import test from 'node:test';
import assert from 'node:assert/strict';
import { planDatasets, findInputColumn } from '../../src/convert/datasets.js';

function col(remoteName, localType, tableId, localName = `[${remoteName}]`) {
	return { remoteName, localName, tableId, localType };
}

function field(id, name, datatype, extra = {}) {
	return { id, name, datatype, role: datatype === 'real' ? 'measure' : 'dimension', kind: 'column', ...extra };
}

function superstoreIR({ relationships = [], relationTree, tables, fields } = {}) {
	const orders = {
		id: 'Orders_1',
		name: 'Orders',
		kind: 'table',
		connectionId: 'c1',
		table: '[dbo].[Orders]',
		columns: [col('Region', 'string', 'Orders_1'), col('Sales', 'real', 'Orders_1'), col('Order ID', 'string', 'Orders_1')]
	};
	const people = {
		id: 'People_2',
		name: 'People',
		kind: 'table',
		connectionId: 'c1',
		table: '[dbo].[People]',
		columns: [col('Region', 'string', 'People_2', '[Region (People)]'), col('Person', 'string', 'People_2')]
	};
	const returns = {
		id: 'Returns_3',
		name: 'Returns',
		kind: 'table',
		connectionId: 'c1',
		table: '[dbo].[Returns]',
		columns: [col('Order ID', 'string', 'Returns_3', '[Order ID (Returns)]'), col('Returned', 'string', 'Returns_3')]
	};
	return {
		irVersion: 1,
		workbook: { name: 'Superstore', sourceFile: 'x.twbx' },
		datasources: [
			{
				id: 'federated.abc',
				caption: 'Sample Superstore',
				connections: [{ id: 'c1', class: 'sqlserver', server: 'db.acme.com', dbname: 'sales', extra: {} }],
				tables: tables ?? [orders, people, returns],
				relationships,
				relationTree,
				fields: fields ?? [
					field('[Region]', 'Region', 'string'),
					field('[Sales]', 'Revenue', 'real'),
					field('[Order ID]', 'Order ID', 'string'),
					field('[Region (People)]', 'Region (People)', 'string'),
					field('[Person]', 'Manager', 'string'),
					field('[Order ID (Returns)]', 'Order ID (Returns)', 'string'),
					field('[Returned]', 'Returned', 'string'),
					{ id: '[__tableau_internal_object_id__].[Orders_1]', name: 'Orders', datatype: 'table', role: 'measure', kind: 'count' }
				],
				filters: []
			}
		],
		parameters: [],
		worksheets: [{ name: 'Sheet 1', datasourceIds: ['federated.abc'], filters: [] }],
		dashboards: [],
		issues: []
	};
}

const tableCsv = (name, tableId, columns, extra = {}) => ({
	name,
	tableId,
	file: `data/sample-superstore/${name}.csv`,
	columns,
	rowCount: 10,
	flattened: false,
	...extra
});

const ordersCols = [
	{ name: 'Region', type: 'STRING', sourceName: 'Region' },
	{ name: 'Revenue', type: 'DOUBLE', sourceName: 'Sales' },
	{ name: 'Order ID', type: 'STRING', sourceName: 'Order ID' }
];
const peopleCols = [
	{ name: 'Region', type: 'STRING', sourceName: 'Region' },
	{ name: 'Person', type: 'STRING', sourceName: 'Person' }
];
const returnsCols = [
	{ name: 'Order ID', type: 'STRING', sourceName: 'Order ID' },
	{ name: 'Returned', type: 'STRING', sourceName: 'Returned' }
];

const relationships = [
	{ fromTableId: 'Orders_1', toTableId: 'People_2', on: [{ left: '[Region]', right: '[Region (People)]' }] },
	{ fromTableId: 'Orders_1', toTableId: 'Returns_3', on: [{ left: '[Order ID]', right: '[Order ID (Returns)]' }] }
];

const multiManifest = () => ({
	datasourceId: 'federated.abc',
	strategy: 'hyper',
	tables: [
		tableCsv('Orders', 'Orders_1', ordersCols),
		tableCsv('People', 'People_2', peopleCols),
		tableCsv('Returns', 'Returns_3', returnsCols)
	],
	issues: []
});

test('single flattened extract becomes one upload card-target dataset', () => {
	const ir = superstoreIR();
	const manifest = {
		datasourceId: 'federated.abc',
		strategy: 'hyper',
		tables: [
			tableCsv(
				'Extract',
				undefined,
				[
					{ name: 'Region', type: 'STRING', sourceName: 'Region' },
					{ name: 'Revenue', type: 'DOUBLE', sourceName: 'Sales' },
					{ name: 'Order ID', type: 'STRING', sourceName: 'Order ID' },
					{ name: 'Region (People)', type: 'STRING', sourceName: 'Region (People)' },
					{ name: 'Manager', type: 'STRING', sourceName: 'Person' },
					{ name: 'Order ID (Returns)', type: 'STRING', sourceName: 'Order ID (Returns)' },
					{ name: 'Returned', type: 'STRING', sourceName: 'Returned' }
				],
				{ flattened: true }
			)
		],
		issues: []
	};
	const { datasets, dataflows, issues } = planDatasets(ir, [manifest], { workbookKey: 'superstore', options: { namePrefix: 'TB ' } });
	assert.equal(dataflows.length, 0);
	assert.equal(datasets.length, 1);
	const [ds] = datasets;
	assert.equal(ds.key, 'superstore.sample-superstore');
	assert.equal(ds.name, 'TB Sample Superstore');
	assert.equal(ds.strategy, 'upload');
	assert.equal(ds.cardTarget, true);
	assert.deepEqual(ds.upload, { file: 'data/sample-superstore/Extract.csv' });
	assert.equal(ds.fieldMap['[Sales]'], 'Revenue');
	assert.equal(ds.fieldMap['[Region]'], 'Region');
	assert.equal(ds.fieldMap['[Region (People)]'], 'Region (People)');
	assert.equal(ds.fieldMap['[Person]'], 'Manager');
	assert.equal(ds.fieldMap['[__tableau_internal_object_id__].[Orders_1]'], undefined);
	assert.equal(issues.filter((i) => i.code === 'data.field-unmapped').length, 0);
});

test('multi-table relationships become a Magic ETL join dataflow', () => {
	const ir = superstoreIR({ relationships });
	const { datasets, dataflows, issues } = planDatasets(ir, [multiManifest()], { workbookKey: 'wb' });
	assert.deepEqual(
		datasets.map((d) => [d.key, d.strategy, d.cardTarget]),
		[
			['wb.sample-superstore.orders', 'upload', false],
			['wb.sample-superstore.people', 'upload', false],
			['wb.sample-superstore.returns', 'upload', false],
			['wb.sample-superstore', 'dataflow-output', true]
		]
	);
	assert.equal(dataflows.length, 1);
	const flow = dataflows[0];
	assert.deepEqual(flow.outputDatasetKeys, ['wb.sample-superstore']);
	const def = flow.definition;
	assert.equal(def.databaseType, 'MAGIC');
	assert.deepEqual(def.engineProperties, { 'kettle.mode': 'STRICT' });
	assert.deepEqual(def.gui, {});
	assert.equal(def.runState, 'ENABLED');

	const byType = (t) => def.actions.filter((a) => a.type === t);
	const inputs = byType('LoadFromVault');
	assert.equal(inputs.length, 3);
	assert.deepEqual(inputs[0].dataSourceId, { $ref: 'dataset:wb.sample-superstore.orders' });
	const joins = byType('MergeJoin');
	assert.equal(joins.length, 2);
	const [j1, j2] = joins;
	assert.equal(j1.joinType, 'LEFT OUTER');
	assert.equal(j1.step1, inputs[0].id);
	assert.equal(j1.step2, inputs[1].id);
	assert.deepEqual(j1.dependsOn, [inputs[0].id, inputs[1].id]);
	assert.deepEqual(j1.keys1, ['Region']);
	assert.deepEqual(j1.keys2, ['Region']);
	assert.deepEqual(j1.schemaModification2, [{ name: 'Region', rename: 'Region', remove: true }]);
	assert.equal(j2.step1, j1.id);
	assert.deepEqual(j2.keys1, ['Order ID']);
	assert.deepEqual(j2.schemaModification2, [{ name: 'Order ID', rename: 'Order ID', remove: true }]);
	assert.ok(j2.gui.x > j1.gui.x);

	const [out] = byType('PublishToVault');
	assert.deepEqual(out.dependsOn, [j2.id]);
	assert.deepEqual(out.dataSource, { guid: '', name: 'Sample Superstore', description: out.dataSource.description });
	assert.equal(out.versionChainType, 'REPLACE');

	const target = datasets.at(-1);
	assert.deepEqual(target.dataflowOutput, { dataflowKey: flow.key, outputName: 'Sample Superstore' });
	assert.deepEqual(
		target.schema.map((c) => c.name),
		['Region', 'Revenue', 'Order ID', 'Person', 'Returned']
	);
	assert.equal(target.fieldMap['[Sales]'], 'Revenue');
	assert.equal(target.fieldMap['[Region (People)]'], 'Region');
	assert.equal(target.fieldMap['[Person]'], 'Person');
	assert.equal(target.fieldMap['[Order ID (Returns)]'], 'Order ID');
	assert.ok(issues.some((i) => i.code === 'data.relationship-join'));
});

test('a relationship on DATE() of a column joins on that date, not on the raw column', () => {
	const dated = [{ ...relationships[0], on: [{ left: 'DATE([Region])', right: '[Region (People)]' }] }, relationships[1]];
	const { dataflows, issues } = planDatasets(superstoreIR({ relationships: dated }), [multiManifest()], { workbookKey: 'wb' });
	const actions = dataflows[0].definition.actions;
	const [j1] = actions.filter((a) => a.type === 'MergeJoin');
	assert.deepEqual([j1.keys1, j1.keys2], [['_t2d_join_key_1'], ['Region']]);
	assert.equal(actions.find((a) => a.type === 'ExpressionEvaluator').expressions[0].expression, 'DATE(`Region`)');
	const other = [{ ...relationships[0], on: [{ left: 'UPPER([Region])', right: '[Region (People)]' }] }, relationships[1]];
	const plain = planDatasets(superstoreIR({ relationships: other }), [multiManifest()], { workbookKey: 'wb' });
	assert.deepEqual(plain.dataflows[0].definition.actions.find((a) => a.type === 'MergeJoin').keys1, ['Region']);
	assert.match(plain.issues.find((i) => i.code === 'data.join-key-expression').message, /UPPER/);
	assert.ok(!issues.some((i) => i.code === 'data.join-key-expression' || i.code === 'data.join-key-unresolved'));
});

test('fact table is the one with most relationships', () => {
	const rels = [
		{ fromTableId: 'People_2', toTableId: 'Orders_1', on: [{ left: '[Region (People)]', right: '[Region]' }] },
		{ fromTableId: 'Returns_3', toTableId: 'Orders_1', on: [{ left: '[Order ID (Returns)]', right: '[Order ID]' }] }
	];
	const ir = superstoreIR({ relationships: rels });
	ir.datasources[0].tables = [ir.datasources[0].tables[1], ir.datasources[0].tables[2], ir.datasources[0].tables[0]];
	const { dataflows } = planDatasets(ir, [multiManifest()], { workbookKey: 'wb' });
	const actions = dataflows[0].definition.actions;
	const joins = actions.filter((a) => a.type === 'MergeJoin');
	const ordersInput = actions.find((a) => a.type === 'LoadFromVault' && a.name === 'Orders');
	assert.equal(joins[0].step1, ordersInput.id);
	assert.deepEqual(joins[0].keys1, ['Region']);
});

test('legacy joins keep join type and rename colliding non-key columns', () => {
	const tree = {
		type: 'join',
		join: 'full',
		on: [{ left: '[Orders].[Region]', right: '[People].[Region]' }],
		children: [
			{ type: 'table', tableId: 'Orders_1' },
			{ type: 'table', tableId: 'People_2' }
		]
	};
	const ir = superstoreIR({ relationTree: tree });
	ir.datasources[0].tables = ir.datasources[0].tables.slice(0, 2);
	const manifest = multiManifest();
	manifest.tables = manifest.tables.slice(0, 2);
	const { datasets, dataflows, issues } = planDatasets(ir, [manifest], { workbookKey: 'wb' });
	const join = dataflows[0].definition.actions.find((a) => a.type === 'MergeJoin');
	assert.equal(join.joinType, 'FULL OUTER');
	assert.deepEqual(join.schemaModification2, [{ name: 'Region', rename: 'Region (People)', remove: false }]);
	const target = datasets.find((d) => d.cardTarget);
	assert.equal(target.fieldMap['[Region (People)]'], 'Region (People)');
	assert.ok(!issues.some((i) => i.code === 'data.relationship-join'));
});

test('unions become UnionAll', () => {
	const tree = {
		type: 'union',
		children: [
			{ type: 'table', tableId: 'A' },
			{ type: 'table', tableId: 'B' }
		]
	};
	const tables = ['A', 'B'].map((id) => ({ id, name: `Sales ${id}`, kind: 'table', columns: [col('Region', 'string', id), col('Sales', 'real', id)] }));
	const ir = superstoreIR({ relationTree: tree, tables, fields: [field('[Region]', 'Region', 'string'), field('[Sales]', 'Sales', 'real')] });
	const cols = [
		{ name: 'Region', type: 'STRING' },
		{ name: 'Sales', type: 'DOUBLE' }
	];
	const manifest = { datasourceId: 'federated.abc', strategy: 'hyper', tables: [tableCsv('Sales A', 'A', cols), tableCsv('Sales B', 'B', cols)], issues: [] };
	const { datasets, dataflows } = planDatasets(ir, [manifest], { workbookKey: 'wb' });
	const union = dataflows[0].definition.actions.find((a) => a.type === 'UnionAll');
	assert.equal(union.unionType, 'INCLUDE_ALL');
	assert.equal(union.schemaSource, union.dependsOn[0]);
	assert.deepEqual(datasets.at(-1).fieldMap, { '[Region]': 'Region', '[Sales]': 'Sales' });
});

test('view strategy builds a nested fusion body', () => {
	const ir = superstoreIR({ relationships });
	const { datasets, dataflows } = planDatasets(ir, [multiManifest()], { workbookKey: 'wb', options: { joins: 'view' } });
	assert.equal(dataflows.length, 0);
	const view = datasets.find((d) => d.cardTarget);
	assert.equal(view.strategy, 'view');
	const body = view.view;
	assert.equal(body.dataSourceType, 'datafusion');
	assert.equal(body.columnFuse.type, 'left');
	assert.deepEqual(body.columnFuse.rightDataSource, { $ref: 'dataset:wb.sample-superstore.returns' });
	assert.deepEqual(body.columnFuse.predicates, [{ leftColumn: 'Order ID', rightColumn: 'Order ID' }]);
	assert.deepEqual(body.columnFuse.columnFuse.leftDataSource, { $ref: 'dataset:wb.sample-superstore.orders' });
	assert.deepEqual(body.columnFuse.columnFuse.rightDataSource, { $ref: 'dataset:wb.sample-superstore.people' });
	const person = body.columnList.find((c) => c.name === 'Person');
	assert.deepEqual(person.fuseMapping, { dataSource: { $ref: 'dataset:wb.sample-superstore.people' }, columnName: 'Person' });
	assert.equal(view.fieldMap['[Person]'], 'Person');
});

test('view strategy falls back to a dataflow for full joins', () => {
	const tree = {
		type: 'join',
		join: 'full',
		on: [{ left: '[Orders].[Region]', right: '[People].[Region]' }],
		children: [
			{ type: 'table', tableId: 'Orders_1' },
			{ type: 'table', tableId: 'People_2' }
		]
	};
	const ir = superstoreIR({ relationTree: tree });
	ir.datasources[0].tables = ir.datasources[0].tables.slice(0, 2);
	const manifest = multiManifest();
	manifest.tables = manifest.tables.slice(0, 2);
	const { datasets, dataflows, issues } = planDatasets(ir, [manifest], { workbookKey: 'wb', options: { joins: 'view' } });
	assert.equal(dataflows.length, 1);
	assert.equal(datasets.find((d) => d.cardTarget).strategy, 'dataflow-output');
	assert.ok(issues.some((i) => i.code === 'data.view-fallback'));
});

test('flatten strategy without a flattened table is an error', () => {
	const ir = superstoreIR({ relationships });
	const { datasets, issues } = planDatasets(ir, [multiManifest()], { workbookKey: 'wb', options: { joins: 'flatten' } });
	assert.ok(issues.some((i) => i.code === 'data.not-flattened' && i.severity === 'error'));
	assert.equal(datasets.filter((d) => d.cardTarget).length, 1);
});

test('existing mapping produces an existing dataset with display-name columns', () => {
	const ir = superstoreIR();
	const { datasets } = planDatasets(ir, [], {
		workbookKey: 'wb',
		mappings: { datasets: { 'Sample Superstore': 'abc-123' }, columns: { 'Sample Superstore.Manager': 'Regional Manager' } }
	});
	assert.equal(datasets.length, 1);
	assert.equal(datasets[0].strategy, 'existing');
	assert.deepEqual(datasets[0].existing, { datasetId: 'abc-123' });
	assert.equal(datasets[0].fieldMap['[Sales]'], 'Revenue');
	assert.equal(datasets[0].fieldMap['[Person]'], 'Regional Manager');
});

test('connector strategy plans one stream per table and a join dataflow', () => {
	const ir = superstoreIR({ relationships });
	const manifest = { datasourceId: 'federated.abc', strategy: 'connector', tables: [], issues: [] };
	const mappings = { accounts: [{ match: { class: 'sqlserver', server: 'DB.acme.com' }, accountId: 42 }] };
	const { datasets, dataflows, issues } = planDatasets(ir, [manifest], { workbookKey: 'wb', mappings });
	const connectors = datasets.filter((d) => d.strategy === 'connector');
	assert.equal(connectors.length, 3);
	assert.equal(connectors[0].connector.providerKey, 'ms-sql-server');
	assert.equal(connectors[0].connector.accountId, 42);
	assert.equal(connectors[0].connector.query, 'SELECT * FROM [dbo].[Orders]');
	assert.equal(dataflows.length, 1);
	assert.equal(datasets.find((d) => d.cardTarget).fieldMap['[Sales]'], 'Sales');
	assert.ok(!issues.some((i) => i.code === 'data.no-account'));
});

test('datasources without a manifest are reported', () => {
	const ir = superstoreIR();
	const { datasets, issues } = planDatasets(ir, [], { workbookKey: 'wb' });
	assert.equal(datasets.length, 0);
	assert.ok(issues.some((i) => i.code === 'data.no-manifest'));
});

test('findInputColumn prefers source names and falls back case-insensitively', () => {
	const cols = [
		{ name: 'Revenue', type: 'DOUBLE', sourceName: 'Sales' },
		{ name: 'REGION', type: 'STRING' }
	];
	assert.equal(findInputColumn(cols, { remoteName: 'Sales', localName: '[Sales]', fieldName: 'Revenue' }).name, 'Revenue');
	assert.equal(findInputColumn(cols, { remoteName: 'region' }).name, 'REGION');
	assert.equal(findInputColumn(cols, { remoteName: 'nope' }), undefined);
});
