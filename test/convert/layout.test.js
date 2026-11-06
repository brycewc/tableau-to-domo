import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TEXT_LINES, compactTemplate, controlHeight, dashboardPixels, filterCardFor, finishLayout, gridLayout, headerLines, labelSheet, minCardHeight, packControls, pageDefaultFilters, planPages, spreadWidths, tableauViewUrl, scaleRect, titleHeaderText, wrapText } from '../../src/convert/layout.js';
import { PLAIN_INTEGER_FORMAT, planCards } from '../../src/convert/cards.js';
import { dashboardFilterScopes } from '../../src/convert/filters.js';
import { tilingGaps } from '../../src/convert/tile.js';
import { DS, DATASET, p, sheet, workbook, makeBindings, cat } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const CATEGORY = p('none', 'Category');
const zone = (id, kind, rect, extra = {}) => ({ id, kind, rect, floating: false, ...extra });

function plan({ worksheets, dashboards, options = {}, name, columns = [] } = {}) {
	const ir = workbook({ worksheets, dashboards, name });
	ir.datasources[0] = { ...ir.datasources[0], fields: [...ir.datasources[0].fields, ...columns.map((c) => ({ id: `[${c}]`, name: c, datatype: 'string', role: 'dimension', kind: 'column' }))] };
	const bindings = makeBindings(Object.fromEntries(columns.map((c) => [`[${c}]`, { datasetKey: DATASET, kind: 'column', name: c, column: c, aggregated: false, dataType: 'STRING', tableauType: 'string' }])));
	const { cards } = planCards(ir, bindings, { options });
	const result = planPages(ir, cards, bindings, { options });
	return { ...result, worksheetCards: cards };
}

function keysOf(template) {
	return template.map((t) => t.contentKey).sort((a, b) => a - b);
}

test('dashboardPixels: fixed size, automatic defaults to 1200x800', () => {
	assert.deepEqual(dashboardPixels({ size: { mode: 'fixed', width: 1000, height: 800 } }), { width: 1000, height: 800 });
	assert.deepEqual(dashboardPixels({ size: { mode: 'automatic' } }), { width: 1200, height: 800 });
	assert.deepEqual(dashboardPixels({ size: { mode: 'range', width: 1400 } }), { width: 1400, height: 800 });
});

test('scaleRect: 60 columns, rows 1 / 1.67 of a column as App Studio draws them (1200x800 -> 66.8 rows)', () => {
	const px = { width: 1200, height: 800 };
	assert.deepEqual(scaleRect({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, px), { x: 30, y: 0, width: 30, height: 33 });
	assert.deepEqual(scaleRect({ x: 0, y: 0.25, w: 1, h: 0.75 }, px), { x: 0, y: 17, width: 60, height: 50 });
});

test('scaleRect: minimum width 5 (the editor\'s) and height 6, clamped to the grid', () => {
	const px = { width: 1200, height: 800 };
	assert.deepEqual(scaleRect({ x: 0.1, y: 0.1, w: 0.01, h: 0.01 }, px), { x: 6, y: 7, width: 5, height: 6 });
	assert.deepEqual(scaleRect({ x: 0.9, y: 0, w: 0.3, h: 0.5 }, px), { x: 42, y: 0, width: 18, height: 33 });
	assert.deepEqual(scaleRect({ x: 0, y: 0, w: 1.2, h: 0.5 }, px), { x: 0, y: 0, width: 60, height: 33 });
});

test('compactTemplate stacks full width in reading order with proportional heights at width 12', () => {
	const items = [
		{ contentKey: 2, type: 'CARD', box: { x: 30, y: 5, width: 30, height: 30 }, order: 1 },
		{ contentKey: 1, type: 'HEADER', box: { x: 0, y: 0, width: 60, height: 5 }, order: 0 },
		{ contentKey: 3, type: 'CARD', box: { x: 0, y: 5, width: 30, height: 20 }, order: 2 },
		{ contentKey: 4, type: 'CARD', box: { x: 0, y: 40, width: 4, height: 60 }, order: 3 }
	];
	assert.deepEqual(
		compactTemplate(items).map((t) => [t.contentKey, t.x, t.y, t.width, t.height]),
		[
			[1, 0, 0, 12, 2],
			[3, 0, 2, 12, 6],
			[2, 0, 8, 12, 7],
			[4, 0, 15, 12, 24]
		]
	);
});

test('root page plus one subpage per dashboard, with card and header items in both templates', () => {
	const s1 = sheet({ name: 'Sales', cols: CATEGORY, rows: SALES });
	const s2 = sheet({ name: 'Profit', cols: CATEGORY, rows: p('sum', 'Profit', 'qk') });
	const dash = {
		name: 'Overview',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('t', 'title', { x: 0, y: 0, w: 1, h: 0.1 }, { text: 'Overview' }),
			zone('a', 'worksheet', { x: 0, y: 0.1, w: 0.5, h: 0.9 }, { worksheet: 'Sales' }),
			zone('b', 'worksheet', { x: 0.5, y: 0.1, w: 0.5, h: 0.9 }, { worksheet: 'Profit' })
		],
		floating: []
	};
	const { pages, worksheetCards, cards } = plan({ worksheets: [s1, s2], dashboards: [dash], options: { pageTitle: 'Migrated' } });
	assert.equal(cards.length, 0);
	assert.deepEqual(
		pages.map((pg) => [pg.key, pg.title, pg.parentKey, pg.dashboard]),
		[
			['superstore', 'Migrated', undefined, ''],
			['superstore--overview', 'Overview', 'superstore', 'Overview']
		]
	);
	assert.equal(pages[0].layout, undefined);
	const layout = pages[1].layout;
	assert.deepEqual(layout.content[0], { contentKey: 1, type: 'HEADER', text: 'Overview' });
	assert.deepEqual(layout.content[1], {
		contentKey: 2,
		type: 'CARD',
		cardId: { $ref: 'card:sales' },
		acceptFilters: true,
		acceptDateFilter: true,
		acceptSegments: true,
		fitToFrame: false,
		hasSummary: false,
		hideBorder: false,
		hideFooter: true,
		hideMargins: false,
		hideSummary: false,
		hideTimeframe: false,
		hideTitle: false,
		hideDescription: true,
		hideWrench: false,
		summaryNumberOnly: false,
		editInAppViewer: true
	});
	assert.deepEqual([layout.standard.width, layout.standard.frameMargin, layout.standard.framePadding], [60, 4, 8]);
	assert.deepEqual([layout.compact.width, layout.compact.frameMargin, layout.compact.framePadding], [12, 4, 8]);
	assert.deepEqual(
		layout.standard.template.map((t) => [t.contentKey, t.type, t.x, t.y, t.width, t.height]),
		[
			[1, 'HEADER', 0, 0, 60, 5],
			[2, 'CARD', 0, 5, 30, 60],
			[3, 'CARD', 30, 5, 30, 60]
		],
		'the rows between the title and the cards close up'
	);
	assert.deepEqual(keysOf(layout.compact.template), [1, 2, 3]);
	assert.deepEqual(
		worksheetCards.map((c) => c.pageKeys),
		[['superstore--overview'], ['superstore--overview']]
	);
});

test('a worksheet zone that hides its title gives its card item a hidden title', () => {
	const s1 = sheet({ name: 'Sales', cols: CATEGORY, rows: SALES });
	const s2 = sheet({ name: 'Profit', cols: CATEGORY, rows: p('sum', 'Profit', 'qk') });
	const dash = {
		name: 'Overview',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('a', 'worksheet', { x: 0, y: 0, w: 0.5, h: 1 }, { worksheet: 'Sales', showTitle: false }), zone('b', 'worksheet', { x: 0.5, y: 0, w: 0.5, h: 1 }, { worksheet: 'Profit' })],
		floating: []
	};
	const { pages } = plan({ worksheets: [s1, s2], dashboards: [dash] });
	const items = pages[1].layout.content.filter((c) => c.type === 'CARD');
	assert.deepEqual(items.map((c) => [c.cardId.$ref, c.hideTitle]), [['card:sales', true], ['card:profit', false]]);
});

test('no dashboards: all cards on the root page in a 2-column grid', () => {
	const sheets = ['A', 'B', 'C'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));
	const { pages, worksheetCards } = plan({ worksheets: sheets, name: 'Book' });
	assert.equal(pages.length, 1);
	assert.equal(pages[0].title, 'Book');
	assert.deepEqual(
		pages[0].layout.standard.template.map((t) => [t.x, t.y, t.width, t.height]),
		[
			[0, 0, 30, 30],
			[30, 0, 30, 30],
			[0, 30, 60, 30]
		],
		'the odd last card fills its row'
	);
	assert.deepEqual(
		pages[0].layout.compact.template.map((t) => [t.y, t.width, t.height]),
		[
			[0, 12, 7],
			[7, 12, 7],
			[14, 12, 6]
		]
	);
	assert.ok(worksheetCards.every((c) => c.pageKeys[0] === 'book'));
});

test('standalone worksheets not on any dashboard go to the root page', () => {
	const a = sheet({ name: 'On Dash', cols: CATEGORY, rows: SALES });
	const b = sheet({ name: 'Loose', cols: CATEGORY, rows: SALES });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 1 }, { worksheet: 'On Dash' })], floating: [] };
	const { pages, issues } = plan({ worksheets: [a, b], dashboards: [dash] });
	assert.deepEqual(
		pages[0].layout.content.map((c) => c.cardId.$ref),
		['card:loose']
	);
	assert.ok(issues.some((i) => i.code === 'layout.standalone-sheets'));
});

test('items no row or column line separates stack in reading order, full width', () => {
	const sheets = ['A', 'B', 'F'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 0.6, h: 0.5 }, { worksheet: 'A' }), zone('2', 'worksheet', { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }, { worksheet: 'B' })],
		floating: [{ ...zone('3', 'worksheet', { x: 0.7, y: 0.05, w: 0.25, h: 0.2 }, { worksheet: 'F' }), floating: true }]
	};
	const { pages, issues } = plan({ worksheets: sheets, dashboards: [dash] });
	const t = pages[1].layout.standard.template.map((x) => [x.contentKey, x.x, x.y, x.width, x.height]);
	assert.deepEqual(t, [
		[1, 0, 0, 60, 33],
		[3, 0, 33, 60, 16],
		[2, 0, 49, 60, 33]
	]);
	assert.match(issues.find((i) => i.code === 'layout.floating').message, /^1 floating item\(s\) placed in the tiled layout at their position$/);
});

test('a floating title over a dropped image is the top row; a floating item over tiled items gets a row of its own there', () => {
	const sheets = ['Chart', 'Other', 'Note'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));
	const floating = (id, kind, rect, extra) => ({ ...zone(id, kind, rect, extra), floating: true });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('b', 'image', { x: 0, y: 0, w: 1, h: 0.1 }), zone('c', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.4 }, { worksheet: 'Chart' }), zone('d', 'worksheet', { x: 0, y: 0.5, w: 1, h: 0.5 }, { worksheet: 'Other' })],
		floating: [floating('t', 'text', { x: 0.3, y: 0.03, w: 0.4, h: 0.04 }, { text: 'Bookings Report' }), floating('n', 'worksheet', { x: 0.6, y: 0.45, w: 0.3, h: 0.2 }, { worksheet: 'Note' })]
	};
	const { pages, issues } = plan({ worksheets: sheets, dashboards: [dash], options: { target: 'app' } });
	assert.deepEqual(pages[0].layout.style, { density: { standard: 0 }, margin: { standard: { top: 0, bottom: 0, left: 0, right: 0 } } }, 'the view spacing the user set on SalesReview Bookings');
	assert.equal(plan({ worksheets: sheets, dashboards: [dash], options: { target: 'pages' } }).pages[1].layout.style, undefined);
	const { content, standard } = pages[0].layout;
	const of = (t) => content.find((c) => c.contentKey === t.contentKey);
	assert.deepEqual(standard.template.map((t) => [t.type, of(t).text ?? of(t).cardId.$ref, t.x, t.width]), [
		['HEADER', 'Bookings Report', 0, 60],
		['CARD', 'card:chart', 0, 60],
		['CARD', 'card:note', 0, 60],
		['CARD', 'card:other', 0, 60]
	]);
	assert.equal(standard.template[0].y, 0, 'the header is at the top, not below the tiled layout');
	assert.match(issues.find((i) => i.code === 'layout.floating').message, /2 floating item\(s\).*1 of them sat over other items/);
	assert.deepEqual(tilingGaps(standard.template, 60), { empty: 0, overlapping: 0 });
});

test('in an app, a relative date filter control is the view date control default, not a filter card', () => {
	const shipped = { pillId: p('none', 'Ship Date', 'qk'), datasourceId: DS, fieldId: '[Ship Date]', kind: 'relative-date', relative: { periodType: 'quarter', first: -1, last: 0 } };
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [shipped] });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 0.8, h: 1 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0.8, y: 0, w: 0.2, h: 0.2 }, { worksheet: 'S', param: shipped.pillId })], floating: [] };
	const { pages, cards, issues } = plan({ worksheets: [s], dashboards: [dash], options: { target: 'app' } });
	assert.deepEqual(pages[0].dateRange, { dateTimeRangeType: 'ROLLING_PERIOD', interval: 'QUARTER', count: 2, offset: 0 });
	assert.ok(!cards.some((c) => /selector/.test(c.chartType)));
	assert.ok(issues.some((i) => i.code === 'layout.date-range'));
});

test('filter zones become filter cards placed in the layout, reused across dashboards', () => {
	const region = cat('Region', ['East']);
	const date = { pillId: p('none', 'Order Date', 'qk'), datasourceId: DS, fieldId: '[Order Date]', kind: 'range-date', min: '2023-01-01', max: '2023-12-31' };
	const qty = { pillId: p('none', 'Quantity', 'qk'), datasourceId: DS, fieldId: '[Quantity]', kind: 'quantitative', min: 1, max: 9 };
	const shipped = { pillId: p('none', 'Ship Date', 'qk'), datasourceId: DS, fieldId: '[Ship Date]', kind: 'relative-date', relative: { period: 'month', last: 3 } };
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region, date, qty, shipped] });
	const mk = (name, mode) => ({
		name,
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0, w: 0.8, h: 1 }, { worksheet: 'S' }),
			zone('2', 'filter', { x: 0.8, y: 0, w: 0.2, h: 0.2 }, { worksheet: 'S', param: region.pillId, mode }),
			zone('3', 'filter', { x: 0.8, y: 0.2, w: 0.2, h: 0.2 }, { worksheet: 'S', param: date.pillId, mode: 'slider' }),
			zone('4', 'filter', { x: 0.8, y: 0.4, w: 0.2, h: 0.2 }, { worksheet: 'S', param: qty.pillId, mode: 'slider' }),
			zone('5', 'filter', { x: 0.8, y: 0.6, w: 0.2, h: 0.2 }, { worksheet: 'S', param: shipped.pillId })
		],
		floating: []
	});
	const { pages, cards, issues } = plan({ worksheets: [s], dashboards: [mk('D1', 'checklist'), mk('D2', 'checklist')] });
	assert.deepEqual(
		cards.map((c) => [c.chartType, c.worksheet, c.pageKeys]),
		[
			['badge_checkbox_selector', '', ['superstore--d1', 'superstore--d2']],
			['badge_range_selector', '', ['superstore--d1', 'superstore--d2']],
			['badge_range_selector', '', ['superstore--d1', 'superstore--d2']],
			['badge_date_selector', '', ['superstore--d1', 'superstore--d2']]
		]
	);
	const checkbox = cards[0].body.definition;
	assert.equal(checkbox.chartVersion, '12');
	assert.deepEqual(checkbox.subscriptions.main.columns, [{ column: 'Region', mapping: 'ITEM' }]);
	assert.deepEqual(checkbox.subscriptions.main.groupBy, [{ column: 'Region' }]);
	assert.deepEqual(checkbox.subscriptions.main.orderBy, [{ column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'ASCENDING' }], 'a list sorts by its own column (the user\'s FYQ card on SalesReview Bookings), text in natural order');
	assert.deepEqual(
		checkbox.formulas.card.map((f) => [f.name, f.formula, f.aggregated]),
		[['Region (natural order)', "REGEXP_REPLACE(REGEXP_REPLACE(MIN(`Region`), '[0-9]+', '0000000000$0'), '0*([0-9]{10})', '$1')", true]],
		'"2023 P7" before "2023 P10"; the key of MIN(Region) is one match per listed value'
	);
	assert.deepEqual(cards[1].body.definition.subscriptions.main.orderBy, [], 'a range selector reads MIN and MAX and needs no sort');
	assert.deepEqual(cards[2].body.definition.formulas.card, []);
	assert.deepEqual(cards[1].body.definition.subscriptions.main.columns, [
		{ column: 'Order Date', mapping: 'MIN', aggregation: 'MIN' },
		{ column: 'Order Date', mapping: 'MAX', aggregation: 'MAX' }
	], 'a range of dates is a range selector on the date column');
	assert.match(cards[1].key, /-order-date-range$/);
	assert.deepEqual(cards[2].body.definition.subscriptions.main.columns, [
		{ column: 'Quantity', mapping: 'MIN', aggregation: 'MIN' },
		{ column: 'Quantity', mapping: 'MAX', aggregation: 'MAX' }
	]);
	const dateCard = cards[3].body.definition.subscriptions.main;
	assert.deepEqual(dateCard.columns, [
		{ column: 'Date', mapping: 'ITEM', calendar: true },
		{ column: 'Ship Date', mapping: 'VALUE', aggregation: 'COUNT' }
	], 'a relative date filter is a date selector');
	assert.deepEqual(dateCard.dateGrain, { column: 'Ship Date', dateTimeElement: 'DAY' });
	const layout = pages[1].layout;
	assert.equal(layout.content.length, 5);
	assert.deepEqual(
		layout.content.slice(1).map((c) => c.cardId.$ref),
		cards.map((c) => `card:${c.key}`)
	);
	assert.deepEqual(keysOf(layout.standard.template), [1, 2, 3, 4, 5]);
	assert.deepEqual(keysOf(layout.compact.template), [1, 2, 3, 4, 5]);
	assert.ok(issues.some((i) => i.code === 'layout.filter-default'));
	assert.equal(cards[0].datasetKey, DATASET);
});

test('pageDefaultFilters: quick filter selections every card on the dataset carries become the view defaults; others stay on their cards', () => {
	const fy = (v) => ({ column: 'FY', name: 'FY', dataType: 'numeric', operand: 'IN', values: [v] });
	const deal = { column: 'calculation_deal', formulaId: 'calculation_deal', name: 'Deal Reg', dataType: 'string', operand: 'IN', values: ['Yes'] };
	const control = (column) => ({ controlType: 'SLICER', column, values: [] });
	const card = (key, pageKeys, defaults, extra = {}) => ({ key, worksheet: key, datasetKey: 'ds', pageKeys, status: 'ok', body: { definition: { controls: defaults.map((d) => control(d.column)) } }, ...(defaults.length ? { quickFilterDefaults: defaults } : {}), ...extra });
	const filterCard = { key: 'fy-filter', worksheet: '', datasetKey: 'ds', pageKeys: ['p1', 'p2', 'p3'], status: 'ok', body: { definition: { subscriptions: { main: { columns: [{ column: 'FY', mapping: 'ITEM' }] } } } } };
	const lost = { column: 'calculation_gone', formulaId: 'calculation_gone', name: 'Gone', dataType: 'string', operand: 'IN', values: ['x'] };
	const cards = [card('A', ['p1', 'p2', 'p3'], [fy('2026'), deal]), card('B', ['p1'], []), card('C', ['p2'], [fy('2025')]), card('D', ['p4'], [lost]), card('U', ['p3'], [fy('1999')], { status: 'unsupported' }), filterCard];
	const pages = ['p1', 'p2', 'p3', 'p4'].map((key) => ({ key, title: key, dashboard: key }));
	const issues = pageDefaultFilters(pages, cards, { beastModes: [{ legacyId: 'calculation_deal', name: 'Deal Reg (calc)' }] });
	const ds = { $ref: 'dataset:ds' };
	const f = (column, values, dataType, extra) => ({ column, dataType, operand: 'IN', values, filterType: 'LEGACY', dataSourceId: ds, ...extra });
	assert.deepEqual(pages[2].filters, [f('FY', ['2026'], 'numeric', { sourceCard: 'fy-filter' }), f('Deal Reg (calc)', ['Yes'], 'string')], 'every card on the dataset has them: they reach the whole view, beast modes by name');
	assert.equal(pages[0].filters, undefined, 'card B has no default, and a page filter would reach it');
	assert.equal(pages[1].filters, undefined, 'cards A and C select different years');
	assert.equal(pages[3].filters, undefined);
	assert.deepEqual(cards.slice(0, 4).map((c) => c.body.definition.controls.map((x) => x.values)), [[['2026'], ['Yes']], [], [['2025']], [['x']]], 'those stay the defaults of the card quick filters');
	assert.ok(issues.some((i) => i.code === 'layout.page-default-partial' && /2026 on 1 card\(s\); 2025 on 1 card\(s\)/.test(i.message)));
	assert.ok(issues.some((i) => i.code === 'layout.page-default' && i.severity === 'warning' && /Gone/.test(i.message)));
});

test('pageDefaultFilters: a dashboard-only selection with no quick filter is a fixed card filter only where no view takes it', () => {
	const fixed = [{ column: 'FY', filterType: 'COLUMN_ID', operand: 'IN', values: ['2026'], dataType: 'numeric' }];
	const fy = (v) => ({ column: 'FY', name: 'FY', dataType: 'numeric', operand: 'IN', values: [v], fixed: v === '2026' ? fixed : [{ ...fixed[0], values: [v] }] });
	const card = (key, pageKeys, d) => ({ key, worksheet: key, datasetKey: 'ds', pageKeys, status: 'ok', body: { definition: { controls: [], subscriptions: { main: { filters: [] } } } }, quickFilterDefaults: [d] });
	const cards = [card('A', ['p1'], fy('2026')), card('B', ['p2'], fy('2026')), card('C', ['p2'], fy('2025'))];
	const pages = ['p1', 'p2'].map((key) => ({ key, title: key, dashboard: key }));
	pageDefaultFilters(pages, cards);
	assert.deepEqual(pages[0].filters.map((f) => f.values), [['2026']]);
	assert.equal(pages[1].filters, undefined);
	assert.deepEqual(cards.map((c) => c.body.definition.subscriptions.main.filters.map((f) => f.values)), [[], [['2026']], [['2025']]], 'the view default replaces the fixed filter; a selection left on the cards is fixed again');
	assert.ok(cards.every((c) => !('fixed' in c.quickFilterDefaults[0])));
});

test('quick filter defaults of a dashboard reach its view as page filters', () => {
	const region = cat('Region', ['East', 'West']);
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region] });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.8 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0, y: 0.8, w: 0.2, h: 0.1 }, { worksheet: 'S', param: region.pillId, mode: 'checkdropdown' })], floating: [] };
	const { pages, cards, worksheetCards } = plan({ worksheets: [s], dashboards: [dash] });
	pageDefaultFilters(pages, [...worksheetCards, ...cards]);
	assert.deepEqual(pages[1].filters, [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], filterType: 'LEGACY', dataSourceId: { $ref: `dataset:${DATASET}` }, sourceCard: cards[0].key }]);
	assert.deepEqual(worksheetCards[0].body.definition.controls[0].values, []);
});

function scopedPlan({ worksheets, dashboards, irVersion = 13 }) {
	const ir = { ...workbook({ worksheets, dashboards }), irVersion };
	const bindings = makeBindings();
	const scopes = dashboardFilterScopes(ir);
	const { cards: worksheetCards } = planCards(ir, bindings, { scopes });
	const { pages, cards } = planPages(ir, worksheetCards, bindings, {});
	const issues = pageDefaultFilters(pages, [...worksheetCards, ...cards], { scopes });
	const card = (name) => worksheetCards.find((c) => c.worksheet === name);
	const fixed = (name) => card(name).body.definition.subscriptions.main.filters.map((f) => [f.column, f.values]);
	const control = (name) => (card(name).body.definition.controls ?? []).map((c) => [c.column, c.values]);
	return { pages, cards, worksheetCards, issues, card, fixed, control };
}

const dashOf = (name, sheets, zoneSheet, param) => ({
	name,
	size: { mode: 'automatic' },
	zones: [...sheets.map((s, i) => zone(String(i + 1), 'worksheet', { x: i / sheets.length, y: 0, w: 1 / sheets.length, h: 0.8 }, { worksheet: s })), ...(zoneSheet ? [zone('9', 'filter', { x: 0, y: 0.8, w: 0.2, h: 0.1 }, { worksheet: zoneSheet, param, mode: 'checkdropdown' })] : [])],
	floating: []
});

test('filter scope: a filter-group shared by every card on the dataset is the view default, and the peer copies go', () => {
	const region = cat('Region', ['East', 'West'], { group: '4' });
	const a = sheet({ name: 'A', cols: CATEGORY, rows: SALES, filters: [region] });
	const b = sheet({ name: 'B', cols: CATEGORY, rows: SALES, filters: [{ ...region }] });
	const { pages, fixed, control, cards, worksheetCards } = scopedPlan({ worksheets: [a, b], dashboards: [dashOf('D', ['A', 'B'], 'A', region.pillId)] });
	const view = pages.find((pg) => pg.dashboard === 'D');
	assert.deepEqual(view.filters, [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], filterType: 'LEGACY', dataSourceId: { $ref: `dataset:${DATASET}` }, sourceCard: cards[0].key }]);
	assert.deepEqual([control('A'), fixed('B')], [[['Region', []]], []], 'the control starts empty and B keeps no fixed copy');
	assert.ok(worksheetCards.every((c) => !('scopedFilters' in c)), 'the scope tags stay out of the plan');
});

test('filter scope: a shared-view filter on four sheets, shown for one, is the view default; every copy goes', () => {
	const product = cat('Category', ['Tech'], { shared: DS });
	const names = ['M1', 'M2', 'M3', 'M4'];
	const sheets = names.map((name) => sheet({ name, cols: CATEGORY, rows: SALES, filters: [{ ...product }] }));
	const { pages, fixed, control } = scopedPlan({ worksheets: sheets, dashboards: [dashOf('D', names, 'M1', product.pillId)] });
	assert.deepEqual(pages.find((pg) => pg.dashboard === 'D').filters.map((f) => [f.column, f.values, f.affectedCards]), [['Category', ['Tech'], undefined]]);
	assert.deepEqual(names.slice(1).map(fixed), [[], [], []]);
	assert.deepEqual(control('M1'), [['Category', []]]);
});

test('filter scope: a group that leaves out a card is the view default with its filter card scoped to the other cards', () => {
	const date = cat('Region', ["26'Q2"], { group: '5' });
	const map = sheet({ name: 'Map', cols: CATEGORY, rows: SALES, filters: [date] });
	const bar = sheet({ name: 'Bar', cols: CATEGORY, rows: SALES, filters: [{ ...date }] });
	const yoy = sheet({ name: 'YOY', cols: CATEGORY, rows: SALES, filters: [cat('Region', ["21'Q1", "21'Q2"])] });
	const { pages, cards, card, fixed, control, issues } = scopedPlan({ worksheets: [map, bar, yoy], dashboards: [dashOf('D', ['Map', 'Bar', 'YOY'], 'Map', date.pillId)] });
	const view = pages.find((pg) => pg.dashboard === 'D');
	const filterCard = cards.find((c) => c.title === 'Region');
	const keys = [card('Map').key, card('Bar').key, filterCard.key];
	assert.deepEqual(view.filters, [{ column: 'Region', dataType: 'string', operand: 'IN', values: ["26'Q2"], filterType: 'LEGACY', dataSourceId: { $ref: `dataset:${DATASET}` }, sourceCard: filterCard.key, affectedCards: keys }]);
	const item = view.layout.content.find((c) => c.cardId?.$ref === `card:${filterCard.key}`);
	assert.deepEqual(item.interaction, { type: 'STANDARD', config: { openInNewWindow: false, allowCardToCardInteractions: true, selectIndividualCards: true, selectedCardUrns: keys.map((k) => ({ $ref: `card:${k}`, field: 'urn' })) } }, 'every card of the view but YOY, the filter card itself included');
	assert.deepEqual([control('Map'), fixed('Bar'), fixed('YOY')], [[['Region', []]], [], [['Region', ["21'Q1", "21'Q2"]]]]);
	assert.ok(issues.some((i) => i.code === 'layout.page-default-scope' && /applies to .*Bar.* but not YOY/.test(i.message)));
});

test('filter scope: a partial scope with no filter card to scope keeps the selection on the cards', () => {
	const date = cat('Region', ["26'Q2"], { group: '5' });
	const worksheets = [sheet({ name: 'Map', cols: CATEGORY, rows: SALES, filters: [date] }), sheet({ name: 'Bar', cols: CATEGORY, rows: SALES, filters: [{ ...date }] }), sheet({ name: 'YOY', cols: CATEGORY, rows: SALES })];
	const ir = { ...workbook({ worksheets, dashboards: [dashOf('D', ['Map', 'Bar', 'YOY'], 'Map', date.pillId)] }), irVersion: 13 };
	const bindings = makeBindings();
	const scopes = dashboardFilterScopes(ir);
	const { cards: worksheetCards } = planCards(ir, bindings, { scopes });
	const { pages, cards } = planPages(ir, worksheetCards, bindings, {});
	const view = pages.find((pg) => pg.dashboard === 'D');
	const filterKeys = new Set(cards.filter((c) => !c.worksheet).map((c) => `card:${c.key}`));
	view.layout.content = view.layout.content.filter((c) => !filterKeys.has(c.cardId?.$ref));
	const issues = pageDefaultFilters(pages, [...worksheetCards, ...cards], { scopes });
	const card = (name) => worksheetCards.find((c) => c.worksheet === name);
	assert.equal(view.filters, undefined);
	assert.deepEqual(card('Map').body.definition.controls.map((c) => c.values), [["26'Q2"]]);
	assert.deepEqual(card('Bar').body.definition.subscriptions.main.filters.map((f) => f.values), [["26'Q2"]]);
	assert.ok(issues.some((i) => i.code === 'layout.page-default-partial' && i.severity === 'warning' && /not YOY/.test(i.message)));
});

test('filter scope: a card on two views keeps its fixed copy unless every view promoted the filter', () => {
	const region = cat('Region', ['East'], { group: '4' });
	const a = sheet({ name: 'A', cols: CATEGORY, rows: SALES, filters: [region] });
	const b = sheet({ name: 'B', cols: CATEGORY, rows: SALES, filters: [{ ...region }] });
	const { pages, fixed } = scopedPlan({ worksheets: [a, b], dashboards: [dashOf('D1', ['A', 'B'], 'A', region.pillId), dashOf('D2', ['B'])] });
	assert.deepEqual(pages.find((pg) => pg.dashboard === 'D1').filters.map((f) => f.values), [['East']]);
	assert.deepEqual(fixed('B'), [['Region', ['East']]], 'D2 has no default, so B keeps the selection there');
});

test('filter scope: a selection over 50 values stays a fixed filter on every card; an ir.json before 13 keeps the card defaults', () => {
	const many = Array.from({ length: 60 }, (_, i) => `R${i}`);
	const big = cat('Region', many, { group: '4' });
	const a = sheet({ name: 'A', cols: CATEGORY, rows: SALES, filters: [big] });
	const b = sheet({ name: 'B', cols: CATEGORY, rows: SALES, filters: [{ ...big }] });
	const over = scopedPlan({ worksheets: [a, b], dashboards: [dashOf('D', ['A', 'B'], 'A', big.pillId)] });
	assert.equal(over.pages.find((pg) => pg.dashboard === 'D').filters, undefined);
	assert.deepEqual([over.fixed('A').length, over.fixed('B').length], [1, 1]);
	const region = cat('Region', ['East'], { group: '4' });
	const old = scopedPlan({ irVersion: 12, worksheets: [sheet({ name: 'A', cols: CATEGORY, rows: SALES, filters: [region] }), sheet({ name: 'B', cols: CATEGORY, rows: SALES, filters: [{ ...region }] })], dashboards: [dashOf('D', ['A', 'B'], 'A', region.pillId)] });
	assert.equal(old.pages.find((pg) => pg.dashboard === 'D').filters, undefined);
	assert.deepEqual([old.control('A'), old.fixed('B')], [[['Region', ['East']]], [['Region', ['East']]]]);
	assert.ok(old.issues.some((i) => i.code === 'layout.page-default-partial'));
});

test('pageDefaultFilters: each dataset of a view gets its own default for a column both have', () => {
	const fy = { column: 'FY', name: 'FY', dataType: 'numeric', operand: 'IN', values: ['2026'] };
	const card = (key, datasetKey) => ({ key, worksheet: key, datasetKey, pageKeys: ['p'], status: 'ok', body: { definition: { controls: [{ column: 'FY', values: [] }] } }, quickFilterDefaults: [fy] });
	const pages = [{ key: 'p', title: 'P', dashboard: 'P' }];
	pageDefaultFilters(pages, [card('A', 'one'), card('B', 'two')]);
	assert.deepEqual(pages[0].filters.map((f) => f.dataSourceId.$ref), ['dataset:one', 'dataset:two']);
});

test('filter cards take the page filters, have presentation mode off and no table drill; an integer dimension has no separators', () => {
	const region = cat('Region', ['East'], { all: true });
	const segment = { ...cat('Segment', ['A'], { all: true }), context: true };
	const category = cat('Fiscal Year', [2026], { all: true });
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region, segment, category] });
	const dash = {
		name: 'D',
		size: { mode: 'automatic' },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.7 }, { worksheet: 'S' }),
			zone('2', 'filter', { x: 0, y: 0.7, w: 0.2, h: 0.1 }, { worksheet: 'S', param: region.pillId, mode: 'checkdropdown', values: 'database' }),
			zone('3', 'filter', { x: 0.2, y: 0.7, w: 0.2, h: 0.1 }, { worksheet: 'S', param: segment.pillId, mode: 'checkdropdown', values: 'relevant' }),
			zone('4', 'filter', { x: 0.4, y: 0.7, w: 0.2, h: 0.1 }, { worksheet: 'S', param: category.pillId, mode: 'checkdropdown', values: 'relevant' })
		],
		floating: []
	};
	const { pages, cards } = plan({ worksheets: [s], dashboards: [dash] });
	const item = (field) => pages[1].layout.content.find((c) => c.cardId?.$ref === `card:${cards.find((x) => x.title === field).key}`);
	const names = ['Region', 'Segment', 'Fiscal Year'];
	assert.deepEqual(names.map((n) => [item(n).acceptFilters, item(n).hideWrench]), names.map(() => [true, true]), 'whatever Tableau lists; "Presentation mode" unchecked is hideWrench');
	assert.deepEqual(cards.map((c) => c.body.definition.allowTableDrill), [false, false, false]);
	const year = cards.find((c) => c.title === 'Fiscal Year').body.definition.subscriptions.main.columns;
	assert.deepEqual(year, [{ column: 'Fiscal Year', mapping: 'ITEM', format: PLAIN_INTEGER_FORMAT }]);
	assert.equal(cards.find((c) => c.title === 'Region').body.definition.subscriptions.main.columns[0].format, undefined);
});

test("a filter card on a field with a Tableau number format shows it in Domo's column format", () => {
	const store = cat('Store Number', [1], { all: true });
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [store] });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.8 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0, y: 0.8, w: 0.2, h: 0.1 }, { worksheet: 'S', param: store.pillId, mode: 'checkdropdown' })], floating: [] };
	const { cards } = plan({ worksheets: [s], dashboards: [dash] });
	assert.deepEqual(cards[0].body.definition.subscriptions.main.columns, [{ column: 'Store Number', mapping: 'ITEM', format: { type: 'number', format: '###,###', commas: true, percentMultiplied: true, precision: 0, abbreviate: false } }]);
});

test('a quick filter selection with the Null member is no default: Domo cannot keep the null rows Tableau keeps', () => {
	const region = cat('Region', [null, 'East', 'West']);
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region] });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.8 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0, y: 0.8, w: 0.2, h: 0.1 }, { worksheet: 'S', param: region.pillId, mode: 'checkdropdown' })], floating: [] };
	const { pages, cards, worksheetCards } = plan({ worksheets: [s], dashboards: [dash] });
	pageDefaultFilters(pages, [...worksheetCards, ...cards]);
	assert.equal(pages[1].filters, undefined);
	assert.equal(worksheetCards[0].quickFilterDefaults, undefined);
	assert.deepEqual(worksheetCards[0].body.definition.subscriptions.main.filters, [], 'and no fixed card filter either');
});

test('dropdown, radio and default list modes pick the matching selector', () => {
	const region = cat('Region', ['East'], { all: true });
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region] });
	for (const [mode, type] of [
		['dropdown', 'badge_dropdown_selector'],
		['checkdropdown', 'badge_dropdown_selector'],
		['radiolist', 'badge_radio_selector'],
		[undefined, 'badge_checkbox_selector']
	]) {
		const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 1 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0, y: 0, w: 0.2, h: 0.1 }, { worksheet: 'S', param: region.pillId, mode })], floating: [] };
		const [card] = plan({ worksheets: [s], dashboards: [dash] }).cards;
		assert.equal(card.chartType, type, String(mode));
		assert.deepEqual(card.body.definition.charts.main.overrides, mode === 'checkdropdown' ? { allow_multi_select: 'true' } : {}, `${mode}: Tableau's multiple values dropdown; no mode is its default multiple values list`);
	}
});

test('a filter zone on an aggregate is a filter card on an aggregated dataset beast mode at its worksheet\'s marks, scoped to its sheets', () => {
	const sumSales = { pillId: SALES, datasourceId: DS, fieldId: '[Sales]', kind: 'quantitative', aggregated: true, includedValues: 'all' };
	const ratioPill = p('usr', 'Profit Ratio', 'qk');
	const ratio = { pillId: ratioPill, datasourceId: DS, fieldId: '[Profit Ratio]', kind: 'quantitative', aggregated: true, includedValues: 'all' };
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [sumSales, ratio, cat('Region', ['East'])] });
	const t = sheet({ name: 'T', cols: CATEGORY, rows: p('sum', 'Profit', 'qk') });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0, w: 0.4, h: 1 }, { worksheet: 'S' }),
			zone('2', 'worksheet', { x: 0.4, y: 0, w: 0.4, h: 1 }, { worksheet: 'T' }),
			zone('3', 'filter', { x: 0.8, y: 0, w: 0.2, h: 0.2 }, { worksheet: 'S', param: SALES }),
			zone('4', 'filter', { x: 0.8, y: 0.2, w: 0.2, h: 0.2 }, { worksheet: 'S', param: ratioPill })
		],
		floating: []
	};
	const { pages, cards, beastModes, issues, worksheetCards } = plan({ worksheets: [s, t], dashboards: [dash] });
	assert.equal(issues.filter((i) => i.code === 'layout.filter-aggregate').length, 0);
	assert.deepEqual(beastModes.map((bm) => [bm.name, bm.expression, bm.aggregated, bm.datasetKey]), [['SUM(Sales)', 'SUM(`Sales`)', true, DATASET]]);
	const [sum, own] = cards;
	assert.equal(sum.chartType, 'badge_range_selector');
	assert.equal(sum.title, 'SUM(Sales)');
	const main = sum.body.definition.subscriptions.main;
	const id = beastModes[0].legacyId;
	assert.deepEqual(main.columns, [{ column: id, formulaId: id, mapping: 'MIN' }, { column: id, formulaId: id, mapping: 'MAX' }], 'no column aggregation: the page filter it emits would drop it');
	const sheetMain = worksheetCards.find((c) => c.worksheet === 'S').body.definition.subscriptions.main;
	assert.deepEqual(main.groupBy, sheetMain.groupBy, 'the range is over the worksheet\'s marks');
	assert.deepEqual(main.filters, sheetMain.filters);
	assert.deepEqual(own.body.definition.subscriptions.main.columns.map((c) => c.column), ['calculation_pr', 'calculation_pr'], 'an aggregated calc selects on its own beast mode');
	const items = pages[1].layout.content.filter((c) => c.type === 'CARD');
	const sKey = worksheetCards.find((c) => c.worksheet === 'S').key;
	for (const card of [sum, own]) {
		const item = items.find((c) => c.cardId.$ref === `card:${card.key}`);
		const urns = item.interaction.config.selectedCardUrns.map((u) => u.$ref);
		assert.deepEqual(urns, [`card:${sKey}`], 'not T, outside the Tableau filter\'s scope, nor the other filter cards, whose lists it would empty');
	}
	assert.ok(issues.some((i) => i.code === 'layout.filter-aggregate-scope'));
});

test('a filter zone on a table calculation has no filter card', () => {
	const pill = '[ds].[pcto:sum:Sales:qk]';
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [{ pillId: pill, datasourceId: DS, fieldId: '[Sales]', kind: 'quantitative', aggregated: true, min: 0.1 }] });
	s.pills[pill] = { ...s.pills[pill], tableCalc: { type: 'PctTotal' } };
	const dash = { name: 'D', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 0.8, h: 1 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0.8, y: 0, w: 0.2, h: 0.2 }, { worksheet: 'S', param: pill })], floating: [] };
	const filter = s.filters[0];
	const binding = makeBindings().get(DS, '[Sales]');
	const result = filterCardFor(dash.zones[1], { ...filter, pillId: '[ds].[sum:Sales:qk]', aggregated: true }, { ...binding, expression: 'SUM(`Sales`) OVER ()' }, DATASET, dash, 'wb');
	assert.equal(result.card, undefined);
	assert.match(result.issues[0].message, /table calculation Sales/);
	assert.equal(result.issues[0].code, 'layout.filter-aggregate');
});

test('zones Tableau never draws, in a container with no height, are left out without an issue', () => {
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [cat('Region', ['East'])] });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0, w: 0.8, h: 1 }, { worksheet: 'S', parent: '9' }),
			zone('2', 'filter', { x: 0.8, y: 0, w: 0.2, h: 0.2 }, { worksheet: 'S', param: p('none', 'Region'), parent: '11' }),
			zone('3', 'text', { x: 0.8, y: 0.5, w: 0, h: 0.2 }, { text: 'gone', parent: '9' })
		],
		containers: [
			{ id: '9', layout: 'basic', rect: { x: 0, y: 0, w: 1, h: 1 } },
			{ id: '10', layout: 'basic', rect: { x: 0.8, y: 0.6, w: 0.2, h: 0 }, parent: '9' },
			{ id: '11', layout: 'flow', rect: { x: 0.8, y: 0.58, w: 0.2, h: 0.03 }, parent: '10' }
		],
		floating: []
	};
	const { pages, cards, issues } = plan({ worksheets: [s], dashboards: [dash] });
	assert.deepEqual(cards, [], 'no filter card for the hidden Region zone');
	assert.deepEqual(pages[1].layout.content.map((c) => c.type), ['CARD']);
	assert.ok(!issues.some((i) => /Region|gone/.test(i.message ?? '') && i.code.startsWith('layout.')));
});

test('createFilterCards false turns filter zones into page filter defaults', () => {
	const region = cat('Region', ['East', 'West']);
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region] });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 1 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0, y: 0, w: 0.2, h: 0.1 }, { worksheet: 'S', param: region.pillId, mode: 'checklist' })], floating: [] };
	const { pages, cards } = plan({ worksheets: [s], dashboards: [dash], options: { createFilterCards: false } });
	assert.equal(cards.length, 0);
	assert.deepEqual(pages[1].filters, [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], filterType: 'LEGACY', dataSourceId: { $ref: `dataset:${DATASET}` } }]);
	assert.equal(pages[1].layout.content.length, 1);
});

test('parameter controls, legends, images, web zones and duplicates raise issues', () => {
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1000, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.5 }, { worksheet: 'S' }),
			zone('2', 'worksheet', { x: 0, y: 0.5, w: 1, h: 0.5 }, { worksheet: 'S' }),
			zone('3', 'paramctrl', { x: 0, y: 0, w: 0.1, h: 0.1 }, { param: '[Parameters].[Top N]' }),
			zone('4', 'legend', { x: 0, y: 0, w: 0.1, h: 0.1 }, { worksheet: 'S' }),
			zone('5', 'image', { x: 0, y: 0, w: 0.1, h: 0.1 }),
			zone('6', 'web', { x: 0, y: 0, w: 0.1, h: 0.1 }, { url: 'https://example.com' }),
			zone('7', 'worksheet', { x: 0, y: 0, w: 0.1, h: 0.1 }, { worksheet: 'Missing' }),
			zone('8', 'blank', { x: 0, y: 0, w: 0.1, h: 0.1 })
		],
		floating: []
	};
	const { pages, issues } = plan({ worksheets: [s], dashboards: [dash], options: { parameters: 'variables' } });
	const codes = issues.map((i) => i.code);
	for (const code of ['layout.parameter-control', 'layout.legend', 'layout.unsupported-zone', 'layout.duplicate-card', 'layout.missing-card']) assert.ok(codes.includes(code), code);
	assert.equal(codes.filter((c) => c === 'layout.unsupported-zone').length, 2);
	assert.equal(pages[1].layout.content.length, 1);
	assert.equal(issues.find((i) => i.code === 'layout.legend').severity, 'info');
});

test('parameter controls of variables become VARIABLE items, once per page, at least 10 columns wide', () => {
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES });
	const param = { id: '[Parameters].[Top N]', name: 'Top N', datatype: 'integer', domain: 'range', value: 5, range: { min: 1, max: 20, step: 1 } };
	const variables = [{ key: 'param.top-n.long', name: 'Top N', legacyId: 'calculation_x', dataType: 'LONG', defaultExpression: '5', parameter: param }];
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 }, { worksheet: 'S' }),
			zone('2', 'paramctrl', { x: 0.98, y: 0, w: 0.02, h: 0.05 }, { param: param.id, mode: 'slider' }),
			zone('3', 'paramctrl', { x: 0, y: 0, w: 0.2, h: 0.05 }, { param: param.id, mode: 'slider' })
		],
		floating: []
	};
	const ir = workbook({ worksheets: [s], dashboards: [dash], parameters: [param] });
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, {});
	const { pages, issues } = planPages(ir, cards, bindings, { options: { parameters: 'variables' }, variables });
	const items = pages[1].layout.content.filter((c) => c.type === 'VARIABLE');
	assert.equal(items.length, 1);
	assert.deepEqual(items[0].variableControlId, { $ref: 'variable:param.top-n.long' });
	assert.equal(items[0].control.type, 'SLIDER');
	const box = pages[1].layout.standard.template.find((t) => t.contentKey === items[0].contentKey);
	assert.deepEqual([box.x, box.width, box.type], [0, 60, 'VARIABLE'], 'alone in its row, it fills the row');
	assert.ok(pages[1].layout.compact.template.some((t) => t.contentKey === items[0].contentKey));
	assert.ok(issues.some((i) => i.code === 'layout.duplicate-control'));
	assert.ok(!issues.some((i) => i.code === 'layout.parameter-control'));

	const missing = planPages(ir, cards, bindings, { options: { parameters: 'variables' }, variables: [], inlineParameters: new Map([[param.id, 'no calculation uses it']]) });
	assert.match(missing.issues.find((i) => i.code === 'layout.parameter-control').message, /inlined as a constant: no calculation uses it/);
});

test('a variable control is named after the zone title, else the parameter caption, whatever the variable is named', () => {
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES });
	const list = (id, name) => ({ id, name, datatype: 'string', domain: 'list', value: 'Quarterly', members: [{ value: 'Quarterly' }, { value: 'Monthly' }] });
	const granularity = list('[Parameters].[Parameter 2]', 'Date Granularity - Activity');
	const partition = list('[Parameters].[Parameter 1]', 'Partition By');
	const variables = [
		{ key: 'param.date-granularity-activity.string', name: 'Date Granularity - Activity', legacyId: 'calculation_x', dataType: 'STRING', defaultExpression: "'Quarterly'", parameter: granularity },
		{ key: 'param.partition-by-parameter.string', name: 'Partition By (Parameter)', legacyId: 'calculation_y', dataType: 'STRING', defaultExpression: "'Quarterly'", parameter: partition }
	];
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 }, { worksheet: 'S' }),
			zone('2', 'paramctrl', { x: 0, y: 0, w: 0.2, h: 0.05 }, { param: granularity.id, mode: 'compact', title: 'Granularity' }),
			zone('3', 'paramctrl', { x: 0.2, y: 0, w: 0.2, h: 0.05 }, { param: partition.id, mode: 'compact' }),
			zone('4', 'paramctrl', { x: 0.4, y: 0, w: 0.2, h: 0.05 }, { param: granularity.id, mode: 'compact', title: 'Second' })
		],
		floating: []
	};
	const ir = workbook({ worksheets: [s], dashboards: [dash], parameters: [granularity, partition] });
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, {});
	const { pages, issues } = planPages(ir, cards, bindings, { options: { parameters: 'variables' }, variables });
	const items = pages[1].layout.content.filter((c) => c.type === 'VARIABLE');
	assert.deepEqual(items.map((i) => [i.control.name, i.variableControlId.$ref]), [
		['Granularity', 'variable:param.date-granularity-activity.string'],
		['Partition By', 'variable:param.partition-by-parameter.string']
	], 'with a duplicate control for one variable, the first zone (and its title) wins');
	assert.match(issues.find((i) => i.code === 'layout.duplicate-control').message, /Second/);
});

test('gridLayout keeps every card in both templates and shows a smart text description', () => {
	const stamped = { key: 'b', body: { definition: { dynamicDescription: { text: [{ type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'data refresh: ' }] } } } };
	const layout = gridLayout([{ key: 'a' }, stamped]);
	assert.deepEqual(keysOf(layout.standard.template), [1, 2]);
	assert.deepEqual(keysOf(layout.compact.template), [1, 2]);
	assert.equal(layout.standard.type, 'STANDARD');
	assert.equal(layout.compact.type, 'COMPACT');
	assert.deepEqual(layout.content.map((c) => [c.cardId.$ref, c.hideDescription]), [['card:a', true], ['card:b', false]]);
});

test('a Worksheets view card with <Data Update Time> in its title shows its description', () => {
	const s = sheet({ name: 'New Business Trend', cols: CATEGORY, rows: SALES, title: 'New Business Trend data refresh: <Data Update Time>' });
	const { pages, worksheetCards } = plan({ worksheets: [s], dashboards: [], options: { target: 'app' } });
	const card = worksheetCards.find((c) => c.worksheet === 'New Business Trend');
	assert.ok(card.body.definition.dynamicDescription?.text?.length);
	const view = pages.find((pg) => pg.title === 'Worksheets') ?? pages.find((pg) => pg.layout?.content.some((c) => c.cardId?.$ref === `card:${card.key}`));
	assert.equal(view.layout.content.find((c) => c.cardId?.$ref === `card:${card.key}`).hideDescription, false);
});

test('long dashboard text on a page becomes one header per wrapped line, stacked, and the layout below moves down', () => {
	const s1 = sheet({ name: 'Sales', cols: CATEGORY, rows: SALES });
	const text = 'Beginning in 2023 ARR follows the fiscal calendar. '.repeat(4).trim();
	const dash = { name: 'Notes', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('t', 'text', { x: 0, y: 0, w: 0.5, h: 0.05 }, { text }), zone('a', 'worksheet', { x: 0, y: 0.05, w: 1, h: 0.95 }, { worksheet: 'Sales' })], floating: [] };
	const { pages, issues } = plan({ worksheets: [s1], dashboards: [dash] });
	const layout = pages.find((pg) => pg.dashboard === 'Notes').layout;
	const headers = layout.content.filter((c) => c.type === 'HEADER');
	assert.ok(headers.length > 1);
	assert.equal(headers.map((h) => h.text).join(' '), text);
	const boxes = headers.map((h) => layout.standard.template.find((t) => t.contentKey === h.contentKey));
	assert.deepEqual(boxes.map((b) => [b.x, b.y, b.width, b.height]), boxes.map((b, i) => [0, i * 5, 60, 5]), 'the text widens into the free half of its row');
	const card = layout.standard.template.find((t) => t.type === 'CARD');
	assert.equal(card.y, headers.length * 5, 'the card starts below the last line');
	assert.match(issues.find((i) => i.code === 'layout.text').message, new RegExp(`${headers.length} header lines`));
	assert.ok(!issues.some((i) => i.code === 'layout.text-truncated'));
});

test('text next to another item becomes full-width header rows above it (the editor gives headers no side edges)', () => {
	const sheets = ['Sales', 'Side'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));
	const text = 'Beginning in 2023 ARR follows the fiscal calendar. '.repeat(3).trim();
	const dash = {
		name: 'Notes',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('t', 'text', { x: 0, y: 0, w: 0.5, h: 0.05 }, { text }), zone('b', 'worksheet', { x: 0.5, y: 0, w: 0.5, h: 0.3 }, { worksheet: 'Side' }), zone('a', 'worksheet', { x: 0, y: 0.3, w: 1, h: 0.7 }, { worksheet: 'Sales' })],
		floating: []
	};
	const layout = plan({ worksheets: sheets, dashboards: [dash], options: { target: 'app' } }).pages[0].layout;
	const lines = layout.content.filter((c) => c.type === 'HEADER').map((h) => layout.standard.template.find((t) => t.contentKey === h.contentKey));
	assert.ok(lines.length >= 1);
	assert.ok(lines.every((b, i) => b.x === 0 && b.width === 60 && b.y === i * 5));
	const side = layout.standard.template.find((t) => t.type === 'CARD');
	assert.deepEqual([side.x, side.y, side.width], [0, lines.length * 5, 60]);
	assert.deepEqual(tilingGaps(layout.standard.template, 60), { empty: 0, overlapping: 0 });
});

test('the lines of a title block stay together on both templates, beside a text card, controls and a Filters section', () => {
	const names = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
	const filters = names.map((n) => cat(n, [], { all: true }));
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters });
	const left = 'Use the options below to filter the view, then click any chart to filter the other charts on this view';
	const right = 'Quarter goal reached versus not reached, defined as bookings at or above the plan for that quarter';
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('l', 'text', { x: 0, y: 0, w: 0.12, h: 0.05 }, { text: left }),
			zone('r', 'text', { x: 0.5, y: 0, w: 0.12, h: 0.05 }, { text: right }),
			...filters.map((f, i) => zone(`f${i}`, 'filter', { x: 0.15 + i * 0.04, y: 0.07, w: 0.04, h: 0.05 }, { worksheet: 'S', param: f.pillId, mode: 'checkdropdown' })),
			zone('s', 'worksheet', { x: 0, y: 0.4, w: 1, h: 0.6 }, { worksheet: 'S' })
		],
		floating: []
	};
	const layout = plan({ worksheets: [s], dashboards: [dash], options: { target: 'app' }, columns: names }).pages[0].layout;
	const text = new Map(layout.content.filter((c) => c.type === 'HEADER').map((c) => [c.contentKey, c.text]));
	const l = [...text].filter(([, line]) => left.includes(line)).map(([k]) => k);
	assert.ok(l.length > 1);
	assert.ok(![...text.values()].some((line) => right.includes(line)), 'the text beside the title is not a header');
	const note = layout.content.find((c) => c.type === 'CARD' && /\.text\.r$/.test(c.cardId.$ref));
	assert.ok(note, 'it is a text card');
	const standard = new Map(layout.standard.template.map((t) => [t.contentKey, t]));
	assert.ok(l.every((k, i) => standard.get(k).y === standard.get(l[0]).y + i * 5), 'the title block stays one stack of lines');
	const section = layout.standard.template.find((t) => t.type === 'TABS');
	assert.ok(section.y >= Math.max(...[...l, note.contentKey].map((k) => standard.get(k).y + standard.get(k).height)), 'the Filters section goes below the text, not into it');
	const phone = [...layout.compact.template].sort((a, b) => a.y - b.y).map((t) => t.contentKey);
	assert.deepEqual(phone.slice(phone.indexOf(l[0]), phone.indexOf(l[0]) + l.length), l, 'a block reads in one piece on a phone');
});

test('headerLines: titles use the h1 style when they fit on one line, body text and long titles h2, cut after 6 lines', () => {
	assert.deepEqual(headerLines('Executive Summary', 60, { app: true, title: true }), { lines: ['Executive Summary'], cut: false });
	assert.deepEqual(headerLines('Executive Summary', 60, { app: true }).style, { sourceId: 'h2', textColor: null });
	assert.equal(headerLines('Big note', 60, { app: true, fontSize: 18 }).style, undefined);
	const long = headerLines('word '.repeat(40), 10, { app: true, title: true });
	assert.equal(long.style.sourceId, 'h2');
	assert.equal(long.lines.length, MAX_TEXT_LINES);
	assert.ok(long.cut && long.lines.at(-1).endsWith('...'));
	assert.deepEqual(headerLines('A\n\nB', 60), { lines: ['A', 'B'], cut: false }, 'blank lines are dropped; pages get no style');
	assert.deepEqual(wrapText('aaaa bbbb cccc', 1, 32), ['aaaa', 'bbbb', 'cccc'], 'at least 8 characters a line');
	assert.ok(wrapText('x'.repeat(300), 60).every((l) => l.length <= 71));
	assert.deepEqual(wrapText('Quarterly Sales Territory', 4, 24), ['Quarterly', 'Sales', 'Territory'], 'a word too long for a narrow box keeps a line of its own');
	assert.deepEqual(wrapText(`x${'y'.repeat(100)}`, 4, 32).map((l) => l.length), [71, 30], 'only a word longer than a full-width line is cut');
});

test('a text sheet over a constant calculation becomes a header with its label; without label text it is left out', () => {
	const ONE = p('sum', 'Calculation1', 'qk');
	const label = sheet({ name: 'Title #1', panes: [{ markClass: 'Automatic', encodings: { text: [ONE] }, label: 'Acme Revenue Dynamic Waterfall\nQuarterly View <Parameters.Period>' }] });
	const bare = sheet({ name: 'Title #2', panes: [{ markClass: 'Automatic', encodings: { text: [ONE] } }] });
	const kpi = sheet({ name: 'KPI', panes: [{ markClass: 'Automatic', encodings: { text: [SALES] } }] });
	const ir = workbook({ worksheets: [label, bare, kpi] });
	ir.datasources[0] = { ...ir.datasources[0], fields: [...ir.datasources[0].fields, { id: '[Calculation1]', name: 'Calculation1', datatype: 'integer', role: 'measure', kind: 'calculated', formula: '1' }] };
	ir.dashboards = [
		{
			name: 'D',
			size: { mode: 'fixed', width: 1200, height: 800 },
			zones: [
				zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.05 }, { worksheet: 'Title #1', showTitle: false }),
				zone('2', 'worksheet', { x: 0, y: 0.05, w: 1, h: 0.05 }, { worksheet: 'Title #2', showTitle: false }),
				zone('3', 'worksheet', { x: 0, y: 0.1, w: 0.3, h: 0.05 }, { worksheet: 'KPI' })
			],
			floating: []
		}
	];
	const bindings = makeBindings({ '[Calculation1]': { datasetKey: DATASET, kind: 'formula', name: 'Calculation1', formulaId: 'calculation_one', expression: '1', aggregated: false, dataType: 'LONG', tableauType: 'integer' } });
	const { cards } = planCards(ir, bindings, {});
	const { pages, issues } = planPages(ir, cards, bindings, { options: { target: 'app' } });
	const layout = pages[0].layout;
	assert.deepEqual(
		layout.content.filter((c) => c.type === 'HEADER').map((c) => c.text),
		['Acme Revenue Dynamic Waterfall'],
		'the line with a parameter value is dropped'
	);
	assert.deepEqual(layout.content.filter((c) => c.type === 'CARD').map((c) => c.cardId.$ref), ['card:kpi'], 'a real measure keeps its single value card');
	assert.deepEqual(cards.filter((c) => c.status === 'unsupported').map((c) => c.worksheet).sort(), ['Title #1', 'Title #2']);
	const found = issues.filter((i) => i.code === 'layout.label-sheet');
	assert.deepEqual(found.map((i) => i.severity), ['info', 'warning']);
	assert.match(found[0].message, /field and parameter values are dropped/);
	assert.ok(!pages.some((pg) => pg.title === 'Worksheets'), 'label sheets do not fall to the Worksheets view');
	assert.equal(labelSheet(kpi, ir), undefined);
	const caption = { ...kpi, panes: kpi.panes.map((pane) => ({ ...pane, label: 'Detailed Account Data\nUse the other tab to filter' })) };
	assert.deepEqual(labelSheet(caption, ir), { text: 'Detailed Account Data\nUse the other tab to filter', dynamic: false }, 'a mark label with no field hides the measure');
	const valued = { ...kpi, panes: kpi.panes.map((pane) => ({ ...pane, label: `Sales <[${DATASET}].[sum:Sales:qk]>` })) };
	assert.equal(labelSheet(valued, ir), undefined);
});

test('a label sheet is a header wherever its story comes in the tab order, and push may delete its old card', () => {
	const ONE = p('sum', 'Calculation1', 'qk');
	const label = sheet({ name: 'Title', panes: [{ markClass: 'Automatic', encodings: { text: [ONE] }, label: 'ARR Waterfall' }] });
	const bindings = makeBindings({ '[Calculation1]': { datasetKey: DATASET, kind: 'formula', name: 'Calculation1', formulaId: 'calculation_one', expression: '1', aggregated: false, dataType: 'LONG', tableauType: 'integer' } });
	const run = (storyTab) => {
		const ir = workbook({ worksheets: [label] });
		ir.datasources[0] = { ...ir.datasources[0], fields: [...ir.datasources[0].fields, { id: '[Calculation1]', name: 'Calculation1', datatype: 'integer', role: 'measure', kind: 'calculated', formula: '1' }] };
		ir.dashboards = [{ name: 'D', tabIndex: 1, size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.05 }, { worksheet: 'Title', showTitle: false })], floating: [] }];
		ir.stories = [{ name: 'Story', tabIndex: storyTab, size: { mode: 'fixed', width: 1000, height: 800 }, points: [{ id: '1', caption: 'P1', sheet: 'Title', sheetKind: 'worksheet', captured: [] }] }];
		const { cards } = planCards(ir, bindings, {});
		const { pages } = planPages(ir, cards, bindings, { options: { target: 'app' } });
		const story = pages.find((pg) => pg.story).layout.content;
		return { card: cards[0], story: [story.filter((c) => c.type === 'CARD').length, story.filter((c) => c.type === 'HEADER').map((c) => c.text)] };
	};
	for (const tab of [0, 2]) {
		const { card, story } = run(tab);
		assert.deepEqual([card.status, card.replacedBy, card.pageKeys], ['unsupported', 'header', []]);
		assert.deepEqual(story, [0, []], `story at tab ${tab}: the tab shows its caption as its label, not the card`);
	}
});

test('tokens in dashboard text become parameter values, the dashboard name, or are left out', () => {
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES });
	const ir = workbook({ worksheets: [s] });
	ir.parameters = [{ id: '[Parameters].[Parameter 8]', name: 'Period', datatype: 'string', value: 'FY26' }];
	ir.dashboards = [
		{
			name: 'Bookings',
			size: { mode: 'fixed', width: 1200, height: 800 },
			zones: [zone('t', 'text', { x: 0, y: 0, w: 1, h: 0.05 }, { text: '<Sheet Name> for <[Parameters].[Parameter 8]> | Refreshed: <Data Update Time>' }), zone('s', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 }, { worksheet: 'S' })],
			floating: []
		}
	];
	const { cards } = planCards(ir, makeBindings(), {});
	const { pages, issues } = planPages(ir, cards, makeBindings(), { options: { target: 'app' } });
	assert.deepEqual(pages[0].layout.content.filter((c) => c.type === 'HEADER').map((c) => c.text), ['Bookings for FY26 | Refreshed']);
	assert.match(issues.find((i) => i.code === 'layout.text-field').message, /Data Update Time/);
});

test('zones that do not convert give their space to their neighbors: no empty cell is left', () => {
	const sheets = ['Chart', 'Logo'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('i', 'image', { x: 0, y: 0, w: 0.2, h: 0.1 }),
			zone('t', 'title', { x: 0.2, y: 0, w: 0.8, h: 0.1 }, { text: 'Sales' }),
			zone('l', 'legend', { x: 0.8, y: 0.1, w: 0.2, h: 0.9 }, { worksheet: 'Chart' }),
			zone('c', 'worksheet', { x: 0, y: 0.1, w: 0.8, h: 0.9 }, { worksheet: 'Chart' })
		],
		floating: []
	};
	const { pages } = plan({ worksheets: sheets, dashboards: [dash], options: { target: 'app' } });
	const t = pages[0].layout.standard.template;
	assert.deepEqual(t.map((x) => [x.type, x.x, x.y, x.width]), [['HEADER', 0, 0, 60], ['CARD', 0, 5, 60]]);
	assert.deepEqual(tilingGaps(t, 60), { empty: 0, overlapping: 0 });
});

test('cards are at least as tall as their chart type needs; the layout below grows without overlaps', () => {
	assert.deepEqual(['badge_singlevalue', 'badge_basic_table', 'badge_pivot_table', 'badge_vert_bar', 'badge_dropdown_selector', 'badge_checkbox_selector', 'badge_vert_bar_small_multiple', undefined].map(minCardHeight), [10, 12, 20, 16, 10, 12, 24, 6]);
	const controls = [{ type: 'VARIABLE', controlType: 'DROPDOWN' }, { type: 'VARIABLE', controlType: 'CALENDAR_DROPDOWN' }, { type: 'VARIABLE', controlType: 'RADIOS' }, ...['badge_dropdown_selector', 'badge_date_selector', 'badge_range_selector', 'badge_checkbox_selector'].map((chartType) => ({ type: 'CARD', chartType }))];
	assert.deepEqual(controls.map((c) => controlHeight(c, { app: true, section: true })), [5, 5, 10, 5, 8, 8, 12], 'in a Filters section: date and range selectors 8 rows (with the view style of 0 spacing push writes)');
	assert.deepEqual(controls.map((c) => controlHeight(c, { app: true })), [6, 6, 10, 6, 8, 8, 12], 'dropdowns and variables a row more outside a section; selectors 8 everywhere');
	assert.deepEqual(controls.map((c) => controlHeight(c)), [10, 10, 10, 10, 10, 10, 12], 'classic pages keep the card minimums (no control style there)');
	assert.deepEqual(['badge_map_us_state', 'badge_world_map', 'badge_treemap', 'badge_heatmap'].map(minCardHeight), [20, 20, 16, 16]);
	const kpis = ['New', 'Late', 'Lost'].map((name) => sheet({ name, enc: { text: [SALES] } }));
	const chart = sheet({ name: 'Trend', cols: CATEGORY, rows: SALES });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1600, height: 1800 },
		zones: [
			...kpis.map((s, i) => zone(String(i + 1), 'worksheet', { x: 0, y: 0.2 + i * 0.0145, w: 1, h: 0.0145 }, { worksheet: s.name })),
			zone('9', 'worksheet', { x: 0, y: 0.3, w: 1, h: 0.2 }, { worksheet: 'Trend' })
		],
		floating: []
	};
	const { pages, issues } = plan({ worksheets: [...kpis, chart], dashboards: [dash], options: { target: 'app' } });
	const t = pages[0].layout.standard.template;
	assert.deepEqual(t.map((x) => [x.y, x.height]), [[0, 10], [10, 10], [20, 10], [30, 23]], 'rows start at the top and stack with no empty band');
	assert.match(issues.find((i) => i.code === 'layout.min-height').message, /^3 card\(s\) made taller/);
	assert.deepEqual(pages[0].layout.compact.template.map((x) => x.height), [4, 4, 4, 6]);
});

test('packControls: short titles get the editor\'s width 10 and a short row ends in a spacer, as on SalesReview Page 3', () => {
	const controls = ['FY', 'FYQ', 'FYP', 'Category', 'Sub-Category'].map((label, i) => ({ label, placed: { type: i < 3 ? 'CARD' : 'VARIABLE', chartType: 'badge_dropdown_selector', box: { x: i, y: 0, width: 1, height: 1 }, order: i } }));
	const packed = packControls(controls);
	assert.deepEqual(controls.map((c) => [c.placed.box.x, c.placed.box.width]), [[0, 10], [10, 10], [20, 10], [30, 10], [40, 10]]);
	assert.deepEqual(packed.spacers, [{ x: 50, y: 0, width: 10, height: packed.height }]);
	const full = packControls(controls.slice(0, 5).concat({ label: 'Region', placed: { type: 'VARIABLE', box: { x: 9, y: 0, width: 1, height: 1 }, order: 9 } }));
	assert.deepEqual(full.spacers, [], 'a full row needs no spacer');
	const long = { label: 'Sales Touch Workaround Detail', placed: { type: 'CARD', chartType: 'badge_dropdown_selector', box: { x: 0, y: 99, width: 1, height: 1 }, order: 9 } };
	const wrapped = packControls([...controls, long]);
	assert.deepEqual([long.placed.box.x, long.placed.box.y > 0, long.placed.box.width], [0, true, 20], 'a long title takes two slots, on the next row when it does not fit');
	assert.deepEqual(wrapped.spacers.map((s) => [s.x, s.width]), [[50, 10], [20, 40]]);
	assert.ok(controls.every((c) => c.placed.box.width === 10), 'one long title does not widen the others');
});

test('packControls: a row is as tall as its tallest control (dropdowns and variables 5, date and range selectors 8)', () => {
	const mk = (label, type, chartType, i) => ({ label, placed: { type, chartType, box: { x: i, y: 0, width: 1, height: 1 }, order: i } });
	const rows = [
		[['FY', 'CARD', 'badge_dropdown_selector'], ['Category', 'VARIABLE'], ['Order Date', 'CARD', 'badge_date_selector']],
		[['Day', 'VARIABLE'], ['Geo', 'CARD', 'badge_dropdown_selector']],
		[['Country', 'CARD', 'badge_dropdown_selector'], ['Employees', 'CARD', 'badge_range_selector']]
	];
	const controls = rows.flatMap((row, r) => [...row.map((c, i) => mk(...c, r * 10 + i)), ...Array.from({ length: 6 - row.length }, (_, i) => mk(`x${r}${i}`, 'CARD', 'badge_dropdown_selector', r * 10 + row.length + i))]);
	const packed = packControls(controls, { app: true });
	assert.deepEqual([...new Set(controls.map((c) => `${c.placed.box.y}:${c.placed.box.height}`))], ['0:8', '8:5', '13:8']);
	assert.equal(packed.height, 21);
	assert.equal(packControls(controls).height, 30, 'classic pages keep 10-row controls');
});

test('packControls: Tableau\'s side-by-side containers of stacked filters stay columns of equal width (CustomerVoice Planning)', () => {
	const stacks = [
		['Granularity', 'Type', 0, 11.5],
		['Process Area', 'RICE Score Bucket', 11.8, 12.1],
		['Urgency', 'Assigned Name', 23.8, 12.2],
		['Impact', 'Impacted Systems', 36, 12.3],
		['Impacted Functional Area', 'Status', 48.3, 11.3]
	];
	const controls = stacks.flatMap(([top, bottom, x, w], i) =>
		[top, bottom].map((label, j) => ({ label, placed: { type: i + j === 0 ? 'VARIABLE' : 'CARD', chartType: 'badge_dropdown_selector', stack: `c${i}`, box: { x, y: 5 + j * 3.5, width: w, height: 3.5 }, frame: { x, y: 5 + j * 3.5, w, h: 3.5 }, order: i * 2 + j } }))
	);
	const packed = packControls(controls, { app: true });
	assert.equal(packed.tableau, true);
	assert.deepEqual(Object.fromEntries(controls.map((c) => [c.label, [c.placed.box.x, c.placed.box.y, c.placed.box.width, c.placed.box.height]])), {
		Granularity: [0, 0, 12, 5],
		'Process Area': [12, 0, 12, 5],
		Urgency: [24, 0, 12, 5],
		Impact: [36, 0, 12, 5],
		'Impacted Functional Area': [48, 0, 12, 5],
		Type: [0, 5, 12, 5],
		'RICE Score Bucket': [12, 5, 12, 5],
		'Assigned Name': [24, 5, 12, 5],
		'Impacted Systems': [36, 5, 12, 5],
		Status: [48, 5, 12, 5]
	});
	assert.deepEqual([packed.height, packed.spacers], [10, []], 'two full rows, no title-sized reflow and no empty row');
});

test('packControls: a short column whose controls fill their Tableau stack spreads over the band, no spacer (CustomerVoice Activity)', () => {
	const stack = (labels, x, heights, fill) => {
		let y = 0;
		return labels.map((label, j) => {
			const h = heights[j];
			const placed = { type: 'CARD', chartType: 'badge_dropdown_selector', stack: `s${x}`, box: { x, y, width: 15, height: h }, frame: { x, y, w: 15, h }, order: x + j, ...(fill ? { stackFill: labels.length } : {}) };
			y += h;
			return { label, placed };
		});
	};
	const three = (x) => stack([`Assigned Name ${x}`, `RICE Score Bucket ${x}`, `Requested Date ${x}`], x, [5.89, 5.89, 5.78], true);
	const controls = [...three(0), ...three(15), ...three(30), ...stack(['Impacted Systems', 'Impacted Functional Area'], 45, [8.777, 8.778], true)];
	const packed = packControls(controls, { app: true });
	assert.equal(packed.tableau, true);
	const box = (label) => Object.values(controls.find((c) => c.label === label).placed.box);
	assert.deepEqual([box('Impacted Systems'), box('Impacted Functional Area')], [[45, 0, 15, 7], [45, 7, 15, 8]]);
	assert.deepEqual([packed.height, packed.spacers], [15, []]);

	const blank = [...three(0), ...three(15), ...three(30), ...stack(['IS', 'IFA'], 45, [5.89, 5.89], false)];
	const kept = packControls(blank, { app: true });
	assert.deepEqual(kept.spacers, [{ x: 45, y: 10, width: 15, height: 5 }], 'a stack with blank space below its controls keeps the spacer');

	const tall = Array.from({ length: 4 }, (_, i) => stack([`Assigned Name ${i}`, `RICE Score Bucket ${i}`, `Requested Date ${i}`], i * 15, [5.89, 5.89, 5.78], true)).flat();
	const lopsided = [...tall.slice(0, 9), ...stack(['Impacted Systems', 'Impacted Functional Area'], 45, [16.5, 1], true)];
	assert.equal(packControls(lopsided, { app: true }).spacers.length, 1, 'a member that would fall below its control height keeps the spacer');
});

test('packControls: a sidebar stack is reflowed into rows, since its Tableau column would be taller', () => {
	const controls = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((label, i) => ({ label, placed: { type: 'CARD', chartType: 'badge_dropdown_selector', stack: 'side', box: { x: 50, y: i * 4, width: 10, height: 4 }, frame: { x: 50, y: i * 4, w: 10, h: 4 }, order: i } }));
	const packed = packControls(controls, { app: true });
	assert.equal(packed.tableau, false);
	assert.deepEqual([packed.height, controls.map((c) => c.placed.box.width)], [10, [10, 10, 10, 10, 10, 10, 10]]);
});

test('packControls: a Tableau row too wide for its minimum widths wraps into even rows in order, a stack keeps its rows aligned', () => {
	const row = Array.from({ length: 9 }, (_, i) => ({ label: `F${i}`, placed: { type: 'CARD', chartType: 'badge_dropdown_selector', box: { x: i * 6, y: 0, width: 6, height: 4 }, frame: { x: i * 6, y: 0, w: 6, h: 4 }, order: i } }));
	packControls(row, { app: true });
	assert.deepEqual(row.map((c) => [c.placed.box.y, c.placed.box.width]), [[0, 12], [0, 12], [0, 12], [0, 12], [0, 12], [5, 15], [5, 15], [5, 15], [5, 15]]);
	const stacked = [['Date', 'Region', 0, 10], ['Segment', 'Channel', 10, 20], ['Product', 'Owner', 30, 10], ['Team', 'Geo', 40, 20]].flatMap(([top, bottom, x, w], i) =>
		[top, bottom].map((label, j) => ({ label, placed: { type: 'CARD', chartType: i + j === 0 ? 'badge_date_selector' : 'badge_dropdown_selector', stack: `s${i}`, box: { x, y: j * 4, width: w, height: 4 }, frame: { x, y: j * 4, w, h: 4 }, order: i * 2 + j } }))
	);
	const packed = packControls(stacked, { app: true });
	assert.equal(packed.tableau, true);
	assert.deepEqual(stacked.map((c) => [c.placed.box.x, c.placed.box.y, c.placed.box.width, c.placed.box.height]), [[0, 0, 10, 8], [0, 8, 10, 5], [10, 0, 20, 8], [10, 8, 20, 5], [30, 0, 10, 8], [30, 8, 10, 5], [40, 0, 20, 8], [40, 8, 20, 5]], 'widths keep their 1:2 ratio, the second row starts under the taller date selector');
});

test('spreadWidths: proportional by largest remainder, raised to the minimums, equal when nearly so', () => {
	assert.deepEqual(spreadWidths([1, 1, 1, 1, 1, 1, 1], [8, 8, 8, 8, 8, 8, 8], 60), [9, 9, 9, 9, 8, 8, 8]);
	assert.deepEqual(spreadWidths([11.4, 12, 12.2, 12.3, 11.3], [10, 8, 8, 8, 8], 60), [12, 12, 12, 12, 12]);
	assert.deepEqual(spreadWidths([1, 3], [8, 8], 60), [15, 45]);
	assert.deepEqual(spreadWidths([1, 10, 10], [10, 8, 8], 60), [10, 25, 25]);
});

test('finishLayout keeps template-only spacers through a re-tile (push leaving an item out)', () => {
	const content = [{ contentKey: 1, type: 'CARD' }];
	const standard = [
		{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 30, height: 10 },
		{ contentKey: 7, type: 'SPACER', x: 30, y: 0, width: 30, height: 10 }
	];
	const compact = [
		{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 6 },
		{ contentKey: 7, type: 'SPACER', x: 0, y: 6, width: 12, height: 0 }
	];
	const out = finishLayout(content, standard, compact);
	assert.deepEqual(out.content.map((c) => c.type), ['CARD']);
	assert.deepEqual(out.standard.template.map((t) => [t.contentKey, t.type]), [[1, 'CARD'], [7, 'SPACER']]);
	assert.deepEqual(out.compact.template.map((t) => [t.contentKey, t.type]), [[1, 'CARD'], [7, 'SPACER']]);
});

test('more than 6 filter cards are packed into a collapsible Filters section in their Tableau row', () => {
	const names = ['Datasource', 'Industry', 'Vertical', 'Product (group)', 'Planname (Level 1)', 'Billingtype', 'Contract Cancelation Reason'];
	const filters = names.map((n) => cat(n, [], { all: true }));
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1600, height: 1800 },
		zones: [
			zone('t', 'title', { x: 0, y: 0, w: 1, h: 0.04 }, { text: 'Waterfall' }),
			...filters.map((f, i) => zone(`f${i}`, 'filter', { x: i * 0.065, y: 0.05, w: 0.065, h: 0.033 }, { worksheet: 'S', param: f.pillId, mode: 'checkdropdown' })),
			zone('s', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.3 }, { worksheet: 'S' })
		],
		floating: []
	};
	const app = plan({ worksheets: [s], dashboards: [dash], options: { target: 'app' }, columns: names });
	const layout = app.pages[0].layout;
	const tabs = layout.content.find((c) => c.type === 'TABS');
	assert.deepEqual([tabs.tabType, tabs.collapsible], ['SECTION', true]);
	assert.equal(layout.content.find((c) => c.type === 'TAB_CONTENT').text, 'Filters');
	const section = layout.standard.template.find((t) => t.type === 'TABS');
	const members = section.children[1].children.filter((m) => m.type !== 'SPACER');
	assert.equal(members.length, 7);
	assert.deepEqual(members.map((m) => [m.x, m.y, m.width, m.height]), [[0, 0, 9, 5], [9, 0, 9, 5], [18, 0, 9, 5], [27, 0, 9, 5], [36, 0, 8, 5], [44, 0, 8, 5], [52, 0, 8, 5]], 'one row of equal widths, as in Tableau, whatever the titles');
	assert.equal(section.children[1].children.length, 7, 'a full row needs no spacer');
	assert.ok(!layout.content.some((c) => c.type === 'SPACER'), 'a spacer has no content item, as the editor saves it');
	assert.deepEqual(tilingGaps(layout.standard.template, 60), { empty: 0, overlapping: 0 });
	assert.deepEqual([section.x, section.y, section.width], [0, 5, 60]);
	const card = layout.standard.template.find((t) => t.type === 'CARD');
	assert.equal(card.y, section.y + section.height, 'the rows the filters left close up under the section');
	assert.match(app.issues.find((i) => i.code === 'layout.filter-panel').message, /^7 filter cards and controls were packed into a collapsible "Filters" section/);
	const compact = layout.compact.template;
	assert.deepEqual(compact.map((t) => t.type), ['HEADER', 'TABS', 'CARD'], 'the controls come right after the title on a phone');
	const phoneMembers = compact[1].children[1].children;
	assert.deepEqual(phoneMembers.slice(0, 2).map((m) => [m.x, m.y, m.width, m.height]), [[0, 0, 12, 4], [0, 4, 12, 4]], 'full width, as the editor adds compact items');

	const pages = plan({ worksheets: [s], dashboards: [dash], options: { target: 'pages' }, columns: names });
	const classic = pages.pages[1].layout;
	assert.ok(!classic.content.some((c) => c.type === 'TABS'));
	const rows = classic.standard.template.filter((t) => t.type === 'CARD' && t.height === 10);
	assert.equal(rows.length, 7);
	assert.ok(rows.every((r) => r.y >= 5));
	assert.deepEqual(tilingGaps(classic.standard.template, 60), { empty: 0, overlapping: 0 }, 'the packed rows tile on a page too');
});

test('filter controls spread over the dashboard go into one Filters section and the cards keep their columns', () => {
	const names = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'];
	const filters = names.map((n) => cat(n, [], { all: true }));
	const sheets = ['L1', 'R1', 'L2', 'R2'].map((n) => sheet({ name: n, cols: CATEGORY, rows: SALES, filters }));
	const fz = (i, x, y) => zone(`f${i}`, 'filter', { x, y, w: 0.1, h: 0.04 }, { worksheet: 'L1', param: filters[i].pillId, mode: 'checkdropdown' });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 1200 },
		zones: [
			...[0, 1, 2, 3].map((i) => fz(i, i * 0.1, 0)),
			zone('l1', 'worksheet', { x: 0, y: 0.05, w: 0.5, h: 0.4 }, { worksheet: 'L1' }),
			zone('r1', 'worksheet', { x: 0.5, y: 0.05, w: 0.5, h: 0.4 }, { worksheet: 'R1' }),
			...[4, 5, 6, 7].map((i) => fz(i, 0.5 + (i - 4) * 0.1, 0.5)),
			zone('l2', 'worksheet', { x: 0, y: 0.55, w: 0.5, h: 0.4 }, { worksheet: 'L2' }),
			zone('r2', 'worksheet', { x: 0.5, y: 0.55, w: 0.5, h: 0.4 }, { worksheet: 'R2' })
		],
		floating: []
	};
	for (const target of ['app', 'pages']) {
		const { pages } = plan({ worksheets: sheets, dashboards: [dash], options: { target }, columns: names });
		const layout = pages.find((pg) => pg.dashboard === 'D').layout;
		const sheetCards = layout.content.filter((c) => /card:.*(l1|r1|l2|r2)$/i.test(c.cardId?.$ref ?? ''));
		assert.equal(sheetCards.length, 4, target);
		const boxes = sheetCards.map((c) => layout.standard.template.find((t) => t.contentKey === c.contentKey));
		assert.ok(boxes.every((b) => b.width === 30), `${target}: side-by-side sheets stay side by side`);
		assert.deepEqual(tilingGaps(layout.standard.template, 60), { empty: 0, overlapping: 0 }, target);
	}
});

test('a few filter cards keep their place, at least as wide as their titles', () => {
	const f = cat('Contract Cancelation Reason', [], { all: true });
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [f] });
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('f', 'filter', { x: 0.5, y: 0, w: 0.07, h: 0.05 }, { worksheet: 'S', param: f.pillId, mode: 'checkdropdown' }), zone('s', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 }, { worksheet: 'S' })],
		floating: []
	};
	const { pages, issues } = plan({ worksheets: [s], dashboards: [dash], options: { target: 'app' }, columns: ['Contract Cancelation Reason'] });
	const box = pages[0].layout.standard.template.find((t) => t.height === 6);
	assert.deepEqual([box.x, box.width], [0, 60], 'alone in its row, it fills the row, a row taller than in a section');
	assert.ok(!issues.some((i) => i.code === 'layout.filter-panel'));
	const beside = { ...dash, zones: [zone('f', 'filter', { x: 0.9, y: 0, w: 0.07, h: 1 }, { worksheet: 'S', param: f.pillId, mode: 'checkdropdown' }), zone('s', 'worksheet', { x: 0, y: 0, w: 0.9, h: 1 }, { worksheet: 'S' })] };
	const narrow = plan({ worksheets: [s], dashboards: [beside], options: { target: 'app' }, columns: ['Contract Cancelation Reason'] }).pages[0].layout.standard.template;
	assert.deepEqual(narrow.map((t) => [t.type, t.x, t.width]), [['CARD', 0, 45], ['CARD', 45, 15]], 'the filter takes the 15 columns its title needs from the card beside it');
});

test('the phone template puts the title first, then the controls full width at small heights, then the content', () => {
	const items = [
		{ contentKey: 1, type: 'CARD', chartType: 'badge_vert_bar', box: { x: 0, y: 10, width: 60, height: 30 }, order: 0 },
		{ contentKey: 2, type: 'HEADER', box: { x: 0, y: 0, width: 60, height: 5 }, order: 1 },
		{ contentKey: 3, type: 'VARIABLE', control: 'variable', box: { x: 0, y: 5, width: 10, height: 7 }, order: 2 },
		{ contentKey: 4, type: 'CARD', chartType: 'badge_dropdown_selector', control: 'filter', box: { x: 10, y: 5, width: 8, height: 8 }, order: 3 },
		{ contentKey: 5, type: 'CARD', chartType: 'badge_checkbox_selector', control: 'filter', box: { x: 40, y: 50, width: 8, height: 12 }, order: 4 }
	];
	assert.deepEqual(
		compactTemplate(items).map((t) => [t.contentKey, t.x, t.y, t.width, t.height]),
		[
			[2, 0, 0, 12, 2],
			[3, 0, 2, 12, 4],
			[4, 0, 6, 12, 4],
			[5, 0, 10, 12, 5],
			[1, 0, 15, 12, 6]
		]
	);
});

test('a custom Tableau phone layout orders the phone template; zones it leaves out follow', () => {
	const sheets = ['A', 'B', 'C'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES }));
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.3 }, { worksheet: 'A' }), zone('2', 'worksheet', { x: 0, y: 0.3, w: 1, h: 0.3 }, { worksheet: 'B' }), zone('3', 'worksheet', { x: 0, y: 0.6, w: 1, h: 0.3 }, { worksheet: 'C' })],
		floating: [],
		deviceLayouts: [{ name: 'Phone', auto: false, size: { mode: 'vscroll' }, zoneIds: ['3', '1'] }]
	};
	const { pages, issues } = plan({ worksheets: sheets, dashboards: [dash], options: { target: 'app' } });
	const layout = pages[0].layout;
	const sheetOf = new Map(layout.content.map((c) => [c.contentKey, c.cardId.$ref]));
	assert.deepEqual([...layout.compact.template].sort((a, b) => a.y - b.y).map((t) => sheetOf.get(t.contentKey)), ['card:c', 'card:a', 'card:b']);
	assert.match(issues.find((i) => i.code === 'layout.phone-layout').message, /1 item\(s\) it leaves out are at the end/);
	const auto = plan({ worksheets: sheets, dashboards: [{ ...dash, deviceLayouts: [{ name: 'Phone', auto: true, size: { mode: 'vscroll' } }] }], options: { target: 'app' } });
	assert.ok(!auto.issues.some((i) => i.code === 'layout.phone-layout'));
});

test('a title-only worksheet becomes a page header; an empty one is left out quietly', () => {
	const dash = {
		name: 'D',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [
			zone('1', 'worksheet', { x: 0, y: 0, w: 1, h: 0.1 }, { worksheet: 'Banner' }),
			zone('2', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.1 }, { worksheet: 'Updated' }),
			zone('3', 'worksheet', { x: 0, y: 0.2, w: 1, h: 0.1 }, { worksheet: 'Blank' })
		],
		floating: []
	};
	const { pages, issues, cards } = plan({ worksheets: [sheet({ name: 'Banner', title: 'Regional Sales' }), sheet({ name: 'Updated', title: 'Last Updated: <Data Update Time>' }), sheet({ name: 'Blank' })], dashboards: [dash] });
	const layout = pages.find((pg) => pg.dashboard === 'D').layout;
	const text = cards.find((c) => c.kind === 'notebook');
	assert.deepEqual(layout.content.map((c) => [c.type, c.text ?? c.cardId?.$ref]), [['HEADER', 'Regional Sales'], ['CARD', `card:${text.key}`]], 'the update time is a text card');
	assert.ok(!issues.some((i) => i.code === 'layout.missing-card'));
});

test('a SalesReview-shaped dashboard lays out as the editor builds it (Page 3): title, the Last Updated text card, Filters section, then the card', () => {
	const names = ['FY', 'FYQ', 'FYP', 'Order Date', 'Country', 'Channel', 'Partner', 'Product Line'];
	const filters = names.map((n) => cat(n, [], { all: true }));
	const table = sheet({ name: 'By End User', cols: CATEGORY, rows: SALES, filters });
	const status = sheet({ name: 'Last Updated', cols: CATEGORY, title: 'Last Updated: <Data Update Time>' });
	const floating = (id, kind, rect, extra) => ({ ...zone(id, kind, rect, extra), floating: true });
	const bookings = {
		name: 'Bookings',
		size: { mode: 'fixed', width: 1400, height: 1100 },
		zones: [
			zone('549', 'image', { x: 0.0057, y: 0.0073, w: 0.9886, h: 0.0713 }),
			...filters.map((f, i) => zone(`f${i}`, 'filter', { x: 0.0057 + (i % 2) * 0.1032, y: 0.0786 + Math.floor(i / 2) * 0.0509, w: 0.1032, h: 0.0509 }, { worksheet: 'By End User', param: f.pillId, mode: 'checkdropdown' })),
			zone('5', 'worksheet', { x: 0.2121, y: 0.0786, w: 0.7822, h: 0.9141 }, { worksheet: 'By End User' })
		],
		floating: [floating('551', 'text', { x: 0.3614, y: 0.0273, w: 0.3079, h: 0.03 }, { text: 'Detailed Bookings Report' }), floating('26', 'worksheet', { x: 0.8107, y: 0.0546, w: 0.1829, h: 0.0227 }, { worksheet: 'Last Updated' })]
	};
	const glossary = { name: 'Glossary', size: { mode: 'fixed', width: 1400, height: 900 }, zones: [zone('19', 'text', { x: 0.0057, y: 0.0089, w: 0.9886, h: 0.1 }, { text: 'Glossary of terms' })], floating: [floating('26', 'worksheet', { x: 0.01, y: 0.0478, w: 0.25, h: 0.0333 }, { worksheet: 'Last Updated' })] };
	const { pages, issues, worksheetCards, cards } = plan({ worksheets: [table, status], dashboards: [bookings, glossary], options: { target: 'app' }, columns: names });
	const layout = pages.find((pg) => pg.dashboard === 'Bookings').layout;
	const of = (t) => layout.content.find((c) => c.contentKey === t.contentKey);
	const text = cards.find((c) => c.kind === 'notebook');
	const tabs = layout.standard.template[2];
	assert.deepEqual(layout.standard.template.map((t) => [t.type, t.x, t.y, t.width]), [['HEADER', 0, 0, 60], ['CARD', 0, 5, 60], ['TABS', 0, 11, 60], ['CARD', 0, tabs.y + tabs.height, 60]]);
	assert.equal(of(layout.standard.template[0]).text, 'Detailed Bookings Report', 'the floating title is the top row, not below the report');
	assert.equal(of(layout.standard.template[1]).cardId.$ref, `card:${text.key}`, 'the update time is a text card under the title');
	for (const [template, width] of [[layout.standard.template, 60], [layout.compact.template, 12]]) assert.deepEqual(tilingGaps(template, width), { empty: 0, overlapping: 0 });
	const pane = tabs.children[1];
	const rows = new Map();
	for (const c of pane.children) rows.set(c.y, [...(rows.get(c.y) ?? []), c]);
	assert.ok([...rows.values()].every((row) => row.reduce((w, c) => w + c.width, 0) === 60 && row.every((c) => c.height === row[0].height)), 'control rows span the width at one height');
	assert.deepEqual(layout.compact.template.map((t) => [t.type, t.width]), [['HEADER', 12], ['CARD', 12], ['TABS', 12], ['CARD', 12]]);

	const card = worksheetCards.find((c) => c.worksheet === 'By End User');
	assert.equal(card.body.definition.dynamicDescription, undefined);
	const content = layout.content.find((c) => c.cardId?.$ref === `card:${card.key}`);
	assert.deepEqual([content.hideDescription, content.hideFooter, content.editInAppViewer], [true, true, true], 'no smart text, so no description');
	const lastUpdated = worksheetCards.find((c) => c.worksheet === 'Last Updated');
	assert.deepEqual([lastUpdated.status, lastUpdated.replacedBy, lastUpdated.pageKeys], ['unsupported', 'notebook', []]);
	const notes = issues.filter((i) => i.code === 'layout.update-time');
	assert.deepEqual(notes.map((i) => i.object.name), ['Last Updated']);
	assert.match(notes[0].message, /text card at the top of each view that shows it, with the update time as "Date last updated" smart text/);
	const glossaryView = pages.find((pg) => pg.dashboard === 'Glossary');
	assert.deepEqual([text.pageKeys, glossaryView.layout.content.map((c) => c.cardId?.$ref).filter(Boolean)], [[pages.find((pg) => pg.dashboard === 'Bookings').key, glossaryView.key], [`card:${text.key}`]], 'one text card on both views');
});

test('--tableau-links: a link to each dashboard on Tableau in the text card at the top of its view, a text card just for it otherwise', () => {
	const status = sheet({ name: 'Status', cols: CATEGORY, title: 'Owner : Ann | Data Refreshed : <Data Update Time>' });
	const chart = sheet({ name: 'Chart', cols: CATEGORY, rows: SALES });
	const dash = (name, sheets) => ({ name, size: { mode: 'fixed', width: 1200, height: 800 }, zones: sheets.map((s, i) => zone(`${name}${i}`, 'worksheet', { x: 0, y: i * 0.1, w: 1, h: i ? 0.9 : 0.1 }, { worksheet: s })), floating: [] });
	const ir = workbook({ worksheets: [status, chart], dashboards: [dash('Executive Summary', ['Status', 'Chart']), dash('Case Metrics', ['Status', 'Chart']), dash('Plain', ['Chart'])] });
	ir.workbook = { ...ir.workbook, contentUrl: 'Support_Summary', webpageUrl: 'https://prod-useast-b.online.tableau.com/#/site/acme/workbooks/1001' };
	const bindings = makeBindings();
	const run = (options) => {
		const { cards } = planCards(ir, bindings, { options });
		const result = planPages(ir, cards, bindings, { options, workbookKey: 'wb' });
		return { ...result, notebooks: result.cards.filter((c) => c.kind === 'notebook') };
	};
	const off = run({ target: 'app' });
	assert.ok(off.notebooks.every((c) => !c.tableauLink && !JSON.stringify(c.body).includes('tableau.com')), 'off by default');
	const { pages, notebooks } = run({ target: 'app', tableauLinks: true });
	const link = (n) => n.body.notebook.paragraphs.at(-1);
	const url = (sheetName) => `https://prod-useast-b.online.tableau.com/#/site/acme/views/Support_Summary/${sheetName}`;
	const byPage = (title) => notebooks.find((n) => n.pageKeys.includes(pages.find((pg) => pg.title === title).key));
	assert.deepEqual(link(byPage('Executive Summary')), [{ text: 'Open in Tableau', link: url('ExecutiveSummary') }]);
	assert.equal(byPage('Executive Summary').body.notebook.paragraphs.length, 2, 'the status text, then the link');
	const copy = byPage('Case Metrics');
	assert.notEqual(copy.key, byPage('Executive Summary').key, 'a view sharing the status card gets its own copy with its own link');
	assert.deepEqual(link(copy), [{ text: 'Open in Tableau', link: url('CaseMetrics') }]);
	const [orig, copied] = [byPage('Executive Summary'), copy].map((n) => n.body.notebook.paragraphs[0]);
	assert.deepEqual(copied.map((s) => s.text ?? s.owner ?? s.smart), orig.map((s) => s.text ?? s.owner ?? s.smart), 'the same status text');
	assert.ok(copied.filter((s) => 'id' in s).every((s, i) => s.id !== orig.filter((x) => 'id' in x)[i].id), 'smart text ids of its own');
	const plain = byPage('Plain');
	assert.deepEqual([plain.key, plain.body.notebook.paragraphs, plain.datasetKey], [`${pages.find((pg) => pg.title === 'Plain').key}.tableau-link`, [[{ text: 'Open in Tableau', link: url('Plain') }]], '']);
	const plainLayout = pages.find((pg) => pg.title === 'Plain').layout;
	const first = plainLayout.standard.template.slice().sort((a, b) => a.y - b.y)[0];
	assert.equal(plainLayout.content.find((c) => c.contentKey === first.contentKey).cardId.$ref, `card:${plain.key}`, 'the link card is the top row');
	assert.equal(plainLayout.content.find((c) => c.contentKey === first.contentKey).editInAppViewer, false, 'viewers cannot edit the link text in app view');
	const noUrl = workbook({ worksheets: [chart], dashboards: [dash('Plain', ['Chart'])] });
	const { cards: c2 } = planCards(noUrl, bindings, { options: {} });
	const r2 = planPages(noUrl, c2, bindings, { options: { target: 'app', tableauLinks: true } });
	assert.ok(r2.issues.some((i) => i.code === 'layout.tableau-link'));
	assert.ok(!r2.cards.some((c) => c.kind === 'notebook'));
});

test('tableauViewUrl: site route, workbook url and the sheet name without spaces or punctuation', () => {
	const ir = { workbook: { contentUrl: 'SalesReview', webpageUrl: 'https://prod-useast-b.online.tableau.com/#/site/acme/workbooks/1002' } };
	assert.equal(tableauViewUrl(ir, 'Bookings'), 'https://prod-useast-b.online.tableau.com/#/site/acme/views/SalesReview/Bookings');
	assert.equal(tableauViewUrl({ workbook: { contentUrl: 'W', webpageUrl: 'https://tableau.example.com/#/workbooks/9' } }, 'Acme Support/Sales Summary'), 'https://tableau.example.com/#/views/W/AcmeSupportSalesSummary', 'the Default site');
	assert.equal(tableauViewUrl({ workbook: { contentUrl: 'W' } }, 'X'), undefined);
	const listed = { workbook: { ...ir.workbook, views: [{ name: 'Bookings', contentUrl: 'SalesReview/sheets/Bookings' }] } };
	assert.equal(tableauViewUrl(listed, 'Bookings'), 'https://prod-useast-b.online.tableau.com/#/site/acme/views/SalesReview/Bookings', 'the view content url listed at extract');
	assert.equal(tableauViewUrl(listed, 'Glossary'), ir.workbook.webpageUrl, 'a sheet Tableau does not publish as a view links to the workbook');
});

test('title header text keeps the parts of a line that show no field value', () => {
	assert.equal(titleHeaderText('Owner: Jane  | Last Updated: <Data Update Time>'), 'Owner: Jane');
	assert.equal(titleHeaderText('Owner: Ann\n Last Updated: <Data Update Time>'), 'Owner: Ann');
	assert.equal(titleHeaderText('A | B'), 'A | B');
	assert.equal(titleHeaderText('Last Updated: <Data Update Time>'), '');
});

test('a scoped filter copy on a dataset whose shown sheet went into a merged stack follows the stack default', () => {
	const selection = { column: 'Region', name: 'Region', dataType: 'string', operand: 'IN', values: ['East'], pillIds: ['[region]'] };
	const fixed = { column: 'Region', filterType: 'COLUMN_ID', operand: 'IN', values: ['East'], dataType: 'string' };
	const card = (key, extra) => ({ key, title: key, datasetKey: 'orders', pageKeys: ['pg'], status: 'ok', body: { definition: { subscriptions: { main: { filters: [{ ...fixed }] } } } }, scopedFilters: [{ pillId: '[region]', default: selection, filters: [{ ...fixed }] }], ...extra });
	const stack = card('stack', { worksheet: '', datasetKey: 'orders.stack-a', stack: { sheets: ['A', 'B'], datasetKey: 'orders.stack-a' }, quickFilterDefaults: [selection] });
	const other = card('c', { worksheet: 'C' });
	const pages = [{ key: 'pg', dashboard: 'D', layout: { content: [] } }];
	const scopes = new Map([['D', [{ id: 's1', members: new Map([['A', '[region]'], ['B', '[region]'], ['C', '[region]']]) }]]]);
	pageDefaultFilters(pages, [stack, other], { scopes });
	assert.deepEqual(pages[0].filters.map((f) => [f.column, f.dataSourceId.$ref]), [['Region', 'dataset:orders.stack-a'], ['Region', 'dataset:orders']]);
	for (const c of [stack, other]) assert.deepEqual(c.body.definition.subscriptions.main.filters, [], `${c.key} drops its fixed copy`);
});

test('a merged stack default takes the filter card on its sheets dataset as its source', () => {
	const selection = { column: 'Region', name: 'Region', dataType: 'string', operand: 'IN', values: ['East'] };
	const stack = { key: 'stack', title: 'stack', worksheet: '', datasetKey: 'orders.stack-a', pageKeys: ['pg'], status: 'ok', stack: { sheets: ['A', 'B'], datasetKey: 'orders.stack-a' }, quickFilterDefaults: [selection], body: { definition: { subscriptions: { main: { filters: [] } } } } };
	const member = { key: 'a', worksheet: 'A', datasetKey: 'orders', pageKeys: [], status: 'unsupported', replacedBy: 'stack', stackedInto: 'stack' };
	const filterCard = { key: 'filter-region', worksheet: '', datasetKey: 'orders', pageKeys: ['pg'], status: 'ok', body: { definition: { subscriptions: { main: { columns: [{ column: 'Region' }] } } } } };
	const pages = [{ key: 'pg', dashboard: 'D', layout: { content: [] } }];
	pageDefaultFilters(pages, [stack, member, filterCard]);
	assert.deepEqual(pages[0].filters.map((f) => [f.dataSourceId.$ref, f.sourceCard]), [['dataset:orders.stack-a', 'filter-region']]);
});
