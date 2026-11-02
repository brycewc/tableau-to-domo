/** Derivation prefix -> derivation name, as written in column-instance@derivation. */
export const PREFIX_TO_DERIVATION = {
	none: 'None',
	sum: 'Sum',
	avg: 'Avg',
	cnt: 'Count',
	ctd: 'CountD',
	min: 'Min',
	max: 'Max',
	med: 'Median',
	attr: 'Attribute',
	usr: 'User',
	stdev: 'Stdev',
	stdevp: 'Stdevp',
	var: 'Var',
	varp: 'Varp',
	kurt: 'Kurtosis',
	skew: 'Skewness',
	collect: 'Collect',
	yr: 'Year',
	qr: 'Quarter',
	mn: 'Month',
	wk: 'Week',
	dy: 'Day',
	wd: 'Weekday',
	hr: 'Hour',
	mi: 'Minute',
	sc: 'Second',
	my: 'Month-Year',
	mdy: 'MDY',
	tyr: 'Year-Trunc',
	tqr: 'Quarter-Trunc',
	tmn: 'Month-Trunc',
	twk: 'Week-Trunc',
	tdy: 'Day-Trunc',
	thr: 'Hour-Trunc',
	tmi: 'Minute-Trunc',
	tsc: 'Second-Trunc',
	iyr: 'ISO-Year',
	iqr: 'ISO-Quarter',
	iwk: 'ISO-Week',
	iwd: 'ISO-Weekday',
	tiyr: 'ISO-Year-Trunc',
	tiqr: 'ISO-Quarter-Trunc',
	tiwk: 'ISO-Week-Trunc',
	io: 'InOut'
};

const DERIVATION_TO_PREFIX = Object.fromEntries(
	Object.entries(PREFIX_TO_DERIVATION).map(([prefix, derivation]) => [derivation.toLowerCase(), prefix])
);
Object.assign(DERIVATION_TO_PREFIX, { average: 'avg', countd: 'ctd', count: 'cnt', median: 'med', user: 'usr', attribute: 'attr', 'month-day-year': 'mdy' });

const AGGREGATE_PREFIXES = new Set(['sum', 'avg', 'cnt', 'ctd', 'min', 'max', 'med', 'attr', 'usr', 'stdev', 'stdevp', 'var', 'varp', 'kurt', 'skew', 'collect']);

const DATE_PARTS = { yr: 'year', qr: 'quarter', mn: 'month', wk: 'week', dy: 'day', wd: 'weekday', hr: 'hour', mi: 'minute', sc: 'second', mdy: 'mdy', iyr: 'year', iqr: 'quarter', iwk: 'week', iwd: 'weekday' };
const DATE_TRUNCS = { tyr: 'year', tqr: 'quarter', tmn: 'month', twk: 'week', tdy: 'day', thr: 'hour', tmi: 'minute', tsc: 'second', my: 'month', tiyr: 'year', tiqr: 'quarter', tiwk: 'week' };

/** Table-calc prefixes that precede the derivation prefix, e.g. 'pcto:sum:Sales:qk'. */
export const TABLE_CALC_PREFIXES = {
	pcto: 'PctTotal',
	cum: 'CumTotal',
	rank: 'Rank',
	rank_dense: 'Rank',
	rank_modified: 'Rank',
	rank_unique: 'Rank',
	pcrk: 'PctRank',
	diff: 'Diff',
	pcdf: 'PctDiff',
	pdiff: 'PctDiff',
	mavg: 'MovingCalc',
	win: 'MovingCalc'
};

const TYPE_KEY = /^[a-z]k$/;
const TYPE_TO_KEY = { nominal: 'nk', ordinal: 'ok', quantitative: 'qk' };

/**
 * Split '[a].[b c].[d]' into its bracketed parts (inner text, ']]' escapes kept).
 * Returns null when the text is not a bracketed reference.
 * @param {string} text
 * @returns {string[]|null}
 */
export function splitBracketParts(text) {
	const s = String(text ?? '').trim();
	const parts = [];
	let i = 0;
	while (i < s.length) {
		if (s[i] !== '[') return null;
		let j = i + 1;
		let inner = '';
		for (;;) {
			if (j >= s.length) return null;
			if (s[j] === ']') {
				if (s[j + 1] === ']') {
					inner += ']]';
					j += 2;
					continue;
				}
				break;
			}
			inner += s[j];
			j += 1;
		}
		parts.push(inner);
		i = j + 1;
		if (i < s.length) {
			if (s[i] !== '.') return null;
			i += 1;
		}
	}
	return parts.length ? parts : null;
}

/** Normalize a derivation name (any case) to its prefix. */
export function derivationPrefix(derivation) {
	return DERIVATION_TO_PREFIX[String(derivation ?? 'none').toLowerCase()] || String(derivation ?? 'none').toLowerCase();
}

/** True when the prefix is an aggregation (User counts: aggregate calcs carry it). */
export function isAggregatePrefix(prefix) {
	return AGGREGATE_PREFIXES.has(prefix);
}

function parseInstanceName(inner) {
	if (inner.startsWith(':') || !inner.includes(':')) return { field: inner, prefix: 'none', typeKey: null, chain: [] };
	const segs = inner.split(':');
	let end = segs.length;
	if (end >= 3 && /^\d+$/.test(segs[end - 1]) && TYPE_KEY.test(segs[end - 2])) end -= 1;
	if (end < 2 || !TYPE_KEY.test(segs[end - 1])) return { field: inner, prefix: 'none', typeKey: null, chain: [] };
	const typeKey = segs[end - 1];
	for (let i = 0; i < end - 2; i++) {
		if (!/^[a-z][a-z0-9_]*$/.test(segs[i])) break;
		if (PREFIX_TO_DERIVATION[segs[i]]) {
			return { prefix: segs[i], chain: segs.slice(0, i), field: segs.slice(i + 1, end - 1).join(':'), typeKey };
		}
	}
	if (end >= 3 && /^[a-z][a-z0-9_]*$/.test(segs[0])) {
		return { prefix: segs[0], chain: [], field: segs.slice(1, end - 1).join(':'), typeKey };
	}
	return { field: segs.slice(0, end - 1).join(':'), prefix: 'none', typeKey, chain: [] };
}

/**
 * Undo the backslash escaping Tableau applies to pill ids stored as Measure Names member and bucket
 * values ('[ds].[usr:\% Share:qk]' names the column instance '[usr:% Share:qk]'). Other values pass through.
 * @param {any} value
 * @returns {any}
 */
export function unescapeMemberPillId(value) {
	if (typeof value !== 'string' || !value.startsWith('[') || !value.includes('\\')) return value;
	return value.replace(/\\(.)/g, '$1');
}

/**
 * Parse a pill id such as '[federated.x].[sum:Sales:qk]',
 * '[ds].[pcto:sum:Sales:qk:2]', '[ds].[__tableau_internal_object_id__].[cnt:Orders_A1:qk]',
 * '[ds].[:Measure Names]' or '[Multiple Values]'.
 *
 * @param {string} id
 * @param {{ column?: string, derivation?: string, type?: string }} [instance] column-instance attributes, when known
 * @returns {import('../../model/types.js').PillIR}
 */
export function parsePillId(id, instance = {}) {
	const parts = splitBracketParts(id);
	let datasourceId = '';
	let scope = [];
	let last = String(id ?? '');
	if (parts) {
		if (parts.length > 1) {
			datasourceId = parts[0];
			scope = parts.slice(1, -1);
		}
		last = parts.at(-1);
	}
	const parsed = parseInstanceName(last);
	let fieldId = [...scope, parsed.field].map((p) => `[${p}]`).join('.');
	if (instance.column) fieldId = instance.column;

	let prefix = parsed.prefix;
	let derivation = PREFIX_TO_DERIVATION[prefix] || prefix;
	if (instance.derivation) {
		derivation = instance.derivation;
		prefix = derivationPrefix(instance.derivation);
	}
	const typeKey = parsed.typeKey || TYPE_TO_KEY[instance.type] || (fieldId === '[Multiple Values]' ? 'qk' : 'nk');

	/** @type {import('../../model/types.js').PillIR} */
	const pill = {
		id: String(id),
		datasourceId,
		fieldId,
		derivation,
		prefix,
		typeKey,
		continuous: typeKey === 'qk',
		aggregated: isAggregatePrefix(prefix),
		datePart: DATE_PARTS[prefix] || null,
		dateTrunc: DATE_TRUNCS[prefix] || null
	};
	if (parsed.chain.length) {
		pill.tableCalc = { type: TABLE_CALC_PREFIXES[parsed.chain[0]] || parsed.chain[0], attrs: { prefix: parsed.chain.join(':') } };
	}
	return pill;
}

/**
 * Tokenize and parse a rows/cols shelf expression.
 * Precedence (loosest first): '+' concat, '*' cross, '/' nest. Parentheses group.
 *
 * @param {string|undefined|null} text
 * @returns {import('../../model/types.js').ShelfNode|null}
 */
export function parseShelf(text) {
	const tokens = tokenizeShelf(text);
	if (!tokens.length) return null;
	let pos = 0;
	const peek = () => tokens[pos];

	const parseLevel = (ops, level) => {
		if (level === ops.length) return parseAtom();
		const [symbol, op] = ops[level];
		const first = parseLevel(ops, level + 1);
		const items = first ? [first] : [];
		while (peek() && peek().type === 'op' && peek().value === symbol) {
			pos += 1;
			const next = parseLevel(ops, level + 1);
			if (next) items.push(next);
		}
		if (items.length <= 1) return items[0] || null;
		return { op, children: items.flatMap((n) => (n.op === op ? n.children : [n])) };
	};
	const OPS = [
		['+', 'concat'],
		['*', 'cross'],
		['/', 'nest']
	];
	const parseAtom = () => {
		const t = peek();
		if (!t) return null;
		if (t.type === 'pill') {
			pos += 1;
			return { op: 'pill', pillId: t.value };
		}
		if (t.type === '(') {
			pos += 1;
			const inner = parseLevel(OPS, 0);
			if (peek()?.type === ')') pos += 1;
			return inner;
		}
		pos += 1;
		return parseAtom();
	};

	const results = [];
	while (pos < tokens.length) {
		const start = pos;
		const node = parseLevel(OPS, 0);
		if (node) results.push(node);
		if (pos === start) pos += 1;
	}
	if (!results.length) return null;
	return results.length === 1 ? results[0] : { op: 'concat', children: results };
}

function tokenizeShelf(text) {
	const s = String(text ?? '');
	const tokens = [];
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (/\s/.test(ch)) {
			i += 1;
		} else if (ch === '(' || ch === ')') {
			tokens.push({ type: ch });
			i += 1;
		} else if (ch === '/' || ch === '+' || ch === '*') {
			tokens.push({ type: 'op', value: ch });
			i += 1;
		} else if (ch === '[') {
			let j = i;
			for (;;) {
				j += 1;
				while (j < s.length) {
					if (s[j] === ']') {
						if (s[j + 1] === ']') {
							j += 2;
							continue;
						}
						break;
					}
					j += 1;
				}
				if (s[j + 1] === '.' && s[j + 2] === '[') {
					j += 2;
					continue;
				}
				break;
			}
			tokens.push({ type: 'pill', value: s.slice(i, j + 1) });
			i = j + 1;
		} else {
			i += 1;
		}
	}
	return tokens;
}

/**
 * Pill ids of a shelf tree, in order.
 * @param {import('../../model/types.js').ShelfNode|null} node
 * @returns {string[]}
 */
export function flattenShelf(node) {
	if (!node) return [];
	if (node.op === 'pill') return [node.pillId];
	return (node.children || []).flatMap(flattenShelf);
}
