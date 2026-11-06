import { SqlSyntaxError, splitScript, tokenize } from './lexer.js';

/**
 * Recursive descent parser for Snowflake SQL scripts (and, with `formula: true`, Magic ETL formulas, which share the
 * expression grammar with backtick identifiers).
 *
 * @typedef {{ name: string, quoted: boolean }} Ident
 * @typedef {{ name: string, args: string[] }} DataType
 * @typedef {{ e: Expr, desc: boolean, nulls?: 'FIRST'|'LAST' }} OrderItem
 * @typedef {{ unit: 'ROWS'|'RANGE', start: FrameBound, end: FrameBound }} Frame
 * @typedef {{ kind: 'UNBOUNDED'|'CURRENT'|'OFFSET', dir?: 'PRECEDING'|'FOLLOWING', n?: number }} FrameBound
 * @typedef {{ partition: Expr[], order: OrderItem[], frame?: Frame }} WindowSpec
 *
 * @typedef {{ k: string, [key: string]: any }} Expr
 *   Kinds: num, str, null, bool, col {parts: Ident[]}, star {qualifier?: Ident[], exclude?: Ident[]}, var {name},
 *   unary {op, e}, bin {op, l, r}, isnull {e, not}, isdistinct {l, r, not}, isbool {e, v, not}, like {e, p, not, ci, escape},
 *   in {e, items?, query?, not}, between {e, lo, hi, not}, exists {query, not}, subquery {query}, case {base?, whens, else?},
 *   cast {e, type, try}, fn {name, args, distinct, star, ignoreNulls, over?, within?}, interval {value, unit}, typed {type, v},
 *   paren {e}, tuple {items}
 *
 * @typedef {{ k: 'table', parts: Ident[], alias?: Ident, columns?: Ident[] }
 *   | { k: 'derived', query: Query, alias?: Ident, columns?: Ident[] }
 *   | { k: 'values', rows: Expr[][], alias?: Ident, columns?: Ident[] }
 *   | { k: 'join', type: 'INNER'|'LEFT'|'RIGHT'|'FULL'|'CROSS', l: FromItem, r: FromItem, on?: Expr, using?: Ident[], natural?: boolean, comma?: boolean }
 *   | { k: 'pivot', source: FromItem, agg: Expr, column: Expr, values: Expr[], alias?: Ident, columns?: Ident[] }
 *   | { k: 'unpivot', source: FromItem, value: Ident, name: Ident, columns: Ident[], includeNulls: boolean, alias?: Ident }} FromItem
 *
 * @typedef {{ e: Expr, alias?: Ident }} SelectItem
 * @typedef {{ k: 'select', distinct: boolean, top?: number, items: SelectItem[], from?: FromItem, where?: Expr, groupBy?: Expr[], groupingSets?: string, having?: Expr, qualify?: Expr }
 *   | { k: 'setop', op: 'UNION'|'EXCEPT'|'INTERSECT', all: boolean, l: QueryBody, r: QueryBody }
 *   | { k: 'values', rows: Expr[][] }
 *   | { k: 'nested', query: Query }} QueryBody
 * @typedef {{ k: 'query', with: { name: Ident, columns?: Ident[], query: Query }[], body: QueryBody, orderBy: OrderItem[], limit?: Expr, offset?: Expr }} Query
 *
 * @typedef {{ kind: string, index: number, start: number, end: number, text: string, [key: string]: any }} Statement
 *   kind: query, create, insert, update, delete, merge, drop, alter-table, truncate, use, session, set, unset, ignored, unknown
 */

const CLAUSE = new Set([
	'FROM', 'WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'EXCEPT', 'MINUS', 'INTERSECT', 'JOIN', 'INNER',
	'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ON', 'USING', 'AS', 'WINDOW', 'LATERAL', 'PIVOT', 'UNPIVOT', 'SAMPLE', 'TABLESAMPLE', 'WHEN', 'THEN',
	'ELSE', 'END', 'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'RLIKE', 'BETWEEN', 'ASC', 'DESC', 'NULLS', 'OVER', 'SELECT', 'WITH', 'SET', 'VALUES',
	'INTO', 'ASOF', 'MATCH_CONDITION', 'CONNECT', 'START', 'ESCAPE', 'RETURNING', 'REGEXP'
]);
const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'EXCEPT', 'MINUS', 'INTERSECT', 'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'ON', 'JOIN', 'QUALIFY', 'LIMIT', 'WITH', 'INTO', 'BY', 'USING', 'CROSS', 'INNER', 'NATURAL']);
const AGGREGATE_NAMES = new Set([
	'SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'MEDIAN', 'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP', 'VARIANCE_SAMP', 'VARIANCE_POP',
	'LISTAGG', 'ARRAY_AGG', 'COUNT_IF', 'SUM_IF', 'ANY_VALUE', 'APPROX_COUNT_DISTINCT', 'BOOLAND_AGG', 'BOOLOR_AGG', 'MODE', 'PERCENTILE_CONT', 'PERCENTILE_DISC',
	'GROUP_CONCAT', 'COUNT_DISTINCT', 'BITAND_AGG', 'BITOR_AGG', 'HASH_AGG', 'OBJECT_AGG', 'KURTOSIS', 'SKEW', 'CORR', 'COVAR_POP', 'COVAR_SAMP'
]);
export const AGGREGATES = AGGREGATE_NAMES;
const INTERVAL_UNIT = /^(YEARS?|QUARTERS?|MONTHS?|WEEKS?|DAYS?|HOURS?|MINUTES?|SECONDS?|MILLISECONDS?|MICROSECONDS?)$/;

export class ParseError extends SqlSyntaxError {}

/**
 * @param {import('./lexer.js').Token[]} tokens
 * @param {string} source
 * @param {{ formula?: boolean }} [opts]
 */
function parser(tokens, source, { formula = false } = {}) {
	let i = 0;
	const peek = (o = 0) => tokens[i + o];
	const isWord = (w, o = 0) => peek(o)?.t === 'word' && peek(o).u === w;
	const isOp = (v, o = 0) => peek(o)?.t === 'op' && peek(o).v === v;
	const fail = (msg) => {
		const tok = peek();
		throw new ParseError(tok ? `${msg} near "${source.slice(tok.s, tok.s + 40).replace(/\s+/g, ' ')}"` : `${msg} at end of statement`, tok?.s);
	};
	const take = () => {
		if (i >= tokens.length) fail('unexpected end');
		return tokens[i++];
	};
	const accept = (w) => (isWord(w) ? (i++, true) : false);
	const acceptOp = (v) => (isOp(v) ? (i++, true) : false);
	const expect = (w) => {
		if (!accept(w)) fail(`expected ${w}`);
	};
	const expectOp = (v) => {
		if (!acceptOp(v)) fail(`expected "${v}"`);
	};
	const isName = (tok) => tok && (tok.t === 'qid' || (tok.t === 'word' && !RESERVED.has(tok.u)));
	const ident = () => {
		const tok = peek();
		if (tok?.t === 'qid') {
			i++;
			return { name: tok.v, quoted: true };
		}
		if (tok?.t === 'word') {
			i++;
			return { name: tok.v, quoted: false };
		}
		return fail('expected an identifier');
	};
	const qualifiedName = () => {
		const parts = [ident()];
		while (isOp('.')) {
			if (isOp('.', 1)) {
				i++;
				parts.push({ name: '', quoted: false });
				continue;
			}
			if (peek(1)?.t !== 'word' && peek(1)?.t !== 'qid') break;
			i++;
			parts.push(ident());
		}
		return parts;
	};
	const identList = () => {
		expectOp('(');
		const out = [ident()];
		while (acceptOp(',')) out.push(ident());
		expectOp(')');
		return out;
	};
	const dataType = () => {
		const first = take();
		if (first.t !== 'word' && first.t !== 'qid') fail('expected a data type');
		let name = first.v.toUpperCase();
		if ((name === 'DOUBLE' && isWord('PRECISION')) || (name === 'CHARACTER' && isWord('VARYING'))) name += ` ${take().u}`;
		const args = [];
		if (acceptOp('(')) {
			while (!isOp(')')) {
				const tok = take();
				if (tok.v !== ',') args.push(tok.v);
			}
			expectOp(')');
		}
		if (/^TIMESTAMP|^TIME$/.test(name) && (isWord('WITH') || isWord('WITHOUT')) && isWord('TIME', 1)) {
			const w = take().u;
			take();
			expect('ZONE');
			name = w === 'WITH' ? 'TIMESTAMP_TZ' : 'TIMESTAMP_NTZ';
		}
		return { name, args };
	};

	/* Expressions */
	const exprList = () => {
		const out = [expr()];
		while (acceptOp(',')) out.push(expr());
		return out;
	};
	const orderItems = () => {
		const out = [];
		do {
			const e = expr();
			let desc = false;
			if (accept('DESC')) desc = true;
			else accept('ASC');
			let nulls;
			if (accept('NULLS')) nulls = accept('FIRST') ? 'FIRST' : (expect('LAST'), 'LAST');
			out.push({ e, desc, ...(nulls ? { nulls } : {}) });
		} while (acceptOp(','));
		return out;
	};
	const frameBound = () => {
		if (accept('UNBOUNDED')) return { kind: 'UNBOUNDED', dir: accept('PRECEDING') ? 'PRECEDING' : (expect('FOLLOWING'), 'FOLLOWING') };
		if (accept('CURRENT')) {
			expect('ROW');
			return { kind: 'CURRENT' };
		}
		const tok = take();
		if (tok.t !== 'num') fail('expected a frame bound');
		return { kind: 'OFFSET', n: Number(tok.v), dir: accept('PRECEDING') ? 'PRECEDING' : (expect('FOLLOWING'), 'FOLLOWING') };
	};
	const windowSpec = () => {
		if (!isOp('(')) return { ref: ident() };
		expectOp('(');
		const spec = { partition: [], order: [] };
		if (accept('PARTITION')) {
			expect('BY');
			spec.partition = exprList();
		}
		if (accept('ORDER')) {
			expect('BY');
			spec.order = orderItems();
		}
		if (isWord('ROWS') || isWord('RANGE')) {
			const unit = take().u;
			if (accept('BETWEEN')) {
				const start = frameBound();
				expect('AND');
				spec.frame = { unit, start, end: frameBound() };
			} else spec.frame = { unit, start: frameBound(), end: { kind: 'CURRENT' } };
		}
		expectOp(')');
		return spec;
	};
	const funcCall = (name) => {
		expectOp('(');
		const node = { k: 'fn', name: name.toUpperCase(), args: [], distinct: false };
		if (accept('DISTINCT')) node.distinct = true;
		else accept('ALL');
		if (isOp('*') && (isOp(')', 1) || isOp(',', 1))) {
			i++;
			node.star = true;
		} else if (!isOp(')')) {
			do {
				if (isName(peek()) && isOp('=>', 1)) {
					const key = take().v;
					i++;
					node.args.push({ ...expr(), named: key });
				} else node.args.push(expr());
			} while (acceptOp(','));
		}
		if (accept('IGNORE')) {
			expect('NULLS');
			node.ignoreNulls = true;
		} else if (accept('RESPECT')) expect('NULLS');
		if (accept('ORDER')) {
			expect('BY');
			node.argOrder = orderItems();
		}
		expectOp(')');
		if (accept('IGNORE')) {
			expect('NULLS');
			node.ignoreNulls = true;
		} else if (accept('RESPECT')) expect('NULLS');
		if (accept('WITHIN')) {
			expect('GROUP');
			expectOp('(');
			expect('ORDER');
			expect('BY');
			node.within = orderItems();
			expectOp(')');
		}
		if (accept('OVER')) node.over = windowSpec();
		return node;
	};
	const startsQuery = () => isWord('SELECT') || isWord('WITH') || (isOp('(') && startsQueryAt(1));
	const startsQueryAt = (o) => {
		let j = o;
		while (isOp('(', j)) j++;
		return isWord('SELECT', j) || isWord('WITH', j);
	};

	const primary = () => {
		const tok = peek();
		if (!tok) fail('unexpected end of expression');
		if (tok.t === 'num') {
			i++;
			return { k: 'num', v: tok.v };
		}
		if (tok.t === 'str') {
			i++;
			return { k: 'str', v: tok.v };
		}
		if (tok.t === 'var') {
			i++;
			return { k: 'var', name: tok.v };
		}
		if (tok.t === 'op') {
			if (tok.v === '(') {
				if (startsQueryAt(1)) {
					i++;
					const query = parseQuery();
					expectOp(')');
					return { k: 'subquery', query };
				}
				i++;
				const first = expr();
				if (acceptOp(',')) {
					const items = [first, ...exprList()];
					expectOp(')');
					return { k: 'tuple', items };
				}
				expectOp(')');
				return { k: 'paren', e: first };
			}
			if (tok.v === '-' || tok.v === '+') {
				i++;
				return { k: 'unary', op: tok.v, e: binary(7) };
			}
			if (tok.v === '*') {
				i++;
				return star();
			}
			if (tok.v === '?' || tok.v === ':') fail('uses a bind variable');
			fail(`unexpected "${tok.v}"`);
		}
		if (tok.t === 'word') {
			const u = tok.u;
			if (u === 'NULL') return (i++, { k: 'null' });
			if (u === 'TRUE' || u === 'FALSE') return (i++, { k: 'bool', v: u === 'TRUE' });
			if (u === 'NOT') {
				i++;
				return { k: 'unary', op: 'NOT', e: binary(3) };
			}
			if (u === 'EXISTS' && isOp('(', 1)) {
				i += 2;
				const query = parseQuery();
				expectOp(')');
				return { k: 'exists', query, not: false };
			}
			if (u === 'CASE') {
				i++;
				const node = { k: 'case', whens: [] };
				if (!isWord('WHEN')) node.base = expr();
				while (accept('WHEN')) {
					const w = expr();
					expect('THEN');
					node.whens.push([w, expr()]);
				}
				if (accept('ELSE')) node.else = expr();
				expect('END');
				return node;
			}
			if ((u === 'CAST' || u === 'TRY_CAST') && isOp('(', 1)) {
				i += 2;
				const e = expr();
				expect('AS');
				const type = dataType();
				expectOp(')');
				return { k: 'cast', e, type, try: u === 'TRY_CAST' };
			}
			if (u === 'EXTRACT' && isOp('(', 1)) {
				i += 2;
				const part = take().v.toUpperCase().replace(/^'|'$/g, '');
				expect('FROM');
				const e = expr();
				expectOp(')');
				return { k: 'fn', name: 'DATE_PART', args: [{ k: 'part', v: part }, e], distinct: false };
			}
			if (u === 'POSITION' && isOp('(', 1)) {
				const save = i;
				i += 2;
				const needle = binary(4);
				if (accept('IN')) {
					const hay = expr();
					expectOp(')');
					return { k: 'fn', name: 'POSITION', args: [needle, hay], distinct: false };
				}
				i = save;
			}
			if (u === 'INTERVAL' && peek(1)?.t === 'str') {
				i++;
				const value = take();
				const unit = peek()?.t === 'word' && !CLAUSE.has(peek().u) ? take().u : undefined;
				return { k: 'interval', value: value.v, unit };
			}
			if (u === 'INTERVAL' && peek(1) && (peek(1).t !== 'op' || peek(1).v === '(' || peek(1).v === '-') && !(peek(1).t === 'word' && (CLAUSE.has(peek(1).u) || RESERVED.has(peek(1).u)))) {
				const save = i;
				try {
					i++;
					const value = binary(4);
					if (peek()?.t === 'word' && INTERVAL_UNIT.test(peek().u)) return { k: 'interval', value, unit: take().u };
				} catch (err) {
					if (!(err instanceof SqlSyntaxError)) throw err;
				}
				i = save;
			}
			if (['DATE', 'TIMESTAMP', 'TIME', 'TIMESTAMP_NTZ', 'TIMESTAMP_LTZ', 'TIMESTAMP_TZ'].includes(u) && peek(1)?.t === 'str') {
				i++;
				return { k: 'typed', type: u, v: take().v };
			}
			if (['CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME', 'LOCALTIMESTAMP', 'LOCALTIME', 'SYSDATE', 'CURRENT_USER', 'CURRENT_ROLE'].includes(u) && !isOp('(', 1) && !isOp('.', 1)) {
				i++;
				return { k: 'fn', name: u, args: [], distinct: false, bare: true };
			}
		}
		if (tok.t === 'word' || tok.t === 'qid') {
			if (tok.t === 'word' && RESERVED.has(tok.u) && !((tok.u === 'LEFT' || tok.u === 'RIGHT') && isOp('(', 1))) fail(`unexpected ${tok.v}`);
			const start = i;
			const parts = qualifiedName();
			if (isOp('(') && parts.length <= 2) {
				const name = parts.map((p) => p.name).join('.');
				if (parts.length === 2 || parts[0].quoted) {
					i = start + parts.length * 2 - 1;
					const node = funcCall(name);
					node.qualified = true;
					return node;
				}
				return funcCall(name);
			}
			if (isOp('.') && isOp('*', 1)) {
				i += 2;
				return star(parts);
			}
			if (isOp(':') && !formula) fail('reads a semi-structured path (:), which t2d does not translate');
			if (isOp('[') && !formula) fail('reads an array element ([])');
			return { k: 'col', parts };
		}
		return fail(`unexpected ${tok.v}`);
	};
	const star = (qualifier) => {
		const node = { k: 'star', ...(qualifier ? { qualifier } : {}) };
		if (accept('EXCLUDE')) node.exclude = isOp('(') ? identList() : [ident()];
		const pairs = (valueFirst) => {
			const out = [];
			const one = () => {
				const value = valueFirst ? expr() : ident();
				expect('AS');
				out.push(valueFirst ? { e: value, name: ident() } : { from: value, name: ident() });
			};
			if (acceptOp('(')) {
				do one();
				while (acceptOp(','));
				expectOp(')');
			} else one();
			return out;
		};
		if (isWord('REPLACE') && isOp('(', 1)) {
			i++;
			node.replace = pairs(true);
		}
		if (accept('RENAME')) node.rename = pairs(false);
		if (isWord('ILIKE')) fail('uses SELECT * ILIKE');
		return node;
	};
	const COMPARE = new Set(['=', '==', '<>', '!=', '<', '>', '<=', '>=', '<=>']);
	const binary = (minPrec) => {
		const from = i;
		let left = primary();
		for (;;) {
			const tok = peek();
			if (!tok) break;
			if (tok.t === 'op' && tok.v === '::') {
				i++;
				left = { k: 'cast', e: left, type: dataType(), try: false };
				continue;
			}
			const u = tok.t === 'word' ? tok.u : tok.v;
			const notNext = u === 'NOT' && ['LIKE', 'ILIKE', 'IN', 'BETWEEN', 'RLIKE', 'REGEXP'].includes(peek(1)?.u);
			let prec;
			if (u === 'OR') prec = 1;
			else if (u === 'AND') prec = 2;
			else if ((tok.t === 'op' && COMPARE.has(u)) || ['LIKE', 'ILIKE', 'RLIKE', 'REGEXP', 'IN', 'BETWEEN', 'IS'].includes(u) || notNext) prec = 4;
			else if (tok.t === 'op' && (u === '+' || u === '-' || u === '||')) prec = 5;
			else if (tok.t === 'op' && (u === '*' || u === '/' || u === '%')) prec = 6;
			else break;
			if (prec <= minPrec) break;
			i++;
			if (u === 'IS') {
				const not = accept('NOT');
				if (accept('NULL')) left = { k: 'isnull', e: left, not };
				else if (accept('DISTINCT')) {
					expect('FROM');
					left = { k: 'isdistinct', l: left, r: binary(4), not };
				} else if (isWord('TRUE') || isWord('FALSE')) left = { k: 'isbool', e: left, v: take().u === 'TRUE', not };
				else fail('expected NULL, DISTINCT FROM, TRUE or FALSE after IS');
				continue;
			}
			let op = u;
			let not = false;
			if (u === 'NOT') {
				not = true;
				op = take().u;
			}
			if (op === 'LIKE' || op === 'ILIKE') {
				if (accept('ANY') || accept('ALL')) fail(`uses ${op} ANY/ALL`);
				const p = binary(4);
				const node = { k: 'like', e: left, p, not, ci: op === 'ILIKE' };
				if (accept('ESCAPE')) node.escape = take().v;
				left = node;
			} else if (op === 'RLIKE' || op === 'REGEXP') {
				left = { k: 'fn', name: 'RLIKE', args: [left, binary(4)], distinct: false, negate: not };
			} else if (op === 'IN') {
				expectOp('(');
				if (startsQuery()) {
					const query = parseQuery();
					expectOp(')');
					left = { k: 'in', e: left, query, not };
				} else {
					const items = exprList();
					expectOp(')');
					left = { k: 'in', e: left, items, not };
				}
			} else if (op === 'BETWEEN') {
				const lo = binary(4);
				expect('AND');
				left = { k: 'between', e: left, lo, hi: binary(4), not };
			} else {
				if ((op === '=' || COMPARE.has(op)) && (isWord('ANY') || isWord('ALL') || isWord('SOME')) && isOp('(', 1)) fail(`compares with ${peek().u} (subquery)`);
				left = { k: 'bin', op: op === '==' ? '=' : op === '!=' ? '<>' : op, l: left, r: binary(prec) };
			}
		}
		void from;
		return left;
	};
	const expr = () => binary(0);

	/* Queries */
	const alias = (allowColumns = true) => {
		let a;
		if (accept('AS')) a = ident();
		else if (peek()?.t === 'qid' || (peek()?.t === 'word' && !CLAUSE.has(peek().u) && !RESERVED.has(peek().u))) a = ident();
		if (!a) return {};
		const columns = allowColumns && isOp('(') && (peek(1)?.t === 'word' || peek(1)?.t === 'qid') && (isOp(',', 2) || isOp(')', 2)) ? identList() : undefined;
		return { alias: a, ...(columns ? { columns } : {}) };
	};
	const valuesRows = () => {
		const rows = [];
		do {
			expectOp('(');
			rows.push(exprList());
			expectOp(')');
		} while (acceptOp(','));
		return rows;
	};
	const fromPrimary = () => {
		if (accept('LATERAL')) fail('uses LATERAL');
		if (isOp('(')) {
			if (startsQueryAt(1)) {
				i++;
				const query = parseQuery();
				expectOp(')');
				return wrapPivot({ k: 'derived', query, ...alias() });
			}
			if (isWord('VALUES', 1)) {
				i += 2;
				const rows = valuesRows();
				expectOp(')');
				return wrapPivot({ k: 'values', rows, ...alias() });
			}
			i++;
			const inner = fromItem();
			expectOp(')');
			return wrapPivot(inner);
		}
		if (accept('VALUES')) return wrapPivot({ k: 'values', rows: valuesRows(), ...alias() });
		if (isWord('TABLE') && isOp('(', 1)) fail('uses a table function');
		const parts = qualifiedName();
		if (isOp('(')) fail(`uses the table function ${parts.map((p) => p.name).join('.')}`);
		if (isWord('AT') || isWord('BEFORE') || isWord('CHANGES')) fail('uses time travel (AT/BEFORE/CHANGES)');
		if (isWord('SAMPLE') || isWord('TABLESAMPLE')) fail('uses SAMPLE');
		return wrapPivot({ k: 'table', parts, ...alias() });
	};
	const wrapPivot = (source) => {
		if (accept('PIVOT')) {
			expectOp('(');
			const agg = expr();
			expect('FOR');
			const column = primary();
			expect('IN');
			expectOp('(');
			if (isWord('ANY') || isWord('SELECT')) fail('uses a dynamic PIVOT (ANY or subquery)');
			const values = exprList();
			expectOp(')');
			if (accept('DEFAULT')) fail('uses PIVOT ... DEFAULT ON NULL');
			expectOp(')');
			return wrapPivot({ k: 'pivot', source, agg, column, values, ...alias() });
		}
		if (accept('UNPIVOT')) {
			let includeNulls = false;
			if (accept('INCLUDE')) {
				expect('NULLS');
				includeNulls = true;
			} else if (accept('EXCLUDE')) expect('NULLS');
			expectOp('(');
			const value = ident();
			expect('FOR');
			const name = ident();
			expect('IN');
			const columns = identList();
			expectOp(')');
			return wrapPivot({ k: 'unpivot', source, value, name, columns, includeNulls, ...alias(false) });
		}
		return source;
	};
	const fromItem = () => {
		let left = fromPrimary();
		for (;;) {
			let type;
			let natural = false;
			if (accept('NATURAL')) natural = true;
			if (accept('JOIN')) type = 'INNER';
			else if (isWord('INNER') && isWord('JOIN', 1)) (i += 2), (type = 'INNER');
			else if (isWord('CROSS') && isWord('JOIN', 1)) (i += 2), (type = 'CROSS');
			else if (['LEFT', 'RIGHT', 'FULL'].includes(peek()?.u) && peek()?.t === 'word' && (isWord('JOIN', 1) || (isWord('OUTER', 1) && isWord('JOIN', 2)))) {
				type = take().u;
				accept('OUTER');
				take();
			} else if (isWord('ASOF')) fail('uses ASOF JOIN');
			else if (natural) fail('expected JOIN after NATURAL');
			else break;
			if (isWord('LATERAL')) fail('uses LATERAL');
			const right = fromPrimary();
			const node = { k: 'join', type, l: left, r: right, ...(natural ? { natural } : {}) };
			if (accept('ON')) node.on = expr();
			else if (accept('USING')) node.using = identList();
			left = node;
		}
		return left;
	};
	const fromClause = () => {
		let item = fromItem();
		while (acceptOp(',')) item = { k: 'join', type: 'CROSS', l: item, r: fromItem(), comma: true };
		return item;
	};
	const selectItem = () => {
		const e = expr();
		if (e.k === 'star') return { e };
		let a;
		if (accept('AS')) a = isOp('(') ? fail('uses a multi-column alias') : peek()?.t === 'str' ? { name: take().v, quoted: true } : ident();
		else if (peek()?.t === 'qid' || (peek()?.t === 'word' && !CLAUSE.has(peek().u) && !RESERVED.has(peek().u))) a = ident();
		return a ? { e, alias: a } : { e };
	};
	const selectBody = () => {
		expect('SELECT');
		const node = { k: 'select', distinct: false, items: [] };
		if (accept('DISTINCT')) node.distinct = true;
		else accept('ALL');
		if (accept('TOP')) {
			const n = take();
			if (n.t !== 'num') fail('expected a number after TOP');
			node.top = Number(n.v);
		}
		// Snowflake accepts a trailing comma at the end of the select list.
		do node.items.push(selectItem());
		while (acceptOp(',') && !(isWord('FROM') || isOp(')') || !peek()));
		if (accept('INTO')) fail('uses SELECT ... INTO');
		if (accept('FROM')) node.from = fromClause();
		if (accept('WHERE')) node.where = expr();
		if (accept('CONNECT') || accept('START')) fail('uses CONNECT BY');
		if (accept('GROUP')) {
			expect('BY');
			if (isWord('ROLLUP') || isWord('CUBE') || isWord('GROUPING')) fail(`uses GROUP BY ${peek().u}`);
			if (accept('ALL')) node.groupAll = true;
			else node.groupBy = exprList();
		}
		if (accept('HAVING')) node.having = expr();
		if (accept('QUALIFY')) node.qualify = expr();
		if (accept('WINDOW')) fail('uses a named WINDOW clause');
		return node;
	};
	const queryTerm = () => {
		if (isWord('SELECT')) return selectBody();
		if (accept('VALUES')) return { k: 'values', rows: valuesRows() };
		if (isOp('(')) {
			i++;
			const query = parseQuery();
			expectOp(')');
			return { k: 'nested', query };
		}
		return fail('expected SELECT');
	};
	const setOp = () => {
		if (isWord('UNION')) return 'UNION';
		if (isWord('EXCEPT') || isWord('MINUS')) return 'EXCEPT';
		if (isWord('INTERSECT')) return 'INTERSECT';
		return null;
	};
	const queryExpr = (minPrec = 0) => {
		let left = queryTerm();
		for (;;) {
			const op = setOp();
			if (!op) break;
			const prec = op === 'INTERSECT' ? 2 : 1;
			if (prec <= minPrec) break;
			i++;
			let all = false;
			if (accept('ALL')) all = true;
			else accept('DISTINCT');
			const byName = isWord('BY') && isWord('NAME', 1) ? ((i += 2), true) : false;
			left = { k: 'setop', op, all, l: left, r: queryExpr(prec), ...(byName ? { byName } : {}) };
		}
		return left;
	};
	const parseQuery = () => {
		const node = { k: 'query', with: [], body: null, orderBy: [] };
		if (accept('WITH')) {
			if (accept('RECURSIVE')) fail('uses a recursive CTE');
			do {
				const name = ident();
				const columns = isOp('(') ? identList() : undefined;
				expect('AS');
				expectOp('(');
				const query = parseQuery();
				expectOp(')');
				node.with.push({ name, ...(columns ? { columns } : {}), query });
			} while (acceptOp(','));
		}
		node.body = queryExpr();
		if (accept('ORDER')) {
			expect('BY');
			node.orderBy = orderItems();
		}
		if (accept('LIMIT')) {
			node.limit = expr();
			if (accept('OFFSET')) node.offset = expr();
		} else if (accept('OFFSET')) {
			node.offset = expr();
			accept('ROWS') || accept('ROW');
			if (accept('FETCH')) {
				accept('FIRST') || accept('NEXT');
				node.limit = expr();
				accept('ROWS') || accept('ROW');
				expect('ONLY');
			}
		} else if (accept('FETCH')) {
			accept('FIRST') || accept('NEXT');
			node.limit = expr();
			accept('ROWS') || accept('ROW');
			expect('ONLY');
		}
		return node;
	};

	/* Statements */
	const columnDefs = () => {
		expectOp('(');
		const cols = [];
		do {
			if (isWord('PRIMARY') || isWord('CONSTRAINT') || isWord('UNIQUE') || isWord('FOREIGN')) {
				let depth = 0;
				while (i < tokens.length && !(depth === 0 && (isOp(',') || isOp(')')))) {
					if (isOp('(')) depth++;
					if (isOp(')')) depth--;
					i++;
				}
				continue;
			}
			const name = ident();
			const type = isOp(',') || isOp(')') ? undefined : dataType();
			while (!isOp(',') && !isOp(')') && i < tokens.length) {
				if (isOp('(')) {
					let depth = 0;
					do {
						if (isOp('(')) depth++;
						if (isOp(')')) depth--;
						i++;
					} while (depth > 0 && i < tokens.length);
				} else i++;
			}
			cols.push({ name, ...(type ? { type } : {}) });
		} while (acceptOp(','));
		expectOp(')');
		return cols;
	};
	const rest = () => tokens.slice(i);
	const statement = () => {
		const head = peek();
		if (!head) return { kind: 'ignored', reason: 'empty' };
		const u = head.u;
		if (u === 'SELECT' || u === 'WITH' || (head.v === '(' && startsQueryAt(0))) return { kind: 'query', query: parseQuery() };
		if (u === 'USE') {
			i++;
			const explicit = ['DATABASE', 'SCHEMA', 'WAREHOUSE', 'ROLE', 'SECONDARY'].includes(peek()?.u) ? take().u : undefined;
			if (explicit === 'SECONDARY') return (i = tokens.length), { kind: 'use', target: 'SECONDARY ROLES' };
			const parts = qualifiedName();
			return { kind: 'use', target: explicit ?? (parts.length > 1 ? 'SCHEMA' : 'DATABASE'), parts };
		}
		if (u === 'ALTER') {
			i++;
			if (accept('SESSION')) {
				if (accept('UNSET')) return { kind: 'session', unset: true, option: take().u };
				expect('SET');
				const options = [];
				do {
					const option = take().u;
					acceptOp('=');
					const value = take();
					// Tableau fills in placeholders such as [WorkbookName][TableauApp] at connect time, so the tag can be any text.
					if (option === 'QUERY_TAG') while (i < tokens.length && !(isOp(',') && peek(1)?.t === 'word' && isOp('=', 2))) i++;
					options.push({ option, value: value.v, valueType: value.t });
				} while (acceptOp(',') || (peek()?.t === 'word' && isOp('=', 1)));
				return { kind: 'session', options };
			}
			if (accept('USER') || accept('ACCOUNT') || accept('WAREHOUSE')) return (i = tokens.length), { kind: 'ignored', reason: `ALTER ${tokens[1].u} does not change the data` };
			if (accept('TABLE')) {
				accept('IF') && expect('EXISTS');
				const name = qualifiedName();
				if (accept('ALTER') || accept('MODIFY')) {
					accept('COLUMN');
					const changes = [];
					do {
						accept('COLUMN');
						const column = ident();
						if (accept('SET')) {
							if (accept('DATA')) expect('TYPE');
							else if (accept('NOT') || accept('DEFAULT') || accept('MASKING') || accept('COMMENT')) return (i = tokens.length), { kind: 'alter-table', name, action: 'noop', column };
							else expect('TYPE');
						} else if (accept('DROP') || accept('COMMENT')) return (i = tokens.length), { kind: 'alter-table', name, action: 'noop', column };
						else accept('TYPE');
						changes.push({ column, type: dataType() });
					} while (acceptOp(','));
					return { kind: 'alter-table', name, action: 'type', changes };
				}
				if (accept('ADD')) {
					accept('COLUMN');
					if (accept('IF')) (expect('NOT'), expect('EXISTS'));
					const columns = [];
					do {
						accept('COLUMN');
						const column = ident();
						const type = dataType();
						let def;
						if (accept('DEFAULT')) def = expr();
						while (i < tokens.length && !isOp(',')) i++;
						columns.push({ name: column, type, ...(def ? { default: def } : {}) });
					} while (acceptOp(','));
					return { kind: 'alter-table', name, action: 'add', columns };
				}
				if (accept('DROP')) {
					accept('COLUMN');
					if (accept('IF')) expect('EXISTS');
					const columns = [ident()];
					while (acceptOp(',')) columns.push(ident());
					return { kind: 'alter-table', name, action: 'drop', columns };
				}
				if (accept('RENAME')) {
					if (accept('COLUMN')) {
						const from = ident();
						expect('TO');
						return { kind: 'alter-table', name, action: 'rename-column', from, to: ident() };
					}
					expect('TO');
					return { kind: 'alter-table', name, action: 'rename', to: qualifiedName() };
				}
				return { kind: 'unknown', reason: 'this ALTER TABLE form is not translated' };
			}
			return { kind: 'unknown', reason: `ALTER ${peek()?.v ?? ''} is not translated` };
		}
		if (u === 'SET') {
			i++;
			if (isOp('(')) {
				const names = identList();
				expectOp('=');
				expectOp('(');
				const values = exprList();
				expectOp(')');
				if (names.length !== values.length) fail('SET has a different number of names and values');
				return { kind: 'set', vars: names.map((n, k) => ({ name: n.name, e: values[k] })) };
			}
			const name = ident();
			expectOp('=');
			return { kind: 'set', vars: [{ name: name.name, e: expr() }] };
		}
		if (u === 'UNSET') {
			i++;
			const names = isOp('(') ? identList() : [ident()];
			return { kind: 'unset', names: names.map((n) => n.name) };
		}
		if (['BEGIN', 'COMMIT', 'ROLLBACK', 'START'].includes(u)) return (i = tokens.length), { kind: 'ignored', reason: 'transaction control' };
		if (u === 'SHOW' || u === 'DESCRIBE' || u === 'DESC' || u === 'LIST' || u === 'GRANT' || u === 'REVOKE') return (i = tokens.length), { kind: 'ignored', reason: `${u} does not change the data` };
		if (u === 'DROP') {
			i++;
			const objectType = take().u;
			if (objectType === 'TEMPORARY' || objectType === 'TEMP' || objectType === 'TRANSIENT') return { kind: 'unknown', reason: 'unexpected DROP form' };
			const ifExists = accept('IF') ? (expect('EXISTS'), true) : false;
			const name = qualifiedName();
			accept('CASCADE') || accept('RESTRICT');
			return { kind: 'drop', objectType, ifExists, name };
		}
		if (u === 'TRUNCATE') {
			i++;
			accept('TABLE');
			if (accept('IF')) expect('EXISTS');
			return { kind: 'truncate', name: qualifiedName() };
		}
		if (u === 'CREATE') {
			i++;
			const replace = accept('OR') ? (expect('REPLACE'), true) : false;
			accept('LOCAL') || accept('GLOBAL');
			let temp = false;
			let transient = false;
			if (accept('TEMP') || accept('TEMPORARY') || accept('VOLATILE')) temp = true;
			else if (accept('TRANSIENT')) transient = true;
			const objectType = take().u;
			if (objectType !== 'TABLE' && objectType !== 'VIEW') return (i = tokens.length), { kind: 'unknown', reason: `CREATE ${objectType} is not translated` };
			const ifNotExists = accept('IF') ? (expect('NOT'), expect('EXISTS'), true) : false;
			const name = qualifiedName();
			const node = { kind: 'create', objectType, replace, temp, transient, ifNotExists, name };
			if (accept('CLONE')) return { ...node, clone: qualifiedName() };
			if (accept('LIKE')) return { ...node, like: qualifiedName() };
			if (isOp('(') && !startsQueryAt(1)) {
				if (objectType === 'VIEW') node.viewColumns = identList();
				else node.columns = columnDefs();
			}
			while (i < tokens.length && !isWord('AS') && !isOp('(') && !isWord('SELECT') && !isWord('WITH')) {
				if (isWord('CLUSTER') || isWord('COMMENT') || isWord('COPY') || isWord('DATA_RETENTION_TIME_IN_DAYS') || isWord('CHANGE_TRACKING')) i++;
				else if (peek().t === 'op' && peek().v === '=') i++;
				else i++;
			}
			if (accept('AS') || isWord('SELECT') || isWord('WITH') || isOp('(')) {
				if (isOp('(') && !startsQueryAt(0)) fail('expected a query after AS');
				node.query = parseQuery();
			}
			return node;
		}
		if (u === 'INSERT') {
			i++;
			const overwrite = accept('OVERWRITE');
			if (accept('ALL') || accept('FIRST')) fail('uses a multi-table INSERT');
			expect('INTO');
			const name = qualifiedName();
			const columns = isOp('(') && !startsQueryAt(0) ? identList() : undefined;
			const node = { kind: 'insert', name, overwrite, ...(columns ? { columns } : {}) };
			if (accept('VALUES')) node.values = valuesRows();
			else node.query = parseQuery();
			return node;
		}
		if (u === 'UPDATE') {
			i++;
			const name = qualifiedName();
			const a = alias(false);
			expect('SET');
			const sets = [];
			do {
				const target = qualifiedName();
				expectOp('=');
				sets.push({ column: target.at(-1), qualifier: target.length > 1 ? target.slice(0, -1) : undefined, e: expr() });
			} while (acceptOp(','));
			const node = { kind: 'update', name, ...(a.alias ? { alias: a.alias } : {}), sets };
			if (accept('FROM')) node.from = fromClause();
			if (accept('WHERE')) node.where = expr();
			return node;
		}
		if (u === 'DELETE') {
			i++;
			expect('FROM');
			const name = qualifiedName();
			const a = alias(false);
			const node = { kind: 'delete', name, ...(a.alias ? { alias: a.alias } : {}) };
			if (accept('USING')) node.using = fromClause();
			if (accept('WHERE')) node.where = expr();
			return node;
		}
		if (u === 'MERGE') {
			i++;
			expect('INTO');
			const name = qualifiedName();
			const a = alias(false);
			expect('USING');
			const source = fromPrimary();
			expect('ON');
			const on = expr();
			const clauses = [];
			while (accept('WHEN')) {
				const matched = !accept('NOT');
				expect('MATCHED');
				let cond;
				if (accept('AND')) cond = expr();
				expect('THEN');
				if (accept('UPDATE')) {
					expect('SET');
					const sets = [];
					do {
						const target = qualifiedName();
						expectOp('=');
						sets.push({ column: target.at(-1), e: expr() });
					} while (acceptOp(','));
					clauses.push({ matched, cond, action: 'update', sets });
				} else if (accept('DELETE')) clauses.push({ matched, cond, action: 'delete' });
				else {
					expect('INSERT');
					const columns = isOp('(') ? identList() : undefined;
					expect('VALUES');
					expectOp('(');
					const values = exprList();
					expectOp(')');
					clauses.push({ matched, cond, action: 'insert', columns, values });
				}
			}
			return { kind: 'merge', name, ...(a.alias ? { alias: a.alias } : {}), source, on, clauses };
		}
		if (u === 'CALL' || u === 'EXECUTE' || u === 'EXEC' || u === 'DECLARE' || u === 'IF' || u === 'FOR' || u === 'WHILE' || u === 'LET' || u === 'RETURN') {
			return (i = tokens.length), { kind: 'unknown', reason: `${u} (Snowflake Scripting / procedures) is not translated` };
		}
		return (i = tokens.length), { kind: 'unknown', reason: `${head.v} statements are not translated` };
	};

	return {
		statement,
		query: parseQuery,
		expr,
		dataType,
		done: () => i >= tokens.length,
		rest,
		fail
	};
}

/**
 * Parse one statement's tokens.
 * @param {import('./lexer.js').ScriptStatement} st
 * @param {string} source  The full script (for messages)
 * @returns {Statement}
 */
export function parseStatement(st, source) {
	const p = parser(st.tokens, source);
	const base = { index: st.index, start: st.start, end: st.end, text: st.text };
	try {
		const node = p.statement();
		if (!p.done()) p.fail('unexpected text after the statement');
		return { ...node, ...base };
	} catch (err) {
		if (err instanceof SqlSyntaxError) return { kind: 'error', reason: err.message, ...base };
		throw err;
	}
}

/**
 * @param {string} sql  A Snowflake script (statements separated by semicolons)
 * @returns {Statement[]}
 */
export function parseScript(sql) {
	return splitScript(sql).map((st) => parseStatement(st, sql));
}

/**
 * Parse a single query. Throws ParseError.
 * @param {string} sql
 * @returns {Query}
 */
export function parseQuery(sql) {
	const tokens = tokenize(sql).filter((t, k, all) => !(t.t === 'op' && t.v === ';' && k === all.length - 1));
	const p = parser(tokens, sql);
	const q = p.query();
	if (!p.done()) p.fail('unexpected text after the query');
	return q;
}

/**
 * Parse an expression. With `formula`, parse Magic ETL formula syntax (backtick columns, no backslash escapes,
 * INTERVAL <expr> <unit>). Throws ParseError.
 * @param {string} text
 * @param {{ formula?: boolean }} [opts]
 * @returns {Expr}
 */
export function parseExpr(text, { formula = false } = {}) {
	const tokens = tokenize(text, { backslashEscapes: !formula });
	const p = parser(tokens, text, { formula });
	const e = p.expr();
	if (!p.done()) p.fail('unexpected text after the expression');
	return e;
}

/** Snowflake's stored name for an identifier: unquoted names fold to upper case. */
export function canonical(id) {
	return id.quoted ? id.name : id.name.toUpperCase();
}

/** Visit every expression node (not descending into subqueries unless `subqueries`). */
export function walkExpr(node, fn, { subqueries = false } = {}) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const n of node) walkExpr(n, fn, { subqueries });
		return;
	}
	if (!node.k) return;
	if (fn(node) === false) return;
	for (const [key, v] of Object.entries(node)) {
		if (key === 'query' && !subqueries) continue;
		if (key === 'parts' || key === 'type' || key === 'qualifier' || key === 'exclude') continue;
		if (key === 'over' && v) {
			walkExpr(v.partition, fn, { subqueries });
			walkExpr(v.order?.map((o) => o.e), fn, { subqueries });
			continue;
		}
		if (key === 'within' || key === 'argOrder') {
			walkExpr(v?.map((o) => o.e), fn, { subqueries });
			continue;
		}
		if (key === 'whens') {
			for (const [w, t] of v) {
				walkExpr(w, fn, { subqueries });
				walkExpr(t, fn, { subqueries });
			}
			continue;
		}
		if (v && typeof v === 'object') walkExpr(v, fn, { subqueries });
	}
}

/** True when the expression calls an aggregate outside any window (OVER). */
export function hasAggregate(e) {
	let found = false;
	walkExpr(e, (n) => {
		if (n.k === 'fn' && n.over) return false;
		if (n.k === 'fn' && AGGREGATE_NAMES.has(n.name)) found = true;
		return undefined;
	});
	return found;
}

/** True when the expression has a window function call. */
export function hasWindow(e) {
	let found = false;
	walkExpr(e, (n) => {
		if (n.k === 'fn' && n.over) found = true;
	});
	return found;
}
