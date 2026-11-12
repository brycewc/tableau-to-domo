import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { findPageStubs } from '../../src/domo/search.js';

let mock;
afterEach(() => mock?.restore());

test('findPageStubs queries each page id once and returns only title-less page entries', async () => {
	const { client } = testClient();
	const entries = {
		7: [{ entityType: 'page', databaseId: '7', owners: [], lastModified: 0 }],
		8: [{ entityType: 'page', databaseId: '8', title: 'Sales' }],
		9: []
	};
	mock = mockFetch([{ method: 'POST', path: '/search/v1/query', repeat: true, handler: (call) => ({ json: { searchObjects: entries[jsonBody(call).filters[0].value] } }) }]);
	const stubs = await findPageStubs(client, [7, '8', 9, '7']);
	assert.deepEqual(stubs.map((s) => s.id), ['7']);
	assert.equal(mock.calls.length, 3);
	assert.deepEqual(jsonBody(mock.calls[0]), { query: '*', entities: ['page'], count: 5, filters: [{ field: 'database_id', value: '7', filterType: 'term' }] });
});
