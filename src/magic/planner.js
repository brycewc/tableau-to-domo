import { AGGREGATES, canonical, hasAggregate, hasWindow, parseQuery, parseScript, walkExpr } from './parser.js';
import { MAGIC_FALSE, TranslateError, backtick, isCondition, magicType, notTrue, toMagic, toMagicValue } from './expr.js';
import { Graph, formulaColumns } from './graph.js';
import { itemName, snowflakeQueryText, sqlTileText } from './sql-tile.js';
import { excerpt } from './lexer.js';

/**
 * SQL script -> logical tile graph. Tracks every table's current version through the script, so a later statement
 * reads what the earlier ones built, then plans the output queries (Tableau Custom SQL) over those versions.
 *
 * @typedef {import('./graph.js').GraphNode} GraphNode
 * @typedef {import('./parser.js').Expr} Expr
 * @typedef {import('./expr.js').Issue} Issue
 *
 * @typedef {{ names: Set<string>, cols: Map<string, string>|null }} Source  `cols`: Snowflake name -> working column
 * @typedef {{ node: GraphNode, sources: Source[] }} Rel
 *
 * @typedef {Object} InputTable
 * @property {any} dataSourceId                   Domo dataset id (or a t2d `{ $ref }`) the LoadFromVault tile reads
 * @property {string} [name]                      Tile name
 * @property {{ name: string, type?: string }[]} [columns]  The dataset's columns as Snowflake stores them
 *
 * @typedef {(table: { key: string, parts: string[] }) => InputTable|undefined} InputResolver
 *
 * @typedef {{ statement: number, excerpt: string, reason: string }} Blocker
 *
 * @typedef {Object} PlanOptions
 * @property {InputResolver|Record<string, InputTable>} [inputs]  Warehouse tables by fully qualified upper-case name
 * @property {{ name: string, sql: string }[]} [outputs]         Final queries (Tableau Custom SQL) that read the script's tables
 * @property {string[]} [publish]                                Tables to publish as they stand at the end, by name
 * @property {'auto'|'tiles'|'sql'} [mode]                       `auto`: tiles, SQL tile where tiles cannot; `sql`: SQL tile per query
 * @property {string} [database]                                 Connection defaults before any USE
 * @property {string} [schema]
 */

const HELPER = /^_t2d_/;
// A second select item with the same name; harmless inside a union branch or subquery, an error where a table is stored.
const DUPLICATE = '__t2d_dup';
const isHelper = (name) => HELPER.test(name);
const fallback = (message) => new TranslateError(message, { fallback: true });
const keyOfParts = (parts) => parts.join('.');

/**
 * @param {string} script
 * @param {PlanOptions} [opts]
 */
export function planSql(script, opts = {}) {
	const statements = parseScript(script ?? '');
	const graph = new Graph();
	const env = {
		graph,
		issues: /** @type {Issue[]} */ ([]),
		tables: new Map(),
		inputs: new Map(),
		poisoned: new Set(),
		session: { database: opts.database ? opts.database.toUpperCase() : undefined, schema: opts.schema ? opts.schema.toUpperCase() : undefined },
		variables: new Map(),
		resolver: typeof opts.inputs === 'function' ? opts.inputs : (t) => (opts.inputs ? opts.inputs[t.key] ?? opts.inputs[t.parts.at(-1)] : undefined),
		mode: opts.mode ?? 'auto',
		engine: opts.compute?.type === 'adr' ? 'adr' : 'magic',
		sqlDialect: opts.compute?.type === 'adr' ? opts.compute.sqlTileDialect ?? 'SNOWFLAKE' : undefined,
		statement: -1,
		fallbacks: 0
	};
	/** @type {Blocker[]} */
	const blockers = [];
	const summary = [];
	const issue = (severity, code, message) => env.issues.push({ severity, code, message, ...(env.statement >= 0 ? { statement: env.statement } : {}) });
	env.issue = issue;

	for (const st of statements) {
		env.statement = st.index;
		graph.statement = st.index;
		const line = { index: st.index, kind: st.kind, text: excerpt(st.text, 100) };
		summary.push(line);
		try {
			if (env.session.quotedIgnoreCase) foldQuoted(st);
			const note = runStatement(st, env);
			if (note) line.note = note;
		} catch (err) {
			if (!(err instanceof TranslateError)) throw err;
			if (err.poisoned) line.note = `skipped: ${err.message}`;
			else {
				blockers.push({ statement: st.index, excerpt: excerpt(st.text), reason: err.message });
				line.note = `blocked: ${err.message}`;
			}
			for (const name of writtenTables(st, env)) {
				env.poisoned.add(name);
				env.tables.delete(name);
			}
		}
	}

	const outputs = [];
	env.statement = -1;
	graph.statement = undefined;
	for (const out of opts.outputs ?? []) {
		try {
			const query = parseQuery(out.sql);
			if (env.session.quotedIgnoreCase) foldQuoted(query);
			const rel = planOrFallback(query, env, `output ${out.name}`);
			assertStorable(rel.node);
			outputs.push({ name: out.name, node: rel.node });
		} catch (err) {
			if (!(err instanceof TranslateError) && err.name !== 'ParseError') throw err;
			blockers.push({ statement: -1, output: out.name, excerpt: excerpt(out.sql), reason: err.message });
		}
	}
	for (const name of opts.publish ?? []) {
		const key = tableKey(String(name).split('.').map((p) => ({ name: p, quoted: false })), env);
		const table = env.tables.get(key);
		if (!table) blockers.push({ statement: -1, output: name, excerpt: name, reason: `the script never creates ${name}` });
		else outputs.push({ name, node: table.node });
	}
	if (env.fallbacks && env.mode === 'auto') issue('info', 'magic.sql-tile', `${env.fallbacks} query(ies) use a SQL tile because no tile chain expresses them.`);
	return { graph, outputs, issues: env.issues, blockers, statements: summary, inputs: [...env.inputs.values()], tables: [...env.tables.keys(), ...env.poisoned] };
}

/** QUOTED_IDENTIFIERS_IGNORE_CASE = TRUE: quoted names resolve (and are stored) upper-case, like unquoted ones. */
function foldQuoted(node) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const n of node) foldQuoted(n);
		return;
	}
	if (typeof node.name === 'string' && typeof node.quoted === 'boolean' && node.quoted) node.quoted = false;
	for (const v of Object.values(node)) if (v && typeof v === 'object') foldQuoted(v);
}

function writtenTables(st, env) {
	if (!st.name) return [];
	try {
		return [tableKey(st.name, env)];
	} catch {
		return [];
	}
}

/* Tables */

function tableKey(parts, env) {
	const names = parts.map(canonical);
	if (names.length === 1) return keyOfParts([env.session.database, env.session.schema, names[0]].filter(Boolean));
	if (names.length === 2) return keyOfParts([env.session.database, ...names].filter(Boolean));
	return keyOfParts(names.slice(-3).map((n, k) => (n === '' && k === 1 ? env.session.schema ?? 'PUBLIC' : n)));
}

function qualifierNames(key, alias) {
	if (alias) return new Set([canonical(alias)]);
	const parts = key.split('.');
	const out = new Set();
	for (let k = 0; k < parts.length; k++) out.add(parts.slice(k).join('.'));
	return out;
}

function sourceFromNode(node, names) {
	return { names, cols: node.columns ? new Map(node.columns.filter((c) => !isHelper(c.name)).map((c) => [c.name, c.name])) : null };
}

/** Current version of a table: a temp table the script built, else the warehouse table's input tile. */
function tableNode(parts, env) {
	const key = tableKey(parts, env);
	if (env.poisoned.has(key)) {
		const err = new TranslateError(`reads ${key}, which a blocked statement builds`);
		err.poisoned = true;
		throw err;
	}
	const temp = env.tables.get(key);
	if (temp) {
		if (temp.empty) return emptyTable(temp);
		return temp.node;
	}
	if (env.inputs.has(key)) return env.inputs.get(key);
	const resolved = env.resolver({ key, parts: key.split('.') });
	const label = resolved?.name ?? key.split('.').at(-1);
	const node = env.graph.add({ op: 'input', table: key, label, dataSourceId: resolved?.dataSourceId ?? null }, [], resolved?.columns ?? null, label);
	if (!resolved?.dataSourceId) env.issue('warning', 'magic.input-unresolved', `No Domo dataset was supplied for ${key}; its LoadFromVault tile has no dataSourceId.`);
	if (!resolved?.columns) env.issue('info', 'magic.input-schema-unknown', `The columns of ${key} are unknown, so statements that expand * over it or join it use a SQL tile.`);
	env.inputs.set(key, node);
	return node;
}

function emptyTable(temp) {
	throw new TranslateError(`reads ${temp.key} while it is still empty (CREATE TABLE with no rows), which Magic ETL cannot produce from nothing`);
}

/* Small builders */

function derive(rel, node, renameSource) {
	return { node, sources: renameSource ? rel.sources.map(renameSource) : rel.sources };
}

function addFormula(rel, fields, env, label = 'Add formula') {
	if (!fields.length) return rel;
	const node = env.graph.add({ op: 'formula', fields: fields.map((f) => ({ name: f.name, expression: f.expression })) }, [rel.node], formulaColumns(rel.node.columns, fields), label);
	return derive(rel, node);
}

function addFilter(rel, expression, env, label = 'Filter rows') {
	return derive(rel, env.graph.add({ op: 'filter', expression }, [rel.node], rel.node.columns, label));
}

function dropColumns(rel, names, env) {
	const drop = [...new Set(names)].filter((n) => !rel.node.columns || rel.node.columns.some((c) => c.name === n));
	if (!drop.length) return rel;
	const columns = rel.node.columns ? rel.node.columns.filter((c) => !drop.includes(c.name)) : null;
	const node = columns ? env.graph.add({ op: 'select', fields: columns.map((c) => ({ name: c.name })) }, [rel.node], columns, 'Drop helper columns') : env.graph.add({ op: 'drop', names: drop }, [rel.node], null, 'Drop helper columns');
	return derive(rel, node);
}

function helperColumns(node) {
	return (node.columns ?? []).filter((c) => isHelper(c.name)).map((c) => c.name);
}

/* Scopes and expressions */

/**
 * @typedef {{ rel: Rel, aliases?: Map<string, Expr>, outer?: Scope, replacements?: Map<Expr, string>, inAlias?: Set<string> }} Scope
 */

function resolveIn(rel, parts) {
	const names = parts.map(canonical);
	const col = names.at(-1);
	const qualifier = names.slice(0, -1).join('.');
	const candidates = rel.sources.filter((s) => !qualifier || s.names.has(qualifier));
	if (qualifier && !candidates.length) return undefined;
	const known = candidates.filter((s) => s.cols?.has(col));
	if (known.length === 1) return known[0].cols.get(col);
	if (known.length > 1) throw new TranslateError(`refers to the ambiguous column ${col}`);
	const unknown = candidates.filter((s) => !s.cols);
	if (unknown.length === 1) return col;
	if (unknown.length) throw fallback(`refers to ${col}, which cannot be placed because a joined table's columns are unknown`);
	// Warehouse metadata can report a column in another case than the script spells it (a view built with
	// QUOTED_IDENTIFIERS_IGNORE_CASE); a unique case-insensitive match is the column Snowflake resolved.
	const folded = candidates.flatMap((s) => [...(s.cols ?? [])].filter(([name]) => name.toUpperCase() === col.toUpperCase()).map(([, w]) => w));
	if (folded.length === 1) return folded[0];
	return undefined;
}

/** Working column for a reference, or undefined when the scope chain has none. */
function lookup(scope, parts) {
	for (let s = scope; s; s = s.outer) {
		const hit = resolveIn(s.rel, parts);
		if (hit !== undefined) return { working: hit, scope: s };
	}
	return undefined;
}

function exprCtx(scope, env, extra = {}) {
	const ctx = {
		target: 'formula',
		variables: env.variables,
		engine: env.engine,
		issue: (i) => env.issue(i.severity, i.code, i.message),
		replace: (n) => scope.replacements?.get(n),
		column: (c) => {
			const hit = resolveIn(scope.rel, c.parts);
			if (hit !== undefined) return backtick(hit);
			const name = c.parts.length === 1 ? canonical(c.parts[0]) : undefined;
			if (name && scope.aliases?.has(name) && !scope.inAlias?.has(name)) {
				const inner = { ...scope, inAlias: new Set([...(scope.inAlias ?? []), name]) };
				return `(${toMagic(scope.aliases.get(name), exprCtx(inner, env, extra))})`;
			}
			if (scope.outer && lookup(scope.outer, c.parts)) throw fallback(`has a correlated reference to ${c.parts.map((p) => p.name).join('.')} that t2d could not turn into a join`);
			throw new TranslateError(`refers to the column ${c.parts.map((p) => p.name).join('.')}, which is not in scope`);
		},
		...extra
	};
	return ctx;
}

function formula(e, scope, env, extra) {
	alignComparisons(e, scope, env);
	return toMagic(e, exprCtx(scope, env, extra));
}

function valueFormula(e, scope, env, extra) {
	alignComparisons(e, scope, env);
	return toMagicValue(e, exprCtx(scope, env, extra));
}

const COMPARISONS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);

/**
 * Compares a text column with a number or date column through a TRY_CAST of the text side, as Snowflake converts the
 * text; ADR hands the comparison to Snowflake, where one unconvertible value fails the statement. Literals are left
 * alone. Rewrites in place; a rewritten pair has matching types, so a second pass changes nothing.
 */
function alignComparisons(e, scope, env) {
	if (!scope?.rel) return;
	walkExpr(e, (n) => {
		if (n.k !== 'bin' || !COMPARISONS.has(n.op)) return undefined;
		const literal = (x) => ['str', 'num', 'null', 'typed', 'bool'].includes(x.k) || (x.k === 'unary' && x.e.k === 'num');
		if (literal(n.l) || literal(n.r)) return undefined;
		const lt = castType(n.l, scope);
		const rt = castType(n.r, scope);
		const wrap = (x, type) => ({ k: 'cast', e: x, type: KEY_CAST_TYPES[type], try: true });
		if (lt === 'STRING' && KEY_CAST_TYPES[rt]) n.l = wrap(n.l, rt);
		else if (rt === 'STRING' && KEY_CAST_TYPES[lt]) n.r = wrap(n.r, lt);
		else return undefined;
		env.issue('info', 'magic.text-comparison', `A comparison of text with ${lt === 'STRING' ? rt : lt} converts the text with TRY_CAST, so values that are not ${lt === 'STRING' ? rt : lt} compare as NULL instead of failing the run.`);
		return undefined;
	});
}

function conjuncts(e) {
	if (!e) return [];
	if (e.k === 'bin' && e.op === 'AND') return [...conjuncts(e.l), ...conjuncts(e.r)];
	if (e.k === 'paren') return conjuncts(e.e);
	return [e];
}

const andAll = (list) => list.reduce((acc, e) => (acc ? { k: 'bin', op: 'AND', l: acc, r: e } : e), null);

function isConstantTrue(e) {
	return (e.k === 'bool' && e.v) || (e.k === 'bin' && e.op === '=' && e.l.k === 'num' && e.r.k === 'num' && Number(e.l.v) === Number(e.r.v));
}

/** Structural key of an expression, with column references replaced by their resolved working columns. */
function exprKey(e, scope) {
	return JSON.stringify(e, (key, value) => {
		if (value && typeof value === 'object' && value.k === 'col') {
			const hit = (() => {
				try {
					return resolveIn(scope.rel, value.parts);
				} catch {
					return undefined;
				}
			})();
			return { k: 'col', w: hit ?? value.parts.map(canonical).join('.') };
		}
		return value;
	});
}

/** Column refs of an expression, outside its subqueries. */
function columnRefs(e) {
	const out = [];
	walkExpr(e, (n) => {
		if (n.k === 'col') out.push(n);
	});
	return out;
}

function hasSubquery(e) {
	let found = false;
	walkExpr(e, (n) => {
		if (n.k === 'subquery' || n.k === 'exists' || (n.k === 'in' && n.query)) found = true;
	});
	return found;
}

/** The expression as a column of the relation: itself when it is a plain column, else a new formula column. */
function asColumn(rel, e, scope, env, kind = 'k') {
	if (e.k === 'col') {
		const hit = resolveIn(rel, e.parts);
		if (hit !== undefined) return { rel, name: hit };
	}
	const name = env.graph.temp(kind);
	const next = addFormula(rel, [{ name, expression: formula(e, { ...scope, rel }, env) }], env, 'Compute key');
	return { rel: next, name };
}

/* Subqueries -> joins */

function subqueryOccurrences(e, condition) {
	const out = [];
	const visit = (n, safe) => {
		if (!n || typeof n !== 'object' || !n.k) return;
		if (n.k === 'subquery' || n.k === 'exists' || (n.k === 'in' && n.query)) {
			out.push({ node: n, safe });
			if (n.k === 'in') visit(n.e, false);
			return;
		}
		if (n.k === 'bin' && (n.op === 'AND' || n.op === 'OR')) {
			visit(n.l, safe);
			visit(n.r, safe);
			return;
		}
		if (n.k === 'paren') return visit(n.e, safe);
		walkExpr(n, (child) => {
			if (child === n) return undefined;
			visit(child, false);
			return false;
		});
	};
	visit(e, condition);
	return out;
}

/**
 * Join every subquery of `exprs` onto the relation and record the formula text that stands in for it.
 * @returns {Rel}
 */
function attachSubqueries(rel, exprs, scope, env, { condition = false } = {}) {
	for (const e of exprs) {
		if (!e) continue;
		for (const { node, safe } of subqueryOccurrences(e, condition)) {
			if (scope.replacements?.has(node)) continue;
			rel = joinSubquery(rel, node, safe, { ...scope, rel }, env);
		}
	}
	return rel;
}

function oneColumnQuery(query) {
	const body = query.body;
	if (body.k === 'select' && body.items.length === 1 && body.items[0].e.k !== 'star') return body.items[0];
	return undefined;
}

/** Split a subquery's WHERE into inner conditions and correlation equalities against the outer scope. */
function correlation(query, innerRel, outerScope) {
	const body = query.body;
	const inner = [];
	const pairs = [];
	for (const c of conjuncts(body.where)) {
		const refs = columnRefs(c);
		const outerRefs = refs.filter((r) => readsOuter(innerRel, outerScope, r.parts));
		if (!outerRefs.length) {
			inner.push(c);
			continue;
		}
		if (c.k === 'bin' && c.op === '=') {
			const side = (x) => {
				const rs = columnRefs(x);
				const out = rs.filter((r) => readsOuter(innerRel, outerScope, r.parts));
				if (!rs.length) return 'const';
				if (out.length === rs.length) return 'outer';
				if (!out.length) return 'inner';
				return 'mixed';
			};
			const l = side(c.l);
			const r = side(c.r);
			if (l === 'inner' && r === 'outer') {
				pairs.push({ inner: c.l, outer: c.r });
				continue;
			}
			if (l === 'outer' && r === 'inner') {
				pairs.push({ inner: c.r, outer: c.l });
				continue;
			}
		}
		throw fallback('has a correlated subquery condition that is not an equality between the subquery and the outer query');
	}
	return { inner, pairs };
}

function isSimpleSelect(query) {
	const b = query.body;
	return b.k === 'select' && !query.with.length && !query.orderBy.length && !query.limit && !b.groupBy && !b.groupAll && !b.having && !b.qualify && !b.distinct && b.top === undefined && b.from;
}

function readsOuter(innerRel, scope, parts) {
	let inner;
	try {
		inner = resolveIn(innerRel, parts);
	} catch {
		return false;
	}
	if (inner !== undefined) return false;
	try {
		return Boolean(lookup(scope, parts));
	} catch {
		return false;
	}
}

function isCorrelated(query, scope, env) {
	if (!isSimpleSelect(query)) return false;
	const innerRel = planFrom(query.body.from, env, new Map(), []);
	for (const c of conjuncts(query.body.where)) {
		for (const r of columnRefs(c)) if (readsOuter(innerRel, scope, r.parts)) return { innerRel };
	}
	for (const item of query.body.items) {
		for (const r of columnRefs(item.e)) if (readsOuter(innerRel, scope, r.parts)) throw fallback('has a subquery whose select list reads the outer query');
	}
	return false;
}

function constKey(rel, env) {
	const name = env.graph.temp('one');
	return { rel: addFormula(rel, [{ name, expression: '1' }], env, 'Join key'), name };
}

/** TRY_CAST of a text column: a plain CAST of text fails the whole Snowflake statement on one bad value. */
function tryCastColumn(name, target, env) {
	return tryCastText(backtick(name), target, env);
}

function tryCastText(text, target, env) {
	const cast = { k: 'cast', e: { k: 'col', parts: [{ name: '', quoted: true }] }, type: KEY_CAST_TYPES[target], try: true };
	return formula(cast, { rel: null }, env, { column: () => text });
}

const KEY_CAST_TYPES = { LONG: { name: 'BIGINT' }, DECIMAL: { name: 'NUMBER', args: ['38', '10'] }, DOUBLE: { name: 'DOUBLE' }, DATE: { name: 'DATE' }, DATETIME: { name: 'TIMESTAMP' } };

/**
 * ADR fails a join whose key pair is STRING on one side and a number or date on the other ("tableReference is null",
 * live-checked). Snowflake compares such a pair by converting the text, so the text side gets a TRY_CAST key.
 */
function alignKeyTypes(left, right, keys, env) {
	const typeOf = (rel, name) => rel.node.columns?.find((c) => c.name === name)?.type;
	const castKey = (rel, name, target) => {
		const temp = env.graph.temp('kc');
		const expression = tryCastColumn(name, target, env);
		return { rel: addFormula(rel, [{ name: temp, expression, type: target }], env, 'Join key type'), name: temp };
	};
	const aligned = [];
	for (const [l, r] of keys) {
		const lt = typeOf(left, l);
		const rt = typeOf(right, r);
		if (lt === 'STRING' && KEY_CAST_TYPES[rt]) {
			const k = castKey(left, l, rt);
			left = k.rel;
			aligned.push([k.name, r]);
		} else if (rt === 'STRING' && KEY_CAST_TYPES[lt]) {
			const k = castKey(right, r, lt);
			right = k.rel;
			aligned.push([l, k.name]);
		} else aligned.push([l, r]);
	}
	return { left, right, keys: aligned };
}

function leftJoin(left, right, keys, env, label) {
	({ left, right, keys } = alignKeyTypes(left, right, keys, env));
	const columns = left.node.columns && right.node.columns ? [...left.node.columns, ...right.node.columns] : null;
	const node = env.graph.add({ op: 'join', joinType: 'LEFT OUTER', keys, rightRenames: [] }, [left.node, right.node], columns, label);
	return { node, sources: left.sources };
}

/** Select only `fields` (working -> new name) of a relation. */
function project(rel, fields, env, label = 'Select columns') {
	const node = env.graph.add({ op: 'select', fields: fields.map(([name, rename]) => (rename && rename !== name ? { name, rename } : { name })) }, [rel.node], fields.map(([name, rename]) => ({ name: rename ?? name, type: rel.node.columns?.find((c) => c.name === name)?.type })), label);
	return { node, sources: [{ names: new Set(), cols: new Map(fields.map(([, r]) => [r, r])) }] };
}

function joinSubquery(rel, node, safe, scope, env) {
	const query = node.query;
	const corr = isCorrelated(query, scope.outer ? scope : scope, env);
	const marker = env.graph.temp('m');
	if (!corr) {
		const sub = planQuery(query, env, new Map());
		if (node.k === 'subquery') {
			const cols = sub.node.columns;
			if (!cols || cols.length !== 1) throw fallback('has a scalar subquery that does not return exactly one column');
			const value = env.graph.temp('s');
			const body = query.body;
			const single = body.k === 'select' && !body.groupBy && body.items.length === 1 && hasAggregate(body.items[0].e);
			if (!single) env.issue('warning', 'magic.scalar-subquery', 'A scalar subquery becomes a join; it must return at most one row, as Snowflake requires.');
			let right = project(sub, [[cols[0].name, value]], env);
			const rk = constKey(right, env);
			const lk = constKey(rel, env);
			const joined = leftJoin(lk.rel, rk.rel, [[lk.name, rk.name]], env, 'Join scalar subquery');
			scope.replacements.set(node, backtick(value));
			return joined;
		}
		if (node.k === 'exists') {
			const limited = derive(sub, env.graph.add({ op: 'limit', limit: 1, offset: 0 }, [sub.node], sub.node.columns, 'First row'));
			const one = env.graph.temp('one');
			const right = derive(limited, env.graph.add({ op: 'formula', fields: [{ name: one, expression: '1' }, { name: marker, expression: '1' }] }, [limited.node], formulaColumns(limited.node.columns, [{ name: one }, { name: marker }]), 'Exists marker'));
			const slim = project(right, [[one, one], [marker, marker]], env);
			const lk = constKey(rel, env);
			scope.replacements.set(node, `(${backtick(marker)} IS ${node.not ? '' : 'NOT '}NULL)`);
			return leftJoin(lk.rel, slim, [[lk.name, one]], env, 'Join EXISTS subquery');
		}
		const cols = sub.node.columns;
		if (!cols || cols.length !== 1) throw fallback('has an IN subquery that does not return exactly one column');
		return joinIn(rel, node, safe, scope, env, sub, cols[0].name, [], []);
	}
	const innerRel0 = corr.innerRel;
	const { inner, pairs } = correlation(query, innerRel0, scope);
	const innerScope = { rel: innerRel0, replacements: new Map() };
	let innerRel = inner.length ? addFilter(innerRel0, formula(andAll(inner), innerScope, env), env, 'Filter subquery') : innerRel0;
	const innerKeys = [];
	const outerKeys = [];
	let outerRel = rel;
	for (const p of pairs) {
		const ik = asColumn(innerRel, p.inner, innerScope, env);
		innerRel = ik.rel;
		innerKeys.push(ik.name);
		const ok = asColumn(outerRel, p.outer, scope, env);
		outerRel = ok.rel;
		outerKeys.push(ok.name);
	}
	if (node.k === 'subquery') {
		const item = oneColumnQuery(query);
		if (!item) throw fallback('has a correlated scalar subquery that does not select one value');
		const value = env.graph.temp('s');
		const gk = innerKeys.map(() => env.graph.temp('ck'));
		let right;
		if (hasAggregate(item.e)) {
			const fields = [{ name: value, expression: toMagic(item.e, exprCtx({ ...innerScope, rel: innerRel }, env, { aggregates: true })) }];
			const grouped = env.graph.add({ op: 'group', groups: innerKeys, fields }, [innerRel.node], [...innerKeys.map((k) => ({ name: k })), { name: value }], 'Aggregate subquery');
			right = project({ node: grouped, sources: [] }, [...innerKeys.map((k, n) => [k, gk[n]]), [value, value]], env);
		} else {
			env.issue('warning', 'magic.scalar-subquery', 'A correlated scalar subquery becomes a join; it must return at most one row per outer row, as Snowflake requires.');
			const v = asColumn(innerRel, item.e, innerScope, env, 'v');
			right = project(v.rel, [...innerKeys.map((k, n) => [k, gk[n]]), [v.name, value]], env);
		}
		const isCount = item.e.k === 'fn' && (item.e.name === 'COUNT' || item.e.name === 'COUNT_IF');
		scope.replacements.set(node, isCount ? `IFNULL(${backtick(value)}, 0)` : backtick(value));
		return leftJoin(outerRel, right, outerKeys.map((k, n) => [k, gk[n]]), env, 'Join correlated subquery');
	}
	if (node.k === 'exists') {
		const gk = innerKeys.map(() => env.graph.temp('ck'));
		let right = project(innerRel, innerKeys.map((k, n) => [k, gk[n]]), env);
		right = derive(right, env.graph.add({ op: 'unique', fields: gk }, [right.node], right.node.columns, 'Distinct keys'));
		right = addFormula(right, [{ name: marker, expression: '1' }], env, 'Exists marker');
		scope.replacements.set(node, `(${backtick(marker)} IS ${node.not ? '' : 'NOT '}NULL)`);
		return leftJoin(outerRel, right, outerKeys.map((k, n) => [k, gk[n]]), env, 'Join EXISTS subquery');
	}
	const item = oneColumnQuery(query);
	if (!item) throw fallback('has a correlated IN subquery that does not select one value');
	const v = asColumn(innerRel, item.e, innerScope, env, 'v');
	return joinIn(outerRel, node, safe, scope, env, v.rel, v.name, innerKeys, outerKeys);
}

/** `x [NOT] IN (subquery)` as a left join on the value (and correlation keys) plus a NULL-aware formula. */
function joinIn(rel, node, safe, scope, env, sub, valueName, innerKeys, outerKeys) {
	const marker = env.graph.temp('m');
	const val = env.graph.temp('iv');
	const gk = innerKeys.map(() => env.graph.temp('ck'));
	let right = project(sub, [[valueName, val], ...innerKeys.map((k, n) => [k, gk[n]])], env);
	right = derive(right, env.graph.add({ op: 'unique', fields: [val, ...gk] }, [right.node], right.node.columns, 'Distinct values'));
	right = addFormula(right, [{ name: marker, expression: '1' }], env, 'IN marker');
	const x = asColumn(rel, node.e, scope, env, 'x');
	let joined = leftJoin(x.rel, right, [[x.name, val], ...outerKeys.map((k, n) => [k, gk[n]])], env, `Join ${node.not ? 'NOT IN' : 'IN'} subquery`);
	if (safe && !node.not) {
		scope.replacements.set(node, `(${backtick(marker)} IS NOT NULL)`);
		return joined;
	}
	const nulls = env.graph.temp('hn');
	const counted = env.graph.add({ op: 'group', groups: gk.length ? [...gk] : [], fields: [{ name: nulls, expression: `SUM(CASE WHEN ${backtick(val)} IS NULL THEN 1 ELSE 0 END)` }] }, [right.node], [...gk.map((k) => ({ name: k })), { name: nulls }], 'Count NULL values');
	let countRel = { node: counted, sources: [] };
	let leftKeys;
	let rightKeys;
	if (gk.length) {
		const ck = gk.map(() => env.graph.temp('ck'));
		countRel = project(countRel, [...gk.map((k, n) => [k, ck[n]]), [nulls, nulls]], env);
		leftKeys = outerKeys;
		rightKeys = ck;
	} else {
		const rk = constKey(countRel, env);
		const lk = constKey(joined, env);
		joined = lk.rel;
		countRel = project(rk.rel, [[rk.name, rk.name], [nulls, nulls]], env);
		leftKeys = [lk.name];
		rightKeys = [rk.name];
	}
	joined = leftJoin(joined, countRel, leftKeys.map((k, n) => [k, rightKeys[n]]), env, 'Join NULL count');
	const verdict = `(CASE WHEN ${backtick(x.name)} IS NULL THEN NULL WHEN ${backtick(marker)} IS NOT NULL THEN 1 WHEN IFNULL(${backtick(nulls)}, 0) > 0 THEN NULL ELSE 0 END)`;
	scope.replacements.set(node, `(${verdict} = ${node.not ? 0 : 1})`);
	return joined;
}

/* FROM */

function planFrom(item, env, ctes, pending) {
	switch (item.k) {
		case 'table': {
			const name = item.parts.length === 1 ? canonical(item.parts[0]) : undefined;
			if (name && ctes.has(name)) {
				const cte = ctes.get(name);
				if (!cte.rel) cte.rel = planQuery(cte.query, env, cte.scope, cte.columns);
				return { node: cte.rel.node, sources: [sourceFromNode(cte.rel.node, new Set([item.alias ? canonical(item.alias) : name]))] };
			}
			const node = tableNode(item.parts, env);
			const key = node.op === 'input' ? node.table : tableKey(item.parts, env);
			let rel = { node, sources: [sourceFromNode(node, qualifierNames(key, item.alias))] };
			if (item.columns) rel = renameColumns(rel, item.columns, env);
			return rel;
		}
		case 'derived': {
			const rel = planQuery(item.query, env, ctes, item.columns);
			return { node: rel.node, sources: [sourceFromNode(rel.node, new Set(item.alias ? [canonical(item.alias)] : []))] };
		}
		case 'values':
			throw fallback('selects FROM VALUES');
		case 'join':
			return planJoin(item, env, ctes, pending);
		case 'pivot':
			return planPivot(item, env, ctes);
		case 'unpivot':
			return planUnpivot(item, env, ctes);
		default:
			throw new TranslateError(`uses ${item.k} in FROM`);
	}
}

function renameColumns(rel, names, env) {
	const cols = rel.node.columns;
	if (!cols) throw fallback('renames the columns of a table whose columns are unknown');
	const visible = cols.filter((c) => !isHelper(c.name));
	if (names.length > visible.length) throw new TranslateError('names more columns than the table has');
	const fields = visible.map((c, k) => [c.name, names[k] ? canonical(names[k]) : c.name]);
	const out = project(rel, fields, env, 'Rename columns');
	return { node: out.node, sources: [{ names: rel.sources[0].names, cols: out.sources[0].cols }] };
}

function sideOf(e, left, right) {
	const refs = columnRefs(e);
	if (!refs.length) return 'none';
	let l = false;
	let r = false;
	for (const ref of refs) {
		const inL = resolveIn(left, ref.parts) !== undefined;
		const inR = resolveIn(right, ref.parts) !== undefined;
		if (inL && inR) throw new TranslateError(`refers to the ambiguous column ${ref.parts.map((p) => p.name).join('.')}`);
		if (inL) l = true;
		else if (inR) r = true;
		else return 'outside';
	}
	return l && r ? 'both' : l ? 'left' : 'right';
}

const JOIN_TYPES = { INNER: 'INNER', CROSS: 'INNER', LEFT: 'LEFT OUTER', RIGHT: 'RIGHT OUTER', FULL: 'FULL OUTER' };

function planJoin(item, env, ctes, pending) {
	if (item.natural) throw fallback('uses NATURAL JOIN');
	let left = planFrom(item.l, env, ctes, pending);
	let right = planFrom(item.r, env, ctes, pending);
	if (!left.node.columns || !right.node.columns) throw fallback('joins a table whose columns are unknown, so column name clashes cannot be resolved');
	const type = item.type;
	let on = item.on ? conjuncts(item.on).filter((c) => !isConstantTrue(c)) : [];
	if (item.using) {
		if (type !== 'INNER' && type !== 'LEFT') throw fallback(`uses ${type} JOIN ... USING`);
		const keysL = item.using.map((u) => resolveIn(left, [u]));
		const keysR = item.using.map((u) => resolveIn(right, [u]));
		if (keysL.some((k) => k === undefined) || keysR.some((k) => k === undefined)) throw new TranslateError('joins USING a column one side lacks');
		return finishJoin(left, right, type, keysL.map((k, n) => [k, keysR[n]]), [], env, new Set(keysR), item.using.map(canonical));
	}
	if (type === 'CROSS' && pending) {
		const taken = [];
		for (const c of pending) {
			if (c.k === 'bin' && c.op === '=' && !hasSubquery(c)) {
				let sl;
				let sr;
				try {
					sl = sideOf(c.l, left, right);
					sr = sideOf(c.r, left, right);
				} catch {
					continue;
				}
				if ((sl === 'left' && sr === 'right') || (sl === 'right' && sr === 'left')) taken.push(c);
			}
		}
		for (const c of taken) pending.splice(pending.indexOf(c), 1);
		on = taken;
	}
	const keys = [];
	const residual = { left: [], right: [], both: [] };
	const leftScope = { rel: left };
	const rightScope = { rel: right };
	const leftKeyExprs = [];
	const rightKeyExprs = [];
	for (const c of on) {
		if (hasSubquery(c)) throw fallback('has a subquery in a join condition');
		if (c.k === 'bin' && c.op === '=') {
			const sl = sideOf(c.l, left, right);
			const sr = sideOf(c.r, left, right);
			if (sl === 'left' && sr === 'right') {
				leftKeyExprs.push(c.l);
				rightKeyExprs.push(c.r);
				continue;
			}
			if (sl === 'right' && sr === 'left') {
				leftKeyExprs.push(c.r);
				rightKeyExprs.push(c.l);
				continue;
			}
		}
		const s = sideOf(c, left, right);
		if (s === 'outside') throw fallback('has a join condition that reads a column outside the joined tables');
		residual[s === 'none' ? 'both' : s].push(c);
	}
	for (let n = 0; n < leftKeyExprs.length; n++) {
		const lk = asColumn(left, leftKeyExprs[n], leftScope, env);
		left = lk.rel;
		leftScope.rel = left;
		const rk = asColumn(right, rightKeyExprs[n], rightScope, env);
		right = rk.rel;
		rightScope.rel = right;
		keys.push([lk.name, rk.name]);
	}
	const after = [];
	const jt = JOIN_TYPES[type];
	const filterSide = (side, list) => {
		const scopeOf = side === 'left' ? leftScope : rightScope;
		const expression = formula(andAll(list), scopeOf, env);
		if (side === 'left') left = addFilter(left, expression, env, 'Filter before join');
		else right = addFilter(right, expression, env, 'Filter before join');
		scopeOf.rel = side === 'left' ? left : right;
	};
	const gateSide = (side, list) => {
		const gate = env.graph.temp('jc');
		const other = env.graph.temp('jc');
		const scopeOf = side === 'left' ? leftScope : rightScope;
		const expression = `CASE WHEN ${formula(andAll(list), scopeOf, env)} THEN 1 END`;
		if (side === 'left') {
			left = addFormula(left, [{ name: gate, expression }], env, 'Join condition');
			right = addFormula(right, [{ name: other, expression: '1' }], env, 'Join condition');
			keys.push([gate, other]);
		} else {
			right = addFormula(right, [{ name: gate, expression }], env, 'Join condition');
			left = addFormula(left, [{ name: other, expression: '1' }], env, 'Join condition');
			keys.push([other, gate]);
		}
		leftScope.rel = left;
		rightScope.rel = right;
	};
	if (jt === 'INNER') {
		if (residual.left.length) filterSide('left', residual.left);
		if (residual.right.length) filterSide('right', residual.right);
		after.push(...residual.both);
	} else if (jt === 'LEFT OUTER') {
		if (residual.right.length) filterSide('right', residual.right);
		if (residual.left.length) gateSide('left', residual.left);
		if (residual.both.length) throw fallback('has a LEFT JOIN condition other than equalities that reads both tables');
	} else if (jt === 'RIGHT OUTER') {
		if (residual.left.length) filterSide('left', residual.left);
		if (residual.right.length) gateSide('right', residual.right);
		if (residual.both.length) throw fallback('has a RIGHT JOIN condition other than equalities that reads both tables');
	} else if (residual.left.length || residual.right.length || residual.both.length) throw fallback('has a FULL JOIN condition other than equalities');
	if (!keys.length) {
		if (jt !== 'INNER' && after.length) throw fallback('has an outer join with no equality condition');
		const lk = constKey(left, env);
		const rk = constKey(right, env);
		left = lk.rel;
		right = rk.rel;
		keys.push([lk.name, rk.name]);
	}
	let joined = finishJoin(left, right, type, keys, after, env);
	return joined;
}

function finishJoin(left, right, type, keys, after, env, removeRight = new Set(), usingNames = []) {
	({ left, right, keys } = alignKeyTypes(left, right, keys, env));
	// ADR compares column names without case ("Duplicate column name" for FY next to fy, live-checked on a real run).
	const taken = new Set(left.node.columns.map((c) => c.name.toUpperCase()));
	const renames = [];
	const renameMap = new Map();
	for (const c of right.node.columns) {
		if (removeRight.has(c.name)) {
			renames.push({ name: c.name, rename: c.name, remove: true });
			continue;
		}
		if (!taken.has(c.name.toUpperCase())) {
			taken.add(c.name.toUpperCase());
			continue;
		}
		let n = 2;
		let name = `${c.name}_${n}`;
		while (taken.has(name.toUpperCase())) name = `${c.name}_${++n}`;
		taken.add(name.toUpperCase());
		renames.push({ name: c.name, rename: name });
		renameMap.set(c.name, name);
	}
	const columns = [...left.node.columns, ...right.node.columns.filter((c) => !removeRight.has(c.name)).map((c) => ({ ...c, name: renameMap.get(c.name) ?? c.name }))];
	const node = env.graph.add({ op: 'join', joinType: JOIN_TYPES[type], keys, rightRenames: renames }, [left.node, right.node], columns, `${type === 'CROSS' ? 'Cross' : type.charAt(0) + type.slice(1).toLowerCase()} join`);
	const rightSources = right.sources.map((s) => ({ names: s.names, cols: s.cols ? new Map([...s.cols].filter(([, w]) => !removeRight.has(w)).map(([k, w]) => [k, renameMap.get(w) ?? w])) : null }));
	if (usingNames.length) for (const s of rightSources) for (const u of usingNames) s.cols?.delete(u);
	let rel = { node, sources: [...left.sources, ...rightSources] };
	if (after.length) rel = addFilter(rel, formula(andAll(after), { rel }, env), env, 'Join condition');
	return rel;
}

/* SELECT */

function aggregateCalls(e) {
	const out = [];
	walkExpr(e, (n) => {
		if (n.k === 'fn' && n.over) return false;
		if (n.k === 'fn' && AGGREGATES.has(n.name)) {
			out.push(n);
			return false;
		}
		return undefined;
	});
	return out;
}

function windowCalls(e) {
	const out = [];
	walkExpr(e, (n) => {
		if (n.k === 'fn' && n.over) {
			out.push(n);
			return false;
		}
		return undefined;
	});
	return out;
}

function expandItems(sel, rel) {
	const out = [];
	for (const item of sel.items) {
		if (item.e.k !== 'star') {
			out.push(item);
			continue;
		}
		const qualifier = item.e.qualifier?.map(canonical).join('.');
		const sources = qualifier ? rel.sources.filter((s) => s.names.has(qualifier)) : rel.sources;
		if (qualifier && !sources.length) throw new TranslateError(`selects ${qualifier}.*, which is not in FROM`);
		const exclude = new Set((item.e.exclude ?? []).map(canonical));
		const replace = new Map((item.e.replace ?? []).map((r) => [canonical(r.name), r.e]));
		const rename = new Map((item.e.rename ?? []).map((r) => [canonical(r.from), canonical(r.name)]));
		for (const s of sources) {
			if (!s.cols) return null;
			for (const [name, working] of s.cols) {
				if (exclude.has(name)) continue;
				const alias = { name: rename.get(name) ?? name, quoted: true };
				if (replace.has(name)) out.push({ e: replace.get(name), alias });
				else out.push({ e: { k: 'col', parts: [{ name: working, quoted: true }] }, alias, working });
			}
		}
	}
	return out;
}

/**
 * @param {import('./parser.js').QueryBody & { k: 'select' }} sel
 * @param {{ orderBy?: import('./parser.js').OrderItem[], limit?: Expr, offset?: Expr }} [tail]
 * @returns {Rel}
 */
function planSelect(sel, env, ctes, tail = {}) {
	const pending = conjuncts(sel.where).filter((c) => !isConstantTrue(c));
	if (!sel.from) throw fallback('selects without FROM (constant rows)');
	let rel = planFrom(sel.from, env, ctes, pending);
	const scope = { rel, replacements: new Map(), aliases: new Map() };
	for (const item of sel.items) if (item.alias && item.e.k !== 'star') scope.aliases.set(canonical(item.alias), item.e);

	if (pending.length) {
		rel = attachSubqueries(rel, pending, scope, env, { condition: true });
		scope.rel = rel;
		rel = addFilter(rel, formula(andAll(pending), scope, env), env, 'Filter rows (WHERE)');
		scope.rel = rel;
	}

	let items = expandItems(sel, rel);
	const starUnknown = items === null;
	if (starUnknown) {
		if (sel.items.some((i) => i.e.k === 'star' && i.e.qualifier) || rel.sources.length > 1) throw fallback('selects * from a table whose columns are unknown');
		items = sel.items.filter((i) => i.e.k !== 'star');
	}

	const grouped = Boolean(sel.groupBy || sel.groupAll || sel.having) || items.some((i) => hasAggregate(i.e)) || (sel.qualify && hasAggregate(sel.qualify));
	if (grouped && starUnknown) throw fallback('groups rows while selecting * from a table whose columns are unknown');

	const valueExprs = [...items.map((i) => i.e), ...(sel.having ? [sel.having] : []), ...(sel.qualify ? [sel.qualify] : []), ...(tail.orderBy ?? []).map((o) => o.e)];
	if (!grouped) {
		rel = attachSubqueries(rel, items.map((i) => i.e), scope, env);
		scope.rel = rel;
	}

	let post = scope;
	if (grouped) {
		const result = planGroup(sel, items, rel, scope, env, tail);
		rel = result.rel;
		post = result.scope;
	}

	const windows = valueExprs.flatMap(windowCalls);
	if (windows.length) {
		rel = planWindows(windows, rel, post, env);
		post.rel = rel;
	}
	if (sel.qualify) {
		rel = attachSubqueries(rel, [sel.qualify], post, env, { condition: true });
		post.rel = rel;
		rel = addFilter(rel, formula(sel.qualify, post, env), env, 'Filter rows (QUALIFY)');
		post.rel = rel;
	}

	const limit = tail.limit ?? (sel.top !== undefined ? { k: 'num', v: String(sel.top) } : undefined);
	if (limit && !sel.distinct) {
		rel = applyLimit(rel, tail.orderBy ?? [], limit, tail.offset, post, env);
		post.rel = rel;
	}

	rel = planProjection(items, rel, post, env, starUnknown);
	if (sel.distinct) {
		rel = derive(rel, env.graph.add({ op: 'unique', fields: [] }, [rel.node], rel.node.columns, 'Remove duplicates (DISTINCT)'));
		if (limit) {
			const outScope = { rel, replacements: new Map() };
			rel = applyLimit(rel, tail.orderBy ?? [], limit, tail.offset, outScope, env);
			rel = dropColumns(rel, helperColumns(rel.node), env);
		}
	}
	return rel;
}

function planGroup(sel, items, rel, scope, env, tail) {
	let groupExprs = [];
	if (sel.groupAll) groupExprs = items.filter((i) => !hasAggregate(i.e) && !hasWindow(i.e)).map((i) => i.e);
	else {
		for (const g of sel.groupBy ?? []) {
			if (g.k === 'num') {
				const item = items[Number(g.v) - 1];
				if (!item) throw new TranslateError(`groups by position ${g.v}, past the select list`);
				groupExprs.push(item.e);
			} else if (g.k === 'col' && g.parts.length === 1 && resolveIn(rel, g.parts) === undefined && scope.aliases.has(canonical(g.parts[0]))) {
				groupExprs.push(scope.aliases.get(canonical(g.parts[0])));
			} else groupExprs.push(g);
		}
	}
	for (const g of groupExprs) if (hasSubquery(g) || hasAggregate(g) || hasWindow(g)) throw fallback('groups by an expression with a subquery, aggregate or window');
	const keyCols = [];
	const keyMap = new Map();
	const pre = [];
	for (const g of groupExprs) {
		const k = exprKey(g, scope);
		if (keyMap.has(k)) continue;
		let name;
		if (g.k === 'col') name = resolveIn(rel, g.parts);
		if (name === undefined) {
			name = env.graph.temp('g');
			pre.push({ name, expression: formula(g, scope, env) });
		}
		keyMap.set(k, name);
		keyCols.push(name);
	}
	if (pre.length) {
		rel = addFormula(rel, pre, env, 'Group keys');
		scope.rel = rel;
	}
	const aggExprs = [...items.map((i) => i.e), ...(sel.having ? [sel.having] : []), ...(sel.qualify ? [sel.qualify] : []), ...(tail.orderBy ?? []).map((o) => o.e)];
	for (const e of aggExprs) for (const a of aggregateCalls(e)) if (hasSubquery(a)) throw fallback('has a subquery inside an aggregate');
	const aggMap = new Map();
	const fields = [];
	for (const e of aggExprs) {
		for (const call of aggregateCalls(e)) {
			const k = exprKey(call, scope);
			if (aggMap.has(k)) continue;
			const name = env.graph.temp('a');
			fields.push({ name, expression: toMagic(call, exprCtx(scope, env, { aggregates: true })) });
			aggMap.set(k, name);
		}
	}
	const node = env.graph.add({ op: 'group', groups: keyCols, fields }, [rel.node], [...keyCols.map((k) => ({ name: k, type: rel.node.columns?.find((c) => c.name === k)?.type })), ...fields.map((f) => ({ name: f.name }))], 'Group by');
	const keySet = new Set(keyCols);
	const groupedRel = { node, sources: rel.sources.map((s) => ({ names: s.names, cols: s.cols ? new Map([...s.cols].filter(([, w]) => keySet.has(w))) : new Map() })) };
	const post = {
		rel: groupedRel,
		aliases: scope.aliases,
		replacements: new Map(scope.replacements),
		groupMatch: { keyMap, aggMap, pre: scope }
	};
	const baseReplace = post.replacements;
	post.replacements = {
		has: (n) => baseReplace.has(n),
		set: (n, v) => baseReplace.set(n, v),
		get: (n) => {
			if (baseReplace.has(n)) return baseReplace.get(n);
			if (!n || typeof n !== 'object' || !n.k || n.k === 'num' || n.k === 'str' || n.k === 'null' || n.k === 'bool') return undefined;
			if (n.k === 'fn' && n.over) return undefined;
			const k = exprKey(n, scope);
			if (aggMap.has(k)) return backtick(aggMap.get(k));
			if (keyMap.has(k)) return backtick(keyMap.get(k));
			if (n.k === 'col') {
				const hit = (() => {
					try {
						return resolveIn(scope.rel, n.parts);
					} catch {
						return undefined;
					}
				})();
				if (hit !== undefined && !keySet.has(hit)) {
					const name = n.parts.length === 1 ? canonical(n.parts[0]) : undefined;
					if (name && scope.aliases.has(name) && !n.parts[0].quoted) return undefined;
					throw new TranslateError(`selects ${n.parts.map((p) => p.name).join('.')}, which is neither grouped nor aggregated`);
				}
			}
			return undefined;
		}
	};
	if (sel.having) {
		let r = attachSubqueries(groupedRel, [sel.having], post, env, { condition: true });
		post.rel = r;
		r = addFilter(r, formula(sel.having, post, env), env, 'Filter groups (HAVING)');
		post.rel = r;
		return { rel: r, scope: post };
	}
	return { rel: groupedRel, scope: post };
}

const RANKING = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK']);
const OFFSET = new Set(['LAG', 'LEAD']);
// Rank & Window "FRAMED" operations (live-checked: SUM, AVERAGE and COUNT only). Their frame counts rows, and with no
// bounds runs from the partition start to the current row.
const FRAMED = new Set(['SUM', 'AVG', 'COUNT']);

function framedColumn(call, colFor) {
	if (call.star || call.distinct || call.args.length !== 1) throw fallback(`uses ${call.name}(${call.star ? '*' : 'DISTINCT ...'}) as a window function`);
	return colFor(call.args[0]);
}

/** Snowflake's frame as the tile's row counts; only explicit ROWS frames match, since the implicit one is RANGE. */
function framedBounds(call) {
	const frame = call.over.frame;
	if (!call.over.order.length) throw fallback(`uses ${call.name} over a whole partition (no ORDER BY), which a Rank & Window frame does not express`);
	if (!frame) throw fallback(`uses ${call.name} with ORDER BY and Snowflake's default RANGE frame (ties share a value), while Rank & Window frames count rows`);
	if (frame.unit !== 'ROWS') throw fallback(`uses a ${frame.unit} window frame`);
	const { start, end } = frame;
	let preceding;
	if (start.kind === 'UNBOUNDED' && start.dir === 'PRECEDING') preceding = null;
	else if (start.kind === 'CURRENT') preceding = 0;
	else if (start.kind === 'OFFSET' && start.dir === 'PRECEDING') preceding = start.n;
	else throw fallback('has a window frame that starts after the current row');
	let following;
	if (end.kind === 'CURRENT') following = 0;
	else if (end.kind === 'OFFSET' && end.dir === 'FOLLOWING') following = end.n;
	else throw fallback('has a window frame that ends before the current row or runs to the partition end');
	return { preceding, following };
}

function planWindows(calls, rel, scope, env) {
	const groups = new Map();
	const pre = [];
	const colFor = (e) => {
		if (e.k === 'col') {
			const replaced = scope.replacements?.get?.(e);
			if (replaced && /^`[^`]+`$/.test(replaced)) return replaced.slice(1, -1);
			const hit = resolveIn(rel, e.parts);
			if (hit !== undefined) return hit;
		}
		const text = formula(e, scope, env);
		const m = /^`((?:[^`]|``)+)`$/.exec(text);
		if (m) return m[1].replace(/``/g, '`');
		const name = env.graph.temp('w');
		pre.push({ name, expression: text });
		return name;
	};
	const planned = [];
	for (const call of calls) {
		if (call.over.ref) throw fallback('uses a named window');
		if (hasSubquery(call)) throw fallback('has a subquery inside a window function');
		const partition = call.over.partition.map(colFor);
		const order = call.over.order.map((o) => {
			if (o.nulls && o.nulls !== (o.desc ? 'FIRST' : 'LAST')) throw fallback('orders a window with non-default NULLS FIRST/LAST');
			return { name: colFor(o.e), asc: !o.desc };
		});
		let addition;
		const name = env.graph.temp('win');
		if (RANKING.has(call.name)) {
			if (call.over.frame) throw fallback(`gives ${call.name} a window frame`);
			addition = { name, fn: call.name };
		} else if (OFFSET.has(call.name)) {
			if (call.ignoreNulls) throw fallback(`uses ${call.name} ... IGNORE NULLS`);
			const column = colFor(call.args[0]);
			const amount = call.args[1] ? Number(call.args[1].v) : 1;
			if (call.args[1] && call.args[1].k !== 'num') throw fallback(`uses ${call.name} with a non-constant offset`);
			let defaultValue = null;
			if (call.args[2]) {
				if (!['num', 'str', 'null', 'bool'].includes(call.args[2].k)) throw fallback(`uses ${call.name} with a non-constant default`);
				defaultValue = call.args[2].k === 'num' ? Number(call.args[2].v) : call.args[2].k === 'null' ? null : call.args[2].v;
			}
			addition = { name, fn: call.name, column, amount, defaultValue };
		} else if (FRAMED.has(call.name)) addition = { name, fn: call.name, column: framedColumn(call, colFor), frame: framedBounds(call) };
		else throw fallback(`uses ${call.name} as a window function, which the Rank & Window tile does not have`);
		const key = JSON.stringify({ partition, order });
		if (!groups.has(key)) groups.set(key, { partition, order, additions: [] });
		groups.get(key).additions.push(addition);
		planned.push([call, name]);
	}
	if (pre.length) rel = addFormula(rel, pre, env, 'Window inputs');
	for (const g of groups.values()) {
		const node = env.graph.add({ op: 'window', partition: g.partition, order: g.order, additions: g.additions }, [rel.node], formulaColumns(rel.node.columns, g.additions), 'Rank & window');
		rel = derive(rel, node);
	}
	for (const [call, name] of planned) scope.replacements.set(call, backtick(name));
	return rel;
}

function applyLimit(rel, orderBy, limit, offset, scope, env) {
	if (limit.k !== 'num' || (offset && offset.k !== 'num')) throw fallback('has a LIMIT or OFFSET that is not a number');
	const n = Number(limit.v);
	const skip = offset ? Number(offset.v) : 0;
	if (!orderBy.length) {
		env.issue('warning', 'magic.limit-unordered', `LIMIT ${n} without ORDER BY keeps an arbitrary ${n} rows, as in Snowflake.`);
		return derive(rel, env.graph.add({ op: 'limit', limit: n, offset: skip }, [rel.node], rel.node.columns, `Limit ${n}`));
	}
	const call = { k: 'fn', name: 'ROW_NUMBER', args: [], distinct: false, over: { partition: [], order: orderBy } };
	rel = planWindows([call], rel, scope, env);
	scope.rel = rel;
	const rn = scope.replacements.get(call);
	return addFilter(rel, skip ? `${rn} > ${skip} AND ${rn} <= ${skip + n}` : `${rn} <= ${n}`, env, `Top ${n}`);
}

function planProjection(items, rel, scope, env, passThrough) {
	if (passThrough) {
		const fields = [];
		for (const item of items) {
			const name = item.alias ? canonical(item.alias) : itemName(item);
			if (item.e.k === 'col' && !item.alias) continue;
			fields.push({ name, expression: valueFormula(item.e, scope, env), type: castType(item.e, scope) });
		}
		let r = addFormula(rel, fields, env, 'Add columns');
		const helpers = [...new Set([...helperColumns(r.node), ...collectHelpers(r.node)])];
		r = helpers.length ? dropColumns(r, helpers, env) : r;
		return { node: r.node, sources: [{ names: new Set(), cols: null }] };
	}
	const out = [];
	const formulas = [];
	const usedWorking = new Set();
	for (const item of items) {
		const name = item.alias ? canonical(item.alias) : itemName(item);
		if (!item.alias && item.e.k !== 'col') env.issue('info', 'magic.unnamed-column', `An unnamed select expression is named ${name}, Snowflake's name for it.`);
		let working;
		let copyOf;
		if (item.working) working = copyOf = item.working;
		else {
			const text = valueFormula(item.e, scope, env);
			const m = /^`((?:[^`]|``)+)`$/.exec(text);
			copyOf = m ? m[1].replace(/``/g, '`') : undefined;
			if (m && !usedWorking.has(copyOf)) working = copyOf;
			else {
				working = env.graph.temp('p');
				formulas.push({ name: working, expression: text, type: castType(item.e, scope) });
			}
		}
		usedWorking.add(working);
		out.push({ name, working, copyOf, star: Boolean(item.working), type: rel.node.columns?.find((c) => c.name === working)?.type ?? castType(item.e, scope) });
	}
	// `SELECT *, COL AS "Col"` is legal in Snowflake, but ADR compares names without case. When both are the same column,
	// the copy * brought in goes and the explicit name stays (Tableau matches either name without case).
	for (let k = out.length - 1; k >= 0; k--) {
		const o = out[k];
		if (!o.star || !o.copyOf) continue;
		const twin = out.find((x) => x !== o && x.name.toUpperCase() === o.name.toUpperCase() && x.copyOf === o.copyOf && !x.star);
		if (!twin) continue;
		env.issue('warning', 'magic.case-duplicate', `${o.name} and ${twin.name} are the same column under names that differ only in case, which ADR cannot hold; only ${twin.name} is kept.`);
		out.splice(k, 1);
	}
	const seen = new Set();
	for (const o of out) {
		if (seen.has(o.name.toUpperCase())) {
			let n = 2;
			while (seen.has(`${o.name}${DUPLICATE}${n}`.toUpperCase())) n++;
			o.name = `${o.name}${DUPLICATE}${n}`;
		}
		seen.add(o.name.toUpperCase());
	}
	let r = addFormula(rel, formulas, env, 'Compute columns');
	const identity = r.node.columns && r.node.columns.length === out.length && out.every((o, k) => r.node.columns[k].name === o.working && o.working === o.name);
	if (!identity) {
		const node = env.graph.add({ op: 'select', fields: out.map((o) => (o.working !== o.name ? { name: o.working, rename: o.name } : { name: o.working })) }, [r.node], out.map((o) => ({ name: o.name, ...(o.type ? { type: o.type } : {}) })), 'Select columns');
		r = { node, sources: [] };
	}
	return { node: r.node, sources: [{ names: new Set(), cols: new Map(out.map((o) => [o.name, o.name])) }] };
}

/** Helper columns added upstream of a node whose schema is unknown. */
function collectHelpers(node, memo = new Map()) {
	if (memo.has(node)) return memo.get(node);
	let out;
	if (node.columns) out = new Set(node.columns.filter((c) => isHelper(c.name)).map((c) => c.name));
	else if (node.op === 'input' || node.op === 'sql') out = new Set();
	else {
		out = new Set(node.deps.flatMap((d) => [...collectHelpers(d, memo)]));
		if (node.op === 'formula') for (const f of node.fields) if (isHelper(f.name)) out.add(f.name);
		if (node.op === 'window') for (const a of node.additions) out.add(a.name);
		if (node.op === 'drop') for (const d of node.names) out.delete(d);
	}
	memo.set(node, out);
	return out;
}

const NUMERIC = new Set(['LONG', 'DECIMAL', 'DOUBLE']);
const TYPED_FUNCTIONS = {
	STRING: ['CONCAT', 'TO_VARCHAR', 'TO_CHAR', 'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'RTRIM', 'LEFT', 'RIGHT', 'SUBSTR', 'SUBSTRING', 'REPLACE', 'LPAD', 'RPAD', 'INITCAP', 'SPLIT_PART', 'LISTAGG', 'DAYNAME', 'MONTHNAME'],
	LONG: ['COUNT', 'COUNT_IF', 'DATEDIFF', 'TIMESTAMPDIFF', 'YEAR', 'MONTH', 'DAY', 'QUARTER', 'DAYOFWEEK', 'DAYOFYEAR', 'WEEK', 'HOUR', 'MINUTE', 'SECOND', 'DATE_PART', 'LENGTH', 'LEN', 'POSITION', 'CHARINDEX', 'ROW_NUMBER', 'RANK', 'DENSE_RANK'],
	DECIMAL: ['SUM', 'AVG', 'ROUND', 'TO_NUMBER', 'TO_NUMERIC', 'TO_DECIMAL', 'TRY_TO_NUMBER', 'TRY_TO_NUMERIC', 'TRY_TO_DECIMAL', 'DIV0', 'DIV0NULL', 'ABS', 'TRUNC', 'TRUNCATE', 'FLOOR', 'CEIL', 'CEILING'],
	DATE: ['TO_DATE', 'TRY_TO_DATE', 'DATE', 'LAST_DAY', 'CURRENT_DATE', 'ADD_MONTHS'],
	DATETIME: ['CURRENT_TIMESTAMP', 'TO_TIMESTAMP', 'TO_TIMESTAMP_NTZ', 'GETDATE', 'SYSDATE']
};
const FUNCTION_TYPE = new Map(Object.entries(TYPED_FUNCTIONS).flatMap(([type, names]) => names.map((n) => [n, type])));

/** Magic type of an expression, where it is evident; used to keep a union's column types when a branch is a SQL tile. */
function castType(e, scope) {
	const of = (x) => castType(x, scope);
	if (isCondition(e)) return 'STRING';
	switch (e.k) {
		case 'cast':
			return magicType(e.type);
		case 'str':
			return 'STRING';
		case 'num':
			return /[.eE]/.test(e.v) ? 'DECIMAL' : 'LONG';
		case 'typed':
			return e.type === 'DATE' ? 'DATE' : 'DATETIME';
		case 'paren':
			return of(e.e);
		case 'col': {
			if (!scope) return undefined;
			try {
				const working = resolveIn(scope.rel, e.parts);
				return scope.rel.node.columns?.find((c) => c.name === working)?.type;
			} catch {
				return undefined;
			}
		}
		case 'bin': {
			if (e.op === '||') return 'STRING';
			if (!['+', '-', '*', '/', '%'].includes(e.op)) return undefined;
			const l = of(e.l);
			const r = of(e.r);
			if (!NUMERIC.has(l) || !NUMERIC.has(r)) return undefined;
			if (l === 'DOUBLE' || r === 'DOUBLE') return 'DOUBLE';
			return l === 'LONG' && r === 'LONG' && e.op !== '/' ? 'LONG' : 'DECIMAL';
		}
		case 'case':
			return [...e.whens.map(([, t]) => t), e.else].filter(Boolean).map(of).find(Boolean);
		case 'fn': {
			if (['COALESCE', 'NVL', 'IFNULL', 'NULLIF', 'IFF', 'GREATEST', 'LEAST', 'MIN', 'MAX', 'ANY_VALUE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE'].includes(e.name)) {
				const args = e.name === 'IFF' ? e.args.slice(1) : e.args;
				return args.map(of).find(Boolean);
			}
			if (e.name === 'DATEADD' || e.name === 'DATE_TRUNC') return of(e.args.at(-1)) ?? 'DATE';
			return FUNCTION_TYPE.get(e.name);
		}
		default:
			return undefined;
	}
}

/* Set operations and queries */

function planBody(body, env, ctes, tail) {
	switch (body.k) {
		case 'select':
			return planSelect(body, env, ctes, tail);
		case 'nested':
			return planQuery(body.query, env, ctes);
		case 'values':
			throw fallback('is a VALUES list');
		case 'setop': {
			if (body.op !== 'UNION') return planSetDifference(body, env, ctes);
			const branches = [];
			const flatten = (b) => {
				if (b.k === 'setop' && b.op === 'UNION' && b.all === body.all && Boolean(b.byName) === Boolean(body.byName)) {
					flatten(b.l);
					flatten(b.r);
				} else branches.push(b);
			};
			flatten(body);
			const rels = planBranches(branches, body.byName, env, ctes);
			if (body.byName) {
				// UNION BY NAME lines columns up by name and fills the missing ones with NULL, which is what Append Rows does.
				const columns = rels.every((r) => r.node.columns) ? [...new Map(rels.flatMap((r) => r.node.columns).map((c) => [c.name, c])).values()] : null;
				const node = env.graph.add({ op: 'union' }, rels.map((r) => r.node), columns, 'Append rows (BY NAME)');
				let rel = { node, sources: [sourceFromNode(node, new Set())] };
				if (!body.all) rel = derive(rel, env.graph.add({ op: 'unique', fields: [] }, [node], node.columns, 'Remove duplicates (UNION)'));
				return rel;
			}
			if (rels.some((r) => !r.node.columns)) throw fallback('unions a branch whose columns are unknown, so the columns cannot be lined up by position');
			const names = rels[0].node.columns.map((c) => c.name);
			const aligned = rels.map((r, k) => {
				if (r.node.columns.length !== names.length) throw new TranslateError(`unions branch ${k + 1} with ${r.node.columns.length} columns into ${names.length}`);
				if (r.node.columns.every((c, n) => c.name === names[n])) return r;
				return project(r, r.node.columns.map((c, n) => [c.name, names[n]]), env, 'Line up union columns');
			});
			const types = names.map((_, n) => rels.map((r) => r.node.columns[n].type).find(Boolean));
			const node = env.graph.add({ op: 'union' }, aligned.map((r) => r.node), names.map((name, n) => ({ name, ...(types[n] ? { type: types[n] } : {}) })), body.all ? 'Append rows (UNION ALL)' : 'Append rows (UNION)');
			let rel = { node, sources: [{ names: new Set(), cols: new Map(names.map((n) => [n, n])) }] };
			// A SQL tile branch of NULL placeholders comes out as text; Snowflake would keep the other branches' type.
			const casts = names
				.map((name, n) => ({ name, type: types[n] }))
				.filter((c, n) => c.type && c.type !== 'STRING' && rels.some((r) => !r.node.columns[n].type && r.node.op === 'sql'))
				.map((c) => ({ name: c.name, type: c.type, expression: KEY_CAST_TYPES[c.type] ? tryCastColumn(c.name, c.type, env) : `CAST(${backtick(c.name)} AS ${c.type})` }));
			rel = addFormula(rel, casts, env, 'Keep union column types');
			if (!body.all) rel = derive(rel, env.graph.add({ op: 'unique', fields: [] }, [rel.node], rel.node.columns, 'Remove duplicates (UNION)'));
			return rel;
		}
		default:
			throw new TranslateError(`has a ${body.k} query`);
	}
}

const NULL_KEY = "'#t2d#null#'";

/**
 * INTERSECT / EXCEPT (MINUS) as a left join on every column, NULLs matching NULLs as Snowflake's set operators do.
 * The SQL tile accepts these keywords but runs them as UNION (live-checked), so they never fall back to it.
 */
function planSetDifference(body, env, ctes) {
	if (body.all) throw new TranslateError(`uses ${body.op} ALL`);
	if (body.byName) throw new TranslateError(`uses ${body.op} BY NAME`);
	const strict = (fn) => {
		try {
			return fn();
		} catch (err) {
			if (err instanceof TranslateError && err.fallback) throw new TranslateError(`${err.message} inside ${body.op}, which the SQL tile runs as UNION`);
			throw err;
		}
	};
	let left = strict(() => planBody(body.l, env, ctes, {}));
	let right = strict(() => planBody(body.r, env, ctes, {}));
	if (!left.node.columns || !right.node.columns) throw new TranslateError(`uses ${body.op} on a query whose columns are unknown`);
	const names = left.node.columns.map((c) => c.name);
	if (right.node.columns.length !== names.length) throw new TranslateError(`uses ${body.op} with ${names.length} and ${right.node.columns.length} columns`);
	left = derive(left, env.graph.add({ op: 'unique', fields: [] }, [left.node], left.node.columns, `Distinct rows (${body.op})`));
	const keyed = (rel, cols) => {
		const keys = cols.map(() => env.graph.temp('sk'));
		return { rel: addFormula(rel, cols.map((c, n) => ({ name: keys[n], expression: `IFNULL(CAST(${backtick(c.name)} AS STRING), ${NULL_KEY})` })), env, 'Set operation keys'), keys };
	};
	const l = keyed(left, left.node.columns);
	const r = keyed(right, right.node.columns);
	const marker = env.graph.temp('m');
	let rightKeys = project(r.rel, r.keys.map((k) => [k, k]), env, 'Set operation keys');
	rightKeys = derive(rightKeys, env.graph.add({ op: 'unique', fields: r.keys }, [rightKeys.node], rightKeys.node.columns, 'Distinct keys'));
	rightKeys = addFormula(rightKeys, [{ name: marker, expression: '1' }], env, `${body.op} marker`);
	let rel = leftJoin(l.rel, rightKeys, l.keys.map((k, n) => [k, r.keys[n]]), env, `${body.op} join`);
	rel = addFilter(rel, `${backtick(marker)} IS ${body.op === 'INTERSECT' ? 'NOT ' : ''}NULL`, env, body.op === 'INTERSECT' ? 'Rows in both' : 'Rows only on the left');
	return project(rel, names.map((n) => [n, n]), env, 'Select columns');
}

/**
 * Union branches as tiles; the branches tiles cannot express go together into one SQL tile (row order does not
 * matter to UNION), so a long list of constant rows is one tile rather than a SQL tile for the whole union.
 */
function planBranches(branches, byName, env, ctes) {
	if (env.mode !== 'auto') return branches.map((b) => planBody(b, env, ctes, {}));
	const rels = [];
	const failed = [];
	let failedAt = -1;
	let reason;
	for (const b of branches) {
		const result = attempt(() => planBody(b, env, ctes, {}), env);
		if (result.rel) rels.push(result.rel);
		else {
			if (failedAt < 0) failedAt = rels.length;
			failed.push(b);
			reason = result.error;
		}
	}
	if (!failed.length) return rels;
	if (!rels.length) throw reason;
	const body = failed.reduce((l, r) => ({ k: 'setop', op: 'UNION', all: true, l, r, ...(byName ? { byName } : {}) }));
	env.issue('info', 'magic.sql-tile-reason', `${failed.length} union branch(es) use a SQL tile: one ${reason.message}.`);
	rels.splice(failedAt, 0, sqlTile({ k: 'query', with: [], orderBy: [], body }, env, 'Union branches (SQL)', ctes));
	return rels;
}

/**
 * @param {import('./parser.js').Query} query
 * @param {Map<string, any>} ctes  Visible CTEs by name
 * @param {import('./parser.js').Ident[]} [columnNames]  Column aliases (derived table or CTE)
 * @returns {Rel}
 */
function planQuery(query, env, ctes, columnNames) {
	const scope = new Map(ctes);
	for (const cte of query.with) scope.set(canonical(cte.name), { query: cte.query, scope: new Map(scope), columns: cte.columns });
	const tail = { orderBy: query.orderBy, limit: query.limit, offset: query.offset };
	let rel;
	if (query.body.k === 'select') rel = planSelect(query.body, env, scope, query.limit ? tail : {});
	else {
		rel = planBody(query.body, env, scope, {});
		if (query.limit) {
			const outScope = { rel, replacements: new Map() };
			rel = applyLimit(rel, query.orderBy, query.limit, query.offset, outScope, env);
			rel = dropColumns(rel, helperColumns(rel.node), env);
		}
	}
	if (query.orderBy.length && !query.limit) env.issue('info', 'magic.order-ignored', 'ORDER BY without LIMIT is dropped: a Domo dataset has no row order.');
	if (columnNames) rel = renameColumns({ node: rel.node, sources: [sourceFromNode(rel.node, new Set())] }, columnNames, env);
	return rel;
}

/* PIVOT / UNPIVOT */

function planPivot(item, env, ctes) {
	const src = planFrom(item.source, env, ctes, []);
	if (!src.node.columns) throw fallback('pivots a table whose columns are unknown');
	const agg = item.agg;
	if (agg.k !== 'fn' || !AGGREGATES.has(agg.name) || agg.args.length !== 1 || agg.args[0].k !== 'col') throw new TranslateError('pivots with something other than one aggregate of one column');
	const scope = { rel: src, replacements: new Map() };
	const pivotCol = resolveIn(src, item.column.parts ?? []);
	const valueCol = resolveIn(src, agg.args[0].parts);
	if (pivotCol === undefined || valueCol === undefined) throw new TranslateError('pivots a column that is not in its source');
	const groups = src.node.columns.map((c) => c.name).filter((n) => n !== pivotCol && n !== valueCol && !isHelper(n));
	const fields = item.values.map((v) => {
		if (!['str', 'num'].includes(v.k)) throw new TranslateError('pivots on a value that is not a constant');
		// Snowflake names a string pivot column 'value' with the quotes; ADR cannot select a name with a quote.
		if (v.k === 'str' && !item.columns) env.issue('warning', 'magic.pivot-names', `PIVOT column '${v.v}' is named ${v.v}, without Snowflake's quotes; give the PIVOT a column list to name it.`);
		const label = v.v;
		const inner = { ...agg, args: [{ k: 'case', whens: [[{ k: 'bin', op: '=', l: { k: 'col', parts: [{ name: pivotCol, quoted: true }] }, r: v }, agg.args[0]]] }] };
		return { name: label, expression: toMagic(inner, exprCtx(scope, env, { aggregates: true })) };
	});
	const node = env.graph.add({ op: 'group', groups, fields }, [src.node], [...groups.map((g) => ({ name: g })), ...fields.map((f) => ({ name: f.name }))], 'Pivot');
	let rel = { node, sources: [sourceFromNode(node, new Set(item.alias ? [canonical(item.alias)] : []))] };
	if (item.columns) rel = renameColumns(rel, [...groups.map((g) => ({ name: g, quoted: true })), ...item.columns], env);
	return rel;
}

function planUnpivot(item, env, ctes) {
	const src = planFrom(item.source, env, ctes, []);
	if (!src.node.columns) throw fallback('unpivots a table whose columns are unknown');
	const cols = item.columns.map((c) => {
		const w = resolveIn(src, [c]);
		if (w === undefined) throw new TranslateError(`unpivots ${c.name}, which is not in its source`);
		return [canonical(c), w];
	});
	const listed = new Set(cols.map(([, w]) => w));
	const keep = src.node.columns.map((c) => c.name).filter((n) => !listed.has(n) && !isHelper(n));
	const nameCol = canonical(item.name);
	const valueCol = canonical(item.value);
	const branches = cols.map(([label, w]) => {
		let r = addFormula(src, [{ name: '_t2d_uname', expression: `'${label.replace(/'/g, "''")}'` }], env, `Unpivot ${label}`);
		r = project(r, [...keep.map((k) => [k, k]), ['_t2d_uname', nameCol], [w, valueCol]], env, `Unpivot ${label}`);
		if (!item.includeNulls) r = addFilter(r, `${backtick(valueCol)} IS NOT NULL`, env, 'Drop NULL values');
		return r;
	});
	const columns = [...keep.map((k) => ({ name: k })), { name: nameCol, type: 'STRING' }, { name: valueCol }];
	const node = env.graph.add({ op: 'union' }, branches.map((b) => b.node), columns, 'Unpivot');
	return { node, sources: [sourceFromNode(node, new Set(item.alias ? [canonical(item.alias)] : []))] };
}

/* SQL tile fallback */

function referencedTables(query, ctes = new Set()) {
	const out = [];
	const visitQuery = (q, visible) => {
		const scope = new Set(visible);
		for (const cte of q.with) {
			visitQuery(cte.query, scope);
			scope.add(canonical(cte.name));
		}
		visitBody(q.body, scope);
	};
	const visitExprs = (e, scope) =>
		walkExpr(e, (n) => {
			if (n.query) visitQuery(n.query, scope);
		});
	const visitFrom = (f, scope) => {
		if (!f) return;
		if (f.k === 'table') {
			if (!(f.parts.length === 1 && scope.has(canonical(f.parts[0])))) out.push(f.parts);
		} else if (f.k === 'derived') visitQuery(f.query, scope);
		else if (f.k === 'join') {
			visitFrom(f.l, scope);
			visitFrom(f.r, scope);
			visitExprs(f.on, scope);
		} else if (f.k === 'pivot' || f.k === 'unpivot') visitFrom(f.source, scope);
	};
	const visitBody = (b, scope) => {
		if (b.k === 'select') {
			visitFrom(b.from, scope);
			for (const i of b.items) visitExprs(i.e, scope);
			visitExprs(b.where, scope);
			visitExprs(b.having, scope);
			visitExprs(b.qualify, scope);
		} else if (b.k === 'setop') {
			visitBody(b.l, scope);
			visitBody(b.r, scope);
		} else if (b.k === 'nested') visitQuery(b.query, scope);
	};
	visitQuery(query, ctes);
	return out;
}

/** Output columns of a query the SQL tile runs, when they can be known without planning it. */
function staticColumns(query, env, ctes = new Map()) {
	try {
		return inferQuery(query, env, ctes);
	} catch (err) {
		if (err instanceof TranslateError) return null;
		throw err;
	}
}

function staticBody(body, env, scope) {
	try {
		return inferBody(body, env, scope);
	} catch (err) {
		if (err instanceof TranslateError) return null;
		throw err;
	}
}

function inferQuery(query, env, ctes) {
	const scope = new Map(ctes);
	for (const cte of query.with) scope.set(canonical(cte.name), { query: cte.query, scope: new Map(scope), columns: cte.columns });
	return inferBody(query.body, env, scope);
}

function renamed(columns, names) {
	if (!columns || !names) return columns;
	return columns.map((c, k) => (names[k] ? { ...c, name: canonical(names[k]) } : c));
}

function inferBody(body, env, ctes) {
	if (body.k === 'values') return body.rows[0].map((_, k) => ({ name: `COLUMN${k + 1}` }));
	if (body.k === 'nested') return inferQuery(body.query, env, ctes);
	if (body.k === 'setop') return inferBody(body.l, env, ctes);
	const sources = body.from ? inferFrom(body.from, env, ctes) : [];
	const out = [];
	for (const item of body.items) {
		if (item.e.k !== 'star') {
			const scope = { rel: { node: { columns: sources.flatMap((s) => s.columns ?? []) }, sources: sources.map((s) => ({ names: s.names, cols: s.columns ? new Map(s.columns.map((c) => [c.name, c.name])) : null })) } };
			out.push({ name: itemName(item), type: castType(item.e, scope) });
			continue;
		}
		const qualifier = item.e.qualifier?.map(canonical).join('.');
		const picked = qualifier ? sources.filter((s) => s.names.has(qualifier)) : sources;
		const exclude = new Set((item.e.exclude ?? []).map(canonical));
		for (const s of picked) {
			if (!s.columns) return null;
			out.push(...s.columns.filter((c) => !isHelper(c.name) && !exclude.has(c.name)));
		}
	}
	return out;
}

function inferFrom(item, env, ctes) {
	switch (item.k) {
		case 'table': {
			const name = item.parts.length === 1 ? canonical(item.parts[0]) : undefined;
			if (name && ctes.has(name)) {
				const cte = ctes.get(name);
				return [{ names: new Set([item.alias ? canonical(item.alias) : name]), columns: renamed(inferQuery(cte.query, env, cte.scope), cte.columns) }];
			}
			const node = tableNode(item.parts, env);
			return [{ names: qualifierNames(node.op === 'input' ? node.table : tableKey(item.parts, env), item.alias), columns: renamed(node.columns, item.columns) }];
		}
		case 'derived':
			return [{ names: new Set(item.alias ? [canonical(item.alias)] : []), columns: renamed(inferQuery(item.query, env, ctes), item.columns) }];
		case 'values':
			return [{ names: new Set(item.alias ? [canonical(item.alias)] : []), columns: renamed(item.rows[0].map((_, k) => ({ name: `COLUMN${k + 1}` })), item.columns) }];
		case 'join': {
			const l = inferFrom(item.l, env, ctes);
			const r = inferFrom(item.r, env, ctes);
			if (item.using) {
				const drop = new Set(item.using.map(canonical));
				return [...l, ...r.map((s) => ({ ...s, columns: s.columns ? s.columns.filter((c) => !drop.has(c.name)) : null }))];
			}
			return [...l, ...r];
		}
		default:
			return [{ names: new Set(item.alias ? [canonical(item.alias)] : []), columns: null }];
	}
}

function sqlTile(query, env, label, ctes = new Map()) {
	const inputs = new Map();
	const nameFor = (node) => {
		inputs.set(node.id, node);
		return tileNameOf(node);
	};
	for (const parts of referencedTables(query, new Set(ctes.keys()))) nameFor(tableNode(parts, env));
	const tileCtx = { table: (parts) => nameFor(tableNode(parts, env)), variables: env.variables, engine: env.engine, issue: (i) => env.issue(i.severity, i.code, i.message), columnsOf: (body, scope) => staticBody(body, env, scope) };
	const text = env.sqlDialect === 'SNOWFLAKE' ? snowflakeQueryText(query, { ...tileCtx, native: true }, ctes) : sqlTileText(query, tileCtx, ctes);
	const deps = [...inputs.values()];
	// With no table the tile has no input; ADR runs a constant SELECT that way (live-checked).
	const node = env.graph.add({ op: 'sql', sql: text, inputNames: deps.map((d) => d.tileName), ...(env.sqlDialect ? { dialect: env.sqlDialect } : {}) }, deps, staticColumns(query, env, ctes), label);
	env.fallbacks++;
	return { node, sources: [sourceFromNode(node, new Set())] };
}

function tileNameOf(node) {
	if (!node.tileName) node.tileName = `t2d_${String(node.label).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tile'}_${node.id}`;
	return node.tileName;
}

/** Positional UNION ALL of nodes whose columns are unknown (Append Rows lines columns up by name, not position). */
function unionAllTile(nodes, env, label) {
	const ref = (n) => (env.sqlDialect === 'SNOWFLAKE' ? `"${tileNameOf(n)}"` : tileNameOf(n));
	const sql = nodes.map((n) => `SELECT * FROM ${ref(n)}`).join(' UNION ALL ');
	const node = env.graph.add({ op: 'sql', sql, inputNames: nodes.map(tileNameOf), ...(env.sqlDialect ? { dialect: env.sqlDialect } : {}) }, nodes, nodes[0].columns, label);
	env.fallbacks++;
	return { node, sources: [sourceFromNode(node, new Set())] };
}

/** Plan a query as tiles with a SQL tile where tiles cannot (mode `auto`), or the other way round (mode `sql`). */
function planOrFallback(query, env, label, ctes = new Map()) {
	if (env.mode === 'sql') {
		const tile = attempt(() => sqlTile(query, env, label, ctes), env, () => true);
		if (tile.rel) return tile.rel;
		env.issue('info', 'magic.tiles-reason', `A query uses tiles because the SQL tile cannot run it: it ${tile.error.message}.`);
		return planQuery(query, env, ctes);
	}
	const result = attempt(() => planQuery(query, env, ctes), env);
	if (result.rel) return result.rel;
	env.issue('info', 'magic.sql-tile-reason', `A query uses a SQL tile: it ${result.error.message}.`);
	return sqlTile(query, env, label, ctes);
}

/** Run a planning step; when it fails in a way a SQL tile could handle, undo what it added and return the error. */
function attempt(fn, env, retry = (err) => err.fallback && env.mode !== 'tiles') {
	const mark = env.graph.nodes.length;
	const counter = env.graph.counter;
	const issues = env.issues.length;
	try {
		return { rel: fn() };
	} catch (err) {
		if (!(err instanceof TranslateError) || err.poisoned || !retry(err)) throw err;
		const dropped = new Set(env.graph.nodes.slice(mark));
		env.graph.nodes.length = mark;
		env.graph.counter = counter;
		env.issues.length = issues;
		for (const [key, node] of env.inputs) if (dropped.has(node)) env.inputs.delete(key);
		return { error: err };
	}
}

/* Statements */

function displayName(parts) {
	return parts.map(canonical).at(-1);
}

function assertStorable(node) {
	const dup = node.columns?.find((c) => c.name.includes(DUPLICATE));
	if (dup) throw new TranslateError(`produces the column ${dup.name.split(DUPLICATE)[0]} twice`);
}

function setTable(env, parts, node) {
	assertStorable(node);
	const key = tableKey(parts, env);
	env.tables.set(key, { key, node });
	env.poisoned.delete(key);
	return key;
}

function tableRel(parts, alias, env) {
	const node = tableNode(parts, env);
	const key = node.op === 'input' ? node.table : tableKey(parts, env);
	return { node, sources: [sourceFromNode(node, qualifierNames(key, alias))] };
}

function runStatement(st, env) {
	switch (st.kind) {
		case 'error':
			throw new TranslateError(`could not be parsed: ${st.reason}`);
		case 'unknown':
			throw new TranslateError(st.reason);
		case 'ignored':
			return st.reason;
		case 'use':
			if (st.target === 'DATABASE') env.session.database = canonical(st.parts.at(-1));
			else if (st.target === 'SCHEMA') {
				if (st.parts.length > 1) env.session.database = canonical(st.parts.at(-2));
				env.session.schema = canonical(st.parts.at(-1));
			} else return `USE ${st.target} does not change the data`;
			return undefined;
		case 'session': {
			for (const o of st.options ?? []) {
				if (o.option === 'TIMEZONE' && !/^(UTC|GMT|Etc\/UTC)$/i.test(o.value)) env.issue('warning', 'magic.timezone', `The script sets TIMEZONE to ${o.value}; Magic ETL evaluates CURRENT_TIMESTAMP and date conversions in the dataflow's time zone instead.`);
				if (o.option === 'QUOTED_IDENTIFIERS_IGNORE_CASE') env.session.quotedIgnoreCase = /^true$/i.test(o.value);
				if (['WEEK_START', 'WEEK_OF_YEAR_POLICY', 'DATE_INPUT_FORMAT', 'TIMESTAMP_INPUT_FORMAT', 'TIMESTAMP_TYPE_MAPPING'].includes(o.option)) env.issue('warning', 'magic.session-setting', `The script sets ${o.option} = ${o.value}, which Magic ETL does not apply; date functions keep their defaults.`);
			}
			return 'session setting';
		}
		case 'set':
			for (const v of st.vars) {
				if (hasSubquery(v.e) || columnRefs(v.e).length) throw new TranslateError(`sets $${v.name} from a query or column, which t2d cannot evaluate before the dataflow runs`);
				env.variables.set(v.name.toUpperCase(), v.e);
			}
			return undefined;
		case 'unset':
			for (const n of st.names) env.variables.delete(n.toUpperCase());
			return undefined;
		case 'query':
			env.issue('info', 'magic.select-ignored', `Statement ${st.index + 1} is a SELECT whose result the script does not keep; it is skipped.`);
			return 'result not kept';
		case 'drop': {
			if (st.objectType !== 'TABLE' && st.objectType !== 'VIEW') return `DROP ${st.objectType} does not change the data`;
			env.tables.delete(tableKey(st.name, env));
			env.poisoned.delete(tableKey(st.name, env));
			return undefined;
		}
		case 'create':
			return runCreate(st, env);
		case 'insert':
			return runInsert(st, env);
		case 'update':
			return runUpdate(st, env);
		case 'delete':
			return runDelete(st, env);
		case 'truncate': {
			const key = tableKey(st.name, env);
			const node = tableNode(st.name, env);
			env.tables.set(key, { key, node: env.graph.add({ op: 'filter', expression: MAGIC_FALSE }, [node], node.columns, `Truncate ${displayName(st.name)}`) });
			return undefined;
		}
		case 'alter-table':
			return runAlter(st, env);
		case 'merge':
			return runMerge(st, env);
		default:
			throw new TranslateError(`is a ${st.kind} statement, which t2d does not translate`);
	}
}

function runCreate(st, env) {
	const key = tableKey(st.name, env);
	if (st.ifNotExists && env.tables.has(key)) return 'already exists';
	if (st.clone) {
		const node = tableNode(st.clone, env);
		setTable(env, st.name, node);
		return undefined;
	}
	if (st.like) {
		const node = tableNode(st.like, env);
		env.tables.set(key, { key, node: env.graph.add({ op: 'filter', expression: MAGIC_FALSE }, [node], node.columns, `Empty ${displayName(st.name)}`) });
		return undefined;
	}
	if (st.query) {
		let rel = planOrFallback(st.query, env, `Build ${displayName(st.name)}`);
		if (st.columns?.length) {
			if (!rel.node.columns) throw new TranslateError('names the columns of a query whose columns are unknown');
			rel = renameColumns({ node: rel.node, sources: [sourceFromNode(rel.node, new Set())] }, st.columns.map((c) => c.name), env);
		}
		if (st.viewColumns?.length) rel = renameColumns({ node: rel.node, sources: [sourceFromNode(rel.node, new Set())] }, st.viewColumns, env);
		rel.node.label = rel.node.label === 'Select columns' || rel.node.op === 'sql' ? displayName(st.name) : rel.node.label;
		setTable(env, st.name, rel.node);
		return undefined;
	}
	if (st.columns) {
		env.tables.set(key, { key, empty: true, columns: st.columns.map((c) => ({ name: canonical(c.name), ...(c.type && magicType(c.type) ? { type: magicType(c.type) } : {}) })) });
		env.poisoned.delete(key);
		return 'empty table';
	}
	throw new TranslateError('creates a table with neither columns nor a query');
}

/** The script's own table a statement changes; changing a warehouse table is out of scope. */
function scriptTable(key, verb, env) {
	if (env.poisoned.has(key)) {
		const err = new TranslateError(`${verb} ${key}, which a blocked statement builds`);
		err.poisoned = true;
		throw err;
	}
	const target = env.tables.get(key);
	if (!target) throw new TranslateError(`${verb} ${key}, which the script did not create (changing a warehouse table is out of scope)`);
	return target;
}

function runInsert(st, env) {
	const key = tableKey(st.name, env);
	const target = scriptTable(key, 'inserts into', env);
	const columns = target.empty ? target.columns : target.node.columns;
	const query = st.values ? { k: 'query', with: [], orderBy: [], body: { k: 'values', rows: st.values } } : st.query;
	const rel = planOrFallback(query, env, `Rows for ${displayName(st.name)}`);
	if (!columns || !rel.node.columns) {
		if (st.columns || target.empty) throw new TranslateError('inserts into named columns of a table whose columns are unknown');
		if (st.overwrite) {
			setTable(env, st.name, rel.node);
			return undefined;
		}
		setTable(env, st.name, unionAllTile([target.node, rel.node], env, `Append to ${displayName(st.name)}`).node);
		return 'appended with a SQL tile (columns unknown)';
	}
	const targetCols = st.columns ? st.columns.map(canonical) : columns.map((c) => c.name);
	if (rel.node.columns.length !== targetCols.length) throw new TranslateError(`inserts ${rel.node.columns.length} columns into ${targetCols.length}`);
	const byTarget = new Map(targetCols.map((t, k) => [t, rel.node.columns[k].name]));
	const fills = [];
	const fields = columns.map((c) => {
		if (byTarget.has(c.name)) return [byTarget.get(c.name), c.name];
		const name = env.graph.temp('null');
		fills.push({ name, expression: c.type ? `CAST(NULL AS ${c.type === 'DATETIME' ? 'TIMESTAMP' : c.type})` : 'NULL' });
		return [name, c.name];
	});
	if (st.columns) for (const t of targetCols) if (!columns.some((c) => c.name === t)) throw new TranslateError(`inserts into ${t}, which the table does not have`);
	let aligned = addFormula(rel, fills, env, 'Missing columns');
	const casts = [];
	for (const [from, to] of fields) {
		const want = columns.find((c) => c.name === to)?.type;
		const have = aligned.node.columns.find((c) => c.name === from)?.type;
		if (want && have && want !== have) casts.push({ name: from, expression: have === 'STRING' && KEY_CAST_TYPES[want] ? tryCastColumn(from, want, env) : `CAST(${backtick(from)} AS ${want === 'DATETIME' ? 'TIMESTAMP' : want})`, type: want });
	}
	aligned = addFormula(aligned, casts, env, 'Match column types');
	if (!(fields.every(([a, b]) => a === b) && aligned.node.columns.length === fields.length && aligned.node.columns.every((c, k) => c.name === fields[k][0]))) aligned = project(aligned, fields, env, `Line up ${displayName(st.name)} columns`);
	if (target.empty || st.overwrite) {
		env.tables.set(key, { key, node: aligned.node });
		return undefined;
	}
	const node = env.graph.add({ op: 'union' }, [target.node, aligned.node], columns, `Append to ${displayName(st.name)}`);
	env.tables.set(key, { key, node });
	return undefined;
}

function runAlter(st, env) {
	const key = tableKey(st.name, env);
	const target = scriptTable(key, 'alters', env);
	if (target.empty) {
		if (st.action === 'type') for (const ch of st.changes) {
			const col = target.columns.find((c) => c.name === canonical(ch.column));
			if (col && magicType(ch.type)) col.type = magicType(ch.type);
		}
		return undefined;
	}
	const rel = tableRel(st.name, undefined, env);
	const known = rel.node.columns;
	switch (st.action) {
		case 'noop':
			return 'column property only';
		case 'type': {
			const fields = [];
			for (const ch of st.changes) {
				const name = canonical(ch.column);
				const want = magicType(ch.type);
				if (!want) throw new TranslateError(`changes ${name} to ${ch.type.name}`);
				const col = known?.find((c) => c.name === name);
				if (known && !col) throw new TranslateError(`alters ${name}, which ${key} does not have`);
				if (col?.type === want) continue;
				if (col?.type === 'STRING' && KEY_CAST_TYPES[want]) fields.push({ name, expression: tryCastColumn(name, want, env), type: want });
				else fields.push({ name, expression: want === 'DATE' ? `DATE(${backtick(name)})` : `CAST(${backtick(name)} AS ${want === 'DATETIME' ? 'TIMESTAMP' : want})`, type: want });
			}
			if (fields.length) env.tables.set(key, { key, node: addFormula(rel, fields, env, `Alter ${displayName(st.name)}`).node });
			return fields.length ? undefined : 'type already matches';
		}
		case 'add': {
			const fields = st.columns.map((c) => {
				const t = magicType(c.type);
				const def = c.default ? formula(c.default, { rel }, env) : 'NULL';
				return { name: canonical(c.name), expression: t ? `CAST(${def} AS ${t === 'DATETIME' ? 'TIMESTAMP' : t})` : def, type: t };
			});
			env.tables.set(key, { key, node: addFormula(rel, fields, env, `Add columns to ${displayName(st.name)}`).node });
			return undefined;
		}
		case 'drop':
			env.tables.set(key, { key, node: dropColumns(rel, st.columns.map(canonical), env).node });
			return undefined;
		case 'rename-column': {
			if (!known) throw new TranslateError('renames a column of a table whose columns are unknown');
			const from = canonical(st.from);
			const to = canonical(st.to);
			env.tables.set(key, { key, node: project(rel, known.map((c) => [c.name, c.name === from ? to : c.name]), env, `Rename ${from}`).node });
			return undefined;
		}
		case 'rename': {
			env.tables.delete(key);
			setTable(env, st.to, target.node);
			return undefined;
		}
		default:
			throw new TranslateError('is an ALTER TABLE form t2d does not translate');
	}
}

const UPDATE_CAST = { STRING: 'VARCHAR', LONG: 'BIGINT', DOUBLE: 'DOUBLE', DATE: 'DATE', DATETIME: 'TIMESTAMP' };

/** UPDATE without FROM as the SELECT that returns the updated table, columns in their order. */
function updateQuery(st, known) {
	const sets = new Map(st.sets.map((s) => [canonical(s.column), s.e]));
	const items = known.map((c) => {
		const col = { k: 'col', parts: [{ name: c.name, quoted: true }] };
		const e = sets.get(c.name);
		if (!e) return { e: col };
		const cast = UPDATE_CAST[c.type] && !['col', 'null'].includes(e.k) && !(c.type === 'STRING' && e.k === 'str');
		const value = cast ? { k: 'cast', e, type: { name: UPDATE_CAST[c.type], args: [] }, try: false } : e;
		return { e: st.where ? { k: 'case', whens: [[st.where, value]], else: col } : value, alias: { name: c.name, quoted: true } };
	});
	const from = { k: 'table', parts: st.name, ...(st.alias ? { alias: st.alias } : {}) };
	return { k: 'query', with: [], orderBy: [], body: { k: 'select', distinct: false, items, from } };
}

function runUpdate(st, env) {
	const key = tableKey(st.name, env);
	scriptTable(key, 'updates', env);
	let rel = tableRel(st.name, st.alias, env);
	const known = rel.node.columns;
	for (const s of st.sets) if (known && !known.some((c) => c.name === canonical(s.column))) throw new TranslateError(`sets ${canonical(s.column)}, which ${key} does not have`);
	// As a SQL tile the table keeps Snowflake's column order, which a later positional UNION relies on.
	if (env.mode === 'sql' && known && !st.from) {
		const tile = attempt(() => sqlTile(updateQuery(st, known), env, `Update ${displayName(st.name)}`), env, () => true);
		if (tile.rel) {
			tile.rel.node.columns = known.map((c) => ({ ...c }));
			env.tables.set(key, { key, node: tile.rel.node });
			return undefined;
		}
		env.issue('info', 'magic.tiles-reason', `An UPDATE uses tiles because the SQL tile cannot run it: it ${tile.error.message}.`);
	}
	const scope = { rel, replacements: new Map() };
	let cond;
	let matchMarker;
	if (st.from) {
		const joined = joinUpdateSource(rel, st, env, scope);
		rel = joined.rel;
		scope.rel = rel;
		matchMarker = joined.marker;
		cond = joined.residual;
	} else cond = conjuncts(st.where).filter((c) => !isConstantTrue(c));
	rel = attachSubqueries(rel, cond, scope, env, { condition: true });
	scope.rel = rel;
	rel = attachSubqueries(rel, st.sets.map((s) => s.e), scope, env);
	scope.rel = rel;
	const condText = [matchMarker ? `${backtick(matchMarker)} IS NOT NULL` : null, cond.length ? formula(andAll(cond), scope, env) : null].filter(Boolean).join(' AND ');
	const temps = [];
	const assigns = [];
	const targets = new Set(st.sets.map((s) => canonical(s.column)));
	const readsTarget = (e) => columnRefs(e).some((r) => targets.has(canonical(r.parts.at(-1))));
	const needTemps = st.sets.length > 1 && (st.sets.some((s) => readsTarget(s.e)) || cond.some(readsTarget));
	for (const s of st.sets) {
		const name = canonical(s.column);
		const type = known?.find((c) => c.name === name)?.type;
		let value = valueFormula(s.e, scope, env);
		if (type && type !== 'STRING' && KEY_CAST_TYPES[type] && castType(s.e, scope) === 'STRING') value = tryCastText(value, type, env);
		else if (type && s.e.k !== 'col' && s.e.k !== 'null') value = type === 'DATE' ? `DATE(${value})` : `CAST(${value} AS ${type === 'DATETIME' ? 'TIMESTAMP' : type})`;
		const text = condText ? `CASE WHEN ${condText} THEN ${value} ELSE ${backtick(name)} END` : value;
		if (needTemps) {
			const temp = env.graph.temp('set');
			temps.push({ name: temp, expression: text });
			assigns.push({ name, expression: backtick(temp), type });
		} else assigns.push({ name, expression: text, type });
	}
	rel = addFormula(rel, [...temps, ...assigns], env, `Update ${displayName(st.name)}`);
	const helpers = [...new Set([...helperColumns(rel.node), ...(rel.node.columns ? [] : collectHelpers(rel.node))])];
	rel = dropColumns(rel, helpers, env);
	env.tables.set(key, { key, node: rel.node });
	return undefined;
}

/** Qualifier names a FROM clause brings into scope, and the columns of its tables when all are known. */
function fromScope(item, env) {
	const names = new Set();
	let cols = new Set();
	const visit = (f) => {
		if (f.k === 'join') {
			visit(f.l);
			visit(f.r);
		} else if (f.k === 'table') {
			const node = tableNode(f.parts, env);
			for (const n of qualifierNames(node.op === 'input' ? node.table : tableKey(f.parts, env), f.alias)) names.add(n);
			if (cols && node.columns) for (const c of node.columns) cols.add(c.name);
			else cols = null;
		} else {
			if (f.alias) names.add(canonical(f.alias));
			cols = null;
		}
	};
	visit(item);
	return { names, cols };
}

/**
 * UPDATE ... FROM: the FROM rows that match (one per key) joined onto each target row by the WHERE equalities. The FROM
 * becomes one query selecting just the keys and the columns the SETs read, so it can be a SQL tile when tiles cannot.
 */
function joinUpdateSource(target, st, env, scope) {
	const all = conjuncts(st.where).filter((c) => !isConstantTrue(c));
	const pairs = [];
	const targetOnly = [];
	const sourceOnly = [];
	const from = fromScope(st.from, env);
	const placeRef = (r) => {
		const label = r.parts.map((p) => p.name).join('.');
		if (r.parts.length > 1) {
			const q = r.parts.slice(0, -1).map(canonical).join('.');
			if (from.names.has(q)) return 'source';
			if (target.sources.some((x) => x.names.has(q))) return 'target';
			throw new TranslateError(`refers to ${label}, which neither the updated table nor FROM has`);
		}
		const name = canonical(r.parts[0]);
		const tCols = target.sources[0].cols;
		const inT = tCols ? tCols.has(name) : undefined;
		const inS = from.cols ? from.cols.has(name) : undefined;
		if (inT && inS) throw new TranslateError(`refers to the ambiguous column ${label}`);
		if (inT || (inT === undefined && inS === false)) return 'target';
		if (inS || (inS === undefined && inT === false)) return 'source';
		throw new TranslateError(`refers to ${label} without a table name, and t2d cannot tell which table has it`);
	};
	const side = (e) => {
		let t = false;
		let s = false;
		for (const r of columnRefs(e)) (placeRef(r) === 'source' ? (s = true) : (t = true));
		return t && s ? 'both' : s ? 'source' : t ? 'target' : 'none';
	};
	for (const c of all) {
		if (hasSubquery(c)) throw new TranslateError('has a subquery in an UPDATE ... FROM condition');
		if (c.k === 'bin' && c.op === '=') {
			const l = side(c.l);
			const r = side(c.r);
			if (l === 'target' && r === 'source') {
				pairs.push([c.l, c.r]);
				continue;
			}
			if (l === 'source' && r === 'target') {
				pairs.push([c.r, c.l]);
				continue;
			}
		}
		const s = side(c);
		if (s === 'both') throw new TranslateError('has an UPDATE ... FROM condition other than an equality that reads both tables');
		(s === 'source' ? sourceOnly : targetOnly).push(c);
	}
	if (!pairs.length) throw new TranslateError('updates FROM another table without an equality that matches rows');
	const items = [];
	const keyHelpers = [];
	for (const [, se] of pairs) {
		const helper = env.graph.temp('uk');
		items.push({ e: se, alias: { name: helper, quoted: true } });
		keyHelpers.push(helper);
	}
	const byRef = new Map();
	for (const s of st.sets) {
		for (const r of columnRefs(s.e)) {
			if (placeRef(r) !== 'source') continue;
			const k = r.parts.map(canonical).join('.');
			if (!byRef.has(k)) {
				const helper = env.graph.temp('u');
				byRef.set(k, helper);
				items.push({ e: r, alias: { name: helper, quoted: true } });
			}
			scope.replacements.set(r, backtick(byRef.get(k)));
		}
	}
	const query = { k: 'query', with: [], orderBy: [], body: { k: 'select', distinct: false, items, from: st.from, ...(sourceOnly.length ? { where: andAll(sourceOnly) } : {}) } };
	let right = planOrFallback(query, env, `Rows that update ${displayName(st.name)}`);
	right = derive(right, env.graph.add({ op: 'unique', fields: keyHelpers }, [right.node], right.node.columns, 'One source row per key'));
	env.issue('info', 'magic.update-from', 'UPDATE ... FROM keeps one source row per matched key; Snowflake also picks an arbitrary row when several match.');
	const marker = env.graph.temp('m');
	right = addFormula(right, [{ name: marker, expression: '1' }], env, 'Update marker');
	let t = target;
	const tScope = { rel: t, replacements: new Map() };
	const keys = [];
	pairs.forEach(([te], n) => {
		const tk = asColumn(t, te, tScope, env);
		t = tk.rel;
		tScope.rel = t;
		keys.push([tk.name, keyHelpers[n]]);
	});
	const joined = leftJoin(t, right, keys, env, `Match ${displayName(st.name)} rows`);
	return { rel: { node: joined.node, sources: target.sources }, marker, residual: targetOnly };
}

function runDelete(st, env) {
	const key = tableKey(st.name, env);
	scriptTable(key, 'deletes from', env);
	let rel = tableRel(st.name, st.alias, env);
	const scope = { rel, replacements: new Map() };
	let cond = st.where;
	if (st.using) {
		const exists = { k: 'exists', not: false, query: { k: 'query', with: [], orderBy: [], body: { k: 'select', distinct: false, items: [{ e: { k: 'num', v: '1' } }], from: st.using, where: st.where } } };
		cond = exists;
	}
	if (!cond) {
		env.tables.set(key, { key, node: env.graph.add({ op: 'filter', expression: MAGIC_FALSE }, [rel.node], rel.node.columns, `Delete all ${displayName(st.name)} rows`) });
		return undefined;
	}
	rel = attachSubqueries(rel, [cond], scope, env, { condition: false });
	scope.rel = rel;
	rel = addFilter(rel, notTrue(formula(cond, scope, env)), env, `Delete ${displayName(st.name)} rows`);
	const helpers = [...new Set([...helperColumns(rel.node), ...(rel.node.columns ? [] : collectHelpers(rel.node))])];
	rel = dropColumns(rel, helpers, env);
	env.tables.set(key, { key, node: rel.node });
	return undefined;
}

/**
 * MERGE as the statements it stands for: the matched UPDATE or DELETE (an UPDATE ... FROM / DELETE ... USING on the ON
 * condition), then an INSERT of the source rows that matched nothing in the table as it was before the MERGE.
 */
function runMerge(st, env) {
	const key = tableKey(st.name, env);
	scriptTable(key, 'merges into', env);
	const matched = st.clauses.filter((c) => c.matched);
	const unmatched = st.clauses.filter((c) => !c.matched);
	if (matched.length > 1 || unmatched.length > 1) throw new TranslateError('has several WHEN MATCHED or WHEN NOT MATCHED clauses, whose first-match order t2d does not translate');
	const snapshot = [{ name: '__T2D', quoted: true }, { name: 'MERGE', quoted: true }, { name: `M${st.index}`, quoted: true }];
	const snapshotKey = tableKey(snapshot, env);
	env.tables.set(snapshotKey, { key: snapshotKey, node: env.tables.get(key).node });
	const base = { index: st.index, start: st.start, end: st.end, text: st.text, name: st.name, ...(st.alias ? { alias: st.alias } : {}) };
	const and = (a, b) => (b ? { k: 'bin', op: 'AND', l: a, r: b } : a);
	try {
		const [m] = matched;
		if (m?.action === 'update') runUpdate({ ...base, kind: 'update', sets: m.sets, from: st.source, where: and(st.on, m.cond) }, env);
		if (m?.action === 'delete') runDelete({ ...base, kind: 'delete', using: st.source, where: and(st.on, m.cond) }, env);
		const [u] = unmatched;
		if (u) {
			const targetAlias = st.alias ?? st.name.at(-1);
			const exists = { k: 'exists', not: true, query: { k: 'query', with: [], orderBy: [], body: { k: 'select', distinct: false, items: [{ e: { k: 'num', v: '1' } }], from: { k: 'table', parts: snapshot, alias: targetAlias }, where: st.on } } };
			const query = { k: 'query', with: [], orderBy: [], body: { k: 'select', distinct: false, items: u.values.map((e) => ({ e })), from: st.source, where: and(exists, u.cond) } };
			runInsert({ ...base, kind: 'insert', ...(u.columns ? { columns: u.columns } : {}), query }, env);
		}
	} finally {
		env.tables.delete(snapshotKey);
	}
	return undefined;
}
