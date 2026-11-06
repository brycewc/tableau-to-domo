import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaToSnowflake, sqlExpressionToFormula } from '../../src/magic/index.js';
import { magicFormatToSnowflake, magicType, snowflakeFormatToMagic, toMagic, toMagicValue } from '../../src/magic/expr.js';
import { parseExpr } from '../../src/magic/parser.js';

const f = (sql, opts) => sqlExpressionToFormula(sql, opts);

test('Snowflake functions map to Magic ETL formulas', () => {
	const cases = [
		["NVL(a, 'x')", "IFNULL(`A`, 'x')"],
		['IFNULL(a, 0)', 'IFNULL(`A`, 0)'],
		["IFF(a > 1, 'big', 'small')", "CASE WHEN `A` > 1 THEN 'big' ELSE 'small' END"],
		['NVL2(a, 1, 0)', 'CASE WHEN `A` IS NOT NULL THEN 1 ELSE 0 END'],
		['ZEROIFNULL(a)', 'IFNULL(`A`, 0)'],
		["DECODE(a, 1, 'one', NULL, 'none', 'other')", "CASE WHEN `A` = 1 THEN 'one' WHEN `A` IS NULL THEN 'none' ELSE 'other' END"],
		['TO_VARCHAR(fy)', 'CAST(`FY` AS STRING)'],
		["TO_CHAR(d, 'YYYY-MM-DD')", "DATE_FORMAT(`D`, '%Y-%m-%d')"],
		["'Q' || TO_VARCHAR(q) || ' ' || y", "CONCAT('Q', CAST(`Q` AS STRING), ' ', `Y`)"],
		['a % 7', 'MOD(`A`, 7)'],
		['TO_NUMBER(x)', 'ROUND(CAST(`X` AS DECIMAL), 0)'],
		['TO_NUMBER(x, 10, 2)', 'ROUND(CAST(`X` AS DECIMAL), 2)'],
		['TRY_TO_NUMERIC(x)', 'ROUND(TRY_CAST(`X` AS DECIMAL), 0)'],
		['TRY_TO_DATE(s)', 'TRY_CAST(`S` AS DATE)'],
		['TO_DATE(s)', 'DATE(`S`)'],
		["TO_DATE(s, 'YYYY-MM-DD')", "DATE(STR_TO_DATE(`S`, '%Y-%m-%d'))"],
		['x::date', 'DATE(`X`)'],
		['CAST(x AS VARCHAR(20))', 'CAST(`X` AS STRING)'],
		['CAST(x AS NUMBER(38,0))', 'CAST(`X` AS LONG)'],
		['CAST(x AS NUMBER(18,4))', 'ROUND(CAST(`X` AS DECIMAL), 4)'],
		['CAST(x AS INT)', 'CAST(`X` AS LONG)'],
		['CAST(x AS FLOAT)', 'CAST(`X` AS DOUBLE)'],
		['CAST(x AS TIMESTAMP_NTZ)', 'CAST(`X` AS TIMESTAMP)'],
		['DATEADD(month, 3, d)', 'DATE_ADD(`D`, INTERVAL 3 MONTH)'],
		["DATEADD('day', -n, d)", 'DATE_ADD(`D`, INTERVAL (-`N`) DAY)'],
		['DATEADD(year, YEAR(d) - 1900 + 3, d)', 'DATE_ADD(`D`, INTERVAL (YEAR(`D`) - 1900 + 3) YEAR)'],
		['ADD_MONTHS(d, 1)', 'DATE_ADD(`D`, INTERVAL 1 MONTH)'],
		['DATEDIFF(day, a, b)', 'DATEDIFF(`B`, `A`)'],
		['DATEDIFF(month, a, b)', '((YEAR(`B`) - YEAR(`A`)) * 12 + MONTH(`B`) - MONTH(`A`))'],
		['DATEDIFF(year, a, b)', '(YEAR(`B`) - YEAR(`A`))'],
		['DATEDIFF(hour, a, b)', '(DATEDIFF(`B`, `A`) * 24 + HOUR(`B`) - HOUR(`A`))'],
		['DATE_PART(YEAR, d)', 'YEAR(`D`)'],
		['DATE_PART(dayofyear, d)', 'DAYOFYEAR(`D`)'],
		['EXTRACT(month FROM d)', 'MONTH(`D`)'],
		["DATE_TRUNC('MONTH', d)", "DATE_TRUNC('MONTH', `D`)"],
		["TRUNC(d, 'MM')", "DATE_TRUNC('MONTH', `D`)"],
		['TRUNC(x, 2)', 'TRUNCATE(`X`, 2)'],
		['TRUNC(x)', 'TRUNCATE(`X`, 0)'],
		['LAST_DAY(d)', 'LAST_DAY(`D`)'],
		['DAYNAME(d)', "DATE_FORMAT(`D`, '%a')"],
		['MONTHNAME(d)', "DATE_FORMAT(`D`, '%b')"],
		['CURRENT_DATE', 'CURRENT_DATE()'],
		['CURRENT_TIMESTAMP()', 'CURRENT_TIMESTAMP()'],
		['GETDATE()', 'CURRENT_TIMESTAMP()'],
		['LEN(s)', 'CHAR_LENGTH(`S`)'],
		['SUBSTR(s, 2, 3)', 'SUBSTRING(`S`, 2, 3)'],
		["REPLACE(s, 'a')", "REPLACE(`S`, 'a', '')"],
		["CHARINDEX('x', s)", "INSTR(`S`, 'x')"],
		["CONTAINS(s, 'x')", "INSTR(`S`, 'x') > 0"],
		["STARTSWITH(s, 'x')", "STR_STARTS_WITH(`S`, 'x')"],
		['CEILING(x)', 'CEIL(`X`)'],
		['DIV0(a, b)', 'CASE WHEN `B` = 0 THEN 0 ELSE `A` / `B` END'],
		['GREATEST(a, b)', 'CASE WHEN `A` IS NULL OR `B` IS NULL THEN NULL WHEN `A` >= `B` THEN `A` ELSE `B` END'],
		["s ILIKE '%x%'", "`S` ILIKE '%x%'"],
		["s NOT LIKE 'a%'", "`S` NOT LIKE 'a%'"],
		['a IS DISTINCT FROM b', '(CASE WHEN `A` = `B` OR (`A` IS NULL AND `B` IS NULL) THEN 1 ELSE 0 END) = 0'],
		['flag IS NOT TRUE', '(CASE WHEN `FLAG` THEN 1 ELSE 0 END) = 0'],
		['TRUE', '(1 = 1)'],
		["x IN ('a', 'b')", "`X` IN ('a', 'b')"],
		['x BETWEEN 1 AND 5', '`X` BETWEEN 1 AND 5'],
		["DATE '2024-01-01'", "DATE('2024-01-01')"],
		["CASE WHEN a = 1 THEN 'x' WHEN a = 2 THEN 'y' END", "CASE WHEN `A` = 1 THEN 'x' WHEN `A` = 2 THEN 'y' END"],
		["CASE a WHEN 1 THEN 'x' ELSE 'z' END", "CASE `A` WHEN 1 THEN 'x' ELSE 'z' END"],
		['"Order Date" > d', '`Order Date` > `D`'],
		["'it''s'", "'it''s'"],
		["'a\\nb'", "'a\nb'"]
	];
	for (const [sql, want] of cases) assert.equal(f(sql), want, sql);
});

test('aggregates translate only where the caller allows them', () => {
	assert.throws(() => f('SUM(x)'), /aggregate/);
	const agg = (sql) => f(sql, { aggregates: true });
	assert.equal(agg('SUM(x)'), 'SUM(`X`)');
	assert.equal(agg('COUNT(*)'), 'COUNT(*)');
	assert.equal(agg('COUNT(DISTINCT x)'), 'COUNT(DISTINCT `X`)');
	assert.equal(agg('COUNT_IF(x > 1)'), 'SUM(CASE WHEN `X` > 1 THEN 1 ELSE 0 END)');
	assert.equal(agg("LISTAGG(x, ',')"), "LISTAGG(`X`, ',')");
	assert.throws(() => agg("LISTAGG(DISTINCT x, ',')"), /DISTINCT/);
	assert.equal(agg('MAX(DISTINCT x)'), 'MAX(`X`)');
	assert.throws(() => agg('SUM(DISTINCT x)'), /DISTINCT/);
});

test('session variables are substituted', () => {
	const variables = new Map([['CUTOFF', parseExpr("'2024-01-01'")]]);
	assert.equal(f('d >= $cutoff', { variables }), "`D` >= '2024-01-01'");
	assert.throws(() => f('d >= $missing', { variables }), /never SETs/);
});

test('untranslatable expressions name the construct', () => {
	assert.throws(() => f('REGEXP_LIKE(s, \'a.*\')'), /regular-expression/);
	assert.throws(() => f('MY_UDF(x)'), /MY_UDF/);
	assert.throws(() => f('db.fn(x)'), /user-defined/);
	assert.throws(() => f("TO_CHAR(n, '999.99')"), /formats a number/);
	assert.throws(() => f('SPLIT_PART(s, \',\', -1)'), /from the end/);
	assert.throws(() => f('ROW_NUMBER() OVER (ORDER BY x)'), (err) => err.fallback === true);
	assert.throws(() => f('x IN (SELECT y FROM t)'), (err) => err.fallback === true);
	assert.throws(() => f("MONTHS_BETWEEN(a, b)"), /MONTHS_BETWEEN/);
});

test('engine-specific day of week', () => {
	assert.equal(f('DAYOFWEEK(d)'), '(DAYOFWEEK(`D`) - 1)');
	assert.equal(f('DAYOFWEEK(d)', { engine: 'adr' }), 'DAYOFWEEK(`D`)');
	assert.equal(f('DAYOFWEEKISO(d)'), '(WEEKDAY(`D`) + 1)');
	assert.equal(f("DATE_TRUNC('week', d)"), "DATE_TRUNC('ISOWEEK', `D`)");
	assert.equal(f("DATE_TRUNC('week', d)", { engine: 'adr' }), "DATE_TRUNC('WEEK', `D`)");
	assert.equal(f('DATEDIFF(week, a, b)', { engine: 'adr' }), "(DATEDIFF(DATE_TRUNC('WEEK', `B`), DATE_TRUNC('WEEK', `A`)) / 7)");
});

test('TRY_ casts can use patterns for engines without TRY_CAST', () => {
	const text = toMagic(parseExpr('TRY_TO_NUMBER(x)'), { column: () => '`X`', tryCastPatterns: true });
	assert.match(text, /^ROUND\(CASE WHEN REGEXP_REPLACE\(TRIM\(CAST\(`X` AS STRING\)\)/);
});

test('a condition used as a value becomes a NULL-preserving CASE', () => {
	const text = toMagicValue(parseExpr('a > 1'), { column: (c) => `\`${c.parts[0].name}\`` });
	assert.equal(text, "CASE WHEN `a` > 1 THEN 'true' WHEN NOT (`a` > 1) THEN 'false' END");
	assert.equal(toMagicValue(parseExpr('FALSE'), { column: () => '' }), "CASE WHEN (1 = 0) THEN 'true' WHEN NOT ((1 = 0)) THEN 'false' END");
});

test('Magic ETL formulas translate back to Snowflake', () => {
	const cases = [
		['IFNULL(`a`, 0)', 'IFNULL("a", 0)'],
		['DATE_ADD(`Order Date`, INTERVAL 3 MONTH)', 'DATEADD(MONTH, 3, "Order Date")'],
		['DATE_SUB(`D`, INTERVAL `N` DAY)', 'DATEADD(DAY, -(N), D)'],
		['DATEDIFF(`A`, `B`)', 'DATEDIFF(DAY, B, A)'],
		['CAST(`A` AS STRING)', 'CAST(A AS VARCHAR)'],
		['CAST(`A` AS LONG)', 'CAST(A AS NUMBER(38,0))'],
		["DATE_FORMAT(`D`, '%Y-%m')", "TO_CHAR(D, 'YYYY-MM')"],
		["DATE_TRUNC('ISOWEEK', `D`)", "DATE_TRUNC('WEEK', D)"],
		["STR_CONTAINS(`S`, 'x')", "CONTAINS(S, 'x')"],
		['INSTR(`S`, `T`)', 'POSITION(T, S)'],
		['DAYOFWEEK(`D`)', '(DAYOFWEEK(D) + 1)'],
		['TRUNCATE(`X`, 2)', 'TRUNC(X, 2)'],
		['COUNT(DISTINCT `X`)', 'COUNT(DISTINCT X)'],
		["`S` ILIKE 'a%'", "S ILIKE 'a%'"],
		['CASE WHEN `A` > 1 THEN TRUE ELSE FALSE END', 'CASE WHEN A > 1 THEN TRUE ELSE FALSE END']
	];
	for (const [formula, want] of cases) assert.equal(formulaToSnowflake(formula), want, formula);
});

test('round trip Snowflake -> Magic -> Snowflake keeps meaning for common expressions', () => {
	const exprs = ["IFF(a > 1, 'x', 'y')", 'DATEADD(month, 1, d)', "NVL(TO_VARCHAR(n), '')", "DATE_TRUNC('MONTH', d)", 'ROUND(a / b, 2)'];
	for (const e of exprs) {
		const back = formulaToSnowflake(f(e));
		assert.doesNotThrow(() => parseExpr(back), back);
	}
	assert.equal(formulaToSnowflake(f('DATEADD(month, 1, d)')), 'DATEADD(MONTH, 1, D)');
});

test('date formats convert both ways', () => {
	assert.equal(snowflakeFormatToMagic('YYYY-MM-DD HH24:MI:SS'), '%Y-%m-%d %H:%i:%S');
	assert.equal(snowflakeFormatToMagic('MON DD, YYYY'), '%b %d, %Y');
	assert.equal(snowflakeFormatToMagic('"Q"Q YYYY'), undefined);
	assert.equal(magicFormatToSnowflake('%Y-%m-%d'), 'YYYY-MM-DD');
	assert.equal(magicFormatToSnowflake('%Q'), undefined);
});

test('magicType maps Snowflake types', () => {
	assert.equal(magicType({ name: 'VARCHAR', args: ['10'] }), 'STRING');
	assert.equal(magicType({ name: 'NUMBER', args: ['38', '0'] }), 'LONG');
	assert.equal(magicType({ name: 'NUMBER', args: ['10', '2'] }), 'DECIMAL');
	assert.equal(magicType({ name: 'TIMESTAMP_LTZ', args: [] }), 'DATETIME');
	assert.equal(magicType({ name: 'VARIANT', args: [] }), undefined);
});
