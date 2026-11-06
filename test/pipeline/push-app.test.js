import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { appPlan, stubAppDomo } from './app-helpers.js';
import { samplePlan, tempDir, testConfig } from './helpers.js';

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

async function setup(plan = appPlan()) {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	await ws.writeJson(p.plan, plan);
	return { ws, p, config: testConfig(root) };
}

const names = (calls) => calls.map((c) => c.name);
const APP_WRITES = new Set(['createApp', 'updateApp', 'createView', 'renameView', 'reorderNavigation', 'setLanding', 'setViewVisible', 'putPersistSettings', 'clearStyleOverride', 'createPage', 'updatePage', 'writeLayout', 'createCard', 'updateCard']);

test('push creates the app, reuses its default view, then cards, layouts, navigation and settings in that order', async () => {
	const { ws, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const order = names(calls);
	const first = (n) => order.indexOf(n);
	assert.equal(first('appStudioStatus'), 0, 'feature flags are checked before any write');
	assert.ok(first('createDataset') > first('appStudioStatus'));
	const sequence = ['createApp', 'renameView', 'createView', 'createCard', 'writeLayout', 'reorderNavigation', 'setLanding', 'setViewVisible', 'putPersistSettings'];
	assert.ok(sequence.every((n) => first(n) >= 0), order.join(','));
	assert.deepEqual([...sequence].sort((a, b) => first(a) - first(b)), sequence);
	assert.ok(!order.includes('createPage') && !order.includes('updatePage'), 'no classic page calls');
	assert.ok(!order.includes('updateApp'), 'create carries the settings, so no app PUT follows it');

	const created = calls.find((c) => c.name === 'createApp');
	const { theme, ...settings } = created.args;
	assert.deepEqual(settings, { title: 'Sales', description: 'Migrated from the Tableau workbook "Sales"', navigation: { orientation: 'TOP', showDomoNavigation: false, showNavigation: true } });
	const control = theme.cards.find((s) => s.id === theme.mappings.control);
	assert.deepEqual([theme.name, control.borderRadius, control.padding, control.elementSpacing.isCustom, control.elementSpacing.header.bottomMargin], ['Clarion', 0, { left: 0, right: 0, top: 0, bottom: 0 }, true, 0], 'Clarion with square, unpadded controls');
	assert.equal(theme.sections.find((s) => s.id === theme.mappings.section).density.standard, 0);
	const state = await loadState(ws, 'acme');
	const app = state.objects['app:root'];
	assert.equal(app.extra.controlSpacing, 4);
	const landingView = calls.find((c) => c.name === 'renameView');
	assert.equal(landingView.args.viewId, app.extra.defaultViewId, 'the first view takes over the default view');
	assert.equal(landingView.args.title, 'Overview');
	assert.equal(state.objects['page:dash'].id, app.extra.defaultViewId);
	assert.deepEqual(
		{ ...state.objects['page:details'].extra, updatedAt: undefined, workbooks: undefined },
		{ appId: app.id, title: 'Details', container: 'app', navOrder: 2, hidden: true, layoutId: state.objects['page:details'].id + 5000, updatedAt: undefined, workbooks: undefined }
	);
	assert.equal(calls.filter((c) => c.name === 'createView').length, 1);
	const card = calls.find((c) => c.name === 'createCard');
	assert.equal(card.args.opts.pageId, state.objects['page:dash'].id, 'cards are created on the view');
	assert.deepEqual(calls.filter((c) => c.name === 'writeLayout').map((c) => c.args.pageId), [state.objects['page:dash'].id, state.objects['page:details'].id]);

	const nav = server.nav.get(String(app.id));
	assert.deepEqual(nav.map((n) => `${n.entity}:${n.title}:${n.visible}`), ['HOME:Home:true', 'VIEW:Overview:true', 'VIEW:Details:false', 'AI_ASSISTANT:AI_ASSISTANT:true', 'CONTROLS:CONTROLS:true', 'DISTRIBUTE:DISTRIBUTE:true', 'MORE:MORE:true']);
	assert.deepEqual(nav.map((n) => n.navOrder), [1, 2, 3, 4, 5, 6, 7]);
	assert.equal(server.apps.get(String(app.id)).landingViewId, state.objects['page:dash'].id);
	assert.deepEqual(calls.filter((c) => c.name === 'setViewVisible').map((c) => c.args), [{ appId: app.id, viewId: state.objects['page:details'].id, visible: false }]);
	assert.deepEqual(server.persist.get(String(app.id)), appPlan().app.persistSettings);
	assert.ok(state.objects['navigation:root']?.hash);

	assert.equal(summary.app.id, app.id);
	assert.equal(summary.app.url, `https://acme.domo.com/app-studio/${app.id}`);
	assert.deepEqual(summary.app.views.map((v) => [v.key, v.url]), [
		['dash', `https://acme.domo.com/app-studio/${app.id}/pages/${state.objects['page:dash'].id}`],
		['details', `https://acme.domo.com/app-studio/${app.id}/pages/${state.objects['page:details'].id}`]
	]);
});

test('read-merge-write: the app PUT keeps the server fields (landing, owners, theme) and changes only the settings', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const [created] = server.apps.values();
	created.theme.cards.find((s) => s.id === created.theme.mappings.control).borderRadius = 6;
	const edited = structuredClone(created.theme);
	const plan = appPlan();
	plan.app.navigation = { orientation: 'LEFT', showDomoNavigation: false, showNavigation: true };
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const get = calls.findIndex((c) => c.name === 'getApp');
	const put = calls.findIndex((c) => c.name === 'updateApp');
	assert.ok(get >= 0 && get < put, 'GET before PUT');
	const body = calls[put].args.body;
	assert.equal(body.landingViewId, (await loadState(ws, 'acme')).objects['app:root'].extra.defaultViewId);
	assert.deepEqual(body.owners, [{ id: 1, type: 'USER' }]);
	assert.equal(body.navOrientation, 'LEFT');
	assert.equal(body.showDomoNavigation, false);
	assert.equal(body.title, 'Sales');
	assert.deepEqual(body.theme, edited, 'the app theme is kept as edited, without a theme lookup or the control spacing again');
	assert.ok(!calls.some((c) => c.name === 'listThemes'));
});

test('an app t2d created before the control spacing gets it once on its theme; an app that has it is not written', async () => {
	const { ws, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const [app] = server.apps.values();
	app.theme = structuredClone(JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8')));
	const state = await loadState(ws, 'acme');
	delete state.objects['app:root'].extra.controlSpacing;
	await saveState(ws, state);
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const put = calls.find((c) => c.name === 'updateApp');
	const control = put.args.body.theme.cards.find((s) => s.id === 'ca1');
	assert.deepEqual([control.borderRadius, control.padding.top, put.args.body.theme.sections[0].density], [0, 0, { compact: 6, standard: 0 }]);
	assert.ok(summary.actions.find((a) => a.kind === 'app').notes.includes('control and section spacing set on the app theme'));
	assert.ok(!calls.some((c) => c.name === 'clearStyleOverride'), 'view style overrides stay');
	assert.equal((await loadState(ws, 'acme')).objects['app:root'].extra.controlSpacing, 4);
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(!calls.some((c) => c.name === 'updateApp'), 'once is enough');
});

test('an app whose plan gains image cards gets the image style squared once', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const [app] = server.apps.values();
	app.theme = structuredClone(JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8')));
	const plan = await ws.readJson(p.plan);
	plan.cards.push({ key: 'dash.image.7', kind: 'image', title: 'b.png', worksheet: '', datasetKey: '', chartType: 'document', body: { image: { file: 'images/b.png', name: 'b.png', bytes: 1, md5: 'ab' } }, pageKeys: [], status: 'ok' });
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	const style = calls.find((c) => c.name === 'updateApp').args.body.theme.cards.find((s) => s.id === app.theme.mappings.document);
	assert.deepEqual([style.borderRadius, style.padding.top, style.elementSpacing.header.bottomMargin], [0, 0, 0]);
	assert.equal((await loadState(ws, 'acme')).objects['app:root'].extra.controlSpacing, '4+images');
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	assert.ok(!calls.some((c) => c.name === 'updateApp'), 'once is enough');
});

test('create sends the theme and LEFT navigation in the create body; no app PUT follows', async () => {
	const plan = appPlan();
	plan.app.theme = { base: 'Midnight' };
	plan.app.navigation = { orientation: 'LEFT', showDomoNavigation: false, showNavigation: true };
	const { config } = await setup(plan);
	const { deps, calls, server } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true);
	const order = names(calls);
	assert.ok(order.indexOf('listThemes') >= 0 && order.indexOf('listThemes') < order.indexOf('createApp'), 'theme looked up before create');
	const created = calls.find((c) => c.name === 'createApp');
	assert.equal(created.args.theme.name, 'Midnight');
	assert.equal(created.args.navigation.orientation, 'LEFT');
	assert.ok(!order.includes('updateApp'));
	const [app] = server.apps.values();
	assert.deepEqual([app.theme.name, app.navOrientation, app.showDomoNavigation], ['Midnight', 'LEFT', false]);
});

test('an instance whose create ignores the settings gets them through GET, merge and PUT', async () => {
	const plan = appPlan();
	plan.app.navigation = { orientation: 'LEFT', showDomoNavigation: false, showNavigation: true };
	const { config } = await setup(plan);
	const { deps, calls, server } = stubAppDomo();
	const create = deps.apps.createApp;
	deps.apps.createApp = (c, spec) => create(c, { title: spec.title, description: spec.description });
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true);
	const put = calls.find((c) => c.name === 'updateApp');
	assert.equal(put?.args.body.navOrientation, 'LEFT');
	assert.equal(server.apps.values().next().value.navOrientation, 'LEFT');
});

test('re-push of an unchanged plan writes nothing; a renamed dashboard renames its view and nav entry', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	calls.length = 0;
	const again = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(again.ok, true);
	assert.deepEqual(names(calls).filter((n) => APP_WRITES.has(n)), [], 'no writes on an unchanged re-push');
	assert.ok(again.actions.filter((a) => ['app', 'page', 'layout', 'navigation'].includes(a.kind)).every((a) => a.action === 'unchanged'));

	const renamed = appPlan();
	renamed.pages[1].title = 'Detail view';
	await ws.writeJson(p.plan, renamed);
	calls.length = 0;
	const third = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	assert.deepEqual(names(calls).filter((n) => APP_WRITES.has(n)), ['renameView', 'reorderNavigation', 'setLanding', 'putPersistSettings']);
	assert.deepEqual(calls.find((c) => c.name === 'renameView').args.viewId, state.objects['page:details'].id);
	assert.equal(third.actions.find((a) => a.kind === 'page' && a.key === 'details').action, 'update');
	const nav = server.nav.get(String(state.objects['app:root'].id));
	assert.ok(nav.some((n) => n.entity === 'VIEW' && n.title === 'Detail view'));
	assert.equal(state.objects['page:details'].extra.title, 'Detail view');
});

test('a pushed card that convert would place but cannot convert now is kept on Domo and in state', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const cardId = (await loadState(ws, 'acme')).objects['card:sheet-2'].id;

	const plan = appPlan();
	plan.cards.find((c) => c.key === 'sheet-2').status = 'unsupported';
	await ws.writeJson(p.plan, plan);
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const row = summary.actions.find((a) => a.kind === 'card' && a.key === 'sheet-2');
	assert.deepEqual([row.action, row.id], ['skip', cardId]);
	assert.match(row.notes.join(' '), /kept the card/);
	assert.ok(!calls.some((c) => c.name === 'deleteCard'));
	assert.equal((await loadState(ws, 'acme')).objects['card:sheet-2'].id, cardId);
});

test('a pushed card whose sheet is now a header is deleted and forgotten, so its view does not keep it', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const cardId = (await loadState(ws, 'acme')).objects['card:sheet-2'].id;

	const plan = appPlan();
	Object.assign(plan.cards.find((c) => c.key === 'sheet-2'), { status: 'unsupported', replacedBy: 'header' });
	const layout = plan.pages[0].layout;
	layout.content = layout.content.filter((i) => i.contentKey !== 2);
	for (const mode of [layout.standard, layout.compact]) mode.template = mode.template.filter((i) => i.contentKey !== 2);
	await ws.writeJson(p.plan, plan);
	const dry = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, dryRun: true });
	assert.deepEqual(dry.actions.filter((a) => a.action === 'delete').map((a) => [a.key, a.id, a.status]), [['sheet-2', cardId, 'dry-run']]);
	assert.ok(!calls.some((c) => c.name === 'deleteCard'));

	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	assert.deepEqual(calls.filter((c) => c.name === 'deleteCard').map((c) => c.args.id), [cardId]);
	assert.equal((await loadState(ws, 'acme')).objects['card:sheet-2'], undefined);
	const again = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(again.actions.find((a) => a.kind === 'card' && a.key === 'sheet-2').action, 'skip');
});

test('a pushed card whose key left the plan is deleted before the layouts and forgotten', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const cardId = (await loadState(ws, 'acme')).objects['card:sheet-2'].id;

	const plan = appPlan();
	plan.cards = plan.cards.filter((c) => c.key !== 'sheet-2');
	const layout = plan.pages[0].layout;
	layout.content = layout.content.filter((i) => i.contentKey !== 2);
	for (const mode of [layout.standard, layout.compact]) mode.template = mode.template.filter((i) => i.contentKey !== 2);
	await ws.writeJson(p.plan, plan);
	const dry = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, dryRun: true });
	assert.deepEqual(dry.actions.filter((a) => a.action === 'delete').map((a) => [a.key, a.id]), [['sheet-2', cardId]]);
	assert.ok(!calls.some((c) => c.name === 'deleteCard'));

	deps.cards.listCardPlacements = async () => [];
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(calls.filter((c) => c.name === 'deleteCard').map((c) => c.args.id), [cardId]);
	assert.ok(calls.findIndex((c) => c.name === 'deleteCard') < calls.findIndex((c) => c.name === 'writeLayout'), 'deleted before the layouts are written');
	assert.deepEqual(summary.actions.filter((a) => a.action === 'delete').map((a) => [a.kind, a.key, a.status]), [['card', 'sheet-2', 'ok']]);
	assert.equal((await loadState(ws, 'acme')).objects['card:sheet-2'], undefined);
});

test('a card merged into a stacked table is retired, naming the merged table', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const cardId = (await loadState(ws, 'acme')).objects['card:sheet-2'].id;
	const plan = appPlan();
	const merged = plan.cards.find((c) => c.key !== 'sheet-2' && c.worksheet);
	Object.assign(plan.cards.find((c) => c.key === 'sheet-2'), { status: 'unsupported', replacedBy: 'stack', stackedInto: merged.key });
	await ws.writeJson(p.plan, plan);
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(calls.filter((c) => c.name === 'deleteCard').map((c) => c.args.id), [cardId]);
	assert.match(summary.actions.find((a) => a.kind === 'card' && a.key === 'sheet-2').notes.join(' '), new RegExp(`the sheet is part of the merged table ${merged.title}; the card an earlier push created is deleted`));
});

test('a status sheet card replaced by description smart text is deleted like a header one; layouts take the theme\'s isDynamic and close the gap a left-out card leaves', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const cardId = state.objects['card:sheet-2'].id;
	server.apps.get(String(state.objects['app:root'].id)).theme = { name: 'Clarion', pages: [{ isDynamic: true }] };

	const plan = appPlan();
	Object.assign(plan.cards.find((c) => c.key === 'sheet-2'), { status: 'unsupported', replacedBy: 'notebook' });
	plan.app.title = 'Sales v2';
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(calls.filter((c) => c.name === 'deleteCard').map((c) => c.args.id), [cardId]);
	assert.match(summary.actions.find((a) => a.kind === 'card' && a.key === 'sheet-2').notes.join(' '), /the sheet is now a text card/);
	const written = calls.filter((c) => c.name === 'writeLayout').find((c) => String(c.args.pageId) === String(state.objects['page:dash'].id)).args.layout;
	assert.equal(written.isDynamic, true);
	assert.deepEqual(written.standard.template.map((t) => [t.contentKey, t.x, t.width]), [[1, 0, 60]], 'the remaining card takes the space');
	assert.deepEqual(written.compact.template.map((t) => [t.contentKey, t.y]), [[1, 0]]);
});

test('a replaced card that a view t2d did not create shows is kept, with a warning', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const cardId = state.objects['card:sheet-2'].id;
	deps.cards.listCardPlacements = async (_c, id) => (String(id) === String(cardId) ? [{ kind: 'view', id: String(state.objects['page:dash'].id) }, { kind: 'view', id: '900000001', title: 'Page 3' }] : []);

	const plan = appPlan();
	Object.assign(plan.cards.find((c) => c.key === 'sheet-2'), { status: 'unsupported', replacedBy: 'notebook' });
	await ws.writeJson(p.plan, plan);
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(!calls.some((c) => c.name === 'deleteCard'));
	const row = summary.actions.find((a) => a.kind === 'card' && a.key === 'sheet-2');
	assert.deepEqual([row.action, row.status], ['skip', 'skipped']);
	assert.match(row.error, /view 900000001 "Page 3"/);
	assert.doesNotMatch(row.error, new RegExp(`view ${state.objects['page:dash'].id}\\b`));
	assert.ok(summary.issues.some((i) => i.code === 'push.card-foreign-placement'));
	assert.equal((await loadState(ws, 'acme')).objects['card:sheet-2'].id, cardId);
});

test('a subset push keeps the other views and orders the navigation from state', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const pruned = appPlan();
	pruned.pages = pruned.pages.filter((pg) => pg.key === 'details').map((pg) => ({ ...pg, title: 'Details 2' }));
	pruned.selection = { dashboards: ['Details'], worksheets: [], datasources: [] };
	await ws.writeJson(p.plan, pruned);
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true);
	assert.ok(!names(calls).includes('deleteView'));
	const state = await loadState(ws, 'acme');
	assert.ok(state.objects['page:dash'], 'the view outside the selection stays');
	const nav = server.nav.get(String(state.objects['app:root'].id)).filter((n) => n.entity === 'VIEW');
	assert.deepEqual(nav.map((n) => n.title), ['Overview', 'Details 2']);
});

test('the app is recreated when it was deleted outside t2d', async () => {
	const { ws, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const before = await loadState(ws, 'acme');
	server.apps.delete(String(before.objects['app:root'].id));
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const after = await loadState(ws, 'acme');
	assert.notEqual(after.objects['app:root'].id, before.objects['app:root'].id);
	assert.equal(after.objects['page:dash'].id, after.objects['app:root'].extra.defaultViewId);
	assert.equal(calls.filter((c) => c.name === 'writeLayout').length, 2, 'layouts are written to the new views');
	assert.match(summary.actions.find((a) => a.kind === 'app').notes.join(' '), /deleted outside t2d/);
});

test('a layout locked by another user fails with push.layout-locked; the rest of the push goes on', async () => {
	const { config } = await setup();
	// The stub numbers ids from 601: app 601, its default view 602, the next view 603 (Details).
	const { deps } = stubAppDomo({ lockedLayouts: [603] });
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const layout = summary.actions.find((a) => a.kind === 'layout' && a.status === 'failed');
	assert.equal(layout?.key, 'details');
	assert.ok(summary.issues.some((i) => i.code === 'push.layout-locked' && /retry/i.test(i.suggestion)));
	assert.ok(summary.actions.some((a) => a.kind === 'navigation' && a.status === 'ok'));
	assert.equal(summary.ok, false);
});

test('preflight: data-app off fails with push.app-unavailable before any write', async () => {
	const { ws, config } = await setup();
	const { deps, calls } = stubAppDomo({ flags: { 'data-app': 'off' } });
	await assert.rejects(pushPlan({ config, slug: 'sales', deps, emitter: quiet }), (err) => err.code === 'push.app-unavailable' && /--target pages/.test(err.message));
	assert.deepEqual(names(calls), ['appStudioStatus']);
	assert.deepEqual((await loadState(ws, 'acme')).objects, {});
});

test('preflight: app-studio-persist off is a warning; a dry run checks nothing and writes nothing', async () => {
	const { config } = await setup();
	const dry = await pushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.deepEqual(
		dry.actions.filter((a) => ['app', 'page', 'navigation'].includes(a.kind)).map((a) => `${a.kind}:${a.key}:${a.action}`),
		['app:root:create', 'page:dash:create', 'page:details:create', 'navigation:root:create']
	);
	assert.match(dry.actions.find((a) => a.key === 'dash').notes.join(' '), /default view/);
	const { deps } = stubAppDomo({ flags: { 'data-app': 'on', 'app-studio-persist': 'off' } });
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(summary.issues.some((i) => i.code === 'push.app-persist-off'));
});

test('--parent-page is rejected for an app plan, and a classic push of the same dashboards blocks the app push', async () => {
	const { ws, config } = await setup();
	const { deps, calls } = stubAppDomo();
	await assert.rejects(pushPlan({ config, slug: 'sales', deps, parentPageId: '12', emitter: quiet }), (err) => err.code === 'push.parent-page-app');
	const state = await loadState(ws, 'acme');
	state.objects['page:dash'] = { id: 77, updatedAt: '2026-01-01', extra: { title: 'Overview' } };
	await saveState(ws, state);
	await assert.rejects(pushPlan({ config, slug: 'sales', deps, emitter: quiet }), (err) => err.code === 'push.target-changed' && /dash \(77\)/.test(err.message));
	assert.deepEqual(calls, []);
});

test('--theme writes the theme on an existing app and clears style overrides; no --theme leaves UI edits alone', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const appId = (await loadState(ws, 'acme')).objects['app:root'].id;
	server.apps.get(String(appId)).theme = { name: 'Edited in the UI' };
	const plan = appPlan();
	plan.app.title = 'Sales v2';
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(server.apps.get(String(appId)).theme.name, 'Edited in the UI', 'a settings change keeps the current theme');
	assert.equal(server.apps.get(String(appId)).title, 'Sales v2');
	assert.ok(!names(calls).includes('clearStyleOverride'));

	plan.app.theme = { base: 'Midnight' };
	plan.options = { theme: 'Midnight' };
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(server.apps.get(String(appId)).theme.name, 'Midnight');
	assert.ok(names(calls).indexOf('clearStyleOverride') > names(calls).indexOf('updateApp'));
});

test('a hidden view that becomes the landing view is shown before it is set as landing', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const plan = appPlan();
	plan.pages[0].hidden = true;
	delete plan.pages[1].hidden;
	plan.app.landingKey = 'details';
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const state = await loadState(ws, 'acme');
	const app = server.apps.get(String(state.objects['app:root'].id));
	const [dash, details] = ['dash', 'details'].map((k) => app.views.find((v) => String(v.viewId) === String(state.objects[`page:${k}`].id)));
	assert.equal(String(app.landingViewId), String(details.viewId));
	assert.deepEqual([details.visible, dash.visible], [true, false]);
	const seq = calls.filter((c) => ['setViewVisible', 'setLanding'].includes(c.name)).map((c) => (c.name === 'setLanding' ? 'landing' : `${c.args.visible ? 'show' : 'hide'}:${c.args.viewId}`));
	assert.deepEqual(seq, [`show:${details.viewId}`, 'landing', `hide:${dash.viewId}`]);
	calls.length = 0;
	const again = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(again.actions.find((a) => a.kind === 'navigation').action, 'unchanged');
});

test('a first push of only a hidden dashboard keeps the landing view visible', async () => {
	const { config } = await setup();
	const { deps, calls } = stubAppDomo();
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, selection: { dashboards: ['Details'] } });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	assert.equal(summary.actions.find((a) => a.kind === 'navigation').status, 'ok');
	assert.ok(!calls.some((c) => c.name === 'setViewVisible' && !c.args.visible), 'the app\'s landing view is not hidden');
});

test('a push that leaves out the app step fails its views when the app was deleted outside t2d', async () => {
	const { ws, config } = await setup();
	const { deps, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	server.apps.delete(String((await loadState(ws, 'acme')).objects['app:root'].id));
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'pages,layouts' });
	assert.equal(summary.ok, false);
	assert.ok(summary.issues.some((i) => i.code === 'push.app-missing' && /including the app/.test(i.suggestion)));
	assert.deepEqual(summary.actions.filter((a) => a.kind === 'page').map((a) => a.status), ['failed', 'failed']);
});

test('navigation leaves out a view deleted in Domo outside the subset, so the landing view falls back', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	const plan = appPlan();
	delete plan.pages[1].hidden;
	await ws.writeJson(p.plan, plan);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const app = server.apps.get(String(state.objects['app:root'].id));
	app.views = app.views.filter((v) => String(v.viewId) !== String(state.objects['page:dash'].id));
	app.landingViewId = state.objects['page:details'].id;
	server.nav.set(String(app.dataAppId), server.nav.get(String(app.dataAppId)).filter((n) => n.entityId !== String(state.objects['page:dash'].id)));
	plan.pages[1].title = 'Details 2';
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, selection: { dashboards: ['Details'] } });
	const nav = summary.actions.find((a) => a.kind === 'navigation');
	assert.equal(nav.status, 'ok', nav.error);
	assert.match(nav.notes.join(' '), /no longer in the app \("Overview"\)/);
	assert.deepEqual(calls.filter((c) => c.name === 'setLanding').map((c) => c.args.viewId), [state.objects['page:details'].id]);
});

test('a pages plan is refused when the workbook was pushed as an app, even with no view in state', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'app' });
	assert.deepEqual(Object.keys((await loadState(ws, 'acme')).objects).filter((r) => /^(app|page):/.test(r)), ['app:root']);
	await ws.writeJson(p.plan, samplePlan());
	calls.length = 0;
	await assert.rejects(pushPlan({ config, slug: 'sales', deps, emitter: quiet }), (err) => err.code === 'push.target-changed' && /app root \(\d+\)/.test(err.message));
	assert.deepEqual(calls, []);
});

test('navigation icons from the plan replace the Domo default, follow plan changes, and leave an icon picked in Domo alone', async () => {
	const plan = appPlan();
	plan.pages[0].navIcon = 'summary-number';
	plan.pages[1].navIcon = 'table';
	const { ws, p, config } = await setup(plan);
	const { deps, calls, server } = stubAppDomo();
	const first = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(first.ok, true);
	let state = await loadState(ws, 'acme');
	const appId = String(state.objects['app:root'].id);
	const icons = () => server.nav.get(appId).filter((n) => n.entity === 'VIEW').map((n) => [n.title, n.icon.value, n.icon.phosphor]);
	assert.deepEqual(icons(), [['Overview', 'summary-number', 'SummaryNumber'], ['Details', 'table', 'Table']]);
	assert.deepEqual(state.objects['navigation:root'].extra.icons, { [state.objects['page:dash'].id]: 'summary-number', [state.objects['page:details'].id]: 'table' });
	assert.match(first.actions.find((a) => a.kind === 'navigation').notes.join('; '), /set the navigation icon of 2 view/);

	calls.length = 0;
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(!names(calls).includes('reorderNavigation'), 'unchanged icons write nothing');

	server.nav.get(appId).find((n) => n.title === 'Overview').icon = { value: 'star', size: 'DEFAULT' };
	const changed = structuredClone(plan);
	changed.pages[0].navIcon = 'home';
	changed.pages[1].navIcon = 'chart-line';
	await ws.writeJson(p.plan, changed);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.deepEqual(icons(), [['Overview', 'star', undefined], ['Details', 'chart-line', 'Line']]);
	state = await loadState(ws, 'acme');
	assert.equal(state.objects['navigation:root'].extra.icons[state.objects['page:details'].id], 'chart-line');

	const bad = structuredClone(changed);
	bad.pages[1].navIcon = 'no-such-icon';
	await ws.writeJson(p.plan, bad);
	const last = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(last.ok, true);
	assert.match(last.actions.find((a) => a.kind === 'navigation').notes.join('; '), /kept the icon of 1 view.*no-such-icon/);
	assert.equal(icons()[1][1], 'chart-line');
});

test('alternating a subset push and a full push leaves an unchanged navigation alone, icons included', async () => {
	const plan = appPlan();
	plan.pages[0].navIcon = 'summary-number';
	plan.pages[1].navIcon = 'table';
	const { ws, p, config } = await setup(plan);
	const { deps, calls } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const subset = structuredClone(plan);
	subset.pages = subset.pages.filter((pg) => pg.key === 'details');
	subset.selection = { dashboards: ['Details'], worksheets: [], datasources: [] };
	for (const next of [subset, plan, subset]) {
		await ws.writeJson(p.plan, next);
		calls.length = 0;
		const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
		assert.equal(summary.actions.find((a) => a.kind === 'navigation').action, 'unchanged');
		assert.ok(!names(calls).includes('reorderNavigation'));
	}
});

test('a re-push never moves, renames, shows, lays out or restyles a view t2d did not create, nor takes its landing', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls, server } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const appId = state.objects['app:root'].id;
	const app = server.apps.get(String(appId));
	const page3 = 9000;
	app.views.push({ viewId: page3, title: 'Page 3', visible: false, children: [] });
	const nav = server.nav.get(String(appId));
	const viewAt = nav.findIndex((n) => n.entity === 'VIEW');
	nav.splice(viewAt + 1, 0, { entity: 'VIEW', entityId: String(page3), title: 'Page 3', visible: false, icon: { value: 'chart-pie', size: 'DEFAULT' }, iconPosition: 'LEFT' });
	nav.forEach((n, i) => (n.navOrder = i + 1));
	app.landingViewId = page3;
	const before = structuredClone(nav.find((n) => n.entityId === String(page3)));
	const slot = nav.findIndex((n) => n.entityId === String(page3));

	const plan = appPlan();
	[plan.pages[0].navOrder, plan.pages[1].navOrder] = [2, 1];
	plan.pages[1].title = 'Details v2';
	plan.app.theme = { base: 'Midnight' };
	plan.options = { theme: 'Midnight' };
	await ws.writeJson(p.plan, plan);
	calls.length = 0;
	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));

	const after = server.nav.get(String(appId));
	assert.equal(after.findIndex((n) => n.entityId === String(page3)), slot, 'Page 3 keeps its navigation slot');
	assert.deepEqual(after[slot], before, 'and its entry is sent back unchanged');
	assert.deepEqual(after.filter((n) => n.entity === 'VIEW' && n.entityId !== String(page3)).map((n) => n.title), ['Details v2', 'Overview'], 't2d views take the new order in their own slots');
	assert.equal(server.apps.get(String(appId)).landingViewId, page3, 'the landing view someone picked stays');
	const touched = calls.filter((c) => [c.args?.viewId, c.args?.pageId].map(String).includes(String(page3)));
	assert.deepEqual(touched.map((c) => c.name), [], 'no call names Page 3');
	assert.ok(!names(calls).includes('clearStyleOverride'), 'clearing style overrides would reset Page 3 too');
	assert.ok(!names(calls).includes('setLanding'));
	assert.match(summary.actions.find((a) => a.kind === 'app').notes.join(' '), /style overrides of the views were kept/);
	assert.match(summary.actions.find((a) => a.kind === 'navigation').notes.join(' '), /kept the landing view 9000/);
});

test('a view that drops out of the plan is deleted on the next whole push, not on a dry run or a partial one', async () => {
	const { ws, p, config } = await setup();
	const { deps, calls } = stubAppDomo();
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const before = await loadState(ws, 'acme');
	const detailsId = before.objects['page:details'].id;
	const next = appPlan();
	next.pages = next.pages.filter((pg) => pg.key !== 'details');
	next.cards[0].pageKeys = ['dash'];
	await ws.writeJson(p.plan, next);

	const dry = await pushPlan({ config, slug: 'sales', deps, emitter: quiet, dryRun: true });
	assert.deepEqual(dry.actions.filter((a) => a.kind === 'page' && a.action === 'delete').map((a) => [a.key, a.id, a.status]), [['details', detailsId, 'dry-run']]);
	await pushPlan({ config, slug: 'sales', deps, emitter: quiet, only: 'cards' });
	assert.ok(!calls.some((c) => c.name === 'deleteView'), 'a partial push leaves views alone');

	const summary = await pushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	assert.deepEqual(calls.filter((c) => c.name === 'deleteView').map((c) => c.args.viewId), [detailsId]);
	const after = await loadState(ws, 'acme');
	assert.equal(after.objects['page:details'], undefined);
	assert.equal(after.objects['layout:details'], undefined);
});
