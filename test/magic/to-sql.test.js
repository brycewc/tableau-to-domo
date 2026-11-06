import test from 'node:test';
import assert from 'node:assert/strict';
import { magicToSql, parseQuery, sqlToMagic } from '../../src/magic/index.js';

const cols = (s) => s.split(',').map((name) => ({ name }));
const TABLES = {
	'DB.S.ORDERS': cols('ID,CUSTOMER_ID,AMOUNT,STATUS,ORDER_DATE,REGION'),
	'DB.S.CUSTOMERS': cols('ID,NAME,REGION,TIER')
};
const inputs = (t) => ({ dataSourceId: `ds-${t.key}`, columns: TABLES[t.key] });
const back = (script, sql, opts = {}) => {
	const r = sqlToMagic(script, { inputs, database: 'DB', schema: 'S', outputs: [{ name: 'out', sql }], ...opts });
	assert.equal(r.blocked, undefined, JSON.stringify(r.blocked));
	const tables = Object.fromEntries(Object.entries(TABLES).map(([k, c]) => [`ds-${k}`, { table: k, columns: c }]));
	return magicToSql(r.definition, { inputs: tables });
};

test('each tile becomes a CTE and the output selects from the last', () => {
	const out = back('', "SELECT id, amount * 2 AS a2 FROM orders WHERE status = 'x'");
	assert.deepEqual(out.unsupported, []);
	assert.match(out.sql, /^WITH "in-orders" AS \(\n {2}SELECT \* FROM DB\.S\.ORDERS\n\)/);
	assert.match(out.sql, /WHERE \(\(STATUS = 'x'\)\)/);
	assert.match(out.sql, /SELECT \*, AMOUNT \* 2 AS "_t2d_p\d+" FROM/);
	assert.match(out.sql, /SELECT ID, "_t2d_p\d+" AS A2 FROM/);
	assert.match(out.sql, /\nSELECT \* FROM "select-[^"]+"$/);
	assert.doesNotThrow(() => parseQuery(out.sql));
});

test('joins, group by, windows, unions and distinct read back as Snowflake SQL', () => {
	const out = back(
		'CREATE TEMP TABLE t AS SELECT o.id, c.name, o.amount, o.region FROM orders o LEFT JOIN customers c ON o.customer_id = c.id;',
		'SELECT region, SUM(amount) AS total FROM t GROUP BY region UNION ALL SELECT DISTINCT name, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) FROM t'
	);
	assert.deepEqual(out.unsupported, []);
	assert.match(out.sql, /LEFT OUTER JOIN "in-customers" AS r ON l\.CUSTOMER_ID = r\.ID/);
	assert.match(out.sql, /r\.\* RENAME \(ID AS ID_2, REGION AS REGION_2\)/);
	assert.match(out.sql, /GROUP BY REGION/);
	assert.match(out.sql, /ROW_NUMBER\(\) OVER \(PARTITION BY REGION ORDER BY AMOUNT DESC\)/);
	assert.match(out.sql, /UNION ALL BY NAME/);
	assert.match(out.sql, /SELECT DISTINCT \*/);
});

test('formulas that overwrite a known column use SELECT * REPLACE', () => {
	const out = back("CREATE TEMP TABLE t AS SELECT id, status FROM orders; UPDATE t SET status = 'x' WHERE id = 1;", 'SELECT * FROM t');
	assert.match(out.sql, /SELECT \* REPLACE \(CASE WHEN ID = 1 THEN 'x' ELSE STATUS END AS STATUS\)/);
});

test('a SQL tile reads back with its inputs as CTEs', () => {
	const out = back('', 'SELECT id, SUM(amount) OVER (PARTITION BY region) AS s FROM orders');
	assert.deepEqual(out.unsupported, []);
	assert.match(out.sql, /SELECT "ID" AS "ID", SUM\("AMOUNT"\) OVER \(PARTITION BY "REGION"\) AS "S" FROM "in-orders" AS "ORDERS"/);
});

test('hand-written tiles: Filter rules, Group By aggregate types, Limit, Alter Columns', () => {
	const def = {
		actions: [
			{ type: 'LoadFromVault', id: 'in', name: 'in', dataSourceId: 'd1' },
			{ type: 'Filter', id: 'f', dependsOn: ['in'], filterList: [{ leftField: 'state', operator: 'NE', rightValue: { value: 'FL', type: 'STRING' }, andFilterList: [{ leftField: 'x', operator: 'NN' }] }] },
			{ type: 'GroupBy', id: 'g', dependsOn: ['f'], groups: [{ name: 'state' }], fields: [{ name: 'n', source: 'id', type: 'COUNT_ALL' }, { name: 'avg', source: 'v', type: 'AVERAGE' }, { name: 'd', source: 'id', type: 'COUNT_DISTINCT' }] },
			{ type: 'Metadata', id: 'm', dependsOn: ['g'], fields: [{ name: 'n', rename: 'count', remove: false }, { name: 'd', remove: true }] },
			{ type: 'Limit', id: 'l', dependsOn: ['m'], limit: 10, offset: 2 },
			{ type: 'PublishToVault', id: 'o', dependsOn: ['l'], dataSource: { name: 'Out' } }
		]
	};
	const out = magicToSql(def, { inputs: { d1: { table: 'DB.S.T' } } });
	assert.deepEqual(out.unsupported, []);
	assert.equal(out.outputs[0].name, 'Out');
	assert.match(out.sql, /WHERE \("state" <> 'FL' AND "x" IS NOT NULL\)/);
	assert.match(out.sql, /SELECT "state", COUNT\(\*\) AS "n", AVG\("v"\) AS "avg", COUNT\(DISTINCT "id"\) AS "d" FROM "f" GROUP BY "state"/);
	assert.match(out.sql, /SELECT \* EXCLUDE \("d"\) RENAME \("n" AS "count"\) FROM "g"/);
	assert.match(out.sql, /LIMIT 10 OFFSET 2/);
});

test('tiles without a SQL equivalent are reported, not guessed', () => {
	const def = { actions: [{ type: 'LoadFromVault', id: 'in', dataSourceId: 'd' }, { type: 'PythonEngineAction', id: 'py', dependsOn: ['in'] }, { type: 'PublishToVault', id: 'o', dependsOn: ['py'], dataSource: { name: 'O' } }] };
	const out = magicToSql(def);
	assert.deepEqual(out.unsupported, [{ action: 'py', reason: 'is a PythonEngineAction tile, which t2d does not translate to SQL' }]);
	assert.equal(out.outputs.length, 0);
});
