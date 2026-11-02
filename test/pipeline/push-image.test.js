import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createDomoClient } from '../../src/domo/client.js';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { unpushPlan } from '../../src/pipeline/unpush.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { ref } from '../../src/util/refs.js';
import { mockFetch } from '../domo/helpers.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let mock;
afterEach(() => {
	mock?.restore();
	mock = undefined;
});

function imagePlan(bytes, size = {}) {
	const plan = samplePlan();
	plan.beastModes = [];
	plan.cards = [{ key: 'dash.image.7', kind: 'image', title: 'banner.png', worksheet: '', datasetKey: '', chartType: 'document', body: { image: { file: 'images/banner.png', name: 'banner.png', bytes: bytes.length, md5: md5(bytes), ...size } }, pageKeys: ['dash'], status: 'ok' }];
	plan.pages[0].layout = {
		content: [{ contentKey: 1, type: 'CARD', cardId: ref('card', 'dash.image.7'), hideTitle: true, fitToFrame: true }],
		standard: { width: 60, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 60, height: 9 }] },
		compact: { width: 12, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 6 }] }
	};
	return plan;
}

async function setup(bytes, size) {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'images'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'images', 'banner.png'), bytes);
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, imagePlan(bytes, size));
	return { ws, p, config: testConfig(root) };
}

function withFiles({ present = true } = {}) {
	const stub = stubDomo({ invalid: [] });
	const { deps, calls } = stub;
	let next = 40;
	deps.files = {
		uploadDataFile: async (_c, bytes, name) => {
			calls.push({ name: 'uploadDataFile', args: { text: bytes.toString(), name } });
			return { id: ++next };
		},
		uploadDataFileVersion: async (_c, id, bytes, name) => calls.push({ name: 'uploadDataFileVersion', args: { id, text: bytes.toString(), name } }),
		getDataFileDetails: async (_c, id) => {
			calls.push({ name: 'getDataFileDetails', args: { id } });
			return present ? { id, currentRevision: { md5Hash: 'X' } } : undefined;
		},
		deleteDataFile: async (_c, id) => calls.push({ name: 'deleteDataFile', args: { id } })
	};
	Object.assign(deps.cards, {
		createDocumentCard: async (_c, spec) => {
			calls.push({ name: 'createDocumentCard', args: spec });
			return { id: 880 };
		},
		updateDocumentCard: async (_c, id, spec) => calls.push({ name: 'updateDocumentCard', args: { id, ...spec } })
	});
	return stub;
}

const imageCalls = (calls) => calls.filter((c) => /DataFile|DocumentCard/.test(c.name)).map((c) => [c.name, c.args]);

test('an image card uploads its file once and is a document card on its view; again it uploads nothing; changed bytes are a new revision', async () => {
	const { ws, p, config } = await setup(Buffer.from('png one'));
	const dry = await pushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.equal(dry.actions.find((a) => a.key === 'dash.image.7').action, 'create');
	const first = withFiles();
	const pushed = await pushPlan({ config, slug: 'sales', deps: first.deps, emitter: quiet });
	assert.deepEqual(pushed.actions.filter((a) => a.status === 'failed').map((a) => [a.key, a.error]), []);
	const pageId = (await loadState(ws, 'acme')).objects['page:dash'].id;
	assert.deepEqual(imageCalls(first.calls), [
		['uploadDataFile', { text: 'png one', name: 'banner.png' }],
		['createDocumentCard', { name: 'banner.png', dataFileId: 41, pageId }]
	]);
	const entry = (await loadState(ws, 'acme')).objects['card:dash.image.7'];
	assert.deepEqual([entry.id, entry.extra.kind, entry.extra.dataFileId, entry.extra.md5], [880, 'image', 41, md5('png one')]);
	const layout = first.calls.find((c) => c.name === 'writeLayout').args.layout;
	assert.equal(layout.content[0].cardId, 880);

	const second = withFiles();
	const again = await pushPlan({ config, slug: 'sales', deps: second.deps, emitter: quiet });
	assert.equal(again.actions.find((a) => a.key === 'dash.image.7').action, 'unchanged');
	assert.deepEqual(imageCalls(second.calls), [['getDataFileDetails', { id: 41 }]]);

	fs.writeFileSync(path.join(p.dir, 'images', 'banner.png'), 'png two');
	await ws.writeJson(p.plan, imagePlan(Buffer.from('png two')));
	const third = withFiles();
	const changed = await pushPlan({ config, slug: 'sales', deps: third.deps, emitter: quiet });
	assert.equal(changed.actions.find((a) => a.key === 'dash.image.7').action, 'update');
	assert.deepEqual(imageCalls(third.calls), [
		['getDataFileDetails', { id: 41 }],
		['uploadDataFileVersion', { id: 41, text: 'png two', name: 'banner.png' }]
	]);
	assert.equal((await loadState(ws, 'acme')).objects['card:dash.image.7'].extra.md5, md5('png two'));
});

test('an image file deleted outside t2d is uploaded again and the card pointed at it', async () => {
	const { ws, config } = await setup(Buffer.from('png one'));
	await pushPlan({ config, slug: 'sales', deps: withFiles().deps, emitter: quiet });
	const gone = withFiles({ present: false });
	const summary = await pushPlan({ config, slug: 'sales', deps: gone.deps, emitter: quiet });
	assert.deepEqual(imageCalls(gone.calls), [
		['getDataFileDetails', { id: 41 }],
		['uploadDataFile', { text: 'png one', name: 'banner.png' }],
		['updateDocumentCard', { id: 880, name: 'banner.png', dataFileId: 41 }]
	]);
	assert.match(summary.actions.find((a) => a.key === 'dash.image.7').notes.join(' '), /image file 41 is gone; uploaded again/);
	assert.equal((await loadState(ws, 'acme')).objects['card:dash.image.7'].extra.dataFileId, 41);
});

test('unpush deletes an image card and then its data file, which deleting the card leaves behind', async () => {
	const { ws, config } = await setup(Buffer.from('png one'));
	await pushPlan({ config, slug: 'sales', deps: withFiles().deps, emitter: quiet });
	const dry = await unpushPlan({ config, slug: 'sales', dryRun: true, emitter: quiet });
	assert.match(dry.actions.find((a) => a.key === 'dash.image.7').notes.join(' '), /and its image file 41/);
	mock = mockFetch([
		{ method: 'DELETE', path: /.*/, repeat: true, json: {} },
		{ method: 'GET', path: /.*/, repeat: true, handler: (call) => ({ json: call.path === '/content/v1/cards' ? [{ id: 880, adminAllPages: [], adminAllAppPages: [], adminAllReportPages: [] }] : [] }) }
	]);
	const summary = await unpushPlan({ config, slug: 'sales', deps: { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) }, emitter: quiet });
	assert.equal(summary.ok, true);
	const deletes = mock.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
	assert.deepEqual(deletes.slice(0, 2), ['/content/v1/cards/880', '/data/v1/data-files/41']);
	assert.equal((await loadState(ws, 'acme')).objects['card:dash.image.7'], undefined);
});

const gif = (width, tail) => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([width & 0xff, width >> 8, 200, 0]), Buffer.from(tail)]);

/** withFiles plus a view whose layout holds a document card someone made in Domo (762, data file 3023). */
function withUserCard({ userBytes, userCardLive = true } = {}) {
	const stub = withFiles();
	const { deps, calls } = stub;
	deps.pages.getLayoutByPage = async (_c, pageId) => {
		calls.push({ name: 'getLayoutByPage', args: { pageId } });
		return { content: [{ contentKey: 1, type: 'CARD', cardId: 880 }, { contentKey: 2, type: 'CARD', cardId: 762 }] };
	};
	deps.cards.getCardSummaries = async (_c, ids) => {
		calls.push({ name: 'getCardSummaries', args: { ids } });
		return ids.filter((id) => String(id) === '762' && userCardLive).map(() => ({ id: 762, type: 'document', title: 'Activity Detail.png', metadata: { documentId: '3023:undefined' } }));
	};
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	const details = deps.files.getDataFileDetails;
	deps.files.getDataFileDetails = async (c, id) => (String(id) === '3023' ? { currentRevision: { md5Hash: 'F1B2', contentType: 'image/gif' } } : details(c, id));
	deps.files.downloadDataFile = async (_c, id) => {
		calls.push({ name: 'downloadDataFile', args: { id } });
		return userBytes;
	};
	return stub;
}

test('a document card made in Domo on the view with the same image replaces t2d\'s own; t2d never changes or deletes it', async () => {
	const own = gif(320, 'own bytes');
	const { ws, config } = await setup(own, { width: 320, height: 200 });
	await pushPlan({ config, slug: 'sales', deps: withFiles().deps, emitter: quiet });

	const adopt = withUserCard({ userBytes: gif(320, 're-encoded') });
	const summary = await pushPlan({ config, slug: 'sales', deps: adopt.deps, emitter: quiet });
	const action = summary.actions.find((a) => a.key === 'dash.image.7');
	assert.deepEqual([action.action, action.id], ['reuse', 762]);
	assert.match(action.notes.join(' '), /deleted the image card 880 and file 41 an earlier push created uses the image card 762 "Activity Detail.png" made in Domo/);
	assert.deepEqual(
		adopt.calls.filter((c) => ['deleteCard', 'deleteDataFile', 'uploadDataFile', 'createDocumentCard', 'updateDocumentCard'].includes(c.name)).map((c) => [c.name, c.args.id]),
		[['deleteCard', 880], ['deleteDataFile', 41]]
	);
	assert.deepEqual(adopt.calls.find((c) => c.name === 'getCardSummaries').args.ids, ['762'], 'only cards t2d did not create are checked');
	const entry = (await loadState(ws, 'acme')).objects['card:dash.image.7'];
	assert.deepEqual([entry.id, entry.extra.adopted, entry.extra.dataFileId], [762, true, undefined]);
	assert.equal(adopt.calls.find((c) => c.name === 'writeLayout').args.layout.content[0].cardId, 762);

	const again = withUserCard({ userBytes: gif(320, 're-encoded') });
	const unchanged = await pushPlan({ config, slug: 'sales', deps: again.deps, emitter: quiet });
	assert.equal(unchanged.actions.find((a) => a.key === 'dash.image.7').action, 'unchanged');
	assert.deepEqual(again.calls.filter((c) => /DataFile|DocumentCard|deleteCard/.test(c.name)), []);

	mock = mockFetch([{ method: /.*/, path: /.*/, repeat: true, json: [] }]);
	const removed = await unpushPlan({ config, slug: 'sales', deps: { createDomoClient: (cfg, opts) => createDomoClient(cfg, { ...opts, delayMs: 0 }) }, emitter: quiet });
	assert.equal(removed.actions.find((a) => a.key === 'dash.image.7').action, 'keep');
	assert.deepEqual(mock.calls.filter((c) => c.method === 'DELETE' && /762|3023/.test(c.path)), []);
	assert.equal((await loadState(ws, 'acme')).objects['card:dash.image.7'], undefined);
});

test('a document card made in Domo with another image is not used; once a used one is gone t2d makes its own', async () => {
	const own = gif(320, 'own bytes');
	const { ws, config } = await setup(own, { width: 320, height: 200 });
	const other = withUserCard({ userBytes: gif(640, 'other image') });
	await pushPlan({ config, slug: 'sales', deps: other.deps, emitter: quiet });
	assert.deepEqual(imageCalls(other.calls).map(([name]) => name), ['downloadDataFile', 'uploadDataFile', 'createDocumentCard']);
	assert.equal((await loadState(ws, 'acme')).objects['card:dash.image.7'].id, 880);

	const state = await loadState(ws, 'acme');
	state.objects['card:dash.image.7'] = { id: 762, extra: { kind: 'image', adopted: true } };
	await saveState(ws, state);
	const gone = withUserCard({ userBytes: gif(640, 'other image'), userCardLive: false });
	const summary = await pushPlan({ config, slug: 'sales', deps: gone.deps, emitter: quiet });
	const action = summary.actions.find((a) => a.key === 'dash.image.7');
	assert.deepEqual([action.action, action.id], ['create', 880]);
	assert.match(action.notes.join(' '), /image card 762 made in Domo is gone; t2d makes its own/);
});

test('cards t2d did not create that Domo appends below a written layout are a warning', async () => {
	const { config } = await setup(Buffer.from('png one'));
	const stub = withFiles();
	stub.deps.pages.writeLayout = async () => ({ layoutId: 900, appendixCardIds: ['880', '1000000001'] });
	const summary = await pushPlan({ config, slug: 'sales', deps: stub.deps, emitter: quiet });
	assert.deepEqual(summary.issues.filter((i) => i.code === 'push.layout-appendix').map((i) => i.message), [
		'Page "Overview" shows 1 card(s) t2d did not create in an Appendix below its layout (1000000001): they are on the page but not in the Tableau layout'
	]);
});
