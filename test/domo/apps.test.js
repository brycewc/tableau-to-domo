import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { DEFAULT_NAV_ICON, NAV_ICONS, appUrl, applyControlSpacing, applyItemStyles, applySectionFills, applyThemeImages, applyThemeOverrides, buildNavigation, createApp, createView, getNavigation, hasAppSettings, mergeAppSettings, renameView, searchApps, sectionFillIds, updateApp, visibleViewIds, appViewIds, withNavIcon } from '../../src/domo/apps.js';
import { LayoutLockedError, writeLayout } from '../../src/domo/pages.js';
import { appStudioStatus } from '../../src/domo/probe.js';

let mock;
afterEach(() => mock?.restore());

test('createApp sends the navigation settings and theme when given', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/content/v1/dataapps', json: { dataAppId: 5, landingViewId: 6, title: 'Sales', navOrientation: 'LEFT', showDomoNavigation: false, showNavigation: true, showTitle: false, theme: { name: 'Midnight' } } }]);
	const navigation = { orientation: 'LEFT', showDomoNavigation: true, showNavigation: true };
	const { app } = await createApp(client, { title: 'Sales', navigation, theme: { name: 'Midnight' } });
	assert.deepEqual(jsonBody(mock.calls[0]), { title: 'Sales', description: '', type: 'app', navOrientation: 'LEFT', showDomoNavigation: false, showNavigation: true, showTitle: false, theme: { name: 'Midnight' } });
	assert.equal(hasAppSettings(app, { title: 'Sales', navigation }, { name: 'midnight' }), true);
	assert.equal(hasAppSettings({ ...app, navOrientation: 'TOP' }, { title: 'Sales', navigation }), false);
	assert.equal(hasAppSettings(app, { title: 'Sales', navigation }, { name: 'Clarion' }), false);
});

test('createApp without settings sends only title, description and type; createView returns the view and layout ids', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/content/v1/dataapps', json: { dataAppId: 5, landingViewId: 6, views: [{ viewId: 6 }] } },
		{ method: 'POST', path: '/content/v1/dataapps/5/views', json: { view: { pageId: 7 }, layout: { layoutId: 70 } } }
	]);
	assert.deepEqual(await createApp(client, { title: 'Sales' }).then((r) => [r.id, r.defaultViewId]), [5, 6]);
	assert.deepEqual(jsonBody(mock.calls[0]), { title: 'Sales', description: '', type: 'app' });
	assert.deepEqual(await createView(client, 5, { title: 'Details' }), { viewId: 7, layoutId: 70 });
	assert.deepEqual(jsonBody(mock.calls[1]), { type: 'dataappview', title: 'Details' });
});

test('updateApp PUTs the merged body without the fields the PUT ignores; renameView sends a text body', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'PUT', path: '/content/v1/dataapps/5', json: { dataAppId: 5 } },
		{ method: 'PUT', path: '/content/v1/dataapps/5/views/6/name', text: '' }
	]);
	const current = { dataAppId: 5, title: 'Old', landingViewId: 6, owners: [{ id: 1, type: 'USER' }], theme: { name: 'Clarion' }, views: [{ viewId: 6 }], navigations: [], userAccess: {}, persistSettings: null, showTitle: true };
	await updateApp(client, 5, mergeAppSettings(current, { title: 'New', navigation: { orientation: 'LEFT', showDomoNavigation: true, showNavigation: true } }));
	assert.equal(mock.calls[0].query.includeHiddenViews, 'true');
	assert.deepEqual(jsonBody(mock.calls[0]), {
		dataAppId: 5,
		title: 'New',
		landingViewId: 6,
		owners: [{ id: 1, type: 'USER' }],
		theme: { name: 'Clarion' },
		showTitle: false,
		navOrientation: 'LEFT',
		showDomoNavigation: false,
		showNavigation: true
	});
	await renameView(client, 5, 6, 'Overview');
	assert.equal(mock.calls[1].body, 'Overview');
	assert.equal(mock.calls[1].headers['Content-Type'], 'text/plain');
});

test('getNavigation sorts by navOrder; buildNavigation orders t2d views in their own slots, leaving foreign views and fixed items where they are', async () => {
	const { client } = testClient();
	const item = (entity, entityId, navOrder, title = entity) => ({ entity, entityId: String(entityId), navOrder, title, visible: true });
	mock = mockFetch([
		{ method: 'GET', path: '/content/v1/dataapps/5/navigation', json: [item('MORE', 'more', 6), item('HOME', 'home', 1), item('VIEW', 9, 3, 'Foreign'), item('VIEW', 6, 2, 'App Page 1'), item('AI_ASSISTANT', 'ai_assistant', 5), item('VIEW', 7, 4, 'Second')] }
	]);
	const nav = await getNavigation(client, 5);
	assert.equal(mock.calls[0].query.includeHidden, 'true');
	assert.deepEqual(nav.map((n) => n.navOrder), [1, 2, 3, 4, 5, 6]);
	const built = buildNavigation(nav, [
		{ id: 7, title: 'Details', visible: false },
		{ id: 6, title: 'Overview', visible: true },
		{ id: 99, title: 'Not in the app', visible: true }
	]);
	assert.deepEqual(built.map((n) => `${n.navOrder}:${n.entity}:${n.title}:${n.visible}`), ['1:HOME:HOME:true', '2:VIEW:Details:false', '3:VIEW:Foreign:true', '4:VIEW:Overview:true', '5:AI_ASSISTANT:AI_ASSISTANT:true', '6:MORE:MORE:true']);
	assert.equal(built[2], nav[2], 'the foreign view is sent exactly as read');
});

test('buildNavigation never moves, renames or shows a view t2d did not create, wherever it sits', () => {
	const item = (entityId, navOrder, title, visible = true) => ({ entity: 'VIEW', entityId: String(entityId), navOrder, title, visible });
	const nav = [item(1, 1, 'Bookings'), item(3, 2, 'Page 3', false), item(2, 3, 'Glossary')];
	const built = buildNavigation(nav, [
		{ id: 2, title: 'Glossary', visible: true },
		{ id: 1, title: 'Bookings', visible: true }
	]);
	assert.deepEqual(built.map((n) => [n.entityId, n.navOrder]), [['2', 1], ['3', 2], ['1', 3]]);
	assert.equal(built[1], nav[1]);
	assert.deepEqual(buildNavigation(nav, [{ id: 1, title: 'Bookings', visible: true }, { id: 2, title: 'Glossary', visible: true }]), nav, 'an unchanged order sends the navigation as read');
});

test('appStudioStatus reads the customer features; data-app decides availability', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v3/customers/current/name', text: '"acme"' },
		{ method: 'GET', path: '/content/v3/customers/acme/features', json: [{ name: 'data-app', enabled: true }, { name: 'app-studio-persist', enabled: false }] }
	]);
	const status = await appStudioStatus(client);
	assert.equal(status.available, true);
	assert.equal(status.customer, 'acme');
	assert.equal(status.flags['app-studio-persist'], 'off');
	assert.equal(status.flags['rooster-cards'], 'absent');
});

test('writeLayout: a write lock held by another user is a LayoutLockedError and the layout is not written', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/6/layouts', json: { layoutId: 60, pageUrn: '6', content: [] } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/60/writelock', status: 403, json: { message: "WL002: Cannot overwrite another user's existing write lock" } }
	]);
	await assert.rejects(writeLayout(client, 6, { content: [], standard: { template: [] }, compact: { template: [] } }), (err) => err instanceof LayoutLockedError && err.code === 'push.layout-locked');
	assert.ok(!mock.calls.some((c) => c.method === 'PUT' && c.path === '/content/v4/pages/layouts/60'));
});

test('searchApps uses the admin summary title search; view helpers and links', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/content/v1/dataapps/adminsummary', json: { dataAppAdminSummaries: [{ dataAppId: 1, title: '[t2d test] x' }] } }]);
	assert.deepEqual(await searchApps(client, '[t2d test]'), [{ dataAppId: 1, title: '[t2d test] x' }]);
	assert.deepEqual(jsonBody(mock.calls[0]), { includeTitleClause: true, titleSearchText: '[t2d test]' });
	const app = { views: [{ viewId: 1, visible: true, children: [{ viewId: 2, visible: false, children: [] }] }, { viewId: 3, visible: false }] };
	assert.deepEqual(appViewIds(app), [1, 2, 3]);
	assert.deepEqual(visibleViewIds(app), [1]);
	assert.equal(appUrl('acme', 5, 6), 'https://acme.domo.com/app-studio/5/pages/6');
});

test('writeLayout: a write lock that lapsed before the PUT (403 WL003) is taken again once; twice is a LayoutLockedError', async () => {
	const { client } = testClient();
	const layout = { content: [], standard: { template: [] }, compact: { template: [] } };
	const lapsed = { status: 403, json: { message: 'WL003: Cannot edit without valid writelock' } };
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/6/layouts', json: { layoutId: 60, pageUrn: '6', content: [] } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/60/writelock', json: {}, repeat: true },
		{ method: 'PUT', path: '/content/v4/pages/layouts/60', ...lapsed },
		{ method: 'PUT', path: '/content/v4/pages/layouts/60', json: {} },
		{ method: 'DELETE', path: '/content/v4/pages/layouts/60/writelock', json: {} },
		{ method: 'GET', path: '/content/v4/pages/layouts/60', json: { layoutId: 60, content: [] } }
	]);
	await writeLayout(client, 6, layout, { pollIntervalMs: 1 });
	assert.equal(mock.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/writelock')).length, 2);
	mock.restore();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/6/layouts', json: { layoutId: 60, pageUrn: '6', content: [] } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/60/writelock', json: {}, repeat: true },
		{ method: 'PUT', path: '/content/v4/pages/layouts/60', ...lapsed, repeat: true },
		{ method: 'DELETE', path: '/content/v4/pages/layouts/60/writelock', json: {} }
	]);
	await assert.rejects(writeLayout(client, 6, layout, { pollIntervalMs: 1 }), (err) => err instanceof LayoutLockedError && /WL003/.test(err.message));
});

test('applyControlSpacing with image cards makes the document style square, unpadded and with no header margin (the user\'s CustomerVoice edit)', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const id = clarion.mappings.document;
	const before = clarion.cards.find((s) => s.id === id);
	const spaced = applyControlSpacing(clarion, { images: true }).theme;
	const style = spaced.cards.find((s) => s.id === id);
	assert.deepEqual([style.borderRadius, style.padding, style.elementSpacing.isCustom, style.elementSpacing.header], [0, { left: 0, right: 0, top: 0, bottom: 0 }, true, { bottomMargin: 0 }]);
	assert.deepEqual([style.backgroundColor, style.borderWidth], [before.backgroundColor, before.borderWidth]);
	assert.deepEqual(spaced.images, clarion.images);
	assert.deepEqual(applyControlSpacing(clarion).theme.cards.find((s) => s.id === id), before, 'without image cards it is left alone');
	assert.equal(applyControlSpacing(spaced, { images: true }).changed, false);
});

test('applyControlSpacing flattens every card, table and text card style with a drop shadow and leaves the others as they were', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const { theme, changed } = applyControlSpacing(clarion);
	assert.equal(changed, true);
	const shadow = (list, id) => {
		const style = theme[list].find((s) => s.id === id);
		return [style.dropShadow, style.dropShadowColor];
	};
	for (const [list, id] of [['cards', 'ca2'], ['cards', 'ca7'], ['tables', 't1']]) assert.deepEqual(shadow(list, id), ['NONE', null], `${list} ${id}`);
	for (const id of ['ca4', 'ca5', 'ca6', 'ca8']) assert.deepEqual(theme.cards.find((s) => s.id === id), clarion.cards.find((s) => s.id === id), `card ${id} untouched`);
	assert.deepEqual(theme.notebooks, clarion.notebooks);
	assert.deepEqual(theme.tables.find((s) => s.id === 't3'), clarion.tables.find((s) => s.id === 't3'));
	assert.equal(applyControlSpacing(theme).changed, false);
	const styled = applyItemStyles(theme, [{ key: 'a', kind: 'card', background: null }, { key: 'b', kind: 'table', background: null }]).theme;
	assert.deepEqual([...styled.cards, ...styled.tables].filter((s) => s.dropShadow && s.dropShadow !== 'NONE'), []);
});

test('applyControlSpacing: a theme whose only difference is a shadowed chart style changes once', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const flat = applyControlSpacing(clarion).theme;
	const shadowed = structuredClone(flat);
	Object.assign(shadowed.cards.find((s) => s.id === flat.mappings.chart), { dropShadow: 'LIFTED', dropShadowColor: { type: 'COLOR_REFERENCE', value: 'c3', opacity: '40' } });
	const once = applyControlSpacing(shadowed);
	assert.equal(once.changed, true);
	assert.deepEqual(once.theme, flat);
	assert.equal(applyControlSpacing(once.theme).changed, false);
});

test('applySectionFills refills the unmapped section style per title fill, copied from the mapped one with no border, density or margin, and reuses it', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const base = clarion.sections.find((s) => s.id === clarion.mappings.section);
	const { theme, changed, notes } = applySectionFills(clarion, ['#19429C', '#19429C']);
	assert.equal(changed, true);
	assert.deepEqual(notes, []);
	const color = theme.colors.find((c) => c.value.value === '#19429C');
	assert.deepEqual(color.tags, ['CUSTOM']);
	assert.equal(theme.sections.length, 2, 'the server rebuilds a theme with any other number of section styles');
	assert.deepEqual(theme.sections[0], base);
	const filled = theme.sections[1];
	assert.deepEqual(filled, { ...base, id: 's2', background: { type: 'COLOR_REFERENCE', value: color.id }, borderWeight: 0, borderRadius: 0, density: { standard: 0, compact: 0 }, margin: { standard: { left: 0, right: 0, top: 0, bottom: 0 }, compact: { left: 0, right: 0, top: 0, bottom: 0 } } });
	assert.deepEqual(sectionFillIds(theme, ['#19429C']), { '#19429C': 's2' });
	assert.deepEqual(sectionFillIds(clarion, ['#19429C']), {}, 'none before');
	assert.equal(applySectionFills(theme, ['#19429C']).changed, false, 'a theme with the style needs no write');
	assert.equal(applySectionFills(clarion, []).changed, false);

	const two = applySectionFills(theme, ['#19429C', '#A6AEFF']);
	assert.equal(two.theme.sections.length, 2);
	assert.deepEqual(sectionFillIds(two.theme, ['#19429C', '#A6AEFF']), { '#19429C': 's2' }, 'a kept fill style is not refilled');
	assert.deepEqual(two.notes, ['the theme keeps 2 section styles; title rows filled #A6AEFF keep no fill']);
	assert.equal(applySectionFills({ ...clarion, sections: [base] }, ['#19429C']).theme.sections.map((s) => s.id).join(), 's1,s2', 'a theme with one section style gets the second');
});

test('applyControlSpacing makes the control style square and unpadded and the section style dense, through the mappings', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const { theme, changed, notes } = applyControlSpacing(clarion);
	const control = theme.cards.find((s) => s.id === 'ca1');
	assert.deepEqual([control.borderRadius, control.padding, control.elementSpacing.isCustom, control.elementSpacing.header], [0, { left: 0, right: 0, top: 0, bottom: 0 }, true, { bottomMargin: 0 }]);
	assert.deepEqual(theme.sections.map((s) => s.density), [{ compact: 6, standard: 0 }, { compact: 6, standard: 6 }], 'only the mapped section style');
	assert.deepEqual(theme.sections.map((s) => s.borderRadius), [0, clarion.sections[1].borderRadius]);
	assert.deepEqual(theme.pages.map((p) => p.density.standard), [0], 'no gap between items, as the user set CustomerVoice Dashboard');
	const chart = theme.cards.find((s) => s.id === 'ca2');
	const { dropShadow, dropShadowColor } = clarion.cards.find((s) => s.id === 'ca2');
	assert.deepEqual({ ...chart, borderRadius: 24, dropShadow, dropShadowColor }, clarion.cards.find((s) => s.id === 'ca2'), 'chart styles keep their padding');
	assert.deepEqual([chart.borderRadius, theme.cards.find((s) => s.id === 'ca3').borderRadius, theme.tables.find((s) => s.id === clarion.mappings.table).borderRadius, theme.cards.find((s) => s.id === 'ca8').borderRadius], [0, 0, 0, 24], 'Tableau zones are square: chart, single value, control and table styles');
	assert.deepEqual([changed, notes], [true, []]);
	assert.equal(clarion.cards[0].borderRadius, 24, 'pure');
	assert.equal(applyControlSpacing(theme).changed, false, 'a spaced theme needs no write');

	const brand = structuredClone(clarion);
	brand.mappings = { ...brand.mappings, control: 'ca3', image: 'ca8', document: 'ca8', brick: 'ca8' };
	const shared = applyControlSpacing(brand).theme;
	assert.equal(shared.mappings.control, 'ca7', 'a style shared with single values is copied onto the last free one');
	assert.deepEqual([shared.cards.find((s) => s.id === 'ca7').borderRadius, shared.cards.length], [0, 8]);
	assert.deepEqual(shared.cards.find((s) => s.id === 'ca7').fontColor, brand.cards.find((s) => s.id === 'ca3').fontColor);
	const full = structuredClone(brand);
	full.mappings = { ...full.mappings, ...Object.fromEntries(['ca1', 'ca2', 'ca4', 'ca5', 'ca6', 'ca7'].map((id, i) => [`x${i}`, id])) };
	const none = applyControlSpacing(full);
	assert.deepEqual(none.theme.cards.find((s) => s.id === 'ca3').padding, full.cards.find((s) => s.id === 'ca3').padding);
	assert.match(none.notes[0], /shared/);
	const filters = applyControlSpacing(clarion, { control: { background: '#EEF1F3', borderWidth: 0 } }).theme;
	const ca1 = filters.cards.find((s) => s.id === 'ca1');
	assert.deepEqual([filters.colors.find((c) => c.id === ca1.backgroundColor.value).value.value, ca1.borderWidth], ['#EEF1F3', 0], "the workbook's filter background, no border");
});

test('applyThemeOverrides clones a built-in theme with the workbook colors and fonts within the server theme rules', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const { theme, notes } = applyThemeOverrides(clarion, { fontFamily: 'Serif', titleFontFamily: 'Condensed', fontColor: '#333333', background: '#FFF5E6', card: { background: '#FFFFFF', borderColor: '#D4D4D4', borderWidth: 9 }, buttonBackground: '#4E79A7' });
	assert.deepEqual(notes, []);
	assert.equal(theme.name, 'Clarion (Tableau)');
	assert.equal(clarion.name, 'Clarion', 'the input is not changed');
	const color = (id) => theme.colors.find((c) => c.id === id);
	const custom = theme.colors.filter((c) => c.tags.includes('CUSTOM'));
	assert.deepEqual(custom.map((c) => c.value.value), ['#FFF5E6', '#4E79A7'], 'existing theme colors are reused');
	assert.ok(custom.every((c) => /^c\d{1,2}$/.test(c.id) && Number(c.id.slice(1)) <= 99 && /^#[A-F0-9]{6}$/.test(c.value.value)));
	assert.equal(color(theme.app.backgroundColor.value).value.value, '#FFF5E6');
	assert.ok(theme.pages.every((pg) => pg.background.value === theme.app.backgroundColor.value));
	const chart = theme.cards.find((c) => c.id === theme.mappings.chart);
	assert.equal(color(chart.backgroundColor.value).tags.includes('FONT'), false, 'a background never references a font color');
	assert.equal(color(chart.borderColor.value).value.value, '#D4D4D4');
	assert.equal(chart.borderWidth, 4, 'border width capped at 4');
	assert.equal(theme.tables.find((t) => t.id === theme.mappings.table).borderWidth, 4);
	assert.equal(color(theme.buttons.find((b) => b.id === theme.mappings.button).backgroundColor.value).value.value, '#4E79A7');
	const auto = theme.colors.find((c) => c.value.type === 'AUTOMATIC_COLOR');
	assert.equal(color(auto.value.dark.value).value.value, '#333333');
	assert.equal(color(auto.value.light.value).value.value, '#FFFFFF');
	const titleFonts = new Set([...theme.headers.map((h) => h.font.value), ...theme.cards.map((c) => c.titleFont.value)]);
	assert.ok(theme.fonts.every((f) => f.family === (titleFonts.has(f.id) ? 'Condensed' : 'Serif')));
	assert.deepEqual(applyThemeOverrides(clarion, undefined).theme, clarion);
	const full = { ...clarion, colors: Array.from({ length: 99 }, (_, i) => ({ id: `c${i + 1}`, value: { type: 'RGB_HEX', value: '#000000' }, tags: ['FONT'] })) };
	assert.match(applyThemeOverrides(full, { background: '#123456' }).notes[0], /no free theme color id/);
});

test('Domo navigation is sent on with TOP unless the plan turns it off, and always off with LEFT, which also hides the title', () => {
	const fields = (navigation) => mergeAppSettings({ owners: [{ id: 1 }] }, { title: 'Sales', navigation });
	assert.deepEqual([fields({ orientation: 'TOP', showNavigation: true })].map((f) => [f.showDomoNavigation, f.showTitle]), [[true, true]]);
	assert.equal(fields({ orientation: 'TOP', showDomoNavigation: false, showNavigation: true }).showDomoNavigation, false);
	assert.deepEqual([fields({ orientation: 'LEFT', showDomoNavigation: true, showNavigation: true })].map((f) => [f.showDomoNavigation, f.showTitle]), [[false, false]]);
	const app = { title: 'Sales', navOrientation: 'TOP', showDomoNavigation: true, showNavigation: true, showTitle: true };
	assert.equal(hasAppSettings(app, { title: 'Sales', navigation: { orientation: 'TOP', showDomoNavigation: false, showNavigation: true } }), false, 'an app showing Domo navigation is updated');
	assert.equal(hasAppSettings(app, { title: 'Sales', navigation: { orientation: 'TOP', showDomoNavigation: true, showNavigation: true, showTitle: true } }), true);
});

test('buildNavigation sets view icons over the Domo default and over its own, never over one picked in the editor', () => {
	const view = (id, icon) => ({ entity: 'VIEW', entityId: String(id), navOrder: id, title: `V${id}`, visible: true, ...(icon ? { icon: { value: icon, size: 'DEFAULT' }, iconPosition: 'LEFT' } : {}) });
	const nav = [view(1, DEFAULT_NAV_ICON), view(2, 'star'), view(3, 'table'), view(4)];
	const built = buildNavigation(nav, [1, 2, 3, 4].map((id) => ({ id, title: `V${id}`, visible: true, icon: 'chart-line' })), { 3: 'table' });
	assert.deepEqual(built.map((n) => n.icon?.value), ['chart-line', 'star', 'chart-line', 'chart-line']);
	assert.deepEqual(built[0].icon, { value: 'chart-line', phosphor: 'Line', size: 'DEFAULT' });
	assert.equal(built[3].iconPosition, 'LEFT', 'the server requires a position for an icon');
	assert.deepEqual(buildNavigation(nav, [{ id: 1, title: 'V1', visible: true }])[0].icon, nav[0].icon, 'no plan icon keeps the item icon');
	assert.deepEqual(withNavIcon({ icon: { value: 'pages', size: 'LARGE', style: { color: 'c1' } } }, 'money-universal').icon, { value: 'money-universal', phosphor: 'Money', size: 'LARGE', style: { color: 'c1' } });
	assert.throws(() => withNavIcon({}, 'not-an-icon'), /not a navigation icon/);
	assert.ok(Object.keys(NAV_ICONS).includes(DEFAULT_NAV_ICON));
});

test('applyThemeImages lists each data file once as a theme image after the highest id, and reuses one already listed', () => {
	const theme = { name: 'Clarion', images: [{ id: 'i1', dataFileId: 301 }, { id: 'i2', dataFileId: 302 }] };
	const { theme: out, ids, changed } = applyThemeImages(theme, [302, '501', 501]);
	assert.equal(changed, true);
	assert.deepEqual(ids, { 302: 'i2', 501: 'i3' });
	assert.deepEqual(out.images, [...theme.images, { id: 'i3', dataFileId: 501 }]);
	assert.equal(theme.images.length, 2, 'the input is not changed');
	const same = applyThemeImages(out, [501]);
	assert.deepEqual([same.changed, same.theme === out, same.ids], [false, true, { 501: 'i3' }]);
	assert.deepEqual(applyThemeImages({}, [7]).theme.images, [{ id: 'i1', dataFileId: 7 }]);
});

test('applyThemeOverrides sets the mapped table style to the workbook table look', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const table = { rowColor: '#FFFFFF', bandColor: '#F5F5F5', totalColor: '#FFFFFF', subtotalColor: '#D4D4D4', borderType: 'HORIZONTAL', borderColor: '#CBCBCB' };
	const { theme, notes } = applyThemeOverrides(clarion, { table });
	assert.deepEqual(notes, []);
	const hex = (ref) => theme.colors.find((c) => c.id === ref.value).value.value;
	const t = theme.tables.find((s) => s.id === theme.mappings.table);
	assert.deepEqual([hex(t.rowColor), hex(t.headerBackgroundColor), hex(t.alternatingRowColor), hex(t.totalRowBackgroundColor), hex(t.subtotalRowBackgroundColor), hex(t.tableBorderColor)], ['#FFFFFF', '#FFFFFF', '#F5F5F5', '#FFFFFF', '#D4D4D4', '#CBCBCB']);
	assert.deepEqual([t.alternatingRowColorEnabled, t.tableBorderType, t.tableBorderWeight], [true, 'HORIZONTAL', 1]);
	const auto = theme.colors.find((c) => c.value.type === 'AUTOMATIC_COLOR').id;
	assert.ok(['headerFontColor', 'totalRowFontColor', 'subtotalRowFontColor'].every((k) => t[k].value === auto), 'text on the fills is the automatic font color');
	const plain = applyThemeOverrides(clarion, { table: { ...table, bandColor: null, borderType: 'NONE', borderColor: null } }).theme.tables.find((s) => s.id === clarion.mappings.table);
	assert.deepEqual([plain.alternatingRowColorEnabled, plain.tableBorderType, plain.tableBorderWeight], [false, 'NONE', 0]);
	const white = applyThemeOverrides(clarion, { table: { ...table, totalColor: '#A6AEFF', totalTextColor: '#ffffff', subtotalTextColor: '#123456' } });
	const w = white.theme.tables.find((s) => s.id === clarion.mappings.table);
	const font = (ref) => white.theme.colors.find((c) => c.id === ref.value);
	assert.deepEqual([font(w.totalRowFontColor).value.value, font(w.totalRowFontColor).tags], ['#FFFFFF', ['FONT']], "Tableau's totals text color is set, not automatic");
	assert.equal(w.subtotalRowFontColor.value, auto, 'a color with no theme font color stays automatic');
	assert.match(white.notes.join(' '), /no theme font color #123456/);
});
