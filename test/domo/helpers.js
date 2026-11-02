import { createDomoClient } from '../../src/domo/client.js';
import { createEmitter } from '../../src/util/events.js';

export const BASE = 'https://acme.domo.com/api';

/**
 * Install a fetch stub. `routes` is an ordered list of
 * { method, path (string or RegExp, relative to /api), status?, json?, text?, handler? }.
 * Each route is consumed once unless `repeat: true`.
 */
export function mockFetch(routes) {
	const calls = [];
	const original = globalThis.fetch;
	const pending = routes.map((r) => ({ ...r }));
	globalThis.fetch = async (url, init = {}) => {
		const method = init.method || 'GET';
		const u = new URL(url);
		const rel = u.pathname.replace(/^\/api/, '');
		const call = { method, url, path: rel, query: Object.fromEntries(u.searchParams), headers: init.headers || {}, body: init.body };
		calls.push(call);
		const index = pending.findIndex((r) => r.method === method && (r.path instanceof RegExp ? r.path.test(rel) : r.path === rel));
		if (index === -1) throw new Error(`Unexpected request ${method} ${url}`);
		const route = pending[index];
		if (!route.repeat) pending.splice(index, 1);
		if (route.handler) {
			const out = await route.handler(call);
			if (out instanceof Response) return out;
			return respond(out?.status ?? 200, out?.json, out?.text);
		}
		return respond(route.status ?? 200, route.json, route.text);
	};
	return {
		calls,
		pending,
		restore() {
			globalThis.fetch = original;
		}
	};
}

function respond(status, json, text) {
	const body = text !== undefined ? text : json === undefined ? '' : JSON.stringify(json);
	return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

export function jsonBody(call) {
	return call.body === undefined || call.body === null ? undefined : JSON.parse(call.body);
}

export function testClient() {
	const events = [];
	const emitter = createEmitter((e) => events.push(e), 'test');
	const client = createDomoClient({ instance: 'acme', accessToken: 'tok' }, { emitter, delayMs: 0 });
	return { client, events };
}
