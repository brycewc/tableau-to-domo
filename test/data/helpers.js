import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 't2d-data-') {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Write an executable stand-in for the Python interpreter. It receives the same
 * argv as python would (flags, script path, sidecar args) and runs `body` as Node.
 */
export function makeFakePython(dir, body) {
	const file = path.join(dir, `fake-python-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(
		file,
		`#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst argv = process.argv.slice(2);\nconst arg = (name) => argv[argv.indexOf(name) + 1];\n${body}\n`
	);
	fs.chmodSync(file, 0o755);
	return file;
}

/** Fake python that passes --check and exports the given tables (rows as CSV text). */
export function fakeHyperPython(dir, tables, { version = '0.0.99999' } = {}) {
	return makeFakePython(
		dir,
		`const tables = ${JSON.stringify(tables)};
if (argv.includes('--check')) { console.log(JSON.stringify({ ok: true, version: ${JSON.stringify(version)} })); process.exit(0); }
const out = arg('--out');
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(arg('--hyper'))) { console.log(JSON.stringify({ error: 'missing hyper' })); process.exit(1); }
const manifest = { hyperApiVersion: ${JSON.stringify(version)}, tables: [] };
tables.forEach((t, i) => {
	const file = path.join(out, i + '.csv');
	fs.writeFileSync(file, t.csv);
	manifest.tables.push({ schema: t.schema, name: t.name, file, rowCount: t.rowCount, columns: t.columns });
});
console.log('noise from library');
console.log(JSON.stringify(manifest));`
	);
}
