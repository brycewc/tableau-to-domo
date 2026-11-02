import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedRowCalcs } from '../../src/convert/inline-size.js';
import { parseFormula, translateCalc } from '../../src/convert/calc/index.js';

const fields = [
	{ id: '[Region]', name: 'Region', datatype: 'string', kind: 'column' },
	{ id: '[H]', name: 'H', datatype: 'string', kind: 'calculated', formula: `[Region] + "${'x'.repeat(100)}"` },
	{ id: '[A]', name: 'A', datatype: 'string', kind: 'calculated', formula: '[H] + [H]' },
	{ id: '[B]', name: 'B', datatype: 'string', kind: 'calculated', formula: '[A] + [H]' },
	{ id: '[Top]', name: 'Top', datatype: 'integer', kind: 'calculated', formula: 'COUNTD([A] + [B])' }
];
const byId = new Map(fields.map((f) => [f.id, f]));
const input = (extra = {}) => ({
	roots: [byId.get('[Top]')],
	astOf: (f) => parseFormula(f.formula),
	calcField: (id) => (byId.get(id)?.kind === 'calculated' ? byId.get(id) : undefined),
	lookupField: (id) => byId.get(id),
	findParameter: () => undefined,
	fieldMap: { '[Region]': 'Region' },
	...extra
});
const inlined = (id) =>
	translateCalc(byId.get(id).formula, {
		resolveField: (ref) => {
			const f = byId.get(ref);
			return f.kind === 'column' ? { kind: 'column', column: f.name, datatype: f.datatype } : { kind: 'calc', field: f };
		}
	}).expression.length;

test('sizes are estimated from one translation per calc and track the inlined length', () => {
	const { sizes, uses, chosen } = sharedRowCalcs(input({ minShared: Infinity, maxInline: Infinity }));
	assert.deepEqual(chosen, []);
	for (const id of ['[H]', '[A]', '[B]', '[Top]']) {
		assert.ok(Math.abs(sizes.get(id) - inlined(id)) <= 0.1 * inlined(id), `${id}: ${sizes.get(id)} vs ${inlined(id)}`);
	}
	assert.deepEqual(Object.fromEntries(uses), { '[H]': 3, '[A]': 2, '[B]': 1 });
});

test('a reused calc over the shared size is chosen bottom-up; its users then count it as a column', () => {
	const { chosen, sizes } = sharedRowCalcs(input({ minShared: 100 }));
	assert.deepEqual(chosen.map((f) => f.name), ['H']);
	assert.ok(sizes.get('[A]') < 100);
});

test('aggregate calcs, blocked calcs and calcs already computed as columns are not chosen', () => {
	assert.deepEqual(sharedRowCalcs(input({ minShared: 0, maxInline: 0 })).chosen.map((f) => f.name), ['H', 'A', 'B']);
	assert.deepEqual(sharedRowCalcs(input({ minShared: 0, isBlocked: (f) => f.name === 'H' })).chosen.map((f) => f.name), []);
	assert.deepEqual(sharedRowCalcs(input({ minShared: 0, isColumn: (f) => f.name === 'H' })).chosen.map((f) => f.name), ['A']);
});

test('a calc using TODAY() or NOW() stays a beast mode: a Magic ETL column would freeze it at the last run', () => {
	const today = [
		{ id: '[D]', name: 'D', datatype: 'string', kind: 'calculated', formula: `IF TODAY() > #2020-01-01# THEN [Region] + "${'x'.repeat(100)}" END` },
		{ id: '[U]', name: 'U', datatype: 'string', kind: 'calculated', formula: '[D] + [D]' }
	];
	const all = new Map([...byId, ...today.map((f) => [f.id, f])]);
	const { chosen } = sharedRowCalcs(input({ roots: [all.get('[U]')], minShared: 0, calcField: (id) => (all.get(id)?.kind === 'calculated' ? all.get(id) : undefined), lookupField: (id) => all.get(id) }));
	assert.deepEqual(chosen, []);
});

test('a boolean calc read through a reference is sized as its predicate, not as LOWER(column) = true', () => {
	const bools = [
		{ id: '[Flag]', name: 'Flag', datatype: 'boolean', kind: 'calculated', formula: `[Region] = "${'x'.repeat(50)}"` },
		{ id: '[Use]', name: 'Use', datatype: 'string', kind: 'calculated', formula: 'IF [Flag] THEN [Region] END' }
	];
	const all = new Map([...byId, ...bools.map((f) => [f.id, f])]);
	const lookup = { calcField: (id) => (all.get(id)?.kind === 'calculated' ? all.get(id) : undefined), lookupField: (id) => all.get(id) };
	const { sizes } = sharedRowCalcs(input({ roots: [all.get('[Use]')], minShared: Infinity, maxInline: Infinity, ...lookup }));
	const real = translateCalc(all.get('[Use]').formula, {
		resolveField: (ref) => {
			const f = all.get(ref);
			return f.kind === 'column' ? { kind: 'column', column: f.name, datatype: f.datatype } : { kind: 'calc', field: f };
		}
	}).expression.length;
	assert.ok(Math.abs(sizes.get('[Use]') - real) <= 4, `${sizes.get('[Use]')} vs ${real}`);
});
