import { requireDomo } from '../../config.js';
import { SelectionError, parseKinds } from '../../convert/select.js';
import { createEmitter } from '../../util/events.js';
import { unpushPlan } from '../../pipeline/unpush.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { formatTable } from '../reporter.js';
import { SELECT_OPTIONS, UsageError, askYesNo, requireWorkbookArg, selectionFrom } from '../shared.js';

export const name = 'unpush';
export const summary = 'Delete what push created in Domo for a workbook (only objects recorded in push state)';
export const usage = 't2d unpush --workbook <slug> [--dashboards <names>] [--worksheets <names>] [--datasources <names>] [--only <kinds>] [--keys <keys>] [--dry-run] [--yes]';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'Pushed workbook' },
	...SELECT_OPTIONS,
	only: { type: 'string', value: '<kinds>', description: 'Comma list: datasets,dataflows,variables,beastmodes,app,pages,cards,layouts,navigation' },
	keys: { type: 'string', value: '<keys>', description: 'Comma list of plan keys (or kind:key) to delete; * globs' },
	'dry-run': { type: 'boolean', short: 'n', description: 'Show what would be deleted; no network calls' },
	yes: { type: 'boolean', short: 'y', description: 'Do not ask for confirmation' }
};

/**
 * Text summary of an unpush or its dry run.
 * @param {import('../../pipeline/unpush.js').UnpushSummary} summary
 */
export function formatUnpushSummary(summary) {
	const rows = summary.actions.map((a) => [a.kind, a.name ?? a.key, a.action, a.status, a.id ?? '', a.error ?? (a.notes ?? []).join('; ')]);
	const c = summary.counts ?? {};
	const head = `${summary.dryRun ? 'Dry run against' : 'Unpushed from'} ${summary.instance}: ${c.delete || 0} delete, ${c.keep || 0} keep, ${c['status:skipped'] || 0} left in place, ${c['status:failed'] || 0} failed`;
	if (!rows.length) return `${head}\nNothing recorded in state for this workbook and selection.`;
	return `${formatTable(['Kind', 'Name', 'Action', 'Status', 'Id', 'Detail'], rows)}\n\n${head}`;
}

/** @param {import('../main.js').CommandContext} ctx */
export async function run(ctx) {
	const { config, args, reporter, io } = ctx;
	try {
		parseKinds(args.values.only);
	} catch (err) {
		if (err instanceof SelectionError) throw new UsageError(err.message);
		throw err;
	}
	const selection = selectionFrom(args.values, { kinds: true });
	const dryRun = Boolean(args.values['dry-run']);
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	if (!dryRun) requireDomo(config);
	const emitter = createEmitter(reporter.sink, 'unpush');

	if (!dryRun && !args.values.yes) {
		if (!(io.stdin ?? process.stdin).isTTY) throw new UsageError('Refusing to delete from a non-interactive session. Re-run with --yes (or --dry-run).');
		if (reporter.json) throw new UsageError('--json cannot show the deletion preview for confirmation. Re-run with --yes (or --dry-run).');
		const preview = await unpushPlan({ config, slug, selection, dryRun: true, emitter });
		reporter.note(formatUnpushSummary(preview));
		if (!preview.actions.some((a) => a.action === 'delete')) {
			reporter.print('Nothing to delete.');
			return { slug, preview };
		}
		if (!(await askYesNo(io, `Delete these objects from ${config.domo.instance}?`))) {
			reporter.print('Cancelled; nothing was deleted.');
			return { slug, cancelled: true, preview };
		}
	}
	const summary = await unpushPlan({ config, slug, selection, dryRun, emitter });
	reporter.print(formatUnpushSummary(summary));
	reporter.print(`Log: ${dryRun ? ws.paths(slug).unpushDryRun : ws.paths(slug).unpushLog}`);
	return summary;
}
