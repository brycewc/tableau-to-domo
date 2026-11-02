import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferChart, classifyPill } from '../../src/convert/chart-types.js';
import { DS, p, sheet, workbook, makeBindings } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const PROFIT = p('sum', 'Profit', 'qk');
const REGION = p('none', 'Region');
const CATEGORY = p('none', 'Category');

function infer(spec) {
	const ws = sheet(spec);
	const ir = workbook({ worksheets: [ws] });
	return inferChart(ws, ir, makeBindings());
}

const slots = (r) => r.mappings.map((m) => `${m.mapping}=${m.pillId.replace(`[${DS}].`, '')}`);
const codes = (r) => r.warnings.map((w) => w.code);

test('classifyPill distinguishes measures, dates, geo and generated lat/long', () => {
	const ws = sheet({ rows: SALES });
	const ir = workbook({ worksheets: [ws] });
	assert.equal(classifyPill(ws, ir, SALES).kind, 'measure');
	assert.equal(classifyPill(ws, ir, p('tmn', 'Order Date', 'qk')).kind, 'date');
	assert.equal(classifyPill(ws, ir, p('none', 'Order Date', 'ok')).kind, 'date');
	assert.equal(classifyPill(ws, ir, p('none', 'State')).geoRole, 'state');
	assert.equal(classifyPill(ws, ir, `[${DS}].[Latitude (generated)]`).kind, 'latlong');
	assert.equal(classifyPill(ws, ir, `[${DS}].[:Measure Names]`).kind, 'measure-names');
	assert.equal(classifyPill(ws, ir, '[Multiple Values]').kind, 'measure-values');
	assert.equal(classifyPill(ws, ir, p('attr', 'Region')).kind, 'dimension');
});

test('Automatic: dimension on columns, measure on rows is a vertical bar', () => {
	const r = infer({ cols: CATEGORY, rows: SALES });
	assert.equal(r.chartType, 'badge_vert_bar');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.equal(r.mark, 'Bar');
});

test('dimension on rows, measure on columns is a horizontal bar', () => {
	const r = infer({ rows: CATEGORY, cols: SALES, mark: 'Bar' });
	assert.equal(r.chartType, 'badge_horiz_bar');
});

test('color dimension stacks bars', () => {
	const r = infer({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [REGION] } });
	assert.equal(r.chartType, 'badge_vert_stackedbar');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'SERIES=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('color on the same field as the category does not add a series', () => {
	const r = infer({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [CATEGORY] } });
	assert.equal(r.chartType, 'badge_vert_bar');
});

test('nested dimension duplicated on color is a grouped bar', () => {
	const r = infer({ cols: `${CATEGORY} / ${REGION}`, rows: SALES, mark: 'Bar', enc: { color: [REGION] } });
	assert.equal(r.chartType, 'badge_vert_multibar');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'SERIES=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('percent-of-total bars with a color dimension are 100% bars', () => {
	const r = infer({ rows: CATEGORY, cols: p('pcto:sum', 'Sales', 'qk'), mark: 'Bar', enc: { color: [REGION] } });
	assert.equal(r.chartType, 'badge_horiz_100pct');
});

test('continuous month on columns is a line with a month truncation', () => {
	const date = p('tmn', 'Order Date', 'qk');
	const r = infer({ cols: date, rows: SALES, enc: { color: [REGION] } });
	assert.equal(r.chartType, 'badge_two_trendline');
	assert.equal(r.mark, 'Line');
	assert.deepEqual(slots(r), ['ITEM=[tmn:Order Date:qk]', 'SERIES=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('discrete year on columns defaults to a line, nested year/month collapses to a month grain', () => {
	const year = p('yr', 'Order Date', 'ok');
	const month = p('mn', 'Order Date', 'ok');
	const r = infer({ cols: `${year} / ${month}`, rows: SALES });
	assert.equal(r.chartType, 'badge_two_trendline');
	assert.equal(r.mappings[0].mapping, 'ITEM');
	assert.equal(r.mappings[0].dateTrunc, 'month');
});

test('area marks: stacked with a color dimension, overlay without', () => {
	const date = p('tmn', 'Order Date', 'qk');
	assert.equal(infer({ cols: date, rows: SALES, mark: 'Area', enc: { color: [REGION] } }).chartType, 'badge_stackedtrend');
	assert.equal(infer({ cols: date, rows: SALES, mark: 'Area' }).chartType, 'badge_vert_area_overlay');
});

test('dual axis bar + line maps to badge_line_bar with an issue', () => {
	const date = p('tmn', 'Order Date', 'qk');
	const r = infer({
		cols: date,
		rows: `${SALES} + ${PROFIT}`,
		panes: [
			{ markClass: 'Automatic', encodings: {} },
			{ markClass: 'Bar', yAxisPill: SALES, encodings: {} },
			{ markClass: 'Line', yAxisPill: PROFIT, encodings: {} }
		]
	});
	assert.equal(r.chartType, 'badge_line_bar');
	assert.ok(codes(r).includes('chart.dual-axis'));
	assert.deepEqual(
		r.mappings.filter((m) => m.mapping === 'VALUE'),
		[]
	);
	assert.deepEqual(
		r.mappings.filter((m) => m.mapping === 'SERIES').map((m) => [m.pillId, m.role]),
		[
			[PROFIT, 'measure'],
			[SALES, 'measure']
		]
	);
});

test('dual axis combo with the line pane first still lists the line measure first and the bar measure last', () => {
	const date = p('tmn', 'Order Date', 'qk');
	const r = infer({
		cols: date,
		rows: `${PROFIT} + ${SALES}`,
		panes: [
			{ markClass: 'Line', yAxisPill: PROFIT, encodings: {} },
			{ markClass: 'Bar', yAxisPill: SALES, encodings: {} }
		]
	});
	assert.equal(r.chartType, 'badge_line_bar');
	assert.deepEqual(slots(r).filter((x) => /^(VALUE|SERIES)=/.test(x)), ['SERIES=[sum:Profit:qk]', 'SERIES=[sum:Sales:qk]']);
});

test('extra measures are dropped with a warning when a dimension holds SERIES', () => {
	const r = infer({ cols: CATEGORY, rows: `${SALES} + ${PROFIT}`, mark: 'Bar', enc: { color: [REGION] } });
	assert.equal(r.mappings.filter((m) => m.mapping === 'VALUE').length, 1);
	assert.deepEqual(slots(r).filter((x) => x.startsWith('SERIES=')), ['SERIES=[none:Region:nk]']);
	assert.ok(r.warnings.some((w) => w.code === 'chart.multi-measure' && w.severity === 'warning'));
});

test('multiple measures (Measure Values) on a bar are a multi-series card: every measure in SERIES, no VALUE', () => {
	const r = infer({ cols: CATEGORY, rows: '[Multiple Values]', mark: 'Bar', measureValues: [SALES, PROFIT], enc: { color: [`[${DS}].[:Measure Names]`] } });
	assert.equal(r.chartType, 'badge_vert_stackedbar');
	assert.equal(r.mappings.filter((m) => m.mapping === 'VALUE').length, 0);
	assert.deepEqual(slots(r).filter((x) => x.startsWith('SERIES=')), ['SERIES=[sum:Sales:qk]', 'SERIES=[sum:Profit:qk]']);
	assert.ok(codes(r).includes('chart.multi-measure'));
});

test('two measures on columns of a horizontal bar never leave a measure in SERIES next to a VALUE', () => {
	const r = infer({ rows: REGION, cols: `${p('ctd', 'Order ID', 'qk')} + ${SALES}`, mark: 'Bar' });
	assert.equal(r.chartType, 'badge_horiz_multibar');
	assert.deepEqual(slots(r), ['ITEM=[none:Region:nk]', 'SERIES=[ctd:Order ID:qk]', 'SERIES=[sum:Sales:qk]']);
	assert.ok(r.mappings.filter((m) => m.mapping === 'SERIES').every((m) => m.role === 'measure'));
});

test('a color measure on a bar is never a SERIES column', () => {
	const r = infer({ cols: CATEGORY, mark: 'Bar', enc: { label: [SALES], color: [PROFIT] } });
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.ok(codes(r).includes('chart.color-measure'));
	const shelf = infer({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [PROFIT] } });
	assert.deepEqual(slots(shelf), ['ITEM=[none:Category:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.ok(codes(shelf).includes('chart.color-measure'));
});

test('a combo with two line measures warns that Domo draws one line by default', () => {
	const date = p('tmn', 'Order Date', 'qk');
	const QTY = p('sum', 'Quantity', 'qk');
	const r = infer({
		cols: date,
		rows: `${SALES} + ${PROFIT} + ${QTY}`,
		panes: [
			{ markClass: 'Automatic', encodings: {} },
			{ markClass: 'Bar', yAxisPill: SALES, encodings: {} },
			{ markClass: 'Line', yAxisPill: PROFIT, encodings: {} },
			{ markClass: 'Line', yAxisPill: QTY, encodings: {} }
		]
	});
	assert.equal(r.chartType, 'badge_line_bar');
	assert.deepEqual(slots(r).filter((x) => x.startsWith('SERIES=')).at(-1), 'SERIES=[sum:Sales:qk]');
	assert.ok(r.warnings.some((w) => w.code === 'chart.dual-axis' && w.severity === 'warning' && /Quantity/.test(w.message)));
});

test('a dual axis on one measure colored on one pane keeps the colored pane', () => {
	const date = p('none', 'Quarter');
	const dual = (shared, bar, line) =>
		infer({
			cols: date,
			rows: `${SALES} + ${SALES}`,
			panes: [
				{ markClass: 'Bar', encodings: shared },
				{ markClass: 'Bar', yAxisPill: SALES, encodings: bar },
				{ markClass: 'Line', yAxisPill: SALES, encodings: line }
			]
		});
	const lines = dual({}, {}, { color: [REGION] });
	assert.equal(lines.chartType, 'badge_two_trendline');
	assert.equal(lines.family, 'line');
	assert.deepEqual(slots(lines), ['ITEM=[none:Quarter:nk]', 'SERIES=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.ok(lines.warnings.some((w) => w.code === 'chart.dual-axis' && /total bar \(Sales\) dropped/.test(w.message)));
	const bars = dual({}, { color: [REGION] }, {});
	assert.equal(bars.chartType, 'badge_vert_stackedbar');
	assert.ok(bars.warnings.some((w) => w.code === 'chart.dual-axis' && /total line \(Sales\) dropped/.test(w.message)));
	assert.equal(dual({}, { color: [REGION] }, { color: [REGION] }).chartType, 'badge_line_bar', 'both panes colored keep the line+bar');
	assert.equal(dual({ color: [REGION] }, {}, {}).chartType, 'badge_line_bar', 'a color on the shared pane colors both axes');
	assert.equal(dual({}, { color: [REGION] }, { color: [CATEGORY] }).chartType, 'badge_line_bar', 'panes colored by different dimensions keep the line+bar');
});

test('pie and dual-axis donut', () => {
	const pie = infer({ mark: 'Pie', enc: { color: [REGION], wedgeSize: [SALES] } });
	assert.equal(pie.chartType, 'badge_pie');
	assert.deepEqual(slots(pie), ['ITEM=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
	const donut = infer({
		rows: `${p('agg', 'Number', 'qk')} + ${p('agg', 'Number', 'qk')}`,
		panes: [
			{ markClass: 'Pie', yAxisPill: 'a', encodings: { color: [REGION], wedgeSize: [SALES] } },
			{ markClass: 'Pie', yAxisPill: 'b', encodings: {} }
		]
	});
	assert.equal(donut.chartType, 'badge_donut');
});

test('scatter: measures on both shelves, detail as series; size makes a bubble', () => {
	const customer = p('none', 'Customer');
	const r = infer({ cols: SALES, rows: PROFIT, enc: { detail: [customer] } });
	assert.equal(r.chartType, 'badge_xyscatterplot_basic');
	assert.deepEqual(slots(r), ['XTIME=[sum:Sales:qk]', 'VALUE=[sum:Profit:qk]', 'SERIES=[none:Customer:nk]']);
	const b = infer({ cols: SALES, rows: PROFIT, enc: { detail: [customer], size: [p('sum', 'Quantity', 'qk')] } });
	assert.equal(b.chartType, 'badge_xybubble');
	assert.ok(b.mappings.some((m) => m.mapping === 'BUBBLESIZE'));
});

test('disaggregated scatter plots raw rows', () => {
	const r = infer({ cols: p('none', 'Sales', 'qk'), rows: p('none', 'Profit', 'qk'), aggregated: false, mark: 'Circle' });
	assert.equal(r.chartType, 'badge_xyscatterplot_basic');
	assert.deepEqual(
		r.mappings.map((m) => m.role),
		['raw', 'raw']
	);
});

test('filled map on generated lat/long with a State role', () => {
	const r = infer({ rows: `[${DS}].[Latitude (generated)]`, cols: `[${DS}].[Longitude (generated)]`, enc: { detail: [p('none', 'State')], color: [SALES] } });
	assert.equal(r.chartType, 'badge_map_us_state');
	assert.deepEqual(slots(r), ['ITEM=[none:State:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('country and county filled maps; county flags FIPS', () => {
	const ll = { rows: `[${DS}].[Latitude (generated)]`, cols: `[${DS}].[Longitude (generated)]` };
	assert.equal(infer({ ...ll, mark: 'Map', enc: { detail: [p('none', 'Country')], color: [SALES] } }).chartType, 'badge_world_map');
	const county = infer({ ...ll, mark: 'Multipolygon', enc: { detail: [p('none', 'County')] } });
	assert.equal(county.chartType, 'badge_map_us_county');
	assert.equal(county.mappings[1].aggregation, 'COUNT');
	assert.ok(codes(county).includes('chart.map-region'));
});

test('point map on real latitude/longitude fields', () => {
	const r = infer({ rows: p('avg', 'Lat', 'qk'), cols: p('avg', 'Lon', 'qk'), mark: 'Circle', enc: { detail: [p('none', 'City')], size: [SALES] } });
	assert.equal(r.chartType, 'badge_map_latlong');
	assert.deepEqual(slots(r), ['COUNTRY=[none:City:nk]', 'LATITUDE=[avg:Lat:qk]', 'LONGITUDE=[avg:Lon:qk]', 'VALUE=[sum:Sales:qk]']);
});

test('city map on generated coordinates falls back with a geocoding issue', () => {
	const r = infer({ rows: `[${DS}].[Latitude (generated)]`, cols: `[${DS}].[Longitude (generated)]`, enc: { detail: [p('none', 'City')], size: [SALES] } });
	assert.equal(r.chartType, 'badge_basic_table');
	assert.ok(codes(r).includes('chart.geocoding'));
	assert.ok(codes(r).includes('chart.fallback'));
});

test('text table: flat list is a basic table, crosstab is a pivot', () => {
	const flat = infer({ rows: `${CATEGORY} / ${REGION}`, enc: { text: [SALES] } });
	assert.equal(flat.chartType, 'badge_basic_table');
	assert.deepEqual(slots(flat), ['VALUE=[none:Category:nk]', 'VALUE=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(
		flat.mappings.map((m) => m.role),
		['dim', 'dim', 'measure']
	);
	const pivot = infer({ rows: CATEGORY, cols: REGION, enc: { text: [SALES] } });
	assert.equal(pivot.chartType, 'badge_pivot_table');
	assert.deepEqual(slots(pivot), ['ROW=[none:Category:nk]', 'COLUMN=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('Measure Names on columns with Measure Values on text stays a flat table', () => {
	const r = infer({ rows: CATEGORY, cols: `[${DS}].[:Measure Names]`, measureValues: [SALES, PROFIT], enc: { text: ['[Multiple Values]'] } });
	assert.equal(r.chartType, 'badge_basic_table');
	assert.equal(r.mappings.length, 3);
});

test('KPI: one measure is a single value, two use multi value', () => {
	assert.equal(infer({ enc: { text: [SALES] } }).chartType, 'badge_singlevalue');
	const two = infer({ enc: { text: [SALES, PROFIT] }, mark: 'Text' });
	assert.equal(two.chartType, 'badge_multi_value');
	assert.deepEqual(
		two.mappings.map((m) => m.mapping),
		['VALUE', 'TARGET']
	);
	assert.equal(infer({ enc: { text: [SALES, PROFIT, p('sum', 'Quantity', 'qk')] }, mark: 'Text' }).chartType, 'badge_basic_table');
});

test('treemap: square marks with no shelves', () => {
	const r = infer({ mark: 'Square', enc: { label: [CATEGORY], size: [SALES], color: [PROFIT] } });
	assert.equal(r.chartType, 'badge_treemap');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'VALUE=[sum:Sales:qk]', 'COLOR=[sum:Profit:qk]']);
});

test('heat map: dimensions on both shelves with a color measure', () => {
	const r = infer({ rows: REGION, cols: CATEGORY, enc: { color: [SALES] } });
	assert.equal(r.mark, 'Square');
	assert.equal(r.chartType, 'badge_heatmap');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'SERIES=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('gantt: task on rows, date on columns, size duration', () => {
	const r = infer({ rows: CATEGORY, cols: p('tdy', 'Order Date', 'qk'), mark: 'GanttBar', enc: { size: [p('sum', 'Duration', 'qk')], color: [REGION] } });
	assert.equal(r.chartType, 'badge_gantt');
	assert.deepEqual(
		r.mappings.map((m) => m.mapping),
		['ITEM', 'START_DATE', 'END_DATE', 'CATEGORY']
	);
	assert.equal(r.mappings[2].derived.type, 'date-add');
});

test('histogram: bin on columns and a count on rows', () => {
	const r = infer({ cols: p('none', 'Sales (bin)', 'ok'), rows: p('cnt', 'Sales', 'qk') });
	assert.equal(r.chartType, 'badge_vert_histogram');
	assert.equal(r.mappings[0].useBinSource, true);
	assert.equal(r.mappings[0].role, 'raw');
});

test('density marks route like circles', () => {
	const r = infer({ cols: CATEGORY, rows: SALES, mark: 'Heatmap' });
	assert.equal(r.chartType, 'badge_vert_bar');
	assert.ok(codes(r).includes('chart.density'));
});

test('unknown marks fall back to a table with chart.fallback', () => {
	const r = infer({ cols: CATEGORY, rows: SALES, mark: 'Ribbon' });
	assert.equal(r.chartType, 'badge_basic_table');
	assert.ok(codes(r).includes('chart.fallback'));
});

test('tooltip measures fill EXTRAINFO1..3 and detail goes to groupBy', () => {
	const tips = [PROFIT, p('sum', 'Quantity', 'qk'), p('avg', 'Sales', 'qk'), p('max', 'Profit', 'qk')];
	const r = infer({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { tooltip: tips, detail: [p('none', 'Segment')] } });
	assert.deepEqual(
		r.mappings.filter((m) => m.mapping.startsWith('EXTRAINFO')).map((m) => m.mapping),
		['EXTRAINFO1', 'EXTRAINFO2', 'EXTRAINFO3']
	);
	assert.deepEqual(r.detail, [p('none', 'Segment')]);
	assert.ok(codes(r).includes('chart.tooltip'));
});

/** Infer with the worksheet adjusted first (table calc addressing, tooltips). */
function inferWith(spec, adjust) {
	const ws = sheet(spec);
	adjust(ws);
	return inferChart(ws, workbook({ worksheets: [ws] }), makeBindings());
}

const PCT_COUNT = p('pcto:cnt', 'Customer', 'qk');
const COUNT = p('cnt', 'Customer', 'qk');
const alongField = (field) => (ws) => {
	ws.pills[PCT_COUNT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[${field}]`], attrs: { prefix: 'pcto' } };
};

test('a dimension on the measure shelf that is also on Color is the SERIES; the other shelf stays the category axis', () => {
	// Channel Growth: rows Channel * % of total along Channel, columns the period, Channel on Color.
	const spec = { rows: `${REGION} * ${PCT_COUNT}`, cols: CATEGORY, enc: { color: [REGION], text: [PCT_COUNT], tooltip: [COUNT] } };
	const r = inferWith(spec, alongField('Region'));
	assert.equal(r.chartType, 'badge_vert_100pct');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'SERIES=[none:Region:nk]', `VALUE=[pcto:cnt:Customer:qk]`]);
	assert.ok(r.warnings.some((w) => w.code === 'chart.small-multiples' && /drawn as series/.test(w.message)));
});

test('a lone pane-splitting dimension with no other series is the SERIES and draws side by side', () => {
	const r = infer({ rows: `${REGION} * ${SALES}`, cols: CATEGORY, mark: 'Bar' });
	assert.equal(r.chartType, 'badge_vert_multibar');
	assert.deepEqual(slots(r), ['ITEM=[none:Category:nk]', 'SERIES=[none:Region:nk]', 'VALUE=[sum:Sales:qk]']);
});

test('a pane-splitting dimension is nested into the axis only when Color holds another series dimension', () => {
	const r = infer({ rows: `${REGION} * ${SALES}`, cols: CATEGORY, mark: 'Bar', enc: { color: [p('none', 'Segment')] } });
	assert.deepEqual(slots(r), ['ITEM=[none:Region:nk]', 'SERIES=[none:Segment:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(r.mappings[0].derived, { type: 'concat', pillIds: [REGION, CATEGORY] });
	assert.equal(r.chartType, 'badge_vert_stackedbar');
	assert.ok(r.warnings.some((w) => w.code === 'chart.small-multiples' && /nested into the category axis/.test(w.message)));
});

test('percent of total along the category axis is not a 100% chart: each series sums to 100%, not each category', () => {
	const spec = { rows: PCT_COUNT, cols: CATEGORY, mark: 'Bar', enc: { color: [REGION] } };
	assert.equal(inferWith(spec, alongField('Region')).chartType, 'badge_vert_100pct');
	assert.equal(inferWith(spec, alongField('Category')).chartType, 'badge_vert_stackedbar');
});

test('tooltip measures already on the card (same field and aggregation) take no EXTRAINFO slot', () => {
	const spec = { rows: PCT_COUNT, cols: CATEGORY, mark: 'Bar', enc: { color: [REGION], tooltip: [COUNT, PROFIT] } };
	// On a 100% chart VALUE is the count itself; along the axis VALUE is the percent, so the count is extra.
	const pct100 = inferWith(spec, alongField('Region'));
	assert.deepEqual(pct100.mappings.filter((m) => /^EXTRAINFO/.test(m.mapping)).map((m) => m.pillId), [PROFIT]);
	const stacked = inferWith(spec, alongField('Category'));
	assert.deepEqual(stacked.mappings.filter((m) => /^EXTRAINFO/.test(m.mapping)).map((m) => m.pillId), [COUNT, PROFIT]);
});

test('with a custom tooltip only the measures it names fill EXTRAINFO slots', () => {
	const spec = { cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { tooltip: [PROFIT, p('sum', 'Quantity', 'qk')] } };
	const r = inferWith(spec, (ws) => {
		ws.panes[0].tooltip = `<${CATEGORY}>: <${SALES}>\nQty: <${p('sum', 'Quantity', 'qk')}>`;
	});
	assert.deepEqual(
		r.mappings.filter((m) => /^EXTRAINFO/.test(m.mapping)).map((m) => [m.mapping, m.pillId]),
		[['EXTRAINFO1', p('sum', 'Quantity', 'qk')]]
	);
	assert.ok(!codes(r).includes('chart.tooltip'));
});

test('color by measure on a bar is flagged', () => {
	const r = infer({ cols: CATEGORY, rows: SALES, mark: 'Bar', enc: { color: [PROFIT] } });
	assert.equal(r.chartType, 'badge_vert_bar');
	assert.ok(codes(r).includes('chart.color-measure'));
});

test('single measure on a shelf with no dimension becomes a KPI', () => {
	assert.equal(infer({ rows: SALES, mark: 'Bar' }).chartType, 'badge_singlevalue');
});

test('discrete aggregate pills are headers, not measure axes', () => {
	const r = infer({ rows: `${CATEGORY} / ${p('min', 'Region', 'nk')}`, cols: `${SALES} + ${PROFIT}`, mark: 'Bar' });
	assert.equal(r.chartType, 'badge_horiz_multibar');
	assert.ok(!codes(r).includes('chart.measure-axes'));
	assert.ok(codes(r).includes('chart.discrete-aggregate'));
	assert.deepEqual(slots(r).filter((x) => /^(VALUE|SERIES)=/.test(x)), ['SERIES=[sum:Sales:qk]', 'SERIES=[sum:Profit:qk]']);
	const one = infer({ cols: p('min', 'Region', 'nk'), rows: SALES });
	assert.notEqual(one.family, 'scatter');
});

test('a discrete aggregate on the text mark stays a pivot value next to a discrete aggregate header', () => {
	const r = infer({ rows: `${CATEGORY} / ${p('ctd', 'Customer', 'ok')}`, cols: REGION, enc: { text: [p('avg', 'Sales', 'ok')] } });
	assert.equal(r.chartType, 'badge_pivot_table');
	assert.deepEqual(slots(r).filter((x) => x.startsWith('VALUE=')), ['VALUE=[avg:Sales:ok]', 'VALUE=[ctd:Customer:ok]']);
});

test('continuous dimensions on both axes with an Automatic mark become a scatter plot', () => {
	const r = infer({ rows: p('none', 'Quantity', 'qk'), cols: p('none', 'Duration', 'qk'), enc: { size: [p('avg', 'Sales', 'qk')], color: [REGION] } });
	assert.equal(r.family, 'scatter');
	assert.deepEqual(slots(r).slice(0, 2), ['XTIME=[none:Duration:qk]', 'VALUE=[none:Quantity:qk]']);
});

test('axis-less circles keep their size and color measures', () => {
	const r = infer({ mark: 'Circle', enc: { size: [SALES], text: [REGION], color: [PROFIT] } });
	assert.deepEqual(
		slots(r).filter((x) => /Sales|Profit/.test(x)),
		['VALUE=[sum:Sales:qk]', 'VALUE=[sum:Profit:qk]']
	);
});

test('rows dim * (bar + line) on a dual axis splits into one card per member', () => {
	const date = p('tmn', 'Order Date', 'qk');
	const r = infer({
		cols: date,
		rows: `${REGION} * (${SALES} + ${PROFIT})`,
		panes: [
			{ markClass: 'Automatic', encodings: {} },
			{ markClass: 'Bar', yAxisPill: SALES, encodings: { color: [REGION] } },
			{ markClass: 'Line', yAxisPill: PROFIT, encodings: {} }
		]
	});
	assert.deepEqual(r.split, { pillId: REGION });
	assert.equal(r.chartType, 'badge_line_bar');
	assert.deepEqual(slots(r), ['ITEM=[tmn:Order Date:qk]', 'SERIES=[sum:Profit:qk]', 'SERIES=[sum:Sales:qk]']);
	assert.ok(!r.warnings.some((w) => /dropped|drawn as series/.test(w.message)));
	assert.ok(r.warnings.some((w) => w.code === 'chart.small-multiples' && w.severity === 'info'));
});

test('a plain bar with one measure keeps the pane dimension as its series', () => {
	const r = infer({ cols: CATEGORY, rows: `${REGION} * ${SALES}`, mark: 'Bar', enc: { color: [REGION] } });
	assert.equal(r.split, undefined);
	assert.ok(slots(r).includes('SERIES=[none:Region:nk]'));
});

test('a color dimension takes the series from a nested category level whose headers are hidden', () => {
	const ws = sheet({ cols: `${REGION} / ${CATEGORY}`, rows: SALES, enc: { color: [p('none', 'Segment')] } });
	ws.hiddenHeaders = [CATEGORY];
	const r = inferChart(ws, workbook({ worksheets: [ws] }), makeBindings());
	assert.equal(r.chartType, 'badge_vert_stackedbar');
	assert.deepEqual(slots(r), ['ITEM=[none:Region:nk]', 'SERIES=[none:Segment:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(r.sortOnly, [CATEGORY]);
});

test('visible category levels with a color on none of them combine into one ITEM, stacked by the color', () => {
	const SEGMENT = p('none', 'Segment');
	const r = infer({ cols: `${REGION} / ${CATEGORY}`, rows: SALES, enc: { color: [SEGMENT] } });
	assert.equal(r.chartType, 'badge_vert_stackedbar');
	assert.deepEqual(slots(r), ['ITEM=[none:Region:nk]', 'SERIES=[none:Segment:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(r.mappings[0].derived, { type: 'concat', pillIds: [REGION, CATEGORY] });
	assert.deepEqual(codes(r), ['chart.combined-category']);
	assert.match(r.warnings[0].message, /Region, Category are combined into one category \(Region \+ Category/);

	const ACCOUNT_ID = p('none', 'AccountID');
	const ACCOUNT = p('none', 'AccountName');
	const horiz = infer({ rows: `${ACCOUNT_ID} / ${ACCOUNT}`, cols: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	assert.equal(horiz.chartType, 'badge_horiz_stackedbar');
	assert.deepEqual(horiz.mappings[0].derived.pillIds, [ACCOUNT_ID, ACCOUNT]);
	assert.ok(slots(horiz).includes('SERIES=[none:Segment:nk]'));
});

test('a color on an inner level keeps the side-by-side nesting; three levels combine the outer ones', () => {
	const SEGMENT = p('none', 'Segment');
	const inner = infer({ cols: `${REGION} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [CATEGORY] } });
	assert.equal(inner.chartType, 'badge_vert_multibar');
	assert.equal(inner.mappings[0].derived, undefined);
	assert.ok(slots(inner).includes('SERIES=[none:Category:nk]'));

	const three = infer({ cols: `${REGION} / ${CATEGORY} / ${SEGMENT}`, rows: SALES, mark: 'Bar' });
	assert.equal(three.chartType, 'badge_vert_multibar');
	assert.deepEqual(three.mappings[0].derived.pillIds, [REGION, CATEGORY]);
	assert.ok(slots(three).includes('SERIES=[none:Segment:nk]'));
	assert.ok(!codes(three).includes('chart.extra-dimension'));

	const colored = infer({ cols: `${REGION} / ${CATEGORY} / ${SEGMENT}`, rows: SALES, mark: 'Bar', enc: { color: [CATEGORY] } });
	assert.deepEqual(colored.mappings[0].derived.pillIds, [REGION, SEGMENT]);
	assert.ok(slots(colored).includes('SERIES=[none:Category:nk]'));
});

test('a one-member level sorts only; one visible level left keeps the color swap; a date level never combines', () => {
	const SEGMENT = p('none', 'Segment');
	const SHIP = p('none', 'Ship Mode');
	const ws = sheet({ cols: `${REGION} / ${CATEGORY} / ${SHIP}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	ws.filters = [{ fieldId: '[Ship Mode]', kind: 'categorical', include: ['First Class'] }];
	const r = inferChart(ws, workbook({ worksheets: [ws] }), makeBindings());
	assert.equal(r.chartType, 'badge_vert_stackedbar');
	assert.deepEqual(r.mappings[0].derived.pillIds, [REGION, CATEGORY]);
	assert.deepEqual(r.sortOnly, [SHIP]);

	const two = sheet({ cols: `${REGION} / ${SHIP}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	two.filters = [{ fieldId: '[Ship Mode]', kind: 'categorical', include: ['First Class'] }];
	const swap = inferChart(two, workbook({ worksheets: [two] }), makeBindings());
	assert.equal(swap.mappings[0].derived, undefined);
	assert.deepEqual(slots(swap), ['ITEM=[none:Region:nk]', 'SERIES=[none:Segment:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(swap.sortOnly, [SHIP]);

	const dated = infer({ cols: `${p('yr', 'Order Date', 'ok')} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	assert.equal(dated.mappings[0].derived, undefined);

	const nested = sheet({ cols: `${SHIP} / ${REGION} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [CATEGORY] } });
	nested.filters = [{ fieldId: '[Ship Mode]', kind: 'categorical', include: ['First Class'] }];
	const kept = inferChart(nested, workbook({ worksheets: [nested] }), makeBindings());
	assert.deepEqual(slots(kept), ['ITEM=[none:Region:nk]', 'SERIES=[none:Category:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(kept.sortOnly, [SHIP]);
	assert.ok(!codes(kept).includes('chart.combined-category') && !kept.warnings.some((w) => /dropped/.test(w.message)));
});

test('levels beside a pane series on the value shelf combine into the ITEM instead of being dropped', () => {
	const SEGMENT = p('none', 'Segment');
	const r = infer({ rows: CATEGORY, cols: `${SEGMENT} * ${SALES}`, mark: 'Bar', enc: { color: [SEGMENT] } });
	assert.equal(r.mappings[0].derived, undefined, 'one level stays plain');
	const two = infer({ rows: `${REGION} / ${CATEGORY}`, cols: `${SEGMENT} * ${SALES}`, mark: 'Bar', enc: { color: [SEGMENT] } });
	assert.deepEqual(two.mappings[0].derived.pillIds, [REGION, CATEGORY]);
	assert.ok(slots(two).includes('SERIES=[none:Segment:nk]'));
	assert.equal(two.chartType, 'badge_horiz_multibar');
	assert.ok(!codes(two).includes('chart.extra-dimension'));
});

test('a filter action on a combined level keeps the nested levels, with a warning', () => {
	const SEGMENT = p('none', 'Segment');
	const ws = sheet({ cols: `${REGION} / ${CATEGORY}`, rows: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	const ir = workbook({ worksheets: [ws] });
	ir.actions = [{ id: '[A1]', name: 'By category', type: 'filter', trigger: 'select', source: { type: 'sheet', worksheets: [ws.name] }, fields: [{ source: '[Category]', target: '[Category]' }] }];
	const r = inferChart(ws, ir, makeBindings());
	assert.equal(r.mappings[0].derived, undefined);
	assert.equal(r.chartType, 'badge_vert_multibar');
	assert.ok(r.warnings.some((w) => w.code === 'chart.combined-category' && w.severity === 'warning' && /action By category/.test(w.message)));
	ir.actions[0].source.worksheets = ['Other'];
	assert.ok(inferChart(ws, ir, makeBindings()).mappings[0].derived);
});

test('percent of total along an inner combined level and the color is no 100% chart', () => {
	const SEGMENT = p('none', 'Segment');
	const spec = { rows: PCT_COUNT, cols: `${REGION} / ${CATEGORY}`, mark: 'Bar', enc: { color: [SEGMENT] } };
	const alongBoth = (ws) => {
		ws.pills[PCT_COUNT].tableCalc = { type: 'PctTotal', orderingType: 'Field', orderFields: [`[${DS}].[Category]`, `[${DS}].[Segment]`], attrs: { prefix: 'pcto' } };
	};
	assert.equal(inferWith(spec, alongBoth).chartType, 'badge_vert_stackedbar');
	assert.equal(inferWith(spec, alongField('Segment')).chartType, 'badge_vert_100pct');
});

test('a hidden axis level takes no slot: the next visible level or the color is the series, with no dropped dimension', () => {
	const SEGMENT = p('none', 'Segment');
	const ws = sheet({ rows: `${REGION} / ${CATEGORY} / ${SEGMENT}`, cols: SALES, mark: 'Bar', enc: { color: [SEGMENT] } });
	ws.hiddenHeaders = [CATEGORY];
	const r = inferChart(ws, workbook({ worksheets: [ws] }), makeBindings());
	assert.equal(r.chartType, 'badge_horiz_multibar', 'a nested visible level draws side-by-side bars, as Tableau does');
	assert.deepEqual(slots(r), ['ITEM=[none:Region:nk]', 'SERIES=[none:Segment:nk]', 'VALUE=[sum:Sales:qk]']);
	assert.deepEqual(r.sortOnly, [CATEGORY]);
	assert.deepEqual(r.warnings.map((w) => w.code), ['chart.hidden-level']);
	const noColor = sheet({ rows: `${REGION} / ${CATEGORY} / ${SEGMENT}`, cols: SALES, mark: 'Bar' });
	noColor.hiddenHeaders = [CATEGORY];
	assert.ok(slots(inferChart(noColor, workbook({ worksheets: [noColor] }), makeBindings())).includes('SERIES=[none:Segment:nk]'));
	const allHidden = sheet({ cols: REGION, rows: SALES, mark: 'Bar' });
	allHidden.hiddenHeaders = [REGION];
	assert.ok(slots(inferChart(allHidden, workbook({ worksheets: [allHidden] }), makeBindings())).includes('ITEM=[none:Region:nk]'), 'a lone hidden level stays the axis');
});
