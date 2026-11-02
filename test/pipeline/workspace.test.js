import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getEntry, loadState, saveState, setEntry } from '../../src/pipeline/state.js';
import { openWorkspace, readJson, writeJson } from '../../src/pipeline/workspace.js';
import { tempDir } from './helpers.js';

test('writeJson/readJson round trip atomically, no temp files left', async () => {
	const dir = tempDir();
	const file = path.join(dir, 'a', 'b.json');
	await writeJson(file, { x: 1, s: 'é' });
	assert.deepEqual(await readJson(file), { x: 1, s: 'é' });
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ['b.json']);
	assert.equal(await readJson(path.join(dir, 'missing.json'), null), null);
	await assert.rejects(readJson(path.join(dir, 'missing.json')), /ENOENT/);
});

test('readJson reports invalid JSON with the file name', async () => {
	const dir = tempDir();
	const file = path.join(dir, 'bad.json');
	fs.writeFileSync(file, '{nope');
	await assert.rejects(readJson(file), /Invalid JSON in .*bad\.json/);
});

test('workspace paths follow the documented layout', () => {
	const ws = openWorkspace('/srv/t2d-root');
	const p = ws.paths('sales');
	assert.equal(p.dir, path.join('/srv/t2d-root', 'workbooks', 'sales'));
	assert.equal(p.source('twbx'), path.join(p.dir, 'source.twbx'));
	assert.equal(p.twb, path.join(p.dir, 'workbook.twb'));
	assert.equal(p.ir, path.join(p.dir, 'ir.json'));
	assert.equal(p.manifest('orders'), path.join(p.dir, 'data', 'orders.manifest.json'));
	assert.equal(p.datasourceDataDir('orders'), path.join(p.dir, 'data', 'orders'));
	assert.equal(p.plan, path.join(p.dir, 'plan.json'));
	assert.equal(p.report, path.join(p.dir, 'report.md'));
	assert.equal(p.pushLog, path.join(p.dir, 'push-log.json'));
	assert.equal(ws.stateFile('acme'), path.join('/srv/t2d-root', 'state', 'acme.json'));
	assert.equal(ws.mappingsFile, path.join('/srv/t2d-root', 'mappings.json'));
	assert.equal(ws.relative(path.join(p.dir, 'data', 'x.csv')), 'workbooks/sales/data/x.csv');
});

test('mappings template is created once and normalized on load', async () => {
	const ws = openWorkspace(tempDir());
	assert.deepEqual(await ws.loadMappings(), { datasets: {}, accounts: [], cloudAmplifier: [], columns: {}, unmapped: {} });
	assert.equal(await ws.ensureMappings(), true);
	assert.deepEqual(JSON.parse(fs.readFileSync(ws.mappingsFile, 'utf8')), { datasets: {}, accounts: [], cloudAmplifier: [], columns: {} });
	fs.writeFileSync(ws.mappingsFile, JSON.stringify({ datasets: { Orders: 'abc' } }));
	assert.equal(await ws.ensureMappings(), false);
	assert.deepEqual(await ws.loadMappings(), { datasets: { Orders: 'abc' }, accounts: [], cloudAmplifier: [], columns: {}, unmapped: {} });
});

test('listWorkbooks, readManifests and resolveSlug', async () => {
	const ws = openWorkspace(tempDir());
	assert.deepEqual(await ws.listWorkbooks(), []);
	const p = ws.paths('sales');
	await ws.writeJson(p.metadata, { workbook: { name: 'Sales Dash', luid: 'luid-1' }, source: 'server' });
	await ws.writeJson(p.ir, { irVersion: 1 });
	await ws.writeJson(p.manifest('b'), { datasourceId: 'b' });
	await ws.writeJson(p.manifest('a'), { datasourceId: 'a' });
	const list = await ws.listWorkbooks();
	assert.equal(list.length, 1);
	assert.equal(list[0].name, 'Sales Dash');
	assert.equal(list[0].hasIr, true);
	assert.equal(list[0].hasPlan, false);
	assert.deepEqual((await ws.readManifests('sales')).map((m) => m.datasourceId), ['a', 'b']);
	assert.equal(await ws.resolveSlug('sales'), 'sales');
	assert.equal(await ws.resolveSlug('Sales Dash'), 'sales');
	assert.equal(await ws.resolveSlug('luid-1'), 'sales');
	assert.equal(await ws.resolveSlug('SALES'), 'sales', 'a case-insensitive file system does not turn SALES into a slug of its own');
	await assert.rejects(ws.resolveSlug('nothing'), /No extracted workbook/);
});

test('state round trip with getEntry/setEntry', async () => {
	const ws = openWorkspace(tempDir());
	const state = await loadState(ws, 'acme');
	assert.deepEqual(state, { instance: 'acme', objects: {} });
	setEntry(state, 'dataset:orders', { id: 'ds-1', extra: { schemaHash: 'h1' } });
	setEntry(state, { $ref: 'dataset:orders' }, { extra: { dataHash: 'd1' } });
	await saveState(ws, state);
	const again = await loadState(ws, 'acme');
	const entry = getEntry(again, { $ref: 'dataset:orders' });
	assert.equal(entry.id, 'ds-1');
	assert.deepEqual(entry.extra, { schemaHash: 'h1', dataHash: 'd1' });
	assert.match(entry.updatedAt, /^\d{4}-/);
	assert.equal(getEntry(again, 'card:x'), undefined);
});

test('loadState refuses a state file from another instance', async () => {
	const ws = openWorkspace(tempDir());
	await ws.writeJson(ws.stateFile('acme'), { instance: 'other', objects: {} });
	await assert.rejects(loadState(ws, 'acme'), /belongs to instance "other"/);
});
