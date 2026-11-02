import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandKnownSplits, expandSplitCard, orderSplitMembers } from '../../src/convert/split.js';
import { buildCardBody } from '../../src/convert/cards.js';

const split = (extra = {}) => ({ pillId: 'p', name: 'Product', ref: { column: 'Product' }, filter: { column: 'Product', filterType: 'COLUMN_ID', operand: 'IN', dataType: 'string' }, max: 6, colors: { 'Product B': '#edc948' }, colorColumns: ['Age'], ...extra });

function plan(cardSplit) {
	const body = buildCardBody({ title: 'L3 Age', datasetKey: 'ds', chartType: 'badge_line_bar', subscription: { columns: [], filters: [{ column: 'Level', operand: 'IN', values: ['L3'] }] } });
	const content = (contentKey, key, extra = {}) => ({ contentKey, type: 'CARD', cardId: { $ref: `card:${key}` }, ...extra });
	return {
		cards: [{ key: 'age', title: 'L3 Age', worksheet: 'L3 age', datasetKey: 'ds', chartType: 'badge_line_bar', body, pageKeys: ['l3'], status: 'approximate', split: cardSplit }],
		pages: [
			{
				key: 'l3',
				layout: {
					content: [content(1, 'age'), content(2, 'below'), content(3, 'details', { interaction: { config: { selectedCardUrns: [{ $ref: 'card:age', field: 'urn' }] } } })],
					standard: { template: [{ contentKey: 1, x: 30, y: 47, width: 30, height: 30 }, { contentKey: 2, x: 30, y: 77, width: 30, height: 10 }, { contentKey: 3, x: 0, y: 47, width: 30, height: 30 }] },
					compact: { template: [{ contentKey: 1, x: 0, y: 77, width: 12, height: 7 }, { contentKey: 2, x: 0, y: 84, width: 12, height: 5 }] }
				}
			}
		]
	};
}

test('members order as Tableau draws panes: natural ascending, a manual order, or descending', () => {
	assert.deepEqual(orderSplitMembers(['Product B', 'Product A', 'Product C', 'Product B', null]), ['Product A', 'Product B', 'Product C']);
	assert.deepEqual(orderSplitMembers(['P10', 'P7']), ['P7', 'P10']);
	assert.deepEqual(orderSplitMembers(['a', 'b', 'c'], { order: ['c', 'a'] }), ['c', 'a', 'b']);
	assert.deepEqual(orderSplitMembers(['a', 'b'], { direction: 'DESC' }), ['b', 'a']);
});

test('a split card becomes one card per member: filter, title suffix and the member color on its bars', () => {
	const p = plan(split());
	const result = expandSplitCard(p, 'age', ['Product B', 'Product A', 'Product C']);
	assert.deepEqual(result.keys, ['age.product-a', 'age.product-b', 'age.product-c']);
	assert.deepEqual(p.cards.map((c) => c.title), ['L3 Age: Product A', 'L3 Age: Product B', 'L3 Age: Product C']);
	const member = p.cards[1];
	assert.equal(member.split, undefined);
	assert.deepEqual(member.splitOf, { key: 'age', member: 'Product B' });
	assert.deepEqual(member.body.definition.dynamicTitle, { text: [{ type: 'TEXT', text: 'L3 Age: Product B' }] });
	assert.deepEqual(member.body.definition.subscriptions.main.filters.at(-1), { column: 'Product', filterType: 'COLUMN_ID', operand: 'IN', dataType: 'string', values: ['Product B'] });
	assert.deepEqual(member.body.definition.conditionalFormats.card.map((r) => [r.condition.column, r.condition.values, r.format.color]), [['Age', [], '#edc948']]);
	assert.deepEqual(p.cards[0].body.definition.conditionalFormats.card, [], 'a member without a Tableau color keeps the chart palette');
});

test('a member card appends its member to a variable title as a TEXT item', () => {
	const p = plan(split());
	const variable = { type: 'VARIABLE_VALUE', variables: [{ $ref: 'variable:v' }], defaultText: 'Geo' };
	p.cards[0].body.definition.dynamicTitle = { text: [{ type: 'TEXT', text: 'By ' }, variable] };
	expandSplitCard(p, 'age', ['Product B', 'Other']);
	assert.deepEqual(p.cards.map((c) => c.body.definition.dynamicTitle.text), [
		[{ type: 'TEXT', text: 'By ' }, variable, { type: 'TEXT', text: ': Other' }],
		[{ type: 'TEXT', text: 'By ' }, variable, { type: 'TEXT', text: ': Product B' }]
	]);
	const one = plan(split());
	one.cards[0].body.definition.dynamicTitle = { text: [{ type: 'TEXT', text: 'By ' }, variable] };
	expandSplitCard(one, 'age', ['Product B']);
	assert.deepEqual(one.cards[0].body.definition.dynamicTitle.text, [{ type: 'TEXT', text: 'By ' }, variable], 'one member keeps the title');
});

test('the layout item becomes stacked items at least a readable chart high; items below move down, items beside grow', () => {
	const p = plan(split());
	expandSplitCard(p, 'age', ['A', 'B', 'C']);
	const { layout } = p.pages[0];
	assert.deepEqual(layout.content.map((c) => [c.contentKey, c.cardId.$ref]), [[1, 'card:age.a'], [4, 'card:age.b'], [5, 'card:age.c'], [2, 'card:below'], [3, 'card:details']]);
	const box = (t) => t.template.map((i) => [i.contentKey, i.x, i.y, i.width, i.height]).sort((a, b) => a[0] - b[0]);
	assert.deepEqual(box(layout.standard), [[1, 30, 47, 30, 14], [2, 30, 89, 30, 10], [3, 0, 47, 30, 42], [4, 30, 61, 30, 14], [5, 30, 75, 30, 14]], 'three cards of 30 / 3 rows would draw no axes or labels; the card beside grows to the new bottom');
	assert.deepEqual(box(layout.compact), [[1, 0, 77, 12, 6], [2, 0, 95, 12, 5], [4, 0, 83, 12, 6], [5, 0, 89, 12, 6]], 'compact 7 rows become three of 6, so the next item moves down 11');
	assert.deepEqual(layout.content[4].interaction.config.selectedCardUrns.map((u) => u.$ref), ['card:age.a', 'card:age.b', 'card:age.c'], 'an interaction naming the card names every member card');
	const tall = plan(split());
	tall.pages[0].layout.standard.template[0].height = 60;
	tall.pages[0].layout.standard.template[2].height = 60;
	tall.pages[0].layout.standard.template[1].y = 107;
	expandSplitCard(tall, 'age', ['A', 'B', 'C']);
	assert.deepEqual(box(tall.pages[0].layout.standard).map((b) => b[4]), [20, 10, 60, 20, 20], 'a tall item divides evenly');
});

test('with member measures, each member card counts its member inside the value formulas and keeps every category', () => {
	const p = plan(split({ expression: '`Product`', measures: [{ column: 'Age', name: 'Age', formula: 'AVG(CASE WHEN __t2d_split_member__ THEN `Age` END)' }] }));
	const main = p.cards[0].body.definition.subscriptions.main;
	main.columns = [{ column: 'Period', mapping: 'ITEM' }, { column: 'Age', mapping: 'SERIES', aggregation: 'AVG', format: { type: 'number' } }];
	main.orderBy = [{ column: 'Age', order: 'DESCENDING' }];
	expandSplitCard(p, 'age', ['Product B', "Rob's"]);
	const def = p.cards[0].body.definition;
	assert.deepEqual(def.subscriptions.main.filters, [{ column: 'Level', operand: 'IN', values: ['L3'] }], 'no member filter, so periods without rows for the member stay on the axis');
	const formula = def.formulas.card.at(-1);
	assert.deepEqual([formula.name, formula.formula, formula.aggregated], ['Age', "AVG(CASE WHEN (`Product` = 'Product B') THEN `Age` END)", true]);
	assert.deepEqual(def.subscriptions.main.columns[1], { column: formula.id, formulaId: formula.id, mapping: 'SERIES', format: { type: 'number' } });
	assert.equal(def.subscriptions.main.orderBy[0].column, formula.id);
	assert.deepEqual(def.conditionalFormats.card.map((r) => [r.condition.column, r.format.color]), [[formula.id, '#edc948']], 'the member color goes on the new value column');
	assert.match(p.cards[1].body.definition.formulas.card.at(-1).formula, /= 'Rob''s'\)/);
});

test('one member keeps the card, its key and title, with the member filter and color', () => {
	const p = plan(split());
	assert.deepEqual(expandSplitCard(p, 'age', ['Product B']), { expanded: true, keys: ['age'] });
	const [card] = p.cards;
	assert.deepEqual([card.key, card.title, card.split, card.splitOf, card.body.definition.title], ['age', 'L3 Age', undefined, undefined, 'L3 Age']);
	assert.deepEqual(card.body.definition.subscriptions.main.filters.at(-1).values, ['Product B']);
	assert.equal(card.body.definition.conditionalFormats.card[0].format.color, '#edc948');
	assert.equal(p.pages[0].layout.content.length, 3);
});

test('no member, or more than the cap, keeps the one card', () => {
	const p = plan(split({ max: 2 }));
	assert.deepEqual(expandSplitCard(p, 'age', []), { expanded: false, reason: 'no Product member has rows' });
	assert.equal(expandSplitCard(p, 'age', ['a', 'b', 'c']).expanded, false);
	assert.equal(p.cards.length, 1);
});

test('convert expands the splits whose members an include filter names, and warns past the cap', () => {
	const known = plan(split({ members: ['B', 'A'] }));
	assert.deepEqual(expandKnownSplits(known), []);
	assert.deepEqual(known.cards.map((c) => c.key), ['age.a', 'age.b']);
	const many = plan(split({ members: ['a', 'b', 'c'], max: 2 }));
	const issues = expandKnownSplits(many);
	assert.equal(issues[0].code, 'chart.small-multiples');
	assert.equal(many.cards[0].split, undefined);
	const unknown = plan(split());
	assert.deepEqual(expandKnownSplits(unknown), []);
	assert.ok(unknown.cards[0].split, 'members found at push');
});
