import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { magicToSql, parseExpr, parseQuery, sqlToMagic } from '../../src/magic/index.js';

// The corpus is local work data: T2D_MAGIC_CORPUS names a workspace datasources directory and tmp/magic/corpus/targets.json
// maps labels to datasource ids. These tests skip without them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(root, 'tmp/magic/corpus');
const DATASOURCES = process.env.T2D_MAGIC_CORPUS ? path.resolve(root, process.env.T2D_MAGIC_CORPUS) : '';
const SCHEMAS = path.join(CORPUS, 'schemas.json');
const TARGETS_FILE = path.join(CORPUS, 'targets.json');
const TARGETS = fs.existsSync(TARGETS_FILE) ? JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')) : {};
const COMPUTE = { type: 'adr', cloudId: 'corpus-cloud' };

function load(id) {
	const file = DATASOURCES && path.join(DATASOURCES, id, 'definition.json');
	if (!file || !fs.existsSync(file)) return null;
	const ds = JSON.parse(fs.readFileSync(file, 'utf8')).datasource;
	const initial = ds.connections.map((c) => c.extra?.['one-time-sql']).filter(Boolean).join(';\n');
	const outputs = ds.tables.filter((t) => t.kind === 'custom-sql').map((t) => ({ name: t.name, sql: t.sql }));
	return { initial, outputs };
}

const schemas = fs.existsSync(SCHEMAS) ? JSON.parse(fs.readFileSync(SCHEMAS, 'utf8')) : null;

function consistent(r) {
	const ids = new Set(r.actions.map((a) => a.id));
	assert.equal(ids.size, r.actions.length, 'action ids are unique');
	for (const a of r.actions) {
		for (const d of a.dependsOn ?? []) assert.ok(ids.has(d), `${a.id} depends on missing ${d}`);
		assert.equal(new Set(a.dependsOn ?? []).size, (a.dependsOn ?? []).length, `${a.id} reads one action twice`);
		if (a.type === 'MergeJoin') assert.notEqual(a.step1, a.step2, `${a.id} joins an action to itself`);
		for (const e of a.expressions ?? []) assert.doesNotThrow(() => parseExpr(e.expression, { formula: true }), `${a.id}: ${e.expression}`);
		for (const f of a.filterList ?? []) assert.doesNotThrow(() => parseExpr(f.expression, { formula: true }), `${a.id}: ${f.expression}`);
		for (const f of a.type === 'GroupBy' ? a.fields : []) assert.doesNotThrow(() => parseExpr(f.expression, { formula: true }), `${a.id}: ${f.expression}`);
		for (const s of a.statements ?? []) assert.doesNotThrow(() => parseQuery(s), `${a.id}: ${s.slice(0, 200)}`);
		if (a.type === 'SQL') {
			const names = a.inputs.map((i) => r.actions.find((x) => x.id === i).name);
			for (const n of names) assert.ok(a.statements[0].includes(n), `${a.id} reads ${n} by name`);
		}
	}
	for (const stage of r.stages) {
		const stageIds = new Set(stage.definition.actions.map((a) => a.id));
		assert.equal(stageIds.size, stage.definition.actions.length);
		assert.ok(stage.definition.actions.length <= 100, `a stage has ${stage.definition.actions.length} actions`);
		for (const a of stage.definition.actions) for (const d of a.dependsOn ?? []) assert.ok(stageIds.has(d), `${a.id} reads ${d} outside its stage`);
	}
	const back = magicToSql(r.definition);
	assert.deepEqual(back.unsupported, [], 'every tile reads back as SQL');
	for (const o of back.outputs) assert.doesNotThrow(() => parseQuery(o.sql));
}

for (const [slug, id] of Object.entries(TARGETS)) {
	const corpus = load(id);
	test(`${slug}: Initial SQL translates with unknown warehouse schemas`, { skip: !corpus && 'corpus not present' }, () => {
		const r = sqlToMagic(corpus.initial, { outputs: corpus.outputs, inputs: (t) => ({ dataSourceId: `ds:${t.key}` }), compute: COMPUTE });
		assert.deepEqual(r.blockers, []);
		assert.ok(r.actions.length > 0);
		consistent(r);
	});
	test(`${slug}: Initial SQL translates with warehouse schemas`, { skip: (!corpus || !schemas) && 'corpus or schemas not present' }, () => {
		const r = sqlToMagic(corpus.initial, { outputs: corpus.outputs, inputs: (t) => ({ dataSourceId: `ds:${t.key}`, columns: schemas[t.key] }), compute: COMPUTE });
		if (slug === 'credits-dash-2025') {
			// The script reads SHF_SALESTERRITORYMAP_2025.SE_REP_9, which the warehouse table no longer has.
			assert.match(r.blocked.reason, /SE_REP_9/);
			return;
		}
		assert.deepEqual(r.blockers, []);
		consistent(r);
		assert.ok(r.stats.sqlTiles <= r.stats.tiles / 5, `mostly tiles: ${JSON.stringify(r.stats)}`);
	});
}
