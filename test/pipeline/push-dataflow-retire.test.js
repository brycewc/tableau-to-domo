import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { unpushPlan } from '../../src/pipeline/unpush.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const OLD = 'sales.orders.initial-sql';
const OUT = 'sales.orders.result';

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

const quiet = { step() {}, progress() {}, warn() {}, done() {}, child() { return quiet; } };

function output(key, dataflowKey, name = 'Result') {
	return { key, name, strategy: 'dataflow-output', dataflowOutput: { dataflowKey, outputName: name }, schema: [], cardTarget: false, fieldMap: {} };
}

function flow(key, outputKeys, name = key) {
	return { key, name, definition: { name, actions: [{ type: 'LoadFromVault', dataSourceId: ref('dataset', 'orders') }] }, outputDatasetKeys: outputKeys, runAfterCreate: true };
}

function planWith(datasets, dataflows) {
	const plan = samplePlan();
	plan.datasets = [plan.datasets[0], ...datasets];
	plan.dataflows = dataflows;
	plan.beastModes = [];
	plan.cards = [];
	plan.pages = [];
	return plan;
}

const firstPlan = () => planWith([output(OUT, OLD)], [flow(OLD, [OUT])]);

async function setup(plan) {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	await ws.writeJson(p.plan, plan);
	return { ws, config: testConfig(root) };
}

function stubs() {
	const { deps, calls } = stubDomo();
	let n = 0;
	deps.dataflows = {
		createDataflow: async (_c, def) => {
			n += 1;
			calls.push({ name: 'createDataflow', args: def });
			return { id: 40 + n, outputs: [{ dataSourceId: `out-${n}`, dataSourceName: 'Result' }] };
		},
		updateDataflow: async (_c, id) => (calls.push({ name: 'updateDataflow', args: id }), { id }),
		runDataflow: async () => ({ id: 7 }),
		waitForExecution: async () => ({ state: 'SUCCESS' })
	};
	return { deps, calls };
}

async function pushedOnce() {
	const env = await setup(firstPlan());
	const s = stubs();
	await pushPlan({ ...env, config: env.config, slug: 'sales', deps: s.deps, emitter: quiet });
	return { ...env, ...s };
}

test('a new dataflow is stamped for its workbook as soon as it is created', async () => {
	const env = await setup(firstPlan());
	const { deps } = stubs();
	deps.dataflows.waitForExecution = async () => ({ state: 'FAILED' });
	const summary = await pushPlan({ config: env.config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.actions.find((a) => a.key === OLD).status, 'failed');
	assert.deepEqual((await loadState(env.ws, 'acme')).objects[`dataflow:${OLD}`].extra.workbooks, ['sales']);
});

test('a dataflow the plan dropped is retired with its output and kept for unpush, without calling Domo', async () => {
	const { ws, config, calls } = await pushedOnce();
	const before = calls.length;
	const summary = await pushPlan({ config, slug: 'sales', deps: stubs().deps, plan: planWith([], []), emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status === 'failed')));
	assert.equal(calls.length, before);
	const df = summary.actions.find((a) => a.kind === 'dataflow');
	assert.deepEqual([df.key, df.action, df.id, df.status], [OLD, 'retire', 41, 'ok']);
	const out = summary.actions.find((a) => a.kind === 'dataset' && a.key === OUT);
	assert.deepEqual([out.action, out.id], ['retire', 'out-1']);
	assert.equal(summary.counts.retire, 2);
	const issue = summary.issues.find((i) => i.code === 'push.dataflow-retired');
	assert.match(issue.message, /out-1/);
	assert.match(issue.suggestion, new RegExp(`--keys dataflow:${OLD},dataset:${OUT}`));

	const state = await loadState(ws, 'acme');
	assert.deepEqual(state.objects[`dataflow:${OLD}`].extra.workbooks, ['sales']);
	assert.ok(state.objects[`dataflow:${OLD}`].extra.retiredAt);
	assert.ok(state.objects[`dataset:${OUT}`].extra.retiredAt);

	const again = await pushPlan({ config, slug: 'sales', deps: stubs().deps, plan: planWith([], []), emitter: quiet });
	assert.equal(again.counts.retire, undefined, 'an already retired dataflow is not reported again');

	const unpush = await unpushPlan({ config, slug: 'sales', dryRun: true, plan: planWith([], []), emitter: quiet });
	assert.equal(unpush.actions.find((a) => a.key === OLD).action, 'delete');
	assert.equal(unpush.actions.find((a) => a.key === OUT).action, 'delete');
});

test('dry run lists the retire action and leaves state alone', async () => {
	const { ws, config } = await pushedOnce();
	const saved = JSON.stringify((await loadState(ws, 'acme')).objects);
	const summary = await pushPlan({ config, slug: 'sales', dryRun: true, plan: planWith([], []) });
	const df = summary.actions.find((a) => a.kind === 'dataflow');
	assert.deepEqual([df.key, df.action, df.status], [OLD, 'retire', 'dry-run']);
	assert.equal(summary.counts.retire, 2);
	assert.ok(summary.issues.some((i) => i.code === 'push.dataflow-retired'));
	assert.equal(JSON.stringify((await loadState(ws, 'acme')).objects), saved);
});

test('an output another dataflow now builds moves to a retired key, and the new dataflow creates its own', async () => {
	const { ws, config } = await pushedOnce();
	const next = planWith([output(OUT, `${OLD}-2`)], [flow(`${OLD}-1`, []), flow(`${OLD}-2`, [OUT])]);
	const dry = await pushPlan({ config, slug: 'sales', dryRun: true, plan: next });
	assert.ok(dry.actions.some((a) => a.kind === 'dataset' && a.key.startsWith(`${OUT}~dataflow-output-`) && a.action === 'retire'));
	assert.equal(dry.actions.find((a) => a.kind === 'dataset' && a.key === OUT).action, 'create');

	const { deps } = stubs();
	const summary = await pushPlan({ config, slug: 'sales', deps, plan: next, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status === 'failed')));
	const state = await loadState(ws, 'acme');
	const retired = Object.entries(state.objects).find(([k]) => k.startsWith(`dataset:${OUT}~dataflow-output-`));
	assert.equal(retired[1].id, 'out-1');
	assert.deepEqual(retired[1].extra.workbooks, ['sales']);
	assert.equal(state.objects[`dataset:${OUT}`].id, 'out-2');
	assert.equal(state.objects[`dataset:${OUT}`].extra.dataflowKey, `${OLD}-2`);
	assert.equal(state.objects[`dataset:${OUT}`].extra.retiredAt, undefined);
});

test('a dataflow another workbook also uses only loses this workbook\'s stamp', async () => {
	const { ws, config } = await pushedOnce();
	const state = await loadState(ws, 'acme');
	state.objects[`dataflow:${OLD}`].extra.workbooks = ['sales', 'other'];
	await saveState(ws, state);
	const summary = await pushPlan({ config, slug: 'sales', deps: stubs().deps, plan: planWith([], []), emitter: quiet });
	assert.equal(summary.counts.retire, undefined);
	const after = await loadState(ws, 'acme');
	assert.deepEqual(after.objects[`dataflow:${OLD}`].extra.workbooks, ['other']);
	assert.equal(after.objects[`dataflow:${OLD}`].extra.retiredAt, undefined);
	assert.deepEqual(after.objects[`dataset:${OUT}`].extra.workbooks, []);
});

test('an unstamped dataflow is claimed only when its key is in this workbook\'s namespace', async () => {
	const env = await setup(planWith([], []));
	await saveState(env.ws, {
		instance: 'acme',
		objects: {
			[`dataflow:${OLD}`]: { id: 136 },
			'dataflow:pds-abc.initial-sql': { id: 137 },
			'dataflow:sales.made-in-domo': { id: 138, extra: { adopted: true } },
			'dataflow:other.orders.initial-sql': { id: 139, extra: { workbooks: ['other'] } }
		}
	});
	const summary = await pushPlan({ config: env.config, slug: 'sales', deps: stubs().deps, emitter: quiet });
	const retired = summary.actions.filter((a) => a.action === 'retire');
	assert.deepEqual(retired.map((a) => a.id), [136]);
	assert.match(retired[0].notes.join(' '), /without a workbook stamp/);
	const state = await loadState(env.ws, 'acme');
	assert.deepEqual(state.objects[`dataflow:${OLD}`].extra.workbooks, ['sales']);
	assert.equal(state.objects['dataflow:pds-abc.initial-sql'].extra, undefined);
	assert.deepEqual(state.objects['dataflow:sales.made-in-domo'].extra, { adopted: true });
	assert.deepEqual(state.objects['dataflow:other.orders.initial-sql'].extra, { workbooks: ['other'] });
});

test('partial pushes do not retire dataflows', async () => {
	const { ws, config } = await pushedOnce();
	const dropped = planWith([], []);
	for (const opts of [{ only: 'datasets' }, { only: 'cards' }, { selection: { keys: 'dataflow:*' } }, { selection: { keys: 'orders' } }, { selection: { datasources: 'Orders' } }]) {
		const summary = await pushPlan({ config, slug: 'sales', deps: stubs().deps, plan: dropped, emitter: quiet, ...opts });
		assert.equal(summary.counts.retire, undefined, JSON.stringify(opts));
	}
	assert.equal((await loadState(ws, 'acme')).objects[`dataflow:${OLD}`].extra.retiredAt, undefined);
});

test('a retired dataflow the plan brings back is updated in place and no longer retired', async () => {
	const { ws, config, calls } = await pushedOnce();
	await pushPlan({ config, slug: 'sales', deps: stubs().deps, plan: planWith([], []), emitter: quiet });
	const summary = await pushPlan({ config, slug: 'sales', deps: stubs().deps, plan: firstPlan(), emitter: quiet });
	assert.equal(summary.actions.find((a) => a.key === OLD).action, 'unchanged');
	assert.equal(calls.filter((c) => c.name === 'createDataflow').length, 1);
	const state = await loadState(ws, 'acme');
	assert.equal(state.objects[`dataflow:${OLD}`].extra.retiredAt, undefined);
	assert.equal(state.objects[`dataset:${OUT}`].extra.retiredAt, undefined);
	assert.equal(state.objects[`dataset:${OUT}`].id, 'out-1');
});
