import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SelectionError } from '../../src/convert/select.js';
import { migrateBatch, renderBatchReport } from '../../src/pipeline/batch.js';
import { convertStage } from '../../src/pipeline/convert.js';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { adoptPreviousKeys } from '../../src/pipeline/push.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { filterCardFor } from '../../src/convert/layout.js';
import { tempDir, testConfig } from './helpers.js';

const LUID = '11111111-2222-3333-4444-555555555555';

function publishedIR(name, { calcFormula = 'SUM([Sales]) / COUNT([Region])', caption = 'Orders (Published)' } = {}) {
	return {
		irVersion: 1,
		workbook: { name, sourceFile: '' },
		datasources: [
			{
				id: `sqlproxy.${name.toLowerCase()}`,
				caption,
				published: { luid: LUID, name: 'Orders' },
				connections: [{ id: 'default', class: 'sqlproxy', extra: {} }],
				tables: [],
				relationships: [],
				fields: [
					{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' },
					{ id: '[Sales]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'column' },
					{ id: '[Calculation_1]', name: 'Ratio', datatype: 'real', role: 'measure', kind: 'calculated', formula: calcFormula }
				],
				filters: []
			}
		],
		parameters: [],
		worksheets: [
			{
				name: 'Sheet 1',
				datasourceIds: [`sqlproxy.${name.toLowerCase()}`],
				pills: {},
				rows: null,
				cols: null,
				rowPills: [],
				colPills: [],
				panes: [],
				filters: [],
				sorts: [],
				aggregated: true,
				measureValues: [],
				hidden: false
			}
		],
		dashboards: [],
		issues: []
	};
}

function stubs(calls, irs) {
	return {
		client: { TableauClient: class {} },
		content: {
			findWorkbook: async (_c, name) => ({ id: `wb-${name}`, name, project: { name: 'Finance' } }),
			findDatasource: async (_c, { luid }) => ({ id: luid, updatedAt: '2026-10-01T00:00:00Z' }),
			downloadWorkbook: async (_c, luid, dir) => {
				const file = path.join(dir, 'wb.twb');
				fs.writeFileSync(file, '<workbook/>');
				return { file };
			}
		},
		metadata: { fetchWorkbookMetadata: async () => null, applyMetadata: () => {} },
		package: { openPackage: async () => ({ kind: 'twb', xml: '<workbook/>', close: () => {} }) },
		twb: { buildWorkbookIR: (_xml, { info }) => structuredClone(irs[info.name]) },
		data: {
			datasourceSlug: (ds) => ds.caption.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
			extractData: async ({ datasource, dir, slug, strategy, skipViewCsv }) => {
				calls.push({ dir, slug, strategy, skipViewCsv, id: datasource.id });
				const dataDir = path.join(dir, 'data', slug);
				fs.mkdirSync(dataDir, { recursive: true });
				fs.writeFileSync(path.join(dataDir, 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
				datasource.fields.push({ id: '[Published Calc]', name: 'Published Calc', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([Sales])' });
				return {
					datasourceId: datasource.id,
					strategy: 'vds',
					tables: [
						{
							name: 'Orders',
							file: `data/${slug}/orders.csv`,
							columns: [
								{ name: 'Region', type: 'STRING', sourceName: 'Region' },
								{ name: 'Sales', type: 'DOUBLE', sourceName: 'Sales' }
							],
							rowCount: 2,
							flattened: true
						}
					],
					issues: [{ severity: 'info', code: 'data.vds', message: 'via vds', object: { type: 'datasource', name: datasource.caption, id: datasource.id } }]
				};
			}
		}
	};
}

const tableauClient = { signIn: async () => {}, signOut: async () => {} };

test('a published datasource used by two workbooks is extracted once and shared', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	const calls = [];
	const irs = { Alpha: publishedIR('Alpha'), Beta: publishedIR('Beta', { caption: 'Orders renamed' }) };
	const sharedCache = new Map();
	const a = await extractWorkbook({ config, workbook: 'Alpha', client: tableauClient, sharedCache, deps: stubs(calls, irs) });
	const b = await extractWorkbook({ config, workbook: 'Beta', client: tableauClient, sharedCache, deps: stubs(calls, irs) });
	assert.equal(calls.length, 1, 'the shared datasource is extracted once');
	const ws = openWorkspace(root);
	assert.equal(calls[0].dir, ws.sharedPaths(LUID).dir);
	assert.equal(calls[0].skipViewCsv, true);

	const [ma] = a.manifests;
	const [mb] = b.manifests;
	assert.equal(ma.shared.luid, LUID);
	assert.equal(ma.shared.reused, false);
	assert.equal(mb.shared.reused, true);
	assert.equal(mb.datasourceId, 'sqlproxy.beta');
	assert.equal(mb.issues.find((i) => i.code === 'data.vds').object.id, 'sqlproxy.beta');
	assert.ok(mb.issues.some((i) => i.code === 'data.shared-reused'));
	const file = path.resolve(ws.paths(b.slug).dir, mb.tables[0].file);
	assert.equal(file, path.join(ws.sharedPaths(LUID).dir, 'data', 'datasource', 'orders.csv'));
	assert.ok(fs.existsSync(file));
	assert.ok(b.ir.datasources[0].fields.some((f) => f.id === '[Published Calc]'), 'published fields are merged into every workbook');

	const again = [];
	await extractWorkbook({ config, workbook: 'Beta', client: tableauClient, deps: stubs(again, irs) });
	assert.equal(again.length, 0, 'unchanged on Tableau: reused from disk');
	await extractWorkbook({ config, workbook: 'Beta', client: tableauClient, refreshShared: true, deps: stubs(again, irs) });
	assert.equal(again.length, 1, '--refresh-data extracts again');
});

test('shared datasets get one site-scoped key; same calcs share a beast mode, differing ones are renamed', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	const irs = { Alpha: publishedIR('Alpha'), Beta: publishedIR('Beta'), Gamma: publishedIR('Gamma', { calcFormula: 'SUM([Sales]) * 2' }) };
	const sharedCache = new Map();
	const slugs = [];
	for (const name of ['Alpha', 'Beta', 'Gamma']) {
		const { slug } = await extractWorkbook({ config, workbook: name, client: tableauClient, sharedCache, deps: stubs([], irs) });
		slugs.push(slug);
	}
	const plans = [];
	for (const slug of slugs) plans.push(await convertStage({ config, slug, options: { allBeastModes: true } }));
	const key = `pds-${LUID}`;
	for (const plan of plans) {
		const ds = plan.datasets.find((d) => d.cardTarget);
		assert.equal(ds.key, key);
		assert.equal(ds.name, 'Orders');
		assert.deepEqual(ds.shared, { luid: LUID, name: 'Orders' });
		assert.match(ds.previousKey, /^(alpha|beta|gamma)\.orders-published$/);
	}
	const ratio = (plan) => plan.beastModes.find((bm) => bm.tableauFieldId === '[Calculation_1]');
	const [a, b, g] = plans.map(ratio);
	assert.equal(a.key, b.key);
	assert.equal(a.legacyId, b.legacyId);
	assert.equal(a.name, 'Ratio');
	assert.equal(b.name, 'Ratio');
	assert.notEqual(g.key, a.key);
	assert.notEqual(g.legacyId, a.legacyId);
	assert.equal(g.name, 'Ratio (Gamma)');
	assert.ok(plans[2].issues.some((i) => i.code === 'calc.shared-conflict'));
	assert.ok(!plans[0].issues.some((i) => i.code === 'calc.shared-conflict'));

	const registry = JSON.parse(fs.readFileSync(openWorkspace(root).sharedPaths(LUID).beastModes, 'utf8'));
	const variants = registry.datasets[key].filter((v) => v.fieldId === '[Calculation_1]');
	assert.equal(variants.length, 2);
	assert.deepEqual(variants.find((v) => !v.renamed).workbooks, [slugs[0], slugs[1]]);

	const reconverted = await convertStage({ config, slug: slugs[0], options: { allBeastModes: true } });
	assert.equal(ratio(reconverted).name, 'Ratio', 'converting again keeps the first workbook\'s name');
	const published = reconverted.beastModes.find((bm) => bm.tableauFieldId === '[Published Calc]');
	assert.equal(published.key, plans[1].beastModes.find((bm) => bm.tableauFieldId === '[Published Calc]').key);

	const pruned = await convertStage({ config, slug: slugs[1] });
	assert.equal(ratio(pruned), undefined, 'no card of Beta uses the calc');
	assert.ok(pruned.issues.some((i) => i.code === 'calc.unused' && i.object.name === 'Ratio'));
	const left = JSON.parse(fs.readFileSync(openWorkspace(root).sharedPaths(LUID).beastModes, 'utf8')).datasets[key];
	assert.deepEqual(left.find((v) => v.fieldId === '[Calculation_1]' && !v.renamed).workbooks, [slugs[0]], 'the shared variant keeps the workbook that still plans it');
});

test('push adopts state entries recorded under the workbook-scoped key', () => {
	const plan = {
		datasets: [{ key: 'pds-x', previousKey: 'wb.orders' }],
		dataflows: [],
		beastModes: [
			{ key: 'pds-x.calc', previousKey: 'wb.orders.calc' },
			{ key: 'pds-x.other', previousKey: 'wb.orders.other' }
		]
	};
	const state = {
		objects: {
			'dataset:wb.orders': { id: 'ds-1' },
			'beastmode:wb.orders.calc': { id: 7 },
			'beastmode:pds-x.other': { id: 8 },
			'beastmode:wb.orders.other': { id: 9 }
		}
	};
	assert.deepEqual(adoptPreviousKeys(plan, state), [
		{ from: 'dataset:wb.orders', to: 'dataset:pds-x' },
		{ from: 'beastmode:wb.orders.calc', to: 'beastmode:pds-x.calc' }
	]);
	assert.equal(state.objects['dataset:pds-x'].id, 'ds-1');
	assert.equal(state.objects['dataset:wb.orders'], undefined);
	assert.equal(state.objects['beastmode:pds-x.other'].id, 8, 'an existing entry under the new key wins');
});

test('filter cards on a shared dataset carry the workbook key', () => {
	const binding = { name: 'Region', kind: 'column', column: 'Region', dataType: 'STRING', aggregated: false };
	const zone = { id: '1', kind: 'filter', mode: 'dropdown', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false };
	const filter = { datasourceId: 'ds', fieldId: '[Region]', kind: 'categorical' };
	assert.match(filterCardFor(zone, filter, binding, 'pds-x', { name: 'D' }, 'wb').card.key, /^filter-wb-pds-x-region-/);
	assert.match(filterCardFor(zone, filter, binding, 'wb.orders', { name: 'D' }, 'wb').card.key, /^filter-wb-orders-region-/);
});

test('migrateBatch continues past failures, skips workbooks without the selection, and writes a summary', async () => {
	const root = tempDir();
	const config = testConfig(root);
	const seen = [];
	const summary = await migrateBatch({
		config,
		project: 'Finance',
		dryRun: true,
		selection: { dashboards: ['Overview'] },
		deps: {
			client: tableauClient,
			content: {
				listWorkbooks: async (_c, { project }) => {
					assert.equal(project, 'Finance');
					return [
						{ id: 'w3', name: 'Gamma', project: { name: 'Finance' } },
						{ id: 'w1', name: 'Alpha', project: { name: 'Finance' } },
						{ id: 'w2', name: 'Beta', project: { name: 'Finance' } }
					];
				}
			},
			migrateWorkbook: async (opts) => {
				seen.push(opts.workbook);
				assert.ok(opts.sharedCache instanceof Map);
				assert.equal(opts.client, tableauClient);
				if (opts.workbook === 'w2') throw new Error('download refused');
				if (opts.workbook === 'w3') throw new SelectionError('Unknown dashboard "Overview"');
				return {
					slug: 'alpha',
					plan: { datasets: [{ key: `pds-${LUID}`, name: 'Orders', cardTarget: true, shared: { luid: LUID } }], beastModes: [], cards: [{}], pages: [], dataflows: [], issues: [{ severity: 'error' }] },
					push: { ok: true, counts: { create: 3 } }
				};
			}
		}
	});
	assert.deepEqual(seen, ['w1', 'w2', 'w3']);
	assert.equal(summary.ok, false);
	assert.deepEqual(summary.counts, { 'dry-run': 1, failed: 1, skipped: 1 });
	assert.equal(summary.workbooks[1].error, 'download refused');
	assert.deepEqual(summary.sharedDatasets[`pds-${LUID}`].workbooks, ['alpha']);
	assert.ok(fs.existsSync(summary.file));
	assert.ok(fs.existsSync(summary.report));
	assert.match(path.basename(summary.migrationReport.markdown), /^migration-report-.+\.md$/);
	assert.match(fs.readFileSync(summary.migrationReport.markdown, 'utf8'), /download refused/);
	assert.ok(fs.existsSync(summary.migrationReport.html));
	assert.deepEqual(JSON.parse(fs.readFileSync(summary.file, 'utf8')).counts, summary.counts);
	const md = renderBatchReport(summary);
	assert.match(md, /# Batch migration: project "Finance"/);
	assert.match(md, /\| Alpha \(`alpha`\) \| Finance \| dry-run \| 1 \|/);
});

test('migrateBatch filters by workbook names and luids and rejects unknown names', async () => {
	const root = tempDir();
	const list = async () => [
		{ id: 'w1', name: 'Alpha' },
		{ id: 'w2', name: 'Beta' },
		{ id: 'w3', name: 'Gamma' }
	];
	const seen = [];
	const deps = { client: tableauClient, content: { listWorkbooks: list }, migrateWorkbook: async (o) => (seen.push(o.workbook), { slug: o.workbook, plan: {}, push: null }) };
	const summary = await migrateBatch({ config: testConfig(root), all: true, workbooks: ['al*', 'w3'], skipPush: true, deps });
	assert.deepEqual(seen, ['w1', 'w3']);
	assert.deepEqual(summary.counts, { converted: 2 });
	seen.length = 0;
	await migrateBatch({ config: testConfig(root), all: true, workbooks: ['w2, W3,Alpha'], skipPush: true, deps });
	assert.deepEqual(seen, ['w1', 'w2', 'w3'], 'a comma list mixes luids and names');
	await assert.rejects(migrateBatch({ config: testConfig(root), all: true, workbooks: ['Nope'], deps }), SelectionError);
	await assert.rejects(migrateBatch({ config: testConfig(root), deps }), /needs a project, all/);
});

test('a shared connector extraction replays the published connections and tables on every workbook', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	const calls = [];
	const irs = { Alpha: publishedIR('Alpha'), Beta: publishedIR('Beta') };
	const deps = stubs(calls, irs);
	deps.data.extractData = async ({ datasource, strategy }) => {
		calls.push(strategy);
		datasource.connections = [{ id: 'sf', class: 'snowflake', dbname: 'ANALYTICS', extra: {} }];
		datasource.tables = [{ id: 't1', name: 'Custom SQL Query', kind: 'custom-sql', sql: 'select 1', columns: [] }];
		return { datasourceId: datasource.id, strategy: 'connector', tables: [], issues: [] };
	};
	const sharedCache = new Map();
	await extractWorkbook({ config, workbook: 'Alpha', client: tableauClient, sharedCache, dataStrategy: 'connector', deps });
	const b = await extractWorkbook({ config, workbook: 'Beta', client: tableauClient, sharedCache, dataStrategy: 'connector', deps });
	assert.deepEqual(calls, ['connector']);
	const ds = b.ir.datasources[0];
	assert.deepEqual([ds.connections[0].class, ds.tables[0].sql], ['snowflake', 'select 1']);
	assert.equal(b.manifests[0].shared.physical, undefined);
	assert.equal(b.manifests[0].shared.reused, true);
});
