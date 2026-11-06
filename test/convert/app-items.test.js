import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPages } from '../../src/convert/layout.js';
import { planCards } from '../../src/convert/cards.js';
import { convertWorkbook, resolveConvertOptions } from '../../src/convert/index.js';
import { actionSources, buildAppLayout, opaqueHex, staticUrl, themeFamily, toggleSections, urlInteraction, workbookTheme } from '../../src/convert/app-layout.js';
import { selectIrDatasources, selectPlan } from '../../src/convert/select.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { tilingGaps } from '../../src/convert/tile.js';
import { collectRefs } from '../../src/util/refs.js';
import { p, sheet, workbook, makeBindings } from './cards.fixtures.test.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app-items.twb');
const SHEETS = ['Accounts', 'Pipeline', 'Trend', 'Region Map'];

/** The fixture's dashboards, actions, story and styles (parsed from its XML) over cards.fixtures sheets of the same names. */
function fixtureIr() {
	const parsed = buildWorkbookIR(fs.readFileSync(FIXTURE, 'utf8'));
	const ir = workbook({ worksheets: SHEETS.map((name) => sheet({ name, cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') })), dashboards: parsed.dashboards, parameters: parsed.parameters });
	return Object.assign(ir, { actions: parsed.actions, stories: parsed.stories, style: parsed.style, filterActions: parsed.filterActions, issues: parsed.issues });
}

function plan(options = {}) {
	const ir = fixtureIr();
	const bindings = makeBindings();
	const resolved = resolveConvertOptions({ target: 'app', ...options }, ir);
	const { cards } = planCards(ir, bindings, { options: resolved, workbookKey: 'wb' });
	const variables = [{ key: 'param.region-pick.string', name: 'Region Pick', parameter: ir.parameters.find((pm) => pm.name === 'Region Pick') }];
	const result = planPages(ir, cards, bindings, { options: resolved, workbookKey: 'wb', variables });
	const page = (title) => result.pages.find((pg) => pg.title === title);
	const content = (title) => page(title).layout.content;
	const codes = (code) => result.issues.filter((i) => i.code === code);
	return { ...result, cards, pageCards: result.cards, ir, page, content, codes };
}

const cardOf = (items, key) => items.find((i) => i.type === 'CARD' && i.cardId?.$ref === `card:${key}`);

test('navigation buttons become BUTTON items that open the target view; a button to a missing sheet is left out', () => {
	const { content, codes, page } = plan();
	const buttons = content('Tracking').filter((i) => i.type === 'BUTTON');
	assert.equal(buttons.length, 1);
	assert.deepEqual(buttons[0], {
		contentKey: buttons[0].contentKey,
		type: 'BUTTON',
		text: 'Account Detail',
		iconPosition: 'LEFT',
		interaction: {
			type: 'DOMOLINK',
			config: {
				entityType: 'page',
				entityId: { $ref: 'page:wb--account-detail', field: 'idString' },
				url: { $ref: 'page:wb--account-detail', field: 'appUrl' },
				displayMode: 'APP_NAVIGATION',
				openInNewWindow: false,
				persistFilters: true,
				allowCardToCardInteractions: false,
				selectedCardUrns: [],
				selectIndividualCards: false,
				mobileOpenScanner: false,
				columns: [],
				displayName: ''
			}
		}
	});
	const box = page('Tracking').layout.standard.template.find((t) => t.contentKey === buttons[0].contentKey);
	assert.ok(box.height >= 3 && box.width >= 8, JSON.stringify(box));
	assert.equal(page('Tracking').layout.compact.template.find((t) => t.contentKey === buttons[0].contentKey).height, 1);
	assert.match(codes('layout.button-target-missing')[0].message, /"Retired Summary" points to a sheet that no longer exists/);
});

test('a hidden dashboard that buttons open stays reachable: linked, with only its navigation item hidden', () => {
	const { page, codes } = plan();
	assert.deepEqual([page('Account Detail').hidden, page('Account Detail').linked], [true, true]);
	assert.equal(page('Tracking').linked, undefined);
	assert.equal(codes('layout.hidden-linked').length, 1);
});

test('show/hide buttons become full-width collapsible sections around the zones they toggle; a text card goes in, a title stays outside', () => {
	const { page, codes, pageCards } = plan();
	const tracking = page('Tracking').layout;
	assert.ok(!tracking.content.some((i) => i.type === 'HEADER'));
	const note = pageCards.find((c) => c.key === 'wb--tracking.text.63');
	assert.equal(note?.body.notebook.valign, 'top');
	const [warning] = tracking.standard.template.filter((x) => x.type === 'TABS');
	assert.equal(tracking.content.find((i) => i.type === 'TAB_CONTENT').text, 'Data Consistency Warning');
	const inside = warning.children[1].children.map((c) => tracking.content.find((i) => i.contentKey === c.contentKey));
	assert.deepEqual(inside.map((i) => i.cardId), [{ $ref: 'card:wb--tracking.text.63' }], 'the text the button toggles is a text card in its section');
	assert.equal(codes('layout.section-text').filter((i) => /above the view items/.test(i.message)).length, 0);
	assert.match(codes('layout.section-text').find((i) => /above its section/.test(i.message)).message, /Title text .* stays a header .*sections hold no headers/);
	assert.deepEqual(tilingGaps(tracking.standard.template, 60), { empty: 0, overlapping: 0 });

	const detail = page('Account Detail').layout;
	const tabs = detail.content.find((i) => i.type === 'TABS');
	assert.deepEqual(tabs, { contentKey: tabs.contentKey, type: 'TABS', tabType: 'SECTION', itemId: tabs.itemId, collapsible: true, hideTitle: false });
	const section = detail.content.find((i) => i.type === 'TAB_CONTENT');
	assert.equal(section.text, 'Filters Panel', 'a named container titles its section');
	const t = detail.standard.template.find((x) => x.type === 'TABS');
	assert.deepEqual([t.x, t.width], [0, 60], 'a section is a full-width row');
	const [bar, content] = t.children;
	assert.deepEqual([bar.type, bar.x, bar.y, bar.width, bar.height], ['TAB_BAR', 0, 0, 60, 5]);
	assert.deepEqual([content.type, content.x, content.y, content.width, content.height + 5], ['TAB_CONTENT', 0, 5, 60, t.height]);
	const members = content.children;
	assert.deepEqual(members.map((m) => [m.type, m.x, m.y, m.width, m.height]), [['CARD', 0, 0, 60, content.height]], 'the card of the container fills the pane; its text is a header above the section');
	assert.ok(!detail.standard.template.some((x) => x.contentKey === members[0].contentKey), 'the member is only inside the section');
	assert.deepEqual(new Set(detail.content.map((c) => c.contentKey)).size, detail.content.length);
	assert.deepEqual(tilingGaps(detail.standard.template, 60), { empty: 0, overlapping: 0 });
	const compact = detail.compact.template.find((x) => x.contentKey === tabs.contentKey);
	assert.deepEqual([compact.width, compact.children[0].height, compact.children[1].y, compact.children[1].children[0].width], [12, 2, 2, 12]);
	assert.equal(compact.height, 2 + compact.children[1].height);
	assert.deepEqual(codes('layout.section').map((i) => /"Data Consistency Warning"/.test(i.message)), [true], 'only the text section on Tracking, which starts shown');
	assert.match(codes('layout.section-expanded')[0].message, /"Filters Panel", which starts expanded/);
	assert.ok(!detail.content.some((i) => i.type === 'BUTTON'), 'the toggle button itself is left out');
});

test('nested show/hide containers are merged into the outer section with an issue', () => {
	const dash = {
		name: 'D',
		zones: [
			{ id: '1', kind: 'worksheet', worksheet: 'A', parent: '10', rect: { x: 0, y: 0, w: 1, h: 0.5 }, floating: false },
			{ id: '2', kind: 'worksheet', worksheet: 'B', parent: '11', rect: { x: 0, y: 0.5, w: 1, h: 0.5 }, floating: false },
			{ id: '8', kind: 'button', button: { action: 'toggle', toggle: { zoneIds: ['10'], shown: true }, states: [] }, rect: {}, floating: true },
			{ id: '9', kind: 'button', button: { action: 'toggle', toggle: { zoneIds: ['11'], shown: true }, states: [] }, rect: {}, floating: true }
		],
		floating: [],
		containers: [
			{ id: '10', layout: 'flow', name: 'Outer', children: ['1', '11'], rect: {}, floating: false },
			{ id: '11', layout: 'flow', name: 'Inner', parent: '10', children: ['2'], rect: {}, floating: false }
		]
	};
	const { sections, issues } = toggleSections(dash);
	assert.deepEqual(sections.map((s) => [s.title, [...s.members]]), [['Outer', ['1', '2']]]);
	assert.match(issues[0].message, /"Inner" is inside section "Outer".*merged into the outer one/);
});

test('card actions: restricted same-view filters, filter and Go to Sheet links, parameter variables, one click action per card', () => {
	const { content, codes } = plan();
	const tracking = content('Tracking');
	assert.deepEqual(cardOf(tracking, 'wb.accounts').interaction, { type: 'STANDARD', config: { allowCardToCardInteractions: false, openInNewWindow: false, selectIndividualCards: true, selectedCardUrns: [] } }, 'its filter targets no other card on the view: the editor\'s "disable interaction filters"');
	const pipeline = cardOf(tracking, 'wb.pipeline').interaction;
	assert.deepEqual([pipeline.type, pipeline.config.entityId, pipeline.config.persistFilters, pipeline.config.displayMode, pipeline.config.allowCardToCardInteractions], ['DOMOLINK', { $ref: 'page:wb--account-detail', field: 'idString' }, true, 'APP_NAVIGATION', true], 'a filter action to another view: "Enable interaction filters" passes the clicked values');
	assert.equal(pipeline.config.interactionFilterMode, undefined, 'Domo accepts an interaction filter mode only from rooster cards');
	assert.deepEqual(codes('layout.action-filter-values'), []);
	assert.ok(codes('layout.action-filter').some((i) => /also filter the cards of the view it starts on/.test(i.message)));
	const detail = content('Account Detail');
	const trend = cardOf(detail, 'wb.trend').interaction;
	assert.deepEqual([trend.config.url, trend.config.persistFilters, trend.config.allowCardToCardInteractions], [{ $ref: 'page:wb--tracking', field: 'appUrl' }, true, false], 'a Go to Sheet action carries filters like a navigation button, with no interaction filters');
	assert.deepEqual(cardOf(detail, 'wb.region-map').interaction, { type: 'VARIABLE', config: { variableId: { $ref: 'variable:param.region-pick.string' } } });
	assert.equal(cardOf(detail, 'wb.pipeline').interaction, undefined, 'actions of another dashboard do not apply');

	const dropped = Object.fromEntries(codes('layout.action-url-dropped').map((i) => [i.object.name, i.message]));
	assert.match(dropped['Go to Account in CRM'], /not migrated: its link needs the clicked mark's field values.*tooltip menu action would replace the card's click filtering/);
	assert.ok(!['Tracking', 'Account Detail'].some((v) => content(v).some((i) => i.interaction?.type === 'WEBLINK')), 'the cut menu link is no card\'s click');
	assert.match(dropped['Email Owner'], /mailto: links are not allowed/);
	assert.equal(codes('layout.action-highlight').length, 1);
	assert.match(codes('layout.action-filter').find((i) => i.object.name === 'Filter by Account').message, /clearing the selection shows all values \(Tableau excludes all\)/);
	assert.match(codes('layout.action-parameter')[0].message, /sets variable "Region Pick"/);
	assert.equal(new Set(content('Account Detail').map((i) => i.contentKey)).size, content('Account Detail').length);
});

test('a same-view filter on selected cards lists their urns; all targets keep Domo\'s default click filtering', () => {
	const ir = workbook({ worksheets: ['A', 'B', 'C'].map((name) => sheet({ name, cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') })) });
	const full = (id, ws, x) => ({ id, kind: 'worksheet', worksheet: ws, rect: { x, y: 0, w: 0.33, h: 1 }, floating: false });
	ir.dashboards = [{ name: 'D', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [full('1', 'A', 0), full('2', 'B', 0.33), full('3', 'C', 0.66)], floating: [] }];
	const filter = (id, targets) => ({ id, name: id, type: 'filter', trigger: 'select', source: { type: 'sheet', dashboard: 'D', worksheet: 'A', worksheets: ['A'] }, target: { name: 'D', kind: 'dashboard', worksheets: targets }, allFields: true, clear: 'show-all' });
	const run = (actions) => {
		ir.actions = actions;
		const bindings = makeBindings();
		const options = resolveConvertOptions({ target: 'app' }, ir);
		const { cards } = planCards(ir, bindings, { options, workbookKey: 'wb' });
		return planPages(ir, cards, bindings, { options, workbookKey: 'wb' }).pages[0].layout.content.find((i) => i.cardId?.$ref === 'card:wb.a');
	};
	assert.deepEqual(run([filter('[F1]', ['A', 'B'])]).interaction.config, { allowCardToCardInteractions: true, openInNewWindow: false, selectIndividualCards: true, selectedCardUrns: [{ $ref: 'card:wb.b', field: 'urn' }] });
	assert.equal(run([filter('[F1]', ['A', 'B', 'C'])]).interaction, undefined);
	assert.equal(run([filter('[F1]', ['B']), filter('[F2]', ['C'])]).interaction, undefined, 'two actions together target every card');
});

test('URL actions: parameter tokens take the current value, field tokens cut the link, http upgrades, other schemes drop', () => {
	const ir = fixtureIr();
	const url = (template, extra = {}) => ({ name: 'Open', type: 'url', url: { template, tokens: [], scheme: /^([a-z]+):/.exec(template)?.[1] ?? '' }, ...extra });
	assert.deepEqual(staticUrl(url('https://<[Parameters].[Parameter 2]>/r/Account/<[Id (Account)]>/view'), ir), { url: 'https://crm.example.com/r/Account/', fieldToken: true, pathToken: true });
	assert.deepEqual(staticUrl(url('https://x.test/search?q=<[Category]>'), ir), { url: 'https://x.test/search', fieldToken: true });
	assert.deepEqual(staticUrl(url('https://x.test/<[Id]>'), ir), { url: 'https://x.test/', fieldToken: true, pathToken: true });
	assert.deepEqual(urlInteraction(url('https://x.test/a', { menuCaption: 'Open <[Name]> -' }), ir).interaction, { type: 'WEBLINK', config: { url: 'https://x.test/a', openInNewWindow: true, displayName: 'Open' } });
	const http = urlInteraction(url('http://x.test/a'), ir);
	assert.deepEqual([http.interaction.config.url, /https/.test(http.note)], ['https://x.test/a', true]);
	assert.match(urlInteraction(url('<[Link]>'), ir).dropped, /starts with a field value/);
	assert.match(urlInteraction(url('https://<[Host]>/x'), ir).dropped, /nothing static is left/);
	assert.match(urlInteraction(url(`https://x.test/${'a'.repeat(2000)}`), ir).dropped, /longer than 2000/);
});

test('a link cut at a field token never replaces the click on menu or hover, and loses the click to a same-view filter', () => {
	const ir = workbook({ worksheets: ['A', 'B'].map((name) => sheet({ name, cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') })) });
	const zone = (id, ws, x) => ({ id, kind: 'worksheet', worksheet: ws, rect: { x, y: 0, w: 0.5, h: 1 }, floating: false });
	ir.dashboards = [{ name: 'D', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('1', 'A', 0), zone('2', 'B', 0.5)], floating: [] }];
	const source = { type: 'sheet', dashboard: 'D', worksheet: 'A', worksheets: ['A'] };
	const link = (id, template, trigger) => ({ id, name: id, type: 'url', trigger, source, url: { template, tokens: [], scheme: /^([a-z]+):/.exec(template)?.[1] ?? '' } });
	const filter = { id: '[F]', name: 'F', type: 'filter', trigger: 'select', source, target: { name: 'D', kind: 'dashboard', worksheets: ['A'] }, allFields: true, clear: 'show-all' };
	const run = (actions) => {
		ir.actions = actions;
		const bindings = makeBindings();
		const options = resolveConvertOptions({ target: 'app' }, ir);
		const { cards } = planCards(ir, bindings, { options, workbookKey: 'wb' });
		const result = planPages(ir, cards, bindings, { options, workbookKey: 'wb' });
		return { card: result.pages[0].layout.content.find((i) => i.cardId?.$ref === 'card:wb.a'), issues: result.issues };
	};
	for (const trigger of ['menu', 'hover']) {
		const { card, issues } = run([link('[U]', 'https://crm.test/r/Account/<[Id]>', trigger)]);
		assert.equal(card.interaction, undefined, `${trigger}: Domo's default click filtering stays`);
		assert.match(issues.find((i) => i.code === 'layout.action-url-dropped').message, /needs the clicked mark's field values/);
	}
	assert.equal(run([link('[U]', 'https://crm.test/home', 'menu')]).card.interaction.config.url, 'https://crm.test/home', 'a link without field tokens is still a menu click');
	const partial = run([link('[U]', 'https://crm.test/search?id=<[Id]>', 'select'), filter]);
	assert.equal(partial.card.interaction.type, 'STANDARD', 'the same-view filter wins over a cut link');
	assert.match(partial.issues.find((i) => i.code === 'layout.action-conflict').message, /URL action "\[U\]" is not applied on 1 card\(s\).*"A" runs "F"/);
	assert.equal(run([link('[U]', 'https://crm.test/search?id=<[Id]>', 'select'), { ...filter, trigger: 'hover' }]).card.interaction.type, 'STANDARD', 'even a hover filter wins over a cut link');
	assert.equal(run([link('[U]', 'https://crm.test/search?id=<[Id]>', 'select')]).card.interaction.config.url, 'https://crm.test/search');
	const table = sheet({ name: 'A', rows: `(${p('none', 'Category')} / ${p('none', 'Region')})`, enc: { text: [p('sum', 'Sales', 'qk')] } });
	ir.worksheets[0] = table;
	const column = run([link('[U]', 'https://crm.test/r/<[Region]>', 'menu'), filter]);
	assert.equal(column.card.interaction.type, 'STANDARD', 'a link column leaves the click to the same-view filter');
	assert.deepEqual(column.issues.filter((i) => i.object?.id === '[U]'), [], 'the card reports the link column; the action has no conflict or drop');
	ir.worksheets[0] = sheet({ name: 'A', cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') });
	const path = run([link('[U]', 'https://crm.test/r/<[Id]>', 'select')]);
	assert.equal(path.card.interaction, undefined, 'a path cut at a field token opens another page, so it is no click');
	assert.match(path.issues.find((i) => i.code === 'layout.action-url-dropped').message, /field values in the page path.*https:\/\/crm\.test\/r\/ opens another page/);
});

test('a URL template that starts with a host and no scheme gets https://, and is cut like any other link', () => {
	const action = (template) => ({ name: 'Open', type: 'url', trigger: 'select', url: { template, tokens: [], scheme: '' } });
	assert.deepEqual(staticUrl(action('support.example.com/s/question/<[Post ID]>')), { url: 'https://support.example.com/s/question/', fieldToken: true, pathToken: true, schemeAdded: true });
	const opened = urlInteraction(action('example.com/a'));
	assert.deepEqual([opened.interaction.config.url, /no scheme, so https:\/\/ was added/.test(opened.note)], ['https://example.com/a', true]);
	assert.match(urlInteraction(action('<[Link]>')).dropped, /starts with a field value/);
	assert.equal(urlInteraction(action('acme.my.salesforce.com/<[Id]>')).interaction.config.url, 'https://acme.my.salesforce.com/');
});

test('an action that starts only on the Worksheets or story view is reported as outside the dashboard views', () => {
	const ir = workbook({ worksheets: ['A', 'B'].map((name) => sheet({ name, cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') })) });
	ir.dashboards = [{ name: 'D', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [{ id: '1', kind: 'worksheet', worksheet: 'A', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false }], floating: [] }];
	ir.actions = [{ id: '[F]', name: 'F', type: 'filter', trigger: 'select', source: { type: 'sheet', worksheet: 'B', worksheets: ['B'] }, target: { name: 'A', kind: 'worksheet' } }];
	const bindings = makeBindings();
	const options = resolveConvertOptions({ target: 'app' }, ir);
	const { cards } = planCards(ir, bindings, { options, workbookKey: 'wb' });
	const result = planPages(ir, cards, bindings, { options, workbookKey: 'wb' });
	assert.ok(result.pages.some((pg) => pg.title === 'Worksheets'));
	assert.match(result.issues.find((i) => i.code === 'layout.action-unplaced').message, /starts on no worksheet of a dashboard view \(card click actions are set on dashboard views only\)/);
});

test('action sources: a datasource action starts on every sheet of that datasource; excluded sheets never', () => {
	const ir = fixtureIr();
	const on = new Set(['Accounts', 'Pipeline']);
	const dash = { name: 'Tracking' };
	assert.deepEqual(actionSources({ source: { type: 'datasource', datasource: 'federated.abc' } }, dash, ir, on), ['Accounts', 'Pipeline']);
	assert.deepEqual(actionSources({ source: { type: 'all', excludeSheets: ['Pipeline'] } }, dash, ir, on), ['Accounts']);
	assert.deepEqual(actionSources({ source: { type: 'sheet', dashboard: 'Other', worksheets: ['Accounts'] } }, dash, ir, on), []);
});

test('a story becomes one view with a tab per point: captions as tab labels, cards, and a button for a dashboard point', () => {
	const { page, codes, cards } = plan();
	const story = page('Account Story');
	assert.deepEqual([story.key, story.story, story.dashboard, story.navOrder], ['wb--account-story', 'Account Story', '', 3]);
	const { content, standard } = story.layout;
	assert.deepEqual(content.slice(0, 2).map((i) => [i.type, i.text ?? i.tabType]), [['HEADER', 'Account Story'], ['TABS', 'TAB']]);
	const panes = content.filter((i) => i.type === 'TAB_CONTENT');
	assert.deepEqual(panes.map((pn) => pn.text), ['1.Summary', '2. Contract Type, Billing Frequency and the Channel Distr...', '3. Trend again']);
	const tabs = standard.template.find((t) => t.type === 'TABS');
	assert.deepEqual(tabs.children.map((c) => [c.type, c.x, c.y]), [['TAB_BAR', 0, 0], ['TAB_CONTENT', 0, 5], ['TAB_CONTENT', 0, 5], ['TAB_CONTENT', 0, 5]]);
	assert.ok(tabs.children.slice(1).every((c) => c.height === tabs.height - 5), 'every pane fills the tab content area');
	const second = tabs.children[2].children.map((c) => content.find((i) => i.contentKey === c.contentKey));
	assert.deepEqual(second.map((i) => i.type), ['BUTTON'], 'the editor allows no header inside a tab');
	assert.match(codes('layout.story-caption')[0].message, /"2. Contract Type, Billing Frequency and the Channel Distribution of Open Balances" is cut/);
	assert.deepEqual(collectRefs(second[0].interaction), new Set(['page:wb--account-detail']));
	assert.deepEqual(tilingGaps(standard.template, 60), { empty: 0, overlapping: 0 });
	assert.ok(!standard.template.some((t) => t.type === 'TABS' && (t.x !== 0 || t.width !== 60)));
	assert.ok(cards.find((c) => c.key === 'wb.trend').pageKeys.includes('wb--account-story'));
	assert.match(codes('layout.story-point')[0].message, /"3. Trend again" repeats the worksheet "Trend"/);
	assert.equal(codes('layout.story-annotations').length, 1);
	assert.equal(codes('layout.story-dashboard').length, 1);
});

test('a story view is selected by its name like a dashboard, with its cards and their datasources', () => {
	const { pages, cards: sheetCards, app, ir } = plan();
	const full = { target: 'app', app, pages, cards: sheetCards, datasets: [], dataflows: [], beastModes: [], variables: [] };
	const story = selectPlan(full, { dashboards: ['account story'] }, { ir });
	assert.deepEqual(story.pages.map((pg) => [pg.story, Boolean(pg.layout)]), [['Account Story', true]]);
	assert.deepEqual(story.selection.dashboards, ['Account Story']);
	assert.ok(story.cards.some((c) => c.worksheet === 'Trend'));
	assert.ok(story.app);
	assert.ok(selectPlan(full, { dashboards: ['*'] }, { ir }).pages.some((pg) => pg.story && pg.layout), '* includes the story view');
	assert.deepEqual(selectIrDatasources(ir, { dashboards: ['Account Story'] }).dashboards, ['Account Story']);
	assert.ok(selectIrDatasources(ir, { dashboards: ['Account Story'] }).datasourceIds.size > 0);
});

test('the workbook theme: dominant fonts mapped to the five families, colors as uppercase hex; --no-workbook-theme keeps the built-in', () => {
	const { app, codes } = plan();
	assert.deepEqual(app.theme, {
		base: 'Clarion',
		overrides: { fontFamily: 'Serif', fontColor: '#333333', background: '#F9F9F9', buttonBackground: '#4E79A7' },
		itemStyles: [{ key: 's1', kind: 'card', background: null, borderColor: '#D4D4D4', borderWidth: 1, padding: null, items: 2 }]
	});
	assert.match(codes('layout.theme')[0].message, /text font Georgia as Serif/);
	assert.match(codes('layout.item-styles')[0].message, /2 card\(s\).*card theme background, border #D4D4D4 1px \(2\)/);
	assert.equal(codes('layout.theme-palette').length, 0, 'a custom palette no color pill uses is no app palette');
	assert.deepEqual(plan({ workbookTheme: false }).app.theme, { base: 'Clarion' });
	assert.deepEqual(plan({ theme: 'Midnight' }).app.theme.base, 'Midnight');
	assert.deepEqual(['Tableau Book', 'Georgia', 'Courier New', 'Arial Narrow', 'Rockwell', 'Benton Sans Book', 'Times New Roman'].map(themeFamily), ['Sans', 'Serif', 'Monospace', 'Condensed', 'Slab', 'Sans', 'Serif']);
	assert.deepEqual(['#fff', '#f9f9f9', '#00000000', '#00000080', 'red'].map(opaqueHex), ['#FFFFFF', '#F9F9F9', undefined, '#7F7F7F', undefined]);
	const zones = ['A', 'B', 'C'].map((name, i) => ({ id: String(i), kind: 'worksheet', worksheet: name, style: i < 2 ? { background: '#fafafa', border: { style: 'solid', width: 2, color: '#d4d4d4' } } : undefined }));
	assert.deepEqual(workbookTheme({ dashboards: [{ name: 'D', zones, floating: [] }] }, 'Clarion').overrides, { card: { background: '#FAFAFA', borderColor: '#D4D4D4', borderWidth: 2 } });
	assert.equal(workbookTheme({ dashboards: [{ name: 'D', zones: zones.slice(2), floating: [] }] }, 'Clarion').overrides, undefined);
});

test('the theme text color comes only from a neutral color most text shares, default-color text included', () => {
	const text = (...colors) => ({ id: '1', kind: 'text', text: 'x', runs: colors.map((color) => ({ text: 'note', ...(color ? { color } : {}) })) });
	const color = (...zones) => workbookTheme({ dashboards: [{ name: 'D', zones, floating: [] }] }, 'Clarion').overrides?.fontColor;
	assert.equal(color(text('#e15759')), undefined, 'a lone red note is an accent');
	assert.equal(color(text(undefined, undefined, '#333333')), undefined, 'default-color runs count');
	assert.equal(color(text('#000000', '#e15759')), undefined, 'a tie is no majority');
	assert.equal(color(text('#333333', '#333333'), { id: '2', kind: 'text', text: 'plain' }), '#333333');
	assert.equal(color(text('#333333'), { id: '2', kind: 'text', text: 'plain' }), undefined, 'a text zone without runs is default-color text');
	assert.equal(workbookTheme({ style: { defaults: { color: '#1f4e79' } }, dashboards: [{ name: 'D', zones: [text('#e15759')], floating: [] }] }, 'Clarion').overrides.fontColor, '#1F4E79', 'the workbook default color is kept');
});

test('target pages gets none of the app items, and the parser action issues stay', () => {
	const ir = fixtureIr();
	const pages = convertWorkbook(ir, { options: { target: 'pages' }, now: new Date(0) });
	const items = pages.pages.flatMap((pg) => pg.layout?.content ?? []);
	assert.ok(!items.some((i) => i.type === 'BUTTON' || i.type === 'TABS' || i.interaction));
	assert.ok(!pages.pages.some((pg) => pg.story));
	assert.ok(pages.issues.some((i) => i.code === 'twb.filter-action') && pages.issues.some((i) => i.code === 'twb.story'));
	const app = convertWorkbook(ir, { options: { target: 'app' }, now: new Date(0) });
	assert.ok(!app.issues.some((i) => /^twb\.(filter|url|highlight|navigation|parameter)-action$|^twb\.story$/.test(i.code)), 'the app reports actions and stories itself');
});

test('buildAppLayout without groups or buttons is buildLayout, so plain views do not change', () => {
	const entries = [{ content: { contentKey: 1, type: 'HEADER', text: 'x' }, placed: { contentKey: 1, type: 'HEADER', box: { x: 0, y: 0, width: 60, height: 5 }, order: 0 } }];
	const layout = buildAppLayout(entries);
	assert.deepEqual(layout.standard.template, [{ contentKey: 1, x: 0, y: 0, width: 60, height: 5, type: 'HEADER', virtual: false, virtualAppendix: false }]);
	assert.equal(layout.standard.template[0].children, undefined);
});

test('workbookTableStyle takes the most common crosstab look, Tableau defaults where a sheet sets none', async () => {
	const { sheetTableStyle, workbookTableStyle } = await import('../../src/convert/app-layout.js');
	const nested = { name: 'A', rowPills: ['r1', 'r2', 'm'], pills: { r1: {}, r2: {}, m: { continuous: true } } };
	assert.deepEqual(sheetTableStyle(nested), { rowColor: '#FFFFFF', bandColor: '#F5F5F5', totalColor: '#FFFFFF', subtotalColor: '#FFFFFF', totalTextColor: null, subtotalTextColor: null, borderType: 'HORIZONTAL', borderColor: '#CBCBCB' });
	const shaded = { ...nested, name: 'B', tableStyle: { totalBackground: '#00000000', subtotalBackground: '#d4d4d4' } };
	assert.deepEqual([sheetTableStyle(shaded).totalColor, sheetTableStyle(shaded).subtotalColor], ['#FFFFFF', '#D4D4D4'], 'None is the row color');
	const flat = { name: 'C', rowPills: ['r1'], pills: { r1: {} }, tableStyle: { rowBandSize: 0, rowDividers: false } };
	assert.deepEqual([sheetTableStyle(flat).bandColor, sheetTableStyle(flat).borderType, sheetTableStyle(flat).borderColor], [null, 'NONE', null]);
	assert.equal(sheetTableStyle({ rowPills: ['r1'], pills: { r1: {} } }).borderType, 'BELOW_HEADER');
	const ir = { worksheets: [shaded, flat, { ...flat, name: 'D' }] };
	const card = (worksheet, chartType = 'badge_basic_table') => ({ worksheet, chartType, pageKeys: ['v'] });
	const { table, issues } = workbookTableStyle(ir, [card('B'), card('C'), card('D'), card('D', 'badge_pivot_table'), { ...card('B'), pageKeys: [] }, card('A', 'badge_vert_bar')]);
	assert.equal(table.borderType, 'NONE', 'two of three crosstabs');
	assert.match(issues[0].message, /2 of the workbook's 3 crosstab/);
	assert.equal(workbookTableStyle(ir, [card('A', 'badge_vert_bar')]).table, undefined);
});
