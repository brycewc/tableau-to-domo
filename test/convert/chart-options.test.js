import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisRangeOverrides, axisTitleOverrides, defaultHoverText, legendOverrides, legendPlacements, legendPosition, markTextOverrides, stackSortOverrides, translateMarkText } from '../../src/convert/chart-options.js';
import { defaultTooltipText, inferChart, textTokens } from '../../src/convert/chart-types.js';
import { DS, makeBindings, p, sheet, workbook } from './cards.fixtures.test.js';

const REGION = p('none', 'Region');
const CATEGORY = p('none', 'Category');
const SALES = p('sum', 'Sales', 'qk');
const PROFIT = p('sum', 'Profit', 'qk');
const PCT_COUNT = p('pcto:cnt', 'Customer', 'qk');
const COUNT = p('cnt', 'Customer', 'qk');

const STACK = [
	{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
	{ pillId: REGION, mapping: 'SERIES', role: 'dim' },
	{ pillId: PCT_COUNT, mapping: 'VALUE', role: 'measure' }
];

/** Channel Growth in miniature: % of the count along Region, Region on Color and rows, Category on columns. */
function pctSheet(pane = {}) {
	const ws = sheet({ rows: `${REGION} * ${PCT_COUNT}`, cols: CATEGORY, enc: { color: [REGION], text: [PCT_COUNT], tooltip: [COUNT] } });
	ws.pills[PCT_COUNT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[Region]`], attrs: { prefix: 'pcto' } };
	Object.assign(ws.panes[0], pane);
	return ws;
}

test('textTokens splits literal text and tokens, nested ones included', () => {
	assert.deepEqual(textTokens('A: <[x].[y]> <Sheet name="S" filter="<All Fields>">!'), [{ text: 'A: ' }, { token: '[x].[y]' }, { text: ' ' }, { token: 'Sheet name="S" filter="<All Fields>"' }, { text: '!' }]);
});

test('a custom tooltip on a 100% chart: category, series and the base count as Phoenix macros', () => {
	const ws = pctSheet();
	const ir = workbook({ worksheets: [ws] });
	const text = `Category:\t<${CATEGORY}>\nRegion:\t<${REGION}>\nCount : <${COUNT}>\nShare: <${PCT_COUNT}>`;
	const result = translateMarkText(text, ws, ir, STACK, { pct100: true, family: 'bar' });
	assert.equal(result.text, 'Category: %_CATEGORY_NAME\nRegion: %_SERIES_NAME\nCount : %_VALUE\nShare: %_PERCENT_OF_CATEGORY');
	assert.deepEqual(result.dropped, []);
});

test('tokens with no macro drop their line; a parameter shows its current value; <Sheet Name> is the sheet name', () => {
	const ws = pctSheet();
	const ir = workbook({ worksheets: [ws], parameters: [{ id: '[Parameters].[Parameter 1]', name: 'Display By', datatype: 'string', value: 'geo', members: [{ value: 'geo', alias: 'Geography' }] }] });
	const text = `<Sheet Name>\nSegment: <${p('none', 'Segment')}>\n<[Parameters].[Parameter 1]>: <${CATEGORY}>\n<Sheet name="Detail" maxwidth="300">`;
	const result = translateMarkText(text, ws, ir, STACK, { pct100: true, family: 'bar' });
	assert.equal(result.text, 'Sheet 1\nGeography: %_CATEGORY_NAME');
	assert.deepEqual(result.dropped, ['Segment', '<Sheet>']);
	assert.deepEqual(result.parameters, ['Display By = Geography']);
});

test('markTextOverrides: hover text from the custom tooltip and the percent label on a 100% chart', () => {
	const ws = pctSheet({ showLabels: true, tooltip: `<${CATEGORY}>\n<${REGION}>: <${COUNT}>` });
	const { overrides, issues } = markTextOverrides(ws, workbook({ worksheets: [ws] }), { chartType: 'badge_vert_100pct', family: 'bar', slots: STACK });
	assert.deepEqual(overrides, { hover_text: '%_CATEGORY_NAME\n%_SERIES_NAME: %_VALUE', datalabel_text: '%_PERCENT_OF_CATEGORY', datalabel_position: 'Center', datalabel_fnt_clr: 'Complimentary' }, 'Automatic labels sit centered in each segment in a contrasting color');
	assert.deepEqual(issues, []);
});

test("markTextOverrides: without a custom tooltip, Tableau's default tooltip, dimensions first, each group by instance name", () => {
	const ws = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { tooltip: [PROFIT, p('avg', 'Quantity', 'qk')] } });
	const slots = [
		{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
		{ pillId: SALES, mapping: 'VALUE', role: 'measure' },
		{ pillId: PROFIT, mapping: 'EXTRAINFO1', role: 'measure' },
		{ pillId: p('avg', 'Quantity', 'qk'), mapping: 'EXTRAINFO2', role: 'measure' }
	];
	const ir = workbook({ worksheets: [ws] });
	assert.deepEqual(markTextOverrides(ws, ir, { chartType: 'badge_vert_bar', family: 'bar', slots }).overrides, { hover_text: 'Category: %_CATEGORY_NAME\nAvg. Quantity: %_TOOLTIP2\nProfit: %_TOOLTIP1\nSales: %_VALUE' });
	assert.deepEqual(markTextOverrides(ws, ir, { chartType: 'badge_basic_table', family: 'table', slots }).overrides, {}, 'tables have no hover text option');
});

test('markTextOverrides: shown labels with no label field show the value; a hover text that loses every value is not written', () => {
	const ws = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' });
	ws.panes[0].showLabels = true;
	ws.panes[0].tooltip = `<${CATEGORY}>: <${PROFIT}>`;
	const slots = [
		{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
		{ pillId: SALES, mapping: 'SERIES', role: 'measure' },
		{ pillId: PROFIT, mapping: 'SERIES', role: 'measure' }
	];
	const { overrides } = markTextOverrides(ws, workbook({ worksheets: [ws] }), { chartType: 'badge_vert_multibar', family: 'bar', slots });
	assert.deepEqual(overrides, { datalabel_text: '%_VALUE' });
});

test('an unconverted table calc drops its whole line, other macros on it included, and does not count as a lost value', () => {
	const RUN = p('cum:sum', 'Sales', 'qk');
	const ws = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' });
	const ir = workbook({ worksheets: [ws] });
	const slots = [
		{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
		{ pillId: RUN, mapping: 'VALUE', role: 'measure' }
	];
	const result = translateMarkText(`<${CATEGORY}>: <${RUN}>\nRegion <${REGION}>`, ws, ir, slots, { family: 'bar', unconverted: new Set([`${DS}|[Sales]|sum|CumTotal`]) });
	assert.equal(result.text, '');
	assert.deepEqual(result.dropped, ['Running Sum of Sales', 'Region']);

	ws.panes[0].tooltip = `<${CATEGORY}>\nRunning: <${RUN}>\nProfit <${PROFIT}>`;
	const hover = markTextOverrides(ws, ir, { chartType: 'badge_vert_bar', family: 'bar', slots: [...slots, { pillId: PROFIT, mapping: 'EXTRAINFO1', role: 'measure' }], unconverted: [RUN] });
	assert.equal(hover.overrides.hover_text, '%_CATEGORY_NAME\nProfit %_TOOLTIP1', 'written although the value line is gone');
});

test('markTextOverrides: Tableau label alignment and color as the Phoenix label position and font color', () => {
	const labels = (chartType, pane = {}) => {
		const ws = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] } });
		Object.assign(ws.panes[0], { showLabels: true }, pane);
		const slots = [{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' }, { pillId: REGION, mapping: chartType.includes('stacked') || chartType.includes('100pct') || chartType.includes('multibar') ? 'SERIES' : 'ITEM', role: 'dim' }, { pillId: SALES, mapping: 'VALUE', role: 'measure' }];
		const { overrides } = markTextOverrides(ws, workbook({ worksheets: [ws] }), { chartType, family: 'bar', slots });
		return [overrides.datalabel_position, overrides.datalabel_fnt_clr];
	};
	assert.deepEqual(labels('badge_vert_100pct'), ['Center', 'Complimentary'], 'Automatic centers a stack segment label in a contrasting color');
	assert.deepEqual(labels('badge_horiz_stackedbar', { labelColor: { mode: 'auto' } }), ['Center', 'Complimentary']);
	assert.deepEqual(labels('badge_vert_bar'), [undefined, undefined], 'a lone bar keeps the label at its end');
	assert.deepEqual(labels('badge_vert_multibar'), [undefined, undefined]);
	assert.deepEqual(labels('badge_horiz_bar', { labelAlign: { horizontal: 'center' } }), ['Center', 'Complimentary'], 'an explicit center, along a horizontal bar');
	assert.deepEqual(labels('badge_vert_bar', { labelAlign: { horizontal: 'center' } }), [undefined, undefined], 'a column chart reads the vertical alignment');
	assert.deepEqual(labels('badge_vert_bar', { labelAlign: { vertical: 'bottom' } }), ['Inside Bottom', 'Complimentary']);
	assert.deepEqual(labels('badge_vert_bar', { labelAlign: { vertical: 'top' } }), [undefined, undefined], 'the top of a lone bar may be outside it');
	assert.deepEqual(labels('badge_vert_stackedbar', { labelAlign: { vertical: 'top' } }), ['Inside Top', 'Complimentary']);
	assert.deepEqual(labels('badge_vert_100pct', { labelColor: { mode: 'user', color: '#ffffff' } }), ['Center', 'White']);
	assert.deepEqual(labels('badge_vert_bar', { labelColor: { mode: 'user', color: '#1b1b1b' } }), [undefined, 'Black']);
	assert.deepEqual(labels('badge_vert_bar', { labelColor: { mode: 'user', color: '#808080' } }), [undefined, 'Gray']);
	assert.deepEqual(labels('badge_vert_100pct', { labelColor: { mode: 'user', color: '#083461' } }), ['Center', undefined], 'a hue has no Phoenix label color');
	assert.deepEqual(labels('badge_vert_100pct', { labelColor: { mode: 'match' } }), ['Center', undefined]);
	assert.deepEqual(labels('badge_line_bar', { labelAlign: { vertical: 'center' } }), [undefined, undefined], 'a combo label may be the line pane\'s');
});

test('defaultHoverText follows Phoenix per chart type', () => {
	assert.equal(defaultHoverText('badge_vert_100pct', STACK), '%_CATEGORY_NAME %_SERIES_NAME : %_ORIG_VALUE');
	assert.equal(defaultHoverText('badge_pie', []), '%_CATEGORY_NAME : %_ORIG_VALUE : %_ORIG_PERCENT_OF_TOTAL');
	assert.equal(defaultHoverText('badge_vert_stackedbar', STACK), '%_CATEGORY_NAME %_SERIES_NAME : %_VALUE');
	assert.equal(defaultHoverText('badge_vert_bar', STACK.filter((s) => s.mapping !== 'SERIES')), '%_CATEGORY_NAME : %_VALUE');
});

test('legendPosition: above or in the top quarter is top, bottom quarter or below is bottom, beside on the right is right', () => {
	const sheetRect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
	assert.equal(legendPosition({ x: 0.4, y: 0.1, w: 0.1, h: 0.05 }, sheetRect), 'top');
	assert.equal(legendPosition({ x: 0.4, y: 0.22, w: 0.1, h: 0.05 }, sheetRect), 'top');
	assert.equal(legendPosition({ x: 0.4, y: 0.55, w: 0.1, h: 0.05 }, sheetRect), 'bottom');
	assert.equal(legendPosition({ x: 0.65, y: 0.3, w: 0.1, h: 0.2 }, sheetRect), 'right');
	assert.equal(legendPosition({ x: 0.3, y: 0.35, w: 0.1, h: 0.05 }, sheetRect), undefined);
});

test('legendPlacements: the first dashboard with a color legend wins, other placements are noted', () => {
	const ws = sheet({ name: 'Trend', cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION], size: [PROFIT] } });
	const zones = (legendY) => [
		{ id: '1', kind: 'worksheet', worksheet: 'Trend', rect: { x: 0, y: 0.2, w: 0.5, h: 0.4 }, floating: false },
		{ id: '2', kind: 'legend', worksheet: 'Trend', param: PROFIT, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, floating: true },
		{ id: '3', kind: 'legend', worksheet: 'Trend', param: REGION, rect: { x: 0.1, y: legendY, w: 0.2, h: 0.05 }, floating: true }
	];
	const ir = workbook({ worksheets: [ws], dashboards: [{ name: 'Overview', zones: zones(0.21) }, { name: 'Detail', zones: zones(0.7) }] });
	const placement = legendPlacements(ir).get('Trend');
	assert.deepEqual(placement, { position: 'top', dashboard: 'Overview', others: [{ dashboard: 'Detail', position: 'bottom' }] });
	const slots = [{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' }, { pillId: REGION, mapping: 'SERIES', role: 'dim' }];
	const result = legendOverrides(ws, placement, { chartType: 'badge_vert_stackedbar', slots });
	assert.deepEqual(result.overrides, { lrg_legend_position: 'Top', details_legend_position: 'Top' });
	assert.equal(result.issues[0].code, 'chart.legend');
	assert.deepEqual(legendOverrides(ws, { position: 'right', dashboard: 'Overview' }, { chartType: 'badge_vert_stackedbar', slots }).overrides, { details_legend_position: 'Right' });
	assert.deepEqual(legendOverrides(ws, placement, { chartType: 'badge_pie', slots }).overrides, {}, 'pie has no legend position option');
});

test('a fixed Tableau axis on the plotted measure pins the value scale; other axes and 100% charts do not', () => {
	const ws = sheet({ rows: SALES, cols: CATEGORY, mark: 'Bar' });
	ws.axes = [{ pillId: SALES, min: -8547459.62, max: 9775742.67 }];
	const slots = [
		{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
		{ pillId: SALES, mapping: 'VALUE', role: 'measure' }
	];
	const r = axisRangeOverrides(ws, { chartType: 'badge_vert_bar', slots });
	assert.deepEqual(r.overrides, { value_scale_min: '-8547459.62', value_scale_max: '9775742.67' });
	assert.equal(r.issues[0].code, 'chart.axis-range');
	assert.deepEqual(axisRangeOverrides(ws, { chartType: 'badge_vert_100pct', slots }).overrides, {});
	assert.deepEqual(axisRangeOverrides({ ...ws, axes: [{ pillId: PROFIT, min: 0 }] }, { chartType: 'badge_vert_bar', slots }).overrides, {});
	assert.deepEqual(axisRangeOverrides({ ...ws, axes: undefined }, { chartType: 'badge_vert_bar', slots }).overrides, {}, 'IR without axes');
	assert.deepEqual(axisRangeOverrides({ ...ws, axes: [{ pillId: SALES, min: 0 }] }, { chartType: 'badge_horiz_stackedbar', slots }).overrides, { value_scale_min: '0' });
});

test('a stack sorted by its measure orders each bar by value, from the base as Tableau draws the sort', () => {
	const ws = sheet({ name: 'By Area %', rows: SALES, cols: CATEGORY, enc: { color: [REGION] } });
	const slots = [
		{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
		{ pillId: REGION, mapping: 'SERIES', role: 'dim' },
		{ pillId: SALES, mapping: 'VALUE', role: 'measure' }
	];
	const sorted = (direction, using = SALES) => ({ ...ws, sorts: [{ pillId: REGION, kind: 'computed', direction, using }] });
	const method = (w, chartType) => stackSortOverrides(w, { chartType, slots }).overrides.category_sort_method;
	assert.equal(method(sorted('ASC'), 'badge_vert_100pct'), 'Descending', 'the smallest is on top in Tableau, the largest at the base');
	assert.equal(method(sorted('DESC'), 'badge_vert_stackedbar'), 'Ascending');
	assert.equal(method(sorted('ASC'), 'badge_horiz_stackedbar'), 'Ascending');
	assert.equal(method(sorted('ASC', PROFIT), 'badge_vert_stackedbar'), undefined, 'a sort by another measure');
	assert.equal(method(sorted('ASC'), 'badge_vert_multibar'), undefined);
	assert.equal(method(ws, 'badge_vert_stackedbar'), undefined);
});

const FYQ = p('none', 'Fiscal Year');
const FYP = p('none', 'Customer');
const CNTD = p('ctd', 'Customer', 'qk');

function trellisCard(extra = {}) {
	const ws = sheet({ cols: `${FYQ} / ${FYP}`, rows: CNTD, mark: 'Bar', enc: { text: [SALES, CNTD] } });
	ws.panes[0].showLabels = true;
	Object.assign(ws, extra);
	const ir = workbook({ worksheets: [ws] });
	const inference = inferChart(ws, ir, makeBindings());
	return { ws, ir, card: { chartType: inference.chartType, family: inference.family, slots: inference.mappings } };
}

test("markTextOverrides: Tableau's default tooltip with a Text-shelf measure on a trellis card, and the label through its EXTRAINFO", () => {
	const { ws, ir, card } = trellisCard();
	const { overrides, issues } = markTextOverrides(ws, ir, card);
	assert.equal(overrides.hover_text, 'Customer: %_CATEGORY_NAME\nFiscal Year: %_CATEGORY2_NAME\nDistinct count of Customer: %_VALUE\nSales: %_TOOLTIP1', 'the inner level first, as [none:Customer:nk] sorts before [none:Fiscal Year:nk]');
	assert.equal(overrides.datalabel_text, '%_TOOLTIP1\n%_VALUE');
	assert.ok(!issues.some((i) => i.code === 'chart.mark-text'));
});

test("markTextOverrides: tooltip-mode 'none' writes no hover text and says Domo keeps its default", () => {
	const { ws, ir, card } = trellisCard({ tooltipMode: 'none' });
	const { overrides, issues } = markTextOverrides(ws, ir, card);
	assert.equal(overrides.hover_text, undefined);
	assert.equal(overrides.datalabel_text, '%_TOOLTIP1\n%_VALUE');
	assert.deepEqual(issues.map((i) => [i.severity, i.code]), [['info', 'chart.tooltip-off']]);
});

test('defaultTooltipText: dimensions, then measures and ATTR, each by instance name; date parts named; Measure Names with Measure Values on one line', () => {
	const ws = sheet({ cols: `${p('yr', 'Order Date', 'ok')} / ${REGION}`, rows: SALES, enc: { color: [CATEGORY], tooltip: [PROFIT, SALES, p('attr', 'Customer')] } });
	assert.equal(
		defaultTooltipText(ws, workbook({ worksheets: [ws] })),
		`Category: <${CATEGORY}>\nRegion: <${REGION}>\nYear of Order Date: <${p('yr', 'Order Date', 'ok')}>\nCustomer: <${p('attr', 'Customer')}>\nProfit: <${PROFIT}>\nSales: <${SALES}>`
	);
	const names = `[${DS}].[:Measure Names]`;
	const mv = sheet({ cols: `${CATEGORY} / ${names}`, rows: '[Multiple Values]', measureValues: [SALES, PROFIT] });
	assert.equal(defaultTooltipText(mv, workbook({ worksheets: [mv] })), `Category: <${CATEGORY}>\n<${names}>: <[Multiple Values]>`);
});

const titles = (ws, chartType, slots) => axisTitleOverrides(ws, workbook({ worksheets: [ws] }), { chartType, slots });
const BAR_SLOTS = [
	{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
	{ pillId: SALES, mapping: 'VALUE', role: 'measure' }
];

test('axisTitleOverrides: the custom value title, else the default name; the category field labels in shelf order', () => {
	const { ws, ir, card } = trellisCard({ axisTitles: [{ pillId: CNTD, scope: 'rows', axis: 0, title: 'Order Items' }] });
	const { overrides, issues } = axisTitleOverrides(ws, ir, card);
	assert.deepEqual(overrides, { title_y: 'Order Items', title_x: 'Fiscal Year / Customer' });
	assert.deepEqual(issues.map((i) => i.code), ['chart.axis-title-position']);
	assert.match(issues[0].message, /column field labels \(Fiscal Year \/ Customer\) above the chart/);
	assert.equal(axisTitleOverrides(trellisCard().ws, ir, card).overrides.title_y, 'Distinct count of Customer');
	const bar = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' });
	assert.deepEqual(titles(bar, 'badge_vert_bar', BAR_SLOTS).overrides, { title_y: 'Sales', title_x: 'Category' }, 'a sum has no prefix');
});

test('axisTitleOverrides: a blank title, a hidden axis, hidden field labels and hidden headers give no title', () => {
	const bar = (extra) => Object.assign(sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' }), extra);
	assert.deepEqual(titles(bar({ axisTitles: [{ pillId: SALES, scope: 'rows', axis: 0, title: '' }] }), 'badge_vert_bar', BAR_SLOTS).overrides, { title_x: 'Category' });
	assert.deepEqual(titles(bar({ hiddenAxes: [{ pillId: SALES, scope: 'rows', axis: 0 }] }), 'badge_vert_bar', BAR_SLOTS).overrides, { title_x: 'Category' });
	assert.deepEqual(titles(bar({ hiddenAxes: [{ pillId: SALES, scope: 'rows', axis: 1 }] }), 'badge_vert_bar', BAR_SLOTS).overrides.title_y, 'Sales', 'a second axis does not hide the first');
	const noLabels = titles(bar({ hiddenFieldLabels: ['cols'] }), 'badge_vert_bar', BAR_SLOTS);
	assert.deepEqual([noLabels.overrides, noLabels.issues], [{ title_y: 'Sales' }, []]);
	assert.deepEqual(titles(bar({ hiddenHeaders: [CATEGORY] }), 'badge_vert_bar', BAR_SLOTS).overrides, { title_y: 'Sales' });
});

test('axisTitleOverrides: horizontal bars, scatter plots and combos', () => {
	const horiz = titles(sheet({ rows: CATEGORY, cols: SALES, mark: 'Bar' }), 'badge_horiz_bar', BAR_SLOTS);
	assert.deepEqual(horiz.overrides, { title_y: 'Sales', title_x: 'Category' });
	assert.deepEqual(horiz.issues, [], 'row field labels sit beside the axis, as Domo draws them');
	const scatter = sheet({ cols: SALES, rows: p('avg', 'Profit', 'qk'), mark: 'Circle', enc: { detail: [REGION] } });
	const xy = [
		{ pillId: SALES, mapping: 'XTIME', role: 'measure' },
		{ pillId: p('avg', 'Profit', 'qk'), mapping: 'VALUE', role: 'measure' },
		{ pillId: REGION, mapping: 'SERIES', role: 'dim' }
	];
	assert.deepEqual(titles(scatter, 'badge_xyscatterplot_basic', xy).overrides, { title_x: 'Sales', title_y: 'Avg. Profit' });
	const combo = sheet({ cols: CATEGORY, rows: `${SALES} + ${PROFIT}`, mark: 'Bar' });
	const comboSlots = [{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' }, { pillId: PROFIT, mapping: 'SERIES', role: 'measure' }, { pillId: SALES, mapping: 'SERIES', role: 'measure' }];
	assert.deepEqual(titles(combo, 'badge_line_bar', comboSlots).overrides, { title_x: 'Category' });
	assert.deepEqual(titles(combo, 'badge_vert_multibar', comboSlots).overrides.title_y, 'Profit & Sales', 'measures sharing the value axis');
	assert.deepEqual(titles(sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar' }), 'badge_basic_table', BAR_SLOTS).overrides, {}, 'tables have no axes');
});
