import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkHyper, exportHyper, HYPER_SCRIPT, resolvePythonPath, detectPython } from '../../src/tableau/data/hyper.js';
import { tempDir, makeFakePython, fakeHyperPython } from './helpers.js';

test('checkHyper passes -I and the sidecar script, and reports the version', async () => {
	const dir = tempDir();
	const log = path.join(dir, 'argv.json');
	const python = makeFakePython(
		dir,
		`fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(argv)); console.log(JSON.stringify({ ok: true, version: '0.0.21200' }));`
	);
	assert.deepEqual(await checkHyper(python), { ok: true, version: '0.0.21200' });
	assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), ['-I', HYPER_SCRIPT, '--check']);
});

test('checkHyper explains how to install tableauhyperapi when missing', async () => {
	const dir = tempDir();
	const python = makeFakePython(
		dir,
		`console.log(JSON.stringify({ error: "No module named 'tableauhyperapi'", code: 'missing-module' })); process.exit(3);`
	);
	const result = await checkHyper(python);
	assert.equal(result.ok, false);
	assert.match(result.error, /pip install tableauhyperapi/);
});

test('checkHyper retries without -I so a user-site install is found', async () => {
	const dir = tempDir();
	const python = makeFakePython(
		dir,
		`if (argv[0] === '-I') { console.log(JSON.stringify({ error: 'x', code: 'missing-module' })); process.exit(3); }
console.log(JSON.stringify({ ok: true, version: '1' }));`
	);
	assert.deepEqual(await checkHyper(python), { ok: true, version: '1' });
});

test('checkHyper reports a missing interpreter', async () => {
	const result = await checkHyper('/nonexistent/python-t2d');
	assert.equal(result.ok, false);
	assert.match(result.error, /not found/);
});

test('checkHyper surfaces stderr for other failures', async () => {
	const dir = tempDir();
	const python = makeFakePython(dir, `console.error('Traceback: boom'); process.exit(1);`);
	const result = await checkHyper(python);
	assert.equal(result.ok, false);
	assert.match(result.error, /boom/);
});

test('exportHyper parses the manifest from the last JSON line', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, [
		{ schema: 'Extract', name: 'Extract', rowCount: 1, csv: 'a\n1\n', columns: [{ name: 'a', type: 'BIGINT', nullable: true }] }
	]);
	const hyperFile = path.join(dir, 'x.hyper');
	fs.writeFileSync(hyperFile, 'fake');
	const result = await exportHyper({ python, hyperFile, outDir: path.join(dir, 'out') });
	assert.equal(result.hyperApiVersion, '0.0.99999');
	assert.equal(result.tables.length, 1);
	assert.equal(result.tables[0].file, path.join(dir, 'out', '0.csv'));
	assert.equal(result.tables[0].rowCount, 1);
});

test('exportHyper throws the sidecar error', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, []);
	await assert.rejects(
		exportHyper({ python, hyperFile: path.join(dir, 'missing.hyper'), outDir: path.join(dir, 'out') }),
		/missing hyper/
	);
});

test('exportHyper rejects files outside the output directory', async () => {
	const dir = tempDir();
	const python = makeFakePython(
		dir,
		`console.log(JSON.stringify({ tables: [{ schema: 's', name: 'n', file: '/etc/passwd', rowCount: 0, columns: [] }] }));`
	);
	await assert.rejects(exportHyper({ python, hyperFile: path.join(dir, 'x.hyper'), outDir: path.join(dir, 'out') }), /outside/);
});

test('exportHyper times out', async () => {
	const dir = tempDir();
	const python = makeFakePython(dir, `setTimeout(() => {}, 10000);`);
	await assert.rejects(
		exportHyper({ python, hyperFile: path.join(dir, 'x.hyper'), outDir: path.join(dir, 'out'), timeoutMs: 300 }),
		/timed out/
	);
});

test('resolvePythonPath makes relative interpreter paths absolute and leaves bare commands alone', () => {
	assert.equal(resolvePythonPath('.venv/bin/python', '/proj'), path.resolve('/proj', '.venv/bin/python'));
	assert.equal(resolvePythonPath('python3', '/proj'), 'python3');
	assert.equal(resolvePythonPath('/usr/bin/python3', '/proj'), '/usr/bin/python3');
});

test('exportHyper runs a relative interpreter path from another cwd', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, [{ schema: 'Extract', name: 'Extract', rowCount: 0, columns: [], csv: '' }]);
	const relative = path.relative(process.cwd(), python);
	assert.ok(/[\\/]/.test(relative));
	const hyperFile = path.join(dir, 'x.hyper');
	fs.writeFileSync(hyperFile, 'h');
	const result = await exportHyper({ python: relative, hyperFile, outDir: path.join(dir, 'out') });
	assert.equal(result.tables.length, 1);
});

test('detectPython falls back to a project virtualenv that has tableauhyperapi', async () => {
	const dir = tempDir();
	const venv = path.join(dir, '.venv', 'bin');
	fs.mkdirSync(venv, { recursive: true });
	fs.writeFileSync(path.join(venv, 'python'), '');
	const seen = [];
	const check = async (python) => {
		seen.push(python);
		return python.includes('.venv') ? { ok: true, version: '1' } : { ok: false, error: 'missing' };
	};
	const found = await detectPython({ python: 'python3', cwd: dir, check });
	assert.equal(found.python, path.join(dir, '.venv', 'bin', 'python'));
	assert.equal(found.detected, true);
	assert.equal(seen[0], 'python3');

	const explicit = await detectPython({ python: 'python3', explicit: true, cwd: dir, check });
	assert.equal(explicit.ok, false);
	assert.equal(explicit.python, 'python3');
});
