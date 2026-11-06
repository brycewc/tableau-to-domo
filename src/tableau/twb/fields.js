import { stripBrackets } from '../../model/naming.js';
import { parseGroupfilter } from './filters.js';
import { parsePillId } from './shelf.js';
import { formattedText, normalizeFormula, parseLiteral } from './xml.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').FieldIR} FieldIR
 * @typedef {import('../../model/types.js').ParameterIR} ParameterIR
 * @typedef {import('../../model/types.js').TableauDataType} TableauDataType
 *
 * @typedef {Object} MetadataRecord
 * @property {string} remoteName
 * @property {string} localName
 * @property {string} [tableId]
 * @property {TableauDataType} localType
 * @property {string} [remoteType]
 * @property {number} [ordinal]
 * @property {string} [aggregation]
 * @property {string} [collation]               `<collation name>`: 'binary', an ICU name such as 'LEN_RUS_S2' or 'LROOT'
 */

const DATATYPES = new Set(['string', 'integer', 'real', 'date', 'datetime', 'boolean', 'spatial', 'table']);
const AGGREGATIONS = new Set(['Sum', 'Avg', 'Count', 'CountD', 'Min', 'Max', 'Median', 'Attr', 'Attribute', 'Stdev', 'StdevP', 'Var', 'VarP']);
const COUNT_PREFIX = '[__tableau_internal_object_id__].';
const ADHOC_GROUP = /^\[(?:Action|Exclusions|Inclusions|Tooltip) \(/;
const GENERATED_GEO = new Set(['latitude', 'longitude']);

/** @returns {TableauDataType} */
export function normalizeDatatype(value) {
	const v = String(value ?? '').toLowerCase();
	return DATATYPES.has(v) ? /** @type {TableauDataType} */ (v) : 'unknown';
}

function defaultRole(datatype) {
	return datatype === 'integer' || datatype === 'real' ? 'measure' : 'dimension';
}

function defaultType(role, datatype) {
	if (role === 'measure') return 'quantitative';
	return datatype === 'date' || datatype === 'datetime' ? 'ordinal' : 'nominal';
}

function parseAliases(node) {
	const aliases = node.child('aliases');
	if (!aliases) return undefined;
	const out = {};
	for (const a of aliases.all('alias')) {
		const key = parseLiteral(a.attr('key'));
		if (a.attr('value') !== undefined) out[key === null ? '%null%' : String(key)] = a.attr('value');
	}
	return Object.keys(out).length ? out : undefined;
}

function describe(node) {
	const desc = node.child('desc');
	return desc ? formattedText(desc) || desc.textContent().trim() || undefined : undefined;
}

/**
 * Build a FieldIR for a metadata record (a physical column with no <column> declaration).
 * @param {MetadataRecord} rec
 * @returns {FieldIR}
 */
export function fieldFromRecord(rec) {
	const role = defaultRole(rec.localType);
	/** @type {FieldIR} */
	const field = {
		id: rec.localName,
		name: stripBrackets(rec.localName),
		datatype: rec.localType,
		role,
		type: defaultType(role, rec.localType),
		kind: 'column',
		physical: { ...(rec.tableId ? { tableId: rec.tableId } : {}), remoteName: rec.remoteName }
	};
	if (rec.aggregation && AGGREGATIONS.has(rec.aggregation) && role === 'measure') field.defaultAggregation = rec.aggregation;
	if (rec.collation) field.collation = rec.collation;
	return field;
}

/**
 * Apply a <column> declaration on top of an existing field (or create one).
 * Returns null for internal fields that should not be exposed.
 *
 * @param {XmlNode} col
 * @param {FieldIR|undefined} existing
 * @param {{ colsMap?: Map<string,{ tableId?: string, remoteName: string }> }} [ctx]
 * @returns {FieldIR|null}
 */
export function fieldFromColumn(col, existing, ctx = {}) {
	const id = col.attr('name');
	if (!id) return null;
	const autoColumn = col.attr('user:auto-column');
	if (GENERATED_GEO.has(autoColumn) || id === '[Multiple Values]' || id === '[:Measure Values]') return null;
	if (id.startsWith('[__tableau_') && !id.startsWith(COUNT_PREFIX)) return null;
	const aliases = parseAliases(col);
	if (id === '[:Measure Names]') {
		if (!aliases) return null;
		return { id, name: 'Measure Names', datatype: 'string', role: 'dimension', type: 'nominal', kind: 'measure-names', hidden: true, aliases };
	}

	const datatype = col.attr('datatype') ? normalizeDatatype(col.attr('datatype')) : existing?.datatype || 'unknown';
	const role = col.attr('role') || existing?.role || defaultRole(datatype);
	/** @type {FieldIR} */
	const field = existing ? { ...existing } : { id, name: stripBrackets(id), datatype, role, kind: 'column' };
	field.datatype = datatype;
	field.role = role === 'measure' ? 'measure' : 'dimension';
	const type = col.attr('type') || existing?.type || defaultType(field.role, datatype);
	if (type) field.type = /** @type {any} */ (type);
	const caption = col.attr('caption');
	if (caption) field.caption = caption;
	field.name = col.attr('alias') || caption || existing?.name || stripBrackets(id);
	if (col.attr('hidden') === 'true') field.hidden = true;
	if (col.attr('semantic-role')) field.semanticRole = col.attr('semantic-role');
	if (col.attr('default-format')) field.defaultFormat = col.attr('default-format');
	if (col.attr('aggregation') && AGGREGATIONS.has(col.attr('aggregation'))) field.defaultAggregation = col.attr('aggregation');
	const description = describe(col);
	if (description) field.description = description;
	if (aliases) field.aliases = { ...(existing?.aliases || {}), ...aliases };

	if (id.startsWith(COUNT_PREFIX)) {
		const label = caption || stripBrackets(id.slice(COUNT_PREFIX.length));
		field.kind = 'count';
		field.name = /\(count\)$/i.test(label) ? label : `${label} (Count)`;
		field.role = 'measure';
		field.type = 'quantitative';
		delete field.physical;
		return field;
	}

	const calc = col.child('calculation');
	if (calc) {
		const cls = calc.attr('class') || 'tableau';
		if (cls === 'bin') {
			const source = calc.attr('formula') || '';
			const rawSize = calc.attr('size') ?? calc.attr('size-parameter');
			const size = rawSize !== undefined && /^-?\d+(\.\d+)?$/.test(rawSize.trim()) ? Number(rawSize) : rawSize ?? '';
			field.kind = 'bin';
			field.bin = { source: normalizeFormula(source), size };
			if (calc.attr('peg') !== undefined && calc.attr('peg') !== '') field.bin.peg = Number(calc.attr('peg'));
			delete field.physical;
		} else if (cls === 'categorical-bin') {
			field.kind = 'group';
			field.group = {
				source: calc.attr('column') || '',
				bins: calc.all('bin').map((bin) => ({
					label: String(parseLiteral(bin.attr('value')) ?? ''),
					values: bin.all('value').map((v) => parseLiteral(v.textContent()))
				}))
			};
			const other = calc.attr('default');
			if (other !== undefined) field.group.otherLabel = String(parseLiteral(other) ?? '');
			delete field.physical;
		} else {
			const formula = normalizeFormula(calc.attr('formula') ?? calc.textContent().trim());
			if (autoColumn === 'numrec' || (id === '[Number of Records]' && String(formula).trim() === '1')) {
				field.kind = 'count';
			} else {
				field.kind = 'calculated';
				field.formula = formula ?? '';
			}
			delete field.physical;
		}
	} else if (autoColumn === 'numrec') {
		field.kind = 'count';
		delete field.physical;
	} else if (field.kind === 'column') {
		field.physical ||= ctx.colsMap?.get(id) || { remoteName: stripBrackets(id) };
	}
	return field;
}

/**
 * Resolve a groupfilter level ('[none:Region:nk]' or '[Region]') to a field id.
 * @param {string|undefined} level
 * @param {Map<string,string>} instances column-instance name -> column
 */
export function resolveLevel(level, instances) {
	if (!level) return '';
	if (instances.has(level)) return instances.get(level);
	return parsePillId(level).fieldId;
}

/**
 * Build a set (or combined field) from a datasource-level <group>.
 * Returns null for ad hoc selection groups ('Action (...)', 'Exclusions (...)').
 *
 * @param {XmlNode} group
 * @param {Map<string,string>} instances
 * @param {string[]} unknown
 * @returns {FieldIR|null}
 */
export function fieldFromGroup(group, instances, unknown = []) {
	const id = group.attr('name');
	if (!id || ADHOC_GROUP.test(id) || group.attr('user:auto-column') === 'sheet_link') return null;
	const name = group.attr('caption') || stripBrackets(id);
	const top = group.child('groupfilter');
	if (top?.attr('function') === 'crossjoin') {
		const levels = top.all('groupfilter').map((g) => resolveLevel(g.attr('level'), instances)).filter(Boolean);
		return {
			id,
			name,
			...(group.attr('caption') ? { caption: group.attr('caption') } : {}),
			datatype: 'string',
			role: 'dimension',
			type: 'nominal',
			kind: 'calculated',
			formula: levels.map((l) => `STR(${l})`).join(' + ", " + '),
			description: 'Combined field'
		};
	}
	const unparsed = [];
	const facets = top ? parseGroupfilter(top, unparsed) : [];
	unknown.push(...unparsed);
	const level = facets.find((f) => f.level)?.level || top?.attr('level');
	/** @type {FieldIR['set']} */
	const set = { source: resolveLevel(level, instances) };
	for (const facet of facets) {
		if (facet.include) set.members = [...(set.members || []), ...facet.include];
		if (facet.exclude) {
			set.members = [...(set.members || []), ...facet.exclude];
			set.exclude = true;
		}
		if (facet.ranges) set.ranges = [...(set.ranges || []), ...facet.ranges];
		if (facet.kind === 'condition' || facet.kind === 'wildcard') set.condition = facet.expression;
		if (facet.top) set.top = { count: /** @type {number} */ (facet.top.count), direction: facet.top.direction, by: facet.top.by };
	}
	// "Use all" (level-members, user:ui-enumeration='all'): every member is in the set.
	if (facets.length && facets.every((f) => f.all)) set.all = true;
	if (unparsed.length) set.unparsed = [...new Set(unparsed)];
	/** @type {FieldIR} */
	const field = { id, name, datatype: 'boolean', role: 'dimension', type: 'nominal', kind: 'set', set };
	if (group.attr('caption')) field.caption = group.attr('caption');
	if (group.attr('hidden') === 'true') field.hidden = true;
	return field;
}

function parseParamValue(raw, datatype) {
	if (raw === undefined) return undefined;
	const value = parseLiteral(raw);
	if (datatype === 'string' && value !== null && typeof value !== 'string') return String(raw).trim();
	if ((datatype === 'integer' || datatype === 'real') && typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) return Number(value);
	return value;
}

/**
 * Parameters from the special 'Parameters' datasource.
 * @param {XmlNode} node
 * @returns {ParameterIR[]}
 */
export function parseParameters(node) {
	const params = [];
	for (const col of node.all('column')) {
		const name = col.attr('name');
		if (!name) continue;
		const id = name.startsWith('[Parameters].') ? name : `[Parameters].${name}`;
		const datatype = normalizeDatatype(col.attr('datatype'));
		const domainRaw = col.attr('param-domain-type') || 'all';
		const domain = domainRaw === 'list' || domainRaw === 'range' ? domainRaw : 'all';
		const calc = col.child('calculation');
		const raw = col.attr('value') ?? calc?.attr('formula');
		/** @type {ParameterIR} */
		const param = {
			id,
			name: col.attr('caption') || stripBrackets(name.replace(/^\[Parameters\]\./, '')),
			datatype,
			domain,
			value: parseParamValue(raw, datatype) ?? null
		};
		const aliases = parseAliases(col) || {};
		const members = col.child('members')?.all('member') || [];
		if (members.length) {
			param.members = members.map((m) => {
				const value = parseParamValue(m.attr('value'), datatype);
				const alias = m.attr('alias') ?? aliases[value === null ? '%null%' : String(value)];
				return alias !== undefined ? { value, alias } : { value };
			});
		}
		const range = col.child('range');
		if (range) {
			param.range = {};
			if (range.attr('min') !== undefined) param.range.min = parseParamValue(range.attr('min'), datatype);
			if (range.attr('max') !== undefined) param.range.max = parseParamValue(range.attr('max'), datatype);
			const granularity = range.attr('granularity');
			if (granularity !== undefined) {
				const step = Number(granularity);
				const period = range.attr('period-type-v2') ?? range.attr('period-type');
				param.range.step = period ? `${granularity} ${period}` : Number.isNaN(step) ? granularity : step;
			}
		}
		params.push(param);
	}
	return params;
}
