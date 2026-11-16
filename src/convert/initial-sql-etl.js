import { ref } from '../util/refs.js';
import { slugify } from '../util/ids.js';

const ETL_SETTINGS = { zoneId: 'UTC' };

/**
 * Magic ETL dataflow for one Initial SQL graph (src/convert/initial-sql.js): LoadFromVault per stream, then the
 * graph's tiles, then one PublishToVault.
 * @param {{ name: string, outputName: string, description?: string, graph: import('./initial-sql.js').Node, streamKeys: Map<string, string> }} spec
 *   `streamKeys`: stream id -> plan key of its connector dataset
 */
export function buildInitialSqlDataflow({ name, outputName, description = '', graph, streamKeys }) {
	const actions = [];
	const used = new Set();
	const built = new Map();
	const inputs = new Map();
	const actionId = (prefix, label) => {
		const base = `${prefix}-${slugify(label) || prefix}`;
		let id = base;
		let n = 2;
		while (used.has(id)) id = `${base}-${n++}`;
		used.add(id);
		return id;
	};
	const add = (action) => {
		actions.push(action);
		return action.id;
	};

	/** @returns {string} The id of the action that produces `node` */
	const build = (node) => {
		if (built.has(node)) return built.get(node);
		let out;
		switch (node.op) {
			case 'input': {
				if (inputs.has(node.stream)) return inputs.get(node.stream);
				const key = streamKeys.get(node.stream);
				if (!key) throw new Error(`Initial SQL graph reads unknown stream ${node.stream}`);
				out = add({
					type: 'LoadFromVault',
					id: actionId('in', node.stream),
					name: node.stream,
					dataSourceId: ref('dataset', key),
					executeFlowWhenUpdated: true,
					onlyLoadNewVersions: false,
					truncateTextColumns: false,
					truncateRows: false
				});
				inputs.set(node.stream, out);
				break;
			}
			case 'select': {
				const from = build(node.from);
				out = add({ type: 'SelectValues', id: actionId('select', node.fields[0]?.rename ?? 'columns'), name: 'Select columns', dependsOn: [from], fields: node.fields.map((f) => ({ name: f.name, ...(f.rename && f.rename !== f.name ? { rename: f.rename } : {}) })) });
				break;
			}
			case 'join': {
				const left = build(node.left);
				const right = build(node.right);
				out = add({
					type: 'MergeJoin',
					id: actionId('join', node.keys[0]?.right ?? 'join'),
					name: `Join ${node.keys.map((k) => k.right.replace(/^_t2d_/, '')).join(', ')}`,
					dependsOn: [left, right],
					step1: left,
					step2: right,
					joinType: node.joinType,
					keys1: node.keys.map((k) => k.left),
					keys2: node.keys.map((k) => k.right),
					schemaModification1: [],
					schemaModification2: []
				});
				break;
			}
			case 'filter': {
				const from = build(node.from);
				out = add({ type: 'Filter', id: actionId('filter', node.label), name: node.label, dependsOn: [from], filterList: [{ expression: node.expression, andFilterList: [] }] });
				break;
			}
			case 'formula': {
				const from = build(node.from);
				out = add({ type: 'ExpressionEvaluator', id: actionId('calc', node.label), name: node.label, dependsOn: [from], settings: { ...ETL_SETTINGS }, expressions: node.fields.map((f) => ({ fieldName: f.name, expression: f.expression })) });
				break;
			}
			case 'group': {
				const from = build(node.from);
				out = add({
					type: 'GroupBy',
					id: actionId('group', node.groups[0] ?? 'rows'),
					name: 'Group By',
					dependsOn: [from],
					settings: { ...ETL_SETTINGS },
					addLineNumber: false,
					giveBackRow: false,
					allRows: false,
					groups: node.groups.map((g) => ({ name: g })),
					fields: node.fields.map((f) => ({ name: f.name, expression: f.expression }))
				});
				break;
			}
			case 'metadata': {
				const from = build(node.from);
				out = add({ type: 'Metadata', id: actionId('columns', node.label), name: node.label, dependsOn: [from], fields: node.fields.map((f) => (f.remove ? { name: f.name, remove: true } : { name: f.name, rename: f.rename })) });
				break;
			}
			case 'distinct': {
				const from = build(node.from);
				out = add({ type: 'Unique', id: actionId('unique', 'rows'), name: 'Remove duplicates (DISTINCT)', dependsOn: [from], fields: [] });
				break;
			}
			case 'union': {
				const parts = node.inputs.map(build);
				out = add({ type: 'UnionAll', id: actionId('union', 'rows'), name: 'Append rows (UNION ALL)', dependsOn: parts, schemaSource: parts[0], unionType: 'INCLUDE_ALL', strict: false });
				break;
			}
			default:
				throw new Error(`Unknown Initial SQL graph node ${node.op}`);
		}
		built.set(node, out);
		return out;
	};

	const root = build(graph);
	actions.push({
		type: 'PublishToVault',
		id: actionId('out', outputName),
		name: outputName,
		dependsOn: [root],
		dataSource: { guid: '', name: outputName, description },
		versionChainType: 'REPLACE'
	});
	return {
		definition: { name, description, databaseType: 'MAGIC', runState: 'ENABLED', engineProperties: { 'kettle.mode': 'STRICT' }, gui: {}, actions },
		inputs: [...inputs.keys()]
	};
}
