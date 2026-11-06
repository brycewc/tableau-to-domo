import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { validateExpressions, createBeastMode, updateBeastMode, listDatasetBeastModes, findByLegacyId, deleteBeastModes } from '../../src/domo/beastmodes.js';

let mock;
afterEach(() => mock?.restore());

test('validateExpressions maps keys to -1, -2 and back', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{
			method: 'POST',
			path: '/query/v1/functions/validateFunctions',
			json: {
				allValid: false,
				results: {
					'-1': { status: 'VALID', dataType: 'DOUBLE', containsAggregation: true },
					'-2': { status: 'INVALID_COLUMN', invalidColumns: ['Nope'] }
				}
			}
		}
	]);
	const out = await validateExpressions(client, 'ds-1', [
		{ key: 'calc:a', name: 'A', expression: 'SUM(`Sales`)' },
		{ key: 'calc:b', name: 'B', expression: 'SUM(`Nope`)' }
	]);
	assert.deepEqual(jsonBody(mock.calls[0]), {
		dataSourceId: 'ds-1',
		functionTemplates: { '-1': { name: 'A', expression: 'SUM(`Sales`)' }, '-2': { name: 'B', expression: 'SUM(`Nope`)' } }
	});
	assert.equal(out.get('calc:a').valid, true);
	assert.equal(out.get('calc:a').dataType, 'DOUBLE');
	assert.equal(out.get('calc:a').aggregated, true);
	assert.equal(out.get('calc:b').valid, false);
	assert.match(out.get('calc:b').message, /INVALID_COLUMN: invalid columns Nope/);
});

test('validateExpressions splits long expressions into separate calls', async () => {
	const { client } = testClient();
	const reply = { method: 'POST', path: '/query/v1/functions/validateFunctions', json: { results: { '-1': { status: 'VALID' }, '-2': { status: 'VALID' } } } };
	mock = mockFetch([reply, reply, reply]);
	const long = 'x'.repeat(40000);
	const out = await validateExpressions(client, 'ds-1', [
		{ key: 'a', expression: long },
		{ key: 'b', expression: long },
		{ key: 'c', expression: 'SUM(1)' }
	]);
	assert.deepEqual(mock.calls.map((call) => Object.keys(jsonBody(call).functionTemplates).length).sort(), [1, 2]);
	assert.deepEqual([...out.values()].map((o) => o.valid), [true, true, true]);
});

test('createBeastMode sends a dataset link and no owner or strict', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/query/v1/functions/template', json: { id: 10, legacyId: 'calculation_x' } }]);
	const res = await createBeastMode(client, { name: 'Ratio', expression: 'SUM(`P`)/SUM(`S`)', legacyId: 'calculation_x', datasetId: 'ds-1' });
	assert.equal(res.id, 10);
	const [call] = mock.calls;
	assert.deepEqual(call.query, {});
	assert.deepEqual(jsonBody(call), {
		name: 'Ratio',
		expression: 'SUM(`P`)/SUM(`S`)',
		global: false,
		variable: false,
		legacyId: 'calculation_x',
		links: [{ resource: { type: 'DATA_SOURCE', id: 'ds-1' }, visible: true, active: true }]
	});
	assert.ok(!('owner' in jsonBody(call)));
});

test('createBeastMode variables are global with no links', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/query/v1/functions/template', json: { id: 11 } }]);
	await createBeastMode(client, { name: 'Param', expression: '10', legacyId: 'calculation_p', variable: true });
	const body = jsonBody(mock.calls[0]);
	assert.equal(body.global, true);
	assert.equal(body.variable, true);
	assert.deepEqual(body.links, []);
});

test('createBeastMode rejects global non-variable and missing dataset', async () => {
	const { client } = testClient();
	await assert.rejects(createBeastMode(client, { name: 'x', expression: '1', global: true }), /must be a variable/);
	await assert.rejects(createBeastMode(client, { name: 'x', expression: '1' }), /datasetId is required/);
});

test('updateBeastMode PUTs only changed fields, leaving links alone', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'PUT', path: '/query/v1/functions/template/10', json: { id: 10 } }]);
	await updateBeastMode(client, 10, { name: 'N', expression: 'E', legacyId: 'ignored' });
	assert.deepEqual(jsonBody(mock.calls[0]), { name: 'N', expression: 'E' });
});

test('listDatasetBeastModes and findByLegacyId', async () => {
	const { client } = testClient();
	const listResponse = {
		resourceMapping: { 'DATA_SOURCE:ds-1': [10, 12] },
		objectMap: {
			10: { id: 10, name: 'A', legacyId: 'calculation_a', global: false },
			12: { id: 12, name: 'B', legacyId: 'calculation_b', global: false },
			13: { id: 13, name: 'other', legacyId: 'calculation_c', global: false }
		}
	};
	mock = mockFetch([{ method: 'POST', path: '/query/v1/functions/list', json: listResponse, repeat: true }]);
	const list = await listDatasetBeastModes(client, 'ds-1');
	assert.deepEqual(jsonBody(mock.calls[0]), { resources: [{ type: 'DATA_SOURCE', id: 'ds-1' }] });
	assert.deepEqual(list.map((t) => t.id).sort(), [10, 12]);
	assert.equal((await findByLegacyId(client, 'calculation_b', { datasetId: 'ds-1' })).id, 12);
	assert.equal(await findByLegacyId(client, 'calculation_zzz', { templates: list }), undefined);
});

test('findByLegacyId searches by name for variables', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/query/v1/functions/search', json: { results: [{ id: 20, name: 'Param' }] } },
		{ method: 'GET', path: '/query/v1/functions/template/20', json: { id: 20, name: 'Param', legacyId: 'calculation_p', expression: '1' } }
	]);
	const hit = await findByLegacyId(client, 'calculation_p', { name: 'Param' });
	assert.equal(hit.id, 20);
	const search = jsonBody(mock.calls[0]);
	assert.equal(search.name, 'Param');
	assert.deepEqual(search.sort, { field: 'name', ascending: true });
	assert.deepEqual(mock.calls[1].query, { hidden: 'true' });
});

test('deleteBeastModes deactivates the visible link and removes other active non-template links in the same request', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'POST', path: '/query/v1/functions/bulk/template', json: { deleted: [] } }]);
	const links = [
		{ resource: { type: 'DATA_SOURCE', id: 'ds-1' }, visible: true, active: true },
		{ resource: { type: 'CARD', id: 42 }, visible: false, active: true },
		{ resource: { type: 'FUNCTION_TEMPLATE', id: '9' }, visible: false, active: true }
	];
	await deleteBeastModes(client, [5, '6'], { unlink: new Map([['5', links], ['7', links]]) });
	assert.deepEqual(jsonBody(mock.calls[0]), {
		delete: [5, 6],
		links: {
			5: {
				linkTo: [{ resource: { type: 'DATA_SOURCE', id: 'ds-1' }, visible: true, active: false }],
				unlinkFrom: [{ resource: { type: 'CARD', id: '42' }, visible: false, active: true }]
			}
		}
	});
});
