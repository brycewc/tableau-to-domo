export const COLUMNS = {
	'[Sales]': 'real',
	'[Profit]': 'real',
	'[Discount]': 'real',
	'[Quantity]': 'integer',
	'[Region]': 'string',
	'[Category]': 'string',
	'[Customer Name]': 'string',
	'[Product]': 'string',
	'[Order Date]': 'date',
	'[Ship Date]': 'date',
	'[Order Time]': 'datetime',
	'[Ship Time]': 'datetime',
	'[Is Returned]': 'boolean',
	'[Weird]]Name]': 'string',
	'[Code]': 'string'
};

export const PARAMETERS = {
	'[Parameters].[Top N]': { id: '[Parameters].[Top N]', name: 'Top N', datatype: 'integer', domain: 'range', value: 10 },
	'[Parameters].[Region Choice]': { id: '[Parameters].[Region Choice]', name: 'Region Choice', datatype: 'string', domain: 'list', value: "O'Brien" },
	'[Parameters].[Start]': { id: '[Parameters].[Start]', name: 'Start', datatype: 'date', domain: 'all', value: '2024-01-15' },
	'[Parameters].[Grain]': { id: '[Parameters].[Grain]', name: 'Grain', datatype: 'string', domain: 'list', value: 'month' },
	'[Parameters].[Rate]': { id: '[Parameters].[Rate]', name: 'Rate', datatype: 'real', domain: 'all', value: 0.25 }
};

export const CALCS = {
	'[Calculation_1]': { id: '[Calculation_1]', name: 'Profit Ratio', datatype: 'real', kind: 'calculated', formula: 'SUM([Profit]) / SUM([Sales])' },
	'[Calculation_2]': { id: '[Calculation_2]', name: 'Label', datatype: 'string', kind: 'calculated', formula: '[Region] + "-" + [Category]' },
	'[Calculation_3]': { id: '[Calculation_3]', name: 'Margin', datatype: 'real', kind: 'calculated', formula: '[Profit] - [Discount]' },
	'[Calculation_4]': { id: '[Calculation_4]', name: 'Uses Margin', datatype: 'real', kind: 'calculated', formula: '[Calculation_3] * 2' },
	'[Cycle A]': { id: '[Cycle A]', name: 'Cycle A', datatype: 'real', kind: 'calculated', formula: '[Cycle B] + 1' },
	'[Cycle B]': { id: '[Cycle B]', name: 'Cycle B', datatype: 'real', kind: 'calculated', formula: '[Cycle A] + 1' },
	'[Customer Sales]': { id: '[Customer Sales]', name: 'Customer Sales', datatype: 'real', kind: 'calculated', formula: '{FIXED [Customer Name] : SUM([Sales])}' },
	'[First Order]': { id: '[First Order]', name: 'First Order', datatype: 'date', kind: 'calculated', formula: '{FIXED [Customer Name] : MIN([Order Date])}' },
	'[Is Big]': { id: '[Is Big]', name: 'Is Big', datatype: 'boolean', kind: 'calculated', formula: '[Sales] > 1000' },
	'[Broken]': { id: '[Broken]', name: 'Broken', datatype: 'real', kind: 'calculated', formula: 'SUM([Sales]' }
};

export function resolveField(id) {
	if (COLUMNS[id]) {
		const column = id.slice(1, -1).replace(/\]\]/g, ']');
		return { kind: 'column', column, datatype: COLUMNS[id] };
	}
	if (PARAMETERS[id]) return { kind: 'parameter', parameter: PARAMETERS[id] };
	if (CALCS[id]) return { kind: 'calc', field: CALCS[id] };
	return undefined;
}

export const baseCtx = (extra = {}) => ({ resolveField, datasourceId: '[federated.abc]', ...extra });

export const codes = (result) => result.issues.map((i) => i.code);
