import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { convertStage } from '../../src/pipeline/convert.js';
import { missingDependencies, pushPlan } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { superstoreWorkspace } from '../convert/superstore-plan.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
let realFetch;
let cleanups = [];
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
	cleanups.forEach((f) => f());
	cleanups = [];
});

async function setup(plan = samplePlan()) {
	const root = tempDir();
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n"No\nrth",3\n');
	await ws.writeJson(p.plan, plan);
	return { ws, p, config: testConfig(root) };
}

test('extract with a dashboard selection and sample rows: sampled manifest, other manifests kept, convert reuses the selection', async () => {
	const w = await superstoreWorkspace({ selection: { dashboards: ['Details'], sampleRows: 2 } });
	cleanups.push(w.cleanup);
	assert.equal(w.manifests.length, 1, 'only the dashboard datasource is extracted');
	const m = w.manifests[0];
	assert.equal(m.sampled, 2);
	assert.ok(m.issues.some((i) => i.code === 'data.sampled'));
	const orders = m.tables.find((t) => /orders/i.test(t.name));
	assert.equal(orders.rowCount, 2);
	const csv = fs.readFileSync(path.join(w.config.workspace, 'workbooks', w.slug, orders.file), 'utf8');
	assert.equal(csv.trim().split('\n').length, 3, 'header plus 2 rows');
	const ws = openWorkspace(w.config.workspace);
	const meta = await ws.readJson(ws.paths(w.slug).metadata);
	assert.deepEqual(meta.selection, { dashboards: ['Details'], worksheets: [], datasources: [], sampleRows: 2 });

	const plan = await convertStage({ config: w.config, slug: w.slug, emitter: quiet });
	assert.deepEqual(plan.selection.dashboards, ['Details']);
	assert.ok(plan.datasets.some((d) => d.upload?.sampled === 2));
	assert.match(fs.readFileSync(ws.paths(w.slug).report, 'utf8'), /Partial data/);
	const full = await convertStage({ config: w.config, slug: w.slug, full: true, emitter: quiet });
	assert.equal(full.selection, undefined);
	assert.ok(full.cards.length > plan.cards.length);
	await assert.rejects(convertStage({ config: w.config, slug: w.slug, selection: { worksheets: ['Nope'] }, emitter: quiet }), { name: 'SelectionError' });

	const dry = await pushPlan({ config: w.config, slug: w.slug, dryRun: true, emitter: quiet });
	assert.ok(dry.issues.some((i) => i.code === 'push.partial-data'));
});

test('kinds that exclude a needed dataset fail before any write unless it is in state', async () => {
	const { config } = await setup();
	const first = stubDomo();
	await assert.rejects(pushPlan({ config, slug: 'sales', deps: first.deps, only: 'cards', emitter: quiet }), /excluded by --only\/--keys and not pushed yet: dataset:orders \(needed by card:sheet-1, card:sheet-2\)/);
	assert.equal(first.calls.length, 0);
	await assert.rejects(pushPlan({ config, slug: 'sales', dryRun: true, selection: { kinds: ['layouts'] }, emitter: quiet }), /page:dash/);
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps, only: 'datasets', emitter: quiet });
	const second = stubDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps: second.deps, selection: { kinds: ['pages', 'cards'] }, emitter: quiet });
	assert.equal(summary.counts['status:failed'] || 0, 0);
	assert.ok(second.calls.some((c) => c.name === 'createCard'));
});

test('keys limit what push writes; existing datasets need no state; missingDependencies lists the gaps', async () => {
	const plan = samplePlan();
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'existing', existing: { datasetId: 'ds-existing' }, upload: undefined };
	const { ws, config } = await setup(plan);
	const { deps, calls } = stubDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, selection: { keys: ['root', 'dash', 'card:sheet-1'] }, emitter: quiet });
	assert.deepEqual([...new Set(summary.actions.map((a) => `${a.kind}:${a.key}`))].sort(), ['card:sheet-1', 'layout:dash', 'page:dash', 'page:root'], 'a bare key matches the page and its layout');
	assert.equal(calls.find((c) => c.name === 'createCard').args.body.dataProvider.dataSourceId, 'ds-existing');
	const state = await loadState(ws, 'acme');
	assert.deepEqual(state.objects['card:sheet-1'].extra.workbooks, ['sales']);
	const gaps = missingDependencies(samplePlan(), (kind) => kind === 'layout', () => false);
	assert.deepEqual(gaps.map((g) => g.ref), ['page:dash']);
});

test('missingDependencies lists a variable a written beast mode references', () => {
	const plan = samplePlan();
	const legacyId = 'calculation_00000000-0000-0000-0000-00000000000a';
	plan.variables = [{ key: 'param.pick.string', name: 'Pick', legacyId, dataType: 'STRING', defaultExpression: "'x'" }];
	plan.beastModes[0] = { ...plan.beastModes[0], expression: `CASE WHEN DOMO_BEAST_MODE(${legacyId}) = 'x' THEN 1 END` };
	const exists = (r) => r.startsWith('dataset:');
	assert.deepEqual(missingDependencies(plan, (kind) => kind === 'beastmode', exists).map((g) => [g.ref, g.by]), [['variable:param.pick.string', [`beastmode:${plan.beastModes[0].key}`]]]);
	assert.deepEqual(missingDependencies(plan, (kind) => kind === 'beastmode' || kind === 'variable', exists), []);
});

test('schema-only creates datasets without rows; sample rows uploads only N rows and re-uploads in full later', async () => {
	const { ws, config } = await setup();
	const a = stubDomo();
	const headers = [];
	a.deps.datasets.uploadCsv = async (_c, id, file) => {
		headers.push(fs.readFileSync(file, 'utf8'));
		return { rowCount: 0 };
	};
	const s1 = await pushPlan({ config, slug: 'sales', deps: a.deps, only: 'datasets', selection: { schemaOnly: true }, emitter: quiet });
	assert.ok(a.calls.some((c) => c.name === 'createDataset'));
	assert.deepEqual(headers, ['Region,Sales\n'], 'a header-only upload indexes the schema');
	assert.match(s1.actions[0].notes.join(';'), /schema-only/);
	const again = stubDomo();
	await pushPlan({ config, slug: 'sales', deps: again.deps, only: 'datasets', selection: { schemaOnly: true }, emitter: quiet });
	assert.ok(!again.calls.some((c) => c.name === 'uploadCsv'), 'the header upload is not repeated');

	const uploaded = [];
	const b = stubDomo();
	b.deps.datasets.uploadCsv = async (_c, id, file) => {
		uploaded.push(fs.readFileSync(file, 'utf8'));
		return { rowCount: 1 };
	};
	const s2 = await pushPlan({ config, slug: 'sales', deps: b.deps, only: 'datasets', selection: { sampleRows: 1 }, emitter: quiet });
	assert.deepEqual(uploaded, ['Region,Sales\nEast,1\n']);
	assert.ok(s2.issues.some((i) => i.code === 'push.partial-data'));
	assert.equal(fs.existsSync(path.join(ws.paths('sales').dir, 'push-sample')) ? fs.readdirSync(path.join(ws.paths('sales').dir, 'push-sample')).length : 0, 0, 'sample file removed');

	const c = stubDomo();
	await pushPlan({ config, slug: 'sales', deps: c.deps, only: 'datasets', emitter: quiet });
	assert.equal(c.calls.filter((x) => x.name === 'uploadCsv').length, 1, 'a full push re-uploads after a sample');
});

test('push with a dashboard selection prunes the plan it pushes', async () => {
	const w = await superstoreWorkspace();
	cleanups.push(w.cleanup);
	await convertStage({ config: w.config, slug: w.slug, emitter: quiet });
	const dry = await pushPlan({ config: w.config, slug: w.slug, dryRun: true, selection: { dashboards: ['Executive Overview'] }, emitter: quiet });
	const kinds = (k) => dry.actions.filter((a) => a.kind === k).map((a) => a.key);
	assert.equal(kinds('card').length, 7);
	assert.deepEqual(kinds('layout'), ['superstore--executive-overview']);
	assert.equal(kinds('beastmode').length, 2);
	assert.equal(kinds('dataflow').length, 1);
});
