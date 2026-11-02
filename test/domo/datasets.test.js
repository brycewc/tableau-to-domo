import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { createDataset, updateSchema, getDataset, getIndexedSchema, indexedColumns, splitCsvParts, uploadCsv, waitForIndex, waitForReadable } from '../../src/domo/datasets.js';

let mock;
afterEach(() => mock?.restore());

function tmpCsv(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-domo-'));
	const file = path.join(dir, 'data.csv');
	fs.writeFileSync(file, content);
	return file;
}

async function collect(file, opts) {
	const parts = [];
	for await (const part of splitCsvParts(file, opts)) parts.push({ ...part, text: part.data.toString('utf8') });
	return parts;
}

test('createDataset posts the v2 body and returns dataSource.dataSourceId', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/data/v2/datasources', json: { metaData: {}, dataSource: { dataSourceId: 'ds-1' } } }]);
	const id = await createDataset(client, { name: 'Orders', description: 'd', schema: [{ name: 'Region', type: 'STRING' }, { name: 'Sales', type: 'DOUBLE' }] });
	assert.equal(id, 'ds-1');
	const [call] = mock.calls;
	assert.equal(call.url, 'https://acme.domo.com/api/data/v2/datasources');
	assert.equal(call.headers['X-DOMO-Developer-Token'], 'tok');
	assert.equal(call.headers.Accept, 'application/json');
	assert.equal(call.headers['Content-Type'], 'application/json');
	assert.deepEqual(jsonBody(call), {
		dataSourceName: 'Orders',
		dataSourceDescription: 'd',
		dataSourceType: 'API',
		dataProviderType: 'api',
		schema: { columns: [{ type: 'STRING', name: 'Region' }, { type: 'DOUBLE', name: 'Sales' }] }
	});
});

test('createDataset falls back to /data/v1/streams on 403', async () => {
	const { client, events } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/data/v2/datasources', status: 403, text: 'forbidden' },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 7, dataSource: { id: 'ds-2' } } }
	]);
	const id = await createDataset(client, { name: 'X', schema: { columns: [{ name: 'A', type: 'LONG' }] } });
	assert.equal(id, 'ds-2');
	assert.deepEqual(jsonBody(mock.calls[1]), {
		dataProvider: { key: 'domo' },
		transport: { type: 'API' },
		dataSource: { name: 'X', description: '' },
		updateMethod: 'REPLACE',
		schemaDefinition: { columns: [{ type: 'LONG', name: 'A' }] }
	});
	assert.ok(events.some((e) => e.type === 'warn'));
});

test('createDataset rethrows non-fallback errors', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/data/v2/datasources', status: 400, text: 'bad schema' }]);
	await assert.rejects(createDataset(client, { name: 'X', schema: [] }), /HTTP 400/);
});

test('updateSchema, getDataset and getIndexedSchema hit the verified paths', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/data/v2/datasources/ds-1/schemas', json: {} },
		{ method: 'GET', path: '/data/v3/datasources/ds-1', json: { id: 'ds-1' } },
		{ method: 'GET', path: '/query/v1/datasources/ds-1/schema/indexed', json: { tables: [{ columns: [{ name: 'A', type: 'LONG' }] }] } }
	]);
	await updateSchema(client, 'ds-1', [{ name: 'A', type: 'LONG' }]);
	assert.deepEqual(jsonBody(mock.calls[0]), { columns: [{ type: 'LONG', name: 'A' }] });
	assert.equal((await getDataset(client, 'ds-1')).id, 'ds-1');
	const schema = await getIndexedSchema(client, 'ds-1');
	assert.deepEqual(indexedColumns(schema), [{ name: 'A', type: 'LONG' }]);
});

test('waitForReadable polls until the indexed schema has the expected columns and the dataset has a data version', async () => {
	const schema = (...names) => ({ json: { tables: [{ columns: names.map((name) => ({ name, type: 'STRING' })) }] } });
	const indexed = { method: 'GET', path: '/query/v1/datasources/v-1/schema/indexed' };
	const meta = { method: 'GET', path: '/data/v3/datasources/v-1' };
	const mock = mockFetch([
		{ ...indexed, status: 404, json: {} },
		{ ...indexed, json: { tables: [] } },
		{ ...indexed, ...schema('OLD') },
		{ ...indexed, ...schema('ID', 'N') },
		{ ...meta, json: { id: 'v-1', status: 'ACTIVE', rowCount: 0 } },
		{ ...indexed, ...schema('ID', 'N') },
		{ ...meta, json: { id: 'v-1', status: 'SUCCESS', lastUpdated: 1792695752219 } }
	]);
	try {
		const { client } = testClient();
		const columns = await waitForReadable(client, 'v-1', { columns: ['ID', 'N'], intervalMs: 1 });
		assert.deepEqual(columns.map((c) => c.name), ['ID', 'N']);
		assert.equal(mock.calls.length, 7);
	} finally {
		mock.restore();
	}
});

test('splitCsvParts keeps quoted newlines inside one row and puts the header only in part 1', async () => {
	const file = tmpCsv('a,b\n1,"x\ny"\n2,"he said ""hi""\n,ok"\n3,z\n4,w\n');
	const parts = await collect(file, { partRows: 2 });
	assert.equal(parts.length, 2);
	assert.equal(parts[0].text, 'a,b\n1,"x\ny"\n2,"he said ""hi""\n,ok"\n');
	assert.equal(parts[0].rows, 2);
	assert.equal(parts[1].text, '3,z\n4,w\n');
	assert.deepEqual(parts.map((p) => p.partNumber), [1, 2]);
});

test('splitCsvParts handles quoted newlines that straddle a stream chunk and a part boundary', async () => {
	const long = 'q'.repeat(1024 * 1024 + 10);
	const file = tmpCsv(`h\n"${long}\nrest"\n"second\nrow"\n`);
	const parts = await collect(file, { partRows: 1 });
	assert.equal(parts.length, 2);
	assert.equal(parts[0].text, `h\n"${long}\nrest"\n`);
	assert.equal(parts[1].text, '"second\nrow"\n');
});

test('splitCsvParts header modes, BOM, missing trailing newline, CRLF and byte limit', async () => {
	const file = tmpCsv('﻿a,b\r\n1,2\r\n3,4\r\n5,6');
	const all = await collect(file, { partRows: 2, header: 'all' });
	assert.deepEqual(all.map((p) => p.text), ['a,b\r\n1,2\r\n3,4\r\n', 'a,b\r\n5,6\n']);
	const none = await collect(file, { partRows: 10, header: 'none' });
	assert.deepEqual(none.map((p) => p.text), ['1,2\r\n3,4\r\n5,6\n']);
	const bytes = await collect(file, { partBytes: 5 });
	assert.equal(bytes.length, 3);
	assert.ok(bytes[0].text.startsWith('a,b'));
	assert.ok(!bytes[1].text.startsWith('a,b'));
});

test('splitCsvParts keeps empty lines of a one-column CSV as NULL rows and skips them otherwise', async () => {
	const one = await collect(tmpCsv('Region\nEast\n\n\nWest\n'));
	assert.equal(one[0].rows, 4);
	const two = await collect(tmpCsv('"a,x",b\n1,2\n\n3,4\n'));
	assert.equal(two[0].rows, 2);
});

test('splitCsvParts yields one header-only part for an empty table and rejects unterminated quotes', async () => {
	assert.deepEqual((await collect(tmpCsv('a,b\n'))).map((p) => p.text), ['a,b\n']);
	await assert.rejects(collect(tmpCsv('a\n"open\n')), /unterminated/);
});

test('uploadCsv: start, gzip parts, commit with index, poll statuses', async () => {
	const { client } = testClient();
	const file = tmpCsv('a,b\n1,"x\ny"\n2,z\n3,w\n');
	let polls = 0;
	mock = mockFetch([
		{ method: 'POST', path: '/data/v3/datasources/ds-1/uploads', json: { uploadId: 55 } },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/55/parts/1', json: {} },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/55/parts/2', json: {} },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/55/commit', json: { size: { rowCount: 3 }, indexing: { requestKey: 'rk1' } } },
		{
			method: 'GET',
			path: '/data/v3/datasources/ds-1/indexes/rk1/statuses',
			repeat: true,
			handler: () => (++polls < 2 ? { json: { progress: { status: 'PROCESSING' } } } : { json: { progress: { status: 'SUCCESS' }, detail: { rowCount: 3, columnCount: 2 } } })
		}
	]);
	const result = await uploadCsv(client, 'ds-1', file, { partRows: 2, pollIntervalMs: 1 });
	assert.equal(result.rowCount, 3);
	assert.equal(result.parts, 2);
	assert.deepEqual(jsonBody(mock.calls[0]), { action: 'REPLACE', appendId: 'none' });

	const [p1, p2] = [mock.calls[1], mock.calls[2]];
	for (const p of [p1, p2]) {
		assert.equal(p.method, 'PUT');
		assert.equal(p.headers['Content-Type'], 'text/csv');
		assert.equal(p.headers['Content-Encoding'], 'gzip');
		assert.equal(p.headers['X-DOMO-Developer-Token'], 'tok');
		assert.equal(p.body[0], 0x1f);
		assert.equal(p.body[1], 0x8b);
	}
	assert.equal(zlib.gunzipSync(p1.body).toString(), 'a,b\n1,"x\ny"\n2,z\n');
	assert.equal(zlib.gunzipSync(p2.body).toString(), 'a,b\n3,w\n');
	assert.deepEqual(jsonBody(mock.calls[3]), { action: 'REPLACE', index: true, appendId: 'none', message: 'tableau-to-domo' });
	assert.equal(polls, 2);
});

test('uploadCsv without gzip sends plain text and APPEND uses appendId latest', async () => {
	const { client } = testClient();
	const file = tmpCsv('a\n1\n');
	mock = mockFetch([
		{ method: 'POST', path: '/data/v3/datasources/ds-1/uploads', json: { uploadId: 1 } },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/1/parts/1', json: {} },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/1/commit', json: { size: { rowCount: 1 }, indexing: { requestKey: 'k' } } },
		{ method: 'GET', path: '/data/v3/datasources/ds-1/indexes/k/statuses', json: { progress: { status: 'SUCCESS' }, detail: {} } }
	]);
	const result = await uploadCsv(client, 'ds-1', file, { action: 'APPEND', gzip: false, pollIntervalMs: 1 });
	assert.equal(result.rowCount, 1);
	assert.equal(mock.calls[1].body.toString(), 'a\n1\n');
	assert.equal(mock.calls[1].headers['Content-Encoding'], undefined);
	assert.equal(jsonBody(mock.calls[0]).appendId, 'latest');
	assert.equal(jsonBody(mock.calls[2]).action, 'APPEND');
});

test('uploadCsv aborts the upload when a part fails and rethrows', async () => {
	const { client } = testClient();
	const file = tmpCsv('a\n1\n2\n');
	mock = mockFetch([
		{ method: 'POST', path: '/data/v3/datasources/ds-1/uploads', json: { uploadId: 9 } },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/9/parts/1', json: {} },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/9/parts/2', status: 400, text: 'bad part' },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/9/abort', json: {} }
	]);
	await assert.rejects(uploadCsv(client, 'ds-1', file, { partRows: 1 }), /HTTP 400/);
	const last = mock.calls.at(-1);
	assert.equal(last.method, 'PUT');
	assert.equal(last.path, '/data/v3/datasources/ds-1/uploads/9/abort');
	assert.ok(jsonBody(last).message);
	assert.ok(!mock.calls.some((c) => c.path.endsWith('/commit')));
});

test('uploadCsv throws when indexing fails', async () => {
	const { client } = testClient();
	const file = tmpCsv('a\n1\n');
	mock = mockFetch([
		{ method: 'POST', path: '/data/v3/datasources/ds-1/uploads', json: { uploadId: 2 } },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/2/parts/1', json: {} },
		{ method: 'PUT', path: '/data/v3/datasources/ds-1/uploads/2/commit', json: { indexing: { requestKey: 'k' } } },
		{ method: 'GET', path: '/data/v3/datasources/ds-1/indexes/k/statuses', json: { progress: { status: 'ERROR', message: 'bad date' } } }
	]);
	await assert.rejects(uploadCsv(client, 'ds-1', file, { pollIntervalMs: 1 }), /Indexing ds-1 failed \(ERROR\): bad date/);
});

test('waitForIndex treats a 400 right after the commit as not ready yet, then gives up after notReadyMs', async () => {
	const { client } = testClient();
	const notReady = { status: 400, json: { status: 400, message: 'Failed to retrieve index status for ds-1' } };
	let polls = 0;
	mock = mockFetch([
		{ method: 'GET', path: '/data/v3/datasources/ds-1/indexes/k/statuses', repeat: true, handler: () => (++polls < 3 ? notReady : { json: { progress: { status: 'SUCCESS' }, detail: { rowCount: 5 } } }) }
	]);
	assert.deepEqual(await waitForIndex(client, 'ds-1', 'k', { intervalMs: 1 }), { rowCount: 5 });
	assert.equal(polls, 3);
	mock.restore();

	mock = mockFetch([{ method: 'GET', path: '/data/v3/datasources/ds-1/indexes/k/statuses', repeat: true, ...notReady }]);
	await assert.rejects(waitForIndex(client, 'ds-1', 'k', { intervalMs: 1, notReadyMs: 20 }), /HTTP 400/);
});
