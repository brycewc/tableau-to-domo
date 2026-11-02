/**
 * Cross-object references inside a DomoPlan. The plan is written before any Domo
 * object exists, so anything that needs a Domo id holds `{ $ref: 'kind:key' }`
 * (optionally `{ $ref, field }`) and push resolves it from state.
 */

/**
 * @param {'dataset'|'dataflow'|'beastmode'|'card'|'page'|'variable'} kind
 * @param {string} key
 * @param {string} [field] Property of the state entry to substitute (default 'id').
 */
export function ref(kind, key, field) {
	return field ? { $ref: `${kind}:${key}`, field } : { $ref: `${kind}:${key}` };
}

export function isRef(value) {
	return value !== null && typeof value === 'object' && typeof value.$ref === 'string';
}

/**
 * Deep-copy `value`, replacing every ref with the resolved id.
 * @param {any} value
 * @param {(refString: string, field: string) => any} lookup Throws or returns undefined when unresolved.
 * @returns {any}
 */
export function resolveRefs(value, lookup) {
	if (isRef(value)) {
		const resolved = lookup(value.$ref, value.field || 'id');
		if (resolved === undefined) throw new Error(`Unresolved reference ${value.$ref}`);
		return resolved;
	}
	if (Array.isArray(value)) return value.map((item) => resolveRefs(item, lookup));
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, lookup);
		return out;
	}
	return value;
}

/** Every `$ref` string reachable from `value`, for dependency ordering. */
export function collectRefs(value, into = new Set()) {
	if (isRef(value)) into.add(value.$ref);
	else if (Array.isArray(value)) value.forEach((item) => collectRefs(item, into));
	else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectRefs(v, into));
	return into;
}
