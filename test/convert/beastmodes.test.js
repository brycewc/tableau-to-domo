import test from 'node:test';
import assert from 'node:assert/strict';
import { planBeastModes, sqlLiteral, variableDefault } from '../../src/convert/beastmodes.js';
import { beastModeLegacyId } from '../../src/util/ids.js';
import { textCaseSensitive } from '../../src/convert/member-case.js';

const DS = 'federated.abc';

function ir(fields, { parameters = [], worksheets } = {}) {
	return {
		irVersion: 1,
		workbook: { name: 'Superstore', sourceFile: 'x.twb' },
		datasources: [{ id: DS, caption: 'Superstore', connections: [], tables: [{ id: 'Orders', name: 'Orders', kind: 'table', columns: [] }], relationships: [], fields, filters: [] }],
		parameters,
		worksheets: worksheets ?? [{ name: 'S', datasourceIds: [DS], filters: [] }],
		dashboards: [],
		issues: []
	};
}

const columns = [
	{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' },
	{ id: '[Sales]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'column' },
	{ id: '[Quantity]', name: 'Quantity', datatype: 'integer', role: 'measure', kind: 'column' },
	{ id: '[Customer]', name: 'Customer', datatype: 'string', role: 'dimension', kind: 'column' }
];

const dataset = {
	key: 'wb.superstore',
	name: 'Superstore',
	strategy: 'upload',
	schema: [
		{ name: 'Region', type: 'STRING' },
		{ name: 'Sales', type: 'DOUBLE' },
		{ name: 'Quantity', type: 'LONG' },
		{ name: 'Customer', type: 'STRING' }
	],
	datasourceId: DS,
	cardTarget: true,
	fieldMap: { '[Region]': 'Region', '[Sales]': 'Sales', '[Quantity]': 'Quantity', '[Customer]': 'Customer' }
};

const bm = (result, id) => result.beastModes.find((b) => b.tableauFieldId === id);

test('groups, bins, sets and counts', () => {
	const fields = [
		...columns,
		{
			id: '[Region (group)]',
			name: 'Region (group)',
			datatype: 'string',
			role: 'dimension',
			kind: 'group',
			group: { source: '[Region]', bins: [{ label: 'East+West', values: ['"East"', 'West'] }, { label: "O'Hare", values: ['Central'] }] }
		},
		{
			id: '[Region (group 2)]',
			name: 'Grouped',
			datatype: 'string',
			role: 'dimension',
			kind: 'group',
			group: { source: '[Region]', bins: [{ label: 'Coasts', values: ['East', null] }], otherLabel: 'Other' }
		},
		{ id: '[Sales (bin)]', name: 'Sales (bin)', datatype: 'integer', role: 'dimension', kind: 'bin', bin: { source: '[Sales]', size: 100 } },
		{ id: '[Qty (bin)]', name: 'Qty (bin)', datatype: 'integer', role: 'dimension', kind: 'bin', bin: { source: '[Quantity]', size: '[Parameters].[Bin Size]' } },
		{ id: '[Top Customers]', name: 'Top Customers', datatype: 'string', role: 'dimension', kind: 'set', set: { source: '[Customer]', members: ['Ann', 'Bob'] } },
		{ id: '[Not Them]', name: 'Not Them', datatype: 'string', role: 'dimension', kind: 'set', set: { source: '[Customer]', members: ['Ann'], exclude: true } },
		{ id: '[Top 10]', name: 'Top 10', datatype: 'string', role: 'dimension', kind: 'set', set: { source: '[Customer]', top: { count: 10, direction: 'top', by: 'SUM([Sales])' } } },
		{ id: '[__tableau_internal_object_id__].[Orders_X]', name: 'Orders (Count)', datatype: 'table', role: 'measure', kind: 'count' }
	];
	const parameters = [{ id: '[Parameters].[Parameter 1]', name: 'Bin Size', datatype: 'integer', domain: 'range', value: 5 }];
	const result = planBeastModes(ir(fields, { parameters }), [dataset], { workbookKey: 'wb' });

	assert.equal(bm(result, '[Region (group)]').expression, "CASE WHEN `Region` IN ('East', 'West') THEN 'East+West' WHEN `Region` IN ('Central') THEN 'O''Hare' ELSE `Region` END");
	assert.equal(bm(result, '[Region (group 2)]').expression, "CASE WHEN (`Region` IN ('East') OR `Region` IS NULL) THEN 'Coasts' ELSE 'Other' END");
	assert.equal(bm(result, '[Sales (bin)]').expression, 'FLOOR(`Sales` / 100) * 100');
	assert.equal(bm(result, '[Qty (bin)]').expression, 'FLOOR(`Quantity` / 5) * 5');
	assert.equal(bm(result, '[Qty (bin)]').dataType, 'LONG');
	assert.equal(bm(result, '[Top Customers]').expression, "CASE WHEN `Customer` IN ('Ann', 'Bob') THEN 'In' ELSE 'Out' END");
	assert.equal(bm(result, '[Not Them]').expression, "CASE WHEN `Customer` IN ('Ann') THEN 'Out' ELSE 'In' END");
	assert.equal(bm(result, '[Top 10]').status, 'unsupported');
	const count = bm(result, '[__tableau_internal_object_id__].[Orders_X]');
	assert.equal(count.expression, 'COUNT(1)');
	assert.equal(count.aggregated, true);
	assert.equal(count.legacyId, beastModeLegacyId('wb', 'wb.superstore', '[__tableau_internal_object_id__].[Orders_X]'));

	const binding = result.bindings.get(DS, '[__tableau_internal_object_id__].[Orders_X]');
	assert.equal(binding.kind, 'formula');
	assert.equal(binding.formulaId, count.legacyId);
	assert.equal(binding.aggregated, true);
	assert.equal(result.bindings.get(DS, '[Top 10]').kind, 'unsupported');
	assert.ok(result.issues.some((i) => i.code === 'calc.set-top'));
});

test('a set referenced by another calc is inlined as its membership test', () => {
	const fields = [
		...columns,
		{ id: '[Top Customers]', name: 'Top Customers', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', members: ['Ann', 'Bob'] } },
		{ id: '[Not Them]', name: 'Not Them', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', members: ['Ann'], exclude: true } },
		{ id: '[Calc]', name: 'Calc', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Top Customers] THEN [Sales] END' },
		{ id: '[Calc 2]', name: 'Calc 2', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF NOT [Not Them] THEN [Sales] END' },
		{ id: '[Other]', name: 'Other', datatype: 'string', role: 'dimension', kind: 'calculated', formula: 'IF NOT [Top Customers] THEN "Other" END' },
		{ id: '[Flag]', name: 'Flag', datatype: 'boolean', role: 'dimension', kind: 'calculated', formula: '[Not Them]' },
		{ id: '[Ranged]', name: 'Ranged', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', members: ['Ann'], ranges: [{ from: 'C', to: 'E' }] } }
	];
	const inline = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.equal(bm(inline, '[Calc]').expression, "CASE WHEN (`Customer` IS NOT NULL AND (`Customer` IN ('Ann', 'Bob'))) THEN `Sales` END");
	assert.equal(bm(inline, '[Calc 2]').expression, "CASE WHEN (`Customer` IS NOT NULL AND (`Customer` IN ('Ann'))) THEN `Sales` END");
	assert.equal(bm(inline, '[Top Customers]').expression, "CASE WHEN `Customer` IN ('Ann', 'Bob') THEN 'In' ELSE 'Out' END");
	// A null value is Out of a set (In of an exclude set), never null.
	assert.equal(bm(inline, '[Other]').expression, "CASE WHEN NOT (`Customer` IS NOT NULL AND (`Customer` IN ('Ann', 'Bob'))) THEN 'Other' END");
	assert.equal(bm(inline, '[Flag]').expression, "CASE WHEN (NOT (`Customer` IS NOT NULL AND (`Customer` IN ('Ann')))) THEN 'true' ELSE 'false' END");
	assert.equal(bm(inline, '[Ranged]').expression, "CASE WHEN `Customer` IS NOT NULL AND (`Customer` IN ('Ann') OR (LOWER(`Customer`) >= 'c' AND LOWER(`Customer`) <= 'e')) THEN 'In' ELSE 'Out' END");
});

test('a set range on a binary-collation column compares case-sensitively, and its binding says so', () => {
	const fields = [
		...columns.map((f) => (f.id === '[Customer]' ? { ...f, collation: 'binary' } : f)),
		{ id: '[Ranged]', name: 'Ranged', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', ranges: [{ from: 'C', to: 'E' }] } }
	];
	const result = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.equal(bm(result, '[Ranged]').expression, "CASE WHEN `Customer` IS NOT NULL AND ((`Customer` >= 'C' AND `Customer` <= 'E')) THEN 'In' ELSE 'Out' END");
	assert.equal(result.bindings.get(DS, '[Customer]').caseSensitive, true);
	assert.equal(planBeastModes(ir(columns), [dataset], { workbookKey: 'wb' }).bindings.get(DS, '[Customer]').caseSensitive, undefined);
});

test('textCaseSensitive: binary collation, else the datasource text columns share binary', () => {
	const ds = { fields: [{ id: '[A]', kind: 'column', datatype: 'string', collation: 'binary' }, { id: '[N]', kind: 'column', datatype: 'integer' }] };
	assert.equal(textCaseSensitive({ datatype: 'string', collation: 'binary' }), true);
	assert.equal(textCaseSensitive({ datatype: 'string', collation: 'LEN_RUS_S2' }, ds), false);
	assert.equal(textCaseSensitive({ datatype: 'string', kind: 'calculated' }, ds), true);
	assert.equal(textCaseSensitive({ datatype: 'string', kind: 'calculated' }, { fields: [...ds.fields, { id: '[B]', kind: 'column', datatype: 'string', collation: 'LROOT' }] }), false);
	assert.equal(textCaseSensitive({ datatype: 'string' }), false);
	assert.equal(textCaseSensitive({ datatype: 'integer', collation: 'binary' }), false);
});

test('a set over all members (Use all) is In for every row, as a beast mode and inside another calc; its binding is marked a set', () => {
	const fields = [
		...columns,
		{ id: '[Channel Set]', name: 'Channel Set', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', all: true } },
		{ id: '[Calc]', name: 'Calc', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Channel Set] THEN [Sales] END' }
	];
	const result = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.equal(bm(result, '[Channel Set]').expression, "'In'");
	// IF <always In> THEN [Sales] END is just Sales: the calc binds to the column.
	assert.equal(bm(result, '[Calc]'), undefined);
	assert.deepEqual([result.bindings.get(DS, '[Calc]').kind, result.bindings.get(DS, '[Calc]').column], ['column', 'Sales']);
	assert.equal(result.bindings.get(DS, '[Channel Set]').setMembers, true);
	const older = [...columns, { id: '[Old]', name: 'Old', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]' } }, { id: '[None]', name: 'None', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '[Customer]', members: [] } }];
	const parsedBefore = planBeastModes(ir(older), [dataset], { workbookKey: 'wb' });
	assert.deepEqual([bm(parsedBefore, '[Old]').expression, bm(parsedBefore, '[None]').expression], ["'In'", "'Out'"], 'an IR parsed before set.all: no member list is all members, an empty one none');
});

test('a set combining other sets, or with no source, is unsupported and never inlines as every row In', () => {
	const fields = [
		...columns,
		{ id: '[Set 1]', name: 'AllDays', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '', unparsed: ['reference'] } },
		{ id: '[Legacy]', name: 'Legacy', datatype: 'boolean', role: 'dimension', kind: 'set', set: { source: '' } },
		{ id: '[Calc]', name: 'Calc', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Set 1] THEN [Sales] END' },
		{ id: '[Calc 2]', name: 'Calc 2', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Legacy] THEN [Sales] END' }
	];
	const result = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.deepEqual([bm(result, '[Set 1]').status, bm(result, '[Legacy]').status], ['unsupported', 'unsupported']);
	assert.ok(result.issues.some((i) => i.code === 'calc.set-combined' && i.object.id === '[Set 1]'));
	for (const id of ['[Calc]', '[Calc 2]']) assert.equal(bm(result, id).status, 'unsupported', id);
});

test('boolean columns: numeric types compare with 1, and text from a dataset t2d did not upload accepts t/1/yes/y', () => {
	const fields = [
		...columns,
		{ id: '[Flag]', name: 'Flag', datatype: 'boolean', role: 'dimension', kind: 'column' },
		{ id: '[Num Flag]', name: 'Num Flag', datatype: 'boolean', role: 'dimension', kind: 'column' },
		{ id: '[Calc]', name: 'Calc', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Flag] THEN [Sales] END' },
		{ id: '[Calc 2]', name: 'Calc 2', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'IF [Num Flag] THEN [Sales] END' }
	];
	const schema = [...dataset.schema, { name: 'Flag', type: 'STRING' }, { name: 'Num Flag', type: 'DOUBLE' }];
	const fieldMap = { ...dataset.fieldMap, '[Flag]': 'Flag', '[Num Flag]': 'Num Flag' };
	const uploaded = planBeastModes(ir(fields), [{ ...dataset, schema, fieldMap }], { workbookKey: 'wb' });
	assert.equal(bm(uploaded, '[Calc]').expression, "CASE WHEN LOWER(`Flag`) = 'true' THEN `Sales` END");
	assert.equal(bm(uploaded, '[Calc 2]').expression, 'CASE WHEN `Num Flag` = 1 THEN `Sales` END');
	const connector = planBeastModes(ir(fields), [{ ...dataset, strategy: 'connector', schema, fieldMap }], { workbookKey: 'wb' });
	assert.equal(bm(connector, '[Calc]').expression, "CASE WHEN LOWER(`Flag`) IN ('true', 't', '1', 'yes', 'y') THEN `Sales` END");
	assert.equal(bm(connector, '[Calc 2]').expression, 'CASE WHEN `Num Flag` = 1 THEN `Sales` END');
});

test('calculated fields go through the calc translator with resolved columns', () => {
	const fields = [
		...columns,
		{ id: '[Calculation_1]', name: 'Profit Ratio', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales]) / SUM([Quantity])' },
		{ id: '[Calculation_2]', name: 'Double Ratio', datatype: 'real', role: 'measure', kind: 'calculated', formula: '[Calculation_1] * 2' },
		{ id: '[Calculation_3]', name: 'Big', datatype: 'string', role: 'dimension', kind: 'calculated', formula: 'IF [Sales] > [Parameters].[Parameter 1] THEN "Y" ELSE "N" END' }
	];
	const parameters = [{ id: '[Parameters].[Parameter 1]', name: 'Threshold', datatype: 'integer', domain: 'all', value: 100 }];
	const result = planBeastModes(ir(fields, { parameters }), [dataset], { workbookKey: 'wb' });
	const ratio = bm(result, '[Calculation_1]');
	assert.match(ratio.expression, /SUM\(`Sales`\)/);
	assert.equal(ratio.aggregated, true);
	assert.notEqual(ratio.status, 'unsupported');
	assert.match(bm(result, '[Calculation_2]').expression, /SUM\(`Sales`\)/);
	assert.match(bm(result, '[Calculation_3]').expression, /100/);
	const binding = result.bindings.get(DS, '[Calculation_1]');
	assert.equal(binding.kind, 'formula');
	assert.equal(binding.formulaId, ratio.legacyId);
	assert.equal(binding.expression, ratio.expression);
});

test('translator is injectable and receives context filters and resolveField', () => {
	const fields = [...columns, { id: '[C]', name: 'C', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'X' }];
	const worksheets = [{ name: 'S', datasourceIds: [DS], filters: [{ datasourceId: DS, fieldId: '[Region]', kind: 'categorical', context: true }] }];
	let seen;
	const translate = (formula, ctx) => {
		seen = ctx;
		return { expression: 'SUM(`Sales`)', aggregated: true, dataType: 'DOUBLE', status: 'approximate', features: ['fixed'], issues: [] };
	};
	const result = planBeastModes(ir(fields, { worksheets }), [dataset], { workbookKey: 'wb', translate });
	assert.deepEqual(seen.contextFilterColumns, ['Region']);
	assert.deepEqual(seen.resolveField('[Sales]'), { kind: 'column', column: 'Sales', datatype: 'real', domoType: 'DOUBLE' });
	assert.deepEqual(seen.resolveField(`[${DS}].[Region]`).column, 'Region');
	assert.equal(seen.resolveField('[Nope]'), undefined);
	assert.equal(bm(result, '[C]').status, 'approximate');
	assert.deepEqual(bm(result, '[C]').features, ['fixed']);
});

test('groups referenced from calcs are inlined as formulas', () => {
	const fields = [
		...columns,
		{ id: '[G]', name: 'G', datatype: 'string', role: 'dimension', kind: 'group', group: { source: '[Region]', bins: [{ label: 'EW', values: ['East', 'West'] }] } },
		{ id: '[C]', name: 'C', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '[G]' }
	];
	let resolved;
	const translate = (formula, ctx) => {
		resolved = ctx.resolveField('[G]');
		return { expression: 'x', aggregated: false, dataType: 'STRING', status: 'ok', features: [], issues: [] };
	};
	planBeastModes(ir(fields), [dataset], { workbookKey: 'wb', translate });
	assert.equal(resolved.kind, 'calc');
	assert.equal(resolved.field.formula, 'IF [Region] IN ("East", "West") THEN "EW" ELSE [Region] END');
});

test('SUM([Number of Records]) in a calc counts rows instead of nesting COUNT inside SUM', () => {
	const fields = [
		...columns,
		{ id: '[Number of Records]', name: 'Number of Records', datatype: 'integer', role: 'measure', kind: 'count' },
		{ id: '[Avg]', name: 'Avg', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales]) / SUM([Number of Records])' }
	];
	const result = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.equal(bm(result, '[Number of Records]').expression, 'COUNT(1)');
	const avg = bm(result, '[Avg]');
	assert.doesNotMatch(avg.expression, /SUM\(COUNT/);
	assert.match(avg.expression, /SUM\(1\)/);
});

test('beast mode names colliding with columns get a suffix', () => {
	const fields = [
		...columns,
		{ id: '[Calculation_9]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales])' },
		{ id: '[Calculation_10]', name: 'sales (calc)', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales])' }
	];
	const result = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.equal(bm(result, '[Calculation_9]').name, 'Sales (calc)');
	assert.equal(bm(result, '[Calculation_10]').name, 'sales (calc) (calc)');
	assert.equal(result.bindings.get(DS, '[Calculation_9]').name, 'Sales');
});

test('column bindings and datasets without targets', () => {
	const result = planBeastModes(ir(columns), [{ ...dataset, fieldMap: { '[Region]': 'Region' } }], { workbookKey: 'wb' });
	assert.deepEqual(result.bindings.get(DS, '[Region]'), {
		datasetKey: 'wb.superstore',
		kind: 'column',
		name: 'Region',
		column: 'Region',
		aggregated: false,
		dataType: 'STRING',
		tableauType: 'string'
	});
	assert.equal(result.bindings.get(DS, `[${DS}].[Region]`).column, 'Region');
	assert.equal(result.bindings.get(DS, '[Sales]').kind, 'unsupported');
	assert.equal(result.bindings.datasetKeyFor(DS), 'wb.superstore');
	assert.equal(result.bindings.get('other', '[Region]'), undefined);

	const none = planBeastModes(ir(columns), [], { workbookKey: 'wb' });
	assert.equal(none.bindings.datasetKeyFor(DS), undefined);
	assert.equal(none.bindings.get(DS, '[Region]').kind, 'unsupported');
});

test('variables mode plans a variable per parameter', () => {
	const parameters = [
		{ id: '[Parameters].[Parameter 1]', name: 'Top N', datatype: 'integer', domain: 'range', value: 10 },
		{ id: '[Parameters].[Parameter 2]', name: 'Region Param', datatype: 'string', domain: 'list', value: "O'Hare" }
	];
	const fields = [...columns, { id: '[C]', name: 'C', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'X' }];
	let ref;
	const translate = (formula, ctx) => {
		ref = ctx.parameterReference(parameters[1]);
		return { expression: 'x', aggregated: false, dataType: 'STRING', status: 'ok', features: [], issues: [] };
	};
	const result = planBeastModes(ir(fields, { parameters }), [dataset], { workbookKey: 'wb', options: { parameters: 'variables' }, translate });
	assert.equal(result.variables.length, 2);
	assert.equal(result.variables[0].legacyId, beastModeLegacyId('site', 'variable', 'top n', 'long'));
	assert.deepEqual([result.variables[0].key, result.variables[0].previousKey], ['param.top-n.long', 'wb.param.top-n']);
	assert.equal(result.variables[0].dataType, 'LONG');
	assert.equal(result.variables[0].defaultExpression, '10');
	assert.equal(result.variables[1].defaultExpression, "'O''Hare'");
	assert.equal(ref, `DOMO_BEAST_MODE(${result.variables[1].legacyId})`);
	assert.equal(planBeastModes(ir(fields, { parameters }), [dataset], { workbookKey: 'wb', translate }).variables.length, 0);
});

test('literals', () => {
	assert.equal(sqlLiteral('"East"', 'string'), "'East'");
	assert.equal(sqlLiteral('5', 'integer'), '5');
	assert.equal(sqlLiteral('5', 'string'), "'5'");
	assert.equal(sqlLiteral('%null%', 'string'), 'NULLIF(1, 1)');
	assert.equal(sqlLiteral('#2020-01-02#', 'date'), "'2020-01-02'");
	assert.equal(sqlLiteral('a\\b', 'string'), "'a\\\\b'");
	assert.equal(variableDefault({ datatype: 'boolean', value: true }), "'true'");
});

test('datasource filters are allowed inside FIXED alongside context filters', () => {
	const fields = [...columns, { id: '[C]', name: 'C', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'X' }];
	const worksheets = [{ name: 'S', datasourceIds: [DS], filters: [{ datasourceId: DS, fieldId: '[Region]', kind: 'categorical', context: true }] }];
	const model = ir(fields, { worksheets });
	model.datasources[0].filters = [{ datasourceId: DS, fieldId: '[Quantity]', kind: 'quantitative' }];
	let seen;
	const translate = (formula, ctx) => {
		seen = ctx;
		return { expression: 'SUM(`Sales`)', aggregated: true, dataType: 'DOUBLE', status: 'ok', features: [], issues: [] };
	};
	planBeastModes(model, [dataset], { workbookKey: 'wb', translate });
	assert.deepEqual(seen.contextFilterColumns, ['Quantity', 'Region']);
});

test('FIXED beast modes flag context filters that differ between worksheets', () => {
	const fields = [...columns, { id: '[L]', name: 'L', datatype: 'real', role: 'measure', kind: 'calculated', formula: '{FIXED [Region] : SUM([Sales])}' }];
	const worksheets = [
		{ name: 'A', datasourceIds: [DS], filters: [{ datasourceId: DS, fieldId: '[Region]', kind: 'categorical', context: true }] },
		{ name: 'B', datasourceIds: [DS], filters: [] }
	];
	const result = planBeastModes(ir(fields, { worksheets }), [dataset], { workbookKey: 'wb' });
	assert.ok(result.issues.some((i) => i.code === 'calc.context-filter-scope'));
	const same = planBeastModes(ir(fields), [dataset], { workbookKey: 'wb' });
	assert.ok(!same.issues.some((i) => i.code === 'calc.context-filter-scope'));
});

test('bare LOD measures keep a SUM default and expose the bare LOD on the binding', () => {
	const fields = [...columns, { id: '[L]', name: 'Region Sales', datatype: 'real', role: 'measure', kind: 'calculated', formula: '{FIXED [Region] : SUM([Sales])}' }];
	const result = planBeastModes(ir(fields), [dataset], { workbookKey: 'superstore' });
	const binding = result.bindings.get(DS, '[L]');
	assert.match(bm(result, '[L]').expression, /^SUM\(.*FIXED/);
	assert.ok(binding.lodExpression);
	assert.equal(binding.expression, `SUM(${binding.lodExpression})`);
	const issue = result.issues.find((i) => i.code === 'calc.lod-outer-aggregation');
	assert.equal(issue?.severity, 'info');
});

test('table calc beast modes take their window partition and order from the worksheet pills', () => {
	const calc = { id: '[Running]', name: 'Running', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'RUNNING_SUM(SUM([Sales]))' };
	const pill = (id, fieldId, extra = {}) => ({ id, datasourceId: DS, fieldId, derivation: 'None', aggregated: false, continuous: false, datePart: null, dateTrunc: null, ...extra });
	const sheetFor = (name, orderingType) => ({
		name,
		datasourceIds: [DS],
		filters: [],
		sorts: [],
		rowPills: [`[${DS}].[none:Region:nk]`],
		colPills: [`[${DS}].[none:Customer:nk]`, `[${DS}].[usr:Running:qk]`],
		panes: [],
		pills: {
			[`[${DS}].[none:Region:nk]`]: pill(`[${DS}].[none:Region:nk]`, '[Region]'),
			[`[${DS}].[none:Customer:nk]`]: pill(`[${DS}].[none:Customer:nk]`, '[Customer]'),
			[`[${DS}].[usr:Running:qk]`]: pill(`[${DS}].[usr:Running:qk]`, '[Running]', { derivation: 'User', aggregated: true, tableCalc: { type: 'Calculation', orderingType } })
		}
	});
	const opts = { options: { useWindowFunctions: true }, workbookKey: 'wb' };
	const one = planBeastModes(ir([...columns, calc], { worksheets: [sheetFor('A', 'Columns')] }), [dataset], opts);
	assert.equal(bm(one, '[Running]').expression, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Customer` ORDER BY `Region` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
	assert.ok(!one.issues.some((i) => i.code === 'calc.table-calc-addressing'));

	const two = planBeastModes(ir([...columns, calc], { worksheets: [sheetFor('A', 'Columns'), sheetFor('B', 'Rows')] }), [dataset], opts);
	assert.ok(two.issues.some((i) => i.code === 'calc.table-calc-addressing' && /Worksheets B compute it differently from 'A'/.test(i.message)));
});

test('a calc that reaches a table calc only through a reference takes its window addressing from its own pill', () => {
	const calcs = [
		{ id: '[Running]', name: 'Running', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'RUNNING_SUM(SUM([Sales]))' },
		{ id: '[Double]', name: 'Double', datatype: 'real', role: 'measure', kind: 'calculated', formula: '[Running] * 2' }
	];
	const pill = (id, fieldId, extra = {}) => ({ id, datasourceId: DS, fieldId, derivation: 'None', aggregated: false, continuous: false, datePart: null, dateTrunc: null, ...extra });
	const sheet = {
		name: 'A',
		datasourceIds: [DS],
		filters: [],
		sorts: [],
		rowPills: [`[${DS}].[none:Region:nk]`],
		colPills: [`[${DS}].[none:Customer:nk]`, `[${DS}].[usr:Double:qk]`],
		panes: [],
		pills: {
			[`[${DS}].[none:Region:nk]`]: pill(`[${DS}].[none:Region:nk]`, '[Region]'),
			[`[${DS}].[none:Customer:nk]`]: pill(`[${DS}].[none:Customer:nk]`, '[Customer]'),
			[`[${DS}].[usr:Double:qk]`]: pill(`[${DS}].[usr:Double:qk]`, '[Double]', { derivation: 'User', aggregated: true, tableCalc: { type: 'Calculation', orderingType: 'Columns' } })
		}
	};
	const result = planBeastModes(ir([...columns, ...calcs], { worksheets: [sheet] }), [dataset], { options: { useWindowFunctions: true }, workbookKey: 'wb' });
	assert.equal(bm(result, '[Double]').status, 'ok');
	assert.equal(bm(result, '[Double]').expression, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Customer` ORDER BY `Region` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) * 2');
	assert.ok(!result.issues.some((i) => i.object?.id === '[Double]' && i.code.startsWith('calc.table-calc')));
});

test('a table calc shown only through a referencing calc takes the nested compute-using of that pill', () => {
	const calcs = [
		{ id: '[Running]', name: 'Running', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'RUNNING_SUM(SUM([Sales]))' },
		{ id: '[Double]', name: 'Double', datatype: 'real', role: 'measure', kind: 'calculated', formula: '[Running] * 2' }
	];
	const pill = (id, fieldId, extra = {}) => ({ id, datasourceId: DS, fieldId, derivation: 'None', aggregated: false, continuous: false, datePart: null, dateTrunc: null, ...extra });
	const tableCalc = { type: 'Calculation', orderingType: 'Columns', nested: { '[Running]': { type: 'Calculation', orderingType: 'Rows' } } };
	const sheet = {
		name: 'A',
		datasourceIds: [DS],
		filters: [],
		sorts: [],
		rowPills: [`[${DS}].[none:Region:nk]`],
		colPills: [`[${DS}].[none:Customer:nk]`, `[${DS}].[usr:Double:qk]`],
		panes: [],
		pills: {
			[`[${DS}].[none:Region:nk]`]: pill(`[${DS}].[none:Region:nk]`, '[Region]'),
			[`[${DS}].[none:Customer:nk]`]: pill(`[${DS}].[none:Customer:nk]`, '[Customer]'),
			[`[${DS}].[usr:Double:qk]`]: pill(`[${DS}].[usr:Double:qk]`, '[Double]', { derivation: 'User', aggregated: true, tableCalc })
		}
	};
	const result = planBeastModes(ir([...columns, ...calcs], { worksheets: [sheet] }), [dataset], { options: { useWindowFunctions: true }, workbookKey: 'wb' });
	assert.equal(bm(result, '[Running]').status, 'ok');
	assert.equal(bm(result, '[Running]').expression, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Region` ORDER BY `Customer` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
	assert.ok(!result.issues.some((i) => i.object?.id === '[Running]' && i.code.startsWith('calc.table-calc')));
});

test('a table calc pill without a compute-using setting uses Table (across) without a warning', () => {
	const calc = { id: '[Prev]', name: 'Prev', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'LOOKUP(SUM([Sales]), -1)' };
	const pill = (id, fieldId, extra = {}) => ({ id, datasourceId: DS, fieldId, derivation: 'None', aggregated: false, continuous: false, datePart: null, dateTrunc: null, ...extra });
	const sheet = {
		name: 'A',
		datasourceIds: [DS],
		filters: [],
		sorts: [],
		rowPills: [`[${DS}].[none:Region:nk]`],
		colPills: [`[${DS}].[none:Customer:nk]`],
		panes: [{ markClass: 'Text', encodings: { text: [`[${DS}].[usr:Prev:qk]`] } }],
		pills: {
			[`[${DS}].[none:Region:nk]`]: pill(`[${DS}].[none:Region:nk]`, '[Region]'),
			[`[${DS}].[none:Customer:nk]`]: pill(`[${DS}].[none:Customer:nk]`, '[Customer]'),
			[`[${DS}].[usr:Prev:qk]`]: pill(`[${DS}].[usr:Prev:qk]`, '[Prev]', { derivation: 'User', aggregated: true })
		}
	};
	const result = planBeastModes(ir([...columns, calc], { worksheets: [sheet] }), [dataset], { options: { useWindowFunctions: true }, workbookKey: 'wb' });
	assert.equal(bm(result, '[Prev]').expression, 'LAG(SUM(`Sales`), 1) OVER (PARTITION BY `Region` ORDER BY `Customer` ASC)');
	assert.ok(!result.issues.some((i) => i.code.startsWith('calc.table-calc')));
});

test('a table calc no worksheet uses is noted, and a missing window order is a warning', () => {
	const calcs = [
		{ id: '[Moving]', name: 'Moving', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'WINDOW_SUM(SUM([Sales]), -2, 0)' },
		{ id: '[Twice]', name: 'Twice', datatype: 'real', role: 'measure', kind: 'calculated', formula: '[Moving] * 2' }
	];
	const result = planBeastModes(ir([...columns, ...calcs], { worksheets: [] }), [dataset], { options: { useWindowFunctions: true }, workbookKey: 'wb' });
	for (const id of ['[Moving]', '[Twice]']) {
		assert.equal(bm(result, id).status, 'unsupported');
		const own = result.issues.filter((i) => i.object?.id === id);
		assert.ok(own.some((i) => i.code === 'calc.table-calc-unused' && i.severity === 'info'));
		assert.ok(own.some((i) => i.code === 'calc.table-calc-order' && i.severity === 'warning' && /no worksheet uses .*not created/.test(i.message)));
		assert.ok(!own.some((i) => i.severity === 'error'));
		assert.equal(result.bindings.get(DS, id).kind, 'unsupported');
	}
});

test('an unknown field in a calc no worksheet uses is a warning; a used one stays an error', () => {
	const broken = (id) => ({ id: `[${id}]`, name: id, datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Gone])' });
	const user = { id: '[User]', name: 'User', datatype: 'real', role: 'measure', kind: 'calculated', formula: '[Shown] * 2' };
	const pill = { id: `[${DS}].[usr:User:qk]`, datasourceId: DS, fieldId: '[User]', derivation: 'User', prefix: 'usr', typeKey: 'qk', aggregated: true };
	const worksheets = [{ name: 'S', datasourceIds: [DS], filters: [], pills: { [pill.id]: pill } }];
	const r = planBeastModes(ir([...columns, broken('Copied'), broken('Shown'), user], { worksheets }), [dataset], { workbookKey: 'wb' });
	const unknown = (name) => r.issues.find((i) => i.code === 'calc.unknown-field' && i.object?.name === name);
	assert.equal(unknown('Copied').severity, 'warning');
	assert.match(unknown('Copied').message, /no worksheet uses 'Copied', so its Beast Mode is not created/);
	assert.equal(unknown('Shown').severity, 'error');
	assert.ok(!r.issues.some((i) => i.code === 'calc.unsupported' && i.object?.name === 'Copied'));
	assert.equal(r.beastModes.find((b) => b.name === 'Copied').status, 'unsupported');
});

test('a calc that reduces to a bare column (parameter inlined) binds to the column with its name as alias; no beast mode', () => {
	const parameters = [{ id: '[Parameters].[Grain]', name: 'Grain', datatype: 'string', value: 'Region', domain: 'list', members: [{ value: 'Region' }, { value: 'Customer' }] }];
	const fields = [
		...columns,
		{ id: '[Granular]', name: 'Granular', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "IF [Parameters].[Grain] = 'Region' THEN [Region] ELSE [Customer] END" },
		{ id: '[Sales Amount]', name: 'Sales Amount', datatype: 'real', role: 'measure', kind: 'calculated', formula: '[Sales]' },
		{ id: '[Uses It]', name: 'Uses It', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "[Granular] + '!'" },
		{ id: '[Total]', name: 'Total', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales])' }
	];
	const result = planBeastModes(ir(fields, { parameters }), [dataset], { workbookKey: 'wb', options: { parameters: 'inline' } });
	assert.equal(bm(result, '[Granular]'), undefined);
	assert.equal(bm(result, '[Sales Amount]'), undefined);
	assert.deepEqual(result.bindings.get(DS, '[Granular]'), { datasetKey: 'wb.superstore', kind: 'column', name: 'Granular', column: 'Region', alias: 'Granular', aggregated: false, dataType: 'STRING', tableauType: 'string' });
	assert.equal(result.bindings.get(DS, '[Sales Amount]').column, 'Sales');
	// Other calcs inline the column, and an aggregate over a column stays a beast mode.
	assert.match(bm(result, '[Uses It]').expression, /`Region`/);
	assert.equal(bm(result, '[Total]').expression, 'SUM(`Sales`)');
});

test('CONTAINS on a column whose collation ignores case compares lower-cased text; a case-sensitive collation keeps the plain INSTR', () => {
	const calc = { id: '[Family]', name: 'Family', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "IF CONTAINS([Customer], 'Acme') THEN 'Acme' ELSE 'Others' END" };
	const withCollation = (collation) => planBeastModes(ir([...columns.map((f) => (f.id === '[Customer]' ? { ...f, collation } : f)), calc]), [dataset], { workbookKey: 'wb' });
	assert.equal(bm(withCollation('LEN_RUS_S2'), '[Family]').expression, "CASE WHEN INSTR(LOWER(`Customer`), 'acme') > 0 THEN 'Acme' ELSE 'Others' END");
	assert.equal(bm(withCollation('LEN_RUS_S2_VWIN'), '[Family]').expression, "CASE WHEN INSTR(LOWER(`Customer`), 'acme') > 0 THEN 'Acme' ELSE 'Others' END");
	for (const collation of ['binary', 'LROOT', 'LEN_RUS']) assert.equal(bm(withCollation(collation), '[Family]').expression, "CASE WHEN INSTR(`Customer`, 'Acme') > 0 THEN 'Acme' ELSE 'Others' END", collation);
});
