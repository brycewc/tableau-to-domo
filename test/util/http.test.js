import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { request } from '../../src/util/http.js';

let realFetch;
let calls;
beforeEach(() => {
	realFetch = globalThis.fetch;
	calls = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const respond = (status, body = '', headers = {}) => new Response(body, { status, headers });

test('POST is not retried after a 500 or a timeout', async () => {
	globalThis.fetch = async (url, init) => {
		calls.push(init.method);
		return respond(500, 'boom');
	};
	await assert.rejects(request('https://x.test/create', { method: 'POST', json: {}, retries: 3 }), /HTTP 500/);
	assert.equal(calls.length, 1);

	calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(init.method);
		throw new DOMException('timed out', 'TimeoutError');
	};
	await assert.rejects(request('https://x.test/create', { method: 'POST', json: {}, retries: 3 }));
	assert.equal(calls.length, 1);
});

test('POST is retried on 429 and explicit retryOn statuses, GET on 500', async () => {
	let n = 0;
	globalThis.fetch = async () => (++n === 1 ? respond(429, '', { 'retry-after': '0' }) : respond(200, '{"ok":true}'));
	assert.deepEqual(await request('https://x.test/create', { method: 'POST', json: {}, retries: 2 }), { ok: true });
	n = 0;
	globalThis.fetch = async () => (++n === 1 ? respond(500) : respond(200, '1'));
	assert.equal(await request('https://x.test/read', { retries: 2 }), 1);
	assert.equal(n, 2);
});

test('credential headers are dropped on a cross-origin redirect and kept on same origin', async () => {
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers, redirect: init.redirect });
		if (String(url) === 'https://a.test/start') return respond(302, '', { location: '/same' });
		if (String(url) === 'https://a.test/same') return respond(302, '', { location: 'https://b.test/other' });
		return respond(200, '"done"');
	};
	const headers = { 'X-Tableau-Auth': 'SESSION', 'X-DOMO-Developer-Token': 'DEV', Authorization: 'Bearer z', Accept: 'application/json' };
	assert.equal(await request('https://a.test/start', { headers }), 'done');
	assert.equal(calls.length, 3);
	assert.ok(calls.every((c) => c.redirect === 'manual'));
	assert.equal(calls[1].headers['X-Tableau-Auth'], 'SESSION');
	assert.deepEqual(calls[2].headers, { Accept: 'application/json' });
});
