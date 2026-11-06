const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const PARTS = {
	weekday: { label: 'Weekday', fn: 'DATENAME', datatype: 'string', value: (v) => WEEKDAYS[Number(v) - 1] },
	month: { label: 'Month', fn: 'DATENAME', datatype: 'string', value: (v) => MONTHS[Number(v) - 1] },
	quarter: { label: 'Quarter', fn: 'DATEPART', datatype: 'integer' },
	year: { label: 'Year', fn: 'DATEPART', datatype: 'integer' },
	week: { label: 'Week', fn: 'DATEPART', datatype: 'integer' },
	day: { label: 'Day', fn: 'DATEPART', datatype: 'integer' }
};

const bare = (id) => String(id).replace(/^\[|\]$/g, '');

/**
 * A filter control on a discrete date part (Weekday of Order Date) as a control on a calculated field holding that part,
 * so it gets a Beast Mode, a filter card and a quick filter of its own instead of filtering the whole date. Tableau's
 * part numbers become the field's members (weekday 1 = Sunday). Only filters a filter card or a window shows. Pure.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @returns {import('../model/types.js').WorkbookIR}
 */
export function withDatePartFilterFields(ir) {
	const shown = new Map();
	for (const d of ir.dashboards ?? []) for (const z of [...(d.zones ?? []), ...(d.floating ?? [])]) if (z.kind === 'filter' && z.worksheet && z.param) shown.set(`${z.worksheet}\u0000${z.param}`, true);
	for (const ws of ir.worksheets ?? []) {
		for (const q of ws.quickFilters ?? []) shown.set(`${ws.name}\u0000${q.pillId}`, true);
		for (const c of ws.windowCards ?? []) if (c.kind === 'filter') shown.set(`${ws.name}\u0000${c.param}`, true);
	}
	const added = new Map();
	const renamed = new Map();
	const worksheets = (ir.worksheets ?? []).map((ws) => {
		let changed = false;
		const pills = { ...(ws.pills ?? {}) };
		const filters = (ws.filters ?? []).map((f) => {
			const pill = ws.pills?.[f.pillId];
			const part = PARTS[pill?.datePart];
			if (!part || f.kind !== 'categorical' || !shown.has(`${ws.name}\u0000${f.pillId}`)) return f;
			const ds = (ir.datasources ?? []).find((d) => d.id === f.datasourceId);
			const field = ds?.fields?.find((x) => x.id === f.fieldId);
			if (!field) return f;
			const id = `[t2d_${pill.datePart}_${bare(f.fieldId).replace(/[^A-Za-z0-9_]/g, '_')}]`;
			if (!added.has(`${f.datasourceId}\u0000${id}`)) {
				const name = `${part.label} of ${String(field.caption ?? field.name ?? bare(f.fieldId)).trim()}`;
				const unit = pill.datePart === 'weekday' ? 'weekday' : pill.datePart;
				added.set(`${f.datasourceId}\u0000${id}`, {
					datasourceId: f.datasourceId,
					field: { id, name, caption: name, datatype: part.datatype, role: 'dimension', type: 'ordinal', kind: 'calculated', formula: `${part.fn}('${unit}', [${bare(f.fieldId)}])`, ...(field.fiscalYearStart ? { fiscalYearStart: field.fiscalYearStart } : {}) }
				});
			}
			const pillId = `[${f.datasourceId}].[none:${bare(id)}:${part.datatype === 'string' ? 'nk' : 'ok'}]`;
			pills[pillId] = { id: pillId, datasourceId: f.datasourceId, fieldId: id, derivation: 'None', prefix: 'none', typeKey: part.datatype === 'string' ? 'nk' : 'ok', continuous: false, aggregated: false, datePart: null, dateTrunc: null };
			renamed.set(`${ws.name}\u0000${f.pillId}`, pillId);
			changed = true;
			const map = (list) => list?.map((v) => (v === null || v === undefined ? v : part.value ? part.value(v) ?? v : v));
			return { ...f, pillId, fieldId: id, ...(f.include ? { include: map(f.include) } : {}), ...(f.exclude ? { exclude: map(f.exclude) } : {}) };
		});
		if (!changed) return ws;
		const swap = (pillId) => renamed.get(`${ws.name}\u0000${pillId}`) ?? pillId;
		const filterTitles = ws.filterTitles ? Object.fromEntries(Object.entries(ws.filterTitles).map(([k, v]) => [swap(k), v])) : undefined;
		return {
			...ws,
			pills,
			filters,
			...(ws.quickFilters ? { quickFilters: ws.quickFilters.map((q) => ({ ...q, pillId: swap(q.pillId) })) } : {}),
			...(ws.windowCards ? { windowCards: ws.windowCards.map((c) => (c.kind === 'filter' ? { ...c, param: swap(c.param) } : c)) } : {}),
			...(filterTitles ? { filterTitles } : {})
		};
	});
	if (!renamed.size) return ir;
	const datasources = (ir.datasources ?? []).map((ds) => {
		const extra = [...added.values()].filter((a) => a.datasourceId === ds.id).map((a) => a.field);
		return extra.length ? { ...ds, fields: [...(ds.fields ?? []), ...extra] } : ds;
	});
	const dashboards = (ir.dashboards ?? []).map((d) => {
		const swap = (z) => (z.kind === 'filter' && renamed.has(`${z.worksheet}\u0000${z.param}`) ? { ...z, param: renamed.get(`${z.worksheet}\u0000${z.param}`) } : z);
		return { ...d, zones: (d.zones ?? []).map(swap), floating: (d.floating ?? []).map(swap) };
	});
	return { ...ir, datasources, worksheets, dashboards };
}
