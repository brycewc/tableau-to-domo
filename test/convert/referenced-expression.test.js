import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards } from '../../src/convert/cards.js';
import { REFERENCED_EXPRESSION_CHARS, aggregateFilterField, bindingExpression, inlineBeastModeReferences } from '../../src/convert/filters.js';
import { DATASET, cat, makeBindings, p, sheet, workbook } from './cards.fixtures.test.js';

const LONG = `CASE ${Array.from({ length: 300 }, (_, i) => `WHEN \`Region\` = 'r${i}' THEN \`Order Date\``).join(' ')} END`;
const dateCalc = (expression) => ({ datasetKey: DATASET, kind: 'formula', name: 'Order Date', formulaId: 'calculation_sel', expression, aggregated: false, dataType: 'DATE', tableauType: 'date' });

test('a long calc expression is referenced as its dataset beast mode, a short one is inlined', () => {
	assert.ok(LONG.length >= REFERENCED_EXPRESSION_CHARS);
	assert.equal(bindingExpression(dateCalc(LONG)), 'DOMO_BEAST_MODE(calculation_sel)');
	assert.equal(bindingExpression(dateCalc(LONG), { inline: true }), `(${LONG})`);
	assert.equal(bindingExpression(dateCalc('`Order Date`')), '(`Order Date`)');
	assert.equal(bindingExpression({ ...dateCalc(LONG), formulaId: undefined }), `(${LONG})`);
});

test('a date part of a long calc reads its beast mode instead of inlining it', () => {
	const ws = sheet({ rows: p('yr', 'Order Date', 'ok'), cols: p('sum', 'Sales', 'qk') });
	const { cards } = planCards(workbook({ worksheets: [ws] }), makeBindings({ '[Order Date]': dateCalc(LONG) }), { options: {} });
	const formulas = cards[0].body.definition.formulas.card;
	assert.ok(formulas.some((f) => f.formula === 'YEAR(DOMO_BEAST_MODE(calculation_sel))'), JSON.stringify(formulas.map((f) => f.formula)));
	assert.ok(formulas.every((f) => !f.formula.includes(LONG)));

	const short = planCards(workbook({ worksheets: [ws] }), makeBindings({ '[Order Date]': dateCalc("DATE_ADD(`Order Date`, INTERVAL 1 DAY)") }), { options: {} });
	assert.ok(short.cards[0].body.definition.formulas.card.some((f) => f.formula === 'YEAR((DATE_ADD(`Order Date`, INTERVAL 1 DAY)))'));
});

test('the natural sort order of a long text calc reads its beast mode', () => {
	const long = `CASE ${Array.from({ length: 300 }, (_, i) => `WHEN \`Region\` = 'r${i}' THEN 'x${i}'`).join(' ')} END`;
	const binding = { datasetKey: DATASET, kind: 'formula', name: 'Is Big', formulaId: 'calculation_big', expression: long, aggregated: false, dataType: 'STRING', tableauType: 'string' };
	const ws = sheet({ rows: p('none', 'Is Big'), cols: p('sum', 'Sales', 'qk'), filters: [cat('Is Big', ['x1'])] });
	const { cards } = planCards(workbook({ worksheets: [ws] }), makeBindings({ '[Is Big]': binding }), { options: {} });
	const formulas = cards[0].body.definition.formulas.card;
	assert.ok(formulas.some((f) => f.formula.includes('DOMO_BEAST_MODE(calculation_big)')), JSON.stringify(formulas));
	assert.ok(!JSON.stringify(cards[0].body).includes(long.slice(0, 200)), 'the expression is not inlined anywhere on the card');
});

test('an aggregate filter beast mode inlines the expression, since push does not point one beast mode at another', () => {
	const binding = { datasetKey: DATASET, kind: 'formula', name: 'Late', formulaId: 'calculation_late', expression: LONG, aggregated: false, dataType: 'LONG', tableauType: 'integer' };
	const target = aggregateFilterField({ pillId: p('sum', 'Late', 'qk'), fieldId: '[Late]', kind: 'quantitative' }, binding);
	assert.equal(target.expression, `SUM((${LONG}))`);
});

test('inlineBeastModeReferences inlines the beast modes it knows and keeps variable references', () => {
	const known = new Map([['calculation_a', { expression: '`x` + 1' }]]);
	assert.equal(inlineBeastModeReferences('DOMO_BEAST_MODE(calculation_a) > DOMO_BEAST_MODE(calculation_var)', known), '(`x` + 1) > DOMO_BEAST_MODE(calculation_var)');
});
