import { translateEtl } from './calc/index.js';
import { fieldLookup } from './beastmodes.js';

/**
 * A datasource's "apply to all worksheets" categorical filters that no sheet or dashboard shows as a quick filter.
 * Tableau applies them to every row before any sheet, so a joins dataflow can apply them too, which keeps a join with
 * no keys (a `1 = 1` relation narrowed by a filter) from materializing every row pair. Pure.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {import('../model/types.js').DatasourceIR} ds
 * @returns {import('../model/types.js').FilterIR[]}
 */
export function fixedDatasourceFilters(ir, ds) {
	const sheets = (ir.worksheets ?? []).filter((w) => (w.datasourceIds ?? []).includes(ds.id));
	if (!sheets.length) return [];
	const zoneParams = new Set(
		(ir.dashboards ?? [])
			.flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])])
			.filter((z) => z.kind === 'filter')
			.map((z) => z.param)
	);
	const copies = new Map();
	for (const ws of sheets) {
		const quick = new Set((ws.quickFilters ?? []).map((q) => q.pillId));
		for (const f of ws.filters ?? []) {
			if (f.shared !== ds.id) continue;
			const shown = Boolean(f.shownOnDashboard) || zoneParams.has(f.pillId) || quick.has(f.pillId);
			const list = copies.get(f.fieldId) ?? [];
			list.push({ filter: f, shown, sheet: ws.name });
			copies.set(f.fieldId, list);
		}
	}
	const out = [];
	for (const list of copies.values()) {
		const [{ filter }] = list;
		if (list.length !== sheets.length || list.some((c) => c.shown)) continue;
		if (filter.kind !== 'categorical' || filter.all || !/^\[[^\]]+\]\.\[none:/.test(filter.pillId ?? '')) continue;
		const members = JSON.stringify({ include: filter.include ?? null, exclude: filter.exclude ?? null });
		if (!(filter.include?.length || filter.exclude?.length)) continue;
		if (list.some((c) => JSON.stringify({ include: c.filter.include ?? null, exclude: c.filter.exclude ?? null }) !== members)) continue;
		out.push(filter);
	}
	return out;
}

const literal = (v) => (v === true ? "'true'" : v === false ? "'false'" : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/**
 * A fixed categorical filter as a Magic ETL filter condition over the joined columns, or undefined when its field
 * cannot be translated row by row.
 * @param {import('../model/types.js').FilterIR} filter
 * @param {import('../model/types.js').DatasourceIR} ds
 * @param {Record<string, string>} fieldMap  Tableau field id -> joined Domo column
 * @returns {{ expression: string, field: string }|undefined}
 */
export function fixedFilterCondition(filter, ds, fieldMap) {
	const lookup = fieldLookup(ds);
	const field = lookup(filter.fieldId);
	if (!field) return undefined;
	const resolveField = (id) => {
		const f = lookup(id);
		if (!f) return undefined;
		if (f.kind === 'calculated' && f.formula) return { kind: 'calc', field: f };
		const column = fieldMap[f.id];
		return column ? { kind: 'column', column, datatype: f.datatype } : undefined;
	};
	let expr;
	if (field.kind === 'calculated') {
		if (!field.formula) return undefined;
		const t = translateEtl(field.formula, { resolveField, field, datasourceId: ds.id });
		if (t.status !== 'ok' || t.aggregated || (t.issues ?? []).some((i) => i.severity === 'error')) return undefined;
		expr = `(${t.expression})`;
	} else {
		const column = fieldMap[field.id];
		if (!column) return undefined;
		expr = `\`${column.replace(/`/g, '``')}\``;
	}
	const values = filter.include?.length ? filter.include : filter.exclude;
	const named = values.filter((v) => v !== null && v !== undefined);
	const hasNull = named.length !== values.length;
	const list = named.length ? `${expr} IN (${named.map(literal).join(', ')})` : '';
	const expression = filter.include?.length
		? [list, hasNull ? `${expr} IS NULL` : ''].filter(Boolean).join(' OR ')
		: [hasNull ? `${expr} IS NOT NULL` : '', named.length ? `(${expr} IS NULL OR NOT ${list})` : ''].filter(Boolean).join(' AND ');
	return { expression, field: field.name ?? filter.fieldId };
}
