import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { translateCalc, translateRowExpression } from '../../src/convert/calc/index.js';
import { tableCalcAddressing, quickTableCalcSql } from '../../src/convert/calc/tablecalc.js';
import { NO_EQUIVALENT } from '../../src/convert/calc/catalog.js';
import { baseCtx, codes, resolveField } from './helpers.js';

const win = (extra = {}) => baseCtx({ options: { useWindowFunctions: true }, ...extra });
const ordered = { orderBy: [{ column: 'Order Date', direction: 'ASC' }] };

describe('table calculations', () => {
	test('TOTAL uses FIXED () by default (filters still apply)', () => {
		const r = translateCalc('SUM([Sales]) / TOTAL(SUM([Sales]))', baseCtx());
		assert.equal(r.expression, 'SUM(`Sales`) / NULLIF(SUM(SUM(`Sales`) FIXED ()), 0)');
		assert.deepEqual(r.features, ['fixed']);
		assert.equal(r.status, 'approximate');
		assert.ok(codes(r).includes('calc.table-calc-addressing'));
	});

	test('TOTAL with partition addressing', () => {
		const r = translateCalc('TOTAL(SUM([Sales]))', baseCtx({ tableCalc: { partitionBy: ['Region'] } }));
		assert.equal(r.expression, 'SUM(SUM(`Sales`) FIXED (BY `Region`))');
		assert.equal(r.status, 'ok');
	});

	test('TOTAL of a ratio applies FIXED to each aggregate', () => {
		const r = translateCalc('TOTAL(SUM([Profit]) / SUM([Sales]))', baseCtx());
		assert.equal(r.expression, 'SUM(SUM(`Profit`) FIXED () / NULLIF(SUM(`Sales`) FIXED (), 0))');
	});

	test('TOTAL without FIXED or windows is unsupported', () => {
		const r = translateCalc('TOTAL(SUM([Sales]))', baseCtx({ options: { useFixed: false } }));
		assert.equal(r.status, 'unsupported');
		assert.deepEqual(codes(r), ['calc.table-calc']);
	});

	test('TOTAL with windows only', () => {
		const r = translateCalc('TOTAL(SUM([Sales]))', baseCtx({ options: { useFixed: false, useWindowFunctions: true } }));
		assert.equal(r.expression, 'SUM(SUM(`Sales`)) OVER ()');
		assert.deepEqual(r.features, ['window']);
	});

	test('table calcs without the window option are unsupported', () => {
		for (const f of ['RUNNING_SUM(SUM([Sales]))', 'RANK(SUM([Sales]))', 'INDEX()', 'LOOKUP(SUM([Sales]), -1)', 'WINDOW_AVG(SUM([Sales]))']) {
			const r = translateCalc(f, baseCtx());
			assert.equal(r.status, 'unsupported', f);
			assert.ok(codes(r).includes('calc.table-calc'), f);
		}
	});

	test('RUNNING_SUM with addressing', () => {
		const r = translateCalc('RUNNING_SUM(SUM([Sales]))', win({ tableCalc: { partitionBy: ['Region'], ...ordered } }));
		assert.equal(r.expression, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Region` ORDER BY `Order Date` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
		assert.equal(r.status, 'ok');
		assert.equal(r.aggregated, true);
		assert.deepEqual(r.features, ['window']);
	});

	test('RUNNING_AVG without an order is unsupported and has no frame, which Domo cannot parse without ORDER BY', () => {
		const r = translateCalc('RUNNING_AVG(SUM([Sales]))', win());
		assert.equal(r.expression, 'AVG(SUM(`Sales`)) OVER ()');
		assert.equal(r.status, 'unsupported');
		assert.equal(r.issues.find((i) => i.code === 'calc.table-calc-order').severity, 'error');
	});

	test('a WINDOW_* frame is dropped without an order: an error for a sliding frame, nothing for the whole partition', () => {
		const sliding = translateCalc('WINDOW_SUM(SUM([Sales]), -2, 0)', win({ tableCalc: {} }));
		assert.equal(sliding.expression, 'SUM(SUM(`Sales`)) OVER ()');
		assert.equal(sliding.status, 'unsupported');
		const whole = translateCalc('WINDOW_SUM(SUM([Sales]), FIRST(), LAST())', win({ tableCalc: { partitionBy: ['Region'] } }));
		assert.equal(whole.expression, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Region`)');
		assert.equal(whole.status, 'ok');
		const lookup = translateCalc('LOOKUP(SUM([Sales]), FIRST())', win({ tableCalc: {} }));
		assert.equal(lookup.expression, 'FIRST_VALUE(SUM(`Sales`)) OVER ()');
	});

	test('RUNNING_COUNT, RUNNING_MIN, RUNNING_MAX', () => {
		const ctx = win({ tableCalc: ordered });
		assert.match(translateCalc('RUNNING_COUNT(SUM([Sales]))', ctx).expression, /^COUNT\(SUM\(`Sales`\)\) OVER/);
		assert.match(translateCalc('RUNNING_MIN(SUM([Sales]))', ctx).expression, /^MIN\(SUM\(`Sales`\)\) OVER/);
		assert.match(translateCalc('RUNNING_MAX(SUM([Sales]))', ctx).expression, /^MAX\(SUM\(`Sales`\)\) OVER/);
	});

	test('WINDOW_SUM over the partition', () => {
		assert.equal(translateCalc('WINDOW_SUM(SUM([Sales]))', win({ tableCalc: { partitionBy: ['Region'] } })).expression, 'SUM(SUM(`Sales`)) OVER (PARTITION BY `Region`)');
	});

	test('WINDOW_AVG with offsets (moving average)', () => {
		assert.equal(
			translateCalc('WINDOW_AVG(SUM([Sales]), -2, 0)', win({ tableCalc: { orderBy: ['Order Date'] } })).expression,
			'AVG(SUM(`Sales`)) OVER (ORDER BY `Order Date` ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)'
		);
		assert.equal(
			translateCalc('WINDOW_MIN(SUM([Sales]), 1, 3)', win({ tableCalc: { orderBy: ['Order Date'] } })).expression,
			'MIN(SUM(`Sales`)) OVER (ORDER BY `Order Date` ROWS BETWEEN 1 FOLLOWING AND 3 FOLLOWING)'
		);
	});

	test('WINDOW_MAX with FIRST() and LAST() is the whole partition, with no frame', () => {
		assert.equal(translateCalc('WINDOW_MAX(SUM([Sales]), FIRST(), LAST())', win({ tableCalc: { orderBy: ['Order Date'] } })).expression, 'MAX(SUM(`Sales`)) OVER ()');
	});

	test('a bound relative to FIRST() is approximated as unbounded', () => {
		const r = translateCalc('WINDOW_SUM(SUM([Sales]), FIRST() + 1, 0)', win({ tableCalc: ordered }));
		assert.equal(r.expression, 'SUM(SUM(`Sales`)) OVER (ORDER BY `Order Date` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
		assert.equal(r.status, 'approximate');
		assert.ok(codes(r).includes('calc.table-calc-frame'));
	});

	test('non-literal window offsets are unsupported', () => {
		const r = translateCalc('WINDOW_SUM(SUM([Sales]), -[Quantity], 0)', win({ tableCalc: ordered }));
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.table-calc-frame'));
	});

	test('variance and deviation use the functions Domo runs as analytics (VAR is rejected at query time)', () => {
		const ctx = win({ tableCalc: {} });
		assert.equal(translateCalc('WINDOW_STDEV(SUM([Sales]))', ctx).expression, 'STDDEV_SAMP(SUM(`Sales`)) OVER ()');
		assert.equal(translateCalc('WINDOW_STDEVP(SUM([Sales]))', ctx).expression, 'STDDEV_POP(SUM(`Sales`)) OVER ()');
		assert.equal(translateCalc('WINDOW_VAR(SUM([Sales]))', ctx).expression, 'VAR_SAMP(SUM(`Sales`)) OVER ()');
		assert.equal(translateCalc('WINDOW_VARP(SUM([Sales]))', ctx).expression, 'VAR_POP(SUM(`Sales`)) OVER ()');
		assert.equal(translateCalc('WINDOW_COUNT(SUM([Sales]))', ctx).dataType, 'LONG');
	});

	test('WINDOW_MEDIAN runs over a whole partition only', () => {
		const ctx = win({ tableCalc: { partitionBy: ['Region'], ...ordered } });
		assert.equal(translateCalc('WINDOW_MEDIAN(SUM([Sales]))', ctx).expression, 'MEDIAN(SUM(`Sales`)) OVER (PARTITION BY `Region`)');
		assert.equal(translateCalc('WINDOW_MEDIAN(SUM([Sales]), FIRST(), LAST())', ctx).status, 'ok');
		const sliding = translateCalc('WINDOW_MEDIAN(SUM([Sales]), -2, 0)', ctx);
		assert.equal(sliding.status, 'unsupported');
		assert.ok(codes(sliding).includes('calc.table-calc-frame'));
	});

	test('WINDOW_CORR from windowed sums over rows where both values exist', () => {
		const r = translateCalc('WINDOW_CORR(SUM([Sales]), SUM([Profit]))', win({ tableCalc: { partitionBy: ['Region'] } }));
		const w = 'OVER (PARTITION BY `Region`)';
		const xs = 'CASE WHEN SUM(`Profit`) IS NOT NULL THEN SUM(`Sales`) END';
		const ys = 'CASE WHEN SUM(`Sales`) IS NOT NULL THEN SUM(`Profit`) END';
		const n = `COUNT(SUM(\`Sales\`) * SUM(\`Profit\`)) ${w}`;
		assert.equal(
			r.expression,
			`(SUM(SUM(\`Sales\`) * SUM(\`Profit\`)) ${w} - SUM(${xs}) ${w} * SUM(${ys}) ${w} / NULLIF(${n}, 0)) / NULLIF(${n} - 1, 0) / NULLIF(STDDEV_SAMP(${xs}) ${w} * STDDEV_SAMP(${ys}) ${w}, 0)`
		);
		assert.equal(r.status, 'ok');
		assert.equal(r.dataType, 'DOUBLE');
	});

	describe('functions the catalog lists as having no equivalent', () => {
		const blocked = ['WINDOW_PERCENTILE', 'WINDOW_COVAR', 'WINDOW_COVARP'].filter((n) => NO_EQUIVALENT.has(n));
		before(() => blocked.forEach((n) => NO_EQUIVALENT.delete(n)));
		after(() => blocked.forEach((n) => NO_EQUIVALENT.add(n)));

		test('WINDOW_COVAR and WINDOW_COVARP', () => {
			const ctx = win({ tableCalc: ordered });
			const covar = translateCalc('WINDOW_COVAR(SUM([Sales]), SUM([Profit]), -2, 0)', ctx);
			assert.match(covar.expression, /^\(SUM\(SUM\(`Sales`\) \* SUM\(`Profit`\)\) OVER \(ORDER BY `Order Date` ASC ROWS BETWEEN 2 PRECEDING AND CURRENT ROW\) - /);
			assert.match(covar.expression, / - 1, 0\)$/);
			assert.equal(covar.status, 'ok');
			const covarp = translateCalc('WINDOW_COVARP(SUM([Sales]), SUM([Profit]))', ctx);
			assert.match(covarp.expression, /\) \/ NULLIF\(COUNT\(SUM\(`Sales`\) \* SUM\(`Profit`\)\) OVER \(\), 0\)$/);
		});

		test('WINDOW_PERCENTILE over a whole partition', () => {
			const ctx = win({ tableCalc: { partitionBy: ['Region'], ...ordered } });
			assert.equal(translateCalc('WINDOW_PERCENTILE(SUM([Sales]), 0.75)', ctx).expression, 'PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY SUM(`Sales`)) OVER (PARTITION BY `Region`)');
			assert.equal(translateCalc('WINDOW_PERCENTILE(SUM([Sales]), 0.5, -2, 0)', ctx).status, 'unsupported');
			assert.equal(translateCalc('WINDOW_PERCENTILE(SUM([Sales]), 75)', ctx).status, 'unsupported');
		});
	});

	test('RANK family', () => {
		const ctx = win({ tableCalc: { partitionBy: ['Region'] } });
		assert.equal(translateCalc('RANK(SUM([Sales]))', ctx).expression, 'RANK() OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) DESC)');
		assert.equal(translateCalc("RANK_DENSE(SUM([Sales]), 'asc')", ctx).expression, 'DENSE_RANK() OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) ASC)');
		assert.equal(translateCalc('RANK_UNIQUE(SUM([Sales]))', ctx).expression, 'ROW_NUMBER() OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) DESC)');
		assert.equal(
			translateCalc('RANK_MODIFIED(SUM([Sales]))', ctx).expression,
			'COUNT(SUM(`Sales`)) OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) DESC RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
		);
	});

	test('RANK_PERCENTILE is (modified ascending rank - 1) / (n - 1), so (6, 9, 9, 14) gives (0, 0.67, 0.67, 1)', () => {
		const r = translateCalc('RANK_PERCENTILE(SUM([Sales]))', win({ tableCalc: { partitionBy: ['Region'] } }));
		assert.equal(
			r.expression,
			'(COUNT(SUM(`Sales`)) OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) ASC RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - 1) / NULLIF(COUNT(SUM(`Sales`)) OVER (PARTITION BY `Region`) - 1, 0)'
		);
		assert.equal(r.dataType, 'DOUBLE');
		assert.match(translateCalc("RANK_PERCENTILE(SUM([Sales]), 'desc')", win({ tableCalc: {} })).expression, /ORDER BY SUM\(`Sales`\) DESC RANGE/);
	});

	test('INDEX, FIRST, LAST, SIZE', () => {
		const ctx = win({ tableCalc: { orderBy: ['Order Date'] } });
		assert.equal(translateCalc('INDEX()', ctx).expression, 'ROW_NUMBER() OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('FIRST()', ctx).expression, '1 - ROW_NUMBER() OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('LAST()', ctx).expression, 'COUNT(*) OVER () - ROW_NUMBER() OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('SIZE()', ctx).expression, 'COUNT(*) OVER ()');
		assert.equal(translateCalc('INDEX() * 2', ctx).expression, 'ROW_NUMBER() OVER (ORDER BY `Order Date`) * 2');
		assert.equal(translateCalc('FIRST() * 2', ctx).expression, '(1 - ROW_NUMBER() OVER (ORDER BY `Order Date`)) * 2');
	});

	test('INDEX without an order is approximate', () => {
		const r = translateCalc('INDEX()', win({ tableCalc: {} }));
		assert.equal(r.status, 'approximate');
		assert.ok(codes(r).includes('calc.table-calc-order'));
	});

	test('LOOKUP to LAG / LEAD / FIRST_VALUE / LAST_VALUE', () => {
		const ctx = win({ tableCalc: { orderBy: ['Order Date'] } });
		assert.equal(translateCalc('LOOKUP(SUM([Sales]), -1)', ctx).expression, 'LAG(SUM(`Sales`), 1) OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('LOOKUP(SUM([Sales]), 2)', ctx).expression, 'LEAD(SUM(`Sales`), 2) OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('LOOKUP(SUM([Sales]), 0)', ctx).expression, 'SUM(`Sales`)');
		assert.equal(
			translateCalc('LOOKUP(SUM([Sales]), FIRST())', ctx).expression,
			'FIRST_VALUE(SUM(`Sales`)) OVER (ORDER BY `Order Date` ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)'
		);
		assert.equal(
			translateCalc('LOOKUP(SUM([Sales]), LAST())', ctx).expression,
			'LAST_VALUE(SUM(`Sales`)) OVER (ORDER BY `Order Date` ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)'
		);
	});

	test('LOOKUP offset must be a literal', () => {
		const r = translateCalc('LOOKUP(SUM([Sales]), [Quantity])', win({ tableCalc: {} }));
		assert.equal(r.status, 'unsupported');
	});

	test('constant LOOKUP offsets and window bounds fold, inlined parameters included', () => {
		const ctx = win({ tableCalc: { orderBy: ['Order Date'] } });
		const byGrain = "LOOKUP(SUM([Sales]), IF [Parameters].[Grain] = 'quarter' THEN -4 ELSEIF [Parameters].[Grain] = 'month' THEN -12 END)";
		assert.equal(translateCalc(byGrain, ctx).expression, 'LAG(SUM(`Sales`), 12) OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('LOOKUP(SUM([Sales]), -[Parameters].[Top N] + 1)', ctx).expression, 'LAG(SUM(`Sales`), 9) OVER (ORDER BY `Order Date`)');
		assert.equal(translateCalc('WINDOW_SUM(SUM([Sales]), 1 - 3, 0)', ctx).expression, 'SUM(SUM(`Sales`)) OVER (ORDER BY `Order Date` ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)');
	});

	describe('LOOKUP offset choosing between integer constants, with parameters as variables', () => {
		const ctx = (extra = {}) => win({ tableCalc: { orderBy: ['Order Date'] }, options: { useWindowFunctions: true, parameters: 'variables' }, ...extra });
		const lag = (n) => `LAG(SUM(\`Sales\`), ${n}) OVER (ORDER BY \`Order Date\`)`;

		test('IF over a parameter is distributed over the branches', () => {
			const r = translateCalc("LOOKUP(SUM([Sales]), IF [Parameters].[Grain] = 'quarter' THEN -4 ELSE -1 END)", ctx());
			assert.equal(r.status, 'ok');
			assert.equal(r.expression, `CASE WHEN \`Grain\` = 'quarter' THEN ${lag(4)} ELSE ${lag(1)} END`);
		});

		test('assumed: an ELSEIF chain without ELSE is null when nothing matches, like a null Tableau offset; offset 0 is the value', () => {
			const r = translateCalc("LOOKUP(SUM([Sales]), IF [Parameters].[Grain] = 'quarter' THEN -4 ELSEIF [Parameters].[Grain] = 'month' THEN 0 END)", ctx());
			assert.equal(r.expression, `CASE WHEN \`Grain\` = 'quarter' THEN ${lag(4)} WHEN \`Grain\` = 'month' THEN SUM(\`Sales\`) END`);
		});

		test('CASE and IIF offsets', () => {
			assert.equal(translateCalc("LOOKUP(SUM([Sales]), CASE [Parameters].[Grain] WHEN 'quarter' THEN -4 ELSE -1 END)", ctx()).expression, `CASE \`Grain\` WHEN 'quarter' THEN ${lag(4)} ELSE ${lag(1)} END`);
			assert.equal(
				translateCalc("LOOKUP(SUM([Sales]), IIF([Parameters].[Grain] = 'quarter', -4, 2))", ctx()).expression,
				`CASE WHEN \`Grain\` = 'quarter' THEN ${lag(4)} WHEN \`Grain\` != 'quarter' THEN LEAD(SUM(\`Sales\`), 2) OVER (ORDER BY \`Order Date\`) END`
			);
		});

		test('an offset from a row-free calc is distributed', () => {
			const offset = { id: '[Offset]', name: 'Offset', datatype: 'integer', kind: 'calculated', formula: 'IF [Parameters].[Grain] = "YoY" THEN -4 ELSE -1 END' };
			const r = translateCalc('LOOKUP(SUM([Sales]), [Offset])', ctx({ resolveField: (id) => (id === '[Offset]' ? { kind: 'calc', field: offset } : resolveField(id)) }));
			assert.equal(r.expression, `CASE WHEN \`Grain\` = 'YoY' THEN ${lag(4)} ELSE ${lag(1)} END`);
		});

		test('a row-level condition, a column branch or a non-integer branch stays unsupported', () => {
			for (const offset of ["IF [Region] = 'East' THEN -4 ELSE -1 END", "IF [Parameters].[Grain] = 'quarter' THEN -4 ELSE [Quantity] END", "IF [Parameters].[Grain] = 'quarter' THEN -4.5 ELSE -1 END"]) {
				const r = translateCalc(`LOOKUP(SUM([Sales]), ${offset})`, ctx());
				assert.equal(r.status, 'unsupported', offset);
				assert.ok(codes(r).includes('calc.table-calc'), offset);
			}
		});
	});

	test('LOOKUP at FIRST() + n needs NTH_VALUE, which Domo does not run', () => {
		const r = translateCalc('LOOKUP(SUM([Sales]), FIRST() + 2)', win({ tableCalc: ordered }));
		assert.equal(r.status, 'unsupported');
		assert.ok(r.issues.some((i) => /NTH_VALUE/.test(i.message)));
	});

	test('LOOKUP offset from an inlined parameter', () => {
		const r = translateCalc('LOOKUP(SUM([Sales]), -[Parameters].[Top N])', win({ tableCalc: { orderBy: ['Order Date'] } }));
		assert.equal(r.expression, 'LAG(SUM(`Sales`), 10) OVER (ORDER BY `Order Date`)');
	});

	test('percent difference quick calc', () => {
		const r = translateCalc('(SUM([Sales]) - LOOKUP(SUM([Sales]), -1)) / ABS(LOOKUP(SUM([Sales]), -1))', win({ tableCalc: { orderBy: ['Order Date'] } }));
		assert.equal(r.expression, '(SUM(`Sales`) - LAG(SUM(`Sales`), 1) OVER (ORDER BY `Order Date`)) / NULLIF(ABS(LAG(SUM(`Sales`), 1) OVER (ORDER BY `Order Date`)), 0)');
		assert.equal(r.aggregated, true);
	});

	test('a table calc over another table calc is unsupported (Domo rejects nested windows with INCOMPATIBLE_LINK)', () => {
		for (const f of ['RANK(RUNNING_SUM(SUM([Sales])))', 'RUNNING_SUM(LOOKUP(SUM([Sales]), -1))', 'WINDOW_AVG(SUM([Sales]) - LOOKUP(SUM([Sales]), -1))']) {
			const r = translateCalc(f, win({ tableCalc: ordered }));
			assert.equal(r.status, 'unsupported', f);
			assert.ok(codes(r).includes('calc.table-calc-nested'), f);
		}
	});

	test('the nested table calc error says a beast mode reference does not help', () => {
		const issue = translateCalc('RANK(RUNNING_SUM(SUM([Sales])))', win({ tableCalc: ordered })).issues.find((i) => i.code === 'calc.table-calc-nested');
		assert.match(issue.message, /^RANK of another table calculation/);
		assert.match(issue.message, /DOMO_BEAST_MODE\(<id>\) back into the same nested window/);
		assert.match(issue.suggestion, /Magic ETL Rank & Window/);
		assert.doesNotMatch(`${issue.message} ${issue.suggestion}`, new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
	});

	test('a table calc over a referenced table calc is still nested once inlined', () => {
		const calcs = {
			'[Running]': { id: '[Running]', name: 'Running', datatype: 'real', kind: 'calculated', formula: 'RUNNING_SUM(SUM([Sales]))' },
			'[Via]': { id: '[Via]', name: 'Via', datatype: 'real', kind: 'calculated', formula: '[Running] * 2' },
			'[Ratio]': { id: '[Ratio]', name: 'Ratio', datatype: 'real', kind: 'calculated', formula: 'SUM([Profit]) / SUM([Sales])' }
		};
		const resolve = (id) => (calcs[id] ? { kind: 'calc', field: calcs[id] } : resolveField(id));
		const ctx = win({ tableCalc: ordered, resolveField: resolve, options: { useWindowFunctions: true } });
		for (const f of ['RANK([Running])', 'WINDOW_AVG([Via])']) {
			const r = translateCalc(f, ctx);
			assert.equal(r.status, 'unsupported', f);
			assert.ok(codes(r).includes('calc.table-calc-nested'), f);
		}
		const plain = translateCalc('RUNNING_SUM([Ratio])', ctx);
		assert.equal(plain.status, 'ok');
		assert.equal(plain.expression, 'SUM((SUM(`Profit`) / NULLIF(SUM(`Sales`), 0))) OVER (ORDER BY `Order Date` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
	});

	test('a table calc combined with another one side by side is fine', () => {
		const r = translateCalc('RUNNING_SUM(SUM([Sales])) / TOTAL(SUM([Sales]))', win({ tableCalc: ordered }));
		assert.equal(r.status, 'ok');
	});

	test('addressing issues are reported on the calc', () => {
		const issue = { severity: 'warning', code: 'calc.table-calc-addressing', message: 'Manual sort on X cannot order a window' };
		const r = translateCalc('INDEX()', win({ tableCalc: { ...ordered, issues: [issue] } }));
		assert.equal(r.status, 'approximate');
		assert.ok(r.issues.some((i) => i.message === issue.message));
	});

	test('PREVIOUS_VALUE has no equivalent', () => {
		const r = translateCalc('PREVIOUS_VALUE(0) + 1', win());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.no-equivalent'));
	});

	test('Magic ETL formulas cannot hold table calcs', () => {
		const r = translateRowExpression('INDEX()', win());
		assert.equal(r.status, 'unsupported');
		assert.ok(codes(r).includes('calc.row-level-only'));
	});
});

describe('live workbook table calcs (usage ranking workbook)', () => {
	const fields = {
		'[REVENUE_PERIOD]': { kind: 'column', column: 'REVENUE_PERIOD', datatype: 'real' },
		'[AU measure]': { kind: 'column', column: 'AU measure', datatype: 'integer' },
		'[Calculation_261771754152816642]': {
			kind: 'calc',
			field: { id: '[Calculation_261771754152816642]', name: 'RankByRevenue', datatype: 'integer', kind: 'calculated', formula: 'RANK_DENSE(AVG([REVENUE_PERIOD]))' }
		},
		'[Parameters].[Parameter 5 2]': { kind: 'parameter', parameter: { id: '[Parameters].[Parameter 5 2]', name: 'Top N 2', datatype: 'integer', domain: 'list', value: 10 } }
	};
	const ctx = (extra = {}) => ({ resolveField: (id) => fields[id] ?? resolveField(id), options: { useWindowFunctions: true }, ...extra });

	test('RankByRevenue: RANK_DENSE(AVG([REVENUE_PERIOD]))', () => {
		const r = translateCalc('RANK_DENSE(AVG([REVENUE_PERIOD]))', ctx({ tableCalc: { partitionBy: [] } }));
		assert.equal(r.expression, 'DENSE_RANK() OVER (ORDER BY AVG(`REVENUE_PERIOD`) DESC)');
		assert.equal(r.status, 'ok');
		assert.equal(r.dataType, 'LONG');
	});

	test('RankRangeFilter: a boolean over RankByRevenue and a parameter', () => {
		const r = translateCalc('if [Calculation_261771754152816642]<=[Parameters].[Parameter 5 2] then TRUE else FALSE end', ctx({ tableCalc: {} }));
		assert.equal(r.expression, "CASE WHEN DENSE_RANK() OVER (ORDER BY AVG(`REVENUE_PERIOD`) DESC) <= 10 THEN 'true' ELSE 'false' END");
		assert.equal(r.status, 'ok');
		assert.equal(r.aggregated, true);
	});

	test('RankByRevenue and RankRangeFilter without window functions keep the window error', () => {
		const r = translateCalc('RANK_DENSE(AVG([REVENUE_PERIOD]))', { resolveField: (id) => fields[id] });
		assert.equal(r.status, 'unsupported');
		assert.deepEqual(codes(r), ['calc.table-calc']);
	});

	// Worksheet "AU": ISEMPLOYEE on rows, Event Time and Eventtime (Year) on columns, compute using Table (across).
	const ds = '[sqlproxy.1example0000000000000000000]';
	const pill = (name, extra = {}) => ({ id: `${ds}.[${name}]`, fieldId: `[${name.split(':')[1]}]`, aggregated: false, ...extra });
	const P = {
		emp: pill('none:ISEMPLOYEE:nk'),
		time: pill('none:Calculation_283726820408152066:ok'),
		year: pill('none:Eventtime (Quarter) (copy)_283726820407980033:ok'),
		au: pill('sum:Event Time (copy)_424182834505986066:qk', { aggregated: true }),
		pcdf: pill('pcdf:sum:Event Time (copy)_424182834505986066:qk:2', {
			aggregated: true,
			tableCalc: { type: 'PctDiff', orderingType: 'RowInPane', attrs: { prefix: 'pcdf', 'diff-options': 'Relative' } }
		}),
		diff: pill('usr:% AU_QUARTER diff (copy)_424182834504544273:nk', { aggregated: true, tableCalc: { type: 'Calculation', orderingType: 'Rows' } })
	};
	const au = {
		name: 'AU',
		pills: Object.fromEntries(Object.values(P).map((p) => [p.id, p])),
		rowPills: [P.emp.id, P.au.id, P.pcdf.id],
		colPills: [P.time.id, P.year.id],
		panes: [
			{ markClass: 'Bar', encodings: {} },
			{ markClass: 'Bar', encodings: { color: [P.year.id], text: [P.au.id] } },
			{ markClass: 'Shape', encodings: { shape: [P.diff.id], text: [P.pcdf.id] } }
		],
		sorts: []
	};
	const columns = { [P.emp.id]: 'ISEMPLOYEE', [P.time.id]: 'Event Time', [P.year.id]: 'Eventtime (Year)', [P.au.id]: 'AU measure' };
	const toItem = (id) => (columns[id] ? { column: columns[id] } : undefined);

	test('% AU measure diff: LOOKUP across the column dimensions, partitioned by the row dimension', () => {
		const addressing = tableCalcAddressing(au, P.diff.id, toItem);
		assert.deepEqual(addressing.partitionBy, [{ column: 'ISEMPLOYEE' }]);
		assert.deepEqual(addressing.orderBy, [
			{ column: 'Event Time', direction: 'ASC' },
			{ column: 'Eventtime (Year)', direction: 'ASC' }
		]);
		const formula =
			"if (ZN(SUM([AU measure])) - LOOKUP(ZN(SUM([AU measure])), -1)) / ABS(LOOKUP(ZN(SUM([AU measure])), -1))>0 then 'up' else 'down' end";
		const r = translateCalc(formula, ctx({ tableCalc: addressing }));
		const lag = 'LAG(IFNULL(SUM(`AU measure`), 0), 1) OVER (PARTITION BY `ISEMPLOYEE` ORDER BY `Event Time` ASC, `Eventtime (Year)` ASC)';
		assert.equal(r.expression, `CASE WHEN 0 < (IFNULL(SUM(\`AU measure\`), 0) - ${lag}) / NULLIF(ABS(${lag}), 0) THEN 'up' ELSE 'down' END`);
		assert.equal(r.status, 'ok');
	});

	test('the Percent Difference quick calc on the same sheet runs across the innermost column within each pane', () => {
		const addressing = tableCalcAddressing(au, P.pcdf.id, toItem);
		assert.deepEqual(addressing.partitionBy, [{ column: 'ISEMPLOYEE' }, { column: 'Event Time' }]);
		assert.deepEqual(addressing.orderBy, [{ column: 'Eventtime (Year)', direction: 'ASC' }]);
		const r = quickTableCalcSql(P.pcdf.tableCalc, 'SUM(`AU measure`)', addressing);
		const lag = 'LAG(SUM(`AU measure`), 1) OVER (PARTITION BY `ISEMPLOYEE`, `Event Time` ORDER BY `Eventtime (Year)` ASC)';
		assert.equal(r.sql, `(SUM(\`AU measure\`) - ${lag}) / NULLIF(ABS(${lag}), 0)`);
	});
});

describe('tableCalcAddressing', () => {
	const pill = (id, extra = {}) => ({ id, fieldId: `[${id}]`, aggregated: false, ...extra });
	const sheet = (calc, { rows = ['r1', 'r2'], cols = ['c1', 'c2'], marks = ['m1'], sorts = [] } = {}) => {
		const ids = [...rows, ...cols, ...marks];
		const pills = Object.fromEntries(ids.map((id) => [id, pill(id)]));
		pills.calc = pill('calc', { aggregated: true, tableCalc: calc });
		pills.measure = pill('measure', { aggregated: true });
		return { pills, rowPills: [...rows, 'measure'], colPills: cols, panes: [{ encodings: { color: marks, text: ['calc'] } }], sorts };
	};
	const toItem = (id) => (id === 'unmapped' ? undefined : { column: id });
	const cols = (items) => items.map((i) => i.column);
	const run = (calc, opts) => tableCalcAddressing(sheet(calc, opts), 'calc', toItem);

	test('Rows is Table (across): columns and marks addressed, rows partitioned', () => {
		const a = run({ type: 'Calculation', orderingType: 'Rows' });
		assert.deepEqual(cols(a.partitionBy), ['r1', 'r2']);
		assert.deepEqual(cols(a.orderBy), ['c1', 'c2', 'm1']);
		assert.deepEqual(a.issues, []);
	});

	test('Columns is Table (down)', () => {
		const a = run({ type: 'CumTotal', orderingType: 'Columns' });
		assert.deepEqual(cols(a.partitionBy), ['c1', 'c2']);
		assert.deepEqual(cols(a.orderBy), ['r1', 'r2', 'm1']);
	});

	test('Table addresses everything, rows first', () => {
		const a = run({ type: 'Calculation', orderingType: 'Table' });
		assert.deepEqual(a.partitionBy, []);
		assert.deepEqual(cols(a.orderBy), ['r1', 'r2', 'c1', 'c2', 'm1']);
	});

	test('pane modes address the innermost dimension', () => {
		assert.deepEqual(cols(run({ type: 'Diff', orderingType: 'RowInPane' }).orderBy), ['c2', 'm1']);
		assert.deepEqual(cols(run({ type: 'Diff', orderingType: 'ColumnInPane' }).orderBy), ['r2', 'm1']);
		assert.deepEqual(cols(run({ type: 'Diff', orderingType: 'ColumnInPane' }).partitionBy), ['r1', 'c1', 'c2']);
		assert.deepEqual(cols(run({ type: 'Diff', orderingType: 'Pane' }).orderBy), ['r2', 'c2', 'm1']);
	});

	test('Cell addresses the Marks card only', () => {
		const a = run({ type: 'PctTotal', orderingType: 'Cell' });
		assert.deepEqual(cols(a.orderBy), ['m1']);
		assert.deepEqual(cols(a.partitionBy), ['r1', 'r2', 'c1', 'c2']);
	});

	test('Field addresses the compute-using fields in their order', () => {
		const a = run({ type: 'Calculation', orderingType: 'Field', orderFields: ['[c2]', 'r1'] });
		assert.deepEqual(cols(a.orderBy), ['c2', 'r1']);
		assert.deepEqual(cols(a.partitionBy), ['r2', 'c1', 'm1']);
		const missing = run({ type: 'Calculation', orderingType: 'Field', orderFields: ['[gone]'] });
		assert.equal(missing.issues.length, 1);
	});

	test('Field matches compute-using fields named [datasource].[field] without their derivation', () => {
		const s = sheet({ type: 'Calculation', orderingType: 'Field', orderFields: ['[ds].[Customer]'] });
		s.pills.c2 = { ...s.pills.c2, id: '[ds].[none:Customer:nk]', datasourceId: 'ds', fieldId: '[Customer]' };
		const a = tableCalcAddressing(s, 'calc', toItem);
		assert.deepEqual(cols(a.orderBy), ['c2']);
		assert.deepEqual(a.issues, []);
	});

	test('parameters on the shelves neither partition nor order the window', () => {
		const s = sheet({ type: 'Calculation', orderingType: 'Rows' }, { rows: ['r1', '[Parameters].[Grain]'] });
		s.pills['[Parameters].[Grain]'] = { id: '[Parameters].[Grain]', datasourceId: 'Parameters', fieldId: '[Grain]', aggregated: false };
		const a = tableCalcAddressing(s, 'calc', toItem);
		assert.deepEqual(cols(a.partitionBy), ['r1']);
		assert.deepEqual(a.issues, []);
	});

	test('a pill without a table-calc setting computes Table (across) silently', () => {
		const a = run(undefined);
		assert.deepEqual(cols(a.orderBy), ['c1', 'c2', 'm1']);
		assert.deepEqual(a.issues, []);
	});

	test('an unknown or missing compute-using falls back to Table (across) with a warning', () => {
		const a = run({ type: 'Calculation' });
		assert.deepEqual(cols(a.orderBy), ['c1', 'c2', 'm1']);
		assert.equal(a.issues[0].code, 'calc.table-calc-addressing');
	});

	test('view sorts set the window order; manual sorts are approximated', () => {
		const a = run(
			{ type: 'Calculation', orderingType: 'Rows' },
			{
				sorts: [
					{ pillId: 'c1', kind: 'computed', direction: 'DESC', using: 'measure' },
					{ pillId: 'c2', kind: 'alphabetic', direction: 'DESC' },
					{ pillId: 'm1', kind: 'manual', direction: 'ASC', order: [] }
				]
			}
		);
		assert.deepEqual(a.orderBy, [
			{ column: 'measure', direction: 'DESC' },
			{ column: 'c2', direction: 'DESC' },
			{ column: 'm1', direction: 'ASC' }
		]);
		assert.equal(a.issues.length, 1);
	});

	test('a computed sort by a measure orders the window by its aggregate, then by the dimension', () => {
		const s = sheet({ type: 'CumTotal', orderingType: 'Rows' }, { cols: ['c1'], marks: [], sorts: [{ pillId: 'c1', kind: 'computed', direction: 'DESC', using: 'measure' }] });
		const items = [];
		const a = tableCalcAddressing(s, 'calc', (id) => (items.push(id), { column: id }), { toMeasure: (id) => (id === 'measure' ? 'COUNT(DISTINCT `x`)' : undefined) });
		assert.deepEqual(a.orderBy, [
			{ expression: 'COUNT(DISTINCT `x`)', direction: 'DESC' },
			{ column: 'c1', direction: 'ASC' }
		]);
		assert.ok(!items.includes('measure'));
		const secondary = tableCalcAddressing(s, 'calc', toItem, { calc: { type: 'PctTotal', orderingType: 'Columns' } });
		assert.deepEqual(cols(secondary.partitionBy), ['c1']);
	});

	test('Measure Names and dimensions with no Domo column are left out', () => {
		const a = run({ type: 'Calculation', orderingType: 'Rows' }, { cols: ['[ds].[:Measure Names]', 'unmapped', 'c1'] });
		assert.deepEqual(cols(a.orderBy), ['c1', 'm1']);
		assert.equal(a.issues.length, 1);
		assert.match(a.issues[0].message, /unmapped/);
	});
});

describe('quickTableCalcSql', () => {
	const addressing = { partitionBy: [{ column: 'Region' }], orderBy: [{ column: 'Order Date', direction: 'ASC' }] };
	const base = 'SUM(`Sales`)';
	const w = 'PARTITION BY `Region` ORDER BY `Order Date` ASC';
	const q = (type, attrs, a = addressing) => quickTableCalcSql({ type, attrs }, base, a);

	test('percent of total', () => {
		assert.equal(q('PctTotal').sql, 'SUM(`Sales`) / NULLIF(SUM(SUM(`Sales`)) OVER (PARTITION BY `Region`), 0)');
		assert.equal(q('PctTotal', {}, {}).sql, 'SUM(`Sales`) / NULLIF(SUM(SUM(`Sales`)) OVER (), 0)');
	});

	test('running total with its aggregation', () => {
		assert.equal(q('CumTotal', { aggregation: 'Sum' }).sql, `SUM(SUM(\`Sales\`)) OVER (${w} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`);
		assert.match(q('CumTotal', { aggregation: 'Avg' }).sql, /^AVG\(/);
		assert.ok(q('CumTotal', { aggregation: 'Median' }).unsupported);
		assert.ok(q('CumTotal', {}, { partitionBy: [] }).unsupported);
	});

	test('difference and percent difference from the previous, first or last value', () => {
		assert.equal(q('Diff').sql, `SUM(\`Sales\`) - LAG(SUM(\`Sales\`), 1) OVER (${w})`);
		assert.equal(q('PctDiff', { 'diff-options': 'Relative' }).sql, `(SUM(\`Sales\`) - LAG(SUM(\`Sales\`), 1) OVER (${w})) / NULLIF(ABS(LAG(SUM(\`Sales\`), 1) OVER (${w})), 0)`);
		assert.match(q('Diff', { 'diff-options': 'First' }).sql, /FIRST_VALUE\(SUM\(`Sales`\)\) OVER \(.* ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING\)$/);
		assert.match(q('Diff', { 'diff-options': 'Last' }).sql, /LAST_VALUE/);
	});

	test('rank variants and percentile', () => {
		assert.equal(q('Rank', { prefix: 'rank' }).sql, 'RANK() OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) DESC)');
		assert.equal(q('Rank', { prefix: 'rank', 'rank-options': 'Competition,Ascending' }).sql, 'RANK() OVER (PARTITION BY `Region` ORDER BY SUM(`Sales`) ASC)');
		assert.match(q('Rank', { prefix: 'rank', 'rank-options': 'Competition,Descending' }).sql, /DESC\)$/);
		assert.match(q('Rank', { prefix: 'rank_dense' }).sql, /^DENSE_RANK\(\)/);
		assert.match(q('Rank', { prefix: 'rank_unique' }).sql, /^ROW_NUMBER\(\)/);
		assert.match(q('Rank', { prefix: 'rank_modified' }).sql, /^COUNT\(SUM\(`Sales`\)\) OVER \(.* RANGE BETWEEN/);
		assert.match(q('PctRank').sql, /^\(COUNT\(SUM\(`Sales`\)\) OVER \(PARTITION BY `Region` ORDER BY SUM\(`Sales`\) ASC RANGE/);
	});

	test('moving calculation', () => {
		assert.equal(q('MovingCalc', { aggregation: 'Avg', from: '-2', to: '0' }).sql, `AVG(SUM(\`Sales\`)) OVER (${w} ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)`);
		assert.match(q('MovingCalc', { aggregation: 'Sum', from: '-1', to: '1' }).sql, /ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING/);
	});

	test('the XML names Difference, WindowTotal and PctValue', () => {
		assert.equal(q('Difference').sql, q('Diff').sql);
		assert.equal(q('WindowTotal', { aggregation: 'Sum', from: '-2', to: '0', 'window-options': 'IncludeCurrent' }).sql, `SUM(SUM(\`Sales\`)) OVER (${w} ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)`);
		assert.match(q('WindowTotal', { aggregation: 'Avg', from: '-4', to: '0', 'window-options': '' }).sql, /ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING\)$/);
		assert.equal(q('PctValue').sql, `SUM(\`Sales\`) / NULLIF(LAG(SUM(\`Sales\`), 1) OVER (${w}), 0)`);
	});

	test('a secondary percent of total over a running sum divides by the total of the measure', () => {
		const order = { partitionBy: [], orderBy: [{ expression: 'COUNT(DISTINCT `Id`)', direction: 'DESC' }, { column: 'Area', direction: 'ASC' }] };
		const r = quickTableCalcSql({ type: 'CumTotal', attrs: { aggregation: 'Sum' }, secondary: { type: 'PctTotal', orderingType: 'Rows' } }, 'COUNT(DISTINCT `Id`)', order, order);
		assert.equal(
			r.sql,
			'(SUM(COUNT(DISTINCT `Id`)) OVER (ORDER BY COUNT(DISTINCT `Id`) DESC, `Area` ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) / NULLIF(SUM(COUNT(DISTINCT `Id`)) OVER (), 0)'
		);
		assert.match(r.note, /sum of the marks/);
		assert.equal(quickTableCalcSql({ type: 'CumTotal', attrs: { aggregation: 'Sum' }, secondary: { type: 'PctTotal' } }, base, addressing).note, undefined);
	});

	test('a secondary difference of a running sum is the measure after the first mark; other secondaries are unsupported', () => {
		const calc = (secondary, aggregation = 'Sum') => ({ type: 'CumTotal', attrs: { aggregation }, secondary });
		assert.equal(quickTableCalcSql(calc({ type: 'Difference', attrs: { 'diff-options': 'Relative' } }), base, addressing).sql, `CASE WHEN ROW_NUMBER() OVER (${w}) = 1 THEN NULLIF(1, 1) ELSE SUM(\`Sales\`) END`);
		assert.match(quickTableCalcSql(calc({ type: 'Difference' }), base, addressing, { partitionBy: [], orderBy: addressing.orderBy }).unsupported, /Difference of CumTotal/);
		assert.ok(quickTableCalcSql(calc({ type: 'Difference' }, 'Avg'), base, addressing).unsupported);
		assert.ok(quickTableCalcSql(calc({ type: 'Rank' }), base, addressing).unsupported);
		assert.ok(quickTableCalcSql({ type: 'WindowTotal', attrs: { aggregation: 'Sum', from: '-2', to: '0' }, secondary: { type: 'Difference' } }, base, addressing).unsupported);
	});

	test('other quick calcs are unsupported', () => {
		assert.ok(q('Custom').unsupported);
	});
});
