import { CalcSyntaxError } from './errors.js';
import { tokenize, bracket } from './lexer.js';
import { parseDateLiteral } from './dates.js';

/**
 * AST node shapes (all carry `pos`, the 0-based source offset):
 * - Literal  { valueType: 'number'|'string'|'boolean'|'null'|'date'|'datetime', value, raw }
 * - Field    { id, parts }                     id is the normalized bracketed id
 * - Call     { name, args }                    name is upper-cased
 * - Unary    { op: '-'|'+'|'NOT', operand }
 * - Binary   { op: '+'|'-'|'*'|'/'|'%'|'^'|'='|'!='|'<'|'<='|'>'|'>='|'AND'|'OR', left, right }
 * - In       { expr, list, negated }
 * - If       { branches: [{ cond, then }], else }
 * - Case     { subject, whens: [{ when, then }], else }
 * - Lod      { lodType: 'FIXED'|'INCLUDE'|'EXCLUDE'|'TABLE', dims, body }
 * - Paren    { expr }
 * @typedef {Object} AstNode
 * @property {string} type
 * @property {number} pos
 */

const RESERVED = new Set(['THEN', 'ELSE', 'ELSEIF', 'END', 'WHEN', 'AND', 'OR', 'IN']);
const COMPARISON = { '=': '=', '==': '=', '!=': '!=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const BP = { OR: 10, AND: 20, NOT: 30, CMP: 40, ADD: 50, MUL: 60, POW: 70, UNARY: 80 };

/**
 * Parse a Tableau calculation into an AST.
 * @param {string} text
 * @returns {AstNode}
 * @throws {CalcSyntaxError}
 */
export function parseFormula(text) {
	const src = String(text ?? '');
	const tokens = tokenize(src);
	let index = 0;

	const peek = (offset = 0) => tokens[Math.min(index + offset, tokens.length - 1)];
	const next = () => tokens[index++];
	const fail = (message, tok = peek()) => {
		throw new CalcSyntaxError(message, tok.pos, src);
	};
	const describe = (tok) => (tok.type === 'eof' ? 'end of formula' : `'${tok.type === 'string' ? tok.quote + tok.value + tok.quote : tok.value}'`);
	const isKeyword = (tok, word) => tok.type === 'ident' && tok.value.toUpperCase() === word;
	const isOp = (tok, op) => tok.type === 'op' && tok.value === op;
	const expectOp = (op) => {
		const tok = peek();
		if (!isOp(tok, op)) fail(`Expected '${op}' but found ${describe(tok)}`, tok);
		return next();
	};
	const expectKeyword = (word) => {
		const tok = peek();
		if (!isKeyword(tok, word)) fail(`Expected ${word} but found ${describe(tok)}`, tok);
		return next();
	};

	function infixPower(tok) {
		if (tok.type === 'op') {
			if (tok.value === '||') return BP.OR;
			if (tok.value === '&&') return BP.AND;
			if (COMPARISON[tok.value]) return BP.CMP;
			if (tok.value === '+' || tok.value === '-') return BP.ADD;
			if (tok.value === '*' || tok.value === '/' || tok.value === '%') return BP.MUL;
			if (tok.value === '^') return BP.POW;
			return 0;
		}
		if (tok.type === 'ident') {
			const word = tok.value.toUpperCase();
			if (word === 'OR') return BP.OR;
			if (word === 'AND') return BP.AND;
			if (word === 'IN') return BP.CMP;
			if (word === 'NOT' && isKeyword(peek(1), 'IN')) return BP.CMP;
		}
		return 0;
	}

	function parseExpression(minBp = 0) {
		let left = parsePrefix();
		for (;;) {
			const tok = peek();
			const bp = infixPower(tok);
			if (!bp || bp <= minBp) break;
			next();
			if (tok.type === 'ident' && (tok.value.toUpperCase() === 'IN' || tok.value.toUpperCase() === 'NOT')) {
				const negated = tok.value.toUpperCase() === 'NOT';
				if (negated) next();
				left = { type: 'In', expr: left, list: parseInList(), negated, pos: tok.pos };
				continue;
			}
			let op;
			if (tok.type === 'op') {
				op = COMPARISON[tok.value] || { '||': 'OR', '&&': 'AND' }[tok.value] || tok.value;
			} else {
				op = tok.value.toUpperCase();
			}
			const right = parseExpression(op === '^' ? bp - 1 : bp);
			left = { type: 'Binary', op, left, right, pos: tok.pos };
		}
		return left;
	}

	function parseInList() {
		const open = peek();
		if (!isOp(open, '(')) fail(`IN must be followed by a parenthesized list, found ${describe(open)}`, open);
		next();
		const list = [];
		if (!isOp(peek(), ')')) {
			list.push(parseExpression());
			while (isOp(peek(), ',')) {
				next();
				if (isOp(peek(), ')')) break;
				list.push(parseExpression());
			}
		}
		expectOp(')');
		if (!list.length) fail('IN list is empty', open);
		return list;
	}

	function parsePrefix() {
		const tok = peek();
		switch (tok.type) {
			case 'number':
				next();
				return { type: 'Literal', valueType: 'number', value: Number(tok.value), raw: tok.value, pos: tok.pos };
			case 'string':
				next();
				return { type: 'Literal', valueType: 'string', value: tok.value, raw: tok.value, pos: tok.pos };
			case 'date': {
				next();
				const parsed = parseDateLiteral(tok.value);
				if (!parsed) fail(`Unrecognized date literal #${tok.value}#`, tok);
				return { type: 'Literal', valueType: parsed.type, value: parsed.value, raw: tok.value, pos: tok.pos };
			}
			case 'field':
				next();
				return { type: 'Field', id: tok.value, parts: tok.parts, pos: tok.pos };
			case 'op':
				return parseOperatorPrefix(tok);
			case 'ident':
				return parseIdent(tok);
			default:
				return fail(`Unexpected ${describe(tok)}`, tok);
		}
	}

	function parseOperatorPrefix(tok) {
		if (tok.value === '(') {
			next();
			const expr = parseExpression();
			expectOp(')');
			return { type: 'Paren', expr, pos: tok.pos };
		}
		if (tok.value === '{') return parseLod();
		if (tok.value === '-' || tok.value === '+') {
			next();
			return { type: 'Unary', op: tok.value, operand: parseExpression(BP.UNARY), pos: tok.pos };
		}
		if (tok.value === '!') {
			next();
			return { type: 'Unary', op: 'NOT', operand: parseExpression(BP.NOT), pos: tok.pos };
		}
		return fail(`Unexpected ${describe(tok)}`, tok);
	}

	function parseIdent(tok) {
		const word = tok.value.toUpperCase();
		if (word === 'TRUE' || word === 'FALSE') {
			next();
			return { type: 'Literal', valueType: 'boolean', value: word === 'TRUE', raw: tok.value, pos: tok.pos };
		}
		if (word === 'NULL') {
			next();
			return { type: 'Literal', valueType: 'null', value: null, raw: tok.value, pos: tok.pos };
		}
		if (word === 'IF') return parseIf();
		if (word === 'CASE') return parseCase();
		if (word === 'NOT') {
			next();
			return { type: 'Unary', op: 'NOT', operand: parseExpression(BP.NOT), pos: tok.pos };
		}
		if (isOp(peek(1), '(')) {
			next();
			next();
			const args = [];
			if (!isOp(peek(), ')')) {
				args.push(parseExpression());
				while (isOp(peek(), ',')) {
					next();
					if (isOp(peek(), ')')) break;
					args.push(parseExpression());
				}
			}
			expectOp(')');
			return { type: 'Call', name: word, args, pos: tok.pos };
		}
		if (RESERVED.has(word)) fail(`Unexpected keyword ${word}`, tok);
		next();
		return { type: 'Field', id: bracket(tok.value), parts: [tok.value], pos: tok.pos };
	}

	function parseIf() {
		const start = next();
		const branches = [];
		const cond = parseExpression();
		expectKeyword('THEN');
		branches.push({ cond, then: parseExpression() });
		let elseExpr = null;
		for (;;) {
			const tok = peek();
			if (isKeyword(tok, 'ELSEIF')) {
				next();
				const c = parseExpression();
				expectKeyword('THEN');
				branches.push({ cond: c, then: parseExpression() });
				continue;
			}
			if (isKeyword(tok, 'ELSE')) {
				next();
				elseExpr = parseExpression();
				expectKeyword('END');
				break;
			}
			if (isKeyword(tok, 'END')) {
				next();
				break;
			}
			fail(`Expected ELSEIF, ELSE or END but found ${describe(tok)}`, tok);
		}
		return { type: 'If', branches, else: elseExpr, pos: start.pos };
	}

	function parseCase() {
		const start = next();
		const subject = isKeyword(peek(), 'WHEN') ? null : parseExpression();
		const whens = [];
		while (isKeyword(peek(), 'WHEN')) {
			next();
			const when = parseExpression();
			expectKeyword('THEN');
			whens.push({ when, then: parseExpression() });
		}
		if (!whens.length) fail(`CASE needs at least one WHEN, found ${describe(peek())}`);
		let elseExpr = null;
		if (isKeyword(peek(), 'ELSE')) {
			next();
			elseExpr = parseExpression();
		}
		expectKeyword('END');
		return { type: 'Case', subject, whens, else: elseExpr, pos: start.pos };
	}

	function parseLod() {
		const start = next();
		const head = peek();
		const word = head.type === 'ident' ? head.value.toUpperCase() : '';
		if (['FIXED', 'INCLUDE', 'EXCLUDE'].includes(word) && !isOp(peek(1), '(')) {
			next();
			const dims = [];
			if (!isOp(peek(), ':')) {
				dims.push(parseExpression());
				while (isOp(peek(), ',')) {
					next();
					dims.push(parseExpression());
				}
			}
			expectOp(':');
			if (word !== 'FIXED' && !dims.length) fail(`${word} needs at least one dimension`, head);
			const body = parseExpression();
			expectOp('}');
			return { type: 'Lod', lodType: word, dims, body, pos: start.pos };
		}
		const body = parseExpression();
		expectOp('}');
		return { type: 'Lod', lodType: 'TABLE', dims: [], body, pos: start.pos };
	}

	if (peek().type === 'eof') fail('Formula is empty');
	const ast = parseExpression();
	const tail = peek();
	if (tail.type !== 'eof') fail(`Unexpected ${describe(tail)}`, tail);
	return ast;
}
