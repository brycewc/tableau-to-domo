import { parseFormula } from './calc/parser.js';
import { stripBrackets } from '../model/naming.js';
import { parsePillId } from '../tableau/twb/shelf.js';
import { slugify } from '../util/ids.js';

const YEAR = /^(fy|fiscal[ _]?year|year|yr)$/i;
const QUARTER = /^(fq|fiscal[ _]?quarter|quarter|qtr|q)$/i;
const SELF_AGG = /^\s*(COUNTD|COUNT|MAX|MIN|ATTR)\s*\(\s*(\[[^\]]+\])\s*\)\s*$/i;
const DATE_TYPES = /^date(time)?$/i;
const UNITS = { year: 'year', yyyy: 'year', yy: 'year', quarter: 'quarter', qq: 'quarter', q: 'quarter', month: 'month', mm: 'month', m: 'month', week: 'week', ww: 'week', day: 'day', dd: 'day', d: 'day' };
const RANKS = /^RANK(_DENSE|_UNIQUE|_MODIFIED)?$/;
const COMPARE = { '<': 'lt', '<=': 'le', '=': 'eq', '==': 'eq', '>': 'gt', '>=': 'ge' };
const FLIP = { lt: 'gt', le: 'ge', eq: 'eq', gt: 'lt', ge: 'le' };

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').Issue} Issue
 */

function fieldRefs(node, out = new Set()) {
	if (!node || typeof node !== 'object') return out;
	if (node.type === 'Field') out.add(node.id);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) value.forEach((v) => fieldRefs(v, out));
		else if (value && typeof value === 'object') fieldRefs(value, out);
	}
	return out;
}

function parse(formula) {
	try {
		return parseFormula(formula);
	} catch {
		return undefined;
	}
}

const findIn = (ds, id) => ds.fields.find((f) => f.id === id || f.name === stripBrackets(id));

/** The year and quarter fields a calc joins into one period label, e.g. str([FY]) + "-" + str([FQ]). */
function yearQuarterOf(ds, field) {
	if (field?.kind !== 'calculated' || !field.formula) return undefined;
	const ast = parse(field.formula);
	if (!ast) return undefined;
	const refs = [...fieldRefs(ast)].map((id) => findIn(ds, id));
	if (refs.length !== 2 || refs.some((f) => !f || f.kind === 'calculated')) return undefined;
	const year = refs.find((f) => YEAR.test(f.caption ?? f.name));
	const quarter = refs.find((f) => QUARTER.test(f.caption ?? f.name));
	return year && quarter ? { year, quarter } : undefined;
}

const digits = (field, strip) => `TRIM(REPLACE(UPPER(STR(${field.id})), "${strip}", ""))`;
const firstMonth = (quarter) => `CASE ${digits(quarter, 'Q')} WHEN "1" THEN 1 WHEN "2" THEN 4 WHEN "3" THEN 7 WHEN "4" THEN 10 END`;

const isDateColumn = (field) => field?.kind === 'column' && DATE_TYPES.test(String(field.datatype ?? ''));

function pillPeriod(pillId) {
	const pill = parsePillId(pillId);
	if (pill.dateTrunc) return UNITS[pill.dateTrunc];
	if (pill.datePart) return pill.datePart === 'year' ? 'year' : undefined;
	return 'day';
}

const unwrap = (node) => (node?.type === 'Paren' ? unwrap(node.expr) : node);

function numberOf(node) {
	const n = unwrap(node);
	if (n?.type === 'Literal' && n.valueType === 'number') return Number(n.value);
	if (n?.type === 'Unary' && n.op === '-') {
		const v = numberOf(n.operand);
		return v === undefined ? undefined : -v;
	}
	return undefined;
}

function dateOf(ds, node) {
	const n = unwrap(node);
	if (n?.type === 'Field') {
		const field = findIn(ds, n.id);
		return isDateColumn(field) ? field : undefined;
	}
	if (n?.type === 'Call' && /^(DATETRUNC|DATE)$/.test(n.name)) return dateOf(ds, n.args.at(-1));
	return undefined;
}

/** 'today' for TODAY()/NOW(), 'data' for the latest value of `date` in the data ({MAX([d])}, WINDOW_MAX, TOTAL). */
function anchorOf(node, date) {
	const n = unwrap(node);
	if (n?.type === 'Call' && /^(TODAY|NOW)$/.test(n.name) && !n.args.length) return 'today';
	const isMax = (m) => m?.type === 'Call' && m.name === 'MAX' && m.args.length === 1 && unwrap(m.args[0])?.type === 'Field' && unwrap(m.args[0]).id === date.id;
	if (n?.type === 'Lod' && !(n.dims ?? []).length && isMax(unwrap(n.body))) return 'data';
	if (n?.type === 'Call' && /^(WINDOW_MAX|TOTAL)$/.test(n.name) && n.args.length === 1 && isMax(unwrap(n.args[0]))) return 'data';
	if (n?.type === 'Call' && /^(DATETRUNC|DATE)$/.test(n.name)) return anchorOf(n.args.at(-1), date);
	return undefined;
}

// RANK(MAX([d])) is 1 for the latest period, which is 0 periods back: `offset` 1.
function periodsBack(ds, ws, node) {
	const n = unwrap(node);
	if (n?.type !== 'Call') return undefined;
	if (n.name === 'DATEDIFF' && n.args.length >= 3) {
		const unitNode = unwrap(n.args[0]);
		const unit = unitNode?.type === 'Literal' ? UNITS[String(unitNode.value).toLowerCase()] : undefined;
		if (!unit) return undefined;
		const forward = dateOf(ds, n.args[1]);
		const backward = dateOf(ds, n.args[2]);
		if (forward) {
			const anchor = anchorOf(n.args[2], forward);
			return anchor ? { date: forward, unit, anchor, sign: 1, offset: 0 } : undefined;
		}
		if (backward) {
			const anchor = anchorOf(n.args[1], backward);
			return anchor ? { date: backward, unit, anchor, sign: -1, offset: 0 } : undefined;
		}
		return undefined;
	}
	if (RANKS.test(n.name) && n.args.length >= 1) {
		const order = unwrap(n.args[1]);
		if (order && !(order.type === 'Literal' && /^desc$/i.test(String(order.value)))) return undefined;
		const agg = unwrap(n.args[0]);
		if (agg?.type !== 'Call' || !/^(MAX|MIN|ATTR)$/.test(agg.name)) return undefined;
		const date = dateOf(ds, agg.args[0]);
		if (!date) return undefined;
		const shown = Object.values(ws.pills ?? {}).filter((p) => p.fieldId === date.id && p.datasourceId === ds.id).map((p) => pillPeriod(p.id));
		const unit = shown.length === 1 ? shown[0] : undefined;
		return unit ? { date, unit, anchor: 'data', sign: 1, offset: 1 } : undefined;
	}
	return undefined;
}

function boundsOf(ds, ws, node) {
	const n = unwrap(node);
	if (n?.type === 'Binary' && /^and$/i.test(n.op)) {
		const a = boundsOf(ds, ws, n.left);
		const b = boundsOf(ds, ws, n.right);
		if (!a || !b || a.term.date !== b.term.date || a.term.unit !== b.term.unit || a.term.anchor !== b.term.anchor) return undefined;
		return { term: a.term, lo: Math.max(a.lo ?? -Infinity, b.lo ?? -Infinity), hi: Math.min(a.hi ?? Infinity, b.hi ?? Infinity), approximate: a.approximate || b.approximate };
	}
	if (n?.type !== 'Binary' || !COMPARE[n.op]) return undefined;
	const dated = dateAddBounds(ds, n);
	if (dated) return dated;
	let op = COMPARE[n.op];
	let term = periodsBack(ds, ws, n.left);
	let value = numberOf(n.right);
	if (!term) {
		term = periodsBack(ds, ws, n.right);
		value = numberOf(n.left);
		op = FLIP[op];
	}
	if (!term || value === undefined || !Number.isInteger(value)) return undefined;
	if (term.sign < 0) {
		op = FLIP[op];
		value = -value;
	}
	value -= term.offset;
	const bound = { lt: { hi: value - 1 }, le: { hi: value }, eq: { lo: value, hi: value }, gt: { lo: value + 1 }, ge: { lo: value } }[op];
	return { term, ...bound };
}

function dateAddBounds(ds, n) {
	let op = COMPARE[n.op];
	let date = dateOf(ds, n.left);
	let other = unwrap(n.right);
	if (!date) {
		date = dateOf(ds, n.right);
		other = unwrap(n.left);
		op = FLIP[op];
	}
	if (!date || other?.type !== 'Call' || other.name !== 'DATEADD' || !['gt', 'ge'].includes(op)) return undefined;
	const unitNode = unwrap(other.args[0]);
	const unit = unitNode?.type === 'Literal' ? UNITS[String(unitNode.value).toLowerCase()] : undefined;
	const amount = numberOf(other.args[1]);
	const anchor = anchorOf(other.args[2], date);
	if (!unit || !anchor || amount === undefined || amount > 0) return undefined;
	return { term: { date, unit, anchor }, lo: 0, hi: op === 'gt' && unit === 'day' ? -amount - 1 : -amount, approximate: unit !== 'day' };
}

const isTrue = (v) => v === true || v === 'true' || v === 'True';
const isFalse = (v) => v === false || v === 'false' || v === 'False';

function calcWindow(ds, ws, filter, field) {
	if (filter.kind !== 'categorical' || filter.shownOnDashboard || field?.kind !== 'calculated' || !field.formula) return undefined;
	const keepsTrue = (filter.include?.length === 1 && isTrue(filter.include[0]) && !filter.exclude?.length) || (filter.exclude?.length === 1 && isFalse(filter.exclude[0]) && !filter.include?.length);
	if (!keepsTrue) return undefined;
	const ast = parse(field.formula);
	const bounds = ast && boundsOf(ds, ws, ast);
	if (!bounds || !Number.isFinite(bounds.hi)) return undefined;
	const lo = Number.isFinite(bounds.lo) ? Math.max(bounds.lo, 0) : 0;
	if (bounds.hi < lo) return undefined;
	return { ...bounds, lo };
}

/**
 * Filters that only keep recent periods become relative date filters (docs/ARCHITECTURE.md, Date windows). Mutates nothing.
 * @param {WorkbookIR} ir
 * @returns {{ ir: WorkbookIR, issues: Issue[] }}
 */
export function periodTopFilters(ir) {
	const added = new Map();
	const issues = [];
	const dateFieldFor = (ds, field) => {
		const key = `${ds.id}\u0000${field.id}`;
		if (added.has(key)) return added.get(key);
		const parts = yearQuarterOf(ds, field);
		if (!parts) return undefined;
		const name = `${field.caption ?? field.name} Quarter Start`;
		const date = {
			id: `[t2d_${slugify(field.name).replace(/-/g, '_')}_quarter_start]`,
			name,
			caption: name,
			datatype: 'date',
			role: 'dimension',
			type: 'ordinal',
			kind: 'calculated',
			periodDate: true,
			formula: `MAKEDATE(${digits(parts.year, 'FY')}, ${firstMonth(parts.quarter)}, 1)`
		};
		added.set(key, date);
		return date;
	};
	const note = (ws, severity, code, message) => issues.push({ severity, code, message, object: { type: 'worksheet', name: ws.name } });
	const latestNote = (unit, count) =>
		`Tableau keeps the latest ${count} ${unit}s in the data and Domo counts back from today, so this keeps the ${count} ${unit}s before the current one (the data's latest ${unit} taken as the last complete one; set the card date range offset to 0 if the data has the current ${unit})`;
	const topWindow = (ws, filter, ds) => {
		if (filter.kind !== 'top' || filter.top?.direction === 'bottom' || typeof filter.top?.count !== 'number' || filter.top.count < 1) return undefined;
		const self = SELF_AGG.exec(String(filter.top.by ?? ''));
		if (!self || self[2] !== filter.fieldId) return undefined;
		const field = ds.fields.find((f) => f.id === filter.fieldId);
		const label = dateFieldFor(ds, field);
		const unit = label ? 'quarter' : isDateColumn(field) ? pillPeriod(filter.pillId) : undefined;
		if (!unit) return undefined;
		const count = filter.top.count;
		const how = /^COUNT$/i.test(self[1]) ? `ranks ${unit}s by their row count, which only a hand-picked list of the latest ${unit}s on the filter turns into a date window` : `orders the ${unit}s by date`;
		const target = label ? ` on '${label.name}' (the first day of each quarter, computed in Magic ETL)` : '';
		note(ws, /^COUNT$/i.test(self[1]) ? 'warning' : 'info', 'filter.period-top', `Top ${count} on ${field.name} by ${self[1].toUpperCase()} ${how}; it is a relative date filter${target}. ${latestNote(unit, count)}`);
		const date = label ?? field;
		const pillId = label ? `[${ds.id}].[none:${stripBrackets(label.id)}:ok]` : filter.pillId;
		return { pillId, fieldId: date.id, relative: { periodType: unit, first: -count, last: -1 } };
	};
	const booleanWindow = (ws, filter, ds) => {
		const field = ds.fields.find((f) => f.id === filter.fieldId);
		const window = calcWindow(ds, ws, filter, field);
		if (!window) return undefined;
		const { term, lo, hi, approximate } = window;
		const shift = term.anchor === 'data' ? 1 : 0;
		const count = hi - lo + 1;
		const text = term.anchor === 'data' ? ` ${latestNote(term.unit, count)}` : '';
		const rounding = approximate ? ` Tableau's window runs to the day; Domo keeps whole ${term.unit}s.` : '';
		note(ws, term.anchor === 'data' || approximate ? 'warning' : 'info', 'filter.date-window', `'${field.name}' only keeps a window of ${term.unit}s of ${term.date.name}; it is a relative date filter on ${term.date.name} and the calc is not built.${text}${rounding}`);
		return { pillId: `[${ds.id}].[none:${stripBrackets(term.date.id)}:nk]`, fieldId: term.date.id, relative: { periodType: term.unit, first: 0 - hi - shift, last: 0 - lo - shift } };
	};
	const worksheets = (ir.worksheets ?? []).map((ws) => {
		let changed = false;
		const filters = (ws.filters ?? []).map((filter) => {
			const ds = (ir.datasources ?? []).find((d) => d.id === (filter.datasourceId || ws.datasourceIds?.[0]));
			if (!ds?.fields) return filter;
			const window = topWindow(ws, filter, ds) ?? booleanWindow(ws, filter, ds);
			if (!window) return filter;
			changed = true;
			const rest = { ...filter };
			for (const key of ['top', 'include', 'exclude', 'all']) delete rest[key];
			return { ...rest, ...window, kind: 'relative-date' };
		});
		return changed ? { ...ws, filters } : ws;
	});
	if (!issues.length) return { ir, issues };
	const byDs = new Map();
	for (const [key, field] of added) {
		const dsId = key.split('\u0000')[0];
		byDs.set(dsId, [...(byDs.get(dsId) ?? []), field]);
	}
	const datasources = (ir.datasources ?? []).map((ds) => (byDs.has(ds.id) ? { ...ds, fields: [...ds.fields, ...byDs.get(ds.id)] } : ds));
	return { ir: { ...ir, datasources, worksheets }, issues };
}
