import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlToMagic } from '../../src/magic/index.js';

const cols = (spec) => spec.split(',').map((s) => {
	const [name, type] = s.trim().split(':');
	return { name, ...(type ? { type } : {}) };
});
const TABLES = {
	'DB.S.ORDERS': cols('ID:LONG,CUSTOMER_ID:LONG,AMOUNT:DECIMAL,STATUS:STRING,ORDER_DATE:DATE,REGION:STRING'),
	'DB.S.CUSTOMERS': cols('ID:LONG,NAME:STRING,REGION:STRING,TIER:STRING'),
	'DB.S.RATES': cols('REGION:STRING,RATE:DECIMAL'),
	'DB.S.CAL': cols('DAY_DATE:DATE,FY:LONG,FP:LONG')
};
const inputs = (t) => ({ dataSourceId: `ds-${t.key}`, columns: TABLES[t.key] });
const run = (script, sql, opts = {}) => sqlToMagic(script, { inputs, database: 'DB', schema: 'S', outputs: sql === undefined ? [] : [].concat(sql).map((q, k) => ({ name: `out${k}`, sql: q })), ...opts });
const types = (r) => r.actions.map((a) => a.type);
const of = (r, type) => r.actions.filter((a) => a.type === type);
const one = (r, type) => {
	const list = of(r, type);
	assert.equal(list.length, 1, `${type}: ${types(r).join(',')}`);
	return list[0];
};
const ok = (r) => {
	assert.equal(r.blocked, undefined, JSON.stringify(r.blocked));
	return r;
};
const dependsOnExist = (r) => {
	const ids = new Set(r.actions.map((a) => a.id));
	for (const a of r.actions) for (const d of a.dependsOn ?? []) assert.ok(ids.has(d), `${a.id} depends on missing ${d}`);
};
const final = (r) => {
	const out = r.actions.find((a) => a.type === 'PublishToVault');
	return r.actions.find((a) => a.id === out.dependsOn[0]);
};

test('select, where, expressions and renames become Filter, Add Formula and Select Columns', () => {
	const r = ok(run('', "SELECT id, amount * 2 AS double_amount, IFF(status = 'x', 1, 0) flag, region AS \"Region\" FROM orders WHERE amount > 10 AND status IS NOT NULL"));
	assert.deepEqual(types(r), ['LoadFromVault', 'Filter', 'ExpressionEvaluator', 'SelectValues', 'PublishToVault']);
	assert.equal(one(r, 'Filter').filterList[0].expression, '`AMOUNT` > 10 AND `STATUS` IS NOT NULL');
	const calc = one(r, 'ExpressionEvaluator');
	assert.deepEqual(calc.expressions.map((e) => e.expression), ['`AMOUNT` * 2', "CASE WHEN `STATUS` = 'x' THEN 1 ELSE 0 END"]);
	const sel = one(r, 'SelectValues');
	assert.deepEqual(sel.fields.map((x) => x.rename ?? x.name), ['ID', 'DOUBLE_AMOUNT', 'FLAG', 'Region']);
	assert.equal(one(r, 'LoadFromVault').dataSourceId, 'ds-DB.S.ORDERS');
	dependsOnExist(r);
});

test('SELECT * with no projection change publishes the input directly', () => {
	const r = ok(run('', 'SELECT * FROM orders'));
	assert.deepEqual(types(r), ['LoadFromVault', 'PublishToVault']);
});

test('inner join on multiple keys renames clashing right columns', () => {
	const r = ok(run('', 'SELECT o.id, c.name, c.region AS cregion, o.region FROM orders o JOIN customers c ON o.customer_id = c.id AND o.region = c.region'));
	const join = one(r, 'MergeJoin');
	assert.equal(join.joinType, 'INNER');
	assert.deepEqual(join.keys1, ['CUSTOMER_ID', 'REGION']);
	assert.deepEqual(join.keys2, ['ID', 'REGION']);
	assert.deepEqual(join.schemaModification2, [{ name: 'ID', rename: 'ID_2', remove: false }, { name: 'REGION', rename: 'REGION_2', remove: false }]);
	assert.deepEqual(final(r).fields, [{ name: 'ID' }, { name: 'NAME' }, { name: 'REGION_2', rename: 'CREGION' }, { name: 'REGION' }]);
});

test('join types and conditions', () => {
	const left = ok(run('', 'SELECT o.id, c.tier FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.tier = \'gold\''));
	assert.equal(one(left, 'MergeJoin').joinType, 'LEFT OUTER');
	assert.equal(one(left, 'Filter').filterList[0].expression, "`TIER` = 'gold'", 'a right-only condition filters the right side first');
	const gate = ok(run('', "SELECT o.id, c.tier FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND o.status = 'open'"));
	const gj = one(gate, 'MergeJoin');
	assert.equal(gj.keys1.length, 2, 'a left-only condition on a LEFT JOIN becomes a gate key');
	assert.ok(of(gate, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => /^CASE WHEN `STATUS` = 'open' THEN 1 END$/.test(e.expression))));
	const right = ok(run('', 'SELECT c.name FROM orders o RIGHT JOIN customers c ON o.customer_id = c.id'));
	assert.equal(one(right, 'MergeJoin').joinType, 'RIGHT OUTER');
	const full = ok(run('', 'SELECT c.name FROM orders o FULL OUTER JOIN customers c ON o.customer_id = c.id'));
	assert.equal(one(full, 'MergeJoin').joinType, 'FULL OUTER');
	const cross = ok(run('', 'SELECT o.id, r.rate FROM orders o CROSS JOIN rates r'));
	const cj = one(cross, 'MergeJoin');
	assert.match(cj.keys1[0], /^_t2d_one/);
	const nonEqui = ok(run('', 'SELECT o.id, c.day_date FROM orders o JOIN cal c ON o.order_date >= c.day_date'));
	assert.ok(of(nonEqui, 'Filter').some((f) => f.filterList[0].expression === '`ORDER_DATE` >= `DAY_DATE`'));
	const comma = ok(run('', 'SELECT o.id, c.name FROM orders o, customers c WHERE o.customer_id = c.id AND o.amount > 1'));
	assert.deepEqual(one(comma, 'MergeJoin').keys1, ['CUSTOMER_ID'], 'WHERE equalities become keys of a comma join');
	const computed = ok(run('', 'SELECT o.id, d.fy FROM orders o LEFT JOIN cal d ON CAST(o.order_date AS DATE) = d.day_date'));
	assert.ok(of(computed, 'ExpressionEvaluator').some((a) => a.expressions[0].expression === 'DATE(`ORDER_DATE`)'));
	const using = ok(run('', 'SELECT * FROM rates JOIN customers USING (region)'));
	assert.deepEqual(one(using, 'MergeJoin').schemaModification2.filter((m) => m.remove).map((m) => m.name), ['REGION']);
});

test('a LEFT JOIN condition that reads both sides beyond equalities falls back to a SQL tile', () => {
	const r = ok(run('', 'SELECT o.id FROM orders o LEFT JOIN cal c ON o.order_date BETWEEN c.day_date AND c.day_date + 6'));
	assert.deepEqual(types(r), ['LoadFromVault', 'LoadFromVault', 'SQL', 'PublishToVault']);
	assert.match(one(r, 'SQL').statements[0], /LEFT OUTER JOIN/);
	assert.ok(r.issues.some((i) => i.code === 'magic.sql-tile-reason'));
	const strict = run('', 'SELECT o.id FROM orders o LEFT JOIN cal c ON o.order_date BETWEEN c.day_date AND c.day_date + 6', { mode: 'tiles' });
	assert.match(strict.blocked.reason, /LEFT JOIN condition/);
});

test('group by with aggregates, HAVING, ordinal and alias groups', () => {
	const r = ok(run('', 'SELECT region, YEAR(order_date) AS yr, SUM(amount) AS total, COUNT(*) n, COUNT(DISTINCT customer_id) AS buyers, MAX(amount) / NULLIF(MIN(amount), 0) AS spread FROM orders GROUP BY 1, yr HAVING SUM(amount) > 100'));
	const g = one(r, 'GroupBy');
	assert.equal(g.groups.length, 2);
	assert.equal(g.groups[0].name, 'REGION');
	assert.deepEqual(g.fields.map((f) => f.expression), ['SUM(`AMOUNT`)', 'COUNT(*)', 'COUNT(DISTINCT `CUSTOMER_ID`)', 'MAX(`AMOUNT`)', 'MIN(`AMOUNT`)']);
	const having = one(r, 'Filter');
	assert.match(having.filterList[0].expression, /^`_t2d_a\d+` > 100$/);
	const pre = r.actions.find((a) => a.type === 'ExpressionEvaluator' && a.expressions.some((e) => e.expression === 'YEAR(`ORDER_DATE`)'));
	assert.ok(pre, 'a computed group key is a formula before the Group By');
	assert.deepEqual(final(r).fields.map((x) => x.rename ?? x.name), ['REGION', 'YR', 'TOTAL', 'N', 'BUYERS', 'SPREAD']);
});

test('selecting a column that is not grouped is an error', () => {
	const r = run('', 'SELECT region, status, SUM(amount) FROM orders GROUP BY region');
	assert.match(r.blocked.reason, /neither grouped nor aggregated/);
});

test('DISTINCT, UNION ALL and UNION', () => {
	const d = ok(run('', 'SELECT DISTINCT region FROM orders'));
	assert.deepEqual(one(d, 'Unique').fields, []);
	const u = ok(run('', "SELECT id, name FROM customers UNION ALL SELECT customer_id, status FROM orders UNION ALL SELECT id, 'x' FROM customers"));
	const union = one(u, 'UnionAll');
	assert.equal(union.dependsOn.length, 3);
	const aligned = of(u, 'SelectValues').find((s) => s.fields.some((f) => f.rename === 'ID' && f.name === 'CUSTOMER_ID'));
	assert.ok(aligned, 'later branches are renamed to the first branch\'s names, by position');
	const distinct = ok(run('', 'SELECT region FROM customers UNION SELECT region FROM orders'));
	assert.deepEqual(types(distinct).slice(-3), ['UnionAll', 'Unique', 'PublishToVault']);
	const bad = run('', 'SELECT id FROM customers UNION ALL SELECT id, name FROM customers');
	assert.match(bad.blocked.reason, /unions branch 2 with 2 columns into 1/);
});

test('INTERSECT and EXCEPT become a NULL-matching join; the SQL tile never gets them', () => {
	const x = ok(run('', 'SELECT region FROM customers INTERSECT SELECT region FROM orders'));
	assert.equal(one(x, 'MergeJoin').joinType, 'LEFT OUTER');
	assert.ok(of(x, 'ExpressionEvaluator').some((a) => a.expressions[0].expression === "IFNULL(CAST(`REGION` AS STRING), '#t2d#null#')"));
	assert.match(of(x, 'Filter').at(-1).filterList[0].expression, /^`_t2d_m\d+` IS NOT NULL$/);
	const e = ok(run('', 'SELECT id, region FROM customers MINUS SELECT customer_id, region FROM orders'));
	assert.match(of(e, 'Filter').at(-1).filterList[0].expression, /^`_t2d_m\d+` IS NULL$/);
	assert.deepEqual(final(e).fields, [{ name: 'ID' }, { name: 'REGION' }]);
	assert.match(run('', 'SELECT region FROM customers EXCEPT ALL SELECT region FROM orders').blocked.reason, /EXCEPT ALL/);
	const unknown = run('', 'SELECT a.region FROM orders a JOIN customers c ON a.customer_id = c.id EXCEPT SELECT region FROM customers', { inputs: (t) => ({ dataSourceId: t.key }) });
	assert.match(unknown.blocked.reason, /SQL tile runs as UNION/);
});

test('window functions become Rank & Window tiles, QUALIFY a filter', () => {
	const r = ok(run('', 'SELECT id, region, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn, LAG(amount, 2, 0) OVER (PARTITION BY region ORDER BY order_date) prev FROM orders QUALIFY rn = 1'));
	const w = of(r, 'WindowAction');
	assert.equal(w.length, 2, 'one tile per distinct window');
	assert.deepEqual(w[0].groupRules, [{ column: 'REGION', caseSensitive: false }]);
	assert.deepEqual(w[0].orderRules, [{ column: 'AMOUNT', caseSensitive: false, ascending: false }]);
	assert.deepEqual(w[0].additions[0].operation, { type: 'RANKING', operationType: 'ROW_NUMBER', column: null, defaultValue: null, amount: null });
	assert.deepEqual(w[1].additions[0].operation, { type: 'OFFSET', operationType: 'LAG', column: 'AMOUNT', defaultValue: 0, amount: 2 });
	assert.match(one(r, 'Filter').filterList[0].expression, /^\(`_t2d_win\d+`\) = 1$/);
	const ranks = ok(run('', 'SELECT id, RANK() OVER (ORDER BY amount) r1, DENSE_RANK() OVER (ORDER BY amount) r2 FROM orders'));
	assert.deepEqual(one(ranks, 'WindowAction').additions.map((a) => a.operation.operationType), ['RANK', 'DENSE_RANK']);
});

test('window SUM/AVG/COUNT with an explicit ROWS frame become FRAMED Rank & Window operations', () => {
	const r = ok(run('', 'SELECT id, SUM(amount) OVER (PARTITION BY region ORDER BY order_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running, AVG(amount) OVER (PARTITION BY region ORDER BY order_date ROWS BETWEEN 2 PRECEDING AND 1 FOLLOWING) AS moving FROM orders'));
	const w = one(r, 'WindowAction');
	assert.deepEqual(w.additions.map((a) => a.operation), [
		{ type: 'FRAMED', operationType: 'SUM', column: 'AMOUNT', preceding: null, following: 0 },
		{ type: 'FRAMED', operationType: 'AVERAGE', column: 'AMOUNT', preceding: 2, following: 1 }
	]);
});

test('window aggregates the tile cannot frame use a SQL tile', () => {
	const r = ok(run('', 'SELECT id, SUM(amount) OVER (PARTITION BY region ORDER BY order_date) AS running FROM orders'));
	const sql = one(r, 'SQL').statements[0];
	assert.match(sql, /SUM\("AMOUNT"\) OVER \(PARTITION BY "REGION" ORDER BY "ORDER_DATE"\)/);
	assert.match(r.issues.find((i) => i.code === 'magic.sql-tile-reason').message, /default RANGE frame/);
	for (const sqlText of ['SELECT MAX(amount) OVER (PARTITION BY region ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) m FROM orders', 'SELECT SUM(amount) OVER (PARTITION BY region) s FROM orders', 'SELECT SUM(amount) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) s FROM orders']) {
		assert.equal(of(ok(run('', sqlText)), 'SQL').length, 1, sqlText);
	}
});

test('a correlated subquery tiles cannot decorrelate is blocked, not sent to the SQL tile', () => {
	const r = run('', 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id > c.id)');
	assert.match(r.blocked.reason, /correlated subquery \(it reads c\.id\)/);
	const unqualified = ok(run('', 'SELECT id, (SELECT MAX(amount) FROM orders) AS top FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE amount > 5)', { mode: 'sql' }));
	assert.match(one(unqualified, 'SQL').statements[0], /\(SELECT MAX\("AMOUNT"\) AS "MAX\(AMOUNT\)" FROM t2d_ORDERS_\d+ AS "ORDERS"\)/);
});

test('ORDER BY with LIMIT keeps the top rows; LIMIT alone uses a Limit tile', () => {
	const top = ok(run('', 'SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 5'));
	assert.equal(one(top, 'WindowAction').additions[0].operation.operationType, 'ROW_NUMBER');
	assert.match(one(top, 'Filter').filterList[0].expression, /<= 5$/);
	const lim = ok(run('', 'SELECT TOP 3 id FROM orders'));
	assert.equal(one(lim, 'Limit').limit, 3);
	assert.ok(lim.issues.some((i) => i.code === 'magic.limit-unordered'));
	const offset = ok(run('', 'SELECT id FROM orders ORDER BY id LIMIT 5 OFFSET 10'));
	assert.match(one(offset, 'Filter').filterList[0].expression, /> 10 AND .* <= 15$/);
	const ignored = ok(run('', 'SELECT id FROM orders ORDER BY id'));
	assert.ok(ignored.issues.some((i) => i.code === 'magic.order-ignored'));
});

test('CTEs and derived tables are planned inline and reused', () => {
	const r = ok(run('', 'WITH big AS (SELECT * FROM orders WHERE amount > 100) SELECT b1.id, b2.region FROM big b1 JOIN big b2 ON b1.id = b2.id'));
	const [cte, pass] = of(r, 'Filter');
	assert.equal(of(r, 'Filter').length, 2, 'a CTE read twice is one tile chain, plus a pass-through for the second read');
	const join = one(r, 'MergeJoin');
	assert.deepEqual([join.step1, join.step2], [cte.id, pass.id]);
	assert.deepEqual(pass.dependsOn, [cte.id]);
	assert.equal(pass.filterList[0].expression, '(1 = 1)');
});

test('column names that differ only in case never reach ADR together', () => {
	const join = ok(run('CREATE TEMP TABLE t AS SELECT id AS "Id", region AS "region" FROM customers;', 'SELECT o.id, t."Id" AS other, t."region" AS r2 FROM orders o JOIN t ON o.id = t."Id"'));
	const mj = one(join, 'MergeJoin');
	assert.deepEqual(mj.schemaModification2, [{ name: 'Id', rename: 'Id_2', remove: false }, { name: 'region', rename: 'region_2', remove: false }]);
	const copy = ok(run('', 'SELECT *, REGION AS "Region" FROM customers'));
	assert.deepEqual(copy.outputs[0].columns.map((c) => c.name), ['ID', 'NAME', 'TIER', 'Region']);
	assert.ok(copy.issues.some((i) => i.code === 'magic.case-duplicate'));
	assert.match(run('', 'SELECT *, 1 AS "id" FROM customers').blocked.reason, /produces the column id twice/);
});

test('a self-join and a union of a table with itself read two distinct actions', () => {
	const self = ok(run('', 'SELECT a.id FROM orders a JOIN orders b ON a.customer_id = b.customer_id'));
	const join = one(self, 'MergeJoin');
	assert.notEqual(join.step1, join.step2);
	assert.deepEqual(join.dependsOn, [join.step1, join.step2]);
	const pass = self.actions.find((a) => a.id === join.step2);
	assert.equal(pass.type, 'Filter');
	assert.deepEqual(pass.dependsOn, [join.step1]);
	const union = ok(run('', 'SELECT * FROM orders UNION ALL SELECT * FROM orders UNION ALL SELECT * FROM orders'));
	const u = one(union, 'UnionAll');
	assert.equal(new Set(u.dependsOn).size, 3);
	assert.equal(of(union, 'Filter').length, 2);
	for (const r of [self, union]) for (const a of r.actions) assert.equal(new Set(a.dependsOn ?? []).size, (a.dependsOn ?? []).length, a.id);
	const derived = ok(run('', 'SELECT x.region, x.n FROM (SELECT region, COUNT(*) n FROM orders GROUP BY region) x WHERE x.n > 1'));
	assert.deepEqual(types(derived), ['LoadFromVault', 'GroupBy', 'SelectValues', 'Filter', 'PublishToVault']);
	const renamed = ok(run('', 'WITH t (a, b) AS (SELECT id, region FROM orders) SELECT a FROM t'));
	assert.deepEqual(final(renamed).fields, [{ name: 'ID', rename: 'A' }], 'consecutive Select Columns tiles compose');
});

test('a join key that is text on one side and a number or date on the other compares through a TRY_CAST key', () => {
	const r = ok(run('', 'SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON o.status = c.id'));
	const join = one(r, 'MergeJoin');
	const cast = r.actions.find((a) => a.id === join.step1);
	assert.equal(cast.type, 'ExpressionEvaluator');
	assert.deepEqual(cast.expressions.map((e) => [e.fieldName, e.expression]), [[join.keys1[0], 'TRY_CAST(`STATUS` AS LONG)']]);
	assert.deepEqual(join.keys2, ['ID']);
	assert.deepEqual(final(r).fields.map((f) => f.rename ?? f.name), ['ID', 'NAME'], 'the cast key is not published');
	const right = ok(run('', 'SELECT o.id FROM cal JOIN orders o ON cal.day_date = o.region'));
	const rj = one(right, 'MergeJoin');
	assert.match(right.actions.find((a) => a.id === rj.step2).expressions[0].expression, /^TRY_CAST\(`REGION` AS DATE\)$/);
	const inSub = ok(run('', 'SELECT id FROM orders WHERE region IN (SELECT id FROM customers)'));
	assert.ok(of(inSub, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => e.expression === 'TRY_CAST(`REGION` AS LONG)')), 'IN subqueries align key types too');
	for (const same of ['SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id', 'SELECT o.id FROM orders o JOIN cal ON o.order_date = cal.day_date', 'SELECT o.id FROM orders o JOIN rates r ON o.amount = r.rate']) {
		assert.deepEqual(of(ok(run('', same)), 'ExpressionEvaluator'), [], same);
	}
});

test('text compared with a number or date column reads through TRY_CAST; literals and matching types do not', () => {
	const r = ok(run('', 'SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status > c.id AND c.region = o.order_date'));
	const where = of(r, 'Filter').at(-1).filterList[0].expression;
	assert.match(where, /TRY_CAST\(`STATUS` AS LONG\) > `ID_2`/);
	assert.match(where, /TRY_CAST\(`REGION_2` AS DATE\) = `ORDER_DATE`/);
	assert.ok(r.issues.some((i) => i.code === 'magic.text-comparison'));
	const plain = ok(run('', "SELECT id FROM orders WHERE status = 'x' AND order_date >= '2024-01-01' AND amount > customer_id"));
	assert.doesNotMatch(of(plain, 'Filter')[0].filterList[0].expression, /TRY_CAST/);
});

test('a SQL tile branch of NULL placeholders converts back to the typed branch types with TRY_CAST', () => {
	const r = ok(run('', 'SELECT id, order_date, status FROM orders UNION ALL SELECT NULL a, NULL b, NULL c'));
	const [union] = of(r, 'UnionAll');
	const keep = r.actions.find((a) => a.dependsOn?.[0] === union.id);
	assert.deepEqual(keep.expressions.map((e) => e.expression), ['TRY_CAST(`ID` AS LONG)', 'TRY_CAST(`ORDER_DATE` AS DATE)']);
});

test('a select list with a trailing comma plans, and a SQL tile is written without it', () => {
	const tiles = ok(run('CREATE TEMP TABLE t AS SELECT id, region, FROM orders', undefined, { publish: ['T'] }));
	assert.deepEqual(final(tiles).fields.map((f) => f.name), ['ID', 'REGION']);
	const tile = ok(run('', 'SELECT x.a, y.b, FROM unknown_x x JOIN unknown_y y ON x.id = y.id'));
	assert.doesNotMatch(one(tile, 'SQL').statements[0], /,\s*FROM/);
});

test('ALTER SESSION SET QUERY_TAG with Tableau placeholders is a skipped session setting', () => {
	const r = ok(run("ALTER SESSION SET QUERY_TAG = [WorkbookName][TableauApp]; CREATE TEMP TABLE t AS SELECT id FROM orders", undefined, { publish: ['T'] }));
	assert.equal(r.statements[0].kind, 'session');
	assert.deepEqual(r.blockers, []);
});

test('IN, NOT IN and EXISTS subqueries become joins with markers', () => {
	const inSub = ok(run('', "SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE tier = 'gold')"));
	const join = one(inSub, 'MergeJoin');
	assert.equal(join.joinType, 'LEFT OUTER');
	assert.equal(one(inSub, 'Unique').fields.length, 1);
	assert.match(of(inSub, 'Filter').at(-1).filterList[0].expression, /^\(`_t2d_m\d+` IS NOT NULL\)$/);
	const notIn = ok(run('', 'SELECT id FROM orders WHERE customer_id NOT IN (SELECT id FROM customers)'));
	assert.ok(of(notIn, 'GroupBy').some((g) => /IS NULL THEN 1 ELSE 0/.test(g.fields[0].expression)), 'NOT IN counts NULLs in the subquery');
	assert.match(of(notIn, 'Filter').at(-1).filterList[0].expression, /^\(\(CASE WHEN `CUSTOMER_ID` IS NULL THEN NULL .* ELSE 0 END\) = 0\)$/);
	const exists = ok(run('', 'SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.amount > 5)'));
	const ej = one(exists, 'MergeJoin');
	assert.deepEqual(ej.keys1, ['ID']);
	assert.ok(of(exists, 'Filter').some((f) => f.filterList[0].expression === '`AMOUNT` > 5'));
	const notExists = ok(run('', 'SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)'));
	assert.match(of(notExists, 'Filter').at(-1).filterList[0].expression, /^NOT \(`_t2d_m\d+` IS NOT NULL\)$/);
});

test('scalar subqueries become joins, correlated ones grouped by the correlation keys', () => {
	const r = ok(run('', 'SELECT id, amount FROM orders WHERE amount > (SELECT AVG(amount) FROM orders)'));
	assert.equal(one(r, 'MergeJoin').joinType, 'LEFT OUTER');
	assert.match(of(r, 'Filter').at(-1).filterList[0].expression, /^`AMOUNT` > `_t2d_s\d+`$/);
	const corr = ok(run('', 'SELECT c.name, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders FROM customers c'));
	const g = one(corr, 'GroupBy');
	assert.deepEqual(g.groups.map((x) => x.name), ['CUSTOMER_ID']);
	assert.ok(of(corr, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => /^IFNULL\(`_t2d_s\d+`, 0\)$/.test(e.expression))), 'COUNT of no rows is 0');
});

test('procedural script: temp tables, UPDATE, DELETE, INSERT, DROP and ALTER', () => {
	const script = `
		USE DATABASE DB; USE SCHEMA S;
		ALTER SESSION SET TIMEZONE = 'UTC';
		SET min_amount = 5;
		DROP TABLE IF EXISTS t1;
		CREATE TEMP TABLE t1 AS SELECT id, customer_id, amount, status FROM orders WHERE amount >= $min_amount;
		UPDATE t1 SET status = 'big', amount = amount * 1 WHERE amount > 1000;
		DELETE FROM t1 WHERE status = 'void';
		CREATE TEMP TABLE t2 (id NUMBER, label VARCHAR(20), amount NUMBER(10,2));
		INSERT INTO t2 (id, label) SELECT id, status FROM t1;
		INSERT INTO t2 SELECT id, 'manual', amount FROM t1 WHERE status = 'big';
		ALTER TABLE t2 ADD COLUMN note VARCHAR(10);
		ALTER TABLE t2 ALTER COLUMN label TYPE VARCHAR(50);
	`;
	const r = ok(run(script, 'SELECT * FROM t2'));
	dependsOnExist(r);
	const filters = of(r, 'Filter').map((f) => f.filterList[0].expression);
	assert.ok(filters.includes('`AMOUNT` >= 5'), 'variables are substituted');
	assert.ok(filters.includes("(CASE WHEN `STATUS` = 'void' THEN 1 ELSE 0 END) = 0"), 'DELETE keeps rows where the condition is not true');
	const update = r.actions.find((a) => a.name === 'Update T1');
	assert.deepEqual(update.expressions.map((e) => e.fieldName.replace(/\d+$/, '')), ['_t2d_set', '_t2d_set', 'STATUS', 'AMOUNT'], 'the condition reads AMOUNT, which is also set, so values are computed first');
	assert.equal(update.expressions[0].expression, "CASE WHEN `AMOUNT` > 1000 THEN CAST('big' AS STRING) ELSE `STATUS` END");
	const union = one(r, 'UnionAll');
	assert.equal(union.dependsOn.length, 2, 'the second INSERT appends to the first');
	assert.ok(of(r, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => e.expression === 'CAST(NULL AS DECIMAL)')), 'a column the INSERT leaves out is NULL of its type');
	assert.ok(of(r, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => e.fieldName === 'NOTE' && e.expression === 'CAST(NULL AS STRING)')));
});

test('CLONE, LIKE, TRUNCATE, RENAME COLUMN, DROP COLUMN and RENAME TO', () => {
	const script = `CREATE TEMP TABLE a AS SELECT id, region, status FROM orders;
		CREATE TEMP TABLE b CLONE a;
		CREATE TEMP TABLE c LIKE a;
		INSERT INTO c SELECT * FROM b WHERE status = 'x';
		TRUNCATE TABLE b;
		ALTER TABLE a RENAME COLUMN region TO area;
		ALTER TABLE a DROP COLUMN status;
		ALTER TABLE a RENAME TO a2;`;
	const r = ok(run(script, ['SELECT * FROM a2', 'SELECT * FROM b', 'SELECT * FROM c']));
	dependsOnExist(r);
	const outs = of(r, 'PublishToVault').map((p) => r.actions.find((a) => a.id === p.dependsOn[0]));
	assert.deepEqual(outs[0].fields, [{ name: 'ID' }, { name: 'REGION', rename: 'AREA' }]);
	assert.equal(outs[1].filterList[0].expression, '(1 = 0)', 'TRUNCATE keeps the columns and no rows');
	assert.equal(outs[2].type, 'UnionAll', 'LIKE starts empty with the same columns, then the INSERT appends');
	const renamed = ok(run('CREATE TEMP TABLE a AS SELECT id FROM orders; ALTER TABLE a RENAME TO b;', 'SELECT * FROM a', { inputs: (t) => ({ dataSourceId: `ds-${t.key}`, columns: TABLES[t.key] ?? [{ name: 'X' }] }) }));
	assert.ok(renamed.inputs.some((i) => i.table === 'DB.S.A'), 'after RENAME TO, the old name is a warehouse table again');
});

test('UPDATE where a SET reads another SET target uses temporaries (simultaneous assignment)', () => {
	const r = ok(run('CREATE TEMP TABLE t AS SELECT id, region, status FROM orders; UPDATE t SET region = status, status = region;', 'SELECT * FROM t'));
	const calc = r.actions.find((a) => a.name === 'Update T');
	assert.equal(calc.expressions.length, 4);
	assert.match(calc.expressions[2].expression, /^`_t2d_set\d+`$/);
});

test('UPDATE ... FROM joins the source and overwrites matched rows', () => {
	const script = "CREATE TEMP TABLE t AS SELECT id, region, amount FROM orders; UPDATE t SET amount = t.amount * r.rate FROM rates r WHERE t.region = r.region AND r.rate > 0 AND t.amount > 0;";
	const r = ok(run(script, 'SELECT * FROM t'));
	const join = r.actions.find((a) => a.type === 'MergeJoin');
	assert.equal(join.joinType, 'LEFT OUTER');
	assert.ok(of(r, 'Unique').some((u) => u.fields.length === 1), 'one source row per key');
	const upd = r.actions.find((a) => a.name === 'Update T');
	assert.match(upd.expressions[0].expression, /^CASE WHEN `_t2d_m\d+` IS NOT NULL AND `AMOUNT` > 0 THEN CAST\(`AMOUNT` \* `_t2d_u\d+` AS DECIMAL\) ELSE `AMOUNT` END$/);
	assert.ok(of(r, 'Filter').some((f) => f.filterList[0].expression === '`RATE` > 0'), 'a source-only condition filters the source');
	assert.deepEqual(final(r).fields.map((f) => f.name), ['ID', 'REGION', 'AMOUNT'], 'helper columns are dropped');
});

test('DELETE ... USING is an anti-join', () => {
	const r = ok(run('CREATE TEMP TABLE t AS SELECT id, customer_id FROM orders; DELETE FROM t USING customers c WHERE t.customer_id = c.id AND c.tier = \'x\';', 'SELECT * FROM t'));
	assert.equal(one(r, 'MergeJoin').joinType, 'LEFT OUTER');
	assert.match(of(r, 'Filter').at(-1).filterList[0].expression, /^\(CASE WHEN \(`_t2d_m\d+` IS NOT NULL\) THEN 1 ELSE 0 END\) = 0$/);
});

test('later statements read the updated version of a table', () => {
	const r = ok(run('CREATE TEMP TABLE t AS SELECT id, status FROM orders; UPDATE t SET status = \'x\'; CREATE TEMP TABLE u AS SELECT status, COUNT(*) n FROM t GROUP BY status;', 'SELECT * FROM u'));
	const group = one(r, 'GroupBy');
	const upd = r.actions.find((a) => a.name === 'Update T');
	assert.equal(group.dependsOn[0], upd.id);
});

test('tables of unknown schema: SELECT * passes through; joins and positional unions use SQL tiles', () => {
	const unknown = (t) => ({ dataSourceId: `ds-${t.key}` });
	const pass = ok(run('', "SELECT *, 'x' AS note FROM orders WHERE amount > 1", { inputs: unknown }));
	assert.deepEqual(types(pass), ['LoadFromVault', 'Filter', 'ExpressionEvaluator', 'PublishToVault']);
	const join = ok(run('', 'SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id', { inputs: unknown }));
	assert.match(one(join, 'SQL').statements[0], /^SELECT "O"\."ID" AS "ID", "C"\."NAME" AS "NAME" FROM t2d_ORDERS_\d+ AS "O" INNER JOIN t2d_CUSTOMERS_\d+ AS "C" ON "O"\."CUSTOMER_ID" = "C"\."ID"$/);
	const sqlTile = one(join, 'SQL');
	const names = sqlTile.inputs.map((id) => join.actions.find((a) => a.id === id).name);
	assert.ok(names.every((n) => sqlTile.statements[0].includes(n)), 'the SQL tile names its inputs by tile name');
	const qualified = ok(run('', 'SELECT DB.S.ORDERS.ID, customers.* FROM DB.S.ORDERS JOIN customers ON DB.S.ORDERS.CUSTOMER_ID = customers.ID', { inputs: unknown }));
	assert.match(one(qualified, 'SQL').statements[0], /^SELECT "ORDERS"\."ID" AS "ID", "CUSTOMERS"\.\* FROM t2d_ORDERS_\d+ AS "ORDERS" INNER JOIN t2d_CUSTOMERS_\d+ AS "CUSTOMERS" ON "ORDERS"\."CUSTOMER_ID" = "CUSTOMERS"\."ID"$/);
	const update = ok(run('CREATE TEMP TABLE t AS SELECT * FROM orders; UPDATE t SET status = \'x\' WHERE customer_id IN (SELECT id FROM customers);', 'SELECT * FROM t', { inputs: unknown }));
	const drop = one(update, 'Metadata');
	assert.ok(drop.fields.every((f) => f.remove && f.name.startsWith('_t2d_')), 'helpers are removed by name when the schema is unknown');
});

test('VALUES and constant SELECTs become SQL tiles with no input', () => {
	const r = ok(run("CREATE TEMP TABLE t (a INT, b VARCHAR(5)); INSERT INTO t VALUES (1, 'x'), (2, 'y'); CREATE TEMP TABLE p AS SELECT * FROM (SELECT 1 AS n UNION ALL SELECT 2);", 'SELECT t.a, t.b, o.id FROM t JOIN orders o ON o.id = t.a CROSS JOIN p'));
	const tiles = of(r, 'SQL');
	assert.equal(tiles.length, 2);
	assert.equal(tiles[0].statements[0], `SELECT 1 AS "COLUMN1", 'x' AS "COLUMN2" UNION ALL SELECT 2 AS "COLUMN1", 'y' AS "COLUMN2"`);
	assert.equal(tiles[1].statements[0], 'SELECT * FROM (SELECT 1 AS "N" UNION ALL SELECT 2 AS "N") AS "_t2d_d"');
	assert.ok(tiles.every((t) => t.dependsOn === undefined && t.inputs.length === 0));
	assert.ok(of(r, 'SelectValues').some((s) => s.fields.some((f) => f.name === 'COLUMN1' && f.rename === 'A')), 'VALUES columns line up with the table by position');
	const alone = ok(run('CREATE TEMP TABLE p AS SELECT 1 AS n;', 'SELECT * FROM p'));
	assert.deepEqual(types(alone), ['SQL', 'PublishToVault']);
});

test('blocked statements report index, excerpt and reason; dependants are skipped, not blamed', () => {
	const r = run('CREATE TEMP TABLE a AS SELECT * FROM orders; UPDATE a SET status = REGEXP_SUBSTR(status, \'x\'); CREATE TEMP TABLE b AS SELECT * FROM a;', 'SELECT * FROM b');
	assert.equal(r.blockers.length, 2);
	assert.deepEqual(r.blocked, { statement: 1, excerpt: "UPDATE a SET status = REGEXP_SUBSTR(status, 'x')", reason: 'calls REGEXP_SUBSTR, which t2d does not translate to a Magic ETL formula' });
	assert.match(r.statements[2].note, /^skipped/);
	assert.match(r.blockers[1].reason, /reads DB\.S\.B, which a blocked statement builds/);
});

test('MERGE becomes the matched UPDATE plus an INSERT of the unmatched source rows', () => {
	const script = `CREATE TEMP TABLE t AS SELECT id, region, tier FROM customers WHERE tier = 'gold';
		MERGE INTO t USING customers c ON t.id = c.id
			WHEN MATCHED THEN UPDATE SET tier = c.tier
			WHEN NOT MATCHED AND c.region = 'EU' THEN INSERT (id, region, tier) VALUES (c.id, c.region, 'new');`;
	const r = ok(run(script, 'SELECT * FROM t'));
	dependsOnExist(r);
	const union = one(r, 'UnionAll');
	assert.equal(union.dependsOn.length, 2);
	assert.ok(of(r, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => /^CASE WHEN `_t2d_m\d+` IS NOT NULL THEN `_t2d_u\d+` ELSE `TIER` END$/.test(e.expression))));
	assert.ok(of(r, 'Filter').some((f) => /^\(`_t2d_m\d+` IS NULL\) AND `REGION` = 'EU'$/.test(f.filterList[0].expression)), 'only source rows with no match in the table as it was');
	const del = ok(run("CREATE TEMP TABLE t AS SELECT id FROM customers; MERGE INTO t USING orders o ON t.id = o.customer_id WHEN MATCHED AND o.amount > 5 THEN DELETE;", 'SELECT * FROM t'));
	assert.match(of(del, 'Filter').at(-1).filterList[0].expression, /THEN 1 ELSE 0 END\) = 0$/);
	assert.match(run('CREATE TEMP TABLE t AS SELECT id FROM customers; MERGE INTO t USING orders o ON t.id = o.id WHEN MATCHED AND o.amount > 1 THEN DELETE WHEN MATCHED THEN UPDATE SET id = 1;', 'SELECT * FROM t').blocked.reason, /several WHEN MATCHED/);
});

test('unparseable and unsupported statements block with their reason', () => {
	assert.match(run('CREATE TEMP TABLE a AS SELECT FROM;', 'SELECT 1').blocked.reason, /could not be parsed/);
	assert.match(run('CALL refresh();', 'SELECT * FROM orders').blocked.reason, /CALL/);
	assert.match(run('', 'SELECT REGEXP_LIKE(status, \'a\') FROM orders').blocked.reason, /regular-expression/);
	assert.match(run('', 'SELECT * FROM t_missing x JOIN orders o ON x.id = o.id', { inputs: () => undefined }).issues.find((i) => i.code === 'magic.input-unresolved').message, /No Domo dataset/);
});

test('SELECTs, USE WAREHOUSE and ALTER USER in the script are not data', () => {
	const r = ok(run("USE WAREHOUSE wh; ALTER USER SET ODBC_QUERY_RESULT_FORMAT='JSON'; SELECT 1 FROM orders;", 'SELECT id FROM orders'));
	assert.ok(r.issues.some((i) => i.code === 'magic.select-ignored'));
	assert.equal(r.statements[0].note, 'USE WAREHOUSE does not change the data');
});

test('QUOTED_IDENTIFIERS_IGNORE_CASE = TRUE folds quoted names', () => {
	const r = ok(run('ALTER SESSION SET QUOTED_IDENTIFIERS_IGNORE_CASE = TRUE; CREATE TEMP TABLE t AS SELECT id AS "MixedCase" FROM orders;', 'SELECT "mixedcase" FROM t'));
	assert.deepEqual(final(r).fields.map((f) => f.rename ?? f.name), ['MIXEDCASE']);
});

test('a non-UTC session time zone is a warning', () => {
	const r = ok(run("ALTER SESSION SET TIMEZONE = 'America/New_York';", 'SELECT id FROM orders'));
	assert.ok(r.issues.some((i) => i.code === 'magic.timezone'));
});

test('PIVOT becomes a Group By with conditional aggregates; UNPIVOT an Append of one branch per column', () => {
	const p = ok(run('', "SELECT * FROM (SELECT region, status, amount FROM orders) PIVOT (SUM(amount) FOR status IN ('open', 'closed')) AS p"));
	const g = one(p, 'GroupBy');
	assert.deepEqual(g.groups.map((x) => x.name), ['REGION']);
	assert.deepEqual(g.fields.map((f) => f.name), ['open', 'closed']);
	assert.ok(p.issues.some((i) => i.code === 'magic.pivot-names'));
	assert.equal(g.fields[0].expression, "SUM(CASE WHEN `STATUS` = 'open' THEN `AMOUNT` END)");
	const u = ok(run('CREATE TEMP TABLE w AS SELECT region, SUM(amount) AS a, COUNT(*) AS n FROM orders GROUP BY region;', 'SELECT * FROM w UNPIVOT (val FOR metric IN (a, n))'));
	assert.equal(one(u, 'UnionAll').dependsOn.length, 2);
	assert.ok(of(u, 'Filter').every((f) => f.filterList[0].expression === '`VAL` IS NOT NULL'));
});

test('mode sql writes one SQL tile per query and per UPDATE of a table with known columns', () => {
	const r = ok(run("CREATE TEMP TABLE t AS SELECT id, status FROM orders WHERE amount > 1; UPDATE t SET status = 'x' WHERE id = 1;", 'SELECT status, COUNT(*) AS n FROM t GROUP BY status', { mode: 'sql' }));
	assert.equal(of(r, 'SQL').length, 3);
	assert.equal(of(r, 'ExpressionEvaluator').length, 0);
	assert.match(of(r, 'SQL')[1].statements[0], /^SELECT "ID" AS "ID", CASE WHEN "ID" = 1 THEN 'x' ELSE "STATUS" END AS "STATUS" FROM t2d_T_\d+ AS "T"$/);
	assert.match(of(r, 'SQL')[2].statements[0], /^SELECT "STATUS" AS "STATUS", COUNT\(\*\) AS "N" FROM t2d_Update_T_\d+ AS "T" GROUP BY "STATUS"$/);
});

test('mode sql keeps an UPDATE of a table with unknown columns as a Formula tile', () => {
	const r = ok(run("CREATE TEMP TABLE t AS SELECT * FROM mystery; UPDATE t SET status = 'x' WHERE id = 1;", 'SELECT * FROM t', { mode: 'sql' }));
	assert.match(one(r, 'ExpressionEvaluator').expressions[0].expression, /^CASE WHEN `ID` = 1/);
});

test('SQL tile text uses the Domo dialect, not Snowflake functions', () => {
	const r = ok(run('', "SELECT IFF(amount > 1, 'a', 'b') AS x, DATEADD(day, 1, order_date) AS d, SUM(amount) OVER (PARTITION BY region) s FROM orders"));
	const text = one(r, 'SQL').statements[0];
	assert.match(text, /CASE WHEN "AMOUNT" > 1 THEN 'a' ELSE 'b' END AS "X"/);
	assert.match(text, /DATE_ADD\("ORDER_DATE", INTERVAL 1 DAY\) AS "D"/);
	assert.doesNotMatch(text, /IFF|DATEADD/);
});

test('ADR compute target shapes the definition', () => {
	const r = ok(run('', 'SELECT id FROM orders', { compute: { type: 'adr', cloudId: 'cloud-1' }, name: 'Flow' }));
	assert.equal(r.definition.databaseType, 'ADR');
	assert.equal(r.definition.computeCloud, 'cloud-1');
	assert.deepEqual(r.definition.settings, { sqlDialect: 'ADRENALINE' });
	const load = one(r, 'LoadFromVault');
	assert.deepEqual(load.settings, { preferredDatabaseEntityType: 'TEMP_VIEW' });
	assert.equal(load.sourceType, 'AUTO');
	assert.equal(load.filterPolicy, 'LEGACY');
	assert.equal(one(r, 'PublishToVault').dataSource.cloudId, 'cloud-1');
	const magic = ok(run('', 'SELECT id FROM orders'));
	assert.equal(magic.definition.databaseType, 'MAGIC');
	assert.equal(one(magic, 'PublishToVault').dataSource.cloudId, undefined);
	assert.deepEqual(r.inputs, [{ table: 'DB.S.ORDERS', actionId: load.id, dataSourceId: 'ds-DB.S.ORDERS', columns: TABLES['DB.S.ORDERS'] }]);
	assert.deepEqual(r.outputs, [{ name: 'out0', actionId: one(r, 'PublishToVault').id, columns: [{ name: 'ID', type: 'LONG' }] }]);
});

test('outputs carry the dataset columns as Domo will name and type them', () => {
	const tiles = ok(run('', 'SELECT id, region AS "Region", amount * 2 AS dbl, amount > 1 AS big, COUNT(*) OVER (PARTITION BY region ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) n, CAST(order_date AS TIMESTAMP) ts FROM orders'));
	assert.deepEqual(tiles.outputs[0].columns, [
		{ name: 'ID', type: 'LONG' },
		{ name: 'Region', type: 'STRING' },
		{ name: 'DBL', type: 'DECIMAL' },
		{ name: 'BIG', type: 'STRING' },
		{ name: 'N', type: 'LONG' },
		{ name: 'TS', type: 'DATETIME' }
	]);
	const sql = ok(run('', 'SELECT region, SUM(amount) OVER (PARTITION BY region) AS s, "ID" FROM orders', { mode: 'sql' }));
	assert.deepEqual(sql.outputs[0].columns.map((c) => c.name), ['REGION', 'S', 'ID']);
	const star = ok(run('', 'SELECT * FROM orders', { mode: 'sql' }));
	assert.deepEqual(star.outputs[0].columns, TABLES['DB.S.ORDERS']);
	const unknown = ok(run('', "SELECT *, 'x' AS note FROM orders", { inputs: (t) => ({ dataSourceId: t.key }) }));
	assert.equal(unknown.outputs[0].columns, null);
});

test('unused temp tables are not emitted', () => {
	const r = ok(run('CREATE TEMP TABLE unused AS SELECT * FROM customers; CREATE TEMP TABLE used AS SELECT id FROM orders;', 'SELECT * FROM used'));
	assert.ok(!r.actions.some((a) => a.type === 'LoadFromVault' && a.name === 'CUSTOMERS'));
});

test('publish emits script tables directly', () => {
	const r = ok(run('CREATE TEMP TABLE t AS SELECT id FROM orders;', undefined, { publish: ['t'] }));
	assert.equal(one(r, 'PublishToVault').name, 't');
	assert.match(run('', undefined).blocked.reason, /nothing to publish/);
});

test('every action has a unique id and a gui position', () => {
	const r = ok(run('CREATE TEMP TABLE t AS SELECT id, region FROM orders; CREATE TEMP TABLE u AS SELECT region, COUNT(*) n FROM t GROUP BY region;', ['SELECT * FROM u', 'SELECT * FROM t']));
	const ids = r.actions.map((a) => a.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(r.actions.every((a) => Number.isFinite(a.gui.x) && Number.isFinite(a.gui.y)));
	assert.equal(of(r, 'PublishToVault').length, 2);
});

test('later UNION branches of a SQL tile take the first branch column names', () => {
	const r = ok(run('CREATE TEMP TABLE t AS SELECT id, status FROM orders; CREATE TEMP TABLE u AS SELECT id AS k, region FROM orders;', 'SELECT * FROM (SELECT *, NULL AS extra FROM t UNION ALL SELECT k, region, 1 FROM u UNION ALL SELECT *, 2 FROM u) x', { mode: 'sql' }));
	const text = of(r, 'SQL').at(-1).statements[0];
	assert.match(text, /UNION ALL SELECT "K" AS "ID", "REGION" AS "STATUS", 1 AS "EXTRA" FROM t2d_U_\d+ AS "U" UNION ALL SELECT "K" AS "ID", "REGION" AS "STATUS", "2" AS "EXTRA" FROM \(SELECT \*, 2 AS "2" FROM t2d_U_\d+ AS "U"\) AS "_t2d_union_3"/);
});
