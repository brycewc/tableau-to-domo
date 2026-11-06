import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutUnpublishedSheets } from '../../src/convert/published.js';

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
