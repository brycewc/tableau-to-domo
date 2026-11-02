import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { translateCalc } from '../../src/convert/calc/index.js';
import { planBeastModes } from '../../src/convert/beastmodes.js';
import { baseCtx } from './helpers.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/account-summary-calcs.json', import.meta.url), 'utf8'));

/** True when `sql` has a TRUE or FALSE token outside string literals, which Beast Mode reads as a column. */
const hasBareBoolean = (sql) => /\b(TRUE|FALSE)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, "''"));

/** Beast modes by name; variable references read as the backticked variable name. */
function planned(options = {}) {
	const { beastModes, variables } = planBeastModes(fixture.ir, [fixture.dataset], { workbookKey: 'cts', options });
	const names = new Map(variables.map((v) => [`DOMO_BEAST_MODE(${v.legacyId})`, `\`${v.name}\``]));
	const named = (sql) => sql.replace(/DOMO_BEAST_MODE\(calculation_[0-9a-f-]{36}\)/g, (m) => names.get(m) ?? m);
	return Object.fromEntries(beastModes.map((bm) => [bm.name, { ...bm, expression: named(bm.expression) }]));
}

// Beast modes that failed validateFunctions or card create on acme.domo.com (Account Summary), with inlined parameters.
const LIVE_FAILURES = {
	RelativeStartDateFilter: ["'true'", 'STRING'],
	SortingField: ['`DAYS_SINCE_FIRST_START` * 1', 'LONG'],
	AgentOutreach: ["CASE WHEN IFNULL(`ACTIVITYCOUNT`, 0) > 0 THEN 'true' ELSE 'false' END", 'STRING'],
	'Agent Engaged Bool to INT': ["CASE WHEN LOWER(`Agent Engaged`) = 'true' THEN 1 ELSE 0 END", 'LONG'],
	'TotalUsage%': ['IFNULL(`ACCOUNT_ACTIVE_USERS`, 0) / NULLIF(`ACCOUNT_LICENSES_PAID`, 0)', 'DOUBLE'],
	'# of Accounts': ["COUNT(DISTINCT CASE WHEN INSTR(`Product`, 'TRIAL') = 0 THEN `Account ID` END)", 'LONG']
};

for (const [name, [expression, dataType]] of Object.entries(LIVE_FAILURES)) {
	test(`live regression: ${name}`, () => {
		const bm = planned()[name];
		assert.equal(bm.expression, expression);
		assert.equal(bm.dataType, dataType);
		assert.equal(bm.status, 'ok');
	});
}

test('live regression: TotalLicenses(Account) reduces to a bare column, so it binds to the column with an alias instead of a beast mode', () => {
	assert.equal(planned()['TotalLicenses(Account)'], undefined);
	const { bindings } = planBeastModes(fixture.ir, [fixture.dataset], { workbookKey: 'cts' });
	const ds = fixture.ir.datasources[0];
	const field = ds.fields.find((f) => f.name === 'TotalLicenses(Account)');
	const binding = bindings.get(ds.id, field.id);
	assert.deepEqual([binding.kind, binding.column, binding.alias], ['column', 'ACCOUNT_LICENSES_PAID', 'TotalLicenses(Account)']);
});

test('live regression: IsAgent keeps the CONTAINS chain and returns a string boolean', () => {
	const { expression } = planned().IsAgent;
	assert.match(expression, /^CASE WHEN INSTR\(UPPER\(`Assigned To`\), 'AGENT A'\) > 0 OR /);
	assert.equal(expression.match(/ OR /g).length, 27);
	assert.ok(expression.endsWith("'AGENT AB') > 0 THEN 'true' END"));
});

test('live regression: Usage Bucket inlines TotalUsage% after its parameter branch collapsed', () => {
	const { expression } = planned()['Usage Bucket'];
	const ratio = '(IFNULL(`ACCOUNT_ACTIVE_USERS`, 0) / NULLIF(`ACCOUNT_LICENSES_PAID`, 0))';
	assert.ok(expression.startsWith(`CASE WHEN ${ratio} <= 0 OR ${ratio} IS NULL THEN '0%' WHEN ${ratio} > 0 AND ${ratio} < 0.2 THEN`));
	assert.ok(expression.endsWith(`WHEN ${ratio} > 1 THEN '>100%' END`));
});

test('no planned beast mode has a bare TRUE or FALSE, with parameters inlined or as variables', () => {
	for (const options of [{}, { parameters: 'variables' }]) {
		for (const bm of Object.values(planned(options))) assert.ok(!hasBareBoolean(bm.expression), `${bm.name}: ${bm.expression}`);
	}
});

test('with variables, boolean parameters and nested boolean IFs become predicates', () => {
	const bms = planned({ parameters: 'variables' });
	assert.equal(
		bms['TotalLicenses(Account)'].expression,
		"CASE WHEN LOWER((CASE `Bundled licenses` WHEN 'Include' THEN 'true' WHEN 'Exclude' THEN 'false' END)) = 'true' THEN `ACCOUNT_LICENSES_ALL` ELSE `ACCOUNT_LICENSES_PAID` END",
		'an aliased parameter maps its label back to the value'
	);
	const filter = bms.RelativeStartDateFilter.expression;
	assert.ok(filter.startsWith("CASE WHEN `RelativeStartDate` = 'All' THEN 'true' WHEN `RelativeStartDate` = 'Today' THEN CASE WHEN `Days Since Start` = 0 THEN 'true' WHEN NOT (`Days Since Start` = 0) THEN 'false' END"));
	assert.ok(filter.includes("AND (CASE WHEN `Currentfp` = 1 THEN CASE WHEN (`Fiscal Period Num` = 12 AND `Fiscal Year Num` = `Currentfy` - 1) THEN 'true'"));
	assert.ok(filter.includes("ELSE CASE WHEN `Fiscal Period Num` = `Currentfp` - 1 THEN 'true' WHEN NOT (`Fiscal Period Num` = `Currentfp` - 1) THEN 'false' END END = 'true')) THEN 'true'"));
});

const BOOL_CALCS = {
	'[Big]': { id: '[Big]', name: 'Big', datatype: 'boolean', kind: 'calculated', formula: '[Sales] > 1000' },
	'[East]': { id: '[East]', name: 'East', datatype: 'boolean', kind: 'calculated', formula: "[Region] = 'East'" },
	'[Dir]': { id: '[Dir]', name: 'Dir', datatype: 'integer', kind: 'calculated', formula: "CASE 'Asc' WHEN 'Asc' THEN 1 ELSE -1 END" }
};
const PARAMS = {
	'[Parameters].[Choice]': { id: '[Parameters].[Choice]', name: 'Choice', datatype: 'string', value: 'Last FP' },
	'[Parameters].[Flag]': { id: '[Parameters].[Flag]', name: 'Flag', datatype: 'boolean', value: false },
	'[Parameters].[On]': { id: '[Parameters].[On]', name: 'On', datatype: 'boolean', value: 'true' },
	'[Parameters].[N]': { id: '[Parameters].[N]', name: 'N', datatype: 'integer', value: 3 },
	'[Parameters].[NullP]': { id: '[Parameters].[NullP]', name: 'NullP', datatype: 'integer', value: null }
};
const ctx = (extra) => {
	const base = baseCtx(extra);
	return { ...base, resolveField: (id) => (BOOL_CALCS[id] ? { kind: 'calc', field: BOOL_CALCS[id] } : PARAMS[id] ? { kind: 'parameter', parameter: PARAMS[id] } : base.resolveField(id)) };
};

// [Tableau formula, Beast Mode expression]. Every shape here was accepted by validateFunctions on acme.domo.com.
const SHAPES = [
	['TRUE', "'true'"],
	['FALSE', "'false'"],
	['NOT TRUE', "'false'"],
	["IF 'All' = 'All' THEN [Sales] ELSE [Profit] END", '`Sales`'],
	["IF [Parameters].[Choice] = 'All' THEN [Sales] ELSEIF [Parameters].[Choice] = 'Last FP' THEN [Profit] END", '`Profit`'],
	['IF [Parameters].[Flag] THEN SUM([Sales]) ELSE SUM([Profit]) END', 'SUM(`Profit`)'],
	['IF [Parameters].[On] THEN 1 ELSE 0 END', '1'],
	['CASE [Parameters].[Flag] WHEN TRUE THEN [Sales] ELSE [Profit] END', '`Profit`'],
	["CASE 'b' WHEN 'a' THEN 1 WHEN 'b' THEN 2 END", '2'],
	["CASE 'z' WHEN 'a' THEN 1 END", 'NULLIF(1, 1)'],
	['IF [Sales] > 0 THEN 1 ELSE NULL END', 'CASE WHEN `Sales` > 0 THEN 1 END'],
	["[Region] = 'East' AND TRUE", "CASE WHEN `Region` = 'East' THEN 'true' WHEN NOT (`Region` = 'East') THEN 'false' END"],
	["[Region] = 'East' OR TRUE", "'true'"],
	["FALSE AND [Region] = 'East'", "'false'"],
	["'a' IN ('a', 'b')", "'true'"],
	['IIF(1 > 2, [Sales], [Profit])', '`Profit`'],
	['IF [Sales] > 0 THEN TRUE ELSE FALSE END', "CASE WHEN `Sales` > 0 THEN 'true' ELSE 'false' END"],
	['IF [Is Returned] = TRUE THEN 1 ELSE 0 END', "CASE WHEN LOWER(`Is Returned`) = 'true' THEN 1 ELSE 0 END"],
	['IF [Is Returned] = FALSE THEN 1 END', "CASE WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 1 END"],
	['IF [Is Returned] != TRUE THEN 1 END', "CASE WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 1 END"],
	['CASE [Is Returned] WHEN TRUE THEN [Sales] ELSE [Profit] END', "CASE WHEN LOWER(`Is Returned`) = 'true' THEN `Sales` ELSE `Profit` END"],
	['CASE [Is Returned] WHEN FALSE THEN 1 WHEN TRUE THEN 2 END', "CASE WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 1 WHEN LOWER(`Is Returned`) = 'true' THEN 2 END"],
	["IF [Big] = FALSE AND NOT [Is Returned] THEN 'small' END", "CASE WHEN `Sales` <= 1000 AND NOT (LOWER(`Is Returned`) = 'true') THEN 'small' END"],
	['IF [Big] THEN 1 END', 'CASE WHEN (`Sales` > 1000) THEN 1 END'],
	['NOT [Big]', "CASE WHEN `Sales` <= 1000 THEN 'true' WHEN (`Sales` > 1000) THEN 'false' END"],
	['[Sales] * [Dir]', '`Sales` * 1'],
	[
		'IF [Sales] > 0 THEN [Profit] = 0 ELSE [Profit] > 0 END',
		"CASE WHEN `Sales` > 0 THEN CASE WHEN `Profit` = 0 THEN 'true' WHEN NOT (`Profit` = 0) THEN 'false' END ELSE CASE WHEN `Profit` > 0 THEN 'true' WHEN `Profit` <= 0 THEN 'false' END END"
	],
	[
		"[Region] = 'East' AND (IF [Sales] > 0 THEN [Profit] > 0 ELSE [Discount] > 0 END)",
		"CASE WHEN `Region` = 'East' AND (CASE WHEN `Sales` > 0 THEN CASE WHEN `Profit` > 0 THEN 'true' WHEN `Profit` <= 0 THEN 'false' END ELSE CASE WHEN `Discount` > 0 THEN 'true' WHEN `Discount` <= 0 THEN 'false' END END = 'true') THEN 'true' WHEN NOT (`Region` = 'East' AND (CASE WHEN `Sales` > 0 THEN CASE WHEN `Profit` > 0 THEN 'true' WHEN `Profit` <= 0 THEN 'false' END ELSE CASE WHEN `Discount` > 0 THEN 'true' WHEN `Discount` <= 0 THEN 'false' END END = 'true')) THEN 'false' END"
	],
	['IIF([Is Returned], [Sales] > 0, FALSE)', "CASE WHEN LOWER(`Is Returned`) = 'true' THEN CASE WHEN `Sales` > 0 THEN 'true' WHEN `Sales` <= 0 THEN 'false' END WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 'false' END"],
	['IFNULL([Is Returned], FALSE)', "IFNULL(CASE WHEN LOWER(`Is Returned`) = 'true' THEN 'true' WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 'false' END, 'false')"],
	['NOT ([Sales] > 0 OR [Is Returned])', "CASE WHEN NOT (`Sales` > 0 OR LOWER(`Is Returned`) = 'true') THEN 'true' WHEN (`Sales` > 0 OR LOWER(`Is Returned`) = 'true') THEN 'false' END"],
	['NOT CONTAINS([Region], "x")', "CASE WHEN INSTR(`Region`, 'x') = 0 THEN 'true' WHEN INSTR(`Region`, 'x') > 0 THEN 'false' END"],
	['INT([Is Returned])', "CASE WHEN LOWER(`Is Returned`) = 'true' THEN 1 WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 0 END"],
	['INT(TRUE)', '1']
];

for (const [formula, expected] of SHAPES) {
	test(`boolean shape: ${formula}`, () => {
		const r = translateCalc(formula, ctx());
		assert.equal(r.expression, expected);
		assert.ok(!hasBareBoolean(r.expression));
	});
}

test('a boolean parameter in variables mode is compared as text', () => {
	const r = translateCalc('IF [Parameters].[Flag] THEN 1 ELSE 0 END', ctx({ options: { parameters: 'variables' } }));
	assert.equal(r.expression, "CASE WHEN LOWER(`Flag`) = 'true' THEN 1 ELSE 0 END");
});

test('a dead branch is not translated, so its problems are not reported', () => {
	const r = translateCalc("IF 'a' = 'b' THEN SCRIPT_REAL('x', SUM([Sales])) ELSE SUM([Sales]) END", ctx());
	assert.equal(r.expression, 'SUM(`Sales`)');
	assert.equal(r.status, 'ok');
});

const BIG = "CASE WHEN (`Sales` > 1000) THEN 'true' WHEN `Sales` <= 1000 THEN 'false' END";
const EAST = "CASE WHEN (`Region` = 'East') THEN 'true' WHEN NOT (`Region` = 'East') THEN 'false' END";

/** Comparisons at the top level of each aggregate, window or CAST argument; nested calls and CASE blocks are skipped. */
function comparisonsInsideCalls(sql) {
	const text = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/`[^`]*`/g, '``');
	const found = [];
	for (const m of text.matchAll(/\b(COUNT|MIN|MAX|SUM|AVG|LAG|LEAD|FIRST_VALUE|LAST_VALUE|CAST)\(/g)) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		while (i < text.length && depth) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0, i++;
		let arg = text.slice(start, i - 1);
		for (let prev; prev !== arg; ) {
			prev = arg;
			arg = arg
				.replace(/\b[A-Z_]+\([^()]*\)/g, '_')
				.replace(/(^|[^A-Z_])\(([^()]*)\)/g, '$1 $2 ')
				.replace(/\bCASE\b((?!\bCASE\b)[\s\S])*?\bEND\b/g, '_');
		}
		if (/<|>|=|\bIS\b/.test(arg)) found.push(`${m[1]}(${arg})`);
	}
	return found;
}

// [Tableau formula, Beast Mode expression]. Each was VALID in validateFunctions on acme.domo.com (SuperStore); before the
// value form, all but the folded ones were PARSING_ERROR.
const BOOLEAN_ARGUMENTS = [
	['COUNTD([Big])', `COUNT(DISTINCT ${BIG})`],
	['COUNTD(IF [Sales] > 0 THEN TRUE END)', "COUNT(DISTINCT CASE WHEN `Sales` > 0 THEN 'true' END)"],
	['COUNT([Big])', `COUNT(${BIG})`],
	['MIN([Big])', `MIN(${BIG})`],
	['MAX([Is Returned])', "MAX(CASE WHEN LOWER(`Is Returned`) = 'true' THEN 'true' WHEN NOT (LOWER(`Is Returned`) = 'true') THEN 'false' END)"],
	['ATTR([Big])', `CASE WHEN MIN(${BIG}) = MAX(${BIG}) THEN MIN(${BIG}) END`],
	['COUNTD([Parameters].[On])', "COUNT(DISTINCT 'true')"],
	['MIN(TRUE)', "MIN('true')"],
	['IF MAX([Big]) THEN 1 ELSE 0 END', `CASE WHEN MAX(${BIG}) = 'true' THEN 1 ELSE 0 END`],
	['ISNULL([Big])', `CASE WHEN ${BIG} IS NULL THEN 'true' ELSE 'false' END`],
	['IF NOT ISNULL([Big]) THEN 1 END', `CASE WHEN ${BIG} IS NOT NULL THEN 1 END`],
	['IF ISNULL([Parameters].[NullP]) THEN 1 ELSE 2 END', '1'],
	['IF ISNULL([Parameters].[N]) THEN 1 ELSE 2 END', '2'],
	['STR([Big])', BIG],
	['STR(TRUE)', "'true'"],
	['IF MIN([Big], [East]) THEN 1 END', `CASE WHEN CASE WHEN ${BIG} <= ${EAST} THEN ${BIG} WHEN ${BIG} IS NOT NULL AND ${EAST} IS NOT NULL THEN ${EAST} END = 'true' THEN 1 END`]
];

for (const [formula, expected] of BOOLEAN_ARGUMENTS) {
	test(`boolean argument: ${formula}`, () => {
		const r = translateCalc(formula, ctx());
		assert.equal(r.expression, expected);
		assert.equal(r.status, 'ok');
		assert.ok(!hasBareBoolean(r.expression));
		assert.deepEqual(comparisonsInsideCalls(r.expression), []);
	});
}

test('comparisonsInsideCalls finds the shapes Domo rejected', () => {
	for (const sql of ['COUNT(DISTINCT (`Sales` > 1000))', "COUNT(DISTINCT CASE WHEN `Sales` > 0 THEN 'true' END = 'true')", 'MIN(1 = 1)', "MAX(LOWER(`Segment`) = 'true')", 'CAST((`Sales` > 1000) AS CHAR)']) {
		assert.equal(comparisonsInsideCalls(sql).length, 1, sql);
	}
});

test('boolean arguments of aggregates, LODs and table calcs are text in every mode', () => {
	const formulas = [
		...BOOLEAN_ARGUMENTS.map(([f]) => f),
		'{FIXED [Region] : MAX([Big])}',
		'WINDOW_MAX(MAX([Big]))',
		'LOOKUP(MIN([Big]), -1)',
		'MAX([Sales] > 0, [Profit] > 0)'
	];
	for (const options of [{}, { parameters: 'variables' }]) {
		for (const formula of formulas) {
			const r = translateCalc(formula, ctx({ options: { useWindowFunctions: true, ...options }, tableCalc: { orderBy: ['Region'] } }));
			assert.ok(!hasBareBoolean(r.expression), `${formula}: ${r.expression}`);
			assert.deepEqual(comparisonsInsideCalls(r.expression), [], `${JSON.stringify(options)} ${formula}: ${r.expression}`);
		}
	}
});

test('a boolean MIN or MAX in a table calc keeps the text value and compares it with true', () => {
	const r = translateCalc('IF WINDOW_MAX(MAX([Big])) THEN 1 END', ctx({ options: { useWindowFunctions: true }, tableCalc: { orderBy: ['Region'] } }));
	assert.equal(r.expression, `CASE WHEN MAX(MAX(${BIG})) OVER () = 'true' THEN 1 END`);
});

// Branches decided by functions and arithmetic over inlined parameters; the dead branch (with an LOD here) is dropped.
const FOLDED = [
	["IF STARTSWITH([Parameters].[Choice], 'Last') THEN 1 ELSE 2 END", '1'],
	["IF ENDSWITH([Parameters].[Choice], 'XX') THEN 1 ELSE 2 END", '2'],
	["IF UPPER([Parameters].[Choice]) = 'LAST FP' THEN 1 ELSE 2 END", '1'],
	["IF LOWER([Parameters].[Choice]) = 'last fp' THEN 1 ELSE 2 END", '1'],
	['IF LEN([Parameters].[Choice]) = 7 THEN 1 ELSE 2 END', '1'],
	["IF [Parameters].[Choice] + '!' = 'Last FP!' THEN 1 ELSE 2 END", '1'],
	['IF [Parameters].[N] - 3 = 0 THEN 1 ELSE 2 END', '1'],
	['IF [Parameters].[N] * 2 + 1 > 6 THEN 1 ELSE 2 END', '1'],
	['IF [Parameters].[NullP] + 1 = 1 THEN 1 ELSE 2 END', '2'],
	['IF 0.1 + 0.2 = 0.3 THEN 1 ELSE 2 END', '1'],
	["IF CONTAINS([Parameters].[Choice], 'FP') THEN SUM([Sales]) ELSE {FIXED [Region] : SUM([Sales])} END", 'SUM(`Sales`)']
];

for (const [formula, expected] of FOLDED) {
	test(`folded: ${formula}`, () => {
		const r = translateCalc(formula, ctx());
		assert.equal(r.expression, expected);
		assert.deepEqual(r.features, []);
	});
}

test('text that differs only in case is not folded: Domo compares it case-insensitively, as with parameter variables', () => {
	for (const formula of ["IF [Parameters].[Choice] = 'last fp' THEN 1 ELSE 2 END", "IF [Parameters].[Choice] IN ('last fp', 'x') THEN 1 ELSE 2 END", "IF CONTAINS([Parameters].[Choice], 'fp') THEN 1 ELSE 2 END"]) {
		const r = translateCalc(formula, ctx());
		assert.match(r.expression, /^CASE WHEN /, formula);
	}
	const r = translateCalc("IF [Parameters].[Choice] = 'last fp' THEN 1 ELSE 2 END", ctx());
	assert.equal(r.expression, "CASE WHEN 'Last FP' = 'last fp' THEN 1 ELSE 2 END");
	assert.ok(r.issues.some((i) => i.code === 'calc.case-sensitivity' && i.severity === 'info'));
	assert.equal(translateCalc("IF 'a' IN ('A', 'a') THEN 1 ELSE 2 END", ctx()).expression, '1');
});
