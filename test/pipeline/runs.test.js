import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestRunLogs, listRuns, parseRunLogName, runLogName, writeRunLog } from '../../src/pipeline/runs.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';

function workspace() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-runs-'));
	return { root, ws: openWorkspace(root) };
}

test('run log names are UTC timestamps to the second, safe for file systems', () => {
	assert.equal(runLogName('push', '2026-10-20T16:54:05.123Z'), 'push-2026-10-20T16-54-05Z.json');
	assert.equal(runLogName('extract', '2026-10-20T16:54:05.123Z', 2), 'extract-2026-10-20T16-54-05Z-2.json');
	assert.deepEqual(parseRunLogName('push-2026-10-20T16-54-05Z-2.json'), { stage: 'push', stamp: '2026-10-20T16-54-05Z', counter: 2 });
	assert.equal(parseRunLogName('push-log.json'), null);
	assert.equal(parseRunLogName('verify-2026-10-20T16-54-05Z.json'), null);
});

test('writeRunLog keeps every run, numbers runs in the same second, and prunes the oldest beyond keep', async () => {
	const { root, ws } = workspace();
	try {
		const files = [];
		for (const startedAt of ['2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.500Z', '2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z']) {
			files.push(path.basename(await writeRunLog(ws, 'wb', 'push', { startedAt, finishedAt: startedAt, ok: true, timing: { ms: 10, steps: [] } }, { keep: 3 })));
		}
		await writeRunLog(ws, 'wb', 'extract', { startedAt: '2026-10-19T09:00:00.000Z', ok: false, error: 'boom', timing: { ms: 5, steps: [] } }, { keep: 3 });
		assert.deepEqual(files, ['push-2026-10-20T10-00-00Z.json', 'push-2026-10-20T10-00-00Z-1.json', 'push-2026-10-20T11-00-00Z.json', 'push-2026-10-20T12-00-00Z.json']);
		const left = fs.readdirSync(ws.paths('wb').logsDir).sort();
		assert.deepEqual(left, ['extract-2026-10-19T09-00-00Z.json', 'push-2026-10-20T10-00-00Z-1.json', 'push-2026-10-20T11-00-00Z.json', 'push-2026-10-20T12-00-00Z.json'], 'the oldest push went, the other stage kept its log');
		const saved = JSON.parse(fs.readFileSync(path.join(ws.paths('wb').logsDir, left[3]), 'utf8'));
		assert.equal(saved.stage, 'push');

		const runs = await listRuns(ws, 'wb');
		assert.deepEqual(runs.map((r) => [r.stage, r.startedAt, r.ms, r.ok]), [
			['extract', '2026-10-19T09:00:00.000Z', 5, false],
			['push', '2026-10-20T10:00:00.500Z', 10, true],
			['push', '2026-10-20T11:00:00.000Z', 10, true],
			['push', '2026-10-20T12:00:00.000Z', 10, true]
		]);
		assert.equal(runs[0].error, 'boom');
		assert.deepEqual((await listRuns(ws, 'wb', { stage: 'extract' })).length, 1);
		assert.deepEqual(await listRuns(ws, 'other'), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('latestRunLogs prefers the current log file and falls back to the newest history log', async () => {
	const { root, ws } = workspace();
	try {
		const p = ws.paths('wb');
		await ws.writeJson(p.pushLog, { startedAt: '2026-10-20T12:00:00.000Z', current: true });
		await writeRunLog(ws, 'wb', 'push', { startedAt: '2026-10-20T13:00:00.000Z' });
		await writeRunLog(ws, 'wb', 'convert', { startedAt: '2026-10-20T09:00:00.000Z' });
		await writeRunLog(ws, 'wb', 'convert', { startedAt: '2026-10-20T10:00:00.000Z' });
		const latest = await latestRunLogs(ws, 'wb');
		assert.equal(latest.push.current, true);
		assert.equal(latest.convert.startedAt, '2026-10-20T10:00:00.000Z');
		assert.equal(latest.extract, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
