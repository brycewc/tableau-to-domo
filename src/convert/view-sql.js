/**
 * Rewrites for warehouse SQL that the SQL DataSet View validator rejects or the Snowflake deparser breaks. Each export
 * cites the rule it answers in docs/VIEW-SQL-RULES.md. Pure, no I/O.
 */

const COMPARISON = /^(?:=|<>|!=|<=|>=|<|>|NOT\s+I?LIKE\b|I?LIKE\b|NOT\s+IN\b|IN\b)/i;
const COMPARISON_BEFORE = /(?:=|<>|!=|<=|>=|<|>|\bNOT\s+I?LIKE|\bI?LIKE|\bNOT\s+IN|\bIN)\s*$/i;

/** Index just past the quoted run starting at `i` ('...', "...", `...`), doubled quotes included. */
function skipQuoted(sql, i) {
	const q = sql[i];
	let j = i + 1;
	while (j < sql.length) {
		if (sql[j] === q) {
			if (sql[j + 1] === q) j += 2;
			else return j + 1;
		} else j++;
	}
	return j;
}

/** Index of the parenthesis closing the one before `start`, and the top-level comma positions. */
function closeParen(sql, start) {
	let depth = 1;
	const commas = [];
	for (let i = start; i < sql.length; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')' && --depth === 0) return { end: i, commas };
		else if (ch === ',' && depth === 1) commas.push(i);
		i++;
	}
	return undefined;
}

/** A string literal, a quoted or dotted identifier, or a parenthesized list at `i`: its end, else undefined. */
function operandEnd(sql, i) {
	if (sql[i] === "'") return skipQuoted(sql, i);
	if (sql[i] === '(') {
		const close = closeParen(sql, i + 1);
		return close ? close.end + 1 : undefined;
	}
	let j = i;
	while (j < sql.length) {
		if (sql[j] === '"' || sql[j] === '`') j = skipQuoted(sql, j);
		else if (/[\w$]/.test(sql[j])) while (j < sql.length && /[\w$]/.test(sql[j])) j++;
		else break;
		if (sql[j] !== '.') break;
		j++;
	}
	return j > i ? j : undefined;
}

const lowerOperand = (text) => {
	if (!text.startsWith('(')) return `LOWER(${text})`;
	const inner = text.slice(1, -1);
	const close = closeParen(`${inner})`, 0);
	if (!close) return text;
	const parts = [];
	let from = 0;
	for (const c of [...close.commas, inner.length]) {
		parts.push(inner.slice(from, c).trim());
		from = c + 1;
	}
	return `(${parts.map((p) => (/^'.*'$/s.test(p) ? `LOWER(${p})` : p)).join(', ')})`;
};

/**
 * Rule P1. Snowflake `COLLATE(<expr>, '<spec>')`. A case-sensitive spec is just
 * `<expr>`. A case-insensitive one ('en-ci') compared with an operand becomes `LOWER(<expr>) <op> LOWER(<operand>)`, the
 * same rows; anywhere else (a projected column) it becomes `<expr>`, and later comparisons on it are case-sensitive.
 * @param {string} sql
 * @returns {{ sql: string, rewrites: { spec: string, compared: boolean }[] }}
 */
export function rewriteCollate(sql) {
	let out = String(sql ?? '');
	const rewrites = [];
	const pattern = /\bCOLLATE\s*\(/gi;
	let searchFrom = 0;
	for (;;) {
		pattern.lastIndex = searchFrom;
		let m;
		let found;
		while ((m = pattern.exec(out))) {
			if (!insideQuotes(out, m.index)) {
				found = m;
				break;
			}
		}
		if (!found) break;
		const argsStart = found.index + found[0].length;
		const close = closeParen(out, argsStart);
		if (!close || close.commas.length !== 1) {
			searchFrom = argsStart;
			continue;
		}
		const expr = out.slice(argsStart, close.commas[0]).trim();
		const spec = out.slice(close.commas[0] + 1, close.end).trim();
		const caseInsensitive = /(^'|-)ci(-|'$)/i.test(spec);
		let start = found.index;
		let end = close.end + 1;
		let replacement = expr;
		let compared = false;
		if (caseInsensitive) {
			const after = out.slice(end).match(/^\s*/)[0].length + end;
			const op = out.slice(after).match(COMPARISON);
			const before = out.slice(0, start).match(COMPARISON_BEFORE);
			if (op) {
				const operandStart = after + op[0].length + out.slice(after + op[0].length).match(/^\s*/)[0].length;
				const operandStop = operandEnd(out, operandStart);
				if (operandStop !== undefined) {
					replacement = `LOWER(${expr}) ${op[0].replace(/\s+/g, ' ').toUpperCase()} ${lowerOperand(out.slice(operandStart, operandStop))}`;
					end = operandStop;
					compared = true;
				}
			} else if (before) {
				const left = out.slice(0, before.index).trimEnd();
				const literal = left.match(/'(?:[^']|'')*'$|"(?:[^"]|"")*"(?:\."(?:[^"]|"")*")*$|[\w$.]+$/);
				if (literal) {
					start = left.length - literal[0].length;
					replacement = `LOWER(${literal[0]}) ${before[0].trim().replace(/\s+/g, ' ').toUpperCase()} LOWER(${expr})`;
					compared = true;
				}
			}
		}
		out = `${out.slice(0, start)}${replacement}${out.slice(end)}`;
		rewrites.push({ spec, compared });
		searchFrom = start + replacement.length;
	}
	return { sql: out, rewrites };
}

const DATE_PARTS = new Map(
	Object.entries({
		YEAR: 'y yy yyy yyyy yr year years yrs',
		QUARTER: 'q qtr qtrs quarter quarters',
		MONTH: 'mm mon mons month months',
		WEEK: 'w wk week weeks weekofyear woy wy',
		DAY: 'd dd day days dayofmonth',
		HOUR: 'h hh hr hrs hour hours',
		MINUTE: 'm mi min mins minute minutes',
		SECOND: 's sec secs second seconds'
	}).flatMap(([unit, names]) => names.split(' ').map((n) => [n, unit]))
);

/** Rules F1 and F3: DATEADD, TIMEADD and TIMESTAMPADD as DATE_ADD(expr, INTERVAL n PART).
 * @returns {{ sql: string, rewrites: number, skipped: string[] }} `skipped`: calls whose part has no interval unit */
export function rewriteDateAdd(sql) {
	let out = String(sql ?? '');
	let rewrites = 0;
	const skipped = [];
	const pattern = /\b(?:DATEADD|TIMEADD|TIMESTAMPADD)\s*\(/gi;
	let searchFrom = 0;
	for (;;) {
		pattern.lastIndex = searchFrom;
		let found;
		for (let m; (m = pattern.exec(out)); ) {
			if (!insideQuotes(out, m.index)) {
				found = m;
				break;
			}
		}
		if (!found) break;
		const argsStart = found.index + found[0].length;
		const close = closeParen(out, argsStart);
		const unit = close?.commas.length === 2 ? DATE_PARTS.get(out.slice(argsStart, close.commas[0]).trim().replace(/^['"]|['"]$/g, '').toLowerCase()) : undefined;
		if (!unit) {
			if (close) skipped.push(out.slice(found.index, close.end + 1));
			searchFrom = argsStart;
			continue;
		}
		const n = out.slice(close.commas[0] + 1, close.commas[1]).trim();
		const expr = out.slice(close.commas[1] + 1, close.end).trim();
		const replacement = `DATE_ADD(${expr}, INTERVAL ${/^[+-]?\d+$/.test(n) ? n : `(${n})`} ${unit})`;
		out = `${out.slice(0, found.index)}${replacement}${out.slice(close.end + 1)}`;
		rewrites++;
		searchFrom = found.index;
	}
	return { sql: out, rewrites, skipped };
}

const DATE_DIFFS = {
	DAY: (a, b) => `DATEDIFF(${b}, ${a})`,
	MONTH: (a, b) => `((YEAR(${b}) - YEAR(${a})) * 12 + MONTH(${b}) - MONTH(${a}))`,
	QUARTER: (a, b) => `((YEAR(${b}) - YEAR(${a})) * 4 + QUARTER(${b}) - QUARTER(${a}))`,
	YEAR: (a, b) => `(YEAR(${b}) - YEAR(${a}))`
};

/** Rules Q1 and F4: DATEDIFF(<part>, a, b) as DATEDIFF(b, a) in days, or YEAR/QUARTER/MONTH arithmetic, which count the
 * same boundaries Snowflake does.
 * @returns {{ sql: string, rewrites: number, skipped: string[] }} `skipped`: calls in a part with no rewrite */
export function rewriteDateDiff(sql) {
	let out = String(sql ?? '');
	let rewrites = 0;
	const skipped = [];
	const pattern = /\b(?:DATEDIFF|TIMEDIFF|TIMESTAMPDIFF)\s*\(/gi;
	let searchFrom = 0;
	for (;;) {
		pattern.lastIndex = searchFrom;
		let found;
		for (let m; (m = pattern.exec(out)); ) {
			if (!insideQuotes(out, m.index)) {
				found = m;
				break;
			}
		}
		if (!found) break;
		const argsStart = found.index + found[0].length;
		const close = closeParen(out, argsStart);
		if (close?.commas.length !== 2) {
			searchFrom = argsStart;
			continue;
		}
		const unit = DATE_PARTS.get(out.slice(argsStart, close.commas[0]).trim().replace(/^['"]|['"]$/g, '').toLowerCase());
		if (!DATE_DIFFS[unit]) {
			skipped.push(out.slice(found.index, close.end + 1));
			searchFrom = argsStart;
			continue;
		}
		const a = out.slice(close.commas[0] + 1, close.commas[1]).trim();
		const b = out.slice(close.commas[1] + 1, close.end).trim();
		const replacement = DATE_DIFFS[unit](a, b);
		out = `${out.slice(0, found.index)}${replacement}${out.slice(close.end + 1)}`;
		rewrites++;
		searchFrom = found.index + (unit === 'DAY' ? 'DATEDIFF('.length : 0);
	}
	return { sql: out, rewrites, skipped };
}

export const UNION_CAST_TYPES = { LONG: 'BIGINT', DOUBLE: 'DOUBLE', DECIMAL: 'DOUBLE', STRING: 'VARCHAR', DATE: 'DATE', DATETIME: 'TIMESTAMP' };

const SET_OP = /^(?:UNION|INTERSECT|EXCEPT|MINUS)(?:\s+(?:ALL|DISTINCT))?\s*/i;

function unionChains(s) {
	const chains = [];
	for (const m of s.matchAll(/\bSELECT\b/gi)) {
		if (insideQuotes(s, m.index) || /\b(?:UNION|INTERSECT|EXCEPT|MINUS)(?:\s+(?:ALL|DISTINCT))?\s*\(?\s*$/i.test(s.slice(0, m.index))) continue;
		let end = blockEnd(s, m.index);
		const names = projectionItems(s.slice(m.index, end));
		if (!names) continue;
		const branches = [projectionSpans(s, m.index, end)];
		while (end < s.length) {
			const op = s.slice(end).match(SET_OP);
			if (!op) break;
			let next = end + op[0].length;
			while (s[next] === '(' || /\s/.test(s[next] ?? '')) next++;
			if (!/^SELECT\b/i.test(s.slice(next, next + 7))) break;
			end = blockEnd(s, next);
			branches.push(projectionSpans(s, next, end));
		}
		if (branches.length > 1) chains.push({ names, branches });
	}
	return chains;
}

/** A select item's expression without its alias, and the name it projects as written. */
function splitItem(text) {
	const alias = text.match(new RegExp(`(?:\\bAS\\s+|[\\s)])(${IDENT})$`, 'i'));
	const plain = text.match(new RegExp(`^(?:${IDENT}\\.)*(${IDENT})$`));
	if (plain) return { expr: text, name: unquote(plain[1]) };
	if (alias && !/^(?:END|AND|OR|NOT|NULL|THEN|ELSE)$/i.test(alias[1])) {
		return { expr: text.slice(0, text.length - alias[0].length + (alias[0].startsWith(')') ? 1 : 0)).trimEnd(), name: unquote(alias[1]) };
	}
	return { expr: text, name: undefined };
}

const written = (want) => (want.quoted ? `"${want.name.replace(/"/g, '""')}"` : want.name);

function applyEdits(s, edits) {
	let out = s;
	for (const e of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}${e.text}${out.slice(e.at + e.length)}`;
	return out;
}

/** Rules U1 and S1: each later set-operation branch aliased to the first branch's column names, as written.
 * @returns {{ sql: string, aliased: number }} */
export function aliasUnionBranches(sql) {
	const s = String(sql ?? '');
	const edits = [];
	for (const { names, branches } of unionChains(s)) {
		for (const items of branches.slice(1)) {
			if (items.length !== names.length) continue;
			items.forEach((item, k) => {
				const want = names[k];
				if (!want || /(^|\.)\*$/.test(item.text)) return;
				const { expr, name } = splitItem(item.text);
				if (name !== want.name) edits.push({ at: item.start, length: item.text.length, text: `${expr} AS ${written(want)}` });
			});
		}
	}
	return { sql: applyEdits(s, edits), aliased: edits.length };
}

/** Rules T1 and U2: a bare NULL branch item cast to its column's type.
 * @param {Map<string, string>} sqlTypes  lower-cased column name -> SQL type
 * @returns {{ sql: string, cast: number }} */
export function castUnionNulls(sql, sqlTypes) {
	const s = String(sql ?? '');
	const edits = [];
	for (const { names, branches } of unionChains(s)) {
		for (const items of branches) {
			if (items.length !== names.length) continue;
			items.forEach((item, k) => {
				const type = names[k] && sqlTypes.get(names[k].name.toLowerCase());
				if (!type || type === 'VARCHAR') return;
				const { expr } = splitItem(item.text);
				if (/^NULL$/i.test(expr.trim())) edits.push({ at: item.start, length: item.text.length, text: `CAST(NULL AS ${type}) AS ${written(names[k])}` });
			});
		}
	}
	return { sql: applyEdits(s, edits), cast: edits.length };
}

const CONSTANT = /^(?:NULL|TRUE|FALSE|[+-]?\d+(?:\.\d+)?|'(?:[^']|'')*'|CAST\(\s*(?:NULL|[+-]?\d+(?:\.\d+)?|'(?:[^']|'')*')\s+AS\s+[\w ()]+\))$/i;

/** Rule X1: a UNION column constant in every branch has the first branch's constant tied to one of its columns.
 * @returns {{ sql: string, anchored: number }} */
export function anchorConstantUnionColumns(sql) {
	const s = String(sql ?? '');
	const edits = [];
	for (const { names, branches } of unionChains(s)) {
		if (branches.some((items) => items.length !== names.length)) continue;
		const first = branches[0];
		const column = first.map((item) => splitItem(item.text)).find(({ expr }) => new RegExp(`^(?:${IDENT}\\.)*${IDENT}$`).test(expr) && !CONSTANT.test(expr))?.expr;
		if (!column) continue;
		names.forEach((want, k) => {
			if (!want || !branches.every((items) => CONSTANT.test(splitItem(items[k].text).expr.trim()))) return;
			const { expr } = splitItem(first[k].text);
			edits.push({ at: first[k].start, length: first[k].text.length, text: `CASE WHEN ${column} IS NULL THEN ${expr} ELSE ${expr} END AS ${written(want)}` });
		});
	}
	return { sql: applyEdits(s, edits), anchored: edits.length };
}

// Snowflake fails the whole view on a value a plain CAST cannot convert, and its TRY_CAST takes only text.
const unionCast = (expr, sqlType) =>
	/^NULL$/i.test(expr.trim()) || sqlType === 'VARCHAR' ? `CAST(${expr} AS ${sqlType})` : `TRY_CAST(CAST(${expr} AS VARCHAR) AS ${sqlType})`;

/** Rule U2.
 * @returns {{ sql: string, cast: number }} */
export function castUnionColumn(sql, column, sqlType) {
	const s = String(sql ?? '');
	const edits = [];
	for (const { names, branches } of unionChains(s)) {
		const k = names.findIndex((n) => n?.name === column);
		if (k < 0) continue;
		for (const items of branches) {
			const item = items[k];
			if (!item || items.length !== names.length || /(^|\.)\*$/.test(item.text)) continue;
			const { expr } = splitItem(item.text);
			if (new RegExp(`^(?:TRY_)?CAST\\(.*\\bAS\\s+${sqlType}\\)$`, 'is').test(expr)) continue;
			edits.push({ at: item.start, length: item.text.length, text: `${unionCast(expr, sqlType)} AS ${written(names[k])}` });
		}
	}
	return { sql: applyEdits(s, edits), cast: edits.length };
}

/** The select items of the SELECT at `selectAt`, with their positions. */
function projectionSpans(sql, selectAt, end) {
	const from = topLevelKeyword(sql, 'FROM', selectAt + 6, end)[0] ?? end;
	const spans = [];
	let depth = 0;
	let start = selectAt + 6;
	const push = (stop) => {
		const raw = sql.slice(start, stop);
		const lead = raw.length - raw.trimStart().length;
		let text = raw.trim();
		let at = start + lead;
		const prefix = spans.length ? null : text.match(/^(?:DISTINCT|ALL)\s+|^TOP\s+\d+\s+/i);
		if (prefix) {
			at += prefix[0].length;
			text = text.slice(prefix[0].length);
		}
		spans.push({ start: at, text });
	};
	for (let i = selectAt + 6; i < from; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			push(i);
			start = i + 1;
		}
		i++;
	}
	push(from);
	return spans;
}

/** SQL with `--` and block comments removed (quoted text kept). */
export function stripComments(sql) {
	const s = String(sql ?? '');
	let out = '';
	for (let i = 0; i < s.length; ) {
		const ch = s[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			const end = skipQuoted(s, i);
			out += s.slice(i, end);
			i = end;
		} else if (ch === '-' && s[i + 1] === '-') {
			while (i < s.length && s[i] !== '\n') i++;
		} else if (ch === '/' && s[i + 1] === '*') {
			const end = s.indexOf('*/', i + 2);
			i = end < 0 ? s.length : end + 2;
			out += ' ';
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/** Positions of `word` (a keyword) at parenthesis depth 0 of `sql` from `from` to `to`, outside quotes. */
function topLevelKeyword(sql, word, from = 0, to = sql.length) {
	const hits = [];
	const re = new RegExp(`^${word}\\b`, 'i');
	let depth = 0;
	for (let i = from; i < to; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (depth === 0 && !/[\w$]/.test(sql[i - 1] ?? '') && re.test(sql.slice(i, i + word.length + 1))) hits.push(i);
		i++;
	}
	return hits;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\`[^\`]+\`|[A-Za-z_][\w$]*)`;
const NOT_CLAUSE = String.raw`(?!(?:SELECT|FROM|ON|USING|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|JOIN|NATURAL|LATERAL|UNPIVOT|PIVOT|QUALIFY|WINDOW|EXCEPT|INTERSECT|MINUS|AND|OR)\b)`;
const unquote = (id) => (/^["`]/.test(id) ? id.slice(1, -1).replace(/""/g, '"') : id);

/** Rule R1: CTEs as derived tables. */
export function inlineCtes(sql) {
	const s = String(sql ?? '').trim();
	const head = s.match(/^WITH\s+/i);
	if (!head || /^WITH\s+RECURSIVE\b/i.test(s)) return { sql: s, inlined: [] };
	const ctes = [];
	let i = head[0].length;
	for (;;) {
		const m = s.slice(i).match(new RegExp(`^(${IDENT})\\s*(?:\\([^()]*\\)\\s*)?AS\\s*\\(`, 'i'));
		if (!m) return { sql: s, inlined: [] };
		const bodyStart = i + m[0].length;
		const close = closeParen(s, bodyStart);
		if (!close) return { sql: s, inlined: [] };
		ctes.push({ name: unquote(m[1]), body: s.slice(bodyStart, close.end).trim() });
		i = close.end + 1;
		const comma = s.slice(i).match(/^\s*,\s*/);
		if (!comma) break;
		i += comma[0].length;
	}
	let main = s.slice(i).trim();
	const substitute = (text, cte) => {
		const ref = new RegExp(`(\\b(?:FROM|JOIN)\\s+)(${IDENT})(?!\\s*[.(])(\\s+(?:AS\\s+)?${NOT_CLAUSE}${IDENT})?`, 'gi');
		return text.replace(ref, (all, lead, id, alias, offset) => {
			if (unquote(id).toLowerCase() !== cte.name.toLowerCase() || insideQuotes(text, offset)) return all;
			return `${lead}(${cte.body}) ${alias ? alias.replace(/^\s+(?:AS\s+)?/i, '') : id}`;
		});
	};
	for (let k = 0; k < ctes.length; k++) {
		for (let j = k + 1; j < ctes.length; j++) ctes[j].body = substitute(ctes[j].body, ctes[k]);
		main = substitute(main, ctes[k]);
	}
	return { sql: main, inlined: ctes.map((c) => c.name) };
}

/** Rule P2: UNPIVOT as a CROSS JOIN with the column names and a CASE; NULL values are dropped as UNPIVOT does, but the
 * unpivoted columns stay in a `SELECT *` over the result. */
export function rewriteUnpivot(sql) {
	let out = String(sql ?? '');
	let rewrites = 0;
	for (let guard = 0; guard < 50; guard++) {
		const m = [...out.matchAll(/\bUNPIVOT\s*\(/gi)].find((x) => !insideQuotes(out, x.index));
		if (!m) break;
		const argsStart = m.index + m[0].length;
		const close = closeParen(out, argsStart);
		const spec = close && out.slice(argsStart, close.end).match(new RegExp(`^\\s*(${IDENT})\\s+FOR\\s+(${IDENT})\\s+IN\\s*\\(([\\s\\S]*)\\)\\s*$`, 'i'));
		const fromAt = enclosingFrom(out, m.index);
		if (!spec || fromAt === undefined) break;
		const source = out.slice(fromAt + 4, m.index).trim();
		const sourceAlias = unquote(source.match(new RegExp(`(${IDENT})\\s*$`))?.[1] ?? source);
		const after = out.slice(close.end + 1).match(new RegExp(`^\\s+(?:AS\\s+)?${NOT_CLAUSE}(${IDENT})`, 'i'));
		const value = spec[1];
		const name = spec[2];
		const columns = spec[3].split(',').map((c) => c.trim()).filter(Boolean);
		const label = (c) => `'${(/^["`]/.test(c) ? unquote(c) : c.toUpperCase()).replace(/'/g, "''")}'`;
		const names = columns.map((c) => `SELECT ${label(c)} AS ${name}`).join(' UNION ALL ');
		const pick = `CASE __unpivot_names.${name} ${columns.map((c) => `WHEN ${label(c)} THEN ${sourceAlias}.${c}`).join(' ')} END AS ${value}`;
		const alias = after ? after[1] : sourceAlias;
		const tailEnd = close.end + 1 + (after ? after[0].length : 0);
		const kept = keptColumns(out, fromAt, tailEnd, unquote(alias), [value, name]);
		const projection = kept ? kept.map((c) => `${sourceAlias}.${c}`).join(', ') : `${sourceAlias}.*`;
		const replacement = `(SELECT * FROM (SELECT ${projection ? `${projection}, ` : ''}__unpivot_names.${name}, ${pick} FROM ${source} CROSS JOIN (${names}) __unpivot_names) __unpivot WHERE ${value} IS NOT NULL) ${alias}`;
		out = `${out.slice(0, fromAt + 4)} ${replacement}${out.slice(tailEnd)}`;
		rewrites++;
	}
	return { sql: out, rewrites };
}

/** Rule N1: output column names as written.
 * @returns {(string|undefined)[]|undefined} */
export function projectionNames(sql) {
	return projectionItems(sql)?.map((item) => item?.name);
}

/** Rule S1: a star over a UNION derived table written out as its column list.
 * @returns {{ sql: string, expanded: number }} */
export function expandStarsOverUnions(sql) {
	const s = String(sql ?? '');
	const edits = [];
	for (const m of s.matchAll(/\bSELECT\b/gi)) {
		if (insideQuotes(s, m.index)) continue;
		const end = blockEnd(s, m.index);
		const sources = fromSources(s, m.index, end);
		if (!sources?.some((x) => x.union)) continue;
		for (const item of projectionSpans(s, m.index, end)) {
			const qualifier = item.text.match(new RegExp(`^(${IDENT})\\.\\*$`))?.[1];
			if (item.text !== '*' && !qualifier) continue;
			const picked = qualifier ? sources.filter((x) => x.alias.toLowerCase() === unquote(qualifier).toLowerCase()) : sources;
			if (!picked.some((x) => x.union) || picked.some((x) => !x.alias || !x.columns)) continue;
			const listed = picked.flatMap((x) =>
				x.union
					? x.union.filter(Boolean).map((col) => `${x.aliasText}.${written(col)} AS ${written(col)}`)
					: [`${x.aliasText}.*`]
			);
			edits.push({ at: item.start, length: item.text.length, text: listed.join(', ') });
		}
	}
	return { sql: applyEdits(s, edits), expanded: edits.length };
}

/** {@link matchColumnCase} until nothing changes: one pass reads each derived table's columns before its own fixes,
 * so a reference to a column renamed by the same pass keeps the old spelling. */
export function matchColumnCaseFully(sql) {
	let out = String(sql ?? '');
	const fixed = new Set();
	for (let pass = 0; pass < 6; pass++) {
		const next = matchColumnCase(out);
		next.fixed.forEach((f) => fixed.add(f));
		if (next.sql === out) break;
		out = next.sql;
	}
	return { sql: out, fixed: [...fixed] };
}

/** Rule D1: references to a derived table's columns written in that column's case.
 * @returns {{ sql: string, fixed: string[] }} */
export function matchColumnCase(sql) {
	const s = String(sql ?? '');
	const edits = [];
	for (const m of s.matchAll(/\bSELECT\b/gi)) {
		if (insideQuotes(s, m.index)) continue;
		const end = blockEnd(s, m.index);
		const sources = fromSources(s, m.index, end, { partial: true });
		if (!sources) continue;
		const columnsOf = new Map(sources.filter((x) => x.columns).map((x) => [x.alias.toLowerCase(), x.columns]));
		const pick = (names, word) => {
			const hits = names.filter((n) => n.toLowerCase() === word.toLowerCase());
			return new Set(hits).size === 1 ? hits[0] : undefined;
		};
		const aliases = new Set(sources.map((x) => x.alias.toLowerCase()));
		forEachTopToken(s, m.index + 6, end, (word, at, qualifier) => {
			if (SQL_WORDS.has(word.toLowerCase()) || (!qualifier && aliases.has(word.toLowerCase()))) return;
			let want;
			if (qualifier) want = columnsOf.has(qualifier.toLowerCase()) ? pick(columnsOf.get(qualifier.toLowerCase()), word) : undefined;
			else {
				const owners = [...columnsOf.values()].map((cols) => pick(cols, word)).filter(Boolean);
				want = owners.length === 1 ? owners[0] : undefined;
			}
			if (want && want !== word) edits.push({ at, length: word.length, want, word });
		});
	}
	let out = s;
	for (const e of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}${e.want}${out.slice(e.at + e.length)}`;
	return { sql: out, fixed: [...new Set(edits.map((e) => `${e.word} -> ${e.want}`))] };
}

function blockEnd(sql, start) {
	let depth = 0;
	for (let i = start + 6; i < sql.length; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')' && depth-- === 0) return i;
		else if (depth === 0 && !/[\w$]/.test(sql[i - 1] ?? '') && /^(?:UNION|INTERSECT|EXCEPT|MINUS)\b/i.test(sql.slice(i, i + 10))) return i;
		i++;
	}
	return sql.length;
}

function fromSources(sql, start, end, { partial = false } = {}) {
	const fromAt = topLevelKeyword(sql, 'FROM', start + 6, end)[0];
	if (fromAt === undefined) return undefined;
	const clauseEnd = Math.min(end, ...['WHERE', 'GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'LIMIT'].flatMap((w) => topLevelKeyword(sql, w, fromAt, end).slice(0, 1)));
	const sources = [];
	let i = fromAt + 4;
	while (i < clauseEnd) {
		while (i < clauseEnd && /[\s,]/.test(sql[i])) i++;
		const join = sql.slice(i, clauseEnd).match(/^(?:(?:NATURAL\s+)?(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?)?JOIN\s+/i);
		if (join) i += join[0].length;
		if (i >= clauseEnd) break;
		let columns;
		let union;
		if (sql[i] === '(') {
			const close = closeParen(sql, i + 1);
			if (!close) return undefined;
			const items = projectionItems(sql.slice(i + 1, close.end), { partial });
			columns = items?.map((item) => item?.name).filter(Boolean);
			if (!columns) return undefined;
			if (['UNION', 'INTERSECT', 'EXCEPT', 'MINUS'].some((w) => topLevelKeyword(sql, w, i + 1, close.end).length)) union = items;
			i = close.end + 1;
		} else {
			const table = sql.slice(i).match(new RegExp(`^(?:${IDENT}\\.)*${IDENT}`));
			if (!table) return undefined;
			i += table[0].length;
		}
		const alias = sql.slice(i, clauseEnd).match(new RegExp(`^\\s${columns ? '*' : '+'}(?:AS\\s+)?${NOT_CLAUSE}(${IDENT})`, 'i'));
		if (alias) i += alias[0].length;
		sources.push({ alias: alias ? unquote(alias[1]) : '', ...(alias ? { aliasText: alias[1] } : {}), columns, ...(union ? { union } : {}) });
		const next = nextSource(sql, i, clauseEnd);
		if (next < 0) break;
		i = next;
	}
	return sources;
}

function nextSource(sql, from, to) {
	let depth = 0;
	for (let i = from; i < to; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (depth === 0 && (ch === ',' || (!/[\w$]/.test(sql[i - 1] ?? '') && /^JOIN\b/i.test(sql.slice(i, i + 5))))) return i;
		i++;
	}
	return -1;
}

function forEachTopToken(sql, from, to, visit) {
	for (let i = from; i < to; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') {
			const sub = /^\(\s*SELECT\b/i.test(sql.slice(i, i + 200));
			if (sub) {
				const close = closeParen(sql, i + 1);
				i = close ? close.end + 1 : to;
				continue;
			}
		}
		const word = /[A-Za-z_]/.test(ch) && !/[\w$]/.test(sql[i - 1] ?? '') ? sql.slice(i).match(/^[A-Za-z_][\w$]*/)[0] : undefined;
		if (!word) {
			i++;
			continue;
		}
		const after = sql.slice(i + word.length).match(/^\s*([.(])?/)[1];
		const qualifier = sql.slice(0, i).match(new RegExp(`(${IDENT})\\s*\\.\\s*$`))?.[1];
		if (!after) visit(word, i, qualifier ? unquote(qualifier) : undefined);
		i += word.length;
	}
}

function projectionItems(sql, { partial = false } = {}) {
	const s = String(sql ?? '').trim();
	const select = topLevelKeyword(s, 'SELECT')[0];
	if (select === undefined) return undefined;
	const from = topLevelKeyword(s, 'FROM', select).find((f) => f > select);
	const listEnd = from ?? s.length;
	const commas = [];
	let depth = 0;
	for (let i = select + 6; i < listEnd; ) {
		const ch = s[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(s, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) commas.push(i);
		i++;
	}
	const items = [];
	let start = select + 6;
	for (const c of [...commas, listEnd]) {
		items.push(s.slice(start, c).trim());
		start = c + 1;
	}
	items[0] = items[0].replace(/^(?:DISTINCT|ALL)\s+/i, '').replace(/^TOP\s+\d+\s+/i, '');
	const names = [];
	for (const item of items) {
		const alias = item.match(new RegExp(`(?:\\bAS\\s+|[\\s)])(${IDENT})$`, 'i'));
		const plain = item.match(new RegExp(`^(?:${IDENT}\\.)*(${IDENT})$`));
		if (/(^|\.)\*$/.test(item)) {
			const sources = fromSources(s, select, s.length, { partial });
			if (!sources) {
				if (partial) continue;
				return undefined;
			}
			const qualifier = item.match(new RegExp(`^(${IDENT})\\.\\*$`))?.[1];
			const picked = qualifier ? sources.filter((x) => x.alias.toLowerCase() === unquote(qualifier).toLowerCase()) : sources;
			if (!partial && (!picked.length || picked.some((x) => !x.columns))) return undefined;
			names.push(...picked.flatMap((x) => (x.columns ?? []).map((name) => ({ name, aliased: false, quoted: false }))));
		} else if (plain) names.push({ name: unquote(plain[1]), aliased: false, quoted: /^"/.test(plain[1]) });
		else if (alias && !/^(?:END|AND|OR|NOT|NULL|THEN|ELSE)$/i.test(alias[1])) names.push({ name: unquote(alias[1]), aliased: true, quoted: /^"/.test(alias[1]) });
		else names.push(undefined);
	}
	return names;
}

const SQL_WORDS = new Set('select distinct all as case when then else end and or not null is in like ilike between true false cast interval exists any some on by group order having limit asc desc nulls first last over partition rows range current row preceding following unbounded where from join inner left right full outer cross union qualify using'.split(' '));

/** Source columns the block around an UNPIVOT reads, undefined when it selects `*`. The rewrite names them because
 * `alias.*` over a derived table holding a scalar subquery fails in the view parser ("Invalid column(s) referenced"). */
function keptColumns(sql, fromAt, tailEnd, alias, generated) {
	const blockStart = lastAtDepth(sql, fromAt, 'SELECT');
	if (blockStart === undefined) return undefined;
	let blockEnd = tailEnd;
	for (let depth = 0; blockEnd < sql.length; blockEnd++) {
		const ch = sql[blockEnd];
		if (ch === "'" || ch === '"' || ch === '`') {
			blockEnd = skipQuoted(sql, blockEnd) - 1;
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')' && depth-- === 0) break;
	}
	const text = `${sql.slice(blockStart + 6, fromAt)} ${sql.slice(tailEnd, blockEnd)}`;
	if (/(^|[\s,])\*\s*(,|$)/.test(sql.slice(blockStart + 6, fromAt).replace(/^\s*(?:DISTINCT|ALL)\s+/i, ''))) return undefined;
	const skip = new Set(generated.map((g) => unquote(g).toLowerCase()));
	const out = [];
	const re = new RegExp(`'(?:[^']|'')*'|(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})(\\s*\\()?`, 'g');
	let previous = '';
	for (const m of text.matchAll(re)) {
		const [whole, qualifier, id, call] = m;
		const word = previous;
		previous = whole.trim().toLowerCase();
		if (whole.startsWith("'") || call || !id || /^\d/.test(id)) continue;
		if (qualifier && unquote(qualifier).toLowerCase() !== alias.toLowerCase()) continue;
		if (word === 'as' || SQL_WORDS.has(id.toLowerCase()) || skip.has(unquote(id).toLowerCase())) continue;
		if (!out.some((c) => unquote(c).toLowerCase() === unquote(id).toLowerCase())) out.push(id);
	}
	return out;
}

function lastAtDepth(sql, index, word) {
	let found;
	const stack = [];
	for (let i = 0; i < index; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') {
			stack.push(found);
			found = undefined;
		} else if (ch === ')') {
			found = stack.pop();
		} else if (!/[\w$]/.test(sql[i - 1] ?? '') && new RegExp(`^${word}\\b`, 'i').test(sql.slice(i, i + word.length + 1))) found = i;
		i++;
	}
	return found;
}

function enclosingFrom(sql, index) {
	const froms = [];
	let depth = 0;
	for (let i = 0; i < index; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			while (froms.length && froms.at(-1).depth > depth) froms.pop();
		} else if (!/[\w$]/.test(sql[i - 1] ?? '') && /^FROM\b/i.test(sql.slice(i, i + 5))) froms.push({ at: i, depth });
		i++;
	}
	return froms.findLast((f) => f.depth === depth)?.at;
}


function insideQuotes(sql, index) {
	for (let i = 0; i < index; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			const end = skipQuoted(sql, i);
			if (end > index) return true;
			i = end;
		} else i++;
	}
	return false;
}

/** Rule P3: `FROM (subquery)` with no alias. */
export function aliasDerivedTables(sql) {
	let out = String(sql ?? '');
	let added = 0;
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i] !== '(' || insideQuotes(out, i)) continue;
		if (!/\b(?:FROM|JOIN)\s*$/i.test(out.slice(Math.max(0, i - 12), i))) continue;
		if (!/^\(\s*(?:SELECT|WITH)\b/i.test(out.slice(i, i + 200))) continue;
		const close = closeParen(out, i + 1);
		if (!close) continue;
		const rest = out.slice(close.end + 1);
		if (new RegExp(`^\\s*(?:AS\\s+)?${NOT_CLAUSE}${IDENT}`, 'i').test(rest)) continue;
		out = `${out.slice(0, close.end + 1)} t2d_derived_${++added}${rest}`;
	}
	return { sql: out, added };
}

/** Rule F1 (docs/VIEW-SQL-RULES.md), Databricks-only entries left out. */
export const SUPPORTED_FUNCTIONS = new Set(
	`__DOMO_REQUIRED_FILTER ABS ADDDATE ADDTIME ANY_VALUE APPROXIMATE_COUNT_DISTINCT APPROXIMATE_COUNT_DISTINCT_SYNOPSIS
	APPROXIMATE_COUNT_DISTINCT_OF_SYNOPSIS APPROXIMATE_MEDIAN APPROXIMATE_PERCENTILE AVG CALENDAR CALENDAR_PERIOD
	CALENDAR_PERIOD_ROLLING CALENDAR_PERIOD_TO_DATE CASE CAST CEILING COALESCE CONCAT CONVERT_TZ CORR COUNT CURDATE CURRENT_DATE
	CURRENT_TIME CURRENT_TIMESTAMP CURTIME DATE DATE_ADD DATE_FORMAT DATE_RANGE DATE_SUB DATE_TRUNC DATEDIFF DAY DAYNAME DAYOFMONTH
	DAYOFWEEK DAYOFYEAR DIV DOMO_BEAST_MODE DYNACAST FIRST_VALUE FIXED FLOOR FROM_DAYS FROM_UNIXTIME GRAIN_HOUR GRAIN_MINUTE
	GRAIN_SECOND HOUR IFNULL INITCAP INSERT INSTR LAG LAST_DAY LAST_VALUE LCASE LEAD LEFT LENGTH LISTAGG LN LOG LOWER LPAD MAX MD5
	MEDIAN MIN MINUTE MOD MONTH MONTHNAME NOW NTILE NULLIF NVL OCTET_LENGTH ONLY_AGG PERCENTILE PERCENTILE25 PERCENTILE75
	PERCENTILE99 PERCENTILE_CONT PERIOD_ADD PERIOD_DIFF POWER POW QUARTER RAND RANDOM RANK DENSE_RANK REGEXP_REPLACE REPLACE RIGHT
	ROUND RPAD SAFE_DIVIDE SEC_TO_TIME SECOND SHA1 SHA224 SHA256 SHA384 SHA512 SQRT SPLIT_PART STDDEV STDDEV_POP STRPOS STR_CONTAINS
	STR_DIGITS STR_ENDS_WITH STR_REMOVE_DIGITS STR_STARTS_WITH STR_TO_DATE SUBDATE SUBSTR SUBSTRING SUBSTRING_INDEX SUBTIME SUM
	SYSDATE TIME TIME_FORMAT TIME_TO_SEC TIMEDIFF TIMESTAMP TO_CHAR TO_DATE TO_DAYS TO_NUMBER TRIM TRUNC TRY_CAST UNIX_TIMESTAMP
	UPPER VAR VAR_POP WEEK WEEKDAY WEEKOFYEAR WIDTH_BUCKET YEAR YEARWEEK HLL_SKETCH_INIT HLL_SKETCH_MERGE HLL_SKETCH_MERGE_PARTIAL
	HLL_SKETCH_ESTIMATE`.split(/\s+/)
);

const GRAMMAR_FORMS = new Set(
	`AND ALL ANY AS BETWEEN BY CASE CAST CURRENT DISTINCT ELSE END ESCAPE EXCEPT EXISTS EXTRACT FILTER FROM GROUP GROUP_CONCAT
	HAVING ILIKE IN INTERSECT INTERVAL IS JOIN KEEP LATERAL LIKE LIMIT MINUS NOT NULLS ON OR ORDER OVER PARTITION PIVOT QUALIFY
	RANGE RECURSIVE RLIKE REGEXP ROWS SELECT SOME THEN TOP TRY_CAST UNION USING VALUES WHEN WHERE WITH WITHIN`.split(/\s+/)
);

function splitArgs(sql, argsStart, close) {
	const starts = [argsStart, ...close.commas.map((c) => c + 1)];
	const ends = [...close.commas, close.end];
	const args = starts.map((s, k) => sql.slice(s, ends[k]).trim());
	return args.length === 1 && !args[0] ? [] : args;
}

function rewriteCalls(sql, names, rewrite) {
	let out = String(sql ?? '');
	const pattern = new RegExp(String.raw`(?<![\w$."\`])(${names.join('|')})\s*\(`, 'gi');
	for (let searchFrom = 0; ; ) {
		pattern.lastIndex = searchFrom;
		let found;
		for (let m; (m = pattern.exec(out)); ) {
			if (!insideQuotes(out, m.index)) {
				found = m;
				break;
			}
		}
		if (!found) break;
		const argsStart = found.index + found[0].length;
		const close = closeParen(out, argsStart);
		const replacement = close ? rewrite(found[1].toUpperCase(), splitArgs(out, argsStart, close), out.slice(found.index, close.end + 1)) : undefined;
		if (replacement === undefined) {
			searchFrom = argsStart;
			continue;
		}
		out = `${out.slice(0, found.index)}${replacement}${out.slice(close.end + 1)}`;
		searchFrom = found.index;
	}
	return out;
}

const SIMPLE_OPERAND = new RegExp(`^(?:(?:${IDENT}\\.)*${IDENT}|'(?:[^']|'')*'|[+-]?\\d+(?:\\.\\d+)?)$`, 'i');
const wrap = (expr) => (SIMPLE_OPERAND.test(expr) ? expr : `(${expr})`);
const INTEGER = /^\d+$/;
const NUMBER_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;
const LITERAL_STRING = /^'(?:[^']|'')*'$/;
const isNullLiteral = (expr) => /^NULL$/i.test(expr);
const datePart = (arg) => DATE_PARTS.get(String(arg).replace(/^'|'$/g, '').toLowerCase());
const numberType = (args) => (args.length === 1 ? 'NUMBER' : args.slice(1).every((a) => INTEGER.test(a)) ? `NUMBER(${args.slice(1).join(', ')})` : undefined);

function greatest(args, op) {
	return args.reduce((x, y) => {
		const a = wrap(x);
		const b = wrap(y);
		return `CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL WHEN ${a} ${op} ${b} THEN ${a} ELSE ${b} END`;
	});
}

function trimClass(chars) {
	if (chars === undefined) return ' ';
	const inner = LITERAL_STRING.test(chars) ? chars.slice(1, -1) : undefined;
	if (!inner || /[\\'\]^[]/.test(inner)) return undefined;
	return `[${inner.replace(/-/g, '')}${inner.includes('-') ? '-' : ''}]`;
}

const FUNCTION_REWRITES = {
	TO_VARCHAR: (args) => `TO_CHAR(${args.join(', ')})`,
	IFF: (args) => (args.length === 3 ? `CASE WHEN ${wrap(args[0])} THEN ${args[1]} ELSE ${args[2]} END` : undefined),
	NVL2: (args) => (args.length === 3 ? `CASE WHEN ${wrap(args[0])} IS NOT NULL THEN ${args[1]} ELSE ${args[2]} END` : undefined),
	ZEROIFNULL: (args) => (args.length === 1 ? `COALESCE(${args[0]}, 0)` : undefined),
	NULLIFZERO: (args) => (args.length === 1 ? `NULLIF(${args[0]}, 0)` : undefined),
	DIV0: (args) => (args.length === 2 ? `CASE WHEN ${wrap(args[1])} = 0 THEN 0 ELSE ${wrap(args[0])} / ${wrap(args[1])} END` : undefined),
	DIV0NULL: (args) => (args.length === 2 ? `CASE WHEN ${wrap(args[1])} = 0 OR ${wrap(args[1])} IS NULL THEN 0 ELSE ${wrap(args[0])} / ${wrap(args[1])} END` : undefined),
	DECODE: (args) => {
		if (args.length < 3) return undefined;
		const subject = wrap(args[0]);
		const pairs = [];
		for (let k = 1; k + 1 < args.length; k += 2) {
			const search = args[k];
			let test = `(${subject} = ${wrap(search)} OR (${subject} IS NULL AND ${wrap(search)} IS NULL))`;
			if (isNullLiteral(search)) test = `${subject} IS NULL`;
			else if (LITERAL_STRING.test(search) || NUMBER_LITERAL.test(search)) test = `${subject} = ${search}`;
			pairs.push(`WHEN ${test} THEN ${args[k + 1]}`);
		}
		return `CASE ${pairs.join(' ')}${args.length % 2 === 0 ? ` ELSE ${args.at(-1)}` : ''} END`;
	},
	CONTAINS: (args) => (args.length === 2 ? `STR_CONTAINS(${args.join(', ')})` : undefined),
	STARTSWITH: (args) => (args.length === 2 ? `STR_STARTS_WITH(${args.join(', ')})` : undefined),
	ENDSWITH: (args) => (args.length === 2 ? `STR_ENDS_WITH(${args.join(', ')})` : undefined),
	LEN: (args) => (args.length === 1 ? `LENGTH(${args[0]})` : undefined),
	CHAR_LENGTH: (args) => (args.length === 1 ? `LENGTH(${args[0]})` : undefined),
	CHARACTER_LENGTH: (args) => (args.length === 1 ? `LENGTH(${args[0]})` : undefined),
	CEIL: (args) => (args.length === 1 ? `CEILING(${args[0]})` : undefined),
	LTRIM: (args) => {
		const cls = args.length <= 2 && args.length ? trimClass(args[1]) : undefined;
		return cls ? `REGEXP_REPLACE(${args[0]}, '^${cls}+', '')` : undefined;
	},
	RTRIM: (args) => {
		const cls = args.length <= 2 && args.length ? trimClass(args[1]) : undefined;
		return cls ? `REGEXP_REPLACE(${args[0]}, '${cls}+$', '')` : undefined;
	},
	LPAD: (args) => (args.length === 2 ? `LPAD(${args[0]}, ${args[1]}, ' ')` : undefined),
	RPAD: (args) => (args.length === 2 ? `RPAD(${args[0]}, ${args[1]}, ' ')` : undefined),
	CONCAT_WS: (args) => (args.length >= 2 ? `CONCAT(${args.slice(1).flatMap((a, k) => (k ? [args[0], a] : [a])).join(', ')})` : undefined),
	CHARINDEX: (args) => (args.length === 2 ? `INSTR(${args[1]}, ${args[0]})` : undefined),
	POSITION: (args) => {
		const parts = args.length === 1 ? splitTopLevelIn(args[0]) : args;
		return parts?.length === 2 ? `INSTR(${parts[1]}, ${parts[0]})` : undefined;
	},
	SQUARE: (args) => (args.length === 1 ? `POWER(${args[0]}, 2)` : undefined),
	SHA2: (args) => {
		const bits = args[1] ?? '256';
		return args.length <= 2 && ['224', '256', '384', '512'].includes(bits) ? `SHA${bits}(${args[0]})` : undefined;
	},
	SHA2_HEX: (args) => FUNCTION_REWRITES.SHA2(args),
	GREATEST: (args) => (args.length >= 2 && args.length <= 3 ? greatest(args, '>=') : undefined),
	LEAST: (args) => (args.length >= 2 && args.length <= 3 ? greatest(args, '<=') : undefined),
	GETDATE: (args) => (args.length ? undefined : 'CURRENT_TIMESTAMP'),
	SYSTIMESTAMP: (args) => (args.length ? undefined : 'CURRENT_TIMESTAMP'),
	LOCALTIMESTAMP: (args) => (args.length ? undefined : 'CURRENT_TIMESTAMP'),
	TO_TIMESTAMP: (args) => (args.length === 1 ? `CAST(${args[0]} AS TIMESTAMP)` : undefined),
	TO_TIMESTAMP_NTZ: (args) => (args.length === 1 ? `CAST(${args[0]} AS TIMESTAMP)` : undefined),
	TRY_TO_TIMESTAMP: (args) => (args.length === 1 ? `TRY_CAST(${args[0]} AS TIMESTAMP)` : undefined),
	TRY_TO_TIMESTAMP_NTZ: (args) => (args.length === 1 ? `TRY_CAST(${args[0]} AS TIMESTAMP)` : undefined),
	TRY_TO_DATE: (args) => (args.length === 1 ? `TRY_CAST(${args[0]} AS DATE)` : undefined),
	TO_DOUBLE: (args) => (args.length === 1 ? `CAST(${args[0]} AS DOUBLE)` : undefined),
	TRY_TO_DOUBLE: (args) => (args.length === 1 ? `TRY_CAST(${args[0]} AS DOUBLE)` : undefined),
	TO_BOOLEAN: (args) => (args.length === 1 ? `CAST(${args[0]} AS BOOLEAN)` : undefined),
	TRY_TO_BOOLEAN: (args) => (args.length === 1 ? `TRY_CAST(${args[0]} AS BOOLEAN)` : undefined),
	TO_NUMBER: (args) => (args.length > 1 && args.length <= 3 && numberType(args) ? `CAST(${args[0]} AS ${numberType(args)})` : undefined),
	TO_DECIMAL: (args) => (args.length <= 3 && numberType(args) ? `CAST(${args[0]} AS ${numberType(args)})` : undefined),
	TO_NUMERIC: (args) => FUNCTION_REWRITES.TO_DECIMAL(args),
	TRY_TO_NUMBER: (args) => (args.length <= 3 && numberType(args) ? `TRY_CAST(${args[0]} AS ${numberType(args)})` : undefined),
	TRY_TO_DECIMAL: (args) => FUNCTION_REWRITES.TRY_TO_NUMBER(args),
	TRY_TO_NUMERIC: (args) => FUNCTION_REWRITES.TRY_TO_NUMBER(args),
	DATE_PART: (args) => (args.length === 2 && /^'?[A-Za-z_]+'?$/.test(args[0]) ? `EXTRACT(${args[0].replace(/'/g, '').toUpperCase()} FROM ${args[1]})` : undefined),
	DATE_TRUNC: (args) => (args.length === 2 && datePart(args[0]) && !LITERAL_STRING.test(args[0]) ? `DATE_TRUNC('${args[0].toLowerCase()}', ${args[1]})` : undefined),
	TRUNC: (args) => (args.length === 2 && datePart(args[1]) && !LITERAL_STRING.test(args[1]) ? `TRUNC(${args[0]}, '${args[1].toLowerCase()}')` : undefined),
	LAST_DAY: (args) => (args.length === 2 && datePart(args[1]) === 'MONTH' ? `LAST_DAY(${args[0]})` : undefined),
	ADD_MONTHS: (args) => (args.length === 2 ? `DATE_ADD(${args[0]}, INTERVAL ${/^[+-]?\d+$/.test(args[1]) ? args[1] : `(${args[1]})`} MONTH)` : undefined),
	COUNT_IF: (args) => (args.length === 1 ? `COUNT(CASE WHEN ${args[0]} THEN 1 END)` : undefined)
};

const APPROXIMATE_REWRITES = new Set(['ADD_MONTHS']);

function splitTopLevelIn(text) {
	const at = topLevelKeyword(text, 'IN')[0];
	return at === undefined ? undefined : [text.slice(0, at).trim(), text.slice(at + 2).trim()];
}

/** Rejected Snowflake functions as supported ones with the same result (rule F2), and bare date parts quoted (rule Q1).
 * @returns {{ sql: string, rewritten: string[], approximate: string[] }} */
export function rewriteFunctions(sql) {
	const rewritten = [];
	const out = rewriteCalls(sql, Object.keys(FUNCTION_REWRITES), (name, args, text) => {
		const replacement = FUNCTION_REWRITES[name](args, text);
		if (replacement !== undefined) rewritten.push(name);
		return replacement;
	});
	const names = [...new Set(rewritten)];
	return { sql: out, rewritten: names, approximate: names.filter((n) => APPROXIMATE_REWRITES.has(n)) };
}

/** Rule F1; window calls (`OVER`, `WITHIN GROUP`) are analytic expressions, which the validator does not check by name.
 * @returns {string[]} distinct upper-cased names */
export function unsupportedFunctions(sql) {
	const s = String(sql ?? '');
	const found = new Set();
	for (const m of s.matchAll(/(?<![\w$."`])([A-Za-z_][\w$]*)\s*\(/g)) {
		const name = m[1].toUpperCase();
		if (SUPPORTED_FUNCTIONS.has(name) || GRAMMAR_FORMS.has(name) || insideQuotes(s, m.index)) continue;
		if (/(?:\bAS|::)\s*$/i.test(s.slice(0, m.index))) continue;
		const close = closeParen(s, m.index + m[0].length);
		if (close && /^\s*(?:OVER|WITHIN\s+GROUP)\b/i.test(s.slice(close.end + 1))) continue;
		found.add(name);
	}
	return [...found];
}

const CAST_TYPES = new Map([
	['TIMESTAMP_NTZ', 'TIMESTAMP'],
	['TEXT', 'VARCHAR'],
	['DOUBLE PRECISION', 'DOUBLE'],
	['FLOAT4', 'FLOAT'],
	['BYTEINT', 'INTEGER']
]);
const UNTYPED_CASTS = /^(?:TIMESTAMP_LTZ|TIMESTAMP_TZ)$/i;
const CAST_TYPE_NAME = /^(DOUBLE\s+PRECISION|[A-Za-z_][\w]*)/i;

/** Rule T2.
 * @returns {{ sql: string, rewrites: number, untyped: string[] }} `untyped`: casts with no such name (TIMESTAMP_LTZ, TIMESTAMP_TZ) */
export function rewriteCastTypes(sql) {
	let rewrites = 0;
	const untyped = new Set();
	const mapType = (type) => {
		const m = type.match(CAST_TYPE_NAME);
		if (!m) return undefined;
		if (UNTYPED_CASTS.test(m[1])) untyped.add(m[1].toUpperCase());
		const to = CAST_TYPES.get(m[1].toUpperCase().replace(/\s+/g, ' '));
		if (!to) return undefined;
		rewrites++;
		return `${to}${type.slice(m[0].length)}`;
	};
	let out = rewriteCalls(sql, ['CAST', 'TRY_CAST'], (name, args) => {
		if (args.length !== 1) return undefined;
		const at = topLevelKeyword(args[0], 'AS').at(-1);
		if (at === undefined) return undefined;
		const type = mapType(args[0].slice(at + 2).trim());
		return type === undefined ? undefined : `${name}(${args[0].slice(0, at).trim()} AS ${type})`;
	});
	out = out.replace(/::\s*(DOUBLE\s+PRECISION|[A-Za-z_]\w*)/gi, (all, type, offset) => {
		if (insideQuotes(out, offset)) return all;
		const mapped = mapType(type);
		return mapped === undefined ? all : `::${mapped}`;
	});
	return { sql: out, rewrites, untyped: [...untyped] };
}

const VALUE_WORDS = /^(?:NULL|TRUE|FALSE|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|SYSDATE)$/i;

function depthAt(sql, index) {
	let depth = 0;
	for (let i = 0; i < index; ) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipQuoted(sql, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		i++;
	}
	return depth;
}

/** Rule D2.
 * @returns {{ sql: string, aliased: number }} */
export function aliasDerivedColumns(sql) {
	const s = String(sql ?? '');
	const edits = [];
	const plain = new RegExp(`^(?:${IDENT}\\.)*(${IDENT})$`);
	for (const m of s.matchAll(/\bSELECT\b/gi)) {
		if (insideQuotes(s, m.index) || depthAt(s, m.index) === 0) continue;
		for (const item of projectionSpans(s, m.index, blockEnd(s, m.index))) {
			const column = item.text.match(plain)?.[1];
			if (!column || VALUE_WORDS.test(column) || !item.text.includes('.') && SQL_WORDS.has(column.toLowerCase())) continue;
			edits.push({ at: item.start, length: item.text.length, text: `${item.text} AS ${column}` });
		}
	}
	return { sql: applyEdits(s, edits), aliased: edits.length };
}
