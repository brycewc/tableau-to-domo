/**
 * Rewrites for warehouse SQL that the SQL DataSet View parser rejects before the query reaches the
 * warehouse. Pure, no I/O.
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
 * Snowflake `COLLATE(<expr>, '<spec>')`, which the view parser rejects in either syntax. A case-sensitive spec is just
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
