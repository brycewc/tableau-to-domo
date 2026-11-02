import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { fiscalMonth } from '../../src/tableau/twb/datasources.js';
import { datePartFormula, fiscalYearRange, toCardFilters } from '../../src/convert/filters.js';
import { fiscalCalendarFor, planCards } from '../../src/convert/cards.js';
import { calendarConflicts, calendarNeeds, calendarSource, planCalendarConflicts } from '../../src/convert/fiscal.js';
import { outdatedIrIssues } from '../../src/convert/index.js';
import { IR_VERSION } from '../../src/model/types.js';
import { DS, DATASET, p, sheet, workbook, makeBindings, FIELDS } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const DATE_TYPES = { date: 'DATE', datetime: 'DATETIME' };
const fiscalBinding = (name, start) => {
	const field = FIELDS.find((f) => f.name === name);
	return { datasetKey: DATASET, kind: 'column', name, column: name, aggregated: false, dataType: DATE_TYPES[field.datatype], tableauType: field.datatype, fiscalYearStart: start };
};

function one(spec, bindings = makeBindings({ '[Order Date]': fiscalBinding('Order Date', 12) })) {
	const { cards, issues } = planCards(workbook({ worksheets: [sheet(spec)] }), bindings, { options: {} });
	return { card: cards[0], issues, main: cards[0]?.body.definition.subscriptions.main, def: cards[0]?.body.definition };
}

function twb(datasource) {
	return `<?xml version='1.0' encoding='utf-8' ?>
<workbook version='18.1'><datasources>${datasource}</datasources><worksheets /></workbook>`;
}

test('fiscalMonth reads month names and column numbers; 0 inherits', () => {
	assert.equal(fiscalMonth('december'), 12);
	assert.equal(fiscalMonth('January'), 1);
	assert.equal(fiscalMonth('12'), 12);
	assert.equal(fiscalMonth('6'), 6);
	assert.equal(fiscalMonth('0'), undefined);
	assert.equal(fiscalMonth(undefined), undefined);
	assert.equal(fiscalMonth('13'), undefined);
});

test('extract records the fiscal year start on the datasource and each date field', () => {
	const ir = buildWorkbookIR(
		twb(`<datasource caption='SalesReview' inline='true' name='federated.d' version='18.1'>
		<column datatype='date' fiscal-year-start='0' name='[bookings_Date]' role='dimension' type='ordinal' />
		<column datatype='datetime' fiscal-year-start='6' name='[Close Date]' role='dimension' type='ordinal' />
		<column datatype='date' name='[Today]' role='dimension' type='ordinal'><calculation class='tableau' formula='TODAY()' /></column>
		<column datatype='string' fiscal-year-start='12' name='[FYQ]' role='dimension' type='nominal' />
		<overridable-settings><date-options fiscal-year-start='december' start-of-week='sunday' /></overridable-settings>
	</datasource>
	<datasource caption='Old' inline='true' name='federated.o' version='18.1'>
		<column datatype='date' name='[Order Date]' role='dimension' type='ordinal' />
		<date-options fiscal-year-start='april' />
	</datasource>
	<datasource caption='ARR' inline='true' name='federated.a' version='18.1'>
		<column datatype='date' name='[Order Date]' role='dimension' type='ordinal' />
		<column datatype='date' fiscal-year-start='12' name='[Invoice Date]' role='dimension' type='ordinal' />
	</datasource>`)
	);
	assert.equal(ir.irVersion, IR_VERSION);
	const [review, old, arr] = ir.datasources;
	const start = (ds, id) => ds.fields.find((f) => f.id === id)?.fiscalYearStart;
	assert.equal(review.fiscalYearStart, 12);
	assert.equal(start(review, '[bookings_Date]'), 12, "'0' inherits the datasource setting");
	assert.equal(start(review, '[Close Date]'), 6);
	assert.equal(start(review, '[Today]'), 12, 'a date calc inherits it too');
	assert.equal(start(review, '[FYQ]'), undefined, 'only date fields carry it');
	assert.equal(old.fiscalYearStart, 4, 'an older workbook keeps date-options directly under the datasource');
	assert.equal(arr.fiscalYearStart, 1, 'January when unset');
	assert.equal(start(arr, '[Order Date]'), 1);
	assert.equal(start(arr, '[Invoice Date]'), 12, 'a column can override a January datasource');
});

test('fiscal date parts shift by 13 - start months, named by the year they end', () => {
	const year = datePartFormula('year', '`d`', 12);
	assert.equal(year.formula, 'YEAR(DATE_ADD(`d`, INTERVAL 1 MONTH))');
	assert.equal(year.toValue(2026), '2026', 'Tableau members of a fiscal year pill are already fiscal years');
	assert.equal(datePartFormula('quarter', '`d`', 4).formula, "CONCAT('Q', QUARTER(DATE_ADD(`d`, INTERVAL 9 MONTH)))");
	const month = datePartFormula('month', '`d`', 12);
	assert.equal(month.formula, 'MONTHNAME(`d`)', 'month names stay calendar months');
	assert.equal(month.sortFormula, 'MIN(MONTH(DATE_ADD(`d`, INTERVAL 1 MONTH)))', 'December sorts first');
	const quarter = datePartFormula('trunc:quarter', '`d`', 12);
	assert.equal(quarter.formula, "CONCAT(YEAR(DATE_ADD(`d`, INTERVAL 1 MONTH)), '-Q', QUARTER(DATE_ADD(`d`, INTERVAL 1 MONTH)))");
	assert.equal(quarter.toValue('2025-12-01'), '2026-Q1');
	assert.equal(quarter.toValue('2025-09-01'), '2025-Q4');
	assert.equal(datePartFormula('trunc:year', '`d`', 12).toValue('2025-12-01 00:00:00'), '2026');
	assert.equal(datePartFormula('trunc:year', '`d`', 7).toValue('2025-07-01'), '2026');
	assert.match(datePartFormula('week', '`d`', 12).formula, /DATEDIFF\(DATE\(`d`\), DATE_SUB\(.*INTERVAL 1 MONTH\)\)/);
	assert.equal(datePartFormula('trunc:month', '`d`', 12).formula, "DATE_FORMAT(`d`, '%Y-%m')", 'months and days do not depend on the fiscal year');
	assert.equal(datePartFormula('year', '`d`', 1).formula, 'YEAR(`d`)', 'January is the calendar year');
});

test('fiscalYearRange: FY2025-FY2026 starting in December runs 2024-12-01 to 2026-11-30', () => {
	assert.deepEqual(fiscalYearRange(2025, 2026, 12), ['2024-12-01', '2026-11-30']);
	assert.deepEqual(fiscalYearRange(2026, 2026, 3), ['2025-03-01', '2026-02-28']);
	assert.deepEqual(fiscalYearRange(2025, 2025), ['2025-01-01', '2025-12-31']);
});

test('a fiscal year filter keeps whole fiscal years', () => {
	const bindings = makeBindings({ '[Order Date]': fiscalBinding('Order Date', 12) });
	const out = toCardFilters([{ pillId: p('yr', 'Order Date', 'ok'), datasourceId: DS, fieldId: '[Order Date]', kind: 'categorical', include: [2025, 2026] }], bindings, { datasourceId: DS });
	assert.deepEqual(out.filters[0].values, ['2024-12-01', '2026-11-30']);
});

test('a fiscal calendar grain sets fiscal on every subscription and records the calendar', () => {
	const { card, main } = one({ cols: p('yr', 'Order Date', 'ok'), rows: SALES, mark: 'Bar' });
	assert.deepEqual(main.dateGrain, { column: 'Order Date', dateTimeElement: 'YEAR' });
	assert.equal(main.fiscal, true);
	assert.equal(card.bigNumber.fiscal, true);
	assert.deepEqual(card.fiscalCalendar, { startMonth: 12, labelByEndYear: true });
});

test('a relative date filter on a fiscal field makes the card fiscal; a day grain or plain date does not', () => {
	const relative = { pillId: p('none', 'Order Date', 'qk'), datasourceId: DS, fieldId: '[Order Date]', kind: 'relative-date', relative: { periodType: 'quarter', first: -1, last: 0 } };
	assert.equal(one({ cols: p('none', 'Region'), rows: SALES, mark: 'Bar', filters: [relative] }).main.fiscal, true);
	const daily = { ...relative, relative: { periodType: 'day', first: -7, last: 0 } };
	assert.equal(one({ cols: p('none', 'Region'), rows: SALES, mark: 'Bar', filters: [daily] }).main.fiscal, false);
	const plain = one({ cols: p('tdy', 'Order Date', 'qk'), rows: SALES });
	assert.equal(plain.main.fiscal, false);
	assert.equal(plain.card.fiscalCalendar, undefined);
});

test('a fiscal date part in a card beast mode carries the offset and needs no fiscal flag', () => {
	const { def, main, card } = one({ cols: p('qr', 'Order Date', 'ok'), rows: SALES, mark: 'Bar' });
	assert.equal(def.formulas.card.find((f) => f.name === 'Order Date (Quarter)').formula, "CONCAT('Q', QUARTER(DATE_ADD(`Order Date`, INTERVAL 1 MONTH)))");
	assert.equal(main.fiscal, false);
	assert.equal(card.fiscalCalendar, undefined);
});

test('a card mixing fiscal and calendar dates is fiscal with an issue', () => {
	const relative = { pillId: p('none', 'Ship Date', 'qk'), datasourceId: DS, fieldId: '[Ship Date]', kind: 'relative-date', relative: { periodType: 'year', first: 0, last: 0 } };
	const { main, issues } = one({ cols: p('yr', 'Order Date', 'ok'), rows: SALES, mark: 'Bar', filters: [relative] });
	assert.equal(main.fiscal, true);
	const mixed = issues.find((i) => i.code === 'card.fiscal-mixed');
	assert.match(mixed.message, /Order Date use a fiscal year starting in December.*Ship Date \(calendar year\)/);
	assert.deepEqual(fiscalCalendarFor([{ name: 'a', startMonth: 1 }]), {});
});

test('calendarSource: stored datasets use the instance calendar, Cloud Amplifier ones their integration', () => {
	const datasets = [
		{ key: 'ca', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'int-1' } },
		{ key: 'sqlview', strategy: 'view', view: { cloudId: 'int-2' } },
		{ key: 'fusion', strategy: 'view', view: { inputs: [{ $ref: 'dataset:ca' }] } },
		{ key: 'etl', strategy: 'dataflow-output', sourceStrategy: 'view' },
		{ key: 'csv', strategy: 'upload' }
	];
	assert.deepEqual(calendarSource('ca', datasets), { integrationId: 'int-1' });
	assert.deepEqual(calendarSource('sqlview', datasets), { integrationId: 'int-2' });
	assert.deepEqual(calendarSource('fusion', datasets), { integrationId: 'int-1' });
	assert.equal(calendarSource('etl', datasets), 'instance', 'a Magic ETL output is stored in Domo');
	assert.equal(calendarSource('csv', datasets), 'instance');
});

test('one calendar per target: the start most cards need wins, a tie flags both', () => {
	const card = (key) => ({ key, title: key, datasetKey: 'd', status: 'ok' });
	const fiscal = (startMonth, source = 'instance') => ({ startMonth, labelByEndYear: true, source });
	const plan = {
		cards: [
			{ ...card('a'), fiscalCalendar: fiscal(12) },
			{ ...card('b'), fiscalCalendar: fiscal(12) },
			{ ...card('c'), fiscalCalendar: fiscal(7) },
			{ ...card('d'), fiscalCalendar: fiscal(7, { integrationId: 'x' }) },
			card('e')
		]
	};
	assert.equal(calendarNeeds(plan).length, 3);
	const issues = planCalendarConflicts(plan);
	assert.deepEqual(issues.map((i) => i.object.id), ['c']);
	assert.equal(issues[0].code, 'convert.fiscal-conflict');
	const tie = calendarConflicts([
		{ target: 'instance', startMonth: 12, cards: [{ key: 'a' }] },
		{ target: 'instance', startMonth: 7, cards: [{ key: 'b' }] }
	]);
	assert.equal(tie.length, 2);
});

test('an IR from before version 17 gets the fiscal notice and converts as before', () => {
	const ir = workbook({ worksheets: [] });
	ir.irVersion = 16;
	ir.datasources[0].fields = FIELDS;
	const [notice] = outdatedIrIssues(ir, 'app');
	assert.equal(notice.code, 'convert.ir-outdated');
	assert.match(notice.message, /did not read fiscal year starts/);
	assert.deepEqual(outdatedIrIssues({ ...ir, irVersion: IR_VERSION }, 'app'), []);
});
