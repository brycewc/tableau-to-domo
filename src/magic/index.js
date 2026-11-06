import { planSql } from './planner.js';
import { buildDefinition } from './tiles.js';
import { splitDefinition } from './stages.js';
import { parseExpr } from './parser.js';
import { snowflakeToFormula, toSnowflake } from './expr.js';

export { magicToSql } from './to-sql.js';
export { parseScript, parseQuery, parseExpr } from './parser.js';
export { TranslateError, toMagic, toSnowflake, snowflakeToFormula, magicType } from './expr.js';

/**
 * @typedef {import('./planner.js').InputTable} InputTable
 * @typedef {import('./planner.js').Blocker} Blocker
 * @typedef {import('./tiles.js').ComputeTarget} ComputeTarget
 *
 * @typedef {Object} SqlToMagicOptions
 * @property {import('./planner.js').InputResolver|Record<string, InputTable>} [inputs]  Warehouse tables, keyed by
 *   fully qualified upper-case name (DB.SCHEMA.TABLE), or a resolver; columns let more statements become tiles
 * @property {{ name: string, sql: string }[]} [outputs]  Queries that read the script's tables (Tableau Custom SQL); one PublishToVault each
 * @property {string[]} [publish]                          Script tables to publish as they stand at the end
 * @property {ComputeTarget} [compute]                     Run on a Cloud Amplifier warehouse (ADR) instead of Domo's engine
 * @property {'auto'|'tiles'|'sql'} [mode]                 auto (default): tiles, SQL tile where tiles cannot; tiles: never SQL tile; sql: SQL tile per query
 * @property {string} [name]                               Dataflow name
 * @property {string} [description]
 * @property {string} [database]                           Connection database/schema before any USE
 * @property {string} [schema]
 * @property {number} [maxActions]                        Actions per dataflow before it is split into stages (default 100; ADR allows 128)
 *
 * @typedef {{ name: string, type: 'STRING'|'LONG'|'DOUBLE'|'DECIMAL'|'DATE'|'DATETIME'|null }} OutputColumn  `type` null: not evident from the SQL
 *
 * @typedef {Object} SqlToMagicResult
 * @property {object} [definition]                         Dataflow definition for POST /dataprocessing/v1/dataflows (absent when blocked)
 * @property {import('./stages.js').Stage[]} [stages]      The same work as dataflows ADR accepts, in run order (one when it fits).
 *   A later stage's LoadFromVault of an earlier stage's output has dataSourceId `stage:<output name>`
 * @property {object[]} actions
 * @property {{ name: string, actionId: string, columns: OutputColumn[]|null }[]} outputs  `columns`: the output dataset's
 *   columns as Domo names them after the run (null when an input's schema was unknown and a `*` passed it through)
 * @property {{ table: string, actionId: string, dataSourceId: any, columns: object[]|null }[]} inputs
 * @property {import('./expr.js').Issue[]} issues
 * @property {Blocker} [blocked]                           The first statement that cannot be translated
 * @property {Blocker[]} blockers                          Every statement that cannot be translated (later ones may depend on earlier ones)
 * @property {{ index: number, kind: string, text: string, note?: string }[]} statements
 * @property {string[]} tables                             Tables the script leaves behind (fully qualified upper-case names)
 * @property {{ tiles: number, sqlTiles: number, byType: Record<string, number> }} stats
 */

/**
 * Translate a Snowflake SQL script (temp tables, UPDATE/DELETE/INSERT, then the output queries) into a Magic ETL
 * dataflow. Pure: no I/O.
 * @param {string} script
 * @param {SqlToMagicOptions} [opts]
 * @returns {SqlToMagicResult}
 */
export function sqlToMagic(script, opts = {}) {
	const plan = planSql(script, opts);
	const base = { issues: plan.issues, blockers: plan.blockers, statements: plan.statements, tables: plan.tables };
	if (plan.blockers.length) return { ...base, blocked: plan.blockers[0], actions: [], outputs: [], inputs: [], stats: { tiles: 0, sqlTiles: 0, byType: {} } };
	if (!plan.outputs.length) {
		const blocked = { statement: -1, excerpt: '', reason: 'nothing to publish: pass outputs (the Custom SQL) or publish (table names)' };
		return { ...base, blocked, blockers: [blocked], actions: [], outputs: [], inputs: [], stats: { tiles: 0, sqlTiles: 0, byType: {} } };
	}
	const { definition, actionIds, columnsByAction } = buildDefinition(plan.graph, plan.outputs, opts);
	const byType = {};
	for (const a of definition.actions) byType[a.type] = (byType[a.type] ?? 0) + 1;
	const outputs = plan.outputs.map((o) => ({ name: o.name, actionId: definition.actions.find((a) => a.type === 'PublishToVault' && a.name === o.name)?.id, columns: outputColumns(o.node) }));
	const stages = splitDefinition(definition, {
		maxActions: opts.maxActions,
		columnsOf: (id) => outputColumns({ columns: columnsByAction.get(id) ?? null }),
		finalColumns: (name) => outputs.find((o) => o.name === name)?.columns ?? null
	});
	return {
		...base,
		definition,
		stages,
		actions: definition.actions,
		outputs,
		inputs: plan.inputs.filter((n) => actionIds.has(n.id)).map((n) => ({ table: n.table, actionId: actionIds.get(n.id), dataSourceId: n.dataSourceId, columns: n.columns })),
		stats: { tiles: definition.actions.length, sqlTiles: byType.SQL ?? 0, byType }
	};
}

const DOMO_TYPES = new Set(['STRING', 'LONG', 'DOUBLE', 'DECIMAL', 'DATE', 'DATETIME']);

/**
 * Output dataset columns. Names are exact: tiles and SQL tiles write every name in Snowflake's stored form (unquoted
 * names upper-cased, quoted kept), and ADR keeps the case it is given. Booleans become 'true'/'false' text.
 */
function outputColumns(node) {
	if (!node.columns) return null;
	return node.columns.map((c) => ({ name: c.name, type: c.type === 'BOOLEAN' ? 'STRING' : DOMO_TYPES.has(c.type) ? c.type : null }));
}

/**
 * Magic ETL formula -> Snowflake SQL expression.
 * @param {string} formula
 */
export function formulaToSnowflake(formula) {
	return toSnowflake(parseExpr(formula, { formula: true }));
}

/**
 * Snowflake SQL expression -> Magic ETL formula (columns become backticked stored names).
 * @param {string} sql
 * @param {Parameters<typeof snowflakeToFormula>[1]} [opts]
 */
export function sqlExpressionToFormula(sql, opts) {
	return snowflakeToFormula(parseExpr(sql), opts);
}
