/**
 * fetch wrapper shared by the Tableau and Domo clients: timeouts, retry with
 * backoff on 429/5xx/network errors, and typed errors.
 */

export class HttpError extends Error {
	/**
	 * @param {string} message
	 * @param {{ status: number, method: string, url: string, body: string }} details
	 */
	constructor(message, { status, method, url, body }) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.method = method;
		this.url = url;
		this.body = body;
	}
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// A non-idempotent request may already be committed after a timeout or a 5xx, so only these are retried.
const UNPROCESSED_STATUS = new Set([429, 503]);
const UNSENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

function unsent(err) {
	const code = err?.cause?.code ?? err?.code;
	return UNSENT_ERROR_CODES.has(code);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {Object} RequestOptions
 * @property {string} [method='GET']
 * @property {Record<string,string>} [headers]
 * @property {any} [json]          Serialized as the JSON body; sets Content-Type.
 * @property {BodyInit} [body]     Raw body (string, Buffer, stream). Mutually exclusive with json.
 * @property {'json'|'text'|'response'|'buffer'} [responseType='json']
 * @property {number} [timeoutMs=120000]
 * @property {number} [retries=3]
 * @property {number[]} [retryOn]  Extra statuses to retry (e.g. Domo card creation 400s).
 * @property {boolean} [idempotent]  Defaults to true except for POST and PATCH. When false, timeouts, network errors
 *   after sending and 5xx (other than 503) are not retried, so a create is never sent twice.
 * @property {'follow'|'manual'} [redirect='follow']
 */

/**
 * @param {string} url
 * @param {RequestOptions} [opts]
 * @returns {Promise<any>}
 */
export async function request(url, opts = {}) {
	const {
		method = 'GET',
		headers = {},
		json,
		body,
		responseType = 'json',
		timeoutMs = 120000,
		retries = 3,
		retryOn = [],
		redirect = 'follow',
		idempotent = IDEMPOTENT_METHODS.has(method.toUpperCase())
	} = opts;

	const finalHeaders = { ...headers };
	let finalBody = body;
	if (json !== undefined) {
		finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
		finalBody = JSON.stringify(json);
	}
	// Streams cannot be replayed, so a streamed body gets exactly one attempt.
	const replayable = finalBody == null || typeof finalBody === 'string' || finalBody instanceof Uint8Array;
	const maxAttempts = replayable ? retries + 1 : 1;

	let lastError;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let response;
		try {
			response = await fetchFollowing(url, {
				method,
				headers: finalHeaders,
				body: finalBody,
				redirect,
				signal: AbortSignal.timeout(timeoutMs),
				...(finalBody && !replayable ? { duplex: 'half' } : {})
			});
		} catch (err) {
			lastError = err;
			if (attempt < maxAttempts && (idempotent || unsent(err))) {
				await sleep(backoffMs(attempt));
				continue;
			}
			throw err;
		}

		if (response.ok || (redirect === 'manual' && response.status >= 300 && response.status < 400)) {
			return readResponse(response, responseType);
		}

		const text = await response.text().catch(() => '');
		lastError = new HttpError(`${method} ${url} failed: HTTP ${response.status}: ${text.slice(0, 2000)}`, {
			status: response.status,
			method,
			url,
			body: text
		});
		const retryable = (idempotent ? RETRYABLE_STATUS : UNPROCESSED_STATUS).has(response.status) || retryOn.includes(response.status);
		if (!retryable || attempt >= maxAttempts) throw lastError;
		await sleep(retryAfterMs(response) ?? backoffMs(attempt));
	}
	throw lastError;
}

const MAX_REDIRECTS = 20;
const CREDENTIAL_HEADER = /^(authorization|cookie|proxy-authorization|x-tableau-auth|x-domo-developer-token|x-domo-authentication)$/i;

/**
 * fetch with redirects followed by hand: fetch strips only Authorization on a cross-origin redirect, so custom
 * credential headers (X-Tableau-Auth, X-DOMO-Developer-Token) would reach the new host.
 */
async function fetchFollowing(url, init) {
	if (init.redirect === 'manual') return fetch(url, init);
	let current = url;
	let { method, body, headers } = init;
	for (let hop = 0; ; hop++) {
		const response = await fetch(current, { ...init, method, body, headers, redirect: 'manual' });
		const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
		if (!location) return response;
		if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${url}`);
		await response.body?.cancel().catch(() => {});
		const from = new URL(current);
		const to = new URL(location, from);
		if (to.origin !== from.origin) {
			headers = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !CREDENTIAL_HEADER.test(name)));
		}
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
			method = 'GET';
			body = undefined;
			headers = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !/^content-/i.test(name)));
		}
		current = to.toString();
	}
}

async function readResponse(response, responseType) {
	if (responseType === 'response') return response;
	if (responseType === 'buffer') return Buffer.from(await response.arrayBuffer());
	const text = await response.text();
	if (responseType === 'text') return text;
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function backoffMs(attempt) {
	return Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function retryAfterMs(response) {
	const header = response.headers.get('retry-after');
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return seconds * 1000;
	const date = Date.parse(header);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Poll until `check` returns a non-undefined value or the timeout elapses.
 * @template T
 * @param {() => Promise<T|undefined>} check
 * @param {{ intervalMs?: number, timeoutMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function poll(check, { intervalMs = 2000, timeoutMs = 600000, label = 'operation' } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = await check();
		if (result !== undefined) return result;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await sleep(intervalMs);
	}
}
