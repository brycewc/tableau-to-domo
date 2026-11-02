import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisRangeOverrides, defaultHoverText, legendOverrides, legendPlacements, legendPosition, markTextOverrides, stackSortOverrides, translateMarkText } from '../../src/convert/chart-options.js';
import { textTokens } from '../../src/convert/chart-types.js';
import { DS, p, sheet, workbook } from './cards.fixtures.test.js';

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

test('markTextOverrides: without a custom tooltip, the chart default hover plus a line per EXTRAINFO column', () => {
	const ws = sheet({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { tooltip: [PROFIT, p('avg', 'Quantity', 'qk')] } });
	const slots = [
		{ pillId: CATEGORY, mapping: 'ITEM', role: 'dim' },
		{ pillId: SALES, mapping: 'VALUE', role: 'measure' },
		{ pillId: PROFIT, mapping: 'EXTRAINFO1', role: 'measure' },
		{ pillId: p('avg', 'Quantity', 'qk'), mapping: 'EXTRAINFO2', role: 'measure' }
	];
	const ir = workbook({ worksheets: [ws] });
	assert.deepEqual(markTextOverrides(ws, ir, { chartType: 'badge_vert_bar', family: 'bar', slots }).overrides, { hover_text: '%_CATEGORY_NAME : %_VALUE\nProfit: %_TOOLTIP1\nAvg. Quantity: %_TOOLTIP2' });
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
