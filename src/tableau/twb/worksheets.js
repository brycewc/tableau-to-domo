import { colorEncodings, paneLabelAlign, paneLabelColor, paneMarkColor, resolveColorEncoding } from './colors.js';
import { fieldFromColumn, fieldFromGroup } from './fields.js';
import { parseFilter } from './filters.js';
import { flattenShelf, parsePillId, parseShelf, unescapeMemberPillId } from './shelf.js';
import { tableStyle, textRuns } from './style.js';
import { formattedText, parseLiteral } from './xml.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../../model/types.js').PillIR} PillIR
 * @typedef {import('../../model/types.js').PaneIR} PaneIR
 * @typedef {import('../../model/types.js').SortIR} SortIR
 * @typedef {import('../../model/types.js').FilterIR} FilterIR
 * @typedef {import('../../model/types.js').TableCalcIR} TableCalcIR
 * @typedef {import('../../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../../model/types.js').Issue} Issue
 *
 * @typedef {Object} WorksheetContext
 * @property {Map<string, DatasourceIR>} datasources
 * @property {Set<string>} hidden
 * @property {Issue[]} issues
 * @property {Map<string, FilterIR[]>} [sharedFilters]  Datasource id -> "apply to all worksheets" filters
 * @property {Map<string, Map<string, import('../../model/types.js').ColorEncodingIR>>} [colorEncodings]  Datasource id -> its
 *   color encodings (Edit Colors on a field), by column instance
 */

const ENCODINGS = {
	color: 'color',
	size: 'size',
	text: 'text',
	label: 'label',
	tooltip: 'tooltip',
	lod: 'detail',
	shape: 'shape',
	'wedge-size': 'wedgeSize',
	path: 'path',
	geometry: 'geometry'
};
const MEASURE_NAMES = '[:Measure Names]';
const SORT_KINDS = { 'computed-sort': 'computed', 'natural-sort': 'natural', 'manual-sort': 'manual', 'alphabetic-sort': 'alphabetic' };

/**
 * @param {XmlNode} ci <column-instance>
 * @param {PillIR} pill
 * @returns {TableCalcIR|undefined}
 */
function parseTableCalc(ci, pill) {
	const [primary, secondary] = ci.all('table-calc').filter((t) => !t.attr('field'));
	const node = primary || ci.child('table-calc');
	if (!node) return pill.tableCalc;
	const calc = tableCalcSetting(node, pill.tableCalc?.type || (pill.prefix === 'usr' ? 'Calculation' : 'Custom'), pill.tableCalc?.attrs);
	if (secondary) calc.secondary = tableCalcSetting(secondary, 'Custom');
	const prefix = `[${pill.datasourceId}].`;
	const nested = ci.all('table-calc').filter((t) => t !== node && t.attr('field'));
	if (nested.length) {
		calc.nested = Object.fromEntries(
			nested.map((t) => {
				const field = t.attr('field');
				return [field.startsWith(prefix) ? field.slice(prefix.length) : field, tableCalcSetting(t, 'Calculation')];
			})
		);
	}
	return calc;
}

/** @returns {TableCalcIR} */
function tableCalcSetting(node, defaultType, baseAttrs = {}) {
	const { type, 'ordering-type': orderingType, 'ordering-field': orderingField, ...rest } = node.attrs;
	delete rest.field;
	const calc = { type: type || defaultType };
	if (orderingType) calc.orderingType = orderingType;
	const orderFields = [orderingField, ...node.all('order').map((o) => o.attr('field'))].filter(Boolean);
	if (orderFields.length) calc.orderFields = orderFields;
	const attrs = { ...baseAttrs, ...rest };
	const sort = node.child('sort');
	if (sort?.attr('using')) attrs['sort-using'] = sort.attr('using');
	if (sort?.attr('direction')) attrs['sort-direction'] = sort.attr('direction');
	if (Object.keys(attrs).length) calc.attrs = attrs;
	return calc;
}

function pillFromInstance(datasourceId, ci) {
	const id = `[${datasourceId}].${ci.attr('name')}`;
	const pill = parsePillId(id, { column: ci.attr('column'), derivation: ci.attr('derivation'), type: ci.attr('type') });
	const tableCalc = parseTableCalc(ci, pill);
	if (tableCalc) pill.tableCalc = tableCalc;
	return pill;
}

function mergeDependencyFields(datasource, deps, unknown) {
	if (!datasource) return;
	const known = new Set(datasource.fields.map((f) => f.id));
	const instances = new Map();
	for (const ci of deps.all('column-instance')) if (ci.attr('name') && ci.attr('column')) instances.set(ci.attr('name'), ci.attr('column'));
	for (const col of deps.all('column')) {
		const id = col.attr('name');
		if (!id || known.has(id)) continue;
		const field = fieldFromColumn(col, undefined, {});
		if (field) {
			datasource.fields.push(field);
			known.add(id);
		}
	}
	for (const group of deps.all('group')) {
		if (known.has(group.attr('name'))) continue;
		const field = fieldFromGroup(group, instances, unknown);
		if (field) {
			datasource.fields.push(field);
			known.add(field.id);
		}
	}
}

/** The `<view><datasources>` list is not ordered primary-first, so rank blend members by how many shelf pills each one supplies. */
function orderPrimaryFirst(datasourceIds, pillDatasources) {
	const score = new Map(datasourceIds.map((id) => [id, 0]));
	const first = new Map();
	pillDatasources.forEach((id, index) => {
		if (!score.has(id)) return;
		score.set(id, score.get(id) + 1);
		if (!first.has(id)) first.set(id, index);
	});
	const original = [...datasourceIds];
	datasourceIds.sort((a, b) => score.get(b) - score.get(a) || (first.get(a) ?? Infinity) - (first.get(b) ?? Infinity) || original.indexOf(a) - original.indexOf(b));
}

const FIXED_RANGE_BOUNDS = { fixed: ['min', 'max'], fixedmin: ['min'], fixedmax: ['max'] };

/** `<style-rule element='axis'><encoding attr='space' range-type='fixed|fixedmin|fixedmax' min max>` (Edit Axis > Fixed, Fixed start, Fixed end). */
function fixedAxes(table, resolvePill) {
	const axes = [];
	for (const rule of (table?.child('style')?.all('style-rule') || []).filter((r) => r.attr('element') === 'axis')) {
		for (const enc of rule.all('encoding')) {
			const bounds = FIXED_RANGE_BOUNDS[enc.attr('range-type')];
			if (enc.attr('attr') !== 'space' || !bounds || !enc.attr('field')) continue;
			const axis = { pillId: resolvePill(enc.attr('field')).id };
			for (const key of bounds) {
				const value = Number(enc.attr(key));
				if (enc.attr(key) !== undefined && Number.isFinite(value)) axis[key] = value;
			}
			if (axis.min !== undefined || axis.max !== undefined) axes.push(axis);
		}
	}
	return axes;
}

/**
 * Parse one <worksheet>.
 * @param {XmlNode} node
 * @param {WorksheetContext} ctx
 * @returns {WorksheetIR}
 */
export function parseWorksheet(node, ctx) {
	const name = node.attr('name') || 'Sheet';
	const table = node.child('table');
	const view = table?.child('view');
	const object = { type: 'worksheet', name };

	const datasourceIds = (view?.child('datasources')?.all('datasource') || []).map((d) => d.attr('name')).filter((id) => id && id !== 'Parameters');

	/** @type {Record<string, PillIR>} */
	const pills = {};
	for (const deps of view?.all('datasource-dependencies') || []) {
		const dsId = deps.attr('datasource');
		if (!dsId) continue;
		const unknown = [];
		mergeDependencyFields(ctx.datasources.get(dsId), deps, unknown);
		if (unknown.length) ctx.issues.push({ severity: 'warning', code: 'twb.unknown-groupfilter', message: `Sets in worksheet "${name}" use unsupported groupfilter function(s): ${[...new Set(unknown)].join(', ')}`, object });
		for (const ci of deps.all('column-instance')) {
			if (!ci.attr('name')) continue;
			const pill = pillFromInstance(dsId, ci);
			pills[pill.id] = pill;
		}
	}
	const resolvePill = (id) => {
		if (pills[id]) return pills[id];
		const pill = parsePillId(id);
		pills[id] = pill;
		return pill;
	};

	const rows = parseShelf(table?.childText('rows'));
	const cols = parseShelf(table?.childText('cols'));
	const rowPills = flattenShelf(rows);
	const colPills = flattenShelf(cols);
	[...rowPills, ...colPills].forEach(resolvePill);

	/** @type {PaneIR[]} */
	const panes = [];
	for (const pane of table?.child('panes')?.all('pane') || []) {
		/** @type {PaneIR} */
		const ir = { markClass: pane.child('mark')?.attr('class') || 'Automatic', encodings: {} };
		if (pane.attr('id') !== undefined) ir.id = pane.attr('id');
		if (pane.attr('x-axis-name')) ir.xAxisPill = resolvePill(pane.attr('x-axis-name')).id;
		if (pane.attr('y-axis-name')) ir.yAxisPill = resolvePill(pane.attr('y-axis-name')).id;
		for (const enc of pane.child('encodings')?.all() || []) {
			const key = ENCODINGS[enc.name];
			const column = enc.attr('column');
			if (!key || !column) continue;
			(ir.encodings[key] ||= []).push(resolvePill(column).id);
		}
		const labels = pane
			.child('style')
			?.all('style-rule')
			.filter((r) => r.attr('element') === 'mark')
			.flatMap((r) => r.all('format'))
			.find((f) => f.attr('attr') === 'mark-labels-show');
		if (labels) ir.showLabels = labels.attr('value') === 'true';
		const labelWeight = pane
			.child('style')
			?.all('style-rule')
			.filter((r) => r.attr('element') === 'datalabel')
			.flatMap((r) => r.all('format'))
			.find((f) => f.attr('attr') === 'font-weight');
		if (labelWeight?.attr('value') === 'bold') ir.boldLabels = true;
		const labelAlign = paneLabelAlign(pane);
		if (labelAlign) ir.labelAlign = labelAlign;
		const labelColor = paneLabelColor(pane);
		if (labelColor) ir.labelColor = labelColor;
		const markColor = paneMarkColor(pane);
		if (markColor) ir.markColor = markColor;
		const label = formattedText(pane.child('customized-label'));
		if (label) ir.label = label;
		const tooltip = formattedText(pane.child('customized-tooltip'));
		if (tooltip) ir.tooltip = tooltip;
		panes.push(ir);
	}

	/** @type {FilterIR[]} */
	const filters = [];
	/** @type {string[]} */
	const measureValues = [];
	const hiddenMeasures = new Set();
	for (const f of view?.all('filter') || []) {
		const column = f.attr('column');
		if (!column) continue;
		const pill = resolvePill(column);
		if (pill.fieldId === MEASURE_NAMES) {
			for (const facet of parseFilter(f, { resolvePill })) {
				for (const value of facet.include || []) if (typeof value === 'string') measureValues.push(resolvePill(value).id);
				for (const value of facet.exclude || []) if (typeof value === 'string') hiddenMeasures.add(resolvePill(value).id);
			}
			continue;
		}
		if (/^\[(?:Action|Exclusions|Inclusions|Tooltip) \(/.test(pill.fieldId)) {
			ctx.issues.push({
				severity: 'warning',
				code: 'twb.adhoc-selection-filter',
				message: `Worksheet "${name}" filters on ${pill.fieldId}, created by a mark selection or action; it is not migrated`,
				object
			});
			continue;
		}
		filters.push(...parseFilter(f, { resolvePill, issues: ctx.issues, scope: name }));
	}
	for (const col of view?.child('measure-values')?.all('column') || []) {
		const id = unescapeMemberPillId(col.textContent().trim() || col.attr('name'));
		if (id && !measureValues.includes(id)) measureValues.push(resolvePill(id).id);
	}
	for (const dsId of datasourceIds) {
		for (const shared of ctx.sharedFilters?.get(dsId) || []) {
			if (filters.some((f) => f.pillId === shared.pillId && f.kind === shared.kind)) continue;
			resolvePill(shared.pillId);
			filters.push({ ...shared });
		}
	}

	/** @type {SortIR[]} */
	const sorts = [];
	const sortNodes = [...(view?.all() || []), ...(table?.all() || [])].filter((n) => SORT_KINDS[n.name]);
	for (const s of sortNodes) {
		const column = s.attr('column');
		if (!column) continue;
		/** @type {SortIR} */
		const sort = { pillId: resolvePill(column).id, kind: /** @type {SortIR['kind']} */ (SORT_KINDS[s.name]), direction: String(s.attr('direction') || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' };
		if (s.attr('using')) sort.using = resolvePill(s.attr('using')).id;
		if (s.name === 'manual-sort') {
			sort.order = (s.child('dictionary')?.all('bucket') || []).map((b) => parseLiteral(b.textContent()));
		}
		sorts.push(sort);
	}
	for (const s of [...(view?.child('shelf-sorts')?.all() || []), ...(table?.child('shelf-sorts')?.all() || [])]) {
		const dimension = s.attr('dimension-to-sort');
		if (!dimension) continue;
		const measure = s.attr('measure-to-sort-by');
		/** @type {SortIR} */
		const sort = { pillId: resolvePill(dimension).id, kind: measure ? 'computed' : 'natural', direction: String(s.attr('direction') || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' };
		if (measure) sort.using = resolvePill(measure).id;
		if (!sorts.some((x) => x.pillId === sort.pillId)) sorts.push(sort);
	}

	const titleNode = node.child('layout-options')?.child('title');
	const title = titleNode ? formattedText(titleNode, { 'Sheet Name': name }) : undefined;

	const aggregation = view?.child('aggregation')?.attr('value');
	if (datasourceIds.length > 1) {
		orderPrimaryFirst(datasourceIds, [...rowPills, ...colPills, ...panes.flatMap((p) => Object.values(p.encodings).flat())].map((id) => pills[id]?.datasourceId));
		ctx.issues.push({
			severity: 'warning',
			code: 'twb.blend',
			message: `Worksheet "${name}" blends ${datasourceIds.length} datasources; Domo cards use one dataset, so the blend must be rebuilt as a join`,
			object,
			suggestion: 'Join the datasources in Magic ETL on the blend (linking) fields'
		});
	}

	/** @type {WorksheetIR} */
	const ws = {
		name,
		datasourceIds,
		pills,
		rows,
		cols,
		rowPills,
		colPills,
		panes,
		filters,
		sorts,
		aggregated: aggregation !== 'false',
		measureValues: [...new Set(measureValues)].filter((id) => !hiddenMeasures.has(id)),
		hidden: ctx.hidden.has(name)
	};
	if (title) {
		ws.title = title;
		const runs = textRuns(titleNode);
		if (runs) ws.titleRuns = runs;
	}
	const hiddenHeaders = (table?.child('style')?.all('style-rule') || [])
		.filter((r) => r.attr('element') === 'label')
		.flatMap((r) => r.all('format'))
		.filter((f) => f.attr('attr') === 'display' && f.attr('value') === 'false' && f.attr('field'))
		.map((f) => resolvePill(f.attr('field')).id);
	if (hiddenHeaders.length) ws.hiddenHeaders = [...new Set(hiddenHeaders)];
	const linkStyled = (table?.child('style')?.all('style-rule') || [])
		.filter((r) => r.attr('element') === 'label')
		.flatMap((r) => r.all('format'))
		.filter((f) => f.attr('attr') === 'text-decoration' && f.attr('value') === 'underline' && f.attr('field') && !f.attr('data-class'))
		.map((f) => resolvePill(f.attr('field')).id);
	if (linkStyled.length) ws.linkStyled = [...new Set(linkStyled)];
	const numberFormats = {};
	for (const element of ['cell', 'label']) {
		for (const rule of (table?.child('style')?.all('style-rule') || []).filter((r) => r.attr('element') === element)) {
			for (const f of rule.all('format')) {
				const field = f.attr('field');
				if (f.attr('attr') === 'text-format' && field && pills[field] && f.attr('value') && !(field in numberFormats)) numberFormats[field] = f.attr('value');
			}
		}
	}
	if (Object.keys(numberFormats).length) ws.numberFormats = numberFormats;
	const axes = fixedAxes(table, resolvePill);
	if (axes.length) ws.axes = axes;
	const filterTitles = {};
	for (const rule of (table?.child('style')?.all('style-rule') || []).filter((r) => r.attr('element') === 'quick-filter')) {
		for (const f of rule.all('format')) {
			const title = String(f.attr('value') ?? '').trim();
			if (f.attr('attr') === 'title' && f.attr('field') && title) filterTitles[f.attr('field')] = title;
		}
	}
	if (Object.keys(filterTitles).length) ws.filterTitles = filterTitles;
	const totals = {};
	if (table?.child('rows')?.attr('total') === 'true') totals.rows = true;
	if (table?.child('cols')?.attr('total') === 'true') totals.cols = true;
	if (table?.child('rows')?.attr('onTop') === 'true') totals.rowsOnTop = true;
	if (table?.child('cols')?.attr('onLeft') === 'true') totals.colsOnLeft = true;
	const subtotals = (table?.child('subtotals')?.all('column') || []).map((c) => c.textContent().trim()).filter(Boolean);
	if (subtotals.length) totals.subtotals = [...new Set(subtotals.map((id) => resolvePill(id).id))];
	if (Object.keys(totals).length) ws.totals = totals;
	const shading = tableStyle(table?.child('style'));
	if (shading) ws.tableStyle = shading;
	const overrides = {};
	for (const [key, tag] of [['include', 'join-lod-include-overrides'], ['exclude', 'join-lod-exclude-overrides']]) {
		const columns = (table?.child(tag)?.all('column') || []).map((c) => c.textContent().trim()).filter(Boolean);
		if (columns.length) overrides[key] = columns;
	}
	if (Object.keys(overrides).length) ws.linkOverrides = overrides;
	const colorPill = panes.flatMap((p) => p.encodings.color ?? [])[0];
	const color = colorPill ? resolveColorEncoding(colorPill, colorEncodings(table?.child('style')), ctx.colorEncodings ?? new Map()) : undefined;
	if (color) ws.color = { pillId: colorPill, ...color };
	const paneColors = {};
	for (const pillId of panes.flatMap((p) => p.encodings.color ?? [])) {
		if (pillId === colorPill || paneColors[pillId]) continue;
		const encoding = resolveColorEncoding(pillId, colorEncodings(table?.child('style')), ctx.colorEncodings ?? new Map());
		if (encoding) paneColors[pillId] = encoding;
	}
	if (Object.keys(paneColors).length) ws.paneColors = paneColors;
	const markColor = (table?.child('panes')?.all('pane') || []).map(paneMarkColor).find(Boolean);
	if (markColor) ws.markColor = markColor;
	return ws;
}
