import test from 'node:test';
import assert from 'node:assert/strict';
import { graphCanvas, layoutTiles } from '../../src/magic/canvas.js';

const load = (id) => ({ type: 'LoadFromVault', id });
const tile = (id, ...dependsOn) => ({ type: 'ExpressionEvaluator', id, dependsOn });
const join = (id, left, right) => ({ type: 'MergeJoin', id, dependsOn: [left, right], step1: left, step2: right });
const publish = (id, from) => ({ type: 'PublishToVault', id, dependsOn: [from] });

const sample = () => [
	load('tasks'),
	load('projects'),
	load('users'),
	load('tags'),
	tile('calc', 'tasks'),
	join('join-projects', 'calc', 'projects'),
	join('join-users', 'join-projects', 'users'),
	tile('group-tags', 'tags'),
	join('join-tags', 'join-users', 'group-tags'),
	publish('out', 'join-tags')
];
const at = (actions) => new Map(actions.map((a) => [a.id, a.gui]));

test('joins stay on the row of the data they extend, one step apart', () => {
	const gui = at(layoutTiles(sample()));
	const row = ['tasks', 'calc', 'join-projects', 'join-users', 'join-tags', 'out'].map((id) => gui.get(id));
	assert.ok(row.every((g) => g.y === row[0].y));
	assert.deepEqual(row.map((g) => g.x), [64, 192, 320, 448, 576, 704]);
});

test('each lookup sits on its own row just before the tile that reads it', () => {
	const gui = at(layoutTiles(sample()));
	const task = gui.get('tasks').y;
	for (const [input, reader] of [['projects', 'join-projects'], ['users', 'join-users'], ['group-tags', 'join-tags'], ['tags', 'group-tags']]) {
		assert.equal(gui.get(input).x, gui.get(reader).x - 128, input);
	}
	assert.equal(gui.get('tags').y, gui.get('group-tags').y);
	const rows = ['projects', 'users', 'tags'].map((id) => gui.get(id).y);
	assert.equal(new Set([task, ...rows]).size, 4);
	assert.ok(rows.every((y) => y > task));
});

test('positions snap to the 32px grid and never overlap', () => {
	const actions = layoutTiles(sample());
	assert.ok(actions.every((a) => a.gui.x % 32 === 0 && a.gui.y % 32 === 0));
	assert.equal(new Set(actions.map((a) => `${a.gui.x},${a.gui.y}`)).size, actions.length);
});

test('an output ends its row, and a second reader branches onto a row of its own', () => {
	const actions = layoutTiles([load('in'), tile('calc', 'in'), publish('out-early', 'calc'), tile('more', 'calc'), publish('out-late', 'more')]);
	const gui = at(actions);
	assert.deepEqual([gui.get('in').y, gui.get('calc').y, gui.get('more').y, gui.get('out-late').y].map((y) => y === gui.get('in').y), [true, true, true, true]);
	assert.notEqual(gui.get('out-early').y, gui.get('in').y);
	for (const out of ['out-early', 'out-late']) assert.ok(!actions.some((a) => a.gui.y === gui.get(out).y && a.gui.x > gui.get(out).x), out);
});

test('the graph editor canvas has one tile element per action at its position', () => {
	const actions = layoutTiles(sample());
	const gui = graphCanvas(actions);
	assert.equal(gui.useGraphUI, true);
	assert.deepEqual(gui.canvases.default.elements.map((e) => [e.id, e.x, e.y]), actions.map((a) => [a.id, a.gui.x, a.gui.y]));
});
