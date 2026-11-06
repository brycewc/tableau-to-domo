import test from 'node:test';
import assert from 'node:assert/strict';
import { splitScript, tokenize } from '../../src/magic/lexer.js';
import { canonical, hasAggregate, hasWindow, parseExpr, parseQuery, parseScript } from '../../src/magic/parser.js';

test('tokenize reads Snowflake strings, $$ strings, quoted names, variables and comments', () => {
	const t = tokenize("select 'it''s', 'a\\nb', $$raw 'x'$$, \"Order Date\", $var -- note\n /* block */ x::date");
	assert.deepEqual(
		t.map((x) => [x.t, x.v]),
		[
			['word', 'select'],
			['str', "it's"],
			['op', ','],
			['str', 'a\nb'],
			['op', ','],
			['str', "raw 'x'"],
			['op', ','],
			['qid', 'Order Date'],
			['op', ','],
			['var', 'var'],
			['word', 'x'],
			['op', '::'],
			['word', 'date']
		]
	);
});

test('formula tokens keep backslashes literally', () => {
	assert.equal(tokenize("'a\\nb'", { backslashEscapes: false })[0].v, 'a\\nb');
});

test('splitScript splits only at top-level semicolons', () => {
	const parts = splitScript("use schema s; create temp table t as (select 1 as a; ); alter table t\n alter column a type varchar(5);");
	assert.equal(parts.length, 3);
	assert.match(parts[2].text, /^alter table t\s+alter column/);
});

test('a trailing comma ends the select list, as Snowflake allows', () => {
	const q = parseQuery('SELECT a, b AS "B", FROM t WHERE (SELECT MAX(x), FROM u) > 1');
	assert.deepEqual(q.body.items.map((i) => i.alias?.name ?? i.e.parts[0].name), ['a', 'B']);
	assert.ok(q.body.from);
	assert.throws(() => parseQuery('SELECT a,, FROM t'));
});

test('ALTER SESSION SET QUERY_TAG takes any value, including Tableau bracket placeholders', () => {
	const st = parseScript("ALTER SESSION SET QUERY_TAG = [WorkbookName][TableauApp]; ALTER SESSION SET QUERY_TAG = [A] x, TIMEZONE = 'UTC'");
	assert.deepEqual(st.map((s) => s.kind), ['session', 'session']);
	assert.deepEqual(st[1].options.map((o) => o.option), ['QUERY_TAG', 'TIMEZONE']);
});

test('parseScript classifies statements', () => {
	const st = parseScript(`
		USE DATABASE SF_EDH; USE SCHEMA EDH;
		ALTER SESSION SET TIMEZONE = 'UTC';
		ALTER USER SET ODBC_QUERY_RESULT_FORMAT='JSON';
		SET cutoff = '2024-01-01';
		DROP TABLE IF EXISTS cal1;
		CREATE OR REPLACE TEMPORARY TABLE cal1 AS SELECT 1 AS a FROM x;
		CREATE TABLE t2 (a INT, b VARCHAR(10), PRIMARY KEY (a));
		INSERT INTO t2 (a, b) VALUES (1, 'x'), (2, 'y');
		INSERT INTO t2 SELECT a, 'z' FROM cal1;
		UPDATE t2 x SET b = s.b, a = 3 FROM src s WHERE x.a = s.a;
		DELETE FROM t2 USING src WHERE t2.a = src.a;
		MERGE INTO t2 USING src s ON t2.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b WHEN NOT MATCHED THEN INSERT (a, b) VALUES (s.a, s.b);
		TRUNCATE TABLE t2;
		ALTER TABLE t2 ALTER COLUMN b TYPE VARCHAR(50);
		ALTER TABLE t2 ADD COLUMN c NUMBER(10,2);
		CALL proc();
	`);
	assert.deepEqual(
		st.map((s) => s.kind),
		['use', 'use', 'session', 'ignored', 'set', 'drop', 'create', 'create', 'insert', 'insert', 'update', 'delete', 'merge', 'truncate', 'alter-table', 'alter-table', 'unknown']
	);
	const create = st[6];
	assert.equal(create.temp, true);
	assert.equal(create.replace, true);
	assert.deepEqual(st[7].columns.map((c) => [c.name.name, c.type.name]), [['a', 'INT'], ['b', 'VARCHAR']]);
	assert.equal(st[8].values.length, 2);
	assert.equal(st[10].alias.name, 'x');
	assert.equal(st[10].sets.length, 2);
	assert.equal(st[13].kind, 'truncate');
	assert.deepEqual(st[14].changes.map((c) => c.type.name), ['VARCHAR']);
});

test('parse errors become error statements with the reason', () => {
	const [st] = parseScript('SELECT a FROM t WHERE');
	assert.equal(st.kind, 'error');
	assert.match(st.reason, /unexpected end/);
});

test('parseQuery handles CTEs, joins, set operations, QUALIFY, LIMIT', () => {
	const q = parseQuery(`
		WITH a AS (SELECT x, y FROM t1), b (k) AS (SELECT k FROM t2)
		SELECT DISTINCT a.x, b.k AS kk, COUNT(*) n
		FROM a LEFT OUTER JOIN b ON a.x = b.k AND b.k > 0, t3
		WHERE a.y IN (SELECT y FROM t4) AND NOT EXISTS (SELECT 1 FROM t5 WHERE t5.y = a.y)
		GROUP BY 1, 2 HAVING COUNT(*) > 1 QUALIFY ROW_NUMBER() OVER (PARTITION BY a.x ORDER BY kk DESC NULLS LAST) = 1
		UNION ALL SELECT 1, 2, 3
		ORDER BY 1 LIMIT 10 OFFSET 5
	`);
	assert.equal(q.with.length, 2);
	assert.deepEqual(q.with[1].columns.map((c) => c.name), ['k']);
	assert.equal(q.body.k, 'setop');
	assert.equal(q.body.all, true);
	const sel = q.body.l;
	assert.equal(sel.distinct, true);
	assert.equal(sel.from.k, 'join');
	assert.equal(sel.from.comma, true);
	assert.equal(sel.from.l.type, 'LEFT');
	assert.equal(sel.where.l.k, 'in');
	assert.equal(sel.where.r.k, 'unary');
	assert.equal(sel.qualify.l.over.order[0].nulls, 'LAST');
	assert.equal(q.limit.v, '10');
	assert.equal(q.offset.v, '5');
});

test('select items take aliases with and without AS, and SELECT * EXCLUDE', () => {
	const q = parseQuery('select NULL SF_G, "x" as "Y", t.* , * exclude (a, b), 1 interval from t');
	const items = q.body.items;
	assert.equal(items[0].alias.name, 'SF_G');
	assert.equal(items[1].alias.quoted, true);
	assert.equal(items[2].e.k, 'star');
	assert.deepEqual(items[3].e.exclude.map((x) => x.name), ['a', 'b']);
	assert.equal(items[4].alias.name, 'interval');
});

test('a column named like a keyword still parses', () => {
	const q = parseQuery('select interval, "year", month from t');
	assert.deepEqual(q.body.items.map((i) => i.e.k), ['col', 'col', 'col']);
});

test('PIVOT and UNPIVOT parse', () => {
	const p = parseQuery("select * from s pivot (sum(v) for k in ('a', 'b')) as p");
	assert.equal(p.body.from.k, 'pivot');
	assert.equal(p.body.from.values.length, 2);
	const u = parseQuery('select * from s unpivot include nulls (val for name in (a, b))');
	assert.equal(u.body.from.k, 'unpivot');
	assert.equal(u.body.from.includeNulls, true);
});

test('expression precedence, casts, CASE, windows and IS DISTINCT FROM', () => {
	const e = parseExpr("a + b * 2 > 3 AND NOT c OR d::date IS NOT DISTINCT FROM e");
	assert.equal(e.k, 'bin');
	assert.equal(e.op, 'OR');
	assert.equal(e.l.op, 'AND');
	assert.equal(e.l.l.l.op, '+');
	assert.equal(e.r.k, 'isdistinct');
	assert.equal(e.r.l.k, 'cast');
	const w = parseExpr('SUM(x) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
	assert.equal(w.over.frame.unit, 'ROWS');
	assert.equal(w.over.frame.start.kind, 'UNBOUNDED');
	assert.equal(hasWindow(w), true);
	assert.equal(hasAggregate(w), false);
	assert.equal(hasAggregate(parseExpr('1 + SUM(x)')), true);
	const ex = parseExpr('EXTRACT(year FROM d)');
	assert.equal(ex.name, 'DATE_PART');
	const lg = parseExpr('LISTAGG(x, \',\') WITHIN GROUP (ORDER BY x)');
	assert.equal(lg.within.length, 1);
});

test('formula mode reads backticks and INTERVAL expressions', () => {
	const e = parseExpr('DATE_ADD(`Order Date`, INTERVAL `n` + 1 MONTH)', { formula: true });
	assert.equal(e.args[0].parts[0].name, 'Order Date');
	assert.equal(e.args[1].k, 'interval');
	assert.equal(e.args[1].unit, 'MONTH');
});

test('unsupported syntax names itself', () => {
	assert.throws(() => parseQuery('select v:a.b from t'), /semi-structured/);
	assert.throws(() => parseQuery('select * from table(flatten(x))'), /table function/);
	assert.throws(() => parseQuery('select * from t, lateral flatten(x)'), /LATERAL/);
});

test('canonical folds unquoted names to upper case', () => {
	assert.equal(canonical({ name: 'abc', quoted: false }), 'ABC');
	assert.equal(canonical({ name: 'abc', quoted: true }), 'abc');
});

test('a bare USE reads two parts as a schema and one part as a database', () => {
	const [schema, database] = parseScript('use SF_EDH.EDH_ODS_READ; use CSG_DB;');
	assert.equal(schema.target, 'SCHEMA');
	assert.deepEqual(schema.parts.map((p) => p.name ?? p), ['SF_EDH', 'EDH_ODS_READ']);
	assert.equal(database.target, 'DATABASE');
});
