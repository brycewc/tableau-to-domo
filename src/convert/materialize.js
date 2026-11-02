import { ref } from '../util/refs.js';
import { slugify } from '../util/ids.js';
import { parseFormula, analyzeFormula, translateEtl, LARGE_EXPRESSION_BYTES } from './calc/index.js';
import { sharedRowCalcs } from './inline-size.js';
import { refreshesOnUpdate } from './etl.js';
import { ETL_ONLY_FUNCTIONS, TABLE_CALCS, VOLATILE_FUNCTIONS } from './calc/catalog.js';
import { tableCalcAddressing } from './calc/tablecalc.js';
import { collationIgnoresCase } from './calc/sql.js';
import { calcFormula, fieldLookup, parameterLookup, planBeastModes } from './beastmodes.js';
import { tableauToDomoType } from './schema.js';
import { topRankReason } from './top-rank.js';
import { stripBrackets } from '../model/naming.js';
import { parsePillId } from '../tableau/twb/shelf.js';

/**
 * Calcs Beast Mode cannot express, computed as columns by Magic ETL: a FIXED LOD used as a row-level value or
 * dimension (Group By its dimensions, joined back), the inner LOD of a wrapped nested LOD, row-level functions
 * only Magic ETL formulas support, and the inner table calc of a nested one (at a worksheet grain).
 *
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../model/types.js').FieldIR} FieldIR
 * @typedef {import('../model/types.js').DatasetPlan} DatasetPlan
 * @typedef {import('../model/types.js').DataflowPlan} DataflowPlan
 * @typedef {import('../model/types.js').Issue} Issue
 *
 * @typedef {Object} Unit
 * @property {string} id                 'field:<fieldId>' | 'formula:<fieldId>' | 'lod:<node text>' | 'window:<node text>:<grain>' | 'top:<spec>'
 * @property {'field'|'formula'|'inline'|'window'|'top'} kind
 * @property {FieldIR} field             The calc it is named after (for inline LODs, the calc whose formula holds it)
 * @property {Object} node               Lod AST node (field, inline), the formula AST (formula) or the inner table calc call (window)
 * @property {Object} [grain]            window: worksheet, dims, partition and order
 * @property {Object} [window]           window: the Rank & Window operation, or a reason it has none
 * @property {Map<string, FieldIR>} [serves]  window: the calcs that read the column
 * @property {Object} [top]              top: the ranked dimension, direction, filters applied first and the sheets served
 */

const TARGET_CODES = new Set(['calc.lod-dimension', 'calc.lod-nested-wrapped', 'calc.no-equivalent', 'calc.table-calc-nested']);
const FIXABLE_CODES = new Set([...TARGET_CODES, 'calc.unsupported']);
const CALC_KINDS = new Set(['calculated', 'bin', 'group', 'set']);
const MAX_ROUNDS = 12;
const MAX_SWITCHED_RANKS = 12;
const TABLEAU_TYPES = { LONG: 'integer', DOUBLE: 'real', DECIMAL: 'real', STRING: 'string', DATE: 'date', DATETIME: 'datetime' };
// Magic ETL formulas default to the instance time zone; Beast Mode evaluates dates in UTC.
const ETL_SETTINGS = { zoneId: 'UTC' };
const X_STEP = 220;
const Y_STEP = 120;

const lodKey = (node) => JSON.stringify(node, (k, v) => (k === 'pos' ? undefined : v));
// The null-safe join key of a ranked dimension: Tableau ranks Null as a member, and a Magic ETL join never matches nulls.
const NULL_KEY = '#t2d-null#';

const etlLiteral = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);

function topIssue(served, message) {
	return { severity: 'warning', code: 'filter.top-context', message, object: { type: 'worksheet', name: served.worksheet } };
}

function setRankIssues(unit, { column, byValue }, flowName, an) {
	const { field, top } = unit;
	const perValue = byValue ? `, one rank per value of parameter ${byValue.parameter.name} (${byValue.ranks.map((r) => `'${r.column}'`).join(', ')}) that the Beast Mode picks by its variable` : ` as column '${column}'`;
	const name = (id) => an.lookupField(id)?.name ?? stripBrackets(id);
	const by = top.by.replace(/\[[^\]]+\](?:\.\[[^\]]+\])?/g, (m) => an.lookupField(m)?.name ?? m);
	const list = (ids) => {
		const names = [...new Set(ids.map(name))];
		return names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ');
	};
	const partitioned = top.partitioned ?? [];
	const shown = top.set.shown.filter((id) => !partitioned.includes(id));
	const out = [
		issue('info', 'calc.materialized', `Top N set '${field.name}' ranks ${top.dim.label} by ${by} in Magic ETL dataflow '${flowName}'${perValue} (a Group By on ${top.dim.label}${top.first.length ? ' over the rows its datasource and context filters keep' : ''}, a Rank & Window tile, joined back to every row); its Beast Mode is In where the rank is at most N.`, field),
		issue(
			'warning',
			'calc.set-top-rank',
			`Top N set '${field.name}' is ranked when the dataflow runs${shown.length ? `; changing the context filters ${list(shown)} does not re-rank the members as in Tableau` : ''}. Members tied at rank N are all In, where Tableau keeps exactly N.`,
			field,
			'Run the dataflow after the data refreshes.'
		)
	];
	if (partitioned.length) {
		out.push(
			issue(
				'warning',
				'calc.set-top-partition',
				`Top N set '${field.name}' is ranked separately for each value of the context filters ${list(partitioned)}, so a single value chosen in them ranks as in Tableau; with several values (or all) chosen, each value keeps its own top N, where Tableau ranks across them.`,
				field
			)
		);
	}
	if (top.set.differing.length) {
		out.push(issue('warning', 'calc.set-top-context', `Worksheets using top N set '${field.name}' (${top.set.sheets.join(', ')}) have different context filters on ${list(top.set.differing)}; the Magic ETL rank applies only the context filters they share.`, field));
	}
	return out;
}

function unwrap(node) {
	let n = node;
	while (n?.type === 'Paren') n = n.expr;
	return n;
}

function children(node) {
	switch (node?.type) {
		case 'Call':
			return node.args;
		case 'Unary':
			return [node.operand];
		case 'Binary':
			return [node.left, node.right];
		case 'In':
			return [node.expr, ...node.list];
		case 'If':
			return [...node.branches.flatMap((b) => [b.cond, b.then]), node.else];
		case 'Case':
			return [node.subject, ...node.whens.flatMap((w) => [w.when, w.then]), node.else];
		case 'Paren':
			return [node.expr];
		case 'Lod':
			return [...node.dims, node.body];
		default:
			return [];
	}
}

function issue(severity, code, message, field, suggestion) {
	return {
		severity,
		code,
		message,
		...(field ? { object: { type: 'field', name: field.name, id: field.id } } : {}),
		...(suggestion ? { suggestion } : {})
	};
}

/** Formula facts of one datasource: calc lookup, cached ASTs and unit discovery. */
function analyzer(ir, ds) {
	const lookupField = fieldLookup(ds);
	const findParameter = parameterLookup(ir.parameters ?? []);
	const asts = new Map();
	const astOf = (field) => {
		if (!asts.has(field.id)) {
			let ast;
			try {
				const formula = calcFormula(field, { lookupField, findParameter });
				ast = formula ? parseFormula(formula) : null;
			} catch {
				ast = null;
			}
			asts.set(field.id, ast);
		}
		return asts.get(field.id);
	};
	const calcField = (id) => {
		if (findParameter(id)) return undefined;
		const f = lookupField(id);
		return f && CALC_KINDS.has(f.kind) ? f : undefined;
	};
	const isLodField = (field) => unwrap(astOf(field))?.type === 'Lod';
	const fieldUnit = (field) => ({ id: `field:${field.id}`, kind: 'field', field, node: unwrap(astOf(field)) });

	/** LOD units reached from `nodes` without entering another LOD unit; calc references are followed. */
	const topUnits = (nodes, owner, out = new Map(), stack = new Set()) => {
		const visit = (node, current) => {
			if (!node) return;
			if (node.type === 'Field') {
				const field = calcField(node.id);
				if (!field) return;
				if (isLodField(field)) {
					const u = fieldUnit(field);
					out.set(u.id, u);
					return;
				}
				if (stack.has(field.id) || !astOf(field)) return;
				stack.add(field.id);
				visit(astOf(field), field);
				stack.delete(field.id);
				return;
			}
			if (node.type === 'Lod') {
				const id = `lod:${lodKey(node)}`;
				out.set(id, { id, kind: 'inline', field: current, node });
				return;
			}
			for (const child of children(node)) visit(child, current);
		};
		for (const n of nodes) visit(n, owner);
		return out;
	};

	const unitsOfField = (field) => (isLodField(field) ? new Map([[`field:${field.id}`, fieldUnit(field)]]) : topUnits([astOf(field)], field));
	const innerUnits = (unit) => {
		if (unit.kind === 'top') return topUnits([unit.node, unit.top.dim.node, ...unit.top.first.map((f) => parseFormula(f.fieldId))], unit.field);
		return unit.kind === 'formula' || unit.kind === 'window' ? topUnits([unit.node], unit.field) : topUnits([...unit.node.dims, unit.node.body], unit.field);
	};
	const closure = (units, into) => {
		const queue = [...units.values()];
		while (queue.length) {
			const u = queue.shift();
			if (into.has(u.id)) continue;
			into.set(u.id, u);
			queue.push(...innerUnits(u).values());
		}
	};

	/** Row-level calcs reached from `field` (itself included) that call a function only Magic ETL supports. */
	const formulaUnits = (field) => {
		const out = new Map();
		const seen = new Set();
		const visitField = (f) => {
			if (seen.has(f.id) || isLodField(f)) return;
			seen.add(f.id);
			const ast = astOf(f);
			if (!ast) return;
			const facts = analyzeFormula(ast);
			if (facts.functions.some((n) => ETL_ONLY_FUNCTIONS.has(n)) && !facts.aggregated && !facts.lod.length && !facts.tableCalcs.length) {
				out.set(`formula:${f.id}`, { id: `formula:${f.id}`, kind: 'formula', field: f, node: ast });
			}
			for (const id of facts.refs) {
				const next = calcField(id);
				if (next) visitField(next);
			}
		};
		visitField(field);
		return out;
	};

	/** Formula units in `units` that a formula unit reads, directly or through calcs computed inline. */
	const formulaDeps = (unit, units) => {
		const out = new Set();
		const seen = new Set([unit.field.id]);
		const visit = (node) => {
			if (!node) return;
			if (node.type === 'Field') {
				const f = calcField(node.id);
				if (!f || seen.has(f.id)) return;
				seen.add(f.id);
				if (units.has(`formula:${f.id}`)) out.add(`formula:${f.id}`);
				else if (!units.has(`field:${f.id}`)) visit(astOf(f));
				return;
			}
			children(node).forEach(visit);
		};
		visit(unit.node);
		return [...out];
	};

	/** Parameters and TODAY()/NOW() calls a unit reaches, through calc references. */
	const frozenOf = (unit) => {
		const names = new Set();
		const ids = new Set();
		const volatile = new Set();
		const seen = new Set();
		const visit = (node) => {
			if (!node) return;
			if (node.type === 'Field') {
				const p = findParameter(node.id);
				if (p) {
					names.add(p.name);
					ids.add(p.id);
				}
				const f = calcField(node.id);
				if (f && !seen.has(f.id) && astOf(f)) {
					seen.add(f.id);
					visit(astOf(f));
				}
				return;
			}
			if (node.type === 'Call' && VOLATILE_FUNCTIONS.has(node.name)) volatile.add(`${node.name}()`);
			children(node).forEach(visit);
		};
		visit(unit.node);
		return { parameters: [...names], parameterIds: [...ids], volatile: [...volatile] };
	};

	/** Table calc calls inside `nodes`, without entering a table calc call, each with the calc whose formula holds it. */
	const tableCalcCalls = (nodes, owner, out = [], stack = new Set()) => {
		const visit = (node, current) => {
			if (!node) return;
			if (node.type === 'Field') {
				const field = calcField(node.id);
				if (!field || stack.has(field.id) || !astOf(field)) return;
				stack.add(field.id);
				visit(astOf(field), field);
				stack.delete(field.id);
				return;
			}
			if (node.type === 'Call' && TABLE_CALCS.has(node.name)) {
				out.push({ node, owner: current });
				return;
			}
			children(node).forEach((child) => visit(child, current));
		};
		nodes.forEach((n) => visit(n, owner));
		return out;
	};
	/** Table calcs used as the value of another table calc, whose own values hold no table calc. */
	const nestedTableCalcs = (field) => {
		const out = new Map();
		for (const outer of tableCalcCalls([astOf(field)], field)) {
			for (const inner of tableCalcCalls(valueArgs(outer.node), outer.owner)) {
				if (!tableCalcCalls(valueArgs(inner.node), inner.owner).length) out.set(`${inner.owner.id}\u0000${lodKey(inner.node)}`, inner);
			}
		}
		return [...out.values()];
	};

	const dimNode = (pill) => {
		const f = pill && pill.aggregated !== true ? lookupField(pill.fieldId) : undefined;
		if (!f || !(f.kind === 'column' || CALC_KINDS.has(f.kind))) return undefined;
		const part = pill.datePart === 'mdy' ? 'trunc:day' : (pill.datePart ?? (pill.dateTrunc ? `trunc:${pill.dateTrunc}` : null));
		if (!part) return { node: parseFormula(f.id), label: f.name };
		const [name, unit] = part.startsWith('trunc:') ? ['DATETRUNC', part.slice(6)] : ['DATEPART', part];
		return { node: parseFormula(`${name}('${unit}', ${f.id})`), label: `${name}('${unit}', ${f.name})` };
	};
	const viewDimensions = (ws, pillId) => {
		const a = tableCalcAddressing(ws, pillId, () => undefined);
		return a.dimensions.map((id) => dimNode(ws.pills?.[id]));
	};
	/** Grain, partition and order of a table calc pill in Magic ETL terms; undefined unless every part is known. */
	const grainOf = (ws, pillId, setting) => {
		const dims = new Map();
		const sheet = setting ? { ...ws, pills: { ...ws.pills, [pillId]: { ...ws.pills[pillId], tableCalc: setting } } } : ws;
		const a = tableCalcAddressing(sheet, pillId, (id, pill) => {
			const d = dimNode(pill);
			if (!d) return undefined;
			dims.set(id, d);
			return { column: id };
		});
		if (a.issues.length || a.dimensions.some((id) => !dims.has(id))) return undefined;
		const key = (id) => lodKey(dims.get(id).node);
		const grain = {
			worksheet: ws.name,
			dims: a.dimensions.map((id) => ({ id, ...dims.get(id) })),
			partition: a.partitionBy.map((i) => i.column),
			order: a.orderBy.map((i) => ({ id: i.column, ascending: i.direction !== 'DESC' })),
			filtered: Boolean((ws.filters ?? []).length || (ds.filters ?? []).length)
		};
		grain.signature = JSON.stringify([a.dimensions.map(key).sort(), grain.partition.map(key), grain.order.map((o) => [key(o.id), o.ascending])]);
		return grain;
	};
	const pillsShowing = (field, { tableCalcOnly = false } = {}) =>
		(ir.worksheets ?? []).flatMap((ws) =>
			Object.entries(ws.pills ?? {})
				.filter(([, p]) => (!tableCalcOnly || p.tableCalc) && p.datasourceId === ds.id && lookupField(p.fieldId)?.id === field.id)
				.map(([pillId]) => ({ ws, pillId }))
		);
	/**
	 * Inner table calcs of `field` computed at the grain of the first worksheet that shows it, as beastmodes.js picks it.
	 * One held by a referenced calc takes that calc's own (nested) compute-using from the pill.
	 */
	const windowUnits = (field) => {
		const out = new Map();
		const nested = nestedTableCalcs(field);
		if (!nested.length) return out;
		const [first] = pillsShowing(field, { tableCalcOnly: true }).sort((a, b) => (a.ws.pills[a.pillId].tableCalc.type === 'Calculation' ? 0 : 1) - (b.ws.pills[b.pillId].tableCalc.type === 'Calculation' ? 0 : 1));
		if (!first) return out;
		const settings = first.ws.pills[first.pillId].tableCalc.nested ?? {};
		const signatures = new Map();
		for (const { node, owner } of nested) {
			const grain = grainOf(first.ws, first.pillId, owner.id === field.id ? undefined : settings[owner.id]);
			if (!grain) return new Map();
			const key = lodKey(node);
			// The beast mode finds the column by call text, so one text at two grains cannot be told apart.
			if (signatures.has(key) && signatures.get(key) !== grain.signature) return new Map();
			signatures.set(key, grain.signature);
			const id = `window:${key}:${grain.signature}`;
			out.set(id, { id, kind: 'window', field, node, grain, window: innerWindow(node), serves: new Map([[field.id, field]]) });
		}
		return out;
	};

	return { lookupField, findParameter, calcField, astOf, unitsOfField, innerUnits, closure, formulaUnits, formulaDeps, frozenOf, windowUnits, pillsShowing, viewDimensions, dimNode };
}

/** Value arguments of a table calc call (not frame bounds, offsets or rank direction). */
function valueArgs(call) {
	if (call.name === 'WINDOW_CORR' || call.name === 'WINDOW_COVAR' || call.name === 'WINDOW_COVARP') return call.args.slice(0, 2);
	return call.args.slice(0, 1);
}

function intLiteral(node) {
	const n = unwrap(node);
	if (n?.type === 'Literal' && n.valueType === 'number' && Number.isInteger(n.value)) return n.value;
	if (n?.type === 'Unary' && n.op === '-') {
		const v = intLiteral(n.operand);
		return v === undefined ? undefined : -v;
	}
	return undefined;
}

function frameOffset(node) {
	const n = unwrap(node);
	if (n?.type === 'Call' && !n.args.length && n.name === 'FIRST') return -Infinity;
	if (n?.type === 'Call' && !n.args.length && n.name === 'LAST') return Infinity;
	return intLiteral(n);
}

/**
 * Magic ETL Rank & Window (WindowAction) operation for a table calc over one value per grain row.
 * Framed operations are SUM, AVERAGE and COUNT only, and the frame cannot end at the partition end.
 * @returns {{ value?: Object, operation: Object, orderByValue?: boolean, ascending?: boolean, ordered?: boolean, resultType?: string } | { reason: string }}
 */
function innerWindow(node) {
	const { name, args } = node;
	const framed = (operationType, preceding, following) => ({ type: 'FRAMED', operationType, column: '', preceding, following });
	const running = { RUNNING_SUM: 'SUM', RUNNING_AVG: 'AVERAGE', RUNNING_COUNT: 'COUNT' }[name];
	if (running && args.length === 1) return { value: args[0], operation: framed(running, null, 0), ordered: true, resultType: running };
	const sliding = { WINDOW_SUM: 'SUM', WINDOW_AVG: 'AVERAGE', WINDOW_COUNT: 'COUNT' }[name];
	if (sliding && args.length === 3) {
		const start = frameOffset(args[1]);
		const end = frameOffset(args[2]);
		if (start === undefined || end === undefined || start > 0 || end < 0) return { reason: `${name} needs a frame from FIRST() or an offset at or before the current row to one at or after it` };
		if (end === Infinity) return { reason: `${name} ending at LAST() has no Magic ETL Rank & Window equivalent (a frame cannot run to the end of the partition)` };
		return { value: args[0], operation: framed(sliding, start === -Infinity ? null : -start, end), ordered: true, resultType: sliding };
	}
	const rank = { RANK: 'RANK', RANK_DENSE: 'DENSE_RANK', RANK_UNIQUE: 'ROW_NUMBER' }[name];
	if (rank && (args.length === 1 || args.length === 2)) {
		const dir = args[1] ? unwrap(args[1]) : undefined;
		if (dir && !(dir.type === 'Literal' && dir.valueType === 'string')) return { reason: `${name} needs a literal 'asc' or 'desc' direction` };
		return { value: args[0], operation: { type: 'RANKING', operationType: rank }, orderByValue: true, ascending: String(dir?.value ?? 'desc').toLowerCase() === 'asc', resultType: 'COUNT' };
	}
	if (name === 'INDEX' && !args.length) return { operation: { type: 'RANKING', operationType: 'ROW_NUMBER' }, ordered: true, resultType: 'COUNT' };
	if (name === 'LOOKUP' && args.length === 2) {
		const offset = intLiteral(args[1]);
		if (!offset) return { reason: 'LOOKUP needs a non-zero integer literal offset' };
		return { value: args[0], operation: { type: 'OFFSET', operationType: offset < 0 ? 'LAG' : 'LEAD', column: '', amount: Math.abs(offset) }, ordered: true };
	}
	return { reason: `${name} has no Magic ETL Rank & Window equivalent` };
}

/** Error codes per (dataset key, field id) of the beast modes that failed, from a planBeastModes result. */
function failingCalcs(calcs) {
	const codes = new Map();
	for (const i of calcs.issues) {
		if (i.severity !== 'error' || !i.object?.id) continue;
		if (!codes.has(i.object.id)) codes.set(i.object.id, new Set());
		codes.get(i.object.id).add(i.code);
	}
	return calcs.beastModes
		.filter((b) => b.status === 'unsupported')
		.map((b) => ({ datasetKey: b.datasetKey, fieldId: b.tableauFieldId, codes: codes.get(b.tableauFieldId) ?? new Set() }))
		.filter((f) => [...f.codes].some((c) => TARGET_CODES.has(c)) && [...f.codes].every((c) => FIXABLE_CODES.has(c)));
}

/** Calcs per datasource id whose beast mode is over LARGE_EXPRESSION_BYTES, from a planBeastModes result. */
function oversizeCalcs(calcs, dsByDataset, ir) {
	const out = new Map();
	for (const b of calcs.beastModes) {
		if ((b.expression?.length ?? 0) * 3 <= LARGE_EXPRESSION_BYTES || Buffer.byteLength(b.expression, 'utf8') <= LARGE_EXPRESSION_BYTES) continue;
		const dsId = dsByDataset.get(b.datasetKey);
		const field = (ir.datasources ?? []).find((d) => d.id === dsId)?.fields?.find((f) => f.id === b.tableauFieldId);
		if (!field) continue;
		if (!out.has(dsId)) out.set(dsId, []);
		out.get(dsId).push(field);
	}
	return out;
}

function contextFilterColumns(ir, ds, fieldMap) {
	const fields = [
		...(ds.filters ?? []).map((f) => f.fieldId),
		...(ir.worksheets ?? []).flatMap((w) => w.filters ?? []).filter((f) => f.context && f.datasourceId === ds.id).map((f) => f.fieldId)
	];
	return [...new Set(fields.map((id) => fieldMap[id]).filter(Boolean))];
}

function uniqueName(base, taken) {
	let name = base;
	for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
	taken.add(name.toLowerCase());
	return name;
}

/**
 * Column expression and types of a unit. An inline LOD keeps its own result type (STR({FIXED ...}) converts it later);
 * a calc materialized whole takes its declared Tableau type, so a string calc over a number is cast.
 */
function conform(translation, unit) {
	if (unit.kind === 'inline') return { expression: translation.expression, domoType: translation.dataType, datatype: translation.dataType };
	const declared = unit.field.datatype;
	if (declared === 'string' && translation.dataType !== 'STRING') {
		return { expression: `CAST(${translation.expression} AS CHAR)`, domoType: 'STRING', datatype: declared };
	}
	// Magic ETL's STR_TO_DATE yields a timestamp, which Domo shifts into the instance time zone, a day early west of UTC.
	if (unit.kind === 'formula' && declared === 'date' && translation.dataType === 'DATE' && !/^DATE\(/.test(translation.expression)) {
		return { expression: `DATE(${translation.expression})`, domoType: 'DATE', datatype: declared };
	}
	return { expression: translation.expression, domoType: translation.dataType, datatype: declared };
}

/**
 * Translate the units of one datasource in dependency order and append their tiles after `sourceId`.
 * @returns {{ actions: Object[], last: string, columns: Map<string, { column: string, domoType: string, datatype: string }>, rejected: Map<string, string>, issues: Issue[] }}
 */
function buildTiles({ units, an, target, rawBoolean, sourceId, gui, usedIds, preset = new Map() }) {
	const actions = [];
	const columns = new Map();
	const known = (id) => columns.get(id) ?? preset.get(id);
	const rejected = new Map();
	const issues = [];
	const taken = new Set((target.schema ?? []).map((c) => c.name.toLowerCase()));
	const schemaTypes = new Map((target.schema ?? []).map((c) => [c.name, c.type]));
	const fieldMap = target.fieldMap ?? {};
	const inlineCount = new Map();
	const actionId = (prefix, label) => {
		const base = `${prefix}-${slugify(label)}`;
		let id = base;
		for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
		usedIds.add(id);
		return id;
	};

	const deps = new Map([...units.values()].map((u) => [u.id, [...an.innerUnits(u).keys(), ...(u.kind === 'formula' ? an.formulaDeps(u, units) : [])]]));
	const order = [];
	const state = new Map();
	const visit = (id) => {
		if (state.get(id) === 'done') return true;
		if (state.get(id) === 'active') return false;
		state.set(id, 'active');
		const ok = (deps.get(id) ?? []).every((d) => preset.has(d) || (units.has(d) && visit(d)));
		state.set(id, 'done');
		if (ok) order.push(units.get(id));
		else rejected.set(id, 'it needs another LOD that cannot be computed in Magic ETL');
		return ok;
	};
	for (const id of units.keys()) visit(id);

	let parameterValues = new Map();
	const resolveField = (id) => {
		const p = an.findParameter(id);
		if (p) return { kind: 'parameter', parameter: parameterValues.has(p.id) ? { ...p, value: parameterValues.get(p.id) } : p };
		const f = an.lookupField(id);
		if (!f) return undefined;
		const done = known(`field:${f.id}`) ?? known(`formula:${f.id}`);
		if (done) return { kind: 'column', column: done.column, datatype: f.datatype, domoType: done.domoType };
		if (f.kind === 'column') {
			const column = fieldMap[f.id];
			if (!column) return undefined;
			return { kind: 'column', column, datatype: f.datatype, domoType: schemaTypes.get(column) ?? tableauToDomoType(f.datatype), ...(rawBoolean ? { rawBoolean: true } : {}), ...(f.datatype === 'string' && collationIgnoresCase(f.collation) ? { ignoreCase: true } : {}) };
		}
		if (CALC_KINDS.has(f.kind)) return { kind: 'calc', field: { ...f, formula: calcFormula(f, an) } };
		return undefined;
	};
	const lodColumn = (node) => {
		const done = known(`lod:${lodKey(node)}`);
		return done ? { column: done.column, datatype: done.datatype, domoType: done.domoType } : undefined;
	};
	const etl = (node, field, aggregate = false) => translateEtl(node, { resolveField, lodColumn, field, options: { parameters: 'inline' } }, { aggregate });
	const failure = (r) => r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');

	let current = sourceId;
	let x = gui.x;
	const helpers = new Map();
	const tile = (action, dy = 0) => {
		if (!dy) x += X_STEP;
		actions.push({ ...action, gui: { x, y: gui.y + dy } });
		return action.id;
	};

	/** Join key columns for dimension nodes: a column itself, or a `_t2d_key_N` formula column added to `newHelpers`. */
	const keyColumns = (dims, field, newHelpers) => {
		const keys = [];
		for (const dim of dims) {
			const d = unwrap(dim);
			const res = d?.type === 'Field' ? resolveField(d.id) : undefined;
			if (res?.kind === 'column') {
				keys.push(res.column);
				continue;
			}
			const r = etl(dim, field);
			if (r.status === 'unsupported') return { bad: failure(r) };
			let helper = helpers.get(r.expression);
			if (!helper) {
				helper = uniqueName(`_t2d_key_${helpers.size + 1}`, taken);
				helpers.set(r.expression, helper);
				newHelpers.push({ fieldName: helper, expression: r.expression });
			}
			keys.push(helper);
		}
		return { keys };
	};

	const grainKey = (u) => JSON.stringify(u.grain.dims.map((d) => lodKey(d.node)).sort());
	const forget = (newHelpers) => {
		for (const h of newHelpers) helpers.delete(h.expression);
	};
	const batched = new Set();
	let valueCount = 0;
	/** Window units at the grain of `first`: one Group By, one Rank & Window tile per partition and order, one join. */
	const buildWindows = (first) => {
		const batch = order.filter((u) => u.kind === 'window' && !batched.has(u.id) && grainKey(u) === grainKey(first) && (u === first || deps.get(u.id).every((d) => known(d))));
		batch.forEach((u) => batched.add(u.id));
		const newHelpers = [];
		const ready = [];
		for (const unit of batch) {
			const spec = unit.window;
			if (spec.reason) {
				rejected.set(unit.id, spec.reason);
				continue;
			}
			const { grain } = unit;
			const { keys, bad: keyBad } = keyColumns(grain.dims.map((d) => d.node), unit.field, newHelpers);
			const value = keyBad || !spec.value ? null : etl(spec.value, unit.field, true);
			let bad = keyBad;
			if (!bad && value?.status === 'unsupported') bad = failure(value);
			if (!bad && value && !value.aggregated) bad = `the value of ${unit.node.name} has no aggregation`;
			if (!bad && spec.ordered && !grain.order.length) bad = `${unit.node.name} needs an order from the compute-using dimensions; none is in the view`;
			if (bad) rejected.set(unit.id, bad);
			else ready.push({ unit, spec, keys, value, keyOf: new Map(grain.dims.map((d, i) => [d.id, keys[i]])) });
		}
		if (!ready.length) {
			forget(newHelpers);
			return;
		}
		const label = first.field.name;
		const values = new Map();
		const valueColumn = (expression) => {
			if (!values.has(expression)) values.set(expression, uniqueName(`_t2d_value_${++valueCount}`, taken));
			return values.get(expression);
		};
		const windows = new Map();
		for (const r of ready) {
			const { unit, spec } = r;
			const column = r.value ? valueColumn(r.value.expression) : undefined;
			const groupRules = unit.grain.partition.map((id) => ({ column: r.keyOf.get(id), caseSensitive: false }));
			const orderRules = spec.orderByValue
				? [{ column, caseSensitive: false, ascending: spec.ascending }]
				: unit.grain.order.map((o) => ({ column: r.keyOf.get(o.id), caseSensitive: false, ascending: o.ascending }));
			const key = JSON.stringify([groupRules, orderRules]);
			if (!windows.has(key)) windows.set(key, { groupRules, orderRules, additions: [], label: unit.field.name, name: unit.node.name });
			r.column = uniqueName(`${unit.field.name} (${unit.node.name})`, taken);
			windows.get(key).additions.push({ name: r.column, operation: 'column' in spec.operation ? { ...spec.operation, column } : spec.operation });
		}
		if (!values.size) valueColumn('COUNT(*)');

		if (newHelpers.length) {
			current = tile({ type: 'ExpressionEvaluator', id: actionId('keys', label), name: `Keys for ${label}`, dependsOn: [current], settings: { ...ETL_SETTINGS }, expressions: newHelpers });
		}
		const { keys } = ready[0];
		const groupId = actionId('grain', label);
		actions.push({
			type: 'GroupBy',
			id: groupId,
			name: `Grain of ${first.grain.worksheet}`,
			dependsOn: [current],
			settings: { ...ETL_SETTINGS },
			addLineNumber: false,
			giveBackRow: false,
			allRows: false,
			groups: keys.map((name) => ({ name })),
			fields: [...values].map(([expression, name]) => ({ name, expression })),
			gui: { x: x + X_STEP, y: gui.y + Y_STEP }
		});
		let step = groupId;
		for (const w of windows.values()) {
			x += X_STEP;
			const id = actionId('window', w.label);
			actions.push({
				type: 'WindowAction',
				id,
				name: `${w.name} for ${w.label}`,
				dependsOn: [step],
				groupRules: w.groupRules,
				orderRules: w.orderRules,
				additions: w.additions,
				gui: { x: x + X_STEP, y: gui.y + Y_STEP }
			});
			step = id;
		}
		x += X_STEP;
		current = tile({
			type: 'MergeJoin',
			id: actionId('join', label),
			name: ready.length > 1 ? `Join grain of ${first.grain.worksheet}` : `Join ${label}`,
			dependsOn: [current, step],
			step1: current,
			step2: step,
			joinType: keys.length ? 'LEFT OUTER' : 'CROSS',
			keys1: keys,
			keys2: keys,
			schemaModification1: [],
			schemaModification2: [...keys, ...values.values()].map((name) => ({ name, rename: name, remove: true }))
		});
		for (const { unit, spec, value, column } of ready) {
			const domoType = spec.resultType === 'AVERAGE' ? 'DOUBLE' : spec.resultType === 'COUNT' ? 'LONG' : (value?.dataType ?? 'DOUBLE');
			columns.set(unit.id, { column, domoType, datatype: TABLEAU_TYPES[domoType] ?? 'real', keys, grain: unit.grain });
			issues.push(...(value?.issues ?? []).filter((i) => i.severity === 'warning'));
		}
	};

	/** Magic ETL predicate for a filter Tableau applies before a Top N rank (datasource or context filter). */
	const firstCondition = (f, field) => {
		const pill = f.pillId ? parsePillId(f.pillId) : undefined;
		if (pill?.datePart || pill?.dateTrunc) return undefined;
		const target = an.lookupField(f.fieldId);
		if (!target || target.kind === 'set' || f.aggregated) return undefined;
		const r = etl(parseFormula(target.id), field);
		if (r.status === 'unsupported') return undefined;
		const expr = r.expression;
		if (f.kind === 'categorical' && !f.ranges?.length) {
			const list = f.include ?? f.exclude ?? [];
			const values = list.filter((v) => v !== null && v !== undefined).map(etlLiteral);
			const hasNull = values.length < list.length;
			const inList = values.length ? `${expr} ${f.include ? 'IN' : 'NOT IN'} (${values.join(', ')})` : undefined;
			if (f.include) return [inList, hasNull ? `${expr} IS NULL` : undefined].filter(Boolean).join(' OR ') || undefined;
			if (hasNull) return [`${expr} IS NOT NULL`, inList].filter(Boolean).join(' AND ');
			return inList && `(${expr} IS NULL OR ${inList})`;
		}
		if (f.includedValues === 'non-null') return `${expr} IS NOT NULL`;
		if (f.includedValues === 'null') return `${expr} IS NULL`;
		const date = f.kind === 'range-date';
		if ((f.kind === 'quantitative' || date) && [f.min, f.max].every((v) => v === undefined || date || Number.isFinite(Number(v)))) {
			const bound = (v) => (date ? etlLiteral(String(v)) : Number(v));
			const terms = [f.min !== undefined && `${expr} >= ${bound(f.min)}`, f.max !== undefined && `${expr} <= ${bound(f.max)}`].filter(Boolean);
			if (!terms.length) return undefined;
			return f.includedValues === 'in-range-or-null' ? `(${terms.join(' AND ')}) OR ${expr} IS NULL` : terms.join(' AND ');
		}
		return undefined;
	};

	/** A Top N member rank: Group By the ranked dimension over the rows its earlier filters keep, Rank & Window, joined back. */
	/** One ranking per member of the one list parameter a set's ranking reads, so the set can pick the rank by the variable. */
	const switchedRanks = (unit, owner) => {
		const params = an.frozenOf(unit).parameterIds.map((id) => an.findParameter(id));
		const [parameter] = params;
		const members = parameter?.members ?? [];
		if (params.length !== 1 || parameter.domain !== 'list' || members.length < 2 || members.length > MAX_SWITCHED_RANKS || members.some((m) => m.value === null || m.value === undefined)) return undefined;
		const variants = [];
		for (const m of members) {
			parameterValues = new Map([[parameter.id, m.value]]);
			const r = etl(unit.node, owner, true);
			parameterValues = new Map();
			if (r.status === 'unsupported' || !r.aggregated) return undefined;
			variants.push({ value: m.value, label: String(m.alias ?? m.value), expression: r.expression, current: m.value === parameter.value });
		}
		return { parameter, variants };
	};

	const buildTop = (unit) => {
		const { top, field } = unit;
		// Not the ranked calc itself as the owner: its own id on the calc stack would read as a circular reference.
		const owner = { name: field.name };
		const key = etl(top.dim.node, { ...owner, datatype: field.datatype });
		const value = key.status === 'unsupported' ? undefined : etl(unit.node, owner, true);
		let bad = key.status === 'unsupported' ? failure(key) : value.status === 'unsupported' ? failure(value) : !value.aggregated ? `the Top N ranking ${top.by} has no aggregation` : '';
		const conditions = [];
		const partitions = [];
		for (const f of top.first) {
			const partition = bad || !top.partition?.includes(f) ? undefined : etl(parseFormula(an.lookupField(f.fieldId)?.id ?? f.fieldId), owner);
			if (partition && partition.status !== 'unsupported') {
				partitions.push(`COALESCE(CAST(${partition.expression} AS CHAR), '${NULL_KEY}')`);
				unit.top.partitioned = [...(unit.top.partitioned ?? []), f.fieldId];
				continue;
			}
			const condition = bad ? undefined : firstCondition(f, owner);
			const name = an.lookupField(f.fieldId)?.name ?? stripBrackets(f.fieldId);
			if (condition) conditions.push(`(${condition})`);
			else if (!bad) issues.push(...top.serves.map((s) => topIssue(s, `Top N on ${field.name}: Tableau applies the ${f.context ? 'context' : 'datasource'} filter on ${name} before ranking; it could not be applied in the Magic ETL rank, which counts every row`)));
			if (condition && f.shownOnDashboard) {
				issues.push(...top.serves.map((s) => topIssue(s, `Top N on ${field.name} is ranked with the current selection of the context filter on ${name}; changing that filter in Domo does not re-rank the members`)));
			}
		}
		if (bad) {
			rejected.set(unit.id, bad);
			return;
		}
		const label = field.name;
		const fresh = [];
		const helperOf = (nullSafe) => {
			if (!helpers.has(nullSafe)) {
				const name = uniqueName(`_t2d_key_${helpers.size + 1}`, taken);
				helpers.set(nullSafe, name);
				fresh.push({ fieldName: name, expression: nullSafe });
			}
			return helpers.get(nullSafe);
		};
		const helper = helperOf(`COALESCE(CAST(${key.expression} AS CHAR), '${NULL_KEY}')`);
		const partitionKeys = partitions.map(helperOf);
		if (fresh.length) current = tile({ type: 'ExpressionEvaluator', id: actionId('keys', label), name: `Keys for ${label}`, dependsOn: [current], settings: { ...ETL_SETTINGS }, expressions: fresh });
		const joinKeys = [helper, ...partitionKeys];
		const direction = top.ascending ? 'bottom' : 'top';
		const switched = top.set ? switchedRanks(unit, owner) : undefined;
		const variants = (switched?.variants ?? [{ expression: value.expression }]).map((v) => ({
			...v,
			valueColumn: uniqueName(`_t2d_value_${++valueCount}`, taken),
			column: uniqueName(top.set ? `${label} (${direction} rank${v.label === undefined ? '' : `, ${switched.parameter.name} ${v.label}`})` : `${label} (${direction} rank by ${stripBrackets(top.by).replace(/[[\]]/g, '')})`, taken)
		}));
		const { column } = variants.find((v) => v.current) ?? variants[0];
		let step = current;
		if (conditions.length) {
			const id = actionId('filter', `${label} rank`);
			actions.push({ type: 'Filter', id, name: `Rows ranked for ${label}`, dependsOn: [current], filterList: [{ expression: conditions.join(' AND '), andFilterList: [] }], gui: { x: x + X_STEP, y: gui.y + Y_STEP } });
			step = id;
			x += X_STEP;
		}
		const groupId = actionId('group', `${label} rank`);
		actions.push({
			type: 'GroupBy',
			id: groupId,
			name: `Members of ${label}`,
			dependsOn: [step],
			settings: { ...ETL_SETTINGS },
			addLineNumber: false,
			giveBackRow: false,
			allRows: false,
			groups: joinKeys.map((name) => ({ name })),
			fields: variants.map((v) => ({ name: v.valueColumn, expression: v.expression })),
			gui: { x: x + X_STEP, y: gui.y + Y_STEP }
		});
		x += X_STEP;
		let windowId = groupId;
		for (const v of variants) {
			const id = actionId('window', `${label} rank${v.label === undefined ? '' : ` ${v.label}`}`);
			actions.push({
				type: 'WindowAction',
				id,
				name: `Rank ${label} by ${stripBrackets(top.by).replace(/[[\]]/g, '')}${v.label === undefined ? '' : ` (${switched.parameter.name} ${v.label})`}`,
				dependsOn: [windowId],
				groupRules: partitionKeys.map((column) => ({ column, caseSensitive: false })),
				orderRules: [{ column: v.valueColumn, caseSensitive: false, ascending: top.ascending }],
				additions: [{ name: v.column, operation: { type: 'RANKING', operationType: 'RANK' } }],
				gui: { x: x + X_STEP, y: gui.y + Y_STEP }
			});
			windowId = id;
			x += X_STEP;
		}
		current = tile({
			type: 'MergeJoin',
			id: actionId('join', `${label} rank`),
			name: `Join ${column}`,
			dependsOn: [current, windowId],
			step1: current,
			step2: windowId,
			joinType: 'LEFT OUTER',
			keys1: joinKeys,
			keys2: joinKeys,
			schemaModification1: [],
			schemaModification2: [...joinKeys, ...variants.map((v) => v.valueColumn)].map((name) => ({ name, rename: name, remove: true }))
		});
		const byValue = switched ? { parameter: switched.parameter, ranks: variants.map((v) => ({ value: v.value, column: v.column })) } : undefined;
		columns.set(unit.id, { column, domoType: 'LONG', datatype: 'integer', keys: joinKeys, nullSafe: true, ...(byValue ? { byValue } : {}) });
		issues.push(...[...key.issues, ...value.issues].filter((i) => i.severity === 'warning'));
	};

	let formulaTile = null;
	for (const unit of order) {
		const label = unit.field.name;
		if (unit.kind === 'window') {
			if (!batched.has(unit.id)) buildWindows(unit);
			continue;
		}
		if (unit.kind === 'top') {
			buildTop(unit);
			continue;
		}
		if (unit.kind === 'formula') {
			const r = etl(unit.node, unit.field);
			if (r.status === 'unsupported') {
				rejected.set(unit.id, failure(r));
				continue;
			}
			const column = uniqueName(unit.field.name, taken);
			const value = conform(r, unit);
			const expression = { fieldName: column, expression: value.expression };
			const open = formulaTile?.id === current && !deps.get(unit.id).some((d) => formulaTile.units.has(d));
			if (open) {
				formulaTile.action.expressions.push(expression);
				formulaTile.action.name = `Calcs (${formulaTile.action.expressions.length})`;
				formulaTile.units.add(unit.id);
			} else {
				const action = { type: 'ExpressionEvaluator', id: actionId('calc', label), name: `Calc ${label}`, dependsOn: [current], settings: { ...ETL_SETTINGS }, expressions: [expression] };
				current = tile(action);
				formulaTile = { id: current, action: actions.at(-1), units: new Set([unit.id]) };
			}
			columns.set(unit.id, { column, domoType: value.domoType, datatype: value.datatype });
			issues.push(...r.issues.filter((i) => i.severity === 'warning'));
			continue;
		}
		const lod = unit.node;
		if (lod.lodType === 'INCLUDE' || lod.lodType === 'EXCLUDE') {
			rejected.set(unit.id, `${lod.lodType} depends on the dimensions of each view; only FIXED can be computed in Magic ETL`);
			continue;
		}
		const newHelpers = [];
		const { keys, bad: keyBad } = keyColumns(lod.dims, unit.field, newHelpers);
		let bad = keyBad ?? '';
		const body = bad ? null : etl(lod.body, unit.field, true);
		if (!bad && body.status === 'unsupported') bad = failure(body);
		if (!bad && !body.aggregated) bad = 'the LOD body has no aggregation';
		if (bad) {
			forget(newHelpers);
			rejected.set(unit.id, bad);
			continue;
		}
		if (newHelpers.length) {
			current = tile({ type: 'ExpressionEvaluator', id: actionId('keys', label), name: `Keys for ${label}`, dependsOn: [current], settings: { ...ETL_SETTINGS }, expressions: newHelpers });
		}
		let column;
		if (unit.kind === 'field') column = uniqueName(unit.field.name, taken);
		else {
			const n = (inlineCount.get(unit.field.id) ?? 0) + 1;
			inlineCount.set(unit.field.id, n);
			column = uniqueName(`${unit.field.name} (LOD${n > 1 ? ` ${n}` : ''})`, taken);
		}
		const value = conform(body, unit);
		const groupId = actionId('group', label);
		actions.push({
			type: 'GroupBy',
			id: groupId,
			name: `Group ${label}`,
			dependsOn: [current],
			settings: { ...ETL_SETTINGS },
			addLineNumber: false,
			giveBackRow: false,
			allRows: false,
			groups: keys.map((name) => ({ name })),
			fields: [{ name: column, expression: value.expression }],
			gui: { x: x + X_STEP, y: gui.y + Y_STEP }
		});
		current = tile({
			type: 'MergeJoin',
			id: actionId('join', label),
			name: `Join ${label}`,
			dependsOn: [current, groupId],
			step1: current,
			step2: groupId,
			joinType: keys.length ? 'LEFT OUTER' : 'CROSS',
			keys1: keys,
			keys2: keys,
			schemaModification1: [],
			schemaModification2: keys.map((name) => ({ name, rename: name, remove: true }))
		});
		x += X_STEP;
		columns.set(unit.id, { column, domoType: value.domoType, datatype: value.datatype, keys });
		issues.push(...body.issues.filter((i) => i.severity === 'warning'));
	}
	if (helpers.size) {
		current = tile({ type: 'Metadata', id: actionId('drop', 'keys'), name: 'Drop key columns', dependsOn: [current], fields: [...helpers.values()].map((name) => ({ name, remove: true })) });
	}
	return { actions, last: current, columns, rejected, issues, x };
}

/**
 * Apply the units of every datasource to a copy of the planned datasets and dataflows.
 * @returns {{ ir: WorkbookIR, datasets: DatasetPlan[], dataflows: DataflowPlan[], lodColumns: Map<string, Function>, tableCalcColumns: Map<string, Function>, issues: Issue[], rejected: Map<string, Map<string, string>> }}
 */
function applyUnits(ir, data, unitsByDs, analyzers, { workbookKey, options }) {
	const datasets = structuredClone(data.datasets);
	const dataflows = structuredClone(data.dataflows);
	const issues = [];
	const lodColumns = new Map();
	const tableCalcColumns = new Map();
	const rankColumns = new Map();
	const setRanks = new Map();
	const rejected = new Map();
	const columnFields = new Map();
	const prefix = options.namePrefix ?? '';

	// Columns a primary's own dataflow adds to the dataset its blend datasources load.
	const inherited = new Map();
	for (const ds of ir.datasources ?? []) {
		const all = unitsByDs.get(ds.id);
		if (!all?.size) continue;
		const an = analyzers.get(ds.id);
		const target = datasets.find((d) => d.cardTarget && d.datasourceId === ds.id);
		if (!target) continue;
		const caption = ds.caption || ds.id;
		const rawBoolean = target.strategy !== 'upload';
		const inFlow = target.strategy === 'dataflow-output' && !target.shared ? dataflows.find((df) => df.key === target.dataflowOutput?.dataflowKey) : undefined;

		const fromPrimary = ds.blend ? inherited.get(ds.blend.primary) : undefined;
		const preset = new Map([...all].filter(([id, u]) => u.kind !== 'window' && u.kind !== 'top' && fromPrimary?.has(id)).map(([id]) => [id, fromPrimary.get(id)]));
		const units = preset.size ? new Map([...all].filter(([id]) => !preset.has(id))) : all;
		const fieldColumns = new Map();
		const inline = new Map();
		const windows = new Map();
		for (const [id, col] of preset) {
			const unit = all.get(id);
			if (!target.schema.some((c) => c.name.toLowerCase() === col.column.toLowerCase())) target.schema.push({ name: col.column, type: col.domoType });
			if (unit.kind === 'inline') inline.set(lodKey(unit.node), col);
			else {
				target.fieldMap[unit.field.id] = col.column;
				fieldColumns.set(unit.field.id, col.column);
			}
		}
		const publishColumns = () => {
			columnFields.set(ds.id, fieldColumns);
			if (inline.size) lodColumns.set(ds.id, (node) => {
				const col = inline.get(lodKey(node));
				return col ? { column: col.column, datatype: col.datatype, domoType: col.domoType } : undefined;
			});
			if (windows.size) tableCalcColumns.set(ds.id, (fieldId, node) => {
				const col = windows.get(`${fieldId}\u0000${lodKey(node)}`);
				return col ? { column: col.column, datatype: col.datatype } : undefined;
			});
		};
		if (!units.size) {
			publishColumns();
			continue;
		}

		let flow;
		let output;
		let publish;
		let source;
		const usedIds = new Set();
		if (inFlow) {
			flow = inFlow;
			flow.definition.actions.forEach((a) => usedIds.add(a.id));
			publish = flow.definition.actions.find((a) => a.type === 'PublishToVault' && a.name === target.dataflowOutput.outputName) ?? flow.definition.actions.find((a) => a.type === 'PublishToVault');
			const root = flow.definition.actions.find((a) => a.id === publish.dependsOn[0]);
			source = { id: root.id, gui: { x: root.gui?.x ?? 50, y: root.gui?.y ?? 50 } };
			output = target;
		} else {
			const key = target.shared ? `${workbookKey}.${slugify(caption)}.etl` : `${target.key}.etl`;
			const outputName = `${target.shared ? `${prefix}${caption}` : target.name} (Magic ETL calcs)`;
			const description = `Tableau calculations Beast Mode cannot express, computed by Magic ETL over '${target.name}'.`;
			const load = {
				type: 'LoadFromVault',
				id: 'in-source',
				name: target.name,
				dataSourceId: ref('dataset', target.key),
				executeFlowWhenUpdated: refreshesOnUpdate(target),
				onlyLoadNewVersions: false,
				truncateTextColumns: false,
				truncateRows: false,
				gui: { x: 50, y: 50 }
			};
			usedIds.add(load.id);
			publish = { type: 'PublishToVault', id: 'out-output', name: outputName, dependsOn: [load.id], dataSource: { guid: '', name: outputName, description }, versionChainType: 'REPLACE', gui: { x: 270, y: 50 } };
			usedIds.add(publish.id);
			flow = {
				key,
				name: `${prefix}${caption} (Tableau calcs)`,
				definition: { name: `${prefix}${caption} (Tableau calcs)`, description, databaseType: 'MAGIC', runState: 'ENABLED', engineProperties: { 'kettle.mode': 'STRICT' }, gui: {}, actions: [load, publish] },
				outputDatasetKeys: [key],
				runAfterCreate: true
			};
			output = {
				key,
				name: outputName,
				description,
				strategy: 'dataflow-output',
				sourceStrategy: target.sourceStrategy ?? target.strategy,
				schema: (target.schema ?? []).map((c) => ({ ...c })),
				dataflowOutput: { dataflowKey: key, outputName },
				datasourceId: ds.id,
				cardTarget: true,
				fieldMap: { ...target.fieldMap }
			};
			source = { id: load.id, gui: load.gui };
		}

		const built = buildTiles({ units, an, target: output, rawBoolean, sourceId: source.id, gui: source.gui, usedIds, preset });
		rejected.set(ds.id, built.rejected);
		issues.push(...built.issues);
		if (!built.columns.size) {
			publishColumns();
			continue;
		}
		if (inFlow) inherited.set(ds.id, new Map([...built.columns].filter(([id]) => units.get(id)?.kind !== 'window' && units.get(id)?.kind !== 'top')));

		const actions = flow.definition.actions.filter((a) => a !== publish);
		actions.push(...built.actions, { ...publish, dependsOn: [built.last], gui: { x: built.x + X_STEP, y: source.gui.y } });
		flow.definition.actions = actions;
		if (!inFlow) {
			target.cardTarget = false;
			datasets.push(output);
			dataflows.push(flow);
			issues.push(
				issue(
					'info',
					'calc.materialized-dataflow',
					`Cards and beast modes of datasource '${caption}' use '${output.name}', the output of Magic ETL dataflow '${flow.name}' that adds ${built.columns.size} computed column(s) to '${target.name}'.${target.shared ? ' The published datasource dataset stays shared; the computed columns are specific to this workbook.' : ''}`
				)
			);
		}

		for (const [id, col] of built.columns) {
			const unit = units.get(id);
			output.schema.push({ name: col.column, type: col.domoType });
			for (const r of col.byValue?.ranks ?? []) if (r.column !== col.column) output.schema.push({ name: r.column, type: col.domoType });
			if (unit.kind === 'top' && unit.top.set) {
				setRanks.set(`${ds.id}\u0000${unit.field.id}`, col);
				issues.push(...setRankIssues(unit, col, flow.name, an));
			} else if (unit.kind === 'top') {
				for (const served of unit.top.serves) rankColumns.set(`${served.worksheet}\u0000${served.index}`, col.column);
				const sheets = unit.top.serves.map((x) => `'${x.worksheet}'`).join(', ');
				issues.push(issue('info', 'calc.materialized', `Top N on '${unit.field.name}' (${sheets}) is ranked by Magic ETL dataflow '${flow.name}' as column '${col.column}' (a Group By on ${unit.field.name}${unit.top.first.length ? ' over the rows its datasource and context filters keep' : ''}, a Rank & Window tile, joined back to every row); the cards keep the members ranked at most N.`, unit.field));
			} else if (unit.kind === 'window') {
				for (const fieldId of unit.serves.keys()) windows.set(`${fieldId}\u0000${lodKey(unit.node)}`, col);
				issues.push(...grainIssues(unit, col, an, flow.name));
			} else {
				if (unit.kind === 'inline') inline.set(lodKey(unit.node), col);
				else {
					output.fieldMap[unit.field.id] = col.column;
					fieldColumns.set(unit.field.id, col.column);
				}
				const how =
					unit.kind === 'formula'
						? 'a formula tile'
						: `a Group By on ${col.keys.length ? col.keys.join(', ') : 'all rows'} joined back to every row`;
				issues.push(issue('info', 'calc.materialized', `'${unit.field.name}'${unit.kind === 'inline' ? ' (an LOD inside it)' : ''} is computed as column '${col.column}' by Magic ETL dataflow '${flow.name}' (${how}).`, unit.field));
			}
			const frozen = an.frozenOf(unit);
			const { volatile } = frozen;
			const params = frozen.parameters.filter((name) => name !== col.byValue?.parameter.name);
			if (volatile.length) {
				issues.push(
					issue(
						'warning',
						'calc.materialized-today',
						`'${unit.field.name}' is computed in Magic ETL with ${volatile.join(' and ')}, which hold the time of the dataflow's last run, not the time a card is viewed.`,
						unit.field,
						'Schedule the dataflow to run daily, or keep the date logic in a beast mode.'
					)
				);
			}
			if (params.length) {
				issues.push(
					issue(
						'warning',
						'calc.materialized-parameter',
						`'${unit.field.name}' is computed in Magic ETL with parameter(s) ${params.join(', ')} at their current value; changing them in Domo does not recompute the column.`,
						unit.field,
						'Rerun convert with other parameter values, or edit the formula in the dataflow.'
					)
				);
			}
		}
		const filters = contextFilterColumns(ir, ds, output.fieldMap);
		if (filters.length && [...built.columns.keys()].some((id) => id.startsWith('field:') || id.startsWith('lod:'))) {
			issues.push(
				issue(
					'warning',
					'calc.materialized-filters',
					`Tableau applies datasource and context filters (${filters.join(', ')}) before FIXED; the LOD columns Magic ETL computes for '${caption}' cover every row.`,
					undefined,
					'Add a Filter tile before the Group By tiles in the dataflow if the filters are fixed.'
				)
			);
		}
		const nullKeys = [...built.columns.values()].filter((c) => c.keys?.length && !c.nullSafe);
		if (nullKeys.length) {
			const what = [nullKeys.some((c) => !c.grain) && 'FIXED dimensions', nullKeys.some((c) => c.grain) && 'view dimensions of a precomputed inner table calc'].filter(Boolean).join(' or ');
			issues.push(issue('info', 'calc.materialized-null-keys', `Rows of '${caption}' whose ${what} are null get a null computed column from the Magic ETL join, where Tableau groups nulls together.`));
		}
		publishColumns();
	}

	const nextIr = {
		...ir,
		datasources: (ir.datasources ?? []).map((ds) => {
			const cols = columnFields.get(ds.id);
			const rankOf = (f) => setRanks.get(`${ds.id}\u0000${f.id}`);
			if (!cols?.size && !(ds.fields ?? []).some(rankOf)) return ds;
			return {
				...ds,
				fields: ds.fields.map((f) => {
					if (cols?.has(f.id)) return { ...f, kind: 'column' };
					return rankOf(f) ? { ...f, set: { ...f.set, top: { ...f.set.top, rankColumn: rankOf(f).column, ...(rankOf(f).byValue ? { rankColumns: { parameter: rankOf(f).byValue.parameter.id, ranks: rankOf(f).byValue.ranks } } : {}) } } } : f;
				})
			};
		}),
		worksheets: (ir.worksheets ?? []).map((ws) => {
			if (!(ws.filters ?? []).some((_, i) => rankColumns.has(`${ws.name}\u0000${i}`))) return ws;
			return { ...ws, filters: ws.filters.map((f, i) => (rankColumns.has(`${ws.name}\u0000${i}`) ? { ...f, top: { ...f.top, rankColumn: rankColumns.get(`${ws.name}\u0000${i}`) } } : f)) };
		})
	};
	return { ir: nextIr, datasets, dataflows, lodColumns, tableCalcColumns, issues, rejected };
}

/**
 * Issues of an inner table calc computed at a worksheet grain: the column, the grain it is only correct at, and
 * every worksheet that shows a calc reading it with other dimensions.
 */
function grainIssues(unit, col, an, flowName) {
	const { grain } = unit;
	const labels = grain.dims.map((d) => d.label).join(', ') || 'no dimensions';
	const grainKeys = JSON.stringify(grain.dims.map((d) => lodKey(d.node)).sort());
	const out = [];
	for (const field of unit.serves.values()) {
		out.push(
			issue(
				'info',
				'calc.materialized',
				`The ${unit.node.name} inside '${field.name}' is computed as column '${col.column}' by Magic ETL dataflow '${flowName}' (a Group By on ${col.keys.join(', ') || 'all rows'}, a Rank & Window tile, joined back to every row); the Beast Mode reads it as MAX(\`${col.column}\`).`,
				field
			)
		);
		out.push(
			issue(
				'warning',
				'calc.table-calc-grain',
				`'${field.name}' uses its inner ${unit.node.name} precomputed at the grain of worksheet '${grain.worksheet}' (${labels}); it matches Tableau only on cards with exactly those dimensions${grain.filtered ? ', and Tableau computes it after the worksheet and datasource filters while Magic ETL uses every row' : ''}.`,
				field,
				'Keep the dimensions of cards that use it, or change the Group By and Rank & Window tiles in the dataflow.'
			)
		);
		const seen = new Set();
		for (const { ws, pillId } of an.pillsShowing(field)) {
			if (seen.has(ws.name) || ws.name === grain.worksheet) continue;
			seen.add(ws.name);
			const dims = an.viewDimensions(ws, pillId);
			if (dims.every(Boolean) && JSON.stringify(dims.map((d) => lodKey(d.node)).sort()) === grainKeys) {
				if ((ws.filters ?? []).length) {
					out.push({
						severity: 'warning',
						code: 'calc.table-calc-grain',
						message: `'${field.name}' on this card is computed from its inner ${unit.node.name} precomputed over every row at the grain of worksheet '${grain.worksheet}'; Tableau computes it after this card's filters, so its values can differ.`,
						object: { type: 'worksheet', name: ws.name }
					});
				}
				continue;
			}
			out.push({
				severity: 'warning',
				code: 'calc.table-calc-grain',
				message: `'${field.name}' on this card is computed from its inner ${unit.node.name} at the grain of worksheet '${grain.worksheet}' (${labels}), but this card shows ${dims.filter(Boolean).map((d) => d.label).join(', ') || 'no dimensions'}; its values differ from Tableau.`,
				object: { type: 'worksheet', name: ws.name }
			});
		}
	}
	return out;
}

/**
 * Rank units per datasource for the Top N filters a card row limit gets wrong; sheets sharing a spec share one.
 * @returns {Map<string, Map<string, Unit>>}
 */
function topRankUnits(ir, analyzers) {
	const out = new Map();
	for (const ws of ir.worksheets ?? []) {
		(ws.filters ?? []).forEach((filter, index) => {
			if (filter.kind !== 'top' || !filter.top?.by || !topRankReason(ws, filter, ir.actions)) return;
			const dsId = filter.datasourceId || ws.datasourceIds?.[0];
			const an = analyzers.get(dsId);
			const ds = (ir.datasources ?? []).find((d) => d.id === dsId);
			const field = an?.lookupField(filter.fieldId);
			if (!field) return;
			let node;
			try {
				node = parseFormula(filter.top.by);
			} catch {
				return;
			}
			const dim = an.dimNode(ws.pills?.[filter.pillId] ?? { fieldId: filter.fieldId });
			if (!dim) return;
			const first = [...(ds?.filters ?? []), ...(ws.filters ?? []).filter((f) => f.context)].filter((f) => f !== filter && !f.all && f.kind !== 'top');
			const ascending = filter.top.direction === 'bottom';
			const spec = JSON.stringify([lodKey(dim.node), lodKey(node), ascending, first.map((f) => [f.fieldId, f.pillId, f.kind, f.include, f.exclude, f.min, f.max, f.ranges])]);
			const id = `top:${spec}`;
			const units = out.get(dsId) ?? new Map();
			out.set(dsId, units);
			const served = { worksheet: ws.name, index };
			if (units.has(id)) units.get(id).top.serves.push(served);
			else units.set(id, { id, kind: 'top', field, node, top: { dim, ascending, by: filter.top.by, first, serves: [served] } });
		});
	}
	for (const ds of ir.datasources ?? []) {
		const an = analyzers.get(ds.id);
		for (const field of ds.fields ?? []) {
			const unit = an && setRankUnit(ir, ds, an, field);
			if (!unit) continue;
			const units = out.get(ds.id) ?? new Map();
			out.set(ds.id, units);
			units.set(unit.id, unit);
		}
	}
	return out;
}

const filterSpec = (f) => JSON.stringify([f.fieldId, f.pillId, f.kind, f.include, f.exclude, f.min, f.max, f.ranges, f.includedValues]);

/** A top N set's source ranked after datasource and shared context filters, before other filters, as Tableau computes a set. */
function setRankUnit(ir, ds, an, field) {
	const top = field.kind === 'set' ? field.set?.top : undefined;
	if (!top?.by || field.set.unparsed || field.set.condition) return undefined;
	let node;
	try {
		node = parseFormula(top.by);
	} catch {
		return undefined;
	}
	const dim = an.dimNode({ fieldId: field.set.source });
	if (!dim) return undefined;
	const usesSet = (ws) => (ws.filters ?? []).some((f) => an.lookupField(f.fieldId)?.id === field.id) || Object.values(ws.pills ?? {}).some((p) => p.datasourceId === ds.id && an.lookupField(p.fieldId)?.id === field.id);
	const sheets = (ir.worksheets ?? []).filter(usesSet);
	if (!sheets.length && !(ds.fields ?? []).some((f) => f.formula?.includes(field.id))) return undefined;
	const contextOf = (ws) => (ws.filters ?? []).filter((f) => f.context && f.kind !== 'top' && an.lookupField(f.fieldId)?.id !== field.id);
	const selected = sheets.map((ws) => new Map(contextOf(ws).filter((f) => !f.all).map((f) => [filterSpec(f), f])));
	const common = selected.length ? [...selected[0]].filter(([k]) => selected.every((m) => m.has(k))).map(([, f]) => f) : [];
	const differing = [...new Set(selected.flatMap((m) => [...m].filter(([k]) => !selected.every((o) => o.has(k))).map(([, f]) => f.fieldId)))];
	const shown = [...new Set(sheets.flatMap((ws) => contextOf(ws).filter((f) => f.shownOnDashboard).map((f) => f.fieldId)))];
	const first = [...(ds.filters ?? []).filter((f) => !f.all && f.kind !== 'top'), ...common];
	const ascending = top.direction === 'bottom';
	const id = `set-top:${field.id}`;
	const partition = common.filter((f) => f.shownOnDashboard && f.kind === 'categorical' && f.include?.length === 1 && !f.ranges?.length);
	return { id, kind: 'top', field, node, top: { dim, ascending, by: top.by, first, partition, serves: [], set: { sheets: sheets.map((ws) => ws.name), differing, shown } } };
}

/**
 * Plan beast modes, moving the calcs Beast Mode cannot express into Magic ETL (unless `options.materialize` is
 * false). Rounds repeat until no new LOD has to be computed: a wrapped nested LOD first materializes its inner
 * LOD, and the outer one is materialized in a later round only when it then fails as a dimension.
 *
 * @param {WorkbookIR} ir
 * @param {{ datasets: DatasetPlan[], dataflows: DataflowPlan[] }} data  planDatasets result
 * @param {{ options?: import('../model/types.js').ConvertOptions, workbookKey: string, shared?: import('./beastmodes.js').SharedBeastModeContext }} opts
 * @returns {{ ir: WorkbookIR, datasets: DatasetPlan[], dataflows: DataflowPlan[], calcs: ReturnType<typeof planBeastModes>, issues: Issue[] }}
 */
/** A federated DataSet, or a DataSet View over federated DataSets: Magic ETL cannot read either. */
export function isFederatedDataset(d) {
	return d?.strategy === 'federated' || d?.sourceStrategy === 'federated';
}

export function materializeCalcs(ir, data, { options = {}, workbookKey, shared } = {}) {
	let calcs = planBeastModes(ir, data.datasets, { options, workbookKey, shared });
	const unchanged = { ir, datasets: data.datasets, dataflows: data.dataflows, calcs, issues: [] };
	if (options.materialize === false) return unchanged;

	const federatedDs = new Set(data.datasets.filter((d) => d.cardTarget && d.datasourceId && isFederatedDataset(d)).map((d) => d.datasourceId));
	const dsByDataset = new Map(data.datasets.filter((d) => d.cardTarget && d.datasourceId && !federatedDs.has(d.datasourceId)).map((d) => [d.key, d.datasourceId]));
	const analyzers = new Map((ir.datasources ?? []).map((ds) => [ds.id, analyzer(ir, ds)]));
	const unitsByDs = new Map();
	const rejectedByDs = new Map();
	const sizedByDs = new Map();
	let applied = null;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		let added = false;
		if (round === 0) {
			for (const [dsId, tops] of topRankUnits(ir, analyzers)) {
				if (federatedDs.has(dsId)) continue;
				const units = unitsByDs.get(dsId) ?? new Map();
				unitsByDs.set(dsId, units);
				const an = analyzers.get(dsId);
				const wanted = new Map();
				an.closure(tops, wanted);
				for (const [id, u] of wanted) if (!units.has(id)) units.set(id, u);
				added = true;
			}
			for (const ds of ir.datasources ?? []) {
				if (federatedDs.has(ds.id)) continue;
				const an = analyzers.get(ds.id);
				for (const field of (ds.fields ?? []).filter((f) => f.periodDate)) {
					const units = unitsByDs.get(ds.id) ?? new Map();
					unitsByDs.set(ds.id, units);
					units.set(`formula:${field.id}`, { id: `formula:${field.id}`, kind: 'formula', field, node: an.astOf(field) });
					added = true;
				}
			}
		}
		for (const failing of failingCalcs(calcs)) {
			const dsId = dsByDataset.get(failing.datasetKey);
			const ds = (ir.datasources ?? []).find((d) => d.id === dsId);
			const field = ds?.fields?.find((f) => f.id === failing.fieldId);
			if (!field) continue;
			const an = analyzers.get(dsId);
			const units = unitsByDs.get(dsId) ?? new Map();
			unitsByDs.set(dsId, units);
			const skip = rejectedByDs.get(dsId) ?? new Map();
			rejectedByDs.set(dsId, skip);
			const wanted = new Map();
			if (failing.codes.has('calc.lod-dimension')) an.closure(an.unitsOfField(field), wanted);
			else if (failing.codes.has('calc.lod-nested-wrapped')) {
				for (const top of an.unitsOfField(field).values()) an.closure(an.innerUnits(top), wanted);
			}
			if (failing.codes.has('calc.no-equivalent')) for (const [id, u] of an.formulaUnits(field)) wanted.set(id, u);
			if (failing.codes.has('calc.table-calc-nested')) an.closure(an.windowUnits(field), wanted);
			for (const [id, u] of wanted) {
				const known = units.get(id);
				if (known?.serves && !known.serves.has(field.id)) {
					known.serves.set(field.id, field);
					added = true;
				}
				if (known || skip.has(id)) continue;
				units.set(id, u);
				added = true;
			}
		}
		for (const [dsId, roots] of oversizeCalcs(calcs, dsByDataset, ir)) {
			if (federatedDs.has(dsId)) continue;
			const an = analyzers.get(dsId);
			const units = unitsByDs.get(dsId) ?? new Map();
			unitsByDs.set(dsId, units);
			const skip = rejectedByDs.get(dsId) ?? new Map();
			rejectedByDs.set(dsId, skip);
			const target = (applied?.datasets ?? data.datasets).find((d) => d.cardTarget && d.datasourceId === dsId);
			const { chosen } = sharedRowCalcs({
				roots,
				astOf: an.astOf,
				calcField: an.calcField,
				lookupField: an.lookupField,
				findParameter: an.findParameter,
				fieldMap: target?.fieldMap,
				options,
				isColumn: (f) => units.has(`field:${f.id}`) || units.has(`formula:${f.id}`),
				isBlocked: (f) => skip.has(`formula:${f.id}`)
			});
			const sized = sizedByDs.get(dsId) ?? new Set();
			sizedByDs.set(dsId, sized);
			for (const field of chosen) {
				const id = `formula:${field.id}`;
				units.set(id, { id, kind: 'formula', field, node: an.astOf(field) });
				sized.add(id);
				added = true;
			}
		}
		if (!added) break;
		applied = applyUnits(ir, data, unitsByDs, analyzers, { workbookKey, options });
		for (const [dsId, reasons] of applied.rejected) {
			for (const [id, reason] of reasons) {
				const unit = unitsByDs.get(dsId)?.get(id);
				unitsByDs.get(dsId)?.delete(id);
				if (unit) rejectedByDs.get(dsId)?.set(id, { unit, reason });
			}
		}
		calcs = planBeastModes(applied.ir, applied.datasets, { options, workbookKey, shared, lodColumns: applied.lodColumns, tableCalcColumns: applied.tableCalcColumns });
		dsByDataset.clear();
		for (const d of applied.datasets) if (d.cardTarget && d.datasourceId && !federatedDs.has(d.datasourceId)) dsByDataset.set(d.key, d.datasourceId);
	}
	const federatedIssues = federatedCalcIssues(calcs, data.datasets, federatedDs, ir);
	if (!applied) return { ...unchanged, calcs, issues: federatedIssues };
	const skipped = [...rejectedByDs.values()].flatMap((m) => [...m.values()]).map(({ unit, reason }) =>
		issue('warning', 'calc.materialize-skipped', `'${unit.field.name}' could not be computed in Magic ETL: ${reason}.`, unit.field)
	);
	const sizedIssues = [...sizedByDs].flatMap(([dsId, ids]) => {
		const kept = [...ids].filter((id) => unitsByDs.get(dsId)?.has(id));
		if (!kept.length) return [];
		const caption = (ir.datasources ?? []).find((d) => d.id === dsId)?.caption || dsId;
		return [
			issue(
				'info',
				'calc.materialized-size',
				`${kept.length} row-level calc(s) of '${caption}' are computed once as Magic ETL columns because inlining them made beast modes over ${LARGE_EXPRESSION_BYTES} bytes; the beast modes read the columns.`
			)
		];
	});
	return { ir: applied.ir, datasets: applied.datasets, dataflows: applied.dataflows, calcs, issues: [...applied.issues, ...sizedIssues, ...skipped, ...federatedIssues] };
}

function federatedCalcIssues(calcs, datasets, federatedDs, ir) {
	if (!federatedDs.size) return [];
	const keys = new Map(datasets.filter((d) => d.cardTarget && federatedDs.has(d.datasourceId)).map((d) => [d.key, d.datasourceId]));
	const byDs = new Map();
	for (const f of failingCalcs(calcs)) {
		const dsId = keys.get(f.datasetKey);
		if (!dsId) continue;
		const field = (ir.datasources ?? []).find((d) => d.id === dsId)?.fields?.find((x) => x.id === f.fieldId);
		byDs.set(dsId, [...(byDs.get(dsId) ?? []), field?.name ?? f.fieldId]);
	}
	return [...byDs].map(([dsId, names]) => {
		const caption = (ir.datasources ?? []).find((d) => d.id === dsId)?.caption || dsId;
		return issue('warning', 'data.federated-etl', `${names.length} calc(s) of '${caption}' would be computed in Magic ETL, which cannot read federated DataSets, so they stay Beast Modes that fail: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', ...' : ''}.`);
	});
}
