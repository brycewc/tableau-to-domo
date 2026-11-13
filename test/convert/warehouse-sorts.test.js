import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedAt, snowflakeBackreferences, warehouseBackreferences, warehouseSafeSorts } from '../../src/convert/warehouse-sorts.js';
import { naturalOrderKey } from '../../src/convert/cards.js';
import { ref } from '../../src/util/refs.js';

const card = (datasetKey, formulas) => ({
	key: 'c',
	title: 'By Region',
	worksheet: 'By Region',
	datasetKey,
	body: {
		dataProvider: { dataSourceId: ref('dataset', datasetKey) },
		definition: {
			formulas: { card: formulas },
			subscriptions: { main: { orderBy: formulas.map((f) => ({ column: f.id, formulaId: f.id, order: 'DESCENDING' })) } }
		}
	}
});
const plain = { id: 'calculation_card_1', name: 'Region (total order)', formula: 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Region`, `State`)' };
const swapped = { id: 'calculation_card_2', name: 'Dim (total order)', formula: "SUM(SUM(`Sales`)) OVER (PARTITION BY (CASE DOMO_BEAST_MODE(calculation_x) WHEN 'a' THEN `A` END))" };

test('a total-order sort on a warehouse dataset becomes a FIXED total, or is dropped when it partitions by an expression', () => {
	const plan = { datasets: [{ key: 'wh', strategy: 'cloud-amplifier' }], dataflows: [], cards: [card('wh', [{ ...plain }, { ...swapped }])] };
	const issues = warehouseSafeSorts(plan);
	const def = plan.cards[0].body.definition;
	assert.deepEqual(def.formulas.card.map((f) => f.formula), ['MAX(SUM(`Sales`) FIXED (BY `Region`, `State`))']);
	assert.deepEqual(def.subscriptions.main.orderBy.map((o) => o.formulaId), ['calculation_card_1']);
	assert.equal(issues[0].severity, 'warning');
});

test('cards on Domo-stored datasets keep their window sorts', () => {
	const plan = { datasets: [{ key: 'up', strategy: 'upload' }], dataflows: [], cards: [card('up', [{ ...swapped }])] };
	assert.deepEqual(warehouseSafeSorts(plan), []);
	assert.equal(plan.cards[0].body.definition.formulas.card.length, 1);
});

test('a total-order key over a compound measure takes FIXED after each aggregate call', () => {
	const caseMeasure = "CASE WHEN DOMO_BEAST_MODE(82) = 'ARR' THEN SUM(`ENDING_ARR` - `OPENING_ARR`) ELSE SUM(`ENDING_LCS` - `OPENING_LCS`) END";
	const formulas = [
		{ id: 'calculation_card_1', name: 'AccountID (total order)', formula: `SUM((${caseMeasure})) OVER (PARTITION BY \`AccountID\`)` },
		{ id: 'calculation_card_2', name: 'Period (total order)', formula: 'SUM((SUM(`ENDING_ARR`) - SUM(`OPENING_ARR`))) OVER (PARTITION BY `AccountID`)' }
	];
	const plan = { datasets: [{ key: 'wh', strategy: 'cloud-amplifier' }], dataflows: [], cards: [card('wh', formulas)] };
	const issues = warehouseSafeSorts(plan);
	const by = ' FIXED (BY `AccountID`)';
	assert.deepEqual(plan.cards[0].body.definition.formulas.card.map((f) => f.formula), [
		`MAX((CASE WHEN DOMO_BEAST_MODE(82) = 'ARR' THEN SUM(\`ENDING_ARR\` - \`OPENING_ARR\`)${by} ELSE SUM(\`ENDING_LCS\` - \`OPENING_LCS\`)${by} END))`,
		`MAX((SUM(\`ENDING_ARR\`)${by} - SUM(\`OPENING_ARR\`)${by}))`
	]);
	assert.equal(issues[0].severity, 'info');
});

test('a compound measure never yields FIXED after a parenthesis, and one FIXED cannot express is left out', () => {
	const levels = ['`Region`'];
	const measures = [
		'(SUM(`a`) - SUM(`b`))',
		"CASE WHEN `c` IS NULL THEN 0 ELSE SUM(`a`) END",
		'SUM(`a`) / NULLIF(COUNT(DISTINCT `b`), 0)',
		"CASE WHEN DOMO_BEAST_MODE(7) = 'x' THEN AVG(`a`) ELSE MAX(`b`) END",
		'SUM(SUM(`a`))',
		'SUM(`a`) OVER (PARTITION BY `b`)',
		'SUM(`a`) FIXED (BY `b`)',
		'`aggregated beast mode`',
		'MEDIAN(`a`)',
		'1'
	];
	for (const m of measures) {
		const out = fixedAt(m, levels);
		if (out === undefined) continue;
		for (const fixed of out.matchAll(/FIXED/g)) assert.match(out.slice(0, fixed.index), /\b(SUM|AVG|MIN|MAX|COUNT)\((?:[^()]|\([^()]*\))*\) $/, `${m}: FIXED follows an aggregate call`);
	}
	assert.deepEqual(measures.map((m) => fixedAt(m, levels) !== undefined), [true, false, true, true, false, false, false, false, false, false]);
	const plan = { datasets: [{ key: 'wh', strategy: 'cloud-amplifier' }], dataflows: [], cards: [card('wh', [{ id: 'calculation_card_1', name: 'Region (total order)', formula: 'SUM(SUM(SUM(`a`))) OVER (PARTITION BY `Region`)' }])] };
	assert.equal(warehouseSafeSorts(plan)[0].severity, 'warning');
	assert.deepEqual(plan.cards[0].body.definition.formulas.card, []);
	assert.deepEqual(plan.cards[0].body.definition.subscriptions.main.orderBy, []);
});

test('REGEXP_REPLACE backreferences on warehouse datasets use the Snowflake form', () => {
	const key = naturalOrderKey('`FYQ`');
	assert.equal(snowflakeBackreferences(key), "MIN(REGEXP_REPLACE(REGEXP_REPLACE(`FYQ`, '([0-9]+)', '0000000000\\1'), '0*([0-9]{10})', '\\1'))");
	assert.equal(snowflakeBackreferences("REGEXP_REPLACE(`s`, '(a)(b)', '$2$1') = 'it''s $1'"), "REGEXP_REPLACE(`s`, '(a)(b)', '\\2\\1') = 'it''s $1'");
	assert.equal(snowflakeBackreferences("REGEXP_REPLACE(`s`, '^ +', '')"), "REGEXP_REPLACE(`s`, '^ +', '')");
	const plan = {
		datasets: [{ key: 'wh', strategy: 'cloud-amplifier' }, { key: 'up', strategy: 'upload' }],
		dataflows: [],
		beastModes: [{ datasetKey: 'wh', expression: "REGEXP_REPLACE(`s`, 'x', '$0_')" }, { datasetKey: 'up', expression: "REGEXP_REPLACE(`s`, 'x', '$0_')" }],
		cards: [card('wh', [{ id: 'calculation_card_1', name: 'FYQ (natural order)', formula: key }]), card('up', [{ id: 'calculation_card_1', name: 'FYQ (natural order)', formula: key }])]
	};
	warehouseBackreferences(plan);
	assert.deepEqual(plan.beastModes.map((b) => b.expression), ["REGEXP_REPLACE(`s`, '(x)', '\\1_')", "REGEXP_REPLACE(`s`, 'x', '$0_')"]);
	assert.deepEqual(plan.cards.map((c) => c.body.definition.formulas.card[0].formula), [snowflakeBackreferences(key), key]);
});
