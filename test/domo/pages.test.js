import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { buildLayoutBody, createFilterView, createPage, deleteFilterView, getPage, deletePage, ensureLayout, listFilterViews, sameFilters, setDefaultFilterView, updateFilterView, writeLayout } from '../../src/domo/pages.js';

test('buildLayoutBody sends the plan\'s isDynamic (an app view\'s theme setting) and template margins, else keeps the server\'s', () => {
	const existing = { layoutId: 9, pageUrn: '42', isDynamic: false, compact: { frameMargin: 2 } };
	const plan = { content: [], standard: { template: [], frameMargin: 4, framePadding: 8 }, compact: { template: [], frameMargin: 4, framePadding: 8 } };
	const body = buildLayoutBody(existing, 42, { ...plan, isDynamic: true });
	assert.deepEqual([body.isDynamic, body.standard.frameMargin, body.compact.frameMargin, body.compact.framePadding], [true, 4, 4, 8]);
	const kept = buildLayoutBody(existing, 42, { content: [], standard: { template: [] }, compact: { template: [] } });
	assert.deepEqual([kept.isDynamic, kept.compact.frameMargin], [false, 2]);
});

let mock;
afterEach(() => mock?.restore());

const layoutPlan = {
	content: [{ contentKey: 1, type: 'CARD', cardId: 111 }],
	standard: { width: 60, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 30, height: 30 }] },
	compact: { width: 12, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 12 }] }
};

test('createPage, getPage, deletePage', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/content/v1/pages', json: { pageId: 42 } },
		{ method: 'POST', path: '/content/v1/pages', json: { pageId: 43 } },
		{ method: 'GET', path: '/content/v1/pages/42', json: { id: 42 } },
		{ method: 'DELETE', path: '/content/v1/pages/42', text: '' }
	]);
	assert.equal(await createPage(client, { title: 'Root' }), 42);
	assert.deepEqual(jsonBody(mock.calls[0]), { title: 'Root' });
	assert.equal(await createPage(client, { title: 'Sub', parentPageId: '42' }), 43);
	assert.deepEqual(jsonBody(mock.calls[1]), { title: 'Sub', parentPageId: 42 });
	await getPage(client, 42);
	await deletePage(client, 42);
	assert.equal(mock.calls[3].method, 'DELETE');
});

test('ensureLayout returns the existing layout', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'GET', path: '/content/v4/pages/42/layouts', json: { layoutId: 9, pageUrn: '42' } }]);
	assert.equal((await ensureLayout(client, 42)).layoutId, 9);
	assert.equal(mock.calls.length, 1);
});

test('ensureLayout creates a layout on 404', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/42/layouts', status: 404, text: 'none' },
		{ method: 'POST', path: '/content/v4/pages/layouts', json: { layoutId: 10, pageUrn: '42' } }
	]);
	assert.equal((await ensureLayout(client, 42)).layoutId, 10);
	assert.deepEqual(jsonBody(mock.calls[1]), { pageUrn: '42' });
});

test('writeLayout locks, PUTs the full body, unlocks, then waits for the content', async () => {
	const { client } = testClient();
	let reads = 0;
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/42/layouts', json: { layoutId: 9, pageUrn: '42', background: { type: 'COLOR' }, standard: { frameMargin: 4, framePadding: 8, template: [] }, content: [] } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9/writelock', json: { layoutId: 9 } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9', json: {} },
		{ method: 'DELETE', path: '/content/v4/pages/layouts/9/writelock', json: true },
		{
			method: 'GET',
			path: '/content/v4/pages/layouts/9',
			repeat: true,
			handler: () => ({ json: ++reads < 2 ? { layoutId: 9, content: [] } : { layoutId: 9, content: [{ contentKey: 1, type: 'CARD', cardId: 111 }] } })
		}
	]);
	const result = await writeLayout(client, 42, layoutPlan, { pollIntervalMs: 1 });
	assert.equal(result.content[0].cardId, 111);
	assert.deepEqual(
		mock.calls.map((c) => `${c.method} ${c.path}`),
		[
			'GET /content/v4/pages/42/layouts',
			'PUT /content/v4/pages/layouts/9/writelock',
			'PUT /content/v4/pages/layouts/9',
			'DELETE /content/v4/pages/layouts/9/writelock',
			'GET /content/v4/pages/layouts/9',
			'GET /content/v4/pages/layouts/9'
		]
	);
	const sent = jsonBody(mock.calls[2]);
	assert.equal(sent.layoutId, 9);
	assert.equal(sent.pageUrn, '42');
	assert.equal(sent.enabled, true);
	assert.equal(sent.printFriendly, false);
	assert.equal(sent.isDynamic, false);
	assert.equal(sent.hasPageBreaks, false);
	assert.deepEqual(sent.background, { type: 'COLOR' });
	assert.deepEqual(sent.content, layoutPlan.content);
	assert.deepEqual(sent.standard, { type: 'STANDARD', aspectRatio: 1.67, width: 60, frameMargin: 4, framePadding: 8, template: layoutPlan.standard.template });
	assert.deepEqual(sent.compact, { type: 'COMPACT', aspectRatio: 1.0, width: 12, template: layoutPlan.compact.template });
	assert.equal(mock.calls[1].body, undefined);
});

test('writeLayout accepts the appendix Domo adds for a card on the page that the layout leaves out, and warns', async () => {
	const { client, events } = testClient();
	const withAppendix = {
		layoutId: 9,
		content: [
			{ contentKey: 1, type: 'CARD', cardId: 111 },
			{ contentKey: 36, type: 'HEADER', text: 'Appendix' },
			{ contentKey: 37, type: 'CARD', cardId: 222 }
		],
		standard: {
			template: [
				{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 30, height: 30 },
				{ contentKey: 34, type: 'PAGE_BREAK', x: 0, y: 30, width: 60, height: 0 },
				{ contentKey: 35, type: 'SEPARATOR', x: 0, y: 30, width: 60, height: 3 },
				{ contentKey: 36, type: 'HEADER', x: 0, y: 33, width: 60, height: 5 },
				{ contentKey: 37, type: 'CARD', x: 0, y: 38, width: 15, height: 30 }
			]
		}
	};
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/42/layouts', json: { layoutId: 9, pageUrn: '42', content: [] } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9/writelock', json: { layoutId: 9 } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9', json: {} },
		{ method: 'DELETE', path: '/content/v4/pages/layouts/9/writelock', json: true },
		{ method: 'GET', path: '/content/v4/pages/layouts/9', repeat: true, json: withAppendix }
	]);
	const result = await writeLayout(client, 42, layoutPlan, { pollIntervalMs: 1, timeoutMs: 50 });
	assert.equal(result.content.length, 3);
	assert.deepEqual(result.appendixCardIds, ['222']);
	assert.ok(events.some((e) => e.type === 'warn' && /keeps 1 card\(s\).*222.*appendix/.test(e.message)));
});

test('writeLayout still waits when a card the plan places is outside the appendix but missing', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/42/layouts', json: { layoutId: 9, pageUrn: '42', content: [] } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9/writelock', json: { layoutId: 9 } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9', json: {} },
		{ method: 'DELETE', path: '/content/v4/pages/layouts/9/writelock', json: true },
		{ method: 'GET', path: '/content/v4/pages/layouts/9', repeat: true, json: { layoutId: 9, content: [{ contentKey: 2, type: 'CARD', cardId: 222 }], standard: { template: [{ contentKey: 2, type: 'CARD', x: 0, y: 0 }] } } }
	]);
	await assert.rejects(writeLayout(client, 42, layoutPlan, { pollIntervalMs: 1, timeoutMs: 30 }), /reflect the update/);
});

test('writeLayout releases the lock when the update fails', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'GET', path: '/content/v4/pages/42/layouts', json: { layoutId: 9, pageUrn: '42' } },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9/writelock', json: {} },
		{ method: 'PUT', path: '/content/v4/pages/layouts/9', status: 400, text: 'bad layout' },
		{ method: 'DELETE', path: '/content/v4/pages/layouts/9/writelock', json: true }
	]);
	await assert.rejects(writeLayout(client, 42, layoutPlan, { pollIntervalMs: 1 }), /HTTP 400/);
	assert.deepEqual(mock.calls.map((c) => c.method).slice(-2), ['PUT', 'DELETE']);
	assert.equal(mock.calls.at(-1).path, '/content/v4/pages/layouts/9/writelock');
});

test('filter views: create a page-scoped Default, update it in place, make it the page default, delete it', async () => {
	const { client } = testClient();
	const filters = [{ column: 'FY', dataType: 'numeric', operand: 'IN', values: ['2026'], filterType: 'LEGACY', dataSourceId: 'ds', affectedCardUrns: [] }];
	mock = mockFetch([
		{ method: 'GET', path: '/content/v3/pages/42/analyzer/named', json: [{ analyzerId: 7, name: 'Default', scope: 'PAGE', isDefault: true }] },
		{ method: 'POST', path: '/content/v3/pages/42/analyzer', json: { analyzerId: 8 } },
		{ method: 'PUT', path: '/content/v3/pages/42/analyzer', json: {} },
		{ method: 'PUT', path: '/content/v3/pages/42/analyzer/8/global', text: '' },
		{ method: 'DELETE', path: '/content/v3/pages/analyzer/8', text: '' }
	]);
	assert.equal((await listFilterViews(client, 42))[0].analyzerId, 7);
	assert.equal(await createFilterView(client, 42, { name: 'Default', filters }), 8);
	assert.deepEqual(jsonBody(mock.calls[1]), { name: 'Default', type: 'NAMED', scope: 'PAGE', filters, segmentIds: [], dateTimeRange: { overrideDateRange: false }, functionOverrides: {} });
	await updateFilterView(client, 42, 8, { name: 'Default', filters });
	assert.equal(jsonBody(mock.calls[2]).analyzerId, 8);
	assert.equal(mock.calls[2].query.removePersonalized, 'false', 'the pushing user\'s own filter state stays');
	await setDefaultFilterView(client, 42, 8);
	await deleteFilterView(client, 8);
	assert.equal(mock.pending.length, 0);
});

test('sameFilters compares columns, operands, data types and values in any order, not datasets or source cards', () => {
	const ours = [{ column: 'FYQ', operand: 'IN', dataType: 'string', values: ['2026 Q4'], dataSourceId: 'ds', sourceCardURN: '1', affectedCardUrns: [] }, { column: 'FY', operand: 'IN', dataType: 'numeric', values: ['2026'] }];
	const theirs = [{ column: 'FY', operand: 'IN', dataType: 'NUMERIC', values: ['2026'], dataSourceId: '' }, { column: 'fyq', operand: 'in', dataType: 'string', values: ['2026 Q4'], sourceCardURN: '2' }];
	assert.equal(sameFilters(ours, theirs), true);
	assert.equal(sameFilters(ours, theirs.slice(0, 1)), false);
	assert.equal(sameFilters(ours, [theirs[0], { ...theirs[1], values: ['2026 Q3'] }]), false);
	assert.equal(sameFilters([...ours, { column: 'X', operand: 'IN', values: [] }], theirs), true, 'a filter with no values filters nothing');
});

test('buildLayoutBody sends the view style when the plan has one, else keeps the server\'s', () => {
	const existing = { layoutId: 9, pageUrn: '42', style: { sourceId: 'p0', density: { standard: 6 } } };
	const plan = { content: [], standard: { template: [] }, compact: { template: [] } };
	assert.deepEqual(buildLayoutBody(existing, 42, plan).style, existing.style);
	const style = { sourceId: 'p0', density: { standard: 0 }, margin: { standard: { top: 0, bottom: 0, left: 0, right: 0 } } };
	assert.deepEqual(buildLayoutBody(existing, 42, { ...plan, style }).style, style);
});
