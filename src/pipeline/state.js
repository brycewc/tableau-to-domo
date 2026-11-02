import fs from 'node:fs/promises';
import path from 'node:path';
import { isRef } from '../util/refs.js';

/**
 * Load push state for an instance, or an empty state.
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} instance
 * @returns {Promise<import('../model/types.js').PushState>}
 */
export async function loadState(ws, instance) {
	const raw = await ws.readJson(ws.stateFile(instance), null);
	if (!raw) return { instance, objects: {} };
	if (raw.instance && instance && raw.instance !== instance) {
		throw new Error(`State file ${ws.stateFile(instance)} belongs to instance "${raw.instance}", not "${instance}"`);
	}
	return { ...raw, instance: raw.instance || instance, objects: raw.objects && typeof raw.objects === 'object' ? raw.objects : {} };
}

/**
 * @param {import('./workspace.js').Workspace} ws
 * @param {import('../model/types.js').PushState} state
 */
export async function saveState(ws, state) {
	await ws.writeJson(ws.stateFile(state.instance), state);
}

function keyOf(refOrKey) {
	if (isRef(refOrKey)) return refOrKey.$ref;
	return String(refOrKey);
}

/**
 * @param {import('../model/types.js').PushState} state
 * @param {string|{ $ref: string }} refOrKey  'kind:key' or a ref object
 * @returns {import('../model/types.js').StateEntry|undefined}
 */
export function getEntry(state, refOrKey) {
	return state.objects[keyOf(refOrKey)];
}

/**
 * Set (merge) a state entry and stamp updatedAt.
 * @param {import('../model/types.js').PushState} state
 * @param {string|{ $ref: string }} refOrKey
 * @param {Partial<import('../model/types.js').StateEntry>} entry
 */
export function setEntry(state, refOrKey, entry) {
	const key = keyOf(refOrKey);
	const prev = state.objects[key];
	const extra = prev?.extra || entry.extra ? { ...prev?.extra, ...entry.extra } : undefined;
	const next = { ...prev, ...entry, updatedAt: new Date().toISOString() };
	if (extra) next.extra = extra;
	state.objects[key] = next;
	return next;
}

/**
 * @param {import('../model/types.js').PushState} state
 * @param {string|{ $ref: string }} refOrKey
 */
export function deleteEntry(state, refOrKey) {
	delete state.objects[keyOf(refOrKey)];
}

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

const heldLocks = new Set();

/**
 * Take the exclusive per-instance push lock, so concurrent pushes cannot overwrite each other's state.
 * Fails fast when another live push holds it; a lock left by a dead process is replaced.
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} instance
 * @returns {Promise<() => Promise<void>>} release
 */
export async function acquireStateLock(ws, instance) {
	const file = ws.stateFile(instance).replace(/\.json$/, '.lock');
	await fs.mkdir(path.dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		if (heldLocks.has(file)) throw new Error(`Another push to "${instance}" is running in this process (lock ${file})`);
		try {
			const handle = await fs.open(file, 'wx');
			await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
			await handle.close();
			heldLocks.add(file);
			return async () => {
				heldLocks.delete(file);
				await fs.rm(file, { force: true });
			};
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
			let holder;
			try {
				holder = JSON.parse(await fs.readFile(file, 'utf8'));
			} catch {
				holder = null;
			}
			if (holder && pidAlive(holder.pid)) {
				throw new Error(`Another push to "${instance}" is running (pid ${holder.pid}, since ${holder.startedAt}). Wait for it, or delete ${file} if it is stale.`, { cause: err });
			}
			await fs.rm(file, { force: true });
		}
	}
	throw new Error(`Could not take the push lock ${file}`);
}
