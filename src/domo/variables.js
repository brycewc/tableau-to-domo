import { isStatus } from './client.js';

const CONTROLS = '/content/v1/variable/controls';

/**
 * Variable controls by control id or by variable (template) id. By variable id only the default controls are
 * returned.
 * @param {import('./client.js').DomoClient} c
 * @param {{ ids?: (number|string)[], functionTemplateIds?: (number|string)[], type?: 'DEFAULT'|'PAGE'|'CARD' }} query
 * @returns {Promise<Object[]>}
 */
export async function listVariableControls(c, { ids, functionTemplateIds, type } = {}) {
	if (!ids?.length && !functionTemplateIds?.length) return [];
	const res = await c.get(CONTROLS, {
		query: { ids: ids?.length ? ids.join(',') : undefined, functionTemplateIds: functionTemplateIds?.length ? functionTemplateIds.join(',') : undefined, type }
	});
	return Array.isArray(res) ? res : [];
}

/**
 * Create or update the default control of a variable. Every variable needs one before a page can show a control
 * for it ("Default control missing for function"); a second default without its id is rejected.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} variableId
 * @param {import('../convert/variables.js').VariableControlSpec} control
 * @returns {Promise<Object>} the saved control, with `id`
 */
export async function upsertDefaultControl(c, variableId, control) {
	const [existing] = await listVariableControls(c, { functionTemplateIds: [variableId], type: 'DEFAULT' });
	const body = { ...control, ...(existing?.id != null ? { id: existing.id } : {}), function: { id: Number(variableId) } };
	const res = await c.put(CONTROLS, [body]);
	return (Array.isArray(res) ? res[0] : res) ?? body;
}

/**
 * True when a global template (variable) already has this name; Domo compares variable names case-insensitively.
 * @param {import('./client.js').DomoClient} c
 * @param {string} name
 */
export async function variableNameTaken(c, name) {
	// The name search is a substring match, so without the filter a short name ("Day") is past the first page.
	const filters = [{ field: 'variable', value: ['true'], not: false }];
	const res = await c.post('/query/v1/functions/search', { name, filters, sort: { field: 'name', ascending: true }, limit: 100, offset: 0 }, { idempotent: true });
	return (res?.results ?? []).some((t) => t.global && String(t.name).toLowerCase() === name.toLowerCase());
}

/**
 * The page's own variable controls (the endpoint also returns default controls, which are dropped).
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} pageId
 * @returns {Promise<Object[]>}
 */
export async function listPageControls(c, pageId) {
	const res = await c.get(`/content/v1/pages/${encodeURIComponent(pageId)}/variable/controls/list`);
	return (Array.isArray(res) ? res : []).filter((x) => x.entityType === 'PAGE' && String(x.entityId) === String(pageId));
}

/**
 * Create or update a variable's control on a page. A page holds one control per variable: a create on a page that
 * already has one answers a bare 400 ("Variable control already exists for pageId"), so the existing one is updated.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} pageId
 * @param {number|string} variableId
 * @param {import('../convert/variables.js').VariableControlSpec} control
 * @param {{ id?: number|string }} [opts]  control id from an earlier push
 * @returns {Promise<Object>} the saved control, with `id`
 */
export async function upsertPageControl(c, pageId, variableId, control, { id } = {}) {
	const path = `${CONTROLS}/PAGE/${encodeURIComponent(pageId)}`;
	const put = (controlId) => c.put(path, { ...control, ...(controlId != null ? { id: Number(controlId) } : {}), function: { id: Number(variableId) } });
	if (id != null) {
		try {
			return await put(id);
		} catch (err) {
			if (!isStatus(err, 400, 404)) throw err;
		}
	}
	try {
		return await put(undefined);
	} catch (err) {
		if (!isStatus(err, 400)) throw err;
		const found = (await listPageControls(c, pageId)).find((x) => String(x.function?.id) === String(variableId));
		if (!found) throw err;
		return put(found.id);
	}
}
