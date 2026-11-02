import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatasourceIR, buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { decodeCustomSql, parseConditions, parseConnection, SENSITIVE_NAME } from '../../src/tableau/twb/datasources.js';
import { parseXml } from '../../src/tableau/twb/xml.js';

const EXTERNAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'external');
const wb = (inner) => `<?xml version='1.0' encoding='utf-8' ?><workbook version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'><datasources>${inner}</datasources></workbook>`;

test('connections never keep credentials', () => {
	const conn = parseConnection(
		parseXml("<connection class='snowflake' server='acme.snowflakecomputing.com' dbname='DB' warehouse='WH' schema='PUBLIC' username='bob' password='p' oauth-config-id='x' access_token='t' odbc-connect-string-extras='UID=bob;PWD=secret' service='svc' port='443' authentication='Username Password' one-time-sql='SET x=1' />"),
		'snowflake.1'
	);
	assert.deepEqual(
		{ ...conn, extra: undefined },
		{ id: 'snowflake.1', class: 'snowflake', server: 'acme.snowflakecomputing.com', dbname: 'DB', warehouse: 'WH', schema: 'PUBLIC', service: 'svc', port: '443', authentication: 'Username Password', extra: undefined }
	);
	assert.deepEqual(conn.extra, { 'one-time-sql': 'SET x=1' });
	assert.ok(SENSITIVE_NAME.test('password') && SENSITIVE_NAME.test('username') && SENSITIVE_NAME.test('private_key_path'));
	const serialized = JSON.stringify(conn);
	assert.ok(!serialized.includes('secret') && !serialized.includes('bob'));
});

test('custom SQL decoding undoes doubled comparison operators', () => {
	assert.equal(decodeCustomSql('SELECT * FROM t WHERE a << 5 AND b >> 2 AND c = <[Parameters].[P]>\r\n'), 'SELECT * FROM t WHERE a < 5 AND b > 2 AND c = <[Parameters].[P]>');
});

test('join conditions with AND, non-equality and calculated sides', () => {
	const conds = parseConditions(
		parseXml(`<expression op='AND'>
			<expression op='='><expression op='[Orders].[Region]' /><expression op='[People].[Region]' /></expression>
			<expression op='&lt;='><expression op='[Orders].[Date]' /><expression op='LOWER'><expression op='[People].[Until]' /></expression></expression>
		</expression>`)
	);
	assert.deepEqual(conds, [
		{ left: '[Orders].[Region]', right: '[People].[Region]' },
		{ left: '[Orders].[Date]', right: 'LOWER([People].[Until])', op: '<=' }
	]);
});

test('legacy join tree (no object model) becomes relationTree with leaf tables', () => {
	const ir = buildWorkbookIR(
		wb(`<datasource caption='Joined' inline='true' name='federated.j1' version='10.0'>
		<connection class='federated'>
			<named-connections><named-connection caption='db' name='postgres.1'><connection class='postgres' dbname='shop' server='pg' port='5432' username='u' /></named-connection></named-connections>
			<relation join='left' type='join'>
				<clause type='join'><expression op='='><expression op='[Orders].[Region]' /><expression op='[People].[Region]' /></expression></clause>
				<relation join='inner' type='join'>
					<clause type='join'><expression op='='><expression op='[Orders].[Order ID]' /><expression op='[Returns].[Order ID]' /></expression></clause>
					<relation connection='postgres.1' name='Orders' table='[public].[orders]' type='table' />
					<relation connection='postgres.1' name='Returns' type='text'>SELECT * FROM returns</relation>
				</relation>
				<relation connection='postgres.1' name='People' table='[public].[people]' type='table' />
			</relation>
			<metadata-records>
				<metadata-record class='column'><remote-name>region</remote-name><remote-type>130</remote-type><local-name>[Region]</local-name><parent-name>[Orders]</parent-name><ordinal>0</ordinal><local-type>string</local-type><collation flag='1' name='LEN_RUS_S2' /></metadata-record>
				<metadata-record class='column'><remote-name>region</remote-name><local-name>[Region (People)]</local-name><parent-name>[People]</parent-name><ordinal>0</ordinal><local-type>string</local-type><collation flag='0' name='binary' /></metadata-record>
				<metadata-record class='column'><remote-name>sales</remote-name><local-name>[Sales]</local-name><parent-name>[Orders]</parent-name><ordinal>1</ordinal><local-type>real</local-type><aggregation>Sum</aggregation></metadata-record>
			</metadata-records>
		</connection>
		<column datatype='integer' name='[Number of Records]' role='measure' type='quantitative' user:auto-column='numrec'><calculation class='tableau' formula='1' /></column>
	</datasource>`)
	);
	const ds = ir.datasources[0];
	assert.deepEqual(ds.tables.map((t) => [t.id, t.kind, t.table ?? t.sql, t.connectionId]), [
		['Orders', 'table', '[public].[orders]', 'postgres.1'],
		['Returns', 'custom-sql', 'SELECT * FROM returns', 'postgres.1'],
		['People', 'table', '[public].[people]', 'postgres.1']
	]);
	assert.equal(ds.relationTree.type, 'join');
	assert.equal(ds.relationTree.join, 'left');
	assert.deepEqual(ds.relationTree.on, [{ left: '[Orders].[Region]', right: '[People].[Region]' }]);
	assert.equal(ds.relationTree.children[0].type, 'join');
	assert.deepEqual(ds.relationTree.children[0].children, [
		{ type: 'table', tableId: 'Orders' },
		{ type: 'custom-sql', tableId: 'Returns' }
	]);
	assert.equal(ds.tables[2].columns[0].localName, '[Region (People)]');
	const sales = ds.fields.find((f) => f.id === '[Sales]');
	assert.deepEqual(sales.physical, { tableId: 'Orders', remoteName: 'sales' });
	assert.equal(sales.role, 'measure');
	assert.equal(sales.defaultAggregation, 'Sum');
	assert.equal(sales.collation, undefined);
	assert.deepEqual(['[Region]', '[Region (People)]'].map((id) => ds.fields.find((f) => f.id === id).collation), ['LEN_RUS_S2', 'binary']);
	assert.equal(ds.fields.find((f) => f.id === '[Number of Records]').kind, 'count');
	assert.equal(ds.relationships.length, 0);
});

test('unions and legacy single connections', () => {
	const ir = buildWorkbookIR(
		wb(`<datasource inline='true' name='legacy' version='9.3'>
		<connection class='excel-direct' filename='C:/data/sales.xlsx' password=''>
			<relation all='true' name='Orders' type='union'>
				<columns><column datatype='string' name='Region' ordinal='0' /><column datatype='real' name='Sales' ordinal='1' /></columns>
				<relation name='Orders2022' table='[Orders2022$]' type='table' />
				<relation name='Orders2023' table='[Orders2023$]' type='table' />
			</relation>
		</connection>
	</datasource>`)
	);
	const ds = ir.datasources[0];
	assert.deepEqual(ds.connections.map((c) => [c.id, c.class, c.filename]), [['default', 'excel-direct', 'C:/data/sales.xlsx']]);
	assert.deepEqual(ds.relationTree, { type: 'union', children: [{ type: 'table', tableId: 'Orders2022' }, { type: 'table', tableId: 'Orders2023' }] });
	assert.ok(ds.tables.every((t) => t.kind === 'file' && t.connectionId === 'default'));
	assert.equal(ds.caption, 'legacy');
});

test('object model with a join inside one logical table', () => {
	const ir = buildWorkbookIR(
		wb(`<datasource caption='OM' inline='true' name='federated.om' version='18.1'>
		<connection class='federated'><named-connections><named-connection name='hyper.1'><connection class='hyper' dbname='Data/Extracts/om.hyper' /></named-connection></named-connections></connection>
		<object-graph><objects>
			<object caption='Sales' id='Sales_1'><properties context=''>
				<relation join='inner' type='join'><clause type='join'><expression op='='><expression op='[A].[k]' /><expression op='[B].[k]' /></expression></clause>
					<relation connection='hyper.1' name='A' table='[Extract].[A]' type='table' /><relation connection='hyper.1' name='B' table='[Extract].[B]' type='table' /></relation>
			</properties></object>
			<object caption='Targets' id='Targets_2'><properties context=''><relation connection='hyper.1' name='Targets' table='[Extract].[T]' type='table' /></properties></object>
		</objects><relationships><relationship><expression op='='><expression op='[k]' /><expression op='[k (Targets)]' /></expression><first-end-point object-id='Sales_1' /><second-end-point object-id='Targets_2' /></relationship></relationships></object-graph>
	</datasource>`)
	);
	const ds = ir.datasources[0];
	assert.deepEqual(ds.tables.map((t) => [t.id, t.kind]), [['A', 'extract'], ['B', 'extract'], ['Targets_2', 'extract']]);
	assert.equal(ds.relationTree.type, 'join');
	assert.deepEqual(ds.relationships, [{ fromTableId: 'A', toTableId: 'Targets_2', on: [{ left: '[k]', right: '[k (Targets)]' }] }]);
	assert.deepEqual(ds.extract, { enabled: true, hyperFiles: ['Data/Extracts/om.hyper'] });
	assert.ok(ir.issues.some((i) => i.code === 'twb.object-join'));
});

test('custom SQL parameters and disabled extracts', () => {
	const ir = buildWorkbookIR(
		wb(`<datasource inline='true' name='federated.c' version='18.1'>
		<connection class='federated'><named-connections><named-connection name='mysql.1'><connection class='mysql' server='m' /></named-connection></named-connections>
			<relation connection='mysql.1' name='Custom SQL Query' type='text'>SELECT * FROM t WHERE region = &lt;[Parameters].[Region]&gt;</relation></connection>
		<extract count='-1' enabled='false' units='records'><connection class='hyper' dbname='C:\\Data\\x.hyper' /></extract>
	</datasource>`)
	);
	const ds = ir.datasources[0];
	assert.equal(ds.tables[0].sql, 'SELECT * FROM t WHERE region = <[Parameters].[Region]>');
	assert.deepEqual(ds.extract, { enabled: false, hyperFiles: ['C:/Data/x.hyper'] });
	assert.equal(ir.issues[0].code, 'twb.custom-sql-parameter');
});

test('hierarchies are read top level first; a one-field path is left out', () => {
	const ir = buildWorkbookIR(
		wb(`<datasource inline='true' name='federated.h' version='18.1'>
		<connection class='hyper' dbname='x.hyper' />
		<column datatype='string' name='[Country]' role='dimension' type='nominal' />
		<column datatype='string' name='[State]' role='dimension' type='nominal' />
		<column datatype='string' name='[City]' role='dimension' type='nominal' />
		<drill-paths>
			<drill-path name='Location'><field>[Country]</field><field>[State]</field><field>[City]</field></drill-path>
			<drill-path name='Alone'><field>[City]</field></drill-path>
		</drill-paths>
	</datasource>`)
	);
	assert.deepEqual(ir.datasources[0].hierarchies, [{ name: 'Location', fields: ['[Country]', '[State]', '[City]'] }]);
	const none = buildWorkbookIR(wb(`<datasource inline='true' name='federated.n' version='18.1'><connection class='hyper' dbname='x.hyper' /></datasource>`));
	assert.equal(none.datasources[0].hierarchies, undefined);
});

test('buildDatasourceIR reads a .tds root', () => {
	const ds = buildDatasourceIR(fs.readFileSync(path.join(EXTERNAL, 'datasource_test.tds'), 'utf8'));
	assert.equal(ds.connections[0].class, 'postgres');
	assert.ok(!JSON.stringify(ds).includes('"username"'));
	assert.ok(ds.fields.length >= 3);
	assert.throws(() => buildDatasourceIR(wb('')), /Expected a Tableau datasource/);
});

test('real fixture: filtering.twb (2021.1 object model, set, set action)', () => {
	const ir = buildWorkbookIR(fs.readFileSync(path.join(EXTERNAL, 'filtering.twb'), 'utf8'), { sourceFile: 'filtering.twb' });
	const ds = ir.datasources[0];
	assert.equal(ds.caption, 'TestData (EmptyDB)');
	assert.deepEqual(ds.tables.map((t) => t.id), ['TestData_44D2C885FAEF453C846AC2CCD3577055']);
	assert.ok(ds.tables[0].columns.length > 10);
	assert.ok(ds.tables[0].columns.every((c) => c.tableId === ds.tables[0].id));
	const set = ds.fields.find((f) => f.id === '[BurstoutSet]');
	assert.deepEqual(set.set, { source: '[Burst Out Set list]', members: ['6112'] });
	assert.equal(ds.fields.find((f) => f.kind === 'count' && f.id.startsWith('[__tableau_internal')).name, 'TestData (Count)');
	assert.equal(ds.fields.find((f) => f.id === '[Calculation_88946136969252864]').formula, 'IF [BurstoutSet] THEN "Selected" ELSE "Not Selected" END');
	assert.ok(!JSON.stringify(ir).includes('ctest'));
	assert.ok(ir.issues.some((i) => i.code === 'twb.set-action'));
	assert.equal(ir.worksheets[1].pills['[federated.1df63xu0j2dvhd1e3sooz18pbrcc].[io:BurstoutSet:nk]'].derivation, 'InOut');
	assert.equal(ir.dashboards[0].zones.length, 2);
	assert.equal(ir.worksheets[0].title, 'Selection');
});

test('real fixture: multiple_connections.twb and old 9.x formats', () => {
	const multi = buildWorkbookIR(fs.readFileSync(path.join(EXTERNAL, 'multiple_connections.twb'), 'utf8'));
	assert.ok(multi.datasources.length >= 1);
	const old = buildWorkbookIR(fs.readFileSync(path.join(EXTERNAL, 'datasource_test.twb'), 'utf8'));
	const ds = old.datasources[0];
	assert.equal(ds.connections[0].id, 'default');
	assert.deepEqual(ds.tables.map((t) => [t.id, t.table]), [['xy', '[public].[xy]']]);
	assert.deepEqual(ds.fields.find((f) => f.id === '[x]').physical, { tableId: 'xy', remoteName: 'x' });
	assert.equal(ds.fields.find((f) => f.id === '[a]').name, 'A');
	assert.deepEqual(old.worksheets[1].colPills, ['[datasource_test].[sum:x:qk]']);
});

test('a sqlproxy connection keeps the published measures listed as class measure records', () => {
	const ir = buildWorkbookIR(
		wb(`<datasource caption='Adoption' inline='true' name='sqlproxy.1abc' version='18.1'>
			<repository-location id='Adoption' path='/t/site/datasources' revision='1.0' site='site' />
			<connection class='sqlproxy' dbname='Adoption' server='https://tableau.example.com'>
				<relation name='sqlproxy' table='[sqlproxy]' type='table' />
				<metadata-records>
					<metadata-record class='capability'><remote-name /><remote-type>0</remote-type><parent-name>[sqlproxy]</parent-name></metadata-record>
					<metadata-record class='column'><remote-name>ACCOUNTID</remote-name><remote-type>129</remote-type><local-name>[ACCOUNTID]</local-name><parent-name>[sqlproxy]</parent-name><ordinal>1</ordinal><local-type>string</local-type></metadata-record>
					<metadata-record class='measure'><remote-name>AU_QUARTER_CEG</remote-name><remote-type>131</remote-type><local-name>[AU_QUARTER_CEG]</local-name><parent-name>[sqlproxy]</parent-name><ordinal>2</ordinal><hidden>true</hidden><local-type>integer</local-type><aggregation>Sum</aggregation></metadata-record>
					<metadata-record class='measure'><remote-name>AU_QUARTER_CEG</remote-name><local-name>[AU_QUARTER_CEG]</local-name><parent-name>[sqlproxy]</parent-name><local-type>integer</local-type></metadata-record>
				</metadata-records>
			</connection>
			<column caption='AU lod' datatype='integer' name='[Calculation_1]' role='measure' type='quantitative'><calculation class='tableau' formula='{FIXED [ACCOUNTID] : MAX([AU_QUARTER_CEG])}' /></column>
		</datasource>`)
	);
	const ds = ir.datasources[0];
	assert.deepEqual(ds.tables[0].columns.map((c) => c.localName), ['[ACCOUNTID]', '[AU_QUARTER_CEG]']);
	const measure = ds.fields.find((f) => f.id === '[AU_QUARTER_CEG]');
	assert.deepEqual([measure.kind, measure.role, measure.datatype, measure.defaultAggregation], ['column', 'measure', 'integer', 'Sum']);
});

test('parameters a published datasource copy depends on are read when the workbook does not list them', () => {
	const param = (name, caption, value) => `<column caption='${caption}' datatype='string' name='[${name}]' param-domain-type='list' role='measure' type='nominal' value='&quot;${value}&quot;'><members><member value='&quot;GEO&quot;' /><member value='&quot;Area&quot;' /></members></column>`;
	const ir = buildWorkbookIR(
		wb(`<datasource hasconnection='false' inline='true' name='Parameters' version='18.1'>${param('Parameter 1', 'Show By', 'GEO')}</datasource>
		<datasource caption='Adoption' inline='true' name='sqlproxy.1abc' version='18.1'>
			<connection class='sqlproxy' dbname='Adoption' server='https://tableau.example.com'><relation name='sqlproxy' table='[sqlproxy]' type='table' /></connection>
			<column caption='View' datatype='string' name='[Calculation_1]' role='dimension' type='nominal'><calculation class='tableau' formula='[Parameters].[Parameter 16]' /></column>
			<datasource-dependencies datasource='Parameters'>${param('Parameter 1', 'Renamed', 'Area')}${param('Parameter 16', 'WS bundled', 'Area')}</datasource-dependencies>
		</datasource>`)
	);
	assert.deepEqual(ir.parameters.map((p) => [p.id, p.name, p.value]), [
		['[Parameters].[Parameter 1]', 'Show By', 'GEO'],
		['[Parameters].[Parameter 16]', 'WS bundled', 'Area']
	]);
	assert.equal(ir.datasources.length, 1);

	const tds = buildDatasourceIR(`<?xml version='1.0' encoding='utf-8' ?><datasource formatted-name='Adoption' inline='true' version='18.1'>
		<connection class='snowflake' dbname='DB' server='acme' />
		<datasource-dependencies datasource='Parameters'>${param('Parameter 4', 'Period', 'FPY')}</datasource-dependencies>
	</datasource>`);
	assert.deepEqual(tds.parameters.map((p) => [p.id, p.value]), [['[Parameters].[Parameter 4]', 'FPY']]);
	assert.equal(buildDatasourceIR(`<datasource formatted-name='x'><connection class='snowflake' /></datasource>`).parameters, undefined);
});
