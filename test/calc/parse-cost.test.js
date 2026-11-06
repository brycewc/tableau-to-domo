import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateCalc, translateEtl } from '../../src/convert/calc/index.js';
import { baseCtx } from './helpers.js';

// Domo parses a Beast Mode with JSqlParser and gives up after 60 s (PARSING_ERROR). Its syntactic lookaheads re-scan a
// comparison's left operand, a parenthesized condition and each nested function call's arguments, so cost grows by a
// factor per nesting level. These shapes keep the same result with less nesting.

const bm = (formula) => translateCalc(formula, baseCtx()).expression;
const LONG_SUM = Array.from({ length: 8 }, (_, i) => `ZN(SUM([Sales])) * ${i + 2}`).join(' + ');
const LONG_SQL = Array.from({ length: 8 }, (_, i) => `IFNULL(SUM(\`Sales\`), 0) * ${i + 2}`).join(' + ');

test('a long left operand of a comparison is mirrored onto the right', () => {
	assert.equal(bm(`IF ${LONG_SUM} >= 0 THEN 1 END`), `CASE WHEN 0 <= ${LONG_SQL} THEN 1 END`);
	assert.equal(bm(`IF ${LONG_SUM} = 0 THEN 1 END`), `CASE WHEN 0 = ${LONG_SQL} THEN 1 END`);
	assert.equal(bm('IF SUM([Sales]) >= 0 THEN 1 END'), 'CASE WHEN SUM(`Sales`) >= 0 THEN 1 END', 'a short one stays');
	assert.equal(
		translateEtl(`IF ${'[Sales] * 2 + '.repeat(20)}[Profit] > 0 THEN 1 END`, baseCtx()).expression,
		`CASE WHEN ${'`Sales` * 2 + '.repeat(20)}\`Profit\` > 0 THEN 1 END`,
		'Magic ETL has another parser'
	);
});

test('a boolean value that is a CASE or long is compared with true from the left', () => {
	const formula = `IF (IF ${LONG_SUM} > 0 THEN TRUE ELSE FALSE END) THEN 1 END`;
	assert.equal(bm(formula), `CASE WHEN 'true' = CASE WHEN 0 < ${LONG_SQL} THEN 'true' ELSE 'false' END THEN 1 END`);
	assert.equal(bm('IF (IF [Sales] > 0 THEN TRUE ELSE FALSE END) THEN 1 END'), "CASE WHEN 'true' = CASE WHEN `Sales` > 0 THEN 'true' ELSE 'false' END THEN 1 END");
	assert.equal(bm('IF MAX([Is Big]) THEN 1 END'), "CASE WHEN MAX(CASE WHEN `Sales` > 1000 THEN 'true' WHEN `Sales` <= 1000 THEN 'false' END) = 'true' THEN 1 END");
});

test('a parenthesized or referenced condition is not wrapped in parentheses again', () => {
	assert.equal(bm('IF ([Sales] > 1) OR [Is Big] THEN 1 END'), 'CASE WHEN `Sales` > 1 OR `Sales` > 1000 THEN 1 END');
	assert.equal(bm('IF NOT ([Sales] > 1 OR [Is Big]) THEN 1 END'), 'CASE WHEN NOT (`Sales` > 1 OR `Sales` > 1000) THEN 1 END');
	assert.equal(bm('IF [Region] = "a" AND ([Sales] > 1 OR [Is Big]) THEN 1 END'), "CASE WHEN `Region` = 'a' AND (`Sales` > 1 OR `Sales` > 1000) THEN 1 END");
	assert.equal(bm('([Sales] + 1) * 2'), '(`Sales` + 1) * 2', 'arithmetic keeps its parentheses');
});

test('zero to null becomes NULLIF with one copy of the value', () => {
	assert.equal(bm('IF COUNTD([Customer Name]) = 0 THEN NULL ELSE COUNTD([Customer Name]) END'), 'NULLIF(COUNT(DISTINCT `Customer Name`), 0)');
	assert.equal(bm('IF 0 = SUM([Sales]) THEN NULL ELSE SUM([Sales]) END'), 'NULLIF(SUM(`Sales`), 0)');
	assert.equal(bm('IF SUM([Sales]) != 0 THEN SUM([Sales]) END'), 'NULLIF(SUM(`Sales`), 0)');
	assert.equal(bm('IF [Region] = "x" THEN NULL ELSE [Region] END'), "NULLIF(`Region`, 'x')");
	assert.equal(bm('IF SUM([Sales]) = 0 THEN NULL ELSE SUM([Profit]) END'), 'CASE WHEN SUM(`Sales`) = 0 THEN NULLIF(1, 1) ELSE SUM(`Profit`) END');
	assert.equal(bm('IF SUM([Sales]) = SUM([Profit]) THEN NULL ELSE SUM([Sales]) END'), 'CASE WHEN SUM(`Sales`) = SUM(`Profit`) THEN NULLIF(1, 1) ELSE SUM(`Sales`) END');
	assert.equal(bm('IF SUM([Sales]) = 0 THEN 0 ELSE SUM([Sales]) END'), 'CASE WHEN SUM(`Sales`) = 0 THEN 0 ELSE SUM(`Sales`) END');
});

test('month offsets of a truncated date fold into one DATE_ADD, and DATE() of a date-only value is dropped', () => {
	const shifted = 'DATE_ADD(`Order Time`, INTERVAL 1 MONTH)';
	assert.equal(
		bm("DATE(DATEADD('month', -1, DATETRUNC('quarter', DATEADD('month', 1, [Order Time]))))"),
		`DATE_ADD(DATE_SUB(DATE(${shifted}), INTERVAL (DAYOFYEAR(${shifted}) - 1) DAY), INTERVAL ((QUARTER(${shifted}) - 1) * 3 - 1) MONTH)`
	);
	const monthStart = 'DATE_SUB(DATE(`Order Date`), INTERVAL (DAYOFMONTH(`Order Date`) - 1) DAY)';
	assert.equal(bm("DATEADD('year', 1, DATETRUNC('month', [Order Date]))"), `DATE_ADD(${monthStart}, INTERVAL 12 MONTH)`);
	assert.equal(bm("DATEADD('month', 1, DATEADD('month', 1, DATETRUNC('month', [Order Date])))"), `DATE_ADD(${monthStart}, INTERVAL 2 MONTH)`);
	assert.equal(bm("DATEADD('month', -1, DATEADD('month', 1, DATETRUNC('month', [Order Date])))"), monthStart);
	const yearStart = 'DATE_SUB(DATE(`Order Date`), INTERVAL (DAYOFYEAR(`Order Date`) - 1) DAY)';
	assert.equal(bm("DATEADD('quarter', [Quantity], DATETRUNC('year', [Order Date]))"), `DATE_ADD(${yearStart}, INTERVAL (\`Quantity\` * 3) MONTH)`);
	assert.equal(bm("DATEADD('month', 1.5, DATETRUNC('year', [Order Date]))"), `DATE_ADD(${yearStart}, INTERVAL 1.5 MONTH)`, 'a fraction of a month is not added up');
	assert.equal(bm("DATEADD('month', 1, DATEADD('day', 1, DATETRUNC('month', [Order Date])))"), `DATE_ADD(DATE_ADD(${monthStart}, INTERVAL 1 DAY), INTERVAL 1 MONTH)`, 'only from a first of month');
	assert.equal(bm("DATEADD('month', 1, DATEADD('month', 1, [Order Date]))"), 'DATE_ADD(DATE_ADD(`Order Date`, INTERVAL 1 MONTH), INTERVAL 1 MONTH)', 'month ends clamp');
	assert.equal(bm("DATE(DATEADD('day', 1, DATETRUNC('week', [Order Time])))"), 'DATE_ADD(DATE_SUB(DATE(`Order Time`), INTERVAL (DAYOFWEEK(`Order Time`) - 1) DAY), INTERVAL 1 DAY)');
	assert.equal(bm("DATE(DATEADD('hour', 1, DATETRUNC('day', [Order Time])))"), 'DATE(DATE_ADD(DATE(`Order Time`), INTERVAL 1 HOUR))');
	assert.equal(bm('DATE([Order Date])'), 'DATE(`Order Date`)', 'a date column may hold a time in Domo');
});
