import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { variableNameTaken } from '../../src/domo/variables.js';

let mock;
afterEach(() => mock?.restore());

test('variableNameTaken searches variables only and matches the name case-insensitively', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/query/v1/functions/search', json: { results: [{ id: 5, name: 'Day', global: true }] }, repeat: true }]);
	assert.equal(await variableNameTaken(client, 'day'), true);
	assert.deepEqual(jsonBody(mock.calls[0]).filters, [{ field: 'variable', value: ['true'], not: false }]);
	assert.equal(await variableNameTaken(client, 'Days'), false);
});
