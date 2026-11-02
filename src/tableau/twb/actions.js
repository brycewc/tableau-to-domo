import { parsePillId } from './shelf.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').ActionIR} ActionIR
 */

const TRIGGER = { 'on-select': 'select', 'on-hover': 'hover', 'on-menu': 'menu' };
const COMMAND_TYPE = { 'tsc:tsl-filter': 'filter', 'tsc:brush': 'highlight', 'tsc:url': 'url', 'tsc:goto-sheet': 'navigate' };
const URL_TOKEN = /<([^<>]+)>/g;
const TYPE_SUFFIX = /~[a-z]+\d*$/i;

function params(node) {
	const out = {};
	for (const p of node?.descendants('param') ?? []) if (p.attr('name')) out[p.attr('name')] = p.attr('value') ?? '';
	return out;
}

function list(value) {
	return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function source(node) {
	const src = node.child('source');
	const out = { type: src?.attr('type') || 'sheet' };
	if (src?.attr('dashboard')) out.dashboard = src.attr('dashboard');
	if (src?.attr('worksheet')) out.worksheet = src.attr('worksheet');
	if (src?.attr('datasource')) out.datasource = src.attr('datasource');
	const exclude = (src?.all('exclude-sheet') ?? []).map((e) => e.attr('name')).filter(Boolean);
	if (exclude.length) out.excludeSheets = exclude;
	return out;
}

function safeDecode(text) {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * Field pairs of a `tsl:<target>?<[ds].[target field]~s0>=<source field~na>&...` link (a filter action on selected fields).
 * @param {string} expression
 */
export function parseTslLink(expression) {
	const m = /^tsl:([^?]*)\??(.*)$/s.exec(expression);
	if (!m) return undefined;
	const fields = m[2]
		.split('&')
		.filter(Boolean)
		.map((pair) => {
			const eq = pair.indexOf('=');
			const target = safeDecode(eq < 0 ? pair : pair.slice(0, eq)).replace(TYPE_SUFFIX, '');
			const raw = eq < 0 ? '' : pair.slice(eq + 1);
			const sourceField = raw.replace(/^<|>$/g, '').replace(TYPE_SUFFIX, '');
			return { source: sourceField, target };
		})
		.filter((f) => f.target && f.source);
	return { target: safeDecode(m[1]), fields };
}

/** Field references in a URL template, as written between angle brackets. */
export function urlTokens(template) {
	return [...new Set([...String(template ?? '').matchAll(URL_TOKEN)].map((t) => t[1]))];
}

function urlOf(template, link) {
	const out = { template, tokens: urlTokens(template), scheme: /^([a-z][a-z0-9+.-]*):/i.exec(template)?.[1]?.toLowerCase() ?? '' };
	if (!link) return out;
	if (link.attr('url-escape') === 'true') out.encode = true;
	if (link.attr('multi-select') === 'true') {
		out.multiSelect = true;
		out.delimiter = link.attr('delimiter') ?? ',';
		if (link.attr('escape') !== undefined) out.escape = link.attr('escape');
	}
	if (link.attr('include-null') === 'true') out.includeNull = true;
	const target = link.childText('url-action-type');
	if (target) out.target = target;
	return out;
}

/** 'b:false' -> false, 's:x' -> 'x', 'i:3' / 'r:1.5' -> number. */
function typedValue(raw) {
	const m = /^([a-z]):(.*)$/s.exec(raw ?? '');
	if (!m) return raw;
	if (m[1] === 'b') return m[2] === 'true';
	if (m[1] === 'i' || m[1] === 'r') return Number.isFinite(Number(m[2])) ? Number(m[2]) : m[2];
	return m[2];
}

function filterClear(activation, p) {
	if (activation?.attr('auto-clear') !== 'true') return 'keep';
	return p['on-empty'] === 'none' ? 'exclude-all' : 'show-all';
}

function targetOf(p, linkTarget) {
	const name = p.target ?? linkTarget;
	if (name === undefined) return undefined;
	const out = { name };
	const exclude = list(p.exclude);
	if (exclude.length) out.excludeSheets = exclude;
	return out;
}

/**
 * One workbook action (<action>, <nav-action>, <edit-parameter-action>, <edit-group-action>).
 * @param {XmlNode} node
 * @returns {ActionIR|undefined}
 */
export function parseAction(node) {
	if (!['action', 'nav-action', 'edit-parameter-action', 'edit-group-action'].includes(node.name)) return undefined;
	const activation = node.child('activation');
	const p = params(node);
	const command = node.child('command')?.attr('command');
	const link = node.child('link');
	/** @type {ActionIR} */
	const action = {
		id: node.attr('name') || '',
		name: node.attr('caption') || node.attr('name') || '',
		type: 'other',
		trigger: /** @type {ActionIR['trigger']} */ (TRIGGER[activation?.attr('type')] ?? 'menu'),
		source: source(node)
	};
	if (link?.attr('caption')) action.menuCaption = link.attr('caption');

	if (node.name === 'nav-action') {
		action.type = 'navigate';
		action.target = { name: p.sheet ?? '' };
	} else if (node.name === 'edit-parameter-action') {
		action.type = 'parameter';
		const clear = node.child('clear-option');
		action.parameter = {
			target: p['target-parameter'] ?? '',
			sourceField: p['source-field'] ? parsePillId(p['source-field']).fieldId : '',
			sourcePill: p['source-field'] ?? ''
		};
		const agg = node.child('agg-type')?.attr('type');
		if (agg) action.parameter.aggregation = agg;
		if (clear?.attr('type')) {
			action.parameter.clear = { type: clear.attr('type') };
			if (clear.attr('value') !== undefined) action.parameter.clear.value = typedValue(clear.attr('value'));
		}
	} else if (node.name === 'edit-group-action') {
		action.type = 'set';
		action.set = { target: p['target-group'] ?? '', mode: node.child('add-or-remove-marks')?.attr('value') || 'assign' };
		if (p['selection-clear-set-option']) action.set.clear = p['selection-clear-set-option'];
	} else if (command && COMMAND_TYPE[command]) {
		action.type = /** @type {ActionIR['type']} */ (COMMAND_TYPE[command]);
	} else if (link && !command) {
		action.type = 'url';
	} else if (command) {
		action.command = command;
	}

	if (action.type === 'filter' || action.type === 'highlight') {
		const tsl = link ? parseTslLink(link.attr('expression') ?? '') : undefined;
		const target = targetOf(p, tsl?.target);
		if (target) action.target = target;
		if (p['special-fields'] === 'all') action.allFields = true;
		if (tsl?.fields.length) action.fields = tsl.fields;
		const captions = list(p['field-captions']);
		if (captions.length) action.fieldCaptions = captions;
		action.clear = filterClear(activation, p);
	}
	if (action.type === 'url') action.url = urlOf(link?.attr('expression') ?? p.url ?? '', link);
	const extra = Object.keys(activation?.attrs ?? {}).filter((k) => k !== 'type' && k !== 'auto-clear');
	if (extra.length) action.activation = Object.fromEntries(extra.map((k) => [k, activation.attr(k)]));
	return action;
}

/**
 * Every action in <actions>, with source sheets resolved against the dashboards (all sheets on the source dashboard
 * minus excluded ones when no worksheet is named) and target kinds against the workbook's sheets.
 * @param {XmlNode} root
 * @param {{ dashboards: import('../../model/types.js').DashboardIR[], worksheets: string[], stories?: string[] }} ctx
 * @returns {ActionIR[]}
 */
export function parseActions(root, ctx) {
	const dashboards = new Map(ctx.dashboards.map((d) => [d.name, d]));
	const worksheets = new Set(ctx.worksheets);
	const stories = new Set(ctx.stories ?? []);
	const kindOf = (name) => (dashboards.has(name) ? 'dashboard' : worksheets.has(name) ? 'worksheet' : stories.has(name) ? 'story' : undefined);
	const sheetsOn = (dash) => [...new Set([...(dash.zones ?? []), ...(dash.floating ?? [])].filter((z) => z.kind === 'worksheet' && z.worksheet).map((z) => z.worksheet))];
	const out = [];
	for (const node of root.child('actions')?.all() ?? []) {
		const action = parseAction(node);
		if (!action) continue;
		const src = action.source;
		if (src.type === 'sheet' && !src.worksheet && src.dashboard && dashboards.has(src.dashboard)) {
			const exclude = new Set(src.excludeSheets ?? []);
			src.worksheets = sheetsOn(dashboards.get(src.dashboard)).filter((s) => !exclude.has(s));
		} else if (src.worksheet) {
			src.worksheets = [src.worksheet];
		}
		if (action.target?.name) {
			const kind = kindOf(action.target.name);
			if (kind) action.target.kind = kind;
			if (kind === 'dashboard') {
				const exclude = new Set(action.target.excludeSheets ?? []);
				action.target.worksheets = sheetsOn(dashboards.get(action.target.name)).filter((s) => !exclude.has(s));
			}
		}
		out.push(action);
	}
	return out;
}
