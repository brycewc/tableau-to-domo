import readline from 'node:readline';
import { BUILTIN_THEMES, DEFAULT_THEME } from '../convert/layout.js';
import { SelectionError, normalizeSelection } from '../convert/select.js';
import { UNMAPPED_POLICIES } from '../pipeline/decisions.js';
import { formatDuration, formatTimingSummary } from '../util/timing.js';
import { formatTable } from './reporter.js';

export class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = 'UsageError';
	}
}

export const GLOBAL_OPTIONS = {
	env: { type: 'string', value: '<name>', description: 'Load .env.<name> on top of .env' },
	workspace: { type: 'string', value: '<dir>', description: 'Workspace directory (default ./t2d-work or T2D_WORKSPACE)' },
	json: { type: 'boolean', description: 'NDJSON events on stdout; the last line is the result' },
	quiet: { type: 'boolean', short: 'q', description: 'Only warnings and errors' },
	verbose: { type: 'boolean', short: 'v', description: 'Show per-object progress and event data' },
	help: { type: 'boolean', short: 'h', description: 'Show help' },
	version: { type: 'boolean', description: 'Print the version' }
};

export const SELECT_OPTIONS = {
	dashboards: { type: 'string', multiple: true, value: '<names>', description: 'Only these dashboards (comma list or repeat; * globs; case-insensitive)' },
	worksheets: { type: 'string', multiple: true, value: '<names>', description: 'Only these worksheets' },
	datasources: { type: 'string', multiple: true, value: '<names>', description: 'Only these datasources (caption or id)' }
};

export const SAMPLE_OPTION = {
	'sample-rows': { type: 'string', value: '<n>', description: 'Only the first N rows per table (partial data, for testing)' }
};

export const EXTRACT_OPTIONS = {
	workbook: { type: 'string', short: 'w', value: '<name|luid>', description: 'Workbook on Tableau Server/Cloud' },
	file: { type: 'string', short: 'f', value: '<path>', description: 'Local .twb/.twbx instead of the server' },
	project: { type: 'string', short: 'p', value: '<name>', description: 'Project, to disambiguate the workbook name' },
	'data-strategy': {
		type: 'string',
		value: '<s>',
		description: 'auto | existing | cloud-amplifier | federated | connector | hyper | published-extract | vds | view-csv | none (default auto)'
	},
	unmapped: {
		type: 'string',
		value: '<mode>',
		description: 'ask | export | fail: a datasource no mapping covers that would be exported as a snapshot (default ask; without a terminal, --json or --yes it stops like fail; export exports as before)'
	},
	'no-domo-lookup': { type: 'boolean', description: 'Make no read-only Domo calls (Cloud Amplifier, federated and connector account matching) during extract' },
	'snowflake-views': { type: 'boolean', description: 'Turn Snowflake Initial SQL temp tables and the Custom SQL over them into views in SNOWFLAKE_VIEW_SCHEMA, so Cloud Amplifier reads them live (needs SNOWFLAKE_* settings; without them the DDL is written for review)' },
	'no-extract-data': { type: 'boolean', description: 'Download the workbook without its packaged extract; undecided datasources get no data instead of a question' },
	'no-metadata': { type: 'boolean', description: 'Skip the Tableau Metadata API lookup' },
	'no-published-fields': { type: 'boolean', description: 'Do not merge field definitions from published datasource .tds files' },
	'refresh-data': { type: 'boolean', description: 'Re-extract shared published datasource data even when it is unchanged on Tableau' }
};

export const CONVERT_OPTIONS = {
	'use-fixed': { type: 'boolean', description: 'Translate LODs with Domo FIXED (default)' },
	'no-fixed': { type: 'boolean', description: 'Do not use FIXED; LOD calcs become unsupported' },
	'window-functions': { type: 'boolean', description: 'Translate table calcs with OVER() window functions (default)' },
	'no-window-functions': { type: 'boolean', description: 'Do not use window functions; table calcs become unsupported' },
	parameters: { type: 'string', value: '<mode>', description: 'variables | inline (default variables; parameters that cannot be variables stay inline)' },
	joins: { type: 'string', value: '<mode>', description: 'dataflow | view | flatten (default dataflow)' },
	'no-filter-cards': { type: 'boolean', description: 'Do not create filter cards for dashboard filters' },
	'no-materialize': { type: 'boolean', description: 'Do not compute calcs Beast Mode cannot express (LODs used as dimensions, trig) in a Magic ETL dataflow' },
	prefix: { type: 'string', value: '<text>', description: 'Prefix for created Domo object names' },
	'page-title': { type: 'string', value: '<title>', description: 'App or root page title (default: workbook name)' },
	target: { type: 'string', value: '<target>', description: 'app | pages: an App Studio app with one view per dashboard, or a root page with subpages (default app)' },
	theme: { type: 'string', value: '<name>', description: `App theme, a built-in name (default ${DEFAULT_THEME}); given, push also applies it to an existing app` },
	nav: { type: 'string', value: '<top|left>', description: 'App navigation placement (default top; a long top navigation folds into a "More" menu)' },
	'no-persist-filters': { type: 'boolean', description: 'Do not carry app filters and variables across views' },
	'domo-nav': { type: 'boolean', description: 'Show Domo\'s own navigation beside the app (the default with top navigation; never with left)' },
	'no-domo-nav': { type: 'boolean', description: 'Hide Domo\'s own navigation beside a top app navigation' },
	'workbook-theme': { type: 'boolean', description: 'Clone the theme with the workbook\'s fonts and colors (default on app create); given, push also applies it to an existing app' },
	'no-workbook-theme': { type: 'boolean', description: 'Use the built-in theme unchanged' },
	unpublished: { type: 'boolean', description: 'Also migrate dashboards and worksheets Tableau does not publish as views and no published view opens' },
	'no-tableau-links': { type: 'boolean', description: 'Do not put a link to each dashboard on Tableau in the text card at the top of its view (by default a view with no text card gets one just for the link)' }
};

export const PUSH_OPTIONS = {
	'dry-run': { type: 'boolean', short: 'n', description: 'Show what would be created or updated; no writes' },
	'parent-page': { type: 'string', value: '<id>', description: 'Create the root page under this Domo page id (--target pages only)' },
	only: { type: 'string', value: '<kinds>', description: 'Comma list: datasets,dataflows,variables,beastmodes,app,pages,cards,layouts,navigation' },
	force: { type: 'boolean', description: 'Re-send unchanged objects and re-upload data' },
	keys: { type: 'string', value: '<keys>', description: 'Comma list of plan keys (or kind:key) to write; * globs (see t2d show)' },
	'schema-only': { type: 'boolean', description: 'Create datasets with their schema and no rows' },
	'all-beast-modes': { type: 'boolean', description: 'With a selection, keep every beast mode of the kept datasets; migrate also plans those nothing migrated uses' },
	yes: { type: 'boolean', short: 'y', description: 'Do not ask for confirmation' }
};

/**
 * Selection flags (dashboards, worksheets, datasources, sample rows, keys, kinds, schema only) as a Selection.
 * @param {Record<string, any>} values
 * @param {{ kinds?: boolean }} [opts]  `kinds` reads --only as the kinds to write
 * @returns {import('../convert/select.js').Selection}
 */
export function selectionFrom(values, { kinds = false } = {}) {
	try {
		return normalizeSelection({
			dashboards: values.dashboards,
			worksheets: values.worksheets,
			datasources: values.datasources,
			keys: values.keys,
			kinds: kinds ? values.only : undefined,
			sampleRows: values['sample-rows'],
			schemaOnly: values['schema-only'],
			allBeastModes: values['all-beast-modes']
		});
	} catch (err) {
		if (err instanceof SelectionError) throw new UsageError(err.message.replace('sampleRows', '--sample-rows'));
		throw err;
	}
}

const PARAMETER_MODES = new Set(['inline', 'variables']);
const TARGETS = new Set(['app', 'pages']);
const JOIN_MODES = new Set(['dataflow', 'view', 'flatten']);
const STRATEGIES = new Set(['auto', 'existing', 'cloud-amplifier', 'federated', 'connector', 'hyper', 'published-extract', 'vds', 'view-csv', 'none']);

/**
 * @param {Record<string, any>} values
 * @returns {import('../model/types.js').ConvertOptions}
 */
export function convertOptionsFrom(values) {
	if (values['use-fixed'] && values['no-fixed']) throw new UsageError('--use-fixed and --no-fixed cannot be combined');
	const options = {};
	if (values['no-fixed']) options.useFixed = false;
	else if (values['use-fixed']) options.useFixed = true;
	if (values['window-functions'] && values['no-window-functions']) throw new UsageError('--window-functions and --no-window-functions cannot be combined');
	if (values['no-window-functions']) options.useWindowFunctions = false;
	else if (values['window-functions']) options.useWindowFunctions = true;
	if (values.parameters !== undefined) {
		if (!PARAMETER_MODES.has(values.parameters)) throw new UsageError(`--parameters must be inline or variables, got "${values.parameters}"`);
		options.parameters = values.parameters;
	}
	if (values.joins !== undefined) {
		if (!JOIN_MODES.has(values.joins)) throw new UsageError(`--joins must be dataflow, view or flatten, got "${values.joins}"`);
		options.joins = values.joins;
	}
	if (values['no-filter-cards']) options.createFilterCards = false;
	if (values['no-materialize']) options.materialize = false;
	if (values.prefix !== undefined) options.namePrefix = values.prefix;
	if (values['page-title'] !== undefined) options.pageTitle = values['page-title'];
	if (values.target !== undefined) {
		if (!TARGETS.has(values.target)) throw new UsageError(`--target must be app or pages, got "${values.target}"`);
		options.target = values.target;
	}
	const appOnly = ['theme', 'nav', 'no-persist-filters', 'domo-nav', 'no-domo-nav', 'workbook-theme', 'no-workbook-theme'].filter((k) => values[k] !== undefined);
	if (options.target === 'pages' && appOnly.length) throw new UsageError(`--${appOnly[0]} applies to --target app only`);
	if (values.theme !== undefined) {
		const theme = BUILTIN_THEMES.find((t) => t.toLowerCase() === String(values.theme).toLowerCase());
		if (!theme) throw new UsageError(`--theme must be a built-in App Studio theme: ${BUILTIN_THEMES.join(', ')}`);
		options.theme = theme;
	}
	if (values.nav !== undefined) {
		const nav = String(values.nav).toUpperCase();
		if (nav !== 'TOP' && nav !== 'LEFT') throw new UsageError(`--nav must be top or left, got "${values.nav}"`);
		options.navOrientation = nav;
	}
	if (values['no-persist-filters']) options.persistFilters = false;
	if (values['domo-nav'] && values['no-domo-nav']) throw new UsageError('--domo-nav and --no-domo-nav cannot be combined');
	if (values['domo-nav']) options.domoNav = true;
	else if (values['no-domo-nav']) options.domoNav = false;
	if (values['workbook-theme'] && values['no-workbook-theme']) throw new UsageError('--workbook-theme and --no-workbook-theme cannot be combined');
	if (values['workbook-theme']) options.workbookTheme = true;
	else if (values['no-workbook-theme']) options.workbookTheme = false;
	if (values['no-tableau-links']) options.tableauLinks = false;
	if (values['all-beast-modes']) options.allBeastModes = true;
	if (values.unpublished) options.unpublished = true;
	return options;
}

/** @param {Record<string, any>} values */
export function extractOptionsFrom(values) {
	if (!values.workbook && !values.file) throw new UsageError('Pass --workbook <name|luid> or --file <path>');
	if (values.workbook && values.file) throw new UsageError('Pass either --workbook or --file, not both');
	const strategy = values['data-strategy'] ?? 'auto';
	if (!STRATEGIES.has(strategy)) throw new UsageError(`--data-strategy must be one of ${[...STRATEGIES].join(', ')}`);
	const unmapped = values.unmapped ?? 'ask';
	if (!UNMAPPED_POLICIES.includes(unmapped)) throw new UsageError(`--unmapped must be one of ${UNMAPPED_POLICIES.join(', ')}`);
	return {
		unmapped,
		workbook: values.workbook,
		file: values.file,
		project: values.project,
		dataStrategy: strategy,
		includeExtract: !values['no-extract-data'],
		metadata: !values['no-metadata'],
		publishedFields: !values['no-published-fields'],
		domoLookup: !values['no-domo-lookup'],
		snowflakeViews: Boolean(values['snowflake-views']),
		refreshShared: Boolean(values['refresh-data'])
	};
}

/** @param {Record<string, any>} values */
export function requireWorkbookArg(values, positionals = []) {
	const value = values.workbook ?? positionals[0];
	if (!value) throw new UsageError('Pass --workbook <slug|name>');
	return value;
}

/**
 * Ask a yes/no question on stderr. Refuses (UsageError) without a TTY.
 * @param {{ stdin?: any, stderr?: any }} io
 * @param {string} question
 */
export async function askYesNo(io, question) {
	const stdin = io.stdin ?? process.stdin;
	const stderr = io.stderr ?? process.stderr;
	if (!stdin.isTTY) throw new UsageError('Refusing to change Domo from a non-interactive session. Re-run with --yes (or --dry-run).');
	const rl = readline.createInterface({ input: stdin, output: stderr, terminal: true });
	try {
		const answer = await new Promise((resolve) => {
			rl.question(`${question} [y/N] `, resolve);
			rl.once('close', () => resolve(''));
		});
		return /^y(es)?$/i.test(String(answer).trim());
	} finally {
		rl.close();
	}
}

/**
 * Text summary of a push or dry run.
 * @param {import('../pipeline/push.js').PushSummary} summary
 * @param {{ verbose?: boolean }} [opts]
 */
export function formatPushSummary(summary, { verbose = false } = {}) {
	const rows = summary.actions
		.filter((a) => verbose || a.action !== 'unchanged' || a.status === 'failed')
		.map((a) => [a.kind, a.name ?? a.key, a.action, a.status, a.id ?? '', a.error ?? (a.notes ?? []).join('; ')]);
	const c = summary.counts ?? {};
	const head = `${summary.dryRun ? 'Dry run against' : 'Pushed to'} ${summary.instance}: ${c.create || 0} create, ${c.register ? `${c.register} register, ` : ''}${c.update || 0} update, ${c.unchanged || 0} unchanged, ${c.reuse || 0} reuse, ${c['status:failed'] || 0} failed, ${c['status:skipped'] || 0} skipped`;
	if (!rows.length) return head;
	return `${formatTable(['Kind', 'Name', 'Action', 'Status', 'Id', 'Detail'], rows)}\n\n${head}`;
}

/** Total, then the slowest steps; a migrate timing (with `stages`) ranks extract and push steps together. */
export function formatTiming(timing, { label = 'Time' } = {}) {
	if (!timing) return '';
	if (!timing.stages) return formatTimingSummary(timing, { label }).join('\n');
	const stages = timing.steps.map((s) => `${s.step} ${formatDuration(s.ms)}`).join(', ');
	const steps = [
		...Object.entries(timing.stages).flatMap(([stage, t]) => t.steps.map((s) => ({ ...s, step: `${stage} ${s.step}` }))),
		...timing.steps.filter((s) => s.step === 'convert')
	];
	const [total, ...rest] = formatTimingSummary({ ...timing, steps }, { label });
	return [`${total}${stages ? ` (${stages})` : ''}`, ...rest].join('\n');
}
