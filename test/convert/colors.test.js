import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_COLOR_RULES, TABLEAU_PALETTES, cardColorRules, heatmapOverrides, paletteJson, workbookPalette } from '../../src/convert/colors.js';
import { controlItemStyle, planItemStyles, zoneItemStyle } from '../../src/convert/app-layout.js';
import { applyItemStyles } from '../../src/domo/apps.js';

const DS = { $ref: 'dataset:orders' };
const REGION = '[ds].[none:Region:nk]';
const slots = [
	{ pillId: REGION, role: 'dim', column: { column: 'Region', mapping: 'SERIES' } },
	{ pillId: '[ds].[sum:Sales:qk]', role: 'measure', column: { column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' } }
];
const sheet = (extra) => ({ name: 'Sheet', ...extra });
const format = (color) => ({ color, textColor: null, textStyle: 'PLAIN', applyToRow: false });

test('member colors become one IN rule per color on the series column, most members first', () => {
	const ws = sheet({
		color: { pillId: REGION, type: 'palette', members: [{ value: 'East', color: '#e15759' }, { value: 'West', color: '#4e79a7' }, { value: 'North', color: '#4e79a7' }, { value: null, color: '#000000' }, { value: true, color: '#59a14f' }], multi: true, truncated: 300 }
	});
	const { rules, issues } = cardColorRules(ws, { family: 'bar', slots, dataSourceId: DS });
	assert.deepEqual(rules, [
		{ condition: { column: 'Region', values: ['West', 'North'], operand: 'IN', dataSourceId: DS }, format: format('#4e79a7') },
		{ condition: { column: 'Region', values: ['East'], operand: 'IN', dataSourceId: DS }, format: format('#e15759') },
		{ condition: { column: 'Region', values: ['true'], operand: 'IN', dataSourceId: DS }, format: format('#59a14f') }
	]);
	assert.deepEqual(issues.map((i) => i.code), ['card.colors-truncated', 'card.colors-null', 'card.colors-tuples']);
});

test('more colors than Domo takes keep the colors with the most members', () => {
	const members = Array.from({ length: MAX_COLOR_RULES + 3 }, (_, i) => ({ value: `m${i}`, color: `#${i.toString(16).padStart(6, '0')}` }));
	const { rules, issues } = cardColorRules(sheet({ color: { pillId: REGION, type: 'palette', members } }), { family: 'line', slots, dataSourceId: DS });
	assert.equal(rules.length, MAX_COLOR_RULES);
	assert.match(issues[0].message, /103 member colors.*the 3 colors with the fewest members/);
});

test('Measure Names colors each measure column; one mark color colors every value column', () => {
	const mn = sheet({ color: { pillId: '[ds].[:Measure Names]', type: 'palette', members: [{ value: '[ds].[sum:Sales:qk]', color: '#f28e2b' }, { value: '[ds].[sum:Gone:qk]', color: '#000000' }] } });
	assert.deepEqual(cardColorRules(mn, { family: 'bar', slots, dataSourceId: DS }).rules, [{ condition: { column: 'Sales', values: [], operand: 'IN', dataSourceId: DS }, format: format('#f28e2b') }]);
	const running = { pillId: '[ds].[pcto:sum:Sales:qk]', role: 'measure', column: { column: 'Sales', mapping: 'VALUE' } };
	const twice = cardColorRules({ ...mn, color: { ...mn.color, members: [{ value: running.pillId, color: '#76b7b2' }, ...mn.color.members] } }, { family: 'combo', slots: [...slots, running], dataSourceId: DS });
	assert.deepEqual(twice.rules.map((r) => r.format.color), ['#f28e2b'], 'the first measure on the card keeps the column');
	assert.equal(twice.issues[0].code, 'card.colors-same-column');
	const mark = cardColorRules(sheet({ markColor: '#59a14f' }), { family: 'bar', slots, dataSourceId: DS });
	assert.deepEqual(mark.rules, [{ condition: { column: 'Sales', values: [], operand: 'IN', dataSourceId: DS }, format: format('#59a14f') }]);
});

test('no rules for gradients, tables, date parts or a color field not on the card, each with its issue', () => {
	const code = (ws, family = 'bar', s = slots) => {
		const out = cardColorRules(ws, { family, slots: s, dataSourceId: DS });
		assert.deepEqual(out.rules, []);
		return out.issues.map((i) => i.code);
	};
	const mapped = { pillId: REGION, type: 'palette', members: [{ value: 'East', color: '#e15759' }] };
	assert.deepEqual(code(sheet({ color: { pillId: '[ds].[sum:Profit:qk]', type: 'interpolated' } })), ['card.color-gradient']);
	assert.deepEqual(code(sheet({ color: mapped }), 'table'), ['card.colors-chart']);
	assert.deepEqual(code(sheet({ markColor: '#000000' }), 'kpi'), []);
	assert.deepEqual(code(sheet({ color: mapped }), 'bar', slots.slice(1)), ['card.colors-dropped']);
	const year = { ...mapped, pillId: '[ds].[yr:Order Date:ok]' };
	assert.deepEqual(code(sheet({ color: year }), 'bar', [{ ...slots[0], pillId: year.pillId }]), ['card.colors-date']);
});

test('the app palette: the most used palette of categorical color pills, from a custom palette, the table, or the maps', () => {
	const ws = (name, palette, members = [], pill = REGION) => ({ name, panes: [{ encodings: { color: [pill] } }], color: { pillId: pill, type: 'palette', ...(palette ? { palette } : {}), members } });
	const ir = (worksheets, style) => ({ workbook: { name: 'W' }, dashboards: [], worksheets, style });
	assert.deepEqual(workbookPalette(ir([ws('a'), ws('b', 'tableau20_10_0'), ws('c')])).palette, TABLEAU_PALETTES.tableau10_10_0);
	assert.deepEqual(workbookPalette(ir([ws('a', 'Brand')], { palettes: [{ name: 'Brand', type: 'regular', colors: ['#112233', '#445566'] }] })).palette, { name: 'Brand', colors: ['#112233', '#445566'] });
	const unknown = workbookPalette(ir([ws('a', 'cyclic_10_0', [{ value: 'x', color: '#aa0000' }, { value: 'y', color: '#00aa00' }, { value: 'z', color: '#aa0000' }])]));
	assert.deepEqual(unknown.palette, { name: 'cyclic_10_0', colors: ['#aa0000', '#00aa00'] });
	assert.equal(unknown.issues[0].code, 'layout.theme-palette');
	const gradientOnly = { name: 'g', panes: [{ encodings: { color: ['[ds].[sum:Sales:qk]'] } }] };
	assert.equal(workbookPalette(ir([gradientOnly])).palette, undefined, 'a measure on color is a gradient');
	const onDash = { ...ir([ws('a', 'tableau-10'), ws('b'), ws('c')]), dashboards: [{ name: 'D', zones: [{ kind: 'worksheet', worksheet: 'a' }], floating: [] }] };
	assert.equal(workbookPalette(onDash).palette.name, 'Tableau Classic 10', 'only sheets on dashboards count when there are any');
});

test('paletteJson: a 9-shade range per color, the color in the middle, one rule cycling them to 36 cells, a gradient per color', () => {
	const json = JSON.parse(paletteJson(['#4E79A7', '#000000']));
	assert.deepEqual(json.colorRanges[1].values, ['cccccc', '999999', '666666', '333333', '000000', '000000', '000000', '000000', '000000']);
	assert.equal(json.colorRanges[0].values[4], '4e79a7');
	assert.deepEqual(json.colorRanges[0].keyColors, [{ color: '4e79a7', locked: true }]);
	assert.deepEqual(json.colorRules, [{ min: 1, max: 36, values: Array.from({ length: 36 }, (_, i) => [i % 2, 4]) }]);
	assert.deepEqual(json.lineColors, json.colorRules[0].values);
	assert.deepEqual(json.gradients[1], { colCount: 9, values: Array.from({ length: 9 }, (_, i) => [1, i]) });
});

test('zone item styles: border clamped, padding rounded, single values skipped; near-identical merged; the theme default dropped', () => {
	const zone = (style) => ({ id: '1', kind: 'worksheet', style });
	assert.deepEqual(zoneItemStyle(zone({ background: '#faf4e7', border: { style: 'dotted', width: 9, color: '#000' }, padding: 7 }), 'badge_vert_bar'), { kind: 'card', background: '#FAF4E7', borderColor: '#000000', borderWidth: 4, padding: { top: 8, right: 8, bottom: 8, left: 8 } });
	assert.deepEqual(zoneItemStyle(zone({ padding: 0 }), 'badge_pivot_table'), { kind: 'table', background: null, borderColor: null, borderWidth: 0, padding: null });
	assert.equal(zoneItemStyle(zone({}), 'badge_singlevalue'), undefined);
	const item = (style) => ({ type: 'CARD', itemStyle: zoneItemStyle(zone(style), 'badge_vert_bar') });
	const boxed = { border: { style: 'solid', width: 1, color: '#000000' } };
	const views = [{ layout: { content: [item(boxed), item(boxed), item({ border: { style: 'solid', width: 1, color: '#030303' } }), item({}), item({ background: '#eeeeee' })] } }];
	const { styles, control } = planItemStyles(views, { borderColor: '#000000', borderWidth: 1 });
	assert.deepEqual(styles.map((s) => [s.key, s.background, s.borderWidth, s.items]), [['s1', null, 0, 1], ['s2', '#EEEEEE', 0, 1]]);
	assert.equal(control, undefined);
	assert.deepEqual(views[0].layout.content.map((i) => i.itemStyle), [undefined, undefined, undefined, 's1', 's2']);
});

test('filter zones show their own or the nearest container background; the most common one is the control style', () => {
	const dash = {
		containers: [
			{ id: 'root', style: {} },
			{ id: 'a', parent: 'root', style: { background: '#efe9e7', border: { style: 'solid', width: 1, color: '#333333' } } },
			{ id: 'b', parent: 'root', style: {} }
		]
	};
	const filter = (parent, style = {}) => ({ id: 'f', kind: 'filter', parent, style });
	assert.deepEqual(controlItemStyle(filter('a'), dash), { kind: 'control', background: '#EFE9E7', borderColor: null, borderWidth: 0, padding: null }, 'no border: Tableau filters draw none');
	assert.equal(controlItemStyle(filter('b', { background: '#eef1f3' }), dash).background, '#EEF1F3');
	assert.equal(controlItemStyle(filter('b'), dash).background, null);
	const item = (style) => ({ type: 'CARD', itemStyle: style });
	const content = [item(controlItemStyle(filter('b', { background: '#eef1f3' }), dash)), item(controlItemStyle(filter('b', { background: '#f2f6f7' }), dash)), item(controlItemStyle(filter('a'), dash))];
	const { styles, control } = planItemStyles([{ layout: { content } }]);
	assert.deepEqual(control, { background: '#EEF1F3', borderWidth: 0 }, '#F2F6F7 is near-identical, so merged into it');
	assert.deepEqual(styles.map((s) => [s.key, s.kind, s.background]), [['s1', 'control', '#EFE9E7']]);
	assert.deepEqual(content.map((i) => i.itemStyle), [undefined, undefined, 's1']);
});

test('applyItemStyles fills the card and table styles no mapping uses, copied from the mapped style, and skips past them', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const styles = [
		{ key: 's1', kind: 'card', background: null, borderColor: '#000000', borderWidth: 2, padding: { top: 4, right: 4, bottom: 4, left: 4 }, items: 3 },
		{ key: 's2', kind: 'table', background: '#FAF4E7', borderColor: null, borderWidth: 0, padding: null, items: 2 },
		...['s3', 's4', 's5', 's6'].map((key) => ({ key, kind: 'card', background: '#123456', borderColor: null, borderWidth: 0, padding: null, items: 1 }))
	];
	const { theme, ids, skipped, notes } = applyItemStyles(clarion, styles, clarion);
	assert.deepEqual(ids, { s1: 'ca4', s2: 't1', s3: 'ca5', s4: 'ca6', s5: 'ca7' });
	assert.deepEqual(skipped, ['s6']);
	assert.match(notes[0], /1 item style/);
	const ca4 = theme.cards.find((s) => s.id === 'ca4');
	const ca2 = clarion.cards.find((s) => s.id === 'ca2');
	assert.deepEqual(ca4.backgroundColor, ca2.backgroundColor, 'no background keeps the chart style background');
	assert.equal(theme.colors.find((c) => c.id === ca4.borderColor.value).value.value, '#000000');
	assert.deepEqual([ca4.borderWidth, ca4.padding, ca4.borderRadius], [2, { top: 16, right: 16, bottom: 16, left: 16 }, ca2.borderRadius], 'Tableau padding adds to the theme padding, 16 at most');
	assert.equal(theme.cards.length, 8, 'no style is added');
	assert.equal(theme.tables.find((s) => s.id === 't1').borderColor, null);
	assert.deepEqual(applyItemStyles(clarion, []).ids, {});
});

test('applyItemStyles copies the control style for filter styles and merges border-only differences when slots run out', () => {
	const clarion = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));
	const chart = (key, borderColor, items) => ({ key, kind: 'card', background: null, borderColor, borderWidth: 1, padding: null, items });
	const filter = (key, background) => ({ key, kind: 'control', background, borderColor: null, borderWidth: 0, padding: null, items: 2 });
	const styles = [chart('s1', '#333333', 3), chart('s2', '#1B1B1B', 2), filter('s3', '#FEFAF1'), filter('s4', '#EFF3E3'), chart('s5', '#000000', 1), filter('s6', '#EFE9E7')];
	const { theme, ids, skipped, merged } = applyItemStyles(clarion, styles, clarion);
	assert.deepEqual(ids, { s1: 'ca4', s3: 'ca5', s4: 'ca6', s6: 'ca7', s2: 'ca4', s5: 'ca4' }, 'the dark borders share the most used one');
	assert.deepEqual([skipped, merged.sort()], [[], ['s2', 's5']]);
	const control = clarion.cards.find((s) => s.id === clarion.mappings.control);
	const ca5 = theme.cards.find((s) => s.id === 'ca5');
	assert.deepEqual([ca5.padding, ca5.borderWidth, ca5.elementSpacing], [control.padding, 0, control.elementSpacing], 'a copy of the control style');
	assert.equal(theme.colors.find((c) => c.id === ca5.backgroundColor.value).value.value, '#FEFAF1');
});

test('a line pane colored by Measure Names under bars colored by a dimension takes its measure color on its column', () => {
	const LINE = '[ds].[usr:Ratio:qk]';
	const ws = sheet({
		color: { pillId: REGION, type: 'palette', members: [{ value: 'East', color: '#e15759' }] },
		paneColors: { '[ds].[:Measure Names]': { type: 'palette', members: [{ value: LINE, color: '#e15759' }, { value: '[ds].[sum:Sales:qk]', color: '#000000' }] } },
		panes: [
			{ markClass: 'Bar', yAxisPill: '[ds].[sum:Sales:qk]', encodings: { color: [REGION] } },
			{ markClass: 'Line', yAxisPill: LINE, encodings: { color: ['[ds].[:Measure Names]'] } }
		]
	});
	const comboSlots = [slots[1], { pillId: LINE, role: 'measure', column: { column: 'Ratio', mapping: 'SERIES' } }];
	const { rules, issues } = cardColorRules(ws, { family: 'combo', slots: comboSlots, dataSourceId: DS });
	assert.deepEqual(rules, [{ condition: { column: 'Ratio', values: [], operand: 'IN', dataSourceId: DS }, format: format('#e15759') }], 'the bars pane is not colored by Measure Names, so Sales gets no measure rule');
	assert.ok(issues.some((i) => i.code === 'card.colors-dropped'), 'Region is not on the card');
});

test('heatmapOverrides colors the given columns with one range, keeping a diverging center and its steps', () => {
	assert.deepEqual(heatmapOverrides({ type: 'interpolated', palette: 'blue_10_0' }, [7]), { use_heatmap_colors: 'true', heatmap_columns: '7', range_by_column: 'false' });
	assert.equal(heatmapOverrides(undefined, [3, 4, 5, 6, 7, 8, 9]).heatmap_columns, '3-9', 'spread members as a range');
	assert.equal(heatmapOverrides(undefined, [5, 2, 3, 9]).heatmap_columns, '2-3,5,9');
	const base = ['use_heatmap_colors', 'heatmap_columns', 'range_by_column'];
	const diverging = (encoding) => Object.fromEntries(Object.entries(heatmapOverrides(encoding, [2])).filter(([key]) => !base.includes(key)));
	assert.deepEqual(diverging({ type: 'custom-interpolated', paletteType: 'ordered-diverging', center: -1, steps: 2 }), { show_diverging: 'true', midpoint_value_type: 'Manual', midpoint_value: '-1', diverging_range_count: '1' });
	assert.deepEqual(diverging({ type: 'custom-interpolated', center: 0, steps: 7 }), { show_diverging: 'true', midpoint_value_type: 'Zero', diverging_range_count: '3', show_midpoint: 'true' });
	assert.deepEqual(diverging({ type: 'interpolated', palette: 'red_green_diverging_10_0' }), { show_diverging: 'true', midpoint_value_type: 'Zero', diverging_range_count: '5' }, 'a continuous diverging scale');
	assert.deepEqual(diverging({ type: 'custom-interpolated', paletteType: 'ordered-diverging', steps: 20 }), { show_diverging: 'true', midpoint_value_type: 'Zero', diverging_range_count: '5' }, 'at most 5 ranges a side');
	assert.deepEqual(diverging({ type: 'custom-interpolated', paletteType: 'ordered-sequential' }), {});
});
