import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli/main.js';
import { readableFormula, untranslatedCalcs } from '../../src/pipeline/calc-formulas.js';
import { describeIssue } from '../../src/pipeline/issue-text.js';
import { buildMigrationReport, loadMigrationReport, renderMigrationHtml, renderMigrationMarkdown, summarizeWorkbook, writeMigrationReport } from '../../src/pipeline/migration-report.js';
import { renderReport } from '../../src/pipeline/report.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { tempDir, testConfig } from './helpers.js';

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

function fixture() {
	const ir = {
		workbook: { name: 'Sales <Ops>', projectName: 'Finance', webpageUrl: 'https://tab.example.com/#/workbooks/1' },
		datasources: [
			{ id: 'ds.orders', caption: 'Orders' },
			{ id: 'ds.wh', caption: 'Warehouse' },
			{ id: 'ds.unused', caption: 'Old' }
		],
		worksheets: [
			{ name: 'Sheet A', datasourceIds: ['ds.orders'] },
			{ name: 'Sheet B', datasourceIds: ['ds.orders'] },
			{ name: 'Sheet C', datasourceIds: ['ds.wh'] }
		],
		dashboards: [{ name: 'Overview' }],
		issues: [{ severity: 'warning', code: 'twb.blend', message: 'Worksheet "Sheet A" blends 2 datasources', object: { type: 'worksheet', name: 'Sheet A' } }]
	};
	const plan = {
		source: { workbook: 'Sales <Ops>' },
		datasets: [
			{ key: 'orders', name: 'Orders DS', strategy: 'upload', upload: { file: 'data/o.csv' }, datasourceId: 'ds.orders', cardTarget: true },
			{ key: 'wh', name: 'Warehouse DS', strategy: 'cloud-amplifier', datasourceId: 'ds.wh', cardTarget: true }
		],
		beastModes: [{ key: 'bm1', name: 'Ratio', status: 'unsupported', features: [] }],
		cards: [
			{ key: 'a', title: 'Card A', worksheet: 'Sheet A', status: 'approximate', pageKeys: ['p1'] },
			{ key: 'b', title: 'Card B', worksheet: 'Sheet B', status: 'ok', pageKeys: ['p1'] },
			{ key: 'c', title: 'Card C', worksheet: 'Sheet C', status: 'ok', pageKeys: ['p2'] }
		],
		pages: [
			{ key: 'p1', title: 'Overview', dashboard: 'Overview', navOrder: 1 },
			{ key: 'p2', title: 'Detail', dashboard: 'Detail', navOrder: 2 }
		],
		app: { title: 'Sales app' },
		issues: [
			{ severity: 'warning', code: 'filter.relative-date', message: 'Relative date filter on X skipped', object: { type: 'worksheet', name: 'Sheet A' } },
			{ severity: 'warning', code: 'filter.relative-date', message: 'Relative date filter on Y skipped', object: { type: 'worksheet', name: 'Sheet B' } },
			{ severity: 'warning', code: 'layout.floating', message: '1 floating item placed below', object: { type: 'dashboard', name: 'Overview' } },
			{ severity: 'info', code: 'layout.floating', message: 'Info only', object: { type: 'dashboard', name: 'Detail' } },
			{ severity: 'error', code: 'calc.no-equivalent', message: 'PREVIOUS_VALUE has no Domo equivalent', object: { type: 'calculation', name: 'Ratio' } },
			{ severity: 'warning', code: 'made.up-code', message: 'Something odd happened', object: { type: 'worksheet', name: 'Sheet C' } }
		]
	};
	const push = {
		instance: 'acme',
		dryRun: false,
		ok: true,
		startedAt: '2026-10-21T00:00:00Z',
		counts: {},
		app: { id: 9, title: 'Sales app', url: 'https://acme.domo.com/app-studio/9', views: [{ key: 'p1', url: 'https://acme.domo.com/app-studio/9/pages/11' }, { key: 'p2', url: 'https://acme.domo.com/app-studio/9/pages/12' }] },
		actions: [
			{ kind: 'dataset', key: 'orders', id: 'uuid-orders', status: 'ok', action: 'create' },
			{ kind: 'dataset', key: 'wh', id: 'uuid-wh', status: 'ok', action: 'register' },
			{ kind: 'card', key: 'a', id: 101, status: 'ok', action: 'create' },
			{ kind: 'card', key: 'b', id: 102, status: 'ok', action: 'create' },
			{ kind: 'card', key: 'c', id: 103, status: 'ok', action: 'create' }
		],
		issues: []
	};
	const manifests = [{ datasourceId: 'ds.orders', strategy: 'hyper', tables: [{ rowCount: 1500 }] }];
	const runs = { extract: { ok: true, timing: { ms: 2000, steps: [] } }, convert: { ok: true, timing: { ms: 500, steps: [] } }, push: { ok: true, timing: { ms: 7000, steps: [] } } };
	return { ir, plan, push, manifests, runs };
}

test('describeIssue maps known codes to plain text and falls back to the message', () => {
	assert.deepEqual(describeIssue({ severity: 'warning', code: 'data.schema-only', message: 'x' }), { level: 'must', text: 'These datasets were created empty; load their data', known: true });
	assert.equal(describeIssue({ severity: 'info', code: 'filter.null', message: 'x' }).level, 'info');
	assert.equal(describeIssue({ severity: 'warning', code: 'filter.null', message: 'x' }).level, 'check');
	assert.deepEqual(describeIssue({ severity: 'error', code: 'nope.unknown', message: 'Raw message' }), { level: 'must', text: 'Raw message', known: false });
});

test('summarizeWorkbook links, statuses, data strategies and a grouped, ranked checklist', () => {
	const wb = summarizeWorkbook(fixture());
	assert.equal(wb.status, 'Migrated');
	assert.deepEqual(wb.stages, { extract: 'done', convert: 'done', push: 'done' });
	assert.equal(wb.app.url, 'https://acme.domo.com/app-studio/9');
	assert.equal(wb.tableauUrl, 'https://tab.example.com/#/workbooks/1');
	assert.deepEqual(wb.counts, { views: 2, viewsPushed: 2, cards: 3, exact: 2, approximate: 1, unsupported: 0, cardsPushed: 3 });
	assert.equal(wb.timing.totalMs, 9500);

	const byName = Object.fromEntries(wb.data.map((d) => [d.name, d]));
	assert.equal(byName.Orders.strategy, 'snapshot');
	assert.match(byName.Orders.label, /1,500 rows/);
	assert.equal(byName.Orders.datasets[0].url, 'https://acme.domo.com/datasources/uuid-orders/details/overview');
	assert.equal(byName.Warehouse.strategy, 'cloud-amplifier');
	assert.equal(byName.Old.strategy, 'unused');

	const levels = wb.followUps.map((f) => f.level);
	assert.deepEqual(levels, [...levels].sort((a, b) => (a === b ? 0 : a === 'must' ? -1 : 1)), 'must items first');
	const filter = wb.followUps.filter((f) => f.codes.includes('filter.relative-date'));
	assert.equal(filter.length, 1, 'same code on one view is one item');
	assert.equal(filter[0].group.title, 'Overview');
	assert.equal(filter[0].group.url, 'https://acme.domo.com/app-studio/9/pages/11');
	assert.deepEqual(filter[0].subjects, [{ label: 'Card A', url: 'https://acme.domo.com/kpis/details/101' }, { label: 'Card B', url: 'https://acme.domo.com/kpis/details/102' }]);
	assert.deepEqual(filter[0].details, ['Relative date filter on X skipped.', 'Relative date filter on Y skipped.']);

	const calc = wb.followUps.find((f) => f.codes.includes('calc.no-equivalent'));
	assert.equal(calc.level, 'must');
	assert.equal(calc.group.key, 'workbook');
	assert.ok(!wb.followUps.some((f) => f.text.startsWith('Rebuild these calculations by hand; they did not convert')), 'unsupported Beast Mode already covered by its issue');
	assert.ok(wb.followUps.some((f) => f.text === 'Something odd happened' && f.group.title === 'Detail'), 'unknown code keeps its message');
	assert.ok(wb.followUps.some((f) => f.text.startsWith('The data is a one-time copy') && f.level === 'must'));
	assert.ok(!wb.followUps.some((f) => f.group.title === 'Detail' && f.codes.includes('layout.floating')), 'info items stay out of the checklist');
	assert.equal(wb.notes, 1);
});

test('a card replaced by a text card or smart text is not a card to recreate by hand', () => {
	const f = fixture();
	f.plan.cards.push(
		{ key: 'u', title: 'Last Updated', worksheet: 'Last Updated', status: 'unsupported', replacedBy: 'notebook', pageKeys: ['p1'] },
		{ key: 'x', title: 'Broken', worksheet: 'Broken', status: 'unsupported', pageKeys: ['p1'] }
	);
	f.plan.issues.push({ severity: 'info', code: 'layout.update-time', message: 'Worksheet Last Updated shows only its title; it is a text card', object: { type: 'worksheet', name: 'Last Updated' } });
	const wb = summarizeWorkbook(f);
	const recreate = wb.followUps.filter((i) => i.text.startsWith('Recreate these cards by hand'));
	assert.deepEqual(recreate.flatMap((i) => i.subjects.map((s) => s.label)), ['Broken']);
	assert.equal(wb.counts.cards, 4);
	assert.equal(wb.counts.unsupported, 1);
	assert.match(renderReport({ ir: f.ir, plan: f.plan }), /\| Last Updated \| Last Updated \| +\| replaced \(text card\) \|/);
});

test('summarizeWorkbook reports push failures, dry runs and batch failures', () => {
	const f = fixture();
	f.push.ok = false;
	f.push.actions.push({ kind: 'card', key: 'c', name: 'Card C', status: 'failed', action: 'update', error: 'HTTP 400' });
	const failed = summarizeWorkbook(f);
	assert.equal(failed.statusKey, 'failed');
	assert.match(failed.why, /1 object\(s\) did not reach Domo.*HTTP 400/);
	assert.ok(failed.followUps[0].text.startsWith('These objects did not reach Domo'));

	const dry = summarizeWorkbook({ ...fixture(), push: { ...fixture().push, dryRun: true } });
	assert.equal(dry.statusKey, 'dry-run');
	assert.equal(dry.app, undefined);
	assert.ok(dry.followUps.some((x) => x.text.startsWith('Only a dry run was done')));

	const batchOnly = summarizeWorkbook({ batch: { name: 'Gone', status: 'failed', error: 'download refused', durationMs: 1200 } });
	assert.equal(batchOnly.status, 'Failed at extract');
	assert.equal(batchOnly.name, 'Gone');
	assert.equal(batchOnly.followUps[0].details[0], 'download refused');
	assert.equal(batchOnly.timing.totalMs, 1200);
});

test('Markdown and HTML render the same model with links, escaping and no dashes', () => {
	const report = buildMigrationReport({ workbooks: [summarizeWorkbook(fixture()), summarizeWorkbook({ batch: { name: 'Gone', status: 'failed', error: 'boom' } })], scope: 'Test', generatedAt: '2026-10-21T00:00:00Z' });
	assert.equal(report.totals.workbooks, 2);
	assert.deepEqual(report.totals.statuses, { migrated: 1, failed: 1 });
	const md = renderMigrationMarkdown(report);
	for (const heading of ['## Workbooks', '## Data', '## Manual follow-up', '## Totals']) assert.ok(md.includes(heading), heading);
	assert.ok(md.indexOf('### Sales \\<Ops\\>') < md.indexOf('### Gone'), 'workbooks with more must-fix items first');
	assert.ok(md.includes('[Open app](https://acme.domo.com/app-studio/9)'));
	assert.ok(md.includes('- View [Overview](https://acme.domo.com/app-studio/9/pages/11)'));
	assert.ok(md.includes('[Card A](https://acme.domo.com/kpis/details/101)'));
	assert.ok(md.indexOf('**Must fix**') < md.indexOf('**Check**'));
	assert.ok(!DASHES.test(md));

	const html = renderMigrationHtml(report);
	assert.match(html, /^<!doctype html>/);
	assert.ok(html.includes('Sales &lt;Ops&gt;'));
	assert.ok(html.includes('<a href="https://acme.domo.com/kpis/details/101" target="_blank" rel="noopener">Card A</a>'));
	assert.ok(!/<script|<link|@import|src=/.test(html), 'no external assets');
	assert.ok(!DASHES.test(html));
});

test('renderReport puts the summary and checklist before the detailed sections', () => {
	const md = renderReport(fixture());
	const order = ['## Summary', '## Manual follow-up', '## Counts', '## Datasets', '## Issues', '## Timing'].map((h) => md.indexOf(h));
	assert.ok(order.every((i) => i >= 0), 'all sections present');
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
	assert.match(md, /- Domo app: \[Sales app\]\(https:\/\/acme\.domo\.com\/app-studio\/9\)/);
	assert.match(md, /\*\*filter\.relative-date\*\*/, 'issue codes stay in the detailed section');
});

async function seedWorkspace() {
	const root = tempDir();
	const ws = openWorkspace(root);
	const f = fixture();
	const p = ws.paths('sales');
	await ws.writeJson(p.ir, f.ir);
	await ws.writeJson(p.plan, f.plan);
	await ws.writeJson(p.pushLog, f.push);
	await ws.writeJson(p.manifest('orders'), f.manifests[0]);
	await ws.writeJson(p.metadata, { workbook: { name: 'Sales <Ops>' } });
	return { root, ws };
}

test('loadMigrationReport reads a batch, a list of workbooks or the whole workspace', async () => {
	const { root, ws } = await seedWorkspace();
	const batch = { startedAt: '2026-10-21T00:00:00Z', scope: { project: 'Finance' }, workbooks: [{ name: 'Sales', slug: 'sales', status: 'migrated', durationMs: 60000 }, { name: 'Lost', status: 'failed', error: 'boom' }] };
	const fromBatch = await loadMigrationReport(ws, { batch });
	assert.equal(fromBatch.workbooks.length, 2);
	assert.equal(fromBatch.workbooks[0].timing.totalMs, 60000);
	assert.match(fromBatch.scope, /project "Finance"/);
	assert.equal((await loadMigrationReport(ws, { workbooks: ['Sales <Ops>'] })).workbooks[0].slug, 'sales');
	await ws.writeText(ws.paths('sales').report, '# Migration report: Sales');
	const all = await loadMigrationReport(ws, { all: true });
	assert.ok(all.workbooks[0].notes > 0, 'fixture has informational notes');
	const written = await writeMigrationReport(ws, all, { file: path.join(root, 'out', 'r.md'), html: true });
	const md = fs.readFileSync(written.markdown, 'utf8');
	const html = fs.readFileSync(written.html, 'utf8');
	assert.ok(md.includes('# Tableau to Domo migration report'));
	assert.ok(html.includes('<h1>Tableau to Domo migration report</h1>'));
	assert.ok(md.includes('listed in [the workbook report](../workbooks/sales/report.md)'));
	assert.ok(html.includes('<a href="../workbooks/sales/report.md" target="_blank" rel="noopener">the workbook report</a>'));
});

test('t2d report --all --html and --batch latest write the migration report', async () => {
	const { root, ws } = await seedWorkspace();
	const config = testConfig(root);
	const out = [];
	const io = { stdout: { write: (s) => out.push(s), isTTY: false }, stderr: { write: () => {}, isTTY: false }, stdin: { isTTY: false }, env: { NO_COLOR: '1' }, loadConfig: () => config };
	assert.equal(await main(['report', '--all', '--html'], io), 0);
	assert.ok(fs.existsSync(path.join(root, 'migration-report.md')));
	assert.ok(fs.existsSync(path.join(root, 'migration-report.html')));
	await ws.writeJson(path.join(root, 'batch-2026-10-21T00-00-00-000Z.json'), { startedAt: 'x', scope: {}, workbooks: [{ name: 'Sales', slug: 'sales', status: 'migrated' }] });
	assert.equal(await main(['report', '--batch', 'latest'], io), 0);
	assert.ok(fs.existsSync(path.join(root, 'migration-report-2026-10-21T00-00-00-000Z.md')));
	assert.equal(await main(['report', '--all', '-w', 'sales'], io), 2);
	assert.match(out.join(''), /1 workbook\(s\), 2 view\(s\), 3 card\(s\)/);
});

const TRICKY = '// Domo has no `RAWSQL` or ```fences```\nIF [Calculation_1] | 1 THEN RAWSQL_INT("a|b")\n\nELSE [Parameters].[Parameter 1] END';

function formulaFixture() {
	const ir = {
		workbook: { name: 'Calcs' },
		datasources: [
			{ id: 'ds.a', caption: 'Orders', fields: [{ id: '[Calculation_1]', name: 'Base Calc', formula: 'RAWSQL_INT("1")' }, { id: '[Calculation_2]', name: 'Tricky', formula: TRICKY }, { id: '[Calculation_9]', name: 'YOY', formula: 'x' }] },
			{ id: 'ds.b', caption: 'Orders (copy)', fields: [{ id: '[Calculation_9]', name: 'YOY', formula: 'x' }] }
		],
		parameters: [{ id: '[Parameters].[Parameter 1]', name: 'Region pick' }]
	};
	const plan = {
		datasets: [
			{ key: 'a', name: 'Orders DS', datasourceId: 'ds.a' },
			{ key: 'b', name: 'Orders copy DS', datasourceId: 'ds.b' }
		],
		beastModes: [
			{ key: 'a.base', datasetKey: 'a', name: 'Base Calc', tableauFieldId: '[Calculation_1]', tableauFormula: 'RAWSQL_INT("1")', status: 'unsupported' },
			{ key: 'a.tricky', datasetKey: 'a', name: 'Tricky', tableauFieldId: '[Calculation_2]', tableauFormula: TRICKY, status: 'unsupported' },
			{ key: 'a.yoy', datasetKey: 'a', name: 'YOY', tableauFieldId: '[Calculation_9]', tableauFormula: 'WINDOW_SUM([Calculation_404])', status: 'unsupported' },
			{ key: 'b.yoy', datasetKey: 'b', name: 'YOY', tableauFieldId: '[Calculation_9]', tableauFormula: 'WINDOW_SUM([Calculation_9])', status: 'unsupported' }
		],
		cards: [],
		pages: [],
		issues: [
			{ severity: 'error', code: 'calc.no-equivalent', message: "'Tricky': RAWSQL_INT has no Domo equivalent", object: { type: 'field', name: 'Tricky', id: '[Calculation_2]' } },
			{ severity: 'warning', code: 'calc.table-calc-order', message: 'WINDOW_SUM needs an ORDER BY', object: { type: 'field', name: 'YOY', id: '[Calculation_9]' } }
		]
	};
	return { ir, plan };
}

test('readableFormula replaces field and parameter ids by captions and keeps unknown references', () => {
	const { ir } = formulaFixture();
	assert.equal(readableFormula('[Calculation_1] + [Calculation_404] + [Parameters].[Parameter 1] + [ds.b].[Calculation_9]', { ir, datasourceId: 'ds.a' }), '[Base Calc] + [Calculation_404] + [Parameters].[Region pick] + [Orders (copy)].[YOY]');
	assert.equal(readableFormula('[Calculation_1]', {}), '[Calculation_1]');
});

test('untranslated calculations carry their datasource, readable formula, reason and untranslated references', () => {
	const { ir, plan } = formulaFixture();
	const calcs = untranslatedCalcs({ ir, plan, issues: plan.issues });
	const tricky = calcs.find((c) => c.key === 'a.tricky');
	assert.equal(tricky.datasource, 'Orders');
	assert.equal(tricky.formula, TRICKY.replace('[Calculation_1]', '[Base Calc]').replace('[Parameter 1]', '[Region pick]'));
	assert.deepEqual(tricky.reasons, ["'Tricky': RAWSQL_INT has no Domo equivalent."]);
	assert.deepEqual(tricky.references, [{ key: 'a.base', name: 'Base Calc', formula: 'RAWSQL_INT("1")' }]);
	assert.deepEqual(calcs.find((c) => c.key === 'b.yoy').references, [], 'a calc does not reference itself');
	assert.equal(calcs.find((c) => c.key === 'a.yoy').formula, 'WINDOW_SUM([Calculation_404])');
});

test('follow-ups show each untranslated formula in a fenced block and in the HTML details', () => {
	const { ir, plan } = formulaFixture();
	const wb = summarizeWorkbook({ ir, plan });
	const tricky = wb.followUps.find((f) => f.codes.includes('calc.no-equivalent'));
	assert.deepEqual(tricky.formulas.map((f) => f.key), ['a.tricky']);
	assert.deepEqual(tricky.details, [], 'the reason sits with the formula');
	const rebuild = wb.followUps.find((f) => f.codes.includes('calc.unsupported'));
	assert.deepEqual(rebuild.subjects.map((s) => s.label), ['Base Calc', 'YOY (Orders)', 'YOY (Orders (copy))'], 'calcs with the same name keep their datasource');

	const report = buildMigrationReport({ workbooks: [wb], scope: 'Test', generatedAt: '2026-10-21T00:00:00Z' });
	const md = renderMigrationMarkdown(report);
	const lines = md.split('\n');
	const checklist = lines.find((l) => l.includes('[ ] Rebuild these calculations by hand; they use functions'));
	assert.ok(!checklist.includes('RAWSQL'), 'the checklist line holds no formula');
	const open = lines.indexOf('      ````');
	assert.ok(open > 0, 'a fence longer than the longest backtick run, indented into the list item');
	const close = lines.indexOf('      ````', open + 1);
	assert.deepEqual(lines.slice(open + 1, close), tricky.formulas[0].formula.split('\n').map((l) => (l ? `      ${l}` : '')));
	assert.ok(md.includes('    - **YOY** (datasource Orders (copy)): WINDOW\\_SUM needs an ORDER BY. Tableau formula:'));
	assert.ok(md.includes('      - Uses **Base Calc**, which did not convert either:'));
	assert.ok(md.includes('        ```\n        RAWSQL_INT("1")\n        ```'));
	assert.ok(!DASHES.test(md));
	assert.ok(renderReport({ ir, plan }).includes(lines.slice(open, close + 1).join('\n')), 'report.md shows the same formulas');

	const html = renderMigrationHtml(report);
	assert.ok(html.includes('<summary>Details and Tableau formulas</summary>'));
	const pre = `<pre><code>${tricky.formulas[0].formula.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</code></pre>`;
	assert.ok(html.includes(pre));
	assert.ok(html.indexOf(pre) > html.indexOf('<details>', html.indexOf('they use functions')), 'formula inside the item details');
});
