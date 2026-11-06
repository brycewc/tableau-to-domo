import { PREC, NULL_VALUE, wrap, fn, quoteString, isNumeric, isDateType, unifyTypes, ignoresCase } from './sql.js';
import { icuToMysqlFormat } from './dates.js';

const WEEKDAYS = { sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7 };

/** Tableau weekday index (1..7) of `d` for a week starting on `start` (1 = Sunday). */
function dow(d, start) {
	if (start === 1) return { sql: `DAYOFWEEK(${d})`, prec: PREC.PRIMARY };
	return { sql: `MOD(DAYOFWEEK(${d}) + ${7 - start}, 7) + 1`, prec: PREC.ADD };
}

function boolToNumber(em, x, one, zero, type) {
	if (x.constant) return em.out(x.constant.value === null ? NULL_VALUE : x.constant.value ? one : zero, type);
	return em.out(`CASE WHEN ${x.sql} THEN ${one} WHEN ${em.not(x).sql} THEN ${zero} END`, type);
}

/** Days since the start of the week containing `d` (0..6). */
function daysIntoWeek(d, start) {
	if (start === 1) return { sql: `DAYOFWEEK(${d}) - 1`, prec: PREC.ADD };
	return { sql: `MOD(DAYOFWEEK(${d}) + ${7 - start}, 7)`, prec: PREC.PRIMARY };
}

const yearStart = (d) => `DATE_SUB(DATE(${d}), INTERVAL (DAYOFYEAR(${d}) - 1) DAY)`;

const castDecimal = (em, sql) => (em.mode === 'etl' ? `CAST(${sql} AS DECIMAL)` : `CAST(${sql} AS DECIMAL(38, 10))`);

/** Interval value for DATE_ADD: anything looser than a primary needs parentheses. */
const intervalValue = (r) => (r.prec >= PREC.PRIMARY || /^-?\d+(\.\d+)?$/.test(r.sql) ? r.sql : `(${r.sql})`);

function datePart(em, c, part, d, start) {
	const dsql = d.sql;
	switch (part) {
		case 'year':
			return em.out(`YEAR(${dsql})`, 'integer');
		case 'quarter':
			return em.out(`QUARTER(${dsql})`, 'integer');
		case 'month':
			return em.out(`MONTH(${dsql})`, 'integer');
		case 'day':
			return em.out(`DAY(${dsql})`, 'integer');
		case 'dayofyear':
			return em.out(`DAYOFYEAR(${dsql})`, 'integer');
		case 'hour':
			return em.out(`HOUR(${dsql})`, 'integer');
		case 'minute':
			return em.out(`MINUTE(${dsql})`, 'integer');
		case 'second':
			return em.out(`SECOND(${dsql})`, 'integer');
		case 'weekday': {
			const w = dow(dsql, start);
			return em.out(w.sql, 'integer', w.prec);
		}
		case 'week': {
			// Tableau week 1 is the week containing Jan 1; MySQL WEEK() modes number it 0 or by a 4-day rule.
			const jan1 = dow(yearStart(dsql), start);
			return em.out(`FLOOR((DAYOFYEAR(${dsql}) + ${jan1.sql} - 2) / 7) + 1`, 'integer', PREC.ADD);
		}
		case 'iso-week':
			return em.out(`WEEK(${dsql}, 3)`, 'integer');
		case 'iso-year':
			return em.out(`FLOOR(YEARWEEK(${dsql}, 3) / 100)`, 'integer');
		case 'iso-weekday':
			return em.out(`WEEKDAY(${dsql}) + 1`, 'integer', PREC.ADD);
		case 'iso-quarter':
			return em.out(`CASE WHEN WEEK(${dsql}, 3) >= 40 THEN 4 ELSE FLOOR((WEEK(${dsql}, 3) - 1) / 13) + 1 END`, 'integer');
		default:
			em.issue('error', 'calc.date-part', `Unsupported date part '${part}' in ${c.name}`);
			return em.out(fn(c.name, quoteString(part), dsql), 'integer');
	}
}

function datePartArg(em, c, index = 0) {
	const part = em.lit(c, index);
	if (typeof part !== 'string') {
		em.issue('error', 'calc.date-part', `${c.name} needs a literal date part as argument ${index + 1}`);
		return null;
	}
	return part.trim().toLowerCase();
}

function weekStart(em, c, index) {
	if (c.args.length > index) {
		const value = em.lit(c, index);
		const start = typeof value === 'string' ? WEEKDAYS[value.trim().toLowerCase()] : undefined;
		if (start) return start;
		em.issue('warning', 'calc.week-start', `${c.name} start_of_week must be a literal weekday name; Sunday assumed`);
		return 1;
	}
	return WEEKDAYS[String(em.ctx.weekStart ?? 'sunday').toLowerCase()] || 1;
}

/** A date without time; `DATE()` of it is the same value. */
function dateOnly(r) {
	r.dateOnly = true;
	return r;
}

/** `base` (a first of month) plus `months`; month offsets of it add up exactly, so DATEADDs fold into one DATE_ADD. */
function monthStart(em, base, offset) {
	const months = offset?.value === 0 ? null : offset;
	const sql = months ? `DATE_ADD(${base}, INTERVAL ${intervalValue(months)} MONTH)` : base;
	const r = dateOnly(em.out(sql, 'date'));
	r.monthStart = { base, months };
	return r;
}

const quarterMonths = (dsql) => ({ sql: `(QUARTER(${dsql}) - 1) * 3`, prec: PREC.MUL });

function dateTrunc(em, c, part, d, start) {
	const dsql = d.sql;
	switch (part) {
		case 'year':
			return monthStart(em, yearStart(dsql), null);
		case 'iso-year':
			em.issue('warning', 'calc.iso-date', 'DATETRUNC iso-year approximated with the calendar year');
			return monthStart(em, yearStart(dsql), null);
		case 'quarter':
			return monthStart(em, yearStart(dsql), quarterMonths(dsql));
		case 'iso-quarter':
			em.issue('warning', 'calc.iso-date', 'DATETRUNC iso-quarter approximated with the calendar quarter');
			return monthStart(em, yearStart(dsql), quarterMonths(dsql));
		case 'month':
			return monthStart(em, `DATE_SUB(DATE(${dsql}), INTERVAL (DAYOFMONTH(${dsql}) - 1) DAY)`, null);
		case 'week':
		case 'iso-week': {
			const w = daysIntoWeek(dsql, part === 'iso-week' ? 2 : start);
			return dateOnly(em.out(`DATE_SUB(DATE(${dsql}), INTERVAL ${w.prec >= PREC.PRIMARY ? w.sql : `(${w.sql})`} DAY)`, 'date'));
		}
		case 'day':
		case 'dayofyear':
		case 'weekday':
		case 'iso-weekday':
			return dateOnly(em.out(`DATE(${dsql})`, 'date'));
		case 'hour':
			return em.out(`DATE_ADD(DATE(${dsql}), INTERVAL HOUR(${dsql}) HOUR)`, 'datetime');
		case 'minute':
			return em.out(`DATE_ADD(DATE(${dsql}), INTERVAL (HOUR(${dsql}) * 60 + MINUTE(${dsql})) MINUTE)`, 'datetime');
		case 'second':
			return em.out(`DATE_ADD(DATE(${dsql}), INTERVAL TIME_TO_SEC(${dsql}) SECOND)`, 'datetime');
		default:
			em.issue('error', 'calc.date-part', `Unsupported date part '${part}' in DATETRUNC`);
			return em.out(fn('DATETRUNC', quoteString(part), dsql), 'date');
	}
}

const INTERVAL_UNITS = {
	quarter: 'QUARTER',
	'iso-quarter': 'QUARTER',
	month: 'MONTH',
	week: 'WEEK',
	'iso-week': 'WEEK',
	day: 'DAY',
	dayofyear: 'DAY',
	weekday: 'DAY',
	'iso-weekday': 'DAY',
	hour: 'HOUR',
	minute: 'MINUTE',
	second: 'SECOND'
};

const MONTHS_PER = { year: 12, 'iso-year': 12, quarter: 3, 'iso-quarter': 3, month: 1 };

/** Months `n` units of `part` span, as `{ sql, prec }`, folded for a constant `n`. */
function monthsOf(n, part) {
	const per = MONTHS_PER[part];
	if (typeof n.constant?.value === 'number') return { sql: String(n.constant.value * per), prec: PREC.PRIMARY, value: n.constant.value * per };
	return per === 1 ? n : { sql: `${wrap(n, PREC.MUL)} * ${per}`, prec: PREC.MUL };
}

function addMonths(months, more) {
	if (!months) return more;
	if (months.value !== undefined && more.value !== undefined) return { sql: String(months.value + more.value), prec: PREC.PRIMARY, value: months.value + more.value };
	if (more.value === 0) return months;
	if (more.value !== undefined) return { sql: `${wrap(months, PREC.ADD)} ${more.value < 0 ? '-' : '+'} ${Math.abs(more.value)}`, prec: PREC.ADD };
	return { sql: `${wrap(months, PREC.ADD)} + ${wrap(more, PREC.ADD + 1)}`, prec: PREC.ADD };
}

function dateAdd(em, part, n, d) {
	if (d.monthStart && MONTHS_PER[part] && n.type === 'integer') {
		return monthStart(em, d.monthStart.base, addMonths(d.monthStart.months, monthsOf(n, part)));
	}
	// Domo's grammar intervalTypeBase has no YEAR unit (BeastModeParser.g4), so years become months.
	if (part === 'year' || part === 'iso-year') {
		const r = em.out(`DATE_ADD(${d.sql}, INTERVAL (${wrap(n, PREC.MUL)} * 12) MONTH)`, d.type === 'datetime' ? 'datetime' : 'date');
		return d.dateOnly ? dateOnly(r) : r;
	}
	const unit = INTERVAL_UNITS[part];
	if (!unit) {
		em.issue('error', 'calc.date-part', `Unsupported date part '${part}' in DATEADD`);
		return em.out(fn('DATEADD', quoteString(part), n.sql, d.sql), 'datetime');
	}
	const timeUnit = unit === 'HOUR' || unit === 'MINUTE' || unit === 'SECOND';
	const r = em.out(`DATE_ADD(${d.sql}, INTERVAL ${intervalValue(n)} ${unit})`, timeUnit || d.type === 'datetime' ? 'datetime' : 'date');
	return d.dateOnly && !timeUnit ? dateOnly(r) : r;
}

/** Tableau DATEDIFF counts boundary crossings, unlike TIMESTAMPDIFF which counts whole elapsed units. */
function dateDiff(em, part, a, b, start) {
	const A = a.sql;
	const B = b.sql;
	const hours = `DATEDIFF(${B}, ${A}) * 24 + HOUR(${B}) - HOUR(${A})`;
	const minutes = `(${hours}) * 60 + MINUTE(${B}) - MINUTE(${A})`;
	switch (part) {
		case 'day':
		case 'dayofyear':
		case 'weekday':
		case 'iso-weekday':
			return em.out(`DATEDIFF(${B}, ${A})`, 'integer');
		case 'week':
		case 'iso-week': {
			const w = daysIntoWeek(A, part === 'iso-week' ? 2 : start);
			return em.out(`FLOOR((DATEDIFF(${B}, ${A}) + ${w.sql}) / 7)`, 'integer');
		}
		case 'month':
			return em.out(`(YEAR(${B}) - YEAR(${A})) * 12 + MONTH(${B}) - MONTH(${A})`, 'integer', PREC.ADD);
		case 'quarter':
			return em.out(`(YEAR(${B}) - YEAR(${A})) * 4 + QUARTER(${B}) - QUARTER(${A})`, 'integer', PREC.ADD);
		case 'iso-quarter':
			em.issue('warning', 'calc.iso-date', 'DATEDIFF iso-quarter approximated with calendar quarters');
			return em.out(`(YEAR(${B}) - YEAR(${A})) * 4 + QUARTER(${B}) - QUARTER(${A})`, 'integer', PREC.ADD);
		case 'year':
			return em.out(`YEAR(${B}) - YEAR(${A})`, 'integer', PREC.ADD);
		case 'iso-year':
			return em.out(`FLOOR(YEARWEEK(${B}, 3) / 100) - FLOOR(YEARWEEK(${A}, 3) / 100)`, 'integer', PREC.ADD);
		case 'hour':
			return em.out(hours, 'integer', PREC.ADD);
		case 'minute':
			return em.out(minutes, 'integer', PREC.ADD);
		case 'second':
			return em.out(`(${minutes}) * 60 + SECOND(${B}) - SECOND(${A})`, 'integer', PREC.ADD);
		default:
			em.issue('error', 'calc.date-part', `Unsupported date part '${part}' in DATEDIFF`);
			return em.out(fn('DATEDIFF', quoteString(part), A, B), 'integer');
	}
}

const numType = (t) => (t === 'integer' ? 'integer' : 'real');

/**
 * @param {{ min?: number, max?: number, prec?: number, fold?: (value: any) => any }} [opts]
 *   `fold` computes the result of a one-argument call on a string constant (null in, null out).
 */
function simple(name, type, { min = 0, max = Infinity, prec, fold } = {}) {
	return (c, em) => {
		em.arity(c, min, max);
		const args = em.args(c);
		const resolved = typeof type === 'function' ? type(args) : type;
		const value = fold && args[0]?.constant ? args[0].constant.value : undefined;
		const constant = value === null ? null : typeof value === 'string' ? fold(value) : undefined;
		return em.out(fn(name, ...args.map((a) => a.sql)), resolved, prec, undefined, constant);
	};
}

/**
 * Aggregate result of type `type`. Boolean arguments are aggregated as 'true'/'false' text (em.valueOf), which orders
 * and counts like Tableau booleans, so a boolean result is a predicate on that text.
 */
function aggResult(em, sql, type) {
	return type === 'boolean' ? { ...em.boolFromValue(sql), flags: { agg: true } } : em.aggOut(sql, type);
}

function aggregate(name, type, { distinct = false } = {}) {
	return (c, em) => {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0, { inAgg: true });
		const v = em.valueOf(x);
		const sql = em.agg(name, distinct ? `DISTINCT ${v.sql}` : v.sql);
		return aggResult(em, sql, typeof type === 'function' ? type(x) : type);
	};
}

function minMax(name, cmp) {
	return (c, em) => {
		if (c.args.length === 2) {
			const args = [em.arg(c, 0), em.arg(c, 1)];
			const type = args.some((x) => x.type === 'boolean') ? 'boolean' : unifyTypes(args.map((x) => x.type));
			const [a, b] = args.map((x) => em.valueOf(x));
			const A = wrap(a, PREC.CMP + 1);
			const B = wrap(b, PREC.CMP + 1);
			const sql = `CASE WHEN ${A} ${cmp} ${B} THEN ${a.sql} WHEN ${A} IS NOT NULL AND ${B} IS NOT NULL THEN ${b.sql} END`;
			return type === 'boolean' ? em.boolFromValue(sql) : em.out(sql, type);
		}
		return aggregate(name, (x) => x.type)(c, em);
	};
}

/** Known text (or null) of `r`, else undefined. */
const textConstant = (r) => (r.constant && (r.constant.value === null || typeof r.constant.value === 'string') ? r.constant.value : undefined);

/** `test` on two text constants; undefined when it matches only ignoring case, which depends on Tableau's collation. */
function foldMatch(s, t, test) {
	const [a, b] = [textConstant(s), textConstant(t)];
	if (a === undefined || b === undefined) return undefined;
	if (a === null || b === null) return null;
	if (test(a.toLowerCase(), b.toLowerCase())) return test(a, b) ? true : undefined;
	return false;
}

/** Both texts lower-cased when either is a field whose Tableau collation ignores case. */
function caseFolded(em, s, t) {
	return ignoresCase(s) || ignoresCase(t) ? [em.caseless(s), em.caseless(t)] : [s, t];
}

function stringPredicate(side, test) {
	return (c, em) => {
		em.arity(c, 2, 2);
		const s = em.arg(c, 0);
		const t = em.arg(c, 1);
		const folded = foldMatch(s, t, test);
		if (folded !== undefined) return em.boolConst(folded);
		const literal = em.lit(c, 1);
		const len = typeof literal === 'string' ? String([...literal].length) : `LENGTH(${t.sql})`;
		const [a, b] = caseFolded(em, s, t);
		return em.out(`${side}(${a.sql}, ${len}) = ${wrap(b, PREC.CMP + 1)}`, 'boolean', PREC.CMP);
	};
}

/** Number of occurrences of `t` in `s`. */
const occurrences = (s, t) => `(LENGTH(${s}) - LENGTH(REPLACE(${s}, ${t}, ''))) / LENGTH(${t})`;

const PI = String(Math.PI);

/** True when a literal pattern can match the empty string; unparseable patterns count as true. */
function matchesEmpty(pattern) {
	try {
		return new RegExp(pattern).test('');
	} catch {
		return true;
	}
}

function noEquivalent(c, em, type) {
	em.issue('error', 'calc.no-equivalent', `${c.name} has no Domo equivalent for a non-literal argument`);
	return em.out(em.generic(c).sql, type);
}

/** @type {Record<string, (c: any, em: any) => import('./sql.js').Emitted>} */
export const FUNCTIONS = {
	// Aggregates
	SUM: aggregate('SUM', (x) => numType(x.type)),
	AVG: aggregate('AVG', 'real'),
	COUNT: aggregate('COUNT', 'integer'),
	COUNTD: aggregate('COUNT', 'integer', { distinct: true }),
	MEDIAN: aggregate('MEDIAN', 'real'),
	STDEV: aggregate('STDDEV', 'real'),
	STDEVP: aggregate('STDDEV_POP', 'real'),
	VAR: aggregate('VAR', 'real'),
	VARP: aggregate('VAR_POP', 'real'),
	MIN: minMax('MIN', '<='),
	MAX: minMax('MAX', '>='),
	ATTR(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0, { inAgg: true });
		const v = em.valueOf(x);
		const lo = em.agg('MIN', v.sql);
		const hi = em.agg('MAX', v.sql);
		const other = x.type === 'string' ? " ELSE '*'" : '';
		return aggResult(em, `CASE WHEN ${lo} = ${hi} THEN ${lo}${other} END`, x.type);
	},
	PERCENTILE(c, em) {
		em.arity(c, 2, 2);
		const x = em.valueOf(em.arg(c, 0, { inAgg: true }));
		const p = em.arg(c, 1, { inAgg: true });
		return em.aggOut(em.agg('PERCENTILE', `${x.sql}, ${p.sql}`), 'real');
	},
	CORR(c, em) {
		em.arity(c, 2, 2);
		const a = em.valueOf(em.arg(c, 0, { inAgg: true }));
		const b = em.valueOf(em.arg(c, 1, { inAgg: true }));
		return em.aggOut(em.agg('CORR', `${a.sql}, ${b.sql}`), 'real');
	},
	COVARP: covariance(false),
	COVAR: covariance(true),

	// Logical
	IIF(c, em) {
		em.arity(c, 3, 4);
		const cond = em.cond(em.arg(c, 0));
		return em.conditional(
			[
				{ cond: () => cond, then: () => em.arg(c, 1) },
				{ cond: () => em.not(cond), then: () => em.arg(c, 2) }
			],
			c.args.length > 3 ? () => em.arg(c, 3) : null
		);
	},
	IFNULL(c, em) {
		em.arity(c, 2, 2);
		const [a, b] = em.args(c);
		const type = unifyTypes([a.type, b.type]);
		const sql = fn('IFNULL', em.valueOf(a).sql, em.valueOf(b).sql);
		return type === 'boolean' ? em.boolFromValue(sql) : em.out(sql, type);
	},
	ZN(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		return em.out(fn('IFNULL', x.sql, '0'), isNumeric(x.type) ? x.type : 'real');
	},
	ISNULL(c, em) {
		em.arity(c, 1, 1);
		return em.isNull(em.arg(c, 0));
	},

	// String
	LEN: simple('LENGTH', 'integer', { min: 1, max: 1, fold: (s) => [...s].length }),
	LEFT: simple('LEFT', 'string', { min: 2, max: 2 }),
	RIGHT: simple('RIGHT', 'string', { min: 2, max: 2 }),
	MID: simple('SUBSTRING', 'string', { min: 2, max: 3 }),
	UPPER: simple('UPPER', 'string', { min: 1, max: 1, fold: (s) => s.toUpperCase() }),
	LOWER: simple('LOWER', 'string', { min: 1, max: 1, fold: (s) => s.toLowerCase() }),
	TRIM: simple('TRIM', 'string', { min: 1, max: 1 }),
	LTRIM: (c, em) => (em.arity(c, 1, 1), em.out(fn('REGEXP_REPLACE', em.arg(c, 0).sql, "'^ +'", "''"), 'string')),
	RTRIM: (c, em) => (em.arity(c, 1, 1), em.out(fn('REGEXP_REPLACE', em.arg(c, 0).sql, "' +$'", "''"), 'string')),
	REPLACE: simple('REPLACE', 'string', { min: 3, max: 3 }),
	PROPER: simple('INITCAP', 'string', { min: 1, max: 1 }),
	ASCII(c, em) {
		em.arity(c, 1, 1);
		const s = em.lit(c, 0);
		if (typeof s === 'string' && s) return em.out(String(s.codePointAt(0)), 'integer', PREC.PRIMARY, undefined, s.codePointAt(0));
		return noEquivalent(c, em, 'integer');
	},
	CHAR(c, em) {
		em.arity(c, 1, 1);
		const n = em.lit(c, 0);
		if (Number.isInteger(n) && n >= 0 && n <= 0x10ffff) return em.out(quoteString(String.fromCodePoint(n)), 'string', PREC.PRIMARY, undefined, String.fromCodePoint(n));
		return noEquivalent(c, em, 'string');
	},
	REGEXP_REPLACE: simple('REGEXP_REPLACE', 'string', { min: 3, max: 3 }),
	SPACE(c, em) {
		em.arity(c, 1, 1);
		return em.out(fn('LPAD', "''", em.arg(c, 0).sql, "' '"), 'string');
	},
	CONTAINS(c, em) {
		em.arity(c, 2, 2);
		const [s, t] = em.args(c);
		const folded = foldMatch(s, t, (a, b) => a.includes(b));
		if (folded !== undefined) return em.boolConst(folded);
		const [a, b] = caseFolded(em, s, t);
		return em.predicate(`INSTR(${a.sql}, ${b.sql}) > 0`, `INSTR(${a.sql}, ${b.sql}) = 0`);
	},
	STARTSWITH: stringPredicate('LEFT', (a, b) => a.startsWith(b)),
	ENDSWITH: stringPredicate('RIGHT', (a, b) => a.endsWith(b)),
	FIND(c, em) {
		em.arity(c, 2, 3);
		const [source, target, start] = em.args(c);
		const [s, t] = caseFolded(em, source, target);
		const n = em.lit(c, 2);
		if (!start || (typeof n === 'number' && n <= 1)) return em.out(fn('INSTR', s.sql, t.sql), 'integer');
		// Domo's INSTR ignores a third argument, so search the tail instead.
		const pos = fn('INSTR', fn('SUBSTRING', s.sql, start.sql), t.sql);
		const offset = typeof n === 'number' ? ` + ${n - 1}` : ` + ${wrap(start, PREC.ADD + 1)} - 1`;
		return em.out(`CASE WHEN ${pos} > 0 THEN ${pos}${offset} WHEN ${pos} = 0 THEN 0 END`, 'integer');
	},
	FINDNTH(c, em) {
		em.arity(c, 3, 3);
		const [s, t, n] = em.args(c);
		return em.out(
			`CASE WHEN ${occurrences(s.sql, t.sql)} >= ${wrap(n, PREC.CMP + 1)} THEN LENGTH(SUBSTRING_INDEX(${s.sql}, ${t.sql}, ${n.sql})) + 1 ELSE 0 END`,
			'integer'
		);
	},
	SPLIT(c, em) {
		em.arity(c, 3, 3);
		const [s, d] = em.args(c);
		const n = em.lit(c, 2);
		if (typeof n !== 'number' || !Number.isInteger(n) || n === 0) {
			em.issue('error', 'calc.split-token', 'SPLIT needs a non-zero integer literal token number');
			return em.out(fn('SPLIT', s.sql, d.sql, em.arg(c, 2).sql), 'string');
		}
		const inner = n > 0 ? `SUBSTRING_INDEX(SUBSTRING_INDEX(${s.sql}, ${d.sql}, ${n}), ${d.sql}, -1)` : `SUBSTRING_INDEX(SUBSTRING_INDEX(${s.sql}, ${d.sql}, ${n}), ${d.sql}, 1)`;
		const needed = Math.abs(n) - 1;
		if (needed === 0) return em.out(inner, 'string');
		// Tableau returns '' for a missing token; SUBSTRING_INDEX would repeat the last one.
		return em.out(`CASE WHEN ${occurrences(s.sql, d.sql)} >= ${needed} THEN ${inner} ELSE '' END`, 'string');
	},
	REGEXP_MATCH(c, em) {
		em.arity(c, 2, 2);
		const [s, p] = em.args(c);
		// Beast Mode has no REGEXP operator or REGEXP_LIKE; appending to every match changes the text iff the pattern matches.
		const replaced = fn('REGEXP_REPLACE', s.sql, p.sql, "'$0_'");
		const pattern = em.lit(c, 1);
		if (typeof pattern !== 'string' || matchesEmpty(pattern)) {
			em.issue('warning', 'calc.regexp-match', 'REGEXP_MATCH emulated with REGEXP_REPLACE, which never matches an empty string');
		}
		return em.predicate(`${replaced} != ${wrap(s, PREC.CMP + 1)}`, `${replaced} = ${wrap(s, PREC.CMP + 1)}`);
	},

	// Date
	TODAY: (c, em) => (em.arity(c, 0, 0), em.out('CURRENT_DATE()', 'date')),
	NOW: (c, em) => (em.arity(c, 0, 0), em.out('NOW()', 'datetime')),
	YEAR: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'year', em.arg(c, 0), 1)),
	QUARTER: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'quarter', em.arg(c, 0), 1)),
	MONTH: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'month', em.arg(c, 0), 1)),
	DAY: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'day', em.arg(c, 0), 1)),
	WEEK: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'week', em.arg(c, 0), weekStart(em, c, 1))),
	ISOYEAR: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'iso-year', em.arg(c, 0), 2)),
	ISOQUARTER: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'iso-quarter', em.arg(c, 0), 2)),
	ISOWEEK: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'iso-week', em.arg(c, 0), 2)),
	ISOWEEKDAY: (c, em) => (em.arity(c, 1, 1), datePart(em, c, 'iso-weekday', em.arg(c, 0), 2)),
	DATEPART(c, em) {
		em.arity(c, 2, 3);
		const part = datePartArg(em, c);
		const d = em.arg(c, 1);
		if (!part) return em.out(fn('DATEPART', em.arg(c, 0).sql, d.sql), 'integer');
		return datePart(em, c, part, d, weekStart(em, c, 2));
	},
	DATENAME(c, em) {
		em.arity(c, 2, 3);
		const part = datePartArg(em, c);
		const d = em.arg(c, 1);
		if (part === 'month') return em.out(`MONTHNAME(${d.sql})`, 'string');
		if (part === 'weekday') return em.out(`DAYNAME(${d.sql})`, 'string');
		if (!part) return em.out(fn('DATENAME', em.arg(c, 0).sql, d.sql), 'string');
		const num = datePart(em, c, part, d, weekStart(em, c, 2));
		return em.out(`CAST(${num.sql} AS CHAR)`, 'string');
	},
	DATETRUNC(c, em) {
		em.arity(c, 2, 3);
		const part = datePartArg(em, c);
		const d = em.arg(c, 1);
		if (!part) return em.out(fn('DATETRUNC', em.arg(c, 0).sql, d.sql), 'date');
		return dateTrunc(em, c, part, d, weekStart(em, c, 2));
	},
	DATEADD(c, em) {
		em.arity(c, 3, 3);
		const part = datePartArg(em, c);
		const n = em.arg(c, 1);
		const d = em.arg(c, 2);
		if (!part) return em.out(fn('DATEADD', em.arg(c, 0).sql, n.sql, d.sql), 'datetime');
		return dateAdd(em, part, n, d);
	},
	DATEDIFF(c, em) {
		em.arity(c, 3, 4);
		const part = datePartArg(em, c);
		const a = em.arg(c, 1);
		const b = em.arg(c, 2);
		if (!part) return em.out(fn('DATEDIFF', em.arg(c, 0).sql, a.sql, b.sql), 'integer');
		return dateDiff(em, part, a, b, weekStart(em, c, 3));
	},
	DATEPARSE(c, em) {
		em.arity(c, 2, 2);
		const pattern = em.lit(c, 0);
		const s = em.arg(c, 1);
		if (typeof pattern !== 'string') {
			em.issue('error', 'calc.dateparse-format', 'DATEPARSE needs a literal format string');
			return em.out(fn('STR_TO_DATE', s.sql, em.arg(c, 0).sql), 'datetime');
		}
		const { format, unsupported, hasTime } = icuToMysqlFormat(pattern);
		if (unsupported.length) {
			em.issue('warning', 'calc.dateparse-format', `DATEPARSE format tokens not translatable to MySQL: ${unsupported.join(', ')}`);
		}
		return em.out(fn('STR_TO_DATE', s.sql, quoteString(format)), hasTime ? 'datetime' : 'date');
	},
	MAKEDATE(c, em) {
		em.arity(c, 3, 3);
		const [y, m, d] = em.args(c);
		return em.out(`STR_TO_DATE(CONCAT(${y.sql}, '-', ${m.sql}, '-', ${d.sql}), '%Y-%c-%e')`, 'date');
	},
	MAKEDATETIME(c, em) {
		em.arity(c, 2, 2);
		const [d, t] = em.args(c);
		// Two-argument TIMESTAMP validates but fails at query time ("Invalid function TIMESTAMP").
		return em.out(`TIMESTAMP(CONCAT(DATE(${d.sql}), ' ', TIME(${t.sql})))`, 'datetime');
	},
	MAKETIME(c, em) {
		em.arity(c, 3, 3);
		const [h, m, s] = em.args(c);
		return em.out(`DATE_ADD(TIMESTAMP('1899-12-30'), INTERVAL (${wrap(h, PREC.MUL)} * 3600 + ${wrap(m, PREC.MUL)} * 60 + ${wrap(s, PREC.ADD + 1)}) SECOND)`, 'datetime');
	},
	DATE(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		if (x.dateOnly) return { ...x };
		if (isNumeric(x.type)) return em.out(`DATE_ADD('1899-12-30', INTERVAL FLOOR(${x.sql}) DAY)`, 'date');
		if (x.type === 'string' && !(c.args[0].type === 'Literal' && /^\d{4}-\d{1,2}-\d{1,2}/.test(c.args[0].value))) {
			em.issue('warning', 'calc.date-cast', 'DATE() of a string only parses ISO yyyy-mm-dd text in Domo; use DATEPARSE for other formats');
		}
		return dateOnly(em.out(`DATE(${x.sql})`, 'date'));
	},
	DATETIME(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		if (isNumeric(x.type)) return em.out(`DATE_ADD(TIMESTAMP('1899-12-30'), INTERVAL ROUND(${wrap(x, PREC.MUL)} * 86400) SECOND)`, 'datetime');
		return em.out(`TIMESTAMP(${x.sql})`, 'datetime');
	},
	ISDATE(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		em.issue('warning', 'calc.isdate', 'ISDATE approximated: only yyyy-mm-dd strings are recognized');
		return em.out(`STR_TO_DATE(${x.sql}, '%Y-%m-%d') IS NOT NULL`, 'boolean', PREC.CMP);
	},

	// Type conversion
	STR(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		if (x.type === 'boolean') return em.valueOf(x);
		if (x.type === 'string') return x.prec >= PREC.PRIMARY ? em.out(x.sql, 'string') : em.out(`(${x.sql})`, 'string');
		return em.out(`CAST(${x.sql} AS CHAR)`, 'string');
	},
	INT(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		if (x.type === 'integer') return em.out(x.sql, 'integer', x.prec);
		if (isDateType(x.type)) return em.out(`DATEDIFF(${x.sql}, '1899-12-30')`, 'integer');
		if (x.type === 'boolean') return boolToNumber(em, x, '1', '0', 'integer');
		const v = x.type === 'string' ? castDecimal(em, x.sql) : wrap(x, PREC.CMP + 1);
		// Tableau INT truncates toward zero; CAST AS SIGNED rounds.
		return em.out(`CASE WHEN ${v} >= 0 THEN FLOOR(${v}) ELSE CEILING(${v}) END`, 'integer');
	},
	FLOAT(c, em) {
		em.arity(c, 1, 1);
		const x = em.arg(c, 0);
		if (x.type === 'string') return em.out(castDecimal(em, x.sql), 'real');
		if (isDateType(x.type)) {
			if (x.type === 'datetime') em.issue('warning', 'calc.float-date', 'FLOAT of a datetime drops the time of day');
			return em.out(`DATEDIFF(${x.sql}, '1899-12-30')`, 'real');
		}
		if (x.type === 'boolean') return boolToNumber(em, x, '1.0', '0.0', 'real');
		return em.out(`${wrap(x, PREC.MUL)} * 1.0`, 'real', PREC.MUL);
	},

	// Math
	ABS: simple('ABS', ([x]) => numType(x?.type), { min: 1, max: 1 }),
	DEGREES: (c, em) => (em.arity(c, 1, 1), em.out(`${wrap(em.arg(c, 0), PREC.MUL)} * 180 / ${PI}`, 'real', PREC.MUL)),
	RADIANS: (c, em) => (em.arity(c, 1, 1), em.out(`${wrap(em.arg(c, 0), PREC.MUL)} * ${PI} / 180`, 'real', PREC.MUL)),
	CEILING: simple('CEILING', 'integer', { min: 1, max: 1 }),
	FLOOR: simple('FLOOR', 'integer', { min: 1, max: 1 }),
	EXP: (c, em) => (em.arity(c, 1, 1), em.out(fn('POWER', String(Math.E), em.arg(c, 0).sql), 'real')),
	LN: simple('LN', 'real', { min: 1, max: 1 }),
	SQRT: simple('SQRT', 'real', { min: 1, max: 1 }),
	SIGN(c, em) {
		em.arity(c, 1, 1);
		const x = wrap(em.arg(c, 0), PREC.CMP + 1);
		return em.out(`CASE WHEN ${x} > 0 THEN 1 WHEN ${x} < 0 THEN -1 WHEN ${x} = 0 THEN 0 END`, 'integer');
	},
	PI: (c, em) => (em.arity(c, 0, 0), em.out(PI, 'real', PREC.PRIMARY, undefined, Math.PI)),
	POWER: simple('POWER', 'real', { min: 2, max: 2 }),
	DIV(c, em) {
		em.arity(c, 2, 2);
		// Domo's DIV() floors (DIV(-7, 2) is -4); Tableau truncates toward zero.
		const a = em.arg(c, 0);
		const b = em.arg(c, 1);
		return em.out(em.mode === 'etl' ? `TRUNCATE(${em.divide(a, b)}, 0)` : `TRUNC(${em.divide(a, b)})`, 'integer');
	},
	ROUND: simple('ROUND', (args) => (args.length === 1 && args[0].type === 'integer' ? 'integer' : 'real'), { min: 1, max: 2 }),
	SQUARE(c, em) {
		em.arity(c, 1, 1);
		return em.out(fn('POWER', em.arg(c, 0).sql, '2'), 'real');
	},
	LOG(c, em) {
		em.arity(c, 1, 2);
		const x = em.arg(c, 0);
		// Tableau LOG takes (x, base); Domo LOG takes (base, x).
		return em.out(fn('LOG', c.args.length === 1 ? '10' : em.arg(c, 1).sql, x.sql), 'real');
	}
};

function covariance(sample) {
	return (c, em) => {
		em.arity(c, 2, 2);
		const a = em.valueOf(em.arg(c, 0, { inAgg: true }));
		const b = em.valueOf(em.arg(c, 1, { inAgg: true }));
		const A = wrap(a, PREC.MUL);
		const B = wrap(b, PREC.MUL + 1);
		const product = `${A} * ${B}`;
		const pop = `${em.agg('AVG', product)} - ${em.agg('AVG', a.sql)} * ${em.agg('AVG', b.sql)}`;
		em.issue('warning', 'calc.covariance', `${c.name} expanded from averages; rows where only one argument is null are not excluded`);
		if (!sample) return em.aggOut(pop, 'real', PREC.ADD);
		const n = em.agg('COUNT', product);
		return em.aggOut(`(${pop}) * ${n} / (${n} - 1)`, 'real', PREC.MUL);
	};
}

export const KNOWN_FUNCTIONS = new Set(Object.keys(FUNCTIONS));
