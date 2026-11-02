import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSqlTableRefs, renameSqlDatabases } from '../../src/tableau/data/sql-refs.js';
import { createBrowser, findCloudAmplifierMapping, matchCloudAmplifier, matchConnection, planTargets } from '../../src/tableau/data/cloud-amplifier.js';
import { extractData } from '../../src/tableau/data/index.js';
import { tempDir } from './helpers.js';

const SF = { id: 'c1', class: 'snowflake', server: 'xy12345.us-east-1.snowflakecomputing.com', dbname: 'ANALYTICS', schema: 'REPORTING', warehouse: 'WH', extra: {} };

function integration(id, extra = {}) {
	return { id, engine: 'SNOWFLAKE', name: id, writeable: false, initialized: true, ...extra };
}

/** Fake Cloud Amplifier browse API: warehouses[id] = { DB: { SCHEMA: { TABLE: columns } } } or an Error. */
function fakeApi(warehouses, calls = []) {
	const at = (id) => {
		const w = warehouses[id];
		if (w instanceof Error) throw w;
		if (!w) throw Object.assign(new Error('not found'), { status: 404 });
		return w;
	};
	return {
		calls,
		listDatabases: async (_c, id) => (calls.push(`db:${id}`), Object.keys(at(id))),
		listSchemas: async (_c, id, db) => (calls.push(`schema:${id}:${db}`), Object.keys(at(id)[db])),
		listObjects: async (_c, id, db, schema) =>
			Object.entries(at(id)[db][schema]).map(([tableName, t]) => ({ tableName, ...(t.datasource ? { datasource: t.datasource } : {}) })),
		getObjectColumns: async (_c, id, db, schema, object) => at(id)[db][schema][object].columns
	};
}

const warehouse = (tables) => ({ ANALYTICS: { REPORTING: tables } });
const orders = { columns: [{ name: 'ORDER_ID', type: 'LONG' }, { name: 'REGION', type: 'STRING' }] };

function snowflakeSource(extra = {}) {
	return {
		id: 'federated.1',
		caption: 'Orders',
		connections: [SF],
		tables: [
			{
				id: 'ORDERS_1',
				name: 'ORDERS',
				kind: 'table',
				connectionId: 'c1',
				table: '[ANALYTICS].[REPORTING].[ORDERS]',
				columns: [
					{ remoteName: 'ORDER_ID', localName: '[ORDER_ID]', localType: 'integer' },
					{ remoteName: 'REGION', localName: '[Region]', localType: 'string' }
				]
			}
		],
		relationships: [],
		fields: [
			{ id: '[ORDER_ID]', name: 'Order Id', datatype: 'integer', role: 'dimension', kind: 'column' },
			{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' }
		],
		filters: [],
		...extra
	};
}

const noRetry = { attempts: 1 };

test('parseSqlTableRefs finds FROM/JOIN tables with offsets and skips CTEs and EXTRACT(... FROM ...)', () => {
	const sql = 'WITH recent AS (SELECT * FROM "ANALYTICS".sales.orders o WHERE EXTRACT(year FROM o.d) > 2020)\nSELECT * FROM recent r JOIN people p ON r.x = p.x, ANALYTICS.SALES.returns';
	const { refs, unsupported } = parseSqlTableRefs(sql);
	assert.equal(unsupported, undefined);
	assert.deepEqual(
		refs.map((r) => r.parts.map((p) => p.name).join('.')),
		['ANALYTICS.sales.orders', 'people', 'ANALYTICS.SALES.returns']
	);
	assert.equal(sql.slice(refs[0].start, refs[0].end), '"ANALYTICS".sales.orders');
	assert.equal(refs[0].parts[0].quoted, true);
	assert.equal(refs[0].parts[1].quoted, false);
	assert.match(parseSqlTableRefs('select * from table(flatten(x))').unsupported, /table\(/);
	assert.match(parseSqlTableRefs('select * from @stage/file').unsupported, /stage/);
	assert.match(parseSqlTableRefs('select 1').unsupported, /no table/);
	assert.deepEqual(parseSqlTableRefs("select 'from x' as a from (select * from t) d -- from y").refs.map((r) => r.parts[0].name), ['t']);
});

test('planTargets rejects initial SQL, files and unparseable custom SQL', () => {
	assert.match(planTargets(snowflakeSource({ connections: [{ ...SF, extra: { 'one-time-sql': 'create temp table x' } }] })).ineligible, /Initial SQL/);
	assert.match(planTargets(snowflakeSource({ connections: [{ id: 'c1', class: 'textscan', extra: {} }] })).ineligible, /textscan/);
	const sql = snowflakeSource();
	sql.tables = [{ id: 'q', name: 'Custom SQL Query', kind: 'custom-sql', connectionId: 'c1', sql: 'select * from table(generator(rowcount => 1))', columns: [] }];
	assert.equal(planTargets(sql).customSql, true);
});

test('a Snowflake integration that does not list the database is not a match', async () => {
	const api = fakeApi({ acme: { HR_DB: {}, GOVERNANCE: {}, RAW_FINANCE: {}, SNOWFLAKE_LEARNING_DB: {} } });
	const browser = createBrowser({}, api, { retry: noRetry });
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('acme')], browser });
	assert.equal(result.status, 'none');
	assert.match(result.reason, /database ANALYTICS is not visible/);
});

test('browse picks the one integration that can read the table, with canonical names and columns', async () => {
	const api = fakeApi({ a: { OTHER: {} }, b: warehouse({ ORDERS: { ...orders, datasource: 'existing-ds' } }) });
	const browser = createBrowser({}, api, { retry: noRetry, getDataset: async () => ({ dataProviderType: 'snowflake' }) });
	const result = await matchCloudAmplifier({ source: snowflakeSource({ connections: [{ ...SF, server: undefined }] }), integrations: [integration('a'), integration('b')], browser });
	assert.equal(result.status, 'match');
	assert.equal(result.info.matchedBy, 'browse');
	assert.deepEqual(result.info.tables[0], {
		integrationId: 'b',
		integrationName: 'b',
		engine: 'SNOWFLAKE',
		dataProviderKey: 'snowflake',
		databaseName: 'ANALYTICS',
		schemaName: 'REPORTING',
		tableName: 'ORDERS',
		columns: orders.columns,
		verified: true,
		registeredDatasetId: 'existing-ds'
	});
	assert.deepEqual(result.info.relations, [{ tableId: 'ORDERS_1', name: 'ORDERS', kind: 'table', table: 0 }]);
});

test('a host match narrows the candidates; another host excludes an integration', async () => {
	const api = fakeApi({ same: warehouse({ ORDERS: orders }), other: warehouse({ ORDERS: orders }), unknown: warehouse({ ORDERS: orders }) });
	const browser = createBrowser({}, api, { retry: noRetry });
	const integrations = [
		integration('same', { host: 'xy12345.us-east-1.snowflakecomputing.com' }),
		integration('other', { host: 'zzz.snowflakecomputing.com' }),
		integration('unknown')
	];
	const result = await matchConnection(SF, planTargets(snowflakeSource()).byConnection.get('c1').targets, { integrations, browser });
	assert.equal(result.status, 'match');
	assert.equal(result.integration.id, 'same');
	assert.equal(result.matchedBy, 'host');
	assert.ok(!api.calls.some((c) => c.includes('other')));
});

test('a browse-only match is unconfirmed when the connection names a server the integration does not expose', async () => {
	const api = fakeApi({ dev: warehouse({ ORDERS: orders }) });
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('dev')], browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'unconfirmed');
	assert.equal(result.integration.id, 'dev');
	const manifest = await extractData({
		datasource: snowflakeSource(),
		dir: tempDir(),
		strategy: 'auto',
		cloudAmplifier: { getIntegrations: async () => [integration('dev')], browser: createBrowser({}, api, { retry: noRetry }) }
	});
	assert.notEqual(manifest.strategy, 'cloud-amplifier');
	const issue = manifest.issues.find((i) => i.code === 'data.cloud-amplifier-unconfirmed');
	assert.equal(issue.severity, 'warning');
	assert.match(issue.suggestion, /"integrationId":"dev"/);
});

test('quoted relation names do not match an object that differs only in case', async () => {
	const api = fakeApi({ a: { ANALYTICS: { REPORTING: { Orders: orders } } } });
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a', { host: SF.server })], browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'none');
	assert.match(result.reason, /ORDERS is not visible/);
});

test('several integrations that can read the tables are ambiguous', async () => {
	const api = fakeApi({ a: warehouse({ ORDERS: orders }), b: warehouse({ ORDERS: orders }) });
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a'), integration('b')], browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'ambiguous');
	assert.deepEqual(result.candidates.map((i) => i.id), ['a', 'b']);
});

test('a warehouse incident is unknown, never a non-match', async () => {
	const incident = Object.assign(new Error('HTTP 400'), { status: 400, body: 'Could not fetch schemas: Snowflake Incident (https://status.snowflake.com)' });
	const api = fakeApi({ a: incident });
	const sleeps = [];
	const browser = createBrowser({}, api, { retry: { attempts: 3, delaysMs: [1, 2], sleep: async (ms) => sleeps.push(ms) } });
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a')], browser });
	assert.equal(result.status, 'unknown');
	assert.deepEqual(sleeps, [1, 2]);
	assert.equal(api.calls.filter((c) => c === 'db:a').length, 3);
});

test('mappings.cloudAmplifier pins or disables an integration', async () => {
	const mappings = { cloudAmplifier: [{ match: { class: 'snowflake', server: 'https://XY12345.us-east-1.snowflakecomputing.com:443' }, integrationId: 'pinned', dataProviderKey: 'snowflake-custom' }] };
	assert.equal(findCloudAmplifierMapping(SF, mappings).integrationId, 'pinned');
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: null, mappings, browser: null });
	assert.equal(result.status, 'match');
	assert.equal(result.info.matchedBy, 'mapping');
	assert.equal(result.info.tables[0].dataProviderKey, 'snowflake-custom');
	assert.equal(result.info.tables[0].verified, false);
	assert.deepEqual(result.info.tables[0].columns, [
		{ name: 'ORDER_ID', type: 'LONG' },
		{ name: 'REGION', type: 'STRING' }
	]);
	const disabled = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a')], mappings: { cloudAmplifier: [{ match: { class: 'snowflake' }, integrationId: false }] } });
	assert.equal(disabled.status, 'disabled');
});

test('mappings.cloudAmplifier databases renames a database shared under another name', async () => {
	const api = fakeApi({ a: { PROD_ANALYTICS: { REPORTING: { ORDERS: orders } } } });
	const mappings = { cloudAmplifier: [{ match: { class: 'snowflake', dbname: 'analytics' }, integrationId: 'a', databases: { analytics: 'PROD_ANALYTICS' } }] };
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a')], mappings, browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'match');
	assert.equal(result.info.tables[0].databaseName, 'PROD_ANALYTICS');
	assert.equal(result.info.tables[0].verified, true);
	const without = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a')], mappings: { cloudAmplifier: [{ ...mappings.cloudAmplifier[0], databases: undefined }] }, browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(without.status, 'none');
	assert.match(without.reason, /ANALYTICS is not visible/);
});

test('custom SQL over visible tables becomes registrations plus SQL refs; unquoted names fold to upper case', async () => {
	const source = snowflakeSource();
	const sql = 'select o.*, r.reason from reporting.orders o left join REPORTING."Returns" r on o.order_id = r.order_id';
	source.tables = [
		{ id: 'q1', name: 'Custom SQL Query', kind: 'custom-sql', connectionId: 'c1', sql, columns: [{ remoteName: 'ORDER_ID', localName: '[ORDER_ID]', localType: 'integer' }] }
	];
	const api = fakeApi({ a: warehouse({ ORDERS: orders, Returns: { columns: [{ name: 'reason', type: 'STRING' }] } }) });
	const result = await matchCloudAmplifier({ source, integrations: [integration('a', { host: SF.server })], browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'match');
	assert.deepEqual(result.info.tables.map((t) => t.tableName), ['ORDERS', 'Returns']);
	const rel = result.info.relations[0];
	assert.equal(rel.kind, 'custom-sql');
	assert.deepEqual(rel.refs.map((r) => [sql.slice(r.start, r.end), r.table]), [
		['reporting.orders', 0],
		['REPORTING."Returns"', 1]
	]);
	assert.deepEqual(rel.columns, [{ name: 'ORDER_ID', type: 'LONG' }]);
});

test('extractData auto prefers cloud-amplifier over a packaged extract and records the manifest', async () => {
	const dir = tempDir();
	const api = fakeApi({ a: warehouse({ ORDERS: orders }) });
	const browser = createBrowser({}, api, { retry: noRetry });
	const ds = snowflakeSource({ extract: { enabled: true, hyperFiles: ['Data/x.hyper'] } });
	const manifest = await extractData({ datasource: ds, dir, cloudAmplifier: { getIntegrations: async () => [integration('a', { host: SF.server })], browser } });
	assert.equal(manifest.strategy, 'cloud-amplifier');
	assert.deepEqual(manifest.tables, []);
	assert.equal(manifest.cloudAmplifier.tables[0].tableName, 'ORDERS');
	assert.ok(manifest.issues.some((i) => i.code === 'data.cloud-amplifier' && /extract is bypassed/.test(i.message)));
});

test('extractData falls back with an issue when the match is ambiguous, and skips lookups for ineligible datasources', async () => {
	const dir = tempDir();
	const api = fakeApi({ a: warehouse({ ORDERS: orders }), b: warehouse({ ORDERS: orders }) });
	const browser = createBrowser({}, api, { retry: noRetry });
	const manifest = await extractData({ datasource: snowflakeSource(), dir, strategy: 'auto', cloudAmplifier: { getIntegrations: async () => [integration('a'), integration('b')], browser } });
	assert.notEqual(manifest.strategy, 'cloud-amplifier');
	const issue = manifest.issues.find((i) => i.code === 'data.cloud-amplifier-ambiguous');
	assert.ok(issue);
	assert.match(issue.suggestion, /"integrationId":"a"/);

	let listed = false;
	const csv = snowflakeSource({ connections: [{ id: 'c1', class: 'textscan', extra: {} }] });
	await extractData({ datasource: csv, dir, strategy: 'auto', cloudAmplifier: { getIntegrations: async () => ((listed = true), []), browser } });
	assert.equal(listed, false);
});

test('extractData with --data-strategy cloud-amplifier errors when nothing matches', async () => {
	const dir = tempDir();
	const api = fakeApi({ a: { OTHER: {} } });
	const manifest = await extractData({
		datasource: snowflakeSource(),
		dir,
		strategy: 'cloud-amplifier',
		cloudAmplifier: { getIntegrations: async () => [integration('a')], browser: createBrowser({}, api, { retry: noRetry }) }
	});
	assert.equal(manifest.strategy, 'none');
	assert.ok(manifest.issues.some((i) => i.severity === 'error' && i.code === 'data.cloud-amplifier-none'));
});

test('cloudAmplifierLookup lists integrations once and exposes a browser afterwards', async () => {
	const { cloudAmplifierLookup } = await import('../../src/pipeline/extract.js');
	let listed = 0;
	const api = { ...fakeApi({ a: warehouse({ ORDERS: orders }) }), listIntegrations: async () => (listed++, [integration('a')]) };
	const emitter = { step() {}, info() {}, warn() {}, progress() {}, child: () => emitter };
	const lookup = cloudAmplifierLookup({ config: { domo: { instance: 'acme' } }, emitter, domo: { client: {}, api, getDataset: async () => ({}), retry: noRetry } });
	assert.equal(lookup.browser, null);
	const [first, second] = await Promise.all([lookup.getIntegrations(), lookup.getIntegrations()]);
	assert.equal(first, second);
	assert.equal(listed, 1);
	assert.equal((await lookup.browser.databases('a')).value[0], 'ANALYTICS');
});

test('renameSqlDatabases renames the database of three-part names only, keeping their quoting', () => {
	const sql = 'select * from analytics.s.t join "ANALYTICS"."S"."U" u on 1=1 join [ANALYTICS].[dbo].[V] v on 1=1 join S.ANALYTICS x on 1=1 -- ANALYTICS.s.t';
	assert.deepEqual(renameSqlDatabases(sql, { ANALYTICS: 'PROD' }), {
		sql: 'select * from PROD.s.t join "PROD"."S"."U" u on 1=1 join [PROD].[dbo].[V] v on 1=1 join S.ANALYTICS x on 1=1 -- ANALYTICS.s.t',
		renamed: 3
	});
	assert.deepEqual(renameSqlDatabases('select 1 from a.b.c', {}), { sql: 'select 1 from a.b.c', renamed: 0 });
});

function accountApi(warehouses, accounts, calls = []) {
	return {
		...fakeApi(warehouses, calls),
		getSnowflakeAccount: async (_c, id) => {
			calls.push(`account:${id}`);
			const value = accounts[id];
			return typeof value === 'string' ? { account: value, providerKey: 'snowflakekeypairauthentication' } : (value ?? { reason: `service account ${id}: HTTP 404` });
		}
	};
}

const ACME_SF = { ...SF, server: 'acme-analytics.snowflakecomputing.com' };
const acmeSource = (extra) => snowflakeSource({ connections: [ACME_SF], ...extra });

test('a Snowflake integration in the same account is trusted, but its browse still has to pass', async () => {
	const api = accountApi({ prod: warehouse({ ORDERS: orders }), dev: warehouse({ ORDERS: orders }) }, { 1: 'ACME-ANALYTICS', 2: 'ACME-ANALYTICS_DEV' });
	const integrations = [integration('prod', { serviceAccountId: '1' }), integration('dev', { serviceAccountId: '2' })];
	const result = await matchCloudAmplifier({ source: acmeSource(), integrations, browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'match');
	assert.equal(result.info.matchedBy, 'account');
	assert.deepEqual(result.info.integrations, [{ id: 'prod', name: 'prod', engine: 'SNOWFLAKE', account: 'ACME-ANALYTICS', accountMatch: 'equal' }]);
	assert.ok(!api.calls.includes('db:dev'));

	const empty = accountApi({ prod: { OTHER: {} } }, { 1: 'ACME-ANALYTICS' });
	const failed = await matchCloudAmplifier({ source: acmeSource(), integrations: [integration('prod', { serviceAccountId: '1' })], browser: createBrowser({}, empty, { retry: noRetry }) });
	assert.equal(failed.status, 'none');
});

test('an integration in another Snowflake account is never picked, even when the browse passes', async () => {
	const api = accountApi({ other: warehouse({ ORDERS: orders }) }, { 1: 'EXAMPLE-PARTNER' });
	const result = await matchCloudAmplifier({ source: acmeSource(), integrations: [integration('other', { serviceAccountId: '1' })], browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'none');
	assert.match(result.reason, /account EXAMPLE-PARTNER/);
	assert.deepEqual(result.accounts, [{ id: 'other', name: 'other', account: 'EXAMPLE-PARTNER', result: 'differs' }]);
	assert.equal(result.suggestions[0].integration.id, 'other');
	assert.equal(result.suggestions[0].databases, undefined);
});

test('an unknown account (locator vs org name, or an unreadable service account) keeps the browse-only behavior', async () => {
	const api = accountApi({ a: warehouse({ ORDERS: orders }), b: warehouse({ ORDERS: orders }) }, { 1: 'ACME-ANALYTICS' });
	const browser = createBrowser({}, api, { retry: noRetry });
	const result = await matchCloudAmplifier({ source: snowflakeSource(), integrations: [integration('a', { serviceAccountId: '1' })], browser });
	assert.equal(result.status, 'unconfirmed');
	assert.equal(result.accounts[0].result, 'unknown');
	const unreadable = await matchCloudAmplifier({ source: acmeSource(), integrations: [integration('b', { serviceAccountId: '404' })], browser });
	assert.equal(unreadable.status, 'unconfirmed');
	assert.deepEqual(unreadable.accounts, [{ id: 'b', name: 'b', result: 'unknown', reason: 'service account 404: HTTP 404' }]);
});

test('accounts are resolved once per service account for the run', async () => {
	const api = accountApi({ a: warehouse({ ORDERS: orders }), b: { OTHER: {} } }, { 1: 'ACME-ANALYTICS' });
	const browser = createBrowser({}, api, { retry: noRetry });
	const integrations = [integration('a', { serviceAccountId: '1' }), integration('b', { serviceAccountId: '1' })];
	await matchCloudAmplifier({ source: acmeSource(), integrations, browser });
	await matchCloudAmplifier({ source: acmeSource(), integrations, browser });
	assert.equal(api.calls.filter((c) => c === 'account:1').length, 1);
});

test('a mappings.json entry wins over a different account', async () => {
	const api = accountApi({ other: warehouse({ ORDERS: orders }) }, { 1: 'EXAMPLE-PARTNER' });
	const mappings = { cloudAmplifier: [{ match: { class: 'snowflake' }, integrationId: 'other' }] };
	const result = await matchCloudAmplifier({ source: acmeSource(), integrations: [integration('other', { serviceAccountId: '1' })], mappings, browser: createBrowser({}, api, { retry: noRetry }) });
	assert.equal(result.status, 'match');
	assert.equal(result.info.matchedBy, 'mapping');
	assert.equal(result.info.integrations[0].accountMatch, 'differs');
});

test('a secure share under a renamed database is suggested with a databases rename, never applied', async () => {
	const shared = { PROD_ANALYTICS: { REPORTING: { ORDERS: orders } }, PROD_OTHER: { X: {} }, UNRELATED: { REPORTING: {} } };
	const api = accountApi({ consumer: shared }, { 1: 'ACME-CONSUMER' });
	const browser = createBrowser({}, api, { retry: noRetry });
	const integrations = [integration('consumer', { serviceAccountId: '1' })];
	const result = await matchCloudAmplifier({ source: acmeSource(), integrations, browser });
	assert.equal(result.status, 'none');
	assert.deepEqual(result.suggestions.map((s) => [s.integration.id, s.databases]), [['consumer', { ANALYTICS: 'PROD_ANALYTICS' }]]);
	assert.ok(!api.calls.includes('schema:consumer:UNRELATED'));

	const manifest = await extractData({ datasource: acmeSource(), dir: tempDir(), strategy: 'auto', cloudAmplifier: { getIntegrations: async () => integrations, browser } });
	assert.notEqual(manifest.strategy, 'cloud-amplifier');
	const issue = manifest.issues.find((i) => i.code === 'data.cloud-amplifier-share');
	assert.equal(issue.severity, 'warning');
	assert.match(issue.message, /account ACME-CONSUMER differs/);
	assert.match(issue.message, /PROD_ANALYTICS \(for ANALYTICS\)/);
	const snippet = JSON.parse(issue.suggestion.replace(/^[^{]*/, ''));
	assert.deepEqual(snippet.cloudAmplifier[0], {
		match: { class: 'snowflake', server: ACME_SF.server, dbname: 'ANALYTICS' },
		integrationId: 'consumer',
		databases: { ANALYTICS: 'PROD_ANALYTICS' }
	});
	const pinned = await matchCloudAmplifier({ source: acmeSource(), integrations, mappings: snippet, browser });
	assert.equal(pinned.status, 'match');
	assert.equal(pinned.info.tables[0].databaseName, 'PROD_ANALYTICS');
});

test('extract report lines name each integration account and whether it matches', async () => {
	const api = accountApi({ prod: warehouse({ ORDERS: orders }), dev: { OTHER: {} } }, { 1: 'ACME-ANALYTICS', 2: 'EXAMPLE-DEV' });
	const integrations = [integration('prod', { serviceAccountId: '1' }), integration('dev', { serviceAccountId: '2' })];
	const manifest = await extractData({ datasource: acmeSource(), dir: tempDir(), cloudAmplifier: { getIntegrations: async () => integrations, browser: createBrowser({}, api, { retry: noRetry }) } });
	assert.equal(manifest.strategy, 'cloud-amplifier');
	assert.match(manifest.issues.find((i) => i.code === 'data.cloud-amplifier').message, /"prod" \(SNOWFLAKE, prod, account ACME-ANALYTICS matches\), matched by account/);

	const none = await extractData({
		datasource: snowflakeSource(),
		dir: tempDir(),
		cloudAmplifier: { getIntegrations: async () => [integration('dev', { serviceAccountId: '2' })], browser: createBrowser({}, api, { retry: noRetry }) }
	});
	assert.match(none.issues.find((i) => i.code === 'data.cloud-amplifier-none').message, /Snowflake accounts vs xy12345\.us-east-1\.snowflakecomputing\.com: "dev" account EXAMPLE-DEV unknown/);
});

test('no credential field from the account API reaches events, issues or the manifest', async () => {
	const { cloudAmplifierLookup } = await import('../../src/pipeline/extract.js');
	const { createEmitter } = await import('../../src/util/events.js');
	const domoApi = await import('../../src/domo/cloud-amplifier.js');
	const { mockFetch, testClient } = await import('../domo/helpers.js');
	const secrets = { privateKey: 'SECRET-PRIVATE-KEY', passPhrase: 'SECRET-PASS', password: 'SECRET-PASSWORD', role: 'SECRET-ROLE', username: 'SECRET-USER' };
	const mock = mockFetch([
		{ method: 'GET', path: '/query/v1/byos/accounts', json: [{ id: 'prod', engine: 'SNOWFLAKE', friendlyName: 'Prod', serviceAccountId: '1' }, { id: 'denied', engine: 'SNOWFLAKE', friendlyName: 'Denied', serviceAccountId: '2' }] },
		{ method: 'GET', path: '/data/v1/accounts/1', json: { dataProviderType: 'snowflakekeypairauthentication', configurations: secrets } },
		{ method: 'GET', path: '/data/v1/providers/snowflakekeypairauthentication/account/1', json: { ...secrets, account: 'ACME-ANALYTICS' } },
		{ method: 'GET', path: '/data/v1/accounts/2', status: 403, json: secrets },
		{ method: 'GET', path: /\/account\/2$/, status: 404, json: secrets, repeat: true },
		{ method: 'GET', path: /^\/query\/v1\/byos\/accounts\/prod\/databases$/, json: [{ databaseName: 'ANALYTICS' }] },
		{ method: 'GET', path: /\/databases\/ANALYTICS\/schemas$/, json: [{ schemaName: 'REPORTING' }], repeat: true },
		{ method: 'GET', path: /\/schemas\/REPORTING\/objects$/, json: [{ tableName: 'ORDERS' }], repeat: true },
		{ method: 'GET', path: /\/objects\/ORDERS$/, json: { columns: orders.columns }, repeat: true },
		{ method: 'GET', path: /^\/query\/v1\/byos\/accounts\/denied\/databases$/, json: [{ databaseName: 'OTHER' }] }
	]);
	try {
		const { client } = testClient();
		const events = [];
		const emitter = createEmitter((e) => events.push(e), 'extract');
		const retry = { attempts: 1 };
		const lookup = cloudAmplifierLookup({ config: { domo: { instance: 'acme' } }, emitter, domo: { client, api: domoApi, getDataset: async () => ({}), retry } });
		const manifest = await extractData({ datasource: acmeSource(), dir: tempDir(), cloudAmplifier: lookup, emitter });
		assert.equal(manifest.strategy, 'cloud-amplifier');
		assert.match(JSON.stringify(manifest.issues), /ACME-ANALYTICS matches/);
		assert.doesNotMatch(JSON.stringify({ events, manifest }), /SECRET/);
	} finally {
		mock.restore();
	}
});

test('ERP_DB shared under a renamed database is suggested ("erp" is a 3-letter word) and pre-fills the export decision', async () => {
	const feedback = { ...SF, server: 'ab67890.us-east-1', dbname: 'ERP_DB', schema: 'FEEDBACK' };
	const source = snowflakeSource({ connections: [feedback], tables: [{ ...snowflakeSource().tables[0], table: '[ERP_DB].[FEEDBACK].[ORDERS]' }] });
	const api = accountApi({ acme: { PROD_ERP_SHARE: { FEEDBACK: { ORDERS: orders } }, MARKETING: { FEEDBACK: {} } } }, { 1: 'ACME-ANALYTICS' });
	const integrations = [integration('acme', { serviceAccountId: '1' })];
	const browser = createBrowser({}, api, { retry: noRetry });
	const result = await matchCloudAmplifier({ source, integrations, browser });
	assert.deepEqual(result.suggestions.map((s) => [s.integration.id, s.databases]), [['acme', { ERP_DB: 'PROD_ERP_SHARE' }]]);
	assert.ok(!api.calls.includes('schema:acme:MARKETING'), 'a database without a shared word is not browsed');

	const pending = await extractData({ datasource: source, dir: tempDir(), unmapped: 'ask', cloudAmplifier: { getIntegrations: async () => integrations, browser } });
	assert.equal(pending.strategy, 'pending');
	const [suggestion] = pending.decision.cloudAmplifier;
	assert.equal(suggestion.integrationId, 'acme');
	assert.deepEqual(suggestion.databases, { ERP_DB: 'PROD_ERP_SHARE' });
	assert.deepEqual(suggestion.match, { class: 'snowflake', server: 'ab67890.us-east-1', dbname: 'ERP_DB' });
	const { completeDecision } = await import('../../src/pipeline/decisions.js');
	const decision = completeDecision(pending.decision, { key: 'FEEDBACK' });
	assert.deepEqual(decision.suggested, { choice: 'cloud-amplifier', id: 'acme' });
	assert.deepEqual(decision.entries['cloud-amplifier'].cloudAmplifier[0].databases, { ERP_DB: 'PROD_ERP_SHARE' });
});
