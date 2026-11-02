import { collectRefs } from '../util/refs.js';

export const SELECT_KINDS = ['datasets', 'dataflows', 'variables', 'beastmodes', 'app', 'pages', 'cards', 'layouts', 'navigation'];

const KIND_ALIASES = {
	app: 'app',
	apps: 'app',
	navigation: 'navigation',
	nav: 'navigation',
	dataset: 'datasets',
	datasets: 'datasets',
	view: 'datasets',
	views: 'datasets',
	dataflow: 'dataflows',
	dataflows: 'dataflows',
	variable: 'variables',
	variables: 'variables',
	beastmode: 'beastmodes',
	beastmodes: 'beastmodes',
	'beast-modes': 'beastmodes',
	page: 'pages',
	pages: 'pages',
	card: 'cards',
	cards: 'cards',
	layout: 'layouts',
	layouts: 'layouts'
};

/** Plan object kind (state ref prefix) to its selection kind. */
export const KIND_GROUP = {
	dataset: 'datasets',
	dataflow: 'dataflows',
	variable: 'variables',
	beastmode: 'beastmodes',
	app: 'app',
	page: 'pages',
	card: 'cards',
	layout: 'layouts',
	filterview: 'layouts',
	navigation: 'navigation'
};

/**
 * @typedef {Object} Selection
 * @property {string[]} [dashboards]     Dashboard names or `*` globs (case-insensitive)
 * @property {string[]} [worksheets]
 * @property {string[]} [datasources]    Datasource captions or ids
 * @property {('datasets'|'dataflows'|'beastmodes'|'variables'|'app'|'cards'|'pages'|'layouts'|'navigation')[]} [kinds]  Push/unpush only these kinds
 * @property {string[]} [keys]           Push/unpush only these plan keys (or 'kind:key'), globs allowed
 * @property {number} [sampleRows]       Extract or upload only the first N rows per table
 * @property {boolean} [schemaOnly]      Push datasets with their schema and no rows
 * @property {boolean} [allBeastModes]   Keep every beast mode of a kept dataset, not only referenced ones
 */

/** A selection name that matched nothing (a usage error for the CLI). */
export class SelectionError extends Error {
	/**
	 * @param {string} message
	 * @param {{ what?: string, unknown?: string[], valid?: string[] }} [info]
	 */
	constructor(message, { what, unknown = [], valid = [] } = {}) {
		super(message);
		this.name = 'SelectionError';
		this.what = what;
		this.unknown = unknown;
		this.valid = valid;
	}
}

function list(value) {
	if (value === undefined || value === null || value === '') return undefined;
	const items = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
	return items.length ? items : undefined;
}

function splitList(value) {
	const items = list(value)?.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
	return items?.length ? items : undefined;
}

/**
 * Parse kinds (array or comma list, singular or plural) into selection kinds.
 * @param {string|string[]|undefined} value
 * @returns {string[]|undefined}
 */
export function parseKinds(value) {
	const items = splitList(value);
	if (!items) return undefined;
	const out = [];
	for (const item of items) {
		const kind = KIND_ALIASES[item.toLowerCase()];
		if (!kind) throw new SelectionError(`Unknown kind "${item}" (use ${SELECT_KINDS.join(', ')})`, { what: 'kinds', unknown: [item], valid: SELECT_KINDS });
		if (!out.includes(kind)) out.push(kind);
	}
	return out;
}

/**
 * Clean a selection: drop empty parts, parse kinds and keys, validate sampleRows.
 * @param {Selection|undefined|null} selection
 * @returns {Selection}
 */
export function normalizeSelection(selection) {
	const s = selection ?? {};
	const out = {};
	for (const field of ['dashboards', 'worksheets', 'datasources']) {
		const items = list(s[field]);
		if (items) out[field] = items;
	}
	const kinds = parseKinds(s.kinds);
	if (kinds) out.kinds = kinds;
	const keys = splitList(s.keys);
	if (keys) out.keys = keys;
	if (s.sampleRows !== undefined && s.sampleRows !== null && s.sampleRows !== '') {
		const n = Number(s.sampleRows);
		if (!Number.isSafeInteger(n) || n <= 0) throw new SelectionError(`sampleRows must be a positive integer, got "${s.sampleRows}"`, { what: 'sampleRows' });
		out.sampleRows = n;
	}
	if (s.schemaOnly) out.schemaOnly = true;
	if (s.allBeastModes) out.allBeastModes = true;
	return out;
}

/** True when the selection names dashboards, worksheets or datasources. */
export function hasObjectSelection(selection) {
	const s = selection ?? {};
	return Boolean(list(s.dashboards) || list(s.worksheets) || list(s.datasources));
}

function globRegex(pattern) {
	const body = pattern
		.split('*')
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${body}$`, 'i');
}

/**
 * Match name patterns against candidate names. A pattern that matches nothing is retried split on commas
 * (so "A,B" works while names that contain commas still match whole). Unknown names throw a SelectionError.
 * @param {string[]} patterns
 * @param {string[]} candidates
 * @param {string} what   'dashboard' | 'worksheet' | 'datasource'
 * @returns {string[]} matched candidates, in candidate order
 */
export function matchNames(patterns, candidates, what) {
	const unique = [...new Set(candidates.filter((c) => c !== undefined && c !== null && c !== ''))];
	const matched = new Set();
	const unknown = [];
	const tryPattern = (p) => {
		const re = globRegex(p.trim());
		// Patterns are trimmed, so names with leading or trailing spaces match trimmed too.
		const hits = unique.filter((c) => re.test(c) || re.test(String(c).trim()));
		hits.forEach((h) => matched.add(h));
		return hits.length > 0;
	};
	for (const pattern of patterns ?? []) {
		if (tryPattern(pattern)) continue;
		const parts = pattern.split(',').map((p) => p.trim()).filter(Boolean);
		if (parts.length > 1) {
			for (const part of parts) if (!tryPattern(part)) unknown.push(part);
		} else unknown.push(pattern);
	}
	if (unknown.length) {
		const valid = unique.length ? unique.map((v) => `"${v}"`).join(', ') : 'none';
		throw new SelectionError(`Unknown ${what}${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}. Valid ${what}s: ${valid}`, { what, unknown, valid: unique });
	}
	return unique.filter((c) => matched.has(c));
}

/**
 * Matcher for `keys`: plan key or 'kind:key', globs allowed. Without keys everything matches.
 * @param {string[]|undefined} keys
 * @returns {(kind: string, key: string) => boolean}
 */
export function keyMatcher(keys) {
	if (!keys?.length) return () => true;
	const res = keys.map(globRegex);
	return (kind, key) => res.some((re) => re.test(key) || re.test(`${kind}:${key}`));
}

/** Worksheet names a dashboard shows (sheet zones plus the sheets its filters and legends belong to). */
export function dashboardWorksheets(dashboard) {
	const names = [];
	for (const zone of [...(dashboard?.zones ?? []), ...(dashboard?.floating ?? [])]) {
		if (zone.worksheet && !names.includes(zone.worksheet)) names.push(zone.worksheet);
	}
	return names;
}

/**
 * Unsupported cards of worksheets on the selected dashboards that no layout places (label sheets). They select no
 * dataset; push needs them to delete the copy an earlier push created.
 */
function unplacedOn(cards, keptCards, ir, lowerDash) {
	const sheets = new Set((ir?.dashboards ?? []).filter((d) => lowerDash.has(d.name.toLowerCase())).flatMap(dashboardWorksheets));
	return cards.filter((c) => c.status === 'unsupported' && !keptCards.has(c.key) && sheets.has(c.worksheet));
}

function datasourceCandidates(ir, plan) {
	const byName = new Map();
	const add = (name, id) => {
		if (!name || !id) return;
		if (!byName.has(name)) byName.set(name, new Set());
		byName.get(name).add(id);
	};
	for (const ds of ir?.datasources ?? []) {
		add(ds.caption, ds.id);
		add(ds.id, ds.id);
		if (ds.published?.luid) add(ds.published.luid, ds.id);
	}
	for (const ds of plan?.datasets ?? []) {
		if (!ds.datasourceId) continue;
		add(ds.datasourceId, ds.datasourceId);
		if (ds.cardTarget) add(ds.name, ds.datasourceId);
	}
	return byName;
}

/**
 * Resolve a selection against the workbook IR: which datasources need data for it.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {Selection} selection
 * @returns {{ dashboards: string[], worksheets: string[], datasources: string[], datasourceIds: Set<string> }}
 */
export function selectIrDatasources(ir, selection) {
	const sel = normalizeSelection(selection);
	const dashboards = sel.dashboards ? matchNames(sel.dashboards, [...(ir.dashboards ?? []), ...(ir.stories ?? [])].map((d) => d.name), 'dashboard') : [];
	const worksheets = sel.worksheets ? matchNames(sel.worksheets, (ir.worksheets ?? []).map((w) => w.name), 'worksheet') : [];
	const dsNames = datasourceCandidates(ir, null);
	const datasources = sel.datasources ? matchNames(sel.datasources, [...dsNames.keys()], 'datasource') : [];
	const sheetNames = new Set(worksheets);
	for (const d of (ir.dashboards ?? []).filter((x) => dashboards.includes(x.name))) dashboardWorksheets(d).forEach((n) => sheetNames.add(n));
	for (const s of (ir.stories ?? []).filter((x) => dashboards.includes(x.name))) {
		for (const point of s.points ?? []) if (point.sheetKind === 'worksheet') sheetNames.add(point.sheet);
	}
	const datasourceIds = new Set();
	for (const ws of (ir.worksheets ?? []).filter((w) => sheetNames.has(w.name))) (ws.datasourceIds ?? []).forEach((id) => datasourceIds.add(id));
	for (const name of datasources) dsNames.get(name).forEach((id) => datasourceIds.add(id));
	return { dashboards, worksheets, datasources, datasourceIds };
}

/** The name `--dashboards` selects a page by: its dashboard, or the story of a story view. */
const viewName = (page) => page.dashboard || page.story || '';

function refsOf(value, kind) {
	return [...collectRefs(value)].filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1));
}

/** Lowercase column names of every dataset in a plan, for `mentions` of variables. */
export function planColumns(plan) {
	return new Set((plan.datasets ?? []).flatMap((d) => (d.schema ?? []).map((c) => String(c.name).toLowerCase())));
}

function jsonText(value) {
	return value === undefined ? '' : JSON.stringify(value);
}

/**
 * True when `text` (JSON or SQL) references a beast mode or variable by legacyId or backticked name. A backticked
 * name that is also a dataset column (`columns`, lowercase) reads the column, as in `bindVariables`.
 * @param {string} text
 * @param {{ legacyId?: string, name?: string }} item
 * @param {{ columns?: Set<string> }} [opts]
 */
export function mentions(text, item, { columns } = {}) {
	if (!text) return false;
	if (item.legacyId && text.includes(item.legacyId)) return true;
	if (!item.name || columns?.has(item.name.toLowerCase())) return false;
	const name = `\`${item.name}\``;
	return text.includes(name) || text.includes(JSON.stringify(name).slice(1, -1));
}

/** Keys of the beast modes `isUsed` accepts plus, transitively, those of the same dataset their expressions reference. */
export function closeBeastModes(beastModes, isUsed) {
	const kept = new Set(beastModes.filter(isUsed).map((b) => b.key));
	const queue = beastModes.filter((b) => kept.has(b.key));
	while (queue.length) {
		const bm = queue.shift();
		for (const other of beastModes) {
			if (kept.has(other.key) || other.datasetKey !== bm.datasetKey || !mentions(bm.expression, other)) continue;
			kept.add(other.key);
			queue.push(other);
		}
	}
	return kept;
}

/** Keys of the beast modes a plan's cards (on their datasets), pages, app, dataflows, views and variables use. */
export function usedBeastModes(plan) {
	const cardText = new Map();
	for (const card of plan.cards ?? []) {
		const text = jsonText(card);
		for (const key of new Set([card.datasetKey ?? '', ...refsOf(card, 'dataset')])) cardText.set(key, `${cardText.get(key) ?? ''}${text}`);
	}
	const shared = [plan.pages, plan.app, plan.dataflows, (plan.datasets ?? []).map((d) => d.view), plan.variables].map(jsonText).join('');
	return closeBeastModes(plan.beastModes ?? [], (bm) => mentions(cardText.get(bm.datasetKey), bm) || mentions(shared, bm));
}

function planCounts(plan) {
	return {
		datasets: plan.datasets?.length ?? 0,
		dataflows: plan.dataflows?.length ?? 0,
		beastModes: plan.beastModes?.length ?? 0,
		variables: plan.variables?.length ?? 0,
		cards: plan.cards?.length ?? 0,
		pages: plan.pages?.length ?? 0
	};
}

/**
 * Prune a plan to the selected dashboards, worksheets and datasources plus everything they need:
 * dashboard pages (their layout cards and filter cards) and the pages above them, worksheet cards,
 * the datasets the cards target with their inputs (dataflows, views, uploaded tables), the beast modes
 * the kept cards reference (and those they reference, or all with `allBeastModes`) and the variables used.
 * Pages kept only to hold a card or a subpage lose their layout and filters, so pushing a subset never
 * rewrites a page layout with fewer cards. Pure; returns the plan itself when nothing is selected.
 *
 * @param {import('../model/types.js').DomoPlan} plan
 * @param {Selection} selection
 * @param {{ ir?: import('../model/types.js').WorkbookIR }} [opts]  The IR adds datasource captions and IR-only names
 * @returns {import('../model/types.js').DomoPlan & { selection?: Object }}
 */
export function selectPlan(plan, selection, { ir } = {}) {
	const sel = normalizeSelection(selection);
	if (!hasObjectSelection(sel)) return plan;
	const pages = plan.pages ?? [];
	const cards = plan.cards ?? [];
	const datasets = plan.datasets ?? [];
	const dataflows = plan.dataflows ?? [];
	const beastModes = plan.beastModes ?? [];
	const variables = plan.variables ?? [];

	const dashboardNames = [...pages.map(viewName), ...(ir?.dashboards ?? []).map((d) => d.name)];
	const worksheetNames = [...cards.map((c) => c.worksheet), ...(ir?.worksheets ?? []).map((w) => w.name)];
	const dsNames = datasourceCandidates(ir, plan);
	const dashboards = sel.dashboards ? matchNames(sel.dashboards, dashboardNames, 'dashboard') : [];
	const worksheets = sel.worksheets ? matchNames(sel.worksheets, worksheetNames, 'worksheet') : [];
	const datasourceNames = sel.datasources ? matchNames(sel.datasources, [...dsNames.keys()], 'datasource') : [];
	const datasourceIds = new Set(datasourceNames.flatMap((n) => [...dsNames.get(n)]));

	const lowerDash = new Set(dashboards.map((d) => d.toLowerCase()));
	const lowerSheets = new Set(worksheets.map((w) => w.toLowerCase()));
	const pageByKey = new Map(pages.map((p) => [p.key, p]));
	const layoutPages = new Set(pages.filter((p) => viewName(p) && lowerDash.has(viewName(p).toLowerCase())).map((p) => p.key));

	const keptCards = new Set();
	for (const key of layoutPages) {
		const page = pageByKey.get(key);
		refsOf(page.layout, 'card').forEach((k) => keptCards.add(k));
		refsOf(page.filters, 'card').forEach((k) => keptCards.add(k));
	}
	for (const card of cards) {
		if ((card.pageKeys ?? []).some((k) => layoutPages.has(k))) keptCards.add(card.key);
		if (card.worksheet && lowerSheets.has(card.worksheet.toLowerCase())) keptCards.add(card.key);
		if (card.stack?.sheets.some((s) => lowerSheets.has(s.toLowerCase()))) keptCards.add(card.key);
	}
	const cardList = cards.filter((c) => keptCards.has(c.key));

	const containerPages = new Set();
	for (const card of cardList) {
		const onPages = (card.pageKeys ?? []).filter((k) => pageByKey.has(k));
		if (onPages.length && !onPages.some((k) => layoutPages.has(k))) containerPages.add(onPages[0]);
	}
	for (const key of [...layoutPages, ...containerPages]) {
		let parent = pageByKey.get(key)?.parentKey;
		const seen = new Set();
		while (parent && pageByKey.has(parent) && !seen.has(parent)) {
			seen.add(parent);
			if (!layoutPages.has(parent)) containerPages.add(parent);
			parent = pageByKey.get(parent).parentKey;
		}
	}

	const dsByKey = new Map(datasets.map((d) => [d.key, d]));
	const dfByKey = new Map(dataflows.map((d) => [d.key, d]));
	const keptDatasets = new Set();
	const keptDataflows = new Set();
	const wholeDatasets = new Set();
	for (const ds of datasets) {
		if (ds.datasourceId && datasourceIds.has(ds.datasourceId)) {
			keptDatasets.add(ds.key);
			wholeDatasets.add(ds.key);
		}
	}
	for (const card of cardList) {
		if (card.datasetKey) keptDatasets.add(card.datasetKey);
		refsOf(card.body, 'dataset').forEach((k) => keptDatasets.add(k));
		refsOf(card.bigNumber, 'dataset').forEach((k) => keptDatasets.add(k));
	}
	const pagesKept = pages.filter((p) => layoutPages.has(p.key));
	for (const page of pagesKept) refsOf(page.filters, 'dataset').forEach((k) => keptDatasets.add(k));

	const cardText = new Map();
	for (const card of cardList) {
		const key = card.datasetKey ?? '';
		cardText.set(key, `${cardText.get(key) ?? ''}${jsonText(card)}`);
	}
	const pageText = pagesKept.map((p) => jsonText(p.filters) + jsonText(p.layout)).join('');
	const allCardText = [...cardText.values()].join('') + pageText;

	const closeDatasets = () => {
		const queue = [...keptDatasets];
		while (queue.length) {
			const ds = dsByKey.get(queue.shift());
			if (!ds) continue;
			const inputs = [...refsOf(ds.view, 'dataset')];
			if (ds.strategy === 'dataflow-output' && ds.dataflowOutput?.dataflowKey) {
				const df = dfByKey.get(ds.dataflowOutput.dataflowKey);
				if (df && !keptDataflows.has(df.key)) {
					keptDataflows.add(df.key);
					inputs.push(...refsOf(df.definition, 'dataset'), ...(df.outputDatasetKeys ?? []));
				}
			}
			for (const k of inputs) {
				if (!keptDatasets.has(k)) {
					keptDatasets.add(k);
					queue.push(k);
				}
			}
		}
	};
	closeDatasets();
	for (const df of dataflows) {
		if (!keptDataflows.has(df.key) && (df.outputDatasetKeys ?? []).some((k) => keptDatasets.has(k))) {
			keptDataflows.add(df.key);
			refsOf(df.definition, 'dataset').forEach((k) => keptDatasets.add(k));
			(df.outputDatasetKeys ?? []).forEach((k) => keptDatasets.add(k));
			closeDatasets();
		}
	}

	const candidates = beastModes.filter((b) => keptDatasets.has(b.datasetKey));
	const keptBeastModes = closeBeastModes(candidates, (bm) => sel.allBeastModes || wholeDatasets.has(bm.datasetKey) || mentions(cardText.get(bm.datasetKey), bm) || mentions(pageText, bm));
	const bmList = beastModes.filter((b) => keptBeastModes.has(b.key));
	const usageText = allCardText + bmList.map((b) => b.expression ?? '').join('\n');
	const columns = planColumns(plan);
	const varList = variables.filter((v) => mentions(usageText, v, { columns }));

	const pageList = pages
		.filter((p) => layoutPages.has(p.key) || containerPages.has(p.key))
		.map((p) => {
			if (layoutPages.has(p.key)) return p;
			const rest = { ...p };
			delete rest.layout;
			delete rest.filters;
			return rest;
		});
	const keptPageKeys = new Set(pageList.map((p) => p.key));

	const pruned = {
		...plan,
		datasets: datasets.filter((d) => keptDatasets.has(d.key)),
		dataflows: dataflows.filter((d) => keptDataflows.has(d.key)),
		beastModes: bmList,
		variables: varList,
		cards: [...cardList, ...unplacedOn(cards, keptCards, ir, lowerDash)].map((c) => ({ ...c, pageKeys: (c.pageKeys ?? []).filter((k) => keptPageKeys.has(k)) })),
		pages: pageList
	};
	if (plan.app && !pageList.some((p) => p.appKey === plan.app.key)) delete pruned.app;
	const previous = plan.selection;
	pruned.selection = {
		dashboards,
		worksheets,
		datasources: datasourceNames,
		...(sel.allBeastModes ? { allBeastModes: true } : {}),
		containerPages: [...containerPages],
		counts: { before: previous?.counts?.before ?? planCounts(plan), after: planCounts(pruned) }
	};
	return pruned;
}
