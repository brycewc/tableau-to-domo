import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { parse } from 'csv-parse';
import { formatDomoValue, createTypeInferrer } from '../../convert/schema.js';

/**
 * RFC 4180 field: quoted when it contains a delimiter, quote or line break.
 * @param {string} value
 */
export function csvField(value) {
	const text = value == null ? '' : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {string[]} values */
export function csvLine(values) {
	return `${values.map(csvField).join(',')}\n`;
}

/**
 * Buffered CSV file writer with backpressure.
 * @param {string} file
 * @param {string[]} header
 */
export async function createCsvWriter(file, header) {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const stream = fs.createWriteStream(file, { encoding: 'utf8' });
	let failure;
	stream.on('error', (err) => {
		failure = err;
	});
	let rows = 0;
	let buffer = csvLine(header);
	const flush = async () => {
		if (failure) throw failure;
		if (!buffer) return;
		const chunk = buffer;
		buffer = '';
		if (!stream.write(chunk)) {
			// once() leaves its listener attached until the event fires, so the losing 'error' wait must be aborted.
			const ac = new AbortController();
			try {
				await Promise.race([once(stream, 'drain', { signal: ac.signal }), once(stream, 'error', { signal: ac.signal })]);
			} finally {
				ac.abort();
			}
		}
		if (failure) throw failure;
	};
	return {
		/** @param {string[]} values */
		async write(values) {
			buffer += csvLine(values);
			rows++;
			if (buffer.length >= 1 << 16) await flush();
		},
		get rowCount() {
			return rows;
		},
		/** @returns {Promise<{ rowCount: number }>} */
		async end() {
			await flush();
			stream.end();
			await once(stream, 'finish');
			if (failure) throw failure;
			return { rowCount: rows };
		},
		async abort() {
			stream.destroy();
			await fs.promises.rm(file, { force: true });
		}
	};
}

/**
 * Streaming record reader over a CSV file. Yields arrays of strings. Empty lines are skipped only when the
 * header has more than one column: in a one-column CSV an empty line is a NULL value.
 * @param {string} file
 * @returns {AsyncGenerator<string[]>}
 */
export async function* readCsv(file) {
	const parser = fs.createReadStream(file).pipe(parse({ bom: true, relax_column_count: true, relax_quotes: true }));
	let width;
	try {
		for await (const record of parser) {
			if (width === undefined) {
				if (record.length === 1 && record[0] === '') continue;
				width = record.length;
			} else if (width > 1 && record.length === 1 && record[0] === '') continue;
			yield record;
		}
	} finally {
		parser.destroy();
	}
}

/**
 * Read only the header row of a CSV file.
 * @param {string} file
 * @returns {Promise<string[]>}
 */
export async function readCsvHeader(file) {
	for await (const record of readCsv(file)) return record;
	return [];
}

/**
 * Write the header and the first `rows` records of a CSV file to `output` (may equal `input`).
 * @param {{ input: string, output: string, rows: number }} opts
 * @returns {Promise<{ rowCount: number, truncated: boolean }>}
 */
export async function copyCsvHead({ input, output, rows }) {
	const tmp = `${output}.${process.pid}.${Date.now()}.head.tmp`;
	let writer;
	let truncated = false;
	try {
		for await (const record of readCsv(input)) {
			if (!writer) {
				writer = await createCsvWriter(tmp, record);
				continue;
			}
			if (writer.rowCount >= rows) {
				truncated = true;
				break;
			}
			await writer.write(record);
		}
		if (!writer) writer = await createCsvWriter(tmp, []);
		const { rowCount } = await writer.end();
		await fs.promises.rename(tmp, output);
		return { rowCount, truncated };
	} catch (err) {
		await fs.promises.rm(tmp, { force: true });
		throw err;
	}
}

/**
 * Infer a Domo type for every column of a CSV file by scanning all rows.
 * @param {string} file
 * @param {{ lenient?: boolean }} [options]
 * @returns {Promise<{ header: string[], types: import('../../model/types.js').DomoColumnType[], rowCount: number }>}
 */
export async function inferCsvColumns(file, { lenient = false } = {}) {
	let header;
	let inferrers = [];
	let rowCount = 0;
	for await (const record of readCsv(file)) {
		if (!header) {
			header = record;
			inferrers = header.map(() => createTypeInferrer({ lenient }));
			continue;
		}
		rowCount++;
		for (let i = 0; i < inferrers.length; i++) inferrers[i].add(record[i]);
	}
	return { header: header || [], types: inferrers.map((inf) => inf.result()), rowCount };
}

/**
 * @typedef {Object} OutputColumn
 * @property {string} name                  Domo column name written to the header
 * @property {import('../../model/types.js').DomoColumnType} type
 * @property {string} [sourceName]          Source header to read from (matched exactly, then case-insensitively)
 * @property {number} [sourceIndex]         Source column position; wins over sourceName
 * @property {boolean} [boolean]            Normalize boolean spellings to 'true'/'false'
 */

/**
 * Rewrite a CSV for Domo: rename headers, normalize values per Domo type,
 * RFC 4180 output with \n line endings. The first source row is the header.
 * @param {{ input: string, output: string, columns: OutputColumn[], lenient?: boolean, emitter?: import('../../util/events.js').Emitter, label?: string }} opts
 * @returns {Promise<{ rowCount: number, invalid: Record<string, number>, missing: string[] }>}
 */
export async function reformatCsv({ input, output, columns, lenient = false, emitter, label }) {
	const writer = await createCsvWriter(
		output,
		columns.map((c) => c.name)
	);
	const invalid = {};
	const missing = [];
	let positions;
	try {
		for await (const record of readCsv(input)) {
			if (!positions) {
				positions = resolvePositions(record, columns, missing);
				continue;
			}
			const values = new Array(columns.length);
			for (let i = 0; i < columns.length; i++) {
				const position = positions[i];
				const raw = position < 0 ? '' : record[position];
				const column = columns[i];
				const formatted = formatDomoValue(raw, column.type, { lenient, boolean: column.boolean });
				if (formatted === null) {
					invalid[column.name] = (invalid[column.name] || 0) + 1;
					values[i] = '';
				} else {
					values[i] = formatted;
				}
			}
			await writer.write(values);
			if (emitter && writer.rowCount % 250000 === 0) {
				emitter.progress(`${label || path.basename(output)}: ${writer.rowCount} rows`, { rows: writer.rowCount });
			}
		}
	} catch (err) {
		await writer.abort();
		throw new Error(`Failed to read ${input}: ${err.message}`, { cause: err });
	}
	const { rowCount } = await writer.end();
	return { rowCount, invalid, missing };
}

function resolvePositions(header, columns, missing) {
	const exact = new Map();
	const lower = new Map();
	header.forEach((name, index) => {
		if (!exact.has(name)) exact.set(name, index);
		const key = name.trim().toLowerCase();
		if (!lower.has(key)) lower.set(key, index);
	});
	return columns.map((column, i) => {
		if (Number.isInteger(column.sourceIndex)) return column.sourceIndex < header.length ? column.sourceIndex : -1;
		const source = column.sourceName ?? column.name;
		const index = exact.get(source) ?? lower.get(source.trim().toLowerCase());
		if (index === undefined) {
			missing.push(column.name);
			return -1;
		}
		return index ?? i;
	});
}
