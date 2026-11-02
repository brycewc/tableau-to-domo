import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { translateCalc } from '../../src/convert/calc/index.js';
import { baseCtx, codes } from './helpers.js';

describe('LOD expressions to Domo FIXED', () => {
	test('bare FIXED used as a measure defaults to SUM and is approximate', () => {
		const r = translateCalc('{FIXED [Region] : SUM([Sales])}', baseCtx());
		assert.equal(r.expression, 'SUM(SUM(`Sales`) FIXED (BY `Region` FILTER NONE))');
		assert.equal(r.status, 'approximate');
		assert.equal(r.aggregated, true);
		assert.deepEqual(r.features, ['fixed']);
		assert.ok(codes(r).includes('calc.lod-outer-aggregation'));
	});

	test('a CASE dimension is parenthesized (a bare one fails at query time)', () => {
		const r = translateCalc("SUM({FIXED [Region], IIF([Sales] > 1, 'big', 'small') : SUM([Sales])})", baseCtx());
		assert.match(r.expression, /FIXED \(BY `Region`, \(CASE WHEN `Sales` > 1 THEN 'big' WHEN .* END\) FILTER NONE\)/);
	});

	test('outer aggregation from the pill is used and keeps status ok', () => {
		const r = translateCalc('{FIXED [Region], [Category] : SUM([Sales])}', baseCtx({ outerAggregation: 'Avg' }));
		assert.equal(r.expression, 'AVG(SUM(`Sales`) FIXED (BY `Region`, `Category` FILTER NONE))');
		assert.equal(r.status, 'ok');
	});

	test('COUNTD outer aggregation', () => {
		const r = translateCalc('{FIXED [Region] : MAX([Sales])}', baseCtx({ outerAggregation: 'CountD' }));
		assert.equal(r.expression, 'COUNT(DISTINCT MAX(`Sales`) FIXED (BY `Region` FILTER NONE))');
		assert.equal(r.dataType, 'LONG');
	});

	test('context filters become FILTER ALLOW', () => {
		const r = translateCalc('SUM({FIXED [Region] : SUM([Sales])})', baseCtx({ contextFilterColumns: ['Category', 'Order Date'] }));
		assert.equal(r.expression, 'SUM(SUM(`Sales`) FIXED (BY `Region` FILTER ALLOW `Category`, `Order Date`))');
		assert.equal(r.status, 'ok');
	});

	test('table-scoped FIXED and bare braces', () => {
		assert.equal(translateCalc('SUM({ FIXED : SUM([Sales]) })', baseCtx()).expression, 'SUM(SUM(`Sales`) FIXED (FILTER NONE))');
		assert.equal(translateCalc('SUM({SUM([Sales])})', baseCtx()).expression, 'SUM(SUM(`Sales`) FIXED (FILTER NONE))');
	});

	test('explicit outer aggregate in the formula', () => {
		const r = translateCalc('SUM([Sales]) / SUM({FIXED : SUM([Sales])})', baseCtx());
		assert.equal(r.expression, 'SUM(`Sales`) / NULLIF(SUM(SUM(`Sales`) FIXED (FILTER NONE)), 0)');
		assert.equal(r.status, 'ok');
	});

	test('INCLUDE becomes FIXED ADD without a FILTER clause', () => {
		const r = translateCalc('AVG({INCLUDE [Customer Name] : SUM([Sales])})', baseCtx({ contextFilterColumns: ['Category'] }));
		assert.equal(r.expression, 'AVG(SUM(`Sales`) FIXED (ADD `Customer Name`))');
	});

	test('EXCLUDE becomes FIXED REMOVE', () => {
		assert.equal(translateCalc('SUM({EXCLUDE [Region] : SUM([Sales])})', baseCtx()).expression, 'SUM(SUM(`Sales`) FIXED (REMOVE `Region`))');
	});

	test('every aggregate in the LOD body carries the FIXED clause', () => {
		const r = translateCalc('MAX({FIXED [Region] : SUM([Profit]) / COUNTD([Customer Name])})', baseCtx());
		assert.equal(r.expression, 'MAX(SUM(`Profit`) FIXED (BY `Region` FILTER NONE) / NULLIF(COUNT(DISTINCT `Customer Name`) FIXED (BY `Region` FILTER NONE), 0))');
	});

	test('ATTR inside an LOD body', () => {
		const r = translateCalc('MAX({FIXED [Region] : ATTR([Category])})', baseCtx());
		assert.equal(
			r.expression,
			"MAX(CASE WHEN MIN(`Category`) FIXED (BY `Region` FILTER NONE) = MAX(`Category`) FIXED (BY `Region` FILTER NONE) THEN MIN(`Category`) FIXED (BY `Region` FILTER NONE) ELSE '*' END)"
		);
	});

	test('nested LOD is translated with a warning', () => {
		const r = translateCalc('{FIXED [Region] : AVG({FIXED [Region], [Customer Name] : SUM([Sales])})}', baseCtx({ outerAggregation: 'SUM' }));
		assert.equal(r.expression, 'SUM(AVG(SUM(`Sales`) FIXED (BY `Region`, `Customer Name` FILTER NONE)) FIXED (BY `Region` FILTER NONE))');
		assert.ok(codes(r).includes('calc.lod-nested'));
		assert.equal(r.status, 'approximate');
	});

	test('nested LOD wrapped in an expression inside another LOD is unsupported', () => {
		for (const formula of [
			'{FIXED [Region] : MAX({FIXED [Customer Name] : SUM([Sales])} + 1)}',
			'{FIXED [Region] : MAX(IF [Sales] = {FIXED [Customer Name] : MIN([Sales])} THEN 1 ELSE 0 END)}',
			'{FIXED [Region] : MAX(IFNULL({FIXED [Customer Name] : MIN([Sales])}, 0))}'
		]) {
			const r = translateCalc(formula, baseCtx({ outerAggregation: 'SUM' }));
			assert.ok(codes(r).includes('calc.lod-nested-wrapped'), formula);
			assert.equal(r.status, 'unsupported', formula);
		}
		const direct = translateCalc('{FIXED [Region] : MAX(({FIXED [Customer Name] : MIN([Sales])}))}', baseCtx({ outerAggregation: 'SUM' }));
		assert.ok(!codes(direct).includes('calc.lod-nested-wrapped'));
		assert.equal(direct.status, 'approximate');
	});

	test('LOD compared in a row-level IF is a dimension', () => {
		const r = translateCalc('IF {FIXED [Customer Name] : SUM([Sales])} > 1000 THEN "Big" ELSE "Small" END', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.deepEqual(codes(r), ['calc.lod-dimension']);
		assert.match(r.issues[0].suggestion, /Magic ETL/);
	});

	test('LOD combined with a row-level column is a dimension', () => {
		const r = translateCalc('{FIXED [Customer Name] : SUM([Sales])} * [Discount]', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.lod-dimension'));
	});

	test('date-valued LOD (cohort) is a dimension', () => {
		const r = translateCalc('{FIXED [Customer Name] : MIN([Order Date])}', baseCtx());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.lod-dimension'));
	});

	test('numeric LOD with role dimension is unsupported', () => {
		const r = translateCalc('{FIXED [Region] : COUNTD([Customer Name])}', baseCtx({ role: 'dimension' }));
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.lod-dimension'));
	});

	test('LOD inside a referenced calc, aggregated by the outer formula', () => {
		const r = translateCalc('SUM([Customer Sales])', baseCtx());
		assert.equal(r.expression, 'SUM(SUM(`Sales`) FIXED (BY `Customer Name` FILTER NONE))');
		assert.equal(r.status, 'ok');
	});

	test('LOD inside a referenced calc used row-level is detected', () => {
		const r = translateCalc('DATEDIFF("day", [First Order], [Order Date])', baseCtx());
		assert.ok(codes(r).includes('calc.lod-dimension'));
	});

	test('useFixed false makes LODs unsupported', () => {
		const r = translateCalc('SUM({FIXED [Region] : SUM([Sales])})', baseCtx({ options: { useFixed: false } }));
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.lod'));
		assert.deepEqual(r.features, []);
	});

	test('LOD with an expression dimension', () => {
		const r = translateCalc('SUM({FIXED YEAR([Order Date]) : SUM([Sales])})', baseCtx());
		assert.equal(r.expression, 'SUM(SUM(`Sales`) FIXED (BY YEAR(`Order Date`) FILTER NONE))');
	});

	test('LOD body without aggregation warns', () => {
		const r = translateCalc('SUM({FIXED [Region] : [Sales]})', baseCtx());
		assert.ok(codes(r).includes('calc.lod-unaggregated'));
	});
});
