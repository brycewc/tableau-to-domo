import { ref } from '../util/refs.js';
import { slugify } from '../util/ids.js';
import { stripBrackets } from '../model/naming.js';
import { resolveTitle } from './titles.js';
import { inferChart, pillFor, findField, markPanes, KPI_TYPES, MEASURE_SLOTS } from './chart-types.js';
import { MAX_SPLIT_CARDS, SPLIT_MEMBER } from './split.js';
import { CALENDAR_INTERVALS, toCardFilters, toQuickFilterControls, bindingExpression, datePartFormula, pillWindowItem, refOf, exceedsSlicerLimit, memberCondition, filterRef, filterDataType, dashboardFilterScopes } from './filters.js';
import { hiddenScope, tableCalcAlong } from './hidden-members.js';
import { fiscalStartName } from './fiscal.js';
import { topRankReason } from './top-rank.js';
import { quickCalcType, quickTableCalcSql, tableCalcAddressing } from './calc/tablecalc.js';
import { axisRangeOverrides, legendOverrides, legendPlacements, markTextOverrides, negativeNumberOverrides, stackSortOverrides } from './chart-options.js';
import { cardColorRules } from './colors.js';
import { isTableChart, planDrillPath } from './drill.js';
import { domoNumberFormat, fieldColumnFormat, fieldNumberFormat, negativeStyle } from './number-format.js';
import { hyperlinkFormula, nativeLinkFormat, parseUrlToken, pickLinkColumn, templateParts, urlActionSheets, withScheme } from './url-columns.js';
import { NULL_VALUE, conditionAggregates, quoteString } from './calc/sql.js';
import { opaqueHex } from './app-layout.js';

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../model/types.js').FieldBindings} FieldBindings
 * @typedef {import('../model/types.js').FieldBinding} FieldBinding
 * @typedef {import('../model/types.js').ConvertOptions} ConvertOptions
 * @typedef {import('../model/types.js').CardPlan} CardPlan
 * @typedef {import('../model/types.js').Issue} Issue
 * @typedef {import('./chart-types.js').SlotMapping} SlotMapping
 */

export const CHART_VERSION = '12';

export const GRAIN_COLUMNS = {
	year: 'Year',
	quarter: 'CalendarQuarter',
	month: 'CalendarMonth',
	week: 'CalendarWeek',
	day: 'Date',
	hour: 'CalendarHour',
	minute: 'CalendarMinute',
	second: 'CalendarMinute'
};
export const GRAIN_ELEMENTS = { year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', week: 'WEEK', day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'MINUTE' };

const AGGREGATIONS = {
	sum: 'SUM',
	avg: 'AVG',
	average: 'AVG',
	count: 'COUNT',
	min: 'MIN',
	max: 'MAX',
	median: 'MEDIAN',
	stdev: 'STDDEV',
	stdevp: 'STDDEV_POP',
	varp: 'VAR_POP'
};
// Card column aggregations have no COUNT DISTINCT or sample variance, so these become aggregated card formulas.
const CARD_FORMULA_AGGREGATIONS = {
	countd: { label: 'Distinct count', wrap: (expr) => `COUNT(DISTINCT ${expr})` },
	var: { label: 'Variance', wrap: (expr) => `VAR(${expr})` }
};
const UNSUPPORTED_AGGREGATIONS = new Set(['kurtosis', 'skewness', 'collect']);
const NEEDS_ITEM = /^badge_(vert|horiz|two_trendline|trendline|stackedtrend|line_bar|horiz_line_bar|pie|donut|map_us|world_map|map$|heatmap$|treemap|gantt)/;
const SCATTER = /^badge_(xyscatterplot|xybubble|bubble)/;

/**
 * Empty write-shape collections every card body needs. `formulas` is mandatory:
 * CardKpiResource.validateRequest dereferences it without a null guard.
 */
function definitionCollections(cardFormulas = [], colorRules = []) {
	return {
		formulas: { card: cardFormulas, dsUpdated: [], dsDeleted: [] },
		annotations: { new: [], modified: [], deleted: [] },
		conditionalFormats: { card: colorRules, datasource: [] },
		segments: { active: [], create: [], update: [], delete: [] }
	};
}

/**
 * Build an AnalyzerCardUpdate body for PUT /content/v3/cards/kpi with the dataset id as a $ref.
 *
 * @param {Object} spec
 * @param {string} spec.title
 * @param {Object[]} [spec.titleItems]  Smart text title items (TEXT and VARIABLE_VALUE); default one TEXT item of `title`
 * @param {string} spec.datasetKey
 * @param {string} spec.chartType
 * @param {Object} spec.subscription      columns, groupBy, orderBy, filters, and optional limit/dateGrain/dateRangeFilter/fiscal
 * @param {Object[]} [spec.formulas]      Card-scoped beast modes
 * @param {Object[]} [spec.controls]      Quick filters
 * @param {string} [spec.chartVersion]
 * @param {string} [spec.description]
 * @param {Object} [spec.dynamicDescription]  Smart text description ({ text: items, displayOnCardDetails }); a card update
 *   without it clears the saved one
 * @param {Object} [spec.overrides]       Chart properties, string values as the editor saves them
 * @param {Object[]} [spec.colorRules]    Card color rules (convert/colors.js cardColorRules)
 * @returns {Object}
 */
export function buildCardBody({ title, titleItems, datasetKey, chartType, subscription, formulas = [], controls = [], chartVersion = CHART_VERSION, description = '', dynamicDescription, overrides = {}, colorRules = [] }) {
	const dataSourceId = ref('dataset', datasetKey);
	const main = {
		name: 'main',
		dataSourceId,
		columns: subscription.columns ?? [],
		groupBy: subscription.groupBy ?? [],
		orderBy: subscription.orderBy ?? [],
		filters: subscription.filters ?? []
	};
	if (subscription.limit) main.limit = subscription.limit;
	if (subscription.dateGrain) main.dateGrain = subscription.dateGrain;
	if (subscription.dateRangeFilter) main.dateRangeFilter = subscription.dateRangeFilter;
	Object.assign(main, { fiscal: Boolean(subscription.fiscal), projection: false, distinct: false });
	return {
		dataProvider: { dataSourceId },
		variables: true,
		columns: false,
		definition: {
			title,
			description,
			dynamicTitle: { text: titleItems ?? [{ type: 'TEXT', text: title }] },
			...(dynamicDescription ? { dynamicDescription } : {}),
			chartVersion,
			charts: { main: { component: 'main', chartType, overrides, goal: null } },
			subscriptions: { main },
			...definitionCollections(formulas, colorRules),
			controls,
			allowTableDrill: !isTableChart(chartType)
		}
	};
}

/** Worksheet names placed on any dashboard, and filter zone modes per worksheet. */
export function dashboardUsage(ir) {
	const sheets = new Set();
	const filterZones = new Map();
	for (const dash of ir?.dashboards ?? []) {
		for (const zone of [...(dash.zones ?? []), ...(dash.floating ?? [])]) {
			if (zone.kind === 'worksheet' && zone.worksheet) sheets.add(zone.worksheet);
			if (zone.kind === 'filter' && zone.worksheet && zone.param) {
				if (!filterZones.has(zone.worksheet)) filterZones.set(zone.worksheet, new Map());
				filterZones.get(zone.worksheet).set(zone.param, zone.mode ?? '');
			}
		}
	}
	return { sheets, filterZones };
}

const UPDATE_TIME = /<Data Update Time>/i;
export const LAST_UPDATED_ITEM = 'DATA_SOURCE_DATA_LAST_UPDATED';

/**
 * The line or `|` part of a Tableau title that holds <Data Update Time>, as a "Date last updated" smart text item with the
 * text around the token as its prefix and suffix, and the title without that part. Undefined without the token.
 * @param {string|undefined} raw
 * @returns {{ item: { type: string, prefix?: string, suffix?: string }, title: string }|undefined}
 */
export function updateTimeToken(raw) {
	const lines = String(raw ?? '').split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const parts = lines[i].split('|');
		const j = parts.findIndex((p) => UPDATE_TIME.test(p));
		if (j < 0) continue;
		const [before, ...after] = parts[j].split(UPDATE_TIME);
		const tidy = (s) => s.replace(/<[^<>]+>/g, '').replace(/\s+/g, ' ').trim();
		const prefix = tidy(before);
		const suffix = tidy(after.join(''));
		const item = { type: LAST_UPDATED_ITEM, ...(prefix ? { prefix: `${prefix} ` } : {}), ...(suffix ? { suffix: ` ${suffix}` } : {}) };
		parts.splice(j, 1);
		const rest = parts.join('|').trim();
		if (rest) lines[i] = rest;
		else lines.splice(i, 1);
		return { item, title: lines.join('\n') };
	}
	return undefined;
}

/**
 * Add a smart text item to a card's description, once, and show the description on Card Details as the editor's "Show
 * description on Card Details" does. Mutates the card body.
 * @param {CardPlan} card
 * @param {{ type: string }} item
 */
export function addSmartDescription(card, item) {
	const definition = card.body.definition;
	const current = definition.dynamicDescription ?? { text: definition.description ? [{ type: 'TEXT', text: `${definition.description} ` }] : [], displayOnCardDetails: true };
	if (current.text.some((t) => t.type === item.type)) return;
	definition.dynamicDescription = { ...current, text: [...current.text, item], displayOnCardDetails: true };
}

/** Smart text items of title lines joined with spaces, adjacent TEXT items merged. */
function joinItems(lines) {
	const items = [];
	lines.forEach((line, i) => {
		for (const item of [...(i ? [{ type: 'TEXT', text: ' ' }] : []), ...(line.items ?? [{ type: 'TEXT', text: line.text }])]) {
			const last = items.at(-1);
			if (item.type === 'TEXT' && last?.type === 'TEXT') items[items.length - 1] = { type: 'TEXT', text: last.text + item.text };
			else items.push(item);
		}
	});
	return items;
}

/**
 * Title, description and info issues for a worksheet's card from its Tableau title. <Data Update Time>, <Data Source Name>,
 * dimension fields and parameters planned as Domo variables become smart text items (dynamicTitle, dynamicDescription).
 */
function cardTitle(ws, ir, bindings, variables) {
	const update = updateTimeToken(ws.title);
	const dataSourceName = (ir?.datasources ?? []).find((d) => d.id === ws.datasourceIds?.[0])?.caption;
	const resolved = resolveTitle(update ? update.title : ws.title, bindings, { sheetName: ws.name, ir, variables, smartText: true, dataSourceName });
	const lines = resolved.lines;
	const issues = [];
	if (resolved.filtered.length) {
		const names = [...new Set(resolved.filtered)].join(', ');
		issues.push(makeIssue(ws, 'info', 'card.title-filter', `Title field token(s) ${names} are filter smart text: the card title shows their filtered values, else "All"`));
	}
	if (resolved.fields.length) {
		const names = [...new Set(resolved.fields)].join(', ');
		issues.push(makeIssue(ws, 'info', 'card.title-field', `Title measure token(s) ${names} left out of the card title: Domo smart text cannot show an aggregated value`));
	}
	if (resolved.parameters.length) {
		const values = [...new Map(resolved.parameters.map((p) => [p.name, `${p.name} = ${p.value}`])).values()].join(', ');
		issues.push(makeIssue(ws, 'info', 'card.title-parameter', `Title shows the current parameter value(s) as fixed text (${values}); it does not follow later variable changes`));
	}
	const aliased = [...new Map(resolved.variables.filter((v) => v.aliased).map((v) => [v.name, v])).values()];
	if (aliased.length) {
		issues.push(makeIssue(ws, 'info', 'card.title-variable', `Title follows the Domo variable(s) ${aliased.map((v) => v.name).join(', ')} but shows the raw member value where Tableau shows its alias (${aliased.map((v) => v.value).join(', ')})`));
	}
	const other = resolved.other.filter((t) => !/^data update time$/i.test(t));
	if (update) issues.push(makeIssue(ws, 'info', 'card.title-update-time', `Title Data Update Time is "${update.item.prefix ?? ''}Date last updated" smart text in the card description, shown on the card`));
	if (other.length) issues.push(makeIssue(ws, 'info', 'card.title-field', `Title token(s) ${[...new Set(other)].map((t) => `<${t}>`).join(', ')} have no Domo equivalent; left out of the card title`));
	const rest = lines.slice(1);
	const description = rest.map((l) => l.text).join(' ');
	const smart = rest.some((l) => l.items);
	const descriptionItems = smart ? joinItems(rest) : description ? [{ type: 'TEXT', text: description }] : [];
	if (update && descriptionItems.length) descriptionItems.push({ type: 'TEXT', text: ' ' });
	const merged = joinItems([{ items: descriptionItems }]);
	const dynamicDescription = update || smart ? { text: [...merged, ...(update ? [update.item] : [])], displayOnCardDetails: true } : undefined;
	return { title: lines[0]?.text || ws.name, titleItems: lines[0]?.items, description, dynamicDescription, issues };
}

/** Unique, stable card key per worksheet name, prefixed with the workbook key when given. */
export function cardKeyFor(name, used, workbookKey) {
	const base = workbookKey ? `${workbookKey}.${slugify(name)}` : slugify(name);
	let key = base;
	let n = 2;
	while (used.has(key)) key = `${base}-${n++}`;
	used.add(key);
	return key;
}

function makeIssue(ws, severity, code, message, suggestion) {
	const out = { severity, code, message, object: { type: 'worksheet', name: ws.name } };
	if (suggestion) out.suggestion = suggestion;
	return out;
}

function sqlLiteral(v) {
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	if (typeof v === 'boolean') return v ? "'true'" : "'false'";
	return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const META = new WeakMap();
const COMBINED_SEPARATOR = ' ';
const TABLE_CHARTS = new Set(['badge_pivot_table', 'badge_basic_table', 'badge_table']);

export { PLAIN_INTEGER_FORMAT, plainInteger } from './number-format.js';

const refKey = (r) => (r.formulaId ? `f:${r.formulaId}` : `c:${r.column}${r.calendar ? ':cal' : ''}`);

function aggregateExpression(binding, aggregation) {
	if (binding.aggregated) return binding.expression ? `(${binding.expression})` : binding.formulaId && `\`${binding.formulaId}\``;
	const expr = bindingExpression(binding);
	return expr && `${aggregation ?? 'SUM'}(${expr})`;
}

/** The Tableau name a card column shows when the column itself has another name (a rename calc, a renamed column). */
function columnAlias(ref, binding) {
	if (binding.kind !== 'column' || ref.calendar || ref.formulaId || ref.column !== binding.column) return undefined;
	const name = binding.alias ?? binding.name;
	return name && name !== binding.column ? name : undefined;
}

const QUICK_CALC_LABELS = { PctTotal: '% of Total', CumTotal: 'Running total', Diff: 'Difference', PctDiff: '% Difference', PctValue: 'Percent of', Rank: 'Rank', PctRank: 'Percentile', MovingCalc: 'Moving calculation' };
const RUNNING_LABELS = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count' };

function quickCalcLabel(calc) {
	const type = quickCalcType(calc.type);
	const running = type === 'CumTotal' && RUNNING_LABELS[String(calc.attrs?.aggregation ?? '').toLowerCase()];
	const label = running ? `Running ${running}` : (QUICK_CALC_LABELS[type] ?? calc.type);
	return calc.secondary ? `${quickCalcLabel(calc.secondary)} ${label}` : label;
}

/** Accumulates one card's columns, groupBy, orderBy and card-scoped formulas. */
class CardBuilder {
	constructor(ws, ir, bindings, datasetKey, inference, options = {}) {
		this.ws = ws;
		this.options = options;
		this.ir = ir;
		this.bindings = bindings;
		this.datasetKey = datasetKey;
		this.inference = inference;
		this.columns = [];
		this.slots = [];
		this.groupBy = [];
		this.defaultOrder = [];
		// Dimensions whose computed sort orders a window formula, which breaks ties by the dimension.
		this.windowTiebreaks = new Set();
		this.formulas = [];
		this.aggregatedFormulas = new Set();
		this.issues = [];
		this.approximate = false;
		this.dateGrain = undefined;
		/** @type {import('./filters.js').CalendarUse[]} */
		this.calendarUses = [];
		this.pillRefs = new Map();
		this.grouped = new Set();
		this.paneConditions = new Map();
		this.combinedFormulas = new Set();
		this.negativeStyles = new Map();
	}

	/** A plain aggregate of a row-level field, which a member condition can go inside. */
	canWrap(pillId) {
		const pill = pillFor(this.ws, pillId);
		const binding = this.bindings?.get?.(pill.datasourceId, pill.fieldId);
		const derivation = String(pill.derivation ?? '').toLowerCase();
		if (!binding || binding.aggregated || binding.lodExpression || pill.tableCalc || !bindingExpression(binding)) return false;
		return Boolean(AGGREGATIONS[derivation] || CARD_FORMULA_AGGREGATIONS[derivation]);
	}

	warn(code, message, suggestion) {
		this.issues.push(makeIssue(this.ws, 'warning', code, message, suggestion));
		this.approximate = true;
	}

	info(code, message) {
		this.issues.push(makeIssue(this.ws, 'info', code, message));
	}

	/** Register a card-scoped beast mode (placeholder id, rewritten by the server on save). */
	addFormula({ name, formula, dataType = 'numeric', aggregated = false }) {
		const existing = this.formulas.find((f) => f.formula === formula && f.aggregated === aggregated);
		if (existing) return existing.id;
		const id = `calculation_card_${this.formulas.length + 1}`;
		let unique = name;
		let n = 2;
		while (this.formulas.some((f) => f.name.toLowerCase() === unique.toLowerCase())) unique = `${name} (${n++})`;
		this.formulas.push({ id, name: unique, formula, templateId: -1, status: 'VALID', dataType, isCalculation: true, aggregated, persistedOnDataSource: false });
		if (aggregated) this.aggregatedFormulas.add(id);
		return id;
	}

	fieldName(pill, binding) {
		return binding?.name ?? findField(this.ir, pill.datasourceId, pill.fieldId)?.name ?? stripBrackets(pill.fieldId);
	}

	/** @returns {{ pill: any, binding?: FieldBinding }} */
	resolve(pillId, { useBinSource = false } = {}) {
		const pill = pillFor(this.ws, pillId);
		let fieldId = pill.fieldId;
		if (useBinSource) {
			const field = findField(this.ir, pill.datasourceId, fieldId);
			if (field?.bin?.source) fieldId = field.bin.source;
		}
		const binding = this.bindings?.get?.(pill.datasourceId, fieldId) ?? this.rowCountBinding(fieldId);
		const label = binding?.name ?? stripBrackets(fieldId);
		if (!binding) {
			this.warn('card.unsupported-field', `${label} has no Domo column; left off the card`);
			return { pill };
		}
		if (binding.kind === 'unsupported') {
			this.warn('card.unsupported-field', `${label} could not be converted (${binding.reason ?? 'unsupported'}); left off the card`);
			return { pill };
		}
		if (binding.datasetKey && binding.datasetKey !== this.datasetKey) {
			this.warn('card.blend', `${label} comes from a blended datasource; Domo cards read one dataset, so it was left off`, 'Join the datasources in ETL.');
			return { pill };
		}
		return { pill, binding };
	}

	/** Tableau 2020.2+ table row counts ('[__tableau_internal_object_id__].[Orders_A1]') have no column. */
	rowCountBinding(fieldId) {
		const m = /^\[__tableau_internal_object_id__\]\.\[(.+)\]$/.exec(fieldId ?? '');
		if (!m) return undefined;
		const table = m[1].replace(/_[0-9A-F]{32}$/i, '').replace(/_[A-Z0-9]{1,4}$/i, '');
		const name = `${table} (Count)`;
		const formulaId = this.addFormula({ name, formula: 'SUM(1)', dataType: 'numeric', aggregated: true });
		return { datasetKey: this.datasetKey, kind: 'formula', name, formulaId, aggregated: true, dataType: 'LONG' };
	}

	pushGroup(r) {
		const key = refKey(r);
		if (this.grouped.has(key)) return;
		this.grouped.add(key);
		this.groupBy.push(r);
	}

	isDateBinding(binding) {
		const t = String(binding.dataType ?? '').toUpperCase();
		return t === 'DATE' || t === 'DATETIME' || binding.tableauType === 'date' || binding.tableauType === 'datetime';
	}

	/** Dimension reference (select fields without mapping) for a pill, creating grain or date-part formulas as needed. */
	dimensionRef(m, pill, binding) {
		const name = this.fieldName(pill, binding);
		const isDate = this.isDateBinding(binding) || pill.datePart || pill.dateTrunc;
		const part = pill.datePart && pill.datePart !== 'mdy' && pill.datePart !== 'year' ? pill.datePart : null;
		let grain = m.dateTrunc ?? pill.dateTrunc ?? (pill.datePart === 'year' ? 'year' : pill.datePart === 'mdy' ? 'day' : null);
		if (m.dateTrunc) grain = m.dateTrunc;
		if (m.rawDate || !isDate || (!grain && !part)) return { ref: refOf(binding) };
		if (!m.dateTrunc && part) {
			const expr = bindingExpression(binding);
			if (!expr) {
				this.warn('card.date-part', `Date part of ${name} could not be computed`);
				return { ref: refOf(binding) };
			}
			const spec = datePartFormula(part, expr, binding.fiscalYearStart);
			const id = this.addFormula({ name: `${name} (${spec.label})`, formula: spec.formula, dataType: spec.dataType });
			if (spec.sortFormula) {
				const sortId = this.addFormula({ name: `${name} (${spec.label} order)`, formula: spec.sortFormula, dataType: 'numeric', aggregated: true });
				this.defaultOrder.push({ pillId: m.pillId, entry: { column: sortId, formulaId: sortId, order: 'ASCENDING' } });
			} else {
				this.defaultOrder.push({ pillId: m.pillId, entry: { column: id, formulaId: id, order: 'ASCENDING' } });
			}
			return { ref: { column: id, formulaId: id } };
		}
		const calendarOk = binding.kind === 'column' && this.isDateBinding(binding) && !this.dateGrain && !SCATTER.test(this.inference.chartType);
		if (calendarOk) {
			const grainColumn = GRAIN_COLUMNS[grain] ?? 'Date';
			this.dateGrain = { column: binding.column, dateTimeElement: GRAIN_ELEMENTS[grain] ?? 'DAY' };
			if (CALENDAR_INTERVALS.has(this.dateGrain.dateTimeElement)) this.calendarUses.push({ name, startMonth: binding.fiscalYearStart ?? 1 });
			if (grain === 'second') this.info('card.date-grain', `${name}: second-level truncation shown by minute`);
			return { ref: { column: grainColumn, calendar: true } };
		}
		const expr = bindingExpression(binding);
		if (!expr) {
			this.warn('card.date-grain', `Date truncation of ${name} could not be computed`);
			return { ref: refOf(binding) };
		}
		const spec = datePartFormula(grain === 'day' ? 'trunc:day' : `trunc:${grain}`, expr, binding.fiscalYearStart);
		const id = this.addFormula({ name: `${name} (${spec.label})`, formula: spec.formula, dataType: spec.dataType });
		this.defaultOrder.push({ pillId: m.pillId, entry: { column: id, formulaId: id, order: 'ASCENDING' } });
		this.info('card.date-grain', `${name} by ${grain} uses a card beast mode because the card already has a calendar grain or the field is calculated`);
		return { ref: { column: id, formulaId: id } };
	}

	aggregationFor(m, pill, binding) {
		if (m.aggregation) return { aggregation: m.aggregation };
		if (binding.aggregated) return {};
		const derivation = String(pill.derivation ?? 'None').toLowerCase();
		if (CARD_FORMULA_AGGREGATIONS[derivation]) return { cardFormula: CARD_FORMULA_AGGREGATIONS[derivation] };
		if (UNSUPPORTED_AGGREGATIONS.has(derivation)) return { unsupported: derivation };
		if (derivation === 'attribute' || derivation === 'attr') {
			this.info('card.aggregation', `ATTR(${this.fieldName(pill, binding)}) approximated with MAX`);
			return { aggregation: 'MAX' };
		}
		const agg = AGGREGATIONS[derivation];
		if (agg) return { aggregation: agg };
		if (derivation !== 'none' && derivation !== 'user') this.info('card.aggregation', `${this.fieldName(pill, binding)}: aggregation ${pill.derivation} shown as SUM`);
		return { aggregation: 'SUM' };
	}

	measureRef(m, pill, binding) {
		const name = this.fieldName(pill, binding);
		if (m.role === 'raw') return { ref: refOf(binding), raw: true };
		const conditions = m.role === 'measure' ? this.paneConditions.get(m.pillId) : undefined;
		if (conditions) {
			const agg = this.aggregationFor(m, pill, binding);
			const inner = `CASE WHEN ${conditions.join(' AND ')} THEN ${bindingExpression(binding)} END`;
			const formula = agg.cardFormula ? agg.cardFormula.wrap(inner) : `${agg.aggregation}(${inner})`;
			const label = agg.cardFormula ? `${agg.cardFormula.label} of ${name}` : name;
			const id = this.addFormula({ name: label, formula, dataType: 'numeric', aggregated: true });
			return { ref: { column: id, formulaId: id } };
		}
		const lod = this.lodWithOuterAggregation(m, pill, binding, name);
		if (lod) return lod;
		const agg = this.aggregationFor(m, pill, binding);
		if (agg.unsupported) {
			this.warn('card.aggregation', `${agg.unsupported} of ${name} has no Domo aggregation; left off the card`);
			return null;
		}
		const pctChart = PCT_CHART.test(this.inference.chartType);
		// 'Calculation' is the compute-using of a table calc formula, which its beast mode already applies.
		const quickTableCalc = Boolean(pill.tableCalc && pill.tableCalc.type !== 'Calculation');
		const quickCalc = quickTableCalc && !pctChart;
		if (agg.cardFormula) {
			const expr = binding.kind === 'formula' && binding.aggregated ? undefined : bindingExpression(binding);
			if (!expr) {
				this.warn('card.aggregation', `${pill.derivation} of ${name} could not be expressed`);
				return null;
			}
			const formula = agg.cardFormula.wrap(expr);
			if (quickCalc) {
				const calc = this.tableCalcRef(m, pill, formula, `${agg.cardFormula.label} of ${name}`);
				if (calc) return calc;
			}
			const id = this.addFormula({ name: `${agg.cardFormula.label} of ${name}`, formula, dataType: 'numeric', aggregated: true });
			return { ref: { column: id, formulaId: id }, calcDropped: quickTableCalc };
		}
		if (pill.tableCalc?.type === 'PctTotal' && !pctChart) {
			const pct = this.percentOfTotal(pill, binding, agg.aggregation, name);
			if (pct) return pct;
		}
		if (quickCalc) {
			const calc = this.tableCalcRef(m, pill, aggregateExpression(binding, agg.aggregation), name);
			if (calc) return calc;
		}
		return { ref: refOf(binding), aggregation: agg.aggregation, calcDropped: quickTableCalc };
	}

	/** The pill's quick table calc as a window formula over `base`, or undefined after warning that it was not converted. */
	tableCalcRef(m, pill, base, name) {
		const reason = this.options.useWindowFunctions ? this.quickTableCalc(m, pill, base, name) : 'window functions are off (--no-window-functions)';
		if (typeof reason !== 'string') return reason;
		this.warn('card.table-calc', `Table calculation ${pill.tableCalc.type} on ${name} is not converted (${reason}); the base aggregation is shown`, 'Use a window-function beast mode or compute it in ETL.');
		return undefined;
	}

	/**
	 * Quick table calculation as a card window formula over the pill's aggregate. Every dimension the calc addresses
	 * or partitions by must be on the card: Domo picks arbitrary values for a window column the query does not group.
	 * @returns {{ ref: Object }|string} The column, or why it was not converted
	 */
	quickTableCalc(m, pill, base, name) {
		if (!base) return 'its aggregate could not be expressed';
		const combinedLevels = new Set(this.slots.flatMap((s) => (s.derived?.type === 'concat' ? s.derived.pillIds : [])));
		const onCard = new Set([...this.inference.mappings.filter((x) => x.role === 'dim').map((x) => x.pillId), ...(this.inference.detail ?? []), ...combinedLevels]);
		const missing = [];
		const toItem = (id, p) => {
			if (!onCard.has(id)) {
				missing.push(this.fieldName(p ?? pillFor(this.ws, id), undefined));
				return undefined;
			}
			// The window partitions by the level's own column, so the query groups by it too (same grain as the combined ITEM).
			if (combinedLevels.has(id)) this.addDetail(id);
			return p ? pillWindowItem(p, this.bindings?.get?.(p.datasourceId, p.fieldId)) : undefined;
		};
		const toMeasure = (id, p) => this.measureSql(p ?? pillFor(this.ws, id));
		const calc = pill.tableCalc;
		const addressing = tableCalcAddressing(this.ws, m.pillId, toItem, { toMeasure });
		const secondary = calc.secondary && tableCalcAddressing(this.ws, m.pillId, toItem, { calc: calc.secondary, toMeasure });
		if (missing.length) return `it addresses ${[...new Set(missing)].join(', ')}, which the card does not show`;
		const result = quickTableCalcSql(calc, base, addressing, secondary || undefined);
		if (result.unsupported) return result.unsupported;
		const issues = [...addressing.issues, ...(secondary ? secondary.issues : [])];
		for (const i of issues) this.issues.push(makeIssue(this.ws, i.severity, i.code, i.message));
		if (issues.some((i) => i.severity !== 'info')) this.approximate = true;
		const label = quickCalcLabel(calc);
		const id = this.addFormula({ name: `${label} of ${name}`, formula: result.sql, dataType: 'numeric', aggregated: true });
		this.info('card.table-calc', `${label} on ${name} converted to a window function${result.note ? `; ${result.note}` : ''}`);
		for (const s of this.ws.sorts ?? []) if (s.kind === 'computed' && s.using && toMeasure(s.using, this.ws.pills?.[s.using])) this.windowTiebreaks.add(s.pillId);
		return { ref: { column: id, formulaId: id } };
	}

	measureSql(pill) {
		if (!pill?.aggregated || pill.tableCalc) return undefined;
		const binding = this.bindings?.get?.(pill.datasourceId, pill.fieldId);
		if (!binding || binding.kind === 'unsupported') return undefined;
		if (binding.aggregated) return aggregateExpression(binding);
		const derivation = String(pill.derivation ?? 'None').toLowerCase();
		const cardFormula = CARD_FORMULA_AGGREGATIONS[derivation];
		if (cardFormula) {
			const expr = bindingExpression(binding);
			return expr && cardFormula.wrap(expr);
		}
		const aggregation = AGGREGATIONS[derivation] ?? (derivation === 'attribute' || derivation === 'attr' ? 'MAX' : undefined);
		return aggregation ? aggregateExpression(binding, aggregation) : undefined;
	}

	/**
	 * A bare LOD beast mode defaults to SUM(<lod>); a pill with another known aggregation gets a card
	 * formula with that outer aggregation over the same LOD instead.
	 */
	lodWithOuterAggregation(m, pill, binding, name) {
		if (binding.kind !== 'formula' || !binding.lodExpression || m.aggregation) return undefined;
		const derivation = String(pill.derivation ?? 'None').toLowerCase();
		if (['none', 'user', 'sum'].includes(derivation)) return undefined;
		let formula;
		const cardFormula = CARD_FORMULA_AGGREGATIONS[derivation];
		if (cardFormula) formula = cardFormula.wrap(binding.lodExpression);
		else if (derivation === 'attribute' || derivation === 'attr') formula = `MAX(${binding.lodExpression})`;
		else if (AGGREGATIONS[derivation]) formula = `${AGGREGATIONS[derivation]}(${binding.lodExpression})`;
		if (!formula) return undefined;
		const label = cardFormula?.label ?? AGGREGATIONS[derivation] ?? 'MAX';
		const id = this.addFormula({ name: `${label} of ${name}`, formula, dataType: 'numeric', aggregated: true });
		this.info('card.lod-outer-aggregation', `${name}: ${pill.derivation} of the LOD expression uses a card formula instead of the dataset Beast Mode (which sums it)`);
		return { ref: { column: id, formulaId: id } };
	}

	/** Percent of Total over the whole table as SUM(x) / SUM(SUM(x) FIXED ()); no FILTER clause, so card filters still apply. */
	percentOfTotal(pill, binding, aggregation, name) {
		const scope = pill.tableCalc.orderingType;
		if (scope && scope !== 'Table') return undefined;
		const expr = bindingExpression(binding);
		if (!expr || !['SUM', 'COUNT'].includes(aggregation)) return undefined;
		const id = this.addFormula({ name: `% of Total ${name}`, formula: `${aggregation}(${expr}) / NULLIF(SUM(${aggregation}(${expr}) FIXED ()), 0)`, dataType: 'numeric', aggregated: true });
		this.info('card.table-calc', `Percent of Total on ${name} converted to a FIXED beast mode over the whole table`);
		return { ref: { column: id, formulaId: id } };
	}

	/** A count or table calc of a measure is another number, so only the pill's own format applies to it. */
	measureFormatText(pill) {
		const pillFormat = this.ws.numberFormats?.[pill.id];
		const shareFormat = !pill.tableCalc && PCT_CHART.test(this.inference.chartType) && domoNumberFormat(pillFormat)?.type === 'percent';
		if (domoNumberFormat(pillFormat) && !shareFormat) return pillFormat;
		const field = findField(this.ir, pill.datasourceId, pill.fieldId);
		return !pill.tableCalc && !/^count/i.test(String(pill.derivation ?? '')) && fieldNumberFormat(field) ? field.defaultFormat : undefined;
	}

	columnFormat(pill, binding, columnRef, measure) {
		if (measure) return domoNumberFormat(this.measureFormatText(pill));
		const field = findField(this.ir, pill.datasourceId, pill.fieldId);
		return refKey(columnRef) === refKey(refOf(binding)) ? fieldColumnFormat(field, this.ws.numberFormats?.[pill.id]) : undefined;
	}

	/** The Measure Names alias Tableau shows for a measure pill (legend, headers), when the sheet uses Measure Names. */
	measureNameAlias(pill) {
		const pills = Object.values(this.ws.pills ?? {});
		if (!pills.some((p) => /Measure Names/i.test(p.fieldId ?? ''))) return undefined;
		const names = (this.ir?.datasources ?? []).find((d) => d.id === pill.datasourceId)?.fields?.find((f) => f.kind === 'measure-names');
		return names?.aliases?.[pill.id];
	}

	/** Add the column for one slot mapping. */
	add(m) {
		if (m.derived?.type === 'concat') return this.addCombinedItem(m);
		if (m.derived?.type === 'member') return this.addMemberMeasure(m);
		const { pill, binding } = this.resolve(m.pillId, { useBinSource: m.useBinSource });
		if (!binding) return;
		if (m.derived?.type === 'date-add') return this.addGanttEnd(m, pill, binding);
		const treatAsMeasure = m.role !== 'dim' || binding.aggregated;
		if (m.role === 'dim' && binding.aggregated) {
			this.info('card.aggregate-dimension', `${this.fieldName(pill, binding)} is an aggregate calculation used as a dimension; shown as a value`);
		}
		const built = treatAsMeasure ? this.measureRef(m, pill, binding) : this.dimensionRef(m, pill, binding);
		if (!built) return;
		const column = { ...built.ref, mapping: m.mapping };
		if (built.aggregation) column.aggregation = built.aggregation;
		const alias = (treatAsMeasure && this.measureNameAlias(pill)) || columnAlias(built.ref, binding);
		if (alias) column.alias = alias;
		// A caption of only punctuation (".") is how a Tableau author hides a header label; Domo tables always show one.
		if (TABLE_CHARTS.has(this.inference.chartType) && m.role === 'dim' && /^[\s\p{P}\p{S}]+$/u.test(this.fieldName(pill, binding))) column.alias = ' ';
		// A table calc Domo draws itself (a 100% chart) or could not convert leaves the base measure, not its number format.
		const format = built.calcDropped ? undefined : this.columnFormat(pill, binding, built.ref, treatAsMeasure);
		if (format) column.format = format;
		if (format && treatAsMeasure) this.negativeStyles.set(m.pillId, negativeStyle(this.measureFormatText(pill)));
		this.columns.push(column);
		this.slots.push({ pillId: m.pillId, role: m.role, column });
		const aggregatedFormula = column.formulaId && (this.aggregatedFormulas.has(column.formulaId) || binding.aggregated);
		const grouped = !treatAsMeasure;
		this.pillRefs.set(m.pillId, { ref: built.ref, aggregation: built.aggregation, grouped, raw: built.raw, aggregated: Boolean(built.aggregation || aggregatedFormula) });
		if (grouped) this.pushGroup(built.ref);
		META.set(column, { raw: Boolean(built.raw), aggregated: Boolean(built.aggregation || aggregatedFormula) });
	}

	/** Several category levels as one ITEM: a card beast mode joining their values, null-safe, as an author would build it. */
	addCombinedItem(m) {
		const parts = m.derived.pillIds.map((id) => {
			const { pill, binding } = this.resolve(id);
			return { id, name: this.fieldName(pill, binding), expr: binding && !binding.aggregated ? bindingExpression(binding) : undefined };
		});
		const usable = parts.filter((p) => p.expr);
		const left = parts.filter((p) => !p.expr && p.name);
		if (left.length && usable.length) this.warn('chart.combined-category', `${left.map((p) => p.name).join(', ')} cannot join the combined category (an aggregate, blended or unconverted field); left off it`);
		if (usable.length < 2) return usable.length ? this.add({ ...m, pillId: usable[0].id, derived: undefined }) : undefined;
		const formula = `CONCAT(${usable.map((p) => `COALESCE(${p.expr}, '')`).join(`, ${sqlLiteral(COMBINED_SEPARATOR)}, `)})`;
		const id = this.addFormula({ name: usable.map((p) => p.name).join(' + '), formula, dataType: 'string' });
		const ref = { column: id, formulaId: id };
		const column = { ...ref, mapping: m.mapping };
		this.columns.push(column);
		this.slots.push({ pillId: m.pillId, role: m.role, column, derived: { type: 'concat', pillIds: usable.map((p) => p.id) } });
		const known = { ref, grouped: true, aggregated: false, combined: m.pillId };
		for (const pillId of [m.pillId, ...usable.map((p) => p.id)]) this.pillRefs.set(pillId, known);
		this.pushGroup(ref);
		this.combinedFormulas.add(id);
		META.set(column, { raw: false, aggregated: false });
	}

	addMemberMeasure(m) {
		const series = this.resolve(m.derived.seriesPillId);
		const measure = this.resolve(m.derived.measurePillId);
		const seriesExpr = series.binding && !series.binding.aggregated ? bindingExpression(series.binding) : undefined;
		const built = measure.binding && this.measureRef({ ...m, pillId: m.derived.measurePillId, derived: undefined }, measure.pill, measure.binding);
		const column = built?.ref?.column;
		if (!seriesExpr || !built?.aggregation || !column || column.startsWith('calculation_')) {
			this.warn('chart.dual-axis', `The ${m.derived.member} line could not be built from ${this.fieldName(measure.pill, measure.binding)}; left off the card`);
			return;
		}
		const formula = `${built.aggregation}(CASE WHEN ${seriesExpr} = ${sqlLiteral(m.derived.member)} THEN \`${column}\` END)`;
		const id = this.addFormula({ name: `${m.derived.member} ${this.fieldName(measure.pill, measure.binding)}`, formula, dataType: 'numeric', aggregated: true });
		const out = { column: id, formulaId: id, mapping: m.mapping, alias: m.derived.member };
		const format = this.columnFormat(measure.pill, measure.binding, built.ref, true);
		if (format) out.format = format;
		this.columns.push(out);
		this.slots.push({ pillId: m.pillId, role: m.role, column: out });
		this.aggregatedFormulas.add(id);
		META.set(out, { raw: false, aggregated: true });
	}

	addGanttEnd(m, pill, binding) {
		const startExpr = bindingExpression(binding);
		let endRef = refOf(binding);
		if (m.derived.sizePillId && startExpr) {
			const size = this.resolve(m.derived.sizePillId);
			const sizeExpr = size.binding && !size.binding.aggregated ? bindingExpression(size.binding) : undefined;
			if (sizeExpr) {
				const name = this.fieldName(pill, binding);
				const id = this.addFormula({ name: `${name} end`, formula: `DATE_ADD(${startExpr}, INTERVAL ${/^`[^`]+`$/.test(sizeExpr) ? sizeExpr : `(${sizeExpr})`} DAY)`, dataType: 'date' });
				endRef = { column: id, formulaId: id };
			} else {
				this.warn('chart.gantt', 'Gantt bar size is an aggregate or missing; end date equals start date');
			}
		} else {
			this.warn('chart.gantt', 'Gantt chart has no size measure; end date equals start date');
		}
		this.columns.push({ ...endRef, mapping: m.mapping });
		this.pushGroup(endRef);
	}

	addDetail(pillId) {
		const { pill, binding } = this.resolve(pillId);
		if (!binding || binding.aggregated) return;
		const built = this.dimensionRef({ pillId, role: 'dim' }, pill, binding);
		this.pushGroup(built.ref);
	}

	/** A dimension whose header is hidden: grouped and sortable, not a table column. */
	addSortOnly(pillId) {
		const { pill, binding } = this.resolve(pillId);
		if (!binding || binding.aggregated) return;
		const built = this.dimensionRef({ pillId, role: 'dim' }, pill, binding);
		this.pushGroup(built.ref);
		this.pillRefs.set(pillId, { ref: built.ref, grouped: true, aggregated: false });
		if (TABLE_CHARTS.has(this.inference.chartType)) this.info('card.hidden-header', `${this.fieldName(pill, binding)} has a hidden header in Tableau; it sorts the card but is not a column (a Domo table cannot hide one)`);
	}
}

function measureOrderEntry(builder, pillId) {
	const known = builder.pillRefs.get(pillId);
	if (known) {
		const entry = { ...known.ref };
		if (known.aggregation) entry.aggregation = known.aggregation;
		return entry;
	}
	const { pill, binding } = builder.resolve(pillId);
	if (!binding) return undefined;
	const built = builder.measureRef({ pillId, mapping: 'VALUE', role: 'measure' }, pill, binding);
	if (!built) return undefined;
	const entry = { ...built.ref };
	if (built.aggregation) entry.aggregation = built.aggregation;
	return entry;
}

/** orderBy entries from the worksheet sorts, then the default orders; `byPill`: pill id -> its entry. */
function sortEntries(builder, ws) {
	const entries = [];
	const byPill = new Map();
	/** Manual order entries: the rank formula and how many members it lists. */
	const ranks = new Map();
	/** Series total-order keys, which like a rank take the series slot ahead of the axis key. */
	const seriesKeys = new Set();
	const push = (pillId, entry) => {
		entries.push(entry);
		byPill.set(pillId, entry);
	};
	const combinedSort = new Map();
	for (const sort of ws.sorts ?? []) {
		const target = builder.pillRefs.get(sort.pillId);
		const levels = target?.combined && builder.slots.find((s) => s.pillId === target.combined)?.derived?.pillIds;
		const rank = levels ? levels.indexOf(sort.pillId) : -1;
		if (levels && (!combinedSort.has(target.combined) || rank < levels.indexOf(combinedSort.get(target.combined).pillId))) combinedSort.set(target.combined, sort);
	}
	const count = (mapping) => builder.columns.filter((c) => c.mapping === mapping).length;
	const seriesChart = count('SERIES') === 1 && count('ITEM') === 1 && count('VALUE') === 1;
	const axisSeriesChart = seriesChart && AXIS_FAMILIES.has(builder.inference.family);
	const stackSlots = builder.slots.map((x) => ({ pillId: x.pillId, mapping: x.column.mapping, role: x.role }));
	const stackSorted = Boolean(stackSortOverrides(ws, { chartType: builder.inference.chartType, slots: stackSlots }).overrides.category_sort_method);
	builder.stackSorted = stackSorted;
	for (const sort of ws.sorts ?? []) {
		const target = builder.pillRefs.get(sort.pillId);
		if (!target) continue;
		if (target.combined && combinedSort.get(target.combined) !== sort) {
			builder.info('card.sort-order', `The sort on ${builder.fieldName(pillFor(ws, sort.pillId))} is left out: the combined category takes the sort of its outermost sorted level`);
			continue;
		}
		const key = target.combined ?? sort.pillId;
		const order = sort.direction === 'DESC' ? 'DESCENDING' : 'ASCENDING';
		if (sort.kind === 'computed' && sort.using) {
			const entry = measureOrderEntry(builder, sort.using);
			if (entry && axisSeriesChart && seriesByValue(builder, sort.pillId, entry)) {
				// category_sort_method orders the segments; a total-order key as well breaks the stack in Analyzer.
				if (stackSorted) continue;
				const id = builder.options.useWindowFunctions && totalOrderKey(builder, sort.pillId, sort.using, [groupExpression(builder, sort.pillId)]);
				if (id) {
					const seriesKey = { column: id, formulaId: id, order };
					push(key, seriesKey);
					seriesKeys.add(seriesKey);
				} else {
					push(key, { ...target.ref, order: 'ASCENDING' });
					const why = builder.options.useWindowFunctions ? 'its grouping has no SQL expression for the total-order key' : 'the total-order key needs window functions';
					builder.info('card.sort', `${builder.fieldName(pillFor(ws, sort.pillId), builder.resolve(sort.pillId).binding)} is ordered by name, not by its total: ${why}`);
				}
				continue;
			}
			if (entry) push(key, { ...entry, order });
			if (entry && builder.windowTiebreaks.has(sort.pillId) && !seriesChart) entries.push({ ...target.ref, order: 'ASCENDING' });
			continue;
		}
		if (sort.kind === 'manual') {
			const { binding } = builder.resolve(sort.pillId);
			const expr = binding && bindingExpression(binding);
			const values = (sort.order ?? []).filter((v) => v !== null && v !== undefined);
			if (!expr || !values.length || values.length > 500) {
				builder.info('card.sort', `Manual sort on ${binding?.name ?? stripBrackets(sort.pillId)} not converted`);
				continue;
			}
			const cases = values.map((v, i) => `WHEN ${expr} = ${sqlLiteral(v)} THEN ${i + 1}`).join(' ');
			const id = builder.addFormula({ name: `${binding.name} (manual order)`, formula: `MIN(CASE ${cases} ELSE ${values.length + 1} END)`, dataType: 'numeric', aggregated: true });
			const entry = { column: id, formulaId: id, order };
			push(key, entry);
			ranks.set(entry, { id, size: values.length + 1 });
			continue;
		}
		const entry = { ...target.ref, order };
		if (target.aggregation) entry.aggregation = target.aggregation;
		push(key, entry);
	}
	for (const d of builder.defaultOrder) if (!byPill.has(d.pillId)) push(d.pillId, d.entry);
	return { entries, byPill, ranks, seriesKeys };
}

function seriesByValue(builder, pillId, entry) {
	const series = builder.slots.find((s) => s.pillId === pillId && s.column.mapping === 'SERIES');
	const value = builder.columns.find((c) => c.mapping === 'VALUE');
	return Boolean(series && value) && refKey(entry) === refKey(value) && (entry.aggregation ?? '') === (value.aggregation ?? '');
}

const AXIS_FAMILIES = new Set(['bar', 'line', 'area', 'combo']);
const DATE_TYPE = /^date(time)?$/i;

/**
 * A bar, line, area or combo chart whose category axis is not a date sorts by it first: Tableau orders such an axis by
 * its own sort, else by its members (text in natural order), where Domo would keep the query's row order. Domo orders a
 * date axis itself. The axis sort comes first.
 */
function itemFirst(builder, inference, sorts) {
	if (inference.family === 'heatmap') return heatmapOrder(builder, inference, sorts);
	if (!AXIS_FAMILIES.has(inference.family)) return sorts.entries;
	const stacked = (entry) => {
		if (VERTICAL_STACKS.test(inference.chartType)) builder.stackSeriesSort = entry;
		return entry;
	};
	const isSeriesKey = (e) => Boolean(sorts.seriesKeys?.has(e));
	// Domo orders a date axis itself; a series total key still goes first so it takes the series slot.
	const keyFirst = () => {
		const key = sorts.entries.find(isSeriesKey);
		return key ? [stacked(key), ...sorts.entries.filter((e) => e !== key)] : sorts.entries;
	};
	const item = inference.mappings.find((m) => m.mapping === 'ITEM');
	const known = item && builder.pillRefs.get(item.pillId);
	if (!known || !known.grouped || known.ref.calendar) return keyFirst();
	const sorted = sorts.byPill.get(item.pillId);
	const combined = builder.combinedFormulas.has(known.ref.formulaId) && builder.formulas.find((f) => f.id === known.ref.formulaId);
	if (combined && sorted && isValueSort(builder, sorted)) return combinedValueOrder(builder, inference, sorts, known, sorted);
	const byName = combined && (!sorted || refKey(sorted) === refKey(known.ref));
	const own = !byName && sorted && itemGrainSort(builder, item.pillId, known, sorted);
	let natural;
	if (byName) natural = { name: `${combined.name} (natural order)`, formula: naturalOrderKey(combined.formula) };
	else if (!own) {
		const pill = pillFor(builder.ws, item.pillId);
		const binding = builder.bindings?.get?.(pill.datasourceId, pill.fieldId);
		const cardFormula = builder.formulas.find((f) => f.id === known.ref.formulaId);
		if (cardFormula ? DATE_TYPE.test(cardFormula.dataType) : binding && builder.isDateBinding(binding)) return keyFirst();
		const text = cardFormula ? cardFormula.dataType === 'string' : /^string$/i.test(String(binding?.dataType ?? binding?.tableauType ?? ''));
		const expr = text && !cardFormula && binding ? bindingExpression(binding) : undefined;
		if (expr) natural = { name: `${builder.fieldName(pill, binding)} (natural order)`, formula: naturalOrderKey(expr) };
	}
	const axisEntry = () => {
		if (own) return own;
		if (!natural) return { ...known.ref, order: 'ASCENDING' };
		const id = builder.addFormula({ ...natural, dataType: 'string', aggregated: true });
		return { column: id, formulaId: id, order: byName ? (sorted?.order ?? 'ASCENDING') : 'ASCENDING' };
	};
	const rest = sorts.entries.filter((e) => e !== sorted);
	const count = (mapping) => builder.columns.filter((c) => c.mapping === mapping).length;
	const seriesChart = count('SERIES') === 1 && count('ITEM') === 1 && count('VALUE') === 1;
	const series = inference.mappings.find((m) => m.mapping === 'SERIES');
	const seriesRef = series && builder.pillRefs.get(series.pillId)?.ref;
	const onAxisColumn = own ? refKey(own) === refKey(known.ref) : !natural;
	const onSeriesColumn = (e) => Boolean(seriesRef) && refKey(e) === refKey(seriesRef);
	// Tableau lists unsorted series members in natural order; with the axis sort alone Domo keeps the query's row order.
	if (seriesChart && seriesRef && !sorts.byPill.has(series.pillId) && !seriesRef.calendar && !builder.stackSorted) {
		const key = seriesNaturalKey(builder, series.pillId, seriesRef);
		if (!key) return [axisEntry(), stacked({ ...seriesRef, order: 'ASCENDING' }), ...rest];
		const id = builder.addFormula({ ...key, dataType: 'string', aggregated: true });
		return [stacked({ column: id, formulaId: id, order: 'ASCENDING' }), axisEntry(), ...rest];
	}
	if (!seriesChart || !rest.length || onAxisColumn || onSeriesColumn(rest[0])) return [axisEntry(), ...rest.map((e) => (isSeriesKey(e) ? stacked(e) : e))];
	if (isSeriesKey(rest[0])) return [stacked(rest[0]), axisEntry(), ...rest.slice(1)];
	if (natural && sorts.ranks?.has(rest[0]) && rest.length === 1) return [stacked({ ...rest[0] }), axisEntry()];
	builder.info('card.sort-order', 'The series sort is listed before the category axis sort: Domo orders the series by the first sort of a one-series card and the axis by the second');
	return [rest[0], axisEntry(), ...rest.slice(1)];
}

function isValueSort(builder, entry) {
	const values = builder.columns.filter((c) => c.mapping === 'VALUE');
	return values.length === 1 && refKey(entry) === refKey(values[0]) && (entry.aggregation ?? '') === (values[0].aggregation ?? '');
}

/**
 * A combined category sorted by the VALUE column, then by itself (the user-verified shape): a VALUE sort turns
 * second-level sorting off, where a series key or an ITEM grain key would be taken as the series sort.
 */
function combinedValueOrder(builder, inference, sorts, known, sorted) {
	const series = inference.mappings.find((m) => m.mapping === 'SERIES' && m.role === 'dim');
	if (series && builder.pillRefs.has(series.pillId)) {
		const name = builder.fieldName(pillFor(builder.ws, series.pillId));
		builder.info('card.sort-order', `Bars are ordered by their segments' values: a category with several ${name} members is placed by its largest segment, where Tableau orders by the stack total`);
	}
	return [sorted, { ...known.ref, order: 'ASCENDING' }, ...sorts.entries.filter((e) => e !== sorted)];
}

/**
 * The ITEM's sort by the VALUE column on a card that groups by more than the ITEM: Tableau orders the axis by the
 * measure over each member, but a sort equal to the VALUE column turns second-level sorting off and orders the rows by
 * their own values, so the key is the measure at the ITEM grain (filters applied, as Tableau sorts).
 */
function itemGrainSort(builder, pillId, known, entry) {
	const values = builder.columns.filter((c) => c.mapping === 'VALUE');
	if (values.length !== 1 || builder.groupBy.length < 2 || !known.ref.column || known.ref.formulaId || known.ref.calendar) return entry;
	const [value] = values;
	if (refKey(entry) !== refKey(value) || (entry.aggregation ?? '') !== (value.aggregation ?? '')) return entry;
	const formula = value.formulaId && builder.formulas.find((f) => f.id === value.formulaId);
	const sql = formula ? (formula.aggregated ? formula.formula : undefined) : value.aggregation && COLUMN_AGGREGATE_SQL[value.aggregation]?.(`\`${value.column}\``);
	if (!sql) return entry;
	const { pill, binding } = builder.resolve(pillId);
	const id = builder.addFormula({ name: `${builder.fieldName(pill, binding)} (sort by ${formula ? formula.name : value.column})`, formula: `MAX(${sql} FIXED (BY \`${known.ref.column}\`))`, dataType: 'numeric', aggregated: true });
	return { column: id, formulaId: id, order: entry.order };
}

const COLUMN_AGGREGATE_SQL = { SUM: (e) => `SUM(${e})`, AVG: (e) => `AVG(${e})`, MIN: (e) => `MIN(${e})`, MAX: (e) => `MAX(${e})`, COUNT: (e) => `COUNT(${e})` };

/**
 * A heatmap lists its columns and rows in the order they first appear in the query, so an unsorted text ITEM or SERIES
 * sorts by its natural-order key. Listed series first: second-level sorting gives the first sort that is no ITEM
 * or SERIES column the series slot and the next the category slot.
 */
function heatmapOrder(builder, inference, sorts) {
	const slot = (mapping) => {
		const m = inference.mappings.find((x) => x.mapping === mapping);
		const known = m && builder.pillRefs.get(m.pillId);
		if (!known?.grouped || known.ref.calendar) return undefined;
		const own = sorts.byPill.get(m.pillId);
		if (own) return { entry: own };
		const key = seriesNaturalKey(builder, m.pillId, known.ref);
		if (!key) return { entry: { ...known.ref, order: 'ASCENDING' } };
		const id = builder.addFormula({ ...key, dataType: 'string', aggregated: true });
		return { entry: { column: id, formulaId: id, order: 'ASCENDING' }, natural: true };
	};
	const item = slot('ITEM');
	const series = slot('SERIES');
	if (!item?.natural && !series?.natural) return sorts.entries;
	const lead = [series?.entry, item?.entry].filter(Boolean);
	return [...lead, ...sorts.entries.filter((e) => !lead.includes(e))];
}

/** The SQL a grouped pill groups by: its bound column or beast mode, or a row-level card formula. */
function groupExpression(builder, pillId) {
	const known = builder.pillRefs.get(pillId);
	if (!known || known.ref.calendar) return undefined;
	const card = builder.formulas.find((f) => f.id === known.ref.formulaId);
	if (card) return card.aggregated ? undefined : `(${card.formula})`;
	return bindingExpression(builder.resolve(pillId).binding);
}

/** A computed sort's key: the `usingId` measure summed per member of `parts` (a window SUM); undefined when inexpressible. */
function totalOrderKey(builder, pillId, usingId, parts) {
	const entry = measureOrderEntry(builder, usingId);
	const card = entry && builder.formulas.find((f) => f.id === entry.formulaId);
	const { binding } = builder.resolve(usingId);
	const measure = card ? card.formula : binding && aggregateExpression(binding, entry?.aggregation);
	if (!measure || !parts.length || parts.some((p) => !p)) return undefined;
	const name = `${builder.fieldName(pillFor(builder.ws, pillId), builder.resolve(pillId).binding)} (total order)`;
	return builder.addFormula({ name, formula: `SUM(${measure}) OVER (PARTITION BY ${parts.join(', ')})`, dataType: 'numeric', aggregated: true });
}

/**
 * Query order of a pivot table, level by level as Tableau nests its rows. Phoenix lists each header's members in the order
 * they first appear in the rows (PivotTableCSR: a LinkedHashMap per level, sorted only after a click), so the rows are
 * sorted by every row header in turn: a computed sort by the member's total within its parents (a window SUM partitioned
 * by the headers up to it), a manual one by its rank, an alphabetic one by the column, an unsorted one ascending as Tableau
 * lists members; then the column headers. Undefined when a level cannot be expressed (window functions off, a calendar
 * header), so the card keeps its flat sort. `natural`: a flat table, drawn in query order, lists text members naturally.
 */
function pivotOrder(builder, ws, sorts, { natural = false } = {}) {
	const rows = (ws.rowPills ?? []).filter((id) => builder.pillRefs.get(id)?.grouped);
	if (!rows.length) return undefined;
	const exprOf = (id) => groupExpression(builder, id);
	const naturalEntry = (id, order) => {
		if (!natural) return undefined;
		const { pill, binding } = builder.resolve(id);
		const card = builder.formulas.find((f) => f.id === builder.pillRefs.get(id).ref.formulaId);
		const text = card ? card.dataType === 'string' : Boolean(binding) && /^string$/i.test(String(binding.dataType ?? binding.tableauType ?? '')) && !builder.isDateBinding(binding);
		const expr = text && !pill.datePart && !pill.dateTrunc ? exprOf(id) : undefined;
		if (!expr) return undefined;
		const fid = builder.addFormula({ name: `${builder.fieldName(pill, binding)} (natural order)`, formula: naturalOrderKey(expr, { perGroup: true }), dataType: 'string', aggregated: true });
		return { column: fid, formulaId: fid, order };
	};
	const sortOf = new Map((ws.sorts ?? []).map((s) => [s.pillId, s]));
	const out = [];
	for (const [i, id] of rows.entries()) {
		const ref = builder.pillRefs.get(id).ref;
		const sort = sortOf.get(id);
		const order = sort?.direction === 'DESC' ? 'DESCENDING' : 'ASCENDING';
		if (sort?.kind === 'computed' && sort.using) {
			if (!builder.options.useWindowFunctions) return undefined;
			const fid = totalOrderKey(builder, id, sort.using, rows.slice(0, i + 1).map(exprOf));
			if (!fid) return undefined;
			out.push({ column: fid, formulaId: fid, order }, { ...ref, order: 'ASCENDING' });
		} else if (sort?.kind === 'manual') {
			const entry = sorts.byPill.get(id);
			if (!entry) return undefined;
			out.push(entry, { ...ref, order: 'ASCENDING' });
		} else {
			// Domo sorts nulls first in a descending sort, where Tableau lists the Null member last.
			const expr = order === 'DESCENDING' ? exprOf(id) : undefined;
			if (expr) {
				const nulls = builder.addFormula({ name: `${builder.fieldName(pillFor(ws, id), builder.resolve(id).binding)} (nulls last)`, formula: `MAX(CASE WHEN ${expr} IS NULL THEN 1 ELSE 0 END)`, dataType: 'numeric', aggregated: true });
				out.push({ column: nulls, formulaId: nulls, order: 'ASCENDING' });
			}
			out.push(naturalEntry(id, order) ?? { ...ref, order });
		}
	}
	for (const id of ws.colPills ?? []) {
		const known = builder.pillRefs.get(id);
		if (!known?.grouped || known.ref.calendar) continue;
		const sort = sortOf.get(id);
		const own = sort?.kind === 'computed' ? undefined : sorts.byPill.get(id);
		const byName = !sort || (sort.kind !== 'computed' && sort.kind !== 'manual');
		out.push((byName && naturalEntry(id, sort?.direction === 'DESC' ? 'DESCENDING' : 'ASCENDING')) || own || { ...known.ref, order: 'ASCENDING' });
	}
	return dedupeOrder(out);
}

// Phoenix lists a header's members by first appearance unless `column_sort` names it by its data label (a column's name,
// not its alias; a beast mode's name); then numbers sort numerically and text naturally ignoring case, as in Tableau.
function pivotHeaderSorts(builder, ws) {
	const sortOf = new Map((ws.sorts ?? []).map((s) => [s.pillId, s]));
	const out = [];
	for (const slot of builder.slots.filter((s) => s.column.mapping === 'ROW' || s.column.mapping === 'COLUMN')) {
		const known = builder.pillRefs.get(slot.pillId);
		const sort = sortOf.get(slot.pillId);
		if (!known?.grouped || known.ref.calendar || sort?.kind === 'computed' || sort?.kind === 'manual') continue;
		const { pill, binding } = builder.resolve(slot.pillId);
		if (pill.datePart || pill.dateTrunc || (binding && builder.isDateBinding(binding))) continue;
		const card = builder.formulas.find((f) => f.id === known.ref.formulaId);
		const name = card ? card.name : binding?.kind === 'formula' ? (binding.formulaName ?? binding.name) : known.ref.column;
		if (name && !out.some((e) => e.column === name)) out.push({ column: name, sort: sort?.direction === 'DESC' ? 'desc' : 'asc' });
	}
	return out.length ? JSON.stringify(out) : undefined;
}

function seriesNaturalKey(builder, pillId, ref) {
	if (builder.formulas.some((f) => f.id === ref.formulaId)) return undefined;
	const pill = pillFor(builder.ws, pillId);
	const binding = builder.bindings?.get?.(pill.datasourceId, pill.fieldId);
	if (!binding || !/^string$/i.test(String(binding.dataType ?? binding.tableauType ?? '')) || builder.isDateBinding(binding)) return undefined;
	const expr = bindingExpression(binding);
	return expr ? { name: `${builder.fieldName(pill, binding)} (natural order)`, formula: naturalOrderKey(expr) } : undefined;
}

// Domo stacks the first series at the bottom where Tableau draws it on top, so the series sort and legend are reversed;
// but Phoenix colors series by order, so without color rules the stack stays upside down and keeps Tableau's colors.
function reverseStackSeries(builder, colorRules, overrides) {
	const entry = builder.stackSeriesSort;
	if (!entry) return;
	if (!colorRules.length) {
		builder.info('card.stack-order', 'The stack lists its series bottom to top, where Tableau draws the first on top: reversing it would move Tableau\'s colors, which no color rule pins on this card');
		return;
	}
	entry.order = entry.order === 'DESCENDING' ? 'ASCENDING' : 'DESCENDING';
	if (overrides.lrg_legend_position !== 'Hide') overrides.legend_reverse_layout = 'true';
}

const VERTICAL_STACKS = /^badge_vert_(stackedbar|100pct)$/;
const PCT_CHART = /^badge_(vert|horiz)_100pct|^badge_vert_100pct_area/;
const NATURAL_DIGITS = 10;

/**
 * Sort key that orders text with numbers in it as Tableau draws such an axis ("2023 P7" before "2023 P10"): every digit
 * run zero-padded to NATURAL_DIGITS. Domo's REGEXP_REPLACE takes `$0`/`$1`.
 * `perGroup`: the key of MIN(expr), one pattern match per group, for a card grouped by expr itself.
 */
export function naturalOrderKey(expr, { perGroup = false } = {}) {
	const zeros = '0'.repeat(NATURAL_DIGITS);
	const padded = (e) => `REGEXP_REPLACE(REGEXP_REPLACE(${e}, '[0-9]+', '${zeros}$0'), '0*([0-9]{${NATURAL_DIGITS}})', '$1')`;
	return perGroup ? padded(`MIN(${expr})`) : `MIN(${padded(expr)})`;
}

function dedupeOrder(entries) {
	const seen = new Set();
	return entries.filter((e) => {
		const key = `${refKey(e)}:${e.aggregation ?? ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const isAggregated = (c) => Boolean(META.get(c)?.aggregated);
const isRaw = (c) => Boolean(META.get(c)?.raw);

const linkText = (text) => String(text ?? '').replace(/<[^<>]+>/g, '').replace(/\s+/g, ' ').replace(/[\s:|-]+$/, '').trim();

/** Undefined when a field token is not in the view or has no column. */
function urlTemplateSql(builder, ws, ir, action) {
	const rowLevel = ws.aggregated === false;
	const viewPills = [...(ws.rowPills ?? []), ...(ws.colPills ?? []), ...(ws.panes ?? []).flatMap((p) => Object.values(p.encodings ?? {}).flat())].map((id) => pillFor(ws, id));
	const parts = [];
	let aggregated = false;
	for (const part of templateParts(withScheme(action.url?.template).template)) {
		if (!('token' in part)) {
			parts.push(part);
			continue;
		}
		const token = parseUrlToken(part.token, ir);
		if (!token) return undefined;
		if ('parameter' in token) {
			const value = token.parameter.value;
			if (value === undefined || value === null || typeof value === 'object') return undefined;
			parts.push({ token: part.token, value: String(value) });
			continue;
		}
		const pills = viewPills.filter((p) => p.fieldId === token.fieldId && (!token.datasourceId || p.datasourceId === token.datasourceId));
		const pill = pills.find((p) => !p.aggregated) ?? pills[0];
		const binding = pill && builder.bindings?.get?.(pill.datasourceId, pill.fieldId);
		if (!binding || (binding.kind !== 'column' && binding.kind !== 'formula') || (binding.datasetKey && binding.datasetKey !== builder.datasetKey)) return undefined;
		const derivation = String(pill.derivation ?? '').toLowerCase();
		const aggregation = rowLevel ? undefined : (token.aggregation ?? (pill.aggregated ? (derivation === 'attr' || derivation === 'attribute' ? 'MAX' : AGGREGATIONS[derivation]) : undefined));
		if (pill.aggregated && !aggregation && !rowLevel) return undefined;
		if (binding.aggregated && rowLevel) return undefined;
		const aggregate = Boolean(binding.aggregated || aggregation);
		const sql = aggregate ? aggregateExpression(binding, aggregation) : bindingExpression(binding);
		if (!sql) return undefined;
		if (aggregate) aggregated = true;
		parts.push({ token: part.token, sql, aggregate, field: { fieldId: pill.fieldId, ...(aggregation ? { aggregation } : {}) } });
	}
	return parts.some((p) => p.field) ? { parts, aggregated } : undefined;
}

/**
 * A table's URL actions whose field tokens are all in the view: a link in each row of the clicked column, or of a column
 * appended under the action's name when Tableau's column is taken by another action or none fits (url-columns.js).
 */
function addUrlColumns(builder, ws, ir) {
	const shelf = new Set([...(ws.rowPills ?? []), ...(ws.colPills ?? [])]);
	const hidden = new Set(ws.hiddenHeaders ?? []);
	const candidates = [];
	for (const slot of builder.slots) {
		const pill = pillFor(ws, slot.pillId);
		const binding = builder.bindings?.get?.(pill.datasourceId, pill.fieldId);
		if (slot.role !== 'dim' || !shelf.has(slot.pillId) || hidden.has(slot.pillId) || pill.aggregated || !binding || binding.aggregated) continue;
		if (builder.isDateBinding(binding) || pill.datePart || pill.dateTrunc || refKey(slot.column) !== refKey(refOf(binding)) || !builder.columns.includes(slot.column)) continue;
		const text = String(binding.dataType ?? '').toUpperCase() === 'STRING' || binding.tableauType === 'string';
		candidates.push({ pillId: slot.pillId, fieldId: pill.fieldId, text, slot, binding, pill });
	}
	const linked = new Set();
	const placed = new Set();
	const out = [];
	for (const action of ir.actions ?? []) {
		if (action.type !== 'url' || !urlActionSheets(action, ir).includes(ws.name)) continue;
		const template = urlTemplateSql(builder, ws, ir, action);
		if (!template) continue;
		// The same action defined on several dashboards is one link, not a column per copy.
		const same = JSON.stringify([action.name, action.menuCaption, action.url?.encode, action.url?.includeNull, template.parts]);
		if (placed.has(same)) continue;
		placed.add(same);
		const fields = template.parts.filter((p) => p.field);
		const tokenFields = new Set(fields.filter((p) => !p.field.aggregation).map((p) => p.field.fieldId));
		const derivedFields = new Set(fields.flatMap((p) => [...String(findField(ir, ws.datasourceIds?.[0], p.field.fieldId)?.formula ?? '').matchAll(/\[[^\]]+\]/g)].map((m) => m[0])));
		const picked = pickLinkColumn(candidates, { linkStyled: ws.linkStyled, tokenFields, derivedFields });
		const display = picked && !linked.has(picked.candidate.pillId) ? picked.candidate : undefined;
		const encode = Boolean(action.url?.encode);
		const { aggregated } = template;
		const wrap = (sql) => (aggregated ? `MAX(${sql})` : sql);
		const parts = template.parts.map((p) => (p.sql ? { sql: p.aggregate ? p.sql : wrap(p.sql) } : p));
		if (display) {
			linked.add(display.pillId);
			const column = display.slot.column;
			const caption = column.alias ?? (display.binding.kind === 'column' ? display.binding.column : display.binding.name);
			const native = display.text && !aggregated ? nativeLinkFormat(template.parts, display.fieldId, { encode }) : undefined;
			if (native) {
				column.format = { ...column.format, tableColumn: native };
			} else {
				const label = wrap(bindingExpression(display.binding));
				const id = builder.addFormula({ name: `${caption} (link)`, formula: hyperlinkFormula({ label, parts, encode, includeNull: action.url?.includeNull }), dataType: 'string', aggregated });
				const link = { column: id, formulaId: id, mapping: column.mapping, alias: caption };
				builder.columns.splice(builder.columns.indexOf(column), 1, link);
				META.set(link, { aggregated });
				if (!aggregated) builder.pushGroup({ column: id, formulaId: id });
			}
			out.push({ actionId: action.id, action: action.name, column: caption, ...(native ? { native: true } : {}) });
			builder.info('card.url-column', `URL action "${action.name}" became a link in each row of ${caption}${native ? ' (link column format)' : ''}, ${picked.reason === 'first' ? 'its first text column (Tableau does not say which column it starts from)' : `the column Tableau ${{ underline: 'underlines', token: 'passes', derived: 'derives the link from' }[picked.reason]}`}`);
			continue;
		}
		const name = linkText(action.name) || 'Link';
		const label = quoteString(linkText(action.menuCaption) || name);
		const id = builder.addFormula({ name, formula: hyperlinkFormula({ label, parts, encode, includeNull: action.url?.includeNull, whenNull: NULL_VALUE }), dataType: 'string', aggregated });
		const link = { column: id, formulaId: id, mapping: 'VALUE', alias: name };
		builder.columns.push(link);
		META.set(link, { aggregated, raw: !aggregated && !builder.groupBy.length });
		if (!aggregated && builder.groupBy.length) builder.pushGroup({ column: id, formulaId: id });
		out.push({ actionId: action.id, action: action.name, column: name });
		builder.info('card.url-column', `URL action "${action.name}" became a link column "${name}" at the end of the table (${picked ? 'its column already links another action' : 'no text column to link'})`);
	}
	return out;
}

function toTableFallback(builder, chartType) {
	builder.warn('chart.fallback', `Required slots for ${chartType} could not be filled; converted to a table`);
	for (const c of builder.columns) c.mapping = 'VALUE';
	return 'badge_basic_table';
}

function requiredSlotsMissing(chartType, columns) {
	const has = (mapping) => columns.some((c) => c.mapping === mapping);
	if (!columns.length) return false;
	if (chartType === 'badge_basic_table' || chartType === 'badge_table') return false;
	if (chartType === 'badge_pivot_table') return !has('VALUE') || (!has('ROW') && !has('COLUMN'));
	if (SCATTER.test(chartType)) return !has('XTIME') || !has('VALUE');
	if (chartType === 'badge_map_latlong') return !has('LATITUDE') || !has('LONGITUDE') || !has('VALUE');
	if (chartType === 'badge_gantt') return !has('ITEM') || !has('START_DATE');
	if (chartType === 'badge_vert_histogram') return !has('VALUE');
	if (KPI_TYPES.has(chartType)) return !has('VALUE');
	if (NEEDS_ITEM.test(chartType)) return !has('ITEM') || (!has('VALUE') && columns.filter((c) => c.mapping === 'SERIES' && isAggregated(c)).length < 2);
	return false;
}

/**
 * Pivot table total and subtotal properties from Tableau's grand totals, subtotaled pills and total placement. Every
 * switch is written, because Phoenix shows grand totals and subtotals unless told not to (badge_pivot_table.json defaults).
 * Phoenix subtotals every header level of an axis; a header Tableau does not subtotal gets the column format
 * `tableColumn.hideSubtotal` (PivotTableCSR reads `tableColumn_hideSubtotal` per header). Mutates the columns.
 */
function pivotTotals(ws, slots) {
	const { rows, cols, subtotals = [], rowsOnTop, colsOnLeft } = ws.totals ?? {};
	const fieldOf = (id) => pillFor(ws, id).fieldId;
	const subtotaled = new Set(subtotals.map(fieldOf));
	const on = (v) => (v ? 'true' : 'false');
	const subtotalRows = (ws.rowPills ?? []).some((id) => subtotaled.has(fieldOf(id)));
	const subtotalCols = (ws.colPills ?? []).some((id) => subtotaled.has(fieldOf(id)));
	const overrides = { total_row: on(rows), total_col: on(cols), subtotal_rows: on(subtotalRows), subtotal_columns: on(subtotalCols) };
	if (rows) overrides.total_row_label = 'Grand Total';
	if (cols) overrides.total_column_label = 'Grand Total';
	if (subtotalRows) overrides.subtotal_rows_label = 'Total';
	if (subtotalCols) overrides.subtotal_columns_label = 'Total';
	if (rowsOnTop && rows) overrides.total_row_position = 'Before';
	if (rowsOnTop && subtotalRows) overrides.subtotal_rows_position = 'Before';
	if (colsOnLeft && cols) overrides.total_col_position = 'Before';
	if (colsOnLeft && subtotalCols) overrides.subtotal_cols_position = 'Before';
	for (const [mapping, active] of [['ROW', subtotalRows], ['COLUMN', subtotalCols]]) {
		if (!active) continue;
		for (const slot of slots.filter((s) => s.column.mapping === mapping && !subtotaled.has(fieldOf(s.pillId)))) {
			slot.column.format = { ...slot.column.format, tableColumn: { ...slot.column.format?.tableColumn, hideSubtotal: true } };
		}
	}
	return overrides;
}

/**
 * The crosstab's innermost column header spread into one value column per member, in Tableau's order:
 * `<AGG>(CASE WHEN <header> = <member> THEN <measure> END)`, then the measure itself as "Grand Total" when Tableau totals
 * the columns. A header or measure that cannot be written per member (a date, an aggregate calc, a card formula
 * aggregation or table calc) stays a column of its own before the values. Mutates the builder.
 */
function spreadMembers(builder, ws, spread) {
	const slot = builder.slots.find((s) => s.pillId === spread.measure);
	const { pill, binding: dim } = builder.resolve(spread.pillId);
	const measure = slot && builder.resolve(spread.measure).binding;
	const column = slot?.column;
	const dimExpr = dim && !dim.aggregated && !builder.isDateBinding(dim) && !pill.datePart && !pill.dateTrunc ? bindingExpression(dim) : undefined;
	const plain = column?.aggregation && measure && refKey(column) === refKey(refOf(measure));
	const measureExpr = plain ? bindingExpression(measure) : undefined;
	if (!dimExpr || !measureExpr) {
		builder.add({ pillId: spread.pillId, mapping: 'VALUE', role: 'dim' });
		const values = builder.columns.filter((c) => c.mapping === 'VALUE' && isAggregated(c));
		builder.columns = [...builder.columns.filter((c) => !values.includes(c)), ...values];
		builder.info('chart.crosstab-spread', `${builder.fieldName(pill, dim)} stays a column: its members cannot be written as one value column each`);
		return;
	}
	const spreadColumns = spread.members.map((member) => {
		const id = builder.addFormula({ name: String(member), formula: `${column.aggregation}(CASE WHEN ${dimExpr} = ${sqlLiteral(member)} THEN ${measureExpr} END)`, dataType: 'numeric', aggregated: true });
		const c = { column: id, formulaId: id, mapping: 'VALUE' };
		if (column.format) c.format = { ...column.format };
		META.set(c, { aggregated: true });
		return c;
	});
	const at = builder.columns.indexOf(column);
	const total = ws.totals?.cols ? [{ ...column, alias: 'Grand Total' }] : [];
	for (const c of total) META.set(c, { aggregated: true });
	builder.columns.splice(at, 1, ...spreadColumns, ...total);
	if (total.length) slot.column = total[0];
	else builder.slots.splice(builder.slots.indexOf(slot), 1);
}

const NUMBER_TYPES = /^(long|double|decimal|integer|real)$/i;

/**
 * Mega Table totals for a crosstab: Tableau's grand total row (label "Grand Total", above the rows for "totals to top"),
 * and subtotals when Tableau subtotals the first row header (a Mega Table subtotals its first column only; TableQueryService
 * groups the subtotal query by it). Dimension columns show no counts in those rows, and a number used as a header is not
 * summed into them (Phoenix `tableColumn_hideTotal`). Mutates the columns.
 */
function crosstabTotals(builder) {
	const { ws } = builder;
	const { rows, subtotals = [], rowsOnTop } = ws.totals ?? {};
	const fieldOf = (id) => pillFor(ws, id).fieldId;
	const subtotaled = new Set(subtotals.map(fieldOf));
	const dims = builder.slots.filter((s) => s.role === 'dim');
	const first = dims[0];
	const subtotalRows = Boolean(first) && subtotaled.has(fieldOf(first.pillId)) && builder.columns[0] === first.column;
	const on = (v) => (v ? 'true' : 'false');
	const overrides = { total_row: on(rows), subtotal_rows: on(subtotalRows) };
	if (rows) Object.assign(overrides, { total_row_label: 'Grand Total', total_row_suppress_count: 'true' }, rowsOnTop ? { total_row_position: 'Before' } : {});
	if (subtotalRows) Object.assign(overrides, { subtotal_rows_label: 'Total', subtotal_suppress_count: 'true' }, rowsOnTop ? { subtotal_rows_position: 'Before' } : {});
	const others = dims.filter((s) => s !== first && subtotaled.has(fieldOf(s.pillId)));
	if (others.length) {
		builder.info('chart.crosstab-subtotals', `Subtotals on ${others.map((s) => builder.fieldName(pillFor(ws, s.pillId))).join(', ')} are not shown: a Mega Table subtotals its first column only`);
	}
	for (const s of dims) {
		const binding = builder.resolve(s.pillId).binding;
		if (!binding || s.column.formulaId !== binding.formulaId || !NUMBER_TYPES.test(String(binding.dataType ?? binding.tableauType ?? ''))) continue;
		s.column.format = { ...s.column.format, tableColumn: { ...s.column.format?.tableColumn, hideTotal: true, hideSubtotal: true } };
	}
	return overrides;
}

/** Tableau's totals fill and text colors on the totals turned on (TableCSR and PivotTableCSR `*_fill_color` / `*_font_color`). */
export function totalsStyleOverrides(style, overrides) {
	const out = {};
	const totalColor = style.totalColor ?? style.subtotalColor;
	const totalWeight = style.totalWeight ?? style.subtotalWeight;
	const set = (on, prefix, attr, { fill, text, weight }) => {
		if (overrides[on] !== 'true') return;
		if (opaqueHex(fill)) out[`${prefix}_fill_color`] = opaqueHex(fill);
		if (opaqueHex(text)) out[`${prefix}_font_color`] = opaqueHex(text);
		if (weight) out[attr] = weight === 'bold' ? 'Bold' : 'Plain';
	};
	const total = { fill: style.totalBackground, text: totalColor, weight: totalWeight };
	const subtotal = { fill: style.subtotalBackground, text: style.subtotalColor, weight: style.subtotalWeight };
	set('total_row', 'total_row', 'attr_total_row', total);
	set('total_col', 'total_col', 'attr_total_col', total);
	set('subtotal_rows', 'subtotal_row', 'attr_subtotal_rows', subtotal);
	set('subtotal_columns', 'subtotal_col', 'attr_subtotal_cols', subtotal);
	return out;
}

/** Card formulas the subscription or a quick filter references (the crosstab drops the spread header's rank formula). */
function usedFormulas(formulas, subscription, controls) {
	const text = JSON.stringify([subscription, controls]);
	return formulas.filter((f) => text.includes(`"${f.id}"`));
}

/** Domo has one calendar per card, so it takes the most used non-January start and the other date fields get an issue. */
export function fiscalCalendarFor(uses) {
	const counts = new Map();
	for (const u of uses) if (u.startMonth > 1) counts.set(u.startMonth, (counts.get(u.startMonth) ?? 0) + 1);
	if (!counts.size) return {};
	const startMonth = [...counts].sort((a, b) => b[1] - a[1])[0][0];
	const others = [...new Set(uses.filter((u) => u.startMonth !== startMonth).map((u) => `${u.name} (${u.startMonth > 1 ? `fiscal year from ${fiscalStartName(u.startMonth)}` : 'calendar year'})`))];
	const fiscalNames = [...new Set(uses.filter((u) => u.startMonth === startMonth).map((u) => u.name))];
	const issue = others.length
		? `Domo applies one calendar to a card: ${fiscalNames.join(', ')} use a fiscal year starting in ${fiscalStartName(startMonth)}, so the card uses that fiscal calendar, and the years, quarters, months or weeks of ${others.join(', ')} follow it too`
		: undefined;
	return { startMonth, ...(issue ? { issue } : {}) };
}

function bigNumberFor(chartType, columns, family, main) {
	const values = columns.filter((c) => c.mapping === 'VALUE');
	const isKpi = KPI_TYPES.has(chartType);
	if (!isKpi && (values.length !== 1 || ['table', 'pivot', 'crosstab', 'fallback', 'scatter', 'histogram', 'gantt'].includes(family))) return undefined;
	const v = values[0];
	if (!v || !isAggregated(v)) return undefined;
	if (!isKpi && v.aggregation && !['SUM', 'COUNT'].includes(v.aggregation)) return undefined;
	const column = { ...(v.formulaId ? { column: v.formulaId, formulaId: v.formulaId } : { column: v.column }), format: { type: 'abbreviated', format: '#' } };
	if (v.aggregation) column.aggregation = v.aggregation;
	const out = { columns: [column], groupBy: [], orderBy: [], filters: main.filters, limit: 1, fiscal: Boolean(main.fiscal), projection: false, distinct: false };
	if (main.dateRangeFilter) out.dateRangeFilter = main.dateRangeFilter;
	return out;
}

const controlDefault = (control) => ({ column: control.column, ...(control.formulaId ? { formulaId: control.formulaId } : {}), name: control.name, dataType: control.type, operand: control.operator, values: control.values });

/** Filters `shown` on a dashboard, the card's `quick` filters (IR 15: the worksheet window's filter cards), and the rest. */
function shownFilters(ws, filterZones, { windowCards = false } = {}) {
	const zones = filterZones.get(ws.name) ?? new Map();
	const shown = [];
	const modes = new Map();
	const allMembers = (pillId) => {
		const pill = pillFor(ws, pillId);
		if (/Measure Names/i.test(pill.fieldId) || pill.datasourceId === 'Parameters') return undefined;
		return { pillId, datasourceId: pill.datasourceId, fieldId: pill.fieldId, kind: 'categorical', all: true, aggregated: pill.aggregated || undefined };
	};
	for (const f of ws.filters ?? []) {
		if (f.shownOnDashboard || zones.has(f.pillId)) {
			shown.push(f);
			if (zones.has(f.pillId)) modes.set(f.pillId, zones.get(f.pillId));
		}
	}
	for (const [pillId, mode] of zones) {
		if (shown.some((f) => f.pillId === pillId)) continue;
		const filter = allMembers(pillId);
		if (!filter) continue;
		shown.push(filter);
		modes.set(pillId, mode);
	}
	if (!windowCards) return { shown, modes, quick: shown, dashboardOnly: [] };
	const cards = new Map((ws.quickFilters ?? []).map((c) => [c.pillId, c.mode ?? '']));
	const quick = (ws.filters ?? []).filter((f) => cards.has(f.pillId));
	for (const [pillId, mode] of cards) {
		modes.set(pillId, mode);
		if (quick.some((f) => f.pillId === pillId)) continue;
		const filter = shown.find((f) => f.pillId === pillId) ?? allMembers(pillId);
		if (filter) quick.push(filter);
	}
	return { shown, modes, quick, dashboardOnly: shown.filter((f) => !cards.has(f.pillId)) };
}

const MARK_ONLY_ENCODINGS = new Set(['shape', 'detail', 'path']);

/**
 * The issue for a worksheet that shows no data field (only its title, a parameter, or a bare shape mark), or
 * undefined when its shelves hold a data field.
 * @returns {Issue|undefined}
 */
export function fieldlessSheetIssue(ws) {
	const shelf = [...(ws.rowPills ?? []), ...(ws.colPills ?? [])];
	const encoded = (ws.panes ?? []).flatMap((pane) => Object.entries(pane.encodings ?? {}).flatMap(([kind, ids]) => (ids ?? []).map((id) => ({ kind, pill: pillFor(ws, id) }))));
	if (shelf.length || encoded.some((e) => e.pill.datasourceId !== 'Parameters' && !MARK_ONLY_ENCODINGS.has(e.kind))) return undefined;
	if (encoded.some((e) => e.pill.datasourceId !== 'Parameters')) {
		if (!(ws.panes ?? []).every((pane) => pane.markClass === 'Shape')) return undefined;
		return makeIssue(ws, 'warning', 'card.ui-sheet', `Worksheet ${ws.name} shows a single shape mark with no row or column fields (a dashboard button or icon); no Domo card`, 'Add a Domo image or link on the page if it is needed.');
	}
	if (encoded.length) {
		return makeIssue(ws, 'warning', 'card.parameter-label', `Worksheet ${ws.name} only shows parameter values as text; no Domo card`, 'Show the value in a page header or a variable control.');
	}
	const title = String(ws.title ?? '').trim();
	if (title) {
		const refresh = UPDATE_TIME.test(title) ? '; it becomes a text card at the top of each view that shows it, with its data update time as "Date last updated" smart text' : '';
		return makeIssue(ws, 'info', 'card.title-only', `Worksheet ${ws.name} has no fields and only shows its title text${refresh}; no Domo card`);
	}
	return makeIssue(ws, 'info', 'card.empty-sheet', `Worksheet ${ws.name} is empty (no fields); skipped`);
}

/** CardPlan.split for a pane dimension: its filter, the members an include filter names, and its member colors. */
function splitSpec(builder, ws, pillId) {
	const { pill, binding } = builder.resolve(pillId);
	if (!binding || binding.aggregated || pill.datePart || pill.dateTrunc) {
		builder.warn('chart.small-multiples', `${builder.fieldName(pill, binding)} splits the view into panes; it cannot filter a Domo card, so the panes are drawn together`);
		return undefined;
	}
	const spec = { pillId, name: builder.fieldName(pill, binding), ref: refOf(binding), filter: { ...filterRef(binding), operand: 'IN', dataType: filterDataType(binding) }, max: MAX_SPLIT_CARDS };
	const sort = (ws.sorts ?? []).find((s) => s.pillId === pillId);
	if (sort?.kind === 'manual' && sort.order?.length) spec.order = sort.order.map(String);
	else if (sort?.direction === 'DESC' && sort.kind !== 'computed') spec.direction = 'DESC';
	const include = (ws.filters ?? []).find((f) => f.fieldId === pill.fieldId && f.kind === 'categorical' && !f.hidden && !f.ranges && f.include?.length);
	if (include) spec.members = include.include.map(String);
	const sameField = (id) => pillFor(ws, id).fieldId === pill.fieldId;
	if (ws.color?.type === 'palette' && sameField(ws.color.pillId)) {
		spec.colors = Object.fromEntries((ws.color.members ?? []).filter((m) => m.value !== null && m.value !== undefined).map((m) => [String(m.value), m.color]));
		const columns = markPanes(ws)
			.filter((p) => (p.encodings?.color ?? []).some(sameField))
			.map((p) => builder.pillRefs.get(p.yAxisPill ?? p.xAxisPill)?.ref.column)
			.filter(Boolean);
		spec.colorColumns = [...new Set(columns)];
	}
	const measures = splitMeasures(builder);
	if (measures) Object.assign(spec, { expression: bindingExpression(binding), measures });
	builder.approximate = true;
	return spec;
}

const CARD_AGGREGATIONS = new Set(Object.values(AGGREGATIONS));

/**
 * Each value column of a split card as an aggregated card formula that counts only the member's rows (SPLIT_MEMBER stands
 * for the member condition), so every member card keeps all the categories, as Tableau's panes share one axis. Undefined
 * when a measure cannot take the condition; the member cards then filter on the member.
 */
function splitMeasures(builder) {
	const out = [];
	for (const slot of builder.slots.filter((s) => s.role !== 'dim')) {
		const column = slot.column;
		const cardFormula = builder.formulas.find((f) => f.id === column.column);
		const { pill, binding } = builder.resolve(slot.pillId);
		let formula;
		if (cardFormula) formula = cardFormula.aggregated ? conditionAggregates(cardFormula.formula, SPLIT_MEMBER) : undefined;
		else if (column.aggregation) formula = CARD_AGGREGATIONS.has(column.aggregation) && bindingExpression(binding) ? `${column.aggregation}(CASE WHEN ${SPLIT_MEMBER} THEN ${bindingExpression(binding)} END)` : undefined;
		else if (binding?.kind === 'formula' && binding.aggregated && !binding.lodExpression && !pill.tableCalc && binding.expression) formula = conditionAggregates(binding.expression, SPLIT_MEMBER);
		if (!formula) return undefined;
		out.push({ column: column.column, name: cardFormula?.name ?? builder.fieldName(pill, binding), formula });
	}
	return out.length ? out : undefined;
}

/** Hide filters only some panes encode, turned into conditions inside those panes' measures. Returns the filters taken. */
function paneHides(ws, bindings, builder) {
	const taken = new Set();
	for (const f of ws.filters ?? []) {
		if (!f.hidden || f.kind !== 'categorical' || f.all || f.aggregated) continue;
		const members = f.exclude ?? f.include;
		if (!members?.length) continue;
		const binding = bindings?.get?.(f.datasourceId, f.fieldId);
		const name = binding?.name ?? stripBrackets(f.fieldId);
		const where = hiddenScope(ws, f);
		if (where.scope === 'rows') {
			if (tableCalcAlong(ws, f)) builder.warn('filter.hidden', `Hidden members of ${name} still feed Tableau's table calculations; the Domo card filters their rows out`);
			continue;
		}
		const condition = binding && memberCondition(binding, members, { exclude: Boolean(f.exclude) });
		if (!condition || !where.measures.every((id) => builder.canWrap(id))) {
			builder.warn('filter.hidden', `Hidden members of ${name} hide marks of some panes only in Tableau; kept as a row filter, which also changes the other panes' values`);
			continue;
		}
		for (const id of where.measures) builder.paneConditions.set(id, [...(builder.paneConditions.get(id) ?? []), condition]);
		taken.add(f);
		builder.info('filter.hidden', `Hidden members of ${name} are left out of ${where.measures.map((id) => builder.fieldName(pillFor(ws, id))).join(', ')} only, as Tableau hides marks without filtering rows`);
	}
	return taken;
}

/**
 * Plan one Domo card for one worksheet.
 *
 * @param {WorksheetIR} ws
 * @param {WorkbookIR} ir
 * @param {FieldBindings} bindings
 * @param {{ key: string, datasetKey: string, filterZones?: Map<string, Map<string,string>>, scopedPills?: Set<string>, legend?: import('./chart-options.js').LegendPlacement, options?: ConvertOptions, variables?: Map<string, string> }} ctx
 *   scopedPills: the sheet's copies of filters shown on a dashboard for other sheets too (dashboardFilterScopes)
 * @returns {{ card: CardPlan, issues: Issue[] }}
 */
export function planCard(ws, ir, bindings, { key, datasetKey, filterZones = new Map(), scopedPills = new Set(), legend, options = {}, variables }) {
	const inference = inferChart(ws, ir, bindings);
	const builder = new CardBuilder(ws, ir, bindings, datasetKey, inference, options);
	builder.issues.push(...inference.warnings);
	if (inference.warnings.some((w) => w.severity !== 'info')) builder.approximate = true;
	const paneHidden = paneHides(ws, bindings, builder);
	for (const m of inference.mappings) builder.add(m);
	for (const pillId of inference.detail ?? []) builder.addDetail(pillId);
	if ((inference.detail ?? []).length) builder.info('chart.detail', 'Detail-shelf dimensions added to the card grouping');
	for (const pillId of inference.sortOnly ?? []) builder.addSortOnly(pillId);
	if (inference.spread) spreadMembers(builder, ws, inference.spread);

	let chartType = inference.chartType;
	const measureSeries = builder.columns.filter((c) => c.mapping === 'SERIES' && isAggregated(c));
	if (measureSeries.length === 1 && !builder.columns.some((c) => c.mapping === 'VALUE')) {
		measureSeries[0].mapping = 'VALUE';
		const v = /horiz/.test(chartType) ? 'horiz' : 'vert';
		if (/_(multibar|stackedbar|line_bar)$/.test(chartType) && !builder.columns.some((c) => c.mapping === 'SERIES')) chartType = `badge_${v}_bar`;
	}
	if (requiredSlotsMissing(chartType, builder.columns)) chartType = toTableFallback(builder, chartType);
	const urlColumns = chartType === 'badge_basic_table' ? addUrlColumns(builder, ws, ir) : [];

	const hasAggregate = builder.columns.some(isAggregated);
	for (const c of builder.columns) {
		if (!isRaw(c)) continue;
		if (hasAggregate || (inference.family !== 'histogram' && builder.groupBy.length)) {
			builder.pushGroup(c.formulaId ? { column: c.column, formulaId: c.formulaId } : { column: c.column });
		}
	}
	const groupBy = inference.family === 'histogram' || KPI_TYPES.has(chartType) ? [] : builder.groupBy;

	const datasourceId = ws.datasourceIds?.[0];
	const { shown, modes, quick, dashboardOnly } = shownFilters(ws, filterZones, { windowCards: (ir.irVersion ?? 1) >= 15 });
	const sheetFilters = (ws.filters ?? []).filter((f) => !paneHidden.has(f));
	const datasourceFilters = ((ir.datasources ?? []).find((d) => d.id === datasourceId)?.filters ?? []).filter(
		(f) => !(ws.filters ?? []).some((s) => s.fieldId === f.fieldId && s.kind === f.kind)
	);
	const viewPills = groupBy.length ? [...(ws.rowPills ?? []), ...(ws.colPills ?? []), ...(ws.panes ?? []).flatMap((p) => Object.values(p.encodings ?? {}).flat())].map((id) => pillFor(ws, id)) : [];
	const viewDimensions = new Set(viewPills.filter((p) => !p.aggregated && !p.tableCalc && String(p.derivation).toLowerCase() === 'none').map((p) => p.fieldId));
	const controlCtx = { datasetKey, datasourceId, object: { type: 'worksheet', name: ws.name }, dataSourceId: ref('dataset', datasetKey), viewDimensions };
	const { controls, issues: controlIssues, pillIds: controlled, sources: controlSources } = toQuickFilterControls(quick, bindings, { ...controlCtx, modes });
	const skipPillIds = new Set(quick.filter((f) => controlled.has(f.pillId) && !exceedsSlicerLimit(f)).map((f) => f.pillId));
	// The page filter takes a dashboard-only selection; a fixed card filter on its column would fight the view's filter card.
	const dashboardDefaults = toQuickFilterControls(dashboardOnly, bindings, { ...controlCtx, modes, maxSlicers: Infinity });
	const dashboardDefaultPills = new Set(dashboardDefaults.controls.flatMap((c, i) => (c.values.length ? dashboardDefaults.sources[i] : [])).filter((pillId) => !skipPillIds.has(pillId)));
	for (const f of dashboardOnly) if (dashboardDefaults.pillIds.has(f.pillId) && !dashboardDefaultPills.has(f.pillId) && !exceedsSlicerLimit(f)) skipPillIds.add(f.pillId);
	const filterResult = toCardFilters([...sheetFilters, ...datasourceFilters], bindings, {
		datasetKey,
		datasourceId,
		object: { type: 'worksheet', name: ws.name },
		parameters: ir.parameters,
		addFormula: (spec) => builder.addFormula(spec),
		viewDimensions,
		worksheet: ws,
		skipPillIds,
		trackPillIds: new Set([...scopedPills, ...dashboardDefaultPills].filter((pillId) => !skipPillIds.has(pillId)))
	});
	const dashboardFixed = new Map();
	for (const origin of filterResult.origins) {
		if (!dashboardDefaultPills.has(origin.filter.pillId)) continue;
		dashboardFixed.set(origin.filter.pillId, structuredClone(origin.filters));
		for (const f of origin.filters) {
			const i = filterResult.filters.indexOf(f);
			if (i >= 0) filterResult.filters.splice(i, 1);
		}
	}
	builder.issues.push(...filterResult.issues);
	if (filterResult.approximate) builder.approximate = true;

	const sorts = sortEntries(builder, ws);
	let orderBy = itemFirst(builder, inference, sorts);
	const levelOrder = chartType === 'badge_pivot_table' || inference.family === 'crosstab';
	const nested = levelOrder && !filterResult.tops.length ? pivotOrder(builder, ws, sorts, { natural: chartType !== 'badge_pivot_table' }) : undefined;
	if (nested) orderBy = nested;
	const sortedPills = new Set((ws.sorts ?? []).map((s) => s.pillId));
	for (const pillId of nested ? [] : [...(inference.sortOnly ?? []), ...(inference.keptHeaders ?? [])]) {
		const known = builder.pillRefs.get(pillId);
		if (known && !sortedPills.has(pillId)) orderBy.push({ ...known.ref, order: 'ASCENDING' });
	}
	let limit;
	for (const top of filterResult.tops) {
		let entry = top.orderBy;
		if (!entry) {
			const v = builder.columns.find((c) => c.mapping === 'VALUE' && isAggregated(c));
			if (v) {
				entry = { ...(v.formulaId ? { column: v.formulaId, formulaId: v.formulaId } : { column: v.column }), order: top.direction === 'bottom' ? 'ASCENDING' : 'DESCENDING' };
				if (v.aggregation) entry.aggregation = v.aggregation;
				builder.warn('filter.top', `Top N ranking expression ${top.by ?? ''} not resolved; ranked by the first value column`);
			}
		}
		if (!entry) {
			builder.warn('filter.top', 'Top N filter could not be ranked; skipped');
			continue;
		}
		orderBy = [entry, ...orderBy];
		limit = limit ? Math.min(limit, top.count) : top.count;
		const item = inference.mappings.find((m) => m.mapping === 'ITEM' || m.mapping === 'ROW');
		const itemField = item && pillFor(ws, item.pillId).fieldId;
		const hasSeries = builder.columns.some((c) => c.mapping === 'SERIES' || c.mapping === 'COLUMN');
		if (hasSeries || (itemField && itemField !== top.fieldId)) {
			builder.warn('filter.top-limit', `Top ${top.count} on ${stripBrackets(top.fieldId)} became a row limit; with other dimensions on the card it limits rows, not ${stripBrackets(top.fieldId)} members`);
		}
		const topFilter = (ws.filters ?? []).find((f) => f.kind === 'top' && f.fieldId === top.fieldId);
		if (filterResult.having) {
			builder.warn('filter.top-order', `Top ${top.count} on ${stripBrackets(top.fieldId)}: Tableau picks the top members before measure filters remove any, Domo limits the rows left after them, so the card can show more members`);
		} else if (topFilter && topRankReason(ws, topFilter, ir.actions) === 'filter') {
			builder.warn('filter.top-order', `Top ${top.count} on ${stripBrackets(top.fieldId)}: Tableau ranks the members before the sheet's other filters, Domo limits the rows left after them, so the card can show other members`);
		}
	}
	orderBy = dedupeOrder(orderBy);

	builder.issues.push(...controlIssues);
	if (quick.length) builder.info('filter.interactive', `${quick.length} interactive filter(s) Tableau shows on the worksheet added as card quick filters instead of fixed card filters`);
	if (dashboardOnly.length) builder.info('filter.dashboard-only', `${dashboardOnly.length} filter(s) shown only on a dashboard are not card quick filters; the view's filter cards control them`);
	// A quick filter default on the card would not narrow the view's filter cards, so it goes into the view's Default filter view.
	const shownPills = new Set([...shown.map((f) => f.pillId), ...scopedPills]);
	const quickFilterDefaults = [];
	controls.forEach((control, i) => {
		if (!control.values.length || !controlSources[i].some((pillId) => shownPills.has(pillId))) return;
		quickFilterDefaults.push({ ...controlDefault(control), pillIds: controlSources[i] });
		control.values = [];
	});
	dashboardDefaults.controls.forEach((control, i) => {
		const fixed = dashboardDefaults.sources[i].flatMap((pillId) => dashboardFixed.get(pillId) ?? []);
		if (control.values.length && fixed.length) quickFilterDefaults.push({ ...controlDefault(control), pillIds: dashboardDefaults.sources[i], fixed });
	});

	const { title, titleItems, description, dynamicDescription, issues: titleIssues } = cardTitle(ws, ir, bindings, variables);
	builder.issues.push(...titleIssues);
	const subscription = {
		columns: builder.columns,
		groupBy,
		orderBy,
		filters: filterResult.filters,
		limit,
		dateGrain: builder.dateGrain,
		dateRangeFilter: filterResult.dateRangeFilter
	};
	const fiscal = fiscalCalendarFor([...builder.calendarUses, ...filterResult.calendarUses]);
	if (fiscal.issue) builder.warn('card.fiscal-mixed', fiscal.issue);
	if (fiscal.startMonth) subscription.fiscal = true;
	const slots = builder.slots.map((s) => ({ pillId: s.pillId, mapping: s.column.mapping, role: s.role, ...(s.derived ? { derived: s.derived } : {}) }));
	const markText = markTextOverrides(ws, ir, { chartType, family: inference.family, slots });
	const legendPosition = legendOverrides(ws, legend, { chartType, slots });
	const axisRange = axisRangeOverrides(ws, { chartType, slots });
	const stackSort = stackSortOverrides(ws, { chartType, slots });
	builder.issues.push(...markText.issues, ...legendPosition.issues, ...axisRange.issues, ...stackSort.issues);
	let overrides = { ...legendPosition.overrides, ...markText.overrides, ...axisRange.overrides, ...stackSort.overrides };
	if (chartType === 'badge_pivot_table') {
		overrides = pivotTotals(ws, builder.slots);
		const columnSort = pivotHeaderSorts(builder, ws);
		if (columnSort) overrides.column_sort = columnSort;
	} else if (inference.family === 'crosstab') overrides = crosstabTotals(builder);
	else if (inference.family === 'table' && ws.totals?.rows) Object.assign(overrides, crosstabTotals(builder));
	Object.assign(overrides, totalsStyleOverrides({ ...ir.style?.table, ...ws.tableStyle }, overrides));
	const negatives = negativeNumberOverrides(ws, { chartType, styles: [...builder.negativeStyles.values()] });
	builder.issues.push(...negatives.issues);
	Object.assign(overrides, negatives.overrides);
	if (chartType === 'badge_basic_table' && measureNamesAsRows(ws)) overrides.transposed = 'true';
	Object.assign(overrides, inference.overrides);
	const formulas = inference.family === 'crosstab' ? usedFormulas(builder.formulas, subscription, controls) : builder.formulas;
	const colors = cardColorRules(ws, { family: TABLE_CHARTS.has(chartType) ? 'table' : inference.family, slots: builder.slots, dataSourceId: ref('dataset', datasetKey) });
	const split = inference.split ? splitSpec(builder, ws, inference.split.pillId) : undefined;
	builder.issues.push(...colors.issues.filter((i) => !(split?.colors && i.code === 'card.colors-dropped')));
	reverseStackSeries(builder, colors.rules, overrides);
	const body = buildCardBody({ title, titleItems, description, dynamicDescription, datasetKey, chartType, subscription, formulas, controls, overrides, colorRules: colors.rules });
	const main = body.definition.subscriptions.main;
	const bigNumber = bigNumberFor(chartType, builder.columns, inference.family, main);

	let status = builder.approximate || builder.issues.some((i) => i.severity !== 'info') ? 'approximate' : 'ok';
	if (!builder.columns.length) {
		status = 'unsupported';
		builder.issues.push(makeIssue(ws, 'error', 'card.empty', `No field of ${ws.name} could be placed on a Domo card`));
	}
	/** @type {CardPlan} */
	const card = { key, title, worksheet: ws.name, datasetKey, chartType, body, pageKeys: [], status };
	if (bigNumber) card.bigNumber = bigNumber;
	if (fiscal.startMonth) card.fiscalCalendar = { startMonth: fiscal.startMonth, labelByEndYear: true };
	if (quickFilterDefaults.length) card.quickFilterDefaults = quickFilterDefaults;
	const scopedFilters = filterResult.origins.filter((o) => o.filters.length && !dashboardDefaultPills.has(o.filter.pillId)).map(({ filter, filters }) => {
		const [control] = toQuickFilterControls([filter], bindings, controlCtx).controls;
		return { pillId: filter.pillId, ...(control?.values.length ? { default: controlDefault(control) } : {}), filters: structuredClone(filters) };
	});
	if (scopedFilters.length) card.scopedFilters = scopedFilters;
	if (split) card.split = split;
	if (urlColumns.length) card.urlColumns = urlColumns;
	return { card, issues: builder.issues, slots, family: inference.family };
}

/**
 * One CardPlan per worksheet that is visible or placed on a dashboard.
 *
 * @param {WorkbookIR} ir
 * @param {FieldBindings} bindings
 * @param {{ options?: ConvertOptions, workbookKey?: string, scopes?: Map<string, import('./filters.js').FilterScope[]>, variables?: import('../model/types.js').VariablePlan[] }} [opts]
 * @returns {{ cards: CardPlan[], issues: Issue[] }}
 */
export function planCards(ir, bindings, { workbookKey, options = {}, scopes, variables: planned = [] } = {}) {
	const variables = new Map(planned.filter((v) => v.parameter?.id).map((v) => [v.parameter.id, v.key]));
	const cards = [];
	const issues = [];
	const { sheets, filterZones } = dashboardUsage(ir);
	const scopedPills = new Map();
	for (const onDashboard of (scopes ?? dashboardFilterScopes(ir)).values()) {
		for (const scope of onDashboard) {
			for (const [name, pillId] of scope.members) scopedPills.set(name, (scopedPills.get(name) ?? new Set()).add(pillId));
		}
	}
	const legends = legendPlacements(ir);
	const usedKeys = new Set();
	for (const ws of ir?.worksheets ?? []) {
		if (ws.hidden && !sheets.has(ws.name)) {
			issues.push(makeIssue(ws, 'info', 'card.hidden-sheet', `Hidden worksheet ${ws.name} is not on any dashboard; skipped`));
			continue;
		}
		const datasourceId = ws.datasourceIds?.[0];
		const datasetKey = datasourceId ? bindings?.datasetKeyFor?.(datasourceId) : undefined;
		const fieldless = fieldlessSheetIssue(ws);
		if (fieldless) {
			issues.push(fieldless);
			if (!datasetKey) continue;
			// An unsupported card keeps the dashboard zone accounted for; push skips it.
			const key = cardKeyFor(ws.name, usedKeys, workbookKey);
			const { title } = cardTitle(ws, ir, bindings);
			const chartType = 'badge_basic_table';
			cards.push({ key, title, worksheet: ws.name, datasetKey, chartType, body: buildCardBody({ title, datasetKey, chartType, subscription: {} }), pageKeys: [], status: 'unsupported' });
			continue;
		}
		if (!datasetKey) {
			issues.push(makeIssue(ws, 'error', 'card.no-dataset', `Worksheet ${ws.name} has no Domo dataset${datasourceId ? ` for datasource ${datasourceId}` : ''}; skipped`));
			continue;
		}
		if ((ws.datasourceIds ?? []).length > 1) {
			issues.push(makeIssue(ws, 'warning', 'card.blend', `Worksheet ${ws.name} blends ${ws.datasourceIds.length} datasources; only fields from the primary one are kept`));
		}
		const key = cardKeyFor(ws.name, usedKeys, workbookKey);
		try {
			const ctx = { key, datasetKey, filterZones, scopedPills: scopedPills.get(ws.name), legend: legends.get(ws.name) ?? (sheets.has(ws.name) ? { position: 'hidden' } : undefined), options, variables };
			const result = planCard(ws, ir, bindings, ctx);
			const drill = planDrillPath(ws, ir, result.card, { slots: result.slots, family: result.family, bindings, planView: (view) => planCard(view, ir, bindings, ctx) });
			if (drill.drillPath.length) result.card.drillPath = drill.drillPath;
			cards.push(result.card);
			issues.push(...result.issues, ...drill.issues);
		} catch (err) {
			issues.push(makeIssue(ws, 'error', 'card.failed', `Worksheet ${ws.name} could not be converted: ${err.message}`));
		}
	}
	return { cards, issues };
}

export { MEASURE_SLOTS };
export { titleText } from './titles.js';

const shelfPills = (node) => (!node ? [] : node.op === 'pill' ? [node.pillId] : (node.children ?? []).flatMap(shelfPills));

function measureNamesAsRows(ws) {
	const rows = shelfPills(ws.rows);
	const cols = shelfPills(ws.cols);
	return rows.some((id) => id.endsWith('[:Measure Names]')) && cols.length > 0 && !cols.some((id) => id.endsWith('[:Measure Names]'));
}
