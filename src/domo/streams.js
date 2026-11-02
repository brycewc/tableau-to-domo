import { poll } from '../util/http.js';

const STREAMS = '/data/v1/streams';

const OK_STATES = new Set(['SUCCESS', 'WARNING']);
const ERROR_STATES = new Set(['ERROR', 'INVALID']);

/**
 * Normalize connector configuration to the stream `configuration[]` shape the
 * connector wizard sends.
 * @param {Array<{ name: string, value: any, type?: string, category?: string }> | Record<string, any>} configuration
 */
export function toConfiguration(configuration = []) {
	const entries = Array.isArray(configuration)
		? configuration
		: Object.entries(configuration).map(([name, value]) => ({ name, value }));
	return entries
		.filter((entry) => entry.value !== undefined && entry.value !== null)
		.map((entry) => {
			const isObject = typeof entry.value === 'object';
			return {
				category: entry.category || 'METADATA',
				name: entry.name,
				type: entry.type || (isObject ? 'object' : 'string'),
				value: isObject ? JSON.stringify(entry.value) : String(entry.value)
			};
		});
}

// Values that describe one particular dataset (its source location, table, columns or SQL), never connector defaults.
const PER_DATASET_CONFIG = new Set([
	'query',
	'databaseName',
	'schemaName',
	'warehouseName',
	'catalogName',
	'reportType',
	'report',
	'updatemode.upsertKeys',
	'_name_',
	'queryParameter',
	'tableName',
	'columnNames',
	'generatedQuery',
	'viewName',
	'viewColumnNames',
	'viewGeneratedQuery',
	'datasetId',
	'tableId',
	'partitionQuery',
	'upsertKeyColumns',
	'tablePartitionColumnName',
	'_description_'
]);
const SENSITIVE_CONFIG = /pass|secret|token|private|credential/i;
// bypassDataUpload is a plain option, not a password.
const isSensitive = (name) => SENSITIVE_CONFIG.test(name.replace(/bypass/gi, ''));

/**
 * Find a CONNECTOR stream of `providerKey` on the instance to use as a template (transport and
 * configuration defaults). Streams with another transport (Cloud Amplifier is CLOUD) are skipped; among
 * the rest the one with the highest connector version wins.
 * @param {import('./client.js').DomoClient} c
 * @param {string} providerKey
 * @param {{ candidates?: number }} [opts]
 * @returns {Promise<Object|null>} the stream (fields=all) or null
 */
export async function findTemplateStream(c, providerKey, { candidates = 5 } = {}) {
	const search = await c.post('/data/ui/v3/datasources/search', {
		entities: ['DATASET'],
		query: '*',
		count: candidates,
		offset: 0,
		combineResults: true,
		filters: [{ filterType: 'term', field: 'dataProviderType', value: providerKey, not: false }]
	});
	let best = null;
	for (const hit of search?.dataSources ?? []) {
		if (!hit?.id) continue;
		const ds = await c.get(`/data/v3/datasources/${encodeURIComponent(hit.id)}`).catch(() => null);
		if (ds?.streamId === undefined || ds?.streamId === null) continue;
		const stream = await c.get(`${STREAMS}/${encodeURIComponent(ds.streamId)}`, { query: { fields: 'all' } }).catch(() => null);
		if (stream?.transport?.type !== 'CONNECTOR' || !stream.transport.description) continue;
		if (stream.dataProvider?.key && stream.dataProvider.key !== providerKey) continue;
		if (!best || Number.parseFloat(stream.transport.version) > Number.parseFloat(best.transport.version)) best = stream;
	}
	return best;
}

/**
 * METADATA configuration of a template stream that can seed a new stream: per-dataset values,
 * CONNECTOR_RESULT entries and anything that looks like a secret are dropped.
 * @param {Object} stream
 * @returns {{ category: string, name: string, type: string, value: string }[]}
 */
export function templateConfiguration(stream) {
	return (stream?.configuration ?? [])
		.filter((e) => e && e.category === 'METADATA' && e.name && !PER_DATASET_CONFIG.has(e.name) && !isSensitive(e.name))
		.map(({ category, name, type, value }) => ({ category, name, type: type || 'string', value: value ?? '' }));
}

/**
 * Create a connector-backed stream and its dataset.
 *
 * The CONNECTOR transport (connector id and major version, both required) is
 * resolved in this order: `templateStreamId`; explicit `connectorId`/`connectorVersion`; a stream of the
 * same provider found on the instance (also seeds configuration defaults the plan does not set); the plan's
 * `defaultTransport`; the provider's `defaultConnectorId`. A missing major version is read from the latest
 * connector descriptor `GET /data/v1/connectors/{id}`, falling back to the default version or '0'.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {{ name: string, description?: string, providerKey: string, accountId?: number|string,
 *   configuration?: Array<Object>|Record<string,any>, updateMethod?: 'REPLACE'|'APPEND'|'UPSERT',
 *   schedule?: string|Object, connectorId?: string, connectorVersion?: string|number,
 *   transportType?: string, templateStreamId?: number|string, useTemplate?: boolean,
 *   defaultTransport?: { providerKey: string, connectorId: string, connectorVersion?: string } }} spec
 * @returns {Promise<{ streamId: number, datasetId: string, stream: Object, transportSource: string }>}
 */
export async function createConnectorStream(c, spec) {
	const { name, description = '', providerKey, accountId, configuration, updateMethod = 'REPLACE', schedule } = spec;
	if (!name) throw new Error('createConnectorStream: name is required');
	if (!providerKey) throw new Error('createConnectorStream: providerKey is required');

	const { transport, template, source } = await resolveTransport(c, spec);
	const own = toConfiguration(configuration);
	const names = new Set(own.map((e) => e.name));
	const seeded = template ? templateConfiguration(template).filter((e) => !names.has(e.name)) : [];
	const body = {
		transport,
		configuration: [...seeded, ...own],
		account: accountId !== undefined && accountId !== null ? { id: Number(accountId) } : null,
		updateMethod,
		dataProvider: { key: providerKey },
		dataSource: { name, description }
	};
	if (schedule) body.advancedScheduleJson = typeof schedule === 'string' ? schedule : JSON.stringify(schedule);

	const res = await c.post(STREAMS, body);
	const streamId = res?.id;
	const datasetId = res?.dataSource?.id;
	if (streamId === undefined || !datasetId) throw new Error(`createConnectorStream: response had no id or dataSource.id: ${JSON.stringify(res).slice(0, 500)}`);
	return { streamId, datasetId, stream: res, transportSource: source };
}

/**
 * Replace the METADATA configuration (and the account) of an existing connector stream; entries the new
 * configuration does not name and other categories (CONNECTOR_RESULT) are kept.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} streamId
 * @param {{ configuration?: Array<Object>|Record<string,any>, accountId?: number|string }} update
 */
export async function updateConnectorStream(c, streamId, { configuration, accountId } = {}) {
	const path = `${STREAMS}/${encodeURIComponent(streamId)}`;
	const current = await c.get(path, { query: { fields: 'all' } });
	const own = toConfiguration(configuration);
	const names = new Set(own.map((e) => e.name));
	const kept = (current?.configuration ?? []).filter((e) => !(e.category === 'METADATA' && names.has(e.name)));
	const body = { ...current, configuration: [...kept, ...own] };
	if (accountId !== undefined && accountId !== null) body.account = { id: Number(accountId) };
	return c.put(path, body);
}

// Streams record 'major.minor' (e.g. '0.165') but the connector wizard creates streams with the major only.
const copyTransport = ({ type, description, version }) => ({ type, description, version: String(version ?? '0').split('.')[0] });

async function resolveTransport(c, spec) {
	const { providerKey, connectorId, connectorVersion, transportType = 'CONNECTOR', templateStreamId, useTemplate = true, defaultTransport } = spec;
	if (templateStreamId !== undefined && templateStreamId !== null) {
		const template = await c.get(`${STREAMS}/${encodeURIComponent(templateStreamId)}`, { query: { fields: 'all' } });
		if (!template?.transport?.type) throw new Error(`Stream ${templateStreamId} has no transport to copy`);
		return { transport: copyTransport(template.transport), template, source: `template stream ${templateStreamId}` };
	}
	if (transportType !== 'CONNECTOR') {
		return {
			transport: { type: transportType, ...(connectorId ? { description: connectorId } : {}), ...(connectorVersion !== undefined ? { version: String(connectorVersion) } : {}) },
			source: 'explicit'
		};
	}
	if (connectorId && hasValue(connectorVersion)) {
		return { transport: { type: 'CONNECTOR', description: connectorId, version: String(connectorVersion) }, source: 'explicit' };
	}
	if (!connectorId && useTemplate) {
		const template = await findTemplateStream(c, providerKey).catch(() => null);
		if (template) return { transport: copyTransport(template.transport), template, source: `stream ${template.id} of ${providerKey}` };
	}
	const defaults = defaultTransport?.providerKey === providerKey ? defaultTransport : undefined;
	let id = connectorId ?? defaults?.connectorId;
	let fallbackVersion = connectorId ? undefined : defaults?.connectorVersion;
	let source = connectorId ? 'explicit' : defaults ? 'defaults' : 'provider';
	if (!id) {
		const provider = await c.get(`/data/v1/providers/${encodeURIComponent(providerKey)}`);
		id = provider?.connectorId ?? provider?.defaultConnectorId;
		fallbackVersion = '0';
		if (!id) {
			throw new Error(
				`createConnectorStream: provider "${providerKey}" has no default connector and no stream of it exists on the instance; ` +
					'set connectorId and connectorVersion (or templateStreamId) on the mappings.json account'
			);
		}
	}
	let version = connectorVersion;
	if (!hasValue(version)) {
		const descriptor = await c.get(`/data/v1/connectors/${encodeURIComponent(id)}`).catch((err) => {
			if (!hasValue(fallbackVersion)) throw err;
			return null;
		});
		version = descriptor?.version?.major ?? descriptor?.majorVersion ?? fallbackVersion;
		if (!hasValue(version)) {
			throw new Error(
				`createConnectorStream: could not read the major version of connector "${id}" (${providerKey}); ` +
					'set connectorVersion or templateStreamId on the mappings.json account'
			);
		}
	}
	return { transport: { type: 'CONNECTOR', description: id, version: String(version) }, source };
}

function hasValue(value) {
	return value !== undefined && value !== null && value !== '';
}

/**
 * Start a stream execution (run the connector now).
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} streamId
 * @returns {Promise<Object>} execution incl. executionId (or id)
 */
export async function runStream(c, streamId) {
	return c.post(`${STREAMS}/${encodeURIComponent(streamId)}/executions`);
}

/**
 * Poll a stream execution until it is final. SUCCESS and WARNING resolve; ERROR and INVALID throw.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} streamId
 * @param {number|string} executionId
 * @param {{ intervalMs?: number, timeoutMs?: number, emitter?: import('../util/events.js').Emitter }} [opts]
 */
export async function waitForStreamExecution(c, streamId, executionId, { intervalMs = 5000, timeoutMs = 2 * 60 * 60 * 1000, emitter = c.emitter } = {}) {
	return poll(
		async () => {
			const exec = await c.get(`${STREAMS}/${encodeURIComponent(streamId)}/executions/${encodeURIComponent(executionId)}`);
			const state = String(exec?.currentState ?? 'UNKNOWN').toUpperCase();
			if (OK_STATES.has(state)) {
				if (state === 'WARNING') emitter?.warn(`Stream ${streamId} execution ${executionId} finished with warnings`);
				return exec;
			}
			if (ERROR_STATES.has(state)) {
				const detail = exec?.errors?.map?.((e) => e.message || e.localizedMessage || JSON.stringify(e)).join('; ');
				const err = new Error(`Stream ${streamId} execution ${executionId} ended in ${state}${detail ? `: ${detail}` : ''}`);
				err.execution = exec;
				throw err;
			}
			emitter?.progress(`Stream ${streamId}: ${state}`, { streamId, executionId, state, rows: exec?.rowsInserted });
			return undefined;
		},
		{ intervalMs, timeoutMs, label: `stream ${streamId} execution ${executionId}` }
	);
}

/** Execution id from a runStream response. */
export function executionIdOf(execution) {
	return execution?.executionId ?? execution?.id;
}
