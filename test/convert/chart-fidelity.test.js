import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards } from '../../src/convert/cards.js';
import { planPages } from '../../src/convert/layout.js';
import { cardColorRules } from '../../src/convert/colors.js';
import { DS, DATASET, p, sheet, workbook, makeBindings, cat } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const PROFIT = p('sum', 'Profit', 'qk');
const REGION = p('none', 'Region');
const CATEGORY = p('none', 'Category');
const MEASURE_NAMES = `[${DS}].[:Measure Names]`;
const zone = (id, kind, rect, extra = {}) => ({ id, kind, rect, floating: false, ...extra });
const overridesOf = (ws, dashboards = [], tweak = (ir) => ir) => planCards(tweak(workbook({ worksheets: [ws], dashboards })), makeBindings(), { options: {} }).cards[0].body.definition.charts.main.overrides;

test('a chart on a dashboard without its color legend hides the Domo legend; off every dashboard it keeps Domo default', () => {
	const ws = () => sheet({ name: 'Trend', cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] } });
	const sheetZone = zone('1', 'worksheet', { x: 0, y: 0.2, w: 0.5, h: 0.4 }, { worksheet: 'Trend' });
	const hidden = overridesOf(ws(), [{ name: 'Overview', zones: [sheetZone] }]);
	assert.deepEqual([hidden.lrg_legend_position, hidden.details_legend_position], ['Hide', 'Hide']);
	const top = overridesOf(ws(), [{ name: 'Overview', zones: [sheetZone, zone('2', 'legend', { x: 0.1, y: 0.21, w: 0.2, h: 0.05 }, { worksheet: 'Trend', param: REGION, floating: true })] }]);
	assert.equal(top.lrg_legend_position, 'Top');
	const away = overridesOf(ws(), [{ name: 'Overview', zones: [sheetZone, zone('2', 'legend', { x: 0.2, y: 0.38, w: 0.1, h: 0.05 }, { worksheet: 'Trend', param: REGION, floating: true })] }]);
	assert.equal(away.lrg_legend_position, undefined, 'a legend Domo cannot place leaves the default legend');
	assert.equal(overridesOf(ws()).lrg_legend_position, undefined);
});

test('the stack total trick labels only the bar totals, bold as Medium, without segment labels', () => {
	const panes = [
		{ markClass: 'Bar', encodings: { color: [REGION] }, yAxisPill: SALES, showLabels: false },
		{ markClass: 'Bar', encodings: {}, yAxisPill: SALES, showLabels: true, boldLabels: true }
	];
	const ws = sheet({ name: 'Tickets', cols: CATEGORY, rows: SALES, panes });
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_vert_stackedbar');
	const o = card.body.definition.charts.main.overrides;
	assert.deepEqual([o.datalabel_show_total, o.datalabel_total_style, o.datalabel_text], ['true', 'Medium', undefined]);
	const labeled = sheet({ name: 'Tickets', cols: CATEGORY, rows: SALES, panes: [{ markClass: 'Bar', encodings: { color: [REGION] }, showLabels: true }] });
	const plain = overridesOf(labeled);
	assert.deepEqual([plain.datalabel_show_total, plain.datalabel_text], [undefined, '%_VALUE'], 'segment labels stay when Tableau labels the segments');
});

test('percent data labels take the decimals of the Tableau number format', () => {
	const PCT = p('pcto:cnt', 'Customer', 'qk');
	const make = (format) => {
		const ws = sheet({ name: 'Growth', rows: `${REGION} * ${PCT}`, cols: CATEGORY, enc: { color: [REGION], text: [PCT] } });
		ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[Region]`], attrs: { prefix: 'pcto' } };
		ws.panes[0].showLabels = true;
		if (format) ws.numberFormats = { [PCT]: format };
		return overridesOf(ws);
	};
	assert.deepEqual([make('p0%').datalabel_text, make('p0%').percent_decimal_places], ['%_PERCENT_OF_CATEGORY', 'None']);
	assert.equal(make('p0.0%').percent_decimal_places, '.0');
	assert.equal(make().percent_decimal_places, undefined);
	const ws = sheet({ name: 'Growth', rows: `${REGION} * ${PCT}`, cols: CATEGORY, enc: { color: [REGION], text: [PCT] } });
	ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[Region]`], attrs: { prefix: 'pcto' } };
	ws.numberFormats = { [PCT]: 'p0%' };
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_vert_100pct');
	assert.equal(card.body.definition.subscriptions.main.columns.find((c) => c.mapping === 'VALUE').format, undefined, 'the column holds the count Domo turns into percents');
});

test('a labeled pane with no label fields labels the measure it plots: a percent of total shows the percent (CustomerVoice Activity by Age Bucket)', () => {
	const PCT = p('pcto:cnt', 'Customer', 'qk');
	const make = (format) => {
		const ws = sheet({ name: 'Age', rows: PCT, cols: CATEGORY, enc: { color: [REGION] } });
		ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Columns', attrs: { prefix: 'pcto' } };
		ws.panes[0].showLabels = true;
		ws.numberFormats = { [PCT]: format };
		return overridesOf(ws);
	};
	assert.deepEqual([make('p0%').datalabel_text, make('p0%').percent_decimal_places], ['%_PERCENT_OF_CATEGORY', 'None']);
	assert.equal(make('p0.0%').percent_decimal_places, '.0');
	const plain = sheet({ name: 'Age', rows: SALES, cols: CATEGORY, enc: { color: [REGION] } });
	plain.panes[0].showLabels = true;
	assert.equal(overridesOf(plain).datalabel_text, '%_VALUE');
});

test('CustomerVoice Activity by Age Bucket: 100% columns by an unsorted text series, Automatic percent labels', () => {
	const PCT = p('pcto:cnt', 'Customer', 'qk');
	const ws = sheet({ name: 'Activity by Age Bucket', rows: PCT, cols: CATEGORY, enc: { color: [REGION], tooltip: [PCT] }, color: { pillId: REGION, type: 'palette', members: [{ value: '0-30 Days', color: '#4e79a7' }, { value: '181+ Days', color: '#e15759' }] } });
	ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Columns', attrs: { prefix: 'pcto' } };
	Object.assign(ws.panes[0], { markClass: 'Bar', showLabels: true });
	ws.numberFormats = { [PCT]: 'p0%' };
	const [card] = planCards(workbook({ worksheets: [ws] }), makeBindings(), { options: {} }).cards;
	assert.equal(card.chartType, 'badge_vert_100pct');
	const def = card.body.definition;
	const name = Object.fromEntries(def.formulas.card.map((f) => [f.id, f.name]));
	assert.deepEqual(def.subscriptions.main.orderBy.map((e) => [name[e.column], e.order]), [['Region (natural order)', 'DESCENDING'], ['Category (natural order)', 'ASCENDING']], '"181+" after "31-60" as Tableau orders it; reversed so the first member stacks on top, nulls (first in a Domo descending sort) at the bottom as Tableau draws them last');
	const o = def.charts.main.overrides;
	assert.deepEqual([o.datalabel_text, o.percent_decimal_places, o.datalabel_position, o.datalabel_fnt_clr, o.legend_reverse_layout], ['%_PERCENT_OF_CATEGORY', 'None', 'Center', 'Complimentary', 'true']);
});

test('Acme ARR By Geo: a percent formatted stack labeled with its share of each category is a 100% chart of the plain measure', () => {
	const PCT = p('pcto:sum', 'Sales', 'qk');
	const make = (salesFormat) => {
		const ws = sheet({ name: 'By Area %', rows: SALES, cols: CATEGORY, enc: { color: [REGION], text: [PCT] } });
		ws.pills[PCT].tableCalc = { type: 'PctTotal', orderingType: 'Columns', attrs: { prefix: 'pcto' } };
		ws.panes[0].showLabels = true;
		ws.numberFormats = { [PCT]: 'p0.0%', ...(salesFormat ? { [SALES]: salesFormat } : {}) };
		ws.sorts = [{ pillId: REGION, kind: 'computed', direction: 'ASC', using: SALES }];
		const ir = workbook({ worksheets: [ws] });
		ir.datasources[0].fields = ir.datasources[0].fields.map((f) => (f.name === 'Sales' ? { ...f, defaultFormat: 'c"$"#,##0;("$"#,##0)' } : f));
		return planCards(ir, makeBindings(), { options: {} }).cards[0];
	};
	const card = make('p0.0%');
	assert.equal(card.chartType, 'badge_vert_100pct');
	const value = card.body.definition.subscriptions.main.columns.find((c) => c.mapping === 'VALUE');
	assert.deepEqual([value.column, value.format?.type, value.format?.currency], ['Sales', 'currency', '$'], 'the value keeps the field format; the percent is the label');
	const o = card.body.definition.charts.main.overrides;
	assert.deepEqual([o.datalabel_text, o.percent_decimal_places, o.category_sort_method], ['%_PERCENT_OF_CATEGORY', '.0', 'Descending']);
	assert.equal(make().chartType, 'badge_vert_stackedbar', 'without a percent format the bars keep their heights');
	assert.equal(make().body.definition.charts.main.overrides.category_sort_method, 'Descending');
});

test('a measure takes its Measure Names alias as the series name', () => {
	const ws = sheet({ name: 'Times', cols: CATEGORY, rows: `[${DS}].[:Measure Values]`, enc: { color: [MEASURE_NAMES] }, measureValues: [SALES, PROFIT], mark: 'Line' });
	const aliases = (ir) => {
		ir.datasources[0].fields = [...ir.datasources[0].fields, { id: '[:Measure Names]', name: 'Measure Names', kind: 'measure-names', aliases: { [SALES]: 'Revenue' } }];
		return ir;
	};
	const [card] = planCards(aliases(workbook({ worksheets: [ws] })), makeBindings(), { options: {} }).cards;
	const columns = card.body.definition.subscriptions.main.columns.filter((c) => c.mapping !== 'ITEM');
	assert.deepEqual(columns.map((c) => c.alias), ['Revenue', undefined]);
});

test('two panes on one combo column: the line color on the column, the bar color on the category column, last', () => {
	const COUNT = p('ctd', 'Id', 'qk');
	const RUNNING = p('pcto:cum:ctd', 'Id', 'qk');
	const ws = {
		name: 'Process Area',
		markColor: '#86bcb6',
		panes: [
			{ markClass: 'Bar', encodings: {}, markColor: '#86bcb6' },
			{ markClass: 'Bar', encodings: {}, yAxisPill: COUNT, markColor: '#55aaff' },
			{ markClass: 'Line', encodings: {}, yAxisPill: RUNNING, markColor: '#86bcb6' }
		]
	};
	const dataSourceId = { $ref: `dataset:${DATASET}` };
	const slots = [
		{ pillId: CATEGORY, role: 'dim', column: { column: 'Processarea', mapping: 'ITEM' } },
		{ pillId: COUNT, role: 'measure', column: { column: 'calc_1', mapping: 'SERIES' } },
		{ pillId: RUNNING, role: 'measure', column: { column: 'calc_1', mapping: 'SERIES' } }
	];
	const { rules, issues } = cardColorRules(ws, { family: 'combo', slots, dataSourceId });
	assert.deepEqual(rules.map((r) => [r.condition.column, r.condition.values, r.format.color]), [['calc_1', [], '#86bcb6'], ['Processarea', [], '#55aaff']]);
	assert.deepEqual(issues, []);
	const apart = cardColorRules(ws, { family: 'combo', slots: [slots[0], slots[1], { ...slots[2], column: { column: 'calc_2', mapping: 'SERIES' } }], dataSourceId });
	assert.deepEqual(apart.rules.map((r) => [r.condition.column, r.format.color]), [['calc_1', '#55aaff'], ['calc_2', '#86bcb6']], 'one rule per column, each its pane color');
	const bars = cardColorRules(ws, { family: 'bar', slots, dataSourceId });
	assert.deepEqual([bars.rules.length, bars.issues[0].code], [1, 'card.colors-same-column']);
});

test('filter cards take the quick filter title of their worksheet, keys stay on the column', () => {
	const region = cat('Region', ['East']);
	const s = sheet({ name: 'S', cols: CATEGORY, rows: SALES, filters: [region] });
	s.filterTitles = { [region.pillId]: 'Sales Region' };
	const dash = { name: 'D1', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('1', 'worksheet', { x: 0, y: 0, w: 0.8, h: 1 }, { worksheet: 'S' }), zone('2', 'filter', { x: 0.8, y: 0, w: 0.2, h: 0.2 }, { worksheet: 'S', param: region.pillId })], floating: [] };
	const ir = workbook({ worksheets: [s], dashboards: [dash] });
	const bindings = makeBindings();
	const { cards } = planPages(ir, planCards(ir, bindings, { options: {} }).cards, bindings, { options: {} });
	assert.deepEqual([cards[0].title, cards[0].body.definition.dynamicTitle.text[0].text], ['Sales Region', 'Sales Region']);
	assert.match(cards[0].key, /-region-/);
});
