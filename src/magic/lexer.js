/**
 * Tokenizer and statement splitter for Snowflake SQL scripts and Magic ETL formulas.
 *
 * @typedef {'word'|'qid'|'str'|'num'|'op'|'var'} TokenType
 * @typedef {{ t: TokenType, v: string, u?: string, q?: string, s: number, e: number }} Token
 *   `v`: the value (unquoted for `qid` and `str`), `u`: upper-case word, `q`: the quote character of a `qid`
 * @typedef {{ index: number, start: number, end: number, text: string, tokens: Token[] }} ScriptStatement
 */

const WORD_START = /[A-Za-z_À-￿]/;
const WORD_PART = /[\w$À-￿]/;
const MULTI_OPS = ['::', '||', '<>', '!=', '<=', '>=', '=>', '->', '<=>', '!~*', '!~', '~*'];

export class SqlSyntaxError extends Error {
	/** @param {string} message @param {number} [at] */
	constructor(message, at) {
		super(message);
		this.at = at;
	}
}

/**
 * @param {string} sql
 * @param {{ backslashEscapes?: boolean }} [opts]  Snowflake strings take backslash escapes; Magic ETL formulas do not.
 * @returns {Token[]}
 */
export function tokenize(sql, { backslashEscapes = true } = {}) {
	const out = [];
	const n = sql.length;
	let i = 0;
	while (i < n) {
		const ch = sql[i];
		if (/\s/.test(ch)) {
			i++;
		} else if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '/')) {
			const eol = sql.indexOf('\n', i);
			i = eol === -1 ? n : eol + 1;
		} else if (ch === '/' && sql[i + 1] === '*') {
			const close = sql.indexOf('*/', i + 2);
			i = close === -1 ? n : close + 2;
		} else if (ch === "'") {
			let j = i + 1;
			let v = '';
			for (; j < n; j++) {
				const c = sql[j];
				if (c === "'" && sql[j + 1] === "'") {
					v += "'";
					j++;
				} else if (c === "'") break;
				else if (c === '\\' && backslashEscapes && j + 1 < n) {
					const next = sql[++j];
					v += { n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b' }[next] ?? next;
				} else v += c;
			}
			if (j >= n) throw new SqlSyntaxError('unterminated string literal', i);
			out.push({ t: 'str', v, s: i, e: j + 1 });
			i = j + 1;
		} else if (ch === '$' && sql[i + 1] === '$') {
			const close = sql.indexOf('$$', i + 2);
			if (close === -1) throw new SqlSyntaxError('unterminated $$ string', i);
			out.push({ t: 'str', v: sql.slice(i + 2, close), s: i, e: close + 2 });
			i = close + 2;
		} else if (ch === '"' || ch === '`') {
			let j = i + 1;
			let v = '';
			for (; j < n; j++) {
				if (sql[j] === ch && sql[j + 1] === ch) {
					v += ch;
					j++;
				} else if (sql[j] === ch) break;
				else v += sql[j];
			}
			if (j >= n) throw new SqlSyntaxError('unterminated quoted identifier', i);
			out.push({ t: 'qid', v, q: ch, s: i, e: j + 1 });
			i = j + 1;
		} else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
			const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i, i + 64));
			out.push({ t: 'num', v: m[0], s: i, e: i + m[0].length });
			i += m[0].length;
		} else if (ch === '$' && /[A-Za-z_0-9]/.test(sql[i + 1] ?? '')) {
			let j = i + 1;
			while (j < n && /\w/.test(sql[j])) j++;
			out.push({ t: 'var', v: sql.slice(i + 1, j), s: i, e: j });
			i = j;
		} else if (WORD_START.test(ch)) {
			let j = i + 1;
			while (j < n && WORD_PART.test(sql[j])) j++;
			const v = sql.slice(i, j);
			out.push({ t: 'word', v, u: v.toUpperCase(), s: i, e: j });
			i = j;
		} else {
			const op = MULTI_OPS.filter((o) => sql.startsWith(o, i)).sort((a, b) => b.length - a.length)[0] ?? ch;
			out.push({ t: 'op', v: op, s: i, e: i + op.length });
			i += op.length;
		}
	}
	return out;
}

/**
 * Split a Snowflake script at top-level semicolons. Snowflake needs a semicolon between statements, so keywords never
 * split (unlike T-SQL batches). Empty statements are dropped.
 * @param {string} sql
 * @returns {ScriptStatement[]}
 */
export function splitScript(sql) {
	const tokens = tokenize(sql);
	const statements = [];
	let cur = [];
	let depth = 0;
	const flush = () => {
		if (cur.length) {
			const start = cur[0].s;
			const end = cur.at(-1).e;
			statements.push({ index: statements.length, start, end, text: sql.slice(start, end), tokens: cur });
		}
		cur = [];
	};
	for (const tok of tokens) {
		if (tok.t === 'op' && tok.v === '(') depth++;
		else if (tok.t === 'op' && tok.v === ')') depth = Math.max(0, depth - 1);
		if (tok.t === 'op' && tok.v === ';' && depth === 0) {
			flush();
			continue;
		}
		cur.push(tok);
	}
	flush();
	return statements;
}

/** One-line excerpt of SQL text for messages. */
export function excerpt(text, max = 120) {
	const one = String(text ?? '').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}
