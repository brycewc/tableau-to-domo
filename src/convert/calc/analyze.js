import { AGGREGATES, TABLE_CALCS, USER_FUNCTIONS, classifyFunction, isAggregateCall } from './catalog.js';
import { KNOWN_FUNCTIONS } from './functions.js';

/**
 * @typedef {Object} FormulaAnalysis
 * @property {boolean} aggregated        An aggregate or table calc appears outside any LOD body
 * @property {{ type: 'FIXED'|'INCLUDE'|'EXCLUDE'|'TABLE', dimensions: (string|null)[] }[]} lod  null = expression dimension
 * @property {string[]} tableCalcs        Table calculation function names, in order of appearance
 * @property {string[]} refs              Field ids referenced (parameters excluded), deduplicated
 * @property {string[]} parameters        Parameter ids referenced, deduplicated
 * @property {string[]} userFunctions     USERNAME, ISMEMBEROF, ...
 * @property {string[]} unsupported       Functions with no Domo translation (user, spatial, RAWSQL, SCRIPT, unknown, ...)
 * @property {string[]} functions         Every function called, deduplicated
 */

const isParameterRef = (node) => node.parts.length === 2 && node.parts[0] === 'Parameters';

/**
 * Static facts about a parsed formula. Calc references are not expanded.
 * @param {import('./parser.js').AstNode} ast
 * @returns {FormulaAnalysis}
 */
export function analyzeFormula(ast) {
	const result = { aggregated: false, lod: [], tableCalcs: [], refs: [], parameters: [], userFunctions: [], unsupported: [], functions: [] };
	const add = (list, value) => {
		if (!list.includes(value)) list.push(value);
	};

	function visit(node, inLod) {
		if (!node) return;
		switch (node.type) {
			case 'Field':
				add(isParameterRef(node) ? result.parameters : result.refs, node.id);
				return;
			case 'Call': {
				add(result.functions, node.name);
				const category = classifyFunction(node.name, KNOWN_FUNCTIONS);
				if (TABLE_CALCS.has(node.name)) {
					result.tableCalcs.push(node.name);
					if (!inLod) result.aggregated = true;
				}
				if (AGGREGATES.has(node.name) && isAggregateCall(node) && !inLod) result.aggregated = true;
				if (USER_FUNCTIONS.has(node.name)) add(result.userFunctions, node.name);
				if (['user', 'spatial', 'rawsql', 'script', 'no-equivalent', 'unknown'].includes(category)) add(result.unsupported, node.name);
				if (/^RAWSQLAGG_/.test(node.name) && !inLod) result.aggregated = true;
				node.args.forEach((arg) => visit(arg, inLod));
				return;
			}
			case 'Lod':
				result.lod.push({ type: node.lodType, dimensions: node.dims.map((d) => (d.type === 'Field' ? d.id : null)) });
				node.dims.forEach((d) => visit(d, true));
				visit(node.body, true);
				return;
			case 'Unary':
				visit(node.operand, inLod);
				return;
			case 'Binary':
				visit(node.left, inLod);
				visit(node.right, inLod);
				return;
			case 'In':
				visit(node.expr, inLod);
				node.list.forEach((item) => visit(item, inLod));
				return;
			case 'If':
				node.branches.forEach((b) => {
					visit(b.cond, inLod);
					visit(b.then, inLod);
				});
				visit(node.else, inLod);
				return;
			case 'Case':
				visit(node.subject, inLod);
				node.whens.forEach((w) => {
					visit(w.when, inLod);
					visit(w.then, inLod);
				});
				visit(node.else, inLod);
				return;
			case 'Paren':
				visit(node.expr, inLod);
				return;
			default:
		}
	}

	visit(ast, false);
	return result;
}
