import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { createDataflow, updateDataflow, runDataflow, waitForExecution, outputDatasetIds, outputDatasets } from '../../src/domo/dataflows.js';
import { createFusion, updateFusion, getFusion } from '../../src/domo/views.js';
import { createConnectorStream, updateConnectorStream, runStream, waitForStreamExecution, toConfiguration } from '../../src/domo/streams.js';

let mock;
afterEach(() => mock?.restore());

test('createDataflow applies Magic defaults; runDataflow posts without a body', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/dataprocessing/v1/dataflows', json: { id: 77 } },
		{ method: 'POST', path: '/dataprocessing/v1/dataflows/77/executions', json: { id: 5, state: 'CREATED' } }
	]);
	await createDataflow(client, { name: 'Join', actions: [] });
	assert.deepEqual(jsonBody(mock.calls[0]), { databaseType: 'MAGIC', engineProperties: { 'kettle.mode': 'STRICT' }, gui: {}, name: 'Join', actions: [] });
	const exec = await runDataflow(client, 77);
	assert.equal(exec.id, 5);
	assert.equal(mock.calls[1].body, undefined);
});

test('updateDataflow merges onto the current dataflow and keeps output guids', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{
			method: 'GET',
			path: '/dataprocessing/v1/dataflows/77',
			json: { id: 77, name: 'Old', onboardFlowVersion: { versionNumber: 3 }, actions: [{ type: 'PublishToVault', id: 'out-1', dataSource: { guid: 'g-1', name: 'Out' } }] }
		},
		{ method: 'PUT', path: '/dataprocessing/v1/dataflows/77', json: { id: 77 } }
	]);
	await updateDataflow(client, 77, { name: 'New', actions: [{ type: 'PublishToVault', id: 'out-1', dataSource: { guid: '', name: 'Out' } }] });
	const sent = jsonBody(mock.calls[1]);
	assert.equal(sent.name, 'New');
	assert.equal(sent.id, 77);
	assert.deepEqual(sent.onboardFlowVersion, { versionNumber: 3 });
	assert.equal(sent.actions[0].dataSource.guid, 'g-1');
});

test('updateDataflow sends a null guid for a new output so the server creates its dataset', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/dataprocessing/v1/dataflows/77', json: { id: 77, actions: [{ type: 'PublishToVault', id: 'out-1', dataSource: { guid: 'g-1', name: 'Out' } }] } },
		{ method: 'PUT', path: '/dataprocessing/v1/dataflows/77', json: { id: 77 } }
	]);
	await updateDataflow(client, 77, {
		actions: [
			{ type: 'PublishToVault', id: 'out-1', dataSource: { guid: '', name: 'Out' } },
			{ type: 'PublishToVault', id: 'out-2', dataSource: { guid: '', name: 'Stacked' } }
		]
	});
	const sent = jsonBody(mock.calls[1]);
	assert.equal(sent.actions[0].dataSource.guid, 'g-1');
	assert.equal(sent.actions[1].dataSource.guid, null);
});

test('updateDataflow unpauses a flow so push can run it', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/dataprocessing/v1/dataflows/77', json: { id: 77, paused: true, pausedReason: 'USER', actions: [] } },
		{ method: 'PUT', path: '/dataprocessing/v1/dataflows/77', json: { id: 77 } }
	]);
	await updateDataflow(client, 77, { name: 'New' });
	const sent = jsonBody(mock.calls[1]);
	assert.equal(sent.paused, false);
	assert.equal(sent.pausedReason, null);
});

test('waitForExecution resolves on SUCCESS and throws on failure states', async () => {
	const { client } = testClient();
	let n = 0;
	mock = mockFetch([
		{ method: 'GET', path: '/dataprocessing/v1/dataflows/77/executions/5', repeat: true, handler: () => ({ json: { id: 5, state: ++n < 3 ? 'RUNNING_DATA_FLOW' : 'SUCCESS' } }) },
		{ method: 'GET', path: '/dataprocessing/v1/dataflows/77/executions/6', json: { id: 6, state: 'FAILED_DATA_FLOW', failureReason: 'join key missing' } }
	]);
	assert.equal((await waitForExecution(client, 77, 5, { intervalMs: 1 })).state, 'SUCCESS');
	await assert.rejects(waitForExecution(client, 77, 6, { intervalMs: 1 }), /FAILED_DATA_FLOW: join key missing/);
});

test('waitForExecution builds the failure detail from errors[] when message is null', async () => {
	const { client } = testClient();
	const errors = [
		{ code: 'DP-0030', actionId: 'group-accountau-lod', message: 'raw', localizedMessage: 'Division by zero' },
		{ code: 'DP-0001', message: 'Bad input' },
		{ actionId: 'x' }
	];
	mock = mockFetch([{ method: 'GET', path: '/dataprocessing/v1/dataflows/77/executions/7', json: { id: 7, state: 'FAILED_DATA_FLOW', message: null, errors } }]);
	await assert.rejects(waitForExecution(client, 77, 7, { intervalMs: 1 }), (err) => {
		assert.equal(err.message, 'Dataflow 77 execution 7 ended in FAILED_DATA_FLOW: DP-0030 group-accountau-lod: Division by zero; DP-0001: Bad input; x: {"actionId":"x"}');
		return true;
	});
});

test('outputDatasetIds reads outputs and PublishToVault actions', () => {
	const df = {
		outputs: [{ dataSourceId: 'a', dataSourceName: 'A' }],
		actions: [
			{ type: 'PublishToVault', id: 'p1', dataSource: { guid: 'a', name: 'A' } },
			{ type: 'PublishToVault', id: 'p2', dataSource: { guid: 'b', name: 'B' } },
			{ type: 'LoadFromVault', id: 'l', dataSourceId: 'c' }
		]
	};
	assert.deepEqual(outputDatasetIds(df), ['a', 'b']);
	assert.deepEqual(outputDatasets(df)[0], { id: 'a', name: 'A', actionId: 'p1' });
});

test('createFusion fills responsibleUserId from whoAmI; update and get', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v2/users/me', json: { id: 1001 }, repeat: true },
		{ method: 'POST', path: '/query/v1/fusions', json: { dataSourceId: 'v-1' } },
		{ method: 'PUT', path: '/query/v1/fusions/v-1', json: { dataSourceId: 'v-1' } },
		{ method: 'GET', path: '/query/v1/fusions/v-1', json: { dataSourceId: 'v-1' } }
	]);
	const body = { dataSourceName: 'View', columnList: [], rowFuse: { dataSources: ['a', 'b'] } };
	assert.equal((await createFusion(client, body)).dataSourceId, 'v-1');
	assert.deepEqual(jsonBody(mock.calls[1]), { dataSourceType: 'datafusion', validate: true, ...body, responsibleUserId: '1001' });
	await updateFusion(client, 'v-1', { ...body, responsibleUserId: '5' });
	assert.equal(jsonBody(mock.calls[2]).responsibleUserId, '5');
	await getFusion(client, 'v-1');
});

test('createConnectorStream builds the connector wizard body', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/data/ui/v3/datasources/search', json: { dataSources: [] } },
		{ method: 'GET', path: '/data/v1/providers/snowflake', json: { key: 'snowflake', connectorId: 'com.domo.connector.snowflake' } },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 300, dataSource: { id: 'ds-9' } } }
	]);
	const res = await createConnectorStream(client, {
		name: 'Orders',
		providerKey: 'snowflake',
		accountId: '55',
		connectorVersion: 2,
		configuration: [{ name: 'query', value: 'select 1' }, { name: 'opts', value: { a: 1 } }],
		updateMethod: 'REPLACE',
		schedule: { type: 'MANUAL' }
	});
	assert.deepEqual({ streamId: res.streamId, datasetId: res.datasetId }, { streamId: 300, datasetId: 'ds-9' });
	assert.deepEqual(jsonBody(mock.calls[2]), {
		transport: { type: 'CONNECTOR', description: 'com.domo.connector.snowflake', version: '2' },
		configuration: [
			{ category: 'METADATA', name: 'query', type: 'string', value: 'select 1' },
			{ category: 'METADATA', name: 'opts', type: 'object', value: '{"a":1}' }
		],
		account: { id: 55 },
		updateMethod: 'REPLACE',
		dataProvider: { key: 'snowflake' },
		dataSource: { name: 'Orders', description: '' },
		advancedScheduleJson: '{"type":"MANUAL"}'
	});
});

test('createConnectorStream copies a template stream transport', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/data/v1/streams/12', json: { id: 12, transport: { type: 'CONNECTOR', description: 'cid', version: '3' } } },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 301, dataSource: { id: 'ds-10' } } }
	]);
	await createConnectorStream(client, { name: 'X', providerKey: 'k', templateStreamId: 12, configuration: { q: 'x' } });
	assert.deepEqual(mock.calls[0].query, { fields: 'all' });
	assert.deepEqual(jsonBody(mock.calls[1]).transport, { type: 'CONNECTOR', description: 'cid', version: '3' });
});

test('createConnectorStream reads the connector id and latest major version when the plan has neither', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/data/ui/v3/datasources/search', json: { dataSources: [] } },
		{ method: 'GET', path: '/data/v1/providers/k', json: { key: 'k', connectorId: 'com.domo.connector.k' } },
		{ method: 'GET', path: '/data/v1/connectors/com.domo.connector.k', json: { id: 'com.domo.connector.k', version: { major: 4, minor: 1 } } },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 302, dataSource: { id: 'ds-11' } } },
		{ method: 'POST', path: '/data/ui/v3/datasources/search', json: { dataSources: [] } },
		{ method: 'GET', path: '/data/v1/providers/k2', json: { key: 'k2', defaultConnectorId: 'c2' } },
		{ method: 'GET', path: '/data/v1/connectors/c2', status: 403, json: {} },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 303, dataSource: { id: 'ds-12' } } },
		{ method: 'POST', path: '/data/ui/v3/datasources/search', json: { dataSources: [] } },
		{ method: 'GET', path: '/data/v1/providers/k3', json: { key: 'k3' } }
	]);
	await createConnectorStream(client, { name: 'X', providerKey: 'k' });
	assert.deepEqual(jsonBody(mock.calls[3]).transport, { type: 'CONNECTOR', description: 'com.domo.connector.k', version: '4' });
	await createConnectorStream(client, { name: 'X', providerKey: 'k2' });
	assert.deepEqual(jsonBody(mock.calls.at(-1)).transport, { type: 'CONNECTOR', description: 'c2', version: '0' });
	await assert.rejects(createConnectorStream(client, { name: 'X', providerKey: 'k3' }), /no default connector/);
});

test('createConnectorStream copies transport and option defaults from a stream of the same provider', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{
			method: 'POST',
			path: '/data/ui/v3/datasources/search',
			handler: (call) => {
				assert.deepEqual(JSON.parse(call.body).filters, [{ filterType: 'term', field: 'dataProviderType', value: 'mysql', not: false }]);
				return { json: { dataSources: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] } };
			}
		},
		{ method: 'GET', path: '/data/v3/datasources/d1', json: { id: 'd1', streamId: 1 } },
		{ method: 'GET', path: '/data/v1/streams/1', json: { id: 1, dataProvider: { key: 'mysql' }, transport: { type: 'CONNECTOR', description: 'com.domo.connector.mysql', version: '5' }, configuration: [] } },
		{ method: 'GET', path: '/data/v3/datasources/d2', json: { id: 'd2', streamId: 2 } },
		{
			method: 'GET',
			path: '/data/v1/streams/2',
			json: {
				id: 2,
				dataProvider: { key: 'mysql' },
				transport: { type: 'CONNECTOR', description: 'com.domo.connector.mysql', version: '6.315' },
				account: { id: 77 },
				configuration: [
					{ category: 'METADATA', type: 'string', name: 'tinyIsBit', value: 'no' },
					{ category: 'METADATA', type: 'string', name: 'useCompression', value: 'true' },
					{ category: 'METADATA', type: 'string', name: 'bypassDataUpload', value: 'false' },
					{ category: 'METADATA', type: 'string', name: 'pass', value: 'p' },
					{ category: 'METADATA', type: 'string', name: 'privateKeyPassphrase', value: 'p' },
					{ category: 'METADATA', type: 'string', name: 'tableName', value: 'other_table' },
					{ category: 'METADATA', type: 'string', name: 'databaseName', value: 'OTHER_DB' },
					{ category: 'METADATA', type: 'string', name: 'query', value: 'select secret stuff' },
					{ category: 'CONNECTOR_RESULT', type: 'string', name: 'lastRun', value: 'x' },
					{ category: 'METADATA', type: 'string', name: 'password', value: 'p' }
				]
			}
		},
		{ method: 'GET', path: '/data/v3/datasources/d3', json: { id: 'd3', streamId: 3 } },
		{ method: 'GET', path: '/data/v1/streams/3', json: { id: 3, transport: { type: 'CLOUD', description: 'x', version: '9' } } },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 304, dataSource: { id: 'ds-13' } } }
	]);
	const res = await createConnectorStream(client, {
		name: 'X',
		providerKey: 'mysql',
		accountId: 5,
		configuration: [{ name: 'query', value: 'select 1' }, { name: 'tinyIsBit', value: 'yes' }],
		defaultTransport: { providerKey: 'mysql', connectorId: 'com.domo.connector.mysql', connectorVersion: '6' }
	});
	assert.equal(res.transportSource, 'stream 2 of mysql');
	const body = jsonBody(mock.calls.at(-1));
	assert.deepEqual(body.transport, { type: 'CONNECTOR', description: 'com.domo.connector.mysql', version: '6' });
	assert.deepEqual(body.account, { id: 5 });
	assert.deepEqual(
		body.configuration.map((e) => [e.name, e.value]),
		[['useCompression', 'true'], ['bypassDataUpload', 'false'], ['query', 'select 1'], ['tinyIsBit', 'yes']]
	);
});

test('createConnectorStream falls back to the plan default transport when no stream exists', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/data/ui/v3/datasources/search', json: { dataSources: [] } },
		{ method: 'GET', path: '/data/v1/connectors/com.domo.connector.mssql', status: 403, json: {} },
		{ method: 'POST', path: '/data/v1/streams', json: { id: 305, dataSource: { id: 'ds-14' } } }
	]);
	const res = await createConnectorStream(client, {
		name: 'X',
		providerKey: 'ms-sql-server',
		defaultTransport: { providerKey: 'ms-sql-server', connectorId: 'com.domo.connector.mssql', connectorVersion: '3' }
	});
	assert.equal(res.transportSource, 'defaults');
	assert.deepEqual(jsonBody(mock.calls.at(-1)).transport, { type: 'CONNECTOR', description: 'com.domo.connector.mssql', version: '3' });
});

test('runStream and waitForStreamExecution', async () => {
	const { client } = testClient();
	let n = 0;
	mock = mockFetch([
		{ method: 'POST', path: '/data/v1/streams/300/executions', json: { executionId: 4 } },
		{ method: 'GET', path: '/data/v1/streams/300/executions/4', repeat: true, handler: () => ({ json: { currentState: ++n < 2 ? 'ACTIVE' : 'SUCCESS' } }) },
		{ method: 'GET', path: '/data/v1/streams/300/executions/5', json: { currentState: 'ERROR', errors: [{ message: 'auth failed' }] } }
	]);
	const exec = await runStream(client, 300);
	assert.equal(exec.executionId, 4);
	assert.equal((await waitForStreamExecution(client, 300, 4, { intervalMs: 1 })).currentState, 'SUCCESS');
	await assert.rejects(waitForStreamExecution(client, 300, 5, { intervalMs: 1 }), /ERROR: auth failed/);
});

test('toConfiguration drops null values', () => {
	assert.deepEqual(toConfiguration({ a: 'x', b: null }), [{ category: 'METADATA', name: 'a', type: 'string', value: 'x' }]);
});

test('updateConnectorStream replaces named METADATA entries and the account, keeping the rest', async () => {
	const { client } = testClient();
	const current = {
		id: 7,
		transport: { type: 'CONNECTOR', description: 'com.domo.connector.x', version: '0' },
		account: { id: 1 },
		configuration: [
			{ category: 'METADATA', type: 'string', name: 'query', value: 'select 1 limit 100' },
			{ category: 'METADATA', type: 'string', name: 'fetchSize', value: '1000' },
			{ category: 'CONNECTOR_RESULT', type: 'string', name: 'lastRun', value: 'x' }
		]
	};
	mock = mockFetch([
		{ method: 'GET', path: '/data/v1/streams/7', json: current },
		{ method: 'PUT', path: '/data/v1/streams/7', handler: (call) => ({ json: JSON.parse(call.body) }) }
	]);
	await updateConnectorStream(client, 7, { configuration: [{ name: 'query', value: 'select 1 limit 50' }], accountId: '2' });
	assert.equal(mock.calls[0].query.fields, 'all');
	const body = jsonBody(mock.calls[1]);
	assert.deepEqual(body.transport, current.transport);
	assert.deepEqual(body.account, { id: 2 });
	assert.deepEqual(body.configuration.map((e) => [e.category, e.name, e.value]), [
		['METADATA', 'fetchSize', '1000'],
		['CONNECTOR_RESULT', 'lastRun', 'x'],
		['METADATA', 'query', 'select 1 limit 50']
	]);
});
