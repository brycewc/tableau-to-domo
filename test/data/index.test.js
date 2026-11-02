import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyCustomSqlOverrides, extractData, datasourceSlug, findConnectorMatch, matchHyperTable, mergePublishedDefinitions, mergePublishedFields, readPublishedDatasource } from '../../src/tableau/data/index.js';
import { tempDir, makeFakePython, fakeHyperPython } from './helpers.js';
import { makeZip } from '../twb/helpers/zip.js';

function field(id, name, datatype = 'string', extra = {}) {
	return { id, name, datatype, role: 'dimension', kind: 'column', ...extra };
}

function baseDatasource(extra = {}) {
	return {
		id: 'federated.abc',
		caption: 'Superstore',
		connections: [{ id: 'c1', class: 'snowflake', server: 'acme.snowflakecomputing.com', dbname: 'SALES', extra: {} }],
		tables: [],
		relationships: [],
		fields: [field('[Region]', 'Region'), field('[Sales]', 'Sales', 'real'), field('[Order Date]', 'Order Date', 'date')],
		filters: [],
		...extra
	};
}

function fakePkg(entries = ['Superstore.twb', 'Data/Extracts/superstore.hyper']) {
	const extracted = [];
	return {
		entries,
		extracted,
		async extractEntry(entry, dest) {
			extracted.push(entry);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, 'hyper');
		}
	};
}

const noPython = '/nonexistent/python-for-t2d-tests';

test('auto picks an existing mapping by caption or published luid', async () => {
	const dir = tempDir();
	const ds = baseDatasource();
	let manifest = await extractData({ datasource: ds, dir, mappings: { datasets: { Superstore: 'abc-123' } } });
	assert.equal(manifest.strategy, 'existing');
	assert.equal(manifest.existingDatasetId, 'abc-123');
	assert.ok(fs.existsSync(path.join(dir, 'data', `${datasourceSlug(ds)}.manifest.json`)));

	const published = baseDatasource({ caption: 'Other', published: { luid: 'luid-9' }, connections: [{ id: 'p', class: 'sqlproxy', extra: {} }] });
	manifest = await extractData({ datasource: published, dir, mappings: { datasets: { 'luid-9': 'ds-9' } } });
	assert.equal(manifest.existingDatasetId, 'ds-9');
});

test('auto picks connector for a live connection with a matching account', async () => {
	const dir = tempDir();
	const mappings = { accounts: [{ match: { class: 'Snowflake', dbname: 'sales' }, accountId: 42 }] };
	const manifest = await extractData({ datasource: baseDatasource(), dir, mappings });
	assert.equal(manifest.strategy, 'connector');
	assert.deepEqual(manifest.tables, []);
	assert.ok(manifest.issues.some((i) => i.code === 'data.connector'));

	assert.equal(findConnectorMatch(baseDatasource(), { accounts: [{ match: { class: 'snowflake', server: 'other' }, accountId: 1 }] }), undefined);
	assert.equal(findConnectorMatch(baseDatasource(), { accounts: [{ match: {}, accountId: 1 }] }), undefined);
});

test('auto skips connector when the datasource uses an extract', async () => {
	const dir = tempDir();
	const ds = baseDatasource({ extract: { enabled: true, hyperFiles: ['Data/Extracts/superstore.hyper'] } });
	const mappings = { accounts: [{ match: { class: 'snowflake' }, accountId: 42 }] };
	const manifest = await extractData({ datasource: ds, dir, mappings, pkg: fakePkg(), python: noPython });
	assert.notEqual(manifest.strategy, 'connector');
});

test('auto uses the hyper sidecar for a packaged single-table extract', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, [
		{
			schema: 'Extract',
			name: 'Extract',
			rowCount: 2,
			columns: [
				{ name: 'Region', type: 'TEXT', nullable: true },
				{ name: 'Sales', type: 'DOUBLE', nullable: true },
				{ name: 'Order Date', type: 'DATE', nullable: true },
				{ name: 'Is Big', type: 'BOOL', nullable: true },
				{ name: 'Mystery', type: 'BIGINT', nullable: true }
			],
			csv: 'Region,Sales,Order Date,Is Big,Mystery\nEast,1.5,2024-01-02,t,7\n"Wes""t",,,f,\n'
		}
	]);
	const ds = baseDatasource({
		extract: { enabled: true, hyperFiles: ['Data/Extracts/superstore.hyper'] },
		fields: [field('[Region]', 'Sales Region'), field('[Sales]', 'Sales', 'real'), field('[Order Date]', 'Order Date', 'date'), field('[Is Big]', 'Region', 'boolean')]
	});
	const pkg = fakePkg();
	const manifest = await extractData({ datasource: ds, dir, pkg, python, mappings: {} });
	assert.equal(manifest.strategy, 'hyper');
	assert.deepEqual(pkg.extracted, ['Data/Extracts/superstore.hyper']);
	assert.equal(manifest.tables.length, 1);
	const [table] = manifest.tables;
	assert.equal(table.name, 'Superstore');
	assert.equal(table.flattened, true);
	assert.equal(table.rowCount, 2);
	assert.equal(table.file, `data/${datasourceSlug(ds)}/superstore.csv`);
	assert.deepEqual(
		table.columns.map((c) => [c.name, c.type, c.sourceName]),
		[
			['Sales Region', 'STRING', 'Region'],
			['Sales', 'DOUBLE', 'Sales'],
			['Order Date', 'DATE', 'Order Date'],
			['Region', 'STRING', 'Is Big'],
			['Mystery', 'LONG', 'Mystery']
		]
	);
	assert.equal(
		fs.readFileSync(path.join(dir, table.file), 'utf8'),
		'Sales Region,Sales,Order Date,Region,Mystery\nEast,1.5,2024-01-02,true,7\n"Wes""t",,,false,\n'
	);
	assert.equal(fs.existsSync(path.join(dir, 'data', '.tmp')), false);
	assert.ok(manifest.issues.some((i) => i.code === 'data.hyper-unmatched-columns'));
});

test('hyper maps multi-table extracts to TableIR by object id and dedupes names', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, [
		{ schema: 'Extract', name: 'Orders_ECFCA1FB690A41FE803BC071773BA862', rowCount: 1, columns: [{ name: 'ID', type: 'BIGINT' }, { name: 'Region', type: 'TEXT' }], csv: 'ID,Region\n1,East\n' },
		{ schema: 'Extract', name: 'People_0123456789ABCDEF0123456789ABCDEF', rowCount: 1, columns: [{ name: 'ID', type: 'BIGINT' }, { name: 'Person', type: 'TEXT' }], csv: 'ID,Person\n1,Ann\n' }
	]);
	const ds = baseDatasource({
		extract: { enabled: true, hyperFiles: ['Data/Extracts/superstore.hyper'] },
		tables: [
			{ id: 'Orders_ECFCA1FB690A41FE803BC071773BA862', name: 'Orders', kind: 'table', columns: [{ remoteName: 'ID', localName: '[ID]', localType: 'integer' }] },
			{ id: 'People_0123456789ABCDEF0123456789ABCDEF', name: 'People', kind: 'table', columns: [{ remoteName: 'ID', localName: '[ID (People)]', localType: 'integer' }] }
		],
		fields: [field('[ID]', 'Order ID', 'integer'), field('[ID (People)]', 'Person ID', 'integer'), field('[Region]', 'Region'), field('[Person]', 'Person')]
	});
	const manifest = await extractData({ datasource: ds, dir, pkg: fakePkg(), python });
	assert.equal(manifest.strategy, 'hyper');
	assert.deepEqual(manifest.tables.map((t) => [t.name, t.tableId, t.flattened]), [
		['Orders', 'Orders_ECFCA1FB690A41FE803BC071773BA862', false],
		['People', 'People_0123456789ABCDEF0123456789ABCDEF', false]
	]);
	assert.deepEqual(manifest.tables[1].columns.map((c) => c.name), ['Person ID', 'Person']);
	assert.deepEqual(manifest.tables[0].columns.map((c) => c.name), ['Order ID', 'Region']);
});

test('matchHyperTable falls back to the stem before the object id', () => {
	const ds = { tables: [{ id: 'x', name: 'Orders' }] };
	assert.equal(matchHyperTable(ds, { name: 'Orders_ECFCA1FB690A41FE803BC071773BA862' }, 2).id, 'x');
});

test('auto falls back from a missing sidecar to vds for a published datasource', async () => {
	const dir = tempDir();
	const ds = baseDatasource({
		published: { luid: 'luid-1', name: 'Superstore Published' },
		connections: [{ id: 'p', class: 'sqlproxy', extra: {} }],
		extract: { enabled: true, hyperFiles: ['Data/Extracts/superstore.hyper'] }
	});
	const python = makeFakePython(dir, `console.log(JSON.stringify({ error: 'no', code: 'missing-module' })); process.exit(3);`);
	const client = {
		async vds(endpoint) {
			if (endpoint === 'read-metadata') return { data: [{ fieldName: 'Region', fieldCaption: 'Region', dataType: 'STRING', columnClass: 'COLUMN' }] };
			return { data: [{ Region: 'East' }] };
		}
	};
	const manifest = await extractData({ datasource: ds, dir, pkg: fakePkg(), python, client });
	assert.equal(manifest.strategy, 'vds');
	assert.ok(manifest.issues.some((i) => i.code === 'data.hyper-sidecar' && /pip install tableauhyperapi/.test(i.message)));
	assert.equal(manifest.tables[0].rowCount, 1);
	assert.equal(fs.readFileSync(path.join(dir, manifest.tables[0].file), 'utf8'), 'Region\nEast\n');
});

test('auto falls back from a failing vds to view csv, one table per view', async () => {
	const dir = tempDir();
	const ds = baseDatasource({ published: { luid: 'luid-1' }, connections: [{ id: 'p', class: 'sqlproxy', extra: {} }] });
	const ir = {
		workbook: { name: 'WB', luid: 'wb-1', sourceFile: 'x.twbx' },
		worksheets: [
			{ name: 'Sales by Region', datasourceIds: ['federated.abc'] },
			{ name: 'Hidden Sheet', datasourceIds: ['federated.abc'] },
			{ name: 'Other DS', datasourceIds: ['federated.zzz'] }
		]
	};
	const downloads = [];
	const client = {
		async vds() {
			throw new Error('HTTP 403');
		},
		async download(p, dest) {
			downloads.push(p);
			fs.writeFileSync(dest, 'Region,Sales\nEast,"1,000"\n');
			return { file: dest };
		}
	};
	const views = [{ id: 'v1', name: 'Sales by Region' }, { id: 'v3', name: 'Other DS' }];
	const manifest = await extractData({ datasource: ds, dir, client, ir, views, python: noPython });
	assert.equal(manifest.strategy, 'view-csv');
	assert.deepEqual(downloads, ['/views/v1/data']);
	assert.equal(manifest.tables.length, 1);
	assert.deepEqual(manifest.tables[0].columns.map((c) => c.type), ['STRING', 'LONG']);
	const codes = manifest.issues.map((i) => i.code);
	assert.ok(codes.includes('data.vds-failed'));
	assert.ok(codes.includes('data.view-csv-lossy'));
	assert.ok(codes.includes('data.view-csv-hidden'));
});

test('auto ends at none with an error issue', async () => {
	const dir = tempDir();
	const manifest = await extractData({ datasource: baseDatasource(), dir, python: noPython });
	assert.equal(manifest.strategy, 'none');
	assert.ok(manifest.issues.some((i) => i.severity === 'error' && i.code === 'data.none'));
});

test('explicit strategies do not fall back', async () => {
	const dir = tempDir();
	let manifest = await extractData({ datasource: baseDatasource(), dir, strategy: 'existing' });
	assert.equal(manifest.strategy, 'none');
	assert.ok(manifest.issues.some((i) => i.code === 'data.existing-missing'));

	manifest = await extractData({ datasource: baseDatasource(), dir, strategy: 'hyper', python: noPython });
	assert.equal(manifest.strategy, 'none');
	assert.ok(manifest.issues.some((i) => i.severity === 'error' && i.code === 'data.hyper-unavailable'));

	manifest = await extractData({ datasource: baseDatasource(), dir, strategy: 'none' });
	assert.equal(manifest.strategy, 'none');

	await assert.rejects(extractData({ datasource: baseDatasource(), dir, strategy: 'bogus' }), /Unknown data strategy/);
});

test('legacy tde extracts are reported', async () => {
	const dir = tempDir();
	const ds = baseDatasource({ extract: { enabled: true, hyperFiles: ['Data/Extracts/old.tde'] } });
	const manifest = await extractData({ datasource: ds, dir, strategy: 'hyper', pkg: fakePkg(['Data/Extracts/old.tde']), python: noPython });
	assert.ok(manifest.issues.some((i) => i.code === 'data.legacy-tde'));
});

const PUBLISHED_TDS = `<?xml version='1.0' encoding='utf-8' ?>
<datasource formatted-name='Credits DS' inline='true' version='18.1'>
  <connection class='federated'>
    <named-connections>
      <named-connection caption='SF' name='snowflake.1'>
        <connection class='snowflake' dbname='ANALYTICS' server='acme.snowflakecomputing.com' />
      </named-connection>
    </named-connections>
    <relation connection='snowflake.1' name='Custom SQL Query' type='text'>select 1</relation>
    <metadata-records>
      <metadata-record class='column'>
        <remote-name>LABEL_RAW</remote-name>
        <remote-type>129</remote-type>
        <local-name>[Label]</local-name>
        <parent-name>[Custom SQL Query]</parent-name>
        <local-type>string</local-type>
      </metadata-record>
      <metadata-record class='column'>
        <remote-name>ACV</remote-name>
        <remote-type>5</remote-type>
        <local-name>[ACV]</local-name>
        <parent-name>[Custom SQL Query]</parent-name>
        <local-type>real</local-type>
      </metadata-record>
    </metadata-records>
  </connection>
  <column caption='ACV Doubled' datatype='real' name='[Calculation_1]' role='measure' type='quantitative'>
    <calculation class='tableau' formula='[ACV] * 2' />
  </column>
  <extract count='-1' enabled='true' units='records'>
    <connection class='hyper' dbname='Data/Extracts/Credits DS.hyper' />
  </extract>
</datasource>`;

function publishedClient(dir, { status } = {}) {
	const calls = [];
	return {
		calls,
		async download(relPath, pick, query) {
			calls.push({ relPath, query });
			if (status) throw new Error(`HTTP ${status}`);
			const file = pick('Credits DS.tdsx', 'application/octet-stream');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, makeZip([{ name: 'Credits DS.tds', data: PUBLISHED_TDS }, { name: 'Data/Extracts/Credits DS.hyper', data: 'hyper' }]));
			return { file };
		}
	};
}

function sqlproxyDatasource() {
	return baseDatasource({
		id: 'sqlproxy.abc',
		caption: 'Credits',
		published: { luid: 'pds-1', name: 'Credits DS' },
		connections: [{ id: 'p', class: 'sqlproxy', extra: {} }],
		tables: [],
		fields: [field('[Label]', 'Label'), field('[ACV]', 'ACV Amount', 'real')]
	});
}

test('auto downloads a published datasource and maps its extract through the tds metadata-records', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, [
		{
			schema: 'Extract',
			name: 'Extract',
			rowCount: 2,
			columns: [{ name: 'LABEL_RAW', type: 'TEXT' }, { name: 'ACV', type: 'DOUBLE' }],
			csv: 'LABEL_RAW,ACV\nSE,1.5\nNE,2\n'
		}
	]);
	const ds = sqlproxyDatasource();
	const client = publishedClient(dir);
	const manifest = await extractData({ datasource: ds, dir, client, python, mappings: {} });
	assert.equal(manifest.strategy, 'published-extract');
	assert.deepEqual(client.calls, [{ relPath: '/datasources/pds-1/content', query: { includeExtract: 'true' } }]);
	assert.equal(manifest.tables.length, 1);
	assert.deepEqual(manifest.tables[0].columns.map((c) => [c.name, c.sourceName]), [['Label', 'LABEL_RAW'], ['ACV Amount', 'ACV']]);
	assert.equal(manifest.tables[0].rowCount, 2);
	assert.equal(fs.readFileSync(path.join(dir, manifest.tables[0].file), 'utf8'), 'Label,ACV Amount\nSE,1.5\nNE,2\n');
	assert.ok(fs.existsSync(path.join(dir, 'data', datasourceSlug(ds), 'source.tdsx')));
	assert.equal(fs.existsSync(path.join(dir, 'data', '.download')), false);
	const calc = ds.fields.find((f) => f.id === '[Calculation_1]');
	assert.equal(calc?.formula, '[ACV] * 2');
	assert.ok(manifest.issues.some((i) => i.code === 'data.published-fields-merged' && i.severity === 'info'));
});

test('published-extract is skipped silently in auto without a sidecar and reported when explicit', async () => {
	const dir = tempDir();
	const client = publishedClient(dir);
	let manifest = await extractData({ datasource: sqlproxyDatasource(), dir, client, python: noPython, strategy: 'published-extract' });
	assert.equal(manifest.strategy, 'none');
	assert.ok(manifest.issues.some((i) => i.severity === 'error' && i.code === 'data.hyper-sidecar'));
	assert.equal(client.calls.length, 0);

	const python = fakeHyperPython(dir, []);
	manifest = await extractData({ datasource: sqlproxyDatasource(), dir, client: publishedClient(dir, { status: 403 }), python, strategy: 'published-extract' });
	assert.ok(manifest.issues.some((i) => i.code === 'data.published-extract-failed' && /Download Data Source/.test(i.suggestion)));
});

test('mergePublishedFields adds missing fields and replaces sqlproxy columns that are published calculations', () => {
	const ds = { fields: [field('[A]', 'A'), field('[Calculation_9]', 'Calculation_9', 'string', { physical: { remoteName: 'Calculation_9' } }), field('[Calculation_8]', 'Calculation_8')] };
	const published = {
		fields: [
			field('[A]', 'A2'),
			{ id: '[C]', name: 'C', kind: 'calculated', formula: '1' },
			{ id: '[Calculation_9]', name: 'Fiscal Period', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "IF [FP] = 1 THEN 'P1' END" },
			{ id: '[Calculation_8]', name: 'Materialized', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "'x'" }
		]
	};
	const { added, replaced } = mergePublishedFields(ds, published, { extractedFieldIds: new Set(['[Calculation_8]']) });
	assert.deepEqual(added.map((f) => f.id), ['[C]']);
	assert.deepEqual(replaced.map((f) => f.id), ['[Calculation_9]']);
	assert.deepEqual(ds.fields.map((f) => [f.name, f.kind ?? 'column']), [['A', 'column'], ['Fiscal Period', 'calculated'], ['Calculation_8', 'column'], ['C', 'calculated']]);
	assert.equal(ds.fields[1].physical, undefined);
});

test('mergePublishedDefinitions adds what the workbook copy lacks and never turns a column into a calculation', () => {
	const ds = {
		fields: [
			field('[A]', 'A'),
			field('[Calculation_9]', 'Calculation_9', 'string', { physical: { remoteName: 'Calculation_9' } }),
			{ id: '[Calculation_7]', name: 'Empty', datatype: 'unknown', role: 'measure', kind: 'calculated' }
		]
	};
	const published = {
		fields: [
			{ ...field('[A]', 'A2'), aliases: { a: 'Alpha' } },
			{ id: '[C]', name: 'C', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([A])' },
			{ id: '[G]', name: 'G', datatype: 'string', role: 'dimension', kind: 'group', group: { source: '[A]', bins: [] } },
			{ id: '[Calculation_9]', name: 'Fiscal Period', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "'P1'" },
			{ id: '[Calculation_7]', name: 'Empty', datatype: 'real', role: 'measure', kind: 'calculated', formula: '1' }
		]
	};
	const { added, filled } = mergePublishedDefinitions(ds, published);
	assert.deepEqual(added.map((f) => f.id), ['[C]', '[G]']);
	assert.deepEqual(filled.map((f) => f.id), ['[A]', '[Calculation_7]']);
	assert.deepEqual(ds.fields[0].aliases, { a: 'Alpha' });
	assert.equal(ds.fields[0].name, 'A');
	assert.equal(ds.fields[1].kind, 'column');
	assert.deepEqual([ds.fields[2].datatype, ds.fields[2].formula], ['real', '1']);
	published.fields[0].aliases.a = 'changed';
	assert.equal(ds.fields[0].aliases.a, 'Alpha', 'the published definition is not shared by reference');
});

test('connector on a published datasource takes the connections and tables of its tds', async () => {
	const dir = tempDir();
	const mappings = { accounts: [{ match: { class: 'snowflake', dbname: 'ANALYTICS' }, accountId: 101 }] };
	const ds = sqlproxyDatasource();
	const client = publishedClient(dir);
	const manifest = await extractData({ datasource: ds, dir, client, mappings, strategy: 'connector', python: noPython });
	assert.equal(manifest.strategy, 'connector');
	assert.deepEqual(client.calls, [{ relPath: '/datasources/pds-1/content', query: { includeExtract: 'false' } }]);
	assert.deepEqual(ds.connections.map((c) => [c.class, c.dbname]), [['snowflake', 'ANALYTICS']]);
	assert.deepEqual(ds.tables.map((t) => [t.kind, t.sql, t.columns.map((c) => c.remoteName)]), [['custom-sql', 'select 1', ['LABEL_RAW', 'ACV']]]);
	assert.equal(ds.fields.find((f) => f.id === '[Calculation_1]')?.formula, '[ACV] * 2');
	assert.ok(manifest.issues.some((i) => i.code === 'data.published-connections' && /extract is bypassed/.test(i.message)));

	const auto = sqlproxyDatasource();
	const autoManifest = await extractData({ datasource: auto, dir, client: publishedClient(dir), mappings, python: noPython, skipViewCsv: true });
	assert.notEqual(autoManifest.strategy, 'connector', 'auto keeps a published extract instead of swapping in a live query');
	assert.equal(auto.connections[0].class, 'sqlproxy');

	const unmapped = await extractData({ datasource: sqlproxyDatasource(), dir, client: publishedClient(dir), mappings: { accounts: [{ match: { class: 'snowflake', dbname: 'OTHER' }, accountId: 1 }] }, strategy: 'connector' });
	assert.equal(unmapped.strategy, 'none');
	assert.ok(unmapped.issues.some((i) => i.severity === 'error' && i.code === 'data.connector-missing'));
});

test('readPublishedDatasource reads the tds without its extract, and a definition passed to extractData is not downloaded again', async () => {
	const dir = tempDir();
	const client = publishedClient(dir);
	const published = await readPublishedDatasource(client, 'pds-1', path.join(dir, 'scratch'));
	assert.deepEqual(client.calls, [{ relPath: '/datasources/pds-1/content', query: { includeExtract: 'false' } }]);
	assert.equal(fs.existsSync(path.join(dir, 'scratch')), false);
	assert.deepEqual(published.connections.map((c) => c.class), ['snowflake']);

	const mappings = { accounts: [{ match: { class: 'snowflake', dbname: 'ANALYTICS' }, accountId: 101 }] };
	const ds = sqlproxyDatasource();
	const again = publishedClient(dir);
	const manifest = await extractData({ datasource: ds, dir, client: again, mappings, strategy: 'connector', published, python: noPython });
	assert.equal(manifest.strategy, 'connector');
	assert.equal(again.calls.length, 0);
	assert.equal(ds.connections[0].class, 'snowflake');
	assert.equal(published.tables.length, 1);
});

test('a datasource joining Salesforce and Snowflake explains its snapshot and the manual setup', async () => {
	const dir = tempDir();
	const ds = baseDatasource({
		connections: [
			{ id: 'sf', class: 'salesforce', server: 'acme.my.salesforce.com', extra: {} },
			{ id: 'snow', class: 'snowflake', server: 'acme.snowflakecomputing.com', dbname: 'SALES', extra: {} }
		],
		tables: [
			{ id: 't1', name: 'Chat Transcript', relation: 'LiveChatTranscript', kind: 'table', connectionId: 'sf', columns: [] },
			{ id: 't2', name: 'DIM_CALENDAR', kind: 'table', connectionId: 'snow', table: '[SALES].[DIM].[DIM_CALENDAR]', columns: [] }
		]
	});
	const manifest = await extractData({ datasource: ds, dir, python: noPython });
	const issue = manifest.issues.find((i) => i.code === 'data.mixed-sources');
	assert.match(issue.message, /salesforce acme\.my\.salesforce\.com \(LiveChatTranscript\); snowflake acme\.snowflakecomputing\.com\/SALES \(DIM_CALENDAR\)/);
	assert.match(issue.message, /Salesforce is read by object, not SQL, so no data could be extracted/);
	assert.match(issue.suggestion, /Salesforce connector DataSet per Salesforce object \(LiveChatTranscript\)/);
	assert.match(issue.suggestion, /mappings\.json datasets \("Superstore": "<DataSet id>"\)/);

	const skipped = await extractData({ datasource: ds, dir, strategy: 'none' });
	assert.ok(!skipped.issues.some((i) => i.code === 'data.mixed-sources'));
	const single = await extractData({ datasource: baseDatasource(), dir, python: noPython });
	assert.ok(!single.issues.some((i) => i.code === 'data.mixed-sources'));
});

test('a multi-table published extract maps warehouse column names through the published tables and relation names', () => {
	const ds = { tables: [{ id: 'T_1', name: 'Case', relation: 'Custom SQL Query', columns: [] }, { id: 'T_2', name: 'Chat Transcript', relation: 'LiveChatTranscript', columns: [] }] };
	assert.equal(matchHyperTable(ds, { name: 'Custom SQL Query' }, 2)?.id, 'T_1');
	assert.equal(matchHyperTable(ds, { name: 'LiveChatTranscript' }, 2)?.id, 'T_2');
});

test('published-extract maps warehouse names when the sqlproxy copy names its columns after the published fields', async () => {
	const dir = tempDir();
	const python = fakeHyperPython(dir, [
		{ schema: 'Extract', name: 'Extract', rowCount: 1, columns: [{ name: 'LABEL_RAW', type: 'TEXT' }, { name: 'ACV', type: 'DOUBLE' }], csv: 'LABEL_RAW,ACV\nSE,1.5\n' }
	]);
	const ds = sqlproxyDatasource();
	ds.tables = [{ id: 'Custom SQL Query', name: 'Custom SQL Query', kind: 'table', columns: [{ remoteName: 'Label', localName: '[Label]', localType: 'string' }, { remoteName: 'ACV Amount', localName: '[ACV]', localType: 'real' }] }];
	const manifest = await extractData({ datasource: ds, dir, client: publishedClient(dir), python, mappings: {}, strategy: 'published-extract' });
	assert.deepEqual(manifest.tables[0].columns.map((c) => [c.name, c.sourceName]), [['Label', 'LABEL_RAW'], ['ACV Amount', 'ACV']]);
	assert.ok(!manifest.issues.some((i) => i.code === 'data.hyper-unmatched-columns'));
});

test('mappings.customSql replaces a Custom SQL table by datasource and table name', () => {
	const source = { tables: [{ id: 'T', kind: 'table', name: 'T' }, { id: 'Custom SQL Query', kind: 'custom-sql', name: 'Custom SQL Query', sql: 'SELECT ID FROM ANALYTICS.S.ACCOUNT' }] };
	const issues = [];
	const mappings = { customSql: { abc: { 'Custom SQL Query': 'SELECT ACCOUNT_ID AS ID FROM P.S.DIM_ACCOUNT' } } };
	const out = applyCustomSqlOverrides(source, { published: { luid: 'abc' } }, mappings, (...a) => issues.push(a));
	assert.equal(out.tables[1].sql, 'SELECT ACCOUNT_ID AS ID FROM P.S.DIM_ACCOUNT');
	assert.equal(out.tables[0], source.tables[0]);
	assert.equal(issues[0][1], 'data.custom-sql-override');
	assert.equal(applyCustomSqlOverrides(source, { caption: 'other' }, mappings), source);
});
