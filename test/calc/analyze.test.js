import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFormula, parseFormula } from '../../src/convert/calc/index.js';

const analyze = (text) => analyzeFormula(parseFormula(text));

describe('analyzeFormula', () => {
	test('aggregated outside LOD only', () => {
		assert.equal(analyze('SUM([Sales])').aggregated, true);
		assert.equal(analyze('[Sales] * 2').aggregated, false);
		assert.equal(analyze('{FIXED [R] : SUM([Sales])}').aggregated, false);
		assert.equal(analyze('MIN([a], [b])').aggregated, false);
		assert.equal(analyze('RUNNING_SUM(SUM([x]))').aggregated, true);
	});

	test('lod list', () => {
		assert.deepEqual(analyze('SUM({FIXED [R], YEAR([D]) : SUM([x])}) + {EXCLUDE [C] : AVG([y])}').lod, [
			{ type: 'FIXED', dimensions: ['[R]', null] },
			{ type: 'EXCLUDE', dimensions: ['[C]'] }
		]);
	});

	test('refs, parameters, functions', () => {
		const a = analyze('IF [Sales] > [Parameters].[Top N] THEN [Region] ELSE [ds].[x] END + STR([Sales])');
		assert.deepEqual(a.refs, ['[Sales]', '[Region]', '[ds].[x]']);
		assert.deepEqual(a.parameters, ['[Parameters].[Top N]']);
		assert.deepEqual(a.functions, ['STR']);
	});

	test('table calcs, user functions, unsupported', () => {
		const a = analyze('IF ISMEMBEROF("x") THEN RANK(SUM([s])) + LOOKUP(SUM([s]), -1) ELSE RAWSQL_INT("1") + FOO() + MAKEPOINT(1, 2) END');
		assert.deepEqual(a.tableCalcs, ['RANK', 'LOOKUP']);
		assert.deepEqual(a.userFunctions, ['ISMEMBEROF']);
		assert.deepEqual(a.unsupported, ['ISMEMBEROF', 'RAWSQL_INT', 'FOO', 'MAKEPOINT']);
	});
});
