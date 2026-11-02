import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { requireDomo, requireTableau } from '../config.js';
import { keyMatcher } from '../convert/select.js';
import { createEmitter } from '../util/events.js';
import { collectRefs } from '../util/refs.js';
import { loadState } from './state.js';
import { openWorkspace } from './workspace.js';

/**
 * @typedef {'ok'|'differs'|'not-comparable'} VerifyStatus
 *
 * @typedef {Object} ColumnCheck
 * @property {string} domo                     Domo column label
 * @property {string} tableau                  Matching Tableau view data header
 * @property {'dimension'|'measure'} role
 * @property {boolean} ok
 * @property {number} [tableauTotal]           measure: sum over the view rows
 * @property {number} [domoTotal]
 * @property {number} [allowed]                measure: allowed absolute difference
 * @property {false} [compared]                measure: totals not compared (sampled or limited data)
 * @property {string[]} [missingInDomo]        dimension: members only Tableau shows (first few)
 * @property {string[]} [extraInDomo]          dimension: members only Domo shows (first few)
 * @property {number} [tableauMembers]
 * @property {number} [domoMembers]
 *
 * @typedef {Object} CardVerification
 * @property {string} key
 * @property {string} title
 * @property {string} worksheet
 * @property {string|number} [cardId]
 * @property {VerifyStatus} status
 * @property {string} [view]                   Tableau view name the data came from
 * @property {number} [sampled]                The card's dataset holds only the first N rows per table
 * @property {{ tableau: number, domo: number, ok: boolean|null }} [rows]
 * @property {ColumnCheck[]} [columns]
 * @property {string[]} [unmatched]            Domo columns with no Tableau header
 * @property {string[]} notes
 *
 * @typedef {Object} VerifySummary
 * @property {string} slug
 * @property {string} instance
 * @property {boolean} ok                      No card differs
 * @property {number} tolerance                Relative tolerance for measure totals
 * @property {number} [sampled]
 * @property {CardVerification[]} cards
 * @property {Record<VerifyStatus, number>} counts
 * @property {string} verifiedAt
 */

const NULL_MEMBER = '(null)';
const TOTAL_MEMBER = 'all';
const NULL_TEXT = new Set(['', 'null', '(null)', '%null%']);
const NUMERIC_TYPES = new Set(['LONG', 'DOUBLE', 'DECIMAL', 'NUMBER', 'INTEGER']);
const DIMENSION_MAPPINGS = new Set(['ITEM', 'SERIES', 'ROW', 'COLUMN', 'CATEGORY', 'GROUP', 'PIVOT', 'LABEL']);
const AGG_PREFIX = /^(sum of|average of|avg\.?|count of|distinct count of|count distinct of|countd of|minimum of|maximum of|min\.?|max\.?|median of|attr|agg|std\.? dev\.? of|variance of)\s+/i;
const AGG_CALL = /^(sum|avg|count|countd|cntd|min|max|median|attr|agg|ctd)\s*\((.*)\)$/i;
const EXAMPLES = 5;
const RENDER_ROW_LIMIT = 250000;

/** Header and rows of a Tableau view data CSV. */
export function parseViewCsv(text) {
	const records = parse(String(text ?? ''), { bom: true, relax_column_count: true, skip_empty_lines: true });
	const [header = [], ...rows] = records;
	return { header, rows };
}

/**
 * Number from a formatted Tableau value ("4,065", "$1.2", "(3)", "12.5%"), or null.
 * @param {any} value
 * @returns {{ value: number, decimals: number }|null}
 */
export function parseNumber(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? { value, decimals: decimalsOf(String(value)) } : null;
	let text = String(value ?? '').trim();
	if (!text) return null;
	let sign = 1;
	if (/^\(.*\)$/.test(text)) {
		sign = -1;
		text = text.slice(1, -1);
	}
	let scale = 1;
	if (text.endsWith('%')) {
		scale = 0.01;
		text = text.slice(0, -1);
	}
	text = text.replace(/[$€£¥\s]/g, '');
	if (!/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?(e[-+]?\d+)?$/i.test(text) || !/\d/.test(text)) return null;
	const n = Number(text.replace(/,/g, ''));
	if (!Number.isFinite(n)) return null;
	return { value: sign * n * scale, decimals: decimalsOf(text) + (scale === 1 ? 0 : 2) };
}

function decimalsOf(text) {
	const m = /\.(\d+)/.exec(text);
	return m ? m[1].length : 0;
}

/** Column label reduced for matching: quotes, case and aggregation wording removed. */
export function normalizeName(name, { stripAggregation = false } = {}) {
	let text = String(name ?? '')
		.trim()
		.replace(/^"+|"+$/g, '')
		.trim();
	if (stripAggregation) {
		const call = AGG_CALL.exec(text);
		if (call) text = call[2];
		text = text.replace(AGG_PREFIX, '');
	}
	return text.toLowerCase().replace(/\s+/g, ' ');
}

const pad = (n) => String(n).padStart(2, '0');

/** Comparable form of a dimension member. */
export function normalizeMember(value, { type } = {}) {
	if (value === null || value === undefined) return NULL_MEMBER;
	if (typeof value === 'number' && (type === 'DATE' || type === 'DATETIME') && Math.abs(value) > 1e11) return isoDate(new Date(value));
	// A link column (convert/url-columns.js) shows only the anchor text.
	const text = String(value)
		.trim()
		.replace(/^<a\s[^>]*>([\s\S]*)<\/a>$/i, '$1');
	if (NULL_TEXT.has(text.toLowerCase())) return NULL_MEMBER;
	const date = parseDateText(text);
	if (date) return date;
	const n = parseNumber(text);
	if (n && !/^0\d/.test(text)) return String(n.value);
	return text.toLowerCase();
}

function isoDate(d) {
	const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
	return time === '00:00:00' ? day : `${day} ${time}`;
}

function parseDateText(text) {
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/.exec(text);
	if (m) return isoDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))));
	m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)?)?$/i.exec(text);
	if (m) {
		let hour = +(m[4] ?? 0);
		if (m[7]) hour = (hour % 12) + (/p/i.test(m[7]) ? 12 : 0);
		return isoDate(new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], hour, +(m[5] ?? 0), +(m[6] ?? 0))));
	}
	return null;
}

/**
 * Columns and rows of a card render (PUT /content/v1/cards/kpi/{id}/render?parts=dynamic,summary).
 * Columns named in `grouped` (the card's group-by columns or their aliases) are dimensions even when numeric.
 * @param {any} render
 * @param {{ grouped?: Set<string> }} [opts]
 * @returns {{ columns: { name: string, mapping: string, type: string, role: 'dimension'|'measure' }[], rows: any[][], limited: boolean }|null}
 */
export function renderData(render, { grouped = new Set() } = {}) {
	const sources = render?.chart?.datasources ?? render?.dynamic?.chart?.datasources;
	const source = sources ? Object.values(sources)[0] : null;
	const data = source?.data;
	if (!data || !Array.isArray(data.rows)) return null;
	const names = data.aliases ?? data.columns ?? [];
	const columns = names.map((name, i) => {
		const mapping = String(data.mappings?.[i] ?? '').toUpperCase();
		const type = String(data.metadata?.[i]?.type ?? '').toUpperCase();
		const isGrouped = grouped.has(String(name)) || grouped.has(String(data.columns?.[i] ?? ''));
		const role = NUMERIC_TYPES.has(type) && !DIMENSION_MAPPINGS.has(mapping) && !isGrouped ? 'measure' : 'dimension';
		return { name: String(name), mapping, type, role };
	});
	const capped = Number(data.limit) > 0 && data.rows.length >= Number(data.limit);
	return { columns, rows: data.rows, limited: Boolean(source.limited || render?.limited || capped) };
}

/** Names and aliases of the group-by columns of a card's main subscription. */
export function groupedColumns(card) {
	const main = card?.body?.definition?.subscriptions?.main;
	const keys = new Set((main?.groupBy ?? []).map((g) => g.formulaId ?? g.column));
	const out = new Set();
	for (const col of main?.columns ?? []) {
		if (!keys.has(col.formulaId ?? col.column)) continue;
		out.add(col.column);
		if (col.alias) out.add(col.alias);
	}
	return out;
}

/** The page's default filters (its "Default" filter view) on the card's dataset, as render query overrides. */
export function pageFilterOverrides(card, page) {
	const dataset = `dataset:${card.datasetKey}`;
	return (page?.filters ?? [])
		.filter((f) => (!f.dataSourceId || f.dataSourceId.$ref === dataset) && (!f.affectedCards || f.affectedCards.includes(card.key)))
		.map((f) => ({ column: f.column, dataType: f.dataType, operand: f.operand, values: f.values }));
}

/** Long Measure Names / Measure Values view data turned into one column per measure. */
export function pivotMeasureValues({ header, rows }) {
	const lower = header.map((h) => normalizeName(h));
	const namesAt = lower.indexOf('measure names');
	const valuesAt = lower.indexOf('measure values');
	if (namesAt < 0 || valuesAt < 0) return { header, rows };
	const keep = header.map((_, i) => i).filter((i) => i !== namesAt && i !== valuesAt);
	const measures = [];
	const groups = new Map();
	for (const row of rows) {
		const measure = row[namesAt] ?? '';
		if (!measures.includes(measure)) measures.push(measure);
		const dims = keep.map((i) => row[i] ?? '');
		const id = JSON.stringify(dims);
		if (!groups.has(id)) groups.set(id, { dims, values: {} });
		groups.get(id).values[measure] = row[valuesAt];
	}
	return {
		header: [...keep.map((i) => header[i]), ...measures],
		rows: [...groups.values()].map((g) => [...g.dims, ...measures.map((m) => g.values[m] ?? '')])
	};
}

/**
 * Pair Domo columns with Tableau headers: exact label first, then without aggregation wording.
 * @returns {{ pairs: { domo: number, tableau: number }[], unmatched: number[] }}
 */
export function matchColumns(domoNames, tableauHeader) {
	const used = new Set();
	const pairs = [];
	const pending = [];
	const find = (name, strip) => tableauHeader.findIndex((h, i) => !used.has(i) && normalizeName(h, { stripAggregation: strip }) === normalizeName(name, { stripAggregation: strip }));
	domoNames.forEach((name, d) => {
		const t = find(name, false);
		if (t >= 0) {
			used.add(t);
			pairs.push({ domo: d, tableau: t });
		} else pending.push(d);
	});
	const unmatched = [];
	for (const d of pending) {
		const t = find(domoNames[d], true);
		if (t >= 0) {
			used.add(t);
			pairs.push({ domo: d, tableau: t });
		} else unmatched.push(d);
	}
	pairs.sort((a, b) => a.domo - b.domo);
	return { pairs, unmatched };
}

function sample(values) {
	return [...values].slice(0, EXAMPLES);
}

/**
 * Compare a Tableau view's data with a Domo card render, at the level of the dimensions both show.
 * Sampled data is only checked for consistency (Domo rows and members within Tableau's).
 * @param {{ tableau: { header: string[], rows: string[][] }, domo: ReturnType<typeof renderData>, tolerance?: number, sampled?: number }} input
 * @returns {Pick<CardVerification, 'status'|'rows'|'columns'|'unmatched'|'notes'> & { score: number }}
 */
export function compareCardData({ tableau, domo, tolerance = 0.005, sampled }) {
	const notes = [];
	const view = pivotMeasureValues(tableau);
	const { pairs, unmatched } = matchColumns(
		domo.columns.map((c) => c.name),
		view.header
	);
	const score = domo.columns.length ? pairs.length / domo.columns.length : 0;
	const unmatchedNames = unmatched.map((i) => domo.columns[i].name);
	if (!pairs.length) {
		return { status: 'not-comparable', score, unmatched: unmatchedNames, notes: [`no Domo column matches the Tableau view data (${view.header.join(', ')})`] };
	}
	if (unmatchedNames.length) notes.push(`not in the Tableau view data: ${unmatchedNames.join(', ')}`);
	const extraTableau = view.header.filter((_, i) => !pairs.some((p) => p.tableau === i));
	if (extraTableau.length) notes.push(`not on the Domo card: ${extraTableau.join(', ')}`);

	const dims = pairs.filter((p) => domo.columns[p.domo].role === 'dimension');
	const measures = pairs.filter((p) => domo.columns[p.domo].role === 'measure');
	const columns = [];
	let ok = true;

	// Tableau view data has its totals as rows with the member "All"; a Domo table card renders them apart from its rows.
	const totalDims = dims.filter((p) => !domo.rows.some((r) => normalizeMember(r[p.domo]) === TOTAL_MEMBER));
	const isTotal = (r) => totalDims.some((p) => normalizeMember(r[p.tableau]) === TOTAL_MEMBER);
	const totals = view.rows.filter(isTotal).length;
	if (totals) {
		view.rows = view.rows.filter((r) => !isTotal(r));
		notes.push(`${totals} Tableau total row(s) ("All") left out`);
	}

	const groupCount = (rows, pick) => new Set(rows.map((r) => JSON.stringify(pick(r)))).size;
	const tableauRows = groupCount(view.rows, (r) => dims.map((p) => normalizeMember(r[p.tableau])));
	const domoRows = groupCount(domo.rows, (r) => dims.map((p) => normalizeMember(r[p.domo], { type: domo.columns[p.domo].type })));
	let rowsOk = null;
	if (domo.limited) notes.push('the Domo render was limited (row cap); row counts and totals are partial');
	else if (sampled) rowsOk = domoRows <= tableauRows;
	else rowsOk = domoRows === tableauRows;
	if (rowsOk === false) ok = false;

	for (const p of dims) {
		const col = domo.columns[p.domo];
		const t = new Set(view.rows.map((r) => normalizeMember(r[p.tableau])));
		const d = new Set(domo.rows.map((r) => normalizeMember(r[p.domo], { type: col.type })));
		const missing = [...t].filter((m) => !d.has(m));
		const extra = [...d].filter((m) => !t.has(m));
		const colOk = extra.length === 0 && (Boolean(sampled) || domo.limited || missing.length === 0);
		if (!colOk) ok = false;
		columns.push({
			domo: col.name,
			tableau: view.header[p.tableau],
			role: 'dimension',
			ok: colOk,
			tableauMembers: t.size,
			domoMembers: d.size,
			...(missing.length ? { missingInDomo: sample(missing) } : {}),
			...(extra.length ? { extraInDomo: sample(extra) } : {})
		});
	}

	for (const p of [...measures, ...pivotedMeasures(view, domo, pairs, unmatched)]) {
		const col = domo.columns[p.domo];
		let tableauTotal = 0;
		let decimals = 0;
		let parsed = 0;
		for (const r of p.member === undefined ? view.rows : view.rows.filter((row) => normalizeMember(row[p.by]) === p.member)) {
			const n = parseNumber(r[p.tableau]);
			if (!n) continue;
			parsed++;
			tableauTotal += n.value;
			decimals = Math.max(decimals, n.decimals);
		}
		let domoTotal = 0;
		for (const r of domo.rows) {
			const n = typeof r[p.domo] === 'number' ? r[p.domo] : parseNumber(r[p.domo])?.value;
			if (Number.isFinite(n)) domoTotal += n;
		}
		const rounding = parsed * 0.5 * 10 ** -decimals;
		const allowed = Math.max(tolerance * Math.max(Math.abs(tableauTotal), Math.abs(domoTotal)), rounding);
		const compared = !sampled && !domo.limited;
		const colOk = compared ? Math.abs(tableauTotal - domoTotal) <= allowed + 1e-9 : true;
		if (!colOk) ok = false;
		const tableauName = p.member === undefined ? view.header[p.tableau] : `${view.header[p.tableau]} where ${view.header[p.by]} = ${col.name}`;
		columns.push({ domo: col.name, tableau: tableauName, role: 'measure', ok: colOk, tableauTotal: round(tableauTotal), domoTotal: round(domoTotal), allowed: round(allowed), ...(compared ? {} : { compared: false }) });
	}
	if (sampled) notes.push(`sampled data (${sampled} rows per table): totals not compared`);
	return { status: ok ? 'ok' : 'differs', score, rows: { tableau: tableauRows, domo: domoRows, ok: rowsOk }, columns, unmatched: unmatchedNames, notes };
}

/** Domo measure columns named after the members of a Tableau dimension (a crosstab pivoted on it), each matched to the
 * one Tableau measure summed over that member's rows. */
function pivotedMeasures(view, domo, pairs, unmatched) {
	const loose = view.header.map((_, i) => i).filter((i) => !pairs.some((p) => p.tableau === i));
	const numeric = (i) => {
		const filled = view.rows.filter((r) => !NULL_TEXT.has(String(r[i] ?? '').trim().toLowerCase()));
		return filled.length > 0 && filled.every((r) => parseNumber(r[i]));
	};
	const values = loose.filter(numeric);
	if (values.length !== 1) return [];
	const wanted = unmatched.filter((i) => domo.columns[i].role === 'measure');
	for (const by of loose.filter((i) => i !== values[0])) {
		const members = new Set(view.rows.map((r) => normalizeMember(r[by])));
		const hits = wanted.filter((i) => members.has(normalizeMember(domo.columns[i].name)));
		if (hits.length) return hits.map((i) => ({ domo: i, tableau: values[0], by, member: normalizeMember(domo.columns[i].name) }));
	}
	return [];
}

function round(n) {
	return Math.round(n * 1e6) / 1e6;
}

/** Card render body; the card's own filters stay as saved, `filters` are added like a page filter. */
export async function renderCard(domo, cardId, { filters = [], limit = RENDER_ROW_LIMIT } = {}) {
	return domo.put(`/content/v1/cards/kpi/${encodeURIComponent(cardId)}/render`, { queryOverrides: { filters, limit }, width: 800, height: 400, scale: 1 }, { query: { parts: 'dynamic,summary' } });
}

/**
 * Sampled row count of the dataset a card reads: extract-time sampling (plan or data manifests), push-time sampling
 * (`push --sample-rows`, recorded in the push state), or either one on a dataset a dataflow or view builds it from.
 */
export function sampledRows(plan, datasetKey, manifests, state, seen = new Set()) {
	if (seen.has(datasetKey)) return undefined;
	seen.add(datasetKey);
	const pushed = state?.objects?.[`dataset:${datasetKey}`]?.extra?.sampled;
	if (pushed) return pushed;
	const ds = (plan.datasets ?? []).find((d) => d.key === datasetKey);
	if (ds?.upload?.sampled) return ds.upload.sampled;
	if (ds?.datasourceId) {
		const m = manifests.find((x) => x.datasourceId === ds.datasourceId);
		if (m?.sampled) return m.sampled;
	}
	const sources = [...(ds ? collectRefs(ds) : []), ...(plan.dataflows ?? []).filter((df) => (df.outputDatasetKeys ?? []).includes(datasetKey)).flatMap((df) => [...collectRefs(df.definition)])];
	for (const r of sources) {
		if (!r.startsWith('dataset:')) continue;
		const found = sampledRows(plan, r.slice('dataset:'.length), manifests, state, seen);
		if (found) return found;
	}
	return undefined;
}

async function readManifests(dataDir) {
	let files;
	try {
		files = (await fs.promises.readdir(dataDir)).filter((f) => f.endsWith('.manifest.json'));
	} catch {
		return [];
	}
	const out = [];
	for (const f of files) {
		try {
			out.push(JSON.parse(await fs.promises.readFile(path.join(dataDir, f), 'utf8')));
		} catch {
			/* unreadable manifests only lose sample detection */
		}
	}
	return out;
}

const viewKey = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Compare pushed cards with the Tableau views they came from. Read-only on Tableau and Domo; writes
 * the downloaded view data and `verify.json` into the workbook directory.
 * @param {{
 *   config: import('../config.js').T2DConfig,
 *   slug: string,
 *   tolerance?: number,
 *   keys?: string[],
 *   emitter?: import('../util/events.js').Emitter,
 *   deps?: { tableau?: any, domo?: any, listViews?: (client: any, workbookLuid: string) => Promise<any[]> }
 * }} opts
 * @returns {Promise<VerifySummary>}
 */
export async function verifyWorkbook({ config, slug, tolerance = 0.005, keys, emitter = createEmitter(undefined, 'verify'), deps = {} }) {
	const ws = openWorkspace(config.workspace);
	const p = ws.paths(slug);
	const plan = await ws.readJson(p.plan, null);
	if (!plan) throw new Error(`No plan for "${slug}". Run t2d convert --workbook ${slug} first.`);
	const workbookLuid = plan.source?.luid;
	if (!workbookLuid) throw new Error(`The plan for "${slug}" has no Tableau workbook luid (extracted from a file?); verify needs the workbook on Tableau.`);
	const instance = deps.domo ? (deps.domo.instance ?? config.domo?.instance) : requireDomo(config).instance;
	const state = await loadState(ws, instance);
	const manifests = await readManifests(p.dataDir);
	const match = keyMatcher(keys);
	const pagesByKey = new Map((plan.pages ?? []).map((pg) => [pg.key, pg]));

	const domo =
		deps.domo ??
		(await import('../domo/client.js')).createDomoClient({ instance, accessToken: config.domo.accessToken }, { emitter: emitter.child('domo') });

	const results = [];
	const cards = (plan.cards ?? []).filter((c) => c.status !== 'unsupported' && match('card', c.key));
	const pending = [];
	for (const card of cards) {
		const result = { key: card.key, title: card.title, worksheet: card.worksheet ?? '', status: 'not-comparable', notes: [] };
		const sampled = sampledRows(plan, card.datasetKey, manifests, state);
		if (sampled) result.sampled = sampled;
		results.push(result);
		const entry = state.objects[`card:${card.key}`];
		if (!entry?.id) {
			result.notes.push(`not pushed to ${instance}`);
			continue;
		}
		result.cardId = entry.id;
		if (card.kind === 'notebook') {
			try {
				const notebook = await domo.get(`/content/v1/cards/notebook/${encodeURIComponent(entry.id)}`);
				const items = typeof notebook?.dynamicTextItems === 'string' ? JSON.parse(notebook.dynamicTextItems || '{}') : notebook?.dynamicTextItems ?? {};
				result.notes.push(`text card with ${Object.keys(items).length} smart text item(s): no Tableau view data to compare`);
			} catch (err) {
				result.notes.push(`text card could not be read: ${err?.message ?? err}`);
			}
			continue;
		}
		if (card.kind === 'image') {
			result.notes.push('image card: no Tableau view data to compare');
			continue;
		}
		if (!card.worksheet) {
			result.notes.push('filter card: no Tableau view to compare');
			continue;
		}
		pending.push({ card, result });
	}

	const views = new Map();
	let tableau = null;
	let signedIn = false;
	if (pending.length) {
		tableau = deps.tableau;
		if (!tableau) {
			requireTableau(config);
			const { TableauClient } = await import('../tableau/client.js');
			tableau = new TableauClient(config.tableau, { emitter: emitter.child('tableau') });
		}
	}
	try {
		if (tableau) {
			if (!deps.tableau) {
				await tableau.signIn();
				signedIn = true;
			}
			const listViews = deps.listViews ?? (await import('../tableau/content.js')).listWorkbookViews;
			for (const v of await listViews(tableau, workbookLuid)) views.set(viewKey(v.name), v);
			emitter.info(`${views.size} published view(s) for "${plan.source.workbook}"`);
		}

		const viewData = new Map();
		const loadView = async (view) => {
			if (!viewData.has(view.id)) {
				const file = path.join(p.dir, 'verify', `${view.id}.csv`);
				viewData.set(
					view.id,
					tableau
						.download(`/views/${encodeURIComponent(view.id)}/data`, file)
						.then(async () => ({ data: parseViewCsv(await fs.promises.readFile(file, 'utf8')) }))
						.catch((err) => ({ error: err?.message ?? String(err) }))
				);
			}
			return viewData.get(view.id);
		};

		const byDashboard = new Map();
		const render = async (item, page) => {
			const { card, result } = item;
			emitter.progress(`Rendering card ${result.cardId} "${card.title}"`);
			const filters = pageFilterOverrides(card, page);
			if (filters.length) result.notes.push(`rendered with the default filters of view "${page.title}": ${filters.map((f) => `${f.column} ${f.operand} ${f.values.join(', ')}`).join('; ')}`);
			try {
				item.domo = renderData(await renderCard(domo, result.cardId, { filters }), { grouped: groupedColumns(card) });
				if (!item.domo) result.notes.push('the Domo render returned no data rows');
			} catch (err) {
				result.notes.push(`Domo render failed: ${err?.message ?? err}`);
			}
			return Boolean(item.domo);
		};
		for (const item of pending) {
			const { card, result } = item;
			const direct = views.get(viewKey(card.worksheet));
			const pages = (card.pageKeys ?? []).map((k) => pagesByKey.get(k)).filter(Boolean);
			if (direct) {
				result.view = direct.name;
				if (!(await render(item, pages.find((pg) => viewKey(pg.dashboard ?? '') === viewKey(direct.name)) ?? pages[0]))) continue;
				const loaded = await loadView(direct);
				if (loaded.error) result.notes.push(`Tableau view data failed: ${loaded.error}`);
				else Object.assign(result, finish(compareCardData({ tableau: loaded.data, domo: item.domo, tolerance, sampled: result.sampled }), result));
				continue;
			}
			const dashboardPage = pages.find((pg) => pg.dashboard && views.get(viewKey(pg.dashboard)));
			const dashboardView = dashboardPage && views.get(viewKey(dashboardPage.dashboard));
			if (!dashboardView) {
				result.notes.push(`worksheet "${card.worksheet}" is not published as a view${pages.some((pg) => pg.dashboard) ? ' and its dashboard has no view' : ''}`);
				continue;
			}
			if (!(await render(item, dashboardPage))) continue;
			if (!byDashboard.has(dashboardView.id)) byDashboard.set(dashboardView.id, { view: dashboardView, items: [] });
			byDashboard.get(dashboardView.id).items.push(item);
		}

		for (const { view, items } of byDashboard.values()) {
			const loaded = await loadView(view);
			if (loaded.error) {
				for (const { result } of items) result.notes.push(`Tableau view data for dashboard "${view.name}" failed: ${loaded.error}`);
				continue;
			}
			const scored = items.map((item) => ({ item, cmp: compareCardData({ tableau: loaded.data, domo: item.domo, tolerance, sampled: item.result.sampled }) }));
			const best = scored.filter((s) => s.cmp.score >= 0.5).sort((a, b) => b.cmp.score - a.cmp.score)[0];
			for (const s of scored) {
				const { result } = s.item;
				if (s === best) {
					result.view = view.name;
					Object.assign(result, finish(s.cmp, result));
					result.notes.unshift(`worksheet is not published as a view; matched to dashboard "${view.name}" view data by its columns`);
				} else {
					result.notes.push(`worksheet "${result.worksheet}" is not published as a view; dashboard "${view.name}" view data holds another sheet (${loaded.data.header.join(', ')})`);
				}
			}
		}
	} finally {
		if (signedIn) await tableau.signOut().catch(() => {});
	}

	const counts = { ok: 0, differs: 0, 'not-comparable': 0 };
	for (const r of results) counts[r.status]++;
	const sampled = results.map((r) => r.sampled).find(Boolean);
	const summary = {
		slug,
		instance,
		ok: counts.differs === 0,
		tolerance,
		...(sampled ? { sampled } : {}),
		cards: results,
		counts,
		verifiedAt: new Date().toISOString()
	};
	await ws.writeJson(path.join(p.dir, 'verify.json'), summary);
	if (sampled) emitter.warn(`Card data comes from a sample (${sampled} rows per table); totals cannot match Tableau. Extract and push again without --sample-rows to verify totals.`);
	emitter.done(`${counts.ok} ok, ${counts.differs} differ, ${counts['not-comparable']} not comparable`);
	return summary;
}

function finish(cmp, result) {
	const { notes, ...rest } = cmp;
	delete rest.score;
	return { ...rest, notes: [...result.notes, ...notes] };
}
