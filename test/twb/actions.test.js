import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, parseTslLink, urlTokens } from '../../src/tableau/twb/actions.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { parseXml } from '../../src/tableau/twb/xml.js';

const action = (xml) => parseAction(parseXml(xml));

test('filter action on all fields: trigger, target dashboard exclusions, clearing shows all or excludes all', () => {
	const a = action(`<action caption='Filter by Account' name='[Action14]'>
		<activation auto-clear='true' type='on-select' />
		<source dashboard='Tracking' type='sheet' worksheet='List of Accounts' />
		<command command='tsc:tsl-filter'>
			<param name='exclude' value='Title,List of Accounts' />
			<param name='on-empty' value='none' />
			<param name='special-fields' value='all' />
			<param name='target' value='Tracking' />
		</command>
	</action>`);
	assert.deepEqual(a, {
		id: '[Action14]',
		name: 'Filter by Account',
		type: 'filter',
		trigger: 'select',
		source: { type: 'sheet', dashboard: 'Tracking', worksheet: 'List of Accounts' },
		target: { name: 'Tracking', excludeSheets: ['Title', 'List of Accounts'] },
		allFields: true,
		clear: 'exclude-all'
	});
	const keep = action("<action caption='K' name='[A]'><activation type='on-hover' /><source type='sheet' worksheet='S' /><command command='tsc:tsl-filter'><param name='target' value='T' /></command></action>");
	assert.deepEqual([keep.trigger, keep.clear], ['hover', 'keep']);
	const menu = action("<action caption='M' name='[A]'><activation auto-clear='true' /><source type='sheet' worksheet='S' /><command command='tsc:tsl-filter'><param name='target' value='T' /></command></action>");
	assert.deepEqual([menu.trigger, menu.clear], ['menu', 'show-all']);
});

test('filter action on selected fields reads the field mapping from its tsl link', () => {
	const a = action(`<action caption='To Trend' name='[Action2]'>
		<activation auto-clear='true' type='on-select' />
		<source dashboard='Overview' type='sheet' worksheet='Accounts' />
		<link caption='To Trend' delimiter=',' escape='\\' expression='tsl:AU%20Trend?%5Bsqlproxy.b%5D.%5BOrgID%5D~s0=&lt;[sqlproxy.a].[org_id]~na&gt;&amp;%5Bsqlproxy.b%5D.%5BHealth%5D~s0=&lt;[sqlproxy.a].[Health]~na&gt;' include-null='true' multi-select='true' url-escape='true' />
		<command command='tsc:tsl-filter'>
			<param name='on-empty' value='none' />
			<param name='target' value='AU Trend' />
		</command>
	</action>`);
	assert.equal(a.type, 'filter');
	assert.equal(a.menuCaption, 'To Trend');
	assert.equal(a.allFields, undefined);
	assert.deepEqual(a.target, { name: 'AU Trend' });
	assert.deepEqual(a.fields, [
		{ source: '[sqlproxy.a].[org_id]', target: '[sqlproxy.b].[OrgID]' },
		{ source: '[sqlproxy.a].[Health]', target: '[sqlproxy.b].[Health]' }
	]);
	assert.equal(a.clear, 'exclude-all');
	assert.deepEqual(parseTslLink('tsl:Account%20Tracking?%5Bds%5D.%5BAccount%20Name%5D~s0=<[Account Name]~na>'), {
		target: 'Account Tracking',
		fields: [{ source: '[Account Name]', target: '[ds].[Account Name]' }]
	});
	assert.equal(parseTslLink('https://x'), undefined);
});

test('highlight action on selected fields keeps the field captions', () => {
	const a = action(`<action caption='Highlight1' name='[Action2_0]'>
		<activation auto-clear='true' type='on-select' />
		<source type='all' />
		<command command='tsc:brush'>
			<param name='field-captions' value='Measure Names,AGG(Color 1 day)' />
			<param name='target' value='Nurture' />
		</command>
	</action>`);
	assert.deepEqual([a.type, a.source, a.target, a.fieldCaptions, a.clear], ['highlight', { type: 'all' }, { name: 'Nurture' }, ['Measure Names', 'AGG(Color 1 day)'], 'show-all']);
});

test('URL actions: template tokens, scheme, encoding, multi-select, target and menu trigger', () => {
	const a = action(`<action caption='Go to Account' name='[Action15]'>
		<source dashboard='Tracking' type='sheet' worksheet='Accounts' />
		<link caption='Go to Account' expression='https://&lt;[Parameters].[Parameter 2]&gt;/r/Account/&lt;[Id (Account)]&gt;/view' url-escape='true'>
			<url-action-type>browser</url-action-type>
		</link>
	</action>`);
	assert.equal(a.type, 'url');
	assert.equal(a.trigger, 'menu');
	assert.deepEqual(a.url, {
		template: 'https://<[Parameters].[Parameter 2]>/r/Account/<[Id (Account)]>/view',
		tokens: ['[Parameters].[Parameter 2]', '[Id (Account)]'],
		scheme: 'https',
		encode: true,
		target: 'browser'
	});
	const multi = action("<action caption='Mail' name='[A]'><source datasource='sqlproxy.x' type='datasource' /><link caption='' delimiter=';' escape='\\' expression='mailto:&lt;[Email]&gt;' include-null='true' multi-select='true' /></action>");
	assert.deepEqual(multi.source, { type: 'datasource', datasource: 'sqlproxy.x' });
	assert.deepEqual(multi.url, { template: 'mailto:<[Email]>', tokens: ['[Email]'], scheme: 'mailto', multiSelect: true, delimiter: ';', escape: '\\', includeNull: true });
	assert.equal(action("<action caption='F' name='[A]'><source type='sheet' worksheet='S' /><link caption='' expression='&lt;ATTR([Calculation_1])&gt;' /></action>").url.scheme, '');
	assert.deepEqual(urlTokens('<[A]><[B]>x<[A]>'), ['[A]', '[B]']);
});

test('go to sheet, change parameter and change set value actions', () => {
	const nav = action(`<nav-action caption='Go to Overview' name='[Action46_2708]'>
		<activation type='on-select' />
		<source dashboard='Space Usage' type='sheet' worksheet='Back Button' />
		<params><param name='sheet' value='Overview' /></params>
	</nav-action>`);
	assert.deepEqual([nav.type, nav.trigger, nav.target, nav.source.worksheet], ['navigate', 'select', { name: 'Overview' }, 'Back Button']);

	const param = action(`<edit-parameter-action caption='Parameter1' name='[Action6_25A1]'>
		<activation type='on-select' />
		<source dashboard='Summary' type='sheet' worksheet='Details' />
		<agg-type type='max' />
		<clear-option type='assign-fixed-value' value='s:ROOT:' />
		<params>
			<param name='source-field' value='[sqlproxy.x].[attr:Contract ID:nk]' />
			<param name='target-parameter' value='[Parameters].[Parameter 2]' />
		</params>
	</edit-parameter-action>`);
	assert.deepEqual(param.parameter, {
		target: '[Parameters].[Parameter 2]',
		sourceField: '[Contract ID]',
		sourcePill: '[sqlproxy.x].[attr:Contract ID:nk]',
		aggregation: 'max',
		clear: { type: 'assign-fixed-value', value: 'ROOT:' }
	});
	const toggle = action("<edit-parameter-action caption='T' name='[A]'><activation type='on-select' /><source type='sheet' worksheet='S' /><clear-option type='do-nothing' value='b:false' /><params><param name='target-parameter' value='[Parameters].[P]' /></params></edit-parameter-action>");
	assert.deepEqual(toggle.parameter.clear, { type: 'do-nothing', value: false });

	const set = action(`<edit-group-action caption='BOT SET' name='[Action3_80CC]'>
		<activation type='on-hover' />
		<source type='sheet' worksheet='Engagement' />
		<add-or-remove-marks value='assign' />
		<params>
			<param name='selection-clear-set-option' value='exclude-all' />
			<param name='target-group' value='[sqlproxy.x].[Engagement Set]' />
		</params>
	</edit-group-action>`);
	assert.deepEqual([set.type, set.trigger, set.set], ['set', 'hover', { target: '[sqlproxy.x].[Engagement Set]', mode: 'assign', clear: 'exclude-all' }]);
	assert.equal(action("<datasources />"), undefined);
});

test('the workbook IR lists actions with resolved source sheets and target kinds, and keeps filterActions', () => {
	const xml = `<?xml version='1.0'?><workbook>
	<actions>
		<action caption='Open' name='[A1]'>
			<source dashboard='One' type='sheet'><exclude-sheet name='B' /></source>
			<link caption='Open' expression='https://x.test/&lt;[Id]&gt;' />
		</action>
		<action caption='Go' name='[A2]'>
			<activation auto-clear='true' type='on-select' />
			<source dashboard='One' type='sheet' worksheet='A' />
			<command command='tsc:tsl-filter'><param name='exclude' value='C' /><param name='special-fields' value='all' /><param name='target' value='Two' /></command>
		</action>
		<nav-action caption='Back' name='[A3]'><activation type='on-select' /><source dashboard='Two' type='sheet' /><params><param name='sheet' value='None' /></params></nav-action>
		<datasources><datasource name='Parameters' /></datasources>
	</actions>
	<worksheets><worksheet name='A' /><worksheet name='B' /><worksheet name='C' /></worksheets>
	<dashboards>
		<dashboard name='One'><zones><zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'><zone id='2' name='A' x='0' y='0' w='50000' h='100000' /><zone id='3' name='B' x='50000' y='0' w='50000' h='100000' /></zone></zones></dashboard>
		<dashboard name='Two'><zones><zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'><zone id='2' name='A' x='0' y='0' w='50000' h='100000' /><zone id='3' name='C' x='50000' y='0' w='50000' h='100000' /></zone></zones></dashboard>
	</dashboards>
	</workbook>`;
	const ir = buildWorkbookIR(xml);
	assert.deepEqual(ir.actions.map((a) => [a.id, a.type, a.trigger, a.source.worksheets, a.target?.kind]), [
		['[A1]', 'url', 'menu', ['A'], undefined],
		['[A2]', 'filter', 'select', ['A'], 'dashboard'],
		['[A3]', 'navigate', 'select', ['A', 'C'], undefined]
	]);
	assert.deepEqual(ir.actions[1].target, { name: 'Two', excludeSheets: ['C'], kind: 'dashboard', worksheets: ['A'] });
	assert.deepEqual(ir.filterActions, [{ name: 'Go', sourceDashboard: 'One', target: 'Two' }]);
	assert.deepEqual(ir.issues.map((i) => i.code), ['twb.url-action', 'twb.filter-action', 'twb.navigation-action']);
});
