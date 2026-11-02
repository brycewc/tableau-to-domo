import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { createDomoClient, instanceHost } from '../../src/domo/client.js';
import { whoAmI, probeCapabilities } from '../../src/domo/probe.js';

let mock;
afterEach(() => mock?.restore());

test('instanceHost normalizes instance forms', () => {
	assert.equal(instanceHost('acme'), 'acme.domo.com');
	assert.equal(instanceHost('acme.domo.com'), 'acme.domo.com');
	assert.equal(instanceHost('https://acme.domo.com/'), 'acme.domo.com');
});

test('createDomoClient requires credentials', () => {
	assert.throws(() => createDomoClient({ instance: 'a' }), /accessToken/);
	assert.throws(() => createDomoClient({ accessToken: 't' }), /instance/);
});

test('client builds URLs with query strings, headers, and raw bodies', async () => {
	const { client } = testClient();
	assert.equal(client.baseUrl, 'https://acme.domo.com/api');
	mock = mockFetch([
		{ method: 'GET', path: '/x/y', json: { ok: 1 } },
		{ method: 'PUT', path: '/raw', text: 'done' }
	]);
	assert.deepEqual(await client.get('/x/y', { query: { a: 1, b: undefined, c: 'z w' } }), { ok: 1 });
	assert.equal(mock.calls[0].url, 'https://acme.domo.com/api/x/y?a=1&c=z+w');
	assert.equal(await client.request('PUT', '/raw', { body: 'a,b', headers: { 'Content-Type': 'text/csv' }, responseType: 'text' }), 'done');
	assert.equal(mock.calls[1].headers['Content-Type'], 'text/csv');
	assert.equal(mock.calls[1].headers['X-DOMO-Developer-Token'], 'tok');
	assert.equal(mock.calls[1].body, 'a,b');
});

test('client sends Accept-Language by default and lets callers override it', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'GET', path: '/content/v4/pages/1/layouts', json: {}, repeat: true }]);
	await client.get('/content/v4/pages/1/layouts');
	await client.get('/content/v4/pages/1/layouts', { headers: { 'Accept-Language': 'fr-FR' } });
	assert.equal(mock.calls[0].headers['Accept-Language'], 'en-US');
	assert.equal(mock.calls[1].headers['Accept-Language'], 'fr-FR');
});

test('client politeness delay spaces requests', async () => {
	const client = createDomoClient({ instance: 'acme', accessToken: 't' }, { delayMs: 30 });
	mock = mockFetch([{ method: 'GET', path: '/a', json: {}, repeat: true }]);
	const start = Date.now();
	await client.get('/a');
	await client.get('/a');
	await client.get('/a');
	assert.ok(Date.now() - start >= 55);
});

test('whoAmI reads /content/v2/users/me', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'GET', path: '/content/v2/users/me', json: { id: 7, displayName: 'Me' } }]);
	assert.equal((await whoAmI(client)).id, 7);
});

test('probeCapabilities validates basic, FIXED and window expressions on a numeric column', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/query/v1/datasources/ds-1/schema/indexed', json: { tables: [{ columns: [{ name: 'Region', type: 'STRING' }, { name: 'Sales', type: 'DOUBLE' }] }] } },
		{
			method: 'POST',
			path: '/query/v1/functions/validateFunctions',
			json: { results: { '-1': { status: 'VALID' }, '-2': { status: 'INVALID' }, '-3': { status: 'VALID' } } }
		},
		{ method: 'POST', path: '/query/v1/execute/ds-1', json: { rows: [['East', 10]] } }
	]);
	const caps = await probeCapabilities(client, { datasetId: 'ds-1' });
	assert.deepEqual(jsonBody(mock.calls[1]).functionTemplates, {
		'-1': { name: 't2d probe basic', expression: 'SUM(`Sales`)' },
		'-2': { name: 't2d probe fixed', expression: 'SUM(SUM(`Sales`) FIXED ())' },
		'-3': { name: 't2d probe window', expression: 'SUM(SUM(`Sales`)) OVER ()' }
	});
	assert.equal(jsonBody(mock.calls[2]).sql, 'SELECT `Region`, SUM(SUM(`Sales`)) OVER () AS t2d_probe FROM table GROUP BY `Region` LIMIT 1');
	assert.equal(caps.basic, true);
	assert.equal(caps.fixed, false);
	assert.equal(caps.window, true);
	assert.equal(caps.windowValidated, true);
	assert.equal('nested' in caps, false);
	assert.equal(caps.column, 'Sales');
	assert.equal(caps.messages.fixed, 'INVALID');
	assert.equal(caps.messages.window, 'valid and queried');
});

test('probeCapabilities reports window support from the query when validation overstates it', async () => {
	const schema = { method: 'GET', path: '/query/v1/datasources/ds-1/schema/indexed', json: { tables: [{ columns: [{ name: 'Region', type: 'STRING' }, { name: 'Sales', type: 'DOUBLE' }] }] } };
	const validate = { method: 'POST', path: '/query/v1/functions/validateFunctions', json: { results: { '-1': { status: 'VALID' }, '-2': { status: 'VALID' }, '-3': { status: 'VALID' } } } };
	const { client } = testClient();
	mock = mockFetch([schema, validate, { method: 'POST', path: '/query/v1/execute/ds-1', status: 400, json: { errorCode: 'ib:4201', status: 400, message: 'Not a valid analytic function' } }]);
	let caps = await probeCapabilities(client, { datasetId: 'ds-1' });
	assert.equal(caps.window, false);
	assert.equal(caps.windowValidated, true);
	assert.match(caps.messages.window, /validates, but the query fails: Not a valid analytic function/);
	mock.restore();

	mock = mockFetch([schema, validate, { method: 'POST', path: '/query/v1/execute/ds-1', status: 403, json: { message: 'Forbidden' } }]);
	caps = await probeCapabilities(client, { datasetId: 'ds-1' });
	assert.equal(caps.window, null);
	assert.match(caps.messages.window, /could not run: Forbidden/);
});

test('probeCapabilities with no columns returns nulls', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'GET', path: '/query/v1/datasources/ds-1/schema/indexed', json: { tables: [] } }]);
	const caps = await probeCapabilities(client, { datasetId: 'ds-1' });
	assert.equal(caps.fixed, null);
	assert.match(caps.messages.fixed, /no indexed columns/);
});
