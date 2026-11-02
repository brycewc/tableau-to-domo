import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';

const STORY = `<dashboard name='AR Aging' type='storyboard'>
	<style><style-rule element='story-title'><format attr='font-size' value='18' /></style-rule></style>
	<size maxheight='1000' maxwidth='1100' minheight='1000' minwidth='1100' sizing-mode='fixed' />
	<zones><zone h='100000' id='2' type-v2='layout-basic' w='100000' x='0' y='0'>
		<zone h='98400' id='1' param='vert' type-v2='layout-flow' w='98546' x='727' y='800'>
			<zone fixed-size='60' h='6000' id='3' is-fixed='true' type-v2='title' w='98546' x='727' y='800' />
			<zone h='12200' id='4' paired-zone-id='5' type-v2='flipboard-nav' w='98546' x='727' y='6800' />
			<zone h='80200' id='5' paired-zone-id='4' type-v2='flipboard' w='98546' x='727' y='19000'>
				<flipboard active-id='2' nav-type='caption' show-nav-arrows='true'>
					<story-points>
						<story-point caption='1.Summary' captured-sheet='Key Insights' id='1'>
							<capturedDeltas><worksheet name='Key Insights'><annotations><annotation class='point' delta-type='added' id='0' /></annotations></worksheet></capturedDeltas>
						</story-point>
						<story-point caption='2. Channel' captured-sheet='Overview' id='2'>
							<capturedDeltas><worksheet name='Channel'>
								<filter class='categorical' column='[federated.a].[none:Channel:nk]' delta-type='changed'><groupfilter function='member' level='[none:Channel:nk]' member='&quot;Partner&quot;' /></filter>
								<style delta-type='added'><style-rule element='annotation' /></style>
							</worksheet></capturedDeltas>
						</story-point>
						<story-point caption='3. Gone' captured-sheet='Deleted' id='3' />
					</story-points>
				</flipboard>
			</zone>
		</zone>
	</zone></zones>
</dashboard>`;

test('stories: points with captions, captured sheet kinds, captured filters and annotations', () => {
	const ir = buildWorkbookIR(`<?xml version='1.0'?><workbook>
	<worksheets><worksheet name='Key Insights' /><worksheet name='Channel' /></worksheets>
	<dashboards><dashboard name='Overview'><zones /></dashboard>${STORY}</dashboards>
	<windows><window class='dashboard' name='Overview' /><window class='storyboard' name='AR Aging' /></windows>
	</workbook>`);
	assert.deepEqual(ir.dashboards.map((d) => d.name), ['Overview']);
	assert.equal(ir.issues.find((i) => i.code === 'twb.story').object.name, 'AR Aging');
	const [story] = ir.stories;
	assert.deepEqual(
		{ ...story, points: undefined },
		{ name: 'AR Aging', size: { mode: 'fixed', width: 1100, height: 1000 }, points: undefined, activePoint: '2', navType: 'caption', showArrows: true, title: { text: 'AR Aging' }, styleRules: [{ element: 'story-title', formats: [{ attr: 'font-size', value: '18' }] }], tabIndex: 1 }
	);
	assert.deepEqual(story.points.map((p) => [p.id, p.caption, p.sheet, p.sheetKind]), [
		['1', '1.Summary', 'Key Insights', 'worksheet'],
		['2', '2. Channel', 'Overview', 'dashboard'],
		['3', '3. Gone', 'Deleted', undefined]
	]);
	assert.deepEqual(story.points[0].captured, [{ name: 'Key Insights', annotations: 1 }]);
	const [channel] = story.points[1].captured;
	assert.equal(channel.name, 'Channel');
	assert.deepEqual([channel.filters[0].fieldId, channel.filters[0].include], ['[Channel]', ['Partner']]);
	assert.equal(story.points[2].captured, undefined);
});

test('workbook style: rules, defaults of the all rule and custom palettes; absent when not set', () => {
	const ir = buildWorkbookIR(`<?xml version='1.0'?><workbook>
	<preferences>
		<preference name='ui.shelf.height' value='26' />
		<color-palette custom='true' name='Brand' type='regular'><color>#9f9cf9</color><color>#13294b</color></color-palette>
	</preferences>
	<style>
		<style-rule element='all'><format attr='font-family' value='Segoe UI' /><format attr='font-size' value='9' /><format attr='color' value='#333333' /></style-rule>
		<style-rule element='animation'><format attr='animation-on' value='ao-on' /></style-rule>
		<style-rule element='refline'><format attr='stroke-size' id='refline0' value='2' /></style-rule>
	</style>
	</workbook>`);
	assert.deepEqual(ir.style, {
		rules: [
			{ element: 'all', formats: [{ attr: 'font-family', value: 'Segoe UI' }, { attr: 'font-size', value: '9' }, { attr: 'color', value: '#333333' }] },
			{ element: 'animation', formats: [{ attr: 'animation-on', value: 'ao-on' }] },
			{ element: 'refline', formats: [{ attr: 'stroke-size', value: '2', id: 'refline0' }] }
		],
		defaults: { fontFamily: 'Segoe UI', fontSize: 9, color: '#333333' },
		palettes: [{ name: 'Brand', type: 'regular', colors: ['#9f9cf9', '#13294b'] }]
	});
	const plain = buildWorkbookIR("<?xml version='1.0'?><workbook><preferences /><style /></workbook>");
	assert.deepEqual([plain.style, plain.actions, plain.stories], [undefined, undefined, undefined]);
});

test('an ir.json written before these fields stays readable by the parser helpers', async () => {
	const { containerZones } = await import('../../src/tableau/twb/index.js');
	const old = { name: 'D', size: { mode: 'automatic' }, zones: [{ id: '1', kind: 'worksheet', worksheet: 'A', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false }], floating: [] };
	assert.deepEqual(containerZones(old, '1').map((z) => z.id), ['1']);
	assert.deepEqual(containerZones(old, 'missing'), []);
});
