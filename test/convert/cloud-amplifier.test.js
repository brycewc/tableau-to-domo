import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSqlView, planDatasets } from '../../src/convert/datasets.js';
import { convertWorkbook } from '../../src/convert/index.js';

const col = (remoteName, localName, localType, tableId) => ({ remoteName, localName, localType, tableId });

function ir(datasource) {
	return {
		irVersion: 1,
		workbook: { name: 'Sales', sourceFile: '' },
		datasources: [datasource],
		parameters: [],
		worksheets: [{ name: 'Sheet 1', datasourceIds: [datasource.id], pills: {}, rows: null, cols: null, rowPills: [], colPills: [], panes: [], filters: [], sorts: [], aggregated: true, measureValues: [], hidden: false }],
		dashboards: [],
		issues: []
	};
}

function field(id, name, datatype = 'string', extra = {}) {
	return { id, name, datatype, role: datatype === 'real' ? 'measure' : 'dimension', kind: 'column', ...extra };
}

const caTable = (tableName, columns, extra = {}) => ({
	integrationId: 'int-1',
	integrationName: 'Prod',
	engine: 'SNOWFLAKE',
	dataProviderKey: 'snowflake',
	databaseName: 'DB',
	schemaName: 'S',
	tableName,
	columns,
	verified: true,
	...extra
});

test('a single registered table is the card target and maps Tableau fields to warehouse column names', () => {
	const ds = {
		id: 'federated.1',
		caption: 'Orders',
		connections: [{ id: 'c', class: 'snowflake', extra: {} }],
		tables: [{ id: 'ORDERS_1', name: 'ORDERS', kind: 'table', connectionId: 'c', table: '[DB].[S].[ORDERS]', columns: [col('ORDER_ID', '[Order Id]', 'integer'), col('SALES', '[Sales]', 'real')] }],
		relationships: [],
		fields: [field('[Order Id]', 'Order Id', 'integer'), field('[Sales]', 'Sales', 'real'), { id: '[Calc]', name: 'Double', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales]) * 2' }],
		filters: []
	};
	const manifest = {
		datasourceId: 'federated.1',
		strategy: 'cloud-amplifier',
		tables: [],
		issues: [],
		cloudAmplifier: {
			integrations: [{ id: 'int-1', name: 'Prod', engine: 'SNOWFLAKE' }],
			matchedBy: 'browse',
			tables: [caTable('ORDERS', [{ name: 'ORDER_ID', type: 'LONG' }, { name: 'SALES', type: 'DOUBLE' }, { name: 'EXTRA', type: 'STRING' }], { registeredDatasetId: 'reg-1' })],
			relations: [{ tableId: 'ORDERS_1', name: 'ORDERS', kind: 'table', table: 0 }]
		}
	};
	const { datasets, dataflows, issues } = planDatasets(ir(ds), [manifest], { workbookKey: 'wb' });
	assert.equal(dataflows.length, 0);
	assert.equal(datasets.length, 1);
	assert.equal(datasets[0].key, 'wb.orders');
	assert.equal(datasets[0].strategy, 'cloud-amplifier');
	assert.equal(datasets[0].cardTarget, true);
	assert.deepEqual(datasets[0].cloudAmplifier, { integrationId: 'int-1', databaseName: 'DB', schemaName: 'S', tableName: 'ORDERS', dataProviderKey: 'snowflake', registeredDatasetId: 'reg-1' });
	assert.deepEqual(datasets[0].fieldMap, { '[Order Id]': 'ORDER_ID', '[Sales]': 'SALES' });
	assert.deepEqual(issues.filter((i) => i.severity !== 'info'), []);

	const plan = convertWorkbook(ir(ds), { manifests: [manifest], options: { allBeastModes: true } });
	const bm = plan.beastModes.find((b) => b.tableauFieldId === '[Calc]');
	assert.match(bm.expression, /`SALES`/);
});

test('a published datasource uses the .tds tables from the manifest and joins two registered tables', () => {
	const ds = {
		id: 'sqlproxy.1',
		caption: 'Shared',
		published: { luid: 'p-1' },
		connections: [{ id: 'sqlproxy', class: 'sqlproxy', extra: {} }],
		tables: [{ id: '[sqlproxy]', name: 'sqlproxy', kind: 'table', columns: [] }],
		relationships: [],
		fields: [field('[Order Id]', 'Order Id', 'integer'), field('[Region]', 'Region'), field('[Manager]', 'Manager')],
		filters: []
	};
	const source = {
		tables: [
			{ id: 'O', name: 'ORDERS', kind: 'table', columns: [col('ORDER_ID', '[Order Id]', 'integer', 'O'), col('REGION', '[Region]', 'string', 'O')] },
			{ id: 'P', name: 'PEOPLE', kind: 'table', columns: [col('REGION', '[Region (People)]', 'string', 'P'), col('MANAGER', '[Manager]', 'string', 'P')] }
		],
		relationships: [{ fromTableId: 'O', toTableId: 'P', on: [{ left: '[Region]', right: '[Region (People)]' }] }]
	};
	const manifest = {
		datasourceId: 'sqlproxy.1',
		strategy: 'cloud-amplifier',
		tables: [],
		issues: [],
		cloudAmplifier: {
			integrations: [{ id: 'int-1', name: 'Prod', engine: 'SNOWFLAKE' }],
			matchedBy: 'host',
			tables: [
				caTable('ORDERS', [{ name: 'ORDER_ID', type: 'LONG' }, { name: 'REGION', type: 'STRING' }]),
				caTable('PEOPLE', [{ name: 'REGION', type: 'STRING' }, { name: 'MANAGER', type: 'STRING' }])
			],
			relations: [
				{ tableId: 'O', name: 'ORDERS', kind: 'table', table: 0 },
				{ tableId: 'P', name: 'PEOPLE', kind: 'table', table: 1 }
			],
			source
		}
	};
	const { datasets, dataflows } = planDatasets(ir(ds), [manifest], { workbookKey: 'wb' });
	assert.deepEqual(datasets.map((d) => [d.key, d.strategy, d.cardTarget]), [
		['wb.shared.orders', 'cloud-amplifier', false],
		['wb.shared.people', 'cloud-amplifier', false],
		['wb.shared', 'dataflow-output', true]
	]);
	assert.equal(dataflows.length, 1);
	const target = datasets[2];
	assert.equal(target.fieldMap['[Order Id]'], 'ORDER_ID');
	assert.equal(target.fieldMap['[Manager]'], 'MANAGER');
});

test('custom SQL becomes a SQL DataSet View over the registered tables, which are planned first', () => {
	const sql = 'select o.*, p.manager from s.orders o join s.people p on o.region = p.region;';
	const ds = {
		id: 'federated.2',
		caption: 'Custom',
		connections: [{ id: 'c', class: 'snowflake', extra: {} }],
		tables: [{ id: 'Q', name: 'Custom SQL Query', kind: 'custom-sql', connectionId: 'c', sql, columns: [col('ORDER_ID', '[ORDER_ID]', 'integer'), col('MANAGER', '[MANAGER]', 'string')] }],
		relationships: [],
		fields: [field('[ORDER_ID]', 'Order Id', 'integer'), field('[MANAGER]', 'Manager')],
		filters: []
	};
	const start1 = sql.indexOf('s.orders');
	const start2 = sql.indexOf('s.people');
	const manifest = {
		datasourceId: 'federated.2',
		strategy: 'cloud-amplifier',
		tables: [],
		issues: [],
		cloudAmplifier: {
			integrations: [{ id: 'int-1', name: 'Prod', engine: 'SNOWFLAKE' }],
			matchedBy: 'browse',
			tables: [caTable('ORDERS', []), caTable('PEOPLE', [])],
			relations: [
				{
					tableId: 'Q',
					name: 'Custom SQL Query',
					kind: 'custom-sql',
					sql,
					refs: [
						{ start: start1, end: start1 + 's.orders'.length, table: 0 },
						{ start: start2, end: start2 + 's.people'.length, table: 1 }
					],
					columns: [{ name: 'ORDER_ID', type: 'LONG' }, { name: 'MANAGER', type: 'STRING' }]
				}
			]
		}
	};
	const { datasets, issues } = planDatasets(ir(ds), [manifest], { workbookKey: 'wb' });
	assert.deepEqual(datasets.map((d) => [d.key, d.strategy, d.cardTarget]), [
		['wb.custom.orders', 'cloud-amplifier', false],
		['wb.custom.people', 'cloud-amplifier', false],
		['wb.custom', 'view', true]
	]);
	const view = datasets[2].view;
	assert.equal(view.schema.viewTemplate.version, 'advancedEditorSql');
	assert.equal(view.schema.viewTemplate.selectString, 'select o.*, p.manager from `t1` o join `t2` p on o.region = p.region');
	assert.deepEqual(view.schema.tableAliases, { t1: { $ref: 'dataset:wb.custom.orders' }, t2: { $ref: 'dataset:wb.custom.people' } });
	assert.equal(view.cloudId, 'int-1');
	assert.equal(view.dataProviderType, 'snowflake');
	assert.deepEqual(datasets[2].fieldMap, { '[ORDER_ID]': 'ORDER_ID', '[MANAGER]': 'MANAGER' });
	assert.ok(issues.some((i) => i.code === 'data.cloud-amplifier-sql-view'));
});

test('buildSqlView aliases only the referenced tables', () => {
	const view = buildSqlView({ name: 'V', description: '', sql: 'select * from a', refs: [{ start: 14, end: 15, table: 1 }], aliasKeys: ['x', 'y'], columns: [] });
	assert.equal(view.schema.viewTemplate.selectString, 'select * from `t2`');
	assert.deepEqual(Object.keys(view.schema.tableAliases), ['t2']);
	assert.deepEqual(view.trigger, { dataSource: { $ref: 'dataset:y' } });
});

test('buildSqlView applies the view rules in order and reports what it could not rewrite', () => {
	const sql = "select s.account_id, iff(s.n > 0, 'p', 'n') as sign, regexp_substr(s.name, 'x') as r, cast(s.d as timestamp_ltz) as d from (select account_id, o.n, o.name, o.d::timestamp_ntz as d from s.orders o) s";
	const issues = [];
	const view = buildSqlView({ name: 'V', description: '', sql, refs: [{ start: sql.indexOf('s.orders'), end: sql.indexOf('s.orders') + 8, table: 0 }], aliasKeys: ['orders'], columns: [{ name: 'ACCOUNT_ID', type: 'STRING' }, { name: 'SIGN', type: 'STRING' }, { name: 'R', type: 'STRING' }, { name: 'D', type: 'DATETIME' }], issues });
	assert.equal(view.schema.viewTemplate.selectString, "select s.account_id, CASE WHEN (s.n > 0) THEN 'p' ELSE 'n' END as sign, regexp_substr(s.name, 'x') as r, cast(s.d as timestamp_ltz) as d from (select account_id AS account_id, o.n AS n, o.name AS name, o.d::TIMESTAMP as d from `t1` o) s");
	assert.deepEqual(view.schema.tables[0].columns.map((c) => c.name), ['account_id', 'sign', 'r', 'd']);
	assert.ok(issues.some((i) => i.code === 'data.view-sql-unsupported-function' && /REGEXP_SUBSTR/.test(i.message)));
	assert.ok(issues.some((i) => /TIMESTAMP_LTZ/.test(i.message) && i.severity === 'warning'));
	assert.ok(issues.some((i) => /IFF rewritten/.test(i.message)));
});

test('an Initial SQL dataflow reads its registered tables and its output is the card target', () => {
	const ds = {
		id: 'federated.9',
		caption: 'Scripted',
		connections: [{ id: 'c', class: 'snowflake', extra: {} }],
		tables: [{ id: 'Q', name: 'Custom SQL Query', kind: 'custom-sql', connectionId: 'c', sql: 'select * from tmp', columns: [col('REGION', '[Region]', 'string'), col('N', '[N]', 'integer')] }],
		relationships: [],
		fields: [field('[Region]', 'Region'), field('[N]', 'N', 'integer')],
		filters: []
	};
	const definition = {
		name: 'Scripted (Initial SQL)',
		databaseType: 'ADR',
		actions: [
			{ id: 'in-a', type: 'LoadFromVault', dataSourceId: 'ca:0' },
			{ id: 'in-b', type: 'LoadFromVault', dataSourceId: 'ca:1' },
			{ id: 'out', type: 'PublishToVault', dependsOn: ['in-a', 'in-b'], dataSource: { name: 'Scripted - Custom SQL Query' } }
		]
	};
	const manifest = {
		datasourceId: 'federated.9',
		strategy: 'cloud-amplifier',
		tables: [],
		issues: [],
		cloudAmplifier: {
			integrations: [{ id: 'int-1', name: 'Prod', engine: 'SNOWFLAKE' }],
			matchedBy: 'browse',
			tables: [caTable('A', [{ name: 'REGION', type: 'STRING' }]), caTable('B', [{ name: 'N', type: 'LONG' }])],
			relations: [],
			initialSqlDataflows: [{ connectionId: 'c', definition, outputs: [{ tableId: 'Q', name: 'Scripted - Custom SQL Query', columns: [{ name: 'REGION', type: 'STRING' }, { name: 'N', type: null }] }], issues: [] }]
		}
	};
	const { datasets, dataflows, issues } = planDatasets(ir(ds), [manifest], { workbookKey: 'wb' });
	const output = datasets.find((d) => d.strategy === 'dataflow-output');
	assert.equal(output.key, 'wb.scripted');
	assert.equal(output.cardTarget, true);
	assert.deepEqual(output.schema, [{ name: 'REGION', type: 'STRING' }, { name: 'N', type: 'STRING' }]);
	assert.deepEqual(output.fieldMap, { '[Region]': 'REGION', '[N]': 'N' });
	assert.deepEqual(datasets.filter((d) => d.strategy === 'cloud-amplifier').map((d) => d.key), ['wb.scripted.a', 'wb.scripted.b']);
	assert.equal(dataflows.length, 1);
	assert.deepEqual(dataflows[0].outputDatasetKeys, ['wb.scripted']);
	assert.deepEqual(output.dataflowOutput, { dataflowKey: dataflows[0].key, outputName: 'Scripted - Custom SQL Query' });
	assert.deepEqual(dataflows[0].definition.actions.slice(0, 2).map((a) => a.dataSourceId), [{ $ref: 'dataset:wb.scripted.a' }, { $ref: 'dataset:wb.scripted.b' }]);
	assert.ok(issues.some((i) => i.code === 'data.initial-sql-magic-refresh'));
});

test('a split Initial SQL dataflow chains its stages through an intermediate dataset', () => {
	const ds = {
		id: 'federated.10',
		caption: 'Split',
		connections: [{ id: 'c', class: 'snowflake', extra: {} }],
		tables: [{ id: 'Q', name: 'Custom SQL Query', kind: 'custom-sql', connectionId: 'c', sql: 'select * from tmp', columns: [col('REGION', '[Region]', 'string')] }],
		relationships: [],
		fields: [field('[Region]', 'Region')],
		filters: []
	};
	const step = 'Split (Initial SQL) step 1 - tmp';
	const stages = [
		{ definition: { name: 'Split (Initial SQL) 1', actions: [{ id: 'in', type: 'LoadFromVault', dataSourceId: 'ca:0' }, { id: 'mid', type: 'PublishToVault', dependsOn: ['in'] }] }, outputs: [{ name: step, intermediate: true, columns: [{ name: 'REGION', type: 'STRING' }] }] },
		{ definition: { name: 'Split (Initial SQL) 2', actions: [{ id: 'in', type: 'LoadFromVault', dataSourceId: `stage:${step}` }, { id: 'out', type: 'PublishToVault', dependsOn: ['in'] }] }, outputs: [{ tableId: 'Q', name: 'Split - Custom SQL Query', columns: [{ name: 'REGION', type: 'STRING' }] }] }
	];
	const manifest = {
		datasourceId: 'federated.10',
		strategy: 'cloud-amplifier',
		tables: [],
		issues: [],
		cloudAmplifier: { integrations: [{ id: 'int-1', name: 'Prod', engine: 'SNOWFLAKE' }], matchedBy: 'browse', tables: [caTable('A', [{ name: 'REGION', type: 'STRING' }])], relations: [], initialSqlDataflows: [{ connectionId: 'c', stages, issues: [] }] }
	};
	const { datasets, dataflows } = planDatasets(ir(ds), [manifest], { workbookKey: 'wb' });
	assert.deepEqual(dataflows.map((d) => d.key), ['wb.split.initial-sql-1', 'wb.split.initial-sql-2']);
	const mid = datasets.find((d) => d.name === step);
	assert.equal(mid.cardTarget, false);
	assert.deepEqual(dataflows[0].outputDatasetKeys, [mid.key]);
	assert.deepEqual(dataflows[1].definition.actions[0].dataSourceId, { $ref: `dataset:${mid.key}` });
	assert.equal(datasets.find((d) => d.cardTarget).key, 'wb.split');
});
