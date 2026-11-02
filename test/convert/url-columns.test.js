import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hyperlinkFormula, nativeLinkFormat, parseUrlToken, pickLinkColumn, templateParts, urlActionSheets, withScheme } from '../../src/convert/url-columns.js';

const ir = {
	parameters: [{ id: '[Parameters].[Org]', value: 'acme co' }],
	worksheets: [
		{ name: 'A', datasourceIds: ['ds1'] },
		{ name: 'B', datasourceIds: ['ds1'] },
		{ name: 'C', datasourceIds: ['ds2'] }
	]
};

test('URL tokens: parameters, plain and qualified fields, aggregations Tableau writes around a field', () => {
	assert.deepEqual(parseUrlToken('[Parameters].[Org]', ir), { parameter: ir.parameters[0] });
	assert.equal(parseUrlToken('[Parameters].[Gone]', ir), undefined);
	assert.deepEqual(parseUrlToken('[Case Id]', ir), { fieldId: '[Case Id]' });
	assert.deepEqual(parseUrlToken('[ds1].[Lead ID]', ir), { datasourceId: 'ds1', fieldId: '[Lead ID]' });
	assert.deepEqual(parseUrlToken('ATTR([Case_ID])', ir), { fieldId: '[Case_ID]', aggregation: 'MAX' });
	assert.equal(parseUrlToken('MEDIAN([Sales])', ir), undefined);
});

test('a URL action starts from its sheets on any dashboard: a datasource action from every sheet of it but the excluded', () => {
	assert.deepEqual(urlActionSheets({ source: { type: 'datasource', datasource: 'ds1', excludeSheets: ['B'] } }, ir), ['A']);
	assert.deepEqual(urlActionSheets({ source: { type: 'sheet', dashboard: 'D', worksheets: ['A', 'C'] } }, ir), ['A', 'C']);
	assert.deepEqual(urlActionSheets({ source: { type: 'sheet', worksheet: 'C' } }, ir), ['C']);
	assert.deepEqual(urlActionSheets({ source: { type: 'all' } }, ir), ['A', 'B', 'C']);
});

test('templates split into text and tokens; a host without a scheme gets https', () => {
	assert.deepEqual(templateParts('https://x.test/items/<[Id]>/view'), [{ text: 'https://x.test/items/' }, { token: '[Id]' }, { text: '/view' }]);
	assert.deepEqual(templateParts('<[Url]>'), [{ token: '[Url]' }]);
	assert.deepEqual(withScheme('x.test/<[Id]>'), { template: 'https://x.test/<[Id]>', schemeAdded: true });
	assert.deepEqual(withScheme('mailto:<[Email]>'), { template: 'mailto:<[Email]>', schemeAdded: false });
});

test('the link column: an underlined header, then the token column, then a column the token derives from, then the first text column', () => {
	const cols = [
		{ pillId: 'p:date', fieldId: '[Date View]', text: false },
		{ pillId: 'p:name', fieldId: '[Name]', text: true },
		{ pillId: 'p:uid', fieldId: '[UNIQUEID]', text: true },
		{ pillId: 'p:num', fieldId: '[Number]', text: true }
	];
	const none = new Set();
	const pick = (hints) => {
		const r = pickLinkColumn(cols, { tokenFields: none, derivedFields: none, ...hints });
		return r && [r.candidate.fieldId, r.reason];
	};
	assert.deepEqual(pick({ linkStyled: ['p:uid'], tokenFields: new Set(['[Number]']) }), ['[UNIQUEID]', 'underline']);
	assert.deepEqual(pick({ tokenFields: new Set(['[Number]']), derivedFields: new Set(['[UNIQUEID]']) }), ['[Number]', 'token']);
	assert.deepEqual(pick({ derivedFields: new Set(['[UNIQUEID]']) }), ['[UNIQUEID]', 'derived']);
	assert.deepEqual(pick({}), ['[Name]', 'first'], 'a date column is never the fallback');
	assert.equal(pickLinkColumn([cols[0]], { tokenFields: none, derivedFields: none }), undefined);
});

test('the native link column format takes https://prefix + the cell value + suffix, with no other token or encoding', () => {
	const id = { token: '[Id]', field: { fieldId: '[Id]' } };
	assert.deepEqual(nativeLinkFormat([{ text: 'https://x.test/items/' }, id, { text: '/view' }], '[Id]'), { displayType: 'link', displayPrefix: 'https://x.test/items/', displaySuffix: '/view', displayLabel: '' });
	assert.equal(nativeLinkFormat([{ text: 'http://x.test/items/' }, id], '[Id]'), undefined, 'Phoenix links https only');
	assert.equal(nativeLinkFormat([{ text: 'https://x.test/items/' }, id], '[Id]', { encode: true }), undefined);
	assert.equal(nativeLinkFormat([{ text: 'https://x.test/' }, id, { text: '/' }, { token: '[Org]', value: 'a' }], '[Id]'), undefined);
	assert.equal(nativeLinkFormat([{ text: 'https://x.test/' }, id], '[Name]'), undefined, 'the cell shows another field');
	assert.equal(nativeLinkFormat([{ text: 'https://x.test/' }, { token: 'ATTR([Id])', field: { fieldId: '[Id]', aggregation: 'MAX' } }], '[Id]'), undefined);
});

test('hyperlink Beast Mode: the label names and shows the link, the token builds the href, a null token shows the label', () => {
	const formula = hyperlinkFormula({ label: '`Uniqueid`', parts: [{ text: 'https://tracker.example.com/items/' }, { sql: '(SUBSTRING(`Uniqueid`, 4, 10))' }] });
	assert.equal(
		formula,
		"CASE WHEN (SUBSTRING(`Uniqueid`, 4, 10)) IS NULL THEN `Uniqueid` ELSE CONCAT('<a name=\"', REPLACE(`Uniqueid`, '\"', ''), '\" href=\"https://tracker.example.com/items/', REPLACE((SUBSTRING(`Uniqueid`, 4, 10)), '\"', '%22'), '\" target=\"_blank\">', `Uniqueid`, '</a>') END"
	);
	const aggregated = hyperlinkFormula({ label: 'MAX(`CaseNumber`)', parts: [{ text: 'https://crm.test/Case/' }, { sql: 'MAX(`Case_ID`)' }, { text: '/view' }] });
	assert.match(aggregated, /^CASE WHEN MAX\(`Case_ID`\) IS NULL THEN MAX\(`CaseNumber`\) ELSE CONCAT\(.*'\/view" target="_blank">', MAX\(`CaseNumber`\), '<\/a>'\) END$/);
});

test('hyperlink Beast Mode: url encoding, parameters as constants, include-null, quotes in static text, mailto', () => {
	const encoded = hyperlinkFormula({ label: '`Name`', parts: [{ text: 'https://x.test/?q=' }, { sql: '`Name`' }, { text: '&org=' }, { value: 'acme co' }], encode: true });
	assert.match(encoded, /^CASE WHEN `Name` IS NULL THEN/);
	assert.ok(encoded.includes("REPLACE(REPLACE(`Name`, '%', '%25'), ' ', '%20')"), 'percent first, so the escapes are not escaped again');
	assert.ok(encoded.includes("'&org=acme%20co\" target"), 'a parameter is its current value, encoded like Tableau');
	const nulls = hyperlinkFormula({ label: '`Name`', parts: [{ text: 'https://x.test/' }, { sql: '`Id`' }], includeNull: true });
	assert.ok(!nulls.startsWith('CASE') && nulls.includes("REPLACE(IFNULL(`Id`, ''), '\"', '%22')"));
	assert.ok(hyperlinkFormula({ label: '`N`', parts: [{ text: 'https://x.test/"a"/' }, { sql: '`Id`' }] }).includes("href=\"https://x.test/%22a%22/'"));
	assert.ok(hyperlinkFormula({ label: '`N`', parts: [{ text: "mailto:" }, { sql: '`Email`' }, { text: "?subject=It's" }] }).includes("href=\"mailto:', REPLACE(`Email`, '\"', '%22'), '?subject=It''s\" target"));
	assert.match(hyperlinkFormula({ label: "'Open'", parts: [{ text: 'https://x.test/' }, { sql: '`Id`' }], whenNull: 'NULLIF(1, 1)' }), /^CASE WHEN `Id` IS NULL THEN NULLIF\(1, 1\) ELSE/);
});
