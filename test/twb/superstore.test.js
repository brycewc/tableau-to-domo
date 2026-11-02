import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IR_VERSION } from '../../src/model/types.js';
import { openPackage } from '../../src/tableau/package.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const D = 'federated.0hgpf0j1fdpvv316shikk0mmdlec';
const P = (name) => `[${D}].[${name}]`;
const xml = fs.readFileSync(path.join(FIXTURES, 'superstore.twb'), 'utf8');
const ir = buildWorkbookIR(xml, { sourceFile: 'workbooks/superstore/source.twbx', info: { luid: 'abc-123', projectName: 'Sales' } });
const ds = ir.datasources.find((d) => d.id === D);
const field = (id) => ds.fields.find((f) => f.id === id);
const sheet = (name) => ir.worksheets.find((w) => w.name === name);

test('workbook info and top-level counts', () => {
	assert.equal(ir.irVersion, IR_VERSION);
	assert.deepEqual(ir.workbook, { name: 'source', luid: 'abc-123', projectName: 'Sales', sourceFile: 'workbooks/superstore/source.twbx', tableauVersion: '2023.3.0 (20233.23.1017.0901)' });
	assert.deepEqual(ir.datasources.map((d) => d.caption), ['Sample - Superstore', 'Sales Targets (Published)']);
	assert.equal(ir.parameters.length, 4);
	assert.equal(ir.worksheets.length, 9);
	assert.deepEqual(ir.dashboards.map((d) => d.name), ['Executive Overview', 'Details']);
	assert.ok(JSON.parse(JSON.stringify(ir)));
});

test('credentials are never copied', () => {
	const json = JSON.stringify(ir);
	for (const secret of ['hunter2', 'svc_tableau', 'PWD=', '"username"', '"password"']) assert.ok(!json.includes(secret), secret);
});

test('datasource: connection, extract, tables, relationships', () => {
	assert.deepEqual(ds.connections.map((c) => [c.id, c.class, c.server, c.dbname, c.port, c.schema]), [['sqlserver.1a2b3c4d5e6f7g8h9i0j', 'sqlserver', 'sql.example.com', 'Superstore', '1433', 'dbo']]);
	assert.deepEqual(ds.extract, { enabled: true, hyperFiles: ['Data/Extracts/superstore.hyper'] });
	assert.deepEqual(ds.tables.map((t) => [t.name, t.kind, t.columns.length]), [['Orders', 'table', 21], ['People', 'table', 2], ['Returns', 'custom-sql', 2]]);
	assert.equal(ds.tables[0].table, '[dbo].[Orders]');
	assert.match(ds.tables[2].sql, /\[Order Date\] > '2019-01-01'$/);
	assert.deepEqual(ds.tables[1].columns[1], { remoteName: 'Region', localName: '[Region (People)]', tableId: 'People_D73023733B004CC1B3CB1ACF62F4A965', localType: 'string', remoteType: '130', ordinal: 1 });
	assert.equal(ds.relationTree, undefined);
	assert.deepEqual(ds.relationships, [
		{ fromTableId: 'Orders_ECFCA1FB690A41FE803BC071773BA862', toTableId: 'People_D73023733B004CC1B3CB1ACF62F4A965', on: [{ left: '[Region]', right: '[Region (People)]' }] },
		{ fromTableId: 'Orders_ECFCA1FB690A41FE803BC071773BA862', toTableId: 'Returns_2AA0FADE3C8A4E1A9A4B4F8E1B2C3D4E', on: [{ left: '[Order ID]', right: '[Order ID (Returns)]' }] }
	]);
	assert.deepEqual(ds.filters.map((f) => [f.fieldId, f.include]), [['[Country/Region]', ['United States']]]);
});

test('datasource: fields of every kind', () => {
	const kinds = {};
	for (const f of ds.fields) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
	assert.deepEqual(kinds, { column: 25, calculated: 9, group: 1, bin: 2, count: 3, 'measure-names': 1, set: 2 });
	assert.equal(field('[Calculation_1368249927221915648]').formula, 'SUM([Profit])/SUM([Sales])');
	assert.equal(field('[Calculation_5571209093911105]').formula, 'IF [Sales] > 1000 THEN "Large"\nELSEIF [Sales] > 100 THEN "Medium"\nELSE "Small"\nEND');
	assert.equal(field('[Calculation_8462181273623541760]').formula, '{ FIXED [Customer Name] : SUM([Sales]) }');
	assert.equal(field('[Calculation_2979236347063238656]').formula, "DATEDIFF('day', [Order Date], [Ship Date])");
	assert.match(field('[Calculation_7290893416218234880]').formula, /\[Calculation_1368249927221915648\]/);
	assert.match(field('[Calculation_1047086431291338752]').formula, /\[Parameters\]\.\[Parameter 1\]/);
	assert.equal(field('[Calculation_6031853216591757312]').formula, 'RUNNING_SUM(SUM([Sales]))');
	assert.equal(field('[Region (group)]').group.otherLabel, 'Other');
	assert.deepEqual(field('[Sales (bin)]').bin, { source: '[Sales]', size: 500, peg: 0 });
	assert.equal(field('[Profit (bin)]').bin.size, '[Parameters].[Parameter 4]');
	assert.deepEqual(field('[Top Customers by Profit]').set, { source: '[Customer Name]', top: { count: 10, direction: 'top', by: 'SUM([Profit])' } });
	assert.deepEqual(field('[Business Segments]').set, { source: '[Segment]', members: ['Corporate', 'Home Office'] });
	assert.equal(field('[Category & Segment]').kind, 'calculated');
	assert.equal(field('[Action (Region)]'), undefined);
	assert.equal(field('[__tableau_internal_object_id__].[Orders_ECFCA1FB690A41FE803BC071773BA862]').name, 'Orders (Count)');
	assert.equal(field('[State/Province]').name, 'State');
	assert.equal(field('[State/Province]').semanticRole, '[State].[Name]');
	assert.equal(field('[Row ID]').hidden, true);
	assert.deepEqual(field('[Segment]').aliases, { 'Home Office': 'Small Business' });
	assert.deepEqual(field('[Region (People)]').physical, { tableId: 'People_D73023733B004CC1B3CB1ACF62F4A965', remoteName: 'Region' });
	assert.equal(field('[Sales]').role, 'measure');
	assert.equal(field('[Order Date]').type, 'ordinal');
	assert.equal(field('[Latitude (generated)]'), undefined);
});

test('published datasource reference', () => {
	const pub = ir.datasources[1];
	assert.deepEqual(pub.published, { repositoryId: 'SalesTargets', path: '/t/acme/datasources', site: 'acme', name: 'Sales Targets' });
	assert.equal(pub.connections[0].class, 'sqlproxy');
	assert.deepEqual(pub.fields.map((f) => f.id), ['[Category]', '[Sales Target]', '[Target Month]', '[Target Region]']);
});

test('parameters', () => {
	assert.deepEqual(
		ir.parameters.map((p) => [p.id, p.name, p.datatype, p.domain, p.value]),
		[
			['[Parameters].[Parameter 1]', 'Sales Target', 'real', 'range', 50000],
			['[Parameters].[Parameter 2]', 'Region Selector', 'string', 'list', 'East'],
			['[Parameters].[Parameter 3]', 'Start Date', 'date', 'all', '2023-01-01'],
			['[Parameters].[Parameter 4]', 'Top N', 'integer', 'range', 10]
		]
	);
	assert.deepEqual(ir.parameters[0].range, { min: 0, max: 100000, step: 1000 });
	assert.deepEqual(ir.parameters[1].members[2], { value: 'Central', alias: 'Central US' });
});

test('bar chart: shelves, color, filters, sort, title', () => {
	const ws = sheet('Sales by Category');
	assert.equal(ws.title, 'Sales by Category by Segment');
	assert.deepEqual(ws.colPills, [P('none:Category:nk')]);
	assert.deepEqual(ws.rowPills, [P('sum:Sales:qk')]);
	assert.equal(ws.panes[0].markClass, 'Bar');
	assert.deepEqual(ws.panes[0].encodings, { color: [P('none:Segment:nk')] });
	assert.equal(ws.panes[0].showLabels, true);
	const region = ws.filters.find((f) => f.fieldId === '[Region]');
	assert.deepEqual([region.kind, region.include, region.context, region.shownOnDashboard], ['categorical', ['East', 'West'], true, true]);
	assert.equal(ws.filters.find((f) => f.fieldId === '[Segment]').all, true);
	assert.deepEqual(ws.filters.find((f) => f.fieldId === '[Ship Mode]').exclude, ['Same Day']);
	assert.deepEqual(ws.sorts, [{ pillId: P('none:Category:nk'), kind: 'computed', direction: 'DESC', using: P('sum:Sales:qk') }]);
	assert.equal(ws.aggregated, true);
	assert.equal(ws.hidden, false);
});

test('line chart with month truncation and relative date / measure range filters', () => {
	const ws = sheet('Monthly Sales Trend');
	const date = ws.pills[P('tmn:Order Date:qk')];
	assert.deepEqual([date.derivation, date.dateTrunc, date.continuous], ['Month-Trunc', 'month', true]);
	assert.equal(ws.panes[0].markClass, 'Line');
	assert.equal(ws.panes[0].yAxisPill, P('sum:Sales:qk'));
	const rel = ws.filters.find((f) => f.kind === 'relative-date');
	assert.deepEqual(rel.relative, { periodType: 'month', first: -11, last: 0, includeNull: false });
	const q = ws.filters.find((f) => f.kind === 'quantitative');
	assert.deepEqual([q.min, q.max, q.aggregated], [-5000, 25000.5, true]);
});

test('crosstab with Measure Names / Measure Values and manual sort', () => {
	const ws = sheet('Sales Crosstab');
	assert.deepEqual(ws.rows, { op: 'nest', children: [{ op: 'pill', pillId: P('none:Category:nk') }, { op: 'pill', pillId: P('none:Sub-Category:nk') }] });
	assert.deepEqual(ws.colPills, [P('yr:Order Date:ok'), P(':Measure Names')]);
	assert.equal(ws.pills[P('yr:Order Date:ok')].datePart, 'year');
	assert.deepEqual(ws.measureValues, [P('sum:Sales:qk'), P('sum:Profit:qk')]);
	assert.deepEqual(ws.panes[0].encodings.text, ['[Multiple Values]']);
	assert.ok(!ws.filters.some((f) => f.fieldId === '[:Measure Names]'));
	const range = ws.filters.find((f) => f.kind === 'range-date');
	assert.deepEqual([range.min, range.max], ['2021-01-01', '2023-12-31T23:59:59']);
	assert.deepEqual(ws.sorts[0].order, ['Technology', 'Furniture', 'Office Supplies']);
});

test('pie, scatter, map and KPI', () => {
	const pie = sheet('Segment Share');
	assert.equal(pie.rows, null);
	assert.deepEqual(Object.keys(pie.panes[0].encodings), ['color', 'wedgeSize', 'label']);
	assert.deepEqual(pie.filters[0].wildcard, { pattern: 'son', mode: 'contains' });

	const scatter = sheet('Sales vs Profit');
	assert.equal(scatter.panes[0].markClass, 'Circle');
	assert.deepEqual(scatter.panes[0].encodings.size, [P('sum:Quantity:qk')]);
	assert.deepEqual(scatter.panes[0].encodings.detail, [P('none:Customer Name:nk')]);
	assert.equal(scatter.pills[P('io:Top Customers by Profit:nk')].derivation, 'InOut');
	assert.deepEqual(scatter.filters.find((f) => f.kind === 'top').top, { count: 20, direction: 'top', by: 'SUM([Profit])' });
	assert.equal(scatter.filters.find((f) => f.kind === 'condition').expression, 'SUM([Sales]) > 1000');

	const map = sheet('Profit by State');
	assert.equal(map.panes[0].markClass, 'Multipolygon');
	assert.deepEqual(map.rowPills, [P('Latitude (generated)')]);
	assert.equal(map.pills[P('usr:Calculation_1368249927221915648:qk')].aggregated, true);
	assert.equal(map.hidden, true);

	const kpi = sheet('Total Sales KPI');
	assert.equal(kpi.title, 'Total Sales\nAll regions');
	assert.deepEqual(kpi.titleRuns, [{ text: 'Total Sales', fontSize: 14 }, { text: '\n' }, { text: 'All regions' }]);
	assert.equal(kpi.hidden, true);
	assert.deepEqual(kpi.panes[0].encodings.text, [P('sum:Sales:qk')]);
});

test('dual axis with table calcs', () => {
	const ws = sheet('Sales and Profit Ratio');
	assert.equal(ws.rows.op, 'concat');
	assert.deepEqual(ws.panes.map((p) => [p.id, p.markClass, p.yAxisPill]), [
		[undefined, 'Automatic', undefined],
		['1', 'Bar', P('sum:Sales:qk')],
		['2', 'Line', P('usr:Calculation_1368249927221915648:qk')]
	]);
	assert.deepEqual(ws.pills[P('pcto:sum:Sales:qk')].tableCalc, { type: 'PctTotal', orderingType: 'Columns', attrs: { prefix: 'pcto' } });
	assert.deepEqual(ws.pills[P('usr:Calculation_6031853216591757312:qk')].tableCalc, { type: 'Calculation', orderingType: 'Field', orderFields: [P('tqr:Order Date:qk')] });
	assert.equal(ws.pills[P('tqr:Order Date:qk')].dateTrunc, 'quarter');
});

test('blend and shared filters', () => {
	const ws = sheet('Sales vs Target');
	assert.deepEqual(ws.datasourceIds, [D, 'sqlproxy.1k2j3h4g5f6d7s8a9q0w'], 'the primary (most shelf pills) comes first');
	assert.ok(ir.issues.some((i) => i.code === 'twb.blend' && i.object.name === 'Sales vs Target'));
	for (const w of ir.worksheets) assert.ok(w.filters.some((f) => f.fieldId === '[Ship Mode]'), w.name);
	for (const w of ir.worksheets) assert.equal(w.filters.find((f) => f.fieldId === '[Ship Mode]').shared, D, `${w.name}: the copy names its shared view`);
});

test('dashboards: sizes, zones, floating', () => {
	const [exec, details] = ir.dashboards;
	assert.deepEqual(exec.size, { mode: 'fixed', width: 1400, height: 900 });
	assert.deepEqual(exec.zones.map((z) => z.kind), ['title', 'filter', 'paramctrl', 'text', 'worksheet', 'worksheet', 'worksheet', 'worksheet', 'legend']);
	assert.equal(exec.zones[3].text, 'Superstore\nSales overview');
	assert.deepEqual(exec.zones[4].rect, { x: 0.008, y: 0.15, w: 0.492, h: 0.42 });
	assert.deepEqual(exec.floating.map((z) => [z.kind, z.worksheet]), [['worksheet', 'Total Sales KPI']]);
	assert.deepEqual(details.size, { mode: 'automatic' });
	assert.deepEqual(details.zones.map((z) => z.kind), ['worksheet', 'worksheet', 'worksheet', 'image', 'web', 'blank']);
	assert.deepEqual(details.floating.map((z) => [z.kind, z.param, z.mode]), [['paramctrl', '[Parameters].[Parameter 2]', 'dropdown']]);
});

test('issues', () => {
	const codes = ir.issues.map((i) => i.code).sort();
	assert.deepEqual(codes, ['twb.blend', 'twb.filter-action', 'twb.parameter-action', 'twb.published-datasource', 'twb.set-action', 'twb.shared-filter', 'twb.story'].sort());
	for (const issue of ir.issues) assert.ok(['info', 'warning', 'error'].includes(issue.severity) && issue.message);
});

test('the packaged .twbx yields the same IR', async () => {
	const pkg = await openPackage(path.join(FIXTURES, 'superstore.twbx'));
	try {
		const fromPkg = buildWorkbookIR(pkg.xml, { sourceFile: 'workbooks/superstore/source.twbx', info: { luid: 'abc-123', projectName: 'Sales' } });
		assert.deepEqual(fromPkg, ir);
		assert.ok(ds.extract.hyperFiles.every((f) => pkg.findEntry(f)));
	} finally {
		pkg.close();
	}
});
