import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createDomoClient } from '../../src/domo/client.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { planGraph, unpushPlan } from '../../src/pipeline/unpush.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { jsonBody, mockFetch } from '../domo/helpers.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
const deps = { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) };
let mock;
const roots = [];
afterEach(() => {
	mock?.restore();
	mock = undefined;
	roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});

async function pushed(plan = samplePlan()) {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, plan);
	const config = testConfig(root);
	await pushPlan({ config, slug: 'sales', deps: stubDomo().deps, emitter: quiet });
	return { ws, p, config, state: await loadState(ws, 'acme') };
}

/** Domo stand-in: deletes succeed (404 for `gone` ids), no foreign cards or subpages unless given. */
function domo({ gone = [], datasetCards = {}, cardViews = {}, subpages = {}, failBulk = false, lineage = {}, templateLinks = {}, lingering = [] } = {}) {
	let datasetDeleted = false;
	const template = (id) => (datasetDeleted && !lingering.includes(String(id)) ? { status: 404, json: {} } : { json: { id: Number(id), links: templateLinks[id] ?? [] } });
	return mockFetch([
		{
			method: 'DELETE',
			path: /.*/,
			repeat: true,
			handler: (call) => {
				if (call.path.startsWith('/data/v3/datasources/')) datasetDeleted = true;
				return { status: gone.some((id) => call.path.endsWith(`/${id}`)) ? 404 : 200 };
			}
		},
		{ method: 'GET', path: /^\/content\/v1\/pages\/\d+\/subpages$/, repeat: true, handler: (call) => ({ json: subpages[call.path.split('/')[4]] ?? [] }) },
		{ method: 'GET', path: /^\/content\/v1\/datasources\/[^/]+\/cards$/, repeat: true, handler: (call) => ({ json: datasetCards[call.path.split('/')[4]] ?? [] }) },
		{ method: 'GET', path: '/content/v1/cards', repeat: true, handler: (call) => ({ json: [{ id: Number(call.query.urns), adminAllPages: [], adminAllAppPages: (cardViews[call.query.urns] ?? []).map((v) => ({ appPageId: Number(v), appPageTitle: `View ${v}` })), adminAllReportPages: [] }] }) },
		{
			method: 'GET',
			path: /^\/data\/v1\/lineage\/DATA_SOURCE\/[^/]+$/,
			repeat: true,
			handler: (call) => {
				const id = call.path.split('/')[5];
				return { json: { [`DATA_SOURCE${id}`]: { type: 'DATA_SOURCE', id, children: lineage[id] ?? [] } } };
			}
		},
		{ method: 'GET', path: /^\/query\/v1\/functions\/template\/\d+$/, repeat: true, handler: (call) => template(call.path.split('/')[5]) },
		{ method: 'POST', path: '/query/v1/functions/bulk/template', repeat: true, handler: () => (failBulk ? { status: 400, json: { message: 'bad' } } : { json: { deleted: [] } }) }
	]);
}

const writes = () => mock.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

test('dry run lists deletions in order, makes no network calls and leaves state alone', async () => {
	const { ws, p, config, state } = await pushed();
	mock = domo();
	const summary = await unpushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.equal(mock.calls.length, 0);
	assert.deepEqual(
		summary.actions.map((a) => `${a.action} ${a.kind}:${a.key}`),
		['delete card:sheet-1', 'delete card:sheet-2', 'delete page:dash', 'delete layout:dash', 'delete page:root', 'delete dataset:orders', 'delete beastmode:orders:ratio']
	);
	assert.deepEqual((await loadState(ws, 'acme')).objects, state.objects);
	assert.ok(fs.existsSync(p.unpushDryRun));
});

test('unpush deletes cards, pages, datasets in order, empties state, and a re-run touches nothing', async () => {
	const { ws, p, config, state } = await pushed();
	const ids = Object.fromEntries(Object.entries(state.objects).map(([k, v]) => [k, v.id]));
	mock = domo();
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.ok, true);
	assert.deepEqual(writes(), [
		`DELETE /content/v1/cards/${ids['card:sheet-1']}`,
		`DELETE /content/v1/cards/${ids['card:sheet-2']}`,
		`DELETE /content/v1/pages/${ids['page:dash']}`,
		`DELETE /content/v1/pages/${ids['page:root']}`,
		'DELETE /data/v3/datasources/ds-orders'
	]);
	assert.ok(!mock.calls.some((c) => c.path.includes('bulk')), 'dataset beast modes go with the dataset');
	assert.deepEqual((await loadState(ws, 'acme')).objects, {});
	assert.ok(fs.existsSync(p.unpushLog));
	mock.restore();
	mock = domo();
	const again = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(mock.calls.length, 0);
	assert.equal(again.actions.length, 0);
});

test('dataset beast modes are polled until they 404; one that lingers without links is deleted, one with links stays', async () => {
	const { ws, config, state } = await pushed();
	const ratio = String(state.objects['beastmode:orders:ratio'].id);
	const fast = { intervalMs: 1, timeoutMs: 20 };
	mock = domo({ lingering: [ratio] });
	const summary = await unpushPlan({ config, slug: 'sales', deps, templateWait: fast, emitter: quiet });
	const bm = summary.actions.find((a) => a.key === 'orders:ratio');
	assert.equal(bm.status, 'ok');
	assert.match(bm.notes.join(), /still present/);
	assert.deepEqual(jsonBody(mock.calls.find((c) => c.path === '/query/v1/functions/bulk/template')), { delete: [Number(ratio)] });
	assert.ok(mock.calls.filter((c) => c.path.endsWith(`/template/${ratio}`)).length > 1, 'polled more than once');
	assert.deepEqual((await loadState(ws, 'acme')).objects, {});

	const again = await pushed();
	const id = String(again.state.objects['beastmode:orders:ratio'].id);
	mock.restore();
	mock = domo({ lingering: [id], templateLinks: { [id]: [{ resource: { type: 'CARD', id: '4242' }, active: true }, { resource: { type: 'DATA_SOURCE', id: 'ds-orders' }, active: true }] } });
	const linked = await unpushPlan({ config: again.config, slug: 'sales', deps, templateWait: fast, emitter: quiet });
	const row = linked.actions.find((a) => a.key === 'orders:ratio');
	assert.equal(row.status, 'skipped');
	assert.match(row.error, /CARD 4242/);
	assert.doesNotMatch(row.error, /DATA_SOURCE/, 'the deleted dataset link does not count');
	assert.ok(!mock.calls.some((c) => c.path === '/query/v1/functions/bulk/template'));
});

test('404 counts as deleted; foreign cards and subpages keep their dataset and page', async () => {
	const { ws, config, state } = await pushed();
	const sheet1 = state.objects['card:sheet-1'].id;
	const root = state.objects['page:root'].id;
	mock = domo({ gone: [sheet1], datasetCards: { 'ds-orders': [{ id: 999 }] }, subpages: { [root]: [12345] } });
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const row = (ref) => summary.actions.find((a) => `${a.kind}:${a.key}` === ref);
	assert.match(row('card:sheet-1').notes.join(), /already deleted/);
	assert.equal(row('page:root').status, 'skipped');
	assert.match(row('page:root').error, /subpage/);
	assert.equal(row('dataset:orders').status, 'skipped');
	assert.match(row('dataset:orders').error, /999/);
	assert.ok(!writes().some((w) => w.includes('/datasources/') || w.endsWith(`/pages/${root}`)));
	const left = Object.keys((await loadState(ws, 'acme')).objects).sort();
	assert.deepEqual(left, ['dataset:orders', 'page:root'], 'the beast mode only our deleted cards used is removed with the bulk delete');
});

test('a t2d card that a view t2d did not create shows stays, and so does its dataset; one on our own pages is deleted', async () => {
	const { ws, config, state } = await pushed();
	const sheet1 = state.objects['card:sheet-1'].id;
	const sheet2 = state.objects['card:sheet-2'].id;
	const dash = state.objects['page:dash'].id;
	mock = domo({ cardViews: { [sheet1]: [dash, 900000001] }, datasetCards: { 'ds-orders': [{ id: sheet1 }, { id: sheet2 }] } });
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const row = (ref) => summary.actions.find((a) => `${a.kind}:${a.key}` === ref);
	assert.equal(row('card:sheet-1').status, 'skipped');
	assert.match(row('card:sheet-1').error, /view 900000001 "View 900000001"/);
	assert.doesNotMatch(row('card:sheet-1').error, new RegExp(`view ${dash}\\b`), 'a page this unpush deletes is not foreign');
	assert.equal(row('card:sheet-2').status, 'ok');
	assert.ok(summary.issues.some((i) => i.code === 'unpush.card-foreign-placement'));
	assert.ok(!writes().includes(`DELETE /content/v1/cards/${sheet1}`));
	assert.equal(row('dataset:orders').status, 'skipped', 'the kept card keeps its dataset');
	assert.ok(Object.keys((await loadState(ws, 'acme')).objects).includes('card:sheet-1'));
	const dry = await unpushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.match(dry.actions.find((a) => a.key === 'sheet-1').notes.join(), /checked only on a real run/);
});

test('existing datasets are never deleted; their beast modes use the bulk delete; shared entries stay', async () => {
	const plan = samplePlan();
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'existing', existing: { datasetId: 'ds-existing' }, upload: undefined };
	const { ws, config } = await pushed(plan);
	const state = await loadState(ws, 'acme');
	state.objects['card:sheet-1'].extra.workbooks = ['sales', 'other'];
	await saveState(ws, state);
	const ratio = state.objects['beastmode:orders:ratio'].id;
	const templateLinks = {
		[ratio]: [
			{ resource: { type: 'DATA_SOURCE', id: 'ds-existing' }, visible: true, active: true },
			{ resource: { type: 'FUNCTION_TEMPLATE', id: '77' }, visible: false, active: true },
			{ resource: { type: 'DATA_SOURCE', id: 'old' }, visible: false, active: false }
		]
	};
	mock = domo({ templateLinks });
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.ok(!writes().some((w) => w.includes('ds-existing')));
	assert.equal(summary.actions.find((a) => a.kind === 'dataset').action, 'keep');
	assert.equal(summary.actions.find((a) => a.key === 'sheet-1').action, 'keep');
	const bulk = mock.calls.find((c) => c.path === '/query/v1/functions/bulk/template');
	assert.deepEqual(jsonBody(bulk), {
		delete: [ratio],
		links: { [ratio]: { linkTo: [{ resource: { type: 'DATA_SOURCE', id: 'ds-existing' }, visible: true, active: false }] } }
	}, 'the kept dataset link is deactivated in the same request, since a linked template cannot be deleted');
	const after = await loadState(ws, 'acme');
	assert.deepEqual(after.objects['card:sheet-1'].extra.workbooks, ['other']);
	assert.equal(after.objects['dataset:orders'], undefined);
	assert.equal(after.objects['beastmode:orders:ratio'], undefined);
});

test('kinds and keys narrow the scope without breaking what stays', async () => {
	const { ws, config } = await pushed();
	mock = domo();
	const summary = await unpushPlan({ config, slug: 'sales', deps, selection: { kinds: ['datasets'] }, emitter: quiet });
	assert.equal(writes().length, 0);
	assert.equal(summary.actions[0].status, 'skipped');
	assert.match(summary.actions[0].error, /still needed by card:sheet-1, card:sheet-2/);
	const cardsOnly = await unpushPlan({ config, slug: 'sales', deps, selection: { keys: ['card:sheet-2'] }, emitter: quiet });
	assert.deepEqual(cardsOnly.actions.map((a) => a.key), ['sheet-2']);
	assert.ok((await loadState(ws, 'acme')).objects['card:sheet-1']);
	const layouts = await unpushPlan({ config, slug: 'sales', dryRun: true, selection: { kinds: ['layouts'] }, emitter: quiet });
	assert.match(layouts.actions[0].error, /removed with their pages/);
});

test('variables use the single DELETE so Domo also removes their default controls', async () => {
	const { ws, config } = await pushed();
	const state = await loadState(ws, 'acme');
	state.objects['variable:param.region.string'] = { id: 555, extra: { createdBy: 'sales', workbooks: ['sales'] } };
	await saveState(ws, state);
	mock = domo();
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const variable = summary.actions.find((a) => a.kind === 'variable');
	assert.equal(variable?.status, 'ok');
	assert.ok(writes().includes('DELETE /query/v1/functions/template/555'));
	const bulkIds = mock.calls.filter((c) => c.path === '/query/v1/functions/bulk/template').flatMap((c) => jsonBody(c).delete);
	assert.ok(!bulkIds.includes(555));
	assert.equal((await loadState(ws, 'acme')).objects['variable:param.region.string'], undefined);
});

test('a variable push found on the instance is kept, only forgotten', async () => {
	const { ws, config } = await pushed();
	const state = await loadState(ws, 'acme');
	state.objects['variable:param.region.string'] = { id: 557, extra: { createdBy: 'sales', workbooks: ['sales'], adopted: true } };
	await saveState(ws, state);
	mock = domo();
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const variable = summary.actions.find((a) => a.kind === 'variable');
	assert.equal(variable?.action, 'keep');
	assert.ok(!writes().some((w) => w.includes('/557')));
	assert.equal((await loadState(ws, 'acme')).objects['variable:param.region.string'], undefined);
});

test('a variable another beast mode still uses is not deleted', async () => {
	const { ws, config } = await pushed();
	const state = await loadState(ws, 'acme');
	state.objects['variable:param.region.string'] = { id: 558, extra: { createdBy: 'sales', workbooks: ['sales'] } };
	await saveState(ws, state);
	mock = mockFetch([
		{ method: 'GET', path: '/query/v1/functions/template/558', repeat: true, handler: () => ({ json: { id: 558, links: [{ resource: { type: 'FUNCTION_TEMPLATE', id: 9001 } }, { resource: { type: 'FUNCTION_TEMPLATE', id: 9002 } }] } }) },
		{ method: 'GET', path: '/query/v1/functions/template/9001', repeat: true, handler: () => ({ json: { id: 9001, links: [] } }) },
		{ method: 'GET', path: /^\/query\/v1\/functions\/template\/\d+$/, repeat: true, handler: () => ({ status: 404, json: {} }) },
		{ method: 'GET', path: /.*/, repeat: true, handler: () => ({ json: [] }) },
		{ method: 'DELETE', path: /.*/, repeat: true, handler: () => ({ status: 200 }) },
		{ method: 'POST', path: '/query/v1/functions/bulk/template', repeat: true, handler: () => ({ json: { deleted: [] } }) }
	]);
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const variable = summary.actions.find((a) => a.kind === 'variable');
	assert.equal(variable?.status, 'skipped');
	assert.match(variable.error, /1 beast mode\(s\) not deleted by this unpush use it \(9001\)/);
	assert.ok(!mock.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/558')));
});

test('a variable the single DELETE refuses falls back to the bulk delete with a warning', async () => {
	const { ws, config } = await pushed();
	const state = await loadState(ws, 'acme');
	state.objects['variable:param.region.string'] = { id: 556, extra: { createdBy: 'sales', workbooks: ['sales'] } };
	await saveState(ws, state);
	mock = mockFetch([
		{ method: 'DELETE', path: '/query/v1/functions/template/556', handler: () => ({ status: 400, json: { message: 'Cannot delete a function template with active links' } }) },
		{ method: 'DELETE', path: /.*/, repeat: true, handler: () => ({ status: 200 }) },
		{ method: 'GET', path: '/query/v1/functions/template/556', repeat: true, handler: () => ({ json: { id: 556, links: [] } }) },
		{ method: 'GET', path: /^\/query\/v1\/functions\/template\/\d+$/, repeat: true, handler: () => ({ status: 404, json: {} }) },
		{ method: 'GET', path: /.*/, repeat: true, handler: () => ({ json: [] }) },
		{ method: 'POST', path: '/query/v1/functions/bulk/template', repeat: true, handler: () => ({ json: { deleted: [] } }) }
	]);
	const warnings = [];
	const emitter = createEmitter((e) => e.type === 'warn' && warnings.push(e.message), 'test');
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter });
	assert.equal(summary.actions.find((a) => a.kind === 'variable')?.status, 'ok');
	assert.ok(mock.calls.some((c) => c.path === '/query/v1/functions/bulk/template' && jsonBody(c).delete.includes(556)));
	assert.ok(warnings.some((w) => /default variable control/.test(w)));
});

test('a failed bulk beast mode delete falls back to one at a time and records failures', async () => {
	const plan = samplePlan();
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'existing', existing: { datasetId: 'ds-existing' }, upload: undefined };
	const { ws, config } = await pushed(plan);
	mock = domo({ failBulk: true });
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const bm = summary.actions.find((a) => a.kind === 'beastmode');
	assert.equal(bm.status, 'failed');
	assert.equal(summary.ok, false);
	assert.ok((await loadState(ws, 'acme')).objects['beastmode:orders:ratio'], 'failed objects stay in state');
});

test('planGraph links cards to datasets and beast modes, pages to parents, dataflows to inputs and outputs', () => {
	const plan = samplePlan();
	plan.dataflows = [{ key: 'df', name: 'DF', definition: { a: { $ref: 'dataset:orders' } }, outputDatasetKeys: ['out'] }];
	const { dependents } = planGraph(plan);
	assert.deepEqual([...dependents.get('dataset:orders')].sort(), ['beastmode:orders:bad', 'beastmode:orders:ratio', 'card:sheet-1', 'card:sheet-2', 'dataflow:df']);
	assert.deepEqual([...dependents.get('beastmode:orders:ratio')], ['card:sheet-2']);
	assert.deepEqual([...dependents.get('page:root')], ['page:dash']);
	assert.deepEqual([...dependents.get('dataset:out')], ['dataflow:df']);
});

function twoDashboards() {
	const plan = samplePlan();
	plan.cards[0].pageKeys = ['dash', 'dash2'];
	plan.pages.unshift({
		key: 'dash2',
		title: 'Detail',
		parentKey: 'root',
		dashboard: 'Detail',
		layout: {
			content: [{ contentKey: 1, type: 'CARD', cardId: ref('card', 'sheet-1') }],
			standard: { width: 60, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 30, height: 20 }] },
			compact: { width: 12, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 12 }] }
		}
	});
	return plan;
}

test('a subset unpush keeps a card that another remaining dashboard still shows', async () => {
	const { config } = await pushed(twoDashboards());
	const summary = await unpushPlan({ config, slug: 'sales', dryRun: true, selection: { dashboards: ['Overview'] }, emitter: quiet });
	const row = (ref) => summary.actions.find((a) => `${a.kind}:${a.key}` === ref);
	assert.equal(row('card:sheet-1').status, 'skipped');
	assert.match(row('card:sheet-1').error, /layout:dash2|page:dash2/);
	assert.equal(row('card:sheet-2').action, 'delete');
	assert.equal(row('page:dash').action, 'delete');
	assert.equal(row('page:dash2'), undefined);
	const all = await unpushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.equal(all.actions.find((a) => a.key === 'sheet-1').action, 'delete', 'a full unpush still removes it');
});

test('beast modes linked to cards this unpush does not delete stay', async () => {
	const plan = samplePlan();
	plan.datasets[0] = { ...plan.datasets[0], strategy: 'existing', existing: { datasetId: 'ds-existing' }, upload: undefined };
	const { ws, config, state } = await pushed(plan);
	const bmId = state.objects['beastmode:orders:ratio'].id;
	mock = domo({ templateLinks: { [bmId]: [{ resource: { type: 'CARD', id: '4242' }, active: true }, { resource: { type: 'DATA_SOURCE', id: 'ds-existing' }, active: true }] } });
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const bm = summary.actions.find((a) => a.key === 'orders:ratio');
	assert.equal(bm.status, 'skipped');
	assert.match(bm.error, /4242/);
	assert.ok(!mock.calls.some((c) => c.path === '/query/v1/functions/bulk/template'));
	assert.ok((await loadState(ws, 'acme')).objects['beastmode:orders:ratio']);
});

test('a dataset another state entry or a dataflow still reads is not deleted', async () => {
	const { ws, config } = await pushed();
	const state = await loadState(ws, 'acme');
	state.objects['dataset:other.orders'] = { id: 'ds-orders', extra: { strategy: 'cloud-amplifier', alreadyRegistered: true, workbooks: ['other'] } };
	await saveState(ws, state);
	mock = domo();
	const first = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	const ds = first.actions.find((a) => a.key === 'orders');
	assert.equal(ds.status, 'skipped');
	assert.match(ds.error, /dataset:other\.orders/);
	assert.ok(!writes().some((w) => w.includes('/datasources/')));

	const after = await loadState(ws, 'acme');
	delete after.objects['dataset:other.orders'];
	await saveState(ws, after);
	mock.restore();
	mock = domo({ lineage: { 'ds-orders': [{ type: 'DATAFLOW', id: '77' }] } });
	const second = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.match(second.actions.find((a) => a.key === 'orders').error, /dataflow 77/);
	assert.ok(!writes().some((w) => w.includes('/datasources/')));
});

test('a Cloud Amplifier dataset whose ownership is uncertain is kept and reported', async () => {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	await ws.writeJson(ws.paths('sales').plan, { ...samplePlan(), cards: [], pages: [], beastModes: [] });
	await saveState(ws, { version: 1, instance: 'acme', objects: { 'dataset:orders': { id: 'ca-x', extra: { strategy: 'cloud-amplifier', alreadyRegistered: false, ownershipUncertain: true, workbooks: ['sales'] } } } });
	const config = testConfig(root);
	mock = domo();
	const summary = await unpushPlan({ config, slug: 'sales', deps, emitter: quiet });
	assert.equal(summary.actions[0].action, 'keep');
	assert.ok(summary.issues.some((i) => i.code === 'unpush.ownership-uncertain'));
	assert.equal(writes().length, 0);
});

test('a card is deleted with its drill views, whose beast mode links do not keep the beast mode', async () => {
	const { ws, config, state } = await pushed();
	const card = state.objects['card:sheet-1'];
	card.extra = { ...card.extra, drillViews: [{ id: 4001, field: '[State]', hash: 'h' }] };
	await saveState(ws, state);
	const ratio = String(state.objects['beastmode:orders:ratio'].id);
	mock = domo({ lingering: [ratio], templateLinks: { [ratio]: [{ resource: { type: 'CARD', id: '4001' }, active: true }] } });
	const summary = await unpushPlan({ config, slug: 'sales', deps, templateWait: { intervalMs: 1, timeoutMs: 20 }, emitter: quiet });
	assert.match(summary.actions.find((a) => a.key === 'sheet-1').notes.join(), /its 1 drill view\(s\), which Domo deletes with it/);
	assert.ok(!writes().includes('DELETE /content/v1/cards/4001'));
	const bm = summary.actions.find((a) => a.key === 'orders:ratio');
	assert.equal(bm.status, 'ok', bm.error);
});
