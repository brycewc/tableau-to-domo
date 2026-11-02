import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHeight, planPages } from '../../src/convert/layout.js';
import { planCards } from '../../src/convert/cards.js';
import { tilingGaps } from '../../src/convert/tile.js';
import { p, sheet, workbook, makeBindings } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const CATEGORY = p('none', 'Category');
const zone = (id, kind, rect, extra = {}) => ({ id, kind, rect, floating: false, ...extra });
const FOOTNOTE = '* Beginning in 2023, ARR is respecting Fiscal Calendar\n** ARR excludes Partner, Trial, and Maintenance';

function plan(zones, { target = 'app', parameters = [], floating = [] } = {}) {
	const ir = workbook({ worksheets: ['Totals', 'Growth'].map((name) => sheet({ name, cols: CATEGORY, rows: SALES })), parameters });
	ir.dashboards = [{ name: 'Acme ARR', size: { mode: 'fixed', width: 1300, height: 900 }, zones, floating }];
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options: { target } });
	const result = planPages(ir, cards, bindings, { options: { target }, workbookKey: 'wb' });
	const layout = result.pages.find((pg) => pg.dashboard === 'Acme ARR').layout;
	const all = (ts) => ts.flatMap((t) => [t, ...all(t.children ?? [])]);
	const box = (item) => all(layout.standard.template).find((t) => t.contentKey === item.contentKey);
	const textItems = layout.content.filter((c) => c.type === 'CARD' && /\.text\./.test(c.cardId.$ref));
	const cardOf = (item) => result.cards.find((c) => `card:${c.key}` === item.cardId.$ref);
	return { ...result, layout, box, textItems, cardOf, headers: layout.content.filter((c) => c.type === 'HEADER').map((c) => c.text) };
}

const acmeArr = () => [
	zone('1', 'title', { x: 0, y: 0, w: 1, h: 0.06 }, { text: 'Acme ARR' }),
	zone('9', 'worksheet', { x: 0, y: 0.06, w: 1, h: 0.47 }, { worksheet: 'Totals' }),
	zone('54', 'worksheet', { x: 0.006, y: 0.537, w: 0.44, h: 0.2 }, { worksheet: 'Growth' }),
	zone('71', 'text', { x: 0.48, y: 0.537, w: 0.51, h: 0.2 }, { text: FOOTNOTE, runs: [{ text: FOOTNOTE, color: '#ff0000', fontSize: 8 }] })
];

test('a footnote beside a table is a top aligned text card at its Tableau columns, keeping its color and line breaks', () => {
	const { layout, box, textItems, cardOf, headers, issues } = plan(acmeArr());
	assert.deepEqual(headers, ['Acme ARR'], 'only the title is a header');
	const [item] = textItems;
	const card = cardOf(item);
	assert.equal(card.key, 'wb--acme-arr.text.71');
	assert.deepEqual([card.kind, card.header, card.body.notebook.align, card.body.notebook.valign], ['notebook', true, 'left', 'top']);
	assert.deepEqual(card.body.notebook.paragraphs, [[{ text: '* Beginning in 2023, ARR is respecting Fiscal Calendar', color: '#FF0000' }], [{ text: '** ARR excludes Partner, Trial, and Maintenance', color: '#FF0000' }]]);
	assert.deepEqual([item.hideTitle, item.hideWrench, item.editInAppViewer], [true, true, false]);
	const growth = layout.content.find((c) => c.cardId?.$ref === 'card:growth');
	assert.equal(growth.editInAppViewer, true, 'chart cards keep the editor default');
	const [g, t] = [box(growth), box(item)];
	assert.deepEqual([g.y, t.y, g.x + g.width, t.x + t.width], [t.y, g.y, t.x, 60], 'the text sits beside the table, on its row');
	assert.ok(t.width >= 28 && t.width <= 33, JSON.stringify(t));
	assert.deepEqual(tilingGaps(layout.standard.template, 60), { empty: 0, overlapping: 0 });
	assert.ok(layout.compact.template.find((x) => x.contentKey === item.contentKey).height < 6, 'a short text is not stretched to a card height on a phone');
	assert.match(issues.find((i) => i.code === 'layout.text-size').message, /1 text card\(s\) have text smaller than 10pt in Tableau; it shows at 14px, the smallest Domo text card size/);
});

test('the title stays a header when a small label sits above or level with it; a bold top-band label that is not the title is a tiled text card', () => {
	const zones = [
		zone('2', 'text', { x: 0.8, y: 0, w: 0.2, h: 0.03 }, { text: 'Last refreshed daily', runs: [{ text: 'Last refreshed daily', fontSize: 8 }] }),
		zone('1', 'text', { x: 0, y: 0.01, w: 0.6, h: 0.06 }, { text: 'Bookings Overview', runs: [{ text: 'Bookings Overview', fontSize: 20 }] }),
		zone('3', 'text', { x: 0, y: 0.08, w: 0.3, h: 0.3 }, { text: 'SELECTION', runs: [{ text: 'SELECTION', bold: true, align: 'center' }] }),
		zone('54', 'worksheet', { x: 0.3, y: 0.08, w: 0.7, h: 0.3 }, { worksheet: 'Growth' }),
		zone('9', 'worksheet', { x: 0, y: 0.4, w: 1, h: 0.6 }, { worksheet: 'Totals' })
	];
	const { headers, textItems, cardOf, box, layout } = plan(zones);
	assert.deepEqual(headers, ['Bookings Overview']);
	assert.deepEqual(textItems.map((i) => cardOf(i).key).sort(), ['wb--acme-arr.text.2', 'wb--acme-arr.text.3']);
	const selection = textItems.find((i) => cardOf(i).key.endsWith('.3'));
	assert.deepEqual([cardOf(selection).body.notebook.align, cardOf(selection).body.notebook.paragraphs[0][0].bold], ['center', true]);
	assert.ok(box(selection).width < 60, 'not a full-width banner');
	assert.deepEqual(tilingGaps(layout.standard.template, 60), { empty: 0, overlapping: 0 });

	const titled = plan([zone('0', 'title', { x: 0, y: 0.05, w: 0.5, h: 0.05 }, { text: 'Dash' }), ...zones]);
	assert.deepEqual(titled.headers, ['Dash'], 'a dashboard title zone is the title');
});

test('long top-band text is body text, not the title: a text card with all its text', () => {
	const long = Array.from({ length: 8 }, (_, i) => `Definition ${i}: a term used on this view and what it means`).join('\n');
	const { headers, textItems, cardOf, issues } = plan([zone('3', 'text', { x: 0, y: 0, w: 1, h: 0.9 }, { text: long }), zone('9', 'worksheet', { x: 0, y: 0.9, w: 1, h: 0.1 }, { worksheet: 'Totals' })]);
	assert.deepEqual(headers, []);
	assert.equal(cardOf(textItems[0]).body.notebook.paragraphs.length, 8);
	assert.equal(issues.filter((i) => i.code === 'layout.text-truncated').length, 0);
});

test('a text card keeps the parameter values its tokens show; fields are left out with an issue', () => {
	const parameters = [{ id: '[Parameters].[Parameter 8]', name: 'Period', datatype: 'string', value: 'FY26' }];
	const text = 'Bookings for <[Parameters].[Parameter 8]> | Refreshed: <Data Update Time>';
	const zones = [...acmeArr().slice(0, 3), zone('71', 'text', { x: 0.48, y: 0.537, w: 0.51, h: 0.2 }, { text, runs: [{ text, bold: true }] })];
	const { textItems, cardOf, issues } = plan(zones, { parameters });
	assert.deepEqual(cardOf(textItems[0]).body.notebook.paragraphs, [[{ text: 'Bookings for FY26 | Refreshed', bold: true }]]);
	assert.match(issues.find((i) => i.code === 'layout.text-field').message, /Data Update Time; left out of its text card/);
});

test('a parameter token Tableau splits over three runs resolves, keeping each run style and the spaces around it', () => {
	const parameters = [{ id: '[Parameters].[Parameter 8]', name: 'Period', datatype: 'string', value: 'FY26' }];
	const runs = [{ text: 'Bookings for <' }, { text: '[Parameters].[Parameter 8]', bold: true }, { text: '> by <' }, { text: '[Parameters].[Parameter 8]', bold: true }, { text: '>' }];
	const zones = [...acmeArr().slice(0, 3), zone('71', 'text', { x: 0.48, y: 0.537, w: 0.51, h: 0.2 }, { text: runs.map((r) => r.text).join(''), runs })];
	const { textItems, cardOf } = plan(zones, { parameters });
	assert.deepEqual(cardOf(textItems[0]).body.notebook.paragraphs, [[{ text: 'Bookings for ' }, { text: 'FY26', bold: true }, { text: ' by ' }, { text: 'FY26', bold: true }]]);
});

test('the pages target keeps dashboard text as header lines', () => {
	const { headers, textItems } = plan(acmeArr(), { target: 'pages' });
	assert.equal(textItems.length, 0);
	assert.deepEqual(headers.slice(0, 2), ['Acme ARR', '* Beginning in 2023, ARR is respecting Fiscal Calendar']);
});

test('compactHeight: a text card off the header keeps its own phone rows; other cards keep their minimum', () => {
	assert.equal(compactHeight({ type: 'CARD', chartType: 'notebook', compactRows: 3, box: { x: 0, y: 0, width: 30, height: 10 } }), 3);
	assert.equal(compactHeight({ type: 'CARD', chartType: 'notebook', box: { x: 0, y: 0, width: 60, height: 2 } }), 6);
});
