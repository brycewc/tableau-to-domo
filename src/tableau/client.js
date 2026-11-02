import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request, sleep, HttpError } from '../util/http.js';
import { createEmitter, noopSink } from '../util/events.js';

export const FLOOR_API_VERSION = '3.19';
const LEGACY_PROBE_VERSION = '2.4';
const MAX_SIGNIN_REDIRECTS = 5;
const MAX_PAGE_SIZE = 1000;
const JSON_HEADERS = { Accept: 'application/json' };

export class TableauGraphQLError extends Error {
	/**
	 * @param {string} message
	 * @param {{ errors: any[], data?: any }} details
	 */
	constructor(message, { errors, data }) {
		super(message);
		this.name = 'TableauGraphQLError';
		this.errors = errors;
		this.data = data;
		this.codes = errors.map((e) => e?.extensions?.code).filter(Boolean);
	}
}

// Codes seen on Tableau Cloud (REST 3.29) for missing capabilities; other 403s are hinted from the detail text.
const CODE_HINTS = {
	403019: 'needs the Download Workbook/Save a Copy capability',
	403028: 'needs the Download Data Source capability, unless Tableau rejected it for running alongside other downloads: retry it on its own',
	403800: 'needs the API Access capability on the datasource for VizQL Data Service'
};

// Tableau Cloud answers 403028 to parallel datasource downloads on one session that succeed one at a time.
const TRANSIENT_DOWNLOAD_CODES = new Set(['403028']);

function hintFor(code, detail) {
	if (CODE_HINTS[code]) return CODE_HINTS[code];
	if (/download/i.test(detail ?? '') && /data ?source/i.test(detail ?? '')) return 'needs the Download Data Source capability';
	return undefined;
}

/** HttpError from a Tableau API with the parsed `code`, `summary` and `detail`. */
export class TableauApiError extends HttpError {
	/**
	 * @param {HttpError} err
	 * @param {{ code?: string, summary?: string, detail?: string }} parsed
	 */
	constructor(err, parsed) {
		super(formatTableauError(err, parsed), { status: err.status, method: err.method, url: err.url, body: err.body });
		this.name = 'TableauApiError';
		this.code = parsed.code;
		this.summary = parsed.summary;
		this.detail = parsed.detail;
		this.cause = err;
	}
}

/**
 * Parse a Tableau error body: REST XML `<tsResponse><error code><summary/><detail/></error>`, REST JSON
 * `{ error: { code, summary, detail } }`, or VizQL Data Service `{ errorCode, message }`.
 * @param {string} body
 * @returns {{ code?: string, summary?: string, detail?: string }|null}
 */
export function parseTableauError(body) {
	const text = String(body ?? '').trim();
	if (!text) return null;
	if (text.startsWith('{')) {
		try {
			const json = JSON.parse(text);
			const e = json?.error ?? json;
			const code = e?.code ?? e?.errorCode;
			const summary = e?.summary;
			const detail = e?.detail ?? e?.message;
			if (code || summary || detail) return { code: code !== undefined ? String(code) : undefined, summary, detail };
		} catch {
			return null;
		}
		return null;
	}
	const error = /<error\b[^>]*\bcode=["']([^"']+)["'][^>]*>([\s\S]*?)<\/error>/i.exec(text);
	if (!error) return null;
	const tag = (name) => {
		const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(error[2]);
		return m ? decodeXml(m[1].trim()) : undefined;
	};
	return { code: error[1], summary: tag('summary'), detail: tag('detail') };
}

function decodeXml(value) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, '&');
}

function formatTableauError(err, { code, summary, detail }) {
	const hint = hintFor(code, detail);
	const text = [summary, detail].filter(Boolean).join(': ') || `HTTP ${err.status}`;
	return `Tableau ${code ?? err.status}: ${text}${hint ? ` (${hint})` : ''} [${err.method} ${err.url?.replace(/\?.*$/, '')}]`;
}

/** Replace a raw Tableau HttpError with a TableauApiError when its body parses. */
export function friendlyTableauError(err) {
	if (!(err instanceof HttpError) || err instanceof TableauApiError) return err;
	const parsed = parseTableauError(err.body);
	return parsed ? new TableauApiError(err, parsed) : err;
}

/**
 * Tableau REST, Metadata API and VizQL Data Service client sharing one PAT session.
 */
export class TableauClient {
	/**
	 * @param {import('../config.js').TableauConfig} tableauConfig
	 * @param {{ emitter?: import('../util/events.js').Emitter, downloadTimeoutMs?: number, timeoutMs?: number, downloadRetries?: number, downloadRetryDelayMs?: number }} [opts]
	 */
	constructor(tableauConfig, { emitter, downloadTimeoutMs = 60 * 60 * 1000, timeoutMs = 120000, downloadRetries = 2, downloadRetryDelayMs = 5000 } = {}) {
		if (!tableauConfig?.server) throw new Error('Tableau server URL is required');
		this.config = tableauConfig;
		this.server = String(tableauConfig.server).replace(/\/+$/, '');
		this.site = tableauConfig.site ?? '';
		this.apiVersion = tableauConfig.apiVersion || null;
		this.token = null;
		this.siteId = null;
		this.userId = null;
		this.log = emitter || createEmitter(noopSink, 'tableau');
		this.downloadTimeoutMs = downloadTimeoutMs;
		this.timeoutMs = timeoutMs;
		this.downloadRetries = downloadRetries;
		this.downloadRetryDelayMs = downloadRetryDelayMs;
		this._signInPromise = null;
		this._downloadQueue = Promise.resolve();
	}

	/** Sign in once; concurrent callers share the same in-flight promise. */
	async signIn() {
		if (this.token) return this._session();
		if (!this._signInPromise) {
			this._signInPromise = this._doSignIn().finally(() => {
				this._signInPromise = null;
			});
		}
		return this._signInPromise;
	}

	_session() {
		return { token: this.token, siteId: this.siteId, userId: this.userId, apiVersion: this.apiVersion, server: this.server };
	}

	async _doSignIn() {
		const { patName, patSecret } = this.config;
		if (!patName || !patSecret) throw new Error('Tableau PAT name and secret are required');
		if (!this.apiVersion) this.apiVersion = await this._detectVersion();

		const body = {
			credentials: {
				personalAccessTokenName: patName,
				personalAccessTokenSecret: patSecret,
				site: { contentUrl: this.site }
			}
		};
		if (/^http:/i.test(this.server)) this.log.warn(`TABLEAU_SERVER ${this.server} is plain http; the PAT secret is sent unencrypted`);
		let url = `${this.server}/api/${this.apiVersion}/auth/signin`;
		let response;
		for (let hop = 0; ; hop++) {
			try {
				response = await request(url, {
					method: 'POST',
					headers: JSON_HEADERS,
					json: body,
					redirect: 'manual',
					responseType: 'response',
					timeoutMs: this.timeoutMs,
					idempotent: true
				});
			} catch (err) {
				if (err instanceof HttpError && err.status === 401) {
					const parsed = parseTableauError(err.body);
					const reason = parsed ? `Tableau ${parsed.code ?? 401}: ${[parsed.summary, parsed.detail].filter(Boolean).join(': ')}` : err.body?.slice(0, 500) || '';
					throw new Error(`Tableau sign-in rejected (HTTP 401). Check the PAT name/secret and site "${this.site}". A PAT expires after 15 days unused. ${reason}`.trim(), { cause: err });
				}
				throw friendlyTableauError(err);
			}
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get('location');
			if (!location) throw new Error(`Tableau sign-in returned HTTP ${response.status} without a Location header`);
			if (hop >= MAX_SIGNIN_REDIRECTS) throw new Error('Tableau sign-in redirected too many times');
			// Re-POST by hand: following a 301/302 would turn the POST into a GET (TSC auth_endpoint.py does the same).
			const next = new URL(location, url);
			assertSafeSignInRedirect(new URL(url), next);
			url = next.toString();
			const base = baseFromApiUrl(url);
			if (base && base !== this.server) {
				this.log.info(`Tableau redirected sign-in to ${base}`, { from: this.server, to: base });
				this.server = base;
			}
		}

		const json = await readJson(response);
		const credentials = json?.credentials;
		if (!credentials?.token) throw new Error('Tableau sign-in response did not contain a token');
		this.token = credentials.token;
		this.siteId = credentials.site?.id ?? null;
		this.userId = credentials.user?.id ?? null;
		this.log.info(`Signed in to Tableau (REST ${this.apiVersion})`, { server: this.server, site: this.site });
		return this._session();
	}

	async _detectVersion() {
		for (const probe of [FLOOR_API_VERSION, LEGACY_PROBE_VERSION]) {
			try {
				const json = await request(`${this.server}/api/${probe}/serverinfo`, {
					headers: JSON_HEADERS,
					retries: 1,
					timeoutMs: this.timeoutMs
				});
				const version = json?.serverInfo?.restApiVersion;
				if (version) {
					if (compareVersions(version, FLOOR_API_VERSION) < 0) {
						this.log.warn(`Tableau REST ${version} is older than ${FLOOR_API_VERSION} (Server 2023.1); some features may not work`);
					}
					return String(version);
				}
			} catch {
				// try the next probe
			}
		}
		this.log.warn(`Could not detect the Tableau REST version; using ${FLOOR_API_VERSION}`);
		return FLOOR_API_VERSION;
	}

	/** Invalidate the session token (best effort). */
	async signOut() {
		if (this._signInPromise) await this._signInPromise.catch(() => {});
		const token = this.token;
		this.token = null;
		this.siteId = null;
		this.userId = null;
		if (!token) return;
		try {
			await request(`${this.server}/api/${this.apiVersion}/auth/signout`, {
				method: 'POST',
				headers: { ...JSON_HEADERS, 'X-Tableau-Auth': token },
				retries: 0,
				timeoutMs: this.timeoutMs
			});
		} catch (err) {
			this.log.warn(`Tableau sign-out failed: ${err.message}`);
		}
	}

	/**
	 * Authenticated request; re-signs-in once on 401 and retries.
	 * @param {(session: { token: string, siteId: string, apiVersion: string, server: string }) => string} buildUrl
	 * @param {import('../util/http.js').RequestOptions} [opts]
	 */
	async _authed(buildUrl, opts = {}) {
		for (let attempt = 0; ; attempt++) {
			const session = await this.signIn();
			try {
				return await request(buildUrl(session), {
					timeoutMs: this.timeoutMs,
					...opts,
					headers: { ...JSON_HEADERS, ...opts.headers, 'X-Tableau-Auth': session.token }
				});
			} catch (err) {
				if (!(err instanceof HttpError) || err.status !== 401 || attempt > 0) throw friendlyTableauError(err);
				this.log.info('Tableau session expired; signing in again');
				if (this.token === session.token) this.token = null;
			}
		}
	}

	_siteUrl(session, relPath, query) {
		const rel = relPath.startsWith('/') ? relPath : `/${relPath}`;
		return `${session.server}/api/${session.apiVersion}/sites/${session.siteId}${rel}${toQueryString(query)}`;
	}

	/**
	 * GET a site-relative REST path as JSON.
	 * @param {string} relPath e.g. '/workbooks'
	 * @param {Record<string, any>} [query]
	 */
	async get(relPath, query) {
		return this._authed((s) => this._siteUrl(s, relPath, query));
	}

	/**
	 * Fetch every page of a REST collection.
	 * @param {string} relPath
	 * @param {{ collection: string, item: string, query?: Record<string, any>, pageSize?: number }} opts
	 * @returns {Promise<any[]>}
	 */
	async paginate(relPath, { collection, item, query = {}, pageSize = 100 } = {}) {
		if (!collection || !item) throw new Error('paginate requires collection and item');
		const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(pageSize)) || 100));
		const items = [];
		for (let pageNumber = 1; ; pageNumber++) {
			const json = await this.get(relPath, { ...query, pageSize: size, pageNumber });
			const page = asArray(json?.[collection]?.[item]);
			items.push(...page);
			const total = Number(json?.pagination?.totalAvailable);
			if (!page.length) break;
			if (Number.isFinite(total) && items.length >= total) break;
			if (!Number.isFinite(total) && page.length < size) break;
		}
		return items;
	}

	/**
	 * Stream a REST resource to disk (temp file then rename).
	 * @param {string} relPath
	 * @param {string | ((filename: string|null, contentType: string) => string)} destFile
	 *   A path, or a function choosing the path from the Content-Disposition filename.
	 * @param {Record<string, any>} [query]
	 * @returns {Promise<{ file: string, filename: string|null, bytes: number }>}
	 */
	async download(relPath, destFile, query) {
		const run = this._downloadQueue.then(() => this._downloadWithRetry(relPath, destFile, query));
		this._downloadQueue = run.catch(() => {});
		return run;
	}

	async _downloadWithRetry(relPath, destFile, query) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this._downloadOnce(relPath, destFile, query);
			} catch (err) {
				if (!TRANSIENT_DOWNLOAD_CODES.has(err?.code) || attempt >= this.downloadRetries) throw err;
				this.log.info(`Tableau ${err.code} on ${relPath}; retrying the download`);
				await sleep(this.downloadRetryDelayMs * (attempt + 1));
			}
		}
	}

	async _downloadOnce(relPath, destFile, query) {
		const response = await this._authed((s) => this._siteUrl(s, relPath, query), {
			headers: { Accept: '*/*' },
			responseType: 'response',
			timeoutMs: this.downloadTimeoutMs
		});
		const filename = parseContentDisposition(response.headers.get('content-disposition'));
		const contentType = response.headers.get('content-type') || '';
		const file = typeof destFile === 'function' ? destFile(filename, contentType) : destFile;
		if (!file) throw new Error('download: no destination file');
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		const temp = `${file}.${randomBytes(6).toString('hex')}.part`;
		try {
			if (!response.body) throw new Error(`Empty response body for ${relPath}`);
			await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
			await fs.promises.rename(temp, file);
		} catch (err) {
			await fs.promises.rm(temp, { force: true }).catch(() => {});
			throw err;
		}
		const { size } = await fs.promises.stat(file);
		return { file, filename, bytes: size };
	}

	/**
	 * Metadata API query. Throws TableauGraphQLError on any `errors`, including
	 * NODE_LIMIT_EXCEEDED / TIME_LIMIT_EXCEEDED partial results.
	 * @param {string} query
	 * @param {Record<string, any>} [variables]
	 */
	async graphql(query, variables = {}) {
		const json = await this._authed((s) => `${s.server}/api/metadata/graphql`, {
			method: 'POST',
			json: { query, variables },
			idempotent: true
		});
		if (json == null || typeof json !== 'object') throw new Error('Metadata API returned a non-JSON response');
		const errors = asArray(json.errors);
		if (errors.length) {
			const messages = errors.map((e) => {
				const code = e?.extensions?.code;
				return code ? `${code}: ${e?.message}` : String(e?.message ?? e);
			});
			const partial = errors.some((e) => /NODE_LIMIT|TIME_LIMIT/.test(e?.extensions?.code || e?.message || ''));
			const prefix = partial ? 'Metadata API returned partial results' : 'Metadata API query failed';
			throw new TableauGraphQLError(`${prefix}: ${messages.join('; ')}`, { errors, data: json.data });
		}
		return json.data;
	}

	/**
	 * VizQL Data Service call.
	 * @param {string} endpoint e.g. 'read-metadata', 'query-datasource'
	 * @param {any} body
	 */
	async vds(endpoint, body) {
		const ep = String(endpoint).replace(/^\/+/, '');
		// A heavy query-datasource can outlast the default timeout; re-sending it would only multiply server load.
		const heavy = ep === 'query-datasource';
		return this._authed((s) => `${s.server}/api/v1/vizql-data-service/${ep}`, {
			method: 'POST',
			json: body,
			idempotent: !heavy,
			...(heavy ? { retries: 0, timeoutMs: this.downloadTimeoutMs } : {})
		});
	}
}

const registrableDomain = (host) => host.split('.').slice(-2).join('.');

/** Sign-in re-POSTs the PAT secret, so refuse redirects that downgrade to http or leave the server's domain. */
function assertSafeSignInRedirect(from, to) {
	if (from.protocol === 'https:' && to.protocol !== 'https:') {
		throw new Error(`Tableau sign-in redirected from https to ${to.protocol}//${to.host}; refusing to send the PAT secret`);
	}
	if (registrableDomain(from.hostname) !== registrableDomain(to.hostname)) {
		throw new Error(`Tableau sign-in redirected to another domain (${to.host}); set TABLEAU_SERVER to that server if it is expected`);
	}
}

/**
 * Filename from a Content-Disposition header (RFC 6266: filename* preferred).
 * @param {string|null|undefined} header
 * @returns {string|null}
 */
export function parseContentDisposition(header) {
	if (!header) return null;
	const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
	if (star) {
		const raw = star[2].trim().replace(/^"|"$/g, '');
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
	if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
	const bare = /filename\s*=\s*([^;]+)/i.exec(header);
	return bare ? bare[1].trim() : null;
}

function baseFromApiUrl(url) {
	const idx = url.indexOf('/api/');
	return idx > 0 ? url.slice(0, idx) : null;
}

function toQueryString(query) {
	if (!query) return '';
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue;
		params.append(key, String(value));
	}
	const qs = params.toString();
	return qs ? `?${qs}` : '';
}

async function readJson(response) {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Expected JSON from Tableau but got: ${text.slice(0, 200)}`);
	}
}

function asArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function compareVersions(a, b) {
	const pa = String(a).split('.').map(Number);
	const pb = String(b).split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return d;
	}
	return 0;
}
