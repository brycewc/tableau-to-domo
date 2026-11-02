import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { keyMatcher, matchNames, mentions, normalizeSelection, planColumns, selectIrDatasources, selectPlan, SelectionError, usedBeastModes } from '../../src/convert/select.js';
import { collectRefs } from '../../src/util/refs.js';
import { superstorePlan } from './superstore-plan.js';

after(async () => (await superstorePlan()).cleanup());

test('one dashboard keeps its cards, filter card, the dataflow with its 3 inputs and only referenced beast modes', async () => {
	const { plan, ir } = await superstorePlan();
	const sub = selectPlan(plan, { dashboards: ['executive overview'] }, { ir });
	assert.deepEqual(sub.pages.map((p) => p.key).sort(), ['superstore', 'superstore--executive-overview']);
	assert.ok(sub.pages.find((p) => p.key === 'superstore--executive-overview').layout, 'the dashboard keeps its layout');
	assert.equal(sub.pages.find((p) => p.key === 'superstore').layout, undefined, 'the parent page is only a container');
	assert.deepEqual(sub.selection.containerPages, ['superstore']);
	const layoutCards = [...collectRefs(sub.pages.find((p) => p.key === 'superstore--executive-overview').layout)].filter((r) => r.startsWith('card:')).map((r) => r.slice(5));
	assert.deepEqual(sub.cards.map((c) => c.key).sort(), layoutCards.sort());
	assert.ok(sub.cards.some((c) => c.key.startsWith('filter-')), 'filter card kept');
	assert.ok(!sub.cards.some((c) => c.worksheet === 'Sales Crosstab'), 'other dashboard cards dropped');
	assert.equal(sub.dataflows.length, 1);
	const target = sub.datasets.find((d) => d.strategy === 'dataflow-output');
	assert.ok(target);
	const inputs = sub.datasets.filter((d) => d.strategy === 'upload');
	assert.equal(inputs.length, 3, 'the dataflow and its 3 input datasets');
	assert.ok(!sub.datasets.some((d) => d.key === 'superstore.sales-targets-published'), 'unused datasource dropped');
	assert.deepEqual(sub.beastModes.map((b) => b.name), ['Profit Ratio', 'Running Sales']);
	assert.equal(sub.selection.counts.before.beastModes, plan.beastModes.length);
	assert.equal(sub.selection.counts.after.cards, sub.cards.length);
	for (const card of sub.cards) assert.ok(card.pageKeys.every((k) => sub.pages.some((p) => p.key === k)));
});

test('an unplaced unsupported card of a kept dashboard stays in the plan so push can retire it; it keeps no dataset', async () => {
	const { plan, ir } = await superstorePlan();
	const dash = ir.dashboards.find((d) => d.name.toLowerCase() === 'executive overview');
	const sheet = dash.zones.find((z) => z.worksheet).worksheet;
	const label = { key: 'superstore.label', title: 'Label', worksheet: sheet, datasetKey: 'superstore.sales-targets-published', pageKeys: [], status: 'unsupported' };
	const other = { ...label, key: 'superstore.other', worksheet: 'Not On It' };
	const sub = selectPlan({ ...plan, cards: [...plan.cards, label, other] }, { dashboards: ['executive overview'] }, { ir });
	assert.ok(sub.cards.some((c) => c.key === 'superstore.label'));
	assert.ok(!sub.cards.some((c) => c.key === 'superstore.other'));
	assert.ok(!sub.datasets.some((d) => d.key === 'superstore.sales-targets-published'));
});

test('a section worksheet of a merged crosstab stack keeps the merged card', async () => {
	const { plan, ir } = await superstorePlan();
	const card = plan.cards.find((c) => c.worksheet === 'Sales vs Target');
	const member = { ...card, status: 'unsupported', replacedBy: 'stack', stackedInto: 'superstore.stack-a-b' };
	const merged = { ...card, key: 'superstore.stack-a-b', worksheet: '', stack: { sheets: ['A', 'Sales vs Target'], datasetKey: card.datasetKey } };
	const sub = selectPlan({ ...plan, cards: [...plan.cards.filter((c) => c !== card), member, merged] }, { worksheets: ['sales VS target'] }, { ir });
	assert.deepEqual(sub.cards.map((c) => c.key).sort(), [card.key, 'superstore.stack-a-b'].sort());
});

test('allBeastModes keeps every beast mode on kept datasets; nested references are followed', async () => {
	const { plan, ir } = await superstorePlan();
	const all = selectPlan(plan, { dashboards: ['Executive Overview'], allBeastModes: true }, { ir });
	assert.equal(all.beastModes.length, plan.beastModes.filter((b) => all.datasets.some((d) => d.key === b.datasetKey)).length);
	const nested = structuredClone(plan);
	const ratio = nested.beastModes.find((b) => b.name === 'Profit Ratio');
	const flag = nested.beastModes.find((b) => b.name === 'Profit Ratio Flag');
	ratio.expression = `CASE WHEN \`${flag.name}\` = 'x' THEN 1 END`;
	const sub = selectPlan(nested, { dashboards: ['Executive Overview'] }, { ir });
	assert.deepEqual(sub.beastModes.map((b) => b.name).sort(), ['Profit Ratio', 'Profit Ratio Flag', 'Running Sales']);
});

test('usedBeastModes follows cards on their dataset, drill paths, pages, dataflows and nested beast modes', () => {
	const bm = (key, datasetKey, expression = '1') => ({ key, datasetKey, name: key.toUpperCase(), legacyId: `calculation_${key}`, expression });
	const plan = {
		datasets: [{ key: 'a' }, { key: 'b', view: { sql: 'SELECT `VIEWED` FROM t' } }],
		dataflows: [{ key: 'df', definition: { expr: 'calculation_flow' } }],
		beastModes: [bm('card', 'a', '`NESTED` + 1'), bm('nested', 'a'), bm('drill', 'a'), bm('page', 'b'), bm('flow', 'a'), bm('viewed', 'b'), bm('unused', 'a'), { ...bm('copy', 'b'), legacyId: 'calculation_card' }],
		cards: [{ key: 'c1', datasetKey: 'a', body: { formula: 'calculation_card' }, drillPath: [{ body: { col: 'calculation_drill' } }] }],
		pages: [{ key: 'p', filters: [{ column: '`PAGE`' }] }],
		variables: []
	};
	assert.deepEqual([...usedBeastModes(plan)].sort(), ['card', 'drill', 'flow', 'nested', 'page', 'viewed']);
});

test('a worksheet keeps its card and container pages; a datasource keeps its datasets and all their beast modes', async () => {
	const { plan, ir } = await superstorePlan();
	const ws = selectPlan(plan, { worksheets: ['sales VS target'] }, { ir });
	assert.deepEqual(ws.cards.map((c) => c.worksheet), ['Sales vs Target']);
	assert.ok(ws.pages.every((p) => !p.layout));
	const ds = selectPlan(plan, { datasources: ['Sales Targets*'] }, { ir });
	assert.deepEqual(ds.datasets.map((d) => d.key), ['superstore.sales-targets-published']);
	assert.equal(ds.cards.length, 0);
	assert.ok(ds.beastModes.every((b) => b.datasetKey === 'superstore.sales-targets-published'));
});

test('unknown names are a SelectionError listing valid names; globs and comma lists match', async () => {
	const { plan, ir } = await superstorePlan();
	assert.throws(
		() => selectPlan(plan, { dashboards: ['Nope'] }, { ir }),
		(err) => err instanceof SelectionError && /Unknown dashboard "Nope"\. Valid dashboards: "Executive Overview", "Details"/.test(err.message)
	);
	assert.deepEqual(matchNames(['exec*'], ['Executive Overview', 'Details'], 'dashboard'), ['Executive Overview']);
	assert.deepEqual(matchNames(['Details,Executive Overview'], ['Executive Overview', 'Details'], 'dashboard'), ['Executive Overview', 'Details']);
	assert.deepEqual(matchNames(['A, B'], ['A, B', 'A'], 'worksheet'), ['A, B']);
	assert.throws(() => normalizeSelection({ kinds: 'cards,widgets' }), /Unknown kind "widgets"/);
	assert.throws(() => normalizeSelection({ sampleRows: '0' }), /positive integer/);
	assert.deepEqual(normalizeSelection({ kinds: 'card,beast-modes', keys: 'a,b', sampleRows: '10' }), { kinds: ['cards', 'beastmodes'], keys: ['a', 'b'], sampleRows: 10 });
	assert.equal(selectPlan(plan, {}), plan, 'no selection returns the plan');
	assert.deepEqual(matchNames(['Topic Report '], ['Topic Report ', 'Other'], 'worksheet'), ['Topic Report ']);
	assert.deepEqual(matchNames(['Customer Detail'], ['  Customer Detail', 'Customer Detail ', 'Other'], 'worksheet'), ['  Customer Detail', 'Customer Detail ']);
});

test('mentions: a variable named like a dataset column is matched by legacyId only', () => {
	const v = { legacyId: 'calculation_v', name: 'Partner' };
	assert.ok(mentions('SUM(`Partner`)', v));
	assert.ok(!mentions('SUM(`Partner`)', v, { columns: new Set(['partner']) }));
	assert.ok(mentions('DOMO_BEAST_MODE(calculation_v)', v, { columns: new Set(['partner']) }));
	assert.deepEqual([...planColumns({ datasets: [{ schema: [{ name: 'Partner' }] }] })], ['partner']);
});

test('keyMatcher and IR datasource selection', async () => {
	const { ir } = await superstorePlan();
	const ok = keyMatcher(['card:superstore.sales-*', 'superstore--details']);
	assert.ok(ok('card', 'superstore.sales-by-category'));
	assert.ok(ok('page', 'superstore--details'));
	assert.ok(!ok('dataset', 'superstore.sales-x'));
	assert.ok(keyMatcher(undefined)('x', 'y'));
	const picked = selectIrDatasources(ir, { dashboards: ['Details'] });
	assert.equal(picked.datasourceIds.size, 1);
	assert.deepEqual(picked.dashboards, ['Details']);
});
