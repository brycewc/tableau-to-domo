import { slugify } from '../util/ids.js';
import { opaqueHex } from './app-layout.js';
import { MIN_TILE_WIDTH } from './tile.js';

/**
 * Dashboard headers (target app): the top band of a dashboard, Tableau's banner image or a filled title, with the title,
 * text zones, status text and logos on it. It becomes one section without a bar whose background is the image (an
 * IMAGE_REFERENCE item style) or the fill (a theme section style), the title and texts as text cards keeping Tableau's
 * alignment, bold, size and color, and the logos as image cards, each at its Tableau columns.
 *
 * @typedef {import('../model/types.js').ZoneIR} ZoneIR
 * @typedef {import('../model/types.js').DashboardIR} DashboardIR
 */

const STANDARD_WIDTH = 60;
const BANNER_MIN_WIDTH = 0.8;
const BAND_MIN_WIDTH = 0.5;
const BAND_MAX_TOP = 0.15;
const CENTER_EPS = 0.005;
const TEXT_SIZES = [
	{ size: 'header', minPt: 18, px: 32, line: 40 },
	{ size: 'title', minPt: 14, px: 24, line: 30 },
	{ size: 'subtitle', minPt: 11, px: 18, line: 23 }
];
const BODY = { px: 14, line: 21 };
// Tableau's default dashboard title and text sizes (points).
const DEFAULT_PT = { title: 18, text: 9 };
const NOTEBOOK_PAD_PX = 24;
const COLUMN_PX = 1268 / STANDARD_WIDTH;
const ROW_PX = COLUMN_PX / 1.67;
const CHAR_EM = 0.55;
// The user's Demand Management header: every item 6 rows high on a phone.
export const COMPACT_HEADER_ROWS = 6;
const ALIGN = { left: 'left', center: 'center', right: 'right' };

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (r, band) => {
	const c = center(r);
	return c.x >= band.x - CENTER_EPS && c.x <= band.x + band.w + CENTER_EPS && c.y >= band.y - CENTER_EPS && c.y <= band.y + band.h + CENTER_EPS;
};

/**
 * The header band of a dashboard: a banner image with its package bytes (`image`), else the first filled title or text
 * zone near the top (`fill`, when it differs from the view background), with the zones on it (`members`, in Tableau order,
 * the filled zone first). Undefined for a dashboard without one.
 * @param {DashboardIR} dash
 * @param {(zone: ZoneIR) => string|undefined} fillOf  A title or text zone's fill
 * @param {(zone: ZoneIR) => boolean} isMember  Zones that can sit on the band (texts, logos, status sheets)
 */
export function findHeader(dash, fillOf, isMember) {
	const zones = [...(dash.zones ?? []), ...(dash.floating ?? [])];
	const background = opaqueHex(dash.background) ?? '#FFFFFF';
	const top = (z) => z.rect && z.rect.y < BAND_MAX_TOP;
	const image = zones.find((z) => z.kind === 'image' && z.image && top(z) && z.rect.w >= BANNER_MIN_WIDTH);
	const filled = image ? undefined : zones.find((z) => (z.kind === 'title' || z.kind === 'text') && top(z) && z.rect.w >= BAND_MIN_WIDTH && fillOf(z) && fillOf(z) !== background && isMember(z));
	const band = image ?? filled;
	if (!band) return undefined;
	const members = zones.filter((z) => z !== image && z.rect && (z === filled || (inside(z.rect, band.rect) && isMember(z))));
	if (filled) members.sort((a, b) => (a === filled ? -1 : b === filled ? 1 : 0));
	return { band, rect: band.rect, ...(image ? { image } : { fill: fillOf(filled) }), members };
}

const isBoldRun = (run) => Boolean(run.bold) || /bold|black|heavy/i.test(String(run.fontName ?? ''));

/** The Domo text size of a Tableau font size (points); undefined is body text. */
export function textSize(pt) {
	return TEXT_SIZES.find((s) => pt >= s.minPt)?.size;
}

/** Runs with each field token in one run: Tableau writes `<[ds].[field]>` as the runs '<', '[ds].[field]' and '>'. */
function joinTokenRuns(runs) {
	const queue = [...runs];
	const out = [];
	for (let i = 0; i < queue.length; i += 1) {
		const [a, b, c] = queue.slice(i, i + 3).map((r) => String(r.text ?? ''));
		if (!(a.endsWith('<') && b && !/[<>]/.test(b) && c?.startsWith('>'))) {
			out.push(queue[i]);
			continue;
		}
		if (a.length > 1) out.push({ ...queue[i], text: a.slice(0, -1) });
		out.push({ ...queue[i + 1], text: `<${b}>` });
		if (c.length > 1) queue[i + 2] = { ...queue[i + 2], text: c.slice(1) };
		i += c.length > 1 ? 1 : 2;
	}
	return out;
}

/** `resolve` on a run's text, keeping the spaces and line breaks around it that resolveTitle trims. */
function resolveKeepingEdges(text, resolve) {
	if (!/<[^<>]+>/.test(text)) return text;
	const [, lead, body, trail] = /^(\s*)([^]*?)(\s*)$/.exec(text);
	return `${lead}${resolve(body)}${trail}`;
}

/**
 * A title or text zone as text card paragraphs: one per line, each run's bold, color (`#RRGGBB`) and size kept, field
 * tokens other than <Sheet Name> left out after `resolve`; `align` from the first run that sets one (Tableau's default is left).
 * @param {ZoneIR} zone
 * @param {DashboardIR} dash
 * @param {string} text  The zone's text with its tokens resolved, used when it has no runs
 * @param {(text: string) => string} [resolve]  Resolves a run's tokens (parameter values) to static text
 */
export function headerParagraphs(zone, dash, text, resolve = (t) => t) {
	const runs = zone.kind === 'title' ? (zone.runs ?? dash.title?.runs) : zone.runs;
	const defaultPt = DEFAULT_PT[zone.kind] ?? DEFAULT_PT.text;
	const source = runs?.length ? joinTokenRuns(runs) : [{ text }];
	const paragraphs = [[]];
	for (const run of source) {
		const style = { ...(isBoldRun(run) ? { bold: true } : {}), ...(opaqueHex(run.color) ? { color: opaqueHex(run.color) } : {}), ...(textSize(Number(run.fontSize) || defaultPt) ? { size: textSize(Number(run.fontSize) || defaultPt) } : {}) };
		const raw = resolveKeepingEdges(String(run.text ?? '').replace(/\r\n?/g, '\n').replace(/<Sheet Name>/gi, dash.name), resolve).replace(/<[^<>]+>/g, '');
		raw.split('\n').forEach((piece, i) => {
			if (i) paragraphs.push([]);
			if (!piece) return;
			const last = paragraphs.at(-1).at(-1);
			if (last && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...style, text: '' })) last.text += piece;
			else paragraphs.at(-1).push({ text: piece, ...style });
		});
	}
	const tidy = paragraphs.map((segments) => trimEdges(segments)).filter((segments, i, all) => segments.length || (i > 0 && i < all.length - 1 && all.slice(i + 1).some((s) => s.length)));
	while (tidy.length && !tidy[0].length) tidy.shift();
	const align = ALIGN[source.find((r) => r.align)?.align] ?? 'left';
	return { paragraphs: tidy, align };
}

function trimEdges(segments) {
	const out = segments.map((s) => ({ ...s }));
	if (out.length) out[0].text = out[0].text.replace(/^\s+/, '');
	if (out.length) out[out.length - 1].text = out.at(-1).text.replace(/\s+$/, '');
	return out.filter((s) => s.text);
}

/** True when a plain title needs a text card to look like Tableau's: not left aligned, or bold. */
export const needsTextCard = ({ paragraphs, align }) => align !== 'left' || paragraphs.flat().some((s) => s.bold);

/** The text card of a header title or text zone. */
export function headerCard(pageKey, zone, { paragraphs, align }) {
	const text = paragraphs.map((p) => p.map((s) => s.text).join('')).join(' ');
	const title = text.length > 60 ? `${text.slice(0, 57).trimEnd()}...` : text || zone.kind;
	return { key: `${pageKey}.header.${slugify(zone.id)}`, kind: 'notebook', header: true, title, worksheet: '', datasetKey: '', chartType: 'notebook', body: { notebook: { title, paragraphs, align, valign: 'middle' } }, pageKeys: [pageKey], status: 'ok' };
}

/** A text zone off the header (a footnote) as a top aligned text card; `header` lets push adopt one made in Domo. */
export function textZoneCard(pageKey, zone, parsed) {
	const card = headerCard(pageKey, zone, parsed);
	return { ...card, key: `${pageKey}.text.${slugify(zone.id)}`, body: { notebook: { ...card.body.notebook, valign: 'top' } } };
}

/** The section background image of a header band: uploaded at push, no card. */
export function sectionImageCard(pageKey, zone) {
	return { key: `${pageKey}.section-image.${slugify(zone.id)}`, kind: 'image', section: true, title: zone.image.name, worksheet: '', datasetKey: '', chartType: 'document', body: { image: { ...zone.image } }, pageKeys: [pageKey], status: 'ok' };
}

const fontOf = (size) => TEXT_SIZES.find((s) => s.size === size) ?? BODY;

/** Lines a paragraph wraps to at `width` columns in a text card, with the line height of its largest text. */
function paragraphLines(segments, width, columnPx = COLUMN_PX) {
	const text = segments.map((s) => s.text ?? s.owner ?? 'Mmm 00, 0000, 00:00 AM').join('');
	const font = segments.map((s) => fontOf(s.size)).reduce((a, b) => (b.line > a.line ? b : a), BODY);
	const perLine = Math.max(4, Math.floor((width * columnPx - NOTEBOOK_PAD_PX) / (font.px * CHAR_EM)));
	return { lines: Math.max(1, Math.ceil(text.length / perLine)), line: font.line };
}

/** Rows a text card needs for its paragraphs at `width` columns, plus a row to spare; standard grid cells unless given. */
export function textCardRows(paragraphs, width, { columnPx = COLUMN_PX, rowPx = ROW_PX } = {}) {
	const px = paragraphs.reduce((sum, p) => {
		const { lines, line } = paragraphLines(p, width, columnPx);
		return sum + lines * line;
	}, 0);
	return Math.ceil((NOTEBOOK_PAD_PX + px) / rowPx) + 1;
}

/** Columns the widest paragraph of a text card needs on one line. */
export function textCardWidth(paragraphs) {
	const px = Math.max(0, ...paragraphs.map((p) => p.reduce((sum, s) => sum + String(s.text ?? s.owner ?? '').length * fontOf(s.size).px * CHAR_EM, 0)));
	return Math.ceil((px + NOTEBOOK_PAD_PX) / COLUMN_PX);
}

const cols = (r) => {
	const x0 = Math.max(0, Math.min(STANDARD_WIDTH - MIN_TILE_WIDTH, Math.round(r.x * STANDARD_WIDTH)));
	return { x0, x1: Math.min(STANDARD_WIDTH, Math.max(x0 + MIN_TILE_WIDTH, Math.round((r.x + r.w) * STANDARD_WIDTH))) };
};

/**
 * Fixed items that Tableau stacks in the same columns (a logo above the status line): their column spans overlap by half
 * the narrower and their rows do not, so they share columns, one above the other.
 */
function stacks(items) {
	const out = [];
	for (const i of [...items].sort((a, b) => a.rect.y - b.rect.y)) {
		const c = cols(i.rect);
		const fits = (s) => {
			const shared = Math.min(s.x1, c.x1) - Math.max(s.x0, c.x0);
			const apart = s.members.every((m) => Math.min(m.rect.y + m.rect.h, i.rect.y + i.rect.h) - Math.max(m.rect.y, i.rect.y) <= 0.2 * Math.min(m.rect.h, i.rect.h));
			return shared >= 0.5 * Math.min(s.x1 - s.x0, c.x1 - c.x0) && apart;
		};
		const stack = out.find(fits);
		if (stack) {
			stack.members.push(i);
			stack.x0 = Math.min(stack.x0, c.x0);
			stack.x1 = Math.max(stack.x1, c.x1);
		} else out.push({ members: [i], ...c });
	}
	return out.sort((a, b) => a.x0 - b.x0);
}

/**
 * Columns of the items on a header band: fixed items (logos, status and text cards) at their Tableau columns, items Tableau
 * stacks in the same columns one above the other (`top` and `share` of the band's height), an overlapping pair split at
 * the later one's left edge; a wide text (`flex`, a title spanning the band) keeps its columns where nothing else is,
 * centered text around its Tableau center when the free space there fits it, else the widest free run of columns.
 * @param {{ rect: {x:number,y:number,w:number,h:number}, flex?: boolean, align?: string, need?: number }[]} items
 * @returns {{ x: number, width: number, top: number, share: number }[]} In the order of `items`
 */
export function bandColumns(items) {
	const fixed = stacks(items.filter((i) => !i.flex));
	for (let k = 1; k < fixed.length; k++) {
		const prev = fixed[k - 1];
		const cur = fixed[k];
		if (cur.x0 >= prev.x1) continue;
		prev.x1 = Math.max(prev.x0 + MIN_TILE_WIDTH, cur.x0);
		cur.x0 = Math.max(cur.x0, prev.x1);
		cur.x1 = Math.max(cur.x1, Math.min(STANDARD_WIDTH, cur.x0 + MIN_TILE_WIDTH));
	}
	const units = fixed.map((f) => ({ members: f.members, align: f.members.length === 1 ? f.members[0].align : undefined, box: { x: f.x0, width: f.x1 - f.x0 } }));
	for (const i of items.filter((x) => x.flex)) {
		const span = cols(i.rect);
		const blocks = fixed.filter((f) => f.x0 < span.x1 && f.x1 > span.x0);
		const free = [];
		let at = span.x0;
		for (const b of blocks) {
			if (b.x0 > at) free.push([at, b.x0]);
			at = Math.max(at, b.x1);
		}
		if (span.x1 > at) free.push([at, span.x1]);
		const c = (span.x0 + span.x1) / 2;
		const left = Math.max(span.x0, ...blocks.filter((b) => (b.x0 + b.x1) / 2 <= c).map((b) => b.x1));
		const right = Math.min(span.x1, ...blocks.filter((b) => (b.x0 + b.x1) / 2 > c).map((b) => b.x0));
		const half = Math.floor(Math.min(c - left, right - c));
		const widest = free.reduce((best, f) => (f[1] - f[0] > best[1] - best[0] ? f : best), [span.x0, span.x0]);
		let box;
		if (i.align === 'center' && blocks.length && 2 * half >= (i.need ?? 0) && 2 * half >= MIN_TILE_WIDTH) box = { x: Math.round(c - half), width: 2 * half };
		else if (widest[1] - widest[0] >= MIN_TILE_WIDTH) box = { x: widest[0], width: widest[1] - widest[0] };
		else box = { x: span.x0, width: span.x1 - span.x0 };
		units.push({ members: [i], align: i.align, box });
	}
	closeGaps(units);
	const out = new Map();
	for (const u of units) {
		const total = u.members.reduce((sum, m) => sum + m.rect.h, 0);
		let top = 0;
		for (const m of u.members) {
			const share = u.members.length === 1 ? 1 : m.rect.h / total;
			out.set(m, { ...u.box, top, share });
			top += share;
		}
	}
	return items.map((i) => out.get(i));
}

/**
 * Widen the band's columns over the gaps between them (App Studio would widen them anyway): centered text first by the
 * same amount on both sides, so it stays where Tableau centers it, then each gap split between its two neighbors.
 */
function closeGaps(units) {
	const row = [...units].sort((a, b) => a.box.x - b.box.x);
	const gap = (k, side) => (side < 0 ? row[k].box.x - (k ? row[k - 1].box.x + row[k - 1].box.width : 0) : (k < row.length - 1 ? row[k + 1].box.x : STANDARD_WIDTH) - (row[k].box.x + row[k].box.width));
	const centered = (r) => r?.align === 'center';
	row.forEach((r, k) => {
		if (!centered(r)) return;
		const grow = Math.max(0, Math.min(gap(k, -1), gap(k, 1)));
		r.box.x -= grow;
		r.box.width += 2 * grow;
	});
	row.forEach((r, k) => {
		const left = gap(k, -1);
		if (left <= 0) return;
		const prev = row[k - 1];
		const take = centered(r) ? 0 : !prev ? left : centered(prev) ? left : Math.ceil(left / 2);
		r.box.x -= take;
		r.box.width += take;
		if (prev && !centered(prev)) prev.box.width += left - take;
	});
	const last = row.at(-1);
	if (last && !centered(last)) last.box.width = STANDARD_WIDTH - last.box.x;
}

/** Column runs of the band no item covers (beside centered text), each to hold a SPACER so the text stays centered. */
export function bandHoles(columns) {
	const holes = [];
	let at = 0;
	for (const c of [...columns].sort((a, b) => a.x - b.x)) {
		if (c.x > at) holes.push({ x: at, width: c.x - at });
		at = Math.max(at, c.x + c.width);
	}
	if (at < STANDARD_WIDTH) holes.push({ x: at, width: STANDARD_WIDTH - at });
	return holes;
}
