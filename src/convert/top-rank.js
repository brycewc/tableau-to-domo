import { pillFor } from './chart-types.js';

const NOT_DIMENSIONS = /^\[:Measure (Names|Values)\]$/;

/** Other filters a Top N member rank must not see: active (or shown) non-context filters of its sheet. */
function otherFilters(ws, top) {
	return (ws.filters ?? []).filter((f) => f !== top && !f.context && !f.hidden && !NOT_DIMENSIONS.test(f.fieldId ?? '') && (!f.all || f.shownOnDashboard));
}

/**
 * Why a Top N on a dimension cannot be a card row limit: Tableau ranks the members before the sheet's dimension and
 * measure filters (only context and datasource filters come first), and a limit counts rows, not members.
 * @returns {'dimension'|'filter'|undefined}
 */
export function topRankReason(ws, top, actions = []) {
	const ids = [...(ws.rowPills ?? []), ...(ws.colPills ?? []), ...(ws.panes ?? []).flatMap((p) => Object.values(p.encodings ?? {}).flat())];
	const dimension = ids.some((id) => {
		const pill = pillFor(ws, id);
		return pill.datasourceId !== 'Parameters' && !pill.aggregated && !pill.tableCalc && !NOT_DIMENSIONS.test(pill.fieldId ?? '') && pill.fieldId !== top.fieldId;
	});
	if (dimension) return 'dimension';
	const filtered = otherFilters(ws, top).length || actions.some((a) => a.type === 'filter' && (a.target?.worksheets ?? []).includes(ws.name));
	return filtered ? 'filter' : undefined;
}
