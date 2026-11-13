import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { convertStage } from '../../src/pipeline/convert.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { createDomoClient } from '../../src/domo/client.js';
import { createEmitter } from '../../src/util/events.js';
import { collectRefs } from '../../src/util/refs.js';
import { fakeHyperPython } from '../data/helpers.js';
import { installDomoServer } from './domo-server.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/superstore.twbx');
const BIN = path.join(ROOT, 'bin/t2d.js');

const ORDERS_HEADER = 'Row ID,Order ID,Order Date,Ship Date,Ship Mode,Customer ID,Customer Name,Segment,Country/Region,City,State/Province,Postal Code,Region,Product ID,Category,Sub-Category,Product Name,Sales,Quantity,Discount,Profit';
const ORDERS = `${ORDERS_HEADER}
1,CA-1,2024-01-03,2024-01-05,Second Class,C1,Ann,Consumer,United States,Austin,Texas,07001,Central,P1,Furniture,Chairs,Chair,261.96,2,0,41.91
2,CA-2,2024-02-03,2024-02-06,Same Day,C2,Bob,Corporate,United States,Boston,Massachusetts,02101,East,P2,Technology,Phones,"Phone, X",731.94,3,0.2,-12.5
`;

function hyperType(name) {
	if (['Sales', 'Discount', 'Profit'].includes(name)) return 'DOUBLE';
	if (['Row ID', 'Quantity'].includes(name)) return 'BIG_INT';
	if (/Date/.test(name)) return 'DATE';
	return 'TEXT';
}

const col = (name, type = 'TEXT') => ({ name, type, nullable: true });

let tmp;
let config;
let slug;
let plan;
const events = [];
const sink = (e) => events.push(e);

before(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-e2e-'));
	const python = fakeHyperPython(tmp, [
		{ schema: 'Extract', name: 'Orders_ECFCA1FB690A41FE803BC071773BA862', csv: ORDERS, rowCount: 2, columns: ORDERS_HEADER.split(',').map((n) => col(n, hyperType(n))) },
		{ schema: 'Extract', name: 'People_D73023733B004CC1B3CB1ACF62F4A965', csv: 'Regional Manager,Region\nChris,Central\nDana,East\n', rowCount: 2, columns: [col('Regional Manager'), col('Region')] },
		{ schema: 'Extract', name: 'Returns_2AA0FADE3C8A4E1A9A4B4F8E1B2C3D4E', csv: 'Returned,Order ID\nYes,CA-2\n', rowCount: 1, columns: [col('Returned'), col('Order ID')] }
	]);
	config = {
		env: null,
		tableau: { server: '', site: '', patName: '', patSecret: '' },
		domo: { instance: 'acme', accessToken: 'tok' },
		workspace: path.join(tmp, 'ws'),
		python
	};
	const result = await extractWorkbook({ config, file: FIXTURE, dataStrategy: 'auto', unmapped: 'export', emitter: createEmitter(sink, 'extract') });
	slug = result.slug;
	plan = await convertStage({ config, slug, options: { target: 'pages', allBeastModes: true }, emitter: createEmitter(sink, 'convert') });
});

after(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const deps = { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) };

test('extract writes the IR, CSVs and manifests for the packaged extract', async () => {
	const dir = path.join(config.workspace, 'workbooks', slug);
	assert.ok(fs.existsSync(path.join(dir, 'ir.json')));
	const manifests = fs.readdirSync(path.join(dir, 'data')).filter((f) => f.endsWith('.manifest.json'));
	assert.equal(manifests.length, 2);
	const superstore = plan.datasets.find((d) => d.key.endsWith('.orders'));
	assert.ok(superstore?.upload?.file, 'Orders table is uploaded from a CSV');
	assert.ok(fs.existsSync(path.join(dir, superstore.upload.file)));
});

test('plan has datasets, a join dataflow, beast modes, cards and pages', () => {
	assert.ok(plan.datasets.length >= 4);
	assert.equal(plan.dataflows.length, 1, 'the joins and the blend run as one dataflow');
	const blendKey = plan.cards.find((c) => c.worksheet === 'Sales vs Target').datasetKey;
	assert.ok(blendKey.includes('.blend-'), 'the Sales vs Target blend becomes a join');
	assert.ok(plan.dataflows[0].outputDatasetKeys.includes(blendKey));
	const target = plan.datasets.find((d) => d.cardTarget && d.strategy === 'dataflow-output');
	assert.ok(target, 'the related tables become a dataflow output card target');
	assert.ok(Object.keys(target.fieldMap).length > 20);
	assert.ok(plan.beastModes.length > 5);
	assert.ok(plan.beastModes.some((b) => b.status === 'ok' && /SUM\(`Profit`\) \/ NULLIF\(SUM\(`Sales`\), 0\)/.test(b.expression)));
	assert.ok(plan.cards.length >= 9);
	assert.ok(plan.pages.length >= 3);
	const keys = new Set(plan.cards.map((c) => c.key));
	assert.equal(keys.size, plan.cards.length, 'card keys are unique');
	for (const card of plan.cards.filter((c) => c.worksheet)) assert.ok(card.key.startsWith(`${slug}.`), `card key ${card.key} is workbook-scoped`);
});

test('every card body carries formulas, dataProvider and variables', () => {
	for (const card of plan.cards.filter((c) => c.kind !== 'image')) {
		const body = card.body;
		assert.ok(body.dataProvider?.dataSourceId, `${card.key} dataProvider`);
		assert.equal(body.variables, true, `${card.key} variables`);
		assert.ok(body.definition?.formulas, `${card.key} formulas`);
		assert.ok(Array.isArray(body.definition.formulas.card), `${card.key} formulas.card`);
		assert.ok(!/\n/.test(card.title), `${card.key} title is one line`);
	}
});

test('every layout card ref names a planned card or variable', () => {
	const cardKeys = new Set([...plan.cards.map((c) => `card:${c.key}`), ...plan.variables.map((v) => `variable:${v.key}`)]);
	let seen = 0;
	for (const page of plan.pages.filter((p) => p.layout)) {
		const templateKeys = new Set(page.layout.standard.template.map((t) => t.contentKey));
		for (const item of page.layout.content) {
			assert.ok(templateKeys.has(item.contentKey), `${page.key} content ${item.contentKey} has a template entry`);
			for (const r of collectRefs(item)) {
				seen++;
				assert.ok(cardKeys.has(r), `${page.key} references ${r}`);
			}
		}
	}
	assert.ok(seen > 5);
});

test('dry run makes no network calls', async () => {
	const server = installDomoServer();
	try {
		const summary = await pushPlan({ config, slug, dryRun: true, emitter: createEmitter(sink, 'push') });
		assert.equal(server.calls.length, 0);
		assert.equal(summary.dryRun, true);
		assert.ok(summary.actions.some((a) => a.kind === 'card' && a.action === 'create'));
		assert.ok(fs.existsSync(path.join(config.workspace, 'workbooks', slug, 'push-dry-run.json')));
	} finally {
		server.restore();
	}
});

test('push creates everything in order, then a second push creates nothing', async () => {
	const server = installDomoServer();
	const target = plan.datasets.find((d) => d.cardTarget && d.strategy === 'dataflow-output');
	const filterPage = plan.pages.find((pg) => pg.layout?.content?.length);
	filterPage.filters = [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], filterType: 'LEGACY', dataSourceId: { $ref: `dataset:${target.key}` } }];
	fs.writeFileSync(path.join(config.workspace, 'workbooks', slug, 'plan.json'), JSON.stringify(plan));
	try {
		const first = await pushPlan({ config, slug, emitter: createEmitter(sink, 'push'), deps });
		const failed = first.actions.filter((a) => a.status === 'failed');
		assert.deepEqual(failed, [], 'no failed actions');
		assert.equal(first.ok, true);

		const order = ['dataset', 'dataflow', 'beastmode', 'page', 'card', 'layout'];
		const firstIndex = order.map((kind) => first.actions.findIndex((a) => a.kind === kind && a.status === 'ok'));
		assert.ok(firstIndex.every((i) => i >= 0), `every kind pushed: ${firstIndex}`);
		const dataflowIndex = first.actions.findIndex((a) => a.kind === 'dataflow');
		const inputs = first.actions.filter((a, i) => a.kind === 'dataset' && a.action === 'create' && i < dataflowIndex);
		assert.ok(inputs.length >= 3, 'input datasets are created before the dataflow');
		for (let i = 1; i < order.length; i++) {
			const lastPrev = first.actions.map((a) => a.kind).lastIndexOf(order[i - 1]);
			if (order[i - 1] === 'dataset') continue;
			assert.ok(lastPrev < firstIndex[i], `${order[i - 1]} before ${order[i]}`);
		}

		const callIndex = (method, re) => server.calls.findIndex((c) => c.method === method && re.test(c.path));
		const sequence = [
			callIndex('POST', /^\/data\/v2\/datasources$/),
			callIndex('POST', /^\/dataprocessing\/v1\/dataflows$/),
			callIndex('POST', /^\/query\/v1\/functions\/template$/),
			callIndex('POST', /^\/content\/v1\/pages$/),
			callIndex('PUT', /^\/content\/v3\/cards\/kpi$/),
			callIndex('PUT', /^\/content\/v4\/pages\/layouts\/\d+$/)
		];
		assert.ok(sequence.every((i) => i >= 0), `all endpoints called: ${sequence}`);
		assert.deepEqual([...sequence].sort((a, b) => a - b), sequence, 'endpoints called in push order');

		const state = JSON.parse(fs.readFileSync(path.join(config.workspace, 'state', 'acme.json'), 'utf8'));
		const targetId = state.objects[`dataset:${target.key}`]?.id;
		assert.match(String(targetId), /^ds-out-/, 'the dataflow output id is recorded');
		const cardCreates = server.calls.filter((c) => c.method === 'PUT' && c.path === '/content/v3/cards/kpi');
		assert.ok(cardCreates.length >= 8);
		for (const call of cardCreates) {
			assert.ok(!collectRefs(call.body).size, 'card body refs are resolved');
			assert.ok(call.body.definition.formulas, 'formulas sent');
		}
		assert.ok(cardCreates.some((c) => c.body.dataProvider.dataSourceId === targetId));
		const images = plan.cards.filter((c) => c.kind === 'image');
		assert.ok(images.length, 'the workbook has an image zone');
		assert.equal(server.calls.filter((c) => c.method === 'POST' && c.path === '/data/v1/data-files').length, images.length, 'one data file per image card');
		const docCards = server.calls.filter((c) => c.method === 'POST' && c.path === '/content/v1/cards');
		assert.deepEqual(docCards.map((c) => [c.body.type, c.body.metadata.kpiType, /^\d+:undefined$/.test(c.body.metadata.documentId), Boolean(c.query.pageId)]), images.map(() => ['document', 'document', true, true]));
		const filtered = plan.pages.filter((pg) => pg.filters?.length);
		const viewCreates = server.calls.filter((c) => c.method === 'POST' && /^\/content\/v3\/pages\/\d+\/analyzer$/.test(c.path));
		assert.equal(viewCreates.length, filtered.length, 'one Default filter view per page with filters');
		const cardUrn = (key) => String(state.objects[`card:${key}`].extra?.urn ?? state.objects[`card:${key}`].id);
		for (const call of viewCreates) {
			assert.deepEqual([call.body.name, call.body.type, call.body.scope], ['Default', 'NAMED', 'PAGE']);
			const pageId = call.path.split('/')[4];
			const page = plan.pages.find((pg) => String(state.objects[`page:${pg.key}`]?.id) === pageId);
			const expected = page.filters.map(({ sourceCard, affectedCards, ...f }) => ({ ...f, dataSourceId: String(state.objects[f.dataSourceId.$ref].id), affectedCardUrns: (affectedCards ?? []).map(cardUrn), ...(sourceCard ? { sourceCardURN: cardUrn(sourceCard) } : {}) }));
			assert.deepEqual(call.body.filters, expected);
			if (page === filterPage) assert.deepEqual(call.body.filters, [{ column: 'Region', dataType: 'string', operand: 'IN', values: ['East', 'West'], filterType: 'LEGACY', dataSourceId: targetId, affectedCardUrns: [] }]);
			assert.equal(server.pageDefaults.get(pageId), [...server.filterViews.values()].find((v) => v.pageUrn === pageId).analyzerId, 'set as the page default');
		}
		const templateCreates = server.calls.filter((c) => c.method === 'POST' && c.path === '/query/v1/functions/template');
		assert.ok(templateCreates.every((c) => c.body.legacyId && !('owner' in c.body) && !('strict' in c.body)));
		for (const layout of server.layouts.values()) {
			for (const item of layout.content.filter((x) => x.type === 'CARD')) {
				assert.equal(typeof item.cardId, 'number', 'layout card ids are resolved');
				assert.ok(server.cards.has(item.cardId));
			}
		}

		server.reset();
		const second = await pushPlan({ config, slug, emitter: createEmitter(sink, 'push'), deps });
		assert.equal(second.ok, true);
		assert.equal(second.actions.filter((a) => a.action === 'create').length, 0, 'nothing is created twice');
		const creates = server.calls.filter(
			(c) =>
				(c.method === 'POST' && /^\/(data\/v2\/datasources|dataprocessing\/v1\/dataflows|query\/v1\/functions\/template|content\/v1\/pages)$/.test(c.path)) ||
				(c.method === 'PUT' && c.path === '/content/v3/cards/kpi')
		);
		assert.deepEqual(creates, []);
		assert.ok(!server.calls.some((c) => /\/uploads$/.test(c.path)), 'unchanged CSVs are not re-uploaded');
		assert.ok(!server.calls.some((c) => c.method !== 'GET' && /^\/(data\/v1\/data-files|content\/v1\/cards)/.test(c.path)), 'unchanged images are not uploaded again');
		assert.ok(second.actions.filter((a) => a.kind === 'filterview').every((a) => a.action === 'unchanged'));
		assert.ok(!server.calls.some((c) => /\/analyzer(\/\d+\/global)?$/.test(c.path) && c.method !== 'GET'), 'filter views are not written again');

		// A "Default" filter view t2d did not create is left alone unless it filters the same way.
		const stateFile = path.join(config.workspace, 'state', 'acme.json');
		const pageKey = filtered[0].key;
		const forget = () => {
			const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
			const entry = s.objects[`filterview:${pageKey}`];
			delete s.objects[`filterview:${pageKey}`];
			fs.writeFileSync(stateFile, JSON.stringify(s));
			return entry;
		};
		const entry = forget();
		const theirs = server.filterViews.get(entry.id);
		const saved = theirs.filters;
		theirs.filters = [{ column: 'Region', operand: 'IN', values: ['West'], dataType: 'string' }];
		server.reset();
		const foreign = await pushPlan({ config, slug, selection: { keys: [`filterview:${pageKey}`] }, emitter: createEmitter(sink, 'push'), deps });
		assert.deepEqual(foreign.actions.filter((a) => a.kind === 'filterview').map((a) => [a.action, a.status]), [['skip', 'skipped']]);
		assert.ok(foreign.issues.some((i) => i.code === 'push.filter-view-foreign'));
		assert.ok(!server.calls.some((c) => c.method !== 'GET' && /analyzer/.test(c.path)), 'nothing written to their view');
		theirs.filters = saved.map((f) => ({ ...f, dataSourceId: '', sourceCardURN: '1' }));
		const same = await pushPlan({ config, slug, selection: { keys: [`filterview:${pageKey}`] }, emitter: createEmitter(sink, 'push'), deps });
		assert.deepEqual(same.actions.filter((a) => a.kind === 'filterview').map((a) => [a.action, a.status]), [['reuse', 'ok']], 'an equivalent one is taken over');
		assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).objects[`filterview:${pageKey}`].extra.adopted, true);

		server.reset();
		const forced = await pushPlan({ config, slug, force: true, emitter: createEmitter(sink, 'push'), deps });
		assert.equal(forced.ok, true);
		assert.ok(forced.actions.some((a) => a.kind === 'card' && a.action === 'update'));
		assert.ok(server.calls.some((c) => c.method === 'PUT' && /^\/content\/v3\/cards\/kpi\/\d+$/.test(c.path)), 'cards are updated in place');
		assert.ok(server.calls.some((c) => c.method === 'PUT' && /^\/query\/v1\/functions\/template\/\d+$/.test(c.path)), 'beast modes are updated in place');
		assert.ok(!server.calls.some((c) => c.method === 'PUT' && c.path === '/content/v3/cards/kpi'));
	} finally {
		server.restore();
	}
});

test('variables mode pushes variables before the beast modes that use them', async () => {
	const stateFile = path.join(config.workspace, 'state', 'acme.json');
	const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	for (const key of Object.keys(state.objects)) if (key.startsWith('variable:')) delete state.objects[key];
	fs.writeFileSync(stateFile, JSON.stringify(state));
	const varPlan = await convertStage({ config, slug, options: { parameters: 'variables', target: 'pages', allBeastModes: true }, emitter: createEmitter(sink, 'convert') });
	assert.ok(varPlan.variables.length >= 1);
	const server = installDomoServer();
	try {
		const summary = await pushPlan({ config, slug, emitter: createEmitter(sink, 'push'), deps, force: true });
		assert.deepEqual(summary.actions.filter((a) => a.status === 'failed'), []);
		const templates = server.calls.filter((c) => c.method === 'POST' && c.path === '/query/v1/functions/template');
		const firstVariable = templates.findIndex((c) => c.body.variable === true);
		const lastVariable = templates.map((c) => c.body.variable === true).lastIndexOf(true);
		assert.ok(firstVariable >= 0, 'variables are created');
		assert.ok(templates.every((c, i) => c.body.variable === true || i > lastVariable), 'all variables precede new beast modes');
		assert.ok(templates.filter((c) => c.body.variable).every((c) => c.body.global === true && !c.body.links?.length));

		const variableIds = new Set([...server.templates.values()].filter((t) => t.variable).map((t) => String(t.id)));
		const writesOf = (c) => (c.method === 'POST' && c.path === '/query/v1/functions/template') || (c.method === 'PUT' && /^\/query\/v1\/functions\/template\/\d+$/.test(c.path));
		const beastModeWrites = server.calls.filter((c) => writesOf(c) && !c.body.variable && c.body.expression);
		const users = beastModeWrites.filter((c) => /DOMO_BEAST_MODE\(\d+\)/.test(c.body.expression));
		assert.ok(users.length >= 1, 'beast modes reference variables by template id');
		for (const u of users) for (const [, n] of u.body.expression.matchAll(/DOMO_BEAST_MODE\((\d+)\)/g)) assert.ok(variableIds.has(n), n);
		assert.ok(beastModeWrites.every((c) => !varPlan.variables.some((v) => c.body.expression.includes(`\`${v.name}\``))), 'no backticked variable names');
		const defaults = [...server.controls.values()].filter((x) => !x.entityType);
		assert.equal(defaults.length, varPlan.variables.length, 'one default control per variable');
		const placed = varPlan.pages.flatMap((pg) => (pg.layout?.content ?? []).filter((x) => x.type === 'VARIABLE'));
		assert.ok(placed.length >= 1, 'parameter controls are placed');
		const pageControls = [...server.controls.values()].filter((x) => x.entityType === 'PAGE');
		assert.equal(pageControls.length, placed.length);
		const written = [...server.layouts.values()].flatMap((l) => l.content ?? []).filter((x) => x.type === 'VARIABLE');
		assert.deepEqual(written.map((x) => x.variableControlId).sort(), pageControls.map((x) => x.id).sort());
		assert.ok(written.every((x) => x.control === undefined));
	} finally {
		server.restore();
		await convertStage({ config, slug, options: { target: 'pages', allBeastModes: true }, emitter: createEmitter(sink, 'convert') });
	}
});

test('report.md is written with the push results', () => {
	const report = fs.readFileSync(path.join(config.workspace, 'workbooks', slug, 'report.md'), 'utf8');
	assert.match(report, /superstore/i);
	assert.ok(!/[\u2013\u2014]/.test(report), 'no en or em dashes');
});

function cliEnv(extra = {}) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABLEAU_|DOMO_|T2D_)/.test(k)));
	return { ...env, NO_COLOR: '1', ...extra };
}

test('CLI help commands', async () => {
	const top = await run(process.execPath, [BIN, '--help'], { env: cliEnv(), cwd: tmp });
	assert.match(top.stdout, /Usage: t2d <command>/);
	const convert = await run(process.execPath, [BIN, 'convert', '--help'], { env: cliEnv(), cwd: tmp });
	assert.match(convert.stdout, /convert/);
	assert.match(convert.stdout, /--joins|--parameters|--workbook/);
});

test('CLI extract, convert and push --dry-run --json run offline', async () => {
	const workspace = path.join(tmp, 'cli-ws');
	const env = cliEnv({ DOMO_INSTANCE: 'dummy-instance', DOMO_ACCESS_TOKEN: 'dummy-token' });
	const opts = { env, cwd: tmp };
	await run(process.execPath, [BIN, 'extract', '--file', FIXTURE, '--data-strategy', 'none', '--workspace', workspace], opts);
	assert.ok(fs.existsSync(path.join(workspace, 'workbooks', 'superstore', 'ir.json')));
	await run(process.execPath, [BIN, 'convert', '--workbook', 'superstore', '--workspace', workspace], opts);
	const cliPlan = JSON.parse(fs.readFileSync(path.join(workspace, 'workbooks', 'superstore', 'plan.json'), 'utf8'));
	assert.ok(cliPlan.datasets.length >= 1, 'schema-only datasets are planned with data strategy none');
	assert.ok(cliPlan.cards.length >= 9);
	const push = await run(process.execPath, [BIN, 'push', '--workbook', 'superstore', '--dry-run', '--json', '--workspace', workspace], opts);
	const lines = push.stdout.trim().split('\n').map((l) => JSON.parse(l));
	const result = lines.at(-1);
	assert.equal(result.type, 'result');
	assert.equal(result.ok, true);
	const summary = result.result;
	assert.equal(summary.dryRun, true);
	assert.ok(summary.actions.length > 20);
	assert.ok(!summary.actions.some((a) => a.status === 'failed'));
	assert.ok(!fs.existsSync(path.join(workspace, 'state', 'dummy-instance.json')), 'a dry run saves no state');
});

test('superstore regression: combo card is multi-series (line measure, then bar measure, no VALUE), FIXED allows the datasource filter', () => {
	const combo = plan.cards.find((c) => c.title === 'Sales and Profit Ratio');
	assert.equal(combo.chartType, 'badge_line_bar');
	const columns = combo.body.definition.subscriptions.main.columns;
	assert.deepEqual(columns.map((c) => c.mapping), ['ITEM', 'SERIES', 'SERIES', 'EXTRAINFO1', 'EXTRAINFO2'], 'the default tooltip shows the percent label measure, then the Running Sales window function beast mode');
	const lifetime = plan.beastModes.find((b) => b.name === 'Customer Lifetime Sales');
	assert.match(lifetime.expression, /FILTER ALLOW `Country\/Region`, `Region`/);
});
