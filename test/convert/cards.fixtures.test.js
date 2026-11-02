import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePillId, flattenShelf, parseShelf } from '../../src/tableau/twb/shelf.js';

export const DS = 'federated.abc';
export const DATASET = 'superstore';

const f = (id, datatype, role, extra = {}) => ({ id: `[${id}]`, name: id, datatype, role, kind: 'column', ...extra });

export const FIELDS = [
	f('Region', 'string', 'dimension'),
	f('Category', 'string', 'dimension'),
	f('Sub-Category', 'string', 'dimension'),
	f('Customer', 'string', 'dimension'),
	f('Segment', 'string', 'dimension'),
	f('Sales', 'real', 'measure'),
	f('Profit', 'real', 'measure'),
	f('Quantity', 'integer', 'measure'),
	f('Duration', 'integer', 'measure'),
	f('Fiscal Year', 'integer', 'dimension'),
	f('Store Number', 'integer', 'dimension', { defaultFormat: 'n#,##0;-#,##0' }),
	f('Order Date', 'date', 'dimension'),
	f('Ship Date', 'datetime', 'dimension'),
	f('State', 'string', 'dimension', { semanticRole: '[State].[Name]' }),
	f('County', 'string', 'dimension', { semanticRole: '[County].[Name]' }),
	f('Country', 'string', 'dimension', { semanticRole: '[Country].[Name]' }),
	f('City', 'string', 'dimension', { semanticRole: '[City].[Name]' }),
	f('Lat', 'real', 'measure', { semanticRole: '[Geographical].[Latitude]' }),
	f('Lon', 'real', 'measure', { semanticRole: '[Geographical].[Longitude]' }),
	f('Profit Ratio', 'real', 'measure', { kind: 'calculated', formula: 'SUM([Profit])/SUM([Sales])' }),
	f('Is Big', 'string', 'dimension', { kind: 'calculated', formula: "IF [Sales] > 100 THEN 'Y' ELSE 'N' END" }),
	f('Sales (bin)', 'integer', 'dimension', { kind: 'bin', bin: { source: '[Sales]', size: 100 } }),
	f('Broken', 'string', 'dimension', { kind: 'calculated' })
];

const DOMO_TYPES = { string: 'STRING', real: 'DOUBLE', integer: 'LONG', date: 'DATE', datetime: 'DATETIME' };

/** Fake FieldBindings: plain columns, one aggregated beast mode, one row-level beast mode, one unsupported. */
export function makeBindings(overrides = {}) {
	const map = new Map();
	for (const field of FIELDS) {
		let binding = { datasetKey: DATASET, kind: 'column', name: field.name, column: field.name, aggregated: false, dataType: DOMO_TYPES[field.datatype], tableauType: field.datatype };
		if (field.name === 'Profit Ratio') binding = { datasetKey: DATASET, kind: 'formula', name: field.name, formulaId: 'calculation_pr', expression: 'SUM(`Profit`) / SUM(`Sales`)', aggregated: true, dataType: 'DOUBLE', tableauType: 'real' };
		if (field.name === 'Is Big') binding = { datasetKey: DATASET, kind: 'formula', name: field.name, formulaId: 'calculation_big', expression: "CASE WHEN `Sales` > 100 THEN 'Y' ELSE 'N' END", aggregated: false, dataType: 'STRING', tableauType: 'string' };
		if (field.name === 'Broken') binding = { datasetKey: DATASET, kind: 'unsupported', name: field.name, aggregated: false, reason: 'table calc' };
		if (field.name === 'Sales (bin)') binding = { datasetKey: DATASET, kind: 'formula', name: field.name, formulaId: 'calculation_bin', expression: 'FLOOR(`Sales` / 100) * 100', aggregated: false, dataType: 'LONG', tableauType: 'integer' };
		map.set(field.id, binding);
	}
	for (const [k, v] of Object.entries(overrides)) map.set(k, v);
	return {
		get: (ds, fieldId) => (ds === DS ? map.get(fieldId) : undefined),
		datasetKeyFor: (ds) => (ds === DS ? DATASET : undefined)
	};
}

/** Pill id: p('sum', 'Sales', 'qk') -> '[federated.abc].[sum:Sales:qk]'. */
export const p = (derivation, name, type = 'nk') => `[${DS}].[${derivation}:${name}:${type}]`;

/**
 * Build a WorksheetIR from shelf expressions and pane specs.
 * @param {Object} spec
 */
export function sheet({ name = 'Sheet 1', rows = '', cols = '', panes, mark = 'Automatic', enc = {}, filters = [], sorts = [], aggregated = true, hidden = false, measureValues = [], title, color } = {}) {
	const rowsNode = parseShelf(rows);
	const colsNode = parseShelf(cols);
	const paneList = panes ?? [{ markClass: mark, encodings: enc }];
	const ids = new Set([...flattenShelf(rowsNode), ...flattenShelf(colsNode), ...measureValues]);
	for (const pane of paneList) for (const list of Object.values(pane.encodings ?? {})) for (const id of list) ids.add(id);
	for (const fl of filters) if (fl.pillId) ids.add(fl.pillId);
	for (const s of sorts) {
		ids.add(s.pillId);
		if (s.using) ids.add(s.using);
	}
	const pills = {};
	for (const id of ids) pills[id] = parsePillId(id);
	return {
		name,
		title,
		datasourceIds: [DS],
		pills,
		rows: rowsNode,
		cols: colsNode,
		rowPills: flattenShelf(rowsNode),
		colPills: flattenShelf(colsNode),
		panes: paneList,
		filters,
		sorts,
		aggregated,
		measureValues,
		hidden,
		...(color ? { color } : {})
	};
}

export function workbook({ worksheets = [], dashboards = [], parameters = [], name = 'Superstore' } = {}) {
	return {
		irVersion: 1,
		workbook: { name, sourceFile: 'x.twb' },
		datasources: [{ id: DS, caption: 'Orders', connections: [], tables: [], relationships: [], fields: FIELDS, filters: [] }],
		parameters,
		worksheets,
		dashboards,
		issues: []
	};
}

export const cat = (pillName, include, extra = {}) => ({ pillId: p('none', pillName), datasourceId: DS, fieldId: `[${pillName}]`, kind: 'categorical', include, ...extra });

test('fixtures build a worksheet with parsed pills', () => {
	const ws = sheet({ rows: p('sum', 'Sales', 'qk'), cols: p('none', 'Region') });
	assert.equal(ws.rowPills.length, 1);
	assert.equal(ws.pills[p('sum', 'Sales', 'qk')].aggregated, true);
	assert.equal(makeBindings().get(DS, '[Sales]').column, 'Sales');
});
