import { boxStyle, elementFont, ruleFormats, styleRules, textRuns } from './style.js';
import { formattedText } from './xml.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').DashboardIR} DashboardIR
 * @typedef {import('../../model/types.js').ZoneIR} ZoneIR
 * @typedef {import('../../model/types.js').ContainerIR} ContainerIR
 * @typedef {import('../../model/types.js').ButtonIR} ButtonIR
 * @typedef {import('../../model/types.js').DeviceLayoutIR} DeviceLayoutIR
 */

/** Zone coordinates are integers in 0..100000 relative to the dashboard. */
const ZONE_UNITS = 100000;
const LEGEND_TYPES = new Set(['color', 'size', 'shape', 'map']);
const KIND_BY_TYPE = {
	text: 'text',
	title: 'title',
	filter: 'filter',
	paramctrl: 'paramctrl',
	bitmap: 'image',
	image: 'image',
	web: 'web',
	empty: 'blank'
};
const DIRECTION = { horz: 'horizontal', vert: 'vertical' };
const WINDOW_ID = /window-id="?(\{[0-9A-Fa-f-]+\})/;
const EXPORT_ACTION = /(?:export|download)[-_:]?([a-z-]*)/i;

function zoneType(zone) {
	return zone.attr('type-v2') || zone.attr('type');
}

function isContainer(zone) {
	const type = zoneType(zone);
	return (type && type.startsWith('layout-')) || zone.all('zone').length > 0;
}

function isFloatingAttr(zone) {
	return zone.attr('is-floating') === 'true' || zone.attr('floating') === 'true';
}

function fraction(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.round(Math.min(1, Math.max(0, n / ZONE_UNITS)) * 1e6) / 1e6;
}

function rectOf(zone) {
	return { x: fraction(zone.attr('x')), y: fraction(zone.attr('y')), w: fraction(zone.attr('w')), h: fraction(zone.attr('h')) };
}

/** @param {XmlNode} state */
function buttonState(state) {
	const out = {};
	const caption = state.childText('caption');
	if (caption) out.caption = caption;
	const image = state.childText('image-path');
	if (image) out.image = image;
	const tooltip = state.childText('tooltip-text');
	if (tooltip) out.tooltip = tooltip;
	const font = elementFont(state.child('button-caption-font-style'));
	if (font) out.font = font;
	const style = boxStyle(state);
	if (style) out.style = style;
	return out;
}

/**
 * A dashboard object button: navigation (Go to Sheet), show/hide toggle or download.
 * @param {XmlNode} zone
 * @returns {ButtonIR|undefined}
 */
function parseButton(zone) {
	const node = zone.child('button');
	if (!node) return undefined;
	const command = node.attr('action') || '';
	const toggle = node.child('toggle-action')?.textContent().trim();
	const states = node.all('button-visual-state').map(buttonState);
	/** @type {ButtonIR} */
	const button = {
		action: 'other',
		style: node.attr('button-type') === 'text' ? 'text' : states.some((s) => s.image) ? 'image' : 'default',
		states
	};
	const active = node.attr('active-visual-state-index');
	if (active !== undefined && active !== '') button.activeState = Number(active);
	if (toggle) {
		button.action = 'toggle';
		const ids = /zone-ids=\[([^\]]*)\]/.exec(toggle)?.[1] ?? '';
		button.toggle = { zoneIds: ids.split(',').map((s) => s.trim()).filter(Boolean) };
	} else if (/goto-sheet/.test(command)) {
		button.action = 'navigate';
		const windowId = WINDOW_ID.exec(command)?.[1];
		button.target = windowId ? { windowId } : {};
	} else if (EXPORT_ACTION.test(command)) {
		button.action = 'download';
		const format = EXPORT_ACTION.exec(command)?.[1];
		if (format) button.exportFormat = format;
	} else if (!command) {
		button.action = 'none';
	}
	if (button.action === 'other' || button.action === 'download') button.command = command;
	return button;
}

/**
 * @param {XmlNode} zone
 * @param {boolean} floating
 * @param {{ name: string, title?: string }} dash
 * @returns {ZoneIR|null}
 */
function leafZone(zone, floating, dash) {
	const type = zoneType(zone);
	const name = zone.attr('name');
	let kind;
	if (!type) kind = name ? 'worksheet' : 'blank';
	else if (LEGEND_TYPES.has(type)) kind = 'legend';
	else if (type.startsWith('layout-')) return null;
	else if (type === 'dashboard-object' && zone.child('button')) kind = 'button';
	else kind = KIND_BY_TYPE[type] || 'other';

	/** @type {ZoneIR} */
	const ir = {
		id: String(zone.attr('id') ?? ''),
		kind: /** @type {ZoneIR['kind']} */ (kind),
		rect: rectOf(zone),
		floating
	};
	if (name && (kind === 'worksheet' || kind === 'filter' || kind === 'legend')) ir.worksheet = name;
	if (zone.attr('param') && (kind === 'filter' || kind === 'paramctrl' || kind === 'legend')) ir.param = zone.attr('param');
	if (zone.attr('mode') && (kind === 'filter' || kind === 'paramctrl')) ir.mode = zone.attr('mode');
	if (zone.attr('values') && kind === 'filter') ir.values = zone.attr('values');
	if (kind === 'paramctrl' && zone.attr('custom-title') === 'true') {
		const title = formattedText(zone);
		if (title) ir.title = title;
	}
	if (kind === 'text' || kind === 'title') {
		const text = formattedText(zone);
		if (text) ir.text = text;
		else if (kind === 'title') ir.text = dash.title ?? dash.name;
		const runs = textRuns(zone);
		if (runs) ir.runs = runs;
	}
	if (kind === 'image') {
		if (zone.attr('param')) ir.url = zone.attr('param');
		ir.fit = zone.attr('is-scaled') === '1' ? 'fit' : zone.attr('is-centered') === '1' ? 'center' : 'none';
	}
	if (kind === 'web') {
		const url = zone.attr('url') || zone.attr('param') || zone.attr('web-url');
		if (url) ir.url = url;
	}
	if (kind === 'button') ir.button = parseButton(zone);
	if (kind === 'other' && type) ir.text = type;
	if (zone.attr('show-title') === 'false') ir.showTitle = false;
	if (zone.attr('alt-text')) ir.altText = zone.attr('alt-text');
	return ir;
}

function containerOf(zone, floating) {
	const type = zoneType(zone) || '';
	/** @type {ContainerIR} */
	const out = {
		id: String(zone.attr('id') ?? ''),
		layout: type === 'layout-flow' ? 'flow' : type === 'layout-basic' ? 'basic' : 'other',
		rect: rectOf(zone),
		floating,
		children: []
	};
	const direction = DIRECTION[zone.attr('param')];
	if (direction) out.direction = direction;
	if (zone.attr('layout-strategy-id') === 'distribute-evenly') out.distributeEvenly = true;
	if (zone.attr('friendly-name')) out.name = zone.attr('friendly-name');
	return out;
}

/** Fields every node (container or leaf) carries: its parent, hidden state and zone style. */
function annotate(target, zone, parent, hidden) {
	if (parent) target.parent = parent;
	if (hidden) target.hidden = true;
	const style = boxStyle(zone.child('zone-style'));
	if (style) target.style = style;
	const fixed = Number(zone.attr('fixed-size'));
	if (zone.attr('is-fixed') === 'true' && Number.isFinite(fixed)) target.fixedSize = fixed;
}

function collect(zone, ctx, floating, parent, hidden) {
	const isFloating = floating || isFloatingAttr(zone);
	const isHidden = hidden || zone.attr('hidden-by-user') === 'true';
	if (isContainer(zone)) {
		const container = containerOf(zone, isFloating);
		annotate(container, zone, parent, isHidden);
		ctx.containers.push(container);
		for (const child of zone.all('zone')) {
			const id = collect(child, ctx, isFloating, container.id, isHidden);
			if (id !== undefined) container.children.push(id);
		}
		return container.id;
	}
	const leaf = leafZone(zone, isFloating, ctx.dash);
	if (!leaf) return undefined;
	annotate(leaf, zone, parent, isHidden);
	(isFloating ? ctx.floating : ctx.tiled).push(leaf);
	return leaf.id;
}

export function parseSize(size, { keepMode = false } = {}) {
	if (!size) return { mode: 'automatic' };
	const num = (name) => (size.attr(name) !== undefined && size.attr(name) !== '' ? Number(size.attr(name)) : undefined);
	const minW = num('minwidth');
	const maxW = num('maxwidth');
	const minH = num('minheight');
	const maxH = num('maxheight');
	const width = maxW ?? num('width') ?? minW;
	const height = maxH ?? num('height') ?? minH;
	const declared = size.attr('sizing-mode');
	let mode;
	if (declared === 'automatic') mode = 'automatic';
	else if (declared === 'fixed') mode = 'fixed';
	else if (declared === 'range') mode = 'range';
	else if (keepMode && declared) mode = declared;
	else if (width === undefined && height === undefined) mode = 'automatic';
	else if ((minW === undefined || minW === maxW) && (minH === undefined || minH === maxH)) mode = 'fixed';
	else mode = 'range';
	const out = { mode };
	if (mode !== 'automatic' || width !== undefined) {
		if (width !== undefined) out.width = width;
		if (height !== undefined) out.height = height;
	}
	return out;
}

function overlaps(a, b) {
	const box = (z) => ['x', 'y', 'w', 'h'].map((k) => Number(z.attr(k)) || 0);
	const [ax, ay, aw, ah] = box(a);
	const [bx, by, bw, bh] = box(b);
	return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** Root zones with no tiled root container that never overlap read as a tiled layout drawn with floating items. */
function rootsTile(roots) {
	if (!roots.length || isContainer(roots[0]) || roots.some(isFloatingAttr)) return false;
	return roots.every((a, i) => roots.slice(i + 1).every((b) => !overlaps(a, b)));
}

/** Leaf zone ids of a device layout in document order. */
function leafIds(zones) {
	return (zones?.descendants('zone') ?? []).filter((z) => !isContainer(z)).map((z) => String(z.attr('id') ?? ''));
}

/** @param {XmlNode} node @returns {DeviceLayoutIR[]} */
function deviceLayouts(node) {
	return (node.child('devicelayouts')?.all('devicelayout') ?? []).map((d) => {
		const auto = d.attr('auto-generated') === 'true';
		/** @type {DeviceLayoutIR} */
		const out = { name: d.attr('name') || '', auto, size: parseSize(d.child('size'), { keepMode: true }) };
		if (!auto) out.zoneIds = leafIds(d.child('zones'));
		return out;
	});
}

/**
 * Parse a <dashboard>. The first root container is the tiled layout; every
 * other root zone, and any zone flagged is-floating, is floating. A dashboard
 * without a root container whose root zones do not overlap is read as tiled.
 * @param {XmlNode} node
 * @returns {DashboardIR}
 */
export function parseDashboard(node) {
	const name = node.attr('name') || 'Dashboard';
	const titleNode = node.path('layout-options/title');
	const title = titleNode ? formattedText(titleNode, { 'Sheet Name': name }) : undefined;
	const ctx = { dash: { name, title }, tiled: [], floating: [], containers: [] };
	const roots = node.child('zones')?.all('zone') || [];
	const tiledRoots = rootsTile(roots);
	const rootIds = [];
	roots.forEach((root, index) => {
		const rootFloating = !tiledRoots && (isFloatingAttr(root) || index > 0 || !isContainer(root));
		const id = collect(root, ctx, rootFloating, undefined, false);
		if (id !== undefined) rootIds.push(id);
	});
	/** @type {DashboardIR} */
	const dash = { name, size: parseSize(node.child('size')), zones: ctx.tiled, floating: ctx.floating };
	if (ctx.containers.length) {
		dash.containers = ctx.containers;
		dash.roots = rootIds;
	}
	if (title !== undefined) {
		dash.title = { text: title };
		const runs = textRuns(titleNode);
		if (runs) dash.title.runs = runs;
	}
	const rules = styleRules(node.child('style'));
	if (rules.length) {
		dash.styleRules = rules;
		const background = ruleFormats(rules, 'table')['background-color'];
		if (background) dash.background = background;
	}
	const devices = deviceLayouts(node);
	if (devices.length) dash.deviceLayouts = devices;
	return dash;
}

/**
 * Leaf zones inside a container, at any depth, in document order.
 * @param {DashboardIR} dash
 * @param {string} containerId
 * @returns {ZoneIR[]}
 */
export function containerZones(dash, containerId) {
	const containers = new Map((dash.containers ?? []).map((c) => [c.id, c]));
	const leaves = new Map([...(dash.zones ?? []), ...(dash.floating ?? [])].map((z) => [z.id, z]));
	const out = [];
	const walk = (id) => {
		const container = containers.get(id);
		if (!container) {
			if (leaves.has(id)) out.push(leaves.get(id));
			return;
		}
		for (const child of container.children) walk(child);
	};
	walk(containerId);
	return out;
}
