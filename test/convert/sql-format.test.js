import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, formatPlanSql } from '../../src/convert/sql-format.js';

test('short expressions stay on one line; keywords and function names are upper-cased', () => {
	assert.equal(formatSql('count(distinct `CaseNumber`)'), 'COUNT(DISTINCT `CaseNumber`)');
	assert.equal(formatSql('SUM(`Sales`) / NULLIF(SUM(`Qty`), 0)'), 'SUM(`Sales`) / NULLIF(SUM(`Qty`), 0)');
	assert.equal(formatSql('DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)'), 'DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)');
});

test('CASE puts each WHEN and ELSE on its own line, END under CASE, nested CASE one level in', () => {
	const sql = "CASE WHEN `Source System Clean` = '-Check-' THEN CASE WHEN `Source Flag` = 'S' THEN 'Acme SFDC' WHEN `Source Flag` = 'C' THEN 'Legacy SFDC' END ELSE `Source System Clean` END";
	assert.equal(
		formatSql(sql),
		[
			'CASE',
			"  WHEN `Source System Clean` = '-Check-' THEN CASE",
			"    WHEN `Source Flag` = 'S' THEN 'Acme SFDC'",
			"    WHEN `Source Flag` = 'C' THEN 'Legacy SFDC'",
			'  END',
			'  ELSE `Source System Clean`',
			'END'
		].join('\n')
	);
	assert.equal(formatSql("CASE `x` WHEN 'a' THEN 1 ELSE 2 END"), "CASE `x`\n  WHEN 'a' THEN 1\n  ELSE 2\nEND");
});

test('a parenthesized expression over 50 characters or holding a CASE breaks one argument per line', () => {
	assert.equal(
		formatSql("SUM(CASE WHEN `Segment` IN ('A', 'B') THEN `Target` END)"),
		"SUM(\n  CASE\n    WHEN `Segment` IN ('A', 'B') THEN `Target`\n  END\n)"
	);
	assert.equal(
		formatSql('DATE(DATE_ADD(DATE_SUB(DATE(`bookings Date`), INTERVAL (DAYOFWEEK(`bookings Date`) - 1) DAY), INTERVAL 1 DAY))'),
		['DATE(', '  DATE_ADD(', '    DATE_SUB(', '      DATE(`bookings Date`),', '      INTERVAL (DAYOFWEEK(`bookings Date`) - 1) DAY', '    ),', '    INTERVAL 1 DAY', '  )', ')'].join('\n'),
		'INTERVAL ( keeps its space; function calls stay tight'
	);
});

test('a long condition starts each AND / OR on a new line; windows and FIXED put one clause per line', () => {
	assert.equal(
		formatSql("CASE WHEN `Category Name` = 'Furniture' AND `Region Name` = 'West' OR `Segment` = 'Home' THEN 1 END"),
		"CASE\n  WHEN `Category Name` = 'Furniture'\n  AND `Region Name` = 'West'\n  OR `Segment` = 'Home' THEN 1\nEND"
	);
	assert.equal(
		formatSql('SUM(SUM(`Sales Amount Total`)) OVER (PARTITION BY `Category Name`, `Region Name` ORDER BY `Order Date`)'),
		'SUM(SUM(`Sales Amount Total`)) OVER (\n  PARTITION BY `Category Name`, `Region Name`\n  ORDER BY `Order Date`\n)'
	);
	assert.equal(formatSql('SUM(SUM(`Sales`)) OVER (PARTITION BY `Category`)'), 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Category`)');
	assert.equal(
		formatSql('SUM(`Sales`) FIXED (BY `Customer Name` FILTER ALLOW `Country/Region`, `Region`)'),
		'SUM(`Sales`) FIXED (\n  BY `Customer Name`\n  FILTER ALLOW `Country/Region`, `Region`\n)'
	);
});

test('literals and names keep their text: case, spacing, keywords and parentheses inside quotes', () => {
	const sql = "CASE WHEN `case when (x)` = 'end  ELSE ''quoted''' THEN \"a  b\" WHEN `y` = 'when\\'s' THEN 'x,  y' ELSE 'then' END";
	const out = formatSql(sql);
	for (const piece of ['`case when (x)`', "'end  ELSE ''quoted'''", '"a  b"', "'when\\'s'", "'x,  y'", "'then'"]) assert.ok(out.includes(piece), piece);
	assert.equal(out.split('\n').length, 5);
});

test('SQL the formatter does not move is returned unchanged: comments, dollar quotes, unbalanced input, huge text', () => {
	for (const sql of ['SUM(`a`) -- total', 'SUM(`a`) /* c */', 'SUM(`a`', "CASE WHEN `a` = 1 THEN 'x'", '$$x$$', `CASE ${'WHEN `a` = 1 THEN 2 '.repeat(5000)}END`]) {
		assert.equal(formatSql(sql), sql);
	}
	assert.equal(formatSql(''), '');
	assert.equal(formatSql(undefined), undefined);
});

test('formatting is idempotent and only changes whitespace', () => {
	const samples = [
		"SUM(CASE WHEN (CASE WHEN `Sales Grouping` = 'ACV Offset' THEN 'Renewals' ELSE `Sales Grouping` END) = 'New Business' THEN (CASE WHEN DOMO_BEAST_MODE(calculation_b1bdc3aa-2c15-5fee-8d24-a370b9c02f7f) = 'Bookings' THEN `Bookings Amt` ELSE 0 END) END)",
		'CONCAT(RPAD(MIN(REGEXP_REPLACE(REGEXP_REPLACE(`Created_FPY`, \'[0-9]+\', \'0000000000$0\'), \'0*([0-9]{10})\', \'$1\')), 255, \' \'), LPAD(CAST(MIN(CASE WHEN `a` = 1 THEN 1 ELSE 2 END) AS CHAR), 1, \'0\'))',
		'-1 * - `x` + (`a` - -2)'
	];
	for (const sql of samples) {
		const once = formatSql(sql);
		assert.equal(formatSql(once), once);
		assert.equal(once.replace(/\s+/g, ''), sql.replace(/\s+/g, ''));
	}
	assert.ok(formatSql(samples[0]).includes('DOMO_BEAST_MODE(calculation_b1bdc3aa-2c15-5fee-8d24-a370b9c02f7f)'), 'variable references stay on one line for bindVariables');
});

test('a SQL DataSet View query puts each clause on its own line', () => {
	const sql = "SELECT a.x, SUM(b.y) AS total FROM t1 a LEFT JOIN t2 b ON a.id = b.id WHERE a.d >= '2024-01-01' GROUP BY a.x ORDER BY total DESC";
	assert.equal(formatSql(sql, { statement: true }), ['SELECT', '  a.x,', '  SUM(b.y) AS total', 'FROM', '  t1 a', '  LEFT JOIN t2 b ON a.id = b.id', 'WHERE', "  a.d >= '2024-01-01'", 'GROUP BY', '  a.x', 'ORDER BY', '  total DESC'].join('\n'));
});

test('formatPlanSql formats beast modes, card formulas, Magic ETL expressions and SQL view queries', () => {
	const long = "CASE WHEN `a` = 1 THEN 'x' ELSE 'y' END";
	const plan = {
		beastModes: [{ expression: long }],
		cards: [{ body: { definition: { formulas: { card: [{ formula: long }] } } } }],
		dataflows: [{ definition: { actions: [{ fields: [{ name: 'f', expression: long }] }, { expressions: [{ fieldName: 'g', expression: long }] }] } }],
		datasets: [{ view: { schema: { viewTemplate: { version: 'advancedEditorSql', selectString: 'SELECT a FROM t1' } } } }]
	};
	formatPlanSql(plan);
	const formatted = formatSql(long);
	assert.notEqual(formatted, long);
	assert.deepEqual([plan.beastModes[0].expression, plan.cards[0].body.definition.formulas.card[0].formula, plan.dataflows[0].definition.actions[0].fields[0].expression, plan.dataflows[0].definition.actions[1].expressions[0].expression], [formatted, formatted, formatted, formatted]);
	assert.equal(plan.datasets[0].view.schema.viewTemplate.selectString, 'SELECT\n  a\nFROM\n  t1');
});
