import test from 'node:test';
import assert from 'node:assert/strict';
import { bindVariables, inlineParameters, parameterVariableNames, resolveParameterModes, siteVariables, variableControl, variableExpression, variableReference } from '../../src/convert/variables.js';
import { planBeastModes } from '../../src/convert/beastmodes.js';
import { convertWorkbook } from '../../src/convert/index.js';

const DS = 'federated.abc';
const LEGACY = 'calculation_00000000-0000-0000-0000-000000000001';

const variable = (parameter, extra = {}) => ({ key: 'wb.param.p', name: parameter.name, legacyId: LEGACY, dataType: 'STRING', defaultExpression: "'x'", parameter, ...extra });

function ir(fields, parameters) {
	return {
		irVersion: 1,
		workbook: { name: 'Superstore', sourceFile: 'x.twb' },
		datasources: [{ id: DS, caption: 'Superstore', connections: [], tables: [{ id: 'Orders', name: 'Orders', kind: 'table', columns: [] }], relationships: [], fields, filters: [] }],
		parameters,
		worksheets: [{ name: 'S', datasourceIds: [DS], filters: [] }],
		dashboards: [],
		issues: []
	};
}

const columns = [
	{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' },
	{ id: '[Sales]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'column' }
];
const dataset = {
	key: 'wb.superstore',
	name: 'Superstore',
	strategy: 'upload',
	schema: [
		{ name: 'Region', type: 'STRING' },
		{ name: 'Sales', type: 'DOUBLE' }
	],
	datasourceId: DS,
	cardTarget: true,
	fieldMap: { '[Region]': 'Region', '[Sales]': 'Sales' }
};

test('variableReference and bindVariables swap placeholders and backticked names for template ids', () => {
	const v = variable({ name: 'Pick' }, { name: 'Pick' });
	assert.equal(variableReference(v), `DOMO_BEAST_MODE(${LEGACY})`);
	const sql = `CASE WHEN \`Region\` = \`Pick\` THEN DOMO_BEAST_MODE(${LEGACY}) END`;
	assert.deepEqual(bindVariables(sql, [v], () => 42), { text: 'CASE WHEN `Region` = DOMO_BEAST_MODE(42) THEN DOMO_BEAST_MODE(42) END', missing: [] });
	assert.equal(bindVariables(sql, [v], () => 42, { columns: ['pick'] }).text, 'CASE WHEN `Region` = `Pick` THEN DOMO_BEAST_MODE(42) END', 'a column of the same name is left alone');
	assert.deepEqual(bindVariables(sql, [v], () => undefined), { text: sql, missing: [v] });
	const json = JSON.stringify({ formula: 'IFNULL(`Pick`, 0)' });
	assert.equal(JSON.parse(bindVariables(json, [v], () => 7).text).formula, 'IFNULL(DOMO_BEAST_MODE(7), 0)');
	assert.equal(bindVariables('SUM(`Sales`)', [v], () => 1).text, 'SUM(`Sales`)');
});

test('variableExpression writes date defaults as DATE() and TIMESTAMP() so the variable is a DATE or DATETIME', () => {
	const date = variableExpression(variable({ datatype: 'date' }, { defaultExpression: "'2024-01-15'" }));
	assert.equal(date, "DATE('2024-01-15')");
	assert.ok(date.toUpperCase().startsWith('DATE(') && date.endsWith(')') && date.length === 18, 'the variable editor reads it as a specific date');
	assert.equal(variableExpression(variable({ datatype: 'date' }, { defaultExpression: "'2024-01-15 00:00:00'" })), "DATE('2024-01-15')");
	assert.equal(variableExpression(variable({ datatype: 'date' }, { defaultExpression: "'Jan 15 2024'" })), "CAST('Jan 15 2024' AS DATE)");
	assert.equal(variableExpression(variable({ datatype: 'date' }, { defaultExpression: "''" })), "''");
	assert.equal(variableExpression(variable({ datatype: 'datetime' }, { defaultExpression: "'2024-01-15T10:30:00'" })), "TIMESTAMP('2024-01-15 10:30:00')");
	assert.equal(variableExpression(variable({ datatype: 'string' }, { defaultExpression: "'2024-01-15'" })), "'2024-01-15'");
	assert.equal(variableExpression(variable({ datatype: 'integer' }, { defaultExpression: '5' })), '5');
});

test('variableControl follows the Tableau control: lists, booleans, sliders, text boxes, calendars', () => {
	const list = { name: 'L', datatype: 'string', domain: 'list', value: 'B', members: [{ value: 'A' }, { value: 'B', alias: 'Bee' }] };
	const dropdown = variableControl(variable(list), { mode: 'compact' });
	assert.equal(dropdown.control.type, 'DROPDOWN');
	assert.deepEqual(dropdown.control.values, [{ expression: { exprType: 'STRING_VALUE', value: 'A' } }, { expression: { exprType: 'STRING_VALUE', value: 'Bee' } }], 'aliases are the values');
	assert.deepEqual(dropdown.notes, []);
	// The Beast Mode editor's variable panel crashes on a control without a format.
	assert.deepEqual(dropdown.control.format, { type: 'default' });
	assert.equal(variableControl(variable(list), { mode: 'list' }).control.type, 'RADIOS');
	assert.deepEqual(variableControl(variable(list), { override: true }).control.override, { exprType: 'STRING_VALUE', value: 'Bee' });
	const clash = { ...list, members: [{ value: 'A', alias: 'Same' }, { value: 'B', alias: 'Same' }] };
	assert.deepEqual(variableControl(variable(clash)).control.values.map((v) => v.expression.value), ['A', 'B'], 'repeated aliases keep the raw values');
	assert.match(variableControl(variable(clash)).notes[0], /aliases/);

	const bool = variableControl(variable({ name: 'B', datatype: 'boolean', domain: 'list', value: false }), { override: true }).control;
	assert.deepEqual(bool.values.map((v) => v.expression.value), ['true', 'false']);
	assert.deepEqual(bool.override, { exprType: 'STRING_VALUE', value: 'false' });

	const numbers = { name: 'N', datatype: 'integer', domain: 'list', value: 2, members: [{ value: 1 }, { value: 2 }] };
	assert.deepEqual(variableControl(variable(numbers), { override: true }).control.override, { exprType: 'NUMERIC_VALUE', value: 2 });
	assert.equal(variableControl(variable(numbers)).control.values[0].expression.exprType, 'NUMERIC_VALUE');

	const range = { name: 'R', datatype: 'integer', domain: 'range', value: 20, range: { min: 0, max: 100, step: 10 } };
	assert.deepEqual(variableControl(variable(range), { mode: 'slider' }).control, { controlType: 'VARIABLE', name: 'R', type: 'SLIDER', format: { type: 'default' }, min: '0', max: '100', stepSize: '10' });
	assert.equal(variableControl(variable(range), { mode: 'type_in' }).control.type, 'INPUT');
	const open = variableControl(variable({ name: 'O', datatype: 'real', domain: 'range', value: 1, range: { min: 0 } }));
	assert.equal(open.control.type, 'INPUT');
	assert.match(open.notes[0], /range/);
	assert.equal(variableControl(variable({ name: 'T', datatype: 'string', domain: 'all', value: 'x' })).control.type, 'INPUT');

	const date = variableControl(variable({ name: 'D', datatype: 'date', domain: 'range', value: '2024-03-01', range: { min: '2024-01-01', max: '2024-12-31' } }), { override: true }).control;
	assert.deepEqual(date, {
		controlType: 'VARIABLE',
		name: 'D',
		type: 'CALENDAR_DROPDOWN',
		format: { type: 'default' },
		min: '2024-01-01',
		max: '2024-12-31',
		override: { exprType: 'FUNCTION', name: 'DATE', arguments: [{ exprType: 'STRING_VALUE', value: '2024-03-01' }] }
	});
});

test('siteVariables keys variables by name and type, keeping the workbook key as previousKey', () => {
	const [v] = siteVariables([variable({ name: 'Date Granularity' }, { name: 'Date Granularity', key: 'wb.param.date-granularity' })]);
	assert.equal(v.key, 'param.date-granularity.string');
	assert.equal(v.previousKey, 'wb.param.date-granularity');
	assert.notEqual(v.legacyId, LEGACY);
	const [w] = siteVariables([variable({ name: 'date granularity' }, { name: 'date granularity', key: 'other.param.x' })]);
	assert.equal(w.legacyId, v.legacyId, 'the same name in another workbook is the same variable');
});

test('siteVariables keeps parameters of one workbook apart when their names share a key or repeat', () => {
	const of = (name, id) => variable({ name, id }, { name, key: `wb.param.${id}` });
	const out = siteVariables([of('Upside <40%', 'a'), of('Upside 40%', 'b'), of('Start Date', 'c'), of('Start Date', 'd'), of('Sort By', 'e'), of('Sort By ', 'f')]);
	assert.equal(new Set(out.map((v) => v.key)).size, 6);
	assert.equal(new Set(out.map((v) => v.legacyId)).size, 6);
	assert.equal(out[1].key, 'param.upside-40.string', 'the first name in sort order keeps the plain key');
	assert.match(out[0].key, /^param\.upside-40-[0-9a-f]+\.string$/);
	assert.deepEqual(out.slice(2).map((v) => [v.name, v.key]), [
		['Start Date', 'param.start-date.string'],
		['Start Date (2)', 'param.start-date-2.string'],
		['Sort By', 'param.sort-by.string'],
		['Sort By (2)', 'param.sort-by-2.string']
	]);
	assert.equal(siteVariables([of('Upside <40%', 'a')])[0].key, 'param.upside-40.string');
});

test('a list parameter with aliases is a STRING variable over its labels, mapped back to the values in beast modes', () => {
	const day = {
		id: '[Parameters].[Category (copy)]',
		name: 'Day',
		datatype: 'integer',
		domain: 'list',
		value: 0,
		members: [{ value: 0, alias: 'All' }, { value: 1, alias: 'Today' }, { value: 7, alias: "Fiscal Period's 3" }, { value: 5, alias: 'This Week' }]
	};
	const fields = [...columns, { id: '[F]', name: 'F', datatype: 'integer', role: 'dimension', kind: 'calculated', formula: 'IF [Parameters].[Category (copy)] = 1 THEN 1 ELSE 0 END' }];
	const { beastModes, variables } = planBeastModes(ir(fields, [day]), [dataset], { options: { parameters: 'variables' }, workbookKey: 'wb' });
	const [v] = variables;
	assert.equal(v.dataType, 'STRING');
	assert.equal(v.key, 'param.day.long', 'the key keeps the parameter type, so a pushed variable is updated in place');
	assert.equal(v.defaultExpression, "'All'");
	const ref = variableReference(v);
	assert.ok(beastModes.find((b) => b.name === 'F').expression.includes(`(CASE ${ref} WHEN 'All' THEN 0 WHEN 'Today' THEN 1 WHEN 'Fiscal Period''s 3' THEN 7 WHEN 'This Week' THEN 5 END) = 1`));
	const { control, notes } = variableControl(v, { override: true });
	assert.deepEqual(control.values.map((x) => x.expression), ['All', 'Today', "Fiscal Period's 3", 'This Week'].map((value) => ({ exprType: 'STRING_VALUE', value })));
	assert.deepEqual(control.override, { exprType: 'STRING_VALUE', value: 'All' });
	assert.deepEqual(notes, []);
});

test('inlineParameters replaces references with the current value', () => {
	const params = [
		{ id: '[Parameters].[Parameter 1]', name: 'Pick', datatype: 'string', value: 'Say "hi"' },
		{ id: '[Parameters].[Parameter 2]', name: 'N', datatype: 'integer', value: -3 },
		{ id: '[Parameters].[Parameter 3]', name: 'D', datatype: 'date', value: '2024-01-15' }
	];
	const fields = [...columns, { id: '[C]', name: 'C', datatype: 'string', role: 'dimension', kind: 'calculated', formula: 'IF [Parameters].[Parameter 1] = [Region] THEN [Parameters].[N] + [Parameters].[Parameter 3] END' }];
	const out = inlineParameters(ir(fields, params), new Set(params.map((p) => p.id)));
	assert.equal(out.datasources[0].fields[2].formula, 'IF "Say ""hi""" = [Region] THEN (-3) + #2024-01-15# END');
	assert.equal(inlineParameters(ir(fields, params), new Set()).datasources[0].fields[2].formula, fields[2].formula);
});

test('resolveParameterModes keeps parameters inline that no calc uses or that a calc needs as a literal', () => {
	const params = [
		{ id: '[Parameters].[Parameter 1]', name: 'Pick', datatype: 'string', domain: 'list', value: 'East', members: [{ value: 'East' }] },
		{ id: '[Parameters].[Parameter 2]', name: 'Unused', datatype: 'integer', domain: 'all', value: 1 },
		{ id: '[Parameters].[Parameter 3]', name: 'Region', datatype: 'string', domain: 'all', value: 'East' },
		{ id: '[Parameters].[Parameter 4]', name: 'Part', datatype: 'string', domain: 'list', value: 'month', members: [{ value: 'month' }, { value: 'year' }] },
		{ id: '[Parameters].[Parameter 5]', name: 'B', datatype: 'string', domain: 'all', value: 'x' }
	];
	const fields = [
		...columns,
		{ id: '[Order Date]', name: 'Order Date', datatype: 'date', role: 'dimension', kind: 'column' },
		{ id: '[A]', name: 'A', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Region] = [Parameters].[Parameter 1] THEN [Sales] END' },
		{ id: '[B]', name: 'B', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '[Parameters].[Parameter 3] + [Parameters].[Parameter 5]' },
		{ id: '[L]', name: 'L', datatype: 'date', role: 'dimension', kind: 'calculated', formula: 'DATETRUNC([Parameters].[Parameter 4], [Order Date])' }
	];
	const input = ir(fields, params);
	const modes = resolveParameterModes(input, [dataset], { options: { parameters: 'variables' }, workbookKey: 'wb' });
	assert.deepEqual([...modes.inline.keys()].sort(), ['[Parameters].[Parameter 2]', '[Parameters].[Parameter 4]']);
	assert.match(modes.inline.get('[Parameters].[Parameter 2]'), /no calculation uses it/);
	assert.match(modes.inline.get('[Parameters].[Parameter 4]'), /calculation L cannot use it/);
	assert.equal(modes.issues.filter((i) => i.code === 'calc.parameter-constant').length, 2);
	assert.equal(modes.ir.datasources[0].fields.find((f) => f.id === '[L]').formula, 'DATETRUNC("month", [Order Date])');
	assert.equal(modes.ir.datasources[0].fields.find((f) => f.id === '[A]').formula, fields[3].formula);

	const inline = resolveParameterModes(input, [dataset], { options: { parameters: 'inline' }, workbookKey: 'wb' });
	assert.equal(inline.ir, input);
	assert.equal(inline.inline.size, 0);
});

test('a top N set count is a parameter use: it stays a variable, and inlining rewrites the count', () => {
	const params = [{ id: '[Parameters].[Parameter 1]', name: 'Top N', datatype: 'integer', domain: 'all', value: 10 }];
	const fields = [...columns, { id: '[Top]', name: 'Top', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Region]', top: { count: '[Parameters].[Parameter 1]', direction: 'top', by: 'SUM([Sales])' } } }];
	const modes = resolveParameterModes(ir(fields, params), [dataset], { options: { parameters: 'variables' }, workbookKey: 'wb' });
	assert.equal(modes.inline.size, 0);
	assert.equal(inlineParameters(ir(fields, params), new Set([params[0].id])).datasources[0].fields.at(-1).set.top.count, '10');
});

test('a parameter named like a calculated field stays a variable under a distinct name', () => {
	const params = [
		{ id: '[Parameters].[Parameter 1]', name: 'B', datatype: 'string', domain: 'all', value: 'x' },
		{ id: '[Parameters].[Parameter 2]', name: 'Measure', datatype: 'string', domain: 'all', value: 'y' },
		{ id: '[Parameters].[Parameter 3]', name: 'Measure', datatype: 'string', domain: 'all', value: 'z' }
	];
	const fields = [
		...columns,
		{ id: '[B]', name: 'B', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '[Region] + [Parameters].[Parameter 1]' },
		{ id: '[BP]', name: 'B (Parameter)', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '[Region] + "!"' },
		{ id: '[M]', name: 'Measure', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '[Parameters].[Parameter 2] + [Parameters].[Parameter 3] + [Region]' }
	];
	const input = ir(fields, params);
	assert.deepEqual([...parameterVariableNames(input).values()], ['B (Parameter 2)', 'Measure (Parameter)', 'Measure (Parameter 2)']);
	const modes = resolveParameterModes(input, [dataset], { options: { parameters: 'variables' }, workbookKey: 'wb' });
	assert.equal(modes.inline.size, 0);
	const { variables, beastModes } = planBeastModes(modes.ir, [dataset], { options: { parameters: 'variables' }, workbookKey: 'wb' });
	assert.deepEqual(variables.map((v) => v.name), ['B (Parameter 2)', 'Measure (Parameter)', 'Measure (Parameter 2)']);
	assert.ok(beastModes.some((bm) => bm.name === 'B' && bm.expression.includes(variables[0].legacyId)));
});

test('a parameter used only in a LOOKUP offset that picks between integers stays a variable', () => {
	const params = [{ id: '[Parameters].[Parameter 1]', name: 'Grain', datatype: 'string', domain: 'list', value: 'Quarter', members: [{ value: 'Quarter' }, { value: 'Period' }] }];
	const fields = [
		...columns,
		{ id: '[Y]', name: 'Yoy', datatype: 'real', role: 'measure', kind: 'calculated', formula: "LOOKUP(SUM([Sales]), IF [Parameters].[Parameter 1] = 'Quarter' THEN -4 ELSE -1 END)" }
	];
	const modes = resolveParameterModes(ir(fields, params), [dataset], { options: { parameters: 'variables', useWindowFunctions: true }, workbookKey: 'wb' });
	assert.equal(modes.inline.size, 0);
});

test('convertWorkbook in variables mode plans site variables and places their controls', () => {
	const params = [{ id: '[Parameters].[Parameter 1]', name: 'Pick', datatype: 'string', domain: 'list', value: 'East', members: [{ value: 'East' }, { value: 'West' }] }];
	const fields = [...columns, { id: '[A]', name: 'A', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Region] = [Parameters].[Parameter 1] THEN [Sales] END' }];
	const input = ir(fields, params);
	input.dashboards = [
		{
			name: 'D',
			size: { mode: 'fixed', width: 1200, height: 800 },
			zones: [{ id: '1', kind: 'paramctrl', rect: { x: 0.9, y: 0, w: 0.05, h: 0.05 }, floating: false, param: '[Parameters].[Parameter 1]', mode: 'compact' }],
			floating: []
		}
	];
	const manifests = [{ datasourceId: DS, strategy: 'none', tables: [] }];
	const plan = convertWorkbook(input, { manifests, options: { parameters: 'variables', target: 'pages' } });
	assert.deepEqual(plan.variables.map((v) => v.key), ['param.pick.string']);
	const item = plan.pages[1].layout.content.find((x) => x.type === 'VARIABLE');
	assert.deepEqual(item.variableControlId, { $ref: 'variable:param.pick.string' });
	assert.equal(item.control.type, 'DROPDOWN');
	assert.equal(item.control.override.value, 'East');
	const box = plan.pages[1].layout.standard.template.find((t) => t.contentKey === item.contentKey);
	assert.ok(box.width >= 10 && box.x + box.width <= 60);
	assert.ok(!plan.issues.some((i) => i.code === 'layout.parameter-control'));

	const inlinePlan = convertWorkbook(input, { manifests, options: { parameters: 'inline' } });
	assert.equal(inlinePlan.variables.length, 0);
	assert.match(inlinePlan.issues.find((i) => i.code === 'layout.parameter-control').message, /inlined as constants/);
});

test('an app variable control shows the parameter caption and takes its Tableau container background, as filter cards do', () => {
	const params = [{ id: '[Parameters].[Parameter 1]', name: 'Granularity', datatype: 'string', domain: 'list', value: 'Fiscal Quarter', members: [{ value: 'Fiscal Quarter' }, { value: 'Fiscal Period' }] }];
	const fields = [...columns, { id: '[A]', name: 'A', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Region] = [Parameters].[Parameter 1] THEN [Sales] END' }];
	const input = ir(fields, params);
	input.dashboards = [
		{
			name: 'D',
			size: { mode: 'fixed', width: 1200, height: 800 },
			zones: [{ id: '1', kind: 'paramctrl', parent: '9', rect: { x: 0, y: 0, w: 0.2, h: 0.05 }, floating: false, param: '[Parameters].[Parameter 1]', mode: 'compact' }],
			floating: [],
			containers: [{ id: '9', layout: 'flow', direction: 'vertical', rect: { x: 0, y: 0, w: 0.2, h: 0.1 }, floating: false, children: ['1'], style: { background: '#efe9e7' } }]
		}
	];
	const manifests = [{ datasourceId: DS, strategy: 'none', tables: [] }];
	const plan = convertWorkbook(input, { manifests, options: { parameters: 'variables', target: 'app' } });
	const item = plan.pages[0].layout.content.find((x) => x.type === 'VARIABLE');
	assert.equal(item.control.name, 'Granularity');
	assert.equal(plan.app.theme.overrides.control.background, '#EFE9E7', 'its style, the only control style, is the theme\'s control style');
	assert.equal(item.itemStyle, undefined);
});
