import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COLOR_MEMBERS, colorEncodings, colorValue, paneLabelAlign, paneLabelColor, paneMarkColor, resolveColorEncoding } from '../../src/tableau/twb/colors.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { parseXml } from '../../src/tableau/twb/xml.js';

const style = (rules) => parseXml(`<style>${rules}</style>`);

test('colorValue reads escaped and alpha hex colors and rejects others', () => {
	assert.equal(colorValue('\\#4E79A7'), '#4e79a7');
	assert.equal(colorValue('#4e79a7ff'), '#4e79a7');
	assert.equal(colorValue('red'), undefined);
	assert.equal(colorValue(undefined), undefined);
});

test('colorEncodings reads palette, member maps, multibuckets and custom gradient colors from mark rules only', () => {
	const map = colorEncodings(style(`
		<style-rule element='mark'>
			<encoding attr='color' field='[none:Region:nk]' type='palette' palette='tableau20_10_0'>
				<map to='#e15759'><bucket>&quot;East&quot;</bucket></map>
				<map to='#4e79a7'><bucket>%null%</bucket></map>
				<map to='#59a14f'><multibucket><bucket>1</bucket><bucket>2</bucket></multibucket></map>
				<map to='bogus'><bucket>&quot;West&quot;</bucket></map>
			</encoding>
			<encoding attr='color' field='[sum:Sales:qk]' type='custom-interpolated'>
				<color-palette custom='true' name='' type='ordered-sequential'><color>#ffffff</color><color>#1f77b4</color></color-palette>
			</encoding>
			<encoding attr='size' field='[sum:Profit:qk]' />
		</style-rule>
		<style-rule element='cell'><encoding attr='color' field='[none:Other:nk]' type='palette' /></style-rule>`));
	assert.deepEqual([...map.keys()], ['[none:Region:nk]', '[sum:Sales:qk]']);
	const region = map.get('[none:Region:nk]');
	assert.equal(region.palette, 'tableau20_10_0');
	assert.equal(region.multi, true);
	assert.deepEqual(region.members.slice(0, 2), [
		{ value: 'East', color: '#e15759' },
		{ value: null, color: '#4e79a7' }
	]);
	assert.deepEqual(map.get('[sum:Sales:qk]'), { type: 'custom-interpolated', colors: ['#ffffff', '#1f77b4'], paletteType: 'ordered-sequential' });
});

test('colorEncodings reads the center, step count, palette type and include-totals of a gradient', () => {
	const enc = colorEncodings(style(`
		<style-rule element='mark'>
			<encoding attr='color' center='-1.0' field='[diff:sum:Bookings:qk:8]' include-totals='true' num-steps='2' type='custom-interpolated'>
				<color-palette custom='true' name='' type='ordered-diverging'><color>#ffffbf</color><color>#d9d9d9</color><color>#ffffff</color></color-palette>
			</encoding>
			<encoding attr='color' field='[sum:Sales:qk]' type='interpolated' palette='blue_10_0' />
		</style-rule>`));
	assert.deepEqual(enc.get('[diff:sum:Bookings:qk:8]'), {
		type: 'custom-interpolated',
		colors: ['#ffffbf', '#d9d9d9', '#ffffff'],
		paletteType: 'ordered-diverging',
		center: -1,
		steps: 2,
		includeTotals: true
	});
	assert.deepEqual(enc.get('[sum:Sales:qk]'), { type: 'interpolated', palette: 'blue_10_0' });
});

test('colorEncodings caps member maps and records the full count', () => {
	const maps = Array.from({ length: MAX_COLOR_MEMBERS + 5 }, (_, i) => `<map to='#000000'><bucket>${i}</bucket></map>`).join('');
	const enc = colorEncodings(style(`<style-rule element='mark'><encoding attr='color' field='[none:Id:ok]' type='palette'>${maps}</encoding></style-rule>`)).get('[none:Id:ok]');
	assert.equal(enc.members.length, MAX_COLOR_MEMBERS);
	assert.equal(enc.truncated, MAX_COLOR_MEMBERS + 5);
});

test('resolveColorEncoding prefers the worksheet, then the datasource instance, then the same column under another derivation', () => {
	const sheet = new Map([['[ds].[none:Segment:nk]', { type: 'palette', palette: 'p1' }]]);
	const datasources = new Map([['ds', new Map([['[none:Region:nk]', { type: 'palette', palette: 'p2' }], ['[attr:Category:nk]', { type: 'palette', palette: 'p3' }]])]]);
	assert.deepEqual(resolveColorEncoding('[ds].[none:Segment:nk]', sheet, datasources), { type: 'palette', palette: 'p1', source: 'worksheet' });
	assert.deepEqual(resolveColorEncoding('[ds].[none:Region:nk]', sheet, datasources), { type: 'palette', palette: 'p2', source: 'datasource' });
	assert.deepEqual(resolveColorEncoding('[ds].[none:Category:nk]', sheet, datasources), { type: 'palette', palette: 'p3', source: 'datasource' });
	assert.equal(resolveColorEncoding('[other].[none:Region:nk]', sheet, datasources), undefined);
	assert.equal(resolveColorEncoding('[ds].[none:Missing:nk]', sheet, datasources), undefined);
});

test('paneMarkColor reads the pane mark-color format without a field', () => {
	const pane = parseXml(`<pane><style><style-rule element='mark'><format attr='mark-color' field='[x]' value='#000000' /><format attr='mark-color' value='#F28E2B' /></style-rule></style></pane>`);
	assert.equal(paneMarkColor(pane), '#f28e2b');
	assert.equal(paneMarkColor(parseXml('<pane />')), undefined);
});

test('paneLabelAlign and paneLabelColor read the pane cell and datalabel rules, not field formats', () => {
	const pane = parseXml(`<pane><style><style-rule element='cell'><format attr='text-format' field='[x]' value='p0%' /><format attr='vertical-align' value='center' /><format attr='text-align' value='auto' /></style-rule><style-rule element='datalabel'><format attr='color-mode' value='user' /><format attr='color' value='#FFFFFF' /><format attr='font-size' value='8' /></style-rule></style></pane>`);
	assert.deepEqual(paneLabelAlign(pane), { horizontal: 'auto', vertical: 'center' });
	assert.deepEqual(paneLabelColor(pane), { mode: 'user', color: '#ffffff' });
	const auto = parseXml(`<pane><style><style-rule element='cell'><format attr='text-align' field='[x]' value='right' /></style-rule><style-rule element='datalabel'><format attr='color-mode' value='auto' /></style-rule></style></pane>`);
	assert.deepEqual([paneLabelAlign(auto), paneLabelColor(auto)], [undefined, { mode: 'auto' }]);
	assert.deepEqual([paneLabelAlign(parseXml('<pane />')), paneLabelColor(parseXml('<pane />'))], [undefined, undefined]);
});

test('worksheets carry the color encoding of their color pill and their mark color', () => {
	const xml = `<?xml version='1.0' encoding='utf-8' ?>
<workbook version='18.1'>
	<datasources>
		<datasource caption='Orders' name='ds'>
			<column datatype='string' name='[Region]' role='dimension' type='nominal' />
			<column datatype='real' name='[Sales]' role='measure' type='quantitative' />
			<style><style-rule element='mark'>
				<encoding attr='color' field='[none:Region:nk]' type='palette'><map to='#e15759'><bucket>&quot;East&quot;</bucket></map></encoding>
			</style-rule></style>
		</datasource>
	</datasources>
	<worksheets>
		<worksheet name='Colored'>
			<table>
				<view><datasources><datasource caption='Orders' name='ds' /></datasources>
					<datasource-dependencies datasource='ds'>
						<column datatype='string' name='[Region]' role='dimension' type='nominal' />
						<column-instance column='[Region]' derivation='None' name='[none:Region:nk]' pivot='key' type='nominal' />
						<column datatype='real' name='[Sales]' role='measure' type='quantitative' />
						<column-instance column='[Sales]' derivation='Sum' name='[sum:Sales:qk]' pivot='key' type='quantitative' />
					</datasource-dependencies>
				</view>
				<panes><pane><mark class='Bar' /><encodings><color column='[ds].[none:Region:nk]' /></encodings></pane></panes>
				<rows>[ds].[none:Region:nk]</rows><cols>[ds].[sum:Sales:qk]</cols>
			</table>
		</worksheet>
		<worksheet name='One color'>
			<table>
				<view><datasources><datasource caption='Orders' name='ds' /></datasources></view>
				<style><style-rule element='quick-filter'><format attr='title' field='[ds].[none:Region:nk]' value='Sales Region' /><format attr='title' field='[ds].[none:Other:nk]' value=' ' /></style-rule></style>
				<panes><pane><mark class='Bar' /><style><style-rule element='mark'><format attr='mark-color' value='#59a14f' /><format attr='mark-labels-show' value='true' /></style-rule><style-rule element='datalabel'><format attr='font-weight' value='bold' /><format attr='color-mode' value='auto' /></style-rule><style-rule element='cell'><format attr='vertical-align' value='bottom' /></style-rule></style></pane></panes>
				<rows>[ds].[none:Region:nk]</rows><cols>[ds].[sum:Sales:qk]</cols>
			</table>
		</worksheet>
	</worksheets>
</workbook>`;
	const ir = buildWorkbookIR(xml);
	const [colored, plain] = ir.worksheets;
	assert.deepEqual(colored.color, { pillId: '[ds].[none:Region:nk]', type: 'palette', members: [{ value: 'East', color: '#e15759' }], source: 'datasource' });
	assert.equal(colored.markColor, undefined);
	assert.equal(plain.color, undefined);
	assert.equal(plain.markColor, '#59a14f');
	assert.deepEqual(plain.panes.map((pane) => [pane.markColor, pane.showLabels, pane.boldLabels, pane.labelAlign, pane.labelColor]), [['#59a14f', true, true, { vertical: 'bottom' }, { mode: 'auto' }]], 'each pane keeps its own mark color and label settings');
	assert.deepEqual(plain.filterTitles, { '[ds].[none:Region:nk]': 'Sales Region' }, 'quick filter titles, blank ones left out');
	assert.equal(colored.filterTitles, undefined);
});

test('the other panes keep the encodings of their own color pills, and a long period map is kept whole', () => {
	const periods = Array.from({ length: 239 }, (_, i) => `<map to='${i === 238 ? '#f28e2b' : '#4e79a7'}'><bucket>&quot;P${i}&quot;</bucket></map>`).join('');
	const xml = `<?xml version='1.0' encoding='utf-8' ?>
<workbook version='18.1'>
	<datasources>
		<datasource caption='Orders' name='ds'>
			<column datatype='string' name='[Region]' role='dimension' type='nominal' />
			<column datatype='real' name='[Sales]' role='measure' type='quantitative' />
			<style><style-rule element='mark'>
				<encoding attr='color' field='[none:Region:nk]' type='palette'>${periods}</encoding>
				<encoding attr='color' field='[:Measure Names]' type='palette'><map to='#e15759'><bucket>&quot;[ds].[sum:Sales:qk]&quot;</bucket></map></encoding>
			</style-rule></style>
		</datasource>
	</datasources>
	<worksheets>
		<worksheet name='Dual'>
			<table>
				<view><datasources><datasource caption='Orders' name='ds' /></datasources></view>
				<panes>
					<pane><mark class='Bar' /><encodings><color column='[ds].[none:Region:nk]' /></encodings></pane>
					<pane id='1' y-axis-name='[ds].[sum:Sales:qk]'><mark class='Line' /><encodings><color column='[ds].[:Measure Names]' /></encodings></pane>
				</panes>
				<rows>[ds].[sum:Sales:qk]</rows><cols>[ds].[none:Region:nk]</cols>
			</table>
		</worksheet>
	</worksheets>
</workbook>`;
	const [ws] = buildWorkbookIR(xml).worksheets;
	assert.equal(ws.color.members.length, 239);
	assert.equal(ws.color.truncated, undefined);
	assert.deepEqual(Object.keys(ws.paneColors), ['[ds].[:Measure Names]']);
	assert.deepEqual(ws.paneColors['[ds].[:Measure Names]'].members, [{ value: '[ds].[sum:Sales:qk]', color: '#e15759' }]);
});
