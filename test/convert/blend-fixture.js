// A workbook that blends a Targets datasource into Sales on Region = Area (a custom relationship).
export const P = 'federated.sales';
export const S = 'federated.targets';

const col = (id, datatype = 'string', role = 'dimension') => ({ id: `[${id}]`, name: id, datatype, role, kind: 'column' });
const pill = (ds, prefix, field, typeKey = prefix === 'none' ? 'nk' : 'qk') => `[${ds}].[${prefix}:${field}:${typeKey}]`;

const DERIVATIONS = { none: 'None', sum: 'Sum', usr: 'User', avg: 'Avg', yr: 'Year' };
function pills(ids) {
	return Object.fromEntries(
		ids.map((id) => {
			const [, ds, prefix, field, typeKey] = /^\[(.+?)\]\.\[(\w+):(.+):(\w+)\]$/.exec(id);
			return [id, { id, datasourceId: ds, fieldId: `[${field}]`, derivation: DERIVATIONS[prefix], prefix, typeKey, continuous: typeKey === 'qk', aggregated: prefix !== 'none' && prefix !== 'yr', datePart: prefix === 'yr' ? 'year' : null, dateTrunc: null }];
		})
	);
}

function sheet(name, { rows = [], text = [], filters = [], extra = [], linkOverrides } = {}) {
	return {
		name,
		datasourceIds: [P, S],
		pills: pills([...new Set([...rows, ...text, ...filters.map((f) => f.pillId), ...extra])]),
		rows: null,
		cols: null,
		rowPills: rows,
		colPills: [],
		panes: [{ markClass: 'Text', encodings: { text } }],
		filters,
		sorts: [],
		aggregated: true,
		measureValues: [],
		hidden: false,
		...(linkOverrides ? { linkOverrides } : {})
	};
}

export const pillIds = {
	region: pill(P, 'none', 'Region'),
	sales: pill(P, 'sum', 'Sales'),
	ratio: pill(P, 'usr', 'Attainment'),
	target: pill(S, 'sum', 'Target'),
	manager: pill(S, 'none', 'Manager'),
	segment: pill(S, 'none', 'Segment'),
	area: pill(S, 'none', 'Area'),
	year: pill(P, 'yr', 'Order Date', 'ok')
};

export function blendIr() {
	const segmentA = { pillId: pillIds.segment, datasourceId: S, fieldId: '[Segment]', kind: 'categorical', include: ['A'] };
	return {
		irVersion: 1,
		workbook: { name: 'Blend', sourceFile: 'blend.twb' },
		datasources: [
			{
				id: P,
				caption: 'Sales',
				connections: [],
				tables: [],
				relationships: [],
				fields: [col('Region'), col('Product'), col('Sales', 'real', 'measure'), col('Order Date', 'date'), { id: '[Attainment]', name: 'Attainment', datatype: 'real', role: 'measure', kind: 'calculated', formula: `SUM([Sales]) / SUM([${S}].[Target])` }],
				filters: []
			},
			{
				id: S,
				caption: 'Targets',
				connections: [],
				tables: [],
				relationships: [],
				fields: [col('Area'), col('Manager'), col('Segment'), col('Target', 'real', 'measure'), col('Target Date', 'date')],
				filters: []
			}
		],
		parameters: [],
		worksheets: [
			sheet('By Region', { rows: [pillIds.region, pillIds.manager], text: [pillIds.sales, pillIds.target, pillIds.ratio] }),
			sheet('Region Targets', { rows: [pillIds.region], text: [pillIds.target] }),
			sheet('Total', { text: [pillIds.sales, pillIds.target], linkOverrides: { include: [`[${S}].[Area]`] } }),
			sheet('Segment A', { rows: [pillIds.region], text: [pillIds.target], filters: [segmentA] }),
			sheet('By Year', { rows: [pillIds.year], text: [pillIds.sales, pillIds.target] }),
			sheet('Area Filter', { rows: [pillIds.region], text: [pillIds.sales], filters: [{ pillId: pillIds.area, datasourceId: S, fieldId: '[Area]', kind: 'categorical', include: ['East'] }] })
		],
		dashboards: [],
		issues: [],
		blendRelationships: [{ source: P, target: S, mappings: [{ source: '[Region]', target: '[Area]' }, { source: '[Order Date]', target: '[Target Date]' }] }]
	};
}

export const primaryRows = [
	['East', 'A', 10, '2023-03-01'],
	['East', 'B', 20, '2024-01-15'],
	['West', 'A', 5, '2023-07-04'],
	['West', 'C', 7, '2024-02-02'],
	['North', 'A', 3, '2024-05-05']
];
export const secondaryRows = [
	['East', 'Ann', 'A', 100, '2023-01-01'],
	['East', 'Ann', 'B', 50, '2024-01-01'],
	['West', 'Bob', 'A', 30, '2023-01-01'],
	['West', 'Cid', 'A', 20, '2024-01-01'],
	['South', 'Dan', 'A', 999, '2024-01-01']
];

export function blendManifests() {
	return [
		{
			datasourceId: P,
			strategy: 'hyper',
			tables: [{ name: 'Sales', file: 'data/sales.csv', rowCount: primaryRows.length, flattened: true, columns: [{ name: 'Region', type: 'STRING' }, { name: 'Product', type: 'STRING' }, { name: 'Sales', type: 'DOUBLE' }, { name: 'Order Date', type: 'DATE' }] }],
			issues: []
		},
		{
			datasourceId: S,
			strategy: 'hyper',
			tables: [{ name: 'Targets', file: 'data/targets.csv', rowCount: secondaryRows.length, flattened: true, columns: [{ name: 'Area', type: 'STRING' }, { name: 'Manager', type: 'STRING' }, { name: 'Segment', type: 'STRING' }, { name: 'Target', type: 'DOUBLE' }, { name: 'Target Date', type: 'DATE' }] }],
			issues: []
		}
	];
}
