import { request as httpRequest, sleep } from '../util/http.js';
import { createEmitter } from '../util/events.js';

/**
 * @typedef {Object} DomoRequestOptions
 * @property {any} [json]
 * @property {BodyInit} [body]
 * @property {Record<string,string>} [headers]
 * @property {Record<string, string|number|boolean|undefined|null>} [query]
 * @property {'json'|'text'|'response'|'buffer'} [responseType]
 * @property {number[]} [retryOn]
 * @property {number} [retries]
 * @property {boolean} [idempotent]
 * @property {number} [timeoutMs]
 *
 * @typedef {Object} DomoClient
 * @property {string} instance
 * @property {string} baseUrl
 * @property {import('../util/events.js').Emitter} emitter
 * @property {(method: string, path: string, opts?: DomoRequestOptions) => Promise<any>} request
 * @property {(path: string, opts?: DomoRequestOptions) => Promise<any>} get
 * @property {(path: string, json?: any, opts?: DomoRequestOptions) => Promise<any>} post
 * @property {(path: string, json?: any, opts?: DomoRequestOptions) => Promise<any>} put
 * @property {(path: string, opts?: DomoRequestOptions) => Promise<any>} del
 * @property {(path: string, query?: DomoRequestOptions['query']) => string} url
 */

/**
 * Domo product API client (developer token auth). Paths are relative to `/api`.
 *
 * @param {{ instance: string, accessToken: string }} domo
 * @param {{ emitter?: import('../util/events.js').Emitter, delayMs?: number, timeoutMs?: number }} [opts]
 *   `delayMs` is the minimum spacing between requests (politeness to Domo rate limits).
 * @returns {DomoClient}
 */
export function createDomoClient({ instance, accessToken } = {}, { emitter, delayMs = 100, timeoutMs = 120000 } = {}) {
	if (!instance) throw new Error('createDomoClient: instance is required');
	if (!accessToken) throw new Error('createDomoClient: accessToken is required');

	const baseUrl = `https://${instanceHost(instance)}/api`;
	const log = emitter || createEmitter(undefined, 'domo');
	let nextSlot = 0;

	const url = (path, query) => {
		const clean = path.startsWith('/') ? path : `/${path}`;
		return `${baseUrl}${clean}${queryString(query)}`;
	};

	async function request(method, path, opts = {}) {
		const { json, body, headers = {}, query, responseType = 'json', retryOn, retries, idempotent, timeoutMs: perCallTimeout } = opts;
		if (delayMs > 0) {
			const now = Date.now();
			const wait = nextSlot - now;
			nextSlot = Math.max(now, nextSlot) + delayMs;
			if (wait > 0) await sleep(wait);
		}
		return httpRequest(url(path, query), {
			method,
			headers: {
				'X-DOMO-Developer-Token': accessToken,
				Accept: 'application/json',
				'Accept-Language': 'en-US',
				...headers
			},
			json,
			body,
			responseType,
			timeoutMs: perCallTimeout ?? timeoutMs,
			...(retryOn ? { retryOn } : {}),
			...(retries !== undefined ? { retries } : {}),
			...(idempotent !== undefined ? { idempotent } : {})
		});
	}

	return {
		instance,
		baseUrl,
		emitter: log,
		url,
		request,
		get: (path, opts) => request('GET', path, opts),
		post: (path, json, opts = {}) => request('POST', path, { ...opts, json }),
		put: (path, json, opts = {}) => request('PUT', path, { ...opts, json }),
		del: (path, opts) => request('DELETE', path, opts)
	};
}

/** Accepts 'acme', 'acme.domo.com' or 'https://acme.domo.com/'. */
export function instanceHost(instance) {
	const host = String(instance)
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/.*$/, '');
	return host.includes('.') ? host : `${host}.domo.com`;
}

function queryString(query) {
	if (!query) return '';
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		params.append(key, String(value));
	}
	const text = params.toString();
	return text ? `?${text}` : '';
}

/** True when `err` is an HTTP error with one of the given statuses. */
export function isStatus(err, ...statuses) {
	return Boolean(err && typeof err.status === 'number' && statuses.includes(err.status));
}
