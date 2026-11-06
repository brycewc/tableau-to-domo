import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards } from '../../src/convert/cards.js';
import { planPages } from '../../src/convert/layout.js';
import { SECTION_COLUMN, findCrosstabStacks, planCrosstabStacks } from '../../src/convert/stack.js';
import { DS, DATASET, FIELDS, p, sheet, workbook, makeBindings, cat } from './cards.fixtures.test.js';

const OPEN_ID = 'calculation_00000000-0000-5000-8000-000000000001';
const END_ID = 'calculation_00000000-0000-5000-8000-000000000002';
const FY = p('none', 'Fiscal Year');
const SEGMENT = p('none', 'Segment');
const OPENING = p('none', 'Opening');
const ENDING = p('none', 'Ending');
const CATEGORY = p('none', 'Category');
const COLS = `(${FY} / ${SEGMENT})`;
const constant = (name, legacyId) => ({ datasetKey: DATASET, kind: 'formula', name, formulaId: legacyId, expression: `'${name}'`, aggregated: false, dataType: 'STRING', tableauType: 'string' });
const bindings = () => makeBindings({ '[Opening]': constant('Opening', OPEN_ID), '[Ending]': constant('Ending', END_ID) });
const beastMode = (name, legacyId) => ({ key: `${DATASET}.${name.toLowerCase()}`, datasetKey: DATASET, name, legacyId, expression: `'${name}'`, aggregated: false, dataType: 'STRING', tableauFieldId: `[${name}]`, tableauFormula: `"${name}"`, status: 'ok', features: [] });

function stackIr({ endShowsHeaders = false, endExtraZone = false } = {}) {
	const open = sheet({ name: 'Dyn Open', rows: OPENING, cols: COLS, enc: { text: [p('sum', 'Sales', 'qk')] } });
	const main = sheet({
		name: 'Dyn Main',
		rows: CATEGORY,
		cols: COLS,
		enc: { text: [p('sum', 'Profit', 'qk')] },
		sorts: [{ pillId: CATEGORY, kind: 'manual', direction: 'ASC', order: ['Technology', 'Furniture', 'Office Supplies'] }],
		filters: [cat('Category', ['Technology', 'Furniture'])]
	});
	main.hiddenHeaders = [FY, SEGMENT];
	const end = sheet({ name: 'Dyn End', rows: ENDING, cols: COLS, enc: { text: [p('sum', 'Quantity', 'qk')] } });
	if (!endShowsHeaders) end.hiddenHeaders = [FY, SEGMENT];
	const zone = (id, worksheet, y, h) => ({ id, kind: 'worksheet', worksheet, rect: { x: 0.01, y, w: 0.98, h }, floating: false, showTitle: false });
	const zones = [zone('7', 'Dyn Open', 0.27, 0.1), zone('3', 'Dyn Main', 0.37, 0.15), zone('12', 'Dyn End', 0.52, 0.4)];
	const dashboards = [{ name: 'Waterfall', size: { mode: 'fixed', width: 1200, height: 800 }, zones, floating: [] }];
	if (endExtraZone) dashboards.push({ name: 'Other', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('1', 'Dyn End', 0.1, 0.3)], floating: [] });
	const ir = workbook({ worksheets: [open, main, end], dashboards });
	ir.datasources[0].fields = [...FIELDS, { id: '[Opening]', name: 'Opening', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '"Opening"' }, { id: '[Ending]', name: 'Ending', datatype: 'string', role: 'dimension', kind: 'calculated', formula: '"Ending"' }];
	return ir;
}

function planned(ir, target = { key: DATASET, name: 'Orders', strategy: 'upload', schema: [{ name: 'Sales', type: 'DOUBLE' }, { name: 'Category', type: 'STRING' }], fieldMap: {}, datasourceId: DS, cardTarget: true }, dataflows = []) {
	const { cards } = planCards(ir, bindings(), { options: {} });
	const data = { datasets: [target], dataflows, beastModes: [beastMode('Opening', OPEN_ID), beastMode('Ending', END_ID)] };
	const result = planCrosstabStacks(ir, cards, data, { workbookKey: 'wb' });
	return { cards, data, result };
}

test('stacked crosstabs over the same column headers, the lower ones hiding them, are one stack', () => {
	const ir = stackIr();
	const { cards } = planCards(ir, bindings(), { options: {} });
	const stacks = [...findCrosstabStacks(ir, cards).values()];
	assert.deepEqual(stacks.map((s) => s.sheets), [['Dyn Open', 'Dyn Main', 'Dyn End']]);
	assert.deepEqual(stacks[0].placements.map((pl) => pl.zones.map((z) => z.id)), [['7', '3', '12']]);

	const shown = stackIr({ endShowsHeaders: true });
	const shownCards = planCards(shown, bindings(), { options: {} }).cards;
	assert.deepEqual([...findCrosstabStacks(shown, shownCards).values()].map((s) => s.sheets), [['Dyn Open', 'Dyn Main']], 'a sheet that shows its own column headers starts no section');
});

test('a stack becomes one pivot on a union of the dataset with a section column, its sections sorted first', () => {
	const { cards, data, result } = planned(stackIr());
	assert.equal(result.cards.length, 1);
	const [card] = result.cards;
	assert.equal(card.key, 'wb.stack-dyn-open-dyn-main-dyn-end');
	assert.deepEqual(card.stack, { sheets: ['Dyn Open', 'Dyn Main', 'Dyn End'], datasetKey: `${DATASET}.stack-dyn-open` });
	for (const member of cards) assert.deepEqual([member.status, member.replacedBy, member.stackedInto], ['unsupported', 'stack', card.key]);

	const dataset = data.datasets.find((d) => d.key === card.datasetKey);
	assert.equal(dataset.strategy, 'dataflow-output');
	assert.equal(dataset.cardTarget, false);
	assert.deepEqual(dataset.schema.at(-1), { name: SECTION_COLUMN, type: 'LONG' });
	const [flow] = data.dataflows;
	assert.deepEqual(flow.outputDatasetKeys, [dataset.key]);
	assert.equal(dataset.dataflowOutput.dataflowKey, flow.key);
	const actions = flow.definition.actions;
	assert.deepEqual(actions.map((a) => a.type), ['LoadFromVault', 'ExpressionEvaluator', 'ExpressionEvaluator', 'ExpressionEvaluator', 'UnionAll', 'PublishToVault']);
	assert.deepEqual(actions.filter((a) => a.type === 'ExpressionEvaluator').map((a) => a.expressions), [1, 2, 3].map((i) => [{ fieldName: SECTION_COLUMN, expression: String(i) }]));
	const union = actions.find((a) => a.type === 'UnionAll');
	assert.deepEqual([union.unionType, union.schemaSource], ['INCLUDE_ALL', actions[1].id]);
	assert.equal(actions.at(-1).name, dataset.dataflowOutput.outputName);

	const def = card.body.definition;
	const main = def.subscriptions.main;
	const formula = (id) => def.formulas.card.find((f) => f.id === id);
	assert.deepEqual(main.columns.map((c) => [c.mapping, c.alias]), [['ROW', ' '], ['COLUMN', undefined], ['COLUMN', undefined], ['VALUE', ' ']]);
	assert.deepEqual(main.columns.slice(1, 3).map((c) => c.column), ['Fiscal Year', 'Segment']);
	assert.equal(formula(main.columns[0].formulaId).formula, "CASE WHEN `t2d_section` = 1 THEN ('Opening') WHEN `t2d_section` = 2 THEN `Category` WHEN `t2d_section` = 3 THEN ('Ending') END");
	assert.equal(formula(main.columns[3].formulaId).formula, 'CASE WHEN MAX(`t2d_section`) = 1 THEN SUM(`Sales`) WHEN MAX(`t2d_section`) = 2 THEN SUM(`Profit`) WHEN MAX(`t2d_section`) = 3 THEN SUM(`Quantity`) END');
	assert.equal(formula(main.orderBy[0].formulaId).formula, 'MIN(`t2d_section`)');
	assert.match(formula(main.orderBy[1].formulaId).formula, /^CASE WHEN MIN\(`t2d_section`\) = 2 THEN \(MIN\(CASE WHEN `Category` = 'Technology' THEN 1/);
	assert.deepEqual(main.orderBy.slice(2).map((o) => o.column), [main.columns[0].column, 'Fiscal Year', 'Segment']);
	assert.deepEqual(JSON.parse(def.charts.main.overrides.column_sort).map((s) => s.column), ['Fiscal Year', 'Segment'], 'the row label keeps the query order');
	assert.equal(def.charts.main.overrides.total_row, 'false');

	const keep = data.beastModes.find((bm) => bm.key === `${dataset.key}.stack-rows`);
	assert.equal(keep.expression, "CASE WHEN `t2d_section` = 1 THEN 'true' WHEN `t2d_section` = 2 THEN CASE WHEN `Category` IN ('Technology', 'Furniture') THEN 'true' ELSE 'false' END WHEN `t2d_section` = 3 THEN 'true' ELSE 'false' END");
	assert.deepEqual(main.filters, [{ column: keep.legacyId, operand: 'IN', values: ['true'], dataType: 'string' }]);
	const clones = data.beastModes.filter((bm) => bm.datasetKey === dataset.key && bm !== keep);
	assert.deepEqual(clones.map((bm) => [bm.name, bm.key]), [['Opening', `${DATASET}.opening@dyn-open-dyn-main-dyn-end`], ['Ending', `${DATASET}.ending@dyn-open-dyn-main-dyn-end`]], 'same names, so page filters on them still match');
	assert.ok(clones.every((bm) => ![OPEN_ID, END_ID].includes(bm.legacyId)));
});

test('a stack over a Magic ETL output is a second output of its dataflow', () => {
	const target = { key: DATASET, name: 'Orders (Magic ETL calcs)', strategy: 'dataflow-output', sourceStrategy: 'upload', schema: [{ name: 'Sales', type: 'DOUBLE' }], dataflowOutput: { dataflowKey: 'orders.etl', outputName: 'Orders (Magic ETL calcs)' }, fieldMap: {}, datasourceId: DS, cardTarget: true };
	const flow = {
		key: 'orders.etl',
		name: 'Orders (Tableau calcs)',
		definition: { actions: [{ type: 'LoadFromVault', id: 'in-source', gui: { x: 50, y: 50 } }, { type: 'ExpressionEvaluator', id: 'calc-x', dependsOn: ['in-source'], gui: { x: 270, y: 50 } }, { type: 'PublishToVault', id: 'out-output', name: 'Orders (Magic ETL calcs)', dependsOn: ['calc-x'], gui: { x: 490, y: 50 } }] },
		outputDatasetKeys: [DATASET],
		runAfterCreate: true
	};
	const { data, result } = planned(stackIr(), target, [flow]);
	assert.equal(result.cards.length, 1);
	assert.equal(data.dataflows.length, 1);
	assert.deepEqual(flow.outputDatasetKeys, [DATASET, `${DATASET}.stack-dyn-open`]);
	const sections = flow.definition.actions.filter((a) => a.id.startsWith('stack-') && a.type === 'ExpressionEvaluator');
	assert.deepEqual(sections.map((a) => a.dependsOn), [['calc-x'], ['calc-x'], ['calc-x']], 'the sections read what the first output publishes');
	assert.equal(flow.definition.actions.filter((a) => a.type === 'PublishToVault').length, 2);
});

test('a sheet also shown outside the stack keeps its card', () => {
	const { cards } = planned(stackIr({ endExtraZone: true }));
	assert.deepEqual(cards.map((c) => [c.worksheet, c.status]), [['Dyn Open', 'unsupported'], ['Dyn Main', 'unsupported'], ['Dyn End', 'ok']]);
});

test('the merged card takes the head zone, as tall as its rows, with no title when its zones show none', () => {
	const ir = stackIr();
	const { cards, result } = planned(ir);
	const all = [...cards, ...result.cards];
	const pages = planPages(ir, all, bindings(), { options: { target: 'pages' }, workbookKey: 'wb', stacks: result.placements });
	const page = pages.pages.find((pg) => pg.dashboard === 'Waterfall');
	const placed = page.layout.content.filter((c) => c.type === 'CARD').map((c) => c.cardId.$ref);
	assert.deepEqual(placed, [`card:${result.cards[0].key}`]);
	const item = page.layout.standard.template.find((t) => t.contentKey === page.layout.content.find((c) => c.cardId?.$ref === placed[0]).contentKey);
	assert.equal(item.height, 20, 'the pivot minimum, not the 50 rows the three zones span');
	assert.equal(page.layout.content.find((c) => c.cardId?.$ref === placed[0]).hideTitle, true, 'no member zone shows its title');
});

test('a stack in zones shorter than its rows keeps the height of its rows', () => {
	const ir = stackIr();
	ir.dashboards[0].zones.forEach((z, i) => Object.assign(z.rect, { y: 0.27 + i * 0.03, h: 0.03 }));
	Object.assign(ir.worksheets[1], { sorts: [], filters: [] });
	const { cards, result } = planned(ir);
	const pages = planPages(ir, [...cards, ...result.cards], bindings(), { options: { target: 'pages' }, workbookKey: 'wb', stacks: result.placements });
	const page = pages.pages.find((pg) => pg.dashboard === 'Waterfall');
	const content = page.layout.content.find((c) => c.cardId?.$ref === `card:${result.cards[0].key}`);
	assert.equal(page.layout.standard.template.find((t) => t.contentKey === content.contentKey).height, 28, '8 rows and 2 header levels, not the 7 rows the zones span');
	assert.deepEqual(pages.issues.filter((i) => i.code === 'layout.crosstab-stack').map((i) => i.message.split(' is ')[0]), ['Worksheet Dyn Main', 'Worksheet Dyn End']);
	assert.ok(!pages.pages.some((pg) => pg.dashboard === '' && pg.layout?.content.some((c) => /dyn-/.test(c.cardId?.$ref ?? ''))), 'the retired members are not orphans');
});

test('on an app, an action that targets a section sheet reaches the merged card', () => {
	const ir = stackIr();
	const zone = (id, worksheet, y) => ({ id, kind: 'worksheet', worksheet, rect: { x: 0.01, y, w: 0.48, h: 0.2 }, floating: false, showTitle: false });
	ir.worksheets.push(sheet({ name: 'Bars', rows: CATEGORY, cols: p('sum', 'Sales', 'qk'), mark: 'Bar' }), sheet({ name: 'Other', rows: CATEGORY, cols: p('sum', 'Profit', 'qk'), mark: 'Bar' }));
	ir.dashboards[0].zones.push(zone('20', 'Bars', 0.02), { ...zone('21', 'Other', 0.02), rect: { x: 0.51, y: 0.02, w: 0.48, h: 0.2 } });
	ir.actions = [{ id: '[F]', name: 'F', type: 'filter', trigger: 'select', source: { type: 'sheet', worksheet: 'Bars', worksheets: ['Bars'] }, target: { name: 'Waterfall', kind: 'dashboard', worksheets: ['Dyn Main'] }, allFields: true, clear: 'show-all' }];
	const { cards, result } = planned(ir);
	const pages = planPages(ir, [...cards, ...result.cards], bindings(), { options: { target: 'app' }, workbookKey: 'wb', stacks: result.placements });
	const page = pages.pages.find((pg) => pg.dashboard === 'Waterfall');
	const bars = page.layout.content.find((c) => c.cardId?.$ref === `card:${cards.find((c) => c.worksheet === 'Bars').key}`);
	assert.deepEqual(bars.interaction.config.selectedCardUrns, [{ $ref: `card:${result.cards[0].key}`, field: 'urn' }]);
});

test('the section rows beast mode inlines the beast modes its conditions reference', () => {
	const FLAG_ID = 'calculation_00000000-0000-5000-8000-000000000003';
	const ir = stackIr();
	const main = ir.worksheets.find((w) => w.name === 'Dyn Main');
	const flag = cat('Flag', ['x']);
	main.filters.push(flag);
	main.pills[flag.pillId] = { ...main.pills[p('none', 'Category')], fieldId: '[Flag]', id: flag.pillId };
	ir.datasources[0].fields.push({ id: '[Flag]', name: 'Flag', datatype: 'string', role: 'dimension', kind: 'calculated', formula: 'IF [Ending] = "Ending" THEN "x" END' });
	const expression = `CASE WHEN DOMO_BEAST_MODE(${END_ID}) = 'Ending' THEN 'x' END`;
	const binds = makeBindings({ '[Opening]': constant('Opening', OPEN_ID), '[Ending]': constant('Ending', END_ID), '[Flag]': { ...constant('Flag', FLAG_ID), expression } });
	const { cards } = planCards(ir, binds, { options: {} });
	const data = { datasets: [{ key: DATASET, name: 'Orders', strategy: 'upload', schema: [], fieldMap: {}, datasourceId: DS, cardTarget: true }], dataflows: [], beastModes: [beastMode('Opening', OPEN_ID), beastMode('Ending', END_ID), { ...beastMode('Flag', FLAG_ID), expression }] };
	planCrosstabStacks(ir, cards, data, { workbookKey: 'wb' });
	const keep = data.beastModes.find((bm) => bm.key.endsWith('.stack-rows'));
	assert.ok(keep.expression.includes(`(CASE WHEN ('Ending') = 'Ending' THEN 'x' END) IN ('x')`), keep.expression);
	assert.ok(!keep.expression.includes('DOMO_BEAST_MODE'), keep.expression);
});

test('a dashboard filter shown on one section and a fixed copy on the others stays one card filter the view default can replace', () => {
	const ir = stackIr();
	const { cards } = planCards(ir, bindings(), { options: {} });
	const region = { column: 'Region', filterType: 'COLUMN_ID', operand: 'IN', values: ['East'], dataType: 'string' };
	const selection = { column: 'Region', name: 'Region', dataType: 'string', operand: 'IN', values: ['East'], pillIds: ['[region]'] };
	for (const card of cards) {
		if (card.worksheet === 'Dyn Main') card.quickFilterDefaults = [selection];
		else {
			card.body.definition.subscriptions.main.filters.push({ ...region });
			card.scopedFilters = [{ pillId: '[region]', default: selection, filters: [{ ...region }] }];
		}
	}
	const data = { datasets: [{ key: DATASET, name: 'Orders', strategy: 'upload', schema: [], fieldMap: {}, datasourceId: DS, cardTarget: true }], dataflows: [], beastModes: [beastMode('Opening', OPEN_ID), beastMode('Ending', END_ID)] };
	const [card] = planCrosstabStacks(ir, cards, data, { workbookKey: 'wb' }).cards;
	const filters = card.body.definition.subscriptions.main.filters;
	assert.equal(filters.filter((f) => f.column === 'Region').length, 1);
	assert.ok(!data.beastModes.find((bm) => bm.key.endsWith('.stack-rows')).expression.includes('Region'), 'not a section row condition');
	assert.deepEqual(card.quickFilterDefaults, [selection]);
	assert.deepEqual(card.scopedFilters.map((s) => s.filters), [[region]]);
});

test('the merged card keeps the smart text title of its head', () => {
	const ir = stackIr();
	const { cards } = planCards(ir, bindings(), { options: {} });
	const items = [{ type: 'TEXT', text: 'By ' }, { type: 'VARIABLE_VALUE', variables: ['variable:param.pick.string'], defaultText: 'Geo' }];
	for (const c of cards) c.body.definition.dynamicTitle = { text: items };
	const data = { datasets: [{ key: DATASET, name: 'Orders', strategy: 'upload', schema: [], fieldMap: {}, datasourceId: DS, cardTarget: true }], dataflows: [], beastModes: [beastMode('Opening', OPEN_ID), beastMode('Ending', END_ID)] };
	const [card] = planCrosstabStacks(ir, cards, data, { workbookKey: 'wb' }).cards;
	assert.deepEqual(card.body.definition.dynamicTitle.text, items);
});

test('sections sharing one date range keep it on the merged card; a section with another starts no stack', () => {
	const ir = stackIr();
	const { cards } = planCards(ir, bindings(), { options: {} });
	const range = { column: { column: 'Quarter Start', exprType: 'COLUMN' }, dateTimeRange: { dateTimeRangeType: 'ROLLING_PERIOD', interval: 'QUARTER', count: 20, offset: 0 } };
	for (const c of cards) c.body.definition.subscriptions.main.dateRangeFilter = range;
	const data = { datasets: [{ key: DATASET, name: 'Orders', strategy: 'upload', schema: [], fieldMap: {}, datasourceId: DS, cardTarget: true }], dataflows: [], beastModes: [beastMode('Opening', OPEN_ID), beastMode('Ending', END_ID)] };
	const [card] = planCrosstabStacks(ir, cards, data, { workbookKey: 'wb' }).cards;
	assert.deepEqual(card.body.definition.subscriptions.main.dateRangeFilter, range);

	const other = planCards(ir, bindings(), { options: {} }).cards;
	for (const c of other) c.body.definition.subscriptions.main.dateRangeFilter = range;
	other[2].body.definition.subscriptions.main.dateRangeFilter = { ...range, dateTimeRange: { ...range.dateTimeRange, count: 4 } };
	assert.deepEqual([...findCrosstabStacks(ir, other).values()].map((s) => s.sheets), [['Dyn Open', 'Dyn Main']]);
});
