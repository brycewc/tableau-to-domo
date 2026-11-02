import { createEmitter } from '../../util/events.js';
import { convertStage } from '../../pipeline/convert.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { CONVERT_OPTIONS, SELECT_OPTIONS, convertOptionsFrom, requireWorkbookArg, selectionFrom } from '../shared.js';

export const name = 'convert';
export const summary = 'Turn ir.json into a Domo plan (plan.json) and a migration report; no network';
export const usage = 't2d convert --workbook <slug|name> [--no-fixed] [--no-window-functions] [--parameters inline|variables] [--joins dataflow|view|flatten] [--no-filter-cards] [--no-materialize] [--target app|pages] [--theme <name>] [--nav top|left] [--no-persist-filters] [--no-domo-nav] [--workbook-theme|--no-workbook-theme] [--no-tableau-links] [--prefix <text>] [--page-title <title>] [--dashboards <names>] [--worksheets <names>] [--datasources <names>] [--all-beast-modes] [--full]';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'Extracted workbook' },
	...CONVERT_OPTIONS,
	...SELECT_OPTIONS,
	'all-beast-modes': { type: 'boolean', description: 'Plan a Beast Mode for every translated calc, also those no migrated card, filter or view uses' },
	full: { type: 'boolean', description: 'Plan the whole workbook, ignoring selection flags and the selection extract ran with' }
};

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const convertOptions = convertOptionsFrom(args.values);
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	const selection = selectionFrom(args.values);
	const plan = await convertStage({ config, slug, options: convertOptions, selection, full: Boolean(args.values.full), emitter: createEmitter(reporter.sink, 'convert') });
	const p = ws.paths(slug);
	const counts = {
		datasets: plan.datasets?.length ?? 0,
		dataflows: plan.dataflows?.length ?? 0,
		beastModes: plan.beastModes?.length ?? 0,
		variables: plan.variables?.length ?? 0,
		cards: plan.cards?.length ?? 0,
		pages: plan.pages?.length ?? 0,
		errors: (plan.issues ?? []).filter((i) => i.severity === 'error').length,
		warnings: (plan.issues ?? []).filter((i) => i.severity === 'warning').length
	};
	reporter.print(`Plan for ${slug}: ${counts.datasets} dataset(s), ${counts.dataflows} dataflow(s), ${counts.beastModes} beast mode(s), ${counts.variables} variable(s), ${counts.cards} card(s), ${plan.app ? `an app with ${counts.pages} view(s)` : `${counts.pages} page(s)`}`);
	if (plan.selection) {
		const s = plan.selection;
		reporter.print(`  Subset of ${s.counts.before.cards} card(s), ${s.counts.before.datasets} dataset(s): ${[...s.dashboards.map((d) => `dashboard "${d}"`), ...s.worksheets.map((w) => `worksheet "${w}"`), ...s.datasources.map((d) => `datasource "${d}"`)].join(', ')}`);
	}
	reporter.print(`  ${counts.errors} error(s), ${counts.warnings} warning(s). Details: ${p.report}`);
	reporter.print(`Next: t2d push --workbook ${slug} --dry-run`);
	return { slug, plan: p.plan, report: p.report, counts, ...(plan.selection ? { selection: plan.selection } : {}) };
}
