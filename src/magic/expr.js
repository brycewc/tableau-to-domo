import { AGGREGATES } from './parser.js';

/**
 * Expression translation between Snowflake SQL and Magic ETL (Adrenaline) formulas, both directions, over the AST of
 * src/magic/parser.js. The same Magic function set serves Add Formula tiles, Group By expressions, Filter tiles and the
 * SQL tile, which accepts one SELECT in Domo's own SQL dialect (Adrenaline functions, not Snowflake's).
 *
 * @typedef {import('./parser.js').Expr} Expr
 * @typedef {{ severity: 'error'|'warning'|'info', code: string, message: string }} Issue
 *
 * @typedef {Object} ToMagicContext
 * @property {'formula'|'sql'} [target]                 `sql`: the SQL tile (column refs and subqueries are the hook's job)
 * @property {(node: Expr) => string} column           Text for a column reference
 * @property {Map<string, Expr>} [variables]            Session variables (upper-case name) for `$name`
 * @property {boolean} [aggregates]                     Aggregate calls are allowed (Group By expression, SQL tile)
 * @property {(fn: Expr) => string|undefined} [replace]  Text for a node computed elsewhere (an aggregate or window column)
 * @property {(node: Expr) => string} [subquery]       SQL tile only: text for a subquery node
 * @property {(issue: Issue) => void} [issue]
 * @property {boolean} [tryCastPatterns]               Emulate TRY_ casts with patterns (an engine without TRY_CAST)
 * @property {'adr'|'magic'} [engine]                   ADR (Magic ETL on Snowflake) runs some functions with Snowflake's semantics
 */

export class TranslateError extends Error {
	/**
	 * @param {string} message
	 * @param {{ fallback?: boolean }} [opts]  `fallback`: the SQL tile could still express it
	 */
	constructor(message, { fallback = false } = {}) {
		super(message);
		this.fallback = fallback;
	}
}

export const DATE_PARTS = {
	YEAR: 'YEAR', Y: 'YEAR', YY: 'YEAR', YYY: 'YEAR', YYYY: 'YEAR', YR: 'YEAR', YEARS: 'YEAR', YRS: 'YEAR',
	QUARTER: 'QUARTER', Q: 'QUARTER', QTR: 'QUARTER', QTRS: 'QUARTER', QUARTERS: 'QUARTER',
	MONTH: 'MONTH', MM: 'MONTH', MON: 'MONTH', MONS: 'MONTH', MONTHS: 'MONTH',
	WEEK: 'WEEK', W: 'WEEK', WK: 'WEEK', WEEKOFYEAR: 'WEEK', WOY: 'WEEK', WY: 'WEEK', WEEKS: 'WEEK',
	DAY: 'DAY', D: 'DAY', DD: 'DAY', DAYS: 'DAY', DAYOFMONTH: 'DAY',
	HOUR: 'HOUR', H: 'HOUR', HH: 'HOUR', HR: 'HOUR', HOURS: 'HOUR', HRS: 'HOUR',
	MINUTE: 'MINUTE', MI: 'MINUTE', MIN: 'MINUTE', MINUTES: 'MINUTE', MINS: 'MINUTE',
	SECOND: 'SECOND', S: 'SECOND', SEC: 'SECOND', SECONDS: 'SECOND', SECS: 'SECOND',
	MILLISECOND: 'MILLISECOND', MS: 'MILLISECOND', MSEC: 'MILLISECOND', MILLISECONDS: 'MILLISECOND',
	DAYOFWEEK: 'DAYOFWEEK', DOW: 'DAYOFWEEK', WEEKDAY: 'DAYOFWEEK', DW: 'DAYOFWEEK',
	DAYOFWEEKISO: 'DAYOFWEEKISO', DOW_ISO: 'DAYOFWEEKISO', WEEKDAY_ISO: 'DAYOFWEEKISO', DW_ISO: 'DAYOFWEEKISO',
	DAYOFYEAR: 'DAYOFYEAR', YEARDAY: 'DAYOFYEAR', DOY: 'DAYOFYEAR', DY: 'DAYOFYEAR',
	WEEKISO: 'WEEKISO', WEEK_ISO: 'WEEKISO', WEEKOFYEARISO: 'WEEKISO', WEEKOFYEAR_ISO: 'WEEKISO',
	YEAROFWEEK: 'YEAROFWEEK', YEAROFWEEKISO: 'YEAROFWEEKISO', EPOCH_SECOND: 'EPOCH_SECOND', EPOCH: 'EPOCH_SECOND'
};
const INTERVAL_UNITS = new Set(['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'MILLISECOND']);
const TRUNC_PARTS = { YEAR: 'YEAR', QUARTER: 'QUARTER', MONTH: 'MONTH', WEEK: 'ISOWEEK', DAY: 'DAY', HOUR: 'HOUR', MINUTE: 'MINUTE', SECOND: 'SECOND', MILLISECOND: 'MILLISECOND' };
const EXTRACT_FUNCTIONS = { YEAR: 'YEAR', QUARTER: 'QUARTER', MONTH: 'MONTH', DAY: 'DAYOFMONTH', HOUR: 'HOUR', MINUTE: 'MINUTE', SECOND: 'SECOND', DAYOFYEAR: 'DAYOFYEAR' };

export const STRING_TYPES = new Set(['VARCHAR', 'STRING', 'TEXT', 'CHAR', 'CHARACTER', 'NCHAR', 'NVARCHAR', 'NVARCHAR2', 'CHAR VARYING', 'CHARACTER VARYING', 'NCHAR VARYING']);
const INTEGER_TYPES = new Set(['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'BYTEINT']);
const FLOAT_TYPES = new Set(['FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE', 'DOUBLE PRECISION', 'REAL']);
const TIMESTAMP_TYPES = new Set(['TIMESTAMP', 'TIMESTAMP_NTZ', 'TIMESTAMP_LTZ', 'TIMESTAMP_TZ', 'DATETIME']);

/**
 * Magic ETL column type for a Snowflake data type, or undefined when it has none.
 * @param {{ name: string, args?: string[] }} type
 * @returns {'STRING'|'LONG'|'DECIMAL'|'DOUBLE'|'DATE'|'DATETIME'|'BOOLEAN'|undefined}
 */
export function magicType(type) {
	const name = type.name;
	if (STRING_TYPES.has(name)) return 'STRING';
	if (INTEGER_TYPES.has(name)) return 'LONG';
	if (name === 'NUMBER' || name === 'NUMERIC' || name === 'DECIMAL') return type.args?.length && Number(type.args[1] ?? 0) === 0 ? 'LONG' : type.args?.length ? 'DECIMAL' : 'LONG';
	if (FLOAT_TYPES.has(name)) return 'DOUBLE';
	if (name === 'DATE') return 'DATE';
	if (TIMESTAMP_TYPES.has(name)) return 'DATETIME';
	if (name === 'BOOLEAN') return 'BOOLEAN';
	return undefined;
}

const CAST_NAMES = { STRING: 'STRING', LONG: 'LONG', DECIMAL: 'DECIMAL', DOUBLE: 'DOUBLE', DATE: 'DATE', DATETIME: 'TIMESTAMP', BOOLEAN: 'BOOLEAN' };

/** Magic formula / Domo SQL string literal. Magic ETL reads backslashes literally (live-checked), so only quotes double. */
export function quoteString(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** Magic formula column reference. */
export function backtick(name) {
	return `\`${String(name).replace(/`/g, '``')}\``;
}

/** Snowflake identifier for a stored column name (quoted unless it is a plain upper-case name). */
export function sfIdent(name) {
	return /^[A-Z_][A-Z0-9_$]*$/.test(name) && !SF_RESERVED.has(name) ? name : `"${String(name).replace(/"/g, '""')}"`;
}
const SF_RESERVED = new Set(['ALL', 'ALTER', 'AND', 'ANY', 'AS', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CHECK', 'COLUMN', 'CONNECT', 'CREATE', 'CROSS', 'CURRENT', 'DELETE', 'DISTINCT', 'DROP', 'ELSE', 'EXISTS', 'FALSE', 'FOLLOWING', 'FOR', 'FROM', 'FULL', 'GRANT', 'GROUP', 'HAVING', 'ILIKE', 'IN', 'INCREMENT', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'LATERAL', 'LEFT', 'LIKE', 'LOCALTIME', 'LOCALTIMESTAMP', 'MINUS', 'NATURAL', 'NOT', 'NULL', 'OF', 'ON', 'OR', 'ORDER', 'QUALIFY', 'REGEXP', 'REVOKE', 'RIGHT', 'RLIKE', 'ROW', 'ROWS', 'SAMPLE', 'SELECT', 'SET', 'SOME', 'START', 'TABLE', 'TABLESAMPLE', 'THEN', 'TO', 'TRIGGER', 'TRUE', 'TRY_CAST', 'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'WHEN', 'WHENEVER', 'WHERE', 'WITH']);

/** Date part named by a function argument (bare word, string literal or EXTRACT part). */
export function datePart(node) {
	if (!node) return undefined;
	const raw = node.k === 'col' && node.parts.length === 1 ? node.parts[0].name : node.k === 'str' || node.k === 'part' ? node.v : undefined;
	return raw ? DATE_PARTS[String(raw).toUpperCase()] : undefined;
}

const SF_FORMAT = [
	['YYYY', '%Y'], ['YYY', '%Y'], ['YY', '%y'], ['MMMM', '%M'], ['MON', '%b'], ['MM', '%m'], ['DD', '%d'], ['DY', '%a'], ['HH24', '%H'], ['HH12', '%h'],
	['HH', '%H'], ['MI', '%i'], ['SS', '%S'], ['AM', '%p'], ['PM', '%p'], ['FF9', '%f'], ['FF6', '%f'], ['FF3', '%f'], ['FF', '%f']
];

/** Snowflake date format -> MySQL-style Magic format, or undefined when it has elements Magic lacks. */
export function snowflakeFormatToMagic(fmt) {
	let out = '';
	let i = 0;
	const upper = fmt.toUpperCase();
	while (i < fmt.length) {
		if (fmt[i] === '"') {
			const close = fmt.indexOf('"', i + 1);
			if (close === -1) return undefined;
			out += fmt.slice(i + 1, close).replace(/%/g, '%%');
			i = close + 1;
			continue;
		}
		const hit = SF_FORMAT.find(([k]) => upper.startsWith(k, i));
		if (hit) {
			out += hit[1];
			i += hit[0].length;
			continue;
		}
		if (/[A-Za-z]/.test(fmt[i])) return undefined;
		out += fmt[i] === '%' ? '%%' : fmt[i];
		i++;
	}
	return out;
}

/** MySQL-style Magic date format -> Snowflake format, or undefined. */
export function magicFormatToSnowflake(fmt) {
	const map = { Y: 'YYYY', y: 'YY', M: 'MMMM', b: 'MON', m: 'MM', c: 'MM', d: 'DD', e: 'DD', a: 'DY', H: 'HH24', k: 'HH24', h: 'HH12', I: 'HH12', l: 'HH12', i: 'MI', S: 'SS', s: 'SS', p: 'AM', f: 'FF6', T: 'HH24:MI:SS' };
	let out = '';
	for (let i = 0; i < fmt.length; i++) {
		if (fmt[i] === '%') {
			const c = fmt[++i];
			if (c === '%') out += '%';
			else if (map[c]) out += map[c];
			else return undefined;
		} else if (/[A-Za-z]/.test(fmt[i])) {
			let j = i;
			while (j < fmt.length && /[A-Za-z]/.test(fmt[j])) j++;
			out += `"${fmt.slice(i, j)}"`;
			i = j - 1;
		} else out += fmt[i];
	}
	return out;
}

const NUMERIC_TEXT = "'^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$'";
const ISO_DATE_TEXT = "'^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([ T].*)?$'";

/** Functions with the same name and argument order in Snowflake and Magic (Adrenaline). */
const SAME = new Set([
	'ABS', 'CEIL', 'FLOOR', 'ROUND', 'MOD', 'POWER', 'POW', 'SQRT', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM', 'LEFT', 'RIGHT', 'LPAD', 'RPAD', 'INITCAP',
	'COALESCE', 'NULLIF', 'IFNULL', 'CONCAT', 'SPLIT_PART', 'REGEXP_REPLACE', 'LAST_DAY', 'YEAR', 'MONTH', 'QUARTER', 'HOUR', 'MINUTE', 'SECOND', 'DAYOFYEAR', 'DAYOFMONTH'
]);
const AGG_SAME = new Set(['SUM', 'MIN', 'MAX', 'AVG', 'MEDIAN', 'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VAR_SAMP', 'VAR_POP', 'VARIANCE', 'VARIANCE_SAMP', 'VARIANCE_POP']);

/**
 * Magic ETL formula (or Domo SQL tile expression) for a Snowflake expression.
 * @param {Expr} node
 * @param {ToMagicContext} ctx
 * @returns {string}
 */
const COMPARISONS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);
const caseInsensitive = (n) => n?.k === 'fn' && String(n.name).toUpperCase() === 'COLLATE' && n.args?.[1]?.k === 'str' && /-ci\b|^ci\b/i.test(n.args[1].v);

export function toMagic(node, ctx) {
	const f = (n) => toMagic(n, ctx);
	const sql = ctx.target === 'sql';
	const replaced = ctx.replace?.(node);
	if (replaced !== undefined) return replaced;
	switch (node.k) {
		case 'num':
			return node.v;
		case 'str':
			return quoteString(node.v);
		case 'null':
			return 'NULL';
		case 'bool':
			return node.v ? MAGIC_TRUE : MAGIC_FALSE;
		case 'col':
			return ctx.column(node);
		case 'var': {
			const value = ctx.variables?.get(node.name.toUpperCase());
			if (!value) throw new TranslateError(`reads the session variable $${node.name}, which the script never SETs`);
			return f(value);
		}
		case 'paren':
			return `(${f(node.e)})`;
		case 'unary':
			return node.op === 'NOT' ? `NOT ${f(node.e)}` : `${node.op}${f(node.e)}`;
		case 'isnull':
			return `${f(node.e)} IS ${node.not ? 'NOT ' : ''}NULL`;
		case 'isbool': {
			const holds = node.v ? f(node.e) : `NOT (${f(node.e)})`;
			return `(CASE WHEN ${holds} THEN 1 ELSE 0 END) = ${node.not ? 0 : 1}`;
		}
		case 'isdistinct': {
			const l = f(node.l);
			const r = f(node.r);
			return `(CASE WHEN ${l} = ${r} OR (${l} IS NULL AND ${r} IS NULL) THEN 1 ELSE 0 END) = ${node.not ? 1 : 0}`;
		}
		case 'like': {
			if (node.escape !== undefined && node.escape !== '\\') throw new TranslateError(`uses LIKE ... ESCAPE '${node.escape}'`);
			const not = node.not ? 'NOT ' : '';
			if (node.ci) return `${f(node.e)} ${not}ILIKE ${f(node.p)}`;
			return `${f(node.e)} ${not}LIKE ${f(node.p)}`;
		}
		case 'in':
			if (node.query) {
				if (sql && ctx.subquery) return `${f(node.e)} ${node.not ? 'NOT ' : ''}IN ${ctx.subquery(node)}`;
				throw new TranslateError('has an IN (subquery) the planner did not turn into a join', { fallback: true });
			}
			if (node.items.some((x) => x.k === 'tuple') || node.e.k === 'tuple') throw new TranslateError('compares a tuple with IN');
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}IN (${node.items.map(f).join(', ')})`;
		case 'between':
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}BETWEEN ${f(node.lo)} AND ${f(node.hi)}`;
		case 'case': {
			const whens = node.whens.map(([w, t]) => `WHEN ${f(w)} THEN ${f(t)}`).join(' ');
			return `CASE${node.base ? ` ${f(node.base)}` : ''} ${whens}${node.else ? ` ELSE ${f(node.else)}` : ''} END`;
		}
		case 'bin': {
			if (node.op === '||') return `CONCAT(${concatArgs(node).map(f).join(', ')})`;
			if (node.op === '%') return `MOD(${f(node.l)}, ${f(node.r)})`;
			if (node.op === '<=>') return f({ k: 'isdistinct', l: node.l, r: node.r, not: true });
			if (COMPARISONS.has(node.op) && (caseInsensitive(node.l) || caseInsensitive(node.r))) return `LOWER(${f(node.l)}) ${node.op} LOWER(${f(node.r)})`;
			return `${f(node.l)} ${node.op} ${f(node.r)}`;
		}
		case 'cast':
			return castTo(node.e, node.type, node.try, ctx);
		case 'typed': {
			const t = node.type === 'DATE' ? 'DATE' : node.type === 'TIME' ? undefined : 'TIMESTAMP';
			if (!t) throw new TranslateError('uses a TIME literal');
			return `${t}(${quoteString(node.v)})`;
		}
		case 'interval':
			throw new TranslateError('uses an INTERVAL value outside DATEADD (date arithmetic with intervals)');
		case 'tuple':
			throw new TranslateError('uses a row value (a, b)');
		case 'star':
			throw new TranslateError('uses * inside an expression');
		case 'subquery':
			if (sql && ctx.subquery) return ctx.subquery(node);
			throw new TranslateError('has a scalar subquery the planner did not turn into a join', { fallback: true });
		case 'exists':
			if (sql && ctx.subquery) return `${node.not ? 'NOT ' : ''}EXISTS ${ctx.subquery(node)}`;
			throw new TranslateError('has an EXISTS subquery the planner did not turn into a join', { fallback: true });
		case 'fn':
			return fnToMagic(node, ctx);
		default:
			throw new TranslateError(`has an unsupported expression (${node.k})`);
	}
}

/** True when the expression is a condition (comparison, AND/OR/NOT, IS, LIKE, IN, BETWEEN, EXISTS, TRUE/FALSE). */
export function isCondition(e) {
	if (!e) return false;
	if (e.k === 'paren') return isCondition(e.e);
	if (e.k === 'bin') return ['=', '<>', '<', '>', '<=', '>=', 'AND', 'OR'].includes(e.op);
	if (e.k === 'unary') return e.op === 'NOT';
	return ['bool', 'isnull', 'isdistinct', 'isbool', 'like', 'in', 'between', 'exists'].includes(e.k) || (e.k === 'fn' && ['CONTAINS', 'STARTSWITH', 'ENDSWITH', 'RLIKE', 'REGEXP_LIKE', 'EQUAL_NULL'].includes(e.name));
}

// ADR reads TRUE and FALSE in a formula as column names (live-checked), so constant conditions are comparisons.
export const MAGIC_TRUE = '(1 = 1)';
export const MAGIC_FALSE = '(1 = 0)';

/**
 * Formula for an expression used as a column value. ADR rejects a bare condition as a value (`FY > 2024` fails to
 * parse, live-checked) and has no boolean literal, so a condition becomes the text Snowflake's TO_VARCHAR gives a
 * BOOLEAN ('true'/'false'), keeping NULL for an unknown result. Domo has no boolean column type either.
 * @param {Expr} node
 * @param {ToMagicContext} ctx
 */
export function toMagicValue(node, ctx) {
	if (!isCondition(node)) return toMagic(node, ctx);
	return conditionValue(toMagic(node, ctx));
}

/** @param {string} cond */
export function conditionValue(cond) {
	return `CASE WHEN ${cond} THEN 'true' WHEN NOT (${cond}) THEN 'false' END`;
}

/** A condition that holds when `cond` is not true (FALSE or NULL). */
export function notTrue(cond) {
	return `(CASE WHEN ${cond} THEN 1 ELSE 0 END) = 0`;
}

function concatArgs(node) {
	if (node.k === 'bin' && node.op === '||') return [...concatArgs(node.l), ...concatArgs(node.r)];
	return [node];
}

function castTo(e, type, tryCast, ctx) {
	const f = (n) => toMagic(n, ctx);
	const target = magicType(type);
	if (!target) throw new TranslateError(`casts to ${type.name}`);
	if (tryCast) return tryCastTo(e, target, ctx);
	if (target === 'DATE') return `DATE(${f(e)})`;
	if (target === 'DECIMAL' && type.args?.[1] !== undefined && Number(type.args[1]) > 0) return `ROUND(CAST(${f(e)} AS DECIMAL), ${Number(type.args[1])})`;
	return `CAST(${f(e)} AS ${CAST_NAMES[target]})`;
}

/**
 * TRY_ conversions. The expression docs list TRY_CAST as Magic-only, but ADR runs it (live-checked: TRY_CAST('Direct'
 * AS DECIMAL) is NULL). With `patterns` the value is matched against a pattern first instead, for engines without it.
 */
function tryCastTo(e, target, ctx) {
	if (!ctx.tryCastPatterns) return `TRY_CAST(${toMagic(e, ctx)} AS ${CAST_NAMES[target]})`;
	const text = `TRIM(CAST(${toMagic(e, ctx)} AS STRING))`;
	if (target === 'LONG' || target === 'DECIMAL' || target === 'DOUBLE') return `CASE WHEN REGEXP_REPLACE(${text}, ${NUMERIC_TEXT}, '') = '' AND ${text} <> '' THEN CAST(${text} AS ${CAST_NAMES[target]}) END`;
	if (target === 'DATE') return `CASE WHEN REGEXP_REPLACE(${text}, ${ISO_DATE_TEXT}, '') = '' AND ${text} <> '' THEN DATE(SUBSTRING(${text}, 1, 10)) END`;
	if (target === 'DATETIME') return `CASE WHEN REGEXP_REPLACE(${text}, ${ISO_DATE_TEXT}, '') = '' AND ${text} <> '' THEN CAST(${text} AS TIMESTAMP) END`;
	return `CAST(${toMagic(e, ctx)} AS STRING)`;
}

/** Domo's parser reads INTERVAL <primary> <unit> (dataShared JSqlParserCC.jjt), so `INTERVAL (a) + 3 YEAR` loses the + 3. */
function intervalAmount(node, ctx) {
	const text = toMagic(node, ctx);
	return ['num', 'col', 'paren'].includes(node.k) && !/^-/.test(text) ? text : `(${text})`;
}

function requireArgs(node, min, max = min) {
	if (node.args.length < min || node.args.length > max) throw new TranslateError(`calls ${node.name} with ${node.args.length} argument(s)`);
}

function fnToMagic(node, ctx) {
	const f = (n) => toMagic(n, ctx);
	const args = node.args;
	const name = node.name;
	const sql = ctx.target === 'sql';
	if (node.qualified) throw new TranslateError(`calls the user-defined function ${name}`);
	if (node.over) {
		if (!sql) throw new TranslateError(`has the window function ${name} where the planner did not expect one`, { fallback: true });
		return windowToSql(node, ctx);
	}
	if (AGGREGATES.has(name)) {
		if (!ctx.aggregates) throw new TranslateError(`has the aggregate ${name} where the planner did not expect one`, { fallback: true });
		return aggregateToMagic(node, ctx);
	}
	if (node.distinct) throw new TranslateError(`calls ${name}(DISTINCT ...)`);
	switch (name) {
		case 'COLLATE':
			requireArgs(node, 2);
			return f(args[0]);
		case 'NVL':
		case 'IFNULL':
			requireArgs(node, 2);
			return `IFNULL(${f(args[0])}, ${f(args[1])})`;
		case 'NVL2':
			requireArgs(node, 3);
			return `CASE WHEN ${f(args[0])} IS NOT NULL THEN ${f(args[1])} ELSE ${f(args[2])} END`;
		case 'ZEROIFNULL':
			requireArgs(node, 1);
			return `IFNULL(${f(args[0])}, 0)`;
		case 'NULLIFZERO':
			requireArgs(node, 1);
			return `NULLIF(${f(args[0])}, 0)`;
		case 'IFF':
		case 'IIF':
			requireArgs(node, 3);
			return `CASE WHEN ${f(args[0])} THEN ${f(args[1])} ELSE ${f(args[2])} END`;
		case 'DECODE': {
			if (args.length < 3) throw new TranslateError('calls DECODE with fewer than 3 arguments');
			const subject = f(args[0]);
			const whens = [];
			let k = 1;
			for (; k + 1 < args.length; k += 2) whens.push(args[k].k === 'null' ? `WHEN ${subject} IS NULL THEN ${f(args[k + 1])}` : `WHEN ${subject} = ${f(args[k])} THEN ${f(args[k + 1])}`);
			return `CASE ${whens.join(' ')}${k < args.length ? ` ELSE ${f(args[k])}` : ''} END`;
		}
		case 'EQUAL_NULL':
			requireArgs(node, 2);
			return f({ k: 'isdistinct', l: args[0], r: args[1], not: true });
		case 'GREATEST':
		case 'LEAST': {
			if (args.length < 1) throw new TranslateError(`calls ${name} with no arguments`);
			const cmp = name === 'GREATEST' ? '>=' : '<=';
			let acc = f(args[0]);
			for (const a of args.slice(1)) {
				const b = f(a);
				acc = `CASE WHEN ${acc} IS NULL OR ${b} IS NULL THEN NULL WHEN ${acc} ${cmp} ${b} THEN ${acc} ELSE ${b} END`;
			}
			return acc;
		}
		case 'TO_VARCHAR':
		case 'TO_CHAR':
		case 'TO_NVARCHAR':
			requireArgs(node, 1, 2);
			if (args.length === 2) {
				if (args[1].k !== 'str') throw new TranslateError(`calls ${name} with a non-literal format`);
				if (/[90]|\$|G|D(?![DY])|S$|MI$|FM/.test(args[1].v) && !/YY|MM|DD|HH|MI|SS|MON|DY/.test(args[1].v)) throw new TranslateError(`formats a number with ${name}(..., '${args[1].v}')`);
				const fmt = snowflakeFormatToMagic(args[1].v);
				if (fmt === undefined) throw new TranslateError(`uses the date format '${args[1].v}'`);
				return `DATE_FORMAT(${f(args[0])}, ${quoteString(fmt)})`;
			}
			return `CAST(${f(args[0])} AS STRING)`;
		case 'TO_NUMBER':
		case 'TO_NUMERIC':
		case 'TO_DECIMAL':
		case 'TRY_TO_NUMBER':
		case 'TRY_TO_NUMERIC':
		case 'TRY_TO_DECIMAL': {
			if (args.length === 2 || (args.length > 1 && args[1].k === 'str')) throw new TranslateError(`calls ${name} with a format`);
			// Snowflake's default scale is 0, so TO_NUMBER('12.5') is 13.
			const scale = args.length >= 3 ? Number(args[2].v) : 0;
			const base = name.startsWith('TRY_') ? tryCastTo(args[0], 'DECIMAL', ctx) : `CAST(${f(args[0])} AS DECIMAL)`;
			return `ROUND(${base}, ${scale})`;
		}
		case 'TO_DOUBLE':
		case 'TRY_TO_DOUBLE':
			requireArgs(node, 1);
			return name.startsWith('TRY_') ? tryCastTo(args[0], 'DOUBLE', ctx) : `CAST(${f(args[0])} AS DOUBLE)`;
		case 'TO_BOOLEAN':
			requireArgs(node, 1);
			return `CAST(${f(args[0])} AS BOOLEAN)`;
		case 'TO_DATE':
		case 'DATE':
		case 'TRY_TO_DATE':
			requireArgs(node, 1, 2);
			if (args.length === 2) {
				if (args[1].k !== 'str') throw new TranslateError(`calls ${name} with a non-literal format`);
				const fmt = snowflakeFormatToMagic(args[1].v);
				if (fmt === undefined) throw new TranslateError(`uses the date format '${args[1].v}'`);
				if (name === 'TRY_TO_DATE') throw new TranslateError('calls TRY_TO_DATE with a format');
				return `DATE(STR_TO_DATE(${f(args[0])}, ${quoteString(fmt)}))`;
			}
			if (args[0].k === 'num') throw new TranslateError(`calls ${name} on a number (epoch)`);
			return name === 'TRY_TO_DATE' ? tryCastTo(args[0], 'DATE', ctx) : `DATE(${f(args[0])})`;
		case 'TO_TIMESTAMP':
		case 'TO_TIMESTAMP_NTZ':
		case 'TO_TIMESTAMP_LTZ':
		case 'TO_TIMESTAMP_TZ':
		case 'TRY_TO_TIMESTAMP':
		case 'TRY_TO_TIMESTAMP_NTZ':
			requireArgs(node, 1, 2);
			if (args.length === 2) {
				const fmt = args[1].k === 'str' ? snowflakeFormatToMagic(args[1].v) : undefined;
				if (fmt === undefined || name.startsWith('TRY_')) throw new TranslateError(`calls ${name} with that format`);
				return `STR_TO_DATE(${f(args[0])}, ${quoteString(fmt)})`;
			}
			if (args[0].k === 'num') throw new TranslateError(`calls ${name} on a number (epoch)`);
			return name.startsWith('TRY_') ? tryCastTo(args[0], 'DATETIME', ctx) : `CAST(${f(args[0])} AS TIMESTAMP)`;
		case 'CURRENT_DATE':
			return 'CURRENT_DATE()';
		case 'CURRENT_TIMESTAMP':
		case 'SYSDATE':
		case 'GETDATE':
		case 'NOW':
		case 'LOCALTIMESTAMP':
		case 'SYSTIMESTAMP':
			return 'CURRENT_TIMESTAMP()';
		case 'DATEADD':
		case 'TIMESTAMPADD':
		case 'TIME_ADD':
		case 'TIMEADD': {
			requireArgs(node, 3);
			const part = datePart(args[0]);
			if (!INTERVAL_UNITS.has(part)) throw new TranslateError(`calls ${name} with the date part ${args[0].v ?? args[0].parts?.[0]?.name}`);
			return `DATE_ADD(${f(args[2])}, INTERVAL ${intervalAmount(args[1], ctx)} ${part})`;
		}
		case 'ADD_MONTHS':
			requireArgs(node, 2);
			return `DATE_ADD(${f(args[0])}, INTERVAL ${intervalAmount(args[1], ctx)} MONTH)`;
		case 'DATEDIFF':
		case 'TIMESTAMPDIFF':
		case 'TIMEDIFF': {
			requireArgs(node, 3);
			return dateDiff(datePart(args[0]), f(args[1]), f(args[2]), args[0], ctx);
		}
		case 'MONTHS_BETWEEN':
			throw new TranslateError('calls MONTHS_BETWEEN (fractional months)');
		case 'DATE_PART':
			requireArgs(node, 2);
			return extractPart(datePart(args[0]), args[1], ctx, args[0]);
		case 'DAY':
		case 'DAYOFWEEK':
		case 'DAYOFWEEKISO':
		case 'WEEK':
		case 'WEEKOFYEAR':
		case 'WEEKISO':
		case 'YEAROFWEEK':
		case 'YEAROFWEEKISO':
			requireArgs(node, 1);
			return extractPart(DATE_PARTS[name] ?? name, args[0], ctx);
		case 'DAYNAME':
			requireArgs(node, 1);
			return `DATE_FORMAT(${f(args[0])}, '%a')`;
		case 'MONTHNAME':
			requireArgs(node, 1);
			return `DATE_FORMAT(${f(args[0])}, '%b')`;
		case 'DATE_TRUNC':
		case 'TRUNC':
		case 'TRUNCATE': {
			if (name !== 'DATE_TRUNC' && (args.length === 1 || args[1].k === 'num' || args[1].k === 'unary')) {
				requireArgs(node, 1, 2);
				return `TRUNCATE(${f(args[0])}, ${args[1] ? f(args[1]) : '0'})`;
			}
			requireArgs(node, 2);
			const [partArg, dateArg] = name === 'DATE_TRUNC' ? args : [args[1], args[0]];
			const part = TRUNC_PARTS[datePart(partArg)];
			if (!part) throw new TranslateError(`truncates a date to ${partArg.v ?? partArg.parts?.[0]?.name}`);
			return `DATE_TRUNC('${weekTrunc(part, ctx)}', ${f(dateArg)})`;
		}
		case 'LENGTH':
		case 'LEN':
		case 'CHAR_LENGTH':
		case 'CHARACTER_LENGTH':
			requireArgs(node, 1);
			return `CHAR_LENGTH(${f(args[0])})`;
		case 'SUBSTR':
		case 'SUBSTRING':
			requireArgs(node, 2, 3);
			return `SUBSTRING(${args.map(f).join(', ')})`;
		case 'REPLACE':
			requireArgs(node, 2, 3);
			return `REPLACE(${f(args[0])}, ${f(args[1])}, ${args[2] ? f(args[2]) : "''"})`;
		case 'POSITION':
		case 'CHARINDEX':
			requireArgs(node, 2);
			return `INSTR(${f(args[1])}, ${f(args[0])})`;
		case 'CONTAINS':
			requireArgs(node, 2);
			return `INSTR(${f(args[0])}, ${f(args[1])}) > 0`;
		case 'STARTSWITH':
			requireArgs(node, 2);
			return `STR_STARTS_WITH(${f(args[0])}, ${f(args[1])})`;
		case 'ENDSWITH':
			requireArgs(node, 2);
			return `STR_ENDS_WITH(${f(args[0])}, ${f(args[1])})`;
		case 'LTRIM':
		case 'RTRIM':
		case 'TRIM':
			if (args.length !== 1) throw new TranslateError(`calls ${name} with characters to trim`);
			return `${name}(${f(args[0])})`;
		case 'SPLIT_PART':
			requireArgs(node, 3);
			if (args[2].k === 'unary' || (args[2].k === 'num' && Number(args[2].v) <= 0)) throw new TranslateError('calls SPLIT_PART with a part number counted from the end');
			return `SPLIT_PART(${args.map(f).join(', ')})`;
		case 'CEILING':
			requireArgs(node, 1, 2);
			return `CEIL(${args.map(f).join(', ')})`;
		case 'DIV0':
			requireArgs(node, 2);
			return `CASE WHEN ${f(args[1])} = 0 THEN 0 ELSE ${f(args[0])} / ${f(args[1])} END`;
		case 'DIV0NULL':
			requireArgs(node, 2);
			return `CASE WHEN ${f(args[1])} = 0 OR ${f(args[1])} IS NULL THEN 0 ELSE ${f(args[0])} / ${f(args[1])} END`;
		case 'SIGN':
			requireArgs(node, 1);
			return `CASE WHEN ${f(args[0])} > 0 THEN 1 WHEN ${f(args[0])} < 0 THEN -1 WHEN ${f(args[0])} = 0 THEN 0 END`;
		case 'SQUARE':
			requireArgs(node, 1);
			return `POWER(${f(args[0])}, 2)`;
		case 'RLIKE':
		case 'REGEXP_LIKE':
			throw new TranslateError(`calls ${name} (Adrenaline has no regular-expression match)`);
		case 'UUID_STRING':
		case 'RANDOM':
		case 'SEQ4':
		case 'SEQ8':
			throw new TranslateError(`calls ${name}, which is not deterministic`);
		default:
			if (SAME.has(name)) return `${name}(${args.map(f).join(', ')})`;
	}
	throw new TranslateError(`calls ${name}, which t2d does not translate to a Magic ETL formula`);
}

/**
 * Week truncation. ADR rejects 'ISOWEEK' (live-checked) but hands 'WEEK' to Snowflake, whose default WEEK_START starts
 * weeks on Monday; Domo's own engine needs 'ISOWEEK' for Monday weeks ('WEEK' follows the locale).
 */
function weekTrunc(part, ctx) {
	if (part !== 'ISOWEEK') return part;
	if (ctx.engine === 'adr') return 'WEEK';
	ctx.issue?.({ severity: 'info', code: 'magic.week-start', message: 'Weeks are taken to start on Monday (Snowflake WEEK_START 0/1).' });
	return 'ISOWEEK';
}

/**
 * Snowflake DATEDIFF counts unit boundaries crossed from `a` to `b`. ADR fails on the unit form of Magic's DATEDIFF
 * (it reads the unit as a column, live-checked) but runs the two-argument form, which returns days `b` - `a`.
 */
function dateDiff(part, a, b, raw, ctx) {
	const days = `DATEDIFF(${b}, ${a})`;
	switch (part) {
		case 'DAY':
			return days;
		case 'WEEK': {
			const week = weekTrunc('ISOWEEK', ctx);
			return `(DATEDIFF(DATE_TRUNC('${week}', ${b}), DATE_TRUNC('${week}', ${a})) / 7)`;
		}
		case 'MONTH':
			return `((YEAR(${b}) - YEAR(${a})) * 12 + MONTH(${b}) - MONTH(${a}))`;
		case 'QUARTER':
			return `((YEAR(${b}) - YEAR(${a})) * 4 + QUARTER(${b}) - QUARTER(${a}))`;
		case 'YEAR':
			return `(YEAR(${b}) - YEAR(${a}))`;
		case 'HOUR':
			return `(${days} * 24 + HOUR(${b}) - HOUR(${a}))`;
		case 'MINUTE':
			return `((${days} * 24 + HOUR(${b}) - HOUR(${a})) * 60 + MINUTE(${b}) - MINUTE(${a}))`;
		case 'SECOND':
			return `(((${days} * 24 + HOUR(${b}) - HOUR(${a})) * 60 + MINUTE(${b}) - MINUTE(${a})) * 60 + SECOND(${b}) - SECOND(${a}))`;
		default:
			throw new TranslateError(`calls DATEDIFF with the date part ${raw?.v ?? raw?.parts?.[0]?.name ?? part}`);
	}
}

function extractPart(part, arg, ctx, raw) {
	const v = toMagic(arg, ctx);
	if (EXTRACT_FUNCTIONS[part]) return `${EXTRACT_FUNCTIONS[part]}(${v})`;
	switch (part) {
		case 'DAYOFWEEK':
			// ADR hands DAYOFWEEK to Snowflake (0 = Sunday, live-checked); Domo's own engine counts 1 = Sunday.
			if (ctx.engine === 'adr') return `DAYOFWEEK(${v})`;
			ctx.issue?.({ severity: 'info', code: 'magic.week-start', message: 'DAYOFWEEK assumes Snowflake\'s default WEEK_START (0 = Sunday).' });
			return `(DAYOFWEEK(${v}) - 1)`;
		case 'DAYOFWEEKISO':
			return `(WEEKDAY(${v}) + 1)`;
		case 'WEEK':
		case 'WEEKISO':
			ctx.issue?.({ severity: 'info', code: 'magic.week-of-year', message: 'Week of year uses ISO weeks (Snowflake WEEK_OF_YEAR_POLICY 0).' });
			return `WEEK(${v}, 3)`;
		default:
			throw new TranslateError(`extracts the date part ${part ?? raw?.v ?? raw?.parts?.[0]?.name ?? '?'}`);
	}
}

/** Group By expression (or SQL tile aggregate) for a Snowflake aggregate call. */
function aggregateToMagic(node, ctx) {
	const f = (n) => toMagic({ ...n }, { ...ctx, aggregates: false });
	const args = node.args;
	if (node.over) throw new TranslateError(`uses ${node.name} as a window function`, { fallback: true });
	switch (node.name) {
		case 'COUNT':
			if (node.star) return 'COUNT(*)';
			if (args.length !== 1) throw new TranslateError('calls COUNT with several columns');
			return node.distinct ? `COUNT(DISTINCT ${f(args[0])})` : `COUNT(${f(args[0])})`;
		case 'COUNT_IF':
			return `SUM(CASE WHEN ${f(args[0])} THEN 1 ELSE 0 END)`;
		case 'APPROX_COUNT_DISTINCT':
			return `COUNT(DISTINCT ${f(args[0])})`;
		case 'ANY_VALUE':
			ctx.issue?.({ severity: 'info', code: 'magic.any-value', message: 'ANY_VALUE becomes MIN (any value of the group).' });
			return `MIN(${f(args[0])})`;
		case 'LISTAGG':
		case 'GROUP_CONCAT': {
			if (node.within?.length) ctx.issue?.({ severity: 'warning', code: 'magic.listagg-order', message: 'LISTAGG ... WITHIN GROUP (ORDER BY) loses its order in Magic ETL; the list order is arbitrary.' });
			if (node.distinct) throw new TranslateError('calls LISTAGG(DISTINCT ...)', { fallback: false });
			return `LISTAGG(${f(args[0])}${args[1] ? `, ${f(args[1])}` : ''})`;
		}
		case 'PERCENTILE_CONT':
		case 'PERCENTILE_DISC':
			throw new TranslateError(`calls ${node.name}`);
		default:
			if (AGG_SAME.has(node.name)) {
				if (node.distinct && node.name !== 'MIN' && node.name !== 'MAX') {
					if (ctx.target === 'sql') return `${node.name}(DISTINCT ${args.map(f).join(', ')})`;
					throw new TranslateError(`calls ${node.name}(DISTINCT ...)`, { fallback: true });
				}
				return `${node.name}(${args.map(f).join(', ')})`;
			}
	}
	throw new TranslateError(`calls the aggregate ${node.name}, which t2d does not translate`);
}

const WINDOW_FUNCTIONS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTILE', 'PERCENT_RANK', 'CUME_DIST', 'SUM', 'MIN', 'MAX', 'AVG', 'COUNT']);

/** SQL tile text of a window call. */
function windowToSql(node, ctx) {
	if (!WINDOW_FUNCTIONS.has(node.name)) throw new TranslateError(`uses ${node.name} as a window function`);
	if (node.over.ref) throw new TranslateError('uses a named window');
	const inner = { ...node, over: undefined };
	const call = AGGREGATES.has(node.name) ? aggregateToMagic(inner, { ...ctx, aggregates: true }) : `${node.name}(${node.args.map((a) => toMagic(a, ctx)).join(', ')})${node.ignoreNulls ? ' IGNORE NULLS' : ''}`;
	return `${call} OVER (${windowSpecText(node.over, (e) => toMagic(e, ctx))})`;
}

const orderText = (items, f) => items.map((o) => `${f(o.e)}${o.desc ? ' DESC' : ''}${o.nulls ? ` NULLS ${o.nulls}` : ''}`).join(', ');

/** A Snowflake call printed as written, for SQL that came from Snowflake and runs there again. */
function nativeCall(node, f) {
	const args = node.args.map((x) => (x.named ? `${x.named} => ${f(x)}` : f(x)));
	const inner = node.star ? '*' : `${node.distinct ? 'DISTINCT ' : ''}${args.join(', ')}${node.argOrder ? ` ORDER BY ${orderText(node.argOrder, f)}` : ''}`;
	let call = `${node.name}(${inner})${node.ignoreNulls ? ' IGNORE NULLS' : ''}`;
	if (node.within) call += ` WITHIN GROUP (ORDER BY ${orderText(node.within, f)})`;
	if (node.over) call += ` OVER (${windowSpecText(node.over, f)})`;
	return call;
}

export function windowSpecText(spec, f) {
	const parts = [];
	if (spec.partition.length) parts.push(`PARTITION BY ${spec.partition.map(f).join(', ')}`);
	if (spec.order.length) parts.push(`ORDER BY ${spec.order.map((o) => `${f(o.e)}${o.desc ? ' DESC' : ''}${o.nulls ? ` NULLS ${o.nulls}` : ''}`).join(', ')}`);
	if (spec.frame) {
		const b = (x) => (x.kind === 'UNBOUNDED' ? `UNBOUNDED ${x.dir}` : x.kind === 'CURRENT' ? 'CURRENT ROW' : `${x.n} ${x.dir}`);
		parts.push(`${spec.frame.unit} BETWEEN ${b(spec.frame.start)} AND ${b(spec.frame.end)}`);
	}
	return parts.join(' ');
}

/* Magic ETL formula -> Snowflake SQL */

/**
 * @typedef {Object} ToSnowflakeContext
 * @property {(node: Expr) => string} [column]    Text for a column reference (default: quoted stored name)
 * @property {(node: Expr) => string} [subquery]  Text for a subquery node
 */

const MAGIC_TO_SF_SAME = new Set([
	'ABS', 'CEIL', 'FLOOR', 'ROUND', 'MOD', 'POWER', 'SQRT', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM', 'LEFT', 'RIGHT', 'LPAD', 'RPAD', 'INITCAP', 'COALESCE',
	'NULLIF', 'IFNULL', 'CONCAT', 'SPLIT_PART', 'REGEXP_REPLACE', 'LAST_DAY', 'YEAR', 'MONTH', 'QUARTER', 'HOUR', 'MINUTE', 'SECOND', 'DAYOFYEAR', 'DAYOFMONTH',
	'SUM', 'MIN', 'MAX', 'AVG', 'MEDIAN', 'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VAR_SAMP', 'VAR_POP', 'VARIANCE', 'LISTAGG', 'SUBSTRING', 'REPLACE', 'DATE'
]);
const SF_CAST = { STRING: 'VARCHAR', LONG: 'NUMBER(38,0)', DECIMAL: 'NUMBER(38,10)', DOUBLE: 'DOUBLE', DATE: 'DATE', TIMESTAMP: 'TIMESTAMP_NTZ', DATETIME: 'TIMESTAMP_NTZ', BOOLEAN: 'BOOLEAN' };

const sfString = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;

/**
 * Snowflake SQL for a Magic ETL formula AST (parseExpr(text, { formula: true })) or a Snowflake AST.
 * @param {Expr} node
 * @param {ToSnowflakeContext} [ctx]
 * @returns {string}
 */
export function toSnowflake(node, ctx = {}) {
	const f = (n) => toSnowflake(n, ctx);
	switch (node.k) {
		case 'num':
			return node.v;
		case 'str':
			return sfString(node.v);
		case 'null':
			return 'NULL';
		case 'bool':
			return node.v ? 'TRUE' : 'FALSE';
		case 'col':
			return ctx.column ? ctx.column(node) : node.parts.map((p) => sfIdent(p.quoted ? p.name : p.name.toUpperCase())).join('.');
		case 'paren':
			return `(${f(node.e)})`;
		case 'unary':
			return node.op === 'NOT' ? `NOT ${f(node.e)}` : `${node.op}${f(node.e)}`;
		case 'isnull':
			return `${f(node.e)} IS ${node.not ? 'NOT ' : ''}NULL`;
		case 'isdistinct':
			return `${f(node.l)} IS ${node.not ? 'NOT ' : ''}DISTINCT FROM ${f(node.r)}`;
		case 'var': {
			const value = ctx.variables?.get(node.name.toUpperCase());
			if (!value) throw new TranslateError(`reads the session variable $${node.name}, which the script never SETs`);
			return f(value);
		}
		case 'isbool':
			return `${f(node.e)} IS ${node.not ? 'NOT ' : ''}${node.v ? 'TRUE' : 'FALSE'}`;
		case 'like':
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}${node.ci ? 'ILIKE' : 'LIKE'} ${f(node.p)}`;
		case 'in':
			if (node.query) {
				if (!ctx.subquery) throw new TranslateError('has an IN subquery in a formula');
				return `${f(node.e)} ${node.not ? 'NOT ' : ''}IN ${ctx.subquery(node)}`;
			}
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}IN (${node.items.map(f).join(', ')})`;
		case 'subquery':
			if (!ctx.subquery) throw new TranslateError('has a subquery in a formula');
			return ctx.subquery(node);
		case 'exists':
			if (!ctx.subquery) throw new TranslateError('has an EXISTS subquery in a formula');
			return `${node.not ? 'NOT ' : ''}EXISTS ${ctx.subquery(node)}`;
		case 'between':
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}BETWEEN ${f(node.lo)} AND ${f(node.hi)}`;
		case 'case':
			return `CASE${node.base ? ` ${f(node.base)}` : ''} ${node.whens.map(([w, t]) => `WHEN ${f(w)} THEN ${f(t)}`).join(' ')}${node.else ? ` ELSE ${f(node.else)}` : ''} END`;
		case 'bin':
			if (node.op === '||') return `${f(node.l)} || ${f(node.r)}`;
			if (node.op === '<=>') return `${f(node.l)} IS NOT DISTINCT FROM ${f(node.r)}`;
			return `${f(node.l)} ${node.op} ${f(node.r)}`;
		case 'cast': {
			const t = SF_CAST[node.type.name] ?? node.type.name;
			return `${node.try ? 'TRY_CAST' : 'CAST'}(${f(node.e)} AS ${t})`;
		}
		case 'typed':
			return `${node.type} ${sfString(node.v)}`;
		case 'interval':
			throw new TranslateError('uses INTERVAL outside DATE_ADD');
		case 'fn':
			return fnToSnowflake(node, ctx);
		default:
			throw new TranslateError(`has an unsupported formula element (${node.k})`);
	}
}

function fnToSnowflake(node, ctx) {
	const f = (n) => toSnowflake(n, ctx);
	const a = node.args;
	const name = node.name;
	if (ctx.native) return nativeCall(node, f);
	if (node.over) {
		const call = `${name}(${node.star ? '*' : `${node.distinct ? 'DISTINCT ' : ''}${a.map(f).join(', ')}`})`;
		return `${call} OVER (${windowSpecText(node.over, f)})`;
	}
	const intervalCall = (sign) => {
		const iv = a[1];
		if (iv?.k !== 'interval') throw new TranslateError(`calls ${name} without an INTERVAL`);
		const value = typeof iv.value === 'string' ? iv.value : f(iv.value);
		return `DATEADD(${iv.unit}, ${sign}${sign ? `(${value})` : value}, ${f(a[0])})`;
	};
	switch (name) {
		case 'COUNT':
			if (node.star) return 'COUNT(*)';
			return `COUNT(${node.distinct ? 'DISTINCT ' : ''}${a.map(f).join(', ')})`;
		case 'COUNT_DISTINCT':
		case 'APPROXIMATE_COUNT_DISTINCT':
			return `COUNT(DISTINCT ${f(a[0])})`;
		case 'DATE_ADD':
		case 'ADDDATE':
			return intervalCall('');
		case 'DATE_SUB':
		case 'SUBDATE':
			return intervalCall('-');
		case 'DATEDIFF':
			if (a.length === 2) return `DATEDIFF(DAY, ${f(a[1])}, ${f(a[0])})`;
			return `DATEDIFF(${a[0].k === 'col' ? a[0].parts[0].name.toUpperCase() : a[0].v}, ${f(a[1])}, ${f(a[2])})`;
		case 'DATE_TRUNC':
		case 'TIMESTAMP_TRUNC':
		case 'TRUNC': {
			const [dateArg, partArg] = name === 'DATE_TRUNC' ? [a[1], a[0]] : [a[0], a[1]];
			const part = String(partArg ? (partArg.v ?? partArg.parts?.[0]?.name) : 'DAY').toUpperCase().replace(/^ISOWEEK$/, 'WEEK');
			return `DATE_TRUNC('${part}', ${f(dateArg)})`;
		}
		case 'TRUNCATE':
			return `TRUNC(${a.map(f).join(', ')})`;
		case 'DAYOFWEEK':
			return `(DAYOFWEEK(${f(a[0])}) + 1)`;
		case 'WEEKDAY':
			return `(DAYOFWEEKISO(${f(a[0])}) - 1)`;
		case 'WEEK':
		case 'WEEKOFYEAR':
			return `WEEKISO(${f(a[0])})`;
		case 'DAY':
			return `DAY(${f(a[0])})`;
		case 'NOW':
		case 'CURRENT_TIMESTAMP':
		case 'CURDATETIME':
		case 'SYSDATE':
			return 'CURRENT_TIMESTAMP()';
		case 'CURRENT_DATE':
		case 'CURDATE':
		case 'TODAY':
			return 'CURRENT_DATE()';
		case 'LENGTH':
		case 'CHAR_LENGTH':
			return `LENGTH(${f(a[0])})`;
		case 'INSTR':
			return `POSITION(${f(a[1])}, ${f(a[0])})`;
		case 'STR_CONTAINS':
			return `CONTAINS(${f(a[0])}, ${f(a[1])})`;
		case 'STR_STARTS_WITH':
			return `STARTSWITH(${f(a[0])}, ${f(a[1])})`;
		case 'STR_ENDS_WITH':
			return `ENDSWITH(${f(a[0])}, ${f(a[1])})`;
		case 'DATE_FORMAT': {
			const fmt = a[1]?.k === 'str' ? magicFormatToSnowflake(a[1].v) : undefined;
			if (fmt === undefined) throw new TranslateError('calls DATE_FORMAT with a format t2d cannot convert');
			return `TO_CHAR(${f(a[0])}, ${sfString(fmt)})`;
		}
		case 'STR_TO_DATE': {
			const fmt = a[1]?.k === 'str' ? magicFormatToSnowflake(a[1].v) : undefined;
			if (fmt === undefined) throw new TranslateError('calls STR_TO_DATE with a format t2d cannot convert');
			return `TO_TIMESTAMP(${f(a[0])}, ${sfString(fmt)})`;
		}
		case 'TIMESTAMP':
		case 'DATETIME':
			return `TO_TIMESTAMP_NTZ(${f(a[0])})`;
		case 'LCASE':
			return `LOWER(${f(a[0])})`;
		case 'UCASE':
			return `UPPER(${f(a[0])})`;
		case 'POW':
			return `POWER(${a.map(f).join(', ')})`;
		case 'DIV':
			return `TRUNC(${f(a[0])} / ${f(a[1])})`;
		case 'GROUP_CONCAT':
			return `LISTAGG(${a.map(f).join(', ')})`;
		case 'ROW_NUMBER':
		case 'RANK':
		case 'DENSE_RANK':
			throw new TranslateError(`calls ${name} without a window`);
		default:
			if (MAGIC_TO_SF_SAME.has(name)) return `${name}(${node.distinct ? 'DISTINCT ' : ''}${a.map(f).join(', ')})`;
	}
	throw new TranslateError(`calls the Magic ETL function ${name}, which t2d does not translate to Snowflake`);
}

/**
 * Translate one Snowflake SQL expression to a Magic ETL formula, with column references written as backticked names.
 * @param {Expr} node
 * @param {{ variables?: Map<string, Expr>, aggregates?: boolean, issue?: (i: Issue) => void, column?: (node: Expr) => string }} [opts]
 */
export function snowflakeToFormula(node, opts = {}) {
	return toMagic(node, { column: (c) => backtick(c.parts.at(-1).quoted ? c.parts.at(-1).name : c.parts.at(-1).name.toUpperCase()), ...opts });
}
