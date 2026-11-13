import { parseLiteral } from './xml.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').ColorEncodingIR} ColorEncodingIR
 */

// Past this a color map is account names or zip codes; below it a period label map (239 fiscal periods) must stay whole.
export const MAX_COLOR_MEMBERS = 1000;

const HEX = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;

/** '#4e79a7' from a map's `to` (worksheet styles escape it as '\#4e79a7'), or undefined. */
export function colorValue(raw) {
	const m = HEX.exec(String(raw ?? '').replace(/\\/g, '').trim());
	return m ? `#${m[1].toLowerCase()}` : undefined;
}

/** @param {XmlNode} enc @returns {ColorEncodingIR} */
function parseEncoding(enc) {
	/** @type {ColorEncodingIR} */
	const out = { type: enc.attr('type') || 'palette' };
	if (enc.attr('palette')) out.palette = enc.attr('palette');
	const members = [];
	let multi = false;
	for (const map of enc.all('map')) {
		const color = colorValue(map.attr('to'));
		if (!color) continue;
		if (map.child('multibucket')) multi = true;
		for (const bucket of map.all('bucket')) {
			members.push({ value: parseLiteral(bucket.textContent()), color });
		}
	}
	if (members.length > MAX_COLOR_MEMBERS) out.truncated = members.length;
	if (members.length) out.members = members.slice(0, MAX_COLOR_MEMBERS);
	if (multi) out.multi = true;
	const palette = enc.child('color-palette');
	const colors = (palette?.all('color') ?? []).map((c) => colorValue(c.textContent())).filter(Boolean);
	if (colors.length) out.colors = colors;
	if (palette?.attr('type')) out.paletteType = palette.attr('type');
	const center = Number(enc.attr('center'));
	if (enc.attr('center') && Number.isFinite(center)) out.center = center;
	const steps = Number(enc.attr('num-steps'));
	if (Number.isInteger(steps) && steps > 0) out.steps = steps;
	if (enc.attr('include-totals') === 'true') out.includeTotals = true;
	return out;
}

/**
 * The color encodings of a `<style>` (its 'mark' rules), by field as written there: a column instance (`[none:Region:nk]`) in
 * a datasource's style, a full pill id in a worksheet's.
 * @param {XmlNode|undefined} style
 * @returns {Map<string, ColorEncodingIR>}
 */
export function colorEncodings(style) {
	const out = new Map();
	for (const rule of style?.all('style-rule') ?? []) {
		if (rule.attr('element') !== 'mark') continue;
		for (const enc of rule.all('encoding')) {
			const field = enc.attr('field');
			if (enc.attr('attr') !== 'color' || !field || out.has(field)) continue;
			out.set(field, parseEncoding(enc));
		}
	}
	return out;
}

const columnOf = (instance) => {
	const m = /^\[(?:[a-z0-9]*:)?(.*?)(?::[a-z0-9]+)*\]$/i.exec(instance);
	return m ? m[1] : instance;
};

/**
 * The encoding that colors a worksheet's color pill: the worksheet's own, else its datasource's for the same column instance,
 * else for the same column under another derivation.
 * @param {string} pillId  '[ds].[none:Region:nk]'
 * @param {Map<string, ColorEncodingIR>} sheet
 * @param {Map<string, Map<string, ColorEncodingIR>>} datasources  datasource id -> its encodings
 * @returns {(ColorEncodingIR & { source: 'worksheet'|'datasource' })|undefined}
 */
export function resolveColorEncoding(pillId, sheet, datasources) {
	if (sheet.has(pillId)) return { ...sheet.get(pillId), source: 'worksheet' };
	const m = /^\[([^\]]+)\]\.(\[.*\])$/.exec(pillId);
	if (!m) return undefined;
	const [, dsId, local] = m;
	const own = datasources.get(dsId);
	if (!own) return undefined;
	if (own.has(local)) return { ...own.get(local), source: 'datasource' };
	const column = columnOf(local);
	for (const [field, enc] of own) if (columnOf(field) === column) return { ...enc, source: 'datasource' };
	return undefined;
}

/** The fixed mark color of a pane (Color > one color), from its 'mark' style rule. */
export function paneMarkColor(pane) {
	for (const rule of pane?.child('style')?.all('style-rule') ?? []) {
		if (rule.attr('element') !== 'mark') continue;
		const f = rule.all('format').find((x) => x.attr('attr') === 'mark-color' && !x.attr('field'));
		if (f) return colorValue(f.attr('value'));
	}
	return undefined;
}

/** Pane-wide formats of a style rule; a format naming a field or scope belongs to that field, not the marks. */
function paneFormats(pane, element) {
	return (pane?.child('style')?.all('style-rule') ?? [])
		.filter((r) => r.attr('element') === element)
		.flatMap((r) => r.all('format'))
		.filter((f) => !f.attr('field') && !f.attr('scope'));
}

/** Mark label alignment (Label > Alignment), from the pane's 'cell' style rule. */
export function paneLabelAlign(pane) {
	const formats = paneFormats(pane, 'cell');
	const value = (attr) => formats.find((f) => f.attr('attr') === attr)?.attr('value');
	const out = {};
	if (value('text-align')) out.horizontal = value('text-align');
	if (value('vertical-align')) out.vertical = value('vertical-align');
	return Object.keys(out).length ? out : undefined;
}

/** Mark label color (Label > Font): `auto`, `match` (the mark's) or `user` with its color, from the 'datalabel' rule. */
export function paneLabelColor(pane) {
	const formats = paneFormats(pane, 'datalabel');
	const mode = formats.find((f) => f.attr('attr') === 'color-mode')?.attr('value');
	if (!mode) return undefined;
	const color = mode === 'user' ? colorValue(formats.find((f) => f.attr('attr') === 'color')?.attr('value')) : undefined;
	return color ? { mode, color } : { mode };
}
