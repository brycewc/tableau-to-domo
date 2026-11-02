import { ref } from '../util/refs.js';
import { shortHash, slugify } from '../util/ids.js';
import { domoColumnName, stripBrackets } from '../model/naming.js';
import { parsePillId, TABLE_CALC_PREFIXES } from '../tableau/twb/shelf.js';
import { analyzeFormula, parseFormula, tokenize, translateEtl } from './calc/index.js';
import { collationIgnoresCase } from './calc/sql.js';
import { calcFormula, fieldLookup, parameterLookup } from './beastmodes.js';
import { tableauToDomoType } from './schema.js';
import { refreshesOnUpdate } from './etl.js';

/**
 * Tableau data blends as Magic ETL joins. A worksheet that blends secondary datasources into its primary moves onto a
 * blend datasource: the primary's fields plus one column per secondary value the worksheets use, computed by a dataflow
 * that aggregates each secondary to its link fields and left-joins it onto the primary rows. Worksheets with the same
 * primary, secondaries and links share one blend datasource and dataflow. A secondary used only through filters on its
 * link fields needs no join: those filters move onto the linked primary field.
 *
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 * @typedef {import('../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../model/types.js').FieldIR} FieldIR
 * @typedef {import('../model/types.js').DatasetPlan} DatasetPlan
 * @typedef {import('../model/types.js').DataflowPlan} DataflowPlan
 * @typedef {import('../model/types.js').Issue} Issue
 *
 * @typedef {{ primary: string, secondary: string, datePart?: string }} Link
 */

const CALC_KINDS = new Set(['calculated', 'bin', 'group', 'set']);
const AGGREGATES = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'MEDIAN', 'ATTR', 'STDEV', 'STDEVP', 'VAR', 'VARP']);
// How Tableau combines per-link values when a link field is not in the view.
const REAGGREGATE = { SUM: 'SUM', COUNT: 'SUM', COUNTD: 'SUM', AVG: 'AVG', MIN: 'MIN', MAX: 'MAX', MEDIAN: 'MEDIAN' };
const PILL_AGGREGATES = { sum: 'SUM', avg: 'AVG', cnt: 'COUNT', ctd: 'COUNTD', min: 'MIN', max: 'MAX', med: 'MEDIAN', stdev: 'STDEV', stdevp: 'STDEVP', var: 'VAR', varp: 'VARP' };
const TABLEAU_TYPES = { LONG: 'integer', DOUBLE: 'real', DECIMAL: 'real', STRING: 'string', DATE: 'date', DATETIME: 'datetime' };
const ETL_SETTINGS = { zoneId: 'UTC' };
const X_STEP = 220;
const Y_STEP = 120;

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

function fieldNodes(node, out = []) {
	if (!node) return out;
	if (node.type === 'Field') out.push(node);
	for (const c of children(node)) fieldNodes(c, out);
	return out;
}

function parseSafe(formula) {
	try {
		return parseFormula(formula);
	} catch {
		return null;
	}
}

const pillDatePart = (pill) => (pill.datePart === 'mdy' ? 'trunc:day' : (pill.datePart ?? (pill.dateTrunc ? `trunc:${pill.dateTrunc}` : undefined)));

/** Pill ids on the shelves and marks (and Measure Values members). */
function shownPillIds(ws) {
	const ids = new Set([...(ws.rowPills ?? []), ...(ws.colPills ?? []), ...(ws.measureValues ?? [])]);
	for (const pane of ws.panes ?? []) {
		for (const list of Object.values(pane.encodings ?? {})) for (const id of list ?? []) ids.add(id);
		if (pane.xAxisPill) ids.add(pane.xAxisPill);
		if (pane.yAxisPill) ids.add(pane.yAxisPill);
	}
	return ids;
}

/** Pill ids a worksheet displays or filters and sorts by. */
function usedPillIds(ws) {
	const ids = shownPillIds(ws);
	for (const f of ws.filters ?? []) if (f.pillId) ids.add(f.pillId);
	for (const s of ws.sorts ?? []) {
		ids.add(s.pillId);
		if (s.using) ids.add(s.using);
	}
	return ids;
}

/** Dimension pills on the shelves and marks: the fields Tableau links on by default. */
function viewDimensionPills(ws) {
	const ids = new Set([...(ws.rowPills ?? []), ...(ws.colPills ?? [])]);
	for (const pane of ws.panes ?? []) for (const list of Object.values(pane.encodings ?? {})) for (const id of list ?? []) ids.add(id);
	return [...ids].map((id) => ws.pills?.[id]).filter((p) => p && !p.aggregated && !p.fieldId?.startsWith('[:'));
}

/**
 * Link candidates between a primary and a secondary: the custom relationship's field pairs, else dimensions with the
 * same name in both (Tableau's automatic relationship).
 * @returns {{ primary: string, secondary: string }[]}
 */
export function linkCandidates(ir, primary, secondary) {
	const rel = (ir.blendRelationships ?? []).find((r) => (r.source === primary.id && r.target === secondary.id) || (r.source === secondary.id && r.target === primary.id));
	if (rel?.mappings?.length) {
		return rel.mappings.map((m) => (rel.source === primary.id ? { primary: m.source, secondary: m.target } : { primary: m.target, secondary: m.source }));
	}
	const out = [];
	for (const sf of secondary.fields ?? []) {
		if (sf.role !== 'dimension' || sf.kind === 'measure-names' || sf.kind === 'measure-values') continue;
		const pf = (primary.fields ?? []).find((f) => f.role === 'dimension' && f.name === sf.name);
		if (pf) out.push({ primary: pf.id, secondary: sf.id });
	}
	return out;
}

/**
 * Links a worksheet blends on: candidates whose primary field is a dimension in the view (at that pill's date
 * level), plus those turned on by hand, minus those turned off.
 * @returns {{ links: (Link & { inView: boolean })[] }}
 */
export function activeLinks(ws, primaryId, secondaryId, candidates) {
	const dims = viewDimensionPills(ws).filter((p) => p.datasourceId === primaryId);
	const overrides = (list) => new Set((list ?? []).map((id) => parsePillId(id)).map((p) => `${p.datasourceId}\u0000${p.fieldId}`));
	const include = overrides(ws.linkOverrides?.include);
	const exclude = overrides(ws.linkOverrides?.exclude);
	const listed = (set, c) => set.has(`${primaryId}\u0000${c.primary}`) || set.has(`${secondaryId}\u0000${c.secondary}`);
	const links = [];
	const seen = new Set();
	for (const c of candidates) {
		if (listed(exclude, c)) continue;
		const pills = dims.filter((p) => p.fieldId === c.primary);
		const parts = pills.length ? [...new Set(pills.map(pillDatePart))] : listed(include, c) ? [undefined] : [];
		for (const datePart of parts) {
			const key = `${c.primary}\u0000${c.secondary}\u0000${datePart ?? ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			links.push({ primary: c.primary, secondary: c.secondary, ...(datePart ? { datePart } : {}), inView: pills.length > 0 });
		}
	}
	return { links };
}

/** Calc closure facts of one datasource: references to its own fields and to other datasources. */
function calcGraph(ir, ds) {
	const lookupField = fieldLookup(ds);
	const findParameter = parameterLookup(ir.parameters ?? []);
	const facts = new Map();
	const factsOf = (field) => {
		if (facts.has(field.id)) return facts.get(field.id);
		const out = { refs: new Set(), foreign: new Set(), aggregated: false };
		facts.set(field.id, out);
		const formula = CALC_KINDS.has(field.kind) ? calcFormula(field, { lookupField, findParameter }) : undefined;
		const sources = [field.group?.source, field.bin?.source, field.set?.source].filter(Boolean);
		const ast = formula ? parseSafe(formula) : null;
		if (ast) out.aggregated = analyzeFormula(ast).aggregated;
		for (const node of ast ? fieldNodes(ast) : []) {
			if (findParameter(node.id)) continue;
			const own = lookupField(node.id);
			if (own) out.refs.add(own.id);
			else if (node.parts.length === 2 && node.parts[0] !== 'Parameters') out.foreign.add(node.parts[0]);
		}
		for (const id of sources) {
			const own = lookupField(id);
			if (own) out.refs.add(own.id);
		}
		return out;
	};
	/** Field ids reachable from `ids` through calc references, with the datasources they reach. */
	const closure = (ids) => {
		const fields = new Set();
		const foreign = new Set();
		const queue = [...ids];
		while (queue.length) {
			const id = queue.shift();
			const field = lookupField(id);
			if (!field || fields.has(field.id)) continue;
			fields.add(field.id);
			const f = factsOf(field);
			f.foreign.forEach((d) => foreign.add(d));
			queue.push(...f.refs);
		}
		return { fields, foreign };
	};
	const aggregatedCalc = (field, seen = new Set()) => {
		if (!CALC_KINDS.has(field.kind) || seen.has(field.id)) return false;
		seen.add(field.id);
		const f = factsOf(field);
		return f.aggregated || [...f.refs].some((id) => aggregatedCalc(lookupField(id), seen));
	};
	return { lookupField, findParameter, factsOf, closure, aggregatedCalc };
}

/** Field ids a filter's own expressions reference (condition, top N by). */
function filterExpressionRefs(filter) {
	const out = [];
	for (const text of [filter.expression, filter.top?.by]) {
		const ast = text ? parseSafe(text) : null;
		if (ast) out.push(...fieldNodes(ast).map((n) => n.id));
	}
	return out;
}

/**
 * Rewrite a primary calc for the blend datasource: an aggregation over one secondary's fields reads its per-link
 * column as MAX(column); a bare secondary reference reads its column.
 * @param {string} formula
 * @param {Set<string>} secondaryIds
 * @param {(secondaryId: string, item: { kind: 'expr', text: string, agg: string } | { kind: 'field', fieldId: string }) => string} register  Replacement text
 */
export function rewriteSecondaryRefs(formula, secondaryIds, register) {
	const ast = parseSafe(formula);
	if (!ast) return formula;
	const tokens = tokenize(formula);
	const at = new Map(tokens.map((t, i) => [t.pos, i]));
	const secondaryOf = (node) => (node.type === 'Field' && node.parts.length === 2 && secondaryIds.has(node.parts[0]) ? node.parts[0] : undefined);
	const callEnd = (node) => {
		let depth = 0;
		for (let i = (at.get(node.pos) ?? tokens.length) + 1; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.type !== 'op') continue;
			if (t.value === '(') depth++;
			else if (t.value === ')' && --depth === 0) return t.end;
		}
		return undefined;
	};
	const edits = [];
	const visit = (node) => {
		if (!node) return;
		if (node.type === 'Call' && AGGREGATES.has(node.name)) {
			const refs = fieldNodes({ type: 'Paren', expr: { type: 'Call', name: 'X', args: node.args } });
			const owners = new Set(refs.map(secondaryOf));
			const end = callEnd(node);
			if (refs.length && owners.size === 1 && !owners.has(undefined) && end !== undefined) {
				const [secondaryId] = owners;
				edits.push({ start: node.pos, end, text: register(secondaryId, { kind: 'expr', text: formula.slice(node.pos, end), agg: node.name }) });
				return;
			}
		}
		const secondaryId = node.type === 'Field' ? secondaryOf(node) : undefined;
		if (secondaryId && at.has(node.pos)) {
			edits.push({ start: node.pos, end: tokens[at.get(node.pos)].end, text: register(secondaryId, { kind: 'field', fieldId: `[${node.parts[1].replace(/\]/g, ']]')}]` }) });
			return;
		}
		children(node).forEach(visit);
	};
	visit(ast);
	let out = formula;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

/** Restrict every aggregation in a formula to the rows where `predicate` holds: SUM(x) becomes SUM(IF p THEN x END). */
export function wrapAggregates(formula, predicate) {
	const ast = parseSafe(formula);
	if (!ast) return undefined;
	const tokens = tokenize(formula);
	const at = new Map(tokens.map((t, i) => [t.pos, i]));
	const edits = [];
	const visit = (node) => {
		if (!node) return;
		if (node.type === 'Call' && AGGREGATES.has(node.name) && node.args.length === 1) {
			const open = (at.get(node.pos) ?? -2) + 1;
			let depth = 0;
			for (let i = open; i < tokens.length; i++) {
				const t = tokens[i];
				if (t.type !== 'op') continue;
				if (t.value === '(') depth++;
				else if (t.value === ')' && --depth === 0) {
					edits.push({ at: tokens[open].end, text: `IF ${predicate} THEN ` }, { at: t.pos, text: ' END' });
					break;
				}
			}
			return;
		}
		children(node).forEach(visit);
	};
	visit(ast);
	let out = formula;
	for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
	return out;
}

function formulaLiteral(value, datatype) {
	if (value === null || value === undefined) return undefined;
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number') return String(value);
	if (datatype === 'date' || datatype === 'datetime') return `#${String(value)}#`;
	if ((datatype === 'integer' || datatype === 'real') && Number.isFinite(Number(value))) return String(Number(value));
	return `"${String(value).replace(/"/g, '""')}"`;
}

/** Tableau predicate for a fixed filter on a secondary dimension, or undefined when it has none. */
export function filterPredicate(filter, pill, field) {
	if (!field || pill?.aggregated) return undefined;
	const part = pill ? pillDatePart(pill) : undefined;
	const subject = part ? (part.startsWith('trunc:') ? `DATETRUNC('${part.slice(6)}', ${field.id})` : `DATEPART('${part}', ${field.id})`) : field.id;
	const type = part && !part.startsWith('trunc:') ? 'integer' : field.datatype;
	if (filter.kind === 'categorical' && !filter.all && !filter.ranges?.length) {
		const values = filter.include ?? filter.exclude;
		if (!Array.isArray(values)) return undefined;
		const literals = values.filter((v) => v !== null && v !== undefined).map((v) => formulaLiteral(v, type));
		if (literals.some((l) => l === undefined)) return undefined;
		const hasNull = values.length !== literals.length;
		const parts = [literals.length ? `${subject} IN (${literals.join(', ')})` : '', hasNull ? `ISNULL(${subject})` : ''].filter(Boolean);
		if (!parts.length) return filter.include ? 'FALSE' : undefined;
		const inside = parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
		return filter.include ? inside : `NOT ${inside.startsWith('(') ? inside : `(${inside})`}`;
	}
	if (filter.kind === 'quantitative' && (filter.min !== undefined || filter.max !== undefined) && (filter.includedValues ?? 'in-range') === 'in-range') {
		const bounds = [filter.min !== undefined ? `${subject} >= ${formulaLiteral(filter.min, type)}` : '', filter.max !== undefined ? `${subject} <= ${formulaLiteral(filter.max, type)}` : ''].filter(Boolean);
		return bounds.length > 1 ? `(${bounds.join(' AND ')})` : bounds[0];
	}
	return undefined;
}

/** Field resolver for Magic ETL formulas over a datasource's dataset. */
function etlResolver(g, target) {
	const types = new Map((target.schema ?? []).map((c) => [c.name, c.type]));
	const rawBoolean = target.strategy !== 'upload';
	return (id) => {
		const p = g.findParameter(id);
		if (p) return { kind: 'parameter', parameter: p };
		const f = g.lookupField(id);
		if (!f) return undefined;
		if (f.kind === 'count') return { kind: 'calc', field: { ...f, kind: 'calculated', formula: '1' } };
		if (f.kind === 'column') {
			const column = target.fieldMap?.[f.id];
			if (!column) return undefined;
			return { kind: 'column', column, datatype: f.datatype, domoType: types.get(column) ?? tableauToDomoType(f.datatype), ...(rawBoolean ? { rawBoolean: true } : {}), ...(f.datatype === 'string' && collationIgnoresCase(f.collation) ? { ignoreCase: true } : {}) };
		}
		if (CALC_KINDS.has(f.kind)) return { kind: 'calc', field: { ...f, formula: calcFormula(f, g) } };
		return undefined;
	};
}

function uniqueName(base, taken) {
	let name = base;
	for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
	taken.add(name.toLowerCase());
	return name;
}

function issue(severity, code, message, object, suggestion) {
	return { severity, code, message, ...(object ? { object } : {}), ...(suggestion ? { suggestion } : {}) };
}

const VOLATILE_SQL = /\b(CURRENT_DATE|CURRENT_TIMESTAMP|NOW)\s*\(/i;

const sheetObject = (ws) => ({ type: 'worksheet', name: ws.name });

/** Pill id on another datasource and field, keeping the table-calc chain, derivation prefix and type key. */
function movedPillId(pill, datasourceId, fieldInner, prefix = pill.prefix) {
	const inner = stripBrackets(pill.id.slice(pill.id.lastIndexOf('].[') + 2));
	const chain = inner.split(':').filter((s, i, all) => i < all.length - 2 && TABLE_CALC_PREFIXES[s]);
	const typeKey = prefix !== pill.prefix && PILL_AGGREGATES[prefix] ? 'qk' : pill.typeKey;
	const name = [...chain, prefix, fieldInner, typeKey].join(':');
	return `[${datasourceId}].[${name.replace(/\]/g, ']]')}]`;
}

function movedPill(pill, id, fieldId) {
	const parsed = parsePillId(id);
	return { ...pill, id, datasourceId: parsed.datasourceId, fieldId, derivation: parsed.derivation, prefix: parsed.prefix, typeKey: parsed.typeKey, continuous: parsed.continuous, aggregated: parsed.aggregated };
}

/** Replace pill ids, field references (`[from].` prefixes too) and datasource ids throughout a worksheet. */
function remapWorksheet(ws, { pills, strings, datasourceIds, from, to, drop }) {
	const map = (s) => {
		if (typeof s !== 'string') return s;
		if (strings.has(s)) return strings.get(s);
		return from && s.startsWith(`[${from}].`) ? `[${to}].${s.slice(from.length + 3)}` : s;
	};
	const walk = (v) => {
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return map(v);
	};
	const rest = Object.fromEntries(Object.entries(ws).filter(([k]) => k !== 'pills' && k !== 'datasourceIds' && k !== 'filters' && k !== 'name'));
	const out = { name: ws.name, ...walk(rest) };
	out.pills = pills;
	out.datasourceIds = datasourceIds;
	out.filters = (ws.filters ?? []).filter((f) => !drop?.has(f.pillId)).map((f) => {
		const pill = f.pillId ? pills[map(f.pillId)] : undefined;
		const moved = walk(f);
		if (pill) Object.assign(moved, { datasourceId: pill.datasourceId, fieldId: pill.fieldId });
		return moved;
	});
	return out;
}

/**
 * Plan blends: worksheets that blend datasources move onto blend datasources whose datasets are Magic ETL joins.
 * Runs after planDatasets and before beast modes, so calcs, cards and filters see one datasource per worksheet.
 *
 * @param {WorkbookIR} ir
 * @param {{ datasets: DatasetPlan[], dataflows: DataflowPlan[] }} data  planDatasets result
 * @param {{ options?: import('../model/types.js').ConvertOptions, workbookKey: string }} opts
 * @returns {{ ir: WorkbookIR, datasets: DatasetPlan[], dataflows: DataflowPlan[], issues: Issue[] }}
 */
export function planBlends(ir, data, { options = {}, workbookKey } = {}) {
	const blended = (ir.worksheets ?? []).filter((ws) => (ws.datasourceIds ?? []).length > 1);

	const dsById = new Map((ir.datasources ?? []).map((d) => [d.id, d]));
	const targetOf = (id) => data.datasets.find((d) => d.cardTarget && d.datasourceId === id);
	const graphs = new Map();
	const graphOf = (ds) => {
		if (!graphs.has(ds.id)) graphs.set(ds.id, calcGraph(ir, ds));
		return graphs.get(ds.id);
	};
	const issues = [];
	const handled = new Map();
	const groups = new Map();
	const quickFilters = new Set(
		(ir.dashboards ?? [])
			.flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])])
			.filter((z) => z.kind === 'filter' && z.worksheet && z.param)
			.map((z) => `${z.worksheet}\u0000${z.param}`)
	);
	const zoneParams = new Set([...quickFilters].map((k) => k.split('\u0000')[1]));

	for (const ws of blended) {
		const [primaryId, ...others] = ws.datasourceIds;
		const primary = dsById.get(primaryId);
		if (!primary || !targetOf(primaryId)) continue;
		const used = usedPillIds(ws);
		const shown = shownPillIds(ws);
		const pg = graphOf(primary);
		const primarySeeds = [
			...[...used].map((id) => ws.pills?.[id]).filter((p) => p?.datasourceId === primaryId).map((p) => p.fieldId),
			...(ws.filters ?? []).filter((f) => f.datasourceId === primaryId).flatMap((f) => [f.fieldId, ...filterExpressionRefs(f)])
		];
		const reachesForeign = pg.closure(primarySeeds).foreign;
		const secondaries = [];
		let blocked = '';
		for (const secondaryId of others) {
			const secondary = dsById.get(secondaryId);
			if (!secondary) continue;
			const candidates = linkCandidates(ir, primary, secondary);
			const linkOf = new Map(candidates.map((c) => [c.secondary, c.primary]));
			const target = targetOf(secondaryId);
			const quick = (f) => f.shownOnDashboard || quickFilters.has(`${ws.name}\u0000${f.pillId}`) || zoneParams.has(f.pillId);
			const unlinkedFilters = (ws.filters ?? []).filter((f) => f.datasourceId === secondaryId && !linkOf.has(f.fieldId));
			// An unlinked filter that keeps every value and has no control does nothing.
			const noop = new Set(unlinkedFilters.filter((f) => f.all && !quick(f)).map((f) => f.pillId));
			const filters = unlinkedFilters.filter((f) => !noop.has(f.pillId));
			const filterOnly = new Set(filters.map((f) => f.pillId).filter((id) => !shown.has(id)));
			const values = [...shown].map((id) => ws.pills?.[id]).filter((p) => p?.datasourceId === secondaryId && !linkOf.has(p.fieldId));
			const joined = values.length > 0 || filters.length > 0 || reachesForeign.has(secondaryId);
			if (joined && !target) blocked = `datasource '${secondary.caption}' has no Domo dataset`;
			// With secondary values in the view, a fixed filter on a secondary dimension restricts the rows they aggregate.
			const folded = new Map();
			if (target && (values.length || reachesForeign.has(secondaryId))) {
				for (const f of filters) {
					if (quick(f) || !filterOnly.has(f.pillId)) continue;
					const predicate = filterPredicate(f, f.pillId ? ws.pills?.[f.pillId] : undefined, graphOf(secondary).lookupField(f.fieldId));
					if (!predicate) continue;
					const check = translateEtl(predicate, { resolveField: etlResolver(graphOf(secondary), target), options: { parameters: 'inline' } });
					if (check.status !== 'unsupported') folded.set(f.pillId, predicate);
				}
			}
			secondaries.push({ secondary, candidates, linkOf, joined, folded, noop, ...(joined ? activeLinks(ws, primaryId, secondaryId, candidates) : { links: [] }) });
		}
		if (blocked) {
			issues.push(issue('warning', 'blend.skipped', `Worksheet ${ws.name} blends datasources, but ${blocked}; only fields from '${primary.caption}' are kept`, sheetObject(ws)));
			continue;
		}
		const joined = secondaries.filter((s) => s.joined);
		for (const s of joined) s.mode = s.links.some((l) => !l.inView) ? 'once' : 'repeat';
		// Tableau sums a per-link value once per link value within each mark, so mode once keeps one row per link and mark.
		const grain = [
			...new Map(
				viewDimensionPills(ws)
					.filter((p) => p.datasourceId === primaryId && !p.tableCalc)
					.map((p) => ({ fieldId: p.fieldId, ...(pillDatePart(p) ? { datePart: pillDatePart(p) } : {}) }))
					.map((g) => [`${g.fieldId}\u0000${g.datePart ?? ''}`, g])
			).values()
		].sort((a, b) => `${a.fieldId}\u0000${a.datePart ?? ''}`.localeCompare(`${b.fieldId}\u0000${b.datePart ?? ''}`));
		for (const s of joined) s.grain = s.mode === 'once' ? grain.filter((g) => !s.links.some((l) => l.inView && l.primary === g.fieldId && (l.datePart ?? '') === (g.datePart ?? ''))) : [];
		const entry = { ws, primary, secondaries, joined };
		handled.set(ws.name, entry);
		if (!joined.length) continue;
		for (const s of joined) s.where = [...new Set(s.folded.values())].sort();
		const grainKey = (s) => (s.grain.length ? [s.grain.map((g) => [g.fieldId, g.datePart ?? ''])] : []);
		const signature = JSON.stringify([primaryId, joined.map((s) => [s.secondary.id, s.mode, s.links.map((l) => [l.primary, l.secondary, l.datePart ?? '']).sort(), s.where, ...grainKey(s)]).sort()]);
		const links = (s) => s.links.map((l) => ({ primary: l.primary, secondary: l.secondary, ...(l.datePart ? { datePart: l.datePart } : {}) }));
		if (!groups.has(signature)) groups.set(signature, { signature, primary, secondaries: joined.map((s) => ({ secondary: s.secondary, mode: s.mode, links: links(s), where: s.where, grain: s.grain })), sheets: [] });
		groups.get(signature).sheets.push(entry);
	}

	const datasets = [...data.datasets];
	const dataflows = [...data.dataflows];
	const newSources = [];
	const sheets = new Map();
	const dashboardParams = new Map();
	const prefix = options.namePrefix ?? '';

	for (const entry of handled.values()) {
		if (entry.joined.length) continue;
		const { ws, primary, secondaries } = entry;
		const strings = new Map();
		const pills = {};
		const mapped = [];
		for (const [id, pill] of Object.entries(ws.pills ?? {})) {
			const s = secondaries.find((x) => x.secondary.id === pill.datasourceId);
			if (!s) {
				pills[id] = pill;
				continue;
			}
			const target = s.linkOf.get(pill.fieldId);
			if (!target) continue;
			const newId = movedPillId(pill, primary.id, stripBrackets(target));
			strings.set(id, newId);
			pills[newId] = movedPill(pill, newId, target);
			if ((ws.filters ?? []).some((f) => f.pillId === id)) mapped.push(mappedLabel(graphOf, s.secondary, pill.fieldId, primary, target));
		}
		sheets.set(ws.name, remapWorksheet(ws, { pills, strings, datasourceIds: [primary.id], drop: new Set(secondaries.flatMap((s) => [...s.noop])) }));
		dashboardParams.set(ws.name, strings);
		if (mapped.length) {
			issues.push(issue('info', 'blend.filter-mapped', `Filters on blended link fields apply to the linked fields of '${primary.caption}': ${[...new Set(mapped)].join(', ')}`, sheetObject(ws)));
		}
	}

	for (const group of groups.values()) {
		const built = buildGroup(group, { ir, targetOf, graphOf, workbookKey, prefix });
		issues.push(...built.issues);
		if (!built.ok) {
			for (const { ws } of group.sheets) handled.delete(ws.name);
			continue;
		}
		newSources.push(built.datasource);
		datasets.push(built.dataset);
		dataflows.push(built.dataflow);
		for (const [name, sheet] of built.sheets) sheets.set(name, sheet);
		for (const [name, strings] of built.params) dashboardParams.set(name, strings);
	}

	const moved = movedCalcs(ir, dsById, sheets, graphOf, issues);
	const handledNames = new Set(sheets.keys());
	for (const ds of newSources) dsById.set(ds.id, ds);
	const zoneContext = { params: dashboardParams, sheets, dsById, ir, graphOf, mapped: [] };
	const dashboards = (ir.dashboards ?? []).map((d) => ({
		...d,
		zones: (d.zones ?? []).map((z) => remapZone(z, zoneContext)),
		floating: (d.floating ?? []).map((z) => remapZone(z, zoneContext))
	}));
	const zoneLabels = new Map();
	for (const m of zoneContext.mapped) zoneLabels.set(m.ws, new Set([...(zoneLabels.get(m.ws) ?? []), m.label]));
	for (const [name, labels] of zoneLabels) {
		issues.push(issue('info', 'blend.filter-mapped', `Dashboard filters on related datasources apply to the linked fields: ${[...labels].join(', ')}`, { type: 'worksheet', name }));
	}
	const nextIr = {
		...ir,
		datasources: [...(ir.datasources ?? []).map((ds) => (moved.has(ds.id) ? { ...ds, fields: ds.fields.filter((f) => !moved.get(ds.id).has(f.id)) } : ds)), ...newSources],
		worksheets: (ir.worksheets ?? []).map((ws) => sheets.get(ws.name) ?? ws),
		dashboards,
		issues: (ir.issues ?? []).filter((i) => !(i.code === 'twb.blend' && handledNames.has(i.object?.name)))
	};
	return { ir: nextIr, datasets, dataflows, issues };
}

const nameOf = (graphOf, ds, fieldId) => graphOf(ds).lookupField(fieldId)?.name ?? stripBrackets(fieldId);
const mappedLabel = (graphOf, secondary, fieldId, primary, target) => `${nameOf(graphOf, secondary, fieldId)} (${secondary.caption}) to ${nameOf(graphOf, primary, target)}`;

/**
 * A dashboard filter zone on a worksheet, possibly on a field of a related datasource ("all using related data
 * sources"): the worksheet's own pill, or the linked field of the worksheet's datasource.
 */
function remapZone(zone, { params, sheets, dsById, ir, graphOf, mapped }) {
	if (zone.kind !== 'filter' || !zone.param || !zone.worksheet) return zone;
	const strings = params.get(zone.worksheet);
	if (strings?.has(zone.param)) return { ...zone, param: strings.get(zone.param) };
	const ws = sheets.get(zone.worksheet) ?? (ir.worksheets ?? []).find((w) => w.name === zone.worksheet);
	const pill = parsePillId(zone.param);
	const [own] = ws?.datasourceIds ?? [];
	if (!own || !pill.datasourceId || (ws.datasourceIds ?? []).includes(pill.datasourceId)) return zone;
	const related = dsById.get(pill.datasourceId);
	const primary = dsById.get(ws.blend?.primary ?? own);
	if (!related || !primary) return zone;
	const link = linkCandidates(ir, primary, related).find((c) => c.secondary === pill.fieldId);
	if (!link) return zone;
	mapped.push({ ws: ws.name, label: mappedLabel(graphOf, related, pill.fieldId, primary, link.primary) });
	return { ...zone, param: movedPillId(pill, own, stripBrackets(link.primary)) };
}

/**
 * Primary calcs that reference a blended datasource are only meaningful on the blend datasources (which carry their
 * rewritten copies); drop them from the primary unless a worksheet left on the primary uses them.
 */
function movedCalcs(ir, dsById, sheets, graphOf, issues) {
	const out = new Map();
	const finalSheets = (ir.worksheets ?? []).map((ws) => sheets.get(ws.name) ?? ws);
	for (const ds of ir.datasources ?? []) {
		const g = graphOf(ds);
		if (ds.blend) continue;
		const foreign = (ds.fields ?? []).filter((f) => CALC_KINDS.has(f.kind) && [...g.closure([f.id]).foreign].some((id) => dsById.has(id)));
		if (!foreign.length) continue;
		const seeds = finalSheets
			.filter((ws) => (ws.datasourceIds ?? []).includes(ds.id))
			.flatMap((ws) => [...Object.values(ws.pills ?? {}).filter((p) => p.datasourceId === ds.id).map((p) => p.fieldId), ...(ws.filters ?? []).filter((f) => f.datasourceId === ds.id).flatMap((f) => [f.fieldId, ...filterExpressionRefs(f)])]);
		const kept = g.closure(seeds).fields;
		const drop = new Set(foreign.filter((f) => !kept.has(f.id)).map((f) => f.id));
		if (!drop.size) continue;
		out.set(ds.id, drop);
		const blendsHere = finalSheets.some((ws) => ws.blend?.primary === ds.id);
		issues.push(
			issue(
				'info',
				'blend.calc-moved',
				`${drop.size} calc(s) of '${ds.caption}' reference other datasources, so they only work in a blend; ${blendsHere ? 'their beast modes are planned on the blend dataset(s) of the worksheets that use them' : 'no worksheet uses them, so no beast mode is planned'}`,
				{ type: 'datasource', name: ds.caption, id: ds.id }
			)
		);
	}
	return out;
}

/**
 * One blend datasource, its output dataset and the Magic ETL dataflow that computes it, plus the worksheets moved onto it.
 */
function buildGroup(group, { ir, targetOf, graphOf, workbookKey, prefix }) {
	const { primary, secondaries } = group;
	const issues = [];
	const primaryTarget = targetOf(primary.id);
	const blendId = `blend.${shortHash(group.signature)}`;
	const captions = secondaries.map((s) => s.secondary.caption || s.secondary.id);
	const linkLabel = (s) => s.links.map((l) => graphOf(s.secondary).lookupField(l.secondary)?.name ?? stripBrackets(l.secondary)).join(', ');
	const onLinks = secondaries.map((s) => (s.links.length ? linkLabel(s) : 'no link')).join('; ');
	const variant = [secondaries.some((s) => s.mode === 'once') && 'link totals', secondaries.some((s) => s.where?.length) && 'filtered'].filter(Boolean).join(', ');
	const caption = `${primary.caption} + ${captions.join(' + ')} on ${onLinks.length > 80 ? `${onLinks.slice(0, 77)}...` : onLinks}${variant ? `, ${variant}` : ''}`;
	const key = `${workbookKey}.blend-${slugify(primary.caption || primary.id)}-${shortHash(group.signature).slice(0, 8)}`;
	const outputName = `${prefix}${caption} (blend)`;
	const description = `Tableau blend of ${captions.map((c) => `'${c}'`).join(', ')} into '${primary.caption}', computed by Magic ETL.`;

	const taken = new Set([...(primaryTarget.schema ?? []).map((c) => c.name.toLowerCase())]);
	const namesTaken = new Set((primary.fields ?? []).map((f) => f.name.toLowerCase()));
	const idsTaken = new Set((primary.fields ?? []).map((f) => f.id));
	/** Per secondary: items keyed by what they compute. */
	const items = new Map(secondaries.map((s) => [s.secondary.id, new Map()]));
	const newField = (secondary, name, base) => {
		const display = uniqueName(namesTaken.has(name.toLowerCase()) ? `${name} (${secondary.caption})` : name, namesTaken);
		let id = `[${display.replace(/\]/g, ']]')}]`;
		for (let n = 2; idsTaken.has(id); n++) id = `[${display.replace(/\]/g, ']]')} ${n}]`;
		idsTaken.add(id);
		return { id, name: display, ...base };
	};
	const register = (secondaryId, itemKey, make) => {
		const bucket = items.get(secondaryId);
		if (!bucket.has(itemKey)) bucket.set(itemKey, make());
		return bucket.get(itemKey);
	};
	const secondaryById = new Map(secondaries.map((s) => [s.secondary.id, s.secondary]));
	const dimItem = (secondaryId, fieldId) =>
		register(secondaryId, `dim:${fieldId}`, () => {
			const secondary = secondaryById.get(secondaryId);
			const sf = graphOf(secondary).lookupField(fieldId);
			const datatype = sf?.datatype ?? 'string';
			const ref = sf?.id ?? fieldId;
			const text = datatype === 'string' ? `IF MIN(${ref}) = MAX(${ref}) THEN MIN(${ref}) ELSE '*' END` : `IF MIN(${ref}) = MAX(${ref}) THEN MIN(${ref}) END`;
			return { kind: 'dim', text, field: newField(secondary, sf?.name ?? stripBrackets(fieldId), { role: 'dimension', datatype }), source: sf };
		});
	const measureItem = (secondaryId, fieldId, agg) =>
		register(secondaryId, `measure:${agg}:${fieldId}`, () => {
			const secondary = secondaryById.get(secondaryId);
			const sf = graphOf(secondary).lookupField(fieldId);
			const name = sf?.name ?? stripBrackets(fieldId);
			const ref = sf?.id ?? fieldId;
			const text = agg === 'USER' ? ref : sf?.kind === 'count' && (agg === 'SUM' || agg === 'COUNT') ? 'COUNT(1)' : `${agg}(${ref})`;
			const taken = [...items.get(secondaryId).values()].some((i) => i.kind === 'measure' && i.source?.id === sf?.id);
			return { kind: 'measure', agg, text, field: newField(secondary, taken ? `${name} (${agg.toLowerCase()})` : name, { role: 'measure', datatype: 'real' }), source: sf };
		});
	const exprItem = (secondaryId, text, agg) => {
		const secondary = secondaryById.get(secondaryId);
		const single = /^\s*[A-Z]+\s*\(\s*(\[[^\]]+\]\.\[(?:[^\]]|\]\])+\])\s*\)\s*$/i.exec(text);
		const sf = single ? graphOf(secondary).lookupField(single[1]) : undefined;
		if (sf && agg !== 'ATTR') return measureItem(secondaryId, sf.id, agg);
		return register(secondaryId, `expr:${text}`, () => {
			const arg = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
			const etlText = agg === 'ATTR' ? `IF MIN(${arg}) = MAX(${arg}) THEN MIN(${arg}) END` : text;
			const name = sf ? `${agg} of ${sf.name}` : `Blended value (${secondary.caption})`;
			return { kind: 'measure', agg, text: etlText, field: newField(secondary, name, { role: 'measure', datatype: 'real' }), source: sf };
		});
	};
	const modeOf = new Map(secondaries.map((s) => [s.secondary.id, s.mode]));
	/** Aggregation that reads a per-link measure column on the cards. */
	const readAggregation = (secondaryId, item) => (modeOf.get(secondaryId) === 'once' ? (REAGGREGATE[item.agg] ?? 'MAX') : 'MAX');
	const replacement = (secondaryId, item) => {
		if (item.kind === 'expr') {
			const measure = exprItem(secondaryId, item.text, item.agg);
			return `${readAggregation(secondaryId, measure)}(${measure.field.id})`;
		}
		const secondary = secondaryById.get(secondaryId);
		const sf = graphOf(secondary).lookupField(item.fieldId);
		if (sf && graphOf(secondary).aggregatedCalc(sf)) {
			const measure = measureItem(secondaryId, sf.id, 'USER');
			return `${readAggregation(secondaryId, measure)}(${measure.field.id})`;
		}
		return dimItem(secondaryId, item.fieldId).field.id;
	};

	// Worksheets: primary pills move to the blend datasource; secondary pills read their per-link columns.
	const movedSheets = new Map();
	const params = new Map();
	const seeds = [];
	const perSheet = [];
	for (const { ws, secondaries: links } of group.sheets) {
		const used = usedPillIds(ws);
		const shown = shownPillIds(ws);
		const strings = new Map([[primary.id, blendId]]);
		const pills = {};
		const shownSecondary = new Map();
		const secondaryFilters = [];
		const mapped = [];
		const foldedFilters = new Set();
		const foldedNames = [];
		for (const [id, pill] of Object.entries(ws.pills ?? {})) {
			if (pill.datasourceId === primary.id) {
				const newId = `[${blendId}]${id.slice(primary.id.length + 2)}`;
				strings.set(id, newId);
				pills[newId] = { ...pill, id: newId, datasourceId: blendId };
				if (used.has(id)) seeds.push(pill.fieldId);
				continue;
			}
			const s = links.find((x) => x.secondary.id === pill.datasourceId);
			if (!s) {
				pills[id] = pill;
				continue;
			}
			if (!used.has(id)) continue;
			if (s.noop?.has(id) && !shown.has(id)) {
				foldedFilters.add(id);
				continue;
			}
			if (s.folded?.has(id) && !shown.has(id)) {
				foldedFilters.add(id);
				foldedNames.push(nameOf(graphOf, s.secondary, pill.fieldId));
				continue;
			}
			const link = s.linkOf.get(pill.fieldId);
			const isFilter = (ws.filters ?? []).some((f) => f.pillId === id);
			let newId;
			let fieldId;
			if (link) {
				fieldId = link;
				newId = movedPillId(pill, blendId, stripBrackets(link));
				seeds.push(link);
				if (isFilter) mapped.push(mappedLabel(graphOf, s.secondary, pill.fieldId, primary, link));
			} else if (!s.joined) {
				continue;
			} else {
				const agg = PILL_AGGREGATES[pill.prefix] ?? (pill.prefix === 'usr' ? 'USER' : undefined);
				const sf = graphOf(s.secondary).lookupField(pill.fieldId);
				const item = agg && !(agg === 'USER' && sf && !graphOf(s.secondary).aggregatedCalc(sf)) ? measureItem(s.secondary.id, pill.fieldId, agg) : dimItem(s.secondary.id, pill.fieldId);
				fieldId = item.field.id;
				newId = movedPillId(pill, blendId, stripBrackets(fieldId), item.kind === 'measure' ? readAggregation(s.secondary.id, item).toLowerCase().replace('median', 'med') : pill.prefix);
				if (isFilter) secondaryFilters.push(item.field.name);
				if (shown.has(id)) shownSecondary.set(s.secondary.id, [...(shownSecondary.get(s.secondary.id) ?? []), item]);
			}
			strings.set(id, newId);
			pills[newId] = movedPill(pill, newId, fieldId);
			strings.set(`[${pill.datasourceId}].${pill.fieldId}`, `[${blendId}].${fieldId}`);
		}
		for (const f of ws.filters ?? []) if (f.datasourceId === primary.id) seeds.push(f.fieldId, ...filterExpressionRefs(f));
		const sheet = remapWorksheet(ws, { pills, strings, datasourceIds: [blendId], from: primary.id, to: blendId, drop: foldedFilters });
		sheet.blend = { primary: primary.id, secondaries: group.secondaries.map((s) => ({ datasourceId: s.secondary.id, links: s.links })) };
		movedSheets.set(ws.name, sheet);
		params.set(ws.name, strings);
		perSheet.push({ ws, links, shownSecondary, secondaryFilters, mapped, foldedNames });
	}

	// Primary calcs the worksheets reach, with secondary references rewritten.
	const pg = graphOf(primary);
	const reached = pg.closure(seeds).fields;
	const secondaryIds = new Set(secondaries.map((s) => s.secondary.id));
	const fields = [];
	for (const f of primary.fields ?? []) {
		if (CALC_KINDS.has(f.kind)) {
			if (!reached.has(f.id)) continue;
			if (f.kind === 'calculated' && f.formula && [...pg.factsOf(f).foreign].some((d) => secondaryIds.has(d))) {
				fields.push({ ...f, formula: rewriteSecondaryRefs(f.formula, secondaryIds, replacement) });
				continue;
			}
		}
		fields.push(f);
	}

	// Dataflow: load the primary, then per secondary aggregate to the link keys and left-join.
	const usedIds = new Set();
	const actionId = (p, label) => {
		const base = `${p}-${slugify(label) || 'x'}`;
		let id = base;
		for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
		usedIds.add(id);
		return id;
	};
	const load = (dataset, gui) => ({
		type: 'LoadFromVault',
		id: actionId('in', dataset.name),
		name: dataset.name,
		dataSourceId: ref('dataset', dataset.key),
		executeFlowWhenUpdated: refreshesOnUpdate(dataset),
		onlyLoadNewVersions: false,
		truncateTextColumns: false,
		truncateRows: false,
		gui
	});
	const actions = [];
	const primaryLoad = load(primaryTarget, { x: 50, y: 50 });
	actions.push(primaryLoad);
	let current = primaryLoad.id;
	let x = 50;
	const fieldMap = { ...(primaryTarget.fieldMap ?? {}) };
	const schema = (primaryTarget.schema ?? []).map((c) => ({ ...c }));
	const helpers = [];
	const newFields = [];

	const sideResolver = (ds, target) => etlResolver(graphOf(ds), target);
	const failure = (r) => r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
	const etl = (text, resolveField, aggregate = false) => translateEtl(text, { resolveField, options: { parameters: 'inline' }, name: caption }, { aggregate });

	/** Join key column for one side of a link: the column itself, else a helper formula column. */
	const keyColumn = (ds, target, resolveField, fieldId, datePart, otherType, sideHelpers, taken) => {
		const res = resolveField(fieldId);
		if (res?.kind === 'column' && !datePart && (!otherType || otherType === res.domoType)) return { column: res.column, type: res.domoType };
		const inner = datePart ? (datePart.startsWith('trunc:') ? `DATETRUNC('${datePart.slice(6)}', ${fieldId})` : `DATEPART('${datePart}', ${fieldId})`) : fieldId;
		const r = etl(otherType === 'STRING' ? `STR(${inner})` : inner, resolveField);
		if (r.status === 'unsupported') return { bad: failure(r) || `${stripBrackets(fieldId)} has no column` };
		const column = uniqueName(`_t2d_link_${helpers.length + sideHelpers.length + 1}`, taken);
		sideHelpers.push({ fieldName: column, expression: r.expression });
		return { column, type: r.dataType };
	};

	const joinedLabels = [];
	for (const [index, s] of secondaries.entries()) {
		const secondary = s.secondary;
		const target = targetOf(secondary.id);
		const sResolve = sideResolver(secondary, target);
		const pResolve = sideResolver(primary, primaryTarget);
		const bucket = items.get(secondary.id);
		const sTaken = new Set([...(target.schema ?? []).map((c) => c.name.toLowerCase()), ...taken]);
		const pHelpers = [];
		const sHelpers = [];
		const keys1 = [];
		const keys2 = [];
		const dropped = [];
		for (const link of s.links) {
			const sType = sResolve(link.secondary)?.domoType;
			const pType = pResolve(link.primary)?.domoType;
			const differs = !link.datePart && sType && pType && sType !== pType ? 'STRING' : undefined;
			const pCount = pHelpers.length;
			const sCount = sHelpers.length;
			const pk = keyColumn(primary, primaryTarget, pResolve, link.primary, link.datePart, differs, pHelpers, taken);
			const sk = keyColumn(secondary, target, sResolve, link.secondary, link.datePart, differs, sHelpers, sTaken);
			if (pk.bad || sk.bad) {
				pHelpers.splice(pCount);
				sHelpers.splice(sCount);
				dropped.push(`${graphOf(secondary).lookupField(link.secondary)?.name ?? stripBrackets(link.secondary)} (${pk.bad || sk.bad})`);
				continue;
			}
			keys1.push(pk.column);
			keys2.push(sk.column);
		}
		if (dropped.length) {
			const all = !keys1.length;
			issues.push(
				issue(
					'warning',
					'blend.link-unsupported',
					`Blend link(s) of '${secondary.caption}' into '${primary.caption}' could not be computed in Magic ETL: ${dropped.join('; ')}; ${all ? 'its fields are left off the cards' : 'the join uses the other links'}`,
					{ type: 'datasource', name: secondary.caption, id: secondary.id }
				)
			);
			if (all) continue;
		}
		const grainKeys = [];
		const grainDropped = [];
		for (const g of s.grain ?? []) {
			const pCount = pHelpers.length;
			const k = keyColumn(primary, primaryTarget, pResolve, g.fieldId, g.datePart, undefined, pHelpers, taken);
			if (k.bad) {
				pHelpers.splice(pCount);
				grainDropped.push(nameOf(graphOf, primary, g.fieldId));
			} else if (!keys1.includes(k.column) && !grainKeys.includes(k.column)) grainKeys.push(k.column);
		}
		if (grainDropped.length) {
			issues.push(issue('warning', 'blend.link-not-in-view', `Primary dimension(s) ${grainDropped.join(', ')} could not be computed in Magic ETL, so the per-link values of '${secondary.caption}' are not kept once per mark for them`, { type: 'datasource', name: secondary.caption, id: secondary.id }));
		}
		const groupFields = [];
		const onceColumns = [];
		const unfiltered = [];
		for (const item of bucket.values()) {
			let text = item.text;
			if (s.where?.length) {
				const base = item.agg === 'USER' && item.source ? (calcFormula(item.source, graphOf(secondary)) ?? item.text) : item.text;
				const wrapped = wrapAggregates(base, s.where.length > 1 ? s.where.map((w) => `(${w})`).join(' AND ') : s.where[0]);
				if (wrapped && wrapped !== base) text = wrapped;
				else unfiltered.push(item.field.name);
			}
			const r = etl(text, sResolve, true);
			if (r.status === 'unsupported' || !r.aggregated) {
				issues.push(issue('warning', 'blend.field-skipped', `'${item.field.name}' from blended datasource '${secondary.caption}' could not be aggregated in Magic ETL${r.status === 'unsupported' ? ` (${failure(r)})` : ''}; it is left off the cards`, { type: 'field', name: item.field.name, id: item.field.id }));
				continue;
			}
			const once = s.mode === 'once' && item.kind === 'measure';
			const column = uniqueName(once ? `_t2d_blend_${helpers.length + onceColumns.length + 1}` : domoColumnName(item.field.name), taken);
			sTaken.add(column.toLowerCase());
			groupFields.push({ name: column, expression: r.expression });
			const datatype = item.kind === 'dim' ? item.field.datatype : (TABLEAU_TYPES[r.dataType] ?? 'real');
			const output = once ? uniqueName(domoColumnName(item.field.name), taken) : column;
			if (once) onceColumns.push({ value: column, output });
			newFields.push({ ...item.field, datatype, kind: 'column', physical: { remoteName: output } });
			fieldMap[item.field.id] = output;
			schema.push({ name: output, type: r.dataType });
			issues.push(...r.issues.filter((i) => i.severity === 'warning'));
			if (VOLATILE_SQL.test(r.expression)) {
				issues.push(issue('warning', 'blend.today', `'${item.field.name}' from blended datasource '${secondary.caption}' uses TODAY() or NOW(), which the blend dataflow evaluates at its last run, not when a card is viewed`, { type: 'field', name: item.field.name, id: item.field.id }, 'Schedule the blend dataflow to run daily.'));
			}
		}
		if (unfiltered.length) {
			issues.push(issue('warning', 'blend.secondary-filter', `The fixed filters on '${secondary.caption}' could not be applied inside ${unfiltered.join(', ')} (it aggregates through other calcs), so those values cover every secondary row`, { type: 'datasource', name: secondary.caption, id: secondary.id }));
		}
		if (!groupFields.length) continue;
		const y = 50 + (index + 1) * Y_STEP * 2;
		const sLoad = load(target, { x: 50, y });
		actions.push(sLoad);
		let sCurrent = sLoad.id;
		if (sHelpers.length) {
			sCurrent = actionId('keys', secondary.caption);
			actions.push({ type: 'ExpressionEvaluator', id: sCurrent, name: `Link keys of ${secondary.caption}`, dependsOn: [sLoad.id], settings: { ...ETL_SETTINGS }, expressions: sHelpers, gui: { x: 50 + X_STEP, y } });
		}
		const groupId = actionId('group', secondary.caption);
		actions.push({
			type: 'GroupBy',
			id: groupId,
			name: `${secondary.caption} by link`,
			dependsOn: [sCurrent],
			settings: { ...ETL_SETTINGS },
			addLineNumber: false,
			giveBackRow: false,
			allRows: false,
			groups: keys2.map((name) => ({ name })),
			fields: groupFields,
			gui: { x: 50 + 2 * X_STEP, y }
		});
		if (pHelpers.length) {
			x += X_STEP;
			const id = actionId('keys', primary.caption);
			actions.push({ type: 'ExpressionEvaluator', id, name: `Link keys of ${primary.caption}`, dependsOn: [current], settings: { ...ETL_SETTINGS }, expressions: pHelpers, gui: { x, y: 50 } });
			current = id;
			helpers.push(...pHelpers.map((h) => h.fieldName));
		}
		x = Math.max(x, 50 + 2 * X_STEP) + X_STEP;
		const joinId = actionId('join', secondary.caption);
		actions.push({
			type: 'MergeJoin',
			id: joinId,
			name: `Blend ${secondary.caption}`,
			dependsOn: [current, groupId],
			step1: current,
			step2: groupId,
			joinType: keys1.length ? 'LEFT OUTER' : 'CROSS',
			keys1,
			keys2,
			schemaModification1: [],
			schemaModification2: keys2.map((name) => ({ name, rename: name, remove: true })),
			gui: { x, y: 50 }
		});
		current = joinId;
		if (onceColumns.length) {
			// Each link value is kept on one row of its link group, so cards can re-aggregate per-link values without repeats.
			const row = uniqueName(`_t2d_link_row_${index + 1}`, taken);
			x += X_STEP;
			const windowId = actionId('window', secondary.caption);
			actions.push({
				type: 'WindowAction',
				id: windowId,
				name: `One row per ${secondary.caption} link`,
				dependsOn: [current],
				groupRules: [...keys1, ...grainKeys].map((column) => ({ column, caseSensitive: false })),
				orderRules: [...keys1, ...grainKeys].map((column) => ({ column, caseSensitive: false, ascending: true })),
				additions: [{ name: row, operation: { type: 'RANKING', operationType: 'ROW_NUMBER' } }],
				gui: { x, y: 50 }
			});
			x += X_STEP;
			const onceId = actionId('once', secondary.caption);
			actions.push({
				type: 'ExpressionEvaluator',
				id: onceId,
				name: `${secondary.caption} once per link`,
				dependsOn: [windowId],
				settings: { ...ETL_SETTINGS },
				expressions: onceColumns.map((c) => ({ fieldName: c.output, expression: `CASE WHEN \`${row}\` = 1 THEN \`${c.value}\` END` })),
				gui: { x, y: 50 }
			});
			current = onceId;
			helpers.push(row, ...onceColumns.map((c) => c.value));
		}
		joinedLabels.push(`'${secondary.caption}' on ${s.links.length ? linkLabel(s) : 'no link (one total row)'}`);
	}
	if (!joinedLabels.length) return { ok: false, issues };
	if (helpers.length) {
		x += X_STEP;
		const id = actionId('drop', 'link keys');
		actions.push({ type: 'Metadata', id, name: 'Drop link keys', dependsOn: [current], fields: helpers.map((name) => ({ name, remove: true })), gui: { x, y: 50 } });
		current = id;
	}
	actions.push({ type: 'PublishToVault', id: 'out-output', name: outputName, dependsOn: [current], dataSource: { guid: '', name: outputName, description }, versionChainType: 'REPLACE', gui: { x: x + X_STEP, y: 50 } });

	const flowName = `${prefix}${caption} (Tableau blend)`;
	const dataflow = {
		key,
		name: flowName,
		definition: { name: flowName, description, databaseType: 'MAGIC', runState: 'ENABLED', engineProperties: { 'kettle.mode': 'STRICT' }, gui: {}, actions },
		outputDatasetKeys: [key],
		runAfterCreate: true
	};
	const dataset = { key, name: outputName, description, strategy: 'dataflow-output', sourceStrategy: primaryTarget.sourceStrategy ?? primaryTarget.strategy, schema, dataflowOutput: { dataflowKey: key, outputName }, datasourceId: blendId, cardTarget: true, fieldMap };
	const datasource = {
		id: blendId,
		caption,
		connections: [],
		tables: primary.tables ?? [],
		relationships: primary.relationships ?? [],
		fields: [...fields, ...newFields],
		filters: primary.filters ?? [],
		blend: { primary: primary.id, secondaries: secondaries.map((s) => s.secondary.id) }
	};

	const sheetNames = group.sheets.map((s) => s.ws.name);
	issues.push(
		issue(
			'info',
			'blend.joined',
			`Worksheet(s) ${sheetNames.join(', ')} blend ${joinedLabels.join(' and ')} into '${primary.caption}'. Magic ETL dataflow '${flowName}' aggregates each secondary to its link fields (measures with their pill aggregation, dimensions as ATTR: the value, or '*' when a link value has several) and left-joins it onto every row of '${primary.caption}'; the cards read '${outputName}' and show blended measures as MAX of the per-link value${secondaries.some((s) => s.mode === 'once') ? ' (re-aggregated per mark where a link is not in the view)' : ''}.`,
			{ type: 'datasource', name: caption, id: blendId }
		)
	);
	for (const { ws, links, shownSecondary, secondaryFilters, mapped, foldedNames } of perSheet) {
		if (foldedNames.length) {
			issues.push(issue('info', 'blend.secondary-filter-folded', `Filter(s) on blended field(s) ${[...new Set(foldedNames)].join(', ')} restrict the secondary rows before the dataflow aggregates them, as in Tableau`, sheetObject(ws)));
		}
		for (const s of links.filter((l) => l.joined)) {
			const shownItems = shownSecondary.get(s.secondary.id) ?? [];
			const outside = s.links.filter((l) => !l.inView);
			if (!s.links.length) {
				issues.push(issue('warning', 'blend.no-links', `No blend link to '${s.secondary.caption}' is active on this worksheet, so the secondary is aggregated to one total row joined onto every row`, sheetObject(ws), 'Check the linking fields in Tableau; add the link field to the view or edit the dataflow join.'));
			} else if (outside.length) {
				const names = outside.map((l) => graphOf(s.secondary).lookupField(l.secondary)?.name ?? stripBrackets(l.secondary)).join(', ');
				const dims = shownItems.some((i) => i.kind === 'dim') ? `; blended dimensions split the rows instead of showing '*'` : '';
				issues.push(
					issue(
						'warning',
						'blend.link-not-in-view',
						`The blend on ${names} is not in the view, so Tableau aggregates '${s.secondary.caption}' per link value and then again for each mark. The dataflow keeps each per-link measure on one row per link value and mark (the primary dimensions in the view) and the card re-aggregates them (SUM for sums and counts, AVG, MIN, MAX; aggregated calcs read MAX); a card filter on a primary field that is neither a link nor in the view can drop that row${dims}`,
						sheetObject(ws),
						`Keep card filters on the link fields (${names}), or add them to the card.`
					)
				);
			}
		}
		if (secondaryFilters.length) {
			issues.push(
				issue(
					'warning',
					'blend.secondary-filter',
					`Filter(s) on blended field(s) ${[...new Set(secondaryFilters)].join(', ')} filter the card rows by their per-link value; Tableau filters the secondary rows before aggregating them`,
					sheetObject(ws)
				)
			);
		}
		if (mapped.length) issues.push(issue('info', 'blend.filter-mapped', `Filters on blended link fields apply to the linked fields of '${primary.caption}': ${[...new Set(mapped)].join(', ')}`, sheetObject(ws)));
	}
	for (const s of secondaries) {
		if ((s.secondary.filters ?? []).length) {
			issues.push(issue('warning', 'blend.secondary-datasource-filters', `Datasource filters of '${s.secondary.caption}' are not applied before it is aggregated for the blend`, { type: 'datasource', name: s.secondary.caption, id: s.secondary.id }, 'Add a Filter tile before the Group By in the blend dataflow.'));
		}
	}
	const params2 = (ir.parameters ?? []).length && [...items.values()].some((b) => [...b.values()].some((i) => /\[Parameters\]\./.test(i.text)));
	if (params2) {
		issues.push(issue('warning', 'calc.materialized-parameter', `Blended values of ${captions.join(', ')} use parameters at their current value; changing them in Domo does not recompute the blend columns.`, { type: 'datasource', name: caption, id: blendId }));
	}
	return { ok: true, datasource, dataset, dataflow, sheets: movedSheets, params, issues };
}
