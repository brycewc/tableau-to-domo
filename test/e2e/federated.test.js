import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { convertStage } from '../../src/pipeline/convert.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { unpushPlan } from '../../src/pipeline/unpush.js';
import { DataDecisionError, describeDecision } from '../../src/pipeline/decisions.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createDomoClient } from '../../src/domo/client.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { planFederatedTargets } from '../../src/tableau/data/federated.js';
import { installDomoServer } from './domo-server.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/sqlserver-live.twb', import.meta.url));
const ACCOUNTS = {
	77: {
		provider: 'sqlserver-federated',
		name: 'DW federated',
		settings: { 'server-name': 'dw.corp.example.com', port: '1433', user: 'svc', password: 'SECRET-FEDERATED-PASSWORD' },
		tree: [{ type: 'catalog', name: 'SUPPORT', values: [{ type: 'schema', name: 'dbo', values: [{ type: 'table', name: 'Cases' }] }] }],
		columns: { Cases: [{ name: 'Status', type: 'STRING' }, { name: 'Count', type: 'LONG' }] }
	}
};

let server;
let tmp;
let config;
const quiet = createEmitter(noopSink);
const deps = { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) };

before(() => {
	server = installDomoServer({ federatedAccounts: ACCOUNTS });
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-federated-'));
	config = { env: null, tableau: { server: '', site: '', patName: '', patSecret: '' }, domo: { instance: 'acme', accessToken: 'tok' }, workspace: path.join(tmp, 'ws'), python: 'python3' };
});

after(() => {
	server.restore();
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function setMappings(federated) {
	const ws = openWorkspace(config.workspace);
	await ws.ensureMappings();
	const raw = JSON.parse(fs.readFileSync(ws.mappingsFile, 'utf8'));
	fs.writeFileSync(ws.mappingsFile, JSON.stringify({ ...raw, federated }));
}

test('the decision offers the federated account whose server and database match, with no credential anywhere', async () => {
	const err = await extractWorkbook({ config, file: FIXTURE, emitter: quiet }).catch((e) => e);
	assert.ok(err instanceof DataDecisionError, err?.message);
	const [d] = err.decisions;
	assert.equal(d.federated.status, 'match');
	assert.equal(d.federated.matches[0].id, 77);
	assert.deepEqual(d.suggested, { choice: 'federated', id: 77 });
	assert.deepEqual(d.entries.federated, { federated: [{ match: { class: 'sqlserver', server: 'dw', dbname: 'SUPPORT' }, accountId: 77, providerKey: 'sqlserver-federated', cacheTTL: 900 }] });
	assert.ok(describeDecision(d).some((l) => /Federated accounts \(sqlserver-federated\): match 77 "DW federated" dw\.corp\.example\.com/.test(l)));
	assert.doesNotMatch(JSON.stringify(err.decisions), /SECRET-FEDERATED-PASSWORD/);
	assert.ok(server.calls.some((c) => c.path === '/federated/v2/config/accounts/77/databases'), 'the database is confirmed by a browse');
});

test('extract, convert, push, re-push and unpush a federated DataSet', async () => {
	await setMappings([{ match: { class: 'sqlserver', server: 'dw', dbname: 'SUPPORT' }, accountId: 77, cacheTTL: 600 }]);
	const result = await extractWorkbook({ config, file: FIXTURE, emitter: quiet });
	const ws = openWorkspace(config.workspace);
	const manifest = JSON.parse(fs.readFileSync(path.join(ws.paths(result.slug).dataDir, fs.readdirSync(ws.paths(result.slug).dataDir).find((f) => f.endsWith('.manifest.json'))), 'utf8'));
	assert.equal(manifest.strategy, 'federated');
	assert.deepEqual(manifest.federated.tables, [{ tableId: manifest.federated.tables[0].tableId, name: 'Cases', catalog: 'SUPPORT', schema: 'dbo', table: 'Cases', verified: true }]);
	assert.equal(manifest.federated.providerKey, 'sqlserver-federated');

	const plan = await convertStage({ config, slug: result.slug, options: { target: 'pages' }, emitter: quiet });
	const ds = plan.datasets.find((d) => d.strategy === 'federated');
	assert.deepEqual(ds.federated, { accountId: 77, providerKey: 'sqlserver-federated', catalog: 'SUPPORT', schema: 'dbo', table: 'Cases', cacheTTL: 600 });
	assert.ok(ds.cardTarget);
	const report = fs.readFileSync(ws.paths(result.slug).report, 'utf8');
	assert.match(report, /Beast Modes run on the database/);

	const dry = await pushPlan({ config, slug: result.slug, dryRun: true, selection: { kinds: ['datasets'] }, emitter: quiet });
	const planned = dry.actions.find((r) => r.kind === 'dataset' && r.key === ds.key);
	assert.equal(planned.action, 'create');
	assert.deepEqual(planned.notes, ['federated sqlserver-federated, account 77, SUPPORT.dbo.Cases, cache 600 s']);

	server.reset();
	const first = await pushPlan({ config, slug: result.slug, selection: { kinds: ['datasets'] }, emitter: quiet, deps });
	assert.equal(first.actions.find((r) => r.key === ds.key).status, 'ok');
	const create = server.calls.find((c) => c.method === 'POST' && c.path === '/federated/v1/config/accounts/77/datasources');
	assert.deepEqual(create.body, { dataSourceName: ds.name, dataSourceDescription: ds.description, server: null, catalog: 'SUPPORT', schema: 'dbo', table: 'Cases', cacheTTL: 600, columns: [{ name: 'Status', type: 'STRING', sourceType: null }, { name: 'Count', type: 'LONG', sourceType: null }], additionalProperties: {} });
	const [fedId] = [...server.federated.keys()];

	server.reset();
	const second = await pushPlan({ config, slug: result.slug, selection: { kinds: ['datasets'] }, emitter: quiet, deps });
	assert.equal(second.actions.find((r) => r.key === ds.key).action, 'reuse');
	assert.ok(!server.calls.some((c) => c.path.startsWith('/federated/v1/config')), 'an unchanged federated DataSet is not written again');

	await setMappings([{ match: { class: 'sqlserver', server: 'dw', dbname: 'SUPPORT' }, accountId: 77, cacheTTL: 1200 }]);
	await extractWorkbook({ config, file: FIXTURE, emitter: quiet });
	await convertStage({ config, slug: result.slug, options: { target: 'pages' }, emitter: quiet });
	server.reset();
	const third = await pushPlan({ config, slug: result.slug, selection: { kinds: ['datasets'] }, emitter: quiet, deps });
	assert.equal(third.actions.find((r) => r.key === ds.key).action, 'update');
	assert.deepEqual(server.calls.filter((c) => c.path.startsWith('/federated/v1/config')).map((c) => [c.method, c.path, c.body]), [['POST', `/federated/v1/config/datasources/${fedId}`, { cacheTTL: 1200 }]]);

	server.reset();
	const removed = await unpushPlan({ config, slug: result.slug, emitter: quiet, deps });
	const row = removed.actions.find((r) => r.kind === 'dataset' && r.id === fedId);
	assert.equal(row.action, 'delete');
	assert.deepEqual(row.notes, ['federated DataSet only; the account and the database table stay']);
	assert.ok(server.calls.some((c) => c.method === 'DELETE' && c.path === `/data/v3/datasources/${fedId}`));
	assert.equal(server.federated.size, 0);
});

test('only plain tables qualify, and joins need federated-views', () => {
	const conn = { id: 'c', class: 'sqlserver', server: 'dw', dbname: 'OPS', extra: {} };
	const table = (id, extra = {}) => ({ id, name: id, kind: 'table', connectionId: 'c', table: `[dbo].[${id}]`, ...extra });
	const ds = (tables, more = {}) => ({ connections: [conn], tables, fields: [], ...more });
	assert.deepEqual(planFederatedTargets(ds([table('A')])).targets, [{ tableId: 'A', name: 'A', catalog: 'OPS', schema: 'dbo', table: 'A' }]);
	assert.equal(planFederatedTargets(ds([{ id: 'q', name: 'Q', kind: 'custom-sql', connectionId: 'c', sql: 'SELECT * FROM [Sales].[dbo].[Orders]' }]), { mapping: { databases: { Sales: 'SalesProd' } } }).targets[0].catalog, 'SalesProd');
	assert.match(planFederatedTargets(ds([{ id: 'q', name: 'Q', kind: 'custom-sql', connectionId: 'c', sql: 'SELECT a FROM t WHERE b = 1' }])).ineligible, /table 'Q' is custom SQL/);
	assert.match(planFederatedTargets({ ...ds([table('A')]), connections: [{ ...conn, extra: { 'one-time-sql': 'SELECT 1 AS x INTO #t' } }] }).ineligible, /runs Initial SQL/);
	assert.match(planFederatedTargets(ds([table('A'), table('B')]), { viewsEnabled: false }).ineligible, /feature federated-views is off/);
	assert.ok(planFederatedTargets(ds([table('A'), table('B')]), { viewsEnabled: true }).targets);
	assert.match(planFederatedTargets(ds([table('A'), table('B')], { relationTree: { type: 'union', children: [] } }), { viewsEnabled: true }).ineligible, /combined with a union, which needs Magic ETL/);
	const lod = { id: '[x]', name: 'Per Customer', kind: 'calculated', formula: '{FIXED [Customer] : SUM([Sales])}' };
	assert.match(planFederatedTargets(ds([table('A')], { fields: [lod] })).ineligible, /1 calculation\(s\) use LOD expressions or table calculations.*Per Customer/);
	assert.match(planFederatedTargets({ connections: [{ ...conn, class: 'excel-direct' }], tables: [table('A')] }).ineligible, /exactly one database connection/);
});

test('planDatasets: two federated tables join in a DataSet View, never in Magic ETL', async () => {
	const { planDatasets } = await import('../../src/convert/datasets.js');
	const col = (name, type = 'string') => ({ remoteName: name, localName: `[${name}]`, localType: type });
	const ds = {
		id: 'ds1',
		caption: 'Orders',
		connections: [{ id: 'c', class: 'sqlserver', server: 'dw', dbname: 'OPS', extra: {} }],
		tables: [
			{ id: 'o', name: 'Orders', kind: 'table', connectionId: 'c', table: '[dbo].[Orders]', columns: [col('OrderId'), col('CustomerId'), col('Amount', 'real')] },
			{ id: 'c', name: 'Customers', kind: 'table', connectionId: 'c', table: '[dbo].[Customers]', columns: [col('CustomerId'), col('Region')] }
		],
		relationTree: { type: 'join', join: 'left', children: [{ type: 'table', tableId: 'o' }, { type: 'table', tableId: 'c' }], on: [{ left: '[CustomerId]', right: '[CustomerId (Customers)]', op: '=' }] },
		relationships: [],
		fields: []
	};
	ds.tables[1].columns[0].localName = '[CustomerId (Customers)]';
	const manifest = {
		datasourceId: 'ds1',
		strategy: 'federated',
		tables: [],
		issues: [],
		federated: { accountId: 77, providerKey: 'sqlserver-federated', cacheTTL: 900, views: true, tables: [{ tableId: 'o', name: 'Orders', catalog: 'OPS', schema: 'dbo', table: 'Orders' }, { tableId: 'c', name: 'Customers', catalog: 'OPS', schema: 'dbo', table: 'Customers' }] }
	};
	const ir = { workbook: { name: 'W' }, datasources: [ds], worksheets: [{ name: 's', datasources: ['ds1'] }] };
	const { datasets, dataflows, issues } = planDatasets(ir, [manifest], { workbookKey: 'w' });
	assert.equal(dataflows.length, 0);
	assert.deepEqual(datasets.map((d) => d.strategy), ['federated', 'federated', 'view']);
	const view = datasets.at(-1);
	assert.equal(view.sourceStrategy, 'federated');
	assert.ok(view.cardTarget);
	assert.ok(issues.some((i) => i.code === 'data.federated-beast-modes'));
});
