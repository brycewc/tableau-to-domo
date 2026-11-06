import { whoAmI } from './probe.js';

const FUSIONS = '/query/v1/fusions';

async function withDefaults(c, body) {
	const out = { dataSourceType: 'datafusion', validate: true, ...body };
	if (out.responsibleUserId === undefined || out.responsibleUserId === null) {
		const me = await whoAmI(c);
		out.responsibleUserId = String(me.id);
	}
	return out;
}

/**
 * Create a DataSet View (legacy fusion API: column fuse for joins, row fuse for unions).
 * `responsibleUserId` defaults to the token user.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {{ dataSourceName: string, columnList: Object[], columnFuse?: Object, rowFuse?: Object, responsibleUserId?: string }} body
 * @returns {Promise<{ dataSourceId: string }>}
 */
export async function createFusion(c, body) {
	const res = await c.post(FUSIONS, await withDefaults(c, body));
	if (!res?.dataSourceId) throw new Error(`createFusion: response had no dataSourceId: ${JSON.stringify(res).slice(0, 500)}`);
	return res;
}

/**
 * Replace a view's fusion definition.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {Object} body
 */
export async function updateFusion(c, id, body) {
	return c.put(`${FUSIONS}/${encodeURIComponent(id)}`, await withDefaults(c, body));
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 */
export async function getFusion(c, id) {
	return c.get(`${FUSIONS}/${encodeURIComponent(id)}`);
}

/**
 * Delete a view. Uses the dataset delete: `DELETE /query/v1/fusions/{id}` leaves the dataset record behind.
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 */
export async function deleteFusion(c, id) {
	return c.del(`/data/v3/datasources/${encodeURIComponent(id)}`);
}

async function withResponsibleUser(c, body) {
	if (body.responsibleUserId !== undefined && body.responsibleUserId !== null) return body;
	const me = await whoAmI(c);
	return { ...body, responsibleUserId: me.id };
}

// Domo runs the view query on the warehouse before answering, which can take minutes.
const SQL_VIEW_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Create a SQL DataSet View (`POST /query/v1/views`, the Views Explorer API).
 * `schema.viewTemplate.version` is 'advancedEditorSql' and `schema.tableAliases` maps SQL aliases to dataset ids.
 * @param {import('./client.js').DomoClient} c
 * @param {{ dataSourceName: string, schema: Object, dataProviderType?: string, cloudId?: string, trigger?: Object, responsibleUserId?: string|number }} body
 * @returns {Promise<{ dataSourceId: string }>}
 */
export async function createSqlView(c, body) {
	const res = await c.post('/query/v1/views', await withResponsibleUser(c, { lastModified: String(Date.now()), ...body }), { idempotent: false, timeoutMs: SQL_VIEW_TIMEOUT_MS });
	if (!res?.dataSourceId) throw new Error(`createSqlView: response had no dataSourceId: ${JSON.stringify(res).slice(0, 500)}`);
	return res;
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {string} id
 * @param {Object} body
 */
export async function updateSqlView(c, id, body) {
	return c.put(`/query/v1/views/${encodeURIComponent(id)}`, await withResponsibleUser(c, { lastModified: String(Date.now()), ...body }), { timeoutMs: SQL_VIEW_TIMEOUT_MS });
}
