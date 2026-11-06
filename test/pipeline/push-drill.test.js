import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const view = (field, title = `Sales by ${field}`) => ({
	title,
	chartType: 'badge_vert_bar',
	field: `[${field}]`,
	hierarchy: 'Geo',
	body: {
		dataProvider: { dataSourceId: ref('dataset', 'orders') },
		variables: true,
		definition: { title, allowTableDrill: false, subscriptions: { main: { name: 'main', columns: [{ column: field, mapping: 'ITEM' }, { column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' }] } }, formulas: { card: [], dsUpdated: [], dsDeleted: [] } }
	}
});

function withDrill(levels) {
	const plan = samplePlan();
	plan.beastModes = plan.beastModes.filter((bm) => bm.key !== 'orders:bad');
	plan.cards = plan.cards.slice(0, 1);
	if (levels.length) plan.cards[0].drillPath = levels.map((l) => view(...[l].flat()));
	return plan;
}

/** Stub cards API that keeps each root card's drill views like Domo does: appended in order, deleted one by one. */
function drillDomo(paths = new Map()) {
	const stub = stubDomo({ invalid: [] });
	let next = 4000;
	Object.assign(stub.deps.cards, {
		createDrillView: async (_c, rootId, body) => {
			const id = ++next;
			paths.set(String(rootId), [...(paths.get(String(rootId)) ?? []), id]);
			stub.calls.push({ name: 'createDrillView', args: { rootId, body } });
			return { id, urn: `dr:${id}:${rootId}` };
		},
		updateDrillView: async (_c, rootId, drillId, body) => stub.calls.push({ name: 'updateDrillView', args: { rootId, drillId, body } }),
		listDrillViews: async (_c, rootId) => (paths.get(String(rootId)) ?? []).map((id) => ({ id, urn: `dr:${id}:${rootId}` })),
		deleteCard: async (_c, id) => {
			for (const [root, ids] of paths) paths.set(root, ids.filter((x) => x !== id));
			stub.calls.push({ name: 'deleteCard', args: { id } });
		}
	});
	return { ...stub, paths };
}

async function setup() {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.ir, { irVersion: 1, workbook: { name: 'Sales', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	return { ws, config: testConfig(root) };
}

const names = (calls) => calls.map((c) => c.name).filter((n) => /Drill|deleteCard/.test(n));
const drillEntries = async (ws) => (await loadState(ws, 'acme')).objects['card:sheet-1'].extra.drillViews;

test('push creates the drill views in order under the card, then leaves unchanged ones alone', async () => {
	const { ws, config } = await setup();
	const paths = new Map();
	const first = drillDomo(paths);
	const result = await pushPlan({ config, slug: 'sales', deps: first.deps, plan: withDrill(['State', 'City']), emitter: quiet });
	const rootId = (await loadState(ws, 'acme')).objects['card:sheet-1'].id;
	const created = first.calls.filter((c) => c.name === 'createDrillView');
	assert.deepEqual(created.map((c) => [c.args.rootId, c.args.body.definition.subscriptions.main.columns[0].column]), [[rootId, 'State'], [rootId, 'City']]);
	assert.equal(created[0].args.body.dataProvider.dataSourceId, 'ds-orders');
	assert.deepEqual((await drillEntries(ws)).map((e) => [e.id, e.field]), [[4001, '[State]'], [4002, '[City]']]);
	assert.match(result.actions.find((a) => a.key === 'sheet-1').notes.join(' '), /created 2 drill view\(s\): Sales by State, Sales by City/);

	const again = drillDomo(paths);
	const second = await pushPlan({ config, slug: 'sales', deps: again.deps, plan: withDrill(['State', 'City']), emitter: quiet });
	assert.deepEqual(names(again.calls), []);
	assert.equal(second.actions.find((a) => a.key === 'sheet-1').action, 'unchanged');
});

test('a changed drill view is updated in place; new levels replace the old views without duplicates', async () => {
	const { ws, config } = await setup();
	const paths = new Map();
	await pushPlan({ config, slug: 'sales', deps: drillDomo(paths).deps, plan: withDrill(['State', 'City']), emitter: quiet });

	const renamed = drillDomo(paths);
	const result = await pushPlan({ config, slug: 'sales', deps: renamed.deps, plan: withDrill(['State', ['City', 'Sales per city']]), emitter: quiet });
	assert.deepEqual(renamed.calls.filter((c) => c.name === 'updateDrillView').map((c) => c.args.drillId), [4002]);
	assert.deepEqual(names(renamed.calls), ['updateDrillView']);
	assert.equal(result.actions.find((a) => a.key === 'sheet-1').action, 'update');

	const relevel = drillDomo(paths);
	await pushPlan({ config, slug: 'sales', deps: relevel.deps, plan: withDrill(['County']), emitter: quiet });
	assert.deepEqual(names(relevel.calls), ['deleteCard', 'deleteCard', 'createDrillView']);
	const root = String((await loadState(ws, 'acme')).objects['card:sheet-1'].id);
	assert.equal(paths.get(root).length, 1);
	assert.deepEqual((await drillEntries(ws)).map((e) => e.field), ['[County]']);

	const none = drillDomo(paths);
	await pushPlan({ config, slug: 'sales', deps: none.deps, plan: withDrill([]), emitter: quiet });
	assert.deepEqual(names(none.calls), ['deleteCard']);
	assert.equal(await drillEntries(ws), undefined);
	assert.deepEqual(paths.get(root), []);
});

test('a drill view deleted in Domo is created again; a view someone else added stays', async () => {
	const { ws, config } = await setup();
	const paths = new Map();
	await pushPlan({ config, slug: 'sales', deps: drillDomo(paths).deps, plan: withDrill(['State']), emitter: quiet });
	const root = String((await loadState(ws, 'acme')).objects['card:sheet-1'].id);
	paths.set(root, [9999]);

	const again = drillDomo(paths);
	await pushPlan({ config, slug: 'sales', deps: again.deps, plan: withDrill(['State']), emitter: quiet });
	assert.deepEqual(names(again.calls), ['createDrillView']);
	assert.deepEqual(paths.get(root), [9999, 4001]);
});

test('a drill view create answered with HTTP 500 that Domo saved anyway is recovered, not created twice; an older view is never taken', async () => {
	const { ws, config } = await setup();
	const paths = new Map();
	await pushPlan({ config, slug: 'sales', deps: drillDomo(paths).deps, plan: withDrill([]), emitter: quiet });
	const root = String((await loadState(ws, 'acme')).objects['card:sheet-1'].id);
	paths.set(root, [9999]);
	const serverError = () => Object.assign(new Error('HTTP 500: Unable to create card'), { status: 500 });
	const stub = drillDomo(paths);
	const create = stub.deps.cards.createDrillView;
	stub.deps.cards.mayHaveCreated = (err) => err.status >= 500;
	stub.deps.cards.createDrillView = async (...args) => {
		await create(...args);
		throw serverError();
	};
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan: withDrill(['State']), emitter: quiet });
	assert.deepEqual(names(stub.calls), ['createDrillView', 'updateDrillView']);
	assert.equal(stub.calls.find((c) => c.name === 'updateDrillView').args.drillId, 4001);
	assert.deepEqual((await drillEntries(ws)).map((e) => e.id), [4001]);
	assert.match(result.actions.find((a) => a.key === 'sheet-1').notes.join(' '), /recovered it/);

	const lost = drillDomo(paths);
	lost.deps.cards.mayHaveCreated = () => true;
	lost.deps.cards.createDrillView = async () => {
		throw serverError();
	};
	const failed = await pushPlan({ config, slug: 'sales', deps: lost.deps, plan: withDrill(['City']), emitter: quiet });
	assert.ok(!lost.calls.some((c) => c.name === 'updateDrillView'), 'the view someone else added is left alone');
	assert.ok(failed.issues.some((i) => i.code === 'push.card-drill-path' && /HTTP 500/.test(i.message)));
});

test('dry run describes the drill views without writing them', async () => {
	const { config } = await setup();
	const stub = drillDomo();
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan: withDrill(['State']), dryRun: true, emitter: quiet });
	assert.deepEqual(names(stub.calls), []);
	assert.match(result.actions.find((a) => a.key === 'sheet-1').notes.join(' '), /would create 1 drill view\(s\): Sales by State/);
});

test('a failed drill view keeps the card and reports push.card-drill-path', async () => {
	const { config } = await setup();
	const stub = drillDomo();
	stub.deps.cards.createDrillView = async () => {
		throw new Error('HTTP 400: invalidSubscription');
	};
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan: withDrill(['State']), emitter: quiet });
	const card = result.actions.find((a) => a.key === 'sheet-1');
	assert.equal(card.status, 'ok');
	assert.ok(result.issues.some((i) => i.code === 'push.card-drill-path' && /invalidSubscription/.test(i.message)));
});
