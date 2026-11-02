import { validateExpressions } from './beastmodes.js';
import { getIndexedSchema, indexedColumns } from './datasets.js';

const NUMERIC = new Set(['LONG', 'DOUBLE', 'DECIMAL', 'INTEGER', 'NUMBER']);
const quote = (name) => `\`${String(name).replace(/`/g, '``')}\``;

/**
 * The token user.
 * @param {import('./client.js').DomoClient} c
 * @returns {Promise<{ id: number, displayName?: string, emailAddress?: string }>}
 */
export async function whoAmI(c) {
	const me = await c.get('/content/v2/users/me');
	if (me?.id === undefined) throw new Error('GET /content/v2/users/me returned no user id');
	return me;
}

export const APP_STUDIO_FLAGS = ['data-app', 'app-studio-sections', 'app-studio-persist', 'app-studio-explore', 'app-studio-page-permissions', 'app-studio-worksheets', 'rooster-cards', 'dashboard-component-support', 'filter-bar-v2', 'page-filters-v3'];

/**
 * The instance's customer feature flags.
 * @param {import('./client.js').DomoClient} c
 * @returns {Promise<{ customer: string, features: Map<string, boolean> }>}
 */
export async function readFeatureFlags(c) {
	const customer = String(await c.get('/content/v3/customers/current/name', { responseType: 'text' }))
		.trim()
		.replace(/^"|"$/g, '');
	if (!customer) throw new Error('GET /content/v3/customers/current/name returned no customer name');
	const list = await c.get(`/content/v3/customers/${encodeURIComponent(customer)}/features`);
	const features = new Map();
	for (const f of Array.isArray(list) ? list : []) if (f?.name) features.set(f.name, f.enabled === true);
	return { customer, features };
}

/**
 * Whether App Studio apps can be pushed: the `data-app` flag registers the frontend's /app-studio route (the backend
 * accepts app writes without it, so an app pushed with it off cannot be opened). `flags` maps each of
 * APP_STUDIO_FLAGS to on, off or absent.
 * @param {import('./client.js').DomoClient} c
 * @returns {Promise<{ available: boolean, customer: string, flags: Record<string, 'on'|'off'|'absent'> }>}
 */
export async function appStudioStatus(c) {
	const { customer, features } = await readFeatureFlags(c);
	const flags = Object.fromEntries(APP_STUDIO_FLAGS.map((name) => [name, features.has(name) ? (features.get(name) ? 'on' : 'off') : 'absent']));
	return { available: flags['data-app'] === 'on', customer, flags };
}

/**
 * Check which beast mode features this instance accepts, by validating (not saving)
 * test expressions against a real dataset. validateFunctions accepts window functions that
 * fail when a card queries them ("Not a valid analytic function"), so `window` comes from a
 * read-only query of the validated expression; `windowValidated` keeps the validation result.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {{ datasetId: string }} opts
 * @returns {Promise<{ basic: boolean|null, fixed: boolean|null, window: boolean|null, windowValidated?: boolean,
 *   column?: string, messages: Record<string,string> }>}
 */
export async function probeCapabilities(c, { datasetId }) {
	if (!datasetId) throw new Error('probeCapabilities: datasetId is required');
	const messages = {};
	const columns = indexedColumns(await getIndexedSchema(c, datasetId));
	if (!columns.length) {
		const reason = `dataset ${datasetId} has no indexed columns`;
		return { basic: null, fixed: null, window: null, messages: { basic: reason, fixed: reason, window: reason } };
	}
	const numeric = columns.find((col) => NUMERIC.has(String(col.type).toUpperCase()));
	const column = (numeric || columns[0]).name ?? (numeric || columns[0]).id;
	const ref = quote(column);
	const inner = numeric ? `SUM(${ref})` : `COUNT(${ref})`;
	const items = [
		{ key: 'basic', name: 't2d probe basic', expression: inner },
		{ key: 'fixed', name: 't2d probe fixed', expression: `SUM(${inner} FIXED ())` },
		{ key: 'window', name: 't2d probe window', expression: `SUM(${inner}) OVER ()` }
	];
	const results = await validateExpressions(c, datasetId, items);
	const out = { column, messages };
	for (const { key } of items) {
		const result = results.get(key);
		out[key] = Boolean(result?.valid);
		messages[key] = result?.message ?? 'no result';
	}
	out.windowValidated = out.window;
	if (out.window) {
		const dim = columns.find((col) => !NUMERIC.has(String(col.type).toUpperCase())) ?? columns[0];
		const group = quote(dim.name ?? dim.id);
		const sql = `SELECT ${group}, ${items[2].expression} AS t2d_probe FROM table GROUP BY ${group} LIMIT 1`;
		try {
			await c.post(`/query/v1/execute/${encodeURIComponent(datasetId)}`, { sql });
			messages.window = 'valid and queried';
		} catch (err) {
			const message = errorMessage(err);
			out.window = /analytic function|window|over/i.test(message) ? false : null;
			messages.window = `validates, but the query ${out.window === false ? 'fails' : 'could not run'}: ${message}`;
		}
	}
	return out;
}

function errorMessage(err) {
	try {
		const body = typeof err?.body === 'string' ? JSON.parse(err.body) : err?.body;
		if (body?.message) return String(body.message);
	} catch {
		// not JSON
	}
	return String(err?.message ?? err);
}
