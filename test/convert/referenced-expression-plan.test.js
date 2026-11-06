import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertWorkbook } from '../../src/convert/index.js';

const DS = 'federated.abc';
const YEAR = `[${DS}].[yr:Calculation_2:ok]`;
const SALES = `[${DS}].[sum:Sales:qk]`;
const pill = (id, fieldId, derivation, prefix, typeKey, extra = {}) => ({ id, datasourceId: DS, fieldId, derivation, prefix, typeKey, continuous: typeKey === 'qk', aggregated: prefix === 'sum', datePart: null, dateTrunc: null, ...extra });

function workbook(formula) {
	return {
		irVersion: 2,
		workbook: { name: 'W', luid: 'L', sourceFile: 'x.twbx' },
		parameters: [],
		dashboards: [],
		issues: [],
		datasources: [
			{
				id: DS,
				caption: 'Superstore',
				connections: [],
				tables: [{ id: 'Orders', name: 'Orders', kind: 'extract', columns: [] }],
				relationships: [],
				filters: [],
				fields: [
					{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column' },
					{ id: '[Order Date]', name: 'Order Date', datatype: 'date', role: 'dimension', kind: 'column' },
					{ id: '[Sales]', name: 'Sales', datatype: 'real', role: 'measure', kind: 'column' },
					{ id: '[Calculation_2]', name: 'Selected Date', datatype: 'date', role: 'dimension', kind: 'calculated', formula }
				]
			}
		],
		worksheets: [
			{
				name: 'By Year',
				datasourceIds: [DS],
				pills: { [YEAR]: pill(YEAR, '[Calculation_2]', 'Year', 'yr', 'ok', { datePart: 'year' }), [SALES]: pill(SALES, '[Sales]', 'Sum', 'sum', 'qk') },
				rows: { op: 'pill', pillId: YEAR },
				cols: { op: 'pill', pillId: SALES },
				rowPills: [YEAR],
				colPills: [SALES],
				panes: [{ markClass: 'Bar', encodings: {} }],
				filters: [],
				sorts: [],
				aggregated: true,
				measureValues: [],
				hidden: false
			}
		]
	};
}

const manifest = {
	datasourceId: DS,
	strategy: 'hyper',
	tables: [{ name: 'Extract', file: 'data/x.csv', columns: [{ name: 'Region', type: 'STRING' }, { name: 'Order Date', type: 'DATE' }, { name: 'Sales', type: 'DOUBLE' }], rowCount: 3, flattened: true }],
	issues: []
};

test('a long calc only a card formula reads gets its dataset beast mode, which the card formula references', () => {
	const formula = `CASE [Region] ${Array.from({ length: 300 }, (_, i) => `WHEN "r${i}" THEN DATEADD('day', ${i}, [Order Date])`).join(' ')} END`;
	const plan = convertWorkbook(workbook(formula), { manifests: [manifest], options: { target: 'pages' } });
	const bm = plan.beastModes.find((b) => b.name === 'Selected Date');
	assert.ok(bm, 'the beast mode is kept');
	assert.ok(!plan.issues.some((i) => i.code === 'calc.unused' && i.object?.name === 'Selected Date'));
	const formulas = plan.cards.flatMap((c) => c.body?.definition?.formulas?.card ?? []);
	assert.ok(formulas.some((f) => f.formula.replace(/\s+/g, '') === `YEAR(DOMO_BEAST_MODE(${bm.legacyId}))`), JSON.stringify(formulas.map((f) => f.formula.slice(0, 100))));

	const short = convertWorkbook(workbook("DATEADD('day', 1, [Order Date])"), { manifests: [manifest], options: { target: 'pages' } });
	assert.ok(!short.beastModes.some((b) => b.name === 'Selected Date'), 'a short calc is inlined and gets no beast mode');
	assert.ok(short.issues.some((i) => i.code === 'calc.unused' && i.object?.name === 'Selected Date'));
});
