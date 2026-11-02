import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

const OWNER_ID = '11111111-1111-5111-8111-111111111111';
const TIME_ID = '22222222-2222-5222-8222-222222222222';

function notebookPlan() {
	const plan = samplePlan();
	plan.beastModes = [];
	plan.cards = [
		{
			key: 'status.text',
			kind: 'notebook',
			title: 'Data Updated Sheet',
			worksheet: 'Data Updated Sheet',
			datasetKey: 'orders',
			chartType: 'notebook',
			body: {
				notebook: { title: 'Data Updated Sheet', paragraphs: [[{ text: 'Owner', bold: true }, { text: ' : ' }, { owner: 'Ann Lee', id: OWNER_ID }, { text: ' | Refreshed : ' }, { smart: 'DATA_SOURCE_DATA_LAST_UPDATED', id: TIME_ID }]] },
				dataSourceId: ref('dataset', 'orders')
			},
			pageKeys: ['dash'],
			status: 'ok'
		}
	];
	plan.pages[0].layout = {
		content: [{ contentKey: 1, type: 'CARD', cardId: ref('card', 'status.text'), hideTitle: true }],
		standard: { width: 60, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 60, height: 6 }] },
		compact: { width: 12, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 6 }] }
	};
	return plan;
}

async function setup(plan) {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, plan);
	await ws.writeJson(p.ir, { irVersion: 1, workbook: { name: 'Sales', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	return { ws, config: testConfig(root) };
}

function withNotebooks(owner) {
	const stub = stubDomo({ invalid: [] });
	const { deps, calls } = stub;
	deps.datasets.getDataset = async (_c, id) => {
		calls.push({ name: 'getDataset', args: { id } });
		return { id, owner: { name: owner } };
	};
	deps.notebooks = {
		createNotebook: async (_c, spec) => {
			calls.push({ name: 'createNotebook', args: spec });
			return { id: 4242 };
		},
		updateNotebook: async (_c, id, body) => {
			calls.push({ name: 'updateNotebook', args: { id, body } });
		}
	};
	return stub;
}

test('a text card is created on its view, then written with its smart text; the owner is owner smart text when it is the dataset owner', async () => {
	const { ws, config } = await setup(notebookPlan());
	const first = withNotebooks('ann  lee');
	const summary = await pushPlan({ config, slug: 'sales', deps: first.deps });
	assert.equal(summary.ok, true);
	const create = first.calls.find((c) => c.name === 'createNotebook');
	const pageId = first.calls.filter((c) => c.name === 'createPage').length && (await loadState(ws, 'acme')).objects['page:dash'].id;
	assert.deepEqual(create.args, { title: 'Data Updated Sheet', pageId });
	const { body } = first.calls.find((c) => c.name === 'updateNotebook').args;
	assert.deepEqual(Object.entries(body.dynamicTextItems).map(([id, item]) => [id, item.type, item.dataSourceId]), [
		[OWNER_ID, 'DATA_SOURCE_OWNER', 'ds-orders'],
		[TIME_ID, 'DATA_SOURCE_DATA_LAST_UPDATED', 'ds-orders']
	]);
	assert.equal(body.title, 'Data Updated Sheet');
	assert.ok(first.calls.findIndex((c) => c.name === 'updateNotebook') < first.calls.findIndex((c) => c.name === 'writeLayout'));
	assert.equal(first.calls.find((c) => c.name === 'writeLayout').args.layout.content[0].cardId, 4242);
	const state = await loadState(ws, 'acme');
	assert.deepEqual([state.objects['card:status.text'].id, state.objects['card:status.text'].extra.ownerSmart], [4242, true]);

	const second = withNotebooks('Ann Lee');
	const again = await pushPlan({ config, slug: 'sales', deps: second.deps });
	assert.equal(again.actions.find((a) => a.key === 'status.text').action, 'unchanged');
	assert.ok(!second.calls.some((c) => c.name === 'createNotebook' || c.name === 'updateNotebook'));

	const third = withNotebooks('Sam Lee');
	const changed = await pushPlan({ config, slug: 'sales', deps: third.deps });
	assert.equal(changed.actions.find((a) => a.key === 'status.text').action, 'update');
	const update = third.calls.find((c) => c.name === 'updateNotebook').args;
	assert.equal(update.id, 4242);
	assert.deepEqual(Object.values(update.body.dynamicTextItems).map((i) => i.type), ['DATA_SOURCE_DATA_LAST_UPDATED']);
	assert.ok(update.body.textHtml.includes('Ann Lee'), 'another owner leaves the Tableau name as text');
	assert.match(changed.actions.find((a) => a.key === 'status.text').notes.join(' '), /plain text: the dataset owner is "Sam Lee"/);
});

test('a text card whose dataset is not pushed shows its text only, with an issue; a dry run plans the create', async () => {
	const plan = notebookPlan();
	const { config } = await setup(plan);
	const dry = await pushPlan({ config, slug: 'sales', dryRun: true });
	assert.equal(dry.actions.find((a) => a.key === 'status.text').action, 'create');
	const stub = withNotebooks('Ann Lee');
	const summary = await pushPlan({ config, slug: 'sales', deps: stub.deps, only: 'pages,cards' });
	const { body } = stub.calls.find((c) => c.name === 'updateNotebook').args;
	assert.deepEqual([body.dynamicTextItems, body.subscriptions], [{}, []]);
	assert.ok(summary.issues.some((i) => i.code === 'push.notebook-text-only'));
	assert.ok(!stub.calls.some((c) => c.name === 'getDataset'));
});
