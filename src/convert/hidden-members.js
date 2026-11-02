import { markPanes, pillFor } from './chart-types.js';
import { tableCalcAddressing } from './calc/tablecalc.js';

const sameField = (pill, filter) => pill.fieldId === filter.fieldId && (!filter.datasourceId || !pill.datasourceId || pill.datasourceId === filter.datasourceId);

/**
 * Where a Hide (filter kind='hide') applies. Hide drops marks, not rows: a dimension in every pane's level of detail
 * (a shelf, or each pane's own encodings) drops the same marks as a row filter would; one only some panes encode hides
 * those panes' marks and leaves the others' aggregates whole.
 * @returns {{ scope: 'rows' } | { scope: 'panes', measures: string[] }}
 */
export function hiddenScope(ws, filter) {
	const shelf = [...(ws.rowPills ?? []), ...(ws.colPills ?? [])].map((id) => pillFor(ws, id));
	if (shelf.some((p) => sameField(p, filter))) return { scope: 'rows' };
	const panes = markPanes(ws);
	const encodes = (pane) => Object.values(pane.encodings ?? {}).flat().some((id) => sameField(pillFor(ws, id), filter));
	const hiding = panes.filter(encodes);
	if (!hiding.length || hiding.length === panes.length) return { scope: 'rows' };
	const measures = hiding.map((p) => p.yAxisPill ?? p.xAxisPill);
	if (measures.some((m) => !m)) return { scope: 'rows' };
	return { scope: 'panes', measures: [...new Set(measures)] };
}

/** A table calculation running along the hidden dimension, which Tableau computes before Hide removes marks. */
export function tableCalcAlong(ws, filter) {
	return Object.entries(ws.pills ?? {}).some(([id, pill]) => {
		if (!pill.tableCalc) return false;
		const { orderBy } = tableCalcAddressing(ws, id, (pillId) => ({ column: pillId }));
		return orderBy.some((o) => o.column && sameField(pillFor(ws, o.column), filter));
	});
}
