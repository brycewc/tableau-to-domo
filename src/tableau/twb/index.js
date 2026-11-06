import path from 'node:path';
import { IR_VERSION } from '../../model/types.js';
import { parseActions } from './actions.js';
import { colorEncodings } from './colors.js';
import { parseDashboard } from './dashboards.js';
import { parseDatasourceNode } from './datasources.js';
import { parseParameters } from './fields.js';
import { parseFilter } from './filters.js';
import { parsePillId, splitBracketParts } from './shelf.js';
import { parseStory } from './stories.js';
import { workbookStyle } from './style.js';
import { parseWorksheet } from './worksheets.js';
import { parseXml } from './xml.js';

export { parsePillId, parseShelf, flattenShelf } from './shelf.js';
export { containerZones } from './dashboards.js';
export { parseTslLink, urlTokens } from './actions.js';
export { SENSITIVE_NAME } from './datasources.js';

/**
 * @typedef {import('../../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../../model/types.js').WorkbookInfo} WorkbookInfo
 * @typedef {import('../../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../../model/types.js').FilterIR} FilterIR
 * @typedef {import('../../model/types.js').Issue} Issue
 * @typedef {import('./xml.js').XmlNode} XmlNode
 */

const ACTION_COMMANDS = {
	'tsc:tsl-filter': ['info', 'twb.filter-action', 'filter action (Domo cards on one dataset cross-filter by default)'],
	'tsc:brush': ['info', 'twb.highlight-action', 'highlight action (no Domo equivalent)'],
	'tsc:url': ['info', 'twb.url-action', 'URL action (map to a card drill or link)'],
	'tsc:goto-sheet': ['info', 'twb.navigation-action', 'go-to-sheet action'],
	link: ['info', 'twb.url-action', 'URL action (map to a card drill or link)']
};

function isParametersDatasource(node) {
	if (node.attr('name') === 'Parameters') return true;
	const cols = node.all('column');
	return node.attr('hasconnection') === 'false' && cols.length > 0 && cols.every((c) => c.attr('param-domain-type'));
}

const LEGEND_CARDS = new Set(['color', 'size', 'shape', 'map']);

function windowsInfo(root) {
	const windows = root.child('windows');
	const hidden = new Set();
	const listed = new Set();
	const order = new Map();
	const byUuid = new Map();
	const filterCards = new Map();
	const windowCards = new Map();
	for (const w of windows?.all('window') || []) {
		const name = w.attr('name');
		if (!name) continue;
		listed.add(name);
		if (w.attr('class') === 'worksheet') {
			const cards = (w.child('cards')?.all('edge') || []).flatMap((e) => e.all('strip')).flatMap((s) => s.all('card'));
			const shown = cards.filter((c) => c.attr('type') === 'filter' && c.attr('param')).map((c) => ({ pillId: c.attr('param'), ...(c.attr('mode') ? { mode: c.attr('mode') } : {}) }));
			if (shown.length) filterCards.set(name, shown);
			const side = cards.map((c) => ({ kind: c.attr('type') === 'filter' ? 'filter' : c.attr('type') === 'parameter' ? 'paramctrl' : LEGEND_CARDS.has(c.attr('type')) ? 'legend' : undefined, c })).filter((x) => x.kind && x.c.attr('param'));
			if (side.length) windowCards.set(name, side.map(({ kind, c }) => ({ kind, param: c.attr('param'), ...(c.attr('mode') ? { mode: c.attr('mode') } : {}), ...(c.attr('values') ? { values: c.attr('values') } : {}) })));
		}
		const uuid = w.child('simple-id')?.attr('uuid');
		if (uuid) byUuid.set(uuid.toUpperCase(), { name, kind: w.attr('class') });
		if (!order.has(name)) order.set(name, order.size);
		if (w.attr('hidden') === 'true') hidden.add(name);
	}
	return { present: Boolean(windows), hidden, listed, order, byUuid, filterCards, windowCards };
}

const SHEET_KIND = { dashboard: 'dashboard', worksheet: 'worksheet', storyboard: 'story' };

/** Name the sheet or dashboard each navigation button opens (window uuid from <windows>, else the sheet's own simple-id). */
function resolveButtonTargets(dashboards, sheetIds, windows) {
	for (const zone of dashboards.flatMap((d) => [...d.zones, ...d.floating])) {
		const target = zone.button?.target;
		if (!target?.windowId) continue;
		const key = target.windowId.toUpperCase();
		const hit = windows.byUuid.get(key) ?? sheetIds.get(key);
		if (!hit) continue;
		target.name = hit.name;
		if (SHEET_KIND[hit.kind]) target.kind = SHEET_KIND[hit.kind];
	}
}

/** Shown state of each show/hide button: its zones are shown unless they are hidden on the dashboard. */
function resolveToggles(dashboards) {
	for (const dash of dashboards) {
		const nodes = new Map([...(dash.containers ?? []), ...dash.zones, ...dash.floating].map((n) => [n.id, n]));
		for (const zone of [...dash.zones, ...dash.floating]) {
			const toggle = zone.button?.toggle;
			if (!toggle) continue;
			const targets = toggle.zoneIds.map((id) => nodes.get(id)).filter(Boolean);
			if (targets.length) toggle.shown = !targets.every((t) => t.hidden);
		}
	}
}

/** Filter actions with the dashboard they start on and their target sheet or dashboard. */
function filterActions(root) {
	return (root.child('actions')?.all('action') || [])
		.filter((a) => a.child('command')?.attr('command') === 'tsc:tsl-filter')
		.map((a) => ({
			name: a.attr('caption') || a.attr('name') || '',
			sourceDashboard: a.child('source')?.attr('dashboard') || '',
			target: a.child('command').all('param').find((p) => p.attr('name') === 'target')?.attr('value') || ''
		}));
}

function sharedViewFilters(root, issues) {
	const out = new Map();
	for (const sv of root.child('shared-views')?.all('shared-view') || []) {
		const dsId = sv.attr('name');
		if (!dsId) continue;
		const instances = new Map();
		for (const deps of sv.all('datasource-dependencies')) {
			for (const ci of deps.all('column-instance')) instances.set(`[${deps.attr('datasource')}].${ci.attr('name')}`, ci);
		}
		const resolvePill = (id) => {
			const ci = instances.get(id);
			return parsePillId(id, ci ? { column: ci.attr('column'), derivation: ci.attr('derivation'), type: ci.attr('type') } : {});
		};
		const filters = sv.all('filter').flatMap((f) => parseFilter(f, { resolvePill, defaultDatasourceId: dsId, issues, scope: dsId })).map((f) => ({ ...f, shared: dsId }));
		if (!filters.length) continue;
		out.set(dsId, filters);
		issues.push({
			severity: 'info',
			code: 'twb.shared-filter',
			message: `${filters.length} filter(s) apply to every worksheet using datasource ${dsId}; they were copied onto those worksheets`,
			object: { type: 'datasource', name: dsId, id: dsId }
		});
	}
	return out;
}

/** Blend relationships between datasources (Data > Edit Blend Relationships). An empty mapping means automatic (by name). */
function blendRelationships(root) {
	return (root.child('datasource-relationships')?.all('datasource-relationship') || [])
		.filter((r) => r.attr('source') && r.attr('target'))
		.map((r) => {
			const maps = r.child('column-mapping')?.all('map') ?? r.all('map');
			const mappings = maps
				.filter((m) => m.attr('key') && m.attr('value'))
				.map((m) => ({ source: parsePillId(m.attr('key')).fieldId, target: parsePillId(m.attr('value')).fieldId }));
			return { source: r.attr('source'), target: r.attr('target'), mappings };
		});
}

function actionIssues(root, issues) {
	for (const action of root.child('actions')?.all() || []) {
		const name = action.attr('caption') || action.attr('name') || action.name;
		const object = { type: 'action', name, id: action.attr('name') };
		if (action.name === 'edit-group-action') {
			issues.push({ severity: 'warning', code: 'twb.set-action', message: `Set action "${name}" has no Domo equivalent and is not migrated`, object });
		} else if (action.name === 'edit-parameter-action') {
			issues.push({ severity: 'warning', code: 'twb.parameter-action', message: `Parameter action "${name}" has no Domo equivalent and is not migrated`, object });
		} else if (action.name === 'nav-action') {
			issues.push({ severity: 'info', code: 'twb.navigation-action', message: `Workbook go-to-sheet action "${name}" is not migrated automatically`, object });
		} else if (action.name === 'action') {
			const command = action.child('command')?.attr('command') || (action.child('link') ? 'link' : '');
			const [severity, code, label] = ACTION_COMMANDS[command] || ['info', 'twb.action', `action (${command || 'unknown'})`];
			issues.push({ severity, code, message: `Workbook ${label} "${name}" is not migrated automatically`, object });
		}
	}
}

/**
 * Normalize a Tableau workbook (.twb XML) into the WorkbookIR.
 *
 * @param {string} xml
 * @param {{ sourceFile?: string, info?: Partial<WorkbookInfo> }} [opts]
 * @returns {WorkbookIR}
 */
export function buildWorkbookIR(xml, { sourceFile = '', info = {} } = {}) {
	const root = parseXml(xml);
	if (root.name !== 'workbook') throw new Error(`Expected a Tableau workbook (<workbook>), found <${root.name}>`);
	/** @type {Issue[]} */
	const issues = [];

	const datasources = [];
	const parameters = [];
	const byId = new Map();
	const dsNodes = root.child('datasources')?.all('datasource') || [];
	for (const dsNode of dsNodes) {
		if (isParametersDatasource(dsNode)) {
			parameters.push(...parseParameters(dsNode));
			continue;
		}
		const { datasource } = parseDatasourceNode(dsNode, { issues });
		datasources.push(datasource);
		byId.set(datasource.id, datasource);
	}
	// A published datasource's copy lists the parameters its calculations use, which the workbook may not.
	const knownParameters = new Set(parameters.map((p) => p.id));
	for (const deps of dsNodes.flatMap((n) => n.all('datasource-dependencies')).filter((d) => d.attr('datasource') === 'Parameters')) {
		for (const param of parseParameters(deps)) {
			if (knownParameters.has(param.id)) continue;
			knownParameters.add(param.id);
			parameters.push(param);
		}
	}

	const colorEncodingsByDatasource = new Map(dsNodes.filter((n) => n.attr('name')).map((n) => [n.attr('name'), colorEncodings(n.child('style'))]));
	const sharedFilters = sharedViewFilters(root, issues);
	const windows = windowsInfo(root);
	const dashboardNodes = root.child('dashboards')?.all('dashboard') || [];
	const storyNodes = dashboardNodes.filter((d) => d.attr('type') === 'storyboard');
	const dashboards = dashboardNodes
		.filter((d) => d.attr('type') !== 'storyboard')
		.map((d) => {
			const dash = parseDashboard(d);
			if (windows.order.has(dash.name)) dash.tabIndex = windows.order.get(dash.name);
			if (windows.hidden.has(dash.name)) dash.hidden = true;
			return dash;
		});
	for (const story of storyNodes) {
		issues.push({
			severity: 'warning',
			code: 'twb.story',
			message: `Story "${story.attr('name')}" is not migrated; its dashboards and sheets are migrated individually`,
			object: { type: 'story', name: story.attr('name') || '' }
		});
	}

	const onDashboards = new Set(dashboards.flatMap((d) => [...d.zones, ...d.floating]).filter((z) => z.kind === 'worksheet').map((z) => z.worksheet));
	const hidden = new Set(windows.hidden);
	const worksheetNodes = root.child('worksheets')?.all('worksheet') || [];
	if (windows.present) {
		for (const ws of worksheetNodes) {
			const name = ws.attr('name');
			if (name && !windows.listed.has(name) && onDashboards.has(name)) hidden.add(name);
		}
	}

	const worksheets = worksheetNodes.map((ws) => parseWorksheet(ws, { datasources: byId, hidden, issues, sharedFilters, colorEncodings: colorEncodingsByDatasource }));

	for (const ws of worksheets) if (windows.filterCards.has(ws.name)) ws.quickFilters = windows.filterCards.get(ws.name);
	for (const ws of worksheets) if (windows.windowCards.has(ws.name)) ws.windowCards = windows.windowCards.get(ws.name);

	const sheetsByName = new Map(worksheets.map((w) => [w.name, w]));
	for (const zone of dashboards.flatMap((d) => [...d.zones, ...d.floating])) {
		if (zone.kind !== 'filter' || !zone.param) continue;
		const sheets = zone.worksheet ? [sheetsByName.get(zone.worksheet)].filter(Boolean) : worksheets;
		for (const sheet of sheets) for (const f of sheet.filters) if (f.pillId === zone.param) f.shownOnDashboard = true;
	}

	actionIssues(root, issues);

	const sheetIds = new Map();
	for (const n of [...dashboardNodes, ...worksheetNodes]) {
		const uuid = n.child('simple-id')?.attr('uuid');
		if (uuid) sheetIds.set(uuid.toUpperCase(), { name: n.attr('name'), kind: n.name === 'worksheet' ? 'worksheet' : n.attr('type') === 'storyboard' ? 'storyboard' : 'dashboard' });
	}
	resolveButtonTargets(dashboards, sheetIds, windows);
	resolveToggles(dashboards);
	const dashboardNames = new Set(dashboards.map((d) => d.name));
	const stories = storyNodes.map((n) => {
		const story = parseStory(n, { issues });
		if (windows.order.has(story.name)) story.tabIndex = windows.order.get(story.name);
		if (windows.hidden.has(story.name)) story.hidden = true;
		for (const point of story.points) {
			if (dashboardNames.has(point.sheet)) point.sheetKind = 'dashboard';
			else if (sheetsByName.has(point.sheet)) point.sheetKind = 'worksheet';
		}
		return story;
	});
	const allActions = parseActions(root, { dashboards, worksheets: worksheets.map((w) => w.name), stories: stories.map((s) => s.name) });

	/** @type {WorkbookInfo} */
	const workbook = {
		name: info.name || (sourceFile ? path.basename(sourceFile).replace(/\.(twbx?|tdsx?)$/i, '') : 'Workbook'),
		...info,
		sourceFile: info.sourceFile || sourceFile
	};
	const version = root.attr('source-build') || root.attr('version');
	if (version && !workbook.tableauVersion) workbook.tableauVersion = version;

	const ir = { irVersion: IR_VERSION, workbook, datasources, parameters, worksheets, dashboards, issues };
	const relationships = blendRelationships(root);
	if (relationships.length) ir.blendRelationships = relationships;
	const actions = filterActions(root);
	if (actions.length) ir.filterActions = actions;
	if (allActions.length) ir.actions = allActions;
	if (stories.length) ir.stories = stories;
	const style = workbookStyle(root);
	if (style) ir.style = style;
	return ir;
}

/**
 * Normalize a standalone datasource (.tds XML). `parameters` lists the parameters it carries for its calculations.
 * @param {string} xml
 * @returns {DatasourceIR & { parameters?: import('../../model/types.js').ParameterIR[] }}
 */
export function buildDatasourceIR(xml) {
	const root = parseXml(xml);
	if (root.name !== 'datasource') throw new Error(`Expected a Tableau datasource (<datasource>), found <${root.name}>`);
	const { datasource } = parseDatasourceNode(root, { issues: [] });
	if (!root.attr('name') && root.attr('formatted-name')) datasource.id = root.attr('formatted-name');
	const parameters = root.all('datasource-dependencies').filter((d) => d.attr('datasource') === 'Parameters').flatMap((d) => parseParameters(d));
	if (parameters.length) datasource.parameters = parameters;
	return datasource;
}

/** Datasource part of a pill id ('' when unqualified). */
export function pillDatasourceId(id) {
	const parts = splitBracketParts(id);
	return parts && parts.length > 1 ? parts[0] : '';
}
