import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { translateCalc } from '../../src/convert/calc/index.js';
import { baseCtx, codes, CALCS, resolveField } from './helpers.js';

describe('field, calc and parameter references', () => {
	test('nested aggregate calc is inlined in parentheses', () => {
		const r = translateCalc('[Calculation_1]', baseCtx());
		assert.equal(r.expression, '(SUM(`Profit`) / NULLIF(SUM(`Sales`), 0))');
		assert.equal(r.aggregated, true);
		assert.equal(r.status, 'ok');
	});

	test('nested calcs inline recursively and keep string type for CONCAT', () => {
		assert.equal(translateCalc('[Calculation_4]', baseCtx()).expression, '((`Profit` - `Discount`) * 2)');
		assert.equal(translateCalc('[Calculation_2] + "!"', baseCtx()).expression, "CONCAT(CONCAT(`Region`, '-', `Category`), '!')");
	});

	test('nested boolean calc keeps its predicate when used as a condition', () => {
		assert.equal(translateCalc('IF [Is Big] THEN "Y" END', baseCtx()).expression, "CASE WHEN `Sales` > 1000 THEN 'Y' END");
	});

	test('cycle detection', () => {
		const r = translateCalc('[Cycle A]', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.cycle'));
		assert.match(r.issues.find((i) => i.code === 'calc.cycle').message, /Cycle A.*Cycle B.*Cycle A/);
	});

	test('self-reference is a cycle when ctx.field is the calc being translated', () => {
		const field = CALCS['[Cycle A]'];
		const r = translateCalc(field.formula, baseCtx({ field }));
		assert.ok(codes(r).includes('calc.cycle'));
		assert.deepEqual(r.issues[0].object, { type: 'calculation', name: 'Cycle A', id: '[Cycle A]' });
	});

	test('referenced calc with a syntax error', () => {
		const r = translateCalc('[Broken] + 1', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.syntax'));
	});

	test('parameters are inlined with their current value', () => {
		const rate = translateCalc('[Sales] * [Parameters].[Rate]', baseCtx());
		assert.equal(rate.expression, '`Sales` * 0.25');
		assert.equal(rate.status, 'ok');
		assert.deepEqual(codes(rate), ['calc.parameter-inlined']);
		assert.equal(rate.issues[0].severity, 'info');
		assert.match(translateCalc('[Region] = [Parameters].[Region Choice]', baseCtx()).expression, /`Region` = 'O''Brien'/);
		assert.match(translateCalc('[Order Date] >= [Parameters].[Start]', baseCtx()).expression, /`Order Date` >= '2024-01-15'/);
	});

	test('parameter as a DATETRUNC part is resolved to its value', () => {
		assert.equal(translateCalc('DATETRUNC([Parameters].[Grain], [Order Date])', baseCtx()).expression, 'DATE_SUB(DATE(`Order Date`), INTERVAL (DAYOFMONTH(`Order Date`) - 1) DAY)');
	});

	test('parameters as variables', () => {
		const r = translateCalc('[Sales] * [Parameters].[Rate]', baseCtx({ options: { parameters: 'variables' }, parameterReference: (p) => `\`${p.name} Variable\`` }));
		assert.equal(r.expression, '`Sales` * `Rate Variable`');
		assert.ok(!codes(r).includes('calc.parameter-inlined'));
		const fallback = translateCalc('[Sales] * [Parameters].[Rate]', baseCtx({ options: { parameters: 'variables' } }));
		assert.equal(fallback.expression, '`Sales` * `Rate`');
	});

	test('unknown parameter and unknown field', () => {
		assert.ok(codes(translateCalc('[Parameters].[Missing]', baseCtx())).includes('calc.unknown-parameter'));
		const r = translateCalc('[Nope] + 1', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.unknown-field'));
	});

	test('qualified reference to the same datasource resolves', () => {
		assert.equal(translateCalc('[federated.abc].[Sales]', baseCtx()).expression, '`Sales`');
	});

	test('cross-datasource reference is a blend', () => {
		const r = translateCalc('SUM([Sample - Superstore].[Sales])', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.deepEqual(codes(r), ['calc.blend']);
	});

	test('escaped bracket in a field name', () => {
		assert.equal(translateCalc('[Weird]]Name]', baseCtx()).expression, '`Weird]Name`');
	});

	test('boolean columns become predicates', () => {
		assert.equal(translateCalc('IF [Is Returned] THEN 1 ELSE 0 END', baseCtx()).expression, "CASE WHEN LOWER(`Is Returned`) = 'true' THEN 1 ELSE 0 END");
		const longCtx = baseCtx({ resolveField: (id) => (id === '[Flag]' ? { kind: 'column', column: 'Flag', datatype: 'boolean', domoType: 'LONG' } : undefined) });
		assert.equal(translateCalc('IIF([Flag], 1, 0)', longCtx).expression, 'CASE WHEN `Flag` = 1 THEN 1 WHEN NOT (`Flag` = 1) THEN 0 END');
	});

	test('resolver accepting Domo types', () => {
		const ctx = { resolveField: (id) => ({ kind: 'column', column: id.slice(1, -1), datatype: id === '[Name]' ? 'STRING' : 'DOUBLE' }) };
		assert.equal(translateCalc('[Name] + [Other]', ctx).expression, 'CONCAT(`Name`, `Other`)');
		assert.equal(translateCalc('[A] + [B]', ctx).expression, '`A` + `B`');
	});

	test('without a resolver every field is a column', () => {
		const r = translateCalc('SUM([Sales]) + [Bare Name]');
		assert.equal(r.expression, 'SUM(`Sales`) + `Bare Name`');
	});

	test('unbracketed field names', () => {
		assert.equal(translateCalc('SUM(Sales)', baseCtx()).expression, 'SUM(`Sales`)');
	});

	test('unknown operand types note the numeric assumption', () => {
		const r = translateCalc('[A] + [B]');
		assert.ok(codes(r).includes('calc.type-unknown'));
		assert.equal(r.status, 'ok');
	});

	test('calc datatype is the fallback for the result type', () => {
		const r = translateCalc('NULL', baseCtx({ field: { id: '[X]', name: 'X', datatype: 'integer', formula: 'NULL' } }));
		assert.equal(r.dataType, 'LONG');
	});
	test('boolean parameter variable compares the string variable', () => {
		const flag = { id: '[Parameters].[Flag]', name: 'Flag', datatype: 'boolean', domain: 'all', value: 'true' };
		const ctx = baseCtx({ options: { parameters: 'variables' }, resolveField: (id) => (id === flag.id ? { kind: 'parameter', parameter: flag } : resolveField(id)) });
		const r = translateCalc('IF [Parameters].[Flag] THEN [Sales] ELSE 0 END', ctx);
		assert.equal(r.expression, "CASE WHEN LOWER(`Flag`) = 'true' THEN `Sales` ELSE 0 END");
	});
});
