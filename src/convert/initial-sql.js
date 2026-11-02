import { quoteIdentifier, connectorFamily, connectorSpec, isConnectorClass } from './connectors.js';

/**
 * @typedef {{ t: 'word'|'qid'|'str'|'num'|'var'|'op', v: string, u?: string, s: number, e: number }} Token
 * @typedef {{ index: number, start: number, end: number, text: string, tokens: Token[] }} Statement
 *
 * @typedef {{ op: 'input', stream: string }
 *   | { op: 'select', from: Node, fields: { name: string, rename?: string }[] }
 *   | { op: 'join', left: Node, right: Node, joinType: 'INNER'|'LEFT OUTER', keys: { left: string, right: string }[] }
 *   | { op: 'filter', from: Node, expression: string, label: string }
 *   | { op: 'formula', from: Node, fields: { name: string, expression: string }[], label: string }
 *   | { op: 'group', from: Node, groups: string[], fields: { name: string, expression: string }[] }
 *   | { op: 'metadata', from: Node, fields: { name: string, rename?: string, remove?: boolean }[], label: string }
 *   | { op: 'distinct', from: Node }
 *   | { op: 'union', inputs: Node[] }} Node
 *
 * @typedef {{ id: string, label: string, sql: string, temp?: string }} StreamPlan
 * @typedef {{ kind: 'stream', stream: string } | { kind: 'etl', graph: Node }} TablePlan
 *
 * @typedef {Object} InitialSqlPlan
 * @property {Statement[]} statements
 * @property {{ index: number, kind: string, text: string, temp?: string, note?: string }[]} summary  One line per statement
 * @property {StreamPlan[]} streams
 * @property {Map<string, TablePlan>} tables  TableIR id -> plan, for the tables of the connection
 * @property {{ dbname?: string, schema?: string, warehouse?: string }} session  USE targets for the streams
 * @property {string[]} notes
 * @property {{ statement?: number, text: string, where: string, reason: string }} [blocked]  Set when it cannot be translated
 */

export const INITIAL_SQL_KEYS = ['one-time-sql', 'initial-sql', 'initialsql'];

/** @param {import('../model/types.js').ConnectionIR} [connection] */
export function initialSqlOf(connection) {
	const value = INITIAL_SQL_KEYS.map((k) => connection?.extra?.[k]).find((v) => v && String(v).trim());
	return value && !isSessionOnly(String(value)) ? String(value) : undefined;
}

/** @param {string} sql */
export function isSessionOnly(sql) {
	let items;
	try {
		items = parseInitialSql(sql).items;
	} catch {
		return false;
	}
	const harmless = (item) =>
		(item.kind === 'session' && (!item.affects || /^TIMEZONE$/i.test(item.option) && /'(UTC|GMT|Etc\/UTC)'/i.test(item.text))) ||
		(item.kind === 'use' && ['WAREHOUSE', 'ROLE', 'SECONDARY'].includes(item.target));
	return items.length > 0 && items.every(harmless);
}

/* Tokens and statements */

const WORD_START = /[A-Za-z_#@$À-￿]/;
const WORD_PART = /[\w#@$À-￿]/;
const TWO_CHAR_OPS = new Set(['<>', '!=', '<=', '>=', '::', '||', '!<', '!>']);

/** @param {string} sql @returns {Token[]} */
export function tokenize(sql) {
	const tokens = [];
	const n = sql.length;
	let i = 0;
	const quoted = (open, close, t) => {
		const start = i;
		let j = i + 1;
		while (j < n) {
			if (sql[j] === close) {
				if (sql[j + 1] === close) {
					j += 2;
					continue;
				}
				break;
			}
			j++;
		}
		i = Math.min(j + 1, n);
		const raw = sql.slice(start, i);
		tokens.push(t === 'str' ? { t, v: raw, s: start, e: i } : { t, v: raw.slice(1, -1).split(close + close).join(close), q: open, s: start, e: i });
	};
	while (i < n) {
		const ch = sql[i];
		if (/\s/.test(ch)) {
			i++;
		} else if (ch === '-' && sql[i + 1] === '-') {
			const eol = sql.indexOf('\n', i);
			i = eol === -1 ? n : eol + 1;
		} else if (ch === '/' && sql[i + 1] === '*') {
			let depth = 1;
			let j = i + 2;
			while (j < n && depth) {
				if (sql.startsWith('/*', j)) {
					depth++;
					j += 2;
				} else if (sql.startsWith('*/', j)) {
					depth--;
					j += 2;
				} else j++;
			}
			i = j;
		} else if (ch === "'") {
			quoted("'", "'", 'str');
		} else if ((ch === 'N' || ch === 'n') && sql[i + 1] === "'") {
			const start = i;
			i++;
			quoted("'", "'", 'str');
			tokens.at(-1).s = start;
		} else if (ch === '[') {
			quoted('[', ']', 'qid');
		} else if (ch === '"') {
			quoted('"', '"', 'qid');
		} else if (ch === '`') {
			quoted('`', '`', 'qid');
		} else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
			const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i));
			tokens.push({ t: 'num', v: m[0], s: i, e: i + m[0].length });
			i += m[0].length;
		} else if (WORD_START.test(ch)) {
			let j = i + 1;
			while (j < n && WORD_PART.test(sql[j])) j++;
			const v = sql.slice(i, j);
			tokens.push({ t: v.startsWith('@') ? 'var' : 'word', v, u: v.toUpperCase(), s: i, e: j });
			i = j;
		} else {
			const two = sql.slice(i, i + 2);
			const v = TWO_CHAR_OPS.has(two) ? two : ch;
			tokens.push({ t: 'op', v, s: i, e: i + v.length });
			i += v.length;
		}
	}
	return tokens;
}

const STARTERS = new Set([
	'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'SET', 'DECLARE', 'EXEC', 'EXECUTE', 'IF', 'ELSE',
	'WHILE', 'BEGIN', 'END', 'USE', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'PRINT', 'RETURN', 'BREAK', 'CONTINUE', 'GOTO', 'WITH', 'RAISERROR',
	'THROW', 'COMMIT', 'ROLLBACK', 'CALL', 'SHOW', 'GRANT', 'REVOKE'
]);
const OBJECT_WORDS = new Set(['TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'PROCEDURE', 'PROC', 'FUNCTION', 'SEQUENCE', 'TRIGGER', 'TYPE']);
const SET_OPERATORS = new Set(['UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'MINUS']);

const hasWord = (tokens, words) => tokens.some((t) => t.t === 'word' && words.includes(t.u));

function startsStatement(cur, tok, prev, next) {
	if (!STARTERS.has(tok.u)) return false;
	if (prev?.v === '.' || next?.v === '.') return false;
	const head = cur[0].u;
	const pu = prev?.u ?? prev?.v;
	if (head === 'MERGE') return false;
	switch (tok.u) {
		case 'SELECT':
			if (SET_OPERATORS.has(pu) || pu === 'AS' || pu === 'FOR') return false;
			if (head === 'INSERT' && !hasWord(cur, ['SELECT', 'VALUES', 'EXEC', 'EXECUTE'])) return false;
			if (head === 'WITH' && pu === ')') return false;
			return true;
		case 'WITH':
			if (next?.v === '(' || pu === 'AS') return false;
			if (head === 'INSERT' && !hasWord(cur, ['SELECT', 'VALUES'])) return false;
			return true;
		case 'SET':
			if (head === 'ALTER' || head === 'CREATE') return false;
			if (head === 'UPDATE' && !hasWord(cur, ['SET'])) return false;
			return pu !== 'ON' && pu !== 'DELETE' && pu !== 'UPDATE';
		case 'UPDATE':
		case 'DELETE':
			return pu !== 'ON' && pu !== 'FOR';
		case 'IF':
			return !OBJECT_WORDS.has(pu) && !(pu === 'ALL' && head === 'DROP');
		case 'ALTER':
			return pu !== 'OR';
		case 'EXEC':
		case 'EXECUTE':
			return head !== 'INSERT' && head !== 'CREATE';
		case 'DROP':
			return head !== 'ALTER';
		default:
			return true;
	}
}

/**
 * Split a batch into statements at semicolons, GO, and statement keywords at the top level (T-SQL needs no
 * semicolons). CASE ... END and parentheses never split.
 * @param {string} sql
 * @returns {Statement[]}
 */
export function splitStatements(sql) {
	const tokens = tokenize(sql);
	const out = [];
	let cur = [];
	let depth = 0;
	let caseDepth = 0;
	const close = () => {
		if (cur.length) out.push(cur);
		cur = [];
	};
	for (let k = 0; k < tokens.length; k++) {
		const tok = tokens[k];
		if (tok.v === ';' && depth === 0) {
			close();
			continue;
		}
		if (tok.v === '(') depth++;
		else if (tok.v === ')') depth = Math.max(0, depth - 1);
		if (tok.t === 'word') {
			if (tok.u === 'CASE') {
				caseDepth++;
			} else if (tok.u === 'END' && caseDepth > 0) {
				caseDepth--;
				cur.push(tok);
				continue;
			} else if (tok.u === 'GO' && depth === 0 && caseDepth === 0 && (!cur.length || tokens[k + 1]?.t === 'word' || !tokens[k + 1])) {
				close();
				continue;
			}
			if (depth === 0 && caseDepth === 0 && cur.length && startsStatement(cur, tok, tokens[k - 1], tokens[k + 1])) close();
		}
		cur.push(tok);
	}
	close();
	return out.map((list, index) => ({ index: index + 1, start: list[0].s, end: list.at(-1).e, text: sql.slice(list[0].s, list.at(-1).e), tokens: list }));
}

/* Names */

const isName = (tok) => tok && (tok.t === 'word' || tok.t === 'qid');

/** A dotted name starting at tokens[i] (empty parts allowed: `db..table`). */
function readName(tokens, i) {
	const parts = [];
	let j = i;
	if (!isName(tokens[j]) && !(tokens[j]?.t === 'var' && !tokens[j].v.startsWith('@@'))) return null;
	parts.push({ name: tokens[j].v, quoted: tokens[j].t === 'qid' });
	j++;
	while (tokens[j]?.v === '.') {
		if (isName(tokens[j + 1])) {
			parts.push({ name: tokens[j + 1].v, quoted: tokens[j + 1].t === 'qid' });
			j += 2;
		} else if (tokens[j + 1]?.v === '.') {
			parts.push({ name: '', quoted: false });
			j++;
		} else break;
	}
	return { parts, start: i, end: j };
}

const lower = (v) => String(v ?? '').toLowerCase();
const isTempName = (name) => name.startsWith('#') || name.startsWith('@');

/* Expressions */

const RESERVED = new Set([
	'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'UNION', 'ALL', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'CASE', 'WHEN',
	'THEN', 'ELSE', 'END', 'AS', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'APPLY', 'DISTINCT', 'TOP', 'INTO', 'EXISTS', 'OVER',
	'PARTITION', 'WITH', 'OPTION', 'EXCEPT', 'INTERSECT', 'ASC', 'DESC', 'TRUE', 'FALSE', 'ILIKE', 'QUALIFY', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'WINDOW'
]);
const AGGREGATES = new Set(['SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'COUNT_BIG']);

class ExprError extends Error {}

/**
 * Pratt parser for the T-SQL expressions t2d translates to Magic ETL formulas.
 * @param {Token[]} tokens
 */
export function parseExpression(tokens) {
	let i = 0;
	const peek = (o = 0) => tokens[i + o];
	const isWord = (w, o = 0) => peek(o)?.t === 'word' && peek(o).u === w;
	const take = () => tokens[i++];
	const expect = (v) => {
		const tok = take();
		if (!tok || (tok.v !== v && tok.u !== v)) throw new ExprError(`expected ${v}`);
		return tok;
	};
	const list = () => {
		const args = [];
		if (peek()?.v === ')') return args;
		for (;;) {
			args.push(expr(0));
			if (peek()?.v !== ',') break;
			take();
		}
		return args;
	};
	const type = () => {
		const name = take();
		if (!isName(name)) throw new ExprError('expected a type');
		const out = { name: name.v.toUpperCase(), args: [] };
		if (peek()?.v === '(') {
			take();
			while (peek() && peek().v !== ')') out.args.push(take().v);
			expect(')');
		}
		return out;
	};
	const primary = () => {
		const tok = take();
		if (!tok) throw new ExprError('unexpected end');
		if (tok.t === 'num') return { k: 'num', v: tok.v };
		if (tok.t === 'str') return { k: 'str', v: tok.v.replace(/^[Nn]/, '') };
		if (tok.t === 'var') throw new ExprError(`uses variable ${tok.v}`);
		if (tok.v === '(') {
			if (isWord('SELECT')) throw new ExprError('has a subquery');
			const inner = expr(0);
			expect(')');
			return { k: 'paren', e: inner };
		}
		if (tok.v === '-' || tok.v === '+') return { k: 'neg', op: tok.v, e: expr(7) };
		if (tok.v === '*') return { k: 'star' };
		if (tok.t === 'word') {
			if (tok.u === 'NULL') return { k: 'null' };
			if (tok.u === 'TRUE' || tok.u === 'FALSE') return { k: 'bool', v: tok.u };
			if (tok.u === 'NOT') return { k: 'not', e: expr(3) };
			if (tok.u === 'EXISTS') throw new ExprError('has an EXISTS subquery');
			if (tok.u === 'CASE') {
				const node = { k: 'case', whens: [] };
				if (!isWord('WHEN')) node.base = expr(0);
				while (isWord('WHEN')) {
					take();
					const when = expr(0);
					expect('THEN');
					node.whens.push([when, expr(0)]);
				}
				if (isWord('ELSE')) {
					take();
					node.else = expr(0);
				}
				expect('END');
				return node;
			}
			if ((tok.u === 'CAST' || tok.u === 'TRY_CAST') && peek()?.v === '(') {
				take();
				const e = expr(0);
				expect('AS');
				const t = type();
				expect(')');
				return { k: 'cast', e, type: t };
			}
			if ((tok.u === 'CONVERT' || tok.u === 'TRY_CONVERT') && peek()?.v === '(') {
				take();
				const t = type();
				expect(',');
				const e = expr(0);
				let style;
				if (peek()?.v === ',') {
					take();
					style = expr(0);
				}
				expect(')');
				return { k: 'cast', e, type: t, style };
			}
			if (['CURRENT_TIMESTAMP', 'CURRENT_DATE'].includes(tok.u)) return { k: 'fn', name: tok.u, args: [] };
		}
		if (isName(tok)) {
			if (tok.t === 'word' && RESERVED.has(tok.u) && !(['LEFT', 'RIGHT'].includes(tok.u) && peek()?.v === '(')) throw new ExprError(`unexpected ${tok.v}`);
			i--;
			const name = readName(tokens, i);
			i = name.end;
			if (peek()?.v === '(' && name.parts.length === 1 && !name.parts[0].quoted) {
				take();
				const distinct = isWord('DISTINCT') ? (take(), true) : false;
				const args = list();
				expect(')');
				if (isWord('OVER')) throw new ExprError('has a window function (OVER)');
				if (isWord('WITHIN')) throw new ExprError('has an ordered-set aggregate');
				return { k: 'fn', name: name.parts[0].name.toUpperCase(), args, distinct };
			}
			if (peek()?.v === '(') throw new ExprError(`calls ${name.parts.map((p) => p.name).join('.')}`);
			if (peek()?.v === '.' && peek(1)?.v === '*') {
				i += 2;
				return { k: 'star', qualifier: name.parts.map((p) => p.name) };
			}
			return { k: 'col', parts: name.parts.map((p) => p.name) };
		}
		throw new ExprError(`unexpected ${tok.v}`);
	};
	const COMPARE = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
	const span = (node, from) => Object.assign(node, { start: tokens[from].s, end: tokens[i - 1].e });
	const expr = (minPrec) => {
		const from = i;
		let left = span(primary(), from);
		for (;;) {
			span(left, from);
			const tok = peek();
			if (!tok) break;
			const u = tok.t === 'word' ? tok.u : tok.v;
			let prec;
			if (u === 'OR') prec = 1;
			else if (u === 'AND') prec = 2;
			else if (COMPARE.has(u) || ['LIKE', 'ILIKE', 'IN', 'BETWEEN', 'IS'].includes(u) || (u === 'NOT' && ['LIKE', 'ILIKE', 'IN', 'BETWEEN'].includes(peek(1)?.u))) prec = 4;
			else if (u === '+' || u === '-' || u === '||') prec = 5;
			else if (u === '*' || u === '/' || u === '%') prec = 6;
			else if (u === '::') {
				take();
				left = { k: 'cast', e: left, type: type() };
				continue;
			} else break;
			if (prec <= minPrec) break;
			take();
			if (u === 'IS') {
				const not = isWord('NOT') ? (take(), true) : false;
				expect('NULL');
				left = { k: 'isnull', e: left, not };
				continue;
			}
			let not = false;
			let op = u;
			if (u === 'NOT') {
				not = true;
				op = take().u;
			}
			if (op === 'LIKE' || op === 'ILIKE') {
				left = { k: 'like', e: left, p: expr(4), not, ...(op === 'ILIKE' ? { ci: true } : {}) };
			} else if (op === 'IN') {
				expect('(');
				if (isWord('SELECT')) throw new ExprError('has an IN subquery');
				const items = list();
				expect(')');
				left = { k: 'in', e: left, items, not };
			} else if (op === 'BETWEEN') {
				const lo = expr(4);
				expect('AND');
				left = { k: 'between', e: left, lo, hi: expr(4), not };
			} else {
				left = { k: 'bin', op, l: left, r: expr(prec) };
			}
		}
		return span(left, from);
	};
	const node = expr(0);
	if (i < tokens.length) throw new ExprError(`unexpected ${tokens[i].v}`);
	return node;
}

/** SQL Server's default collation compares text without case, so its LIKE becomes ILIKE in Magic ETL. */
function likeCase(node, env) {
	if (env.dialect === 'tsql') walk(node, (n) => n.k === 'like' && (n.ci = true));
	return node;
}

function walk(node, fn) {
	if (!node || typeof node !== 'object') return;
	fn(node);
	for (const v of Object.values(node)) {
		if (Array.isArray(v)) v.forEach((x) => (Array.isArray(x) ? x.forEach((y) => walk(y, fn)) : walk(x, fn)));
		else if (v && typeof v === 'object' && v.k) walk(v, fn);
	}
}

function hasAggregate(node) {
	let found = false;
	walk(node, (n) => {
		if (n.k === 'fn' && AGGREGATES.has(n.name)) found = true;
	});
	return found;
}

/* Magic ETL formulas */

const STRING_TYPES = new Set(['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'TEXT', 'NTEXT', 'SYSNAME', 'STRING']);
const CAST_TYPES = {
	INT: 'LONG', BIGINT: 'LONG', SMALLINT: 'LONG', TINYINT: 'LONG', BIT: 'LONG', INTEGER: 'LONG', NUMBER: 'DECIMAL',
	FLOAT: 'DOUBLE', REAL: 'DOUBLE', DECIMAL: 'DECIMAL', NUMERIC: 'DECIMAL', MONEY: 'DECIMAL', SMALLMONEY: 'DECIMAL',
	DATETIME: 'DATETIME', DATETIME2: 'DATETIME', SMALLDATETIME: 'DATETIME', DATETIMEOFFSET: 'DATETIME', TIMESTAMP: 'DATETIME'
};
const DATE_PARTS = {
	YEAR: 'YEAR', YY: 'YEAR', YYYY: 'YEAR', QUARTER: 'QUARTER', QQ: 'QUARTER', Q: 'QUARTER', MONTH: 'MONTH', MM: 'MONTH', M: 'MONTH',
	DAY: 'DAY', DD: 'DAY', D: 'DAY', WEEK: 'WEEK', WK: 'WEEK', WW: 'WEEK', HOUR: 'HOUR', HH: 'HOUR', MINUTE: 'MINUTE', MI: 'MINUTE', N: 'MINUTE',
	SECOND: 'SECOND', SS: 'SECOND', S: 'SECOND'
};
const SAME_FUNCTIONS = new Set([
	'COALESCE', 'NULLIF', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM', 'SUBSTRING', 'LEFT', 'RIGHT', 'REPLACE', 'CONCAT', 'ABS', 'ROUND', 'FLOOR',
	'POWER', 'SQRT', 'YEAR', 'MONTH', 'DAY', 'SUM', 'MIN', 'MAX', 'AVG'
]);
const STRING_FUNCTIONS = new Set(['UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM', 'SUBSTRING', 'LEFT', 'RIGHT', 'REPLACE', 'CONCAT']);

const backtick = (name) => `\`${String(name).replace(/`/g, '``')}\``;

function isStringish(node) {
	if (!node) return false;
	if (node.k === 'str') return true;
	if (node.k === 'paren') return isStringish(node.e);
	if (node.k === 'cast') return STRING_TYPES.has(node.type.name);
	if (node.k === 'fn') return STRING_FUNCTIONS.has(node.name);
	if (node.k === 'bin' && node.op === '+') return isStringish(node.l) || isStringish(node.r);
	return node.k === 'bin' && node.op === '||';
}

/**
 * Magic ETL formula for a T-SQL expression AST; throws ExprError for anything it cannot translate.
 * @param {object} node
 * @param {(parts: string[]) => string} column  Working column name for a column reference
 * @param {(fn: object) => string|undefined} [aggregate]  Replace an aggregate call (HAVING)
 */
export function toFormula(node, column, aggregate) {
	const f = (n) => toFormula(n, column, aggregate);
	switch (node.k) {
		case 'num':
			return node.v;
		case 'str':
			return node.v;
		case 'null':
			return 'NULL';
		case 'bool':
			return node.v;
		case 'col':
			return backtick(column(node.parts));
		case 'paren':
			return `(${f(node.e)})`;
		case 'neg':
			return `${node.op}${f(node.e)}`;
		case 'not':
			return `NOT ${f(node.e)}`;
		case 'isnull':
			return `${f(node.e)} IS ${node.not ? 'NOT ' : ''}NULL`;
		case 'like': {
			if (node.p.k === 'str' && /\[/.test(node.p.v)) throw new ExprError(`uses a LIKE character class (${node.p.v})`);
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}${node.ci ? 'ILIKE' : 'LIKE'} ${f(node.p)}`;
		}
		case 'in':
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}IN (${node.items.map(f).join(', ')})`;
		case 'between':
			return `${f(node.e)} ${node.not ? 'NOT ' : ''}BETWEEN ${f(node.lo)} AND ${f(node.hi)}`;
		case 'case':
			return `CASE${node.base ? ` ${f(node.base)}` : ''} ${node.whens.map(([w, t]) => `WHEN ${f(w)} THEN ${f(t)}`).join(' ')}${node.else ? ` ELSE ${f(node.else)}` : ''} END`;
		case 'bin': {
			if (node.op === '+' && (isStringish(node.l) || isStringish(node.r))) return `CONCAT(${f(node.l)}, ${f(node.r)})`;
			const op = node.op === '<>' ? '!=' : node.op;
			return `${f(node.l)} ${op} ${f(node.r)}`;
		}
		case 'cast': {
			if (node.style) throw new ExprError(`uses CONVERT with a style (${node.type.name})`);
			const name = node.type.name;
			if (name === 'DATE') return `DATE(${f(node.e)})`;
			if (STRING_TYPES.has(name)) return `CAST(${f(node.e)} AS STRING)`;
			if (CAST_TYPES[name]) return `CAST(${f(node.e)} AS ${CAST_TYPES[name]})`;
			throw new ExprError(`casts to ${name}`);
		}
		case 'star':
			throw new ExprError('selects *');
		case 'fn': {
			if (aggregate && AGGREGATES.has(node.name)) {
				const replaced = aggregate(node);
				if (replaced) return backtick(replaced);
			}
			const args = node.args;
			switch (node.name) {
				case 'ISNULL':
				case 'IFNULL':
					return `IFNULL(${args.map(f).join(', ')})`;
				case 'IIF':
					return `CASE WHEN ${f(args[0])} THEN ${f(args[1])} ELSE ${f(args[2])} END`;
				case 'GETDATE':
				case 'SYSDATETIME':
				case 'GETUTCDATE':
				case 'CURRENT_TIMESTAMP':
				case 'NOW':
					return 'NOW()';
				case 'CURRENT_DATE':
					return 'CURRENT_DATE()';
				case 'LEN':
					return `LENGTH(RTRIM(${f(args[0])}))`;
				case 'CEILING':
					return `CEIL(${f(args[0])})`;
				case 'EOMONTH':
					if (args.length !== 1) break;
					return `LAST_DAY(${f(args[0])})`;
				case 'DATEADD': {
					const part = args[0]?.k === 'col' && args[0].parts.length === 1 ? DATE_PARTS[args[0].parts[0].toUpperCase()] : undefined;
					if (!part) break;
					return `DATE_ADD(${f(args[2])}, INTERVAL ${f(args[1])} ${part})`;
				}
				case 'DATEDIFF': {
					const part = args[0]?.k === 'col' && args[0].parts.length === 1 ? DATE_PARTS[args[0].parts[0].toUpperCase()] : undefined;
					if (part !== 'DAY') break;
					return `DATEDIFF(${f(args[2])}, ${f(args[1])})`;
				}
				case 'DATEPART': {
					const part = args[0]?.k === 'col' && args[0].parts.length === 1 ? DATE_PARTS[args[0].parts[0].toUpperCase()] : undefined;
					if (!part || part === 'WEEK') break;
					return `${part}(${f(args[1])})`;
				}
				case 'COUNT':
				case 'COUNT_BIG':
					if (args[0]?.k === 'star') return 'COUNT(*)';
					return node.distinct ? `COUNT(DISTINCT ${f(args[0])})` : `COUNT(${f(args[0])})`;
				default:
					if (SAME_FUNCTIONS.has(node.name)) {
						if (node.distinct) break;
						return `${node.name}(${args.map(f).join(', ')})`;
					}
			}
			throw new ExprError(`calls ${node.name}${node.name === 'DATEADD' || node.name === 'DATEDIFF' || node.name === 'DATEPART' ? ' with that date part' : ''}, which t2d does not translate to Magic ETL`);
		}
		default:
			throw new ExprError(`has an unsupported expression (${node.k})`);
	}
}

/* Statement classification */

const RESULT_SETTINGS = /^(TIMEZONE|DATEFIRST|DATEFORMAT|LANGUAGE|WEEK_START|WEEK_OF_YEAR_POLICY|ANSI_NULLS|CONCAT_NULL_YIELDS_NULL|TIMESTAMP_TYPE_MAPPING|SEARCH_PATH)$/i;
const TABLEAU_PARAMETERS = /\[(TableauServerUser|TableauServerUserFull|TableauApp|TableauVersion|WorkbookName)\]/i;
const TEMP_CREATE = /^(TEMP|TEMPORARY|VOLATILE|LOCAL|GLOBAL|TRANSIENT)$/;

/** Index of the first top-level (depth 0) word in `words` from `from`, or -1. */
function topIndex(tokens, words, from = 0) {
	let depth = 0;
	for (let i = from; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.v === '(') depth++;
		else if (t.v === ')') depth--;
		else if (depth === 0 && t.t === 'word' && words.includes(t.u)) return i;
	}
	return -1;
}

/** Split tokens at top-level commas. */
function splitTop(tokens, sep = ',') {
	const parts = [[]];
	let depth = 0;
	let caseDepth = 0;
	for (const t of tokens) {
		if (t.v === '(') depth++;
		else if (t.v === ')') depth--;
		else if (t.u === 'CASE') caseDepth++;
		else if (t.u === 'END' && caseDepth) caseDepth--;
		if (depth === 0 && caseDepth === 0 && (sep === ',' ? t.v === ',' : t.t === 'word' && t.u === sep)) {
			parts.push([]);
			continue;
		}
		parts.at(-1).push(t);
	}
	return parts.filter((p) => p.length);
}

const sliceText = (sql, tokens) => (tokens.length ? sql.slice(tokens[0].s, tokens.at(-1).e) : '');

/**
 * Parse an Initial SQL batch into classified statements.
 * @param {string} sql
 * @returns {{ statements: Statement[], items: object[] }}
 */
export function parseInitialSql(sql) {
	const statements = splitStatements(sql);
	const items = [];
	for (let k = 0; k < statements.length; k++) {
		const st = statements[k];
		const item = classify(st, sql);
		const constant = item.kind === 'if' ? constantCondition(st.tokens.slice(1)) : undefined;
		if (constant !== undefined) {
			items.push({ ...item, kind: 'dead', note: constant ? 'always true, the statements run' : 'never true, the statements are skipped' });
			if (constant) continue;
			let j = k + 1;
			if (statements[j]?.tokens[0].u === 'BEGIN') {
				let depth = 0;
				for (; j < statements.length; j++) {
					const u = statements[j].tokens[0].u;
					if (u === 'BEGIN' && !['TRAN', 'TRANSACTION'].includes(statements[j].tokens[1]?.u)) depth++;
					else if (u === 'END' && --depth === 0) break;
				}
			}
			for (let s = k + 1; s <= Math.min(j, statements.length - 1); s++) items.push({ kind: 'dead', statement: statements[s], text: statements[s].text, note: 'inside IF that never runs' });
			k = j;
			continue;
		}
		if (item.kind === 'if' && statements[k + 1]) {
			const next = classify(statements[k + 1], sql);
			const guard = /OBJECT_ID|EXISTS/i.test(st.text);
			if (guard && next.kind === 'drop' && next.temp) {
				items.push({ ...next, statement: st, guarded: true, text: `${st.text} ${next.text}` });
				k++;
				continue;
			}
			if (guard && statements[k + 1].tokens[0].u === 'BEGIN') {
				let j = k + 2;
				const drops = [];
				while (statements[j] && classify(statements[j], sql).kind === 'drop' && classify(statements[j], sql).temp) drops.push(classify(statements[j++], sql));
				if (drops.length && statements[j]?.tokens[0].u === 'END' && statements[j].tokens.length === 1) {
					for (const d of drops) items.push({ ...d, guarded: true });
					k = j;
					continue;
				}
			}
		}
		items.push(item);
	}
	return { statements, items };
}

/** `(SELECT ...)`: a scalar subquery the variable's uses can inline. */
function scalarQuery(tokens) {
	if (tokens[0]?.v !== '(' || tokens.at(-1)?.v !== ')' || tokens[1]?.u !== 'SELECT') return false;
	let depth = 0;
	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i].v === '(') depth++;
		else if (tokens[i].v === ')' && --depth === 0) return false;
	}
	return true;
}

/** true/false for a condition of two numbers (`1=2`, `1 = 1`), else undefined. */
function constantCondition(tokens) {
	if (tokens.length !== 3 || tokens[0].t !== 'num' || tokens[2].t !== 'num') return undefined;
	const [a, op, b] = [Number(tokens[0].v), tokens[1].v, Number(tokens[2].v)];
	const result = { '=': a === b, '<>': a !== b, '!=': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[op];
	return result;
}

function blocked(st, reason) {
	return { kind: 'blocked', statement: st, text: st.text, reason };
}

function classify(st, sql) {
	const tk = st.tokens;
	const head = tk[0].u ?? tk[0].v;
	const base = { statement: st, text: st.text };
	const word = (i) => tk[i]?.u;
	switch (head) {
		case 'SET': {
			if (tk[1]?.t === 'var') {
				if (tk[1].v.startsWith('@@')) return blocked(st, `sets the system variable ${tk[1].v}`);
				const eq = tk.findIndex((t) => t.v === '=');
				if (eq !== 2) return blocked(st, `assigns ${tk[1].v} with an operator t2d does not handle`);
				const value = tk.slice(3);
				if (hasWord(value, ['SELECT']) && !scalarQuery(value)) return blocked(st, `sets the variable ${tk[1].v} from a query t2d cannot inline`);
				return { ...base, kind: 'variable', vars: [{ name: tk[1].v, value: sliceText(sql, value), query: hasWord(value, ['SELECT']) }] };
			}
			const option = tk[1]?.v ?? '';
			return { ...base, kind: 'session', option, affects: RESULT_SETTINGS.test(option) };
		}
		case 'ALTER':
			if (word(1) === 'SESSION' || word(1) === 'USER') {
				const option = tk[3]?.v ?? '';
				return { ...base, kind: 'session', option, affects: word(1) === 'SESSION' && tk.some((t) => t.t === 'word' && RESULT_SETTINGS.test(t.v)) };
			}
			return blocked(st, 'alters a database object (ALTER)');
		case 'USE': {
			const kindWord = ['DATABASE', 'SCHEMA', 'WAREHOUSE', 'ROLE', 'SECONDARY'].includes(word(1)) ? word(1) : 'DATABASE';
			const name = readName(tk, kindWord === 'DATABASE' && word(1) !== 'DATABASE' ? 1 : 2);
			if (!name) return blocked(st, 'has a USE statement t2d cannot read');
			return { ...base, kind: 'use', target: kindWord, parts: name.parts.map((p) => p.name) };
		}
		case 'DECLARE': {
			if (hasWord(tk, ['CURSOR'])) return blocked(st, 'declares a cursor, which reads rows one at a time');
			if (tk[1]?.t === 'var' && word(2) === 'TABLE') {
				const open = tk.findIndex((t) => t.v === '(');
				return { ...base, kind: 'create', temp: tk[1].v, columns: open > 0 ? columnList(tk.slice(open + 1, -1)) : null };
			}
			const vars = [];
			for (const part of splitTop(tk.slice(1))) {
				if (part[0]?.t !== 'var') return blocked(st, 'declares something t2d cannot read');
				const eq = part.findIndex((t) => t.v === '=');
				const value = eq > 0 ? part.slice(eq + 1) : null;
				if (value && hasWord(value, ['SELECT']) && !scalarQuery(value)) return blocked(st, `sets the variable ${part[0].v} from a query t2d cannot inline`);
				vars.push({ name: part[0].v, value: value ? sliceText(sql, value) : undefined, query: Boolean(value && hasWord(value, ['SELECT'])) });
			}
			return { ...base, kind: 'variable', vars };
		}
		case 'DROP': {
			if (!['TABLE', 'VIEW'].includes(word(1))) return blocked(st, `drops a ${tk[1]?.v ?? 'database object'}`);
			let i = 2;
			if (word(2) === 'IF' && word(3) === 'EXISTS') i = 4;
			const name = readName(tk, i);
			const last = name?.parts.at(-1)?.name ?? '';
			if (word(1) === 'TABLE' && isTempName(last)) return { ...base, kind: 'drop', temp: last };
			return { ...base, kind: 'drop', target: name ? name.parts.map((p) => p.name).join('.') : '', parts: name ? name.parts.map((p) => p.name) : [] };
		}
		case 'TRUNCATE': {
			const name = readName(tk, word(1) === 'TABLE' ? 2 : 1);
			return { ...base, kind: 'truncate', target: name ? name.parts.map((p) => p.name) : [] };
		}
		case 'CREATE': {
			let i = 1;
			if (word(i) === 'OR' && word(i + 1) === 'REPLACE') i += 2;
			let temp = false;
			while (TEMP_CREATE.test(word(i) ?? '')) {
				temp = true;
				i++;
			}
			if (word(i) === 'INDEX' || (word(i) === 'UNIQUE' || word(i) === 'CLUSTERED' || word(i) === 'NONCLUSTERED')) return { ...base, kind: 'index' };
			if (word(i) !== 'TABLE') return blocked(st, `creates a ${tk[i]?.v ?? 'database object'} (CREATE ${tk[i]?.v ?? ''})`);
			i++;
			if (word(i) === 'IF' && word(i + 1) === 'NOT' && word(i + 2) === 'EXISTS') i += 3;
			const name = readName(tk, i);
			if (!name) return blocked(st, 'creates a table t2d cannot read');
			const parts = name.parts.map((p) => p.name);
			temp ||= isTempName(parts.at(-1));
			if (!temp) return blocked(st, `creates the permanent table ${parts.join('.')}`);
			let j = name.end;
			if (tk[j]?.v === '(' && word(j + 1) !== 'SELECT') {
				let depth = 0;
				let k = j;
				for (; k < tk.length; k++) {
					if (tk[k].v === '(') depth++;
					else if (tk[k].v === ')' && --depth === 0) break;
				}
				const columns = columnList(tk.slice(j + 1, k));
				j = k + 1;
				if (word(j) !== 'AS') return { ...base, kind: 'create', temp: parts.at(-1), parts, columns };
			}
			const as = word(j) === 'AS' ? j + 1 : -1;
			if (as < 0) return blocked(st, 'creates a temp table t2d cannot read');
			let q = tk.slice(as);
			if (q[0]?.v === '(' && q.at(-1)?.v === ')') q = q.slice(1, -1);
			if (!['SELECT', 'WITH'].includes(q[0]?.u)) return blocked(st, 'creates a temp table from something other than a SELECT');
			return { ...base, kind: 'define', temp: parts.at(-1), parts, query: sliceText(sql, q) };
		}
		case 'WITH':
		case 'SELECT': {
			const into = topIndex(tk, ['INTO']);
			if (into >= 0) {
				const name = readName(tk, into + 1);
				if (!name) return blocked(st, 'selects INTO a target t2d cannot read');
				const parts = name.parts.map((p) => p.name);
				if (!isTempName(parts.at(-1))) return blocked(st, `writes to the database table ${parts.join('.')} (SELECT ... INTO)`);
				const query = `${sql.slice(st.start, tk[into].s).trimEnd()} ${sql.slice(tk[name.end - 1].e, st.end).trimStart()}`;
				return { ...base, kind: 'define', temp: parts.at(-1), parts, query };
			}
			if (head === 'SELECT' && tk[1]?.t === 'var') {
				const from = topIndex(tk, ['FROM']);
				const rest = from >= 0 ? ` ${sql.slice(tk[from].s, st.end)}` : '';
				const vars = [];
				for (const part of splitTop(tk.slice(1, from >= 0 ? from : tk.length))) {
					const eq = part.findIndex((t) => t.v === '=');
					if (part[0]?.t !== 'var' || eq !== 1) return blocked(st, 'assigns variables in a way t2d does not handle');
					const value = sliceText(sql, part.slice(2));
					vars.push({ name: part[0].v, value: rest ? `SELECT ${value}${rest}` : value, query: Boolean(rest) });
				}
				return { ...base, kind: 'variable', vars };
			}
			if (head === 'WITH' && topIndex(tk, ['INSERT', 'UPDATE', 'DELETE', 'MERGE']) >= 0) return blocked(st, 'writes rows from a WITH clause');
			return { ...base, kind: 'select' };
		}
		case 'INSERT': {
			const at = word(1) === 'INTO' ? 2 : 1;
			const name = readName(tk, at);
			if (!name) return blocked(st, 'inserts into a target t2d cannot read');
			const parts = name.parts.map((p) => p.name);
			let j = name.end;
			let columns = null;
			if (tk[j]?.v === '(') {
				let depth = 0;
				let k = j;
				for (; k < tk.length; k++) {
					if (tk[k].v === '(') depth++;
					else if (tk[k].v === ')' && --depth === 0) break;
				}
				columns = tk.slice(j + 1, k).filter(isName).map((t) => t.v);
				j = k + 1;
			}
			const rest = tk.slice(j);
			if (rest[0]?.u === 'VALUES') {
				const rows = splitTop(rest.slice(1)).map((row) => (row[0]?.v === '(' && row.at(-1)?.v === ')' ? splitTop(row.slice(1, -1)).map((v) => sliceText(sql, v)) : null));
				if (rows.some((r) => !r)) return blocked(st, 'inserts VALUES t2d cannot read');
				return { ...base, kind: 'insert', parts, temp: parts.at(-1), columns, values: rows };
			}
			if (rest[0]?.u === 'EXEC' || rest[0]?.u === 'EXECUTE') return blocked(st, 'inserts the result of a stored procedure (INSERT ... EXEC)');
			if (!['SELECT', 'WITH'].includes(rest[0]?.u)) return blocked(st, 'inserts rows t2d cannot read');
			return { ...base, kind: 'insert', parts, temp: parts.at(-1), columns, query: sliceText(sql, rest) };
		}
		case 'UPDATE': {
			const name = readName(tk, 1);
			const set = topIndex(tk, ['SET']);
			if (!name || set < 0) return blocked(st, 'updates rows in a way t2d cannot read');
			const parts = name.parts.map((p) => p.name);
			const from = topIndex(tk, ['FROM'], set);
			const where = topIndex(tk, ['WHERE'], set);
			const end = [from, where].filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? tk.length;
			const assignments = splitTop(tk.slice(set + 1, end)).map((a) => {
				const eq = a.findIndex((t) => t.v === '=');
				return { column: eq > 0 ? readName(a, 0)?.parts.at(-1)?.name : undefined, value: eq > 0 ? a.slice(eq + 1) : [], ok: eq > 0 && readName(a, 0)?.end === eq };
			});
			return { ...base, kind: 'update', parts, temp: parts.at(-1), assignments, from: from >= 0, where: where >= 0 ? tk.slice(where + 1) : null };
		}
		case 'DELETE': {
			let i = 1;
			if (word(1) === 'FROM') i = 2;
			if (word(i) === 'TOP') return blocked(st, 'deletes the TOP rows');
			const name = readName(tk, i);
			if (!name) return blocked(st, 'deletes rows in a way t2d cannot read');
			const parts = name.parts.map((p) => p.name);
			const from = topIndex(tk, ['FROM', 'USING'], name.end);
			const where = topIndex(tk, ['WHERE'], name.end);
			return { ...base, kind: 'delete', parts, temp: parts.at(-1), from: from >= 0, where: where >= 0 ? tk.slice(where + 1) : null };
		}
		case 'IF':
			return { ...base, kind: 'if' };
		case 'BEGIN':
			if (['TRAN', 'TRANSACTION'].includes(word(1))) return { ...base, kind: 'transaction' };
			if (word(1) === 'TRY' || word(1) === 'CATCH') return blocked(st, 'has a TRY ... CATCH block, which runs statements only on an error');
			return { ...base, kind: 'block' };
		case 'END':
			return { ...base, kind: 'block' };
		case 'COMMIT':
		case 'ROLLBACK':
			return { ...base, kind: 'transaction' };
		case 'PRINT':
			return { ...base, kind: 'print' };
		case 'WHILE':
			return blocked(st, 'has a WHILE loop, which runs statements repeatedly');
		case 'OPEN':
		case 'FETCH':
		case 'CLOSE':
		case 'DEALLOCATE':
			return blocked(st, 'uses a cursor, which reads rows one at a time');
		case 'EXEC':
		case 'EXECUTE':
		case 'CALL':
			return blocked(st, 'runs a stored procedure or dynamic SQL (EXEC)');
		case 'ELSE':
			return blocked(st, 'has an IF ... ELSE, which runs statements conditionally');
		case 'MERGE':
			return blocked(st, 'merges rows (MERGE)');
		case 'GOTO':
		case 'RETURN':
		case 'BREAK':
		case 'CONTINUE':
		case 'RAISERROR':
		case 'THROW':
			return blocked(st, `has control flow (${head})`);
		default:
			return blocked(st, `has a ${head} statement t2d does not translate`);
	}
}

function columnList(tokens) {
	return splitTop(tokens)
		.map((def) => (isName(def[0]) && !['CONSTRAINT', 'PRIMARY', 'INDEX', 'UNIQUE', 'FOREIGN', 'CHECK'].includes(def[0].u) ? def[0].v : null))
		.filter(Boolean);
}

/* Planning */

class PlanBlock extends Error {
	constructor(reason, where) {
		super(reason);
		this.where = where;
	}
}

const FOLD = { snowflake: (n) => n.toUpperCase(), oracle: (n) => n.toUpperCase(), postgres: (n) => n.toLowerCase(), redshift: (n) => n.toLowerCase() };

/**
 * Plan the streams and Magic ETL graphs for a connection whose Initial SQL creates temp tables.
 * @param {{ sql: string, tables: import('../model/types.js').TableIR[], dialect?: import('./connectors.js').Dialect, engine?: string }} opts
 *   `tables`: the datasource tables read through this connection
 * @returns {InitialSqlPlan}
 */
export function planInitialSql({ sql, tables, dialect = 'tsql', engine }) {
	const { statements, items } = parseInitialSql(sql);
	const fold = FOLD[engine] ?? ((n) => n);
	const plan = { statements, summary: [], streams: [], tables: new Map(), session: {}, notes: [] };
	const vars = new Map();
	/** @type {Map<string, { name: string, parts: string[], columns: string[]|null, rows: { query?: string, node?: Node, columns: string[]|null, mods: object[] }[], statement: number }>} */
	const temps = new Map();
	const streamsBySql = new Map();
	const stop = (item, reason) => {
		plan.blocked = { statement: item.statement.index, text: item.text, where: `Initial SQL statement ${item.statement.index} of ${statements.length}`, reason };
		return plan;
	};

	const substitute = (text) => {
		const tokens = tokenize(text);
		let out = '';
		let at = 0;
		for (const t of tokens) {
			if (t.t !== 'var' || t.v.startsWith('@@') || temps.has(lower(t.v))) continue;
			const key = lower(t.v);
			if (!vars.has(key)) throw new PlanBlock(`uses ${t.v}, which the Initial SQL does not declare`);
			const value = vars.get(key);
			if (value === undefined) throw new PlanBlock(`uses ${t.v} before it has a value`);
			if (value.temp) throw new PlanBlock(`uses ${t.v}, which is set from a query over ${value.temp}`);
			out += `${text.slice(at, t.s)}(${value.text})`;
			at = t.e;
		}
		if (tokens.some((t) => t.t === 'var' && t.v.startsWith('@@'))) throw new PlanBlock('uses a system variable (@@...)');
		return out + text.slice(at);
	};

	const findTemp = finder(temps);
	const scope = () => finder(new Map([...temps].map(([k, t]) => [k, { ...t, rows: t.rows.map((r) => ({ ...r, mods: [...r.mods] })) }])));

	const env = { dialect, fold, findTemp, plan, streamsBySql, temps };
	const batchTemps = new Set(items.filter((i) => (i.kind === 'create' || i.kind === 'define') && i.temp).map((i) => lower(i.temp)));

	for (const item of items) {
		const line = { index: item.statement.index, kind: item.kind, text: item.text };
		plan.summary.push(line);
		try {
			if (TABLEAU_PARAMETERS.test(item.text) && !['session', 'use'].includes(item.kind)) {
				return stop(item, `uses the Tableau parameter ${TABLEAU_PARAMETERS.exec(item.text)[0]}, which differs per user or workbook`);
			}
			switch (item.kind) {
				case 'blocked':
					return stop(item, item.reason);
				case 'session':
					line.note = item.affects ? `session setting ${item.option} is not applied by the connector; results that depend on it may differ` : 'session setting, not needed';
					if (item.affects) plan.notes.push(`Initial SQL statement ${item.statement.index} sets ${item.option}, which the connector session does not apply.`);
					break;
				case 'use':
					if (item.target === 'DATABASE') plan.session.dbname = item.parts.at(-1);
					else if (item.target === 'SCHEMA') {
						plan.session.schema = item.parts.at(-1);
						if (item.parts.length > 1) plan.session.dbname = item.parts.at(-2);
					} else if (item.target === 'WAREHOUSE') plan.session.warehouse = item.parts.at(-1);
					else plan.notes.push(`Initial SQL statement ${item.statement.index} switches the ${lower(item.target)} to ${item.parts.join('.')}; the Domo account's own ${lower(item.target)} is used.`);
					line.note = `sets the ${lower(item.target)} for the streams`;
					break;
				case 'variable':
					for (const v of item.vars) {
						const text = v.value === undefined ? undefined : substitute(v.value);
						const temp = v.query && text ? refsOf(text, env)[0]?.name : undefined;
						vars.set(lower(v.name), text === undefined ? undefined : { text, ...(temp ? { temp } : {}) });
					}
					line.note = item.vars.some((v) => v.query) ? 'variable from a query, inlined as a subquery' : 'variable, substituted into the queries';
					break;
				case 'drop':
					if (!item.temp && !batchTemps.has(lower(item.parts?.at(-1)))) return stop(item, `drops the database ${item.target ? `object ${item.target}` : 'object'}`);
					temps.delete(lower(item.temp ?? item.parts.at(-1)));
					line.note = 'drops a temp table, not needed';
					break;
				case 'index':
				case 'transaction':
				case 'print':
				case 'block':
				case 'select':
					line.note = item.kind === 'select' ? 'returns rows nobody reads, skipped' : 'not needed';
					break;
				case 'dead':
					line.note = item.note;
					break;
				case 'if':
					return stop(item, 'has an IF, which runs statements conditionally');
				case 'truncate': {
					const temp = findTemp(item.target);
					if (!temp) return stop(item, `empties the database table ${item.target.join('.')} (TRUNCATE)`);
					if (temp.rows.length) return stop(item, `empties ${temp.name} after rows were added to it`);
					line.note = 'empties a new temp table, not needed';
					break;
				}
				case 'create':
					temps.set(lower(item.temp), { name: item.temp, parts: item.parts ?? [item.temp], columns: item.columns, rows: [], statement: item.statement.index });
					line.temp = item.temp;
					line.note = 'creates a temp table';
					break;
				case 'define': {
					const query = substitute(item.query);
					temps.set(lower(item.temp), { name: item.temp, parts: item.parts, columns: null, rows: [{ query, columns: outputColumns(query, env), mods: [], findTemp: scope() }], statement: item.statement.index });
					const temp = temps.get(lower(item.temp));
					temp.columns = temp.rows[0].columns;
					line.temp = item.temp;
					line.note = 'temp table from one SELECT';
					break;
				}
				case 'insert': {
					const temp = findTemp(item.parts);
					if (!temp) return stop(item, `writes to the database table ${item.parts.join('.')} (INSERT)`);
					const query = item.values ? valuesQuery(item, temp, substitute, dialect) : substitute(item.query);
					if (refsOf(query, env).some((t) => t === temp)) return stop(item, `adds rows to ${temp.name} from ${temp.name} itself, row by row`);
					const names = temp.columns;
					const wanted = item.columns ?? names;
					if (!wanted) return stop(item, `adds rows to ${temp.name} without a column list, after a SELECT * INTO whose columns are unknown`);
					const aligned = item.values && (!names || names.join('\u0000') === wanted.join('\u0000'));
					temp.rows.push({ query: aligned ? query : alignColumns(query, wanted, names ?? wanted, dialect), columns: names ?? wanted, mods: [], findTemp: scope() });
					temp.columns ??= wanted;
					line.temp = temp.name;
					line.note = `${item.values ? 'fixed rows as a SELECT of the values' : 'rows from a SELECT'}${temp.rows.length > 1 ? ', added with UNION ALL' : ''}`;
					break;
				}
				case 'update':
				case 'delete': {
					const temp = findTemp(item.parts);
					if (!temp && item.from) return stop(item, `${item.kind === 'update' ? 'updates' : 'deletes'} rows through a join (${item.kind.toUpperCase()} ... FROM)`);
					if (!temp) return stop(item, `${item.kind === 'update' ? 'updates' : 'deletes from'} the database table ${item.parts.join('.')}`);
					if (item.from) return stop(item, `${item.kind === 'update' ? 'updates' : 'deletes from'} ${temp.name} through a join (${item.kind.toUpperCase()} ... FROM)`);
					if (item.kind === 'delete' && !item.where) return stop(item, `empties ${temp.name} (DELETE without WHERE)`);
					const mod = item.kind === 'update' ? updateMod(item, temp, substitute, env) : deleteMod(item, temp, substitute, env);
					for (const row of temp.rows) row.mods.push(mod);
					line.temp = temp.name;
					line.note = item.kind === 'update' ? 'updates rows: Magic ETL formula' : 'deletes rows: Magic ETL filter';
					break;
				}
				default:
					return stop(item, `has a ${item.kind} statement t2d does not translate`);
			}
		} catch (err) {
			if (err instanceof PlanBlock || err instanceof ExprError) return stop(item, err.message);
			throw err;
		}
	}

	for (const table of tables) {
		const where = `the custom SQL of table '${table.name || table.id}'`;
		try {
			let query;
			if (table.kind === 'custom-sql') query = table.sql ?? '';
			else if (table.kind === 'table') {
				const parts = relationNameParts(table.table || table.name);
				if (!findTemp(parts)) continue;
				query = `SELECT * FROM ${parts.map((p) => quoteIdentifier(p, dialect)).join('.')}`;
			} else continue;
			if (!refsOf(query, env).length) continue;
			const direct = directTemp(query, env);
			if (direct) {
				const node = tempNode(direct, env);
				plan.tables.set(table.id, node.op === 'input' ? { kind: 'stream', stream: node.stream } : { kind: 'etl', graph: node });
				continue;
			}
			plan.tables.set(table.id, { kind: 'etl', graph: queryGraph(query, env, table.name || table.id).node });
		} catch (err) {
			if (err instanceof PlanBlock || err instanceof ExprError) {
				plan.blocked = { ...(err.statement ? { statement: err.statement } : {}), text: err.text ?? (table.sql ?? '').trim(), where: err.where ?? where, reason: err.message };
				return plan;
			}
			throw err;
		}
	}
	const used = new Set();
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.op === 'input') used.add(node.stream);
		for (const v of Object.values(node)) (Array.isArray(v) ? v : [v]).forEach((x) => x?.op && visit(x));
	};
	for (const t of plan.tables.values()) (t.kind === 'stream' ? used.add(t.stream) : visit(t.graph));
	plan.streams = plan.streams.filter((s) => used.has(s.id));
	if (dialect === 'tsql' && [...plan.tables.values()].some((t) => t.kind === 'etl')) {
		plan.notes.push('Magic ETL compares text case-sensitively, while SQL Server usually does not: check joins and filters on text columns.');
	}
	return plan;
}

/** Look up a temp table by a (possibly qualified) name; qualifiers must match the end of the temp's own name. */
function finder(temps) {
	return (parts) => {
		const temp = temps.get(lower(parts.at(-1)));
		if (!temp) return undefined;
		const own = temp.parts.map(lower);
		const want = parts.map(lower).filter(Boolean);
		return want.every((p, i) => own[own.length - want.length + i] === p) ? temp : undefined;
	};
}

function relationNameParts(relation) {
	const tokens = tokenize(String(relation ?? ''));
	return readName(tokens, 0)?.parts.map((p) => p.name) ?? [String(relation ?? '')];
}

function updateMod(item, temp, substitute, env) {
	const parse = (tokens) => likeCase(parseExpression(tokens), env);
	const where = item.where ? parse(tokenize(substitute(sliceTokens(item.text, item.statement, item.where)))) : null;
	const sets = item.assignments.map((a) => {
		if (!a.ok || !a.column) throw new ExprError('sets a column in a way t2d does not handle');
		return { column: a.column, value: parse(tokenize(substitute(sliceTokens(item.text, item.statement, a.value)))) };
	});
	return { kind: 'update', where, sets, temp: temp.name, statement: item.statement.index };
}

function deleteMod(item, temp, substitute, env) {
	const where = parseExpression(tokenize(substitute(sliceTokens(item.text, item.statement, item.where))));
	return { kind: 'delete', where: likeCase(where, env), temp: temp.name, statement: item.statement.index };
}

function sliceTokens(text, st, tokens) {
	return tokens.length ? text.slice(tokens[0].s - st.start, tokens.at(-1).e - st.start) : '';
}

/** INSERT ... VALUES as a SELECT of the literal rows, so a connector stream can return them. */
function valuesQuery(item, temp, substitute, dialect) {
	const columns = item.columns ?? temp.columns;
	if (!columns) throw new PlanBlock(`adds fixed rows to ${temp.name} without a column list`);
	if (item.values.some((row) => row.length !== columns.length)) throw new PlanBlock(`adds fixed rows to ${temp.name} whose values do not match its columns`);
	return item.values.map((row) => `SELECT ${row.map((v, k) => `${substitute(v)} AS ${quoteIdentifier(columns[k], dialect)}`).join(', ')}`).join('\nUNION ALL\n');
}

/** Rows for INSERT INTO t (cols) SELECT, aligned to the temp table's columns by name. */
function alignColumns(query, insertColumns, tempColumns, dialect) {
	const q = (n) => quoteIdentifier(n, dialect);
	const byName = new Map(insertColumns.map((c) => [lower(c), c]));
	const list = tempColumns.map((c) => (byName.has(lower(c)) ? `t2d_rows.${q(byName.get(lower(c)))} AS ${q(c)}` : `NULL AS ${q(c)}`));
	return `SELECT ${list.join(', ')}\nFROM (\n${query}\n) AS t2d_rows (${insertColumns.map(q).join(', ')})`;
}

/* Query analysis */

const CLAUSES = ['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'OPTION', 'FOR', 'WINDOW', 'QUALIFY', 'LIMIT'];
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'APPLY']);

/** Temp tables a query reads (names after FROM, JOIN, APPLY or a FROM-list comma, at any depth). */
function refsOf(query, env) {
	const tokens = tokenize(query);
	const out = [];
	const clause = [];
	let depth = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.v === '(') {
			depth++;
			continue;
		}
		if (t.v === ')') {
			clause[depth] = undefined;
			depth--;
			continue;
		}
		if (t.t === 'word' && ['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'SELECT', 'ON', 'SET', 'UNION'].includes(t.u)) clause[depth] = t.u;
		const prev = tokens[i - 1];
		const after = prev && (['FROM', 'JOIN', 'APPLY', 'INTO', 'UPDATE'].includes(prev.u) || (prev.v === ',' && clause[depth] === 'FROM'));
		if (!after || !isName(t)) continue;
		const name = readName(tokens, i);
		const temp = env.findTemp(name.parts.map((p) => p.name));
		if (temp && !out.includes(temp)) out.push(temp);
	}
	return out;
}

/** The temp table of `SELECT * FROM #t [alias]`, else undefined. */
function directTemp(query, env) {
	const tokens = tokenize(query);
	if (tokens[0]?.u !== 'SELECT' || tokens[1]?.v !== '*' || tokens[2]?.u !== 'FROM') return undefined;
	const name = readName(tokens, 3);
	if (!name) return undefined;
	let end = name.end;
	if (tokens[end]?.u === 'AS') end++;
	if (isName(tokens[end]) && !RESERVED.has(tokens[end].u)) end++;
	if (end !== tokens.length) return undefined;
	return env.findTemp(name.parts.map((p) => p.name));
}

/** Output column names of a query (first branch), or null when it selects * from a table. */
function outputColumns(query, env) {
	try {
		const tokens = tokenize(query);
		const start = tokens[0]?.u === 'WITH' ? topIndex(tokens, ['SELECT']) : 0;
		const branch = splitBranches(tokens.slice(start))[0];
		const block = parseBlock(branch.tokens, query);
		const names = [];
		for (const item of block.items) {
			if (item.star) {
				const from = block.from[0];
				if (block.from.length === 1 && from?.derived) {
					const inner = outputColumns(query.slice(from.inner[0].s, from.inner.at(-1).e), env);
					if (!inner) return null;
					names.push(...inner);
				} else if (block.from.length === 1 && from && env.findTemp(from.parts)) {
					const cols = env.findTemp(from.parts).columns;
					if (!cols) return null;
					names.push(...cols);
				} else return null;
			} else if (item.name) names.push(item.name);
			else return null;
		}
		return names;
	} catch {
		return null;
	}
}

function splitBranches(tokens) {
	const branches = [{ tokens: [], op: null }];
	let depth = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.v === '(') depth++;
		else if (t.v === ')') depth--;
		if (depth === 0 && t.t === 'word' && ['UNION', 'EXCEPT', 'INTERSECT', 'MINUS'].includes(t.u)) {
			const all = tokens[i + 1]?.u === 'ALL';
			branches.push({ tokens: [], op: t.u === 'UNION' ? (all ? 'UNION ALL' : 'UNION') : t.u });
			if (all) i++;
			continue;
		}
		branches.at(-1).tokens.push(t);
	}
	return branches;
}

/**
 * One SELECT block: items, FROM items with joins, WHERE, GROUP BY, HAVING.
 * @param {Token[]} tokens
 * @param {string} sql  Source text the tokens point into
 */
function parseBlock(tokens, sql) {
	if (tokens[0]?.u !== 'SELECT') throw new PlanBlock('has a query that does not start with SELECT');
	let i = 1;
	const block = { distinct: false, top: null, items: [], from: [], where: null, groupBy: null, having: null, orderBy: false, extra: null, sql };
	if (tokens[i]?.u === 'DISTINCT') {
		block.distinct = true;
		i++;
	} else if (tokens[i]?.u === 'ALL') i++;
	if (tokens[i]?.u === 'TOP') {
		block.top = tokens[i + 1]?.v;
		i += tokens[i + 1]?.v === '(' ? 4 : 2;
		if (tokens[i]?.u === 'PERCENT') i++;
		if (tokens[i]?.u === 'WITH') i += 2;
	}
	const clauseAt = (word, from) => {
		const k = topIndex(tokens, [word], from);
		return k;
	};
	const positions = CLAUSES.map((w) => ({ w, k: clauseAt(w, i) })).filter((p) => p.k >= 0).sort((a, b) => a.k - b.k);
	const fromPos = positions.find((p) => p.w === 'FROM')?.k ?? tokens.length;
	const nextAfter = (k) => positions.find((p) => p.k > k)?.k ?? tokens.length;
	block.items = splitTop(tokens.slice(i, fromPos)).map((t) => parseItem(t, sql));
	if (fromPos < tokens.length) block.from = parseFrom(tokens.slice(fromPos + 1, nextAfter(fromPos)), sql);
	for (const p of positions) {
		const body = tokens.slice(p.k + (p.w === 'GROUP' || p.w === 'ORDER' ? 2 : 1), nextAfter(p.k));
		if (p.w === 'WHERE') block.where = body;
		else if (p.w === 'GROUP') block.groupBy = splitTop(body);
		else if (p.w === 'HAVING') block.having = body;
		else if (p.w === 'ORDER') block.orderBy = true;
		else if (p.w !== 'FROM') block.extra = p.w;
	}
	return block;
}

function parseItem(tokens, sql) {
	const text = sliceText(sql, tokens);
	if (tokens.length === 1 && tokens[0].v === '*') return { tokens, text, star: true };
	if (tokens.at(-1)?.v === '*' && tokens.at(-2)?.v === '.') return { tokens, text, star: true, qualifier: readName(tokens, 0).parts.map((p) => p.name) };
	if (isName(tokens[0]) && tokens[1]?.v === '=' && tokens.length > 2 && tokens[0].t !== 'var') {
		return { tokens, text, expr: tokens.slice(2), name: tokens[0].v, alias: true };
	}
	const last = tokens.at(-1);
	const prev = tokens.at(-2);
	if (tokens.length > 1 && isName(last) && !(last.t === 'word' && RESERVED.has(last.u))) {
		if (prev?.u === 'AS') return { tokens, text, expr: tokens.slice(0, -2), name: last.v, alias: true };
		if (prev && prev.v !== '.' && (prev.t !== 'op' || prev.v === ')') && !(prev.t === 'word' && ['NOT', 'AND', 'OR', 'IS', 'LIKE', 'IN', 'THEN', 'ELSE', 'WHEN', 'CASE', 'DISTINCT'].includes(prev.u))) {
			return { tokens, text, expr: tokens.slice(0, -1), name: last.v, alias: true };
		}
	}
	if (last?.t === 'str' && prev?.u === 'AS') return { tokens, text, expr: tokens.slice(0, -2), name: last.v.slice(1, -1), alias: true };
	const name = readName(tokens, 0);
	if (name && name.end === tokens.length) return { tokens, text, expr: tokens, name: name.parts.at(-1).name, column: name.parts.map((p) => p.name) };
	return { tokens, text, expr: tokens, name: null };
}

function parseFrom(tokens, sql) {
	const items = [];
	let i = 0;
	const readItem = () => {
		const start = i;
		let derived = null;
		let parts = null;
		if (tokens[i]?.v === '(') {
			let depth = 0;
			let k = i;
			for (; k < tokens.length; k++) {
				if (tokens[k].v === '(') depth++;
				else if (tokens[k].v === ')' && --depth === 0) break;
			}
			derived = tokens.slice(i + 1, k);
			i = k + 1;
		} else {
			const name = readName(tokens, i);
			if (!name) throw new PlanBlock(`has a FROM clause t2d cannot read near '${tokens[i]?.v ?? 'the end'}'`);
			parts = name.parts.map((p) => p.name);
			i = name.end;
			if (tokens[i]?.v === '(') throw new PlanBlock(`reads a table function ${parts.join('.')}`);
		}
		if (tokens[i]?.u === 'AS') i++;
		let alias = null;
		if (isName(tokens[i]) && !(tokens[i].t === 'word' && (RESERVED.has(tokens[i].u) || JOIN_WORDS.has(tokens[i].u)))) alias = tokens[i++].v;
		if (tokens[i]?.v === '(' && derived && alias) {
			while (i < tokens.length && tokens[i].v !== ')') i++;
			i++;
		}
		if (tokens[i]?.u === 'WITH' && tokens[i + 1]?.v === '(') {
			while (i < tokens.length && tokens[i].v !== ')') i++;
			i++;
		}
		const itemTokens = tokens.slice(start, i);
		return { parts, derived: Boolean(derived), inner: derived, alias: alias ?? parts?.at(-1) ?? null, text: sliceText(sql, itemTokens) };
	};
	const readJoin = () => {
		const start = i;
		const words = [];
		while (tokens[i]?.t === 'word' && JOIN_WORDS.has(tokens[i].u)) words.push(tokens[i++].u);
		if (!words.length) return null;
		const type = words.includes('CROSS') || words.includes('APPLY') ? (words.includes('APPLY') ? `${words[0]} APPLY` : 'CROSS') : words.includes('LEFT') ? 'LEFT' : words.includes('RIGHT') ? 'RIGHT' : words.includes('FULL') ? 'FULL' : 'INNER';
		return { type, keyword: sliceText(sql, tokens.slice(start, i)) };
	};
	const first = readItem();
	items.push({ ...first, join: null });
	while (i < tokens.length) {
		if (tokens[i].v === ',') {
			i++;
			items.push({ ...readItem(), join: { type: 'COMMA', keyword: ',' } });
			continue;
		}
		const pending = readJoin();
		if (!pending) throw new PlanBlock(`has a FROM clause t2d cannot read near '${tokens[i].v}'`);
		const item = readItem();
		let on = null;
		if (tokens[i]?.u === 'ON') {
			i++;
			const start = i;
			let depth = 0;
			for (; i < tokens.length; i++) {
				const t = tokens[i];
				if (t.v === '(') depth++;
				else if (t.v === ')') depth--;
				else if (depth === 0 && (t.v === ',' || (t.t === 'word' && JOIN_WORDS.has(t.u) && !['OUTER'].includes(t.u)))) break;
			}
			on = tokens.slice(start, i);
		}
		items.push({ ...item, join: pending, on, onText: on ? sliceText(sql, on) : null });
	}
	return items;
}

/** Aliases (lower case) that a token list qualifies a column with. */
function qualifiers(tokens) {
	const out = new Set();
	for (let i = 0; i + 2 < tokens.length; i++) {
		if (isName(tokens[i]) && tokens[i + 1]?.v === '.' && (isName(tokens[i + 2]) || tokens[i + 2]?.v === '*') && tokens[i - 1]?.v !== '.') out.add(lower(tokens[i].v));
	}
	return out;
}

/** Unqualified column names in a token list (not functions, keywords, aliases after AS or CAST types). */
function bareNames(tokens) {
	const out = new Set();
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!isName(t) || (t.t === 'word' && RESERVED.has(t.u))) continue;
		if (tokens[i - 1]?.v === '.' || tokens[i + 1]?.v === '.' || tokens[i + 1]?.v === '(' || tokens[i - 1]?.u === 'AS') continue;
		out.add(lower(t.v));
	}
	return out;
}

/**
 * A query that reads temp tables, as a Magic ETL graph.
 * @returns {{ node: Node, columns: string[]|null }}
 */
function queryGraph(query, env, label) {
	const tokens = tokenize(query);
	if (tokens[0]?.u === 'WITH') throw new PlanBlock('reads a temp table inside a WITH clause');
	const branches = splitBranches(tokens);
	const built = branches.map((b, n) => {
		if (b.op && b.op !== 'UNION' && b.op !== 'UNION ALL') throw new PlanBlock(`combines queries with ${b.op}`);
		const text = sliceText(query, b.tokens);
		if (b.tokens[0]?.v === '(') throw new PlanBlock('has a parenthesized query in a UNION');
		const direct = directTemp(text, env);
		if (direct) return { node: tempNode(direct, env), columns: direct.columns, op: b.op };
		if (!refsOf(text, env).length) {
			const columns = outputColumns(text, env);
			return { node: streamNode(text, env, `${label}${branches.length > 1 ? ` part ${n + 1}` : ''}`), columns, op: b.op };
		}
		return { ...blockGraph(parseBlock(b.tokens, query), env, label), op: b.op };
	});
	if (built.length === 1) return built[0];
	const names = built[0].columns;
	if (!names || built.some((b) => !b.columns || b.columns.length !== names.length)) throw new PlanBlock('has a UNION whose column names t2d cannot line up (SELECT * in a branch)');
	const inputs = built.map((b, n) => {
		if (n === 0) return b.node;
		const fields = b.columns.map((c, k) => (c === names[k] ? null : { name: c, rename: names[k] })).filter(Boolean);
		return fields.length ? { op: 'metadata', from: b.node, fields, label: `Name the columns of part ${n + 1}` } : b.node;
	});
	let node = { op: 'union', inputs };
	if (built.slice(1).some((b) => b.op === 'UNION')) node = { op: 'distinct', from: node };
	return { node, columns: names };
}

function streamNode(sql, env, label, temp) {
	const key = sql.trim();
	let stream = env.streamsBySql.get(key);
	if (!stream) {
		const base = slugish(temp ?? label);
		let id = base;
		let n = 2;
		while (env.plan.streams.some((s) => s.id === id)) id = `${base}-${n++}`;
		stream = { id, label: temp ?? label, sql: key, ...(temp ? { temp } : {}) };
		env.streamsBySql.set(key, stream);
		env.plan.streams.push(stream);
	}
	return { op: 'input', stream: stream.id };
}

const slugish = (v) => String(v).replace(/^#+|^@/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'query';

/** The graph for a temp table's rows: streams for SELECTs over base tables, ETL for the rest and for UPDATE/DELETE. */
function tempNode(temp, env) {
	try {
		return tempRows(temp, env);
	} catch (err) {
		if ((err instanceof PlanBlock || err instanceof ExprError) && !err.where && temp.statement) {
			err.where = `Initial SQL statement ${temp.statement} of ${env.plan.statements.length} (${temp.name})`;
			err.text = env.plan.statements[temp.statement - 1]?.text;
			err.statement = temp.statement;
		}
		throw err;
	}
}

function tempRows(temp, env) {
	if (!temp.rows.length) throw new PlanBlock(`reads ${temp.name}, which the Initial SQL creates but never fills`);
	const scopeOf = (row) => (row.findTemp ? { ...env, findTemp: row.findTemp } : env);
	if (temp.rows.length > 1 && temp.rows.every((r) => !r.node && !r.mods.length && !refsOf(r.query, scopeOf(r)).length)) {
		return streamNode(temp.rows.map((r) => r.query).join('\nUNION ALL\n'), env, temp.name, temp.name);
	}
	const parts = temp.rows.map((row) => {
		let node;
		const scoped = scopeOf(row);
		if (row.node) node = row.node;
		else if (refsOf(row.query, scoped).length) node = queryGraph(row.query, scoped, temp.name).node;
		else node = streamNode(row.query, env, temp.name, temp.name);
		for (const mod of row.mods) node = applyMod(node, mod, temp, env);
		return node;
	});
	return parts.length === 1 ? parts[0] : { op: 'union', inputs: parts };
}

function applyMod(node, mod, temp, env) {
	const column = (parts) => columnOf(parts, temp, env);
	if (mod.kind === 'delete') {
		return { op: 'filter', from: node, expression: `CASE WHEN ${toFormula(mod.where, column)} THEN 0 ELSE 1 END = 1`, label: `DELETE in statement ${mod.statement}` };
	}
	const fields = mod.sets.map((s, k) => {
		const value = toFormula(s.value, column);
		const name = column([s.column]);
		return { name: `_t2d_update_${mod.statement}_${k + 1}`, column: name, expression: mod.where ? `CASE WHEN ${toFormula(mod.where, column)} THEN ${value} ELSE ${backtick(name)} END` : value };
	});
	const computed = { op: 'formula', from: node, fields: fields.map(({ name, expression }) => ({ name, expression })), label: `UPDATE in statement ${mod.statement}` };
	const dropped = { op: 'metadata', from: computed, fields: fields.map((f) => ({ name: f.column, remove: true })), label: `Replace the updated columns (statement ${mod.statement})` };
	return { op: 'metadata', from: dropped, fields: fields.map((f) => ({ name: f.name, rename: f.column })), label: `Updated columns (statement ${mod.statement})` };
}

function columnOf(parts, temp, env) {
	const name = parts.at(-1);
	const known = temp.columns?.find((c) => lower(c) === lower(name));
	return known ?? env.fold(name);
}

/**
 * One SELECT block that joins temp tables: a stream for its base tables, then Magic ETL joins, filters, formulas,
 * group-bys and the final column names.
 */
function blockGraph(block, env, label) {
	const { fold } = env;
	if (block.top) throw new PlanBlock('takes the TOP rows of a temp table join');
	if (block.extra) throw new PlanBlock(`has a ${block.extra} clause over a temp table join`);
	if (!block.from.length) throw new PlanBlock('has no FROM clause');
	const items = block.from.map((f) => {
		if (!f.derived) return { ...f, temp: env.findTemp(f.parts) };
		const inner = sliceText(block.sql, f.inner);
		if (!refsOf(inner, env).length) return { ...f };
		if (!f.alias) throw new PlanBlock('reads a temp table in a subquery without an alias');
		const g = queryGraph(inner, env, `${label} ${f.alias}`);
		return { ...f, temp: { name: `subquery ${f.alias}`, parts: [f.alias], columns: g.columns, rows: [{ node: g.node, columns: g.columns, mods: [] }] } };
	});
	const aliasOf = (f) => lower(f.alias ?? f.parts?.at(-1));
	const tempAliases = new Map(items.filter((f) => f.temp).map((f) => [aliasOf(f), f]));
	const baseItems = items.filter((f) => !f.temp);
	const firstBase = items.findIndex((f) => !f.temp);
	let seenTemp = Boolean(items[0].temp);
	let attachedLeft = false;
	items.forEach((f, n) => {
		if (n === 0) return;
		const type = f.join?.type;
		if (f.temp) {
			if (type !== 'INNER' && type !== 'LEFT') throw new PlanBlock(`joins ${f.temp.name} with a ${type === 'COMMA' ? 'comma (cross) join' : `${type} join`}; Magic ETL needs an inner or left join on equal columns`);
			seenTemp = true;
			return;
		}
		if (n === firstBase) {
			if (type !== 'INNER' && type !== 'LEFT') throw new PlanBlock(`joins ${itemLabel(f)} to a temp table with a ${type === 'COMMA' ? 'comma (cross) join' : `${type} join`}; Magic ETL needs an inner or left join on equal columns`);
			attachedLeft = type === 'LEFT';
			return;
		}
		if (seenTemp && type !== 'INNER' && type !== 'LEFT') throw new PlanBlock(`has a ${type} join after a temp table join`);
		if (attachedLeft && type !== 'LEFT') throw new PlanBlock(`inner-joins ${itemLabel(f)} to a table that is left-joined to a temp table`);
		if (f.on && [...qualifiers(f.on)].some((a) => tempAliases.has(a))) throw new PlanBlock(`joins ${itemLabel(f)} on temp table columns`);
	});

	const tempColumns = new Map();
	for (const [alias, f] of tempAliases) tempColumns.set(alias, new Set((f.temp.columns ?? []).map(lower)));
	const onlyTempBare = (name) => {
		const owners = [...tempColumns.entries()].filter(([, cols]) => cols.has(name)).map(([a]) => a);
		return owners.length === 1 ? owners[0] : undefined;
	};
	const touchesTemp = (tokens) => [...qualifiers(tokens)].some((a) => tempAliases.has(a)) || [...bareNames(tokens)].some((n) => onlyTempBare(n));

	const baseHelpers = new Map();
	const tempNeeds = new Map([...tempAliases.keys()].map((a) => [a, new Map()]));
	const working = (parts) => {
		const alias = parts.length > 1 ? lower(parts.at(-2)) : onlyTempBare(lower(parts[0]));
		const col = parts.at(-1);
		if (alias && tempAliases.has(alias)) {
			const temp = tempAliases.get(alias).temp;
			const real = temp.columns?.find((c) => lower(c) === lower(col)) ?? fold(col);
			const name = `_t2d_${alias}_${real}`;
			tempNeeds.get(alias).set(lower(real), { name: real, rename: name });
			return name;
		}
		const key = parts.map(lower).join('.');
		if (!baseHelpers.has(key)) baseHelpers.set(key, { sql: parts.map((p) => quoteIdentifier(p, env.dialect)).join('.'), name: `_t2d_${parts.join('_')}` });
		return baseHelpers.get(key).name;
	};
	const parse = (tokens) => likeCase(parseExpression(tokens), env);
	const formula = (tokens, aggregate) => toFormula(parse(tokens), working, aggregate);

	const keys = [];
	const joinFilters = [];
	const keyFormulas = new Map();
	let keyCount = 0;
	const baseKey = (node, sql) => {
		const cols = [];
		walk(node, (n) => n.k === 'col' && cols.push(n));
		if (cols.some((c) => tempAliases.has(c.parts.length > 1 ? lower(c.parts.at(-2)) : onlyTempBare(lower(c.parts[0]))))) {
			throw new PlanBlock(`joins on '${sql.slice(node.start, node.end)}', an expression of an earlier temp table`);
		}
		const name = `_t2d_key_${++keyCount}`;
		baseHelpers.set(`key ${name}`, { sql: sql.slice(node.start, node.end), name });
		return name;
	};
	const tempKey = (f, node) => {
		const name = `_t2d_key_${++keyCount}`;
		if (!keyFormulas.has(f)) keyFormulas.set(f, []);
		keyFormulas.get(f).push({ name, expression: toFormula(node, working) });
		return name;
	};
	const baseAliases = new Set(baseItems.map(aliasOf));
	for (const f of items.filter((x, n) => n > 0 && (x.temp || n === firstBase))) {
		const what = f.temp?.name ?? itemLabel(f);
		if (!f.on) throw new PlanBlock(`joins ${what} without an ON condition`);
		const owner = (c) => (c.parts.length > 1 ? lower(c.parts.at(-2)) : onlyTempBare(lower(c.parts[0])));
		const mine = f.temp ? (c) => owner(c) === aliasOf(f) : (c) => !tempAliases.has(owner(c)) && (c.parts.length === 1 || baseAliases.has(owner(c)));
		const pairs = [];
		const rightFilters = [];
		for (const conj of splitTop(f.on, 'AND')) {
			const node = parse(conj);
			const eq = node.k === 'paren' ? node.e : node;
			const text = sliceText(block.sql, conj);
			const cols = [];
			walk(node, (n) => n.k === 'col' && cols.push(n));
			const side = (e) => {
				const c = [];
				walk(e, (n) => n.k === 'col' && c.push(n));
				return !c.length ? 'none' : c.every(mine) ? 'mine' : c.some(mine) ? 'mixed' : 'other';
			};
			const sides = eq.k === 'bin' && eq.op === '=' ? [side(eq.l), side(eq.r)] : [];
			if (sides.includes('mine') && sides.includes('other')) {
				const [right, left] = sides[0] === 'mine' ? [eq.l, eq.r] : [eq.r, eq.l];
				const leftKey = left.k === 'col' ? working(left.parts) : baseKey(left, block.sql);
				const rightKey = right.k === 'col' ? working(right.parts) : f.temp ? tempKey(f, right) : baseKey(right, block.sql);
				pairs.push({ left: leftKey, right: rightKey });
			} else if (cols.length && cols.every(mine)) {
				rightFilters.push(f.temp ? toFormula(node, working) : text);
			} else if (cols.length && !cols.some(mine) && f.join.type === 'INNER') {
				joinFilters.push(toFormula(node, working));
			} else {
				throw new PlanBlock(`joins ${what} on '${text}', which is not an equality of two columns`);
			}
		}
		if (!pairs.length) throw new PlanBlock(`joins ${what} without an equality of two columns`);
		if (keyFormulas.has(f)) rightFilters.unshift({ formulas: keyFormulas.get(f) });
		keys.push({ item: f, pairs, rightFilters });
	}

	const whereParts = block.where ? splitTop(block.where, 'AND') : [];
	const baseWhere = [];
	const etlWhere = [];
	for (const conj of whereParts) (touchesTemp(conj) ? etlWhere : baseWhere).push(conj);
	if (block.having && !block.groupBy) throw new PlanBlock('has HAVING without GROUP BY over a temp table join');

	const outputs = [];
	const baseSelect = [];
	const formulas = [];
	const renames = [];
	const groupMode = Boolean(block.groupBy);
	const groupFields = [];
	const groupKeys = [];
	const postFormulas = [];
	const outName = (item) => (item.alias ? item.name : item.name ? (item.column ? fold(item.name) : item.name) : null);

	if (groupMode) {
		const keyByText = new Map();
		block.groupBy.forEach((g, n) => {
			const node = parse(g);
			let name;
			if (node.k === 'col') name = working(node.parts);
			else {
				name = `_t2d_group_${n + 1}`;
				formulas.push({ name, expression: toFormula(node, working) });
			}
			keyByText.set(normalized(g), name);
			groupKeys.push(name);
		});
		let hidden = 0;
		for (const item of block.items) {
			if (item.star) throw new PlanBlock('selects * with GROUP BY over a temp table join');
			const name = outName(item);
			if (!name) throw new PlanBlock(`selects '${item.text}' without a column name`);
			const node = parse(item.expr);
			if (hasAggregate(node)) {
				const outside = [];
				walkOutsideAggregates(node, (n) => n.k === 'col' && outside.push(n));
				if (outside.length) throw new PlanBlock(`selects '${item.text}', which mixes aggregated and grouped columns`);
				groupFields.push({ name, expression: toFormula(node, working) });
			} else if (keyByText.has(normalized(item.expr))) {
				renames.push({ from: keyByText.get(normalized(item.expr)), to: name });
			} else {
				const cols = [];
				walk(node, (n) => n.k === 'col' && cols.push(n));
				const keyed = cols.every((c) => groupKeys.includes(working(c.parts)));
				if (!keyed) throw new PlanBlock(`selects '${item.text}', which is neither grouped nor aggregated`);
				postFormulas.push({ name, expression: toFormula(node, working) });
			}
			outputs.push(name);
		}
		if (block.having) {
			const aggregates = [];
			const expression = toFormula(parse(block.having), working, (fn) => {
				const name = `_t2d_having_${++hidden}`;
				aggregates.push({ name, expression: toFormula(fn, working) });
				return name;
			});
			groupFields.push(...aggregates);
			postFormulas.push({ filter: expression, hidden: aggregates.map((a) => a.name) });
		}
	} else {
		for (const item of block.items) {
			if (item.star) {
				const aliases = item.qualifier ? [lower(item.qualifier.at(-1))] : items.map(aliasOf);
				const taken = new Set();
				for (const alias of aliases) {
					if (!tempAliases.has(alias)) {
						baseSelect.push(item.qualifier ? item.text : `${quoteIdentifier(items.find((f) => aliasOf(f) === alias).alias, env.dialect)}.*`);
						outputs.push(null);
						continue;
					}
					const temp = tempAliases.get(alias).temp;
					if (!temp.columns) throw new PlanBlock(`selects ${item.qualifier ? item.text : '*'} from ${temp.name}, whose columns t2d cannot know`);
					for (const c of temp.columns) {
						if (taken.has(lower(c))) throw new PlanBlock(`selects * with the column ${c} in two tables`);
						taken.add(lower(c));
						renames.push({ from: working([alias, c]), to: c });
						outputs.push(c);
					}
				}
				continue;
			}
			const name = outName(item);
			if (!touchesTemp(item.expr)) {
				const node = safeParse(item.expr);
				if (node && hasAggregate(node)) throw new PlanBlock(`selects the aggregate '${item.text}' without GROUP BY over a temp table join`);
				if (/\bOVER\s*\(/i.test(item.text) && (etlWhere.length || keys.some((k) => k.item.join.type === 'INNER'))) {
					throw new PlanBlock(`has the window function '${item.text}', which would see rows a temp table join or filter removes`);
				}
				baseSelect.push(item.alias || !name ? item.text : `${item.text} AS ${quoteIdentifier(name, env.dialect)}`);
				outputs.push(name);
				continue;
			}
			if (!name) throw new PlanBlock(`selects '${item.text}' without a column name`);
			const node = parse(item.expr);
			if (hasAggregate(node)) throw new PlanBlock(`selects the aggregate '${item.text}' without GROUP BY`);
			if (node.k === 'col') renames.push({ from: working(node.parts), to: name });
			else formulas.push({ name, expression: toFormula(node, working), output: true });
			outputs.push(name);
		}
	}
	const etlFilters = [...joinFilters, ...etlWhere.map((conj) => formula(conj))];
	const filterExpression = etlFilters.map((e) => (etlFilters.length > 1 ? `(${e})` : e)).join(' AND ');

	const baseSql = (() => {
		if (!baseItems.length) return null;
		const list = [...(groupMode ? [] : baseSelect), ...[...baseHelpers.values()].map((h) => `${h.sql} AS ${quoteIdentifier(h.name, env.dialect)}`)];
		if (!list.length) list.push(`1 AS ${quoteIdentifier('_t2d_row', env.dialect)}`);
		const from = baseItems.map((f, n) => (n === 0 ? f.text : `${f.join.keyword} ${f.text}${f.onText ? ` ON ${f.onText}` : ''}`)).join('\n');
		const attach = keys.find((k) => !k.item.temp);
		const where = [...baseWhere.map((c) => sliceText(block.sql, c)), ...(attach?.rightFilters ?? []).filter((c) => typeof c === 'string')];
		return `SELECT\n\t${list.join(',\n\t')}\nFROM ${from}${where.length ? `\nWHERE ${where.length > 1 ? where.map((w) => `(${w})`).join('\nAND ') : where[0]}` : ''}`;
	})();

	const baseNode = baseSql ? streamNode(baseSql, env, `${label} (database tables)`) : null;
	if (!baseNode && items.length === 1 && !filterExpression && !formulas.length && !groupMode && !block.distinct && renames.length === outputs.length) {
		const real = new Map([...tempNeeds.get(aliasOf(items[0])).values()].map((f) => [f.rename, f.name]));
		const fields = renames.map((r) => ({ name: real.get(r.from), ...(real.get(r.from) !== r.to ? { rename: r.to } : {}) }));
		return { node: { op: 'select', from: tempNode(items[0].temp, env), fields }, columns: outputs };
	}
	const tempInput = (f, conditions = []) => {
		let node = { op: 'select', from: tempNode(f.temp, env), fields: [...tempNeeds.get(aliasOf(f)).values()] };
		const formulas = conditions.find((c) => c.formulas)?.formulas;
		const filters = conditions.filter((c) => typeof c === 'string');
		if (formulas) node = { op: 'formula', from: node, fields: formulas, label: `Join keys of ${f.temp.name}` };
		if (!filters.length) return node;
		return { op: 'filter', from: node, expression: filters.map((e) => (filters.length > 1 ? `(${e})` : e)).join(' AND '), label: `Join condition on ${f.temp.name}` };
	};
	let node = firstBase === 0 ? baseNode : tempInput(items[0]);
	for (const { item, pairs, rightFilters } of keys) {
		node = { op: 'join', left: node, right: item.temp ? tempInput(item, rightFilters) : baseNode, joinType: item.join.type === 'LEFT' ? 'LEFT OUTER' : 'INNER', keys: pairs };
	}
	if (filterExpression) node = { op: 'filter', from: node, expression: filterExpression, label: 'WHERE over the temp table join' };
	if (formulas.length) node = { op: 'formula', from: node, fields: formulas.map(({ name, expression }) => ({ name, expression })), label: groupMode ? 'Group keys' : 'Columns computed from temp tables' };
	if (groupMode) {
		node = { op: 'group', from: node, groups: groupKeys, fields: groupFields };
		const columns = postFormulas.filter((p) => !p.filter);
		if (columns.length) node = { op: 'formula', from: node, fields: columns.map((p) => ({ name: p.name, expression: p.expression })), label: 'Columns from group keys' };
		for (const p of postFormulas.filter((x) => x.filter)) {
			node = { op: 'filter', from: node, expression: p.filter, label: 'HAVING' };
			node = { op: 'metadata', from: node, fields: p.hidden.map((name) => ({ name, remove: true })), label: 'Drop HAVING helpers' };
		}
	}
	const kept = new Set(renames.map((r) => r.to));
	const renamed = new Set(renames.map((r) => r.from));
	const helperNames = groupMode
		? groupKeys.filter((k) => !renamed.has(k))
		: [...new Set([...[...baseHelpers.values()].map((h) => h.name), ...[...tempNeeds.values()].flatMap((m) => [...m.values()].map((f) => f.rename)), ...[...keyFormulas.values()].flat().map((k) => k.name)])].filter((n) => !renamed.has(n));
	const metadata = [
		...renames.map((r) => ({ name: r.from, rename: r.to })),
		...helperNames.filter((n) => !kept.has(n)).map((name) => ({ name, remove: true }))
	];
	const duplicates = renames.filter((r, k) => renames.findIndex((x) => x.from === r.from) !== k);
	if (duplicates.length) throw new PlanBlock(`selects ${duplicates[0].from.replace(/^_t2d_/, '')} twice under different names`);
	if (metadata.length) node = { op: 'metadata', from: node, fields: metadata, label: 'Final column names' };
	if (block.distinct) node = { op: 'distinct', from: node };
	if (block.orderBy) env.plan.notes.push(`${label}: ORDER BY is dropped (Domo DataSets have no row order).`);
	return { node, columns: outputs.includes(null) ? null : outputs };
}

const itemLabel = (f) => (f.derived ? `subquery ${f.alias ?? ''}`.trim() : f.parts.filter(Boolean).join('.'));

function walkOutsideAggregates(node, fn) {
	if (!node || typeof node !== 'object') return;
	if (node.k === 'fn' && AGGREGATES.has(node.name)) return;
	fn(node);
	for (const v of Object.values(node)) {
		if (Array.isArray(v)) v.forEach((x) => (Array.isArray(x) ? x.forEach((y) => walkOutsideAggregates(y, fn)) : walkOutsideAggregates(x, fn)));
		else if (v && typeof v === 'object' && v.k) walkOutsideAggregates(v, fn);
	}
}

function safeParse(tokens) {
	try {
		return parseExpression(tokens);
	} catch {
		return null;
	}
}

const normalized = (tokens) => tokens.map((t) => (t.t === 'word' ? t.u : t.t === 'qid' ? t.v.toUpperCase() : t.v)).join(' ');

/** One line per statement, for issues and the report. */
export function describeInitialSql(plan) {
	return plan.summary.map((s) => `${s.index}. ${oneLine(s.text, 70)}: ${s.note ?? s.kind}`);
}

export function oneLine(text, max = 90) {
	const flat = String(text ?? '').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Issue text for Initial SQL that cannot run on connector streams. */
export function initialSqlBlockedMessage(blocked) {
	return `${blocked.where}${blocked.text ? ` (${oneLine(blocked.text, 120)})` : ''} ${blocked.reason}. A connector stream runs one query, so t2d turns each temp table built by one SELECT into its own stream and joins, filters, GROUP BY, simple expressions, unions and set-based UPDATE or DELETE into Magic ETL; this statement has no such translation.`;
}

const ENGINES = { snowflake: 'snowflake', postgres: 'postgres', redshift: 'redshift', oracle: 'oracle' };

/**
 * Plan the Initial SQL of every connection of a datasource that has one, with the tables read through it.
 * @param {import('../model/types.js').DatasourceIR} source
 * @returns {{ connection: import('../model/types.js').ConnectionIR, tables: import('../model/types.js').TableIR[], plan: InitialSqlPlan }[]}
 */
export function planDatasourceInitialSql(source) {
	const conns = source.connections ?? [];
	const byConnection = new Map();
	for (const table of source.tables ?? []) {
		const connection = conns.find((c) => c.id === table.connectionId) ?? conns.find((c) => isConnectorClass(c.class)) ?? conns[0];
		if (!initialSqlOf(connection)) continue;
		if (!byConnection.has(connection)) byConnection.set(connection, []);
		byConnection.get(connection).push(table);
	}
	return [...byConnection].map(([connection, tables]) => ({
		connection,
		tables,
		plan: planInitialSql({ sql: initialSqlOf(connection), tables, dialect: connectorSpec(connectorFamily(connection.class))?.dialect ?? 'ansi', engine: ENGINES[lower(connection.class)] })
	}));
}
