import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { ref } from '../../src/util/refs.js';
import { headerParagraphs, textZoneCard } from '../../src/convert/header.js';
import { appItemsPlan, stubAppDomo } from './app-helpers.js';
import { tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const roots = [];
let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
	roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});

const BYTES = Buffer.from('banner bytes');
const SECTION = 'dash.section-image.7';
const TITLE = 'dash.header.9';

function headerPlan({ image = true, title = false, card } = {}) {
	const plan = appItemsPlan();
	const dash = plan.pages.find((pg) => pg.key === 'dash');
	const tabs = dash.layout.content.find((i) => i.type === 'TABS');
	if (image) {
		Object.assign(tabs, { collapsible: false, hideTitle: true, sectionImage: SECTION });
		plan.cards.push({ key: SECTION, kind: 'image', section: true, title: 'banner.png', worksheet: '', datasetKey: '', chartType: 'document', body: { image: { file: 'images/banner.png', name: 'banner.png', bytes: BYTES.length, md5: md5(BYTES) } }, pageKeys: ['dash'], status: 'ok' });
	}
	if (title || card) {
		const key = card?.key ?? TITLE;
		plan.cards.push(card ?? { key: TITLE, kind: 'notebook', header: true, title: 'Planning Dashboard', worksheet: '', datasetKey: '', chartType: 'notebook', body: { notebook: { title: 'Planning Dashboard', paragraphs: [[{ text: 'Planning Dashboard', bold: true, size: 'header' }]], align: 'center', valign: 'middle' } }, pageKeys: ['dash'], status: 'ok' });
		const header = dash.layout.content.find((i) => i.type === 'HEADER');
		Object.assign(header, { type: 'CARD', cardId: ref('card', key), hideTitle: true, hideWrench: true, editInAppViewer: false });
		delete header.text;
		for (const t of [dash.layout.standard.template, dash.layout.compact.template].flatMap(function all(ts) { return ts.flatMap((x) => [x, ...all(x.children ?? [])]); })) if (t.contentKey === header.contentKey) t.type = 'CARD';
	}
	return plan;
}

async function setup(plan) {
	const root = tempDir();
	roots.push(root);
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	fs.mkdirSync(path.join(p.dir, 'images'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'images', 'banner.png'), BYTES);
	await ws.writeJson(p.plan, plan);
	return { ws, p, config: testConfig(root) };
}

/** stubAppDomo plus data files, and a view layout from `liveLayout(pageId)` for the checks of what was made in Domo. */
function withFiles({ liveLayout = () => ({ content: [] }), userFiles = {}, liveCards = [], files = new Map() } = {}) {
	const stub = stubAppDomo();
	const { deps, calls } = stub;
	let next = 500 + files.size;
	deps.files = {
		uploadLayoutBackground: async (_c, pageId, bytes, name) => {
			calls.push({ name: 'uploadLayoutBackground', args: { pageId, text: bytes.toString(), name } });
			const id = ++next;
			files.set(String(id), md5(bytes));
			return { id };
		},
		uploadDataFile: async () => {
			throw new Error('a section image is uploaded as the view background');
		},
		getDataFileDetails: async (_c, id) => {
			const hash = files.get(String(id)) ?? userFiles[id];
			return hash ? { currentRevision: { md5Hash: hash, contentType: 'image/png' } } : undefined;
		},
		downloadDataFile: async () => Buffer.from('other'),
		deleteDataFile: async (_c, id) => {
			calls.push({ name: 'deleteDataFile', args: { id } });
			files.delete(String(id));
		}
	};
	deps.notebooks = {
		createNotebook: async (_c, spec) => {
			calls.push({ name: 'createNotebook', args: spec });
			return { id: ++next };
		},
		updateNotebook: async (_c, id, body) => calls.push({ name: 'updateNotebook', args: { id, body } })
	};
	deps.cards.deleteCard = async (_c, id) => calls.push({ name: 'deleteCard', args: { id } });
	deps.pages.getLayoutByPage = async (_c, pageId) => liveLayout(pageId);
	deps.cards.getCardSummaries = async (_c, ids) => liveCards.filter((card) => ids.map(String).includes(String(card.id)));
	return { ...stub, files };
}

const sectionOf = (calls) => calls.filter((c) => c.name === 'writeLayout').map((c) => c.args.layout.content.find((i) => i.type === 'TABS')).findLast(Boolean);

test('a header section image is uploaded as the view background, listed in the app theme and the section style; a second push uploads and writes nothing', async () => {
	const { ws, config } = await setup(headerPlan());
	const first = withFiles();
	const summary = await pushPlan({ config, slug: 'sales', deps: first.deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const state = await loadState(ws, 'acme');
	const viewId = state.objects['page:dash'].id;
	assert.deepEqual(first.calls.filter((c) => c.name === 'uploadLayoutBackground').map((c) => c.args), [{ pageId: viewId, text: 'banner bytes', name: 'banner.png' }]);
	const entry = state.objects[`card:${SECTION}`];
	assert.deepEqual([entry.id, entry.extra.section, entry.extra.dataFileId, entry.extra.md5], [501, true, 501, md5(BYTES)]);
	const app = first.server.apps.get(String(state.objects['app:root'].id));
	assert.deepEqual(app.theme.images, [{ id: 'i1', dataFileId: 501 }]);
	const tabs = sectionOf(first.calls);
	assert.equal('sectionImage' in tabs, false);
	assert.deepEqual(tabs.style, { sourceId: null, textColor: null, background: { value: 'i1', type: 'IMAGE_REFERENCE' }, isDynamic: null, density: null, margin: null, titleFontColor: null, titleFontStyle: null });

	const second = withFiles({ files: first.files });
	second.server.apps.set(String(state.objects['app:root'].id), app);
	const again = await pushPlan({ config, slug: 'sales', deps: second.deps, emitter: quiet });
	assert.deepEqual(again.actions.filter((a) => a.action !== 'unchanged').map((a) => [a.kind, a.key, a.action]), []);
	assert.deepEqual(second.calls.filter((c) => ['uploadLayoutBackground', 'updateApp', 'writeLayout'].includes(c.name)), []);
});

test('a matching background image set in Domo on the view is used instead of t2d\'s own, which is deleted; the image left out of the plan is deleted, a used one never', async () => {
	const { ws, p, config } = await setup(headerPlan());
	const first = withFiles();
	await pushPlan({ config, slug: 'sales', deps: first.deps, emitter: quiet });
	const state = await loadState(ws, 'acme');
	const appId = String(state.objects['app:root'].id);
	const app = first.server.apps.get(appId);
	app.theme.images.push({ id: 'i2', dataFileId: 3054 });
	const live = () => ({ content: [{ contentKey: 31, type: 'TABS', tabType: 'SECTION', style: { sourceId: null, background: { value: 'i2', type: 'IMAGE_REFERENCE' } } }] });
	const adopt = withFiles({ liveLayout: live, userFiles: { 3054: md5(BYTES) } });
	adopt.server.apps.set(appId, structuredClone(app));
	const summary = await pushPlan({ config, slug: 'sales', deps: adopt.deps, emitter: quiet });
	const action = summary.actions.find((a) => a.key === SECTION);
	assert.deepEqual([action.action, action.id], ['reuse', 3054]);
	assert.deepEqual(adopt.calls.filter((c) => c.name === 'deleteDataFile').map((c) => c.args.id), [501]);
	assert.deepEqual(sectionOf(adopt.calls).style.background, { value: 'i2', type: 'IMAGE_REFERENCE' });
	assert.deepEqual((await loadState(ws, 'acme')).objects[`card:${SECTION}`].extra.adopted, true);

	await ws.writeJson(p.plan, headerPlan({ image: false }));
	const retire = withFiles({ userFiles: { 3054: md5(BYTES) } });
	retire.server.apps.set(appId, structuredClone(app));
	const retired = await pushPlan({ config, slug: 'sales', deps: retire.deps, emitter: quiet });
	assert.equal(retired.actions.find((a) => a.key === SECTION).action, 'skip');
	assert.deepEqual(retire.calls.filter((c) => c.name === 'deleteDataFile'), [], 'the file set in Domo is kept');
	assert.equal((await loadState(ws, 'acme')).objects[`card:${SECTION}`], undefined);
});

test('a header text card made in Domo on the view with the same text is used instead of creating one, and never updated', async () => {
	const { ws, config } = await setup(headerPlan({ image: false, title: true }));
	const first = withFiles();
	const made = await pushPlan({ config, slug: 'sales', deps: first.deps, emitter: quiet });
	assert.equal(made.ok, true, JSON.stringify(made.actions.filter((a) => a.status !== 'ok')));
	const own = (await loadState(ws, 'acme')).objects[`card:${TITLE}`].id;
	const theirs = { id: 1586, type: 'Text', title: 'Notebook', metadata: { tagMarkup: JSON.stringify({ text: 'Planning  Dashboard', tags: [] }) } };
	const adopt = withFiles({ liveLayout: () => ({ content: [{ type: 'CARD', cardId: 1586 }] }), liveCards: [theirs] });
	const summary = await pushPlan({ config, slug: 'sales', deps: adopt.deps, emitter: quiet });
	const action = summary.actions.find((a) => a.key === TITLE);
	assert.deepEqual([action.action, action.id], ['reuse', 1586]);
	assert.deepEqual(adopt.calls.filter((c) => c.name === 'deleteCard').map((c) => c.args.id), [own]);
	assert.equal(adopt.calls.some((c) => /Notebook/.test(c.name)), false);
	const again = withFiles({ liveCards: [theirs] });
	const unchanged = await pushPlan({ config, slug: 'sales', deps: again.deps, emitter: quiet });
	assert.equal(unchanged.actions.find((a) => a.key === TITLE).action, 'unchanged');
	assert.equal(again.calls.some((c) => /Notebook|deleteCard/.test(c.name)), false);
});

test('a footnote text card (key <page>.text.<zone>) is adopted like a header one: a matching text card made in Domo is used, none is created', async () => {
	const zone = { id: '71', kind: 'text', text: '* Beginning in 2023\n** Revenue excludes partners', runs: [{ text: '* Beginning in 2023\n** Revenue excludes partners', color: '#ff0000' }], rect: { x: 0.48, y: 0.54, w: 0.51, h: 0.05 } };
	const footnote = textZoneCard('dash', zone, headerParagraphs(zone, { name: 'Dash' }, zone.text));
	assert.equal(footnote.key, 'dash.text.71');
	const { ws, config } = await setup(headerPlan({ image: false, card: footnote }));
	const theirs = { id: 1480, type: 'Text', title: 'Notebook', metadata: { tagMarkup: JSON.stringify({ text: '* Beginning in 2023\n** Revenue excludes partners', tags: [] }) } };
	const adopt = withFiles({ liveLayout: () => ({ content: [{ type: 'CARD', cardId: 1480 }] }), liveCards: [theirs] });
	const summary = await pushPlan({ config, slug: 'sales', deps: adopt.deps, emitter: quiet });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	assert.deepEqual([summary.actions.find((a) => a.key === footnote.key).action, (await loadState(ws, 'acme')).objects[`card:${footnote.key}`].id], ['reuse', 1480]);
	assert.equal(adopt.calls.some((c) => c.name === 'createNotebook'), false);
	const written = adopt.calls.filter((c) => c.name === 'writeLayout').flatMap((c) => c.args.layout.content).find((i) => String(i.cardId) === '1480');
	assert.equal(written?.editInAppViewer, false, 'viewers cannot edit the text in app view');
});

test('a text card made in Domo that an earlier push adopted under a .header. key is adopted again when the zone becomes a .text. card', async () => {
	const { ws, p, config } = await setup(headerPlan({ image: false, title: true }));
	const theirs = { id: 1586, type: 'Text', title: 'Notebook', metadata: { tagMarkup: JSON.stringify({ text: 'Planning Dashboard', tags: [] }) } };
	const live = () => withFiles({ liveLayout: () => ({ content: [{ type: 'CARD', cardId: 1586 }] }), liveCards: [theirs] });
	const first = live();
	assert.equal((await pushPlan({ config, slug: 'sales', deps: first.deps, emitter: quiet })).actions.find((a) => a.key === TITLE).id, 1586);
	const renamed = headerPlan({ image: false, card: { ...headerPlan({ image: false, title: true }).cards.find((c) => c.key === TITLE), key: 'dash.text.9' } });
	await ws.writeJson(p.plan, renamed);
	const again = live();
	const summary = await pushPlan({ config, slug: 'sales', deps: again.deps, emitter: quiet });
	assert.deepEqual([summary.actions.find((a) => a.key === 'dash.text.9').action, summary.actions.find((a) => a.key === 'dash.text.9').id], ['reuse', 1586]);
	assert.equal(again.calls.some((c) => c.name === 'createNotebook' || (c.name === 'deleteCard' && c.args.id === 1586)), false);
	assert.equal((await loadState(ws, 'acme')).objects[`card:${TITLE}`], undefined, 'the old key is forgotten');
});
