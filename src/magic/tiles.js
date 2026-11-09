import { slugify } from '../util/ids.js';

/**
 * Logical tile graph (src/magic/graph.js) -> Magic ETL dataflow definition.
 *
 * @typedef {Object} ComputeTarget
 * @property {'adr'} type                Run the dataflow on a Cloud Amplifier warehouse (Magic ETL on Snowflake)
 * @property {string} cloudId            The Cloud Amplifier integration (computeCloud); inputs must be its datasets
 * @property {string} [sqlDialect]       Default ADRENALINE
 *
 * @typedef {Object} BuildOptions
 * @property {string} [name]
 * @property {string} [description]
 * @property {ComputeTarget} [compute]   Omit for Domo's own Magic ETL engine
 * @property {string} [zoneId]           Formula/Group By time zone (default UTC)
 */

const X_STEP = 220;
const Y_STEP = 120;
const ORIGIN = 50;

const FRAMED_OPERATIONS = { SUM: 'SUM', AVG: 'AVERAGE', COUNT: 'COUNT' };

/**
 * @param {import('./graph.js').Graph} graph
 * @param {{ name: string, node: import('./graph.js').GraphNode }[]} outputs
 * @param {BuildOptions} [opts]
 * @returns {{ definition: object, actionIds: Map<number, string> }}
 */
export function buildDefinition(graph, planned, opts = {}) {
	const adr = opts.compute?.type === 'adr';
	const zone = { zoneId: opts.zoneId ?? 'UTC' };
	const reachable = new Set();
	const visit = (n) => {
		if (reachable.has(n)) return;
		reachable.add(n);
		for (const d of n.deps) visit(d);
	};
	for (const o of planned) visit(o.node);
	const merged = mergeSelects(graph.nodes.filter((n) => reachable.has(n)), planned);
	const nodes = distinctInputs(merged.nodes);
	const outputs = merged.outputs;
	const depth = new Map();
	const depthOf = (n) => {
		if (depth.has(n)) return depth.get(n);
		const d = n.deps.length ? Math.max(...n.deps.map(depthOf)) + 1 : 0;
		depth.set(n, d);
		return d;
	};
	nodes.forEach(depthOf);
	const rows = new Map();
	const used = new Set();
	const ids = new Map();
	const idFor = (n) => {
		if (ids.has(n.id)) return ids.get(n.id);
		const prefix = { input: 'in', formula: 'calc', select: 'select', drop: 'drop', filter: 'filter', join: 'join', group: 'group', window: 'window', unique: 'unique', union: 'union', limit: 'limit', sql: 'sql' }[n.op];
		const base = `${prefix}-${slugify(n.label).slice(0, 40)}`;
		let id = base;
		let k = 2;
		while (used.has(id)) id = `${base}-${k++}`;
		used.add(id);
		ids.set(n.id, id);
		return id;
	};
	const gui = (n) => {
		const d = depth.get(n);
		const row = rows.get(d) ?? 0;
		rows.set(d, row + 1);
		return { x: ORIGIN + d * X_STEP, y: ORIGIN + row * Y_STEP };
	};
	const names = new Set();
	const nameFor = (n) => {
		if (n.tileName) return n.tileName;
		let name = n.label;
		let k = 2;
		while (names.has(name)) name = `${n.label} (${k++})`;
		names.add(name);
		return name;
	};
	for (const n of nodes) if (n.tileName) names.add(n.tileName);

	const actions = [];
	for (const n of nodes) {
		const id = idFor(n);
		const dependsOn = n.deps.map(idFor);
		const base = { type: '', id, name: nameFor(n), ...(dependsOn.length ? { dependsOn } : {}), gui: gui(n) };
		if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Tile ${id} (${n.op}) reads the same action twice (${dependsOn.join(', ')}); Magic ETL rejects that at run time`);
		const clash = duplicateName(n.columns);
		if (clash) throw new Error(`Tile ${id} (${n.op}) outputs the column ${clash[0]} and ${clash[1]}, which ADR treats as one name; it rejects that at run time`);
		actions.push(tile(n, base, dependsOn, { adr, zone }));
	}
	let row = 0;
	for (const o of outputs) {
		const from = idFor(o.node);
		const base = `out-${slugify(o.name).slice(0, 40)}`;
		let id = base;
		let k = 2;
		while (used.has(id)) id = `${base}-${k++}`;
		used.add(id);
		actions.push({
			type: 'PublishToVault',
			id,
			name: o.name,
			dependsOn: [from],
			dataSource: { guid: '', name: o.name, description: opts.description ?? '', type: 'DataFlow', ...(adr ? { cloudId: opts.compute.cloudId } : {}) },
			versionChainType: 'REPLACE',
			gui: { x: ORIGIN + (Math.max(0, ...depth.values()) + 1) * X_STEP, y: ORIGIN + row++ * Y_STEP }
		});
	}
	const definition = {
		name: opts.name ?? outputs[0]?.name ?? 'SQL dataflow',
		description: opts.description ?? '',
		databaseType: adr ? 'ADR' : 'MAGIC',
		...(adr ? { computeCloud: opts.compute.cloudId, settings: { sqlDialect: opts.compute.sqlDialect ?? 'ADRENALINE' } } : {}),
		runState: 'ENABLED',
		engineProperties: { 'kettle.mode': 'STRICT' },
		gui: {},
		actions
	};
	const columnsByAction = new Map(nodes.map((n) => [idFor(n), n.columns]));
	return { definition, actionIds: ids, columnsByAction };
}

/**
 * Fold a Select Columns (or Add Formula) tile into the tile of the same kind it reads when nothing else reads that one.
 * Nodes are copied, so the graph itself is unchanged.
 */
function mergeSelects(nodes, outputs) {
	const copies = new Map(nodes.map((n) => [n, { ...n }]));
	for (const c of copies.values()) c.deps = c.deps.map((d) => copies.get(d));
	const outs = outputs.map((o) => ({ ...o, node: copies.get(o.node) }));
	const readers = new Map();
	for (const c of copies.values()) for (const d of c.deps) readers.set(d, (readers.get(d) ?? 0) + 1);
	for (const o of outs) readers.set(o.node, (readers.get(o.node) ?? 0) + 1);
	const removed = new Set();
	for (const c of copies.values()) {
		const up = c.deps[0];
		if (c.op === 'formula' && up?.op === 'formula' && readers.get(up) === 1 && !up.tileName) {
			// One Add Formula tile evaluates its expressions in order, each seeing the ones before (live-checked).
			c.fields = [...up.fields, ...c.fields];
			c.deps = up.deps;
			removed.add(up);
			continue;
		}
		if (c.op !== 'select' || up?.op !== 'select' || readers.get(up) !== 1 || up.tileName) continue;
		const byOut = new Map(up.fields.map((f) => [f.rename ?? f.name, f.name]));
		if (!c.fields.every((f) => byOut.has(f.name))) continue;
		c.fields = c.fields.map((f) => {
			const name = byOut.get(f.name);
			const out = f.rename ?? f.name;
			return out === name ? { name } : { name, rename: out };
		});
		c.deps = up.deps;
		removed.add(up);
	}
	return { nodes: [...copies.values()].filter((c) => !removed.has(c)), outputs: outs };
}

/**
 * Magic ETL rejects a tile that lists one action twice (a self-join, or a union of a table with itself: "Wrong number
 * of dependencies"), so each repeat reads a pass-through Filter that keeps every row instead.
 */
function distinctInputs(nodes) {
	const out = [];
	for (const n of nodes) {
		const seen = new Set();
		let copies = 0;
		n.deps = n.deps.map((d) => {
			if (!seen.has(d)) {
				seen.add(d);
				return d;
			}
			const pass = { op: 'filter', expression: '(1 = 1)', id: `${d.id}.pass${n.id}.${++copies}`, deps: [d], columns: d.columns, label: `${d.label} (second input)` };
			out.push(pass);
			return pass;
		});
		out.push(n);
	}
	return out;
}

/** Two column names that differ only in case (ADR, like Snowflake's resolver, compares them without case). */
export function duplicateName(columns) {
	const seen = new Map();
	for (const c of columns ?? []) {
		const key = c.name.toUpperCase();
		if (seen.has(key)) return [seen.get(key), c.name];
		seen.set(key, c.name);
	}
	return undefined;
}

function tile(n, base, dependsOn, { adr, zone }) {
	const input = dependsOn[0];
	switch (n.op) {
		case 'input':
			return {
				...base,
				type: 'LoadFromVault',
				dataSourceId: n.dataSourceId,
				executeFlowWhenUpdated: false,
				onlyLoadNewVersions: false,
				truncateTextColumns: false,
				truncateRows: false,
				...(adr ? { settings: { preferredDatabaseEntityType: 'TEMP_VIEW' }, sourceType: 'AUTO', filterPolicy: 'LEGACY' } : {})
			};
		case 'formula':
			return { ...base, type: 'ExpressionEvaluator', input, settings: { ...zone }, expressions: n.fields.map((f) => ({ fieldName: f.name, expression: f.expression, settings: {} })) };
		case 'select':
			return { ...base, type: 'SelectValues', input, fields: n.fields.map((f) => (f.rename && f.rename !== f.name ? { name: f.name, rename: f.rename } : { name: f.name })) };
		case 'drop':
			return { ...base, type: 'Metadata', input, fields: n.names.map((name) => ({ name, rename: name, remove: true })) };
		case 'filter':
			return { ...base, type: 'Filter', input, filterList: [{ filterType: 'EXPRESSION', expression: n.expression, andFilterList: [] }] };
		case 'join':
			return {
				...base,
				type: 'MergeJoin',
				joinType: n.joinType,
				step1: dependsOn[0],
				step2: dependsOn[1],
				keys1: n.keys.map((k) => k[0]),
				keys2: n.keys.map((k) => k[1]),
				schemaModification1: [],
				schemaModification2: n.rightRenames.map((r) => ({ name: r.name, rename: r.rename, remove: Boolean(r.remove) }))
			};
		case 'group':
			return { ...base, type: 'GroupBy', input, settings: { ...zone }, addLineNumber: false, giveBackRow: false, allRows: false, groups: n.groups.map((name) => ({ name })), fields: n.fields.map((f) => ({ name: f.name, expression: f.expression })) };
		case 'window':
			return {
				...base,
				type: 'WindowAction',
				input,
				groupRules: n.partition.map((column) => ({ column, caseSensitive: false })),
				orderRules: n.order.map((o) => ({ column: o.name, caseSensitive: false, ascending: o.asc })),
				additions: n.additions.map(windowAddition)
			};
		case 'unique':
			return { ...base, type: 'Unique', input, countRows: false, fields: n.fields.map((name) => ({ name, caseInsensitive: false })) };
		case 'union':
			return { ...base, type: 'UnionAll', schemaSource: dependsOn[0], unionType: 'INCLUDE_ALL', strict: false };
		case 'limit':
			return { ...base, type: 'Limit', input, limit: n.limit, offset: n.offset };
		case 'sql':
			return { ...base, type: 'SQL', inputs: dependsOn, ...(n.dialect ? { settings: { sqlDialect: n.dialect, preferredDatabaseEntityType: 'TEMP_VIEW' } } : {}), statements: [n.sql] };
		default:
			throw new Error(`Unknown tile node ${n.op}`);
	}
}

function windowAddition(a) {
	if (a.fn === 'ROW_NUMBER' || a.fn === 'RANK' || a.fn === 'DENSE_RANK') return { name: a.name, operation: { type: 'RANKING', operationType: a.fn, column: null, defaultValue: null, amount: null } };
	if (a.fn === 'LAG' || a.fn === 'LEAD') return { name: a.name, operation: { type: 'OFFSET', operationType: a.fn, column: a.column, defaultValue: a.defaultValue ?? null, amount: a.amount ?? 1 } };
	return { name: a.name, operation: { type: 'FRAMED', operationType: FRAMED_OPERATIONS[a.fn], column: a.column, preceding: a.frame.preceding, following: a.frame.following } };
}
