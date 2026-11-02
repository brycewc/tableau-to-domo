import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { slugify } from '../util/ids.js';

/** @returns {import('../model/types.js').Mappings} */
export function emptyMappings() {
	return { datasets: {}, accounts: [], cloudAmplifier: [], columns: {} };
}

/**
 * Read a JSON file. Returns `fallback` when the file does not exist (throws when no fallback is given).
 * @param {string} file
 * @param {any} [fallback]
 */
export async function readJson(file, fallback) {
	let text;
	try {
		text = await fsp.readFile(file, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
		throw err;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`Invalid JSON in ${file}: ${err.message}`, { cause: err });
	}
}

/**
 * Write JSON atomically (temp file in the same directory, then rename).
 * @param {string} file
 * @param {any} data
 */
export async function writeJson(file, data) {
	await writeText(file, `${JSON.stringify(data, null, '\t')}\n`);
}

/**
 * Write a text file atomically.
 * @param {string} file
 * @param {string} text
 */
export async function writeText(file, text) {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await fsp.writeFile(tmp, text, 'utf8');
	try {
		await fsp.rename(tmp, file);
	} catch (err) {
		await fsp.rm(tmp, { force: true });
		throw err;
	}
}

/**
 * Normalize a parsed mappings.json into the Mappings shape.
 * @param {any} raw
 * @returns {import('../model/types.js').Mappings}
 */
export function normalizeMappings(raw) {
	const value = raw && typeof raw === 'object' ? raw : {};
	const datasets = value.datasets && typeof value.datasets === 'object' && !Array.isArray(value.datasets) ? value.datasets : {};
	const accounts = Array.isArray(value.accounts) ? value.accounts.filter((a) => a && typeof a === 'object') : [];
	const cloudAmplifier = Array.isArray(value.cloudAmplifier) ? value.cloudAmplifier.filter((a) => a && typeof a === 'object') : [];
	const columns = value.columns && typeof value.columns === 'object' && !Array.isArray(value.columns) ? value.columns : {};
	const unmapped = value.unmapped && typeof value.unmapped === 'object' && !Array.isArray(value.unmapped) ? value.unmapped : {};
	return { ...value, datasets, accounts, cloudAmplifier, columns, unmapped };
}

/**
 * Open (without creating) a workspace directory and return path helpers.
 *
 * Layout:
 *   <root>/workbooks/<slug>/{source.<ext>, workbook.twb, metadata.json, ir.json, data/<ds>/*.csv,
 *     data/<ds>.manifest.json, plan.json, report.md, extract-log.json, convert-log.json, push-log.json, push-dry-run.json,
 *     unpush-log.json, unpush-dry-run.json, logs/<stage>-<timestamp>.json}
 *   <root>/datasources/<luid>/{manifest.json, data/..., beastmodes.json}   published datasources shared by several workbooks
 *   <root>/state/<instance>.json
 *   <root>/batch-<timestamp>.{json,md}
 *   <root>/mappings.json
 *
 * @param {string} root
 */
export function openWorkspace(root) {
	const absRoot = path.resolve(root);
	const workbooksDir = path.join(absRoot, 'workbooks');
	const stateDir = path.join(absRoot, 'state');
	const datasourcesDir = path.join(absRoot, 'datasources');
	const mappingsFile = path.join(absRoot, 'mappings.json');

	const workbookDir = (slug) => path.join(workbooksDir, slug);

	const paths = (slug) => {
		const dir = workbookDir(slug);
		const dataDir = path.join(dir, 'data');
		return {
			dir,
			source: (ext) => path.join(dir, `source.${String(ext).replace(/^\./, '')}`),
			twb: path.join(dir, 'workbook.twb'),
			metadata: path.join(dir, 'metadata.json'),
			ir: path.join(dir, 'ir.json'),
			dataDir,
			datasourceDataDir: (dsSlug) => path.join(dataDir, dsSlug),
			manifest: (dsSlug) => path.join(dataDir, `${dsSlug}.manifest.json`),
			plan: path.join(dir, 'plan.json'),
			report: path.join(dir, 'report.md'),
			pushLog: path.join(dir, 'push-log.json'),
			pushDryRun: path.join(dir, 'push-dry-run.json'),
			unpushLog: path.join(dir, 'unpush-log.json'),
			unpushDryRun: path.join(dir, 'unpush-dry-run.json'),
			extractLog: path.join(dir, 'extract-log.json'),
			convertLog: path.join(dir, 'convert-log.json'),
			logsDir: path.join(dir, 'logs')
		};
	};

	/** Site-scoped directory of a published datasource, shared by every workbook that uses it. */
	const sharedPaths = (luid) => {
		const dir = path.join(datasourcesDir, slugify(luid));
		return { dir, manifest: path.join(dir, 'manifest.json'), beastModes: path.join(dir, 'beastmodes.json') };
	};

	const ws = {
		root: absRoot,
		workbooksDir,
		stateDir,
		datasourcesDir,
		sharedPaths,
		batchFile: (stamp, ext = 'json') => path.join(absRoot, `batch-${stamp}.${ext}`),
		mappingsFile,
		workbookDir,
		paths,
		readJson,
		writeJson,
		writeText,
		stateFile: (instance) => path.join(stateDir, `${slugify(instance || 'default')}.json`),

		/** Workspace-relative path with forward slashes. */
		relative: (file) => path.relative(absRoot, path.resolve(absRoot, file)).split(path.sep).join('/'),

		/** Absolute path for a workspace-relative (or already absolute) path. */
		resolve: (file) => path.resolve(absRoot, file),

		exists: (file) => fs.existsSync(file),

		/** @returns {Promise<import('../model/types.js').Mappings>} */
		async loadMappings() {
			return normalizeMappings(await readJson(mappingsFile, emptyMappings()));
		},

		/** Create mappings.json with empty sections when it does not exist. Returns true when created. */
		async ensureMappings() {
			if (fs.existsSync(mappingsFile)) return false;
			await writeJson(mappingsFile, emptyMappings());
			return true;
		},

		/** @param {string} slug */
		async readManifests(slug) {
			const { dataDir } = paths(slug);
			let names = [];
			try {
				names = await fsp.readdir(dataDir);
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
			const manifests = [];
			for (const name of names.filter((n) => n.endsWith('.manifest.json')).sort()) {
				manifests.push(await readJson(path.join(dataDir, name)));
			}
			return manifests;
		},

		/** @returns {Promise<{ slug: string, name: string, luid?: string, contentUrl?: string, source?: string, extractedAt?: string, hasIr: boolean, hasPlan: boolean, pushed: boolean }[]>} */
		async listWorkbooks() {
			let entries = [];
			try {
				entries = await fsp.readdir(workbooksDir, { withFileTypes: true });
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
			const out = [];
			for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
				const p = paths(entry.name);
				const meta = await readJson(p.metadata, null).catch(() => null);
				out.push({
					slug: entry.name,
					name: meta?.workbook?.name ?? entry.name,
					luid: meta?.workbook?.luid,
					contentUrl: meta?.workbook?.contentUrl,
					source: meta?.source,
					extractedAt: meta?.extractedAt,
					hasIr: fs.existsSync(p.ir),
					hasPlan: fs.existsSync(p.plan),
					pushed: fs.existsSync(p.pushLog)
				});
			}
			return out;
		},

		/**
		 * Find the workspace slug for a slug, workbook name or luid.
		 * @param {string} nameOrSlug
		 */
		async resolveSlug(nameOrSlug) {
			if (!nameOrSlug) throw new Error('A workbook slug or name is required');
			const isSlug = (name) => fs.existsSync(workbooksDir) && fs.readdirSync(workbooksDir).includes(name);
			if (!nameOrSlug.includes('/') && !nameOrSlug.includes('\\') && isSlug(nameOrSlug)) return nameOrSlug;
			const all = await ws.listWorkbooks();
			const lower = String(nameOrSlug).toLowerCase();
			const matches = all.filter((w) => w.name.toLowerCase() === lower || w.luid === nameOrSlug);
			if (matches.length === 1) return matches[0].slug;
			if (matches.length > 1) {
				throw new Error(`"${nameOrSlug}" matches several workbooks: ${matches.map((m) => m.slug).join(', ')}. Use the slug.`);
			}
			const slug = slugify(nameOrSlug);
			if (isSlug(slug)) return slug;
			const known = all.map((w) => w.slug).join(', ') || 'none';
			throw new Error(`No extracted workbook "${nameOrSlug}" in ${workbooksDir} (known: ${known}). Run extract first.`);
		}
	};
	return ws;
}

/** @typedef {ReturnType<typeof openWorkspace>} Workspace */
