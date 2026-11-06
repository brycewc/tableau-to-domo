import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineInitialSql } from '../../src/tableau/data/initial-sql-inline.js';

const source = (initialSql) => ({
	connections: [{ id: 'sf', class: 'snowflake', dbname: 'SF_EDH', schema: 'EDH_IDS', extra: { 'one-time-sql': initialSql } }],
	tables: [
		{ id: 'CAL', name: 'CAL', kind: 'table', table: '[cal]', connectionId: 'sf' },
		{ id: 'q', name: 'Q', kind: 'custom-sql', sql: 'select * from casedata where y > 1', connectionId: 'sf' }
	]
});

test('temp tables become CTEs in front of the Custom SQL that reads them, and a temp table relation reads its CTE', () => {
	const sql = "ALTER SESSION SET TIMEZONE = 'UTC'; create temp table cal as select d, y from dim_calendar; create temp table casedata as select c.id, k.y from cases c join cal k on c.d = k.d;";
	const { source: out, cteCount } = inlineInitialSql(source(sql));
	assert.equal(out.connections[0].extra['one-time-sql'], undefined);
	const [cal, q] = out.tables;
	assert.equal(cal.kind, 'custom-sql');
	assert.match(cal.sql, /^WITH T2D_CAL_[0-9A-F]{6} AS \(\nselect d, y from SF_EDH\.EDH_IDS\.dim_calendar\n\)\nSELECT \* FROM T2D_CAL_[0-9A-F]{6}$/);
	assert.match(q.sql, /^WITH T2D_CAL_\w+ AS \(\n.*\n\),\nT2D_CASEDATA_\w+ AS \(\nselect c\.id, k\.y from SF_EDH\.EDH_IDS\.cases c join T2D_CAL_\w+ k on c\.d = k\.d\n\)\nselect \* from T2D_CASEDATA_\w+ where y > 1$/s);
	assert.equal(cteCount, 3);
	assert.match(inlineInitialSql(source(`${sql} update casedata set y = 0;`)).unsupported, /UPDATE on casedata/);
	assert.deepEqual(inlineInitialSql({ connections: [{ id: 'sf', class: 'snowflake' }], tables: [] }), {});
});
