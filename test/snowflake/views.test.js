import test from 'node:test';
import assert from 'node:assert/strict';
import { planSnowflakeViews } from '../../src/snowflake/views.js';

const target = { database: 'SF_EDH', schema: 'tableau_migration' };

test('temp tables become views in the target schema, qualified from USE, and Custom SQL reads them', () => {
	const initialSql = `ALTER SESSION SET TIMEZONE = 'UTC';
use database sf_edh; use schema edh_ids;
create temp table cal as (select distinct calendar_date, fiscal_year_num from dim_calendar);
create temp table casedata as select c.id, k.fiscal_year_num from edh_ods.cases c join cal k on c.d = k.calendar_date;
drop table if exists scratch;`;
	const { views, customViews, unsupported } = planSnowflakeViews({
		initialSql,
		customSql: [{ id: 'q1', name: 'Custom SQL Query', sql: 'select * from casedata where fiscal_year_num > 2020' }],
		target,
		label: 'Backlog'
	});
	assert.equal(unsupported, undefined);
	assert.deepEqual(views.map((v) => [v.kind, v.name.replace(/_[0-9A-F]{6}$/, '_#')]), [
		['temp', 'T2D_CAL_#'],
		['temp', 'T2D_CASEDATA_#'],
		['custom', 'T2D_BACKLOG_CUSTOM_SQL_QUERY']
	]);
	const [cal, casedata, custom] = views;
	assert.match(cal.sql, /from SF_EDH\.EDH_IDS\.dim_calendar$/);
	assert.match(casedata.sql, new RegExp(`from SF_EDH\\.edh_ods\\.cases c join ${cal.fqName.replace(/\./g, '\\.')} k`));
	assert.equal(custom.sql, `select * from ${casedata.fqName} where fiscal_year_num > 2020`);
	assert.match(custom.ddl, /^CREATE OR REPLACE VIEW SF_EDH\.TABLEAU_MIGRATION\.T2D_BACKLOG_CUSTOM_SQL_QUERY COMMENT = 'Created by t2d from Custom SQL of Backlog' AS\n/);
	assert.equal(customViews.get('q1'), custom.fqName);
});

test('the same temp table in two datasources is one view; steps a view cannot express are reported', () => {
	const sql = 'use database d; use schema s; create temp table cal as select 1 as x from t;';
	const a = planSnowflakeViews({ initialSql: sql, target, label: 'A' });
	const b = planSnowflakeViews({ initialSql: sql, target, label: 'B' });
	assert.equal(a.views[0].fqName, b.views[0].fqName);
	const steps = planSnowflakeViews({ initialSql: `${sql} insert into cal select 2 from t;`, target, label: 'C' });
	assert.match(steps.unsupported, /runs INSERT on cal/);
	assert.match(planSnowflakeViews({ initialSql: 'create temp table x as select 1 from t;', target }).unsupported, /no database or schema/);
});

test('a table created with columns and filled by INSERTs is one view, built when first read', () => {
	const initialSql = `use database d; use schema s;
create temp table free_emails (domain varchar);
insert into free_emails (domain) values ('gmail.com'), ('yahoo.com');
insert into free_emails select domain from extra_domains;
create temp table leads as select * from crm_leads l where l.domain not in (select domain from free_emails);
select 1;`;
	const { views, unsupported } = planSnowflakeViews({ initialSql, target, label: 'Leads' });
	assert.equal(unsupported, undefined);
	assert.deepEqual(views.map((v) => v.name.replace(/_[0-9A-F]{6}$/, '')), ['T2D_FREE_EMAILS', 'T2D_LEADS']);
	assert.equal(views[0].sql, "SELECT 'gmail.com' AS DOMAIN\nUNION ALL\nSELECT 'yahoo.com' AS DOMAIN\nUNION ALL\nSELECT * FROM (select domain from D.S.extra_domains)");
	assert.ok(views[1].sql.includes(`select domain from ${views[0].fqName}`));
	assert.match(planSnowflakeViews({ initialSql: `${initialSql} update leads set x = 1;`, target }).unsupported, /UPDATE on leads/);
});

test('a bare USE db.schema sets the schema and its database; a bare USE db sets the database', () => {
	const plan = planSnowflakeViews({
		initialSql: 'use SF_EDH.EDH_ODS_READ;\ncreate temp table a as select s.id from EDH_ODS_SALESFORCE.SBQQ__SUBSCRIPTION__C s join FREE_EMAILS f on f.id = s.id;',
		customSql: [{ id: 'c', name: 'Custom SQL Query', sql: 'select * from a' }],
		database: 'OTHER',
		schema: 'PUBLIC',
		target
	});
	const temp = plan.views.find((v) => v.kind === 'temp');
	assert.match(temp.sql, /SF_EDH\.EDH_ODS_SALESFORCE\.SBQQ__SUBSCRIPTION__C/);
	assert.match(temp.sql, /SF_EDH\.EDH_ODS_READ\.FREE_EMAILS/);
	const one = planSnowflakeViews({ initialSql: 'use CSG_DB;\ncreate temp table b as select 1 as x from S.T;', customSql: [], database: 'OTHER', schema: 'PUBLIC', target });
	assert.match(one.views[0].sql, /CSG_DB\.S\.T/);
});
