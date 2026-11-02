import { requireDomo } from '../config.js';
import { appViewIds, visibleViewIds } from '../domo/apps.js';
import { linkedPageKeys } from '../convert/app-layout.js';
import { KIND_GROUP, SELECT_KINDS, hasObjectSelection, keyMatcher, mentions, normalizeSelection, planColumns, selectPlan } from '../convert/select.js';
import { createEmitter } from '../util/events.js';
import { createTimer } from '../util/timing.js';
import { sleep } from '../util/http.js';
import { collectRefs } from '../util/refs.js';
import { acquireStateLock, loadState, saveState } from './state.js';
import { writeRunLog } from './runs.js';
import { openWorkspace } from './workspace.js';

const BULK_BEAST_MODES = 500;
const LINK_KINDS = { DATA_SOURCE: 'dataset', CARD: 'card' };
const TEMPLATE_WAIT = { intervalMs: 5000, timeoutMs: 180000 };

/**
 * @typedef {Object} UnpushAction
 * @property {'dataset'|'dataflow'|'variable'|'beastmode'|'app'|'page'|'card'|'layout'|'navigation'} kind
 * @property {string} key
 * @property {string} [name]
 * @property {'delete'|'keep'|'skip'} action   keep = left in Domo (existing dataset, already registered, shared)
 * @property {string|number|null} id
 * @property {'ok'|'failed'|'skipped'|'dry-run'} status
 * @property {string} [error]
 * @property {string[]} [notes]
 *
 * @typedef {Object} UnpushSummary
 * @property {string} slug
 * @property {string} instance
 * @property {boolean} dryRun
 * @property {boolean} ok              No failed actions
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {Record<string, number>} counts
 * @property {UnpushAction[]} actions
 * @property {import('../model/types.js').Issue[]} issues
 * @property {import('../util/timing.js').Timing} [timing]
 */

async function loadDomoDeps(overrides = {}) {
	const need = (key, loader) => overrides[key] ?? loader();
	const [datasets, beastmodes, cards, pages, dataflows, apps, files] = await Promise.all([
		need('datasets', () => import('../domo/datasets.js')),
		need('beastmodes', () => import('../domo/beastmodes.js')),
		need('cards', () => import('../domo/cards.js')),
		need('pages', () => import('../domo/pages.js')),
		need('dataflows', () => import('../domo/dataflows.js')),
		need('apps', () => import('../domo/apps.js')),
		need('files', () => import('../domo/files.js'))
	]);
	return { datasets, beastmodes, cards, pages, dataflows, apps, files };
}

const isNotFound = (err) => Boolean(err && err.status === 404);

function errorMessage(err) {
	return err?.message ? String(err.message).slice(0, 2000) : String(err);
}

function splitRef(ref) {
	const i = ref.indexOf(':');
	return { kind: ref.slice(0, i), key: ref.slice(i + 1) };
}

/**
 * Objects in a plan and who depends on whom, so unpush never removes something a remaining object needs.
 * @param {import('../model/types.js').DomoPlan|null} plan
 */
export function planGraph(plan) {
	/** @type {Map<string, { name?: string, strategy?: string, datasetKey?: string, parentKey?: string, order: number }>} */
	const nodes = new Map();
	/** @type {Map<string, Set<string>>} */
	const dependents = new Map();
	if (!plan) return { nodes, dependents };
	const dep = (needed, by) => {
		if (!dependents.has(needed)) dependents.set(needed, new Set());
		dependents.get(needed).add(by);
	};
	let order = 0;
	for (const ds of plan.datasets ?? []) {
		nodes.set(`dataset:${ds.key}`, { name: ds.name, strategy: ds.strategy, order: order++ });
		for (const r of collectRefs(ds.view)) dep(r, `dataset:${ds.key}`);
	}
	for (const df of plan.dataflows ?? []) {
		const ref = `dataflow:${df.key}`;
		nodes.set(ref, { name: df.name, order: order++ });
		for (const r of collectRefs(df.definition)) dep(r, ref);
		for (const o of df.outputDatasetKeys ?? []) dep(`dataset:${o}`, ref);
	}
	const beastModes = plan.beastModes ?? [];
	const variables = plan.variables ?? [];
	const columns = planColumns(plan);
	for (const v of variables) nodes.set(`variable:${v.key}`, { name: v.name, order: order++ });
	for (const bm of beastModes) {
		const ref = `beastmode:${bm.key}`;
		nodes.set(ref, { name: bm.name, datasetKey: bm.datasetKey, order: order++ });
		dep(`dataset:${bm.datasetKey}`, ref);
		for (const other of beastModes) if (other !== bm && other.datasetKey === bm.datasetKey && mentions(bm.expression, other)) dep(`beastmode:${other.key}`, ref);
		for (const v of variables) if (mentions(bm.expression, v, { columns })) dep(`variable:${v.key}`, ref);
	}
	if (plan.app) {
		nodes.set(`app:${plan.app.key}`, { name: plan.app.title, order: order++ });
		nodes.set(`navigation:${plan.app.key}`, { name: plan.app.title, order: order++ });
		dep(`app:${plan.app.key}`, `navigation:${plan.app.key}`);
	}
	for (const page of plan.pages ?? []) {
		nodes.set(`page:${page.key}`, { name: page.title, parentKey: page.parentKey, order: order++ });
		if (page.parentKey) dep(`page:${page.parentKey}`, `page:${page.key}`);
		if (page.appKey) dep(`app:${page.appKey}`, `page:${page.key}`);
		if (page.filters?.length) {
			nodes.set(`filterview:${page.key}`, { name: page.title, order: order++ });
			dep(`page:${page.key}`, `filterview:${page.key}`);
			for (const r of collectRefs(page.filters)) dep(r, `filterview:${page.key}`);
		}
		if (page.layout) {
			nodes.set(`layout:${page.key}`, { name: page.title, order: order++ });
			dep(`page:${page.key}`, `layout:${page.key}`);
			// Buttons and click actions only link: push leaves them out when their target is gone.
			const placed = (page.layout.content ?? []).filter((item) => item.type !== 'BUTTON').map((item) => ({ ...item, interaction: undefined }));
			for (const r of collectRefs(placed)) dep(r, `layout:${page.key}`);
		}
	}
	for (const card of plan.cards ?? []) {
		const ref = `card:${card.key}`;
		nodes.set(ref, { name: card.title, datasetKey: card.datasetKey, order: order++ });
		for (const pageKey of card.pageKeys ?? []) dep(ref, `page:${pageKey}`);
		const bodies = [card.body ?? null, card.bigNumber ?? null, ...(card.drillPath ?? []).map((v) => v.body)];
		const text = JSON.stringify(bodies);
		for (const r of collectRefs(bodies)) dep(r, ref);
		for (const bm of beastModes) if (bm.datasetKey === card.datasetKey && mentions(text, bm)) dep(`beastmode:${bm.key}`, ref);
		for (const v of variables) if (mentions(text, v, { columns })) dep(`variable:${v.key}`, ref);
	}
	return { nodes, dependents };
}

/** Dependents that disappear together with the object (beast modes with their dataset, layouts with their page, views and navigation with their app). */
function goesWith(dependent, ref) {
	const d = splitRef(dependent).kind;
	const r = splitRef(ref).kind;
	return (d === 'beastmode' && r === 'dataset') || ((d === 'layout' || d === 'filterview') && r === 'page') || (r === 'app' && ['page', 'layout', 'filterview', 'navigation'].includes(d));
}

/**
 * Delete what push created for a workbook, using the push state as the only source of truth: an object is
 * deleted only when its state entry exists, and its entry is removed as soon as it is gone (404 counts as gone),
 * so a re-run continues where it stopped. `existing` datasets and Cloud Amplifier tables that were already
 * registered are never deleted, and neither is an entry another workbook's push shares. An object stays when a
 * remaining object needs it (a card on a dataset, a subpage under a page, a dataflow reading a dataset), and
 * before deleting, the instance is checked for cards, dataflows and views on the dataset, subpages under the page,
 * and cards linked to a beast mode that this unpush does not delete. A dataset another state entry also records is
 * kept. Beast modes on a deleted dataset go with it: each is polled until it 404s (`templateWait`, default 5 s for up
 * to 3 minutes), and one still there with no remaining links is deleted. Others are removed with the bulk template delete.
 * A dry run makes no network calls and writes `unpush-dry-run.json`; a real run writes `unpush-log.json`.
 *
 * @param {{
 *   config: import('../config.js').T2DConfig,
 *   slug: string,
 *   dryRun?: boolean,
 *   selection?: import('../convert/select.js').Selection,
 *   emitter?: import('../util/events.js').Emitter,
 *   plan?: import('../model/types.js').DomoPlan,
 *   deps?: { client?: any, createDomoClient?: Function, datasets?: any, beastmodes?: any, cards?: any, pages?: any, dataflows?: any, apps?: any },
 *   templateWait?: { intervalMs: number, timeoutMs: number }
 * }} opts  Without dashboards/worksheets/datasources in `selection`, every plan object and every state entry stamped
 *   with this workbook is in scope. With one, the selected objects are (pages kept only as parents stay), while the
 *   whole plan still decides what depends on them. `selection.kinds` and `selection.keys` narrow the scope further.
 * @returns {Promise<UnpushSummary>}
 */
export async function unpushPlan(opts) {
	if (opts.dryRun) return unpushUnlocked(opts);
	const ws = openWorkspace(opts.config.workspace);
	const release = await acquireStateLock(ws, requireDomo(opts.config).instance);
	try {
		return await unpushUnlocked(opts);
	} finally {
		await release();
	}
}

async function unpushUnlocked({ config, slug, dryRun = false, selection, emitter = createEmitter(undefined, 'unpush'), plan: planOverride, deps = {}, templateWait = TEMPLATE_WAIT }) {
	const timer = createTimer({ emitter });
	timer.phase('preflight');
	const ws = openWorkspace(config.workspace);
	const p = ws.paths(slug);
	const plan = planOverride ?? (await ws.readJson(p.plan, null));
	const sel = normalizeSelection(selection);
	const subset = hasObjectSelection(sel);
	let selected = plan;
	if (subset) {
		if (!plan) throw new Error(`No plan.json for "${slug}" at ${p.plan}: a dashboard, worksheet or datasource selection needs the plan`);
		selected = selectPlan(plan, sel, { ir: await ws.readJson(p.ir, null).catch(() => null) });
	}
	const kinds = new Set(sel.kinds ?? SELECT_KINDS);
	const keyOk = keyMatcher(sel.keys);
	const inScope = (ref) => {
		const { kind, key } = splitRef(ref);
		return kinds.has(KIND_GROUP[kind]) && keyOk(kind, key);
	};

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
	const objects = dryRun ? { ...state.objects } : state.objects;
	const logFile = dryRun ? p.unpushDryRun : p.unpushLog;
	const { nodes, dependents } = planGraph(plan);

	const candidates = new Set(subset ? planGraph(selected).nodes.keys() : nodes.keys());
	if (subset) {
		for (const key of selected.selection?.containerPages ?? []) {
			candidates.delete(`page:${key}`);
			candidates.delete(`layout:${key}`);
			candidates.delete(`filterview:${key}`);
		}
		if (selected.app) {
			candidates.delete(`app:${selected.app.key}`);
			candidates.delete(`navigation:${selected.app.key}`);
		}
	} else {
		for (const [ref, entry] of Object.entries(objects)) if ((entry?.extra?.workbooks ?? []).includes(slug)) candidates.add(ref);
	}
	const targets = new Set([...candidates].filter((ref) => objects[ref] && inScope(ref)));

	/** @type {UnpushSummary} */
	const summary = { slug, instance, dryRun, ok: true, startedAt: new Date().toISOString(), counts: {}, actions: [], issues: [] };
	const checkpoint = async () => {
		if (!dryRun) await saveState(ws, state);
		await ws.writeJson(logFile, summary);
	};
	const record = async (ref, action, status, extra = {}) => {
		const { kind, key } = splitRef(ref);
		const row = { kind, key, name: nodes.get(ref)?.name ?? key, action, id: extra.id ?? objects[ref]?.id ?? null, status, ...extra };
		summary.actions.push(row);
		summary.counts[action] = (summary.counts[action] || 0) + 1;
		summary.counts[`status:${status}`] = (summary.counts[`status:${status}`] || 0) + 1;
		if (status === 'failed') {
			summary.ok = false;
			emitter.warn(`${kind} "${row.name}" not deleted: ${row.error}`, { ref });
		} else if (status === 'skipped') {
			emitter.warn(`${kind} "${row.name}" left in place: ${row.error}`, { ref });
		} else {
			emitter.progress(`${action} ${kind} "${row.name}"${row.id != null ? ` (${row.id})` : ''}`, { ref, action, status });
		}
		await checkpoint();
	};
	const forget = (ref) => {
		delete objects[ref];
	};
	const pageLeaves = (x) => {
		const { kind, key } = splitRef(x);
		if (kind !== 'page' && kind !== 'layout') return false;
		const pageRef = `page:${key}`;
		return targets.has(pageRef) && !(objects[pageRef]?.extra?.workbooks ?? []).some((w) => w !== slug);
	};
	const blockersOf = (ref) =>
		[...(dependents.get(ref) ?? [])].filter((x) => objects[x] && !goesWith(x, ref) && !(splitRef(ref).kind === 'card' && pageLeaves(x)));
	const blocked = async (ref) => {
		const blockers = blockersOf(ref);
		if (!blockers.length) return false;
		const shown = blockers.slice(0, 5).join(', ') + (blockers.length > 5 ? ', ...' : '');
		await record(ref, 'skip', 'skipped', { error: `still needed by ${shown}` });
		return true;
	};
	const shared = async (ref) => {
		const others = (objects[ref]?.extra?.workbooks ?? []).filter((w) => w !== slug);
		if (!others.length) return false;
		if (!dryRun) objects[ref] = { ...objects[ref], extra: { ...objects[ref].extra, workbooks: others } };
		await record(ref, 'keep', dryRun ? 'dry-run' : 'ok', { notes: [`shared with ${others.join(', ')}`] });
		return true;
	};
	const deletedCardIds = new Set();
	const deletedIds = new Set();
	const withDataset = [];
	const deleteWith = async (ref, call, notes = []) => {
		const id = objects[ref].id;
		if (dryRun) {
			forget(ref);
			await record(ref, 'delete', 'dry-run', { id, notes });
			return true;
		}
		try {
			await call(id);
		} catch (err) {
			if (!isNotFound(err)) {
				await record(ref, 'delete', 'failed', { id, error: errorMessage(err), notes });
				return false;
			}
			notes = [...notes, 'already deleted'];
		}
		deletedIds.add(`${splitRef(ref).kind}:${id}`);
		forget(ref);
		await record(ref, 'delete', 'ok', { id, notes });
		return true;
	};
	const byKind = (kind) => [...targets].filter((r) => splitRef(r).kind === kind);
	const planOrder = (r) => nodes.get(r)?.order ?? Number.MAX_SAFE_INTEGER;

	emitter.step(`${dryRun ? 'Dry run: would remove' : 'Removing'} ${targets.size} object(s) of "${slug}" recorded in state for ${instance}`);

	/** A variable or image card push found on the instance rather than created: another workspace or a person owns it. */
	const adopted = async (ref) => {
		if (!objects[ref]?.extra?.adopted) return false;
		const id = objects[ref].id;
		if (!dryRun) forget(ref);
		await record(ref, 'keep', dryRun ? 'dry-run' : 'ok', { id, notes: ['found on the instance by an earlier push, not created by it'] });
		return true;
	};

	timer.phase('cards');
	/* 1. Cards. */
	const leavingPageIds = new Set([...byKind('page').map((r) => String(objects[r].id)), ...byKind('app').map((r) => objects[r].extra?.defaultViewId).filter((v) => v != null).map(String)]);
	const placedElsewhere = async (ref) => {
		if (dryRun || !d.cards.listCardPlacements) return false;
		let placements;
		try {
			placements = await d.cards.listCardPlacements(c, objects[ref].id);
		} catch (err) {
			if (isNotFound(err)) return false;
			await record(ref, 'delete', 'failed', { error: `could not list the pages and views that show it: ${errorMessage(err)}` });
			return true;
		}
		const foreign = placements.filter((p) => p.kind === 'report' || !leavingPageIds.has(p.id));
		if (!foreign.length) return false;
		const where = foreign.slice(0, 5).map((p) => `${p.kind} ${p.id}${p.title ? ` "${p.title}"` : ''}`).join(', ');
		summary.issues.push({
			severity: 'warning',
			code: 'unpush.card-foreign-placement',
			message: `Card "${nodes.get(ref)?.name ?? objects[ref].id}" (${objects[ref].id}) was kept: ${foreign.length} page(s) or view(s) this unpush does not delete show it (${where})`,
			suggestion: 'Remove the card from those pages or views, then run unpush again.'
		});
		await record(ref, 'skip', 'skipped', { error: `shown on ${where}, which this unpush does not delete` });
		return true;
	};
	for (const ref of byKind('card').sort((a, b) => planOrder(a) - planOrder(b))) {
		if ((await shared(ref)) || (await adopted(ref)) || (await blocked(ref))) continue;
		if (objects[ref].extra?.section) {
			await deleteWith(ref, (fileId) => d.files.deleteDataFile(c, fileId), ['the section background image file of a view']);
			continue;
		}
		if (await placedElsewhere(ref)) continue;
		const id = objects[ref].id;
		const notes = dryRun ? ['unless a page or view this unpush does not delete shows it (checked only on a real run), in which case it is kept'] : [];
		const dataFileId = objects[ref].extra?.kind === 'image' ? objects[ref].extra.dataFileId : undefined;
		if (dataFileId != null) notes.push(`and its image file ${dataFileId}`);
		const drillIds = (objects[ref].extra?.drillViews ?? []).map((v) => String(v.id));
		if (drillIds.length) notes.push(`and its ${drillIds.length} drill view(s), which Domo deletes with it`);
		// Deleting a document card leaves its data file, so the file goes too, also when the card was already gone.
		const call = async (cardId) => {
			const gone = await d.cards.deleteCard(c, cardId).then(() => undefined, (err) => {
				if (!isNotFound(err)) throw err;
				return err;
			});
			if (dataFileId != null) await d.files.deleteDataFile(c, dataFileId);
			if (gone) throw gone;
		};
		if (await deleteWith(ref, call, notes)) {
			deletedCardIds.add(String(id));
			for (const drillId of drillIds) {
				deletedCardIds.add(drillId);
				deletedIds.add(`card:${drillId}`);
			}
		}
	}

	timer.phase('apps-pages');
	/* 2. Apps with their views, layouts and navigation; then pages, subpages first, with their layouts. */
	const isView = (ref) => objects[ref]?.extra?.container === 'app';
	const forgetWith = async (ref, note) => {
		for (const r of [ref, `layout:${splitRef(ref).key}`, `filterview:${splitRef(ref).key}`]) {
			if (!objects[r]) continue;
			const id = objects[r].id;
			forget(r);
			targets.delete(r);
			await record(r, 'delete', dryRun ? 'dry-run' : 'ok', { id, notes: [note] });
		}
	};
	const viewsOf = (appId) => Object.keys(objects).filter((r) => r.startsWith('page:') && isView(r) && String(objects[r].extra.appId) === String(appId));

	for (const ref of byKind('app')) {
		if ((await shared(ref)) || (await blocked(ref))) continue;
		const appId = objects[ref].id;
		const views = viewsOf(appId);
		const staying = views.filter((v) => !targets.has(v) || (objects[v].extra?.workbooks ?? []).some((w) => w !== slug) || blockersOf(v).length);
		if (staying.length) {
			await record(ref, 'skip', 'skipped', { error: `its view(s) ${staying.slice(0, 5).join(', ')} stay (shared, still needed or not in scope), and deleting the app would delete them` });
			continue;
		}
		if (!dryRun) {
			let app;
			try {
				app = await d.apps.getApp(c, appId);
			} catch (err) {
				if (!isNotFound(err)) {
					await record(ref, 'delete', 'failed', { error: `could not read the app: ${errorMessage(err)}` });
					continue;
				}
			}
			if (app) {
				const ours = new Set([...views.map((v) => String(objects[v].id)), String(objects[ref].extra?.defaultViewId)]);
				const foreign = appViewIds(app).filter((id) => !ours.has(String(id)));
				if (foreign.length) {
					summary.issues.push({
						severity: 'warning',
						code: 'unpush.app-foreign-views',
						message: `App "${nodes.get(ref)?.name ?? appId}" (${appId}) was kept: it has ${foreign.length} view(s) t2d did not create (${foreign.slice(0, 5).join(', ')})`,
						suggestion: 'Move or delete those views in App Studio, then run unpush again.'
					});
					await record(ref, 'skip', 'skipped', { error: `has view(s) ${foreign.slice(0, 5).join(', ')} that t2d did not create; deleting the app would delete them` });
					continue;
				}
				try {
					await d.apps.setSavedThemes(c, appId, []);
				} catch (err) {
					if (!isNotFound(err)) {
						await record(ref, 'delete', 'failed', { error: `could not clear its saved themes: ${errorMessage(err)}` });
						continue;
					}
				}
			}
		}
		const notes = ['permanent: App Studio apps have no trash; its views, layouts, navigation, app chart palettes and users\' landing entries go with it'];
		if (dryRun) notes.push('unless the app has views t2d did not create (checked only on a real run), in which case it is kept');
		if (!(await deleteWith(ref, (id) => d.apps.deleteApp(c, id), notes))) continue;
		for (const v of views) await forgetWith(v, 'removed with its app');
		const navRef = `navigation:${splitRef(ref).key}`;
		if (objects[navRef]) {
			const id = objects[navRef].id;
			forget(navRef);
			targets.delete(navRef);
			await record(navRef, 'delete', dryRun ? 'dry-run' : 'ok', { id, notes: ['removed with its app'] });
		}
	}

	/** Delete one view of an app that stays (subset unpush). The app's last visible view cannot be deleted. */
	async function unpushView(ref) {
		const appId = objects[ref].extra.appId;
		if (!dryRun) {
			let app;
			try {
				app = await d.apps.getApp(c, appId);
			} catch (err) {
				if (!isNotFound(err)) {
					await record(ref, 'delete', 'failed', { error: `could not read its app ${appId}: ${errorMessage(err)}` });
					return;
				}
				await forgetWith(ref, 'its app is already deleted');
				return;
			}
			const visible = visibleViewIds(app).filter((id) => String(id) !== String(objects[ref].id) && !deletedIds.has(`page:${id}`));
			if (!visible.length) {
				await record(ref, 'skip', 'skipped', { error: `it is the last visible view of app ${appId}, which App Studio cannot delete; unpush the whole workbook to delete the app` });
				return;
			}
		}
		const notes = dryRun ? ['unless it is the last visible view of its app (checked only on a real run), in which case it is kept'] : [];
		if (await deleteWith(ref, (id) => d.apps.deleteView(c, appId, id), notes)) await forgetWith(`layout:${splitRef(ref).key}`, 'removed with its view');
	}

	const depth = (ref) => {
		let n = 0;
		for (let parent = nodes.get(ref)?.parentKey, seen = new Set(); parent && !seen.has(parent); parent = nodes.get(`page:${parent}`)?.parentKey) {
			seen.add(parent);
			n++;
		}
		return n;
	};
	for (const ref of byKind('page').filter((r) => objects[r]).sort((a, b) => depth(b) - depth(a) || planOrder(a) - planOrder(b))) {
		if ((await shared(ref)) || (await blocked(ref))) continue;
		if (isView(ref)) {
			await unpushView(ref);
			continue;
		}
		const { key } = splitRef(ref);
		const layoutRef = `layout:${key}`;
		if (!dryRun) {
			try {
				const subpages = await d.pages.getSubpageIds(c, objects[ref].id);
				if (subpages.length) {
					await record(ref, 'skip', 'skipped', { error: `has subpage(s) ${subpages.slice(0, 5).join(', ')} that this unpush does not delete; deleting the page would delete them too` });
					continue;
				}
			} catch (err) {
				if (!isNotFound(err)) {
					await record(ref, 'delete', 'failed', { error: `could not list subpages: ${errorMessage(err)}` });
					continue;
				}
			}
		}
		if (await deleteWith(ref, (pageId) => d.pages.deletePage(c, pageId))) {
			for (const withPage of [layoutRef, `filterview:${key}`]) {
				if (!objects[withPage]) continue;
				const id = objects[withPage].id;
				forget(withPage);
				targets.delete(withPage);
				await record(withPage, 'delete', dryRun ? 'dry-run' : 'ok', { id, notes: ['removed with its page'] });
			}
		}
	}
	for (const ref of [...byKind('layout'), ...byKind('filterview')].filter((r) => objects[r])) {
		await record(ref, 'skip', 'skipped', { error: `${splitRef(ref).kind === 'layout' ? 'layouts' : 'filter views'} are removed with their pages; include pages to remove it` });
	}
	for (const ref of byKind('navigation').filter((r) => objects[r])) {
		await record(ref, 'skip', 'skipped', { error: 'the navigation is removed with its app; include app to remove it' });
	}

	timer.phase('dataflows');
	/* 3. Dataflows (their output datasets are datasets in state and follow below). */
	for (const ref of byKind('dataflow').sort((a, b) => planOrder(b) - planOrder(a))) {
		if ((await shared(ref)) || (await blocked(ref))) continue;
		await deleteWith(ref, (id) => d.dataflows.deleteDataflow(c, id));
	}

	timer.phase('datasets');
	/* 4. Datasets: views and dataflow outputs before their inputs. */
	const strategyOf = (ref) => objects[ref]?.extra?.strategy ?? nodes.get(ref)?.strategy;
	const rank = (ref) => ({ view: 0, 'dataflow-output': 1 })[strategyOf(ref)] ?? 2;
	const keptInDomo = (ref, entry) => strategyOf(ref) === 'existing' || Boolean(entry?.extra?.alreadyRegistered || entry?.extra?.ownershipUncertain);
	for (const ref of byKind('dataset').sort((a, b) => rank(a) - rank(b) || planOrder(b) - planOrder(a))) {
		if (await shared(ref)) continue;
		const entry = objects[ref];
		const strategy = strategyOf(ref);
		if (keptInDomo(ref, entry)) {
			forget(ref);
			const why =
				strategy === 'existing'
					? 'existing dataset (mapped, not created by t2d); never deleted'
					: entry.extra?.alreadyRegistered
						? 'Cloud Amplifier table was registered before t2d; left registered'
						: 'Cloud Amplifier registration was retried after an error, so t2d cannot tell whether it created this dataset; left registered, delete it in Domo if t2d made it';
			if (!entry.extra?.alreadyRegistered && strategy !== 'existing') {
				summary.issues.push({ severity: 'warning', code: 'unpush.ownership-uncertain', message: `Dataset "${nodes.get(ref)?.name ?? ref}" (${entry.id}) was kept: ${why}` });
			}
			await record(ref, 'keep', dryRun ? 'dry-run' : 'ok', { id: entry.id, notes: [why] });
			continue;
		}
		if (await blocked(ref)) continue;
		const sameId = Object.entries(objects)
			.filter(([other, e]) => other !== ref && other.startsWith('dataset:') && e?.id != null && String(e.id) === String(entry.id))
			.filter(([other, e]) => !(targets.has(other) && keptInDomo(other, e) && !(e.extra?.workbooks ?? []).some((w) => w !== slug)))
			.map(([other]) => other);
		if (sameId.length) {
			await record(ref, 'skip', 'skipped', { error: `the same Domo dataset is also recorded as ${sameId.slice(0, 5).join(', ')}; deleting it would break that object` });
			continue;
		}
		const notes =
			strategy === 'cloud-amplifier'
				? ['Cloud Amplifier dataset only; the integration and the warehouse table stay']
				: strategy === 'federated'
					? ['federated DataSet only; the account and the database table stay']
					: [];
		if (!dryRun) {
			try {
				const foreign = (await d.cards.listDatasetCards(c, entry.id)).filter((card) => !deletedCardIds.has(String(card.id)));
				if (foreign.length) {
					await record(ref, 'skip', 'skipped', { error: `${foreign.length} card(s) not deleted by this unpush use it (${foreign.slice(0, 5).map((x) => x.id).join(', ')}); deleting the dataset would delete them` });
					continue;
				}
			} catch (err) {
				if (!isNotFound(err)) {
					await record(ref, 'delete', 'failed', { error: `could not list the cards on it: ${errorMessage(err)}` });
					continue;
				}
			}
			if (d.datasets.listDownstream) {
				try {
					const down = await d.datasets.listDownstream(c, entry.id);
					const users = [
						...down.dataflows.filter((id) => !deletedIds.has(`dataflow:${id}`)).map((id) => `dataflow ${id}`),
						...down.datasets.filter((id) => !deletedIds.has(`dataset:${id}`)).map((id) => `dataset ${id}`)
					];
					if (users.length) {
						await record(ref, 'skip', 'skipped', { error: `${users.length} object(s) not deleted by this unpush read it (${users.slice(0, 5).join(', ')}); deleting it would break them` });
						continue;
					}
				} catch (err) {
					if (!isNotFound(err)) {
						await record(ref, 'delete', 'failed', { error: `could not read its lineage: ${errorMessage(err)}` });
						continue;
					}
				}
			}
		}
		if (!(await deleteWith(ref, (id) => d.datasets.deleteDataset(c, id), notes))) continue;
		const { key } = splitRef(ref);
		for (const [bmRef, bm] of Object.entries(objects)) {
			if (!bmRef.startsWith('beastmode:')) continue;
			const onDataset = nodes.get(bmRef)?.datasetKey === key || (bm.extra?.datasetId != null && String(bm.extra.datasetId) === String(entry.id));
			if (!onDataset) continue;
			targets.delete(bmRef);
			if (dryRun) {
				forget(bmRef);
				await record(bmRef, 'delete', 'dry-run', { id: bm.id, notes: ['removed with its dataset'] });
			} else {
				withDataset.push(bmRef);
			}
		}
	}

	if (withDataset.length) await settleDatasetBeastModes(withDataset);

	/**
	 * Dataset beast modes disappear asynchronously after their dataset is deleted, and deleting one before then
	 * fails with "active links". Wait for each to 404; delete those still there with no links left.
	 */
	async function settleDatasetBeastModes(refs) {
		emitter.progress(`Waiting for ${refs.length} beast mode(s) to be removed with their dataset(s)`, { refs });
		const deadline = Date.now() + templateWait.timeoutMs;
		let pending = [...refs];
		const lastSeen = new Map();
		for (;;) {
			const still = [];
			for (const bmRef of pending) {
				try {
					const template = await d.beastmodes.getBeastMode(c, objects[bmRef].id);
					still.push(bmRef);
					lastSeen.set(bmRef, template);
				} catch (err) {
					if (isNotFound(err)) {
						const id = objects[bmRef].id;
						forget(bmRef);
						await record(bmRef, 'delete', 'ok', { id, notes: ['removed with its dataset'] });
					} else {
						still.push(bmRef);
						lastSeen.set(bmRef, err);
					}
				}
			}
			pending = still;
			if (!pending.length || Date.now() >= deadline) break;
			await sleep(templateWait.intervalMs);
		}
		for (const bmRef of pending) {
			const seen = lastSeen.get(bmRef);
			if (seen instanceof Error) {
				await record(bmRef, 'delete', 'failed', { error: `still present after its dataset was deleted, and could not be read: ${errorMessage(seen)}` });
				continue;
			}
			const links = (seen?.links ?? []).filter((l) => l?.active !== false && l?.resource?.id != null && !deletedIds.has(`${LINK_KINDS[l.resource.type] ?? l.resource.type}:${l.resource.id}`));
			if (links.length) {
				await record(bmRef, 'skip', 'skipped', { error: `still present after its dataset was deleted and linked to ${links.slice(0, 5).map((l) => `${l.resource.type} ${l.resource.id}`).join(', ')}` });
				continue;
			}
			await deleteWith(bmRef, (id) => d.beastmodes.deleteBeastModes(c, [id]), ['still present after its dataset was deleted']);
		}
	}

	const templateLinks = new Map();
	/** False (and recorded) when a card this unpush does not delete is linked to the template; the bulk delete would break it. */
	const unusedByOtherCards = async (ref) => {
		if (dryRun) return true;
		let template;
		try {
			template = await d.beastmodes.getBeastMode(c, objects[ref].id);
		} catch (err) {
			if (isNotFound(err)) return true;
			await record(ref, 'delete', 'failed', { error: `could not read the cards linked to it: ${errorMessage(err)}` });
			return false;
		}
		templateLinks.set(String(objects[ref].id), template?.links ?? []);
		const cards = [
			...new Set(
				(template?.links ?? [])
					.filter((l) => l?.resource?.type === 'CARD' && l.active !== false && l.resource.id != null && !deletedCardIds.has(String(l.resource.id)))
					.map((l) => String(l.resource.id))
			)
		];
		if (cards.length) {
			await record(ref, 'skip', 'skipped', { error: `${cards.length} card(s) not deleted by this unpush use it (${cards.slice(0, 5).join(', ')}); deleting it would break them` });
			return false;
		}
		if (splitRef(ref).kind !== 'variable') return true;
		const others = [];
		for (const l of template?.links ?? []) {
			const id = l?.resource?.id;
			if (l?.resource?.type !== 'FUNCTION_TEMPLATE' || l.active === false || id == null || deletedIds.has(`beastmode:${id}`)) continue;
			if (await d.beastmodes.getBeastMode(c, id).then(() => true, (err) => !isNotFound(err))) others.push(String(id));
		}
		if (!others.length) return true;
		await record(ref, 'skip', 'skipped', { error: `${others.length} beast mode(s) not deleted by this unpush use it (${others.slice(0, 5).join(', ')}); deleting it would break them` });
		return false;
	};

	timer.phase('beastmodes-variables');
	/* 5. Remaining beast modes (bulk template delete), then variables one by one so their default controls go too. */
	for (const kind of ['beastmode', 'variable']) {
		const ready = [];
		for (const ref of byKind(kind).filter((r) => objects[r]).sort((a, b) => planOrder(a) - planOrder(b))) {
			if ((await shared(ref)) || (await adopted(ref)) || (await blocked(ref)) || !(await unusedByOtherCards(ref))) continue;
			ready.push(ref);
		}
		if (kind === 'variable') {
			for (const ref of ready) {
				await deleteWith(ref, dryRun ? null : async (id) => {
					try {
						await d.beastmodes.deleteTemplate(c, id);
					} catch (err) {
						if (isNotFound(err)) throw err;
						const template = await d.beastmodes.getBeastMode(c, id);
						await d.beastmodes.deleteBeastModes(c, [id], { unlink: { [id]: template?.links ?? [] } });
						emitter.warn(`Variable ${id} was deleted through the bulk endpoint (${err.message}); Domo may keep its default variable control`);
					}
				});
			}
			continue;
		}
		for (let i = 0; i < ready.length; i += BULK_BEAST_MODES) {
			const batch = ready.slice(i, i + BULK_BEAST_MODES);
			if (dryRun) {
				for (const ref of batch) await deleteWith(ref, null);
				continue;
			}
			try {
				await d.beastmodes.deleteBeastModes(
					c,
					batch.map((r) => objects[r].id),
					{ unlink: templateLinks }
				);
				for (const ref of batch) await deleteWith(ref, async () => {});
			} catch {
				for (const ref of batch) {
					await deleteWith(ref, async (id) => {
						const template = await d.beastmodes.getBeastMode(c, id);
						await d.beastmodes.deleteBeastModes(c, [id], { unlink: { [id]: template?.links ?? [] } });
					});
				}
			}
		}
	}

	const deletedPages = new Set(summary.actions.filter((a) => a.kind === 'page' && a.action === 'delete' && a.status !== 'failed').map((a) => a.key));
	for (const page of deletedPages.size ? plan?.pages ?? [] : []) {
		if (!objects[`layout:${page.key}`]) continue;
		const gone = [...linkedPageKeys(page.layout)].filter((k) => deletedPages.has(k));
		if (!gone.length) continue;
		summary.issues.push({
			severity: 'warning',
			code: 'unpush.links-stale',
			message: `View "${page.title}" stays and still has buttons or click actions that open the deleted view(s) ${gone.map((k) => `"${nodes.get(`page:${k}`)?.name ?? k}"`).join(', ')}`,
			object: { type: 'page', name: page.title },
			suggestion: `Push this view's layout again (t2d push --keys layout:${page.key}) to drop those links.`
		});
	}

	summary.ok = !summary.actions.some((a) => a.status === 'failed');
	summary.timing = timer.finish({ slug, dryRun });
	summary.finishedAt = summary.timing.finishedAt;
	await checkpoint();
	if (!dryRun) await writeRunLog(ws, slug, 'unpush', summary);
	const c2 = summary.counts;
	emitter.done(`${dryRun ? 'Dry run' : 'Unpush'} finished: ${c2.delete || 0} delete, ${c2.keep || 0} keep, ${c2['status:skipped'] || 0} left in place, ${c2['status:failed'] || 0} failed`, {
		counts: summary.counts,
		log: ws.relative(logFile),
		ms: summary.timing.ms
	});
	return summary;
}
