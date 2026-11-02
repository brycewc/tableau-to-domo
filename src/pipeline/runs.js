import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const RUN_STAGES = ['extract', 'convert', 'push', 'unpush'];
export const DEFAULT_KEEP = 50;

const NAME = /^(extract|convert|push|unpush)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?\.json$/;

/** `push-2026-10-20T16-54-05Z.json` for a run that started at that time (UTC, to the second). */
export function runLogName(stage, startedAt, counter = 0) {
	const stamp = new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
	return `${stage}-${stamp}${counter ? `-${counter}` : ''}.json`;
}

/** @returns {{ stage: string, stamp: string, counter: number }|null} */
export function parseRunLogName(name) {
	const m = NAME.exec(name);
	return m ? { stage: m[1], stamp: m[2], counter: Number(m[3] ?? 0) } : null;
}

const sortKey = (parsed) => `${parsed.stamp}.${String(parsed.counter).padStart(4, '0')}`;

async function runFiles(dir, stage) {
	let names = [];
	try {
		names = await fsp.readdir(dir);
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
	}
	return names
		.map((name) => ({ name, parsed: parseRunLogName(name) }))
		.filter((f) => f.parsed && (!stage || f.parsed.stage === stage))
		.sort((a, b) => sortKey(a.parsed).localeCompare(sortKey(b.parsed)));
}

/**
 * Write one run's log to `logs/<stage>-<timestamp>.json` and keep only the newest `keep` logs of that stage.
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} slug
 * @param {'extract'|'convert'|'push'|'unpush'} stage
 * @param {Record<string, any> & { startedAt: string }} log
 * @returns {Promise<string>} the file written
 */
export async function writeRunLog(ws, slug, stage, log, { keep = DEFAULT_KEEP } = {}) {
	const dir = ws.paths(slug).logsDir;
	let counter = 0;
	while (fs.existsSync(path.join(dir, runLogName(stage, log.startedAt, counter)))) counter++;
	const file = path.join(dir, runLogName(stage, log.startedAt, counter));
	await ws.writeJson(file, { stage, ...log });
	const files = await runFiles(dir, stage);
	for (const old of files.slice(0, Math.max(0, files.length - keep))) await fsp.rm(path.join(dir, old.name), { force: true });
	return file;
}

/**
 * Past runs of a workbook, oldest first.
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} slug
 * @param {{ stage?: string }} [opts]
 */
export async function listRuns(ws, slug, { stage } = {}) {
	const dir = ws.paths(slug).logsDir;
	const out = [];
	for (const { name, parsed } of await runFiles(dir, stage)) {
		const log = await ws.readJson(path.join(dir, name), null).catch(() => null);
		if (!log) continue;
		const ms = log.timing?.ms ?? (log.finishedAt && log.startedAt ? Date.parse(log.finishedAt) - Date.parse(log.startedAt) : undefined);
		out.push({
			stage: parsed.stage,
			file: ws.relative(path.join(dir, name)),
			startedAt: log.startedAt,
			finishedAt: log.finishedAt,
			ms,
			ok: log.ok !== false,
			...(log.instance ? { instance: log.instance } : {}),
			...(log.counts ? { counts: log.counts } : {}),
			...(log.error ? { error: log.error } : {})
		});
	}
	return out;
}

/**
 * The newest log per stage, for the report: the current `<stage>-log.json`, else the newest file in logs/.
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} slug
 * @returns {Promise<Record<string, any>>}
 */
export async function latestRunLogs(ws, slug) {
	const p = ws.paths(slug);
	const current = { extract: p.extractLog, convert: p.convertLog, push: p.pushLog, unpush: p.unpushLog };
	const out = {};
	for (const stage of RUN_STAGES) {
		let log = await ws.readJson(current[stage], null).catch(() => null);
		if (!log) {
			const newest = (await runFiles(p.logsDir, stage)).at(-1);
			if (newest) log = await ws.readJson(path.join(p.logsDir, newest.name), null).catch(() => null);
		}
		if (log) out[stage] = log;
	}
	return out;
}
