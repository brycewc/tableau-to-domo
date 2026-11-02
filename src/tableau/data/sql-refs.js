/**
 * Table references in a custom SQL query, with their character positions so convert can swap them for
 * DataSet View aliases. Covers FROM/JOIN lists, CTEs and derived tables; table functions, stages and
 * VALUES lists make the query unsupported.
 */

const NOT_ALIAS = new Set([
	'WHERE', 'JOIN', 'ON', 'USING', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'GROUP', 'ORDER', 'UNION',
	'EXCEPT', 'INTERSECT', 'MINUS', 'LIMIT', 'OFFSET', 'FETCH', 'HAVING', 'QUALIFY', 'WINDOW', 'SAMPLE', 'TABLESAMPLE', 'PIVOT',
	'UNPIVOT', 'MATCH_RECOGNIZE', 'AT', 'BEFORE', 'CHANGES', 'CONNECT', 'START', 'LATERAL', 'ASOF', 'SELECT', 'WITH', 'FOR', 'INTO'
]);
const FROM_FUNCTIONS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'SUBSTR', 'POSITION', 'OVERLAY', 'DATE_PART']);
const CLAUSE_END = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'UNION', 'EXCEPT', 'INTERSECT', 'MINUS', 'LIMIT', 'WINDOW', 'SELECT', 'FETCH', 'OFFSET', 'FROM']);
const TABLE_FUNCTIONS = new Set(['LATERAL', 'TABLE', 'UNNEST', 'FLATTEN', 'VALUES', 'GENERATOR', 'IDENTIFIER', 'OPENQUERY', 'OPENROWSET']);

/**
 * @typedef {{ type: 'ident'|'qident'|'punct'|'string'|'number', value: string, upper: string, start: number, end: number }} Token
 */

/**
 * @param {string} sql
 * @returns {Token[]}
 */
export function tokenizeSql(sql) {
	const tokens = [];
	let i = 0;
	const n = sql.length;
	const push = (type, value, start, end) => tokens.push({ type, value, upper: type === 'ident' ? value.toUpperCase() : value, start, end });
	while (i < n) {
		const ch = sql[i];
		if (/\s/.test(ch)) {
			i++;
		} else if (ch === '-' && sql[i + 1] === '-') {
			while (i < n && sql[i] !== '\n') i++;
		} else if (ch === '/' && sql[i + 1] === '/') {
			while (i < n && sql[i] !== '\n') i++;
		} else if (ch === '/' && sql[i + 1] === '*') {
			const close = sql.indexOf('*/', i + 2);
			i = close === -1 ? n : close + 2;
		} else if (ch === "'") {
			const start = i++;
			while (i < n) {
				if (sql[i] === '\\') i += 2;
				else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
				else if (sql[i] === "'") break;
				else i++;
			}
			i++;
			push('string', sql.slice(start, i), start, i);
		} else if (ch === '$' && sql[i + 1] === '$') {
			const start = i;
			const close = sql.indexOf('$$', i + 2);
			i = close === -1 ? n : close + 2;
			push('string', sql.slice(start, i), start, i);
		} else if (ch === '"' || ch === '`' || ch === '[') {
			const closeCh = ch === '[' ? ']' : ch;
			const start = i++;
			let value = '';
			while (i < n) {
				if (sql[i] === closeCh && sql[i + 1] === closeCh) {
					value += closeCh;
					i += 2;
				} else if (sql[i] === closeCh) break;
				else value += sql[i++];
			}
			i++;
			push('qident', value, start, i);
		} else if (/[A-Za-z_À-￿]/.test(ch)) {
			const start = i;
			while (i < n && /[A-Za-z0-9_$À-￿]/.test(sql[i])) i++;
			push('ident', sql.slice(start, i), start, i);
		} else if (/[0-9]/.test(ch)) {
			const start = i;
			while (i < n && /[0-9.eE]/.test(sql[i])) i++;
			push('number', sql.slice(start, i), start, i);
		} else {
			push('punct', ch, i, i + 1);
			i++;
		}
	}
	return tokens;
}

/**
 * @typedef {Object} SqlTableRef
 * @property {number} start                         Offset of the first name part in the SQL text
 * @property {number} end                           Offset after the last name part
 * @property {{ name: string, quoted: boolean }[]} parts   1 to 3 parts: [database.][schema.]table
 */

/**
 * @param {string} sql
 * @returns {{ refs: SqlTableRef[], unsupported?: string }}
 */
export function parseSqlTableRefs(sql) {
	const tokens = tokenizeSql(String(sql ?? ''));
	const isName = (t) => t && (t.type === 'ident' || t.type === 'qident');
	const isPunct = (t, v) => t && t.type === 'punct' && t.value === v;
	const kw = (t, v) => t && t.type === 'ident' && t.upper === v;

	const cteNames = new Set();
	for (let i = 0; i < tokens.length - 2; i++) {
		if (!isName(tokens[i])) continue;
		const prev = tokens[i - 1];
		if (!(kw(prev, 'WITH') || kw(prev, 'RECURSIVE') || isPunct(prev, ','))) continue;
		let j = i + 1;
		if (isPunct(tokens[j], '(')) {
			let depth = 0;
			for (; j < tokens.length; j++) {
				if (isPunct(tokens[j], '(')) depth++;
				else if (isPunct(tokens[j], ')') && --depth === 0) break;
			}
			j++;
		}
		if (kw(tokens[j], 'AS') && isPunct(tokens[j + 1], '(')) cteNames.add(tokens[i].value.toLowerCase());
	}

	const parenFn = [];
	const enclosing = new Array(tokens.length);
	for (let i = 0; i < tokens.length; i++) {
		enclosing[i] = parenFn[parenFn.length - 1];
		if (isPunct(tokens[i], '(')) parenFn.push(tokens[i - 1]?.type === 'ident' ? tokens[i - 1].upper : '');
		else if (isPunct(tokens[i], ')')) parenFn.pop();
	}

	const refs = [];
	const skipParens = (i) => {
		let depth = 0;
		for (; i < tokens.length; i++) {
			if (isPunct(tokens[i], '(')) depth++;
			else if (isPunct(tokens[i], ')') && --depth === 0) return i + 1;
		}
		return i;
	};
	const skipAlias = (i) => {
		if (kw(tokens[i], 'AS')) i++;
		if (isName(tokens[i]) && !(tokens[i].type === 'ident' && NOT_ALIAS.has(tokens[i].upper))) {
			i++;
			if (isPunct(tokens[i], '(')) i = skipParens(i);
		}
		return i;
	};

	/** Reads one FROM/JOIN item at `j`; returns the next index, or a string reason when unsupported. */
	const readItem = (j, keyword) => {
		const next = tokens[j];
		if (!next) return `the query ends after ${keyword}`;
		if (isPunct(next, '(')) return skipAlias(skipParens(j));
		if (isPunct(next, '@')) return 'it reads from a stage (@...)';
		if (next.type === 'ident' && TABLE_FUNCTIONS.has(next.upper)) return `it uses ${next.value}(...) in FROM`;
		if (!isName(next)) return `unexpected "${next.value}" after ${keyword}`;
		const parts = [{ name: next.value, quoted: next.type === 'qident' }];
		let end = next.end;
		j++;
		while (isPunct(tokens[j], '.') && isName(tokens[j + 1])) {
			parts.push({ name: tokens[j + 1].value, quoted: tokens[j + 1].type === 'qident' });
			end = tokens[j + 1].end;
			j += 2;
		}
		const label = parts.map((p) => p.name).join('.');
		if (isPunct(tokens[j], '(')) return `it calls the table function ${label}(...)`;
		if (parts.length > 3) return `the table name ${label} has more than three parts`;
		if (!(parts.length === 1 && cteNames.has(parts[0].name.toLowerCase()))) refs.push({ start: next.start, end, parts });
		return skipAlias(j);
	};

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const isFrom = kw(t, 'FROM');
		if (!isFrom && !kw(t, 'JOIN')) continue;
		if (isFrom && FROM_FUNCTIONS.has(enclosing[i])) continue;
		if (isFrom && kw(tokens[i - 1], 'DISTINCT')) continue;
		let j = readItem(i + 1, t.value);
		if (typeof j === 'string') return { refs, unsupported: j };
		if (!isFrom) continue;
		// Comma joins can follow JOIN ... ON conditions, so scan the rest of this FROM clause at its own depth.
		for (let depth = 0; j < tokens.length; j++) {
			const tok = tokens[j];
			if (isPunct(tok, '(')) depth++;
			else if (isPunct(tok, ')') && --depth < 0) break;
			else if (depth === 0 && (isPunct(tok, ';') || (tok.type === 'ident' && CLAUSE_END.has(tok.upper)))) break;
			else if (depth === 0 && isPunct(tok, ',')) {
				const after = readItem(j + 1, ',');
				if (typeof after === 'string') return { refs, unsupported: after };
				j = after - 1;
			}
		}
	}
	if (!refs.length) return { refs, unsupported: 'no table references were found' };
	refs.sort((a, b) => a.start - b.start);
	return { refs: refs.filter((r, i) => i === 0 || r.start !== refs[i - 1].start) };
}

const CLOSE_QUOTE = { '"': '"', '`': '`', '[': ']' };

/**
 * Rename the database part of three-part table references ({ tableauName: warehouseName }, case-insensitive),
 * keeping the quoting each reference was written with.
 * @param {string} sql
 * @param {Record<string, string>} [databases]
 * @returns {{ sql: string, renamed: number }}
 */
export function renameSqlDatabases(sql, databases) {
	const renames = new Map(Object.entries(databases ?? {}).map(([from, to]) => [from.toLowerCase(), to]));
	const text = String(sql ?? '');
	if (!renames.size) return { sql: text, renamed: 0 };
	let out = '';
	let at = 0;
	let renamed = 0;
	for (const ref of parseSqlTableRefs(text).refs) {
		const to = ref.parts.length === 3 ? renames.get(ref.parts[0].name.toLowerCase()) : undefined;
		if (!to) continue;
		const open = text[ref.start];
		const close = CLOSE_QUOTE[open];
		const end = close ? text.indexOf(close, ref.start + 1) + 1 : ref.start + ref.parts[0].name.length;
		out += text.slice(at, ref.start) + (close ? `${open}${to}${close}` : to);
		at = end;
		renamed++;
	}
	return { sql: out + text.slice(at), renamed };
}
