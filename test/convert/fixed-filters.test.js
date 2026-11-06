import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedDatasourceFilters, fixedFilterCondition } from '../../src/convert/fixed-filters.js';

const ds = {
	id: 'sqlproxy.1',
	caption: 'Backlog',
	fields: [
		{ id: '[Created Date]', name: 'Created Date', datatype: 'date', kind: 'column' },
		{ id: '[Closed Date]', name: 'Closed Date', datatype: 'date', kind: 'column' },
		{ id: '[Region]', name: 'Region', datatype: 'string', kind: 'column' },
		{ id: '[Week End]', name: 'Week End', datatype: 'date', kind: 'calculated', formula: 'DATEADD("day", 6, [Created Date])' },
		{ id: '[Open]', name: 'Open', datatype: 'boolean', kind: 'calculated', formula: '[Closed Date] >= [Week End] or isnull([Closed Date])' }
	]
};
const shared = (fieldId, extra) => ({ pillId: `[sqlproxy.1].[none:${fieldId.slice(1, -1)}:nk]`, datasourceId: 'sqlproxy.1', fieldId, kind: 'categorical', shared: 'sqlproxy.1', ...extra });
const ir = (filters, more = {}) => ({
	worksheets: [
		{ name: 'A', datasourceIds: ['sqlproxy.1'], filters: filters.map((f) => ({ ...f })), quickFilters: more.quick ?? [] },
		{ name: 'B', datasourceIds: ['sqlproxy.1'], filters: filters.map((f) => ({ ...f })) }
	],
	dashboards: more.dashboards ?? []
});

test('fixed "all worksheets" filters are found, and ones a viewer can change are left on the cards', () => {
	const open = shared('[Open]', { include: [true] });
	const region = shared('[Region]', { include: ['East'] });
	assert.deepEqual(fixedDatasourceFilters(ir([open, region]), ds).map((f) => f.fieldId), ['[Open]', '[Region]']);
	assert.deepEqual(fixedDatasourceFilters(ir([open, region], { quick: [{ pillId: region.pillId }] }), ds).map((f) => f.fieldId), ['[Open]']);
	assert.deepEqual(fixedDatasourceFilters(ir([open, region], { dashboards: [{ zones: [{ kind: 'filter', param: open.pillId }] }] }), ds).map((f) => f.fieldId), ['[Region]']);
	assert.deepEqual(fixedDatasourceFilters(ir([{ ...open, shared: undefined }]), ds), []);
});

test('a fixed filter becomes a Magic ETL condition over the joined columns, nested calcs inlined', () => {
	const fieldMap = { '[Created Date]': 'CreatedDate', '[Closed Date]': 'ClosedDate', '[Region]': 'REGION' };
	const open = fixedFilterCondition(shared('[Open]', { include: [true] }), ds, fieldMap);
	assert.match(open.expression, /^\(.*`ClosedDate`.*`CreatedDate`.*\) IN \('true'\)$/s);
	assert.equal(fixedFilterCondition(shared('[Region]', { exclude: ['West', null] }), ds, fieldMap).expression, "`REGION` IS NOT NULL AND (`REGION` IS NULL OR NOT `REGION` IN ('West'))");
	assert.equal(fixedFilterCondition(shared('[Region]', { include: ['East', null] }), ds, fieldMap).expression, "`REGION` IN ('East') OR `REGION` IS NULL");
	assert.equal(fixedFilterCondition(shared('[Missing]', { include: ['x'] }), ds, fieldMap), undefined);
});
