import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldFromColumn, fieldFromGroup, parseParameters } from '../../src/tableau/twb/fields.js';
import { parseXml } from '../../src/tableau/twb/xml.js';

const col = (xml, existing) => fieldFromColumn(parseXml(xml), existing);

test('calculated fields decode formulas and descriptions', () => {
	const f = col(`<column caption='Size' datatype='string' name='[Calculation_1]' role='dimension' type='nominal'>
		<calculation class='tableau' formula='IF [Sales] &gt; 10 THEN &quot;Big&quot;&#13;&#10;ELSE &apos;Small&apos; END' />
		<desc><formatted-text><run>Order size</run></formatted-text></desc></column>`);
	assert.equal(f.kind, 'calculated');
	assert.equal(f.name, 'Size');
	assert.equal(f.formula, 'IF [Sales] > 10 THEN "Big"\nELSE \'Small\' END');
	assert.equal(f.description, 'Order size');
	assert.equal(f.physical, undefined);
});

test('declared columns merge onto metadata-record fields', () => {
	const existing = { id: '[State]', name: 'State', datatype: 'string', role: 'dimension', type: 'nominal', kind: 'column', physical: { tableId: 'Orders', remoteName: 'state' } };
	const f = col(`<column caption='State Name' datatype='string' hidden='true' name='[State]' role='dimension' semantic-role='[State].[Name]' type='nominal'><aliases><alias key='&quot;CA&quot;' value='California' /><alias key='%null%' value='Unknown' /></aliases></column>`, existing);
	assert.equal(f.name, 'State Name');
	assert.equal(f.hidden, true);
	assert.equal(f.semanticRole, '[State].[Name]');
	assert.deepEqual(f.aliases, { CA: 'California', '%null%': 'Unknown' });
	assert.deepEqual(f.physical, existing.physical);
});

test('count fields, Number of Records and internal fields', () => {
	assert.equal(col("<column caption='Orders' datatype='table' name='[__tableau_internal_object_id__].[Orders_1]' role='measure' type='quantitative' />").name, 'Orders (Count)');
	assert.equal(col("<column datatype='integer' name='[Number of Records]' role='measure' type='quantitative' user:auto-column='numrec'><calculation class='tableau' formula='1' /></column>").kind, 'count');
	assert.equal(col("<column datatype='real' name='[Number of Records]' role='measure' type='quantitative' user:auto-column='numrec' />").kind, 'count');
	assert.equal(col("<column datatype='string' name='[:Measure Names]' role='dimension' type='nominal' />"), null);
	assert.equal(col("<column datatype='real' name='[Multiple Values]' role='measure' />"), null);
	assert.equal(col("<column datatype='real' name='[Latitude (generated)]' role='measure' user:auto-column='latitude' />"), null);
	assert.equal(col("<column datatype='string' name='[__tableau_hidden]' />"), null);
	assert.equal(col("<column datatype='string' name='[:Measure Names]'><aliases><alias key='&quot;[ds].[sum:Sales:qk]&quot;' value='Total' /></aliases></column>").kind, 'measure-names');
});

test('bins with numeric and parameter sizes; categorical-bin groups with Other', () => {
	const bin = col("<column datatype='integer' name='[Sales (bin)]' role='dimension' type='ordinal'><calculation class='bin' decimals='0' formula='[Sales]' peg='0' size='100' /></column>");
	assert.deepEqual(bin.bin, { source: '[Sales]', size: 100, peg: 0 });
	assert.equal(col("<column name='[B]'><calculation class='bin' formula='[Profit]' size='[Parameters].[Bin Size]' /></column>").bin.size, '[Parameters].[Bin Size]');
	const group = col(`<column datatype='string' name='[Region (group)]' role='dimension' type='nominal'><calculation class='categorical-bin' column='[Region]' default='&quot;Other&quot;' new-bin='true'>
		<bin default-name='false' value='&quot;East+West&quot;'><value>&quot;East&quot;</value><value>&quot;West&quot;</value></bin>
		<bin value='1'><value>1</value><value>%null%</value></bin></calculation></column>`);
	assert.equal(group.kind, 'group');
	assert.deepEqual(group.group, { source: '[Region]', bins: [{ label: 'East+West', values: ['East', 'West'] }, { label: '1', values: [1, null] }], otherLabel: 'Other' });
});

test('sets from groupfilters: member lists, exclusions, conditions, top N, combined fields', () => {
	const instances = new Map([['[none:Customer:nk]', '[Customer Name]']]);
	const g = (xml) => fieldFromGroup(parseXml(xml), instances);
	const list = g("<group caption='VIPs' name='[VIPs]'><groupfilter function='union'><groupfilter function='member' level='[none:Customer:nk]' member='&quot;A&quot;' /><groupfilter function='member' level='[none:Customer:nk]' member='&quot;B&quot;' /></groupfilter></group>");
	assert.equal(list.kind, 'set');
	assert.equal(list.datatype, 'boolean');
	assert.deepEqual(list.set, { source: '[Customer Name]', members: ['A', 'B'] });
	const excl = g("<group name='[Not A]'><groupfilter function='except'><groupfilter function='level-members' level='[Region]' /><groupfilter function='member' level='[Region]' member='&quot;A&quot;' /></groupfilter></group>");
	assert.deepEqual(excl.set, { source: '[Region]', members: ['A'], exclude: true });
	const cond = g("<group name='[Profitable]'><groupfilter expression='SUM([Profit]) &gt; 0' function='filter'><groupfilter function='level-members' level='[none:Customer:nk]' /></groupfilter></group>");
	assert.deepEqual(cond.set, { source: '[Customer Name]', condition: 'SUM([Profit]) > 0' });
	const top = g("<group name='[Top]'><groupfilter count='5' end='bottom' function='end'><groupfilter direction='ASC' expression='SUM([Sales])' function='order'><groupfilter function='level-members' level='[none:Customer:nk]' /></groupfilter></groupfilter></group>");
	assert.deepEqual(top.set.top, { count: 5, direction: 'bottom', by: 'SUM([Sales])' });
	const all = g("<group caption='Channel Set' name='[Channel Set]' user:ui-builder='filter-group'><groupfilter function='level-members' level='[none:Customer:nk]' user:ui-enumeration='all' user:ui-marker='enumerate' /></group>");
	assert.deepEqual(all.set, { source: '[Customer Name]', all: true }, 'a set over all members holds every value');
	const combined = g("<group caption='A &amp; B' name='[A &amp; B]'><groupfilter function='crossjoin'><groupfilter function='level-members' level='[A]' /><groupfilter function='level-members' level='[none:Customer:nk]' /></groupfilter></group>");
	assert.equal(combined.kind, 'calculated');
	assert.equal(combined.formula, 'STR([A]) + ", " + STR([Customer Name])');
	assert.equal(g("<group name='[Action (Region)]' user:auto-column='sheet_link'><groupfilter function='level-members' level='[Region]' /></group>"), null);
	assert.equal(g("<group name='[Exclusions (A,B)]'><groupfilter function='crossjoin' /></group>"), null);
	const unknown = [];
	const union = fieldFromGroup(parseXml("<group caption='AllDays' name='[Set 1]'><groupfilter function='union'><groupfilter function='reference' name='[WeekDays]' /><groupfilter function='reference' name='[WeekEnd]' /></groupfilter></group>"), instances, unknown);
	assert.deepEqual(union.set, { source: '', unparsed: ['reference'] }, 'a union of other sets is marked, not read as every member');
	assert.deepEqual(unknown, ['reference', 'reference']);
});

test('parameters: range, list with aliases, any, dates and strings', () => {
	const params = parseParameters(
		parseXml(`<datasource hasconnection='false' inline='true' name='Parameters' version='18.1'>
		<column caption='Top N' datatype='integer' name='[Parameter 1]' param-domain-type='range' role='measure' type='quantitative' value='10'><calculation class='tableau' formula='10' /><range granularity='1' max='50' min='1' /></column>
		<column caption='Region' datatype='string' name='[Parameter 2]' param-domain-type='list' role='measure' type='nominal' value='&quot;East&quot;'>
			<calculation class='tableau' formula='&quot;East&quot;' />
			<aliases><alias key='&quot;East&quot;' value='E' /></aliases>
			<members><member value='&quot;East&quot;' /><member alias='W' value='&quot;West&quot;' /></members></column>
		<column caption='As Of' datatype='date' name='[Parameter 3]' param-domain-type='range' role='measure' type='quantitative' value='#2024-01-15#'><range granularity='1' max='#2024-12-31#' min='#2024-01-01#' period-type='month' /></column>
		<column caption='Note' datatype='string' name='[Parameter 4]' param-domain-type='any' role='measure' type='nominal'><calculation class='tableau' formula='&quot;hello&quot;' /></column>
		<column caption='Flag' datatype='boolean' name='[Parameter 5]' param-domain-type='list' role='measure' type='nominal' value='true' />
		<column caption='Code' datatype='string' name='[Parameter 6]' param-domain-type='list' value='42' />
	</datasource>`)
	);
	assert.deepEqual(params[0], { id: '[Parameters].[Parameter 1]', name: 'Top N', datatype: 'integer', domain: 'range', value: 10, range: { min: 1, max: 50, step: 1 } });
	assert.deepEqual(params[1].members, [{ value: 'East', alias: 'E' }, { value: 'West', alias: 'W' }]);
	assert.equal(params[1].value, 'East');
	assert.deepEqual(params[2].range, { min: '2024-01-01', max: '2024-12-31', step: '1 month' });
	assert.equal(params[2].value, '2024-01-15');
	assert.equal(params[3].domain, 'all');
	assert.equal(params[3].value, 'hello');
	assert.equal(params[4].value, true);
	assert.equal(params[5].value, '42');
});
