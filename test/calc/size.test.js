import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateCalc, translateEtl, MAX_EXPRESSION_BYTES, LARGE_EXPRESSION_BYTES } from '../../src/convert/calc/index.js';
import { baseCtx, codes } from './helpers.js';

const literal = (n) => `"${'a'.repeat(n)}"`;

test('an expression over the large size is a warning, never ok', () => {
	const r = translateCalc(`[Region] + ${literal(LARGE_EXPRESSION_BYTES)}`, baseCtx());
	assert.equal(r.status, 'approximate');
	assert.ok(codes(r).includes('calc.expression-large'));
	assert.equal(translateCalc(`[Region] + ${literal(1000)}`, baseCtx()).status, 'ok');
});

test('an expression over the Domo limit is unsupported, counted in UTF-8 bytes', () => {
	const r = translateCalc(`[Region] + ${literal(MAX_EXPRESSION_BYTES)}`, baseCtx());
	assert.equal(r.status, 'unsupported');
	assert.ok(codes(r).includes('calc.expression-too-large'));
	const wide = translateCalc(`[Region] + "${'é'.repeat(MAX_EXPRESSION_BYTES / 2)}"`, baseCtx());
	assert.ok(wide.expression.length < MAX_EXPRESSION_BYTES);
	assert.ok(codes(wide).includes('calc.expression-too-large'));
});

test('Magic ETL formulas get only the hard limit', () => {
	assert.equal(translateEtl(`[Region] + ${literal(LARGE_EXPRESSION_BYTES)}`, baseCtx()).status, 'ok');
	assert.ok(codes(translateEtl(`[Region] + ${literal(MAX_EXPRESSION_BYTES)}`, baseCtx())).includes('calc.expression-too-large'));
});

test('the value form of IN over constants does not repeat the list', () => {
	const r = translateCalc('NOT ([Region] IN ("a", "b") OR ISNULL([Region]))', baseCtx());
	assert.equal(r.expression, "CASE WHEN NOT (`Region` IN ('a', 'b') OR `Region` IS NULL) THEN 'true' ELSE 'false' END");
});

test('MAKEDATETIME in Magic ETL adds the time to the date', () => {
	assert.equal(translateEtl('MAKEDATETIME([Order Date], [Ship Time])', baseCtx()).expression, 'ADDTIME(TIMESTAMP(DATE(`Order Date`)), TIME(`Ship Time`))');
});
