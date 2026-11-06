import fs from 'node:fs';
import path from 'node:path';
import { requireDomo } from '../config.js';
import { PLAN_VERSION } from '../model/types.js';
import { createEmitter } from '../util/events.js';
import { createTimer } from '../util/timing.js';
import { imageInfo } from '../util/image.js';
import { shortHash } from '../util/ids.js';
import { collectRefs, isRef, resolveRefs } from '../util/refs.js';
import { KIND_GROUP, hasObjectSelection, keyMatcher, mentions, normalizeSelection, planColumns, selectPlan } from '../convert/select.js';
import { bindVariables, variableControl, variableExpression } from '../convert/variables.js';
import { finishLayout } from '../convert/layout.js';
import { isTableChart } from '../convert/drill.js';
import { UNION_CAST_TYPES, castUnionColumn } from '../convert/view-sql.js';
import { linkedPageKeys, tableauViewLink } from '../convert/app-layout.js';
import { paletteJson } from '../convert/colors.js';
import { expandSplitCard } from '../convert/split.js';
import { NAV_ICONS, appUrl, appViewIds, applyControlSpacing, applyItemStyles, applySectionFills, applyThemeImages, applyThemeOverrides, buildNavigation, findTheme, hasAppSettings, mergeAppSettings, sectionFillIds, visibleViewIds } from '../domo/apps.js';
import { instanceHost } from '../domo/client.js';
import { notebookBody, sameOwner } from '../domo/notebooks.js';
import { DEFAULT_FILTER_VIEW, sameFilters } from '../domo/pages.js';
import { copyCsvHead, csvLine } from '../tableau/data/csv-writer.js';
import { renameSqlDatabases } from '../tableau/data/sql-refs.js';
import { renderReport } from './report.js';
import { calendarNeeds, checkFiscalCalendars, otherWorkbookNeeds, workspaceCalendarConflicts } from './fiscal-calendars.js';
import { latestRunLogs, writeRunLog } from './runs.js';
import { acquireStateLock, deleteEntry, getEntry, loadState, saveState, setEntry } from './state.js';
import { openWorkspace } from './workspace.js';


export const PUSH_KINDS = ['datasets', 'dataflows', 'variables', 'beastmodes', 'app', 'pages', 'cards', 'layouts', 'navigation'];

const KIND_ALIASES = {
	app: 'app',
	apps: 'app',
	navigation: 'navigation',
	nav: 'navigation',
	dataset: 'datasets',
	datasets: 'datasets',
	dataflow: 'dataflows',
	dataflows: 'dataflows',
	view: 'datasets',
	views: 'datasets',
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

/**
 * @typedef {Object} PushAction
 * @property {'dataset'|'dataflow'|'variable'|'beastmode'|'app'|'page'|'card'|'layout'|'filterview'|'navigation'} kind
 * @property {string} key
 * @property {string} [name]
 * @property {'create'|'register'|'update'|'unchanged'|'reuse'|'skip'|'delete'} action  delete: a card pushed earlier that convert now marks unsupported
 * @property {string|number|null} id
 * @property {'ok'|'failed'|'skipped'|'dry-run'} status
 * @property {string} [error]
 * @property {string[]} [notes]
 *
 * @typedef {Object} PushSummary
 * @property {string} slug
 * @property {string} instance
 * @property {boolean} dryRun
 * @property {boolean} ok              No failed actions
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {import('../util/timing.js').Timing} [timing]   Step durations (preflight, each push stage, uploads, dataflow runs)
 * @property {Record<string, number>} counts   By action and by status ('status:failed', ...)
 * @property {PushAction[]} actions
 * @property {import('../model/types.js').Issue[]} issues
 * @property {{ key: string, id: number|string, title: string, url: string, views: { key: string, title: string, id: number|string, url: string }[] }} [app]
 *   Target 'app' (not on dry runs): links to the app and its views
 */

/** A push that stops before any write, with a stable `code` (push.app-unavailable, push.target-changed). */
export class PushError extends Error {
	constructor(code, message, suggestion) {
		super(`${code}: ${message}${suggestion ? ` ${suggestion}` : ''}`);
		this.name = 'PushError';
		this.code = code;
		this.suggestion = suggestion;
	}
}

/**
 * Parse `only` (array or comma-separated string) into a set of PUSH_KINDS.
 * @param {string|string[]|undefined} only
 * @returns {Set<string>}
 */
export function parseOnly(only) {
	if (!only || (Array.isArray(only) && !only.length)) return new Set(PUSH_KINDS);
	const items = (Array.isArray(only) ? only : String(only).split(','))
		.flatMap((v) => String(v).split(','))
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);
	const out = new Set();
	for (const item of items) {
		const kind = KIND_ALIASES[item];
		if (!kind) throw new Error(`Unknown push kind "${item}" (use ${PUSH_KINDS.join(', ')})`);
		out.add(kind);
	}
	return out;
}

class DependencyError extends Error {
	constructor(message, refs) {
		super(message);
		this.name = 'DependencyError';
		this.refs = refs;
	}
}

async function loadDomoDeps(overrides = {}) {
	const need = (key, loader) => overrides[key] ?? loader();
	const [datasets, beastmodes, cards, pages, dataflows, views, streams, cloudAmplifier, variables, apps, probe, notebooks, files, federated] = await Promise.all([
		need('datasets', () => import('../domo/datasets.js')),
		need('beastmodes', () => import('../domo/beastmodes.js')),
		need('cards', () => import('../domo/cards.js')),
		need('pages', () => import('../domo/pages.js')),
		need('dataflows', () => import('../domo/dataflows.js')),
		need('views', () => import('../domo/views.js')),
		need('streams', () => import('../domo/streams.js')),
		need('cloudAmplifier', () => import('../domo/cloud-amplifier.js')),
		need('variables', () => import('../domo/variables.js')),
		need('apps', () => import('../domo/apps.js')),
		need('probe', () => import('../domo/probe.js')),
		need('notebooks', () => import('../domo/notebooks.js')),
		need('files', () => import('../domo/files.js')),
		need('federated', () => import('../domo/federated.js'))
	]);
	return { datasets, beastmodes, cards, pages, dataflows, views, streams, cloudAmplifier, variables, apps, probe, notebooks, files, federated };
}

const federatedTable = (fed) => [fed?.catalog, fed?.schema, fed?.table].filter(Boolean).join('.');

const isDuplicateVariableName = (err) => err?.status === 400 && /ib:7303|global variable name must be unique/i.test(err.message ?? '');

function errorMessage(err) {
	return err?.message ? String(err.message).slice(0, 2000) : String(err);
}

const describeFilters = (filters) => (filters ?? []).map((f) => `${f.column} ${f.operand} ${(f.values ?? []).join(', ')}`).join('; ') || 'none';

const norm = (v) => String(v ?? '').trim().toLowerCase();
// Version of applyControlSpacing an app got; an app's theme gets it once, so later edits in the theme editor stay.
const CONTROL_SPACING = 4;
// Part of every page layout hash: bump it when push changes what it writes to a page, so pushed pages are rewritten.
const LAYOUT_WRITER = 2;

/**
 * Most specific mappings.accounts entry whose `match` fields all equal the plan's accountMatch.
 * @param {import('../model/types.js').Mappings} mappings
 * @param {Record<string,string>} accountMatch
 */
export function resolveAccount(mappings, accountMatch = {}) {
	let best = null;
	let bestScore = -1;
	for (const account of mappings?.accounts ?? []) {
		const match = account.match ?? {};
		const keys = Object.keys(match).filter((k) => match[k] !== undefined && match[k] !== '');
		if (!keys.every((k) => norm(match[k]) === norm(accountMatch[k]))) continue;
		if (keys.length > bestScore) {
			best = account;
			bestScore = keys.length;
		}
	}
	return best;
}

/**
 * Apply a mappings.json account's `databases` renames ({ tableauName: warehouseName }) to a connector's
 * databaseName and to the three-part table names in its query, for a database the account sees under another name.
 */
export function renameConnectorDatabases(configuration, databases) {
	const renames = Object.fromEntries(Object.entries(databases ?? {}).map(([from, to]) => [from.toLowerCase(), to]));
	if (!Object.keys(renames).length || !Array.isArray(configuration)) return configuration;
	return configuration.map((entry) => {
		if (entry.name === 'databaseName' && renames[String(entry.value).toLowerCase()]) return { ...entry, value: renames[String(entry.value).toLowerCase()] };
		if (entry.name === 'query') return { ...entry, value: renameSqlDatabases(entry.value, renames).sql };
		return entry;
	});
}

/** A mappings.json account's `configuration` ({ name: value }, null drops the entry) over the planned connector configuration. */
export function overrideConfiguration(configuration, overrides) {
	if (!overrides || typeof overrides !== 'object' || !Array.isArray(configuration)) return configuration;
	const out = configuration.filter((entry) => !Object.hasOwn(overrides, entry.name));
	for (const [name, value] of Object.entries(overrides)) {
		if (value !== null && value !== undefined) out.push({ name, value: String(value), type: 'string', category: 'METADATA' });
	}
	return out;
}

/** Remove array items that reference one of `legacyIds` through `formulaId`, or `column` (beast mode filters). Returns [copy, removedCount]. */
export function stripFormulaRefs(value, legacyIds) {
	let removed = 0;
	const walk = (v) => {
		if (Array.isArray(v)) {
			const out = [];
			for (const item of v) {
				if (item && typeof item === 'object' && (legacyIds.has(item.formulaId) || legacyIds.has(item.column) || legacyIds.has(item.condition?.column))) {
					removed++;
					continue;
				}
				out.push(walk(item));
			}
			return out;
		}
		if (v && typeof v === 'object' && !isRef(v)) {
			const out = {};
			for (const [k, child] of Object.entries(v)) out[k] = walk(child);
			return out;
		}
		return v;
	};
	const result = walk(value);
	return [result, removed];
}

function withBigNumber(body, bigNumber) {
	if (!bigNumber?.columns?.length) return body;
	const definition = body.definition ?? {};
	return {
		...body,
		definition: {
			...definition,
			subscriptions: { ...definition.subscriptions, big_number: { name: 'big_number', ...bigNumber } }
		}
	};
}

function sortPages(pages) {
	const byKey = new Map(pages.map((p) => [p.key, p]));
	const out = [];
	const seen = new Set();
	const visit = (page, trail = new Set()) => {
		if (seen.has(page.key)) return;
		if (trail.has(page.key)) throw new Error(`Page parent cycle at "${page.key}"`);
		trail.add(page.key);
		const parent = page.parentKey && byKey.get(page.parentKey);
		if (parent) visit(parent, trail);
		seen.add(page.key);
		out.push(page);
	};
	pages.forEach((p) => visit(p));
	return out;
}

function idOf(result, ...fields) {
	if (result == null || typeof result !== 'object') return result;
	for (const f of fields) if (result[f] != null) return result[f];
	return undefined;
}

/**
 * Ref fields that app links read from a state entry: `idString`, a view's `appUrl` (/app-studio/<app>/pages/<view>, the
 * exact url a same-app DOMOLINK needs), a card's `detailsUrl`, and `webUrl`, the https address of a view, page or card on
 * `host` (a WEBLINK to another app's view).
 */
export function linkField(refString, entry, field, host) {
	if (field === 'idString') return String(entry.id);
	if (field === 'appUrl' && refString.startsWith('page:') && entry.extra?.appId != null) return `/app-studio/${entry.extra.appId}/pages/${entry.id}`;
	if (field === 'detailsUrl' && refString.startsWith('card:')) return `/kpis/details/${entry.id}`;
	// Text and image cards record no urn; a card's urn is its id.
	if (field === 'urn' && refString.startsWith('card:')) return String(entry.extra?.urn ?? entry.id);
	if (field === 'webUrl' && host) {
		if (refString.startsWith('card:')) return `https://${host}/kpis/details/${entry.id}`;
		if (refString.startsWith('page:')) return entry.extra?.appId != null ? `https://${host}/app-studio/${entry.extra.appId}/pages/${entry.id}` : `https://${host}/page/${entry.id}`;
	}
	return undefined;
}

/**
 * A same-view filter on selected cards (STANDARD with `selectedCardUrns`) keeps only the cards that are pushed; with none
 * left it disables click filtering (the editor's "disable interaction filters"), so it never widens to every card.
 * @param {(value: unknown) => string[]} unresolved  Refs in a value that have no pushed id
 */
export function withPushedCardUrns(item, unresolved, notes) {
	const config = item.interaction?.type === 'STANDARD' ? item.interaction.config : undefined;
	if (!config?.selectedCardUrns?.length) return item;
	const urns = config.selectedCardUrns.filter((u) => !unresolved(u).length);
	if (urns.length === config.selectedCardUrns.length) return item;
	const gone = config.selectedCardUrns.filter((u) => !urns.includes(u)).flatMap((u) => unresolved(u));
	notes.push(`item ${item.contentKey} filters ${urns.length ? 'only the pushed ones of its selected cards' : 'no card, since none of its selected cards is pushed'} (${gone.join(', ')} not pushed)`);
	return { ...item, interaction: { ...item.interaction, config: { ...config, allowCardToCardInteractions: urns.length > 0, selectIndividualCards: true, selectedCardUrns: urns } } };
}

/**
 * Move state entries recorded under a plan object's `previousKey` (its workbook-scoped key from before its
 * published datasource was shared) to the object's key, so a re-push updates instead of creating duplicates.
 * Mutates `state`; returns the moves.
 * @param {import('../model/types.js').DomoPlan} plan
 * @param {import('../model/types.js').PushState} state
 * @returns {{ from: string, to: string }[]}
 */
export function adoptPreviousKeys(plan, state) {
	const moves = [];
	for (const [kind, items] of [['dataset', plan.datasets], ['dataflow', plan.dataflows], ['beastmode', plan.beastModes], ['variable', plan.variables]]) {
		for (const item of items ?? []) {
			if (!item.previousKey || item.previousKey === item.key) continue;
			const to = `${kind}:${item.key}`;
			const from = `${kind}:${item.previousKey}`;
			if (state.objects[to] || !state.objects[from]) continue;
			state.objects[to] = state.objects[from];
			delete state.objects[from];
			moves.push({ from, to });
		}
	}
	return moves;
}

function resolveUploadFile(ws, slug, file) {
	if (path.isAbsolute(file)) return file;
	const candidates = [path.join(ws.paths(slug).dir, file), ws.resolve(file)];
	return candidates.find((f) => fs.existsSync(f)) ?? candidates[0];
}

/**
 * Hard dependencies of the objects a push writes that it does not write itself and `exists` does not know.
 * Beast modes a card references and a text card's dataset are soft (the card is pushed without them) and layout cards
 * are left out, so none of them is listed.
 * @param {import('../model/types.js').DomoPlan} plan
 * @param {(kind: string, key: string) => boolean} writes
 * @param {(ref: string) => boolean} exists
 * @returns {{ ref: string, by: string[] }[]}
 */
export function missingDependencies(plan, writes, exists) {
	const written = new Set();
	const needs = [];
	const add = (by, value) => {
		for (const r of collectRefs(value)) needs.push([by, r]);
	};
	for (const ds of plan.datasets ?? []) {
		if (!writes('dataset', ds.key) || ds.strategy === 'dataflow-output') continue;
		written.add(`dataset:${ds.key}`);
		add(`dataset:${ds.key}`, ds.view);
	}
	for (const df of plan.dataflows ?? []) {
		if (!writes('dataflow', df.key)) continue;
		written.add(`dataflow:${df.key}`);
		for (const o of df.outputDatasetKeys ?? []) written.add(`dataset:${o}`);
		add(`dataflow:${df.key}`, df.definition);
	}
	for (const v of plan.variables ?? []) if (writes('variable', v.key)) written.add(`variable:${v.key}`);
	const addVariables = (by, text) => {
		for (const v of plan.variables ?? []) if (v.legacyId && text.includes(`DOMO_BEAST_MODE(${v.legacyId})`)) needs.push([by, `variable:${v.key}`]);
	};
	for (const bm of plan.beastModes ?? []) {
		if (!writes('beastmode', bm.key) || bm.status === 'unsupported') continue;
		written.add(`beastmode:${bm.key}`);
		needs.push([`beastmode:${bm.key}`, `dataset:${bm.datasetKey}`]);
		addVariables(`beastmode:${bm.key}`, bm.expression ?? '');
	}
	if (plan.app) {
		if (writes('app', plan.app.key)) written.add(`app:${plan.app.key}`);
		if (writes('navigation', plan.app.key)) needs.push([`navigation:${plan.app.key}`, `app:${plan.app.key}`]);
	}
	for (const page of plan.pages ?? []) {
		if (writes('page', page.key)) {
			written.add(`page:${page.key}`);
			if (page.parentKey) needs.push([`page:${page.key}`, `page:${page.parentKey}`]);
			if (page.appKey) needs.push([`page:${page.key}`, `app:${page.appKey}`]);
		}
		if (page.layout && writes('layout', page.key)) needs.push([`layout:${page.key}`, `page:${page.key}`]);
		if (page.filters?.length && writes('filterview', page.key)) needs.push([`filterview:${page.key}`, `page:${page.key}`]);
	}
	for (const card of plan.cards ?? []) {
		if (!writes('card', card.key) || card.status === 'unsupported' || card.kind === 'notebook' || card.kind === 'image') continue;
		add(`card:${card.key}`, card.body);
		add(`card:${card.key}`, card.bigNumber);
		for (const view of card.drillPath ?? []) add(`card:${card.key}`, view.body);
		addVariables(`card:${card.key}`, JSON.stringify([card.body ?? null, card.bigNumber ?? null, ...(card.drillPath ?? []).map((v) => v.body)]));
	}
	const missing = new Map();
	for (const [by, r] of needs) {
		if (written.has(r) || exists(r)) continue;
		if (!missing.has(r)) missing.set(r, []);
		if (!missing.get(r).includes(by)) missing.get(r).push(by);
	}
	return [...missing].map(([ref, by]) => ({ ref, by }));
}

/**
 * Stage 3: create or update everything in plan.json on the Domo instance.
 *
 * @param {{
 *   config: import('../config.js').T2DConfig,
 *   slug: string,
 *   dryRun?: boolean,
 *   parentPageId?: string|number,
 *   only?: string|string[],
 *   force?: boolean,
 *   selection?: import('../convert/select.js').Selection,
 *   emitter?: import('../util/events.js').Emitter,
 *   plan?: import('../model/types.js').DomoPlan,
 *   deps?: { client?: any, createDomoClient?: Function, datasets?: any, beastmodes?: any, cards?: any, pages?: any, dataflows?: any, views?: any, streams?: any, cloudAmplifier?: any }
 * }} opts  `force` re-sends unchanged objects and re-uploads data. `selection` prunes the plan to dashboards, worksheets
 *   and datasources (selectPlan), `selection.kinds` (or `only`) and `selection.keys` limit what is written (objects they
 *   exclude must already be in state when a written object needs them, else push throws before any write),
 *   `selection.schemaOnly` creates datasets without rows and `selection.sampleRows` uploads only the first N rows.
 *   `plan`/`deps` are for tests and embedding.
 * @returns {Promise<PushSummary>}
 */
export async function pushPlan(opts) {
	if (opts.dryRun) return pushPlanUnlocked(opts);
	const ws = openWorkspace(opts.config.workspace);
	const release = await acquireStateLock(ws, requireDomo(opts.config).instance);
	try {
		return await pushPlanUnlocked(opts);
	} finally {
		await release();
	}
}

async function pushPlanUnlocked({
	config,
	slug,
	dryRun = false,
	parentPageId,
	only,
	force = false,
	selection,
	emitter = createEmitter(undefined, 'push'),
	plan: planOverride,
	deps = {}
}) {
	const timer = createTimer({ emitter });
	timer.phase('preflight');
	const ws = openWorkspace(config.workspace);
	const p = ws.paths(slug);
	let plan = planOverride ?? (await ws.readJson(p.plan, null));
	if (!plan) throw new Error(`No plan.json for "${slug}" at ${p.plan}. Run convert first.`);
	if (plan.planVersion > PLAN_VERSION) throw new Error(`plan.json version ${plan.planVersion} is newer than this tool supports (${PLAN_VERSION})`);
	const sel = normalizeSelection(selection);
	const fullPlan = plan;
	const hasImages = (fullPlan.cards ?? []).some((card) => card.kind === 'image' && card.status !== 'unsupported');
	// An app with image cards also gets the image style squared (applyControlSpacing images), once.
	const spacingMark = hasImages ? `${CONTROL_SPACING}+images` : CONTROL_SPACING;
	const sectionFills = [...new Set((fullPlan.pages ?? []).flatMap((pg) => (pg.layout?.content ?? []).map((item) => item.sectionFill).filter(Boolean)))];
	if (hasObjectSelection(sel)) plan = selectPlan(plan, sel, { ir: await ws.readJson(p.ir, null).catch(() => null) });
	const kinds = parseOnly(sel.kinds ?? only);
	const keyOk = keyMatcher(sel.keys);
	const writes = (kind, key) => kinds.has(KIND_GROUP[kind]) && keyOk(kind, key);
	const wholePlan = !hasObjectSelection(sel) && !sel.keys?.length && !plan.selection;
	const asApp = plan.target === 'app';
	if (asApp && parentPageId != null && parentPageId !== '') {
		throw new PushError('push.parent-page-app', 'App Studio apps have no parent page, so --parent-page cannot be used with this plan (converted with --target app).', 'Drop --parent-page, or convert with --target pages.');
	}

	let instance = config.domo?.instance || 'default';
	let c = null;
	if (!dryRun) {
		const domo = requireDomo(config);
		instance = domo.instance;
		if (deps.client) c = deps.client;
		else {
			const create = deps.createDomoClient ?? (await import('../domo/client.js')).createDomoClient;
			c = create({ instance: domo.instance, accessToken: domo.accessToken }, { emitter: emitter.child('domo') });
		}
	}
	const d = dryRun ? null : await loadDomoDeps(deps);
	const state = await loadState(ws, instance);
	const mappings = await ws.loadMappings();
	const logFile = dryRun ? p.pushDryRun : p.pushLog;

	const otherTarget = (plan.pages ?? [])
		.map((pg) => [pg.key, state.objects[`page:${pg.key}`]])
		.concat(asApp && plan.app ? [[plan.app.key, state.objects[`page:${plan.app.key}`]]] : [])
		.filter(([, e]) => e && (e.extra?.container === 'app') !== asApp);
	if (!asApp) {
		const roots = new Set((plan.pages ?? []).flatMap((pg) => [pg.key, pg.parentKey]).filter(Boolean));
		for (const key of roots) if (state.objects[`app:${key}`]) otherTarget.push([`app ${key}`, state.objects[`app:${key}`]]);
	}
	if (otherTarget.length) {
		const ids = otherTarget.slice(0, 10).map(([key, e]) => `${key} (${e.id})`).join(', ');
		throw new PushError(
			'push.target-changed',
			`This plan targets ${asApp ? 'an App Studio app' : 'classic pages'}, but ${otherTarget.length} of its objects were pushed to this instance as ${asApp ? 'classic pages' : 'an App Studio app or views'}: ${ids}.`,
			`Run t2d unpush first, or convert again with --target ${asApp ? 'pages' : 'app'}.`
		);
	}
	const appWrites = asApp && plan.app && ['app', 'pages', 'cards', 'layouts', 'navigation'].some((k) => kinds.has(k));
	const preflightIssues = [];
	let appFlags = null;
	if (appWrites && !dryRun) {
		try {
			const status = await d.probe.appStudioStatus(c);
			appFlags = status.flags;
			if (!status.available) {
				throw new PushError('push.app-unavailable', `App Studio is off on ${instance} (customer feature "data-app" is ${status.flags['data-app']}), so nobody could open the app.`, 'Ask Domo to enable App Studio, or convert again with --target pages.');
			}
		} catch (err) {
			if (err instanceof PushError) throw err;
			preflightIssues.push({ severity: 'warning', code: 'push.app-flags-unknown', message: `Could not read the instance feature flags, so App Studio availability is unchecked: ${errorMessage(err)}` });
		}
		if (appFlags?.['app-studio-persist'] === 'off') {
			preflightIssues.push({ severity: 'warning', code: 'push.app-persist-off', message: 'Feature "app-studio-persist" is off: the app ignores its persist settings, so filters and variables do not carry across views', suggestion: 'Ask Domo to enable app-studio-persist.' });
		}
		const sections = (plan.pages ?? []).some((pg) => (pg.layout?.content ?? []).some((i) => i.type === 'TABS'));
		if (sections && appFlags?.['app-studio-sections'] === 'off') {
			preflightIssues.push({ severity: 'warning', code: 'push.app-sections-off', message: 'Feature "app-studio-sections" is off: sections in the layouts may not render for viewers' });
		}
	}
	const calendars = calendarNeeds(plan, (card) => writes('card', card.key));
	if (calendars.length) {
		let reader = c;
		if (!reader && config.domo?.instance && config.domo?.accessToken) {
			reader = deps.client ?? (deps.createDomoClient ?? (await import('../domo/client.js')).createDomoClient)({ instance: config.domo.instance, accessToken: config.domo.accessToken }, { emitter: emitter.child('domo') });
		}
		emitter.step('Fiscal calendars');
		preflightIssues.push(...(await checkFiscalCalendars(reader, calendars, { instance: config.domo?.instance || instance })));
		preflightIssues.push(...workspaceCalendarConflicts(calendars, await otherWorkbookNeeds(ws, slug)));
	}

	/** @type {PushSummary} */
	const summary = {
		slug,
		instance,
		dryRun,
		ok: true,
		startedAt: new Date().toISOString(),
		counts: {},
		actions: [],
		issues: [...preflightIssues]
	};
	const failed = new Set();
	const dryIds = new Map();
	const adoptedImages = new Set();
	const recreatedViews = new Set();
	const layoutsPushed = new Set();
	const refreshed = new Set();
	/** Datasets that never had data, so cards on them would fail ("could not load schema"), mapped to the reason. */
	const noData = new Map();

	const checkpoint = async () => {
		if (!dryRun) await saveState(ws, state);
		await ws.writeJson(logFile, summary);
	};

	const record = async (action) => {
		const row = { id: null, ...action };
		summary.actions.push(row);
		summary.counts[row.action] = (summary.counts[row.action] || 0) + 1;
		summary.counts[`status:${row.status}`] = (summary.counts[`status:${row.status}`] || 0) + 1;
		const ref = `${row.kind}:${row.key}`;
		if (row.status === 'failed' || row.status === 'skipped') failed.add(ref);
		const stamped = !dryRun && row.status === 'ok' && state.objects[ref];
		if (stamped && !(stamped.extra?.workbooks ?? []).includes(slug)) setEntry(state, ref, { extra: { workbooks: [...(stamped.extra?.workbooks ?? []), slug] } });
		if (row.status === 'failed') {
			summary.ok = false;
			emitter.warn(`${row.kind} "${row.name ?? row.key}" failed: ${row.error}`, { ref });
		} else if (row.status === 'skipped') {
			emitter.warn(`${row.kind} "${row.name ?? row.key}" skipped: ${row.error ?? 'skipped'}`, { ref });
		} else {
			emitter.progress(`${row.action} ${row.kind} "${row.name ?? row.key}"${row.id != null ? ` (${row.id})` : ''}`, { ref, action: row.action, status: row.status });
		}
		await checkpoint();
		return row;
	};

	const placeholder = (ref) => {
		const id = `dry-run:${ref}`;
		dryIds.set(ref, id);
		return id;
	};

	const superseded = new Set();
	const used = new Set();
	const lookup = (refString, field) => {
		const entry = superseded.has(refString) ? undefined : state.objects[refString];
		if (failed.has(refString) && !(entry && dryRun)) return undefined;
		if (entry) {
			used.add(refString);
			if (field === 'id') return entry.id;
			const computed = linkField(refString, entry, field, instanceHost(instance));
			if (computed !== undefined) return computed;
			return entry[field] ?? entry.extra?.[field];
		}
		if (dryRun && dryIds.has(refString)) return field === 'id' ? dryIds.get(refString) : `${dryIds.get(refString)}:${field}`;
		return undefined;
	};

	const resolve = (value) => {
		const missing = [...collectRefs(value)].filter((r) => {
			if (failed.has(r)) return true;
			return lookup(r, 'id') === undefined;
		});
		if (missing.length) {
			const why = missing.map((r) => (failed.has(r) ? `${r} (failed or skipped)` : `${r} (not pushed yet)`));
			throw new DependencyError(`Depends on ${why.join(', ')}`, missing);
		}
		return resolveRefs(value, lookup);
	};

	const changed = (entry, hash) => force || !entry || entry.hash !== hash;

	const datasetPlans = plan.datasets ?? [];
	const dsByKey = new Map(datasetPlans.map((ds) => [ds.key, ds]));

	const adopted = adoptPreviousKeys(plan, state);
	if (adopted.length) {
		emitter.info(`${adopted.length} object(s) pushed under workbook-scoped keys now use shared published datasource keys`, { adopted });
		summary.issues.push({
			severity: 'info',
			code: 'push.shared-keys-adopted',
			message: `Reused ${adopted.length} object(s) pushed before their published datasource became shared: ${adopted.slice(0, 10).map((a) => `${a.from} -> ${a.to}`).join(', ')}${adopted.length > 10 ? ', ...' : ''}`
		});
	}

	for (const ds of datasetPlans) {
		const ref = `dataset:${ds.key}`;
		if (ds.strategy !== 'existing' || !ds.existing?.datasetId || writes('dataset', ds.key) || getEntry(state, ref)) continue;
		if (dryRun) dryIds.set(ref, ds.existing.datasetId);
		else setEntry(state, ref, { id: ds.existing.datasetId, extra: { strategy: 'existing' } });
	}
	const missing = missingDependencies(plan, writes, (ref) => Boolean(getEntry(state, ref) || dryIds.has(ref)));
	if (missing.length) {
		const lines = missing.slice(0, 20).map((m) => `${m.ref} (needed by ${m.by.slice(0, 3).join(', ')}${m.by.length > 3 ? ', ...' : ''})`);
		throw new Error(
			`The objects to push need ${missing.length} object(s) that are excluded by --only/--keys and not pushed yet: ${lines.join('; ')}${missing.length > 20 ? '; ...' : ''}. Include them in the push, or push them first.`
		);
	}
	for (const ds of datasetPlans.filter((x) => x.upload?.sampled && writes('dataset', x.key))) {
		summary.issues.push({
			severity: 'warning',
			code: 'push.partial-data',
			message: `Dataset "${ds.name}" holds a sample: extract kept only the first ${ds.upload.sampled} rows per table`,
			object: { type: 'dataset', name: ds.name, id: ds.key },
			suggestion: 'Extract again without --sample-rows, convert and push to load all rows.'
		});
	}
	if (sel.sampleRows) {
		summary.issues.push({
			severity: 'warning',
			code: 'push.partial-data',
			message: `Only the first ${sel.sampleRows} rows per table are uploaded (--sample-rows)`,
			suggestion: 'Push again without --sample-rows to load all rows.'
		});
	}

	timer.phase('datasets', kinds.has('datasets'));
	/* 1. Datasets (everything except dataflow outputs). */
	if (kinds.has('datasets')) {
		emitter.step('Datasets');
		for (const ds of datasetPlans.filter((x) => x.strategy !== 'dataflow-output' && writes('dataset', x.key))) {
			const ref = `dataset:${ds.key}`;
			const entry = settleStrategy(ds, ref, getEntry(state, ref));
			const base = { kind: 'dataset', key: ds.key, name: ds.name };
			try {
				if (ds.strategy === 'existing') {
					const id = ds.existing?.datasetId;
					if (!id) throw new Error('strategy "existing" without existing.datasetId');
					if (!dryRun) setEntry(state, ref, { id, extra: { strategy: 'existing' } });
					else dryIds.set(ref, id);
					await record({ ...base, action: 'reuse', id, status: dryRun ? 'dry-run' : 'ok' });
				} else if (ds.strategy === 'upload') {
					await pushUploadDataset(ds, ref, entry, base);
				} else if (ds.strategy === 'connector') {
					await pushConnectorDataset(ds, ref, entry, base);
				} else if (ds.strategy === 'cloud-amplifier') {
					await pushCloudAmplifierDataset(ds, ref, entry, base);
				} else if (ds.strategy === 'federated') {
					await pushFederatedDataset(ds, ref, entry, base);
				} else if (ds.strategy === 'view') {
					await pushViewDataset(ds, ref, entry, base);
				} else {
					throw new Error(`Unknown dataset strategy "${ds.strategy}"`);
				}
			} catch (err) {
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err) });
			}
		}
	}

	/**
	 * The state entry `ds` may reuse, or undefined when it was pushed with another strategy (or another Cloud Amplifier
	 * table). The old dataset is never written again: a mapped or pre-registered one is left alone, and one t2d created
	 * moves to a retired key so unpush still removes it.
	 */
	function settleStrategy(ds, ref, entry) {
		const stored = entry?.extra?.strategy;
		if (!entry || !stored) return entry;
		const caTable = ds.cloudAmplifier ? `${ds.cloudAmplifier.databaseName}.${ds.cloudAmplifier.schemaName}.${ds.cloudAmplifier.tableName}` : undefined;
		const sameTarget =
			ds.strategy === 'existing'
				? String(entry.id) === String(ds.existing?.datasetId ?? '')
				: stored === ds.strategy &&
					(ds.strategy !== 'cloud-amplifier' || ((entry.extra.table ?? caTable) === caTable && String(entry.extra.integrationId ?? ds.cloudAmplifier?.integrationId) === String(ds.cloudAmplifier?.integrationId))) &&
					(ds.strategy !== 'federated' || (entry.extra.table === federatedTable(ds.federated) && String(entry.extra.accountId) === String(ds.federated?.accountId)));
		if (sameTarget) return entry;
		const now = ds.strategy === 'cloud-amplifier' ? `cloud-amplifier ${caTable}` : ds.strategy;
		const was = stored === 'cloud-amplifier' && entry.extra.table ? `cloud-amplifier ${entry.extra.table}` : stored;
		const customerOwned = stored === 'existing' || (stored === 'cloud-amplifier' && Boolean(entry.extra.alreadyRegistered || entry.extra.ownershipUncertain));
		const retiredRef = `${ref}~${stored}-${shortHash(String(entry.id))}`;
		summary.issues.push({
			severity: 'warning',
			code: 'push.dataset-strategy-changed',
			message: customerOwned
				? `Dataset "${ds.name}" changed from ${was} to ${now}: its previous dataset ${entry.id} was not created by t2d, so it is left untouched and ${ds.strategy === 'existing' ? 'the mapped dataset is used' : 'a new dataset is created'}`
				: `Dataset "${ds.name}" changed from ${was} to ${now}: ${ds.strategy === 'existing' ? 'the mapped dataset is used' : 'a new dataset is created'}; the previous one (${entry.id}) is no longer updated and is recorded as ${retiredRef} so unpush can remove it`,
			object: { type: 'dataset', name: ds.name, id: ds.key },
			suggestion: 'Cards and beast modes move to the new dataset on this push. Check the change is intended.'
		});
		if (dryRun) {
			superseded.add(ref);
		} else {
			if (!customerOwned) state.objects[retiredRef] = entry;
			delete state.objects[ref];
		}
		return undefined;
	}

	async function pushUploadDataset(ds, ref, entry, base) {
		const file = ds.upload?.file && !sel.schemaOnly ? resolveUploadFile(ws, slug, ds.upload.file) : null;
		if (file && !fs.existsSync(file)) throw new Error(`CSV not found: ${file}`);
		const stat = file ? fs.statSync(file) : null;
		const dataHash = stat ? shortHash(`${stat.size}:${stat.mtimeMs}${sel.sampleRows ? `:sample${sel.sampleRows}` : ''}`) : null;
		const schemaHash = shortHash(ds.schema ?? []);
		const notes = file ? [] : [ds.upload?.file ? 'schema only (--schema-only), no rows uploaded' : 'schema only, no data to upload'];
		const needsUpload = Boolean(file) && (force || !entry || entry.extra?.dataHash !== dataHash);
		const headerHash = `header:${schemaHash}`;
		const storedHash = entry?.extra?.dataHash;
		// Cards on a dataset that never had an upload fail with "could not load schema for datasource".
		const needsHeaderUpload = !file && (!storedHash || (storedHash.startsWith('header:') && (force || storedHash !== headerHash)));
		const needsSchema = entry && (force || entry.extra?.schemaHash !== schemaHash);
		let action = entry ? (needsUpload || needsSchema || needsHeaderUpload ? 'update' : 'unchanged') : 'create';
		if (dryRun) {
			const id = entry?.id ?? placeholder(ref);
			if (needsSchema) notes.push('schema changed');
			if (needsUpload) notes.push(`upload ${path.basename(file)} (${sel.sampleRows ? `first ${sel.sampleRows} rows of ` : ''}${stat.size} bytes)`);
			if (needsHeaderUpload) notes.push('upload header row only, to index the schema');
			await record({ ...base, action, id, status: 'dry-run', notes });
			return;
		}
		let id = entry?.id;
		if (!entry) {
			id = idOf(await d.datasets.createDataset(c, { name: ds.name, description: ds.description ?? '', schema: ds.schema }), 'dataSourceId', 'id');
			if (!id) throw new Error('createDataset returned no id');
			setEntry(state, ref, { id, extra: { strategy: 'upload', schemaHash } });
			await checkpoint();
		} else if (needsSchema) {
			await d.datasets.updateSchema(c, id, ds.schema);
			setEntry(state, ref, { extra: { schemaHash } });
			notes.push('schema updated');
		}
		if (needsUpload) {
			emitter.progress(`Uploading ${path.basename(file)} to ${ds.name}`, { ref, bytes: stat.size });
			let source = file;
			if (sel.sampleRows) {
				source = path.join(p.dir, 'push-sample', `${shortHash(file)}-${path.basename(file)}`);
				await fs.promises.mkdir(path.dirname(source), { recursive: true });
				await copyCsvHead({ input: file, output: source, rows: sel.sampleRows });
			}
			let result;
			const bytes = fs.statSync(source).size;
			try {
				result = await timer.time('datasets.upload', () => d.datasets.uploadCsv(c, id, source, { action: 'REPLACE', emitter: emitter.child('upload') }), (r) => ({ key: ds.key, name: ds.name, rows: r?.rowCount, bytes }));
			} finally {
				if (source !== file) await fs.promises.rm(source, { force: true });
			}
			setEntry(state, ref, { extra: { dataHash, rowCount: result?.rowCount, ...(sel.sampleRows ? { sampled: sel.sampleRows } : { sampled: undefined }) } });
			refreshed.add(ref);
			notes.push(`uploaded ${result?.rowCount ?? '?'} rows${sel.sampleRows ? ' (sample)' : ''}`);
		}
		if (needsHeaderUpload) {
			const source = path.join(p.dir, 'push-sample', `${shortHash(ref)}-header.csv`);
			await fs.promises.mkdir(path.dirname(source), { recursive: true });
			await fs.promises.writeFile(source, csvLine(ds.schema.map((col) => col.name)));
			try {
				await d.datasets.uploadCsv(c, id, source, { action: 'REPLACE', emitter: emitter.child('upload') });
			} finally {
				await fs.promises.rm(source, { force: true });
			}
			setEntry(state, ref, { extra: { dataHash: headerHash, rowCount: 0 } });
			refreshed.add(ref);
			notes.push('uploaded the header row to index the schema');
		}
		await record({ ...base, action, id, status: 'ok', notes });
	}

	async function pushConnectorDataset(ds, ref, entry, base) {
		const connector = ds.connector;
		if (!connector) throw new Error('strategy "connector" without connector');
		const account =
			resolveAccount(mappings, connector.accountMatch) ??
			(connector.accountId != null
				? (mappings.accounts ?? []).find((a) => String(a.accountId) === String(connector.accountId)) ?? { accountId: connector.accountId }
				: null);
		if (!entry && !account) {
			const m = connector.accountMatch ?? {};
			throw new Error(`No mappings.json account matches ${JSON.stringify(m)}. Add { "match": ${JSON.stringify(m)}, "accountId": <Domo account id> } to accounts.`);
		}
		const { accountId, providerKey, databases, configuration: overrides, ...accountExtras } = account ?? {};
		delete accountExtras.match;
		const configuration = overrideConfiguration(renameConnectorDatabases(connector.configuration, databases), overrides);
		const configHash = account ? shortHash({ configuration, accountId: String(accountId) }) : undefined;
		const changed = Boolean(entry && configHash && entry.extra?.configHash && entry.extra.configHash !== configHash);
		const pending = !entry || Boolean(entry.extra?.streamPending) || changed;
		const willRun = !sel.schemaOnly && (pending || force);
		if (sel.schemaOnly && pending) {
			noData.set(ref, `connector stream of dataset "${ds.name}" has not run yet (--schema-only), so the dataset has no data; push without --schema-only to run it before creating cards`);
		}
		const action = !entry ? 'create' : changed ? 'update' : 'reuse';
		if (dryRun) {
			const run = sel.schemaOnly ? ', stream not run (--schema-only)' : willRun && entry ? ', stream run' : '';
			const notes = [`connector ${providerKey ?? connector.providerKey}, account ${accountId ?? entry?.extra?.accountId}${changed ? ', configuration changed' : ''}${run}`];
			await record({ ...base, action, id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
			return;
		}
		let id = entry?.id;
		let streamId = entry?.extra?.streamId;
		if (!entry) {
			const connectorSpec = { ...connector, configuration };
			for (const k of ['accountMatch', 'unverified', 'query', 'accountId']) delete connectorSpec[k];
			const result = await d.streams.createConnectorStream(c, {
				...connectorSpec,
				...accountExtras,
				name: ds.name,
				description: ds.description ?? '',
				schema: ds.schema,
				providerKey: providerKey ?? connector.providerKey,
				accountId
			});
			id = result?.datasetId;
			streamId = result?.streamId;
			if (!id) throw new Error('createConnectorStream returned no datasetId');
			setEntry(state, ref, { id, extra: { strategy: 'connector', streamId, accountId, configHash, streamPending: true } });
			await checkpoint();
		} else if (changed && streamId != null) {
			await d.streams.updateConnectorStream(c, streamId, { configuration, accountId });
			setEntry(state, ref, { extra: { configHash, accountId, streamPending: true } });
			await checkpoint();
		} else if (configHash && !entry.extra?.configHash) {
			setEntry(state, ref, { extra: { configHash } });
		}
		if (streamId != null && willRun) {
			emitter.progress(`Running connector stream ${streamId} for ${ds.name}`, { ref });
			const endRun = timer.start('datasets.stream-run', { key: ds.key, name: ds.name });
			const execution = await d.streams.runStream(c, streamId);
			const executionId = d.streams.executionIdOf ? d.streams.executionIdOf(execution) : idOf(execution, 'executionId', 'id');
			const waitStart = Date.now();
			if (executionId != null && d.streams.waitForStreamExecution) {
				await d.streams.waitForStreamExecution(c, streamId, executionId, { emitter: emitter.child('stream') });
			}
			endRun({ waitMs: Date.now() - waitStart });
			setEntry(state, ref, { extra: { streamPending: undefined } });
			refreshed.add(ref);
		}
		const notes = [...(changed ? [`stream ${streamId} configuration updated`] : []), ...(refreshed.has(ref) ? [`stream ${streamId} run`] : [])];
		await record({ ...base, action, id, status: 'ok', notes });
	}

	async function pushCloudAmplifierDataset(ds, ref, entry, base) {
		const ca = ds.cloudAmplifier;
		if (!ca?.integrationId || !ca.tableName) throw new Error('strategy "cloud-amplifier" without cloudAmplifier integrationId and table');
		const table = `${ca.databaseName}.${ca.schemaName}.${ca.tableName}`;
		const notes = [`${table} on integration ${ca.integrationId}`];
		if (entry) {
			await record({ ...base, action: 'reuse', id: entry.id, status: dryRun ? 'dry-run' : 'ok', notes });
			return;
		}
		if (dryRun) {
			if (ca.registeredDatasetId) notes.push(`already registered as ${ca.registeredDatasetId}`);
			await record({ ...base, action: 'register', id: ca.registeredDatasetId ?? placeholder(ref), status: 'dry-run', notes });
			if (ca.registeredDatasetId) dryIds.set(ref, ca.registeredDatasetId);
			return;
		}
		const [result] = await d.cloudAmplifier.registerTables(c, ca.integrationId, [
			{ databaseName: ca.databaseName, schemaName: ca.schemaName, tableName: ca.tableName, dataProviderKey: ca.dataProviderKey, displayName: ds.name }
		]);
		const id = result?.datasetId;
		if (!id) throw new Error('Cloud Amplifier registration returned no dataset id');
		const knownBefore = ca.registeredDatasetId != null && String(ca.registeredDatasetId) === String(id);
		const uncertain = !knownBefore && Boolean(result.alreadyRegistered && result.afterRetry);
		const alreadyRegistered = knownBefore || (Boolean(result.alreadyRegistered) && !uncertain);
		setEntry(state, ref, {
			id,
			extra: { strategy: 'cloud-amplifier', integrationId: ca.integrationId, table, alreadyRegistered, ...(uncertain ? { ownershipUncertain: true } : {}) }
		});
		await checkpoint();
		if (alreadyRegistered) notes.push('already registered; reused (unpush leaves it in place)');
		if (uncertain) {
			notes.push('registered on a retry after an error; t2d may have created it (unpush leaves it in place)');
			summary.issues.push({
				severity: 'warning',
				code: 'push.cloud-amplifier-ownership-uncertain',
				message: `Cloud Amplifier table ${table} reported "already registered" after a retried registration, so t2d may have created dataset ${id}`,
				object: { type: 'dataset', name: ds.name, id: ds.key },
				suggestion: 'Unpush keeps this dataset. Delete it in Domo yourself if it was created by this push.'
			});
		}
		emitter.progress(`Waiting for the schema of ${table}`, { ref });
		const columns = await d.datasets.waitForReadable(c, id);
		notes.push(`${columns?.length ?? '?'} columns`);
		refreshed.add(ref);
		await record({ ...base, action: 'register', id, status: 'ok', notes });
	}

	async function pushFederatedDataset(ds, ref, entry, base) {
		const fed = ds.federated;
		if (!fed?.accountId || !fed.table) throw new Error('strategy "federated" without federated accountId and table');
		const table = federatedTable(fed);
		const notes = [`federated ${fed.providerKey}, account ${fed.accountId}, ${table}, cache ${fed.cacheTTL} s`];
		if (entry) {
			const before = entry.extra?.cacheTTL;
			const ttlChanged = before !== undefined && Number(before) !== Number(fed.cacheTTL);
			if (ttlChanged) notes.push(`cache TTL ${before} s to ${fed.cacheTTL} s`);
			if (ttlChanged && !dryRun) {
				await d.federated.updateFederatedCacheTtl(c, entry.id, fed.cacheTTL);
				setEntry(state, ref, { extra: { cacheTTL: fed.cacheTTL } });
				await checkpoint();
			}
			await record({ ...base, action: ttlChanged ? 'update' : 'reuse', id: entry.id, status: dryRun ? 'dry-run' : 'ok', notes });
			return;
		}
		if (dryRun) {
			await record({ ...base, action: 'create', id: placeholder(ref), status: 'dry-run', notes });
			return;
		}
		const columns = await d.federated.getTableColumns(c, fed.accountId, fed);
		if (!columns.length) throw new Error(`federated account ${fed.accountId} returned no columns for ${table}`);
		const id = await d.federated.createFederatedDataset(c, fed.accountId, { name: ds.name, description: ds.description ?? '', catalog: fed.catalog, schema: fed.schema, table: fed.table, cacheTTL: fed.cacheTTL, columns });
		setEntry(state, ref, { id, extra: { strategy: 'federated', accountId: fed.accountId, table, cacheTTL: fed.cacheTTL } });
		await checkpoint();
		notes.push(`${columns.length} columns`);
		await record({ ...base, action: 'create', id, status: 'ok', notes });
	}

	async function withUnionCasts(body, send) {
		let current = body;
		for (let attempt = 0; ; attempt++) {
			try {
				return await send(current);
			} catch (err) {
				const column = String(err?.message ?? '').match(/column types do not match\. .*?\(([^()]+)\):\w+ does not match/)?.[1];
				const declared = column && current.schema.tables.flatMap((t) => t.columns ?? []).find((col) => col.name === column);
				const sqlType = declared && UNION_CAST_TYPES[declared.type];
				if (!sqlType || attempt >= 40) throw err;
				const cast = castUnionColumn(current.schema.viewTemplate.selectString, column, sqlType);
				if (!cast.cast) throw err;
				emitter.progress(`View column ${column} differs in type between UNION branches; casting it to ${sqlType}`);
				current = { ...current, schema: { ...current.schema, viewTemplate: { ...current.schema.viewTemplate, selectString: cast.sql } } };
			}
		}
	}

	async function pushViewDataset(ds, ref, entry, base) {
		if (!ds.view) throw new Error('strategy "view" without view body');
		const body = resolve(ds.view);
		const sqlView = Boolean(body.schema?.viewTemplate);
		const hash = shortHash(body);
		const isChanged = changed(entry, hash);
		const action = entry ? (isChanged ? 'update' : 'unchanged') : 'create';
		if (dryRun) {
			await record({ ...base, action, id: entry?.id ?? placeholder(ref), status: 'dry-run', notes: sqlView ? ['SQL DataSet View'] : [] });
			return;
		}
		let id = entry?.id;
		if (!entry) {
			id = idOf(sqlView ? await withUnionCasts(body, (b) => d.views.createSqlView(c, b)) : await d.views.createFusion(c, body), 'dataSourceId', 'id');
			if (!id) throw new Error(`${sqlView ? 'createSqlView' : 'createFusion'} returned no dataSourceId`);
		} else if (isChanged) {
			if (sqlView) await withUnionCasts(body, (b) => d.views.updateSqlView(c, id, b));
			else await d.views.updateFusion(c, id, body);
		}
		setEntry(state, ref, { id, hash, extra: { strategy: 'view', ...(sqlView ? { sql: true } : {}) } });
		await checkpoint();
		if (action !== 'unchanged') {
			emitter.progress(`Waiting for view ${ds.name} to be readable`, { ref });
			const columns = (body.schema?.tables ?? []).flatMap((t) => t.columns ?? []).map((col) => col.name);
			await d.datasets.waitForReadable(c, id, { columns });
			refreshed.add(ref);
		}
		await record({ ...base, action, id, status: 'ok' });
	}

	timer.phase('dataflows', kinds.has('dataflows'));
	/* 2. Dataflows, then the datasets they output. */
	if (kinds.has('dataflows')) {
		const dataflows = (plan.dataflows ?? []).filter((df) => writes('dataflow', df.key));
		if (dataflows.length) emitter.step('DataFlows');
		for (const df of dataflows) {
			const ref = `dataflow:${df.key}`;
			const entry = getEntry(state, ref);
			const base = { kind: 'dataflow', key: df.key, name: df.name };
			const outputs = (df.outputDatasetKeys ?? []).map((k) => dsByKey.get(k)).filter(Boolean);
			try {
				const def = resolve(df.definition);
				const hash = shortHash(def);
				const outputMissing = !outputs.every((o) => getEntry(state, `dataset:${o.key}`));
				const isChanged = changed(entry, hash) || (Boolean(entry) && outputMissing);
				const action = entry ? (isChanged ? 'update' : 'unchanged') : 'create';
				const inputsRefreshed = [...collectRefs(df.definition)].some((r) => refreshed.has(r));
				const run = df.runAfterCreate !== false && (isChanged || inputsRefreshed || outputMissing);
				if (dryRun) {
					const id = entry?.id ?? placeholder(ref);
					await record({ ...base, action, id, status: 'dry-run', notes: run ? ['run and wait'] : [] });
					for (const o of outputs) {
						const oref = `dataset:${o.key}`;
						const oid = getEntry(state, oref)?.id ?? placeholder(oref);
						await record({ kind: 'dataset', key: o.key, name: o.name, action: getEntry(state, oref) ? 'reuse' : 'create', id: oid, status: 'dry-run', notes: [`output of dataflow ${df.key}`] });
					}
					continue;
				}
				let id = entry?.id;
				let response = null;
				if (!entry) {
					response = await d.dataflows.createDataflow(c, def);
					id = idOf(response, 'id');
					if (id == null) throw new Error('createDataflow returned no id');
					setEntry(state, ref, { id, hash });
					await checkpoint();
				} else if (isChanged) {
					response = await d.dataflows.updateDataflow(c, id, def);
					setEntry(state, ref, { hash });
				}
				let execution = null;
				if (run) {
					emitter.progress(`Running dataflow ${df.name}`, { ref });
					const endRun = timer.start('dataflows.run', { key: df.key, name: df.name });
					const started = await d.dataflows.runDataflow(c, id);
					const waitStart = Date.now();
					try {
						execution = await d.dataflows.waitForExecution(c, id, idOf(started, 'id'));
					} finally {
						endRun({ waitMs: Date.now() - waitStart });
					}
					const exState = String(execution?.state ?? execution?.status ?? '').toUpperCase();
					if (['FAILED', 'KILLED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(exState)) {
						throw new Error(`Dataflow execution ${idOf(started, 'id')} ended ${exState}`);
					}
				}
				await record({ ...base, action, id, status: 'ok', notes: run ? ['ran'] : [] });
				recordDataflowOutputs(df, outputs, response, execution);
				if (outputs.some((o) => !getEntry(state, `dataset:${o.key}`)) && d.dataflows.getDataflow) {
					recordDataflowOutputs(df, outputs, await d.dataflows.getDataflow(c, id));
				}
				for (const o of outputs) {
					const oref = `dataset:${o.key}`;
					const oentry = getEntry(state, oref);
					if (oentry) {
						if (run) refreshed.add(oref);
						await record({ kind: 'dataset', key: o.key, name: o.name, action: 'reuse', id: oentry.id, status: 'ok', notes: [`output of dataflow ${df.key}`] });
					} else {
						await record({ kind: 'dataset', key: o.key, name: o.name, action: 'create', status: 'failed', error: `Output "${o.dataflowOutput?.outputName ?? o.name}" not found in the dataflow response` });
					}
				}
			} catch (err) {
				const status = err instanceof DependencyError ? 'skipped' : 'failed';
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status, error: errorMessage(err) });
				for (const o of outputs.filter((x) => !getEntry(state, `dataset:${x.key}`) || status === 'skipped')) {
					await record({ kind: 'dataset', key: o.key, name: o.name, action: 'skip', id: getEntry(state, `dataset:${o.key}`)?.id ?? null, status: 'skipped', error: `dataflow ${df.key} ${status}` });
				}
			}
		}
	}

	function recordDataflowOutputs(df, outputs, ...responses) {
		const found = responses.flatMap((r) => {
			if (!r || typeof r !== 'object') return [];
			if (d.dataflows.outputDatasets) return d.dataflows.outputDatasets(r).map((o) => ({ dataSourceId: o.id, dataSourceName: o.name }));
			return Array.isArray(r.outputs) ? r.outputs : [];
		});
		const fromDef = Array.isArray(df.definition?.outputs) ? df.definition.outputs : [];
		outputs.forEach((o, index) => {
			const oref = `dataset:${o.key}`;
			const wanted = norm(o.dataflowOutput?.outputName ?? o.name);
			let match = found.find((x) => norm(x.dataSourceName ?? x.name) === wanted);
			if (!match && found.length === outputs.length) match = found[index];
			if (!match && fromDef[index]?.dataSourceId && !isRef(fromDef[index].dataSourceId)) match = fromDef[index];
			const id = match?.dataSourceId ?? match?.id;
			if (!id) return;
			const prev = getEntry(state, oref);
			if (prev && String(prev.id) !== String(id)) settleStrategy(o, oref, prev);
			setEntry(state, oref, { id, extra: { strategy: 'dataflow-output', dataflowKey: df.key } });
		});
	}

	timer.phase('variables', kinds.has('variables'));
	/* 3. Variables (Tableau parameters), before beast modes that may reference them. */
	if (kinds.has('variables')) {
		const variables = (plan.variables ?? []).filter((v) => writes('variable', v.key));
		if (variables.length) emitter.step('Variables');
		for (const v of variables) {
			const ref = `variable:${v.key}`;
			let entry = getEntry(state, ref);
			const base = { kind: 'variable', key: v.key, name: v.name };
			const notes = [];
			try {
				if (entry && !dryRun && d.beastmodes.getBeastMode && (await d.beastmodes.getBeastMode(c, entry.id).then(() => false, (err) => err?.status === 404))) {
					notes.push(`variable ${entry.id} no longer exists in Domo; recreated`);
					deleteEntry(state, ref);
					entry = undefined;
				}
				const name = entry?.extra?.name ?? v.name;
				const spec = resolve({ name, expression: variableExpression(v), legacyId: v.legacyId, dataType: v.dataType, global: true, variable: true });
				const { control } = variableControl(v);
				const hash = shortHash({ spec: { ...spec, name: v.name }, control });
				// Another workbook created this variable: keep its default value and control (pages and cards carry their own value).
				// The owner gives the variable up when it unpushes (unpush drops it from extra.workbooks).
				const owner = entry?.extra?.createdBy;
				const ownedElsewhere = Boolean(owner) && owner !== slug && (entry.extra.workbooks ?? [owner]).includes(owner);
				const reused = ownedElsewhere && !force;
				const isChanged = !reused && changed(entry, hash);
				const action = reused ? 'reuse' : entry ? (isChanged ? 'update' : 'unchanged') : 'create';
				if (dryRun) {
					await record({ ...base, action, id: entry?.id ?? placeholder(ref), status: 'dry-run' });
					continue;
				}
				if (reused || (action === 'unchanged' && entry.extra?.defaultControlId != null)) {
					await record({ ...base, name, action, id: entry.id, status: 'ok' });
					continue;
				}
				let id = entry?.id;
				let finalAction = action;
				let saved = { ...spec };
				let adopted = false;
				if (!entry && d.beastmodes.findByLegacyId) {
					const found = await d.beastmodes.findByLegacyId(c, v.legacyId, { name: v.name }).catch(() => undefined);
					if (found?.id != null) {
						id = found.id;
						finalAction = 'update';
						saved = { ...spec, name: found.name ?? spec.name };
						adopted = true;
						notes.push('found on the instance (not created from this workspace), so unpush keeps it');
					}
				}
				if (id == null) {
					const created = await createVariable(saved, v);
					id = created.id;
					saved = created.spec;
				} else if (isChanged || finalAction === 'update') {
					await d.beastmodes.updateBeastMode(c, id, saved);
				}
				if (saved.name !== v.name) notes.push(`named "${saved.name}": Domo variable names are unique on the instance`);
				setEntry(state, ref, { id, hash, extra: { legacyId: v.legacyId, name: saved.name, createdBy: ownedElsewhere ? owner : slug, ...(adopted ? { adopted: true } : {}) } });
				const defaultControl = await d.variables.upsertDefaultControl(c, id, { ...control, name: saved.name });
				if (defaultControl?.id != null) setEntry(state, ref, { extra: { defaultControlId: defaultControl.id } });
				await record({ ...base, name: saved.name, action: finalAction, id, status: 'ok', notes });
			} catch (err) {
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
			}
		}
	}

	/**
	 * Update a t2d card; on a 500, drop its card formulas that depend on a deleted template (a variable recreated after
	 * another workspace's unpush deleted it), which the server cannot update ("template" is null), and retry once.
	 */
	async function updateCardDroppingStale(id, body, notes) {
		try {
			return await d.cards.updateCard(c, id, body);
		} catch (err) {
			if (err?.status !== 500 || !d.cards.getCardDefinition || !d.beastmodes.getBeastMode || !d.beastmodes.updateBeastMode) throw err;
			const current = await d.cards.getCardDefinition(c, id).catch(() => undefined);
			const missing = new Map();
			const exists = (tid) => d.beastmodes.getBeastMode(c, tid).then(() => true, (e) => e?.status !== 404);
			const stale = [];
			for (const f of current?.definition?.formulas ?? []) {
				if (f.persistedOnDataSource || f.templateId == null) continue;
				for (const dep of f.formulaDependencies ?? []) {
					if (!missing.has(dep)) missing.set(dep, !(await exists(dep)));
					if (missing.get(dep)) {
						stale.push(f);
						break;
					}
				}
			}
			if (!stale.length) throw err;
			const gone = [...missing].filter(([, isGone]) => isGone).map(([dep]) => dep);
			// Any valid expression frees the template: the card update then writes the planned formula.
			for (const f of stale) await d.beastmodes.updateBeastMode(c, f.templateId, { expression: 'MIN(1)' });
			notes.push(`cleared ${stale.length} card formula(s) that used a deleted template (${gone.join(', ')})`);
			return d.cards.updateCard(c, id, body);
		}
	}

	/** Create a variable, renaming it "<name> (Tableau)" when a variable t2d did not create has the name. */
	async function createVariable(spec, v) {
		const names = [spec.name, `${spec.name} (Tableau)`, ...[2, 3, 4, 5].map((n) => `${spec.name} (Tableau ${n})`)];
		let lastError;
		for (const name of names) {
			try {
				const created = await d.beastmodes.createBeastMode(c, { ...spec, name });
				return { id: idOf(created, 'id'), spec: { ...spec, name } };
			} catch (err) {
				const duplicate = isDuplicateVariableName(err) || (err?.status === 500 && (await d.variables.variableNameTaken(c, name).catch(() => false)));
				if (!duplicate) throw err;
				lastError = err;
			}
		}
		throw new Error(`Variable "${v.name}": every candidate name is taken on the instance (${errorMessage(lastError)})`);
	}

	const variablePlans = plan.variables ?? [];
	const columnNames = planColumns(plan);
	const variableId = (v) => (failed.has(`variable:${v.key}`) ? undefined : lookup(`variable:${v.key}`, 'id'));
	/** Swap variable references in beast mode SQL or a card body for DOMO_BEAST_MODE(<id>); throws when a variable is not pushed. */
	const withVariables = (value, datasetKey) => {
		if (!variablePlans.length) return value;
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		const columns = (dsByKey.get(datasetKey)?.schema ?? []).map((col) => col.name);
		const bound = bindVariables(text, variablePlans, variableId, { columns });
		if (bound.missing.length) {
			const refs = bound.missing.map((v) => `variable:${v.key}`);
			throw new DependencyError(`Depends on ${refs.map((r) => `${r} (${failed.has(r) ? 'failed or skipped' : 'not pushed yet'})`).join(', ')}`, refs);
		}
		if (bound.text === text) return value;
		return typeof value === 'string' ? bound.text : JSON.parse(bound.text);
	};

	timer.phase('beastmodes', kinds.has('beastmodes'));
	/* 4. Beast modes, validated in one batch per dataset. */
	const droppedFormulas = new Map();
	for (const bm of plan.beastModes ?? []) {
		if (bm.status === 'unsupported') droppedFormulas.set(bm.legacyId, bm);
	}
	if (kinds.has('beastmodes')) {
		const beastModes = (plan.beastModes ?? []).filter((bm) => writes('beastmode', bm.key));
		if (beastModes.length) emitter.step('Beast Modes');
		const byDataset = new Map();
		for (const bm of beastModes) {
			if (!byDataset.has(bm.datasetKey)) byDataset.set(bm.datasetKey, []);
			byDataset.get(bm.datasetKey).push(bm);
		}
		for (const [datasetKey, group] of byDataset) {
			await pushBeastModeGroup(datasetKey, group);
		}
	}

	async function pushBeastModeGroup(datasetKey, group) {
		const dsRef = `dataset:${datasetKey}`;
		const datasetId = failed.has(dsRef) ? undefined : lookup(dsRef, 'id');
		const pending = [];
		for (const bm of group) {
			const ref = `beastmode:${bm.key}`;
			const entry = getEntry(state, ref);
			const base = { kind: 'beastmode', key: bm.key, name: bm.name };
			if (bm.status === 'unsupported') {
				await record({ ...base, action: 'skip', id: entry?.id ?? null, status: 'skipped', error: 'Formula could not be translated (unsupported)' });
				continue;
			}
			if (datasetId === undefined) {
				droppedFormulas.set(bm.legacyId, bm);
				await record({ ...base, action: 'skip', id: entry?.id ?? null, status: 'skipped', error: `Depends on ${dsRef} (${failed.has(dsRef) ? 'failed or skipped' : 'not pushed yet'})` });
				continue;
			}
			let spec;
			try {
				spec = resolve({
					name: bm.name,
					expression: withVariables(bm.expression, datasetKey),
					legacyId: bm.legacyId,
					datasetId,
					dataType: bm.dataType,
					aggregated: bm.aggregated,
					global: false,
					variable: false
				});
			} catch (err) {
				droppedFormulas.set(bm.legacyId, bm);
				await record({ ...base, action: 'skip', id: entry?.id ?? null, status: 'skipped', error: errorMessage(err) });
				continue;
			}
			const hash = shortHash(spec);
			if (!changed(entry, hash)) {
				await record({ ...base, action: 'unchanged', id: entry.id, status: dryRun ? 'dry-run' : 'ok' });
				continue;
			}
			if (dryRun) {
				const notes = bm.status === 'approximate' ? ['approximate translation'] : [];
				notes.push('expression not validated in dry run');
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
				continue;
			}
			const relinked = entry?.extra?.datasetId != null && entry.extra.datasetId !== datasetId;
			pending.push({ bm, ref, entry: relinked ? undefined : entry, base, spec, hash });
		}
		if (!pending.length) return;

		let existingByLegacyId = new Map();
		if (pending.some((x) => !x.entry)) {
			try {
				const list = await d.beastmodes.listDatasetBeastModes(c, datasetId);
				existingByLegacyId = new Map((list ?? []).filter((t) => t?.legacyId).map((t) => [t.legacyId, t.id]));
			} catch (err) {
				emitter.warn(`Could not list existing beast modes on ${datasetKey}: ${errorMessage(err)}`);
			}
		}

		let results;
		try {
			results = await d.beastmodes.validateExpressions(
				c,
				datasetId,
				pending.map((x) => ({ key: x.bm.key, name: x.bm.name, expression: x.spec.expression }))
			);
		} catch (err) {
			for (const x of pending) {
				droppedFormulas.set(x.bm.legacyId, x.bm);
				await record({ ...x.base, action: x.entry ? 'update' : 'create', id: x.entry?.id ?? null, status: 'failed', error: `Validation call failed: ${errorMessage(err)}` });
			}
			return;
		}
		const get = (key) => (results instanceof Map ? results.get(key) : results?.[key]);
		for (const x of pending) {
			const verdict = get(x.bm.key);
			if (verdict && verdict.valid === false) {
				droppedFormulas.set(x.bm.legacyId, x.bm);
				summary.issues.push({
					severity: 'error',
					code: 'push.beastmode-invalid',
					message: `Beast mode "${x.bm.name}" failed Domo validation: ${verdict.message ?? 'invalid'}`,
					object: { type: 'beastmode', name: x.bm.name, id: x.bm.legacyId },
					suggestion: 'Fix the expression in plan.json (beastModes[].expression) and push again; cards using it were pushed without it.'
				});
				await record({ ...x.base, action: x.entry ? 'update' : 'create', id: x.entry?.id ?? null, status: 'failed', error: `Invalid expression: ${verdict.message ?? 'rejected by validateFunctions'}` });
				continue;
			}
			try {
				const spec = verdict?.dataType && !x.spec.dataType ? { ...x.spec, dataType: verdict.dataType } : x.spec;
				let id = x.entry?.id ?? existingByLegacyId.get(x.bm.legacyId);
				const action = id != null ? 'update' : 'create';
				if (id != null) await d.beastmodes.updateBeastMode(c, id, spec);
				else id = idOf(await d.beastmodes.createBeastMode(c, spec), 'id');
				setEntry(state, x.ref, { id, hash: x.hash, extra: { legacyId: x.bm.legacyId, datasetId } });
				await record({ ...x.base, action, id, status: 'ok', notes: x.bm.status === 'approximate' ? ['approximate translation'] : [] });
			} catch (err) {
				droppedFormulas.set(x.bm.legacyId, x.bm);
				await record({ ...x.base, action: x.entry ? 'update' : 'create', id: x.entry?.id ?? null, status: 'failed', error: errorMessage(err) });
			}
		}
	}

	/* 5a. App (target 'app'): the workbook's App Studio app. */
	const appRef = asApp && plan.app ? `app:${plan.app.key}` : null;
	/** The app as last read or written, so views can be checked against it. */
	let appCurrent = null;
	timer.phase('app', Boolean(appRef && kinds.has('app')));
	if (appRef && kinds.has('app') && writes('app', plan.app.key)) {
		emitter.step('App');
		await pushApp(plan.app);
	}

	/** Forget the state entries of an app deleted outside t2d, so push recreates it with its views and layouts. */
	function forgetApp(appId) {
		for (const [ref, e] of Object.entries(state.objects)) {
			if (!ref.startsWith('page:') || e?.extra?.container !== 'app' || String(e.extra.appId) !== String(appId)) continue;
			delete state.objects[ref];
			delete state.objects[`layout:${ref.slice('page:'.length)}`];
			delete state.objects[`filterview:${ref.slice('page:'.length)}`];
		}
		delete state.objects[`navigation:${plan.app.key}`];
		delete state.objects[appRef];
	}

	/** The built-in theme to write, cloned with the plan's workbook formatting, t2d's control spacing and the item styles. */
	async function resolveTheme(appId, name, notes) {
		const found = findTheme(await d.apps.listThemes(c, appId), name);
		if (found) {
			const overrides = plan.app.theme?.overrides;
			const { theme, notes: themeNotes } = applyThemeOverrides(found, overrides);
			if (overrides) notes.push('theme with the workbook formatting', ...themeNotes);
			const spaced = applyControlSpacing(theme, { control: overrides?.control, images: hasImages });
			notes.push(...spaced.notes);
			const styled = applyItemStyles(spaced.theme, plan.app.theme?.itemStyles, found);
			notes.push(...styled.notes);
			const filled = applySectionFills(styled.theme, sectionFills);
			notes.push(...filled.notes);
			if (Object.keys(styled.ids).length) notes.push(`item styles ${[...new Set(Object.values(styled.ids))].join(', ')}`);
			if (styled.merged.length) {
				summary.issues.push({ severity: 'info', code: 'push.item-styles-merged', message: `${styled.merged.length} of the workbook's zone styles share another's card style: they differ only by border color and theme "${found.name}" has no free card style left for them (App Studio keeps 8)`, object: { type: 'app', name: plan.app.title } });
			}
			if (styled.skipped.length) {
				summary.issues.push({ severity: 'info', code: 'push.item-styles-full', message: `${styled.skipped.length} of the workbook's ${plan.app.theme.itemStyles.length} zone styles have no free card or table style in theme "${found.name}" (App Studio keeps 8 card and 3 table styles), so their cards use the default style`, object: { type: 'app', name: plan.app.title } });
			}
			const images = appCurrent?.theme?.images;
			return { theme: images?.length ? { ...filled.theme, images } : filled.theme, itemStyleIds: styled.ids };
		}
		notes.push(`theme "${name}" not found; kept the current theme`);
		summary.issues.push({ severity: 'warning', code: 'push.app-theme-missing', message: `Theme "${name}" is not a built-in or saved theme on ${instance}; the app keeps its current theme`, object: { type: 'app', name: plan.app.title } });
		return {};
	}

	/** Points `theme` at the plan's palette, created or updated; with none, t2d's earlier palette is deleted. */
	async function writePalette(appId, theme, entry, notes) {
		const planned = plan.app.theme?.palette;
		const previous = entry?.extra?.paletteId;
		if (!planned) {
			if (previous) {
				await d.apps.deleteAppPalette(c, previous).catch((err) => {
					if (err?.status !== 404) throw err;
				});
				notes.push('app chart palette removed');
			}
			return null;
		}
		const body = { name: `Tableau ${planned.name}`, json: paletteJson(planned.colors) };
		let id = previous;
		if (id) {
			try {
				await d.apps.updateAppPalette(c, id, appId, body);
			} catch (err) {
				if (err?.status !== 404) throw err;
				id = undefined;
			}
		}
		if (!id) id = (await d.apps.createAppPalette(c, appId, body))?.id;
		if (id == null) throw new Error('the app chart palette was created without an id');
		theme.chartColorPalette = { id, type: 'APP' };
		notes.push(`chart palette ${planned.name} (${planned.colors.length} colors)`);
		return id;
	}

	/** A palette that fails leaves the theme without one, so the app (already created) still gets its theme. */
	async function safePalette(appId, theme, entry, notes) {
		try {
			return await writePalette(appId, theme, entry, notes);
		} catch (err) {
			delete theme.chartColorPalette;
			summary.issues.push({ severity: 'warning', code: 'push.app-palette-failed', message: `The app chart palette was not written (${errorMessage(err)}), so the cards use the theme's chart colors`, object: { type: 'app', name: plan.app.title }, suggestion: 'Push again with --workbook-theme.' });
			return null;
		}
	}

	/** Domo drops a palette it cannot find without an error. */
	function checkPalette(saved, paletteId) {
		if (paletteId == null || String(saved?.theme?.chartColorPalette?.id ?? '') === String(paletteId)) return;
		summary.issues.push({ severity: 'warning', code: 'push.app-palette-dropped', message: `The app theme was saved without its chart palette ${paletteId}, so the cards use the default chart colors`, object: { type: 'app', name: plan.app.title }, suggestion: 'Push again with --workbook-theme.' });
	}

	async function pushApp(app) {
		const ref = appRef;
		let entry = getEntry(state, ref);
		const base = { kind: 'app', key: app.key, name: app.title };
		const notes = [];
		const settings = { title: app.title, description: app.description, navigation: app.navigation };
		const settingsHash = shortHash(settings);
		const themeName = app.theme?.base;
		const themeHash = shortHash(app.theme ?? {});
		const explicitTheme = Boolean(plan.options?.theme) || plan.options?.workbookTheme === true;
		try {
			if (dryRun) {
				const settingsChanged = force || entry?.extra?.settingsHash !== settingsHash;
				const themeChanged = explicitTheme && (force || entry?.extra?.themeHash !== themeHash);
				if (!entry) {
					const extras = [app.theme?.overrides && ' with the workbook formatting', app.theme?.palette && `, chart palette ${app.theme.palette.name}`, app.theme?.itemStyles?.length && `, ${app.theme.itemStyles.length} item style(s)`].filter(Boolean).join('');
					notes.push(`theme ${themeName}${extras}, navigation ${app.navigation.orientation}`);
				}
				else if (themeChanged) notes.push(`theme set to ${themeName}`);
				else if (entry.extra?.controlSpacing !== spacingMark) notes.push('control and section spacing set on the app theme where it differs');
				await record({ ...base, action: !entry ? 'create' : settingsChanged || themeChanged ? 'update' : 'unchanged', id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
				return;
			}
			if (entry) {
				try {
					appCurrent = await d.apps.getApp(c, entry.id);
				} catch (err) {
					if (err?.status !== 404) throw err;
					notes.push(`app ${entry.id} was deleted outside t2d; recreated with its views`);
					forgetApp(entry.id);
					entry = undefined;
				}
			}
			if (!entry) {
				const { theme, itemStyleIds } = themeName ? await resolveTheme(undefined, themeName, notes) : {};
				let created;
				try {
					created = await d.apps.createApp(c, { title: app.title, description: app.description, navigation: app.navigation, theme });
				} catch (err) {
					if (err?.status === 403 || err?.status === 404) {
						summary.issues.push({ severity: 'error', code: 'push.app-unavailable', message: `Creating the app was refused (HTTP ${err.status}): App Studio is unavailable to this user, which needs the content.dataapp.edit and content.page.edit grants`, object: { type: 'app', name: app.title }, suggestion: 'Grant those rights, or convert again with --target pages.' });
					}
					throw err;
				}
				setEntry(state, ref, { id: created.id, extra: { title: app.title, defaultViewId: created.defaultViewId ?? null } });
				await checkpoint();
				const paletteId = theme ? await safePalette(created.id, theme, undefined, notes) : null;
				if (paletteId == null && hasAppSettings(created.app, settings, theme)) appCurrent = created.app;
				else {
					const current = await d.apps.getApp(c, created.id);
					const merged = mergeAppSettings(current, settings, theme);
					appCurrent = (await d.apps.updateApp(c, created.id, merged)) ?? merged;
				}
				checkPalette(appCurrent, paletteId);
				setEntry(state, ref, { extra: { settingsHash, themeHash, ...(theme ? { controlSpacing: spacingMark, itemStyleIds, paletteId } : {}) } });
				if (theme) notes.push(`theme ${theme.name}`);
				await record({ ...base, action: 'create', id: created.id, status: 'ok', notes });
				return;
			}
			const settingsChanged = force || entry.extra?.settingsHash !== settingsHash;
			const themeChanged = explicitTheme && (force || entry.extra?.themeHash !== themeHash);
			const spacing = !themeChanged && entry.extra?.controlSpacing !== spacingMark && appCurrent?.theme ? applyControlSpacing(appCurrent.theme, { images: hasImages }) : undefined;
			const filled = !themeChanged && sectionFills.length && appCurrent?.theme ? applySectionFills(spacing?.theme ?? appCurrent.theme, sectionFills) : undefined;
			if (!settingsChanged && !themeChanged && !spacing?.changed && !filled?.changed) {
				if (spacing) setEntry(state, ref, { extra: { controlSpacing: spacingMark } });
				await record({ ...base, action: 'unchanged', id: entry.id, status: 'ok', ...(spacing?.notes.length ? { notes: spacing.notes } : {}) });
				return;
			}
			const { theme, itemStyleIds } = themeChanged ? await resolveTheme(entry.id, themeName, notes) : {};
			const paletteId = theme ? await safePalette(entry.id, theme, entry, notes) : undefined;
			if (spacing) notes.push(...spacing.notes, ...(spacing.changed ? ['control and section spacing set on the app theme'] : []));
			if (filled) notes.push(...filled.notes, ...(filled.changed ? [`section style(s) for the title fill(s) ${sectionFills.join(', ')} set on the app theme`] : []));
			const merged = mergeAppSettings(appCurrent, settings, theme ?? (filled?.changed ? filled.theme : spacing?.changed ? spacing.theme : undefined));
			appCurrent = (await d.apps.updateApp(c, entry.id, merged)) ?? merged;
			if (theme) checkPalette(appCurrent, paletteId);
			if (theme) {
				// clearStyleOverride resets every view of the app, so it waits until no view is someone else's.
				const ours = new Set(Object.values(state.objects).filter((e) => e?.extra?.container === 'app' && String(e.extra.appId) === String(entry.id)).map((e) => String(e.id)));
				const foreign = appViewIds(appCurrent).filter((id) => !ours.has(String(id)));
				if (foreign.length) notes.push(`style overrides of the views were kept: the app has ${foreign.length} view(s) t2d did not create`);
				else await d.apps.clearStyleOverride(c, entry.id);
				notes.push(`theme set to ${theme.name}`);
			}
			if (entry.extra?.title !== undefined && entry.extra.title !== app.title) notes.push(`renamed from "${entry.extra.title}"`);
			setEntry(state, ref, { extra: { title: app.title, settingsHash, ...(theme ? { themeHash, itemStyleIds, paletteId } : {}), ...(theme || spacing ? { controlSpacing: spacingMark } : {}) } });
			await record({ ...base, action: 'update', id: entry.id, status: 'ok', notes });
		} catch (err) {
			await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: 'failed', error: errorMessage(err), notes });
		}
	}

	/** Views of the app (target 'app'), in navigation order. The first new view takes over the app's default view. */
	async function pushViews(views) {
		const appEntryId = appRef ? getEntry(state, appRef)?.id : undefined;
		let appGone = false;
		if (!dryRun && !appCurrent && appEntryId != null) {
			appCurrent = await d.apps.getApp(c, appEntryId).catch((err) => {
				appGone = err?.status === 404;
				return null;
			});
		}
		if (appGone) {
			summary.issues.push({ severity: 'error', code: 'push.app-missing', message: `App ${appEntryId} of "${plan.app.title}" no longer exists in Domo (deleted outside t2d), so its views were not pushed`, object: { type: 'app', name: plan.app.title }, suggestion: 'Push again including the app (no --only or --keys that leave it out); t2d then recreates it with its views.' });
			for (const view of views) {
				const entry = getEntry(state, `page:${view.key}`);
				await record({ kind: 'page', key: view.key, name: view.title, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: 'failed', error: `app ${appEntryId} was deleted outside t2d; push with the app included to recreate it` });
			}
			return;
		}
		const inApp = (id) => !Array.isArray(appCurrent?.views) || appViewIds(appCurrent).some((v) => String(v) === String(id));
		let defaultTaken = false;
		for (const view of views) {
			const ref = `page:${view.key}`;
			let entry = getEntry(state, ref);
			const base = { kind: 'page', key: view.key, name: view.title };
			const notes = [];
			try {
				const appId = resolve({ $ref: `app:${view.appKey}` });
				const desired = { navOrder: view.navOrder ?? null, hidden: Boolean(view.hidden), linked: view.linked ? true : undefined, navIcon: view.navIcon };
				if (entry && !dryRun && !inApp(entry.id)) {
					notes.push(`view ${entry.id} is no longer in the app; recreated`);
					recreatedViews.add(view.key);
					delete state.objects[ref];
					delete state.objects[`layout:${view.key}`];
					delete state.objects[`filterview:${view.key}`];
					entry = undefined;
				}
				if (entry) {
					const renamed = entry.extra?.title !== undefined && entry.extra.title !== view.title;
					if (!dryRun) {
						if (renamed) await d.apps.renameView(c, appId, entry.id, view.title);
						setEntry(state, ref, { extra: { title: view.title, ...desired } });
					}
					if (renamed) notes.push(`renamed from "${entry.extra.title}"`);
					await record({ ...base, action: renamed ? 'update' : 'unchanged', id: entry.id, status: dryRun ? 'dry-run' : 'ok', notes });
					continue;
				}
				const appEntry = getEntry(state, `app:${view.appKey}`);
				const defaultId = appEntry?.extra?.defaultViewId;
				const claimed =
					defaultId == null ||
					Object.values(state.objects).some((e) => e?.extra?.container === 'app' && String(e.id) === String(defaultId)) ||
					(!dryRun && !inApp(defaultId));
				if (dryRun) {
					const reuse = !defaultTaken && (!appEntry || !claimed);
					defaultTaken ||= reuse;
					let id;
					if (reuse && appEntry) dryIds.set(ref, (id = defaultId));
					else id = placeholder(ref);
					await record({ ...base, action: 'create', id, status: 'dry-run', notes: [...notes, reuse ? 'takes over the default view of the app' : 'new view'] });
					continue;
				}
				let id;
				let layoutId;
				if (!claimed) {
					await d.apps.renameView(c, appId, defaultId, view.title);
					id = defaultId;
					notes.push('took over the default view of the app');
				} else {
					({ viewId: id, layoutId } = await d.apps.createView(c, appId, { title: view.title }));
				}
				setEntry(state, ref, { id, extra: { appId, title: view.title, container: 'app', ...desired, ...(layoutId != null ? { layoutId } : {}) } });
				await record({ ...base, action: 'create', id, status: 'ok', notes });
			} catch (err) {
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
			}
		}
	}

	timer.phase(asApp ? 'views' : 'pages', kinds.has('pages'));
	/* 5. Pages: workbook root, then one subpage per dashboard. Target 'app': the app's views. */
	if (kinds.has('pages') && asApp) {
		const views = (plan.pages ?? []).filter((pg) => writes('page', pg.key)).sort((a, b) => (a.navOrder ?? Infinity) - (b.navOrder ?? Infinity));
		if (views.length) emitter.step('Views');
		await pushViews(views);
	} else if (kinds.has('pages')) {
		const pages = sortPages(plan.pages ?? []).filter((pg) => writes('page', pg.key));
		if (pages.length) emitter.step('Pages');
		for (const page of pages) {
			const ref = `page:${page.key}`;
			const entry = getEntry(state, ref);
			const base = { kind: 'page', key: page.key, name: page.title };
			const notes = [];
			try {
				let parent;
				if (page.parentKey) {
					parent = resolve({ $ref: `page:${page.parentKey}` });
				} else if (parentPageId != null && parentPageId !== '') {
					parent = parentPageId;
				}
				if (entry) {
					if (String(entry.extra?.parentPageId ?? '') !== String(parent ?? '')) notes.push('parent differs from the first push; move the page manually if needed');
					const renamed = entry.extra?.title !== undefined && entry.extra.title !== page.title;
					if (renamed && !dryRun) {
						await d.pages.updatePage(c, entry.id, { title: page.title });
						setEntry(state, ref, { extra: { title: page.title } });
					} else if (entry.extra?.title === undefined && !dryRun) {
						setEntry(state, ref, { extra: { title: page.title } });
					}
					if (renamed) notes.push(`renamed from "${entry.extra.title}"`);
					await record({ ...base, action: renamed ? 'update' : 'unchanged', id: entry.id, status: dryRun ? 'dry-run' : 'ok', notes });
					continue;
				}
				if (dryRun) {
					await record({ ...base, action: 'create', id: placeholder(ref), status: 'dry-run', notes: [...notes, parent != null ? `under ${parent}` : 'top level'] });
					continue;
				}
				const id = idOf(await d.pages.createPage(c, { title: page.title, ...(parent != null ? { parentPageId: parent } : {}) }), 'pageId', 'id');
				if (id == null) throw new Error('createPage returned no id');
				setEntry(state, ref, { id, extra: { parentPageId: parent ?? null, title: page.title } });
				await record({ ...base, action: 'create', id, status: 'ok', notes });
			} catch (err) {
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
			}
		}
	}

	timer.phase('cards', kinds.has('cards'));
	/* 6. Cards, one at a time. */
	if (kinds.has('cards')) {
		for (const bm of plan.beastModes ?? []) {
			const ref = `beastmode:${bm.key}`;
			if (!getEntry(state, ref) && !dryIds.has(ref)) droppedFormulas.set(bm.legacyId, bm);
		}
		const dropped = new Set(droppedFormulas.keys());
		for (const card of (plan.cards ?? []).filter((x) => x.split && writes('card', x.key))) await resolveSplit(card, dropped);
		const cards = (plan.cards ?? []).filter((card) => writes('card', card.key));
		if (cards.length) emitter.step('Cards');
		for (const card of cards) {
			const ref = `card:${card.key}`;
			const entry = getEntry(state, ref);
			const base = { kind: 'card', key: card.key, name: card.title };
			const notes = [];
			if (card.status === 'unsupported' && card.replacedBy) {
				const merged = card.replacedBy === 'stack' ? (plan.cards ?? []).find((c) => c.key === card.stackedInto) : undefined;
				const replaced = { notebook: 'the sheet is now a text card', stack: `the sheet is part of the merged table ${merged?.title ?? ''}`.trim() }[card.replacedBy] ?? `the sheet is now a ${card.replacedBy}`;
				if (entry) await retireCard(ref, entry, base, replaced);
				else await record({ ...base, action: 'skip', id: null, status: 'skipped', notes: [`not a card of its own: ${replaced}`] });
				continue;
			}
			if (card.status === 'unsupported') {
				if (entry) notes.push('kept the card an earlier push created; delete it in Domo if it is no longer wanted');
				await record({ ...base, action: 'skip', id: entry?.id ?? null, status: 'skipped', error: 'Card could not be converted (unsupported); see the report', notes });
				continue;
			}
			if (card.kind === 'notebook') {
				await pushNotebook(card, entry, base, notes);
				continue;
			}
			if (card.kind === 'image') {
				await (card.section ? pushSectionImage : pushImage)(card, entry, base, notes);
				continue;
			}
			const emptyDataset = [...collectRefs(card.body)].find((r) => noData.has(r));
			if (emptyDataset) {
				await record({ ...base, action: 'skip', id: entry?.id ?? null, status: 'skipped', error: `Not created: the ${noData.get(emptyDataset)}` });
				continue;
			}
			try {
				const [body, removed] = dropped.size ? stripFormulaRefs(card.body, dropped) : [card.body, 0];
				if (removed) {
					const names = [...dropped].filter((id) => JSON.stringify(card.body).includes(id)).map((id) => droppedFormulas.get(id)?.name ?? id);
					const emptied = Object.entries(body.definition?.subscriptions ?? {}).filter(([, s]) => !(s?.columns ?? []).length);
					if (emptied.length) {
						await record({ ...base, action: 'skip', id: entry?.id ?? null, status: 'skipped', error: `Not created: without beast mode(s) ${names.join(', ')}, its ${emptied.map(([k]) => k).join(', ')} query has no columns` });
						continue;
					}
					notes.push(`pushed without beast mode(s): ${names.join(', ')}`);
					summary.issues.push({
						severity: 'warning',
						code: 'push.card-missing-beastmode',
						message: `Card "${card.title}" was pushed without ${names.join(', ')}`,
						object: { type: 'card', name: card.title, id: card.worksheet },
						suggestion: 'Fix the beast mode, push again, and re-add the field to the card.'
					});
				}
				const resolved = resolve(withVariables(withVariableControls(body, dropped), card.datasetKey));
				const pageKey = (card.pageKeys ?? []).find((k) => lookup(`page:${k}`, 'id') !== undefined);
				const pageId = pageKey ? lookup(`page:${pageKey}`, 'id') : undefined;
				if ((card.pageKeys ?? []).length > 1) notes.push(`also placed on ${card.pageKeys.length - 1} other page(s) through layouts`);
				const bigNumber = card.bigNumber ? resolve(withVariables(dropped.size ? stripFormulaRefs(card.bigNumber, dropped)[0] : card.bigNumber, card.datasetKey)) : undefined;
				const full = withBigNumber(resolved, bigNumber);
				const hash = shortHash(full);
				const isChanged = changed(entry, hash);
				const action = entry ? (isChanged ? 'update' : 'unchanged') : 'create';
				if (card.status === 'approximate') notes.push('approximate conversion');
				const drillViews = drillViewBodies(card, dropped, hash);
				if (dryRun) {
					const drill = drillDryRun(entry, drillViews);
					if (drill) notes.push(drill.note);
					await record({ ...base, action: action === 'unchanged' && drill?.changed ? 'update' : action, id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
					continue;
				}
				let id = entry?.id;
				if (!entry) {
					const created = await d.cards.createCard(c, resolved, pageId != null ? { pageId } : {});
					id = idOf(created, 'id');
					if (id == null) throw new Error('createCard returned no id');
					setEntry(state, ref, { id, extra: { urn: created?.urn ?? String(id), pageId: pageId ?? null } });
					await checkpoint();
					const shown = d.cards.cardTitle?.(created?.response?.definition);
					if (shown !== undefined && shown.replace(/\s+/g, '') !== card.title.replace(/\s+/g, '')) notes.push(`Domo shows the title "${shown}"`);
					if (bigNumber) await applySummaryNumber(id, resolved, bigNumber);
				} else if (isChanged) {
					await updateCardDroppingStale(id, bigNumber && d.cards.applyBigNumber ? resolved : full, notes);
					if (bigNumber && d.cards.applyBigNumber) await applySummaryNumber(id, resolved, bigNumber);
				}
				setEntry(state, ref, { id, hash, ...(card.splitOf ? { extra: { splitOf: card.splitOf } } : {}) });
				const drillChanged = await syncDrillViews(card, ref, id, drillViews, notes);
				const text = JSON.stringify([full, ...drillViews.map((v) => v.body)]);
				for (const f of plan.beastModes ?? []) if (f.legacyId && getEntry(state, `beastmode:${f.key}`) && text.includes(f.legacyId)) used.add(`beastmode:${f.key}`);
				for (const v of variablePlans) if (getEntry(state, `variable:${v.key}`) && mentions(JSON.stringify(body), v, { columns: columnNames })) used.add(`variable:${v.key}`);
				await record({ ...base, action: action === 'unchanged' && drillChanged ? 'update' : action, id, status: 'ok', notes });
			} catch (err) {
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
			}
		}
		if (wholePlan) {
			const planned = new Set((plan.cards ?? []).map((card) => `card:${card.key}`));
			const stale = Object.entries(state.objects).filter(([ref, entry]) => ref.startsWith('card:') && !planned.has(ref) && (entry.extra?.workbooks ?? []).includes(slug));
			for (const [ref, entry] of stale) {
				const others = entry.extra.workbooks.filter((w) => w !== slug);
				if (others.length) {
					if (!dryRun) setEntry(state, ref, { extra: { workbooks: others } });
					continue;
				}
				await retireCard(ref, entry, { kind: 'card', key: ref.slice('card:'.length), name: ref.slice('card:'.length) }, 'no longer in the plan');
			}
		}
	}

	/** A drill view hash covers its card's: a card write can renumber the card formulas a drill view carries. */
	function drillViewBodies(card, dropped, rootHash) {
		return (card.drillPath ?? []).map((view) => {
			const body = dropped.size ? stripFormulaRefs(view.body, dropped)[0] : view.body;
			const resolved = resolve(withVariables(withVariableControls(body, dropped), card.datasetKey));
			return { field: view.grain ? `${view.field}:${view.grain}` : view.field, title: view.title, body: resolved, hash: shortHash([rootHash, resolved]) };
		});
	}

	function sameDrillLevels(known, views) {
		return known.length === views.length && known.every((k, i) => k.field === views[i].field);
	}

	function drillDryRun(entry, views) {
		const known = entry?.extra?.drillViews ?? [];
		if (!views.length && !known.length) return undefined;
		if (!views.length) return { changed: true, note: `would delete its ${known.length} drill view(s)` };
		if (sameDrillLevels(known, views)) {
			const changed = views.filter((v, i) => v.hash !== known[i].hash).length;
			return { changed: changed > 0, note: changed ? `would update ${changed} of its ${views.length} drill view(s)` : `its ${views.length} drill view(s) are unchanged` };
		}
		return { changed: true, note: `would ${known.length ? `replace its ${known.length} drill view(s) with` : 'create'} ${views.length} drill view(s): ${views.map((v) => v.title).join(', ')}` };
	}

	/**
	 * A click on the card filters its drill view by the clicked values, also of the card's own formulas (a date part),
	 * under the formula ids Domo saved on the card; the drill view needs those formulas to read the filter, or it shows
	 * no rows (as Analyzer saves a drill view with its parent's formulas).
	 */
	async function withParentFormulas(card, rootId, views) {
		if (!views.length || !card.body?.definition?.formulas?.card?.length || !d.cards.getCardDefinition) return views;
		const formulas = (await d.cards.getCardDefinition(c, rootId))?.definition?.formulas;
		const saved = (Array.isArray(formulas) ? formulas : (formulas?.card ?? [])).filter((f) => !f.persistedOnDataSource && f.id);
		if (!saved.length) return views;
		return views.map((v) => {
			const own = v.body.definition.formulas?.card ?? [];
			const ids = new Set(own.map((f) => f.id));
			const body = { ...v.body, definition: { ...v.body.definition, formulas: { ...v.body.definition.formulas, card: [...own, ...saved.filter((f) => !ids.has(f.id))] } } };
			return { ...v, body };
		});
	}

	/**
	 * Create, update or replace the drill views t2d made under a card, in drill order. Views another person added stay;
	 * ids in the state that Domo no longer has are forgotten. Returns whether anything was written.
	 */
	async function syncDrillViews(card, ref, rootId, views, notes) {
		const known = getEntry(state, ref)?.extra?.drillViews ?? [];
		if (!views.length && !known.length) return false;
		const save = async (list) => {
			setEntry(state, ref, { extra: { drillViews: list } });
			await checkpoint();
		};
		try {
			const live = new Set((await d.cards.listDrillViews(c, rootId)).map((v) => String(v.id)));
			const kept = known.filter((k) => live.has(String(k.id)));
			if (!views.length && !kept.length) {
				await save(undefined);
				return false;
			}
			if (views.length && sameDrillLevels(kept, views)) {
				const stale = views.map((v, i) => [v, kept[i]]).filter(([v, k]) => v.hash !== k.hash);
				const bodies = stale.length ? await withParentFormulas(card, rootId, stale.map(([v]) => v)) : [];
				for (const [i, [, k]] of stale.entries()) await d.cards.updateDrillView(c, rootId, k.id, bodies[i].body);
				if (stale.length || kept.length !== known.length) await save(views.map((v, i) => ({ id: kept[i].id, field: v.field, hash: v.hash })));
				if (stale.length) notes.push(`updated ${stale.length} of its ${views.length} drill view(s)`);
				return stale.length > 0;
			}
			for (const k of [...kept].reverse()) {
				await d.cards.deleteCard(c, k.id).catch((err) => {
					if (err?.status !== 404) throw err;
				});
			}
			if (known.length) await save(undefined);
			const created = [];
			for (const v of await withParentFormulas(card, rootId, views)) {
				const view = await d.cards.createDrillView(c, rootId, v.body);
				created.push({ id: view.id, field: v.field, hash: v.hash });
				await save(created);
			}
			notes.push(views.length ? `${kept.length ? `replaced its ${kept.length} drill view(s) with` : 'created'} ${views.length} drill view(s): ${views.map((v) => v.title).join(', ')}` : `deleted its ${kept.length} drill view(s)`);
			return true;
		} catch (err) {
			notes.push(`drill path not complete: ${errorMessage(err)}`);
			summary.issues.push({
				severity: 'warning',
				code: 'push.card-drill-path',
				message: `Card "${card.title}" has no complete drill path: ${errorMessage(err)}`,
				object: { type: 'card', name: card.title, id: card.worksheet },
				suggestion: 'Push the card again.'
			});
			return true;
		}
	}

	/** Expand a split card into its member cards, reading the members from the dataset under the card's filters. */
	async function resolveSplit(card, dropped) {
		const keep = (reason) => {
			summary.issues.push({
				severity: 'warning',
				code: 'push.card-split',
				message: `Card "${card.title}" kept as one card (${reason}); Tableau draws one pane per ${card.split.name}`,
				object: { type: 'card', name: card.title, id: card.worksheet }
			});
			delete card.split;
		};
		if (dryRun || !d.cards.previewMembers) return;
		let members;
		try {
			const body = dropped.size ? stripFormulaRefs(card.body, dropped)[0] : card.body;
			members = await d.cards.previewMembers(c, resolve(withVariables(withVariableControls(body, dropped), card.datasetKey)), card.split.ref);
		} catch (err) {
			keep(`its ${card.split.name} members could not be read: ${errorMessage(err)}`);
			return;
		}
		const result = expandSplitCard(plan, card.key, members);
		if (!result.expanded) return keep(result.reason);
		if (result.keys.length > 1) summary.issues.push({
			severity: 'info',
			code: 'push.card-split',
			message: `Card "${card.title}" is ${result.keys.length} cards, one per ${card.split.name} with rows; a page filter can leave one of them empty`,
			object: { type: 'card', name: card.title, id: card.worksheet }
		});
	}

	/**
	 * Delete a card an earlier push created that the plan no longer places, unless a page or view t2d did not create
	 * shows it. Domo appends a page card a layout leaves out, so the layout write would never settle.
	 */
	async function retireCard(ref, entry, base, reason) {
		if (entry.extra?.adopted) {
			if (!dryRun) delete state.objects[ref];
			await record({ ...base, action: 'skip', id: entry.id, status: dryRun ? 'dry-run' : 'ok', notes: [`${reason}; the card was made in Domo, so t2d leaves it there and forgets it`] });
			return;
		}
		if (entry.extra?.section) {
			if (!dryRun) {
				await d.files.deleteDataFile(c, entry.extra.dataFileId ?? entry.id);
				delete state.objects[ref];
			}
			await record({ ...base, action: 'delete', id: entry.id, status: dryRun ? 'dry-run' : 'ok', notes: [`${reason}; the section background image file an earlier push uploaded is deleted`] });
			return;
		}
		const notes = [`${reason}; the card an earlier push created is deleted`];
		if (dryRun) {
			if (entry.extra?.kind === 'image' && entry.extra.dataFileId != null) notes.push(`and its image file ${entry.extra.dataFileId}`);
			await record({ ...base, action: 'delete', id: entry.id, status: 'dry-run', notes: [...notes, 'unless a page or view t2d did not create shows it (checked only on a real run), in which case it is kept'] });
			return;
		}
		try {
			const ours = new Set(Object.entries(state.objects).filter(([r]) => r.startsWith('page:')).map(([, e]) => String(e.id)));
			const foreign = d.cards.listCardPlacements ? (await d.cards.listCardPlacements(c, entry.id)).filter((p) => p.kind === 'report' || !ours.has(p.id)) : [];
			if (foreign.length) {
				const where = foreign.slice(0, 5).map((p) => `${p.kind} ${p.id}${p.title ? ` "${p.title}"` : ''}`).join(', ');
				summary.issues.push({
					severity: 'warning',
					code: 'push.card-foreign-placement',
					message: `Card "${base.name}" (${entry.id}) was not deleted: ${foreign.length} page(s) or view(s) t2d did not create show it (${where})`,
					suggestion: 'Remove the card from those pages or views, then push again.'
				});
				await record({ ...base, action: 'skip', id: entry.id, status: 'skipped', error: `shown on ${where}, which t2d did not create`, notes: [`${reason}; the card an earlier push created is kept`] });
				return;
			}
			await d.cards.deleteCard(c, entry.id);
		} catch (err) {
			if (err?.status !== 404) {
				await record({ ...base, action: 'delete', id: entry.id, status: 'failed', error: errorMessage(err), notes });
				return;
			}
		}
		if (entry.extra?.kind === 'image' && entry.extra.dataFileId != null) {
			try {
				await d.files.deleteDataFile(c, entry.extra.dataFileId);
				notes.push(`and its image file ${entry.extra.dataFileId}`);
			} catch (err) {
				notes.push(`its image file ${entry.extra.dataFileId} could not be deleted: ${errorMessage(err)}`);
			}
		}
		delete state.objects[ref];
		await record({ ...base, action: 'delete', id: entry.id, status: 'ok', notes });
	}

	/**
	 * Add a card variable control per variable the card uses (in its own formulas, its beast modes or its smart text). Pages re-render
	 * a card when a variable changes only if it has one. Card controls
	 * without an id replace the card's previous ones.
	 */
	function withVariableControls(body, dropped) {
		if (!variablePlans.length || !body?.definition) return body;
		const text = JSON.stringify(body);
		const sources = [text, ...(plan.beastModes ?? []).filter((bm) => !dropped.has(bm.legacyId) && text.includes(bm.legacyId)).map((bm) => bm.expression)];
		const usedVars = variablePlans.filter((v) => getEntry(state, `variable:${v.key}`) || dryIds.has(`variable:${v.key}`)).filter((v) => text.includes(`"variable:${v.key}"`) || sources.some((s) => mentions(s, v, { columns: columnNames })));
		if (!usedVars.length) return body;
		const controls = usedVars.map((v) => {
			const name = getEntry(state, `variable:${v.key}`)?.extra?.name ?? v.name;
			return { ...variableControl(v, { override: true }).control, name, id: null, function: { id: { $ref: `variable:${v.key}` } } };
		});
		const kept = (body.definition.controls ?? []).filter((x) => x?.controlType !== 'VARIABLE');
		return { ...body, definition: { ...body.definition, controls: [...kept, ...controls] } };
	}

	function variableControlSpecs(planned, rawContent) {
		const keyOf = new Map(rawContent.filter((i) => i.type === 'VARIABLE' && isRef(i.variableControlId)).map((i) => [i.contentKey, i.variableControlId.$ref.replace(/^variable:/, '')]));
		return planned.content
			.filter((item) => item.type === 'VARIABLE')
			.map((item) => {
				const key = keyOf.get(item.contentKey);
				// The control shows the Tableau parameter's caption even when the variable's name took a suffix.
				return { item, key, name: item.control?.name || getEntry(state, `variable:${key}`)?.extra?.name };
			});
	}

	/**
	 * Create or update a page control per VARIABLE layout item and point the item at it; an item whose control
	 * fails is left out of the layout. Mutates `planned`. Returns variable key -> page control id.
	 */
	async function placeVariableControls(pageId, planned, rawContent, known, notes) {
		const out = {};
		const dropped = new Set();
		for (const { item, key, name } of variableControlSpecs(planned, rawContent)) {
			try {
				const saved = await d.variables.upsertPageControl(c, pageId, item.variableControlId, { ...item.control, ...(name ? { name } : {}) }, { id: known[key] });
				if (saved?.id == null) throw new Error('no control id returned');
				out[key] = saved.id;
				item.variableControlId = saved.id;
				delete item.control;
			} catch (err) {
				dropped.add(item.contentKey);
				notes.push(`left out the control of variable:${key}: ${errorMessage(err)}`);
			}
		}
		if (dropped.size) {
			planned.content = planned.content.filter((i) => !dropped.has(i.contentKey));
			const kept = (template) => template.filter((x) => !dropped.has(x.contentKey)).map((x) => ({ ...x, ...(x.children ? { children: kept(x.children) } : {}) }));
			const tiled = finishLayout(planned.content, kept(planned.standard.template), kept(planned.compact.template));
			planned.standard.template = tiled.standard.template;
			planned.compact.template = tiled.compact.template;
		}
		return out;
	}

	/**
	 * A header text card the view already shows that t2d did not create, with the same text (made in Domo, as the user's
	 * Demand Management title): used instead of t2d's own, never changed or deleted. True when it handled the card.
	 */
	async function adoptTextCard(card, entry, base, notes) {
		const ref = `card:${card.key}`;
		if (entry?.extra?.adopted) {
			const [live] = d.cards.getCardSummaries ? await d.cards.getCardSummaries(c, [entry.id]) : [{}];
			if (live && live.active !== false) {
				adoptedImages.add(String(entry.id));
				await record({ ...base, action: 'unchanged', id: entry.id, status: 'ok', notes: [...notes, 'shows the text card made in Domo on this view; t2d does not change or delete it'] });
				return true;
			}
			notes.push(`the text card ${entry.id} made in Domo is gone; t2d makes its own`);
			delete state.objects[ref];
			entry = undefined;
		}
		const pageKey = (card.pageKeys ?? []).find((k) => lookup(`page:${k}`, 'id') !== undefined);
		const pageId = pageKey ? lookup(`page:${pageKey}`, 'id') : undefined;
		if (pageId == null || !d.pages.getLayoutByPage || !d.cards.getCardSummaries) return false;
		const text = (paragraphs) => paragraphs.map((p) => p.map((seg) => seg.text ?? '').join('')).join('\n').replace(/\s+/g, ' ').trim().toLowerCase();
		const want = text(card.body.notebook.paragraphs);
		let theirs;
		try {
			// A card adopted under a key the plan no longer has (a .header. zone now .text.) is the user's again.
			const planned = new Set((fullPlan.cards ?? []).map((k) => `card:${k.key}`));
			const ours = new Set(Object.entries(state.objects).filter(([r, e]) => r.startsWith('card:') && (planned.has(r) || !e?.extra?.adopted)).map(([, e]) => String(e.id)));
			const layout = await d.pages.getLayoutByPage(c, pageId);
			const ids = [...new Set((layout?.content ?? []).filter((i) => i.type === 'CARD' && i.cardId != null).map((i) => String(i.cardId)))].filter((id) => !ours.has(id) && !adoptedImages.has(id));
			theirs = (ids.length ? await d.cards.getCardSummaries(c, ids) : []).find((live) => {
				if (String(live?.type ?? '').toLowerCase() !== 'text') return false;
				let markup;
				try {
					markup = JSON.parse(live.metadata?.tagMarkup ?? '{}');
				} catch {
					return false;
				}
				return text([[{ text: String(markup.text ?? '') }]]) === want;
			});
		} catch (err) {
			notes.push(`could not check the view for a text card made in Domo: ${errorMessage(err)}`);
			return false;
		}
		if (!theirs) return false;
		if (entry) {
			await d.cards.deleteCard(c, entry.id).catch((err) => {
				if (err?.status !== 404) throw err;
			});
			notes.push(`deleted the text card ${entry.id} an earlier push created`);
		}
		adoptedImages.add(String(theirs.id));
		delete state.objects[ref];
		setEntry(state, ref, { id: theirs.id, extra: { kind: 'notebook', adopted: true, pageId } });
		notes.push(`uses the text card ${theirs.id}${theirs.title ? ` "${theirs.title}"` : ''} made in Domo on this view (the same text); t2d does not change or delete it`);
		await record({ ...base, action: 'reuse', id: theirs.id, status: 'ok', notes });
		return true;
	}

	/**
	 * Create or update a status text card (CardPlan kind 'notebook'): create it on its first pushed view, then write its
	 * content. Its smart text needs its dataset; without one (not pushed, or no rows) it shows only its text. The owner
	 * name is owner smart text when the dataset owner has that name.
	 */
	async function pushNotebook(card, entry, base, notes) {
		const ref = `card:${card.key}`;
		try {
			if (card.header && !dryRun && (await adoptTextCard(card, entry, base, notes))) return;
			const { notebook, dataSourceId: datasetRef } = card.body;
			const segments = notebook.paragraphs.flat();
			let dataSourceId;
			if (datasetRef && segments.some((s) => 'smart' in s || 'owner' in s)) {
				const r = datasetRef.$ref;
				dataSourceId = noData.has(r) || failed.has(r) ? undefined : lookup(r, 'id');
				if (dataSourceId === undefined) {
					const why = noData.has(r) ? `the ${noData.get(r)}` : `${r} is not pushed`;
					notes.push(`text only: ${why}`);
					summary.issues.push({ severity: 'warning', code: 'push.notebook-text-only', message: `Text card "${card.title}" shows its text without smart text: ${why}`, object: { type: 'card', name: card.title }, suggestion: 'Push the dataset with its data, then push this card again.' });
				}
			}
			const owner = segments.find((s) => 'owner' in s)?.owner;
			let ownerSmart = Boolean(entry?.extra?.ownerSmart);
			if (owner && dataSourceId !== undefined && !dryRun) {
				try {
					const name = (await d.datasets.getDataset(c, dataSourceId))?.owner?.name;
					ownerSmart = sameOwner(owner, name);
					notes.push(ownerSmart ? `owner "${owner}" is the dataset owner, so it is owner smart text` : `owner "${owner}" is plain text: the dataset owner is ${name ? `"${name}"` : 'unknown'}`);
				} catch (err) {
					ownerSmart = false;
					notes.push(`owner "${owner}" is plain text: the dataset owner could not be read (${errorMessage(err)})`);
				}
			}
			const content = notebookBody(notebook.paragraphs, { dataSourceId: dataSourceId === undefined ? undefined : String(dataSourceId), ownerSmart, align: notebook.align, valign: notebook.valign });
			const hash = shortHash({ title: notebook.title, content });
			const action = entry ? (changed(entry, hash) ? 'update' : 'unchanged') : 'create';
			const pageKey = (card.pageKeys ?? []).find((k) => lookup(`page:${k}`, 'id') !== undefined);
			const pageId = pageKey ? lookup(`page:${pageKey}`, 'id') : undefined;
			if (dryRun) {
				await record({ ...base, action, id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
				return;
			}
			let id = entry?.id;
			if (!entry) {
				id = (await d.notebooks.createNotebook(c, { title: notebook.title, pageId })).id;
				setEntry(state, ref, { id, extra: { kind: 'notebook', pageId: pageId ?? null } });
				await checkpoint();
			}
			if (action !== 'unchanged') await d.notebooks.updateNotebook(c, id, { title: notebook.title, ...content });
			setEntry(state, ref, { id, hash, extra: { ownerSmart } });
			await record({ ...base, action, id, status: 'ok', notes });
		} catch (err) {
			await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
		}
	}

	/**
	 * Create or update an image card (CardPlan kind 'image'): its package image uploaded as a data file and a document card
	 * on its first pushed view. Again with the same bytes uploads nothing; changed bytes are a new revision of the file; a
	 * file deleted outside t2d is uploaded again and the card pointed at it.
	 */
	/** A hand-made document card on the view with the same image (bytes, or pixel size when re-encoded); t2d shows it instead of its own. */
	async function userImageCard(image, pageId) {
		if (!d.pages.getLayoutByPage || !d.cards.getCardSummaries || !d.files.downloadDataFile) return undefined;
		const ours = new Set(Object.entries(state.objects).filter(([r]) => r.startsWith('card:')).map(([, e]) => String(e.id)));
		const layout = await d.pages.getLayoutByPage(c, pageId);
		const ids = [...new Set((layout?.content ?? []).filter((i) => i.type === 'CARD' && i.cardId != null).map((i) => String(i.cardId)))].filter((id) => !ours.has(id) && !adoptedImages.has(id));
		for (const live of ids.length ? await d.cards.getCardSummaries(c, ids) : []) {
			const dataFileId = live?.type === 'document' ? String(live.metadata?.documentId ?? '').split(':')[0] : '';
			if (!dataFileId) continue;
			const details = await d.files.getDataFileDetails(c, dataFileId);
			if (!String(details?.currentRevision?.contentType ?? '').startsWith('image/')) continue;
			let same = String(details.currentRevision.md5Hash ?? '').toLowerCase() === String(image.md5).toLowerCase();
			if (!same && image.width) {
				const size = imageInfo(await d.files.downloadDataFile(c, dataFileId), { tone: false });
				same = size?.width === image.width && size?.height === image.height;
			}
			if (same) return { id: live.id, title: live.title };
		}
		return undefined;
	}

	/** The data file of a section background image on the view that t2d did not upload and that shows the same image. */
	async function userSectionImage(image, pageId) {
		if (!d.pages.getLayoutByPage || !d.files.downloadDataFile) return undefined;
		const layout = await d.pages.getLayoutByPage(c, pageId);
		const refs = new Set((layout?.content ?? []).filter((i) => i.type === 'TABS' && i.style?.background?.type === 'IMAGE_REFERENCE').map((i) => i.style.background.value));
		if (!refs.size) return undefined;
		const theme = (appCurrent ?? (await d.apps.getApp(c, getEntry(state, appRef)?.id)))?.theme;
		const ours = new Set(Object.values(state.objects).filter((e) => e?.extra?.section && !e.extra.adopted).map((e) => String(e.extra.dataFileId)));
		for (const ref of refs) {
			const dataFileId = (theme?.images ?? []).find((i) => i.id === ref)?.dataFileId;
			if (dataFileId == null || ours.has(String(dataFileId))) continue;
			if (await sameImage(image, dataFileId)) return String(dataFileId);
		}
		return undefined;
	}

	/** True when a data file holds `image`: the same bytes, or the same pixel size (the editor may re-encode an upload). */
	async function sameImage(image, dataFileId) {
		const details = await d.files.getDataFileDetails(c, dataFileId);
		if (!String(details?.currentRevision?.contentType ?? '').startsWith('image/')) return false;
		if (String(details.currentRevision.md5Hash ?? '').toLowerCase() === String(image.md5).toLowerCase()) return true;
		if (!image.width) return false;
		const size = imageInfo(await d.files.downloadDataFile(c, dataFileId), { tone: false });
		return size?.width === image.width && size?.height === image.height;
	}

	/**
	 * A header's section background image (CardPlan kind 'image', `section`): uploaded as the view's layout background,
	 * no card; the layout write adds it to the app theme's images. A matching background the view already has (set in
	 * Domo) is used instead and never changed or deleted.
	 */
	async function pushSectionImage(card, entry, base, notes) {
		const ref = `card:${card.key}`;
		const { image } = card.body;
		const md5 = String(image.md5).toLowerCase();
		const hash = shortHash({ name: image.name, md5 });
		try {
			const viewKey = (card.pageKeys ?? []).find((k) => lookup(`page:${k}`, 'id') !== undefined);
			const viewId = viewKey ? lookup(`page:${viewKey}`, 'id') : undefined;
			if (dryRun) {
				await record({ ...base, action: entry ? (changed(entry, hash) ? 'update' : 'unchanged') : 'create', id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
				return;
			}
			const present = entry?.extra?.dataFileId != null && (await d.files.getDataFileDetails(c, entry.extra.dataFileId));
			if (entry?.extra?.adopted) {
				if (present) {
					await record({ ...base, action: 'unchanged', id: entry.id, status: 'ok', notes: [...notes, 'uses the section background image set in Domo on this view; t2d does not change or delete it'] });
					return;
				}
				notes.push(`the background image file ${entry.extra.dataFileId} set in Domo is gone; t2d uploads its own`);
				delete state.objects[ref];
				entry = undefined;
			}
			const unchecked = (err) => void notes.push(`could not check the view for a background image set in Domo: ${errorMessage(err)}`);
			const theirs = viewId != null ? await userSectionImage(image, viewId).catch(unchecked) : undefined;
			if (theirs) {
				if (entry?.extra?.dataFileId != null) {
					await d.files.deleteDataFile(c, entry.extra.dataFileId);
					notes.push(`deleted the image file ${entry.extra.dataFileId} an earlier push uploaded`);
				}
				setEntry(state, ref, { id: Number(theirs), hash, extra: { kind: 'image', section: true, adopted: true, dataFileId: Number(theirs), pageId: viewId } });
				notes.push(`uses the section background image file ${theirs} set in Domo on this view (the same image); t2d does not change or delete it`);
				await record({ ...base, action: 'reuse', id: Number(theirs), status: 'ok', notes });
				return;
			}
			if (present && String(entry.extra.md5 ?? '').toLowerCase() === md5) {
				setEntry(state, ref, { hash });
				await record({ ...base, action: 'unchanged', id: entry.id, status: 'ok', notes });
				return;
			}
			const source = path.join(p.dir, image.file);
			if (!fs.existsSync(source)) throw new Error(`the image ${ws.relative(source)} is missing; run convert again`);
			const bytes = fs.readFileSync(source);
			const dataFileId = (
				await timer.time('images.upload', () => (viewId != null && d.files.uploadLayoutBackground ? d.files.uploadLayoutBackground(c, viewId, bytes, image.name) : d.files.uploadDataFile(c, bytes, image.name)), { name: image.name, bytes: bytes.length })
			).id;
			if (present) {
				await d.files.deleteDataFile(c, entry.extra.dataFileId);
				notes.push(`the image changed: uploaded again, file ${entry.extra.dataFileId} deleted`);
			} else if (entry) notes.push(`its image file ${entry.extra?.dataFileId} is gone; uploaded again`);
			setEntry(state, ref, { id: dataFileId, hash, extra: { kind: 'image', section: true, dataFileId, md5, pageId: viewId ?? null } });
			await record({ ...base, action: entry ? 'update' : 'create', id: dataFileId, status: 'ok', notes });
		} catch (err) {
			await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
		}
	}

	async function pushImage(card, entry, base, notes) {
		const ref = `card:${card.key}`;
		const { image } = card.body;
		const md5 = String(image.md5).toLowerCase();
		const hash = shortHash({ name: image.name });
		try {
			const viewKey = (card.pageKeys ?? []).find((k) => lookup(`page:${k}`, 'id') !== undefined);
			const viewId = viewKey ? lookup(`page:${viewKey}`, 'id') : undefined;
			if (entry?.extra?.adopted && !dryRun) {
				const [live] = d.cards.getCardSummaries ? await d.cards.getCardSummaries(c, [entry.id]) : [{}];
				if (live && live.active !== false) {
					adoptedImages.add(String(entry.id));
					await record({ ...base, action: 'unchanged', id: entry.id, status: 'ok', notes: [...notes, 'shows the image card made in Domo on this view; t2d does not change or delete it'] });
					return;
				}
				notes.push(`the image card ${entry.id} made in Domo is gone; t2d makes its own`);
				delete state.objects[ref];
				entry = undefined;
			}
			const unchecked = (err) => void notes.push(`could not check the view for an image card made in Domo: ${errorMessage(err)}`);
			const theirs = !dryRun && viewId != null ? await userImageCard(image, viewId).catch(unchecked) : undefined;
			if (theirs) {
				if (entry) {
					await d.cards.deleteCard(c, entry.id).catch((err) => {
						if (err?.status !== 404) throw err;
					});
					if (entry.extra?.dataFileId != null) await d.files.deleteDataFile(c, entry.extra.dataFileId);
					notes.push(`deleted the image card ${entry.id} and file ${entry.extra?.dataFileId} an earlier push created`);
				}
				adoptedImages.add(String(theirs.id));
				delete state.objects[ref];
				setEntry(state, ref, { id: theirs.id, hash, extra: { kind: 'image', adopted: true, pageId: viewId } });
				notes.push(`uses the image card ${theirs.id}${theirs.title ? ` "${theirs.title}"` : ''} made in Domo on this view (the same image); t2d does not change or delete it`);
				await record({ ...base, action: 'reuse', id: theirs.id, status: 'ok', notes });
				return;
			}
			let dataFileId = entry?.extra?.dataFileId;
			let file = 'upload';
			if (entry && dataFileId != null) {
				const present = dryRun || (await d.files.getDataFileDetails(c, dataFileId));
				if (!present) notes.push(`its image file ${dataFileId} is gone; uploaded again`);
				else file = String(entry.extra.md5 ?? '').toLowerCase() === md5 ? 'unchanged' : 'version';
			}
			if (file === 'version') notes.push('the image changed: a new revision of its file');
			const action = !entry ? 'create' : file === 'unchanged' && !changed(entry, hash) ? 'unchanged' : 'update';
			const pageId = viewId;
			if (dryRun) {
				await record({ ...base, action, id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
				return;
			}
			const source = path.join(p.dir, image.file);
			if (file !== 'unchanged' && !fs.existsSync(source)) throw new Error(`the image ${ws.relative(source)} is missing; run convert again`);
			const bytes = file === 'unchanged' ? undefined : fs.readFileSync(source);
			if (file === 'upload') dataFileId = (await timer.time('images.upload', () => d.files.uploadDataFile(c, bytes, image.name), { name: image.name, bytes: bytes.length })).id;
			else if (file === 'version') await timer.time('images.upload', () => d.files.uploadDataFileVersion(c, dataFileId, bytes, image.name), { name: image.name, bytes: bytes.length });
			let id = entry?.id;
			if (!entry) {
				try {
					id = (await d.cards.createDocumentCard(c, { name: image.name, dataFileId, pageId })).id;
				} catch (err) {
					await d.files.deleteDataFile(c, dataFileId).catch(() => {});
					throw err;
				}
			} else if (file === 'upload' || changed(entry, hash)) await d.cards.updateDocumentCard(c, id, { name: image.name, dataFileId });
			setEntry(state, ref, { id, hash, extra: { kind: 'image', dataFileId, md5, ...(entry ? {} : { pageId: pageId ?? null }) } });
			await record({ ...base, action, id, status: 'ok', notes });
		} catch (err) {
			await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
		}
	}

	async function applySummaryNumber(cardId, body, bigNumber) {
		if (d.cards.applyBigNumber) {
			await d.cards.applyBigNumber(c, cardId, bigNumber, { dataSourceId: body?.dataProvider?.dataSourceId, cardFormulas: body?.definition?.formulas?.card ?? [] });
		} else {
			await d.cards.updateCard(c, cardId, withBigNumber(body, bigNumber));
		}
	}

	/**
	 * Theme image ids (`iN`) by data file id for the header background images of `pages`, listed in the app theme first
	 * when missing (the app PUT carries the theme). Missing entries stay out when the app cannot be read or written.
	 */
	async function themeImageIds(pages) {
		const keys = pages.flatMap((pg) => (pg.layout?.content ?? []).map((i) => i.sectionImage).filter(Boolean));
		const files = [...new Set(keys.map((k) => getEntry(state, `card:${k}`)?.extra?.dataFileId).filter((v) => v != null).map(String))];
		const appId = getEntry(state, appRef)?.id;
		if (!files.length || appId == null) return {};
		try {
			const current = await d.apps.getApp(c, appId);
			const { theme, ids, changed } = applyThemeImages(current.theme, files);
			if (changed) {
				appCurrent = (await d.apps.updateApp(c, appId, { ...current, theme })) ?? { ...current, theme };
				emitter.info(`app theme lists ${files.length} header background image(s)`);
			} else appCurrent = current;
			return ids;
		} catch (err) {
			summary.issues.push({ severity: 'warning', code: 'push.section-image-theme', message: `The app theme could not list the header background images: ${errorMessage(err)}`, object: { type: 'app', name: plan.app?.title ?? '' } });
			return {};
		}
	}

	timer.phase('layouts', kinds.has('layouts'));
	/* 7. Layouts. */
	if (kinds.has('layouts')) {
		// A layouts-only push lays out the member cards an earlier push made.
		for (const card of (plan.cards ?? []).filter((x) => x.split)) {
			const made = Object.values(state.objects).filter((e) => e.extra?.splitOf?.key === card.key);
			if (made.length) expandSplitCard(plan, card.key, made.map((e) => e.extra.splitOf.member));
		}
		const withLayout = (plan.pages ?? []).filter((pg) => pg.layout && writes('layout', pg.key));
		if (withLayout.length) emitter.step('Layouts');
		const themeDynamic = appCurrent?.theme?.pages?.[0]?.isDynamic;
		const isDynamic = asApp && typeof themeDynamic === 'boolean' ? themeDynamic : undefined;
		const pageStyleId = appCurrent?.theme?.pages?.[0]?.id ?? 'p0';
		// An item style id is used only when t2d wrote it into the theme and the app's theme still has it (else a 400).
		const itemStyleIds = asApp ? (getEntry(state, appRef)?.extra?.itemStyleIds ?? {}) : {};
		const themeStyleIds = appCurrent?.theme ? new Set([...(appCurrent.theme.cards ?? []), ...(appCurrent.theme.tables ?? [])].map((s) => s.id)) : undefined;
		const tableStyleIds = appCurrent?.theme ? new Set((appCurrent.theme.tables ?? []).map((s) => s.id)) : undefined;
		const cardsByKey = new Map((plan.cards ?? []).map((c) => [c.key, c]));
		let unstyled = 0;
		const fillIds = asApp ? sectionFillIds(appCurrent?.theme, sectionFills) : {};
		let unfilled = 0;
		const imageIds = asApp && !dryRun ? await themeImageIds(withLayout) : {};
		let unimaged = 0;
		const withItemStyle = (item) => {
			if ('sectionImage' in item) {
				const { sectionImage, ...rest } = item;
				const id = imageIds[String(getEntry(state, `card:${sectionImage}`)?.extra?.dataFileId)];
				if (id) rest.style = { sourceId: null, textColor: null, background: { value: id, type: 'IMAGE_REFERENCE' }, isDynamic: null, density: null, margin: null, titleFontColor: null, titleFontStyle: null };
				else if (!dryRun) unimaged += 1;
				return rest;
			}
			if ('sectionFill' in item) {
				const { sectionFill, ...rest } = item;
				if (fillIds[sectionFill]) rest.style = { ...(rest.style ?? {}), sourceId: fillIds[sectionFill] };
				else unfilled += 1;
				return rest;
			}
			if (!('itemStyle' in item)) return item;
			const { itemStyle, ...rest } = item;
			const id = itemStyleIds[itemStyle];
			// Domo takes a table style only on a table card and a card style only on any other item.
			const cardKey = isRef(item.cardId) ? String(item.cardId.$ref).replace(/^card:/, '') : undefined;
			const chartType = cardKey ? cardsByKey.get(cardKey)?.chartType : undefined;
			const tableStyle = tableStyleIds ? tableStyleIds.has(id) : /^t\d+$/.test(String(id));
			const fits = !id || tableStyle === (item.type === 'CARD' && isTableChart(chartType));
			if (id && fits && (!themeStyleIds || themeStyleIds.has(id))) rest.style = { ...(rest.style ?? {}), sourceId: id };
			else unstyled += 1;
			return rest;
		};
		for (const page of withLayout) {
			const ref = `layout:${page.key}`;
			const entry = getEntry(state, ref);
			const base = { kind: 'layout', key: page.key, name: page.title };
			layoutsPushed.add(page.key);
			const notes = [];
			try {
				const pageId = resolve({ $ref: `page:${page.key}` });
				const layout = page.layout;
				const droppedKeys = new Set();
				const content = [];
				const unresolved = (value) => [...collectRefs(value)].filter((r) => failed.has(r) || lookup(r, 'id') === undefined);
				const lostLinks = [];
				const webLinks = new Map((page.webLinks ?? []).filter((w) => w.contentKey !== undefined).map((w) => [w.contentKey, w]));
				for (const source of layout.content ?? []) {
					const item = withPushedCardUrns(source, unresolved, notes);
					const { interaction, ...rest } = item;
					const missing = unresolved(item.type === 'BUTTON' ? item : rest);
					if (missing.length) {
						const web = webLinks.get(item.contentKey);
						const onTableau = web?.slug && web.tableauUrl && item.type === 'BUTTON' ? { ...item, ...tableauViewLink(web.title ?? web.sheet, web.name, web.tableauUrl) } : undefined;
						if (onTableau && !unresolved(onTableau).length) {
							notes.push(`linked ${missing.join(', ')} to Tableau`);
							summary.issues.push({
								severity: 'warning',
								code: 'push.web-link-target-missing',
								message: `${asApp ? 'View' : 'Page'} "${page.title}" links its button to the view "${web.title ?? web.sheet}" of workbook "${web.name}" (its Tableau web page zone) on Tableau until that workbook is pushed to ${instance}`,
								object: { type: 'page', name: page.title },
								suggestion: `Push workbook ${web.slug}, then push this layout again (t2d push --workbook ${slug} --only layouts).`
							});
							content.push(onTableau);
							continue;
						}
						droppedKeys.add(item.contentKey);
						notes.push(`left out ${missing.join(', ')}`);
						if (web?.slug) {
							summary.issues.push({
								severity: 'warning',
								code: 'push.web-link-target-missing',
								message: `${asApp ? 'View' : 'Page'} "${page.title}" left out the button to the view "${web.title ?? web.sheet}" of workbook "${web.name}" (its Tableau web page zone): that workbook is not pushed to ${instance} yet`,
								object: { type: 'page', name: page.title },
								suggestion: `Push workbook ${web.slug}, then push this layout again (t2d push --workbook ${slug} --only layouts).`
							});
						} else if (item.type === 'BUTTON') lostLinks.push(...missing);
						continue;
					}
					const missingLink = interaction ? unresolved(interaction) : [];
					if (missingLink.length) {
						notes.push(`left out the click action of item ${item.contentKey} (${missingLink.join(', ')})`);
						lostLinks.push(...missingLink);
						content.push(rest);
						continue;
					}
					content.push(item);
				}
				if (lostLinks.length) {
					summary.issues.push({
						severity: 'warning',
						code: 'push.link-target-missing',
						message: `${asApp ? 'View' : 'Page'} "${page.title}" left out ${lostLinks.length} button(s) or click action(s) whose target is not pushed: ${[...new Set(lostLinks)].slice(0, 5).join(', ')}`,
						object: { type: 'page', name: page.title },
						suggestion: 'Push the target dashboards too, then push this layout again.'
					});
				}
				const styled = content.map((item) => withItemStyle(item));
				content.splice(0, content.length, ...styled);
				const kept = (template) => template.filter((t) => !droppedKeys.has(t.contentKey)).map((t) => ({ ...t, ...(t.children ? { children: kept(t.children) } : {}) }));
				// Items left out leave holes the editor cannot close, so their neighbors take the space.
				const tiled = droppedKeys.size ? finishLayout(content, kept(layout.standard?.template ?? []), kept(layout.compact?.template ?? [])) : undefined;
				const planned = resolve({
					content,
					standard: { ...layout.standard, template: tiled ? tiled.standard.template : kept(layout.standard?.template ?? []) },
					compact: { ...layout.compact, template: tiled ? tiled.compact.template : kept(layout.compact?.template ?? []) },
					...(isDynamic !== undefined ? { isDynamic } : {}),
					...(layout.style ? { style: { sourceId: pageStyleId, background: null, isDynamic: null, height: null, fontColor: null, ...layout.style } } : {})
				});
				const controls = variableControlSpecs(planned, layout.content ?? []).map(({ key, name }) => [key, name]);
				const hash = shortHash({ layout: planned, writer: LAYOUT_WRITER, controls });
				const isChanged = changed(entry, hash);
				const action = entry ? (isChanged ? 'update' : 'unchanged') : 'create';
				if (dryRun) {
					await record({ ...base, action, id: entry?.id ?? placeholder(ref), status: 'dry-run', notes });
					continue;
				}
				if (!isChanged) {
					await record({ ...base, action, id: entry.id, status: 'ok', notes });
					continue;
				}
				const variableControls = await placeVariableControls(pageId, planned, layout.content ?? [], entry?.extra?.variableControls ?? {}, notes);
				const written = await d.pages.writeLayout(c, pageId, planned);
				const ours = new Set(Object.entries(state.objects).filter(([r]) => r.startsWith('card:')).map(([, e]) => String(e.id)));
				const theirs = (written?.appendixCardIds ?? []).filter((cardId) => !ours.has(cardId));
				if (theirs.length) {
					summary.issues.push({
						severity: 'warning',
						code: 'push.layout-appendix',
						message: `${asApp ? 'View' : 'Page'} "${page.title}" shows ${theirs.length} card(s) t2d did not create in an Appendix below its layout (${theirs.slice(0, 5).join(', ')}): they are on the ${asApp ? 'view' : 'page'} but not in the Tableau layout`,
						object: { type: 'page', name: page.title },
						suggestion: `Delete those cards, or remove them from the ${asApp ? 'view' : 'page'}, if the converted layout replaces them; t2d does not delete cards it did not create.`
					});
				}
				const id = written?.layoutId ?? entry?.id ?? pageId;
				setEntry(state, ref, { id, hash, extra: { pageId, ...(Object.keys(variableControls).length ? { variableControls } : {}) } });
				await record({ ...base, action, id, status: 'ok', notes });
			} catch (err) {
				if (err?.code === 'push.layout-locked') {
					summary.issues.push({
						severity: 'error',
						code: 'push.layout-locked',
						message: `The layout of "${page.title}" was not written: another user holds its write lock (someone is editing it)`,
						object: { type: 'page', name: page.title },
						suggestion: 'Retry the push after the editor closes; the lock times out 60 s after the editor stops.'
					});
				}
				await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
			}
		}
		if (unimaged) {
			summary.issues.push({ severity: 'warning', code: 'push.section-image-skipped', message: `${unimaged} header section(s) show no background image: the image was not uploaded or the app theme could not list it`, object: { type: 'app', name: plan.app?.title ?? '' }, suggestion: 'See the image card errors in the push log, then push again.' });
		}
		if (unfilled) {
			summary.issues.push({ severity: 'info', code: 'push.section-fill-skipped', message: `${unfilled} title row(s) keep no fill: the app's theme has no section style for their Tableau title fill (${sectionFills.join(', ')})`, object: { type: 'app', name: plan.app?.title ?? '' }, suggestion: 'Push again to add the section styles to the app theme.' });
		}
		if (unstyled) {
			summary.issues.push({ severity: 'info', code: 'push.item-styles-skipped', message: `${unstyled} card(s) keep the default card style instead of their Tableau zone style: the app's theme was written before t2d wrote item styles, or has no free style for them`, object: { type: 'app', name: plan.app?.title ?? '' }, suggestion: 'Push again with --workbook-theme to write the theme with the item styles.' });
		}
	}
	timer.phase('filter-views', kinds.has('layouts'));
	/* 7b. Page default filters: the Tableau filter selections as each page's "Default" filter view, the page default for all users. */
	if (kinds.has('layouts')) {
		const withFilters = (plan.pages ?? []).filter((pg) => writes('filterview', pg.key) && (pg.filters?.length || getEntry(state, `filterview:${pg.key}`)));
		if (withFilters.length) emitter.step('Page filters');
		for (const page of withFilters) await pushFilterView(page);
	}

	/** The page's filters with dataset ids and the source filter card's urn, as the filter bar saves them; a filter whose dataset is not pushed is left out. */
	function pageFilterBody(page) {
		const urn = (key) => state.objects[`card:${key}`]?.extra?.urn ?? state.objects[`card:${key}`]?.id ?? (dryRun ? dryIds.get(`card:${key}`) : undefined);
		const out = [];
		for (const { sourceCard, affectedCards, ...rest } of page.filters ?? []) {
			let dataSourceId;
			try {
				dataSourceId = resolve(rest.dataSourceId);
			} catch {
				continue;
			}
			const source = sourceCard ? urn(sourceCard) : undefined;
			const affectedCardUrns = (affectedCards ?? []).map(urn).filter((u) => u != null).map(String);
			out.push({ ...rest, dataSourceId: String(dataSourceId), affectedCardUrns, ...(source != null ? { sourceCardURN: String(source) } : {}) });
		}
		return out;
	}

	async function pushFilterView(page) {
		const ref = `filterview:${page.key}`;
		const entry = getEntry(state, ref);
		const name = DEFAULT_FILTER_VIEW;
		const base = { kind: 'filterview', key: page.key, name: `${page.title}: ${name}` };
		const notes = [];
		try {
			const pageId = resolve({ $ref: `page:${page.key}` });
			const filters = pageFilterBody(page);
			const hash = shortHash({ name, filters });
			if (dryRun) {
				await record({ ...base, action: !filters.length ? 'delete' : entry ? (changed(entry, hash) ? 'update' : 'unchanged') : 'create', id: entry?.id ?? placeholder(ref), status: 'dry-run', notes: [`${filters.length} filter(s)`] });
				return;
			}
			const views = await d.pages.listFilterViews(c, pageId);
			const mine = entry && views.find((v) => String(v.analyzerId) === String(entry.id));
			if (!filters.length) {
				if (mine) await d.pages.deleteFilterView(c, mine.analyzerId);
				delete state.objects[ref];
				await record({ ...base, action: 'delete', id: entry?.id ?? null, status: 'ok', notes: mine ? [] : ['already gone'] });
				return;
			}
			const otherDefault = views.find((v) => v.isDefault && v !== mine);
			const makeDefault = async (view, id) => {
				if (view?.isDefault) return;
				if (otherDefault) {
					notes.push(`not the page default: "${otherDefault.name}" is`);
					summary.issues.push({
						severity: 'warning',
						code: 'push.filter-view-default',
						message: `${asApp ? 'View' : 'Page'} "${page.title}" keeps the filter view "${otherDefault.name}" as its default (t2d did not create it); t2d's "${name}" view holds the Tableau filter selections`,
						object: { type: 'page', name: page.title },
						suggestion: `Make "${name}" the default in the filter bar if the Tableau selections should apply when the ${asApp ? 'view' : 'page'} opens.`
					});
					return;
				}
				await d.pages.setDefaultFilterView(c, pageId, id);
			};
			if (mine) {
				const isChanged = changed(entry, hash);
				if (isChanged) await d.pages.updateFilterView(c, pageId, mine.analyzerId, { name, filters });
				await makeDefault(mine, mine.analyzerId);
				setEntry(state, ref, { id: mine.analyzerId, hash, extra: { pageId } });
				await record({ ...base, action: isChanged ? 'update' : 'unchanged', id: mine.analyzerId, status: 'ok', notes });
				return;
			}
			if (entry) notes.push('recreated: the filter view was deleted in Domo');
			const sameName = views.find((v) => v.name === name);
			if (sameName) {
				const existing = await d.pages.getFilterView(c, sameName.analyzerId);
				if (!sameFilters(existing?.filters, filters)) {
					summary.issues.push({
						severity: 'warning',
						code: 'push.filter-view-foreign',
						message: `${asApp ? 'View' : 'Page'} "${page.title}" already has a filter view named "${name}" that t2d did not create, with other filters (${describeFilters(existing?.filters)}; t2d's: ${describeFilters(filters)}); left as it is`,
						object: { type: 'page', name: page.title },
						suggestion: `Rename or delete that filter view and push again for t2d's "${name}" view, or keep it.`
					});
					await record({ ...base, action: 'skip', id: sameName.analyzerId, status: 'skipped', error: `a "${name}" filter view t2d did not create has other filters`, notes });
					return;
				}
				await makeDefault(sameName, sameName.analyzerId);
				setEntry(state, ref, { id: sameName.analyzerId, hash, extra: { pageId, adopted: true } });
				await record({ ...base, action: 'reuse', id: sameName.analyzerId, status: 'ok', notes: [...notes, `the existing "${name}" filter view has the same filters`] });
				return;
			}
			const id = await d.pages.createFilterView(c, pageId, { name, filters });
			setEntry(state, ref, { id, hash, extra: { pageId } });
			await makeDefault(undefined, id);
			await record({ ...base, action: 'create', id, status: 'ok', notes });
		} catch (err) {
			await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
		}
	}

	for (const page of recreatedViews.size ? fullPlan.pages ?? [] : []) {
		if (layoutsPushed.has(page.key) || !getEntry(state, `layout:${page.key}`)) continue;
		const stale = [...linkedPageKeys(page.layout)].filter((k) => recreatedViews.has(k));
		if (!stale.length) continue;
		summary.issues.push({
			severity: 'warning',
			code: 'push.links-stale',
			message: `View "${page.title}" was not pushed and its buttons or click actions still open the old id of the recreated view(s) ${stale.map((k) => `"${fullPlan.pages.find((pg) => pg.key === k)?.title ?? k}"`).join(', ')}`,
			object: { type: 'page', name: page.title },
			suggestion: `Push this view's layout too (t2d push --keys layout:${page.key}).`
		});
	}

	timer.phase('navigation', Boolean(appRef && kinds.has('navigation')));
	/* 8. Navigation (target 'app'): view order and titles, hidden views, landing view, persist settings. */
	if (appRef && kinds.has('navigation') && writes('navigation', plan.app.key)) {
		emitter.step('Navigation');
		await pushNavigation(plan.app);
	}

	/**
	 * t2d's views of the app, in navigation order: those in the plan with their plan order, title and hidden flag, and
	 * those outside it (a subset push) as last pushed.
	 */
	function appViews(app, appId) {
		const planned = new Map((plan.pages ?? []).filter((pg) => pg.appKey === app.key).map((pg) => [pg.key, pg]));
		const views = [];
		const seen = new Set();
		for (const [ref, e] of Object.entries(state.objects)) {
			if (!ref.startsWith('page:') || e?.extra?.container !== 'app' || String(e.extra.appId) !== String(appId)) continue;
			const key = ref.slice('page:'.length);
			const pv = planned.get(key);
			seen.add(key);
			views.push({ key, id: e.id, title: pv?.title ?? e.extra.title, navOrder: pv?.navOrder ?? e.extra.navOrder ?? Infinity, hidden: Boolean(pv ? pv.hidden : e.extra.hidden), linked: Boolean(pv ? pv.linked : e.extra.linked), icon: pv ? pv.navIcon : e.extra.navIcon });
		}
		if (dryRun) {
			for (const [key, pv] of planned) if (!seen.has(key) && dryIds.has(`page:${key}`)) views.push({ key, id: dryIds.get(`page:${key}`), title: pv.title, navOrder: pv.navOrder ?? Infinity, hidden: Boolean(pv.hidden), linked: Boolean(pv.linked), icon: pv.navIcon });
		}
		return views.sort((a, b) => a.navOrder - b.navOrder || a.key.localeCompare(b.key));
	}

	async function pushNavigation(app) {
		const ref = `navigation:${app.key}`;
		const entry = getEntry(state, ref);
		const base = { kind: 'navigation', key: app.key, name: app.title };
		const notes = [];
		try {
			const appId = resolve({ $ref: `app:${app.key}` });
			const live = dryRun ? null : await d.apps.getApp(c, appId);
			let views = appViews(app, appId);
			if (live) {
				const present = new Set(appViewIds(live).map(String));
				const gone = views.filter((v) => !present.has(String(v.id)));
				if (gone.length) {
					views = views.filter((v) => present.has(String(v.id)));
					notes.push(`left out ${gone.length} view(s) no longer in the app (${gone.slice(0, 5).map((v) => `"${v.title}"`).join(', ')}); push their dashboards to recreate them`);
				}
			}
			const landing = views.find((v) => v.key === app.landingKey) ?? views.find((v) => !v.hidden);
			// With no visible view in a subset, the app's current landing view must stay visible.
			const landingId = landing?.id ?? live?.landingViewId ?? null;
			const isLanding = (v) => landingId != null && String(v.id) === String(landingId);
			const unknownIcons = views.filter((v) => v.icon && !Object.hasOwn(NAV_ICONS, v.icon));
			if (unknownIcons.length) notes.push(`kept the icon of ${unknownIcons.length} view(s) whose plan icon App Studio does not offer ("${unknownIcons[0].icon}")`);
			for (const v of unknownIcons) delete v.icon;
			const hash = shortHash({ views: views.map((v) => [...(v.linked && v.hidden ? [v.id, v.title, v.hidden, 'linked'] : [v.id, v.title, v.hidden]), ...(v.icon ? [v.icon] : [])]), landing: landingId, persist: app.persistSettings ?? null });
			const action = entry ? (changed(entry, hash) ? 'update' : 'unchanged') : 'create';
			notes.push(`${views.length} view(s)${landing ? `, landing "${landing.title}"` : ''}`);
			if (dryRun || action === 'unchanged') {
				await record({ ...base, action, id: entry?.id ?? appId, status: dryRun ? 'dry-run' : 'ok', notes });
				return;
			}
			const items = views.map((v) => ({ id: v.id, title: v.title, visible: !v.hidden || isLanding(v), icon: v.icon }));
			const ownIcons = entry?.extra?.icons ?? {};
			let written;
			try {
				written = buildNavigation(await d.apps.getNavigation(c, appId), items, ownIcons);
				await d.apps.reorderNavigation(c, appId, written);
			} catch (err) {
				// The reorder must list every view; another user may have added one since the read.
				if (err?.status !== 400) throw err;
				written = buildNavigation(await d.apps.getNavigation(c, appId), items, ownIcons);
				await d.apps.reorderNavigation(c, appId, written);
				notes.push('navigation read again after a 400');
			}
			const icons = { ...ownIcons };
			for (const v of items) {
				const item = written.find((n) => n.entity === 'VIEW' && String(n.entityId) === String(v.id));
				if (v.icon && item?.icon?.value === v.icon) icons[String(v.id)] = v.icon;
			}
			const iconed = items.filter((v) => v.icon && icons[String(v.id)] === v.icon && ownIcons[String(v.id)] !== v.icon).length;
			if (iconed) notes.push(`set the navigation icon of ${iconed} view(s)`);
			// The landing view must be visible before it is set, and cannot be hidden after.
			const shown = new Set(visibleViewIds(live).map(String));
			const setVisible = async (v, visible) => {
				await d.apps.setViewVisible(c, appId, v.id, visible);
				notes.push(`${visible ? 'showed' : 'hid'} "${v.title}"`);
			};
			// A linked view keeps its view visible (buttons open it) and hides only its navigation item.
			const hide = (v) => v.hidden && !v.linked && !isLanding(v);
			for (const v of views) if (!hide(v) && !shown.has(String(v.id))) await setVisible(v, true);
			// A landing view someone picked among views t2d did not create stays the landing view.
			const current = live?.landingViewId;
			const foreignLanding = current != null && String(current) !== '0' && !views.some((v) => String(v.id) === String(current)) && appViewIds(live).some((id) => String(id) === String(current));
			if (foreignLanding) notes.push(`kept the landing view ${current}, a view t2d did not create`);
			else if (landing) await d.apps.setLanding(c, appId, landing.id);
			for (const v of views) if (hide(v) && shown.has(String(v.id))) await setVisible(v, false);
			if (app.persistSettings) {
				await d.apps.putPersistSettings(c, appId, app.persistSettings);
				if (appFlags?.['app-studio-persist'] === 'off') notes.push('persist settings saved, but app-studio-persist is off');
			}
			setEntry(state, ref, { id: appId, hash, ...(Object.keys(icons).length ? { extra: { icons } } : {}) });
			await record({ ...base, action, id: appId, status: 'ok', notes });
		} catch (err) {
			await record({ ...base, action: entry ? 'update' : 'create', id: entry?.id ?? null, status: err instanceof DependencyError ? 'skipped' : 'failed', error: errorMessage(err), notes });
		}
	}

	timer.phase('retired-beastmodes', kinds.has('beastmodes') && kinds.has('cards'));
	/* 9. Beast modes earlier pushes of this workbook created that the plan no longer has, once its cards stopped using them. */
	if (wholePlan && kinds.has('beastmodes') && kinds.has('cards') && ![...failed].some((r) => r.startsWith('card:') && getEntry(state, r))) {
		const planned = new Set((plan.beastModes ?? []).map((bm) => `beastmode:${bm.key}`));
		const ourCards = new Set(Object.entries(state.objects).filter(([r]) => r.startsWith('card:')).flatMap(([, e]) => [e.id, ...(e.extra?.drillViews ?? []).map((v) => v.id)].map(String)));
		const stale = Object.entries(state.objects).filter(([ref, entry]) => ref.startsWith('beastmode:') && !planned.has(ref) && (entry.extra?.workbooks ?? []).includes(slug));
		if (stale.length) emitter.step('Retired beast modes');
		for (const [ref, entry] of stale) {
			const base = { kind: 'beastmode', key: ref.slice('beastmode:'.length), name: entry.extra?.legacyId ?? ref };
			const others = entry.extra.workbooks.filter((w) => w !== slug);
			if (others.length) {
				if (!dryRun) setEntry(state, ref, { extra: { workbooks: others } });
				continue;
			}
			const notes = ['no longer in the plan (nothing migrated uses it, it is now a plain column, or the calc changed)'];
			if (dryRun) {
				await record({ ...base, action: 'delete', id: entry.id, status: 'dry-run', notes: [...notes, 'kept if a card t2d did not create uses it (checked only on a real run)'] });
				continue;
			}
			try {
				const template = await d.beastmodes.getBeastMode(c, entry.id);
				base.name = template?.name ?? base.name;
				const foreign = (template?.links ?? []).filter((l) => l.active !== false && l.resource?.type === 'CARD' && !ourCards.has(String(l.resource.id)));
				if (foreign.length) {
					const ids = foreign.slice(0, 5).map((l) => l.resource.id).join(', ');
					summary.issues.push({ severity: 'warning', code: 'push.beastmode-foreign-use', message: `Beast mode "${base.name}" (${entry.id}) is no longer in the plan but was kept: card(s) t2d did not create use it (${ids})`, object: { type: 'beastmode', name: base.name, id: entry.id }, suggestion: 'Delete it in Domo once those cards no longer need it.' });
					await record({ ...base, action: 'skip', id: entry.id, status: 'skipped', error: `used by card(s) ${ids}, which t2d did not create`, notes });
					continue;
				}
				await d.beastmodes.deleteBeastModes(c, [entry.id], { unlink: { [entry.id]: template?.links ?? [] } });
			} catch (err) {
				if (err?.status !== 404) {
					await record({ ...base, action: 'delete', id: entry.id, status: 'failed', error: errorMessage(err), notes });
					continue;
				}
			}
			delete state.objects[ref];
			await record({ ...base, action: 'delete', id: entry.id, status: 'ok', notes });
		}
	}

	if (appRef && !dryRun && getEntry(state, appRef)) {
		const appId = getEntry(state, appRef).id;
		summary.app = {
			key: plan.app.key,
			id: appId,
			title: plan.app.title,
			url: appUrl(instance, appId),
			views: appViews(plan.app, appId).map((v) => ({ key: v.key, title: v.title, id: v.id, url: appUrl(instance, appId, v.id) }))
		};
	}

	if (!dryRun) {
		// Stamp what this workbook's objects depend on, so another workbook's unpush keeps it (shared()).
		for (const ref of used) {
			const entry = state.objects[ref];
			if (entry && !(entry.extra?.workbooks ?? []).includes(slug)) setEntry(state, ref, { extra: { workbooks: [...(entry.extra?.workbooks ?? []), slug] } });
		}
	}
	summary.ok = !summary.actions.some((a) => a.status === 'failed');
	summary.timing = timer.finish({ slug, dryRun });
	summary.finishedAt = summary.timing.finishedAt;
	await checkpoint();
	if (!dryRun) await writeRunLog(ws, slug, 'push', summary);

	if (!dryRun) {
		try {
			const ir = await ws.readJson(p.ir, null);
			const manifests = await ws.readManifests(slug);
			await ws.writeText(p.report, renderReport({ ir, plan, push: summary, manifests, runs: { ...(await latestRunLogs(ws, slug)), push: summary } }));
		} catch (err) {
			emitter.warn(`Could not refresh report.md: ${errorMessage(err)}`);
		}
	}

	const failedCount = summary.counts['status:failed'] || 0;
	const skippedCount = summary.counts['status:skipped'] || 0;
	emitter.done(
		`${dryRun ? 'Dry run' : 'Push'} finished: ${summary.counts.create || 0} create, ${summary.counts.update || 0} update, ${summary.counts.unchanged || 0} unchanged, ${summary.counts.delete ? `${summary.counts.delete} delete, ` : ''}${failedCount} failed, ${skippedCount} skipped`,
		{ counts: summary.counts, log: ws.relative(logFile), ms: summary.timing.ms }
	);
	return summary;
}
