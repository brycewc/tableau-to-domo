const KPI = '/content/v3/cards/kpi';

// Dataset not yet indexed, page not yet visible, or a per-dataset deadlock.
export const CARD_RETRY_STATUSES = [400, 404, 500];
const CARD_CREATE_RETRY_STATUSES = [400, 404];
const CARD_RETRIES = 6;

/**
 * Create an Analyzer (KPI) card.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {{ dataProvider: { dataSourceId: string }, definition: Object, variables?: boolean, columns?: boolean }} body
 * @param {{ pageId?: number|string, retries?: number }} [opts]
 * @returns {Promise<{ id: number, urn: string, response: Object }>}
 */
export async function createCard(c, body, { pageId, retries = CARD_RETRIES } = {}) {
	const res = await c.put(KPI, normalizeBody(body), {
		query: pageId !== undefined && pageId !== null ? { pageId } : undefined,
		retryOn: CARD_CREATE_RETRY_STATUSES,
		retries,
		idempotent: false
	});
	const id = res?.id ?? (res?.urn !== undefined ? Number(res.urn) : undefined);
	if (id === undefined || Number.isNaN(id)) throw new Error(`createCard: response had no id: ${JSON.stringify(res).slice(0, 500)}`);
	return { id, urn: String(res?.urn ?? id), response: res };
}

/**
 * Replace an Analyzer card definition.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @param {Object} body same shape as createCard
 * @param {{ retries?: number }} [opts]
 */
export async function updateCard(c, id, body, { retries = CARD_RETRIES } = {}) {
	return c.put(`${KPI}/${encodeURIComponent(id)}`, normalizeBody(body), { retryOn: CARD_RETRY_STATUSES, retries });
}

/**
 * Read a card for editing. The returned `definition` is in read shape; pass it
 * through toWriteShape before sending it back.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function getCardDefinition(c, id) {
	return c.put(`${KPI}/definition`, { urn: String(id), dynamicText: true, variables: true, columns: false });
}

/** The values of `column` under a resolved card body's filters and formulas, from a render preview (nothing is saved). */
export async function previewMembers(c, body, column) {
	const { definition, dataProvider } = normalizeBody(body);
	const main = definition.subscriptions.main;
	const preview = {
		...definition,
		// Read shape: a filter on an unsaved formula keeps no row in a preview unless the formula says isAggregatable.
		formulas: definition.formulas.card.map(({ templateId: _templateId, ...f }) => ({ ...f, dataType: String(f.dataType ?? '').toUpperCase() || undefined, isAggregatable: !f.aggregated })),
		annotations: [],
		conditionalFormats: [],
		segments: { active: [], definitions: [] },
		charts: { main: { ...definition.charts.main, chartType: 'badge_basic_table', overrides: {} } },
		subscriptions: { main: { ...main, columns: [{ ...column, mapping: 'ITEM' }], groupBy: [column], orderBy: [], limit: undefined } }
	};
	const res = await c.put(`${KPI}/render/preview`, { definition: preview, dataProvider, chartRequest: { width: 400, height: 300 } }, { query: { parts: 'dynamic' }, retryOn: CARD_RETRY_STATUSES, retries: CARD_RETRIES });
	const data = Object.values(res?.chart?.datasources ?? {})[0]?.data;
	return (data?.rows ?? []).map((row) => row[0]);
}

export function documentCardBody(name, dataFileId) {
	return { type: 'document', description: name, metadata: { title: name, documentId: `${dataFileId}:undefined`, usingSampleData: '', kpiType: 'document', description: name } };
}

/**
 * Create a document card on a page or view.
 * @param {import('./client.js').DomoClient} c
 * @param {{ name: string, dataFileId: number|string, pageId?: number|string }} opts
 * @returns {Promise<{ id: number }>}
 */
export async function createDocumentCard(c, { name, dataFileId, pageId }) {
	const res = await c.post('/content/v1/cards', documentCardBody(name, dataFileId), {
		query: pageId != null ? { pageId } : undefined,
		retryOn: CARD_CREATE_RETRY_STATUSES,
		retries: CARD_RETRIES,
		idempotent: false
	});
	const id = res?.id ?? (res?.urn !== undefined ? Number(res.urn) : undefined);
	if (id === undefined || Number.isNaN(id)) throw new Error(`createDocumentCard: response had no id: ${JSON.stringify(res).slice(0, 300)}`);
	return { id };
}

export async function updateDocumentCard(c, id, { name, dataFileId }) {
	return c.put(`/content/v1/cards/${encodeURIComponent(id)}`, documentCardBody(name, dataFileId));
}

/** Appended under the last view of the card's drill path. */
export async function createDrillView(c, rootId, body, { retries = CARD_RETRIES } = {}) {
	const res = await c.put(KPI, normalizeBody(body), { query: { parentUrn: rootId }, retryOn: CARD_CREATE_RETRY_STATUSES, retries, idempotent: false });
	const id = res?.id;
	if (id == null) throw new Error(`createDrillView: response had no id: ${JSON.stringify(res).slice(0, 500)}`);
	return { id, urn: String(res.urn ?? drillUrn(id, rootId)) };
}

/** A drill view is updated through its `dr:` urn only; its plain id is a 400 "Unable to find card id in urn". */
export async function updateDrillView(c, rootId, drillId, body, { retries = CARD_RETRIES } = {}) {
	return c.put(`${KPI}/${drillUrn(drillId, rootId)}`, normalizeBody(body), { retryOn: CARD_RETRY_STATUSES, retries });
}

/** In drill order. Deleting one (deleteCard) links the rest up; deleting the card deletes them all. */
export async function listDrillViews(c, rootId) {
	const res = await c.get('/content/v1/cards', { query: { urns: String(rootId), parts: 'drillPathURNs' } });
	const card = (Array.isArray(res) ? res : []).find((x) => String(x?.id) === String(rootId));
	return (card?.drillPathURNs ?? []).map((urn) => ({ id: Number(String(urn).split(':')[1]), urn: String(urn) })).filter((v) => !Number.isNaN(v.id));
}

const drillUrn = (drillId, rootId) => `dr:${drillId}:${rootId}`;

/**
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function deleteCard(c, id) {
	return c.del(`/content/v1/cards/${encodeURIComponent(id)}`);
}

function normalizeBody(body) {
	if (!body?.dataProvider?.dataSourceId) throw new Error('card body needs dataProvider.dataSourceId');
	if (!body.definition) throw new Error('card body needs a definition');
	return {
		...body,
		variables: body.variables ?? true,
		columns: body.columns ?? false,
		definition: uniqueNewFormulaIds(toWriteShape(body.definition))
	};
}

/**
 * Card formulas not yet saved carry a negative templateId; the server keys them by it and answers duplicates with a
 * bare 400.
 */
function uniqueNewFormulaIds(definition) {
	const card = definition?.formulas?.card;
	if (!Array.isArray(card)) return definition;
	const isNew = (f) => typeof f?.templateId === 'number' && f.templateId < 0;
	const fresh = card.filter(isNew);
	if (new Set(fresh.map((f) => f.templateId)).size === fresh.length) return definition;
	let next = 0;
	const renumbered = card.map((f) => (isNew(f) ? { ...f, templateId: --next } : f));
	return { ...definition, formulas: { ...definition.formulas, card: renumbered } };
}

/**
 * Convert a card definition from the read shape (`/definition` returns arrays for
 * formulas, annotations, conditionalFormats and a preview object for segments) to
 * the write shape. Already write-shaped fields pass through; missing ones get empty defaults because
 * the server dereferences formulas without a null check.
 *
 * Dataset beast modes in the read `formulas` array are dropped: they live on the
 * dataset, and resending them in `dsUpdated` would rewrite them.
 *
 * On KPI cards Domo keeps the dynamic title and ignores `title` when both are sent, so a
 * non-empty `title` replaces a TEXT-only (or absent) `dynamicTitle` with one TEXT item. A dynamic title with other
 * items (a VARIABLE_VALUE) is sent as it is, without `title`.
 *
 * @param {Object} definition
 * @returns {Object}
 */
export function toWriteShape(definition) {
	const out = { ...definition };

	const formulas = definition.formulas;
	if (Array.isArray(formulas)) {
		out.formulas = { card: formulas.filter((f) => !f.persistedOnDataSource), dsUpdated: [], dsDeleted: [] };
	} else {
		out.formulas = { card: formulas?.card ?? [], dsUpdated: formulas?.dsUpdated ?? [], dsDeleted: formulas?.dsDeleted ?? [] };
	}

	const annotations = definition.annotations;
	out.annotations = Array.isArray(annotations) || !annotations
		? { new: [], modified: [], deleted: [] }
		: { new: annotations.new ?? [], modified: annotations.modified ?? [], deleted: annotations.deleted ?? [] };

	const formats = definition.conditionalFormats;
	if (Array.isArray(formats)) {
		out.conditionalFormats = {
			card: formats.filter((f) => f.cardId !== undefined && f.cardId !== null),
			datasource: formats.filter((f) => f.cardId === undefined || f.cardId === null)
		};
	} else {
		out.conditionalFormats = { card: formats?.card ?? [], datasource: formats?.datasource ?? [] };
	}

	const segments = definition.segments;
	if (Array.isArray(segments) || !segments) {
		out.segments = { active: [], create: [], update: [], delete: [] };
	} else {
		out.segments = {
			active: segments.active ?? [],
			create: segments.create ?? [],
			update: segments.update ?? [],
			delete: segments.delete ?? []
		};
	}

	out.controls = Array.isArray(definition.controls) ? definition.controls : [];
	const items = definition.dynamicTitle?.text;
	if (Array.isArray(items) && items.some((item) => item?.type !== 'TEXT')) delete out.title;
	else if (typeof definition.title === 'string' && definition.title) {
		out.dynamicTitle = { ...definition.dynamicTitle, text: [{ type: 'TEXT', text: definition.title }] };
	}
	return out;
}

/**
 * A card's title from either definition shape. Read with `dynamicText: true`, `title` is null and the title is the
 * TEXT (and default text) items of `dynamicTitle`, joined with spaces.
 * @param {Object} [definition]
 * @returns {string|undefined}
 */
export function cardTitle(definition) {
	if (definition?.title) return definition.title;
	const items = definition?.dynamicTitle?.text;
	if (!Array.isArray(items)) return undefined;
	const text = items
		.map((item) => item?.text ?? item?.defaultText)
		.filter((v) => typeof v === 'string' && v.trim())
		.map((v) => v.trim())
		.join(' ');
	return text || undefined;
}

/**
 * Add or replace the summary number (`big_number` subscription) with a
 * read-modify-write; the create endpoint strips it.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} cardId
 * Card formulas get new ids when the card is saved, so ids of `cardFormulas` (the formulas the card was
 * created with) in the subscription are mapped to the saved formula of the same name.
 *
 * @param {Object} bigNumberSubscription  subscription body; name is forced to 'big_number'
 * @param {{ dataSourceId?: string, cardFormulas?: { id: string, name?: string }[] }} [opts]
 */
export async function applyBigNumber(c, cardId, bigNumberSubscription, { dataSourceId, cardFormulas = [] } = {}) {
	const current = await getCardDefinition(c, cardId);
	const definition = toWriteShape(current?.definition || {});
	bigNumberSubscription = remapFormulaIds(bigNumberSubscription, cardFormulas, definition.formulas.card);
	const subscriptions = { ...(definition.subscriptions || {}) };
	const datasetId = dataSourceId || subscriptions.main?.dataSourceId;
	if (!datasetId) throw new Error(`applyBigNumber: could not determine the dataset of card ${cardId}`);
	subscriptions.big_number = {
		groupBy: [],
		orderBy: [],
		filters: [],
		fiscal: false,
		projection: false,
		distinct: false,
		...bigNumberSubscription,
		name: 'big_number'
	};
	definition.subscriptions = subscriptions;
	return updateCard(c, cardId, { definition, dataProvider: { dataSourceId: datasetId }, variables: true, columns: false });
}

function remapFormulaIds(value, planned, saved) {
	const byName = new Map(saved.filter((f) => f?.name).map((f) => [f.name, f.id]));
	const ids = new Map(planned.filter((f) => f?.id && byName.has(f.name) && byName.get(f.name) !== f.id).map((f) => [f.id, byName.get(f.name)]));
	if (!ids.size) return value;
	const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : ids.get(v) ?? v);
	return walk(value);
}

/**
 * Cards built on a dataset.
 * @param {import('./client.js').DomoClient} c
 * @param {string} datasetId
 * @returns {Promise<{ id: number, urn?: string, title?: string }[]>}
 */
export async function listDatasetCards(c, datasetId) {
	const res = await c.get(`/content/v1/datasources/${encodeURIComponent(datasetId)}/cards`);
	return Array.isArray(res) ? res : [];
}

/**
 * Cards by id with their type and metadata (a document card's `metadata.documentId` is `<dataFileId>:...`); missing ids
 * are left out.
 * @param {import('./client.js').DomoClient} c
 * @param {(number|string)[]} ids
 * @returns {Promise<Object[]>}
 */
export async function getCardSummaries(c, ids) {
	if (!ids.length) return [];
	const res = await c.get('/content/v1/cards', { query: { urns: ids.map(String).join(','), parts: 'metadata' } });
	return Array.isArray(res) ? res : [];
}

/**
 * Every page, App Studio view and report page that shows a card, whoever can see it.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} cardId
 * @returns {Promise<{ kind: 'page'|'view'|'report', id: string, title?: string }[]>}
 */
export async function listCardPlacements(c, cardId) {
	const res = await c.get('/content/v1/cards', { query: { urns: String(cardId), parts: 'adminAllPages' } });
	const card = (Array.isArray(res) ? res : []).find((x) => String(x?.id) === String(cardId));
	if (!card) return [];
	return [
		...(card.adminAllPages ?? []).map((p) => ({ kind: 'page', id: String(p.pageId), title: p.title })),
		...(card.adminAllAppPages ?? []).map((p) => ({ kind: 'view', id: String(p.appPageId), title: p.appPageTitle })),
		...(card.adminAllReportPages ?? []).map((p) => ({ kind: 'report', id: String(p.reportPageId), title: p.reportPageTitle }))
	];
}
