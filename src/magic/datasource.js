import { initialSqlOf } from '../convert/initial-sql.js';
import { sqlToMagic } from './index.js';

/**
 * A Snowflake datasource whose Initial SQL builds temp tables, planned as one Magic ETL dataflow on the Cloud Amplifier
 * warehouse: the warehouse tables the script reads are its inputs (Cloud Amplifier datasets), and each Custom SQL query
 * (and each relation that reads a temp table) is one output. Pure, no I/O.
 *
 * @typedef {Object} WarehouseTable
 * @property {string} key       Fully qualified name as the script reads it (DB.SCHEMA.TABLE, upper-case)
 * @property {string} database  Database as the integration sees it (after `databases` renames)
 * @property {string} schema
 * @property {string} name
 * @property {any} dataSourceId  What the LoadFromVault tile reads (`datasetRef`'s value)
 *
 * @typedef {Object} DatasourceDataflowOptions
 * @property {string} cloudId                                     Cloud Amplifier integration that computes the dataflow
 * @property {Record<string, string>} [databases]                 Script database -> integration database (a share renames it)
 * @property {(t: { database: string, schema: string, name: string }) => { name: string, type?: string }[]|undefined} [columns]
 *   Warehouse columns of a table, when known (browse the integration): more statements become tiles
 * @property {(t: { database: string, schema: string, name: string, key: string }) => any} [datasetRef]  dataSourceId for a table (default: `ca:<db.schema.name>`)
 * @property {string} [name]                                      Dataflow (and output name) prefix
 * @property {'auto'|'tiles'|'sql'} [mode]                     Default `sql`: a SQL tile per query, tiles where the SQL tile cannot
 *
 * @typedef {Object} ConnectionDataflow
 * @property {string} connectionId
 * @property {import('./index.js').SqlToMagicResult} result
 * @property {WarehouseTable[]} tables                            Inputs to register through Cloud Amplifier
 * @property {{ definition: object, outputs: { name: string, columns: object[]|null, intermediate: boolean, actionId: string, tableId?: string }[] }[]} stages
 *   The dataflows to create and run, in order (one unless ADR's action limit forces a split); a later stage reads an
 *   earlier stage's intermediate output through a LoadFromVault with dataSourceId `stage:<output name>`
 * @property {{ tableId: string, name: string, actionId?: string, columns: import('./index.js').OutputColumn[]|null }[]} outputs
 *   Datasource relation -> PublishToVault, with the output dataset's columns as Domo names them
 */

/**
 * @param {any} source  Datasource IR (a published datasource's .tds for sqlproxy)
 * @param {DatasourceDataflowOptions} opts
 * @returns {{ dataflows: ConnectionDataflow[], blocked?: import('./index.js').Blocker }}
 */
export function planInitialSqlDataflow(source, opts) {
	const rename = opts.databases ?? {};
	const dataflows = [];
	const connections = (source.connections ?? []).filter((c) => String(c.class).toLowerCase() === 'snowflake' && initialSqlOf(c));
	for (const conn of connections) {
		const own = (t) => (t.connectionId ? t.connectionId === conn.id : (source.connections ?? []).length === 1);
		const label = opts.name ?? source.caption ?? source.name ?? conn.id;
		const custom = (source.tables ?? []).filter((t) => t.kind === 'custom-sql' && own(t)).map((t) => ({ tableId: t.id, name: `${label} - ${t.name || t.id}`, sql: t.sql ?? '' }));
		const tables = new Map();
		const inputs = (t) => {
			const [database, schema, name] = t.parts.length === 3 ? t.parts : [undefined, ...t.parts].slice(-3);
			const located = { database: rename[database] ?? database, schema, name, key: t.key };
			const dataSourceId = opts.datasetRef ? opts.datasetRef(located) : `ca:${[located.database, schema, name].join('.')}`;
			tables.set(t.key, { ...located, dataSourceId });
			return { dataSourceId, name, columns: opts.columns?.(located) };
		};
		const run = (outputs) => sqlToMagic(initialSqlOf(conn), { inputs, outputs, database: conn.dbname, schema: conn.schema, compute: { type: 'adr', cloudId: opts.cloudId }, mode: opts.mode ?? 'sql', name: `${label} (Initial SQL)` });
		const first = run(custom);
		const created = new Set(first.tables ?? []);
		const relations = (source.tables ?? [])
			.filter((t) => t.kind === 'table' && own(t))
			.map((t) => ({ t, parts: String(t.table ?? t.name ?? '').split('.').map((p) => p.replace(/^\[|\]$/g, '')) }))
			.filter(({ parts }) => created.has(qualify(parts, conn)))
			.map(({ t, parts }) => ({ tableId: t.id, name: `${label} - ${t.name || t.id}`, sql: `SELECT * FROM ${parts.map((p) => `"${p.toUpperCase().replace(/"/g, '""')}"`).join('.')}` }));
		const outputs = [...custom, ...relations];
		tables.clear();
		const result = run(outputs);
		if (result.blocked) return { dataflows, blocked: result.blocked };
		dataflows.push({
			connectionId: conn.id,
			result,
			tables: result.inputs.map((i) => tables.get(i.table)).filter(Boolean),
			stages: result.stages.map((st) => ({
				definition: st.definition,
				outputs: st.outputs.map((o) => {
					const tableId = o.intermediate ? undefined : outputs.find((x) => x.name === o.name)?.tableId;
					return { ...o, ...(tableId ? { tableId } : {}) };
				})
			})),
			outputs: outputs.map((o) => {
				const out = result.outputs.find((x) => x.name === o.name);
				return { tableId: o.tableId, name: o.name, actionId: out?.actionId, columns: out?.columns ?? null };
			})
		});
	}
	return { dataflows };
}

function qualify(parts, conn) {
	const up = parts.map((p) => p.toUpperCase());
	if (up.length === 1) return [conn.dbname, conn.schema, up[0]].filter(Boolean).map((p) => p.toUpperCase()).join('.');
	if (up.length === 2) return [conn.dbname, ...up].filter(Boolean).map((p) => p.toUpperCase()).join('.');
	return up.slice(-3).join('.');
}
