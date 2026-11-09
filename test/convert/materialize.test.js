import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeCalcs } from '../../src/convert/materialize.js';
import { convertWorkbook } from '../../src/convert/index.js';

const DS = 'federated.abc';

const columns = [
	{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' },
	{ id: '[Customer]', name: 'Customer', datatype: 'string', role: 'dimension', kind: 'column' },
	{ id: '[Sales]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'column' },
	{ id: '[Order Date]', name: 'Order Date', datatype: 'date', role: 'dimension', kind: 'column' }
];
const calc = (id, formula, datatype = 'real', role = 'measure') => ({ id: `[${id}]`, name: id, datatype, role, kind: 'calculated', formula });

function ir(fields, { filters = [], parameters = [] } = {}) {
	return {
		irVersion: 1,
		workbook: { name: 'Superstore', sourceFile: 'x.twb' },
		datasources: [{ id: DS, caption: 'Superstore', connections: [], tables: [], relationships: [], fields: [...columns, ...fields], filters }],
		parameters,
		worksheets: [{ name: 'S', datasourceIds: [DS], filters: [] }],
		dashboards: [],
		issues: []
	};
}

const upload = () => ({
	key: 'wb.superstore',
	name: 'Superstore',
	strategy: 'upload',
	schema: [
		{ name: 'Region', type: 'STRING' },
		{ name: 'Customer', type: 'STRING' },
		{ name: 'Sales', type: 'DOUBLE' },
		{ name: 'Order Date', type: 'DATE' }
	],
	upload: { file: 'data/x.csv' },
	datasourceId: DS,
	cardTarget: true,
	fieldMap: { '[Region]': 'Region', '[Customer]': 'Customer', '[Sales]': 'Sales', '[Order Date]': 'Order Date' }
});

const run = (fields, { datasets = [upload()], dataflows = [], options = {}, irOpts } = {}) =>
	materializeCalcs(ir(fields, irOpts), { datasets, dataflows }, { options, workbookKey: 'wb' });

const bm = (r, id) => r.calcs.beastModes.find((b) => b.tableauFieldId === `[${id}]`);
const action = (flow, type) => flow.definition.actions.filter((a) => a.type === type);

test('a FIXED LOD used as a dimension becomes a Group By joined back in a new dataflow over the dataset', () => {
	const r = run([calc('First Order', '{FIXED [Customer] : MIN([Order Date])}', 'date', 'dimension'), calc('Is First', '[Order Date] = [First Order]', 'boolean', 'dimension')]);
	assert.equal(bm(r, 'First Order'), undefined);
	assert.equal(bm(r, 'Is First').status, 'ok');
	assert.equal(bm(r, 'Is First').expression, "CASE WHEN `Order Date` = `First Order` THEN 'true' WHEN `Order Date` != `First Order` THEN 'false' END");

	const source = r.datasets.find((d) => d.key === 'wb.superstore');
	const output = r.datasets.find((d) => d.key === 'wb.superstore.etl');
	assert.equal(source.cardTarget, false);
	assert.equal(output.cardTarget, true);
	assert.equal(output.strategy, 'dataflow-output');
	assert.deepEqual(output.schema.at(-1), { name: 'First Order', type: 'DATE' });
	assert.equal(output.fieldMap['[First Order]'], 'First Order');
	assert.equal(r.calcs.bindings.get(DS, '[First Order]').kind, 'column');
	assert.equal(r.calcs.bindings.datasetKeyFor(DS), 'wb.superstore.etl');

	const [flow] = r.dataflows;
	assert.equal(flow.key, 'wb.superstore.etl');
	assert.deepEqual(flow.outputDatasetKeys, ['wb.superstore.etl']);
	assert.deepEqual(action(flow, 'LoadFromVault')[0].dataSourceId, { $ref: 'dataset:wb.superstore' });
	const [group] = action(flow, 'GroupBy');
	assert.deepEqual(group.groups, [{ name: 'Customer' }]);
	assert.deepEqual(group.fields, [{ name: 'First Order', expression: 'MIN(`Order Date`)' }]);
	const [join] = action(flow, 'MergeJoin');
	assert.deepEqual([join.step1, join.step2, join.joinType], ['in-source', group.id, 'LEFT OUTER']);
	assert.deepEqual([join.keys1, join.keys2], [['Customer'], ['Customer']]);
	assert.deepEqual(join.schemaModification2, [{ name: 'Customer', rename: 'Customer', remove: true }]);
	const [publish] = action(flow, 'PublishToVault');
	assert.deepEqual(publish.dependsOn, [join.id]);
	assert.equal(publish.name, output.dataflowOutput.outputName);
	assert.ok(r.issues.some((i) => i.code === 'calc.materialized' && i.object.id === '[First Order]'));
	assert.ok(r.issues.some((i) => i.code === 'calc.materialized-dataflow'));
});

test('a wrapped nested LOD materializes the inner LOD and keeps the outer one a FIXED beast mode', () => {
	const r = run([calc('Cust Sales', '{FIXED [Customer] : SUM([Sales])}'), calc('Big Regions', '{FIXED [Region] : MAX(IF [Cust Sales] > 100 THEN 1 ELSE 0 END)}')]);
	assert.equal(bm(r, 'Cust Sales'), undefined);
	const outer = bm(r, 'Big Regions');
	assert.notEqual(outer.status, 'unsupported');
	assert.match(outer.expression, /MAX\(CASE WHEN `Cust Sales` > 100 THEN 1 ELSE 0 END\) FIXED \(BY `Region`/);
	assert.deepEqual(action(r.dataflows[0], 'GroupBy')[0].fields, [{ name: 'Cust Sales', expression: 'SUM(`Sales`)' }]);
});

test('an LOD used as a dimension pulls in the LODs it references, in dependency order, with key columns for calculated dimensions', () => {
	const r = run([
		calc('Year Label', 'STR(YEAR([Order Date]))', 'string', 'dimension'),
		calc('Min Date', '{FIXED [Customer] : MIN([Order Date])}', 'date'),
		calc('First Sales', '{FIXED [Customer], [Year Label] : SUM(IF [Order Date] = [Min Date] THEN [Sales] END)}', 'real', 'dimension')
	]);
	const flow = r.dataflows[0];
	const groups = action(flow, 'GroupBy');
	assert.deepEqual(groups.map((g) => g.fields[0].name), ['Min Date', 'First Sales']);
	assert.deepEqual(groups[1].groups, [{ name: 'Customer' }, { name: '_t2d_key_1' }]);
	assert.equal(groups[1].fields[0].expression, 'SUM(CASE WHEN `Order Date` = `Min Date` THEN `Sales` END)');
	const keys = action(flow, 'ExpressionEvaluator');
	assert.deepEqual(keys[0].expressions, [{ fieldName: '_t2d_key_1', expression: 'CAST(YEAR(`Order Date`) AS CHAR)' }]);
	const [drop] = action(flow, 'Metadata');
	assert.deepEqual(drop.fields, [{ name: '_t2d_key_1', remove: true }]);
	assert.deepEqual(action(flow, 'PublishToVault')[0].dependsOn, [drop.id]);
	assert.equal(bm(r, 'Year Label').status, 'ok');
});

test('an inline LOD in a row-level calc becomes its own column; FIXED with no dimensions is a cross join', () => {
	const r = run([calc('Share', '[Sales] / {FIXED : SUM([Sales])}')]);
	assert.equal(bm(r, 'Share').expression, '`Sales` / NULLIF(`Share (LOD)`, 0)');
	const [join] = action(r.dataflows[0], 'MergeJoin');
	assert.equal(join.joinType, 'CROSS');
	assert.deepEqual(action(r.dataflows[0], 'GroupBy')[0].groups, []);
	assert.ok(r.issues.some((i) => i.code === 'calc.materialized' && /an LOD inside it/.test(i.message)));
});

test('a materialized calc using TODAY() warns that the column holds the last run; only refreshed inputs rerun the flow', () => {
	const r = run([calc('Age', 'SIN(DATEDIFF("day", [Order Date], TODAY()))'), calc('Big', '{FIXED [Customer] : MAX([Sales])}', 'real', 'dimension')]);
	assert.deepEqual(r.issues.filter((i) => i.code === 'calc.materialized-today').map((i) => i.object.id), ['[Age]']);
	assert.equal(action(r.dataflows[0], 'LoadFromVault')[0].executeFlowWhenUpdated, false);
	const connector = run([calc('Wave', 'SIN([Sales])')], { datasets: [{ ...upload(), strategy: 'connector', upload: undefined }] });
	assert.equal(action(connector.dataflows[0], 'LoadFromVault')[0].executeFlowWhenUpdated, true);
});

test('trig functions become a Magic ETL formula column', () => {
	const r = run([calc('Wave', 'SIN([Sales]) + ATAN2([Sales], 2)'), calc('Double Wave', '[Wave] * 2')]);
	assert.equal(bm(r, 'Wave'), undefined);
	assert.equal(bm(r, 'Double Wave').expression, '`Wave` * 2');
	const [formula] = action(r.dataflows[0], 'ExpressionEvaluator');
	assert.deepEqual(formula.expressions, [{ fieldName: 'Wave', expression: 'SIN(`Sales`) + ATAN2(`Sales`, 2)' }]);
	assert.equal(r.datasets.find((d) => d.cardTarget).schema.at(-1).type, 'DOUBLE');
});

test('an aggregate calc with a trig function stays unsupported', () => {
	const r = run([calc('Agg Wave', 'SUM(SIN([Sales]))')]);
	assert.equal(bm(r, 'Agg Wave').status, 'unsupported');
	assert.equal(r.dataflows.length, 0);
});

test('INCLUDE used as a dimension is not materialized and is reported', () => {
	const r = run([calc('Inc', '{INCLUDE [Customer] : SUM([Sales])}', 'real', 'dimension')]);
	assert.equal(bm(r, 'Inc').status, 'unsupported');
	assert.ok(r.issues.some((i) => i.code === 'calc.materialize-skipped' && /only FIXED/.test(i.message)));
	assert.equal(r.dataflows.length, 0);
	assert.ok(r.datasets.find((d) => d.key === 'wb.superstore').cardTarget);
});

test('materialize: false keeps the beast mode errors and plans no dataflow', () => {
	const r = run([calc('First Order', '{FIXED [Customer] : MIN([Order Date])}', 'date', 'dimension')], { options: { materialize: false } });
	assert.equal(bm(r, 'First Order').status, 'unsupported');
	assert.equal(r.dataflows.length, 0);
	assert.deepEqual(r.issues, []);
});

test('a join dataflow gets the tiles before its output; parameters and filters are reported', () => {
	const joined = { ...upload(), key: 'wb.superstore', strategy: 'dataflow-output', dataflowOutput: { dataflowKey: 'wb.superstore', outputName: 'Superstore' } };
	delete joined.upload;
	const flow = {
		key: 'wb.superstore',
		name: 'Superstore (Tableau joins)',
		outputDatasetKeys: ['wb.superstore'],
		runAfterCreate: true,
		definition: {
			name: 'Superstore (Tableau joins)',
			actions: [
				{ type: 'LoadFromVault', id: 'in-orders', gui: { x: 50, y: 50 } },
				{ type: 'LoadFromVault', id: 'in-people', gui: { x: 50, y: 170 } },
				{ type: 'MergeJoin', id: 'join-people', dependsOn: ['in-orders', 'in-people'], gui: { x: 270, y: 50 } },
				{ type: 'PublishToVault', id: 'out-superstore', name: 'Superstore', dependsOn: ['join-people'], gui: { x: 490, y: 50 } }
			]
		}
	};
	const parameters = [{ id: '[Parameters].[Min]', name: 'Min', datatype: 'real', domain: 'all', value: 5 }];
	const r = run([calc('Top Cust', '{FIXED [Customer] : MAX(IF [Sales] > [Parameters].[Min] THEN 1 ELSE 0 END)}', 'integer', 'dimension')], {
		datasets: [joined],
		dataflows: [flow],
		irOpts: { parameters, filters: [{ datasourceId: DS, fieldId: '[Region]', kind: 'categorical', include: ['East'] }] }
	});
	assert.equal(r.dataflows.length, 1);
	assert.equal(r.datasets.length, 1);
	const actions = r.dataflows[0].definition.actions;
	assert.deepEqual(actions.find((a) => a.type === 'GroupBy').dependsOn, ['join-people']);
	assert.equal(actions.find((a) => a.type === 'GroupBy').fields[0].expression, 'MAX(CASE WHEN `Sales` > 5 THEN 1 ELSE 0 END)');
	assert.equal(actions.at(-1).type, 'PublishToVault');
	assert.deepEqual(actions.at(-1).dependsOn, [actions.find((a) => a.type === 'MergeJoin' && a.id !== 'join-people').id]);
	assert.equal(r.datasets[0].fieldMap['[Top Cust]'], 'Top Cust');
	assert.deepEqual(flow.definition.actions.length, 4, 'the planned dataflow is not mutated');
	const codes = r.issues.map((i) => i.code);
	assert.ok(codes.includes('calc.materialized-parameter'));
	assert.ok(codes.includes('calc.materialized-filters'));
	assert.ok(!codes.includes('calc.materialized-dataflow'));
});

test('a shared published datasource dataset stays shared; the computed columns go to a workbook-scoped dataflow', () => {
	const shared = { ...upload(), key: 'pds-luid', shared: { luid: 'luid', name: 'Superstore' }, previousKey: 'wb.superstore' };
	const r = run([calc('First Order', '{FIXED [Customer] : MIN([Order Date])}', 'date', 'dimension')], { datasets: [shared] });
	const output = r.datasets.find((d) => d.cardTarget);
	assert.equal(output.key, 'wb.superstore.etl');
	assert.equal(output.shared, undefined);
	assert.equal(r.dataflows[0].shared, undefined);
	assert.deepEqual(action(r.dataflows[0], 'LoadFromVault')[0].dataSourceId, { $ref: 'dataset:pds-luid' });
	assert.ok(r.issues.some((i) => i.code === 'calc.materialized-dataflow' && /stays shared/.test(i.message)));
});

test('column types follow the result: an inline LOD keeps its number type under STR, a string calc over a number is cast', () => {
	const r = run([
		calc('Was Requested', 'STR({FIXED [Customer] : MAX(IF [Region] = "East" THEN 1 ELSE 0 END)})', 'string', 'dimension'),
		calc('Max Label', '{FIXED [Customer] : MAX([Sales])}', 'string', 'dimension')
	]);
	const target = r.datasets.find((d) => d.cardTarget);
	assert.deepEqual(target.schema.find((c) => c.name === 'Was Requested (LOD)'), { name: 'Was Requested (LOD)', type: 'LONG' });
	assert.equal(bm(r, 'Was Requested').expression, 'CAST(`Was Requested (LOD)` AS CHAR)');
	assert.equal(bm(r, 'Was Requested').dataType, 'STRING');
	assert.deepEqual(target.schema.find((c) => c.name === 'Max Label'), { name: 'Max Label', type: 'STRING' });
	const group = action(r.dataflows[0], 'GroupBy').find((g) => g.fields[0].name === 'Max Label');
	assert.equal(group.fields[0].expression, 'CAST(MAX(`Sales`) AS CHAR)');
});

const pill = (fieldId, extra = {}) => ({ id: `[${DS}].[${fieldId}]`, datasourceId: DS, fieldId: `[${fieldId}]`, aggregated: false, datePart: null, dateTrunc: null, ...extra });
function sheet(name, { rows = [], cols = [], measure, orderFields = [], filters = [], nested }) {
	const m = pill(measure, { aggregated: true, tableCalc: { type: 'Calculation', orderingType: 'Field', orderFields: orderFields.map((p) => p.id), ...(nested ? { nested } : {}) } });
	const pills = Object.fromEntries([...rows, ...cols, m].map((p) => [p.id, p]));
	return { name, datasourceIds: [DS], rowPills: rows.map((p) => p.id), colPills: cols.map((p) => p.id), panes: [{ encodings: { text: [m.id] } }], pills, sorts: [], filters };
}
const region = pill('Region');
const month = pill('Order Date', { dateTrunc: 'month' });
const runWindow = (fields, worksheets, options = {}, irOpts) => {
	const base = ir(fields, irOpts);
	return materializeCalcs({ ...base, worksheets }, { datasets: [upload()], dataflows: [] }, { options: { useWindowFunctions: true, ...options }, workbookKey: 'wb' });
};

test('a table calc of a table calc computes the inner one at the worksheet grain in Magic ETL', () => {
	const fields = [calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))')];
	const r = runWindow(fields, [sheet('Ranks', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] })]);
	assert.equal(bm(r, 'Rank Running').status, 'ok');
	assert.equal(bm(r, 'Rank Running').expression, 'RANK() OVER (PARTITION BY `Region` ORDER BY MAX(`Rank Running (RUNNING_SUM)`) DESC)');

	const [flow] = r.dataflows;
	const [keys] = action(flow, 'ExpressionEvaluator');
	assert.equal(keys.expressions[0].fieldName, '_t2d_key_1');
	const [group] = action(flow, 'GroupBy');
	assert.deepEqual(group.groups, [{ name: 'Region' }, { name: '_t2d_key_1' }]);
	assert.deepEqual(group.fields, [{ name: '_t2d_value_1', expression: 'SUM(`Sales`)' }]);
	const [window] = action(flow, 'WindowAction');
	assert.deepEqual(window.dependsOn, [group.id]);
	assert.deepEqual(window.groupRules, [{ column: 'Region', caseSensitive: false }]);
	assert.deepEqual(window.orderRules, [{ column: '_t2d_key_1', caseSensitive: false, ascending: true }]);
	assert.deepEqual(window.additions, [{ name: 'Rank Running (RUNNING_SUM)', operation: { type: 'FRAMED', operationType: 'SUM', column: '_t2d_value_1', preceding: null, following: 0 } }]);
	const [join] = action(flow, 'MergeJoin');
	assert.deepEqual([join.step2, join.joinType, join.keys1], [window.id, 'LEFT OUTER', ['Region', '_t2d_key_1']]);
	assert.deepEqual(join.schemaModification2.map((m) => m.name), ['Region', '_t2d_key_1', '_t2d_value_1']);
	assert.deepEqual(action(flow, 'Metadata')[0].fields, [{ name: '_t2d_key_1', remove: true }]);
	assert.deepEqual(r.datasets.find((d) => d.key === 'wb.superstore.etl').schema.at(-1), { name: 'Rank Running (RUNNING_SUM)', type: 'DOUBLE' });

	const grain = r.issues.filter((i) => i.code === 'calc.table-calc-grain');
	assert.equal(grain.length, 1);
	assert.match(grain[0].message, /grain of worksheet 'Ranks' \(Region, DATETRUNC\('month', Order Date\)\)/);
});

test('a worksheet showing the calc with other dimensions gets a card warning; RANK inside WINDOW_AVG orders by the value', () => {
	const fields = [calc('Avg Rank', 'WINDOW_AVG(RANK(SUM([Sales]), "asc"))')];
	const r = runWindow(fields, [sheet('By Month', { rows: [region], cols: [month], measure: 'Avg Rank', orderFields: [month] }), sheet('By Region', { rows: [region], measure: 'Avg Rank' })]);
	assert.equal(bm(r, 'Avg Rank').expression, 'AVG(MAX(`Avg Rank (RANK)`)) OVER (PARTITION BY `Region`)');
	const [window] = action(r.dataflows[0], 'WindowAction');
	assert.deepEqual(window.orderRules, [{ column: '_t2d_value_1', caseSensitive: false, ascending: true }]);
	assert.deepEqual(window.additions[0].operation, { type: 'RANKING', operationType: 'RANK' });
	const card = r.issues.find((i) => i.code === 'calc.table-calc-grain' && i.object.type === 'worksheet');
	assert.equal(card.object.name, 'By Region');
	assert.match(card.message, /this card shows Region;/);
});

test('a nested table calc stays calc.table-calc-nested when its addressing is unknown or materialize is off', () => {
	const fields = [calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))')];
	const shown = [sheet('Ranks', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] })];
	const sorted = structuredClone(shown);
	sorted[0].sorts = [{ pillId: month.id, kind: 'computed', using: `[${DS}].[sum:Sales:qk]`, direction: 'DESC' }];
	for (const r of [runWindow(fields, [sheet('Other', { rows: [region], measure: 'Sales' })]), runWindow(fields, shown, { materialize: false }), runWindow(fields, sorted)]) {
		assert.equal(bm(r, 'Rank Running').status, 'unsupported');
		assert.ok(r.calcs.issues.some((i) => i.code === 'calc.table-calc-nested'));
		assert.equal(r.dataflows.length, 0);
	}
});

test('an inner table calc Rank & Window cannot compute is skipped with the reason', () => {
	const r = runWindow([calc('Rank Max', 'RANK(RUNNING_MAX(SUM([Sales])))')], [sheet('Ranks', { rows: [region], cols: [month], measure: 'Rank Max', orderFields: [month] })]);
	assert.equal(bm(r, 'Rank Max').status, 'unsupported');
	assert.match(r.issues.find((i) => i.code === 'calc.materialize-skipped').message, /RUNNING_MAX has no Magic ETL Rank & Window equivalent/);
	assert.equal(r.dataflows.length, 0);
});

test('nested table calcs at one grain share a Group By and a join; each partition and order gets one Rank & Window tile', () => {
	const fields = [
		calc('Running Sales', 'RUNNING_SUM(SUM([Sales]))'),
		calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))'),
		calc('Rank Ref', 'RANK([Running Sales])'),
		calc('Avg Running Customers', 'WINDOW_AVG(RUNNING_SUM(COUNTD([Customer])))'),
		calc('Avg Rank', 'WINDOW_AVG(RANK(SUM([Sales])))')
	];
	const sheets = ['Rank Running', 'Rank Ref', 'Avg Running Customers', 'Avg Rank'].map((m) => sheet(m, { rows: [region], cols: [month], measure: m, orderFields: [month] }));
	const r = runWindow(fields, sheets);
	for (const id of ['Rank Running', 'Rank Ref', 'Avg Running Customers', 'Avg Rank']) assert.equal(bm(r, id).status, 'ok', id);
	assert.equal(bm(r, 'Rank Ref').expression, bm(r, 'Rank Running').expression);

	const [flow] = r.dataflows;
	const groups = action(flow, 'GroupBy');
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].fields, [
		{ name: '_t2d_value_1', expression: 'SUM(`Sales`)' },
		{ name: '_t2d_value_2', expression: 'COUNT(DISTINCT `Customer`)' }
	]);
	const windows = action(flow, 'WindowAction');
	assert.equal(windows.length, 2);
	assert.deepEqual(windows[0].dependsOn, [groups[0].id]);
	assert.deepEqual(windows[1].dependsOn, [windows[0].id]);
	assert.deepEqual(windows[0].additions.map((a) => [a.name, a.operation.column]), [
		['Rank Running (RUNNING_SUM)', '_t2d_value_1'],
		['Avg Running Customers (RUNNING_SUM)', '_t2d_value_2']
	]);
	assert.deepEqual(windows[1].orderRules, [{ column: '_t2d_value_1', caseSensitive: false, ascending: false }]);
	assert.deepEqual(windows[1].additions, [{ name: 'Avg Rank (RANK)', operation: { type: 'RANKING', operationType: 'RANK' } }]);
	const joins = action(flow, 'MergeJoin');
	assert.equal(joins.length, 1);
	assert.equal(joins[0].step2, windows[1].id);
	assert.deepEqual(joins[0].schemaModification2.map((m) => m.name), ['Region', '_t2d_key_1', '_t2d_value_1', '_t2d_value_2']);
	assert.equal(action(flow, 'ExpressionEvaluator').length, 1);
	assert.equal(r.issues.filter((i) => i.code === 'calc.table-calc-grain').length, 4);
});

test('inner table calcs at different grains get their own Group By and join', () => {
	const fields = [calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))'), calc('Rank Customers', 'RANK(RUNNING_SUM(SUM([Sales])))')];
	const customer = pill('Customer');
	const r = runWindow(fields, [
		sheet('By Month', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] }),
		sheet('By Customer', { rows: [region], cols: [customer], measure: 'Rank Customers', orderFields: [customer] })
	]);
	const [flow] = r.dataflows;
	assert.equal(action(flow, 'GroupBy').length, 2);
	assert.equal(action(flow, 'MergeJoin').length, 2);
	assert.deepEqual(action(flow, 'GroupBy')[1].groups, [{ name: 'Region' }, { name: 'Customer' }]);
	assert.match(bm(r, 'Rank Customers').expression, /MAX\(`Rank Customers \(RUNNING_SUM\)`\)/);
});

test('a parameter inside the inner table calc is reported as fixed at its current value', () => {
	const parameters = [{ id: '[Parameters].[Factor]', name: 'Factor', datatype: 'real', domain: 'all', value: 2 }];
	const fields = [calc('Rank Scaled', 'RANK(RUNNING_SUM(SUM([Sales]) * [Parameters].[Factor]))')];
	const r = runWindow(fields, [sheet('Ranks', { rows: [region], cols: [month], measure: 'Rank Scaled', orderFields: [month] })], {}, { parameters });
	assert.equal(bm(r, 'Rank Scaled').status, 'ok');
	assert.equal(action(r.dataflows[0], 'GroupBy')[0].fields[0].expression, 'SUM(`Sales`) * 2');
	assert.match(r.issues.find((i) => i.code === 'calc.materialized-parameter').message, /Factor/);
});

test('an inner table calc of a referenced calc uses that calc\'s nested compute-using from the pill', () => {
	const fields = [calc('Running Sales', 'RUNNING_SUM(SUM([Sales]))'), calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))'), calc('Rank Ref', 'RANK([Running Sales])')];
	const along = (p) => ({ '[Running Sales]': { type: 'Calculation', orderingType: 'Field', orderFields: [p.id] } });
	const sheets = (nestedOrder) => [
		sheet('Rank Running', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] }),
		sheet('Rank Ref', { rows: [region], cols: [month], measure: 'Rank Ref', orderFields: [month], nested: along(nestedOrder) })
	];

	const same = runWindow(fields, sheets(month));
	assert.equal(action(same.dataflows[0], 'WindowAction').length, 1);
	assert.equal(bm(same, 'Rank Ref').expression, bm(same, 'Rank Running').expression);

	const r = runWindow(fields, sheets(region));
	assert.equal(bm(r, 'Rank Ref').expression, 'RANK() OVER (PARTITION BY `Region` ORDER BY MAX(`Rank Ref (RUNNING_SUM)`) DESC)');
	const [flow] = r.dataflows;
	assert.equal(action(flow, 'GroupBy').length, 1);
	const windows = action(flow, 'WindowAction').map((w) => [w.groupRules.map((g) => g.column), w.orderRules.map((o) => o.column), w.additions.map((a) => a.name)]);
	assert.deepEqual(windows, [
		[['Region'], ['_t2d_key_1'], ['Rank Running (RUNNING_SUM)']],
		[['_t2d_key_1'], ['Region'], ['Rank Ref (RUNNING_SUM)']]
	]);
});

test('an LOD inside an inner table calc is computed first in the same dataflow', () => {
	const fields = [calc('Avg Running Region', 'WINDOW_AVG(RUNNING_SUM(SUM({FIXED [Region] : SUM([Sales])})))')];
	const r = runWindow(fields, [sheet('Avg', { rows: [region], cols: [month], measure: 'Avg Running Region', orderFields: [month] })]);
	assert.equal(bm(r, 'Avg Running Region').status, 'ok');
	assert.ok(!r.issues.some((i) => i.code === 'calc.materialize-skipped'));
	const [flow] = r.dataflows;
	const [lod, grain] = action(flow, 'GroupBy');
	assert.deepEqual(lod.fields, [{ name: 'Avg Running Region (LOD)', expression: 'SUM(`Sales`)' }]);
	assert.deepEqual(grain.fields, [{ name: '_t2d_value_1', expression: 'SUM(`Avg Running Region (LOD)`)' }]);
	assert.equal(action(flow, 'MergeJoin').length, 2);
});

test('a stale inlineNestedCalcs option is ignored: an inner table calc behind a reference is materialized', () => {
	const fields = [calc('Running Sales', 'RUNNING_SUM(SUM([Sales]))'), calc('Rank Ref', 'RANK([Running Sales])')];
	const r = runWindow(fields, [sheet('Rank Ref', { rows: [region], cols: [month], measure: 'Rank Ref', orderFields: [month] })], { inlineNestedCalcs: false });
	assert.equal(bm(r, 'Rank Ref').status, 'ok');
	assert.equal(r.dataflows.length, 1);
});

test('null view dimensions of a precomputed inner table calc are reported', () => {
	const r = runWindow([calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))')], [sheet('Ranks', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] })]);
	assert.match(r.issues.find((i) => i.code === 'calc.materialized-null-keys').message, /view dimensions of a precomputed inner table calc are null/);
});

test('a card with the grain dimensions but its own filters gets a card warning', () => {
	const fields = [calc('Rank Running', 'RANK(RUNNING_SUM(SUM([Sales])))')];
	const filters = [{ datasourceId: DS, fieldId: '[Customer]', kind: 'categorical', include: ['A'] }];
	const r = runWindow(fields, [
		sheet('Ranks', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] }),
		sheet('Filtered', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month], filters }),
		sheet('Same', { rows: [region], cols: [month], measure: 'Rank Running', orderFields: [month] })
	]);
	const cards = r.issues.filter((i) => i.code === 'calc.table-calc-grain' && i.object.type === 'worksheet');
	assert.deepEqual(cards.map((i) => i.object.name), ['Filtered']);
	assert.match(cards[0].message, /after this card's filters/);
});

const pad = `"${'x'.repeat(1500)}"`;
const doubling = (from, levels, datatype = 'string') =>
	Array.from({ length: levels }, (_, i) => calc(`D${i + 1}`, `[${i ? `D${i}` : from}] + [${i ? `D${i}` : from}]`, datatype, 'dimension'));

test('a reused row-level calc that makes beast modes too large is computed once as a column', () => {
	const r = run([calc('H', `[Region] + ${pad}`, 'string', 'dimension'), ...doubling('H', 6), calc('Distinct', 'COUNTD([D6])')]);
	for (const b of r.calcs.beastModes) {
		assert.ok(b.expression.length < 65536, b.name);
		assert.equal(b.status, 'ok', b.name);
	}
	assert.equal(bm(r, 'H'), undefined);
	assert.doesNotMatch(bm(r, 'D6').expression, /xxxx/);
	assert.match(bm(r, 'Distinct').expression, /^COUNT\(DISTINCT CONCAT\(CONCAT\(.*`H`, `H`\)/);
	assert.doesNotMatch(bm(r, 'Distinct').expression, /xxxx/);
	const [formula] = action(r.dataflows[0], 'ExpressionEvaluator');
	assert.deepEqual(formula.settings, { zoneId: 'UTC' });
	assert.deepEqual(formula.expressions, [{ fieldName: 'H', expression: `CONCAT(\`Region\`, '${'x'.repeat(1500)}')` }]);
	assert.ok(r.issues.some((i) => i.code === 'calc.materialized-size' && /1 row-level calc/.test(i.message)));
});

test('beast modes under the large size keep their calcs inlined', () => {
	const r = run([calc('H', `[Region] + ${pad}`, 'string', 'dimension'), ...doubling('H', 4)]);
	assert.equal(r.dataflows.length, 0);
	assert.match(bm(r, 'D4').expression, /xxxx/);
});

test('materialized calcs go bottom-up; a calc shares a formula tile unless it reads a column of that tile', () => {
	const r = run([
		calc('A', `[Region] + ${pad}`, 'string', 'dimension'),
		calc('X', `[Customer] + ${pad}`, 'string', 'dimension'),
		calc('B', `[A] + [A] + ${pad}`, 'string', 'dimension'),
		calc('C', '[B] + [B] + [X] + [X]', 'string', 'dimension'),
		...doubling('C', 5)
	]);
	const tiles = action(r.dataflows[0], 'ExpressionEvaluator');
	assert.deepEqual(tiles.map((t) => t.expressions.map((e) => e.fieldName)), [['A'], ['B', 'X']]);
	assert.deepEqual(tiles[1].dependsOn, [tiles[0].id]);
	assert.equal(tiles[1].expressions[0].expression, `CONCAT(\`A\`, \`A\`, '${'x'.repeat(1500)}')`);
	assert.ok(r.calcs.beastModes.every((b) => b.expression.length < 65536));
});

test('calcs with parameters stay inlined in variables mode, so the beast mode is reported as too large', () => {
	const parameters = [{ id: '[Parameters].[P]', name: 'P', datatype: 'string', value: 'v' }];
	const r = run([calc('H', `[Region] + [Parameters].[P] + ${pad}`, 'string', 'dimension'), ...doubling('H', 6)], { options: { parameters: 'variables' }, irOpts: { parameters } });
	assert.equal(r.dataflows.length, 0);
	assert.equal(bm(r, 'D6').status, 'approximate');
	assert.ok(r.calcs.issues.some((i) => i.code === 'calc.expression-large'));
});

test('a blend over a joined primary reads the columns the primary join dataflow computes instead of computing them again', () => {
	const S = 'federated.targets';
	const col = (remoteName, localType, tableId, localName = `[${remoteName}]`) => ({ remoteName, localName, tableId, localType });
	const field = (id, name, datatype) => ({ id, name, datatype, role: datatype === 'real' ? 'measure' : 'dimension', kind: 'column' });
	const pill = (ds, prefix, f, typeKey) => {
		const id = `[${ds}].[${prefix}:${f}:${typeKey}]`;
		return [id, { id, datasourceId: ds, fieldId: `[${f}]`, derivation: prefix === 'sum' ? 'Sum' : 'None', prefix, typeKey, continuous: typeKey === 'qk', aggregated: prefix === 'sum', datePart: null, dateTrunc: null }];
	};
	const [first, region, sales, target] = [pill(DS, 'none', 'First', 'nk'), pill(DS, 'none', 'Region', 'nk'), pill(DS, 'sum', 'Sales', 'qk'), pill(S, 'sum', 'Target', 'qk')];
	const sheet = (name, dsIds, rows, text) => ({ name, datasourceIds: dsIds, pills: Object.fromEntries([...rows, ...text]), rowPills: rows.map((p) => p[0]), colPills: [], panes: [{ markClass: 'Text', encodings: { text: text.map((p) => p[0]) } }], filters: [], sorts: [], aggregated: true, measureValues: [] });
	const model = {
		irVersion: 1,
		workbook: { name: 'JB', sourceFile: 'x.twb' },
		datasources: [
			{
				id: DS,
				caption: 'Superstore',
				connections: [],
				tables: [
					{ id: 'Orders_1', name: 'Orders', kind: 'table', columns: [col('Region', 'string', 'Orders_1'), col('Sales', 'real', 'Orders_1')] },
					{ id: 'People_2', name: 'People', kind: 'table', columns: [col('Region', 'string', 'People_2', '[Region (People)]'), col('Person', 'string', 'People_2')] }
				],
				relationships: [{ fromTableId: 'Orders_1', toTableId: 'People_2', on: [{ left: '[Region]', right: '[Region (People)]' }] }],
				fields: [field('[Region]', 'Region', 'string'), field('[Sales]', 'Sales', 'real'), field('[Region (People)]', 'Region (People)', 'string'), field('[Person]', 'Person', 'string'), calc('First', '{FIXED [Person] : MIN([Sales])}', 'real', 'dimension')],
				filters: []
			},
			{ id: S, caption: 'Targets', connections: [], tables: [], relationships: [], fields: [field('[Region]', 'Region', 'string'), field('[Target]', 'Target', 'real')], filters: [] }
		],
		parameters: [],
		worksheets: [sheet('Primary only', [DS], [first], [sales]), sheet('Blended', [DS, S], [region, first], [sales, target])],
		dashboards: [],
		issues: []
	};
	const table = (name, tableId, columns) => ({ name, tableId, file: `data/${name}.csv`, columns, rowCount: 3, flattened: false });
	const manifests = [
		{ datasourceId: DS, strategy: 'hyper', tables: [table('Orders', 'Orders_1', [{ name: 'Region', type: 'STRING', sourceName: 'Region' }, { name: 'Sales', type: 'DOUBLE', sourceName: 'Sales' }]), table('People', 'People_2', [{ name: 'Region', type: 'STRING', sourceName: 'Region' }, { name: 'Person', type: 'STRING', sourceName: 'Person' }])], issues: [] },
		{ datasourceId: S, strategy: 'hyper', tables: [{ name: 'Targets', file: 'data/t.csv', rowCount: 2, flattened: true, columns: [{ name: 'Region', type: 'STRING' }, { name: 'Target', type: 'DOUBLE' }] }], issues: [] }
	];
	const plan = convertWorkbook(model, { manifests, options: { parameters: 'inline', combineDataflows: false } });
	const blendCard = plan.cards.find((c) => c.worksheet === 'Blended');
	const blendFlow = plan.dataflows.find((d) => d.key === blendCard.datasetKey);
	assert.ok(!blendFlow.definition.actions.some((a) => a.id === 'group-first'), 'the blend does not compute First again');
	assert.equal(action(plan.dataflows.find((d) => d.key === 'jb.superstore'), 'GroupBy').length, 1);
	assert.deepEqual(plan.datasets.find((d) => d.key === blendCard.datasetKey).schema.filter((c) => c.name === 'First'), [{ name: 'First', type: 'DOUBLE' }]);
	assert.ok(JSON.stringify(blendCard.body).includes('"First"'));
});

const topSheet = (name, { rows = [], filters = [] } = {}) => {
	const measure = pill('Customer', { id: `[${DS}].[ctd:Customer:qk]`, aggregated: true });
	const pills = Object.fromEntries([...rows, measure].map((p) => [p.id, p]));
	return { name, datasourceIds: [DS], rowPills: rows.map((p) => p.id), colPills: [measure.id], panes: [{ encodings: {} }], pills, sorts: [], filters };
};
const topN = (by = 'COUNTD([Customer])', extra = {}) => ({ pillId: region.id, datasourceId: DS, fieldId: '[Region]', kind: 'top', top: { count: 16, direction: 'top', by, ...extra } });
const exclude = (field, list, extra = {}) => ({ pillId: `[${DS}].[none:${field}:nk]`, datasourceId: DS, fieldId: `[${field}]`, kind: 'categorical', exclude: list, ...extra });

test('a Top N with another dimension on the sheet becomes a null-safe Magic ETL member rank the card filters on', () => {
	const r = runWindow([], [topSheet('Articles', { rows: [region, pill('Customer')], filters: [topN()] })]);
	const flow = r.dataflows[0];
	assert.deepEqual(flow.definition.actions.map((a) => a.type), ['LoadFromVault', 'ExpressionEvaluator', 'GroupBy', 'WindowAction', 'MergeJoin', 'Metadata', 'PublishToVault']);
	assert.equal(action(flow, 'ExpressionEvaluator')[0].expressions[0].expression, "COALESCE(CAST(`Region` AS CHAR), '#t2d-null#')", 'the Null member keeps its rank through the join');
	assert.deepEqual(action(flow, 'GroupBy')[0].fields, [{ name: '_t2d_value_1', expression: 'COUNT(DISTINCT `Customer`)' }]);
	const [win] = action(flow, 'WindowAction');
	assert.deepEqual([win.orderRules, win.additions], [[{ column: '_t2d_value_1', caseSensitive: false, ascending: false }], [{ name: 'Region (top rank by COUNTD(Customer))', operation: { type: 'RANKING', operationType: 'RANK' } }]]);
	assert.deepEqual(action(flow, 'MergeJoin')[0].keys1, ['_t2d_key_1']);
	assert.equal(r.ir.worksheets[0].filters[0].top.rankColumn, 'Region (top rank by COUNTD(Customer))');
	assert.ok(r.datasets.find((d) => d.cardTarget).schema.some((c) => c.name === 'Region (top rank by COUNTD(Customer))' && c.type === 'LONG'));
});

test('a Top N alone on the sheet with no other active filter keeps the card row limit', () => {
	const r = runWindow([], [topSheet('Top', { rows: [region], filters: [topN(), { ...exclude('Customer', ['Ann']), all: true }] })]);
	assert.equal(r.dataflows.length, 0);
	assert.equal(r.ir.worksheets[0].filters[0].top.rankColumn, undefined);
	const shown = runWindow([], [topSheet('Top', { rows: [region], filters: [topN(), { ...exclude('Customer', []), all: true, shownOnDashboard: true }] })]);
	assert.equal(shown.ir.worksheets[0].filters[0].top.rankColumn, 'Region (top rank by COUNTD(Customer))', 'a shown quick filter can narrow the rows, which Tableau does after the rank');
});

test('datasource and context filters run before the rank in a Filter tile; a shown context filter warns; a bottom N ranks ascending', () => {
	const context = { ...exclude('Customer', [null, 'Ann']), context: true };
	const shownContext = { pillId: `[${DS}].[none:Region:nk]`, datasourceId: DS, fieldId: '[Region]', kind: 'categorical', include: ['East', null], context: true, shownOnDashboard: true };
	const r = runWindow([], [topSheet('Ctx', { rows: [region, pill('Customer')], filters: [topN('SUM([Sales])', { direction: 'bottom' }), context, shownContext] })], {}, { filters: [{ datasourceId: DS, fieldId: '[Sales]', kind: 'quantitative', min: 0 }] });
	const flow = r.dataflows[0];
	const [filter] = action(flow, 'Filter');
	assert.equal(filter.filterList[0].expression, "(`Sales` >= 0) AND (`Customer` IS NOT NULL AND `Customer` NOT IN ('Ann')) AND (`Region` IN ('East') OR `Region` IS NULL)");
	assert.deepEqual(action(flow, 'GroupBy')[0].dependsOn, [filter.id]);
	assert.equal(action(flow, 'WindowAction')[0].orderRules[0].ascending, true);
	assert.ok(r.issues.some((i) => i.code === 'filter.top-context' && /current selection of the context filter on Region/.test(i.message)));
});

test('sheets sharing a Top N spec share one rank column; materialize off keeps the limit path', () => {
	const sheets = ['A', 'B'].map((name) => topSheet(name, { rows: [region, pill('Customer')], filters: [topN()] }));
	const r = runWindow([], sheets);
	assert.equal(action(r.dataflows[0], 'WindowAction').length, 1);
	assert.deepEqual(r.ir.worksheets.map((w) => w.filters[0].top.rankColumn), ['Region (top rank by COUNTD(Customer))', 'Region (top rank by COUNTD(Customer))']);
	assert.equal(runWindow([], sheets, { materialize: false }).ir.worksheets[0].filters[0].top.rankColumn, undefined);
});

const topSet = (top) => ({ id: '[Top Customers]', name: 'Top Customers', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', top } });
const setFilter = { pillId: `[${DS}].[io:Top Customers:nk]`, datasourceId: DS, fieldId: '[Top Customers]', kind: 'categorical', all: true, shownOnDashboard: true };
const N = { id: '[Parameters].[Parameter 3]', name: 'Top N', datatype: 'integer', domain: 'all', value: 10 };

test('a top N set is a Magic ETL member rank after the datasource and context filters, In up to a variable N', () => {
	const single = { pillId: `[${DS}].[none:Region:nk]`, datasourceId: DS, fieldId: '[Region]', kind: 'categorical', include: ['East'], context: true, shownOnDashboard: true };
	const fixed = { ...exclude('Customer', ['Ann']), context: true };
	const dimension = { ...exclude('Customer', ['Bob']), shownOnDashboard: true };
	const sheets = [topSheet('Deals', { rows: [region, pill('Customer')], filters: [setFilter, single, fixed, dimension] })];
	const r = runWindow([topSet({ count: '[Parameters].[Parameter 3]', direction: 'top', by: 'SUM([Sales])' })], sheets, { parameters: 'variables' }, { parameters: [N], filters: [{ datasourceId: DS, fieldId: '[Sales]', kind: 'quantitative', min: 0 }] });
	const flow = r.dataflows[0];
	assert.deepEqual(action(flow, 'ExpressionEvaluator')[0].expressions.map((e) => e.expression), ["COALESCE(CAST(`Customer` AS CHAR), '#t2d-null#')", "COALESCE(CAST(`Region` AS CHAR), '#t2d-null#')"]);
	assert.equal(action(flow, 'Filter')[0].filterList[0].expression, "(`Sales` >= 0) AND ((`Customer` IS NULL OR `Customer` NOT IN ('Ann')))", 'the sheet filter that is not in context ranks after the set, as in Tableau');
	assert.deepEqual(action(flow, 'GroupBy')[0].groups, [{ name: '_t2d_key_1' }, { name: '_t2d_key_2' }]);
	const [win] = action(flow, 'WindowAction');
	assert.deepEqual([win.groupRules, win.orderRules[0].ascending, win.additions[0].name], [[{ column: '_t2d_key_2', caseSensitive: false }], false, 'Top Customers (top rank)']);
	assert.deepEqual(action(flow, 'MergeJoin')[0].keys1, ['_t2d_key_1', '_t2d_key_2']);
	const set = bm(r, 'Top Customers');
	assert.equal(set.status, 'ok');
	assert.match(set.expression, /^CASE\s+WHEN `Top Customers \(top rank\)` <= DOMO_BEAST_MODE\(calculation_[0-9a-f-]+\) THEN 'In'\s+ELSE 'Out'\s+END$/);
	const codes = r.issues.filter((i) => i.object?.name === 'Top Customers').map((i) => i.code);
	assert.deepEqual(codes.filter((c) => c.startsWith('calc.set-top')).sort(), ['calc.set-top-partition', 'calc.set-top-rank']);
	assert.ok(r.issues.some((i) => i.code === 'calc.set-top-partition' && /each value of the context filters Region/.test(i.message)));
});

test('a bottom N set with a constant count ranks ascending; an unused one or materialize off stays unsupported', () => {
	const bottom = topSet({ count: 5, direction: 'bottom', by: 'SUM([Sales])' });
	const r = runWindow([bottom], [topSheet('Low', { rows: [region], filters: [setFilter] })]);
	assert.equal(action(r.dataflows[0], 'WindowAction')[0].orderRules[0].ascending, true);
	assert.equal(bm(r, 'Top Customers').expression.replace(/\s+/g, ' '), "CASE WHEN `Top Customers (bottom rank)` <= 5 THEN 'In' ELSE 'Out' END");
	assert.equal(runWindow([bottom], [topSheet('None', { rows: [region] })]).dataflows.length, 0);
	const off = runWindow([bottom], [topSheet('Low', { rows: [region], filters: [setFilter] })], { materialize: false });
	assert.equal(bm(off, 'Top Customers').status, 'unsupported');
	assert.ok(off.calcs.issues.some((i) => i.code === 'calc.set-top'));
});

test('a top N set ranked by a list parameter switch gets one rank per value, picked by the variable', () => {
	const metric = { id: '[Parameters].[Parameter 2]', name: 'Metric', datatype: 'string', domain: 'list', value: 'Sales', members: [{ value: 'Sales' }, { value: 'Count' }] };
	const amount = calc('Amount', 'IF [Parameters].[Parameter 2] = "Sales" THEN [Sales] ELSE 1 END');
	const r = runWindow([amount, topSet({ count: 3, direction: 'top', by: 'SUM([Amount])' })], [topSheet('Deals', { rows: [region], filters: [setFilter] })], { parameters: 'variables' }, { parameters: [metric] });
	const flow = r.dataflows[0];
	assert.equal(action(flow, 'GroupBy')[0].fields.length, 2);
	assert.deepEqual(action(flow, 'WindowAction').map((w) => w.additions[0].name), ['Top Customers (top rank, Metric Sales)', 'Top Customers (top rank, Metric Count)']);
	assert.ok(r.datasets.find((d) => d.cardTarget).schema.some((c) => c.name === 'Top Customers (top rank, Metric Count)'));
	const expr = bm(r, 'Top Customers').expression.replace(/\s+/g, ' ');
	assert.match(expr, /^CASE WHEN CASE DOMO_BEAST_MODE\(calculation_[0-9a-f-]+\) WHEN 'Sales' THEN `Top Customers \(top rank, Metric Sales\)` WHEN 'Count' THEN `Top Customers \(top rank, Metric Count\)` ELSE `Top Customers \(top rank, Metric Sales\)` END <= 3 THEN 'In' ELSE 'Out' END$/);
	assert.ok(!r.issues.some((i) => i.code === 'calc.materialized-parameter' && i.object?.name === 'Top Customers'), 'the switch is handled, so it is not reported');
});
