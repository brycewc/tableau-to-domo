import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlToMagic } from '../../src/magic/index.js';
import { planInitialSqlDataflow } from '../../src/magic/datasource.js';
import { ADR_MAX_ACTIONS } from '../../src/magic/stages.js';

const TABLES = { 'DB.S.ORDERS': [{ name: 'ID', type: 'LONG' }, { name: 'REGION', type: 'STRING' }, { name: 'AMOUNT', type: 'DECIMAL' }] };
const inputs = (t) => ({ dataSourceId: `ca:${t.key}`, columns: TABLES[t.key] });

/** A script of `n` chained temp tables, each a filter plus a computed column, that later tables also join back to. */
function chain(n) {
	const lines = ['CREATE TEMP TABLE t0 AS SELECT id, region, amount FROM orders;'];
	for (let k = 1; k <= n; k++) lines.push(`CREATE TEMP TABLE t${k} AS SELECT id, region, amount + ${k} AS amount FROM t${k - 1} WHERE amount > ${k};`);
	return lines.join('\n');
}

function checkStage(stage) {
	const ids = new Set(stage.definition.actions.map((a) => a.id));
	assert.equal(ids.size, stage.definition.actions.length, 'unique ids');
	assert.ok(stage.definition.actions.length <= 100, `stage has ${stage.definition.actions.length} actions`);
	for (const a of stage.definition.actions) {
		for (const d of a.dependsOn ?? []) assert.ok(ids.has(d), `${a.id} depends on ${d}, which is not in its stage`);
		if (a.type === 'SQL') for (const i of a.inputs) assert.ok(ids.has(i));
	}
}

test('a plan within the limit is one stage', () => {
	const r = sqlToMagic(chain(3), { inputs, database: 'DB', schema: 'S', outputs: [{ name: 'out', sql: 'SELECT * FROM t3' }] });
	assert.equal(r.stages.length, 1);
	assert.equal(r.stages[0].definition, r.definition);
	assert.deepEqual(r.stages[0].outputs, [{ name: 'out', columns: r.outputs[0].columns, intermediate: false, actionId: r.outputs[0].actionId }]);
});

test('a plan over the limit splits into chained stages that read each other through stage: placeholders', () => {
	const r = sqlToMagic(chain(130), { inputs, database: 'DB', schema: 'S', compute: { type: 'adr', cloudId: 'cloud-1' }, name: 'Big (Initial SQL)', outputs: [{ name: 'out', sql: 'SELECT a.id, b.amount FROM t130 a JOIN t1 b ON a.id = b.id' }] });
	assert.ok(r.actions.length > ADR_MAX_ACTIONS);
	assert.ok(r.stages.length >= 3);
	for (const s of r.stages) checkStage(s);
	const names = new Set();
	r.stages.forEach((stage, k) => {
		const loads = stage.definition.actions.filter((a) => a.type === 'LoadFromVault');
		for (const l of loads) {
			if (String(l.dataSourceId).startsWith('stage:')) {
				const from = l.dataSourceId.slice('stage:'.length);
				assert.ok(names.has(from), `stage ${k + 1} reads ${from} before any stage publishes it`);
				assert.equal(l.executeFlowWhenUpdated, true);
				assert.equal(l.sourceType, 'AUTO');
			} else assert.equal(l.dataSourceId, 'ca:DB.S.ORDERS');
		}
		for (const o of stage.outputs) {
			if (o.intermediate) {
				assert.match(o.name, new RegExp(`^Big \\(Initial SQL\\) step ${k + 1} - `));
				assert.ok(Array.isArray(o.columns) && o.columns.length > 0, 'intermediate outputs carry columns');
				const pub = stage.definition.actions.find((a) => a.id === o.actionId);
				assert.equal(pub.dataSource.cloudId, 'cloud-1');
			}
			names.add(o.name);
		}
		assert.match(stage.definition.name, new RegExp(`\\(step ${k + 1} of ${r.stages.length}\\)$`));
	});
	const finals = r.stages.flatMap((s) => s.outputs.filter((o) => !o.intermediate));
	assert.deepEqual(finals.map((o) => o.name), ['out']);
	assert.deepEqual(finals[0].columns, [{ name: 'ID', type: 'LONG' }, { name: 'AMOUNT', type: 'DECIMAL' }]);
	assert.ok(r.stages.at(-1).outputs.some((o) => o.name === 'out'), 'the final output is in the last stage');
	const tiles = r.actions.filter((a) => a.type !== 'LoadFromVault' && a.type !== 'PublishToVault').length;
	assert.equal(r.stages.reduce((n, s) => n + s.definition.actions.filter((a) => a.type !== 'LoadFromVault' && a.type !== 'PublishToVault').length, 0), tiles, 'each tile runs in exactly one stage');
});

test('maxActions sets the stage size', () => {
	const r = sqlToMagic(chain(20), { inputs, database: 'DB', schema: 'S', maxActions: 15, outputs: [{ name: 'out', sql: 'SELECT * FROM t20' }] });
	assert.ok(r.stages.length >= 3);
	for (const s of r.stages) assert.ok(s.definition.actions.length <= 15);
});

test('planInitialSqlDataflow exposes stages with the datasource relation on final outputs', () => {
	const source = { caption: 'Big', connections: [{ id: 'sf', class: 'snowflake', dbname: 'DB', schema: 'S', extra: { 'one-time-sql': chain(130) } }], tables: [{ id: 'q', name: 'Custom SQL Query', kind: 'custom-sql', sql: 'select * from t130', connectionId: 'sf' }] };
	const { dataflows } = planInitialSqlDataflow(source, { cloudId: 'cloud-1', columns: (t) => TABLES[`DB.S.${t.name}`] });
	const [flow] = dataflows;
	assert.ok(flow.stages.length > 1);
	const finals = flow.stages.flatMap((s) => s.outputs).filter((o) => !o.intermediate);
	assert.deepEqual(finals.map((o) => [o.tableId, o.name]), [['q', 'Big - Custom SQL Query']]);
	assert.ok(flow.stages.flatMap((s) => s.outputs).filter((o) => o.intermediate).every((o) => o.tableId === undefined));
	assert.deepEqual(flow.outputs.map((o) => o.tableId), ['q']);
});
