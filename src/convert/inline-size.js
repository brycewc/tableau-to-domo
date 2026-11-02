import { analyzeFormula, translateCalc, LARGE_EXPRESSION_BYTES } from './calc/index.js';
import { bmColumn } from '../model/naming.js';
import { VOLATILE_FUNCTIONS } from './calc/catalog.js';

/**
 * Calc references are inlined, so a helper calc reached through several paths (a diamond) is repeated in every
 * beast mode above it. This picks the row-level calcs to compute once as Magic ETL columns instead.
 *
 * @typedef {import('../model/types.js').FieldIR} FieldIR
 */

/** A reused row-level calc smaller than this stays inlined. */
export const MIN_SHARED_CHARS = 1024;

const placeholder = (i) => `__t2d_ref_${i}__`;
// A boolean calc read as a column is `LOWER(col) = 'true'`; inlined, it is its own predicate.
const BOOLEAN_WRAP = "LOWER() = 'true'";

function count(text, needle) {
	let n = 0;
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++;
	return n;
}

/**
 * Inlined size of every calc reachable from `roots`, and the row-level ones to materialize, bottom-up: a calc is
 * chosen when it is used more than once by the calcs above it and inlines to at least `minShared` characters, or
 * when it alone inlines to more than `maxInline`. Sizes are estimated from one translation per calc, with every
 * calc reference read as a column, so the full expansion is never built.
 *
 * @param {{
 *   roots: FieldIR[],
 *   astOf: (field: FieldIR) => Object|null,
 *   calcField: (id: string) => FieldIR|undefined,
 *   lookupField: (id: string) => FieldIR|undefined,
 *   findParameter: (id: string) => Object|undefined,
 *   fieldMap?: Record<string, string>,
 *   options?: import('../model/types.js').ConvertOptions,
 *   isColumn?: (field: FieldIR) => boolean,
 *   isBlocked?: (field: FieldIR) => boolean,
 *   minShared?: number,
 *   maxInline?: number
 * }} input
 * @returns {{ chosen: FieldIR[], sizes: Map<string, number>, uses: Map<string, number> }}
 */
export function sharedRowCalcs({ roots, astOf, calcField, lookupField, findParameter, fieldMap = {}, options = {}, isColumn = () => false, isBlocked = () => false, minShared = MIN_SHARED_CHARS, maxInline = LARGE_EXPRESSION_BYTES }) {
	const index = new Map();
	const order = [];
	const facts = new Map();
	const state = new Map();
	const visit = (field) => {
		if (state.has(field.id)) return;
		state.set(field.id, 'active');
		index.set(field.id, index.size);
		const ast = astOf(field);
		const f = ast ? analyzeFormula(ast) : null;
		facts.set(field.id, f);
		for (const id of f?.refs ?? []) {
			const ref = calcField(id);
			if (ref && !isColumn(ref)) visit(ref);
		}
		state.set(field.id, 'done');
		order.push(field);
	};
	roots.filter((f) => !isColumn(f)).forEach(visit);

	const variables = options.parameters === 'variables';
	const resolveField = (id) => {
		const p = findParameter(id);
		if (p) return { kind: 'parameter', parameter: p };
		const f = lookupField(id);
		if (!f) return undefined;
		if (index.has(f.id)) return { kind: 'column', column: placeholder(index.get(f.id)), datatype: f.datatype };
		return { kind: 'column', column: fieldMap[f.id] ?? f.name, datatype: f.datatype };
	};

	const counts = new Map();
	const own = new Map();
	const wrapped = new Map();
	for (const field of order) {
		const ast = astOf(field);
		let sql;
		try {
			// A boolean calc is inlined into conditions as its predicate, shorter than its value form.
			const asCondition = ast && field.datatype === 'boolean';
			const node = asCondition ? { type: 'If', branches: [{ cond: ast, then: { type: 'Literal', valueType: 'number', value: 1, raw: '1' } }], else: null } : ast;
			sql = node ? translateCalc(node, { resolveField, options, field: asCondition ? { ...field, datatype: 'integer' } : field }).expression : '';
			if (asCondition) sql = sql.replace(/^CASE WHEN (.*) THEN 1 END$/s, '$1');
		} catch {
			sql = '';
		}
		const refs = new Map();
		const wraps = new Map();
		let rest = sql.length;
		for (const id of facts.get(field.id)?.refs ?? []) {
			const ref = calcField(id);
			if (!ref || !index.has(ref.id) || refs.has(ref.id)) continue;
			const name = placeholder(index.get(ref.id));
			const n = count(sql, name);
			if (!n) continue;
			refs.set(ref.id, n);
			const w = count(sql, `LOWER(\`${name}\`) = 'true'`);
			if (w) wraps.set(ref.id, w);
			rest -= n * (name.length + 2) + w * BOOLEAN_WRAP.length;
		}
		counts.set(field.id, refs);
		wrapped.set(field.id, wraps);
		own.set(field.id, Math.max(rest, 0));
	}

	const uses = new Map();
	for (const refs of counts.values()) for (const [id, n] of refs) uses.set(id, (uses.get(id) ?? 0) + n);

	const byId = new Map(order.map((f) => [f.id, f]));
	const eligible = new Map();
	const chosen = new Set();
	const rowLevel = (field) => {
		const f = facts.get(field.id);
		if (!f || isBlocked(field)) return false;
		if (f.aggregated || f.lod.length || f.tableCalcs.length || f.userFunctions.length) return false;
		// A Magic ETL column would freeze TODAY()/NOW() at the dataflow's last run.
		if (f.functions.some((name) => VOLATILE_FUNCTIONS.has(name))) return false;
		if (variables && f.parameters.length) return false;
		return [...counts.get(field.id).keys()].every((id) => eligible.get(id) || chosen.has(id));
	};
	const sizes = new Map();
	const measure = (field) => {
		let size = own.get(field.id);
		for (const [id, n] of counts.get(field.id)) {
			size += chosen.has(id) ? n * bmColumn(byId.get(id).name).length + (wrapped.get(field.id).get(id) ?? 0) * BOOLEAN_WRAP.length : n * (sizes.get(id) + 2);
		}
		sizes.set(field.id, size);
		eligible.set(field.id, rowLevel(field));
		return size;
	};
	for (const field of order) {
		const size = measure(field);
		if (eligible.get(field.id) && (((uses.get(field.id) ?? 0) >= 2 && size >= minShared) || size > maxInline)) chosen.add(field.id);
	}

	/** Copies of each calc inlined into `root`, through calcs that cannot be computed as columns. */
	const copiesIn = (root) => {
		const copies = new Map([[root.id, 1]]);
		for (let i = order.length - 1; i >= 0; i--) {
			const id = order[i].id;
			const n = copies.get(id);
			if (!n || chosen.has(id) || (id !== root.id && eligible.get(id))) continue;
			for (const [ref, k] of counts.get(id)) if (!chosen.has(ref)) copies.set(ref, (copies.get(ref) ?? 0) + n * k);
		}
		return copies;
	};
	// A calc still too large that cannot be a column itself (an aggregate, a parameter switch) gets its largest
	// row-level parts computed as columns until it fits.
	for (const field of order) {
		if (chosen.has(field.id)) continue;
		while (sizes.get(field.id) > maxInline) {
			let best;
			let weight = minShared;
			for (const [id, n] of copiesIn(field)) {
				if (id === field.id || !eligible.get(id)) continue;
				if (n * sizes.get(id) >= weight) [best, weight] = [id, n * sizes.get(id)];
			}
			if (!best) break;
			chosen.add(best);
			order.forEach(measure);
		}
	}
	return { chosen: order.filter((f) => chosen.has(f.id)), sizes, uses };
}
