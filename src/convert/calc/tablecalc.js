import { bmColumn } from '../../model/naming.js';
import { NULL_VALUE, PREC, wrap } from './sql.js';
import { isAggregateCall } from './catalog.js';

// Domo's query engine runs these over a ROWS frame. VAR, CORR, COVAR_*, PERCENT_RANK, CUME_DIST and NTH_VALUE pass
// validateFunctions but fail at query time with "Not a valid analytic function", so they are never emitted.
const WINDOW_AGG = {
	WINDOW_SUM: 'SUM',
	WINDOW_AVG: 'AVG',
	WINDOW_COUNT: 'COUNT',
	WINDOW_MIN: 'MIN',
	WINDOW_MAX: 'MAX',
	WINDOW_STDEV: 'STDDEV_SAMP',
	WINDOW_STDEVP: 'STDDEV_POP',
	WINDOW_VAR: 'VAR_SAMP',
	WINDOW_VARP: 'VAR_POP'
};
// MEDIAN and PERCENTILE_CONT run over a whole partition only; a sliding frame fails at query time.
const WINDOW_WHOLE = new Set(['WINDOW_MEDIAN', 'WINDOW_PERCENTILE']);
const WINDOW_PAIR = new Set(['WINDOW_CORR', 'WINDOW_COVAR', 'WINDOW_COVARP']);
const RUNNING_AGG = { RUNNING_SUM: 'SUM', RUNNING_AVG: 'AVG', RUNNING_COUNT: 'COUNT', RUNNING_MIN: 'MIN', RUNNING_MAX: 'MAX' };
const RANKS = { RANK: 'RANK()', RANK_DENSE: 'DENSE_RANK()', RANK_UNIQUE: 'ROW_NUMBER()' };
const TOTAL_OUTER = { SUM: 'SUM', COUNT: 'SUM', COUNTD: null, MIN: 'MIN', MAX: 'MAX', AVG: 'AVG' };
const WHOLE = 'ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING';
const RUNNING = 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW';
const AT_OR_BEFORE = 'RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW';

function direction(d) {
	return d ? ` ${String(d).toUpperCase()}` : '';
}

function orderItem(item) {
	if (typeof item === 'string') return bmColumn(item);
	if (item?.expression) return `${item.expression}${direction(item.direction)}`;
	return `${bmColumn(item.column)}${direction(item.direction)}`;
}

function partitionItem(item) {
	if (typeof item === 'string') return bmColumn(item);
	return item?.expression ?? bmColumn(item.column);
}

function unwrapParen(node) {
	let n = node;
	while (n && n.type === 'Paren') n = n.expr;
	return n;
}

const isCall = (n, name) => n?.type === 'Call' && n.name === name && !n.args.length;

/** Frame bound for WINDOW_* start/end arguments. */
function frameBound(em, node) {
	const n = unwrapParen(node);
	if (isCall(n, 'FIRST')) return 'UNBOUNDED PRECEDING';
	if (isCall(n, 'LAST')) return 'UNBOUNDED FOLLOWING';
	if (n.type === 'Binary' && (n.op === '+' || n.op === '-')) {
		const base = unwrapParen(n.left);
		if (isCall(base, 'FIRST') || isCall(base, 'LAST')) {
			em.issue('warning', 'calc.table-calc-frame', `Window bound relative to ${base.name}() approximated as unbounded`);
			return base.name === 'FIRST' ? 'UNBOUNDED PRECEDING' : 'UNBOUNDED FOLLOWING';
		}
	}
	const value = em.literalValue(n) ?? em.emit(n).constant?.value;
	if (typeof value !== 'number' || !Number.isInteger(value)) return null;
	if (value === 0) return 'CURRENT ROW';
	return value < 0 ? `${-value} PRECEDING` : `${value} FOLLOWING`;
}

/** OVER clause text; Domo rejects a frame without ORDER BY (PARSING_ERROR), so the frame needs an order. */
function overClause(partition, order = [], frame = '') {
	const parts = [];
	if (partition.length) parts.push(`PARTITION BY ${partition.join(', ')}`);
	if (order.length) parts.push(`ORDER BY ${order.join(', ')}`);
	if (order.length && frame) parts.push(frame);
	return `OVER (${parts.join(' ')})`;
}

/** Sample (or population) covariance and Pearson correlation from windowed sums over rows where both values exist. */
function pairStatistic(name, x, y, over) {
	const product = `${wrap(x, PREC.MUL)} * ${wrap(y, PREC.MUL)}`;
	const xs = `CASE WHEN ${wrap(y, PREC.CMP + 1)} IS NOT NULL THEN ${x.sql} END`;
	const ys = `CASE WHEN ${wrap(x, PREC.CMP + 1)} IS NOT NULL THEN ${y.sql} END`;
	const n = `COUNT(${product}) ${over}`;
	const centered = `SUM(${product}) ${over} - SUM(${xs}) ${over} * SUM(${ys}) ${over} / NULLIF(${n}, 0)`;
	if (name === 'WINDOW_COVARP') return `(${centered}) / NULLIF(${n}, 0)`;
	const covar = `(${centered}) / NULLIF(${n} - 1, 0)`;
	if (name === 'WINDOW_COVAR') return covar;
	return `${covar} / NULLIF(STDDEV_SAMP(${xs}) ${over} * STDDEV_SAMP(${ys}) ${over}, 0)`;
}

/** Offsets of a LOOKUP offset that chooses between integer constants (IF, CASE, IIF or a calc that is one), or undefined. */
function offsetTree(em, node, seen) {
	const n = unwrapParen(node);
	if (n.type === 'Literal' && n.valueType === 'null') return { value: null };
	if (n.type === 'If') {
		const thens = n.branches.map((b) => offsetTree(em, b.then, seen));
		const otherwise = n.else ? offsetTree(em, n.else, seen) : null;
		return thens.every(Boolean) && otherwise !== undefined ? { node: n, thens, otherwise } : undefined;
	}
	if (n.type === 'Case') {
		const thens = n.whens.map((w) => offsetTree(em, w.then, seen));
		const otherwise = n.else ? offsetTree(em, n.else, seen) : null;
		return thens.every(Boolean) && otherwise !== undefined ? { node: n, thens, otherwise } : undefined;
	}
	if (n.type === 'Call' && n.name === 'IIF' && (n.args.length === 3 || n.args.length === 4)) {
		const thens = n.args.slice(1, 3).map((a) => offsetTree(em, a, seen));
		const otherwise = n.args[3] ? offsetTree(em, n.args[3], seen) : null;
		return thens.every(Boolean) && otherwise !== undefined ? { node: n, thens, otherwise } : undefined;
	}
	if (n.type === 'Field') {
		const res = em.resolve(n);
		if (res?.kind === 'calc' && res.field.formula && !seen.has(res.field.id ?? n.id)) {
			const ast = em.parseCalc(res.field);
			return ast ? offsetTree(em, ast, new Set([...seen, res.field.id ?? n.id])) : undefined;
		}
	}
	const value = em.literalValue(n) ?? em.emit(n).constant?.value;
	return typeof value === 'number' && Number.isInteger(value) ? { value } : undefined;
}

/** CASE over the LOOKUP at each constant offset, so a parameter in the condition stays a variable; no ELSE gives null. */
function distributeOffset(em, node, at) {
	const tree = offsetTree(em, node, new Set());
	if (!tree || 'value' in tree) return undefined;
	let rowLevel = false;
	const check = (r) => {
		if (r.flags?.rowRef) rowLevel = true;
		return r;
	};
	const build = (t) => {
		if ('value' in t) return at(t.value);
		const n = t.node;
		const then = (i) => () => build(t.thens[i]);
		const otherwise = t.otherwise ? () => build(t.otherwise) : null;
		if (n.type === 'If') return em.conditional(n.branches.map((b, i) => ({ cond: () => check(em.cond(em.emit(b.cond))), then: then(i) })), otherwise);
		if (n.type === 'Call') {
			const cond = check(em.cond(em.emit(n.args[0])));
			return em.conditional([{ cond: () => cond, then: then(0) }, { cond: () => em.not(cond), then: then(1) }], otherwise);
		}
		if (!n.subject) return em.conditional(n.whens.map((w, i) => ({ cond: () => check(em.cond(em.emit(w.when))), then: then(i) })), otherwise);
		const s = check(em.emit(n.subject));
		if (s.type === 'boolean' || s.constant) return em.conditional(n.whens.map((w, i) => ({ cond: () => em.compare('=', s, em.emit(w.when)), then: then(i) })), otherwise);
		return em.conditional(n.whens.map((w, i) => ({ cond: () => em.emit(w.when), then: then(i) })), otherwise, s.sql);
	};
	const result = build(tree);
	return rowLevel ? undefined : result;
}

/**
 * Translate a Tableau table calculation function call.
 * @param {any} c Call node
 * @param {any} em Emitter
 */
export function emitTableCalc(c, em) {
	const name = c.name;
	const generic = () => em.generic(c);
	if (em.mode === 'etl') {
		em.issue('error', 'calc.row-level-only', `${name} is a table calculation; Magic ETL formulas are row-level only`, 'Use a Magic ETL Rank & Window tile');
		return generic();
	}
	// One value per row at the grain Magic ETL computed it, so any aggregate reads it back on a card at that grain.
	const materialized = em.ctx.tableCalcColumn?.(c);
	if (materialized) return em.aggOut(`MAX(${bmColumn(materialized.column)})`, materialized.datatype ?? 'real');
	const options = em.options;
	const addressing = em.ctx.tableCalc;
	for (const i of addressing?.issues ?? []) em.issue(i.severity, i.code, i.message, i.suggestion);

	if (name === 'TOTAL' && options.useFixed) {
		em.arity(c, 1, 1);
		const partition = (addressing?.partitionBy ?? []).map(partitionItem);
		const clause = partition.length ? `(BY ${partition.join(', ')})` : '()';
		em.feature('fixed');
		if (!addressing) {
			em.issue('warning', 'calc.table-calc-addressing', 'TOTAL translated over the whole table; check the Tableau compute-using addressing');
		}
		const inner = em.valueOf(em.arg(c, 0, { inAgg: false, fixed: clause, lodDepth: em.env.lodDepth + 1 }));
		return { sql: `SUM(${inner.sql})`, type: inner.type, prec: PREC.PRIMARY, flags: { agg: true, tableCalc: true } };
	}

	if (!options.useWindowFunctions) {
		em.issue(
			'error',
			'calc.table-calc',
			`Table calculation ${name} needs window functions`,
			'Enable useWindowFunctions (requires the Domo window functions feature switch) or precompute with a Magic ETL Rank & Window tile'
		);
		return generic();
	}

	em.feature('window');
	if (!addressing) {
		em.issue('warning', 'calc.table-calc-addressing', `${name}: partition and order come from the worksheet table-calc addressing; translated without it`);
	}
	const partition = (addressing?.partitionBy ?? []).map(partitionItem);
	const order = (addressing?.orderBy ?? []).map(orderItem);
	const needOrder = (severity = 'warning', consequence = '') => {
		if (!order.length) em.issue(severity, 'calc.table-calc-order', `${name} needs an ORDER BY from the table-calc addressing; none was provided${consequence}`);
	};
	const over = (orderList = [], frame = '') => overClause(partition, orderList, frame);
	// Boolean arguments are passed in their 'true'/'false' text form; a boolean result compares that text.
	const out = (sql, type, prec = PREC.PRIMARY) => ({ ...(type === 'boolean' ? em.boolFromValue(sql) : { sql, type, prec }), flags: { agg: true, tableCalc: true } });
	const value = (i) => {
		const x = em.arg(c, i);
		if (x.flags?.tableCalc) {
			em.issue(
				'error',
				'calc.table-calc-nested',
				`${name} of another table calculation needs a window function over another window function. Domo rejects that inline (INCOMPATIBLE_LINK), and splitting it into two beast modes does not help: Domo expands DOMO_BEAST_MODE(<id>) back into the same nested window before the query runs, so the card query fails`,
				'Precompute the inner table calculation as a column with a Magic ETL Rank & Window tile (at a fixed grain), then apply the outer one to that column'
			);
		}
		return { x, e: em.valueOf(x) };
	};

	if (RUNNING_AGG[name]) {
		em.arity(c, 1, 1);
		needOrder('error', ', so the running order is undefined');
		const { x, e } = value(0);
		const type = name === 'RUNNING_COUNT' ? 'integer' : name === 'RUNNING_AVG' ? 'real' : x.type;
		return out(`${RUNNING_AGG[name]}(${e.sql}) ${over(order, RUNNING)}`, type);
	}

	if (WINDOW_AGG[name] || WINDOW_WHOLE.has(name) || WINDOW_PAIR.has(name)) {
		const arity = WINDOW_PAIR.has(name) || name === 'WINDOW_PERCENTILE' ? 2 : 1;
		em.arity(c, arity, arity + 2);
		const values = name === 'WINDOW_PERCENTILE' ? [value(0)] : Array.from({ length: arity }, (_, i) => value(i));
		let frame = '';
		if (c.args.length > arity) {
			const start = frameBound(em, c.args[arity]);
			const end = c.args.length > arity + 1 ? frameBound(em, c.args[arity + 1]) : 'CURRENT ROW';
			if (!start || !end) {
				em.issue('error', 'calc.table-calc-frame', `${name} window offsets must be integer literals or FIRST()/LAST()`);
				return generic();
			}
			if (start !== 'UNBOUNDED PRECEDING' || end !== 'UNBOUNDED FOLLOWING') frame = `ROWS BETWEEN ${start} AND ${end}`;
		}
		if (frame && WINDOW_WHOLE.has(name)) {
			em.issue('error', 'calc.table-calc-frame', `${name} over a sliding window has no Domo equivalent; Domo runs MEDIAN and PERCENTILE over a whole partition only`);
			return generic();
		}
		if (frame) needOrder('error', ', so the window frame is undefined');
		const w = over(frame ? order : [], frame);
		const [first, second] = values.map((v) => v.e);
		if (name === 'WINDOW_MEDIAN') return out(`MEDIAN(${first.sql}) ${w}`, 'real');
		if (name === 'WINDOW_PERCENTILE') {
			const p = em.lit(c, 1);
			if (typeof p !== 'number' || p < 0 || p > 1) {
				em.issue('error', 'calc.table-calc', 'WINDOW_PERCENTILE needs a literal percentile between 0 and 1');
				return generic();
			}
			return out(`PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY ${first.sql}) ${w}`, 'real');
		}
		if (WINDOW_PAIR.has(name)) return out(pairStatistic(name, first, second, w), 'real', PREC.MUL);
		const type = ['WINDOW_SUM', 'WINDOW_MIN', 'WINDOW_MAX'].includes(name) ? values[0].x.type : name === 'WINDOW_COUNT' ? 'integer' : 'real';
		return out(`${WINDOW_AGG[name]}(${first.sql}) ${w}`, type);
	}

	if (name === 'TOTAL') {
		em.arity(c, 1, 1);
		const arg = unwrapParen(c.args[0]);
		const outer = isAggregateCall(arg) ? TOTAL_OUTER[arg.name] : undefined;
		if (!outer) {
			em.issue('error', 'calc.table-calc', 'TOTAL of this expression has no window-function equivalent', 'Enable useFixed to translate TOTAL with FIXED ()');
			return generic();
		}
		if (outer === 'AVG') em.issue('warning', 'calc.table-calc', 'TOTAL(AVG()) approximated as the average of averages');
		const { x, e } = value(0);
		return out(`${outer}(${e.sql}) ${over()}`, x.type);
	}

	if (RANKS[name] || name === 'RANK_MODIFIED' || name === 'RANK_PERCENTILE') {
		em.arity(c, 1, 2);
		const { e } = value(0);
		const dirArg = c.args.length > 1 ? em.lit(c, 1) : undefined;
		const dir = (typeof dirArg === 'string' ? dirArg : name === 'RANK_PERCENTILE' ? 'asc' : 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
		const ordered = [`${wrap(e, PREC.ADD)} ${dir}`];
		// Modified competition rank: rows ranked at or before the current one. COUNT(e) skips nulls as Tableau does.
		const atOrBefore = `COUNT(${e.sql}) ${over(ordered, AT_OR_BEFORE)}`;
		if (name === 'RANK_MODIFIED') return out(atOrBefore, 'integer');
		if (name === 'RANK_PERCENTILE') return out(`(${atOrBefore} - 1) / NULLIF(COUNT(${e.sql}) ${over()} - 1, 0)`, 'real', PREC.MUL);
		return out(`${RANKS[name]} ${over(ordered)}`, 'integer');
	}

	if (name === 'INDEX') {
		em.arity(c, 0, 0);
		needOrder();
		return out(`ROW_NUMBER() ${over(order)}`, 'integer');
	}
	if (name === 'FIRST') {
		em.arity(c, 0, 0);
		needOrder();
		return out(`1 - ROW_NUMBER() ${over(order)}`, 'integer', PREC.ADD);
	}
	if (name === 'LAST') {
		em.arity(c, 0, 0);
		needOrder();
		return out(`COUNT(*) ${over()} - ROW_NUMBER() ${over(order)}`, 'integer', PREC.ADD);
	}
	if (name === 'SIZE') {
		em.arity(c, 0, 0);
		return out(`COUNT(*) ${over()}`, 'integer');
	}
	if (name === 'LOOKUP') {
		em.arity(c, 2, 2);
		const { x, e } = value(0);
		const target = unwrapParen(c.args[1]);
		if (isCall(target, 'FIRST') || isCall(target, 'LAST')) {
			needOrder();
			const f = target.name === 'FIRST' ? 'FIRST_VALUE' : 'LAST_VALUE';
			return out(`${f}(${e.sql}) ${over(order, WHOLE)}`, x.type);
		}
		if (target.type === 'Binary' && (isCall(unwrapParen(target.left), 'FIRST') || isCall(unwrapParen(target.left), 'LAST'))) {
			em.issue('error', 'calc.table-calc', 'LOOKUP at an offset from FIRST() or LAST() needs NTH_VALUE, which Domo cannot run');
			return generic();
		}
		const at = (n) => {
			if (n === null) return em.nullValue();
			if (n === 0) return { ...x, flags: { ...x.flags, agg: true, tableCalc: true } };
			needOrder();
			return out(`${n < 0 ? 'LAG' : 'LEAD'}(${e.sql}, ${Math.abs(n)}) ${over(order)}`, x.type);
		};
		const n = em.literalValue(target) ?? em.emit(target).constant?.value;
		if (typeof n === 'number' && Number.isInteger(n)) return at(n);
		const distributed = distributeOffset(em, target, at);
		if (distributed) return { ...distributed, flags: { ...distributed.flags, agg: true, tableCalc: true } };
		em.issue('error', 'calc.table-calc', 'LOOKUP offset must be an integer literal, a constant (parameters inlined), or a condition choosing between integer constants');
		return generic();
	}

	em.issue('error', 'calc.table-calc', `Table calculation ${name} has no Domo equivalent`);
	return generic();
}

const ORDERING = {
	Rows: { address: ['cols'] },
	Columns: { address: ['rows'] },
	Table: { address: ['rows', 'cols'] },
	RowInPane: { address: ['cols'], innermost: true },
	ColumnInPane: { address: ['rows'], innermost: true },
	Pane: { address: ['rows', 'cols'], innermost: true },
	Cell: { address: [] },
	CellInPane: { address: [] }
};

const isMeasureNames = (id) => /\[:Measure Names\]$|\[Multiple Values\]$/.test(id);

/**
 * Window partition and order for a table calc pill, from the worksheet layout and the Tableau compute-using setting.
 *
 * XML ordering-type to Tableau UI, inferred from live workbooks: Rows = Table (across), Columns = Table (down),
 * RowInPane = Pane (across), ColumnInPane = Pane (down), Table and Pane = across then down, Cell = Cell,
 * Field = Specific Dimensions (orderFields). Dimensions on the Marks card are addressed in every mode.
 *
 * @param {import('../../model/types.js').WorksheetIR} worksheet
 * @param {string} pillId The table calc pill (its `tableCalc` holds the addressing)
 * @param {(pillId: string, pill: import('../../model/types.js').PillIR|undefined) => ({column: string}|{expression: string}|undefined)} toItem
 *   Domo column or expression of a dimension pill (date parts included), or undefined when it has none
 * @param {{ calc?: import('../../model/types.js').TableCalcIR, toMeasure?: (pillId: string, pill: import('../../model/types.js').PillIR|undefined) => string|undefined }} [options]
 *   `calc` addresses another setting of the pill (its secondary calc); `toMeasure` gives the aggregate SQL of the measure a
 *   computed sort orders by, which then orders the window ahead of the sorted dimension
 * @returns {{ partitionBy: object[], orderBy: object[], dimensions: string[], issues: { severity: string, code: string, message: string }[] }}
 *   `dimensions` are the dimension pill ids in the view, in shelf order (rows, columns, marks)
 */
export function tableCalcAddressing(worksheet, pillId, toItem, options = {}) {
	const issues = [];
	const warn = (message) => issues.push({ severity: 'warning', code: 'calc.table-calc-addressing', message });
	const pills = worksheet.pills ?? {};
	const calc = options.calc ?? pills[pillId]?.tableCalc;
	// A parameter is one value for every row, so it neither partitions nor orders a window.
	const isDim = (id) => !isMeasureNames(id) && pills[id]?.aggregated !== true && !pills[id]?.tableCalc && pills[id]?.datasourceId !== 'Parameters' && !id.startsWith('[Parameters].');
	const shelves = { rows: [], cols: [], marks: [] };
	const seen = new Set();
	for (const [shelf, ids] of [
		['rows', worksheet.rowPills ?? []],
		['cols', worksheet.colPills ?? []],
		['marks', (worksheet.panes ?? []).flatMap((p) => Object.values(p.encodings ?? {}).flat())]
	]) {
		for (const id of ids) {
			if (seen.has(id) || !isDim(id)) continue;
			seen.add(id);
			shelves[shelf].push(id);
		}
	}

	let addressed;
	const type = calc?.orderingType;
	if (type === 'Field') {
		// Tableau names a discrete dimension without its derivation: [ds].[Customer] for the pill [ds].[none:Customer:nk].
		const qualified = (id) => pills[id]?.datasourceId && `[${pills[id].datasourceId}].${pills[id].fieldId}`;
		const byField = (f) => [...seen].find((id) => id === f || pills[id]?.fieldId === f || id.endsWith(`.${f}`)) ?? [...seen].find((id) => qualified(id) === f);
		addressed = (calc.orderFields ?? []).map(byField).filter(Boolean);
		if (addressed.length < (calc.orderFields ?? []).length) warn('Some compute-using fields are not in the view; they were left out of the window order');
	} else {
		const mode = ORDERING[type] ?? ORDERING.Rows;
		// A pill without a table-calc setting computes with Tableau's default, Table (across).
		if (!ORDERING[type] && calc) warn(`Compute using ${type ?? '(automatic)'} is not recognized; translated as Table (across)`);
		addressed = mode.address.flatMap((s) => (mode.innermost ? shelves[s].slice(-1) : shelves[s]));
		addressed.push(...shelves.marks);
	}
	const addressedSet = new Set(addressed);
	const partitioned = [...seen].filter((id) => !addressedSet.has(id));

	const mapped = (id) => {
		const item = toItem(id, pills[id]);
		if (!item) warn(`Dimension ${id} has no Domo column; it was left out of the window`);
		return item;
	};
	const partitionBy = partitioned.map(mapped).filter(Boolean);
	const sortBy = new Map((worksheet.sorts ?? []).map((s) => [s.pillId, s]));
	const orderBy = [];
	for (const id of addressed) {
		const sort = sortBy.get(id);
		const measure = sort?.kind === 'computed' && sort.using && options.toMeasure?.(sort.using, pills[sort.using]);
		if (measure) {
			const item = mapped(id);
			orderBy.push({ expression: measure, direction: sort.direction ?? 'ASC' });
			if (item) orderBy.push({ ...item, direction: 'ASC' });
			continue;
		}
		if (sort?.kind === 'computed' && sort.using) {
			const by = toItem(sort.using, pills[sort.using]);
			if (by) {
				orderBy.push({ ...by, direction: sort.direction ?? 'ASC' });
				continue;
			}
			warn(`Sort of ${id} by ${sort.using} has no Domo equivalent; ordered by value instead`);
		}
		if (sort?.kind === 'manual') warn(`Manual sort on ${id} cannot order a window; ordered by value instead`);
		const item = mapped(id);
		if (item) orderBy.push({ ...item, direction: sort && sort.kind !== 'manual' ? (sort.direction ?? 'ASC') : 'ASC' });
	}
	return { partitionBy, orderBy, dimensions: [...seen], issues };
}

/** True for an ascending quick Rank: the workbook writes `rank-options='Competition,Ascending'`. */
export function rankAscending(attrs = {}) {
	const options = attrs['rank-options'];
	if (options !== undefined) return /(^|,)\s*Ascending\s*$/i.test(String(options));
	return String(attrs['rank-direction'] ?? attrs['sort-direction'] ?? 'DESC').toUpperCase() === 'ASC';
}

/** The XML writes Difference and WindowTotal where a pill prefix says diff and win/mavg. */
export function quickCalcType(type) {
	return { Difference: 'Diff', WindowTotal: 'MovingCalc' }[type] ?? type;
}

const NON_ADDITIVE = /^(COUNT\(DISTINCT|AVG|MEDIAN|MIN|MAX|STDDEV|VAR)/i;

/**
 * Domo SQL for a Tableau quick table calculation on a measure pill (Running Total, Difference, Percent Difference,
 * Percent Of, Percent of Total, Rank, Percentile, Moving Average), and its secondary calculation when it has one.
 *
 * @param {import('../../model/types.js').TableCalcIR} calc
 * @param {string} base Aggregate SQL of the pill, e.g. SUM(`Sales`)
 * @param {{ partitionBy?: object[], orderBy?: object[] }} addressing From tableCalcAddressing
 * @param {{ partitionBy?: object[], orderBy?: object[] }} [secondaryAddressing] The secondary calc's, from tableCalcAddressing
 * @returns {{ sql: string, note?: string } | { unsupported: string }}
 */
export function quickTableCalcSql(calc, base, addressing = {}, secondaryAddressing = addressing) {
	const primary = primaryCalcSql(calc, base, addressing);
	const second = calc.secondary;
	if (!second || primary.unsupported) return primary;
	const unsupported = { unsupported: `its secondary calculation ${second.type} of ${calc.type} needs a window over a window` };
	if (quickCalcType(calc.type) !== 'CumTotal') return unsupported;
	const partition = (secondaryAddressing.partitionBy ?? []).map(partitionItem);
	const order = (secondaryAddressing.orderBy ?? []).map(orderItem);
	const key = (a) => JSON.stringify([(a.partitionBy ?? []).map(partitionItem), (a.orderBy ?? []).map(orderItem)]);
	const runningSum = String(calc.attrs?.aggregation ?? 'Sum').toLowerCase() === 'sum';
	switch (quickCalcType(second.type)) {
		case 'PctTotal': {
			// Tableau divides by the TOTAL of the pill's measure, so a Pareto line ends at 100%.
			const note = NON_ADDITIVE.test(base) ? 'the total is the sum of the marks, which differs from Tableau when a value counts in more than one mark' : undefined;
			return { sql: `(${primary.sql}) / NULLIF(SUM(${base}) ${overClause(partition)}, 0)`, ...(note ? { note } : {}) };
		}
		case 'Diff':
			if (!runningSum || String(second.attrs?.['diff-options'] ?? 'Relative') !== 'Relative' || !order.length || key(addressing) !== key(secondaryAddressing)) return unsupported;
			return { sql: `CASE WHEN ROW_NUMBER() ${overClause(partition, order)} = 1 THEN ${NULL_VALUE} ELSE ${base} END` };
		default:
			return unsupported;
	}
}

function primaryCalcSql(calc, base, addressing) {
	const partition = (addressing.partitionBy ?? []).map(partitionItem);
	const order = (addressing.orderBy ?? []).map(orderItem);
	const attrs = calc.attrs ?? {};
	const over = (o = [], frame = '') => overClause(partition, o, frame);
	const needsOrder = () => (order.length ? undefined : { unsupported: `${calc.type} needs an order from the compute-using dimensions; none is in the view` });
	const type = quickCalcType(calc.type);
	switch (type) {
		case 'PctTotal':
			return { sql: `${base} / NULLIF(SUM(${base}) ${over()}, 0)` };
		case 'CumTotal': {
			const agg = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX', count: 'COUNT' }[String(attrs.aggregation ?? 'Sum').toLowerCase()];
			if (!agg) return { unsupported: `Running ${attrs.aggregation} has no Domo equivalent` };
			return needsOrder() ?? { sql: `${agg}(${base}) ${over(order, RUNNING)}` };
		}
		case 'Diff':
		case 'PctDiff':
		case 'PctValue': {
			const to = String(attrs['diff-options'] ?? 'Relative');
			const target =
				to === 'First' ? `FIRST_VALUE(${base}) ${over(order, WHOLE)}` : to === 'Last' ? `LAST_VALUE(${base}) ${over(order, WHOLE)}` : to === 'Next' ? `LEAD(${base}, 1) ${over(order)}` : `LAG(${base}, 1) ${over(order)}`;
			const diff = `${base} - ${target}`;
			const sql = { Diff: diff, PctDiff: `(${diff}) / NULLIF(ABS(${target}), 0)`, PctValue: `${base} / NULLIF(${target}, 0)` }[type];
			return needsOrder() ?? { sql };
		}
		case 'Rank': {
			const prefix = String(attrs.prefix ?? 'rank');
			const dir = rankAscending(attrs) ? 'ASC' : 'DESC';
			const ordered = [`${base} ${dir}`];
			if (prefix === 'rank_modified') return { sql: `COUNT(${base}) ${over(ordered, AT_OR_BEFORE)}` };
			const fn = { rank_dense: 'DENSE_RANK()', rank_unique: 'ROW_NUMBER()' }[prefix] ?? 'RANK()';
			return { sql: `${fn} ${over(ordered)}` };
		}
		case 'PctRank':
			return { sql: `(COUNT(${base}) ${over([`${base} ASC`], AT_OR_BEFORE)} - 1) / NULLIF(COUNT(${base}) ${over()} - 1, 0)` };
		case 'MovingCalc': {
			const agg = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX', count: 'COUNT' }[String(attrs.aggregation ?? 'Avg').toLowerCase()];
			let from = Number(attrs.from ?? -2);
			let to = Number(attrs.to ?? 0);
			if (attrs['window-options'] !== undefined && !/IncludeCurrent/i.test(attrs['window-options'])) {
				if (to === 0 && from < 0) to = -1;
				else if (from === 0 && to > 0) from = 1;
				else return { unsupported: 'A moving calculation without the current value around it has no single Domo window frame' };
			}
			if (!agg || !Number.isInteger(from) || !Number.isInteger(to)) return { unsupported: 'Moving calculation settings are not recognized' };
			const bound = (v) => (v === 0 ? 'CURRENT ROW' : v < 0 ? `${-v} PRECEDING` : `${v} FOLLOWING`);
			return needsOrder() ?? { sql: `${agg}(${base}) ${over(order, `ROWS BETWEEN ${bound(from)} AND ${bound(to)}`)}` };
		}
		default:
			return { unsupported: `Quick table calculation ${calc.type} has no Domo equivalent` };
	}
}
