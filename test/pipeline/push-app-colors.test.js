import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { appItemsPlan, stubAppDomo } from './app-helpers.js';
import { tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
const roots = [];
let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
	roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});

const PALETTE = { name: 'Tableau 10', colors: ['#4e79a7', '#f28e2b', '#e15759'] };
const STYLE = { key: 's1', kind: 'card', background: '#FAF4E7', borderColor: '#000000', borderWidth: 2, padding: null, items: 1 };

function colorPlan() {
	const plan = appItemsPlan();
	plan.app.theme = { base: 'Clarion', palette: PALETTE, itemStyles: [STYLE] };
	const dash = plan.pages.find((pg) => pg.key === 'dash');
	dash.layout.content.find((i) => i.contentKey === 1).itemStyle = 's1';
	return plan;
}

async function setup(plan) {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	await ws.writeJson(p.plan, plan);
	return { ws, p, config: testConfig(root) };
}

const layoutOf = (calls, pageId) => calls.findLast((c) => c.name === 'writeLayout' && c.args.pageId === pageId).args.layout;

test('a new app gets its chart palette and item styles in the theme, and the cards point at the item style', async () => {
	const { ws, p, config } = await setup(colorPlan());
	const { deps, calls, server } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const state = await loadState(ws, 'acme');
	const app = state.objects['app:root'];
	const created = calls.find((c) => c.name === 'createAppPalette');
	assert.equal(created.args.appId, app.id);
	assert.equal(created.args.palette.name, 'Tableau Tableau 10');
	const json = JSON.parse(created.args.palette.json);
	assert.deepEqual(json.colorRanges.map((r) => r.values[4]), ['4e79a7', 'f28e2b', 'e15759']);
	assert.equal(json.colorRules[0].values.length, 36);
	assert.deepEqual(json.colorRules[0].values.slice(0, 4), [[0, 4], [1, 4], [2, 4], [0, 4]]);
	const theme = server.apps.get(String(app.id)).theme;
	assert.deepEqual(theme.chartColorPalette, { id: app.extra.paletteId, type: 'APP' });
	assert.deepEqual(app.extra.itemStyleIds, { s1: 'ca4' });
	const ca4 = theme.cards.find((s) => s.id === 'ca4');
	const color = (ref) => theme.colors.find((c) => c.id === ref.value).value.value;
	assert.deepEqual([color(ca4.backgroundColor), color(ca4.borderColor), ca4.borderWidth], ['#FAF4E7', '#000000', 2]);
	assert.equal(ca4.titleFont.value, theme.cards.find((s) => s.id === theme.mappings.chart).titleFont.value, 'copied from the chart style');
	const layout = layoutOf(calls, state.objects['page:dash'].id);
	assert.deepEqual(layout.content.find((i) => i.contentKey === 1).style, { sourceId: 'ca4' });
	assert.ok(!layout.content.some((i) => 'itemStyle' in i));
	assert.ok(!layout.content.find((i) => i.contentKey === 2).style);

	calls.length = 0;
	const again = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(again.actions.filter((a) => a.action !== 'unchanged').map((a) => `${a.kind}:${a.key}`), []);
	assert.ok(!calls.some((c) => /Palette|updateApp|writeLayout/.test(c.name)));

	const plan = colorPlan();
	plan.app.theme.palette = { ...PALETTE, colors: ['#111111', '#222222'] };
	plan.options = { workbookTheme: true };
	await ws.writeJson(p.plan, plan);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	assert.ok(calls.some((c) => c.name === 'updateAppPalette' && c.args.paletteId === app.extra.paletteId));
	assert.ok(!calls.some((c) => c.name === 'createAppPalette'), 'updated in place');

	delete plan.app.theme.palette;
	await ws.writeJson(p.plan, plan);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	assert.ok(calls.some((c) => c.name === 'deleteAppPalette' && c.args.paletteId === app.extra.paletteId));
	assert.equal((await loadState(ws, 'acme')).objects['app:root'].extra.paletteId, null);
});

test('an app whose theme t2d wrote without item styles keeps the default style on its cards', async () => {
	const { ws, config } = await setup(colorPlan());
	const { deps, calls } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	delete state.objects['app:root'].extra.itemStyleIds;
	await saveState(ws, state);
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'layouts', force: true });
	const layout = layoutOf(calls, state.objects['page:dash'].id);
	assert.ok(!layout.content.find((i) => i.contentKey === 1).style);
	assert.match(summary.issues.find((i) => i.code === 'push.item-styles-skipped').message, /^1 card\(s\) keep the default card style/);
});

test('a palette the theme comes back without warns push.app-palette-dropped; a failing palette create warns and the app is still made', async () => {
	const dropped = stubAppDomo();
	const updateApp = dropped.deps.apps.updateApp;
	dropped.deps.apps.updateApp = async (c, id, body) => updateApp(c, id, { ...body, theme: { ...body.theme, chartColorPalette: null } });
	const one = await setup(colorPlan());
	const summary = await pushPlan({ config: one.config, slug: 'sales', deps: dropped.deps, emitter: quiet });
	assert.ok(summary.issues.some((i) => i.code === 'push.app-palette-dropped'));

	const failing = stubAppDomo();
	failing.deps.apps.createAppPalette = async () => {
		throw Object.assign(new Error('HTTP 403'), { status: 403 });
	};
	const two = await setup(colorPlan());
	const result = await pushPlan({ config: two.config, slug: 'sales', deps: failing.deps, emitter: quiet });
	assert.ok(result.issues.some((i) => i.code === 'push.app-palette-failed'));
	assert.equal(result.actions.find((a) => a.kind === 'app').status, 'ok');
	const app = (await loadState(two.ws, 'acme')).objects['app:root'];
	assert.equal(app.extra.paletteId, null);
	assert.ok(!failing.server.apps.get(String(app.id)).theme.chartColorPalette);
});

test('a filled title row (sectionFill) points at a section style of that color, added to a new app\'s theme or to an existing one, once', async () => {
	const filled = () => {
		const plan = appItemsPlan();
		plan.pages.find((pg) => pg.key === 'dash').layout.content.find((i) => i.contentKey === 5).sectionFill = '#19429C';
		return plan;
	};
	const { ws, config } = await setup(filled());
	const { deps, calls, server } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const state = await loadState(ws, 'acme');
	const appId = String(state.objects['app:root'].id);
	const sectionOf = (theme, id) => theme.sections.find((s) => s.id === id);
	const fillOf = (theme, style) => theme.colors.find((c) => c.id === style.background.value).value.value;
	let theme = server.apps.get(appId).theme;
	const tabs = layoutOf(calls, state.objects['page:dash'].id).content.find((i) => i.contentKey === 5);
	assert.ok(!('sectionFill' in tabs));
	assert.equal(fillOf(theme, sectionOf(theme, tabs.style.sourceId)), '#19429C');

	calls.length = 0;
	const again = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(again.actions.filter((a) => a.action !== 'unchanged').map((a) => `${a.kind}:${a.key}`), []);

	theme = server.apps.get(appId).theme;
	const id = tabs.style.sourceId;
	server.apps.get(appId).theme = { ...theme, sections: theme.sections.filter((s) => s.id !== id) };
	calls.length = 0;
	const restored = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, force: true });
	assert.equal(restored.ok, true);
	assert.ok(calls.some((c) => c.name === 'updateApp'));
	theme = server.apps.get(appId).theme;
	const again2 = layoutOf(calls, state.objects['page:dash'].id).content.find((i) => i.contentKey === 5);
	assert.equal(fillOf(theme, sectionOf(theme, again2.style.sourceId)), '#19429C');
	assert.equal(theme.sections.filter((s) => s.background?.value === sectionOf(theme, again2.style.sourceId).background.value).length, 1);
});
