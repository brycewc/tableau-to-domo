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
import { fakeHyperPython } from '../data/helpers.js';
import { installDomoServer } from './domo-server.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/superstore.twbx');
const BIN = path.join(ROOT, 'bin/t2d.js');

const ORDERS_HEADER = 'Row ID,Order ID,Order Date,Ship Date,Ship Mode,Customer ID,Customer Name,Segment,Country/Region,City,State/Province,Postal Code,Region,Product ID,Category,Sub-Category,Product Name,Sales,Quantity,Discount,Profit';
const ORDERS = `${ORDERS_HEADER}
1,CA-1,2024-01-03,2024-01-05,Second Class,C1,Ann,Consumer,United States,Austin,Texas,07001,Central,P1,Furniture,Chairs,Chair,261.96,2,0,41.91
2,CA-2,2024-02-03,2024-02-06,Same Day,C2,Bob,Corporate,United States,Boston,Massachusetts,02101,East,P2,Technology,Phones,Phone,731.94,3,0.2,-12.5
`;
const col = (name, type = 'TEXT') => ({ name, type, nullable: true });

let tmp;
let config;
let extracted;
let dir;
const events = [];
const sink = (e) => events.push(e);
const deps = { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) };
const logs = (stage) => fs.readdirSync(path.join(dir, 'logs')).filter((f) => f.startsWith(`${stage}-`));

before(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-timing-'));
	const python = fakeHyperPython(tmp, [
		{ schema: 'Extract', name: 'Orders_ECFCA1FB690A41FE803BC071773BA862', csv: ORDERS, rowCount: 2, columns: ORDERS_HEADER.split(',').map((n) => col(n)) },
		{ schema: 'Extract', name: 'People_D73023733B004CC1B3CB1ACF62F4A965', csv: 'Regional Manager,Region\nChris,Central\n', rowCount: 1, columns: [col('Regional Manager'), col('Region')] },
		{ schema: 'Extract', name: 'Returns_2AA0FADE3C8A4E1A9A4B4F8E1B2C3D4E', csv: 'Returned,Order ID\nYes,CA-2\n', rowCount: 1, columns: [col('Returned'), col('Order ID')] }
	]);
	config = { env: null, tableau: { server: '', site: '', patName: '', patSecret: '' }, domo: { instance: 'acme', accessToken: 'tok' }, workspace: path.join(tmp, 'ws'), python };
	extracted = await extractWorkbook({ config, file: FIXTURE, dataStrategy: 'auto', unmapped: 'export', emitter: createEmitter(sink, 'extract') });
	dir = path.join(config.workspace, 'workbooks', extracted.slug);
	await convertStage({ config, slug: extracted.slug, options: { target: 'pages' }, emitter: createEmitter(sink, 'convert') });
});

after(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('extract records the parse, and per datasource the unpack, Hyper export and CSVs with rows and bytes', () => {
	const steps = extracted.timing.steps;
	const names = new Set(steps.map((s) => s.step));
	for (const step of ['workbook.parse', 'datasource', 'datasource.unpack', 'datasource.hyper-export', 'datasource.csv']) assert.ok(names.has(step), `${step} recorded`);
	const data = steps.filter((s) => s.step === 'datasource');
	assert.ok(data.some((s) => s.strategy === 'hyper' && s.rows > 0 && s.bytes > 0), JSON.stringify(data));
	assert.ok(steps.find((s) => s.step === 'datasource.unpack').bytes > 0);

	const log = JSON.parse(fs.readFileSync(path.join(dir, 'extract-log.json'), 'utf8'));
	assert.equal(log.ok, true);
	assert.equal(log.source, 'file');
	assert.equal(log.timing.ms, extracted.timing.ms);
	assert.ok(log.datasources.some((d) => d.rows > 0 && d.bytes > 0));
	assert.equal(logs('extract').length, 1);
	assert.equal(logs('convert').length, 1);
	assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'convert-log.json'), 'utf8')).timing.steps.some((s) => s.step === 'convert'));
	assert.ok(events.some((e) => e.type === 'timing' && e.stage === 'extract' && e.data.step === 'total'));
});

test('a dry run is timed but writes no history log', async () => {
	const server = installDomoServer();
	try {
		const summary = await pushPlan({ config, slug: extracted.slug, dryRun: true, emitter: createEmitter(sink, 'push') });
		assert.ok(summary.timing.steps.some((s) => s.step === 'preflight'));
		assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'push-dry-run.json'), 'utf8')).timing);
		assert.deepEqual(logs('push'), []);
	} finally {
		server.restore();
	}
});

test('push records preflight, each stage, uploads and dataflow runs, and keeps one log per run', async () => {
	const server = installDomoServer();
	try {
		events.length = 0;
		const first = await pushPlan({ config, slug: extracted.slug, emitter: createEmitter(sink, 'push'), deps });
		assert.equal(first.ok, true);
		const names = first.timing.steps.map((s) => s.step);
		for (const step of ['preflight', 'datasets', 'datasets.upload', 'dataflows', 'dataflows.run', 'beastmodes', 'pages', 'cards', 'layouts']) assert.ok(names.includes(step), `${step} recorded`);
		const upload = first.timing.steps.find((s) => s.step === 'datasets.upload');
		assert.ok(upload.key && upload.bytes > 0 && upload.rows === 2, JSON.stringify(upload));
		assert.ok(first.timing.steps.find((s) => s.step === 'dataflows.run').waitMs >= 0);
		assert.equal(first.finishedAt, first.timing.finishedAt);
		assert.ok(events.some((e) => e.type === 'timing' && e.stage === 'push' && e.data.step === 'datasets.upload'));

		const current = JSON.parse(fs.readFileSync(path.join(dir, 'push-log.json'), 'utf8'));
		assert.equal(current.timing.ms, first.timing.ms);
		assert.ok(current.actions.length && current.counts, 'the current log keeps its shape');

		await new Promise((r) => setTimeout(r, 5));
		const second = await pushPlan({ config, slug: extracted.slug, emitter: createEmitter(sink, 'push'), deps });
		assert.equal(second.counts.create ?? 0, 0);
		assert.ok(!second.timing.steps.some((s) => s.step === 'datasets.upload'), 'unchanged data is not uploaded or timed');
		assert.equal(logs('push').length, 2);

		const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
		assert.match(report, /## Timing/);
		assert.match(report, /\| extract \|/);
		assert.match(report, /\| push \|/);
		assert.ok(!/[\u2013\u2014]/.test(report), 'no en or em dashes');
	} finally {
		server.restore();
	}
});

test('t2d status --runs lists the runs with their durations', async () => {
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABLEAU_|DOMO_|T2D_)/.test(k))), NO_COLOR: '1' };
	const opts = { env, cwd: tmp };
	const text = await run(process.execPath, [BIN, 'status', '--workbook', extracted.slug, '--runs', '--workspace', config.workspace], opts);
	assert.match(text.stdout, /Started\s+Stage\s+Duration\s+Result/);
	assert.equal(text.stdout.match(/ push /g)?.length, 2);
	assert.match(text.stdout, / extract /);
	const json = await run(process.execPath, [BIN, 'status', '--workbook', extracted.slug, '--runs', '--json', '--workspace', config.workspace], opts);
	const result = JSON.parse(json.stdout.trim().split('\n').at(-1)).result;
	assert.deepEqual(result.runs.map((r) => r.stage), ['extract', 'convert', 'push', 'push']);
	assert.ok(result.runs.every((r) => typeof r.ms === 'number' && r.ok));
});
