/** Tableau function classification shared by the analyzer and the emitter. */

export const AGGREGATES = new Set([
	'SUM',
	'AVG',
	'MIN',
	'MAX',
	'COUNT',
	'COUNTD',
	'MEDIAN',
	'ATTR',
	'STDEV',
	'STDEVP',
	'VAR',
	'VARP',
	'PERCENTILE',
	'CORR',
	'COVAR',
	'COVARP'
]);

export const TABLE_CALCS = new Set([
	'RUNNING_SUM',
	'RUNNING_AVG',
	'RUNNING_COUNT',
	'RUNNING_MIN',
	'RUNNING_MAX',
	'WINDOW_SUM',
	'WINDOW_AVG',
	'WINDOW_COUNT',
	'WINDOW_MIN',
	'WINDOW_MAX',
	'WINDOW_MEDIAN',
	'WINDOW_STDEV',
	'WINDOW_STDEVP',
	'WINDOW_VAR',
	'WINDOW_VARP',
	'WINDOW_PERCENTILE',
	'WINDOW_CORR',
	'WINDOW_COVAR',
	'WINDOW_COVARP',
	'TOTAL',
	'RANK',
	'RANK_DENSE',
	'RANK_MODIFIED',
	'RANK_PERCENTILE',
	'RANK_UNIQUE',
	'INDEX',
	'FIRST',
	'LAST',
	'SIZE',
	'LOOKUP',
	'PREVIOUS_VALUE'
]);

export const USER_FUNCTIONS = new Set([
	'USERNAME',
	'FULLNAME',
	'USERDOMAIN',
	'ISMEMBEROF',
	'ISUSERNAME',
	'ISFULLNAME',
	'USERATTRIBUTE',
	'USERATTRIBUTEINCLUDES'
]);

export const SPATIAL_FUNCTIONS = new Set([
	'MAKEPOINT',
	'MAKELINE',
	'DISTANCE',
	'BUFFER',
	'AREA',
	'INTERSECTS',
	'OUTLINE',
	'SHAPETYPE',
	'VALIDATE',
	'COLLECT',
	'HEXBINX',
	'HEXBINY',
	'DIFFERENCE',
	'INTERSECTION',
	'SYMDIFFERENCE',
	'LENGTH'
]);

// Trigonometric functions fail validateFunctions with ILLEGAL_FUNCTION.
export const NO_EQUIVALENT = new Set([
	'REGEXP_EXTRACT',
	'REGEXP_EXTRACT_NTH',
	'PREVIOUS_VALUE',
	'SIN',
	'COS',
	'TAN',
	'COT',
	'ASIN',
	'ACOS',
	'ATAN',
	'ATAN2'
]);

/** Functions whose value changes over time: a Beast Mode reads them at query time, a Magic ETL column at its last run. */
export const VOLATILE_FUNCTIONS = new Set(['TODAY', 'NOW']);

/** NO_EQUIVALENT functions that Magic ETL formulas support, with their argument count. */
export const ETL_ONLY_FUNCTIONS = new Map([
	['SIN', 1],
	['COS', 1],
	['TAN', 1],
	['COT', 1],
	['ASIN', 1],
	['ACOS', 1],
	['ATAN', 1],
	['ATAN2', 2]
]);

export const isRawSql = (name) => /^RAWSQL(AGG)?_/.test(name);
export const isScript = (name) => /^SCRIPT_/.test(name) || /^MODEL_/.test(name);

/** Aggregate call: MIN/MAX with two arguments are row-level comparisons, not aggregates. */
export function isAggregateCall(node) {
	if (node.type !== 'Call' || !AGGREGATES.has(node.name)) return false;
	if ((node.name === 'MIN' || node.name === 'MAX') && node.args.length === 2) return false;
	return true;
}

/**
 * Category for a function name, for analysis and issue codes.
 * @param {string} name Upper-case function name
 * @param {Set<string>} known Names the emitter can translate
 * @returns {'aggregate'|'table-calc'|'user'|'spatial'|'rawsql'|'script'|'no-equivalent'|'known'|'unknown'}
 */
export function classifyFunction(name, known) {
	if (USER_FUNCTIONS.has(name)) return 'user';
	if (SPATIAL_FUNCTIONS.has(name)) return 'spatial';
	if (isRawSql(name)) return 'rawsql';
	if (isScript(name)) return 'script';
	if (NO_EQUIVALENT.has(name)) return 'no-equivalent';
	if (TABLE_CALCS.has(name)) return 'table-calc';
	if (AGGREGATES.has(name)) return 'aggregate';
	return known.has(name) ? 'known' : 'unknown';
}
