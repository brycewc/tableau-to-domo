import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { findCreatedCard, mayHaveCreated } from '../../src/domo/cards.js';
import { pushPlan, stripFormulaRefs } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { HttpError } from '../../src/util/http.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const quiet = createEmitter(noopSink, 'test');
let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

async function setup() {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.ir, { irVersion: 1, workbook: { name: 'Sales', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	return { ws, config: testConfig(root) };
}

const serverError = () => new HttpError('PUT https://acme.domo.com/api/content/v3/cards/kpi failed: HTTP 500: Unable to create card', { status: 500, method: 'PUT', url: '', body: '' });

function onePlan() {
	const plan = samplePlan();
	plan.beastModes = plan.beastModes.filter((bm) => bm.key !== 'orders:bad');
	plan.cards = plan.cards.slice(0, 1);
	delete plan.cards[0].bigNumber;
	return plan;
}

/** Card creates that fail with HTTP 500 after Domo saved `saved` cards on the page. */
function failingCreate(saved) {
	const stub = stubDomo({ invalid: [] });
	Object.assign(stub.deps.cards, {
		createCard: async (_c, body, opts) => {
			stub.calls.push({ name: 'createCard', args: { body, opts } });
			throw serverError();
		},
		mayHaveCreated,
		findCreatedCard: (_c, opts) => {
			const client = {
				get: async (url) => {
					stub.calls.push({ name: 'listPageCards', args: { url } });
					return saved();
				}
			};
			return findCreatedCard(client, opts);
		}
	});
	return stub;
}

test('a card create answered with HTTP 500 that Domo saved anyway is recovered, then updated to the planned definition', async () => {
	const { ws, config } = await setup();
	const now = Math.floor(Date.now() / 1000);
	const stub = failingCreate(() => [
		{ id: 316176780, title: 'Sales by Region', created: now },
		{ id: 1, title: 'Sales by Region', created: now - 86400 },
		{ id: 2, title: 'Other', created: now }
	]);
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan: onePlan(), emitter: quiet });
	const action = result.actions.find((a) => a.key === 'sheet-1');
	assert.equal(action.status, 'ok', action.error);
	assert.equal(action.action, 'create');
	assert.equal(action.id, 316176780);
	assert.match(action.notes.join(' '), /HTTP 500.*recovered card 316176780/);
	assert.equal(stub.calls.filter((c) => c.name === 'createCard').length, 1);
	const pageId = stub.calls.find((c) => c.name === 'createCard').args.opts.pageId;
	assert.deepEqual(stub.calls.filter((c) => c.name === 'listPageCards').map((c) => c.args.url), [`/content/v1/pages/${pageId}/cards`]);
	const update = stub.calls.find((c) => c.name === 'updateCard');
	assert.equal(update.args.id, 316176780);
	assert.equal(update.args.body.definition.title, 'Sales by Region');
	const state = await loadState(ws, 'acme');
	assert.equal(state.objects['card:sheet-1'].id, 316176780);
	assert.ok(state.objects['card:sheet-1'].hash);
});

test('a failed card create with no new card of its title on the page fails with the original error', async () => {
	const { ws, config } = await setup();
	const stub = failingCreate(() => []);
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan: onePlan(), emitter: quiet });
	const action = result.actions.find((a) => a.key === 'sheet-1');
	assert.equal(action.status, 'failed');
	assert.match(action.error, /HTTP 500: Unable to create card/);
	assert.equal((await loadState(ws, 'acme')).objects['card:sheet-1'], undefined);
});

test('a failed card create with several new cards of its title fails naming them, and adopts none', async () => {
	const { ws, config } = await setup();
	const now = Date.now();
	const stub = failingCreate(() => [
		{ id: 11, title: 'Sales by Region', created: now },
		{ id: 12, title: 'Sales  by Region', created: now }
	]);
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan: onePlan(), emitter: quiet });
	const action = result.actions.find((a) => a.key === 'sheet-1');
	assert.equal(action.status, 'failed');
	assert.match(action.error, /HTTP 500.*2 cards titled "Sales by Region".*ids 11, 12/);
	assert.equal((await loadState(ws, 'acme')).objects['card:sheet-1'], undefined);
});

test('a card already in state is never taken for the one a failed create saved', async () => {
	const now = Date.now();
	const c = { get: async () => [{ id: 5, title: 'T', created: now }, { id: 6, title: 'T', created: now }] };
	assert.deepEqual(await findCreatedCard(c, { pageId: 9, titles: ['T'], since: now, known: new Set(['5']) }), { id: 6 });
	assert.equal(await findCreatedCard(c, { pageId: 9, titles: ['T'], since: now + 3600000, known: new Set() }), undefined);
	assert.equal(mayHaveCreated(new HttpError('x', { status: 400 })), false);
	assert.equal(mayHaveCreated(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
	assert.equal(mayHaveCreated(new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } })), false);
});

test('a card formula reads a dataset beast mode through its template id, and is dropped with its uses when the beast mode is not pushed', async () => {
	const { config } = await setup();
	const plan = samplePlan();
	const def = plan.cards[0].body.definition;
	def.formulas.card = [
		{ id: 'calculation_card_1', name: 'Ratio x2', formula: 'DOMO_BEAST_MODE(calculation_ratio) * 2', templateId: -1, aggregated: true, isCalculation: true },
		{ id: 'calculation_card_2', name: 'Bad x2', formula: 'DOMO_BEAST_MODE(calculation_bad) * 2', templateId: -2, aggregated: true, isCalculation: true }
	];
	def.subscriptions.main.columns.push({ column: 'calculation_card_1', formulaId: 'calculation_card_1', mapping: 'VALUE' }, { column: 'calculation_card_2', formulaId: 'calculation_card_2', mapping: 'VALUE' });
	const stub = stubDomo();
	const result = await pushPlan({ config, slug: 'sales', deps: stub.deps, plan, emitter: quiet });
	const ratioId = result.actions.find((a) => a.key === 'orders:ratio').id;
	const body = stub.calls.find((c) => c.name === 'createCard' && c.args.body.definition.title === 'Sales by Region').args.body;
	assert.deepEqual(body.definition.formulas.card.map((f) => f.formula), [`DOMO_BEAST_MODE(${ratioId}) * 2`]);
	assert.deepEqual(body.definition.subscriptions.main.columns.map((col) => col.formulaId ?? col.column), ['Region', 'Sales', 'calculation_card_1']);
	assert.match(result.actions.find((a) => a.key === 'sheet-1').notes.join(' '), /pushed without beast mode\(s\): Bad/);
});

test('stripFormulaRefs drops a card formula that references a dropped beast mode and the columns that use it', () => {
	const body = {
		dataProvider: { dataSourceId: ref('dataset', 'orders') },
		definition: {
			formulas: { card: [{ id: 'calculation_card_1', formula: 'YEAR(DOMO_BEAST_MODE(calculation_gone))' }, { id: 'calculation_card_2', formula: 'MAX(1)' }] },
			subscriptions: { main: { columns: [{ column: 'calculation_card_1', formulaId: 'calculation_card_1' }, { column: 'calculation_card_2', formulaId: 'calculation_card_2' }], orderBy: [{ column: 'calculation_card_1', formulaId: 'calculation_card_1' }] } }
		}
	};
	const [out, removed] = stripFormulaRefs(body, new Set(['calculation_gone']));
	assert.equal(removed, 3);
	assert.deepEqual(out.definition.formulas.card.map((f) => f.id), ['calculation_card_2']);
	assert.deepEqual(out.definition.subscriptions.main.columns.map((col) => col.column), ['calculation_card_2']);
	assert.deepEqual(out.definition.subscriptions.main.orderBy, []);
	assert.deepEqual(out.dataProvider, body.dataProvider);
});
