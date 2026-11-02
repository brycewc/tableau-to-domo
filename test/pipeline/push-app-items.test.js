import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan, withPushedCardUrns } from '../../src/pipeline/push.js';
import { planGraph, unpushPlan } from '../../src/pipeline/unpush.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { ref } from '../../src/util/refs.js';
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

async function setup(plan = appItemsPlan()) {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	await ws.writeJson(p.plan, plan);
	return { ws, p, config: testConfig(root) };
}

const WRITES = new Set(['createApp', 'updateApp', 'createView', 'renameView', 'reorderNavigation', 'setLanding', 'setViewVisible', 'putPersistSettings', 'clearStyleOverride', 'writeLayout', 'createCard', 'updateCard']);
const layoutOf = (calls, pageId) => calls.find((c) => c.name === 'writeLayout' && c.args.pageId === pageId).args.layout;

test('buttons and card actions are written with the view link fields, card urns and the section template', async () => {
	const { ws, config } = await setup();
	const { deps, calls } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const state = await loadState(ws, 'acme');
	const appId = state.objects['app:root'].id;
	const details = state.objects['page:details'].id;
	const [sheet1, sheet2] = ['sheet-1', 'sheet-2'].map((k) => state.objects[`card:${k}`].id);
	const overview = layoutOf(calls, state.objects['page:dash'].id);
	const byKey = new Map(overview.content.map((i) => [i.contentKey, i]));
	const link = { entityType: 'page', entityId: String(details), url: `/app-studio/${appId}/pages/${details}`, displayMode: 'APP_NAVIGATION', openInNewWindow: false };
	const pick = (config) => Object.fromEntries(Object.keys(link).map((k) => [k, config[k]]));
	assert.deepEqual(pick(byKey.get(3).interaction.config), link);
	assert.equal(byKey.get(2).interaction.config.url, link.url);
	assert.deepEqual(byKey.get(1).interaction.config.selectedCardUrns, [String(sheet2)]);
	const tabs = overview.standard.template.find((t) => t.type === 'TABS');
	assert.deepEqual(tabs.children.map((c) => c.type), ['TAB_BAR', 'TAB_CONTENT']);
	assert.deepEqual(tabs.children[1].children.map((c) => c.contentKey), [4]);
	assert.ok(!overview.content.some((i) => i.type === 'TAB_BAR'), 'the bar is a template entry only');
	const detailLayout = layoutOf(calls, details);
	assert.deepEqual([detailLayout.content[0].interaction.config.entityId, detailLayout.content[0].interaction.config.url], [String(sheet2), `/kpis/details/${sheet2}`]);
	assert.notEqual(sheet1, sheet2);
});

test('a linked hidden view keeps its view visible and hides only its navigation item', async () => {
	const { ws, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const app = server.apps.get(String(state.objects['app:root'].id));
	const details = state.objects['page:details'].id;
	assert.equal(app.views.find((v) => v.viewId === details).visible, true);
	assert.ok(!calls.some((c) => c.name === 'setViewVisible' && !c.args.visible));
	assert.equal(server.nav.get(String(app.dataAppId)).find((n) => n.entityId === String(details)).visible, false);
	assert.equal(state.objects['page:details'].extra.linked, true);
});

test('the workbook theme is cloned from the built-in on create; re-push changes nothing; --workbook-theme writes it again', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const created = calls.find((c) => c.name === 'createApp').args.theme;
	assert.equal(created.name, 'Clarion (Tableau)');
	assert.ok(created.fonts.every((f) => f.family === 'Serif'));
	assert.equal(created.colors.find((c) => c.id === created.app.backgroundColor.value).value.value, '#FFF5E6');

	calls.length = 0;
	const again = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(again.actions.filter((a) => a.action !== 'unchanged').map((a) => `${a.kind}:${a.key}:${a.action}`), []);
	assert.deepEqual(calls.filter((c) => WRITES.has(c.name)).map((c) => c.name), []);

	const plan = appItemsPlan();
	plan.app.theme.overrides.fontFamily = 'Slab';
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	assert.ok(!calls.some((c) => c.name === 'updateApp'), 'a theme change alone is not written to an existing app');
	plan.options = { workbookTheme: true };
	await ws.writeJson(p.plan, plan);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	const put = calls.find((c) => c.name === 'updateApp');
	assert.ok(put.args.body.theme.fonts.every((f) => f.family === 'Slab'));
	assert.ok(calls.some((c) => c.name === 'clearStyleOverride'));
	assert.ok((await loadState(ws, 'acme')).objects['app:root'].extra.themeHash);
});

test('a button or click action whose target view is not pushed is left out with push.link-target-missing; the card stays', async () => {
	const plan = appItemsPlan();
	plan.pages = plan.pages.filter((pg) => pg.key !== 'details');
	plan.cards.forEach((c) => (c.pageKeys = ['dash']));
	const { config } = await setup(plan);
	const { deps, calls } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const layout = calls.find((c) => c.name === 'writeLayout').args.layout;
	assert.deepEqual(layout.content.map((i) => [i.contentKey, i.type, Boolean(i.interaction)]), [[1, 'CARD', true], [2, 'CARD', false], [5, 'TABS', false], [7, 'TAB_CONTENT', false], [4, 'HEADER', false]]);
	assert.ok(!layout.standard.template.some((t) => t.contentKey === 3), 'the button is out of the template too');
	const issue = summary.issues.find((i) => i.code === 'push.link-target-missing');
	assert.match(issue.message, /left out 2 button\(s\) or click action\(s\).*page:details/);
});

test('a button to a view of a workbook not pushed yet opens it on Tableau; once that view is pushed the next push links the app view', async () => {
	const plan = appItemsPlan();
	const tableauUrl = 'https://t.example.com/#/site/s/views/Other/Main';
	const button = plan.pages[0].layout.content.find((i) => i.contentKey === 3);
	button.interaction = { type: 'WEBLINK', config: { url: ref('page', 'other--main', 'webUrl'), openInNewWindow: false, displayName: 'Open Main (Other app)' } };
	plan.pages[0].webLinks = [{ contentKey: 3, url: `${tableauUrl}?:iid=1`, workbook: 'Other', sheet: 'Main', status: 'move', tableauUrl, title: 'Main', target: 'page:other--main', slug: 'other', name: 'Other' }];
	const { ws, config } = await setup(plan);
	const { deps, calls } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const dash = state.objects['page:dash'].id;
	const kept = layoutOf(calls, dash).content.find((i) => i.contentKey === 3);
	assert.deepEqual(kept, { contentKey: 3, type: 'BUTTON', text: 'Open Main in Tableau (Other)', iconPosition: 'LEFT', interaction: { type: 'WEBLINK', config: { url: tableauUrl, openInNewWindow: true, displayName: 'Open Main in Tableau (Other)' } } });
	assert.match(summary.issues.find((i) => i.code === 'push.web-link-target-missing').message, /on Tableau until that workbook is pushed/);
	state.objects['page:other--main'] = { id: 77, extra: { appId: 5 } };
	await saveState(ws, state);
	calls.splice(0);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(layoutOf(calls, dash).content.find((i) => i.contentKey === 3).interaction.config.url, 'https://acme.domo.com/app-studio/5/pages/77');
});

test('a same-view filter whose selected card failed keeps its restriction: the urn is dropped and, with none left, filtering is off', async () => {
	assert.deepEqual(withPushedCardUrns({ contentKey: 1, type: 'CARD' }, () => ['x'], []), { contentKey: 1, type: 'CARD' });
	const { config } = await setup();
	const { deps, calls } = stubAppDomo();
	const create = deps.cards.createCard;
	deps.cards.createCard = async (c, body, opts) => {
		if (body.definition?.title === 'Bad ratio' || JSON.stringify(body).includes('Bad ratio')) throw new Error('card create refused');
		return create(c, body, opts);
	};
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const layout = calls.find((c) => c.name === 'writeLayout' && c.args.layout.content.some((i) => i.contentKey === 3)).args.layout;
	assert.deepEqual(layout.content.find((i) => i.contentKey === 1).interaction, { type: 'STANDARD', config: { allowCardToCardInteractions: false, openInNewWindow: false, selectIndividualCards: true, selectedCardUrns: [] } });
	const missing = summary.issues.filter((i) => i.code === 'push.link-target-missing').map((i) => i.object.name);
	assert.deepEqual(missing, ['Details'], 'only the card link on Details is a missing link target');
	assert.ok(summary.actions.find((a) => a.kind === 'layout' && a.key === 'dash').notes.some((n) => /filters no card, since none of its selected cards is pushed \(card:sheet-2/.test(n)));
});

test('views that keep links to a deleted or recreated view are named: subset unpush, and a subset push that recreates the target', async () => {
	const { ws, config } = await setup();
	const { deps, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	Object.assign(deps.cards, { deleteCard: async () => {}, listDatasetCards: async () => [] });
	const unpushed = await unpushPlan({ config, slug: 'sales', selection: { dashboards: ['Details'] }, deps, emitter: quiet, templateWait: { timeoutMs: 0 } });
	const stale = unpushed.issues.filter((i) => i.code === 'unpush.links-stale');
	assert.deepEqual(stale.map((i) => i.object.name), ['Overview']);
	assert.match(stale[0].message, /still has buttons or click actions that open the deleted view\(s\) "Details"/);
	assert.match(stale[0].suggestion, /--keys layout:dash/);

	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const app = server.apps.get(String(state.objects['app:root'].id));
	app.views = app.views.filter((v) => String(v.viewId) !== String(state.objects['page:details'].id));
	const subset = await pushPlan({ config, slug: 'sales', selection: { dashboards: ['Details'] }, deps, emitter: quiet });
	assert.ok(subset.actions.find((a) => a.kind === 'page' && a.key === 'details').notes.some((n) => /recreated/.test(n)));
	const pushStale = subset.issues.filter((i) => i.code === 'push.links-stale');
	assert.deepEqual(pushStale.map((i) => i.object.name), ['Overview']);
	assert.match(pushStale[0].message, /still open the old id of the recreated view\(s\) "Details"/);
	const whole = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(!whole.issues.some((i) => i.code === 'push.links-stale'), 'a push that writes the linking layout updates it');
});

test('unpush: links never block deleting their target view; the app goes with its views and themes are cleared', async () => {
	const graph = planGraph(appItemsPlan());
	assert.ok(![...(graph.dependents.get('page:details') ?? [])].includes('layout:dash'), 'a link is not a dependency');
	assert.ok([...(graph.dependents.get('card:sheet-2') ?? [])].includes('layout:dash'), 'placed cards still are');
	const { ws, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	deps.datasets.deleteDataset = async () => {};
	deps.datasets.listDownstream = async () => ({ dataflows: [], datasets: [] });
	deps.cards.listDatasetCards = async () => [];
	deps.beastmodes.deleteBeastModes = async () => {};
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet, templateWait: { timeoutMs: 0 } });
	assert.ok(summary.actions.some((a) => a.kind === 'app' && a.status === 'ok'), JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	assert.equal(server.apps.size, 0);
	assert.ok(calls.findIndex((c) => c.name === 'setSavedThemes') < calls.findIndex((c) => c.name === 'deleteApp'));
	assert.deepEqual(Object.keys((await loadState(ws, 'acme')).objects).filter((r) => /^(app|page|layout|navigation):/.test(r)), []);
});
