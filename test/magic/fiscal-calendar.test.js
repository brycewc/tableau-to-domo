import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fiscalCalendarDataflow, fiscalCalendarSql, sourceCalendarSql } from '../../src/magic/fiscal-calendar.js';

const REQUIRED = ['DOMO_Key', 'Date', 'DayOfWeek', 'DayNumberInWeek', 'DayNumberInMonth', 'DayNumberInQuarter', 'DayNumberInYear', 'WeekNumberInYear', 'MonthName', 'MonthAbrv', 'MonthNumberInYear', 'Quarter', 'Year', 'CalendarMonth', 'CalendarQuarter', 'WeekStart', 'QuarterStart', 'DaySinceEpoch', 'WeekSinceEpoch', 'MonthSinceEpoch', 'QuarterSinceEpoch', 'YearSinceEpoch', 'MonthStart', 'YearStart', 'QuarterOfYear'];

test('the calendar SQL selects the 25 columns Domo requires of a Cloud Amplifier calendar, in order', () => {
	const sql = fiscalCalendarSql(12);
	const outer = sql.slice(0, sql.indexOf(' FROM ('));
	assert.deepEqual([...outer.matchAll(/ AS "([A-Za-z_]+)"(?=, |$)/g)].map((m) => m[1]), REQUIRED);
	assert.match(sql, /GENERATOR\(ROWCOUNT => 31046\)/, '1990-01-01 through 2074-12-31');
});

test('a December year is named by the year it ends; a January year by its own', () => {
	const dec = fiscalCalendarSql(12);
	assert.match(dec, /YEAR\("D"\) \+ IFF\(MONTH\("D"\) >= 12, 1, 0\) AS "FY"/);
	assert.match(dec, /DATE_FROM_PARTS\("FY" - 1, 12, 1\) AS "YS"/);
	assert.match(dec, /\("FY" - 1970\) \* 4 \+ "FQ" - 1/);
	const jan = fiscalCalendarSql(1);
	assert.match(jan, /IFF\(MONTH\("D"\) >= 1, 0, 0\)/);
	assert.match(jan, /DATE_FROM_PARTS\("FY" - 0, 1, 1\)/);
	assert.match(jan, /"FY" - 1969 AS INTEGER\) AS "YearSinceEpoch"/);
	assert.throws(() => fiscalCalendarSql(13), /not 1-12/);
});

test('the calendar dataflow runs on the warehouse in the graph editor format and publishes there', () => {
	const df = fiscalCalendarDataflow({ integrationId: 'int-1', integrationName: 'Acme', startMonth: 12 });
	assert.equal(df.databaseType, 'ADR');
	assert.equal(df.computeCloud, 'int-1');
	assert.equal(df.gui.useGraphUI, true);
	assert.deepEqual(df.gui.canvases.default.elements.map((e) => e.id), df.actions.map((a) => a.id));
	const [sql, out] = df.actions;
	assert.deepEqual([sql.type, sql.settings.sqlDialect, sql.inputs], ['SQL', 'SNOWFLAKE', []]);
	assert.deepEqual(out.dependsOn, [sql.id]);
	assert.equal(out.dataSource.cloudId, 'int-1');
	assert.equal(out.dataSource.name, 't2d Fiscal Calendar (December start)');
});

test('a mapped calendar table keeps its own fiscal years, quarters and periods', () => {
	const sql = sourceCalendarSql({ table: 'DB.SCH.DIM_CALENDAR', startMonth: 12, columns: { date: 'CALENDAR_DATE', fiscalYear: 'FISCAL_YEAR_NUM', fiscalQuarter: 'FISCAL_QUARTER_NUM', fiscalPeriod: 'FISCAL_PERIOD_NUM' } });
	assert.match(sql, /CAST\("FISCAL_YEAR_NUM" AS INTEGER\) AS "FY"/);
	assert.match(sql, /MIN\("D"\) OVER \(PARTITION BY "FY"\) AS "YS"/);
	for (const name of ['DOMO_Key', 'Year', 'QuarterStart', 'WeekStart', 'QuarterOfYear']) assert.match(sql, new RegExp(`AS "${name}"`));
	assert.throws(() => sourceCalendarSql({ table: 'T', columns: {} }), /needs table and columns/);
});
