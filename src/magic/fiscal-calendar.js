import { fiscalStartName } from '../convert/fiscal.js';

/** Years Domo's StandardCalendar covers on a Cloud Amplifier device (live-checked: 1990-01-01 to 2074-12-31). */
export const CALENDAR_YEARS = { from: 1990, to: 2074 };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const decode = (expr, names) => `DECODE(${expr}, ${names.slice(0, -1).map((n, i) => `${i + 1}, '${n}'`).join(', ')}, '${names.at(-1)}')`;
const monthName = decode('MONTH("D")', MONTHS);
const monthAbrv = decode('MONTH("D")', MONTHS.map((m) => m.slice(0, 3)));
const dayName = decode('DAYOFWEEKISO("D")', ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
const weekStart = (d) => `DATEADD(day, -MOD(DAYOFWEEKISO(${d}), 7), ${d})`;
const int = (expr) => `CAST(${expr} AS INTEGER)`;

/**
 * Snowflake SQL for the 25 columns a Cloud Amplifier calendar must have (ice CalendarRegistrationService.REQUIRED_COLUMNS),
 * one row per day, with the values Domo's month-boundary fiscal calendar generator gives (icebox
 * MonthBoundaryCalendarGenerator): weeks start on Sunday and a fiscal year is named by the year it ends.
 * @param {number} startMonth  1-12
 */
export function fiscalCalendarSql(startMonth, years = CALENDAR_YEARS) {
	if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error(`fiscalCalendarSql: start month ${startMonth} is not 1-12`);
	const days = (Date.UTC(years.to + 1, 0, 1) - Date.UTC(years.from, 0, 1)) / 86400000;
	const ahead = startMonth === 1 ? 0 : 1;
	const fy = `YEAR("D") + IFF(MONTH("D") >= ${startMonth}, ${ahead}, 0)`;
	const spine = `SELECT DATEADD(day, ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1, '${years.from}-01-01'::DATE) AS "D" FROM TABLE(GENERATOR(ROWCOUNT => ${days}))`;
	const fiscal = `SELECT "D", ${fy} AS "FY", MOD(MONTH("D") - ${startMonth} + 12, 12) + 1 AS "FM" FROM (${spine}) AS "T0"`;
	const starts = `SELECT "D", "FY", "FM", FLOOR(("FM" - 1) / 3) + 1 AS "FQ", DATE_FROM_PARTS("FY" - ${ahead}, ${startMonth}, 1) AS "YS" FROM (${fiscal}) AS "T1"`;
	const quarters = `SELECT *, DATEADD(month, ("FQ" - 1) * 3, "YS") AS "QS", ${weekStart('"D"')} AS "WS" FROM (${starts}) AS "T2"`;
	return calendarColumnsSql(quarters, ahead);
}

/** The 25 calendar columns read from an existing calendar table (mappings.json `fiscalCalendars`), keeping its fiscal years. */
export function sourceCalendarSql(source) {
	const { table, columns: c, from, startMonth } = source;
	if (!table || !c?.date || !c.fiscalYear || !c.fiscalQuarter || !c.fiscalPeriod) throw new Error('a fiscal calendar mapping needs table and columns date, fiscalYear, fiscalQuarter and fiscalPeriod');
	const col = (name) => `"${String(name).replace(/"/g, '""')}"`;
	const base = `SELECT CAST(${col(c.date)} AS DATE) AS "D", ${int(col(c.fiscalYear))} AS "FY", ${int(col(c.fiscalPeriod))} AS "FM", ${int(col(c.fiscalQuarter))} AS "FQ", ${c.weekStart ? `CAST(${col(c.weekStart)} AS DATE)` : weekStart(`CAST(${col(c.date)} AS DATE)`)} AS "WS" FROM ${table}${from ? ` WHERE ${col(c.date)} >= '${from}'::DATE` : ''}`;
	const starts = `SELECT *, MIN("D") OVER (PARTITION BY "FY") AS "YS", MIN("D") OVER (PARTITION BY "FY", "FQ") AS "QS" FROM (${base}) AS "T0"`;
	return calendarColumnsSql(starts, startMonth === 1 ? 0 : 1);
}

/** The required columns over rows of "D", "FY", "FM", "FQ", "YS", "QS" and "WS". */
function calendarColumnsSql(rows, ahead) {
	const epochYear = 1969 + ahead;
	const columns = [
		['DOMO_Key', '"D"'],
		['Date', '"D"'],
		['DayOfWeek', dayName],
		['DayNumberInWeek', int('MOD(DAYOFWEEKISO("D"), 7) + 1')],
		['DayNumberInMonth', int('DAY("D")')],
		['DayNumberInQuarter', int('DATEDIFF(day, "QS", "D") + 1')],
		['DayNumberInYear', int('DATEDIFF(day, "YS", "D") + 1')],
		['WeekNumberInYear', int(`FLOOR(DATEDIFF(day, ${weekStart('"YS"')}, "WS") / 7) + 1`)],
		['MonthName', monthName],
		['MonthAbrv', monthAbrv],
		['MonthNumberInYear', int('"FM"')],
		['Quarter', `'Q' || CAST("FQ" AS VARCHAR)`],
		['Year', int('"FY"')],
		['CalendarMonth', `CAST("FY" AS VARCHAR) || '-' || ${monthAbrv}`],
		['CalendarQuarter', `CAST("FY" AS VARCHAR) || '-Q' || CAST("FQ" AS VARCHAR)`],
		['WeekStart', '"WS"'],
		['QuarterStart', '"QS"'],
		['DaySinceEpoch', int(`DATEDIFF(day, '1969-12-31'::DATE, "D")`)],
		// icebox seeds it with daySinceEpoch / 7 on the first row (1043 on 1990-01-01), then adds one per week
		['WeekSinceEpoch', int(`DATEDIFF(day, '1970-01-04'::DATE, "WS") / 7`)],
		['MonthSinceEpoch', int('(YEAR("D") - 1970) * 12 + MONTH("D")')],
		['QuarterSinceEpoch', int(`("FY" - ${epochYear}) * 4 + "FQ" - 1`)],
		['YearSinceEpoch', int(`"FY" - ${epochYear}`)],
		['MonthStart', `DATE_TRUNC('month', "D")`],
		['YearStart', '"YS"'],
		['QuarterOfYear', int('"FQ"')]
	];
	return `SELECT ${columns.map(([name, expr]) => `${expr} AS "${name}"`).join(', ')} FROM (${rows}) AS "T3"`;
}

export const calendarDatasetName = (startMonth) => `t2d Fiscal Calendar (${fiscalStartName(startMonth)} start)`;

/**
 * A Magic ETL dataflow that writes the fiscal calendar into the integration's warehouse, so it can be registered there.
 * It needs the graph editor format: without `useGraphUI` dataProcessing runs an ADR flow in legacy mode
 * (AdrenalineExecutionEngineService), where a Snowflake SQL tile fails.
 * @param {{ integrationId: string, integrationName?: string, startMonth: number, table?: import('../domo/calendars.js').CalendarTable }} opts
 */
export function fiscalCalendarDataflow({ integrationId, integrationName, startMonth, source, table }) {
	const name = calendarDatasetName(startMonth);
	const actions = [
		{ type: 'SQL', id: 'sql-fiscal-calendar', name: 't2d_FISCAL_CALENDAR', inputs: [], settings: { sqlDialect: 'SNOWFLAKE', preferredDatabaseEntityType: 'TEMP_VIEW' }, statements: [source ? sourceCalendarSql(source) : fiscalCalendarSql(startMonth)], gui: { x: 50, y: 50 } },
		{
			type: 'PublishToVault',
			id: 'out-fiscal-calendar',
			name,
			dependsOn: ['sql-fiscal-calendar'],
			dataSource: { guid: '', name, description: `Fiscal year starts ${fiscalStartName(startMonth)} 1 and is named by the year it ends.`, type: 'DataFlow', cloudId: integrationId, ...(table ? { schemaMapping: { database: table.database, schemaName: table.schema, tableName: table.table } } : {}) },
			versionChainType: 'REPLACE',
			gui: { x: 270, y: 50 }
		}
	];
	return {
		name: source ? `t2d fiscal calendar (${source.table})` : `t2d fiscal calendar (${fiscalStartName(startMonth)} start)`,
		description: `Fiscal calendar for Cloud Amplifier integration ${integrationName ?? integrationId}, ${source ? `read from ${source.table} in Domo's calendar columns` : `generated in its warehouse for ${CALENDAR_YEARS.from} through ${CALENDAR_YEARS.to}`}. t2d registered its output as the integration's fiscal calendar, so keep it.`,
		databaseType: 'ADR',
		computeCloud: integrationId,
		settings: { sqlDialect: 'ADRENALINE' },
		runState: 'ENABLED',
		engineProperties: { 'kettle.mode': 'STRICT' },
		gui: {
			version: '1.0',
			useGraphUI: true,
			canvases: { default: { canvasSettings: { coarserGrid: true, hideCoarserGridPopUp: false }, disabledActions: [], elements: actions.map((a) => ({ id: a.id, type: 'Tile', x: a.gui.x, y: a.gui.y, color: null, colorSource: null })) } }
		},
		actions
	};
}
