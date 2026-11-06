import { isRef, ref } from '../util/refs.js';
import { beastModeLegacyId, slugify, uuidv5 } from '../util/ids.js';
import { stripBrackets } from '../model/naming.js';
import { parsePillId } from '../tableau/twb/shelf.js';
import { buildCardBody, fieldlessSheetIssue, naturalOrderKey } from './cards.js';
import { fieldColumnFormat } from './number-format.js';
import { aggregateFilterField, bindingExpression, dashboardFilterScopes, isAggregateControl, toCardFilters, filterDataType, refOf, relativeDateRange } from './filters.js';
import { variableControl } from './variables.js';
import { resolveTitle } from './titles.js';
import { BUTTON_HEIGHT, SECTION_BAR_HEIGHT, actionIssues, applyCardActions, buildAppLayout, buttonBox, filterSection, groupSections, headerBand, linkedPageKeys, navigationButton, planItemStyles, planStoryLayout, sectionIssues, sheetButton, titleBand, toggleSections, webPageButton, webViewButton, workbookTheme, workbookTableStyle, controlItemStyle, opaqueHex, zoneItemStyle } from './app-layout.js';
import { workbookPalette } from './colors.js';
import { MIN_NARROW_WIDTH, MIN_TILE_WIDTH, apportion, fillHoles, sortTemplate, tile } from './tile.js';
import { notebookCard, notebookLines } from './notebook.js';
import { resolveWebUrl } from './web-links.js';
import { COMPACT_HEADER_ROWS, bandColumns, bandHoles, findHeader, headerCard, headerParagraphs, needsTextCard, sectionImageCard, textCardRows, textCardWidth, textZoneCard } from './header.js';
import { colorTone } from '../util/image.js';
import { stackHeightPx } from './stack.js';

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').DashboardIR} DashboardIR
 * @typedef {import('../model/types.js').ZoneIR} ZoneIR
 * @typedef {import('../model/types.js').CardPlan} CardPlan
 * @typedef {import('../model/types.js').PagePlan} PagePlan
 * @typedef {import('../model/types.js').LayoutPlan} LayoutPlan
 * @typedef {import('../model/types.js').FieldBindings} FieldBindings
 * @typedef {import('../model/types.js').ConvertOptions} ConvertOptions
 * @typedef {import('../model/types.js').Issue} Issue
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 * @typedef {{ contentKey: number, type: 'CARD'|'HEADER'|'VARIABLE'|'BUTTON'|'TABS'|'SPACER'|'BLOCK', box: Box, frame?: import('./tile.js').Frame, minWidth?: number, order: number, chartType?: string, controlType?: string, control?: 'filter'|'variable'|'panel', phone?: number, banner?: boolean, image?: boolean, compactRows?: number, hostKey?: number, attach?: { bottom: boolean, x: number }, compactBox?: Box }} Placed
 *   `box`: natural height before tiling, the final box after; `frame`: the zone in grid units that tiling lays it out from;
 *   `control`: filter cards, variable controls and the filter section, grouped after the title on a phone; `phone`: position in
 *   Tableau's custom phone layout; BLOCK: packed control rows on a classic page, replaced by its controls after tiling;
 *   `banner`: a status text card or header image, a full-width row like a header, `compactRows` its phone height; `image`: an image card;
 *   `hostKey`: the card a button sits over (attachButtons),
 *   whose `compactBox` is its box before its buttons took their rows
 */

export const STANDARD_WIDTH = 60;
export const COMPACT_WIDTH = 12;
export const MIN_CARD_HEIGHT = 6;
export const HEADER_HEIGHT = 5;
export const COMPACT_HEADER_HEIGHT = 2;
const COMPACT_BUTTON_HEIGHT = 1;
export const ASPECT_RATIO = 1.67;
const COLUMN_PX = 1268 / STANDARD_WIDTH;
// Theme header fonts h1 and h2 (f2 32px, f3 24px) and the card title font (f4 18px).
const HEADER_FONT_PX = { h1: 32, h2: 24 };
const CARD_TITLE_PX = 18;
const CHAR_EM = 0.55;
const HEADER_PAD_PX = 16;
const CARD_PAD_PX = 48;
// Theme notebook text (contentTextFont f6, 14px) and padding (12 a side), plus the template framePadding (8 a side).
const NOTEBOOK_FONT_PX = 14;
const NOTEBOOK_LINE_PX = 21;
const NOTEBOOK_PAD_PX = 40;
const COMPACT_ROW_PX = 31.5;
export const MAX_TEXT_LINES = 6;
// Longer top-band text in a text zone is body text (a glossary, a definitions view), not the view's title.
const MAX_TITLE_LINES = 2;
// More filter cards and variable controls than this on a dashboard go into one "Filters" section.
export const FILTER_PANEL_THRESHOLD = 6;
const MIN_FILTER_WIDTH = 8;
const MAX_FILTER_WIDTH = 20;
export const MAX_HEADER_TEXT = 254;
export const APP_TEXT_LIMIT = 250;
export const MAX_TITLE = 254;
export const BUILTIN_THEMES = ['Clarion', 'Impact', 'Essential', 'Obsidian', 'Midnight', 'Domo Classic', 'Saturated Brand', 'Subtle Brand', 'Domo Retro', 'Domo Neutral'];
export const DEFAULT_THEME = 'Clarion';
export const NOTEBOOK_HEIGHT = 6;
const APP_TEXT_TYPES = new Set(['HEADER', 'BUTTON', 'TAB_CONTENT']);
export const MIN_WIDTH = MIN_TILE_WIDTH;
export const MIN_CONTROL_WIDTH = 10;
export const MIN_CONTROL_HEIGHT = 10;
// A dropdown filter card or variable control with the unpadded control style.
export const CONTROL_HEIGHT = 5;
const COMPACT_MAX_HEIGHT = 24;
const DEFAULT_SIZE = { width: 1200, height: 800 };
const GRID_CARD = { width: 30, height: 30 };
const FILTER_CARD_CHART_VERSION = '12';

/** Dashboard size in pixels; automatic sizing is assumed to be 1200x800. */
export function dashboardPixels(dashboard) {
	const size = dashboard?.size ?? {};
	if (size.mode !== 'automatic' && size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
	if (size.mode === 'range' && size.width > 0) return { width: size.width, height: size.height > 0 ? size.height : DEFAULT_SIZE.height };
	return { ...DEFAULT_SIZE };
}

/**
 * Scale a zone rect (fractions 0..1) to the 60-column grid, keeping the dashboard's proportions: a row is
 * 1 / ASPECT_RATIO of a column.
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @param {{ width: number, height: number }} px
 * @param {{ minHeight?: number }} [opts]
 * @returns {Box}
 */
export function scaleRect(rect, px, { minHeight = MIN_CARD_HEIGHT } = {}) {
	const unitPx = px.width / STANDARD_WIDTH;
	const rows = (px.height / unitPx) * ASPECT_RATIO;
	let width = Math.min(STANDARD_WIDTH, Math.max(MIN_WIDTH, Math.round((rect?.w ?? 0) * STANDARD_WIDTH)));
	let x = Math.max(0, Math.round((rect?.x ?? 0) * STANDARD_WIDTH));
	if (x + width > STANDARD_WIDTH) x = Math.max(0, STANDARD_WIDTH - width);
	width = Math.min(width, STANDARD_WIDTH - x);
	const y = Math.max(0, Math.round((rect?.y ?? 0) * rows));
	const height = Math.max(minHeight, Math.round((rect?.h ?? 0) * rows));
	return { x, y, width, height };
}

/** A zone rect in grid units, unrounded: the frame tile() lays the item out from. */
export function frameOf(rect, px) {
	const rows = (px.height / (px.width / STANDARD_WIDTH)) * ASPECT_RATIO;
	return { x: (rect?.x ?? 0) * STANDARD_WIDTH, y: (rect?.y ?? 0) * rows, w: (rect?.w ?? 0) * STANDARD_WIDTH, h: (rect?.h ?? 0) * rows };
}

/** Smallest frame holding all of `frames`. */
export function frameBounds(frames) {
	const x = Math.min(...frames.map((f) => f.x));
	const y = Math.min(...frames.map((f) => f.y));
	return { x, y, w: Math.max(...frames.map((f) => f.x + f.w)) - x, h: Math.max(...frames.map((f) => f.y + f.h)) - y };
}

const MAP_CHART = /(^|_)map(_|$)/;

/**
 * Smallest standard height (rows) at which a card of this chart type shows its title, summary and content. Tableau
 * tiles are often a strip of text, which a Domo card clips below these.
 */
export function minCardHeight(chartType) {
	const type = String(chartType ?? '');
	if (!type) return MIN_CARD_HEIGHT;
	if (/checkbox|radio/.test(type)) return 12;
	if (/_selector$/.test(type)) return MIN_CONTROL_HEIGHT;
	if (type === 'badge_singlevalue') return 10;
	if (type === 'badge_multi_value') return 12;
	if (/pivot/.test(type)) return 20;
	if (/table/.test(type)) return 12;
	if (/small_multiple|trellis/.test(type)) return 24;
	if (MAP_CHART.test(type)) return 20;
	return 16;
}

const APP_SELECTOR_HEIGHT = { badge_date_selector: 8, badge_range_selector: 8 };

/**
 * View style of every app view: no spacing between items and no view margins. With the
 * theme's spacing an 8-row range selector draws no Minimum/Maximum labels. Push
 * fills in `sourceId`, the app theme's page style.
 */
export const APP_VIEW_STYLE = { density: { standard: 0 }, margin: { standard: { top: 0, bottom: 0, left: 0, right: 0 } } };

/**
 * Smallest standard height of a filter card or variable control. In an app (with the unpadded control style push sets,
 * applyControlSpacing): range and date selectors 8 rows; dropdowns and variable controls as the user sized them in a
 * section, whose density is 0, and a row more elsewhere (5 rows clip a control there); a radio button control lists its
 * values like a checkbox or radio filter card. On a classic page, which has no control style, the card minimums.
 * @param {{ type: string, chartType?: string, controlType?: string }} placed
 * @param {{ app?: boolean, section?: boolean }} [opts]
 */
export function controlHeight(placed, { app = false, section = false } = {}) {
	const variable = placed.type === 'VARIABLE';
	const lists = variable ? placed.controlType === 'RADIOS' : /checkbox|radio/.test(String(placed.chartType ?? ''));
	if (!app || lists) return variable ? MIN_CONTROL_HEIGHT : minCardHeight(placed.chartType);
	if (!variable && APP_SELECTOR_HEIGHT[placed.chartType]) return APP_SELECTOR_HEIGHT[placed.chartType];
	return section ? CONTROL_HEIGHT : CONTROL_HEIGHT + 1;
}

/** Smallest compact height (rows, 31.5 px each) per item type and chart type. */
export function minCompactHeight(type, chartType) {
	if (type === 'HEADER') return COMPACT_HEADER_HEIGHT;
	if (type === 'BUTTON') return COMPACT_BUTTON_HEIGHT;
	if (type === 'VARIABLE') return 4;
	const chart = String(chartType ?? '');
	if (chart === 'document') return COMPACT_HEADER_HEIGHT;
	if (/checkbox|radio/.test(chart)) return 5;
	if (/_selector$/.test(chart)) return 4;
	if (chart === 'badge_singlevalue') return 4;
	if (chart === 'badge_multi_value') return 5;
	if (/pivot/.test(chart)) return 8;
	if (/small_multiple|trellis/.test(chart)) return 10;
	if (MAP_CHART.test(chart)) return 8;
	return MIN_CARD_HEIGHT;
}

/** Compact height of a leaf item: its standard proportions at width 12, at least its type's minimum; controls stay small. */
export function compactHeight(placed) {
	if (placed.type === 'SPACER') return 0;
	const min = minCompactHeight(placed.type, placed.chartType);
	if (placed.type === 'HEADER' || placed.type === 'BUTTON' || placed.control || placed.banner) return Math.max(min, placed.compactRows ?? 0);
	if (placed.chartType === 'notebook' && placed.compactRows !== undefined) return Math.max(COMPACT_HEADER_HEIGHT, placed.compactRows);
	const box = placed.compactBox ?? placed.box;
	const proportional = Math.round((box.height * COMPACT_WIDTH) / (Math.max(1, box.width) * ASPECT_RATIO));
	return Math.max(min, Math.min(COMPACT_MAX_HEIGHT, proportional));
}

const boxOf = (p) => p.compactBox ?? p.box;
const readingOrder = (a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).x - boxOf(b).x || a.order - b.order;

/**
 * Phone order: Tableau's custom phone layout when the items carry `phone` (items it leaves out follow in reading order),
 * else reading order with the leading headers and status text cards first, then the controls, then everything else. A
 * button over a card comes right before it (after it when it sits at the card's bottom).
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Placed} placedOf
 * @returns {T[]}
 */
export function compactOrder(items, placedOf = (x) => x) {
	const reading = [...items].sort((a, b) => readingOrder(placedOf(a), placedOf(b)));
	let ordered;
	if (reading.some((x) => placedOf(x).phone !== undefined)) ordered = reading.sort((a, b) => (placedOf(a).phone ?? Infinity) - (placedOf(b).phone ?? Infinity));
	else {
		const firstOther = reading.findIndex((x) => placedOf(x).type !== 'HEADER' && !placedOf(x).banner);
		const rest = firstOther < 0 ? [] : reading.slice(firstOther);
		ordered = firstOther < 0 ? reading : [...reading.slice(0, firstOther), ...rest.filter((x) => placedOf(x).control), ...rest.filter((x) => !placedOf(x).control)];
	}
	const keys = new Set(ordered.map((x) => placedOf(x).contentKey));
	const attached = ordered.filter((x) => placedOf(x).hostKey !== undefined && keys.has(placedOf(x).hostKey));
	if (!attached.length) return ordered;
	const byX = (a, b) => placedOf(a).attach.x - placedOf(b).attach.x;
	const on = (host, bottom) => attached.filter((b) => placedOf(b).hostKey === placedOf(host).contentKey && placedOf(b).attach.bottom === bottom).sort(byX);
	return ordered.filter((x) => !attached.includes(x)).flatMap((x) => [...on(x, false), x, ...on(x, true)]);
}

/**
 * Stack items full width in phone order, as the editor adds every compact item.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Placed} placedOf
 * @param {(item: T) => number} heightOf
 * @returns {{ boxes: [T, Box][], height: number }}
 */
export function stackCompact(items, placedOf, heightOf) {
	const boxes = [];
	let y = 0;
	for (const item of compactOrder(items, placedOf)) {
		const height = heightOf(item);
		boxes.push([item, { x: 0, y, width: COMPACT_WIDTH, height }]);
		y += height;
	}
	return { boxes, height: y };
}

/**
 * Compact (phone) template: full width in phone order (compactOrder), heights from compactHeight.
 * @param {Placed[]} items
 */
export function compactTemplate(items) {
	return stackCompact(items, (p) => p, compactHeight).boxes.map(([item, box]) => templateItem(item.contentKey, item.type, box));
}

/**
 * Header lines for text: Tableau line breaks kept, each line wrapped to what one HEADER shows at `width` columns. A word
 * too long for the width gets a line of its own (the header truncates it); only one longer than a full-width line is cut.
 */
export function wrapText(text, width, fontPx = HEADER_FONT_PX.h1, { columnPx = COLUMN_PX, padPx = HEADER_PAD_PX } = {}) {
	const fits = (cols) => Math.max(8, Math.floor((cols * columnPx - padPx) / (fontPx * CHAR_EM)));
	const capacity = fits(width);
	const longest = fits(STANDARD_WIDTH);
	const lines = [];
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		let line = '';
		for (let word of raw.split(/\s+/).filter(Boolean)) {
			while (word.length > capacity) {
				if (line) lines.push(line);
				line = '';
				const cut = word.length > longest ? longest : word.length;
				lines.push(word.slice(0, cut));
				word = word.slice(cut);
			}
			if (!word) continue;
			if (!line) line = word;
			else if (line.length + 1 + word.length <= capacity) line += ` ${word}`;
			else {
				lines.push(line);
				line = word;
			}
		}
		if (line) lines.push(line);
	}
	return lines;
}

/**
 * HEADER lines for dashboard text. App Studio draws a HEADER on one line, truncated, and resizes it to HEADER_HEIGHT,
 * so long text becomes one HEADER per wrapped line. In an
 * app, body text and titles that do not fit on one line use the smaller h2 header style.
 * @param {string} text
 * @param {number} width  Columns
 * @param {{ app?: boolean, title?: boolean, fontSize?: number }} [opts]  `fontSize`: the largest Tableau run size
 * @returns {{ lines: string[], style?: { sourceId: string, textColor: null }, cut: boolean }}
 */
export function headerLines(text, width, { app = false, title = false, fontSize } = {}) {
	let lines = wrapText(text, width, HEADER_FONT_PX.h1);
	let style;
	const large = title || (fontSize ?? 0) >= 15;
	if (app && (lines.length > 1 || !large)) {
		lines = wrapText(text, width, HEADER_FONT_PX.h2);
		style = { sourceId: 'h2', textColor: null };
	}
	const cut = lines.length > MAX_TEXT_LINES;
	if (cut) {
		lines = lines.slice(0, MAX_TEXT_LINES);
		const last = lines[MAX_TEXT_LINES - 1];
		lines[MAX_TEXT_LINES - 1] = `${last.slice(0, Math.max(1, last.length - 3)).trimEnd()}...`;
	}
	return { lines, ...(style ? { style } : {}), cut };
}

/**
 * Rows a full-width text card needs for its paragraphs, wrapped at the view's width (at least NOTEBOOK_HEIGHT). Calibrated
 * on ChatBot's status card: one line fits 6 standard rows, two need 7.
 * @param {string[]} lines  One string per paragraph
 * @param {{ compact?: boolean }} [opts]
 */
export function notebookHeight(lines, { compact = false } = {}) {
	const columnPx = compact ? COMPACT_ROW_PX : COLUMN_PX;
	const rowPx = compact ? COMPACT_ROW_PX : COLUMN_PX / ASPECT_RATIO;
	const width = compact ? COMPACT_WIDTH : STANDARD_WIDTH;
	const count = lines.reduce((n, line) => n + Math.max(1, wrapText(line, width, NOTEBOOK_FONT_PX, { columnPx, padPx: NOTEBOOK_PAD_PX }).length), 0);
	return Math.max(NOTEBOOK_HEIGHT, Math.ceil((NOTEBOOK_PAD_PX + count * NOTEBOOK_LINE_PX) / rowPx));
}

/** Columns a filter card or control needs to show its title untruncated. */
export function titleWidth(title, min = MIN_FILTER_WIDTH) {
	const cols = Math.ceil((String(title ?? '').length * CARD_TITLE_PX * CHAR_EM + CARD_PAD_PX) / COLUMN_PX);
	return Math.max(min, Math.min(MAX_FILTER_WIDTH, cols));
}

const CONTROL_SLOT = 10;

const CONTROL_KINDS = new Set(['filter', 'paramctrl']);
// Members this share of their container's height fill it.
const STACK_FILL = 0.95;

/**
 * `stack`: the vertical container a control zone sits in, which its column in a Filters section keeps. `stackFill`: the
 * container's child count when they are all controls covering its height, which a short column then stretches over.
 */
function controlStack(zone, dash) {
	const parent = (dash?.containers ?? []).find((c) => c.id === zone.parent);
	if (parent?.direction !== 'vertical') return {};
	const leaves = [...(dash.zones ?? []), ...(dash.floating ?? [])];
	const children = parent.children.map((id) => leaves.find((z) => z.id === id));
	const covered = children.reduce((n, z) => n + (z?.rect?.h ?? 0), 0);
	const fills = children.length > 0 && children.every((z) => CONTROL_KINDS.has(z?.kind)) && covered >= STACK_FILL * (parent.rect?.h ?? Infinity);
	return fills ? { stack: parent.id, stackFill: children.length } : { stack: parent.id };
}

/** Heights summing to `total` in proportion to the members' Tableau heights; undefined when one is below its minimum. */
function stretchMembers(members, total, height) {
	const tableau = members.reduce((n, m) => n + m.placed.frame.h, 0);
	let cum = 0;
	let prev = 0;
	const out = members.map((m) => {
		cum += m.placed.frame.h;
		const edge = Math.round((total * cum) / tableau);
		const h = edge - prev;
		prev = edge;
		return h;
	});
	return out.every((h, i) => h >= height(members[i])) ? out : undefined;
}
// Tableau columns this close in width (widest over narrowest) get equal widths.
const EVEN_COLUMNS = 1.15;

const evenWidths = (weights) => Math.max(...weights) <= Math.min(...weights) * EVEN_COLUMNS;

/** Split `total` columns by `weights` (largest remainder), each at least its `mins` entry when they fit. */
export function spreadWidths(weights, mins, total) {
	const w = weights.map((x) => (evenWidths(weights) ? 1 : Math.max(x, 0.01)));
	const fixed = new Set();
	let exact;
	for (;;) {
		const free = total - [...fixed].reduce((n, i) => n + mins[i], 0);
		const sum = w.reduce((n, x, i) => (fixed.has(i) ? n : n + x), 0);
		exact = w.map((x, i) => (fixed.has(i) ? mins[i] : (x * free) / sum));
		const under = exact.findIndex((x, i) => !fixed.has(i) && x < mins[i]);
		if (under < 0 || fixed.size === w.length - 1) break;
		fixed.add(under);
	}
	const out = exact.map(Math.floor);
	const byRemainder = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	const short = total - out.reduce((n, x) => n + x, 0);
	for (let k = 0; k < short; k += 1) out[byRemainder[k % out.length][1]] += 1;
	return out;
}

/** Rows of 10-column slots (the editor's control width) in reading order, more when the title needs them. */
function reflowControls(controls, height) {
	const rows = [];
	let x = STANDARD_WIDTH;
	for (const c of [...controls].sort((a, b) => readingOrder(a.placed, b.placed))) {
		const needed = titleWidth(c.label, c.placed.type === 'VARIABLE' ? MIN_CONTROL_WIDTH : MIN_FILTER_WIDTH);
		const width = Math.min(STANDARD_WIDTH, Math.ceil(needed / CONTROL_SLOT) * CONTROL_SLOT);
		if (x + width > STANDARD_WIDTH) {
			rows.push([]);
			x = 0;
		}
		rows.at(-1).push({ c, x, width, height: height(c) });
		x += width;
	}
	let y = 0;
	const boxes = [];
	const spacers = [];
	for (const row of rows) {
		const h = Math.max(...row.map((r) => r.height));
		for (const r of row) boxes.push({ c: r.c, x: r.x, y, width: r.width, height: h });
		const end = row.at(-1).x + row.at(-1).width;
		if (end < STANDARD_WIDTH) spacers.push({ x: end, y, width: STANDARD_WIDTH - end, height: h });
		y += h;
	}
	return { height: y, boxes, spacers };
}

/**
 * Tableau's arrangement: controls in one vertical container (`placed.stack`) form a column, side-by-side columns a band,
 * at their Tableau widths scaled so the widest band fills the row; a band too narrow for its minimum widths wraps evenly.
 */
function tableauControls(controls, height) {
	const columns = new Map();
	for (const c of controls) {
		const key = c.placed.stack ?? c;
		if (!columns.has(key)) columns.set(key, []);
		columns.get(key).push(c);
	}
	const list = [...columns.values()].map((members) => {
		members.sort((a, b) => a.placed.frame.y - b.placed.frame.y || a.placed.frame.x - b.placed.frame.x);
		const frame = frameBounds(members.map((m) => m.placed.frame));
		const min = Math.max(...members.map((m) => (m.placed.type === 'VARIABLE' ? MIN_CONTROL_WIDTH : MIN_FILTER_WIDTH)));
		return { members, frame, min };
	});
	const bands = [];
	for (const col of list.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)) {
		const band = bands.find((b) => col.frame.y < b.bottom - EPS && b.top < col.frame.y + col.frame.h - EPS);
		if (band) {
			band.columns.push(col);
			band.bottom = Math.max(band.bottom, col.frame.y + col.frame.h);
		} else bands.push({ columns: [col], top: col.frame.y, bottom: col.frame.y + col.frame.h });
	}
	let y = 0;
	const boxes = [];
	const spacers = [];
	const spanOf = (cols) => Math.max(...cols.map((c) => c.frame.x + c.frame.w)) - Math.min(...cols.map((c) => c.frame.x));
	const scale = STANDARD_WIDTH / Math.max(...bands.map((b) => spanOf(b.columns)));
	const fits = (cols, perRow) => Array.from({ length: Math.ceil(cols.length / perRow) }, (_, r) => cols.slice(r * perRow, (r + 1) * perRow)).every((row) => row.reduce((n, c) => n + c.min, 0) <= STANDARD_WIDTH);
	for (const band of bands) {
		const cols = band.columns.sort((a, b) => a.frame.x - b.frame.x);
		let rowCount = Math.ceil(cols.reduce((n, c) => n + c.min, 0) / STANDARD_WIDTH);
		while (!fits(cols, Math.ceil(cols.length / rowCount))) rowCount += 1;
		const perRow = Math.ceil(cols.length / rowCount);
		for (let start = 0; start < cols.length; start += perRow) {
			const row = cols.slice(start, start + perRow);
			const mins = row.map((c) => c.min);
			const step = evenWidths(row.map((c) => c.frame.w)) ? row.length : 1;
			const total = rowCount > 1 ? STANDARD_WIDTH : Math.min(STANDARD_WIDTH, Math.max(mins.reduce((n, m) => n + m, 0), step * Math.round((spanOf(row) * scale) / step)));
			const widths = spreadWidths(row.map((c) => c.frame.w), mins, total);
			const depth = Math.max(...row.map((c) => c.members.length));
			const rowHeights = Array.from({ length: depth }, (_, i) => Math.max(0, ...row.map((c) => (c.members[i] ? height(c.members[i]) : 0))));
			const tops = rowHeights.map((_, i) => y + rowHeights.slice(0, i).reduce((n, h) => n + h, 0));
			const bottom = y + rowHeights.reduce((n, h) => n + h, 0);
			let x = 0;
			row.forEach((col, i) => {
				const fills = col.members.length < depth && col.members.every((m) => m.placed.stackFill === col.members.length);
				const stretched = fills ? stretchMembers(col.members, bottom - y, height) : undefined;
				if (stretched) {
					let top = y;
					col.members.forEach((m, j) => {
						boxes.push({ c: m, x, y: top, width: widths[i], height: stretched[j] });
						top += stretched[j];
					});
					x += widths[i];
					return;
				}
				col.members.forEach((m, j) => boxes.push({ c: m, x, y: tops[j], width: widths[i], height: rowHeights[j] }));
				const end = col.members.length < depth ? tops[col.members.length] : bottom;
				if (end < bottom) spacers.push({ x, y: end, width: widths[i], height: bottom - end });
				x += widths[i];
			});
			if (total < STANDARD_WIDTH) spacers.push({ x: total, y, width: STANDARD_WIDTH - total, height: bottom - y });
			y = bottom;
		}
	}
	return { height: y, boxes, spacers };
}

/**
 * Pack controls into the 60-column grid in Tableau's columns unless that is taller than the reflow (a sidebar stack);
 * each row as tall as its tallest control, the rest of a row a SPACER as the editor leaves it. Mutates the boxes.
 * @param {{ placed: Placed, label?: string }[]} controls
 * @param {{ app?: boolean }} [opts]  `app`: packed into a Filters section (controlHeight)
 * @returns {{ height: number, spacers: Box[], tableau: boolean }}
 */
export function packControls(controls, { app = false } = {}) {
	const height = (c) => controlHeight(c.placed, { app, section: app });
	const reflowed = reflowControls(controls, height);
	const kept = controls.every((c) => c.placed.frame) ? tableauControls(controls, height) : undefined;
	const chosen = kept && kept.height <= reflowed.height ? kept : reflowed;
	for (const { c, x, y, width, height: h } of chosen.boxes) {
		Object.assign(c.placed.box, { x, y, width, height: h });
		c.placed.frame = { x, y, w: width, h };
	}
	return { height: chosen.height, spacers: chosen.spacers, tableau: chosen === kept };
}

function templateItem(contentKey, type, box) {
	return { contentKey, x: box.x, y: box.y, width: box.width, height: box.height, type, virtual: false, virtualAppendix: false };
}

/**
 * A CARD content item with the editor's defaults. The description
 * shows when the card has a smart text description (a Tableau title with <Data Update Time>).
 * @param {number} contentKey
 * @param {string} cardKey
 * @param {{ showDescription?: boolean }} [opts]
 */
export function cardContent(contentKey, cardKey, { showDescription = false } = {}) {
	return {
		contentKey,
		type: 'CARD',
		cardId: ref('card', cardKey),
		acceptFilters: true,
		acceptDateFilter: true,
		acceptSegments: true,
		fitToFrame: false,
		hasSummary: false,
		hideBorder: false,
		hideFooter: true,
		hideMargins: false,
		hideSummary: false,
		hideTimeframe: false,
		hideTitle: false,
		hideDescription: !showDescription,
		hideWrench: false,
		summaryNumberOnly: false,
		editInAppViewer: true
	};
}

export const hasSmartDescription = (card) => Boolean(card?.body?.definition?.dynamicDescription?.text?.length);

/** A status text card: only its text shows, as the user's Executive Summary edit has it. */
const TABLEAU_LINK_TEXT = 'Open in Tableau';

/**
 * The Tableau url of a sheet's view: the site route of the workbook's web page, then `views/<workbook>/<sheet>` from the
 * view's content url (`WorkbookInfo.views`, listed at extract). A sheet Tableau does not publish as a view (a workbook
 * published without its sheets as tabs) links to the workbook page. Without the view list, the sheet name with spaces and
 * punctuation dropped, as Tableau names view urls. Undefined without the web page address.
 */
export function tableauViewUrl(ir, sheetName) {
	const page = String(ir?.workbook?.webpageUrl ?? '');
	const route = /^(https:\/\/[^/]+\/#\/(?:site\/[^/]+\/)?)/.exec(page);
	const workbook = ir?.workbook?.contentUrl;
	if (!route || !workbook) return undefined;
	const views = ir.workbook.views;
	if (Array.isArray(views)) {
		const view = views.find((v) => v.name === sheetName);
		return view?.contentUrl ? `${route[1]}views/${String(view.contentUrl).replace('/sheets/', '/')}` : page;
	}
	const sheet = String(sheetName ?? '').replace(/[^A-Za-z0-9]/g, '');
	return sheet ? `${route[1]}views/${encodeURIComponent(workbook)}/${sheet}` : undefined;
}

const linkParagraph = (url) => [{ text: TABLEAU_LINK_TEXT, link: url }];

/**
 * A status text card with a last paragraph linking to the view's dashboard on Tableau. The card is shared by every view
 * that shows the sheet, so the first view takes it and each further view gets a copy (key `<card>.<page>`, smart text and
 * owner ids made from the new key) with its own link. Mutates the card; copies go into `extra`.
 */
function withTableauLink(card, url, pageKey, extra) {
	if (!card.tableauLink) {
		card.tableauLink = url;
		card.body.notebook.paragraphs.push(linkParagraph(url));
		return card;
	}
	if (card.tableauLink === url) return card;
	const key = `${card.key}.${slugify(pageKey)}`;
	const existing = extra.find((c) => c.key === key);
	if (existing) return existing;
	const paragraphs = card.body.notebook.paragraphs.slice(0, -1).map((segments) => segments.map((s) => ('id' in s ? { ...s, id: uuidv5(`notebook|${key}|${s.id}`) } : { ...s })));
	const copy = { ...card, key, body: { ...card.body, notebook: { ...card.body.notebook, paragraphs: [...paragraphs, linkParagraph(url)] } }, pageKeys: [], tableauLink: url };
	extra.push(copy);
	return copy;
}

/** A text card just for the Tableau link, for a view with no status text card. */
function tableauLinkCard(pageKey, name, url) {
	const title = `${name} on Tableau`;
	return { key: `${pageKey}.tableau-link`, kind: 'notebook', title, worksheet: '', datasetKey: '', chartType: 'notebook', body: { notebook: { title, paragraphs: [linkParagraph(url)] } }, pageKeys: [pageKey], status: 'ok', tableauLink: url };
}

const segmentColors = (card) => card.body.notebook.paragraphs.flat().map((seg) => seg.color).filter(Boolean);

/** False when a text card has text colored like the view background (a status line made for a dark header fill). */
export function showsColors(card, background) {
	const backdrop = colorTone(opaqueHex(background) ?? '#FFFFFF');
	return segmentColors(card).every((color) => Math.abs(colorTone(color) - backdrop) >= LOGO_MIN_CONTRAST);
}

/** The view's copy of a text card without its colors (key `<card>.<page>.plain`), for a view it would not show on. */
function uncolored(card, pageKey, extra) {
	const key = `${card.key}.${slugify(pageKey)}.plain`;
	const existing = extra.find((c) => c.key === key);
	if (existing) return existing;
	const plain = (source) => {
		const seg = { ...source };
		delete seg.color;
		return 'id' in seg ? { ...seg, id: uuidv5(`notebook|${key}|${seg.id}`) } : seg;
	};
	const paragraphs = card.body.notebook.paragraphs.map((segments) => segments.map(plain));
	const copy = { ...card, key, body: { ...card.body, notebook: { ...card.body.notebook, paragraphs } }, pageKeys: [] };
	extra.push(copy);
	return copy;
}

export function notebookContent(contentKey, cardKey) {
	return { ...cardContent(contentKey, cardKey), hideTitle: true, hideWrench: true, editInAppViewer: false };
}

// A header image: 9 rows standard, 6 compact, the dashboard title right below it.
export const BANNER_IMAGE_HEIGHT = 9;
export const COMPACT_BANNER_IMAGE_HEIGHT = 6;
const BANNER_MIN_WIDTH = 0.8;
const BANNER_MAX_TOP = 0.15;
const MAX_TITLE_LOGO_WIDTH = 20;
const LOGO_MIN_CONTRAST = 0.25;
// A document card shorter than this crops its image.
const STACKED_LOGO_ROWS = 4;
const SMALLEST_TEXT_PT = 10;
const ZONE_EPS = 0.002;

/** An image (document) card item: no title or menu; fitToFrame (cover) unless Tableau fits the image (contain). */
export function imageContent(contentKey, cardKey, zone) {
	return { ...cardContent(contentKey, cardKey), hideTitle: true, hideWrench: true, fitToFrame: zone.fit !== 'fit' };
}

/** The document card of an image zone with its package bytes; one per view, as the user made them. */
export function imageCard(pageKey, zone) {
	return { key: `${pageKey}.image.${slugify(zone.id)}`, kind: 'image', title: zone.image.name, worksheet: '', datasetKey: '', chartType: 'document', body: { image: { ...zone.image } }, pageKeys: [pageKey], status: 'ok' };
}

const isBannerZone = (zone) => zone.rect.w >= BANNER_MIN_WIDTH && zone.rect.y < BANNER_MAX_TOP;
const zonesOverlap = (a, b) => a.x < b.x + b.w - ZONE_EPS && b.x < a.x + a.w - ZONE_EPS && a.y < b.y + b.h - ZONE_EPS && b.y < a.y + a.h - ZONE_EPS;

/** False for an image about as light or dark as the view background (a white logo made for a filled title row). */
export function showsOnBackground(image, background) {
	const backdrop = colorTone(opaqueHex(background) ?? '#FFFFFF');
	return image?.tone === undefined || Math.abs(image.tone - backdrop) >= LOGO_MIN_CONTRAST;
}

const TEXT_RULES = { title: 'dash-title', text: 'dash-text' };
const ruleBackground = (rules, element) => (rules ?? []).filter((r) => r.element === element).flatMap((r) => r.formats).findLast((f) => f.attr === 'background-color' && !f.id && !f.field)?.value;

/** A title or text zone's fill: its own, else its dashboard's then the workbook's dash-title (dash-text) style rule. */
export function textZoneFill(zone, dash, ir) {
	const element = TEXT_RULES[zone?.kind];
	return opaqueHex(zone?.style?.background ?? (element ? (ruleBackground(dash?.styleRules, element) ?? ruleBackground(ir?.style?.rules, element)) : undefined));
}

/** The title's fill (`#RRGGBB`) a logo's title row keeps as a section, when it differs from the view background and the logo shows on it. */
export function titleRowFill(image, fill, background) {
	if (!fill || fill === (opaqueHex(background) ?? '#FFFFFF')) return undefined;
	return showsOnBackground(image, fill) ? fill : undefined;
}

const titleLogoWidth = (zone) => Math.min(MAX_TITLE_LOGO_WIDTH, Math.max(MIN_TILE_WIDTH, Math.round(zone.rect.w * STANDARD_WIDTH)));

/**
 * How each image zone of a dashboard converts: `banner` (full width near the top, tiled or floating), `tile` (another tiled
 * image), `frame` (floating over nothing), `title` (floating over a title or text zone, `on` its id: on that title's row)
 * or `overlay` (floating over other zones, such as a logo on a banner: dropped). Beneath counts Tableau's z-order only:
 * the tiled zones and the floating ones listed before the image; blank zones are nothing.
 * @param {DashboardIR} dash
 * @returns {Map<ZoneIR, { role: 'banner'|'tile'|'frame'|'title'|'overlay', on?: string }>}
 */
export function imageRoles(dash) {
	const tiled = (dash.zones ?? []).filter((z) => !z.floating);
	const floats = [...(dash.floating ?? []), ...(dash.zones ?? []).filter((z) => z.floating)];
	const roles = new Map();
	for (const zone of tiled) if (zone.kind === 'image') roles.set(zone, { role: isBannerZone(zone) ? 'banner' : 'tile' });
	floats.forEach((zone, i) => {
		if (zone.kind !== 'image') return;
		if (isBannerZone(zone)) return roles.set(zone, { role: 'banner' });
		const beneath = [...tiled, ...floats.slice(0, i)].filter((b) => b.kind !== 'blank' && zonesOverlap(b.rect, zone.rect));
		if (!beneath.length) return roles.set(zone, { role: 'frame' });
		const title = beneath.findLast((b) => b.kind === 'title' || b.kind === 'text');
		roles.set(zone, title ? { role: 'title', on: title.id } : { role: 'overlay' });
	});
	return roles;
}

const MIN_HOST_SHARE = 0.5;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Floating buttons over a card: App Studio cannot overlap items, so each button attaches to the card whose zone covers at
 * least half of it (the largest share) and takes rows of that card's box after tiling (placeButtons). A button with no
 * such card keeps a row of its own (placeFloating). Mutates the entries; returns how many buttons attached.
 */
export function attachButtons(entries) {
	const hosts = entries.filter((e) => e.placed.type === 'CARD' && !e.placed.control && !e.placed.banner && e.placed.frame);
	let attached = 0;
	for (const b of entries) {
		const f = b.placed.frame;
		if (!b.floating || b.placed.type !== 'BUTTON' || !f || !(f.w * f.h > 0)) continue;
		let host;
		let best = 0;
		for (const h of hosts) {
			const share = overlapArea(f, h.placed.frame) / (f.w * f.h);
			if (share >= MIN_HOST_SHARE && share > best) [host, best] = [h, share];
		}
		if (!host) continue;
		const hf = host.placed.frame;
		b.host = host;
		Object.assign(b.placed, { hostKey: host.placed.contentKey, attach: { bottom: f.y + f.h / 2 > hf.y + hf.h / 2, x: f.x } });
		(host.buttons ??= []).push(b);
		attached += 1;
	}
	return attached;
}

/** Undo attachButtons for one button: it gets a row of its own. */
export function detachButton(b) {
	if (!b.host) return;
	b.host.buttons = b.host.buttons.filter((x) => x !== b);
	delete b.host;
	delete b.placed.hostKey;
	delete b.placed.attach;
}

const buttonGroups = (host) => [false, true].map((bottom) => host.buttons.filter((b) => b.placed.attach.bottom === bottom).sort((a, b) => a.placed.attach.x - b.placed.attach.x));
const rowsFor = (count, width) => (count ? Math.ceil(count / Math.max(1, Math.floor(width / MIN_NARROW_WIDTH))) : 0);

/** Natural height of a card with its buttons: the card's, or the button rows plus the card's minimum when that is more. */
export function hostHeight(e) {
	if (!e.buttons?.length) return e.placed.box.height;
	const width = Math.max(MIN_TILE_WIDTH, Math.round(e.placed.frame?.w ?? e.placed.box.width));
	const rows = buttonGroups(e).reduce((n, group) => n + rowsFor(group.length, width), 0);
	return Math.max(e.placed.box.height, rows * BUTTON_HEIGHT + minCardHeight(e.placed.chartType));
}

/**
 * Give a tiled card's buttons its top BUTTON_HEIGHT rows (its bottom ones for buttons in the lower half of its zone), the
 * width split between them in x order, more rows when they do not fit at MIN_NARROW_WIDTH; the card keeps the rest.
 * Mutates the boxes.
 */
export function placeButtons(host) {
	if (!host.buttons?.length) return;
	const box = host.placed.box;
	host.placed.compactBox = { ...box };
	const [top, bottom] = buttonGroups(host);
	const perRow = Math.max(1, Math.floor(box.width / MIN_NARROW_WIDTH));
	const lay = (group, y0) => {
		for (let r = 0; r * perRow < group.length; r++) {
			const row = group.slice(r * perRow, (r + 1) * perRow);
			const widths = apportion(box.width, row.map(() => 1));
			let x = box.x;
			row.forEach((b, i) => {
				Object.assign(b.placed.box, { x, y: y0 + r * BUTTON_HEIGHT, width: widths[i], height: BUTTON_HEIGHT });
				x += widths[i];
			});
		}
	};
	const topRows = rowsFor(top.length, box.width) * BUTTON_HEIGHT;
	const bottomRows = rowsFor(bottom.length, box.width) * BUTTON_HEIGHT;
	lay(top, box.y);
	lay(bottom, box.y + box.height - bottomRows);
	Object.assign(box, { y: box.y + topRows, height: box.height - topRows - bottomRows });
}

/** Tile items of the given entries with attached buttons left out of tiling and placed over their cards after it. */
export function tileWithButtons(entries, toItem, run) {
	const tiled = entries.filter((e) => !e.host);
	const items = tiled.map((e) => ({ ...toItem(e), height: hostHeight(e) }));
	const result = run(items);
	for (const item of items) Object.assign(item.entry.placed.box, result.boxes.get(item));
	for (const e of tiled) placeButtons(e);
	return result;
}

/**
 * Tile the top-level entries of a view (tile.js) and set their boxes: HEADER lines, status text cards, sections and packed
 * control rows become full-width rows; a packed control block's controls move into its rows; attached buttons take rows
 * of their cards. Mutates the entries.
 * @param {Object[]} entries  planDashboard entries with `placed.frame`
 * @returns {Object[]} The entries, with control blocks replaced by their controls
 */
export function tileEntries(entries) {
	const toItem = (e) => {
		const barrier = e.placed.type === 'HEADER' || Boolean(e.placed.banner) || Boolean(e.group) || Boolean(e.block);
		const minWidth = e.placed.minWidth ?? (e.placed.type === 'BUTTON' ? MIN_NARROW_WIDTH : MIN_TILE_WIDTH);
		return { entry: e, frame: e.placed.frame ?? { x: e.placed.box.x, y: e.placed.box.y, w: e.placed.box.width, h: e.placed.box.height }, minWidth, barrier, fixed: barrier, ...(e.sortKey ? { sortKey: e.sortKey } : {}) };
	};
	tileWithButtons(entries, toItem, (items) => tile(items, STANDARD_WIDTH));
	return entries.flatMap((e) => {
		if (!e.block) return [e];
		for (const c of e.block) c.placed.box.y += e.placed.box.y;
		return e.block;
	});
}

/**
 * Assemble a LayoutPlan. Every content item gets a standard and a compact template entry,
 * because cards missing from the templates fall into the appendix and do not render.
 * @param {{ content: Object, placed: Placed }[]} entries
 * @returns {LayoutPlan}
 */
export function buildLayout(entries) {
	const content = entries.map((e) => e.content);
	const standard = entries.map((e) => templateItem(e.placed.contentKey, e.placed.type, e.placed.box));
	return finishLayout(content, standard, compactTemplate(entries.map((e) => e.placed)));
}

const TEMPLATE_DEFAULTS = { aspectRatio: 1.67, frameMargin: 4, framePadding: 8 };
// The editor saves these with no content item.
const TEMPLATE_ONLY = new Set(['TAB_BAR', 'SPACER', 'PAGE_BREAK']);
const descendants = (items) => items.flatMap((t) => [t, ...descendants(t.children ?? [])]);

/**
 * The LayoutPlan for content and templates, made what the editor saves: every content item in both templates (a card
 * missing from them falls into the appendix and does not render) and no template entry without content; every level
 * tiled (a hole becomes a SPACER when no neighbor can take it, tile.js fillHoles) and in the editor's order (sortTemplate).
 * Mutates `content` and the templates.
 * @returns {LayoutPlan}
 */
export function finishLayout(content, standard, compact) {
	const keys = new Set(content.map((c) => c.contentKey));
	for (const [template, width] of [[standard, STANDARD_WIDTH], [compact, COMPACT_WIDTH]]) {
		const present = new Set(descendants(template).map((t) => t.contentKey));
		let bottom = template.reduce((m, t) => Math.max(m, t.y + t.height), 0);
		for (const c of content) {
			if (present.has(c.contentKey) || c.type === 'TAB_CONTENT') continue;
			template.push(templateItem(c.contentKey, c.type, { x: 0, y: bottom, width, height: MIN_CARD_HEIGHT }));
			bottom += MIN_CARD_HEIGHT;
		}
		const prune = (items) => {
			for (let i = items.length - 1; i >= 0; i--) {
				if (!keys.has(items[i].contentKey) && !TEMPLATE_ONLY.has(items[i].type)) items.splice(i, 1);
				else if (items[i].children) prune(items[i].children);
			}
		};
		prune(template);
	}
	let next = Math.max(0, ...content.map((c) => c.contentKey), ...descendants(standard).map((t) => t.contentKey), ...descendants(compact).map((t) => t.contentKey)) + 1;
	const bottomOf = (template) => template.reduce((m, t) => Math.max(m, t.y + t.height), 0);
	const spacers = (other, otherWidth) => (box) => {
		const contentKey = next++;
		other.push(templateItem(contentKey, 'SPACER', { x: 0, y: bottomOf(other), width: otherWidth, height: 0 }));
		return templateItem(contentKey, 'SPACER', box);
	};
	const fillLevels = (template, width, spacer) => {
		fillHoles(template, width, bottomOf(template), spacer);
		for (const tabs of descendants(template).filter((t) => t.type === 'TABS')) {
			for (const pane of tabs.children.filter((c) => c.type === 'TAB_CONTENT')) fillHoles(pane.children ?? (pane.children = []), tabs.width, pane.height, spacer);
		}
	};
	fillLevels(standard, STANDARD_WIDTH, spacers(compact, COMPACT_WIDTH));
	fillLevels(compact, COMPACT_WIDTH, spacers(standard, STANDARD_WIDTH));
	return {
		content: content.filter((c) => !TEMPLATE_ONLY.has(c.type)),
		standard: { type: 'STANDARD', width: STANDARD_WIDTH, ...TEMPLATE_DEFAULTS, template: sortTemplate(standard) },
		compact: { type: 'COMPACT', width: COMPACT_WIDTH, ...TEMPLATE_DEFAULTS, aspectRatio: 1.0, template: sortTemplate(compact) }
	};
}

/** Two-column grid of cards, used for the root page; an odd last card takes the full width. */
export function gridLayout(cards) {
	const entries = cards.map((card, i) => {
		const contentKey = i + 1;
		const frame = { x: (i % 2) * GRID_CARD.width, y: Math.floor(i / 2) * GRID_CARD.height, w: GRID_CARD.width, h: GRID_CARD.height };
		return { content: cardContent(contentKey, card.key, { showDescription: hasSmartDescription(card) }), placed: { contentKey, type: 'CARD', box: { x: 0, y: 0, width: GRID_CARD.width, height: GRID_CARD.height }, frame, order: i } };
	});
	tileEntries(entries);
	return buildLayout(entries);
}

function makeIssue(dash, severity, code, message, suggestion) {
	const out = { severity, code, message, object: { type: 'dashboard', name: dash.name } };
	if (suggestion) out.suggestion = suggestion;
	return out;
}

function uniqueKey(base, used) {
	let key = base;
	let n = 2;
	while (used.has(key)) key = `${base}-${n++}`;
	used.add(key);
	return key;
}

/** Locate the FilterIR (or a synthetic one) a filter zone exposes. */
const zeroSize = (rect) => rect !== undefined && (rect.w === 0 || rect.h === 0);

/** Drops the dashboard zones Tableau never draws: a zone in a container, or itself, with no width or height. */
export function withoutHiddenZones(ir) {
	let changed = false;
	const dashboards = (ir?.dashboards ?? []).map((dash) => {
		const containers = new Map((dash.containers ?? []).map((c) => [c.id, c]));
		const hidden = (zone) => {
			for (let node = zone; node; node = containers.get(node.parent)) if (zeroSize(node.rect)) return true;
			return false;
		};
		const keep = (list) => list?.filter((z) => !hidden(z));
		const next = { ...dash, zones: keep(dash.zones), floating: keep(dash.floating) };
		if ((next.zones?.length ?? 0) === (dash.zones?.length ?? 0) && (next.floating?.length ?? 0) === (dash.floating?.length ?? 0)) return dash;
		changed = true;
		return next;
	});
	return changed ? { ...ir, dashboards } : ir;
}

function filterForZone(ir, zone) {
	const ws = (ir.worksheets ?? []).find((w) => w.name === zone.worksheet);
	const fromSheet = ws?.filters?.find((f) => f.pillId === zone.param);
	if (fromSheet) return { filter: fromSheet, ws };
	const pill = ws?.pills?.[zone.param] ?? parsePillId(zone.param ?? '');
	const datasourceId = pill.datasourceId || ws?.datasourceIds?.[0] || '';
	const sameField = ws?.filters?.find((f) => f.fieldId === pill.fieldId && (f.datasourceId === datasourceId || !datasourceId));
	if (sameField) return { filter: sameField, ws };
	return { filter: { pillId: zone.param, datasourceId, fieldId: pill.fieldId, kind: 'categorical', all: true, aggregated: pill.aggregated || undefined }, ws };
}

const CATEGORICAL_SELECTORS = {
	radiolist: 'badge_radio_selector',
	checklist: 'badge_checkbox_selector',
	dropdown: 'badge_dropdown_selector',
	checkdropdown: 'badge_dropdown_selector',
	compact: 'badge_dropdown_selector'
};

/** Lines of a worksheet title or label without the lines or `|` parts that hold field values (<Data Update Time>, ...). */
export function titleLines(title) {
	return String(title ?? '')
		.split(/\r?\n/)
		.map((line) => line.split(/\s*\|\s*/).filter((part) => !/<[^<>]+>/.test(part)).join(' | '))
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean);
}

/** Header text for a worksheet that only shows its title; lines or `|` parts with field values (<Data Update Time>, ...) are dropped. */
export function titleHeaderText(title, max = MAX_HEADER_TEXT) {
	return cutText(titleLines(title).join(' '), max);
}

const CONSTANT_FORMULA = /^\s*(-?\d+(\.\d+)?|"[^"]*"|'[^']*')?\s*$/;

/**
 * A text sheet that shows only static text: no shelves, and every text or label pill is a calculation with a constant
 * formula (Tableau authors use `1` on Text to hold a mark label), or its mark label holds no field. Its card would show
 * a value Tableau never draws, so it becomes a header with the mark label text (`PaneIR.label`), else the sheet title
 * when the zone shows it.
 * @returns {{ text: string, dynamic: boolean } | undefined}
 */
export function labelSheet(ws, ir, zone) {
	if (!ws || (ws.rowPills ?? []).length || (ws.colPills ?? []).length) return undefined;
	const encoded = (ws.panes ?? []).flatMap((pane) => Object.entries(pane.encodings ?? {}).flatMap(([kind, ids]) => (ids ?? []).map((id) => [kind, id])));
	if (!encoded.some(([kind]) => kind === 'text' || kind === 'label')) return undefined;
	const constant = ([kind, id]) => {
		if (kind !== 'text' && kind !== 'label' && kind !== 'tooltip') return false;
		const pill = ws.pills?.[id] ?? parsePillId(id);
		if (pill.datasourceId === 'Parameters') return true;
		const field = (ir?.datasources ?? []).find((d) => d.id === pill.datasourceId)?.fields?.find((f) => f.id === pill.fieldId);
		return field?.kind === 'calculated' && CONSTANT_FORMULA.test(String(field.formula ?? ''));
	};
	const label = (ws.panes ?? []).map((pane) => (typeof pane.label === 'string' ? pane.label : pane.label?.text)).find((t) => String(t ?? '').trim());
	const staticLabel = label !== undefined && !/<\[/.test(label);
	if (!staticLabel && !encoded.every(constant)) return undefined;
	const source = label ?? (zone?.showTitle !== false ? ws.title : undefined);
	const lines = titleLines(source);
	const parameters = encoded.some(([, id]) => (ws.pills?.[id] ?? parsePillId(id)).datasourceId === 'Parameters');
	return { text: lines.join('\n'), dynamic: parameters || /<[^<>]+>/.test(String(source ?? '')) };
}

const cutText = (text, max) => (text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text);

/**
 * App Studio rules a view layout must follow on top of the classic ones: per item, a WEBLINK interaction whose url is
 * not https is dropped (any other scheme fails the whole layout PUT), and HEADER, BUTTON and TAB_CONTENT text is cut
 * to APP_TEXT_LIMIT. Mutates the layout.
 * @param {LayoutPlan} layout
 * @param {DashboardIR|{ name: string }} dash
 * @returns {Issue[]}
 */
export function applyAppLayoutRules(layout, dash) {
	const issues = [];
	for (const item of layout?.content ?? []) {
		const interaction = item.interaction;
		if (interaction?.type === 'WEBLINK' && !isRef(interaction.config?.url) && !/^https:/i.test(String(interaction.config?.url ?? ''))) {
			delete item.interaction;
			issues.push(makeIssue(dash, 'warning', 'layout.url-action-dropped', `Link "${String(interaction.config?.url ?? '').slice(0, 100)}" was dropped from a ${item.type} item: App Studio accepts only https links`, 'Add an https link in the App Studio editor if the target supports it.'));
		}
		if (APP_TEXT_TYPES.has(item.type) && typeof item.text === 'string' && item.text.length > APP_TEXT_LIMIT) {
			issues.push(makeIssue(dash, 'warning', 'layout.text-truncated', `${item.type} text of ${item.text.length} characters cut to ${APP_TEXT_LIMIT}, the App Studio limit: "${item.text.slice(0, 60)}..."`));
			item.text = cutText(item.text, APP_TEXT_LIMIT);
		}
	}
	return issues;
}

function hasSelection(filter) {
	if (filter.kind === 'categorical') return !filter.all && Boolean((filter.include ?? filter.exclude ?? []).length);
	if (filter.kind === 'quantitative' || filter.kind === 'range-date') return filter.min !== undefined || filter.max !== undefined;
	return filter.kind === 'relative-date' || filter.kind === 'wildcard';
}

/**
 * Selector card for a dashboard filter zone. Its key carries `workbookKey` when the dataset key does not
 * (a shared published datasource dataset), so workbooks never share filter cards.
 * A filter on an aggregate selects on an aggregated dataset beast mode (`beastMode` when it is a new one), grouped by the
 * card of `grain` (the zone's worksheet), so its range and values are those of the worksheet's marks.
 * @returns {{ card?: CardPlan, beastMode?: import('../model/types.js').BeastModePlan, issues: Issue[] }}
 */
export function filterCardFor(zone, filter, binding, datasetKey, dash, workbookKey, { field, title, grain } = {}) {
	const label = binding.name ?? stripBrackets(filter.fieldId);
	if (isAggregateControl(filter, binding)) return aggregateFilterCard(zone, filter, binding, datasetKey, dash, workbookKey, { field, title, grain, label });
	const dataType = filterDataType(binding);
	const mode = String(zone.mode ?? '').toLowerCase();
	const r = refOf(binding);
	let chartType;
	let columns;
	let groupBy = [];
	let orderBy = [];
	const formulas = [];
	const overrides = {};
	let dateGrain;
	const isDate = dataType === 'date' || dataType === 'datetime' || filter.kind === 'relative-date' || filter.kind === 'range-date';
	// Tableau's range of dates (a quantitative date filter) is a range selector; relative dates stay a date selector.
	const dateRange = isDate && (filter.kind === 'quantitative' || filter.kind === 'range-date');
	if (dateRange) {
		chartType = 'badge_range_selector';
		columns = [
			{ ...r, mapping: 'MIN', aggregation: 'MIN' },
			{ ...r, mapping: 'MAX', aggregation: 'MAX' }
		];
	} else if (isDate && binding.kind === 'column') {
		chartType = 'badge_date_selector';
		columns = [
			{ column: 'Date', mapping: 'ITEM', calendar: true },
			{ column: binding.column, mapping: 'VALUE', aggregation: 'COUNT' }
		];
		groupBy = [{ column: 'Date', calendar: true }];
		dateGrain = { column: binding.column, dateTimeElement: 'DAY' };
	} else if (dataType === 'numeric' && (filter.kind === 'quantitative' || mode === 'slider')) {
		chartType = 'badge_range_selector';
		columns = [
			{ ...r, mapping: 'MIN', aggregation: 'MIN' },
			{ ...r, mapping: 'MAX', aggregation: 'MAX' }
		];
	} else {
		// No mode is Tableau's default card, "Multiple Values (list)".
		chartType = CATEGORICAL_SELECTORS[mode || 'checklist'] ?? 'badge_dropdown_selector';
		if (chartType === 'badge_dropdown_selector' && mode === 'checkdropdown') overrides.allow_multi_select = 'true';
		columns = [{ ...r, mapping: 'ITEM' }];
		groupBy = [{ ...r }];
		orderBy = [{ ...r, order: 'ASCENDING' }];
		const expr = dataType === 'string' && bindingExpression(binding);
		const calendar = /^(DAYNAME|MONTHNAME)\((.*)\)$/s.exec(binding.expression ?? '');
		if (field?.datePartOf && calendar) {
			const id = 'calculation_card_1';
			formulas.push({ id, name: `${label} (calendar order)`, formula: `MIN(${calendar[1] === 'DAYNAME' ? 'DAYOFWEEK' : 'MONTH'}(${calendar[2]}))`, templateId: -1, status: 'VALID', dataType: 'numeric', isCalculation: true, aggregated: true, persistedOnDataSource: false });
			orderBy = [{ column: id, formulaId: id, order: 'ASCENDING' }];
		} else if (expr) {
			const id = 'calculation_card_1';
			formulas.push({ id, name: `${label} (natural order)`, formula: naturalOrderKey(expr, { perGroup: true }), templateId: -1, status: 'VALID', dataType: 'string', isCalculation: true, aggregated: true, persistedOnDataSource: false });
			orderBy = [{ column: id, formulaId: id, order: 'ASCENDING' }];
		}
	}
	const key = `filter-${filterKeyScope(datasetKey, workbookKey)}${slugify(datasetKey)}-${slugify(label)}-${selectorSlug(chartType)}`;
	const format = fieldColumnFormat(field);
	if (format) for (const c of columns) if (c.column === r.column) c.format = { ...format };
	const shown = title || label;
	return { card: filterCardPlan({ key, title: shown, datasetKey, chartType, subscription: { columns, groupBy, orderBy, filters: [], dateGrain }, formulas, overrides }), issues: [] };
}

const filterKeyScope = (datasetKey, workbookKey) => (workbookKey && !datasetKey.startsWith(`${workbookKey}.`) ? `${slugify(workbookKey)}-` : '');
const selectorSlug = (chartType) => chartType.replace(/^badge_/, '').replace(/_selector$/, '');

function filterCardPlan({ key, title, datasetKey, chartType, subscription, formulas, overrides }) {
	const body = buildCardBody({ title, datasetKey, chartType, subscription, formulas, overrides, chartVersion: FILTER_CARD_CHART_VERSION });
	// A selector has no table to drill to.
	body.definition.allowTableDrill = false;
	return { key, title, worksheet: '', datasetKey, chartType, body, pageKeys: [], status: 'ok' };
}

/** The marks of the worksheet card a filter on an aggregate is evaluated at: its grouping and filters, with their card formulas. */
function aggregateGrain(grain, datasetKey) {
	const main = grain?.datasetKey === datasetKey ? grain.body?.definition?.subscriptions?.main : undefined;
	if (!main) return undefined;
	const groupBy = structuredClone(main.groupBy ?? []);
	const filters = structuredClone(main.filters ?? []);
	const used = new Set([...groupBy.map((g) => g.formulaId), ...filters.map((f) => f.column)].filter(Boolean));
	const formulas = (grain.body.definition.formulas?.card ?? []).filter((f) => used.has(f.id)).map((f) => structuredClone(f));
	return { groupBy, filters, formulas, dateGrain: main.dateGrain ? structuredClone(main.dateGrain) : undefined };
}

function aggregateFilterCard(zone, filter, binding, datasetKey, dash, workbookKey, { field, title, grain, label }) {
	const target = aggregateFilterField(filter, binding);
	if (target.problem) {
		const why = {
			'table-calc': `is on table calculation ${label}, which Domo cannot filter on (it filters before window functions)`,
			formula: `is on aggregate ${label}, whose expression has no beast mode to aggregate`,
			aggregation: `is on aggregate ${label}, whose aggregation has no Domo equivalent`
		}[target.problem];
		return { issues: [makeIssue(dash, 'warning', 'layout.filter-aggregate', `Filter control ${why}; it has no Domo filter card, and the worksheet cards keep its current selection as a fixed filter`, 'Compute the value in ETL and filter on it.')] };
	}
	const isDate = ['date', 'datetime'].includes(filterDataType(target.binding ?? { dataType: target.dataType }));
	if (filter.kind === 'relative-date' || (isDate && filter.kind === 'categorical')) {
		return { issues: [makeIssue(dash, 'warning', 'layout.filter-aggregate', `Filter control on aggregate date ${label} has no Domo filter card (a date selector cannot select on an aggregate); the worksheet cards keep its current selection as a fixed filter`)] };
	}
	const issues = [];
	let beastMode;
	let r;
	if (target.binding) r = refOf(target.binding);
	else {
		const legacyId = beastModeLegacyId(workbookKey ?? '', 'filter-aggregate', datasetKey, target.expression);
		r = { column: legacyId, formulaId: legacyId };
		beastMode = { key: `${datasetKey}.filter-${slugify(label)}-${slugify(target.aggregation)}`, datasetKey, name: target.name, legacyId, expression: target.expression, aggregated: true, dataType: target.dataType, tableauFieldId: filter.fieldId, tableauFormula: '', status: target.note ? 'approximate' : 'ok', features: [] };
	}
	if (target.note) issues.push(makeIssue(dash, 'warning', 'layout.filter-aggregate', `Filter card on aggregate ${label}: ${target.note}`));
	const at = aggregateGrain(grain, datasetKey);
	const sheet = zone.worksheet;
	if (!at) issues.push(makeIssue(dash, 'info', 'layout.filter-aggregate', `Filter card on aggregate ${label} lists its range or values over the whole dataset: worksheet ${sheet} has no card on its dataset to take the marks from`));
	const range = filter.kind === 'quantitative' || filter.kind === 'range-date';
	const chartType = range ? 'badge_range_selector' : (CATEGORICAL_SELECTORS[String(zone.mode ?? '').toLowerCase() || 'checklist'] ?? 'badge_dropdown_selector');
	const columns = range ? [{ ...r, mapping: 'MIN' }, { ...r, mapping: 'MAX' }] : [{ ...r, mapping: 'ITEM' }];
	const overrides = chartType === 'badge_dropdown_selector' && String(zone.mode ?? '').toLowerCase() === 'checkdropdown' ? { allow_multi_select: 'true' } : {};
	const format = fieldColumnFormat(field);
	if (format && target.binding) for (const c of columns) c.format = { ...format };
	const key = `filter-${filterKeyScope(datasetKey, workbookKey)}${slugify(datasetKey)}-${slugify(target.name ?? label)}-${slugify(sheet ?? '')}-${selectorSlug(chartType)}`;
	const subscription = { columns, groupBy: at?.groupBy ?? (range ? [] : [{ ...r }]), orderBy: range ? [] : [{ ...r, order: 'ASCENDING' }], filters: at?.filters ?? [], dateGrain: at?.dateGrain };
	const card = filterCardPlan({ key, title: title || target.name || label, datasetKey, chartType, subscription, formulas: at?.formulas ?? [], overrides });
	return { card, beastMode, issues, aggregate: true };
}

function pageFiltersFor(filter, bindings, datasetKey, dash) {
	const result = toCardFilters([filter], bindings, { datasetKey, datasourceId: filter.datasourceId, object: { type: 'dashboard', name: dash.name } });
	const issues = [...result.issues];
	const filters = [];
	for (const f of result.filters) {
		if (f.filterType !== 'COLUMN_ID') {
			issues.push(makeIssue(dash, 'warning', 'layout.page-filter', `Page filter on ${stripBrackets(filter.fieldId)} needs a beast mode; not set as a page default`));
			continue;
		}
		filters.push({ column: f.column, dataType: f.dataType, operand: f.operand, values: f.values, filterType: 'LEGACY', dataSourceId: ref('dataset', datasetKey) });
	}
	if (result.dateRangeFilter || result.tops.length) {
		issues.push(makeIssue(dash, 'info', 'layout.page-filter', `Filter control on ${stripBrackets(filter.fieldId)} has no page-level default in Domo`));
	}
	return { filters, issues };
}

const defaultSignature = (f) => JSON.stringify([f.dataType, f.operand, [...f.values].map(String).sort()]);

/** The column a filter card selects on: its ITEM, MIN/MAX range or date selector column. */
function filterCardColumn(card) {
	const main = card.body?.definition?.subscriptions?.main;
	return main?.dateGrain?.column ?? main?.columns?.[0]?.column;
}

/**
 * The Tableau selections of card quick filters (CardPlan.quickFilterDefaults) become each view's default filters
 * (PagePlan.filters), written by push as the "Default" filter view; it also reaches the view's filter cards, which then
 * list only the values left. A page filter reaches every card of the view on its dataset (an App Studio view ignores the
 * filter's affectedCardUrns, verified live). With the Tableau filter's scope on the dashboard (dashboardFilterScopes), the
 * default goes to the view when every card in scope selects the same; when the scope leaves out cards on its dataset, the
 * view's filter card on the column filters only the other cards (STANDARD with selected cards, as a user set it up). The
 * fixed copies of the filter on cards in scope go once every view holding the card promoted it. Without a scope, a
 * default that only some cards on the dataset carry, or that differs between them, stays the default of their quick
 * filters, as does one whose beast mode has no name. Mutates the pages and cards.
 * @param {PagePlan[]} pages
 * @param {CardPlan[]} cards  Worksheet and filter cards
 * @param {{ beastModes?: { legacyId: string, name: string }[], scopes?: Map<string, import('./filters.js').FilterScope[]> }} [opts]
 * @returns {Issue[]}
 */
export function pageDefaultFilters(pages, cards, { beastModes = [], scopes = new Map() } = {}) {
	const issues = [];
	const names = new Map(beastModes.map((bm) => [bm.legacyId, bm.name]));
	const promoted = new Map();
	for (const page of pages ?? []) {
		const placed = (cards ?? []).filter((c) => (c.pageKeys ?? []).includes(page.key) && c.status !== 'unsupported' && c.kind !== 'notebook' && c.kind !== 'image');
		const dataCards = placed.filter((c) => c.worksheet || c.stack);
		const pageScopes = (page.dashboard && scopes.get(page.dashboard)) || [];
		const units = new Map();
		for (const card of dataCards) {
			for (const d of card.quickFilterDefaults ?? []) {
				const scope = pageScopes.find((s) => cardSheets(card).some((sheet) => (d.pillIds ?? []).includes(s.members.get(sheet))));
				const id = `${card.datasetKey}\u0000${d.column}\u0000${scope?.id ?? ''}`;
				if (!units.has(id)) units.set(id, { datasetKey: card.datasetKey, default: d, scope, groups: new Map(), copies: new Map() });
				const groups = units.get(id).groups;
				const sig = defaultSignature(d);
				if (!groups.has(sig)) groups.set(sig, { filter: d, cards: [] });
				groups.get(sig).cards.push(card.key);
			}
		}
		const copyOf = (u, card, copy) => u.scope && cardSheets(card).some((sheet) => u.scope.members.get(sheet) === copy.pillId);
		for (const card of dataCards) {
			for (const copy of card.scopedFilters ?? []) {
				let unit = [...units.values()].find((u) => u.datasetKey === card.datasetKey && copyOf(u, card, copy));
				const shown = !unit && copy.default && [...units.values()].find((u) => copyOf(u, card, copy) && u.default.column === copy.default.column);
				// A copy on a dataset no card shows the filter for (a merged stack took the shown sheet) follows the shown one.
				if (shown) {
					const id = `${card.datasetKey}\u0000${copy.default.column}\u0000${shown.scope.id}`;
					unit = { datasetKey: card.datasetKey, default: copy.default, scope: shown.scope, groups: new Map([[defaultSignature(copy.default), { filter: copy.default, cards: [] }]]), copies: new Map() };
					units.set(id, unit);
				}
				if (unit && !unit.copies.has(card.key)) unit.copies.set(card.key, copy);
			}
		}
		const dash = { name: page.dashboard || page.story || page.title };
		const filters = [...(page.filters ?? [])];
		const filterKey = (f) => `${f.dataSourceId?.$ref ?? ''}\u0000${f.column}\u0000${defaultSignature(f)}`;
		const seen = new Set(filters.map(filterKey));
		const scopedFilterCards = new Map();
		let count = 0;
		const restore = (groups) => {
			for (const g of groups.values()) for (const key of g.cards) restoreDefault(cards.find((c) => c.key === key), g.filter);
		};
		for (const unit of units.values()) {
			const { datasetKey, default: d, groups, scope } = unit;
			const column = d.formulaId ? names.get(d.formulaId) : d.column;
			const onDataset = dataCards.filter((c) => c.datasetKey === datasetKey).map((c) => c.key);
			const filterCards = placed.filter((c) => !c.worksheet && !c.stack && c.datasetKey === datasetKey);
			if (!column) {
				restore(groups);
				issues.push(makeIssue(dash, 'warning', 'layout.page-default', `The Tableau selection of the quick filter on ${d.name} has no beast mode to name in a page filter; it stays the default of the card's quick filter`));
				continue;
			}
			const [first] = groups.values();
			const stack = dataCards.find((c) => c.stack && c.datasetKey === datasetKey);
			const stackSource = stack && cards.find((c) => c.stackedInto === stack.key)?.datasetKey;
			const sameColumn = (c) => filterCardColumn(c) === d.column || (d.formulaId && names.get(filterCardColumn(c)) === column);
			const unitColumn = (u) => (u.default.formulaId ? names.get(u.default.formulaId) : u.default.column);
			const sourceHasDefault = [...units.values()].some((u) => u.datasetKey === stackSource && unitColumn(u) === column);
			// A stack has no filter card of its own: the one on its sheets' dataset shows the default unless that dataset has one too.
			const source = filterCards.find(sameColumn) ?? (stackSource && !sourceHasDefault ? placed.find((c) => !c.worksheet && !c.stack && c.datasetKey === stackSource && sameColumn(c)) : undefined);
			let affectedCards;
			if (scope) {
				const scoped = scopedDefault({ unit, page, placed, source, scopedFilterCards });
				if (scoped.issue) issues.push(makeIssue(dash, scoped.issue.severity, scoped.issue.code, scoped.issue.message));
				if (!scoped.promote) {
					restore(groups);
					continue;
				}
				affectedCards = scoped.affectedCards;
			} else if (groups.size > 1 || first.cards.length !== onDataset.length) {
				restore(groups);
				const which = [...groups.values()].map((g) => `${g.filter.values.join(', ')} on ${g.cards.length} card(s)`).join('; ');
				issues.push(
					makeIssue(
						dash,
						'info',
						'layout.page-default-partial',
						`The Tableau selection of ${d.name} (${which}) applies to only some of the view's ${onDataset.length} cards on its dataset, and a page filter would reach them all; it stays the default of those cards' quick filters, so the view's filter cards still list every value`
					)
				);
				continue;
			}
			const f = first.filter;
			const filter = { column, dataType: f.dataType, operand: f.operand, values: f.values, filterType: 'LEGACY', dataSourceId: ref('dataset', datasetKey) };
			if (source) filter.sourceCard = source.key;
			if (affectedCards) filter.affectedCards = affectedCards;
			for (const [cardKey, copy] of unit.copies) {
				const byCopy = promoted.get(cardKey) ?? new Map();
				const id = JSON.stringify(copy.filters);
				byCopy.set(id, (byCopy.get(id) ?? new Set()).add(page.key));
				promoted.set(cardKey, byCopy);
			}
			const key = filterKey(filter);
			if (seen.has(key)) continue;
			seen.add(key);
			filters.push(filter);
			count += 1;
		}
		if (filters.length) page.filters = filters;
		if (count) issues.push(makeIssue(dash, 'info', 'layout.page-default', `${count} Tableau filter selection(s) are the defaults of the view's "Default" filter view (a page saved filter for all users); the card quick filters start empty`));
	}
	const pageKeys = new Set((pages ?? []).map((p) => p.key));
	for (const card of cards ?? []) {
		const byCopy = promoted.get(card.key);
		const holding = (card.pageKeys ?? []).filter((k) => pageKeys.has(k));
		for (const d of card.quickFilterDefaults ?? []) {
			if (!holding.length && card.status !== 'unsupported') restoreDefault(card, d);
			delete d.fixed;
		}
		for (const copy of byCopy ? (card.scopedFilters ?? []) : []) {
			const onPages = byCopy.get(JSON.stringify(copy.filters));
			if (onPages && holding.every((k) => onPages.has(k))) dropFilters(card, copy.filters);
		}
		delete card.scopedFilters;
	}
	return issues;
}

/** A scoped default goes to the view when every card in scope selects the same; a partial scope scopes the filter card. */
function scopedDefault({ unit, page, placed, source, scopedFilterCards }) {
	const { datasetKey, default: d, groups, scope } = unit;
	const [first] = groups.values();
	const values = first.filter.values.join(', ');
	const titles = (list) => list.map((c) => c.title || c.worksheet).join(', ');
	const inScope = placed.filter((c) => c.datasetKey === datasetKey && cardSheets(c).some((s) => scope.members.has(s)));
	const selection = (c) => {
		const own = [...groups.values()].find((g) => g.cards.includes(c.key));
		const copy = unit.copies.get(c.key);
		return own ? defaultSignature(own.filter) : copy?.default ? defaultSignature(copy.default) : undefined;
	};
	if (groups.size > 1 || inScope.some((c) => selection(c) !== defaultSignature(first.filter))) {
		const message = `The Tableau selection of ${d.name} (${values}) is not one quick filter default on every card it applies to (${titles(inScope)}); it stays the default of the cards' quick filters and their fixed filters`;
		return { promote: false, issue: { severity: 'info', code: 'layout.page-default-partial', message } };
	}
	const outside = placed.filter((c) => cardSheets(c).length && !cardSheets(c).some((s) => scope.members.has(s)));
	if (!outside.some((c) => c.datasetKey === datasetKey)) return { promote: true };
	const keys = layoutCardKeys(page).filter((k) => !outside.some((c) => c.key === k));
	const item = source && (page.layout?.content ?? []).find((c) => c.type === 'CARD' && c.cardId?.$ref === `card:${source.key}`);
	const prior = item && scopedFilterCards.get(source.key);
	if (!item || (prior ?? JSON.stringify(keys)) !== JSON.stringify(keys) || (item.interaction && !prior)) {
		const why = item ? 'its filter card already filters other cards' : 'the view has no filter card on the column to scope to them';
		const message = `The Tableau filter on ${d.name} (${values}) applies to ${titles(inScope)} but not ${titles(outside)}, and ${why}; it stays the default of the cards' quick filters and their fixed filters`;
		return { promote: false, issue: { severity: 'warning', code: 'layout.page-default-partial', message } };
	}
	item.interaction = { type: 'STANDARD', config: { openInNewWindow: false, allowCardToCardInteractions: true, selectIndividualCards: true, selectedCardUrns: keys.map((k) => ref('card', k, 'urn')) } };
	scopedFilterCards.set(source.key, JSON.stringify(keys));
	const message = `The Tableau filter on ${d.name} (${values}) applies to ${titles(inScope)} but not ${titles(outside)}: it is the view's default, and its filter card filters every card but those`;
	return { promote: true, affectedCards: keys, issue: { severity: 'info', code: 'layout.page-default-scope', message } };
}

const cardSheets = (card) => card.stack?.sheets ?? (card.worksheet ? [card.worksheet] : []);

function layoutCardKeys(page) {
	return [...new Set((page.layout?.content ?? []).filter((c) => c.type === 'CARD' && c.cardId?.$ref).map((c) => c.cardId.$ref.replace(/^card:/, '')))];
}

function dropFilters(card, drop) {
	const lists = new Set([card.body?.definition?.subscriptions?.main?.filters, card.bigNumber?.filters].filter(Boolean));
	for (const filters of lists) {
		for (const f of drop) {
			const i = filters.findIndex((x) => JSON.stringify(x) === JSON.stringify(f));
			if (i >= 0) filters.splice(i, 1);
		}
	}
}

function restoreDefault(card, d) {
	const control = (card?.body?.definition?.controls ?? []).find((c) => c.column === d.column);
	if (control) control.values = d.values;
	else if (d.fixed && card?.worksheet) {
		const lists = new Set([card.body?.definition?.subscriptions?.main?.filters, card.bigNumber?.filters].filter(Boolean));
		for (const filters of lists) for (const f of d.fixed) if (!filters.some((x) => JSON.stringify(x) === JSON.stringify(f))) filters.push(structuredClone(f));
	}
}

/**
 * Filter cards and variable controls outside sections. Up to FILTER_PANEL_THRESHOLD keep their place, at least as wide as
 * their titles; more are packed into full-width rows by title width (in an app, inside a collapsible "Filters" section)
 * where the first ones were, and the space they held goes to their neighbors when the view is tiled.
 * @returns {{ entries: Object[], count: number }}
 */
function controlPanel(entries, pageKey, nextKey, app) {
	const controls = entries.filter((e) => !e.group && e.placed.control);
	if (controls.length <= FILTER_PANEL_THRESHOLD) {
		for (const c of controls) c.placed.minWidth = c.placed.type === 'VARIABLE' ? MIN_CONTROL_WIDTH : titleWidth(c.label);
		return { entries, count: 0 };
	}
	const floating = controls.every((c) => c.floating);
	// The first control's frame, not all of theirs: controls spread over the dashboard would leave no row or column to cut.
	const [top] = controls.filter((c) => Boolean(c.floating) === floating).sort((a, b) => a.placed.frame.y - b.placed.frame.y || a.placed.frame.x - b.placed.frame.x);
	const frame = { ...top.placed.frame };
	const packed = packControls(controls, { app });
	const order = Math.min(...controls.map((c) => c.placed.order));
	const last = Math.max(...controls.map((c) => c.placed.order));
	const members = [...controls];
	for (const box of packed.spacers) {
		const contentKey = nextKey();
		members.push({ content: { contentKey, type: 'SPACER' }, placed: { contentKey, type: 'SPACER', box, frame: { x: box.x, y: box.y, w: box.width, h: box.height }, order: last } });
	}
	const height = app ? packed.height + SECTION_BAR_HEIGHT : packed.height;
	const box = { x: 0, y: 0, width: STANDARD_WIDTH, height };
	const replacement = app ? filterSection(members, pageKey, nextKey, box, order, floating) : { block: members, placed: { contentKey: 0, type: 'BLOCK', box, order, control: 'panel' }, floating };
	replacement.placed.frame = frame;
	const first = entries.find((e) => controls.includes(e));
	return { entries: entries.flatMap((e) => (e === first ? [replacement] : controls.includes(e) ? [] : [e])), count: controls.length };
}

const EPS = 0.25;
const framesOverlap = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

/** Row boundaries of the frames: the top of every band no frame crosses, and the bottom. */
function rowCuts(frames) {
	const sorted = [...frames].sort((a, b) => a.y - b.y);
	const out = [];
	let end = -Infinity;
	for (const f of sorted) {
		if (f.y >= end - EPS) out.push(f.y);
		end = Math.max(end, f.y + f.h);
	}
	if (sorted.length) out.push(end);
	return out;
}

/**
 * Put floating items into the tiled flow at their own height. An item over nothing that converts keeps its frame; one
 * over tiled items gets a band of its own at the nearest row boundary, and the rows below move down. The lines of a
 * text block move together. A button attached to a card goes with the card. Mutates the frames and returns how many items
 * needed a band.
 */
export function placeFloating(entries) {
	const placed = entries.filter((e) => !e.floating);
	const units = new Map();
	for (const e of entries.filter((x) => x.floating && !x.host)) {
		const id = e.textBlock !== undefined ? `text${e.textBlock}` : e;
		if (!units.has(id)) units.set(id, []);
		units.get(id).push(e);
	}
	const trailing = (u) => (u.members.some((m) => m.trailing) ? 1 : 0);
	const list = [...units.values()].map((members) => ({ members, frame: frameBounds(members.map((m) => m.placed.frame)) })).sort((a, b) => trailing(a) - trailing(b) || a.frame.y - b.frame.y || a.frame.x - b.frame.x);
	const under = (e) => e.placed.type === 'HEADER' || e.placed.image || e.titleRow;
	// Items banded below an image, in reading order: the next one over that image goes below them.
	const stacked = new Map();
	const bottom = (fs) => Math.max(...fs.map((f) => f.y + f.h));
	let banded = 0;
	for (const { members, frame } of list) {
		const frames = placed.map((e) => e.placed.frame);
		if (frames.some((f) => framesOverlap(f, frame))) {
			// An item over a header or an image (a status line over the dashboard title, the title over a banner) goes below it.
			const over = placed.filter((e) => under(e) && framesOverlap(e.placed.frame, frame));
			const below = Math.max(-Infinity, ...over.map((e) => bottom([e.placed.frame, ...(stacked.get(e) ?? [])])));
			const cuts = rowCuts(frames).filter((c) => c >= below - EPS);
			const at = cuts.reduce((best, c) => (Math.abs(c - frame.y) < Math.abs(best - frame.y) ? c : best));
			const shift = Math.max(frame.h, 1);
			for (const f of frames) if (f.y >= at - EPS) f.y += shift;
			for (const m of members) m.placed.frame.y += at - frame.y;
			for (const e of over.filter((x) => x.placed.image)) stacked.set(e, [...(stacked.get(e) ?? []), ...members.map((m) => m.placed.frame)]);
			banded += members.length;
		}
		placed.push(...members);
	}
	return banded;
}

/** Mark entries with their position in the dashboard's custom phone layout. Undefined when it has none. */
function phoneOrder(dash, entries) {
	const phone = (dash.deviceLayouts ?? []).find((l) => /phone/i.test(l.name) && !l.auto && l.zoneIds?.length);
	if (!phone) return undefined;
	const index = new Map(phone.zoneIds.map((id, i) => [id, i]));
	let missing = 0;
	const mark = (e) => {
		if (e.group) {
			const children = e.group.panes.flatMap((p) => p.children);
			children.forEach(mark);
			const positions = children.map((c) => c.placed.phone).filter((v) => v !== undefined);
			if (positions.length) e.placed.phone = Math.min(...positions);
			return;
		}
		const position = index.get(e.zoneId);
		if (position === undefined) missing += 1;
		else e.placed.phone = position;
	};
	entries.forEach(mark);
	return { missing };
}

/**
 * Lay out one dashboard as a v4 page layout.
 * @returns {{ layout: LayoutPlan, filters: Object[], issues: Issue[], filterCards: CardPlan[] }}
 */
function planDashboard(ir, dash, pageKey, cardsBySheet, bindings, options, filterCardsByKey, workbookKey, { variables, inlineParameters, textLimit = MAX_HEADER_TEXT, app, labelCards, statusSheets, statusNotes, links, extraCards = [], stacks, beastModes = [] } = {}) {
	const issues = [];
	const pageFilters = [];
	let dateRange;
	const aggregateFilterEntries = [];
	const scopes = dashboardFilterScopes(ir).get(dash.name) ?? [];
	const scopeSheets = (zone) => new Set(scopes.find((s) => s.members.get(zone.worksheet) === zone.param)?.members.keys() ?? [zone.worksheet]);
	const px = dashboardPixels(dash);
	if (dash.size?.mode !== 'fixed' && !dash.sheetView) {
		issues.push(makeIssue(dash, 'info', 'layout.size', `Dashboard sizing is ${dash.size?.mode ?? 'automatic'}; laid out as ${px.width}x${px.height}px`));
	}
	let entries = [];
	const placedCards = new Set();
	const placedVariables = new Set();
	let contentKey = 0;
	let order = 0;
	let grown = 0;
	const add = (makeContent, type, box, floating, zone, extra, frame = frameOf(zone?.rect, px)) => {
		contentKey += 1;
		const entry = { content: makeContent(contentKey), placed: { contentKey, type, box, frame, order: order++, ...extra }, floating, zoneId: zone?.id };
		entries.push(entry);
		return entry;
	};
	const placeCard = (card, zone, floating, extra) => {
		if (placedCards.has(card.key)) {
			issues.push(makeIssue(dash, 'warning', 'layout.duplicate-card', `Card ${card.key} appears twice on the dashboard; the second copy was left out`));
			return undefined;
		}
		placedCards.add(card.key);
		const box = scaleRect(zone.rect, px, { minHeight: extra?.control && app ? 0 : MIN_CARD_HEIGHT });
		const min = card.status === 'unsupported' ? 0 : extra?.control ? controlHeight({ type: 'CARD', chartType: card.chartType }, { app: Boolean(app) }) : minCardHeight(card.chartType);
		if (box.height < min) {
			box.height = min;
			grown += 1;
		}
		const entry = add((k) => cardContent(k, card.key, { showDescription: hasSmartDescription(card) }), 'CARD', box, floating, zone, { chartType: card.chartType, ...extra });
		entry.datasetKey = card.datasetKey;
		if (zone.kind === 'worksheet') entry.sheet = zone.worksheet;
		if (zone.kind === 'worksheet' && zone.showTitle === false) entry.content.hideTitle = true;
		if (card.status === 'unsupported') entry.unsupported = true;
		const styled = app && card.status !== 'unsupported';
		const itemStyle = styled && extra?.control === 'filter' ? controlItemStyle(zone, dash) : styled && zone.kind === 'worksheet' && !extra?.control ? zoneItemStyle(zone, card.chartType) : undefined;
		if (itemStyle) entry.content.itemStyle = itemStyle;
		return entry;
	};
	let textBlocks = 0;
	const lineContent = (k, line, style) => ({ contentKey: k, type: 'HEADER', text: cutText(line, textLimit), ...(style ? { style: { ...style } } : {}) });
	const roles = imageRoles(dash);
	const zoneById = new Map(zonesOf(dash).map((z) => [z.id, z]));
	const logoFills = new Map([...roles].filter(([z, r]) => r.role === 'title' && z.image).map(([z, r]) => [z, app ? titleRowFill(z.image, textZoneFill(zoneById.get(r.on), dash, ir), dash.background) : undefined]));
	const hiddenLogos = new Set([...logoFills].filter(([z, fill]) => !fill && !showsOnBackground(z.image, dash.background)).map(([z]) => z));
	const titleLogos = new Map([...roles].filter(([z, r]) => r.role === 'title' && z.image && !hiddenLogos.has(z)).map(([z, r]) => [r.on, z]));
	const titleRows = new Map();
	// Headers are full-width rows (the editor gives them no side handles or drop zones), so text wraps at the full width,
	// less the logo that floats over it in Tableau.
	const addText = (text, zone, floating, { title = false, fontSize, kind } = {}) => {
		const frame = frameOf(zone.rect, px);
		const logo = titleLogos.get(zone.id);
		const width = logo ? STANDARD_WIDTH - titleLogoWidth(logo) : STANDARD_WIDTH;
		const { lines, style, cut } = headerLines(text, width, { app: Boolean(app), title, fontSize });
		const block = textBlocks++;
		const added = [];
		// Every line has the block's frame, so the block is lifted out of one row and keeps its lines together (sortKey).
		lines.forEach((line, i) => {
			const entry = add((k) => lineContent(k, line, style), 'HEADER', { x: 0, y: 0, width: STANDARD_WIDTH, height: HEADER_HEIGHT }, floating, zone, {}, { ...frame });
			Object.assign(entry, { textBlock: block, sortKey: [frame.y, frame.x, i] });
			added.push(entry);
		});
		if (logo) titleRows.set(zone.id, { lines: added });
		if (cut) issues.push(makeIssue(dash, 'warning', 'layout.text-truncated', `Dashboard text of ${text.length} characters cut to ${MAX_TEXT_LINES} header lines: "${text.slice(0, 60)}..."`, 'Add the full text as a Domo text card.'));
		if (kind === 'text' && lines.length > 1) issues.push(makeIssue(dash, 'info', 'layout.text', `Dashboard text placed as ${lines.length} header lines (App Studio headers show one line each); formatting is lost`));
	};
	const runSize = (zone) => Math.max(0, ...(zone.runs ?? []).filter((r) => String(r.text ?? '').trim()).map((r) => Number(r.fontSize) || 0));
	const tableauUrl = options.tableauLinks ? tableauViewUrl(ir, dash.name) : undefined;
	if (options.tableauLinks && !tableauUrl) issues.push(makeIssue(dash, 'info', 'layout.tableau-link', 'The workbook has no Tableau web page address (extracted from a file), so the view gets no link to Tableau'));
	let linkedNotebook = false;
	const placeNotebook = (source, zone, floating) => {
		const linked = tableauUrl ? withTableauLink(source, tableauUrl, pageKey, extraCards) : source;
		const card = showsColors(linked, dash.background) ? linked : uncolored(linked, pageKey, extraCards);
		if (placedCards.has(card.key)) return;
		placedCards.add(card.key);
		if (tableauUrl) linkedNotebook = true;
		const lines = notebookLines(card.body.notebook.paragraphs);
		const height = notebookHeight(lines);
		add((k) => notebookContent(k, card.key), 'CARD', { x: 0, y: 0, width: STANDARD_WIDTH, height }, floating, zone, { chartType: card.chartType, banner: true, compactRows: notebookHeight(lines, { compact: true }) });
		if (!card.pageKeys.includes(pageKey)) card.pageKeys.push(pageKey);
	};
	const webLinks = [];
	const placeImage = (zone, floating, banner) => {
		const card = imageCard(pageKey, zone);
		if (placedCards.has(card.key)) return;
		placedCards.add(card.key);
		extraCards.push(card);
		const box = scaleRect(zone.rect, px);
		if (banner) Object.assign(box, { x: 0, width: STANDARD_WIDTH, height: Math.max(BANNER_IMAGE_HEIGHT, box.height) });
		add((k) => imageContent(k, card.key, zone), 'CARD', box, floating, zone, { chartType: card.chartType, image: true, ...(banner ? { banner: true, compactRows: COMPACT_BANNER_IMAGE_HEIGHT } : {}) });
	};
	// One full-width row: the title narrowed, the logo on its Tableau side.
	const placeTitleLogo = (zone, { lines }) => {
		const card = imageCard(pageKey, zone);
		if (placedCards.has(card.key)) return;
		placedCards.add(card.key);
		extraCards.push(card);
		const width = titleLogoWidth(zone);
		const height = lines.length * HEADER_HEIGHT;
		const [first] = lines;
		const titleFrame = first.placed.frame;
		const left = zone.rect.x + zone.rect.w / 2 < (titleFrame.x + titleFrame.w / 2) / STANDARD_WIDTH;
		lines.forEach((line, i) => Object.assign(line.placed.box, { x: left ? width : 0, y: i * HEADER_HEIGHT, width: STANDARD_WIDTH - width, height: HEADER_HEIGHT }));
		contentKey += 1;
		const logo = {
			content: imageContent(contentKey, card.key, zone),
			placed: { contentKey, type: 'CARD', chartType: card.chartType, image: true, banner: true, compactRows: COMPACT_HEADER_HEIGHT * lines.length, box: { x: left ? 0 : STANDARD_WIDTH - width, y: 0, width, height }, order: order++ },
			zoneId: zone.id
		};
		const fill = logoFills.get(zone);
		const shared = { titleRow: true, floating: first.floating, zoneId: first.zoneId, textBlock: first.textBlock, sortKey: first.sortKey };
		const placed = { box: { x: 0, y: 0, width: STANDARD_WIDTH, height }, frame: { ...titleFrame }, order: first.placed.order, banner: true };
		const row = fill ? { ...titleBand(lines, logo, fill, pageKey, () => ++contentKey), ...shared } : { block: [...lines, logo], placed: { contentKey: 0, type: 'BLOCK', ...placed }, ...shared };
		if (fill) {
			Object.assign(row.placed, placed);
			issues.push(makeIssue(dash, 'info', 'layout.title-band', `The title and the logo ${zone.image.name} are on the title's ${fill} fill, a section without a title bar (App Studio title rows have no fill)`));
		}
		entries = entries.flatMap((e) => (e === first ? [row] : lines.includes(e) ? [] : [e]));
	};

	const resolveRun = (t) => (/<[^<>]+>/.test(t) ? resolveTitle(t, bindings, { sheetName: dash.name, ir }).text : t);
	const zoneText = (zone) => {
		const raw = (zone.text ?? (zone.kind === 'title' ? dash.name : '')).trim();
		const resolved = /<[^<>]+>/.test(raw) ? resolveTitle(raw, bindings, { sheetName: dash.name, ir }) : undefined;
		return { text: resolved ? resolved.text : raw, dropped: [...(resolved?.fields ?? []), ...(resolved?.other ?? [])] };
	};
	const statusNote = (zone) => (zone.kind === 'worksheet' && statusSheets?.has(zone.worksheet) && zone.showTitle !== false ? statusNotes?.get(zone.worksheet) : undefined);
	const headerMember = (zone) => ((zone.kind === 'title' || zone.kind === 'text') && Boolean(zoneText(zone).text)) || (zone.kind === 'image' && Boolean(zone.image)) || Boolean(statusNote(zone));
	const header = app ? findHeader(dash, (z) => textZoneFill(z, dash, ir), headerMember) : undefined;
	const headerZones = new Set(header ? [header.image, ...header.members].filter(Boolean) : []);
	const placeTitleCard = (zone, floating, parsed) => {
		const card = headerCard(pageKey, zone, parsed);
		extraCards.push(card);
		const height = Math.max(HEADER_HEIGHT, textCardRows(parsed.paragraphs, STANDARD_WIDTH));
		const frame = frameOf(zone.rect, px);
		const entry = add((k) => notebookContent(k, card.key), 'CARD', { x: 0, y: 0, width: STANDARD_WIDTH, height }, floating, zone, { chartType: card.chartType, banner: true, compactRows: COMPACT_HEADER_ROWS }, frame);
		entry.sortKey = [frame.y, frame.x, 0];
	};
	// App Studio: only the title stays a header (none when the header band holds it); every other text zone is a text card.
	const titleLike = (text) => Boolean(text) && wrapText(text, STANDARD_WIDTH, HEADER_FONT_PX.h2).length <= MAX_TITLE_LINES;
	const titledHeader = Boolean(header?.members.some((z) => z.kind === 'title' || z.kind === 'text'));
	const titleRank = (z) => [z.kind === 'title' ? 1 : 0, titleLogos.has(z.id) ? 1 : 0, runSize(z), z.rect.w, -z.rect.y, -z.rect.x];
	const byTitleRank = (a, b) => {
		const ra = titleRank(a);
		const rb = titleRank(b);
		return rb.reduce((d, v, i) => d || v - ra[i], 0);
	};
	const titleZone = app && !titledHeader ? zonesOf(dash).filter((z) => (z.kind === 'title' || z.kind === 'text') && z.rect && z.rect.y < BANNER_MAX_TOP && !headerZones.has(z) && (z.kind === 'title' ? Boolean(zoneText(z).text) : titleLike(zoneText(z).text))).sort(byTitleRank)[0] : undefined;
	let smallText = 0;
	const placeTextCard = (zone, floating, parsed) => {
		const card = textZoneCard(pageKey, zone, parsed);
		if (placedCards.has(card.key)) return;
		extraCards.push(card);
		placedCards.add(card.key);
		const box = scaleRect(zone.rect, px, { minHeight: 0 });
		box.height = textCardRows(parsed.paragraphs, Math.max(MIN_TILE_WIDTH, box.width));
		const compactRows = textCardRows(parsed.paragraphs, COMPACT_WIDTH, { columnPx: COMPACT_ROW_PX, rowPx: COMPACT_ROW_PX });
		add((k) => notebookContent(k, card.key), 'CARD', box, floating, zone, { chartType: card.chartType, compactRows });
		if ((zone.runs ?? []).some((r) => String(r.text ?? '').trim() && Number(r.fontSize) > 0 && Number(r.fontSize) < SMALLEST_TEXT_PT)) smallText += 1;
	};
	const placeHeader = () => {
		const items = [];
		let statusPlaced = false;
		for (const zone of header.members) {
			if (zone.kind === 'image') {
				const card = imageCard(pageKey, zone);
				if (placedCards.has(card.key)) continue;
				placedCards.add(card.key);
				extraCards.push(card);
				items.push({ zone, rect: zone.rect, content: (k) => imageContent(k, card.key, zone), chartType: card.chartType, image: true });
				continue;
			}
			const note = statusNote(zone);
			if (note) {
				const card = tableauUrl ? withTableauLink(note, tableauUrl, pageKey, extraCards) : note;
				if (placedCards.has(card.key)) continue;
				placedCards.add(card.key);
				if (tableauUrl) linkedNotebook = true;
				statusPlaced = true;
				if (!card.pageKeys.includes(pageKey)) card.pageKeys.push(pageKey);
				items.push({ zone, rect: zone.rect, content: (k) => notebookContent(k, card.key), chartType: card.chartType, paragraphs: card.body.notebook.paragraphs });
				continue;
			}
			const { text, dropped } = zoneText(zone);
			if (dropped.length) issues.push(makeIssue(dash, 'info', 'layout.text-field', `Dashboard text shows ${dropped.join(', ')}; left out of its text card (the card shows static text only)`));
			const parsed = headerParagraphs(zone, dash, text, resolveRun);
			if (!parsed.paragraphs.length) continue;
			const wide = zone === header.band || zone.rect.w >= 0.8 * header.rect.w;
			const merged = wide ? items.find((i) => i.flex) : undefined;
			if (merged) {
				merged.card.body.notebook.paragraphs.push(...parsed.paragraphs);
				continue;
			}
			const card = headerCard(pageKey, zone, parsed);
			extraCards.push(card);
			items.push({ zone, rect: zone.rect, content: (k) => notebookContent(k, card.key), chartType: card.chartType, card, paragraphs: card.body.notebook.paragraphs, flex: wide, align: parsed.align, title: zone.kind === 'title' || zone === header.band });
		}
		// Tableau's link joins the header's other text (as the user placed it on Demand Management); a title-only header keeps the separate link card.
		const rank = (i) => Math.max(0, ...i.paragraphs.flat().map((seg) => ['subtitle', 'title', 'header'].indexOf(seg.size) + 1));
		const title = items.find((i) => i.flex) ?? items.filter((i) => i.card).sort((a, b) => rank(b) - rank(a) || Number(b.title) - Number(a.title))[0];
		const joins = tableauUrl && !statusPlaced ? items.find((i) => i.card && i !== title) : undefined;
		if (joins) {
			joins.card.body.notebook.paragraphs.push([{ text: TABLEAU_LINK_TEXT, link: tableauUrl }]);
			joins.card.tableauLink = tableauUrl;
			linkedNotebook = true;
		}
		for (const i of items) if (i.flex) i.need = textCardWidth(i.paragraphs);
		const columns = bandColumns(items);
		const scaled = scaleRect(header.rect, px, { minHeight: 0 }).height;
		const needs = items.map((i, n) => (i.paragraphs ? textCardRows(i.paragraphs, columns[n].width) : columns[n].share < 1 ? Math.max(STACKED_LOGO_ROWS, Math.round(columns[n].share * scaled)) : 0));
		const stackOf = (n) => items.map((_, m) => m).filter((m) => columns[m].x === columns[n].x && columns[m].width === columns[n].width && columns[m].share < 1).sort((a, b) => columns[a].top - columns[b].top);
		const height = Math.max(HEADER_HEIGHT, scaled, ...items.map((_, n) => (columns[n].share < 1 ? stackOf(n).reduce((sum, m) => sum + needs[m], 0) : needs[n])));
		const boxes = items.map((_, n) => {
			if (columns[n].share === 1) return { x: columns[n].x, y: 0, width: columns[n].width, height };
			const stack = stackOf(n);
			const spare = height - stack.reduce((sum, m) => sum + needs[m], 0);
			const grown = (m) => needs[m] + (m === stack.findLast((k) => items[k].paragraphs) || (m === stack.at(-1) && !stack.some((k) => items[k].paragraphs)) ? spare : 0);
			const y = stack.slice(0, stack.indexOf(n)).reduce((sum, m) => sum + grown(m), 0);
			return { x: columns[n].x, y, width: columns[n].width, height: grown(n) };
		});
		const children = items.map((i, n) => {
			contentKey += 1;
			return { content: i.content(contentKey), placed: { contentKey, type: 'CARD', chartType: i.chartType, banner: true, compactRows: COMPACT_HEADER_ROWS, ...(i.image ? { image: true } : {}), box: boxes[n], frame: frameOf(i.rect, px), order: order++ }, zoneId: i.zone.id };
		});
		for (const hole of bandHoles(columns)) {
			contentKey += 1;
			children.push({ content: { contentKey, type: 'SPACER' }, placed: { contentKey, type: 'SPACER', box: { ...hole, y: 0, height }, order: order++ } });
		}
		const style = header.image ? { image: sectionImageCard(pageKey, header.image) } : { fill: header.fill };
		if (style.image) extraCards.push(style.image);
		const band = headerBand(children, { fill: style.fill, image: style.image?.key }, height, pageKey, header.band.id, () => ++contentKey);
		const frame = frameOf(header.rect, px);
		Object.assign(band.placed, { box: { x: 0, y: 0, width: STANDARD_WIDTH, height }, frame, order: order++, banner: true });
		entries.push({ ...band, floating: false, titleRow: true, zoneId: header.band.id, sortKey: [frame.y, frame.x, 0] });
		const logos = items.filter((i) => i.image).length;
		const texts = items.filter((i) => !i.image).length;
		const background = header.image ? `the image ${header.image.image.name} as its background` : `the title's ${header.fill} fill`;
		issues.push(makeIssue(dash, 'info', 'layout.header', `The header is a section with ${background}, holding ${texts} text card(s)${logos ? ` and ${logos} logo(s)` : ''} at their Tableau positions`));
	};

	const handle = (zone, floating) => {
		if (headerZones.has(zone)) return;
		switch (zone.kind) {
			case 'worksheet': {
				const stacked = stacks?.get(`${dash.name}\u0000${zone.id}`);
				if (stacked) {
					if (stacked.head) {
						const entry = placeCard(stacked.card, { ...zone, rect: stackRect(stacked, px) }, floating);
						if (entry) {
							entry.sheets = stacked.zones.map((z) => z.worksheet);
							entry.content.hideTitle = stacked.zones.every((z) => z.showTitle === false);
						}
						if (!stacked.card.pageKeys.includes(pageKey)) stacked.card.pageKeys.push(pageKey);
					} else {
						issues.push(makeIssue(dash, 'info', 'layout.crosstab-stack', `Worksheet ${zone.worksheet} is a section of the merged table ${stacked.card.title}, placed where the stack starts`));
					}
					return;
				}
				const card = cardsBySheet.get(zone.worksheet);
				const sheet = (ir.worksheets ?? []).find((w) => w.name === zone.worksheet);
				if (statusSheets?.has(zone.worksheet)) {
					const note = statusNotes?.get(zone.worksheet);
					if (note && zone.showTitle !== false) placeNotebook(note, zone, floating);
					return;
				}
				const fieldless = sheet && (!card || card.status === 'unsupported') ? fieldlessSheetIssue(sheet)?.code : undefined;
				const button = app && fieldless === 'card.ui-sheet' ? sheetButton(zone, dash, app) : undefined;
				if (button) {
					add(button, 'BUTTON', buttonBox(zone, px), floating, zone);
					return;
				}
				if (fieldless === 'card.title-only') {
					const text = titleLines(sheet.title).join('\n');
					if (text) addText(text, zone, floating, { title: true });
					return;
				}
				if (fieldless === 'card.empty-sheet') return;
				const label = card && labelCards?.has(card) ? labelSheet(sheet, ir, zone) : undefined;
				if (label) {
					const planned = labelCards.get(card);
					labelCards.set(card, false);
					const dynamic = label.dynamic ? '; its field and parameter values are dropped (a header shows static text only)' : '';
					if (label.text) {
						addText(label.text, zone, floating, { title: true });
						issues.push(makeIssue(dash, 'info', 'layout.label-sheet', `Worksheet ${zone.worksheet} shows only text over a constant calculation; placed as a header${dynamic}`));
					} else if (planned) {
						issues.push(makeIssue(dash, 'warning', 'layout.label-sheet', `Worksheet ${zone.worksheet} shows only text over a constant calculation, and its label text is not in the extract; left out`, 'Extract again with a t2d version that reads mark labels, or add a header in Domo.'));
					}
					return;
				}
				if (!card) {
					issues.push(makeIssue(dash, 'warning', 'layout.missing-card', `Worksheet ${zone.worksheet} has no card; left off the page`));
					return;
				}
				placeCard(card, zone, floating);
				if (!card.pageKeys.includes(pageKey)) card.pageKeys.push(pageKey);
				return;
			}
			case 'title':
			case 'text': {
				const raw = (zone.text ?? (zone.kind === 'title' ? dash.name : '')).trim();
				const resolved = /<[^<>]+>/.test(raw) ? resolveTitle(raw, bindings, { sheetName: dash.name, ir }) : undefined;
				const text = resolved ? resolved.text : raw;
				const dropped = [...(resolved?.fields ?? []), ...(resolved?.other ?? [])];
				const textCard = app && zone !== titleZone && !titleLogos.has(zone.id) && Boolean(text);
				if (dropped.length) issues.push(makeIssue(dash, 'info', 'layout.text-field', textCard ? `Dashboard text shows ${dropped.join(', ')}; left out of its text card (the card shows static text only)` : `Dashboard text shows ${dropped.join(', ')}; left out of the header (a header shows static text only)`));
				if (!text) return;
				if (textCard) {
					const body = headerParagraphs(zone, dash, text, resolveRun);
					if (body.paragraphs.length) {
						placeTextCard(zone, floating, body);
						return;
					}
				}
				const parsed = app && zone.rect && zone.rect.y < BANNER_MAX_TOP && !titleLogos.has(zone.id) ? headerParagraphs(zone, dash, text, resolveRun) : undefined;
				if (parsed?.paragraphs.length && needsTextCard(parsed)) {
					placeTitleCard(zone, floating, parsed);
					return;
				}
				addText(text, zone, floating, { title: zone.kind === 'title', fontSize: runSize(zone), kind: zone.kind });
				return;
			}
			case 'filter': {
				const { filter, ws: filterSheet } = filterForZone(ir, zone);
				const binding = bindings?.get?.(filter.datasourceId, filter.fieldId);
				const datasetKey = bindings?.datasetKeyFor?.(filter.datasourceId) ?? binding?.datasetKey;
				const label = binding?.name ?? stripBrackets(filter.fieldId);
				if (!binding || binding.kind === 'unsupported' || !datasetKey) {
					issues.push(makeIssue(dash, 'warning', 'layout.filter-zone', `Filter control on ${label} has no Domo column; left off the page`));
					return;
				}
				if (app && filter.kind === 'relative-date') {
					const { range } = relativeDateRange(filter.relative ?? {});
					if (!dateRange) {
						dateRange = range;
						issues.push(makeIssue(dash, 'info', 'layout.date-range', `Relative date filter on ${label} is the view's date control, defaulting to the Tableau range; it has no filter card`));
					} else issues.push(makeIssue(dash, 'info', 'layout.date-range', `Relative date filter on ${label} has no filter card: the view's date control already takes another relative date filter's range`));
					return;
				}
				if (options.createFilterCards === false) {
					const result = pageFiltersFor(filter, bindings, datasetKey, dash);
					pageFilters.push(...result.filters);
					issues.push(...result.issues);
					issues.push(makeIssue(dash, 'info', 'layout.filter-zone', `Filter control on ${label} is available from the Domo page filter bar`));
					return;
				}
				const field = (ir?.datasources ?? []).find((d) => d.id === filter.datasourceId)?.fields?.find((f) => f.id === filter.fieldId);
				const title = filterSheet?.filterTitles?.[zone.param] ?? filterSheet?.filterTitles?.[filter.pillId];
				const result = filterCardFor(zone, filter, binding, datasetKey, dash, workbookKey, { field, title, grain: cardsBySheet.get(zone.worksheet) });
				issues.push(...result.issues);
				const { card } = result;
				if (!card) return;
				if (result.beastMode && !beastModes.some((bm) => bm.key === result.beastMode.key)) beastModes.push(result.beastMode);
				let target = filterCardsByKey.get(card.key);
				if (!target) {
					target = card;
					filterCardsByKey.set(card.key, card);
				}
				if (!target.pageKeys.includes(pageKey)) target.pageKeys.push(pageKey);
				const entry = placeCard(target, zone, floating, { control: 'filter', ...controlStack(zone, dash) });
				if (entry) {
					entry.label = target.title;
					// "Presentation mode" off in App Studio: no card options menu.
					entry.content.hideWrench = true;
					if (result.aggregate) aggregateFilterEntries.push({ entry, card: target, label, sheets: scopeSheets(zone) });
				}
				if (hasSelection(filter)) {
					const where = result.aggregate ? 'stays a fixed filter of the worksheet cards' : `is a default of the view's "Default" filter view`;
					issues.push(makeIssue(dash, 'info', 'layout.filter-default', `Filter card on ${label}: the Tableau selection ${where}`));
				}
				return;
			}
			case 'paramctrl': {
				const param = (ir?.parameters ?? []).find((pm) => pm.id === zone.param);
				const name = zone.title || param?.name || stripBrackets(`[${String(zone.param ?? '').split('].[').pop() ?? ''}`);
				const variable = options.parameters === 'variables' ? (variables ?? []).find((v) => v.parameter?.id === zone.param) : undefined;
				if (!variable) {
					const why = options.parameters !== 'variables' ? 'parameters are inlined as constants' : `it is inlined as a constant: ${inlineParameters?.get(zone.param) ?? 'it has no Domo variable'}`;
					issues.push(
						makeIssue(
							dash,
							'warning',
							'layout.parameter-control',
							`Parameter control ${name || zone.param} was not placed on the page: ${why}`,
							options.parameters === 'variables' ? 'The parameter keeps its current value; edit the beast modes to change it.' : 'Convert with --parameters variables to get a Domo variable control.'
						)
					);
					return;
				}
				if (placedVariables.has(variable.key)) {
					issues.push(makeIssue(dash, 'info', 'layout.duplicate-control', `Parameter control ${name} appears twice on the dashboard; Domo shows one control per variable on a page`));
					return;
				}
				placedVariables.add(variable.key);
				const { control, notes } = variableControl(variable, { mode: zone.mode, name: name.trim() || variable.name, override: true });
				const box = scaleRect(zone.rect, px, { minHeight: controlHeight({ type: 'VARIABLE', controlType: control.type }, { app: Boolean(app) }) });
				const itemStyle = app ? { itemStyle: controlItemStyle(zone, dash) } : {};
				add((k) => ({ contentKey: k, type: 'VARIABLE', variableControlId: ref('variable', variable.key), control, ...itemStyle }), 'VARIABLE', box, floating, zone, { control: 'variable', controlType: control.type, ...controlStack(zone, dash) }).label = name;
				if (notes.length) issues.push(makeIssue(dash, 'info', 'layout.parameter-control-approximate', `Parameter control ${name} placed as a Domo variable control; ${notes.join('; ')}`));
				return;
			}
			case 'legend':
				issues.push(makeIssue(dash, 'info', 'layout.legend', 'Legend dropped: Domo cards draw their own legends'));
				return;
			case 'web': {
				const link = zone.url ? resolveWebUrl(zone.url, ir, links) : undefined;
				const webPage = !link && app ? webPageButton(zone, dash) : undefined;
				if (webPage) {
					issues.push(...webPage.issues);
					add(webPage.item, 'BUTTON', buttonBox(zone, px), floating, zone);
					return;
				}
				if (!link) {
					issues.push(makeIssue(dash, 'warning', 'layout.unsupported-zone', `Web page zone${zone.url ? ` (${zone.url})` : ''} is not converted`, 'Add a document or web content card in Domo.'));
					return;
				}
				const result = webViewButton(link, zone, dash, app, ir);
				issues.push(...result.issues);
				if (result.item) {
					const entry = add(result.item, 'BUTTON', buttonBox(zone, px), floating, zone);
					if (result.link) webLinks.push({ contentKey: entry.placed.contentKey, ...result.link });
				} else if (result.link) webLinks.push(result.link);
				return;
			}
			case 'image': {
				const role = roles.get(zone)?.role;
				const where = zone.url ? ` (${zone.url})` : '';
				if (!zone.image) {
					issues.push(makeIssue(dash, 'warning', 'layout.unsupported-zone', `Image zone${where} is not converted: its image is not in the workbook package`, 'Add a document card with the image in Domo.'));
					return;
				}
				if (hiddenLogos.has(zone)) {
					const fill = textZoneFill(zoneById.get(roles.get(zone).on), dash, ir);
					const why = !fill ? 'its title has no fill' : app ? `it does not show on the title's ${fill} fill either` : `the title's ${fill} fill needs an app view (a filled section)`;
					issues.push(makeIssue(dash, 'info', 'layout.image-on-fill', `Image ${zone.image.name} is left out: its colors match the view background and ${why}, so it would not show`, 'Add it in Domo on a filled section if it is needed.'));
				} else if (role === 'title' && titleRows.has(roles.get(zone).on) && titleLogos.get(roles.get(zone).on) === zone) placeTitleLogo(zone, titleRows.get(roles.get(zone).on));
				else if (role === 'overlay' || role === 'title') issues.push(makeIssue(dash, 'info', 'layout.image-overlay', `Image ${zone.image.name} floats over other items in Tableau and is left out (App Studio items cannot overlap)`, 'Add it in Domo if it is needed.'));
				else placeImage(zone, floating, role === 'banner');
				return;
			}
			case 'button': {
				if (!app) return;
				const { item, issues: buttonIssues } = navigationButton(zone, dash, app);
				issues.push(...buttonIssues);
				if (item) add(item, 'BUTTON', buttonBox(zone, px), floating, zone);
				return;
			}
			default:
		}
	};

	for (const zone of dash.zones ?? []) if (!zone.floating) handle(zone, false);
	const floatingZones = [...(dash.floating ?? []), ...(dash.zones ?? []).filter((z) => z.floating)];
	for (const zone of floatingZones) handle(zone, true);
	if (header) placeHeader();
	if (tableauUrl && !linkedNotebook) {
		const card = tableauLinkCard(pageKey, dash.name, tableauUrl);
		extraCards.push(card);
		const lines = notebookLines(card.body.notebook.paragraphs);
		const height = notebookHeight(lines);
		// Floating at the top, placed after the other floating items: placeFloating gives it a row of its own below the title
		// header it overlaps.
		add((k) => notebookContent(k, card.key), 'CARD', { x: 0, y: 0, width: STANDARD_WIDTH, height }, true, undefined, { chartType: card.chartType, banner: true, compactRows: notebookHeight(lines, { compact: true }) }, { x: 0, y: 0, w: STANDARD_WIDTH, h: height }).trailing = true;
	}
	entries = entries.filter((e) => !e.unsupported);
	issues.push(...scopeAggregateFilterCards(aggregateFilterEntries, entries, dash));
	const attached = attachButtons(entries);
	if (app) {
		applyCardActions(dash, entries, app);
		const { sections, issues: sectionErrors } = toggleSections(dash);
		const grouped = groupSections(entries, sections, pageKey, () => ++contentKey);
		entries = grouped.entries;
		issues.push(...sectionErrors, ...sectionIssues(dash, sections, grouped.formed, grouped.withText));
	}
	const panel = controlPanel(entries, pageKey, () => ++contentKey, Boolean(app));
	entries = panel.entries;
	if (panel.count) {
		issues.push(
			makeIssue(
				dash,
				'info',
				'layout.filter-panel',
				`${panel.count} filter cards and controls were packed into ${app ? 'a collapsible "Filters" section' : 'rows'}, each as wide as its title`,
				'App Studio has no filter bar item a layout can hold; viewers can also add page filters from the Controls panel.'
			)
		);
	}
	if (grown) issues.push(makeIssue(dash, 'info', 'layout.min-height', `${grown} card(s) made taller than in Tableau so their title, summary and values fit; items below moved down`));
	if (smallText) issues.push(makeIssue(dash, 'info', 'layout.text-size', `${smallText} text card(s) have text smaller than ${SMALLEST_TEXT_PT}pt in Tableau; it shows at 14px, the smallest Domo text card size`));
	const floatingCount = entries.filter((e) => e.floating).length;
	const onCards = entries.flatMap((e) => (e.group ? e.group.panes.flatMap((p) => p.children) : [e])).filter((e) => e.host).length;
	const banded = placeFloating(entries);
	if (floatingCount) {
		const how = [onCards && `${onCards} of them are buttons over a card and take that card's top or bottom rows`, banded && `${banded} of them sat over other items and got a row of their own there`].filter(Boolean).join('; ');
		issues.push(makeIssue(dash, 'info', 'layout.floating', `${floatingCount} floating item(s) placed in the tiled layout at their position${how ? `; ${how}` : ''}`, 'Domo layouts do not float items; adjust them in edit mode if needed.'));
	}
	if (attached > onCards) issues.push(makeIssue(dash, 'info', 'layout.floating', `${attached - onCards} button(s) over a card of another section got a row of their own`));
	entries = tileEntries(entries);
	const phone = phoneOrder(dash, entries);
	if (phone) issues.push(makeIssue(dash, 'info', 'layout.phone-layout', `The phone layout follows Tableau's custom phone layout${phone.missing ? `; ${phone.missing} item(s) it leaves out are at the end (a Domo layout shows every item on both templates)` : ''}`));
	return { layout: app ? buildAppLayout(entries) : buildLayout(entries), filters: pageFilters, issues, webLinks, ...(dateRange ? { dateRange } : {}) };
}

// Unscoped, Domo applies the selection to every card on the dataset at its own grain, emptying the other filter cards (live).
function scopeAggregateFilterCards(filterEntries, entries, dash) {
	const issues = [];
	const sheetsOf = (e) => e.sheets ?? (e.sheet ? [e.sheet] : []);
	for (const { entry, card, label, sheets } of filterEntries) {
		const data = entries.filter((e) => e.content?.type === 'CARD' && sheetsOf(e).length);
		const inScope = data.filter((e) => sheetsOf(e).some((s) => sheets.has(s)));
		const keys = [...new Set(inScope.map((e) => e.content.cardId.$ref.replace(/^card:/, '')))];
		entry.content.interaction = { type: 'STANDARD', config: { openInNewWindow: false, allowCardToCardInteractions: keys.length > 0, selectIndividualCards: true, selectedCardUrns: keys.map((k) => ref('card', k, 'urn')) } };
		const outside = [...new Set(data.filter((e) => e.datasetKey === card.datasetKey && !inScope.includes(e)).flatMap(sheetsOf))];
		if (outside.length) issues.push(makeIssue(dash, 'info', 'layout.filter-aggregate-scope', `Filter card on aggregate ${label} filters only the cards of the Tableau filter's sheets, not ${outside.join(', ')}`));
	}
	return issues;
}

/**
 * Cards of label sheets on a dashboard, marked unsupported and `replacedBy: 'header'` before any view is planned, so a
 * story point never places one. Maps each to whether convert had planned it.
 * @returns {Map<CardPlan, boolean>}
 */
function labelSheetCards(ir, dashboards, cardsBySheet, statusNames) {
	const out = new Map();
	for (const dash of dashboards) {
		for (const zone of [...(dash.zones ?? []), ...(dash.floating ?? [])]) {
			const card = zone.kind === 'worksheet' ? cardsBySheet.get(zone.worksheet) : undefined;
			if (!card || out.has(card) || statusNames.has(zone.worksheet)) continue;
			const sheet = (ir.worksheets ?? []).find((w) => w.name === zone.worksheet);
			if (labelSheet(sheet, ir, zone)) out.set(card, card.status !== 'unsupported');
		}
	}
	for (const card of out.keys()) {
		card.status = 'unsupported';
		card.replacedBy = 'header';
	}
	return out;
}

const UPDATE_TIME = /<Data Update Time>/i;
// A worksheet zone this short shows only the sheet's title.
const STATUS_ZONE_PX = 80;
const zonesOf = (dash) => [...(dash.zones ?? []), ...(dash.floating ?? [])];

// Sized to its rows, not to the zones it replaces: Domo draws table lines taller than Tableau's, so those zones clip it.
function stackRect(stacked, px) {
	const head = stacked.zones[0].rect;
	const rows = (px.height / (px.width / STANDARD_WIDTH)) * ASPECT_RATIO;
	const contentRows = stackHeightPx(stacked) / (COLUMN_PX / ASPECT_RATIO);
	return { x: head.x, y: head.y, w: head.w, h: contentRows / rows };
}

function stackedSheets(cardsBySheet, cards) {
	const merged = new Map((cards ?? []).filter((c) => c.stack).map((c) => [c.key, c]));
	if (!merged.size) return cardsBySheet;
	return new Map([...cardsBySheet].map(([sheet, card]) => [sheet, card.replacedBy === 'stack' ? (merged.get(card.stackedInto) ?? card) : card]));
}

/**
 * Status sheets: worksheets whose title shows <Data Update Time> and that only show that title on every dashboard (each
 * zone at most STATUS_ZONE_PX high, or a sheet with no data field). They get no chart card (planStatusSheets).
 * @returns {Set<string>} Worksheet names
 */
export function statusSheetNames(ir, dashboards) {
	const out = new Set();
	for (const ws of ir?.worksheets ?? []) {
		if (!UPDATE_TIME.test(ws.title ?? '')) continue;
		const zones = dashboards.flatMap((d) => zonesOf(d).filter((z) => z.kind === 'worksheet' && z.worksheet === ws.name).map((z) => (z.rect?.h ?? 1) * dashboardPixels(d).height));
		if (!zones.length) continue;
		if (zones.every((px) => px <= STATUS_ZONE_PX) || fieldlessSheetIssue(ws)?.code === 'card.title-only' || labelSheet(ws, ir)) out.add(ws.name);
	}
	return out;
}

/**
 * Each status sheet is a text (notebook) card at the top of each view that shows it, with the update time as smart text.
 * Marks the status sheets' cards unsupported with `replacedBy`.
 * @returns {{ notes: Map<string, Map<string, CardPlan>>, cards: CardPlan[], issues: Issue[] }}  `notes`: dashboard name ->
 *   status sheet -> its text card
 */
function planStatusSheets(ir, dashboards, statusNames, cardsBySheet, bindings, workbookKey, { aligned = false } = {}) {
	const sheetOf = (name) => (ir.worksheets ?? []).find((w) => w.name === name);
	const notebooks = new Map();
	const notes = new Map();
	const issues = [];
	const notebookFor = (sheet) => {
		if (notebooks.has(sheet.name)) return notebooks.get(sheet.name).card;
		const made = notebookCard(sheet, cardsBySheet.get(sheet.name), bindings, workbookKey, { aligned });
		notebooks.set(sheet.name, made);
		const object = { type: 'worksheet', name: sheet.name };
		const parts = [made.updateTime && 'the update time as "Date last updated" smart text', made.owner && `the owner "${made.owner}" as text, or as Domo's owner smart text when the dataset owner in Domo has that name at push time`].filter(Boolean);
		issues.push({ severity: 'info', code: 'layout.update-time', message: `Worksheet ${sheet.name} shows only its title; it is a text card at the top of each view that shows it${parts.length ? `, with ${parts.join(' and ')}` : ''}`, object });
		if (!made.card.datasetKey && made.updateTime) issues.push({ severity: 'warning', code: 'layout.update-time', message: `Worksheet ${sheet.name} has no Domo dataset, so its text card leaves out the update time`, object });
		if (made.dropped.length) issues.push({ severity: 'info', code: 'layout.update-time', message: `Worksheet ${sheet.name} title token(s) ${[...new Set(made.dropped)].map((t) => `<${t}>`).join(', ')} have no Domo equivalent; left out of its text card`, object });
		return made.card;
	};
	for (const dash of dashboards) {
		for (const zone of zonesOf(dash).filter((z) => z.kind === 'worksheet' && statusNames.has(z.worksheet))) {
			const sheet = sheetOf(zone.worksheet);
			if (!sheet || zone.showTitle === false) continue;
			if (!notes.has(dash.name)) notes.set(dash.name, new Map());
			notes.get(dash.name).set(zone.worksheet, notebookFor(sheet));
		}
	}
	for (const name of statusNames) {
		const statusCard = cardsBySheet.get(name);
		if (statusCard) Object.assign(statusCard, { status: 'unsupported', replacedBy: 'notebook' });
	}
	return { notes, cards: [...notebooks.values()].map((n) => n.card), issues };
}

/** Dashboards in workbook tab order (document order when the workbook lists no tabs). */
function tabOrder(dashboards) {
	return dashboards.map((dash, index) => ({ dash, index })).sort((a, b) => (a.dash.tabIndex ?? Infinity) - (b.dash.tabIndex ?? Infinity) || a.index - b.index).map((x) => x.dash);
}

function capTitle(title, object, issues) {
	if (title.length <= MAX_TITLE) return title;
	issues.push({ severity: 'warning', code: 'layout.title-truncated', message: `Title of ${title.length} characters cut to ${MAX_TITLE}, the App Studio limit: "${title.slice(0, 60)}..."`, object });
	return cutText(title, MAX_TITLE);
}

/**
 * Target 'app': the AppPlan for the workbook, and nav order, hidden flags and the landing view on `views` (mutated).
 * @returns {import('../model/types.js').AppPlan}
 */
const itemStyleLabel = (s) =>
	`${s.kind} ${[s.background ? `background ${s.background}` : 'theme background', s.borderWidth ? `border ${s.borderColor} ${s.borderWidth}px` : 'no border', s.padding ? `padding ${s.padding.top}px` : ''].filter(Boolean).join(', ')} (${s.items})`;

function planApp(ir, rootKey, title, views, cards, options, issues) {
	const workbookName = ir?.workbook?.name || 'Workbook';
	views.forEach((view, i) => {
		view.navOrder = i + 1;
	});
	let landing = views.find((v) => !v.hidden);
	if (!landing && views.length) {
		landing = views[0];
		delete landing.hidden;
		issues.push({ severity: 'warning', code: 'layout.landing-hidden', message: `Every dashboard is hidden; "${landing.title}" is shown as the landing view (App Studio cannot hide it)`, object: { type: 'workbook', name: workbookName } });
	}
	const orientation = options.navOrientation ?? 'TOP';
	const persist = options.persistFilters !== false;
	const base = options.theme ?? DEFAULT_THEME;
	const fromWorkbook = options.workbookTheme === false ? {} : workbookTheme(ir, base);
	issues.push(...(fromWorkbook.issues ?? []));
	const theme = { base, ...(fromWorkbook.overrides ? { overrides: fromWorkbook.overrides } : {}) };
	if (options.workbookTheme === false) {
		for (const view of views) for (const item of view.layout?.content ?? []) delete item.itemStyle;
	} else {
		const { palette, issues: paletteIssues } = workbookPalette(ir);
		issues.push(...paletteIssues);
		if (palette) theme.palette = palette;
		const { table, issues: tableIssues } = workbookTableStyle(ir, cards);
		issues.push(...tableIssues);
		if (table) theme.overrides = { ...(theme.overrides ?? {}), table };
		const { styles: itemStyles, control } = planItemStyles(views, fromWorkbook.overrides?.card);
		if (control) theme.overrides = { ...(theme.overrides ?? {}), control };
		if (itemStyles.length) {
			theme.itemStyles = itemStyles;
			const items = itemStyles.reduce((n, s) => n + s.items, 0);
			issues.push({ severity: 'info', code: 'layout.item-styles', message: `${items} card(s) keep their own Tableau zone style (background, border, padding) as ${itemStyles.length} extra theme style(s): ${itemStyles.map(itemStyleLabel).join('; ')}`, object: { type: 'workbook', name: workbookName } });
		}
	}
	return {
		key: rootKey,
		title,
		description: `Migrated from the Tableau workbook "${workbookName}"`,
		theme,
		navigation: { orientation, showDomoNavigation: orientation !== 'LEFT' && options.domoNav !== false, showNavigation: true, showTitle: orientation !== 'LEFT' },
		persistSettings: { persistFiltersEnabled: persist, persistVariablesEnabled: persist, persistDateEnabled: false, persistInteractionsEnabled: false, persistedColumns: [] },
		...(landing ? { landingKey: landing.key } : {})
	};
}

/**
 * Target 'pages': root page for the workbook plus one subpage per dashboard. Target 'app': an app for the workbook
 * (`app`) plus one view per dashboard in tab order, and a "Worksheets" view for sheets on no dashboard.
 * Both come with layouts and filter cards. Mutates `cards[].pageKeys` to record where each card is placed.
 *
 * @param {WorkbookIR} ir
 * @param {CardPlan[]} cards
 * @param {FieldBindings} bindings
 * @param {{ options?: ConvertOptions, workbookKey?: string, variables?: import('../model/types.js').VariablePlan[], inlineParameters?: Map<string, string>, links?: import('./web-links.js').LinkContext, stacks?: Map<string, Object> }} [opts]
 *   `variables`: parameter controls of these variables become variable controls (`parameters: 'variables'`);
 *   `inlineParameters`: parameter id -> why it stays a constant (resolveParameterModes); `links`: the Tableau site and the
 *   other workbooks of the migration, for web zones that show their views; `stacks`: the zones of merged crosstab stacks
 *   (stack.js planCrosstabStacks placements)
 * @returns {{ pages: PagePlan[], cards: CardPlan[], issues: Issue[], app?: import('../model/types.js').AppPlan }}
 *   `cards`: filter cards and status text cards
 */
export function planPages(workbookIr, cards, bindings, { options = {}, workbookKey, variables, inlineParameters, links, stacks } = {}) {
	const ir = withoutHiddenZones(workbookIr);
	const issues = [];
	const pages = [];
	const usedKeys = new Set();
	const asApp = options.target === 'app';
	const textLimit = asApp ? APP_TEXT_LIMIT : MAX_HEADER_TEXT;
	const prefix = options.namePrefix ?? '';
	const workbookName = ir?.workbook?.name || 'Workbook';
	const rootKey = uniqueKey(workbookKey || slugify(workbookName), usedKeys);
	const rootTitle = options.pageTitle || `${prefix}${workbookName}`;
	/** @type {PagePlan|undefined} */
	const root = asApp ? undefined : { key: rootKey, title: rootTitle, dashboard: '' };
	if (root) pages.push(root);

	const cardsBySheet = new Map();
	for (const card of cards ?? []) {
		if (!card.pageKeys) card.pageKeys = [];
		if (card.worksheet) cardsBySheet.set(card.worksheet, card);
	}
	const filterCardsByKey = new Map();
	const beastModes = [];
	/** Text cards the Tableau links add (a copy of a status text card for each further view, or one just for the link) and image cards. */
	const extraCards = [];
	const dashboards = ir?.dashboards ?? [];
	const statusSheets = statusSheetNames(ir, dashboards);
	const labelCards = labelSheetCards(ir, dashboards, cardsBySheet, statusSheets);
	const status = planStatusSheets(ir, dashboards, statusSheets, cardsBySheet, bindings, workbookKey, { aligned: asApp });
	issues.push(...status.issues);
	const keyOf = new Map(dashboards.map((dash) => [dash, uniqueKey(`${rootKey}--${slugify(dash.name)}`, usedKeys)]));
	const stories = asApp ? ir?.stories ?? [] : [];
	const storyKeyOf = new Map(stories.map((story) => [story, uniqueKey(`${rootKey}--${slugify(story.name)}`, usedKeys)]));
	/** @type {import('./app-layout.js').AppContext|undefined} */
	const app = asApp
		? {
				ir,
				cardsBySheet: stackedSheets(cardsBySheet, cards),
				variables: options.parameters === 'variables' ? variables ?? [] : [],
				dashboardKeys: new Map(dashboards.map((d) => [d.name, keyOf.get(d)])),
				storyKeys: new Map(stories.map((s) => [s.name, storyKeyOf.get(s)])),
				actions: new Map()
			}
		: undefined;
	for (const item of asApp ? tabOrder([...dashboards, ...stories]) : dashboards) {
		if (storyKeyOf.has(item)) {
			const key = storyKeyOf.get(item);
			const result = planStoryLayout(item, key, app);
			const page = { key, title: capTitle(item.name, { type: 'story', name: item.name }, issues), appKey: rootKey, dashboard: '', story: item.name, layout: result.layout, ...(item.hidden ? { hidden: true } : {}) };
			pages.push(page);
			issues.push(...result.issues, ...applyAppLayoutRules(page.layout, { name: item.name }));
			continue;
		}
		const dash = item;
		const key = keyOf.get(dash);
		const result = planDashboard(ir, dash, key, cardsBySheet, bindings, options, filterCardsByKey, workbookKey, { variables, inlineParameters, textLimit, app, labelCards, statusSheets, statusNotes: status.notes.get(dash.name), links, extraCards, stacks, beastModes });
		/** @type {PagePlan} */
		const page = asApp
			? { key, title: capTitle(dash.name, { type: 'dashboard', name: dash.name }, issues), appKey: rootKey, dashboard: dash.name, layout: result.layout, ...(dash.hidden ? { hidden: true } : {}) }
			: { key, title: `${prefix}${dash.name}`, parentKey: rootKey, dashboard: dash.name, layout: result.layout };
		if (result.filters.length) page.filters = result.filters;
		if (result.dateRange) page.dateRange = result.dateRange;
		if (result.webLinks.length) page.webLinks = result.webLinks;
		if (!result.layout.content.length) issues.push(makeIssue(dash, 'warning', 'layout.empty', `Dashboard ${dash.name} has nothing that converts to a Domo page item`));
		pages.push(page);
		issues.push(...result.issues);
		if (asApp) issues.push(...applyAppLayoutRules(page.layout, dash));
	}
	if (app) {
		issues.push(...actionIssues(ir, app.actions, cards));
		const linked = new Set(pages.flatMap((pg) => [...linkedPageKeys(pg.layout)].filter((k) => k !== pg.key)));
		for (const page of pages) {
			if (!page.hidden || !linked.has(page.key)) continue;
			page.linked = true;
			issues.push({ severity: 'info', code: 'layout.hidden-linked', message: `Hidden ${page.story ? 'story' : 'dashboard'} "${page.title}" is opened by buttons or actions, so its view stays visible to them and only its navigation item is hidden`, object: { type: page.story ? 'story' : 'dashboard', name: page.title } });
		}
	}

	const onDashboards = new Set(dashboards.flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])].map((z) => z.worksheet).filter(Boolean)));
	const orphans = (cards ?? []).filter((c) => c.worksheet && !c.pageKeys.length && !(c.status === 'unsupported' && onDashboards.has(c.worksheet)));
	if (orphans.length) {
		const holder = asApp ? { key: uniqueKey(`${rootKey}--worksheets`, usedKeys), title: 'Worksheets', appKey: rootKey, dashboard: '' } : root;
		holder.layout = gridLayout(orphans);
		if (asApp) pages.push(holder);
		for (const c of orphans) c.pageKeys.push(holder.key);
		if (dashboards.length) {
			issues.push({ severity: 'info', code: 'layout.standalone-sheets', message: `${orphans.length} worksheet card(s) not on any dashboard placed on the ${asApp ? '"Worksheets" view' : 'root page'}`, object: { type: 'workbook', name: workbookName } });
		}
	}
	const planned = [...filterCardsByKey.values(), ...status.cards.filter((c) => c.pageKeys.length), ...extraCards];
	if (!asApp) return { pages, cards: planned, issues, beastModes };
	for (const page of pages) if (page.layout) page.layout.style = structuredClone(APP_VIEW_STYLE);
	const appPlan = planApp(ir, rootKey, capTitle(rootTitle, { type: 'workbook', name: workbookName }, issues), pages, cards, options, issues);
	return { pages, cards: planned, issues, app: appPlan, beastModes };
}
