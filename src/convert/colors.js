import { parsePillId } from '../tableau/twb/shelf.js';
import { markPanes } from './chart-types.js';

/**
 * Tableau colors on Domo: card color rules (`conditionalFormats.card`) and the app chart palette.
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').Issue} Issue
 */

// At most 100 rules per card, each value under 255 characters.
export const MAX_COLOR_RULES = 100;
const MAX_RULE_VALUE = 254;

// A rule colors cells or regions on these, not Tableau's marks.
const COLORED_FAMILIES = new Set(['bar', 'line', 'area', 'combo', 'pie', 'scatter', 'treemap', 'gantt', 'histogram']);

const issue = (ws, code, message) => ({ severity: 'info', code, message, object: { type: 'worksheet', name: ws.name } });

const measureNames = (pillId) => /\[:Measure Names\]$/.test(pillId ?? '');

/** A rule as the Analyzer saves one. */
export function rule(column, values, color, dataSourceId) {
	return { condition: { column, values, operand: 'IN', dataSourceId }, format: { color, textColor: null, textStyle: 'PLAIN', applyToRow: false } };
}

const pillOf = (ws, pillId) => ws.pills?.[pillId] ?? parsePillId(pillId);

/**
 * The color rules that give a card Tableau's member and mark colors: a dimension's member map as one IN rule per color,
 * Measure Names as one rule per measure column, a single mark color as a rule on each value column, and the measure color
 * of a pane colored by Measure Names under another pane's color pill. Pure.
 * @param {WorksheetIR} ws
 * @param {{ family?: string, slots: { pillId: string, role: string, column: Object }[], dataSourceId: Object }} card
 * @returns {{ rules: Object[], issues: Issue[] }}
 */
export function cardColorRules(ws, card) {
	const out = primaryColorRules(ws, card);
	if (!COLORED_FAMILIES.has(card.family) || !ws.paneColors) return out;
	const ruled = new Set(out.rules.map((r) => r.condition.column));
	for (const pane of markPanes(ws)) {
		const encoding = (pane.encodings?.color ?? []).filter(measureNames).map((id) => ws.paneColors[id]).find(Boolean);
		if (encoding?.type !== 'palette') continue;
		for (const s of card.slots.filter((x) => x.role !== 'dim' && (x.pillId === pane.yAxisPill || x.pillId === pane.xAxisPill))) {
			const m = (encoding.members ?? []).find((x) => x.value === s.pillId);
			if (!m || ruled.has(s.column.column) || out.rules.length >= MAX_COLOR_RULES) continue;
			ruled.add(s.column.column);
			out.rules.push(rule(s.column.column, [], m.color, card.dataSourceId));
		}
	}
	return out;
}

function primaryColorRules(ws, { family, slots, dataSourceId }) {
	const color = ws.color;
	const issues = [];
	const rules = [];
	if (!color && !ws.markColor) return { rules, issues };
	if (!COLORED_FAMILIES.has(family)) {
		if (color?.members?.length) issues.push(issue(ws, 'card.colors-chart', `Tableau's member colors of ${pillName(color.pillId)} are not set on this ${family ?? 'card'} card: Domo color rules color its cells or regions, not marks`));
		return { rules, issues };
	}
	const values = slots.filter((s) => s.role !== 'dim' && ['VALUE', 'SERIES', 'Y', 'Y_VALUE'].includes(s.column.mapping));
	if (!color) return markColorRules(ws, { family, slots, values, dataSourceId });
	if (color.type !== 'palette') {
		issues.push(issue(ws, 'card.color-gradient', `Tableau colors the marks with a gradient by ${pillName(color.pillId)}; Domo gradients follow each bar's own value on single-series bars only, so the card uses the app's chart colors`));
		return { rules, issues };
	}
	const members = color.members ?? [];
	if (!members.length) return { rules, issues };
	if (measureNames(color.pillId)) {
		const shared = new Set();
		for (const s of values) {
			const m = members.find((x) => x.value === s.pillId);
			if (!m) continue;
			const same = rules.find((r) => r.condition.column === s.column.column);
			if (same) {
				if (same.format.color !== m.color) shared.add(s.column.column);
				continue;
			}
			rules.push(rule(s.column.column, [], m.color, dataSourceId));
		}
		if (shared.size) issues.push(issue(ws, 'card.colors-same-column', `Measures on the same column (${[...shared].join(', ')}) get one color: Domo color rules match a column, not a series`));
		return { rules: rules.slice(0, MAX_COLOR_RULES), issues };
	}
	const slot = slots.find((s) => s.pillId === color.pillId && s.role === 'dim');
	if (!slot) {
		issues.push(issue(ws, 'card.colors-dropped', `The member colors of ${pillName(color.pillId)} are not kept: the field is not on the Domo card`));
		return { rules, issues };
	}
	const pill = pillOf(ws, color.pillId);
	if (pill.datePart || pill.dateTrunc || slot.column.calendar || slot.column.dateGrain) {
		issues.push(issue(ws, 'card.colors-date', `The member colors of the date part ${pillName(color.pillId)} are not kept: Domo matches color rules on the date values, not Tableau's date parts`));
		return { rules, issues };
	}
	const byColor = new Map();
	let nulls = 0;
	for (const m of members) {
		if (m.value === null || m.value === undefined) {
			nulls += 1;
			continue;
		}
		const value = typeof m.value === 'boolean' ? String(m.value) : m.value;
		if (String(value).length > MAX_RULE_VALUE) continue;
		if (!byColor.has(m.color)) byColor.set(m.color, []);
		byColor.get(m.color).push(value);
	}
	const ranked = [...byColor].sort((a, b) => b[1].length - a[1].length);
	for (const [hex, list] of ranked.slice(0, MAX_COLOR_RULES)) rules.push(rule(slot.column.column, list, hex, dataSourceId));
	const name = pillName(color.pillId);
	if (ranked.length > MAX_COLOR_RULES) issues.push(issue(ws, 'card.colors-limit', `${name} has ${ranked.length} member colors; Domo cards take ${MAX_COLOR_RULES} color rules, so the ${ranked.length - MAX_COLOR_RULES} colors with the fewest members are left to the chart palette`));
	if (color.truncated) issues.push(issue(ws, 'card.colors-truncated', `${name} maps ${color.truncated} members to colors; the first ${members.length} are kept`));
	if (nulls) issues.push(issue(ws, 'card.colors-null', `The color of ${name}'s null member is not kept: Domo color rules cannot match null`));
	if (color.multi) issues.push(issue(ws, 'card.colors-tuples', `Colors Tableau maps to combinations of ${name} with other fields are not kept`));
	return { rules, issues };
}

/**
 * Each value column takes its pane's mark color. Two on one combo column split as the user set Process Area: the line's
 * on the column (it colors the stroke), the bars' on the category column, last so it wins on the bars (ColorManager).
 */
function markColorRules(ws, { family, slots, values, dataSourceId }) {
	const rules = [];
	const issues = [];
	const panes = markPanes(ws);
	const paneOf = (s) => panes.find((p) => p.yAxisPill === s.pillId || p.xAxisPill === s.pillId);
	const byColumn = new Map();
	for (const s of values) {
		const pane = paneOf(s);
		const hex = pane?.markColor ?? ws.markColor;
		if (!hex) continue;
		const list = byColumn.get(s.column.column) ?? [];
		if (!list.some((x) => x.hex === hex)) list.push({ hex, line: pane?.markClass === 'Line' });
		byColumn.set(s.column.column, list);
	}
	const item = slots.find((s) => s.role === 'dim' && s.column.mapping === 'ITEM');
	const last = [];
	for (const [column, list] of byColumn) {
		const line = list.find((x) => x.line);
		const bar = list.find((x) => !x.line);
		if (list.length === 2 && family === 'combo' && item && line && bar) {
			rules.push(rule(column, [], line.hex, dataSourceId));
			last.push(rule(item.column.column, [], bar.hex, dataSourceId));
			continue;
		}
		rules.push(rule(column, [], list[0].hex, dataSourceId));
		if (list.length > 1) issues.push(issue(ws, 'card.colors-same-column', `Measures on the same column (${column}) get one color: Domo color rules match a column, not a series`));
	}
	return { rules: [...rules, ...last.slice(0, 1)], issues };
}

const MAX_DIVERGING_RANGES = 5;

/** '3-5,7' from [3, 4, 5, 7]. */
function numberList(numbers) {
	const sorted = [...new Set(numbers)].sort((a, b) => a - b);
	const runs = [];
	for (const n of sorted) {
		const run = runs.at(-1);
		if (run && n === run[1] + 1) run[1] = n;
		else runs.push([n, n]);
	}
	return runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');
}

/**
 * Mega Table heatmap overrides (TableCSR) for a Tableau color gradient on the given columns. `columnNumbers` count the
 * subscription columns from 1. One range over all the columns, as Tableau's one scale; a diverging scale keeps its center
 * and, when stepped, its step count. Colors stay Domo's theme gradients. Pure.
 * @param {import('../model/types.js').ColorEncodingIR|undefined} encoding
 * @param {number[]} columnNumbers
 * @returns {Record<string, string>}
 */
export function heatmapOverrides(encoding, columnNumbers) {
	const overrides = { use_heatmap_colors: 'true', heatmap_columns: numberList(columnNumbers), range_by_column: 'false' };
	const diverging = encoding?.paletteType === 'ordered-diverging' || /diverging/i.test(encoding?.palette ?? '') || encoding?.center !== undefined;
	if (!diverging) return overrides;
	overrides.show_diverging = 'true';
	if (!encoding.center) overrides.midpoint_value_type = 'Zero';
	else Object.assign(overrides, { midpoint_value_type: 'Manual', midpoint_value: String(encoding.center) });
	overrides.diverging_range_count = String(encoding.steps ? Math.min(MAX_DIVERGING_RANGES, Math.max(1, Math.floor(encoding.steps / 2))) : MAX_DIVERGING_RANGES);
	if (encoding.steps % 2 === 1) overrides.show_midpoint = 'true';
	return overrides;
}

function pillName(pillId) {
	const m = /\]\.\[(?:[a-z0-9]*:)?(.*?)(?::[a-z0-9]+)*\]$/i.exec(pillId ?? '');
	return m ? m[1] : String(pillId ?? '');
}

/* ------------------------------------------------------------------ */
/* App chart palette                                                   */
/* ------------------------------------------------------------------ */

const TABLEAU_10 = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const CLASSIC_10 = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

/** The common built-in Tableau palettes, by the name a `<encoding palette>` gives. */
export const TABLEAU_PALETTES = {
	tableau10_10_0: { name: 'Tableau 10', colors: TABLEAU_10 },
	tableau20_10_0: {
		name: 'Tableau 20',
		colors: ['#4e79a7', '#a0cbe8', '#f28e2b', '#ffbe7d', '#59a14f', '#8cd17d', '#b6992d', '#f1ce63', '#499894', '#86bcb6', '#e15759', '#ff9d9a', '#79706e', '#bab0ac', '#d37295', '#fabfd2', '#b07aa1', '#d4a6c8', '#9d7660', '#d7b5a6']
	},
	'tableau-10': { name: 'Tableau Classic 10', colors: CLASSIC_10 },
	'tableau-20': {
		name: 'Tableau Classic 20',
		colors: ['#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5']
	},
	'tableau-10-medium': { name: 'Tableau Classic Medium', colors: ['#729ece', '#ff9e4a', '#67bf5c', '#ed665d', '#ad8bc9', '#a8786e', '#ed97ca', '#a2a2a2', '#cdcc5d', '#6dccda'] }
};
const DEFAULT_PALETTE = 'tableau10_10_0';
const MIN_PALETTE_COLORS = 2;
const MAX_PALETTE_COLORS = 20;

/**
 * The chart palette of the workbook's categorical color pills, by sheet count over the sheets on dashboards (all sheets
 * when none is): a custom palette from `<preferences>`, a built-in from TABLEAU_PALETTES, else the colors the pills' member
 * maps use, in order. Undefined when no sheet has a categorical color pill. Pure.
 * @param {WorkbookIR} ir
 * @returns {{ palette?: { name: string, colors: string[] }, issues: Issue[] }}
 */
export function workbookPalette(ir) {
	const placed = new Set((ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])]).filter((z) => z.kind === 'worksheet').map((z) => z.worksheet));
	const sheets = (ir.worksheets ?? []).filter((w) => !placed.size || placed.has(w.name));
	const counts = new Map();
	const used = new Map();
	for (const ws of sheets) {
		const pillId = (ws.panes ?? []).flatMap((p) => p.encodings?.color ?? [])[0];
		if (!pillId || (ws.color ? ws.color.type !== 'palette' : !measureNames(pillId) && pillOf(ws, pillId).continuous)) continue;
		const name = ws.color?.palette ?? DEFAULT_PALETTE;
		counts.set(name, (counts.get(name) ?? 0) + 1);
		if (!used.has(name)) used.set(name, []);
		for (const m of ws.color?.members ?? []) if (!used.get(name).includes(m.color)) used.get(name).push(m.color);
	}
	const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (!top) return { issues: [] };
	const object = { type: 'workbook', name: ir.workbook?.name || 'Workbook' };
	const custom = (ir.style?.palettes ?? []).find((p) => p.name === top && p.colors?.length >= MIN_PALETTE_COLORS);
	const builtIn = TABLEAU_PALETTES[top];
	const colors = custom?.colors ?? builtIn?.colors ?? used.get(top) ?? [];
	if (colors.length < MIN_PALETTE_COLORS) {
		return { issues: [{ severity: 'info', code: 'layout.theme-palette', message: `The workbook's chart palette "${top}" is not known to t2d and its member maps use fewer than ${MIN_PALETTE_COLORS} colors; the app keeps the theme's chart colors`, object }] };
	}
	const palette = { name: custom?.name ?? builtIn?.name ?? top, colors: colors.slice(0, MAX_PALETTE_COLORS).map((c) => c.toLowerCase()) };
	const issues = [];
	if (!custom && !builtIn) issues.push({ severity: 'info', code: 'layout.theme-palette', message: `The workbook's chart palette "${top}" is a Tableau built-in t2d has no table for; the app palette is the ${palette.colors.length} colors its member maps use, in the order first seen`, object });
	return { palette, issues };
}

const PALETTE_CELLS = 36;
// Phoenix reads shade columns and gradients beyond the first (a one-shade palette fails cards with "Index: 1, Size: 1"),
// so each color gets the 9 shades of Domo's own ranges, the color itself in the middle.
const SHADES = [0.8, 0.6, 0.4, 0.2, 0, -0.15, -0.3, -0.45, -0.6];
const KEY_SHADE = 4;

function shade(hex, amount) {
	const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
	const target = amount > 0 ? 255 : 0;
	return rgb.map((v) => Math.round(v + (target - v) * Math.abs(amount)).toString(16).padStart(2, '0')).join('');
}

/** The palette string Phoenix reads (DataUtils.getPalette): a 9-shade range per color and one rule cycling them. Pure. */
export function paletteJson(colors) {
	const hex = colors.map((c) => c.replace('#', '').toLowerCase());
	const cells = Array.from({ length: Math.max(PALETTE_CELLS, hex.length) }, (_, i) => [i % hex.length, KEY_SHADE]);
	return JSON.stringify({
		colorRanges: hex.map((h, i) => ({ name: `Color ${i + 1}`, keyColors: [{ color: h, locked: true }], values: SHADES.map((a) => shade(h, a)) })),
		colorRules: [{ min: 1, max: cells.length, values: cells }],
		lineColors: cells,
		latLongMapColors: cells,
		gradients: hex.map((_, row) => ({ colCount: SHADES.length, values: SHADES.map((_, col) => [row, col]) })),
		type: 'APP'
	});
}
