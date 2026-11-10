import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as cloudAmplifier from '../../src/domo/cloud-amplifier.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const quiet = { step() {}, progress() {}, warn() {}, done() {}, child() { return quiet; } };

const output = (key, name) => ({ key, name, strategy: 'dataflow-output', dataflowOutput: { dataflowKey: 'sales.etl', outputName: name }, schema: [], cardTarget: false, fieldMap: {} });

function plan() {
	const p = samplePlan();
	p.datasets = [p.datasets[0], output('sales.a', 'Sales Orders'), output('sales.b', 'Orders'), output('sales.c', 'Kept')];
	p.dataflows = [
		{
			key: 'sales.etl',
			name: 'Sales ETL',
			definition: { name: 'Sales ETL', databaseType: 'ADR', computeCloud: 'int-1', actions: [{ type: 'LoadFromVault', dataSourceId: ref('dataset', 'orders') }, ...['Sales Orders', 'Orders', 'Kept'].map((name, i) => ({ type: 'PublishToVault', id: `out-${i}`, name, dataSource: { guid: '', name, type: 'DataFlow', cloudId: 'int-1' } }))] },
			outputDatasetKeys: ['sales.a', 'sales.b', 'sales.c'],
			runAfterCreate: true
		}
	];
	p.beastModes = [];
	p.cards = [];
	p.pages = [];
	return p;
}

test('a warehouse dataflow names its output tables on create, and push renames one the server left under its id', async () => {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, plan());
	const { deps } = stubDomo();
	const ids = { 'Sales Orders': 'aaaa-1111', Orders: 'bbbb-2222', Kept: 'cccc-3333' };
	let created;
	deps.dataflows = {
		createDataflow: async (_c, def) => ((created = def), { id: 41, outputs: Object.entries(ids).map(([dataSourceName, dataSourceId]) => ({ dataSourceId, dataSourceName })) }),
		runDataflow: async () => ({ id: 7 }),
		waitForExecution: async () => ({ state: 'SUCCESS' })
	};
	const tables = { 'aaaa-1111': 'T2D_SALES_ORDERS', 'bbbb-2222': 'bbbb_2222', 'cccc-3333': 'FINANCE_KEPT' };
	const renames = [];
	deps.cloudAmplifier = {
		...cloudAmplifier,
		getIntegration: async () => ({ id: 'int-1', database: 'DB', defaultSchema: 'WB', writeable: true }),
		getDatasetTable: async (_c, integrationId, id) => (assert.equal(integrationId, 'int-1'), { database: 'DB', schemaName: 'WB', tableName: tables[id] }),
		renameDatasetTable: async (_c, _i, id, table) => (renames.push([id, table]), { ...table, tableName: `${table.tableName}_1` })
	};
	const summary = await pushPlan({ config: testConfig(root), slug: 'sales', deps, emitter: quiet });
	const mappings = created.actions.filter((a) => a.type === 'PublishToVault').map((a) => [a.dataSource.name, a.dataSource.schemaMapping]);
	assert.deepEqual(mappings, [
		['Sales Orders', { database: 'DB', schemaName: 'WB', tableName: 'T2D_SALES_ORDERS' }],
		['Orders', { database: 'DB', schemaName: 'WB', tableName: 'T2D_SALES_ORDERS' }],
		['Kept', { database: 'DB', schemaName: 'WB', tableName: 'T2D_SALES_KEPT' }]
	]);
	assert.deepEqual(renames, [['bbbb-2222', { database: 'DB', schemaName: 'WB', tableName: 'T2D_SALES_ORDERS' }]], 'only the table left under its id; FINANCE_KEPT was renamed by hand');
	const b = summary.actions.find((x) => x.kind === 'dataset' && x.key === 'sales.b');
	assert.ok(b.notes.includes('Snowflake table DB.WB.T2D_SALES_ORDERS_1'), 'the name ice settled on');
	assert.equal(summary.issues.filter((i) => i.code === 'push.warehouse-table-name').length, 0);
});
