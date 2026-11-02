import { CalcSyntaxError } from './errors.js';

/**
 * @typedef {Object} Token
 * @property {'field'|'ident'|'number'|'string'|'date'|'op'|'eof'} type
 * @property {string} value       field: normalized id ('[a]' or '[ds].[a]'); ident: as written; string: decoded text
 * @property {string[]} [parts]   field: unescaped name parts
 * @property {string} [quote]     string: the quote character used
 * @property {number} pos         0-based offset of the first character
 * @property {number} end         Offset just past the token
 */

const OPERATORS = ['==', '!=', '<>', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '^', '=', '<', '>', '(', ')', ',', '{', '}', ':', '!'];
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/** Re-escape a field name part the way Tableau writes it: ']' becomes ']]'. */
export function bracket(part) {
	return `[${part.replace(/\]/g, ']]')}]`;
}

/**
 * Split a Tableau formula into tokens. Comments and whitespace are dropped.
 * @param {string} text
 * @returns {Token[]}
 */
export function tokenize(text) {
	const src = String(text ?? '');
	const tokens = [];
	let i = 0;
	const fail = (message, at = i) => {
		throw new CalcSyntaxError(message, at, src);
	};

	const readBracket = () => {
		const start = i;
		i++;
		let name = '';
		for (;;) {
			if (i >= src.length) fail('Unterminated field reference', start);
			const ch = src[i];
			if (ch === ']') {
				if (src[i + 1] === ']') {
					name += ']';
					i += 2;
					continue;
				}
				i++;
				return name;
			}
			name += ch;
			i++;
		}
	};

	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && src[i + 1] === '*') {
			const start = i;
			const close = src.indexOf('*/', i + 2);
			if (close < 0) fail('Unterminated block comment', start);
			i = close + 2;
			continue;
		}
		const pos = i;
		if (ch === '[') {
			const parts = [readBracket()];
			while (src[i] === '.' && src[i + 1] === '[') {
				i++;
				parts.push(readBracket());
			}
			tokens.push({ type: 'field', value: parts.map(bracket).join('.'), parts, pos, end: i });
			continue;
		}
		if (ch === '"' || ch === "'") {
			let value = '';
			i++;
			for (;;) {
				if (i >= src.length) fail('Unterminated string literal', pos);
				if (src[i] === ch) {
					if (src[i + 1] === ch) {
						value += ch;
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += src[i++];
			}
			tokens.push({ type: 'string', value, quote: ch, pos, end: i });
			continue;
		}
		if (ch === '#') {
			const close = src.indexOf('#', i + 1);
			if (close < 0) fail('Unterminated date literal', pos);
			const value = src.slice(i + 1, close).trim();
			i = close + 1;
			tokens.push({ type: 'date', value, pos, end: i });
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			const match = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
			i += match[0].length;
			if (i < src.length && IDENT_START.test(src[i])) fail(`Unexpected character '${src[i]}' after number`);
			tokens.push({ type: 'number', value: match[0], pos, end: i });
			continue;
		}
		if (IDENT_START.test(ch)) {
			let j = i + 1;
			while (j < src.length && IDENT_PART.test(src[j])) j++;
			tokens.push({ type: 'ident', value: src.slice(i, j), pos, end: j });
			i = j;
			continue;
		}
		const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
		if (!op) fail(`Unexpected character '${ch}'`);
		i += op.length;
		tokens.push({ type: 'op', value: op, pos, end: i });
	}
	tokens.push({ type: 'eof', value: '', pos: src.length, end: src.length });
	return tokens;
}
