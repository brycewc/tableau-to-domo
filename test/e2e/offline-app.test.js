import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { convertStage } from '../../src/pipeline/convert.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { createDomoClient } from '../../src/domo/client.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { installDomoServer } from './domo-server.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/superstore.twbx');
const quiet = createEmitter(noopSink, 'test');
const deps = { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) };

let tmp;
let config;
let slug;
let plan;

before(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-e2e-app-'));
	config = { env: null, tableau: { server: '', site: '', patName: '', patSecret: '' }, domo: { instance: 'acme', accessToken: 'tok' }, workspace: path.join(tmp, 'ws'), python: 'python3' };
	slug = (await extractWorkbook({ config, file: FIXTURE, dataStrategy: 'none', domoLookup: false, emitter: quiet })).slug;
	plan = await convertStage({ config, slug, options: { namePrefix: '[t2d] ' }, emitter: quiet });
});

after(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('convert defaults to an App Studio app with one view per dashboard', () => {
	assert.equal(plan.target, 'app');
	assert.equal(plan.app.title, '[t2d] superstore');
	assert.deepEqual(plan.pages.filter((pg) => pg.dashboard).map((pg) => [pg.title, pg.appKey, pg.parentKey]), [
		['Executive Overview', plan.app.key, undefined],
		['Details', plan.app.key, undefined]
	]);
	assert.ok(!plan.pages.some((pg) => pg.key === plan.app.key), 'no root page');
});

test('push builds the app over HTTP, and a second push changes nothing', async () => {
	const server = installDomoServer();
	try {
		const first = await pushPlan({ config, slug, emitter: quiet, deps });
		assert.deepEqual(first.actions.filter((a) => a.status === 'failed'), []);
		const call = (method, re) => server.calls.findIndex((c) => c.method === method && re.test(c.path));
		const sequence = [
			call('GET', /^\/content\/v3\/customers\/acme\/features$/),
			call('POST', /^\/data\/v2\/datasources$/),
			call('POST', /^\/content\/v1\/dataapps$/),
			call('PUT', /^\/content\/v1\/dataapps\/\d+\/views\/\d+\/name$/),
			call('POST', /^\/content\/v1\/dataapps\/\d+\/views$/),
			call('PUT', /^\/content\/v3\/cards\/kpi$/),
			call('PUT', /^\/content\/v4\/pages\/layouts\/\d+$/),
			call('PUT', /^\/content\/v1\/dataapps\/\d+\/navigation\/reorder$/),
			call('PUT', /^\/content\/v1\/dataapps\/\d+\/landing\/\d+$/),
			call('PUT', /^\/content\/v1\/dataapps\/\d+\/persistSettings$/)
		];
		assert.ok(sequence.every((i) => i >= 0), `all endpoints called: ${sequence}`);
		assert.deepEqual([...sequence].sort((a, b) => a - b), sequence, 'endpoints called in push order');
		assert.ok(!server.calls.some((c) => c.path === '/content/v1/pages'), 'no classic pages');
		assert.equal(call('PUT', /^\/content\/v1\/dataapps\/\d+$/), -1, 'create carries the settings, so no app PUT follows it');
		const createBody = server.calls[call('POST', /^\/content\/v1\/dataapps$/)].body;
		assert.deepEqual([createBody.type, createBody.navOrientation, createBody.showNavigation], ['app', 'TOP', true]);
		const [app] = server.apps.values();
		assert.equal(app.title, '[t2d] superstore');
		assert.deepEqual(app.views.map((v) => v.title), ['Executive Overview', 'Details', 'Superstore Story', 'Worksheets']);
		assert.deepEqual(server.navigation.get(app.dataAppId).filter((n) => n.entity === 'VIEW').map((n) => n.title), ['Executive Overview', 'Details', 'Superstore Story', 'Worksheets']);
		const layoutPages = new Set([...server.layouts.values()].filter((l) => l.content.length).map((l) => Number(l.pageUrn)));
		assert.ok(app.views.every((v) => layoutPages.has(v.viewId)), 'every view has its layout');
		assert.equal(first.app.url, `https://acme.domo.com/app-studio/${app.dataAppId}`);
		const report = fs.readFileSync(path.join(config.workspace, 'workbooks', slug, 'report.md'), 'utf8');
		assert.match(report, /## App Studio app/);
		assert.ok(report.includes(`https://acme.domo.com/app-studio/${app.dataAppId}/pages/${app.views[0].viewId}`));

		server.reset();
		const second = await pushPlan({ config, slug, emitter: quiet, deps });
		assert.equal(second.ok, true);
		assert.equal(second.actions.filter((a) => a.action === 'create' || a.action === 'update').length, 0);
		assert.ok(!server.calls.some((c) => c.method !== 'GET'), server.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`).join(', '));
	} finally {
		server.restore();
	}
});
