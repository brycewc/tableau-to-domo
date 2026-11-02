import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { translateRowExpression, translateEtl, translateCalc, parseFormula } from '../../src/convert/calc/index.js';
import { baseCtx, codes } from './helpers.js';

describe('translateRowExpression (Magic ETL formula)', () => {
	test('row-level expressions translate like beast modes', () => {
		assert.equal(translateRowExpression('[Region] + "-" + [Category]', baseCtx()).expression, "CONCAT(`Region`, '-', `Category`)");
		assert.equal(translateRowExpression('DATEDIFF("day", [Order Date], [Ship Date])', baseCtx()).expression, 'DATEDIFF(`Ship Date`, `Order Date`)');
		assert.equal(translateRowExpression('ZN([Sales]) * 2', baseCtx()).status, 'ok');
	});

	test('aggregates, LODs and table calcs are row-level-only errors', () => {
		for (const f of ['SUM([Sales])', '{FIXED [Region] : SUM([Sales])}', 'RUNNING_SUM(SUM([Sales]))', 'TOTAL(SUM([Sales]))']) {
			const r = translateRowExpression(f, baseCtx({ options: { useWindowFunctions: true } }));
			assert.equal(r.status, 'unsupported', f);
			assert.ok(codes(r).includes('calc.row-level-only'), f);
		}
	});

	test('parameters are always inlined', () => {
		const ctx = baseCtx({ options: { parameters: 'variables' } });
		assert.equal(translateRowExpression('[Calculation_3] * [Parameters].[Rate]', ctx).expression, '(`Profit` - `Discount`) * 0.25');
	});

	test('no FIXED or window features are reported', () => {
		assert.deepEqual(translateRowExpression('IF [Sales] > 0 THEN "P" END', baseCtx()).features, []);
	});
});

describe('translateEtl (Magic ETL Group By and formula tiles)', () => {
	test('aggregate mode allows aggregations without FIXED and uses Magic SQL names', () => {
		const r = translateEtl('ZN(SUM([Sales])) / VAR([Profit])', baseCtx(), { aggregate: true });
		assert.equal(r.status, 'ok');
		assert.equal(r.aggregated, true);
		assert.equal(r.expression, 'IFNULL(SUM(`Sales`), 0) / NULLIF(VARIANCE_SAMP(`Profit`), 0)');
		assert.ok(codes(translateEtl('SUM(MAX([Sales]))', baseCtx(), { aggregate: true })).includes('calc.etl-nested-aggregate'));
	});

	test('an AST node translates directly, and lodColumn reads a materialized LOD as a column', () => {
		const lod = parseFormula('{FIXED [Region] : SUM([Sales])}');
		assert.equal(translateEtl(lod.body, baseCtx(), { aggregate: true }).expression, 'SUM(`Sales`)');
		const ctx = baseCtx({ lodColumn: (node) => (node.type === 'Lod' ? { column: 'Region Sales', datatype: 'real' } : undefined) });
		assert.equal(translateEtl('[Sales] / {FIXED [Region] : SUM([Sales])}', ctx).expression, '`Sales` / NULLIF(`Region Sales`, 0)');
		assert.equal(translateCalc('[Sales] / {FIXED [Region] : SUM([Sales])}', ctx).expression, '`Sales` / NULLIF(`Region Sales`, 0)');
	});

	test('INT and FLOAT of text cast to DECIMAL with no precision, which is all Magic ETL parses', () => {
		assert.equal(translateEtl('FLOAT([Region])', baseCtx()).expression, 'CAST(`Region` AS DECIMAL)');
		assert.equal(translateEtl('INT([Region])', baseCtx()).expression, 'CASE WHEN CAST(`Region` AS DECIMAL) >= 0 THEN FLOOR(CAST(`Region` AS DECIMAL)) ELSE CEILING(CAST(`Region` AS DECIMAL)) END');
	});

	test('division by a value that can be zero is null in Magic ETL, as in Tableau', () => {
		assert.equal(translateEtl('[Sales] / 2 + [Sales] % [Profit] + DIV([Quantity], [Quantity])', baseCtx()).expression, '`Sales` / 2 + MOD(`Sales`, NULLIF(`Profit`, 0)) + TRUNCATE(`Quantity` / NULLIF(`Quantity`, 0), 0)');
		assert.equal(translateCalc('[Sales] / [Profit]', baseCtx()).expression, '`Sales` / NULLIF(`Profit`, 0)');
		assert.equal(translateCalc('SUM([Sales]) / 2.5 + [Sales] / 0', baseCtx()).expression, 'SUM(`Sales`) / 2.5 + `Sales` / NULLIF(0, 0)');
	});

	test('trig functions are Magic ETL formulas but stay no-equivalent in Beast Mode', () => {
		assert.equal(translateEtl('ATAN2([Sales], [Profit]) + COS(0)', baseCtx()).expression, 'ATAN2(`Sales`, `Profit`) + COS(0)');
		const bm = translateCalc('SIN([Sales])', baseCtx());
		assert.ok(codes(bm).includes('calc.no-equivalent'));
		assert.match(bm.issues.find((i) => i.code === 'calc.no-equivalent').suggestion, /Magic ETL formula tile/);
		assert.ok(codes(translateEtl('SIN([Sales], 1)', baseCtx())).includes('calc.arity'));
		assert.ok(codes(translateEtl('REGEXP_EXTRACT([Region], "a")', baseCtx())).includes('calc.no-equivalent'));
	});
});
