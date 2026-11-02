import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { convertStage } from '../../src/pipeline/convert.js';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { migrateWorkbook } from '../../src/pipeline/migrate.js';
import { renderReport } from '../../src/pipeline/report.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';
import { makeZip } from '../twb/helpers/zip.js';

function sampleIR(name = 'Sales') {
	return {
		irVersion: 1,
		workbook: { name, sourceFile: '' },
		datasources: [
			{ id: 'federated.1', caption: 'Orders', connections: [], tables: [], relationships: [], fields: [], filters: [], extract: { enabled: true, hyperFiles: ['Data/x.hyper'] } },
			{ id: 'federated.2', caption: 'Unused', connections: [], tables: [], relationships: [], fields: [], filters: [] }
		],
		parameters: [],
		worksheets: [{ name: 'Sheet 1', datasourceIds: ['federated.1'], pills: {}, rows: null, cols: null, rowPills: [], colPills: [], panes: [], filters: [], sorts: [], aggregated: true, measureValues: [], hidden: false }],
		dashboards: [],
		issues: []
	};
}

function tableauStubs(calls) {
	return {
		client: {
			TableauClient: class {
				async signIn() {
					calls.push('signIn');
				}
				async signOut() {
					calls.push('signOut');
				}
			}
		},
		content: {
			findWorkbook: async () => ({ id: 'wb-luid', name: 'Sales', project: { name: 'Finance' } }),
			findDatasource: async () => null,
			downloadWorkbook: async (_c, luid, dir) => {
				const file = path.join(dir, 'Sales.twbx');
				fs.writeFileSync(file, 'zip');
				calls.push(`download:${luid}`);
				return { file };
			}
		},
		metadata: {
			fetchWorkbookMetadata: async () => {
				throw new Error('Metadata API disabled');
			},
			applyMetadata: () => {}
		},
		package: {
			openPackage: async (file) => ({ kind: path.extname(file).slice(1), xml: '<workbook/>', close: () => calls.push('close') })
		},
		twb: {
			buildWorkbookIR: (_xml, { sourceFile, info }) => ({ ...sampleIR(info.name), workbook: { ...info, sourceFile } })
		},
		data: {
			datasourceSlug: (ds) => ds.caption.toLowerCase(),
			extractData: async ({ datasource, dir, strategy }) => {
				calls.push(`data:${datasource.id}:${strategy}`);
				const manifest = { datasourceId: datasource.id, strategy: 'hyper', tables: [{ name: 'Orders', file: 'data/orders/orders.csv', columns: [], rowCount: 2, flattened: true }], issues: [] };
				fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
				fs.writeFileSync(path.join(dir, 'data', 'orders.manifest.json'), JSON.stringify(manifest));
				return manifest;
			}
		}
	};
}

test('extract --file mode copies the file and extracts only used datasources without Tableau', async () => {
	const root = tempDir();
	const src = path.join(tempDir(), 'My Sales.twb');
	fs.writeFileSync(src, '<workbook/>');
	const calls = [];
	const { slug, ir, manifests } = await extractWorkbook({ config: testConfig(root), file: src, deps: tableauStubs(calls) });
	assert.equal(slug, 'my-sales');
	assert.equal(ir.workbook.name, 'My Sales');
	assert.equal(ir.workbook.sourceFile, 'workbooks/my-sales/source.twb');
	assert.deepEqual(calls, ['data:federated.1:auto', 'close']);
	assert.equal(manifests.length, 1);
	const ws = openWorkspace(root);
	const p = ws.paths(slug);
	for (const f of [p.source('twb'), p.twb, p.ir, p.metadata, ws.mappingsFile, p.manifest('orders')]) assert.ok(fs.existsSync(f), f);
	const meta = await ws.readJson(p.metadata);
	assert.equal(meta.source, 'file');
	assert.deepEqual(meta.datasources, [{ id: 'federated.1', caption: 'Orders', slug: 'orders' }]);
});

test('extract server mode signs in, downloads, tolerates metadata failure and always signs out', async () => {
	const root = tempDir();
	const config = testConfig(root);
	config.tableau = { server: 'https://t.example.com', site: '', patName: 'n', patSecret: 's' };
	const calls = [];
	const warnings = [];
	const emitter = { step() {}, progress() {}, info() {}, done() {}, error() {}, warn: (m) => warnings.push(m), child: () => emitter };
	const { slug, ir } = await extractWorkbook({ config, workbook: 'Sales', emitter, deps: tableauStubs(calls) });
	assert.equal(slug, 'sales');
	assert.equal(ir.workbook.luid, 'wb-luid');
	assert.equal(calls[0], 'signIn');
	assert.ok(calls.includes('download:wb-luid'));
	assert.equal(calls.at(-1), 'signOut');
	assert.ok(warnings.some((w) => /Metadata API lookup failed/.test(w)));
	assert.ok(ir.issues.some((i) => i.code === 'extract.metadata-unavailable'));
	assert.ok(fs.existsSync(openWorkspace(root).paths('sales').source('twbx')));
});

test('extract lists the Tableau names of the views its web zones show; a failed lookup only warns', async () => {
	const root = tempDir();
	const config = testConfig(root);
	config.tableau = { server: 'https://t.example.com', site: '', patName: 'n', patSecret: 's' };
	const deps = tableauStubs([]);
	const web = (wb) => ({ id: wb, kind: 'web', url: `https://t.example.com/#/views/${wb}/Main?:iid=1`, rect: { x: 0, y: 0, w: 1, h: 1 } });
	deps.twb = { buildWorkbookIR: (_xml, { sourceFile, info }) => ({ ...sampleIR(info.name), workbook: { ...info, sourceFile }, dashboards: [{ name: 'Frame', zones: [web('Other'), web('Broken')], floating: [] }] }) };
	deps.content.listWorkbooks = async (_c, { contentUrl }) => {
		if (contentUrl === 'Broken') throw new Error('HTTP 500');
		return [{ id: 'wb-other', name: 'Other Workbook', contentUrl }];
	};
	deps.content.listWorkbookViews = async (_c, id) => (id === 'wb-other' ? [{ name: 'Main View', contentUrl: 'Other/sheets/Main' }] : []);
	const warnings = [];
	const emitter = { step() {}, progress() {}, info() {}, done() {}, error() {}, warn: (m) => warnings.push(m), child: () => emitter };
	const { ir } = await extractWorkbook({ config, workbook: 'Sales', emitter, deps });
	assert.deepEqual(ir.workbook.linkedViews, [{ contentUrl: 'Other/sheets/Main', name: 'Main View', workbook: 'Other Workbook' }]);
	assert.ok(warnings.some((w) => /views of workbook "Broken"/.test(w)));
});

test('extract adds a luid suffix only when another workbook owns the slug', async () => {
	const root = tempDir();
	const ws = openWorkspace(root);
	await ws.writeJson(ws.paths('sales').metadata, { workbook: { name: 'Sales', luid: 'other' }, identity: 'other' });
	const config = testConfig(root);
	config.tableau = { server: 'https://t.example.com', site: '', patName: 'n', patSecret: 's' };
	const { slug } = await extractWorkbook({ config, workbook: 'Sales', deps: tableauStubs([]) });
	assert.equal(slug, 'sales-wbluid');
});

test('extract validates inputs', async () => {
	const config = testConfig(tempDir());
	await assert.rejects(extractWorkbook({ config }), /needs a workbook/);
	await assert.rejects(extractWorkbook({ config, workbook: 'a', file: 'b' }), /either/);
	await assert.rejects(extractWorkbook({ config, file: 'x.twb', dataStrategy: 'magic' }), /Unknown data strategy/);
	await assert.rejects(extractWorkbook({ config, file: '/nope/x.twb', deps: tableauStubs([]) }), /File not found/);
});

test('convertStage reads the images of an older ir.json from the package extract stored, without extracting again', async () => {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	const xml = `<?xml version='1.0'?><workbook><dashboards><dashboard name='Home'><zones><zone h='10000' id='2' type-v2='bitmap' param='Image/banner.png' is-scaled='1' w='100000' x='0' y='0' /></zones></dashboard></dashboards></workbook>`;
	fs.mkdirSync(p.dir, { recursive: true });
	fs.writeFileSync(p.source('twbx'), makeZip([{ name: 'Book.twb', data: xml }, { name: 'Image/banner.png', data: 'png' }]));
	await ws.writeJson(p.metadata, { sourceFile: 'workbooks/sales/source.twbx' });
	const ir = { ...sampleIR(), irVersion: 10, dashboards: [{ name: 'Home', zones: [{ id: '2', kind: 'image', url: 'Image/banner.png', rect: { x: 0, y: 0, w: 1, h: 0.1 }, floating: false }], floating: [] }] };
	await ws.writeJson(p.ir, ir);
	let zone;
	await convertStage({ config: testConfig(root), slug: 'sales', convertWorkbook: (seen) => ((zone = seen.dashboards[0].zones[0]), samplePlan()) });
	assert.deepEqual([zone.fit, zone.image.file, zone.image.bytes], ['fit', 'images/banner.png', 3]);
	assert.equal(fs.readFileSync(path.join(p.dir, 'images', 'banner.png'), 'utf8'), 'png');
	assert.equal((await ws.readJson(p.ir)).dashboards[0].zones[0].image, undefined, 'ir.json stays as extract wrote it');
});

test('convertStage writes plan.json and report.md', async () => {
	const root = tempDir();
	const ws = openWorkspace(root);
	await ws.writeJson(ws.paths('sales').ir, sampleIR());
	await ws.writeJson(ws.paths('sales').manifest('orders'), { datasourceId: 'federated.1', strategy: 'hyper', tables: [], issues: [] });
	let seen;
	const plan = await convertStage({
		config: testConfig(root),
		slug: 'sales',
		options: { useFixed: false },
		convertWorkbook: (ir, opts) => {
			seen = opts;
			return samplePlan();
		}
	});
	assert.equal(seen.options.useFixed, false);
	assert.equal(seen.manifests.length, 1);
	assert.deepEqual(seen.mappings, { datasets: {}, accounts: [], cloudAmplifier: [], columns: {}, unmapped: {} });
	assert.equal(plan.datasets.length, 1);
	assert.ok(fs.existsSync(ws.paths('sales').plan));
	assert.match(fs.readFileSync(ws.paths('sales').report, 'utf8'), /# Migration report: Sales/);
	await assert.rejects(convertStage({ config: testConfig(root), slug: 'missing' }), /Run extract first/);
});

test('renderReport covers tables, issues, follow-ups and escapes markdown', () => {
	const plan = samplePlan();
	plan.beastModes[0].expression = 'CASE WHEN `a|b` > 1 THEN 1 END';
	plan.beastModes.push({ ...plan.beastModes[1], key: 'x', name: 'Unsupported', status: 'unsupported' });
	plan.issues.push({ severity: 'error', code: 'calc.unsupported', message: 'Could not translate', suggestion: 'Rebuild it' });
	plan.issues.push({ severity: 'warning', code: 'chart.dual-axis', message: 'Dual axis simplified' });
	const md = renderReport({ ir: sampleIR(), plan, manifests: [{ datasourceId: 'federated.1', strategy: 'hyper', tables: [{ rowCount: 1234 }], issues: [] }] });
	assert.match(md, /## Summary/);
	assert.match(md, /\| Orders \| upload \(hyper\) \| 1234 \|/);
	assert.ok(md.includes('``CASE WHEN `a\\|b` > 1 THEN 1 END``'));
	assert.match(md, /### Errors \(did not convert\) \(1\)/);
	assert.match(md, /Suggestion: Rebuild it/);
	assert.match(md, /FIXED/);
	assert.match(md, /- \[ \] Rebuild these calculations by hand; they did not convert: Unsupported/);
	assert.ok(md.indexOf('## Manual follow-up') < md.indexOf('## Counts'), 'checklist before the detailed sections');
	assert.ok(!/[\u2013\u2014]/.test(md));
});

test('renderReport includes push results', () => {
	const push = {
		dryRun: false,
		instance: 'acme',
		ok: false,
		startedAt: 'now',
		counts: { create: 1, 'status:failed': 1 },
		actions: [{ kind: 'card', key: 'sheet-1', name: 'Sales by Region', action: 'create', status: 'failed', id: null, error: 'HTTP 400' }],
		issues: []
	};
	const md = renderReport({ plan: samplePlan(), push });
	assert.match(md, /create: failed: HTTP 400/);
	assert.match(md, /### Push failures \(1\)/);
	assert.match(md, /resumes from the saved state/);
});

test('migrateWorkbook runs all stages and honors confirm', async () => {
	const root = tempDir();
	const src = path.join(tempDir(), 'Sales.twb');
	fs.writeFileSync(src, '<workbook/>');
	const config = testConfig(root);
	const { deps, calls } = stubDomo();
	const convertWorkbook = () => {
		const plan = samplePlan();
		plan.datasets[0].upload.file = 'data/orders/orders.csv';
		return plan;
	};
	const extractDeps = tableauStubs([]);
	const realExtract = extractDeps.data.extractData;
	extractDeps.data.extractData = async (opts) => {
		const m = await realExtract(opts);
		fs.mkdirSync(path.join(opts.dir, 'data', 'orders'), { recursive: true });
		fs.writeFileSync(path.join(opts.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
		return m;
	};
	const cancelled = await migrateWorkbook({ config, file: src, confirm: () => false, deps: { extract: extractDeps, convertWorkbook, push: deps } });
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.preview.dryRun, true);
	assert.equal(calls.length, 0);
	const done = await migrateWorkbook({ config, file: src, confirm: () => true, deps: { extract: extractDeps, convertWorkbook, push: deps } });
	assert.equal(done.push.dryRun, false);
	assert.ok(calls.some((c) => c.name === 'createCard'));
});
