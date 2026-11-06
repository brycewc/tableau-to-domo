import { bmColumn, stripBrackets } from '../../model/naming.js';
import { CalcSyntaxError } from './errors.js';
import { parseFormula } from './parser.js';
import { bracket } from './lexer.js';
import { parseDateLiteral } from './dates.js';
import { FUNCTIONS, KNOWN_FUNCTIONS } from './functions.js';
import { emitTableCalc } from './tablecalc.js';
import { classifyFunction, ETL_ONLY_FUNCTIONS } from './catalog.js';
import { TRUE_VALUES } from '../schema.js';
import { PREC, NULL_VALUE, wrap, fn, quoteString, isNumeric, isDateType, unifyTypes, normalizeType, toDomoType, ignoresCase } from './sql.js';

/**
 * @typedef {import('../../model/types.js').ConvertOptions} ConvertOptions
 * @typedef {import('../../model/types.js').Issue} Issue
 * @typedef {import('../../model/types.js').DomoColumnType} DomoColumnType
 *
 * @typedef {{ kind: 'column', column: string, datatype?: string, domoType?: DomoColumnType, rawBoolean?: boolean, ignoreCase?: boolean }
 *   | { kind: 'calc', field: import('../../model/types.js').FieldIR }
 *   | { kind: 'parameter', parameter: import('../../model/types.js').ParameterIR }} ResolvedField
 *
 * @typedef {Object} CalcContext
 * @property {(id: string) => ResolvedField|undefined} [resolveField]  id is the bracketed field id as written ('[Sales]', '[ds].[Sales]', '[Parameters].[P1]')
 * @property {ConvertOptions} [options]
 * @property {string[]} [contextFilterColumns]  Domo columns of Tableau context filters (FIXED FILTER ALLOW)
 * @property {string} [datasourceId]            Datasource the calc belongs to; other qualifiers are blends
 * @property {import('../../model/types.js').FieldIR} [field]  The calc being translated (cycle seed, type fallback, issue object)
 * @property {string} [name]                    Display name for issues when `field` is absent
 * @property {'measure'|'dimension'} [role]     How the calc is used; a row-level LOD used as a dimension is unsupported
 * @property {string} [outerAggregation]        Pill aggregation (SUM, AVG, ... or Tableau derivation) wrapped around a bare LOD
 * @property {{ partitionBy?: (string|{column?: string, expression?: string})[], orderBy?: (string|{column?: string, expression?: string, direction?: 'ASC'|'DESC'})[], issues?: Issue[] }} [tableCalc]
 *   Window addressing from the worksheet (tablecalc.js tableCalcAddressing); `issues` are reported with the translation
 * @property {(parameter: import('../../model/types.js').ParameterIR) => string} [parameterReference]  options.parameters === 'variables'
 * @property {string} [weekStart]               Datasource start of week (default 'sunday')
 * @property {(node: Object) => { column: string, datatype?: string, domoType?: DomoColumnType, rawBoolean?: boolean }|undefined} [lodColumn]
 *   An LOD node computed in Magic ETL: it is read as that column instead of being translated
 * @property {(node: Object) => { column: string, datatype?: string }|undefined} [tableCalcColumn]
 *   A table calc Call node computed in Magic ETL at a worksheet grain: it is read as MAX of that column
 * @property {boolean} [allowAggregates]         'etl' mode: aggregations are allowed (Group By field expressions)
 *
 * @typedef {Object} CalcTranslation
 * @property {string} expression
 * @property {boolean} aggregated
 * @property {DomoColumnType} dataType
 * @property {'ok'|'approximate'|'unsupported'} status
 * @property {string[]} features              'fixed' | 'window'
 * @property {Issue[]} issues
 * @property {string} [lodExpression]         Bare LOD without the default SUM, set when the outer aggregation was unknown
 */

const DEFAULT_OPTIONS = { useFixed: true, useWindowFunctions: false, parameters: 'inline' };
const STATUS_RANK = { ok: 0, approximate: 1, unsupported: 2 };
const SEVERITY_STATUS = { info: 'ok', warning: 'approximate', error: 'unsupported' };
const OUTER_AGGREGATIONS = {
	SUM: 'SUM',
	AVG: 'AVG',
	AVERAGE: 'AVG',
	MIN: 'MIN',
	MAX: 'MAX',
	COUNT: 'COUNT',
	CNT: 'COUNT',
	COUNTD: 'COUNTD',
	CTD: 'COUNTD',
	MEDIAN: 'MEDIAN',
	MDN: 'MEDIAN',
	ATTR: 'MIN',
	ATTRIBUTE: 'MIN',
	STDEV: 'STDDEV',
	STDEVP: 'STDDEV_POP',
	VAR: 'VAR',
	VARP: 'VAR_POP'
};
const PDP_SUGGESTION = 'Recreate the row-level security as Domo PDP policies on the dataset';
const ETL_LOD_SUGGESTION = 'Precompute it in Magic ETL: Group By the LOD dimensions, then Join the result back to the dataset as a column';
const ETL_FORMULA_SUGGESTION = 'Compute it as a column in a Magic ETL formula tile (convert materializes row-level uses unless --no-materialize)';
const ETL_AGGREGATES = { VAR: 'VARIANCE_SAMP', VAR_POP: 'VARIANCE_POP', STDDEV: 'STDDEV_SAMP' };
export const MAX_EXPRESSION_BYTES = 4 * 1024 * 1024;
export const LARGE_EXPRESSION_BYTES = 64 * 1024;
/** Magic ETL spellings of functions whose Beast Mode SQL its formula tiles reject. */
const ETL_FUNCTIONS = {
	MAKEDATETIME(c, em) {
		em.arity(c, 2, 2);
		const [d, t] = em.args(c);
		return em.out(`ADDTIME(TIMESTAMP(DATE(${d.sql})), TIME(${t.sql}))`, 'datetime');
	}
};
const SIZE_SUGGESTION = 'Compute the calculations it references as columns in Magic ETL (convert does this for reused row-level calcs unless --no-materialize)';

class ArityError extends Error {}

/** Translates one formula; handlers in functions.js and tablecalc.js call back into it. */
export class Emitter {
	/**
	 * @param {CalcContext} ctx
	 * @param {'beastmode'|'etl'} mode
	 */
	constructor(ctx, mode) {
		this.ctx = ctx || {};
		this.mode = mode;
		this.options = { ...DEFAULT_OPTIONS, ...(this.ctx.options || {}) };
		this.issues = [];
		this.features = new Set();
		this.status = 'ok';
		this.frames = [];
		this.env = { inAgg: false, fixed: null, lodDepth: 0 };
		this.calcStack = this.ctx.field?.id ? [this.ctx.field.id] : [];
		this.astCache = new Map();
		this.resolveCache = new Map();
	}

	issue(severity, code, message, suggestion) {
		if (this.issues.some((i) => i.code === code && i.message === message)) return;
		const entry = { severity, code, message };
		const name = this.ctx.field?.name ?? this.ctx.name;
		if (name) entry.object = { type: 'calculation', name, ...(this.ctx.field?.id ? { id: this.ctx.field.id } : {}) };
		if (suggestion) entry.suggestion = suggestion;
		this.issues.push(entry);
		const implied = SEVERITY_STATUS[severity];
		if (STATUS_RANK[implied] > STATUS_RANK[this.status]) this.status = implied;
	}

	feature(name) {
		this.features.add(name);
	}

	/** `constant` (string, number, boolean or null) marks a value known at translation time, for folding. */
	out(sql, type, prec = PREC.PRIMARY, flags, constant) {
		const r = flags ? { sql, type, prec, flags } : { sql, type, prec };
		if (constant !== undefined) r.constant = { value: constant };
		return r;
	}

	aggOut(sql, type, prec = PREC.PRIMARY) {
		return { sql, type, prec, flags: { agg: true } };
	}

	/** Aggregate call text, with the FIXED clause when it is the outermost aggregate inside an LOD body. */
	agg(name, inner) {
		if (this.mode === 'etl') {
			if (!this.ctx.allowAggregates) {
				this.issue('error', 'calc.row-level-only', 'Aggregations are not allowed in a Magic ETL formula', 'Use a Magic ETL Group By tile');
			} else if (this.env.inAgg) {
				this.issue('error', 'calc.etl-nested-aggregate', 'An aggregation inside another aggregation cannot run in a Magic ETL Group By');
			}
			return `${ETL_AGGREGATES[name] ?? name}(${inner})`;
		}
		const base = `${name}(${inner})`;
		return this.env.fixed && !this.env.inAgg ? `${base} FIXED ${this.env.fixed}` : base;
	}

	arity(c, min, max) {
		if (c.args.length < min || c.args.length > max) {
			const expected = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
			throw new ArityError(`${c.name} expects ${expected} argument(s), got ${c.args.length}`);
		}
	}

	arg(c, index, envPatch) {
		return this.emit(c.args[index], this.slotPatch(envPatch));
	}

	args(c, envPatch) {
		const patch = this.slotPatch(envPatch);
		return c.args.map((a) => this.emit(a, patch));
	}

	/** Marks the argument of the outermost aggregate in an LOD body, the only place Domo can run a nested FIXED. */
	slotPatch(envPatch) {
		return envPatch?.inAgg && this.env.fixed && !this.env.inAgg ? { ...envPatch, lodSlot: true } : envPatch;
	}

	/** Predicate form of `r` for WHEN, AND, OR and NOT; booleans are always emitted as predicates. */
	cond(r) {
		return r;
	}

	nullValue() {
		return this.out(NULL_VALUE, 'null', PREC.PRIMARY, undefined, null);
	}

	/** Boolean constant as a predicate: Beast Mode reads bare TRUE/FALSE as column names. */
	boolConst(value) {
		if (value === null) return { sql: NULL_VALUE, type: 'boolean', prec: PREC.PRIMARY, constant: { value: null } };
		return { sql: value ? '1 = 1' : '1 = 0', type: 'boolean', prec: PREC.CMP, constant: { value } };
	}

	/** A boolean whose natural form is a 'true'/'false' string expression. */
	boolFromValue(valueSql) {
		const sql = this.mode === 'beastmode' && this.heavyLeft(valueSql, "'true'") ? `'true' = ${valueSql}` : `${valueSql} = 'true'`;
		return { sql, type: 'boolean', prec: PREC.CMP, valueSql };
	}

	/**
	 * Beast Mode's parser re-scans a comparison's left operand for each condition form it tries, so a long one nested
	 * a few levels deep exceeds its 60 s parse limit (PARSING_ERROR); mirrored, the long side is scanned far less.
	 */
	heavyLeft(left, right) {
		if (this.mode !== 'beastmode') return /^CASE\b/i.test(left) && !/^CASE\b/i.test(right);
		return (/^CASE\b/i.test(left) && !/^CASE\b/i.test(right)) || (left.length >= HEAVY_OPERAND_CHARS && left.length > right.length);
	}

	/** Value form of `r`: booleans become 'true'/'false' strings (calc.boolean-as-string), other values pass through. */
	valueOf(r) {
		if (r.type !== 'boolean') return r;
		if (isConst(r)) return r.constant.value === null ? this.nullValue() : this.out(r.constant.value ? "'true'" : "'false'", 'string');
		if (r.valueSql) return this.out(r.valueSql, 'string');
		if (r.notNull === true) return this.out(`CASE WHEN ${r.sql} THEN 'true' ELSE 'false' END`, 'string');
		return this.out(`CASE WHEN ${r.sql} THEN 'true' WHEN ${r.notNull ?? this.not(r).sql} THEN 'false' END`, 'string');
	}

	/** `x IS NULL` (`IS NOT NULL` when `negated`), folded for constants; a boolean is tested in its value form. */
	isNull(x, negated = false) {
		if (isConst(x)) return this.boolConst((x.constant.value === null) !== negated);
		const v = wrap(this.valueOf(x), PREC.CMP + 1);
		const p = negated ? this.predicate(`${v} IS NOT NULL`, `${v} IS NULL`) : this.predicate(`${v} IS NULL`, `${v} IS NOT NULL`);
		p.notNull = true;
		return p;
	}

	/** A predicate that knows its own negation, e.g. `a > b` and `a <= b`. */
	predicate(sql, negated, prec = PREC.CMP, negatedPrec = PREC.CMP) {
		return { sql, type: 'boolean', prec, negated, negatedPrec };
	}

	not(r) {
		if (isConst(r)) return this.boolConst(r.constant.value === null ? null : !r.constant.value);
		// Beast Mode fails with PARSING_ERROR on NOT around a single <, >, <= or >= comparison, and on a parenthesis opening onto a long CASE.
		const p = r.negated ? this.predicate(r.negated, r.sql, r.negatedPrec ?? PREC.CMP, r.prec) : this.predicate(`NOT ${r.prec >= PREC.PRIMARY ? r.sql : `(${r.sql})`}`, r.sql, PREC.NOT, r.prec);
		if (r.notNull) p.notNull = r.notNull;
		return p;
	}

	/** `l op r` as a predicate, folded when both sides are constants; boolean operands compare as predicates or values. */
	compare(op, l, r) {
		if (isConst(l) && isConst(r)) {
			this.noteCaseOnly(l.constant.value, r.constant.value);
			const folded = compareConstants(op, l.constant.value, r.constant.value);
			if (folded !== undefined) return this.boolConst(folded);
		}
		if (l.type === 'boolean' || r.type === 'boolean') {
			if (op === '=' || op === '!=') {
				const pair = isBoolConst(r) ? [r.constant.value, l] : isBoolConst(l) ? [l.constant.value, r] : null;
				if (pair && pair[1].type === 'boolean') return pair[0] === (op === '=') ? pair[1] : this.not(pair[1]);
			}
			l = this.valueOf(l);
			r = this.valueOf(r);
		}
		if ((op === '=' || op === '!=') && (ignoresCase(l) || ignoresCase(r)) && l.type !== 'null' && r.type !== 'null') {
			l = this.caseless(l);
			r = this.caseless(r);
		}
		if (MIRRORED[op] && this.heavyLeft(l.sql, r.sql)) [l, r, op] = [r, l, MIRRORED[op]];
		const [a, b] = [wrap(l, PREC.CMP + 1), wrap(r, PREC.CMP + 1)];
		const p = FLIPPED[op] ? this.predicate(`${a} ${op} ${b}`, `${a} ${FLIPPED[op]} ${b}`) : this.out(`${a} ${op} ${b}`, 'boolean', PREC.CMP);
		if (op === '=' || op === '!=') p.operands = { op, l, r };
		return p;
	}

	/** `IF x = c THEN NULL ELSE x END` or `IF x != c THEN x END` (constant `c`) as `NULLIF(x, c)`: one copy of `x` to parse. */
	nullIf(kept, last) {
		if (this.mode !== 'beastmode' || kept.length !== 1) return undefined;
		const { c, t } = kept[0];
		const ops = c.operands;
		if (!ops || isConst(c)) return undefined;
		const isNullish = (x) => !x || (isConst(x) && x.constant.value === null);
		const [kept1, other] = ops.op === '=' ? [last, t] : [t, last];
		if (!kept1 || kept1.type === 'boolean' || !isNullish(other)) return undefined;
		const [x, k] = isConst(ops.r) ? [ops.l, ops.r] : isConst(ops.l) ? [ops.r, ops.l] : [];
		if (!x || isConst(x) || k.constant.value === null || x.sql !== kept1.sql) return undefined;
		return this.out(fn('NULLIF', x.sql, k.sql), kept1.type, PREC.PRIMARY, ignoresCase(kept1) ? { ignoreCase: true } : undefined);
	}

	noteCaseOnly(a, b) {
		if (!caseOnly(a, b)) return;
		this.issue(
			'info',
			'calc.case-sensitivity',
			`${quoteString(a)} and ${quoteString(b)} differ only in case; the comparison is left to Domo, which compares text case-sensitively`
		);
	}

	/**
	 * IF / CASE / IIF. Arms are thunks so dead branches are never emitted: a constant false or null condition drops its
	 * arm, and a constant true one ends the chain as its ELSE. Without `subject`, conditions are predicates.
	 * @param {{ cond: () => Object, then: () => Object }[]} arms
	 * @param {(() => Object)|null} otherwise
	 * @param {string} [subject]  simple CASE operand; its WHEN values are not folded
	 */
	conditional(arms, otherwise, subject) {
		const kept = [];
		let tail = otherwise;
		for (const arm of arms) {
			const c = arm.cond();
			if (!subject && isConst(c)) {
				if (c.constant.value !== true) continue;
				tail = arm.then;
				break;
			}
			kept.push({ c, t: arm.then() });
		}
		const last = tail ? tail() : null;
		if (!kept.length) return last ?? this.nullValue();
		if (!subject) {
			const folded = this.nullIf(kept, last);
			if (folded) return folded;
		}
		const thens = [...kept.map((k) => k.t), ...(last ? [last] : [])];
		const type = unifyTypes(thens.map((t) => t.type));
		const value = (t) => this.valueOf(t).sql;
		const whens = kept.map((k) => `WHEN ${k.c.sql} THEN ${value(k.t)}`).join(' ');
		const elseSql = last && !(isConst(last) && last.constant.value === null) ? ` ELSE ${value(last)}` : '';
		const sql = `CASE ${subject ? `${subject} ` : ''}${whens}${elseSql} END`;
		if (type === 'boolean') return this.boolFromValue(sql);
		return this.out(sql, type, PREC.PRIMARY, type === 'string' && thens.some(ignoresCase) ? { ignoreCase: true } : undefined);
	}

	/** Text compared ignoring case, as Tableau compares a field whose collation ignores case (Domo compares case-sensitively). */
	caseless(r) {
		if (isConst(r) && typeof r.constant.value === 'string') {
			const lower = r.constant.value.toLowerCase();
			return this.out(quoteString(lower), 'string', PREC.PRIMARY, undefined, lower);
		}
		return this.out(`LOWER(${r.sql})`, 'string', PREC.PRIMARY);
	}

	/** Literal value of argument `index` (string or number), or undefined. Inlined parameters count. */
	lit(c, index) {
		return this.literalValue(c.args[index]);
	}

	literalValue(node) {
		let n = node;
		while (n && n.type === 'Paren') n = n.expr;
		if (!n) return undefined;
		if (n.type === 'Literal' && (n.valueType === 'string' || n.valueType === 'number')) return n.value;
		if (n.type === 'Unary' && n.op === '-') {
			const v = this.literalValue(n.operand);
			return typeof v === 'number' ? -v : undefined;
		}
		if (n.type === 'Field' && this.options.parameters !== 'variables') {
			const res = this.resolve(n);
			if (res?.kind === 'parameter' && (typeof res.parameter.value === 'string' || typeof res.parameter.value === 'number')) {
				this.issue('info', 'calc.parameter-inlined', `Parameter '${res.parameter.name}' inlined with its current value ${JSON.stringify(res.parameter.value)}`);
				return res.parameter.value;
			}
		}
		return undefined;
	}

	generic(c) {
		const args = this.args(c);
		return this.out(fn(c.name, ...args.map((a) => a.sql)), 'unknown');
	}

	emit(node, envPatch) {
		const prevEnv = this.env;
		if (envPatch) this.env = { ...prevEnv, ...envPatch };
		if (this.env.lodSlot && !LOD_SLOT_PASSTHROUGH.has(node.type)) this.env = { ...this.env, lodSlot: false };
		const frame = [];
		this.frames.push(frame);
		let r;
		try {
			r = this.emitNode(node);
		} finally {
			this.frames.pop();
			this.env = prevEnv;
		}
		if (!r.flags) {
			r.flags = {};
			for (const kid of frame) {
				for (const [k, v] of Object.entries(kid.flags || {})) if (v && k !== 'ignoreCase') r.flags[k] = true;
			}
		}
		this.frames.at(-1)?.push(r);
		return r;
	}

	emitNode(node) {
		switch (node.type) {
			case 'Literal':
				return this.emitLiteral(node);
			case 'Field':
				return this.emitField(node);
			case 'Call':
				return this.emitCall(node);
			case 'Unary':
				return this.emitUnary(node);
			case 'Binary':
				return this.emitBinary(node);
			case 'In': {
				const x = this.valueOf(this.emit(node.expr));
				const items = node.list.map((item) => this.valueOf(this.emit(item)));
				if (isConst(x) && x.constant.value !== null && items.every((i) => isConst(i) && typeof i.constant.value === typeof x.constant.value)) {
					const found = items.some((i) => i.constant.value === x.constant.value);
					const unsure = !found && items.filter((i) => caseOnly(x.constant.value, i.constant.value));
					if (!unsure?.length) return this.boolConst(found !== node.negated);
					unsure.forEach((i) => this.noteCaseOnly(x.constant.value, i.constant.value));
				}
				const sql = `${wrap(x, PREC.CMP + 1)} ${node.negated ? 'NOT IN' : 'IN'} (${items.map((i) => i.sql).join(', ')})`;
				// With non-null constant items the result is null only for a null operand, so the value form need not repeat the list.
				if (items.every((i) => isConst(i) && i.constant.value !== null) && x.sql.length <= IN_VALUE_OPERAND_MAX) {
					return { sql, type: 'boolean', prec: PREC.CMP, notNull: `${wrap(x, PREC.CMP + 1)} IS NOT NULL` };
				}
				return this.out(sql, 'boolean', PREC.CMP);
			}
			case 'If':
				return this.conditional(
					node.branches.map((b) => ({ cond: () => this.cond(this.emit(b.cond)), then: () => this.emit(b.then) })),
					node.else ? () => this.emit(node.else) : null
				);
			case 'Case': {
				const otherwise = node.else ? () => this.emit(node.else) : null;
				const then = (w) => () => this.emit(w.then);
				if (!node.subject) return this.conditional(node.whens.map((w) => ({ cond: () => this.cond(this.emit(w.when)), then: then(w) })), otherwise);
				const s = this.emit(node.subject);
				// Beast Mode cannot parse a boolean CASE operand or WHEN value, and a constant operand should fold.
				if (s.type === 'boolean' || isConst(s)) {
					return this.conditional(node.whens.map((w) => ({ cond: () => this.compare('=', s, this.emit(w.when)), then: then(w) })), otherwise);
				}
				return this.conditional(node.whens.map((w) => ({ cond: () => this.emit(w.when), then: then(w) })), otherwise, s.sql);
			}
			case 'Lod':
				return this.emitLod(node);
			case 'Paren': {
				const inner = this.emit(node.expr);
				if (this.unwrapsPredicate(inner)) return { ...inner };
				return carry(this.out(`(${inner.sql})`, inner.type), inner);
			}
			default:
				throw new Error(`Unknown AST node ${node.type}`);
		}
	}

	emitLiteral(node) {
		switch (node.valueType) {
			case 'number': {
				const raw = node.raw.startsWith('.') ? `0${node.raw}` : node.raw;
				return this.out(raw.replace(/\.$/, ''), /^\d+$/.test(raw) ? 'integer' : 'real', PREC.PRIMARY, undefined, node.value);
			}
			case 'string':
				if (node.value.includes('\\')) {
					this.issue('info', 'calc.backslash-literal', 'String literal contains a backslash; check whether the target engine treats it as an escape');
				}
				return this.out(quoteString(node.value), 'string', PREC.PRIMARY, undefined, node.value);
			case 'boolean':
				return this.boolConst(node.value);
			case 'null':
				return this.nullValue();
			case 'date':
				return this.out(quoteString(node.value), 'date');
			case 'datetime':
				return this.out(`TIMESTAMP(${quoteString(node.value)})`, 'datetime');
			default:
				throw new Error(`Unknown literal ${node.valueType}`);
		}
	}

	resolveRaw(id) {
		if (this.ctx.resolveField) return this.ctx.resolveField(id);
		const parts = id.match(/\[(?:[^\]]|\]\])*\]/g) || [id];
		return { kind: 'column', column: stripBrackets(parts.at(-1)), datatype: 'unknown' };
	}

	/** @returns {ResolvedField|undefined|{ kind: 'blend' }} */
	resolve(node) {
		if (this.resolveCache.has(node.id)) return this.resolveCache.get(node.id);
		let res = this.resolveRaw(node.id);
		if (!res && node.parts.length === 2 && node.parts[0] !== 'Parameters') {
			const ds = this.ctx.datasourceId;
			const qualifier = node.parts[0];
			const sameSource = !ds || qualifier === ds || bracket(qualifier) === ds || qualifier === stripBrackets(ds);
			res = sameSource ? this.resolveRaw(bracket(node.parts[1])) : { kind: 'blend' };
		}
		this.resolveCache.set(node.id, res);
		return res;
	}

	emitField(node) {
		const res = this.resolve(node);
		const display = stripBrackets(bracket(node.parts.at(-1)));
		if (!res) {
			const isParam = node.parts.length === 2 && node.parts[0] === 'Parameters';
			this.issue('error', isParam ? 'calc.unknown-parameter' : 'calc.unknown-field', `Unresolved ${isParam ? 'parameter' : 'field'} reference ${node.id}`);
			return this.out(bmColumn(display), 'unknown', PREC.PRIMARY, { rowRef: true });
		}
		if (res.kind === 'blend') {
			this.issue(
				'error',
				'calc.blend',
				`${node.id} references another datasource (data blend)`,
				'Join or blend the datasources upstream with a Magic ETL join or a DataSet View, then reference the joined column'
			);
			return this.out(bmColumn(display), 'unknown', PREC.PRIMARY, { rowRef: true });
		}
		if (res.kind === 'column') return this.emitColumn(res);
		if (res.kind === 'parameter') return this.emitParameter(res.parameter);
		if (res.kind === 'calc') return this.emitCalcRef(res.field, node);
		throw new Error(`resolveField returned unknown kind '${res.kind}' for ${node.id}`);
	}

	emitColumn(res) {
		const sql = bmColumn(res.column);
		const type = normalizeType(res.datatype ?? res.domoType);
		if (type === 'boolean') {
			// Domo has no boolean column type: booleans arrive as 1/0 numbers or as text, which t2d uploads normalize to 'true'/'false'.
			const numeric = res.domoType === 'LONG' || res.domoType === 'DOUBLE' || res.domoType === 'DECIMAL';
			const predicate = numeric ? `${sql} = 1` : res.rawBoolean ? `LOWER(${sql}) IN (${TRUE_TEXT})` : `LOWER(${sql}) = 'true'`;
			return this.out(predicate, 'boolean', PREC.CMP, { rowRef: true });
		}
		return this.out(sql, type, PREC.PRIMARY, res.ignoreCase && type === 'string' ? { rowRef: true, ignoreCase: true } : { rowRef: true });
	}

	emitParameter(param) {
		const type = normalizeType(param.datatype);
		if (this.options.parameters === 'variables' && this.mode !== 'etl') {
			const sql = this.ctx.parameterReference ? this.ctx.parameterReference(param) : bmColumn(param.name);
			// Boolean parameters are planned as string variables ('true'/'false').
			if (type === 'boolean') return this.out(`LOWER(${sql}) = 'true'`, 'boolean', PREC.CMP);
			return this.out(sql, type, PREC.PRIMARY);
		}
		const sql = literalFor(param.value, type);
		this.issue('info', 'calc.parameter-inlined', `Parameter '${param.name}' inlined with its current value ${sql}`);
		if (type === 'boolean') return this.boolConst(sql === NULL_VALUE ? null : sql === "'true'");
		return this.out(sql, type === 'unknown' && typeof param.value === 'number' ? 'real' : type, /^-/.test(sql) ? PREC.UNARY : PREC.PRIMARY, undefined, parameterConstant(sql, type));
	}

	parseCalc(field) {
		const key = field.id ?? field.name;
		if (this.astCache.has(key)) return this.astCache.get(key);
		let ast = null;
		try {
			ast = parseFormula(field.formula ?? '');
		} catch (err) {
			if (!(err instanceof CalcSyntaxError)) throw err;
			this.issue('error', 'calc.syntax', `Referenced calculation '${field.name}' does not parse: ${err.message}`);
		}
		this.astCache.set(key, ast);
		return ast;
	}

	emitCalcRef(field, node) {
		const key = field.id ?? node.id;
		const fallbackType = normalizeType(field.datatype);
		if (!field.formula) {
			this.issue('error', 'calc.missing-formula', `Calculation '${field.name}' has no formula`);
			return this.out(bmColumn(field.name), fallbackType, PREC.PRIMARY, { rowRef: true });
		}
		if (this.calcStack.includes(key)) {
			this.issue('error', 'calc.cycle', `Circular calculation reference: ${[...this.calcStack, key].join(' -> ')}`);
			return this.out(bmColumn(field.name), fallbackType, PREC.PRIMARY, { rowRef: true });
		}
		const ast = this.parseCalc(field);
		if (!ast) return this.out(bmColumn(field.name), fallbackType, PREC.PRIMARY, { rowRef: true });
		this.calcStack.push(key);
		let inner;
		try {
			inner = this.emit(ast);
		} finally {
			this.calcStack.pop();
		}
		const type = inner.type === 'unknown' || inner.type === 'null' ? fallbackType : inner.type;
		if (this.unwrapsPredicate(inner)) return { ...inner };
		return carry(this.out(inner.prec >= PREC.PRIMARY ? inner.sql : `(${inner.sql})`, type), inner);
	}

	/** A parenthesized comparison is slow for Beast Mode's parser to read; it is wrapped by precedence where used. */
	unwrapsPredicate(inner) {
		return this.mode === 'beastmode' && inner.type === 'boolean' && !isConst(inner) && inner.prec >= PREC.NOT;
	}

	emitCall(c) {
		const category = classifyFunction(c.name, KNOWN_FUNCTIONS);
		switch (category) {
			case 'user':
				this.issue('error', 'calc.user-function', `${c.name}() depends on the viewing user`, PDP_SUGGESTION);
				return this.generic(c);
			case 'spatial':
				this.issue('error', 'calc.spatial', `Spatial function ${c.name} has no Beast Mode equivalent`, 'Use latitude/longitude columns with a Domo map card');
				return this.generic(c);
			case 'rawsql':
				this.issue('error', 'calc.rawsql', `${c.name} passes SQL to the Tableau source database`, 'Rewrite the SQL as a Beast Mode or in the source query/Magic ETL');
				return this.generic(c);
			case 'script':
				this.issue('error', 'calc.script', `${c.name} calls an external analytics extension`, 'Run the script in a Domo Jupyter workspace or Magic ETL Python/R tile');
				return this.generic(c);
			case 'no-equivalent':
				if (this.mode === 'etl' && ETL_ONLY_FUNCTIONS.has(c.name)) break;
				this.issue('error', 'calc.no-equivalent', `${c.name} has no Domo equivalent`, ETL_ONLY_FUNCTIONS.has(c.name) ? ETL_FORMULA_SUGGESTION : undefined);
				return this.generic(c);
			case 'unknown':
				this.issue('error', 'calc.unknown-function', `Unknown function ${c.name}`);
				return this.generic(c);
			default:
		}
		try {
			if (category === 'no-equivalent') {
				const n = ETL_ONLY_FUNCTIONS.get(c.name);
				this.arity(c, n, n);
				return this.out(fn(c.name, ...this.args(c).map((a) => this.valueOf(a).sql)), 'real');
			}
			if (category === 'table-calc') return emitTableCalc(c, this);
			if (this.mode === 'etl' && ETL_FUNCTIONS[c.name]) return ETL_FUNCTIONS[c.name](c, this);
			return FUNCTIONS[c.name](c, this);
		} catch (err) {
			if (!(err instanceof ArityError)) throw err;
			this.issue('error', 'calc.arity', err.message);
			return this.generic(c);
		}
	}

	emitUnary(node) {
		if (node.op === '+') return this.emit(node.operand);
		if (node.op === '-') {
			const x = this.emit(node.operand);
			let inner = wrap(x, PREC.UNARY);
			if (inner.startsWith('-')) inner = `(${x.sql})`;
			return this.out(`-${inner}`, x.type, PREC.UNARY, undefined, typeof x.constant?.value === 'number' ? -x.constant.value : undefined);
		}
		let operand = node.operand;
		while (operand.type === 'Paren') operand = operand.expr;
		if (operand.type === 'Call' && operand.name === 'ISNULL' && operand.args.length === 1) {
			return this.isNull(this.emit(operand.args[0]), true);
		}
		return this.not(this.cond(this.emit(node.operand)));
	}

	/** AND / OR with three-valued folding; the right side is not emitted when the left decides the result. */
	emitLogical(node) {
		const { op } = node;
		const absorbing = op === 'OR';
		const l = this.cond(this.emit(node.left));
		if (isConst(l) && l.constant.value === absorbing) return l;
		const r = this.cond(this.emit(node.right));
		if (isConst(r) && r.constant.value === absorbing) return r;
		if (isConst(l) && l.constant.value === !absorbing) return r;
		if (isConst(r) && r.constant.value === !absorbing) return l;
		const p = op === 'AND' ? PREC.AND : PREC.OR;
		const result = this.out(`${wrap(l, p)} ${op} ${wrap(r, p + 1)}`, 'boolean', p);
		const notNull = this.logicalNotNull(op, l, r);
		if (notNull) result.notNull = notNull;
		return result;
	}

	/**
	 * When `l op r` is not null, where one side is never null: OR is null only when the other side is null and this
	 * side false, AND only when the other side is null and this side true. Undefined when that test would be long.
	 */
	logicalNotNull(op, l, r) {
		if (l.notNull === true && r.notNull === true) return true;
		const [known, other] = r.notNull === true ? [r, l] : l.notNull === true ? [l, r] : [];
		if (!known || !other.notNull || known.sql.length > IN_VALUE_OPERAND_MAX) return undefined;
		if (other.notNull === true) return true;
		const decides = op === 'OR' ? known : this.not(known);
		if (decides.negated === other.notNull) return true;
		return `${wrap({ sql: other.notNull, prec: PREC.CMP }, PREC.OR + 1)} OR ${wrap(decides, PREC.OR + 1)}`;
	}

	emitBinary(node) {
		const { op } = node;
		if (op === 'AND' || op === 'OR') return this.emitLogical(node);
		const l = this.emit(node.left);
		const r = this.emit(node.right);
		if (['=', '!=', '<', '<=', '>', '>='].includes(op)) return this.compare(op, l, r);
		if (op === '+') return this.emitPlus(l, r);
		if (op === '-') return this.emitMinus(l, r);
		if (op === '*') return this.out(`${wrap(l, PREC.MUL)} * ${wrap(r, PREC.MUL + 1)}`, numericResult(l.type, r.type), PREC.MUL, undefined, foldNumbers(l, r, (a, b) => a * b));
		if (op === '/') return this.out(this.divide(l, r), 'real', PREC.MUL);
		if (op === '%') return this.out(fn('MOD', l.sql, this.divisor(r)), numericResult(l.type, r.type));
		if (op === '^') return this.out(fn('POWER', l.sql, r.sql), 'real');
		throw new Error(`Unknown operator ${op}`);
	}

	emitPlus(l, r) {
		if (l.type === 'string' || r.type === 'string') {
			const parts = [...(l.concat ?? [l.sql]), ...(r.concat ?? [r.sql])];
			const joined = { sql: fn('CONCAT', ...parts), type: 'string', prec: PREC.PRIMARY, concat: parts };
			const folded = foldConstants(l, r, 'string', (a, b) => a + b);
			if (folded !== undefined) joined.constant = { value: folded };
			return joined;
		}
		if (isDateType(l.type) && !isDateType(r.type)) return this.dateShift('DATE_ADD', l, r);
		if (isDateType(r.type) && !isDateType(l.type)) return this.dateShift('DATE_ADD', r, l);
		this.noteUnknown(l, r);
		return this.out(`${wrap(l, PREC.ADD)} + ${wrap(r, PREC.ADD + 1)}`, numericResult(l.type, r.type), PREC.ADD, undefined, foldNumbers(l, r, (a, b) => a + b));
	}

	emitMinus(l, r) {
		if (isDateType(l.type) && isDateType(r.type)) {
			if (l.type === 'datetime' || r.type === 'datetime') {
				return this.out(`(UNIX_TIMESTAMP(${l.sql}) - UNIX_TIMESTAMP(${r.sql})) / 86400`, 'real', PREC.MUL);
			}
			return this.out(fn('DATEDIFF', l.sql, r.sql), 'integer');
		}
		if (isDateType(l.type)) return this.dateShift('DATE_SUB', l, r);
		this.noteUnknown(l, r);
		return this.out(`${wrap(l, PREC.ADD)} - ${wrap(r, PREC.ADD + 1)}`, numericResult(l.type, r.type), PREC.ADD, undefined, foldNumbers(l, r, (a, b) => a - b));
	}

	/** `l / r`; Magic ETL and Domo on Snowflake fail on a zero divisor where Tableau returns null. */
	divide(l, r) {
		return `${wrap(l, PREC.MUL)} / ${this.divisor(r, PREC.MUL + 1)}`;
	}

	divisor(r, prec = PREC.PRIMARY) {
		if (isConst(r) && typeof r.constant.value === 'number' && r.constant.value !== 0) return wrap(r, prec);
		return `NULLIF(${r.sql}, 0)`;
	}

	/** Tableau date +/- number shifts by days (fractional days for datetimes). */
	dateShift(name, d, n) {
		const value = n.prec >= PREC.PRIMARY || /^\d+(\.\d+)?$/.test(n.sql) ? n.sql : `(${n.sql})`;
		if (d.type === 'datetime' && n.type !== 'integer') {
			return this.out(`${name}(${d.sql}, INTERVAL ROUND(${wrap(n, PREC.MUL)} * 86400) SECOND)`, 'datetime');
		}
		return this.out(`${name}(${d.sql}, INTERVAL ${value} DAY)`, d.type);
	}

	noteUnknown(l, r) {
		if (l.type === 'unknown' || r.type === 'unknown') {
			this.issue('info', 'calc.type-unknown', 'Operand type unknown; + and - were treated as numeric');
		}
	}

	lodClause(node) {
		// A bare CASE dimension validates but the query fails ("Grouping by aggregate is not permitted", ib:4201).
		const dims = node.dims.map((d) => this.emit(d, { inAgg: false, fixed: null }).sql).map((sql) => (/^CASE\b/.test(sql) ? `(${sql})` : sql));
		if (node.lodType === 'INCLUDE') return `(ADD ${dims.join(', ')})`;
		if (node.lodType === 'EXCLUDE') return `(REMOVE ${dims.join(', ')})`;
		// Tableau FIXED ignores dimension filters except context filters (FILTER clause).
		const allow = (this.ctx.contextFilterColumns ?? []).map((c) => bmColumn(c));
		const filter = allow.length ? `FILTER ALLOW ${allow.join(', ')}` : 'FILTER NONE';
		return `(${[dims.length ? `BY ${dims.join(', ')}` : '', filter].filter(Boolean).join(' ')})`;
	}

	emitLod(node) {
		const materialized = this.ctx.lodColumn?.(node);
		if (materialized) return this.emitColumn(materialized);
		const label = node.lodType === 'TABLE' ? 'Table-scoped LOD' : `${node.lodType} LOD`;
		if (this.mode === 'etl') {
			this.issue('error', 'calc.row-level-only', `${label} expressions are not allowed in a Magic ETL formula`, ETL_LOD_SUGGESTION);
		} else if (!this.options.useFixed) {
			this.issue('error', 'calc.lod', `${label} needs Domo FIXED functions, which are disabled (useFixed: false)`, ETL_LOD_SUGGESTION);
		} else {
			this.feature('fixed');
		}
		if (this.env.lodDepth > 0 && !this.env.lodSlot) {
			// Domo validates these but the query engine fails ("Fixed expressions should have been replaced before deparsing").
			this.issue(
				'error',
				'calc.lod-nested-wrapped',
				'A nested LOD inside an expression in another LOD cannot run in Domo; only AGG({LOD}) nesting works',
				ETL_LOD_SUGGESTION
			);
		} else if (this.env.lodDepth > 0) {
			this.issue('warning', 'calc.lod-nested', 'Nested LOD expressions become nested FIXED functions; validate in Domo');
		}
		// Syntax AGG(expr) FIXED (BY|ADD|REMOVE dims [FILTER ...]).
		const clause = this.lodClause(node);
		const body = this.emit(node.body, { inAgg: false, fixed: clause, lodDepth: this.env.lodDepth + 1, lodSlot: false });
		if (!body.flags.agg) this.issue('warning', 'calc.lod-unaggregated', `${label} body has no aggregation; FIXED applies to aggregates only`);
		return carry({ sql: body.sql, type: body.type, prec: body.prec, flags: { lod: true } }, body);
	}
}

const MIRRORED = { '=': '=', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
const FLIPPED = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '=': '!=', '!=': '=' };
const HEAVY_OPERAND_CHARS = 200;
const LOD_SLOT_PASSTHROUGH = new Set(['Paren', 'Field', 'Lod']);
const IN_VALUE_OPERAND_MAX = 200;
const TRUE_TEXT = [...TRUE_VALUES].map(quoteString).join(', ');
const isConst = (r) => r?.constant !== undefined;
const isBoolConst = (r) => isConst(r) && typeof r.constant.value === 'boolean';

/** Copy the folding facts of `from` (constant, string value form, negation) onto a re-wrapped result. */
function carry(r, from) {
	if (isConst(from)) r.constant = from.constant;
	if (ignoresCase(from)) r.flags = { ...r.flags, ignoreCase: true };
	if (from.valueSql) r.valueSql = from.valueSql;
	if (from.notNull) r.notNull = from.notNull;
	if (from.negated) Object.assign(r, { negated: from.negated, negatedPrec: from.negatedPrec });
	if (from.dateOnly) r.dateOnly = true;
	if (from.monthStart) r.monthStart = from.monthStart;
	return r;
}

/**
 * Value of `f` over two constants of `type` (null when either is null), or undefined when they are not both known.
 * The SQL is kept as written; the value only decides comparisons and branches.
 */
function foldConstants(l, r, type, f) {
	if (!isConst(l) || !isConst(r)) return undefined;
	const [a, b] = [l.constant.value, r.constant.value];
	if (a === null || b === null) return null;
	return typeof a === type && typeof b === type ? f(a, b) : undefined;
}

/** Numeric fold rounded to 15 significant digits, so 0.1 + 0.2 = 0.3 folds the way decimal SQL literals compare. */
function foldNumbers(l, r, f) {
	const v = foldConstants(l, r, 'number', f);
	if (v === null || v === undefined) return v;
	return Number.isFinite(v) ? Number(v.toPrecision(15)) : undefined;
}

/** Text that differs only in case: Domo compares it as equal, so it is not folded either way. */
const caseOnly = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== b && a.toLowerCase() === b.toLowerCase();

/** Comparison of two constants; undefined when it is left to Domo (types differ, case-only text difference, text ordering). */
function compareConstants(op, a, b) {
	if (a === null || b === null) return null;
	if (typeof a !== typeof b || caseOnly(a, b)) return undefined;
	if (typeof a === 'string' && op !== '=' && op !== '!=') return undefined;
	switch (op) {
		case '=':
			return a === b;
		case '!=':
			return a !== b;
		case '<':
			return a < b;
		case '<=':
			return a <= b;
		case '>':
			return a > b;
		case '>=':
			return a >= b;
		default:
			return undefined;
	}
}

/** Folding value of an inlined parameter literal (dates are not folded). */
function parameterConstant(sql, type) {
	if (sql === NULL_VALUE) return null;
	if (type === 'string') return sql.slice(1, -1).replace(/''/g, "'");
	if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(sql)) return Number(sql);
	return undefined;
}

function numericResult(a, b) {
	if (a === 'integer' && b === 'integer') return 'integer';
	if (isNumeric(a) || isNumeric(b)) return 'real';
	return 'unknown';
}

/** SQL literal for a parameter value. */
export function literalFor(value, type) {
	if (value === null || value === undefined || value === '') return type === 'string' && value === '' ? "''" : NULL_VALUE;
	if (type === 'boolean') return value === true || String(value).toLowerCase() === 'true' ? "'true'" : "'false'";
	if (type === 'integer' || type === 'real' || (type === 'unknown' && typeof value === 'number')) {
		const n = Number(value);
		return Number.isFinite(n) ? String(n) : NULL_VALUE;
	}
	if (type === 'date' || type === 'datetime') {
		const text = String(value).replace(/^#|#$/g, '').replace('T', ' ').replace(/(\.\d+)?Z?$/, '');
		const parsed = parseDateLiteral(text);
		if (parsed?.type === 'datetime' || (type === 'datetime' && parsed)) {
			const v = parsed.type === 'datetime' ? parsed.value : `${parsed.value} 00:00:00`;
			return `TIMESTAMP(${quoteString(v)})`;
		}
		return quoteString(parsed ? parsed.value : text);
	}
	return quoteString(value);
}

function outerAggregation(ctx) {
	const raw = ctx.outerAggregation;
	if (!raw) return null;
	return OUTER_AGGREGATIONS[String(raw).toUpperCase().replace(/[^A-Z]/g, '')] ?? null;
}

function finish(em, r) {
	const ctx = em.ctx;
	let { sql, type } = r;
	let aggregated = Boolean(r.flags.agg);
	let lodExpression;

	if (r.flags.lod && em.mode === 'beastmode') {
		const dimensionLike = ctx.role === 'dimension' || r.flags.rowRef || ['string', 'boolean', 'date', 'datetime'].includes(type);
		if (dimensionLike) {
			em.issue(
				'error',
				'calc.lod-dimension',
				'LOD expression is used as a row-level value or dimension; Domo cannot group by a FIXED expression',
				ETL_LOD_SUGGESTION
			);
		} else if (aggregated) {
			em.issue('warning', 'calc.lod-mixed', 'LOD expression combined with aggregates outside an aggregation; Domo requires its dimensions to be on the card');
		} else {
			let outer = outerAggregation(ctx);
			if (!outer) {
				outer = 'SUM';
				lodExpression = sql;
				em.issue('warning', 'calc.lod-outer-aggregation', 'LOD used as a measure; wrapped in SUM because the pill aggregation is unknown');
			}
			sql = outer === 'COUNTD' ? `COUNT(DISTINCT ${sql})` : `${outer}(${sql})`;
			if (outer === 'COUNT' || outer === 'COUNTD') type = 'integer';
			else if (outer !== 'SUM' && outer !== 'MIN' && outer !== 'MAX') type = 'real';
			aggregated = true;
		}
	}

	if (type === 'boolean') {
		sql = em.valueOf({ ...r, sql }).sql;
		em.issue('info', 'calc.boolean-as-string', "Boolean result returned as 'true'/'false' text (Domo has no boolean type)");
	}

	let domoType = toDomoType(type);
	if (!domoType) domoType = toDomoType(normalizeType(ctx.field?.datatype)) ?? (aggregated ? 'DOUBLE' : 'STRING');
	return { expression: sql, aggregated, dataType: domoType, ...(lodExpression ? { lodExpression } : {}) };
}

function translate(formula, ctx, mode) {
	const em = new Emitter(ctx, mode);
	let ast;
	try {
		ast = typeof formula === 'string' ? parseFormula(formula) : formula;
	} catch (err) {
		if (!(err instanceof CalcSyntaxError)) throw err;
		em.issue('error', 'calc.syntax', `Formula does not parse: ${err.message}`);
		return {
			expression: '',
			aggregated: false,
			dataType: toDomoType(normalizeType(ctx?.field?.datatype)) ?? 'STRING',
			status: 'unsupported',
			features: [],
			issues: em.issues
		};
	}
	const r = em.emit(ast);
	const done = finish(em, r);
	checkSize(em, done.expression);
	return { ...done, status: em.status, features: [...em.features].sort(), issues: em.issues };
}

function checkSize(em, expression) {
	if (expression.length * 3 <= LARGE_EXPRESSION_BYTES) return;
	const bytes = Buffer.byteLength(expression, 'utf8');
	const what = em.mode === 'etl' ? 'Magic ETL formula' : 'Beast Mode expression';
	if (bytes > MAX_EXPRESSION_BYTES) {
		em.issue('error', 'calc.expression-too-large', `The ${what} is ${bytes} bytes; Domo rejects formulas over ${MAX_EXPRESSION_BYTES} bytes`, SIZE_SUGGESTION);
	} else if (bytes > LARGE_EXPRESSION_BYTES && em.mode !== 'etl') {
		em.issue('warning', 'calc.expression-large', `The ${what} is ${bytes} bytes (over ${LARGE_EXPRESSION_BYTES}), which is slow to validate and query in Domo`, SIZE_SUGGESTION);
	}
}

/**
 * Translate a Tableau calculation to a Domo Beast Mode expression.
 * @param {string} formula
 * @param {CalcContext} [ctx]
 * @returns {CalcTranslation}
 */
export function translateCalc(formula, ctx = {}) {
	return translate(formula, ctx, 'beastmode');
}

/**
 * Translate a row-level Tableau calculation to a Magic ETL formula (Add Formula tile).
 * Aggregates, LOD expressions and table calculations are reported as unsupported.
 * @param {string} formula
 * @param {CalcContext} [ctx]
 * @returns {CalcTranslation}
 */
export function translateRowExpression(formula, ctx = {}) {
	return translate(formula, ctx, 'etl');
}

/**
 * Translate a formula or an already parsed AST node to Magic ETL SQL. With `aggregate`, aggregations are allowed
 * (a Group By field expression) and nested ones are errors; LOD nodes need `ctx.lodColumn` to resolve to a column.
 * @param {string|import('./parser.js').AstNode} formula
 * @param {CalcContext} [ctx]
 * @param {{ aggregate?: boolean }} [opts]
 * @returns {CalcTranslation}
 */
export function translateEtl(formula, ctx = {}, { aggregate = false } = {}) {
	return translate(formula, { ...ctx, allowAggregates: aggregate }, 'etl');
}
