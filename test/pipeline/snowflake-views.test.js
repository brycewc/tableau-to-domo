import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSnowflakeViews } from '../../src/pipeline/snowflake-views.js';

const target = { database: 'SF_EDH', schema: 'TABLEAU_MIGRATION' };

function source() {
	return {
		connections: [{ id: 'sf', class: 'snowflake', dbname: 'SF_EDH', schema: 'EDH_IDS', extra: { 'one-time-sql': "ALTER SESSION SET TIMEZONE = 'UTC'; create temp table cal as select calendar_date from dim_calendar;" } }],
		tables: [
			{ id: 'CAL', name: 'CAL', kind: 'table', table: '[cal]', connectionId: 'sf' },
			{ id: 'q', name: 'Custom SQL Query', kind: 'custom-sql', sql: 'select * from cal c join cases x on x.d = c.calendar_date', connectionId: 'sf' }
		]
	};
}

function stubClient(existing = {}) {
	const statements = [];
	return {
		statements,
		execute: async (sql) => {
			statements.push(sql);
			const like = sql.match(/^SHOW VIEWS LIKE '([^']+)'/);
			if (like) return existing[like[1]] ? { columns: ['name', 'comment'], rows: [[like[1], existing[like[1]]]] } : { columns: ['name', 'comment'], rows: [] };
			return { columns: [], rows: [] };
		}
	};
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 't2d-sfv-'));

test('views are created, and the datasource reads them in place of its Initial SQL and Custom SQL', async () => {
	const dir = tempDir();
	const client = stubClient();
	const prepare = createSnowflakeViews({ client, target, dir });
	const out = await prepare(source(), { label: 'Backlog' });
	const creates = client.statements.filter((s) => s.startsWith('CREATE OR REPLACE VIEW'));
	assert.equal(creates.length, 2);
	assert.match(creates[0], /^CREATE OR REPLACE VIEW SF_EDH\.TABLEAU_MIGRATION\.T2D_CAL_[0-9A-F]{6} .* AS\nselect calendar_date from SF_EDH\.EDH_IDS\.dim_calendar$/s);
	assert.equal(out.source.connections[0].extra['one-time-sql'], undefined);
	const [cal, custom] = out.source.tables;
	assert.match(cal.table, /^\[SF_EDH\]\.\[TABLEAU_MIGRATION\]\.\[T2D_CAL_[0-9A-F]{6}\]$/);
	assert.deepEqual([custom.kind, custom.table, custom.sql], ['table', '[SF_EDH].[TABLEAU_MIGRATION].[T2D_BACKLOG_CUSTOM_SQL_QUERY]', undefined]);
	assert.ok(fs.readFileSync(out.file, 'utf8').includes('T2D_BACKLOG_CUSTOM_SQL_QUERY'));
	assert.equal(out.issues.at(-1).code, 'data.snowflake-views');

	client.statements.length = 0;
	await prepare(source(), { label: 'Backlog' });
	assert.ok(!client.statements.some((s) => s.startsWith('CREATE')), 'unchanged views are not sent again in the same run');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a view someone else made is left alone, and without a client only the DDL is written', async () => {
	const dir = tempDir();
	const client = stubClient({ T2D_BACKLOG_CUSTOM_SQL_QUERY: 'owned by the data team' });
	const blocked = await createSnowflakeViews({ client, target, dir })(source(), { label: 'Backlog' });
	assert.equal(blocked.source, undefined);
	assert.equal(blocked.issues.at(-1).code, 'data.snowflake-view-exists');
	assert.ok(!client.statements.some((s) => s.includes('T2D_BACKLOG_CUSTOM_SQL_QUERY COMMENT')));

	const planned = await createSnowflakeViews({ client: null, target, dir })(source(), { label: 'Backlog' });
	assert.equal(planned.source, undefined);
	assert.equal(planned.issues[0].code, 'data.snowflake-views-ddl');
	assert.ok(fs.existsSync(planned.file));
	fs.rmSync(dir, { recursive: true, force: true });
});
