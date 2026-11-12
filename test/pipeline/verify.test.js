import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkVdsAccess } from '../../src/cli/commands/doctor.js';
import { cardDetail } from '../../src/cli/commands/verify.js';
import { compareCardData, groupedColumns, matchColumns, normalizeMember, pageFilterOverrides, parseNumber, parseViewCsv, pivotMeasureValues, renderData, sampledRows, verifyWorkbook } from '../../src/pipeline/verify.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { samplePlan, tempDir, testConfig } from './helpers.js';

function render(columns, rows, { limited = false } = {}) {
	return {
		chart: {
			datasources: {
				ds: {
					limited,
					data: {
						columns: columns.map((c) => c.name),
						aliases: columns.map((c) => c.name),
						mappings: columns.map((c) => c.mapping),
						metadata: columns.map((c) => ({ type: c.type })),
						rows
					}
				}
			}
		}
	};
}

const regionSales = (rows, opts) =>
	renderData(
		render(
			[
				{ name: 'Region', mapping: 'ITEM', type: 'STRING' },
				{ name: 'Sales', mapping: 'VALUE', type: 'DOUBLE' }
			],
			rows,
			opts
		)
	);

test('parseNumber reads formatted Tableau values', () => {
	assert.deepEqual(parseNumber('4,065'), { value: 4065, decimals: 0 });
	assert.deepEqual(parseNumber('$1,234.50'), { value: 1234.5, decimals: 2 });
	assert.equal(parseNumber('(3)').value, -3);
	assert.equal(parseNumber('12.5%').value, 0.125);
	assert.equal(parseNumber('East'), null);
	assert.equal(parseNumber(''), null);
	assert.equal(parseNumber('1,23'), null);
});

test('normalizeMember folds nulls, case, numbers and dates', () => {
	assert.equal(normalizeMember(''), '(null)');
	assert.equal(normalizeMember(null), '(null)');
	assert.equal(normalizeMember('Null'), '(null)');
	assert.equal(normalizeMember(' East '), 'east');
	assert.equal(normalizeMember('2,024'), '2024');
	assert.equal(normalizeMember('007'), '007');
	assert.equal(normalizeMember('1/5/2024'), '2024-01-05');
	assert.equal(normalizeMember('2024-01-05T00:00:00'), '2024-01-05');
	assert.equal(normalizeMember(Date.UTC(2024, 0, 5), { type: 'DATE' }), '2024-01-05');
	assert.equal(normalizeMember('<a name="VOC496" href="https://x.test/items/496" target="_blank">VOC496</a>'), 'voc496', 'a link column compares by its text');
});

test('parseViewCsv strips the BOM and keeps quoted commas', () => {
	const { header, rows } = parseViewCsv('﻿Region,Sales\nEast,"4,065"\n');
	assert.deepEqual(header, ['Region', 'Sales']);
	assert.deepEqual(rows, [['East', '4,065']]);
});

test('matchColumns prefers exact labels, then ignores aggregation wording', () => {
	const { pairs, unmatched } = matchColumns(['"Avg Tenure"', 'Sales', 'Distinct count of Id', 'Missing'], ['Sum of Sales', '"Avg Tenure"', 'Distinct count of Id']);
	assert.deepEqual(pairs, [
		{ domo: 0, tableau: 1 },
		{ domo: 1, tableau: 0 },
		{ domo: 2, tableau: 2 }
	]);
	assert.deepEqual(unmatched, [3]);
});

test('pivotMeasureValues turns long measure data wide', () => {
	const out = pivotMeasureValues({
		header: ['Region', 'Measure Names', 'Measure Values'],
		rows: [
			['East', 'Sum of Sales', '10'],
			['East', 'Sum of Profit', '2'],
			['West', 'Sum of Sales', '5']
		]
	});
	assert.deepEqual(out.header, ['Region', 'Sum of Sales', 'Sum of Profit']);
	assert.deepEqual(out.rows, [
		['East', '10', '2'],
		['West', '5', '']
	]);
});

test('renderData classifies numeric value columns as measures', () => {
	const d = regionSales([['East', 1]]);
	assert.deepEqual(
		d.columns.map((c) => c.role),
		['dimension', 'measure']
	);
	const year = renderData(render([{ name: 'Year', mapping: 'ITEM', type: 'LONG' }], [[2024]]));
	assert.equal(year.columns[0].role, 'dimension');
	assert.equal(renderData({}), null);
});

test('renderData: a grouped numeric column is a dimension, and rows at the render limit are limited', () => {
	const card = {
		body: {
			definition: {
				subscriptions: {
					main: {
						columns: [{ column: 'FY', alias: 'FY ' }, { column: 'calculation_1', formulaId: 'calculation_1' }, { column: 'Amount' }],
						groupBy: [{ column: 'FY' }, { column: 'calculation_1', formulaId: 'calculation_1' }]
					}
				}
			}
		}
	};
	assert.deepEqual([...groupedColumns(card)], ['FY', 'FY ', 'calculation_1']);
	const raw = render([{ name: 'FY ', mapping: 'VALUE', type: 'LONG' }, { name: 'Amount', mapping: 'VALUE', type: 'DOUBLE' }], [[2026, 1], [2025, 2]]);
	const d = renderData(raw, { grouped: groupedColumns(card) });
	assert.deepEqual(d.columns.map((c) => c.role), ['dimension', 'measure']);
	assert.equal(d.limited, false);
	raw.chart.datasources.ds.data.limit = 2;
	assert.equal(renderData(raw).limited, true);
});

test('compareCardData compares measure columns pivoted on a Tableau dimension with the Tableau measure per member', () => {
	const tableau = {
		header: ['Region', 'Segment', 'Sales'],
		rows: [['East', 'Retail', '10'], ['East', 'Online', '4'], ['West', 'Retail', '5'], ['All', 'All', '19']]
	};
	const domo = renderData(
		render(
			[{ name: 'Region', mapping: 'ITEM', type: 'STRING' }, { name: 'Retail', mapping: 'VALUE', type: 'DOUBLE' }, { name: 'Online', mapping: 'VALUE', type: 'DOUBLE' }],
			[['East', 10, 4], ['West', 5, 0]]
		)
	);
	const cmp = compareCardData({ tableau, domo });
	assert.equal(cmp.status, 'ok');
	assert.deepEqual(cmp.columns.filter((c) => c.role === 'measure').map((c) => [c.domo, c.tableau, c.tableauTotal, c.domoTotal]), [
		['Retail', 'Sales where Segment = Retail', 15, 15],
		['Online', 'Sales where Segment = Online', 4, 4]
	]);
	domo.rows[0][1] = 20;
	assert.equal(compareCardData({ tableau, domo }).status, 'differs');
});

test('pageFilterOverrides keeps the page filters on the card dataset that reach the card', () => {
	const card = { key: 'c1', datasetKey: 'orders' };
	const page = {
		filters: [
			{ column: 'FY', dataType: 'numeric', operand: 'IN', values: ['2026'], filterType: 'LEGACY', dataSourceId: { $ref: 'dataset:orders' }, sourceCard: 'f1' },
			{ column: 'FY', dataType: 'numeric', operand: 'IN', values: ['2025'], filterType: 'LEGACY', dataSourceId: { $ref: 'dataset:other' } },
			{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East'], filterType: 'LEGACY', dataSourceId: { $ref: 'dataset:orders' }, affectedCards: ['c2'] }
		]
	};
	assert.deepEqual(pageFilterOverrides(card, page), [{ column: 'FY', dataType: 'numeric', operand: 'IN', values: ['2026'] }]);
	assert.deepEqual(pageFilterOverrides(card, undefined), []);
});

test('compareCardData leaves out Tableau total rows ("All") the Domo card does not show', () => {
	const tableau = { header: ['Region', 'Sum of Sales'], rows: [['East', '10'], ['West', '5'], ['All', '15']] };
	const cmp = compareCardData({ tableau, domo: regionSales([['East', 10], ['West', 5]]) });
	assert.equal(cmp.status, 'ok');
	assert.equal(cmp.rows.tableau, 2);
	assert.match(cmp.notes.join(' '), /1 Tableau total row/);
	const withAll = compareCardData({ tableau, domo: regionSales([['East', 10], ['West', 5], ['All', 15]]) });
	assert.equal(withAll.rows.tableau, 3);
});

const tableauView = { header: ['Region', 'Sum of Sales'], rows: [['East', '1,000.5'], ['West', '20']] };

test('compareCardData: matching data is ok, within display rounding', () => {
	const cmp = compareCardData({ tableau: tableauView, domo: regionSales([['East', 1000.46], ['West', 20.02]]) });
	assert.equal(cmp.status, 'ok');
	assert.deepEqual(cmp.rows, { tableau: 2, domo: 2, ok: true });
	assert.equal(cmp.score, 1);
	const sales = cmp.columns.find((c) => c.role === 'measure');
	assert.equal(sales.tableauTotal, 1020.5);
	assert.equal(sales.ok, true);
});

test('compareCardData: different totals and members differ', () => {
	const cmp = compareCardData({ tableau: tableauView, domo: regionSales([['East', 900], ['North', 20]]) });
	assert.equal(cmp.status, 'differs');
	const region = cmp.columns.find((c) => c.role === 'dimension');
	assert.deepEqual(region.missingInDomo, ['west']);
	assert.deepEqual(region.extraInDomo, ['north']);
	assert.equal(cmp.columns.find((c) => c.role === 'measure').ok, false);
	const detail = cardDetail({ ...cmp, notes: [] });
	assert.match(detail, /DIFFERS/);
	assert.match(detail, /only Domo: north/);
});

test('compareCardData: a tolerance absorbs small total differences', () => {
	const domo = regionSales([['East', 1010], ['West', 20]]);
	assert.equal(compareCardData({ tableau: tableauView, domo }).status, 'differs');
	assert.equal(compareCardData({ tableau: tableauView, domo, tolerance: 0.01 }).status, 'ok');
});

test('compareCardData: sampled data only checks that Domo stays within Tableau', () => {
	const ok = compareCardData({ tableau: tableauView, domo: regionSales([['East', 3]]), sampled: 1000 });
	assert.equal(ok.status, 'ok');
	assert.equal(ok.rows.ok, true);
	assert.equal(ok.columns.find((c) => c.role === 'dimension').ok, true);
	assert.equal(ok.columns.find((c) => c.role === 'measure').compared, false);
	assert.ok(ok.notes.some((n) => /sampled data \(1000 rows per table\)/.test(n)));
	const extra = compareCardData({ tableau: tableauView, domo: regionSales([['South', 3]]), sampled: 1000 });
	assert.equal(extra.status, 'differs');
});

test('sampledRows: push-time --sample-rows sampling counts, on the card dataset or on any dataset a dataflow builds it from', () => {
	const plan = {
		datasets: [{ key: 'wb.orders' }, { key: 'wb.people' }, { key: 'wb.joined' }, { key: 'wb.calcs' }],
		dataflows: [
			{ key: 'f1', outputDatasetKeys: ['wb.joined'], definition: { actions: [{ dataSourceId: { $ref: 'dataset:wb.orders' } }, { dataSourceId: { $ref: 'dataset:wb.people' } }] } },
			{ key: 'f2', outputDatasetKeys: ['wb.calcs'], definition: { actions: [{ dataSourceId: { $ref: 'dataset:wb.joined' } }] } }
		]
	};
	const state = { objects: { 'dataset:wb.people': { id: 'p', extra: { sampled: 500 } } } };
	assert.equal(sampledRows(plan, 'wb.calcs', [], state), 500);
	assert.equal(sampledRows(plan, 'wb.orders', [], state), undefined);
	assert.equal(sampledRows(plan, 'wb.orders', [], { objects: { 'dataset:wb.orders': { extra: { sampled: 20 } } } }), 20);
	assert.equal(sampledRows(plan, 'wb.calcs', [], { objects: {} }), undefined);
});

test('compareCardData: no shared columns is not comparable', () => {
	const cmp = compareCardData({ tableau: { header: ['A', 'B'], rows: [] }, domo: regionSales([]) });
	assert.equal(cmp.status, 'not-comparable');
	assert.equal(cmp.score, 0);
});

async function pushedWorkspace({ sampled } = {}) {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	const plan = samplePlan();
	plan.source.luid = 'wb-luid';
	plan.pages = [
		{ key: 'root', title: 'Sales', dashboard: '' },
		{ key: 'dash', title: 'Overview', parentKey: 'root', dashboard: 'Overview' }
	];
	plan.cards.push({ key: 'filter-region', title: 'Region', worksheet: '', datasetKey: 'orders', chartType: 'badge_dropdown_selector', body: {}, pageKeys: ['dash'], status: 'ok' });
	plan.cards.push({ key: 'hidden', title: 'Hidden', worksheet: 'Hidden sheet', datasetKey: 'orders', chartType: 'badge_vert_bar', body: {}, pageKeys: ['dash'], status: 'ok' });
	if (sampled) plan.datasets[0].upload.sampled = sampled;
	await ws.writeJson(p.plan, plan);
	await ws.writeJson(ws.stateFile('acme'), {
		instance: 'acme',
		objects: { 'card:sheet-1': { id: 101 }, 'card:filter-region': { id: 103 }, 'card:hidden': { id: 104 } }
	});
	return { root, ws, p };
}

function fakes(views, csvByView, renders) {
	const calls = [];
	const tableau = {
		download: async (relPath, file) => {
			calls.push(['download', relPath]);
			const id = relPath.split('/')[2];
			if (!csvByView[id]) throw new Error('403 no summary data');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, csvByView[id]);
			return { file };
		}
	};
	const domo = {
		instance: 'acme',
		put: async (relPath, body, opts) => {
			calls.push(['put', relPath, opts.query.parts, body.queryOverrides]);
			const id = Number(relPath.split('/')[5]);
			return renders[id];
		}
	};
	return { calls, deps: { tableau, domo, listViews: async () => views } };
}

test('verifyWorkbook compares pushed cards and writes verify.json', async () => {
	const { root, p } = await pushedWorkspace();
	const { calls, deps } = fakes([{ id: 'v1', name: 'Sheet 1' }], { v1: 'Region,Sum of Sales\nEast,10\nWest,5\n' }, { 101: render([{ name: 'Region', mapping: 'ITEM', type: 'STRING' }, { name: 'Sales', mapping: 'VALUE', type: 'DOUBLE' }], [['East', 10], ['West', 5]]) });
	const summary = await verifyWorkbook({ config: testConfig(root), slug: 'sales', deps });
	const by = Object.fromEntries(summary.cards.map((c) => [c.key, c]));
	assert.equal(by['sheet-1'].status, 'ok');
	assert.equal(by['sheet-1'].view, 'Sheet 1');
	assert.equal(by['sheet-2'].status, 'not-comparable');
	assert.match(by['sheet-2'].notes[0], /not pushed to acme/);
	assert.match(by['filter-region'].notes[0], /filter card/);
	assert.match(by.hidden.notes[0], /not published as a view/);
	assert.deepEqual(summary.counts, { ok: 1, differs: 0, 'not-comparable': 3 });
	assert.equal(summary.ok, true);
	assert.ok(calls.every((c) => c[0] === 'download' || c[0] === 'put'));
	assert.ok(calls.some((c) => c[0] === 'put' && c[1] === '/content/v1/cards/kpi/101/render' && c[2] === 'dynamic,summary'));
	assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, 'verify.json'), 'utf8')).counts.ok, 1);
});

test('verifyWorkbook flags pushed app views that have a title-less page search entry', async () => {
	const { root, ws } = await pushedWorkspace();
	const state = await ws.readJson(ws.stateFile('acme'));
	state.objects['page:root'] = { id: 7, extra: { container: 'app', appId: 5 } };
	state.objects['page:dash'] = { id: 8, extra: { container: 'app', appId: 5 } };
	await ws.writeJson(ws.stateFile('acme'), state);
	const { deps } = fakes([{ id: 'v1', name: 'Sheet 1' }], { v1: 'Region\nEast\n' }, { 101: render([{ name: 'Region', mapping: 'ITEM', type: 'STRING' }], [['East']]) });
	const queried = [];
	deps.domo.post = async (relPath, body) => {
		queried.push(body.filters[0].value);
		return { searchObjects: body.filters[0].value === '8' ? [{ entityType: 'page', databaseId: '8', owners: [], lastModified: 0 }] : [] };
	};
	const summary = await verifyWorkbook({ config: testConfig(root), slug: 'sales', keys: ['sheet-1'], deps });
	assert.deepEqual(queried, ['7', '8']);
	assert.deepEqual(summary.searchStubs, [{ viewId: '8', key: 'dash', title: 'Overview' }]);
});

test('verifyWorkbook matches a hidden worksheet to its dashboard view by columns and flags sampled data', async () => {
	const { root } = await pushedWorkspace({ sampled: 100 });
	const { deps } = fakes(
		[{ id: 'd1', name: 'Overview' }],
		{ d1: 'Region,Sum of Sales\nEast,10\nWest,5\n' },
		{
			101: render([{ name: 'Category', mapping: 'ITEM', type: 'STRING' }, { name: 'Profit', mapping: 'VALUE', type: 'DOUBLE' }], [['A', 1]]),
			104: render([{ name: 'Region', mapping: 'ITEM', type: 'STRING' }, { name: 'Sales', mapping: 'VALUE', type: 'DOUBLE' }], [['East', 1]])
		}
	);
	const summary = await verifyWorkbook({ config: testConfig(root), slug: 'sales', deps });
	const by = Object.fromEntries(summary.cards.map((c) => [c.key, c]));
	assert.equal(by.hidden.status, 'ok');
	assert.equal(by.hidden.view, 'Overview');
	assert.equal(by.hidden.sampled, 100);
	assert.match(by['sheet-1'].notes.join(' '), /holds another sheet/);
	assert.equal(summary.sampled, 100);
});

test('verifyWorkbook reports a failed view download as not comparable', async () => {
	const { root } = await pushedWorkspace();
	const { deps } = fakes([{ id: 'v1', name: 'Sheet 1' }], {}, { 101: render([{ name: 'Region', mapping: 'ITEM', type: 'STRING' }], [['East']]) });
	const summary = await verifyWorkbook({ config: testConfig(root), slug: 'sales', keys: ['sheet-1'], deps });
	assert.equal(summary.cards.length, 1);
	assert.equal(summary.cards[0].status, 'not-comparable');
	assert.match(summary.cards[0].notes.join(' '), /Tableau view data failed: 403 no summary data/);
});

test('verifyWorkbook renders a card with the default filters of its view', async () => {
	const { root, ws, p } = await pushedWorkspace();
	const plan = await ws.readJson(p.plan);
	plan.pages[1].filters = [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East'], filterType: 'LEGACY', dataSourceId: { $ref: 'dataset:orders' } }];
	await ws.writeJson(p.plan, plan);
	const { calls, deps } = fakes([{ id: 'd1', name: 'Overview' }], { d1: 'Region,Sum of Sales\nEast,10\n' }, { 104: render([{ name: 'Region', mapping: 'ITEM', type: 'STRING' }, { name: 'Sales', mapping: 'VALUE', type: 'DOUBLE' }], [['East', 10]]) });
	const summary = await verifyWorkbook({ config: testConfig(root), slug: 'sales', keys: ['hidden'], deps });
	const hidden = summary.cards.find((c) => c.key === 'hidden');
	assert.equal(hidden.status, 'ok');
	assert.match(hidden.notes.join(' '), /default filters of view "Overview": Region IN East/);
	const put = calls.find((c) => c[0] === 'put' && c[1].includes('/104/'));
	assert.deepEqual(put[3].filters, [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East'] }]);
	assert.ok(put[3].limit > 10000);
});

test('verifyWorkbook needs a plan with a Tableau workbook luid', async () => {
	const root = tempDir();
	await assert.rejects(verifyWorkbook({ config: testConfig(root), slug: 'nope', deps: { domo: { instance: 'acme' } } }), /No plan/);
	const ws = openWorkspace(root);
	await ws.writeJson(ws.paths('sales').plan, samplePlan());
	await assert.rejects(verifyWorkbook({ config: testConfig(root), slug: 'sales', deps: { domo: { instance: 'acme' } } }), /no Tableau workbook luid/);
});

test('doctor checkVdsAccess reads metadata of the first datasource and explains 403800', async () => {
	const calls = [];
	const client = {
		get: async (relPath, query) => {
			calls.push(['get', relPath, query]);
			return { datasources: { datasource: [{ id: 'ds1', name: 'Orders' }] } };
		},
		vds: async (endpoint, body) => {
			calls.push(['vds', endpoint, body]);
			return { data: [{ fieldName: 'a', fieldCaption: 'A' }] };
		}
	};
	assert.match(await checkVdsAccess(client), /read-metadata ok on "Orders" \(1 field/);
	assert.deepEqual(calls[1], ['vds', 'read-metadata', { datasource: { datasourceLuid: 'ds1' } }]);
	assert.ok(!calls.some((c) => c[1] === 'query-datasource'));

	const denied = {
		get: async () => ({ datasource: { name: 'Secret' } }),
		vds: async () => {
			throw Object.assign(new Error('Tableau 403800: VIZQL_DATA_API_ACCESS'), { code: '403800' });
		}
	};
	await assert.rejects(checkVdsAccess(denied, { datasource: 'ds2' }), /403800 on "Secret": the API Access capability is missing or the datasource does not exist/);
	assert.deepEqual(await checkVdsAccess({ get: async () => ({ datasources: {} }) }), { skipped: 'no published datasources on the site' });
});

test('t2d verify rejects a bad --tolerance as a usage error', async () => {
	const { main } = await import('../../src/cli/main.js');
	const err = [];
	const io = { stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) }, env: { NO_COLOR: '1' }, loadConfig: () => testConfig(tempDir()) };
	assert.equal(await main(['verify', '--workbook', 'x', '--tolerance', 'abc'], io), 2);
	assert.match(err.join(''), /--tolerance must be a non-negative percentage/);
});
