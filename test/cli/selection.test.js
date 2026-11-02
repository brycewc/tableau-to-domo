import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { main } from '../../src/cli/main.js';
import { selectionFrom } from '../../src/cli/shared.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { superstorePlan } from '../convert/superstore-plan.js';
import { stubDomo, tempDir, testConfig } from '../pipeline/helpers.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { samplePlan } from '../pipeline/helpers.js';

function capture({ tty = false } = {}) {
	const out = [];
	const err = [];
	return {
		io: { stdout: { write: (s) => out.push(s), isTTY: false }, stderr: { write: (s) => err.push(s), isTTY: false }, stdin: { isTTY: tty }, env: { NO_COLOR: '1' } },
		out: () => out.join(''),
		err: () => err.join('')
	};
}

let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

test('show lists dashboards, worksheets, datasources and plan keys (text and --json)', async () => {
	const { config, slug, cleanup } = await superstorePlan();
	try {
		const c = capture();
		assert.equal(await main(['show', '--workbook', slug], { ...c.io, loadConfig: () => config }), 0);
		assert.match(c.out(), /Executive Overview\s+.*Sales by Category/);
		assert.match(c.out(), /Datasource\s+Data strategy/);
		assert.match(c.out(), /cards: superstore\.sales-by-category/);
		const j = capture();
		assert.equal(await main(['--json', 'show', '-w', slug], { ...j.io, loadConfig: () => config }), 0);
		const result = JSON.parse(j.out().trim().split('\n').at(-1)).result;
		assert.deepEqual(result.dashboards.map((d) => d.name), ['Executive Overview', 'Details']);
		assert.ok(result.datasources.some((d) => d.strategy === 'hyper'));
		assert.ok(result.plan.keys.beastmodes.length > 5);

		const bad = capture();
		assert.equal(await main(['push', '-w', slug, '--dry-run', '--dashboards', 'Nope'], { ...bad.io, loadConfig: () => config }), 2);
		assert.match(bad.err(), /Unknown dashboard "Nope"\. Valid dashboards/);
		const ok = capture();
		assert.equal(await main(['push', '-w', slug, '--dry-run', '--dashboards', 'details', '--only', 'datasets,dataflows,beastmodes,pages,cards,layouts'], { ...ok.io, loadConfig: () => config }), 0);
		assert.match(ok.out(), /Sales Crosstab/);
		assert.doesNotMatch(ok.out(), /Sales by Category/);
	} finally {
		cleanup();
	}
});

test('selection flags parse; bad sample rows and kinds are usage errors', () => {
	assert.deepEqual(selectionFrom({ dashboards: ['A,B'], 'sample-rows': '5', 'schema-only': true, keys: 'x,y' }), { dashboards: ['A,B'], keys: ['x', 'y'], sampleRows: 5, schemaOnly: true });
	assert.throws(() => selectionFrom({ 'sample-rows': 'x' }), { name: 'UsageError', message: /--sample-rows/ });
	assert.throws(() => selectionFrom({ only: 'widgets' }, { kinds: true }), /Unknown kind/);
});

test('unpush needs --yes without a TTY; --dry-run prints what would be deleted', async () => {
	const root = tempDir();
	try {
		const ws = openWorkspace(root);
		const p = ws.paths('sales');
		fs.mkdirSync(`${p.dir}/data/orders`, { recursive: true });
		fs.writeFileSync(`${p.dir}/data/orders/orders.csv`, 'Region,Sales\nEast,1\n');
		await ws.writeJson(p.plan, samplePlan());
		const config = testConfig(root);
		await pushPlan({ config, slug: 'sales', deps: stubDomo().deps, emitter: createEmitter(noopSink, 'test') });
		const c = capture();
		assert.equal(await main(['unpush', '--workbook', 'sales'], { ...c.io, loadConfig: () => config }), 2);
		assert.match(c.err(), /non-interactive/);
		const d = capture();
		assert.equal(await main(['unpush', '--workbook', 'sales', '--dry-run'], { ...d.io, loadConfig: () => config }), 0);
		assert.match(d.out(), /Dry run against acme: 7 delete/);
		const bad = capture();
		assert.equal(await main(['unpush', '--workbook', 'sales', '--dry-run', '--only', 'widgets'], { ...bad.io, loadConfig: () => config }), 2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
