import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards, buildCardBody, titleText, updateTimeToken, addSmartDescription, PLAIN_INTEGER_FORMAT, naturalOrderKey } from '../../src/convert/cards.js';
import { DS, DATASET, p, sheet, workbook, makeBindings, cat } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const PROFIT = p('sum', 'Profit', 'qk');
const REGION = p('none', 'Region');
const CATEGORY = p('none', 'Category');
const dsRef = { $ref: `dataset:${DATASET}` };
const NATURAL = (column) => "MIN(REGEXP_REPLACE(REGEXP_REPLACE(`" + column + "`, '[0-9]+', '0000000000$0'), '0*([0-9]{10})', '$1'))";
// Card formulas other than the category axis sort key.
const measureFormulas = (def) => def.formulas.card.filter((f) => !f.name.endsWith('(natural order)'));

function one(spec, { dashboards = [], parameters = [], bindings = makeBindings() } = {}) {
	const ws = sheet(spec);
	const ir = workbook({ worksheets: [ws], dashboards, parameters });
	const { cards, issues } = planCards(ir, bindings, { options: {} });
	return { card: cards[0], issues, main: cards[0]?.body.definition.subscriptions.main, def: cards[0]?.body.definition };
}

test('vertical bar: exact card update body', () => {
	const { card } = one({ name: 'Sales by Category', cols: CATEGORY, rows: SALES, mark: 'Bar' });
	assert.equal(card.key, 'sales-by-category');
	assert.equal(card.status, 'ok');
	assert.equal(card.chartType, 'badge_vert_bar');
	assert.deepEqual(card.body, {
		dataProvider: { dataSourceId: dsRef },
		variables: true,
		columns: false,
		definition: {
			title: 'Sales by Category',
			description: '',
			dynamicTitle: { text: [{ type: 'TEXT', text: 'Sales by Category' }] },
			chartVersion: '12',
			charts: { main: { component: 'main', chartType: 'badge_vert_bar', overrides: {}, goal: null } },
			subscriptions: {
				main: {
					name: 'main',
					dataSourceId: dsRef,
					columns: [
						{ column: 'Category', mapping: 'ITEM' },
						{ column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' }
					],
					groupBy: [{ column: 'Category' }],
					orderBy: [{ column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'ASCENDING' }],
					filters: [],
					fiscal: false,
					projection: false,
					distinct: false
				}
			},
			formulas: { card: [{ id: 'calculation_card_1', name: 'Category (natural order)', formula: NATURAL('Category'), templateId: -1, status: 'VALID', dataType: 'string', isCalculation: true, aggregated: true, persistedOnDataSource: false }], dsUpdated: [], dsDeleted: [] },
			annotations: { new: [], modified: [], deleted: [] },
			conditionalFormats: { card: [], datasource: [] },
			segments: { active: [], create: [], update: [], delete: [] },
			controls: [],
			allowTableDrill: true
		}
	});
	assert.deepEqual(card.bigNumber.columns, [{ column: 'Sales', aggregation: 'SUM', format: { type: 'abbreviated', format: '#' } }]);
});

test('monthly line: grain column with calendar on columns and groupBy, dateGrain on the raw column', () => {
	const { card, main } = one({ cols: p('tmn', 'Order Date', 'qk'), rows: SALES, enc: { color: [REGION] } });
	assert.equal(card.chartType, 'badge_two_trendline');
	assert.deepEqual(main.columns, [
		{ column: 'CalendarMonth', calendar: true, mapping: 'ITEM' },
		{ column: 'Region', mapping: 'SERIES' },
		{ column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' }
	]);
	assert.deepEqual(main.groupBy, [{ column: 'CalendarMonth', calendar: true }, { column: 'Region' }]);
	assert.deepEqual(main.dateGrain, { column: 'Order Date', dateTimeElement: 'MONTH' });
});

test('discrete year is a Year grain; nested year/quarter collapses to CalendarQuarter', () => {
	assert.deepEqual(one({ cols: p('yr', 'Order Date', 'ok'), rows: SALES }).main.dateGrain, { column: 'Order Date', dateTimeElement: 'YEAR' });
	const { main } = one({ cols: `${p('yr', 'Order Date', 'ok')} / ${p('qr', 'Order Date', 'ok')}`, rows: SALES });
	assert.equal(main.columns[0].column, 'CalendarQuarter');
	assert.deepEqual(main.dateGrain, { column: 'Order Date', dateTimeElement: 'QUARTER' });
});

test('discrete month part: MONTHNAME card formula as ITEM, ordered by a numeric month formula', () => {
	const { main, def } = one({ cols: p('mn', 'Order Date', 'ok'), rows: SALES, mark: 'Bar' });
	assert.deepEqual(def.formulas.card, [
		{ id: 'calculation_card_1', name: 'Order Date (Month)', formula: 'MONTHNAME(`Order Date`)', templateId: -1, status: 'VALID', dataType: 'string', isCalculation: true, aggregated: false, persistedOnDataSource: false },
		{ id: 'calculation_card_2', name: 'Order Date (Month order)', formula: 'MIN(MONTH(`Order Date`))', templateId: -1, status: 'VALID', dataType: 'numeric', isCalculation: true, aggregated: true, persistedOnDataSource: false }
	]);
	assert.deepEqual(main.columns[0], { column: 'calculation_card_1', formulaId: 'calculation_card_1', mapping: 'ITEM' });
	assert.deepEqual(main.groupBy, [{ column: 'calculation_card_1', formulaId: 'calculation_card_1' }]);
	assert.deepEqual(main.orderBy, [{ column: 'calculation_card_2', formulaId: 'calculation_card_2', order: 'ASCENDING' }]);
	assert.equal(main.dateGrain, undefined);
});

test('a second date grain on one card becomes a card formula', () => {
	const { main, def } = one({ rows: `${p('tyr', 'Order Date', 'qk')} / ${p('tmn', 'Ship Date', 'qk')}`, enc: { text: [SALES] } });
	assert.equal(main.columns[0].column, 'Year');
	assert.equal(def.formulas.card[0].formula, "DATE_FORMAT(`Ship Date`, '%Y-%m')");
	assert.deepEqual(main.dateGrain, { column: 'Order Date', dateTimeElement: 'YEAR' });
});

test('COUNTD becomes an aggregated card formula referenced by formulaId with no aggregation', () => {
	const { main, def } = one({ cols: CATEGORY, rows: p('ctd', 'Customer', 'qk'), mark: 'Bar' });
	assert.equal(def.formulas.card[0].formula, 'COUNT(DISTINCT `Customer`)');
	assert.equal(def.formulas.card[0].aggregated, true);
	assert.deepEqual(main.columns[1], { column: 'calculation_card_1', formulaId: 'calculation_card_1', mapping: 'VALUE' });
	assert.deepEqual(main.groupBy, [{ column: 'Category' }]);
});

test('variance and deviation pills: sample variance is a VAR card formula, the rest are exact card aggregations', () => {
	const sample = one({ cols: CATEGORY, rows: p('var', 'Sales', 'qk'), mark: 'Bar' });
	assert.equal(sample.def.formulas.card[0].formula, 'VAR(`Sales`)');
	assert.equal(sample.def.formulas.card[0].name, 'Variance of Sales');
	assert.equal(sample.def.formulas.card[0].aggregated, true);
	assert.deepEqual(sample.main.columns[1], { column: 'calculation_card_1', formulaId: 'calculation_card_1', mapping: 'VALUE' });
	assert.ok(!sample.issues.some((i) => i.code === 'card.aggregation'));
	for (const [derivation, aggregation] of [['varp', 'VAR_POP'], ['stdev', 'STDDEV'], ['stdevp', 'STDDEV_POP']]) {
		const exact = one({ cols: CATEGORY, rows: p(derivation, 'Sales', 'qk'), mark: 'Bar' });
		assert.deepEqual(exact.main.columns[1], { column: 'Sales', mapping: 'VALUE', aggregation }, derivation);
		assert.equal(measureFormulas(exact.def).length, 0, derivation);
		assert.ok(!exact.issues.some((i) => i.code === 'card.aggregation'), derivation);
	}
});

test('aggregated beast mode binding: formulaId, no extra aggregation, not grouped', () => {
	const { main, card } = one({ cols: CATEGORY, rows: p('usr', 'Profit Ratio', 'qk'), mark: 'Bar' });
	assert.deepEqual(main.columns[1], { column: 'calculation_pr', formulaId: 'calculation_pr', mapping: 'VALUE' });
	assert.deepEqual(main.groupBy, [{ column: 'Category' }]);
	assert.deepEqual(card.bigNumber.columns[0], { column: 'calculation_pr', formulaId: 'calculation_pr', format: { type: 'abbreviated', format: '#' } });
});

test('row-level beast mode measure gets the pill aggregation', () => {
	const { main } = one({ cols: CATEGORY, rows: p('avg', 'Sales (bin)', 'qk'), mark: 'Bar' });
	assert.deepEqual(main.columns[1], { column: 'calculation_bin', formulaId: 'calculation_bin', mapping: 'VALUE', aggregation: 'AVG' });
});

test('basic table: dimensions grouped, measures aggregated, all VALUE', () => {
	const { main, card } = one({ rows: `${CATEGORY} / ${REGION}`, enc: { text: [SALES] } });
	assert.equal(card.chartType, 'badge_basic_table');
	assert.deepEqual(main.columns, [
		{ column: 'Category', mapping: 'VALUE' },
		{ column: 'Region', mapping: 'VALUE' },
		{ column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' }
	]);
	assert.deepEqual(main.groupBy, [{ column: 'Category' }, { column: 'Region' }]);
	assert.equal(card.bigNumber, undefined);
});

test('KPI single value: no groupBy, summary number', () => {
	const { main, card } = one({ enc: { text: [SALES] } });
	assert.equal(card.chartType, 'badge_singlevalue');
	assert.deepEqual(main.groupBy, []);
	assert.equal(card.bigNumber.limit, 1);
	assert.deepEqual(card.bigNumber.groupBy, []);
});

test('histogram uses the raw bin source column and no groupBy', () => {
	const { main, card } = one({ cols: p('none', 'Sales (bin)', 'ok'), rows: p('cnt', 'Sales', 'qk') });
	assert.equal(card.chartType, 'badge_vert_histogram');
	assert.deepEqual(main.columns, [{ column: 'Sales', mapping: 'VALUE' }]);
	assert.deepEqual(main.groupBy, []);
});

test('gantt end date is a DATE_ADD card formula', () => {
	const { main, def } = one({ rows: CATEGORY, cols: p('tdy', 'Order Date', 'qk'), mark: 'GanttBar', enc: { size: [p('sum', 'Duration', 'qk')] } });
	assert.equal(def.formulas.card[0].formula, 'DATE_ADD(`Order Date`, INTERVAL `Duration` DAY)');
	assert.deepEqual(
		main.columns.map((c) => c.mapping),
		['ITEM', 'START_DATE', 'END_DATE']
	);
	assert.deepEqual(main.columns[1], { column: 'Order Date', mapping: 'START_DATE' });
});

test('detail dimensions are added to groupBy only', () => {
	const { main } = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { detail: [p('none', 'Segment')] } });
	assert.equal(main.columns.length, 2);
	assert.deepEqual(main.groupBy, [{ column: 'Category' }, { column: 'Segment' }]);
});

test('computed and alphabetic sorts become orderBy entries', () => {
	const { main } = one({ rows: CATEGORY, cols: SALES, mark: 'Bar', sorts: [{ pillId: CATEGORY, kind: 'computed', direction: 'DESC', using: SALES }] });
	assert.deepEqual(main.orderBy, [{ column: 'Sales', aggregation: 'SUM', order: 'DESCENDING' }]);
	const alpha = one({ rows: CATEGORY, cols: SALES, mark: 'Bar', sorts: [{ pillId: CATEGORY, kind: 'alphabetic', direction: 'ASC' }] });
	assert.deepEqual(alpha.main.orderBy, [{ column: 'Category', order: 'ASCENDING' }]);
});

const REGION_COLORS = { pillId: REGION, type: 'palette', members: [{ value: 'West', color: '#4e79a7' }, { value: 'East', color: '#e15759' }] };

test('a category axis that is not a date sorts by itself first, before the series sort', () => {
	const { main, def, card } = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, color: REGION_COLORS, sorts: [{ pillId: REGION, kind: 'manual', direction: 'ASC', order: ['West', 'East'] }] });
	assert.deepEqual(def.formulas.card.map((f) => [f.id, f.name, f.dataType]), [['calculation_card_1', 'Region (manual order)', 'numeric'], ['calculation_card_2', 'Category (natural order)', 'string']]);
	assert.equal(def.formulas.card[1].formula, NATURAL('Category'), 'digit runs padded, so "2023 P7" sorts before "2023 P10" as Tableau draws it');
	assert.deepEqual(main.orderBy.map((e) => [e.column, e.order]), [['calculation_card_1', 'DESCENDING'], ['calculation_card_2', 'ASCENDING']], 'the series rank fills the series slot, the axis key the category slot; reversed, so the first member stacks on top as in Tableau');
	assert.equal(card.chartType, 'badge_vert_stackedbar');
	assert.equal(card.body.definition.charts.main.overrides.legend_reverse_layout, 'true', 'the legend lists the series as Tableau does');
	const stacked = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, color: REGION_COLORS, sorts: [{ pillId: REGION, kind: 'manual', direction: 'DESC', order: ['West', 'East'] }] });
	assert.deepEqual(stacked.main.orderBy.map((e) => e.order), ['ASCENDING', 'ASCENDING']);
	const palette = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, sorts: [{ pillId: REGION, kind: 'manual', direction: 'ASC', order: ['West', 'East'] }] });
	assert.deepEqual([palette.main.orderBy.map((e) => e.order), palette.card.body.definition.charts.main.overrides.legend_reverse_layout], [['ASCENDING', 'ASCENDING'], undefined], 'with no color rule Phoenix colors by series order, so the rank is not reversed');
	assert.ok(palette.issues.some((i) => i.code === 'card.stack-order'));
	const lines = one({ cols: CATEGORY, rows: SALES, mark: 'Line', enc: { color: [REGION] }, sorts: [{ pillId: REGION, kind: 'manual', direction: 'ASC', order: ['West', 'East'] }] });
	assert.deepEqual([lines.main.orderBy.map((e) => e.order), lines.card.body.definition.charts.main.overrides.legend_reverse_layout], [['ASCENDING', 'ASCENDING'], undefined], 'lines keep the rank order and the legend');
	const sorted = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, sorts: [{ pillId: CATEGORY, kind: 'computed', direction: 'DESC', using: SALES }, { pillId: REGION, kind: 'alphabetic', direction: 'DESC' }] });
	assert.deepEqual(sorted.main.orderBy, [{ column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'DESCENDING' }, { column: 'Region', order: 'DESCENDING' }], 'its own Tableau sort orders the categories, first; a sort on the series column orders the series wherever it is');
	assert.deepEqual(sorted.def.formulas.card.map((f) => [f.name, f.formula]), [['Category (sort by Sales)', 'MAX(SUM(`Sales`) FIXED (BY `Category`))']], 'a sort equal to the VALUE column would turn second-level sorting off, so the axis sorts by the measure over each category');
	const unsorted = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, color: REGION_COLORS });
	assert.deepEqual(unsorted.def.formulas.card.map((f) => [f.name, f.formula]), [['Region (natural order)', NATURAL('Region')], ['Category (natural order)', NATURAL('Category')]]);
	assert.deepEqual(unsorted.main.orderBy.map((e) => [e.column, e.order]), [['calculation_card_1', 'DESCENDING'], ['calculation_card_2', 'ASCENDING']], 'the series key first takes the series slot (members in natural order, reversed so the first stacks on top), the axis key the category slot');
	assert.equal(unsorted.card.body.definition.charts.main.overrides.legend_reverse_layout, 'true');
	const unpinned = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] } });
	assert.deepEqual([unpinned.main.orderBy.map((e) => e.order), unpinned.card.body.definition.charts.main.overrides.legend_reverse_layout], [['ASCENDING', 'ASCENDING'], undefined]);
	const sideBySide = one({ cols: `${CATEGORY} / ${REGION}`, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, color: REGION_COLORS });
	assert.deepEqual([sideBySide.card.chartType, sideBySide.main.orderBy.map((e) => e.order), sideBySide.card.body.definition.charts.main.overrides.legend_reverse_layout], ['badge_vert_multibar', ['ASCENDING', 'ASCENDING'], undefined], 'a multibar keeps the natural order and its legend');
	const horizontal = one({ rows: CATEGORY, cols: SALES, mark: 'Bar', enc: { color: [REGION] }, color: REGION_COLORS });
	assert.deepEqual([horizontal.card.chartType, horizontal.main.orderBy.map((e) => e.order), horizontal.card.body.definition.charts.main.overrides.legend_reverse_layout], ['badge_horiz_stackedbar', ['ASCENDING', 'ASCENDING'], undefined]);
	const computedSeries = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, sorts: [{ pillId: REGION, kind: 'computed', direction: 'DESC', using: SALES }] });
	assert.deepEqual(computedSeries.main.orderBy.map((e) => e.column), ['calculation_card_1'], 'the stack sort option orders the segments, so the series gets no sort of its own');
	assert.equal(computedSeries.def.charts.main.overrides.category_sort_method, 'Ascending');
	assert.equal(computedSeries.def.formulas.card[0].name, 'Category (natural order)');
	assert.ok(computedSeries.issues.some((i) => i.code === 'chart.stack-sort'));
	assert.ok(!computedSeries.issues.some((i) => i.code === 'card.sort-order'));
	assert.equal(measureFormulas(sorted.def).length, sorted.def.formulas.card.length);
	const byColumn = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] }, sorts: [{ pillId: REGION, kind: 'manual', direction: 'ASC', order: ['West'] }, { pillId: CATEGORY, kind: 'alphabetic', direction: 'ASC' }] });
	assert.deepEqual(byColumn.main.orderBy[0], { column: 'Category', order: 'ASCENDING' }, 'the ITEM column itself orders the categories wherever it is, so it goes first');
	const line = one({ cols: CATEGORY, rows: SALES, mark: 'Line' });
	assert.equal(line.def.formulas.card[0].name, 'Category (natural order)');
	assert.deepEqual(one({ cols: CATEGORY, rows: SALES, mark: 'Line', sorts: [{ pillId: CATEGORY, kind: 'manual', direction: 'ASC', order: ['B', 'A'] }] }).main.orderBy.length, 1);
	const numeric = one({ cols: p('none', 'Quantity', 'ok'), rows: SALES, mark: 'Bar' });
	assert.deepEqual([numeric.main.orderBy, numeric.def.formulas.card], [[{ column: 'Quantity', order: 'ASCENDING' }], []], 'a number axis sorts by its value');
});

test('date axes, tables and pies get no category sort', () => {
	assert.deepEqual(one({ cols: p('tmn', 'Order Date', 'qk'), rows: SALES, mark: 'Bar' }).main.orderBy, []);
	assert.deepEqual(one({ cols: p('tdy', 'Order Date', 'qk'), rows: SALES, mark: 'Bar', enc: { color: [CATEGORY] } }).main.orderBy, []);
	assert.deepEqual(one({ rows: `${CATEGORY} / ${REGION}`, enc: { text: [SALES] } }).main.orderBy, []);
	assert.deepEqual(one({ mark: 'Pie', enc: { color: [CATEGORY], size: [SALES] } }).main.orderBy, []);
});

test('manual sort becomes an aggregated CASE formula', () => {
	const { main, def } = one({ rows: CATEGORY, cols: SALES, mark: 'Bar', sorts: [{ pillId: CATEGORY, kind: 'manual', direction: 'ASC', order: ['Technology', "O'Brien"] }] });
	assert.equal(def.formulas.card[0].formula, "MIN(CASE WHEN `Category` = 'Technology' THEN 1 WHEN `Category` = 'O''Brien' THEN 2 ELSE 3 END)");
	assert.deepEqual(main.orderBy, [{ column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'ASCENDING' }]);
});

test('Top N filter becomes orderBy + limit', () => {
	const customer = p('none', 'Customer');
	const { main, card } = one({
		rows: customer,
		cols: SALES,
		mark: 'Bar',
		filters: [{ pillId: customer, datasourceId: DS, fieldId: '[Customer]', kind: 'top', top: { count: 10, direction: 'top', by: 'SUM([Sales])' } }]
	});
	assert.equal(main.limit, 10);
	assert.deepEqual(main.orderBy, [{ column: 'Sales', order: 'DESCENDING', aggregation: 'SUM' }, { column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'ASCENDING' }], 'the ranking stays first so the limit keeps the top members');
	assert.deepEqual(main.filters, []);
	assert.equal(card.status, 'ok');
});

test('a Top N with a measure filter warns that Domo limits after HAVING', () => {
	const customer = p('none', 'Customer');
	const top = { pillId: customer, datasourceId: DS, fieldId: '[Customer]', kind: 'top', top: { count: 10, direction: 'top', by: 'SUM([Sales])' } };
	const profit = { pillId: p('sum', 'Profit', 'qk'), datasourceId: DS, fieldId: '[Profit]', kind: 'quantitative', aggregated: true, min: 0 };
	assert.ok(one({ rows: customer, cols: SALES, mark: 'Bar', filters: [top, profit] }).issues.some((i) => i.code === 'filter.top-order'));
	assert.ok(!one({ rows: customer, cols: SALES, mark: 'Bar', filters: [top] }).issues.some((i) => i.code === 'filter.top-order'));
	const other = one({ rows: customer, cols: SALES, mark: 'Bar', filters: [top, cat('Region', ['East'])] }).issues.find((i) => i.code === 'filter.top-order');
	assert.match(other.message, /ranks the members before the sheet's other filters/, 'without a Magic ETL rank column the row limit re-ranks inside the other filters');
});

test('card-level filters and relative date land on the subscription', () => {
	const { main } = one({
		cols: CATEGORY,
		rows: SALES,
		mark: 'Bar',
		filters: [cat('Region', ['East']), { pillId: p('none', 'Order Date', 'qk'), datasourceId: DS, fieldId: '[Order Date]', kind: 'relative-date', relative: { periodType: 'year', first: 0, last: 0 } }]
	});
	assert.deepEqual(main.filters, [{ column: 'Region', operand: 'IN', values: ['East'], dataType: 'string', filterType: 'COLUMN_ID' }]);
	assert.deepEqual(main.dateRangeFilter.dateTimeRange, { dateTimeRangeType: 'INTERVAL_OFFSET', interval: 'YEAR', offset: 0, count: 0 });
});

test('filters shown on a dashboard become quick-filter controls instead of card filters', () => {
	const region = cat('Region', ['East', 'West']);
	const dashboards = [
		{
			name: 'Dash',
			size: { mode: 'fixed', width: 1200, height: 800 },
			zones: [
				{ id: '1', kind: 'worksheet', worksheet: 'Sheet 1', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false },
				{ id: '2', kind: 'filter', worksheet: 'Sheet 1', param: region.pillId, mode: 'checkdropdown', rect: { x: 0, y: 0, w: 0.2, h: 0.1 }, floating: false },
				{ id: '3', kind: 'filter', worksheet: 'Sheet 1', param: p('none', 'Segment'), mode: 'radiolist', rect: { x: 0, y: 0, w: 0.2, h: 0.1 }, floating: false }
			],
			floating: []
		}
	];
	const { card, main, def, issues } = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', filters: [region] }, { dashboards });
	assert.deepEqual(main.filters, []);
	assert.deepEqual(def.controls, [
		{ controlType: 'SLICER', column: 'Region', name: 'Region', columnDisplayName: 'Region', type: 'string', displayType: 'multiple_select', operator: 'IN', values: [], collapsed: false, dataSourceId: dsRef },
		{ controlType: 'SLICER', column: 'Segment', name: 'Segment', columnDisplayName: 'Segment', type: 'string', displayType: 'single_select', operator: 'IN', values: [], collapsed: false, dataSourceId: dsRef }
	]);
	assert.deepEqual(card.quickFilterDefaults, [{ column: 'Region', name: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], pillIds: [region.pillId] }], 'the Tableau selection is a page default, not a card default');
	assert.ok(issues.some((i) => i.code === 'filter.interactive'));
});

test('IR 15: card quick filters are the worksheet window filter cards; a dashboard-only selection waits for the view', () => {
	const region = cat('Region', ['East', 'West']);
	const category = cat('Category', ['Furniture']);
	const segment = cat('Segment', ['Consumer']);
	const zone = (id, param) => ({ id, kind: 'filter', worksheet: 'Sheet 1', param, rect: { x: 0, y: 0, w: 0.2, h: 0.1 }, floating: false });
	const dashboards = [{ name: 'Dash', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [{ id: '1', kind: 'worksheet', worksheet: 'Sheet 1', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false }, zone('2', region.pillId), zone('3', p('none', 'Customer'))], floating: [] }];
	const ws = { ...sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar', filters: [region, category, segment] }), quickFilters: [{ pillId: category.pillId, mode: 'radiolist' }] };
	const ir = { ...workbook({ worksheets: [ws], dashboards }), irVersion: 15 };
	const { cards, issues } = planCards(ir, makeBindings(), { options: {} });
	const def = cards[0].body.definition;
	assert.deepEqual(def.controls.map((c) => [c.column, c.displayType, c.values]), [['Category', 'single_select', ['Furniture']]], 'the worksheet quick filter keeps its selection: no dashboard filter card controls it');
	assert.deepEqual(def.subscriptions.main.filters, [{ column: 'Segment', operand: 'IN', values: ['Consumer'], dataType: 'string', filterType: 'COLUMN_ID' }], 'a filter neither the sheet nor a dashboard shows stays fixed');
	assert.deepEqual(cards[0].quickFilterDefaults, [
		{ column: 'Region', name: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], pillIds: [region.pillId], fixed: [{ column: 'Region', operand: 'IN', values: ['East', 'West'], dataType: 'string', filterType: 'COLUMN_ID' }] }
	]);
	assert.ok(issues.some((i) => i.code === 'filter.dashboard-only' && /^2 filter/.test(i.message)));
	const older = planCards({ ...ir, irVersion: 14 }, makeBindings(), { options: {} }).cards[0].body.definition.controls;
	assert.deepEqual(older.map((c) => c.column), ['Region', 'Customer'], 'an older IR keeps every dashboard filter as a quick filter');
});

test('IR 15: more than 20 worksheet filter cards keep the rest as fixed card filters', () => {
	const filters = Array.from({ length: 21 }, (_, i) => cat(`F${i}`, ['x']));
	const bindings = makeBindings(Object.fromEntries(filters.map((f) => [f.fieldId, { datasetKey: DATASET, kind: 'column', name: f.fieldId.slice(1, -1), column: f.fieldId.slice(1, -1), aggregated: false, dataType: 'STRING', tableauType: 'string' }])));
	const ws = { ...sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar', filters }), quickFilters: filters.map((f) => ({ pillId: f.pillId })) };
	const { cards, issues } = planCards({ ...workbook({ worksheets: [ws] }), irVersion: 15 }, bindings, { options: {} });
	assert.ok(issues.some((i) => i.code === 'filter.slicer-count' && /F20/.test(i.message)));
	assert.equal(cards[0].body.definition.controls.length, 20);
	assert.deepEqual(cards[0].body.definition.subscriptions.main.filters.map((f) => f.column), ['F20']);
});

test('a quick filter over the 50-value slicer limit keeps its selection as a fixed card filter', () => {
	const many = Array.from({ length: 60 }, (_, i) => `R${i}`);
	const region = cat('Region', undefined, { exclude: many });
	const dashboards = [
		{
			name: 'Dash',
			size: { mode: 'fixed', width: 1200, height: 800 },
			zones: [
				{ id: '1', kind: 'worksheet', worksheet: 'Sheet 1', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false },
				{ id: '2', kind: 'filter', worksheet: 'Sheet 1', param: region.pillId, mode: 'checkdropdown', rect: { x: 0, y: 0, w: 0.2, h: 0.1 }, floating: false }
			],
			floating: []
		}
	];
	const { main, def, card, issues } = one({ cols: CATEGORY, rows: SALES, mark: 'Bar', filters: [region] }, { dashboards });
	assert.deepEqual(main.filters, [{ column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' }]);
	assert.match(def.formulas.card[0].formula, /^CASE WHEN \(`Region` IS NULL OR `Region` NOT IN \('R0', 'R1', /, 'the exclude list keeps the null rows Tableau keeps');
	assert.equal(def.controls[0].operator, 'NOT_IN');
	assert.deepEqual(def.controls[0].values, []);
	assert.equal(issues.find((i) => i.code === 'filter.slicer-limit').severity, 'warning');
	assert.equal(card.status, 'approximate');
});

test('unsupported bindings are dropped and mark the card approximate', () => {
	const { main, card, issues } = one({ rows: `${CATEGORY} / ${p('none', 'Broken')}`, enc: { text: [SALES] } });
	assert.equal(card.status, 'approximate');
	assert.equal(main.columns.length, 2);
	assert.ok(issues.some((i) => i.code === 'card.unsupported-field'));
});

test('a chart that loses its ITEM falls back to a table', () => {
	const { card, issues } = one({ cols: p('none', 'Broken'), rows: SALES, mark: 'Bar' });
	assert.equal(card.chartType, 'badge_basic_table');
	assert.ok(issues.some((i) => i.code === 'chart.fallback'));
});

test('two measures on a bar become a multi-series card with no VALUE and no summary number', () => {
	const { card, main } = one({ rows: REGION, cols: `${p('ctd', 'Customer', 'qk')} + ${SALES}`, mark: 'Bar' });
	assert.equal(card.chartType, 'badge_horiz_multibar');
	assert.deepEqual(
		main.columns.map((c) => [c.mapping, c.column]),
		[
			['ITEM', 'Region'],
			['SERIES', 'calculation_card_1'],
			['SERIES', 'Sales']
		]
	);
	assert.deepEqual(main.groupBy, [{ column: 'Region' }]);
	assert.equal(card.bigNumber, undefined);
});

test('a multi-series card left with one measure series turns it back into the VALUE', () => {
	const broken = { datasetKey: 'superstore', kind: 'unsupported', name: 'Profit', aggregated: false, reason: 'table calc' };
	const { card, main } = one({ cols: CATEGORY, rows: `${SALES} + ${PROFIT}`, mark: 'Bar' }, { bindings: makeBindings({ '[Profit]': broken }) });
	assert.equal(card.chartType, 'badge_vert_bar');
	assert.deepEqual(
		main.columns.map((c) => [c.mapping, c.column]),
		[
			['ITEM', 'Category'],
			['VALUE', 'Sales']
		]
	);
});

test('no usable fields makes the card unsupported', () => {
	const { card } = one({ cols: p('none', 'Broken'), mark: 'Text' });
	assert.equal(card.status, 'unsupported');
});

test('hidden worksheets are skipped unless a dashboard uses them; keys are unique', () => {
	const a = sheet({ name: 'Hidden', cols: CATEGORY, rows: SALES, hidden: true });
	const b = sheet({ name: 'Used', cols: CATEGORY, rows: SALES, hidden: true });
	const c = sheet({ name: 'used', cols: CATEGORY, rows: PROFIT });
	const dash = { name: 'D', size: { mode: 'automatic' }, zones: [{ id: '1', kind: 'worksheet', worksheet: 'Used', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false }], floating: [] };
	const { cards, issues } = planCards(workbook({ worksheets: [a, b, c], dashboards: [dash] }), makeBindings());
	assert.deepEqual(
		cards.map((x) => x.key),
		['used', 'used-2']
	);
	assert.ok(issues.some((i) => i.code === 'card.hidden-sheet' && i.object.name === 'Hidden'));
});

test('worksheets without a dataset are skipped with an error', () => {
	const ws = { ...sheet({ cols: CATEGORY, rows: SALES }), datasourceIds: ['federated.other'] };
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings());
	assert.equal(cards.length, 0);
	assert.equal(issues[0].code, 'card.no-dataset');
});

test('an empty worksheet without a datasource is noted and skipped', () => {
	const ws = { ...sheet({ name: 'Sheet 9' }), datasourceIds: [] };
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings());
	assert.equal(cards.length, 0);
	assert.deepEqual(
		issues.map((i) => [i.severity, i.code]),
		[['info', 'card.empty-sheet']]
	);
});

test('a worksheet that only shows its title gets an unsupported card and an info, not an error', () => {
	const { card, issues } = one({ name: 'Refresh', title: 'Refresh Date: <Data Update Time>' });
	assert.equal(card.status, 'unsupported');
	assert.equal(card.title, 'Refresh');
	assert.deepEqual(
		issues.map((i) => [i.severity, i.code]),
		[['info', 'card.title-only']]
	);
	assert.match(issues[0].message, /becomes a text card at the top of each view that shows it, with its data update time as "Date last updated" smart text/);
});

test('shape buttons and parameter labels are warnings without a card', () => {
	const button = one({ name: 'info button', mark: 'Shape', enc: { shape: [p('none', 'Region')] } });
	assert.equal(button.card.status, 'unsupported');
	assert.deepEqual(
		button.issues.map((i) => [i.severity, i.code]),
		[['warning', 'card.ui-sheet']]
	);
	const label = one({ name: 'Label', mark: 'Text', enc: { text: ['[Parameters].[none:Choice:nk]'] } });
	assert.equal(label.card.status, 'unsupported');
	assert.deepEqual(
		label.issues.map((i) => i.code),
		['card.parameter-label']
	);
});

test('a worksheet with fields that all fail to convert is still an error', () => {
	const { card, issues } = one({ name: 'Broken', mark: 'Text', enc: { text: [p('usr', 'Broken', 'nk')] } });
	assert.equal(card.status, 'unsupported');
	assert.ok(issues.some((i) => i.severity === 'error' && i.code === 'card.empty'));
});

test('buildCardBody includes limit, dateGrain and dateRangeFilter only when set', () => {
	const body = buildCardBody({ title: 'T', datasetKey: 'd', chartType: 'badge_table', subscription: { columns: [], limit: 5 } });
	assert.equal(body.definition.subscriptions.main.limit, 5);
	assert.equal('dateGrain' in body.definition.subscriptions.main, false);
	assert.equal('dateRangeFilter' in body.definition.subscriptions.main, false);
});

test('Tableau table row counts become a SUM(1) card formula', () => {
	const { main, def } = one({ cols: CATEGORY, rows: `[${DS}].[__tableau_internal_object_id__].[cnt:Orders_A1B2C3D4E5F60718293A4B5C6D7E8F90:qk]`, mark: 'Bar' });
	assert.equal(def.formulas.card[0].formula, 'SUM(1)');
	assert.equal(def.formulas.card[0].name, 'Orders (Count)');
	assert.deepEqual(main.columns[1], { column: 'calculation_card_1', formulaId: 'calculation_card_1', mapping: 'VALUE' });
});

test('percent of total quick table calc becomes a FIXED card formula', () => {
	const { main, def, issues } = one({ cols: CATEGORY, rows: p('pcto:sum', 'Sales', 'qk'), mark: 'Bar' });
	const value = main.columns.find((c) => c.mapping === 'VALUE');
	assert.ok(value.formulaId);
	const formula = def.formulas.card.find((f) => f.id === value.formulaId);
	assert.equal(formula.formula, 'SUM(`Sales`) / NULLIF(SUM(SUM(`Sales`) FIXED ()), 0)');
	assert.ok(!issues.some((i) => i.code === 'card.table-calc' && i.severity === 'warning'));
});

test('bare LOD beast modes: avg/min/countd pills get a card formula with that outer aggregation, sum keeps the beast mode', () => {
	const lod = 'SUM(`Sales`) FIXED (BY `Region`)';
	const bindings = makeBindings({
		'[Profit]': { datasetKey: DATASET, kind: 'formula', name: 'Region Sales', formulaId: 'calculation_lod', expression: `SUM(${lod})`, lodExpression: lod, aggregated: true, dataType: 'DOUBLE', tableauType: 'real' }
	});
	const avg = one({ cols: CATEGORY, rows: p('avg', 'Profit', 'qk'), mark: 'Bar' }, { bindings });
	const formula = avg.def.formulas.card.find((f) => f.formula === `AVG(${lod})`);
	assert.ok(formula, JSON.stringify(avg.def.formulas.card));
	assert.equal(formula.name, 'AVG of Region Sales');
	assert.deepEqual(avg.main.columns.at(-1), { column: formula.id, formulaId: formula.id, mapping: 'VALUE' });
	assert.ok(avg.issues.some((i) => i.code === 'card.lod-outer-aggregation'));

	const countd = one({ cols: CATEGORY, rows: p('ctd', 'Profit', 'qk'), mark: 'Bar' }, { bindings });
	assert.ok(countd.def.formulas.card.some((f) => f.formula === `COUNT(DISTINCT ${lod})`));
	const variance = one({ cols: CATEGORY, rows: p('var', 'Profit', 'qk'), mark: 'Bar' }, { bindings });
	assert.ok(variance.def.formulas.card.some((f) => f.formula === `VAR(${lod})` && f.name === 'Variance of Region Sales'));

	for (const prefix of ['sum', 'usr']) {
		const kept = one({ cols: CATEGORY, rows: p(prefix, 'Profit', 'qk'), mark: 'Bar' }, { bindings });
		assert.equal(measureFormulas(kept.def).length, 0, prefix);
		assert.equal(kept.main.columns.at(-1).formulaId, 'calculation_lod');
	}
});

test('quick table calcs become window card formulas (unless window functions are off) when their dimensions are on the card', () => {
	const runSpec = { cols: CATEGORY, rows: p('cum:sum', 'Sales', 'qk'), mark: 'Bar' };
	const bindings = makeBindings();
	const ws = sheet(runSpec);
	ws.pills[p('cum:sum', 'Sales', 'qk')].tableCalc.orderingType = 'Rows';
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), bindings, { options: { useWindowFunctions: true } });
	const def = cards[0].body.definition;
	const value = def.subscriptions.main.columns.find((c) => c.mapping === 'VALUE');
	const formula = def.formulas.card.find((f) => f.id === value.formulaId);
	assert.match(formula.formula, /^SUM\(SUM\(`Sales`\)\) OVER \(ORDER BY `Category`/);
	assert.equal(formula.name, 'Running total of Sales');
	assert.ok(!issues.some((i) => i.code === 'card.table-calc' && i.severity === 'warning'));

	const off = planCards(workbook({ worksheets: [ws] }), bindings, { options: { useWindowFunctions: false } });
	assert.ok(off.issues.some((i) => i.code === 'card.table-calc' && /--no-window-functions/.test(i.message)));

	const hidden = sheet({ ...runSpec, enc: { tooltip: [REGION] } });
	hidden.pills[p('cum:sum', 'Sales', 'qk')].tableCalc.orderingType = 'Rows';
	const missing = planCards(workbook({ worksheets: [hidden] }), bindings, { options: { useWindowFunctions: true } });
	assert.ok(missing.issues.some((i) => i.code === 'card.table-calc' && /addresses Region, which the card does not show/.test(i.message)));
});

test('a Pareto line (% of Total of a Running Sum) follows the bars sorted by their measure', () => {
	const count = p('ctd', 'Region', 'qk');
	const pareto = p('pcto:cum:ctd', 'Region', 'qk');
	const ws = sheet({
		cols: CATEGORY,
		rows: `(${count} + ${pareto})`,
		panes: [
			{ markClass: 'Bar', yAxisPill: count, encodings: {} },
			{ markClass: 'Line', yAxisPill: pareto, encodings: {} }
		],
		sorts: [{ pillId: CATEGORY, kind: 'computed', direction: 'DESC', using: count }]
	});
	ws.pills[pareto].tableCalc = { type: 'CumTotal', orderingType: 'Rows', attrs: { prefix: 'pcto:cum', aggregation: 'Sum' }, secondary: { type: 'PctTotal', orderingType: 'Rows' } };
	ws.numberFormats = { [pareto]: 'p0%' };
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: { useWindowFunctions: true } });
	const def = cards[0].body.definition;
	const formula = def.formulas.card.find((f) => f.name.startsWith('% of Total'));
	assert.equal(formula.name, '% of Total Running Sum of Distinct count of Region');
	assert.equal(
		formula.formula,
		'(SUM(COUNT(DISTINCT `Region`)) OVER (ORDER BY COUNT(DISTINCT `Region`) DESC, `Category` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) / NULLIF(SUM(COUNT(DISTINCT `Region`)) OVER (), 0)'
	);
	const column = def.subscriptions.main.columns.find((c) => c.formulaId === formula.id);
	assert.equal(column.format.type, 'percent');
	assert.deepEqual(def.subscriptions.main.orderBy.at(-1), { column: 'Category', order: 'ASCENDING' });
	assert.ok(!issues.some((i) => i.code === 'card.table-calc' && i.severity === 'warning'), JSON.stringify(issues));
});

test('quick table calcs on VAR and COUNTD pills wrap their card formula instead of dropping the calc', () => {
	const bindings = makeBindings();
	const plan = (derivation, orderingType, useWindowFunctions = true) => {
		const ws = sheet({ cols: CATEGORY, rows: p(derivation, 'Sales', 'qk'), mark: 'Bar' });
		if (orderingType) ws.pills[p(derivation, 'Sales', 'qk')].tableCalc.orderingType = orderingType;
		const { cards, issues } = planCards(workbook({ worksheets: [ws] }), bindings, { options: { useWindowFunctions } });
		const def = cards[0].body.definition;
		const value = def.subscriptions.main.columns.find((c) => c.mapping === 'VALUE');
		return { formula: def.formulas.card.find((f) => f.id === value.formulaId), issues };
	};
	const running = plan('cum:var', 'Rows');
	assert.match(running.formula.formula, /^SUM\(VAR\(`Sales`\)\) OVER \(ORDER BY `Category` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\)$/);
	assert.equal(running.formula.name, 'Running total of Variance of Sales');
	assert.match(plan('cum:ctd', 'Rows').formula.formula, /^SUM\(COUNT\(DISTINCT `Sales`\)\) OVER \(ORDER BY `Category`/);
	assert.equal(plan('pcto:var').formula.formula, 'VAR(`Sales`) / NULLIF(SUM(VAR(`Sales`)) OVER (), 0)');

	const off = plan('cum:var', 'Rows', false);
	assert.equal(off.formula.formula, 'VAR(`Sales`)');
	assert.ok(off.issues.some((i) => i.code === 'card.table-calc' && i.severity === 'warning' && /--no-window-functions/.test(i.message)));
});

test('a table calc formula pill uses its beast mode without a quick table calc warning', () => {
	const pillId = p('usr', 'Profit Ratio', 'qk');
	const ws = sheet({ cols: CATEGORY, rows: pillId, mark: 'Bar' });
	ws.pills[pillId].tableCalc = { type: 'Calculation', orderingType: 'Field', orderFields: [CATEGORY] };
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: { useWindowFunctions: true } });
	const value = cards[0].body.definition.subscriptions.main.columns.find((c) => c.mapping === 'VALUE');
	assert.equal(value.formulaId, 'calculation_pr');
	assert.equal(measureFormulas(cards[0].body.definition).length, 0);
	assert.ok(!issues.some((i) => i.code === 'card.table-calc'), JSON.stringify(issues));
	assert.equal(cards[0].status, 'ok');
});

const GRAIN_PARAM = {
	id: '[Parameters].[Created / Closed Date (copy)_1430]',
	name: 'Date granularity',
	datatype: 'string',
	domain: 'list',
	value: 'Fiscal Period',
	members: [{ value: 'Year', alias: 'Fiscal Year' }, { value: 'Fiscal Period' }]
};
const GRAIN_CALC = {
	id: '[Calculation_2265]',
	name: 'TitleGranularityDisplay',
	datatype: 'string',
	role: 'dimension',
	kind: 'calculated',
	formula: "if [Parameters].[Created / Closed Date (copy)_1430] ='Year' then 'Y'\nELSEIF [Parameters].[Created / Closed Date (copy)_1430] ='Fiscal Period' then 'FP'\nEND"
};
const titleIr = () => {
	const ir = workbook({ parameters: [GRAIN_PARAM] });
	ir.datasources[0].fields = [...ir.datasources[0].fields, GRAIN_CALC];
	return ir;
};

test('field tokens in a title are left out with the word they are glued to, never named', () => {
	assert.equal(titleText(`<${REGION}> by Industry`, makeBindings()), 'Industry');
	assert.equal(titleText(`Sales for <${REGION}>`, makeBindings()), 'Sales');
	assert.equal(titleText(`Sales (<${REGION}>) - Total`, makeBindings()), 'Sales - Total');
	assert.equal(titleText(`Closed Cases with  <${REGION}>o<${REGION}>`, makeBindings()), 'Closed Cases');
	assert.equal(titleText('Owner | Refreshed: <Data Update Time>', makeBindings()), 'Owner | Refreshed');
	assert.equal(titleText(`Sales: <${SALES}>  Region: <${REGION}>`, makeBindings()), 'Sales, Region');
	assert.equal(titleText(`Sales: <${SALES}> | Region: <${REGION}>`, makeBindings()), 'Sales | Region');
	assert.equal(titleText('Date Refreshed:<Data Update Time>', makeBindings()), 'Date Refreshed');
	assert.equal(titleText(`By Region - <${REGION}>`, makeBindings()), 'By Region');
	assert.equal(titleText(`Cases ( <${REGION}> o <${REGION}>)`, makeBindings()), 'Cases (o)');
	assert.equal(titleText('<Default Title> by month', makeBindings(), { sheetName: 'Sales' }), 'Sales by month');
	assert.equal(titleText('Age < 30 days > 10', makeBindings()), 'Age < 30 days > 10');
});

test('parameter tokens in a title become the current value, and calcs of parameters only are evaluated', () => {
	const ir = titleIr();
	assert.equal(titleText('Top <[Parameters].[Created / Closed Date (copy)_1430]> view', makeBindings(), { ir }), 'Top Fiscal Period view');
	ir.parameters[0] = { ...GRAIN_PARAM, value: 'Year' };
	assert.equal(titleText('Top <[Parameters].[Created / Closed Date (copy)_1430]>', makeBindings(), { ir }), 'Top Fiscal Year');
	const token = `<[${DS}].[attr:Calculation_2265:nk]>`;
	assert.equal(titleText(`Closed Cases with  ${token}o${token}`, makeBindings(), { ir }), 'Closed Cases with YoY');
});

test('a title calc reads a data field before a parameter of the same name, and a summed constant is data', () => {
	const ir = titleIr();
	ir.parameters.push({ id: '[Parameters].[Parameter 2]', name: 'Region', datatype: 'string', value: 'West' });
	const calc = (id, formula) => ({ id: `[${id}]`, name: id, datatype: 'string', role: 'dimension', kind: 'calculated', formula });
	ir.datasources[0].fields = [...ir.datasources[0].fields, calc('Team', 'IF [Region] = "West" THEN "West team" ELSE "Other" END'), calc('One', '1'), calc('Pick', 'IF [Parameters].[Parameter 2] = "West" THEN "West team" ELSE "Other" END')];
	assert.ok(ir.datasources[0].fields.some((f) => f.id === '[Region]'));
	assert.equal(titleText(`Sales <[${DS}].[none:Team:nk]>`, makeBindings(), { ir }), 'Sales');
	assert.equal(titleText(`Sales <[${DS}].[none:Pick:nk]>`, makeBindings(), { ir }), 'Sales West team');
	assert.equal(titleText(`Records: <[${DS}].[sum:One:qk]>`, makeBindings(), { ir }), 'Records');
	assert.equal(titleText(`Records: <[${DS}].[cnt:One:qk]>`, makeBindings(), { ir }), 'Records');
	assert.equal(titleText(`Level <[${DS}].[attr:One:nk]>`, makeBindings(), { ir }), 'Level 1');
});

test('card titles report dropped measure tokens and fixed parameter values as info issues', () => {
	const token = `<[${DS}].[attr:Calculation_2265:nk]>`;
	const ws = sheet({ name: 'Close cases with YOY', cols: CATEGORY, rows: SALES, mark: 'Bar', title: `Closed Cases with  ${token}o${token}\nfor <${SALES}>` });
	const ir = titleIr();
	ir.worksheets = [ws];
	const { cards, issues } = planCards(ir, makeBindings());
	assert.equal(cards[0].title, 'Closed Cases with FPoFP');
	assert.equal(cards[0].body.definition.description, '');
	assert.equal(cards[0].status, 'ok');
	const title = issues.filter((i) => i.code.startsWith('card.title-'));
	assert.deepEqual(title.map((i) => [i.severity, i.code]), [['info', 'card.title-field'], ['info', 'card.title-parameter']]);
	assert.match(title[0].message, /Sales/);
	assert.match(title[1].message, /TitleGranularityDisplay = FP/);
});

test('a dimension token in a card title is FILTER smart text on its column, <Data Source Name> the dataset name', () => {
	const ws = sheet({ name: 'By region', cols: CATEGORY, rows: SALES, mark: 'Bar', title: `By Region - <${REGION}>\nFrom <Data Source Name>` });
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings());
	const def = cards[0].body.definition;
	assert.equal(cards[0].title, 'By Region - All');
	assert.deepEqual(def.dynamicTitle.text, [{ type: 'TEXT', text: 'By Region - ' }, { type: 'FILTER', columns: ['Region'], defaultText: 'All' }]);
	assert.equal(def.description, 'From Orders');
	assert.deepEqual(def.dynamicDescription.text, [{ type: 'TEXT', text: 'From ' }, { type: 'DATA_SOURCE_NAME' }]);
	assert.deepEqual(issues.filter((i) => i.code.startsWith('card.title-')).map((i) => i.code), ['card.title-filter']);
	assert.equal(titleText(`By Region - <${REGION}>`, makeBindings()), 'By Region', 'headers and other static titles still leave the field out');
});

test('a title parameter planned as a Domo variable is a VARIABLE_VALUE item, with the alias as its default text', () => {
	const PARAM = '<[Parameters].[Created / Closed Date (copy)_1430]>';
	const ws = sheet({ name: 'By grain', cols: CATEGORY, rows: SALES, mark: 'Bar', title: `By ${PARAM} (End of Period)\nShown per ${PARAM}\nUpdated <Data Update Time>` });
	const ir = titleIr();
	ir.parameters[0] = { ...GRAIN_PARAM, value: 'Year' };
	ir.worksheets = [ws];
	const variables = [{ key: 'param.date-granularity.string', parameter: { id: GRAIN_PARAM.id } }];
	const { cards, issues } = planCards(ir, makeBindings(), { variables });
	const def = cards[0].body.definition;
	const item = { type: 'VARIABLE_VALUE', variables: [{ $ref: 'variable:param.date-granularity.string' }], defaultText: 'Fiscal Year' };
	assert.equal(cards[0].title, 'By Fiscal Year (End of Period)');
	assert.equal(def.title, 'By Fiscal Year (End of Period)', 'the plain title stays as the fallback');
	assert.deepEqual(def.dynamicTitle.text, [{ type: 'TEXT', text: 'By ' }, item, { type: 'TEXT', text: ' (End of Period)' }]);
	assert.equal(def.description, 'Shown per Fiscal Year');
	assert.deepEqual(def.dynamicDescription, { text: [{ type: 'TEXT', text: 'Shown per ' }, item, { type: 'TEXT', text: ' ' }, { type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Updated ' }], displayOnCardDetails: true });
	const codes = issues.filter((i) => i.code.startsWith('card.title-')).map((i) => i.code);
	assert.deepEqual(codes, ['card.title-update-time'], 'the variable shows the alias, as Tableau does');

	ws.title = `Sales\nper ${PARAM}`;
	assert.deepEqual(planCards(ir, makeBindings(), { variables }).cards[0].body.definition.dynamicDescription, { text: [{ type: 'TEXT', text: 'per ' }, item], displayOnCardDetails: true });

	ws.title = `${PARAM} only`;
	const plain = planCards(ir, makeBindings(), { variables: [{ key: 'v', parameter: { id: GRAIN_PARAM.id } }] });
	assert.deepEqual(plain.cards[0].body.definition.dynamicTitle.text[0].variables, [{ $ref: 'variable:v' }]);
	ir.parameters[0] = { ...GRAIN_PARAM, members: [{ value: 'Year' }, { value: 'Fiscal Period' }] };
	assert.ok(!planCards(ir, makeBindings(), { variables }).issues.some((i) => i.code.startsWith('card.title-')), 'no alias, nothing to report');

	const inline = planCards(ir, makeBindings());
	assert.deepEqual(inline.cards[0].body.definition.dynamicTitle.text, [{ type: 'TEXT', text: 'Fiscal Period only' }], 'an inlined parameter stays fixed text');
	assert.deepEqual(inline.issues.filter((i) => i.code.startsWith('card.title-')).map((i) => i.code), ['card.title-parameter']);
});

test('a pivot dimension with a hidden header only sorts: not a column, still grouped and in the sorts where Tableau has it', () => {
	const SEGMENT = p('none', 'Segment');
	const spec = { name: 'By End User', rows: `(${SEGMENT} / ${REGION})`, cols: CATEGORY, enc: { text: [SALES] }, sorts: [{ pillId: SEGMENT, kind: 'alphabetic', direction: 'DESC' }] };
	const ws = sheet(spec);
	ws.hiddenHeaders = [SEGMENT];
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} });
	const main = cards[0].body.definition.subscriptions.main;
	assert.equal(cards[0].chartType, 'badge_pivot_table');
	assert.deepEqual(main.columns.map((c) => [c.column, c.mapping]), [['Region', 'ROW'], ['Category', 'COLUMN'], ['Sales', 'VALUE']]);
	assert.ok(main.groupBy.some((g) => g.column === 'Segment'), 'the hidden field keeps the rows Tableau shows');
	assert.deepEqual(main.orderBy, [{ column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'ASCENDING' }, { column: 'Segment', order: 'DESCENDING' }, { column: 'Region', order: 'ASCENDING' }, { column: 'Category', order: 'ASCENDING' }], 'every header level in turn, unsorted ones ascending');
	assert.deepEqual(cards[0].body.definition.formulas.card.map((f) => [f.name, f.formula]), [['Segment (nulls last)', 'MAX(CASE WHEN `Segment` IS NULL THEN 1 ELSE 0 END)']], 'a descending sort lists the Null member last, as Tableau does');
	assert.match(issues.find((i) => i.code === 'card.hidden-header').message, /Segment has a hidden header/);

	const unsorted = sheet({ ...spec, sorts: [] });
	unsorted.hiddenHeaders = [SEGMENT];
	const plain = planCards(workbook({ worksheets: [unsorted] }), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main;
	assert.deepEqual(plain.orderBy[0], { column: 'Segment', order: 'ASCENDING' }, 'with no sort of its own it sorts ascending, as the editor keeps a sort field grouped');
	const table = sheet({ name: 'Flat', rows: `(${SEGMENT} / ${REGION})`, enc: { text: [SALES] } });
	table.hiddenHeaders = [SEGMENT];
	const flat = planCards(workbook({ worksheets: [table] }), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main;
	assert.ok(!flat.columns.some((c) => c.column === 'Segment'));
});

test('a discrete measure with a hidden header is not a table column, flat or pivot', () => {
	const HIDDEN = p('sum', 'Profit', 'ok');
	const flat = sheet({ name: 'Top Deals', rows: `(${REGION} / ${HIDDEN})`, enc: { text: [SALES] } });
	flat.hiddenHeaders = [HIDDEN];
	const flatMain = planCards(workbook({ worksheets: [flat] }), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main;
	assert.deepEqual(flatMain.columns.map((c) => c.column), ['Region', 'Sales']);
	const pivot = sheet({ name: 'Pivot', rows: `(${REGION} / ${HIDDEN})`, cols: CATEGORY, enc: { text: [SALES] } });
	pivot.hiddenHeaders = [HIDDEN];
	const [card] = planCards(workbook({ worksheets: [pivot] }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_pivot_table');
	assert.deepEqual(card.body.definition.subscriptions.main.columns.map((c) => [c.column, c.mapping]), [['Region', 'ROW'], ['Category', 'COLUMN'], ['Sales', 'VALUE']]);
	const shown = sheet({ name: 'Shown', rows: `(${REGION} / ${HIDDEN})`, enc: { text: [SALES] } });
	assert.ok(planCards(workbook({ worksheets: [shown] }), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main.columns.some((c) => c.column === 'Profit'));
});

test('a pivot axis whose headers are all hidden keeps them as headers, since nothing else splits its cells', () => {
	const YEAR = p('none', 'Fiscal Year', 'nk');
	const ws = sheet({ name: 'Dyn Main', rows: CATEGORY, cols: `(${YEAR} / ${REGION})`, enc: { text: [SALES] } });
	ws.hiddenHeaders = [YEAR, REGION];
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} });
	const main = cards[0].body.definition.subscriptions.main;
	assert.equal(cards[0].chartType, 'badge_pivot_table');
	assert.deepEqual(main.columns.map((c) => [c.column, c.mapping]), [['Category', 'ROW'], ['Fiscal Year', 'COLUMN'], ['Region', 'COLUMN'], ['Sales', 'VALUE']]);
	assert.match(issues.find((i) => i.code === 'card.hidden-header').message, /Fiscal Year, Region have hidden headers in Tableau; shown: Domo cannot hide a pivot header/);

	const rows = sheet({ name: 'Rows hidden', rows: CATEGORY, cols: REGION, enc: { text: [SALES] } });
	rows.hiddenHeaders = [CATEGORY];
	const rowMain = planCards(workbook({ worksheets: [rows] }), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main;
	assert.deepEqual(rowMain.columns.map((c) => [c.column, c.mapping]), [['Category', 'ROW'], ['Region', 'COLUMN'], ['Sales', 'VALUE']]);
});

test('a flat table whose only dimensions have hidden headers keeps them as leading columns', () => {
	const ws = sheet({ name: 'MRR Metrics Main', rows: `(${CATEGORY} / ${REGION})`, enc: { text: [SALES] } });
	ws.hiddenHeaders = [CATEGORY, REGION];
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} });
	const main = cards[0].body.definition.subscriptions.main;
	assert.equal(cards[0].chartType, 'badge_basic_table');
	assert.deepEqual(main.columns.map((c) => c.column), ['Category', 'Region', 'Sales']);
	assert.deepEqual(main.orderBy, [{ column: 'Category', order: 'ASCENDING' }, { column: 'Region', order: 'ASCENDING' }]);
	assert.match(issues.find((i) => i.code === 'card.hidden-header').message, /shown: Domo cannot hide a table column/);
});

test('pivot grand totals and subtotals carry into the chart properties', () => {
	const ws = sheet({ name: 'Pivot', rows: `(${CATEGORY} / ${REGION})`, cols: p('none', 'Segment'), enc: { text: [SALES] } });
	ws.totals = { rows: true, cols: true, subtotals: [CATEGORY] };
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_pivot_table');
	const { column_sort: columnSort, ...totals } = card.body.definition.charts.main.overrides;
	assert.deepEqual(totals, { total_row: 'true', total_col: 'true', subtotal_rows: 'true', subtotal_columns: 'false', total_row_label: 'Grand Total', total_column_label: 'Grand Total', subtotal_rows_label: 'Total' });
	assert.deepEqual(JSON.parse(columnSort).map((s) => s.column), ['Category', 'Region', 'Segment']);
	const rows = card.body.definition.subscriptions.main.columns.filter((c) => c.mapping === 'ROW');
	assert.deepEqual(rows.map((c) => [c.column, c.format]), [['Category', undefined], ['Region', { tableColumn: { hideSubtotal: true } }]], 'Phoenix subtotals every header level: only the subtotaled one keeps them');
	const plain = sheet({ name: 'Plain', rows: REGION, cols: p('none', 'Segment'), enc: { text: [SALES] } });
	const plainOverrides = planCards(workbook({ worksheets: [plain] }), makeBindings(), { options: {} }).cards[0].body.definition.charts.main.overrides;
	assert.deepEqual(plainOverrides, { total_row: 'false', total_col: 'false', subtotal_rows: 'false', subtotal_columns: 'false', column_sort: plainOverrides.column_sort }, 'Phoenix shows totals and subtotals unless they are off');
	const top = sheet({ name: 'Top', rows: `(${CATEGORY} / ${REGION})`, cols: p('none', 'Segment'), enc: { text: [SALES] } });
	top.totals = { rows: true, subtotals: [CATEGORY], rowsOnTop: true };
	const topOverrides = planCards(workbook({ worksheets: [top] }), makeBindings(), { options: {} }).cards[0].body.definition.charts.main.overrides;
	assert.deepEqual([topOverrides.total_row_position, topOverrides.subtotal_rows_position, topOverrides.total_col], ['Before', 'Before', 'false'], "Tableau's totals to top");
});

test('a crosstab listing records (four or more row headers) is a Mega Table with the inner column header spread into value columns', () => {
	const SEGMENT = p('none', 'Segment');
	const CUSTOMER = p('none', 'Customer');
	const SUB = p('none', 'Sub-Category');
	const YEAR = p('none', 'Fiscal Year', 'ok');
	const ws = sheet({ name: 'By End User', rows: `(${REGION} / ${CATEGORY} / ${SUB} / ${CUSTOMER})`, cols: `(${YEAR} / ${SEGMENT})`, enc: { text: [SALES] }, sorts: [{ pillId: SEGMENT, kind: 'manual', direction: 'ASC', order: ['Corporate', 'Consumer'] }, { pillId: CUSTOMER, kind: 'computed', direction: 'DESC', using: SALES }] });
	ws.totals = { rows: true, cols: true, rowsOnTop: true, subtotals: [REGION, CATEGORY] };
	const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: { useWindowFunctions: true } });
	const def = cards[0].body.definition;
	const main = def.subscriptions.main;
	assert.equal(cards[0].chartType, 'badge_basic_table');
	const name = (c) => c.alias ?? def.formulas.card.find((f) => f.id === c.formulaId)?.name ?? c.column;
	assert.deepEqual(main.columns.map(name), ['Region', 'Category', 'Sub-Category', 'Customer', 'Fiscal Year', 'Corporate', 'Consumer', 'Grand Total'], 'row headers, outer column headers, then one column per member in Tableau order and the grand total');
	assert.ok(main.columns.every((c) => c.mapping === 'VALUE'));
	const corporate = def.formulas.card.find((f) => f.name === 'Corporate');
	assert.equal(corporate.formula, "SUM(CASE WHEN `Segment` = 'Corporate' THEN `Sales` END)");
	assert.deepEqual(main.columns.at(-1), { column: 'Sales', mapping: 'VALUE', aggregation: 'SUM', alias: 'Grand Total' });
	assert.ok(!main.groupBy.some((g) => g.column === 'Segment'), 'the spread header is not grouped');
	assert.ok(!def.formulas.card.some((f) => f.name.endsWith('(manual order)')), 'its rank formula is dropped');
	assert.deepEqual(main.columns.find((c) => c.column === 'Fiscal Year').format, { ...PLAIN_INTEGER_FORMAT, tableColumn: { hideTotal: true, hideSubtotal: true } }, 'a number used as a header is not summed into the totals, and has no thousands separator');
	assert.deepEqual(def.charts.main.overrides, { total_row: 'true', subtotal_rows: 'true', total_row_label: 'Grand Total', total_row_suppress_count: 'true', total_row_position: 'Before', subtotal_rows_label: 'Total', subtotal_suppress_count: 'true', subtotal_rows_position: 'Before' });
	assert.ok(main.orderBy.some((o) => def.formulas.card.find((f) => f.id === o.formulaId)?.name === 'Customer (total order)'), 'rows keep the level-by-level order');
	assert.match(issues.find((i) => i.code === 'chart.crosstab-table').message, /Mega Table.*Segment spread/);
	assert.match(issues.find((i) => i.code === 'chart.crosstab-subtotals').message, /Category/, 'a Mega Table subtotals its first column only');

	const unordered = sheet({ name: 'No order', rows: `(${REGION} / ${CATEGORY} / ${SUB} / ${CUSTOMER})`, cols: SEGMENT, enc: { text: [SALES] } });
	const plainDef = planCards(workbook({ worksheets: [unordered] }), makeBindings(), { options: {} }).cards[0].body.definition;
	const plain = plainDef.subscriptions.main;
	assert.deepEqual(plain.columns.map((c) => c.column), ['Region', 'Category', 'Sub-Category', 'Customer', 'Segment', 'Sales'], 'without a member list the header stays a column');
	const keys = new Map(plainDef.formulas.card.map((f) => [f.id, f]));
	assert.deepEqual(plain.orderBy.map((o) => [keys.get(o.formulaId)?.name ?? o.column, o.order]), [
		['Region (natural order)', 'ASCENDING'],
		['Category (natural order)', 'ASCENDING'],
		['Sub-Category (natural order)', 'ASCENDING'],
		['Customer (natural order)', 'ASCENDING'],
		['Segment (natural order)', 'ASCENDING']
	], 'a flat table is drawn in query order, so text headers sort naturally ("P7" before "P10")');
	assert.equal(keys.get(plain.orderBy[0].formulaId).formula, naturalOrderKey('`Region`', { perGroup: true }));
	assert.equal(plainDef.charts.main.overrides.column_sort, undefined, 'column_sort is a pivot option');
	const small = sheet({ name: 'Small', rows: `(${REGION} / ${CATEGORY})`, cols: SEGMENT, enc: { text: [SALES] } });
	assert.equal(planCards(workbook({ worksheets: [small] }), makeBindings(), { options: {} }).cards[0].chartType, 'badge_pivot_table', 'a summary crosstab stays a pivot');
});

test('an integer dimension has no thousands separator, as Tableau draws it, unless its Tableau format has one', () => {
	const { main } = one({ cols: p('none', 'Fiscal Year', 'ok'), rows: SALES, mark: 'Bar' });
	assert.deepEqual(main.columns[0], { column: 'Fiscal Year', mapping: 'ITEM', format: PLAIN_INTEGER_FORMAT });
	assert.deepEqual(one({ cols: p('none', 'Store Number', 'ok'), rows: SALES, mark: 'Bar' }).main.columns[0].format, { type: 'number', format: '###,###', commas: true, percentMultiplied: true, precision: 0, abbreviate: false }, 'a format with separators');
	assert.equal(one({ cols: p('none', 'Sales (bin)', 'ok'), rows: SALES, mark: 'Bar' }).main.columns[0].format, undefined, 'a bin');
	assert.equal(one({ cols: CATEGORY, rows: p('sum', 'Quantity', 'qk'), mark: 'Bar' }).main.columns[1].format, undefined, 'a measure without a Tableau format');
});

const CURRENCY_0 = { type: 'currency', format: '###,###', commas: true, percentMultiplied: true, precision: 0, currency: '$', abbreviate: false };

test("a measure takes the worksheet's Tableau number format for its pill as its column format", () => {
	const ws = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' });
	ws.numberFormats = { [SALES]: 'c"$"#,##0;("$"#,##0)' };
	const main = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main;
	assert.deepEqual(main.columns[1], { column: 'Sales', mapping: 'VALUE', aggregation: 'SUM', format: CURRENCY_0 });
	assert.equal(main.columns[0].format, undefined);
});

test('a parenthesized negative format sets the chart type\'s negative number properties', () => {
	const PARENS = 'c"$"#,##0;("$"#,##0)';
	const plan = (spec, formats) => {
		const ws = sheet(spec);
		ws.numberFormats = formats;
		const { cards, issues } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} });
		return { overrides: cards[0].body.definition.charts.main.overrides, issues, chartType: cards[0].chartType };
	};
	const bar = plan({ cols: CATEGORY, rows: SALES, mark: 'Bar' }, { [SALES]: PARENS }).overrides;
	assert.deepEqual([bar.negative_numbers, bar.negative_numbers_dl, bar.negative_numbers_hvr], ['(100)', '(100)', '(100)']);
	assert.equal(bar.parenthesize_negatives, undefined);
	const table = plan({ name: 'By End User', rows: `(${REGION} / ${CATEGORY})`, enc: { text: [SALES] } }, { [SALES]: PARENS }).overrides;
	assert.equal(table.parenthesize_negatives, 'true');
	assert.equal(table.negative_numbers, undefined, 'tables have no value scale');
	const pivot = plan({ name: 'Pivot', rows: REGION, cols: CATEGORY, enc: { text: [SALES] } }, { [SALES]: PARENS }).overrides;
	assert.equal(pivot.parenthesize_negatives, 'true', 'a pivot table takes the table properties');
	const minus = plan({ cols: CATEGORY, rows: SALES, mark: 'Bar' }, { [SALES]: 'c"$"#,##0;-"$"#,##0' }).overrides;
	assert.equal(minus.negative_numbers, undefined);
	const mixed = plan({ cols: CATEGORY, rows: `${SALES} + ${PROFIT}`, mark: 'Bar' }, { [SALES]: PARENS, [PROFIT]: 'c"$"#,##0;-"$"#,##0' });
	assert.equal(mixed.overrides.negative_numbers, undefined, 'only when every formatted measure uses parentheses');
	assert.ok(mixed.issues.some((i) => i.code === 'chart.negative-numbers' && i.severity === 'info'));
	const both = plan({ cols: CATEGORY, rows: `${SALES} + ${PROFIT}`, mark: 'Bar' }, { [SALES]: PARENS, [PROFIT]: PARENS });
	assert.ok(Object.keys(both.overrides).filter((k) => /negative/.test(k)).every((k) => both.overrides[k] === '(100)'), both.chartType);
});

test("a measure takes its field's default format, except for a count or a table calc", () => {
	const ir = (ws) => {
		const out = workbook({ worksheets: [ws] });
		out.datasources[0].fields = out.datasources[0].fields.map((f) => (f.name === 'Sales' ? { ...f, defaultFormat: 'c"$"#,##0,,.0M;("$"#,##0,,.0M)' } : f));
		return out;
	};
	const columns = (ws) => planCards(ir(ws), makeBindings(), { options: {} }).cards[0].body.definition.subscriptions.main.columns;
	assert.deepEqual(columns(sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' }))[1].format, { type: 'currency', format: '###,###.0', commas: true, percentMultiplied: true, precision: 1, currency: '$', abbreviate: true }, 'millions with one decimal');
	assert.equal(columns(sheet({ cols: CATEGORY, rows: p('cnt', 'Sales', 'qk'), mark: 'Bar' }))[1].format, undefined, 'a count is not currency');
	const pct = sheet({ cols: CATEGORY, rows: p('pcto:sum', 'Sales', 'qk'), mark: 'Bar' });
	pct.numberFormats = { [p('pcto:sum', 'Sales', 'qk')]: 'p0.0%' };
	assert.deepEqual(columns(pct)[1].format, { type: 'percent', format: '#.0', commas: false, percentMultiplied: true, precision: 1, abbreviate: false }, 'a table calc takes only its own pill format');
});

test("a Mega Table's member value columns and Grand Total carry the measure's format", () => {
	const SEGMENT = p('none', 'Segment');
	const ws = sheet({ name: 'By End User', rows: `(${REGION} / ${CATEGORY} / ${p('none', 'Sub-Category')} / ${p('none', 'Customer')})`, cols: SEGMENT, enc: { text: [SALES] }, sorts: [{ pillId: SEGMENT, kind: 'manual', direction: 'ASC', order: ['Corporate', 'Consumer'] }] });
	ws.totals = { cols: true };
	ws.numberFormats = { [SALES]: 'c"$"#,##0;("$"#,##0)' };
	const def = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards[0].body.definition;
	const values = def.subscriptions.main.columns.slice(4);
	assert.deepEqual(values.map((c) => c.alias ?? def.formulas.card.find((f) => f.id === c.formulaId).name), ['Corporate', 'Consumer', 'Grand Total']);
	assert.ok(values.every((c) => JSON.stringify(c.format) === JSON.stringify(CURRENCY_0)));
});

test('a table header whose Tableau caption is only punctuation gets a blank label', () => {
	const bindings = makeBindings({ '[Region]': { datasetKey: DATASET, kind: 'column', name: '.', column: 'Region', aggregated: false, dataType: 'STRING', tableauType: 'string' } });
	const { main } = one({ name: 'Pivot', rows: REGION, cols: CATEGORY, enc: { text: [SALES] } }, { bindings });
	assert.deepEqual(main.columns[0], { column: 'Region', mapping: 'ROW', alias: ' ' });
	const bar = one({ cols: REGION, rows: SALES, mark: 'Bar' }, { bindings }).main;
	assert.notEqual(bar.columns[0].alias, ' ', 'charts keep the name');
});

test('a pivot sorts level by level: a computed sort by the member total within its parents (window SUM)', () => {
	const ws = sheet({ name: 'Pivot', rows: `(${CATEGORY} / ${REGION})`, cols: p('none', 'Segment'), enc: { text: [SALES] }, sorts: [{ pillId: REGION, kind: 'computed', direction: 'DESC', using: SALES }] });
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: { useWindowFunctions: true } }).cards;
	const def = card.body.definition;
	const total = def.formulas.card.find((f) => f.name === 'Region (total order)');
	assert.equal(total.formula, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Category`, `Region`)');
	assert.deepEqual(def.subscriptions.main.orderBy, [
		{ column: 'Category', order: 'ASCENDING' },
		{ column: total.id, formulaId: total.id, order: 'DESCENDING' },
		{ column: 'Region', order: 'ASCENDING' },
		{ column: 'Segment', order: 'ASCENDING' }
	], 'Phoenix lists each header in the order its members first appear in the rows');
	const off = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: { useWindowFunctions: false } }).cards[0].body.definition.subscriptions.main.orderBy;
	assert.deepEqual(off, [{ column: 'Sales', aggregation: 'SUM', order: 'DESCENDING' }], 'without window functions the flat sort stays');
});

test('a series sorted by its VALUE measure orders by a series total key first, then the axis key (second-level sorting)', () => {
	const plan = (spec, bindings = makeBindings()) => {
		const ws = sheet({ mark: 'Line', rows: SALES, enc: { color: [REGION] }, sorts: [{ pillId: REGION, kind: 'computed', direction: 'DESC', using: SALES }], ...spec });
		const { cards, issues } = planCards(workbook({ worksheets: [ws] }), bindings, { options: { useWindowFunctions: true } });
		const def = cards[0].body.definition;
		const names = new Map(def.formulas.card.map((f) => [f.id, f]));
		return { def, issues, order: def.subscriptions.main.orderBy.map((o) => [names.get(o.formulaId)?.name ?? o.column, o.order]), formula: (name) => def.formulas.card.find((f) => f.name === name)?.formula };
	};
	const text = plan({ cols: CATEGORY });
	assert.deepEqual(text.order, [['Region (total order)', 'DESCENDING'], ['Category (natural order)', 'ASCENDING']]);
	assert.equal(text.formula('Region (total order)'), 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Region`)');
	assert.ok(!text.issues.some((i) => i.code === 'card.sort-order'));
	const bm = { datasetKey: DATASET, kind: 'formula', name: 'Region', formulaId: 'bm_area', expression: "CASE WHEN `Segment` = 'A' THEN `Region` ELSE `Category` END", aggregated: false, dataType: 'STRING', tableauType: 'string' };
	const beastMode = plan({ cols: CATEGORY }, makeBindings({ '[Region]': bm }));
	assert.equal(beastMode.formula('Region (total order)'), "SUM(SUM(`Sales`)) OVER (PARTITION BY (CASE WHEN `Segment` = 'A' THEN `Region` ELSE `Category` END))", 'a beast-mode series partitions by its expression');
	const date = plan({ cols: p('tmn', 'Order Date', 'qk'), sorts: [{ pillId: p('tmn', 'Order Date', 'qk'), kind: 'alphabetic', direction: 'ASC' }, { pillId: REGION, kind: 'computed', direction: 'DESC', using: SALES }] });
	assert.equal(date.order[0][0], 'Region (total order)', 'on a date axis the series key still comes first');
	assert.ok(!date.order.some(([c]) => c === 'Sales'));
	const other = plan({ cols: CATEGORY, sorts: [{ pillId: REGION, kind: 'computed', direction: 'DESC', using: PROFIT }] });
	assert.deepEqual(other.order[0], ['Profit', 'DESCENDING'], 'a sort by another measure keeps today\'s path');
	const stack = plan({ cols: CATEGORY, mark: 'Bar' });
	assert.deepEqual(stack.order, [['Category (natural order)', 'ASCENDING']], 'a stacked bar leaves the series to category_sort_method: a series key as well puts every bar in one column in Analyzer');
	assert.equal(stack.def.charts.main.overrides.category_sort_method, 'Ascending');
});

test('pivot headers Tableau leaves unsorted or sorts by name get column_sort, named by their data label', () => {
	const SEGMENT = p('none', 'Segment');
	const YEAR = p('yr', 'Order Date', 'ok');
	const columnSort = (spec, opts = {}) => {
		const [card] = planCards(workbook({ worksheets: [sheet({ name: 'Pivot', enc: { text: [SALES] }, ...spec })] }), opts.bindings ?? makeBindings(), { options: { useWindowFunctions: true } }).cards;
		assert.equal(card.chartType, 'badge_pivot_table');
		const raw = card.body.definition.charts.main.overrides.column_sort;
		return raw && JSON.parse(raw);
	};
	assert.deepEqual(columnSort({ rows: `(${CATEGORY} / ${REGION})`, cols: SEGMENT, sorts: [{ pillId: CATEGORY, kind: 'alphabetic', direction: 'DESC' }] }), [
		{ column: 'Category', sort: 'desc' },
		{ column: 'Region', sort: 'asc' },
		{ column: 'Segment', sort: 'asc' }
	]);
	assert.deepEqual(columnSort({ rows: `(${CATEGORY} / ${REGION})`, cols: SEGMENT, sorts: [{ pillId: REGION, kind: 'computed', direction: 'DESC', using: SALES }, { pillId: SEGMENT, kind: 'manual', direction: 'ASC', order: ['Corporate', 'Consumer'] }] }), [{ column: 'Category', sort: 'asc' }], 'computed and manual sorts keep the query order');
	assert.equal(columnSort({ rows: REGION, cols: YEAR }).some((s) => /Order Date/.test(s.column)), false, 'a date header keeps the query order');
	const renamed = { datasetKey: DATASET, kind: 'column', name: 'Period', column: 'Segment', alias: 'Period', aggregated: false, dataType: 'STRING', tableauType: 'string' };
	const bm = { datasetKey: DATASET, kind: 'formula', name: 'Area', formulaName: 'Area (calc)', formulaId: 'bm_area', expression: 'UPPER(`Region`)', aggregated: false, dataType: 'STRING', tableauType: 'string' };
	assert.deepEqual(columnSort({ rows: p('none', 'Is Big'), cols: REGION }, { bindings: makeBindings({ '[Is Big]': renamed, '[Region]': bm }) }), [
		{ column: 'Segment', sort: 'asc' },
		{ column: 'Area (calc)', sort: 'asc' }
	], "a renamed column by its column name, not the alias; a beast mode by its name");
});

test('a heatmap sorts unsorted text columns and rows by natural-order keys, the series key first (second-level sorting)', () => {
	const plan = (spec) => {
		const [card] = planCards(workbook({ worksheets: [sheet({ name: 'Heat', rows: REGION, cols: CATEGORY, enc: { color: [SALES] }, ...spec })] }), makeBindings(), { options: {} }).cards;
		assert.equal(card.chartType, 'badge_heatmap');
		const keys = new Map(card.body.definition.formulas.card.map((f) => [f.id, f.name]));
		return card.body.definition.subscriptions.main.orderBy.map((o) => [keys.get(o.formulaId) ?? o.column, o.order]);
	};
	assert.deepEqual(plan({}), [
		['Region (natural order)', 'ASCENDING'],
		['Category (natural order)', 'ASCENDING']
	]);
	assert.deepEqual(plan({ sorts: [{ pillId: REGION, kind: 'computed', direction: 'DESC', using: SALES }] }), [
		['Sales', 'DESCENDING'],
		['Category (natural order)', 'ASCENDING']
	], "a series with its own sort keeps it, still listed first");
});

test('<Data Update Time> in a worksheet title becomes "Date last updated" smart text in the card description', () => {
	const { card, issues, def } = one({ name: 'ARR', cols: CATEGORY, rows: SALES, title: 'ARR Rollforward\nUpdated <Data Update Time> (UTC)' });
	assert.equal(card.title, 'ARR Rollforward');
	assert.deepEqual(def.dynamicDescription, { text: [{ type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Updated ', suffix: ' (UTC)' }], displayOnCardDetails: true });
	assert.match(issues.find((i) => i.code === 'card.title-update-time').message, /smart text in the card description/);
	const owner = one({ name: 'Sales', cols: CATEGORY, rows: SALES, title: 'Sales\nOwner: Ann | Last  Updated:   <Data Update Time>' }).def;
	assert.deepEqual(owner.dynamicDescription.text, [{ type: 'TEXT', text: 'Owner: Ann ' }, { type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Last Updated: ' }]);
	assert.equal(one({ name: 'Plain', cols: CATEGORY, rows: SALES, title: 'Plain' }).def.dynamicDescription, undefined);
	assert.deepEqual(updateTimeToken('Last Updated: <Data Update Time>'), { item: { type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Last Updated: ' }, title: '' });
	const target = { body: buildCardBody({ title: 'T', datasetKey: DATASET, chartType: 'badge_vert_bar', subscription: {} }) };
	addSmartDescription(target, { type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Last Updated: ' });
	addSmartDescription(target, { type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Again: ' });
	assert.deepEqual(target.body.definition.dynamicDescription, { text: [{ type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix: 'Last Updated: ' }], displayOnCardDetails: true }, 'added once');
});

test('a calc bound as a renamed column shows its Tableau name as the column alias, and only on the card column', () => {
	const renamed = { datasetKey: DATASET, kind: 'column', name: 'Period', column: 'Category', alias: 'Period', aggregated: false, dataType: 'STRING', tableauType: 'string' };
	const bindings = makeBindings({ '[Is Big]': renamed });
	const PERIOD = p('none', 'Is Big');
	const { main } = one({ cols: PERIOD, rows: SALES, mark: 'Bar', filters: [cat('Is Big', ['A'])], sorts: [{ pillId: PERIOD, kind: 'alphabetic', direction: 'DESC' }] }, { bindings });
	assert.deepEqual(main.columns[0], { column: 'Category', mapping: 'ITEM', alias: 'Period' });
	assert.deepEqual(main.groupBy, [{ column: 'Category' }]);
	assert.deepEqual(main.orderBy, [{ column: 'Category', order: 'DESCENDING' }]);
	assert.ok(main.filters.every((f) => !('alias' in f)) && main.filters.some((f) => f.column === 'Category'));
});

test('a plain column whose Tableau caption differs from the Domo column name gets the caption as its alias', () => {
	const bindings = makeBindings({ '[Region]': { datasetKey: DATASET, kind: 'column', name: 'Sales Region', column: 'REGION_CODE', aggregated: false, dataType: 'STRING', tableauType: 'string' } });
	const { main } = one({ cols: REGION, rows: SALES, mark: 'Bar' }, { bindings });
	assert.deepEqual(main.columns, [
		{ column: 'REGION_CODE', mapping: 'ITEM', alias: 'Sales Region' },
		{ column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' }
	]);
});

test('Channel Growth: period on the axis, the color dimension as series, Tableau tooltip, percent labels and legend on top', () => {
	const PCT = p('pcto:cnt', 'Customer', 'qk');
	const COUNT = p('cnt', 'Customer', 'qk');
	const ws = sheet({ name: 'Growth', rows: `${REGION} * ${PCT}`, cols: CATEGORY, enc: { color: [REGION], text: [PCT], tooltip: [COUNT] } });
	ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[Region]`], attrs: { prefix: 'pcto' } };
	Object.assign(ws.panes[0], { showLabels: true, tooltip: `Category:\t<${CATEGORY}>\nRegion:\t<${REGION}>\nCount : <${COUNT}>` });
	const dashboards = [
		{
			name: 'Summary',
			zones: [
				{ id: '1', kind: 'worksheet', worksheet: 'Growth', rect: { x: 0.3, y: 0.2, w: 0.3, h: 0.4 }, floating: false },
				{ id: '2', kind: 'legend', worksheet: 'Growth', param: REGION, rect: { x: 0.45, y: 0.22, w: 0.15, h: 0.05 }, floating: true }
			]
		}
	];
	const [card] = planCards(workbook({ worksheets: [ws], dashboards }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_vert_100pct');
	const main = card.body.definition.subscriptions.main;
	assert.deepEqual(main.columns.map((c) => c.mapping), ['ITEM', 'SERIES', 'VALUE']);
	assert.deepEqual(main.columns.slice(0, 2).map((c) => c.column), ['Category', 'Region']);
	assert.deepEqual(card.body.definition.charts.main.overrides, {
		lrg_legend_position: 'Top',
		details_legend_position: 'Top',
		hover_text: 'Category: %_CATEGORY_NAME\nRegion: %_SERIES_NAME\nCount : %_VALUE',
		datalabel_text: '%_PERCENT_OF_CATEGORY',
		datalabel_position: 'Center',
		datalabel_fnt_clr: 'Complimentary'
	});
});

const COUNTD = p('ctd', 'Customer', 'qk');
const dualAxis = (filters, barColor = [REGION]) =>
	sheet({
		cols: CATEGORY,
		rows: `(${COUNTD} + ${p('usr', 'Profit Ratio', 'qk')})`,
		panes: [
			{ markClass: 'Automatic', encodings: {} },
			{ markClass: 'Bar', yAxisPill: COUNTD, encodings: { color: barColor } },
			{ markClass: 'Line', yAxisPill: p('usr', 'Profit Ratio', 'qk'), encodings: {} }
		],
		filters
	});

test('a Hide on a dimension only one pane encodes goes inside that pane measure, not into a row filter', () => {
	const hide = cat('Region', undefined, { exclude: ['East'], hidden: true });
	const [card] = planCards(workbook({ worksheets: [dualAxis([hide])] }), makeBindings(), { options: {} }).cards;
	const def = card.body.definition;
	assert.deepEqual(def.subscriptions.main.filters, []);
	const bar = def.formulas.card.find((f) => f.name === 'Distinct count of Customer');
	assert.equal(bar.formula, "COUNT(DISTINCT CASE WHEN (`Region` IS NULL OR `Region` NOT IN ('East')) THEN `Customer` END)");
	assert.ok(def.subscriptions.main.columns.some((c) => c.column === 'calculation_pr'), 'the line measure is untouched');
	const shelf = planCards(workbook({ worksheets: [sheet({ cols: REGION, rows: SALES, mark: 'Bar', filters: [hide] })] }), makeBindings(), { options: {} }).cards[0];
	assert.deepEqual(shelf.body.definition.subscriptions.main.filters, [{ column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' }], 'a hide on a shelf dimension drops the same marks as a row filter');
	assert.equal(shelf.body.definition.formulas.card[0].formula, "CASE WHEN (`Region` IS NULL OR `Region` NOT IN ('East')) THEN 'true' ELSE 'false' END");
	const unwrappable = dualAxis([hide], []);
	unwrappable.panes[2].encodings = { color: [REGION] };
	const kept = planCards(workbook({ worksheets: [unwrappable] }), makeBindings(), { options: {} });
	assert.equal(kept.cards[0].body.definition.subscriptions.main.filters.length, 1, 'an aggregate calc cannot take the condition, so the row filter stays');
	assert.ok(kept.issues.some((i) => i.code === 'filter.hidden' && i.severity === 'warning'));
	const running = sheet({ cols: REGION, rows: p('cum:sum', 'Sales', 'qk'), mark: 'Bar', filters: [hide] });
	running.pills[p('cum:sum', 'Sales', 'qk')].tableCalc.orderingType = 'Rows';
	const along = planCards(workbook({ worksheets: [running] }), makeBindings(), { options: { useWindowFunctions: true } });
	assert.match(along.issues.find((i) => i.code === 'filter.hidden').message, /still feed Tableau's table calculations/, 'a running sum along the hidden dimension still counts the hidden members in Tableau');
	assert.ok(!planCards(workbook({ worksheets: [sheet({ cols: REGION, rows: SALES, mark: 'Bar', filters: [hide] })] }), makeBindings(), { options: {} }).issues.some((i) => i.code === 'filter.hidden'));
});

test('a value-shelf dimension the measures cannot share becomes a split card with its filter, members and colors', () => {
	const ws = sheet({
		name: 'Age',
		cols: CATEGORY,
		rows: `${REGION} * (${SALES} + ${PROFIT})`,
		panes: [
			{ markClass: 'Automatic', encodings: {} },
			{ markClass: 'Bar', yAxisPill: SALES, encodings: { color: [REGION] } },
			{ markClass: 'Line', yAxisPill: PROFIT, encodings: {} }
		],
		filters: [cat('Region', ['West', 'East'])],
		color: REGION_COLORS
	});
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_line_bar');
	const { expression, measures, ...split } = card.split;
	assert.equal(expression, '`Region`');
	assert.deepEqual(measures, [
		{ column: 'Profit', name: 'Profit', formula: 'SUM(CASE WHEN __t2d_split_member__ THEN `Profit` END)' },
		{ column: 'Sales', name: 'Sales', formula: 'SUM(CASE WHEN __t2d_split_member__ THEN `Sales` END)' }
	]);
	assert.deepEqual(split, {
		pillId: REGION,
		name: 'Region',
		ref: { column: 'Region' },
		filter: { column: 'Region', filterType: 'COLUMN_ID', operand: 'IN', dataType: 'string' },
		max: 6,
		members: ['West', 'East'],
		colors: { West: '#4e79a7', East: '#e15759' },
		colorColumns: ['Sales']
	});
	assert.ok(!card.body.definition.subscriptions.main.columns.some((c) => c.column === 'Region'));
	const RATIO = p('usr', 'Profit Ratio', 'qk');
	const ratioSheet = sheet({
		name: 'Age',
		cols: CATEGORY,
		rows: `${REGION} * (${SALES} + ${RATIO})`,
		panes: [
			{ markClass: 'Automatic', encodings: {} },
			{ markClass: 'Bar', yAxisPill: SALES, encodings: { color: [REGION] } },
			{ markClass: 'Line', yAxisPill: RATIO, encodings: {} }
		],
		color: REGION_COLORS
	});
	const ratio = planCards(workbook({ worksheets: [ratioSheet] }), makeBindings(), { options: {} }).cards[0];
	assert.equal(ratio.split.measures.find((m) => m.column === 'calculation_pr').formula, 'SUM(CASE WHEN __t2d_split_member__ THEN `Profit` END) / SUM(CASE WHEN __t2d_split_member__ THEN `Sales` END)', 'each aggregate of a calc takes the member condition');
});

const CUSTOMER = p('none', 'Customer');
const SHORT_ID = p('none', 'Short Id');
const linkIr = (ws, actions) => {
	const ir = workbook({ worksheets: [ws] });
	ir.datasources[0].fields = [...ir.datasources[0].fields, { id: '[Short Id]', name: 'Short Id', datatype: 'string', role: 'dimension', kind: 'calculated', formula: 'MID([Customer],4,10)' }];
	ir.actions = actions;
	return ir;
};
const linkBindings = () => makeBindings({ '[Short Id]': { datasetKey: DATASET, kind: 'formula', name: 'Short Id', formulaId: 'calculation_short', expression: 'SUBSTRING(`Customer`, 4, 10)', aggregated: false, dataType: 'STRING', tableauType: 'string' } });
const urlAction = (id, template, extra = {}) => ({ id, name: id.replace(/\W/g, ''), type: 'url', trigger: 'select', source: { type: 'datasource', datasource: DS }, url: { template, tokens: [], scheme: 'https' }, ...extra });
const linkSheet = (extra = {}) => {
	const ws = sheet({ name: 'Detail', rows: `(${REGION} / ${CUSTOMER} / ${SHORT_ID})`, enc: { text: [SALES], tooltip: [p('attr', 'Segment')] }, ...extra });
	ws.hiddenHeaders = [SHORT_ID];
	return ws;
};

test('a table URL action becomes a hyperlink Beast Mode in the column Tableau links, which keeps its grouping and sort', () => {
	const ws = linkSheet();
	ws.linkStyled = [CUSTOMER];
	const { cards, issues } = planCards(linkIr(ws, [urlAction('[VOCID]', 'https://crm.test/items/<[Short Id]>')]), linkBindings(), { options: {} });
	const main = cards[0].body.definition.subscriptions.main;
	assert.equal(cards[0].chartType, 'badge_basic_table');
	assert.deepEqual(main.columns.map((c) => c.alias ?? c.column), ['Region', 'Customer', 'Sales']);
	const link = main.columns[1];
	assert.equal(link.mapping, 'VALUE');
	const formula = cards[0].body.definition.formulas.card.find((f) => f.id === link.formulaId);
	assert.equal(formula.dataType, 'string');
	assert.equal(formula.aggregated, false);
	assert.equal(
		formula.formula,
		"CASE WHEN (SUBSTRING(`Customer`, 4, 10)) IS NULL THEN `Customer` ELSE CONCAT('<a name=\"', REPLACE(`Customer`, '\"', ''), '\" href=\"https://crm.test/items/', REPLACE((SUBSTRING(`Customer`, 4, 10)), '\"', '%22'), '\" target=\"_blank\">', `Customer`, '</a>') END"
	);
	assert.ok(main.groupBy.some((g) => g.column === 'Customer'), 'the label column still groups');
	assert.ok(main.groupBy.some((g) => g.formulaId === link.formulaId), 'a row-level link groups like the column it replaces');
	assert.deepEqual(cards[0].urlColumns, [{ actionId: '[VOCID]', action: 'VOCID', column: 'Customer' }]);
	assert.match(issues.find((i) => i.code === 'card.url-column').message, /"VOCID" became a link in each row of Customer, the column Tableau underlines/);

	const derived = planCards(linkIr(linkSheet(), [urlAction('[VOCID]', 'https://crm.test/items/<[Short Id]>')]), linkBindings(), { options: {} }).cards[0];
	assert.equal(derived.urlColumns[0].column, 'Customer', 'with no underline, the column the hidden token is computed from');
});

test('a URL action on a table: native link format for the token column, MAX for an ATTR token, a caption column for a second action', () => {
	const actions = [urlAction('[Native]', 'https://crm.test/r/<[Region]>'), urlAction('[Seg]', 'https://crm.test/s/<ATTR([Segment])>/view', { menuCaption: 'Open <[Segment]> segment' })];
	const { cards } = planCards(linkIr(linkSheet(), actions), linkBindings(), { options: {} });
	const main = cards[0].body.definition.subscriptions.main;
	assert.deepEqual(main.columns[0], { column: 'Region', mapping: 'VALUE', format: { tableColumn: { displayType: 'link', displayPrefix: 'https://crm.test/r/', displaySuffix: '', displayLabel: '' } } });
	const appended = main.columns.at(-1);
	assert.equal(appended.alias, 'Seg', 'Region is taken, so the second action gets its own column under the action name');
	const formula = cards[0].body.definition.formulas.card.find((f) => f.id === appended.formulaId);
	assert.equal(formula.aggregated, true);
	assert.match(formula.formula.replace(/\s+/g, ' '), /WHEN MAX\(`Segment`\) IS NULL THEN NULLIF\(1, 1\) .*'Open segment'/, 'no NULL keyword, which Beast Mode cannot parse');
	assert.ok(!main.groupBy.some((g) => g.formulaId === appended.formulaId));
	assert.deepEqual(cards[0].urlColumns.map((u) => [u.action, u.column, Boolean(u.native)]), [['Native', 'Region', true], ['Seg', 'Seg', false]]);
});

test('the same URL action on two dashboards is one link column', () => {
	const copy = (id) => ({ ...urlAction(id, 'https://crm.test/s/<ATTR([Segment])>/view'), name: 'Seg' });
	const actions = [urlAction('[Native]', 'https://crm.test/r/<[Region]>'), copy('[Seg1]'), copy('[Seg2]')];
	const { cards } = planCards(linkIr(linkSheet(), actions), linkBindings(), { options: {} });
	const main = cards[0].body.definition.subscriptions.main;
	assert.equal(main.columns.filter((c) => c.alias === 'Seg').length, 1);
	assert.deepEqual(cards[0].urlColumns.map((u) => u.column), ['Region', 'Seg']);
});

test('a URL action stays a card click when a token is not in the view or the sheet is not a table', () => {
	const outside = planCards(linkIr(linkSheet(), [urlAction('[City]', 'https://crm.test/c/<[City]>')]), linkBindings(), { options: {} }).cards[0];
	assert.equal(outside.urlColumns, undefined);
	const bar = sheet({ name: 'Bars', cols: REGION, rows: SALES, mark: 'Bar' });
	const barCard = planCards(linkIr(bar, [urlAction('[R]', 'https://crm.test/r/<[Region]>')]), linkBindings(), { options: {} }).cards[0];
	assert.equal(barCard.chartType, 'badge_vert_bar');
	assert.equal(barCard.urlColumns, undefined);
});

test('a combined category is one null-safe CONCAT beast mode on ITEM, sorted by VALUE and then by itself', () => {
	const STORE = p('none', 'Store Number');
	const CUSTOMER = p('none', 'Customer');
	const SEGMENT = p('none', 'Segment');
	const r = one({ rows: `${STORE} / ${CUSTOMER}`, cols: SALES, mark: 'Bar', enc: { color: [SEGMENT] }, sorts: [{ pillId: STORE, kind: 'computed', direction: 'DESC', using: SALES }] });
	assert.equal(r.card.chartType, 'badge_horiz_stackedbar');
	assert.deepEqual(r.def.formulas.card.map((f) => [f.id, f.name, f.formula, f.dataType, f.aggregated]), [
		['calculation_card_1', 'Store Number + Customer', "CONCAT(COALESCE(`Store Number`, ''), ' ', COALESCE(`Customer`, ''))", 'string', false]
	]);
	assert.deepEqual(r.main.columns.map((c) => [c.column, c.mapping]), [['calculation_card_1', 'ITEM'], ['Segment', 'SERIES'], ['Sales', 'VALUE']]);
	assert.deepEqual(r.main.groupBy, [{ column: 'calculation_card_1', formulaId: 'calculation_card_1' }, { column: 'Segment' }]);
	assert.deepEqual(r.main.orderBy, [{ column: 'Sales', aggregation: 'SUM', order: 'DESCENDING' }, { column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'ASCENDING' }]);
	assert.ok(r.issues.some((i) => i.code === 'card.sort-order' && /largest segment/.test(i.message)));
});

test('an unsorted combined category orders by the natural key of the whole formula; one part sort is kept', () => {
	const FY = p('none', 'Fiscal Year');
	const SEGMENT = p('none', 'Segment');
	const concat = "CONCAT(COALESCE(`Fiscal Year`, ''), ' ', COALESCE(`Category`, ''))";
	const natural = (expr) => `MIN(REGEXP_REPLACE(REGEXP_REPLACE(${expr}, '[0-9]+', '0000000000$0'), '0*([0-9]{10})', '$1'))`;
	const r = one({ cols: `${FY} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	assert.equal(r.card.chartType, 'badge_vert_stackedbar');
	assert.deepEqual(r.def.formulas.card.map((f) => [f.name, f.formula]), [['Fiscal Year + Category', concat], ['Segment (natural order)', NATURAL('Segment')], ['Fiscal Year + Category (natural order)', natural(concat)]]);
	assert.deepEqual(r.main.orderBy.map((e) => e.column), ['calculation_card_2', 'calculation_card_3'], 'the series key takes the series slot, the combined key the category slot');

	const sorted = one({ cols: `${FY} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] }, sorts: [{ pillId: CATEGORY, kind: 'alphabetic', direction: 'ASC' }, { pillId: FY, kind: 'alphabetic', direction: 'DESC' }] });
	const keys = sorted.main.orderBy.map((e) => [sorted.def.formulas.card.find((f) => f.id === e.formulaId)?.name, e.order]);
	assert.deepEqual(keys.filter(([name]) => /Fiscal Year \+ Category/.test(name ?? '')), [['Fiscal Year + Category (natural order)', 'DESCENDING']], 'the outer level sort wins, once');
	assert.ok(sorted.issues.some((i) => i.code === 'card.sort-order' && /sort on Category is left out/.test(i.message)));
});

test('a part with no row-level expression leaves the combined category; tooltips name it by its outer level', () => {
	const SEGMENT = p('none', 'Segment');
	const broken = one({ cols: `${REGION} / ${p('none', 'Broken')}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	assert.deepEqual(broken.main.columns.map((c) => [c.column, c.mapping]), [['Region', 'ITEM'], ['Segment', 'SERIES'], ['Sales', 'VALUE']]);
	assert.ok(broken.issues.some((i) => i.code === 'card.unsupported-field'));

	const ws = sheet({ cols: `${REGION} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	ws.panes[0].tooltip = `Region: <${REGION}>\nCategory: <${CATEGORY}>\nSegment: <${SEGMENT}>\nSales: <${SALES}>`;
	const { cards } = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} });
	assert.equal(cards[0].body.definition.charts.main.overrides.hover_text, 'Region: %_CATEGORY_NAME\nSegment: %_SERIES_NAME\nSales: %_VALUE');
});

test('a table calculation along a combined level partitions by the level columns, which the card then groups by', () => {
	const PCT = p('pcto:sum', 'Sales', 'qk');
	const SEGMENT = p('none', 'Segment');
	const ws = sheet({ cols: `${REGION} / ${CATEGORY}`, rows: PCT, mark: 'Bar', enc: { color: [SEGMENT] } });
	ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[Category]`], attrs: { prefix: 'pcto' } };
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: { useWindowFunctions: true } }).cards;
	const { formulas, subscriptions } = card.body.definition;
	assert.equal(card.chartType, 'badge_vert_stackedbar');
	const value = subscriptions.main.columns.find((c) => c.mapping === 'VALUE');
	assert.equal(formulas.card.find((f) => f.id === value.formulaId).formula, 'SUM(`Sales`) / NULLIF(SUM(SUM(`Sales`)) OVER (PARTITION BY `Region`, `Segment`), 0)');
	assert.deepEqual(subscriptions.main.groupBy.map((g) => g.column), ['calculation_card_1', 'Segment', 'Region', 'Category']);
});
