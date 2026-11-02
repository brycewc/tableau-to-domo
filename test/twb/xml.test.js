import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, formattedText, normalizeName, parseDateLiteral, parseLiteral, parseXml, sniffRootName } from '../../src/tableau/twb/xml.js';

test('normalizeName keeps the true variant and drops the false variant', () => {
	assert.equal(normalizeName('_.fcp.ObjectModelEncapsulateLegacy.true...relation'), 'relation');
	assert.equal(normalizeName('_.fcp.ObjectModelEncapsulateLegacy.false...relation'), null);
	assert.equal(normalizeName('_.fcp.A.true..._.fcp.B.true...object-graph'), 'object-graph');
	assert.equal(normalizeName('_.fcp.A.true..._.fcp.B.false...x'), null);
	assert.equal(normalizeName('zone'), 'zone');
});

test('parseXml strips feature prefixes on elements and attributes', () => {
	const root = parseXml(`<w>
		<_.fcp.F.false...relation name='old' />
		<_.fcp.F.true...relation name='new' />
		<zone _.fcp.S.false...type='layout-basic' _.fcp.S.true...type-v2='layout-flow' type-v2='ignored' />
	</w>`);
	const relations = root.all('relation');
	assert.equal(relations.length, 1);
	assert.equal(relations[0].attr('name'), 'new');
	const zone = root.child('zone');
	assert.equal(zone.attr('type'), undefined);
	assert.equal(zone.attr('type-v2'), 'layout-flow');
});

test('parseXml decodes entities exactly once and keeps CDATA raw', () => {
	const root = parseXml(`<c formula='IF [A] &gt; 1&#10;THEN &quot;x&quot; &amp;amp; &apos;y&apos; END'><t><![CDATA[a &lt; b]]></t><r>&#x41;&#13;&#10;</r></c>`);
	assert.equal(root.attr('formula'), 'IF [A] > 1\nTHEN "x" &amp; \'y\' END');
	assert.equal(root.child('t').text, 'a &lt; b');
	assert.equal(root.child('r').text, 'A\r\n');
});

test('parseXml rejects DOCTYPE and invalid XML', () => {
	assert.throws(() => parseXml("<?xml version='1.0'?><!DOCTYPE x [<!ENTITY e 'boom'>]><x>&e;</x>"), /DOCTYPE/);
	assert.throws(() => parseXml('<a><b></a>'), /Invalid Tableau XML/);
});

test('path, pathAll, descendants, childText', () => {
	const root = parseXml('<a><b><c>1</c></b><b><c> 2 </c></b></a>');
	assert.equal(root.path('b/c').text, '1');
	assert.deepEqual(root.pathAll('b/c').map((n) => n.text), ['1', ' 2 ']);
	assert.equal(root.descendants('c').length, 2);
	assert.equal(root.all('b')[1].childText('c'), '2');
});

test('decodeEntities leaves unknown entities alone', () => {
	assert.equal(decodeEntities('a &nbsp; &#999999999; &lt;'), 'a &nbsp; &#999999999; <');
});

test('parseLiteral handles strings, dates, nulls, numbers and booleans', () => {
	assert.equal(parseLiteral('"East"'), 'East');
	assert.equal(parseLiteral('"He said ""hi"""'), 'He said "hi"');
	assert.equal(parseLiteral("'x'"), 'x');
	assert.equal(parseLiteral('#2023-01-31#'), '2023-01-31');
	assert.equal(parseLiteral('#2023-01-31 9:05:00#'), '2023-01-31T09:05:00');
	assert.equal(parseLiteral('%null%'), null);
	assert.equal(parseLiteral('\\%null\\%'), null);
	assert.equal(parseLiteral('"Contraction >= 80\\%"'), 'Contraction >= 80%');
	assert.equal(parseLiteral('"\\#NAME?"'), '#NAME?');
	assert.equal(parseLiteral('"Developments \\\\"'), 'Developments \\');
	assert.equal(parseLiteral('42'), 42);
	assert.equal(parseLiteral('50000.'), 50000);
	assert.equal(parseLiteral('-1.5e3'), -1500);
	assert.equal(parseLiteral('12345678901234567890'), '12345678901234567890');
	assert.equal(parseLiteral('true'), true);
	assert.equal(parseLiteral('FALSE'), false);
	assert.equal(parseLiteral(undefined), undefined);
	assert.equal(parseDateLiteral('2020-02-03 10:11'), '2020-02-03T10:11:00');
});

test('formattedText joins runs, handles paragraph markers and placeholders', () => {
	const root = parseXml("<title><formatted-text><run>&lt;Sheet Name&gt;</run><run> for </run><run>2023</run><run>Æ&#10;</run><run>Second</run></formatted-text></title>");
	assert.equal(formattedText(root, { 'Sheet Name': 'Sales' }), 'Sales for 2023\nSecond');
	assert.equal(formattedText(parseXml('<zone />')), undefined);
});

test('sniffRootName skips declarations and comments', () => {
	assert.equal(sniffRootName("﻿<?xml version='1.0'?>\n<!-- build -->\n<workbook version='18.1'>"), 'workbook');
	assert.equal(sniffRootName('<_.fcp.X.true...datasource />'), 'datasource');
	assert.equal(sniffRootName('no xml'), undefined);
});
