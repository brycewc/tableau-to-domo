import test from 'node:test';
import assert from 'node:assert/strict';
import { convertWorkbook } from '../../src/convert/index.js';
import { activeLinks, filterPredicate, linkCandidates, planBlends, rewriteSecondaryRefs, wrapAggregates } from '../../src/convert/blends.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { formatSql } from '../../src/convert/sql-format.js';
import { blendIr, blendManifests, P, S, pillIds } from './blend-fixture.js';

const convert = (ir = blendIr()) => convertWorkbook(ir, { manifests: blendManifests(), options: { parameters: 'inline', combineDataflows: false } });
const cardOf = (plan, ws) => plan.cards.find((c) => c.worksheet === ws);
const flowOf = (plan, ws) => plan.dataflows.find((d) => d.key === cardOf(plan, ws).datasetKey);
const actions = (flow, type) => flow.definition.actions.filter((a) => a.type === type);
const columns = (card) => card.body.definition.subscriptions.main.columns;

test('a blended worksheet reads a dataflow that aggregates the secondary to the link and left-joins it', () => {
	const plan = convert();
	const card = cardOf(plan, 'By Region');
	const dataset = plan.datasets.find((d) => d.key === card.datasetKey);
	assert.equal(dataset.strategy, 'dataflow-output');
	assert.equal(dataset.cardTarget, true);
	const flow = flowOf(plan, 'By Region');
	assert.deepEqual(
		actions(flow, 'LoadFromVault').map((a) => a.dataSourceId),
		[{ $ref: 'dataset:blend.sales' }, { $ref: 'dataset:blend.targets' }]
	);
	const [group] = actions(flow, 'GroupBy');
	assert.deepEqual(group.groups, [{ name: 'Area' }]);
	assert.deepEqual(group.fields, [
		{ name: 'Manager', expression: formatSql("CASE WHEN MIN(`Manager`) = MAX(`Manager`) THEN MIN(`Manager`) ELSE '*' END") },
		{ name: 'Target', expression: 'SUM(`Target`)' }
	]);
	const [join] = actions(flow, 'MergeJoin');
	assert.deepEqual([join.joinType, join.keys1, join.keys2], ['LEFT OUTER', ['Region'], ['Area']]);
	assert.deepEqual(join.schemaModification2, [{ name: 'Area', rename: 'Area', remove: true }]);
	assert.deepEqual(columns(card), [
		{ column: 'Region', mapping: 'VALUE' },
		{ column: 'Manager', mapping: 'VALUE' },
		{ column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' },
		{ column: 'Target', mapping: 'VALUE', aggregation: 'MAX' },
		columns(card)[4]
	]);
	assert.equal(card.status, 'ok');
	assert.ok(!plan.issues.some((i) => ['card.blend', 'twb.blend', 'calc.blend'].includes(i.code)));
});

test('worksheets with the same primary, secondary and links share one blend dataflow', () => {
	const plan = convert();
	assert.equal(cardOf(plan, 'By Region').datasetKey, cardOf(plan, 'Region Targets').datasetKey);
	const joined = plan.issues.find((i) => i.code === 'blend.joined' && /By Region, Region Targets/.test(i.message));
	assert.ok(joined);
	assert.equal(plan.dataflows.length, 4);
});

test('a primary calc over secondary aggregates reads the per-link column', () => {
	const plan = convert();
	const bm = plan.beastModes.find((b) => b.name === 'Attainment');
	assert.equal(bm.datasetKey, cardOf(plan, 'By Region').datasetKey);
	assert.equal(bm.expression, 'SUM(`Sales`) / NULLIF(MAX(`Target`), 0)');
	assert.equal(bm.status, 'ok');
	assert.ok(!plan.beastModes.some((b) => b.name === 'Attainment' && b.datasetKey === 'blend.sales'));
	assert.ok(plan.issues.some((i) => i.code === 'blend.calc-moved'));
});

test('a link not in the view keeps each per-link value once and the card re-aggregates it', () => {
	const plan = convert();
	const flow = flowOf(plan, 'Total');
	const [window] = actions(flow, 'WindowAction');
	assert.deepEqual(window.groupRules, [{ column: 'Region', caseSensitive: false }]);
	assert.deepEqual(window.additions, [{ name: '_t2d_link_row_1', operation: { type: 'RANKING', operationType: 'ROW_NUMBER' } }]);
	const once = actions(flow, 'ExpressionEvaluator').find((a) => a.id.startsWith('once-'));
	assert.deepEqual(once.expressions, [{ fieldName: 'Target', expression: formatSql('CASE WHEN `_t2d_link_row_1` = 1 THEN `_t2d_blend_1` END') }]);
	assert.deepEqual(actions(flow, 'Metadata')[0].fields.map((f) => f.name), ['_t2d_link_row_1', '_t2d_blend_1']);
	assert.ok(columns(cardOf(plan, 'Total')).some((c) => c.column === 'Target' && c.aggregation === 'SUM'));
	assert.ok(plan.issues.some((i) => i.code === 'blend.link-not-in-view' && i.object.name === 'Total'));
	assert.notEqual(cardOf(plan, 'Total').datasetKey, cardOf(plan, 'By Region').datasetKey);
});

test('a link not in the view keeps each per-link value once per link and primary view dimension', () => {
	const ir = blendIr();
	const product = `[${P}].[none:Product:nk]`;
	const ws = structuredClone(ir.worksheets.find((w) => w.name === 'Total'));
	ws.name = 'By Product';
	ws.rowPills = [product];
	ws.pills[product] = { id: product, datasourceId: P, fieldId: '[Product]', derivation: 'None', prefix: 'none', typeKey: 'nk', continuous: false, aggregated: false, datePart: null, dateTrunc: null };
	ir.worksheets.push(ws);
	const plan = convert(ir);
	const [window] = actions(flowOf(plan, 'By Product'), 'WindowAction');
	assert.deepEqual(window.groupRules.map((r) => r.column), ['Region', 'Product']);
	assert.deepEqual(actions(flowOf(plan, 'Total'), 'WindowAction')[0].groupRules.map((r) => r.column), ['Region']);
	assert.notEqual(cardOf(plan, 'Total').datasetKey, cardOf(plan, 'By Product').datasetKey);
});

test('a primary calc copied into the blend datasource reports its issue once', () => {
	const ir = blendIr();
	ir.datasources[0].fields.push({ id: '[Bad]', name: 'Bad', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM(RAWSQL_REAL("1", [Sales]))' });
	const bad = `[${P}].[usr:Bad:qk]`;
	const ws = ir.worksheets.find((w) => w.name === 'By Region');
	ws.panes[0].encodings.text.push(bad);
	ws.pills[bad] = { id: bad, datasourceId: P, fieldId: '[Bad]', derivation: 'User', prefix: 'usr', typeKey: 'qk', continuous: true, aggregated: true, datePart: null, dateTrunc: null };
	assert.equal(convert(ir).issues.filter((i) => i.object?.id === '[Bad]').length, 1);
});

test('a blended value using TODAY() warns that the dataflow freezes it at its last run', () => {
	const ir = blendIr();
	const secondary = ir.datasources.find((d) => d.id === S);
	secondary.fields.push({ id: '[Due]', name: 'Due', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM(IF [Target Date] <= TODAY() THEN [Target] END)' });
	const due = `[${S}].[usr:Due:qk]`;
	const ws = ir.worksheets.find((w) => w.name === 'Region Targets');
	ws.panes[0].encodings.text.push(due);
	ws.pills[due] = { id: due, datasourceId: S, fieldId: '[Due]', derivation: 'User', prefix: 'usr', typeKey: 'qk', continuous: true, aggregated: true, datePart: null, dateTrunc: null };
	const plan = convert(ir);
	assert.deepEqual(plan.issues.filter((i) => i.code === 'blend.today').map((i) => i.object.name), ['Due']);
});

test('a fixed filter on a secondary dimension restricts the secondary rows inside the aggregation', () => {
	const plan = convert();
	const [group] = actions(flowOf(plan, 'Segment A'), 'GroupBy');
	assert.deepEqual(group.fields, [{ name: 'Target', expression: formatSql("SUM(CASE WHEN `Segment` IN ('A') THEN `Target` END)") }]);
	assert.deepEqual(cardOf(plan, 'Segment A').body.definition.subscriptions.main.filters, []);
	assert.ok(plan.issues.some((i) => i.code === 'blend.secondary-filter-folded'));
});

test('a date-part link joins on the date part of both sides', () => {
	const plan = convert();
	const flow = flowOf(plan, 'By Year');
	const keys = actions(flow, 'ExpressionEvaluator').map((a) => a.expressions);
	assert.deepEqual(keys, [[{ fieldName: '_t2d_link_1', expression: 'YEAR(`Target Date`)' }], [{ fieldName: '_t2d_link_1', expression: 'YEAR(`Order Date`)' }]]);
	assert.deepEqual(actions(flow, 'MergeJoin')[0].keys1, ['_t2d_link_1']);
	assert.deepEqual(actions(flow, 'Metadata')[0].fields, [{ name: '_t2d_link_1', remove: true }]);
});

test('a secondary used only through filters on link fields moves the filters onto the primary, with no join', () => {
	const plan = convert();
	const card = cardOf(plan, 'Area Filter');
	assert.equal(card.datasetKey, 'blend.sales');
	assert.deepEqual(card.body.definition.subscriptions.main.filters, [{ column: 'Region', operand: 'IN', values: ['East'], dataType: 'string', filterType: 'COLUMN_ID' }]);
	assert.ok(plan.issues.some((i) => i.code === 'blend.filter-mapped' && i.object.name === 'Area Filter'));
});

test('dashboard filter zones on a related datasource map to the linked field', () => {
	const ir = blendIr();
	ir.dashboards = [{ name: 'D', size: { mode: 'automatic' }, zones: [{ id: '1', kind: 'filter', worksheet: 'Area Filter', param: pillIds.area, rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false }], floating: [] }];
	ir.worksheets = ir.worksheets.map((w) => (w.name === 'Area Filter' ? { ...w, filters: [], pills: { [pillIds.region]: w.pills[pillIds.region], [pillIds.sales]: w.pills[pillIds.sales] }, datasourceIds: [P] } : w));
	const r = planBlends(ir, { datasets: [{ key: 'p', cardTarget: true, datasourceId: P, schema: [], fieldMap: {} }], dataflows: [] }, { workbookKey: 'wb' });
	assert.equal(r.ir.dashboards[0].zones[0].param, `[${P}].[none:Region:nk]`);
});

test('a secondary calc with a FIXED LOD is skipped with a warning', () => {
	const ir = blendIr();
	ir.datasources[1].fields.push({ id: '[Top]', name: 'Top', datatype: 'real', role: 'measure', kind: 'calculated', formula: '{FIXED [Area] : SUM([Target])}' });
	const ws = ir.worksheets[1];
	const id = `[${S}].[sum:Top:qk]`;
	ws.panes[0].encodings.text.push(id);
	ws.pills[id] = { id, datasourceId: S, fieldId: '[Top]', derivation: 'Sum', prefix: 'sum', typeKey: 'qk', continuous: true, aggregated: true, datePart: null, dateTrunc: null };
	const plan = convert(ir);
	assert.ok(plan.issues.some((i) => i.code === 'blend.field-skipped' && i.object.name === 'Top'));
	assert.ok(plan.issues.some((i) => i.code === 'card.unsupported-field' && /Top/.test(i.message)));
});

test('link candidates: a custom relationship maps differently named fields; otherwise same-name dimensions link', () => {
	const ir = blendIr();
	const [primary, secondary] = ir.datasources;
	assert.deepEqual(linkCandidates(ir, primary, secondary), [
		{ primary: '[Region]', secondary: '[Area]' },
		{ primary: '[Order Date]', secondary: '[Target Date]' }
	]);
	assert.deepEqual(linkCandidates({ ...ir, blendRelationships: [] }, primary, { ...secondary, fields: [...secondary.fields, { id: '[R]', name: 'Region', role: 'dimension', kind: 'column' }] }), [{ primary: '[Region]', secondary: '[R]' }]);
	const ws = { ...ir.worksheets[0], linkOverrides: { exclude: [`[${S}].[Area]`] } };
	assert.deepEqual(activeLinks(ws, P, S, linkCandidates(ir, primary, secondary)).links, []);
});

test('formula helpers', () => {
	const register = (sid, item) => (item.kind === 'expr' ? `MAX([x:${item.text}])` : `[f:${item.fieldId}]`);
	assert.equal(rewriteSecondaryRefs(`SUM([Sales]) - SUM([${S}].[Target]) + MIN([${S}].[Target Date])`, new Set([S]), register), `SUM([Sales]) - MAX([x:SUM([${S}].[Target])]) + MAX([x:MIN([${S}].[Target Date])])`);
	assert.equal(rewriteSecondaryRefs(`[${S}].[Manager] + "!"`, new Set([S]), register), '[f:[Manager]] + "!"');
	assert.equal(wrapAggregates('SUM([a]) / COUNTD([b])', '[s] = 1'), 'SUM(IF [s] = 1 THEN [a] END) / COUNTD(IF [s] = 1 THEN [b] END)');
	const field = { id: '[Segment]', datatype: 'string' };
	assert.equal(filterPredicate({ kind: 'categorical', include: ['A', 'B'] }, undefined, field), '[Segment] IN ("A", "B")');
	assert.equal(filterPredicate({ kind: 'categorical', exclude: ['A', null] }, undefined, field), 'NOT ([Segment] IN ("A") OR ISNULL([Segment]))');
	assert.equal(filterPredicate({ kind: 'categorical', all: true }, undefined, field), undefined);
});

test('the workbook parser reads blend relationships and link overrides', () => {
	const xml = `<workbook><datasource-relationships>
		<datasource-relationship source='${P}' target='${S}'><column-mapping>
			<map key='[${P}].[none:Region:nk]' value='[${S}].[none:Area:nk]' />
		</column-mapping></datasource-relationship>
	</datasource-relationships>
	<worksheets><worksheet name='W'><table><view><datasources><datasource name='${P}' /><datasource name='${S}' /></datasources></view>
		<join-lod-include-overrides><column>[${S}].[Area]</column></join-lod-include-overrides>
	</table></worksheet></worksheets></workbook>`;
	const ir = buildWorkbookIR(xml);
	assert.deepEqual(ir.blendRelationships, [{ source: P, target: S, mappings: [{ source: '[Region]', target: '[Area]' }] }]);
	assert.deepEqual(ir.worksheets[0].linkOverrides, { include: [`[${S}].[Area]`] });
});
