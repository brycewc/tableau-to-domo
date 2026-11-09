import test from 'node:test';
import assert from 'node:assert/strict';
import { combineDataflows, moveDataflowsToWarehouse, useGraphEditor } from '../../src/convert/combine-dataflows.js';
import { ref } from '../../src/util/refs.js';

const load = (id, key, y = 50) => ({ type: 'LoadFromVault', id, name: key, dataSourceId: ref('dataset', key), gui: { x: 50, y } });
const publish = (id, from, name) => ({ type: 'PublishToVault', id, name, dependsOn: [from], dataSource: { guid: '', name }, gui: { x: 490, y: 50 } });
const output = (key, flow, name, cardTarget) => ({ key, name, strategy: 'dataflow-output', dataflowOutput: { dataflowKey: flow, outputName: name }, cardTarget, schema: [] });
const flow = (key, actions, outputs, databaseType = 'MAGIC') => ({ key, name: key, definition: { name: key, databaseType, actions }, outputDatasetKeys: outputs, runAfterCreate: true });

function samplePlan() {
	return {
		source: { workbook: 'Sales' },
		datasets: [{ key: 'raw', strategy: 'view' }, { key: 'other', strategy: 'view' }, output('joined', 'join', 'Joined', false), output('calcs', 'calc', 'Calcs', true), output('blend', 'blend', 'Blend', true)],
		dataflows: [
			flow('join', [load('in-raw', 'raw'), load('in-other', 'other', 170), { type: 'MergeJoin', id: 'join', dependsOn: ['in-raw', 'in-other'], step1: 'in-raw', step2: 'in-other', gui: { x: 270, y: 50 } }, publish('out', 'join', 'Joined')], ['joined']),
			flow('calc', [load('in-source', 'joined'), { type: 'ExpressionEvaluator', id: 'calc', dependsOn: ['in-source'], gui: { x: 270, y: 50 } }, publish('out', 'calc', 'Calcs')], ['calcs']),
			flow('blend', [load('in-raw', 'raw'), { type: 'GroupBy', id: 'group', dependsOn: ['in-raw'], gui: { x: 270, y: 50 } }, publish('out', 'group', 'Blend')], ['blend'])
		],
		cards: [{ key: 'c1', datasetKey: 'calcs', body: { dataProvider: { dataSourceId: ref('dataset', 'calcs') } } }],
		beastModes: []
	};
}

test('a workbook\'s dataflows become one: chained inputs read the upstream tile and unread intermediates are not published', () => {
	const plan = samplePlan();
	const issues = combineDataflows(plan, { workbookKey: 'sales' });
	assert.equal(plan.dataflows.length, 1);
	const [df] = plan.dataflows;
	assert.equal(df.key, 'calc');
	assert.equal(df.name, 'Sales (Tableau data prep)');
	assert.deepEqual(df.outputDatasetKeys.sort(), ['blend', 'calcs']);
	const actions = df.definition.actions;
	assert.deepEqual(actions.filter((a) => a.type === 'LoadFromVault').map((a) => a.dataSourceId.$ref), ['dataset:raw', 'dataset:other'], 'one load per input; none of the intermediate');
	assert.deepEqual(actions.find((a) => a.id === 'calc').dependsOn, ['join']);
	assert.deepEqual(actions.find((a) => a.id === 'group').dependsOn, ['in-raw']);
	assert.deepEqual(actions.filter((a) => a.type === 'PublishToVault').map((a) => a.name).sort(), ['Blend', 'Calcs']);
	assert.equal(new Set(actions.map((a) => a.id)).size, actions.length, 'action ids stay unique');
	assert.ok(!plan.datasets.some((d) => d.key === 'joined'));
	assert.ok(plan.datasets.filter((d) => d.dataflowOutput).every((d) => d.dataflowOutput.dataflowKey === 'calc'));
	assert.equal(issues[0].code, 'data.dataflows-combined');
});

test('an intermediate a card reads stays published', () => {
	const plan = samplePlan();
	plan.cards.push({ key: 'c2', datasetKey: 'joined', body: { dataProvider: { dataSourceId: ref('dataset', 'joined') } } });
	combineDataflows(plan, { workbookKey: 'sales' });
	assert.ok(plan.dataflows[0].outputDatasetKeys.includes('joined'));
	assert.ok(plan.dataflows[0].definition.actions.some((a) => a.type === 'PublishToVault' && a.name === 'Joined'));
	assert.ok(!plan.dataflows[0].definition.actions.some((a) => a.type === 'LoadFromVault' && a.dataSourceId.$ref === 'dataset:joined'));
});

test('dataflows on other engines and SQL tile flows stay separate', () => {
	const plan = samplePlan();
	plan.dataflows.push(flow('sql', [load('in-x', 'raw'), { type: 'SQL', id: 'sql', name: 't2d_X_1', inputs: ['in-x'], statements: ['SELECT 1'] }], [], 'ADR'));
	combineDataflows(plan, { workbookKey: 'sales' });
	assert.deepEqual(plan.dataflows.map((d) => d.key).sort(), ['calc', 'sql']);
});

test('SQL tiles keep reading their inputs when a merge renames or replaces a tile', () => {
	const adr = (key, actions, outputs) => ({ ...flow(key, actions, outputs, 'ADR'), definition: { name: key, databaseType: 'ADR', computeCloud: 'c1', actions } });
	const plan = {
		source: { workbook: 'Sales' },
		datasets: [{ key: 'raw', strategy: 'cloud-amplifier' }, output('mid', 'one', 'Mid', false), output('final', 'two', 'Final', true)],
		dataflows: [
			adr('one', [{ ...load('in-raw', 'raw'), name: 't2d_RAW_1' }, { type: 'SQL', id: 'sql-a', name: 't2d_A_2', inputs: ['in-raw'], dependsOn: ['in-raw'], statements: ['SELECT * FROM t2d_RAW_1'] }, publish('out', 'sql-a', 'Mid')], ['mid']),
			adr('two', [{ ...load('in-mid', 'mid'), name: 't2d_A_2' }, { type: 'SQL', id: 'sql-b', name: 't2d_B_3', inputs: ['in-mid'], dependsOn: ['in-mid'], statements: ['SELECT COUNT(*) AS "N" FROM t2d_A_2'] }, publish('out', 'sql-b', 'Final')], ['final'])
		],
		cards: [{ key: 'c', body: { dataProvider: { dataSourceId: ref('dataset', 'final') } } }],
		beastModes: []
	};
	combineDataflows(plan, { workbookKey: 'sales' });
	assert.equal(plan.dataflows.length, 1);
	const sql = plan.dataflows[0].definition.actions.find((a) => a.id === 'sql-b');
	assert.deepEqual(sql.inputs, ['sql-a']);
	assert.equal(sql.statements[0], 'SELECT COUNT(*) AS "N" FROM t2d_A_2');
	assert.ok(!plan.datasets.some((d) => d.key === 'mid'));
});

test('dataflows over one Cloud Amplifier integration move to its warehouse, the flows that read them too', () => {
	const plan = samplePlan();
	plan.datasets[0] = { key: 'raw', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'snow' } };
	plan.datasets[1] = { key: 'other', strategy: 'view', view: { cloudId: 'snow' } };
	const issues = moveDataflowsToWarehouse(plan);
	assert.deepEqual(plan.dataflows.map((d) => [d.key, d.definition.databaseType, d.definition.computeCloud]), [['join.warehouse', 'ADR', 'snow'], ['calc.warehouse', 'ADR', 'snow'], ['blend.warehouse', 'ADR', 'snow']]);
	const join = plan.dataflows[0].definition.actions;
	assert.equal(join.find((a) => a.type === 'LoadFromVault').sourceType, 'AUTO');
	assert.equal(join.find((a) => a.type === 'PublishToVault').dataSource.cloudId, 'snow');
	assert.equal(plan.datasets.find((d) => d.key === 'calcs').dataflowOutput.dataflowKey, 'calc.warehouse');
	assert.equal(issues[0].code, 'data.dataflows-warehouse');
});

test('a dataflow with an input off the warehouse stays on Domo', () => {
	const plan = samplePlan();
	plan.datasets[0] = { key: 'raw', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'snow' } };
	plan.datasets[1] = { key: 'other', strategy: 'upload' };
	moveDataflowsToWarehouse(plan);
	assert.deepEqual(plan.dataflows.map((d) => d.definition.databaseType), ['MAGIC', 'MAGIC', 'ADR']);
});

test('a moved dataflow writes CAST AS STRING, which Adrenaline SQL has instead of CHAR', () => {
	const plan = samplePlan();
	plan.datasets[0] = { key: 'raw', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'snow' } };
	plan.dataflows[2].definition.actions[1] = { ...plan.dataflows[2].definition.actions[1], type: 'ExpressionEvaluator', expressions: [{ fieldName: 'k', expression: "COALESCE(CAST(`a` AS CHAR), '-')" }] };
	moveDataflowsToWarehouse(plan);
	assert.equal(plan.dataflows[2].definition.actions[1].expressions[0].expression, "COALESCE(CAST(`a` AS STRING), '-')");
});

test('a view only the warehouse dataflow reads becomes its SQL tiles', () => {
	const plan = samplePlan();
	plan.datasets[0] = { key: 'raw', name: 'RAW', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'snow' }, schema: [{ name: 'ID', type: 'LONG' }, { name: 'NAME', type: 'STRING' }] };
	plan.datasets[1] = { key: 'other', name: 'Other', strategy: 'view', view: { cloudId: 'snow' }, warehouseSql: { sql: 'SELECT ID, collate(NAME, \'en-ci\') AS NAME FROM "T2D_T1" WHERE collate(NAME, \'en-ci\') = \'x\'', tables: { T2D_T1: ref('dataset', 'raw') } }, schema: [] };
	moveDataflowsToWarehouse(plan);
	combineDataflows(plan, { workbookKey: 'sales' });
	assert.equal(plan.dataflows.length, 1);
	const actions = plan.dataflows[0].definition.actions;
	assert.ok(!plan.datasets.some((d) => d.key === 'other'), 'the view is no longer planned');
	assert.deepEqual(actions.filter((a) => a.type === 'LoadFromVault').map((a) => a.dataSourceId.$ref), ['dataset:raw']);
	const sql = actions.find((a) => a.type === 'SQL');
	assert.match(sql.statements[0], /WHERE collate\(NAME, 'en-ci'\) = 'x'/i);
	assert.equal(sql.settings.sqlDialect, 'SNOWFLAKE');
	assert.deepEqual(actions.find((a) => a.id === 'join').step2, sql.id);
});

test('a view cards read stays a view, and the warehouse dataflow runs its SQL itself', () => {
	const plan = samplePlan();
	plan.datasets[0] = { key: 'raw', name: 'RAW', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'snow' }, schema: [{ name: 'ID', type: 'LONG' }] };
	plan.datasets[1] = { key: 'other', name: 'Other', strategy: 'view', cardTarget: true, view: { cloudId: 'snow' }, warehouseSql: { sql: 'SELECT ID FROM "T2D_T1"', tables: { T2D_T1: ref('dataset', 'raw') } }, schema: [] };
	moveDataflowsToWarehouse(plan);
	combineDataflows(plan, { workbookKey: 'sales' });
	const actions = plan.dataflows[0].definition.actions;
	assert.ok(plan.datasets.some((d) => d.key === 'other' && d.strategy === 'view' && !d.dataflowOutput));
	assert.ok(!plan.dataflows[0].outputDatasetKeys.includes('other'));
	assert.ok(!actions.some((a) => a.type === 'PublishToVault' && a.name === 'Other'));
	assert.ok(!actions.some((a) => a.type === 'LoadFromVault' && a.dataSourceId.$ref === 'dataset:other'));
});

test('warehouse dataflows use the graph editor format, with one canvas tile per action', () => {
	const plan = samplePlan();
	plan.datasets[0] = { key: 'raw', strategy: 'cloud-amplifier', cloudAmplifier: { integrationId: 'snow' } };
	moveDataflowsToWarehouse(plan);
	useGraphEditor(plan);
	const [magic, , adr] = plan.dataflows;
	assert.deepEqual(magic.definition.gui ?? {}, {});
	assert.equal(adr.definition.gui.useGraphUI, true);
	assert.deepEqual(adr.definition.gui.canvases.default.elements.map((e) => e.id), adr.definition.actions.map((a) => a.id));
});
