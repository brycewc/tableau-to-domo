import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN_INTEGER_FORMAT, domoNumberFormat, fieldColumnFormat, fieldNumberFormat, negativeStyle } from '../../src/convert/number-format.js';

const number = (precision, commas = true, extra = {}) => ({ type: 'number', format: `${commas ? '###,###' : '#'}${precision ? `.${'0'.repeat(precision)}` : ''}`, commas, percentMultiplied: true, precision, abbreviate: false, ...extra });
const currency = (precision, symbol = '$', abbreviate = false) => {
	const { format, commas, percentMultiplied } = number(precision);
	return { type: 'currency', format, commas, percentMultiplied, precision, currency: symbol, abbreviate };
};
const percent = (precision, commas = false, percentMultiplied = true) => ({ ...number(precision, commas), type: 'percent', percentMultiplied });

test('Tableau currency formats: symbol, decimals, separators', () => {
	assert.deepEqual(domoNumberFormat('c"$"#,##0;("$"#,##0)'), currency(0));
	assert.deepEqual(domoNumberFormat('c"$"#,##0.00;"$"-#,##0.00'), currency(2));
	assert.deepEqual(domoNumberFormat('c"$"\\#,\\#\\#0;("$"\\#,\\#\\#0)'), currency(0), 'escaped pattern characters');
	assert.deepEqual(domoNumberFormat('c!en_US!"$"#,##0'), currency(0), 'a locale tag');
	assert.deepEqual(domoNumberFormat('c"₹ "#,##0.0;"₹ "-#,##0.0'), currency(1, '₹'));
	assert.deepEqual(domoNumberFormat('n"$"#,##0;-"$"#,##0'), currency(0), 'a number format with a currency symbol');
	assert.deepEqual(domoNumberFormat('C1033%'), currency(2), 'Currency (Standard), en-US');
	assert.deepEqual(domoNumberFormat('C2057\\%'), currency(2, '£'));
	assert.deepEqual(domoNumberFormat('C9999%'), number(2), 'an unknown locale keeps the decimals, not a guessed symbol');
});

test('Tableau display units become abbreviation; a bare unit letter is text', () => {
	assert.deepEqual(domoNumberFormat('c"$"#,##0,K;("$"#,##0,K)'), currency(0, '$', true));
	assert.deepEqual(domoNumberFormat('c"$"#,##0,,.00M;("$"#,##0,,.00M)'), currency(2, '$', true));
	assert.deepEqual(domoNumberFormat('n#,##0,,.0M;-#,##0,,.0M'), number(1, true, { abbreviate: true }));
	assert.deepEqual(domoNumberFormat('[>=1000000]$0.0,,"M";[<=-1000000]($0.0,,"M");$#,##0'), { type: 'currency', format: '#.0', commas: false, percentMultiplied: true, precision: 1, currency: '$', abbreviate: true }, 'conditions are dropped, the first section is read');
	assert.deepEqual(domoNumberFormat('*#,##0.0K'), number(1), 'no scaling comma');
});

test('Tableau percent and plain number formats', () => {
	assert.deepEqual(domoNumberFormat('p0%'), percent(0));
	assert.deepEqual(domoNumberFormat('p0.0\\%'), percent(1));
	assert.deepEqual(domoNumberFormat('*+#,##0%;-#,##0%'), percent(0, true));
	assert.deepEqual(domoNumberFormat('n#,##0.0"%";-#,##0.0"%"'), percent(1, true, false), 'a literal percent sign is not multiplied');
	assert.deepEqual(domoNumberFormat('n#,##0;-#,##0'), number(0));
	assert.deepEqual(domoNumberFormat('n#,##0.00;-#,##0.00'), number(2));
	assert.deepEqual(domoNumberFormat('n0;-0'), PLAIN_INTEGER_FORMAT);
	assert.deepEqual(domoNumberFormat('n"Target: "#,##0" days";-"Target: "#,##0" days"'), number(0), 'other text is dropped');
});

test('formats Domo cannot express as a number format are left out', () => {
	for (const f of [undefined, '', 'N', 'S', 'iLLL', '*yyyy-mm-dd', '*mmm yyyy', '*"Q"Q', '*## days', 'e0.0000e+00']) assert.equal(domoNumberFormat(f), undefined, String(f));
});

test('a field column format: pill format, then the default format, then the plain integer format', () => {
	const year = { datatype: 'integer', role: 'dimension', kind: 'column' };
	assert.deepEqual(fieldColumnFormat(year), PLAIN_INTEGER_FORMAT);
	assert.deepEqual(fieldColumnFormat({ ...year, defaultFormat: 'n#,##0' }), number(0));
	assert.deepEqual(fieldColumnFormat({ ...year, defaultFormat: 'n#,##0' }, 'c"$"#,##0'), currency(0));
	assert.equal(fieldColumnFormat({ datatype: 'string', role: 'dimension', defaultFormat: 'n#,##0' }), undefined, 'not a number');
	assert.equal(fieldNumberFormat({ datatype: 'integer', role: 'dimension', kind: 'bin', defaultFormat: 'n#,##0' }), undefined, 'a bin');
	assert.equal(fieldColumnFormat({ datatype: 'real', role: 'measure' }), undefined, 'no Tableau format');
});

test('the negative section: parentheses, a minus sign, or neither', () => {
	assert.equal(negativeStyle('c"$"#,##0;("$"#,##0)'), 'parens', "SalesReview By End User's Bookings Amount");
	assert.equal(negativeStyle('c"$"#,##0;"$"(#,##0)'), 'parens', 'the symbol outside the parentheses');
	assert.equal(negativeStyle('c"$"\\#,\\#\\#0;("$"\\#,\\#\\#0)'), 'parens', 'escaped pattern characters');
	assert.equal(negativeStyle('c"$"#,##0.00;"$"-#,##0.00'), 'minus');
	assert.equal(negativeStyle('n#,##0,,.0M;-#,##0,,.0M'), 'minus');
	assert.equal(negativeStyle('p0.0%'), 'minus', 'no negative section');
	assert.equal(negativeStyle('#,##0;#,##0'), undefined, 'negatives without a sign');
	assert.equal(negativeStyle('[>=1000000]$0.0,,"M";[<=-1000000]($0.0,,"M");$#,##0'), undefined, 'conditional sections are not sign sections');
	assert.equal(negativeStyle('C1033%'), undefined);
	assert.equal(negativeStyle('e0.00'), undefined, 'no Domo format');
	assert.equal(domoNumberFormat('c"$"#,##0;("$"#,##0)').negative, undefined, 'the column format Domo stores has no negative key');
});
