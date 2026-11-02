import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter } from '../../src/util/events.js';
import { createTimer, describeStep, formatBytes, formatDuration, formatTimingSummary, slowestSteps } from '../../src/util/timing.js';

function clock(start = Date.parse('2026-10-20T16:54:05.000Z')) {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
}

test('time, start and phase record steps with startedAt, ms and metadata', async () => {
	const c = clock();
	const timer = createTimer({ now: c.now });
	timer.phase('preflight');
	c.advance(100);
	timer.phase('datasets');
	const result = await timer.time(
		'datasets.upload',
		async () => {
			c.advance(2500);
			return { rowCount: 42 };
		},
		(r) => ({ key: 'orders', rows: r.rowCount, bytes: 2048 })
	);
	assert.deepEqual(result, { rowCount: 42 });
	const end = timer.start('dataflows.run', { name: 'Join' });
	c.advance(400);
	end({ waitMs: 300 });
	end({ waitMs: 999 });
	timer.phase('cards', false);
	c.advance(50);
	const timing = timer.finish();
	assert.equal(timing.startedAt, '2026-10-20T16:54:05.000Z');
	assert.equal(timing.ms, 3050);
	assert.equal(timing.finishedAt, '2026-10-20T16:54:08.050Z');
	assert.deepEqual(
		timing.steps.map((s) => [s.step, s.ms]),
		[['preflight', 100], ['datasets.upload', 2500], ['dataflows.run', 400], ['datasets', 2900]]
	);
	assert.deepEqual(timing.steps[1], { step: 'datasets.upload', startedAt: '2026-10-20T16:54:05.100Z', ms: 2500, key: 'orders', rows: 42, bytes: 2048 });
	assert.equal(timing.steps[2].waitMs, 300, 'a second end call is ignored');
	assert.equal(timer.finish(), timing, 'finish is idempotent');
});

test('a throwing step is recorded as failed and rethrown', async () => {
	const timer = createTimer();
	await assert.rejects(timer.time('tableau.sign-in', () => Promise.reject(new Error('401'))), /401/);
	assert.equal(timer.steps[0].step, 'tableau.sign-in');
	assert.equal(timer.steps[0].failed, true);
});

test('each step and the total are emitted as timing events', async () => {
	const events = [];
	const timer = createTimer({ emitter: createEmitter((e) => events.push(e), 'push') });
	await timer.time('variables', () => {}, { name: 'Region' });
	timer.finish({ slug: 'wb' });
	assert.deepEqual(events.map((e) => [e.type, e.stage, e.data.step]), [['timing', 'push', 'variables'], ['timing', 'push', 'total']]);
	assert.equal(events[1].data.slug, 'wb');
	assert.match(events[0].message, /^variables "Region": \d+ ms$/);
});

test('durations, bytes and step lines format for humans', () => {
	assert.equal(formatDuration(340), '340 ms');
	assert.equal(formatDuration(12_345), '12.3 s');
	assert.equal(formatDuration(245_000), '4m 05s');
	assert.equal(formatDuration(3_720_000), '1h 02m');
	assert.equal(formatBytes(512), '512 B');
	assert.equal(formatBytes(3.4 * 1024 * 1024), '3.4 MB');
	assert.equal(formatBytes(250 * 1024), '250 KB');
	assert.equal(describeStep({ step: 'datasets.upload', ms: 61_000, name: 'Orders', rows: 120000, bytes: 1536 }), 'datasets.upload "Orders": 1m 01s (120,000 rows, 1.5 KB)');
	assert.equal(describeStep({ step: 'dataflows.run', ms: 5000, key: 'df', waitMs: 4000, failed: true }), 'dataflows.run "df": 5.0 s (4.0 s waiting, failed)');
});

test('the summary gives the total, then the slowest steps first', () => {
	const timing = { ms: 9000, steps: [{ step: 'a', ms: 10 }, { step: 'b', ms: 5000 }, { step: 'c', ms: 300 }] };
	assert.deepEqual(slowestSteps(timing, 2).map((s) => s.step), ['b', 'c']);
	assert.deepEqual(formatTimingSummary(timing, { label: 'Push took', top: 2 }), ['Push took: 9.0 s', 'Slowest steps:', '  b: 5.0 s', '  c: 300 ms']);
	assert.deepEqual(formatTimingSummary(undefined), []);
});

test('base metadata is kept on a failed step whose metadata comes from the result', async () => {
	const timer = createTimer();
	await assert.rejects(timer.time('datasource.hyper-export', () => Promise.reject(new Error('no sidecar')), (r) => ({ tables: r.length }), { name: 'Orders' }));
	assert.deepEqual([timer.steps[0].name, timer.steps[0].failed, timer.steps[0].tables], ['Orders', true, undefined]);
});
