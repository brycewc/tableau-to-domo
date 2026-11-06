import { canonical, walkExpr } from './parser.js';
import { TranslateError, conditionValue, isCondition, toMagic, toSnowflake } from './expr.js';

/**
 * Text for Magic ETL's SQL tile ("Write a custom SQL script"). On ADR compute the tile takes exactly one SELECT in
 * Domo's own dialect (live-checked on ADR): Adrenaline functions, QUALIFY, window functions, subqueries and
 * set operations work; WITH, non-SELECT statements and Snowflake-only functions (IFF, DATEADD, TO_VARCHAR, DATE_PART,
 * TRY_TO_DATE) are rejected. Unquoted identifiers keep their case there (Snowflake folds them), so every name is quoted.
 */

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Snowflake's result column name for a select item.
 * @param {import('./parser.js').SelectItem} item
 */
export function itemName(item) {
	if (item.alias) return canonical(item.alias);
	if (item.e.k === 'col') return canonical(item.e.parts.at(-1));
	try {
		// ADR cannot select a column whose name has a single quote (live-checked), so 'x' AS-less literals lose them.
		return toSnowflake(item.e).toUpperCase().replace(/'/g, '');
	} catch {
		return 'EXPR';
	}
}

/**
 * @typedef {Object} SqlTileContext
 * @property {(parts: import('./parser.js').Ident[]) => string|undefined} table  Tile name for a table reference
 * @property {Map<string, import('./parser.js').Expr>} [variables]
 * @property {(issue: import('./expr.js').Issue) => void} [issue]
 */

/**
 * @param {import('./parser.js').Query} query
 * @param {SqlTileContext} ctx
 * @returns {string}
 */
export function sqlTileText(query, ctx, ctes = new Map()) {
	let q = query;
	while (!q.with.length && !q.orderBy.length && !q.limit && !q.offset && q.body.k === 'nested') q = q.body.query;
	return printQuery(q, ctx, ctes);
}

/**
 * The same query printed as Snowflake SQL (expressions through toSnowflake), for reading a SQL tile back.
 * @param {import('./parser.js').Query} query
 * @param {SqlTileContext} ctx
 */
export function snowflakeQueryText(query, ctx) {
	return printQuery(query, { ...ctx, snowflake: true }, new Map());
}

function printQuery(query, ctx, ctes) {
	const scope = new Map(ctes);
	for (const cte of query.with) {
		if (cte.columns) throw new TranslateError('has a CTE with a column list, which the SQL tile cannot inline');
		scope.set(canonical(cte.name), { query: cte.query, scope: new Map(scope) });
	}
	let text = printBody(query.body, ctx, scope);
	const expr = exprPrinter(ctx, scope);
	if (query.orderBy.length) text += ` ORDER BY ${query.orderBy.map((o) => `${expr(o.e)}${o.desc ? ' DESC' : ''}${o.nulls ? ` NULLS ${o.nulls}` : ''}`).join(', ')}`;
	if (query.limit) text += ` LIMIT ${expr(query.limit)}`;
	if (query.offset) text += ` OFFSET ${expr(query.offset)}`;
	return text;
}

/** Names a FROM clause brings into scope (aliases, else table names). */
function fromNames(item, out = new Set()) {
	if (!item) return out;
	if (item.k === 'join') {
		fromNames(item.l, out);
		fromNames(item.r, out);
	} else if (item.k === 'pivot' || item.k === 'unpivot') {
		fromNames(item.source, out);
		if (item.alias) out.add(canonical(item.alias));
	} else if (item.alias) out.add(canonical(item.alias));
	else if (item.k === 'table') out.add(canonical(item.parts.at(-1)));
	return out;
}

/** A qualified column a subquery reads from the query around it. */
function outerReference(query) {
	const visit = (body) => {
		if (body.k === 'setop') return visit(body.l) ?? visit(body.r);
		if (body.k === 'nested') return outerReference(body.query);
		if (body.k !== 'select') return undefined;
		const names = fromNames(body.from);
		let found;
		const exprs = [...body.items.map((i) => i.e), body.where, body.having, body.qualify, ...(body.groupBy ?? [])];
		for (const e of exprs) {
			walkExpr(e, (n) => {
				if (n.k === 'col' && n.parts.length > 1 && !names.has(canonical(n.parts.at(-2)))) found ??= n;
			});
		}
		return found;
	};
	return visit(query.body);
}

function exprPrinter(ctx, scope) {
	// A table is aliased by its last name part, so DB.SCHEMA.T.COL is read as T.COL.
	const column = (c) => c.parts.slice(-2).map((p) => quote(canonical(p))).join('.');
	const subquery = (node) => {
		const outer = !ctx.snowflake && outerReference(node.query);
		if (outer) throw new TranslateError(`has a correlated subquery (it reads ${outer.parts.map((p) => p.name).join('.')}), which the SQL tile fails to run (live-checked)`);
		return `(${printQuery(node.query, ctx, scope)})`;
	};
	if (ctx.snowflake) return (e) => toSnowflake(e, { column, subquery });
	const self = (e) =>
		toMagic(e, {
			target: 'sql',
			aggregates: true,
			variables: ctx.variables,
			engine: ctx.engine,
			issue: ctx.issue,
			column,
			subquery
		});
	return self;
}

function printBody(body, ctx, scope) {
	const expr = exprPrinter(ctx, scope);
	switch (body.k) {
		case 'nested':
			return `(${printQuery(body.query, ctx, scope)})`;
		case 'setop':
			if (body.byName && !ctx.snowflake) throw new TranslateError(`uses ${body.op} BY NAME, which the SQL tile does not accept`);
			if (body.op !== 'UNION' && !ctx.snowflake) throw new TranslateError(`uses ${body.op}, which the SQL tile runs as UNION (live-checked)`);
			return `${printBody(body.l, ctx, scope)} ${body.op}${body.all ? ' ALL' : ''}${body.byName ? ' BY NAME' : ''} ${printBody(body.r, ctx, scope)}`;
		case 'values':
			return body.rows.map((row) => `SELECT ${row.map((v, k) => `${expr(v)} AS ${quote(`COLUMN${k + 1}`)}`).join(', ')}`).join(' UNION ALL ');
		case 'select': {
			const taken = new Set();
			const items = body.items.map((item) => {
				if (item.e.k === 'star') {
					const head = item.e.qualifier ? `${quote(canonical(item.e.qualifier.at(-1)))}.*` : '*';
					if (!(item.e.exclude || item.e.replace || item.e.rename)) return head;
					if (!ctx.snowflake) throw new TranslateError('uses SELECT * EXCLUDE/REPLACE/RENAME, which the SQL tile does not accept');
					const mods = [];
					if (item.e.exclude) mods.push(`EXCLUDE (${item.e.exclude.map((x) => quote(canonical(x))).join(', ')})`);
					if (item.e.replace) mods.push(`REPLACE (${item.e.replace.map((r) => `${expr(r.e)} AS ${quote(canonical(r.name))}`).join(', ')})`);
					if (item.e.rename) mods.push(`RENAME (${item.e.rename.map((r) => `${quote(canonical(r.from))} AS ${quote(canonical(r.name))}`).join(', ')})`);
					return `${head} ${mods.join(' ')}`;
				}
				let name = itemName(item);
				for (let n = 2; taken.has(name); n++) name = `${itemName(item)}_${n}`;
				taken.add(name);
				const text = expr(item.e);
				return `${!ctx.snowflake && isCondition(item.e) ? conditionValue(text) : text} AS ${quote(name)}`;
			});
			let text = `SELECT ${body.distinct ? 'DISTINCT ' : ''}${items.join(', ')}`;
			if (body.from) text += ` FROM ${printFrom(body.from, ctx, scope)}`;
			if (body.where) text += ` WHERE ${expr(body.where)}`;
			if (body.groupAll) throw new TranslateError('uses GROUP BY ALL, which the SQL tile does not accept');
			if (body.groupBy?.length) text += ` GROUP BY ${body.groupBy.map(expr).join(', ')}`;
			if (body.having) text += ` HAVING ${expr(body.having)}`;
			if (body.qualify) text += ` QUALIFY ${expr(body.qualify)}`;
			if (body.top !== undefined) text = `SELECT * FROM (${text}) AS ${quote('_t2d_top')} LIMIT ${body.top}`;
			return text;
		}
		default:
			throw new TranslateError(`has a ${body.k} query body`);
	}
}

function printFrom(item, ctx, scope) {
	const alias = (a, fallback) => (a ? ` AS ${quote(canonical(a))}` : fallback ? ` AS ${quote(fallback)}` : '');
	switch (item.k) {
		case 'table': {
			if (item.columns) throw new TranslateError('renames a table\'s columns in FROM, which the SQL tile cannot express');
			const name = item.parts.length === 1 ? canonical(item.parts[0]) : undefined;
			if (name && scope.has(name)) {
				const cte = scope.get(name);
				if (cte.columns) throw new TranslateError('has a CTE with a column list, which the SQL tile cannot inline');
				return `(${printQuery(cte.query, ctx, cte.scope)})${alias(item.alias, name)}`;
			}
			const tile = ctx.table(item.parts);
			if (!tile) throw new TranslateError(`reads ${item.parts.map((p) => p.name).join('.')}, which has no input tile`);
			return `${tile}${alias(item.alias, canonical(item.parts.at(-1)))}`;
		}
		case 'derived':
			if (item.columns) throw new TranslateError('renames a derived table\'s columns, which the SQL tile cannot express');
			return `(${printQuery(item.query, ctx, scope)})${alias(item.alias, '_t2d_d')}`;
		case 'values':
			return `(${printBody({ k: 'values', rows: item.rows }, ctx, scope)})${alias(item.alias, '_t2d_v')}`;
		case 'join': {
			const l = printFrom(item.l, ctx, scope);
			const r = printFrom(item.r, ctx, scope);
			if (item.natural) throw new TranslateError('uses NATURAL JOIN');
			if (item.comma) return `${l} CROSS JOIN ${r}`;
			const type = { INNER: 'INNER JOIN', LEFT: 'LEFT OUTER JOIN', RIGHT: 'RIGHT OUTER JOIN', FULL: 'FULL OUTER JOIN', CROSS: 'CROSS JOIN' }[item.type];
			if (item.using) return `${l} ${type} ${r} USING (${item.using.map((u) => quote(canonical(u))).join(', ')})`;
			return `${l} ${type} ${r}${item.on ? ` ON ${exprPrinter(ctx, scope)(item.on)}` : ''}`;
		}
		default:
			throw new TranslateError(`uses ${item.k.toUpperCase()}, which the SQL tile translation does not express`);
	}
}
