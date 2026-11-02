import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { translateCalc } from '../../src/convert/calc/index.js';
import { baseCtx, codes } from './helpers.js';

const CASES = [
	['USERNAME()', 'calc.user-function'],
	['FULLNAME()', 'calc.user-function'],
	['USERDOMAIN()', 'calc.user-function'],
	['ISMEMBEROF("Managers")', 'calc.user-function'],
	['ISUSERNAME("bob")', 'calc.user-function'],
	['IF ISMEMBEROF("Sales") THEN [Sales] END', 'calc.user-function'],
	['MAKEPOINT([Sales], [Profit])', 'calc.spatial'],
	['DISTANCE([A], [B], "km")', 'calc.spatial'],
	['HEXBINX([Sales], [Profit])', 'calc.spatial'],
	['RAWSQL_REAL("%1 * 2", [Sales])', 'calc.rawsql'],
	['RAWSQLAGG_INT("SUM(%1)", [Sales])', 'calc.rawsql'],
	['SCRIPT_REAL("return 1", SUM([Sales]))', 'calc.script'],
	['MODEL_QUANTILE(0.5, SUM([Sales]))', 'calc.script'],
	['FOO([Sales])', 'calc.unknown-function'],
	['REGEXP_EXTRACT([Code], "[0-9]+")', 'calc.no-equivalent'],
	['SIN([Sales]) + COS([Sales]) + TAN([Sales])', 'calc.no-equivalent'],
	['COT([Sales])', 'calc.no-equivalent'],
	['ASIN([Profit]) + ACOS([Profit]) + ATAN([Profit])', 'calc.no-equivalent'],
	['ATAN2([Sales], [Profit])', 'calc.no-equivalent'],
	['ASCII([Code])', 'calc.no-equivalent'],
	['CHAR([Quantity])', 'calc.no-equivalent'],
	['LEFT([Region])', 'calc.arity'],
	['DATEPART([Code], [Order Date])', 'calc.date-part'],
	["DATEPART('fortnight', [Order Date])", 'calc.date-part'],
	['SPLIT([Code], "-", [Quantity])', 'calc.split-token'],
	['DATEPARSE([Code], [Code])', 'calc.dateparse-format'],
	['[Region] + ', 'calc.syntax'],
	['IF [Sales] > 1 THEN 2', 'calc.syntax']
];

describe('unsupported constructs', () => {
	for (const [formula, code] of CASES) {
		test(`${formula} -> ${code}`, () => {
			const r = translateCalc(formula, baseCtx());
			assert.equal(r.status, 'unsupported');
			assert.ok(codes(r).includes(code), codes(r).join(','));
			assert.equal(r.issues.find((i) => i.code === code).severity, 'error');
		});
	}

	test('user functions suggest PDP', () => {
		assert.match(translateCalc('USERNAME()', baseCtx()).issues[0].suggestion, /PDP/);
	});

	test('syntax error carries position', () => {
		const r = translateCalc('SUM([Sales]', baseCtx());
		assert.equal(r.expression, '');
		assert.match(r.issues[0].message, /line 1, column 12/);
	});

	test('approximations are warnings, not errors', () => {
		const r = translateCalc('COVARP([Sales], [Profit])', baseCtx());
		assert.equal(r.status, 'approximate');
		assert.equal(r.issues[0].severity, 'warning');
		const p = translateCalc("DATEPARSE('yyyy-MM-dd zzz', [Code])", baseCtx());
		assert.equal(p.status, 'approximate');
		assert.ok(codes(p).includes('calc.dateparse-format'));
	});

	test('REGEXP_MATCH warns only when the pattern can match an empty string', () => {
		assert.ok(!codes(translateCalc("REGEXP_MATCH([Code], '^[A-Z]+$')", baseCtx())).includes('calc.regexp-match'));
		for (const formula of ["REGEXP_MATCH([Code], '^$')", 'REGEXP_MATCH([Code], [Region])', "REGEXP_MATCH([Code], '(?i)a')"]) {
			const r = translateCalc(formula, baseCtx());
			assert.equal(r.status, 'approximate', formula);
			assert.equal(r.issues.find((i) => i.code === 'calc.regexp-match').severity, 'warning');
		}
	});

	test('issue object names the calculation', () => {
		const r = translateCalc('USERNAME()', baseCtx({ name: 'Me' }));
		assert.deepEqual(r.issues[0].object, { type: 'calculation', name: 'Me' });
	});
});
