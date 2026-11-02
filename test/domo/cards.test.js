import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { createCard, updateCard, getCardDefinition, toWriteShape, applyBigNumber, deleteCard, cardTitle, previewMembers, createDrillView, updateDrillView, listDrillViews } from '../../src/domo/cards.js';

let mock;
afterEach(() => mock?.restore());

const body = () => ({
	dataProvider: { dataSourceId: 'ds-1' },
	definition: {
		title: 'Sales',
		charts: { main: { component: 'main', chartType: 'badge_vert_bar', overrides: {} } },
		subscriptions: { main: { name: 'main', columns: [], groupBy: [], orderBy: [], filters: [] } }
	}
});

test('createCard PUTs v3 kpi with pageId and fills mandatory empty sections', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'PUT', path: '/content/v3/cards/kpi', json: { id: 123, urn: '123' } }]);
	const res = await createCard(client, body(), { pageId: 99 });
	assert.deepEqual({ id: res.id, urn: res.urn }, { id: 123, urn: '123' });
	const [call] = mock.calls;
	assert.equal(call.url, 'https://acme.domo.com/api/content/v3/cards/kpi?pageId=99');
	const sent = jsonBody(call);
	assert.equal(sent.variables, true);
	assert.equal(sent.columns, false);
	assert.deepEqual(sent.definition.formulas, { card: [], dsUpdated: [], dsDeleted: [] });
	assert.deepEqual(sent.definition.annotations, { new: [], modified: [], deleted: [] });
	assert.deepEqual(sent.definition.conditionalFormats, { card: [], datasource: [] });
	assert.deepEqual(sent.definition.segments, { active: [], create: [], update: [], delete: [] });
	assert.deepEqual(sent.definition.controls, []);
});

test('the title is sent as the dynamic title too, and read back from either shape', async () => {
	const sent = toWriteShape({ title: 'Renamed', dynamicTitle: { text: [{ type: 'TEXT', text: 'Old' }], displayOnCardDetails: true } });
	assert.deepEqual(sent.dynamicTitle, { text: [{ type: 'TEXT', text: 'Renamed' }], displayOnCardDetails: true });
	const read = { title: null, dynamicTitle: { text: [{ type: 'TEXT', text: 'Sales ' }, { type: 'FILTER', defaultText: 'by Region' }] } };
	assert.deepEqual(toWriteShape(read).dynamicTitle, read.dynamicTitle, 'a read-back definition keeps its dynamic title');
	assert.equal(cardTitle(read), 'Sales by Region');
	const variable = { type: 'VARIABLE_VALUE', variables: [573597], defaultText: 'Geo' };
	const planned = { title: 'By Geo (End)', dynamicTitle: { text: [{ type: 'TEXT', text: 'By ' }, variable, { type: 'TEXT', text: ' (End)' }] } };
	const kept = toWriteShape(planned);
	assert.deepEqual(kept.dynamicTitle, planned.dynamicTitle, 'a variable title is sent as planned');
	assert.equal('title' in kept, false, 'without the plain title, as the live write was verified');
	assert.equal(cardTitle(kept), 'By Geo (End)');
	assert.equal(cardTitle({ title: 'Plain' }), 'Plain');
	assert.equal(cardTitle({}), undefined);
});

test('createCard retries on 400 while the dataset indexes', async () => {
	const { client } = testClient();
	let attempts = 0;
	mock = mockFetch([
		{
			method: 'PUT',
			path: '/content/v3/cards/kpi',
			repeat: true,
			handler: () => (++attempts === 1 ? { status: 400, text: 'column not found' } : { json: { id: 5, urn: '5' } })
		}
	]);
	const res = await createCard(client, body(), { pageId: 1 });
	assert.equal(res.id, 5);
	assert.equal(attempts, 2);
});

test('createCard gives up after the retry budget', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'PUT', path: '/content/v3/cards/kpi', status: 404, text: 'no', repeat: true }]);
	await assert.rejects(createCard(client, body(), { retries: 1 }), /HTTP 404/);
	assert.equal(mock.calls.length, 2);
	assert.equal(mock.calls[0].query.pageId, undefined);
});

test('createCard requires a dataSourceId', async () => {
	const { client } = testClient();
	await assert.rejects(createCard(client, { definition: {} }), /dataSourceId/);
});

test('updateCard, getCardDefinition and deleteCard paths', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'PUT', path: '/content/v3/cards/kpi/7', json: {} },
		{ method: 'PUT', path: '/content/v3/cards/kpi/definition', json: { id: 7 } },
		{ method: 'DELETE', path: '/content/v1/cards/7', text: '' }
	]);
	await updateCard(client, 7, body());
	await getCardDefinition(client, 7);
	assert.deepEqual(jsonBody(mock.calls[1]), { urn: '7', dynamicText: true, variables: true, columns: false });
	await deleteCard(client, 7);
	assert.equal(mock.calls[2].method, 'DELETE');
});

test('toWriteShape converts read arrays to write objects', () => {
	const read = {
		formulas: [
			{ id: 'calculation_card_1', formula: 'SUM(1)', persistedOnDataSource: false },
			{ id: 'calculation_ds', formula: 'SUM(2)', persistedOnDataSource: true }
		],
		annotations: [{ id: 1, content: 'x' }],
		conditionalFormats: [{ cardId: 7, condition: {} }, { dataSourceId: 'ds-1', condition: {} }],
		segments: { active: [3], definitions: [{ id: 3 }] },
		subscriptions: { main: {} },
		chartVersion: '12'
	};
	const out = toWriteShape(read);
	assert.deepEqual(out.formulas, { card: [read.formulas[0]], dsUpdated: [], dsDeleted: [] });
	assert.deepEqual(out.annotations, { new: [], modified: [], deleted: [] });
	assert.deepEqual(out.conditionalFormats, { card: [read.conditionalFormats[0]], datasource: [read.conditionalFormats[1]] });
	assert.deepEqual(out.segments, { active: [3], create: [], update: [], delete: [] });
	assert.equal(out.chartVersion, '12');
	assert.deepEqual(toWriteShape(out), out);
});

test('applyBigNumber reads, converts, adds big_number and updates', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{
			method: 'PUT',
			path: '/content/v3/cards/kpi/definition',
			json: { id: 7, definition: { formulas: [], annotations: [], conditionalFormats: [], subscriptions: { main: { name: 'main', dataSourceId: 'ds-1' } } } }
		},
		{ method: 'PUT', path: '/content/v3/cards/kpi/7', json: { id: 7 } }
	]);
	await applyBigNumber(client, 7, { columns: [{ column: 'Sales', aggregation: 'SUM' }], limit: 1 });
	const sent = jsonBody(mock.calls[1]);
	assert.deepEqual(sent.dataProvider, { dataSourceId: 'ds-1' });
	assert.equal(sent.definition.subscriptions.big_number.name, 'big_number');
	assert.deepEqual(sent.definition.subscriptions.big_number.columns, [{ column: 'Sales', aggregation: 'SUM' }]);
	assert.deepEqual(sent.definition.formulas, { card: [], dsUpdated: [], dsDeleted: [] });
	assert.deepEqual(sent.definition.subscriptions.main, { name: 'main', dataSourceId: 'ds-1' });
});

test('new card formulas sharing a negative templateId are renumbered (the server rejects duplicate ids)', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'PUT', path: '/content/v3/cards/kpi', json: { id: 1, urn: '1' } }]);
	const f = (id, templateId) => ({ id, name: id, formula: 'COUNT(1)', templateId, persistedOnDataSource: false });
	const definition = { formulas: { card: [f('calculation_card_1', -1), f('saved', 77), f('calculation_card_2', -1)], dsUpdated: [], dsDeleted: [] } };
	await createCard(client, { dataProvider: { dataSourceId: 'ds-1' }, definition });
	const sent = jsonBody(mock.calls[0]).definition.formulas.card.map((x) => [x.id, x.templateId]);
	assert.deepEqual(sent, [['calculation_card_1', -1], ['saved', 77], ['calculation_card_2', -2]]);
	assert.equal(definition.formulas.card[2].templateId, -1, 'the plan is not mutated');
});

test('applyBigNumber maps planned card formula ids to the ids the saved card gave them', async () => {
	const { client } = testClient();
	const saved = { id: 'calculation_d356', name: 'Distinct count of ID', formula: 'COUNT(DISTINCT `ID`)', persistedOnDataSource: false };
	mock = mockFetch([
		{ method: 'PUT', path: '/content/v3/cards/kpi/definition', json: { id: 7, definition: { formulas: [saved], subscriptions: { main: { name: 'main', dataSourceId: 'ds-1' } } } } },
		{ method: 'PUT', path: '/content/v3/cards/kpi/7', json: { id: 7 } }
	]);
	const bigNumber = { columns: [{ column: 'calculation_card_1', formulaId: 'calculation_card_1' }], filters: [{ formulaId: 'calculation_dataset_bm' }] };
	await applyBigNumber(client, 7, bigNumber, { cardFormulas: [{ id: 'calculation_card_1', name: 'Distinct count of ID' }] });
	const big = jsonBody(mock.calls[1]).definition.subscriptions.big_number;
	assert.deepEqual(big.columns, [{ column: 'calculation_d356', formulaId: 'calculation_d356' }]);
	assert.deepEqual(big.filters, [{ formulaId: 'calculation_dataset_bm' }]);
});

test('previewMembers groups a render preview by one column, keeping the filters, with unsaved formulas in read shape', async () => {
	const { client } = testClient();
	mock = mockFetch([{ method: 'PUT', path: '/content/v3/cards/kpi/render/preview', json: { chart: { datasources: { main: { data: { columns: ['Product'], rows: [['Product B'], ['Product C']] } } } } } }]);
	const b = body();
	b.definition.subscriptions.main.filters = [{ column: 'calculation_card_1', operand: 'IN', values: ['true'] }];
	b.definition.formulas = { card: [{ id: 'calculation_card_1', name: 'Range', formula: "CASE WHEN 1 = 1 THEN 'true' END", templateId: -1, dataType: 'string', aggregated: false }], dsUpdated: [], dsDeleted: [] };
	assert.deepEqual(await previewMembers(client, b, { column: 'calculation_pv', formulaId: 'calculation_pv' }), ['Product B', 'Product C']);
	const [call] = mock.calls;
	assert.equal(call.query.parts, 'dynamic');
	const sent = jsonBody(call).definition;
	assert.deepEqual(sent.subscriptions.main.columns, [{ column: 'calculation_pv', formulaId: 'calculation_pv', mapping: 'ITEM' }]);
	assert.deepEqual(sent.subscriptions.main.groupBy, [{ column: 'calculation_pv', formulaId: 'calculation_pv' }]);
	assert.deepEqual(sent.subscriptions.main.filters, b.definition.subscriptions.main.filters);
	assert.deepEqual(sent.formulas, [{ id: 'calculation_card_1', name: 'Range', formula: "CASE WHEN 1 = 1 THEN 'true' END", dataType: 'STRING', aggregated: false, isAggregatable: true }]);
	assert.deepEqual(sent.segments, { active: [], definitions: [] });
});

test('drill views: created with parentUrn, updated through their dr: urn, listed from drillPathURNs', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'PUT', path: '/content/v3/cards/kpi', json: { id: 55, urn: 'dr:55:9', drillpath: ['9'] } },
		{ method: 'PUT', path: '/content/v3/cards/kpi/dr:55:9', json: { id: 55 } },
		{ method: 'GET', path: '/content/v1/cards', json: [{ id: 9, drillPathURNs: ['dr:55:9', 'dr:56:9'] }] }
	]);
	assert.deepEqual(await createDrillView(client, 9, body()), { id: 55, urn: 'dr:55:9' });
	await updateDrillView(client, 9, 55, body());
	assert.deepEqual(await listDrillViews(client, 9), [{ id: 55, urn: 'dr:55:9' }, { id: 56, urn: 'dr:56:9' }]);
	assert.equal(mock.calls[0].url, 'https://acme.domo.com/api/content/v3/cards/kpi?parentUrn=9');
	assert.equal(jsonBody(mock.calls[1]).definition.title, 'Sales');
	assert.equal(mock.calls[2].query.parts, 'drillPathURNs');
});
