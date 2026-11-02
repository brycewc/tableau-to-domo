import { stripBrackets } from '../model/naming.js';
import { parsePillId } from '../tableau/twb/shelf.js';
import { parseFormula } from './calc/parser.js';
import { ref } from '../util/refs.js';
import { parameterAliases } from './variables.js';

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').FieldBindings} FieldBindings
 *
 * @typedef {Object} TitleContext
 * @property {string} [sheetName]
 * @property {WorkbookIR} [ir]        Parameters and calculated fields that title tokens can be resolved from
 * @property {Map<string, string>} [variables]  Parameter id -> planned Domo variable key; their tokens become VARIABLE_VALUE items
 * @property {boolean} [smartText]   Dimension tokens become FILTER items and <Data Source Name> a DATA_SOURCE_NAME item
 * @property {string} [dataSourceName]  The plain text of <Data Source Name>
 *
 * @typedef {{ type: 'TEXT', text: string }|{ type: 'VARIABLE_VALUE', variables: Object[], defaultText: string }|{ type: 'FILTER', columns: string[], defaultText: string }|{ type: 'DATA_SOURCE_NAME' }} TitleItem
 *
 * @typedef {Object} ResolvedTitle
 * @property {string} text
 * @property {{ text: string, items?: TitleItem[] }[]} lines  Non-empty lines; `items` when the line shows smart text
 * @property {{ name: string, key: string, value: string, aliased: boolean }[]} variables  Parameters shown as their variable
 * @property {string[]} filtered     Dimension tokens shown as FILTER smart text
 * @property {string[]} fields       Field tokens left out: their values change with the data, a Domo title is static
 * @property {{ name: string, value: string }[]} parameters  Parameter values (or calcs of them) written in as text
 * @property {string[]} other        Other dropped tokens, e.g. Data Update Time
 */

const TOKEN = /<(\[[^<>]+\])>|<([A-Za-z][A-Za-z ]*)>/g;
const DROPPED = '';
const VARIABLE = /\uE001(\d+)\uE002/g;
const CONNECTOR = /^(by|for|with|of|in|at|from|to|and|or|vs\.?|per|on|-|:|\||\/|,|&)$/i;
const MAX_DEPTH = 5;
// Pill aggregations that leave a constant as it is; SUM and COUNT of one depend on the row count.
const CONSTANT_AGGREGATIONS = new Set(['None', 'Attribute', 'Avg', 'Min', 'Max', 'Median', 'User']);
// What Tableau shows for a title field whose filter keeps every member.
const ALL_MEMBERS = 'All';

const paramKey = (id) => stripBrackets(String(id ?? '').replace(/^\[Parameters\]\./, ''));

function displayValue(param) {
	const raw = param.value ?? '';
	const member = (param.members ?? []).find((m) => String(m.value) === String(raw));
	return String(member?.alias ?? raw);
}

function findParameter(ir, datasourceId, fieldId) {
	const key = paramKey(fieldId);
	const params = ir?.parameters ?? [];
	if (datasourceId && datasourceId !== 'Parameters') return undefined;
	return params.find((p) => paramKey(p.id) === key) ?? params.find((p) => p.name === key);
}

function findField(ir, datasourceId, fieldId) {
	const ds = (ir?.datasources ?? []).find((d) => d.id === datasourceId);
	return ds?.fields?.find((f) => f.id === fieldId) ?? ds?.fields?.find((f) => f.name === stripBrackets(fieldId));
}

/** Value of a calculation that only depends on parameters and literals, or undefined when it reads data. */
function evaluateCalc(ir, datasourceId, field, depth = 0) {
	if (!field?.formula || depth > MAX_DEPTH) return undefined;
	let ast;
	try {
		ast = parseFormula(field.formula);
	} catch {
		return undefined;
	}
	const NOT_STATIC = Symbol('data');
	const truthy = (v) => v === true;
	const ev = (node) => {
		switch (node?.type) {
			case 'Literal':
				return node.value;
			case 'Paren':
				return ev(node.expr);
			case 'Field': {
				const [first, second] = node.parts ?? [];
				// A one-part reference is a field of the calc's datasource before it is a parameter of that name.
				const other = second === undefined && findField(ir, datasourceId, node.id);
				const param = second !== undefined ? findParameter(ir, first, `[${second}]`) : !other && findParameter(ir, 'Parameters', `[${first}]`);
				if (param) return param.value ?? null;
				if (!other || other === field) throw NOT_STATIC;
				const value = evaluateCalc(ir, datasourceId, other, depth + 1);
				if (value === undefined) throw NOT_STATIC;
				return value;
			}
			case 'If': {
				for (const b of node.branches) if (truthy(ev(b.cond))) return ev(b.then);
				return node.else ? ev(node.else) : null;
			}
			case 'Case': {
				const subject = node.subject ? ev(node.subject) : true;
				for (const w of node.whens) if (String(ev(w.when)) === String(subject)) return ev(w.then);
				return node.else ? ev(node.else) : null;
			}
			case 'Unary':
				if (node.op === 'NOT') return !truthy(ev(node.operand));
				throw NOT_STATIC;
			case 'Binary': {
				const l = ev(node.left);
				if (node.op === 'AND') return truthy(l) && truthy(ev(node.right));
				if (node.op === 'OR') return truthy(l) || truthy(ev(node.right));
				const r = ev(node.right);
				if (node.op === '=') return l !== null && r !== null && String(l) === String(r);
				if (node.op === '!=') return l !== null && r !== null && String(l) !== String(r);
				if (node.op === '+') {
					if (l === null || r === null) return null;
					return typeof l === 'number' && typeof r === 'number' ? l + r : `${l}${r}`;
				}
				throw NOT_STATIC;
			}
			default:
				throw NOT_STATIC;
		}
	};
	try {
		return ev(ast) ?? '';
	} catch (err) {
		if (err === NOT_STATIC) return undefined;
		throw err;
	}
}

function tidyLine(line) {
	if (!line.includes(DROPPED)) return line.replace(/[ \t]+/g, ' ').trim();
	const all = line.split(/\s+/).filter(Boolean);
	const words = [];
	let labelled = false;
	for (const w of all) {
		if (w.includes(DROPPED)) {
			const label = /^([^]*[^:]):/.exec(w)?.[1];
			const brackets = w.replaceAll(DROPPED, '');
			if (/^[()[\]]+$/.test(brackets)) {
				words.push(brackets);
				continue;
			}
			if (label) words.push(label);
			else if (words.length && /[^:]:$/.test(words.at(-1))) words[words.length - 1] = words.at(-1).slice(0, -1);
			else continue;
			labelled = true;
			continue;
		}
		if (labelled && !CONNECTOR.test(w)) words[words.length - 1] += ',';
		labelled = false;
		words.push(w);
	}
	if (all.at(-1)?.includes(DROPPED) || labelled) while (words.length > 1 && CONNECTOR.test(words.at(-1))) words.pop();
	if (all[0]?.includes(DROPPED)) while (words.length > 1 && CONNECTOR.test(words[0])) words.shift();
	if (words.length === 1 && CONNECTOR.test(words[0])) words.pop();
	return words
		.join(' ')
		.replace(/\(\s*\)|\[\s*\]/g, '')
		.replace(/\(\s+/g, '(')
		.replace(/\s+([,.;:)])/g, '$1')
		.replace(/[ \t]+/g, ' ')
		.replace(/[\s:|,(-]+$/, '')
		.trim();
}

/**
 * Card title text from a Tableau title. Parameter tokens become the parameter's current value, calculations of
 * parameters only are evaluated, and data field tokens are left out with the word they are glued to.
 * @param {string|undefined} raw
 * @param {FieldBindings} [bindings]
 * @param {TitleContext} [ctx]
 * @returns {ResolvedTitle}
 */
export function resolveTitle(raw, bindings, { sheetName, ir, variables, smartText, dataSourceName } = {}) {
	const out = { text: '', lines: [], variables: [], filtered: [], fields: [], parameters: [], other: [] };
	const shown = [];
	const show = (item) => {
		shown.push(item);
		return `${shown.length - 1}`;
	};
	const text = String(raw ?? '').replace(TOKEN, (all, bracketed, named) => {
		if (named) {
			if (/^(sheet name|default title)$/i.test(named) && sheetName) return sheetName;
			if (/^workbook name$/i.test(named) && ir?.workbook?.name) return ir.workbook.name;
			if (smartText && /^data ?source name$/i.test(named)) return show({ type: 'DATA_SOURCE_NAME' });
			out.other.push(named);
			return DROPPED;
		}
		const pill = parsePillId(bracketed);
		if (!pill?.fieldId) return all;
		const param = findParameter(ir, pill.datasourceId, pill.fieldId);
		if (param) {
			const value = displayValue(param);
			const key = variables?.get(param.id);
			if (key) {
				const aliased = !parameterAliases(param) && (param.members ?? []).some((m) => m.alias !== undefined && m.alias !== null && String(m.alias) !== String(m.value));
				out.variables.push({ name: param.name ?? paramKey(param.id), key, value, aliased });
				return show({ type: 'VARIABLE_VALUE', variables: [ref('variable', key)], defaultText: value });
			}
			out.parameters.push({ name: param.name ?? paramKey(param.id), value });
			return value || DROPPED;
		}
		const field = findField(ir, pill.datasourceId, pill.fieldId);
		const binding = bindings?.get?.(pill.datasourceId, pill.fieldId);
		const name = binding?.name ?? field?.name ?? stripBrackets(pill.fieldId);
		const value = !pill.derivation || CONSTANT_AGGREGATIONS.has(pill.derivation) ? evaluateCalc(ir, pill.datasourceId, field) : undefined;
		if (value !== undefined) {
			out.parameters.push({ name, value: String(value) });
			return String(value) || DROPPED;
		}
		const columns = smartText && filterColumns(pill, binding);
		if (columns) {
			out.filtered.push(name);
			return show({ type: 'FILTER', columns, defaultText: ALL_MEMBERS });
		}
		out.fields.push(name);
		return DROPPED;
	});
	const lines = text.split(/\r?\n/).map(tidyLine);
	const plain = (line) => line.replace(VARIABLE, (_, i) => shown[i].defaultText ?? (shown[i].type === 'DATA_SOURCE_NAME' ? (dataSourceName ?? '') : ''));
	out.text = lines.map(plain).join('\n').trim();
	out.lines = lines.filter((line) => plain(line)).map((line) => (line.includes('\uE001') ? { text: plain(line), items: titleItems(line, shown) } : { text: plain(line) }));
	return out;
}

function filterColumns(pill, binding) {
	if (!binding || pill.tableCalc) return undefined;
	if (pill.aggregated && pill.derivation !== 'Attribute') return undefined;
	if (binding.kind === 'column' && binding.column) return [binding.column];
	if (binding.kind === 'formula' && binding.formulaId && !binding.aggregated) return [binding.formulaId, binding.formulaName ?? binding.name];
	return undefined;
}

function titleItems(line, shown) {
	const items = [];
	line.split(VARIABLE).forEach((part, i) => {
		if (i % 2) items.push(shown[part]);
		else if (part) items.push({ type: 'TEXT', text: part });
	});
	return items;
}

/** Title text only; see resolveTitle. */
export function titleText(raw, bindings, ctx) {
	return resolveTitle(raw, bindings, ctx).text;
}
