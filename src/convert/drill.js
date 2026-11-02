import { stripBrackets } from '../model/naming.js';
import { parsePillId } from '../tableau/twb/shelf.js';
import { findField, pillFor } from './chart-types.js';

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../model/types.js').CardPlan} CardPlan
 * @typedef {import('../model/types.js').DrillViewPlan} DrillViewPlan
 * @typedef {import('../model/types.js').Issue} Issue
 */

const CHART_FAMILIES = new Set(['bar', 'line', 'area', 'combo', 'pie', 'treemap']);
const TABLE_FAMILIES = new Set(['table', 'crosstab', 'pivot']);
const CHART_MAPPINGS = ['ITEM', 'SERIES'];
const TRUNC_PREFIXES = { year: 'tyr', quarter: 'tqr', month: 'tmn', day: 'tdy' };
const PART_PREFIXES = { quarter: 'qr', month: 'mn', day: 'dy' };
const DATE_LEVELS = ['year', 'quarter', 'month', 'day'];
const GRAIN_LABELS = { year: 'Year', quarter: 'Quarter', month: 'Month', day: 'Day' };

/** Table-type charts (basic, pivot, mega and any other table) never offer Domo's table drill. */
export const isTableChart = (chartType) => /table/i.test(String(chartType ?? ''));

function drillKind(chartType, family) {
	if (chartType === 'badge_pivot_table') return 'pivot';
	if (isTableChart(chartType) || TABLE_FAMILIES.has(family)) return 'table';
	if (family === 'map') return 'map';
	return CHART_FAMILIES.has(family) ? 'chart' : undefined;
}

function hierarchiesFor(ir, datasourceId) {
	const ds = (ir?.datasources ?? []).find((d) => d.id === datasourceId);
	if (ds?.hierarchies?.length) return ds.hierarchies;
	const primary = ds?.blend?.primary && (ir.datasources ?? []).find((d) => d.id === ds.blend.primary);
	return primary?.hierarchies ?? [];
}

const isDimension = (pill) => !pill.aggregated && !pill.tableCalc && String(pill.derivation ?? 'None').toLowerCase() === 'none';

/**
 * Slots a click drills from, in priority order: a chart's axis then series, a map's region, any table column, a pivot's
 * column headers. A pivot cell or row header click filters by the column header only (Phoenix TCell.getColumnDrillFilter;
 * a row header gives "<column> in <column>", VERIFIED LIVE), so a pivot does not drill from its rows.
 */
function dimensionSlots(ws, slots, kind) {
	const dims = slots.filter((s) => !s.derived).map((slot) => ({ slot, pill: pillFor(ws, slot.pillId) }));
	if (kind === 'table') return dims;
	if (kind === 'pivot') return dims.filter((d) => d.slot.mapping === 'COLUMN');
	return CHART_MAPPINGS.flatMap((mapping) => dims.filter((d) => d.slot.mapping === mapping));
}

/**
 * The card dimension a Tableau hierarchy drills from: the deepest hierarchy level the card shows where a click lands
 * (chart axis or series, map region, table column). `levels` are the hierarchy fields below it.
 * @returns {{ pillId: string, datasourceId: string, hierarchy: { name: string, fields: string[] }, levels: { fieldId: string }[] } | { skipped: string, hierarchy: { name: string } } | undefined}
 */
export function drillSource(ws, ir, slots, kind = 'chart') {
	const all = slots.filter((s) => !s.derived).map((slot) => ({ slot, pill: pillFor(ws, slot.pillId) })).filter((d) => isDimension(d.pill));
	const clickable = new Set(dimensionSlots(ws, slots, kind).map((d) => d.slot));
	for (const { pill } of dimensionSlots(ws, slots, kind).filter((d) => isDimension(d.pill))) {
		const hierarchy = hierarchiesFor(ir, pill.datasourceId).find((h) => h.fields.includes(pill.fieldId));
		if (!hierarchy) continue;
		const level = (d) => hierarchy.fields.indexOf(d.pill.fieldId);
		const deepest = all.filter((d) => d.pill.datasourceId === pill.datasourceId && level(d) >= 0).reduce((a, b) => (level(b) > level(a) ? b : a));
		if (!clickable.has(deepest.slot)) return { skipped: `its deepest shown level ${stripBrackets(deepest.pill.fieldId)} is not on the axis or series`, hierarchy };
		return { pillId: deepest.slot.pillId, datasourceId: pill.datasourceId, hierarchy, levels: hierarchy.fields.slice(level(deepest) + 1).map((fieldId) => ({ fieldId })) };
	}
	return undefined;
}

/**
 * Tableau's implicit date drill from a chart's axis or series date pill: Year > Quarter > Month > Day from where the pill
 * starts, week pills to Day, day and finer pills none. Truncations (and a discrete Year, a Domo date grain) drill by
 * date grain; discrete Quarter or Month parts drill by the next date part.
 */
export function dateDrillSource(ws, slots) {
	for (const { slot, pill } of dimensionSlots(ws, slots, 'chart')) {
		if (pill.aggregated || pill.tableCalc) continue;
		const grain = pill.dateTrunc ?? pill.datePart;
		if (!grain) continue;
		const byGrain = Boolean(pill.dateTrunc) || grain === 'year' || grain === 'week';
		const start = grain === 'week' ? DATE_LEVELS.indexOf('month') : DATE_LEVELS.indexOf(grain);
		if (start < 0) return undefined;
		const typeKey = pill.continuous ? 'qk' : 'ok';
		const levels = DATE_LEVELS.slice(start + 1).map((g) => ({ fieldId: pill.fieldId, grain: g, prefix: byGrain ? TRUNC_PREFIXES[g] : PART_PREFIXES[g], typeKey }));
		return { pillId: slot.pillId, datasourceId: pill.datasourceId, date: true, levels };
	}
	return undefined;
}

/** Hierarchy members among the card's dimension slots, so a chart that cannot drill can say so. */
function hierarchyOnCard(ws, ir, slots) {
	for (const slot of slots) {
		const pill = pillFor(ws, slot.pillId);
		if (!isDimension(pill)) continue;
		const hierarchy = hierarchiesFor(ir, pill.datasourceId).find((h) => h.fields.includes(pill.fieldId));
		if (hierarchy && hierarchy.fields.indexOf(pill.fieldId) < hierarchy.fields.length - 1) return hierarchy;
	}
	return undefined;
}

const PILL_KEYED = new Set(['numberFormats', 'paneColors']);

/**
 * A copy of the worksheet with one dimension pill replaced by a pill of another field (or the same date field at
 * another derivation) of its datasource. Filters keep the old pill: they still filter the level above. A manual sort or
 * member colors of the old pill do not fit the new one and are dropped.
 * @param {WorksheetIR} ws
 * @param {string} pillId
 * @param {string} fieldId
 * @param {{ prefix?: string, typeKey?: string }} [derivation]  Default a plain discrete dimension ('none', 'nk')
 * @returns {WorksheetIR}
 */
export function swapPill(ws, pillId, fieldId, { prefix = 'none', typeKey = 'nk' } = {}) {
	const old = pillFor(ws, pillId);
	const nextId = `[${old.datasourceId}].[${prefix}:${stripBrackets(fieldId)}:${typeKey}]`;
	const walk = (v, key) => {
		if (v === pillId) return nextId;
		if (Array.isArray(v)) return v.map((x) => walk(x));
		if (!v || typeof v !== 'object') return v;
		const out = {};
		for (const [k, x] of Object.entries(v)) out[PILL_KEYED.has(key) && k === pillId ? nextId : k] = walk(x, k);
		return out;
	};
	const { filters, pills, ...rest } = ws;
	const next = walk(rest);
	next.filters = structuredClone(filters ?? []);
	next.pills = { ...structuredClone(pills ?? {}), [nextId]: pills?.[nextId] ?? { ...parsePillId(nextId, { column: fieldId }), datasourceId: old.datasourceId } };
	next.sorts = (next.sorts ?? []).filter((s) => !(s.pillId === nextId && s.kind === 'manual'));
	if (next.color?.pillId === nextId) delete next.color.members;
	return next;
}

function viewTitle(rootTitle, titleItems, caption) {
	const suffix = rootTitle ? `: ${caption}` : caption;
	const items = rootTitle ? [...(titleItems ?? [{ type: 'TEXT', text: rootTitle }])] : [];
	const last = items.at(-1);
	if (last?.type === 'TEXT') items[items.length - 1] = { ...last, text: `${last.text}${suffix}` };
	else items.push({ type: 'TEXT', text: suffix });
	return { title: `${rootTitle}${suffix}`, items };
}

function drillBody(body, title, items) {
	const out = structuredClone(body);
	const def = out.definition;
	def.title = title;
	def.dynamicTitle = { text: items };
	def.controls = [];
	def.allowTableDrill = false;
	const main = def.subscriptions.main;
	main.filters = [];
	delete main.limit;
	delete main.dateRangeFilter;
	return out;
}

/**
 * Drill views for a card whose clicked dimension is a Tableau hierarchy level, or, on a chart without one, a date pill
 * coarser than Day (Tableau's implicit date drill): one view per deeper level, each the card planned again with that
 * dimension swapped for the level. Charts, maps and tables drill (a map level without a Domo map becomes what planCard
 * picks, usually a table); Domo filters a drill view by the clicked mark or cell. `planView` is cards.js planCard.
 *
 * @param {WorksheetIR} ws
 * @param {WorkbookIR} ir
 * @param {CardPlan} card
 * @param {{ slots: { pillId: string, mapping: string, derived?: Object }[], family: string, bindings: import('../model/types.js').FieldBindings, planView: (ws: WorksheetIR) => { card: CardPlan } }} ctx
 * @returns {{ drillPath: DrillViewPlan[], issues: Issue[] }}
 */
export function planDrillPath(ws, ir, card, { slots, family, bindings, planView }) {
	const object = { type: 'worksheet', name: ws.name };
	const issue = (severity, code, message) => ({ severity, code, message, object });
	if (card.status === 'unsupported') return { drillPath: [], issues: [] };
	const kind = drillKind(card.chartType, family);
	const onCard = hierarchyOnCard(ws, ir, slots);
	if (!kind) {
		return { drillPath: [], issues: onCard ? [issue('info', 'card.drill-chart', `Hierarchy "${onCard.name}" on ${ws.name} has no Domo drill path: the card is a ${family} chart, which t2d does not drill`)] : [] };
	}
	const hierarchySource = onCard ? drillSource(ws, ir, slots, kind) : undefined;
	if (onCard && !hierarchySource && kind === 'pivot') {
		return { drillPath: [], issues: [issue('info', 'card.drill-chart', `Hierarchy "${onCard.name}" on ${ws.name} has no Domo drill path: it is on the pivot's rows, and a Domo pivot click filters by its column headers only`)] };
	}
	const source = hierarchySource ?? (kind === 'chart' ? dateDrillSource(ws, slots) : undefined);
	if (!source) return { drillPath: [], issues: [] };
	const name = source.date ? 'Date' : `Hierarchy "${source.hierarchy.name}"`;
	if (card.split) return { drillPath: [], issues: [issue('info', 'card.drill-chart', `${name} on ${ws.name} has no Domo drill path: the card is split into one card per pane`)] };
	if (source.skipped) return { drillPath: [], issues: [issue('info', 'card.drill-unmapped', `${name} on ${ws.name} has no Domo drill path: ${source.skipped}`)] };
	if (!source.levels.length) return { drillPath: [], issues: [] };

	const drillPath = [];
	const captions = [];
	const issues = [];
	for (const level of source.levels) {
		const fieldCaption = findField(ir, source.datasourceId, level.fieldId)?.caption || stripBrackets(level.fieldId);
		const caption = level.grain ? `${fieldCaption} (${GRAIN_LABELS[level.grain]})` : fieldCaption;
		const stop = (why) => issues.push(issue('warning', 'card.drill-unmapped', `${name} on ${ws.name} drills ${drillPath.length} level(s); ${caption} and below are left out: ${why}`));
		if (!bindings?.get?.(source.datasourceId, level.fieldId)) {
			stop('the field has no Domo column');
			break;
		}
		let view;
		try {
			view = planView(swapPill(ws, source.pillId, level.fieldId, level)).card;
		} catch (err) {
			stop(err.message);
			break;
		}
		if (view.status === 'unsupported' || !view.body?.definition?.subscriptions?.main?.columns?.length) {
			stop('the drill view could not be converted');
			break;
		}
		const { title, items } = viewTitle(card.title, card.body?.definition?.dynamicTitle?.text, caption);
		const plan = { title, chartType: view.chartType, field: level.fieldId, ...(level.grain ? { grain: level.grain } : {}), hierarchy: source.date ? '' : source.hierarchy.name, body: drillBody(view.body, title, items), ...(view.fiscalCalendar ? { fiscalCalendar: view.fiscalCalendar } : {}) };
		drillPath.push(plan);
		captions.push(caption);
	}
	if (drillPath.length) {
		card.body.definition.allowTableDrill = false;
		issues.unshift(issue('info', source.date ? 'card.drill-date' : 'card.drill-path', `${name} on ${ws.name} became a Domo drill path of ${drillPath.length} level(s): ${captions.join(', ')}`));
	}
	return { drillPath, issues };
}

const DRILL_INTERACTION = { type: 'DRILL', config: { openInNewWindow: false } };

/**
 * A layout card item clicks through its default interaction, which filters the other cards, so a card with a drill
 * path gets the DRILL interaction (the viewer then drills in place). A card whose click carries a Tableau action on that
 * dashboard keeps it; the drill is then in the card's details only (`card.drill-action`).
 * @param {import('../model/types.js').PagePlan[]} pages
 * @param {CardPlan[]} cards
 * @param {WorkbookIR} ir
 * @returns {Issue[]}
 */
export function applyDrillInteractions(pages, cards, ir) {
	const drilled = new Map(cards.filter((c) => c.drillPath?.length).map((c) => [`card:${c.key}`, c]));
	if (!drilled.size) return [];
	const issues = [];
	for (const page of pages) {
		const clicked = new Set(
			(ir?.actions ?? [])
				.filter((a) => (a.type === 'filter' || a.type === 'highlight') && (!a.source?.dashboard || a.source.dashboard === page.dashboard))
				.flatMap((a) => a.source?.worksheets ?? (a.source?.worksheet ? [a.source.worksheet] : []))
		);
		for (const item of page.layout?.content ?? []) {
			const card = item.type === 'CARD' && drilled.get(item.cardId?.$ref);
			if (!card) continue;
			if (!item.interaction && !clicked.has(card.worksheet)) {
				item.interaction = structuredClone(DRILL_INTERACTION);
				continue;
			}
			if (item.interaction?.type === 'DRILL') continue;
			issues.push({
				severity: 'info',
				code: 'card.drill-action',
				message: `Card "${card.title}" on ${page.title} runs its Tableau click action when clicked; its drill path opens from the card's details`,
				object: { type: 'worksheet', name: card.worksheet }
			});
		}
	}
	return issues;
}
