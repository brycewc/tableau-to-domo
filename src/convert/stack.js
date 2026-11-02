import { ref } from '../util/refs.js';
import { beastModeLegacyId, slugify } from '../util/ids.js';
import { refreshesOnUpdate } from './etl.js';
import { buildCardBody } from './cards.js';

/**
 * Crosstabs stacked on a dashboard as one table (Tableau's "Dyn Open / Dyn Main / Dyn End" waterfall tables: one tiled
 * column of pivots over the same column headers, the lower ones hiding them) merged into one Domo pivot. Each source row
 * feeds one row of every section, so the card reads a union of the dataset with one copy per section (`t2d_section`).
 */

export const SECTION_COLUMN = 't2d_section';
const PIVOT = 'badge_pivot_table';
const EDGE = 0.005;
const LEGACY_ID = /calculation_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const CARD_FORMULA = /^calculation_card_\d+$/;
const STRING_LITERAL = /^\s*(?:"([^"]*)"|'([^']*)')\s*$/;
const NUMERIC = /^(numeric|long|double|decimal|integer)$/i;
const AGGREGATE_SQL = { SUM: 'SUM', AVG: 'AVG', MIN: 'MIN', MAX: 'MAX', COUNT: 'COUNT' };
const COMPARISONS = { EQUALS: '=', NOT_EQUALS: '<>', GREAT_THAN_EQUALS_TO: '>=', LESS_THAN_EQUALS_TO: '<=', GREATER_THAN: '>', LESS_THAN: '<' };
const X_STEP = 220;
const Y_STEP = 120;
// Phoenix pivot: about 28px a header or body line, plus the card chrome.
const PIVOT_LINE_PX = 28;
const PIVOT_CHROME_PX = 48;
const UNKNOWN_MEMBERS = 6;

const near = (a, b) => Math.abs(a - b) <= EDGE;
const tick = (name) => `\`${String(name).replace(/`/g, '``')}\``;
const section = tick(SECTION_COLUMN);
const mainOf = (card) => card.body?.definition?.subscriptions?.main;
const refOf = (c) => (c.formulaId ? { column: c.formulaId, formulaId: c.formulaId } : { column: c.column });
const sameRef = (a, b) => (a.formulaId ?? a.column) === (b.formulaId ?? b.column);

function sqlLiteral(v, dataType) {
	if (NUMERIC.test(String(dataType ?? '')) && v !== '' && Number.isFinite(Number(v))) return String(Number(v));
	return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function issue(severity, code, message, name) {
	return { severity, code, message, object: { type: 'worksheet', name } };
}

function fieldOf(ir, ws, pillId) {
	const pill = ws.pills?.[pillId];
	if (!pill) return undefined;
	return (ir.datasources ?? []).find((d) => d.id === pill.datasourceId)?.fields?.find((f) => f.id === pill.fieldId);
}

/** The constant label of a sheet's row header (`"Opening"`), and the members Tableau lists for it (manual sort, include filter). */
function rowMembers(ir, ws) {
	const pillId = ws.rowPills[0];
	const field = fieldOf(ir, ws, pillId);
	const m = STRING_LITERAL.exec(field?.formula ?? '');
	const label = m ? (m[1] ?? m[2]) : undefined;
	const listed = new Set();
	for (const s of ws.sorts ?? []) if (s.pillId === pillId && s.kind === 'manual') for (const v of s.order ?? []) if (v !== null && v !== undefined) listed.add(String(v));
	const include = (ws.filters ?? []).find((f) => f.kind === 'categorical' && f.fieldId === field?.id && f.include?.length)?.include;
	const shown = include ? [...listed].filter((v) => include.includes(v)) : [...listed];
	return { label, listed: new Set([...listed, ...(include ?? []).map(String)]), count: label !== undefined ? 1 : (shown.length || include?.length || UNKNOWN_MEMBERS) };
}

/** A pivot card with one row header, one value and the shared column headers, nothing that would split a section's cells. */
function candidate(card, ws) {
	if (!card || !ws || card.chartType !== PIVOT || card.status === 'unsupported' || card.split || card.spread) return false;
	if ((ws.datasourceIds ?? []).length !== 1 || (ws.rowPills ?? []).length !== 1 || /Measure Names/.test(ws.rowPills[0])) return false;
	if (ws.totals && Object.values(ws.totals).some((v) => (Array.isArray(v) ? v.length : v === true))) return false;
	const main = mainOf(card);
	if (!main || main.dateGrain) return false;
	const count = (mapping) => main.columns.filter((c) => c.mapping === mapping).length;
	if (count('ROW') !== 1 || count('VALUE') !== 1 || count('COLUMN') + 2 !== main.columns.length) return false;
	const allowed = main.columns.filter((c) => c.mapping !== 'VALUE');
	return main.groupBy.every((g) => allowed.some((c) => sameRef(c, g)));
}

const topFilters = (ws) => JSON.stringify((ws.filters ?? []).filter((f) => f.kind === 'top'));
const valueFormat = (card) => JSON.stringify(mainOf(card).columns.find((c) => c.mapping === 'VALUE').format ?? null);
const headerColumns = (card) => JSON.stringify(mainOf(card).columns.filter((c) => c.mapping === 'COLUMN').map(refOf));

function joins(ir, chain, next) {
	const head = chain[0];
	if (next.ws.datasourceIds[0] !== head.ws.datasourceIds[0] || next.card.datasetKey !== head.card.datasetKey) return false;
	if (JSON.stringify(next.ws.colPills ?? []) !== JSON.stringify(head.ws.colPills ?? [])) return false;
	const hidden = new Set(next.ws.hiddenHeaders ?? []);
	if (!(next.ws.colPills ?? []).every((p) => hidden.has(p))) return false;
	if (headerColumns(next.card) !== headerColumns(head.card) || valueFormat(next.card) !== valueFormat(head.card)) return false;
	if (topFilters(next.ws) !== topFilters(head.ws) || (mainOf(next.card).limit ?? null) !== (mainOf(head.card).limit ?? null)) return false;
	if (JSON.stringify(mainOf(next.card).dateRangeFilter ?? null) !== JSON.stringify(mainOf(head.card).dateRangeFilter ?? null)) return false;
	const rows = [...chain, next].map((m) => rowMembers(ir, m.ws));
	return rows.every((r, i) => r.label === undefined || rows.every((o, j) => i === j || (o.label !== r.label && !o.listed.has(r.label))));
}

/**
 * Stacks of crosstab zones per dashboard: tiled worksheet zones over the same x and width, each top on the previous
 * bottom, with the same datasource, column headers, single row header, value format and top filters; the lower ones hide
 * their column headers. Keyed by the ordered sheet names, so a stack on two dashboards is one.
 * @returns {Map<string, { sheets: string[], members: { card: Object, ws: Object }[], placements: { dashboard: Object, zones: Object[] }[] }>}
 */
export function findCrosstabStacks(ir, cards) {
	const bySheet = new Map(cards.filter((c) => c.worksheet).map((c) => [c.worksheet, c]));
	const sheets = new Map((ir.worksheets ?? []).map((w) => [w.name, w]));
	const stacks = new Map();
	for (const dashboard of ir.dashboards ?? []) {
		const zones = (dashboard.zones ?? [])
			.filter((z) => z.kind === 'worksheet' && !z.floating && z.rect && candidate(bySheet.get(z.worksheet), sheets.get(z.worksheet)))
			.map((zone) => ({ zone, card: bySheet.get(zone.worksheet), ws: sheets.get(zone.worksheet) }))
			.sort((a, b) => a.zone.rect.y - b.zone.rect.y || a.zone.rect.x - b.zone.rect.x);
		const used = new Set();
		for (const head of zones) {
			const hidden = new Set(head.ws.hiddenHeaders ?? []);
			if (used.has(head) || !(head.ws.colPills ?? []).length || head.ws.colPills.some((p) => hidden.has(p))) continue;
			const chain = [head];
			for (;;) {
				const last = chain.at(-1).zone.rect;
				const next = zones.find((m) => !used.has(m) && !chain.includes(m) && near(m.zone.rect.x, last.x) && near(m.zone.rect.w, last.w) && near(m.zone.rect.y, last.y + last.h));
				if (!next || chain.some((m) => m.ws === next.ws) || !joins(ir, chain, next)) break;
				chain.push(next);
			}
			if (chain.length < 2) continue;
			for (const m of chain) used.add(m);
			const names = chain.map((m) => m.ws.name);
			const key = names.join('\u0000');
			if (!stacks.has(key)) stacks.set(key, { sheets: names, members: chain.map(({ card, ws }) => ({ card, ws })), placements: [] });
			stacks.get(key).placements.push({ dashboard, zones: chain.map((m) => m.zone) });
		}
	}
	return stacks;
}

/** SQL of a member card's column reference: a dataset column, an inlined dataset beast mode or a card formula. */
function expressionOf(c, member, ctx) {
	if (c.calendar) return undefined;
	const id = c.formulaId ?? c.column;
	const formula = (member.card.body.definition.formulas?.card ?? []).find((f) => f.id === id);
	if (formula) return { sql: `(${formula.formula})`, aggregated: Boolean(formula.aggregated), dataType: formula.dataType };
	const bm = ctx.beastModes.get(id);
	if (bm) return { sql: `(${bm.expression})`, aggregated: Boolean(bm.aggregated), dataType: bm.dataType };
	if (CARD_FORMULA.test(id) || /^calculation_[0-9a-f-]{36}$/.test(id)) return undefined;
	return { sql: tick(c.column), aggregated: false, dataType: ctx.schema.get(c.column) };
}

function measureOf(c, member, ctx) {
	const e = expressionOf(c, member, ctx);
	if (!e) return undefined;
	if (e.aggregated) return e.sql;
	const agg = String(c.aggregation ?? 'SUM').toUpperCase();
	if (agg === 'COUNT_DISTINCT') return `COUNT(DISTINCT ${e.sql})`;
	return AGGREGATE_SQL[agg] ? `${AGGREGATE_SQL[agg]}(${e.sql})` : undefined;
}

/** A row-level SQL condition equal to a card filter, or undefined when it is not one (aggregated, unknown operand). */
function filterCondition(f, member, ctx) {
	if (f.aggregation) return undefined;
	const e = expressionOf(f, member, ctx);
	if (!e || e.aggregated) return undefined;
	const values = f.values ?? [];
	const lits = (vs) => vs.map((v) => sqlLiteral(v, f.dataType)).join(', ');
	const text = String(f.dataType ?? '').toLowerCase() === 'string';
	const date = /^date/i.test(String(f.dataType ?? ''));
	const blank = values.includes('');
	const rest = values.filter((v) => v !== '');
	switch (f.operand) {
		case 'IN':
			if (blank && date) return rest.length ? `(${e.sql} IS NULL OR ${e.sql} IN (${lits(rest)}))` : `${e.sql} IS NULL`;
			return values.length ? `${e.sql} IN (${lits(values)})` : undefined;
		case 'NOT_IN':
			if (blank && !text) return rest.length ? `(${e.sql} IS NOT NULL AND ${e.sql} NOT IN (${lits(rest)}))` : `${e.sql} IS NOT NULL`;
			return values.length ? `${e.sql} NOT IN (${lits(values)})` : undefined;
		case 'BETWEEN':
		case 'NOT_BETWEEN':
			return values.length === 2 ? `${e.sql} ${f.operand === 'BETWEEN' ? '' : 'NOT '}BETWEEN ${sqlLiteral(values[0], f.dataType)} AND ${sqlLiteral(values[1], f.dataType)}` : undefined;
		default:
			return COMPARISONS[f.operand] && values.length === 1 ? `${e.sql} ${COMPARISONS[f.operand]} ${sqlLiteral(values[0], f.dataType)}` : undefined;
	}
}

/** A filter keyed by what it does: a card formula filter by its formula, since every card numbers its own. */
function filterKey(f, member) {
	const formula = (member.card.body.definition.formulas?.card ?? []).find((x) => x.id === f.column);
	return JSON.stringify(formula ? { ...f, column: `formula:${formula.formula}:${formula.aggregated}` } : f);
}

function sectionCase(parts, { aggregated = false, fallback } = {}) {
	const at = aggregated ? `MAX(${section})` : section;
	const whens = parts.map((sql, i) => (sql === undefined ? '' : `WHEN ${at} = ${i + 1} THEN ${sql}`)).filter(Boolean);
	return `CASE ${whens.join(' ')}${fallback !== undefined ? ` ELSE ${fallback}` : ''} END`;
}

function cloneBeastModes(members, ctx, stackKey, datasetKey) {
	const clones = new Map();
	const visit = (text) => {
		for (const id of String(text).match(LEGACY_ID) ?? []) {
			const bm = ctx.beastModes.get(id);
			if (!bm || clones.has(id)) continue;
			clones.set(id, null);
			visit(bm.expression);
			clones.set(id, bm);
		}
	};
	for (const m of members) visit(JSON.stringify(m.card.body));
	const ids = new Map([...clones.values()].map((bm) => [bm.legacyId, beastModeLegacyId('stack', stackKey, bm.legacyId)]));
	const rewrite = (text) => String(text).replace(LEGACY_ID, (id) => ids.get(id) ?? id);
	const planned = [...clones.values()].map((bm) => ({
		key: `${bm.key}@${stackKey}`,
		datasetKey,
		name: bm.name,
		legacyId: ids.get(bm.legacyId),
		expression: rewrite(bm.expression),
		aggregated: bm.aggregated,
		...(bm.dataType ? { dataType: bm.dataType } : {}),
		tableauFieldId: bm.tableauFieldId,
		tableauFormula: bm.tableauFormula,
		status: bm.status,
		features: [...(bm.features ?? [])]
	}));
	return { planned, rewrite };
}

/** Union of the card dataset with one copy per section: a second output of its Magic ETL flow, else a flow of its own. */
function planUnion(target, sections, { dataflows, workbookKey, slug, name, description, prefix }) {
	const outputName = name;
	const flow = target.strategy === 'dataflow-output' && !target.shared ? dataflows.find((df) => df.key === target.dataflowOutput?.dataflowKey) : undefined;
	const used = new Set(flow?.definition.actions.map((a) => a.id) ?? []);
	const unique = (base) => {
		let id = base;
		let n = 2;
		while (used.has(id)) id = `${base}-${n++}`;
		used.add(id);
		return id;
	};
	let root;
	let actions;
	let y = 50;
	let x = 50;
	if (flow) {
		const publish = flow.definition.actions.find((a) => a.type === 'PublishToVault' && a.name === target.dataflowOutput.outputName);
		if (!publish?.dependsOn?.length) return undefined;
		root = publish.dependsOn[0];
		const rootAction = flow.definition.actions.find((a) => a.id === root);
		x = rootAction?.gui?.x ?? x;
		y = Math.max(...flow.definition.actions.map((a) => a.gui?.y ?? 0)) + Y_STEP;
		actions = flow.definition.actions;
	} else {
		root = unique('in-source');
		actions = [
			{
				type: 'LoadFromVault',
				id: root,
				name: target.name,
				dataSourceId: ref('dataset', target.key),
				executeFlowWhenUpdated: refreshesOnUpdate(target) || target.strategy === 'dataflow-output',
				onlyLoadNewVersions: false,
				truncateTextColumns: false,
				truncateRows: false,
				gui: { x, y }
			}
		];
	}
	const branches = sections.map((label, i) => {
		const id = unique(`stack-${slug}-section-${i + 1}`);
		actions.push({ type: 'ExpressionEvaluator', id, name: `Section ${i + 1}: ${label}`, dependsOn: [root], settings: { zoneId: 'UTC' }, expressions: [{ fieldName: SECTION_COLUMN, expression: String(i + 1) }], gui: { x: x + X_STEP, y: y + i * Y_STEP } });
		return id;
	});
	const union = unique(`stack-${slug}-union`);
	actions.push({ type: 'UnionAll', id: union, name: 'Stack sections', dependsOn: branches, schemaSource: branches[0], unionType: 'INCLUDE_ALL', strict: false, gui: { x: x + 2 * X_STEP, y } });
	actions.push({ type: 'PublishToVault', id: unique(`out-stack-${slug}`), name: outputName, dependsOn: [union], dataSource: { guid: '', name: outputName, description }, versionChainType: 'REPLACE', gui: { x: x + 3 * X_STEP, y } });
	if (flow) return { flow, created: false };
	const key = `${target.shared ? `${workbookKey}.${slugify(target.name)}` : target.key}.stack-${slug}.etl`;
	const flowName = `${prefix}${target.name} (stacked crosstab)`;
	return {
		flow: { key, name: flowName, definition: { name: flowName, description, databaseType: 'MAGIC', runState: 'ENABLED', engineProperties: { 'kettle.mode': 'STRICT' }, gui: {}, actions }, outputDatasetKeys: [], runAfterCreate: true },
		created: true
	};
}

/** The merged pivot of one stack, or a reason it cannot be one. */
function mergeStack(stack, ctx, { datasetKey, keepLegacyId, rewrite, title }) {
	const { members } = stack;
	const head = members[0];
	const headMain = mainOf(head.card);
	const formulas = [];
	const addFormula = (name, formula, { aggregated, dataType = 'numeric' }) => {
		const id = `calculation_card_${formulas.length + 1}`;
		formulas.push({ id, name, formula: rewrite(formula), templateId: -1, status: 'VALID', dataType, isCalculation: true, aggregated, persistedOnDataSource: false });
		return id;
	};

	const rows = [];
	const values = [];
	for (const m of members) {
		const main = mainOf(m.card);
		const row = main.columns.find((c) => c.mapping === 'ROW');
		const r = expressionOf(row, m, ctx);
		if (!r || r.aggregated) return { reason: `the row header of ${m.ws.name} is not a row-level field` };
		if (r.dataType && !/^string$/i.test(String(r.dataType))) return { reason: `the row header of ${m.ws.name} is not text` };
		rows.push(r.sql);
		const v = measureOf(main.columns.find((c) => c.mapping === 'VALUE'), m, ctx);
		if (!v) return { reason: `the value of ${m.ws.name} has no SQL form` };
		values.push(v);
	}
	const rowId = addFormula('Section row', sectionCase(rows), { aggregated: false, dataType: 'string' });
	const headValue = headMain.columns.find((c) => c.mapping === 'VALUE');
	const valueId = addFormula('Section value', sectionCase(values, { aggregated: true }), { aggregated: true });
	const columnHeaders = headMain.columns.filter((c) => c.mapping === 'COLUMN');

	const scoped = scopedCopies(members);
	const bodyFilters = members.map((m, i) => mainOf(m.card).filters.filter((f) => !scoped.skip[i].has(JSON.stringify(f))));
	const keys = members.map((m, i) => bodyFilters[i].map((f) => filterKey(f, m)));
	const shared = bodyFilters[0].filter((f, i) => keys.every((k) => k.includes(keys[0][i])));
	const conditions = [];
	for (const [i, m] of members.entries()) {
		const own = bodyFilters[i].filter((f, j) => !keys.every((k) => k.includes(keys[i][j])));
		const sql = [];
		for (const f of own) {
			const c = filterCondition(f, m, ctx);
			if (!c) return { reason: `the filter on ${f.column} of ${m.ws.name} is not a row-level condition and the other sections do not share it` };
			sql.push(c);
		}
		conditions.push(sql.length ? `CASE WHEN ${sql.join(' AND ')} THEN 'true' ELSE 'false' END` : "'true'");
	}
	const filters = shared.map((f) => {
		const formula = (head.card.body.definition.formulas?.card ?? []).find((x) => x.id === f.column);
		if (!formula) return { ...f, column: rewrite(f.column) };
		const id = addFormula(formula.name, formula.formula, { aggregated: Boolean(formula.aggregated), dataType: formula.dataType });
		return { ...f, column: id };
	});
	const scopedFilters = scoped.copies.map((copy) => {
		const fixed = copy.filters.map((f) => ({ ...f, column: rewrite(f.column) }));
		filters.push(...fixed);
		return { pillId: copy.pillId, default: copy.default, filters: fixed };
	});
	const keep = conditions.some((c) => c !== "'true'") ? rewrite(sectionCase(conditions, { fallback: "'false'" })) : undefined;
	if (keep) filters.push({ column: keepLegacyId, operand: 'IN', values: ['true'], dataType: 'string' });

	// Phoenix lists pivot row members as they first appear in the query rows, so sections and their own sorts go first.
	const orderBy = [{ column: addFormula('Section', `MIN(${section})`, { aggregated: true }), order: 'ASCENDING' }];
	orderBy[0].formulaId = orderBy[0].column;
	const lead = [];
	const directions = new Set();
	for (const [i, m] of members.entries()) {
		const main = mainOf(m.card);
		const row = main.columns.find((c) => c.mapping === 'ROW');
		const at = main.orderBy.findIndex((o) => sameRef(o, row));
		if (rowMembers(ctx.ir, m.ws).label === undefined && at >= 0) directions.add(main.orderBy[at].order);
		for (const [p, o] of main.orderBy.slice(0, Math.max(0, at)).entries()) {
			const e = expressionOf(o, m, ctx);
			if (!e) return { reason: `a sort of ${m.ws.name} has no SQL form` };
			if (!NUMERIC.test(String(e.dataType ?? '')) && o.aggregation === undefined && !e.aggregated) return { reason: `a sort of ${m.ws.name} is not numeric` };
			const sql = e.aggregated ? e.sql : `${String(o.aggregation ?? 'MIN').toUpperCase()}(${e.sql})`;
			(lead[p] ??= [])[i] = o.order === 'DESCENDING' ? `-(${sql})` : sql;
		}
	}
	if (directions.size > 1) return { reason: 'the sections sort their rows in opposite directions' };
	for (const parts of lead) {
		const id = addFormula(`Section sort ${orderBy.length}`, `CASE ${parts.map((sql, i) => (sql === undefined ? '' : `WHEN MIN(${section}) = ${i + 1} THEN ${sql}`)).filter(Boolean).join(' ')} END`, { aggregated: true });
		orderBy.push({ column: id, formulaId: id, order: 'ASCENDING' });
	}
	orderBy.push({ column: rowId, formulaId: rowId, order: [...directions][0] ?? 'ASCENDING' });
	const headRow = headMain.columns.find((c) => c.mapping === 'ROW');
	const headAt = headMain.orderBy.findIndex((o) => sameRef(o, headRow));
	const tail = headAt >= 0 ? headMain.orderBy.slice(headAt + 1) : headMain.orderBy.filter((o) => columnHeaders.some((c) => sameRef(c, o)));
	orderBy.push(...tail.map((o) => ({ ...o, column: rewrite(o.column), ...(o.formulaId ? { formulaId: rewrite(o.formulaId) } : {}) })));

	const rowLabels = new Set(members.map((m) => {
		const row = mainOf(m.card).columns.find((c) => c.mapping === 'ROW');
		const id = row.formulaId ?? row.column;
		return ctx.beastModes.get(id)?.name ?? (m.card.body.definition.formulas?.card ?? []).find((f) => f.id === id)?.name ?? row.column;
	}));
	const headOverrides = head.card.body.definition.charts.main.overrides ?? {};
	const sorted = headOverrides.column_sort ? JSON.parse(headOverrides.column_sort).filter((s) => !rowLabels.has(s.column)) : [];
	const overrides = { total_row: 'false', total_col: 'false', subtotal_rows: 'false', subtotal_columns: 'false', ...(sorted.length ? { column_sort: JSON.stringify(sorted) } : {}) };

	const subscription = {
		columns: [{ column: rowId, formulaId: rowId, mapping: 'ROW', alias: ' ' }, ...columnHeaders.map((c) => ({ ...c })), { column: valueId, formulaId: valueId, mapping: 'VALUE', alias: ' ', ...(headValue.format ? { format: headValue.format } : {}) }],
		groupBy: [{ column: rowId, formulaId: rowId }, ...columnHeaders.map(refOf)],
		orderBy,
		filters,
		limit: headMain.limit,
		...(headMain.dateRangeFilter ? { dateRangeFilter: headMain.dateRangeFilter } : {}),
		...(headMain.fiscal ? { fiscal: true } : {})
	};
	const definition = head.card.body.definition;
	const body = buildCardBody({ title, titleItems: definition.dynamicTitle?.text, description: definition.description ?? '', dynamicDescription: definition.dynamicDescription, datasetKey, chartType: PIVOT, subscription, formulas, overrides });
	return { body, keep, scopedFilters };
}

const selectionKey = (d) => JSON.stringify([d.column, d.operand, d.values]);

/**
 * A dashboard filter every section selects the same, as a quick filter default on one and a fixed copy on the others
 * (CardPlan.scopedFilters), stays one filter of the merged card so the view's default can replace it, not a section row.
 */
function scopedCopies(members) {
	const skip = members.map(() => new Set());
	const copies = [];
	const candidates = new Map();
	for (const m of members) for (const copy of m.card.scopedFilters ?? []) if (copy.default && !candidates.has(selectionKey(copy.default))) candidates.set(selectionKey(copy.default), copy);
	for (const [key, copy] of candidates) {
		const formulaColumn = (m, f) => (m.card.body.definition.formulas?.card ?? []).some((x) => x.id === f.column);
		const own = members.map((m) => (m.card.scopedFilters ?? []).find((c) => c.default && selectionKey(c.default) === key));
		const shown = members.map((m) => (m.card.quickFilterDefaults ?? []).some((d) => selectionKey(d) === key));
		if (!shown.some(Boolean) || !members.every((m, i) => own[i] || shown[i])) continue;
		if (members.some((m, i) => own[i]?.filters.some((f) => formulaColumn(m, f)))) continue;
		for (const [i, c] of own.entries()) for (const f of c?.filters ?? []) skip[i].add(JSON.stringify(f));
		copies.push({ pillId: copy.pillId, default: copy.default, filters: copy.filters });
	}
	return { skip, copies };
}

/**
 * Merge the crosstab stacks of the dashboards into one pivot each, fed by a union of the card dataset with a section
 * column. Mutates `data.datasets`, `data.dataflows` and `data.beastModes` (the arrays that become the plan's), and
 * the member cards: a member whose every dashboard zone is in a stack becomes unsupported with `replacedBy: 'stack'`.
 * A stack that cannot be merged keeps its cards.
 *
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {import('../model/types.js').CardPlan[]} cards
 * @param {{ datasets: Object[], dataflows: Object[], beastModes: Object[] }} data
 * @param {{ workbookKey?: string, options?: Object }} [opts]
 * @returns {{ cards: import('../model/types.js').CardPlan[], placements: Map<string, { card: Object, zones: Object[], head: boolean, rows: number }>, issues: Object[] }}
 *   placements: `${dashboard name}\u0000${zone id}` -> the merged card, its zones and whether this is the head zone
 */
export function planCrosstabStacks(ir, cards, data, { workbookKey, options = {} } = {}) {
	const issues = [];
	const merged = [];
	const placements = new Map();
	const stacks = findCrosstabStacks(ir, cards);
	if (!stacks.size) return { cards: merged, placements, issues };
	const prefix = options.namePrefix ?? '';
	const usedKeys = new Set(data.datasets.map((d) => d.key));
	for (const stack of stacks.values()) {
		const head = stack.members[0];
		const names = stack.sheets.join(', ');
		const target = data.datasets.find((d) => d.key === head.card.datasetKey);
		if (!target) continue;
		const stackKey = slugify(stack.sheets.join(' '));
		let slug = slugify(stack.sheets[0]);
		let datasetKey = `${target.shared ? `${workbookKey}.${slugify(target.name)}` : target.key}.stack-${slug}`;
		for (let n = 2; usedKeys.has(datasetKey); n++) datasetKey = `${datasetKey.replace(/-\d+$/, '')}-${n}`;
		slug = datasetKey.slice(datasetKey.lastIndexOf('.stack-') + '.stack-'.length);
		const ctx = { ir, beastModes: new Map(data.beastModes.filter((bm) => bm.datasetKey === target.key).map((bm) => [bm.legacyId, bm])), schema: new Map((target.schema ?? []).map((c) => [c.name, c.type])) };
		const { planned, rewrite } = cloneBeastModes(stack.members, ctx, stackKey, datasetKey);
		const keepLegacyId = beastModeLegacyId('stack', stackKey, 'rows');
		const title = head.card.title;
		const result = mergeStack(stack, ctx, { datasetKey, keepLegacyId, rewrite, title });
		if (result.reason) {
			issues.push(issue('info', 'card.crosstab-stack', `${names} are stacked as one table in Tableau but stay separate cards: ${result.reason}`, head.ws.name));
			continue;
		}
		const name = `${target.name}, stacked for ${names}`;
		const description = `'${target.name}' once per section of the merged table ${names} (${SECTION_COLUMN} 1 to ${stack.members.length}).`;
		const union = planUnion(target, stack.sheets, { dataflows: data.dataflows, workbookKey, slug, name, description, prefix });
		if (!union) {
			issues.push(issue('info', 'card.crosstab-stack', `${names} are stacked as one table in Tableau but stay separate cards: the dataflow of '${target.name}' has no output to stack`, head.ws.name));
			continue;
		}
		union.flow.outputDatasetKeys.push(datasetKey);
		if (union.created) data.dataflows.push(union.flow);
		usedKeys.add(datasetKey);
		data.datasets.push({
			key: datasetKey,
			name,
			description,
			strategy: 'dataflow-output',
			sourceStrategy: target.strategy === 'dataflow-output' ? (target.sourceStrategy ?? target.strategy) : target.strategy,
			schema: [...(target.schema ?? []).map((c) => ({ ...c })), { name: SECTION_COLUMN, type: 'LONG' }],
			dataflowOutput: { dataflowKey: union.flow.key, outputName: name },
			...(target.datasourceId ? { datasourceId: target.datasourceId } : {}),
			cardTarget: false,
			fieldMap: { ...(target.fieldMap ?? {}) }
		});
		data.beastModes.push(...planned);
		if (result.keep) {
			data.beastModes.push({ key: `${datasetKey}.stack-rows`, datasetKey, name: `${title} (section rows)`, legacyId: keepLegacyId, expression: result.keep, aggregated: false, dataType: 'STRING', tableauFieldId: '', tableauFormula: '', status: 'ok', features: [] });
		}

		const approximate = stack.members.some((m) => m.card.status === 'approximate');
		const defaults = [];
		for (const d of stack.members.flatMap((m) => m.card.quickFilterDefaults ?? [])) {
			const own = { ...d, ...(d.formulaId ? { formulaId: rewrite(d.formulaId), column: rewrite(d.column) } : {}) };
			if (!defaults.some((x) => selectionKey(x) === selectionKey(own))) defaults.push(own);
		}
		const card = {
			key: `${workbookKey ? `${workbookKey}.` : ''}stack-${stackKey}`,
			title,
			worksheet: '',
			datasetKey,
			chartType: PIVOT,
			body: result.body,
			pageKeys: [],
			status: approximate ? 'approximate' : 'ok',
			stack: { sheets: [...stack.sheets], datasetKey }
		};
		if (defaults.length) card.quickFilterDefaults = defaults;
		const fiscalCalendar = stack.members.find((m) => m.card.fiscalCalendar)?.card.fiscalCalendar;
		if (fiscalCalendar) card.fiscalCalendar = { ...fiscalCalendar };
		if (result.scopedFilters.length) card.scopedFilters = result.scopedFilters;
		merged.push(card);
		const rows = stack.members.reduce((n, m) => n + rowMembers(ir, m.ws).count, 0);
		for (const { dashboard, zones } of stack.placements) for (const [i, zone] of zones.entries()) placements.set(`${dashboard.name}\u0000${zone.id}`, { card, zones, head: i === 0, rows, headers: head.ws.colPills.length });
		issues.push(issue('info', 'card.crosstab-stack', `${names} are stacked as one table in Tableau; merged into one pivot over '${name}', ${stack.members.length} copies of '${target.name}' told apart by ${SECTION_COLUMN}`, head.ws.name));

		const absorbed = new Set([...placements.keys()]);
		for (const m of stack.members) {
			const zones = (ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])].filter((z) => z.kind === 'worksheet' && z.worksheet === m.ws.name).map((z) => `${d.name}\u0000${z.id}`));
			if (zones.length && zones.every((z) => absorbed.has(z))) Object.assign(m.card, { status: 'unsupported', replacedBy: 'stack', stackedInto: card.key });
		}
	}
	return { cards: merged, placements, issues };
}

/**
 * Pixel height of a merged stack: its header and body lines.
 * @param {{ rows: number, headers: number }} placement
 */
export function stackHeightPx(placement) {
	return (placement.headers + 1 + placement.rows) * PIVOT_LINE_PX + PIVOT_CHROME_PX;
}
