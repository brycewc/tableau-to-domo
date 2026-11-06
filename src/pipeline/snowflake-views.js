import fs from 'node:fs';
import path from 'node:path';
import { INITIAL_SQL_KEYS, initialSqlOf } from '../convert/initial-sql.js';
import { planSnowflakeViews } from '../snowflake/views.js';
import { slugify } from '../util/ids.js';

/**
 * Turns a Snowflake connection's Initial SQL temp tables, and the Custom SQL reading them, into views in the
 * configured schema, then hands back the datasource with those relations pointing at the views so Cloud Amplifier
 * can register them. Without a client (no Snowflake settings) or in a plan-only run, only writes the DDL.
 *
 * @param {{ client?: import('../snowflake/client.js').SnowflakeClient|null, target: { database: string, schema: string }, dir: string, emitter?: any }} opts
 */
export function createSnowflakeViews({ client = null, target, dir, emitter }) {
	const created = new Map();

	/** A view of that name made by someone else must not be replaced. */
	async function ownedOrAbsent(view) {
		const like = view.name.replace(/'/g, "''");
		const { rows, columns } = await client.execute(`SHOW VIEWS LIKE '${like}' IN SCHEMA ${view.fqName.split('.').slice(0, 2).join('.')}`);
		if (!rows.length) return true;
		const comment = rows[0][columns.findIndex((c) => c.toLowerCase() === 'comment')] ?? '';
		return String(comment).startsWith('Created by t2d');
	}

	/**
	 * @param {any} source  datasource IR (a published datasource's .tds for sqlproxy)
	 * @param {{ label: string, planOnly?: boolean }} opts
	 * @returns {Promise<{ source?: any, file?: string, created: string[], issues: { severity: string, code: string, message: string, suggestion?: string }[] }>}
	 */
	return async function prepare(source, { label, planOnly = false }) {
		const issues = [];
		const out = structuredClone(source);
		const connections = (out.connections ?? []).filter((c) => String(c.class).toLowerCase() === 'snowflake' && initialSqlOf(c));
		if (!connections.length) return { created: [], issues };
		const all = [];
		for (const conn of connections) {
			const tables = (out.tables ?? []).filter((t) => t.kind === 'custom-sql' && (t.connectionId ? t.connectionId === conn.id : (out.connections ?? []).length === 1));
			const plan = planSnowflakeViews({
				initialSql: initialSqlOf(conn),
				customSql: tables.map((t) => ({ id: t.id, name: t.name || t.id, sql: t.sql ?? '' })),
				database: conn.dbname,
				schema: conn.schema,
				target,
				label
			});
			if (plan.unsupported) {
				issues.push({ severity: 'info', code: 'data.snowflake-views-unsupported', message: `Snowflake views not planned for '${label}': ${plan.unsupported}.`, suggestion: 'It keeps the Magic ETL or snapshot path.' });
				return { created: [], issues };
			}
			all.push({ conn, tables, plan });
		}
		const views = [...new Map(all.flatMap((a) => a.plan.views).map((v) => [v.fqName, v])).values()];
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${slugify(label)}.sql`);
		fs.writeFileSync(file, `-- Views t2d plans for '${label}', in dependency order.\n${views.map((v) => `${v.ddl};\n`).join('\n')}`);
		if (!client || planOnly) {
			issues.push({
				severity: 'warning',
				code: 'data.snowflake-views-ddl',
				message: `'${label}' needs ${views.length} Snowflake view(s) for Cloud Amplifier; ${client ? 'this run only planned them' : 'no Snowflake settings are configured, so t2d did not create them'}. The DDL is in ${file}.`,
				suggestion: client ? 'Run extract without plan-only to create them.' : 'Set the SNOWFLAKE_* settings, or run the DDL yourself and extract again.'
			});
			return { file, created: [], issues };
		}
		const made = [];
		for (const view of views) {
			if (created.get(view.fqName) === view.ddl) continue;
			if (!(await ownedOrAbsent(view))) {
				issues.push({ severity: 'error', code: 'data.snowflake-view-exists', message: `View ${view.fqName} already exists and was not created by t2d; it was left alone, and '${label}' keeps its snapshot.` });
				return { file, created: made, issues };
			}
			await client.execute(view.ddl);
			created.set(view.fqName, view.ddl);
			made.push(view.fqName);
			emitter?.info?.(`Created Snowflake view ${view.fqName}`);
		}
		for (const { conn, tables, plan } of all) {
			for (const key of INITIAL_SQL_KEYS) if (conn.extra) delete conn.extra[key];
			const bracketed = (fq) => fq.split('.').map((p) => `[${p.replace(/^"|"$/g, '')}]`).join('.');
			for (const t of tables) {
				const fq = plan.customViews.get(t.id);
				if (!fq) continue;
				t.kind = 'table';
				t.table = bracketed(fq);
				delete t.sql;
			}
			for (const t of out.tables ?? []) {
				if (t.kind !== 'table' || (t.connectionId && t.connectionId !== conn.id)) continue;
				const last = String(t.table || t.name || '').split('.').at(-1).replace(/^\[|\]$/g, '').toLowerCase();
				if (plan.tempViews.has(last)) t.table = bracketed(plan.tempViews.get(last));
			}
		}
		issues.push({ severity: 'info', code: 'data.snowflake-views', message: `'${label}' reads ${views.length} Snowflake view(s) t2d created from its Initial SQL and Custom SQL (${views.map((v) => v.fqName).join(', ')}); the DDL is in ${file}.` });
		return { source: out, file, created: made, issues };
	};
}
