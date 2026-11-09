import { shortHash, slugify } from '../util/ids.js';
import { fixedDatasourceFilters, fixedFilterCondition } from './fixed-filters.js';
import { ref } from '../util/refs.js';
import { dedupeNames, domoColumnName, stripBrackets } from '../model/naming.js';
import { tableauToDomoType } from './schema.js';
import { planConnector, relationParts, isConnectorClass } from './connectors.js';
import { buildJoinDataflow, buildFusionView, magicJoinType, originKey, refreshesOnUpdate } from './etl.js';
import { planDatasourceInitialSql, describeInitialSql, initialSqlBlockedMessage } from './initial-sql.js';
import { buildInitialSqlDataflow } from './initial-sql-etl.js';
import { UNION_CAST_TYPES, aliasDerivedColumns, aliasDerivedTables, anchorConstantUnionColumns, expandStarsOverUnions, aliasUnionBranches, castUnionNulls, inlineCtes, matchColumnCaseFully, projectionNames, rewriteCastTypes, rewriteCollate, rewriteDateAdd, rewriteDateDiff, rewriteFunctions, rewriteUnpivot, stripComments, unsupportedFunctions } from './view-sql.js';

/**
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../model/types.js').TableIR} TableIR
 * @typedef {import('../model/types.js').FieldIR} FieldIR
 * @typedef {import('../model/types.js').DataManifest} DataManifest
 * @typedef {import('../model/types.js').DatasetPlan} DatasetPlan
 * @typedef {import('../model/types.js').DataflowPlan} DataflowPlan
 * @typedef {import('../model/types.js').Issue} Issue
 * @typedef {import('../model/types.js').Mappings} Mappings
 * @typedef {import('./etl.js').JoinNode} JoinNode
 *
 * @typedef {Object} InputColumn
 * @property {string} name
 * @property {string} type
 * @property {string} [sourceName]
 *
 * @typedef {Object} PlannedInput
 * @property {string} id               TableIR id (or a synthetic id when the table is unknown)
 * @property {string} name
 * @property {string} datasetKey
 * @property {TableIR} [table]
 * @property {InputColumn[]} columns
 * @property {DatasetPlan} dataset
 */

const UPLOAD_STRATEGIES = new Set(['hyper', 'published-extract', 'vds', 'view-csv']);

/** Normalize manifests given as an array or a record keyed by datasource id. */
export function manifestIndex(manifests) {
	const index = new Map();
	const list = Array.isArray(manifests) ? manifests : Object.values(manifests ?? {});
	for (const manifest of list) if (manifest?.datasourceId) index.set(manifest.datasourceId, manifest);
	return index;
}

/** Datasources referenced by any worksheet, or all of them when none are. */
export function usedDatasources(ir) {
	const used = new Set((ir.worksheets ?? []).flatMap((w) => w.datasourceIds ?? []));
	const all = ir.datasources ?? [];
	const picked = all.filter((d) => used.has(d.id));
	return picked.length ? picked : all;
}

function lower(value) {
	return String(value ?? '').toLowerCase();
}

/** True when `tableRef` (an id, a name, or a bracketed parent-name) names `table`. */
export function tableMatches(table, tableRef) {
	if (!table || tableRef === undefined || tableRef === null || tableRef === '') return false;
	const wanted = lower(stripBrackets(tableRef));
	const candidates = [table.id, table.name, stripBrackets(table.id)];
	const parts = relationParts(table.table);
	if (parts.length) candidates.push(parts[parts.length - 1], parts.join('.'));
	return candidates.some((c) => c !== undefined && lower(c) === wanted);
}

function findTable(ds, tableRef) {
	return (ds.tables ?? []).find((t) => tableMatches(t, tableRef));
}

/**
 * Physical origin of a column field: owning table id and source column name.
 * @param {DatasourceIR} ds
 * @param {FieldIR} field
 * @returns {{ tableId?: string, remoteName?: string, localName: string }}
 */
export function physicalOf(ds, field) {
	for (const table of ds.tables ?? []) {
		const col = (table.columns ?? []).find((c) => c.localName === field.id);
		if (col) {
			const owner = col.tableId ? findTable(ds, col.tableId) : table;
			return { tableId: (owner ?? table).id, remoteName: col.remoteName, localName: field.id };
		}
	}
	if (field.physical) {
		const owner = field.physical.tableId ? findTable(ds, field.physical.tableId) : undefined;
		return { tableId: owner?.id ?? field.physical.tableId, remoteName: field.physical.remoteName, localName: field.id };
	}
	return { localName: field.id };
}

/**
 * Find the dataset column holding a Tableau column, trying the extract's source
 * name, the Tableau local name, the display name and the remote name, exact first.
 * @param {InputColumn[]} columns
 * @param {{ remoteName?: string, localName?: string, fieldName?: string }} want
 */
export function findInputColumn(columns, { remoteName, localName, fieldName }) {
	const local = localName ? stripBrackets(localName) : undefined;
	const display = fieldName ? domoColumnName(fieldName) : undefined;
	const probes = [
		['sourceName', local],
		['sourceName', remoteName],
		['name', display],
		['name', local],
		['name', remoteName]
	].filter(([, v]) => v);
	for (const [prop, value] of probes) {
		const hit = columns.find((c) => c[prop] === value);
		if (hit) return hit;
	}
	for (const [prop, value] of probes) {
		const hit = columns.find((c) => c[prop] !== undefined && lower(c[prop]) === lower(value));
		if (hit) return hit;
	}
	return undefined;
}

function dsObject(ds) {
	return { type: 'datasource', name: ds.caption || ds.id, id: ds.id };
}

function columnOverride(mappings, ds, field) {
	const columns = mappings?.columns ?? {};
	return columns[`${ds.caption}.${field.name}`] ?? columns[`${ds.id}.${field.name}`];
}

function columnFields(ds) {
	return (ds.fields ?? []).filter((f) => f.kind === 'column');
}

function existingDatasetId(ds, manifest, mappings) {
	if (manifest?.strategy === 'existing' && manifest.existingDatasetId) return manifest.existingDatasetId;
	const map = mappings?.datasets ?? {};
	return map[ds.published?.luid] ?? map[ds.caption] ?? map[ds.id] ?? (ds.published?.name ? map[ds.published.name] : undefined);
}

function uniqueKey(base, used) {
	let key = base;
	let n = 2;
	while (used.has(key)) key = `${base}-${n++}`;
	used.add(key);
	return key;
}

const KEY_FUNCTION = /^\s*([A-Za-z_]+)\s*\(\s*(\[[^()]*\])\s*\)\s*$/;
// Functions a join key may apply that the join dataflow computes into a key column first (etl.js JOIN_KEY_FORMULAS).
const KEY_TRANSFORMS = new Set(['DATE']);

/**
 * A join condition side, which may wrap the column in a function (Tableau relationships and join clauses allow
 * `DATE([Created Date])`): the column with that function as its `transform`. A function t2d cannot compute joins on the
 * bare column with a warning.
 */
function resolveKeySide(ref, ds, inputs, preferred, issues) {
	const m = KEY_FUNCTION.exec(String(ref ?? ''));
	if (!m) return resolveConditionSide(ref, ds, inputs, preferred);
	const side = resolveConditionSide(m[2], ds, inputs, preferred);
	const fn = m[1].toUpperCase();
	if (!side || KEY_TRANSFORMS.has(fn)) return side && { ...side, transform: fn };
	issues.push({ severity: 'warning', code: 'data.join-key-expression', message: `Join key ${ref} applies ${fn}, which t2d does not compute; the join uses ${m[2]} as it is.`, object: dsObject(ds), suggestion: 'Add a Formula tile for the key before the join in the generated Magic ETL dataflow.' });
	return side;
}

/**
 * @param {string} ref       Join condition side, e.g. '[Orders].[Region]' or '[Region (People)]'
 * @param {DatasourceIR} ds
 * @param {Map<string, PlannedInput>} inputs  by TableIR id
 * @param {string[]} preferred                Table ids to try first
 * @returns {import('./etl.js').ColumnRef|undefined}
 */
function resolveConditionSide(ref, ds, inputs, preferred) {
	const parts = relationParts(ref);
	if (!parts.length) return undefined;
	const columnName = parts[parts.length - 1];
	const tableRef = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
	const ordered = [
		...preferred.map((id) => inputs.get(id)).filter(Boolean),
		...[...inputs.values()].filter((i) => !preferred.includes(i.id))
	];
	const bracketed = `[${columnName.replace(/\]/g, ']]')}]`;

	if (tableRef) {
		const input = ordered.find((i) => tableMatches(i.table ?? { id: i.id, name: i.name }, tableRef));
		if (input) {
			const phys = (input.table?.columns ?? []).find(
				(c) => lower(c.remoteName) === lower(columnName) || c.localName === bracketed
			);
			const hit = findInputColumn(input.columns, {
				remoteName: phys?.remoteName ?? columnName,
				localName: phys?.localName
			});
			if (hit) return { tableId: input.id, column: hit.name };
		}
	}

	for (const input of ordered) {
		const phys = (input.table?.columns ?? []).find((c) => c.localName === bracketed);
		if (phys) {
			const owner = phys.tableId ? findTable(ds, phys.tableId) : input.table;
			const target = inputs.get(owner?.id) ?? input;
			const ownerPhys = target === input ? phys : { remoteName: phys.remoteName, localName: phys.localName };
			const hit = findInputColumn(target.columns, ownerPhys);
			if (hit) return { tableId: target.id, column: hit.name };
		}
	}
	const field = (ds.fields ?? []).find((f) => f.id === bracketed && f.kind === 'column');
	if (field) {
		const phys = physicalOf(ds, field);
		const input = phys.tableId ? inputs.get(phys.tableId) ?? ordered.find((i) => tableMatches(i.table, phys.tableId)) : undefined;
		if (input) {
			const hit = findInputColumn(input.columns, { ...phys, fieldName: field.name });
			if (hit) return { tableId: input.id, column: hit.name };
		}
	}
	for (const input of ordered) {
		const hit = findInputColumn(input.columns, { remoteName: columnName, fieldName: columnName });
		if (hit) return { tableId: input.id, column: hit.name };
	}
	return undefined;
}

function subtreeTables(node, into = new Set()) {
	if (node.type === 'input') into.add(node.tableId);
	else if (node.type === 'join') {
		subtreeTables(node.left, into);
		subtreeTables(node.right, into);
	} else node.children.forEach((c) => subtreeTables(c, into));
	return into;
}

/** Legacy physical-layer relation tree -> join tree over planned inputs. */
function treeFromRelation(relation, ds, inputs, issues) {
	if (relation.type === 'table' || relation.type === 'custom-sql') {
		const input = inputs.get(relation.tableId) ?? [...inputs.values()].find((i) => tableMatches(i.table, relation.tableId));
		if (!input) throw new Error(`table '${relation.tableId}' has no extracted data`);
		return { type: 'input', tableId: input.id };
	}
	if (relation.type === 'union') {
		return { type: 'union', children: (relation.children ?? []).map((c) => treeFromRelation(c, ds, inputs, issues)) };
	}
	const [leftRel, rightRel] = relation.children ?? [];
	if (!leftRel || !rightRel) throw new Error('join relation without two inputs');
	const left = treeFromRelation(leftRel, ds, inputs, issues);
	const right = treeFromRelation(rightRel, ds, inputs, issues);
	const leftTables = [...subtreeTables(left)];
	const rightTables = [...subtreeTables(right)];
	const keys = [];
	const constant = (side) => /^(?:-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|TRUE)$/i.test(String(side ?? '').trim());
	if ((relation.on ?? []).length && relation.on.every((c) => constant(c.left) && constant(c.right) && String(c.left).trim() === String(c.right).trim())) {
		return { type: 'join', joinType: 'CROSS', left, right, keys };
	}
	for (const cond of relation.on ?? []) {
		if (cond.op && cond.op !== '=' && cond.op !== '==') {
			issues.push({
				severity: 'warning',
				code: 'data.join-non-equi',
				message: `Join condition ${cond.left} ${cond.op} ${cond.right} is not an equality and was dropped.`,
				object: dsObject(ds),
				suggestion: 'Add a Filter tile after the join in the generated Magic ETL dataflow.'
			});
			continue;
		}
		let l = resolveKeySide(cond.left, ds, inputs, leftTables, issues);
		let r = resolveKeySide(cond.right, ds, inputs, rightTables, issues);
		if (l && r && rightTables.includes(l.tableId) && leftTables.includes(r.tableId)) [l, r] = [r, l];
		if (!l || !r || !leftTables.includes(l.tableId) || !rightTables.includes(r.tableId)) {
			issues.push({
				severity: 'error',
				code: 'data.join-key-unresolved',
				message: `Could not resolve join condition ${cond.left} = ${cond.right} to dataset columns.`,
				object: dsObject(ds)
			});
			continue;
		}
		keys.push({ left: l, right: r });
	}
	return { type: 'join', joinType: magicJoinType(relation.join), left, right, keys };
}

/** Object-model relationships -> left-deep LEFT OUTER join tree from the fact table. */
function treeFromRelationships(ds, inputs, issues) {
	const edges = (ds.relationships ?? [])
		.map((r) => ({
			...r,
			from: inputs.get(r.fromTableId) ?? [...inputs.values()].find((i) => tableMatches(i.table, r.fromTableId)),
			to: inputs.get(r.toTableId) ?? [...inputs.values()].find((i) => tableMatches(i.table, r.toTableId))
		}))
		.filter((e) => {
			if (e.from && e.to) return true;
			issues.push({
				severity: 'error',
				code: 'data.relationship-table-missing',
				message: `Relationship ${e.fromTableId} -> ${e.toTableId} references a table without extracted data.`,
				object: dsObject(ds)
			});
			return false;
		});
	if (!edges.length) return null;

	const degree = new Map();
	for (const e of edges) {
		degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
		degree.set(e.to.id, (degree.get(e.to.id) ?? 0) + 1);
	}
	const order = [...inputs.keys()];
	// The physical join tree is the logical table its relationships attach to; it must stay one unit.
	const rel = ds.relationTree;
	const physical = rel && (rel.type === 'join' || rel.type === 'union') ? treeFromRelation(rel, ds, inputs, issues) : undefined;
	const group = physical ? subtreeTables(physical) : new Set();
	const anchored = physical && edges.some((e) => group.has(e.from.id) || group.has(e.to.id));
	const fact = anchored ? [...group][0] : order.reduce((best, id) => ((degree.get(id) ?? 0) > (degree.get(best) ?? 0) ? id : best), order[0]);

	const visited = anchored ? new Set(group) : new Set([fact]);
	const remaining = [...edges];
	let tree = anchored ? physical : { type: 'input', tableId: fact };
	const sideTables = (input) => (group.has(input.id) ? [...group] : [input.id]);
	let progress = true;
	while (remaining.length && progress) {
		progress = false;
		for (let i = 0; i < remaining.length; i++) {
			const e = remaining[i];
			const fromIn = visited.has(e.from.id);
			const toIn = visited.has(e.to.id);
			if (fromIn && toIn) {
				issues.push({
					severity: 'warning',
					code: 'data.relationship-cycle',
					message: `Relationship ${e.from.name} -> ${e.to.name} closes a cycle and was not applied.`,
					object: dsObject(ds)
				});
				remaining.splice(i--, 1);
				continue;
			}
			if (!fromIn && !toIn) continue;
			const known = fromIn ? e.from : e.to;
			const added = fromIn ? e.to : e.from;
			const visitedIds = [...visited];
			const keys = [];
			for (const cond of e.on ?? []) {
				let l = resolveKeySide(cond.left, ds, inputs, sideTables(e.from), issues);
				let r = resolveKeySide(cond.right, ds, inputs, sideTables(e.to), issues);
				if (!fromIn) [l, r] = [r, l];
				if (l && r && l.tableId === added.id && visitedIds.includes(r.tableId)) [l, r] = [r, l];
				if (!l || !r || !visitedIds.includes(l.tableId) || r.tableId !== added.id) {
					issues.push({
						severity: 'error',
						code: 'data.join-key-unresolved',
						message: `Could not resolve relationship condition ${cond.left} = ${cond.right} (${known.name} -> ${added.name}).`,
						object: dsObject(ds)
					});
					continue;
				}
				keys.push({ left: l, right: r });
			}
			tree = { type: 'join', joinType: 'LEFT OUTER', left: tree, right: { type: 'input', tableId: added.id }, keys };
			visited.add(added.id);
			remaining.splice(i--, 1);
			progress = true;
		}
	}
	const disconnected = order.filter((id) => !visited.has(id));
	if (disconnected.length) {
		issues.push({
			severity: 'warning',
			code: 'data.relationship-disconnected',
			message: `Tables not related to ${inputs.get(fact).name} were left out of the joined dataset: ${disconnected.map((id) => inputs.get(id).name).join(', ')}.`,
			object: dsObject(ds)
		});
	}
	issues.push({
		severity: 'warning',
		code: 'data.relationship-join',
		message: `Tableau relationships in '${ds.caption}' were materialized as LEFT OUTER joins from '${inputs.get(fact).name}'. Tableau picks the join type and level of detail per viz, so measures from the related tables can be duplicated by one-to-many joins.`,
		object: dsObject(ds),
		suggestion: 'Review the join types and check aggregates of measures from non-fact tables.'
	});
	return tree;
}

function connectionFor(ds, table) {
	const conns = ds.connections ?? [];
	return (
		conns.find((c) => c.id === table?.connectionId) ??
		conns.find((c) => isConnectorClass(c.class)) ??
		conns[0]
	);
}

function connectorColumns(table) {
	return (table.columns ?? []).map((c) => ({ name: domoColumnName(c.remoteName), type: tableauToDomoType(c.localType), sourceName: c.remoteName }));
}

/** Streams and Magic ETL for tables that read Initial SQL temp tables; undefined when none do, null when it cannot be translated. */
function planInitialSqlInputs(ds, { name, description, mappings, tableKey, issues, object }) {
	const planned = planDatasourceInitialSql(ds);
	if (!planned.length) return undefined;
	const out = { inputs: new Map(), early: [], flows: [] };
	const seen = new Set();
	const addIssues = (list) => {
		for (const i of list) {
			const k = `${i.code}|${i.message}`;
			if (!seen.has(k)) issues.push(i);
			seen.add(k);
		}
	};
	const multi = (ds.tables ?? []).length > 1;
	for (const { connection, tables: connTables, plan } of planned) {
		if (plan.blocked) {
			issues.push({
				severity: 'error',
				code: 'data.initial-sql-untranslatable',
				message: `${initialSqlBlockedMessage(plan.blocked)} Its DataSet is created empty.`,
				object,
				suggestion: 'Export a snapshot instead: re-run extract and answer e (export) at the data decision, or add "unmapped": { "<datasource>": "export" } to mappings.json.'
			});
			return null;
		}
		if (!plan.tables.size) continue;
		const streamDatasets = new Map();
		const streamDataset = (stream) => {
			if (!streamDatasets.has(stream.id)) {
				const { connector, issues: connIssues } = planConnector(ds, connection, mappings, { table: { kind: 'custom-sql', sql: stream.sql, name: stream.label }, session: plan.session });
				addIssues(connIssues);
				streamDatasets.set(stream.id, {
					key: '',
					name: `${name} - ${stream.label}`,
					description: `${description} Initial SQL ${stream.temp ? `temp table ${stream.temp}` : `query: ${stream.label}`}.`,
					strategy: 'connector',
					schema: [],
					...(connector ? { connector } : {}),
					datasourceId: ds.id,
					cardTarget: false,
					fieldMap: {}
				});
			}
			return streamDatasets.get(stream.id);
		};
		const streamById = new Map(plan.streams.map((s) => [s.id, s]));
		const etlTables = [];
		for (const table of connTables) {
			const tablePlan = plan.tables.get(table.id);
			if (!tablePlan) continue;
			const columns = connectorColumns(table);
			const label = table.name || table.id;
			const datasetName = multi ? `${name} - ${label}` : name;
			let dataset;
			if (tablePlan.kind === 'stream') {
				dataset = streamDataset(streamById.get(tablePlan.stream));
				if (!dataset.schema.length) Object.assign(dataset, { name: datasetName, schema: columns.map((c) => ({ name: c.name, type: c.type })) });
			} else {
				dataset = { key: '', name: datasetName, description, strategy: 'dataflow-output', sourceStrategy: 'connector', schema: columns.map((c) => ({ name: c.name, type: c.type })), dataflowOutput: { dataflowKey: '', outputName: datasetName }, datasourceId: ds.id, cardTarget: false, fieldMap: {} };
				etlTables.push({ dataset, graph: tablePlan.graph });
			}
			out.inputs.set(table.id, { id: table.id, name: label, table, columns, datasetKey: '', dataset });
		}
		const tableDatasets = new Set([...out.inputs.values()].map((i) => i.dataset));
		for (const stream of plan.streams) {
			const dataset = streamDataset(stream);
			if (tableDatasets.has(dataset)) continue;
			dataset.key = tableKey(`sql ${stream.id}`);
			out.early.push(dataset);
		}
		for (const { dataset, graph } of etlTables) {
			out.flows.push({
				finish: () => {
					const dataflowKey = `${dataset.key}.initial-sql`;
					dataset.dataflowOutput.dataflowKey = dataflowKey;
					const streamKeys = new Map([...streamDatasets].map(([id, d]) => [id, d.key]));
					const { definition } = buildInitialSqlDataflow({ name: `${dataset.name} (Initial SQL)`, outputName: dataset.name, description, graph, streamKeys });
					return { key: dataflowKey, name: definition.name, definition, outputDatasetKeys: [dataset.key], runAfterCreate: true };
				}
			});
		}
		const temps = plan.streams.filter((s) => s.temp).map((s) => s.temp);
		const queries = plan.streams.filter((s) => !s.temp).map((s) => s.label);
		issues.push({
			severity: 'info',
			code: 'data.initial-sql',
			message: `The Initial SQL of the ${connection.class} connection (${plan.statements.length} statement(s)) becomes ${plan.streams.length} connector stream(s)${temps.length ? `, one per temp table (${temps.join(', ')})` : ''}${queries.length ? `${temps.length ? ' and' : ','} ${queries.length} over database tables (${queries.join(', ')})` : ''}${etlTables.length ? `, and ${etlTables.length} Magic ETL DataFlow(s) that combine them (${etlTables.map((t) => t.dataset.name).join(', ')})` : ''}. Statements: ${describeInitialSql(plan).join('; ')}`,
			object
		});
		for (const note of plan.notes) issues.push({ severity: 'warning', code: 'data.initial-sql-note', message: note, object });
	}
	return out.inputs.size ? out : undefined;
}

/**
 * Plan the Domo datasets (and join dataflows / views) for every Tableau datasource.
 *
 * @param {WorkbookIR} ir
 * @param {DataManifest[]|Record<string, DataManifest>} manifests
 * @param {{ mappings?: Mappings, options?: import('../model/types.js').ConvertOptions, workbookKey: string }} opts
 * @returns {{ datasets: DatasetPlan[], dataflows: DataflowPlan[], issues: Issue[] }}
 */
export function planDatasets(ir, manifests, { mappings = {}, options = {}, workbookKey } = {}) {
	const index = manifestIndex(manifests);
	const prefix = options.namePrefix ?? '';
	const joins = options.joins ?? 'dataflow';
	const datasets = [];
	const dataflows = [];
	const issues = [];
	const usedKeys = new Set();
	const wbKey = workbookKey || slugify(ir.workbook?.luid || ir.workbook?.name);

	const sharedKeys = [];
	for (const ds of usedDatasources(ir)) {
		const caption = ds.caption || ds.id;
		const object = dsObject(ds);
		const manifest = index.get(ds.id);
		const shared = manifest?.shared?.luid ? manifest.shared : null;
		const workbookScopedKey = `${wbKey}.${slugify(caption)}`;
		const dsKey = uniqueKey(shared ? sharedDatasetKey(shared.luid) : workbookScopedKey, usedKeys);
		if (shared) sharedKeys.push({ key: dsKey, previousKey: workbookScopedKey, luid: shared.luid, name: shared.name ?? caption });
		if (manifest?.issues?.length) issues.push(...manifest.issues);
		const name = `${prefix}${shared?.name ?? caption}`;
		const description = shared
			? `Migrated from Tableau published datasource '${shared.name ?? caption}' (shared by every migrated workbook that uses it).`
			: `Migrated from Tableau workbook '${ir.workbook?.name ?? ''}', datasource '${caption}'.`;

		const existingId = existingDatasetId(ds, manifest, mappings);
		if (existingId && (!manifest || manifest.strategy === 'existing' || manifest.strategy === 'none')) {
			const columns = manifest?.tables?.[0]?.columns ?? [];
			const fieldMap = {};
			for (const field of columnFields(ds)) {
				const override = columnOverride(mappings, ds, field);
				const phys = physicalOf(ds, field);
				const hit = columns.length ? findInputColumn(columns, { ...phys, fieldName: field.name }) : undefined;
				fieldMap[field.id] = override ?? hit?.name ?? domoColumnName(field.name);
			}
			datasets.push({
				key: dsKey,
				name,
				description,
				strategy: 'existing',
				schema: columns.map((c) => ({ name: c.name, type: c.type })),
				existing: { datasetId: String(existingId) },
				datasourceId: ds.id,
				cardTarget: true,
				fieldMap
			});
			continue;
		}

		if (!manifest) {
			issues.push({
				severity: 'error',
				code: 'data.no-manifest',
				message: `No data was extracted for datasource '${caption}', so it has no Domo dataset.`,
				object,
				suggestion: 'Re-run extract with a data strategy, or map the datasource to an existing Domo dataset in mappings.json.'
			});
			continue;
		}
		if (manifest.strategy === 'none') {
			datasets.push(schemaOnlyDataset(ds, { key: dsKey, name, description, mappings }));
			issues.push({
				severity: 'warning',
				code: 'data.schema-only',
				message: `No data was extracted for datasource '${caption}'; its Domo dataset is created empty, with a schema built from the Tableau fields.`,
				object,
				suggestion: 'Load the data into the dataset (or map the datasource to an existing dataset in mappings.json) before using the cards.'
			});
			continue;
		}

		/** @type {PlannedInput[]} */
		const inputs = [];
		let flattened = false;
		let effective = ds;
		const tableKey = (label) => uniqueKey(`${dsKey}.${slugify(label)}`, usedKeys);

		const initialSqlFlows = [];
		if (manifest.strategy === 'connector') {
			const tables = ds.tables ?? [];
			if (!tables.length) {
				issues.push({ severity: 'error', code: 'data.no-tables', message: `Datasource '${caption}' has no tables to query.`, object });
				continue;
			}
			const initial = planInitialSqlInputs(ds, { name, description, mappings, tableKey, issues, object });
			if (initial === null) {
				datasets.push(schemaOnlyDataset(ds, { key: dsKey, name, description, mappings }));
				continue;
			}
			datasets.push(...(initial?.early ?? []));
			initialSqlFlows.push(...(initial?.flows ?? []));
			for (const table of tables) {
				const planned = initial?.inputs.get(table.id);
				if (planned) {
					inputs.push(planned);
					continue;
				}
				const connection = connectionFor(ds, table);
				const { connector, issues: connIssues } = planConnector(ds, connection ?? { class: 'unknown', extra: {} }, mappings, { table });
				issues.push(...connIssues);
				const columns = (table.columns ?? []).map((c) => ({
					name: domoColumnName(c.remoteName),
					type: tableauToDomoType(c.localType),
					sourceName: c.remoteName
				}));
				inputs.push({
					id: table.id,
					name: table.name || table.id,
					table,
					columns,
					datasetKey: '',
					dataset: {
						key: '',
						name: tables.length > 1 ? `${name} - ${table.name || table.id}` : name,
						description,
						strategy: 'connector',
						schema: columns.map((c) => ({ name: c.name, type: c.type })),
						...(connector ? { connector } : {}),
						datasourceId: ds.id,
						cardTarget: false,
						fieldMap: {}
					}
				});
			}
		} else if (manifest.strategy === 'federated') {
			const planned = planFederatedInputs(ds, manifest, { name, description, issues });
			if (!planned) continue;
			inputs.push(...planned);
		} else if (manifest.strategy === 'cloud-amplifier') {
			const planned = planCloudAmplifierInputs(ds, manifest, { name, description, dsKey, tableKey, issues });
			if (!planned) continue;
			effective = planned.effective;
			inputs.push(...planned.inputs);
			datasets.push(...planned.early);
			dataflows.push(...planned.flows);
		} else if (UPLOAD_STRATEGIES.has(manifest.strategy)) {
			const all = manifest.tables ?? [];
			const flat = all.find((t) => t.flattened);
			const dataTables = flat ? [flat] : all;
			flattened = Boolean(flat);
			for (const dt of dataTables) {
				const table =
					(dt.tableId && findTable(ds, dt.tableId)) ||
					findTable(ds, dt.name) ||
					(dataTables.length === 1 && (ds.tables ?? []).length === 1 ? ds.tables[0] : undefined);
				const label = table?.name || dt.name;
				inputs.push({
					id: table?.id ?? dt.tableId ?? dt.name,
					name: label,
					table,
					columns: dt.columns.map((c) => ({ ...c })),
					datasetKey: '',
					dataset: {
						key: '',
						name: dataTables.length > 1 ? `${name} - ${label}` : name,
						description,
						strategy: 'upload',
						schema: dt.columns.map((c) => ({ name: c.name, type: c.type })),
						upload: { file: dt.file, ...(manifest.sampled ? { sampled: manifest.sampled } : {}) },
						datasourceId: ds.id,
						cardTarget: false,
						fieldMap: {}
					}
				});
			}
		} else {
			issues.push({
				severity: 'error',
				code: 'data.strategy-unknown',
				message: `Unknown data strategy '${manifest.strategy}' for datasource '${caption}'.`,
				object
			});
			continue;
		}

		if (!inputs.length) {
			issues.push({ severity: 'error', code: 'data.no-tables', message: `No data tables were extracted for datasource '${caption}'.`, object });
			continue;
		}

		const single = inputs.length === 1;
		for (const input of inputs) {
			if (!input.dataset.key) input.dataset.key = single ? dsKey : tableKey(input.name);
			input.datasetKey = input.dataset.key;
		}
		for (const flow of initialSqlFlows) dataflows.push(flow.finish());
		const pushInputs = () => {
			for (const input of inputs) if (!datasets.includes(input.dataset)) datasets.push(input.dataset);
		};
		const inputsById = new Map(inputs.map((i) => [i.id, i]));

		if (single) {
			const input = inputs[0];
			input.dataset.cardTarget = true;
			input.dataset.fieldMap = singleTableFieldMap(effective, input, mappings, issues);
			datasets.push(input.dataset);
			continue;
		}

		const fallbackToFirst = () => {
			const first = inputs[0];
			first.dataset.cardTarget = true;
			first.dataset.fieldMap = singleTableFieldMap(effective, first, mappings, issues);
			pushInputs();
		};

		if (joins === 'flatten' && !flattened) {
			issues.push({
				severity: 'error',
				code: 'data.not-flattened',
				message: `joins=flatten was requested but datasource '${caption}' arrived as ${inputs.length} separate tables. Only '${inputs[0].name}' is used by cards.`,
				object,
				suggestion: "Re-extract with a single-table extract, or convert with joins 'dataflow' or 'view'."
			});
			fallbackToFirst();
			continue;
		}

		let tree = null;
		const treeIssues = [];
		try {
			if ((effective.relationships ?? []).length) tree = treeFromRelationships(effective, inputsById, treeIssues);
			else if (effective.relationTree && (effective.relationTree.type === 'join' || effective.relationTree.type === 'union')) {
				tree = treeFromRelation(effective.relationTree, effective, inputsById, treeIssues);
			}
		} catch (err) {
			treeIssues.push({
				severity: 'error',
				code: 'data.join-unresolved',
				message: `Could not rebuild the joins of datasource '${caption}': ${err.message}.`,
				object
			});
			tree = null;
		}
		issues.push(...treeIssues);
		if (!tree) {
			if (!treeIssues.length) {
				issues.push({
					severity: 'error',
					code: 'data.unrelated-tables',
					message: `Datasource '${caption}' has ${inputs.length} tables but no relationships or joins between them. Only '${inputs[0].name}' is used by cards.`,
					object
				});
			}
			fallbackToFirst();
			continue;
		}

		const joinInputs = inputs.map((i) => ({ id: i.id, name: i.name, datasetKey: i.datasetKey, columns: i.columns, refreshed: refreshesOnUpdate(i.dataset) }));
		pushInputs();

		let result = null;
		const federated = manifest.strategy === 'federated';
		if (joins === 'view' || federated) {
			const view = buildFusionView({ name, description, inputs: joinInputs, tree });
			if ('error' in view && federated) {
				issues.push({
					severity: 'error',
					code: 'data.federated-join',
					message: `Datasource '${caption}' cannot be a DataSet View over its federated DataSets (${view.error}), and Magic ETL cannot read federated DataSets. Only '${inputs[0].name}' is used by cards.`,
					object,
					suggestion: 'Map the datasource to the connector or a snapshot instead of federated (remove its mappings.json federated entry and extract again).'
				});
				const first = inputs[0];
				first.dataset.cardTarget = true;
				first.dataset.fieldMap = singleTableFieldMap(effective, first, mappings, issues);
				continue;
			}
			if ('error' in view) {
				issues.push({
					severity: 'warning',
					code: 'data.view-fallback',
					message: `Datasource '${caption}' cannot be a DataSet View (${view.error}); a Magic ETL dataflow is used instead.`,
					object
				});
			} else {
				issues.push(...view.issues);
				result = view;
				datasets.push({
					key: dsKey,
					name,
					description,
					strategy: 'view',
					...(federated ? { sourceStrategy: 'federated' } : {}),
					schema: view.columns,
					view: view.body,
					datasourceId: ds.id,
					cardTarget: true,
					fieldMap: joinedFieldMap(effective, inputsById, view, mappings, issues)
				});
			}
		}
		if (!result) {
			const flow = buildJoinDataflow({ name: `${name} (Tableau joins)`, outputName: name, description, inputs: joinInputs, tree });
			issues.push(...flow.issues);
			const fieldMap = joinedFieldMap(effective, inputsById, flow, mappings, issues);
			const fixed = fixedDatasourceFilters(ir, ds)
				.map((f) => fixedFilterCondition(f, { ...effective, fields: ds.fields ?? effective.fields }, fieldMap))
				.filter(Boolean);
			let key = dsKey;
			let outputName = name;
			if (fixed.length) {
				const conditions = fixed.map((f) => `(${f.expression})`);
				key = `${dsKey}.filtered-${shortHash(conditions)}`;
				outputName = `${name} (fixed filters)`;
				const publish = flow.definition.actions.find((a) => a.type === 'PublishToVault');
				const filterId = 'fixed-datasource-filters';
				flow.definition.actions.splice(flow.definition.actions.indexOf(publish), 0, {
					type: 'Filter',
					id: filterId,
					name: 'Fixed datasource filters',
					dependsOn: publish.dependsOn,
					filterList: [{ expression: conditions.join(' AND '), andFilterList: [] }],
					gui: { x: (publish.gui?.x ?? 0) - 110, y: (publish.gui?.y ?? 0) + 120 }
				});
				publish.dependsOn = [filterId];
				publish.name = outputName;
				if (publish.dataSource) publish.dataSource = { ...publish.dataSource, name: outputName };
				flow.definition.name = `${outputName} (Tableau joins)`;
				issues.push({
					severity: 'info',
					code: 'data.fixed-filters-in-dataflow',
					message: `The joins dataflow of '${caption}' applies its fixed "all worksheets" filter(s) ${fixed.map((f) => f.field).join(', ')} right after the joins, as Tableau applies them before any sheet, so the joined rows stay as few as Tableau's. This workbook gets its own copy of the dataset.`,
					object
				});
			}
			dataflows.push({
				key,
				name: flow.definition.name,
				definition: flow.definition,
				outputDatasetKeys: [key],
				runAfterCreate: true
			});
			datasets.push({
				key,
				name: outputName,
				description,
				strategy: 'dataflow-output',
				schema: flow.columns,
				dataflowOutput: { dataflowKey: key, outputName },
				datasourceId: ds.id,
				cardTarget: true,
				fieldMap
			});
		}
	}

	for (const { key, previousKey, luid, name } of sharedKeys) {
		const rekey = (k) => (k === key ? previousKey : k.startsWith(`${key}.`) ? `${previousKey}${k.slice(key.length)}` : null);
		for (const item of [...datasets, ...dataflows]) {
			const before = rekey(item.key);
			if (before === null) continue;
			item.shared = { luid, name };
			item.previousKey = before;
		}
	}

	return { datasets, dataflows, issues };
}

/**
 * Plan key of the Domo dataset for a published datasource, shared by every workbook on the site.
 * @param {string} luid  Tableau datasource luid
 */
export function sharedDatasetKey(luid) {
	return `pds-${slugify(luid)}`;
}

const SQL_VIEW_FROM_INFO = { mapping: { columnInfo: {} }, where: { columnInfo: {} }, having: { columnInfo: {} }, calculated: { columnInfo: {} }, remapped: { columnInfo: {} } };

/**
 * Advanced SQL DataSet View over registered Cloud Amplifier tables: each table reference in the custom SQL
 * becomes an alias mapped to its dataset. The SQL keeps the warehouse dialect.
 * @param {{ name: string, description: string, sql: string, refs: { start: number, end: number, table: number }[], aliasKeys: string[], columns: { name: string, type: string }[], dataProviderType?: string, cloudId?: string }} opts
 */
export function buildSqlView({ name, description, sql, refs, aliasKeys, columns, dataProviderType, cloudId, issues, object }) {
	let selectString = String(sql ?? '');
	for (const r of [...refs].sort((a, b) => b.start - a.start)) {
		selectString = `${selectString.slice(0, r.start)}\`t${r.table + 1}\`${selectString.slice(r.end)}`;
	}
	const ctes = inlineCtes(stripComments(selectString).trim().replace(/;+\s*$/, ''));
	const unpivot = rewriteUnpivot(aliasDerivedTables(ctes.sql).sql);
	const collate = rewriteCollate(unpivot.sql);
	const dateAdd = rewriteDateAdd(collate.sql);
	const dateDiff = rewriteDateDiff(dateAdd.sql);
	const functions = rewriteFunctions(dateDiff.sql);
	const casts = rewriteCastTypes(functions.sql);
	const derived = aliasDerivedColumns(casts.sql);
	const unions = aliasUnionBranches(derived.sql);
	const nulls = castUnionNulls(unions.sql, new Map(columns.map((c) => [String(c.name).toLowerCase(), UNION_CAST_TYPES[c.type]])));
	const anchored = anchorConstantUnionColumns(nulls.sql);
	const starred = expandStarsOverUnions(matchColumnCaseFully(anchored.sql).sql);
	const cased = matchColumnCaseFully(starred.sql);
	selectString = cased.sql;
	if (cased.fixed.length && issues) {
		issues.push({
			severity: 'info',
			code: 'data.view-sql-rewrite',
			message: `Custom SQL of '${name}': column references written in a different case from their derived table were matched to it (${cased.fixed.join(', ')}), since the SQL DataSet View resolves names as written.`,
			object
		});
	}
	if ((dateDiff.rewrites || functions.rewritten.length || casts.rewrites || derived.aliased || unions.aliased || nulls.cast || anchored.anchored || starred.expanded) && issues) {
		issues.push({
			severity: 'info',
			code: 'data.view-sql-rewrite',
			message: `Custom SQL of '${name}': ${[dateDiff.rewrites ? `${dateDiff.rewrites} DATEDIFF(<part>, a, b) call(s) rewritten as DATEDIFF(b, a) or date-part arithmetic` : '', functions.rewritten.length ? `${functions.rewritten.join(', ')} rewritten as supported functions` : '', casts.rewrites ? `${casts.rewrites} cast type(s) renamed to a type Domo recognizes` : '', derived.aliased ? `${derived.aliased} derived-table column(s) aliased to the name as written` : '', unions.aliased ? `${unions.aliased} UNION branch column(s) aliased to the first branch's names` : '', nulls.cast ? `${nulls.cast} NULL UNION branch item(s) cast to their column's type` : '', anchored.anchored ? `${anchored.anchored} UNION column(s) that are constant in every branch tied to a table column` : '', starred.expanded ? `${starred.expanded} SELECT * over a UNION written out as its column list` : ''].filter(Boolean).join(', and ')}, since the SQL DataSet View parser rejects the original form.`,
			object
		});
	}
	if (dateDiff.skipped.length && issues) {
		issues.push({
			severity: 'warning',
			code: 'data.view-sql-rewrite',
			message: `Custom SQL of '${name}': ${dateDiff.skipped.length} DATEDIFF() call(s) use a date part with no Domo equivalent and stay as they are, so the view will fail: ${dateDiff.skipped.slice(0, 3).join('; ')}`,
			object
		});
	}
	const unsupported = unsupportedFunctions(selectString);
	if (unsupported.length && issues) {
		issues.push({
			severity: 'warning',
			code: 'data.view-sql-unsupported-function',
			message: `Custom SQL of '${name}' calls ${unsupported.join(', ')}, which the SQL DataSet View validator rejects ("Unsupported function referenced") and t2d has no supported equivalent for, so the view will fail to save.`,
			object,
			suggestion: 'Rewrite the calls with functions Domo supports (docs/VIEW-SQL-RULES.md, rule F1), or serve the datasource through Magic ETL.'
		});
	}
	if (functions.approximate.length && issues) {
		issues.push({
			severity: 'warning',
			code: 'data.view-sql-rewrite',
			message: `Custom SQL of '${name}': ${functions.approximate.join(', ')} rewritten as DATE_ADD(<date>, INTERVAL <n> MONTH), which does not keep a month-end date at month end and returns a DATE.`,
			object
		});
	}
	if (casts.untyped.length && issues) {
		issues.push({
			severity: 'warning',
			code: 'data.view-sql-rewrite',
			message: `Custom SQL of '${name}' casts to ${casts.untyped.join(', ')}, which Domo types as text, so those view columns come out as STRING.`,
			object,
			suggestion: 'Cast to TIMESTAMP instead if the time zone offset is not needed.'
		});
	}
	if ((ctes.inlined.length || unpivot.rewrites) && issues) {
		issues.push({
			severity: 'info',
			code: 'data.view-sql-rewrite',
			message: `Custom SQL of '${name}': ${[ctes.inlined.length ? `CTE(s) ${ctes.inlined.join(', ')} inlined as derived tables` : '', unpivot.rewrites ? `${unpivot.rewrites} UNPIVOT(s) rewritten as a CROSS JOIN with a CASE` : ''].filter(Boolean).join(', and ')}, since the SQL DataSet View parser rejects them.`,
			object
		});
	}
	const projected = new Map((projectionNames(selectString) ?? []).filter(Boolean).map((n) => [n.toLowerCase(), n]));
	const outputName = (c) => projected.get(String(c.name).toLowerCase()) ?? c.name;
	if (dateAdd.rewrites && issues) {
		issues.push({
			severity: 'info',
			code: 'data.view-sql-dateadd',
			message: `Custom SQL of '${name}': ${dateAdd.rewrites} DATEADD() call(s) rewritten as DATE_ADD(<date>, INTERVAL <n> <part>), since the SQL DataSet View parser rejects DATEADD. Domo's Snowflake translation returns a DATE for a part of a day or longer, so a timestamp argument loses its time of day.`,
			object
		});
	}
	if (dateAdd.skipped.length && issues) {
		issues.push({
			severity: 'warning',
			code: 'data.view-sql-dateadd',
			message: `Custom SQL of '${name}': ${dateAdd.skipped.length} DATEADD() call(s) use a date part with no Domo interval and stay as they are, so the view will fail: ${dateAdd.skipped.slice(0, 3).join('; ')}`,
			object
		});
	}
	if (collate.rewrites.length && issues) {
		const loose = collate.rewrites.filter((r) => !r.compared && /ci/i.test(r.spec)).length;
		issues.push({
			severity: 'info',
			code: 'data.view-sql-collate',
			message: `Custom SQL of '${name}': ${collate.rewrites.length} COLLATE() call(s) rewritten, since the SQL DataSet View parser rejects COLLATE; comparisons use LOWER() on both sides${loose ? `, and ${loose} projected column(s) lose their case-insensitive collation` : ''}.`,
			object
		});
	}
	const used = [...new Set(refs.map((r) => r.table))].sort((a, b) => a - b);
	const tableAliases = Object.fromEntries(used.map((i) => [`t${i + 1}`, ref('dataset', aliasKeys[i])]));
	return {
		dataSourceName: name,
		dataSourceDescription: description,
		...(dataProviderType ? { dataProviderType } : {}),
		...(cloudId ? { cloudId } : {}),
		trigger: { dataSource: ref('dataset', aliasKeys[used[0]]) },
		schema: {
			tables: [{ columns: columns.map((c, order) => ({ name: outputName(c), id: outputName(c), type: c.type, visible: true, order })) }],
			viewTemplate: { version: 'advancedEditorSql', fromItemInfo: SQL_VIEW_FROM_INFO, selectString },
			tableAliases
		}
	};
}

// Tables become "T2D_T<n>" so a dataflow on the warehouse can map them to its inputs.
function warehouseSql(rel, aliasKeys) {
	let sql = String(rel.sql ?? '');
	for (const r of [...rel.refs].sort((a, b) => b.start - a.start)) sql = `${sql.slice(0, r.start)}"T2D_T${r.table + 1}"${sql.slice(r.end)}`;
	const tables = Object.fromEntries([...new Set(rel.refs.map((r) => r.table))].map((t) => [`T2D_T${t + 1}`, ref('dataset', aliasKeys[t])]));
	return { sql, tables };
}

/**
 * Inputs for a datasource served by Cloud Amplifier: one registered dataset per warehouse table, and a SQL
 * DataSet View per custom SQL relation. `early` holds registrations that only feed SQL views.
 */
/** One federated DataSet per table; its columns keep the database names, like Cloud Amplifier. */
function planFederatedInputs(ds, manifest, { name, description, issues }) {
	const fed = manifest.federated;
	const object = dsObject(ds);
	if (!fed?.tables?.length) {
		issues.push({ severity: 'error', code: 'data.no-tables', message: `The federated manifest of '${ds.caption}' lists no tables.`, object });
		return null;
	}
	issues.push({
		severity: 'info',
		code: 'data.federated-beast-modes',
		message: `Beast Modes run on the database: the cards of '${ds.caption}' query federated DataSets, so Domo translates each Beast Mode to the ${fed.providerKey} dialect at query time.`,
		object,
		suggestion: 'Check cards whose Beast Modes use window functions or FIXED LODs after push.'
	});
	const many = fed.tables.length > 1;
	return fed.tables.map((t) => {
		const table = findTable(ds, t.tableId) ?? (ds.tables ?? []).find((x) => x.id === t.tableId);
		const columns = (table?.columns ?? []).map((c) => ({ name: c.remoteName, type: tableauToDomoType(c.localType), sourceName: c.remoteName }));
		return {
			id: t.tableId,
			name: t.name,
			table,
			columns,
			datasetKey: '',
			dataset: {
				key: '',
				name: many ? `${name} - ${t.name}` : name,
				description,
				strategy: 'federated',
				schema: columns.map((c) => ({ name: c.name, type: c.type })),
				federated: { accountId: fed.accountId, providerKey: fed.providerKey, ...(t.catalog ? { catalog: t.catalog } : {}), ...(t.schema ? { schema: t.schema } : {}), table: t.table, cacheTTL: fed.cacheTTL },
				datasourceId: ds.id,
				cardTarget: false,
				fieldMap: {}
			}
		};
	});
}

function planCloudAmplifierInputs(ds, manifest, { name, description, dsKey, tableKey, issues }) {
	const ca = manifest.cloudAmplifier;
	const object = dsObject(ds);
	if (!ca?.tables?.length || !(ca.relations?.length || ca.initialSqlDataflows?.length)) {
		issues.push({ severity: 'error', code: 'data.no-tables', message: `The Cloud Amplifier manifest of '${ds.caption}' lists no tables.`, object });
		return null;
	}
	const effective = ca.source ? { ...ds, tables: ca.source.tables ?? [], relationTree: ca.source.relationTree, relationships: ca.source.relationships ?? [] } : ds;
	const many = ca.relations.length > 1 || ca.relations.some((r) => r.kind !== 'table');
	const registrations = ca.tables.map((t) => ({
		key: '',
		name: many ? `${name} - ${t.tableName}` : name,
		description,
		strategy: 'cloud-amplifier',
		schema: (t.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
		cloudAmplifier: {
			integrationId: t.integrationId,
			databaseName: t.databaseName,
			schemaName: t.schemaName,
			tableName: t.tableName,
			dataProviderKey: t.dataProviderKey,
			...(t.registeredDatasetId ? { registeredDatasetId: t.registeredDatasetId } : {})
		},
		datasourceId: ds.id,
		cardTarget: false,
		fieldMap: {}
	}));
	const early = [];
	for (const rel of ca.relations.filter((r) => r.kind === 'custom-sql')) {
		for (const r of rel.refs) {
			const dataset = registrations[r.table];
			if (!dataset.key) {
				dataset.key = tableKey(ca.tables[r.table].tableName);
				early.push(dataset);
			}
		}
	}
	const inputs = [];
	for (const rel of ca.relations) {
		const table = findTable(effective, rel.tableId) ?? (effective.tables ?? []).find((t) => t.id === rel.tableId);
		if (rel.kind === 'table') {
			const dataset = registrations[rel.table];
			inputs.push({ id: rel.tableId, name: rel.name, table, columns: dataset.schema.map((c) => ({ ...c, sourceName: c.name })), datasetKey: '', dataset });
			continue;
		}
		const columns = rel.columns ?? [];
		const first = ca.tables[rel.refs[0].table];
		if (!columns.length) {
			issues.push({
				severity: 'warning',
				code: 'data.cloud-amplifier-sql-columns',
				message: `Custom SQL '${rel.name}' of '${ds.caption}' has no column metadata, so the SQL DataSet View is planned without a column list.`,
				object
			});
		}
		issues.push({
			severity: 'warning',
			code: 'data.cloud-amplifier-sql-view',
			message: `Custom SQL '${rel.name}' of '${ds.caption}' becomes an Advanced SQL DataSet View over ${rel.refs.length} registered Cloud Amplifier table reference(s). The SQL keeps its ${first.engine ?? 'warehouse'} dialect and was not translated.`,
			object,
			suggestion: 'Open the view in Domo after push and check that it previews; adjust functions or quoting the view engine rejects.'
		});
		const viewName = ca.relations.length > 1 ? `${name} - ${rel.name}` : name;
		const aliasKeys = registrations.map((d) => d.key);
		const view = buildSqlView({ name: viewName, description, sql: rel.sql, refs: rel.refs, aliasKeys, columns, dataProviderType: first.dataProviderKey, cloudId: first.integrationId, issues, object });
		const viewNames = view.schema.tables[0].columns.map((c) => c.name);
		inputs.push({
			id: rel.tableId,
			name: rel.name,
			table,
			columns: columns.map((c, i) => ({ name: viewNames[i], type: c.type, sourceName: c.name })),
			datasetKey: '',
			dataset: {
				key: '',
				name: viewName,
				description,
				strategy: 'view',
				schema: columns.map((c, i) => ({ name: viewNames[i], type: c.type })),
				view,
				warehouseSql: warehouseSql(rel, aliasKeys),
				datasourceId: ds.id,
				cardTarget: false,
				fieldMap: {}
			}
		});
	}
	const flows = [];
	const stagesOf = (scripted) => scripted.stages ?? [{ definition: scripted.definition, outputs: scripted.outputs }];
	const finalOutputs = (scripted) => stagesOf(scripted).flatMap((stage) => stage.outputs.filter((o) => !o.intermediate));
	const onlyOutput = !ca.relations.length && (ca.initialSqlDataflows ?? []).flatMap(finalOutputs).length === 1;
	for (const scripted of ca.initialSqlDataflows ?? []) {
		const registered = (index) => {
			const dataset = registrations[index];
			if (!dataset.key) {
				dataset.key = tableKey(ca.tables[index].tableName);
				early.push(dataset);
			}
			return ref('dataset', dataset.key);
		};
		const stageKeys = new Map();
		const resolveInputs = (node) => {
			if (Array.isArray(node)) return node.map(resolveInputs);
			if (!node || typeof node !== 'object') return node;
			return Object.fromEntries(
				Object.entries(node).map(([k, v]) => {
					if (k !== 'dataSourceId') return [k, resolveInputs(v)];
					const text = String(v);
					if (/^ca:\d+$/.test(text)) return [k, registered(Number(text.slice(3)))];
					if (text.startsWith('stage:')) {
						const key = stageKeys.get(text.slice(6));
						if (!key) throw new Error(`Initial SQL dataflow stage input '${text.slice(6)}' is not an earlier stage's output`);
						return [k, ref('dataset', key)];
					}
					return [k, v];
				})
			);
		};
		const stages = stagesOf(scripted);
		let firstName;
		for (const [n, stage] of stages.entries()) {
			const definition = resolveInputs(stage.definition);
			firstName ??= definition.name;
			const dataflowKey = tableKey(stages.length > 1 ? `initial-sql-${n + 1}` : 'initial-sql');
			const outputKeys = [];
			for (const output of stage.outputs) {
				const columns = (output.columns ?? []).map((c) => ({ name: c.name, type: c.type ?? 'STRING' }));
				if (!output.columns) {
					issues.push({ severity: 'warning', code: 'data.initial-sql-magic-columns', message: `Output '${output.name}' of the Initial SQL dataflow of '${ds.caption}' has no known columns, so its fields are matched after the first run.`, object });
				}
				const key = !output.intermediate && onlyOutput ? dsKey : tableKey(output.name);
				outputKeys.push(key);
				const dataset = {
					key,
					name: output.name,
					description,
					strategy: 'dataflow-output',
					sourceStrategy: 'cloud-amplifier',
					schema: columns,
					dataflowOutput: { dataflowKey, outputName: output.name },
					datasourceId: ds.id,
					cardTarget: false,
					fieldMap: {}
				};
				if (output.intermediate) {
					stageKeys.set(output.name, key);
					early.push(dataset);
					continue;
				}
				const table = findTable(effective, output.tableId) ?? (effective.tables ?? []).find((t) => t.id === output.tableId);
				inputs.push({ id: output.tableId, name: table?.name || output.name, table, columns: columns.map((c) => ({ ...c, sourceName: c.name })), datasetKey: key, dataset });
			}
			flows.push({ key: dataflowKey, name: definition.name, definition, outputDatasetKeys: outputKeys, runAfterCreate: true });
		}
		issues.push(...(scripted.issues ?? []).map((i) => ({ ...i, object: i.object ?? object })));
		issues.push({
			severity: 'warning',
			code: 'data.initial-sql-magic-refresh',
			message: `The Initial SQL of '${ds.caption}' runs as ${stages.length > 1 ? `${stages.length} chained Magic ETL dataflows ('${firstName}' first)` : `Magic ETL dataflow '${firstName}'`} on the warehouse. Its Cloud Amplifier inputs do not trigger it, so it only reruns on a schedule.`,
			object,
			suggestion: stages.length > 1 ? 'Schedule the first dataflow in Domo after push, and set each later one to run when the previous one updates its output.' : 'Set a schedule on the dataflow in Domo after push (Settings > Schedule).'
		});
	}
	return { effective, inputs, early, flows };
}

function schemaOnlyDataset(ds, { key, name, description, mappings }) {
	const fields = columnFields(ds);
	const names = dedupeNames(fields.map((f) => columnOverride(mappings, ds, f) ?? domoColumnName(f.name)));
	const fieldMap = {};
	const schema = fields.map((field, i) => {
		fieldMap[field.id] = names[i];
		return { name: names[i], type: tableauToDomoType(field.datatype) };
	});
	return { key, name, description, strategy: 'upload', schema, datasourceId: ds.id, cardTarget: true, fieldMap };
}

function unmapped(ds, field, issues) {
	issues.push({
		severity: 'warning',
		code: 'data.field-unmapped',
		message: `Field '${field.name}' of datasource '${ds.caption}' was not found in the Domo dataset columns.`,
		object: { type: 'field', name: field.name, id: field.id }
	});
}

function singleTableFieldMap(ds, input, mappings, issues) {
	const fieldMap = {};
	for (const field of columnFields(ds)) {
		const override = columnOverride(mappings, ds, field);
		if (override) {
			fieldMap[field.id] = override;
			continue;
		}
		const phys = physicalOf(ds, field);
		const hit = findInputColumn(input.columns, { ...phys, fieldName: field.name });
		if (hit) fieldMap[field.id] = hit.name;
		else unmapped(ds, field, issues);
	}
	return fieldMap;
}

function joinedFieldMap(ds, inputsById, result, mappings, issues) {
	const fieldMap = {};
	const finalNames = new Map(result.columns.map((c) => [c.name.toLowerCase(), c.name]));
	for (const field of columnFields(ds)) {
		const override = columnOverride(mappings, ds, field);
		if (override) {
			fieldMap[field.id] = override;
			continue;
		}
		const phys = physicalOf(ds, field);
		const want = { ...phys, fieldName: field.name };
		const input = phys.tableId
			? inputsById.get(phys.tableId) ?? [...inputsById.values()].find((i) => tableMatches(i.table, phys.tableId))
			: undefined;
		let name;
		if (input) {
			const hit = findInputColumn(input.columns, want);
			if (hit) name = result.columnMap.get(originKey(input.id, hit.name));
		}
		if (!name && !input) {
			for (const candidate of inputsById.values()) {
				const hit = findInputColumn(candidate.columns, { localName: phys.localName, fieldName: field.name });
				if (hit) {
					name = result.columnMap.get(originKey(candidate.id, hit.name));
					if (name) break;
				}
			}
		}
		name ??= finalNames.get(domoColumnName(field.name).toLowerCase());
		if (name) fieldMap[field.id] = name;
		else unmapped(ds, field, issues);
	}
	return fieldMap;
}
