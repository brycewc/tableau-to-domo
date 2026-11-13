import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards } from '../../src/convert/cards.js';
import { applyDrillInteractions, swapPill } from '../../src/convert/drill.js';
import { DS, p, sheet, workbook, makeBindings, cat } from './cards.fixtures.test.js';

const SALES = p('sum', 'Sales', 'qk');
const PRODUCT = { name: 'Product', fields: ['[Category]', '[Sub-Category]', '[Customer]'] };

function plan(spec, { hierarchies = [PRODUCT], bindings = makeBindings() } = {}) {
	const ir = workbook({ worksheets: [sheet(spec)] });
	ir.datasources[0].hierarchies = hierarchies;
	const { cards, issues } = planCards(ir, bindings, { options: {} });
	return { card: cards[0], issues: issues.filter((i) => i.code.startsWith('card.drill')) };
}

const itemOf = (body) => body.definition.subscriptions.main.columns.find((c) => c.mapping === 'ITEM')?.column;

test('a bar on a hierarchy level drills one view per deeper level, same chart, no table drill', () => {
	const { card, issues } = plan({ name: 'Sales by Category', cols: p('none', 'Category'), rows: SALES, mark: 'Bar', filters: [cat('Region', ['East'])] });
	assert.equal(card.chartType, 'badge_vert_bar');
	assert.equal(card.body.definition.allowTableDrill, false);
	assert.deepEqual(card.drillPath.map((d) => [d.field, d.chartType, itemOf(d.body)]), [
		['[Sub-Category]', 'badge_vert_bar', 'Sub-Category'],
		['[Customer]', 'badge_vert_bar', 'Customer']
	]);
	const view = card.drillPath[0].body.definition;
	assert.equal(view.title, 'Sales by Category: Sub-Category');
	assert.deepEqual(view.dynamicTitle, { text: [{ type: 'TEXT', text: 'Sales by Category: Sub-Category' }] });
	assert.equal(view.allowTableDrill, false);
	assert.deepEqual(view.controls, []);
	assert.equal(card.body.definition.subscriptions.main.filters.length, 1);
	assert.deepEqual(view.subscriptions.main.filters, []);
	assert.deepEqual(view.subscriptions.main.groupBy.map((g) => g.column), ['Sub-Category']);
	assert.deepEqual(issues.map((i) => i.code), ['card.drill-path']);
	assert.match(issues[0].message, /2 level\(s\): Sub-Category, Customer/);
});

test('expanded levels stay on the card and the drill continues below the deepest one', () => {
	const { card } = plan({ cols: `${p('none', 'Category')} / ${p('none', 'Sub-Category')}`, rows: SALES, mark: 'Bar' });
	assert.deepEqual(card.drillPath.map((d) => d.field), ['[Customer]']);
	assert.equal(itemOf(card.drillPath[0].body), itemOf(card.body).replace(/Sub-Category/, 'Customer'));
});

test('the series drills when the axis is not a hierarchy level', () => {
	const { card } = plan({ cols: p('none', 'Region'), rows: SALES, mark: 'Bar', enc: { color: [p('none', 'Category')] } });
	const series = (body) => body.definition.subscriptions.main.columns.find((c) => c.mapping === 'SERIES')?.column;
	assert.equal(series(card.body), 'Category');
	assert.deepEqual(card.drillPath.map((d) => series(d.body)), ['Sub-Category', 'Customer']);
	assert.equal(itemOf(card.drillPath[0].body), 'Region');
});

test('a trellis group on a hierarchy level drills when the axis is not one', () => {
	const { card } = plan({ cols: `${p('none', 'Category')} / ${p('none', 'Region')}`, rows: SALES, mark: 'Bar' });
	const group = (body) => body.definition.subscriptions.main.columns.find((c) => c.mapping === 'GROUP1')?.column;
	assert.equal(itemOf(card.body), 'Region');
	assert.equal(group(card.body), 'Category');
	assert.deepEqual(card.drillPath.map((d) => group(d.body)), ['Sub-Category', 'Customer']);
	assert.equal(itemOf(card.drillPath[0].body), 'Region');
});

test('the deepest level has nothing to drill to; table drill stays on for a plain chart', () => {
	const { card, issues } = plan({ cols: p('none', 'Customer'), rows: SALES, mark: 'Bar' });
	assert.equal(card.drillPath, undefined);
	assert.equal(card.body.definition.allowTableDrill, true);
	assert.deepEqual(issues, []);
	assert.equal(plan({ cols: p('none', 'Region'), rows: SALES, mark: 'Bar' }, { hierarchies: [] }).card.body.definition.allowTableDrill, true);
});

test('a table drills with the hierarchy column swapped, and has no table drill', () => {
	const { card, issues } = plan({ rows: `${p('none', 'Category')} / ${p('none', 'Region')}`, mark: 'Text', enc: { text: [SALES] } });
	assert.match(card.chartType, /table/);
	assert.equal(card.body.definition.allowTableDrill, false);
	const names = (body) => body.definition.subscriptions.main.columns.map((c) => c.column);
	assert.deepEqual(card.drillPath.map((d) => [d.chartType, names(d.body)]), [
		[card.chartType, names(card.body).map((c) => (c === 'Category' ? 'Sub-Category' : c))],
		[card.chartType, names(card.body).map((c) => (c === 'Category' ? 'Customer' : c))]
	]);
	assert.deepEqual(issues.map((i) => i.code), ['card.drill-path']);
});

test('a filled map drills to the next map type, and to a table when the level has no map', () => {
	const geo = { name: 'Geo', fields: ['[Country]', '[State]', '[County]', '[City]'] };
	const { card } = plan({ name: 'Map', mark: 'Map', enc: { color: [SALES], detail: [p('none', 'Country')] } }, { hierarchies: [geo] });
	assert.equal(card.chartType, 'badge_world_map');
	assert.deepEqual(card.drillPath.map((d) => d.chartType), ['badge_map_us_state', 'badge_map_us_county', 'badge_basic_table']);
});

test('a date axis drills down the date levels by Domo date grain; an explicit hierarchy wins', () => {
	const { card, issues } = plan({ name: 'By year', cols: p('yr', 'Order Date', 'ok'), rows: SALES, mark: 'Bar' }, { hierarchies: [] });
	const grain = (body) => body.definition.subscriptions.main.dateGrain?.dateTimeElement;
	assert.deepEqual(card.drillPath.map((d) => [d.grain, d.chartType, grain(d.body), d.body.definition.title]), [
		['quarter', 'badge_vert_bar', 'QUARTER', 'By year: Order Date (Quarter)'],
		['month', 'badge_vert_bar', 'MONTH', 'By year: Order Date (Month)'],
		['day', 'badge_vert_bar', 'DAY', 'By year: Order Date (Day)']
	]);
	assert.equal(card.body.definition.allowTableDrill, false);
	assert.deepEqual(issues.map((i) => i.code), ['card.drill-date']);
	assert.deepEqual(plan({ cols: p('twk', 'Order Date', 'qk'), rows: SALES, mark: 'Line' }, { hierarchies: [] }).card.drillPath.map((d) => d.grain), ['day']);
	assert.equal(plan({ cols: p('tdy', 'Order Date', 'qk'), rows: SALES, mark: 'Line' }, { hierarchies: [] }).card.drillPath, undefined);
	assert.equal(plan({ cols: p('mdy', 'Order Date', 'ok'), rows: SALES, mark: 'Bar' }, { hierarchies: [] }).card.drillPath, undefined);
	const both = plan({ cols: p('yr', 'Order Date', 'ok'), rows: SALES, mark: 'Bar', enc: { color: [p('none', 'Category')] } });
	assert.deepEqual(both.card.drillPath.map((d) => d.field), ['[Sub-Category]', '[Customer]']);
});

test('a discrete month part drills to the day part', () => {
	const { card } = plan({ cols: p('mn', 'Order Date', 'ok'), rows: SALES, mark: 'Bar' }, { hierarchies: [] });
	assert.deepEqual(card.drillPath.map((d) => d.grain), ['day']);
	assert.match(JSON.stringify(card.drillPath[0].body.definition.formulas.card), /DAY|DAYOFMONTH/);
});

test('a level without a Domo column ends the drill path there', () => {
	const bindings = makeBindings({ '[Customer]': undefined });
	const { card, issues } = plan({ cols: p('none', 'Category'), rows: SALES, mark: 'Bar' }, { bindings });
	assert.deepEqual(card.drillPath.map((d) => d.field), ['[Sub-Category]']);
	assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['card.drill-path', 'info'], ['card.drill-unmapped', 'warning']]);
	assert.match(issues[1].message, /Customer and below are left out: the field has no Domo column/);
});

test('swapPill replaces the pill outside filters and drops a manual sort of it', () => {
	const ws = sheet({ cols: p('none', 'Category'), rows: SALES, filters: [cat('Category', ['A'])], sorts: [{ pillId: p('none', 'Category'), kind: 'manual', direction: 'ASC', order: ['A'] }] });
	const next = swapPill(ws, p('none', 'Category'), '[Customer]');
	assert.deepEqual(next.colPills, [`[${DS}].[none:Customer:nk]`]);
	assert.equal(next.filters[0].pillId, p('none', 'Category'));
	assert.deepEqual(next.sorts, []);
	assert.equal(next.pills[`[${DS}].[none:Customer:nk]`].fieldId, '[Customer]');
	assert.deepEqual(ws.colPills, [p('none', 'Category')]);
});

test('a drill path card drills in place unless its click carries a Tableau action', () => {
	const cards = [{ key: 'a', title: 'A', worksheet: 'A', drillPath: [{}] }, { key: 'b', title: 'B', worksheet: 'B', drillPath: [{}] }, { key: 'c', title: 'C', worksheet: 'C' }];
	const item = (key) => ({ type: 'CARD', cardId: { $ref: `card:${key}` } });
	const pages = [{ title: 'Dash', dashboard: 'Dash', layout: { content: [item('a'), item('b'), item('c')] } }];
	const ir = { actions: [{ type: 'filter', source: { dashboard: 'Dash', worksheets: ['B'] } }] };
	const issues = applyDrillInteractions(pages, cards, ir);
	assert.deepEqual(pages[0].layout.content.map((i) => i.interaction?.type), ['DRILL', undefined, undefined]);
	assert.deepEqual(issues.map((i) => [i.code, i.object.name]), [['card.drill-action', 'B']]);
});

test('a pivot drills from its column headers only', () => {
	const rows = plan({ rows: p('none', 'Category'), cols: p('none', 'Region'), mark: 'Text', enc: { text: [SALES] } });
	assert.equal(rows.card.chartType, 'badge_pivot_table');
	assert.equal(rows.card.drillPath, undefined);
	assert.match(rows.issues[0].message, /column headers only/);
	const cols = plan({ rows: p('none', 'Region'), cols: p('none', 'Category'), mark: 'Text', enc: { text: [SALES] } });
	assert.equal(cols.card.chartType, 'badge_pivot_table');
	assert.deepEqual(cols.card.drillPath.map((d) => [d.chartType, d.field]), [['badge_pivot_table', '[Sub-Category]'], ['badge_pivot_table', '[Customer]']]);
});
