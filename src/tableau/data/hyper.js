import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HYPER_SCRIPT = fileURLToPath(new URL('../../../python/hyper_export.py', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const CHECK_TIMEOUT_MS = 60000;
const EXPORT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_CAPTURE = 4 * 1024 * 1024;

// -I hides user site-packages too, so a `pip install --user` copy is retried with -E alone (-P needs Python 3.11+;
// the sidecar runs as a script with cwd = tmpdir, so sys.path[0] is the trusted script directory, not cwd).
const FLAG_SETS = [['-I'], ['-E']];
const workingFlags = new Map();

/**
 * Run the sidecar and parse the JSON object on its last stdout line.
 * @param {string} python
 * @param {string[]} flags
 * @param {string[]} args
 * @param {{ timeoutMs: number }} opts
 * @returns {Promise<{ code: number|null, json: any, stdout: string, stderr: string }>}
 */
export function runSidecar(python, flags, args, { timeoutMs }) {
	python = resolvePythonPath(python);
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(python, [...flags, HYPER_SCRIPT, ...args], {
				cwd: os.tmpdir(),
				shell: false,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
			});
		} catch (err) {
			reject(interpreterError(python, err));
			return;
		}
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			stdout = (stdout + chunk).slice(-MAX_CAPTURE);
		});
		child.stderr.on('data', (chunk) => {
			stderr = (stderr + chunk).slice(-MAX_CAPTURE);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(interpreterError(python, err));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Hyper export timed out after ${Math.round(timeoutMs / 1000)}s`));
				return;
			}
			resolve({ code, json: lastJson(stdout), stdout, stderr });
		});
	});
}

/**
 * Make an interpreter path that contains a directory separator absolute against `cwd`. The sidecar
 * is spawned with cwd = tmpdir, so a relative path like `.venv/bin/python` would not resolve there.
 * A bare command name (`python3`) is left for PATH lookup.
 * @param {string} python
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
export function resolvePythonPath(python, cwd = process.cwd()) {
	if (!python || path.isAbsolute(python) || !/[\\/]/.test(python)) return python;
	return path.resolve(cwd, python);
}

/**
 * Virtualenv interpreters to try when no interpreter was configured.
 * @param {string} [cwd=process.cwd()]
 * @returns {string[]}
 */
export function venvPythonCandidates(cwd = process.cwd()) {
	const rel = process.platform === 'win32' ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe'] : ['.venv/bin/python', 'venv/bin/python'];
	const roots = [...new Set([path.resolve(cwd), path.resolve(PROJECT_ROOT)])];
	return roots.flatMap((root) => rel.map((r) => path.join(root, r))).filter((file) => fs.existsSync(file));
}

/**
 * Pick the interpreter for the Hyper sidecar. An explicit interpreter is only made absolute. Otherwise
 * `python` is used when it has tableauhyperapi, else the first project virtualenv that has it.
 * @param {{ python?: string, explicit?: boolean, cwd?: string, check?: typeof checkHyper }} [opts]
 * @returns {Promise<{ python: string, ok: boolean, version?: string, error?: string, detected?: boolean }>}
 */
export async function detectPython({ python = 'python3', explicit = false, cwd = process.cwd(), check = checkHyper } = {}) {
	const resolved = resolvePythonPath(python, cwd);
	const first = await check(resolved);
	if (first.ok || explicit) return { python: resolved, ...first };
	for (const candidate of venvPythonCandidates(cwd)) {
		if (candidate === resolved) continue;
		const result = await check(candidate);
		if (result.ok) return { python: candidate, ...result, detected: true };
	}
	return { python: resolved, ...first };
}

function interpreterError(python, err) {
	if (err?.code === 'ENOENT') {
		return new Error(`Python interpreter not found: ${python}. Install Python 3 or set T2D_PYTHON to its path.`, {
			cause: err
		});
	}
	return new Error(`Could not start ${python}: ${err?.message || err}`, { cause: err });
}

function lastJson(stdout) {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith('{')) continue;
		try {
			return JSON.parse(line);
		} catch {
			// keep looking
		}
	}
	return null;
}

function failureMessage(result) {
	if (result.json?.error) return result.json.error;
	const tail = result.stderr.trim().split(/\r?\n/).slice(-5).join(' ').trim();
	return tail || `Hyper sidecar exited with code ${result.code} and no output`;
}

/**
 * Check that the interpreter can run the sidecar with tableauhyperapi.
 * @param {string} [python='python3']
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function checkHyper(python = 'python3') {
	let other;
	let missing = false;
	for (const flags of FLAG_SETS) {
		let result;
		try {
			result = await runSidecar(python, flags, ['--check'], { timeoutMs: CHECK_TIMEOUT_MS });
		} catch (err) {
			return { ok: false, error: err.message };
		}
		if (result.code === 0 && result.json?.ok) {
			workingFlags.set(resolvePythonPath(python), flags);
			return { ok: true, version: result.json.version };
		}
		if (result.json?.code === 'missing-module' || /No module named .?tableauhyperapi/.test(result.stderr)) {
			missing = true;
			continue;
		}
		other ??= result;
		if (!missing) break;
	}
	if (missing && !other) {
		return {
			ok: false,
			error: `tableauhyperapi is not available to ${python}. Run: ${python} -m pip install tableauhyperapi (or set T2D_PYTHON to a virtualenv python that has it).`
		};
	}
	return { ok: false, error: failureMessage(other) };
}

/**
 * @typedef {Object} HyperTable
 * @property {string} schema
 * @property {string} name
 * @property {string} file          Absolute CSV path (header row = hyper column names)
 * @property {number} rowCount
 * @property {{ name: string, type: string, nullable: boolean }[]} columns
 */

/**
 * Export every table in a .hyper file to CSV through the Python sidecar.
 * @param {{ python?: string, hyperFile: string, outDir: string, timeoutMs?: number }} opts
 * @returns {Promise<{ tables: HyperTable[], hyperApiVersion?: string }>}
 */
export async function exportHyper({ python = 'python3', hyperFile, outDir, timeoutMs = EXPORT_TIMEOUT_MS }) {
	if (!hyperFile || !outDir) throw new Error('exportHyper needs hyperFile and outDir');
	python = resolvePythonPath(python);
	const flags = workingFlags.get(python) || FLAG_SETS[0];
	const absOut = path.resolve(outDir);
	const result = await runSidecar(python, flags, ['--hyper', path.resolve(hyperFile), '--out', absOut], { timeoutMs });
	if (result.code !== 0 || !result.json || result.json.error) {
		throw new Error(`Hyper export failed for ${path.basename(hyperFile)}: ${failureMessage(result)}`);
	}
	const tables = Array.isArray(result.json.tables) ? result.json.tables : [];
	for (const table of tables) {
		const file = path.resolve(absOut, table.file);
		if (path.relative(absOut, file).startsWith('..')) {
			throw new Error(`Hyper sidecar wrote outside the output directory: ${table.file}`);
		}
		table.file = file;
		table.rowCount = Number(table.rowCount) || 0;
		table.columns = Array.isArray(table.columns) ? table.columns : [];
	}
	return { tables, hyperApiVersion: result.json.hyperApiVersion };
}
