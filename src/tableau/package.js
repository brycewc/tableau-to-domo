import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { assertNoDoctype, sniffRootName } from './twb/xml.js';

export const MAX_XML_BYTES = 100 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 200;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const XML_ENTRY = /\.(twb|tds)$/i;
const CACHE_PATH = /(^|\/)(TwbxExternalCache|TdsxExternalCache)\//i;
const ROOT_KIND = { workbook: 'twb', datasource: 'tds' };

/**
 * @typedef {Object} TableauPackage
 * @property {'twb'|'twbx'|'tds'|'tdsx'} kind
 * @property {string} xml                       Root workbook/datasource XML
 * @property {string} xmlEntry                  Zip entry name of the root XML (file basename when not packaged)
 * @property {string[]} entries                 Every file entry in the package (empty when not packaged)
 * @property {(name: string) => string|undefined} findEntry  Resolve a path written in the XML (e.g. an extract dbname) to an entry name
 * @property {(entry: string|{ name: string }, dest: string) => Promise<{ file: string, bytes: number }>} extractEntry
 * @property {() => void} close
 */

async function readHead(filePath, length) {
	const handle = await fsp.open(filePath, 'r');
	try {
		const buf = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buf, 0, length, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

function openZip(filePath) {
	return new Promise((resolve, reject) => {
		yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) =>
			err ? reject(new Error(`Cannot open package ${path.basename(filePath)}: ${err.message}`)) : resolve(zip)
		);
	});
}

function listEntries(zip) {
	return new Promise((resolve, reject) => {
		const entries = [];
		zip.on('entry', (entry) => {
			entries.push(entry);
			zip.readEntry();
		});
		zip.once('end', () => resolve(entries));
		zip.once('error', (err) => reject(new Error(`Unsafe or corrupt package: ${err.message}`)));
		zip.readEntry();
	});
}

function openStream(zip, entry) {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
	});
}

function compressionRatio(entry) {
	if (entry.uncompressedSize === 0) return 0;
	if (entry.compressedSize === 0) return Infinity;
	return entry.uncompressedSize / entry.compressedSize;
}

function assertEntrySafe(entry) {
	if (entry.isEncrypted?.()) throw new Error(`Package entry ${entry.fileName} is encrypted`);
	if (compressionRatio(entry) > MAX_COMPRESSION_RATIO) {
		throw new Error(`Package entry ${entry.fileName} has a compression ratio above ${MAX_COMPRESSION_RATIO} (possible zip bomb)`);
	}
}

/** Rejects absolute paths, drive letters and '..' segments. */
export function assertSafeEntryName(name) {
	const n = String(name ?? '');
	if (!n || n.includes('\0') || /^([a-zA-Z]:|[\\/])/.test(n) || n.split(/[\\/]/).includes('..')) {
		throw new Error(`Unsafe package entry path: ${n}`);
	}
}

async function readEntryText(zip, entry, limit) {
	const stream = await openStream(zip, entry);
	const chunks = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		if (total > limit) {
			stream.destroy();
			throw new Error(`Package entry ${entry.fileName} exceeds ${limit} bytes`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function normalizeRef(p) {
	return String(p ?? '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/^\/+/, '');
}

function checkXmlText(text, label) {
	assertNoDoctype(text.slice(0, 8192));
	const root = sniffRootName(text);
	if (!ROOT_KIND[root]) throw new Error(`${label} is not a Tableau workbook or datasource (root <${root ?? '?'}>)`);
	return ROOT_KIND[root];
}

/**
 * Open a .twb/.twbx/.tds/.tdsx file. Packaged files are detected by zip magic bytes,
 * not by extension. The root XML is the shallowest .twb/.tds entry that parses as a
 * workbook/datasource root; cache folders are ignored.
 *
 * @param {string} filePath
 * @returns {Promise<TableauPackage>}
 */
export async function openPackage(filePath) {
	const stat = await fsp.stat(filePath);
	if (!stat.isFile()) throw new Error(`${filePath} is not a file`);
	const head = await readHead(filePath, 4);
	const isZip = head.length === 4 && (head.equals(ZIP_MAGIC) || head.equals(EMPTY_ZIP_MAGIC));

	if (!isZip) {
		if (stat.size > MAX_XML_BYTES) throw new Error(`${path.basename(filePath)} is larger than ${MAX_XML_BYTES} bytes`);
		let xml = await fsp.readFile(filePath, 'utf8');
		if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
		const kind = checkXmlText(xml, path.basename(filePath));
		return {
			kind: /** @type {'twb'|'tds'} */ (kind),
			xml,
			xmlEntry: path.basename(filePath),
			entries: [],
			findEntry: () => undefined,
			extractEntry: async () => {
				throw new Error(`${path.basename(filePath)} is not a packaged file; it has no entries to extract`);
			},
			close: () => {}
		};
	}

	const zip = await openZip(filePath);
	try {
		const all = await listEntries(zip);
		const files = all.filter((e) => !e.fileName.endsWith('/'));
		const byName = new Map(files.map((e) => [e.fileName, e]));
		const candidates = files
			.filter((e) => XML_ENTRY.test(e.fileName) && !CACHE_PATH.test(e.fileName))
			.sort((a, b) => a.fileName.split('/').length - b.fileName.split('/').length || a.fileName.localeCompare(b.fileName));
		if (!candidates.length) throw new Error(`${path.basename(filePath)} contains no .twb or .tds file`);

		let xml;
		let rootEntry;
		let kind;
		const errors = [];
		for (const entry of candidates) {
			try {
				assertEntrySafe(entry);
				if (entry.uncompressedSize > MAX_XML_BYTES) throw new Error(`${entry.fileName} is larger than ${MAX_XML_BYTES} bytes`);
				let text = await readEntryText(zip, entry, MAX_XML_BYTES);
				if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
				kind = checkXmlText(text, entry.fileName);
				xml = text;
				rootEntry = entry;
				break;
			} catch (err) {
				errors.push(err.message);
				if (/DOCTYPE|zip bomb|encrypted|exceeds|larger than/.test(err.message)) throw err;
			}
		}
		if (!rootEntry) throw new Error(`${path.basename(filePath)} has no valid Tableau XML: ${errors.join('; ')}`);

		const names = files.map((e) => e.fileName);
		const findEntry = (ref) => {
			const wanted = normalizeRef(ref).toLowerCase();
			if (!wanted) return undefined;
			const exact = names.find((n) => n.toLowerCase() === wanted);
			if (exact) return exact;
			const suffix = names.filter((n) => wanted.endsWith(`/${n.toLowerCase()}`) || n.toLowerCase().endsWith(`/${wanted}`));
			if (suffix.length === 1) return suffix[0];
			const base = wanted.split('/').pop();
			const byBase = names.filter((n) => n.toLowerCase().split('/').pop() === base);
			return byBase.length === 1 ? byBase[0] : undefined;
		};

		const extractEntry = async (entryRef, dest) => {
			const name = typeof entryRef === 'string' ? entryRef : entryRef?.name ?? entryRef?.fileName;
			const entry = byName.get(name) || byName.get(findEntry(name));
			if (!entry) throw new Error(`Package entry not found: ${name}`);
			assertSafeEntryName(entry.fileName);
			assertEntrySafe(entry);
			let destFile = path.resolve(String(dest));
			const isDir = /[\\/]$/.test(String(dest)) || (await fsp.stat(destFile).then((s) => s.isDirectory(), () => false));
			if (isDir) {
				const root = destFile;
				destFile = path.resolve(root, entry.fileName);
				if (destFile !== root && !destFile.startsWith(root + path.sep)) throw new Error(`Unsafe package entry path: ${entry.fileName}`);
			}
			await fsp.mkdir(path.dirname(destFile), { recursive: true });
			const stream = await openStream(zip, entry);
			let bytes = 0;
			const counter = new Transform({
				transform(chunk, _enc, cb) {
					bytes += chunk.length;
					cb(null, chunk);
				}
			});
			await pipeline(stream, counter, fs.createWriteStream(destFile));
			return { file: destFile, bytes };
		};

		return {
			kind: kind === 'twb' ? 'twbx' : 'tdsx',
			xml,
			xmlEntry: rootEntry.fileName,
			entries: names,
			findEntry,
			extractEntry,
			close: () => zip.close()
		};
	} catch (err) {
		zip.close();
		throw err;
	}
}
