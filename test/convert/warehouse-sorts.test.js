import test from 'node:test';
import assert from 'node:assert/strict';
import { warehouseSafeSorts } from '../../src/convert/warehouse-sorts.js';
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
