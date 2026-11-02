import test from 'node:test';
import assert from 'node:assert/strict';
import { planConnector, findAccount, buildQuery, quoteIdentifier, relationParts } from '../../src/convert/connectors.js';

const ds = { id: 'federated.x', caption: 'Orders DS', tables: [] };

test('snowflake table with matching account', () => {
	const connection = { id: 'c', class: 'snowflake', server: 'acme.snowflakecomputing.com', dbname: 'SALES', schema: 'PUBLIC', warehouse: 'WH', extra: {} };
	const table = { id: 't', name: 'ORDERS', kind: 'table', table: '[PUBLIC].[ORDERS]', columns: [] };
	const mappings = {
		accounts: [
			{ match: { class: 'snowflake' }, accountId: 1 },
			{ match: { class: 'snowflake', server: 'ACME.snowflakecomputing.com' }, accountId: 2 }
		]
	};
	const { connector, issues } = planConnector(ds, connection, mappings, { table });
	assert.equal(connector.providerKey, 'snowflakekeypairauthentication');
	assert.deepEqual(connector.defaultTransport, { providerKey: 'snowflakekeypairauthentication', connectorId: 'com.domo.connector.snowflakekeypairauthentication', connectorVersion: '0' });
	assert.equal(connector.accountId, 2);
	assert.equal(connector.query, 'SELECT * FROM "PUBLIC"."ORDERS"');
	assert.equal(connector.updateMethod, 'REPLACE');
	assert.deepEqual(connector.accountMatch, { class: 'snowflake', server: 'acme.snowflakecomputing.com', dbname: 'SALES', warehouse: 'WH' });
	const query = connector.configuration.find((c) => c.name === 'query');
	assert.deepEqual(query, { name: 'query', value: connector.query, type: 'string', category: 'METADATA' });
	const config = Object.fromEntries(connector.configuration.map((c) => [c.name, c.value]));
	assert.equal(config.warehouseName, 'WH');
	assert.equal(config.databaseName, 'SALES');
	assert.equal(config.schemaName, 'PUBLIC');
	assert.equal(config['updatemode.mode'], 'Replace');
	assert.equal(config.convertTimeZone, 'UTC');
	assert.deepEqual(connector.unverified, []);
	assert.ok(!issues.some((i) => i.code === 'data.connector-unverified'));
	assert.ok(!issues.some((i) => i.code === 'data.no-account'));
});

test('missing account yields null accountId and an error issue', () => {
	const connection = { id: 'c', class: 'postgres', server: 'pg', dbname: 'db', extra: {} };
	const table = { id: 't', name: 'q', kind: 'custom-sql', sql: ' select 1 as x ', columns: [] };
	const { connector, issues } = planConnector(ds, connection, { accounts: [] }, { table });
	assert.equal(connector.accountId, null);
	assert.equal(connector.providerKey, 'postgresql');
	assert.equal(connector.query, 'select 1 as x');
	const err = issues.find((i) => i.code === 'data.no-account');
	assert.equal(err.severity, 'error');
	assert.match(err.suggestion, /accountId/);
	assert.match(err.suggestion, /t2d list accounts --provider postgresql/);
	assert.ok(issues.some((i) => i.code === 'data.connector-unverified'));
});

test('mapping providerKey overrides the default', () => {
	const connection = { id: 'c', class: 'oracle', server: 'o', extra: {} };
	const mappings = { accounts: [{ match: { class: 'oracle' }, accountId: 9, providerKey: 'oracle-custom' }] };
	const { connector } = planConnector(ds, connection, mappings, { table: { id: 't', name: 'T', kind: 'table', table: '[HR].[EMP]', columns: [] } });
	assert.equal(connector.providerKey, 'oracle-custom');
	assert.equal(connector.defaultTransport, undefined);
	assert.ok(connector.unverified.some((u) => u.includes("provider 'oracle-custom'")));
});

test('unsupported class', () => {
	const { connector, issues } = planConnector(ds, { id: 'c', class: 'excel-direct', extra: {} }, {});
	assert.equal(connector, null);
	assert.equal(issues[0].code, 'data.connector-unsupported');
});

test('quoting per dialect', () => {
	assert.equal(quoteIdentifier('a]b', 'tsql'), '[a]]b]');
	assert.equal(quoteIdentifier('a`b', 'mysql'), '`a``b`');
	assert.equal(quoteIdentifier('a"b', 'ansi'), '"a""b"');
	assert.deepEqual(relationParts('[dbo].[Order]]s]'), ['dbo', 'Order]s']);
	const t = { kind: 'table', table: '[proj.ds].[orders]', columns: [] };
	assert.equal(buildQuery(t, 'bigquery'), 'SELECT * FROM `proj.ds`.`orders`');
	assert.equal(buildQuery({ kind: 'table', table: '[orders]', columns: [] }, 'ansi', { schema: 'public' }), 'SELECT * FROM "public"."orders"');
});

test('findAccount requires every match key', () => {
	const m = { accounts: [{ match: { class: 'mysql', dbname: 'other' }, accountId: 1 }] };
	assert.equal(findAccount({ class: 'mysql', dbname: 'db' }, m), null);
});

test('verified connector configurations for mysql, bigquery, redshift and sql server', () => {
	const table = { id: 't', name: 'q', kind: 'custom-sql', sql: 'select 1', columns: [] };
	const config = (cls) => {
		const { connector } = planConnector(ds, { id: 'c', class: cls, server: 'h', dbname: 'd', extra: {} }, {}, { table });
		return { connector, config: Object.fromEntries(connector.configuration.map((c) => [c.name, c.value])) };
	};
	let r = config('mysql');
	assert.equal(r.config.queryType, 'customQuery');
	assert.equal(r.config.query, 'select 1');
	assert.equal(r.connector.defaultTransport.connectorId, 'com.domo.connector.mysql');
	r = config('bigquery');
	assert.equal(r.connector.providerKey, 'google-bigquery-service');
	assert.equal(r.config.report, 'run_query');
	assert.equal(r.config.queryType, 'standard');
	r = config('redshift');
	assert.equal(r.connector.defaultTransport.connectorId, 'com.domo.connector.redshift.l1');
	assert.equal(r.config.booleanFormat, 'true/false');
	r = config('sqlserver');
	assert.equal(r.connector.providerKey, 'ms-sql-server');
	assert.deepEqual(Object.keys(r.config), ['query', 'updatemode.mode', 'retry.retryNumber']);
	r = config('oracle');
	assert.equal(r.connector.providerKey, 'OracleDB');
	assert.equal(r.config.QueryType, 'query');
	r = config('databricks');
	assert.equal(r.connector.providerKey, 'databricks-pat');
	assert.equal(r.connector.defaultTransport, undefined);
});

test('salesforce is flagged for manual setup', () => {
	const { connector, issues } = planConnector(ds, { id: 'c', class: 'salesforce', extra: {} }, {});
	assert.equal(connector, null);
	assert.equal(issues[0].code, 'data.connector-manual');
	assert.equal(issues[0].severity, 'error');
});
