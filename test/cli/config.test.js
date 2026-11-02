import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadConfig } from '../../src/config.js';

const KEYS = ['DOMO_INSTANCE', 'DOMO_ACCESS_TOKEN', 'TABLEAU_SERVER', 'TABLEAU_PAT_SECRET'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function dir(files) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-config-'));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
	return d;
}

test('--env file wins over the shell so instance and token come from one environment', () => {
	for (const k of KEYS) delete process.env[k];
	const cwd = dir({ '.env': 'DOMO_INSTANCE=dev\nDOMO_ACCESS_TOKEN=a\n', '.env.prod': 'DOMO_INSTANCE=prod\nDOMO_ACCESS_TOKEN=b\n' });
	process.env.DOMO_INSTANCE = 'sandbox';
	const config = loadConfig({ env: 'prod', cwd });
	assert.deepEqual(config.domo, { instance: 'prod', accessToken: 'b' });
});

test('an instance and a token from different environments are rejected', () => {
	for (const k of KEYS) delete process.env[k];
	const cwd = dir({ '.env': 'DOMO_INSTANCE=dev\nDOMO_ACCESS_TOKEN=a\n' });
	process.env.DOMO_INSTANCE = 'sandbox';
	assert.throws(() => loadConfig({ cwd }), /DOMO_INSTANCE comes from the shell environment but DOMO_ACCESS_TOKEN comes from \.env/);
	process.env.DOMO_ACCESS_TOKEN = 'tok';
	assert.deepEqual(loadConfig({ cwd }).domo, { instance: 'sandbox', accessToken: 'tok' });
});

test('T2D_PYTHON with a separator resolves against cwd and marks the interpreter explicit', () => {
	const saved = process.env.T2D_PYTHON;
	delete process.env.T2D_PYTHON;
	try {
		const cwd = dir({ '.env': 'T2D_PYTHON=.venv/bin/python\n' });
		const config = loadConfig({ cwd });
		assert.equal(config.python, path.join(cwd, '.venv', 'bin', 'python'));
		assert.equal(config.pythonExplicit, true);
		const fallback = loadConfig({ cwd: dir({}) });
		assert.equal(fallback.python, 'python3');
		assert.equal(fallback.pythonExplicit, false);
	} finally {
		if (saved !== undefined) process.env.T2D_PYTHON = saved;
	}
});
