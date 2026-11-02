import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promptDecisions } from '../../src/cli/decide.js';
import { main } from '../../src/cli/main.js';
import { compareHosts, getAccountSettings, matchAccounts, safeAccountSettings } from '../../src/domo/accounts.js';
import { compareSnowflakeAccounts } from '../../src/domo/cloud-amplifier.js';
import { migrateBatch } from '../../src/pipeline/batch.js';
import { DataDecisionError, choicesFor, completeDecision, describeDecision, formatDecisions, mergeDecisions, recordAnswers } from '../../src/pipeline/decisions.js';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter } from '../../src/util/events.js';
import { tempDir, testConfig } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/sqlserver-live.twb', import.meta.url));
const SECRETS = { password: 'SECRET-PASSWORD', privateKey: 'SECRET-PRIVATE-KEY', passPhrase: 'SECRET-PASSPHRASE', token: 'SECRET-TOKEN', secret: 'SECRET-SECRET', key: 'SECRET-KEY' };

const SQL = { id: 'c1', class: 'sqlserver', server: 'dw', dbname: 'SUPPORT', extra: {} };
const account = (id, settings, providerKey = 'ms-sql-server') => ({ id, name: `Account ${id}`, providerKey, settings });

test('compareHosts: short name vs FQDN, ports, instances and case', () => {
	assert.equal(compareHosts('dw', 'DW.corp.example.com'), 'short');
	assert.equal(compareHosts('dw.corp.example.com ', 'tcp:DW.corp.example.com,1433'), 'exact');
	assert.equal(compareHosts('dw\\SQL01', 'dw:1433'), 'exact');
	assert.equal(compareHosts('dw', 'replica.corp.example.com'), false);
	assert.equal(compareHosts('dw.a.com', 'dw.b.com'), false, 'two FQDNs must be equal');
	assert.equal(compareHosts('10.0.0.5', '10.0.0'), false);
});

test('matchAccounts: one confident match, several candidates, none', () => {
	const accounts = [
		account(1, { host: 'dw.corp.example.com', port: '1433', database: 'SUPPORT' }),
		account(2, { host: 'mysql.example.com', port: '3306', database: 'inventory' }),
		account(3, { host: 'DW', database: 'Salesforce' })
	];
	const one = matchAccounts(SQL, accounts, { family: 'sqlserver' });
	assert.equal(one.status, 'match');
	assert.deepEqual(one.matches.map((m) => [m.id, m.confident]), [[1, true], [3, false]]);
	assert.match(one.matches[1].notes.join(), /database Salesforce differs/);
	assert.deepEqual(one.others.map((o) => o.id), [2]);

	const several = matchAccounts(SQL, [...accounts, account(4, { host: 'dw', port: '1433' })], { family: 'sqlserver' });
	assert.equal(several.status, 'candidates');
	assert.equal(matchAccounts({ ...SQL, port: '1444' }, [accounts[0]], { family: 'sqlserver' }).status, 'candidates', 'a differing port is not confident');
	assert.equal(matchAccounts({ ...SQL, server: 'replica' }, accounts, { family: 'sqlserver' }).status, 'none');

	const sf = { class: 'snowflake', server: 'ab67890.us-east-1.snowflakecomputing.com', dbname: 'SALES_DB' };
	const snow = matchAccounts(sf, [account(9, { account: 'ab67890.us-east-1.aws' }, 'snowflakekeypairauthentication')], { family: 'snowflake', compareSnowflake: compareSnowflakeAccounts });
	assert.equal(snow.status, 'match');
	assert.equal(snow.matches[0].hostMatch, 'account');
});

test('safeAccountSettings keeps only allowlisted, unmasked, non-secret fields', () => {
	const raw = { host: 'dw', port: 1433, database: 'OPS', username: 'svc', account: '********', role: '', ...SECRETS, credentials: { password: 'x' } };
	assert.deepEqual(safeAccountSettings(raw), { host: 'dw', port: '1433', database: 'OPS', username: 'svc' });
});

test('getAccountSettings reads without unmask and returns no credential field', async () => {
	const calls = [];
	const client = {
		get: async (p, opts) => {
			calls.push([p, opts]);
			return p.endsWith('/41') && p.startsWith('/data/v1/accounts') ? { id: 41, displayName: 'SQL', dataProviderType: 'ms-sql-server', valid: true } : { host: 'h', database: 'd', ...SECRETS };
		}
	};
	const result = await getAccountSettings(client, 41);
	assert.deepEqual(result, { id: 41, name: 'SQL', providerKey: 'ms-sql-server', valid: true, settings: { host: 'h', database: 'd' } });
	assert.ok(calls.every(([, opts]) => !opts?.query?.unmask));
	assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

/** A Domo stub: Cloud Amplifier has no integrations; the SQL Server provider has accounts whose responses carry credentials. */
function fakeDomo(accounts) {
	const calls = [];
	return {
		calls,
		api: { listIntegrations: async () => [] },
		getDataset: async () => null,
		client: {
			get: async (p) => {
				calls.push(p);
				const id = p.split('/').at(-1);
				return { ...accounts[id], ...SECRETS };
			},
			post: async (p, body) => {
				calls.push(p);
				const provider = body.filters[0].value;
				const hits = provider === 'ms-sql-server' ? Object.keys(accounts).map((id) => ({ databaseId: id, displayName: `Account ${id}`, valid: true })) : [];
				return { totalResultCount: hits.length, searchObjects: hits };
			}
		}
	};
}

const DW_ACCOUNTS = { 41: { host: 'mysql.example.com', port: '3306', database: 'inventory', username: 'reader' }, 42: { host: 'dw.corp.example.com', port: '1433', database: 'SUPPORT', username: 'domo' } };

function collect() {
	const events = [];
	return { events, emitter: createEmitter((e) => events.push(e), 'extract') };
}

test('extract stops before any data with the open decision, a suggested account and no credentials anywhere', async () => {
	const root = tempDir();
	const config = testConfig(root);
	const domo = fakeDomo(DW_ACCOUNTS);
	const { events, emitter } = collect();
	const err = await extractWorkbook({ config, file: FIXTURE, emitter, deps: { domo } }).catch((e) => e);
	assert.ok(err instanceof DataDecisionError);
	assert.equal(err.code, 'extract.data-decision-needed');
	const [d] = err.decisions;
	assert.equal(d.key, 'Cases');
	assert.deepEqual(d.connections, [{ class: 'sqlserver', server: 'dw', dbname: 'SUPPORT', authentication: 'sspi' }]);
	assert.equal(d.accounts.status, 'match');
	assert.deepEqual(d.suggested, { choice: 'account', id: 42 });
	assert.deepEqual(d.entries.account, { accounts: [{ match: { class: 'sqlserver', server: 'dw', dbname: 'SUPPORT' }, accountId: 42 }] });
	assert.deepEqual(d.entries.export, { unmapped: { Cases: 'export' } });
	assert.ok(events.some((e) => e.type === 'decision' && e.data.key === 'Cases'));

	const ws = openWorkspace(root);
	const written = fs.readdirSync(ws.paths('sqlserver-live').dir, { recursive: true }).map(String);
	assert.ok(!written.some((f) => f.endsWith('.manifest.json') || f.endsWith('.csv')), 'no data was written');
	const files = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(root, f)).isFile());
	const derived = files.filter((f) => !/(source\.twbx?|workbook\.twb)$/.test(f));
	const everything = [JSON.stringify(events), JSON.stringify(err.decisions), formatDecisions(err.decisions), ...files.map((f) => fs.readFileSync(path.join(root, f), 'utf8'))].join('\n');
	assert.doesNotMatch(everything, /SECRET/);
	assert.doesNotMatch([JSON.stringify(err.decisions), ...derived.map((f) => fs.readFileSync(path.join(root, f), 'utf8'))].join('\n'), /hunter2/, 'the Tableau password stays in the workbook copy');
});

test('answers are written to mappings.json and used; the next run asks nothing', async () => {
	const root = tempDir();
	const config = testConfig(root);
	const domo = fakeDomo(DW_ACCOUNTS);
	let asked = 0;
	const decide = async (decisions) => (asked++, decisions.map((d) => ({ key: d.key, choice: 'account', id: '42' })));
	const first = await extractWorkbook({ config, file: FIXTURE, decide, deps: { domo } });
	assert.equal(asked, 1);
	assert.equal(first.manifests[0].strategy, 'connector');
	const ws = openWorkspace(root);
	const file = JSON.parse(fs.readFileSync(ws.mappingsFile, 'utf8'));
	assert.deepEqual(file.accounts, [{ match: { class: 'sqlserver', server: 'dw', dbname: 'SUPPORT' }, accountId: 42 }]);
	const again = await extractWorkbook({ config, file: FIXTURE, deps: { domo } });
	assert.equal(again.manifests[0].strategy, 'connector');
});

test('export and none answers are recorded per datasource; fail never calls decide; export policy never asks', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	await assert.rejects(extractWorkbook({ config, file: FIXTURE, unmapped: 'fail', decide: () => assert.fail('decide called') }), DataDecisionError);
	const exported = await extractWorkbook({ config, file: FIXTURE, unmapped: 'export' });
	assert.equal(exported.manifests[0].strategy, 'none', 'nothing could export it offline, but it was tried');
	assert.ok(exported.manifests[0].issues.some((i) => i.code === 'data.none'));

	const root2 = tempDir();
	const none = await extractWorkbook({ config: testConfig(root2, null), file: FIXTURE, decide: async ([d]) => [{ key: d.key, choice: 'none' }] });
	assert.equal(none.manifests[0].strategy, 'none');
	assert.ok(none.manifests[0].issues.some((i) => i.code === 'data.unmapped-none'));
	assert.deepEqual(JSON.parse(fs.readFileSync(openWorkspace(root2).mappingsFile, 'utf8')).unmapped, { Cases: 'none' });
});

test('a dry run and --no-extract-data never ask: the datasource gets no data and a pending warning', async () => {
	for (const opts of [{ dryRun: true }, { includeExtract: false }]) {
		const { manifests } = await extractWorkbook({ config: testConfig(tempDir(), null), file: FIXTURE, decide: () => assert.fail('decide called'), ...opts });
		assert.equal(manifests[0].strategy, 'none');
		const issue = manifests[0].issues.find((i) => i.code === 'data.decision-pending');
		assert.match(issue.suggestion, /"unmapped":\{"Cases":"export"\}/);
	}
});

test('a datasource exported by an earlier extract is not asked about', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	const ws = openWorkspace(root);
	const first = await extractWorkbook({ config, file: FIXTURE, dryRun: true });
	const dsId = first.manifests[0].datasourceId;
	const manifestFile = fs.readdirSync(ws.paths(first.slug).dataDir).find((f) => f.endsWith('.manifest.json'));
	fs.writeFileSync(path.join(ws.paths(first.slug).dataDir, manifestFile), JSON.stringify({ datasourceId: dsId, strategy: 'hyper', tables: [], issues: [] }));
	const again = await extractWorkbook({ config, file: FIXTURE, decide: () => assert.fail('decide called') });
	assert.notEqual(again.manifests[0].strategy, 'pending');
});

test('recordAnswers writes each kind of entry and keeps the rest of the file', async () => {
	const file = path.join(tempDir(), 'mappings.json');
	fs.writeFileSync(file, JSON.stringify({ columns: { 'A.b': 'c' }, accounts: [{ match: { class: 'sqlserver', server: 'dw', dbname: 'X' }, accountId: 1 }] }));
	const base = { connections: [{ class: 'sqlserver', server: 'dw', dbname: 'X' }], snapshot: ['vds'] };
	const decisions = [
		completeDecision({ ...base, datasource: { id: 'a', caption: 'A' } }, { key: 'A' }),
		completeDecision({ ...base, datasource: { id: 'b', caption: 'B' }, cloudAmplifier: [{ integrationId: 'int-1', name: 'SF', reason: 'share', match: { class: 'snowflake', dbname: 'SALES_DB' }, databases: { SALES_DB: 'PROD_SALES' } }] }, { key: 'B' }),
		completeDecision({ ...base, datasource: { id: 'c', caption: 'C' } }, { key: 'C' }),
		completeDecision({ ...base, datasource: { id: 'd', caption: 'D' } }, { key: 'D' })
	];
	assert.deepEqual(decisions[1].suggested, { choice: 'cloud-amplifier', id: 'int-1' }, 'a share suggestion is pre-filled');
	const recorded = await recordAnswers(file, decisions, [
		{ key: 'A', choice: 'account', id: '22' },
		{ key: 'B', choice: 'cloud-amplifier', id: 'int-1' },
		{ key: 'C', choice: 'dataset', id: 'ds-1' },
		{ key: 'D', choice: 'export' },
		{ key: 'A', choice: 'dataset' }
	]);
	assert.equal(recorded.length, 4, 'an answer without its id is not recorded');
	const out = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(out.columns, { 'A.b': 'c' });
	assert.deepEqual(out.accounts, [{ match: { class: 'sqlserver', server: 'dw', dbname: 'X' }, accountId: 22 }], 'the entry with the same match is replaced');
	assert.deepEqual(out.cloudAmplifier, [{ match: { class: 'snowflake', dbname: 'SALES_DB' }, integrationId: 'int-1', databases: { SALES_DB: 'PROD_SALES' } }]);
	assert.deepEqual(out.datasets, { C: 'ds-1' });
	assert.deepEqual(out.unmapped, { D: 'export' });
});

test('mergeDecisions asks about a datasource shared by several workbooks once', () => {
	const raw = { datasource: { id: 'x', caption: 'Orders', published: { luid: 'L1' } }, connections: [], snapshot: [] };
	const merged = mergeDecisions([completeDecision(raw, { key: 'L1', workbook: 'alpha' }), completeDecision(raw, { key: 'L1', workbook: 'beta' }), completeDecision({ ...raw, datasource: { id: 'y', caption: 'Other' } }, { key: 'Other', workbook: 'beta' })]);
	assert.deepEqual(merged.map((d) => [d.key, d.workbooks]), [['L1', ['alpha', 'beta']], ['Other', ['beta']]]);
});

function tty(lines) {
	const stdin = new PassThrough();
	stdin.isTTY = true;
	stdin.end(lines.map((l) => `${l}\n`).join(''));
	const err = [];
	return { stdin, stderr: { write: (s) => err.push(s) }, err: () => err.join('') };
}

test('the prompt lists zero-copy options first, pre-fills the suggestion, and re-asks on bad input', async () => {
	const raw = { connections: [{ class: 'sqlserver', server: 'dw', dbname: 'SUPPORT', username: 'svc', embedPassword: true }], snapshot: ['published-extract', 'vds'] };
	const decisions = [
		completeDecision({ ...raw, datasource: { id: 'a', caption: 'A' }, accounts: { providers: ['ms-sql-server'], status: 'match', matches: [{ id: 42, name: 'DW', host: 'dw.corp', confident: true, notes: [] }], others: [] } }, { key: 'A', workbook: 'wb' }),
		completeDecision({ ...raw, datasource: { id: 'b', caption: 'B' } }, { key: 'B', workbook: 'wb' }),
		completeDecision({ ...raw, datasource: { id: 'c', caption: 'C' } }, { key: 'C', workbook: 'wb' })
	];
	const io = tty(['', 'x', 'a', '', 'a', '41', 'e']);
	const answers = await promptDecisions(decisions, io);
	assert.deepEqual(answers, [
		{ key: 'A', choice: 'account', id: '42' },
		{ key: 'B', choice: 'account', id: '41' },
		{ key: 'C', choice: 'export' }
	]);
	const text = io.err();
	assert.ok(text.indexOf('Keeps the data out of Domo') < text.indexOf('Copies the data into Domo'));
	assert.match(text, /\(Enter: a 42\)/);
	assert.match(text, /Type one of c\/f\/d\/a\/e\/n/);
	assert.match(text, /No Domo connector account id given/);
	assert.match(text, /user svc, password embedded in Tableau, not readable/);

	const short = await promptDecisions(decisions, tty(['e']));
	assert.equal(short.length, 1, 'input ending early leaves the rest unanswered');
});

test('CLI: without a terminal extract exits 3 with the decisions and ready-to-paste entries; --unmapped export does not stop', async () => {
	const root = tempDir();
	const out = [];
	const err = [];
	const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdin: { isTTY: false }, env: { NO_COLOR: '1' }, loadConfig: () => testConfig(root, null) };
	assert.equal(await main(['extract', '--file', FIXTURE], io), 3);
	assert.match(err.join(''), /1 datasource\(s\) need a data decision/);
	assert.match(err.join(''), /\{"unmapped":\{"Cases":"export"\}\}/);
	assert.match(err.join(''), /--unmapped export/);

	out.length = 0;
	assert.equal(await main(['--json', 'extract', '--file', FIXTURE], io), 3);
	const result = JSON.parse(out.join('').trim().split('\n').at(-1));
	assert.equal(result.exitCode, 3);
	assert.equal(result.error.code, 'extract.data-decision-needed');
	assert.equal(result.decisions[0].key, 'Cases');
	assert.ok(out.join('').split('\n').filter(Boolean).some((l) => JSON.parse(l).type === 'decision'));

	assert.equal(await main(['extract', '--file', FIXTURE, '--unmapped', 'export'], io), 0);
});

const LUID = '11111111-2222-3333-4444-555555555555';

function batchStubs(calls) {
	const ir = (name) => ({
		irVersion: 1,
		workbook: { name, sourceFile: '' },
		datasources: [{ id: `sqlproxy.${name}`, caption: 'Orders', published: { luid: LUID, name: 'Orders' }, connections: [{ id: 'default', class: 'sqlproxy', extra: {} }], tables: [], relationships: [], fields: [{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' }], filters: [] }],
		parameters: [],
		worksheets: [{ name: 'Sheet 1', datasourceIds: [`sqlproxy.${name}`], pills: {}, rows: null, cols: null, rowPills: [], colPills: [], panes: [], filters: [], sorts: [], aggregated: true, measureValues: [], hidden: false }],
		dashboards: [],
		issues: []
	});
	return {
		client: { TableauClient: class {} },
		content: {
			findWorkbook: async (_c, name) => ({ id: name, name }),
			findDatasource: async (_c, { luid }) => ({ id: luid, updatedAt: '2026-10-01T00:00:00Z' }),
			downloadWorkbook: async (_c, luid, dir, { includeExtract }) => {
				calls.push(`download:${luid}:${includeExtract}`);
				const file = path.join(dir, 'wb.twb');
				fs.writeFileSync(file, '<workbook/>');
				return { file };
			}
		},
		metadata: { fetchWorkbookMetadata: async () => null, applyMetadata: () => {} },
		package: { openPackage: async () => ({ kind: 'twb', xml: '<workbook/>', close: () => {} }) },
		twb: { buildWorkbookIR: (_xml, { info }) => ir(info.name) },
		data: {
			datasourceSlug: () => 'orders',
			extractData: async ({ datasource, dir, slug, unmapped, planOnly, snapshotOnly, mappings }) => {
				const decided = mappings.unmapped?.[LUID] === 'export' || unmapped === 'export';
				if (unmapped === 'ask' && !decided) {
					calls.push('pending');
					return { datasourceId: datasource.id, strategy: 'pending', tables: [], issues: [], decision: { datasource: { id: datasource.id, caption: 'Orders', published: { luid: LUID } }, connections: [{ class: 'sqlserver', server: 'dw', dbname: 'OPS' }], snapshot: ['vds'] } };
				}
				if (planOnly) return { datasourceId: datasource.id, strategy: 'deferred', tables: [], issues: [] };
				calls.push(`export:${snapshotOnly ? 'resumed' : 'direct'}`);
				fs.mkdirSync(path.join(dir, 'data', slug), { recursive: true });
				fs.writeFileSync(path.join(dir, 'data', slug, 'orders.csv'), 'Region\nEast\n');
				return { datasourceId: datasource.id, strategy: 'vds', tables: [{ name: 'Orders', file: `data/${slug}/orders.csv`, columns: [{ name: 'Region', type: 'STRING', sourceName: 'Region' }], rowCount: 1, flattened: true }], issues: [] };
			}
		}
	};
}

test('a batch asks every decision up front, a shared datasource once, before any workbook downloads data', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	const calls = [];
	const deps = { client: { signIn: async () => {}, signOut: async () => {} }, content: { listWorkbooks: async () => [{ id: 'alpha', name: 'alpha' }, { id: 'beta', name: 'beta' }] }, workbook: { extract: batchStubs(calls) } };
	await assert.rejects(migrateBatch({ config, project: 'P', skipPush: true, deps }), (e) => e instanceof DataDecisionError && e.decisions.length === 1 && e.decisions[0].workbooks.join() === 'alpha,beta');
	assert.deepEqual(calls, ['download:alpha:false', 'pending', 'download:beta:false', 'pending'], 'nothing exported before the decision');

	calls.length = 0;
	const seen = [];
	const summary = await migrateBatch({ config, project: 'P', skipPush: true, deps, decide: async (decisions) => (seen.push(decisions), decisions.map((d) => ({ key: d.key, choice: 'export' }))) });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].length, 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(openWorkspace(root).mappingsFile, 'utf8')).unmapped, { [LUID]: 'export' });
	assert.deepEqual(summary.counts, { converted: 2 });
	assert.equal(calls.filter((c) => c.startsWith('export')).length, 1, 'the shared datasource is exported once');
});

test('a datasource Cloud Amplifier cannot serve hides that choice and says why', () => {
	const decision = completeDecision(
		{ datasource: { id: 'ds', caption: 'DS' }, connections: [{ class: 'snowflake' }], snapshot: [], cloudAmplifierBlocked: { reason: 'the snowflake connection runs Initial SQL' } },
		{ key: 'ds', workbook: 'wb' }
	);
	assert.ok(!choicesFor(decision).some((c) => c.choice === 'cloud-amplifier'));
	assert.ok(describeDecision(decision).some((l) => /Cloud Amplifier: not possible, the snowflake connection runs Initial SQL/.test(l)));
});
