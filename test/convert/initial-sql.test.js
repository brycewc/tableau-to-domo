import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInitialSql, planInitialSql, splitStatements, initialSqlBlockedMessage, describeInitialSql, initialSqlOf, isSessionOnly } from '../../src/convert/initial-sql.js';
import { buildInitialSqlDataflow } from '../../src/convert/initial-sql-etl.js';
import { planDatasets } from '../../src/convert/datasets.js';
import { extractData } from '../../src/tableau/data/index.js';
import { choicesFor, completeDecision, describeDecision } from '../../src/pipeline/decisions.js';
import { promptDecisions } from '../../src/cli/decide.js';
import { PassThrough } from 'node:stream';
import { tempDir } from '../data/helpers.js';

const INITIAL_SQL = `DROP TABLE IF EXISTS #activeaccounts
select distinct acct_count, ACCT_FY, product
into #activeaccounts
from (
select sum(activecount) as acct_count, fiscal_year_num as ACCT_FY, 'PA' as product
from Usage.dbo.v_PA pa
group by fiscal_year_num
union
select max(acct_count) as acct_count, ACCT_FY, 'core' as product from [UsageMart].[ACCT].[AccountActivity] group by ACCT_FY
) a
--------------------
select  Name,Region,Email, ID, ManagerID
into #user
from support.dbo.d_user
where IsActive='true'
drop table if exists #escalationEmpCount
select * into #escalationEmpCount
from (select snapshot_date, count(employee_id) escalationEmpCount from Support.ops.Employee_headcount group by snapshot_date) final`;

const CASES_SQL = `SELECT DISTINCT
dca.CreatedDate,
dca.Id [Case_ID],
CASE WHEN dca.recordtype LIKE '%Customer Service%' THEN 'CS' ELSE 'TS' END AS [Case_Type],
usr.Name [Owner],
usr.Region,
mgr_usr.Name [Manager]
from Support.dbo.d_case dca
LEFT JOIN Support.dbo.f_case fca ON dca.case_dwk = fca.case_dwk
LEFT JOIN #user usr on dca.ownerID= usr.ID
left join #user mgr_usr on usr.ManagerID = mgr_usr.id
left join salesforce..[case] c on c.casenumber = dca.casenumber
WHERE (dca.case_team like '%Billing Team%') AND fca.fiscal_year_num >= 2022`;

const col = (name, type = 'string') => ({ remoteName: name, localName: `[${name}]`, localType: type });

function sampleDatasource() {
	return {
		id: 'ds1',
		caption: 'Support_Case',
		connections: [{ id: 'sql1', class: 'sqlserver', server: 'dw', dbname: 'Support', extra: { 'one-time-sql': INITIAL_SQL } }],
		tables: [
			{ id: 'cases', name: 'Cases Custom SQL Query', kind: 'custom-sql', connectionId: 'sql1', sql: CASES_SQL, columns: ['CreatedDate', 'Case_ID', 'Case_Type', 'Owner', 'Region', 'Manager'].map((n) => col(n)) },
			{ id: 'esc', name: 'EscalationEmpCount', kind: 'custom-sql', connectionId: 'sql1', sql: 'select * from #escalationEmpCount', columns: [col('snapshot_date', 'date'), col('escalationEmpCount', 'integer')] },
			{ id: 'au', name: 'Custom SQL Query1', kind: 'custom-sql', connectionId: 'sql1', sql: 'select * from #activeaccounts', columns: [col('acct_count', 'integer'), col('ACCT_FY', 'integer'), col('product')] }
		],
		relationships: [
			{ fromTableId: 'cases', toTableId: 'esc', on: [{ left: '[CreatedDate]', right: '[snapshot_date]' }] },
			{ fromTableId: 'cases', toTableId: 'au', on: [{ left: '[Case_ID]', right: '[ACCT_FY]' }] }
		],
		fields: []
	};
}

const plan = (sql, tables = [], opts = {}) => planInitialSql({ sql, tables, dialect: 'tsql', ...opts });
const etlOf = (p, id) => buildInitialSqlDataflow({ name: 'x', outputName: 'out', graph: p.tables.get(id).graph, streamKeys: new Map(p.streams.map((s) => [s.id, `k.${s.id}`])) }).definition.actions;

test('splitStatements: T-SQL without semicolons, CASE ... END, UNION, GO and semicolons', () => {
	const sql = `SET NOCOUNT ON
DROP TABLE IF EXISTS #a select CASE WHEN x = 1 THEN 'a' ELSE 'b' END AS y into #a from t
union all select 'c' from u
GO
insert into #a (y) select z from v; update #a set y = 'd' where y = 'a'`;
	const st = splitStatements(sql).map((s) => s.text.split(/\s+/)[0].toUpperCase());
	assert.deepEqual(st, ['SET', 'DROP', 'SELECT', 'INSERT', 'UPDATE']);
	assert.match(splitStatements(sql)[2].text, /union all select 'c' from u$/);
});

test('parseInitialSql classifies the usual shapes, guarded drops and dead IF blocks', () => {
	const sql = `IF OBJECT_ID('tempdb..#t') IS NOT NULL DROP TABLE #t
DECLARE @fy INT = 2024
CREATE TABLE #t (a INT, b VARCHAR(10))
INSERT INTO #t (a, b) SELECT x, y FROM db.dbo.src WHERE fy = @fy
if 1=2 BEGIN select count(*) from #t select * from #t END
DELETE FROM #t WHERE b IS NULL`;
	const kinds = parseInitialSql(sql).items.map((i) => i.kind);
	assert.deepEqual(kinds, ['drop', 'variable', 'create', 'insert', 'dead', 'dead', 'dead', 'dead', 'dead', 'delete']);
});

test('a multi-statement Initial SQL: a stream per temp table, a stream for the database tables, Magic ETL for the join', () => {
	const ds = sampleDatasource();
	const p = plan(INITIAL_SQL, ds.tables);
	assert.equal(p.blocked, undefined);
	assert.deepEqual(p.streams.map((s) => s.id).sort(), ['activeaccounts', 'cases-custom-sql-query-database-tables', 'escalationempcount', 'user']);
	assert.deepEqual(p.tables.get('esc'), { kind: 'stream', stream: 'escalationempcount' });
	assert.deepEqual(p.tables.get('au'), { kind: 'stream', stream: 'activeaccounts' });
	const user = p.streams.find((s) => s.id === 'user');
	assert.doesNotMatch(user.sql, /into/i, 'the INTO clause is removed');
	assert.match(user.sql, /from support\.dbo\.d_user\s+where IsActive='true'$/);
	const base = p.streams.find((s) => s.id === 'cases-custom-sql-query-database-tables').sql;
	assert.doesNotMatch(base, /#user|DISTINCT/, 'the temp joins and DISTINCT move to Magic ETL');
	assert.match(base, /\[dca\]\.\[ownerID\] AS \[_t2d_dca_ownerID\]/);
	assert.match(base, /left join salesforce\.\.\[case\] c ON c\.casenumber = dca\.casenumber/);
	assert.match(base, /WHERE \(\(dca\.case_team like '%Billing Team%'\)\)\nAND \(fca\.fiscal_year_num >= 2022\)/);

	const actions = etlOf(p, 'cases');
	assert.deepEqual(actions.map((a) => a.type), ['LoadFromVault', 'LoadFromVault', 'SelectValues', 'MergeJoin', 'SelectValues', 'MergeJoin', 'Metadata', 'Unique', 'PublishToVault']);
	const loads = actions.filter((a) => a.type === 'LoadFromVault');
	assert.equal(loads.length, 2, 'the #user stream is loaded once for both aliases');
	const [join1, join2] = actions.filter((a) => a.type === 'MergeJoin');
	assert.deepEqual([join1.joinType, join1.keys1, join1.keys2], ['LEFT OUTER', ['_t2d_dca_ownerID'], ['_t2d_usr_ID']]);
	assert.deepEqual([join2.keys1, join2.keys2], [['_t2d_usr_ManagerID'], ['_t2d_mgr_usr_ID']], 'mgr_usr.id takes the known column casing');
	const names = actions.find((a) => a.type === 'Metadata').fields;
	assert.deepEqual(names.filter((f) => f.rename).map((f) => `${f.name}>${f.rename}`), ['_t2d_usr_Name>Owner', '_t2d_usr_Region>Region', '_t2d_mgr_usr_Name>Manager']);
	assert.ok(names.some((f) => f.name === '_t2d_dca_ownerID' && f.remove));
	assert.match(p.notes.join(' '), /case-sensitively/);
	assert.match(describeInitialSql(p)[1], /^2\. select distinct acct_count.*temp table from one SELECT$/);
});

test('variables are substituted; CREATE TABLE plus several INSERT ... SELECT become one UNION ALL stream', () => {
	const sql = `DECLARE @fy INT = 2024
SET @fy = @fy - 1
CREATE TABLE #t (a INT, b VARCHAR(10))
INSERT INTO #t (b, a) SELECT name, id FROM db.dbo.one WHERE fy >= @fy
INSERT INTO #t SELECT id, name FROM db.dbo.two`;
	const p = plan(sql, [{ id: 't', kind: 'custom-sql', sql: 'SELECT * FROM #t' }]);
	assert.equal(p.streams.length, 1);
	const s = p.streams[0].sql;
	assert.match(s, /WHERE fy >= \(\(2024\) - 1\)/);
	assert.match(s, /SELECT t2d_rows\.\[a\] AS \[a\], t2d_rows\.\[b\] AS \[b\]\nFROM \(\nSELECT name, id FROM db\.dbo\.one/);
	assert.match(s, /\) AS t2d_rows \(\[b\], \[a\]\)\nUNION ALL\n/);
	assert.deepEqual(p.tables.get('t'), { kind: 'stream', stream: p.streams[0].id });
});

test('a variable set from a query is inlined as a scalar subquery', () => {
	const p = plan(`DECLARE @d DATE
SELECT @d = MAX(day_date) FROM db.dbo.cal WHERE closed = 1
SELECT * INTO #t FROM db.dbo.f WHERE day_date = @d`, [{ id: 't', kind: 'custom-sql', sql: 'select * from #t' }]);
	assert.match(p.streams[0].sql, /WHERE day_date = \(SELECT MAX\(day_date\) FROM db\.dbo\.cal WHERE closed = 1\)$/);
});

test('UPDATE and DELETE on a temp table become Magic ETL formula and filter tiles', () => {
	const sql = `SELECT id, week, fy INTO #a FROM db.dbo.cal
UPDATE #a SET week = week - 53 WHERE fy = 2022 AND week > 53
DELETE FROM #a WHERE name LIKE 'x%'`;
	const p = plan(sql, [{ id: 't', kind: 'custom-sql', sql: 'SELECT * FROM #a' }]);
	const actions = etlOf(p, 't');
	assert.deepEqual(actions.map((a) => a.type), ['LoadFromVault', 'ExpressionEvaluator', 'Metadata', 'Metadata', 'Filter', 'PublishToVault']);
	assert.equal(actions[1].expressions[0].expression, 'CASE WHEN `fy` = 2022 AND `week` > 53 THEN `week` - 53 ELSE `week` END');
	assert.deepEqual(actions[2].fields, [{ name: 'week', remove: true }]);
	assert.deepEqual(actions[3].fields, [{ name: '_t2d_update_2_1', rename: 'week' }]);
	assert.equal(actions[4].filterList[0].expression, "CASE WHEN `name` ILIKE 'x%' THEN 0 ELSE 1 END = 1", 'SQL Server LIKE ignores case');
});

test('GROUP BY over a temp table join becomes formula, Group By and rename tiles', () => {
	const sql = 'SELECT id, region INTO #r FROM db.dbo.reps';
	const query = `SELECT r.region AS Region, YEAR(o.order_date) AS Yr, SUM(o.amount) AS Amount, COUNT(DISTINCT o.id) AS Orders
FROM db.dbo.orders o JOIN #r r ON r.id = o.rep_id
WHERE r.region <> 'X'
GROUP BY r.region, YEAR(o.order_date)
HAVING SUM(o.amount) > 10`;
	const p = plan(sql, [{ id: 'q', kind: 'custom-sql', sql: query }]);
	assert.equal(p.blocked, undefined, p.blocked?.reason);
	const base = p.streams.find((s) => !s.temp).sql;
	assert.match(base, /\[o\]\.\[rep_id\] AS \[_t2d_o_rep_id\]/);
	assert.match(base, /\[o\]\.\[order_date\] AS \[_t2d_o_order_date\]/);
	const actions = etlOf(p, 'q');
	assert.deepEqual(actions.map((a) => a.type), ['LoadFromVault', 'LoadFromVault', 'SelectValues', 'MergeJoin', 'Filter', 'ExpressionEvaluator', 'GroupBy', 'Filter', 'Metadata', 'Metadata', 'PublishToVault']);
	const join = actions.find((a) => a.type === 'MergeJoin');
	assert.equal(join.joinType, 'INNER');
	assert.equal(actions[4].filterList[0].expression, "`_t2d_r_region` != 'X'");
	assert.deepEqual(actions[5].expressions, [{ fieldName: '_t2d_group_2', expression: 'YEAR(`_t2d_o_order_date`)' }]);
	const group = actions.find((a) => a.type === 'GroupBy');
	assert.deepEqual(group.groups, [{ name: '_t2d_r_region' }, { name: '_t2d_group_2' }]);
	assert.deepEqual(group.fields.map((f) => f.expression), ['SUM(`_t2d_o_amount`)', 'COUNT(DISTINCT `_t2d_o_id`)', 'SUM(`_t2d_o_amount`)']);
	assert.equal(actions[7].filterList[0].expression, '`_t2d_having_1` > 10');
	assert.deepEqual(actions[9].fields.filter((f) => f.rename), [{ name: '_t2d_r_region', rename: 'Region' }, { name: '_t2d_group_2', rename: 'Yr' }]);
});

test('a UNION of a temp table and a database query appends rows with the first branch names', () => {
	const p = plan('SELECT id, amt INTO #t FROM db.dbo.a', [{ id: 'u', kind: 'custom-sql', sql: 'SELECT id, amt FROM #t UNION SELECT oid AS id, total AS amount FROM db.dbo.b' }]);
	const actions = etlOf(p, 'u');
	assert.deepEqual(actions.map((a) => a.type), ['LoadFromVault', 'SelectValues', 'LoadFromVault', 'Metadata', 'UnionAll', 'Unique', 'PublishToVault']);
	assert.deepEqual(actions[1].fields, [{ name: 'id' }, { name: 'amt' }], 'a plain column list over one temp table is one Select Columns tile');
	assert.deepEqual(actions[3].fields, [{ name: 'amount', rename: 'amt' }]);
});

test('Snowflake temp tables, USE and session settings', () => {
	const sql = `ALTER SESSION SET TIMEZONE = 'UTC'; USE DATABASE ANALYTICS; USE SCHEMA CORE;
DROP TABLE IF EXISTS ANALYTICS.CORE.CAL;
create temp table cal as( select calendar_date, fiscal_year_num from dim_calendar );`;
	const p = planInitialSql({ sql, tables: [{ id: 't', kind: 'custom-sql', sql: 'select * from cal' }], dialect: 'ansi', engine: 'snowflake' });
	assert.equal(p.blocked, undefined, p.blocked?.reason);
	assert.deepEqual(p.session, { dbname: 'ANALYTICS', schema: 'CORE' });
	assert.equal(p.streams[0].sql, 'select calendar_date, fiscal_year_num from dim_calendar');
	assert.match(p.notes.join(' '), /TIMEZONE, which the connector session does not apply/);
});

test('untranslatable statements block with the statement and the reason', () => {
	const cases = [
		['DECLARE @i INT = 0\nWHILE @i < 3 BEGIN SET @i = @i + 1 END', 2, /WHILE loop/],
		['DECLARE c CURSOR FOR SELECT id FROM t', 1, /cursor/],
		["EXEC('SELECT 1')", 1, /dynamic SQL/],
		['SELECT a INTO #t FROM x\nUPDATE t SET a = 1 FROM #t t JOIN y ON y.id = t.a', 2, /through a join \(UPDATE \.\.\. FROM\)/],
		['INSERT INTO dbo.audit SELECT 1', 1, /writes to the database table dbo\.audit/],
		['IF @@ROWCOUNT > 0 SELECT a INTO #t FROM x', 1, /IF, which runs statements conditionally/]
	];
	for (const [sql, statement, reason] of cases) {
		const p = plan(sql, [{ id: 't', kind: 'custom-sql', sql: 'select * from #t' }]);
		assert.ok(p.blocked, sql);
		assert.equal(p.blocked.statement, statement, sql);
		assert.match(p.blocked.reason, reason);
	}
	const p = plan('SELECT a INTO #t FROM x', [{ id: 'q', name: 'Q', kind: 'custom-sql', sql: 'SELECT b.k, t.a FROM db.dbo.b b JOIN #t t ON t.a > b.k' }]);
	assert.equal(p.blocked.where, "the custom SQL of table 'Q'");
	const message = initialSqlBlockedMessage(p.blocked);
	assert.match(message, /^the custom SQL of table 'Q' \(SELECT b\.k, t\.a FROM .*\) joins #t on 't\.a > b\.k', which is not an equality of two columns\. A connector stream runs one query/);
	const nested = plan('SELECT a INTO #t FROM x\nSELECT b.k, t.a INTO #u FROM db.dbo.b b JOIN #t t ON t.a > b.k', [{ id: 'q', kind: 'custom-sql', sql: 'select * from #u' }]);
	assert.equal(nested.blocked.where, 'Initial SQL statement 2 of 2 (#u)');
	assert.match(nested.blocked.text, /^SELECT b\.k, t\.a INTO #u/);
});

test('planDatasets: connector streams, an Initial SQL DataFlow before the join DataFlow, and the card target', () => {
	const ds = sampleDatasource();
	const ir = { workbook: { name: 'Acme' }, datasources: [ds], worksheets: [{ name: 's', datasources: ['ds1'] }] };
	const mappings = { accounts: [{ match: { class: 'sqlserver', server: 'dw' }, accountId: 101 }] };
	const { datasets, dataflows, issues } = planDatasets(ir, [{ datasourceId: 'ds1', strategy: 'connector', tables: [], issues: [] }], { mappings, workbookKey: 'ac' });
	const connectors = datasets.filter((d) => d.strategy === 'connector');
	assert.equal(connectors.length, 4);
	assert.ok(connectors.every((d) => d.connector.accountId === 101));
	assert.deepEqual(connectors.map((d) => d.key).sort(), ['ac.support-case.custom-sql-query1', 'ac.support-case.escalationempcount', 'ac.support-case.sql-cases-custom-sql-query-database-tables', 'ac.support-case.sql-user']);
	const query = (d) => d.connector.configuration.find((c) => c.name === 'query').value;
	assert.equal(query(connectors.find((d) => d.key.endsWith('escalationempcount'))).startsWith('select * from (select snapshot_date'), true);
	assert.deepEqual(dataflows.map((f) => f.key), ['ac.support-case.cases-custom-sql-query.initial-sql', 'ac.support-case']);
	const cases = datasets.find((d) => d.key === 'ac.support-case.cases-custom-sql-query');
	assert.equal(cases.strategy, 'dataflow-output');
	assert.equal(cases.sourceStrategy, 'connector');
	const loads = dataflows[0].definition.actions.filter((a) => a.type === 'LoadFromVault').map((a) => a.dataSourceId.$ref);
	assert.deepEqual(loads, ['dataset:ac.support-case.sql-cases-custom-sql-query-database-tables', 'dataset:ac.support-case.sql-user']);
	const joinLoads = dataflows[1].definition.actions.filter((a) => a.type === 'LoadFromVault');
	assert.ok(joinLoads.some((a) => a.dataSourceId.$ref === 'dataset:ac.support-case.cases-custom-sql-query' && a.executeFlowWhenUpdated));
	assert.ok(datasets.find((d) => d.key === 'ac.support-case').cardTarget);
	assert.match(issues.find((i) => i.code === 'data.initial-sql').message, /becomes 4 connector stream\(s\), one per temp table \(#user, #escalationEmpCount, #activeaccounts\) and 1 over database tables/);
});

test('planDatasets: untranslatable Initial SQL gives an empty DataSet and an error, never a broken stream', () => {
	const ds = sampleDatasource();
	ds.connections[0].extra['one-time-sql'] = `${INITIAL_SQL}\nWHILE 1 = 0 BEGIN PRINT 'x' END`;
	const ir = { workbook: { name: 'Acme' }, datasources: [ds], worksheets: [{ name: 's', datasources: ['ds1'] }] };
	const { datasets, issues } = planDatasets(ir, [{ datasourceId: 'ds1', strategy: 'connector', tables: [], issues: [] }], { mappings: {}, workbookKey: 'ac' });
	assert.deepEqual(datasets.map((d) => d.strategy), ['upload']);
	const error = issues.find((i) => i.code === 'data.initial-sql-untranslatable');
	assert.equal(error.severity, 'error');
	assert.match(error.message, /Initial SQL statement 6 of 9 \(WHILE 1 = 0\) has a WHILE loop/);
});

test('extract: a mapped account with untranslatable Initial SQL falls back to the decision, which hides the account choice', async () => {
	const ds = sampleDatasource();
	ds.connections[0].extra['one-time-sql'] = 'DECLARE c CURSOR FOR SELECT id FROM t\nSELECT a INTO #escalationEmpCount FROM x';
	const mappings = { accounts: [{ match: { class: 'sqlserver', server: 'dw' }, accountId: 101 }] };
	const manifest = await extractData({ datasource: ds, dir: tempDir(), mappings, unmapped: 'ask', planOnly: true });
	assert.equal(manifest.strategy, 'pending');
	const warning = manifest.issues.find((i) => i.code === 'data.connector-initial-sql');
	assert.match(warning.message, /Initial SQL statement 1 of 2 \(DECLARE c CURSOR FOR SELECT id FROM t\) declares a cursor/);
	const decision = completeDecision({ ...manifest.decision, accounts: { providers: ['ms-sql-server'], status: 'match', matches: [{ id: 101, name: 'A', host: 'dw' }], others: [] } }, { key: 'k', workbook: 'wb' });
	assert.match(decision.connectorBlocked.reason, /declares a cursor/);
	assert.deepEqual(decision.suggested, { choice: 'export' });
	assert.ok(!choicesFor(decision).some((c) => c.choice === 'account'));
	assert.ok(describeDecision(decision).some((l) => /Connector stream: not possible\. Initial SQL statement 1/.test(l)));
	const stdin = new PassThrough();
	stdin.end('\n');
	const err = [];
	const answers = await promptDecisions([decision], { stdin, stderr: { write: (s) => err.push(s) } });
	assert.deepEqual(answers, [{ key: 'k', choice: 'export' }]);
	assert.doesNotMatch(err.join(''), /\[a\]/);
	assert.match(err.join(''), /\(Enter: e\)/);

	const explicit = await extractData({ datasource: ds, dir: tempDir(), mappings, strategy: 'connector' });
	assert.equal(explicit.strategy, 'none');
	assert.equal(explicit.issues.find((i) => i.code === 'data.connector-initial-sql').severity, 'error');
});

test('extract: translatable Initial SQL keeps the connector strategy', async () => {
	const ds = sampleDatasource();
	const mappings = { accounts: [{ match: { class: 'sqlserver', server: 'dw' }, accountId: 101 }] };
	const manifest = await extractData({ datasource: ds, dir: tempDir(), mappings, unmapped: 'ask' });
	assert.equal(manifest.strategy, 'connector');
	assert.match(manifest.issues.find((i) => i.code === 'data.connector').message, /Initial SQL becomes 4 connector stream\(s\) and Magic ETL/);
});

test('Initial SQL that only sets harmless session options is ignored', () => {
	const session = "ALTER SESSION SET TIMEZONE = 'UTC';\nALTER SESSION SET QUERY_TAG = [WorkbookName][TableauApp];";
	assert.equal(isSessionOnly(session), true);
	assert.equal(initialSqlOf({ extra: { 'one-time-sql': session } }), undefined);
	assert.equal(isSessionOnly('USE WAREHOUSE OPS_WH;\nSET NOCOUNT ON;'), true);
	assert.equal(isSessionOnly("ALTER SESSION SET TIMEZONE = 'America/Denver';"), false);
	assert.equal(isSessionOnly('USE DATABASE ANALYTICS;'), false);
	assert.equal(isSessionOnly('create temp table cal as (select 1)'), false);
	assert.equal(initialSqlOf({ extra: { 'one-time-sql': 'USE DATABASE ANALYTICS;' } }), 'USE DATABASE ANALYTICS;');
});
