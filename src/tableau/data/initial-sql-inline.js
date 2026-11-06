import { INITIAL_SQL_KEYS, initialSqlOf } from '../../convert/initial-sql.js';
import { planSnowflakeViews } from '../../snowflake/views.js';
import { inlineCtes, stripComments } from '../../convert/view-sql.js';

/**
 * A Snowflake connection's Initial SQL temp tables carried into its Custom SQL as CTEs, so Cloud Amplifier can serve
 * the datasource as SQL DataSet Views over the warehouse tables without any Snowflake object. Domo cannot build a
 * view on a view, so each Custom SQL query carries the whole chain it reads. Pure, no I/O.
 */

const PLACEHOLDER = { database: 'T2D_INLINE', schema: 'T2D_INLINE' };
// Past this (after Domo's CTEs become derived tables) a view's SQL is too long for Domo's view parser to handle reliably.
const MAX_INLINE_CHARS = 150000;

/**
 * @param {any} source  datasource IR (a published datasource's .tds for sqlproxy)
 * @returns {{ source?: any, unsupported?: string, cteCount?: number }}  `source`: undefined when nothing applies
 */
export function inlineInitialSql(source) {
	const out = structuredClone(source);
	const connections = (out.connections ?? []).filter((c) => String(c.class).toLowerCase() === 'snowflake' && initialSqlOf(c));
	if (!connections.length) return {};
	let cteCount = 0;
	for (const conn of connections) {
		const own = (t) => (t.connectionId ? t.connectionId === conn.id : (out.connections ?? []).length === 1);
		const custom = (out.tables ?? []).filter((t) => t.kind === 'custom-sql' && own(t));
		const plan = planSnowflakeViews({ initialSql: initialSqlOf(conn), customSql: custom.map((t) => ({ id: t.id, name: t.name || t.id, sql: t.sql ?? '' })), database: conn.dbname, schema: conn.schema, target: PLACEHOLDER });
		if (plan.unsupported) return { unsupported: plan.unsupported };
		const temps = plan.views.filter((v) => v.kind === 'temp');
		const cteName = new Map(temps.map((v) => [v.fqName, v.name]));
		const swap = (sql) => [...cteName].reduce((s, [fq, name]) => s.split(fq).join(name), sql);
		const needs = (sql, seen = new Set()) => {
			for (const v of temps) if (!seen.has(v.fqName) && sql.includes(v.fqName)) {
				seen.add(v.fqName);
				needs(v.sql, seen);
			}
			return seen;
		};
		const withChain = (sql) => {
			const used = needs(sql);
			const chain = temps.filter((v) => used.has(v.fqName));
			cteCount += chain.length;
			return chain.length ? `WITH ${chain.map((v) => `${v.name} AS (\n${swap(v.sql)}\n)`).join(',\n')}\n${swap(sql)}` : swap(sql);
		};
		for (const t of custom) {
			const view = plan.views.find((v) => v.fqName === plan.customViews.get(t.id));
			if (!view) continue;
			t.sql = withChain(view.sql);
		}
		for (const t of out.tables ?? []) {
			if (t.kind !== 'table' || !own(t)) continue;
			const last = String(t.table || t.name || '').split('.').at(-1).replace(/^\[|\]$/g, '').toLowerCase();
			const fq = plan.tempViews.get(last);
			if (!fq) continue;
			t.kind = 'custom-sql';
			t.sql = withChain(`SELECT * FROM ${fq}`);
			delete t.table;
		}
		for (const key of INITIAL_SQL_KEYS) if (conn.extra) delete conn.extra[key];
	}
	const longest = Math.max(0, ...(out.tables ?? []).filter((t) => t.kind === 'custom-sql').map((t) => inlineCtes(stripComments(t.sql ?? '')).sql.length));
	if (longest > MAX_INLINE_CHARS) return { unsupported: `its temp table chain inlines to ${longest.toLocaleString('en-US')} characters of SQL, too long for one Domo view` };
	return { source: out, cteCount };
}
