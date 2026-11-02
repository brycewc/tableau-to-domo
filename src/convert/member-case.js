import { collationIgnoresCase } from './calc/sql.js';

// Tableau matches filter members with the source collation (often case-insensitive: "ENDOFPERIOD" keeps "EndOfPeriod"
// rows); Domo compares text case-sensitively, so such members are rewritten to every spelling the data holds.

const sharedCollations = new WeakMap();

function datasourceCollation(ds) {
	if (!ds) return undefined;
	if (!sharedCollations.has(ds)) {
		const names = new Set((ds.fields ?? []).filter((f) => f.kind === 'column' && f.datatype === 'string' && f.collation).map((f) => f.collation));
		sharedCollations.set(ds, names.size === 1 ? [...names][0] : undefined);
	}
	return sharedCollations.get(ds);
}

/** Tableau compares this text field case-sensitively: its collation (else its datasource's shared one) is 'binary'. */
export function textCaseSensitive(field, ds) {
	if (field?.datatype !== 'string') return false;
	return (field.collation ?? datasourceCollation(ds)) === 'binary';
}

/** Tableau's collation of this text field (else its datasource's shared one) ignores case. */
export function textIgnoresCase(field, ds) {
	if (field?.datatype !== 'string') return false;
	return collationIgnoresCase(field.collation ?? datasourceCollation(ds));
}

/**
 * Text members of the categorical filters and sets on each column field of a datasource.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {import('../model/types.js').DatasourceIR} ds
 * @returns {Map<string, Set<string>>} field id -> members
 */
export function filterMembers(ir, ds) {
	const columns = new Set((ds.fields ?? []).filter((f) => f.kind === 'column' && f.datatype === 'string').map((f) => f.id));
	const out = new Map();
	const add = (fieldId, values) => {
		if (!columns.has(fieldId)) return;
		for (const v of values ?? []) {
			if (typeof v !== 'string' || !v) continue;
			if (!out.has(fieldId)) out.set(fieldId, new Set());
			out.get(fieldId).add(v);
		}
	};
	const filters = [...(ds.filters ?? []), ...(ir.worksheets ?? []).flatMap((w) => (w.filters ?? []).filter((f) => f.datasourceId === ds.id))];
	for (const f of filters) if (f.kind === 'categorical') add(f.fieldId, [...(f.include ?? []), ...(f.exclude ?? [])]);
	for (const f of ds.fields ?? []) if (f.kind === 'set' && f.set?.source) add(f.set.source, f.set.members);
	return out;
}

/**
 * Rewrite filter and set members to the case the data holds (`DataManifest.memberCase`). Returns the IR unchanged when
 * no manifest records a variant.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {Map<string, import('../model/types.js').DataManifest>} manifests  by datasource id
 */
export function applyMemberCase(ir, manifests) {
	const byDs = new Map();
	for (const ds of ir.datasources ?? []) {
		const map = manifests.get(ds.id)?.memberCase;
		if (map && Object.keys(map).length) byDs.set(ds.id, map);
	}
	if (!byDs.size) return { ir, issues: [] };
	const issues = [];
	const fixed = new Set();
	const rewrite = (dsId, fieldId, values, where) => {
		const map = byDs.get(dsId)?.[fieldId];
		if (!map || !values) return values;
		const out = values.flatMap((v) => {
			const to = typeof v === 'string' && Object.hasOwn(map, v) ? map[v] : undefined;
			if (to === undefined) return [v];
			const key = `${dsId}|${fieldId}|${v}`;
			if (!fixed.has(key)) {
				fixed.add(key);
				const shown = [to].flat().map((s) => `"${s}"`).join(', ');
				issues.push({ severity: 'info', code: 'filter.member-case', message: `${where}: member "${v}" of ${fieldId} is ${shown} in the data (Tableau matched it ignoring case); Domo compares case-sensitively, so the data's values are used` });
			}
			return [to].flat();
		});
		return [...new Set(out)];
	};
	const fixFilter = (f, dsId, where) => (f.kind === 'categorical' && byDs.has(dsId) ? { ...f, ...(f.include ? { include: rewrite(dsId, f.fieldId, f.include, where) } : {}), ...(f.exclude ? { exclude: rewrite(dsId, f.fieldId, f.exclude, where) } : {}) } : f);
	const datasources = ir.datasources.map((ds) => {
		if (!byDs.has(ds.id)) return ds;
		return {
			...ds,
			filters: (ds.filters ?? []).map((f) => fixFilter(f, ds.id, `Datasource "${ds.caption}"`)),
			fields: (ds.fields ?? []).map((f) => (f.kind === 'set' && f.set?.members ? { ...f, set: { ...f.set, members: rewrite(ds.id, f.set.source, f.set.members, `Set "${f.name}"`) } } : f))
		};
	});
	const worksheets = (ir.worksheets ?? []).map((w) => ({ ...w, filters: (w.filters ?? []).map((f) => fixFilter(f, f.datasourceId, `Worksheet "${w.name}"`)) }));
	return { ir: { ...ir, datasources, worksheets }, issues };
}
