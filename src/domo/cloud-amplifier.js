import { sleep as defaultSleep } from '../util/http.js';

/**
 * Cloud Amplifier (BYOS) integrations: list, browse (read-only) and register warehouse tables as datasets.
 *
 * @typedef {Object} Integration
 * @property {string} id
 * @property {string} engine          SNOWFLAKE | BIGQUERY | DATABRICKS | POSTGRES | MYSQL | REDSHIFT | ORACLE | ...
 * @property {string} name
 * @property {string} [database]
 * @property {string} [defaultSchema]
 * @property {string} [host]          Server host when the integration exposes it (endpoint, url or rawURL)
 * @property {string} [port]
 * @property {boolean} writeable
 * @property {boolean} initialized
 * @property {string} [authMethod]
 * @property {string} [serviceAccountId]
 *
 * @typedef {{ account?: string, providerKey?: string, reason?: string }} WarehouseAccount  `reason` when unknown
 */

const BYOS = '/query/v1/byos/accounts';
const PAGE_ROWS = 500;

const PROVIDER_KEYS = {
	SNOWFLAKE: 'snowflake',
	BIGQUERY: 'google-bigquery',
	DATABRICKS: 'databricks',
	POSTGRES: 'postgresql',
	POSTGRESQL: 'postgresql',
	MYSQL: 'mysql',
	REDSHIFT: 'amazon-redshift',
	ORACLE: 'oracle',
	AZURE_SQL: 'microsoft-azure-sql-database',
	AZURESQL: 'microsoft-azure-sql-database',
	SQLSERVER: 'microsoft-azure-sql-database',
	ATHENA: 'aws-athena-arn',
	LAKEBASE: 'lakebase'
};

const TRANSIENT = /snowflake incident|cold start|warehouse (is )?(suspended|starting|resuming)|unable to fetch warehouses|statement is closed|could not fetch database objects|maestrosqlexception|timeout|timed out|temporarily unavailable/i;

/**
 * Normalized host for comparisons: lower case, no protocol, port, path or trailing dot.
 * @param {string} [value]
 */
export function normalizeHost(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
		.replace(/[/?#].*$/, '')
		.replace(/:\d+$/, '')
		.replace(/\.$/, '');
}

function prop(raw, name) {
	const value = raw?.properties?.[name];
	return value && typeof value === 'object' ? value.value : value;
}

/**
 * @param {any} raw  One element of GET /query/v1/byos/accounts
 * @returns {Integration}
 */
export function normalizeIntegration(raw) {
	const host = raw.endpoint ?? raw.url ?? prop(raw, 'endpoint') ?? prop(raw, 'url') ?? prop(raw, 'rawURL') ?? prop(raw, 'host');
	const database = raw.database ?? prop(raw, 'database');
	const defaultSchema = raw.defaultSchema ?? prop(raw, 'default_schema');
	const port = raw.port ?? prop(raw, 'port');
	const authMethod = raw.authMethod ?? prop(raw, 'AUTH_METHOD');
	const serviceAccountId = raw.serviceAccountId ?? prop(raw, 'serviceAccountId');
	return {
		id: String(raw.id),
		engine: String(raw.engine ?? '').toUpperCase(),
		name: raw.friendlyName ?? prop(raw, 'friendlyName') ?? String(raw.id),
		...(database ? { database: String(database) } : {}),
		...(defaultSchema ? { defaultSchema: String(defaultSchema) } : {}),
		...(host ? { host: normalizeHost(host) } : {}),
		...(port ? { port: String(port) } : {}),
		writeable: raw.writeable === true || raw.writeable === 'true',
		initialized: raw.initialized === true || raw.initialized === 'true',
		...(authMethod ? { authMethod: String(authMethod) } : {}),
		...(serviceAccountId ? { serviceAccountId: String(serviceAccountId) } : {})
	};
}

const SNOWFLAKE_PROVIDER_KEYS = ['snowflakekeypairauthentication', 'snowflake', 'snowflake-oauth'];

/**
 * Snowflake account of a service account. Only `account` is read: the rest of the response holds credentials,
 * and failures keep only the HTTP status. Never throws.
 * @param {import('./client.js').DomoClient} c
 * @param {string} [serviceAccountId]
 * @returns {Promise<WarehouseAccount>}
 */
export async function getSnowflakeAccount(c, serviceAccountId) {
	if (!serviceAccountId) return { reason: 'the integration names no service account' };
	const id = seg(serviceAccountId);
	const statusOf = (err) => (typeof err?.status === 'number' ? `HTTP ${err.status}` : 'request failed');
	let providerKey;
	let lookupError;
	try {
		const meta = await c.get(`/data/v1/accounts/${id}`);
		providerKey = typeof meta?.dataProviderType === 'string' ? meta.dataProviderType : undefined;
	} catch (err) {
		lookupError = statusOf(err);
	}
	if (providerKey && !/^snowflake/i.test(providerKey)) return { providerKey, reason: `service account provider ${providerKey} is not Snowflake` };
	const errors = [];
	// The `snowflake` provider masks `account`; the key-pair provider's field list reads the same account unmasked.
	for (const key of new Set([providerKey ?? SNOWFLAKE_PROVIDER_KEYS[0], ...SNOWFLAKE_PROVIDER_KEYS])) {
		for (const unmask of [false, true]) {
			let account;
			try {
				account = accountField(await c.get(`/data/v1/providers/${seg(key)}/account/${id}`, unmask ? { query: { unmask: true } } : {}));
			} catch (err) {
				errors.push(statusOf(err));
				break;
			}
			if (account) return { account, providerKey: providerKey ?? key };
		}
	}
	const why = errors.length ? errors[errors.length - 1] : 'no account field';
	return { ...(providerKey ? { providerKey } : {}), reason: `service account ${serviceAccountId}: ${lookupError && !providerKey ? `${lookupError}, ` : ''}${why}` };
}

/**
 * {@link getSnowflakeAccount} for every Snowflake integration, once per service account.
 * @param {import('./client.js').DomoClient} c
 * @param {Integration[]} integrations
 * @returns {Promise<Map<string, WarehouseAccount>>}  By integration id
 */
export async function resolveSnowflakeAccounts(c, integrations) {
	const byServiceAccount = new Map();
	const snowflake = integrations.filter((i) => i.engine === 'SNOWFLAKE');
	for (const i of snowflake) if (!byServiceAccount.has(i.serviceAccountId)) byServiceAccount.set(i.serviceAccountId, null);
	const ids = [...byServiceAccount.keys()];
	let next = 0;
	const worker = async () => {
		while (next < ids.length) {
			const id = ids[next++];
			byServiceAccount.set(id, await getSnowflakeAccount(c, id));
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
	return new Map(snowflake.map((i) => [i.id, byServiceAccount.get(i.serviceAccountId)]));
}

function accountField(response) {
	const value = response?.account;
	return typeof value === 'string' && value.trim() && !/^\*+$/.test(value.trim()) ? value.trim() : undefined;
}

const REGION = /^[a-z]+(-[a-z0-9]+)+$/;

/**
 * Snowflake account from a host or identifier: org-account (underscores read as hyphens) or locator.region
 * (AWS implied, a bare locator is us-west-2); null when it is neither.
 * @param {string} [value]
 * @returns {{ kind: 'org'|'locator', id: string }|null}
 */
export function parseSnowflakeAccount(value) {
	const host = normalizeHost(value);
	const isHost = /\.snowflakecomputing\.(com|cn)$/.test(host);
	const [first, ...rest] = host.replace(/\.snowflakecomputing\.(com|cn)$/, '').replace(/\.privatelink$/, '').split('.');
	if (!first || !/^[a-z0-9_-]+$/.test(first)) return null;
	if (/[-_]/.test(first)) return rest.length ? null : { kind: 'org', id: first.replace(/_/g, '-') };
	const [region, cloud, ...extra] = rest;
	if (extra.length || (region && !REGION.test(region)) || (cloud && !['aws', 'azure', 'gcp'].includes(cloud))) return null;
	if (!region && !isHost && !/\d/.test(first)) return null;
	return { kind: 'locator', id: `${first}.${region ?? 'us-west-2'}${cloud && cloud !== 'aws' ? `.${cloud}` : ''}` };
}

/**
 * A locator and an org-account name cannot be compared by name, so they are 'unknown'.
 * @param {string} [a]
 * @param {string} [b]
 * @returns {'equal'|'differs'|'unknown'}
 */
export function compareSnowflakeAccounts(a, b) {
	const x = parseSnowflakeAccount(a);
	const y = parseSnowflakeAccount(b);
	if (!x || !y || x.kind !== y.kind) return 'unknown';
	return x.id === y.id ? 'equal' : 'differs';
}

/**
 * Register `dataProviderKey` for an integration. Lakebase integrations report engine POSTGRES.
 * @param {Integration} integration
 * @returns {string|undefined}
 */
export function dataProviderKeyFor(integration) {
	const engine = String(integration?.engine ?? '').toUpperCase();
	if (engine === 'POSTGRES' && /\.database\.(cloud\.|azure)?databricks\.(com|net)$/.test(integration?.host ?? '')) return 'lakebase';
	return PROVIDER_KEYS[engine];
}

/** True for warehouse incidents and cold starts, which must not be read as "the object does not exist". */
export function isTransientByosError(err) {
	if (!err) return false;
	if (typeof err.status === 'number' && [408, 429, 500, 502, 503, 504].includes(err.status)) return true;
	return TRANSIENT.test(`${err.message ?? ''} ${err.body ?? ''}`);
}

/**
 * Run `fn`, retrying transient Cloud Amplifier errors with backoff.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delaysMs?: number[], sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(fn, { attempts = 3, delaysMs = [2000, 5000], sleep = defaultSleep } = {}) {
	let last;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			last = err;
			if (!isTransientByosError(err) || attempt === attempts) throw err;
			await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0);
		}
	}
	throw last;
}

const seg = (v) => encodeURIComponent(String(v));

/**
 * @param {import('./client.js').DomoClient} c
 * @returns {Promise<Integration[]>}
 */
export async function listIntegrations(c) {
	const raw = await c.get(BYOS);
	return (Array.isArray(raw) ? raw : []).filter((r) => r?.id).map(normalizeIntegration);
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @returns {Promise<Integration>}
 */
export async function getIntegration(c, id) {
	return normalizeIntegration(await c.get(`${BYOS}/${seg(id)}`));
}

async function allPages(c, path, query = {}) {
	const out = [];
	for (let page = 0; page < 200; page++) {
		const items = await c.get(path, { query: { ...query, rows: PAGE_ROWS, page } });
		const list = Array.isArray(items) ? items : [];
		out.push(...list);
		if (list.length < PAGE_ROWS) break;
	}
	return out;
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @returns {Promise<string[]>}
 */
export async function listDatabases(c, id) {
	return (await allPages(c, `${BYOS}/${seg(id)}/databases`)).map((d) => d?.databaseName ?? d?.name).filter(Boolean);
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {string} database
 * @returns {Promise<string[]>}
 */
export async function listSchemas(c, id, database) {
	return (await allPages(c, `${BYOS}/${seg(id)}/databases/${seg(database)}/schemas`)).map((s) => s?.schemaName ?? s?.name).filter(Boolean);
}

/**
 * Tables and views in a schema. `datasource` is set when the object is already registered.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {string} database
 * @param {string} schema
 * @returns {Promise<{ tableName: string, tableType?: string, datasource?: string }[]>}
 */
export async function listObjects(c, id, database, schema) {
	return (await allPages(c, `${BYOS}/${seg(id)}/databases/${seg(database)}/schemas/${seg(schema)}/objects`)).filter((o) => o?.tableName);
}

/**
 * Columns of one warehouse object, as the Cloud Amplifier dataset will expose them.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {string} database
 * @param {string} schema
 * @param {string} object
 * @returns {Promise<{ name: string, type: string, sourceType?: string }[]>}
 */
export async function getObjectColumns(c, id, database, schema, object) {
	const res = await c.get(`${BYOS}/${seg(id)}/databases/${seg(database)}/schemas/${seg(schema)}/objects/${seg(object)}`);
	const columns = Array.isArray(res?.columns) ? res.columns : (res?.tables ?? []).flatMap((t) => t?.columns ?? []);
	return columns.filter((col) => col?.name).map((col) => ({ name: col.name, type: col.type ?? 'STRING', ...(col.sourceType ? { sourceType: col.sourceType } : {}) }));
}

/**
 * @typedef {Object} RegistrationResult
 * @property {string} datasetId
 * @property {'SUCCESS'|'SKIPPED'} status
 * @property {boolean} alreadyRegistered
 * @property {boolean} [afterRetry]   The result came from a retry after a failed attempt, which may itself have registered the table
 */

function registrationError(entry) {
	const error = new Error(`Cloud Amplifier registration failed: ${entry?.error?.code ?? entry?.status ?? 'unknown'}${entry?.error?.message ? `: ${entry.error.message}` : ''}`);
	error.body = JSON.stringify(entry ?? null);
	return error;
}

/**
 * Parse one registration result (new `{ summary, results }` or old array format).
 * @param {any} entry
 * @returns {RegistrationResult}
 */
export function parseRegistration(entry) {
	if (entry?.status === 'SUCCESS' && entry.datasource) return { datasetId: entry.datasource, status: 'SUCCESS', alreadyRegistered: false };
	if (entry?.status === 'SKIPPED' && entry.error?.code === 'ALREADY_REGISTERED') {
		const id = /registered as ([0-9a-f-]{36})/i.exec(entry.error.message ?? '')?.[1] ?? entry.datasource;
		if (id) return { datasetId: id, status: 'SKIPPED', alreadyRegistered: true };
	}
	if (entry?.status == null && entry?.datasource) return { datasetId: entry.datasource, status: 'SUCCESS', alreadyRegistered: false };
	throw registrationError(entry);
}

const tableId = (t) => [t?.databaseName, t?.schemaName, t?.tableName].join('\u0000');

/**
 * Register warehouse tables as Cloud Amplifier datasets (mutating). Retries warehouse cold starts 3 times,
 * 30 s apart. An already registered table returns its existing dataset id.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {string} integrationId
 * @param {{ databaseName: string, schemaName: string, tableName: string, dataProviderKey: string, displayName?: string }[]} tables
 * @param {{ attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<RegistrationResult[]>} One per table, in the order of `tables`
 */
export async function registerTables(c, integrationId, tables, { attempts = 3, delayMs = 30000, sleep = defaultSleep } = {}) {
	if (!tables.length) return [];
	let tries = 0;
	const attempt = async () => {
		tries++;
		const raw = await c.post(`/data/v1/byos/register/${seg(integrationId)}`, tables, { idempotent: false, timeoutMs: 300000 });
		const results = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : null;
		if (!results) throw new Error(`Unexpected Cloud Amplifier registration response: ${JSON.stringify(raw).slice(0, 500)}`);
		if (results.length !== tables.length) {
			throw new Error(`Cloud Amplifier registration returned ${results.length} result(s) for ${tables.length} table(s)`);
		}
		const named = results.every((r) => r?.tableName);
		const byName = new Map(named ? results.map((r) => [tableId(r), r]) : []);
		const ordered = tables.map((t, i) => {
			if (!named) return results[i];
			const hit = byName.get(tableId(t));
			if (!hit) throw new Error(`Cloud Amplifier registration returned no result for ${t.databaseName}.${t.schemaName}.${t.tableName}`);
			return hit;
		});
		const parsed = ordered.map(parseRegistration);
		return tries > 1 ? parsed.map((r) => ({ ...r, afterRetry: true })) : parsed;
	};
	return withTransientRetry(attempt, { attempts, delaysMs: [delayMs], sleep });
}

/** @typedef {{ database: string, schemaName: string, tableName: string }} WarehouseTable */

const nameWords = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const MAX_TABLE_NAME = 128;

/** Already in the form ice's sanitizer gives (one `_` per run of other characters), so ice keeps it as sent. */
export function warehouseTableName(scope, name) {
	const prefix = nameWords(scope);
	let words = nameWords(name);
	if (prefix.length && words.length > prefix.length && prefix.every((w, i) => words[i] === w)) words = words.slice(prefix.length);
	const full = ['T2D', ...prefix, ...(words.length ? words : ['DATA'])].join('_');
	return full.length <= MAX_TABLE_NAME ? full : full.slice(0, MAX_TABLE_NAME).replace(/_+$/, '');
}

export const isIceDefaultTableName = (tableName, datasetId) => String(tableName).toLowerCase() === String(datasetId).toLowerCase().replace(/-/g, '_');

/** ice adds `_<n>` to a name another table already holds (SchemaService.getUniqueTableName). */
export const isWarehouseTableName = (tableName, wanted) => new RegExp(`^${wanted}(_\\d+)?$`, 'i').test(String(tableName));

/** @returns {Promise<WarehouseTable>} */
export async function getDatasetTable(c, integrationId, datasetId) {
	return c.get(`${BYOS}/${seg(integrationId)}/datasets/${seg(datasetId)}/mapping`);
}

/** ice renames the table in place (ExternalDeviceController.saveSchemaMapping). icebox 500s without `standardize`. @returns {Promise<WarehouseTable>} the name ice settled on */
export async function renameDatasetTable(c, integrationId, datasetId, { database, schemaName, tableName }) {
	return c.put(`${BYOS}/${seg(integrationId)}/datasets/${seg(datasetId)}/mapping`, { mapping: { database, schemaName, tableName }, standardize: true });
}
