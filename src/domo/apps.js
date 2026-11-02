import { instanceHost } from './client.js';

const APPS = '/content/v1/dataapps';
const enc = encodeURIComponent;
const READ_ONLY_FIELDS = ['userAccess', 'navigations', 'views', 'persistSettings'];

/**
 * Create an App Studio app. The response holds the default view ("App Page 1"), which is also the landing view.
 * Create honors the navigation settings and the theme (Clarion when none is sent).
 * @param {import('./client.js').DomoClient} c
 * @param {{ title: string, description?: string, navigation?: import('../model/types.js').AppPlan['navigation'], theme?: Object }} spec
 * @returns {Promise<{ app: Object, id: number, defaultViewId: number|undefined }>}
 */
export async function createApp(c, { title, description, navigation, theme }) {
	if (!title) throw new Error('createApp: title is required');
	const body = { title, description: description ?? '', type: 'app', ...(navigation ? navigationFields(navigation) : {}), ...(theme ? { theme } : {}) };
	const app = await c.post(APPS, body);
	if (app?.dataAppId == null) throw new Error(`createApp: response had no dataAppId: ${JSON.stringify(app).slice(0, 500)}`);
	return { app, id: app.dataAppId, defaultViewId: app.landingViewId ?? app.views?.[0]?.viewId };
}

/** @param {import('./client.js').DomoClient} c */
export async function getApp(c, id) {
	return c.get(`${APPS}/${enc(id)}`, { query: { includeHiddenViews: true } });
}

/**
 * The app PUT replaces the whole object (omitted flags reset, a null landingViewId becomes 0), so `body` must be a
 * full GET merged with the changes. Fields the PUT ignores or rejects are dropped.
 * @param {import('./client.js').DomoClient} c
 */
export async function updateApp(c, id, body) {
	const out = { ...body };
	for (const field of READ_ONLY_FIELDS) delete out[field];
	return c.put(`${APPS}/${enc(id)}`, out, { query: { includeHiddenViews: true } });
}

/**
 * App fields for t2d's navigation settings, as the editor sets them (NavigationConfiguration): TOP shows Domo's own
 * navigation unless turned off; LEFT requires showDomoNavigation false and hides the app title.
 */
function navigationFields(navigation) {
	const left = navigation.orientation === 'LEFT';
	return {
		navOrientation: navigation.orientation,
		showDomoNavigation: !left && navigation.showDomoNavigation !== false,
		showNavigation: navigation.showNavigation,
		showTitle: navigation.showTitle ?? !left
	};
}

/**
 * Merge t2d's app settings (and optionally a theme object) into an app read with getApp. Pure.
 * @param {Object} current
 * @param {{ title: string, description?: string, navigation: import('../model/types.js').AppPlan['navigation'] }} settings
 * @param {Object} [theme]
 */
export function mergeAppSettings(current, { title, description, navigation }, theme) {
	const out = { ...current, title, ...(description !== undefined ? { description } : {}), ...navigationFields(navigation) };
	if (theme) out.theme = theme;
	return out;
}

/** True when an app already has these settings (and the theme, by name). Pure. */
export function hasAppSettings(app, { title, navigation }, theme) {
	const fields = navigationFields(navigation);
	if (app?.title !== title) return false;
	if (Object.entries(fields).some(([k, v]) => v !== undefined && app?.[k] !== v)) return false;
	return !theme || String(app?.theme?.name ?? '').toLowerCase() === String(theme.name ?? '').toLowerCase();
}

/** Built-in (`default`) and saved themes; `saved` is null when the app has none. */
export async function listThemes(c, appId) {
	return c.get(`${APPS}/themes`, { query: appId != null ? { dataAppId: appId } : undefined });
}

/** A theme by name (case-insensitive) among the built-in and saved themes, or undefined. */
export function findTheme(themes, name) {
	const wanted = String(name ?? '').toLowerCase();
	return [...(themes?.default ?? []), ...(themes?.saved ?? [])].find((t) => String(t?.name ?? '').toLowerCase() === wanted);
}

const MAX_COLOR_ID = 99;
const MAX_PADDING = 16;
const colorRef = (id) => ({ type: 'COLOR_REFERENCE', value: id });

/** Mutates `theme`: a missing color is appended as CUSTOM. */
function themeColorId(theme, hex, notes) {
	theme.colors = theme.colors ?? [];
	const wanted = String(hex).toUpperCase();
	const found = theme.colors.find((c) => c.value?.type === 'RGB_HEX' && String(c.value.value).toUpperCase() === wanted && (c.tags ?? []).some((t) => t === 'THEME' || t === 'CUSTOM'));
	if (found) return found.id;
	const used = new Set(theme.colors.map((c) => Number(String(c.id).slice(1))));
	let n = 1;
	while (used.has(n)) n += 1;
	if (n > MAX_COLOR_ID) {
		notes.push(`no free theme color id for ${wanted}`);
		return undefined;
	}
	theme.colors.push({ id: `c${n}`, value: { type: 'RGB_HEX', value: wanted }, tags: ['CUSTOM'] });
	return `c${n}`;
}
const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

/**
 * A copy of a built-in theme with the workbook's formatting applied. Pure. Theme rules: hex is uppercase, color ids stop at c99, backgrounds and borders reference THEME or
 * CUSTOM colors, font colors are the FONT colors, families are the five allowed. New colors are appended as CUSTOM.
 * @param {Object} theme  From listThemes
 * @param {import('../model/types.js').AppThemeOverrides} [overrides]
 * @returns {{ theme: Object, notes: string[] }}
 */
export function applyThemeOverrides(theme, overrides) {
	const out = structuredClone(theme);
	const notes = [];
	if (!overrides || !Object.keys(overrides).length) return { theme: out, notes };
	out.name = `${theme.name} (Tableau)`;
	out.colors = out.colors ?? [];
	const colorId = (hex) => themeColorId(out, hex, notes);
	const mapping = (list, key) => (out[list] ?? []).find((s) => s.id === out.mappings?.[key]);
	if (overrides.background) {
		const id = colorId(overrides.background);
		if (id) {
			out.app = { ...(out.app ?? {}), backgroundColor: colorRef(id) };
			for (const page of out.pages ?? []) page.background = colorRef(id);
		}
	}
	if (overrides.card) {
		for (const style of [mapping('cards', 'chart'), mapping('tables', 'table')].filter(Boolean)) {
			const bg = overrides.card.background ? colorId(overrides.card.background) : undefined;
			if (bg) style.backgroundColor = colorRef(bg);
			const border = overrides.card.borderColor ? colorId(overrides.card.borderColor) : undefined;
			if (border) {
				style.borderColor = colorRef(border);
				style.borderWidth = Math.min(4, Math.max(0, Math.round(overrides.card.borderWidth ?? 1)));
			}
		}
	}
	const table = overrides.table && mapping('tables', 'table');
	if (table) {
		const t = overrides.table;
		const ref = (hex) => {
			const id = colorId(hex);
			return id ? colorRef(id) : undefined;
		};
		const set = (key, hex) => {
			const value = ref(hex);
			if (value) table[key] = value;
		};
		set('rowColor', t.rowColor);
		set('headerBackgroundColor', t.rowColor);
		set('totalRowBackgroundColor', t.totalColor);
		set('subtotalRowBackgroundColor', t.subtotalColor);
		const band = t.bandColor ? ref(t.bandColor) : undefined;
		table.alternatingRowColorEnabled = Boolean(band);
		if (band) table.alternatingRowColor = band;
		const border = t.borderColor ? ref(t.borderColor) : undefined;
		table.tableBorderType = border ? t.borderType : 'NONE';
		table.tableBorderWeight = border ? 1 : 0;
		if (border) table.tableBorderColor = border;
		// The fills turn light or dark, so header and total text follow the automatic font color (TV: FONT colors only).
		const auto = out.colors.find((c) => c.value?.type === 'AUTOMATIC_COLOR');
		if (auto) for (const key of ['headerFontColor', 'totalRowFontColor', 'subtotalRowFontColor']) table[key] = colorRef(auto.id);
	}
	if (overrides.buttonBackground) {
		const button = mapping('buttons', 'button');
		const id = button ? colorId(overrides.buttonBackground) : undefined;
		if (id) button.backgroundColor = colorRef(id);
	}
	if (overrides.fontColor) {
		const auto = out.colors.find((c) => c.value?.type === 'AUTOMATIC_COLOR');
		const side = luminance(overrides.fontColor) < 0.5 ? 'dark' : 'light';
		const target = out.colors.find((c) => c.id === auto?.value?.[side]?.value && c.value?.type === 'RGB_HEX');
		if (target) target.value = { ...target.value, value: String(overrides.fontColor).toUpperCase() };
	}
	if (overrides.fontFamily) for (const font of out.fonts ?? []) font.family = overrides.fontFamily;
	if (overrides.titleFontFamily) {
		const ids = new Set([...(out.headers ?? []).map((h) => h.font?.value), ...(out.cards ?? []).map((c) => c.titleFont?.value)].filter(Boolean));
		for (const font of out.fonts ?? []) if (ids.has(font.id)) font.family = overrides.titleFontFamily;
	}
	return { theme: out, notes };
}

// Domo drops card styles past the eighth, so a control style is never added, only repointed.
const ZERO_PADDING = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * A theme with t2d's Tableau spacing: the card style mapped to controls unpadded and
 * with no margin under its header; the chart, single value, control, table and section styles square; no drop shadow
 * on any card, table or text card style (Tableau zones have none); no standard density on pages and sections (no gap between items, as Tableau tiles them). A control style another mapping shares is
 * copied onto the last card style no mapping uses, which controls then map to; with none free it is left alone.
 * `control`: the workbook's filter style (AppThemeOverrides.control), set on the control style. `images`: the app has
 * image cards, so the document style is square, unpadded and with no header margin. Pure.
 * @param {Object} theme  An app theme
 * @param {{ control?: import('../model/types.js').AppThemeOverrides['control'], images?: boolean }} [opts]
 * @returns {{ theme: Object, changed: boolean, notes: string[] }}
 */
export function applyControlSpacing(theme, { control: filterStyle, images = false } = {}) {
	const out = structuredClone(theme);
	const notes = [];
	const mappings = out.mappings ?? {};
	const cards = out.cards ?? [];
	let control = cards.find((s) => s.id === mappings.control);
	if (control && Object.entries(mappings).some(([k, id]) => k !== 'control' && id === control.id)) {
		const used = new Set(Object.values(mappings));
		const free = cards.findLast((s) => !used.has(s.id));
		if (free) {
			Object.assign(free, structuredClone({ ...control, id: free.id }));
			mappings.control = free.id;
			control = free;
		} else {
			notes.push(`control style ${control.id} is shared with other items and no card style is free; control spacing not set`);
			control = undefined;
		}
	}
	if (control) {
		control.padding = { ...ZERO_PADDING };
		control.elementSpacing = { ...(control.elementSpacing ?? {}), isCustom: true, header: { ...(control.elementSpacing?.header ?? {}), bottomMargin: 0 } };
		if (filterStyle) {
			const background = filterStyle.background ? themeColorId(out, filterStyle.background, notes) : undefined;
			if (background) control.backgroundColor = colorRef(background);
			control.borderWidth = Math.min(4, Math.max(0, filterStyle.borderWidth ?? 0));
		}
	}
	for (const style of [control, ...['chart', 'singleValue'].map((k) => cards.find((s) => s.id === mappings[k])), (out.tables ?? []).find((s) => s.id === mappings.table)]) {
		if (style) style.borderRadius = 0;
	}
	for (const style of [...cards, ...(out.tables ?? []), ...(out.notebooks ?? [])]) {
		// Domo rejects a dropShadowColor beside NONE, and a notebook style without a dropShadow.
		if (style.dropShadow && style.dropShadow !== 'NONE') Object.assign(style, { dropShadow: 'NONE', dropShadowColor: null });
	}
	const document = images ? cards.find((s) => s.id === mappings.document) : undefined;
	if (document) {
		Object.assign(document, { borderRadius: 0, padding: { ...ZERO_PADDING } });
		document.elementSpacing = { ...(document.elementSpacing ?? {}), isCustom: true, header: { ...(document.elementSpacing?.header ?? {}), bottomMargin: 0 } };
	}
	const section = (out.sections ?? []).find((s) => s.id === mappings.section);
	if (section) {
		section.density = { ...(section.density ?? {}), standard: 0 };
		section.borderRadius = 0;
	}
	for (const page of out.pages ?? []) page.density = { ...(page.density ?? {}), standard: 0 };
	return { theme: out, changed: JSON.stringify(out) !== JSON.stringify(theme), notes };
}

const ZERO_SECTION_MARGIN = { standard: { ...ZERO_PADDING }, compact: { ...ZERO_PADDING } };
const isFillSection = (s, colorId) =>
	s.background?.type === 'COLOR_REFERENCE' && s.background.value === colorId && !s.background.opacity && !s.borderWeight && !s.density?.standard && !s.density?.compact && Object.values(s.margin ?? {}).every((m) => Object.values(m ?? {}).every((v) => !v));

/**
 * The theme's image references (`theme.images`, `iN` to a data file) for `dataFileIds`, adding the missing ones after the
 * highest id (the editor numbers them by count). Pure.
 * @returns {{ theme: Object, ids: Record<string, string>, changed: boolean }}
 */
export function applyThemeImages(theme, dataFileIds = []) {
	const images = [...(theme?.images ?? [])];
	const ids = {};
	let next = Math.max(images.length, ...images.map((i) => Number(/^i(\d+)$/.exec(i.id ?? '')?.[1] ?? 0))) + 1;
	let changed = false;
	for (const fileId of dataFileIds.map(String)) {
		const found = images.find((i) => String(i.dataFileId) === fileId);
		if (found) ids[fileId] = found.id;
		else {
			const id = `i${next++}`;
			images.push({ id, dataFileId: Number(fileId) });
			ids[fileId] = id;
			changed = true;
		}
	}
	return { theme: changed ? { ...theme, images } : theme, ids, changed };
}

/** The section style ids of title fills (`#RRGGBB`, layout `sectionFill`) the theme already has. Pure. */
export function sectionFillIds(theme, fills = []) {
	const ids = {};
	for (const hex of new Set(fills)) {
		const wanted = String(hex).toUpperCase();
		const color = (theme?.colors ?? []).find((c) => c.value?.type === 'RGB_HEX' && String(c.value.value).toUpperCase() === wanted && (c.tags ?? []).some((t) => t === 'THEME' || t === 'CUSTOM'));
		const style = color && (theme.sections ?? []).find((s) => isFillSection(s, color.id));
		if (style) ids[hex] = style.id;
	}
	return ids;
}

const SECTION_STYLES = 2;

/**
 * A theme with a section style per title fill: a copy of the mapped section style with that background and no border,
 * density or margin, refilled into an unmapped section style. A matching style is reused; fills beyond the free styles
 * keep none (noted). Pure.
 * @returns {{ theme: Object, changed: boolean, notes: string[] }}
 */
export function applySectionFills(theme, fills = []) {
	const out = structuredClone(theme);
	const notes = [];
	const sections = out.sections ?? [];
	const base = sections.find((s) => s.id === out.mappings?.section) ?? sections[0];
	const wanted = [...new Set(fills)];
	const kept = new Set(Object.values(sectionFillIds(out, wanted)));
	const missing = wanted.filter((hex) => !sectionFillIds(out, [hex])[hex]);
	if (missing.length && !base) notes.push('the theme has no section style to copy; title rows keep no fill');
	const free = sections.filter((s) => s !== base && !kept.has(s.id));
	const left = [];
	for (const hex of base ? missing : []) {
		const unusedId = `s${[1, 2, 3].find((n) => !sections.some((s) => s.id === `s${n}`))}`;
		const slot = free.shift() ?? (sections.length < SECTION_STYLES ? { id: unusedId } : undefined);
		if (!slot) {
			left.push(hex);
			continue;
		}
		const colorId = themeColorId(out, hex, notes);
		if (!colorId) continue;
		const style = { ...structuredClone(base), id: slot.id, background: colorRef(colorId), borderWeight: 0, borderRadius: 0, density: { standard: 0, compact: 0 }, margin: structuredClone(ZERO_SECTION_MARGIN) };
		const at = sections.indexOf(slot);
		if (at >= 0) sections[at] = style;
		else sections.push(style);
	}
	if (left.length) notes.push(`the theme keeps ${SECTION_STYLES} section styles; title rows filled ${left.join(', ')} keep no fill`);
	return { theme: out, changed: JSON.stringify(out) !== JSON.stringify(theme), notes };
}

/**
 * A theme with the plan's item styles in the card (`ca#`) and table (`t#`) styles no mapping uses: Domo keeps
 * only the first 8 card and 3 table styles, and the built-ins ship that many, so styles are refilled, never added. Each
 * is a copy of the mapped chart, control or table style with the item's background (null: `original`'s), border and
 * padding. With more styles than free slots, card styles that differ only by border color share the most used one's
 * (`merged`); the rest left over keep the default (`skipped`). Pure.
 * @param {Object} theme  After applyThemeOverrides and applyControlSpacing
 * @param {import('../model/types.js').ItemStylePlan[]} [itemStyles]
 * @param {Object} [original]  The built-in theme, for the background a style with none keeps
 * @returns {{ theme: Object, ids: Record<string, string>, skipped: string[], merged: string[], notes: string[] }}
 */
export function applyItemStyles(theme, itemStyles = [], original = theme) {
	const out = structuredClone(theme);
	const ids = {};
	const skipped = [];
	const notes = [];
	if (!itemStyles.length) return { theme: out, ids, skipped, merged: [], notes };
	const used = new Set(Object.values(out.mappings ?? {}));
	const lists = { card: ['cards', 'chart'], control: ['cards', 'control'], table: ['tables', 'table'] };
	const free = Object.fromEntries(['cards', 'tables'].map((list) => [list, (out[list] ?? []).filter((s) => !used.has(s.id))]));
	const { kept, into } = mergeBorders(itemStyles, free.cards.length);
	for (const s of kept) {
		const [list, mapping] = lists[s.kind] ?? [];
		const base = (out[list] ?? []).find((x) => x.id === out.mappings?.[mapping]);
		const slot = base && free[list].shift();
		if (!slot) {
			skipped.push(s.key);
			continue;
		}
		const style = { ...structuredClone(base), id: slot.id };
		const originalBackground = (original[list] ?? []).find((x) => x.id === original.mappings?.[mapping])?.backgroundColor ?? base.backgroundColor;
		const background = s.background ? themeColorId(out, s.background, notes) : undefined;
		style.backgroundColor = background ? colorRef(background) : structuredClone(originalBackground ?? null);
		const border = s.borderWidth ? themeColorId(out, s.borderColor, notes) : undefined;
		style.borderWidth = border ? Math.min(4, Math.max(0, s.borderWidth)) : 0;
		style.borderColor = border ? colorRef(border) : null;
		if (s.padding && 'padding' in base) style.padding = Object.fromEntries(Object.entries(s.padding).map(([side, v]) => [side, Math.min(MAX_PADDING, (base.padding?.[side] ?? 0) + v)]));
		out[list][out[list].indexOf(slot)] = style;
		ids[s.key] = slot.id;
	}
	for (const [key, target] of into) {
		if (ids[target]) ids[key] = ids[target];
		else skipped.push(key);
	}
	const merged = [...into.keys()].filter((k) => ids[k]);
	if (merged.length) notes.push(`${merged.length} item style(s) share a style that differs only in border color: no free card style left`);
	if (skipped.length) notes.push(`${skipped.length} item style(s) kept the default style: no free card or table style left`);
	return { theme: out, ids, skipped, merged, notes };
}

/** Card styles that differ only by border color merge into the most used one, until they fit in `slots`. */
function mergeBorders(itemStyles, slots) {
	const into = new Map();
	const isCard = (s) => s.kind !== 'table';
	let kept = [...itemStyles];
	const shape = (s) => JSON.stringify([s.kind, s.background, s.borderWidth, s.padding]);
	for (const s of [...itemStyles].sort((a, b) => a.items - b.items)) {
		if (kept.filter(isCard).length <= slots) break;
		const target = kept.filter((x) => x !== s && isCard(x) && x.borderColor && shape(x) === shape(s)).sort((a, b) => b.items - a.items)[0];
		if (!isCard(s) || !s.borderColor || !target) continue;
		into.set(s.key, target.key);
		kept = kept.filter((x) => x !== s);
	}
	for (const [key, target] of into) {
		let t = target;
		while (into.has(t)) t = into.get(t);
		into.set(key, t);
	}
	return { kept, into };
}

const PALETTES = '/brandkit/v1/chartColorPalettes/APP';

export function appPaletteBody(appId, { name, json }) {
	return { name: String(name).slice(0, 255), type: 'APP', entityType: 'DATA_APP', entityId: appId, palette: json };
}

export async function createAppPalette(c, appId, palette) {
	return c.post(PALETTES, appPaletteBody(appId, palette));
}

export async function updateAppPalette(c, paletteId, appId, palette) {
	return c.put(`${PALETTES}/${enc(paletteId)}`, { id: paletteId, ...appPaletteBody(appId, palette) });
}

/** The app's APP palettes (deleting the app deletes them). */
export async function listAppPalettes(c, appId) {
	return c.get(`${PALETTES}/entityType/DATA_APP/id/${enc(appId)}`);
}

export async function deleteAppPalette(c, paletteId) {
	return c.del(`${PALETTES}/${enc(paletteId)}`, { responseType: 'text' });
}

/** Drop per-item style overrides after a theme switch (what the editor does before saving a new theme). */
export async function clearStyleOverride(c, appId) {
	return c.put(`${APPS}/${enc(appId)}/views/clearStyleOverride`, undefined, { responseType: 'text' });
}

/** Replace the app's saved themes (`[]` clears them; app delete leaves them behind). */
export async function setSavedThemes(c, appId, themes) {
	return c.put(`${APPS}/${enc(appId)}/themes`, themes, { responseType: 'text' });
}

/**
 * @param {import('./client.js').DomoClient} c
 * @returns {Promise<{ viewId: number, layoutId: number|undefined }>}
 */
export async function createView(c, appId, { title, parentViewId }) {
	if (!title) throw new Error('createView: title is required');
	const res = await c.post(`${APPS}/${enc(appId)}/views`, { type: 'dataappview', title, ...(parentViewId != null ? { parentPageId: parentViewId } : {}) });
	const viewId = res?.view?.pageId;
	if (viewId == null) throw new Error(`createView: response had no view.pageId: ${JSON.stringify(res).slice(0, 500)}`);
	return { viewId, layoutId: res?.layout?.layoutId };
}

/** The endpoint takes the new title as a raw text body (400 without one). */
export async function renameView(c, appId, viewId, title) {
	if (!title) throw new Error('renameView: title is required');
	return c.put(`${APPS}/${enc(appId)}/views/${enc(viewId)}/name`, undefined, { body: title, headers: { 'Content-Type': 'text/plain' }, responseType: 'text' });
}

/** Deletes the view, its child views and its layout, not its cards. The last visible view cannot be deleted. */
export async function deleteView(c, appId, viewId) {
	return c.del(`${APPS}/${enc(appId)}/views/${enc(viewId)}`);
}

export async function setViewVisible(c, appId, viewId, visible) {
	const path = `${APPS}/${enc(appId)}/views/${enc(viewId)}/visible`;
	return visible ? c.put(path, undefined, { responseType: 'text' }) : c.del(path, { responseType: 'text' });
}

/** Navigation items sorted by navOrder (the server does not sort them). */
export async function getNavigation(c, appId) {
	const items = await c.get(`${APPS}/${enc(appId)}/navigation`, { query: { includeHidden: true } });
	return (Array.isArray(items) ? items : []).slice().sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0));
}

/** PUT the full ordered navigation; every view must be listed and VIEW items must be contiguous. */
export async function reorderNavigation(c, appId, items) {
	return c.put(`${APPS}/${enc(appId)}/navigation/reorder`, items);
}

export const DEFAULT_NAV_ICON = 'pages';

/**
 * Navigation icons t2d assigns, with the Phosphor name the editor's icon picker stores next to each.
 * The reorder skips that check, so nothing else may be sent.
 */
export const NAV_ICONS = Object.freeze({
	analytics: 'Analytics',
	building: 'Buildings',
	calendar: 'CalendarBlank',
	'chart-bar-vertical': 'ChartBar',
	'chart-line': 'Line',
	'chart-pie': 'ChartPie',
	'chat-bubbles': 'Chats',
	'checked-list': 'CheckList',
	clock: 'Clock',
	'exclamation-triangle': 'Warning',
	forecast: 'Forecast',
	funnel: 'Funnel',
	gauge: 'Gauge',
	gear: 'Gear',
	globe: 'GlobeHemisphereWest',
	goals: 'Goals',
	handshake: 'Handshake',
	home: 'House',
	lightbulb: 'Lightbulb',
	'list-bulleted': 'ListBullets',
	'map-marker': 'MapPin',
	'money-universal': 'Money',
	pages: 'Pages',
	people: 'Users',
	person: 'User',
	presentation: 'Presentation',
	pulse: 'Activity',
	'summary-number': 'SummaryNumber',
	table: 'Table',
	tag: 'TagSimple',
	trophy: 'Trophy'
});

/** A navigation item's icon set to `name`, keeping its size and color. Pure. */
export function withNavIcon(item, name) {
	if (!Object.hasOwn(NAV_ICONS, name)) throw new Error(`withNavIcon: "${name}" is not a navigation icon t2d uses`);
	return { ...item, icon: { ...(item.icon ?? {}), value: name, phosphor: NAV_ICONS[name], size: item.icon?.size ?? 'DEFAULT' }, iconPosition: item.iconPosition ?? 'LEFT' };
}

/**
 * Navigation with `views` (t2d's, in order) in the slots t2d's VIEW items hold now. Every other item (views t2d did not
 * create, and non-VIEW items) keeps its slot and is sent unchanged; navOrder is renumbered from 1, which keeps theirs.
 * Views not in `nav` are skipped. A view's `icon` replaces the item's icon only while the item shows Domo's default or
 * `ownIcons` (what t2d last wrote there), so an icon picked in the editor stays.
 * @param {Object[]} nav  getNavigation result
 * @param {{ id: number|string, title: string, visible: boolean, icon?: string }[]} views
 * @param {Record<string, string>} [ownIcons]  view id -> icon t2d last wrote
 */
export function buildNavigation(nav, views, ownIcons = {}) {
	const byId = new Map(nav.filter((n) => n.entity === 'VIEW').map((n) => [String(n.entityId), n]));
	const iconed = (item, v) => {
		const current = item.icon?.value;
		const replaceable = current == null || current === DEFAULT_NAV_ICON || current === ownIcons[String(v.id)];
		return v.icon && replaceable && current !== v.icon ? withNavIcon(item, v.icon) : item;
	};
	const ours = views.filter((v) => byId.has(String(v.id))).map((v) => iconed({ ...byId.get(String(v.id)), title: v.title, visible: v.visible }, v));
	const ourIds = new Set(views.map((v) => String(v.id)));
	let next = 0;
	const out = nav.map((item) => (item.entity === 'VIEW' && ourIds.has(String(item.entityId)) ? ours[next++] : item));
	return out.map((item, i) => (item.navOrder === i + 1 ? item : { ...item, navOrder: i + 1 }));
}

export async function setLanding(c, appId, viewId) {
	return c.put(`${APPS}/${enc(appId)}/landing/${enc(viewId)}`, undefined, { responseType: 'text' });
}

export async function putPersistSettings(c, appId, settings) {
	return c.put(`${APPS}/${enc(appId)}/persistSettings`, settings, { responseType: 'text' });
}

/** Permanent: there is no trash or restore. Removes views, layouts and navigation, not the cards on the views. */
export async function deleteApp(c, id) {
	return c.del(`${APPS}/${enc(id)}`);
}

/** Apps whose title contains `text` (admin summary search; the list endpoint only shows apps the user can open). */
export async function searchApps(c, text, { limit = 100 } = {}) {
	const res = await c.post(`${APPS}/adminsummary`, { includeTitleClause: true, titleSearchText: text }, { query: { limit, skip: 0 } });
	return res?.dataAppAdminSummaries ?? (Array.isArray(res) ? res : []);
}

/** Ids of every view of an app read with getApp, child views included. */
export function appViewIds(app) {
	const out = [];
	const walk = (views) => {
		for (const v of views ?? []) {
			if (v?.viewId != null) out.push(v.viewId);
			walk(v?.children);
		}
	};
	walk(app?.views);
	return out;
}

/** Ids of the views viewers see (visible), child views included. */
export function visibleViewIds(app) {
	const out = [];
	const walk = (views) => {
		for (const v of views ?? []) {
			if (v?.viewId != null && v.visible !== false) out.push(v.viewId);
			walk(v?.children);
		}
	};
	walk(app?.views);
	return out;
}

/** Browser link to an app, or to one of its views. */
export function appUrl(instance, appId, viewId) {
	return `https://${instanceHost(instance)}/app-studio/${appId}${viewId != null ? `/pages/${viewId}` : ''}`;
}
