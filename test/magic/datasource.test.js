import test from 'node:test';
import assert from 'node:assert/strict';
import { planInitialSqlDataflow } from '../../src/magic/datasource.js';

const source = (initialSql, extraTables = []) => ({
	caption: 'Credits',
	connections: [{ id: 'sf', class: 'snowflake', dbname: 'SF_EDH', schema: 'EDH_IDS', extra: { 'one-time-sql': initialSql } }],
	tables: [{ id: 'q', name: 'Custom SQL Query', kind: 'custom-sql', sql: 'select * from tmp_b where n > 1', connectionId: 'sf' }, ...extraTables]
});
const SCRIPT = "ALTER SESSION SET TIMEZONE = 'UTC'; create temp table tmp_a as select id, region from orders; create temp table tmp_b as select region, count(*) n from tmp_a group by region; update tmp_b set region = 'x' where n = 0;";

test('a datasource with procedural Initial SQL becomes one ADR dataflow over Cloud Amplifier inputs', () => {
	const { dataflows, blocked } = planInitialSqlDataflow(source(SCRIPT), {
		cloudId: 'cloud-1',
		databases: { SF_EDH: 'PROD_SHF_EDH' },
		columns: (t) => (t.name === 'ORDERS' ? [{ name: 'ID' }, { name: 'REGION' }] : undefined),
		datasetRef: (t) => ({ $ref: `dataset:ca ${t.database}.${t.schema}.${t.name}` })
	});
	assert.equal(blocked, undefined);
	assert.equal(dataflows.length, 1);
	const [flow] = dataflows;
	assert.equal(flow.result.definition.databaseType, 'ADR');
	assert.equal(flow.result.definition.computeCloud, 'cloud-1');
	assert.deepEqual(flow.tables, [{ database: 'PROD_SHF_EDH', schema: 'EDH_IDS', name: 'ORDERS', key: 'SF_EDH.EDH_IDS.ORDERS', dataSourceId: { $ref: 'dataset:ca PROD_SHF_EDH.EDH_IDS.ORDERS' } }]);
	assert.deepEqual(flow.outputs.map((o) => [o.tableId, o.name]), [['q', 'Credits - Custom SQL Query']]);
	assert.ok(flow.outputs[0].actionId);
	assert.deepEqual(flow.outputs[0].columns, [{ name: 'REGION', type: null }, { name: 'N', type: 'LONG' }]);
	assert.equal(flow.result.actions.find((a) => a.type === 'LoadFromVault').dataSourceId.$ref, 'dataset:ca PROD_SHF_EDH.EDH_IDS.ORDERS');
	assert.equal(flow.result.stats.sqlTiles, 4);
	assert.equal(flow.stages.length, 1);
});

test('a query the SQL tile cannot run becomes tiles', () => {
	const script = 'create temp table tmp_b as with c (region, n) as (select region, 1 from orders) select region, n from c;';
	const { dataflows, blocked } = planInitialSqlDataflow(source(script), { cloudId: 'c', columns: () => [{ name: 'REGION' }] });
	assert.equal(blocked, undefined);
	const { result } = dataflows[0];
	assert.ok(result.issues.some((i) => i.code === 'magic.tiles-reason'));
	assert.equal(result.stats.sqlTiles, 1);
	assert.equal(planInitialSqlDataflow(source(SCRIPT), { cloudId: 'c', mode: 'auto' }).dataflows[0].result.stats.sqlTiles, 0);
});

test('a relation that reads a temp table is an output too; warehouse relations are not', () => {
	const { dataflows } = planInitialSqlDataflow(
		source(SCRIPT, [
			{ id: 't1', name: 'tmp_a', kind: 'table', table: '[SF_EDH].[EDH_IDS].[tmp_a]', connectionId: 'sf' },
			{ id: 't2', name: 'TARGETS', kind: 'table', table: '[SF_EDH].[EDH_RDM].[TARGETS]', connectionId: 'sf' }
		]),
		{ cloudId: 'c' }
	);
	assert.deepEqual(dataflows[0].outputs.map((o) => o.tableId), ['q', 't1']);
});

test('a blocked script returns the blocker', () => {
	const { blocked } = planInitialSqlDataflow(source('create temp table tmp_b as select * from x; call refresh_all();'), { cloudId: 'c' });
	assert.match(blocked.reason, /CALL/);
});

test('connections without Initial SQL are left alone', () => {
	assert.deepEqual(planInitialSqlDataflow({ connections: [{ id: 'sf', class: 'snowflake', extra: {} }], tables: [] }, { cloudId: 'c' }), { dataflows: [] });
});
