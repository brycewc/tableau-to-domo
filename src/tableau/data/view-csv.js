import fs from 'node:fs';
import path from 'node:path';
import { domoColumnName, dedupeNames } from '../../model/naming.js';
import { inferCsvColumns, reformatCsv } from './csv-writer.js';

/**
 * Export a view's summary data (GET /views/{id}/data). This is aggregated to the
 * view's level of detail and formatted for display, so it is always lossy.
 * @param {import('../client.js').TableauClient} client
 * @param {string} viewLuid
 * @param {string} outFile
 * @param {{ columnName?: (header: string) => string|undefined, maxAgeMinutes?: number, emitter?: import('../../util/events.js').Emitter }} [opts]
 * @returns {Promise<{ columns: { name: string, type: import('../../model/types.js').DomoColumnType, sourceName: string }[], rowCount: number, lossy: true, invalid: Record<string, number> }>}
 */
export async function exportViewCsv(client, viewLuid, outFile, opts = {}) {
	const { columnName, maxAgeMinutes, emitter } = opts;
	await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
	const rawFile = `${outFile}.raw`;
	try {
		await client.download(`/views/${encodeURIComponent(viewLuid)}/data`, rawFile, maxAgeMinutes ? { maxAge: maxAgeMinutes } : undefined);
		const { header, types } = await inferCsvColumns(rawFile, { lenient: true });
		if (!header.length) throw new Error(`View ${viewLuid} returned no CSV header`);
		const names = dedupeNames(header.map((h) => domoColumnName(columnName?.(h) ?? h)));
		const columns = header.map((sourceName, i) => ({ name: names[i], type: types[i], sourceName }));
		const { rowCount, invalid } = await reformatCsv({
			input: rawFile,
			output: outFile,
			columns: columns.map((c, i) => ({ ...c, sourceIndex: i })),
			lenient: true,
			emitter
		});
		return { columns, rowCount, lossy: true, invalid };
	} finally {
		await fs.promises.rm(rawFile, { force: true });
	}
}
