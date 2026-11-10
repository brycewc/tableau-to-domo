import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkFiscalCalendars, matchesInstanceCalendar, probeDates, provisionFiscalCalendars, workspaceCalendarConflicts } from '../../src/pipeline/fiscal-calendars.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { samplePlan, tempDir, testConfig } from './helpers.js';

const NOW = new Date('2026-10-31T00:00:00Z');
const PLAIN = { '2025-12-01': ['2025-12-01', 2025, 'Q4', 4, '2025-01-01'], '2026-03-01': ['2026-03-01', 2026, 'Q1', 1, '2026-01-01'], '2025-11-30': ['2025-11-30', 2025, 'Q4', 4, '2025-01-01'] };
const DECEMBER = { '2025-12-01': ['2025-12-01', 2026, 'Q1', 1, '2025-12-01'], '2026-03-01': ['2026-03-01', 2026, 'Q2', 2, '2025-12-01'], '2025-11-30': ['2025-11-30', 2025, 'Q4', 4, '2024-12-01'] };

/** Read-only fake: answers the calendar reads and fails any other call. */
function fakeClient({ table = '', calendar = PLAIN, integration = {} } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(`GET ${path}`);
			if (path === '/content/v1/customer-states/domo.calendar.tablename') return { name: 'domo.calendar.tablename', value: table };
			const id = /^\/query\/v1\/byos\/accounts\/(.+)$/.exec(path)?.[1];
			if (id) return { id, friendlyName: 'Acme', properties: integration };
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			calls.push(`POST ${path}`);
			if (path !== '/query/v1/execute/StandardCalendar') throw new Error(`unexpected POST ${path}`);
			const dates = [...body.sql.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
			return { columns: ['Date', 'Year', 'Quarter', 'QuarterOfYear', 'YearStart'], rows: dates.map((d) => calendar[d]).filter(Boolean) };
		}
	};
}

const need = (target, startMonth = 12) => ({
	target,
	startMonth,
	source: target === 'instance' ? 'instance' : { integrationId: target.slice(12) },
	cards: [
		{ key: 'a', title: 'Bookings by FY' },
		{ key: 'b', title: 'Bookings by FQ' }
	]
});

test('probe dates: the fiscal year start, the second quarter start and the day before', () => {
	assert.deepEqual(probeDates(12, 2025), { start: '2025-12-01', secondQuarter: '2026-03-01', dayBefore: '2025-11-30' });
	assert.deepEqual(probeDates(1, 2025), { start: '2025-01-01', secondQuarter: '2025-04-01', dayBefore: '2024-12-31' });
});

test('the instance calendar matches a December fiscal year named by its end year', () => {
	const rows = (cal) => new Map(Object.entries(cal).map(([d, r]) => [d, { Date: r[0], Year: r[1], Quarter: r[2], QuarterOfYear: r[3], YearStart: r[4] }]));
	assert.equal(matchesInstanceCalendar(rows(DECEMBER), 12, 2025).ok, true);
	const plain = matchesInstanceCalendar(rows(PLAIN), 12, 2025);
	assert.equal(plain.ok, false);
	assert.equal(plain.seen, '2025-12-01 is in year 2025, quarter 4, of a year starting 2025-01-01');
});

test('a missing instance calendar is a must-fix issue per card; a matching one is none', async () => {
	const c = fakeClient();
	const issues = await checkFiscalCalendars(c, [need('instance')], { instance: 'acme', now: NOW });
	assert.deepEqual(issues.map((i) => [i.code, i.object.name]), [
		['push.fiscal-calendar-missing', 'Bookings by FY'],
		['push.fiscal-calendar-missing', 'Bookings by FQ']
	]);
	assert.match(issues[0].message, /year starts in December, labelled by the year it ends .* on acme, but it has no custom fiscal calendar/);
	assert.match(issues[0].suggestion, /company settings/);
	assert.ok(c.calls.every((call) => !call.startsWith('POST') || call === 'POST /query/v1/execute/StandardCalendar'), 'only reads');
	assert.deepEqual(await checkFiscalCalendars(fakeClient({ table: 'fiscal_cal', calendar: DECEMBER }), [need('instance')], { now: NOW }), []);
	const wrong = await checkFiscalCalendars(fakeClient({ table: 'fiscal_cal' }), [need('instance')], { now: NOW });
	assert.equal(wrong[0].code, 'push.fiscal-calendar-wrong');
});

test('an integration without a registered fiscal calendar is must-fix; a registered one is not verified', async () => {
	const missing = await checkFiscalCalendars(fakeClient(), [need('integration:int-1')], { now: NOW });
	assert.equal(missing[0].code, 'push.fiscal-calendar-missing');
	assert.match(missing[0].message, /Cloud Amplifier integration "Acme" \(int-1\) live/);
	assert.match(missing[0].suggestion, /wrench > Set up calendar.*"Label fiscal year by end year" on/);
	const props = { fiscal_calendar_database: { value: 'DB' }, fiscal_calendar_schema: 'S', fiscal_calendar_name: 'DIM_CALENDAR' };
	const registered = await checkFiscalCalendars(fakeClient({ integration: props }), [need('integration:int-1')], { now: NOW });
	assert.equal(registered[0].code, 'push.fiscal-calendar-unverified');
	assert.match(registered[0].message, /DB\.S\.DIM_CALENDAR registered/);
});

const WRITEABLE = { writeable: true, database: 'DOMO_DB', defaultSchema: 'WRITEBACK_SCHEMA' };

/** A writeable integration: the calendar dataflow, its run and the registration are recorded. */
function provisioningClient({ raw = WRITEABLE, valid = true } = {}) {
	const calls = [];
	const registered = [];
	const tables = new Map();
	const c = {
		calls,
		registered,
		tables,
		get: async (path) => {
			calls.push(`GET ${path}`);
			const mapped = /\/datasets\/([^/]+)\/mapping$/.exec(path)?.[1];
			if (mapped) return { database: 'DOMO_DB', schemaName: 'WRITEBACK_SCHEMA', tableName: tables.get(mapped) ?? mapped.replace(/-/g, '_') };
			const id = /^\/query\/v1\/byos\/accounts\/([^/]+)$/.exec(path)?.[1];
			if (id) return { id, friendlyName: 'Acme', properties: {}, ...raw };
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			calls.push(`POST ${path}`);
			if (path.endsWith('/calendar/validate')) return valid ? { success: true, message: 'ok' } : { success: false, message: 'Missing required column' };
			if (path.endsWith('/calendar/register')) return registered.push(body), { success: true };
			throw new Error(`unexpected POST ${path}`);
		},
		put: async (path, body) => {
			calls.push(`PUT ${path}`);
			if (path.endsWith('/calendar/update')) return registered.push({ ...body, updated: true }), { success: true };
			const mapped = /\/datasets\/([^/]+)\/mapping$/.exec(path)?.[1];
			if (mapped) return tables.set(mapped, body.mapping.tableName), body.mapping;
			throw new Error(`unexpected PUT ${path}`);
		}
	};
	const dataflows = {
		created: [],
		createDataflow: async (_c, def) => (dataflows.created.push(def), { id: 77 }),
		updateDataflow: async () => ({}),
		runDataflow: async () => ({ id: 5 }),
		waitForExecution: async () => ({ state: 'SUCCESS' }),
		getDataflow: async () => ({ outputs: [{ dataSourceId: 'aaaa-bbbb' }] }),
		outputDatasetIds: (df) => df.outputs.map((o) => o.dataSourceId)
	};
	return { c, dataflows };
}

test('a writeable integration without a fiscal calendar gets one built and registered, which the check then accepts', async () => {
	const { c, dataflows } = provisioningClient();
	const state = { instance: 'acme', objects: {} };
	const issues = await provisionFiscalCalendars(c, [need('integration:int-1')], { state, dataflows });
	assert.deepEqual(issues.map((i) => i.code), ['push.fiscal-calendar-created']);
	assert.equal(dataflows.created[0].computeCloud, 'int-1');
	assert.deepEqual(dataflows.created[0].actions.find((x) => x.type === 'PublishToVault').dataSource.schemaMapping, { database: 'DOMO_DB', schemaName: 'WRITEBACK_SCHEMA', tableName: 'FISCAL_CALENDAR_DECEMBER_START' });
	const table = { database: 'DOMO_DB', schema: 'WRITEBACK_SCHEMA', table: 'FISCAL_CALENDAR_DECEMBER_START' };
	assert.deepEqual(c.registered, [{ ...table, calendarType: 'FISCAL' }]);
	assert.equal(c.tables.get('aaaa-bbbb'), 'FISCAL_CALENDAR_DECEMBER_START');
	assert.deepEqual(state.objects['fiscalcalendar:int-1'].extra, { startMonth: 12, datasetId: 'aaaa-bbbb', table });
	assert.equal(state.objects['fiscalcalendar:int-1'].extra.workbooks, undefined, 'no workbook stamp, so unpush keeps it');
	const props = { fiscal_calendar_database: 'DOMO_DB', fiscal_calendar_schema: 'WRITEBACK_SCHEMA', fiscal_calendar_name: 'FISCAL_CALENDAR_DECEMBER_START' };
	assert.deepEqual(await checkFiscalCalendars(fakeClient({ integration: props }), [need('integration:int-1')], { now: NOW, state }), []);
	const otherStart = await checkFiscalCalendars(fakeClient({ integration: props }), [need('integration:int-1', 7)], { now: NOW, state });
	assert.equal(otherStart[0].code, 'push.fiscal-calendar-unverified');
});

test('no calendar is built where one is registered, the integration is read-only, or cards compete for it', async () => {
	const registered = provisioningClient({ raw: { ...WRITEABLE, properties: { fiscal_calendar_name: 'CAL' } } });
	assert.deepEqual(await provisionFiscalCalendars(registered.c, [need('integration:int-1')], { state: { objects: {} }, dataflows: registered.dataflows }), []);
	const readOnly = provisioningClient({ raw: { writeable: false } });
	assert.deepEqual(await provisionFiscalCalendars(readOnly.c, [need('integration:int-1')], { state: { objects: {} }, dataflows: readOnly.dataflows }), []);
	const contested = provisioningClient();
	const others = [{ slug: 'other', needs: [need('integration:int-1', 7), need('integration:int-1', 7)] }];
	assert.deepEqual(await provisionFiscalCalendars(contested.c, [need('integration:int-1')], { state: { objects: {} }, dataflows: contested.dataflows, others }), []);
	assert.deepEqual(await provisionFiscalCalendars(contested.c, [need('instance')], { state: { objects: {} }, dataflows: contested.dataflows }), [], 'the company calendar is never changed');
	for (const { dataflows } of [registered, readOnly, contested]) assert.equal(dataflows.created.length, 0);
});

test('the calendar t2d registered under its dataset id is renamed and registered under the new name', async () => {
	const props = { fiscal_calendar_database: 'DOMO_DB', fiscal_calendar_schema: 'WRITEBACK_SCHEMA', fiscal_calendar_name: 'aaaa_bbbb' };
	const { c, dataflows } = provisioningClient({ raw: { ...WRITEABLE, properties: props } });
	const state = { objects: { 'fiscalcalendar:int-1': { id: 77, extra: { startMonth: 12, datasetId: 'aaaa-bbbb', table: { database: 'DOMO_DB', schema: 'WRITEBACK_SCHEMA', table: 'aaaa_bbbb' } } } } };
	const issues = await provisionFiscalCalendars(c, [need('integration:int-1')], { state, dataflows });
	assert.deepEqual(issues.map((i) => i.code), ['push.fiscal-calendar-renamed']);
	const table = { database: 'DOMO_DB', schema: 'WRITEBACK_SCHEMA', table: 'FISCAL_CALENDAR_DECEMBER_START' };
	assert.deepEqual(c.registered, [{ ...table, calendarType: 'FISCAL', updated: true }]);
	assert.deepEqual(state.objects['fiscalcalendar:int-1'].extra.table, table);
	assert.equal(dataflows.created.length, 0, 'not rebuilt');
});

test('a calendar table that fails validation is not registered and is reported per card', async () => {
	const { c, dataflows } = provisioningClient({ valid: false });
	const issues = await provisionFiscalCalendars(c, [need('integration:int-1')], { state: { objects: {} }, dataflows });
	assert.deepEqual(issues.map((i) => i.code), ['push.fiscal-calendar-failed', 'push.fiscal-calendar-failed']);
	assert.match(issues[0].message, /not a valid calendar: Missing required column/);
	assert.deepEqual(c.registered, []);
});

test('without credentials the calendars are reported unchecked', async () => {
	const issues = await checkFiscalCalendars(null, [need('instance')]);
	assert.equal(issues[0].code, 'push.fiscal-calendar-unchecked');
});

test('a calendar other workbooks need more on the same target is a conflict for this workbook only', () => {
	const own = [{ ...need('instance', 7), cards: [{ key: 'x', title: 'X' }] }];
	const issues = workspaceCalendarConflicts(own, [{ slug: 'salesreview', needs: [need('instance', 12)] }]);
	assert.deepEqual(issues.map((i) => [i.code, i.object.id]), [['push.fiscal-conflict', 'x']]);
	assert.match(issues[0].message, /December \(salesreview\)/);
	assert.deepEqual(workspaceCalendarConflicts([need('instance', 12)], [{ slug: 'other', needs: [{ ...need('instance', 7), cards: [{ key: 'x', title: 'X' }] }] }]), []);
	assert.deepEqual(workspaceCalendarConflicts([need('instance', 12)], [{ slug: 'other', needs: [need('integration:int-1', 7)] }]), [], 'another target holds its own calendar');
});

test('dry run checks the fiscal calendars read-only and still plans every card', async () => {
	const root = tempDir();
	const ws = openWorkspace(root);
	const plan = samplePlan();
	plan.cards[0].fiscalCalendar = { startMonth: 12, labelByEndYear: true, source: 'instance' };
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, plan);
	const client = fakeClient();
	const summary = await pushPlan({ config: testConfig(root), slug: 'sales', dryRun: true, deps: { client } });
	const fiscal = summary.issues.filter((i) => i.code.startsWith('push.fiscal'));
	assert.deepEqual(fiscal.map((i) => [i.code, i.object.id]), [['push.fiscal-calendar-missing', plan.cards[0].key]]);
	assert.ok(summary.actions.some((a) => a.kind === 'card' && a.key === plan.cards[0].key && a.status === 'dry-run'));
	assert.deepEqual(client.calls, ['GET /content/v1/customer-states/domo.calendar.tablename', 'POST /query/v1/execute/StandardCalendar']);
});

test('a mapped warehouse calendar replaces the generated one t2d registered, and is not rebuilt on the next push', async () => {
	const source = { table: 'DB.SCH.DIM_CALENDAR', startMonth: 12, columns: { date: 'CALENDAR_DATE', fiscalYear: 'FISCAL_YEAR_NUM', fiscalQuarter: 'FISCAL_QUARTER_NUM', fiscalPeriod: 'FISCAL_PERIOD_NUM', weekStart: 'WEEK_START_DATE' }, from: '1989-01-01' };
	const table = { database: 'DOMO_DB', schema: 'WRITEBACK_SCHEMA', table: 'aaaa_bbbb' };
	const props = { fiscal_calendar_database: 'DOMO_DB', fiscal_calendar_schema: 'WRITEBACK_SCHEMA', fiscal_calendar_name: 'aaaa_bbbb' };
	const { c, dataflows } = provisioningClient({ raw: { ...WRITEABLE, properties: props } });
	const state = { instance: 'acme', objects: { 'fiscalcalendar:int-1': { id: 77, extra: { startMonth: 12, datasetId: 'aaaa-bbbb', table } } } };
	const updates = [];
	dataflows.updateDataflow = async (_c, id, def) => (updates.push(def), {});
	const issues = await provisionFiscalCalendars(c, [need('integration:int-1')], { state, dataflows, sources: { 'int-1': source } });
	assert.deepEqual(issues.map((i) => i.code), ['push.fiscal-calendar-created']);
	assert.match(updates[0].actions[0].statements[0], /FROM DB\.SCH\.DIM_CALENDAR WHERE "CALENDAR_DATE" >= '1989-01-01'::DATE/);
	assert.equal(updates[0].actions[1].dataSource.schemaMapping, undefined, 'an update leaves the table name to the rename');
	assert.equal(c.registered[0].updated, true);
	assert.equal(state.objects['fiscalcalendar:int-1'].extra.source, 'DB.SCH.DIM_CALENDAR');
	updates.length = 0;
	assert.deepEqual(await provisionFiscalCalendars(c, [need('integration:int-1')], { state, dataflows, sources: { 'int-1': source } }), []);
	assert.equal(updates.length, 0);
	const wrong = await provisionFiscalCalendars(c, [need('integration:int-1', 7)], { state, dataflows, sources: { 'int-1': source } });
	assert.equal(wrong[0].code, 'push.fiscal-calendar-failed');
});
