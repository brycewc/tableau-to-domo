import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodTopFilters } from '../../src/convert/period-top.js';

const DS = 'Waterfall';
const fields = [
	{ id: '[FY]', name: 'FY', datatype: 'string', role: 'dimension', kind: 'column' },
	{ id: '[FQ]', name: 'FQ', datatype: 'string', role: 'dimension', kind: 'column' },
	{ id: '[Calculation_1]', name: 'FY-FQ', caption: 'FY-FQ', datatype: 'string', role: 'dimension', kind: 'calculated', formula: 'str([FY]) + "-" + str([FQ])' },
	{ id: '[Order Date]', name: 'Order Date', datatype: 'date', role: 'dimension', kind: 'column' }
];
const top = (by, count = 20) => ({ pillId: `[${DS}].[none:Calculation_1:nk]`, datasourceId: DS, fieldId: '[Calculation_1]', kind: 'top', shared: DS, top: { count, direction: 'top', by } });
const irWith = (filter, extraFields = [], pills = {}) => ({ datasources: [{ id: DS, caption: DS, fields: [...fields, ...extraFields] }], worksheets: [{ name: 'Dyn Main', datasourceIds: [DS], filters: [filter], pills }] });

test('a Top N on a year-quarter label ranked by an aggregate of itself keeps the N quarters before the current one', () => {
	const { ir, issues } = periodTopFilters(irWith(top('COUNTD([Calculation_1])')));
	const date = ir.datasources[0].fields.at(-1);
	assert.deepEqual([date.name, date.datatype, date.periodDate], ['FY-FQ Quarter Start', 'date', true]);
	assert.equal(date.formula, 'MAKEDATE(TRIM(REPLACE(UPPER(STR([FY])), "FY", "")), CASE TRIM(REPLACE(UPPER(STR([FQ])), "Q", "")) WHEN "1" THEN 1 WHEN "2" THEN 4 WHEN "3" THEN 7 WHEN "4" THEN 10 END, 1)');
	const [filter] = ir.worksheets[0].filters;
	assert.deepEqual([filter.kind, filter.fieldId, filter.relative, filter.top, filter.shared], ['relative-date', date.id, { periodType: 'quarter', first: -20, last: -1 }, undefined, DS]);
	assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['filter.period-top', 'info']]);
	assert.match(issues[0].message, /latest 20 quarters in the data and Domo counts back from today/);
});

test('Acme ARR: a Top 9 by COUNT of the label is the last 9 quarters, with a warning that Tableau ranks by row count', () => {
	const { ir, issues } = periodTopFilters(irWith(top('COUNT([Calculation_1])', 9)));
	assert.deepEqual(ir.worksheets[0].filters[0].relative, { periodType: 'quarter', first: -9, last: -1 });
	assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['filter.period-top', 'warning']]);
	for (const by of ['MAX([Calculation_1])', 'MIN([Calculation_1])', 'ATTR([Calculation_1])']) assert.equal(periodTopFilters(irWith(top(by))).ir.worksheets[0].filters[0].kind, 'relative-date', by);
});

test('a Top N within a hand-picked run of quarters keeps a rolling window as long as the list, and says Tableau\'s list is fixed', () => {
	const quarters = ['2022-1', '2022-2', '2022-3', '2022-4', '2023-1'];
	const listed = (by, count, members) => periodTopFilters(irWith({ ...top(by, count), top: { ...top(by, count).top, members } }));
	const { ir, issues } = listed('COUNTD([Calculation_1])', 20, quarters);
	assert.deepEqual(ir.worksheets[0].filters[0].relative, { periodType: 'quarter', first: -5, last: -1 });
	assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['filter.period-top', 'warning']]);
	assert.match(issues[0].message, /hand-picked list of 5 quarters \(2022-1 to 2023-1\) that only changes when someone edits it; Domo keeps the latest 5 instead/);
	const byCount = listed('COUNT([Calculation_1])', 9, ["24'Q4", "25'Q1", "24'Q3"]);
	assert.deepEqual(byCount.ir.worksheets[0].filters[0].relative, { periodType: 'quarter', first: -3, last: -1 }, 'an unordered list of short labels');
	assert.doesNotMatch(byCount.issues[0].message, /row count/, 'a list no longer than the count keeps every member, whatever the ranking');
	assert.deepEqual(listed('COUNTD([Calculation_1])', 2, quarters).ir.worksheets[0].filters[0].relative, { periodType: 'quarter', first: -2, last: -1 });
	const gap = listed('COUNTD([Calculation_1])', 20, ['2022-1', '2022-3']);
	assert.deepEqual(gap.ir.worksheets[0].filters[0].relative, { periodType: 'quarter', first: -20, last: -1 });
	assert.match(gap.issues[0].message, /not consecutive/);
});

test('a Top N that is no date window ranks within its hand-picked list as an include filter', () => {
	const sales = { id: '[Customer]', name: 'Customer', datatype: 'string', role: 'dimension', kind: 'column' };
	const ranked = (count) => ({ pillId: `[${DS}].[none:Customer:nk]`, datasourceId: DS, fieldId: '[Customer]', kind: 'top', top: { count, direction: 'top', by: 'SUM([Sales])', members: ['A', 'B', 'C'] } });
	const [all] = periodTopFilters(irWith(ranked(5), [sales])).ir.worksheets[0].filters;
	assert.deepEqual([all.kind, all.include, all.top], ['categorical', ['A', 'B', 'C'], undefined], 'a top 5 of 3 members keeps them all');
	const [two, list] = periodTopFilters(irWith(ranked(2), [sales])).ir.worksheets[0].filters;
	assert.deepEqual([two.kind, two.top, list.kind, list.include], ['top', { count: 2, direction: 'top', by: 'SUM([Sales])' }, 'categorical', ['A', 'B', 'C']]);
});

test('a Top N on a truncated date by an aggregate of itself is a relative filter in the pill period', () => {
	const filter = { pillId: `[${DS}].[tmn:Order Date:ok]`, datasourceId: DS, fieldId: '[Order Date]', kind: 'top', top: { count: 6, direction: 'top', by: 'MAX([Order Date])' } };
	const { ir } = periodTopFilters(irWith(filter));
	assert.deepEqual([ir.worksheets[0].filters[0].fieldId, ir.worksheets[0].filters[0].relative], ['[Order Date]', { periodType: 'month', first: -6, last: -1 }]);
	assert.equal(ir.datasources[0].fields.length, fields.length, 'no date calc for a date column');
	const part = { ...filter, pillId: `[${DS}].[qr:Order Date:ok]` };
	assert.equal(periodTopFilters(irWith(part)).ir.worksheets[0].filters[0].kind, 'top', 'a quarter-of-year part is not a window');
});

test('a Top N that really ranks, or one on another label, is left as it is', () => {
	for (const filter of [top('SUM([Sales])'), top('COUNT([FY])'), { ...top('COUNTD([Calculation_1])'), top: { count: 20, direction: 'bottom', by: 'COUNTD([Calculation_1])' } }]) {
		const source = irWith(filter);
		assert.equal(periodTopFilters(source).ir, source);
	}
	const source = irWith(top('COUNTD([Calculation_1])'));
	source.datasources[0].fields = [...fields.slice(0, 2), { ...fields[2], formula: 'str([FY]) + "-" + str([Region])' }, { id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' }];
	assert.equal(periodTopFilters(source).ir, source);
});

const calc = (formula) => ({ id: '[Recent]', name: 'Recent', datatype: 'boolean', role: 'dimension', kind: 'calculated', formula });
const keepTrue = { pillId: `[${DS}].[none:Recent:nk]`, datasourceId: DS, fieldId: '[Recent]', kind: 'categorical', include: [true] };
const windowOf = (formula, filter = keepTrue, pills) => {
	const { ir, issues } = periodTopFilters(irWith(filter, [calc(formula)], pills));
	const [f] = ir.worksheets[0].filters;
	return { filter: f, issues, relative: f.kind === 'relative-date' ? f.relative : undefined };
};

test('a boolean calc that keeps a DATEDIFF window against today is a relative date filter on the date', () => {
	const r = windowOf('DATEDIFF("quarter", [Order Date], TODAY()) < 9');
	assert.deepEqual([r.filter.fieldId, r.filter.include, r.relative], ['[Order Date]', undefined, { periodType: 'quarter', first: -8, last: 0 }]);
	assert.deepEqual(r.issues.map((i) => [i.code, i.severity]), [['filter.date-window', 'info']]);
	assert.deepEqual(windowOf('DATEDIFF(\'month\', [Order Date], NOW()) <= 3').relative, { periodType: 'month', first: -3, last: 0 });
	assert.deepEqual(windowOf('DATEDIFF("year", [Order Date], TODAY()) = 1').relative, { periodType: 'year', first: -1, last: -1 });
	assert.deepEqual(windowOf('DATEDIFF("month", [Order Date], TODAY()) >= 1 AND DATEDIFF("month", [Order Date], TODAY()) <= 12').relative, { periodType: 'month', first: -12, last: -1 });
	assert.deepEqual(windowOf('12 > DATEDIFF("month", [Order Date], TODAY())').relative, { periodType: 'month', first: -11, last: 0 });
	assert.deepEqual(windowOf('DATEDIFF("day", TODAY(), [Order Date]) > -30').relative, { periodType: 'day', first: -29, last: 0 });
	assert.deepEqual(windowOf('DATEDIFF("quarter", [Order Date], TODAY()) < 9', { ...keepTrue, include: undefined, exclude: [false] }).relative, { periodType: 'quarter', first: -8, last: 0 });
});

test('a window against the latest date in the data ends at the previous period, with a warning', () => {
	const r = windowOf('DATEDIFF("quarter", [Order Date], {MAX([Order Date])}) < 9');
	assert.deepEqual(r.relative, { periodType: 'quarter', first: -9, last: -1 });
	assert.deepEqual(r.issues.map((i) => [i.code, i.severity]), [['filter.date-window', 'warning']]);
	assert.match(r.issues[0].message, /latest 9 quarters in the data/);
	assert.deepEqual(windowOf('DATEDIFF("month", [Order Date], {FIXED : MAX([Order Date])}) <= 5').relative, { periodType: 'month', first: -6, last: -1 });
	assert.deepEqual(windowOf('DATEDIFF("month", [Order Date], WINDOW_MAX(MAX([Order Date]))) < 6').relative, { periodType: 'month', first: -6, last: -1 });
	const ranked = windowOf('RANK_DENSE(MAX([Order Date])) <= 4', keepTrue, { [`[${DS}].[tqr:Order Date:ok]`]: { id: `[${DS}].[tqr:Order Date:ok]`, datasourceId: DS, fieldId: '[Order Date]' } });
	assert.deepEqual(ranked.relative, { periodType: 'quarter', first: -4, last: -1 });
});

test('a DATEADD lower bound keeps whole periods, with a warning unless it counts days', () => {
	const months = windowOf('[Order Date] >= DATEADD("month", -6, TODAY())');
	assert.deepEqual(months.relative, { periodType: 'month', first: -6, last: 0 });
	assert.equal(months.issues[0].severity, 'warning');
	const days = windowOf('[Order Date] > DATEADD("day", -30, TODAY())');
	assert.deepEqual([days.relative, days.issues[0].severity], [{ periodType: 'day', first: -29, last: 0 }, 'info']);
});

test('calcs that are not only a date window, or a filter a dashboard shows, stay as they are', () => {
	for (const formula of ['DATEDIFF("quarter", [Order Date], TODAY()) > 9', 'DATEDIFF("quarter", [Order Date], TODAY()) < 9 AND [FY] = "2024"', 'DATEDIFF("quarter", [FY], TODAY()) < 9', 'RANK(MAX([Order Date]), "asc") <= 4', 'DATEDIFF("quarter", [Order Date], [Order Date]) < 9']) {
		assert.equal(windowOf(formula).relative, undefined, formula);
	}
	assert.equal(windowOf('RANK(MAX([Order Date])) <= 4').relative, undefined, 'a rank without the date on the sheet has no period');
	assert.equal(windowOf('DATEDIFF("quarter", [Order Date], TODAY()) < 9', { ...keepTrue, shownOnDashboard: true }).relative, undefined);
	assert.equal(windowOf('DATEDIFF("quarter", [Order Date], TODAY()) < 9', { ...keepTrue, include: [false] }).relative, undefined);
});
