import { parsePillId } from '../tableau/twb/shelf.js';
import { stripBrackets } from '../model/naming.js';
import { quickCalcType, tableCalcAddressing } from './calc/tablecalc.js';

/**
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').PillIR} PillIR
 * @typedef {import('../model/types.js').FieldIR} FieldIR
 * @typedef {import('../model/types.js').FieldBindings} FieldBindings
 * @typedef {import('../model/types.js').Issue} Issue
 *
 * @typedef {'dimension'|'date'|'measure'|'geo'|'latlong'|'measure-names'|'measure-values'} PillKind
 *
 * @typedef {Object} ClassifiedPill
 * @property {string} pillId
 * @property {PillIR} pill
 * @property {FieldIR} [field]
 * @property {PillKind} kind
 * @property {string} [geoRole]   state | county | country | city | zip | lat | lon | other
 * @property {boolean} [generated] Tableau-generated Latitude/Longitude (no data behind it)
 * @property {boolean} [bin]
 *
 * @typedef {Object} SlotMapping
 * @property {string} pillId
 * @property {string} mapping                 Domo column mapping (ITEM, VALUE, SERIES, ...)
 * @property {'dim'|'measure'|'raw'} role     raw = plotted row by row, never aggregated
 * @property {string} [aggregation]           Forces this aggregation (e.g. COUNT for a map without a measure)
 * @property {string} [dateTrunc]             Overrides the pill's date handling with this truncation grain
 * @property {boolean} [rawDate]              Date used as an exact value (no calendar grain)
 * @property {boolean} [useBinSource]         Use the bin field's source column instead of the bin
 * @property {{ type: 'date-add', sizePillId?: string }|{ type: 'concat', pillIds: string[] }} [derived]  concat: one category of
 *   several axis levels (a card beast mode); `pillId` is the outer level
 *
 * @typedef {Object} ChartInference
 * @property {string} chartType
 * @property {SlotMapping[]} mappings
 * @property {string[]} detail                Dimension pill ids that only change granularity (groupBy)
 * @property {string[]} [sortOnly]            Dimensions grouped and sorted but not a column (a table's hidden header, a hidden category level)
 * @property {string[]} [keptHeaders]         Hidden headers a flat table shows as columns, sorted ascending as Tableau lists them
 * @property {{ pillId: string }} [split]     Small multiples drawn as one card per member of this dimension
 * @property {{ pillId: string, members: Array<string|number>, measure: string }} [spread]  crosstab column header written as one value column per member
 * @property {{ pillIds: string[] }} [heatmap]  Mega Table value columns colored as heatmap columns (the color measure's)
 * @property {Issue[]} warnings
 * @property {string} family                  bar | line | area | combo | pie | scatter | map | table | pivot | crosstab | kpi | treemap | heatmap | gantt | histogram | fallback
 * @property {string} mark                    Resolved Tableau mark class
 */

const MEASURE_SLOTS = new Set(['VALUE', 'BUBBLESIZE', 'TARGET', 'EXTRAINFO1', 'EXTRAINFO2', 'EXTRAINFO3', 'COLOR', 'MIN', 'MAX']);
const KPI_TYPES = new Set(['badge_singlevalue', 'badge_multi_value']);
const FILLED_MAPS = { state: 'badge_map_us_state', county: 'badge_map_us_county', country: 'badge_world_map' };
const GENERATED_LATLONG = /^\[(Latitude|Longitude) \(generated\)\]$/i;
const POLYGON_MARKS = new Set(['Map', 'Polygon', 'Multipolygon', 'Filled Map']);
const DENSITY_MARKS = new Set(['Heatmap', 'Density']);
const DATE_PART_ORDER = ['year', 'quarter', 'month', 'week', 'day'];

export { MEASURE_SLOTS, KPI_TYPES };

/**
 * Find a field by datasource and field id.
 * @param {WorkbookIR} ir
 * @param {string} datasourceId
 * @param {string} fieldId
 * @returns {FieldIR|undefined}
 */
export function findField(ir, datasourceId, fieldId) {
	const sources = ir?.datasources ?? [];
	const ds = sources.find((d) => d.id === datasourceId);
	const hit = ds?.fields?.find((f) => f.id === fieldId);
	if (hit || datasourceId) return hit;
	for (const d of sources) {
		const f = d.fields?.find((x) => x.id === fieldId);
		if (f) return f;
	}
	return undefined;
}

/**
 * The pill for an id, from the worksheet when present, else parsed from the id.
 * @param {WorksheetIR} ws
 * @param {string} pillId
 * @returns {PillIR}
 */
export function pillFor(ws, pillId) {
	const pill = ws?.pills?.[pillId] ?? parsePillId(pillId);
	if (!pill.datasourceId && ws?.datasourceIds?.length) return { ...pill, datasourceId: ws.datasourceIds[0] };
	return pill;
}

function geoRoleOf(field, fieldId) {
	if (GENERATED_LATLONG.test(fieldId)) return /^\[Lat/i.test(fieldId) ? 'lat' : 'lon';
	const role = String(field?.semanticRole ?? '');
	if (!role) return undefined;
	const head = (/^\[([^\]]+)\]/.exec(role)?.[1] ?? role).toLowerCase();
	const tail = (/\.\[([^\]]+)\]$/.exec(role)?.[1] ?? '').toLowerCase();
	if (head === 'geographical' && tail === 'latitude') return 'lat';
	if (head === 'geographical' && tail === 'longitude') return 'lon';
	if (head === 'state' || head === 'province') return 'state';
	if (head === 'county') return 'county';
	if (head === 'country') return 'country';
	if (head === 'city') return 'city';
	if (head === 'zipcode' || head === 'zip code' || head === 'postal code') return 'zip';
	return 'other';
}

const isDateType = (t) => t === 'date' || t === 'datetime';
const isNumericType = (t) => t === 'integer' || t === 'real';

/**
 * Classify a pill: measure, discrete/continuous date, dimension, geographic role, generated lat/long.
 * @param {WorksheetIR} ws
 * @param {WorkbookIR} ir
 * @param {string} pillId
 * @returns {ClassifiedPill}
 */
export function classifyPill(ws, ir, pillId) {
	const pill = pillFor(ws, pillId);
	const fieldId = pill.fieldId ?? '';
	if (/Measure Names/i.test(fieldId)) return { pillId, pill, kind: 'measure-names' };
	if (fieldId === '[Multiple Values]' || /^:?Measure Values$/i.test(stripBrackets(fieldId))) return { pillId, pill, kind: 'measure-values' };
	const field = findField(ir, pill.datasourceId, fieldId);
	const geoRole = geoRoleOf(field, fieldId);
	const base = { pillId, pill, field };
	if (GENERATED_LATLONG.test(fieldId)) return { ...base, kind: 'latlong', geoRole, generated: true };
	if (geoRole === 'lat' || geoRole === 'lon') return { ...base, kind: 'latlong', geoRole, generated: false };
	const derivation = String(pill.derivation ?? 'None');
	const isAttr = /^attr/i.test(derivation);
	if (pill.aggregated && !isAttr) return { ...base, kind: 'measure' };
	if (pill.datePart || pill.dateTrunc) return { ...base, kind: 'date' };
	const datatype = field?.datatype;
	if (isDateType(datatype)) return { ...base, kind: 'date' };
	if (geoRole) return { ...base, kind: 'geo', geoRole, bin: field?.kind === 'bin' };
	const measureRole = field?.role === 'measure' || (!field && pill.continuous);
	if (!isAttr && measureRole && pill.continuous && ws?.aggregated === false && (isNumericType(datatype) || !field)) {
		return { ...base, kind: 'measure' };
	}
	return { ...base, kind: 'dimension', bin: field?.kind === 'bin' };
}

const isDim = (c) => c.kind === 'dimension' || c.kind === 'date' || c.kind === 'geo';

/** An aggregate pill set to discrete (MIN([Group]):nk, an aggregate string calc) draws headers, not an axis. */
const isDiscreteAggregate = (c) => c.kind === 'measure' && c.pill.aggregated && c.pill.continuous === false && (c.pill.typeKey === 'nk' || c.pill.typeKey === 'ok');

const isContinuousAxisDim = (c) => isDim(c) && c.kind !== 'date' && c.pill.continuous === true;

function issue(ws, severity, code, message, suggestion) {
	const out = { severity, code, message, object: { type: 'worksheet', name: ws.name } };
	if (suggestion) out.suggestion = suggestion;
	return out;
}

function uniq(ids) {
	return [...new Set(ids.filter(Boolean))];
}

/**
 * Expand Measure Values pills into the measures they stand for and drop Measure Names. On rows and columns a
 * discrete aggregate draws headers (`discreteAggregates`); on a mark encoding (`headers: false`) it is a measure.
 * @returns {{ items: ClassifiedPill[], measureNames: boolean, measureValues: boolean }}
 */
function expandShelf(ws, ir, pillIds, { headers = true } = {}) {
	const items = [];
	const discreteAggregates = [];
	let measureNames = false;
	let measureValues = false;
	for (const id of pillIds) {
		const c = classifyPill(ws, ir, id);
		if (c.kind === 'measure-names') {
			measureNames = true;
			continue;
		}
		if (c.kind === 'measure-values') {
			measureValues = true;
			for (const mv of ws.measureValues ?? []) {
				const m = classifyPill(ws, ir, mv);
				items.push(m.kind === 'dimension' ? { ...m, kind: 'measure' } : m);
			}
			continue;
		}
		if (headers && isDiscreteAggregate(c)) discreteAggregates.push(c);
		else items.push(c);
	}
	return { items, discreteAggregates, measureNames, measureValues };
}

function analyze(ws, ir) {
	const rows = expandShelf(ws, ir, ws.rowPills ?? []);
	const cols = expandShelf(ws, ir, ws.colPills ?? []);
	const panes = ws.panes?.length ? ws.panes : [{ markClass: 'Automatic', encodings: {} }];
	const enc = {};
	for (const pane of panes) {
		for (const [key, ids] of Object.entries(pane.encodings ?? {})) {
			enc[key] = uniq([...(enc[key] ?? []), ...(ids ?? [])]);
		}
	}
	const encItems = {};
	let measureValuesOnMarks = false;
	for (const [key, ids] of Object.entries(enc)) {
		const expanded = expandShelf(ws, ir, ids, { headers: false });
		if (expanded.measureValues) measureValuesOnMarks = true;
		encItems[key] = expanded.items;
	}
	const get = (key) => encItems[key] ?? [];
	const rowMeasures = rows.items.filter((c) => c.kind === 'measure');
	const colMeasures = cols.items.filter((c) => c.kind === 'measure');
	const rowDims = rows.items.filter(isDim);
	const colDims = cols.items.filter(isDim);
	const latlong = [...rows.items, ...cols.items].filter((c) => c.kind === 'latlong');
	const discreteAggregates = [...rows.discreteAggregates, ...cols.discreteAggregates];
	return {
		discreteAggregates,
		ws,
		rows,
		cols,
		panes,
		enc: encItems,
		get,
		rowMeasures,
		colMeasures,
		rowDims,
		colDims,
		latlong,
		measureValuesOnMarks,
		measureNames: rows.measureNames || cols.measureNames || (enc.color ?? []).some((id) => /Measure Names/.test(id))
	};
}

/** Tableau's Automatic mark, from its documented defaults. */
function resolveAutomatic(a) {
	const geoOnMarks = ['detail', 'color', 'label', 'text', 'tooltip'].some((k) => a.get(k).some((c) => c.kind === 'geo'));
	if (a.latlong.length || a.get('geometry').length) {
		const geo = findGeo(a);
		if (a.get('geometry').length || (geo && FILLED_MAPS[geo.geoRole])) return 'Map';
		return 'Circle';
	}
	if (geoOnMarks && !a.rowMeasures.length && !a.colMeasures.length && !a.rowDims.length && !a.colDims.length) return 'Map';
	if (a.rowMeasures.length && a.colMeasures.length) return 'Circle';
	if (!a.rowMeasures.length && !a.colMeasures.length && a.rowDims.some(isContinuousAxisDim) && a.colDims.some(isContinuousAxisDim)) return 'Circle';
	const rowDate = a.rowDims.some((c) => c.kind === 'date');
	const colDate = a.colDims.some((c) => c.kind === 'date');
	if ((colDate && a.rowMeasures.length && !a.colMeasures.length) || (rowDate && a.colMeasures.length && !a.rowMeasures.length)) return 'Line';
	if (a.rowMeasures.length || a.colMeasures.length) return 'Bar';
	const colorOrSize = [...a.get('color'), ...a.get('size')].some((c) => c.kind === 'measure');
	if (a.rowDims.length && a.colDims.length && colorOrSize) return 'Square';
	return 'Text';
}

function findGeo(a) {
	const pools = [a.get('detail'), a.get('color'), a.get('label'), a.get('text'), a.rowDims, a.colDims, a.get('tooltip')];
	for (const pool of pools) {
		const hit = pool.find((c) => c.kind === 'geo');
		if (hit) return hit;
	}
	return undefined;
}

function axisPanes(a) {
	const tagged = a.panes.filter((p) => p.yAxisPill || p.xAxisPill);
	return tagged.length >= 2 ? tagged : null;
}

function resolveMark(a, pane) {
	const mark = pane?.markClass || 'Automatic';
	return mark === 'Automatic' ? resolveAutomatic(a) : mark;
}

/**
 * Pick a Domo chart type and slot assignment for a worksheet.
 *
 * @param {WorksheetIR} worksheet
 * @param {WorkbookIR} ir
 * @param {FieldBindings} [_bindings]  Reserved: slot choice does not depend on bindings today
 * @returns {ChartInference}
 */
export function inferChart(worksheet, ir, _bindings) {
	const a = analyze(worksheet, ir);
	const dual = axisPanes(a);
	const marks = dual ? uniq(dual.map((p) => resolveMark(a, p))) : [resolveMark(a, a.panes[0])];
	const mark = DENSITY_MARKS.has(marks[0]) ? 'Circle' : marks[0];
	const out = { warnings: [], detail: [], mappings: [], mark };
	const ctx = { a, ws: worksheet, ir, out };
	if (mark !== marks[0]) out.warnings.push(issue(worksheet, 'info', 'chart.density', 'Density mark drawn as circles; density shading is lost'));
	if (a.discreteAggregates.length && mark !== 'Text') {
		out.warnings.push(
			issue(worksheet, 'warning', 'chart.discrete-aggregate', `Discrete aggregate headers (${a.discreteAggregates.map(nameOf).join(', ')}) have no Domo chart equivalent and are left off the chart`)
		);
	}

	if (isHistogram(a, mark)) return finish(ctx, histogram(ctx));
	if (POLYGON_MARKS.has(mark) || ((mark === 'Circle' || mark === 'Shape') && a.latlong.length)) return finish(ctx, mapChart(ctx, mark));
	if (dual && marks.includes('Pie')) return finish(ctx, pie(ctx, true));
	if (marks.length > 1 && dual) {
		const barLine = marks.includes('Bar') && (marks.includes('Line') || marks.includes('Area'));
		if (barLine) return finish(ctx, axisChart(ctx, 'combo', dual));
		out.warnings.push(issue(worksheet, 'warning', 'chart.dual-axis', `Dual axis with marks ${marks.join(' + ')} is drawn with the first mark only`));
	}
	switch (mark) {
		case 'Bar':
			return finish(ctx, axisChart(ctx, 'bar'));
		case 'Line':
			return finish(ctx, axisChart(ctx, 'line'));
		case 'Area':
			return finish(ctx, axisChart(ctx, 'area'));
		case 'Pie':
			return finish(ctx, pie(ctx, false));
		case 'Text':
			return finish(ctx, textTable(ctx));
		case 'Square':
			return finish(ctx, square(ctx));
		case 'Circle':
		case 'Shape':
			return finish(ctx, circle(ctx));
		case 'GanttBar':
			return finish(ctx, gantt(ctx));
		default:
			return finish(ctx, fallback(ctx, `Mark type ${mark} has no Domo equivalent`));
	}
}

function finish(ctx, result) {
	const { out } = ctx;
	out.chartType = result.chartType;
	out.family = result.family;
	out.mappings = result.mappings;
	out.detail = uniq([...(result.detail ?? [])]);
	if (result.sortOnly?.length) out.sortOnly = result.sortOnly;
	if (result.keptHeaders?.length) out.keptHeaders = result.keptHeaders;
	if (result.spread) out.spread = result.spread;
	if (result.heatmap) out.heatmap = result.heatmap;
	if (result.overrides) out.overrides = result.overrides;
	return out;
}

const slot = (c, mapping, role, extra = {}) => ({ pillId: c.pillId, mapping, role, ...extra });

/** Same field and aggregation; `withCalc` also compares the quick table calc type. */
export function measureKey(pill, { withCalc = true } = {}) {
	const calc = withCalc && pill.tableCalc ? `|${pill.tableCalc.type}` : '';
	return `${pill.datasourceId ?? ''}|${pill.fieldId}|${String(pill.derivation ?? 'None').toLowerCase()}${calc}`;
}

export const isPctTotal = (pill) => !pill.tableCalc?.secondary && /pcto|pcttotal|pct ?total|percent ?of ?total/i.test(`${pill.tableCalc?.type ?? ''} ${pill.tableCalc?.attrs?.prefix ?? ''}`);

/**
 * What a percent-of-total pill sums to 100% along: 'series' (each category's series), 'table' (every mark), or
 * undefined (anything else, such as along the category axis). `itemPillId` may list every level of a combined category.
 */
export function percentScope(ws, pillId, itemPillId, seriesPillId) {
	const fieldOf = (id) => {
		const p = pillFor(ws, id);
		return `${p.datasourceId}|${p.fieldId}`;
	};
	const { partitionBy, dimensions } = tableCalcAddressing(ws, pillId, (id) => ({ column: id }));
	const partitioned = new Set(partitionBy.map((p) => p.column));
	const along = new Set(dimensions.filter((id) => !partitioned.has(id)).map(fieldOf));
	const onItem = [itemPillId].flat().some((id) => Boolean(id) && along.has(fieldOf(id)));
	const onSeries = Boolean(seriesPillId) && along.has(fieldOf(seriesPillId));
	if (onSeries && !onItem) return 'series';
	if (onItem && (onSeries || !seriesPillId)) return 'table';
	return undefined;
}

/**
 * A formatted text (tooltip, label) as literal text and field tokens. Tokens nest (`<Sheet name="x" filter="<All Fields>">`).
 * @param {string} text
 * @returns {({ text: string }|{ token: string })[]}
 */
export function textTokens(text) {
	const parts = [];
	let buf = '';
	let i = 0;
	while (i < text.length) {
		if (text[i] === '<') {
			let depth = 0;
			let j = i;
			for (; j < text.length; j++) {
				if (text[j] === '<') depth++;
				else if (text[j] === '>' && --depth === 0) break;
			}
			if (j < text.length) {
				if (buf) parts.push({ text: buf });
				buf = '';
				parts.push({ token: text.slice(i + 1, j) });
				i = j + 1;
				continue;
			}
		}
		buf += text[i++];
	}
	if (buf) parts.push({ text: buf });
	return parts;
}

const isPillToken = (token) => /^\[.+\]$/s.test(token);

/** Panes that draw marks: on a dual axis the per-axis panes, not the first one, whose settings Tableau no longer shows. */
export function markPanes(ws) {
	const panes = ws.panes ?? [];
	const tagged = panes.filter((p) => p.yAxisPill || p.xAxisPill);
	return tagged.length >= 2 ? tagged : panes;
}

/** The customized tooltip of the first pane that has one, or undefined when the marks use Tableau's default. */
export function customTooltip(ws) {
	return markPanes(ws).find((p) => p.tooltip)?.tooltip;
}

const AGG_LABELS = { avg: 'Avg.', countd: 'Distinct count of', count: 'Count of', min: 'Min.', max: 'Max.', median: 'Median' };
const DATE_LABELS = { year: 'Year', quarter: 'Quarter', month: 'Month', week: 'Week', day: 'Day', weekday: 'Weekday', hour: 'Hour', minute: 'Minute', second: 'Second' };

const CALC_AGG_LABELS = { sum: 'Sum', avg: 'Avg', average: 'Avg', min: 'Min', max: 'Max' };
const CALC_LABELS = {
	PctTotal: () => '% of Total',
	CumTotal: (attrs) => `Running ${CALC_AGG_LABELS[String(attrs?.aggregation ?? 'sum').toLowerCase()] ?? 'Sum'} of`,
	Diff: () => 'Difference in',
	PctDiff: () => '% Difference in',
	Rank: () => 'Rank of',
	PctRank: () => 'Percentile of',
	MovingCalc: (attrs) => `Moving ${MOVING_AGG_LABELS[String(attrs?.aggregation ?? 'avg').toLowerCase()] ?? 'Average'} of`
};
const MOVING_AGG_LABELS = { ...CALC_AGG_LABELS, avg: 'Average', average: 'Average' };

/** Tableau's name for a quick table calculation over a field named `base`, e.g. "% of Total Count of Customer". */
function tableCalcLabel(calc, base) {
	const label = CALC_LABELS[quickCalcType(calc.type)]?.(calc.attrs);
	if (!label) return base;
	const primary = `${label} ${base}`;
	return calc.secondary ? tableCalcLabel(calc.secondary, primary) : primary;
}

/**
 * Tableau's default label for a pill: its field name, with the aggregation unless it is a sum, or its date part or
 * truncation, inside the name of its quick table calculation.
 */
export function pillLabel(ws, ir, pillId) {
	const pill = pillFor(ws, pillId);
	const name = findField(ir, pill.datasourceId, pill.fieldId)?.name ?? stripBrackets(pill.fieldId);
	const part = DATE_LABELS[pill.datePart ?? pill.dateTrunc ?? ''];
	if (part) return `${part} of ${name}`;
	const agg = AGG_LABELS[String(pill.derivation ?? '').toLowerCase()];
	const base = agg ? `${agg} ${name}` : name;
	return pill.tableCalc ? tableCalcLabel(pill.tableCalc, base) : base;
}

/**
 * The fields of a labeled pane's default label: its Text and Label shelf fields, else the measure it plots (its own axis
 * on a dual axis, else the one measure on Rows and Columns). Empty when that is Measure Values or several measures.
 */
export function labelPills(ws, ir, pane) {
	const pills = [...new Set([...(pane.encodings?.text ?? []), ...(pane.encodings?.label ?? [])])];
	if (pills.length) return pills;
	const own = pane.yAxisPill ?? pane.xAxisPill;
	const measures = own ? [own] : [...(ws.rowPills ?? []), ...(ws.colPills ?? [])].filter((id) => /^measure/.test(classifyPill(ws, ir, id).kind));
	return measures.length === 1 && classifyPill(ws, ir, measures[0]).kind === 'measure' ? measures : [];
}

/** The data label Tableau draws: its customized label, else its label fields, else the mark's value. */
export function tableauLabel(ws, ir) {
	const pane = markPanes(ws).find((p) => p.showLabels);
	if (!pane) return undefined;
	if (pane.label) return pane.label;
	const pills = labelPills(ws, ir, pane);
	return pills.length ? pills.map((id) => `<${id}>`).join('\n') : '<[Multiple Values]>';
}

const MARK_SHELVES = ['color', 'size', 'shape', 'text', 'label', 'detail', 'tooltip', 'path', 'wedgeSize'];

/**
 * Tableau's default tooltip: a "<label>: <[pill]>" line per field in the view, dimensions, then measures and ATTR. Each
 * group is in column instance order, which Tableau sorts by instance name (`[none:Region:nk]`), as its live hover shows.
 */
export function defaultTooltipText(ws, ir) {
	const encoded = (key) => (ws.panes ?? []).flatMap((p) => p.encodings?.[key] ?? []);
	const ids = uniq([...(ws.colPills ?? []), ...(ws.rowPills ?? []), ...MARK_SHELVES.flatMap(encoded)]);
	const classified = ids.map((id) => classifyPill(ws, ir, id));
	const measureNames = classified.find((c) => c.kind === 'measure-names');
	const lines = [];
	const add = (measure, key, pillId, line) => {
		if (lines.some((l) => l.key === key)) return;
		const source = (ws.datasourceIds ?? []).indexOf(pillFor(ws, pillId).datasourceId);
		lines.push({ measure, key, line, source: source < 0 ? Infinity : source, instance: pillId.replace(/^\[[^\]]*\]\.(?=\[)/, '') });
	};
	for (const c of classified) {
		if (c.generated || c.kind === 'measure-names') continue;
		if (c.kind === 'measure-values') {
			const [only, ...more] = ws.measureValues ?? [];
			if (only && !more.length) add(true, `m:${measureKey(pillFor(ws, only))}`, only, `${pillLabel(ws, ir, only)}: <${only}>`);
			else if (measureNames) add(true, 'measure-values', measureNames.pillId, `<${measureNames.pillId}>: <${c.pillId}>`);
			continue;
		}
		const measure = c.kind === 'measure' || isAttrDim(c) || (c.kind === 'latlong' && c.pill.aggregated);
		add(measure, measure ? `m:${measureKey(c.pill)}` : `d:${dimKey(c.pill)}`, c.pillId, `${pillLabel(ws, ir, c.pillId)}: <${c.pillId}>`);
	}
	const byInstance = (a, b) => a.source - b.source || (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0);
	return [...lines.filter((l) => !l.measure).sort(byInstance), ...lines.filter((l) => l.measure).sort(byInstance)].map((l) => l.line).join('\n');
}

const DIM_MACROS = { ITEM: '%_CATEGORY_NAME', SERIES: '%_SERIES_NAME', CATEGORY: '%_CATEGORY', START_DATE: '%_STARTDATE', XTIME: '%_XVALUE', GROUP1: '%_CATEGORY2_NAME', GROUP2: '%_CATEGORY3_NAME' };
const dimKey = (pill) => `${pill.datasourceId ?? ''}|${pill.fieldId}|${String(pill.derivation ?? 'None').toLowerCase()}`;
const EXTRA_SLOT = /^EXTRAINFO(\d)$/;

/**
 * The Phoenix hover and data label macro for a pill a Tableau tooltip or label names, from the card's slots.
 * `{ extra: true }` is an aggregate the card does not show, which needs an EXTRAINFO slot; undefined has no macro.
 * `{ unconverted: true }` is a measure whose table calc the card could not convert (`unconverted`, measure keys).
 * On a 100% chart the VALUE column holds the measure without its percent of total (Phoenix shows that as %_VALUE).
 *
 * @param {WorksheetIR} ws
 * @param {WorkbookIR} ir
 * @param {string} pillId
 * @param {{ pillId: string, mapping: string, role: string }[]} slots
 * @param {{ pct100?: boolean, family?: string, unconverted?: Set<string> }} [opts]
 * @returns {{ macro: string }|{ extra: true }|{ unconverted: true }|undefined}
 */
export function slotMacro(ws, ir, pillId, slots, { pct100 = false, family, unconverted } = {}) {
	const c = classifyPill(ws, ir, pillId);
	if (c.kind === 'measure' && unconverted?.has(measureKey(c.pill))) return { unconverted: true };
	const measureSeries = slots.some((s) => s.mapping === 'SERIES' && s.role !== 'dim');
	if (c.kind === 'measure-names') return measureSeries ? { macro: '%_SERIES_NAME' } : undefined;
	if (c.kind === 'measure-values') return measureSeries || slots.some((s) => s.mapping === 'VALUE') ? { macro: '%_VALUE' } : undefined;
	const pillOf = (s) => pillFor(ws, s.pillId);
	if (c.kind !== 'measure') {
		const hit = slots.find((s) => s.role !== 'measure' && DIM_MACROS[s.mapping] && dimKey(pillOf(s)) === dimKey(c.pill));
		if (hit?.mapping === 'ITEM' && family === 'gantt') return { macro: '%_ITEM' };
		if (hit) return { macro: DIM_MACROS[hit.mapping] };
		const extra = slots.find((s) => EXTRA_SLOT.test(s.mapping) && dimKey(pillOf(s)) === dimKey(c.pill));
		return extra ? { macro: `%_TOOLTIP${EXTRA_SLOT.exec(extra.mapping)[1]}` } : undefined;
	}
	const key = measureKey(c.pill);
	for (const s of slots) {
		if (s.role === 'dim') continue;
		const p = pillOf(s);
		const extra = EXTRA_SLOT.exec(s.mapping);
		if (extra && measureKey(p) === key) return { macro: `%_TOOLTIP${extra[1]}` };
		if (s.mapping === 'VALUE' && measureKey(p, { withCalc: !pct100 }) === key) return { macro: family === 'scatter' ? '%_YVALUE' : '%_VALUE' };
		if (s.mapping === 'XTIME' && measureKey(p) === key) return { macro: '%_XVALUE' };
		if (s.mapping === 'BUBBLESIZE' && measureKey(p) === key) return { macro: '%_BUBBLE_VALUE' };
		if (s.mapping === 'SERIES' && measureKey(p) === key) return undefined;
	}
	const value = slots.find((s) => s.mapping === 'VALUE');
	if (value && isPctTotal(c.pill) && measureKey(pillOf(value), { withCalc: false }) === measureKey(c.pill, { withCalc: false })) {
		const item = slots.find((s) => s.mapping === 'ITEM' && s.role === 'dim');
		const series = slots.find((s) => s.mapping === 'SERIES' && s.role === 'dim');
		const scope = percentScope(ws, pillId, item?.derived?.pillIds ?? item?.pillId, series?.pillId);
		if (scope === 'series') return { macro: '%_PERCENT_OF_CATEGORY' };
		if (scope === 'table') return { macro: '%_PERCENT_OF_TOTAL' };
		return undefined;
	}
	return { extra: true };
}

const isAttrDim = (c) => c.kind === 'dimension' && /^attr/i.test(String(c.pill.derivation ?? ''));

/**
 * Fields the mark label or tooltip names that the card does not already show go in EXTRAINFO1..3: label measures, then
 * tooltip measures, then tooltip dimensions the card groups by (`grouped`) and ATTR dimensions. Phoenix shows an
 * EXTRAINFO column only through a %_TOOLTIPn macro in the hover or label text.
 */
function addTooltips(ctx, mappings, { limit = 3, pct100 = false, family, grouped = [] } = {}) {
	const { a, ws, ir } = ctx;
	const opts = { pct100, family };
	const pills = (text) => (text ? textTokens(text).filter((t) => t.token && isPillToken(t.token)).map((t) => classifyPill(ws, ir, t.token)) : []);
	const custom = customTooltip(ws);
	const tooltipOn = ws.tooltipMode !== 'none';
	const tooltip = tooltipOn ? pills(custom ?? defaultTooltipText(ws, ir)) : [];
	const groupedKeys = new Set(grouped.map((id) => dimKey(pillFor(ws, id))));
	const keyOf = (c) => (c.kind === 'measure' ? `m:${measureKey(c.pill)}` : `d:${dimKey(c.pill)}`);
	const picked = [];
	const pick = (c, source, dims) => {
		if (picked.some((p) => keyOf(p.c) === keyOf(c))) return;
		if (c.kind === 'measure') {
			if (slotMacro(ws, ir, c.pillId, mappings, opts)?.extra) picked.push({ c, source, role: 'measure' });
			return;
		}
		if (!dims || !isDim(c) || slotMacro(ws, ir, c.pillId, mappings, opts)) return;
		if (isAttrDim(c)) picked.push({ c, source, role: 'measure' });
		else if (groupedKeys.has(dimKey(c.pill))) picked.push({ c, source, role: 'dim' });
	};
	for (const c of pills(tableauLabel(ws, ir))) pick(c, 'label', false);
	for (const c of tooltip) pick(c, 'tooltip', false);
	for (const c of tooltip) pick(c, 'tooltip', true);
	picked.slice(0, limit).forEach(({ c, role }, i) => mappings.push(slot(c, `EXTRAINFO${i + 1}`, role)));
	const dropped = picked.slice(limit);
	if (dropped.length) {
		const severity = dropped.some((p) => p.source === 'label') ? 'warning' : 'info';
		ctx.out.warnings.push(issue(ws, severity, 'chart.tooltip', `Only ${limit} label and tooltip fields fit in Domo extra-info slots; ${dropped.map((p) => `${nameOf(p.c)} (${p.source})`).join(', ')} dropped`));
	}
	const dims = custom || !tooltipOn ? [] : a.get('tooltip').filter((c) => isDim(c) && !isAttrDim(c) && !slotMacro(ws, ir, c.pillId, mappings, opts));
	if (dims.length) ctx.out.warnings.push(issue(ws, 'info', 'chart.tooltip', `Tooltip dimensions (${dims.map(nameOf).join(', ')}) are not carried over`));
}

function nameOf(c) {
	return c.field?.name ?? stripBrackets(c.pill.fieldId);
}

function sameField(a, b) {
	return a && b && a.pill.datasourceId === b.pill.datasourceId && a.pill.fieldId === b.pill.fieldId;
}

function detailDims(ctx, exclude = []) {
	return ctx.a.get('detail').filter((c) => isDim(c) && !exclude.some((e) => sameField(e, c)));
}

/** Collapse nested discrete date parts of one field (YEAR / MONTH) into a single truncation. */
function collapseDateParts(dims) {
	if (dims.length < 2) return dims;
	const dates = dims.filter((c) => c.kind === 'date' && c.pill.datePart);
	if (dates.length < 2 || dates.length !== dims.length) return dims;
	if (!dates.every((c) => sameField(c, dates[0]))) return dims;
	const parts = dates.map((c) => c.pill.datePart);
	if (!parts.includes('year')) return dims;
	const finest = [...DATE_PART_ORDER].reverse().find((p) => parts.includes(p));
	return [{ ...dates[0], collapsedTrunc: finest }];
}

function axisSlot(c, mapping, family) {
	const extra = {};
	if (c.collapsedTrunc) extra.dateTrunc = c.collapsedTrunc;
	else if (c.kind === 'date' && !c.pill.datePart && !c.pill.dateTrunc && ['line', 'area', 'bar', 'combo'].includes(family)) extra.dateTrunc = 'day';
	return slot(c, mapping, 'dim', extra);
}

function hasPctTotal(measures) {
	return measures.some((c) => isPctTotal(c.pill));
}

const PERCENT_FORMAT = /^p|%/;

// A plain measure formatted as a percent and labeled with its share of each category: the bars read as shares.
function percentLabelStack(ws, primary, itemPills, seriesPillId) {
	if (primary.pill.tableCalc || !PERCENT_FORMAT.test(String(ws.numberFormats?.[primary.pillId] ?? ''))) return false;
	const base = measureKey(primary.pill, { withCalc: false });
	const labels = markPanes(ws).flatMap((p) => [...(p.encodings?.text ?? []), ...(p.encodings?.label ?? [])]);
	return labels.some((id) => {
		const pill = pillFor(ws, id);
		return isPctTotal(pill) && measureKey(pill, { withCalc: false }) === base && percentScope(ws, id, itemPills, seriesPillId) === 'series';
	});
}

/**
 * Of the dimensions on the measure's shelf (which split Tableau's view into panes), the one drawn as SERIES: the one also
 * on Color, else the only one when nothing else would be a series.
 */
function paneSeriesDim(extraDims, axis, colorDims) {
	if (!extraDims.length || !axis.length) return undefined;
	const onColor = extraDims.find((d) => colorDims.some((c) => sameField(c, d)));
	if (onColor) return onColor;
	const otherColor = colorDims.some((c) => !extraDims.some((d) => sameField(d, c)) && !axis.some((x) => sameField(x, c)));
	return extraDims.length === 1 && axis.length === 1 && !otherColor ? extraDims[0] : undefined;
}

/** A category level the view does not show apart: hidden headers, or a filter keeping one member. */
function unseenLevel(ws, c) {
	if ((ws.hiddenHeaders ?? []).includes(c.pillId)) return true;
	return (ws.filters ?? []).some((f) => f.fieldId === c.pill.fieldId && f.kind === 'categorical' && !f.hidden && f.include?.length === 1 && !f.ranges);
}

function clickActionOnLevels(ctx, levels) {
	const { ws, ir } = ctx;
	const passes = (action, c) =>
		action.allFields ||
		(action.fields ?? []).some((f) => f.source === c.pill.fieldId || String(f.source).endsWith(`.${c.pill.fieldId}`)) ||
		(action.fieldCaptions ?? []).includes(nameOf(c));
	return (ir?.actions ?? []).find((action) => (action.type === 'filter' || action.type === 'highlight') && (action.source?.worksheets ?? [action.source?.worksheet]).includes(ws.name) && levels.some((c) => passes(action, c)));
}

/**
 * Nested levels as Phoenix trellis categories: innermost ITEM, then GROUP1, then GROUP2 (from four levels, a combination of
 * the outer ones). A color on no level is the stacked SERIES.
 */
function trellisLevels(ctx, axis, colorDims) {
	const { ws } = ctx;
	if (axis.length < 2 || axis.some((c) => c.kind === 'date')) return undefined;
	if (colorDims.some((d) => axis.some((x) => sameField(x, d)))) return undefined;
	const seen = axis.filter((c) => !unseenLevel(ws, c));
	if (seen.length < 2) return undefined;
	const item = seen.at(-1);
	const group1 = seen.at(-2);
	const outer = seen.slice(0, -2);
	if (outer.length > 1 && clickActionOnLevels(ctx, outer)) return undefined;
	return { item, group1, group2: outer[0], group2Levels: outer.length > 1 ? outer : undefined, series: colorDims[0], unseen: axis.filter((c) => !seen.includes(c)) };
}

// Domo bars take one ITEM and one SERIES. Tableau stacks a color on no level within each cell of the level tuple; without
// one, the pane dimension, else the colored or innermost of three or more levels, is a side-by-side SERIES.
function combinedCategory(ctx, axis, colorDims, paneSeries) {
	const { ws, out } = ctx;
	if (axis.length < 2 || axis.some((c) => c.kind === 'date')) return undefined;
	const stackColor = colorDims.find((c) => !axis.some((x) => sameField(x, c)));
	const seen = axis.filter((c) => !unseenLevel(ws, c));
	const unseen = axis.filter((c) => !seen.includes(c));
	let result;
	if (paneSeries) {
		if (seen.length >= 2) result = { levels: seen, unseen, series: paneSeries, nested: true };
	} else if (stackColor && seen.length >= 2) result = { levels: seen, unseen, series: stackColor, nested: false };
	else if (!stackColor && seen.length >= 2 && (seen.length > 2 || unseen.length)) {
		const series = seen.find((c) => colorDims.some((d) => sameField(c, d))) ?? seen.at(-1);
		result = { levels: seen.filter((c) => c !== series), unseen, series, nested: true };
	}
	if (!result) return undefined;
	const names = result.levels.map(nameOf);
	if (names.length < 2) {
		out.warnings.push(issue(ws, 'info', 'chart.extra-dimension', `${unseen.map(nameOf).join(', ')} keeps one member; it still groups and sorts the rows but takes no slot`));
		return result;
	}
	const action = clickActionOnLevels(ctx, result.levels);
	if (action) {
		out.warnings.push(issue(ws, 'warning', 'chart.combined-category', `${names.join(', ')} stay separate category levels because action ${action.name} filters on them, which one combined category column could not pass on`));
		return undefined;
	}
	const how = result.nested ? `${nameOf(result.series)} keeps the series` : `${nameOf(result.series)} stacks in each bar as in Tableau`;
	out.warnings.push(issue(ws, 'info', 'chart.combined-category', `${names.join(', ')} are combined into one category (${names.join(' + ')}, a card beast mode) so ${how}`));
	return result;
}

/** One measure on both axes, colored on one pane only: Domo line+bar would bar every member but the last, so keep the colored pane. */
const MAX_MEMBER_LINES = 12;

/** Members of a color dimension that no parameter drives, from the Tableau color legend and the sheet's filters. */
function fixedSeriesMembers(ctx, series) {
	const { ws, ir } = ctx;
	const field = findField(ir, series.pill?.datasourceId, series.pill?.fieldId);
	if (!field || field.kind === 'parameter' || dependsOnParameter(ir, field)) return undefined;
	if (ws.color?.pillId !== series.pillId) return undefined;
	const filter = (ws.filters ?? []).find((f) => f.fieldId === series.pill?.fieldId && f.kind === 'categorical');
	let members = (ws.color.members ?? []).map((m) => String(m.value)).filter((v) => v !== '' && v !== '%null%');
	if (filter?.include?.length) members = members.filter((v) => filter.include.includes(v));
	if (filter?.exclude?.length) members = members.filter((v) => !filter.exclude.includes(v));
	return members.length && members.length <= MAX_MEMBER_LINES ? [...new Set(members)] : undefined;
}

function dependsOnParameter(ir, field, seen = new Set()) {
	if (!field || seen.has(field.id)) return false;
	seen.add(field.id);
	const formula = field.formula ?? '';
	if (/\[Parameters\]/.test(formula)) return true;
	const ds = (ir.datasources ?? []).find((d) => (d.fields ?? []).includes(field));
	for (const m of formula.matchAll(/\[([^\]]+)\]/g)) {
		const ref = (ds?.fields ?? []).find((f) => f.id === `[${m[1]}]`);
		if (ref && ref !== field && dependsOnParameter(ir, ref, seen)) return true;
	}
	return false;
}

function singlePaneColorFamily(ctx, series, measure, barPane, linePane) {
	const { a, ws, out } = ctx;
	const colors = (p) => p?.encodings?.color ?? [];
	const colored = (p) => colors(p).includes(series.pillId);
	if (a.panes.some((p) => !p.yAxisPill && !p.xAxisPill && colors(p).length)) return undefined;
	const line = colored(linePane) && !colors(barPane).length;
	const bar = colored(barPane) && !colors(linePane).length;
	if (!line && !bar) return undefined;
	const dim = nameOf(series);
	if (line) {
		const members = fixedSeriesMembers(ctx, series);
		if (members) {
			out.warnings.push(issue(ws, 'info', 'chart.dual-axis', `Dual axis total bar (${nameOf(measure)}) + one line per ${dim}: a card Beast Mode per member (${members.join(', ')}) draws its line`));
			out.memberLines = { seriesPillId: series.pillId, members };
			return 'combo';
		}
		out.warnings.push(issue(ws, 'warning', 'chart.dual-axis', `Dual axis total bar (${nameOf(measure)}) drawn as Domo's total line: ${dim} depends on a parameter or has too many members for a line per member, so the per-${dim} lines are kept and the total is one more line`));
		out.totalLine = true;
		return 'line';
	}
	out.warnings.push(issue(ws, 'warning', 'chart.dual-axis', `Dual axis total line (${nameOf(measure)}) dropped: Domo line+bar draws only the last ${dim} member as a line; the per-${dim} bars are kept`));
	return 'bar';
}

/** Bars, lines, areas and bar+line combos: one value axis, one category axis. */
function axisChart(ctx, family, dualPanes) {
	const { a, ws, out } = ctx;
	let horizontal = false;
	let measures;
	let axis;
	let extraDims;
	if (a.rowMeasures.length && !a.colMeasures.length) {
		measures = a.rowMeasures;
		axis = a.colDims;
		extraDims = a.rowDims;
	} else if (a.colMeasures.length && !a.rowMeasures.length) {
		horizontal = true;
		measures = a.colMeasures;
		axis = a.rowDims;
		extraDims = a.colDims;
	} else if (a.rowMeasures.length && a.colMeasures.length) {
		out.warnings.push(issue(ws, 'warning', 'chart.measure-axes', 'Measures on both rows and columns; only the row measures are charted'));
		measures = a.rowMeasures;
		axis = a.colDims;
		extraDims = a.rowDims;
	} else {
		const marked = [...a.get('text'), ...a.get('label'), ...a.get('size')].filter((c) => c.kind === 'measure');
		measures = marked.length ? marked : a.get('color').filter((c) => c.kind === 'measure').slice(0, 1);
		axis = a.colDims.length ? a.colDims : a.rowDims;
		horizontal = !a.colDims.length && a.rowDims.length > 0;
		extraDims = a.colDims.length ? a.rowDims : [];
	}
	if (!axis.length && !extraDims.length) return kpi(ctx, measures);
	const colorDims = a.get('color').filter(isDim);
	axis = collapseDateParts(axis);
	const paneSeries = paneSeriesDim(extraDims, axis, colorDims);
	const nestedDims = extraDims.filter((d) => d !== paneSeries);
	const asSeries = paneSeries && issue(ws, 'warning', 'chart.small-multiples', `${nameOf(paneSeries)} on the value shelf splits the view into panes; drawn as series instead`);
	if (asSeries) out.warnings.push(asSeries);
	if (nestedDims.length) {
		out.warnings.push(issue(ws, 'warning', 'chart.small-multiples', `Dimensions on the value shelf (${nestedDims.map(nameOf).join(', ')}) split the view into panes; they are nested into the category axis instead`));
		axis = collapseDateParts([...nestedDims, ...axis]);
	}
	if (family !== 'bar' && axis.length > 1) {
		const dateIdx = axis.findIndex((c) => c.kind === 'date');
		if (dateIdx > 0) axis = [axis[dateIdx], ...axis.filter((_, i) => i !== dateIdx)];
	}

	const hiddenLevels = axis.filter((c) => (ws.hiddenHeaders ?? []).includes(c.pillId));
	if (hiddenLevels.length && hiddenLevels.length < axis.length) {
		axis = axis.filter((c) => !hiddenLevels.includes(c));
		out.sortOnly = [...(out.sortOnly ?? []), ...hiddenLevels.map((c) => c.pillId)];
		out.warnings.push(issue(ws, 'info', 'chart.hidden-level', `${hiddenLevels.map(nameOf).join(', ')} has hidden headers in Tableau; it still groups and sorts the rows but takes no axis or series slot`));
	}
	const colorMeasure = a.get('color').find((c) => c.kind === 'measure');
	const trellis = family === 'bar' && !paneSeries ? trellisLevels(ctx, axis, colorDims) : undefined;
	const combined = family === 'bar' && !trellis ? combinedCategory(ctx, axis, colorDims, paneSeries) : undefined;
	let item = axis[0];
	let mappings = [axisSlot(item, 'ITEM', family)];
	let series = paneSeries;
	let nested = false;
	const groups = trellis ? [trellis.group1, trellis.group2].filter(Boolean) : [];
	const groupPills = trellis ? [trellis.group1.pillId, ...(trellis.group2Levels ?? [trellis.group2]).filter(Boolean).map((c) => c.pillId)] : [];
	if (trellis) {
		item = trellis.item;
		mappings = [axisSlot(item, 'ITEM', family)];
		series = trellis.series;
		if (trellis.unseen.length) out.sortOnly = [...(out.sortOnly ?? []), ...trellis.unseen.map((c) => c.pillId)];
		const outer = [...(trellis.group2Levels ?? [trellis.group2]), trellis.group1].filter(Boolean);
		out.warnings.push(issue(ws, 'info', 'chart.trellis', `${outer.map(nameOf).join(', ')} ${outer.length > 1 ? 'draw' : 'draws'} as trellis categories over ${nameOf(item)}, as Tableau's header bands`));
	} else if (combined) {
		item = combined.levels[0];
		const derived = combined.levels.length > 1 ? { derived: { type: 'concat', pillIds: combined.levels.map((c) => c.pillId) } } : {};
		mappings = [{ ...axisSlot(item, 'ITEM', family), ...derived }];
		series = combined.series;
		nested = combined.nested;
		if (combined.unseen.length) out.sortOnly = [...(out.sortOnly ?? []), ...combined.unseen.map((c) => c.pillId)];
	}
	const levels = paneSeries ? 1 : 2;
	if (!trellis && !combined && !paneSeries && axis.length >= 2) {
		series = axis[1];
		nested = true;
	}
	if (!trellis && !combined && axis.length > levels) {
		out.warnings.push(issue(ws, 'warning', 'chart.extra-dimension', `Only two category levels fit a Domo ${family} chart; ${axis.slice(levels).map(nameOf).join(', ')} dropped`));
	}
	const color = !combined && colorDims.find((c) => !sameField(c, item));
	if (color) {
		if (!series) series = color;
		else if (nested && !sameField(color, series) && unseenLevel(ws, series)) {
			out.warnings.push(issue(ws, 'info', 'chart.extra-dimension', `Color dimension ${nameOf(color)} is the series; ${nameOf(series)}, a second category level whose headers Tableau hides or that has one member, still groups the rows`));
			out.sortOnly = [...(out.sortOnly ?? []), series.pillId];
			series = color;
			nested = false;
		} else if (!sameField(color, series)) {
			out.warnings.push(issue(ws, 'warning', 'chart.extra-dimension', `Color dimension ${nameOf(color)} dropped: the series slot holds ${nameOf(series)}`));
		}
	}
	if (colorMeasure && !measures.some((m) => m.pillId === colorMeasure.pillId)) {
		out.warnings.push(issue(ws, 'warning', 'chart.color-measure', `Color by measure ${nameOf(colorMeasure)} has no Domo equivalent on this chart`, 'Add a conditional format in Analyzer.'));
	}

	const uniqueMeasures = measures.filter((m, i) => measures.findIndex((x) => x.pillId === m.pillId) === i);
	if (!uniqueMeasures.length) return fallback(ctx, 'No measure on the value axis');
	let primary = uniqueMeasures[0];
	let linePane;
	let barPane;
	if (family === 'combo') {
		barPane = dualPanes.find((p) => resolveMark(ctx.a, p) === 'Bar');
		linePane = dualPanes.find((p) => p !== barPane);
		const barPill = barPane?.yAxisPill ?? barPane?.xAxisPill;
		primary = uniqueMeasures.find((m) => m.pillId === barPill) ?? primary;
	}
	const others = uniqueMeasures.filter((m) => m !== primary);
	if (family === 'combo' && !others.length && series && series === color && !nested) {
		family = singlePaneColorFamily(ctx, series, primary, barPane, linePane) ?? family;
	}
	if (paneSeries && series === paneSeries && others.length) {
		// Phoenix's trellis facets along the category axis only, not into Tableau's stacked row panes.
		out.warnings.splice(out.warnings.indexOf(asSeries), 1);
		out.warnings.push(issue(ws, 'info', 'chart.small-multiples', `${nameOf(paneSeries)} on the value shelf splits the view into panes and the measures need the series slot; one card per member, stacked, each scaling its own value axis`));
		out.split = { pillId: paneSeries.pillId };
		series = undefined;
	} else if (family === 'combo' && others.length && series) {
		out.warnings.push(issue(ws, 'warning', 'chart.extra-dimension', `Series dimension ${nameOf(series)} dropped: the line measures of the dual axis use the SERIES slot`));
		series = undefined;
		nested = false;
	}
	const measureSeries = others.length > 0 && !series;
	if (measureSeries) {
		const ordered = family === 'combo' ? [...others, primary] : [primary, ...others];
		for (const m of ordered) mappings.push(slot(m, 'SERIES', 'measure'));
		if (family !== 'combo') {
			out.warnings.push(issue(ws, 'info', 'chart.multi-measure', `${uniqueMeasures.length} measures share one axis; mapped as ${uniqueMeasures.length} Domo series (${uniqueMeasures.map(nameOf).join(', ')})`));
		} else if (others.length > 1) {
			out.warnings.push(issue(ws, 'warning', 'chart.dual-axis', `Domo line+bar draws only the first series as a line by default; ${others.slice(1).map(nameOf).join(', ')} show as bars`, 'Set the number of lines in the card\'s chart properties.'));
		}
	} else {
		if (series) mappings.push(slot(series, 'SERIES', 'dim'));
		mappings.push(slot(primary, 'VALUE', 'measure'));
	}
	groups.forEach((c, i) => {
		const group = axisSlot(c, `GROUP${i + 1}`, family);
		mappings.push(i === 1 && trellis.group2Levels ? { ...group, derived: { type: 'concat', pillIds: trellis.group2Levels.map((l) => l.pillId) } } : group);
	});
	if (!measureSeries && others.length) {
		out.warnings.push(
			issue(ws, 'warning', 'chart.multi-measure', `Domo ${family} charts take one VALUE column and the SERIES slot holds ${nameOf(series)}; ${others.map(nameOf).join(', ')} dropped`, 'Unpivot the measures in ETL, or split into separate cards.')
		);
	}
	// A 100% chart sums each category's series to 100%: the percent of total must run along the series only.
	const itemPills = combined ? combined.levels.map((c) => c.pillId) : trellis ? [...groupPills, item.pillId] : item.pillId;
	const pct = measureSeries
		? hasPctTotal(uniqueMeasures)
		: Boolean(series) && ((isPctTotal(primary.pill) && percentScope(ws, primary.pillId, itemPills, series.pillId) === 'series') || (family === 'bar' && percentLabelStack(ws, primary, itemPills, series.pillId)));
	const detail = detailDims(ctx, [item, series, ...(combined?.levels ?? []), ...(trellis?.group2Levels ?? []), ...groups].filter(Boolean)).map((c) => c.pillId);
	const combinedLevels = [...(combined?.levels ?? []), ...(trellis?.group2Levels ?? [])].map((c) => c.pillId);
	addTooltips(ctx, mappings, { pct100: pct && (family === 'bar' || family === 'area'), family, grouped: [...detail, ...(out.sortOnly ?? []), ...combinedLevels] });
	const v = horizontal ? 'horiz' : 'vert';
	const bar = (chartType) => ({ chartType, family, mappings, detail, ...(trellis ? { overrides: { show_as_trellis: 'Trellis Categories' } } : {}) });

	if (family === 'combo' && out.memberLines) {
		const { seriesPillId, members } = out.memberLines;
		delete out.memberLines;
		const lines = members.map((member, i) => slot(primary, 'SERIES', 'measure', { pillId: `${primary.pillId}#member-${i}`, derived: { type: 'member', seriesPillId, measurePillId: primary.pillId, member } }));
		const kept = mappings.filter((m) => m.mapping !== 'SERIES' && m.mapping !== 'VALUE');
		return { chartType: 'badge_vert_bar_line', family, mappings: [...kept, slot(primary, 'SERIES', 'measure'), ...lines], detail, overrides: { set_line_count: String(members.length) } };
	}
	if (family === 'combo') {
		if (!measureSeries && !series) {
			out.warnings.push(issue(ws, 'warning', 'chart.dual-axis', 'Dual axis bar + line plots a single measure; drawn as bars'));
			return { chartType: `badge_${v}_bar`, family: 'bar', mappings, detail };
		}
		const lineName = measureSeries ? others.map(nameOf).join(', ') : (linePane?.yAxisPill ?? linePane?.xAxisPill ?? 'second measure');
		out.warnings.push(issue(ws, 'info', 'chart.dual-axis', `Dual axis bar (${nameOf(primary)}) + line (${lineName}) mapped to ${horizontal ? 'badge_horiz_line_bar' : 'badge_line_bar'}`));
		return { chartType: horizontal ? 'badge_horiz_line_bar' : 'badge_line_bar', family, mappings, detail };
	}
	if (family === 'line') {
		if (horizontal) out.warnings.push(issue(ws, 'info', 'chart.orientation', 'Vertical (rotated) line drawn as a regular left-to-right line'));
		const totalLine = out.totalLine ? { overrides: { show_total_line: 'true' } } : {};
		delete out.totalLine;
		return { chartType: 'badge_two_trendline', family, mappings, detail, ...totalLine };
	}
	if (family === 'area') {
		if (horizontal) out.warnings.push(issue(ws, 'info', 'chart.orientation', 'Vertical (rotated) area drawn left to right'));
		if (!series) return { chartType: 'badge_vert_area_overlay', family, mappings, detail };
		return { chartType: pct ? 'badge_vert_100pct_area' : 'badge_stackedtrend', family, mappings, detail };
	}
	if (!series && !measureSeries) return bar(`badge_${v}_bar`);
	if (pct) return bar(`badge_${v}_100pct`);
	const measureNamesOnColor = (ws.panes ?? []).some((pane) => (pane.encodings?.color ?? []).some((id) => /Measure Names/.test(id)));
	if (measureSeries && measureNamesOnColor) return bar(`badge_${v}_stackedbar`);
	const sideBySide = measureSeries || nested || Boolean(paneSeries) || colorDims.some((c) => sameField(c, series) && axis.some((x) => sameField(x, c)));
	return bar(sideBySide ? `badge_${v}_multibar` : `badge_${v}_stackedbar`);
}

/** Measures only (no dimension anywhere): a KPI. */
function kpi(ctx, measures) {
	const { ws, out } = ctx;
	const list = uniq(measures.map((m) => m.pillId)).map((id) => measures.find((m) => m.pillId === id));
	if (!list.length) return fallback(ctx, 'No measures or dimensions to chart');
	if (list.length === 1) {
		const mappings = [slot(list[0], 'VALUE', 'measure')];
		addTooltips(ctx, mappings);
		return { chartType: 'badge_singlevalue', family: 'kpi', mappings };
	}
	if (list.length === 2) {
		out.warnings.push(issue(ws, 'info', 'chart.kpi-target', `Two KPI measures mapped to badge_multi_value with ${nameOf(list[1])} as the TARGET`));
		return { chartType: 'badge_multi_value', family: 'kpi', mappings: [slot(list[0], 'VALUE', 'measure'), slot(list[1], 'TARGET', 'measure')] };
	}
	return { chartType: 'badge_basic_table', family: 'table', mappings: list.map((m) => slot(m, 'VALUE', 'measure')) };
}

function textMeasures(a) {
	const out = [...a.get('text'), ...a.get('label'), ...a.rowMeasures, ...a.colMeasures, ...a.get('size'), ...a.get('color'), ...a.discreteAggregates].filter(
		(c) => c.kind === 'measure'
	);
	return out.filter((m, i) => out.findIndex((x) => x.pillId === m.pillId) === i);
}

function tableRole(ctx, c) {
	if (c.kind === 'measure' && ctx.ws.aggregated === false && !c.pill.aggregated) return 'raw';
	return c.kind === 'measure' ? 'measure' : 'dim';
}

function textTable(ctx) {
	const { a, ws, out } = ctx;
	const measures = textMeasures(a);
	const rowDims = collapseDateParts(a.rowDims);
	const colDims = collapseDateParts(a.colDims);
	const markDims = [...a.get('text'), ...a.get('label')].filter(isDim);
	if (!rowDims.length && !colDims.length && !markDims.length) return kpi(ctx, measures);
	const colorMeasure = a.get('color').find((c) => c.kind === 'measure');
	const colored = (result) => tableColor(ctx, result, colorMeasure);
	// A table cannot hide a column, but its sorts may use a field it does not show: a hidden header sorts only.
	const hidden = new Set(ws.hiddenHeaders ?? []);
	const values = measures.filter((c) => !hidden.has(c.pillId));
	const pivot = rowDims.length && colDims.length && values.length;
	// Hidden headers still split Tableau's cells: when no shown dimension tells them apart (every header of a pivot axis,
	// or every dimension of a flat table, hidden), they stay columns.
	const kept = (pivot ? [rowDims, colDims] : [[...rowDims, ...colDims, ...markDims]]).filter((dims) => dims.length && dims.every((c) => hidden.has(c.pillId))).flat();
	for (const c of kept) hidden.delete(c.pillId);
	if (kept.length) out.warnings.push(issue(ws, 'info', 'card.hidden-header', `${uniq(kept.map(nameOf)).join(', ')} ${kept.length > 1 ? 'have hidden headers' : 'has a hidden header'} in Tableau; shown: Domo cannot hide a ${pivot ? 'pivot header' : 'table column'} and the cells need it`));
	const shown = (c) => !hidden.has(c.pillId);
	const sortOnly = [...rowDims, ...colDims].filter((c) => !shown(c)).map((c) => c.pillId);
	const withSortOnly = (result) => (sortOnly.length ? { ...result, sortOnly } : result);
	if (pivot) {
		const rows = rowDims.filter(shown);
		const cols = colDims.filter(shown);
		if (rows.length >= CROSSTAB_ROW_HEADERS && cols.length) return colored(withSortOnly(crosstabTable(ctx, rows, cols, values)));
		if (spreadsHighlight(ctx, cols, values, colorMeasure)) return colored(withSortOnly(crosstabTable(ctx, rows, cols, values, { highlight: true })));
		const mappings = [...rows.map((c) => axisSlot(c, 'ROW', 'pivot')), ...cols.map((c) => axisSlot(c, 'COLUMN', 'pivot')), ...values.map((m) => slot(m, 'VALUE', 'measure'))];
		if (rows.length + cols.length > 10) out.warnings.push(issue(ws, 'warning', 'chart.pivot-limit', 'Domo pivot tables take at most 10 row and column fields'));
		return colored(withSortOnly({ chartType: 'badge_pivot_table', family: 'pivot', mappings, detail: detailDims(ctx, [...rowDims, ...colDims]).map((c) => c.pillId) }));
	}
	const flat = withSortOnly(flatTable(ctx, [...rowDims, ...colDims, ...markDims], values, shown));
	return colored(kept.length ? { ...flat, keptHeaders: kept.map((c) => c.pillId) } : flat);
}

function colorScale(ctx, colorMeasure) {
	const enc = ctx.ws.color;
	return colorMeasure && enc?.pillId === colorMeasure.pillId ? enc : undefined;
}

/** Without an encoding, Tableau colors a continuous measure with a gradient and a discrete one by member. */
const isGradient = (scale, colorMeasure) => (scale ? scale.type !== 'palette' : colorMeasure.pill.continuous !== false);

const PALE_LUMINANCE = 0.6;
const PALE_CONTRAST = 1.5;

function luminance(hex) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A listed gradient whose colors are all light and barely tell apart (WCAG relative luminance and contrast ratio), so the
 * Tableau sheet reads as a plain table. A named built-in palette always has a dark end. Pure.
 * @param {import('../model/types.js').ColorEncodingIR} [encoding]
 * @returns {boolean}
 */
export function paleScale(encoding) {
	const colors = (encoding?.type === 'palette' ? [] : (encoding?.colors ?? [])).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
	if (!colors.length) return false;
	const levels = colors.map(luminance);
	const low = Math.min(...levels);
	return low >= PALE_LUMINANCE && (Math.max(...levels) + 0.05) / (low + 0.05) < PALE_CONTRAST;
}

/**
 * What a table does with Tableau's color measure: a pale scale is left off, a Mega Table crosstab colors the measure's
 * columns as heatmap columns, a pivot or flat table cannot show a scale.
 */
function tableColor(ctx, result, colorMeasure) {
	if (!colorMeasure) return result;
	const { ws, out } = ctx;
	const scale = colorScale(ctx, colorMeasure);
	const name = pillLabel(ws, ctx.ir, colorMeasure.pillId);
	if (paleScale(scale)) {
		out.warnings.push(issue(ws, 'info', 'chart.highlight-table', `The color scale of ${name} (${scale.colors[0]} to ${scale.colors.at(-1)}) is nearly invisible in Tableau; left off`));
		return result;
	}
	const valueColumn = result.mappings.some((s) => s.pillId === colorMeasure.pillId && s.role !== 'dim') || result.spread?.measure === colorMeasure.pillId;
	if (result.family === 'crosstab' && valueColumn && isGradient(scale, colorMeasure)) {
		const totals = scale?.includeTotals ? '; Domo does not color totals' : '';
		out.warnings.push(issue(ws, 'info', 'chart.highlight-table', `The color scale of ${name} is drawn as Mega Table heatmap columns in Domo's theme gradients, not Tableau's colors${totals}`));
		return { ...result, heatmap: { pillIds: [colorMeasure.pillId] } };
	}
	if (result.family === 'pivot') {
		out.warnings.push(issue(ws, 'warning', 'chart.highlight-table', `Domo pivot tables have no color scale; the Tableau colors by ${name} are left off`, 'Switch the card to a Mega Table in Analyzer for heatmap columns.'));
	} else {
		out.warnings.push(issue(ws, 'warning', 'chart.highlight-table', `Highlight table color (${name}) needs a conditional format in Domo`));
	}
	return result;
}

/** The members Tableau lists for a header (a manual sort), when there are few enough to spread into columns. */
function spreadableMembers(ws, c) {
	const sort = (ws.sorts ?? []).find((s) => s.pillId === c.pillId && s.kind === 'manual');
	const members = (sort?.order ?? []).filter((v) => v !== null && v !== undefined);
	return members.length <= MAX_SPREAD_MEMBERS ? members : [];
}

/**
 * A highlight table with one column header Tableau lists the members of, colored by its only value, keeps Tableau's grid
 * and its color as a Mega Table with that header spread into member columns (pivot column subtotals are lost).
 */
function spreadsHighlight(ctx, cols, values, colorMeasure) {
	if (!colorMeasure || cols.length !== 1 || cols[0].kind === 'date' || values.length !== 1) return false;
	if (values[0].pill.tableCalc || measureKey(values[0].pill) !== measureKey(colorMeasure.pill)) return false;
	const scale = colorScale(ctx, colorMeasure);
	return isGradient(scale, colorMeasure) && !paleScale(scale) && spreadableMembers(ctx.ws, cols[0]).length > 0;
}

/** Visible row headers from which a crosstab is a listing (a Mega Table) rather than a Domo pivot. */
export const CROSSTAB_ROW_HEADERS = 4;

/**
 * A crosstab whose rows list records (four or more row headers, down to accounts, orders and dates) as a Mega Table:
 * a Domo pivot reads at most 10,000 query rows and then shows partial data,
 * where a Mega Table pages through every row. The row headers become the leading columns, outer column headers the next
 * ones; the innermost column header is spread into one value column per member when Tableau lists its members (a
 * manual sort) and one measure is shown (`spread`, built by cards.js), else it is one more column.
 */
function crosstabTable(ctx, rows, cols, values, { highlight = false } = {}) {
	const { ws, out } = ctx;
	const inner = cols.at(-1);
	const members = spreadableMembers(ws, inner);
	const spread = values.length === 1 && members.length > 0;
	const dims = spread ? [...rows, ...cols.slice(0, -1)] : [...rows, ...cols];
	const mappings = [...dims.map((c) => slot(c, 'VALUE', 'dim', c.collapsedTrunc ? { dateTrunc: c.collapsedTrunc } : {})), ...values.map((m) => slot(m, 'VALUE', 'measure'))];
	const how = spread ? `, ${nameOf(inner)} spread into one column per member` : '';
	const why = highlight ? 'Highlight table shown as a Mega Table to keep its color as heatmap columns (pivot column subtotals are not kept)' : `Crosstab with ${rows.length} row headers shown as a Mega Table (a Domo pivot reads at most 10,000 rows)`;
	out.warnings.push(issue(ws, 'info', 'chart.crosstab-table', `${why}${how}`));
	const result = { chartType: 'badge_basic_table', family: 'crosstab', mappings, detail: detailDims(ctx, [...rows, ...cols]).map((c) => c.pillId) };
	if (spread) result.spread = { pillId: inner.pillId, members, measure: values[0].pillId };
	return result;
}

const MAX_SPREAD_MEMBERS = 50;

function flatTable(ctx, dims, measures, shown = () => true) {
	const seen = new Set();
	const mappings = [];
	for (const c of [...dims.filter(shown), ...measures]) {
		if (seen.has(c.pillId)) continue;
		seen.add(c.pillId);
		mappings.push(slot(c, 'VALUE', tableRole(ctx, c), c.collapsedTrunc ? { dateTrunc: c.collapsedTrunc } : {}));
	}
	if (!mappings.length) return { chartType: 'badge_basic_table', family: 'table', mappings };
	return { chartType: 'badge_basic_table', family: 'table', mappings, detail: detailDims(ctx, dims).map((c) => c.pillId) };
}

/** Everything as table columns, flagged. */
function fallback(ctx, reason) {
	const { a, ws, out } = ctx;
	const all = [...a.rowDims, ...a.colDims, ...a.get('color'), ...a.get('detail'), ...a.get('label'), ...a.get('text'), ...a.get('size'), ...a.rowMeasures, ...a.colMeasures, ...a.get('tooltip')];
	const dims = all.filter(isDim);
	const geo = all.filter((c) => c.kind === 'latlong' && !c.generated);
	const measures = all.filter((c) => c.kind === 'measure');
	out.warnings.push(issue(ws, 'warning', 'chart.fallback', `${reason}; converted to a table`, 'Pick a chart type in Analyzer after the push.'));
	const result = flatTable(ctx, [...dims, ...geo], measures);
	return { ...result, family: 'fallback', detail: [] };
}

function pie(ctx, dualPane) {
	const { a, ws, out } = ctx;
	const dims = [...a.get('color'), ...a.get('detail'), ...a.get('label'), ...a.rowDims, ...a.colDims].filter(isDim);
	const measures = [...a.get('wedgeSize'), ...a.get('size'), ...a.get('text'), ...a.get('label'), ...a.rowMeasures, ...a.colMeasures, ...a.get('tooltip')].filter((c) => c.kind === 'measure');
	if (!dims.length) return kpi(ctx, measures);
	if (!measures.length) return fallback(ctx, 'Pie without an angle measure');
	const item = dims[0];
	const value = measures[0];
	const mappings = [slot(item, 'ITEM', 'dim'), slot(value, 'VALUE', 'measure')];
	addTooltips(ctx, mappings, { family: 'pie' });
	const extra = dims.filter((c) => !sameField(c, item));
	if (extra.length) out.warnings.push(issue(ws, 'warning', 'chart.extra-dimension', `Pie slices by ${nameOf(item)} only; ${uniq(extra.map(nameOf)).join(', ')} dropped`));
	if (dualPane) out.warnings.push(issue(ws, 'info', 'chart.donut', 'Dual-axis pie (donut technique) converted to badge_donut'));
	return { chartType: dualPane ? 'badge_donut' : 'badge_pie', family: 'pie', mappings };
}

/**
 * A Square crosstab whose numbers are the content (a measure on Text or Label) is a highlight table, not a heat map, once
 * a heat map would drop headers or label measures; so is one whose color scale is too pale to read.
 */
function highlightTable(ctx, colorMeasure, value) {
	const { a } = ctx;
	const headers = Math.max(collapseDateParts(a.rowDims).length, collapseDateParts(a.colDims).length);
	const texts = [...a.get('text'), ...a.get('label')].filter((c) => c.kind === 'measure');
	const extra = uniq(texts.map((c) => measureKey(c.pill)).filter((key) => key !== measureKey(value.pill)));
	return (texts.length > 0 && (headers > 1 || extra.length > EXTRA_SLOTS)) || paleScale(colorScale(ctx, colorMeasure));
}

const EXTRA_SLOTS = 3;

function square(ctx) {
	const { a, ws, out } = ctx;
	const colorMeasure = a.get('color').find((c) => c.kind === 'measure');
	const sizeMeasure = a.get('size').find((c) => c.kind === 'measure');
	const textMeasure = textMeasures(a)[0];
	if (a.rowDims.length && a.colDims.length && !a.rowMeasures.length && !a.colMeasures.length) {
		const value = colorMeasure ?? textMeasure ?? sizeMeasure;
		if (!value || highlightTable(ctx, colorMeasure, value)) return textTable(ctx);
		const item = a.colDims.at(-1);
		const series = a.rowDims.at(-1);
		const dropped = [...a.colDims.slice(0, -1), ...a.rowDims.slice(0, -1)];
		if (dropped.length) out.warnings.push(issue(ws, 'warning', 'chart.extra-dimension', `Heat map keeps one dimension per axis; ${dropped.map(nameOf).join(', ')} dropped`));
		const mappings = [slot(item, 'ITEM', 'dim'), slot(series, 'SERIES', 'dim'), slot(value, 'VALUE', 'measure')];
		addTooltips(ctx, mappings);
		return { chartType: 'badge_heatmap', family: 'heatmap', mappings };
	}
	if (!a.rowDims.length && !a.colDims.length && !a.rowMeasures.length && !a.colMeasures.length) {
		const labelDims = [...a.get('label'), ...a.get('text'), ...a.get('detail'), ...a.get('color')].filter(isDim);
		const value = sizeMeasure ?? textMeasure ?? colorMeasure;
		if (!labelDims.length || !value) return kpi(ctx, [value].filter(Boolean));
		const item = labelDims[0];
		const mappings = [slot(item, 'ITEM', 'dim'), slot(value, 'VALUE', 'measure')];
		const outer = a.get('color').filter(isDim).find((c) => !sameField(c, item)) ?? labelDims.find((c) => !sameField(c, item));
		if (outer) mappings.push(slot(outer, 'SERIES', 'dim'));
		if (colorMeasure && colorMeasure !== value) mappings.push(slot(colorMeasure, 'COLOR', 'measure'));
		addTooltips(ctx, mappings);
		return { chartType: 'badge_treemap', family: 'treemap', mappings };
	}
	out.warnings.push(issue(ws, 'info', 'chart.square', 'Square marks on an axis converted to bars'));
	return axisChart(ctx, 'bar');
}

function circle(ctx) {
	const { a, ws, out } = ctx;
	const x = a.colMeasures[0] ?? a.colDims.find(isContinuousAxisDim);
	const y = a.rowMeasures[0] ?? a.rowDims.find(isContinuousAxisDim);
	if (x && y) {
		if (a.rowMeasures.length > 1 || a.colMeasures.length > 1) {
			out.warnings.push(issue(ws, 'warning', 'chart.scatter-matrix', 'Scatter plot matrix reduced to the first measure on each axis'));
		}
		const raw = ws.aggregated === false;
		const roleOf = (c) => (raw ? 'raw' : c.kind === 'measure' ? 'measure' : 'dim');
		const mappings = [slot(x, 'XTIME', roleOf(x)), slot(y, 'VALUE', roleOf(y))];
		const series = a.get('color').find(isDim) ?? a.get('detail').find(isDim) ?? [...a.rowDims, ...a.colDims].find((c) => c !== x && c !== y);
		if (series) mappings.push(slot(series, 'SERIES', 'dim'));
		const size = a.get('size').find((c) => c.kind === 'measure');
		if (size) mappings.push(slot(size, 'BUBBLESIZE', 'measure'));
		addTooltips(ctx, mappings, { family: 'scatter' });
		const detail = detailDims(ctx, [series].filter(Boolean)).map((c) => c.pillId);
		if (!raw && !series) out.warnings.push(issue(ws, 'warning', 'chart.scatter-single-point', 'Aggregated scatter without a detail dimension plots a single point'));
		return { chartType: size ? 'badge_xybubble' : 'badge_xyscatterplot_basic', family: 'scatter', mappings, detail };
	}
	if (!a.rowMeasures.length && !a.colMeasures.length && a.rowDims.length && a.colDims.length) return square(ctx);
	if (!a.rowMeasures.length && !a.colMeasures.length) return textTable(ctx);
	out.warnings.push(issue(ws, 'warning', 'chart.dot-plot', 'Circle/shape marks along a category axis converted to bars'));
	return axisChart(ctx, 'bar');
}

function mapChart(ctx, mark) {
	const { a, ws, out } = ctx;
	const geo = findGeo(a);
	const realLat = [...a.latlong, ...a.get('detail')].find((c) => c.kind === 'latlong' && !c.generated && c.geoRole === 'lat');
	const realLon = [...a.latlong, ...a.get('detail')].find((c) => c.kind === 'latlong' && !c.generated && c.geoRole === 'lon');
	const measures = [...a.get('color'), ...a.get('size'), ...a.get('text'), ...a.get('label'), ...a.get('tooltip')].filter((c) => c.kind === 'measure');
	const valueOf = () => measures[0];
	if (realLat && realLon) {
		const label = geo ?? [...a.get('detail'), ...a.get('label')].find(isDim);
		const value = valueOf();
		const mappings = [];
		if (label) mappings.push(slot(label, 'COUNTRY', 'dim'));
		else out.warnings.push(issue(ws, 'warning', 'chart.map-label', 'Lat/long map has no label dimension; Domo requires one (COUNTRY slot)'));
		mappings.push(slot(realLat, 'LATITUDE', 'dim'), slot(realLon, 'LONGITUDE', 'dim'));
		mappings.push(value ? slot(value, 'VALUE', 'measure') : slot(realLat, 'VALUE', 'measure', { aggregation: 'COUNT' }));
		const colorDim = a.get('color').find(isDim);
		if (colorDim) mappings.push(slot(colorDim, 'COLOR', 'dim'));
		addTooltips(ctx, mappings);
		return { chartType: 'badge_map_latlong', family: 'map', mappings };
	}
	if (!geo) return fallback(ctx, 'Map without a geographic dimension');
	const filled = FILLED_MAPS[geo.geoRole];
	if (!filled) {
		out.warnings.push(issue(ws, 'warning', 'chart.geocoding', `${nameOf(geo)} (${geo.geoRole}) relies on Tableau geocoding, which has no coordinates in the data`, 'Join latitude/longitude columns in ETL and switch the card to a Lat/Long map.'));
		return fallback(ctx, 'Geocoded map');
	}
	if (!POLYGON_MARKS.has(mark)) {
		out.warnings.push(issue(ws, 'warning', 'chart.symbol-map', `Symbol map on ${nameOf(geo)} converted to a filled map`));
	}
	if (geo.geoRole === 'state') {
		out.warnings.push(issue(ws, 'info', 'chart.map-region', `${filled} matches US state names or codes; non-US provinces will not render`));
	}
	if (geo.geoRole === 'county') {
		out.warnings.push(issue(ws, 'warning', 'chart.map-region', 'badge_map_us_county may expect FIPS codes rather than county names'));
	}
	const value = valueOf();
	const mappings = [slot(geo, 'ITEM', 'dim'), value ? slot(value, 'VALUE', 'measure') : slot(geo, 'VALUE', 'measure', { aggregation: 'COUNT' })];
	if (!value) out.warnings.push(issue(ws, 'info', 'chart.map-count', `Map has no measure; colored by the count of ${nameOf(geo)}`));
	addTooltips(ctx, mappings);
	return { chartType: filled, family: 'map', mappings };
}

function gantt(ctx) {
	const { a, ws, out } = ctx;
	const dateOnCols = a.colDims.find((c) => c.kind === 'date');
	const dateOnRows = a.rowDims.find((c) => c.kind === 'date');
	const start = dateOnCols ?? dateOnRows;
	const items = (dateOnCols ? a.rowDims : a.colDims).filter((c) => c.kind !== 'date');
	if (!start || !items.length) {
		out.warnings.push(issue(ws, 'warning', 'chart.gantt', 'Gantt bars without a date axis and a task dimension'));
		return axisChart(ctx, 'bar');
	}
	const size = a.get('size').find((c) => c.kind === 'measure');
	const mappings = [slot(items.at(-1), 'ITEM', 'dim'), slot(start, 'START_DATE', 'dim', { rawDate: true })];
	mappings.push(slot(start, 'END_DATE', 'dim', { rawDate: true, derived: { type: 'date-add', sizePillId: size?.pillId } }));
	const category = a.get('color').find(isDim);
	if (category) mappings.push(slot(category, 'CATEGORY', 'dim'));
	addTooltips(ctx, mappings, { family: 'gantt' });
	if (items.length > 1) out.warnings.push(issue(ws, 'warning', 'chart.extra-dimension', `Gantt rows use ${nameOf(items.at(-1))}; ${items.slice(0, -1).map(nameOf).join(', ')} dropped`));
	out.warnings.push(issue(ws, 'warning', 'chart.gantt', 'Gantt end date computed as start + size (days); badge_gantt slot semantics are unverified'));
	return { chartType: 'badge_gantt', family: 'gantt', mappings };
}

function isHistogram(a, mark) {
	if (mark !== 'Bar') return false;
	const axisBins = [...a.colDims, ...a.rowDims].filter((c) => c.bin);
	if (axisBins.length !== 1 || a.colDims.length + a.rowDims.length !== 1) return false;
	const measures = [...a.rowMeasures, ...a.colMeasures];
	return measures.length === 1 && /^(count|countd|cnt|ctd)$/i.test(measures[0].pill.derivation ?? measures[0].pill.prefix ?? '');
}

function histogram(ctx) {
	const { a, ws, out } = ctx;
	const bin = [...a.colDims, ...a.rowDims].find((c) => c.bin);
	out.warnings.push(issue(ws, 'warning', 'chart.histogram', `Histogram of ${nameOf(bin)}: Domo picks its own bucket size`));
	return { chartType: 'badge_vert_histogram', family: 'histogram', mappings: [slot(bin, 'VALUE', 'raw', { useBinSource: true })] };
}
