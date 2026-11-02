/** Operator precedence of emitted SQL, lowest first. Matches MySQL. */
export const PREC = { OR: 10, AND: 20, NOT: 30, CMP: 40, ADD: 50, MUL: 60, UNARY: 80, PRIMARY: 100 };

/**
 * @typedef {'string'|'integer'|'real'|'date'|'datetime'|'boolean'|'null'|'spatial'|'unknown'} CalcType
 *
 * @typedef {Object} Flags
 * @property {boolean} [agg]       Contains an aggregate (or table calc) at this level
 * @property {boolean} [lod]       Contains an LOD that is not inside an aggregate
 * @property {boolean} [rowRef]    Contains a row-level column reference outside any aggregate
 * @property {boolean} [tableCalc]
 *
 * @typedef {Object} Emitted
 * @property {string} sql
 * @property {CalcType} type
 * @property {number} prec
 * @property {Flags} [flags]
 * @property {string[]} [concat]   Parts when the node is a CONCAT built from string '+'
 */

// Beast Mode rejects the NULL keyword with PARSING_ERROR, even as THEN/ELSE value.
export const NULL_VALUE = 'NULLIF(1, 1)';

/** Parenthesize `r` when it binds looser than `min`. */
export function wrap(r, min) {
	return r.prec < min ? `(${r.sql})` : r.sql;
}

export function quoteString(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

export function fn(name, ...parts) {
	return `${name}(${parts.join(', ')})`;
}

export const isNumeric = (t) => t === 'integer' || t === 'real';
export const isDateType = (t) => t === 'date' || t === 'datetime';

/** Common type of branches (IF/CASE results, IFNULL arguments). */
export function unifyTypes(types) {
	const known = types.filter((t) => t && t !== 'null' && t !== 'unknown');
	if (!known.length) return types.includes('null') && types.every((t) => t === 'null') ? 'null' : 'unknown';
	if (known.every((t) => isNumeric(t))) return known.includes('real') ? 'real' : 'integer';
	if (known.every((t) => isDateType(t))) return known.includes('datetime') ? 'datetime' : 'date';
	if (known.includes('string')) return 'string';
	return known[0];
}

const TYPE_ALIASES = {
	string: 'string',
	str: 'string',
	integer: 'integer',
	int: 'integer',
	long: 'integer',
	real: 'real',
	double: 'real',
	decimal: 'real',
	float: 'real',
	number: 'real',
	date: 'date',
	datetime: 'datetime',
	timestamp: 'datetime',
	boolean: 'boolean',
	bool: 'boolean',
	spatial: 'spatial'
};

/** Accepts Tableau datatypes and Domo column types. */
export function normalizeType(datatype) {
	return TYPE_ALIASES[String(datatype ?? '').toLowerCase()] || 'unknown';
}

const DOMO_TYPES = { string: 'STRING', integer: 'LONG', real: 'DOUBLE', date: 'DATE', datetime: 'DATETIME', boolean: 'STRING' };

/** @returns {import('../../model/types.js').DomoColumnType|undefined} */
export function toDomoType(type) {
	return DOMO_TYPES[type];
}

export const ignoresCase = (r) => Boolean(r?.flags?.ignoreCase);

// ICU strength 1 or 2 (`LEN_RUS_S2`, `LEN_RUS_S2_VWIN`) ignores case; `binary`, `LROOT` and `LEN_RUS` do not.
export const collationIgnoresCase = (name) => /_S[12](?:_|$)/.test(String(name ?? ''));

const AGGREGATE_CALL = /\b(SUM|AVG|MIN|MAX|COUNT|MEDIAN|STDDEV|STDDEV_POP|STDDEV_SAMP|VARIANCE|VAR|VAR_POP|VAR_SAMP)\s*\(/iy;
const ANY_AGGREGATE = new RegExp(AGGREGATE_CALL.source, 'i');
const QUOTED = /'(?:[^'\\]|\\.|'')*'|`[^`]*`|"(?:[^"\\]|\\.)*"/y;
const withoutLiterals = (sql) => sql.replace(new RegExp(QUOTED.source, 'g'), "''");

function closingParen(sql, open) {
	let depth = 0;
	for (let i = open; i < sql.length; i++) {
		QUOTED.lastIndex = i;
		const quoted = QUOTED.exec(sql);
		if (quoted) {
			i += quoted[0].length - 1;
			continue;
		}
		if (sql[i] === '(') depth += 1;
		else if (sql[i] === ')' && --depth === 0) return i;
	}
	return -1;
}

/**
 * An aggregate expression with every aggregate limited to the rows where `condition` holds: `SUM(x)` becomes
 * `SUM(CASE WHEN condition THEN x END)`, `COUNT(*)` counts `1`. Undefined when it holds no aggregate, nests one, or uses
 * a window, subquery or other Beast Mode, whose rows the condition cannot reach.
 * @param {string} sql
 * @param {string} condition
 * @returns {string|undefined}
 */
export function conditionAggregates(sql, condition) {
	if (/\bOVER\s*\(|\bSELECT\b|\bDOMO_BEAST_MODE\s*\(/i.test(withoutLiterals(sql))) return undefined;
	let out = '';
	let found = 0;
	for (let i = 0; i < sql.length; ) {
		QUOTED.lastIndex = i;
		const quoted = QUOTED.exec(sql);
		if (quoted) {
			out += quoted[0];
			i += quoted[0].length;
			continue;
		}
		AGGREGATE_CALL.lastIndex = i;
		const call = AGGREGATE_CALL.exec(sql);
		if (!call) {
			out += sql[i++];
			continue;
		}
		const open = i + call[0].length - 1;
		const close = closingParen(sql, open);
		if (close < 0) return undefined;
		const inner = sql.slice(open + 1, close);
		if (ANY_AGGREGATE.test(withoutLiterals(inner))) return undefined;
		const distinct = /^\s*DISTINCT\s+/i.exec(inner);
		const arg = (distinct ? inner.slice(distinct[0].length) : inner).trim();
		out += `${call[1]}(${distinct ? 'DISTINCT ' : ''}CASE WHEN ${condition} THEN ${arg === '*' ? '1' : arg} END)`;
		found += 1;
		i = close + 1;
	}
	return found ? out : undefined;
}
