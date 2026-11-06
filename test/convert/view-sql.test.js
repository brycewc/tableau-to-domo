import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasDerivedTables, inlineCtes, matchColumnCase, projectionNames, rewriteCollate, rewriteDateAdd, rewriteToVarchar, rewriteUnpivot, stripComments, rewriteDateDiff, aliasUnionBranches, anchorConstantUnionColumns, castUnionColumn, castUnionNulls, expandStarsOverUnions, matchColumnCaseFully } from '../../src/convert/view-sql.js';

test('stripComments drops line and block comments but not quoted text', () => {
	assert.equal(stripComments("SELECT a -- x\n, '--b' /* c */ FROM t"), "SELECT a \n, '--b'   FROM t");
});

test('inlineCtes turns CTEs into derived tables, earlier ones inside later ones', () => {
	const { sql, inlined } = inlineCtes('WITH b AS (SELECT * FROM `t1`), f AS (SELECT x FROM b) SELECT f.x FROM f JOIN b ON f.x = b.x WHERE 1 = 1');
	assert.deepEqual(inlined, ['b', 'f']);
	assert.equal(sql, 'SELECT f.x FROM (SELECT x FROM (SELECT * FROM `t1`) b) f JOIN (SELECT * FROM `t1`) b ON f.x = b.x WHERE 1 = 1');
	assert.equal(inlineCtes('WITH b AS (SELECT 1 AS x) SELECT a,\n x FROM b UNPIVOT (v FOR n IN (x))').sql, 'SELECT a,\n x FROM (SELECT 1 AS x) b UNPIVOT (v FOR n IN (x))');
	assert.equal(inlineCtes('WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r').inlined.length, 0);
});

test('rewriteUnpivot emulates UNPIVOT with a CROSS JOIN, uppercasing unquoted names', () => {
	const { sql, rewrites } = rewriteUnpivot('SELECT k, n, v FROM (SELECT k, a, "b_x" FROM `t1`) src UNPIVOT (v FOR n IN (a, "b_x")) u');
	assert.equal(rewrites, 1);
	assert.equal(
		sql,
		`SELECT k, n, v FROM (SELECT * FROM (SELECT src.k, __unpivot_names.n, CASE __unpivot_names.n WHEN 'A' THEN src.a WHEN 'b_x' THEN src."b_x" END AS v FROM (SELECT k, a, "b_x" FROM \`t1\`) src CROSS JOIN (SELECT 'A' AS n UNION ALL SELECT 'b_x' AS n) __unpivot_names) __unpivot WHERE v IS NOT NULL) u`
	);
});

test('rewriteUnpivot keeps every source column when the block selects *', () => {
	assert.match(rewriteUnpivot('SELECT * FROM `t1` s UNPIVOT (v FOR n IN (a, b))').sql, /SELECT s\.\*, __unpivot_names\.n/);
	assert.match(rewriteUnpivot('SELECT REPLACE(n, \'x\', \'\') AS m, s.k FROM `t1` s UNPIVOT (v FOR n IN (a)) WHERE s.j > 0').sql, /SELECT s\.k, s\.j, __unpivot_names\.n/);
});

test('matchColumnCase writes references to derived-table columns as the table defines them, leaving table columns alone', () => {
	const sql = 'SELECT s.instance_id__C AS SFAccountId, product, ACCOUNT_NUMBER FROM (SELECT SHAREFILE_INSTANCE_ID AS Instance_id__c, PRODUCT_NAME AS Product, account_number AS ACCOUNT_NUMBER FROM `t5`)s LEFT JOIN (SELECT ACCOUNT_ID AS Id FROM `t6`) a ON s.instance_id__c = a.id';
	const { sql: out, fixed } = matchColumnCase(sql);
	assert.equal(out, 'SELECT s.Instance_id__c AS SFAccountId, Product, ACCOUNT_NUMBER FROM (SELECT SHAREFILE_INSTANCE_ID AS Instance_id__c, PRODUCT_NAME AS Product, account_number AS ACCOUNT_NUMBER FROM `t5`)s LEFT JOIN (SELECT ACCOUNT_ID AS Id FROM `t6`) a ON s.Instance_id__c = a.Id');
	assert.deepEqual(fixed.sort(), ['id -> Id', 'instance_id__C -> Instance_id__c', 'instance_id__c -> Instance_id__c', 'product -> Product']);
	assert.equal(matchColumnCase('SELECT x, a.y FROM `t1` a JOIN (SELECT X, Y FROM `t2`) b ON a.k = b.k').sql, 'SELECT X, a.y FROM `t1` a JOIN (SELECT X, Y FROM `t2`) b ON a.k = b.k', 'an unqualified name only one derived table defines is that table\'s, or Snowflake would call it ambiguous');
});

test('projectionNames reads output names as written, through SELECT * over one derived table', () => {
	assert.deepEqual(projectionNames('select distinct acc.ID as AccountID, case when x then 0 else u.E end AS ShareFile_E, "T"."Q", count(*) from `t1` acc'), ['AccountID', 'ShareFile_E', 'Q', undefined]);
	assert.deepEqual(projectionNames('select * from (select a.Foo, b AS Bar from `t1` a) vf where rown = 1'), ['Foo', 'Bar']);
	assert.equal(projectionNames('select * from `t1` a join `t2` b on a.x = b.x'), undefined);
});

test('rewriteDateAdd turns Snowflake DATEADD into DATE_ADD with an INTERVAL', () => {
	const sql = `SELECT DATEADD(hour, -8, oi.PROVISIONING_DATE) AS a, dateadd('day', x + 1, DATEADD(mm, 1, "T"."D")) AS b, 'DATEADD(day, 1, x)' AS c, DATEADD(nanosecond, 1, y) AS d
FROM \`t1\` oi LEFT JOIN \`t4\` dd ON CAST(TIMESTAMPADD(hours, -8, oi.P) AS DATE) = dd.CALENDAR_DATE`;
	const out = rewriteDateAdd(sql);
	assert.equal(
		out.sql,
		`SELECT DATE_ADD(oi.PROVISIONING_DATE, INTERVAL -8 HOUR) AS a, DATE_ADD(DATE_ADD("T"."D", INTERVAL 1 MONTH), INTERVAL (x + 1) DAY) AS b, 'DATEADD(day, 1, x)' AS c, DATEADD(nanosecond, 1, y) AS d
FROM \`t1\` oi LEFT JOIN \`t4\` dd ON CAST(DATE_ADD(oi.P, INTERVAL -8 HOUR) AS DATE) = dd.CALENDAR_DATE`
	);
	assert.equal(out.rewrites, 4);
	assert.deepEqual(out.skipped, ['DATEADD(nanosecond, 1, y)']);
});

test('rewriteCollate turns Snowflake COLLATE() into SQL the view parser accepts', () => {
	const sql = `SELECT collate("T"."PRODUCT_LINE", 'en-ci') AS "Product_Line", COLLATE("T"."X", 'en-cs') AS "X"
FROM \`t1\` "T"
WHERE collate("T"."TRANSACTIONTYPE",'en-ci') = 'Evergreen' AND COLLATE("T"."G", 'en-ci') IN ('A', 'b') AND 'Ab' <> COLLATE(T.C, 'en-ci-pi') AND "T"."N" = 'collate(x, ''en-ci'')'`;
	const { sql: out, rewrites } = rewriteCollate(sql);
	assert.equal(
		out,
		`SELECT "T"."PRODUCT_LINE" AS "Product_Line", "T"."X" AS "X"
FROM \`t1\` "T"
WHERE LOWER("T"."TRANSACTIONTYPE") = LOWER('Evergreen') AND LOWER("T"."G") IN (LOWER('A'), LOWER('b')) AND LOWER('Ab') <> LOWER(T.C) AND "T"."N" = 'collate(x, ''en-ci'')'`
	);
	assert.deepEqual(rewrites.map((r) => r.compared), [false, false, true, true, true]);
	assert.deepEqual(rewriteCollate('SELECT 1').rewrites, []);
});

test('aliasDerivedTables names a FROM subquery that has no alias; rewriteToVarchar casts one-argument TO_VARCHAR', () => {
	assert.equal(aliasDerivedTables('select * from (select a from `t1`) where x = 1 union select * from (select b from `t2`) b').sql, 'select * from (select a from `t1`) t2d_derived_1 where x = 1 union select * from (select b from `t2`) b');
	assert.equal(rewriteToVarchar("select TO_VARCHAR(dd.FY) || ' Q' || to_char(q), TO_VARCHAR(d, 'YYYY') from t").sql, "select CAST(dd.FY AS VARCHAR) || ' Q' || CAST(q AS VARCHAR), TO_VARCHAR(d, 'YYYY') from t");
});

test('matchColumnCase leaves a table alias alone when another table has a column of that name', () => {
	const sql = 'SELECT arr.*, a.Id FROM (SELECT x FROM `t1`) arr LEFT JOIN (SELECT ARR, Id FROM `t2`) a ON arr.x = a.Id';
	assert.equal(matchColumnCase(sql).sql, sql);
});

test('DATEDIFF with a part becomes the two-argument form or date-part arithmetic', () => {
	const out = rewriteDateDiff("SELECT DATEDIFF(DAY, a.CreatedDate, a.CloseDate) AS d, DATEDIFF('month', x, COALESCE(y, z)) AS m, DATEDIFF(year, x, y) AS yy, DATEDIFF(minute, x, y) AS mi FROM t");
	assert.equal(out.sql, "SELECT DATEDIFF(a.CloseDate, a.CreatedDate) AS d, ((YEAR(COALESCE(y, z)) - YEAR(x)) * 12 + MONTH(COALESCE(y, z)) - MONTH(x)) AS m, (YEAR(y) - YEAR(x)) AS yy, DATEDIFF(minute, x, y) AS mi FROM t");
	assert.equal(out.rewrites, 3);
	assert.deepEqual(out.skipped, ['DATEDIFF(minute, x, y)']);
	assert.equal(rewriteDateDiff('SELECT DATEDIFF(DAY, DATEDIFF(DAY, a, b), c) FROM t').sql, 'SELECT DATEDIFF(c, DATEDIFF(b, a)) FROM t');
});

test('later UNION branches take the first branch column names', () => {
	const out = aliasUnionBranches('SELECT * FROM (SELECT Data, NULL AS TYPE, ACCOUNTNAME, "Geo" FROM `t1` UNION ALL SELECT Data, NULL, ACCOUNT_NAME, g.GEOGRAPHY AS geo FROM `t2` g) u');
	assert.equal(out.sql, 'SELECT * FROM (SELECT Data, NULL AS TYPE, ACCOUNTNAME, "Geo" FROM `t1` UNION ALL SELECT Data, NULL AS TYPE, ACCOUNT_NAME AS ACCOUNTNAME, g.GEOGRAPHY AS "Geo" FROM `t2` g) u');
	assert.equal(out.aliased, 3);
	assert.equal(aliasUnionBranches('SELECT a FROM t UNION SELECT a FROM s UNION SELECT CAST(b AS VARCHAR) FROM r').sql, 'SELECT a FROM t UNION SELECT a FROM s UNION SELECT CAST(b AS VARCHAR) AS a FROM r');
	assert.equal(aliasUnionBranches('SELECT a, b FROM t').aliased, 0);
});

test('a column whose type differs between UNION branches is cast in every branch', () => {
	const out = castUnionColumn('SELECT * FROM (SELECT a, FQ FROM t UNION ALL SELECT a, x.q AS FQ FROM s x UNION ALL SELECT a, 1.5 FROM r) u', 'FQ', 'DOUBLE');
	assert.equal(out.sql, 'SELECT * FROM (SELECT a, TRY_CAST(CAST(FQ AS VARCHAR) AS DOUBLE) AS FQ FROM t UNION ALL SELECT a, TRY_CAST(CAST(x.q AS VARCHAR) AS DOUBLE) AS FQ FROM s x UNION ALL SELECT a, TRY_CAST(CAST(1.5 AS VARCHAR) AS DOUBLE) AS FQ FROM r) u');
	assert.equal(out.cast, 3);
	assert.equal(castUnionColumn(out.sql, 'FQ', 'DOUBLE').cast, 0);
	assert.equal(castUnionColumn('SELECT FQ FROM t', 'FQ', 'DOUBLE').cast, 0);
});

test('bare NULL UNION items take their column type, since Domo types them as text', () => {
	const types = new Map([['start_date', 'TIMESTAMP'], ['fq', 'DOUBLE'], ['name', 'VARCHAR']]);
	const out = castUnionNulls('SELECT "start_date" AS Start_Date, FQ, Name FROM t UNION ALL SELECT NULL, NULL AS FQ, NULL FROM s', types);
	assert.equal(out.sql, 'SELECT "start_date" AS Start_Date, FQ, Name FROM t UNION ALL SELECT CAST(NULL AS TIMESTAMP) AS Start_Date, CAST(NULL AS DOUBLE) AS FQ, NULL FROM s');
	assert.equal(out.cast, 2);
});

test('a reference is matched to the case of a derived table column even when the table also selects an unknown *', () => {
	const sql = "SELECT Data, WS_Unbundle FROM ( SELECT a.*, 'No' AS WS_unbundle FROM ( SELECT * FROM `t1` ) a LEFT JOIN `t4` s ON a.id = s.id ) x";
	assert.equal(matchColumnCase(sql).sql, "SELECT Data, WS_unbundle FROM ( SELECT a.*, 'No' AS WS_unbundle FROM ( SELECT * FROM `t1` ) a LEFT JOIN `t4` s ON a.id = s.id ) x");
	assert.equal(projectionNames('SELECT a.*, b FROM `t1` a'), undefined);
});

test('a UNION column that is a constant in every branch is tied to a column of the first branch', () => {
	const out = anchorConstantUnionColumns("SELECT 'SF' AS DataSource, FYQ, 'No' AS ecomm, x.n FROM t x UNION ALL SELECT 'Coffee', FYQ, 'No', n FROM s");
	assert.equal(out.sql, "SELECT CASE WHEN FYQ IS NULL THEN 'SF' ELSE 'SF' END AS DataSource, FYQ, CASE WHEN FYQ IS NULL THEN 'No' ELSE 'No' END AS ecomm, x.n FROM t x UNION ALL SELECT 'Coffee', FYQ, 'No', n FROM s");
	assert.equal(out.anchored, 2);
	assert.equal(anchorConstantUnionColumns("SELECT 'a' AS k, v FROM t UNION ALL SELECT k, v FROM s").anchored, 0);
});

test('a star over a UNION derived table is written out, since Domo leaks names across branches when expanding it', () => {
	const sql = 'SELECT * FROM (SELECT "Source_Flag" AS X, y FROM `t1` UNION ALL SELECT b.X AS X, y FROM (SELECT a.* FROM (SELECT * FROM `t1`) a) b) u';
	const out = expandStarsOverUnions(sql);
	assert.equal(out.sql, 'SELECT u.X AS X, u.y AS y FROM (SELECT "Source_Flag" AS X, y FROM `t1` UNION ALL SELECT b.X AS X, y FROM (SELECT a.* FROM (SELECT * FROM `t1`) a) b) u');
	assert.equal(out.expanded, 1);
	assert.equal(expandStarsOverUnions('SELECT x.*, k.v FROM (SELECT a FROM t UNION ALL SELECT a FROM s) x JOIN `t2` k ON x.a = k.a').sql, 'SELECT x.a AS a, k.v FROM (SELECT a FROM t UNION ALL SELECT a FROM s) x JOIN `t2` k ON x.a = k.a');
	assert.equal(expandStarsOverUnions('SELECT * FROM (SELECT * FROM `t1`) a').expanded, 0);
});

test('case matching repeats until references to a column it renamed in the same pass agree', () => {
	const sql = "SELECT u.WS_Unbundle AS WS_Unbundle FROM (SELECT WS_Unbundle FROM (SELECT 'No' AS WS_unbundle FROM `t1`) b) u";
	assert.equal(matchColumnCaseFully(sql).sql, "SELECT u.WS_unbundle AS WS_unbundle FROM (SELECT WS_unbundle FROM (SELECT 'No' AS WS_unbundle FROM `t1`) b) u");
});
