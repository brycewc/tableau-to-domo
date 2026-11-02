import { stripBrackets } from '../model/naming.js';
import { parsePillId } from '../tableau/twb/shelf.js';
import { rankAscending, tableCalcAddressing } from './calc/tablecalc.js';

/**
 * @typedef {import('../model/types.js').FilterIR} FilterIR
 * @typedef {import('../model/types.js').FieldBinding} FieldBinding
 * @typedef {import('../model/types.js').FieldBindings} FieldBindings
 * @typedef {import('../model/types.js').ParameterIR} ParameterIR
 * @typedef {import('../model/types.js').Issue} Issue
 * @typedef {{ name: string, startMonth: number }} CalendarUse  A date field whose periods follow the card's Domo calendar
 *
 * @typedef {Object} CardFormulaSpec
 * @property {string} name
 * @property {string} formula
 * @property {'string'|'numeric'|'date'|'datetime'} dataType
 * @property {boolean} aggregated
 *
 * @typedef {Object} FilterContext
 * @property {string} datasetKey                  Card-target dataset; bindings on other datasets are dropped
 * @property {string} [datasourceId]              Default Tableau datasource for filters without one
 * @property {{ type: string, name: string }} [object]   Issue owner
 * @property {ParameterIR[]} [parameters]         To resolve parameter-driven Top N counts
 * @property {(spec: CardFormulaSpec) => string} [addFormula]  Registers a card-scoped beast mode, returns its id
 * @property {Set<string>} [skipPillIds]          Filters exposed as quick filters (not baked into the card)
 * @property {Set<string>} [trackPillIds]         Filters whose card filters are listed in the result's `origins`
 * @property {Set<string>} [viewDimensions]       Field ids the card groups by as plain dimensions (ATTR filters)
 * @property {import('../model/types.js').WorksheetIR} [worksheet]  For a Rank filter's compute-using and direction
 *
 * @typedef {Object} TopSpec
 * @property {number} count
 * @property {'top'|'bottom'} direction
 * @property {Object} orderBy                     Domo orderBy entry for the ranking measure
 * @property {string} fieldId                     Field the Top N ranks
 * @property {boolean} [approximate]
 */

const INTERVALS = { year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', week: 'WEEK', day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'MINUTE' };
/** Periods a card's `fiscal` flag moves onto the fiscal calendar. */
export const CALENDAR_INTERVALS = new Set(['YEAR', 'QUARTER', 'MONTH', 'WEEK']);
const AGGREGATIONS = { sum: 'SUM', avg: 'AVG', average: 'AVG', count: 'COUNT', min: 'MIN', max: 'MAX', median: 'MEDIAN' };
const TOP_AGGREGATIONS = { ...AGGREGATIONS, stdev: 'STDDEV', stdevp: 'STDDEV_POP', varp: 'VAR_POP' };
const HAVING_AGGREGATIONS = { ...AGGREGATIONS, stdev: 'STDDEV', stdevp: 'STDDEV_POP', varp: 'VAR_POP', attribute: 'MAX', attr: 'MAX' };
const HAVING_FORMULAS = {
	countd: { label: 'Distinct count', wrap: (expr) => `COUNT(DISTINCT ${expr})` },
	var: { label: 'Variance', wrap: (expr) => `VAR(${expr})` }
};
const WILDCARD_OPERANDS ={ contains: 'CONTAINS', 'starts-with': 'STARTS_WITH', 'ends-with': 'ENDS_WITH', exact: 'EQUALS' };
// Card create answers 400 'slicers may have at most 50 values' above this.
const MAX_SLICER_VALUES = 50;
export const MAX_SLICERS = 20;

/** Selected members of a categorical quick filter, without nulls. */
const selectedMembers = (filter) => (filter.include ?? filter.exclude ?? []).filter((v) => v !== null && v !== undefined);

// The first IR version with FilterIR.group and FilterIR.shared.
const SCOPE_IR_VERSION = 13;

/**
 * @typedef {Object} FilterScope                 The sheets of a dashboard one Tableau filter shown on it applies to
 * @property {string} id
 * @property {string} worksheet                   The sheet its filter zone names
 * @property {Map<string, string>} members        Worksheet name to the pill id of its copy of the filter
 */

function fieldCaption(ir, filter) {
	const ds = (ir.datasources ?? []).find((d) => d.id === filter.datasourceId);
	const field = (ds?.fields ?? []).find((f) => f.id === filter.fieldId);
	return String(field?.caption ?? field?.name ?? stripBrackets(filter.fieldId)).toLowerCase();
}

/** Copies of one filter: the same filter-group on the same field (by caption across related datasources), or one shared view. */
function samePeerFilter(ir, f, g) {
	if (g.hidden || g.kind !== f.kind) return false;
	if (f.shared && g.shared === f.shared && g.pillId === f.pillId) return true;
	if (!f.group || g.group !== f.group) return false;
	if (g.pillId === f.pillId) return true;
	const derivation = (p) => String(parsePillId(p).derivation ?? '').toLowerCase();
	return derivation(f.pillId) === derivation(g.pillId) && fieldCaption(ir, f) === fieldCaption(ir, g);
}

/**
 * Per dashboard, the scope of each filter zone: its sheet plus the dashboard's sheets holding a copy of the filter.
 * Zones on one field whose scopes share a sheet are one scope. Empty for an ir.json without filter scope.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @returns {Map<string, FilterScope[]>}  by dashboard name
 */
export function dashboardFilterScopes(ir) {
	const out = new Map();
	if ((ir?.irVersion ?? 1) < SCOPE_IR_VERSION) return out;
	const sheets = new Map((ir.worksheets ?? []).map((w) => [w.name, w]));
	for (const dash of ir.dashboards ?? []) {
		const zones = [...(dash.zones ?? []), ...(dash.floating ?? [])];
		const placed = [...new Set(zones.filter((z) => z.kind === 'worksheet' && z.worksheet).map((z) => z.worksheet))].map((n) => sheets.get(n)).filter(Boolean);
		const scopes = [];
		for (const zone of zones) {
			if (zone.kind !== 'filter' || !zone.worksheet || !zone.param) continue;
			const ws = placed.find((w) => w.name === zone.worksheet);
			if (!ws) continue;
			const members = new Map([[ws.name, zone.param]]);
			const f = (ws.filters ?? []).find((x) => x.pillId === zone.param && !x.hidden);
			if (f?.group || f?.shared) {
				for (const other of placed) {
					const g = other === ws ? undefined : (other.filters ?? []).find((x) => samePeerFilter(ir, f, x));
					if (g) members.set(other.name, g.pillId);
				}
			}
			const same = scopes.find((s) => [...members].some(([name, pillId]) => s.members.get(name) === pillId));
			if (same) for (const [name, pillId] of members) if (!same.members.has(name)) same.members.set(name, pillId);
			if (!same) scopes.push({ id: `${dash.name}#${scopes.length + 1}`, worksheet: ws.name, members });
		}
		if (scopes.length) out.set(dash.name, scopes);
	}
	return out;
}

/**
 * True when a quick filter's selection is too large for a Domo slicer default. Its control starts unfiltered,
 * so the caller keeps the selection as a fixed card filter.
 * @param {FilterIR} filter
 */
export function exceedsSlicerLimit(filter) {
	return filter.kind === 'categorical' && !filter.all && selectedMembers(filter).length > MAX_SLICER_VALUES;
}

export const GTE = 'GREAT_THAN_EQUALS_TO';
export const LTE = 'LESS_THAN_EQUALS_TO';

/**
 * Lowercase filter dataType for a binding: string | numeric | date | datetime.
 * @param {FieldBinding} binding
 */
export function filterDataType(binding) {
	const t = String(binding?.dataType ?? '').toUpperCase();
	if (t === 'LONG' || t === 'DOUBLE' || t === 'DECIMAL') return 'numeric';
	if (t === 'DATE') return 'date';
	if (t === 'DATETIME') return 'datetime';
	if (t === 'STRING') return 'string';
	const tt = binding?.tableauType;
	if (tt === 'integer' || tt === 'real') return 'numeric';
	if (tt === 'date') return 'date';
	if (tt === 'datetime') return 'datetime';
	return 'string';
}

/**
 * Beast Mode SQL operand for a binding: a backticked column or the formula's own expression.
 * @param {FieldBinding} binding
 * @returns {string|undefined}
 */
export function bindingExpression(binding) {
	if (!binding) return undefined;
	if (binding.kind === 'column') return `\`${binding.column}\``;
	if (binding.kind === 'formula') {
		if (binding.aggregated) return undefined;
		return binding.expression ? `(${binding.expression})` : `\`${binding.formulaId}\``;
	}
	return undefined;
}

/**
 * Card-scoped Beast Mode for a discrete date part or a truncation label, plus how a Tableau
 * member value maps onto it.
 *
 * @param {string} part   year | quarter | month | week | day | weekday | hour | minute | second (parts),
 *                        or 'trunc:<grain>' for a sortable truncation label
 * @param {string} expr   Column or expression
 * @param {number} [fiscalStart]  Month 2-12 the field's fiscal year starts in: year, quarter and week count from it
 *                        (a year named by the year it ends, as Tableau does) and months sort from it
 * @returns {{ formula: string, dataType: 'string'|'numeric'|'date', label: string, sortFormula?: string, toValue: (v: any) => string|undefined }}
 */
export function datePartFormula(part, expr, fiscalStart) {
	if (fiscalStart > 1 && fiscalStart <= 12) return fiscalDatePartFormula(part, expr, fiscalStart);
	const num = (v) => (v === null || v === undefined || v === '' ? undefined : String(v));
	switch (part) {
		case 'year':
			return { formula: `YEAR(${expr})`, dataType: 'numeric', label: 'Year', toValue: num };
		case 'quarter':
			return { formula: `CONCAT('Q', QUARTER(${expr}))`, dataType: 'string', label: 'Quarter', toValue: (v) => (num(v) ? `Q${num(v)}` : undefined) };
		case 'month':
			return { formula: `MONTHNAME(${expr})`, dataType: 'string', label: 'Month', sortFormula: `MIN(MONTH(${expr}))`, toValue: (v) => monthName(v) };
		case 'week':
			return { formula: tableauWeek(expr), dataType: 'numeric', label: 'Week', toValue: num };
		case 'day':
			return { formula: `DAYOFMONTH(${expr})`, dataType: 'numeric', label: 'Day', toValue: num };
		case 'weekday':
			return { formula: `DAYNAME(${expr})`, dataType: 'string', label: 'Weekday', sortFormula: `MIN(DAYOFWEEK(${expr}))`, toValue: (v) => weekdayName(v) };
		case 'hour':
			return { formula: `HOUR(${expr})`, dataType: 'numeric', label: 'Hour', toValue: num };
		case 'minute':
			return { formula: `MINUTE(${expr})`, dataType: 'numeric', label: 'Minute', toValue: num };
		case 'second':
			return { formula: `SECOND(${expr})`, dataType: 'numeric', label: 'Second', toValue: num };
		case 'trunc:year':
			return { formula: `YEAR(${expr})`, dataType: 'numeric', label: 'Year', toValue: (v) => (v ? String(v).slice(0, 4) : undefined) };
		case 'trunc:quarter':
			return {
				formula: `CONCAT(YEAR(${expr}), '-Q', QUARTER(${expr}))`,
				dataType: 'string',
				label: 'Quarter',
				toValue: (v) => (v ? `${String(v).slice(0, 4)}-Q${Math.floor((Number(String(v).slice(5, 7)) - 1) / 3) + 1}` : undefined)
			};
		case 'trunc:month':
			return { formula: `DATE_FORMAT(${expr}, '%Y-%m')`, dataType: 'string', label: 'Month', toValue: (v) => (v ? String(v).slice(0, 7) : undefined) };
		case 'trunc:week':
			return { formula: `DATE_FORMAT(${expr}, '%x-W%v')`, dataType: 'string', label: 'Week', toValue: () => undefined };
		case 'trunc:hour':
			return { formula: `DATE_FORMAT(${expr}, '%Y-%m-%d %H:00')`, dataType: 'string', label: 'Hour', toValue: (v) => (v ? `${String(v).slice(0, 10)} ${String(v).slice(11, 13)}:00` : undefined) };
		case 'trunc:minute':
		case 'trunc:second':
			return { formula: `DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i')`, dataType: 'string', label: 'Minute', toValue: (v) => (v ? `${String(v).slice(0, 10)} ${String(v).slice(11, 16)}` : undefined) };
		default:
			return { formula: `DATE(${expr})`, dataType: 'date', label: 'Day', toValue: (v) => (v ? String(v).slice(0, 10) : undefined) };
	}
}

function shiftedYearQuarter(v, shift) {
	const m = /^(\d{4})-(\d{2})/.exec(String(v ?? ''));
	if (!m) return undefined;
	const months = Number(m[1]) * 12 + Number(m[2]) - 1 + shift;
	return { year: Math.floor(months / 12), quarter: Math.floor((months % 12) / 3) + 1 };
}

function fiscalDatePartFormula(part, expr, start) {
	const shift = 13 - start;
	const shifted = `DATE_ADD(${expr}, INTERVAL ${shift} MONTH)`;
	const calendar = datePartFormula(part, expr);
	const num = (v) => (v === null || v === undefined || v === '' ? undefined : String(v));
	switch (part) {
		case 'year':
			return { ...calendar, formula: `YEAR(${shifted})`, toValue: num };
		case 'quarter':
			return { ...calendar, formula: `CONCAT('Q', QUARTER(${shifted}))` };
		case 'month':
			return { ...calendar, sortFormula: `MIN(MONTH(${shifted}))` };
		case 'week': {
			const jan1 = `DATE_SUB(DATE(${shifted}), INTERVAL (DAYOFYEAR(${shifted}) - 1) DAY)`;
			const yearStart = `DATE_SUB(${jan1}, INTERVAL ${shift} MONTH)`;
			return { ...calendar, formula: `FLOOR((DATEDIFF(DATE(${expr}), ${yearStart}) + DAYOFWEEK(${yearStart}) - 1) / 7) + 1` };
		}
		case 'trunc:year':
			return { ...calendar, formula: `YEAR(${shifted})`, toValue: (v) => (shiftedYearQuarter(v, shift) ? String(shiftedYearQuarter(v, shift).year) : undefined) };
		case 'trunc:quarter':
			return {
				...calendar,
				formula: `CONCAT(YEAR(${shifted}), '-Q', QUARTER(${shifted}))`,
				toValue: (v) => {
					const fy = shiftedYearQuarter(v, shift);
					return fy ? `${fy.year}-Q${fy.quarter}` : undefined;
				}
			};
		default:
			return calendar;
	}
}

/** Fiscal years are named by the year they end, so FY2026 starting in December begins 2025-12-01. */
export function fiscalYearRange(from, to, start = 1) {
	if (!(start > 1)) return [`${from}-01-01`, `${to}-12-31`];
	const mm = String(start).padStart(2, '0');
	const end = new Date(Date.UTC(to, start - 1, 0)).toISOString().slice(0, 10);
	return [`${from - 1}-${mm}-01`, end];
}

/**
 * Window PARTITION BY / ORDER BY item for a dimension pill (tableCalcAddressing `toItem`): its column, or the same
 * date part or calculation expression the card groups by (so month and weekday parts order by name).
 * @param {import('../model/types.js').PillIR|undefined} pill
 * @param {import('../model/types.js').FieldBinding|undefined} binding
 * @returns {{ column: string }|{ expression: string }|undefined}
 */
export function pillWindowItem(pill, binding) {
	if (!binding || binding.kind === 'unsupported' || binding.aggregated) return undefined;
	const part = pill?.datePart === 'mdy' ? 'trunc:day' : (pill?.datePart ?? (pill?.dateTrunc ? `trunc:${pill.dateTrunc}` : null));
	const expr = bindingExpression(binding);
	if (!part) return binding.kind === 'column' ? { column: binding.column } : expr ? { expression: expr } : undefined;
	if (!expr) return undefined;
	return { expression: datePartFormula(part, expr, binding.fiscalYearStart).formula };
}

/** Tableau week number (week 1 contains January 1, weeks start Sunday); MySQL WEEK() mode 0 numbers differently. */
function tableauWeek(expr) {
	const jan1 = `DATE_SUB(DATE(${expr}), INTERVAL (DAYOFYEAR(${expr}) - 1) DAY)`;
	return `FLOOR((DAYOFYEAR(${expr}) + DAYOFWEEK(${jan1}) - 2) / 7) + 1`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function monthName(v) {
	const n = Number(v);
	if (Number.isInteger(n) && n >= 1 && n <= 12) return MONTHS[n - 1];
	return v === null || v === undefined ? undefined : String(v);
}

function weekdayName(v) {
	const n = Number(v);
	if (Number.isInteger(n) && n >= 1 && n <= 7) return WEEKDAYS[n - 1];
	return v === null || v === undefined ? undefined : String(v);
}

/** Column reference fields for a binding: dataset column or dataset beast mode. */
export function refOf(binding) {
	if (binding.kind === 'formula') return { column: binding.formulaId, formulaId: binding.formulaId };
	return { column: binding.column };
}

/**
 * Card filter reference for a binding, in the shape the editor saves (COLUMN_ID only for columns). A filter on a beast
 * mode carries no filterType and no formulaId: the server stores it as LEGACY, which the quick filter values endpoint
 * can resolve. FORMULA_ID filters fail every quick filter of the card with INVALID_COLUMN.
 */
export function filterRef(binding) {
	if (binding.kind === 'formula') return { column: binding.formulaId };
	return { column: binding.column, filterType: 'COLUMN_ID' };
}

/** Filter reference to a card-scoped beast mode registered through ctx.addFormula; create remaps it to the saved id. */
function cardFormulaRef(id) {
	return { column: id };
}

const MEMBER_LIST_BYTES = 49_152;

function stringValue(v, dataType) {
	if (v === null || v === undefined) return undefined;
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	const s = String(v);
	if (dataType === 'date') return s.slice(0, 10);
	return s;
}

/** A filter value; on a set's In/Out pill Tableau stores true and false, which the set beast mode returns as 'In' and 'Out'. */
function memberValue(v, dataType, binding) {
	if (binding.setMembers && (v === true || v === 'true')) return 'In';
	if (binding.setMembers && (v === false || v === 'false')) return 'Out';
	return stringValue(v, dataType);
}

function makeIssue(ctx, severity, code, message, suggestion) {
	const out = { severity, code, message };
	if (ctx.object) out.object = ctx.object;
	if (suggestion) out.suggestion = suggestion;
	return out;
}

function fieldLabel(filter, binding) {
	return binding?.name ?? stripBrackets(filter.fieldId);
}

/**
 * Resolve the binding for a filter, checking it lives on the card's dataset.
 * @returns {{ binding?: FieldBinding, problem?: string }}
 */
function resolveBinding(filter, bindings, ctx) {
	const ds = filter.datasourceId || ctx.datasourceId;
	const binding = bindings?.get?.(ds, filter.fieldId);
	if (!binding) return { problem: 'has no Domo column' };
	if (binding.kind === 'unsupported') return { problem: `could not be converted (${binding.reason ?? 'unsupported'})` };
	if (ctx.datasetKey && binding.datasetKey && binding.datasetKey !== ctx.datasetKey) return { problem: 'comes from a blended datasource' };
	return { binding };
}

function pillDateHandling(filter) {
	if (!filter.pillId) return {};
	const pill = parsePillId(filter.pillId);
	const part = pill.datePart === 'mdy' ? undefined : pill.datePart ?? undefined;
	return { part, trunc: pill.dateTrunc ?? undefined };
}

function contiguousYears(values) {
	const nums = values.map(Number);
	if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1000 || n > 9999)) return null;
	nums.sort((x, y) => x - y);
	for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) return null;
	return [nums[0], nums.at(-1)];
}

function sqlLiteral(v, dataType) {
	if (dataType === 'numeric' && Number.isFinite(Number(v))) return String(Number(v));
	return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Beast Mode predicate for a member list; an exclude keeps nulls unless null is listed, as Tableau does. */
export function memberCondition(binding, members, { exclude = false } = {}) {
	const expr = bindingExpression(binding);
	if (!expr) return undefined;
	const dataType = filterDataType(binding);
	const values = members.filter((v) => v !== null && v !== undefined).map((v) => sqlLiteral(memberValue(v, dataType, binding), dataType));
	const hasNull = values.length < members.length;
	const list = values.length ? `${expr} ${exclude ? 'NOT IN' : 'IN'} (${values.join(', ')})` : undefined;
	if (exclude) return [hasNull ? `${expr} IS NOT NULL` : undefined, list && !hasNull ? `(${expr} IS NULL OR ${list})` : list].filter(Boolean).join(' AND ') || '1 = 1';
	return [list, hasNull ? `${expr} IS NULL` : undefined].filter(Boolean).join(' OR ') || '1 = 0';
}

/**
 * Categorical filter with member ranges (groupfilter function='range', a shift-selected run of members): a number range,
 * or a text range Tableau compares case-sensitively, alone is a BETWEEN; other text ranges and ranges mixed with members
 * become a card beast mode predicate, comparing lower-cased text where Tableau's collation ignores case.
 */
function memberRangeFilters(filter, binding, ctx, out, ranges) {
	const label = fieldLabel(filter, binding);
	const exclude = Boolean(filter.exclude && !filter.include);
	const members = selectedMembers(filter);
	const dataType = filterDataType(binding);
	const { part, trunc } = pillDateHandling(filter);
	const skip = (why) => {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.member-range', `Filter on ${label} selects a range of members, which ${why}; skipped`));
		out.approximate = true;
	};
	if (part || trunc) return skip('is not converted on a date part');
	const bounds = ranges.map((r) => [stringValue(r.from, dataType), stringValue(r.to, dataType)]);
	const foldCase = dataType === 'string' && !binding.caseSensitive;
	const expr = bindingExpression(binding);
	const canFormula = Boolean(expr && ctx.addFormula);
	const between = bounds.map((b) => b.join(' to ')).join(', ');
	const textNote = dataType === 'string' ? '; text compares character by character, as in Tableau, so a range from P1 to P7 also keeps P10' : '';
	if (foldCase && !canFormula && bounds.length === 1 && !members.length) {
		out.issues.push(
			makeIssue(ctx, 'warning', 'filter.member-range', `Filter on ${label} keeps the values from ${between}; Tableau compares this text ignoring case and the card filter compares it case-sensitively, so values that differ only in case may be kept or dropped differently`)
		);
		out.approximate = true;
	} else {
		out.issues.push(makeIssue(ctx, 'info', 'filter.member-range', `Filter on ${label} keeps the values from ${between}, compared as Tableau compares them${foldCase ? ' (ignoring case)' : ''}${textNote}`));
	}
	if (bounds.length === 1 && !members.length && (!foldCase || !canFormula)) {
		out.filters.push({ ...filterRef(binding), operand: exclude ? 'NOT_BETWEEN' : 'BETWEEN', values: bounds[0], dataType });
		return;
	}
	if (!canFormula) return skip('needs a card beast mode that could not be built');
	const rangeExpr = foldCase ? `LOWER(${expr})` : expr;
	const bound = (v) => sqlLiteral(foldCase ? v.toLowerCase() : v, dataType);
	const terms = bounds.map(([a, b]) => `${rangeExpr} BETWEEN ${bound(a)} AND ${bound(b)}`);
	if (members.length) terms.unshift(`${expr} IN (${members.map((v) => sqlLiteral(stringValue(v, dataType), dataType)).join(', ')})`);
	const id = ctx.addFormula({ name: `${label} (selected members)`, formula: `CASE WHEN ${terms.join(' OR ')} THEN 'true' ELSE 'false' END`, dataType: 'string', aggregated: false });
	out.filters.push({ ...cardFormulaRef(id), operand: 'IN', values: [exclude ? 'false' : 'true'], dataType: 'string' });
}

const memberRanges = (filter) => (filter.kind === 'categorical' && !filter.all ? (filter.ranges ?? []).filter((r) => r && r.from != null && r.to != null) : []);
const hasMemberRanges = (filter) => memberRanges(filter).length > 0;

/**
 * True for an ATTR filter on a dimension the view does not group by: Tableau keeps a mark when ATTR (one value
 * across its rows, else '*') is selected, which a row filter cannot express. Needs `ctx.viewDimensions`.
 */
export function isAttrMarkFilter(filter, binding, ctx) {
	if (filter.kind !== 'categorical' || !filter.aggregated || binding?.aggregated || !ctx.viewDimensions) return false;
	const derivation = String(filter.pillId ? parsePillId(filter.pillId).derivation : '').toLowerCase();
	return (derivation === 'attribute' || derivation === 'attr') && !ctx.viewDimensions.has(filter.fieldId);
}

function attrMarkFilter(filter, binding, ctx, out) {
	const label = fieldLabel(filter, binding);
	const list = filter.include ?? filter.exclude;
	const expr = bindingExpression(binding);
	if (!expr || !ctx.addFormula) {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.attr', `ATTR filter on ${label} needs a card beast mode that could not be built; skipped`));
		out.approximate = true;
		return;
	}
	const dataType = filterDataType(binding);
	const members = list.filter((v) => v !== null && v !== undefined).map((v) => sqlLiteral(memberValue(v, dataType, binding), dataType));
	const terms = [];
	if (members.length) terms.push(`(MIN(${expr}) = MAX(${expr}) AND MIN(${expr}) IN (${members.join(', ')}))`);
	if (members.length !== list.length) terms.push(`COUNT(${expr}) = 0`);
	const formula = terms.length ? `CASE WHEN ${terms.join(' OR ')} THEN 'true' ELSE 'false' END` : "'false'";
	const id = ctx.addFormula({ name: `ATTR of ${label} (selected members)`, formula, dataType: 'string', aggregated: true });
	out.filters.push({ ...cardFormulaRef(id), operand: 'IN', values: [filter.include ? 'true' : 'false'], dataType: 'string' });
	out.issues.push(makeIssue(ctx, 'info', 'filter.attr', `ATTR filter on ${label} applies to each mark of the card (HAVING): a mark whose rows hold several values is '*' in Tableau and never selected`));
}

function nullMemberFilter(filter, binding, ctx, out, { values, hasNull }) {
	const exclude = Boolean(filter.exclude && !filter.include);
	if ((!exclude && !hasNull) || binding.setMembers || binding.aggregated) return false;
	const label = fieldLabel(filter, binding);
	const dataType = filterDataType(binding);
	if (exclude && hasNull && (dataType === 'string' || !values.length)) {
		out.filters.push({ ...filterRef(binding), operand: 'NOT_IN', values: [...values.map((v) => memberValue(v, dataType, binding)), ''], dataType });
		const blank = dataType === 'string' ? ', and also rows holding empty text, which Tableau keeps' : '';
		out.issues.push(makeIssue(ctx, 'info', 'filter.null', `Filter on ${label} excludes the Null member; the card filter lists an empty value, which drops the null rows${blank}`));
		return true;
	}
	const condition = memberCondition(binding, filter.exclude ?? filter.include, { exclude });
	if (!condition || !ctx.addFormula) {
		const what = exclude ? 'Tableau keeps the null rows this exclude filter drops' : 'the Null member cannot be expressed in a Domo IN filter and was left out';
		out.issues.push(makeIssue(ctx, 'info', 'filter.null', `Filter on ${label}: ${what}`));
		return false;
	}
	const id = ctx.addFormula({ name: `${label} (selected members)`, formula: `CASE WHEN ${condition} THEN 'true' ELSE 'false' END`, dataType: 'string', aggregated: false });
	out.filters.push({ ...cardFormulaRef(id), operand: 'IN', values: ['true'], dataType: 'string' });
	const why = exclude ? 'it keeps the null rows as Tableau does, which a Domo NOT IN filter drops' : 'it keeps the Null member, which a Domo IN filter cannot list';
	out.issues.push(makeIssue(ctx, 'info', 'filter.null', `Filter on ${label} uses a card beast mode filter: ${why}`));
	return true;
}

/** A set filter in "show members in set" mode: no groupfilter, or one on the set's source members. */
export function keepsSetMembers(filter, binding) {
	return Boolean(binding?.setMembers && filter.kind === 'categorical' && (filter.bare || filter.memberLevel));
}

/** The source IN the set's saved members (narrowed to the sheet's selection), else the set beast mode IN ('In'). */
function setMemberFilters(filter, binding, bindings, ctx, out) {
	const set = binding.set;
	const label = fieldLabel(filter, binding);
	const sourceId = set?.source ?? filter.memberLevel;
	const { binding: source } = sourceId ? resolveBinding({ ...filter, fieldId: sourceId }, bindings, ctx) : {};
	const plain = source && !source.aggregated && !source.setMembers;
	const sourceFilter = (selection) => ({ ...filter, pillId: undefined, fieldId: sourceId, bare: undefined, memberLevel: undefined, all: undefined, include: undefined, exclude: undefined, ...selection });
	const listed = (values, v) => (values ?? []).some((x) => String(x) === String(v));
	if (plain && set && !set.exclude && !set.members.some((v) => v === null || v === undefined)) {
		let members = set.members;
		if (filter.include) members = members.filter((v) => listed(filter.include, v));
		if (filter.exclude) members = members.filter((v) => !listed(filter.exclude, v));
		out.issues.push(makeIssue(ctx, 'info', 'filter.set-members', `Filter keeps the members of set ${label} (${members.map(String).join(', ')}), as a filter on ${fieldLabel({ fieldId: sourceId }, source)}`));
		return categoricalFilters(sourceFilter({ include: members }), source, ctx, out);
	}
	out.filters.push({ ...filterRef(binding), operand: 'IN', values: ['In'], dataType: 'string' });
	out.issues.push(makeIssue(ctx, 'info', 'filter.set-members', `Filter keeps the members of set ${label}, as a filter on its beast mode`));
	if (!(filter.include || filter.exclude)) return;
	if (plain) return categoricalFilters(sourceFilter(filter.include ? { include: filter.include } : { exclude: filter.exclude }), source, ctx, out);
	out.issues.push(makeIssue(ctx, 'warning', 'filter.set-members', `Filter on set ${label} selects source members that have no Domo column on the card's dataset; only the set membership is kept`));
	out.approximate = true;
}

function categoricalFilters(filter, binding, ctx, out, bindings) {
	if (keepsSetMembers(filter, binding)) return setMemberFilters(filter, binding, bindings, ctx, out);
	const ranges = memberRanges(filter);
	if (ranges.length) return memberRangeFilters(filter, binding, ctx, out, ranges);
	const include = filter.include;
	const exclude = filter.exclude;
	if (filter.all || (!include && !exclude)) return;
	if (isAttrMarkFilter(filter, binding, ctx) && (!include || include.length)) return attrMarkFilter(filter, binding, ctx, out);
	const values = (include ?? exclude).filter((v) => v !== null && v !== undefined);
	const hasNull = (include ?? exclude).length !== values.length;
	if (include && include.length === 0) {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.empty', `Filter on ${fieldLabel(filter, binding)} excludes every value; skipped`));
		return;
	}
	const operand = include ? 'IN' : 'NOT_IN';
	const { part, trunc } = pillDateHandling(filter);
	const datePart = (part || trunc) && (binding.dataType === 'DATE' || binding.dataType === 'DATETIME' || binding.tableauType === 'date' || binding.tableauType === 'datetime' || binding.kind === 'formula');
	if (!datePart && nullMemberFilter(filter, binding, ctx, out, { values, hasNull })) return;
	if (hasNull) out.issues.push(makeIssue(ctx, 'info', 'filter.null', `Filter on ${fieldLabel(filter, binding)}: the Null member cannot be expressed in a Domo IN filter and was left out`));
	if (!values.length) return;
	if (datePart) {
		const expr = bindingExpression(binding);
		const yearOf = part === 'year' ? (v) => String(v).slice(0, 4) : datePartFormula('trunc:year', '', binding.fiscalYearStart).toValue;
		const years = part === 'year' || trunc === 'year' ? contiguousYears(values.map(yearOf)) : null;
		if (years && include && binding.kind === 'column') {
			out.filters.push({ ...refOf(binding), operand: 'BETWEEN', values: fiscalYearRange(years[0], years[1], binding.fiscalYearStart), dataType: 'date', filterType: 'COLUMN_ID' });
			return;
		}
		if (!expr || !ctx.addFormula) {
			out.issues.push(makeIssue(ctx, 'warning', 'filter.date-part', `Date-part filter on ${fieldLabel(filter, binding)} could not be expressed; skipped`));
			out.approximate = true;
			return;
		}
		const spec = datePartFormula(part ?? `trunc:${trunc}`, expr, binding.fiscalYearStart);
		const mapped = values.map((v) => spec.toValue(v)).filter((v) => v !== undefined);
		if (mapped.length !== values.length) {
			out.issues.push(makeIssue(ctx, 'warning', 'filter.date-part', `Some ${spec.label.toLowerCase()} values of the filter on ${fieldLabel(filter, binding)} could not be mapped`));
			out.approximate = true;
		}
		const id = ctx.addFormula({ name: `${fieldLabel(filter, binding)} (${spec.label})`, formula: spec.formula, dataType: spec.dataType, aggregated: false });
		out.filters.push({ ...cardFormulaRef(id), operand, values: mapped, dataType: spec.dataType });
		out.issues.push(makeIssue(ctx, 'info', 'filter.card-formula', `Filter on ${fieldLabel(filter, binding)} (${spec.label.toLowerCase()}) uses a card beast mode filter`));
		return;
	}
	const dataType = filterDataType(binding);
	const card = { ...filterRef(binding), operand, values: values.map((v) => memberValue(v, dataType, binding)), dataType };
	out.filters.push(card);
	const expr = bindingExpression(binding);
	if (expr) out.memberLists.push({ card, expr, label: fieldLabel(filter, binding) });
}

/** Move the longest member lists into card beast mode predicates until the card's filters fit MEMBER_LIST_BYTES. */
function fitMemberLists(out, ctx) {
	if (!ctx.addFormula) return;
	let bytes = Buffer.byteLength(JSON.stringify(out.filters));
	const lists = out.memberLists.sort((a, b) => b.card.values.length - a.card.values.length);
	for (const { card, expr, label } of lists) {
		if (bytes <= MEMBER_LIST_BYTES) break;
		const before = Buffer.byteLength(JSON.stringify(card));
		const formula = `CASE WHEN ${expr} IN (${card.values.map((v) => sqlLiteral(v, card.dataType)).join(', ')}) THEN 'true' ELSE 'false' END`;
		const id = ctx.addFormula({ name: `${label} (selected members)`, formula, dataType: 'string', aggregated: false });
		const replacement = { ...cardFormulaRef(id), operand: 'IN', values: [card.operand === 'IN' ? 'true' : 'false'], dataType: 'string' };
		out.issues.push(makeIssue(ctx, 'info', 'filter.member-list', `Filter on ${label} lists ${card.values.length} members, too many for a card filter; it uses a card beast mode filter`));
		for (const key of Object.keys(card)) delete card[key];
		Object.assign(card, replacement);
		bytes -= before - Buffer.byteLength(JSON.stringify(card));
	}
}

/** True when a filter applies to an aggregate (a Tableau measure filter or an aggregated calc), which Domo runs as HAVING. */
export function isAggregateFilter(filter, binding) {
	const range = filter.kind === 'quantitative' || filter.kind === 'range-date';
	if (binding?.aggregated) return range || filter.kind === 'categorical' || filter.kind === 'wildcard';
	return Boolean(filter.aggregated && range);
}

const WINDOW_SQL = /\bOVER\s*\(/i;

/**
 * Card filter reference for an aggregate filter. Domo puts a filter in HAVING when it carries `aggregation`
 * or names an aggregated beast mode.
 * @returns {{ ref?: Object, dataType?: string, problem?: string, note?: string }}
 */
function aggregateTarget(filter, binding, ctx) {
	const pill = filter.pillId ? parsePillId(filter.pillId) : undefined;
	const derivation = String(pill?.derivation ?? 'None').toLowerCase();
	const formula = (name, sql) => {
		if (!ctx.addFormula) return undefined;
		const id = ctx.addFormula({ name, formula: sql, dataType: 'numeric', aggregated: true });
		return cardFormulaRef(id);
	};
	if (pill?.tableCalc || WINDOW_SQL.test(binding.expression ?? '')) return { problem: 'table-calc' };
	if (binding.aggregated) {
		const outer = HAVING_AGGREGATIONS[derivation] ?? HAVING_FORMULAS[derivation];
		if (binding.lodExpression && outer && derivation !== 'sum') {
			const sql = typeof outer === 'string' ? `${outer}(${binding.lodExpression})` : outer.wrap(binding.lodExpression);
			const ref = formula(`${typeof outer === 'string' ? outer : outer.label} of ${fieldLabel(filter, binding)}`, sql);
			return ref ? { ref, dataType: 'numeric' } : { problem: 'formula' };
		}
		return { ref: filterRef(binding), dataType: filterDataType(binding) };
	}
	const cardFormula = HAVING_FORMULAS[derivation];
	if (cardFormula) {
		const expr = bindingExpression(binding);
		const ref = expr && formula(`${cardFormula.label} of ${fieldLabel(filter, binding)}`, cardFormula.wrap(expr));
		return ref ? { ref, dataType: 'numeric' } : { problem: 'formula' };
	}
	const aggregation = HAVING_AGGREGATIONS[derivation];
	if (!aggregation) {
		if (derivation !== 'none' && derivation !== 'user') return { problem: 'aggregation' };
		return {
			ref: { ...filterRef(binding), aggregation: 'SUM' },
			dataType: filterDataType(binding),
			note: 'its aggregation is unknown, so the filter applies to SUM'
		};
	}
	const dataType = aggregation === 'COUNT' ? 'numeric' : filterDataType(binding);
	const note = derivation === 'attribute' || derivation === 'attr' ? 'ATTR is approximated with MAX' : undefined;
	return { ref: { ...filterRef(binding), aggregation }, dataType, note };
}

const OUTER_NAMES = { countd: 'COUNTD', var: 'VAR' };
const OUTER_TYPES = { COUNT: 'LONG', countd: 'LONG', AVG: 'DOUBLE', STDDEV: 'DOUBLE', STDDEV_POP: 'DOUBLE', VAR_POP: 'DOUBLE', var: 'DOUBLE' };

// ATTR of a dimension filters like the dimension itself.
export function isAggregateControl(filter, binding) {
	if (binding?.aggregated) return true;
	if (!filter.aggregated) return false;
	const derivation = String((filter.pillId ? parsePillId(filter.pillId).derivation : '') ?? '').toLowerCase();
	return !(filter.kind === 'categorical' && ['attr', 'attribute', 'none', ''].includes(derivation));
}

/**
 * Dataset beast mode a filter card on an aggregate selects on: the field's own, or a new one. Domo applies its selection as
 * HAVING only on an aggregated dataset beast mode; a column's `aggregation` is dropped and a card beast mode is refused (live).
 * @returns {{ binding?: FieldBinding, expression?: string, name?: string, dataType?: string, aggregation?: string, note?: string, problem?: 'table-calc'|'formula'|'aggregation' }}
 */
export function aggregateFilterField(filter, binding) {
	const pill = filter.pillId ? parsePillId(filter.pillId) : undefined;
	const derivation = String(pill?.derivation ?? 'None').toLowerCase();
	if (pill?.tableCalc || WINDOW_SQL.test(binding.expression ?? '')) return { problem: 'table-calc' };
	const label = fieldLabel(filter, binding);
	const build = (outer, expr, note) => {
		const key = typeof outer === 'string' ? outer : derivation;
		return {
			expression: typeof outer === 'string' ? `${outer}(${expr})` : outer.wrap(expr),
			name: `${OUTER_NAMES[derivation] ?? key}(${label})`,
			dataType: OUTER_TYPES[key] ?? binding.dataType,
			aggregation: OUTER_NAMES[derivation] ?? key,
			...(note ? { note } : {})
		};
	};
	if (binding.aggregated) {
		const outer = HAVING_AGGREGATIONS[derivation] ?? HAVING_FORMULAS[derivation];
		if (binding.lodExpression && outer && derivation !== 'sum') return build(outer, binding.lodExpression);
		return { binding };
	}
	const expr = bindingExpression(binding);
	if (!expr) return { problem: 'formula' };
	const outer = HAVING_FORMULAS[derivation] ?? HAVING_AGGREGATIONS[derivation];
	if (outer) return build(outer, expr, derivation === 'attribute' || derivation === 'attr' ? 'ATTR is approximated with MAX' : undefined);
	if (derivation !== 'none' && derivation !== 'user') return { problem: 'aggregation' };
	return build('SUM', expr, 'its aggregation is unknown, so it uses SUM');
}

/** Rank quick table calc kept to the first N ranks: the same rows as a Top N on the measure it ranks. */
function rankTop(filter, binding, ctx, out) {
	const pill = filter.pillId ? parsePillId(filter.pillId) : undefined;
	if (pill?.tableCalc?.type !== 'Rank' || WINDOW_SQL.test(binding.expression ?? '')) return false;
	if (filter.max === undefined || (filter.includedValues ?? 'in-range') !== 'in-range') return false;
	const min = filter.min === undefined ? 1 : Number(filter.min);
	const count = Math.floor(Number(filter.max));
	if (min > 1 || !(count >= 1)) return false;
	const ws = ctx.worksheet;
	// A rank restarting per partition keeps N per partition, which a card-wide Top N cannot express.
	if (ws && tableCalcAddressing(ws, filter.pillId, () => ({})).partitionBy.length) return false;
	const calc = ws?.pills?.[filter.pillId]?.tableCalc ?? pill.tableCalc;
	const ascending = rankAscending(calc.attrs);
	const aggregation = binding.aggregated ? undefined : (HAVING_AGGREGATIONS[String(pill.derivation ?? '').toLowerCase()] ?? 'SUM');
	const orderBy = { ...refOf(binding), order: ascending ? 'ASCENDING' : 'DESCENDING' };
	if (aggregation) orderBy.aggregation = aggregation;
	out.tops.push({ count, direction: ascending ? 'bottom' : 'top', orderBy, fieldId: filter.fieldId, by: stripBrackets(filter.fieldId) });
	return true;
}

function aggregateRangeFilters(filter, binding, ctx, out, iv) {
	const label = fieldLabel(filter, binding);
	if (rankTop(filter, binding, ctx, out)) {
		out.issues.push(makeIssue(ctx, 'info', 'filter.aggregate', `Rank filter on ${label} (first ${Math.floor(Number(filter.max))}) became a ${out.tops.at(-1).direction === 'bottom' ? 'Bottom' : 'Top'} N ranking`));
		return;
	}
	const target = aggregateTarget(filter, binding, ctx);
	if (target.problem) {
		const why = {
			'table-calc': `Filter on table calculation ${label} is not supported on Domo card filters (Domo filters before window functions); skipped`,
			formula: `Filter on aggregate ${label} needs a card beast mode that could not be built; skipped`,
			aggregation: `Filter on aggregate ${label} uses an aggregation Domo has no equivalent for; skipped`
		}[target.problem];
		out.issues.push(makeIssue(ctx, 'warning', target.problem === 'table-calc' ? 'filter.table-calc' : 'filter.aggregate', why, 'Compute the value in ETL and filter on it.'));
		out.approximate = true;
		return;
	}
	if (target.note) {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.aggregate', `Filter on aggregate ${label}: ${target.note}`));
		out.approximate = true;
	}
	if (iv === 'in-range-or-null') out.issues.push(makeIssue(ctx, 'info', 'filter.null', `Filter on ${label} includes nulls in Tableau; the Domo range filter drops them`));
	const dataType = filter.kind === 'range-date' && target.dataType !== 'datetime' ? 'date' : target.dataType;
	const min = stringValue(filter.min, dataType);
	const max = stringValue(filter.max, dataType);
	const base = { ...target.ref, dataType };
	if (min !== undefined && max !== undefined) out.filters.push({ ...base, operand: 'BETWEEN', values: [min, max] });
	else if (min !== undefined) out.filters.push({ ...base, operand: GTE, values: [min] });
	else out.filters.push({ ...base, operand: LTE, values: [max] });
	out.issues.push(makeIssue(ctx, 'info', 'filter.aggregate', `Filter on aggregate ${label} applies to each row of the card (HAVING), as Tableau applies it at the view's level of detail`));
}

function nullFilter(filter, binding, ctx, out, iv, dataType) {
	const label = fieldLabel(filter, binding);
	const kind = iv === 'null' ? '"Null values only"' : '"Non-null values"';
	const skip = (why) => {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.null', `${kind} filter on ${label} ${why}; skipped`));
		out.approximate = true;
	};
	if (isAggregateFilter(filter, binding)) {
		const derivation = String((filter.pillId ? parsePillId(filter.pillId).derivation : '') ?? '').toLowerCase();
		if (iv === 'non-null' && (derivation === 'count' || derivation === 'countd')) return;
		return skip('applies to an aggregate, and a row filter would change the other measures');
	}
	if (iv === 'non-null' || dataType === 'date' || dataType === 'datetime') {
		out.filters.push({ ...filterRef(binding), operand: iv === 'null' ? 'IN' : 'NOT_IN', values: [''], dataType });
		return;
	}
	const expr = bindingExpression(binding);
	if (!expr || !ctx.addFormula) return skip('needs a card beast mode that could not be built');
	const id = ctx.addFormula({ name: `${label} is null`, formula: `CASE WHEN ${expr} IS NULL THEN 'true' ELSE 'false' END`, dataType: 'string', aggregated: false });
	out.filters.push({ ...cardFormulaRef(id), operand: 'IN', values: ['true'], dataType: 'string' });
}

function rangeFilters(filter, binding, ctx, out) {
	const label = fieldLabel(filter, binding);
	const iv = filter.includedValues ?? 'in-range';
	if (iv === 'all') return;
	if (isAggregateFilter(filter, binding) && (iv === 'in-range' || iv === 'in-range-or-null')) {
		if (filter.min === undefined && filter.max === undefined) return;
		aggregateRangeFilters(filter, binding, ctx, out, iv);
		return;
	}
	let dataType = filterDataType(binding);
	if (filter.kind === 'range-date' && dataType !== 'datetime') dataType = 'date';
	if (iv === 'non-null' || iv === 'null') {
		nullFilter(filter, binding, ctx, out, iv, dataType);
		return;
	}
	if (iv === 'in-range-or-null') out.issues.push(makeIssue(ctx, 'info', 'filter.null', `Filter on ${label} includes nulls in Tableau; the Domo range filter drops them`));
	const min = stringValue(filter.min, dataType);
	const max = stringValue(filter.max, dataType);
	const base = { ...filterRef(binding), dataType };
	if (min !== undefined && max !== undefined) out.filters.push({ ...base, operand: 'BETWEEN', values: [min, max] });
	else if (min !== undefined) out.filters.push({ ...base, operand: GTE, values: [min] });
	else if (max !== undefined) out.filters.push({ ...base, operand: LTE, values: [max] });
}

/**
 * Domo dateTimeRange for a Tableau relative-date filter.
 * @param {{ periodType: string, first: number, last: number }} relative
 * @returns {{ range: Object, approximate: boolean }}
 */
export function relativeDateRange(relative) {
	const interval = INTERVALS[String(relative.periodType ?? 'day').toLowerCase()] ?? 'DAY';
	const first = Number(relative.first ?? 0);
	const last = Number(relative.last ?? 0);
	const approximate = String(relative.periodType).toLowerCase() === 'second';
	const neg = (n) => (n === 0 ? 0 : -n);
	if (first === last) return { range: { dateTimeRangeType: 'INTERVAL_OFFSET', interval, offset: neg(first), count: 0 }, approximate };
	if (last <= 0) return { range: { dateTimeRangeType: 'ROLLING_PERIOD', interval, count: last - first + 1, offset: neg(last) }, approximate };
	if (first >= 0) return { range: { dateTimeRangeType: 'ROLLING_PERIOD', interval, count: -(last - first + 1), offset: neg(first) }, approximate };
	return { range: { dateTimeRangeType: 'ROLLING_PERIOD', interval, count: 1 - first, offset: 0 }, approximate: true };
}

function relativeFilter(filter, binding, ctx, out) {
	const label = fieldLabel(filter, binding);
	if (binding.kind !== 'column') {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.relative-date', `Relative date filter on calculated field ${label} is not supported; skipped`));
		out.approximate = true;
		return;
	}
	if (out.dateRangeFilter) {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.relative-date', `Only one date range filter fits a Domo card; the one on ${label} was skipped`));
		out.approximate = true;
		return;
	}
	const { range, approximate } = relativeDateRange(filter.relative ?? { periodType: 'day', first: 0, last: 0 });
	out.dateRangeFilter = { column: { column: binding.column, exprType: 'COLUMN' }, dateTimeRange: range };
	if (CALENDAR_INTERVALS.has(range.interval)) out.calendarUses.push({ name: label, startMonth: binding.fiscalYearStart ?? 1 });
	if (approximate) out.approximate = true;
	if (filter.relative?.anchor) {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.relative-anchor', `Relative date filter on ${label} is anchored to ${filter.relative.anchor} in Tableau; Domo is relative to today`));
		out.approximate = true;
	}
	if (range.dateTimeRangeType === 'ROLLING_PERIOD') {
		out.issues.push(makeIssue(ctx, 'info', 'filter.relative-date', `Relative date filter on ${label} mapped to ROLLING_PERIOD (offset 0 counts the current partial period)`));
	}
}

function wildcardFilter(filter, binding, ctx, out) {
	const w = filter.wildcard;
	if (!w || w.pattern === undefined || w.pattern === '') return;
	const operand = WILDCARD_OPERANDS[w.mode] ?? 'CONTAINS';
	out.filters.push({ ...filterRef(binding), operand, values: [String(w.pattern)], dataType: 'string' });
}

function resolveCount(raw, parameters) {
	if (typeof raw === 'number') return raw;
	const s = String(raw ?? '').trim();
	if (/^-?\d+$/.test(s)) return Number(s);
	const param = (parameters ?? []).find((p) => p.id === s || `[Parameters].${s}` === p.id || stripBrackets(p.id.split('].[').pop() ?? '') === stripBrackets(s));
	const n = Number(param?.value);
	return Number.isFinite(n) ? n : undefined;
}

/** Parse a Top N 'by' expression such as SUM([Sales]) into an aggregation and a field id. */
export function parseTopBy(expression) {
	const m = /^\s*([A-Za-z]+)\s*\(\s*(\[(?:[^\]]|\]\])+\])\s*\)\s*$/.exec(String(expression ?? ''));
	if (m) return { agg: m[1].toLowerCase(), fieldId: m[2] };
	const f = /^\s*(\[(?:[^\]]|\]\])+\])\s*$/.exec(String(expression ?? ''));
	if (f) return { agg: 'user', fieldId: f[1] };
	return null;
}

function topFilter(filter, bindings, binding, ctx, out) {
	const label = fieldLabel(filter, binding);
	const top = filter.top ?? {};
	const count = resolveCount(top.count, ctx.parameters);
	if (!count || count < 1) {
		out.issues.push(makeIssue(ctx, 'warning', 'filter.top', `Top N filter on ${label} has a count that could not be resolved; skipped`));
		out.approximate = true;
		return;
	}
	if (top.rankColumn) {
		out.filters.push({ column: top.rankColumn, filterType: 'COLUMN_ID', operand: LTE, values: [count], dataType: 'numeric' });
		const how = top.direction === 'bottom' ? 'lowest' : 'highest';
		out.issues.push(makeIssue(ctx, 'info', 'filter.top-rank', `Top ${count} on ${label} keeps the members whose Magic ETL rank column '${top.rankColumn}' (by ${top.by}, ${how} first) is at most ${count}; Tableau ranks them before the dimension filters, as the dataflow does`));
		if (typeof top.count !== 'number' && !/^\s*\d+\s*$/.test(String(top.count))) {
			out.issues.push(makeIssue(ctx, 'info', 'filter.top-parameter', `Top N count of ${label} comes from a parameter; the card keeps its current value ${count}`));
		}
		return;
	}
	const by = parseTopBy(top.by);
	const order = top.direction === 'bottom' ? 'ASCENDING' : 'DESCENDING';
	let orderBy;
	if (by) {
		const ds = filter.datasourceId || ctx.datasourceId;
		const measure = bindings?.get?.(ds, by.fieldId);
		if (measure && measure.kind !== 'unsupported' && (!ctx.datasetKey || !measure.datasetKey || measure.datasetKey === ctx.datasetKey)) {
			orderBy = measure.aggregated ? { ...refOf(measure), order } : topOrderEntry(measure, by, order, ctx);
			if (!orderBy) {
				out.issues.push(makeIssue(ctx, 'warning', 'filter.top', `Top N on ${label} ranks by ${top.by}, which the card cannot rank by; skipped`));
				out.approximate = true;
				return;
			}
			if (orderBy.note) {
				out.issues.push(makeIssue(ctx, 'warning', 'filter.top', `Top N on ${label} ranks by ${top.by}; ${orderBy.note}`));
				out.approximate = true;
				delete orderBy.note;
			}
		}
	}
	out.tops.push({ count, direction: top.direction === 'bottom' ? 'bottom' : 'top', orderBy, fieldId: filter.fieldId, by: top.by });
}

function topOrderEntry(measure, by, order, ctx) {
	const numeric = filterDataType(measure) === 'numeric';
	const formula = HAVING_FORMULAS[by.agg];
	if (formula) {
		const expr = bindingExpression(measure);
		if (!expr || !ctx.addFormula) return undefined;
		const id = ctx.addFormula({ name: `${formula.label} of ${measure.name ?? stripBrackets(by.fieldId)}`, formula: formula.wrap(expr), dataType: 'numeric', aggregated: true });
		return { ...cardFormulaRef(id), formulaId: id, order };
	}
	const agg = TOP_AGGREGATIONS[by.agg];
	if (agg && (numeric || agg === 'COUNT' || agg === 'MIN' || agg === 'MAX')) return { ...refOf(measure), order, aggregation: agg };
	if (!numeric) return undefined;
	const entry = { ...refOf(measure), order, aggregation: 'SUM' };
	if (by.agg !== 'user') entry.note = 'ranked by SUM instead';
	return entry;
}

/**
 * Convert worksheet filters into Domo card subscription filters, a date range filter and Top N specs.
 *
 * @param {FilterIR[]} filters
 * @param {FieldBindings} bindings
 * @param {FilterContext} ctx
 * @returns {{ filters: Object[], dateRangeFilter?: Object, tops: TopSpec[], issues: Issue[], approximate: boolean, having?: boolean, origins: { filter: FilterIR, filters: Object[] }[], calendarUses: CalendarUse[] }}
 *   having: an aggregate filter runs as HAVING; origins: the card filters of each ctx.trackPillIds filter; calendarUses:
 *   the date range filter when its periods follow the card's (fiscal or calendar) Domo calendar
 */
export function toCardFilters(filters, bindings, ctx = {}) {
	const out = { filters: [], dateRangeFilter: undefined, tops: [], issues: [], approximate: false, memberLists: [], origins: [], calendarUses: [] };
	for (const filter of filters ?? []) {
		if (/Measure Names/i.test(filter.fieldId ?? '')) continue;
		const { binding, problem } = resolveBinding(filter, bindings, ctx);
		// A quick filter control cannot hold an aggregate or Top N filter, so it stays on the card.
		if (ctx.skipPillIds?.has(filter.pillId) && filter.kind !== 'top' && !(binding && (isAggregateFilter(filter, binding) || hasMemberRanges(filter)))) continue;
		if (!binding) {
			out.issues.push(makeIssue(ctx, 'warning', 'filter.unsupported-field', `Filter on ${stripBrackets(filter.fieldId)} ${problem}; skipped`));
			out.approximate = true;
			continue;
		}
		if (filter.context) {
			out.issues.push(makeIssue(ctx, 'info', 'filter.context', `Context filter on ${fieldLabel(filter, binding)} applied as a regular card filter`));
		}
		const before = out.filters.length;
		switch (filter.kind) {
			case 'categorical':
				categoricalFilters(filter, binding, ctx, out, bindings);
				break;
			case 'quantitative':
			case 'range-date':
				rangeFilters(filter, binding, ctx, out);
				break;
			case 'relative-date':
				relativeFilter(filter, binding, ctx, out);
				break;
			case 'top':
				topFilter(filter, bindings, binding, ctx, out);
				break;
			case 'wildcard':
				wildcardFilter(filter, binding, ctx, out);
				break;
			case 'condition':
				out.issues.push(
					makeIssue(ctx, 'warning', 'filter.condition', `Condition filter on ${fieldLabel(filter, binding)} (${filter.expression ?? ''}) is not converted`, 'Recreate it as a beast mode filter in Analyzer.')
				);
				out.approximate = true;
				break;
			default:
				out.issues.push(makeIssue(ctx, 'warning', 'filter.unsupported', `Filter kind ${filter.kind} on ${fieldLabel(filter, binding)} is not converted`));
				out.approximate = true;
		}
		if (out.filters.length > before && (isAggregateFilter(filter, binding) || isAttrMarkFilter(filter, binding, ctx))) out.having = true;
		if (ctx.trackPillIds?.has(filter.pillId)) out.origins.push({ filter, filters: out.filters.slice(before) });
	}
	fitMemberLists(out, ctx);
	delete out.memberLists;
	return out;
}

const DISPLAY_BY_MODE = {
	radiolist: 'single_select',
	dropdown: 'single_select_dropdown',
	checklist: 'multiple_select',
	checkdropdown: 'multiple_select',
	compact: 'single_select_dropdown',
	typein: 'match_values_text_input',
	type_in: 'match_values_text_input',
	pattern: 'match_values_text_input',
	wildcard: 'match_values_text_input'
};

function controlType(binding) {
	const dt = filterDataType(binding);
	if (dt === 'numeric') return 'numeric';
	if (dt === 'date' || dt === 'datetime') return 'date';
	return 'string';
}

/**
 * Card quick filters (`definition.controls[]`, SLICER) for filters Tableau shows as interactive controls.
 * The current selection becomes the control's default values.
 *
 * @param {FilterIR[]} filters
 * @param {FieldBindings} bindings
 * @param {FilterContext & { dataSourceId: any, modes?: Map<string,string>, maxSlicers?: number }} ctx  dataSourceId is the dataset $ref
 * @returns {{ controls: Object[], issues: Issue[], pillIds: Set<string>, sources: string[][] }}  pillIds: the filters a control (or an
 *   earlier one on the same column) covers; sources: the pill ids of each control's filters
 */
export function toQuickFilterControls(filters, bindings, ctx = {}) {
	const controls = [];
	const sources = [];
	const issues = [];
	const seen = new Map();
	const pillIds = new Set();
	for (const filter of filters ?? []) {
		if (/Measure Names/i.test(filter.fieldId ?? '')) continue;
		const { binding, problem } = resolveBinding(filter, bindings, ctx);
		const label = fieldLabel(filter, binding);
		if (!binding) {
			issues.push(makeIssue(ctx, 'warning', 'filter.unsupported-field', `Quick filter on ${label} ${problem}; skipped`));
			pillIds.add(filter.pillId);
			continue;
		}
		if (isAggregateFilter(filter, binding)) {
			issues.push(makeIssue(ctx, 'info', 'filter.aggregate', `Quick filter on aggregate ${label} has no Domo control; its current selection is kept as a fixed card filter`));
			continue;
		}
		// ATTR of a dimension filters like the dimension itself, so only other aggregate kinds are dropped.
		if (binding.aggregated || (filter.aggregated && filter.kind !== 'categorical')) {
			issues.push(makeIssue(ctx, 'warning', 'filter.aggregate', `Quick filter on aggregate ${label} is not supported; skipped`));
			pillIds.add(filter.pillId);
			continue;
		}
		if (keepsSetMembers(filter, binding)) {
			issues.push(makeIssue(ctx, 'info', 'filter.set-members', `Quick filter on set ${label} keeps the set's members, which a control cannot hold; it is a fixed card filter`));
			continue;
		}
		if (isAttrMarkFilter(filter, binding, ctx)) {
			issues.push(makeIssue(ctx, 'warning', 'filter.attr', `Quick filter on ATTR(${label}) filters rows in Domo; Tableau drops a mark whose rows hold several values ('*'), Domo keeps its selected rows`));
		}
		const key = `${binding.formulaId ?? binding.column}`;
		if (!seen.has(key) && controls.length >= (ctx.maxSlicers ?? MAX_SLICERS)) {
			issues.push(makeIssue(ctx, 'warning', 'filter.slicer-count', `Quick filter on ${label}: a Domo card holds at most ${MAX_SLICERS} quick filters, so its selection is kept as a fixed card filter without a control`));
			continue;
		}
		const type = controlType(binding);
		const mode = ctx.modes?.get(filter.pillId);
		let displayType = DISPLAY_BY_MODE[mode] ?? (type === 'numeric' ? 'numeric_range' : type === 'date' ? 'date_range' : 'multiple_select');
		let operator = 'IN';
		let values = [];
		if (filter.kind === 'categorical') {
			if (!filter.all) values = selectedMembers(filter).map((v) => memberValue(v, type, binding));
			if (filter.exclude && !filter.include) operator = 'NOT_IN';
			if (hasMemberRanges(filter)) {
				values = [];
				issues.push(makeIssue(ctx, 'info', 'filter.member-range', `Quick filter on ${label} selects a range of members, which a control cannot hold; the control starts unfiltered and the selection is kept as a fixed card filter`));
			} else if (values.length && !filter.all && (filter.include ?? []).some((v) => v === null)) {
				// Without the Null member the default would drop the null rows Tableau keeps.
				values = [];
				issues.push(makeIssue(ctx, 'info', 'filter.null-default', `Quick filter on ${label} selects the Null member, which a Domo filter cannot hold; the control starts with every value (Tableau shows "All" for such a selection when it holds every member)`));
			}
			if (mode === 'slider' && type === 'string') displayType = 'single_select_dropdown';
			if (displayType === 'match_values_text_input') {
				if (values.length || operator !== 'IN' || mode === 'typein' || mode === 'type_in') displayType = 'multiple_select';
				else operator = 'CONTAINS';
			}
		} else if (filter.kind === 'quantitative' || filter.kind === 'range-date') {
			displayType = type === 'date' ? 'date_range' : 'numeric_range';
			operator = 'BETWEEN';
			const min = stringValue(filter.min, type);
			const max = stringValue(filter.max, type);
			if (min !== undefined && max !== undefined) values = [min, max];
			else if (min !== undefined) {
				operator = GTE;
				values = [min];
			} else if (max !== undefined) {
				operator = LTE;
				values = [max];
			}
		} else if (filter.kind === 'relative-date') {
			displayType = 'date_range';
			operator = 'BETWEEN';
			issues.push(makeIssue(ctx, 'info', 'filter.relative-date', `Quick filter on ${label}: the relative date default is not carried into the control`));
		} else if (filter.kind === 'wildcard') {
			displayType = 'match_values_text_input';
			operator = WILDCARD_OPERANDS[filter.wildcard?.mode] ?? 'CONTAINS';
			values = filter.wildcard?.pattern ? [String(filter.wildcard.pattern)] : [];
		}
		if (values.length > MAX_SLICER_VALUES) {
			issues.push(
				makeIssue(
					ctx,
					'warning',
					'filter.slicer-limit',
					`Quick filter on ${label}: ${values.length} selected values exceed Domo's ${MAX_SLICER_VALUES}, so the control starts unfiltered and the selection is kept as a fixed card filter that viewers cannot clear`
				)
			);
			values = [];
		}
		const control = {
			controlType: 'SLICER',
			column: binding.kind === 'formula' ? binding.formulaId : binding.column,
			name: label,
			columnDisplayName: label,
			type,
			displayType,
			operator,
			values,
			collapsed: false,
			dataSourceId: ctx.dataSourceId
		};
		if (binding.kind === 'formula') control.formulaId = binding.formulaId;
		const prior = seen.get(key);
		if (prior) {
			if (mergeSelection(prior.control, control)) {
				pillIds.add(filter.pillId);
				prior.sources.push(filter.pillId);
			}
			continue;
		}
		seen.set(key, { control, sources: [filter.pillId] });
		pillIds.add(filter.pillId);
		controls.push(control);
		sources.push(seen.get(key).sources);
	}
	return { controls, issues, pillIds, sources };
}

/**
 * Fold a second filter on a control's column into its default: a selection wins over none, and two member lists
 * intersect. False when they cannot be combined, so the second stays a fixed card filter.
 */
function mergeSelection(control, other) {
	if (!other.values.length) return true;
	if (!control.values.length) {
		control.values = other.values;
		control.operator = other.operator;
		return true;
	}
	if (control.operator !== other.operator) return false;
	if (control.operator === 'IN') {
		const both = control.values.filter((v) => other.values.includes(v));
		if (!both.length) return false;
		control.values = both;
		return true;
	}
	if (control.operator === 'NOT_IN') {
		control.values = [...new Set([...control.values, ...other.values])];
		return true;
	}
	return JSON.stringify(control.values) === JSON.stringify(other.values);
}
