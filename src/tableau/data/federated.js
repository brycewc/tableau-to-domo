import { relationParts, isConnectorClass } from '../../convert/connectors.js';
import { initialSqlOf } from '../../convert/initial-sql.js';
import { parseFormula } from '../../convert/calc/parser.js';
import { analyzeFormula } from '../../convert/calc/analyze.js';
import { normalizeHost } from '../../domo/accounts.js';
import { federatedProviders } from '../../domo/federated.js';

export const DEFAULT_CACHE_TTL = 900;
const MIN_CACHE_TTL = 5;
const MAX_CACHE_TTL = 172800;

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** Cache TTL in seconds within the range Domo accepts (5 s to 2 days). */
export function cacheTtlOf(mapping) {
	const value = Number(mapping?.cacheTTL ?? DEFAULT_CACHE_TTL);
	if (!Number.isFinite(value)) return DEFAULT_CACHE_TTL;
	return Math.min(MAX_CACHE_TTL, Math.max(MIN_CACHE_TTL, Math.round(value)));
}

/**
 * Most specific `mappings.federated` entry whose every `match` key equals the connection's (server compares as a host).
 * @param {import('../../model/types.js').ConnectionIR} connection
 * @param {Partial<import('../../model/types.js').Mappings>} [mappings]
 */
export function findFederatedMapping(connection, mappings) {
	let best;
	let bestScore = -1;
	for (const entry of mappings?.federated ?? []) {
		const match = entry?.match ?? {};
		const keys = Object.keys(match).filter((k) => match[k] !== undefined && match[k] !== null && match[k] !== '');
		if (!keys.length) continue;
		const ok = keys.every((key) => (key === 'server' ? normalizeHost(connection?.server) === normalizeHost(match.server) : norm(connection?.[key]) === norm(match[key])));
		if (ok && keys.length > bestScore) {
			best = entry;
			bestScore = keys.length;
		}
	}
	return best;
}

/** The live connection a federated DataSet would read: the one connector-class connection of the source. */
export function federatedConnection(source) {
	const live = (source.connections ?? []).filter((c) => isConnectorClass(c.class));
	return live.length === 1 ? live[0] : undefined;
}

const SELECT_STAR = /^\s*select\s+\*\s+from\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$#@]+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$#@]*))*)\s*;?\s*$/i;

function calcsNeedingEtl(fields) {
	const names = [];
	for (const field of fields ?? []) {
		if (field.kind !== 'calculated' || !field.formula) continue;
		let info;
		try {
			info = analyzeFormula(parseFormula(field.formula));
		} catch {
			continue;
		}
		if (info.lod.length || info.tableCalcs.length) names.push(field.name);
	}
	return names;
}

function hasEtlJoin(node) {
	if (!node) return false;
	if (node.type === 'union') return 'a union';
	if (node.type === 'join' && node.join === 'full') return 'a FULL OUTER join';
	for (const child of node.children ?? []) {
		const found = hasEtlJoin(child);
		if (found) return found;
	}
	return false;
}

/**
 * Whether a datasource can be federated DataSets, and which tables they read. Only plain tables and views qualify
 * (or custom SQL that is exactly `SELECT * FROM x`); a join needs DataSet Views on federated DataSets.
 * @param {import('../../model/types.js').DatasourceIR} source  The datasource, or its published .tds
 * @param {{ mapping?: object, viewsEnabled?: boolean|null, fields?: import('../../model/types.js').FieldIR[] }} [opts]
 *   `viewsEnabled`: feature federated-views (null: could not be read); `fields`: the workbook's own fields too
 * @returns {{ ineligible: string } | { connection: object, targets: { tableId: string, name: string, catalog?: string, schema?: string, table: string }[] }}
 */
export function planFederatedTargets(source, { mapping, viewsEnabled = false, fields = [] } = {}) {
	const tables = source.tables ?? [];
	if (!tables.length) return { ineligible: 'the datasource has no tables' };
	const connection = federatedConnection(source);
	if (!connection) return { ineligible: 'it does not read exactly one database connection' };
	if (!federatedProviders(connection.class).length) return { ineligible: `Domo has no federated provider for ${connection.class}` };
	if (initialSqlOf(connection)) return { ineligible: `the ${connection.class} connection runs Initial SQL, and a federated DataSet reads a table, not a query` };
	const renames = new Map(Object.entries(mapping?.databases ?? {}).map(([from, to]) => [norm(from), to]));
	const targets = [];
	for (const table of tables) {
		const label = table.name || table.id;
		if (table.connectionId && table.connectionId !== connection.id) return { ineligible: `table '${label}' reads another connection` };
		let relation;
		if (table.kind === 'table') relation = table.table || table.name;
		else if (table.kind === 'custom-sql') {
			const m = SELECT_STAR.exec(table.sql ?? '');
			if (!m) return { ineligible: `table '${label}' is custom SQL, and a federated DataSet reads a table or view, not a query` };
			relation = m[1];
		} else return { ineligible: `table '${label}' is a ${table.kind} table` };
		const parts = relationParts(relation);
		if (!parts.length || parts.length > 3) return { ineligible: `table '${label}' has no usable [database].[schema].[table] name` };
		const [name, schema, catalog] = [...parts].reverse();
		const database = catalog || connection.dbname || undefined;
		targets.push({
			tableId: table.id,
			name: label,
			...(database ? { catalog: renames.get(norm(database)) ?? database } : {}),
			...((schema || connection.schema) ? { schema: schema || connection.schema } : String(connection.class).toLowerCase() === 'sqlserver' ? { schema: 'dbo' } : {}),
			table: name
		});
	}
	if (targets.length > 1) {
		const etlJoin = hasEtlJoin(source.relationTree);
		if (etlJoin) return { ineligible: `its tables are combined with ${etlJoin}, which needs Magic ETL, and Magic ETL cannot read federated DataSets` };
		if (viewsEnabled !== true) {
			return { ineligible: `it joins ${targets.length} tables, which needs DataSet Views on federated DataSets (feature federated-views is ${viewsEnabled === null ? 'unreadable' : 'off'} on this instance), and Magic ETL cannot read federated DataSets` };
		}
	}
	const calcs = calcsNeedingEtl([...(source.fields ?? []), ...fields]);
	if (calcs.length) {
		const unique = [...new Set(calcs)];
		return { ineligible: `${unique.length} calculation(s) use LOD expressions or table calculations, which t2d computes in Magic ETL, and Magic ETL cannot read federated DataSets: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', ...' : ''}` };
	}
	return { connection, targets };
}

/** mappings.json entry that pins a connection to a federated account. */
export function federatedEntry(connection, accountId = '<federated account id>', { providerKey, databases, cacheTTL = DEFAULT_CACHE_TTL } = {}) {
	const match = Object.fromEntries(['class', 'server', 'dbname'].filter((k) => connection?.[k]).map((k) => [k, connection[k]]));
	return { match, accountId, providerKey: providerKey ?? federatedProviders(connection?.class)[0], ...(databases && Object.keys(databases).length ? { databases } : {}), cacheTTL };
}
