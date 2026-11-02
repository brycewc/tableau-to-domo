import { ref } from '../util/refs.js';
import { slugify } from '../util/ids.js';

/**
 * Join plans shared by the Magic ETL and DataSet View builders.
 *
 * @typedef {Object} JoinInput
 * @property {string} id                  TableIR id
 * @property {string} name                Table display name (used for rename suffixes and tile names)
 * @property {string} datasetKey          Plan key of the input dataset
 * @property {{ name: string, type: string }[]} columns  Domo columns of the input dataset
 * @property {boolean} [refreshed]        The input is refreshed after push (refreshesOnUpdate)
 *
 * @typedef {{ tableId: string, column: string, transform?: 'DATE' }} ColumnRef  `transform`: a function the join key applies
 *
 * @typedef {{ type: 'input', tableId: string }
 *   | { type: 'join', joinType: JoinType, left: JoinNode, right: JoinNode, keys: { left: ColumnRef, right: ColumnRef }[] }
 *   | { type: 'union', children: JoinNode[] }} JoinNode
 *
 * @typedef {'INNER'|'LEFT OUTER'|'RIGHT OUTER'|'FULL OUTER'} JoinType
 *
 * @typedef {Object} JoinResult
 * @property {{ name: string, type: string }[]} columns  Output columns, in order
 * @property {Map<string, string>} columnMap             originKey(tableId, inputColumn) -> output column name
 * @property {import('../model/types.js').Issue[]} issues
 */

const TABLEAU_JOIN_TYPES = { inner: 'INNER', left: 'LEFT OUTER', right: 'RIGHT OUTER', full: 'FULL OUTER' };
// Magic ETL formula and type of a key column for a join key function (`DATE([Created Date]) = [CALENDAR_DATE]`).
const JOIN_KEY_FORMULAS = { DATE: { formula: (column) => `DATE(\`${column.replace(/`/g, '``')}\`)`, type: 'DATE' } };
const ETL_SETTINGS = { zoneId: 'UTC' };
const FUSE_TYPES = { 'INNER': 'inner', 'LEFT OUTER': 'left', 'RIGHT OUTER': 'right' };
const X_STEP = 220;
const Y_STEP = 120;
const ORIGIN = 50;

/** Tableau relation join attribute -> Magic ETL MergeJoin joinType. */
export function magicJoinType(tableauJoin) {
	return TABLEAU_JOIN_TYPES[String(tableauJoin ?? 'inner').toLowerCase()] || 'INNER';
}

/** Key for {@link JoinResult.columnMap}. */
export function originKey(tableId, column) {
	return `${tableId}\u0000${column}`;
}

/**
 * @typedef {{ name: string, type: string, origins: string[] }} TrackedColumn
 */

function inputColumns(input) {
	return input.columns.map((c) => ({ name: c.name, type: c.type, origins: [originKey(input.id, c.name)] }));
}

function currentName(columns, columnRef) {
	const key = originKey(columnRef.tableId, columnRef.column);
	return columns.find((c) => c.origins.includes(key))?.name;
}

/**
 * Combine the right side's columns into the left side's. Right columns whose
 * name collides are removed when they are an equal-named join key and the join
 * keeps every left row's key (INNER / LEFT OUTER), otherwise renamed 'Col (Table)'.
 * @returns {{ columns: TrackedColumn[], modifications: { name: string, rename: string, remove: boolean }[] }}
 */
function mergeColumns(left, right, keyPairs, joinType, label) {
	const columns = left.map((c) => ({ ...c, origins: [...c.origins] }));
	const taken = new Set(columns.map((c) => c.name.toLowerCase()));
	const modifications = [];
	const canDropKey = joinType === 'INNER' || joinType === 'LEFT OUTER';
	for (const col of right) {
		const lower = col.name.toLowerCase();
		if (!taken.has(lower)) {
			columns.push({ ...col, origins: [...col.origins] });
			taken.add(lower);
			continue;
		}
		const pair = keyPairs.find((p) => p.right === col.name && p.left.toLowerCase() === lower);
		if (pair && canDropKey) {
			const leftCol = columns.find((c) => c.name === pair.left);
			leftCol?.origins.push(...col.origins);
			modifications.push({ name: col.name, rename: col.name, remove: true });
			continue;
		}
		let rename = `${col.name} (${label})`;
		let n = 2;
		while (taken.has(rename.toLowerCase())) rename = `${col.name} (${label} ${n++})`;
		taken.add(rename.toLowerCase());
		columns.push({ name: rename, type: col.type, origins: [...col.origins] });
		modifications.push({ name: col.name, rename, remove: false });
	}
	return { columns, modifications };
}

function unionColumns(children) {
	const columns = [];
	const byName = new Map();
	for (const child of children) {
		for (const col of child) {
			const existing = byName.get(col.name.toLowerCase());
			if (existing) existing.origins.push(...col.origins);
			else {
				const copy = { ...col, origins: [...col.origins] };
				byName.set(col.name.toLowerCase(), copy);
				columns.push(copy);
			}
		}
	}
	return columns;
}

const REFRESHED = new Set(['connector', 'existing']);

/** True when a dataflow input is refreshed after push (a connector or existing dataset), so the flow reruns on update. */
export function refreshesOnUpdate(dataset) {
	return REFRESHED.has(dataset?.strategy) || (['dataflow-output', 'view'].includes(dataset?.strategy) && REFRESHED.has(dataset.sourceStrategy));
}

function finish(columns, issues) {
	const columnMap = new Map();
	for (const col of columns) for (const origin of col.origins) columnMap.set(origin, col.name);
	return { columns: columns.map((c) => ({ name: c.name, type: c.type })), columnMap, issues };
}

function leftmostLabel(node, inputsById) {
	if (node.type === 'input') return inputsById.get(node.tableId)?.name ?? node.tableId;
	if (node.type === 'join') return leftmostLabel(node.left, inputsById);
	return leftmostLabel(node.children[0], inputsById);
}

/**
 * Magic ETL dataflow that joins/unions the input datasets into one output.
 *
 * @param {{ name: string, outputName: string, description?: string, inputs: JoinInput[], tree: JoinNode }} spec
 * @returns {JoinResult & { definition: Object }}
 */
export function buildJoinDataflow({ name, outputName, description = '', inputs, tree }) {
	const inputsById = new Map(inputs.map((i) => [i.id, i]));
	const actions = [];
	const issues = [];
	const usedIds = new Set();
	const helpers = [];
	let row = 0;

	const actionId = (prefix, label) => {
		const base = `${prefix}-${slugify(label)}`;
		let id = base;
		let n = 2;
		while (usedIds.has(id)) id = `${base}-${n++}`;
		usedIds.add(id);
		return id;
	};

	/** @returns {{ id: string, columns: TrackedColumn[], depth: number, y: number }} */
	const build = (node) => {
		if (node.type === 'input') {
			const input = inputsById.get(node.tableId);
			if (!input) throw new Error(`Join tree references unknown table ${node.tableId}`);
			const y = ORIGIN + row++ * Y_STEP;
			const id = actionId('in', input.name);
			actions.push({
				type: 'LoadFromVault',
				id,
				name: input.name,
				dataSourceId: ref('dataset', input.datasetKey),
				executeFlowWhenUpdated: Boolean(input.refreshed),
				onlyLoadNewVersions: false,
				truncateTextColumns: false,
				truncateRows: false,
				gui: { x: ORIGIN, y }
			});
			return { id, columns: inputColumns(input), depth: 0, y };
		}
		if (node.type === 'union') {
			const children = node.children.map(build);
			const depth = Math.max(...children.map((c) => c.depth)) + 1;
			const id = actionId('union', leftmostLabel(node, inputsById));
			actions.push({
				type: 'UnionAll',
				id,
				name: 'Append Rows',
				dependsOn: children.map((c) => c.id),
				schemaSource: children[0].id,
				unionType: 'INCLUDE_ALL',
				strict: false,
				gui: { x: ORIGIN + depth * X_STEP, y: children[0].y }
			});
			return { id, columns: unionColumns(children.map((c) => c.columns)), depth, y: children[0].y };
		}
		let left = build(node.left);
		let right = build(node.right);
		const label = leftmostLabel(node.right, inputsById);
		const keyPairs = [];
		const computed = { left: [], right: [] };
		const keyName = (side, ref, name) => {
			const spec = ref.transform && JOIN_KEY_FORMULAS[ref.transform];
			if (!spec) return name;
			const fieldName = `_t2d_join_key_${helpers.length + 1}`;
			helpers.push(fieldName);
			computed[side].push({ fieldName, expression: spec.formula(name), type: spec.type });
			return fieldName;
		};
		for (const key of node.keys) {
			const l = currentName(left.columns, key.left);
			const r = currentName(right.columns, key.right);
			if (!l || !r) {
				issues.push({
					severity: 'error',
					code: 'data.join-key-missing',
					message: `Join key ${key.left.column} = ${key.right.column} could not be found in the joined inputs (${label}).`,
					object: { type: 'table', name: label }
				});
				continue;
			}
			keyPairs.push({ left: keyName('left', key.left, l), right: keyName('right', key.right, r) });
		}
		const withKeys = (side, built) => {
			const exprs = computed[side];
			if (!exprs.length) return built;
			const id = actionId('keys', `${label} ${side}`);
			actions.push({ type: 'ExpressionEvaluator', id, name: `Join keys of ${side === 'left' ? 'joined rows' : label}`, dependsOn: [built.id], settings: { ...ETL_SETTINGS }, expressions: exprs.map(({ fieldName, expression }) => ({ fieldName, expression })), gui: { x: ORIGIN + Math.round((built.depth + 0.5) * X_STEP), y: built.y } });
			return { ...built, id, columns: [...built.columns, ...exprs.map((e) => ({ name: e.fieldName, type: e.type, origins: [] }))] };
		};
		left = withKeys('left', left);
		right = withKeys('right', right);
		const { columns, modifications } = mergeColumns(left.columns, right.columns, keyPairs, node.joinType, label);
		const depth = Math.max(left.depth, right.depth) + 1;
		const id = actionId('join', label);
		actions.push({
			type: 'MergeJoin',
			id,
			name: `Join ${label}`,
			dependsOn: [left.id, right.id],
			step1: left.id,
			step2: right.id,
			joinType: node.joinType,
			keys1: keyPairs.map((p) => p.left),
			keys2: keyPairs.map((p) => p.right),
			schemaModification1: [],
			schemaModification2: modifications,
			gui: { x: ORIGIN + depth * X_STEP, y: left.y }
		});
		return { id, columns, depth, y: left.y };
	};

	let root = build(tree);
	if (helpers.length) {
		const id = actionId('drop', 'join keys');
		actions.push({ type: 'Metadata', id, name: 'Drop join keys', dependsOn: [root.id], fields: helpers.map((name) => ({ name, remove: true })), gui: { x: ORIGIN + (root.depth + 1) * X_STEP, y: root.y } });
		const dropped = new Set(helpers);
		root = { ...root, id, depth: root.depth + 1, columns: root.columns.filter((c) => !dropped.has(c.name)) };
	}
	actions.push({
		type: 'PublishToVault',
		id: actionId('out', outputName),
		name: outputName,
		dependsOn: [root.id],
		dataSource: { guid: '', name: outputName, description },
		versionChainType: 'REPLACE',
		gui: { x: ORIGIN + (root.depth + 1) * X_STEP, y: root.y }
	});

	const definition = {
		name,
		description,
		databaseType: 'MAGIC',
		runState: 'ENABLED',
		engineProperties: { 'kettle.mode': 'STRICT' },
		gui: {},
		actions
	};
	return { definition, ...finish(root.columns, issues) };
}

/**
 * Legacy Fusion ("Blend") view body for POST /query/v1/fusions. Supports a union
 * of inputs, or a left-deep chain of inner/left/right equality joins where every
 * step's keys come from one already-joined table.
 *
 * @param {{ name: string, description?: string, inputs: JoinInput[], tree: JoinNode }} spec
 * @returns {(JoinResult & { body: Object }) | { error: string }}
 */
export function buildFusionView({ name, description = '', inputs, tree }) {
	const inputsById = new Map(inputs.map((i) => [i.id, i]));
	const dataSource = (tableId) => ref('dataset', inputsById.get(tableId).datasetKey);
	const issues = [];

	if (tree.type === 'union') {
		if (!tree.children.every((c) => c.type === 'input')) return { error: 'nested unions are not supported by DataSet Views' };
		const columns = unionColumns(tree.children.map((c) => inputColumns(inputsById.get(c.tableId))));
		const result = finish(columns, issues);
		return {
			...result,
			body: {
				dataSourceName: name,
				dataSourceDescription: description,
				dataSourceType: 'datafusion',
				validate: true,
				columnList: result.columns.map((c) => ({ name: c.name, id: c.name, type: c.type })),
				rowFuse: { dataSources: tree.children.map((c) => dataSource(c.tableId)) }
			}
		};
	}

	const steps = [];
	let node = tree;
	while (node.type === 'join') {
		steps.unshift(node);
		node = node.left;
	}
	if (node.type !== 'input') return { error: 'only joins of single tables are supported by DataSet Views' };

	const rootId = node.tableId;
	let columns = inputColumns(inputsById.get(rootId)).map((c) => ({ ...c, mapping: { tableId: rootId, column: c.name } }));
	const joined = new Set([rootId]);
	const fuses = [];
	for (const step of steps) {
		const fuseType = FUSE_TYPES[step.joinType];
		if (!fuseType) return { error: `${step.joinType} joins are not supported by DataSet Views` };
		if (step.right.type !== 'input') return { error: 'joining a joined or unioned subtree is not supported by DataSet Views' };
		if (!step.keys.length) return { error: 'a join without equality keys is not supported by DataSet Views' };
		if (step.keys.some((k) => k.left.transform || k.right.transform)) return { error: 'a join on a computed key (such as DATE of a column) is not supported by DataSet Views' };
		const parents = new Set(step.keys.map((k) => k.left.tableId));
		if (parents.size !== 1) return { error: 'a join whose keys span several tables is not supported by DataSet Views' };
		const parent = [...parents][0];
		const rightId = step.right.tableId;
		if (!joined.has(parent) || joined.has(rightId)) return { error: 'join keys do not link a joined table to a new table' };

		const right = inputsById.get(rightId);
		const keyPairs = step.keys.map((k) => ({ left: currentName(columns, k.left), right: k.right.column }));
		if (keyPairs.some((p) => !p.left)) return { error: 'a join key is missing from the joined columns' };
		const rightCols = inputColumns(right).map((c) => ({ ...c, mapping: { tableId: rightId, column: c.name } }));
		const merged = mergeColumns(columns, rightCols, keyPairs, step.joinType, right.name);
		const mappingByOrigin = new Map([...columns, ...rightCols].map((c) => [c.origins[0], c.mapping]));
		columns = merged.columns.map((c) => ({ ...c, mapping: mappingByOrigin.get(c.origins[0]) }));
		fuses.push({
			type: fuseType,
			leftDataSource: dataSource(parent),
			rightDataSource: dataSource(rightId),
			predicates: step.keys.map((k) => ({ leftColumn: k.left.column, rightColumn: k.right.column }))
		});
		joined.add(rightId);
	}

	let columnFuse = null;
	for (const fuse of fuses) columnFuse = columnFuse ? { ...fuse, columnFuse } : fuse;

	const result = finish(columns, issues);
	return {
		...result,
		body: {
			dataSourceName: name,
			dataSourceDescription: description,
			dataSourceType: 'datafusion',
			validate: true,
			columnList: columns.map((c) => ({
				name: c.name,
				id: c.name,
				type: c.type,
				fuseMapping: { dataSource: dataSource(c.mapping.tableId), columnName: c.mapping.column }
			})),
			...(columnFuse ? { columnFuse } : {})
		}
	};
}
