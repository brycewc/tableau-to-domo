import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPages } from '../../src/convert/layout.js';
import { planCards } from '../../src/convert/cards.js';
import { tilingGaps } from '../../src/convert/tile.js';
import { makeBindings, p, sheet, workbook } from './cards.fixtures.test.js';

const SHEETS = ['Volume', 'Growth', 'CSAT', 'FDR', 'TTC', 'Queue'];
const tiled = (id, worksheet, rect) => ({ id, kind: 'worksheet', worksheet, rect, floating: false });
const button = (id, rect) => ({ id, kind: 'button', rect, floating: true, button: { action: 'navigate', target: { kind: 'dashboard', name: 'Details' }, states: [{ caption: '>' }] } });

/** The Executive Summary of Support_Summary: two rows of three cards, ">" buttons at the top right of five of them. */
function summary(extraFloating = []) {
	const [x0, x1, x2, w] = [0.00615, 0.33538, 0.66462, 0.32923];
	return {
		name: 'Executive Summary',
		size: { mode: 'fixed', width: 1300, height: 1200 },
		zones: [
			{ id: '169', kind: 'title', text: 'Executive Summary', rect: { x: 0.00615, y: 0.00667, w: 0.9877, h: 0.0675 }, floating: false },
			tiled('9', 'Volume', { x: x0, y: 0.22667, w, h: 0.38333 }),
			tiled('752', 'Growth', { x: x1, y: 0.22667, w, h: 0.38333 }),
			tiled('586', 'CSAT', { x: x2, y: 0.22667, w, h: 0.38333 }),
			tiled('385', 'FDR', { x: x0, y: 0.61, w, h: 0.35583 }),
			tiled('335', 'TTC', { x: x1, y: 0.61, w, h: 0.35583 }),
			tiled('76', 'Queue', { x: x2, y: 0.61, w, h: 0.35583 })
		],
		floating: [
			button('91', { x: 0.30538, y: 0.23583, w: 0.02154, h: 0.02583 }),
			button('338', { x: 0.96385, y: 0.23583, w: 0.02154, h: 0.02583 }),
			button('92', { x: 0.63538, y: 0.61917, w: 0.02154, h: 0.02917 }),
			button('94', { x: 0.30538, y: 0.61917, w: 0.02154, h: 0.02917 }),
			button('93', { x: 0.96077, y: 0.61833, w: 0.02462, h: 0.02667 }),
			{ id: '639', kind: 'text', text: '** Usage does not include Product B data', rect: { x: 0.02923, y: 0.28083, w: 0.14077, h: 0.02167 }, floating: true },
			...extraFloating
		]
	};
}

function planFor(dash) {
	const details = { name: 'Details', size: { mode: 'fixed', width: 1300, height: 1200 }, zones: [tiled('1', 'Volume', { x: 0, y: 0, w: 1, h: 1 })], floating: [] };
	const ir = workbook({ worksheets: SHEETS.map((name) => sheet({ name, cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') })), dashboards: [dash, details] });
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options: { target: 'app' }, workbookKey: 'wb' });
	const result = planPages(ir, cards, bindings, { options: { target: 'app' }, workbookKey: 'wb' });
	const layout = result.pages.find((pg) => pg.title === dash.name).layout;
	const nameOf = (t) => {
		const c = layout.content.find((x) => x.contentKey === t.contentKey);
		if (c?.type === 'CARD') return cards.find((k) => `card:${k.key}` === c.cardId.$ref)?.worksheet ?? (/\.text\./.test(c.cardId.$ref) ? 'TEXT' : c.cardId.$ref);
		return c?.type === 'BUTTON' ? `button${t.contentKey}` : t.type;
	};
	return { layout, nameOf, issues: result.issues };
}

test('a floating button over a card takes that card\'s column width and top 3 rows, as the user\'s Executive Summary edit has it', () => {
	const { layout, nameOf, issues } = planFor(summary());
	const boxes = new Map(layout.standard.template.map((t) => [nameOf(t), [t.x, t.y, t.width, t.height]]));
	const at = (name) => boxes.get(name);
	const buttonOver = (sheetName) => [...boxes].find(([n, [x, y, w]]) => n.startsWith('button') && x === at(sheetName)[0] && w === at(sheetName)[2] && y + 3 === at(sheetName)[1])?.[0];
	const [, top, , rowHeight] = at('Growth');
	assert.deepEqual(at('Volume'), [0, top + 3, 20, rowHeight - 3]);
	assert.deepEqual(at('CSAT'), [40, top + 3, 20, rowHeight - 3]);
	for (const name of SHEETS.filter((n) => n !== 'Growth')) assert.ok(buttonOver(name), `a button sits over ${name}`);
	assert.deepEqual(at(buttonOver('Volume')), [0, top, 20, 3]);
	assert.equal(at('TEXT')[1] + at('TEXT')[3], top, 'the floating note is a text card right above the band');
	const [, top2, , h2] = at('FDR');
	assert.deepEqual([at('TTC')[1], at('Queue')[1], at('TTC')[3]], [top2, top2, h2], 'a row where every card has a button stays one band');
	for (const [template, width] of [[layout.standard.template, 60], [layout.compact.template, 12]]) assert.deepEqual(tilingGaps(template, width), { empty: 0, overlapping: 0 });

	const compact = layout.compact.template.map(nameOf);
	for (const name of SHEETS.filter((n) => n !== 'Growth')) assert.equal(compact[compact.indexOf(name) - 1], buttonOver(name), `on a phone the button comes right before ${name}`);
	const heights = new Map(layout.compact.template.map((t) => [nameOf(t), t.height]));
	assert.equal(heights.get('Volume'), heights.get('Growth'), 'the card keeps its phone height');
	assert.match(issues.find((i) => i.code === 'layout.floating' && i.object.name === 'Executive Summary').message, /5 of them are buttons over a card/);
});

test('two buttons over one card split its width; a button in the lower half sits at the bottom; one over nothing keeps a row', () => {
	const dash = summary([button('500', { x: 0.25, y: 0.23583, w: 0.02, h: 0.025 }), button('501', { x: 0.36, y: 0.58, w: 0.02, h: 0.025 }), button('502', { x: 0.5, y: 0.975, w: 0.05, h: 0.02 })]);
	const { layout, nameOf } = planFor(dash);
	const t = layout.standard.template;
	const boxOf = (name) => t.find((x) => nameOf(x) === name);
	const volume = boxOf('Volume');
	const over = t.filter((x) => x.type === 'BUTTON' && x.y + x.height === volume.y && x.x >= 0 && x.x < 20).sort((a, b) => a.x - b.x);
	assert.deepEqual(over.map((x) => [x.x, x.width]), [[0, 10], [10, 10]]);
	const growth = boxOf('Growth');
	const bottom = t.find((x) => x.type === 'BUTTON' && x.x === growth.x && x.y === growth.y + growth.height);
	assert.deepEqual([bottom?.width, bottom?.height], [20, 3]);
	const loose = t.find((x) => x.type === 'BUTTON' && x.y >= boxOf('Queue').y + boxOf('Queue').height);
	assert.ok(loose, 'the button below every card gets a row of its own');
	for (const [template, width] of [[t, 60], [layout.compact.template, 12]]) assert.deepEqual(tilingGaps(template, width), { empty: 0, overlapping: 0 });
	const compact = layout.compact.template.map(nameOf);
	assert.equal(compact[compact.indexOf('Growth') + 1], nameOf(bottom), 'on a phone a bottom button follows its card');
});
