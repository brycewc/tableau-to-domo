/**
 * Tableau formulas of the calculations that did not translate, for the follow-up checklist.
 *
 * @typedef {Object} CalcFormula
 * @property {string} key          Beast Mode key
 * @property {string} name
 * @property {string} fieldId      Tableau field id
 * @property {string} [datasource]  Tableau datasource caption
 * @property {string} formula      As written in Tableau, field ids replaced by captions where they resolve
 * @property {string[]} reasons
 * @property {{ key: string, name: string, formula: string }[]} references  Untranslated calcs it uses, transitively
 */

const REF = /(\[(?:[^\]]|\]\])*\]\.)?\[(?:[^\]]|\]\])*\]/g;

const bracket = (name) => `[${String(name).replace(/\]/g, ']]')}]`;

/**
 * Replace field and parameter ids ([Calculation_123], [Parameters].[Parameter 1]) by their captions; a reference that
 * does not resolve is kept as written.
 * @param {string} formula
 * @param {{ ir?: import('../model/types.js').WorkbookIR | null, datasourceId?: string }} [ctx]
 */
export function readableFormula(formula, { ir, datasourceId } = {}) {
	const text = String(formula ?? '');
	if (!ir) return text;
	const sources = new Map((ir.datasources ?? []).map((d) => [`[${d.id}]`, d]));
	const params = new Map((ir.parameters ?? []).map((p) => [p.id, p.name ?? p.caption]));
	const fieldName = (ds, id) => {
		const field = ds?.fields?.find((f) => f.id === id);
		return field ? field.caption ?? field.name : undefined;
	};
	const own = sources.get(`[${datasourceId}]`);
	return text.replace(REF, (ref, prefix) => {
		if (!prefix) {
			const name = fieldName(own, ref);
			return name ? bracket(name) : ref;
		}
		const qualifier = prefix.slice(0, -1);
		if (qualifier === '[Parameters]') return params.get(ref) ? `[Parameters].${bracket(params.get(ref))}` : ref;
		const ds = sources.get(qualifier);
		const name = fieldName(ds, ref.slice(prefix.length));
		return name ? `${bracket(ds.caption ?? ds.id)}.${bracket(name)}` : ref;
	});
}

/**
 * One entry per unsupported Beast Mode, with the reasons from the issues raised on its field.
 * @param {{ ir?: any, plan?: any, issues?: import('../model/types.js').Issue[] }} input
 * @returns {CalcFormula[]}
 */
export function untranslatedCalcs({ ir, plan, issues = [] } = {}) {
	const datasetSource = new Map((plan?.datasets ?? []).map((d) => [d.key, d]));
	const sourceOf = (bm) => datasetSource.get(bm.datasetKey)?.datasourceId;
	const unsupported = (plan?.beastModes ?? []).filter((b) => b.status === 'unsupported');
	const irSource = (id) => ir?.datasources?.find((d) => d.id === id);
	const formulaOf = (bm) => {
		const field = irSource(sourceOf(bm))?.fields?.find((f) => f.id === bm.tableauFieldId);
		return readableFormula(bm.tableauFormula || field?.formula || '', { ir, datasourceId: sourceOf(bm) });
	};
	const referenced = (bm, seen = new Set([bm.key])) => {
		const raw = bm.tableauFormula || '';
		const ids = new Set([...raw.matchAll(REF)].filter((m) => !m[1]).map((m) => m[0]));
		const found = unsupported.filter((b) => !seen.has(b.key) && ids.has(b.tableauFieldId) && sourceOf(b) === sourceOf(bm));
		for (const b of found) seen.add(b.key);
		return found.flatMap((b) => [b, ...referenced(b, seen)]);
	};
	return unsupported.map((bm) => {
		const datasource = irSource(sourceOf(bm))?.caption ?? datasetSource.get(bm.datasetKey)?.name;
		const reasons = issues
			.filter((i) => i.severity !== 'info' && i.object?.name === bm.name && (!i.object.id || i.object.id === bm.tableauFieldId))
			.map((i) => [String(i.message ?? '').trim().replace(/([^.!?)])$/, '$1.'), i.suggestion].filter(Boolean).join(' '))
			.filter((r, idx, all) => r && all.indexOf(r) === idx);
		return {
			key: bm.key,
			name: bm.name,
			fieldId: bm.tableauFieldId,
			...(datasource ? { datasource } : {}),
			formula: formulaOf(bm),
			reasons: reasons.length ? reasons : ['It could not be translated to a Beast Mode.'],
			references: referenced(bm).map((b) => ({ key: b.key, name: b.name, formula: formulaOf(b) }))
		};
	});
}
