import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apportion, fillHoles, sortTemplate, tile, tilingGaps } from '../../src/convert/tile.js';

const item = (name, frame, height, extra = {}) => ({ name, frame, height, ...extra });
const boxesOf = (items, result) => Object.fromEntries(items.map((i) => [i.name, Object.values(result.boxes.get(i))]));

test('apportion: integer shares that sum to the total, by weight, each at least its minimum', () => {
	assert.deepEqual(apportion(60, [1, 1, 1]), [20, 20, 20]);
	assert.deepEqual(apportion(60, [10, 20]), [20, 40]);
	assert.deepEqual(apportion(10, [1, 1, 1]).reduce((a, b) => a + b), 10);
	assert.deepEqual(apportion(60, [1, 59], [15, 5]), [15, 45]);
	assert.deepEqual(apportion(5, [0, 0]), [3, 2]);
});

test('tile: rows and columns from the frames; every cell is covered and gaps between zones close up', () => {
	const items = [
		item('title', { x: 0, y: 1, w: 60, h: 3 }, 5, { barrier: true, fixed: true }),
		item('left', { x: 13, y: 6, w: 20, h: 30 }, 30),
		item('right', { x: 34, y: 6, w: 25, h: 20 }, 20),
		item('below', { x: 13, y: 40, w: 46, h: 10 }, 10)
	];
	const result = tile(items, 60);
	assert.deepEqual(boxesOf(items, result), {
		title: [0, 0, 60, 5],
		left: [0, 5, 27, 30],
		right: [27, 5, 33, 30],
		below: [0, 35, 60, 10]
	});
	assert.equal(result.height, 45);
});

test('tile: a column of several items beside a taller one grows to its height; fixed items keep theirs', () => {
	const items = [item('chart', { x: 0, y: 0, w: 40, h: 40 }, 40), item('a', { x: 40, y: 0, w: 20, h: 10 }, 10), item('b', { x: 40, y: 10, w: 20, h: 10 }, 10, { fixed: true })];
	const result = tile(items, 60);
	assert.deepEqual(boxesOf(items, result), { chart: [0, 0, 40, 40], a: [40, 0, 20, 30], b: [40, 30, 20, 10] });
});

test('tile: barriers become full-width top-level rows next to the row they sat in, in their own order', () => {
	const lines = [0, 1].map((i) => item(`line${i}`, { x: 0, y: 0, w: 12, h: 4 }, 5, { barrier: true, fixed: true, sortKey: [0, 0, i] }));
	const items = [...lines, item('filters', { x: 0, y: 4, w: 12, h: 50 }, 30, { barrier: true, fixed: true }), item('chart', { x: 12, y: 0, w: 48, h: 54 }, 54)];
	const result = tile(items, 60);
	assert.deepEqual(boxesOf(items, result), { line0: [0, 0, 60, 5], line1: [0, 5, 60, 5], filters: [0, 10, 60, 30], chart: [0, 40, 60, 54] });
});

test('tile: columns narrower than their minimum widths stack; items no line separates stack in reading order', () => {
	const narrow = [0, 1, 2].map((i) => item(`n${i}`, { x: i * 20, y: 0, w: 20, h: 10 }, 10, { minWidth: 25 }));
	assert.deepEqual(Object.values(boxesOf(narrow, tile(narrow, 60))), [[0, 0, 60, 10], [0, 10, 60, 10], [0, 20, 60, 10]]);
	const pinwheel = [item('a', { x: 0, y: 0, w: 40, h: 20 }, 20), item('b', { x: 30, y: 10, w: 30, h: 20 }, 20)];
	assert.deepEqual(boxesOf(pinwheel, tile(pinwheel, 60)), { a: [0, 0, 60, 20], b: [0, 20, 60, 20] });
});

test('tile: a pane has no barriers, so its items keep their columns', () => {
	const items = [item('h', { x: 0, y: 0, w: 30, h: 5 }, 5, { barrier: true }), item('c', { x: 30, y: 0, w: 30, h: 5 }, 5)];
	assert.deepEqual(boxesOf(items, tile(items, 60, { barriers: false })), { h: [0, 0, 30, 5], c: [30, 0, 30, 5] });
});

test('tilingGaps counts empty and overlapping cells per level, sections against their own height', () => {
	const pane = { type: 'TAB_CONTENT', x: 0, y: 5, width: 60, height: 10, children: [{ type: 'CARD', x: 0, y: 0, width: 30, height: 10 }] };
	const template = [{ type: 'TABS', x: 0, y: 0, width: 60, height: 15, children: [{ type: 'TAB_BAR', x: 0, y: 0, width: 60, height: 5 }, pane] }, { type: 'CARD', x: 0, y: 15, width: 50, height: 2 }, { type: 'CARD', x: 40, y: 15, width: 20, height: 2 }];
	assert.deepEqual(tilingGaps(template, 60), { empty: 300, overlapping: 20 });
});

test('fillHoles: the neighbor that borders a hole takes it, as the editor\'s delete does; else a SPACER fills it', () => {
	const items = [{ type: 'CARD', x: 0, y: 0, width: 30, height: 10 }, { type: 'CARD', x: 0, y: 10, width: 60, height: 10 }];
	fillHoles(items, 60, 20, () => assert.fail('no spacer needed'));
	assert.deepEqual(items[0], { type: 'CARD', x: 0, y: 0, width: 60, height: 10 });
	const ragged = [
		{ type: 'CARD', x: 0, y: 0, width: 10, height: 20 },
		{ type: 'CARD', x: 20, y: 0, width: 40, height: 5 },
		{ type: 'CARD', x: 20, y: 5, width: 40, height: 5 },
		{ type: 'CARD', x: 10, y: 10, width: 50, height: 10 }
	];
	const spacers = [];
	fillHoles(ragged, 60, 20, (box) => {
		spacers.push(box);
		return { type: 'SPACER', ...box };
	});
	assert.deepEqual(spacers, [{ x: 10, y: 0, width: 10, height: 10 }], 'no edge borders the whole hole');
	assert.deepEqual(tilingGaps(ragged, 60), { empty: 0, overlapping: 0 });
});

test('sortTemplate orders each level by y, x, height and keeps the tab bar first', () => {
	const template = [
		{ type: 'CARD', x: 0, y: 81, width: 60, height: 10 },
		{ type: 'TABS', x: 0, y: 6, width: 60, height: 20, children: [{ type: 'TAB_CONTENT', x: 0, y: 5, width: 60, height: 15, children: [{ type: 'CARD', x: 30, y: 0, width: 30, height: 15 }, { type: 'CARD', x: 0, y: 0, width: 30, height: 15 }] }, { type: 'TAB_BAR', x: 0, y: 0, width: 60, height: 5 }] },
		{ type: 'HEADER', x: 0, y: 0, width: 60, height: 5 }
	];
	sortTemplate(template);
	assert.deepEqual(template.map((t) => t.type), ['HEADER', 'TABS', 'CARD']);
	assert.deepEqual(template[1].children.map((c) => c.type), ['TAB_BAR', 'TAB_CONTENT']);
	assert.deepEqual(template[1].children[1].children.map((c) => c.x), [0, 30]);
});
