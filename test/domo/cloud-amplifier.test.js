import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	compareSnowflakeAccounts,
	dataProviderKeyFor,
	getSnowflakeAccount,
	getObjectColumns,
	isTransientByosError,
	listIntegrations,
	listObjects,
	normalizeHost,
	parseRegistration,
	isWarehouseTableName,
	warehouseTableName,
	parseSnowflakeAccount,
	registerTables,
	resolveSnowflakeAccounts
} from '../../src/domo/cloud-amplifier.js';
import { jsonBody, mockFetch, testClient } from './helpers.js';

test('listIntegrations normalizes engine, names and the host from endpoint or rawURL', async () => {
	const mock = mockFetch([
		{
			method: 'GET',
			path: '/query/v1/byos/accounts',
			json: [
				{ id: 'a', engine: 'SNOWFLAKE', friendlyName: 'Acme', database: 'WAREHOUSE_DB', defaultSchema: 'WB', writeable: true, initialized: true, properties: { AUTH_METHOD: { value: 'KEY_PAIR' } } },
				{ id: 'b', engine: 'SNOWFLAKE', friendlyName: 'POC', properties: { rawURL: { value: 'https://Acme-Org.snowflakecomputing.com/' } } },
				{ id: 'c', engine: 'POSTGRES', friendlyName: 'Lakebase', endpoint: 'instance-1.database.cloud.databricks.com', port: '5432' }
			]
		}
	]);
	try {
		const { client } = testClient();
		const list = await listIntegrations(client);
		assert.deepEqual(list[0], { id: 'a', engine: 'SNOWFLAKE', name: 'Acme', database: 'WAREHOUSE_DB', defaultSchema: 'WB', writeable: true, initialized: true, authMethod: 'KEY_PAIR' });
		assert.equal(list[1].host, 'acme-org.snowflakecomputing.com');
		assert.equal(list[2].host, 'instance-1.database.cloud.databricks.com');
		assert.equal(dataProviderKeyFor(list[0]), 'snowflake');
		assert.equal(dataProviderKeyFor(list[2]), 'lakebase');
		assert.equal(dataProviderKeyFor({ engine: 'BIGQUERY' }), 'google-bigquery');
	} finally {
		mock.restore();
	}
});

test('normalizeHost drops protocol, port, path and case', () => {
	assert.equal(normalizeHost('HTTPS://Acme.snowflakecomputing.com:443/x?y'), 'acme.snowflakecomputing.com');
	assert.equal(normalizeHost(undefined), '');
});

test('listObjects pages through the 500-row pages; getObjectColumns reads tables[].columns', async () => {
	const page0 = Array.from({ length: 500 }, (_, i) => ({ tableName: `T${i}` }));
	const mock = mockFetch([
		{ method: 'GET', path: '/query/v1/byos/accounts/a/databases/DB/schemas/S/objects', handler: (call) => ({ json: call.query.page === '0' ? page0 : [{ tableName: 'LAST', datasource: 'ds-1' }] }), repeat: true },
		{ method: 'GET', path: '/query/v1/byos/accounts/a/databases/DB/schemas/S/objects/LAST', json: { name: 'LAST', tables: [{ columns: [{ name: 'ID', id: 'ID', type: 'LONG', sourceType: 'NUMBER' }] }] } }
	]);
	try {
		const { client } = testClient();
		const objects = await listObjects(client, 'a', 'DB', 'S');
		assert.equal(objects.length, 501);
		assert.equal(mock.calls[0].query.rows, '500');
		assert.deepEqual(await getObjectColumns(client, 'a', 'DB', 'S', 'LAST'), [{ name: 'ID', type: 'LONG', sourceType: 'NUMBER' }]);
	} finally {
		mock.restore();
	}
});

test('isTransientByosError recognizes incidents and cold starts', () => {
	assert.equal(isTransientByosError({ status: 400, body: 'Could not fetch schemas: Snowflake Incident (https://status.snowflake.com)' }), true);
	assert.equal(isTransientByosError({ status: 400, message: 'Unable to fetch warehouses' }), true);
	assert.equal(isTransientByosError({ status: 503 }), true);
	assert.equal(isTransientByosError({ status: 400, body: 'Object does not exist' }), false);
});

test('registerTables handles new and old formats and ALREADY_REGISTERED, and retries cold starts', async () => {
	const tables = [{ databaseName: 'DB', schemaName: 'S', tableName: 'T', dataProviderKey: 'snowflake' }];
	let attempts = 0;
	const mock = mockFetch([
		{ method: 'POST', path: '/data/v1/byos/register/a', json: { summary: { total: 1 }, results: [{ datasource: 'new-id', status: 'SUCCESS' }] } },
		{ method: 'POST', path: '/data/v1/byos/register/a', json: [{ datasource: 'old-id' }] },
		{
			method: 'POST',
			path: '/data/v1/byos/register/a',
			json: { results: [{ status: 'SKIPPED', error: { code: 'ALREADY_REGISTERED', message: 'DB.S.T is already registered as 0a1b2c3d-0000-4000-8000-000000000001' } }] }
		},
		{
			method: 'POST',
			path: '/data/v1/byos/register/b',
			repeat: true,
			handler: () => (++attempts < 3 ? { status: 400, json: { message: 'Unable to fetch warehouses' } } : { json: { results: [{ datasource: 'warm', status: 'SUCCESS' }] } })
		},
		{ method: 'POST', path: '/data/v1/byos/register/c', json: { results: [{ status: 'FAILED', error: { code: 'NOT_FOUND', message: 'no such table' } }] } }
	]);
	try {
		const { client } = testClient();
		assert.deepEqual(await registerTables(client, 'a', tables), [{ datasetId: 'new-id', status: 'SUCCESS', alreadyRegistered: false }]);
		assert.deepEqual(jsonBody(mock.calls[0]), tables);
		assert.equal((await registerTables(client, 'a', tables))[0].datasetId, 'old-id');
		assert.deepEqual(await registerTables(client, 'a', tables), [{ datasetId: '0a1b2c3d-0000-4000-8000-000000000001', status: 'SKIPPED', alreadyRegistered: true }]);
		const sleeps = [];
		assert.equal((await registerTables(client, 'b', tables, { sleep: async (ms) => sleeps.push(ms) }))[0].datasetId, 'warm');
		assert.deepEqual(sleeps, [30000, 30000]);
		await assert.rejects(registerTables(client, 'c', tables, { sleep: async () => {} }), /NOT_FOUND: no such table/);
	} finally {
		mock.restore();
	}
});

test('ALREADY_REGISTERED takes the existing id from the message, not the temporary datasource the server deletes', () => {
	const result = parseRegistration({
		tableName: 'T',
		databaseName: 'DB',
		schemaName: 'S',
		datasource: '11111111-1111-1111-1111-111111111111',
		status: 'SKIPPED',
		error: { code: 'ALREADY_REGISTERED', message: 'DB.S.T is registered as 22222222-2222-2222-2222-222222222222' }
	});
	assert.equal(result.datasetId, '22222222-2222-2222-2222-222222222222');
	assert.equal(result.alreadyRegistered, true);
	assert.equal(parseRegistration({ datasource: 'only-id', status: 'SKIPPED', error: { code: 'ALREADY_REGISTERED', message: 'already registered' } }).datasetId, 'only-id');
});

test('registerTables pairs results with tables by name (validation failures come first) and flags results after a retry', async () => {
	const tables = [
		{ databaseName: 'DB', schemaName: 'S', tableName: 'A', dataProviderKey: 'snowflake' },
		{ databaseName: 'DB', schemaName: 'S', tableName: 'B', dataProviderKey: 'snowflake' }
	];
	let attempts = 0;
	const mock = mockFetch([
		{
			method: 'POST',
			path: '/data/v1/byos/register/a',
			json: {
				results: [
					{ tableName: 'B', databaseName: 'DB', schemaName: 'S', datasource: 'id-b', status: 'SUCCESS' },
					{ tableName: 'A', databaseName: 'DB', schemaName: 'S', datasource: 'id-a', status: 'SUCCESS' }
				]
			}
		},
		{
			method: 'POST',
			path: '/data/v1/byos/register/t',
			repeat: true,
			handler: () =>
				++attempts < 2
					? { status: 504, json: { message: 'timed out' } }
					: { json: { results: [{ tableName: 'A', databaseName: 'DB', schemaName: 'S', datasource: 'tmp', status: 'SKIPPED', error: { code: 'ALREADY_REGISTERED', message: 'registered as 33333333-3333-3333-3333-333333333333' } }] } }
		}
	]);
	try {
		const { client } = testClient();
		assert.deepEqual((await registerTables(client, 'a', tables)).map((r) => r.datasetId), ['id-a', 'id-b']);
		const [retried] = await registerTables(client, 't', [tables[0]], { sleep: async () => {} });
		assert.deepEqual(retried, { datasetId: '33333333-3333-3333-3333-333333333333', status: 'SKIPPED', alreadyRegistered: true, afterRetry: true });
	} finally {
		mock.restore();
	}
});

test('parseSnowflakeAccount reads hosts, org-account names and locators', () => {
	const cases = {
		'ACME-ANALYTICS': { kind: 'org', id: 'acme-analytics' },
		'https://acme-analytics.snowflakecomputing.com:443/': { kind: 'org', id: 'acme-analytics' },
		'acme-org_name.privatelink.snowflakecomputing.com': { kind: 'org', id: 'acme-org-name' },
		'ab67890.us-east-1.snowflakecomputing.com': { kind: 'locator', id: 'ab67890.us-east-1' },
		'xy12345.us-east-1.aws': { kind: 'locator', id: 'xy12345.us-east-1' },
		'XY12345.US-EAST-1.privatelink.snowflakecomputing.com': { kind: 'locator', id: 'xy12345.us-east-1' },
		'xy12345.east-us-2.azure': { kind: 'locator', id: 'xy12345.east-us-2.azure' },
		'xy12345.snowflakecomputing.com': { kind: 'locator', id: 'xy12345.us-west-2' },
		xy12345: { kind: 'locator', id: 'xy12345.us-west-2' }
	};
	for (const [value, expected] of Object.entries(cases)) assert.deepEqual(parseSnowflakeAccount(value), expected, value);
	for (const value of ['', undefined, 'db.example.com', 'replica','org-acct.us-east-1']) assert.equal(parseSnowflakeAccount(value), null, String(value));
});

test('compareSnowflakeAccounts: equal, differs, and unknown for a locator against an org-account name', () => {
	assert.equal(compareSnowflakeAccounts('ACME-ANALYTICS', 'acme-analytics.snowflakecomputing.com'), 'equal');
	assert.equal(compareSnowflakeAccounts('EXAMPLE-ORG_ANALYTICS', 'example-org-analytics.privatelink.snowflakecomputing.com'), 'equal');
	assert.equal(compareSnowflakeAccounts('xy12345.us-east-1', 'xy12345.us-east-1.aws'), 'equal');
	assert.equal(compareSnowflakeAccounts('EXAMPLE-PARTNER', 'acme-analytics.snowflakecomputing.com'), 'differs');
	assert.equal(compareSnowflakeAccounts('xy12345.us-east-1', 'xy12345.us-west-2.snowflakecomputing.com'), 'differs');
	assert.equal(compareSnowflakeAccounts('ACME-ANALYTICS', 'ab67890.us-east-1.snowflakecomputing.com'), 'unknown');
	assert.equal(compareSnowflakeAccounts(undefined, 'ab67890.us-east-1.snowflakecomputing.com'), 'unknown');
	assert.equal(compareSnowflakeAccounts('EXAMPLE-X', 'tableau.example.com'), 'unknown');
});

const CREDENTIALS = { privateKey: 'SECRET-PRIVATE-KEY', passPhrase: 'SECRET-PASS', password: 'SECRET-PASSWORD', role: 'SVC_ROLE', username: 'SVC_USER', allowExternalUse: 'false' };

test('getSnowflakeAccount reads the provider key, then only the account field, without unmask first', async () => {
	const mock = mockFetch([
		{ method: 'GET', path: '/data/v1/accounts/101', json: { id: 101, dataProviderType: 'snowflakekeypairauthentication', configurations: {} } },
		{ method: 'GET', path: '/data/v1/providers/snowflakekeypairauthentication/account/101', json: { ...CREDENTIALS, account: 'ACME-ANALYTICS' } }
	]);
	try {
		const { client, events } = testClient();
		const result = await getSnowflakeAccount(client, '101');
		assert.deepEqual(result, { account: 'ACME-ANALYTICS', providerKey: 'snowflakekeypairauthentication' });
		assert.equal(mock.calls[1].query.unmask, undefined);
		assert.doesNotMatch(JSON.stringify({ result, events }), /SECRET|SVC_/);
	} finally {
		mock.restore();
	}
});

test('getSnowflakeAccount uses unmask=true only when the plain read has no account, and tries the key-pair field list for a masked one', async () => {
	const mock = mockFetch([
		{ method: 'GET', path: '/data/v1/accounts/7', json: { dataProviderType: 'snowflake' } },
		{ method: 'GET', path: '/data/v1/providers/snowflake/account/7', repeat: true, json: { ...CREDENTIALS, account: '********' } },
		{ method: 'GET', path: '/data/v1/providers/snowflakekeypairauthentication/account/7', handler: (call) => ({ json: call.query.unmask ? { account: 'ACME-PROD' } : { ...CREDENTIALS } }), repeat: true }
	]);
	try {
		const { client } = testClient();
		assert.deepEqual(await getSnowflakeAccount(client, '7'), { account: 'ACME-PROD', providerKey: 'snowflake' });
		assert.deepEqual(
			mock.calls.slice(1).map((c) => `${c.path} ${c.query.unmask ?? ''}`.trim()),
			['/data/v1/providers/snowflake/account/7', '/data/v1/providers/snowflake/account/7 true', '/data/v1/providers/snowflakekeypairauthentication/account/7', '/data/v1/providers/snowflakekeypairauthentication/account/7 true']
		);
	} finally {
		mock.restore();
	}
});

test('getSnowflakeAccount failures are unknown with the status only, never the response body', async () => {
	const secretBody = { message: 'denied', privateKey: 'SECRET-PRIVATE-KEY' };
	const mock = mockFetch([
		{ method: 'GET', path: '/data/v1/accounts/8', status: 403, json: secretBody },
		{ method: 'GET', path: /^\/data\/v1\/providers\/[^/]+\/account\/8$/, status: 404, json: secretBody, repeat: true },
		{ method: 'GET', path: '/data/v1/accounts/9', json: { dataProviderType: 'mysql' } }
	]);
	try {
		const { client, events } = testClient();
		const denied = await getSnowflakeAccount(client, '8');
		assert.equal(denied.account, undefined);
		assert.match(denied.reason, /HTTP 403, HTTP 404/);
		const other = await getSnowflakeAccount(client, '9');
		assert.deepEqual(other, { providerKey: 'mysql', reason: 'service account provider mysql is not Snowflake' });
		assert.equal(mock.calls.filter((c) => c.path.includes('/account/9')).length, 0);
		assert.deepEqual(await getSnowflakeAccount(client, undefined), { reason: 'the integration names no service account' });
		assert.doesNotMatch(JSON.stringify({ denied, other, events }), /SECRET/);
	} finally {
		mock.restore();
	}
});

test('resolveSnowflakeAccounts reads each service account once and keeps serviceAccountId from the integration list', async () => {
	const mock = mockFetch([
		{
			method: 'GET',
			path: '/query/v1/byos/accounts',
			json: [
				{ id: 'a', engine: 'SNOWFLAKE', friendlyName: 'A', serviceAccountId: '1' },
				{ id: 'b', engine: 'SNOWFLAKE', friendlyName: 'B', properties: { serviceAccountId: { value: '1' } } },
				{ id: 'c', engine: 'BIGQUERY', friendlyName: 'C', serviceAccountId: '2' }
			]
		},
		{ method: 'GET', path: '/data/v1/accounts/1', json: { dataProviderType: 'snowflakekeypairauthentication' } },
		{ method: 'GET', path: '/data/v1/providers/snowflakekeypairauthentication/account/1', json: { ...CREDENTIALS, account: 'ACME-PROD' } }
	]);
	try {
		const { client } = testClient();
		const list = await listIntegrations(client);
		assert.equal(list[1].serviceAccountId, '1');
		const accounts = await resolveSnowflakeAccounts(client, list);
		assert.deepEqual([...accounts.keys()], ['a', 'b']);
		assert.equal(accounts.get('b').account, 'ACME-PROD');
		assert.equal(mock.calls.length, 3);
	} finally {
		mock.restore();
	}
});

test('warehouse table names: T2D, the workbook, then the dataset name without a repeat of the workbook', () => {
	assert.equal(warehouseTableName('podio-xero-dash', 'Podio Xero Dash - SNOWFLAKE - Custom SQL Query'), 'T2D_PODIO_XERO_DASH_SNOWFLAKE_CUSTOM_SQL_QUERY');
	assert.equal(warehouseTableName('dbr', 'DBR (Magic ETL calcs)'), 'T2D_DBR_MAGIC_ETL_CALCS');
	assert.equal(warehouseTableName('dbr-daily-trend', 'DBR (Magic ETL calcs)'), 'T2D_DBR_DAILY_TREND_DBR_MAGIC_ETL_CALCS');
	assert.equal(warehouseTableName('dbr', 'DBR'), 'T2D_DBR_DBR');
	assert.ok(isWarehouseTableName('t2d_dbr_dbr_1', 'T2D_DBR_DBR'), 'with the suffix ice adds to a taken name');
	assert.ok(!isWarehouseTableName('T2D_DBR_DBR_X', 'T2D_DBR_DBR'));
	const long = warehouseTableName('sharefile-arr', 'x '.repeat(100));
	assert.ok(long.length <= 128 && !long.endsWith('_'));
});
