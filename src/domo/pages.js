import { poll } from '../util/http.js';
import { isStatus } from './client.js';

const LAYOUTS = '/content/v4/pages/layouts';

/** Another user holds the layout's write lock (someone is editing the page or view); there is no takeover. */
export class LayoutLockedError extends Error {
	constructor(layoutId, cause) {
		super(`Layout ${layoutId} is locked by another user editing it: ${cause?.message ?? cause}`, { cause });
		this.name = 'LayoutLockedError';
		this.code = 'push.layout-locked';
		this.layoutId = layoutId;
	}
}

const isLockConflict = (err) => /WL002/.test(String(err?.message ?? '')) || isStatus(err, 409, 423);
const isLockLost = (err) => /WL003/.test(String(err?.message ?? ''));

export const STANDARD_WIDTH = 60;
export const COMPACT_WIDTH = 12;
export const STANDARD_ASPECT_RATIO = 1.67;
export const COMPACT_ASPECT_RATIO = 1.0;

/**
 * @param {import('./client.js').DomoClient} c
 * @param {{ title: string, parentPageId?: number|string }} spec
 * @returns {Promise<number>} pageId
 */
export async function createPage(c, { title, parentPageId }) {
	if (!title) throw new Error('createPage: title is required');
	const body = { title };
	if (parentPageId !== undefined && parentPageId !== null && parentPageId !== '') {
		const parent = Number(parentPageId);
		if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error(`createPage: parentPageId must be a positive integer, got "${parentPageId}"`);
		body.parentPageId = parent;
	}
	const res = await c.post('/content/v1/pages', body);
	const pageId = res?.pageId ?? res?.id;
	if (pageId === undefined) throw new Error(`createPage: response had no pageId: ${JSON.stringify(res).slice(0, 500)}`);
	return pageId;
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function getPage(c, id) {
	return c.get(`/content/v1/pages/${encodeURIComponent(id)}`);
}

/**
 * Rename a page.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @param {{ title: string }} spec
 */
export async function updatePage(c, id, { title }) {
	if (!title) throw new Error('updatePage: title is required');
	return c.put(`/content/v1/pages/${encodeURIComponent(id)}`, { title });
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function deletePage(c, id) {
	return c.del(`/content/v1/pages/${encodeURIComponent(id)}`);
}

/**
 * The page's v4 layout, creating one when the page has none.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} pageId
 * @returns {Promise<Object>} PageLayout incl. layoutId
 */
export async function ensureLayout(c, pageId) {
	const existing = await getLayoutByPage(c, pageId);
	if (existing?.layoutId) return existing;
	try {
		const created = await c.post(LAYOUTS, { pageUrn: String(pageId) });
		if (created?.layoutId) return created;
	} catch (err) {
		// CREATE throws "Layout exists for pageId" on a race with another writer.
		if (!isStatus(err, 400, 409)) throw err;
	}
	const after = await getLayoutByPage(c, pageId);
	if (!after?.layoutId) throw new Error(`Could not create a layout for page ${pageId}`);
	return after;
}

export async function getLayoutByPage(c, pageId) {
	try {
		return await c.get(`/content/v4/pages/${encodeURIComponent(pageId)}/layouts`);
	} catch (err) {
		if (isStatus(err, 404)) return null;
		throw err;
	}
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {number} layoutId
 */
export async function getLayout(c, layoutId) {
	return c.get(`${LAYOUTS}/${encodeURIComponent(layoutId)}`);
}

/**
 * Build the full PageLayout PUT body from the server layout plus new content and templates.
 * @param {Object} existing server PageLayout
 * @param {number|string} pageId
 * @param {{ content: Object[], standard: { template: Object[], width?: number, frameMargin?: number, framePadding?: number }, compact?: { template: Object[], width?: number, frameMargin?: number, framePadding?: number }, isDynamic?: boolean }} layout
 *   `isDynamic`: an app view takes its theme's `pages[0].isDynamic`, as the editor saves it
 */
export function buildLayoutBody(existing, pageId, { content, standard, compact, isDynamic, style }) {
	const prevStandard = existing?.standard || {};
	const prevCompact = existing?.compact || {};
	return {
		...existing,
		layoutId: existing.layoutId,
		pageUrn: String(existing.pageUrn ?? pageId),
		printFriendly: existing.printFriendly ?? false,
		enabled: true,
		isDynamic: isDynamic ?? existing.isDynamic ?? false,
		hasPageBreaks: existing.hasPageBreaks ?? false,
		...(style !== undefined ? { style } : {}),
		content,
		standard: {
			...prevStandard,
			type: 'STANDARD',
			aspectRatio: STANDARD_ASPECT_RATIO,
			width: standard?.width ?? STANDARD_WIDTH,
			frameMargin: standard?.frameMargin ?? prevStandard.frameMargin ?? null,
			framePadding: standard?.framePadding ?? prevStandard.framePadding ?? null,
			template: standard?.template ?? []
		},
		compact: {
			...prevCompact,
			type: 'COMPACT',
			aspectRatio: COMPACT_ASPECT_RATIO,
			width: compact?.width ?? COMPACT_WIDTH,
			...(compact?.frameMargin != null ? { frameMargin: compact.frameMargin } : {}),
			...(compact?.framePadding != null ? { framePadding: compact.framePadding } : {}),
			template: compact?.template ?? []
		}
	};
}

/**
 * Write a page layout: ensure it exists, take the write lock (unlocked updates are rejected), PUT the full layout, release the lock, then wait until a read
 * reflects the new content (writes are eventually consistent).
 *
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} pageId
 * @param {import('../model/types.js').LayoutPlan} layout  with $refs already resolved
 * @param {{ pollIntervalMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<Object>} the layout as read back, with `appendixCardIds` when Domo appended cards the layout leaves out
 */
export async function writeLayout(c, pageId, layout, { pollIntervalMs = 1500, timeoutMs = 60000 } = {}) {
	const existing = await ensureLayout(c, pageId);
	const { layoutId } = existing;
	const body = buildLayoutBody(existing, pageId, layout);
	const lockPath = `${LAYOUTS}/${layoutId}/writelock`;

	const lock = async () => {
		try {
			await c.put(lockPath);
		} catch (err) {
			if (isLockConflict(err)) throw new LayoutLockedError(layoutId, err);
			throw err;
		}
	};
	await lock();
	try {
		try {
			await c.put(`${LAYOUTS}/${layoutId}`, body);
		} catch (err) {
			// A lock that lapsed before the PUT is a 403 WL003, not a permission error (T12): lock again once.
			if (!isLockLost(err)) throw err;
			await lock();
			try {
				await c.put(`${LAYOUTS}/${layoutId}`, body);
			} catch (again) {
				if (isLockLost(again)) throw new LayoutLockedError(layoutId, again);
				throw again;
			}
		}
	} finally {
		try {
			await c.del(lockPath);
		} catch (err) {
			c.emitter.warn(`Could not release the write lock on layout ${layoutId}: ${err.message}`);
		}
	}

	const wanted = contentSignature(body.content);
	const sentKeys = new Set([...body.content, ...body.standard.template].map((item) => item.contentKey));
	let appended = [];
	const written = await poll(
		async () => {
			const current = await getLayout(c, layoutId);
			const appendix = appendixKeys(current, sentKeys);
			const content = (current?.content || []).filter((item) => !appendix.has(item.contentKey));
			if (contentSignature(content) !== wanted) return undefined;
			appended = (current?.content || []).filter((item) => appendix.has(item.contentKey) && item.cardId != null);
			return current;
		},
		{ intervalMs: pollIntervalMs, timeoutMs, label: `layout ${layoutId} to reflect the update` }
	);
	if (appended.length) {
		c.emitter.warn(`Layout ${layoutId} keeps ${appended.length} card(s) the plan does not place (${appended.map((item) => item.cardId).join(', ')}): they are on the page, so Domo put them in an appendix below a page break`);
	}
	return appended.length ? { ...written, appendixCardIds: appended.map((item) => String(item.cardId)) } : written;
}

/** Keys of the appendix Domo adds for cards on the page that a layout PUT leaves out: items it flags `virtualAppendix`, or anything below its first page break. */
function appendixKeys(layout, sentKeys) {
	const template = (layout?.standard?.template || []).filter((item) => !sentKeys.has(item.contentKey));
	const pageBreak = template.find((item) => item.type === 'PAGE_BREAK');
	return new Set(template.filter((item) => item.virtualAppendix === true || (pageBreak && item.y >= pageBreak.y)).map((item) => item.contentKey));
}

function contentSignature(content) {
	return (content || [])
		.map((item) => `${item.contentKey}:${item.type}:${item.cardId ?? ''}`)
		.sort()
		.join('|');
}

/**
 * Ids of a page's subpages (collections excluded). Deleting a page also deletes its subpages,
 * so check this first.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @returns {Promise<number[]>}
 */
export async function getSubpageIds(c, id) {
	const res = await c.get(`/content/v1/pages/${encodeURIComponent(id)}/subpages`);
	return Array.isArray(res) ? res : [];
}

const ANALYZER = '/content/v3/pages';

/** Name of the page filter view push writes from the Tableau filter selections. */
export const DEFAULT_FILTER_VIEW = 'Default';

/**
 * The page's named filter views (saved filters) the current user can see, `isDefault` on the page default.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} pageId  page or App Studio view id
 * @returns {Promise<{ analyzerId: number, name: string, scope: 'PAGE'|'USER', ownerId: string, isDefault: boolean }[]>}
 */
export async function listFilterViews(c, pageId) {
	const res = await c.get(`${ANALYZER}/${encodeURIComponent(pageId)}/analyzer/named`);
	return Array.isArray(res) ? res : [];
}

/** One filter view with its filters. */
export async function getFilterView(c, id) {
	return c.get(`${ANALYZER}/analyzer/${encodeURIComponent(id)}`);
}

function filterViewBody(name, filters, dateRange) {
	const dateTimeRange = dateRange ? { dateTimeRange: dateRange, overrideDateRange: true } : { overrideDateRange: false };
	return { name, type: 'NAMED', scope: 'PAGE', filters, segmentIds: [], dateTimeRange, functionOverrides: {} };
}

/**
 * Create a page-scoped named filter view (scope PAGE needs page edit rights).
 * @returns {Promise<number>} its analyzerId
 */
export async function createFilterView(c, pageId, { name, filters, dateRange }) {
	const res = await c.post(`${ANALYZER}/${encodeURIComponent(pageId)}/analyzer`, filterViewBody(name, filters, dateRange), { idempotent: false });
	const id = res?.analyzerId;
	if (id === undefined || id === null) throw new Error(`createFilterView: response had no analyzerId: ${JSON.stringify(res).slice(0, 300)}`);
	return id;
}

/** Replace a named filter view's name and filters, leaving the caller's own page filter state alone. */
export async function updateFilterView(c, pageId, id, { name, filters, dateRange }) {
	return c.put(`${ANALYZER}/${encodeURIComponent(pageId)}/analyzer`, { ...filterViewBody(name, filters, dateRange), analyzerId: id }, { query: { removePersonalized: false } });
}

/** Make a named filter view the page default for every user (PageAnalyzerServiceV3.saveAsGlobal). */
export async function setDefaultFilterView(c, pageId, id) {
	return c.put(`${ANALYZER}/${encodeURIComponent(pageId)}/analyzer/${encodeURIComponent(id)}/global`);
}

export async function deleteFilterView(c, id) {
	return c.del(`${ANALYZER}/analyzer/${encodeURIComponent(id)}`);
}

const filterKey = (f) =>
	JSON.stringify([String(f.column ?? '').toLowerCase(), String(f.operand ?? '').toUpperCase(), String(f.dataType ?? '').toLowerCase(), [...(f.values ?? [])].map(String).sort(), [...(f.affectedCardUrns ?? [])].map(String).sort()]);

/** Whether two filter lists filter the same way: columns, operands, data types, values and card limits, in any order. */
export function sameFilters(a, b) {
	const keys = (list) => (list ?? []).filter((f) => (f.values ?? []).length).map(filterKey).sort();
	return JSON.stringify(keys(a)) === JSON.stringify(keys(b));
}
