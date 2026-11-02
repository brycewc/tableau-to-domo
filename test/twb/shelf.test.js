import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenShelf, parsePillId, parseShelf, splitBracketParts } from '../../src/tableau/twb/shelf.js';
import { parsePillId as exportedPill, parseShelf as exportedShelf } from '../../src/tableau/twb/index.js';

const DS = '[federated.abc]';

test('index re-exports parsePillId and parseShelf', () => {
	assert.equal(exportedPill, parsePillId);
	assert.equal(exportedShelf, parseShelf);
});

test('splitBracketParts honors ]] escapes and dotted names', () => {
	assert.deepEqual(splitBracketParts('[federated.x (copy 7)].[none:A]]B:nk]'), ['federated.x (copy 7)', 'none:A]]B:nk']);
	assert.deepEqual(splitBracketParts('[Multiple Values]'), ['Multiple Values']);
	assert.equal(splitBracketParts('Sales'), null);
});

test('aggregations and dimensions', () => {
	const sum = parsePillId(`${DS}.[sum:Sales:qk]`);
	assert.equal(sum.datasourceId, 'federated.abc');
	assert.equal(sum.fieldId, '[Sales]');
	assert.equal(sum.derivation, 'Sum');
	assert.equal(sum.prefix, 'sum');
	assert.equal(sum.typeKey, 'qk');
	assert.equal(sum.continuous, true);
	assert.equal(sum.aggregated, true);
	const dim = parsePillId(`${DS}.[none:Region:nk]`);
	assert.equal(dim.aggregated, false);
	assert.equal(dim.continuous, false);
	for (const [prefix, derivation] of [['avg', 'Avg'], ['cnt', 'Count'], ['ctd', 'CountD'], ['min', 'Min'], ['max', 'Max'], ['med', 'Median'], ['attr', 'Attribute'], ['usr', 'User']]) {
		const p = parsePillId(`${DS}.[${prefix}:X:qk]`);
		assert.equal(p.derivation, derivation);
		assert.equal(p.aggregated, true, prefix);
	}
});

test('date parts and truncations', () => {
	const parts = { yr: 'year', qr: 'quarter', mn: 'month', wk: 'week', dy: 'day', wd: 'weekday', hr: 'hour', mi: 'minute', sc: 'second', mdy: 'mdy' };
	for (const [prefix, part] of Object.entries(parts)) {
		const p = parsePillId(`${DS}.[${prefix}:Order Date:ok]`);
		assert.equal(p.datePart, part, prefix);
		assert.equal(p.dateTrunc, null);
	}
	const truncs = { tyr: 'year', tqr: 'quarter', tmn: 'month', twk: 'week', tdy: 'day', thr: 'hour', tmi: 'minute', tsc: 'second' };
	for (const [prefix, part] of Object.entries(truncs)) {
		const p = parsePillId(`${DS}.[${prefix}:Order Date:qk]`);
		assert.equal(p.dateTrunc, part, prefix);
		assert.equal(p.datePart, null);
		assert.equal(p.aggregated, false);
	}
});

test('sets, table-calc chains, duplicate suffixes and odd names', () => {
	const set = parsePillId(`${DS}.[io:Top Customers:nk]`);
	assert.equal(set.derivation, 'InOut');
	assert.equal(set.fieldId, '[Top Customers]');
	const pct = parsePillId(`${DS}.[pcto:sum:Sales:qk:3]`);
	assert.equal(pct.prefix, 'sum');
	assert.equal(pct.fieldId, '[Sales]');
	assert.equal(pct.typeKey, 'qk');
	assert.equal(pct.tableCalc.type, 'PctTotal');
	assert.equal(parsePillId(`${DS}.[cum:sum:Sales:qk]`).tableCalc.type, 'CumTotal');
	assert.equal(parsePillId(`${DS}.[none:Ratio: A/B:nk]`).fieldId, '[Ratio: A/B]');
	assert.equal(parsePillId(`${DS}.[none:A]]B:nk]`).fieldId, '[A]]B]');
	assert.equal(parsePillId('[federated.x (copy 7)].[sum:VIEWS:qk]').datasourceId, 'federated.x (copy 7)');
});

test('count fields, Measure Names/Values and generated geo pills', () => {
	const count = parsePillId(`${DS}.[__tableau_internal_object_id__].[cnt:Orders_ABC:qk]`);
	assert.equal(count.fieldId, '[__tableau_internal_object_id__].[Orders_ABC]');
	assert.equal(count.derivation, 'Count');
	assert.equal(parsePillId(`${DS}.[:Measure Names]`).fieldId, '[:Measure Names]');
	const mv = parsePillId('[Multiple Values]');
	assert.equal(mv.fieldId, '[Multiple Values]');
	assert.equal(mv.datasourceId, '');
	assert.equal(mv.continuous, true);
	const lat = parsePillId(`${DS}.[Latitude (generated)]`);
	assert.equal(lat.fieldId, '[Latitude (generated)]');
	assert.equal(lat.derivation, 'None');
	assert.equal(parsePillId('[Parameters].[Parameter 1]').fieldId, '[Parameter 1]');
});

test('column-instance attributes override the name', () => {
	const p = parsePillId(`${DS}.[sum:Sales:qk]`, { column: '[Sales Amount]', derivation: 'Sum', type: 'quantitative' });
	assert.equal(p.fieldId, '[Sales Amount]');
	assert.equal(parsePillId(`${DS}.[x]`, { derivation: 'Month-Trunc', type: 'quantitative' }).dateTrunc, 'month');
});

test('parseShelf: single pill, nest, concat, cross, parentheses', () => {
	assert.equal(parseShelf(''), null);
	assert.equal(parseShelf(undefined), null);
	assert.deepEqual(parseShelf(`${DS}.[none:A:nk]`), { op: 'pill', pillId: `${DS}.[none:A:nk]` });
	const nest = parseShelf(`(${DS}.[none:A:nk] / ${DS}.[none:B:nk] / ${DS}.[none:C/D:nk])`);
	assert.equal(nest.op, 'nest');
	assert.deepEqual(flattenShelf(nest), [`${DS}.[none:A:nk]`, `${DS}.[none:B:nk]`, `${DS}.[none:C/D:nk]`]);
	const concat = parseShelf(`(${DS}.[sum:Sales:qk] + ${DS}.[sum:Profit:qk])`);
	assert.equal(concat.op, 'concat');
	assert.equal(concat.children.length, 2);
	const mixed = parseShelf(`(${DS}.[none:A:nk] / (${DS}.[sum:S:qk] + ${DS}.[sum:P:qk]))`);
	assert.equal(mixed.op, 'nest');
	assert.equal(mixed.children[1].op, 'concat');
	const cross = parseShelf(`(${DS}.[none:A:nk] * ${DS}.[none:B:nk]) / ${DS}.[none:C:nk]`);
	assert.equal(cross.op, 'nest');
	assert.equal(cross.children[0].op, 'cross');
	const precedence = parseShelf(`${DS}.[none:A:nk] + ${DS}.[none:B:nk] / ${DS}.[none:C:nk]`);
	assert.equal(precedence.op, 'concat');
	assert.equal(precedence.children[1].op, 'nest');
});

test('parseShelf handles escaped brackets, multi-part pills and stray tokens', () => {
	const escaped = parseShelf(`(${DS}.[none:A]] (x):nk] / ${DS}.[__tableau_internal_object_id__].[cnt:O_1:qk])`);
	assert.deepEqual(flattenShelf(escaped), [`${DS}.[none:A]] (x):nk]`, `${DS}.[__tableau_internal_object_id__].[cnt:O_1:qk]`]);
	assert.deepEqual(flattenShelf(parseShelf(`) ${DS}.[a] (`)), [`${DS}.[a]`]);
	assert.deepEqual(flattenShelf(parseShelf('[Multiple Values]')), ['[Multiple Values]']);
});
