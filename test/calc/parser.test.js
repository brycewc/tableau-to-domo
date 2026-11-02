import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseFormula, CalcSyntaxError } from '../../src/convert/calc/index.js';

const shape = (node) => {
	switch (node.type) {
		case 'Literal':
			return node.valueType === 'string' ? `'${node.value}'` : String(node.value);
		case 'Field':
			return node.id;
		case 'Binary':
			return `(${shape(node.left)} ${node.op} ${shape(node.right)})`;
		case 'Unary':
			return `(${node.op} ${shape(node.operand)})`;
		case 'Call':
			return `${node.name}(${node.args.map(shape).join(', ')})`;
		case 'Paren':
			return `[${shape(node.expr)}]`;
		case 'In':
			return `(${shape(node.expr)} ${node.negated ? 'NOT IN' : 'IN'} ${node.list.map(shape).join(',')})`;
		default:
			return node.type;
	}
};

describe('lexer', () => {
	test('field references, escapes and qualifiers', () => {
		const toks = tokenize('[a]]b].[c] [Parameters].[P 1] [x]');
		assert.deepEqual(
			toks.filter((t) => t.type === 'field').map((t) => [t.value, t.parts]),
			[
				['[a]]b].[c]', ['a]b', 'c']],
				['[Parameters].[P 1]', ['Parameters', 'P 1']],
				['[x]', ['x']]
			]
		);
	});

	test('strings with doubled quotes in both quote styles', () => {
		const toks = tokenize(`"a""b" 'c''d' "it's"`);
		assert.deepEqual(
			toks.filter((t) => t.type === 'string').map((t) => t.value),
			['a"b', "c'd", "it's"]
		);
	});

	test('numbers, dates, operators and comments', () => {
		const toks = tokenize('1.5 .25 1e-3 #2024-01-01# <= >= == != <> && || // tail\n/* block\n*/ x');
		assert.deepEqual(
			toks.map((t) => t.value),
			['1.5', '.25', '1e-3', '2024-01-01', '<=', '>=', '==', '!=', '<>', '&&', '||', 'x', '']
		);
	});

	test('positions are tracked', () => {
		const toks = tokenize('  SUM( [x] )');
		assert.equal(toks[0].pos, 2);
		assert.equal(toks[2].pos, 7);
	});

	test('lexer errors carry position, line and column', () => {
		for (const [text, pos] of [
			['[Sales', 0],
			['"abc', 0],
			['1 + #2024', 4],
			['/* x', 0],
			['1 @ 2', 2]
		]) {
			assert.throws(
				() => tokenize(text),
				(err) => err instanceof CalcSyntaxError && err.position === pos
			);
		}
		assert.throws(
			() => tokenize('1 +\n  @'),
			(err) => err.line === 2 && err.column === 3
		);
	});
});

describe('parser precedence', () => {
	const cases = [
		['1 + 2 * 3', '(1 + (2 * 3))'],
		['(1 + 2) * 3', '([(1 + 2)] * 3)'],
		['1 - 2 - 3', '((1 - 2) - 3)'],
		['2 ^ 3 ^ 2', '(2 ^ (3 ^ 2))'],
		['-2 ^ 2', '((- 2) ^ 2)'],
		['a = 1 OR b = 2 AND c = 3', '(([a] = 1) OR (([b] = 2) AND ([c] = 3)))'],
		['NOT a = 1 AND b', '((NOT ([a] = 1)) AND [b])'],
		['a + 1 > b * 2', '(([a] + 1) > ([b] * 2))'],
		['[x] IN (1, 2) AND [y]', '(([x] IN 1,2) AND [y])'],
		['[x] NOT IN (1)', '([x] NOT IN 1)'],
		['a && b || c', '(([a] AND [b]) OR [c])'],
		['[a] == 1', '([a] = 1)'],
		['[a] <> 1', '([a] != 1)'],
		['sum([x])', 'SUM([x])'],
		['1 % 2 * 3', '((1 % 2) * 3)']
	];
	for (const [text, expected] of cases) {
		test(text, () => assert.equal(shape(parseFormula(text)), expected));
	}

	test('IF / ELSEIF / ELSE', () => {
		const ast = parseFormula('IF a THEN 1 ELSEIF b THEN 2 ELSE 3 END');
		assert.equal(ast.type, 'If');
		assert.equal(ast.branches.length, 2);
		assert.equal(ast.else.value, 3);
	});

	test('CASE with subject', () => {
		const ast = parseFormula('CASE [r] WHEN "a" THEN 1 WHEN "b" THEN 2 END');
		assert.equal(ast.type, 'Case');
		assert.equal(ast.subject.id, '[r]');
		assert.equal(ast.whens.length, 2);
		assert.equal(ast.else, null);
	});

	test('LOD forms', () => {
		const fixed = parseFormula('{FIXED [a], [b] : SUM([x])}');
		assert.deepEqual([fixed.lodType, fixed.dims.length, fixed.body.name], ['FIXED', 2, 'SUM']);
		assert.equal(parseFormula('{ FIXED : SUM([x]) }').dims.length, 0);
		assert.equal(parseFormula('{SUM([x])}').lodType, 'TABLE');
		assert.equal(parseFormula('{include [a]: AVG([x])}').lodType, 'INCLUDE');
		assert.equal(parseFormula('{EXCLUDE [a]: AVG([x])}').lodType, 'EXCLUDE');
	});

	test('date literal kinds', () => {
		assert.deepEqual(
			['#2024-01-31#', '#2024-01-31 13:05:09#', '#1/2/2024#', '#March 5, 2024#', '#5 March 2024 2:30 PM#'].map((t) => {
				const n = parseFormula(t);
				return [n.valueType, n.value];
			}),
			[
				['date', '2024-01-31'],
				['datetime', '2024-01-31 13:05:09'],
				['date', '2024-01-02'],
				['date', '2024-03-05'],
				['datetime', '2024-03-05 14:30:00']
			]
		);
	});

	test('syntax errors with position', () => {
		const cases = [
			['', 0],
			['SUM([x]', 7],
			['IF a THEN b', 11],
			['1 +', 3],
			['CASE a END', 7],
			['{INCLUDE : SUM([x])}', 1],
			['[x] IN 3', 7],
			['1 2', 2],
			['#not a date#', 0],
			['THEN', 0]
		];
		for (const [text, pos] of cases) {
			assert.throws(
				() => parseFormula(text),
				(err) => err instanceof CalcSyntaxError && err.position === pos,
				text
			);
		}
	});
});

test('trailing commas in IN lists and argument lists are accepted and dropped', () => {
	const ast = parseFormula("IF [Campaign] IN (\n\t'eCommerce: Buy Now', \n\t'eCommerce: Free Trial Conversion',) \n THEN 'eCommerce'\n\nELSE 'Marketing Programs' END");
	assert.equal(ast.type, 'If');
	assert.equal(shape(ast.branches[0].cond), "([Campaign] IN 'eCommerce: Buy Now','eCommerce: Free Trial Conversion')");
	assert.equal(shape(parseFormula('MAX([a], [b],)')), 'MAX([a], [b])');
	assert.throws(() => parseFormula('[x] IN (,)'), CalcSyntaxError);
	assert.throws(() => parseFormula('[x] IN ()'), CalcSyntaxError);
});
