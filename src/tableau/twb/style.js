/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').StyleRuleIR} StyleRuleIR
 * @typedef {import('../../model/types.js').BoxStyleIR} BoxStyleIR
 * @typedef {import('../../model/types.js').TextRunIR} TextRunIR
 * @typedef {import('../../model/types.js').FontIR} FontIR
 * @typedef {import('../../model/types.js').WorkbookStyleIR} WorkbookStyleIR
 */

const SIDES = ['top', 'right', 'bottom', 'left'];

/** `<format attr value>` children as attr -> value (the first unscoped value wins). */
export function formats(node) {
	const out = {};
	for (const f of node?.all('format') ?? []) {
		const attr = f.attr('attr');
		if (!attr || f.attr('field') || f.attr('id') || attr in out) continue;
		out[attr] = f.attr('value') ?? '';
	}
	return out;
}

/** @param {XmlNode|undefined} style @returns {StyleRuleIR[]} */
export function styleRules(style) {
	return (style?.all('style-rule') ?? [])
		.filter((r) => r.attr('element'))
		.map((r) => ({
			element: r.attr('element'),
			formats: r.all('format').filter((f) => f.attr('attr')).map((f) => {
				const out = { attr: f.attr('attr'), value: f.attr('value') ?? '' };
				if (f.attr('id')) out.id = f.attr('id');
				if (f.attr('field')) out.field = f.attr('field');
				return out;
			})
		}))
		.filter((r) => r.formats.length);
}

/** Unscoped formats of the rules for an element (the first value wins). */
export function ruleFormats(rules, element) {
	const out = {};
	for (const rule of rules ?? []) {
		if (rule.element !== element) continue;
		for (const f of rule.formats) if (!f.id && !f.field && !(f.attr in out)) out[f.attr] = f.value;
	}
	return out;
}

function px(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function sides(map, name) {
	const all = px(map[name]);
	const each = Object.fromEntries(SIDES.map((s) => [s, px(map[`${name}-${s}`]) ?? all]));
	if (SIDES.every((s) => each[s] === undefined)) return undefined;
	if (SIDES.every((s) => each[s] === all)) return all;
	return Object.fromEntries(SIDES.map((s) => [s, each[s] ?? 0]));
}

/**
 * Background, border, margin (outer padding) and padding (inner) from `<format>` children.
 * A border whose style is none is left out.
 * @param {XmlNode|undefined} node
 * @returns {BoxStyleIR|undefined}
 */
export function boxStyle(node) {
	const map = formats(node);
	/** @type {BoxStyleIR} */
	const out = {};
	if (map['background-color']) out.background = map['background-color'];
	const borderStyle = map['border-style'];
	if (borderStyle && borderStyle !== 'none') {
		out.border = { style: borderStyle };
		if (px(map['border-width']) !== undefined) out.border.width = px(map['border-width']);
		if (map['border-color']) out.border.color = map['border-color'];
	}
	const margin = sides(map, 'margin');
	if (margin !== undefined) out.margin = margin;
	const padding = sides(map, 'padding');
	if (padding !== undefined) out.padding = padding;
	return Object.keys(out).length ? out : undefined;
}

const RUN_ATTRS = { fontname: 'fontName', fontsize: 'fontSize', fontcolor: 'color', fontalignment: 'align', hyperlink: 'hyperlink' };
const ALIGN = { 0: 'left', 1: 'center', 2: 'right' };

/** @param {XmlNode} run @returns {FontIR} */
function runFont(run) {
	/** @type {FontIR} */
	const font = {};
	for (const [attr, key] of Object.entries(RUN_ATTRS)) {
		const v = run.attr(attr);
		if (v === undefined || v === '') continue;
		if (key === 'fontSize') font.fontSize = Number(v);
		else if (key === 'align') font.align = ALIGN[v] ?? v;
		else font[key] = v;
	}
	for (const flag of ['bold', 'italic', 'underline']) if (run.attr(flag) === 'true') font[flag] = true;
	return font;
}

/**
 * Styled runs of a formatted-text block. Paragraph-end runs ('Æ' and a newline) become a '\n' run.
 * @param {XmlNode|undefined} node
 * @returns {TextRunIR[]|undefined}  undefined when no run carries formatting
 */
export function textRuns(node) {
	const container = node?.name === 'formatted-text' ? node : node?.descendants('formatted-text')[0];
	const runs = container?.descendants('run') ?? [];
	const out = runs
		.map((r) => ({ text: r.textContent().replace(/Æ(?=\r?\n)/g, '').replace(/Æ/g, '').replace(/\r\n/g, '\n'), ...runFont(r) }))
		.filter((r) => r.text);
	return out.some((r) => Object.keys(r).length > 1) ? out : undefined;
}

/** Font of a `<button-caption-font-style>` or similar element. */
export function elementFont(node) {
	if (!node) return undefined;
	const font = runFont(node);
	return Object.keys(font).length ? font : undefined;
}

/** Shading and row dividers of a `<style>` (rows scope wins over unscoped; '#00000000' is Tableau's None). */
export function tableStyle(style) {
	const rules = style?.all('style-rule') ?? [];
	const find = (elements, attr, { scope, dataClass } = {}) => {
		for (const element of elements) {
			for (const rule of rules.filter((r) => r.attr('element') === element)) {
				const f = rule.all('format').find((x) => x.attr('attr') === attr && !x.attr('field') && !x.attr('id') && x.attr('scope') === scope && x.attr('data-class') === dataClass);
				if (f) return f.attr('value') ?? '';
			}
		}
		return undefined;
	};
	const fill = (dataClass) => find(['pane', 'header'], 'background-color', { scope: 'rows', dataClass }) ?? find(['pane', 'header'], 'background-color', { dataClass });
	/** @type {import('../../model/types.js').TableStyleIR} */
	const out = {};
	const bandSize = px(find(['table'], 'band-size', { scope: 'rows' }));
	if (bandSize !== undefined) out.rowBandSize = bandSize;
	const bandColor = find(['pane', 'header'], 'band-color', { scope: 'rows' });
	if (bandColor) out.rowBandColor = bandColor;
	const background = find(['table', 'worksheet', 'pane'], 'background-color');
	if (background) out.background = background;
	const total = fill('total');
	if (total) out.totalBackground = total;
	const subtotal = fill('subtotal');
	if (subtotal) out.subtotalBackground = subtotal;
	const text = (attr, dataClass) => find(['cell', 'pane', 'header'], attr, { scope: 'rows', dataClass }) ?? find(['cell', 'pane', 'header'], attr, { dataClass });
	for (const [key, attr, dataClass] of [['totalColor', 'color', 'total'], ['subtotalColor', 'color', 'subtotal'], ['totalWeight', 'font-weight', 'total'], ['subtotalWeight', 'font-weight', 'subtotal']]) {
		const value = text(attr, dataClass);
		if (value) out[key] = value;
	}
	const visibility = find(['table-div'], 'line-visibility', { scope: 'rows' });
	const stroke = px(find(['table-div'], 'stroke-size', { scope: 'rows' }));
	if (visibility === 'off' || stroke === 0) out.rowDividers = false;
	else if (visibility === 'on' || stroke) out.rowDividers = true;
	const dividerColor = find(['table-div'], 'stroke-color', { scope: 'rows' });
	if (dividerColor) out.rowDividerColor = dividerColor;
	return Object.keys(out).length ? out : undefined;
}

/**
 * Workbook `<style>` rules, the defaults of its 'all' rule and the custom palettes in `<preferences>`.
 * @param {XmlNode} root
 * @returns {WorkbookStyleIR|undefined}
 */
export function workbookStyle(root) {
	const rules = styleRules(root.child('style'));
	const palettes = (root.child('preferences')?.all('color-palette') ?? [])
		.filter((p) => p.attr('name'))
		.map((p) => ({ name: p.attr('name'), type: p.attr('type') || 'regular', colors: p.all('color').map((c) => c.textContent().trim()).filter(Boolean) }));
	const all = ruleFormats(rules, 'all');
	const defaults = {};
	if (all['font-family']) defaults.fontFamily = all['font-family'];
	if (px(all['font-size']) !== undefined) defaults.fontSize = px(all['font-size']);
	if (all.color) defaults.color = all.color;
	if (!rules.length && !palettes.length) return undefined;
	/** @type {WorkbookStyleIR} */
	const out = { rules };
	if (Object.keys(defaults).length) out.defaults = defaults;
	const table = tableStyle(root.child('style'));
	if (table) out.table = table;
	if (palettes.length) out.palettes = palettes;
	return out;
}
