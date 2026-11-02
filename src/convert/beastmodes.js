import { beastModeLegacyId, shortHash, slugify } from '../util/ids.js';
import { bmColumn, stripBrackets } from '../model/naming.js';
import { tableauToDomoType } from './schema.js';
import { relationParts } from './connectors.js';
import { analyzeFormula, parseFormula, translateCalc } from './calc/index.js';
import { NULL_VALUE } from './calc/sql.js';
import { tableCalcAddressing } from './calc/tablecalc.js';
import { pillWindowItem } from './filters.js';
import { textCaseSensitive, textIgnoresCase } from './member-case.js';
import { aliasedDefault, aliasedReference, parameterAliases, parameterVariableNames, siteVariables, variableReference } from './variables.js';
import { parsePillId } from '../tableau/twb/shelf.js';

const fiscalOf = (field) => (field.fiscalYearStart > 1 ? { fiscalYearStart: field.fiscalYearStart } : {});

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../model/types.js').FieldIR} FieldIR
 * @typedef {import('../model/types.js').ParameterIR} ParameterIR
 * @typedef {import('../model/types.js').DatasetPlan} DatasetPlan
 * @typedef {import('../model/types.js').BeastModePlan} BeastModePlan
 * @typedef {import('../model/types.js').VariablePlan} VariablePlan
 * @typedef {import('../model/types.js').FieldBinding} FieldBinding
 * @typedef {import('../model/types.js').FieldBindings} FieldBindings
 * @typedef {import('../model/types.js').Issue} Issue
 *
 * @typedef {Object} Computed
 * @property {string} expression
 * @property {boolean} aggregated
 * @property {import('../model/types.js').DomoColumnType} dataType
 * @property {'ok'|'approximate'|'unsupported'} status
 * @property {string[]} features
 * @property {Issue[]} issues
 * @property {string} [reason]
 */

const CALC_KINDS = new Set(['calculated', 'bin', 'group', 'set', 'count']);
const NUMERIC = new Set(['integer', 'real']);

function bracket(part) {
	return `[${String(part).replace(/\]/g, ']]')}]`;
}

/**
 * Interpret a raw member value as written in a TWB ('"East"', '#2020-01-01#',
 * '%null%', '42') when it arrives still in Tableau literal syntax.
 * @returns {{ kind: 'null' } | { kind: 'string'|'number'|'date', value: string }}
 */
export function decodeMember(value, datatype) {
	if (value === null || value === undefined) return { kind: 'null' };
	if (typeof value === 'number' || typeof value === 'bigint') return { kind: 'number', value: String(value) };
	if (typeof value === 'boolean') return { kind: 'string', value: value ? 'true' : 'false' };
	const text = String(value);
	if (text === '%null%') return { kind: 'null' };
	if (/^".*"$/s.test(text)) return { kind: 'string', value: text.slice(1, -1).replace(/""/g, '"') };
	if (/^#.*#$/.test(text)) return { kind: 'date', value: text.slice(1, -1) };
	if (NUMERIC.has(datatype) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text.trim())) return { kind: 'number', value: text.trim() };
	if (datatype === 'date' || datatype === 'datetime') return { kind: 'date', value: text };
	return { kind: 'string', value: text };
}

/** Beast Mode SQL literal. */
export function sqlLiteral(value, datatype) {
	const m = decodeMember(value, datatype);
	if (m.kind === 'null') return NULL_VALUE;
	if (m.kind === 'number') return m.value;
	return `'${m.value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Tableau formula literal, for synthesized formulas fed back to the calc translator. */
function tableauLiteral(value, datatype) {
	const m = decodeMember(value, datatype);
	if (m.kind === 'null') return 'NULL';
	if (m.kind === 'number') return m.value;
	if (m.kind === 'date') return `#${m.value}#`;
	return `"${m.value.replace(/"/g, '""')}"`;
}

function inList(source, values, datatype, literal) {
	const members = values.map((v) => decodeMember(v, datatype));
	const hasNull = members.some((m) => m.kind === 'null');
	const listed = values.filter((_, i) => members[i].kind !== 'null').map((v) => literal(v, datatype));
	const parts = [];
	if (listed.length) parts.push(`${source} IN (${listed.join(', ')})`);
	if (hasNull) parts.push(literal === sqlLiteral ? `${source} IS NULL` : `ISNULL(${source})`);
	if (!parts.length) return null;
	return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/** Default value expression of a Domo variable for a Tableau parameter. */
export function variableDefault(parameter) {
	const type = parameter.datatype;
	if (NUMERIC.has(type)) {
		const n = Number(parameter.value);
		return Number.isFinite(n) ? String(n) : '0';
	}
	if (type === 'boolean') return String(parameter.value).toLowerCase() === 'true' ? "'true'" : "'false'";
	return sqlLiteral(parameter.value === undefined ? '' : String(parameter.value).replace(/^#|#$/g, ''), 'string');
}

/** Parameter by id as a formula writes it ('[Parameters].[Parameter 1]', or its caption). */
export function parameterLookup(parameters) {
	return (id) => {
		const hit = parameters.find((p) => p.id === id);
		if (hit) return hit;
		const parts = relationParts(id);
		if (parts.length !== 2 || parts[0] !== 'Parameters') return undefined;
		return parameters.find((p) => relationParts(p.id).at(-1) === parts[1] || p.name === parts[1]);
	};
}

/** Field of `ds` by id as a formula writes it: '[Sales]', '[ds].[Sales]', or a display name. */
export function fieldLookup(ds) {
	const fields = ds.fields ?? [];
	const byId = new Map(fields.map((f) => [f.id, f]));
	const byName = new Map();
	for (const f of fields) if (!byName.has(f.name?.toLowerCase())) byName.set(f.name?.toLowerCase(), f);
	return (id) => {
		if (byId.has(id)) return byId.get(id);
		const parts = relationParts(id);
		if (parts.length === 2 && (parts[0] === ds.id || parts[0] === ds.caption || bracket(parts[0]) === ds.id)) {
			return byId.get(bracket(parts[1])) ?? byName.get(parts[1].toLowerCase());
		}
		if (parts.length === 1) return byName.get(parts[0].toLowerCase());
		return undefined;
	};
}

/** Bin size as a number (a parameter size uses its current value), or null. */
function binSizeOf(field, findParameter) {
	const raw = field.bin?.size;
	if (typeof raw === 'string' && raw.trim().startsWith('[')) {
		const n = Number(findParameter(raw.trim())?.value);
		return Number.isFinite(n) && n !== 0 ? n : null;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * Tableau formula equivalent of a calc field (bins, groups, static sets and counts included), so other calcs can
 * inline it; undefined when there is none.
 * @param {FieldIR} field
 * @param {{ lookupField: (id: string) => FieldIR|undefined, findParameter: (id: string) => ParameterIR|undefined, datasource?: DatasourceIR }} lookup
 */
export function calcFormula(field, { lookupField, findParameter, datasource }) {
	if (field.kind === 'calculated') return field.formula;
	// Number of Records is the row-level calc 1, so SUM([Number of Records]) inlines to SUM(1), not SUM(COUNT(1)).
	if (field.kind === 'count') return field.id.startsWith('[__tableau_internal_object_id__].') ? 'COUNT(1)' : '1';
	if (field.kind === 'bin') {
		const size = binSizeOf(field, findParameter);
		if (size === null) return undefined;
		const peg = Number(field.bin?.peg) || 0;
		const src = field.bin.source;
		return peg ? `FLOOR((${src} - ${peg}) / ${size}) * ${size} + ${peg}` : `FLOOR(${src} / ${size}) * ${size}`;
	}
	if (field.kind === 'group' && field.group) {
		const srcType = lookupField(field.group.source)?.datatype;
		const branches = (field.group.bins ?? [])
			.map((b) => {
				const cond = inList(field.group.source, b.values ?? [], srcType, tableauLiteral);
				return cond ? `${cond} THEN ${tableauLiteral(String(b.label), 'string')}` : null;
			})
			.filter(Boolean);
		if (!branches.length) return field.group.source;
		const other = field.group.otherLabel !== undefined ? tableauLiteral(String(field.group.otherLabel), 'string') : field.group.source;
		return `IF ${branches.join(' ELSEIF ')} ELSE ${other} END`;
	}
	if (field.kind === 'set' && field.set?.source && !field.set.unparsed && !field.set.top && !field.set.condition) {
		const source = lookupField(field.set.source);
		const srcType = source?.datatype;
		const members = inList(field.set.source, field.set.members ?? [], srcType, tableauLiteral);
		const foldCase = srcType === 'string' && !textCaseSensitive(source, datasource);
		const rangeSrc = foldCase ? `LOWER(${field.set.source})` : field.set.source;
		const bound = (v) => tableauLiteral(foldCase && typeof v === 'string' ? v.toLowerCase() : v, srcType);
		const ranges = (field.set.ranges ?? []).map((r) => `(${rangeSrc} >= ${bound(r.from)} AND ${rangeSrc} <= ${bound(r.to)})`);
		const listed = [members, ...ranges].filter(Boolean);
		if (!listed.length) return field.set.exclude || allMembers(field.set) ? 'TRUE' : 'FALSE';
		const src = field.set.source;
		// A set is never null: a null value is Out (In for an exclude set) unless the null member is listed.
		const nullListed = (field.set.members ?? []).some((m) => decodeMember(m, srcType).kind === 'null');
		const cond = nullListed ? listed.join(' OR ') : `NOT ISNULL(${src}) AND (${listed.join(' OR ')})`;
		return field.set.exclude ? `NOT (${cond})` : cond;
	}
	return undefined;
}

const isMeasureValues = (id) => /\[(:Measure Values|Multiple Values)\]$/.test(id);

/** Pill ids a worksheet displays: shelves, marks, and the Measure Values members when that pill is placed. */
function shownPillIds(ws) {
	const placed = [...(ws.rowPills ?? []), ...(ws.colPills ?? []), ...(ws.panes ?? []).flatMap((p) => Object.values(p.encodings ?? {}).flat())];
	return new Set([...placed, ...(placed.some(isMeasureValues) ? (ws.measureValues ?? []) : [])]);
}

/**
 * A set over all members ("Use all": level-members, ui-enumeration all). An IR parsed before `set.all` existed has a set
 * with no member list at all for it; an empty selection (empty-level) has `members: []`.
 */
const allMembers = (set) => !set.unparsed && (Boolean(set.all) || (Boolean(set.source) && !set.members && !set.ranges && !set.exclude && !set.condition && !set.top));

function savedSet(set) {
	if (!set?.source || !set.members?.length || set.unparsed || set.top || set.condition || set.ranges?.length || set.all) return {};
	return { set: { source: set.source, members: set.members, exclude: Boolean(set.exclude) } };
}

function issueFor(field, severity, code, message, suggestion) {
	return {
		severity,
		code,
		message,
		object: { type: 'field', name: field.name, id: field.id },
		...(suggestion ? { suggestion } : {})
	};
}

function unsupported(field, reason, code = 'calc.unsupported', dataType = 'STRING') {
	return {
		expression: '',
		aggregated: false,
		dataType,
		status: 'unsupported',
		features: [],
		issues: [issueFor(field, 'error', code, `'${field.name}': ${reason}`)],
		reason
	};
}

/**
 * Plan dataset beast modes for every calculated field, Domo variables for
 * parameters, and the field bindings that cards and filters use.
 *
 * @param {WorkbookIR} ir
 * @param {DatasetPlan[]} datasets
 * Beast modes on a shared dataset (`DatasetPlan.shared`, a published datasource used by several workbooks) are
 * keyed by (dataset key, field id) without the workbook, so workbooks defining the same calculation reuse one
 * beast mode. `shared.registry` lists the variants other workbooks already planned on each shared dataset; a
 * definition that differs from a variant with the same name or field id gets its own name, key and legacyId.
 *
 * `lodColumns` maps a datasource id to the lookup of its LOD expressions computed as columns in Magic ETL, and
 * `tableCalcColumns` to the lookup (calc field id, table calc node) of inner table calcs computed there.
 *
 * @param {{ options?: import('../model/types.js').ConvertOptions, workbookKey: string, translate?: typeof translateCalc, shared?: SharedBeastModeContext, lodColumns?: Map<string, (node: Object) => { column: string, datatype?: string }|undefined>, tableCalcColumns?: Map<string, (fieldId: string, node: Object) => { column: string, datatype?: string }|undefined> }} opts
 * @returns {{ beastModes: BeastModePlan[], variables: VariablePlan[], bindings: FieldBindings & { all: () => Map<string, Map<string, FieldBinding>> }, issues: Issue[] }}
 */
export function planBeastModes(ir, datasets, { options = {}, workbookKey, translate = translateCalc, shared, lodColumns, tableCalcColumns } = {}) {
	const wbKey = workbookKey || slugify(ir.workbook?.luid || ir.workbook?.name);
	const useVariables = options.parameters === 'variables';
	const beastModes = [];
	const variables = [];
	const issues = [];
	const parameters = ir.parameters ?? [];

	const variableByParam = new Map();
	if (useVariables) {
		const seen = new Set();
		const names = parameterVariableNames(ir);
		const local = parameters.map((p) => {
			let key = `${wbKey}.param.${slugify(p.name || stripBrackets(p.id))}`;
			for (let n = 2; seen.has(key); n++) key = `${wbKey}.param.${slugify(p.name)}-${n}`;
			seen.add(key);
			const aliases = parameterAliases(p);
			const keyType = tableauToDomoType(p.datatype);
			return { key, name: names.get(p.id) ?? p.name, legacyId: beastModeLegacyId(wbKey, 'variable', p.id), dataType: aliases ? 'STRING' : keyType, ...(aliases ? { keyType } : {}), defaultExpression: aliases ? aliasedDefault(p, aliases) : variableDefault(p), parameter: p };
		});
		for (const plan of siteVariables(local)) {
			variables.push(plan);
			variableByParam.set(plan.parameter.id, plan);
		}
	}

	const findParameter = parameterLookup(parameters);
	const parameterReference = (p) => {
		const variable = variableByParam.get(p.id);
		if (!variable) return bmColumn(p.name);
		const aliases = parameterAliases(p);
		return aliases ? aliasedReference(variable, aliases) : variableReference(variable);
	};

	/** @type {Map<string, Map<string, FieldBinding>>} */
	const bindingsByDs = new Map();
	const datasetByDs = new Map();
	const nameIndexByDs = new Map();

	for (const ds of ir.datasources ?? []) {
		const dataset = datasets.find((d) => d.cardTarget && d.datasourceId === ds.id);
		const bindings = new Map();
		bindingsByDs.set(ds.id, bindings);
		const nameIndex = new Map();
		nameIndexByDs.set(ds.id, nameIndex);
		for (const f of ds.fields ?? []) {
			if (!nameIndex.has(f.name?.toLowerCase())) nameIndex.set(f.name?.toLowerCase(), f.id);
		}
		if (!dataset) {
			for (const field of ds.fields ?? []) {
				if (field.kind === 'measure-names' || field.kind === 'measure-values') continue;
				bindings.set(field.id, {
					datasetKey: '',
					kind: 'unsupported',
					name: field.name,
					aggregated: false,
					tableauType: field.datatype,
					reason: `Datasource '${ds.caption}' has no Domo dataset`
				});
			}
			continue;
		}
		datasetByDs.set(ds.id, dataset.key);
		planDatasource(ds, dataset);
	}

	function planDatasource(ds, dataset) {
		const fieldMap = dataset.fieldMap ?? {};
		const bindings = bindingsByDs.get(ds.id);
		const fields = ds.fields ?? [];
		const lookupField = fieldLookup(ds);
		const schemaTypes = new Map((dataset.schema ?? []).map((c) => [c.name, c.type]));
		const columnNames = new Set([...(dataset.schema ?? []).map((c) => c.name.toLowerCase()), ...Object.values(fieldMap).map((c) => c.toLowerCase())]);
		const multiTable = (ds.tables ?? []).length > 1 && !['upload', 'connector', 'cloud-amplifier'].includes(dataset.sourceStrategy ?? dataset.strategy);

		const calcFields = fields.filter((f) => CALC_KINDS.has(f.kind));
		const bmNames = new Map();
		const takenNames = new Set(columnNames);
		for (const field of calcFields) {
			let name = field.name;
			if (takenNames.has(name.toLowerCase())) name = `${field.name} (calc)`;
			for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = `${field.name} (calc ${n})`;
			takenNames.add(name.toLowerCase());
			bmNames.set(field.id, name);
		}
		const sharedDataset = Boolean(dataset.shared);
		const idParts = sharedDataset ? ['site', dataset.key] : [wbKey, dataset.key];
		/** @type {Map<string, { hash?: string, legacyId?: string, name?: string, key?: string, keySuffix?: string }>} */
		const identities = new Map();
		const legacyOf = (field) => identities.get(field.id)?.legacyId ?? beastModeLegacyId(...idParts, field.id);
		const nameOf = (id) => identities.get(id)?.name ?? bmNames.get(id);

		// Tableau applies datasource filters before FIXED, and they become card WHERE conditions in Domo.
		const datasourceFilterColumns = (ds.filters ?? []).filter((f) => fieldMap[f.fieldId]).map((f) => fieldMap[f.fieldId]);
		const contextFilterColumns = [
			...new Set([
				...datasourceFilterColumns,
				...(ir.worksheets ?? [])
					.flatMap((w) => w.filters ?? [])
					.filter((f) => f.context && f.datasourceId === ds.id && fieldMap[f.fieldId])
					.map((f) => fieldMap[f.fieldId])
			])
		];

		const contextSets = new Set(
			(ir.worksheets ?? [])
				.filter((w) => (w.datasourceIds ?? []).includes(ds.id))
				.map((w) => JSON.stringify([...new Set((w.filters ?? []).filter((f) => f.context && f.datasourceId === ds.id).map((f) => f.fieldId))].sort()))
		);
		const contextDiffers = contextSets.size > 1;

		const referenceFormula = (field) => calcFormula(field, { lookupField, findParameter, datasource: ds });
		const binSize = (field) => binSizeOf(field, findParameter);

		/** @type {Map<string, Computed>} */
		const computed = new Map();
		const inProgress = new Set();

		const resolveField = (id) => {
			const param = findParameter(id);
			if (param) return { kind: 'parameter', parameter: param };
			const field = lookupField(id);
			if (!field) return undefined;
			if (field.kind === 'column') {
				const column = fieldMap[field.id];
				if (!column) return undefined;
				const domoType = schemaTypes.get(column) ?? tableauToDomoType(field.datatype);
				// Only t2d uploads normalize boolean text to 'true'/'false' (formatBoolean in schema.js).
				return { kind: 'column', column, datatype: field.datatype, domoType, ...(dataset.strategy === 'upload' ? {} : { rawBoolean: true }), ...(textIgnoresCase(field, ds) ? { ignoreCase: true } : {}) };
			}
			if (CALC_KINDS.has(field.kind)) {
				const formula = referenceFormula(field);
				return {
					kind: 'calc',
					field: { ...field, formula },
					legacyId: legacyOf(field),
					name: nameOf(field.id)
				};
			}
			return undefined;
		};

		const tableCalcPills = new Map();
		const plainPills = new Map();
		const shown = new Map();
		for (const ws of ir.worksheets ?? []) {
			const onShelves = shownPillIds(ws);
			const filtered = new Set((ws.filters ?? []).map((f) => f.pillId));
			for (const [pillId, pill] of Object.entries(ws.pills ?? {})) {
				if (pill.datasourceId !== ds.id) continue;
				const field = lookupField(pill.fieldId);
				if (!field) continue;
				const use = { ws, pillId, pill };
				shown.set(use, onShelves.has(pillId) || filtered.has(pillId));
				const into = pill.tableCalc ? tableCalcPills : plainPills;
				if (!into.has(field.id)) into.set(field.id, []);
				into.get(field.id).push(use);
			}
		}
		const referrers = new Map();
		const references = new Map();
		for (const f of calcFields) {
			let refs;
			try {
				refs = f.formula ? analyzeFormula(parseFormula(f.formula)).refs : [];
			} catch {
				continue;
			}
			for (const id of refs) {
				const ref = lookupField(id);
				if (!ref || ref.id === f.id) continue;
				if (!referrers.has(ref.id)) referrers.set(ref.id, []);
				referrers.get(ref.id).push(f);
				if (!references.has(f.id)) references.set(f.id, []);
				references.get(f.id).push(ref.id);
			}
		}
		/** Fields a worksheet, filter or dashboard zone of this datasource reaches, through calc references. */
		const usedFields = new Set();
		{
			const queue = [
				...(ds.filters ?? []).map((f) => f.fieldId),
				...(ir.worksheets ?? []).flatMap((w) => [
					...Object.values(w.pills ?? {}).filter((p) => p.datasourceId === ds.id).map((p) => p.fieldId),
					...(w.filters ?? []).filter((f) => f.datasourceId === ds.id).map((f) => f.fieldId)
				]),
				...(ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])]).filter((z) => z.param?.startsWith(`[${ds.id}].`)).map((z) => parsePillId(z.param).fieldId)
			];
			while (queue.length) {
				const field = lookupField(queue.shift());
				if (!field || usedFields.has(field.id)) continue;
				usedFields.add(field.id);
				queue.push(...(references.get(field.id) ?? []), ...[field.group?.source, field.bin?.source, field.set?.source].filter(Boolean));
			}
		}
		const windowItem = (pillId, pill) => {
			const f = pill && lookupField(pill.fieldId);
			if (!f) return undefined;
			if (f.kind === 'column') return fieldMap[f.id] ? pillWindowItem(pill, { kind: 'column', column: fieldMap[f.id] }) : undefined;
			if (!CALC_KINDS.has(f.kind)) return undefined;
			const c = compute(f);
			return c.status === 'unsupported' ? undefined : pillWindowItem(pill, { kind: 'formula', expression: c.expression, aggregated: c.aggregated });
		};
		/** Whether a calc, or a calc it references, calls a table calculation. */
		const reachesTableCalc = (field, seen = new Set()) => {
			if (!field.formula || seen.has(field.id)) return false;
			seen.add(field.id);
			let facts;
			try {
				facts = analyzeFormula(parseFormula(field.formula));
			} catch {
				return false;
			}
			return (
				facts.tableCalcs.length > 0 ||
				facts.refs.some((id) => {
					const ref = lookupField(id);
					return Boolean(ref) && CALC_KINDS.has(ref.kind) && reachesTableCalc(ref, seen);
				})
			);
		};
		const calcFirst = (a, b) => (a.pill.tableCalc?.type === 'Calculation' ? 0 : 1) - (b.pill.tableCalc?.type === 'Calculation' ? 0 : 1);
		const directUses = (field) => {
			const own = [...(tableCalcPills.get(field.id) ?? [])].sort(calcFirst);
			return own.length ? own : (plainPills.get(field.id) ?? []).filter((u) => shown.get(u));
		};
		/**
		 * Pills whose addressing applies to `field`: its own (a pill without a table-calc setting uses Tableau's default),
		 * else those of the nearest calc that references it, with the pill's nested compute-using for `field`.
		 */
		const addressingUses = (field) => {
			const own = directUses(field);
			if (own.length) return own;
			const seen = new Set([field.id]);
			const queue = [...(referrers.get(field.id) ?? [])];
			while (queue.length) {
				const outer = queue.shift();
				if (seen.has(outer.id)) continue;
				seen.add(outer.id);
				const uses = directUses(outer);
				if (!uses.length) {
					queue.push(...(referrers.get(outer.id) ?? []));
					continue;
				}
				return uses.map(({ ws, pillId, pill }) => {
					const setting = pill.tableCalc?.nested?.[field.id] ?? pill.tableCalc;
					const p = { ...pill, ...(setting ? { tableCalc: setting } : {}) };
					const use = { ws: { ...ws, pills: { ...ws.pills, [pillId]: p } }, pillId, pill: p };
					shown.set(use, true);
					return use;
				});
			}
			return [];
		};
		const addressingCache = new Map();
		/** Window partition and order of a table calc beast mode, from the worksheets that show it. */
		const tableCalcOf = (field) => {
			if (addressingCache.has(field.id)) return addressingCache.get(field.id);
			let result;
			const reaches = reachesTableCalc(field);
			const uses = reaches ? addressingUses(field) : [];
			if (reaches && !uses.length) {
				result = {
					partitionBy: [],
					orderBy: [],
					dimensions: [],
					unused: true,
					issues: [{ severity: 'info', code: 'calc.table-calc-unused', message: `'${field.name}' is not used on any worksheet, so it has no table-calc addressing; translated over the whole table` }]
				};
			} else if (uses.length) {
				addressingCache.set(field.id, undefined);
				const all = uses.map((u) => ({ ...u, addressing: tableCalcAddressing(u.ws, u.pillId, windowItem) }));
				const [first] = all;
				const shape = (a) => JSON.stringify([a.partitionBy, a.orderBy]);
				const others = [...new Set(all.filter((a, i) => shown.get(uses[i]) && shape(a.addressing) !== shape(first.addressing)).map((a) => a.ws.name))];
				result = {
					...first.addressing,
					issues: [
						...first.addressing.issues,
						...(others.length
							? [{ severity: 'warning', code: 'calc.table-calc-addressing', message: `Worksheets ${others.join(', ')} compute it differently from '${first.ws.name}'; a Beast Mode has one definition, so '${first.ws.name}' is used` }]
							: [])
					]
				};
			}
			addressingCache.set(field.id, result);
			return result;
		};

		const lodColumn = lodColumns?.get(ds.id);
		const tableCalcColumn = tableCalcColumns?.get(ds.id);
		const ctx = (field) => ({
			resolveField,
			options,
			...(lodColumn ? { lodColumn } : {}),
			...(tableCalcColumn ? { tableCalcColumn: (node) => tableCalcColumn(field.id, node) } : {}),
			...(tableCalcOf(field) ? { tableCalc: tableCalcOf(field) } : {}),
			contextFilterColumns,
			datasourceId: ds.id,
			field,
			role: field.role,
			...(useVariables ? { parameterReference } : {})
		});

		const viaTranslator = (field, formula) => {
			try {
				return { reason: undefined, ...translate(formula, ctx(field)) };
			} catch (err) {
				return unsupported(field, `translation failed: ${err.message}`, 'calc.translate-failed');
			}
		};

		/** Source column of a group/bin/set, or undefined when it is not a plain column. */
		const sourceColumn = (sourceId) => {
			const res = resolveField(sourceId);
			return res?.kind === 'column' ? res : undefined;
		};

		/** @returns {Computed} */
		const compute = (field) => {
			if (computed.has(field.id)) return computed.get(field.id);
			if (inProgress.has(field.id)) return unsupported(field, 'circular reference', 'calc.cycle');
			inProgress.add(field.id);
			let result;
			try {
				result = computeUncached(field);
			} finally {
				inProgress.delete(field.id);
			}
			computed.set(field.id, result);
			return result;
		};

		const ok = (expression, aggregated, dataType, extraIssues = [], status = 'ok') => ({
			expression,
			aggregated,
			dataType,
			status,
			features: [],
			issues: extraIssues
		});

		/** In for the members a Magic ETL rank column (materialize.js) puts at most N; N stays a variable when it is a parameter. */
		const topSet = (field, set) => {
			if (!set.top.rankColumn) {
				return unsupported(field, 'a top N set is ranked by a Magic ETL dataflow, which this datasource does not get (materialize is off, the data is federated, or the ranking could not be computed in Magic ETL)', 'calc.set-top');
			}
			const count = typeof set.top.count === 'number' ? { expression: String(set.top.count), features: [], issues: [], status: 'ok' } : viaTranslator(field, String(set.top.count ?? ''));
			if (count.status === 'unsupported' || count.aggregated) return unsupported(field, `the set's count ${set.top.count} could not be translated`, 'calc.set-top');
			let rank = bmColumn(set.top.rankColumn);
			const switched = set.top.rankColumns;
			const picker = switched ? viaTranslator(field, switched.parameter) : undefined;
			if (picker && picker.status !== 'unsupported') {
				const type = typeof switched.ranks[0].value === 'number' ? 'real' : 'string';
				rank = `CASE ${picker.expression} ${switched.ranks.map((r) => `WHEN ${sqlLiteral(r.value, type)} THEN ${bmColumn(r.column)}`).join(' ')} ELSE ${rank} END`;
			}
			const expression = `CASE WHEN ${rank} <= ${count.expression} THEN 'In' ELSE 'Out' END`;
			return { ...ok(expression, false, 'STRING', [...(count.issues ?? []), ...(picker?.issues ?? [])], count.status === 'approximate' ? 'approximate' : 'ok'), features: [...(count.features ?? []), ...(picker?.features ?? [])] };
		};

		const computeUncached = (field) => {
			switch (field.kind) {
				case 'calculated':
					if (!field.formula) return unsupported(field, 'the calculation has no formula', 'calc.missing-formula', tableauToDomoType(field.datatype));
					return viaTranslator(field, field.formula);
				case 'count': {
					const extra = [];
					let status = 'ok';
					if (multiTable) {
						status = 'approximate';
						extra.push(
							issueFor(
								field,
								'warning',
								'calc.count-joined',
								`'${field.name}' counts rows of the joined dataset, which can differ from Tableau's per-table count.`,
								'Use COUNT(DISTINCT `<table key>`) if the table is on the many side of a join.'
							)
						);
					}
					return ok('COUNT(1)', true, 'LONG', extra, status);
				}
				case 'bin': {
					if (!field.bin?.source) return unsupported(field, 'the bin has no source field');
					const size = binSize(field);
					if (size === null) return unsupported(field, `bin size '${field.bin.size}' could not be resolved to a number`);
					const src = sourceColumn(field.bin.source);
					if (!src) return viaTranslator(field, referenceFormula(field));
					const extra = [];
					if (typeof field.bin.size === 'string' && field.bin.size.trim().startsWith('[')) {
						extra.push(issueFor(field, 'info', 'calc.parameter-inlined', `Bin size parameter of '${field.name}' inlined as ${size}.`));
					}
					const peg = Number(field.bin.peg) || 0;
					const col = bmColumn(src.column);
					const expression = peg ? `FLOOR((${col} - ${peg}) / ${size}) * ${size} + ${peg}` : `FLOOR(${col} / ${size}) * ${size}`;
					const integral = Number.isInteger(size) && Number.isInteger(peg) && src.datatype === 'integer';
					return ok(expression, false, integral ? 'LONG' : 'DOUBLE', extra);
				}
				case 'group': {
					if (!field.group?.source) return unsupported(field, 'the group has no source field');
					const src = sourceColumn(field.group.source);
					if (!src) return viaTranslator(field, referenceFormula(field));
					const col = bmColumn(src.column);
					const whens = (field.group.bins ?? [])
						.map((b) => {
							const cond = inList(col, b.values ?? [], src.datatype, sqlLiteral);
							return cond ? `WHEN ${cond} THEN ${sqlLiteral(String(b.label), 'string')}` : null;
						})
						.filter(Boolean);
					const other = field.group.otherLabel !== undefined ? sqlLiteral(String(field.group.otherLabel), 'string') : col;
					const expression = whens.length ? `CASE ${whens.join(' ')} ELSE ${other} END` : other;
					return ok(expression, false, 'STRING');
				}
				case 'set': {
					const set = field.set;
					if (set?.unparsed) return unsupported(field, `the set combines other sets (groupfilter ${set.unparsed.join(', ')}), which is not translated`, 'calc.set-combined');
					if (!set?.source) return unsupported(field, 'the set has no source field');
					if (set.top) return topSet(field, set);
					if (set.condition) return unsupported(field, 'condition sets are not translated', 'calc.set-condition');
					const src = sourceColumn(set.source);
					const [inLabel, outLabel] = set.exclude ? ["'Out'", "'In'"] : ["'In'", "'Out'"];
					if (!src) {
						const translated = viaTranslator(field, `IF ${referenceFormula(field)} THEN "In" ELSE "Out" END`);
						return translated;
					}
					if (set.ranges?.length) return viaTranslator(field, `IF ${referenceFormula(field)} THEN "In" ELSE "Out" END`);
					const cond = inList(bmColumn(src.column), set.members ?? [], src.datatype, sqlLiteral);
					const expression = cond ? `CASE WHEN ${cond} THEN ${inLabel} ELSE ${outLabel} END` : allMembers(set) ? inLabel : outLabel;
					const extra = [
						issueFor(field, 'info', 'calc.set-static', `Set '${field.name}' was converted with its saved members; set actions do not update it in Domo.`)
					];
					return ok(expression, false, 'STRING', extra);
				}
				default:
					return unsupported(field, `field kind '${field.kind}' is not supported`);
			}
		};

		if (sharedDataset) {
			resolveSharedIdentities({ dataset, calcFields, compute, bmNames, takenNames, identities, shared, workbookName: ir.workbook?.name, issues });
			computed.clear();
		}

		const usedKeys = new Set(beastModes.map((b) => b.key));
		for (const field of calcFields) {
			const result = compute(field);
			const legacyId = legacyOf(field);
			const identity = identities.get(field.id);
			const fieldSlug = `${slugify(stripBrackets(field.id))}${identity?.keySuffix ? `.${identity.keySuffix}` : ''}`;
			let key = identity?.key ?? `${dataset.key}.${fieldSlug}`;
			for (let n = 2; usedKeys.has(key); n++) key = `${dataset.key}.${fieldSlug}-${n}`;
			usedKeys.add(key);
			const name = nameOf(field.id);
			// A calc that only renames a column binds to the column, shown under the calc's name.
			const renamed = result.status === 'ok' && !result.aggregated && !result.lodExpression && /^`[^`]+`$/.test(result.expression ?? '') ? result.expression.slice(1, -1) : undefined;
			if (!renamed) beastModes.push({
				key,
				datasetKey: dataset.key,
				name,
				legacyId,
				...(identity?.hash ? { sharedHash: identity.hash } : {}),
				...(identity?.renamed ? { sharedRenamed: true } : {}),
				...(dataset.previousKey && !identity?.key && !identity?.keySuffix ? { previousKey: `${dataset.previousKey}.${slugify(stripBrackets(field.id))}` } : {}),
				expression: result.expression,
				aggregated: Boolean(result.aggregated),
				dataType: result.dataType,
				tableauFieldId: field.id,
				tableauFormula: field.formula ?? referenceFormula(field) ?? '',
				status: result.status,
				features: result.features ?? []
			});
			const unusedTableCalc = Boolean(tableCalcOf(field)?.unused);
			const unused = !usedFields.has(field.id);
			const fieldIssues = (result.issues ?? []).map((i) => {
				if (i.code === 'calc.lod-outer-aggregation' && result.lodExpression && result.status !== 'unsupported') {
					return {
						...i,
						severity: 'info',
						message: `'${field.name}' is a bare LOD used as a measure; its dataset Beast Mode sums it, and cards whose pill uses another aggregation get a card formula with that aggregation`
					};
				}
				// No card uses it, so its missing window order costs no card; the Beast Mode is still left out.
				if (unusedTableCalc && i.code === 'calc.table-calc-order') {
					const created = i.severity === 'error' ? ', so its Beast Mode is not created' : '';
					return { ...i, severity: 'warning', message: `${i.message}; no worksheet uses '${field.name}'${created}` };
				}
				// A broken reference in a calc nothing uses (often copied from another datasource) costs no card.
				if (unused && i.severity === 'error' && i.code === 'calc.unknown-field') {
					return { ...i, severity: 'warning', message: `${i.message}; no worksheet uses '${field.name}', so its Beast Mode is not created` };
				}
				return i;
			});
			issues.push(...fieldIssues);
			if (contextDiffers && /\{\s*FIXED\b/i.test(field.formula ?? '')) {
				issues.push(
					issueFor(
						field,
						'warning',
						'calc.context-filter-scope',
						`'${field.name}' is a FIXED LOD and context filters differ between worksheets; the Beast Mode allows ${contextFilterColumns.join(', ') || 'no'} filters inside FIXED for every card on the dataset`,
						'Check cards whose worksheet had a different set of context filters.'
					)
				);
			}
			if (result.status === 'unsupported' && !fieldIssues.some((i) => i.severity === 'error' || (unusedTableCalc && i.code === 'calc.table-calc-order') || (unused && i.code === 'calc.unknown-field'))) {
				issues.push(issueFor(field, 'error', 'calc.unsupported', `'${field.name}' could not be translated to a Beast Mode.`));
			}
			if (renamed) {
				bindings.set(field.id, {
					datasetKey: dataset.key,
					kind: 'column',
					name: field.name,
					column: renamed,
					alias: field.name,
					aggregated: false,
					dataType: schemaTypes.get(renamed) ?? result.dataType,
					tableauType: field.datatype,
					...fiscalOf(field),
					...(textCaseSensitive(field, ds) ? { caseSensitive: true } : {})
				});
				continue;
			}
			bindings.set(
				field.id,
				result.status === 'unsupported'
					? {
							datasetKey: dataset.key,
							kind: 'unsupported',
							name: field.name,
							aggregated: Boolean(result.aggregated),
							dataType: result.dataType,
							tableauType: field.datatype,
							reason: result.reason ?? fieldIssues.find((i) => i.severity === 'error')?.message ?? 'Calculation could not be translated'
						}
					: {
							datasetKey: dataset.key,
							kind: 'formula',
							name: field.name,
							...(name !== field.name ? { formulaName: name } : {}),
							formulaId: legacyId,
							expression: result.expression,
							...(result.lodExpression ? { lodExpression: result.lodExpression } : {}),
							...(field.kind === 'set' ? { setMembers: true, ...savedSet(field.set) } : {}),
							aggregated: Boolean(result.aggregated),
							dataType: result.dataType,
							tableauType: field.datatype,
							...fiscalOf(field),
							...(textCaseSensitive(field, ds) ? { caseSensitive: true } : {})
						}
			);
		}

		for (const field of fields) {
			if (field.kind !== 'column') continue;
			const column = fieldMap[field.id];
			bindings.set(
				field.id,
				column
					? {
							datasetKey: dataset.key,
							kind: 'column',
							name: field.name,
							column,
							aggregated: false,
							dataType: schemaTypes.get(column) ?? tableauToDomoType(field.datatype),
							tableauType: field.datatype,
							...fiscalOf(field),
							...(textCaseSensitive(field, ds) ? { caseSensitive: true } : {})
						}
					: {
							datasetKey: dataset.key,
							kind: 'unsupported',
							name: field.name,
							aggregated: false,
							tableauType: field.datatype,
							reason: `Column for '${field.name}' was not found in the Domo dataset`
						}
			);
		}
	}

	const get = (datasourceId, fieldId) => {
		const bindings = bindingsByDs.get(datasourceId);
		if (!bindings) return undefined;
		if (bindings.has(fieldId)) return bindings.get(fieldId);
		const parts = relationParts(fieldId);
		if (parts.length === 2) {
			const inner = bracket(parts[1]);
			if (bindings.has(inner)) return bindings.get(inner);
		}
		const byName = nameIndexByDs.get(datasourceId)?.get(stripBrackets(fieldId).toLowerCase());
		return byName ? bindings.get(byName) : undefined;
	};

	return {
		beastModes,
		variables,
		bindings: {
			get,
			datasetKeyFor: (datasourceId) => datasetByDs.get(datasourceId),
			all: () => bindingsByDs
		},
		issues
	};
}

/**
 * @typedef {Object} SharedBeastModeVariant
 * @property {string} fieldId
 * @property {string} name
 * @property {string} key
 * @property {string} legacyId
 * @property {string} hash        Fingerprint of the translated definition
 * @property {boolean} [renamed]  Got a workbook-specific name because another workbook defines the name differently
 * @property {string[]} workbooks Workspace slugs whose plans use this variant
 *
 * @typedef {Object} SharedBeastModeContext
 * @property {string} [workbook]  Workspace slug of the workbook being converted (its own variants are ignored)
 * @property {Record<string, SharedBeastModeVariant[]>} [registry]  Variants per shared dataset key
 */

/** Fingerprint of a translated calculation, compared across workbooks sharing a dataset. */
export function beastModeDefinitionHash(result) {
	return shortHash({ expression: result.expression ?? null, dataType: result.dataType ?? null, aggregated: Boolean(result.aggregated), status: result.status ?? null });
}

function resolveSharedIdentities({ dataset, calcFields, compute, bmNames, takenNames, identities, shared, workbookName, issues }) {
	const self = shared?.workbook;
	const variants = (shared?.registry?.[dataset.key] ?? []).filter((v) => (v.workbooks ?? []).some((w) => w !== self));
	const lower = (v) => String(v ?? '').toLowerCase();
	const variantNames = new Set(variants.map((v) => lower(v.name)));
	for (const field of calcFields) {
		const hash = beastModeDefinitionHash(compute(field));
		const baseName = bmNames.get(field.id);
		const same = variants.find((v) => v.hash === hash && (v.fieldId === field.id || lower(v.name) === lower(baseName)));
		if (same) {
			identities.set(field.id, { hash, legacyId: same.legacyId, name: same.name, key: same.key, ...(same.renamed ? { renamed: true } : {}) });
			continue;
		}
		const clash = variants.filter((v) => !v.renamed && (v.fieldId === field.id || lower(v.name) === lower(baseName)));
		if (!clash.length) {
			identities.set(field.id, { hash });
			continue;
		}
		const suffix = workbookName || self || 'workbook';
		let name = `${baseName} (${suffix})`;
		for (let n = 2; takenNames.has(lower(name)) || variantNames.has(lower(name)); n++) name = `${baseName} (${suffix} ${n})`;
		takenNames.add(lower(name));
		identities.set(field.id, { hash, name, legacyId: beastModeLegacyId('site', dataset.key, field.id, hash), keySuffix: hash.slice(0, 6), renamed: true });
		const others = [...new Set(clash.flatMap((v) => v.workbooks ?? []))].filter((w) => w !== self);
		issues.push(
			issueFor(
				field,
				'warning',
				'calc.shared-conflict',
				`'${baseName}' on shared dataset '${dataset.name}' is defined differently by ${others.join(', ') || 'another workbook'}; this workbook's version is a separate Beast Mode named '${name}'.`,
				'Align the calculation across workbooks (or rename it in Tableau) to share one Beast Mode.'
			)
		);
	}
}

/**
 * Registry of beast mode variants on one shared dataset after a workbook's conversion: the workbook is removed
 * from every variant, then added to the variants its plan uses. Pure; variants no workbook uses are dropped.
 * @param {SharedBeastModeVariant[]} variants
 * @param {string} workbook  Workspace slug
 * @param {import('../model/types.js').BeastModePlan[]} beastModes  The workbook's beast modes on that dataset
 * @returns {SharedBeastModeVariant[]}
 */
export function updateSharedRegistry(variants, workbook, beastModes) {
	const next = (variants ?? []).map((v) => ({ ...v, workbooks: (v.workbooks ?? []).filter((w) => w !== workbook) }));
	for (const bm of beastModes ?? []) {
		if (!bm.sharedHash) continue;
		let variant = next.find((v) => v.key === bm.key && v.hash === bm.sharedHash);
		if (!variant) {
			variant = { fieldId: bm.tableauFieldId, name: bm.name, key: bm.key, legacyId: bm.legacyId, hash: bm.sharedHash, ...(bm.sharedRenamed ? { renamed: true } : {}), workbooks: [] };
			next.push(variant);
		}
		if (!variant.workbooks.includes(workbook)) variant.workbooks.push(workbook);
	}
	return next.filter((v) => v.workbooks.length);
}
