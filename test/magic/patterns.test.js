import test from 'node:test';
import assert from 'node:assert/strict';
import { magicToSql, parseExpr, parseQuery, sqlToMagic } from '../../src/magic/index.js';

// Shapes taken from the target workbooks' Initial SQL (credits, podio/xero, growth levers, pipeline), with made-up
// names and values.

const cols = (spec) => spec.split(',').map((name) => ({ name }));
const TABLES = {
	'DW.RPT.CONTRACT_CHANGE': cols('FY,FQY,FP,CHANGE_DATE,ORG_ID,NAME,MRR_CHANGE,REASON_GROUPED,ENDED_REASON,ENDED_ON,CONTRACT_ID,ACCOUNTING_PROVIDER,IS_SPAM'),
	'DW.RPT.INVOICE': cols('FY,FQY,FP,ORG_ID,CONTRACT_ID,REP,INVOICE_DATE,START_DATE,INVOICE_INTERVAL,AMOUNT,IS_SPAM'),
	'DW.RPT.CREDITS': cols('Order Date,Employee ID,Emp_Name,level_,AMOUNT,FP'),
	'DW.RPT.TERRITORY': cols('YEAR,VERSION,S1,REP_1,REP_2,FLM'),
	'DW.SF.ACCOUNT': cols('ID,ORG_ID,SOURCE_ID'),
	'DW.SF.HISTORY': cols('Month,AccountID,MRR'),
	'DW.IDS.OPPORTUNITY': cols('OPPORTUNITY_ID,ACCOUNT_ID,CLOSE_DATE,CREATED_DATE,PROBABILITY,STAGE_NAME,AMOUNT'),
	'DW.IDS.CALENDAR': cols('CALENDAR_DATE,FISCAL_YEAR_NUM,FISCAL_QUARTER_NUM'),
	'DW.IDS.CONTRACT': cols('ACCOUNT_ID,MIGRATED')
};
const run = (script, outputs, { known = true, ...opts } = {}) =>
	sqlToMagic(script, {
		inputs: (t) => ({ dataSourceId: `ds:${t.key}`, ...(known ? { columns: TABLES[t.key] } : {}) }),
		outputs: [].concat(outputs).map((sql, k) => ({ name: `out${k}`, sql })),
		compute: { type: 'adr', cloudId: 'cloud' },
		...opts
	});
const ok = (r) => {
	assert.deepEqual(r.blockers, []);
	for (const a of r.actions) {
		for (const e of a.expressions ?? []) parseExpr(e.expression, { formula: true });
		for (const s of a.statements ?? []) parseQuery(s);
	}
	assert.deepEqual(magicToSql(r.definition).unsupported, []);
	return r;
};
const of = (r, type) => r.actions.filter((a) => a.type === type);

test('podio/xero: grouped temp table, plug UPDATE, positional union with NULL placeholders', () => {
	const script = `
		USE DATABASE DW; USE SCHEMA RPT;
		ALTER SESSION SET QUOTED_IDENTIFIERS_IGNORE_CASE = FALSE;
		DROP TABLE IF EXISTS DW.RPT.iv2;
		CREATE TEMPORARY TABLE DW.RPT.iv2 AS (
			select 'Comp' as label_, FY, FQY, FP, org_id, contract_id, rep, invoice_date,
				DATE_PART(YEAR, TRY_TO_DATE(invoice_date)) as "year",
				1.0* FY + 1.0 * FP/100 as FPP,
				case when invoice_interval = 1 then 'Month' when invoice_interval = 12 then 'Year' end as interval,
				sum(amount) as amount
			from DW.RPT.INVOICE where 1=1 and is_spam <> 1
			group by FY, FQY, FP, org_id, contract_id, rep, invoice_date,
				DATE_PART(YEAR, TRY_TO_DATE(invoice_date)), 1.0* FY + 1.0 * FP/100,
				case when invoice_interval = 1 then 'Month' when invoice_interval = 12 then 'Year' end);
		CREATE TEMPORARY TABLE DW.RPT.cc1 AS (
			select 'Contract Change' as label_, a.FY, a.FQY, a.FP, a.org_id, a.contract_id, b.rep as rep, a.change_date as invoice_date,
				0 as "year", 0 as FPP, '' as interval, sum(a.mrr_change)*12 as amount
			from DW.RPT.CONTRACT_CHANGE a
			left join (select distinct contract_id, rep from DW.RPT.INVOICE) b on a.contract_id = b.contract_id
			where accounting_provider like '%xero%' and not (IFNULL(ended_reason,'') = 'org_cleanup' and ended_on = '2023-05-06')
			group by a.FY, a.FQY, a.FP, a.org_id, a.contract_id, b.rep, a.change_date);
		CREATE TEMPORARY TABLE DW.RPT.cc2 AS (select * from DW.RPT.cc1 where FP = 9 and amount > 0);
		update DW.RPT.cc2 set label_ = 'plug';
		CREATE TEMPORARY TABLE DW.RPT.r1 AS (
			select * from (
				select * from DW.RPT.cc1
				union all select * from DW.RPT.cc2
				union all select 'Comp', FY, FQY, FP, org_id, null, null, null, null, null, interval, amount from DW.RPT.iv2
			) x);
	`;
	const r = ok(run(script, 'SELECT LABEL_ AS "label_", FPP, interval AS "interval", amount FROM DW.RPT.r1'));
	const group = of(r, 'GroupBy').find((g) => g.groups.length > 5);
	assert.ok(group.groups.some((g) => /^_t2d_g/.test(g.name)), 'computed GROUP BY expressions become key columns');
	const keyFormula = of(r, 'ExpressionEvaluator').find((a) => a.expressions.some((e) => e.expression === 'YEAR(TRY_CAST(`INVOICE_DATE` AS DATE))'));
	assert.ok(keyFormula);
	const year = r.actions.find((a) => a.type === 'SelectValues' && a.fields.some((f) => f.rename === 'year'));
	assert.ok(year, 'the select-list expression reuses the matching group key');
	assert.equal(of(r, 'UnionAll').length, 1);
	assert.equal(of(r, 'UnionAll')[0].dependsOn.length, 3);
	assert.ok(of(r, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => e.fieldName === 'LABEL_' && e.expression === "CAST('plug' AS STRING)")), 'a SET value takes the column type');
	assert.equal(of(r, 'SQL').length, 0);
});

test('credits: scalar subquery filter, DISTINCT *, UPDATE of quoted columns, ALTER COLUMN, TRY_TO_NUMERIC', () => {
	const script = `
		USE SCHEMA DW.RPT;
		create or replace temporary table DW.RPT.tmp_periods as select * from (select 1 as A union all select 2 union all select 3);
		create or replace temporary table DW.RPT.tmp_r3 as select c.*, p.A from DW.RPT.CREDITS c join DW.RPT.tmp_periods p on c.FP = p.A;
		update DW.RPT.tmp_r3 set "level_" = 'Rep' where "Emp_Name" = 'Someone';
		update DW.RPT.tmp_r3 set FP = A;
		alter table DW.RPT.tmp_r3 alter column "Employee ID" type varchar(50);
		create or replace temporary table DW.RPT.tmp_r4 as select * from DW.RPT.tmp_r3 where 1=1 and try_to_numeric("Employee ID") is not null;
		create or replace temporary table DW.RPT.tmp_base as select "Order Date" as ORDER_DATE, AMOUNT from DW.RPT.CREDITS;
	`;
	const r = ok(run(script, `select distinct *,'' as "Notes" from DW.RPT.tmp_r4 where "Order Date" >(select max("ORDER_DATE") from DW.RPT.tmp_base) union ALL select *, 'x', 1, 2, 3, 4, 5 from DW.RPT.tmp_base`));
	const constant = of(r, 'SQL');
	assert.equal(constant.length, 1);
	assert.equal(constant[0].inputs.length, 0);
	assert.ok(of(r, 'Filter').some((f) => /^`Order Date` > `_t2d_s\d+`$/.test(f.filterList[0].expression)));
	assert.ok(of(r, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => e.fieldName === 'level_')));
	assert.ok(of(r, 'ExpressionEvaluator').some((a) => a.expressions.some((e) => e.fieldName === 'Employee ID' && e.expression === 'CAST(`Employee ID` AS STRING)')));
	assert.ok(of(r, 'Filter').some((f) => f.filterList[0].expression === 'ROUND(TRY_CAST(`Employee ID` AS DECIMAL), 0) IS NOT NULL'));
	assert.ok(of(r, 'Unique').length >= 1);
});

test('growth levers: ignore-case session, VALUES table, UPDATE ... FROM an aggregated join, SUM(DISTINCT) fallback', () => {
	const script = `
		ALTER SESSION SET QUOTED_IDENTIFIERS_IGNORE_CASE = TRUE;
		USE SCHEMA DW.SF;
		CREATE OR REPLACE TEMPORARY TABLE tmp_rank (Product VARCHAR(100), Line VARCHAR(20), Rank VARCHAR(5));
		insert into tmp_rank values ('A','SF','0'), ('B','Podio','1');
		CREATE OR REPLACE TEMPORARY TABLE tmp_acc AS
			select acc.ID AccountId, acc.Source_ID, acc.Org_ID, min(h.Month) as First_order, max(h.Month) as Last_order, 'SFDC' as Order_Source
			from ACCOUNT acc join HISTORY h on acc.Source_ID = h.AccountID group by acc.ID, acc.Source_ID, acc.Org_ID;
		UPDATE tmp_acc SET First_order = acc.First_order, Order_Source = acc.Order_Source
			FROM (select a.AccountId, min(NVL(h.Month, a.First_order)) as First_order, 'Legacy' as Order_Source
				from tmp_acc AS a join HISTORY h on a.Source_ID = h.AccountID and h.Month < a.First_order
				group by a.AccountId) as acc
			where tmp_acc.AccountId = acc.AccountId;
		CREATE OR REPLACE TEMPORARY TABLE tmp_sum AS select Order_Source, SUM(DISTINCT Org_ID) AS s from tmp_acc group by Order_Source;
		ALTER SESSION SET QUOTED_IDENTIFIERS_IGNORE_CASE = FALSE;
	`;
	const r = ok(run(script, ['select * from DW.SF.tmp_sum', 'select r.Product, a.AccountId from DW.SF.tmp_rank r cross join DW.SF.tmp_acc a']));
	const sql = of(r, 'SQL');
	assert.ok(sql.some((s) => /^SELECT 'A' AS "COLUMN1"/.test(s.statements[0])), 'VALUES rows are a SQL tile');
	assert.ok(sql.some((s) => /SUM\(DISTINCT "?ORG_ID"?\)/i.test(s.statements[0])), 'SUM(DISTINCT) runs in a SQL tile');
	const update = of(r, 'ExpressionEvaluator').find((a) => a.name.startsWith('Update') || a.expressions.some((e) => /^CASE WHEN `_t2d_m\d+` IS NOT NULL THEN/.test(e.expression)));
	assert.ok(update, 'UPDATE ... FROM overwrites matched rows');
	assert.ok(of(r, 'Filter').some((f) => f.filterList[0].expression === '`Month` < `FIRST_ORDER`'), 'a non-equi join condition becomes a filter after the join');
});

test('pipeline: first row per key via ROW_NUMBER, many LEFT JOINs with computed and constant conditions, constant union rows', () => {
	const script = `
		ALTER SESSION SET TIMEZONE = 'UTC';
		create TEMP table DW.IDS.CM as
		select X.* from (SELECT o.OPPORTUNITY_ID, o.ACCOUNT_ID, o.CREATED_DATE, ROW_NUMBER() OVER (PARTITION BY o.ACCOUNT_ID ORDER BY o.CREATED_DATE ASC) as ROW_NUM
			FROM DW.IDS.OPPORTUNITY o WHERE o.CREATED_DATE >= '2023-12-01') X
		WHERE ROW_NUM = 1 AND ACCOUNT_ID is not null;
	`;
	const dummy = Array.from({ length: 40 }, (_, k) => `SELECT 'Dummy' AS Data, NULL OppID, 'Team ${k}', NULL Close_Date, NULL FY`).join(' UNION ALL\n');
	const query = `
		SELECT DISTINCT 'Pipeline' AS Data, opp.OPPORTUNITY_ID as OppID, NVL(con.MIGRATED, 'Not Mapped') as Team,
			opp.CLOSE_DATE as Close_Date, CAST(dd.FISCAL_YEAR_NUM AS STRING) || ' Q' || CAST(dd.FISCAL_QUARTER_NUM AS STRING) AS FY
		FROM DW.IDS.OPPORTUNITY opp
		LEFT JOIN DW.IDS.CONTRACT con on opp.ACCOUNT_ID = con.ACCOUNT_ID and con.MIGRATED = 'False'
		LEFT JOIN DW.IDS.CALENDAR dd on cast(opp.CLOSE_DATE as date) = dd.CALENDAR_DATE
		LEFT JOIN DW.IDS.CM cm on cm.ACCOUNT_ID = opp.ACCOUNT_ID
		WHERE 1=1 AND opp.CLOSE_DATE < DATEADD(YEAR, DATEDIFF(YEAR, TO_DATE('1900-01-01'), opp.CREATED_DATE) + 3, TO_DATE('1900-01-01'))
		UNION ALL
		${dummy}`;
	const r = ok(run(script, query));
	assert.equal(of(r, 'SQL').length, 1, 'all constant branches share one SQL tile');
	assert.equal((of(r, 'SQL')[0].statements[0].match(/UNION ALL/g) ?? []).length, 39);
	assert.equal(of(r, 'MergeJoin').length, 3);
	assert.ok(of(r, 'WindowAction').length === 1);
	assert.ok(of(r, 'Filter').some((f) => f.filterList[0].expression === "`MIGRATED` = 'False'"), "a right-side ON condition filters before the LEFT JOIN");
	assert.ok(of(r, 'Filter').some((f) => [f.filterList[0]].some((e) => /DATE_ADD\(DATE\('1900-01-01'\), INTERVAL \(\(YEAR\(`CREATED_DATE`\) - YEAR\(DATE\('1900-01-01'\)\)\) \+ 3\) YEAR\)/.test(e.expression))));
	const unknown = ok(run(script, query, { known: false }));
	assert.equal(of(unknown, 'SQL').length, 1, 'without schemas no branch is a tile chain, so the whole union is one SQL tile');
});
