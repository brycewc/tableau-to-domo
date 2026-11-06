import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { buildSqlView } from '../../src/convert/datasets.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		throw new Error(`unexpected network call ${init?.method ?? 'GET'} ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

function caPlan() {
	const plan = samplePlan();
	const ds = plan.datasets[0];
	delete ds.upload;
	ds.strategy = 'cloud-amplifier';
	ds.cloudAmplifier = { integrationId: 'int-1', databaseName: 'DB', schemaName: 'S', tableName: 'ORDERS', dataProviderKey: 'snowflake' };
	plan.datasets.push({
		key: 'view',
		name: 'View',
		strategy: 'view',
		schema: [{ name: 'Region', type: 'STRING' }],
		view: buildSqlView({ name: 'View', description: '', sql: 'select * from s.orders', refs: [{ start: 14, end: 22, table: 0 }], aliasKeys: ['orders'], columns: [{ name: 'Region', type: 'STRING' }] }),
		datasourceId: 'federated.2',
		cardTarget: false,
		fieldMap: {}
	});
	return plan;
}

async function setup(plan) {
	const root = tempDir();
	const ws = openWorkspace(root);
	await ws.writeJson(ws.paths('sales').plan, plan);
	return { ws, config: testConfig(root) };
}

function caStubs() {
	const { deps, calls } = stubDomo({ invalid: [] });
	deps.cloudAmplifier = {
		registerTables: async (_c, integrationId, tables) => (calls.push({ name: 'registerTables', args: { integrationId, tables } }), [{ datasetId: 'ca-1', status: 'SUCCESS', alreadyRegistered: false }])
	};
	deps.datasets.waitForReadable = async (_c, id, opts) => (calls.push({ name: 'waitForReadable', args: { id, ...opts } }), [{ name: 'Region', type: 'STRING' }]);
	deps.views = {
		createSqlView: async (_c, body) => (calls.push({ name: 'createSqlView', args: body }), { dataSourceId: 'view-1' }),
		createFusion: async () => {
			throw new Error('fusion API must not be used for SQL views');
		}
	};
	return { deps, calls };
}

test('dry run lists a register action without calling Domo', async () => {
	const { config } = await setup(caPlan());
	const summary = await pushPlan({ config, slug: 'sales', dryRun: true });
	const row = summary.actions.find((a) => a.key === 'orders');
	assert.equal(row.action, 'register');
	assert.equal(row.status, 'dry-run');
	assert.match(row.notes.join(' '), /DB\.S\.ORDERS on integration int-1/);
	assert.equal(summary.counts.register, 1);
	assert.equal(summary.actions.find((a) => a.key === 'view').notes[0], 'SQL DataSet View');
});

test('push registers the table, waits for its schema, records state, and builds SQL views on the registered id', async () => {
	const { ws, config } = await setup(caPlan());
	const { deps, calls } = caStubs();
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status === 'failed')));
	const reg = calls.find((c) => c.name === 'registerTables');
	assert.deepEqual(reg.args, { integrationId: 'int-1', tables: [{ databaseName: 'DB', schemaName: 'S', tableName: 'ORDERS', dataProviderKey: 'snowflake', displayName: 'Orders' }] });
	assert.ok(calls.findIndex((c) => c.name === 'waitForReadable' && c.args.id === 'ca-1') > calls.indexOf(reg));
	const view = calls.find((c) => c.name === 'createSqlView');
	assert.deepEqual(view.args.schema.tableAliases, { t1: 'ca-1' });
	assert.equal(calls.some((c) => c.name === 'createDataset' || c.name === 'uploadCsv'), false);
	const state = await loadState(ws, 'acme');
	assert.equal(state.objects['dataset:orders'].id, 'ca-1');
	assert.equal(state.objects['dataset:orders'].extra.strategy, 'cloud-amplifier');
	assert.equal(state.objects['dataset:orders'].extra.alreadyRegistered, false);

	const again = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(again.actions.find((a) => a.key === 'orders').action, 'reuse');
	assert.equal(calls.filter((c) => c.name === 'registerTables').length, 1);
});

test('a dataflow on a new SQL view waits until the view is readable, and runs again when the view changes', async () => {
	const plan = caPlan();
	plan.datasets.push({ key: 'joined', name: 'Joined', strategy: 'dataflow-output', dataflowOutput: { dataflowKey: 'join', outputName: 'Joined' }, schema: [], cardTarget: false, fieldMap: {} });
	plan.dataflows = [
		{ key: 'join', name: 'Join', definition: { name: 'Join', actions: [{ type: 'LoadFromVault', dataSourceId: { $ref: 'dataset:view' } }] }, outputDatasetKeys: ['joined'], runAfterCreate: true }
	];
	const { config } = await setup(plan);
	const { deps, calls } = caStubs();
	deps.views.updateSqlView = async (_c, id) => calls.push({ name: 'updateSqlView', args: { id } });
	deps.dataflows = {
		createDataflow: async () => (calls.push({ name: 'createDataflow' }), { id: 42, outputs: [{ dataSourceId: 'out-1', dataSourceName: 'Joined' }] }),
		runDataflow: async () => (calls.push({ name: 'runDataflow' }), { id: 7 }),
		waitForExecution: async () => ({ state: 'SUCCESS' })
	};
	const summary = await pushPlan({ config, slug: 'sales', deps, plan });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status === 'failed')));
	const ready = calls.findIndex((c) => c.name === 'waitForReadable' && c.args.id === 'view-1');
	assert.ok(ready > calls.findIndex((c) => c.name === 'createSqlView'));
	assert.deepEqual(calls[ready].args.columns, ['Region']);
	assert.ok(ready < calls.findIndex((c) => c.name === 'createDataflow'));
	assert.ok(ready < calls.findIndex((c) => c.name === 'runDataflow'));

	const unchanged = calls.length;
	await pushPlan({ config, slug: 'sales', deps, plan });
	assert.equal(calls.slice(unchanged).some((c) => c.name === 'waitForReadable' || c.name === 'runDataflow'), false);

	plan.datasets.find((d) => d.key === 'view').view.schema.viewTemplate.selectString += ' ';
	const before = calls.length;
	await pushPlan({ config, slug: 'sales', deps, plan });
	const later = calls.slice(before).map((c) => c.name);
	assert.ok(later.indexOf('updateSqlView') < later.indexOf('waitForReadable'));
	assert.ok(later.indexOf('waitForReadable') < later.indexOf('runDataflow'));
});

test('a view rejected for UNION branch types is sent again with the column cast in every branch', async () => {
	const plan = caPlan();
	const view = plan.datasets.find((d) => d.key === 'view');
	view.view.schema.tables[0].columns = [{ name: 'FQ', id: 'FQ', type: 'DOUBLE', visible: true, order: 0 }];
	view.view.schema.viewTemplate.selectString = 'SELECT FQ FROM `t1` UNION ALL SELECT 1.5 AS FQ FROM `t1`';
	const { config } = await setup(plan);
	const { deps, calls } = caStubs();
	const sent = [];
	deps.views.createSqlView = async (_c, body) => {
		sent.push(body.schema.viewTemplate.selectString);
		if (sent.length === 1) throw new Error('HTTP 400: {"message":"Invalid view definition column types do not match. FQ(FQ):LONG does not match FQ(FQ):DECIMAL"}');
		calls.push({ name: 'createSqlView' });
		return { dataSourceId: 'view-1' };
	};
	const summary = await pushPlan({ config, slug: 'sales', deps, plan });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status === 'failed')));
	assert.equal(sent[1], 'SELECT TRY_CAST(CAST(FQ AS VARCHAR) AS DOUBLE) AS FQ FROM `t1` UNION ALL SELECT TRY_CAST(CAST(1.5 AS VARCHAR) AS DOUBLE) AS FQ FROM `t1`');
});

function uploadPlan() {
	const plan = samplePlan();
	plan.datasets[0].upload = undefined;
	return plan;
}

test('a strategy change never writes to a mapped existing dataset', async () => {
	const plan = uploadPlan();
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'existing', existing: { datasetId: 'CUSTOMER-DS' } };
	const { ws, config } = await setup(plan);
	const { deps, calls } = caStubs();
	await pushPlan({ config, slug: 'sales', deps, plan });
	assert.equal((await loadState(ws, 'acme')).objects['dataset:orders'].extra.strategy, 'existing');

	const next = uploadPlan();
	const summary = await pushPlan({ config, slug: 'sales', deps, plan: next });
	assert.ok(!calls.some((c) => ['updateSchema', 'uploadCsv'].includes(c.name) && c.args.id === 'CUSTOMER-DS'));
	assert.ok(calls.some((c) => c.name === 'createDataset'));
	assert.ok(summary.issues.some((i) => i.code === 'push.dataset-strategy-changed'));
	const state = await loadState(ws, 'acme');
	assert.equal(state.objects['dataset:orders'].id, 'ds-orders');
	assert.equal(state.objects['dataset:orders'].extra.strategy, 'upload');
	assert.ok(!Object.keys(state.objects).some((k) => k.startsWith('dataset:orders~')), 'a customer dataset is not kept for unpush');
});

test('an uploaded dataset that becomes Cloud Amplifier is registered anew and the old one is retired for unpush', async () => {
	const first = uploadPlan();
	const { ws, config } = await setup(first);
	const { deps, calls } = caStubs();
	await pushPlan({ config, slug: 'sales', deps, plan: first });
	const summary = await pushPlan({ config, slug: 'sales', deps, plan: caPlan() });
	assert.equal(summary.actions.find((a) => a.key === 'orders').action, 'register');
	assert.ok(calls.some((c) => c.name === 'registerTables'));
	const state = await loadState(ws, 'acme');
	assert.equal(state.objects['dataset:orders'].id, 'ca-1');
	const retired = Object.entries(state.objects).find(([k]) => k.startsWith('dataset:orders~upload-'));
	assert.equal(retired[1].id, 'ds-orders');
	assert.deepEqual(retired[1].extra.workbooks, ['sales']);
	const dry = await pushPlan({ config, slug: 'sales', dryRun: true, plan: first });
	assert.equal(dry.actions.find((a) => a.key === 'orders').action, 'create');
});

test('a table extract found registered is marked alreadyRegistered; ALREADY_REGISTERED after a retry is ownership-uncertain', async () => {
	const plan = caPlan();
	plan.datasets[0].cloudAmplifier.registeredDatasetId = 'pre-1';
	const { ws, config } = await setup(plan);
	const { deps } = caStubs();
	deps.cloudAmplifier.registerTables = async () => [{ datasetId: 'pre-1', status: 'SUCCESS', alreadyRegistered: false }];
	await pushPlan({ config, slug: 'sales', deps, plan });
	assert.equal((await loadState(ws, 'acme')).objects['dataset:orders'].extra.alreadyRegistered, true);

	const other = await setup(caPlan());
	const stubs = caStubs();
	stubs.deps.cloudAmplifier.registerTables = async () => [{ datasetId: 'ca-9', status: 'SKIPPED', alreadyRegistered: true, afterRetry: true }];
	const summary = await pushPlan({ config: other.config, slug: 'sales', deps: stubs.deps });
	const entry = (await loadState(other.ws, 'acme')).objects['dataset:orders'];
	assert.equal(entry.extra.alreadyRegistered, false);
	assert.equal(entry.extra.ownershipUncertain, true);
	assert.ok(summary.issues.some((i) => i.code === 'push.cloud-amplifier-ownership-uncertain'));
});

test('a push stamps the datasets and beast modes its cards use, so another workbook\'s unpush keeps them', async () => {
	const plan = caPlan();
	const { ws, config } = await setup(plan);
	const { deps } = caStubs();
	await pushPlan({ config, slug: 'sales', deps });
	const b = samplePlan();
	b.cards = b.cards.map((card) => ({ ...card, key: `b-${card.key}`, pageKeys: [] }));
	b.pages = [];
	await pushPlan({ config, slug: 'b', deps, plan: b, only: 'cards' });
	const state = await loadState(ws, 'acme');
	assert.deepEqual(state.objects['dataset:orders'].extra.workbooks, ['sales', 'b']);
	assert.deepEqual(state.objects['beastmode:orders:ratio'].extra.workbooks, ['sales', 'b']);
});
