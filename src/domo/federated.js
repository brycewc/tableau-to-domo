/**
 * Domo federated DataSets: a DataSet that points at catalog.schema.table on a federated
 * account and is queried live. Reads are read-only, but the database browse and
 * column calls connect to the database through the account.
 */

/** Federated provider keys per Tableau connection class. */
const PROVIDERS_BY_CLASS = {
	sqlserver: ['sqlserver-federated'],
	snowflake: ['snowflake-federated', 'snowflake-federated-keypair'],
	postgres: ['postgres-federated'],
	mysql: ['mysql-federated'],
	mariadb: ['mysql-federated'],
	oracle: ['oracle-federated'],
	redshift: ['redshift-federated'],
	bigquery: ['bigquery-federated'],
	teradata: ['teradata-federated'],
	vertica: ['vertica-federated'],
	saphana: ['hana-federated'],
	db2: ['db2-federated'],
	presto: ['presto-federated', 'trino-federated'],
	athena: ['athena-federated'],
	'amazon-athena': ['athena-federated'],
	azure_sql_db: ['azure-federated', 'sqlserver-federated']
};

/**
 * @param {string} connectionClass  Tableau connection class
 * @returns {string[]}  Federated provider keys that can reach it, best first (empty: none)
 */
export function federatedProviders(connectionClass) {
	return PROVIDERS_BY_CLASS[String(connectionClass ?? '').toLowerCase()] ?? [];
}

/** Federated adapters: `{ adapterType, providers: [{ providerType, providerName, hasCloudAgent, hasOnPremiseAgent }] }[]`. */
export async function listAdapters(c) {
	const list = await c.get('/federated/v1/config/adapters');
	return Array.isArray(list) ? list : [];
}

/**
 * Database tree of a federated account (`{ id, name, displayName, type: catalog|schema|table, values }`).
 * Connects to the database.
 */
export async function listDatabases(c, accountId) {
	const tree = await c.get(`/federated/v2/config/accounts/${encodeURIComponent(accountId)}/databases`);
	return Array.isArray(tree) ? tree : tree ? [tree] : [];
}

/** Columns of one table, already as Domo types (`LONG|DOUBLE|DECIMAL|STRING|DATE|DATETIME`). Connects to the database. */
export async function getTableColumns(c, accountId, { catalog, schema, table }) {
	const res = await c.get(`/federated/v1/config/accounts/${encodeURIComponent(accountId)}/databases/columns`, {
		query: { ...(catalog ? { catalog } : {}), ...(schema ? { schema } : {}), table }
	});
	return (Array.isArray(res?.columns) ? res.columns : []).filter((col) => col?.name).map((col) => ({ name: col.name, type: col.type ?? 'STRING' }));
}

/**
 * Create a federated DataSet. Domo checks every column against the table and counts its rows.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} accountId
 * @param {{ name: string, description?: string, catalog?: string, schema?: string, table: string, cacheTTL: number, columns: { name: string, type: string }[] }} spec
 * @returns {Promise<string>}  The DataSet id
 */
export async function createFederatedDataset(c, accountId, { name, description = '', catalog, schema, table, cacheTTL, columns }) {
	const res = await c.post(`/federated/v1/config/accounts/${encodeURIComponent(accountId)}/datasources`, {
		dataSourceName: name,
		dataSourceDescription: description,
		server: null,
		catalog: catalog ?? null,
		schema: schema ?? null,
		table,
		cacheTTL,
		columns: columns.map((col) => ({ name: col.name, type: col.type, sourceType: null })),
		additionalProperties: {}
	});
	const id = res?.dataSourceId ?? res?.id;
	if (!id) throw new Error('Federated DataSet create returned no dataSourceId');
	return String(id);
}

/** `{ accountId, dataProviderType, catalog, schema, table, cacheTTL, ... }` of a federated DataSet. */
export async function getFederatedDataset(c, id) {
	return c.get(`/federated/v1/config/datasources/${encodeURIComponent(id)}`);
}

/** Change the cache TTL. Every update adds a schema version and recounts the rows, so call it only on a change. */
export async function updateFederatedCacheTtl(c, id, cacheTTL) {
	return c.post(`/federated/v1/config/datasources/${encodeURIComponent(id)}`, { cacheTTL });
}

/** Federated DataSets are deleted like any other DataSet. */
export async function deleteFederatedDataset(c, id) {
	return c.del(`/data/v3/datasources/${encodeURIComponent(id)}`);
}

/**
 * Find catalog/schema/table in a database tree, case-insensitively when the exact name is missing.
 * @returns {{ catalog?: string, schema?: string, table: string }|null}  The names as the tree spells them
 */
export function findInTree(tree, { catalog, schema, table }) {
	const pick = (nodes, name) => {
		if (!name) return nodes.length === 1 ? nodes[0] : undefined;
		const exact = nodes.find((n) => nameOf(n) === name);
		if (exact) return exact;
		const folded = nodes.filter((n) => String(nameOf(n)).toLowerCase() === String(name).toLowerCase());
		return folded.length === 1 ? folded[0] : undefined;
	};
	const kids = (n) => (Array.isArray(n?.values) ? n.values : []);
	const byType = (nodes, type) => nodes.filter((n) => String(n.type ?? '').toLowerCase() === type);
	let level = tree;
	const out = {};
	for (const [type, wanted] of [['catalog', catalog], ['schema', schema]]) {
		if (!byType(level, type).length) continue;
		const node = pick(byType(level, type), wanted);
		if (!node) return null;
		out[type] = nameOf(node);
		level = kids(node);
	}
	const node = pick(byType(level, 'table').length ? byType(level, 'table') : level, table);
	if (!node) return null;
	out.table = nameOf(node);
	return out;
}

const nameOf = (n) => n?.name ?? n?.displayName;

/** Catalog names of a database tree. */
export function treeCatalogs(tree) {
	return tree.filter((n) => String(n.type ?? '').toLowerCase() === 'catalog').map(nameOf);
}
