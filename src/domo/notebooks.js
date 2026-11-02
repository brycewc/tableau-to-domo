const NOTEBOOK = '/content/v1/cards/notebook';
const enc = encodeURIComponent;

export const LAST_UPDATED = 'DATA_SOURCE_DATA_LAST_UPDATED';
export const DATASET_OWNER = 'DATA_SOURCE_OWNER';

/**
 * @typedef {{ text: string, bold?: boolean, link?: string, color?: string, size?: 'header'|'title'|'subtitle' } | { smart: string, id: string } | { owner: string, id: string, bold?: boolean }} NotebookSegment
 *   Plain text (a link opening `link` in a new window; `color` `#RRGGBB`, `size` a text size), a smart text item, or a
 *   Tableau owner name that becomes owner smart text when it is the dataset owner's
 * @typedef {NotebookSegment[][]} NotebookParagraphs
 */

/**
 * Create an empty Text (notebook v4) card on a page or view, as the editor's "Text v4" item does.
 * Its content is written with updateNotebook: create takes no smart text items.
 * @param {import('./client.js').DomoClient} c
 * @param {{ title: string, pageId?: number|string }} spec
 * @returns {Promise<{ id: number, response: Object }>}
 */
export async function createNotebook(c, { title, pageId }) {
	if (!title) throw new Error('createNotebook: title is required');
	const body = { text: '', title, encoding: 'html', dataFileIds: [], markup: '', version: 'v4', tagMarkup: JSON.stringify({ text: '', tags: [] }), ...(pageId != null ? { pageId: Number(pageId) } : {}) };
	const res = await c.post(NOTEBOOK, body, { idempotent: false });
	const id = res?.id ?? res?.cardId;
	if (id == null) throw new Error(`createNotebook: response had no id: ${JSON.stringify(res).slice(0, 500)}`);
	return { id: Number(id), response: res };
}

/**
 * Write a notebook card's content. A patch: fields left out keep their value, so every update sends all of them.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @param {ReturnType<typeof notebookBody>} body
 */
export async function updateNotebook(c, id, body) {
	return c.post(`${NOTEBOOK}/${enc(id)}/update`, { id: Number(id), ...body });
}

/** @param {import('./client.js').DomoClient} c */
export async function getNotebook(c, id) {
	return c.get(`${NOTEBOOK}/${enc(id)}`);
}

const normName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** True when a Tableau owner name is the Domo dataset owner's name (spacing and case ignored). */
export const sameOwner = (tableauName, domoName) => Boolean(normName(tableauName)) && normName(tableauName) === normName(domoName);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STRONG = { object: 'mark', type: 'strong', data: {} };
const SIZE_MARK = { header: 'header', title: 'h1', subtitle: 'h2' };
const SIZE_HTML = { header: ['h1', 32], title: ['h1', 24], subtitle: ['h2', 18] };
const ALIGN_TAG = { left: 'start', center: 'middle', right: 'end' };
const VALIGN = { top: ['top', 'start', ''], middle: ['center', 'middle', 'centerAlignedContent'], bottom: ['bottom', 'end', 'bottomAlignedContent'] };
const marksOf = (s) => [...(s.size ? [{ object: 'mark', type: SIZE_MARK[s.size], data: {} }] : []), ...(s.bold ? [STRONG] : []), ...(s.color ? [{ object: 'mark', type: 'color', data: { color: s.color } }] : [])];

/** A text segment's html as the editor serializes its marks in the order size, bold, color (html/Serializer.tsx). */
function textHtml(s) {
	const text = escapeHtml(s.text);
	const span = [s.bold && 'font-weight:600', s.color && `color:${s.color}`].filter(Boolean);
	if (!s.size) return span.length ? `<span style="${span.join(';')}">${text}</span>` : text;
	const [tag, px] = SIZE_HTML[s.size];
	const inner = `<${tag} style="margin:inherit;font-weight:inherit;line-height:inherit;color:inherit;display:inline;font-size:${px}px">${text}</${tag}>`;
	if (!span.length) return inner;
	return `<span style="margin:inherit;font-weight:${s.bold ? 600 : 'inherit'};line-height:inherit;color:${s.color ?? 'inherit'};display:inline;font-size:${px}px">${inner}</span>`;
}
const linkHtml = (s) => `<a href="${escapeHtml(s.link)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(s.text)}</a>`;

/**
 * The stored fields of a notebook card for its paragraphs, as the editor saves them (NotebookCardEditor): textHtml, the
 * Slate `markup`, `tagMarkup` (text plus bold ranges; smart text adds no characters), one dynamicTextItems entry and one
 * subscription per smart text item. Without `dataSourceId` the smart text is left out; an owner segment is owner smart
 * text when `ownerSmart`, else plain text. `align` (left, center, right) and `valign` (top, middle, bottom) are the
 * card's text alignment. Pure.
 * @param {NotebookParagraphs} paragraphs
 * @param {{ dataSourceId?: string, ownerSmart?: boolean, align?: 'left'|'center'|'right', valign?: 'top'|'middle'|'bottom' }} [opts]
 */
export function notebookBody(paragraphs, { dataSourceId, ownerSmart = false, align, valign } = {}) {
	const resolved = paragraphs.map((segments) =>
		segments.flatMap((s) => {
			if ('owner' in s) return ownerSmart && dataSourceId ? [{ smart: DATASET_OWNER, id: s.id }] : [{ text: s.owner, bold: s.bold, ...(s.color ? { color: s.color } : {}) }];
			if ('smart' in s) return dataSourceId ? [s] : [];
			return s.text ? [s] : [];
		})
	);
	const items = resolved.flat().filter((s) => 'smart' in s);
	const body = resolved
		.map((segments) => {
			const inner = segments.map((s) => ('smart' in s ? `<dynamic-text data-id="${s.id}"></dynamic-text>` : s.link ? linkHtml(s) : textHtml(s))).join('');
			return `<div>${inner || '<br>'}</div>`;
		})
		.join('');
	const blocks = resolved.map((segments) => {
		const nodes = [];
		let leaves = [];
		const flush = () => {
			nodes.push({ object: 'text', leaves: leaves.length ? leaves : [{ object: 'leaf', text: '', marks: [] }] });
			leaves = [];
		};
		for (const s of segments) {
			if ('smart' in s) {
				flush();
				nodes.push({ object: 'inline', type: 'DynamicText', data: { id: s.id, MarkVoidMarks: [] }, nodes: [{ object: 'text', leaves: [{ object: 'leaf', text: '', marks: [] }] }] });
			} else if (s.link) {
				flush();
				nodes.push({ object: 'inline', type: 'a', data: { configType: 'WEBLINK', url: s.link, openInNewWindow: true, displayName: s.text }, nodes: [{ object: 'text', leaves: [{ object: 'leaf', text: s.text, marks: s.bold ? [STRONG] : [] }] }] });
			} else leaves.push({ object: 'leaf', text: s.text, marks: marksOf(s) });
		}
		flush();
		return { object: 'block', type: 'p', data: {}, nodes };
	});
	let text = '';
	const tags = [];
	resolved.forEach((segments, i) => {
		if (i) text += '\n';
		for (const s of segments) {
			if ('smart' in s) continue;
			if (s.size) tags.push({ type: 'textSize', value: s.size, start: text.length, length: s.text.length });
			if (s.bold) tags.push({ type: 'textStyle', value: 'bold', start: text.length, length: s.text.length });
			if (s.color) tags.push({ type: 'textColor', value: s.color, start: text.length, length: s.text.length });
			if (s.link) tags.push({ type: 'link', value: s.link, newWindow: true, start: text.length, length: s.text.length, contentLength: s.text.length });
			text += s.text;
		}
	});
	const [vert, vertTag, vertClass] = VALIGN[valign] ?? [];
	const horizontal = align && align !== 'left' ? align : undefined;
	let html = `<div style="white-space:pre-wrap">${body}</div>`;
	if (vertClass) html = `<div class="${vertClass}">${html}</div>`;
	if (horizontal) html = `<div style="height:100%;width:100%;text-align:${horizontal}">${html}</div>`;
	const data = { ...(vert ? { vertAlignment: vert } : {}), ...(horizontal ? { horizontalAlignment: horizontal } : {}) };
	return {
		textHtml: html,
		markup: JSON.stringify({ object: 'value', document: { object: 'document', data, nodes: blocks } }),
		tagMarkup: JSON.stringify({ text, tags, ...(vertTag ? { verticalAlignment: vertTag } : {}), ...(horizontal ? { horizontalAlignment: ALIGN_TAG[horizontal] } : {}) }),
		dynamicTextItems: Object.fromEntries(items.map((s) => [s.id, { dataSourceId, type: s.smart }])),
		subscriptions: items.map((s) => ({ name: s.id, dataSourceId, columns: [], filters: [], orderBy: [], groupBy: [], fiscal: false, projection: false, distinct: false, limit: 1, offset: 0 })),
		dataFileIds: []
	};
}
