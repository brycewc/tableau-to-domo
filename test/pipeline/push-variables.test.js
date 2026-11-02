import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pushPlan } from '../../src/pipeline/push.js';
import { loadState, saveState } from '../../src/pipeline/state.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { HttpError } from '../../src/util/http.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo, tempDir, testConfig } from './helpers.js';

let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		throw new Error(`unexpected network call ${init?.method ?? 'GET'} ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const PARAM = { id: '[Parameters].[Parameter 1]', name: 'Region Pick', datatype: 'string', domain: 'list', value: 'East', members: [{ value: 'East' }, { value: 'West' }] };
const VARIABLE = { key: 'param.region-pick.string', name: 'Region Pick', legacyId: 'calculation_00000000-0000-0000-0000-00000000000a', dataType: 'STRING', defaultExpression: "'East'", parameter: PARAM };

function variablePlan() {
	const plan = samplePlan();
	plan.variables = [VARIABLE];
	plan.beastModes[0].expression = "CASE WHEN `Region` = `Region Pick` THEN SUM(`Sales`) END";
	plan.beastModes.push({ ...plan.beastModes[0], key: 'orders:pick', name: 'Pick', legacyId: 'calculation_pick', expression: `CASE WHEN DOMO_BEAST_MODE(${VARIABLE.legacyId}) = 'East' THEN 1 ELSE 0 END` });
	const layout = plan.pages[0].layout;
	layout.content.push({ contentKey: 3, type: 'VARIABLE', variableControlId: ref('variable', VARIABLE.key), control: { controlType: 'VARIABLE', name: 'Region Pick', type: 'DROPDOWN', override: { exprType: 'STRING_VALUE', value: 'East' } } });
	layout.standard.template.push({ contentKey: 3, type: 'VARIABLE', x: 0, y: 20, width: 10, height: 5 });
	layout.compact.template.push({ contentKey: 3, type: 'VARIABLE', x: 0, y: 24, width: 12, height: 5 });
	return plan;
}

async function setup(plan, slug = 'sales') {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths(slug);
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\nWest,2\n');
	await ws.writeJson(p.plan, plan);
	await ws.writeJson(p.ir, { irVersion: 1, workbook: { name: 'Sales', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	return { root, ws, config: testConfig(root) };
}

function stub({ taken = [], pageControlExists = false, bareDuplicate = false } = {}) {
	const { deps, calls } = stubDomo({ invalid: [] });
	const create = deps.beastmodes.createBeastMode;
	deps.beastmodes.createBeastMode = async (c, spec) => {
		if (spec.variable && taken.includes(spec.name)) {
			calls.push({ name: 'createBeastMode', args: spec, failed: true });
			if (bareDuplicate) throw new HttpError('POST template failed: HTTP 500: {"message":"Internal database error"}', { status: 500 });
			throw new HttpError('POST template failed: HTTP 400: {"errorCode":"ib:7303","message":"global variable name must be unique"}', { status: 400 });
		}
		return create(c, spec);
	};
	deps.beastmodes.findByLegacyId = async () => undefined;
	let n = 0;
	deps.variables = {
		variableNameTaken: async (_c, name) => taken.includes(name),
		upsertDefaultControl: async (_c, variableId, control) => {
			calls.push({ name: 'upsertDefaultControl', args: { variableId, control } });
			return { id: 4000 + ++n };
		},
		upsertPageControl: async (_c, pageId, variableId, control, opts) => {
			calls.push({ name: 'upsertPageControl', args: { pageId, variableId, control, opts } });
			if (pageControlExists && opts.id == null) return { id: 4999 };
			return { id: opts.id ?? 4100 + ++n };
		}
	};
	return { deps, calls };
}

test('variables: references become DOMO_BEAST_MODE(id), controls are placed, cards carry variable controls', async () => {
	const { ws, config } = await setup(variablePlan());
	const { deps, calls } = stub();
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));

	const variable = calls.find((c) => c.name === 'createBeastMode' && c.args.variable);
	assert.equal(variable.args.name, 'Region Pick');
	const variableId = summary.actions.find((a) => a.kind === 'variable').id;
	const validated = calls.find((c) => c.name === 'validateExpressions').args.items;
	assert.equal(validated.find((i) => i.key === 'orders:ratio').expression, `CASE WHEN \`Region\` = DOMO_BEAST_MODE(${variableId}) THEN SUM(\`Sales\`) END`);
	assert.equal(validated.find((i) => i.key === 'orders:pick').expression, `CASE WHEN DOMO_BEAST_MODE(${variableId}) = 'East' THEN 1 ELSE 0 END`);

	const def = calls.find((c) => c.name === 'upsertDefaultControl');
	assert.equal(def.args.variableId, variableId);
	assert.equal(def.args.control.type, 'DROPDOWN');
	assert.deepEqual(def.args.control.values.map((v) => v.expression.value), ['East', 'West']);

	const page = calls.find((c) => c.name === 'upsertPageControl');
	assert.equal(page.args.variableId, variableId);
	assert.equal(page.args.control.override.value, 'East');
	const layout = calls.find((c) => c.name === 'writeLayout').args.layout;
	const item = layout.content.find((x) => x.type === 'VARIABLE');
	assert.equal(item.variableControlId, page.args.control && 4102);
	assert.equal(item.control, undefined);

	const card = calls.find((c) => c.name === 'createCard' && c.args.body.definition.title === 'Sales by Region');
	assert.deepEqual(card.args.body.definition.controls, undefined, 'a card without variable references gets no control');
	const ratioCard = calls.find((c) => c.name === 'createCard' && c.args.body.definition.title === 'Bad ratio');
	const controls = ratioCard.args.body.definition.controls;
	assert.equal(controls.length, 1);
	assert.deepEqual({ id: controls[0].id, function: controls[0].function, override: controls[0].override.value }, { id: null, function: { id: variableId }, override: 'East' });

	const state = await loadState(ws, 'acme');
	assert.equal(state.objects[`variable:${VARIABLE.key}`].extra.createdBy, 'sales');
	assert.deepEqual(state.objects['layout:dash'].extra.variableControls, { [VARIABLE.key]: 4102 });

	const again = stub();
	await pushPlan({ config, slug: 'sales', deps: again.deps, force: true });
	assert.equal(again.calls.find((c) => c.name === 'upsertPageControl').args.opts.id, 4102, 'the page control id from state is reused');
});

test('variables: a page pushed with an older layout hash is rewritten once, its control named after the caption', async () => {
	const { ws, config } = await setup(variablePlan());
	await pushPlan({ config, slug: 'sales', deps: stub({ taken: ['Region Pick'] }).deps });
	const state = await loadState(ws, 'acme');
	state.objects['layout:dash'].hash = 'older-writer';
	await saveState(ws, state);

	const again = stub({ taken: ['Region Pick'] });
	await pushPlan({ config, slug: 'sales', deps: again.deps });
	assert.ok(again.calls.some((c) => c.name === 'writeLayout'));
	const control = again.calls.find((c) => c.name === 'upsertPageControl').args;
	assert.equal(control.control.name, 'Region Pick', 'not the suffixed variable name "Region Pick (Tableau)"');
	assert.equal(control.opts.id, 4102);

	const third = stub({ taken: ['Region Pick'] });
	await pushPlan({ config, slug: 'sales', deps: third.deps });
	assert.ok(!third.calls.some((c) => c.name === 'writeLayout' || c.name === 'upsertPageControl'));
});

test('variables: a name taken by a variable t2d did not create gets a (Tableau) suffix', async () => {
	const { config } = await setup(variablePlan());
	const { deps, calls } = stub({ taken: ['Region Pick'] });
	const summary = await pushPlan({ config, slug: 'sales', deps });
	const action = summary.actions.find((a) => a.kind === 'variable');
	assert.equal(action.status, 'ok');
	assert.equal(action.name, 'Region Pick (Tableau)');
	assert.match(action.notes.join(' '), /unique on the instance/);
	assert.equal(calls.find((c) => c.name === 'upsertPageControl').args.control.name, 'Region Pick', 'the page control shows the Tableau caption');
	assert.equal(calls.find((c) => c.name === 'upsertDefaultControl').args.control.name, 'Region Pick (Tableau)');

	const bare = stub({ taken: ['Region Pick'], bareDuplicate: true });
	const { config: config2 } = await setup(variablePlan());
	const again = await pushPlan({ config: config2, slug: 'sales', deps: bare.deps });
	assert.equal(again.actions.find((a) => a.kind === 'variable').name, 'Region Pick (Tableau)', 'a bare 500 on a taken name is a duplicate too');
});

test('variables: another workbook reuses the variable without changing its default', async () => {
	const { root, ws, config } = await setup(variablePlan());
	await pushPlan({ config, slug: 'sales', deps: stub().deps });
	const other = variablePlan();
	other.variables = [{ ...VARIABLE, defaultExpression: "'West'", parameter: { ...PARAM, value: 'West' } }];
	const p2 = ws.paths('other');
	fs.mkdirSync(path.join(p2.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p2.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p2.plan, other);
	await ws.writeJson(p2.ir, { irVersion: 1, workbook: { name: 'Other', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	const { deps, calls } = stub();
	const summary = await pushPlan({ config: testConfig(root), slug: 'other', deps });
	assert.equal(summary.actions.find((a) => a.kind === 'variable').action, 'reuse');
	assert.ok(!calls.some((c) => (c.name === 'createBeastMode' || c.name === 'updateBeastMode') && (c.args.variable || c.args.spec?.expression === "'West'")));
	const state = await loadState(ws, 'acme');
	assert.deepEqual(state.objects[`variable:${VARIABLE.key}`].extra.workbooks, ['sales', 'other']);
});

test('variables: a reuse never writes the shared entry or control; once the owner unpushed, the next workbook owns it', async () => {
	const { root, ws, config } = await setup(variablePlan());
	await pushPlan({ config, slug: 'sales', deps: stub().deps });
	const stateFile = path.join(root, 'state', 'acme.json');
	const state = await loadState(ws, 'acme');
	const vref = `variable:${VARIABLE.key}`;
	delete state.objects[vref].extra.defaultControlId;
	fs.writeFileSync(stateFile, JSON.stringify(state));
	const other = variablePlan();
	other.variables = [{ ...VARIABLE, defaultExpression: "'West'", parameter: { ...PARAM, value: 'West' } }];
	const p2 = ws.paths('other');
	fs.mkdirSync(path.join(p2.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p2.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p2.plan, other);
	await ws.writeJson(p2.ir, { irVersion: 1, workbook: { name: 'Other', sourceFile: 'x' }, datasources: [], parameters: [], worksheets: [], dashboards: [], issues: [] });
	const first = stub();
	await pushPlan({ config: testConfig(root), slug: 'other', deps: first.deps });
	assert.ok(!first.calls.some((c) => c.name === 'upsertDefaultControl'));
	assert.equal((await loadState(ws, 'acme')).objects[vref].extra.createdBy, 'sales');

	const left = await loadState(ws, 'acme');
	left.objects[vref].extra.workbooks = ['other'];
	fs.writeFileSync(stateFile, JSON.stringify(left));
	const second = stub();
	const summary = await pushPlan({ config: testConfig(root), slug: 'other', deps: second.deps });
	assert.notEqual(summary.actions.find((a) => a.kind === 'variable').action, 'reuse');
	assert.equal((await loadState(ws, 'acme')).objects[vref].extra.createdBy, 'other');
});

test('variables: one found on the instance is adopted, and one deleted outside the workspace is recreated', async () => {
	const { ws, config } = await setup(variablePlan());
	const first = stub();
	first.deps.beastmodes.findByLegacyId = async () => ({ id: 777, name: 'Region Pick' });
	const summary = await pushPlan({ config, slug: 'sales', deps: first.deps });
	const action = summary.actions.find((a) => a.kind === 'variable');
	assert.equal(action.id, 777);
	assert.match(action.notes.join(' '), /unpush keeps it/);
	const vref = `variable:${VARIABLE.key}`;
	assert.equal((await loadState(ws, 'acme')).objects[vref].extra.adopted, true);

	const second = stub();
	second.deps.beastmodes.getBeastMode = async (_c, id) => {
		throw new HttpError(`GET template ${id}: HTTP 404`, { status: 404 });
	};
	const again = await pushPlan({ config, slug: 'sales', deps: second.deps });
	const recreated = again.actions.find((a) => a.kind === 'variable');
	assert.equal(recreated.action, 'create');
	assert.match(recreated.notes.join(' '), /777 no longer exists in Domo; recreated/);
	const entry = (await loadState(ws, 'acme')).objects[vref];
	assert.notEqual(entry.id, 777);
	assert.equal(entry.extra.adopted, undefined);
	assert.ok(second.calls.some((c) => c.name === 'updateBeastMode' && c.args.spec.expression.includes(`DOMO_BEAST_MODE(${entry.id})`)));
});

test('a card update Domo refuses for a card formula on a deleted template frees that formula and retries', async () => {
	const { ws, config } = await setup(variablePlan());
	await pushPlan({ config, slug: 'sales', deps: stub().deps });
	const changed = variablePlan();
	changed.cards[0].title = 'Renamed';
	changed.cards[0].body.definition.title = 'Renamed';
	await ws.writeJson(ws.paths('sales').plan, changed);
	const { deps, calls } = stub();
	let attempts = 0;
	const update = deps.cards.updateCard;
	deps.cards.updateCard = async (c, id, body) => {
		attempts += 1;
		if (attempts === 1) throw new HttpError('PUT card failed: HTTP 500', { status: 500 });
		return update(c, id, body);
	};
	deps.cards.getCardDefinition = async () => ({ definition: { formulas: [{ templateId: 9001, formula: 'MIN(DOMO_BEAST_MODE(555))', persistedOnDataSource: false, formulaDependencies: ['555'] }, { templateId: 9002, formula: 'SUM(1)', persistedOnDataSource: true, formulaDependencies: ['555'] }] } });
	deps.beastmodes.getBeastMode = async (_c, id) => {
		if (String(id) === '555') throw new HttpError('GET template: HTTP 404', { status: 404 });
		return { id };
	};
	const summary = await pushPlan({ config, slug: 'sales', deps });
	const card = summary.actions.find((a) => a.kind === 'card' && a.key === changed.cards[0].key);
	assert.equal(card.status, 'ok');
	assert.match(card.notes.join(' '), /cleared 1 card formula\(s\) that used a deleted template \(555\)/);
	assert.deepEqual(calls.filter((c) => c.name === 'updateBeastMode' && c.args.id === 9001).map((c) => c.args.spec), [{ expression: 'MIN(1)' }], 'only the card formula, not the dataset beast mode');
	assert.equal(attempts, 2);
});

test('variables: a beast mode whose variable failed is skipped', async () => {
	const { config } = await setup(variablePlan());
	const { deps } = stub({ taken: ['Region Pick', 'Region Pick (Tableau)', 'Region Pick (Tableau 2)', 'Region Pick (Tableau 3)', 'Region Pick (Tableau 4)', 'Region Pick (Tableau 5)'] });
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(summary.actions.find((a) => a.kind === 'variable').status, 'failed');
	const pick = summary.actions.find((a) => a.key === 'orders:pick');
	assert.equal(pick.status, 'skipped');
	assert.match(pick.error, /variable:param\.region-pick\.string/);
	assert.match(summary.actions.find((a) => a.kind === 'layout').notes.join(' '), /left out variable:/);
});

test('variables: a title VARIABLE_VALUE item resolves to the variable id and the card gets its variable control', async () => {
	const plan = variablePlan();
	const card = plan.cards.find((c) => c.title === 'Sales by Region');
	card.title = 'Sales by East';
	Object.assign(card.body.definition, { title: 'Sales by East', dynamicTitle: { text: [{ type: 'TEXT', text: 'Sales by ' }, { type: 'VARIABLE_VALUE', variables: [ref('variable', VARIABLE.key)], defaultText: 'East' }] } });
	const { config } = await setup(plan);
	const { deps, calls } = stub();
	deps.cards.cardTitle = (definition) => definition?.dynamicTitle?.text.map((i) => i.text ?? i.defaultText).join(' ');
	const create = deps.cards.createCard;
	deps.cards.createCard = async (c, body, opts) => ({ ...(await create(c, body, opts)), response: { definition: body.definition } });
	const summary = await pushPlan({ config, slug: 'sales', deps });
	assert.equal(summary.ok, true, JSON.stringify(summary.actions.filter((a) => a.status !== 'ok')));
	const variableId = summary.actions.find((a) => a.kind === 'variable').id;
	const sent = calls.find((c) => c.name === 'createCard' && c.args.body.definition.title === 'Sales by East').args.body.definition;
	assert.deepEqual(sent.dynamicTitle.text[1], { type: 'VARIABLE_VALUE', variables: [variableId], defaultText: 'East' });
	assert.deepEqual(sent.controls.map((x) => x.function.id), [variableId], 'the card re-renders when the variable changes');
	assert.equal(summary.actions.find((a) => a.key === card.key).notes.some((n) => /Domo shows the title/.test(n)), false, 'spacing differences are not a title change');

	const again = stub();
	const second = await pushPlan({ config, slug: 'sales', deps: again.deps });
	assert.equal(second.actions.find((a) => a.key === card.key).action, 'unchanged');
});
