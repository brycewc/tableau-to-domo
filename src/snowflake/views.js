import { createHash } from 'node:crypto';
import { parseInitialSql } from '../convert/initial-sql.js';
import { parseSqlTableRefs } from '../tableau/data/sql-refs.js';

/**
 * Snowflake views for a Tableau connection whose Initial SQL builds temp tables: each CREATE TEMP TABLE ... AS SELECT
 * becomes a view in the target schema, and each Custom SQL query a view over those, so Cloud Amplifier can read the
 * result live. Pure, no I/O.
 *
 * @typedef {{ database: string, schema: string }} ViewTarget
 * @typedef {{ name: string, fqName: string, kind: 'temp'|'custom', source: string, sql: string, ddl: string }} PlannedView
 */

const IGNORED = new Set(['session', 'dead', 'transaction', 'print', 'select']);
const PREFIX = 'T2D_';

const ident = (name) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name.toUpperCase() : `"${String(name).replace(/"/g, '""')}"`);
const partName = (p) => (p.quoted ? `"${p.name.replace(/"/g, '""')}"` : p.name);
const slug = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'VIEW';
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 6).toUpperCase();
const normalize = (sql) => String(sql).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;+$/, '');

/**
 * @param {{ initialSql?: string, customSql?: { id: string, name: string, sql: string }[], database?: string, schema?: string, target: ViewTarget, label?: string }} opts
 *   `database`/`schema`: the connection's own defaults, before any USE in the Initial SQL
 * @returns {{ views: PlannedView[], customViews: Map<string, string>, tempViews: Map<string, string>, unsupported?: string }}  `tempViews`: lower-case temp table name -> view
 */
export function planSnowflakeViews({ initialSql = '', customSql = [], database, schema, target, label = '' }) {
	const views = [];
	const temps = new Map();
	const pending = new Map();
	const customViews = new Map();
	let db = database;
	let sc = schema;
	const targetFq = (name) => `${ident(target.database)}.${ident(target.schema)}.${name}`;

	const qualify = (sql) => {
		const parsedRefs = parseSqlTableRefs(sql);
		if (parsedRefs.unsupported && !/no table references/.test(parsedRefs.unsupported)) return { unsupported: parsedRefs.unsupported };
		const refs = parsedRefs.refs ?? [];
		for (const ref of refs) {
			const last = ref.parts.at(-1).name.toLowerCase();
			if (ref.parts.length === 1 && pending.has(last)) {
				const r = finalize(last);
				if (r.unsupported) return r;
			}
		}
		let out = sql;
		for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
			const last = ref.parts.at(-1).name.toLowerCase();
			let replacement;
			if (temps.has(last) && (ref.parts.length === 1 || temps.get(last).qualified)) replacement = temps.get(last).fqName;
			else if (ref.parts.length === 3) continue;
			else if (ref.parts.length === 2) {
				if (!db) return { unsupported: `table ${ref.parts.map(partName).join('.')} has no database and no USE DATABASE sets one` };
				replacement = `${ident(db)}.${ref.parts.map(partName).join('.')}`;
			} else {
				if (!db || !sc) return { unsupported: `table ${ref.parts[0].name} has no database or schema and no USE sets them` };
				replacement = `${ident(db)}.${ident(sc)}.${partName(ref.parts[0])}`;
			}
			out = `${out.slice(0, ref.start)}${replacement}${out.slice(ref.end)}`;
		}
		return { sql: out };
	};

	const add = (kind, baseName, source, query) => {
		const q = qualify(query);
		if (q.unsupported) return q;
		const body = normalize(q.sql);
		const name = kind === 'temp' ? `${PREFIX}${slug(baseName)}_${hash(body)}` : `${PREFIX}${slug(baseName)}`;
		const fqName = targetFq(name);
		if (!views.some((v) => v.fqName === fqName)) {
			const comment = `Created by t2d from ${kind === 'temp' ? `temp table ${baseName} in the Initial SQL` : 'Custom SQL'} of ${source}`.replace(/'/g, "''");
			views.push({ name, fqName, kind, source, sql: q.sql.trim().replace(/;+\s*$/, ''), ddl: `CREATE OR REPLACE VIEW ${fqName} COMMENT = '${comment}' AS\n${q.sql.trim().replace(/;+\s*$/, '')}` });
		}
		return { fqName };
	};

	/** A table created with columns and filled by INSERTs, as one SELECT over its VALUES rows and inserted queries. */
	function finalize(key) {
		const t = pending.get(key);
		pending.delete(key);
		const columns = t.columns.map(ident);
		const parts = [];
		for (const row of t.rows) parts.push(`SELECT ${row.map((v, i) => `${v} AS ${columns[i]}`).join(', ')}`);
		for (const q of t.selects) parts.push(`SELECT * FROM (${q.trim().replace(/;+\s*$/, '')})`);
		if (!parts.length) parts.push(`SELECT ${columns.map((c) => `NULL AS ${c}`).join(', ')} WHERE FALSE`);
		const r = add('temp', t.name, label, parts.join('\nUNION ALL\n'));
		if (r.unsupported) return { unsupported: `temp table ${t.name}: ${r.unsupported}` };
		temps.set(key, { fqName: r.fqName, qualified: false });
		return r;
	}

	let parsed;
	try {
		parsed = parseInitialSql(initialSql);
	} catch (err) {
		return { views: [], customViews, unsupported: `the Initial SQL could not be read: ${err.message}` };
	}
	for (const item of parsed.items) {
		if (IGNORED.has(item.kind)) continue;
		if (item.kind === 'use') {
			const parts = item.parts ?? [];
			if (item.target === 'DATABASE') db = parts.at(-1);
			else if (item.target === 'SCHEMA') {
				if (parts.length > 1) db = parts.at(-2);
				sc = parts.at(-1);
			} else if (!item.target || item.target === 'NAMESPACE') {
				if (parts.length > 1) db = parts.at(-2);
				sc = parts.at(-1);
			}
			continue;
		}
		if (item.kind === 'drop') continue;
		const key = String(item.temp ?? '').toLowerCase();
		if (item.kind === 'create' && item.columns?.length && !temps.has(key)) {
			pending.set(key, { name: item.temp, columns: item.columns, rows: [], selects: [] });
			continue;
		}
		if (item.kind === 'insert' && pending.has(key)) {
			const t = pending.get(key);
			const same = !item.columns?.length || (item.columns.length === t.columns.length && item.columns.every((c, i) => c.toLowerCase() === t.columns[i].toLowerCase()));
			if (same && item.values) {
				t.rows.push(...item.values);
				continue;
			}
			if (same && item.query) {
				t.selects.push(item.query);
				continue;
			}
		}
		if (item.kind === 'define') {
			const r = add('temp', item.temp, label, item.query);
			if (r.unsupported) return { views, customViews, unsupported: `temp table ${item.temp}: ${r.unsupported}` };
			temps.set(String(item.temp).toLowerCase(), { fqName: r.fqName, qualified: (item.parts ?? []).length > 1 });
			continue;
		}
		return { views, customViews, unsupported: `the Initial SQL runs ${item.kind.toUpperCase()}${item.temp ? ` on ${item.temp}` : ''}, which changes data in steps a view cannot express` };
	}
	for (const rel of customSql) {
		const r = add('custom', `${label} ${rel.name}`, label, rel.sql);
		if (r.unsupported) return { views, customViews, unsupported: `Custom SQL ${rel.name}: ${r.unsupported}` };
		customViews.set(rel.id, r.fqName);
	}
	return { views, customViews, tempViews: new Map([...temps].map(([k, v]) => [k, v.fqName])) };
}
