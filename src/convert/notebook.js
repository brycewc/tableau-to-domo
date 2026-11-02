import { ref } from '../util/refs.js';
import { slugify, uuidv5 } from '../util/ids.js';
import { LAST_UPDATED_ITEM } from './cards.js';
import { opaqueHex } from './app-layout.js';

/**
 * Text (notebook) cards for status sheets: a worksheet that shows only its title, with <Data Update Time> and often the
 * owner's name in it. The card keeps the title's bold runs, shows the update time as "Date last updated" smart text and
 * the owner as text, which push turns into owner smart text when the Domo dataset owner has that name.
 *
 * @typedef {import('../domo/notebooks.js').NotebookParagraphs} NotebookParagraphs
 */

const UPDATE_TIME = /^<Data Update Time>$/i;
const OWNER_LABEL = /\bowner\b/i;
const SPACE = /^[ \t\xa0]$/;
const ALIGN = { left: 'left', center: 'center', right: 'right' };

/**
 * The title of a status sheet as notebook paragraphs: one per title line, runs merged by boldness (spaces at the edge of
 * a bold run are not bold), <Sheet Name> filled in, other field tokens left out, and the value of an `Owner ... : value`
 * part (between `|`s) an owner segment. Smart text and owner ids are uuidv5 of the card key and their position.
 * @param {import('../model/types.js').WorksheetIR} ws
 * @param {string} cardKey
 * @returns {{ paragraphs: NotebookParagraphs, dropped: string[], owner?: string, updateTime: boolean, align: 'left'|'center'|'right' }}
 */
export function notebookParagraphs(ws, cardKey, { colors = false } = {}) {
	const runs = ws.titleRuns?.length ? ws.titleRuns : [{ text: ws.title ?? '' }];
	const dropped = [];
	const lines = [[]];
	for (const run of runs) {
		const text = String(run.text ?? '').replace(/\r\n?/g, '\n').replace(/<Sheet Name>/gi, ws.name);
		for (const piece of text.split(/(<[^<>]+>|\n)/)) {
			if (piece === '\n') lines.push([]);
			else if (/^<[^<>]+>$/.test(piece)) {
				if (UPDATE_TIME.test(piece)) lines.at(-1).push({ smart: true });
				else dropped.push(piece.slice(1, -1));
			} else {
				const color = colors ? opaqueHex(run.color) : undefined;
				for (const ch of piece) lines.at(-1).push({ ch, bold: Boolean(run.bold), ...(color ? { color } : {}) });
			}
		}
	}
	let next = 0;
	const id = () => uuidv5(`notebook|${cardKey}|${next++}`);
	let owner;
	let updateTime = false;
	const paragraphs = [];
	for (const atoms of lines) {
		const tidy = collapse(atoms);
		if (!tidy.length) continue;
		markOwner(tidy, (name) => {
			owner ??= name;
		});
		const segments = [];
		for (const a of tidy) {
			const last = segments.at(-1);
			if (a.smart) {
				updateTime = true;
				segments.push({ smart: LAST_UPDATED_ITEM, id: id() });
			} else if (a.owner !== undefined) segments.push({ owner: a.owner, id: id(), ...(a.bold ? { bold: true } : {}), ...(a.color ? { color: a.color } : {}) });
			else if (last && 'text' in last && Boolean(last.bold) === a.bold && last.color === a.color) last.text += a.ch;
			else segments.push({ text: a.ch, ...(a.bold ? { bold: true } : {}), ...(a.color ? { color: a.color } : {}) });
		}
		paragraphs.push(segments);
	}
	const align = ALIGN[runs.find((r) => r.align)?.align] ?? 'left';
	return { paragraphs, dropped, ...(owner ? { owner } : {}), updateTime, align };
}

// What "Date last updated" smart text shows, for sizing: "Oct 16, 2026, 10:30 AM".
const SMART_TEXT_SAMPLE = 'Mmm 00, 0000, 00:00 AM';

/** The text each paragraph shows, smart text as a sample date and owner segments as the owner's name. */
export function notebookLines(paragraphs) {
	return (paragraphs ?? []).map((segments) => segments.map((s) => s.text ?? s.owner ?? (s.smart ? SMART_TEXT_SAMPLE : '')).join(''));
}

/** Atoms with runs of spaces as one space, none at the line ends, and spaces bold only between bold characters. */
function collapse(atoms) {
	const out = [];
	for (const a of atoms) {
		if (a.ch !== undefined && SPACE.test(a.ch)) {
			if (out.length && out.at(-1).ch === ' ') continue;
			out.push({ ch: ' ', bold: false, ...(a.color ? { color: a.color } : {}) });
		} else out.push(a);
	}
	while (out.length && out[0].ch === ' ') out.shift();
	while (out.length && out.at(-1).ch === ' ') out.pop();
	out.forEach((a, i) => {
		if (a.ch === ' ') a.bold = Boolean(out[i - 1]?.bold && out[i + 1]?.bold);
	});
	return out;
}

/** Replace the value of an `Owner ... : value` part of a line with one owner atom. Mutates `atoms`. */
function markOwner(atoms, found) {
	let start = 0;
	for (let i = 0; i <= atoms.length; i++) {
		if (i < atoms.length && atoms[i].ch !== '|') continue;
		const colon = atoms.slice(start, i).findIndex((a) => a.ch === ':');
		if (colon >= 0) {
			const label = atoms.slice(start, start + colon).map((a) => a.ch ?? '').join('');
			let from = start + colon + 1;
			let to = i;
			while (from < to && atoms[from].ch === ' ') from++;
			while (to > from && atoms[to - 1].ch === ' ') to--;
			const value = atoms.slice(from, to);
			if (OWNER_LABEL.test(label) && value.length && value.every((a) => a.ch !== undefined)) {
				const name = value.map((a) => a.ch).join('');
				atoms.splice(from, to - from, { owner: name, bold: value.every((a) => a.bold), ...(value[0].color ? { color: value[0].color } : {}) });
				found(name);
				i -= to - from - 1;
			}
		}
		start = i + 1;
	}
}

/**
 * The text card of a status sheet: on the status sheet's dataset (its card's, else its primary datasource's), keyed after
 * its card. Push creates it as a Text v4 card (src/domo/notebooks.js).
 * @param {import('../model/types.js').WorksheetIR} ws
 * @param {import('../model/types.js').CardPlan|undefined} statusCard
 * @param {import('../model/types.js').FieldBindings} [bindings]
 * @param {string} [workbookKey]
 * @param {{ aligned?: boolean }} [opts]  `aligned` (target app): the text keeps the title's Tableau colors and alignment, middle aligned
 * @returns {{ card: import('../model/types.js').CardPlan, dropped: string[], owner?: string, updateTime: boolean }}
 */
export function notebookCard(ws, statusCard, bindings, workbookKey, { aligned = false } = {}) {
	const datasetKey = statusCard?.datasetKey || bindings?.datasetKeyFor?.(ws.datasourceIds?.[0]) || '';
	const key = `${statusCard?.key ?? `${workbookKey ? `${workbookKey}.` : ''}${slugify(ws.name)}`}.text`;
	const { paragraphs, align, ...rest } = notebookParagraphs(ws, key, { colors: aligned });
	const body = { notebook: { title: ws.name, paragraphs, ...(aligned ? { align, valign: 'middle' } : {}) }, ...(datasetKey ? { dataSourceId: ref('dataset', datasetKey) } : {}) };
	return { card: { key, kind: 'notebook', title: ws.name, worksheet: ws.name, datasetKey, chartType: 'notebook', body, pageKeys: [], status: 'ok' }, ...rest };
}
