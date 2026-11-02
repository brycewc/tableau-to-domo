import { tableauToDomoType, formatDomoValue } from '../../convert/schema.js';
import { domoColumnName, dedupeNames } from '../../model/naming.js';
import { createCsvWriter } from './csv-writer.js';

const EXPORTABLE_CLASSES = new Set(['COLUMN']);
const UNQUERYABLE_TYPES = new Set(['SPATIAL']);

/**
 * @typedef {Object} VdsField
 * @property {string} fieldName
 * @property {string} fieldCaption
 * @property {string} [dataType]       INTEGER | REAL | STRING | DATE | DATETIME | BOOLEAN | SPATIAL | UNKNOWN
 * @property {string} [columnClass]    COLUMN | CALCULATION | BIN | GROUP | TABLE_CALCULATION | ...
 * @property {string} [logicalTableId]
 */

/**
 * List the fields of a published datasource.
 * @param {import('../client.js').TableauClient} client
 * @param {string} datasourceLuid
 * @returns {Promise<VdsField[]>}
 */
export async function readDatasourceMetadata(client, datasourceLuid) {
	const response = await client.vds('read-metadata', { datasource: { datasourceLuid } });
	if (response?.error) throw new Error(`VizQL Data Service read-metadata failed: ${errorText(response.error)}`);
	const fields = response?.data ?? response?.fields ?? [];
	if (!Array.isArray(fields)) throw new Error('VizQL Data Service read-metadata returned no field list');
	return fields.filter((f) => f && (f.fieldCaption || f.fieldName));
}

function errorText(error) {
	if (typeof error === 'string') return error;
	return error?.message || error?.errorCode || JSON.stringify(error);
}

/**
 * Export row-level data from a published datasource through VizQL Data Service.
 *
 * VDS has no documented paging and no documented row cap, and returns the whole
 * result as one JSON body, so very large datasources may time out or be
 * truncated server side. Pass `rowLimit` to cap explicitly; a result that hits
 * it is reported as truncated.
 *
 * @param {import('../client.js').TableauClient} client
 * @param {string} datasourceLuid
 * @param {string} outFile
 * @param {{ fields?: string[], includeCalculations?: boolean, columnName?: (field: VdsField) => string|undefined, rowLimit?: number, emitter?: import('../../util/events.js').Emitter }} [opts]
 *   fields: captions to export (overrides the class filter, so calcs can be requested by name)
 * @returns {Promise<{ columns: { name: string, type: import('../../model/types.js').DomoColumnType, sourceName: string }[], rowCount: number, truncated: boolean, skipped: { caption: string, reason: string }[] }>}
 */
export async function exportPublishedDatasource(client, datasourceLuid, outFile, opts = {}) {
	const { fields: requested, includeCalculations = false, columnName, rowLimit, emitter } = opts;
	const metadata = await readDatasourceMetadata(client, datasourceLuid);
	const skipped = [];
	let selected;
	if (requested?.length) {
		const byCaption = new Map(metadata.map((f) => [captionOf(f), f]));
		selected = [];
		for (const caption of requested) {
			const field = byCaption.get(caption);
			if (field) selected.push(field);
			else skipped.push({ caption, reason: 'not in datasource metadata' });
		}
	} else {
		selected = metadata.filter((field) => {
			const columnClass = String(field.columnClass || 'COLUMN').toUpperCase();
			if (EXPORTABLE_CLASSES.has(columnClass) || (includeCalculations && columnClass === 'CALCULATION')) return true;
			skipped.push({ caption: captionOf(field), reason: `columnClass ${columnClass}` });
			return false;
		});
	}
	selected = selected.filter((field) => {
		if (!UNQUERYABLE_TYPES.has(String(field.dataType || '').toUpperCase())) return true;
		skipped.push({ caption: captionOf(field), reason: 'spatial fields cannot be queried' });
		return false;
	});
	if (!selected.length) throw new Error(`Published datasource ${datasourceLuid} has no exportable fields`);

	const captions = selected.map(captionOf);
	const names = dedupeNames(selected.map((f) => domoColumnName(columnName?.(f) ?? captionOf(f))));
	const columns = selected.map((field, i) => ({
		name: names[i],
		type: tableauToDomoType(field.dataType),
		sourceName: captions[i]
	}));
	const booleans = selected.map((f) => String(f.dataType || '').toUpperCase() === 'BOOLEAN');

	emitter?.step(`Querying ${captions.length} fields from published datasource ${datasourceLuid}`);
	const options = { returnFormat: 'OBJECTS', disaggregate: true };
	if (rowLimit) options.rowLimit = rowLimit;
	const response = await client.vds('query-datasource', {
		datasource: { datasourceLuid },
		query: { fields: captions.map((fieldCaption) => ({ fieldCaption })) },
		options
	});
	if (response?.error) throw new Error(`VizQL Data Service query-datasource failed: ${errorText(response.error)}`);
	const rows = response?.data;
	if (!Array.isArray(rows)) throw new Error('VizQL Data Service query-datasource returned no data array');

	const writer = await createCsvWriter(
		outFile,
		columns.map((c) => c.name)
	);
	try {
		for (const row of rows) {
			const values = columns.map((column, i) => {
				const raw = Array.isArray(row) ? row[i] : row?.[captions[i]];
				const value = (column.type === 'DATE' || column.type === 'DATETIME') && typeof raw === 'number' ? new Date(raw) : raw;
				return formatDomoValue(value, column.type, { boolean: booleans[i] }) ?? '';
			});
			await writer.write(values);
		}
	} catch (err) {
		await writer.abort();
		throw err;
	}
	const { rowCount } = await writer.end();
	return { columns, rowCount, truncated: Boolean(rowLimit && rowCount >= rowLimit), skipped };
}

function captionOf(field) {
	return field.fieldCaption || field.fieldName;
}
