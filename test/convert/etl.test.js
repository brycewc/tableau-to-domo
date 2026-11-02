import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJoinDataflow, buildFusionView, magicJoinType, originKey } from '../../src/convert/etl.js';

const inputs = [
	{ id: 'a', name: 'Orders', datasetKey: 'k.a', columns: [{ name: 'Id', type: 'LONG' }, { name: 'Name', type: 'STRING' }] },
	{ id: 'b', name: 'Customers', datasetKey: 'k.b', columns: [{ name: 'Id', type: 'LONG' }, { name: 'Name', type: 'STRING' }, { name: 'Tier', type: 'STRING' }] }
];
const join = (joinType) => ({
	type: 'join',
	joinType,
	left: { type: 'input', tableId: 'a' },
	right: { type: 'input', tableId: 'b' },
	keys: [{ left: { tableId: 'a', column: 'Id' }, right: { tableId: 'b', column: 'Id' } }]
});

test('magicJoinType maps Tableau joins', () => {
	assert.equal(magicJoinType('inner'), 'INNER');
	assert.equal(magicJoinType('left'), 'LEFT OUTER');
	assert.equal(magicJoinType('right'), 'RIGHT OUTER');
	assert.equal(magicJoinType('full'), 'FULL OUTER');
});

test('inner join drops the duplicate key and renames other collisions', () => {
	const { definition, columns, columnMap } = buildJoinDataflow({ name: 'F', outputName: 'Out', inputs, tree: join('INNER') });
	const mj = definition.actions.find((a) => a.type === 'MergeJoin');
	assert.deepEqual(mj.schemaModification2, [
		{ name: 'Id', rename: 'Id', remove: true },
		{ name: 'Name', rename: 'Name (Customers)', remove: false }
	]);
	assert.deepEqual(columns.map((c) => c.name), ['Id', 'Name', 'Name (Customers)', 'Tier']);
	assert.equal(columnMap.get(originKey('b', 'Id')), 'Id');
	assert.equal(columnMap.get(originKey('b', 'Name')), 'Name (Customers)');
	const ids = new Set(definition.actions.map((a) => a.id));
	assert.equal(ids.size, definition.actions.length);
	for (const a of definition.actions) for (const d of a.dependsOn ?? []) assert.ok(ids.has(d));
	assert.equal(definition.actions.at(-1).type, 'PublishToVault');
});

test('a DATE() join key is computed into a key column before the join and dropped before the output', () => {
	const tree = { ...join('LEFT OUTER'), keys: [{ left: { tableId: 'a', column: 'Name', transform: 'DATE' }, right: { tableId: 'b', column: 'Tier' } }] };
	const { definition, columns } = buildJoinDataflow({ name: 'F', outputName: 'Out', inputs, tree });
	const [keys] = definition.actions.filter((a) => a.type === 'ExpressionEvaluator');
	assert.deepEqual(keys.expressions, [{ fieldName: '_t2d_join_key_1', expression: 'DATE(`Name`)' }]);
	const mj = definition.actions.find((a) => a.type === 'MergeJoin');
	assert.deepEqual([mj.step1, mj.keys1, mj.keys2], [keys.id, ['_t2d_join_key_1'], ['Tier']]);
	const drop = definition.actions.find((a) => a.type === 'Metadata');
	assert.deepEqual(drop.fields, [{ name: '_t2d_join_key_1', remove: true }]);
	assert.deepEqual(definition.actions.at(-1).dependsOn, [drop.id]);
	assert.ok(!columns.some((c) => c.name.startsWith('_t2d')));
	assert.match(buildFusionView({ name: 'V', inputs, tree }).error, /computed key/);
});

test('right join keeps both keys', () => {
	const { columns } = buildJoinDataflow({ name: 'F', outputName: 'Out', inputs, tree: join('RIGHT OUTER') });
	assert.ok(columns.some((c) => c.name === 'Id (Customers)'));
});

test('fusion view for a two-table left join', () => {
	const view = buildFusionView({ name: 'V', inputs, tree: join('LEFT OUTER') });
	assert.ok(!('error' in view));
	assert.deepEqual(view.body.columnFuse, {
		type: 'left',
		leftDataSource: { $ref: 'dataset:k.a' },
		rightDataSource: { $ref: 'dataset:k.b' },
		predicates: [{ leftColumn: 'Id', rightColumn: 'Id' }]
	});
	assert.deepEqual(
		view.body.columnList.map((c) => [c.name, c.fuseMapping.columnName, c.fuseMapping.dataSource.$ref]),
		[
			['Id', 'Id', 'dataset:k.a'],
			['Name', 'Name', 'dataset:k.a'],
			['Name (Customers)', 'Name', 'dataset:k.b'],
			['Tier', 'Tier', 'dataset:k.b']
		]
	);
	assert.ok('error' in buildFusionView({ name: 'V', inputs, tree: join('FULL OUTER') }));
});

test('fusion union uses rowFuse', () => {
	const view = buildFusionView({ name: 'V', inputs, tree: { type: 'union', children: [{ type: 'input', tableId: 'a' }, { type: 'input', tableId: 'b' }] } });
	assert.deepEqual(view.body.rowFuse, { dataSources: [{ $ref: 'dataset:k.a' }, { $ref: 'dataset:k.b' }] });
	assert.deepEqual(view.columns.map((c) => c.name), ['Id', 'Name', 'Tier']);
});
