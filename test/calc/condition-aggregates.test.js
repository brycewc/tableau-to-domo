import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionAggregates } from '../../src/convert/calc/sql.js';

test('every aggregate of an expression counts only the rows a condition keeps', () => {
	assert.equal(conditionAggregates('COUNT(DISTINCT CASE WHEN `age` > 30 THEN `id` END) / COUNT(DISTINCT `id`)', 'c'), 'COUNT(DISTINCT CASE WHEN c THEN CASE WHEN `age` > 30 THEN `id` END END) / COUNT(DISTINCT CASE WHEN c THEN `id` END)');
	assert.equal(conditionAggregates('SUM(`x`) + COUNT(*)', 'c'), 'SUM(CASE WHEN c THEN `x` END) + COUNT(CASE WHEN c THEN 1 END)');
	assert.equal(conditionAggregates("MAX(CONCAT('SUM(', `x`))", 'c'), "MAX(CASE WHEN c THEN CONCAT('SUM(', `x`) END)", 'text inside quotes is not a call');
	assert.equal(conditionAggregates('SUM(`a`) / SUM(`b`)', 'c'), 'SUM(CASE WHEN c THEN `a` END) / SUM(CASE WHEN c THEN `b` END)');
});

test('expressions the condition cannot reach give undefined', () => {
	assert.equal(conditionAggregates('`x` + 1', 'c'), undefined, 'no aggregate');
	assert.equal(conditionAggregates('SUM(SUM(`x`)) OVER ()', 'c'), undefined, 'a window');
	assert.equal(conditionAggregates('SUM(DOMO_BEAST_MODE(calculation_1))', 'c'), undefined, 'another Beast Mode');
	assert.equal(conditionAggregates('SUMMARY(`x`)', 'c'), undefined, 'a function named like one');
	assert.equal(conditionAggregates('SUM(`x`', 'c'), undefined, 'unbalanced');
});
