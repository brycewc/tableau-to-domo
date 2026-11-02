const FUNCTIONS = '/query/v1/functions';
const VALIDATE_BATCH = 200;

/**
 * @typedef {Object} ValidationOutcome
 * @property {boolean} valid
 * @property {string} status         Server status, e.g. VALID, INVALID, INVALID_COLUMN
 * @property {string} message
 * @property {string} [dataType]
 * @property {boolean} [aggregated]
 * @property {boolean} [analytic]
 * @property {string[]} [invalidColumns]
 */

/**
 * Validate beast mode expressions against a dataset without saving them.
 * Keys are mapped to the numeric-string ids the endpoint requires ('-1', '-2', ...).
 *
 * @param {import('./client.js').DomoClient} c
 * @param {string} datasetId
 * @param {{ key: string, name: string, expression: string }[]} items
 * @returns {Promise<Map<string, ValidationOutcome>>}
 */
export async function validateExpressions(c, datasetId, items) {
	const out = new Map();
	for (let offset = 0; offset < items.length; offset += VALIDATE_BATCH) {
		const batch = items.slice(offset, offset + VALIDATE_BATCH);
		const functionTemplates = {};
		const keyById = new Map();
		batch.forEach((item, i) => {
			const id = String(-(i + 1));
			keyById.set(id, item.key);
			functionTemplates[id] = { name: item.name || item.key, expression: item.expression };
		});
		const res = await c.post(`${FUNCTIONS}/validateFunctions`, { dataSourceId: datasetId, functionTemplates }, { idempotent: true });
		const results = res?.results || {};
		for (const [id, key] of keyById) {
			out.set(key, toOutcome(results[id]));
		}
	}
	return out;
}

function toOutcome(result) {
	if (!result) return { valid: false, status: 'MISSING', message: 'No validation result returned' };
	const status = String(result.status || 'UNKNOWN');
	const invalidColumns = [...(result.invalidColumns || [])];
	const valid = status === 'VALID';
	let message = valid ? 'valid' : status;
	if (invalidColumns.length) message += `: invalid columns ${invalidColumns.join(', ')}`;
	return {
		valid,
		status,
		message,
		dataType: result.dataType ?? undefined,
		aggregated: result.containsAggregation,
		analytic: result.containsAnalytic,
		invalidColumns
	};
}

function datasetLink(datasetId) {
	return { resource: { type: 'DATA_SOURCE', id: datasetId }, visible: true, active: true };
}

/**
 * Create a dataset beast mode, or a variable when `variable` is true. Never sends
 * `owner` or `strict` (the server rejects a foreign owner,
 * and strict=true lets it fill the owner). Variables must be global.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {{ name: string, expression: string, legacyId?: string, datasetId?: string, variable?: boolean,
 *   global?: boolean, description?: string, dataType?: string }} spec
 * @returns {Promise<Object>} function template incl. numeric `id` and `legacyId`
 */
export async function createBeastMode(c, spec) {
	const { name, expression, legacyId, datasetId, variable = false, description, dataType } = spec;
	const global = variable ? true : Boolean(spec.global);
	if (!name) throw new Error('createBeastMode: name is required');
	if (expression === undefined || expression === null) throw new Error('createBeastMode: expression is required');
	if (global && !variable) throw new Error('createBeastMode: a global function template must be a variable');
	if (!global && !datasetId) throw new Error('createBeastMode: datasetId is required for a dataset beast mode');
	const body = {
		name,
		expression,
		global,
		variable,
		links: global ? [] : [datasetLink(datasetId)]
	};
	if (legacyId) body.legacyId = legacyId;
	if (description) body.description = description;
	if (dataType) body.dataType = dataType;
	return c.post(`${FUNCTIONS}/template`, body);
}

/**
 * Update a beast mode. The endpoint behaves like PATCH and ignores links, so only
 * the changed fields are sent and existing links are kept as they are.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @param {{ name?: string, expression?: string, description?: string, dataType?: string }} spec
 */
export async function updateBeastMode(c, id, spec) {
	const body = {};
	for (const key of ['name', 'expression', 'description', 'dataType']) {
		if (spec[key] !== undefined) body[key] = spec[key];
	}
	return c.put(`${FUNCTIONS}/template/${encodeURIComponent(id)}`, body);
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function getBeastMode(c, id) {
	return c.get(`${FUNCTIONS}/template/${encodeURIComponent(id)}`, { query: { hidden: true } });
}

/**
 * Beast modes linked to a dataset.
 * @param {import('./client.js').DomoClient} c
 * @param {string} datasetId
 * @returns {Promise<Object[]>} templates (with id, legacyId, name, expression, links)
 */
export async function listDatasetBeastModes(c, datasetId) {
	const res = await c.post(`${FUNCTIONS}/list`, { resources: [{ type: 'DATA_SOURCE', id: datasetId }] }, { idempotent: true });
	const objectMap = res?.objectMap || {};
	const mapping = res?.resourceMapping || {};
	const ids = new Set();
	for (const [resourceKey, list] of Object.entries(mapping)) {
		if (!resourceKey.includes(datasetId)) continue;
		for (const fid of list || []) ids.add(String(fid));
	}
	const templates = Object.entries(objectMap)
		.filter(([fid]) => ids.size === 0 || ids.has(String(fid)))
		.map(([fid, template]) => ({ id: template.id ?? Number(fid), ...template }));
	return templates.filter((t) => !t.global);
}

/**
 * Find a beast mode by legacyId among a dataset's beast modes, or by name search
 * for variables (which have no dataset link).
 *
 * @param {import('./client.js').DomoClient} c
 * @param {string} legacyId
 * @param {{ datasetId?: string, name?: string, templates?: Object[] }} [opts]
 *   `templates`: a previously fetched listDatasetBeastModes result, to avoid a call per lookup.
 * @returns {Promise<Object|undefined>}
 */
export async function findByLegacyId(c, legacyId, { datasetId, name, templates } = {}) {
	if (templates) {
		const hit = templates.find((t) => t.legacyId === legacyId);
		if (hit) return hit;
	} else if (datasetId) {
		const hit = (await listDatasetBeastModes(c, datasetId)).find((t) => t.legacyId === legacyId);
		if (hit) return hit;
	}
	if (!name) return undefined;
	const res = await c.post(`${FUNCTIONS}/search`, {
		name,
		filters: [],
		sort: { field: 'name', ascending: true },
		limit: 100,
		offset: 0
	}, { idempotent: true });
	for (const result of res?.results || []) {
		if (result.legacyId === legacyId) return result.expression === undefined ? getBeastMode(c, result.id) : result;
		if (result.legacyId === undefined && result.name === name) {
			const full = await getBeastMode(c, result.id);
			if (full?.legacyId === legacyId) return full;
		}
	}
	return undefined;
}

/**
 * Delete beast modes and variables by template id in one bulk call. Both this and the single DELETE refuse
 * templates with active links, and a non-global template
 * must keep exactly one visible link. So `unlink` gives, per id, the template's links: the visible one is
 * deactivated and other active links except FUNCTION_TEMPLATE ones are removed, in the same request, whose
 * `links` are applied before the deletes are validated. Mutating.
 * @param {import('./client.js').DomoClient} c
 * @param {(number|string)[]} ids
 * @param {{ unlink?: Map<string, Object[]>|Record<string, Object[]> }} [opts]  links as read from each template
 */
export async function deleteBeastModes(c, ids, { unlink } = {}) {
	if (!ids.length) return null;
	const body = { delete: ids.map(Number) };
	const wanted = new Set(ids.map(String));
	const entries = unlink instanceof Map ? [...unlink.entries()] : Object.entries(unlink ?? {});
	const links = {};
	for (const [id, list] of entries) {
		if (!wanted.has(String(id))) continue;
		const active = (list ?? []).filter((l) => l?.resource?.id != null && l.active !== false && l.resource.type !== 'FUNCTION_TEMPLATE');
		const resource = (l) => ({ type: l.resource.type, id: String(l.resource.id) });
		const linkTo = active.filter((l) => l.visible).map((l) => ({ resource: resource(l), visible: true, active: false }));
		const unlinkFrom = active.filter((l) => !l.visible).map((l) => ({ resource: resource(l), visible: false, active: true }));
		if (linkTo.length || unlinkFrom.length) links[id] = { ...(linkTo.length ? { linkTo } : {}), ...(unlinkFrom.length ? { unlinkFrom } : {}) };
	}
	if (Object.keys(links).length) body.links = links;
	return c.post(`${FUNCTIONS}/bulk/template`, body, { idempotent: true });
}

/**
 * Delete one template with the single DELETE. Use it for variables: only this path removes a variable's default
 * control. Mutating.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function deleteTemplate(c, id) {
	return c.del(`${FUNCTIONS}/template/${encodeURIComponent(id)}`);
}
