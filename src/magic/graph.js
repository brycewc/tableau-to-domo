/**
 * The logical tile graph sqlToMagic builds before it becomes Magic ETL actions. Each node is one tile; `columns` is the
 * node's output schema when it is known (null when an input's schema was not supplied and could not be derived).
 *
 * @typedef {{ name: string, type?: string }} Column
 * @typedef {{ name: string, rename?: string }} SelectField
 * @typedef {{ name: string, expression: string }} FormulaField
 * @typedef {{ name: string, asc: boolean }} OrderRule
 * @typedef {{ name: string, fn: 'ROW_NUMBER'|'RANK'|'DENSE_RANK'|'LAG'|'LEAD'|'SUM'|'AVG'|'MIN'|'MAX'|'COUNT', column?: string, amount?: number, defaultValue?: any, frame?: object }} WindowAddition
 *
 * @typedef {{ op: 'input', table: string, label: string, dataSourceId: any }
 *   | { op: 'formula', fields: FormulaField[] }
 *   | { op: 'select', fields: SelectField[] }
 *   | { op: 'drop', names: string[] }
 *   | { op: 'filter', expression: string }
 *   | { op: 'join', joinType: 'INNER'|'LEFT OUTER'|'RIGHT OUTER'|'FULL OUTER', keys: [string, string][], rightRenames: { name: string, rename: string }[] }
 *   | { op: 'group', groups: string[], fields: FormulaField[] }
 *   | { op: 'window', partition: string[], order: OrderRule[], additions: WindowAddition[] }
 *   | { op: 'unique', fields: string[] }
 *   | { op: 'union' }
 *   | { op: 'limit', limit: number, offset: number }
 *   | { op: 'sql', sql: string, inputNames: string[] }} NodeBody
 *
 * @typedef {NodeBody & { id: number, deps: GraphNode[], columns: Column[]|null, label: string, statement?: number, tileName?: string }} GraphNode
 */

export class Graph {
	constructor() {
		/** @type {GraphNode[]} */
		this.nodes = [];
		this.counter = 0;
	}

	/**
	 * @param {NodeBody} body
	 * @param {GraphNode[]} deps
	 * @param {import('./graph.js').Column[]|null} columns
	 * @param {string} label
	 * @returns {GraphNode}
	 */
	add(body, deps, columns, label) {
		const node = { ...body, id: this.nodes.length, deps, columns: columns ? columns.map((c) => ({ ...c })) : null, label, statement: this.statement };
		this.nodes.push(node);
		return node;
	}

	/** A helper column name unique within the script. */
	temp(kind) {
		return `_t2d_${kind}${++this.counter}`;
	}
}

/** Output columns after a formula tile adds or replaces `fields`. */
export function formulaColumns(columns, fields) {
	if (!columns) return null;
	const out = columns.map((c) => ({ ...c }));
	for (const f of fields) {
		const at = out.findIndex((c) => c.name === f.name);
		if (at >= 0) out[at] = { name: f.name, ...(f.type ? { type: f.type } : {}) };
		else out.push({ name: f.name, ...(f.type ? { type: f.type } : {}) });
	}
	return out;
}
