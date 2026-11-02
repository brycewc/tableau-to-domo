import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TableauClient, TableauGraphQLError, TableauApiError, parseContentDisposition, parseTableauError } from '../../src/tableau/client.js';
import { HttpError } from '../../src/util/http.js';
import { installFetch, jsonResponse, signinBody, baseConfig } from './mock-fetch.js';

let mock;
afterEach(() => mock?.restore());

const serverinfo = ['GET', /\/api\/3\.19\/serverinfo$/, () => ({ serverInfo: { restApiVersion: '3.24', productVersion: { value: '2024.3' } } })];

test('detects version from serverinfo and signs in with a PAT', async () => {
	mock = installFetch([serverinfo, ['POST', /\/api\/3\.24\/auth\/signin$/, () => signinBody()]]);
	const client = new TableauClient(baseConfig);
	const session = await client.signIn();
	assert.equal(session.token, 'tok-1');
	assert.equal(client.siteId, 'site-1');
	assert.equal(client.userId, 'user-1');
	assert.equal(client.apiVersion, '3.24');
	assert.equal(mock.calls[0].headers.Accept, 'application/json');
	const signin = mock.calls[1];
	assert.equal(signin.init.redirect, 'manual');
	assert.deepEqual(JSON.parse(signin.body), {
		credentials: { personalAccessTokenName: 'pat', personalAccessTokenSecret: 'secret', site: { contentUrl: 'mysite' } }
	});
});

test('pinned apiVersion skips serverinfo', async () => {
	mock = installFetch([['POST', /\/api\/3\.21\/auth\/signin$/, () => signinBody()]]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.21' });
	await client.signIn();
	assert.equal(mock.calls.length, 1);
});

test('falls back to the floor version when serverinfo fails', async () => {
	mock = installFetch([
		['GET', /serverinfo$/, () => new Response('nope', { status: 404 })],
		['POST', /\/api\/3\.19\/auth\/signin$/, () => signinBody()]
	]);
	const events = [];
	const client = new TableauClient(baseConfig, { emitter: { info() {}, warn: (m) => events.push(m) } });
	await client.signIn();
	assert.equal(client.apiVersion, '3.19');
	assert.ok(events.some((m) => /3\.19/.test(m)));
});

test('re-POSTs sign-in to the Location of a 301 and moves to the pod server', async () => {
	mock = installFetch([
		['GET', /online\.tableau\.com\/api\/3\.19\/serverinfo$/, () => ({ serverInfo: { restApiVersion: '3.26' } })],
		['POST', /^https:\/\/online\.tableau\.com\/api\/3\.26\/auth\/signin$/, () =>
			new Response(null, { status: 301, headers: { location: 'https://prod-useast-b.online.tableau.com/api/3.26/auth/signin' } })],
		['POST', /^https:\/\/prod-useast-b\.online\.tableau\.com\/api\/3\.26\/auth\/signin$/, () => signinBody('pod-token')],
		['GET', /^https:\/\/prod-useast-b\.online\.tableau\.com\/api\/3\.26\/sites\/site-1\/workbooks\/abc$/, () => ({ workbook: { id: 'abc' } })]
	]);
	const client = new TableauClient({ ...baseConfig, server: 'https://online.tableau.com/' });
	await client.signIn();
	assert.equal(client.server, 'https://prod-useast-b.online.tableau.com');
	assert.equal(client.token, 'pod-token');
	const reposted = mock.calls[2];
	assert.equal(reposted.method, 'POST');
	assert.match(reposted.body, /personalAccessTokenName/);
	const wb = await client.get('/workbooks/abc');
	assert.equal(wb.workbook.id, 'abc');
	assert.equal(mock.calls[3].headers['X-Tableau-Auth'], 'pod-token');
});

test('sign-in 401 gives a clear error', async () => {
	mock = installFetch([['POST', /signin$/, () => new Response('{"error":{"code":"401001"}}', { status: 401 })]]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	await assert.rejects(client.signIn(), /sign-in rejected/);
});

test('concurrent callers share one sign-in', async () => {
	let signins = 0;
	mock = installFetch([
		['POST', /signin$/, async () => {
			signins++;
			await new Promise((r) => setTimeout(r, 10));
			return signinBody();
		}],
		['GET', /\/projects/, () => ({ projects: { project: [] } })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	await Promise.all([client.get('/projects'), client.get('/projects'), client.get('/projects')]);
	assert.equal(signins, 1);
});

test('paginate walks 3 pages with string pagination numbers', async () => {
	const all = Array.from({ length: 5 }, (_, i) => ({ id: `wb${i}` }));
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\?/, (call) => {
			const u = new URL(call.url);
			const size = Number(u.searchParams.get('pageSize'));
			const page = Number(u.searchParams.get('pageNumber'));
			const slice = all.slice((page - 1) * size, page * size);
			return { pagination: { pageNumber: String(page), pageSize: String(size), totalAvailable: '5' }, workbooks: { workbook: slice } };
		}]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const items = await client.paginate('/workbooks', { collection: 'workbooks', item: 'workbook', pageSize: 2, query: { filter: 'name:eq:X' } });
	assert.deepEqual(items.map((w) => w.id), ['wb0', 'wb1', 'wb2', 'wb3', 'wb4']);
	const pageCalls = mock.calls.filter((c) => c.method === 'GET');
	assert.equal(pageCalls.length, 3);
	assert.equal(new URL(pageCalls[0].url).searchParams.get('filter'), 'name:eq:X');
});

test('paginate stops on an empty page and clamps pageSize', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/projects\?/, (call) => {
			const page = Number(new URL(call.url).searchParams.get('pageNumber'));
			return page === 1
				? { pagination: { totalAvailable: '99' }, projects: { project: { id: 'p1' } } }
				: { pagination: { totalAvailable: '99' }, projects: {} };
		}]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const items = await client.paginate('/projects', { collection: 'projects', item: 'project', pageSize: 5000 });
	assert.deepEqual(items, [{ id: 'p1' }]);
	assert.equal(new URL(mock.calls[1].url).searchParams.get('pageSize'), '1000');
});

test('401 triggers one re-sign-in and a retry', async () => {
	let signins = 0;
	mock = installFetch([
		['POST', /signin$/, () => signinBody(`tok-${++signins}`)],
		['GET', /\/workbooks\/w1$/, (call) =>
			call.headers['X-Tableau-Auth'] === 'tok-1' ? new Response('expired', { status: 401 }) : { workbook: { id: 'w1' } }]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const res = await client.get('/workbooks/w1');
	assert.equal(res.workbook.id, 'w1');
	assert.equal(signins, 2);
});

test('persistent 401 is thrown after one retry', async () => {
	let signins = 0;
	mock = installFetch([
		['POST', /signin$/, () => signinBody(`tok-${++signins}`)],
		['GET', /\/workbooks/, () => new Response('no', { status: 401 })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	await assert.rejects(client.get('/workbooks'), (err) => err.status === 401);
	assert.equal(signins, 2);
});

test('download streams to disk using the Content-Disposition filename', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-dl-'));
	const payload = Buffer.from('PK\u0003\u0004 fake twbx bytes');
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\/w1\/content\?includeExtract=false$/, () => new Response(payload, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Sales Report.twbx"' }
		})]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const res = await client.download('/workbooks/w1/content', (name) => path.join(dir, name), { includeExtract: false });
	assert.equal(res.filename, 'Sales Report.twbx');
	assert.equal(res.file, path.join(dir, 'Sales Report.twbx'));
	assert.equal(res.bytes, payload.length);
	assert.deepEqual(fs.readFileSync(res.file), payload);
	assert.deepEqual(fs.readdirSync(dir), ['Sales Report.twbx']);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('parseContentDisposition handles filename* and filename', () => {
	assert.equal(parseContentDisposition("attachment; filename*=UTF-8''Caf%C3%A9%20Sales.twbx; filename=\"Cafe.twbx\""), 'Café Sales.twbx');
	assert.equal(parseContentDisposition('attachment; filename="a \\"b\\".twb"'), 'a "b".twb');
	assert.equal(parseContentDisposition('attachment; filename=plain.tdsx'), 'plain.tdsx');
	assert.equal(parseContentDisposition(null), null);
	assert.equal(parseContentDisposition('inline'), null);
});

test('graphql posts to the metadata endpoint and returns data', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /\/api\/metadata\/graphql$/, () => ({ data: { workbooks: [{ luid: 'w1' }] } })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const data = await client.graphql('query Q($l: String!) { workbooks(filter:{luid:$l}) { luid } }', { l: 'w1' });
	assert.equal(data.workbooks[0].luid, 'w1');
	const body = JSON.parse(mock.calls[1].body);
	assert.deepEqual(body.variables, { l: 'w1' });
	assert.equal(mock.calls[1].headers['X-Tableau-Auth'], 'tok-1');
});

test('graphql throws with messages on errors, including partial-result limits', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /graphql$/, (call) => JSON.parse(call.body).query.includes('partial')
			? jsonResponse({ data: { workbooks: [] }, errors: [{ message: 'Showing partial results', extensions: { code: 'NODE_LIMIT_EXCEEDED', severity: 'WARNING' } }] })
			: jsonResponse({ errors: [{ message: "Validation error: Field 'foo' is undefined" }] })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	await assert.rejects(client.graphql('{ foo }'), (err) => err instanceof TableauGraphQLError && /foo/.test(err.message) && /failed/.test(err.message));
	await assert.rejects(client.graphql('{ partial }'), (err) =>
		err instanceof TableauGraphQLError && err.codes.includes('NODE_LIMIT_EXCEEDED') && /partial results/.test(err.message) && Array.isArray(err.data.workbooks));
});

test('vds posts to the VizQL Data Service with the auth header', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /\/api\/v1\/vizql-data-service\/read-metadata$/, () => ({ data: [{ fieldName: 'Region' }] })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const res = await client.vds('/read-metadata', { datasource: { datasourceLuid: 'd1' } });
	assert.equal(res.data[0].fieldName, 'Region');
	assert.equal(mock.calls[1].headers['X-Tableau-Auth'], 'tok-1');
});

test('signOut posts signout and clears the token', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /\/api\/3\.24\/auth\/signout$/, () => new Response(null, { status: 204 })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	await client.signIn();
	await client.signOut();
	assert.equal(client.token, null);
	assert.equal(mock.calls[1].headers['X-Tableau-Auth'], 'tok-1');
});

test('Tableau XML and JSON error bodies become short messages with a capability hint', async () => {
	const xml = `<?xml version='1.0' encoding='UTF-8'?><tsResponse xmlns="http://tableau.com/api"><error code="403019"><summary>Forbidden</summary><detail>&apos;user&apos; isn&apos;t authorized to download workbook &apos;wb-1&apos;.</detail></error></tsResponse>`;
	assert.deepEqual(parseTableauError(xml), { code: '403019', summary: 'Forbidden', detail: "'user' isn't authorized to download workbook 'wb-1'." });
	assert.deepEqual(parseTableauError('{"error":{"code":"404006","summary":"Not Found","detail":"Workbook not found"}}'), { code: '404006', summary: 'Not Found', detail: 'Workbook not found' });
	assert.deepEqual(parseTableauError('{"errorCode":"403800","message":"no VIZQL_DATA_API_ACCESS"}'), { code: '403800', summary: undefined, detail: 'no VIZQL_DATA_API_ACCESS' });
	assert.equal(parseTableauError('<html>gateway</html>'), null);

	mock = installFetch([
		['POST', /\/auth\/signin$/, () => signinBody()],
		['GET', /\/workbooks\/wb-1\/content/, () => new Response(xml, { status: 403, headers: { 'content-type': 'application/xml' } })],
		['GET', /\/workbooks$/, () => jsonResponse({ error: { code: '400006', summary: 'Bad Request', detail: 'Invalid filter' } }, 400)]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.29' });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-err-'));
	const err = await client.download('/workbooks/wb-1/content', path.join(dir, 'x.twbx'), { includeExtract: 'true' }).catch((e) => e);
	assert.ok(err instanceof TableauApiError);
	assert.ok(err instanceof HttpError);
	assert.equal(err.status, 403);
	assert.equal(err.code, '403019');
	assert.match(err.message, /^Tableau 403019: Forbidden: 'user' isn't authorized to download workbook 'wb-1'\. \(needs the Download Workbook\/Save a Copy capability\)/);
	assert.doesNotMatch(err.message, /tsResponse|includeExtract/);
	const listErr = await client.get('/workbooks').catch((e) => e);
	assert.match(listErr.message, /^Tableau 400006: Bad Request: Invalid filter/);
	assert.equal(listErr.status, 400);
});

const denied403028 = () => new Response(`<?xml version='1.0' encoding='UTF-8'?><tsResponse><error code="403028"><summary>Forbidden</summary><detail>&apos;user&apos; isn&apos;t authorized to download datasource &apos;ds-1&apos;.</detail></error></tsResponse>`, { status: 403 });
const tdsxResponse = () => new Response(Buffer.from('PK fake'), { status: 200, headers: { 'content-disposition': 'attachment; filename="ds.tdsx"' } });

test('downloads on one client run one at a time', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-dl-'));
	let active = 0;
	let peak = 0;
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/datasources\/ds-\d\/content/, async () => {
			peak = Math.max(peak, ++active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
			return tdsxResponse();
		}]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' });
	const results = await Promise.all([1, 2, 3].map((n) => client.download(`/datasources/ds-${n}/content`, path.join(dir, `ds-${n}.tdsx`))));
	assert.equal(peak, 1);
	assert.deepEqual(results.map((r) => path.basename(r.file)), ['ds-1.tdsx', 'ds-2.tdsx', 'ds-3.tdsx']);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a 403028 download is retried, and a failed download does not block the next one', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-dl-'));
	let tries = 0;
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/datasources\/flaky\/content/, () => (++tries < 2 ? denied403028() : tdsxResponse())],
		['GET', /\/datasources\/denied\/content/, () => denied403028()],
		['GET', /\/datasources\/ok\/content/, () => tdsxResponse()]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' }, { downloadRetryDelayMs: 1, emitter: { info() {}, warn() {} } });
	const res = await client.download('/datasources/flaky/content', path.join(dir, 'a.tdsx'));
	assert.equal(tries, 2);
	assert.ok(fs.existsSync(res.file));

	const [denied, ok] = await Promise.allSettled([
		client.download('/datasources/denied/content', path.join(dir, 'b.tdsx')),
		client.download('/datasources/ok/content', path.join(dir, 'c.tdsx'))
	]);
	assert.equal(mock.calls.filter((c) => /denied/.test(c.url)).length, 3);
	assert.equal(denied.reason.code, '403028');
	assert.match(denied.reason.message, /Download Data Source capability, unless Tableau rejected it for running alongside other downloads/);
	assert.equal(ok.status, 'fulfilled');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('other download errors are not retried', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['GET', /\/workbooks\/wb-1\/content/, () => new Response('<tsResponse><error code="403019"><summary>Forbidden</summary><detail>no</detail></error></tsResponse>', { status: 403 })]
	]);
	const client = new TableauClient({ ...baseConfig, apiVersion: '3.24' }, { downloadRetryDelayMs: 1 });
	const err = await client.download('/workbooks/wb-1/content', path.join(os.tmpdir(), 'never.twbx')).catch((e) => e);
	assert.equal(err.code, '403019');
	assert.equal(mock.calls.filter((c) => /content/.test(c.url)).length, 1);
});
