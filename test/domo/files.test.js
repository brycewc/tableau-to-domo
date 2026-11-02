import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { deleteDataFile, downloadDataFile, fileMime, getDataFileDetails, uploadDataFile, uploadDataFileVersion } from '../../src/domo/files.js';
import { createDocumentCard, getCardSummaries, updateDocumentCard } from '../../src/domo/cards.js';

let mock;
afterEach(() => mock?.restore());

test('uploadDataFile posts the bytes as multipart field "file" with the name and type; a version is a PUT to the file', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/data/v1/data-files', json: { dataFileId: 41 } },
		{ method: 'PUT', path: '/data/v1/data-files/41', json: { revisionId: 7 } }
	]);
	assert.deepEqual(await uploadDataFile(client, Buffer.from('png!'), 'banner.png'), { id: 41 });
	await uploadDataFileVersion(client, 41, Buffer.from('png2'), 'banner.png');
	for (const call of mock.calls) {
		assert.ok(call.body instanceof FormData);
		const file = call.body.get('file');
		assert.deepEqual([file.name, file.type, await file.text()], ['banner.png', 'image/png', call.method === 'POST' ? 'png!' : 'png2']);
		assert.equal(Object.keys(call.headers).some((h) => /content-type/i.test(h)), false, 'fetch sets the multipart boundary');
	}
	assert.equal(fileMime('A.JPG'), 'image/jpeg');
});

test('getDataFileDetails is undefined for a deleted file; deleteDataFile is false when it is gone', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/data/v1/data-files/1/details', json: { id: 1, currentRevision: { md5Hash: 'AB' } } },
		{ method: 'GET', path: '/data/v1/data-files/2/details', json: { id: 2, revisions: [] } },
		{ method: 'GET', path: '/data/v1/data-files/3/details', status: 400, json: {} },
		{ method: 'DELETE', path: '/data/v1/data-files/1', json: {} },
		{ method: 'DELETE', path: '/data/v1/data-files/3', status: 400, json: {} }
	]);
	assert.equal((await getDataFileDetails(client, 1)).currentRevision.md5Hash, 'AB');
	assert.equal(await getDataFileDetails(client, 2), undefined);
	assert.equal(await getDataFileDetails(client, 3), undefined);
	assert.equal(await deleteDataFile(client, 1), true);
	assert.equal(await deleteDataFile(client, 3), false);
});

test('createDocumentCard posts the document card the editor makes, on the page; updateDocumentCard points it at another file', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/content/v1/cards', json: { id: 90, urn: '90' } },
		{ method: 'PUT', path: '/content/v1/cards/90', json: { id: 90 } }
	]);
	assert.deepEqual(await createDocumentCard(client, { name: 'banner.png', dataFileId: 41, pageId: 5 }), { id: 90 });
	await updateDocumentCard(client, 90, { name: 'banner.png', dataFileId: 42 });
	const [create, update] = mock.calls;
	assert.deepEqual(create.query, { pageId: '5' });
	assert.deepEqual(jsonBody(create), { type: 'document', description: 'banner.png', metadata: { title: 'banner.png', documentId: '41:undefined', usingSampleData: '', kpiType: 'document', description: 'banner.png' } });
	assert.equal(jsonBody(update).metadata.documentId, '42:undefined');
});

test('downloadDataFile reads the bytes; getCardSummaries asks for the cards\' metadata by urn', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/data/v1/data-files/3023', text: 'GIF89a' },
		{ method: 'GET', path: '/content/v1/cards', json: [{ id: 762, type: 'document', metadata: { documentId: '3023:undefined' } }] }
	]);
	assert.equal((await downloadDataFile(client, 3023)).toString(), 'GIF89a');
	assert.deepEqual((await getCardSummaries(client, [762, '9'])).map((x) => x.id), [762]);
	assert.deepEqual(mock.calls[1].query, { urns: '762,9', parts: 'metadata' });
	assert.deepEqual(await getCardSummaries(client, []), []);
});
