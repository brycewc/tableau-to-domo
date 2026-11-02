import { relationParts } from '../../convert/connectors.js';
import { initialSqlOf } from '../../convert/initial-sql.js';
import { tableauToDomoType } from '../../convert/schema.js';
import { compareSnowflakeAccounts, dataProviderKeyFor, isTransientByosError, normalizeHost, withTransientRetry } from '../../domo/cloud-amplifier.js';
import { parseSqlTableRefs } from './sql-refs.js';

/**
 * Match Tableau connections to Domo Cloud Amplifier integrations (read-only Domo calls only).
 *
 * @typedef {import('../../domo/cloud-amplifier.js').Integration} Integration
 * @typedef {import('../../model/types.js').CloudAmplifierInfo} CloudAmplifierInfo
 *
 * @typedef {Object} Target
 * @property {string} [databaseName]
 * @property {string} [schemaName]
 * @property {string} tableName
 * @property {boolean} quoted         Names are exact (Tableau relation or quoted SQL identifier)
 *
 * @typedef {Object} Resolved
 * @property {string} databaseName
 * @property {string} schemaName
 * @property {string} tableName
 * @property {{ name: string, type: string }[]|null} columns
 * @property {string} [registeredDatasetId]
 *
 * @typedef {{ status: 'yes'|'no'|'unknown', resolved?: Resolved[], reason?: string }} Verification
 *
 * @typedef {{ id: string, name: string, account?: string, result: 'equal'|'differs'|'unknown', reason?: string }} AccountCheck
 * @typedef {{ integration: Integration, account?: AccountCheck, databases?: Record<string, string> }} ShareSuggestion
 */

const ENGINES_BY_CLASS = {
	snowflake: ['SNOWFLAKE'],
	bigquery: ['BIGQUERY'],
	'google-bigquery': ['BIGQUERY'],
	'bigquery-jdbc': ['BIGQUERY'],
	databricks: ['DATABRICKS'],
	spark: ['DATABRICKS'],
	redshift: ['REDSHIFT'],
	postgres: ['POSTGRES', 'POSTGRESQL', 'LAKEBASE'],
	postgresql: ['POSTGRES', 'POSTGRESQL', 'LAKEBASE'],
	mysql: ['MYSQL'],
	mariadb: ['MYSQL'],
	oracle: ['ORACLE'],
	sqlserver: ['SQLSERVER', 'AZURE_SQL', 'AZURESQL'],
	azure_sql_db: ['AZURE_SQL', 'AZURESQL', 'SQLSERVER'],
	'azure-sql-db': ['AZURE_SQL', 'AZURESQL', 'SQLSERVER'],
	athena: ['ATHENA'],
	'amazon-athena': ['ATHENA']
};

const UPPER_FOLD = new Set(['SNOWFLAKE', 'ORACLE']);
const LOWER_FOLD = new Set(['POSTGRES', 'POSTGRESQL', 'REDSHIFT', 'LAKEBASE']);
const BROWSE_CONCURRENCY = 4;
const SHARE_BROWSE_BUDGET = 40;
const GENERIC_NAME_TOKENS = new Set(['db', 'database', 'prod', 'dev', 'qa', 'test', 'stg', 'stage', 'uat', 'share', 'shared', 'data']);

/**
 * Cloud Amplifier engines that can serve a Tableau connection class, or undefined.
 * @param {string} connectionClass
 * @returns {string[]|undefined}
 */
export function cloudAmplifierEngines(connectionClass) {
	return ENGINES_BY_CLASS[String(connectionClass ?? '').toLowerCase()];
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Most specific `mappings.cloudAmplifier` entry whose every `match` key equals the connection's value
 * (case-insensitive; `server` compares as a host).
 * @param {import('../../model/types.js').ConnectionIR} connection
 * @param {Partial<import('../../model/types.js').Mappings>} [mappings]
 */
export function findCloudAmplifierMapping(connection, mappings) {
	let best;
	let bestScore = -1;
	for (const entry of mappings?.cloudAmplifier ?? []) {
		const match = entry?.match ?? {};
		const keys = Object.keys(match).filter((k) => match[k] !== undefined && match[k] !== null && match[k] !== '');
		const ok = keys.every((key) => {
			const actual = connection?.[key] ?? connection?.extra?.[key];
			if (key === 'server') return normalizeHost(actual) === normalizeHost(match[key]);
			return norm(actual) === norm(match[key]);
		});
		if (ok && keys.length > bestScore) {
			best = entry;
			bestScore = keys.length;
		}
	}
	return best;
}

/**
 * Apply a mapping's `databases` renames ({ tableauName: warehouseName }, case-insensitive) to the targets,
 * for warehouses where the Tableau database is shared into the Cloud Amplifier account under another name.
 * @param {Target[]} targets
 * @param {{ databases?: Record<string, string> }} [mapping]
 */
export function renameDatabases(targets, mapping) {
	const renames = new Map(Object.entries(mapping?.databases ?? {}).map(([from, to]) => [norm(from), to]));
	if (!renames.size) return targets;
	return targets.map((target) => {
		const to = renames.get(norm(target.databaseName));
		return to ? { ...target, databaseName: to } : target;
	});
}

/** mappings.json snippet that pins a connection to an integration. */
export function mappingSnippet(connection, integrationId = '<integration id>', databases) {
	const match = { class: connection.class };
	if (connection.server) match.server = connection.server;
	if (connection.dbname) match.dbname = connection.dbname;
	return JSON.stringify({ cloudAmplifier: [{ match, integrationId, ...(databases && Object.keys(databases).length ? { databases } : {}) }] });
}

function connectionOf(source, table) {
	const conns = source.connections ?? [];
	if (table.connectionId) return conns.find((c) => c.id === table.connectionId);
	const eligible = conns.filter((c) => cloudAmplifierEngines(c.class));
	return eligible.length === 1 ? eligible[0] : conns.length === 1 ? conns[0] : undefined;
}

function tableTarget(table) {
	const parts = relationParts(table.table || table.name);
	if (!parts.length || parts.length > 3) return null;
	const [tableName, schemaName, databaseName] = [...parts].reverse();
	return { databaseName, schemaName, tableName, quoted: true };
}

function sqlTarget(ref) {
	const names = ref.parts.map((p) => p.name);
	const [tableName, schemaName, databaseName] = [...names].reverse();
	return { databaseName, schemaName, tableName, quoted: ref.parts.at(-1).quoted };
}

/**
 * Which warehouse tables a datasource reads, grouped by connection. Returns `ineligible` with a reason when
 * a table cannot be served by Cloud Amplifier (files, extracts only, unsupported custom SQL, initial SQL).
 * @param {import('../../model/types.js').DatasourceIR} source   The datasource (a published datasource's .tds for sqlproxy)
 */
export function planTargets(source) {
	const tables = source.tables ?? [];
	if (!tables.length) return { ineligible: 'the datasource has no tables' };
	const byConnection = new Map();
	const relations = [];
	for (const table of tables) {
		const connection = connectionOf(source, table);
		if (!connection || !cloudAmplifierEngines(connection.class)) {
			return { ineligible: `table '${table.name || table.id}' reads from ${connection?.class ?? 'an unknown connection'}, which Cloud Amplifier cannot reach` };
		}
		const sqlInit = initialSqlOf(connection);
		if (sqlInit) return { ineligible: `the ${connection.class} connection runs Initial SQL, which a Cloud Amplifier dataset cannot reproduce`, connection, initialSql: true };
		if (!byConnection.has(connection.id)) byConnection.set(connection.id, { connection, targets: [] });
		const group = byConnection.get(connection.id);
		const addTarget = (raw) => {
			const target = {
				...raw,
				databaseName: raw.databaseName ?? (connection.dbname || connection.extra?.project || connection.extra?.['bq-project'] || undefined),
				schemaName: raw.schemaName ?? (connection.schema || undefined)
			};
			const key = [target.databaseName, target.schemaName, target.tableName].map(norm).join('.');
			let index = group.targets.findIndex((t) => t.key === key);
			if (index === -1) index = group.targets.push({ ...target, key }) - 1;
			return index;
		};
		if (table.kind === 'custom-sql') {
			const parsed = parseSqlTableRefs(table.sql ?? '');
			if (parsed.unsupported) return { ineligible: `the custom SQL of '${table.name || table.id}' cannot become a DataSet View: ${parsed.unsupported}`, customSql: true };
			relations.push({
				table,
				connectionId: connection.id,
				kind: 'custom-sql',
				refs: parsed.refs.map((ref) => ({ start: ref.start, end: ref.end, target: addTarget(sqlTarget(ref)) }))
			});
		} else if (table.kind === 'table') {
			const target = tableTarget(table);
			if (!target) return { ineligible: `table '${table.name || table.id}' has no usable [database].[schema].[table] name` };
			relations.push({ table, connectionId: connection.id, kind: 'table', target: addTarget(target) });
		} else {
			return { ineligible: `table '${table.name || table.id}' is a ${table.kind} table, which Cloud Amplifier cannot reach` };
		}
	}
	return { byConnection, relations };
}

function pickName(names, wanted, { engine, quoted }) {
	if (!wanted) return undefined;
	const exact = names.find((n) => n === wanted);
	if (exact) return exact;
	if (!quoted && UPPER_FOLD.has(engine)) {
		const folded = names.find((n) => n === wanted.toUpperCase());
		if (folded) return folded;
	}
	if (!quoted && LOWER_FOLD.has(engine)) {
		const folded = names.find((n) => n === wanted.toLowerCase());
		if (folded) return folded;
	}
	if (quoted) return undefined;
	const ci = names.filter((n) => n.toLowerCase() === wanted.toLowerCase());
	return ci.length === 1 ? ci[0] : undefined;
}

function foldName(name, { engine, quoted }) {
	if (!name || quoted) return name;
	if (UPPER_FOLD.has(engine)) return name.toUpperCase();
	if (LOWER_FOLD.has(engine)) return name.toLowerCase();
	return name;
}

/**
 * Cached read-only browsing of integrations. Every method resolves to `{ ok: true, value }` or
 * `{ ok: false, transient, error }`; transient warehouse errors are retried first.
 * @param {import('../../domo/client.js').DomoClient} c
 * @param {typeof import('../../domo/cloud-amplifier.js')} api
 * @param {{ retry?: Parameters<typeof withTransientRetry>[1], getDataset?: (c: any, id: string) => Promise<any> }} [opts]
 */
export function createBrowser(c, api, { retry, getDataset } = {}) {
	const cache = new Map();
	const cached = (key, fn) => {
		if (!cache.has(key)) {
			cache.set(
				key,
				withTransientRetry(fn, retry).then(
					(value) => ({ ok: true, value }),
					(error) => ({ ok: false, transient: isTransientByosError(error), error })
				)
			);
		}
		return cache.get(key);
	};
	return {
		databases: (id) => cached(`d|${id}`, () => api.listDatabases(c, id)),
		schemas: (id, db) => cached(`s|${id}|${db}`, () => api.listSchemas(c, id, db)),
		objects: (id, db, schema) => cached(`o|${id}|${db}|${schema}`, () => api.listObjects(c, id, db, schema)),
		columns: (id, db, schema, object) => cached(`c|${id}|${db}|${schema}|${object}`, () => api.getObjectColumns(c, id, db, schema, object)),
		account: (integration) => {
			if (integration?.engine !== 'SNOWFLAKE' || !api.getSnowflakeAccount) return Promise.resolve(undefined);
			const key = `a|${integration.serviceAccountId ?? integration.id}`;
			if (!cache.has(key)) cache.set(key, api.getSnowflakeAccount(c, integration.serviceAccountId).catch(() => ({ reason: 'the account lookup failed' })));
			return cache.get(key);
		},
		providerType: (datasetId) =>
			getDataset ? cached(`p|${datasetId}`, async () => (await getDataset(c, datasetId))?.dataProviderType) : Promise.resolve({ ok: false, transient: false })
	};
}

function failure(result, what) {
	const raw = result.error?.body ? `${result.error.status ?? ''} ${result.error.body}` : result.error?.message ?? result.error ?? 'failed';
	const detail = String(raw).replace(/\s+/g, ' ').slice(0, 160);
	return result.transient ? { status: 'unknown', reason: `${what}: ${detail}` } : { status: 'no', reason: `${what} failed: ${detail}` };
}

/**
 * Check that an integration can see every target table, resolving canonical names and columns.
 * @param {Integration} integration
 * @param {Target[]} targets
 * @param {ReturnType<typeof createBrowser>} browser
 * @returns {Promise<Verification>}
 */
export async function verifyTargets(integration, targets, browser) {
	const resolved = [];
	let unknown;
	const opts = (target, fromTarget) => ({ engine: integration.engine, quoted: Boolean(target.quoted && fromTarget) });
	for (const target of targets) {
		const db = target.databaseName ?? integration.database;
		const schemaWanted = target.schemaName ?? integration.defaultSchema;
		const label = [db, schemaWanted, target.tableName].filter(Boolean).join('.');
		if (!db || !schemaWanted) return { status: 'no', reason: `${label} does not name its database and schema` };
		const dbs = await browser.databases(integration.id);
		if (!dbs.ok) {
			const f = failure(dbs, 'listing databases');
			if (f.status === 'no') return f;
			unknown ??= f;
			continue;
		}
		const databaseName = pickName(dbs.value, db, opts(target, target.databaseName));
		if (!databaseName) return { status: 'no', reason: `database ${db} is not visible (${dbs.value.length} database(s) listed)` };
		const schemas = await browser.schemas(integration.id, databaseName);
		if (!schemas.ok) {
			const f = failure(schemas, `listing schemas of ${databaseName}`);
			if (f.status === 'no') return f;
			unknown ??= f;
			continue;
		}
		const schemaName = pickName(schemas.value, schemaWanted, opts(target, target.schemaName));
		if (!schemaName) return { status: 'no', reason: `schema ${databaseName}.${schemaWanted} is not visible` };
		const objects = await browser.objects(integration.id, databaseName, schemaName);
		if (!objects.ok) {
			const f = failure(objects, `listing tables of ${databaseName}.${schemaName}`);
			if (f.status === 'no') return f;
			unknown ??= f;
			continue;
		}
		const tableName = pickName(
			objects.value.map((o) => o.tableName),
			target.tableName,
			opts(target, target.tableName)
		);
		if (!tableName) return { status: 'no', reason: `table ${databaseName}.${schemaName}.${target.tableName} is not visible` };
		const object = objects.value.find((o) => o.tableName === tableName);
		const columns = await browser.columns(integration.id, databaseName, schemaName, tableName);
		resolved.push({
			databaseName,
			schemaName,
			tableName,
			columns: columns.ok && columns.value.length ? columns.value.map((col) => ({ name: col.name, type: col.type })) : null,
			...(object?.datasource ? { registeredDatasetId: String(object.datasource) } : {})
		});
	}
	if (unknown) return unknown;
	return { status: 'yes', resolved };
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** @returns {Promise<Map<string, AccountCheck>>} */
async function checkAccounts(connection, candidates, browser) {
	const out = new Map();
	if (!browser?.account || !connection.server) return out;
	await mapLimit(candidates, BROWSE_CONCURRENCY, async (integration) => {
		const resolved = await browser.account(integration);
		if (!resolved) return;
		const result = resolved.account ? compareSnowflakeAccounts(resolved.account, connection.server) : 'unknown';
		out.set(integration.id, { id: integration.id, name: integration.name, ...(resolved.account ? { account: resolved.account } : {}), result, ...(resolved.reason ? { reason: resolved.reason } : {}) });
	});
	return out;
}

const nameTokens = (name) => norm(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t));

/**
 * Databases of the integration that hold the targets' schema and tables under another name (a secure share
 * usually renames the database). Only databases sharing a name token with the Tableau one are browsed.
 * @returns {Promise<Record<string, string>|null>}
 */
async function findRenamedDatabases(integration, targets, browser, budget) {
	const dbs = await browser.databases(integration.id);
	if (!dbs.ok) return null;
	const renames = {};
	for (const wanted of new Set(targets.map((t) => t.databaseName).filter(Boolean))) {
		if (pickName(dbs.value, wanted, { engine: integration.engine, quoted: false })) continue;
		const want = nameTokens(wanted);
		const ranked = dbs.value
			.map((name) => ({ name, score: nameTokens(name).filter((t) => want.includes(t)).length }))
			.filter((d) => d.score > 0)
			.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
		const subset = targets.filter((t) => norm(t.databaseName) === norm(wanted));
		for (const { name } of ranked) {
			if (budget.left-- <= 0) return null;
			const verification = await verifyTargets(integration, subset.map((t) => ({ ...t, databaseName: name })), browser);
			if (verification.status === 'yes') {
				renames[wanted] = name;
				break;
			}
		}
		if (!renames[wanted]) return null;
	}
	if (!Object.keys(renames).length) return null;
	return (await verifyTargets(integration, renameDatabases(targets, { databases: renames }), browser)).status === 'yes' ? renames : null;
}

/**
 * Non-candidates that read the same schema and tables (a secure share into another account). Never applied.
 * @returns {Promise<ShareSuggestion[]>}
 */
async function suggestShares(integrations, targets, browser, accounts) {
	const budget = { left: SHARE_BROWSE_BUDGET };
	const out = [];
	for (const integration of integrations) {
		if (budget.left <= 0) break;
		const account = accounts.get(integration.id);
		const verification = await verifyTargets(integration, targets, browser);
		if (verification.status === 'yes') {
			if (account?.result === 'differs') out.push({ integration, account });
			continue;
		}
		if (verification.status !== 'no' || !/^database .* is not visible/.test(verification.reason ?? '')) continue;
		const databases = await findRenamedDatabases(integration, targets, browser, budget);
		if (databases) out.push({ integration, ...(account ? { account } : {}), databases });
	}
	return out;
}

/**
 * Pick the integration for one connection: explicit mapping, then engine, host or Snowflake account, and a
 * browse of the warehouse. Several candidates is ambiguous (none picked). Transient browse errors give
 * 'unknown', never 'none'. A browse-only match is 'unconfirmed' (not used) when the connection names a server
 * the integration cannot be tied to. Another Snowflake account is never a candidate, only a suggestion.
 *
 * @param {import('../../model/types.js').ConnectionIR} connection
 * @param {Target[]} targets
 * @param {{ integrations: Integration[]|null, mappings?: any, browser?: ReturnType<typeof createBrowser>|null }} ctx
 * @returns {Promise<{ status: 'match'|'none'|'ambiguous'|'unconfirmed'|'unknown'|'disabled'|'unavailable', integration?: Integration, matchedBy?: string, verification?: Verification, candidates?: Integration[], reason?: string, accounts?: AccountCheck[], suggestions?: ShareSuggestion[] }>}
 */
export async function matchConnection(connection, targets, { integrations, mappings, browser }) {
	const engines = cloudAmplifierEngines(connection.class) ?? [];
	const mapped = findCloudAmplifierMapping(connection, mappings);
	if (mapped && (mapped.integrationId === false || mapped.integrationId === null)) return { status: 'disabled', reason: 'disabled for this connection in mappings.json' };
	if (mapped?.integrationId) {
		const id = String(mapped.integrationId);
		const integration = integrations?.find((i) => i.id === id) ?? { id, engine: engines[0] ?? '', name: id, writeable: false, initialized: false };
		const accounts = [...(await checkAccounts(connection, [integration], browser)).values()];
		const verification = browser ? await verifyTargets(integration, targets, browser) : { status: 'unknown', reason: 'no Domo lookup' };
		if (verification.status === 'no') return { status: 'none', integration, accounts, reason: `mapped integration "${integration.name}" cannot read the tables: ${verification.reason}` };
		return { status: 'match', integration, matchedBy: 'mapping', verification, accounts };
	}
	if (!integrations) return { status: 'unavailable', reason: 'the Domo integration list is not available' };
	const candidates = integrations.filter((i) => engines.includes(i.engine));
	if (!candidates.length) return { status: 'none', reason: `the instance has no ${engines.join(' or ')} Cloud Amplifier integration` };
	const checks = await checkAccounts(connection, candidates, browser);
	const accounts = candidates.filter((i) => checks.has(i.id)).map((i) => checks.get(i.id));
	const result = await pickCandidate(connection, targets, candidates, checks, browser);
	if (result.status === 'none' && browser) {
		const searched = candidates.filter((i) => checks.get(i.id)?.result === 'differs' || result.browsed?.includes(i.id));
		const suggestions = await suggestShares(searched, targets, browser, checks);
		if (suggestions.length) result.suggestions = suggestions;
	}
	delete result.browsed;
	return { ...result, accounts };
}

async function pickCandidate(connection, targets, candidates, checks, browser) {
	const engines = cloudAmplifierEngines(connection.class) ?? [];
	const host = normalizeHost(connection.server).replace('.privatelink.', '.');
	const sameHost = (i) => i.host && host && i.host.replace('.privatelink.', '.') === host;
	const accountResult = (i) => checks.get(i.id)?.result;
	const by = (i) => (sameHost(i) ? 'host' : accountResult(i) === 'equal' ? 'account' : 'browse');
	const differs = candidates.filter((i) => accountResult(i) === 'differs');
	const live = candidates.filter((i) => accountResult(i) !== 'differs');
	const trusted = live.filter((i) => sameHost(i) || accountResult(i) === 'equal');
	const pool = trusted.length ? trusted : live.filter((i) => !i.host || !host);
	if (!pool.length) {
		const other = [
			...live.map((i) => `${i.name}: ${i.host}`),
			...differs.map((i) => `${i.name}: account ${checks.get(i.id).account}`)
		];
		return { status: 'none', reason: `no ${engines.join('/')} integration points at ${connection.server} (${other.join(', ')})` };
	}
	if (!browser) {
		if (trusted.length === 1 && sameHost(trusted[0])) return { status: 'match', integration: trusted[0], matchedBy: 'host', verification: { status: 'unknown', reason: 'no browse client' } };
		return { status: 'unknown', candidates: pool, reason: 'the integrations cannot be browsed' };
	}
	const results = await mapLimit(pool, BROWSE_CONCURRENCY, async (integration) => ({ integration, verification: await verifyTargets(integration, targets, browser) }));
	const yes = results.filter((r) => r.verification.status === 'yes');
	const unknown = results.filter((r) => r.verification.status === 'unknown');
	if (yes.length === 1 && by(yes[0].integration) === 'browse' && host) {
		return {
			status: 'unconfirmed',
			integration: yes[0].integration,
			candidates: [yes[0].integration],
			reason: `integration "${yes[0].integration.name}" lists the same database, schema and table names, but neither its server nor its Snowflake account can be tied to ${connection.server}`
		};
	}
	if (yes.length === 1) return { status: 'match', integration: yes[0].integration, matchedBy: by(yes[0].integration), verification: yes[0].verification };
	if (yes.length > 1) return { status: 'ambiguous', candidates: yes.map((r) => r.integration), reason: `${yes.length} integrations can read the tables` };
	if (trusted.length === 1 && sameHost(trusted[0]) && unknown.length === 1) return { status: 'match', integration: trusted[0], matchedBy: 'host', verification: unknown[0].verification };
	if (unknown.length) {
		return {
			status: 'unknown',
			candidates: unknown.map((r) => r.integration),
			reason: unknown.map((r) => `${r.integration.name}: ${r.verification.reason}`).join('; ')
		};
	}
	return {
		status: 'none',
		browsed: results.map((r) => r.integration.id),
		reason: results
			.slice(0, 6)
			.map((r) => `${r.integration.name}: ${r.verification.reason}`)
			.join('; ') + (results.length > 6 ? `; and ${results.length - 6} more` : '')
	};
}

async function discoverProviderKey(integration, resolved, browser) {
	const registered = (resolved ?? []).find((r) => r.registeredDatasetId);
	if (!registered || !browser) return undefined;
	const result = await browser.providerType(registered.registeredDatasetId);
	return result.ok && result.value ? String(result.value) : undefined;
}

/**
 * Decide whether a datasource can be served by Cloud Amplifier and describe the registrations.
 *
 * @param {{
 *   source: import('../../model/types.js').DatasourceIR,
 *   integrations: Integration[]|null,
 *   mappings?: any,
 *   browser?: ReturnType<typeof createBrowser>|null
 * }} opts
 * @returns {Promise<{ status: 'match'|'ineligible'|'none'|'ambiguous'|'unconfirmed'|'unknown'|'disabled'|'unavailable', info?: CloudAmplifierInfo, reason?: string, connection?: any, candidates?: Integration[], initialSql?: boolean, customSql?: boolean }>}
 */
export async function matchCloudAmplifier({ source, integrations, mappings, browser }) {
	const planned = planTargets(source);
	if (planned.ineligible) return { status: 'ineligible', reason: planned.ineligible, initialSql: planned.initialSql, customSql: planned.customSql };

	const groups = [];
	for (const group of planned.byConnection.values()) {
		group.targets = renameDatabases(group.targets, findCloudAmplifierMapping(group.connection, mappings));
		const result = await matchConnection(group.connection, group.targets, { integrations, mappings, browser });
		if (result.status !== 'match') return { ...result, connection: group.connection };
		groups.push({ ...group, result });
	}

	const tables = [];
	const tableIndex = new Map();
	const matchedBy = new Set();
	for (const group of groups) {
		const { integration, verification } = group.result;
		matchedBy.add(group.result.matchedBy);
		const mapped = findCloudAmplifierMapping(group.connection, mappings);
		const verified = verification?.status === 'yes';
		const providerKey =
			mapped?.dataProviderKey ?? (verified ? await discoverProviderKey(integration, verification.resolved, browser) : undefined) ?? dataProviderKeyFor(integration);
		if (!providerKey) return { status: 'none', reason: `no dataProviderKey is known for ${integration.engine} integrations`, connection: group.connection };
		group.indexes = group.targets.map((target, i) => {
			const r = verified ? verification.resolved[i] : null;
			const fold = { engine: integration.engine, quoted: target.quoted };
			const entry = {
				integrationId: integration.id,
				integrationName: integration.name,
				engine: integration.engine,
				dataProviderKey: providerKey,
				databaseName: r?.databaseName ?? foldName(target.databaseName ?? integration.database, fold),
				schemaName: r?.schemaName ?? foldName(target.schemaName ?? integration.defaultSchema, fold),
				tableName: r?.tableName ?? foldName(target.tableName, fold),
				columns: r?.columns ?? null,
				verified: Boolean(r),
				...(r?.registeredDatasetId ? { registeredDatasetId: r.registeredDatasetId } : {})
			};
			const key = [entry.integrationId, entry.databaseName, entry.schemaName, entry.tableName].join('|');
			if (!tableIndex.has(key)) tableIndex.set(key, tables.push(entry) - 1);
			return tableIndex.get(key);
		});
	}
	const byConn = new Map(groups.map((g) => [g.connection.id, g]));
	const relations = planned.relations.map((rel) => {
		const group = byConn.get(rel.connectionId);
		const base = { tableId: rel.table.id, name: rel.table.name || rel.table.id };
		if (rel.kind === 'table') {
			const index = group.indexes[rel.target];
			if (!tables[index].columns && rel.table.columns?.length) {
				tables[index].columns = rel.table.columns.map((col) => ({ name: col.remoteName, type: tableauToDomoType(col.localType) }));
			}
			return { ...base, kind: 'table', table: index };
		}
		return {
			...base,
			kind: 'custom-sql',
			sql: rel.table.sql,
			refs: rel.refs.map((ref) => ({ start: ref.start, end: ref.end, table: group.indexes[ref.target] })),
			columns: (rel.table.columns ?? []).map((col) => ({ name: col.remoteName, type: tableauToDomoType(col.localType) }))
		};
	});
	for (const table of tables) table.columns ??= [];
	const integrationList = [
		...new Map(
			groups.map((g) => {
				const { id, name, engine } = g.result.integration;
				const check = g.result.accounts?.find((x) => x.id === id);
				return [id, { id, name, engine, ...(check?.account ? { account: check.account } : {}), ...(check ? { accountMatch: check.result } : {}) }];
			})
		).values()
	];
	return {
		status: 'match',
		info: { integrations: integrationList, matchedBy: [...matchedBy].join(','), tables, relations }
	};
}
