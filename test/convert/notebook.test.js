import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notebookCard, notebookLines, notebookParagraphs } from '../../src/convert/notebook.js';
import { planCards } from '../../src/convert/cards.js';
import { notebookHeight, planPages } from '../../src/convert/layout.js';
import { tilingGaps } from '../../src/convert/tile.js';
import { DATASET, makeBindings, p, sheet, workbook } from './cards.fixtures.test.js';

const LAST = 'DATA_SOURCE_DATA_LAST_UPDATED';
const strip = (paragraphs) => paragraphs.map((segments) => segments.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'id'))));

const statusSheet = () => ({
	...sheet({ name: 'Data Updated Sheet', title: 'Owner Name : Jane Doe | Data Refreshed : <Data Update Time>' }),
	titleRuns: [
		{ text: 'Owner Name', bold: true, fontSize: 9 },
		{ text: ' : Jane Doe | ', fontSize: 9 },
		{ text: 'Data Refreshed ', bold: true, fontSize: 9 },
		{ text: ': <Data Update Time>', fontSize: 9 }
	]
});

test('notebookParagraphs keeps bold runs (not their edge spaces), makes <Data Update Time> smart text and the owner value an owner segment', () => {
	const { paragraphs, owner, updateTime, dropped } = notebookParagraphs(statusSheet(), 'wb.data-updated-sheet.text');
	assert.deepEqual(strip(paragraphs), [[{ text: 'Owner Name', bold: true }, { text: ' : ' }, { owner: 'Jane Doe' }, { text: ' | ' }, { text: 'Data Refreshed', bold: true }, { text: ' : ' }, { smart: LAST }]]);
	assert.deepEqual([owner, updateTime, dropped], ['Jane Doe', true, []]);
	const again = notebookParagraphs(statusSheet(), 'wb.data-updated-sheet.text').paragraphs.flat().map((s) => s.id).filter(Boolean);
	assert.deepEqual(paragraphs.flat().map((s) => s.id).filter(Boolean), again, 'smart text ids are stable for a card key');
	assert.notDeepEqual(notebookParagraphs(statusSheet(), 'other.text').paragraphs.flat().map((s) => s.id).filter(Boolean), again);
});

test('notebookParagraphs: one paragraph per title line, spaces collapsed, <Sheet Name> filled in, other tokens left out', () => {
	const chatbot = sheet({ name: 'LastUpdated', title: 'Owner  :  John Smith \nLast Updated  :   <Data Update Time>' });
	assert.deepEqual(strip(notebookParagraphs(chatbot, 'k').paragraphs), [[{ text: 'Owner : ' }, { owner: 'John Smith' }], [{ text: 'Last Updated : ' }, { smart: LAST }]]);
	const other = notebookParagraphs(sheet({ name: 'S', title: '<Sheet Name> as of <Data Update Time> for <[Parameters].[Region]>' }), 'k');
	assert.deepEqual(strip(other.paragraphs), [[{ text: 'S as of ' }, { smart: LAST }, { text: ' for' }]]);
	assert.deepEqual([other.dropped, other.owner], [['[Parameters].[Region]'], undefined]);
	assert.equal(notebookParagraphs(sheet({ name: 'S', title: 'Owner: <[ds].[Owner]> | Updated <Data Update Time>' }), 'k').owner, undefined, 'a field value is no owner name');
});

test('notebookCard is on the status sheet card\'s dataset, keyed after it; without a dataset it has no dataset ref', () => {
	const ws = statusSheet();
	const { card } = notebookCard(ws, { key: 'wb.data-updated-sheet', datasetKey: 'pds-1' });
	assert.deepEqual([card.key, card.kind, card.title, card.datasetKey, card.body.dataSourceId], ['wb.data-updated-sheet.text', 'notebook', 'Data Updated Sheet', 'pds-1', { $ref: 'dataset:pds-1' }]);
	assert.equal(notebookCard(ws, undefined, makeBindings(), 'wb').card.datasetKey, DATASET, 'the primary datasource\'s dataset when the sheet has no card');
	assert.equal(notebookCard({ ...ws, datasourceIds: [] }, undefined, makeBindings(), 'wb').card.body.dataSourceId, undefined);
});

const zone = (id, kind, rect, extra = {}) => ({ id, kind, rect, floating: false, ...extra });

function planFor(target, statusTitle) {
	const chart = sheet({ name: 'Volume', cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') });
	const status = statusTitle ? { ...statusSheet(), title: statusTitle, titleRuns: undefined } : statusSheet();
	const dash = (name) => ({
		name,
		size: { mode: 'fixed', width: 1300, height: 1200 },
		zones: [zone('1', 'title', { x: 0, y: 0, w: 1, h: 0.0675 }, { text: name }), zone('2', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 }, { worksheet: 'Volume' })],
		floating: [{ ...zone('3', 'worksheet', { x: 0.56, y: 0.0458, w: 0.43, h: 0.0267 }, { worksheet: 'Data Updated Sheet' }), floating: true }]
	});
	const ir = workbook({ worksheets: [chart, status], dashboards: [dash('Executive Summary'), dash('Case Metrics')] });
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options: {} });
	return { ...planPages(ir, cards, bindings, { options: { target } }), worksheetCards: cards };
}

test('a status sheet with an owner is a text card under the title in both templates, on every view that shows it; no card description', () => {
	for (const target of ['app', 'pages']) {
		const { pages, cards, worksheetCards, issues } = planFor(target);
		const text = cards.find((c) => c.kind === 'notebook');
		const views = pages.filter((pg) => pg.dashboard);
		assert.deepEqual(text.pageKeys, views.map((pg) => pg.key));
		for (const view of views) {
			const { content, standard, compact } = view.layout;
			const typeOf = (t) => (content.find((c) => c.contentKey === t.contentKey)?.cardId?.$ref === `card:${text.key}` ? 'TEXT' : t.type);
			assert.deepEqual(standard.template.map((t) => [typeOf(t), t.x, t.y, t.width, t.height]).slice(0, 2), [['HEADER', 0, 0, 60, 5], ['TEXT', 0, 5, 60, 6]], `${target} standard`);
			assert.deepEqual(compact.template.map((t) => [typeOf(t), t.height]).slice(0, 2), [['HEADER', 2], ['TEXT', 6]], `${target} compact`);
			for (const [template, width] of [[standard.template, 60], [compact.template, 12]]) assert.deepEqual(tilingGaps(template, width), { empty: 0, overlapping: 0 });
			const item = content.find((c) => c.cardId?.$ref === `card:${text.key}`);
			assert.deepEqual([item.hideTitle, item.hideDescription, item.hideFooter, item.hideWrench, item.editInAppViewer], [true, true, true, true, false]);
			assert.ok(content.filter((c) => c.type === 'CARD' && c !== item).every((c) => c.editInAppViewer === true), 'chart cards keep the editor default');
			assert.ok(content.filter((c) => c.type === 'CARD').every((c) => c.hideDescription === true), 'no card shows a description');
			assert.ok(!content.some((c) => c.type === 'HEADER' && /Owner/.test(c.text)));
		}
		const status = worksheetCards.find((c) => c.worksheet === 'Data Updated Sheet');
		assert.deepEqual([status.status, status.replacedBy], ['unsupported', 'notebook']);
		assert.equal(worksheetCards.find((c) => c.worksheet === 'Volume').body.definition.dynamicDescription, undefined);
		assert.match(issues.find((i) => i.code === 'layout.update-time').message, /text card at the top of each view .*"Date last updated" smart text and the owner "Jane Doe" as text/);
	}
});

test('a text card is as tall as its lines: one line 6 standard rows, two 7 (ChatBot\'s LastUpdated), long lines wrap; compact at least 6', () => {
	const { pages } = planFor('app', 'Owner : John Smith\nLast Updated : <Data Update Time>');
	const { standard, compact } = pages[0].layout;
	assert.deepEqual([standard.template[1].y, standard.template[1].height, standard.template[2].y], [5, 7, 12], 'the card below moves down');
	assert.equal(compact.template[1].height, 6);
	assert.deepEqual(notebookLines([[{ text: 'Owner : ' }, { owner: 'John Smith' }], [{ text: 'Last Updated : ' }, { smart: LAST }]]), ['Owner : John Smith', 'Last Updated : Mmm 00, 0000, 00:00 AM']);
	assert.deepEqual([notebookHeight(['one line']), notebookHeight(['one', 'two']), notebookHeight(['a', 'b', 'c'])], [6, 7, 9]);
	assert.equal(notebookHeight(['word '.repeat(60)]), 7, 'a line longer than the card wraps');
	assert.ok(notebookHeight(['word '.repeat(60)], { compact: true }) > 6, 'and wraps sooner on a phone');
});

test('a status sheet with only the update time is a text card at the top of each view too, not the main card\'s description', () => {
	const { pages, cards, worksheetCards, issues } = planFor('app', 'Last Updated: <Data Update Time>');
	const text = cards.find((c) => c.kind === 'notebook');
	assert.deepEqual(text.body.notebook.paragraphs, [[{ text: 'Last Updated: ' }, { smart: LAST, id: text.body.notebook.paragraphs[0][1].id }]]);
	assert.deepEqual(text.pageKeys, pages.filter((pg) => pg.dashboard).map((pg) => pg.key));
	const volume = worksheetCards.find((c) => c.worksheet === 'Volume');
	assert.equal(volume.body.definition.dynamicDescription, undefined);
	for (const view of pages.filter((pg) => pg.dashboard)) assert.equal(view.layout.content.find((c) => c.cardId?.$ref === `card:${volume.key}`).hideDescription, true);
	assert.equal(worksheetCards.find((c) => c.worksheet === 'Data Updated Sheet').replacedBy, 'notebook');
	assert.match(issues.find((i) => i.code === 'layout.update-time').message, /text card at the top of each view that shows it, with the update time as "Date last updated" smart text/);
});
