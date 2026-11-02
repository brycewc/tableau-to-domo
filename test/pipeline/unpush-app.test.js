import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { planGraph, unpushPlan } from '../../src/pipeline/unpush.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { appPlan, stubAppDomo } from './app-helpers.js';
import { tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
const roots = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

/** Push appPlan with the in-memory App Studio, then give the stub the deletes unpush needs. */
async function pushed(opts, pushOpts = {}) {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, appPlan());
	const config = testConfig(root);
	const stub = stubAppDomo(opts);
	const summary = await pushPlan({ config, slug: 'sales', deps: stub.deps, emitter: quiet, ...pushOpts });
	assert.equal(summary.ok, true);
	const rec = (name, args, result) => {
		stub.calls.push({ name, args });
		return result;
	};
	Object.assign(stub.deps.cards, { deleteCard: async (_c, id) => rec('deleteCard', { id }), listDatasetCards: async () => [] });
	Object.assign(stub.deps.datasets, { deleteDataset: async (_c, id) => rec('deleteDataset', { id }), listDownstream: async () => ({ dataflows: [], datasets: [] }) });
	const gone = Object.assign(new Error('HTTP 404'), { status: 404 });
	Object.assign(stub.deps.beastmodes, {
		getBeastMode: async () => {
			throw gone;
		},
		deleteBeastModes: async (_c, ids) => rec('deleteBeastModes', { ids }),
		deleteTemplate: async (_c, id) => rec('deleteTemplate', { id })
	});
	Object.assign(stub.deps.pages, {
		getSubpageIds: async () => {
			throw new Error('a classic page call was sent to a view');
		},
		deletePage: async () => {
			throw new Error('a classic page call was sent to a view');
		}
	});
	stub.calls.length = 0;
	return { ws, config, ...stub, state: await loadState(ws, 'acme') };
}

test('planGraph: views and navigation depend on the app', () => {
	const { dependents, nodes } = planGraph(appPlan());
	assert.ok(nodes.has('app:root') && nodes.has('navigation:root'));
	assert.deepEqual([...dependents.get('app:root')].sort(), ['navigation:root', 'page:dash', 'page:details']);
});

test('unpush deletes cards, then clears saved themes and deletes the app with its views, layouts and navigation', async () => {
	const { ws, config, deps, calls, server, state } = await pushed();
	const appId = state.objects['app:root'].id;
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const order = calls.map((c) => c.name);
	assert.deepEqual(order.slice(0, 2), ['deleteCard', 'deleteCard']);
	assert.ok(order.indexOf('setSavedThemes') < order.indexOf('deleteApp'));
	assert.ok(order.indexOf('deleteApp') < order.indexOf('deleteDataset'));
	assert.ok(!order.includes('deleteView'), 'views go with the app');
	assert.deepEqual(calls.find((c) => c.name === 'setSavedThemes').args, { appId, themes: [] });
	assert.equal(server.apps.has(String(appId)), false);
	const rows = summary.actions.map((a) => `${a.action} ${a.kind}:${a.key}`);
	for (const r of ['delete app:root', 'delete page:dash', 'delete layout:dash', 'delete page:details', 'delete layout:details', 'delete navigation:root']) assert.ok(rows.includes(r), r);
	assert.match(summary.actions.find((a) => a.kind === 'app').notes.join(' '), /permanent/);
	assert.deepEqual(Object.keys((await loadState(ws, 'acme')).objects), []);
});

test('an app holding views t2d did not create is kept and reported; only t2d views are deleted from it', async () => {
	const { ws, config, deps, calls, server, state } = await pushed({ foreignViews: ['Added by a user'] });
	const appId = state.objects['app:root'].id;
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(!calls.some((c) => c.name === 'deleteApp' || c.name === 'setSavedThemes'));
	assert.ok(server.apps.has(String(appId)));
	const app = summary.actions.find((a) => a.kind === 'app');
	assert.equal(app.status, 'skipped');
	assert.match(app.error, /did not create/);
	assert.ok(summary.issues.some((i) => i.code === 'unpush.app-foreign-views'));
	assert.deepEqual(server.apps.get(String(appId)).views.map((v) => v.title), ['Added by a user']);
	assert.deepEqual(calls.filter((c) => c.name === 'deleteView').map((c) => c.args.viewId).sort(), [state.objects['page:dash'].id, state.objects['page:details'].id].sort());
	const left = await loadState(ws, 'acme');
	assert.ok(left.objects['app:root'] && !left.objects['page:dash'] && !left.objects['page:details']);
	assert.ok(!left.objects['card:sheet-1'], 'cards are still deleted');
});

test('a dashboard subset deletes only its view; the last visible view is never deleted', async () => {
	const { ws, config, deps, calls, server, state } = await pushed();
	const appId = state.objects['app:root'].id;
	const summary = await unpushPlan({ config, slug: 'sales', selection: { dashboards: ['Details'] }, deps, emitter: quiet });
	assert.ok(summary.ok);
	assert.deepEqual(calls.filter((c) => c.name === 'deleteView').map((c) => c.args), [{ appId, viewId: state.objects['page:details'].id }]);
	assert.ok(!calls.some((c) => c.name === 'deleteApp'));
	const left = await loadState(ws, 'acme');
	assert.ok(left.objects['app:root'] && left.objects['page:dash'] && !left.objects['page:details'] && !left.objects['layout:details']);

	server.apps.get(String(appId)).views.forEach((v) => (v.visible = String(v.viewId) === String(state.objects['page:dash'].id)));
	calls.length = 0;
	const last = await unpushPlan({ config, slug: 'sales', selection: { dashboards: ['Overview'] }, deps, emitter: quiet });
	const view = last.actions.find((a) => a.kind === 'page' && a.key === 'dash');
	assert.equal(view.status, 'skipped');
	assert.match(view.error, /last visible view/);
	assert.ok(!calls.some((c) => c.name === 'deleteView'));
});

test('an app whose default view no dashboard took over is still deleted (push --only app)', async () => {
	const { ws, config, deps, calls, server, state } = await pushed({}, { only: 'app' });
	assert.deepEqual(Object.keys(state.objects).filter((r) => /^(app|page):/.test(r)), ['app:root']);
	const appId = state.objects['app:root'].id;
	assert.deepEqual(server.apps.get(String(appId)).views.map((v) => String(v.viewId)), [String(state.objects['app:root'].extra.defaultViewId)]);
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	assert.ok(calls.some((c) => c.name === 'deleteApp'));
	assert.equal(server.apps.size, 0);
	assert.ok(!summary.issues.some((i) => i.code === 'unpush.app-foreign-views'));
	assert.equal((await loadState(ws, 'acme')).objects['app:root'], undefined);
});

test('a dry run says the app and the last visible view are kept when the real run finds they must be', async () => {
	const { config } = await pushed();
	const full = await unpushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.match(full.actions.find((a) => a.kind === 'app').notes.join(' '), /checked only on a real run/);
	const subset = await unpushPlan({ config, slug: 'sales', dryRun: true, selection: { dashboards: ['Overview'] }, emitter: quiet });
	assert.match(subset.actions.find((a) => a.kind === 'page' && a.key === 'dash').notes.join(' '), /last visible view/);
});
