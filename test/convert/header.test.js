import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandColumns, bandHoles, findHeader, headerParagraphs, needsTextCard, textSize } from '../../src/convert/header.js';

const z = (id, kind, rect, extra = {}) => ({ id, kind, rect, ...extra });

test('findHeader: a banner image with its bytes, else the first filled wide title near the top, with the zones whose center is on it', () => {
	const banner = z('7', 'image', { x: 0, y: 0, w: 1, h: 0.08 }, { image: { name: 'b.png' } });
	const logo = z('8', 'image', { x: 0.01, y: 0.03, w: 0.09, h: 0.04 }, { image: { name: 'l.png' } });
	const title = z('9', 'text', { x: 0.23, y: 0.02, w: 0.47, h: 0.05 }, { text: 'T' });
	const chart = z('10', 'worksheet', { x: 0, y: 0.1, w: 1, h: 0.9 });
	const member = (zone) => zone.kind !== 'worksheet';
	const found = findHeader({ zones: [banner, chart], floating: [logo, title] }, () => undefined, member);
	assert.deepEqual([found.band.id, found.image.id, found.members.map((m) => m.id)], ['7', '7', ['8', '9']]);
	const filled = z('1', 'title', { x: 0, y: 0, w: 1, h: 0.07 }, { text: 'Summary' });
	const onFill = findHeader({ zones: [filled, chart], floating: [logo] }, (zone) => (zone === filled ? '#19429C' : undefined), member);
	assert.deepEqual([onFill.fill, onFill.members.map((m) => m.id)], ['#19429C', ['1', '8']]);
	assert.equal(findHeader({ zones: [filled, chart], floating: [] }, () => '#FFFFFF', member), undefined, 'a fill like the view background is no band');
	assert.equal(findHeader({ zones: [{ ...banner, image: undefined }, chart], floating: [] }, () => undefined, member), undefined, 'a banner without its bytes is no band');
});

test('headerParagraphs keeps each run\'s bold, color and size, Tableau line breaks and the first alignment; textSize maps points to text sizes', () => {
	const zone = z('9', 'text', {}, { runs: [{ text: 'Owner: Ann', fontName: 'Tableau Bold', fontSize: 9, align: 'right' }, { text: '\n' }, { text: 'Sales <Sheet Name>', color: '#ffffffcc', fontSize: 20 }, { text: ' <Field>' }] });
	assert.deepEqual(headerParagraphs(zone, { name: 'Dash' }, ''), { paragraphs: [[{ text: 'Owner: Ann', bold: true }], [{ text: 'Sales Dash', color: '#FFFFFF', size: 'header' }]], align: 'right' });
	assert.deepEqual(headerParagraphs(z('1', 'title', {}), { name: 'Dash', title: { text: 'Dash' } }, 'Dash'), { paragraphs: [[{ text: 'Dash', size: 'header' }]], align: 'left' });
	assert.deepEqual([textSize(22), textSize(18), textSize(15), textSize(12), textSize(9)], ['header', 'header', 'title', 'subtitle', undefined]);
	assert.equal(needsTextCard({ paragraphs: [[{ text: 'a' }]], align: 'left' }), false);
	assert.equal(needsTextCard({ paragraphs: [[{ text: 'a', bold: true }]], align: 'left' }), true);
	assert.equal(needsTextCard({ paragraphs: [[{ text: 'a' }]], align: 'center' }), true);
});

test('bandColumns: items at their Tableau columns with the gaps closed, centered text grown evenly; a wide title keeps the free columns; overlaps split; a logo above a status line shares its columns', () => {
	const full = (x, width) => ({ x, width, top: 0, share: 1 });
	const logo = { rect: { x: 0.0126, y: 0, w: 0.0874, h: 1 } };
	const title = { rect: { x: 0.229, y: 0, w: 0.4748, h: 1 }, align: 'center' };
	const status = { rect: { x: 0.772, y: 0, w: 0.218, h: 1 } };
	assert.deepEqual(bandColumns([logo, title, status]), [full(0, 10), full(10, 36), full(46, 14)]);
	const wide = { rect: { x: 0, y: 0, w: 1, h: 1 }, flex: true, align: 'center', need: 40 };
	const right = { rect: { x: 0.8, y: 0, w: 0.18, h: 1 } };
	assert.deepEqual(bandColumns([wide, right]), [full(0, 48), full(48, 12)], 'too little room to stay centered: the free columns');
	assert.deepEqual(bandColumns([{ ...wide, need: 10 }, right]), [full(12, 36), full(48, 12)], 'centered where it fits');
	assert.deepEqual(bandColumns([{ rect: { x: 0.5, y: 0, w: 0.4, h: 1 } }, { rect: { x: 0.8, y: 0, w: 0.2, h: 1 } }]), [full(0, 48), full(48, 12)]);
	const top = { rect: { x: 0.766, y: 0.018, w: 0.221, h: 0.035 } };
	const below = { rect: { x: 0.762, y: 0.05, w: 0.215, h: 0.063 } };
	const [, a, b] = bandColumns([{ ...wide, need: 10 }, top, below]);
	assert.deepEqual([a.x, a.width, a.top, b.x, b.width, b.top], [46, 14, 0, 46, 14, a.share]);
	assert.ok(Math.abs(a.share + b.share - 1) < 1e-9);
	assert.deepEqual(bandHoles([{ x: 12, width: 36 }, { x: 48, width: 12 }]), [{ x: 0, width: 12 }]);
});

test('a status text card keeps its title colors and alignment on an app; a color like the view background shows on no plain view', async () => {
	const { notebookCard } = await import('../../src/convert/notebook.js');
	const { showsColors } = await import('../../src/convert/layout.js');
	const ws = { name: 'Updated', title: 'Owner : Ann | Data Refreshed : <Data Update Time>', titleRuns: [{ text: 'Owner', bold: true, color: '#ffffff', align: 'right' }, { text: ' : Ann | ', color: '#ffffff' }, { text: 'Data Refreshed : <Data Update Time>', color: '#ffffff' }] };
	const { card } = notebookCard(ws, undefined, undefined, 'wb', { aligned: true });
	assert.deepEqual([card.body.notebook.align, card.body.notebook.valign], ['right', 'middle']);
	assert.deepEqual(card.body.notebook.paragraphs[0].map((s) => [s.text ?? s.owner ?? s.smart, s.color]), [['Owner', '#FFFFFF'], [' : ', '#FFFFFF'], ['Ann', '#FFFFFF'], [' | Data Refreshed : ', '#FFFFFF'], ['DATA_SOURCE_DATA_LAST_UPDATED', undefined]]);
	assert.equal(notebookCard(ws, undefined, undefined, 'wb').card.body.notebook.paragraphs[0][0].color, undefined, 'pages keep no colors');
	assert.equal(showsColors(card, undefined), false, 'white text on a white view');
	assert.equal(showsColors(card, '#1a1a1a'), true);
});
