import fs from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { poll } from '../util/http.js';
import { isStatus } from './client.js';

const gzip = promisify(zlib.gzip);

const QUOTE = 0x22;
const NEWLINE = 0x0a;
const COMMA = 0x2c;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const DEFAULT_PART_ROWS = 100000;
export const DEFAULT_PART_BYTES = 50 * 1024 * 1024;
const COMMIT_MESSAGE = 'tableau-to-domo';

/**
 * @typedef {{ name: string, type: import('../model/types.js').DomoColumnType }} SchemaColumn
 */

function toColumns(schema) {
	const columns = Array.isArray(schema) ? schema : schema?.columns;
	if (!Array.isArray(columns)) throw new Error('schema must be an array of { name, type } or { columns }');
	return columns.map((column) => {
		const out = { type: column.type, name: column.name };
		for (const key of ['id', 'description', 'visible', 'precision', 'scale']) {
			if (column[key] !== undefined) out[key] = column[key];
		}
		return out;
	});
}

/**
 * Create an empty API dataset with a schema. Falls back to `POST /data/v1/streams`
 * (API transport) when the v2 datasources endpoint is not reachable with a developer token.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {{ name: string, description?: string, schema: SchemaColumn[] | { columns: SchemaColumn[] } }} spec
 * @returns {Promise<string>} dataset id
 */
export async function createDataset(c, { name, description = '', schema }) {
	if (!name) throw new Error('createDataset: name is required');
	const columns = toColumns(schema || []);
	try {
		const res = await c.post('/data/v2/datasources', {
			dataSourceName: name,
			dataSourceDescription: description,
			dataSourceType: 'API',
			dataProviderType: 'api',
			schema: { columns }
		});
		const id = res?.dataSource?.dataSourceId;
		if (!id) throw new Error(`createDataset: response did not include dataSource.dataSourceId: ${JSON.stringify(res).slice(0, 500)}`);
		return id;
	} catch (err) {
		if (!isStatus(err, 401, 403, 404, 405)) throw err;
		c.emitter.warn(`POST /data/v2/datasources returned HTTP ${err.status}; creating "${name}" through /data/v1/streams instead`);
		const res = await c.post('/data/v1/streams', {
			dataProvider: { key: 'domo' },
			transport: { type: 'API' },
			dataSource: { name, description },
			updateMethod: 'REPLACE',
			schemaDefinition: { columns }
		});
		const id = res?.dataSource?.id;
		if (!id) throw new Error(`createDataset: stream response did not include dataSource.id: ${JSON.stringify(res).slice(0, 500)}`, { cause: err });
		return id;
	}
}

/**
 * Replace a dataset's schema.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {SchemaColumn[] | { columns: SchemaColumn[] }} schema
 */
export async function updateSchema(c, id, schema) {
	return c.post(`/data/v2/datasources/${encodeURIComponent(id)}/schemas`, { columns: toColumns(schema) });
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 */
export async function getDataset(c, id) {
	return c.get(`/data/v3/datasources/${encodeURIComponent(id)}`);
}

/**
 * Indexed (queryable) schema. Columns are under `tables[].columns`.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {{ includeHidden?: boolean }} [opts]
 */
export async function getIndexedSchema(c, id, { includeHidden } = {}) {
	return c.get(`/query/v1/datasources/${encodeURIComponent(id)}/schema/indexed`, {
		query: includeHidden === undefined ? undefined : { includeHidden }
	});
}

/** Flat column list from an indexed schema response. */
export function indexedColumns(schema) {
	if (!schema) return [];
	if (Array.isArray(schema.columns)) return schema.columns;
	return (schema.tables || []).flatMap((table) => table.columns || []);
}

const notReadyYet = (err) => {
	if (typeof err?.status === 'number' && err.status < 500 && ![404, 408, 409].includes(err.status)) throw err;
	return null;
};

/**
 * Poll until the indexed schema has columns (all of `columns` when given) and the dataset has a data version.
 * A new SQL view gets its data version about two minutes after creation; a dataflow run before then is REJECTED (DP-61100).
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {{ columns?: string[], intervalMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ name: string, type: string }[]>}
 */
export async function waitForReadable(c, id, { columns: expected = [], intervalMs = 3000, timeoutMs = 10 * 60 * 1000 } = {}) {
	return poll(
		async () => {
			const columns = indexedColumns(await getIndexedSchema(c, id).catch(notReadyYet));
			if (!columns.length) return undefined;
			const names = new Set(columns.map((col) => col.name));
			if (!expected.every((name) => names.has(name))) return undefined;
			const meta = await getDataset(c, id).catch(notReadyYet);
			return meta?.lastUpdated ? columns : undefined;
		},
		{ intervalMs, timeoutMs, label: `dataset ${id} to be readable` }
	);
}

/**
 * Split a CSV file into parts on record boundaries. Quoted fields may contain
 * newlines; a newline only ends a record outside quotes. Byte-level scanning is
 * UTF-8 safe because `"` and `\n` never occur inside multibyte sequences.
 *
 * @param {string} file
 * @param {{ partRows?: number, partBytes?: number, header?: 'first'|'all'|'none' }} [opts]
 *   `header`: where the header row goes ('first' = part 1 only).
 * @returns {AsyncGenerator<{ partNumber: number, data: Buffer, rows: number }>}
 */
export async function* splitCsvParts(file, { partRows = DEFAULT_PART_ROWS, partBytes = DEFAULT_PART_BYTES, header = 'first' } = {}) {
	if (!['first', 'all', 'none'].includes(header)) throw new Error(`Unknown header mode "${header}"`);
	let headerRow = null;
	let multiColumn = true;
	let pending = [];
	let pendingLength = 0;
	let inQuotes = false;
	let atStart = true;
	let part = [];
	let partLength = 0;
	let partRowCount = 0;
	let partNumber = 0;

	const buildPart = () => {
		const chunks = [];
		if (headerRow && (header === 'all' || (header === 'first' && partNumber === 0))) chunks.push(headerRow);
		chunks.push(...part);
		partNumber++;
		const out = { partNumber, data: Buffer.concat(chunks), rows: partRowCount };
		part = [];
		partLength = 0;
		partRowCount = 0;
		return out;
	};

	const finishRecord = (record) => {
		if (headerRow === null) {
			headerRow = record;
			multiColumn = hasUnquotedComma(record);
			return null;
		}
		// In a one-column CSV an empty line is a NULL value, not a blank record.
		if (multiColumn && isBlankRecord(record)) return null;
		part.push(record);
		partLength += record.length;
		partRowCount++;
		if (partRowCount >= partRows || partLength >= partBytes) return buildPart();
		return null;
	};

	const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
	for await (let chunk of stream) {
		if (atStart) {
			atStart = false;
			if (chunk.subarray(0, 3).equals(UTF8_BOM)) chunk = chunk.subarray(3);
		}
		let start = 0;
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i];
			if (byte === QUOTE) inQuotes = !inQuotes;
			else if (byte === NEWLINE && !inQuotes) {
				pending.push(chunk.subarray(start, i + 1));
				const record = Buffer.concat(pending, pendingLength + (i + 1 - start));
				pending = [];
				pendingLength = 0;
				start = i + 1;
				const ready = finishRecord(record);
				if (ready) yield ready;
			}
		}
		if (start < chunk.length) {
			pending.push(chunk.subarray(start));
			pendingLength += chunk.length - start;
		}
	}
	if (pendingLength > 0) {
		pending.push(Buffer.from('\n'));
		const ready = finishRecord(Buffer.concat(pending));
		if (ready) yield ready;
	}
	if (inQuotes) throw new Error(`${file}: unterminated quoted field at end of file`);
	if (partRowCount > 0 || partNumber === 0) yield buildPart();
}

function hasUnquotedComma(record) {
	let quoted = false;
	for (const byte of record) {
		if (byte === QUOTE) quoted = !quoted;
		else if (byte === COMMA && !quoted) return true;
	}
	return false;
}

function isBlankRecord(record) {
	for (const byte of record) if (byte !== 0x0a && byte !== 0x0d) return false;
	return true;
}

/**
 * Multipart upload of a local CSV (header row = Domo column names), then commit
 * with indexing and wait for the index to finish.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {string} file
 * @param {{ action?: 'REPLACE'|'APPEND', partRows?: number, partBytes?: number, gzip?: boolean,
 *   header?: 'first'|'all'|'none', index?: boolean, emitter?: import('../util/events.js').Emitter,
 *   pollIntervalMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ rowCount: number, uploadId: number, parts: number, requestKey?: string }>}
 */
export async function uploadCsv(c, id, file, opts = {}) {
	const {
		action = 'REPLACE',
		partRows = DEFAULT_PART_ROWS,
		partBytes = DEFAULT_PART_BYTES,
		gzip: useGzip = true,
		header = 'all',
		index = true,
		emitter = c.emitter,
		pollIntervalMs = 2000,
		timeoutMs = 30 * 60 * 1000
	} = opts;
	const appendId = action === 'APPEND' ? 'latest' : 'none';
	const base = `/data/v3/datasources/${encodeURIComponent(id)}/uploads`;

	const started = await c.post(base, { action, appendId });
	const uploadId = started?.uploadId;
	if (uploadId === undefined || uploadId === null) throw new Error(`Upload start for ${id} returned no uploadId`);

	let parts = 0;
	let localRows = 0;
	let commit;
	try {
		for await (const part of splitCsvParts(file, { partRows, partBytes, header })) {
			const body = useGzip ? await gzip(part.data) : part.data;
			await c.request('PUT', `${base}/${uploadId}/parts/${part.partNumber}`, {
				body,
				headers: { 'Content-Type': 'text/csv', ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}) }
			});
			parts = part.partNumber;
			localRows += part.rows;
			emitter?.progress(`Uploaded part ${part.partNumber} (${localRows} rows)`, { datasetId: id, part: part.partNumber, rows: localRows });
		}
		commit = await c.put(`${base}/${uploadId}/commit`, { action, index, appendId, message: COMMIT_MESSAGE });
	} catch (err) {
		try {
			await c.put(`${base}/${uploadId}/abort`, { message: `${COMMIT_MESSAGE}: aborted after error` });
		} catch (abortErr) {
			emitter?.warn(`Could not abort upload ${uploadId} on ${id}: ${abortErr.message}`);
		}
		throw err;
	}

	const committedRows = commit?.size?.rowCount;
	if (header !== 'none' && Number.isFinite(committedRows) && committedRows !== localRows) {
		emitter?.warn(`Domo committed ${committedRows} rows to ${id} but the CSV has ${localRows}`, { datasetId: id, committedRows, localRows });
	}
	const requestKey = commit?.indexing?.requestKey;
	if (!index || !requestKey) {
		if (index) emitter?.warn(`Commit for ${id} returned no indexing.requestKey; not waiting for the index`);
		return { rowCount: committedRows ?? localRows, uploadId, parts };
	}
	const detail = await waitForIndex(c, id, requestKey, { intervalMs: pollIntervalMs, timeoutMs, emitter });
	return { rowCount: detail?.rowCount ?? committedRows ?? localRows, uploadId, parts, requestKey };
}

/**
 * Poll an index request until SUCCESS. Throws on ERROR/FAILED.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {string} requestKey
 * @param {{ intervalMs?: number, timeoutMs?: number, notReadyMs?: number, emitter?: import('../util/events.js').Emitter }} [opts]
 * @returns {Promise<{ rowCount?: number, columnCount?: number }>}
 */
export async function waitForIndex(c, id, requestKey, { intervalMs = 2000, timeoutMs = 30 * 60 * 1000, notReadyMs = 60000, emitter } = {}) {
	const path = `/data/v3/datasources/${encodeURIComponent(id)}/indexes/${encodeURIComponent(requestKey)}/statuses`;
	const started = Date.now();
	return poll(
		async () => {
			let res;
			try {
				res = await c.get(path);
			} catch (err) {
				// Right after a commit the status can answer 400 "Failed to retrieve index status" until the request is registered.
				if (isStatus(err, 400, 404) && Date.now() - started < notReadyMs) return undefined;
				throw err;
			}
			const status = String(res?.progress?.status ?? res?.status ?? '').toUpperCase();
			if (status === 'SUCCESS') return res?.detail ?? {};
			if (status === 'ERROR' || status === 'FAILED') {
				throw new Error(`Indexing ${id} failed (${status}): ${res?.progress?.message || 'no message'}`);
			}
			emitter?.progress(`Indexing ${id}: ${status || 'PENDING'}`, { datasetId: id, status, progress: res?.progress?.progress });
			return undefined;
		},
		{ intervalMs, timeoutMs, label: `index of dataset ${id}` }
	);
}

/**
 * Delete a dataset (also its stream; works for uploaded, connector, Cloud Amplifier and view datasets).
 * Mutating.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 */
export async function deleteDataset(c, id) {
	return c.del(`/data/v3/datasources/${encodeURIComponent(id)}`);
}

/**
 * DataFlows that read a dataset and datasets (views) built directly on it.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @returns {Promise<{ dataflows: string[], datasets: string[] }>}
 */
export async function listDownstream(c, id) {
	const res = await c.get(`/data/v1/lineage/DATA_SOURCE/${encodeURIComponent(id)}`, {
		query: { traverseUp: false, traverseDown: true, requestEntities: 'DATAFLOW,DATA_SOURCE', maxDepth: 1 }
	});
	const nodes = res && typeof res === 'object' ? Object.values(res) : [];
	const root = nodes.find((n) => n?.type === 'DATA_SOURCE' && String(n.id) === String(id));
	const children = Array.isArray(root?.children) ? root.children : [];
	const ids = (type) => [...new Set(children.filter((ch) => ch?.type === type && ch.id != null && String(ch.id) !== String(id)).map((ch) => String(ch.id)))];
	return { dataflows: ids('DATAFLOW'), datasets: ids('DATA_SOURCE') };
}
