import { analyzeFormula, parseFormula } from './calc/index.js';
import { parameterLookup, planBeastModes } from './beastmodes.js';
import { beastModeLegacyId, shortHash, slugify } from '../util/ids.js';

/**
 * Domo variables for Tableau parameters (`parameters: 'variables'`): which parameters become variables, how beast
 * modes reference them, their default value expression, and the variable controls placed on pages. Pure, no I/O.
 *
 * @typedef {import('../model/types.js').VariablePlan} VariablePlan
 * @typedef {import('../model/types.js').ParameterIR} ParameterIR
 *
 * @typedef {'DROPDOWN'|'RADIOS'|'PILLS'|'SLIDER'|'INPUT'|'SLIDER_INPUT'|'CALENDAR_DROPDOWN'|'TOGGLE'} VariableControlType
 *
 * @typedef {Object} VariableControlSpec   A variable control without `function` and `id`
 * @property {'VARIABLE'} controlType
 * @property {string} name
 * @property {VariableControlType} type
 * @property {{ expression: { exprType: 'STRING_VALUE'|'NUMERIC_VALUE', value: string } }[]} [values]
 * @property {string} [min]
 * @property {string} [max]
 * @property {string} [stepSize]
 * @property {{ type: 'default' }} format
 */

const NUMERIC = new Set(['integer', 'real']);
const DATES = new Set(['date', 'datetime']);
const MAX_FALLBACK_ROUNDS = 5;
const REFERENCE = /DOMO_BEAST_MODE\((calculation_[0-9a-f-]{36})\)/g;

/**
 * Beast Mode reference to a variable. Domo rejects a backticked variable name (validateFunctions ILLEGAL_REFERENCE);
 * only `DOMO_BEAST_MODE(<template id>)` resolves, so plans carry the legacyId and push swaps in the id.
 * @param {{ legacyId: string }} variable
 */
export function variableReference(variable) {
	return `DOMO_BEAST_MODE(${variable.legacyId})`;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace variable references in beast mode SQL (or a JSON text holding it) with `DOMO_BEAST_MODE(<id>)`:
 * `variableReference` placeholders, and backticked variable names that are not a column of the dataset.
 * @param {string} text
 * @param {VariablePlan[]} variables
 * @param {(variable: VariablePlan) => string|number|undefined} idOf  Domo template id, undefined when not pushed
 * @param {{ columns?: Iterable<string> }} [opts]
 * @returns {{ text: string, missing: VariablePlan[] }}  `missing`: referenced variables without an id
 */
export function bindVariables(text, variables, idOf, { columns = [] } = {}) {
	if (!text || !variables?.length) return { text, missing: [] };
	const byLegacyId = new Map(variables.map((v) => [v.legacyId, v]));
	const missing = new Set();
	const swap = (v, original) => {
		const id = idOf(v);
		if (id === undefined || id === null) {
			missing.add(v);
			return original;
		}
		return `DOMO_BEAST_MODE(${id})`;
	};
	let out = text.replace(REFERENCE, (m, legacyId) => (byLegacyId.has(legacyId) ? swap(byLegacyId.get(legacyId), m) : m));
	const taken = new Set([...columns].map((c) => String(c).toLowerCase()));
	for (const v of variables) {
		if (!v.name || taken.has(v.name.toLowerCase())) continue;
		for (const quoted of new Set([`\`${v.name}\``, JSON.stringify(`\`${v.name}\``).slice(1, -1)])) {
			if (out.includes(quoted)) out = out.replace(new RegExp(escapeRegex(quoted), 'g'), (m) => swap(v, m));
		}
	}
	return { text: out, missing: [...missing] };
}

/**
 * Default value expression for a variable: DATE('yyyy-mm-dd') and TIMESTAMP('...') make DATE and DATETIME variables
 * (CALENDAR_DROPDOWN needs one). The variable editor reads only DATE('yyyy-mm-dd') as a specific date;
 * other forms open as a relative date cut to 10 characters.
 * @param {VariablePlan} variable
 */
export function variableExpression(variable) {
	const expression = variable.defaultExpression;
	const type = variable.parameter?.datatype;
	if (!DATES.has(type) || !/^'[^']*'$/.test(expression ?? '')) return expression;
	const text = expression.slice(1, -1).replace('T', ' ');
	if (!text) return expression;
	if (type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(text) ? `DATE('${text.slice(0, 10)}')` : `CAST('${text}' AS DATE)`;
	return `TIMESTAMP('${text}')`;
}

function memberValue(value, datatype) {
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	let text = String(value ?? '');
	if (/^".*"$/s.test(text)) text = text.slice(1, -1).replace(/""/g, '"');
	if (/^#.*#$/.test(text)) text = text.slice(1, -1);
	if (datatype === 'boolean') return text.toLowerCase() === 'true' ? 'true' : 'false';
	return text;
}

/** Domo controls show raw values only, so a list parameter whose aliases differ from its values becomes a STRING
 * variable over the labels, mapped back in beast modes (labels must be distinct). @returns {{ label: string, value: string }[] | undefined} */
export function parameterAliases(parameter) {
	if (parameter?.domain !== 'list' || DATES.has(parameter.datatype) || !parameter.members?.length) return undefined;
	const members = parameter.members.map((m) => {
		const value = memberValue(m.value, parameter.datatype);
		const alias = m.alias === undefined || m.alias === null || m.alias === '' ? value : String(m.alias);
		return { label: alias, value };
	});
	if (!members.some((m) => m.label !== m.value)) return undefined;
	const labels = new Set(members.map((m) => m.label));
	return labels.size === members.length ? members : undefined;
}

const labelLiteral = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

export function aliasedReference(variable, aliases) {
	const numeric = NUMERIC.has(variable.parameter?.datatype) || variable.parameter?.datatype === 'boolean';
	const literal = (value) => (numeric && finite(value) ? String(Number(value)) : labelLiteral(value));
	const branches = aliases.map((m) => `WHEN ${labelLiteral(m.label)} THEN ${literal(m.value)}`).join(' ');
	return `(CASE ${variableReference(variable)} ${branches} END)`;
}

export function aliasedLabel(parameter, aliases) {
	const current = memberValue(parameter.value, parameter.datatype);
	const match = aliases.find((m) => m.value === current || (finite(m.value) && finite(current) && Number(m.value) === Number(current)));
	return (match ?? aliases[0]).label;
}

export const aliasedDefault = (parameter, aliases) => labelLiteral(aliasedLabel(parameter, aliases));

function listValues(parameter) {
	const aliases = parameterAliases(parameter);
	if (aliases) return aliases.map((m) => ({ expression: { exprType: 'STRING_VALUE', value: m.label } }));
	const members = parameter.members?.length
		? parameter.members
		: parameter.datatype === 'boolean'
			? [{ value: true }, { value: false }]
			: [];
	const exprType = NUMERIC.has(parameter.datatype) ? 'NUMERIC_VALUE' : 'STRING_VALUE';
	const seen = new Set();
	const values = [];
	for (const m of members) {
		const value = memberValue(m.value, parameter.datatype);
		if (seen.has(value)) continue;
		seen.add(value);
		values.push({ expression: { exprType, value } });
	}
	return values;
}

const finite = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

/**
 * Variable control for a parameter, shaped like the Tableau parameter control: a list is a dropdown (radio buttons
 * for a single value list), a numeric range with both bounds a slider (or a box for type-in controls), a date a
 * calendar, anything else a text box. `override` sets the control's value to the parameter's current value: a variable
 * serves every workbook with a parameter of that name, and each page or card keeps its own value.
 * @param {VariablePlan} variable
 * @param {{ mode?: string, name?: string, override?: boolean }} [opts]  Tableau control mode (compact, list, slider, type_in, datetime)
 * @returns {{ control: VariableControlSpec, notes: string[] }}
 */
export function variableControl(variable, { mode, name, override = false } = {}) {
	const p = variable.parameter ?? {};
	const notes = [];
	const control = { controlType: 'VARIABLE', name: name ?? variable.name, type: 'INPUT', format: { type: 'default' } };
	const m = String(mode ?? '').toLowerCase();
	if (DATES.has(p.datatype)) {
		control.type = 'CALENDAR_DROPDOWN';
		if (p.domain === 'range' && p.range?.min !== undefined) control.min = memberValue(p.range.min, p.datatype).slice(0, 10);
		if (p.domain === 'range' && p.range?.max !== undefined) control.max = memberValue(p.range.max, p.datatype).slice(0, 10);
		if (p.domain === 'list') notes.push('its list of dates becomes a calendar picker');
	} else if (p.domain === 'list' || p.datatype === 'boolean') {
		const values = listValues(p);
		if (values.length) {
			control.type = m === 'list' || m === 'radiolist' ? 'RADIOS' : 'DROPDOWN';
			control.values = values;
			if (!parameterAliases(p) && (p.members ?? []).some((x) => x.alias !== undefined && String(x.alias) !== memberValue(x.value, p.datatype))) {
				notes.push('Domo controls show member values, not their Tableau aliases');
			}
		}
	} else if (p.domain === 'range' && NUMERIC.has(p.datatype) && finite(p.range?.min) && finite(p.range?.max) && m !== 'type_in' && m !== 'typein') {
		control.type = 'SLIDER';
		control.min = String(Number(p.range.min));
		control.max = String(Number(p.range.max));
		control.stepSize = String(finite(p.range.step) && Number(p.range.step) > 0 ? Number(p.range.step) : p.datatype === 'integer' ? 1 : (Number(p.range.max) - Number(p.range.min)) / 100);
	} else if (p.domain === 'range') {
		notes.push('its range is not enforced by the Domo text box');
	}
	if (override) {
		const value = overrideExpression(p);
		if (value) control.override = value;
	}
	return { control, notes };
}

/** Expression for a parameter's current value (dates as DATE('yyyy-mm-dd'), as the Domo control writes them). */
function overrideExpression(p) {
	if (p.value === null || p.value === undefined) return undefined;
	const aliases = parameterAliases(p);
	if (aliases) return { exprType: 'STRING_VALUE', value: aliasedLabel(p, aliases) };
	if (NUMERIC.has(p.datatype) && finite(p.value)) return { exprType: 'NUMERIC_VALUE', value: Number(p.value) };
	const text = memberValue(p.value, p.datatype);
	if (DATES.has(p.datatype)) return { exprType: 'FUNCTION', name: 'DATE', arguments: [{ exprType: 'STRING_VALUE', value: text.slice(0, 10) }] };
	return { exprType: 'STRING_VALUE', value: text };
}

/**
 * Variables keyed by parameter name and type instead of by workbook. Domo variable names are unique on an instance,
 * and beast modes on a shared published datasource dataset are shared by every workbook defining them the same way,
 * so workbooks with a parameter of the same name and type share one variable; each page and card control keeps that
 * workbook's value (`variableControl` `override`). Names of one workbook that share a key ("Upside 40%" and
 * "Upside <40%") get a hash of the name in their key; a repeated name gets " (2)".
 * @param {VariablePlan[]} variables  the variables of one workbook
 * @returns {VariablePlan[]}
 */
export function siteVariables(variables) {
	const typeOf = (v) => String(v.keyType ?? v.dataType ?? 'STRING').toLowerCase();
	const baseKey = (name, type) => `param.${slugify(name || 'parameter')}.${type}`;
	const norm = (name) => String(name ?? '').trim().toLowerCase();
	const names = new Map();
	for (const v of variables) {
		const key = baseKey(v.name || v.parameter?.id, typeOf(v));
		if (!names.has(key)) names.set(key, new Set());
		names.get(key).add(norm(v.name));
	}
	const used = new Set();
	return variables.map((v) => {
		const type = typeOf(v);
		let name = v.name;
		let key = baseKey(v.name || v.parameter?.id, type);
		const first = [...names.get(key)].sort()[0];
		if (norm(name) !== first) key = baseKey(`${v.name}-${shortHash(norm(name))}`, type);
		for (let n = 2; used.has(key); n++) {
			name = `${String(v.name).trim()} (${n})`;
			key = baseKey(`${slugify(v.name)}-${n}`, type);
		}
		used.add(key);
		return { ...v, name, key, legacyId: beastModeLegacyId('site', 'variable', String(name).toLowerCase(), type), previousKey: v.key };
	});
}

/** Parameter id -> variable name: the caption, or `<caption> (Parameter)` when a calc has it (bindVariables binds by name). */
export function parameterVariableNames(ir) {
	const lower = (s) => String(s ?? '').trim().toLowerCase();
	const calcs = new Set();
	for (const ds of ir.datasources ?? []) for (const f of ds.fields ?? []) if (f.name && f.kind !== 'column') calcs.add(lower(f.name));
	const parameters = ir.parameters ?? [];
	const used = new Set(parameters.map((p) => lower(p.name)));
	const names = new Map();
	for (const p of parameters) {
		let name = p.name;
		if (calcs.has(lower(name))) {
			name = `${String(p.name).trim()} (Parameter)`;
			for (let n = 2; calcs.has(lower(name)) || used.has(lower(name)); n++) name = `${String(p.name).trim()} (Parameter ${n})`;
			used.add(lower(name));
		}
		names.set(p.id, name);
	}
	return names;
}

/** Tableau formula literal for a parameter's current value. */
function tableauLiteral(parameter) {
	const v = parameter.value;
	if (v === null || v === undefined) return 'NULL';
	if (parameter.datatype === 'boolean') return String(v).toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
	if (NUMERIC.has(parameter.datatype) && Number.isFinite(Number(v))) return Number(v) < 0 ? `(${Number(v)})` : String(Number(v));
	const text = memberValue(v, parameter.datatype);
	if (DATES.has(parameter.datatype)) return `#${text.replace('T', ' ')}#`;
	return `"${text.replace(/"/g, '""')}"`;
}

const PARAMETER_REF = /\[Parameters\]\.\[(?:[^\]]|\]\])*\]/g;

/**
 * The IR with references to `parameters` in calculated field formulas replaced by their current value, so those
 * calcs translate exactly as with `parameters: 'inline'` while the other parameters stay variables.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {Set<string>} parameterIds
 */
export function inlineParameters(ir, parameterIds) {
	if (!parameterIds.size) return ir;
	const find = parameterLookup(ir.parameters ?? []);
	const rewrite = (formula) =>
		formula.replace(PARAMETER_REF, (m) => {
			const p = find(m);
			return p && parameterIds.has(p.id) ? tableauLiteral(p) : m;
		});
	return {
		...ir,
		datasources: (ir.datasources ?? []).map((ds) => ({
			...ds,
			fields: (ds.fields ?? []).map((f) => {
				if (typeof f.set?.top?.count === 'string' && f.set.top.count.includes('[Parameters]')) return { ...f, set: { ...f.set, top: { ...f.set.top, count: rewrite(f.set.top.count) } } };
				return typeof f.formula === 'string' && f.formula.includes('[Parameters]') ? { ...f, formula: rewrite(f.formula) } : f;
			})
		}))
	};
}

/** Parameter ids each calculated field uses, through the calcs it references. Keyed by datasource id, then field id. */
function parameterUsage(ir) {
	const find = parameterLookup(ir.parameters ?? []);
	const out = new Map();
	for (const ds of ir.datasources ?? []) {
		const fields = new Map((ds.fields ?? []).map((f) => [f.id, f]));
		const direct = new Map();
		for (const f of ds.fields ?? []) {
			const top = f.kind === 'set' ? f.set?.top : undefined;
			const formula = top?.by ? `IF ${top.by} <= ${typeof top.count === 'string' ? top.count : 0} THEN 1 END` : f.formula;
			if (typeof formula !== 'string') continue;
			try {
				const a = analyzeFormula(parseFormula(formula));
				direct.set(f.id, { params: a.parameters.map((id) => find(id)?.id).filter(Boolean), refs: a.refs });
			} catch {
				direct.set(f.id, { params: [], refs: [] });
			}
		}
		const memo = new Map();
		const used = (id, seen = new Set()) => {
			if (memo.has(id)) return memo.get(id);
			const d = direct.get(id) ?? direct.get(fields.get(id)?.id);
			if (!d || seen.has(id)) return new Set();
			seen.add(id);
			const all = new Set(d.params);
			for (const r of d.refs) for (const p of used(r, seen)) all.add(p);
			memo.set(id, all);
			return all;
		};
		const byField = new Map();
		for (const id of direct.keys()) {
			const params = used(id);
			if (params.size) byField.set(id, params);
		}
		out.set(ds.id, byField);
	}
	return out;
}

const errorCounts = (issues) => {
	const counts = new Map();
	for (const i of issues ?? []) {
		if (i.severity !== 'error' || !i.object?.id) continue;
		counts.set(i.object.id, (counts.get(i.object.id) ?? 0) + 1);
	}
	return counts;
};

/**
 * Decide which parameters become Domo variables when `options.parameters` is 'variables'. A parameter stays an
 * inlined constant when no calculated field uses it, or when a calc using it translates worse as a variable
 * reference than with the value inlined (a literal-only argument such as a LOOKUP offset, or a branch that inlining
 * folds away). Runs planBeastModes in both modes, repeating until no other parameter falls back.
 *
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {import('../model/types.js').DatasetPlan[]} datasets
 * @param {{ options?: import('../model/types.js').ConvertOptions, workbookKey?: string, shared?: Object }} [opts]
 * @returns {{ ir: import('../model/types.js').WorkbookIR, inline: Map<string, string>, issues: import('../model/types.js').Issue[] }}
 *   `ir` with the inlined parameters' references replaced, `inline` parameter id -> reason
 */
export function resolveParameterModes(ir, datasets, { options = {}, workbookKey, shared } = {}) {
	const parameters = ir.parameters ?? [];
	const inline = new Map();
	if (options.parameters !== 'variables' || !parameters.length) return { ir, inline, issues: [] };
	const usage = parameterUsage(ir);
	const usedAnywhere = new Set();
	for (const byField of usage.values()) for (const params of byField.values()) for (const p of params) usedAnywhere.add(p);
	for (const p of parameters) if (!usedAnywhere.has(p.id)) inline.set(p.id, 'no calculation uses it');

	const run = (input, mode) => planBeastModes(input, datasets, { options: { ...options, parameters: mode }, workbookKey, shared });
	const baseline = run(ir, 'inline');
	const baseStatus = new Map(baseline.beastModes.map((bm) => [bm.key, bm.status]));
	const baseErrors = errorCounts(baseline.issues);
	for (let round = 0; round < MAX_FALLBACK_ROUNDS; round++) {
		const current = run(inlineParameters(ir, new Set(inline.keys())), 'variables');
		const errors = errorCounts(current.issues);
		const firstError = new Map();
		for (const i of current.issues ?? []) if (i.severity === 'error' && i.object?.id && !firstError.has(i.object.id)) firstError.set(i.object.id, i.message);
		let added = false;
		for (const bm of current.beastModes) {
			const worse = (bm.status === 'unsupported' && baseStatus.get(bm.key) !== 'unsupported') || (errors.get(bm.tableauFieldId) ?? 0) > (baseErrors.get(bm.tableauFieldId) ?? 0);
			if (!worse) continue;
			for (const byField of usage.values()) {
				for (const p of byField.get(bm.tableauFieldId) ?? []) {
					if (inline.has(p)) continue;
					inline.set(p, `calculation ${bm.name} cannot use it as a Domo variable${firstError.has(bm.tableauFieldId) ? ` (${firstError.get(bm.tableauFieldId)})` : ''}`);
					added = true;
				}
			}
		}
		if (!added) break;
	}

	const issues = [];
	for (const p of parameters) {
		if (!inline.has(p.id)) continue;
		issues.push({
			severity: 'info',
			code: 'calc.parameter-constant',
			message: `Parameter '${p.name}' is inlined with its current value ${JSON.stringify(p.value)} instead of becoming a Domo variable: ${inline.get(p.id)}`,
			object: { type: 'parameter', name: p.name, id: p.id }
		});
	}
	const substituted = new Set([...inline.keys()].filter((id) => usedAnywhere.has(id)));
	return { ir: inlineParameters(ir, substituted), inline, issues };
}
