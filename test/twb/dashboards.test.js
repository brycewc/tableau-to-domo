import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerZones, parseDashboard } from '../../src/tableau/twb/dashboards.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { parseXml } from '../../src/tableau/twb/xml.js';

const dash = (xml) => parseDashboard(parseXml(xml));

test('size modes', () => {
	assert.deepEqual(dash("<dashboard name='a'><size maxheight='800' maxwidth='1000' minheight='800' minwidth='1000' /></dashboard>").size, { mode: 'fixed', width: 1000, height: 800 });
	assert.deepEqual(dash("<dashboard name='a'><size sizing-mode='automatic' /></dashboard>").size, { mode: 'automatic' });
	assert.deepEqual(dash("<dashboard name='a' />").size, { mode: 'automatic' });
	assert.deepEqual(dash("<dashboard name='a'><size maxheight='900' maxwidth='1600' minheight='600' minwidth='800' /></dashboard>").size, { mode: 'range', width: 1600, height: 900 });
});

test('tiled containers flatten to leaves with fractional rects and kinds', () => {
	const d = dash(`<dashboard name='D'><zones>
		<zone _.fcp.S.false...type='layout-basic' _.fcp.S.true...type-v2='layout-basic' h='100000' id='1' w='100000' x='0' y='0'>
			<zone h='100000' id='2' param='vert' type-v2='layout-flow' w='100000' x='0' y='0'>
				<zone h='10000' id='3' type-v2='title' w='100000' x='0' y='0' />
				<zone h='45000' id='4' name='Sheet 1' w='50000' x='0' y='10000'><zone-style /></zone>
				<zone h='45000' id='5' name='Sheet 1' param='[ds].[none:Region:nk]' type='filter' mode='radiolist' w='50000' x='50000' y='10000' />
				<zone h='5000' id='6' param='[Parameters].[P1]' type-v2='paramctrl' mode='typein' w='25000' x='0' y='55000' />
				<zone h='5000' id='7' name='Sheet 1' param='[ds].[sum:Sales:qk]' type-v2='size' w='25000' x='25000' y='55000' />
				<zone h='5000' id='8' type-v2='shape' name='Sheet 1' w='1' x='0' y='0' />
				<zone h='5000' id='9' type-v2='map' name='Sheet 1' w='1' x='0' y='0' />
				<zone h='5000' id='10' type-v2='text' w='1' x='0' y='0'><formatted-text><run>Hello </run><run bold='true'>world</run></formatted-text></zone>
				<zone h='5000' id='11' type-v2='empty' w='1' x='0' y='0' />
				<zone h='5000' id='12' type-v2='highlighter' w='1' x='0' y='0' />
				<zone h='5000' id='13' type-v2='layout-flow' w='1' x='0' y='0' />
				<zone h='5000' id='14' type-v2='web' url='https://x.test' w='1' x='0' y='0' />
				<zone h='5000' id='15' type='bitmap' param='Image/a.png' w='200000' x='-5' y='0' />
			</zone>
		</zone></zones></dashboard>`);
	assert.deepEqual(d.zones.map((z) => [z.id, z.kind]), [
		['3', 'title'], ['4', 'worksheet'], ['5', 'filter'], ['6', 'paramctrl'], ['7', 'legend'], ['8', 'legend'], ['9', 'legend'],
		['10', 'text'], ['11', 'blank'], ['12', 'other'], ['14', 'web'], ['15', 'image']
	]);
	assert.equal(d.zones[0].text, 'D');
	assert.deepEqual(d.zones[1].rect, { x: 0, y: 0.1, w: 0.5, h: 0.45 });
	assert.equal(d.zones[1].worksheet, 'Sheet 1');
	assert.deepEqual([d.zones[2].param, d.zones[2].mode, d.zones[2].worksheet], ['[ds].[none:Region:nk]', 'radiolist', 'Sheet 1']);
	assert.deepEqual([d.zones[3].param, d.zones[3].mode], ['[Parameters].[P1]', 'typein']);
	assert.equal(d.zones[4].param, '[ds].[sum:Sales:qk]');
	assert.equal(d.zones[7].text, 'Hello world');
	assert.equal(d.zones[10].url, 'https://x.test');
	assert.equal(d.zones[11].url, 'Image/a.png');
	assert.deepEqual(d.zones[11].rect, { x: 0, y: 0, w: 1, h: 0.05 });
	assert.equal(d.floating.length, 0);
});

test('a parameter control keeps its custom title (a "Granularity" selector)', () => {
	const d = dash(`<dashboard name='D'><zones>
		<zone h='100000' id='1' param='vert' type-v2='layout-flow' w='100000' x='0' y='0'>
			<zone custom-title='true' h='5000' id='2' mode='compact' param='[Parameters].[Parameter 2]' type-v2='paramctrl' w='25000' x='0' y='0'><formatted-text><run fontsize='8'>Granularity</run></formatted-text></zone>
			<zone custom-title='true' h='5000' id='3' param='[Parameters].[Parameter 3]' type-v2='paramctrl' w='25000' x='0' y='5000'><formatted-text><run /></formatted-text></zone>
			<zone h='5000' id='4' param='[Parameters].[Parameter 4]' type-v2='paramctrl' w='25000' x='0' y='10000'><formatted-text><run>Ignored</run></formatted-text></zone>
		</zone></zones></dashboard>`);
	assert.deepEqual(d.zones.map((z) => z.title), ['Granularity', undefined, undefined]);
});

test('floating zones: later root zones, is-floating, and dashboards with no tiled root', () => {
	const d = dash(`<dashboard name='D'><zones>
		<zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'>
			<zone h='50000' id='2' name='A' w='100000' x='0' y='0' />
			<zone h='10000' id='3' is-floating='true' name='B' w='10000' x='0' y='0' />
		</zone>
		<zone h='20000' id='4' name='C' w='20000' x='80000' y='0' />
		<zone h='20000' id='5' param='horz' type-v2='layout-flow' w='20000' x='0' y='80000'><zone h='20000' id='6' type-v2='text' w='20000' x='0' y='80000'><formatted-text><run>Note</run></formatted-text></zone></zone>
	</zones><devicelayouts><devicelayout name='Phone'><zones><zone id='99' name='A' /></zones></devicelayout></devicelayouts></dashboard>`);
	assert.deepEqual(d.zones.map((z) => z.id), ['2']);
	assert.deepEqual(d.floating.map((z) => [z.id, z.kind, z.floating]), [['3', 'worksheet', true], ['4', 'worksheet', true], ['6', 'text', true]]);
	const allFloating = dash("<dashboard name='S'><zones><zone h='1' id='7' param='C:/a.jpg' type='bitmap' w='1' x='0' y='0' /><zone id='8' type='text' x='0' y='0' w='1' h='1'><formatted-text><run>T</run></formatted-text></zone></zones></dashboard>");
	assert.equal(allFloating.zones.length, 0);
	assert.deepEqual(allFloating.floating.map((z) => z.kind), ['image', 'text']);
});

test('an image zone keeps its package path and how Tableau fits it', () => {
	const d = dash(`<dashboard name='S'><zones><zone h='100000' id='1' type-v2='layout-flow' param='vert' w='100000' x='0' y='0'>
		<zone h='10000' id='2' type-v2='bitmap' param='Image/banner.png' is-centered='0' w='100000' x='0' y='0' />
		<zone h='10000' id='3' type-v2='bitmap' param='Image/logo.png' is-scaled='1' w='50000' x='0' y='10000' />
		<zone h='10000' id='4' type-v2='bitmap' param='Image/c.png' is-centered='1' w='50000' x='50000' y='10000' />
	</zone></zones></dashboard>`);
	assert.deepEqual(d.zones.map((z) => [z.id, z.kind, z.url, z.fit]), [['2', 'image', 'Image/banner.png', 'none'], ['3', 'image', 'Image/logo.png', 'fit'], ['4', 'image', 'Image/c.png', 'center']]);
});

test('a dashboard with no tiled root whose root zones do not overlap is tiled (account-summary)', () => {
	const d = dash(`<dashboard name='Summary'><zones>
		<zone h='87001' id='3' name='Tenure' w='46817' x='1000' y='11666'><zone-style /></zone>
		<zone h='10333' id='17' param='horz' type-v2='layout-flow' w='98000' x='1000' y='1333'>
			<zone h='10333' id='8' mode='checkdropdown' name='Tenure' param='[ds].[none:PRODUCT:nk]' type-v2='filter' values='database' w='10888' x='1000' y='1333' />
			<zone h='10333' id='25' mode='compact' param='[Parameters].[Parameter 4]' type-v2='paramctrl' w='10896' x='88104' y='1333' />
		</zone>
		<zone h='87001' id='22' name='Partition' w='51183' x='47817' y='11666' />
	</zones></dashboard>`);
	assert.deepEqual(d.zones.map((z) => [z.id, z.kind, z.floating]), [['3', 'worksheet', false], ['8', 'filter', false], ['25', 'paramctrl', false], ['22', 'worksheet', false]]);
	assert.equal(d.zones[1].values, 'database', "the quick filter's domain");
	assert.equal(d.floating.length, 0);
});

test('containers keep their tree, direction, distribute evenly, name, style and hidden state', () => {
	const d = dash(`<dashboard name='D'><zones>
		<zone h='100000' id='4' type-v2='layout-basic' w='100000' x='0' y='0'>
			<zone h='98000' id='5' param='vert' type-v2='layout-flow' w='98400' x='800' y='1000'>
				<zone h='6000' id='7' layout-strategy-id='distribute-evenly' param='horz' type-v2='layout-flow' w='98400' x='800' y='1000'>
					<zone h='6000' id='8' name='KPI' w='49200' x='800' y='1000' />
					<zone h='6000' id='9' name='KPI 2' show-title='false' w='49200' x='50000' y='1000' />
					<zone-style><format attr='border-color' value='#000000' /><format attr='border-style' value='none' /><format attr='border-width' value='0' /><format attr='margin' value='4' /><format attr='padding' value='8' /><format attr='background-color' value='#f5f5f5' /></zone-style>
				</zone>
				<zone friendly-name='Trend panel' h='30000' hidden-by-user='true' id='184' param='vert' type-v2='layout-flow' w='98400' x='800' y='7000'>
					<zone h='30000' id='186' name='Trend' w='98400' x='800' y='7000'><zone-style><format attr='border-style' value='solid' /><format attr='border-width' value='1' /><format attr='border-color' value='#cccccc' /><format attr='margin-top' value='2' /><format attr='margin' value='4' /></zone-style></zone>
				</zone>
			</zone>
		</zone>
	</zones></dashboard>`);
	assert.deepEqual(d.roots, ['4']);
	assert.deepEqual(d.containers.map((c) => [c.id, c.layout, c.direction, c.parent, c.children]), [
		['4', 'basic', undefined, undefined, ['5']],
		['5', 'flow', 'vertical', '4', ['7', '184']],
		['7', 'flow', 'horizontal', '5', ['8', '9']],
		['184', 'flow', 'vertical', '5', ['186']]
	]);
	const row = d.containers[2];
	assert.equal(row.distributeEvenly, true);
	assert.deepEqual(row.style, { background: '#f5f5f5', margin: 4, padding: 8 });
	const panel = d.containers[3];
	assert.deepEqual([panel.name, panel.hidden], ['Trend panel', true]);
	assert.deepEqual(d.zones.map((z) => [z.id, z.parent, Boolean(z.hidden), z.showTitle]), [['8', '7', false, undefined], ['9', '7', false, false], ['186', '184', true, undefined]]);
	assert.deepEqual(d.zones[2].style, { border: { style: 'solid', width: 1, color: '#cccccc' }, margin: { top: 2, right: 4, bottom: 4, left: 4 } });
	assert.deepEqual(containerZones(d, '5').map((z) => z.id), ['8', '9', '186']);
	assert.deepEqual(containerZones(d, '8').map((z) => z.id), ['8']);
});

test('navigation, show/hide and download buttons', () => {
	const d = dash(`<dashboard name='D'><zones><zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'>
		<zone fixed-size='36' h='1222' id='1089' is-fixed='true' type-v2='dashboard-object' w='20250' x='667' y='41138'>
			<button action='tabdoc:goto-sheet window-id=&quot;{799C3844-5C50-413E-BD06-D1E5333513C7}&quot;' button-type='text'>
				<button-visual-state>
					<caption>Quotes &amp; Summary</caption>
					<button-caption-font-style bold='true' fontcolor='#ffffff' fontname='Verdana' fontsize='8' />
					<format attr='background-color' value='#4e79a7' />
					<format attr='border-style' value='solid' />
					<format attr='border-width' value='1' />
					<format attr='border-color' value='#000000' />
				</button-visual-state>
			</button>
		</zone>
		<zone h='3333' id='152' type-v2='dashboard-object' w='3125' x='62937' y='68047'>
			<button action=''>
				<toggle-action>tabdoc:toggle-button-click-action window-id=&quot;{BC07A3EF-F2E9-4AB1-AC11-A310CAF1CDA1}&quot; zone-id=&quot;152&quot; zone-ids=[147]</toggle-action>
				<button-visual-state><image-path>Image/switch-right.png</image-path></button-visual-state>
				<button-visual-state><image-path>Image/switch-left.png</image-path></button-visual-state>
			</button>
		</zone>
		<zone h='3250' id='289' type-v2='dashboard-object' w='1800' x='3800' y='34250'>
			<button action='' active-visual-state-index='1'>
				<toggle-action>tabdoc:toggle-button-click-action window-id=&quot;{B3DD}&quot; zone-id=&quot;289&quot; zone-ids=[288]</toggle-action>
				<button-visual-state><tooltip-text>Click to close the trend</tooltip-text></button-visual-state>
				<button-visual-state><tooltip-text>Click to view the trend</tooltip-text></button-visual-state>
			</button>
		</zone>
		<zone h='3250' id='300' type-v2='dashboard-object' w='1800' x='0' y='0'><button action='tabdoc:export-pdf' button-type='text'><button-visual-state><caption>Download</caption></button-visual-state></button></zone>
	</zone></zones></dashboard>`);
	assert.deepEqual(d.zones.map((z) => [z.id, z.kind, z.button.action, z.button.style]), [
		['1089', 'button', 'navigate', 'text'],
		['152', 'button', 'toggle', 'image'],
		['289', 'button', 'toggle', 'default'],
		['300', 'button', 'download', 'text']
	]);
	assert.deepEqual(d.zones[0].button, {
		action: 'navigate',
		style: 'text',
		states: [{ caption: 'Quotes & Summary', font: { fontName: 'Verdana', fontSize: 8, color: '#ffffff', bold: true }, style: { background: '#4e79a7', border: { style: 'solid', width: 1, color: '#000000' } } }],
		target: { windowId: '{799C3844-5C50-413E-BD06-D1E5333513C7}' }
	});
	assert.equal(d.zones[0].fixedSize, 36);
	assert.deepEqual(d.zones[1].button.toggle, { zoneIds: ['147'] });
	assert.deepEqual([d.zones[2].button.activeState, d.zones[2].button.states.map((s) => s.tooltip)], [1, ['Click to close the trend', 'Click to view the trend']]);
	assert.deepEqual([d.zones[3].button.exportFormat, d.zones[3].button.command], ['pdf', 'tabdoc:export-pdf']);
});

test('the workbook resolves navigation button targets and the initial state of show/hide buttons', () => {
	const ir = buildWorkbookIR(`<?xml version='1.0'?><workbook>
	<worksheets><worksheet name='Trend'><simple-id uuid='{55555555-0000-0000-0000-000000000000}' /></worksheet></worksheets>
	<dashboards>
		<dashboard name='Home'><zones><zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'>
			<zone h='5000' id='2' type-v2='dashboard-object' w='10000' x='0' y='0'><button action='tabdoc:goto-sheet window-id=&quot;{11111111-0000-0000-0000-000000000000}&quot;' button-type='text'><button-visual-state><caption>Details</caption></button-visual-state></button></zone>
			<zone h='5000' id='3' type-v2='dashboard-object' w='10000' x='0' y='0'><button action='tabdoc:goto-sheet window-id=&quot;{55555555-0000-0000-0000-000000000000}&quot;' /></zone>
			<zone h='5000' id='4' type-v2='dashboard-object' w='10000' x='0' y='0'><button action='tabdoc:goto-sheet window-id=&quot;{99999999-0000-0000-0000-000000000000}&quot;' /></zone>
			<zone h='5000' id='5' type-v2='dashboard-object' w='10000' x='0' y='0'><button action=''><toggle-action>tabdoc:toggle-button-click-action zone-id=&quot;5&quot; zone-ids=[6]</toggle-action></button></zone>
			<zone h='5000' id='7' type-v2='dashboard-object' w='10000' x='0' y='0'><button action=''><toggle-action>tabdoc:toggle-button-click-action zone-id=&quot;7&quot; zone-ids=[8]</toggle-action></button></zone>
			<zone h='50000' hidden-by-user='true' id='6' param='vert' type-v2='layout-flow' w='100000' x='0' y='5000'><zone h='50000' id='9' name='Trend' w='100000' x='0' y='5000' /></zone>
			<zone h='45000' id='8' type-v2='text' w='100000' x='0' y='55000'><formatted-text><run>Note</run></formatted-text></zone>
		</zone></zones></dashboard>
		<dashboard name='Details'><zones /></dashboard>
	</dashboards>
	<windows>
		<window class='dashboard' name='Home'><simple-id uuid='{22222222-0000-0000-0000-000000000000}' /></window>
		<window class='dashboard' name='Details'><simple-id uuid='{11111111-0000-0000-0000-000000000000}' /></window>
	</windows></workbook>`);
	const buttons = ir.dashboards[0].zones.filter((z) => z.kind === 'button').map((z) => z.button);
	assert.deepEqual(buttons.slice(0, 3).map((b) => b.target), [
		{ windowId: '{11111111-0000-0000-0000-000000000000}', name: 'Details', kind: 'dashboard' },
		{ windowId: '{55555555-0000-0000-0000-000000000000}', name: 'Trend', kind: 'worksheet' },
		{ windowId: '{99999999-0000-0000-0000-000000000000}' }
	]);
	assert.deepEqual(buttons.slice(3).map((b) => b.toggle), [{ zoneIds: ['6'], shown: false }, { zoneIds: ['8'], shown: true }]);
	assert.equal(ir.dashboards[0].zones.find((z) => z.id === '9').hidden, true);
});

test('text runs, custom dashboard title, dashboard style rules and device layouts', () => {
	const d = dash(`<dashboard name='Plain AgedAR'>
		<layout-options><title><formatted-text><run bold='true' fontcolor='#ffffff' fontname='Tableau Medium' fontsize='22'>&lt;Sheet Name&gt; (no link)</run></formatted-text></title></layout-options>
		<style>
			<style-rule element='table'><format attr='background-color' value='#002b49' /></style-rule>
			<style-rule element='dash-title'><format attr='font-size' value='22' /><format attr='color' value='#ffffff' /></style-rule>
			<style-rule element='parameter-ctrl'><format attr='color' field='[Parameters].[Parameter 1]' value='#333333' /></style-rule>
		</style>
		<size maxheight='1000' maxwidth='1100' minheight='1000' minwidth='1100' sizing-mode='fixed' />
		<zones><zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'>
			<zone h='6000' id='3' type-v2='title' w='100000' x='0' y='0' />
			<zone h='9444' id='10' type-v2='text' w='100000' x='0' y='6000'><formatted-text>
				<run fontcolor='#0000ff' fontname='Arial' fontsize='11' underline='true'>Summary</run>
				<run>Æ&#10;</run>
				<run fontalignment='1' italic='true'>Detail</run>
			</formatted-text></zone>
			<zone h='9444' id='11' type-v2='text' w='100000' x='0' y='16000'><formatted-text><run>Plain</run></formatted-text></zone>
			<zone id='12' name='Chart' x='0' y='26000' w='100000' h='74000' />
		</zone></zones>
		<devicelayouts>
			<devicelayout auto-generated='true' name='Phone'><size maxheight='1300' minheight='1300' sizing-mode='vscroll' /><zones /></devicelayout>
			<devicelayout name='Tablet'><size maxheight='1050' minheight='1050' sizing-mode='vscroll' /><zones><zone h='100000' id='42' type-v2='layout-basic' w='100000' x='0' y='0'><zone id='12' name='Chart' /><zone id='3' type-v2='title' /></zone></zones></devicelayout>
		</devicelayouts>
	</dashboard>`);
	assert.deepEqual(d.title, { text: 'Plain AgedAR (no link)', runs: [{ text: '<Sheet Name> (no link)', fontName: 'Tableau Medium', fontSize: 22, color: '#ffffff', bold: true }] });
	assert.equal(d.zones[0].text, 'Plain AgedAR (no link)');
	assert.deepEqual(d.zones[1].runs, [
		{ text: 'Summary', fontName: 'Arial', fontSize: 11, color: '#0000ff', underline: true },
		{ text: '\n' },
		{ text: 'Detail', align: 'center', italic: true }
	]);
	assert.equal(d.zones[2].runs, undefined);
	assert.equal(d.background, '#002b49');
	assert.deepEqual(d.styleRules[2], { element: 'parameter-ctrl', formats: [{ attr: 'color', value: '#333333', field: '[Parameters].[Parameter 1]' }] });
	assert.deepEqual(d.deviceLayouts, [
		{ name: 'Phone', auto: true, size: { mode: 'vscroll', height: 1300 } },
		{ name: 'Tablet', auto: false, size: { mode: 'vscroll', height: 1050 }, zoneIds: ['12', '3'] }
	]);
	assert.equal(dash("<dashboard name='a' />").containers, undefined);
});
