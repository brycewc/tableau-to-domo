import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPackage, assertSafeEntryName } from '../../src/tableau/package.js';
import { makeZip } from './helpers/zip.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const WB = "<?xml version='1.0' encoding='utf-8' ?>\n<workbook version='18.1'><datasources /></workbook>";
const DS = "<?xml version='1.0' encoding='utf-8' ?>\n<datasource name='x' version='18.1' />";

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 't2d-pkg-'));
}

function writeZip(dir, name, entries) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, makeZip(entries));
	return file;
}

test('opens a plain .twb and reports kind twb', async () => {
	const pkg = await openPackage(path.join(FIXTURES, 'superstore.twb'));
	assert.equal(pkg.kind, 'twb');
	assert.equal(pkg.xmlEntry, 'superstore.twb');
	assert.deepEqual(pkg.entries, []);
	assert.match(pkg.xml, /<workbook /);
	await assert.rejects(pkg.extractEntry('x', '/srv/x'), /not a packaged file/);
	pkg.close();
});

test('opens the superstore .twbx, finds the root workbook and extracts the hyper file', async () => {
	const pkg = await openPackage(path.join(FIXTURES, 'superstore.twbx'));
	try {
		assert.equal(pkg.kind, 'twbx');
		assert.equal(pkg.xmlEntry, 'superstore.twb');
		assert.ok(pkg.entries.includes('Data/Extracts/superstore.hyper'));
		assert.equal(pkg.findEntry('Data\\Extracts\\superstore.hyper'), 'Data/Extracts/superstore.hyper');
		assert.equal(pkg.findEntry('C:/Data/My Tableau Repository/Datasources/superstore.hyper'), 'Data/Extracts/superstore.hyper');
		const dir = tmp();
		const out = await pkg.extractEntry('Data/Extracts/superstore.hyper', path.join(dir, 'a', 'x.hyper'));
		assert.equal(out.file, path.join(dir, 'a', 'x.hyper'));
		assert.equal(out.bytes, fs.statSync(out.file).size);
		const intoDir = await pkg.extractEntry({ name: 'Data/Extracts/superstore.hyper' }, dir + path.sep);
		assert.equal(intoDir.file, path.join(dir, 'Data', 'Extracts', 'superstore.hyper'));
		await assert.rejects(pkg.extractEntry('missing.hyper', dir), /not found/);
	} finally {
		pkg.close();
	}
});

test('detects zips by magic bytes regardless of extension and prefers the shallowest root', async () => {
	const dir = tmp();
	const file = writeZip(dir, 'renamed.twb', [
		{ name: 'nested/other.twb', data: WB },
		{ name: 'TwbxExternalCache/cache.twb', data: WB },
		{ name: 'Book.twb', data: WB }
	]);
	const pkg = await openPackage(file);
	assert.equal(pkg.kind, 'twbx');
	assert.equal(pkg.xmlEntry, 'Book.twb');
	pkg.close();
});

test('skips candidate entries that are not Tableau roots and reports tdsx for datasource roots', async () => {
	const dir = tmp();
	const file = writeZip(dir, 'x.tdsx', [
		{ name: 'a.tds', data: '<?xml version="1.0"?><notTableau />' },
		{ name: 'sub/b.tds', data: DS }
	]);
	const pkg = await openPackage(file);
	assert.equal(pkg.kind, 'tdsx');
	assert.equal(pkg.xmlEntry, 'sub/b.tds');
	pkg.close();
});

test('opens a plain .tds', async () => {
	const pkg = await openPackage(path.join(FIXTURES, 'external', 'datasource_test.tds'));
	assert.equal(pkg.kind, 'tds');
	pkg.close();
});

test('rejects zips without a workbook', async () => {
	await assert.rejects(openPackage(path.join(FIXTURES, 'external', 'BadZip.zip')), /no \.twb or \.tds/);
});

test('rejects DOCTYPE and ENTITY declarations', async () => {
	const dir = tmp();
	const plain = path.join(dir, 'evil.twb');
	fs.writeFileSync(plain, "<?xml version='1.0'?><!DOCTYPE w [<!ENTITY a 'b'>]><workbook />");
	await assert.rejects(openPackage(plain), /DOCTYPE/);
	const zipped = writeZip(dir, 'evil.twbx', [{ name: 'evil.twb', data: "<!DOCTYPE workbook><workbook />" }]);
	await assert.rejects(openPackage(zipped), /DOCTYPE/);
});

test('rejects entries whose compression ratio exceeds 200', async () => {
	const dir = tmp();
	const bomb = writeZip(dir, 'bomb.twbx', [{ name: 'Book.twb', data: WB + ' '.repeat(5 * 1024 * 1024) }]);
	await assert.rejects(openPackage(bomb), /compression ratio/);
	const ok = writeZip(dir, 'ok.twbx', [
		{ name: 'Book.twb', data: WB },
		{ name: 'Data/big.hyper', data: Buffer.alloc(2 * 1024 * 1024) }
	]);
	const pkg = await openPackage(ok);
	await assert.rejects(pkg.extractEntry('Data/big.hyper', path.join(dir, 'big.hyper')), /compression ratio/);
	pkg.close();
});

test('rejects path traversal in zip entry names', async () => {
	const dir = tmp();
	const file = writeZip(dir, 'trav.twbx', [
		{ name: 'Book.twb', data: WB },
		{ name: '../../escape.txt', data: 'x' }
	]);
	await assert.rejects(openPackage(file), /Unsafe|invalid relative path/i);
	assert.throws(() => assertSafeEntryName('../x'), /Unsafe/);
	assert.throws(() => assertSafeEntryName('/etc/passwd'), /Unsafe/);
	assert.throws(() => assertSafeEntryName('C:/x'), /Unsafe/);
	assert.doesNotThrow(() => assertSafeEntryName('Data/Extracts/a.hyper'));
});

test('rejects plain XML that is not a Tableau root', async () => {
	const dir = tmp();
	const file = path.join(dir, 'x.twb');
	fs.writeFileSync(file, '<html />');
	await assert.rejects(openPackage(file), /not a Tableau workbook/);
});

test('opens the document-api packaged fixtures, ignoring cache entries', async () => {
	const cache = await openPackage(path.join(FIXTURES, 'external', 'Cache.twbx'));
	assert.equal(cache.xmlEntry, 'Superstore.twb');
	assert.equal(cache.findEntry('Data/en_US-US/Sales Target.tde'), 'Data/en_US-US/Sales Target.tde');
	cache.close();
	const tdsx = await openPackage(path.join(FIXTURES, 'external', 'TABLEAU_10_TDSX.tdsx'));
	assert.equal(tdsx.kind, 'tdsx');
	tdsx.close();
});
