import test from 'node:test';
import assert from 'node:assert/strict';
import { withSheetViews, withoutUnpublishedSheets } from '../../src/convert/published.js';

const zone = (worksheet) => ({ kind: 'worksheet', worksheet });
const ir = (views) => ({
	workbook: { name: 'Credits', views },
	dashboards: [
		{ name: 'Details', zones: [zone('d'), zone('ts'), { kind: 'button', button: { action: 'navigate', target: { name: 'Drill', kind: 'dashboard' } } }] },
		{ name: 'Drill', zones: [zone('drill_sheet')] },
		{ name: 'RollUp', zones: [zone('rollup_1'), zone('ts')] },
		{ name: 'Target', zones: [zone('target_sheet')] }
	],
	stories: [{ name: 'Old Story', points: [{ id: '1', caption: 'a', sheet: 'RollUp' }] }],
	actions: [{ id: '[A1]', name: 'go', type: 'filter', trigger: 'select', source: { type: 'sheet', dashboard: 'Drill' }, target: { name: 'Target', kind: 'dashboard' } }],
	worksheets: ['d', 'ts', 'drill_sheet', 'rollup_1', 'target_sheet', 'Sheet 6', 'tab_sheet'].map((name) => ({ name }))
});

test('dashboards, stories and worksheets that are not views and that no view opens are left out', () => {
	const { ir: out, issues } = withoutUnpublishedSheets(ir([{ name: 'Details' }, { name: 'tab_sheet' }]));
	assert.deepEqual(out.dashboards.map((d) => d.name), ['Details', 'Drill', 'Target'], 'a button and then an action open them');
	assert.deepEqual(out.stories, []);
	assert.deepEqual(out.worksheets.filter((w) => w.hidden).map((w) => w.name), ['rollup_1', 'Sheet 6']);
	assert.equal(issues[0].code, 'convert.unpublished');
	assert.match(issues[0].message, /dashboard "RollUp", story "Old Story", worksheet "rollup_1", worksheet "Sheet 6"/);
});

test('without a view list, or with everything published, the workbook is unchanged', () => {
	const none = ir(undefined);
	assert.equal(withoutUnpublishedSheets(none).ir, none);
	const all = ir(['Details', 'RollUp', 'Target', 'Old Story', 'Sheet 6', 'tab_sheet'].map((name) => ({ name })));
	assert.deepEqual(withoutUnpublishedSheets(all).issues, []);
});

test('a published worksheet on no dashboard becomes a view of its own, with its filter cards, in view-list order', () => {
	const out = withSheetViews({
		workbook: { name: 'Trend', views: [{ name: 'New Business' }, { name: 'Summary' }, { name: 'Renewal' }] },
		dashboards: [{ name: 'Summary', zones: [{ kind: 'worksheet', worksheet: 'kpi' }], floating: [], tabIndex: 7 }],
		worksheets: [{ name: 'Renewal' }, { name: 'New Business', quickFilters: [{ pillId: '[ds].[none:Region:nk]', mode: 'checkdropdown' }] }, { name: 'kpi' }, { name: 'Draft', hidden: true }]
	});
	assert.deepEqual(out.dashboards.map((d) => [d.name, d.tabIndex, Boolean(d.sheetView)]).sort((a, b) => a[1] - b[1]), [['New Business', 0, true], ['Summary', 1, false], ['Renewal', 2, true]]);
	const nb = out.dashboards.find((d) => d.name === 'New Business');
	assert.deepEqual(nb.zones.map((z) => [z.kind, z.worksheet, z.param, z.mode]), [['worksheet', 'New Business', undefined, undefined], ['filter', 'New Business', '[ds].[none:Region:nk]', 'checkdropdown']]);
	assert.equal(out.dashboards.find((d) => d.name === 'Renewal').zones[0].rect.w, 1, 'a sheet with no filter cards takes the whole view');
	const none = { workbook: { name: 'x' }, dashboards: [], worksheets: [{ name: 'a' }] };
	assert.equal(withSheetViews(none), none);
});
