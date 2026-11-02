import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TableauClient } from '../../src/tableau/client.js';
import {
	buildFilter,
	listWorkbooks,
	listDatasources,
	findWorkbook,
	findDatasource,
	listWorkbookViews,
	downloadWorkbook,
	downloadDatasource,
	safeFileName
} from '../../src/tableau/content.js';
import { installFetch, signinBody, baseConfig } from './mock-fetch.js';

let mock;
afterEach(() => mock?.restore());

const LUID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const newClient = () => new TableauClient({ ...baseConfig, apiVersion: '3.24' });
const page = (collection, item, list) => ({ pagination: { pageNumber: '1', pageSize: '100', totalAvailable: String(list.length) }, [collection]: { [item]: list } });

test('buildFilter escapes by moving comma/colon values client-side', () => {
	assert.deepEqual(buildFilter({ name: 'Sales', projectName: 'Finance' }), { filter: 'name:eq:Sales,projectName:eq:Finance', clientSide: {} });
	assert.deepEqual(buildFilter({ name: 'Sales, East: 2024', projectName: undefined }), { filter: undefined, clientSide: { name: 'Sales, East: 2024' } });
});

test('listWorkbooks sends name/project filters and filters tricky values locally', async () => {
	const workbooks = [
		{ id: 'a', name: 'Q1, Sales', project: { id: 'p1', name: 'Finance' } },
		{ id: 'b', name: 'Q1 Sales', project: { id: 'p1', name: 'Finance' } }
	];
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\?/, () => page('workbooks', 'workbook', workbooks)]
	]);
	const result = await listWorkbooks(newClient(), { name: 'Q1, Sales', project: 'Finance' });
	assert.deepEqual(result.map((w) => w.id), ['a']);
	assert.equal(new URL(mock.calls[1].url).searchParams.get('filter'), 'projectName:eq:Finance');
});

test('listDatasources falls back to client-side filtering when the server rejects a filter', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/datasources\?/, (call) => new URL(call.url).searchParams.get('filter')
			? new Response('{"error":{"code":"400065"}}', { status: 400 })
			: page('datasources', 'datasource', [{ id: 'd1', contentUrl: 'superstore' }, { id: 'd2', contentUrl: 'other' }])]
	]);
	const result = await listDatasources(newClient(), { contentUrl: 'superstore' });
	assert.deepEqual(result.map((d) => d.id), ['d1']);
});

test('findWorkbook by luid uses GET /workbooks/{id}', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', new RegExp(`/workbooks/${LUID}$`), () => ({ workbook: { id: LUID, name: 'X' } })]
	]);
	const wb = await findWorkbook(newClient(), LUID);
	assert.equal(wb.id, LUID);
});

test('findWorkbook reports ambiguity with project names', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\?/, () => page('workbooks', 'workbook', [
			{ id: 'a', name: 'Sales', project: { name: 'Finance' } },
			{ id: 'b', name: 'Sales', project: { name: 'Marketing' } }
		])]
	]);
	await assert.rejects(findWorkbook(newClient(), 'Sales'), /ambiguous.*Finance.*Marketing/);
});

test('findWorkbook filters by project luid client-side and errors when missing', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\?/, () => page('workbooks', 'workbook', [
			{ id: 'a', name: 'Sales', project: { id: LUID, name: 'Finance' } },
			{ id: 'b', name: 'Sales', project: { id: 'other', name: 'Finance' } }
		])]
	]);
	const wb = await findWorkbook(newClient(), 'Sales', { project: LUID });
	assert.equal(wb.id, 'a');
	mock.restore();
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\?/, () => page('workbooks', 'workbook', [])]
	]);
	await assert.rejects(findWorkbook(newClient(), 'Nope'), /not found/);
});

test('findDatasource returns null when not found and resolves by contentUrl', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/datasources\?/, (call) => {
			const filter = new URL(call.url).searchParams.get('filter');
			return filter === 'contentUrl:eq:superstore'
				? page('datasources', 'datasource', [{ id: 'd1', name: 'Superstore', contentUrl: 'superstore' }])
				: page('datasources', 'datasource', []);
		}]
	]);
	const client = newClient();
	assert.equal((await findDatasource(client, { contentUrl: 'superstore', name: 'Superstore' })).id, 'd1');
	assert.equal(await findDatasource(client, { name: 'Missing' }), null);
});

test('listWorkbookViews returns the view array', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\/w1\/views$/, () => ({ views: { view: [{ id: 'v1', name: 'Sheet 1' }] } })]
	]);
	assert.deepEqual(await listWorkbookViews(newClient(), 'w1'), [{ id: 'v1', name: 'Sheet 1' }]);
});

test('downloadWorkbook and downloadDatasource write into destDir', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-content-'));
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\/w1\/content\?includeExtract=true$/, () => new Response('zip', {
			headers: { 'content-disposition': 'attachment; filename="../evil/Sales.twbx"' }
		})],
		['GET', /\/datasources\/d1\/content\?includeExtract=false$/, () => new Response('<datasource/>', {
			headers: { 'content-type': 'application/xml' }
		})]
	]);
	const client = newClient();
	const wb = await downloadWorkbook(client, 'w1', dir);
	assert.equal(wb.file, path.join(dir, 'Sales.twbx'));
	const ds = await downloadDatasource(client, 'd1', dir, { includeExtract: false });
	assert.equal(ds.file, path.join(dir, 'd1.tds'));
	assert.equal(fs.readFileSync(ds.file, 'utf8'), '<datasource/>');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('safeFileName strips paths and enforces extensions', () => {
	assert.equal(safeFileName('a/b/c.twbx', 'x.twbx', ['twb', 'twbx'], 'twbx'), 'c.twbx');
	assert.equal(safeFileName('report', 'x.twbx', ['twb', 'twbx'], 'twbx'), 'report.twbx');
	assert.equal(safeFileName(null, 'x.twbx', ['twb', 'twbx'], 'twbx'), 'x.twbx');
	assert.equal(safeFileName('a:b?.twb', 'x', ['twb', 'twbx'], 'twbx'), 'a_b_.twb');
});
