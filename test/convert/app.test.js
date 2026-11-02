import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_TEXT_LIMIT, applyAppLayoutRules, planPages } from '../../src/convert/layout.js';
import { planCards } from '../../src/convert/cards.js';
import { resolveConvertOptions } from '../../src/convert/index.js';
import { selectPlan } from '../../src/convert/select.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { p, sheet, workbook, makeBindings } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const CATEGORY = p('none', 'Category');
const zone = (id, kind, rect, extra = {}) => ({ id, kind, rect, floating: false, ...extra });
const full = { x: 0, y: 0, w: 1, h: 1 };
const dash = (name, sheets, extra = {}) => ({ name, size: { mode: 'fixed', width: 1200, height: 800 }, zones: sheets.map((s, i) => zone(`${name}-${i}`, 'worksheet', full, { worksheet: s })), floating: [], ...extra });

function appPlanFor({ worksheets, dashboards, options = {}, filterActions } = {}) {
	const ir = workbook({ worksheets, dashboards });
	if (filterActions) ir.filterActions = filterActions;
	const bindings = makeBindings();
	const resolved = resolveConvertOptions({ target: 'app', ...options }, ir);
	const { cards } = planCards(ir, bindings, { options: resolved });
	const result = planPages(ir, cards, bindings, { options: resolved, workbookKey: 'wb' });
	return { ...result, cards, pageCards: result.cards, ir };
}

const sheets = ['A', 'B', 'C'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));

test('target app: one app per workbook, one view per dashboard in tab order, hidden dashboards hidden in nav', () => {
	const dashboards = [dash('First', ['A'], { tabIndex: 2 }), dash('Second', ['B'], { tabIndex: 0, hidden: true }), dash('Third', ['C'], { tabIndex: 1 })];
	const { app, pages } = appPlanFor({ worksheets: sheets, dashboards });
	assert.ok(!pages.some((pg) => pg.key === 'wb'), 'no root page');
	assert.deepEqual(
		pages.map((pg) => [pg.key, pg.title, pg.navOrder, Boolean(pg.hidden), pg.appKey, pg.parentKey]),
		[
			['wb--second', 'Second', 1, true, 'wb', undefined],
			['wb--third', 'Third', 2, false, 'wb', undefined],
			['wb--first', 'First', 3, false, 'wb', undefined]
		]
	);
	assert.equal(app.key, 'wb');
	assert.equal(app.landingKey, 'wb--third', 'the landing view is the first visible one');
	assert.deepEqual(app.theme, { base: 'Clarion' });
	assert.deepEqual(app.navigation, { orientation: 'TOP', showDomoNavigation: true, showNavigation: true, showTitle: true });
	assert.deepEqual(app.persistSettings, { persistFiltersEnabled: true, persistVariablesEnabled: true, persistDateEnabled: false, persistInteractionsEnabled: false, persistedColumns: [] });
});

test('target app: prefix and page title apply to the app title only; standalone sheets get a Worksheets view last', () => {
	const { app, pages, cards } = appPlanFor({ worksheets: sheets, dashboards: [dash('Overview', ['A'])], options: { namePrefix: 'T: ' } });
	assert.equal(app.title, 'T: Superstore');
	assert.deepEqual(pages.map((pg) => [pg.title, pg.navOrder]), [['Overview', 1], ['Worksheets', 2]]);
	assert.equal(pages[1].key, 'wb--worksheets');
	assert.deepEqual(cards.filter((c) => c.pageKeys.includes('wb--worksheets')).map((c) => c.worksheet), ['B', 'C']);
	const titled = appPlanFor({ worksheets: sheets, dashboards: [dash('Overview', ['A'])], options: { namePrefix: 'T: ', pageTitle: 'Sales app' } });
	assert.equal(titled.app.title, 'Sales app');
});

test('target app: TOP navigation whatever the view count, LEFT only with --nav left (no Domo navigation, no title); --theme and --no-persist-filters', () => {
	const many = Array.from({ length: 7 }, (_, i) => dash(`D${i}`, ['A']));
	assert.deepEqual(appPlanFor({ worksheets: sheets.slice(0, 1), dashboards: many }).app.navigation, { orientation: 'TOP', showDomoNavigation: true, showNavigation: true, showTitle: true });
	assert.deepEqual(appPlanFor({ worksheets: sheets.slice(0, 1), dashboards: many, options: { navOrientation: 'LEFT' } }).app.navigation, { orientation: 'LEFT', showDomoNavigation: false, showNavigation: true, showTitle: false });
	assert.equal(appPlanFor({ worksheets: sheets.slice(0, 1), dashboards: many, options: { domoNav: false } }).app.navigation.showDomoNavigation, false);
	const themed = appPlanFor({ worksheets: sheets.slice(0, 1), dashboards: [dash('D', ['A'])], options: { theme: 'Midnight', persistFilters: false } });
	assert.deepEqual(themed.app.theme, { base: 'Midnight' });
	assert.equal(themed.app.persistSettings.persistFiltersEnabled, false);
	assert.equal(themed.app.persistSettings.persistVariablesEnabled, false);
});

test('target app: click filters never carry across views, since a chart card link cannot pass the clicked values', () => {
	const dashboards = [dash('One', ['A']), dash('Two', ['B'])];
	const cross = appPlanFor({ worksheets: sheets, dashboards, filterActions: [{ name: 'Go', sourceDashboard: 'One', target: 'Two' }] });
	assert.equal(cross.app.persistSettings.persistInteractionsEnabled, false);
	assert.ok(!cross.issues.some((i) => i.code === 'layout.persist-interactions'));
});

test('target app: every dashboard hidden keeps the landing view visible', () => {
	const { app, pages, issues } = appPlanFor({ worksheets: sheets.slice(0, 2), dashboards: [dash('One', ['A'], { hidden: true }), dash('Two', ['B'], { hidden: true })] });
	assert.equal(app.landingKey, pages[0].key);
	assert.equal(pages[0].hidden, undefined);
	assert.equal(pages[1].hidden, true);
	assert.ok(issues.some((i) => i.code === 'layout.landing-hidden'));
});

test('a long dashboard title wraps into header lines in both targets; app lines use the h2 style; long text is a text card in an app', () => {
	const long = 'x'.repeat(252);
	const d = { ...dash('Long', ['A']), zones: [zone('t', 'title', { x: 0, y: 0, w: 1, h: 0.1 }, { text: long }), zone('a', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 }, { worksheet: 'A' })] };
	const app = appPlanFor({ worksheets: sheets.slice(0, 1), dashboards: [d] });
	const appHeaders = app.pages[0].layout.content.filter((i) => i.type === 'HEADER');
	assert.equal(appHeaders.map((h) => h.text).join(''), long);
	assert.ok(appHeaders.length > 1 && appHeaders.every((h) => h.text.length < APP_TEXT_LIMIT && h.style?.sourceId === 'h2'));
	const body = appPlanFor({ worksheets: sheets.slice(0, 1), dashboards: [{ ...d, zones: [{ ...d.zones[0], kind: 'text' }, d.zones[1]] }] });
	assert.equal(body.pages[0].layout.content.filter((i) => i.type === 'HEADER').length, 0);
	assert.deepEqual(body.pageCards.find((c) => c.key.endsWith('.text.t')).body.notebook.paragraphs, [[{ text: long }]]);
	const ir = workbook({ worksheets: sheets.slice(0, 1), dashboards: [d] });
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, {});
	const classic = planPages(ir, cards, bindings, { options: { target: 'pages' } });
	const headers = classic.pages[1].layout.content.filter((i) => i.type === 'HEADER');
	assert.equal(headers.map((h) => h.text).join(''), long);
	assert.ok(headers.every((h) => !h.style), 'classic pages keep the default header style');
	assert.equal(classic.app, undefined);
});

test('applyAppLayoutRules drops non-https links per item and cuts button and section text', () => {
	const layout = {
		content: [
			{ contentKey: 1, type: 'BUTTON', text: 'Mail', interaction: { type: 'WEBLINK', config: { url: 'mailto:a@b.c' } } },
			{ contentKey: 2, type: 'BUTTON', text: 'Site', interaction: { type: 'WEBLINK', config: { url: 'https://example.com' } } },
			{ contentKey: 3, type: 'CARD', cardId: 1, interaction: { type: 'WEBLINK', config: { url: 'http://example.com' } } },
			{ contentKey: 4, type: 'TAB_CONTENT', text: 's'.repeat(300) }
		]
	};
	const issues = applyAppLayoutRules(layout, { name: 'D' });
	assert.equal(layout.content[0].interaction, undefined);
	assert.equal(layout.content[0].text, 'Mail', 'the item stays');
	assert.equal(layout.content[1].interaction.config.url, 'https://example.com');
	assert.equal(layout.content[2].interaction, undefined);
	assert.equal(layout.content[3].text.length, APP_TEXT_LIMIT);
	assert.deepEqual(issues.map((i) => i.code), ['layout.url-action-dropped', 'layout.url-action-dropped', 'layout.text-truncated']);
});

test('selectPlan keeps the app with the selected views and drops it when no view is kept', () => {
	const { app, pages, cards, ir } = appPlanFor({ worksheets: sheets.slice(0, 2), dashboards: [dash('One', ['A']), dash('Two', ['B'])] });
	const plan = { planVersion: 1, target: 'app', app, pages, cards, datasets: [], dataflows: [], beastModes: [], variables: [], issues: [] };
	const one = selectPlan(plan, { dashboards: ['Two'] }, { ir });
	assert.deepEqual(one.app, app);
	assert.deepEqual(one.pages.map((pg) => [pg.key, Boolean(pg.layout)]), [['wb--two', true]]);
	const none = selectPlan(plan, { datasources: ['Orders'] }, { ir });
	assert.deepEqual(none.pages, []);
	assert.equal(none.app, undefined);
});

test('resolveConvertOptions defaults the target to app', () => {
	assert.equal(resolveConvertOptions({}).target, 'app');
	assert.equal(resolveConvertOptions({ target: 'pages' }).target, 'pages');
});

test('the parser reads dashboard tab order, hidden tabs and filter action targets', () => {
	const xml = `<?xml version='1.0'?><workbook>
	<actions>
		<action caption='Go' name='[A1]'><source dashboard='One' type='sheet' worksheet='S' /><command command='tsc:tsl-filter'><param name='target' value='Two' /></command></action>
		<action caption='Link' name='[A2]'><source dashboard='One' type='sheet' worksheet='S' /><command command='tsc:url'><param name='url' value='https://x' /></command></action>
	</actions>
	<dashboards><dashboard name='One'><zones /></dashboard><dashboard name='Two'><zones /></dashboard></dashboards>
	<windows><window class='dashboard' name='Two' /><window class='dashboard' hidden='true' name='One' /></windows>
	</workbook>`;
	const ir = buildWorkbookIR(xml);
	assert.deepEqual(ir.dashboards.map((d) => [d.name, d.tabIndex, Boolean(d.hidden)]), [['One', 1, true], ['Two', 0, false]]);
	assert.deepEqual(ir.filterActions, [{ name: 'Go', sourceDashboard: 'One', target: 'Two' }]);
});
