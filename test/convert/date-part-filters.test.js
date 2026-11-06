import test from 'node:test';
import assert from 'node:assert/strict';
import { withDatePartFilterFields } from '../../src/convert/date-part-filters.js';

const DS = 'ds1';
const WD = `[${DS}].[wd:Order Date:ok]`;
const ir = (shown) => ({
	datasources: [{ id: DS, fields: [{ id: '[Order Date]', name: 'Order Date', datatype: 'date', kind: 'column' }] }],
	worksheets: [
		{
			name: 'Trend',
			pills: { [WD]: { id: WD, datasourceId: DS, fieldId: '[Order Date]', derivation: 'Weekday', datePart: 'weekday' } },
			filters: [{ pillId: WD, datasourceId: DS, fieldId: '[Order Date]', kind: 'categorical', exclude: [1, 7, null] }],
			...(shown ? { windowCards: [{ kind: 'filter', param: WD }], quickFilters: [{ pillId: WD }], filterTitles: { [WD]: 'Weekday' } } : {})
		}
	],
	dashboards: [{ name: 'D', zones: shown ? [{ kind: 'filter', worksheet: 'Trend', param: WD }] : [], floating: [] }]
});

test('a shown filter on a weekday becomes a filter on a calculated weekday field, with named members', () => {
	const out = withDatePartFilterFields(ir(true));
	const field = out.datasources[0].fields.at(-1);
	assert.deepEqual([field.name, field.formula, field.datatype], ['Weekday of Order Date', "DATENAME('weekday', [Order Date])", 'string']);
	const [ws] = out.worksheets;
	const [filter] = ws.filters;
	assert.equal(filter.fieldId, field.id);
	assert.deepEqual(filter.exclude, ['Sunday', 'Saturday', null]);
	assert.equal(ws.pills[filter.pillId].datePart, null);
	assert.deepEqual([ws.windowCards[0].param, ws.quickFilters[0].pillId, Object.keys(ws.filterTitles)[0], out.dashboards[0].zones[0].param], Array(4).fill(filter.pillId));
});

test('a date part filter no control shows is left alone', () => {
	const plain = ir(false);
	assert.equal(withDatePartFilterFields(plain), plain);
});
