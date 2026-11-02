/**
 * Readable layout for the SQL t2d writes (Beast Modes, card formulas, Magic ETL expressions, SQL DataSet Views), in the
 * style of the sql-formatter defaults Domo's SQL editors use (the Beast Mode editor has no format
 * action): 2-space indent, CASE with one WHEN / ELSE per line and END on its own line, a parenthesized expression longer
 * than 50 characters (or holding a CASE) broken one argument per line, AND / OR at the start of a line in a long
 * condition. Only whitespace between tokens changes (and keywords and function names are upper-cased): literals,
 * backticked and quoted names keep their text, and the result is checked token by token against the input. SQL with
 * comments, dollar-quoted strings or unbalanced parentheses / CASE is returned unchanged. Pure.
 */

const INDENT = '  ';
const EXPRESSION_WIDTH = 50;
/** Larger SQL is generated (inlined calcs) and left as one line: indentation would grow it a lot. */
const MAX_FORMAT_CHARS = 64 * 1024;

const KEYWORDS = new Set(
	[
		'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'AS', 'DISTINCT', 'OVER', 'PARTITION', 'BY',
		'ORDER', 'ASC', 'DESC', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'INTERVAL', 'FIXED', 'FILTER', 'ALLOW', 'DENY',
		'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON',
		'USING', 'WITH', 'QUALIFY', 'EXISTS', 'ANY', 'SOME', 'TRUE', 'FALSE', 'YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND'
	]
);
const LOGICAL = new Set(['AND', 'OR']);
const CLAUSES = ['WITH', 'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'QUALIFY', 'ORDER BY', 'LIMIT', 'UNION ALL', 'UNION', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'INNER JOIN', 'CROSS JOIN', 'JOIN', 'ON'];
const LIST_CLAUSES = new Set(['SELECT', 'GROUP BY', 'ORDER BY']);
const WINDOW_CLAUSES = ['PARTITION BY', 'ORDER BY', 'ROWS', 'RANGE', 'BY', 'FILTER ALLOW', 'FILTER DENY'];

/**
 * @typedef {{ type: 'word'|'quoted'|'number'|'op'|'open'|'close'|'comma', text: string, space: boolean }} Token
 *   `space`: whitespace before it in the input
 */

/** @returns {Token[]|null} null when the SQL holds something the formatter does not move (comments, dollar quotes) */
function tokenize(sql) {
	const tokens = [];
	let i = 0;
	let space = false;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i];
		if (/\s/.test(ch)) {
			space = true;
			i++;
			continue;
		}
		if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*') || ch === '#') return null;
		if (ch === '$' && sql[i + 1] === '$') return null;
		const push = (type, text) => {
			tokens.push({ type, text, space });
			space = false;
			i += text.length;
		};
		if (ch === "'" || ch === '"' || ch === '`') {
			let j = i + 1;
			for (;;) {
				if (j >= n) return null;
				if (sql[j] === '\\' && ch !== '`') {
					j += 2;
					continue;
				}
				if (sql[j] === ch) {
					if (sql[j + 1] === ch) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			push('quoted', sql.slice(i, j + 1));
			continue;
		}
		if (ch === '[') {
			const j = sql.indexOf(']', i);
			if (j < 0) return null;
			push('quoted', sql.slice(i, j + 1));
			continue;
		}
		const num = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(sql.slice(i, i + 64));
		if (num) {
			push('number', num[0]);
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 256));
		if (word) {
			push('word', word[0]);
			continue;
		}
		if (ch === '(') push('open', ch);
		else if (ch === ')') push('close', ch);
		else if (ch === ',') push('comma', ch);
		else push('op', /^(<=|>=|<>|!=|\|\||::|=>|->)/.exec(sql.slice(i, i + 2))?.[0] ?? ch);
	}
	return tokens;
}

const upper = (t) => t.type === 'word' && t.text.toUpperCase();
const isWord = (t, w) => upper(t) === w;

/**
 * Tree: a sequence holds tokens, groups `{ kind: 'paren', items: seq[], tight }` (items split at top-level commas;
 * `tight`: no whitespace before the "(") and `{ kind: 'case', operand, whens: [{ when, then }], else }`.
 * @returns {any[]|null}
 */
function parse(tokens) {
	let pos = 0;
	const seq = (stop) => {
		const out = [];
		while (pos < tokens.length) {
			const t = tokens[pos];
			if (stop(t)) return out;
			if (t.type === 'close') return null;
			if (t.type === 'open') {
				pos++;
				const items = [];
				for (;;) {
					const item = seq((x) => x.type === 'comma' || x.type === 'close');
					if (!item || pos >= tokens.length) return null;
					items.push(item);
					const end = tokens[pos++];
					if (end.type === 'close') break;
				}
				out.push({ kind: 'paren', items, tight: !t.space, word: out.at(-1)?.type === 'word' ? out.at(-1) : undefined });
				continue;
			}
			if (isWord(t, 'CASE')) {
				pos++;
				const node = { kind: 'case', operand: null, whens: [], else: null };
				node.operand = seq((x) => isWord(x, 'WHEN') || isWord(x, 'ELSE') || isWord(x, 'END'));
				if (!node.operand) return null;
				while (pos < tokens.length && isWord(tokens[pos], 'WHEN')) {
					pos++;
					const when = seq((x) => isWord(x, 'THEN'));
					if (!when || pos >= tokens.length) return null;
					pos++;
					const then = seq((x) => isWord(x, 'WHEN') || isWord(x, 'ELSE') || isWord(x, 'END'));
					if (!then) return null;
					node.whens.push({ when, then });
				}
				if (pos < tokens.length && isWord(tokens[pos], 'ELSE')) {
					pos++;
					node.else = seq((x) => isWord(x, 'END'));
					if (!node.else) return null;
				}
				if (pos >= tokens.length || !isWord(tokens[pos], 'END')) return null;
				pos++;
				out.push(node);
				continue;
			}
			if (isWord(t, 'END') || isWord(t, 'WHEN') || isWord(t, 'THEN') || isWord(t, 'ELSE')) return null;
			out.push(t);
			pos++;
		}
		return out;
	};
	const root = seq(() => false);
	return root && pos === tokens.length ? root : null;
}

function wordText(t, next) {
	const u = t.text.toUpperCase();
	if (KEYWORDS.has(u)) return u;
	return next?.kind === 'paren' && next.tight ? u : t.text;
}

/** Whether a separator goes between two inline pieces: the input's spacing, with fixed rules around ( ) , . and ::. */
function gap(prev, next) {
	if (!prev) return '';
	if (next.kind === 'paren') return next.tight ? '' : ' ';
	const nt = next.kind ? null : next;
	if (nt && (nt.type === 'op' && (nt.text === '.' || nt.text === '::'))) return '';
	if (!prev.kind && prev.type === 'op' && (prev.text === '.' || prev.text === '::')) return '';
	if (next.kind === 'case') return ' ';
	return nt?.space ? ' ' : '';
}

function inlineSeq(seq) {
	let out = '';
	seq.forEach((node, i) => {
		const text = node.kind === 'paren' ? `(${node.items.map(inlineSeq).join(', ')})` : node.kind === 'case' ? inlineCase(node) : node.type === 'word' ? wordText(node, seq[i + 1]) : node.text;
		out += gap(seq[i - 1], node) + text;
	});
	return out;
}

function inlineCase(node) {
	const parts = ['CASE'];
	if (node.operand.length) parts.push(inlineSeq(node.operand));
	for (const w of node.whens) parts.push('WHEN', inlineSeq(w.when), 'THEN', inlineSeq(w.then));
	if (node.else) parts.push('ELSE', inlineSeq(node.else));
	parts.push('END');
	return parts.join(' ');
}

const hasCase = (seq) => seq.some((n) => n.kind === 'case' || (n.kind === 'paren' && n.items.some(hasCase)));

/** Clause keyword (one or two words) starting at seq[i], from `list`. */
function clauseAt(seq, i, list) {
	const words = [];
	for (let j = i; j < seq.length && words.length < 3 && !seq[j].kind && seq[j].type === 'word'; j++) words.push(seq[j].text.toUpperCase());
	return list.find((c) => {
		const parts = c.split(' ');
		return parts.every((p, k) => words[k] === p);
	});
}

/**
 * Render a sequence starting at the current position; continuation lines start with `indent`.
 * `statement`: top-level SQL clauses (SELECT, FROM, ...) begin lines.
 */
function renderSeq(seq, indent, { statement = false } = {}) {
	const flat = inlineSeq(seq);
	if (!statement && !hasCase(seq) && flat.length <= EXPRESSION_WIDTH) return flat;
	if (statement && clauseAt(seq, 0, CLAUSES)) return renderStatement(seq, indent);
	const breakLogic = !statement && flat.length > EXPRESSION_WIDTH && seq.some((n) => !n.kind && LOGICAL.has(upper(n)));
	let out = '';
	seq.forEach((node, i) => {
		let text;
		if (node.kind === 'paren') text = renderParen(node, indent);
		else if (node.kind === 'case') text = renderCase(node, indent);
		else text = node.type === 'word' ? wordText(node, seq[i + 1]) : node.text;
		if (breakLogic && !node.kind && LOGICAL.has(upper(node)) && i > 0) out += `\n${indent}${text}`;
		else out += gap(seq[i - 1], node) + text;
	});
	return out;
}

function renderParen(node, indent) {
	const inner = `${indent}${INDENT}`;
	if (isWindow(node)) return renderWindow(node, indent);
	if (node.items.length === 1 && clauseAt(node.items[0], 0, ['SELECT', 'WITH'])) return `(\n${inner}${renderStatement(node.items[0], inner)}\n${indent})`;
	const flat = `(${node.items.map(inlineSeq).join(', ')})`;
	if (!node.items.some(hasCase) && flat.length - 2 <= EXPRESSION_WIDTH) return flat;
	return `(\n${node.items.map((item) => inner + renderSeq(item, inner)).join(',\n')}\n${indent})`;
}

const isWindow = (node) => node.word && (isWord(node.word, 'OVER') || isWord(node.word, 'FIXED'));

/** OVER (PARTITION BY ..., ORDER BY ...): one clause per line, its list kept on the line when it fits. */
function renderWindow(node, indent) {
	const flat = `(${node.items.map(inlineSeq).join(', ')})`;
	if (!node.items.some(hasCase) && flat.length - 2 <= EXPRESSION_WIDTH) return flat;
	const inner = `${indent}${INDENT}`;
	const clauses = splitClauses(node.items, WINDOW_CLAUSES);
	if (!clauses) return `(\n${node.items.map((item) => inner + renderSeq(item, inner)).join(',\n')}\n${indent})`;
	return `(\n${clauses.map((c) => inner + renderClause(c, inner)).join('\n')}\n${indent})`;
}

/**
 * Comma-separated items regrouped into clauses `[{ keyword, parts: seq[] }]`, each comma-separated piece one part of
 * the clause it follows. Null when the first item does not open with one of `list`.
 */
function splitClauses(items, list) {
	const out = [];
	for (const item of items) {
		let part = [];
		const flush = () => {
			if (!part.length) return true;
			if (!out.length) return false;
			out.at(-1).parts.push(part);
			part = [];
			return true;
		};
		for (let i = 0; i < item.length; i++) {
			const kw = clauseAt(item, i, list);
			if (!kw) {
				part.push(item[i]);
				continue;
			}
			if (!flush()) return null;
			out.push({ keyword: kw, parts: [] });
			i += kw.split(' ').length - 1;
		}
		if (!flush()) return null;
	}
	return out.length ? out : null;
}

function renderCase(node, indent) {
	const inner = `${indent}${INDENT}`;
	const lines = [node.operand.length ? `CASE ${renderSeq(node.operand, inner)}` : 'CASE'];
	for (const { when, then } of node.whens) lines.push(`${inner}WHEN ${renderSeq(when, inner)} THEN ${renderSeq(then, inner)}`);
	if (node.else) lines.push(`${inner}ELSE ${renderSeq(node.else, inner)}`);
	lines.push(`${indent}END`);
	return lines.join('\n');
}

function renderClause(clause, indent) {
	const items = clause.parts.filter((p) => p.length);
	const flat = items.map(inlineSeq).join(', ');
	const head = clause.keyword;
	if (!items.length) return head;
	if (!items.some(hasCase) && flat.length <= EXPRESSION_WIDTH) return `${head} ${flat}`;
	const inner = `${indent}${INDENT}`;
	if (LIST_CLAUSES.has(head) || WINDOW_CLAUSES.includes(head)) return `${head}\n${items.map((p) => inner + renderSeq(p, inner)).join(',\n')}`;
	return `${head}\n${inner}${items.map((p) => renderSeq(p, inner)).join(', ')}`;
}

/** A top-level statement: each clause starts a line at `indent`, its body on the next lines one level in. */
function renderStatement(seq, indent) {
	const clauses = [];
	let current;
	for (let i = 0; i < seq.length; i++) {
		const kw = clauseAt(seq, i, CLAUSES);
		if (kw) {
			current = { keyword: kw, body: [] };
			clauses.push(current);
			i += kw.split(' ').length - 1;
			continue;
		}
		if (!current) return inlineSeq(seq);
		current.body.push(seq[i]);
	}
	const inner = `${indent}${INDENT}`;
	const lines = [];
	for (const { keyword, body } of clauses) {
		// Joins sit in the FROM block, each with its table and ON condition on one line.
		if (keyword.endsWith('JOIN')) lines.push(`${inner}${keyword}${body.length ? ` ${renderSeq(body, inner)}` : ''}`);
		else if (keyword === 'ON' && lines.length) lines[lines.length - 1] += ` ON ${renderSeq(body, inner)}`;
		else if (!body.length) lines.push(`${indent}${keyword}`);
		else if (LIST_CLAUSES.has(keyword)) lines.push(`${indent}${keyword}\n${splitTopCommas(body).map((item) => inner + renderSeq(item, inner)).join(',\n')}`);
		else lines.push(`${indent}${keyword}\n${inner}${renderSeq(body, inner)}`);
	}
	return lines.join('\n').slice(indent.length);
}

/** Top-level comma tokens split a statement clause body (commas inside parentheses are already grouped). */
function splitTopCommas(body) {
	const out = [[]];
	for (const node of body) {
		if (!node.kind && node.type === 'comma') out.push([]);
		else out.at(-1).push(node);
	}
	return out.filter((x) => x.length);
}

/** Non-whitespace tokens compared as SQL reads them: keywords and function names ignore case. */
function signature(tokens) {
	return tokens.map((t) => (t.type === 'word' ? t.text.toUpperCase() : t.text)).join('\u0000');
}

/**
 * Format SQL for reading. `statement`: a full query (a SQL DataSet View), else one expression (Beast Mode, card formula,
 * Magic ETL formula). Returns the input unchanged when it cannot be formatted safely.
 * @param {string} sql
 * @param {{ statement?: boolean }} [opts]
 * @returns {string}
 */
export function formatSql(sql, { statement = false } = {}) {
	if (typeof sql !== 'string' || !sql.trim() || sql.length > MAX_FORMAT_CHARS) return sql;
	const tokens = tokenize(sql);
	if (!tokens) return sql;
	const tree = statement ? parseStatement(tokens) : parse(tokens);
	if (!tree) return sql;
	const out = renderSeq(tree, '', { statement });
	const check = tokenize(out);
	if (!check || signature(check) !== signature(tokens)) return sql;
	return out;
}

/** Statements keep top-level commas as tokens (expressions only meet commas inside parentheses). */
function parseStatement(tokens) {
	const marked = tokens.map((t) => t);
	let depth = 0;
	const top = [];
	for (const t of marked) {
		if (t.type === 'open') depth++;
		if (t.type === 'close') depth--;
		if (depth < 0) return null;
		top.push(depth === 0 && t.type === 'comma');
	}
	if (depth !== 0) return null;
	// Parse with top-level commas hidden as ops so parse() keeps them in the sequence.
	const tree = parse(marked.map((t, i) => (top[i] ? { ...t, type: 'op' } : t)));
	if (!tree) return null;
	return tree.map((n) => (!n.kind && n.type === 'op' && n.text === ',' ? { ...n, type: 'comma' } : n));
}

/**
 * Format every SQL text of a plan in place: dataset Beast Modes, card formulas, Magic ETL tile expressions and SQL
 * DataSet View queries.
 * @param {import('../model/types.js').DomoPlan} plan
 */
export function formatPlanSql(plan) {
	for (const bm of plan.beastModes ?? []) bm.expression = formatSql(bm.expression);
	for (const card of plan.cards ?? []) {
		for (const f of card.body?.definition?.formulas?.card ?? []) f.formula = formatSql(f.formula);
	}
	for (const df of plan.dataflows ?? []) {
		for (const action of df.definition?.actions ?? []) {
			for (const list of [action.fields, action.expressions]) {
				for (const x of Array.isArray(list) ? list : []) if (typeof x?.expression === 'string') x.expression = formatSql(x.expression);
			}
		}
	}
	for (const ds of plan.datasets ?? []) {
		const template = ds.view?.schema?.viewTemplate;
		if (template?.version === 'advancedEditorSql' && typeof template.selectString === 'string') template.selectString = formatSql(template.selectString, { statement: true });
	}
	return plan;
}
