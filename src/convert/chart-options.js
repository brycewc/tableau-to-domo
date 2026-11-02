import { stripBrackets } from '../model/naming.js';
import { domoNumberFormat } from './number-format.js';
import { classifyPill, customTooltip, findField, markPanes, measureKey, pillFor, slotMacro, textTokens } from './chart-types.js';

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../model/types.js').ZoneIR} ZoneIR
 * @typedef {import('../model/types.js').Issue} Issue
 *
 * @typedef {{ pillId: string, mapping: string, role: string }} CardSlot
 *
 * @typedef {Object} LegendPlacement
 * @property {'top'|'bottom'|'right'|'hidden'} [position]  none: a legend Domo cannot place, so the card keeps its default
 * @property {string} dashboard
 * @property {{ dashboard: string, position: string }[]} [others]  Other dashboards that place the legend differently
 */

const BARS = ['vert_bar', 'horiz_bar', 'vert_100pct', 'horiz_100pct', 'vert_stackedbar', 'horiz_stackedbar', 'vert_multibar', 'horiz_multibar', 'line_bar', 'horiz_line_bar'];
const AXES = [...BARS, 'two_trendline', 'vert_area_overlay', 'vert_100pct_area', 'stackedtrend', 'xyscatterplot_basic', 'xybubble', 'heatmap'];
const badges = (names) => new Set(names.map((n) => `badge_${n}`));

const PLAIN_BARS = BARS.filter((b) => !b.includes('line_bar'));
const SUPPORT = {
	hover_text: badges([...AXES, 'pie', 'donut', 'treemap', 'gantt']),
	datalabel_text: badges([...AXES, 'pie', 'donut', 'gantt']),
	legend: badges([...AXES, 'gantt']),
	// Combos also list datalabel_position, but their label may belong to the line pane.
	datalabel_position: badges(PLAIN_BARS),
	datalabel_fnt_clr: badges(PLAIN_BARS),
	// A 100% chart's value axis is the percent Phoenix computes, not the Tableau measure.
	value_scale: badges([...PLAIN_BARS.filter((b) => !b.includes('100pct')), 'two_trendline', 'vert_area_overlay', 'stackedtrend'])
};

const PCT100 = /^badge_(vert|horiz)_100pct$|^badge_vert_100pct_area$/;
const VALUE_MACRO = /%_(VALUE|ORIG_VALUE|TOOLTIP\d|PERCENT_OF_\w+|XVALUE|YVALUE|BUBBLE_VALUE)/;
const TEXT_FAMILIES = new Set(['bar', 'line', 'area', 'combo', 'pie', 'scatter', 'heatmap', 'treemap', 'gantt']);

const AGG_LABELS = { avg: 'Avg.', countd: 'Distinct count of', count: 'Count of', min: 'Min.', max: 'Max.', median: 'Median' };

function issue(ws, severity, code, message) {
	return { severity, code, message, object: { type: 'worksheet', name: ws.name } };
}

/** Tableau's default tooltip label for a pill: its field name, with the aggregation unless it is a sum. */
function pillLabel(ws, ir, pillId) {
	const pill = pillFor(ws, pillId);
	const name = findField(ir, pill.datasourceId, pill.fieldId)?.name ?? stripBrackets(pill.fieldId);
	const agg = AGG_LABELS[String(pill.derivation ?? '').toLowerCase()];
	return agg ? `${agg} ${name}` : name;
}

/** Phoenix's own hover text for a chart type (HoverLabel, HandlerScaleBase, HandlerPie, HandlerHeatmap, ...). */
export function defaultHoverText(chartType, slots) {
	const has = (mapping) => slots.some((s) => s.mapping === mapping);
	if (/^badge_(vert|horiz)_100pct$/.test(chartType)) return '%_CATEGORY_NAME %_SERIES_NAME : %_ORIG_VALUE';
	if (chartType === 'badge_pie' || chartType === 'badge_donut') return '%_CATEGORY_NAME : %_ORIG_VALUE : %_ORIG_PERCENT_OF_TOTAL';
	if (chartType === 'badge_heatmap') return '%_SERIES_NAME %_CATEGORY_NAME : %_VALUE';
	if (chartType === 'badge_treemap') return '%_CATEGORY_NAME : %_VALUE';
	if (chartType === 'badge_xybubble') return '%_SERIES_NAME : %_XVALUE\n%_TF1_NAME : %_YVALUE\n%_TF2_NAME : %_BUBBLE_VALUE';
	if (/^badge_xyscatterplot/.test(chartType)) return '%_SERIES_NAME : %_XVALUE\n%_TF1_NAME : %_YVALUE';
	if (chartType === 'badge_gantt') return has('CATEGORY') ? '%_CATEGORY : %_ITEM : %_STARTDATE - %_ENDDATE' : '%_ITEM : %_STARTDATE - %_ENDDATE';
	return has('SERIES') ? '%_CATEGORY_NAME %_SERIES_NAME : %_VALUE' : '%_CATEGORY_NAME : %_VALUE';
}

/** The current (display) value of a parameter token, or undefined when the token is not a known parameter. */
function parameterValue(ir, token) {
	const m = /^\[Parameters\]\.\[(.+)\]$/s.exec(token);
	const p = m && (ir?.parameters ?? []).find((x) => x.id === token || x.name === m[1]);
	if (!p) return undefined;
	const member = (p.members ?? []).find((x) => String(x.value) === String(p.value));
	return { name: p.name, value: String(member?.alias ?? p.value ?? '') };
}

/**
 * A Tableau tooltip or label as Phoenix hover or data label text: field tokens become macros, parameters their current
 * value, tabs spaces, and a line whose every field token has no macro is left out. Bold, colors and fonts are not carried.
 * `valueLost`: the Tableau text shows a measure, the translation none.
 * @returns {{ text: string, dropped: string[], parameters: string[], valueLost: boolean }}
 */
export function translateMarkText(text, ws, ir, slots, opts) {
	const dropped = [];
	const parameters = [];
	const lines = [];
	let measures = 0;
	for (const line of String(text).split('\n')) {
		let out = '';
		let macros = 0;
		let misses = 0;
		for (const part of textTokens(line)) {
			if ('text' in part) {
				out += part.text.replace(/\t+/g, ' ');
				continue;
			}
			if (part.token === 'Sheet Name') {
				out += ws.name;
				continue;
			}
			const param = parameterValue(ir, part.token);
			if (param) {
				out += param.value;
				parameters.push(`${param.name} = ${param.value}`);
				continue;
			}
			const pill = /^\[.+\]$/s.test(part.token);
			if (pill && /^measure/.test(classifyPill(ws, ir, part.token).kind)) measures++;
			const hit = pill ? slotMacro(ws, ir, part.token, slots, opts) : undefined;
			if (hit?.macro) {
				out += hit.macro;
				macros++;
			} else {
				misses++;
				dropped.push(pill ? pillLabel(ws, ir, part.token) : `<${part.token.includes('=') ? part.token.split(/\s/)[0] : part.token}>`);
			}
		}
		if (misses && !macros) continue;
		lines.push(out.replace(/ {2,}/g, ' ').trimEnd());
	}
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines.at(-1).trim()) lines.pop();
	const joined = lines.join('\n');
	return { text: joined, dropped: [...new Set(dropped)], parameters: [...new Set(parameters)], valueLost: measures > 0 && !VALUE_MACRO.test(joined) };
}

/**
 * The fields of a labeled pane's default label: its Text and Label shelf fields, else the measure it plots (its own axis
 * on a dual axis, else the one measure on Rows and Columns). Empty when that is Measure Values or several measures.
 */
function labelPills(ws, ir, pane) {
	const pills = [...new Set([...(pane.encodings?.text ?? []), ...(pane.encodings?.label ?? [])])];
	if (pills.length) return pills;
	const own = pane.yAxisPill ?? pane.xAxisPill;
	const measures = own ? [own] : [...(ws.rowPills ?? []), ...(ws.colPills ?? [])].filter((id) => /^measure/.test(classifyPill(ws, ir, id).kind));
	return measures.length === 1 && classifyPill(ws, ir, measures[0]).kind === 'measure' ? measures : [];
}

/** The data label Tableau draws: its customized label, else its label fields, else the mark's value. */
function tableauLabel(ws, ir) {
	const pane = markPanes(ws).find((p) => p.showLabels);
	if (!pane) return undefined;
	if (pane.label) return pane.label;
	const pills = labelPills(ws, ir, pane);
	return pills.length ? pills.map((id) => `<${id}>`).join('\n') : '<[Multiple Values]>';
}

const PERCENT_PLACES = ['None', '.0', '.00', '.000', '.0000', '.00000'];

/** Phoenix's `percent_decimal_places` for the Tableau percent format of the labeled measure, as its labels show it. */
function labelPercentPlaces(ws, ir) {
	const pane = markPanes(ws).find((p) => p.showLabels);
	for (const id of pane ? labelPills(ws, ir, pane) : []) {
		const format = domoNumberFormat(ws.numberFormats?.[id]);
		if (format?.type === 'percent') return PERCENT_PLACES[Math.min(format.precision ?? 0, PERCENT_PLACES.length - 1)];
	}
	return undefined;
}

const STACKS = /^badge_(vert|horiz)_(stackedbar|100pct)$/;

/**
 * Phoenix label position for the Tableau alignment along the bar (vertical on a column chart, horizontal on a bar chart):
 * Automatic centers each segment's label on a stack. An end that is outside on a lone bar maps on a stack only.
 */
function labelPosition(pane, chartType, stacked) {
	const horizontal = chartType.includes('_horiz_');
	const along = (horizontal ? pane.labelAlign?.horizontal : pane.labelAlign?.vertical) ?? 'auto';
	if (along === 'center' || (along === 'auto' && stacked)) return 'Center';
	if (along === (horizontal ? 'left' : 'bottom')) return horizontal ? 'Inside Left' : 'Inside Bottom';
	if (stacked && along === (horizontal ? 'right' : 'top')) return horizontal ? 'Inside Right' : 'Inside Top';
	return undefined;
}

const NEAR_GRAY = 24;

/** Phoenix label color: Tableau's automatic color contrasts the mark under it; a user color near white, black or gray. */
function labelFontColor(pane, inside) {
	const mode = pane.labelColor?.mode ?? 'auto';
	if (mode === 'auto') return inside ? 'Complimentary' : undefined;
	const m = mode === 'user' && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(pane.labelColor.color ?? '');
	if (!m) return undefined;
	const rgb = m.slice(1).map((h) => parseInt(h, 16));
	if (Math.max(...rgb) - Math.min(...rgb) > NEAR_GRAY) return undefined;
	const level = Math.max(...rgb);
	return level >= 230 ? 'White' : level <= 64 ? 'Black' : 'Gray';
}

const STACK_TOTALS = badges(['vert_stackedbar', 'horiz_stackedbar']);
const BOLD_TOTAL_STYLE = 'Medium';

/** Tableau's stack total trick: a dual axis pane stacked by color without labels, and an uncolored one labeling totals. */
function stackTotalPane(ws) {
	const panes = markPanes(ws);
	const labeled = panes.filter((p) => p.showLabels);
	if (labeled.length !== 1 || labeled[0].encodings?.color?.length) return undefined;
	return panes.some((p) => p !== labeled[0] && p.encodings?.color?.length && !p.showLabels) ? labeled[0] : undefined;
}

/**
 * Hover text and data label overrides for a card, from the worksheet's tooltip and mark labels.
 * @param {WorksheetIR} ws
 * @param {WorkbookIR} ir
 * @param {{ chartType: string, family: string, slots: CardSlot[] }} card  `slots` are the card's columns with their pills
 * @returns {{ overrides: Record<string,string>, issues: Issue[] }}
 */
export function markTextOverrides(ws, ir, { chartType, family, slots }) {
	const overrides = {};
	const issues = [];
	if (!TEXT_FAMILIES.has(family)) return { overrides, issues };
	const opts = { pct100: PCT100.test(chartType), family };
	const translate = (text, what, target) => {
		const result = translateMarkText(text, ws, ir, slots, opts);
		if (result.dropped.length) issues.push(issue(ws, 'info', 'chart.mark-text', `${what} item(s) ${result.dropped.join(', ')} have no Domo macro on this card; left out of the ${target}`));
		if (result.parameters.length) issues.push(issue(ws, 'info', 'chart.mark-text', `${what} shows the current parameter value(s) as fixed text (${result.parameters.join(', ')}); it does not follow later variable changes`));
		return result;
	};
	if (SUPPORT.hover_text.has(chartType)) {
		const custom = customTooltip(ws);
		const extras = slots.filter((s) => /^EXTRAINFO\d$/.test(s.mapping));
		if (custom) {
			const { text, valueLost } = translate(custom, 'Tooltip', 'hover text');
			// A hover text without the mark's value is worse than Domo's default one.
			if (text && !valueLost) overrides.hover_text = text;
		} else if (extras.length) {
			const lines = extras.map((s) => `${pillLabel(ws, ir, s.pillId)}: %_TOOLTIP${s.mapping.slice(-1)}`);
			overrides.hover_text = [defaultHoverText(chartType, slots), ...lines].join('\n');
		}
	}
	const total = STACK_TOTALS.has(chartType) ? stackTotalPane(ws) : undefined;
	if (total) {
		overrides.datalabel_show_total = 'true';
		if (total.boldLabels) overrides.datalabel_total_style = BOLD_TOTAL_STYLE;
		return { overrides, issues };
	}
	const label = SUPPORT.datalabel_text.has(chartType) ? tableauLabel(ws, ir) : undefined;
	if (label) {
		const { text, valueLost } = translate(label, 'Mark label', 'data label');
		// A label's measure Domo cannot name is still the mark's own value (one series per measure).
		const shown = valueLost ? [text, '%_VALUE'].filter(Boolean).join('\n') : text;
		if (shown) overrides.datalabel_text = shown;
		const places = /%_(ORIG_)?PERCENT_OF_/.test(shown ?? '') ? labelPercentPlaces(ws, ir) : undefined;
		if (places) overrides.percent_decimal_places = places;
		const pane = markPanes(ws).find((p) => p.showLabels);
		const position = SUPPORT.datalabel_position.has(chartType) ? labelPosition(pane, chartType, STACKS.test(chartType) && slots.some((s) => s.mapping === 'SERIES')) : undefined;
		if (position) overrides.datalabel_position = position;
		const color = SUPPORT.datalabel_fnt_clr.has(chartType) ? labelFontColor(pane, Boolean(position)) : undefined;
		if (color) overrides.datalabel_fnt_clr = color;
	}
	return { overrides, issues };
}

/** Only a value axis fixed by hand in Tableau pins Phoenix's range: the sign of the data is unknown at convert time. */
export function axisRangeOverrides(ws, { chartType, slots }) {
	const overrides = {};
	const issues = [];
	if (!ws.axes?.length || !SUPPORT.value_scale.has(chartType)) return { overrides, issues };
	const keys = new Set(slots.filter((s) => s.role !== 'dim' && (s.mapping === 'VALUE' || s.mapping === 'SERIES')).map((s) => measureKey(pillFor(ws, s.pillId))));
	const axis = ws.axes.find((x) => keys.has(measureKey(pillFor(ws, x.pillId))));
	if (!axis) return { overrides, issues };
	if (axis.min !== undefined) overrides.value_scale_min = String(axis.min);
	if (axis.max !== undefined) overrides.value_scale_max = String(axis.max);
	issues.push(issue(ws, 'info', 'chart.axis-range', `The value axis keeps Tableau's fixed range (${axis.min ?? 'automatic'} to ${axis.max ?? 'automatic'})`));
	return { overrides, issues };
}

const SORTED_STACKS = /^badge_(vert|horiz)_(stackedbar|100pct)$/;

// Phoenix Descending puts the largest segment at the base; Tableau stacks a
// vertical bar's first series on top and a horizontal bar's at the base.
export function stackSortOverrides(ws, { chartType, slots }) {
	const overrides = {};
	const issues = [];
	const stack = SORTED_STACKS.exec(chartType);
	const series = slots.find((s) => s.mapping === 'SERIES' && s.role === 'dim');
	const value = slots.find((s) => s.mapping === 'VALUE');
	if (!stack || !series || !value) return { overrides, issues };
	const key = (id) => measureKey(pillFor(ws, id), { withCalc: false });
	const sort = (ws.sorts ?? []).find((s) => s.kind === 'computed' && s.using && s.pillId === series.pillId && key(s.using) === key(value.pillId));
	if (!sort) return { overrides, issues };
	const ascending = sort.direction !== 'DESC';
	overrides.category_sort_method = ascending === (stack[1] === 'vert') ? 'Descending' : 'Ascending';
	issues.push(issue(ws, 'info', 'chart.stack-sort', `Each bar orders its segments by value (${overrides.category_sort_method}); Tableau orders them by the series total over the whole chart`));
	return { overrides, issues };
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where a legend sits relative to its worksheet's zone, as a Domo legend position. */
export function legendPosition(legendRect, sheetRect) {
	if (!sheetRect?.w || !sheetRect?.h) return undefined;
	const c = center(legendRect);
	const rx = (c.x - sheetRect.x) / sheetRect.w;
	const ry = (c.y - sheetRect.y) / sheetRect.h;
	if (rx > 1) return 'right';
	if (ry <= 0.25) return 'top';
	if (ry >= 0.75) return 'bottom';
	if (rx >= 0.75) return 'right';
	return undefined;
}

/** A legend zone for the worksheet's color: no field named, Measure Names, or a field on its Color shelf. */
function isColorLegend(zone, ws) {
	if (!zone.param) return true;
	const field = pillFor(ws, zone.param).fieldId;
	if (/Measure Names/.test(field)) return true;
	return (ws.panes ?? []).some((p) => (p.encodings?.color ?? []).some((id) => pillFor(ws, id).fieldId === field));
}

/**
 * Color legend placement per worksheet name, from the first dashboard that shows the worksheet with a color legend
 * (no position when no legend sits beside the sheet).
 * @param {WorkbookIR} ir
 * @returns {Map<string, LegendPlacement>}
 */
export function legendPlacements(ir) {
	const out = new Map();
	const sheets = new Map((ir?.worksheets ?? []).map((w) => [w.name, w]));
	for (const dash of ir?.dashboards ?? []) {
		const zones = [...(dash.zones ?? []), ...(dash.floating ?? [])];
		const placed = new Set();
		for (const legend of zones) {
			const ws = sheets.get(legend.worksheet);
			if (legend.kind !== 'legend' || !ws || placed.has(ws.name) || !isColorLegend(legend, ws)) continue;
			const sheet = zones.find((z) => z.kind === 'worksheet' && z.worksheet === ws.name);
			const position = sheet && legendPosition(legend.rect, sheet.rect);
			if (!position) {
				if (!out.has(ws.name)) out.set(ws.name, { dashboard: dash.name });
				continue;
			}
			placed.add(ws.name);
			const first = out.get(ws.name);
			if (!first?.position) out.set(ws.name, { position, dashboard: dash.name });
			else if (first.position !== position) first.others = [...(first.others ?? []), { dashboard: dash.name, position }];
		}
	}
	return out;
}

const LEGEND_OVERRIDES = {
	top: { lrg_legend_position: 'Top', details_legend_position: 'Top' },
	bottom: { lrg_legend_position: 'Bottom', details_legend_position: 'Bottom' },
	right: { details_legend_position: 'Right' },
	hidden: { lrg_legend_position: 'Hide', details_legend_position: 'Hide' }
};

/**
 * Legend position overrides for a card whose chart draws a legend.
 * @param {WorksheetIR} ws
 * @param {LegendPlacement|undefined} placement
 * @param {{ chartType: string, slots: CardSlot[] }} card
 * @returns {{ overrides: Record<string,string>, issues: Issue[] }}
 */
export function legendOverrides(ws, placement, { chartType, slots }) {
	if (!placement?.position || !SUPPORT.legend.has(chartType) || !slots.some((s) => s.mapping === 'SERIES')) return { overrides: {}, issues: [] };
	const issues = [];
	if (placement.others?.length) {
		const others = placement.others.map((o) => `${o.dashboard}: ${o.position}`).join(', ');
		issues.push(issue(ws, 'info', 'chart.legend', `The color legend sits ${placement.position} of the sheet on ${placement.dashboard} but elsewhere on other dashboards (${others}); the card uses ${placement.dashboard}'s`));
	}
	return { overrides: { ...LEGEND_OVERRIDES[placement.position] }, issues };
}

const AXIS_NEGATIVES = ['negative_numbers', 'negative_numbers_dl', 'negative_numbers_hvr'];
// Each is a select list of Default, -100, (100).
const NEGATIVE_PROPERTIES = {
	...Object.fromEntries([...BARS.filter((b) => !b.includes('line_bar')), 'vert_area_overlay', 'vert_100pct_area', 'stackedtrend'].map((b) => [`badge_${b}`, AXIS_NEGATIVES])),
	badge_vert_multibar: [...AXIS_NEGATIVES, 'negative_numbers_right'],
	badge_two_trendline: [...AXIS_NEGATIVES, 'negative_numbers_right'],
	badge_line_bar: ['negative_numbers_line', 'negative_numbers_bar', 'negative_numbers_dl', 'negative_numbers_hvr'],
	badge_horiz_line_bar: ['negative_numbers_line', 'negative_numbers_bar', 'negative_numbers_dl', 'negative_numbers_hvr'],
	badge_xyscatterplot_basic: ['negative_numbers_x', 'negative_numbers_y', 'negative_numbers_dl', 'negative_numbers_hvr'],
	badge_xybubble: ['negative_numbers_x', 'negative_numbers_y', 'negative_numbers_dl', 'negative_numbers_hvr'],
	badge_heatmap: ['negative_numbers_dl', 'negative_numbers_hvr'],
	badge_treemap: ['negative_numbers_hvr'],
	badge_pie: ['negative_numbers'],
	badge_donut: ['negative_numbers'],
	badge_singlevalue: ['negative_numbers'],
	badge_multi_value: ['single_negative_numbers', 'addl_text_negative_numbers'],
	badge_map_us_state: ['negative_numbers'],
	badge_map_us_county: ['negative_numbers'],
	badge_world_map: ['negative_numbers']
};
const TABLE_NEGATIVES = badges(['basic_table', 'table', 'pivot_table']);

/**
 * Parenthesized negatives for the card when every formatted measure's Tableau format uses them.
 * @param {{ chartType: string, styles: (string|undefined)[] }} card  `styles`: negativeStyle of each formatted measure
 */
export function negativeNumberOverrides(ws, { chartType, styles }) {
	const overrides = {};
	const issues = [];
	if (!styles.includes('parens')) return { overrides, issues };
	if (!styles.every((s) => s === 'parens')) {
		issues.push(issue(ws, 'info', 'chart.negative-numbers', 'Some measures show negatives in parentheses in Tableau and others do not; the card keeps Domo\'s minus sign'));
		return { overrides, issues };
	}
	if (TABLE_NEGATIVES.has(chartType)) overrides.parenthesize_negatives = 'true';
	for (const name of NEGATIVE_PROPERTIES[chartType] ?? []) overrides[name] = '(100)';
	return { overrides, issues };
}
