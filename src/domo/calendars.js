const CALENDAR_COLUMNS = ['Date', 'Year', 'Quarter', 'QuarterOfYear', 'YearStart'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Table of the company's custom fiscal calendar; '' when the instance has none. */
export async function getInstanceCalendarTable(c) {
	const state = await c.get('/content/v1/customer-states/domo.calendar.tablename');
	return String(state?.value ?? '');
}

/**
 * Rows of the instance's calendar (the StandardCalendar pseudo-dataset, which follows the company fiscal calendar).
 * @param {import('./client.js').DomoClient} c
 * @param {string[]} dates  yyyy-mm-dd
 * @returns {Promise<Map<string, { Date: string, Year: number, Quarter: string, QuarterOfYear: number, YearStart: string }>>}
 */
export async function queryStandardCalendar(c, dates) {
	const list = dates.filter((d) => ISO_DATE.test(d));
	if (!list.length) return new Map();
	const sql = `SELECT ${CALENDAR_COLUMNS.map((col) => `\`${col}\``).join(', ')} FROM StandardCalendar WHERE \`Date\` IN (${list.map((d) => `'${d}'`).join(', ')})`;
	const res = await c.post('/query/v1/execute/StandardCalendar', { sql });
	const columns = res?.columns ?? CALENDAR_COLUMNS;
	const rows = new Map();
	for (const row of res?.rows ?? []) {
		const rec = Object.fromEntries(columns.map((col, i) => [col, row[i]]));
		rows.set(String(rec.Date).slice(0, 10), { ...rec, Year: Number(rec.Year), QuarterOfYear: Number(rec.QuarterOfYear), YearStart: String(rec.YearStart ?? '').slice(0, 10) });
	}
	return rows;
}

const prop = (raw, name) => {
	const value = raw?.properties?.[name];
	return value && typeof value === 'object' ? value.value : value;
};

/**
 * Fiscal calendar table registered on a Cloud Amplifier integration, read
 * without changing anything.
 * @returns {Promise<{ name: string, calendar?: CalendarTable, writeback?: { database: string, schema: string } }>}
 */
export async function getIntegrationFiscalCalendar(c, integrationId) {
	const raw = await c.get(`/query/v1/byos/accounts/${encodeURIComponent(integrationId)}`);
	const name = String(raw?.friendlyName ?? prop(raw, 'friendlyName') ?? integrationId);
	const database = raw?.database ?? prop(raw, 'database');
	const schema = raw?.defaultSchema ?? prop(raw, 'default_schema');
	const writeback = raw?.writeable === true && database && schema ? { writeback: { database: String(database), schema: String(schema) } } : {};
	const table = prop(raw, 'fiscal_calendar_name');
	if (!table) return { name, ...writeback };
	return { name, calendar: { database: String(prop(raw, 'fiscal_calendar_database') ?? ''), schema: String(prop(raw, 'fiscal_calendar_schema') ?? ''), table: String(table) }, ...writeback };
}

/** @typedef {{ database: string, schema: string, table: string }} CalendarTable */

const calendarPath = (integrationId, action) => `/query/v1/byos/accounts/${encodeURIComponent(integrationId)}/calendar/${action}`;

/** A table missing calendar columns answers 200 with `success: false` (icebox ByosResource.validateCalendar). @param {CalendarTable} table */
export async function validateIntegrationFiscalCalendar(c, integrationId, table) {
	const res = await c.post(calendarPath(integrationId, 'validate'), { ...table, calendarType: 'FISCAL' });
	return { success: res?.success === true, message: String(res?.message ?? '') };
}

/** Domo refuses it while another fiscal calendar is registered (ice CalendarRegistrationService). @param {CalendarTable} table */
export async function registerIntegrationFiscalCalendar(c, integrationId, table) {
	return c.post(calendarPath(integrationId, 'register'), { ...table, calendarType: 'FISCAL' }, { idempotent: false });
}

/** icebox ByosResource.updateCalendar. @param {CalendarTable} table */
export async function updateIntegrationFiscalCalendar(c, integrationId, table) {
	return c.put(calendarPath(integrationId, 'update'), { ...table, calendarType: 'FISCAL' }, { idempotent: false });
}
