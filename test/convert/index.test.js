import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const convertDir = fileURLToPath(new URL('../../src/convert/', import.meta.url));
const ready = ['cards.js', 'layout.js'].every((f) => fs.existsSync(convertDir + f));
const skip = ready ? false : 'cards.js or layout.js not written yet';

const DS = 'federated.abc';

function superstore() {
	return {
		irVersion: 1,
		workbook: { name: 'Superstore Sales', luid: 'LUID-1', sourceFile: 'x.twbx' },
		datasources: [
			{
				id: DS,
				caption: 'Superstore',
				connections: [],
				tables: [{ id: 'Orders', name: 'Orders', kind: 'extract', columns: [] }],
				relationships: [],
				fields: [
					{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' },
					{ id: '[Sales]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'column' },
					{ id: '[Calculation_1]', name: 'Sales x2', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales]) * 2' }
				],
				filters: []
			}
		],
		parameters: [],
		worksheets: [
			{
				name: 'Sales by Region',
				datasourceIds: [DS],
				pills: {
					[`[${DS}].[none:Region:nk]`]: { id: `[${DS}].[none:Region:nk]`, datasourceId: DS, fieldId: '[Region]', derivation: 'None', prefix: 'none', typeKey: 'nk', continuous: false, aggregated: false, datePart: null, dateTrunc: null },
					[`[${DS}].[sum:Sales:qk]`]: { id: `[${DS}].[sum:Sales:qk]`, datasourceId: DS, fieldId: '[Sales]', derivation: 'Sum', prefix: 'sum', typeKey: 'qk', continuous: true, aggregated: true, datePart: null, dateTrunc: null }
				},
				rows: { op: 'pill', pillId: `[${DS}].[none:Region:nk]` },
				cols: { op: 'pill', pillId: `[${DS}].[sum:Sales:qk]` },
				rowPills: [`[${DS}].[none:Region:nk]`],
				colPills: [`[${DS}].[sum:Sales:qk]`],
				panes: [{ markClass: 'Bar', encodings: {} }],
				filters: [],
				sorts: [],
				aggregated: true,
				measureValues: [],
				hidden: false
			}
		],
		dashboards: [],
		issues: [{ severity: 'info', code: 'ir.note', message: 'from extract' }]
	};
}

const manifest = {
	datasourceId: DS,
	strategy: 'hyper',
	tables: [
		{
			name: 'Extract',
			file: 'data/superstore/Extract.csv',
			columns: [
				{ name: 'Region', type: 'STRING' },
				{ name: 'Sales', type: 'DOUBLE' }
			],
			rowCount: 3,
			flattened: true
		}
	],
	issues: []
};

test('convertWorkbook assembles a DomoPlan', { skip }, async () => {
	const { convertWorkbook, resolveConvertOptions } = await import('../../src/convert/index.js');
	const events = [];
	const emitter = { step: (m) => events.push(m), info() {}, warn() {}, error() {}, done() {}, progress() {} };
	const now = new Date('2026-01-01T00:00:00Z');
	const plan = convertWorkbook(superstore(), { manifests: [manifest], options: { namePrefix: 'T: ', joins: undefined, target: 'pages' }, emitter, now });
	assert.equal(plan.planVersion, 1);
	assert.deepEqual(plan.source, { workbook: 'Superstore Sales', luid: 'LUID-1', irFile: 'ir.json' });
	assert.equal(plan.generatedAt, '2026-01-01T00:00:00.000Z');
	assert.equal(plan.options.joins, 'dataflow');
	assert.equal(plan.options.namePrefix, 'T: ');
	assert.equal(plan.options.pageTitle, 'T: Superstore Sales');
	assert.equal(plan.pages.find((p) => !p.parentKey)?.title, 'T: Superstore Sales');
	assert.equal(plan.datasets.length, 1);
	assert.equal(plan.datasets[0].key, 'luid-1.superstore');
	assert.equal(plan.beastModes.length, 0, 'no card uses the one calc');
	const unused = plan.issues.filter((i) => i.code === 'calc.unused');
	assert.equal(unused.length, 1);
	assert.equal(unused[0].severity, 'info');
	const all = convertWorkbook(superstore(), { manifests: [manifest], options: { target: 'pages', allBeastModes: true }, now });
	assert.equal(all.beastModes.length, 1);
	assert.equal(all.options.allBeastModes, true);
	assert.ok(!all.issues.some((i) => i.code === 'calc.unused'));
	assert.equal(plan.cards.filter((c) => c.worksheet === 'Sales by Region').length, 1);
	assert.equal(plan.cards[0].datasetKey, 'luid-1.superstore');
	assert.ok(Array.isArray(plan.pages));
	assert.ok(plan.issues.some((i) => i.code === 'ir.note'));
	assert.ok(events.length >= 4);
	assert.deepEqual(resolveConvertOptions({}).parameters, 'variables');
	assert.equal(resolveConvertOptions({ namePrefix: 'P ', pageTitle: 'Given' }, superstore()).pageTitle, 'Given');
	assert.equal(resolveConvertOptions({ namePrefix: 'P ' }, superstore()).pageTitle, 'P Superstore Sales');
});

test('an ir.json from before IR version 2 warns that the app gets none of the App Studio items', { skip }, async () => {
	const { convertWorkbook } = await import('../../src/convert/index.js');
	const { IR_VERSION } = await import('../../src/model/types.js');
	const warned = [];
	const emitter = { step() {}, info() {}, warn: (m) => warned.push(m), error() {}, done() {}, progress() {} };
	const old = convertWorkbook(superstore(), { manifests: [manifest], options: { target: 'app' }, emitter });
	const issue = old.issues.find((i) => i.code === 'convert.ir-outdated');
	assert.equal(issue.severity, 'warning');
	assert.match(issue.message, new RegExp(`IR version 1, now ${IR_VERSION}.*none of`));
	assert.match(issue.message, /none of the buttons, sections, story view, card click actions or workbook theme/);
	assert.match(issue.suggestion, /extract again/);
	assert.ok(warned.some((m) => /older t2d/.test(m)));
	assert.equal(convertWorkbook(superstore(), { manifests: [manifest], options: { target: 'pages' } }).issues.find((i) => i.code === 'convert.ir-outdated').severity, 'info');
	// The axis title issue ends the chain: it is the only one left once an older ir.json loses nothing else.
	const fresh = (ir) => !convertWorkbook(ir, { manifests: [manifest], options: { target: 'app' } }).issues.some((i) => i.code === 'convert.ir-outdated' && !/did not read axis titles/.test(i.message));
	assert.ok(fresh({ ...superstore(), irVersion: IR_VERSION }));
	const colorless = convertWorkbook({ ...superstore(), actions: [] }, { manifests: [manifest], options: { target: 'pages' } }).issues.find((i) => i.code === 'convert.ir-outdated');
	assert.equal(colorless.severity, 'info', 'a version 1 ir.json with the newer fields came from the newer parser');
	assert.match(colorless.message, /did not read the worksheets' colors/);
	const colored = convertWorkbook({ ...superstore(), irVersion: 3 }, { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated');
	assert.match(colored.message, /IR version 3.*did not read quick filter titles/);
	const paneColors = (w) => ({ ...w, panes: (w.panes ?? []).map((pane) => ({ ...pane, markColor: '#4e79a7' })) });
	assert.ok(fresh({ ...superstore(), irVersion: 2, worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...paneColors(w), markColor: '#4e79a7' })) }), 'a sheet with pane colors came from the newer parser');
	assert.ok(fresh({ ...superstore(), irVersion: 4 }), 'a version 4 ir.json without parameter controls loses nothing');
	const control = { id: 'p', kind: 'paramctrl', rect: { x: 0, y: 0, w: 0.2, h: 0.1 }, floating: false, param: '[Parameters].[P]' };
	const withControl = (title) => ({ ...superstore(), irVersion: 4, dashboards: [{ name: 'D', size: { mode: 'fixed', width: 800, height: 600 }, zones: [{ ...control, ...(title ? { title } : {}) }], floating: [] }] });
	const untitled = convertWorkbook(withControl(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated');
	assert.match(untitled.message, /IR version 4.*did not read parameter control titles/);
	assert.ok(fresh(withControl('Granularity')), 'a titled parameter control came from the newer parser');
	const labeled = (extra) => ({ ...superstore(), irVersion: 5, worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...w, panes: (w.panes ?? [{ markClass: 'Bar', encodings: {} }]).map((pane) => ({ ...pane, showLabels: true, ...extra })) })) });
	const unaligned = convertWorkbook(labeled(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated');
	assert.match(unaligned.message, /IR version 5.*did not read mark label alignment and color/);
	assert.ok(fresh(labeled({ labelColor: { mode: 'auto' } })), 'a pane with a label color came from the newer parser');
	assert.ok(fresh({ ...superstore(), irVersion: 6 }), 'a version 6 ir.json without two-calc pills loses nothing');
	const pareto = (secondary) => ({
		...superstore(),
		irVersion: 6,
		worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...w, pills: { ...w.pills, x: { id: 'x', fieldId: '[Sales]', tableCalc: { type: 'CumTotal', attrs: { prefix: 'pcto:cum' }, ...(secondary ? { secondary } : {}) } } } }))
	});
	assert.match(convertWorkbook(pareto(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 6.*secondary calculation/);
	assert.ok(fresh(pareto({ type: 'PctTotal' })));
	assert.ok(fresh({ ...superstore(), irVersion: 7 }), 'a version 7 ir.json without text member ranges loses nothing');
	const ranged = (collation) => {
		const ir = superstore();
		const [ds, ...rest] = ir.datasources;
		const field = ds.fields.find((f) => f.kind === 'column' && f.datatype === 'string');
		const filter = { pillId: `[${ds.id}].[none:${field.name}:nk]`, datasourceId: ds.id, fieldId: field.id, kind: 'categorical', ranges: [{ from: 'A', to: 'C' }] };
		return { ...ir, irVersion: 7, datasources: [{ ...ds, fields: ds.fields.map((f) => (f === field && collation ? { ...f, collation } : f)), filters: [...(ds.filters ?? []), filter] }, ...rest] };
	};
	assert.match(convertWorkbook(ranged(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 7.*did not read column collations/);
	assert.ok(fresh(ranged('LEN_RUS_S2')), 'a field with a collation came from the newer parser');
	const contains = () => {
		const ir = superstore();
		const [ds, ...rest] = ir.datasources;
		const calc = { id: '[Family]', name: 'Family', datatype: 'string', role: 'dimension', kind: 'calculated', formula: "CONTAINS([Region], 'st')" };
		return { ...ir, irVersion: 7, datasources: [{ ...ds, fields: [...ds.fields, calc] }, ...rest] };
	};
	assert.match(convertWorkbook(contains(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /CONTAINS, STARTSWITH, ENDSWITH, FIND and text comparisons stay case-sensitive/);
	assert.ok(fresh({ ...superstore(), irVersion: 8 }), 'a version 8 ir.json without pane-only member filters loses nothing');
	const paneOnly = () => {
		const ir = superstore();
		const ws = ir.worksheets[0];
		const pill = `[${ir.datasources[0].id}].[none:Pane Only:nk]`;
		const panes = [{ markClass: 'Bar', yAxisPill: 'a', encodings: { color: [pill] } }, { markClass: 'Line', yAxisPill: 'b', encodings: {} }];
		const filter = { pillId: pill, datasourceId: ir.datasources[0].id, fieldId: '[Pane Only]', kind: 'categorical', exclude: ['x'] };
		return { ...ir, irVersion: 8, worksheets: ir.worksheets.map((w) => (w === ws ? { ...w, panes, filters: [...(w.filters ?? []), filter] } : w)) };
	};
	assert.match(convertWorkbook(paneOnly(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 8.*did not read Hide filters/);
	assert.ok(fresh({ ...paneOnly(), irVersion: 9 }), 'a version 9 ir.json has the Hide filters');
	const fieldLink = (extra = {}) => ({ ...superstore(), irVersion: 9, actions: [{ id: '[U]', name: 'U', type: 'url', trigger: 'menu', source: { type: 'all' }, url: { template: 'https://x.test/<[Region]>', tokens: ['[Region]'], scheme: 'https' } }], ...extra });
	assert.match(convertWorkbook(fieldLink(), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 9.*did not read underlined headers/);
	assert.ok(fresh({ ...fieldLink(), worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...w, linkStyled: ['x'] })) }), 'an underlined header came from the newer parser');
	const cut = (truncated) => ({ ...superstore(), irVersion: 11, worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...w, color: { pillId: 'x', type: 'palette', members: [], truncated } })) });
	assert.match(convertWorkbook(cut(239), { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 11.*first 200 members of a color map/);
	assert.ok(fresh(cut(5000)), 'a map past the new cap is cut the same way');
	assert.ok(fresh({ ...superstore(), irVersion: 12 }), 'a version 12 ir.json without shared or set filters loses nothing');
	const unscoped = (extra) => ({ ...superstore(), irVersion: 12, ...extra });
	const shared = unscoped({ issues: [{ severity: 'info', code: 'twb.shared-filter', message: '', object: { type: 'datasource', name: 'x' } }] });
	assert.match(convertWorkbook(shared, { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 12.*which sheets a dashboard filter applies to/);
	const [ds] = superstore().datasources;
	const set = { id: '[Big Set]', name: 'Big Set', datatype: 'string', role: 'dimension', kind: 'set', set: { source: '[Region]', members: ['East'] } };
	const setFilter = { pillId: `[${ds.id}].[Big Set]`, datasourceId: ds.id, fieldId: '[Big Set]', kind: 'categorical', all: true };
	const withSet = unscoped({ datasources: [{ ...ds, fields: [...ds.fields, set] }], worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...w, filters: [...(w.filters ?? []), setFilter] })) });
	assert.match(convertWorkbook(withSet, { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /set filters that keep the set's members/);
	const shownFilter = { pillId: `[${ds.id}].[none:Region:nk]`, datasourceId: ds.id, fieldId: '[Region]', kind: 'categorical', all: true, shownOnDashboard: true };
	const withShown = { ...superstore(), irVersion: 14, worksheets: superstore().worksheets.map((w, i) => (i ? w : { ...w, filters: [...(w.filters ?? []), shownFilter] })) };
	assert.match(convertWorkbook(withShown, { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated').message, /IR version 14.*filter cards of each worksheet's own window/);
	const axisTitles = convertWorkbook({ ...superstore(), irVersion: 18 }, { manifests: [manifest], options: { target: 'app' } }).issues.find((i) => i.code === 'convert.ir-outdated');
	assert.equal(axisTitles.severity, 'info');
	assert.match(axisTitles.message, /IR version 18.*did not read axis titles, hidden axes and field labels, or turned-off tooltips/);
});

test('target app: Domo navigation is on unless domoNav is false (never with LEFT); every view gets a navigation icon', { skip }, async () => {
	const { convertWorkbook } = await import('../../src/convert/index.js');
	const { NAV_ICONS } = await import('../../src/domo/apps.js');
	const zone = { id: 'z1', kind: 'worksheet', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false, worksheet: 'Sales by Region' };
	const ir = { ...superstore(), irVersion: 2, dashboards: [{ name: 'Executive Summary', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone], floating: [] }] };
	const plan = convertWorkbook(ir, { manifests: [manifest], options: { target: 'app' } });
	assert.equal(plan.options.domoNav, true);
	assert.deepEqual(plan.app.navigation, { orientation: 'TOP', showDomoNavigation: true, showNavigation: true, showTitle: true });
	assert.deepEqual(plan.pages.map((pg) => [pg.title, pg.navIcon]), [['Executive Summary', 'summary-number']]);
	assert.ok(plan.pages.every((pg) => Object.hasOwn(NAV_ICONS, pg.navIcon)));
	assert.equal(convertWorkbook(ir, { manifests: [manifest], options: { target: 'app', domoNav: false } }).app.navigation.showDomoNavigation, false);
	assert.equal(convertWorkbook(ir, { manifests: [manifest], options: { target: 'app', domoNav: true, navOrientation: 'LEFT' } }).app.navigation.showDomoNavigation, false);
	assert.equal(convertWorkbook(ir, { manifests: [manifest], options: { target: 'pages' } }).app, undefined);
});

test('navIconFor picks an icon from the view title words; stories and the Worksheets view have their own', async () => {
	const { navIconFor } = await import('../../src/convert/index.js');
	const { NAV_ICONS } = await import('../../src/domo/apps.js');
	const cases = [
		['Executive Summary', 'summary-number'],
		['Sales Overview', 'summary-number'],
		['Home', 'home'],
		['Revenue Trends', 'money-universal'],
		['Trend over Time', 'chart-line'],
		['Regional Map', 'map-marker'],
		['Global Footprint', 'globe'],
		['Detailed Account View (Q)', 'table'],
		['Acme ARR', 'money-universal'],
		['AR Aging Analysis', 'money-universal'],
		['CasesPerEngineer', 'people'],
		['Case Metrics', 'checked-list'],
		['Customer Health', 'people'],
		['ChatBot', 'chat-bubbles'],
		['Escalation CPE', 'exclamation-triangle'],
		['Backlog', 'exclamation-triangle'],
		['Waterfall Quarter', 'chart-bar-vertical'],
		['Quarter', 'calendar'],
		['Settings', 'gear'],
		['Sales Forecast', 'money-universal'],
		['Forecast', 'forecast'],
		['Market Share', 'chart-pie'],
		['L3', 'analytics'],
		['', 'analytics']
	];
	assert.deepEqual(cases.map(([title]) => [title, navIconFor({ title, dashboard: title || 'x' })]), cases);
	assert.equal(navIconFor({ title: 'Quarterly Story', dashboard: '', story: 'Quarterly Story' }), 'presentation');
	assert.equal(navIconFor({ title: 'Worksheets', dashboard: '' }), 'list-bulleted');
	assert.ok(cases.every(([, icon]) => Object.hasOwn(NAV_ICONS, icon)) && ['presentation', 'list-bulleted'].every((i) => Object.hasOwn(NAV_ICONS, i)));
});
