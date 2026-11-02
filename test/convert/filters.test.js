import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFilterField, isAggregateControl, toCardFilters, toQuickFilterControls, relativeDateRange, parseTopBy, datePartFormula, filterDataType, exceedsSlicerLimit, filterRef, memberCondition } from '../../src/convert/filters.js';
import { DS, DATASET, p, makeBindings, cat } from './cards.fixtures.test.js';

const ctx = (extra = {}) => ({ datasetKey: DATASET, datasourceId: DS, object: { type: 'worksheet', name: 'S' }, ...extra });

function formulas() {
	const list = [];
	return {
		list,
		addFormula: (spec) => {
			const id = `calculation_card_${list.length + 1}`;
			list.push({ id, ...spec });
			return id;
		}
	};
}

test('categorical include and exclude lists become IN / NOT_IN with string values', () => {
	const r = toCardFilters([cat('Region', ['East', 'West']), { ...cat('Segment', undefined), exclude: ['Consumer'] }], makeBindings(), ctx());
	assert.deepEqual(r.filters, [
		{ column: 'Region', operand: 'IN', values: ['East', 'West'], dataType: 'string', filterType: 'COLUMN_ID' },
		{ column: 'Segment', operand: 'NOT_IN', values: ['Consumer'], dataType: 'string', filterType: 'COLUMN_ID' }
	]);
	assert.equal(r.approximate, false);
});

test('"all" categorical filters and Measure Names filters are dropped silently', () => {
	const r = toCardFilters([{ ...cat('Region'), all: true }, { pillId: 'x', datasourceId: DS, fieldId: '[:Measure Names]', kind: 'categorical', include: ['a'] }], makeBindings(), ctx());
	assert.deepEqual(r.filters, []);
	assert.deepEqual(r.issues, []);
});

test('nulls in an include list are left out with an info issue; numbers become strings', () => {
	const r = toCardFilters([{ ...cat('Quantity', [1, 2, null]) }], makeBindings(), ctx());
	assert.deepEqual(r.filters[0], { column: 'Quantity', operand: 'IN', values: ['1', '2'], dataType: 'numeric', filterType: 'COLUMN_ID' });
	assert.equal(r.issues[0].code, 'filter.null');
});

test('beast mode filters are saved the editor\'s way: no filterType or formulaId, so quick filters can resolve them', () => {
	const r = toCardFilters([cat('Is Big', ['Y'])], makeBindings(), ctx());
	assert.deepEqual(r.filters[0], { column: 'calculation_big', operand: 'IN', values: ['Y'], dataType: 'string' });
	assert.equal(filterRef({ kind: 'column', column: 'Region' }).filterType, 'COLUMN_ID');
	assert.deepEqual(filterRef({ kind: 'formula', formulaId: 'calculation_x' }), { column: 'calculation_x' });
});

test('filters on a set\'s In/Out pill compare In and Out, the values its beast mode returns', () => {
	const set = { ...makeBindings().get(DS, '[Is Big]'), setMembers: true };
	const r = toCardFilters([cat('Is Big', [true]), cat('Is Big', undefined, { exclude: [false] })], makeBindings({ '[Is Big]': set }), ctx());
	assert.deepEqual(r.filters.map((f) => [f.operand, f.values]), [['IN', ['In']], ['NOT_IN', ['Out']]]);
});

test("a set filter that keeps the set's members filters the source on its members, else the set beast mode on 'In'", () => {
	const base = { ...makeBindings().get(DS, '[Is Big]'), setMembers: true };
	const bindings = (set) => makeBindings({ '[Is Big]': { ...base, ...(set ? { set } : {}) } });
	const kept = (set, filter) => toCardFilters([filter], bindings(set), ctx());
	const members = { source: '[Region]', members: ['East', 'West'], exclude: false };
	const bare = cat('Is Big', undefined, { all: true, bare: true });
	const r = kept(members, bare);
	assert.deepEqual(r.filters, [{ column: 'Region', operand: 'IN', values: ['East', 'West'], dataType: 'string', filterType: 'COLUMN_ID' }], 'the source IN the members (Waterfall IN Expansion, New)');
	assert.ok(r.issues.some((i) => i.code === 'filter.set-members'));
	const level = cat('Is Big', undefined, { all: true, memberLevel: '[Region]' });
	assert.deepEqual(kept(members, level).filters.map((f) => [f.column, f.values]), [['Region', ['East', 'West']]], 'level-members on the source');
	const picked = cat('Is Big', ['West', 'North'], { memberLevel: '[Region]' });
	assert.deepEqual(kept(members, picked).filters.map((f) => [f.column, f.values]), [['Region', ['West']]], 'source members the sheet selects, within the set');
	const inBm = { column: 'calculation_big', operand: 'IN', values: ['In'], dataType: 'string' };
	assert.deepEqual(kept({ ...members, exclude: true }, bare).filters, [inBm], 'an exclude set keeps the rows its beast mode calls In');
	assert.deepEqual(kept({ ...members, members: ['East', null] }, bare).filters, [inBm], 'a null member cannot be listed');
	assert.deepEqual(kept(undefined, picked).filters.map((f) => [f.column, f.values]), [['calculation_big', ['In']], ['Region', ['West', 'North']]], 'no saved members: the set beast mode, and the selected source members, never the set beast mode IN them');
	assert.deepEqual(kept(members, cat('Is Big', [true])).filters.map((f) => [f.column, f.values]), [['calculation_big', ['In']]], 'In/Out mode is unchanged');
	assert.deepEqual(kept(members, cat('Is Big', undefined, { all: true })).filters, [], 'In/Out mode with All filters nothing');
	const q = toQuickFilterControls([bare], bindings(members), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual([q.controls, [...q.pillIds]], [[], []], 'no control: it stays a fixed card filter');
	assert.ok(q.issues.some((i) => i.code === 'filter.set-members'));
});

test('two shown filters on one column fold into one control: a selection wins over All, member lists intersect', () => {
	const all = cat('Region', undefined, { all: true });
	const picked = { ...cat('Region', ["26'Q2"]), pillId: `[${DS}].[none:Region:ok]` };
	const q = toQuickFilterControls([all, picked], makeBindings(), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual(q.controls.map((c) => c.values), [["26'Q2"]]);
	assert.deepEqual([...q.pillIds], [all.pillId, picked.pillId]);
	assert.deepEqual(q.sources, [[all.pillId, picked.pillId]]);
	const narrowed = toQuickFilterControls([cat('Region', ['East', 'West']), { ...cat('Region', ['West', 'North']), pillId: 'other' }], makeBindings(), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual(narrowed.controls.map((c) => c.values), [['West']]);
	const apart = toQuickFilterControls([cat('Region', ['East']), { ...cat('Region', ['West']), pillId: 'other' }], makeBindings(), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual([apart.controls.map((c) => c.values), apart.pillIds.has('other')], [[['East']], false], 'disjoint lists cannot fold: the second stays a fixed card filter');
});

test('"Non-null values" and "Null values only" filters compare with \'\', which the server reads as IS [NOT] NULL', () => {
	const range = (derivation, name, includedValues, kind = 'quantitative') => ({ pillId: p(derivation, name, 'qk'), datasourceId: DS, fieldId: `[${name}]`, kind, includedValues });
	const f = formulas();
	const r = toCardFilters(
		[range('none', 'Order Date', 'non-null', 'range-date'), range('none', 'Is Big', 'non-null'), range('none', 'Order Date', 'null', 'range-date'), range('none', 'Segment', 'null')],
		makeBindings(),
		ctx({ addFormula: f.addFormula })
	);
	assert.deepEqual(r.filters, [
		{ column: 'Order Date', filterType: 'COLUMN_ID', operand: 'NOT_IN', values: [''], dataType: 'date' },
		{ column: 'calculation_big', operand: 'NOT_IN', values: [''], dataType: 'string' },
		{ column: 'Order Date', filterType: 'COLUMN_ID', operand: 'IN', values: [''], dataType: 'date' },
		{ column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' }
	]);
	assert.equal(f.list[0].formula, "CASE WHEN `Segment` IS NULL THEN 'true' ELSE 'false' END");
	assert.deepEqual(r.issues, []);
	assert.equal(r.approximate, false);
});

test('a non-null filter on an aggregate is skipped with a warning, and on a count it keeps every mark', () => {
	const agg = (derivation, name) => ({ pillId: p(derivation, name, 'qk'), datasourceId: DS, fieldId: `[${name}]`, kind: 'quantitative', aggregated: true, includedValues: 'non-null' });
	const r = toCardFilters([agg('sum', 'Sales'), agg('ctd', 'Region')], makeBindings(), ctx());
	assert.deepEqual(r.filters, []);
	assert.deepEqual(r.issues.map((i) => [i.code, i.severity]), [['filter.null', 'warning']]);
	assert.equal(r.approximate, true);
});

test('quantitative ranges: BETWEEN, at-least (GREAT_THAN_EQUALS_TO), at-most', () => {
	const base = { pillId: p('none', 'Quantity', 'qk'), datasourceId: DS, fieldId: '[Quantity]', kind: 'quantitative', includedValues: 'in-range' };
	const r = toCardFilters([{ ...base, min: 1, max: 10 }, { ...base, min: 5 }, { ...base, max: 3 }], makeBindings(), ctx());
	assert.deepEqual(
		r.filters.map((f) => [f.operand, f.values, f.dataType]),
		[
			['BETWEEN', ['1', '10'], 'numeric'],
			['GREAT_THAN_EQUALS_TO', ['5'], 'numeric'],
			['LESS_THAN_EQUALS_TO', ['3'], 'numeric']
		]
	);
});

const agg = (derivation, name, extra = {}) => ({ pillId: p(derivation, name, 'qk'), datasourceId: DS, fieldId: `[${name}]`, kind: 'quantitative', includedValues: 'in-range', aggregated: true, ...extra });

test('aggregate range filters carry the pill aggregation (HAVING): at-least, between, at-most', () => {
	const r = toCardFilters([agg('sum', 'Sales', { min: 100 }), agg('avg', 'Profit', { min: -5, max: 5 }), agg('cnt', 'Quantity', { max: 3 })], makeBindings(), ctx());
	assert.deepEqual(r.filters, [
		{ column: 'Sales', aggregation: 'SUM', filterType: 'COLUMN_ID', dataType: 'numeric', operand: 'GREAT_THAN_EQUALS_TO', values: ['100'] },
		{ column: 'Profit', aggregation: 'AVG', filterType: 'COLUMN_ID', dataType: 'numeric', operand: 'BETWEEN', values: ['-5', '5'] },
		{ column: 'Quantity', aggregation: 'COUNT', filterType: 'COLUMN_ID', dataType: 'numeric', operand: 'LESS_THAN_EQUALS_TO', values: ['3'] }
	]);
	assert.equal(r.approximate, false);
	assert.ok(r.issues.every((i) => i.severity === 'info' && i.code === 'filter.aggregate'));
});

test('aggregate filters: an aggregated beast mode is filtered as is; MAX of a date keeps dataType date', () => {
	const r = toCardFilters([agg('usr', 'Profit Ratio', { min: 0.1 }), { ...agg('max', 'Order Date', { min: '2024-03-01T00:00:00' }), kind: 'range-date' }], makeBindings(), ctx());
	assert.deepEqual(r.filters, [
		{ column: 'calculation_pr', dataType: 'numeric', operand: 'GREAT_THAN_EQUALS_TO', values: ['0.1'] },
		{ column: 'Order Date', aggregation: 'MAX', filterType: 'COLUMN_ID', dataType: 'date', operand: 'GREAT_THAN_EQUALS_TO', values: ['2024-03-01'] }
	]);
});

test('aggregate filters: SUM of a row-level beast mode carries an aggregation and no filterType', () => {
	const r = toCardFilters([agg('sum', 'Sales (bin)', { min: 10 })], makeBindings(), ctx());
	assert.deepEqual(r.filters[0], { column: 'calculation_bin', aggregation: 'SUM', dataType: 'numeric', operand: 'GREAT_THAN_EQUALS_TO', values: ['10'] });
});

test('aggregate filters: COUNTD and an LOD with another outer aggregation filter an aggregated card beast mode', () => {
	const fx = formulas();
	const lod = { datasetKey: DATASET, kind: 'formula', name: 'Per Customer', formulaId: 'calculation_lod', expression: 'SUM(SUM(`Sales`) FIXED (BY `Customer`))', lodExpression: 'SUM(`Sales`) FIXED (BY `Customer`)', aggregated: true, dataType: 'DOUBLE' };
	const r = toCardFilters([agg('ctd', 'Customer', { max: 2 }), agg('avg', 'Per Customer', { min: 50 })], makeBindings({ '[Per Customer]': lod }), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters, [
		{ column: 'calculation_card_1', dataType: 'numeric', operand: 'LESS_THAN_EQUALS_TO', values: ['2'] },
		{ column: 'calculation_card_2', dataType: 'numeric', operand: 'GREAT_THAN_EQUALS_TO', values: ['50'] }
	]);
	assert.deepEqual(
		fx.list.map((f) => [f.formula, f.aggregated]),
		[
			['COUNT(DISTINCT `Customer`)', true],
			['AVG(SUM(`Sales`) FIXED (BY `Customer`))', true]
		]
	);
});

test('aggregate filters without bounds, or on all values, are dropped silently', () => {
	const r = toCardFilters([agg('sum', 'Sales'), agg('sum', 'Profit', { includedValues: 'all', min: 1 })], makeBindings(), ctx());
	assert.deepEqual(r.filters, []);
	assert.deepEqual(r.issues, []);
});

test('aggregate filters: ATTR is approximated with MAX; a COUNTD without card formulas and kurtosis are skipped', () => {
	const r = toCardFilters([agg('attr', 'Sales', { min: 1 }), agg('ctd', 'Customer', { min: 1 }), agg('kurtosis', 'Sales', { min: 1 })], makeBindings(), ctx());
	assert.deepEqual(r.filters.map((f) => f.aggregation), ['MAX']);
	assert.deepEqual(
		r.issues.filter((i) => i.severity === 'warning').map((i) => i.message),
		['Filter on aggregate Sales: ATTR is approximated with MAX', 'Filter on aggregate Customer needs a card beast mode that could not be built; skipped', 'Filter on aggregate Sales uses an aggregation Domo has no equivalent for; skipped']
	);
	assert.equal(r.approximate, true);
});

test('filters on table calculations are skipped with filter.table-calc', () => {
	const windowed = { datasetKey: DATASET, kind: 'formula', name: 'Running', formulaId: 'calculation_run', expression: 'SUM(SUM(`Sales`)) OVER (ORDER BY `Region`)', aggregated: true, dataType: 'DOUBLE' };
	const r = toCardFilters([agg('usr', 'Running', { min: 1 }), agg('pcto:sum', 'Sales', { max: 0.5 })], makeBindings({ '[Running]': windowed }), ctx());
	assert.deepEqual(r.filters, []);
	assert.deepEqual(r.issues.map((i) => i.code), ['filter.table-calc', 'filter.table-calc']);
	assert.equal(r.approximate, true);
});

test('a rank table calc kept to the first N ranks becomes a Top N on the ranked measure', () => {
	const r = toCardFilters([agg('rank:sum', 'Sales', { max: 5 }), agg('rank:usr', 'Profit Ratio', { min: 1, max: 3 })], makeBindings(), ctx());
	assert.deepEqual(r.filters, []);
	assert.deepEqual(r.tops, [
		{ count: 5, direction: 'top', orderBy: { column: 'Sales', order: 'DESCENDING', aggregation: 'SUM' }, fieldId: '[Sales]', by: 'Sales' },
		{ count: 3, direction: 'top', orderBy: { column: 'calculation_pr', formulaId: 'calculation_pr', order: 'DESCENDING' }, fieldId: '[Profit Ratio]', by: 'Profit Ratio' }
	]);
});

test('an ascending rank filter is a Bottom N; a rank partitioned by another view dimension is not a Top N', () => {
	const filter = agg('rank:sum', 'Sales', { max: 3 });
	const pills = (calc) => ({
		[filter.pillId]: { ...filter, fieldId: '[Sales]', datasourceId: DS, aggregated: true, tableCalc: calc },
		[p('none', 'Customer')]: { fieldId: '[Customer]', datasourceId: DS },
		[p('none', 'Region')]: { fieldId: '[Region]', datasourceId: DS }
	});
	const ws = (calc, rows) => ({ name: 'S', rowPills: rows, colPills: [filter.pillId], pills: pills(calc) });
	const asc = { type: 'Rank', orderingType: 'Columns', attrs: { prefix: 'rank', 'rank-options': 'Competition,Ascending' } };
	const bottom = toCardFilters([filter], makeBindings(), ctx({ worksheet: ws(asc, [p('none', 'Customer')]) }));
	assert.deepEqual(bottom.tops.map((t) => [t.direction, t.orderBy.order]), [['bottom', 'ASCENDING']]);
	const byRegion = { type: 'Rank', orderingType: 'Field', orderFields: ['[Customer]'], attrs: { prefix: 'rank' } };
	const partitioned = toCardFilters([filter], makeBindings(), ctx({ worksheet: ws(byRegion, [p('none', 'Region'), p('none', 'Customer')]) }));
	assert.deepEqual(partitioned.tops, []);
	assert.deepEqual(partitioned.issues.map((i) => i.code), ['filter.table-calc']);
});

test('an aggregate filter shown as a quick filter stays a fixed card filter; the control is not created', () => {
	const f = { ...agg('sum', 'Sales', { min: 100 }), shownOnDashboard: true };
	const r = toCardFilters([f], makeBindings(), ctx({ skipPillIds: new Set([f.pillId]) }));
	assert.equal(r.filters[0].aggregation, 'SUM');
	const q = toQuickFilterControls([f], makeBindings(), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual(q.controls, []);
	assert.deepEqual(q.issues.map((i) => [i.severity, i.code]), [['info', 'filter.aggregate']]);
});

test('a categorical quick filter on an aggregated beast mode stays on the card; one on ATTR of a dimension gets a control', () => {
	const ratio = { ...cat('Profit Ratio', ['1']), pillId: p('usr', 'Profit Ratio') };
	const region = { ...cat('Region', ['East']), pillId: p('attr', 'Region'), aggregated: true };
	const skip = new Set([ratio.pillId, region.pillId]);
	const r = toCardFilters([ratio, region], makeBindings(), ctx({ skipPillIds: skip }));
	assert.deepEqual(r.filters, [{ column: 'calculation_pr', operand: 'IN', values: ['1'], dataType: 'numeric' }]);
	const q = toQuickFilterControls([ratio, region], makeBindings(), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual(q.controls.map((c) => [c.column, c.values]), [['Region', ['East']]]);
});

test('an ATTR filter on a dimension the view does not group by filters each mark (HAVING); in the view it filters rows', () => {
	const region = { ...cat('Region', ['East']), pillId: p('attr', 'Region'), aggregated: true };
	const f = formulas();
	const r = toCardFilters([region, { ...region, include: [null], fieldId: '[Segment]', pillId: p('attr', 'Segment') }], makeBindings(), ctx({ addFormula: f.addFormula, viewDimensions: new Set(['[Customer]']) }));
	assert.deepEqual(r.filters.map((x) => [x.column, x.filterType, x.values]), [
		['calculation_card_1', undefined, ['true']],
		['calculation_card_2', undefined, ['true']]
	]);
	assert.deepEqual(f.list.map((x) => [x.formula, x.aggregated]), [
		["CASE WHEN (MIN(`Region`) = MAX(`Region`) AND MIN(`Region`) IN ('East')) THEN 'true' ELSE 'false' END", true],
		["CASE WHEN COUNT(`Segment`) = 0 THEN 'true' ELSE 'false' END", true]
	]);
	const excluded = toCardFilters([{ ...region, include: undefined, exclude: ['East'] }], makeBindings(), ctx({ addFormula: formulas().addFormula, viewDimensions: new Set() }));
	assert.deepEqual(excluded.filters[0].values, ['false']);
	const inView = toCardFilters([region], makeBindings(), ctx({ addFormula: formulas().addFormula, viewDimensions: new Set(['[Region]']) }));
	assert.deepEqual(inView.filters, [{ column: 'Region', operand: 'IN', values: ['East'], dataType: 'string', filterType: 'COLUMN_ID' }]);
	const q = toQuickFilterControls([region], makeBindings(), ctx({ dataSourceId: 'ref', viewDimensions: new Set() }));
	assert.deepEqual(q.issues.map((i) => [i.severity, i.code]), [['warning', 'filter.attr']]);
});

test('date ranges use dataType date and trim times', () => {
	const r = toCardFilters([{ pillId: p('none', 'Order Date', 'qk'), datasourceId: DS, fieldId: '[Order Date]', kind: 'range-date', min: '2023-01-01T00:00:00', max: '2023-12-31' }], makeBindings(), ctx());
	assert.deepEqual(r.filters[0], { column: 'Order Date', operand: 'BETWEEN', values: ['2023-01-01', '2023-12-31'], dataType: 'date', filterType: 'COLUMN_ID' });
});

test('relative dates map to INTERVAL_OFFSET and ROLLING_PERIOD', () => {
	assert.deepEqual(relativeDateRange({ periodType: 'month', first: 0, last: 0 }).range, { dateTimeRangeType: 'INTERVAL_OFFSET', interval: 'MONTH', offset: 0, count: 0 });
	assert.deepEqual(relativeDateRange({ periodType: 'year', first: -1, last: -1 }).range, { dateTimeRangeType: 'INTERVAL_OFFSET', interval: 'YEAR', offset: 1, count: 0 });
	assert.deepEqual(relativeDateRange({ periodType: 'month', first: -2, last: 0 }).range, { dateTimeRangeType: 'ROLLING_PERIOD', interval: 'MONTH', count: 3, offset: 0 });
	assert.deepEqual(relativeDateRange({ periodType: 'day', first: -7, last: -1 }).range, { dateTimeRangeType: 'ROLLING_PERIOD', interval: 'DAY', count: 7, offset: 1 });
	assert.deepEqual(relativeDateRange({ periodType: 'week', first: 1, last: 2 }).range, { dateTimeRangeType: 'ROLLING_PERIOD', interval: 'WEEK', count: -2, offset: -1 });
	assert.equal(relativeDateRange({ periodType: 'day', first: -3, last: 3 }).approximate, true);
});

test('relative-date filter becomes the subscription dateRangeFilter; a second one is skipped', () => {
	const rel = { pillId: p('none', 'Order Date', 'qk'), datasourceId: DS, fieldId: '[Order Date]', kind: 'relative-date', relative: { periodType: 'quarter', first: -1, last: -1 } };
	const r = toCardFilters([rel, { ...rel, fieldId: '[Ship Date]' }], makeBindings(), ctx());
	assert.deepEqual(r.dateRangeFilter, { column: { column: 'Order Date', exprType: 'COLUMN' }, dateTimeRange: { dateTimeRangeType: 'INTERVAL_OFFSET', interval: 'QUARTER', offset: 1, count: 0 } });
	assert.ok(r.issues.some((i) => i.code === 'filter.relative-date' && i.severity === 'warning'));
});

test('wildcard modes map to CONTAINS / STARTS_WITH / ENDS_WITH / EQUALS', () => {
	const w = (mode) => ({ pillId: p('none', 'Customer'), datasourceId: DS, fieldId: '[Customer]', kind: 'wildcard', wildcard: { pattern: 'Ab', mode } });
	const r = toCardFilters([w('contains'), w('starts-with'), w('ends-with'), w('exact')], makeBindings(), ctx());
	assert.deepEqual(
		r.filters.map((f) => f.operand),
		['CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'EQUALS']
	);
});

test('discrete year filters with contiguous years become a date BETWEEN on the raw column', () => {
	const r = toCardFilters([{ pillId: p('yr', 'Order Date', 'ok'), datasourceId: DS, fieldId: '[Order Date]', kind: 'categorical', include: [2022, 2023] }], makeBindings(), ctx());
	assert.deepEqual(r.filters[0], { column: 'Order Date', operand: 'BETWEEN', values: ['2022-01-01', '2023-12-31'], dataType: 'date', filterType: 'COLUMN_ID' });
});

test('discrete month filters use a card beast mode with month names', () => {
	const fx = formulas();
	const r = toCardFilters([{ pillId: p('mn', 'Order Date', 'ok'), datasourceId: DS, fieldId: '[Order Date]', kind: 'categorical', include: [1, 12] }], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters[0], { column: 'calculation_card_1', operand: 'IN', values: ['January', 'December'], dataType: 'string' });
	assert.equal(fx.list[0].formula, 'MONTHNAME(`Order Date`)');
});

test('top N yields an orderBy spec, resolving a parameter count', () => {
	const top = { pillId: p('none', 'Customer'), datasourceId: DS, fieldId: '[Customer]', kind: 'top', top: { count: '[Parameters].[Top N]', direction: 'top', by: 'SUM([Sales])' } };
	const r = toCardFilters([top], makeBindings(), ctx({ parameters: [{ id: '[Parameters].[Top N]', name: 'Top N', datatype: 'integer', domain: 'range', value: 10 }] }));
	assert.deepEqual(r.tops, [{ count: 10, direction: 'top', orderBy: { column: 'Sales', order: 'DESCENDING', aggregation: 'SUM' }, fieldId: '[Customer]', by: 'SUM([Sales])' }]);
	const bottom = toCardFilters([{ ...top, top: { count: 5, direction: 'bottom', by: 'SUM([Profit Ratio])' } }], makeBindings(), ctx());
	assert.deepEqual(bottom.tops[0].orderBy, { column: 'calculation_pr', formulaId: 'calculation_pr', order: 'ASCENDING' });
});

test('condition filters, unknown fields and blended fields raise issues', () => {
	const bindings = makeBindings({ '[Segment]': { datasetKey: 'other', kind: 'column', name: 'Segment', column: 'Segment', aggregated: false, dataType: 'STRING' } });
	const r = toCardFilters(
		[
			{ pillId: p('none', 'Region'), datasourceId: DS, fieldId: '[Region]', kind: 'condition', expression: 'SUM([Sales]) > 0' },
			{ pillId: 'x', datasourceId: DS, fieldId: '[Nope]', kind: 'categorical', include: ['a'] },
			cat('Segment', ['A']),
			cat('Broken', ['x'])
		],
		bindings,
		ctx()
	);
	assert.deepEqual(r.filters, []);
	assert.deepEqual(
		r.issues.map((i) => i.code),
		['filter.condition', 'filter.unsupported-field', 'filter.unsupported-field', 'filter.unsupported-field']
	);
});

test('context filters are kept and recorded', () => {
	const r = toCardFilters([cat('Region', ['East'], { context: true })], makeBindings(), ctx());
	assert.equal(r.filters.length, 1);
	assert.equal(r.issues[0].code, 'filter.context');
});

test('skipPillIds leaves interactive filters out of the card filters', () => {
	const f = cat('Region', ['East']);
	const r = toCardFilters([f], makeBindings(), ctx({ skipPillIds: new Set([f.pillId]) }));
	assert.deepEqual(r.filters, []);
});

test('quick filter controls carry the selection, display type by mode, and the dataset ref', () => {
	const dsRef = { $ref: `dataset:${DATASET}` };
	const region = cat('Region', ['East']);
	const qty = { pillId: p('none', 'Quantity', 'qk'), datasourceId: DS, fieldId: '[Quantity]', kind: 'quantitative', min: 1, max: 5 };
	const big = cat('Is Big', undefined, { all: true });
	const r = toQuickFilterControls([region, qty, big], makeBindings(), ctx({ dataSourceId: dsRef, modes: new Map([[region.pillId, 'radiolist']]) }));
	assert.deepEqual(r.controls[0], {
		controlType: 'SLICER',
		column: 'Region',
		name: 'Region',
		columnDisplayName: 'Region',
		type: 'string',
		displayType: 'single_select',
		operator: 'IN',
		values: ['East'],
		collapsed: false,
		dataSourceId: dsRef
	});
	assert.equal(r.controls[1].displayType, 'numeric_range');
	assert.equal(r.controls[1].operator, 'BETWEEN');
	assert.deepEqual(r.controls[1].values, ['1', '5']);
	assert.equal(r.controls[2].formulaId, 'calculation_big');
	assert.deepEqual(r.controls[2].values, []);
});

test('a categorical filter shown as a text input gets a match operator, or a list when it holds a selection', () => {
	const all = cat('Region', undefined, { all: true });
	const picked = cat('Is Big', ['true']);
	const typed = cat('Quantity', undefined, { all: true });
	const modes = new Map([[all.pillId, 'pattern'], [picked.pillId, 'pattern'], [typed.pillId, 'typein']]);
	const r = toQuickFilterControls([all, picked, typed], makeBindings(), ctx({ dataSourceId: 'ds', modes }));
	assert.deepEqual(r.controls.map((x) => [x.displayType, x.operator, x.values]), [
		['match_values_text_input', 'CONTAINS', []],
		['multiple_select', 'IN', ['true']],
		['multiple_select', 'IN', []]
	]);
});

test('a quick filter with more than 50 default values starts unfiltered', () => {
	const many = Array.from({ length: 51 }, (_, i) => `R${i}`);
	const r = toQuickFilterControls([cat('Region', many)], makeBindings(), ctx({ dataSourceId: 'ds' }));
	assert.deepEqual(r.controls[0].values, []);
	assert.equal(r.issues[0].code, 'filter.slicer-limit');
	assert.equal(r.issues[0].severity, 'warning');
	assert.equal(exceedsSlicerLimit(cat('Region', many)), true);
	assert.equal(exceedsSlicerLimit(cat('Region', many.slice(0, 50))), false);
	const fifty = toQuickFilterControls([cat('Region', many.slice(0, 50))], makeBindings(), ctx({ dataSourceId: 'ds' }));
	assert.equal(fifty.controls[0].values.length, 50);
	assert.deepEqual(fifty.issues, []);
});

test('helpers: parseTopBy, datePartFormula, filterDataType', () => {
	assert.deepEqual(parseTopBy('SUM([Sales])'), { agg: 'sum', fieldId: '[Sales]' });
	assert.deepEqual(parseTopBy('[Profit Ratio]'), { agg: 'user', fieldId: '[Profit Ratio]' });
	assert.equal(parseTopBy('SUM([A]) + 1'), null);
	assert.equal(datePartFormula('weekday', '`d`').sortFormula, 'MIN(DAYOFWEEK(`d`))');
	assert.equal(datePartFormula('quarter', '`d`').toValue(3), 'Q3');
	assert.equal(datePartFormula('week', '`d`').formula, 'FLOOR((DAYOFYEAR(`d`) + DAYOFWEEK(DATE_SUB(DATE(`d`), INTERVAL (DAYOFYEAR(`d`) - 1) DAY)) - 2) / 7) + 1');
	assert.equal(datePartFormula('trunc:month', '`d`').toValue('2023-04-01'), '2023-04');
	assert.equal(filterDataType({ dataType: 'DATETIME' }), 'datetime');
	assert.equal(filterDataType({ tableauType: 'real' }), 'numeric');
});

test('a number member range is a BETWEEN; excluded, a NOT_BETWEEN', () => {
	const fx = formulas();
	const r = toCardFilters([{ ...cat('Quantity', undefined), ranges: [{ from: 2, to: 5 }] }, { ...cat('Quantity', undefined), exclude: [], ranges: [{ from: 7, to: 9 }] }], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters, [
		{ column: 'Quantity', operand: 'BETWEEN', values: ['2', '5'], dataType: 'numeric', filterType: 'COLUMN_ID' },
		{ column: 'Quantity', operand: 'NOT_BETWEEN', values: ['7', '9'], dataType: 'numeric', filterType: 'COLUMN_ID' }
	]);
	assert.deepEqual(fx.list, []);
	assert.deepEqual(r.issues.map((i) => [i.severity, i.code]), [['info', 'filter.member-range'], ['info', 'filter.member-range']]);
});

test('a text member range compares lower-cased text in a card beast mode, as Tableau ignores case', () => {
	const fx = formulas();
	const r = toCardFilters([{ ...cat('Region', undefined), ranges: [{ from: '*N/A', to: 'Plan-SMB-Windows' }] }, { ...cat('Segment', undefined), exclude: [], ranges: [{ from: 'A', to: 'C' }] }], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters, [
		{ column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' },
		{ column: 'calculation_card_2', operand: 'IN', values: ['false'], dataType: 'string' }
	]);
	assert.equal(fx.list[0].formula, "CASE WHEN LOWER(`Region`) BETWEEN '*n/a' AND 'plan-smb-windows' THEN 'true' ELSE 'false' END");
	assert.equal(fx.list[1].formula, "CASE WHEN LOWER(`Segment`) BETWEEN 'a' AND 'c' THEN 'true' ELSE 'false' END");
	assert.match(r.issues[0].message, /ignoring case/);
});

test('a text member range on a binary-collation field stays a BETWEEN', () => {
	const fx = formulas();
	const region = { ...makeBindings().get(DS, '[Region]'), caseSensitive: true };
	const r = toCardFilters([{ ...cat('Region', undefined), ranges: [{ from: '2024P1', to: '2024P7' }] }], makeBindings({ '[Region]': region }), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters, [{ column: 'Region', operand: 'BETWEEN', values: ['2024P1', '2024P7'], dataType: 'string', filterType: 'COLUMN_ID' }]);
	assert.deepEqual(fx.list, []);
	assert.deepEqual(r.issues.map((i) => [i.severity, i.code]), [['info', 'filter.member-range']]);
	assert.match(r.issues[0].message, /also keeps P10/);
});

test('a text member range without card formulas keeps the BETWEEN and warns', () => {
	const r = toCardFilters([{ ...cat('Region', undefined), ranges: [{ from: 'Central', to: 'East' }] }], makeBindings(), ctx());
	assert.deepEqual(r.filters, [{ column: 'Region', operand: 'BETWEEN', values: ['Central', 'East'], dataType: 'string', filterType: 'COLUMN_ID' }]);
	assert.deepEqual(r.issues.map((i) => [i.severity, i.code]), [['warning', 'filter.member-range']]);
	assert.equal(r.approximate, true);
});

test('member ranges mixed with members become a card beast mode predicate', () => {
	const fx = formulas();
	const r = toCardFilters([{ ...cat('Region', ['West', "O'Hare"]), ranges: [{ from: 'Central', to: 'East' }] }], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters, [{ column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' }]);
	assert.equal(fx.list[0].formula, "CASE WHEN `Region` IN ('West', 'O''Hare') OR LOWER(`Region`) BETWEEN 'central' AND 'east' THEN 'true' ELSE 'false' END");
});

test('member ranges on a date part, or without card formulas, are skipped with filter.member-range', () => {
	const r = toCardFilters([{ ...cat('Region', ['West']), ranges: [{ from: 'A', to: 'C' }] }, { pillId: p('yr', 'Order Date', 'ok'), datasourceId: DS, fieldId: '[Order Date]', kind: 'categorical', ranges: [{ from: 2020, to: 2022 }] }], makeBindings(), ctx());
	assert.deepEqual(r.filters, []);
	assert.deepEqual(r.issues.filter((i) => i.severity === 'warning').map((i) => i.code), ['filter.member-range', 'filter.member-range']);
	assert.equal(r.approximate, true);
});

test('a quick filter with member ranges starts unfiltered and its selection stays on the card', () => {
	const f = { ...cat('Region', ['West']), ranges: [{ from: 'Central', to: 'East' }] };
	const fx = formulas();
	const r = toCardFilters([f], makeBindings(), ctx({ addFormula: fx.addFormula, skipPillIds: new Set([f.pillId]) }));
	assert.equal(r.filters.length, 1);
	const q = toQuickFilterControls([f], makeBindings(), ctx({ dataSourceId: 'ref' }));
	assert.deepEqual(q.controls[0].values, []);
	assert.equal(q.issues[0].code, 'filter.member-range');
});

test('member lists too long for the card subscription become card beast mode predicates, longest first', () => {
	const fx = formulas();
	const many = (n) => Array.from({ length: n }, (_, i) => `Account ${i}`);
	const filters = [cat('Segment', many(3500)), cat('Region', many(4000)), cat('Customer', ['Ann'])];
	const r = toCardFilters(filters, makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters[0], { column: 'calculation_card_2', operand: 'IN', values: ['true'], dataType: 'string' });
	assert.deepEqual(r.filters[1], { column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' });
	assert.deepEqual(r.filters[2], { column: 'Customer', operand: 'IN', values: ['Ann'], dataType: 'string', filterType: 'COLUMN_ID' });
	assert.ok(fx.list[0].formula.startsWith("CASE WHEN `Region` IN ('Account 0', 'Account 1', "));
	assert.ok(fx.list[1].formula.endsWith("'Account 3499') THEN 'true' ELSE 'false' END"));
	assert.deepEqual(r.issues.map((i) => i.code), ['filter.member-list', 'filter.member-list']);
	assert.equal(r.memberLists, undefined);
});

test('a member list that fits stays a plain IN filter', () => {
	const fx = formulas();
	const r = toCardFilters([cat('Region', Array.from({ length: 2000 }, (_, i) => `Account ${i}`))], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.equal(r.filters[0].operand, 'IN');
	assert.equal(r.filters[0].values.length, 2000);
	assert.equal(fx.list.length, 0);
});

test('quick filters past the 20 slicers a card holds stay fixed card filters', () => {
	const fields = Array.from({ length: 22 }, (_, i) => `F${i}`);
	const bindings = { get: (ds, id) => ({ datasetKey: DATASET, kind: 'column', name: id.slice(1, -1), column: id.slice(1, -1), aggregated: false, dataType: 'STRING', tableauType: 'string' }) };
	const filters = fields.map((f) => cat(f, ['a']));
	const q = toQuickFilterControls(filters, bindings, ctx({ dataSourceId: 'ref' }));
	assert.equal(q.controls.length, 20);
	assert.deepEqual(q.issues.map((i) => i.code), ['filter.slicer-count', 'filter.slicer-count']);
	assert.equal(q.pillIds.size, 20);
	const r = toCardFilters(filters, bindings, ctx({ skipPillIds: q.pillIds }));
	assert.deepEqual(r.filters.map((f) => f.column), ['F20', 'F21']);
});

test('memberCondition: an exclude keeps nulls unless null is listed; numbers stay unquoted', () => {
	const b = makeBindings();
	assert.equal(memberCondition(b.get(DS, '[Region]'), ['East', "O'Hare"], { exclude: true }), "(`Region` IS NULL OR `Region` NOT IN ('East', 'O''Hare'))");
	assert.equal(memberCondition(b.get(DS, '[Region]'), ['East', null], { exclude: true }), "`Region` IS NOT NULL AND `Region` NOT IN ('East')");
	assert.equal(memberCondition(b.get(DS, '[Quantity]'), [0]), '`Quantity` IN (0)');
	assert.equal(memberCondition(b.get(DS, '[Is Big]'), ['Y', null]), "(CASE WHEN `Sales` > 100 THEN 'Y' ELSE 'N' END) IN ('Y') OR (CASE WHEN `Sales` > 100 THEN 'Y' ELSE 'N' END) IS NULL");
	assert.equal(memberCondition(b.get(DS, '[Profit Ratio]'), [1]), undefined, 'an aggregate has no row condition');
});

test('an exclude list with Null drops the nulls through an empty value; other null shapes keep Tableau rows with a card formula', () => {
	const fx = formulas();
	const exclude = (name, list) => ({ ...cat(name, undefined), exclude: list });
	const r = toCardFilters([exclude('Region', [null]), exclude('Segment', [null, 'Consumer']), cat('Customer', [null, 'Ann']), exclude('City', ['Paris'])], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters, [
		{ column: 'Region', filterType: 'COLUMN_ID', operand: 'NOT_IN', values: [''], dataType: 'string' },
		{ column: 'Segment', filterType: 'COLUMN_ID', operand: 'NOT_IN', values: ['Consumer', ''], dataType: 'string' },
		{ column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' },
		{ column: 'calculation_card_2', operand: 'IN', values: ['true'], dataType: 'string' }
	]);
	assert.equal(fx.list[0].formula, "CASE WHEN `Customer` IN ('Ann') OR `Customer` IS NULL THEN 'true' ELSE 'false' END");
	assert.equal(fx.list[1].formula, "CASE WHEN (`City` IS NULL OR `City` NOT IN ('Paris')) THEN 'true' ELSE 'false' END");
	assert.deepEqual(r.issues.map((i) => i.code), ['filter.null', 'filter.null', 'filter.null', 'filter.null']);
	assert.match(r.issues[0].message, /empty text, which Tableau keeps/);
});

test('an exclude list with Null and members on a number field keeps its rows exact with a card formula', () => {
	const fx = formulas();
	const r = toCardFilters([{ ...cat('Quantity', undefined), exclude: [null, 3] }, { ...cat('Profit', undefined), exclude: [null] }], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.filters[0], { column: 'calculation_card_1', operand: 'IN', values: ['true'], dataType: 'string' });
	assert.equal(fx.list[0].formula, "CASE WHEN `Quantity` IS NOT NULL AND `Quantity` NOT IN (3) THEN 'true' ELSE 'false' END");
	assert.deepEqual(r.filters[1], { column: 'Profit', filterType: 'COLUMN_ID', operand: 'NOT_IN', values: [''], dataType: 'numeric' });
});

test('Top N by COUNTD ranks by a distinct count card formula; a text field is never ranked by SUM', () => {
	const fx = formulas();
	const top = (by) => ({ pillId: p('none', 'Customer'), datasourceId: DS, fieldId: '[Customer]', kind: 'top', top: { count: 16, direction: 'top', by } });
	const r = toCardFilters([top('COUNTD([Category])')], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.deepEqual(r.tops[0].orderBy, { column: 'calculation_card_1', formulaId: 'calculation_card_1', order: 'DESCENDING' });
	assert.deepEqual(fx.list[0], { id: 'calculation_card_1', name: 'Distinct count of Category', formula: 'COUNT(DISTINCT `Category`)', dataType: 'numeric', aggregated: true });
	assert.deepEqual(r.issues, []);
	const text = toCardFilters([top('SUM([Region])'), top('[Region]'), top('MAX([Region])')], makeBindings(), ctx({ addFormula: fx.addFormula }));
	assert.equal(text.tops.length, 1);
	assert.deepEqual(text.tops[0].orderBy, { column: 'Region', order: 'DESCENDING', aggregation: 'MAX' });
	assert.deepEqual(text.issues.map((i) => i.code), ['filter.top', 'filter.top']);
	const unknown = toCardFilters([top('KURTOSIS([Sales])')], makeBindings(), ctx());
	assert.deepEqual(unknown.tops[0].orderBy, { column: 'Sales', order: 'DESCENDING', aggregation: 'SUM' });
	assert.match(unknown.issues[0].message, /ranked by SUM instead/);
});

test('a Top N with a Magic ETL rank column is a rank filter, not a row limit', () => {
	const f = { pillId: p('none', 'Customer'), datasourceId: DS, fieldId: '[Customer]', kind: 'top', top: { count: 16, direction: 'top', by: 'COUNTD([Category])', rankColumn: 'Customer (Top 16 rank)' } };
	const r = toCardFilters([f], makeBindings(), ctx());
	assert.deepEqual(r.tops, []);
	assert.deepEqual(r.filters, [{ column: 'Customer (Top 16 rank)', filterType: 'COLUMN_ID', operand: 'LESS_THAN_EQUALS_TO', values: [16], dataType: 'numeric' }]);
	assert.deepEqual(r.issues.map((i) => i.code), ['filter.top-rank']);
});

test('aggregateFilterField: the dataset beast mode a filter card on an aggregate selects on', () => {
	const b = makeBindings();
	const q = (derivation, field, extra = {}) => ({ pillId: p(derivation, field, 'qk'), datasourceId: DS, fieldId: `[${field}]`, kind: 'quantitative', aggregated: true, ...extra });
	const pick = (r) => [r.name, r.expression, r.dataType, r.note];
	assert.deepEqual(pick(aggregateFilterField(q('sum', 'Sales'), b.get(DS, '[Sales]'))), ['SUM(Sales)', 'SUM(`Sales`)', 'DOUBLE', undefined]);
	assert.deepEqual(pick(aggregateFilterField(q('ctd', 'Customer'), b.get(DS, '[Customer]'))), ['COUNTD(Customer)', 'COUNT(DISTINCT `Customer`)', 'LONG', undefined]);
	assert.deepEqual(pick(aggregateFilterField(q('avg', 'Is Big'), b.get(DS, '[Is Big]'))).slice(0, 3), ['AVG(Is Big)', "AVG((CASE WHEN `Sales` > 100 THEN 'Y' ELSE 'N' END))", 'DOUBLE']);
	assert.equal(aggregateFilterField(q('none', 'Sales'), b.get(DS, '[Sales]')).note, 'its aggregation is unknown, so it uses SUM');
	assert.equal(aggregateFilterField(q('usr', 'Profit Ratio'), b.get(DS, '[Profit Ratio]')).binding.formulaId, 'calculation_pr');
	assert.equal(aggregateFilterField(q('sum', 'Sales'), { ...b.get(DS, '[Sales]'), kind: 'formula', formulaId: 'x', expression: 'SUM(`Sales`) OVER ()' }).problem, 'table-calc');
	assert.equal(isAggregateControl({ ...cat('Region', ['East']), aggregated: true, pillId: p('attr', 'Region') }, b.get(DS, '[Region]')), false, 'ATTR of a dimension is the dimension');
	assert.equal(isAggregateControl(q('sum', 'Sales'), b.get(DS, '[Sales]')), true);
});
