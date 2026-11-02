import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { overrideConfiguration, parseOnly, pushPlan, renameConnectorDatabases, resolveAccount, stripFormulaRefs } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const KIND_OF_CALL = {
	createDataset: 'dataset',
	updateSchema: 'dataset',
	uploadCsv: 'dataset',
	validateExpressions: 'beastmode',
	listDatasetBeastModes: 'beastmode',
	createBeastMode: 'beastmode',
	updateBeastMode: 'beastmode',
	createPage: 'page',
	createCard: 'card',
	updateCard: 'card',
	applyBigNumber: 'card',
	writeLayout: 'layout'
};

let realFetch;
let fetchCalls;
beforeEach(() => {
	realFetch = globalThis.fetch;
	fetchCalls = [];
	globalThis.fetch = async (url, init) => {
		fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
		throw new Error(`unexpected network call ${init?.method ?? 'GET'} ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

async function setup(plan = samplePlan()) {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	await ws.writeJson(p.plan, plan);
	await ws.writeJson(p.ir, { irVersion: 1, workbook: { name: 'Sales', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	return { ws, p, config: testConfig(root) };
}

test('dry run makes no network calls, writes no state, and plans creates in order', async () => {
	const { ws, p, config } = await setup();
	const events = [];
	const summary = await pushPlan({ config, slug: 'sales', dryRun: true, emitter: { ...silentEmitter(events) } });
	assert.equal(fetchCalls.length, 0);
	assert.equal(fs.existsSync(ws.stateFile('acme')), false);
	assert.ok(fs.existsSync(p.pushDryRun));
	assert.equal(fs.existsSync(p.pushLog), false);
	assert.equal(summary.dryRun, true);
	assert.ok(summary.actions.every((a) => a.status === 'dry-run'));
	assert.deepEqual(
		summary.actions.map((a) => `${a.kind}:${a.key}:${a.action}`),
		[
			'dataset:orders:create',
			'beastmode:orders:ratio:create',
			'beastmode:orders:bad:create',
			'page:root:create',
			'page:dash:create',
			'card:sheet-1:create',
			'card:sheet-2:create',
			'layout:dash:create'
		]
	);
	assert.equal(summary.actions[0].id, 'dry-run:dataset:orders');
});

test('dry run without Domo settings still works', async () => {
	const { config } = await setup();
	config.domo = { instance: '', accessToken: '' };
	const summary = await pushPlan({ config, slug: 'sales', dryRun: true });
	assert.equal(summary.instance, 'default');
	assert.equal(summary.counts.create, 8);
});

test('real push requires Domo settings', async () => {
	const { config } = await setup();
	config.domo = { instance: '', accessToken: '' };
	await assert.rejects(pushPlan({ config, slug: 'sales' }), /Missing Domo settings/);
});

test('push creates in dependency order, saves state, strips failed beast modes, then updates idempotently', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubDomo();
	const first = await pushPlan({ config, slug: 'sales', deps });

	const kinds = calls.map((c) => KIND_OF_CALL[c.name]);
	const order = ['dataset', 'beastmode', 'page', 'card', 'layout'];
	for (let i = 1; i < kinds.length; i++) assert.ok(order.indexOf(kinds[i - 1]) <= order.indexOf(kinds[i]), `${calls[i - 1].name} before ${calls[i].name}`);
	assert.deepEqual(calls.filter((c) => c.name === 'createPage').map((c) => c.args), [{ title: 'Sales' }, { title: 'Overview', parentPageId: calls.find((c) => c.name === 'createPage') && 502 }]);

	const validate = calls.find((c) => c.name === 'validateExpressions');
	assert.equal(validate.args.datasetId, 'ds-orders');
	assert.equal(validate.args.items.length, 2);
	assert.equal(calls.filter((c) => c.name === 'createBeastMode').length, 1);

	const created = calls.filter((c) => c.name === 'createCard');
	assert.equal(created.length, 2);
	assert.equal(created[0].args.body.dataProvider.dataSourceId, 'ds-orders');
	assert.ok(created[0].args.opts.pageId);
	const badColumns = created[1].args.body.definition.subscriptions.main.columns;
	assert.deepEqual(badColumns.map((col) => col.formulaId ?? col.column), ['Region', 'calculation_ratio']);
	assert.equal(calls.filter((c) => c.name === 'applyBigNumber').length, 1);

	const layout = calls.find((c) => c.name === 'writeLayout');
	assert.deepEqual(layout.args.layout.content.map((x) => typeof x.cardId), ['number', 'number']);

	assert.equal(first.ok, false);
	const bad = first.actions.find((a) => a.key === 'orders:bad');
	assert.equal(bad.status, 'failed');
	assert.match(bad.error, /INVALID_COLUMN/);
	assert.ok(first.issues.some((i) => i.code === 'push.beastmode-invalid'));
	assert.ok(first.issues.some((i) => i.code === 'push.card-missing-beastmode'));

	const state = await loadState(ws, 'acme');
	assert.equal(state.objects['dataset:orders'].id, 'ds-orders');
	assert.ok(state.objects['card:sheet-1'].id);
	assert.ok(state.objects['layout:dash']);
	assert.equal(state.objects['beastmode:orders:bad'], undefined);
	const log = await ws.readJson(p.pushLog);
	assert.equal(log.actions.length, first.actions.length);
	assert.ok(fs.readFileSync(p.report, 'utf8').includes('Migration report'));

	const second = stubDomo({ invalid: [] });
	const again = await pushPlan({ config, slug: 'sales', deps: second.deps });
	const names = second.calls.map((c) => c.name);
	assert.ok(!names.includes('createDataset'));
	assert.ok(!names.includes('createPage'));
	assert.ok(!names.includes('createCard'));
	assert.ok(!names.includes('uploadCsv'), 'unchanged CSV is not re-uploaded');
	assert.deepEqual(second.calls.filter((c) => c.name === 'createBeastMode').map((c) => c.args.legacyId), ['calculation_bad']);
	assert.equal(again.ok, true);
	assert.equal(again.actions.find((a) => a.key === 'sheet-1').action, 'unchanged');
	assert.equal(again.actions.find((a) => a.key === 'sheet-2').action, 'update');

	const plan = samplePlan();
	plan.cards[0].body.definition.title = 'Renamed';
	plan.datasets[0].schema.push({ name: 'Profit', type: 'DOUBLE' });
	const third = stubDomo({ invalid: [] });
	const result = await pushPlan({ config, slug: 'sales', deps: third.deps, plan });
	const thirdNames = third.calls.map((c) => c.name);
	assert.ok(thirdNames.includes('updateSchema'));
	assert.ok(!thirdNames.some((n) => n.startsWith('create')));
	const update = third.calls.find((c) => c.name === 'updateCard');
	assert.equal(update.args.id, state.objects['card:sheet-1'].id);
	assert.equal(result.actions.find((a) => a.key === 'sheet-1').action, 'update');
});

test('a failed dataset skips its dependents and the push continues', async () => {
	const { config } = await setup();
	const { deps, calls } = stubDomo();
	deps.datasets.createDataset = async () => {
		throw new Error('HTTP 403');
	};
	const summary = await pushPlan({ config, slug: 'sales', deps });
	const status = Object.fromEntries(summary.actions.map((a) => [`${a.kind}:${a.key}`, a.status]));
	assert.equal(status['dataset:orders'], 'failed');
	assert.equal(status['beastmode:orders:ratio'], 'skipped');
	assert.equal(status['card:sheet-1'], 'skipped');
	assert.equal(status['page:root'], 'ok');
	assert.equal(status['layout:dash'], 'ok');
	assert.ok(!calls.some((c) => c.name === 'createCard'));
	const layout = calls.find((c) => c.name === 'writeLayout');
	assert.deepEqual(layout.args.layout.content, []);
});

test('interrupted push resumes from saved state', async () => {
	const { ws, config } = await setup();
	const { deps } = stubDomo();
	deps.cards.createCard = async () => {
		throw new Error('boom');
	};
	await pushPlan({ config, slug: 'sales', deps });
	const state = await loadState(ws, 'acme');
	assert.ok(state.objects['page:dash']);
	assert.equal(state.objects['card:sheet-1'], undefined);
	const resumed = stubDomo();
	await pushPlan({ config, slug: 'sales', deps: resumed.deps });
	assert.ok(!resumed.calls.some((c) => c.name === 'createPage'));
	assert.equal(resumed.calls.filter((c) => c.name === 'createCard').length, 2);
});

test('only limits kinds and resolves the rest from state', async () => {
	const { config } = await setup();
	const { deps } = stubDomo();
	await pushPlan({ config, slug: 'sales', deps });
	const second = stubDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps: second.deps, only: 'cards', force: true });
	assert.deepEqual([...new Set(summary.actions.map((a) => a.kind))], ['card']);
	assert.ok(second.calls.every((c) => KIND_OF_CALL[c.name] === 'card'));
	assert.throws(() => parseOnly('cards,widgets'), /Unknown push kind "widgets"/);
});

test('existing and dataflow-output datasets are recorded from mappings and dataflow responses', async () => {
	const plan = samplePlan();
	plan.datasets = [
		{ key: 'raw', name: 'Raw', strategy: 'existing', existing: { datasetId: 'existing-1' }, schema: [], cardTarget: false, fieldMap: {} },
		{ key: 'orders', name: 'Orders joined', strategy: 'dataflow-output', dataflowOutput: { dataflowKey: 'join', outputName: 'Orders joined' }, schema: [], cardTarget: true, fieldMap: {} }
	];
	plan.dataflows = [
		{ key: 'join', name: 'Join', definition: { name: 'Join', actions: [{ type: 'LoadFromVault', dataSourceId: ref('dataset', 'raw') }] }, outputDatasetKeys: ['orders'], runAfterCreate: true }
	];
	plan.beastModes = [];
	plan.cards = plan.cards.slice(0, 1);
	const { ws, config } = await setup(plan);
	const { deps, calls } = stubDomo();
	deps.dataflows = {
		createDataflow: async (_c, def) => {
			calls.push({ name: 'createDataflow', args: def });
			return { id: 42, outputs: [{ dataSourceId: 'out-1', dataSourceName: 'Orders joined' }] };
		},
		runDataflow: async () => ({ id: 7 }),
		waitForExecution: async () => ({ state: 'SUCCESS' })
	};
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(calls.find((c) => c.name === 'createDataflow').args.actions[0].dataSourceId, 'existing-1');
	const state = await loadState(ws, 'acme');
	assert.equal(state.objects['dataset:raw'].id, 'existing-1');
	assert.equal(state.objects['dataset:orders'].id, 'out-1');
	assert.equal(calls.find((c) => c.name === 'createCard').args.body.dataProvider.dataSourceId, 'out-1');
	assert.equal(summary.ok, true);
});

test('a dataflow with an output missing from state is sent again even when its definition is unchanged', async () => {
	const plan = samplePlan();
	plan.datasets = [
		{ key: 'raw', name: 'Raw', strategy: 'existing', existing: { datasetId: 'existing-1' }, schema: [], cardTarget: false, fieldMap: {} },
		{ key: 'orders', name: 'Orders joined', strategy: 'dataflow-output', dataflowOutput: { dataflowKey: 'join', outputName: 'Orders joined' }, schema: [], cardTarget: true, fieldMap: {} },
		{ key: 'stacked', name: 'Stacked', strategy: 'dataflow-output', dataflowOutput: { dataflowKey: 'join', outputName: 'Stacked' }, schema: [], cardTarget: false, fieldMap: {} }
	];
	plan.dataflows = [
		{ key: 'join', name: 'Join', definition: { name: 'Join', actions: [{ type: 'LoadFromVault', dataSourceId: ref('dataset', 'raw') }] }, outputDatasetKeys: ['orders', 'stacked'], runAfterCreate: true }
	];
	plan.beastModes = [];
	plan.cards = plan.cards.slice(0, 1);
	const { ws, config } = await setup(plan);
	const { deps, calls } = stubDomo();
	const outputs = [{ dataSourceId: 'out-1', dataSourceName: 'Orders joined' }];
	deps.dataflows = {
		createDataflow: async () => ({ id: 42, outputs }),
		updateDataflow: async (_c, id) => {
			calls.push({ name: 'updateDataflow', args: id });
			return { id, outputs: [...outputs, { dataSourceId: 'out-2', dataSourceName: 'Stacked' }] };
		},
		getDataflow: async () => ({ id: 42, outputs }),
		runDataflow: async () => ({ id: 7 }),
		waitForExecution: async () => ({ state: 'SUCCESS' })
	};
	await pushPlan({ config, slug: 'sales', deps });
	assert.equal((await loadState(ws, 'acme')).objects['dataset:stacked'], undefined);
	await pushPlan({ config, slug: 'sales', deps });
	assert.equal(calls.filter((c) => c.name === 'updateDataflow').length, 1);
	assert.equal((await loadState(ws, 'acme')).objects['dataset:stacked'].id, 'out-2');
});

test('connector datasets need an account mapping', async () => {
	const plan = samplePlan();
	plan.datasets[0] = {
		...plan.datasets[0],
		strategy: 'connector',
		upload: undefined,
		connector: { providerKey: 'snowflake', accountMatch: { class: 'snowflake', server: 'acme.snowflakecomputing.com' }, configuration: [], query: 'select 1', updateMethod: 'REPLACE' }
	};
	const { ws, config } = await setup(plan);
	const { deps } = stubDomo();
	const runs = [];
	deps.streams = {
		createConnectorStream: async (_c, spec) => {
			runs.push(spec);
			return { streamId: 9, datasetId: 'conn-1' };
		},
		runStream: async () => ({ executionId: 1 }),
		executionIdOf: (e) => e.executionId,
		waitForStreamExecution: async () => ({ currentState: 'SUCCESS' })
	};
	const missing = await pushPlan({ config, slug: 'sales', deps });
	assert.match(missing.actions[0].error, /No mappings.json account/);
	await ws.writeJson(ws.mappingsFile, { datasets: {}, accounts: [{ match: { class: 'Snowflake' }, accountId: 55, connectorVersion: 2 }], columns: {} });
	const ok = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(ok.actions[0].status, 'ok');
	assert.equal(runs[0].accountId, 55);
	assert.equal(runs[0].connectorVersion, 2);
	assert.equal(runs[0].match, undefined);
});

test('a changed connector configuration updates and reruns the existing stream', async () => {
	const plan = samplePlan();
	const conf = (q) => [{ name: 'query', value: q, type: 'string', category: 'METADATA' }];
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'connector', upload: undefined, connector: { providerKey: 'mysql', accountMatch: { class: 'mysql' }, configuration: conf('select 1 limit 100'), updateMethod: 'REPLACE' } };
	const { ws, config } = await setup(plan);
	await ws.writeJson(ws.mappingsFile, { accounts: [{ match: { class: 'mysql' }, accountId: 3 }] });
	const { deps } = stubDomo();
	const log = [];
	deps.streams = {
		createConnectorStream: async () => (log.push('create'), { streamId: 9, datasetId: 'conn-1' }),
		updateConnectorStream: async (_c, id, upd) => log.push(`update ${id} ${upd.configuration[0].value}`),
		runStream: async () => (log.push('run'), { executionId: 1 }),
		executionIdOf: (e) => e.executionId,
		waitForStreamExecution: async () => ({})
	};
	await pushPlan({ config, slug: 'sales', deps });
	await pushPlan({ config, slug: 'sales', deps });
	assert.deepEqual(log, ['create', 'run']);
	plan.datasets[0].connector.configuration = conf('select 1 limit 50');
	await ws.writeJson(path.join(ws.paths('sales').dir, 'plan.json'), plan);
	const dry = await pushPlan({ config, slug: 'sales', deps, dryRun: true });
	assert.equal(dry.actions[0].action, 'update');
	const res = await pushPlan({ config, slug: 'sales', deps });
	assert.deepEqual(log, ['create', 'run', 'update 9 select 1 limit 50', 'run']);
	assert.equal(res.actions[0].action, 'update');
});

test('a connector account renames databases and overrides configuration (database shared under another name)', async () => {
	const plan = samplePlan();
	const query = 'SELECT * FROM ANALYTICS.MAIN.T WHERE D = (SELECT MAX(D) FROM "ANALYTICS"."MAIN"."T") LIMIT 100';
	const configuration = [
		{ name: 'query', value: query, type: 'string', category: 'METADATA' },
		{ name: 'databaseName', value: 'ANALYTICS', type: 'string', category: 'METADATA' },
		{ name: 'warehouseName', value: 'WH_TABLEAU', type: 'string', category: 'METADATA' },
		{ name: 'queryTag', value: '', type: 'string', category: 'METADATA' }
	];
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'connector', upload: undefined, connector: { providerKey: 'snowflakekeypairauthentication', accountMatch: { class: 'snowflake', dbname: 'ANALYTICS' }, configuration, query, updateMethod: 'REPLACE' } };
	const { ws, config } = await setup(plan);
	const { deps } = stubDomo();
	const runs = [];
	deps.streams = { createConnectorStream: async (_c, spec) => (runs.push(spec), { streamId: 9, datasetId: 'conn-1' }), runStream: async () => ({ executionId: 1 }), executionIdOf: (e) => e.executionId, waitForStreamExecution: async () => ({}) };
	await ws.writeJson(ws.mappingsFile, { accounts: [{ match: { class: 'snowflake', dbname: 'ANALYTICS' }, accountId: 101, databases: { ANALYTICS: 'PROD_ANALYTICS' }, configuration: { warehouseName: 'REPORTING_WH', queryTag: null } }] });
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(summary.actions[0].status, 'ok');
	assert.deepEqual(Object.fromEntries(runs[0].configuration.map((e) => [e.name, e.value])), {
		query: 'SELECT * FROM PROD_ANALYTICS.MAIN.T WHERE D = (SELECT MAX(D) FROM "PROD_ANALYTICS"."MAIN"."T") LIMIT 100',
		databaseName: 'PROD_ANALYTICS',
		warehouseName: 'REPORTING_WH'
	});
	assert.equal(runs[0].databases, undefined);
	assert.equal(plan.datasets[0].connector.configuration[1].value, 'ANALYTICS');
	assert.equal(renameConnectorDatabases(configuration, undefined), configuration);
	assert.equal(overrideConfiguration(configuration, undefined), configuration);
});

test('a connector dataset pushed with --schema-only skips its cards until a later push runs the stream', async () => {
	const plan = samplePlan();
	plan.datasets[0] = {
		...plan.datasets[0],
		strategy: 'connector',
		upload: undefined,
		connector: { providerKey: 'snowflake', accountMatch: { class: 'snowflake' }, configuration: [], query: 'select 1', updateMethod: 'REPLACE' }
	};
	const { ws, config } = await setup(plan);
	await ws.writeJson(ws.mappingsFile, { datasets: {}, accounts: [{ match: { class: 'snowflake' }, accountId: 55 }], columns: {} });
	const withStreams = (runStream) => {
		const stub = stubDomo();
		stub.deps.streams = {
			createConnectorStream: async () => ({ streamId: 9, datasetId: 'conn-1' }),
			runStream: async (...args) => (stub.calls.push({ name: 'runStream' }), runStream(...args)),
			executionIdOf: (e) => e.executionId,
			waitForStreamExecution: async () => ({ currentState: 'SUCCESS' })
		};
		return stub;
	};
	const quiet = silentEmitter([]);

	const dry = await pushPlan({ config, slug: 'sales', dryRun: true, selection: { schemaOnly: true }, emitter: quiet });
	assert.ok(dry.actions.filter((a) => a.kind === 'card').every((a) => a.status === 'skipped'));

	const first = withStreams(async () => ({ executionId: 1 }));
	const schemaOnly = await pushPlan({ config, slug: 'sales', deps: first.deps, selection: { schemaOnly: true }, emitter: quiet });
	assert.ok(!first.calls.some((c) => c.name === 'runStream'));
	const cards = schemaOnly.actions.filter((a) => a.kind === 'card');
	assert.equal(cards.length, 2);
	for (const card of cards) {
		assert.equal(card.status, 'skipped');
		assert.match(card.error, /has not run yet \(--schema-only\)/);
	}
	assert.ok(!first.calls.some((c) => c.name === 'createCard'));
	assert.equal((await loadState(ws, 'acme')).objects['dataset:orders'].extra.streamPending, true);

	const failing = withStreams(async () => {
		throw new Error('stream run failed');
	});
	const failed = await pushPlan({ config, slug: 'sales', deps: failing.deps, emitter: quiet });
	assert.equal(failed.actions[0].status, 'failed');
	assert.equal((await loadState(ws, 'acme')).objects['dataset:orders'].extra.streamPending, true, 'a failed run is retried next push');

	const full = withStreams(async () => ({ executionId: 2 }));
	const later = await pushPlan({ config, slug: 'sales', deps: full.deps, emitter: quiet });
	assert.equal(full.calls.filter((c) => c.name === 'runStream').length, 1);
	assert.equal(full.calls.filter((c) => c.name === 'createCard').length, 2);
	assert.equal(later.actions[0].status, 'ok');
	assert.equal((await loadState(ws, 'acme')).objects['dataset:orders'].extra.streamPending, undefined);

	const again = withStreams(async () => ({ executionId: 3 }));
	await pushPlan({ config, slug: 'sales', deps: again.deps, emitter: quiet });
	assert.ok(!again.calls.some((c) => c.name === 'runStream'), 'a stream that ran is not rerun without --force');
});

test('resolveAccount picks the most specific match', () => {
	const mappings = {
		accounts: [
			{ match: { class: 'snowflake' }, accountId: 1 },
			{ match: { class: 'snowflake', server: 'a.example.com' }, accountId: 2 },
			{ match: { class: 'postgres' }, accountId: 3 }
		]
	};
	assert.equal(resolveAccount(mappings, { class: 'snowflake', server: 'A.example.com' }).accountId, 2);
	assert.equal(resolveAccount(mappings, { class: 'snowflake', server: 'b' }).accountId, 1);
	assert.equal(resolveAccount(mappings, { class: 'mysql' }), null);
});

test('stripFormulaRefs removes only array items with matching formulaId', () => {
	const [out, removed] = stripFormulaRefs({ a: [{ formulaId: 'x' }, { formulaId: 'y' }, 3], b: { $ref: 'dataset:k' } }, new Set(['x']));
	assert.equal(removed, 1);
	assert.deepEqual(out, { a: [{ formulaId: 'y' }, 3], b: { $ref: 'dataset:k' } });
	const [filters, gone] = stripFormulaRefs({ filters: [{ column: 'x', operand: 'IN', values: ['1'] }, { column: 'Region', filterType: 'COLUMN_ID' }] }, new Set(['x']));
	assert.deepEqual([gone, filters.filters.map((f) => f.column)], [1, ['Region']], 'a beast mode filter names its formula in column only');
});

function silentEmitter(events) {
	const emit = (type) => (message, data) => events.push({ type, message, data });
	const e = { step: emit('step'), progress: emit('progress'), info: emit('info'), warn: emit('warn'), error: emit('error'), done: emit('done') };
	e.child = () => e;
	return e;
}

test('concurrent pushes to one instance are refused instead of overwriting state', async () => {
	const { ws, config } = await setup();
	const { deps } = stubDomo();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const createPage = deps.pages.createPage;
	deps.pages.createPage = async (...args) => {
		await gate;
		return createPage(...args);
	};
	const first = pushPlan({ config, slug: 'sales', deps });
	await new Promise((resolve) => setTimeout(resolve, 20));
	await assert.rejects(pushPlan({ config, slug: 'sales', deps: stubDomo().deps }), /Another push to "acme" is running/);
	release();
	await first;
	assert.equal(fs.existsSync(ws.stateFile('acme').replace(/\.json$/, '.lock')), false);
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
});

test('a stale lock left by a dead process is replaced', async () => {
	const { ws, config } = await setup();
	const lock = ws.stateFile('acme').replace(/\.json$/, '.lock');
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'then' }));
	const summary = await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
	assert.ok(summary.actions.length);
});

test('--only cards strips beast modes that have no state entry', async () => {
	const { config } = await setup();
	const { deps } = stubDomo();
	await pushPlan({ config, slug: 'sales', deps, only: 'datasets' });
	const second = stubDomo();
	await pushPlan({ config, slug: 'sales', deps: second.deps, only: 'pages,cards' });
	for (const call of second.calls.filter((c) => c.name === 'createCard')) {
		assert.ok(!JSON.stringify(call.args.body).includes('calculation_ratio'), 'card still references an unpushed beast mode');
	}
});

test('a beast mode whose dataset changed is created again instead of updated', async () => {
	const { ws, config } = await setup();
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
	const state = await loadState(ws, 'acme');
	for (const entry of Object.values(state.objects)) if (entry.extra?.datasetId) entry.extra.datasetId = 'ds-old';
	await ws.writeJson(ws.stateFile('acme'), state);
	const second = stubDomo();
	await pushPlan({ config, slug: 'sales', deps: second.deps, only: 'beastmodes', force: true });
	assert.equal(second.calls.filter((c) => c.name === 'updateBeastMode').length, 0);
	assert.ok(second.calls.some((c) => c.name === 'createBeastMode'));
});

test('a beast mode that left the plan is deleted, unless a card t2d did not create uses it', async () => {
	const plan = samplePlan();
	const extra = (key) => ({ ...plan.beastModes[0], key, name: key, legacyId: `calculation_${key.replace(':', '_')}`, expression: '`Region`', aggregated: false });
	plan.beastModes.push(extra('orders:rename'), extra('orders:shared'));
	const { ws, p, config } = await setup(plan);
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
	const before = await loadState(ws, 'acme');
	const idOf = (key) => before.objects[`beastmode:${key}`].id;
	await ws.writeJson(p.plan, { ...plan, beastModes: plan.beastModes.filter((bm) => !['orders:rename', 'orders:shared'].includes(bm.key)) });
	const second = stubDomo();
	const deleted = [];
	Object.assign(second.deps.beastmodes, {
		getBeastMode: async (_c, id) => ({ id, name: `bm ${id}`, links: id === idOf('orders:shared') ? [{ resource: { type: 'CARD', id: '424242' }, visible: false, active: true }] : [{ resource: { type: 'DATA_SOURCE', id: 'ds-orders' }, visible: true, active: true }] }),
		deleteBeastModes: async (_c, ids, opts) => deleted.push({ ids, opts })
	});
	const summary = await pushPlan({ config, slug: 'sales', deps: second.deps });
	assert.deepEqual(deleted.map((x) => x.ids), [[idOf('orders:rename')]]);
	assert.ok(deleted[0].opts.unlink[idOf('orders:rename')], 'its links are removed in the same call');
	const after = await loadState(ws, 'acme');
	assert.equal(after.objects['beastmode:orders:rename'], undefined);
	assert.ok(after.objects['beastmode:orders:shared'], 'kept while a foreign card uses it');
	assert.ok(summary.issues.some((i) => i.code === 'push.beastmode-foreign-use' && /424242/.test(i.message)));
	assert.ok(after.objects['beastmode:orders:ratio'], 'beast modes still in the plan stay');
});

test('a beast mode that left one workbook\'s plan but another workbook pushed stays, given up by this workbook only', async () => {
	const plan = samplePlan();
	plan.beastModes.push({ ...plan.beastModes[0], key: 'orders:unused', name: 'orders:unused', legacyId: 'calculation_orders_unused', expression: '`Region`', aggregated: false });
	const { ws, p, config } = await setup(plan);
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
	const state = await loadState(ws, 'acme');
	state.objects['beastmode:orders:unused'].extra.workbooks = ['sales', 'other'];
	await ws.writeJson(ws.stateFile('acme'), state);
	await ws.writeJson(p.plan, { ...plan, beastModes: plan.beastModes.filter((bm) => bm.key !== 'orders:unused') });
	const second = stubDomo();
	const deleted = [];
	second.deps.beastmodes.deleteBeastModes = async (_c, ids) => deleted.push(ids);
	await pushPlan({ config, slug: 'sales', deps: second.deps });
	assert.deepEqual(deleted, []);
	assert.deepEqual((await loadState(ws, 'acme')).objects['beastmode:orders:unused'].extra.workbooks, ['other']);
});

test('an unsupported card Domo never had does not hold back retiring beast modes; a failed card that exists does', async () => {
	const plan = samplePlan();
	plan.beastModes.push({ ...plan.beastModes[0], key: 'orders:rename', name: 'orders:rename', legacyId: 'calculation_orders_rename', expression: '`Region`', aggregated: false });
	const { ws, p, config } = await setup(plan);
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
	const retiring = {
		...plan,
		beastModes: plan.beastModes.filter((bm) => bm.key !== 'orders:rename'),
		cards: [...plan.cards, { ...plan.cards[0], key: 'label-sheet', title: 'Owner Name', status: 'unsupported', replacedBy: 'notebook' }]
	};
	await ws.writeJson(p.plan, retiring);
	const run = async (deps) => {
		const deleted = [];
		Object.assign(deps.beastmodes, { getBeastMode: async (_c, id) => ({ id, links: [] }), deleteBeastModes: async (_c, ids) => deleted.push(...ids) });
		await pushPlan({ config, slug: 'sales', deps, force: true });
		return deleted;
	};
	const failing = stubDomo();
	failing.deps.cards.updateCard = async () => {
		throw new Error('HTTP 500');
	};
	assert.deepEqual(await run(failing.deps), [], 'kept while a pushed card failed to update');
	const id = (await loadState(ws, 'acme')).objects['beastmode:orders:rename'].id;
	assert.deepEqual(await run(stubDomo().deps), [id]);
});

test('a retitled page is renamed on the next push', async () => {
	const { ws, p, config } = await setup();
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps });
	const plan = await ws.readJson(p.plan);
	plan.pages[0].title = 'Sales (migrated)';
	await ws.writeJson(p.plan, plan);
	const second = stubDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps: second.deps, only: 'pages' });
	assert.deepEqual(second.calls.filter((c) => c.name === 'updatePage').map((c) => c.args.title), ['Sales (migrated)']);
	assert.equal(summary.actions.find((a) => a.kind === 'page' && a.key === plan.pages[0].key).action, 'update');
});

test('a split card is pushed as one card per member the dataset holds, stacked in the layout', async () => {
	const plan = samplePlan();
	plan.cards[0].split = { pillId: 'r', name: 'Region', ref: { column: 'Region' }, filter: { column: 'Region', filterType: 'COLUMN_ID', operand: 'IN', dataType: 'string' }, max: 6 };
	const { ws, config } = await setup(plan);
	const { deps, calls } = stubDomo();
	deps.cards.previewMembers = async (_c, body, column) => {
		calls.push({ name: 'previewMembers', args: { dataSourceId: body.dataProvider.dataSourceId, column } });
		return ['West', 'East'];
	};
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.deepEqual(calls.find((c) => c.name === 'previewMembers').args, { dataSourceId: 'ds-orders', column: { column: 'Region' } });
	const titles = calls.filter((c) => c.name === 'createCard').map((c) => c.args.body.definition.title);
	assert.deepEqual(titles, ['Sales by Region: East', 'Sales by Region: West', 'Bad ratio']);
	const layout = calls.find((c) => c.name === 'writeLayout').args.layout;
	assert.equal(layout.content.length, 3);
	assert.deepEqual(layout.standard.template.filter((i) => i.x === 0).map((i) => [i.y, i.height]), [[0, 14], [14, 14]], 'two of 20 / 2 rows would draw no axes, so each gets the 14-row floor');
	assert.ok(summary.issues.some((i) => i.code === 'push.card-split' && i.severity === 'info'));
	const state = await loadState(ws, 'acme');
	assert.deepEqual(state.objects['card:sheet-1.west'].extra.splitOf, { key: 'sheet-1', member: 'West' });

	const layoutsOnly = await pushPlan({ config, slug: 'sales', deps: stubDomo().deps, only: 'layouts' });
	const again = layoutsOnly.actions.find((a) => a.kind === 'layout');
	assert.deepEqual([again.action, again.status], ['unchanged', 'ok'], 'a layouts-only push stacks the member cards an earlier push made');
});
