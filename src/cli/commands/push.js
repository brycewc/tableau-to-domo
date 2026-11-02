import { requireDomo } from '../../config.js';
import { createEmitter } from '../../util/events.js';
import { parseOnly, pushPlan } from '../../pipeline/push.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { PUSH_OPTIONS, SAMPLE_OPTION, SELECT_OPTIONS, UsageError, askYesNo, formatPushSummary, formatTiming, requireWorkbookArg, selectionFrom } from '../shared.js';

export const name = 'push';
export const summary = 'Create or update the planned datasets, beast modes, pages and cards in Domo';
export const usage = 't2d push --workbook <slug> [--dry-run] [--parent-page <id>] [--only <kinds>] [--keys <keys>] [--dashboards <names>] [--worksheets <names>] [--datasources <names>] [--schema-only] [--sample-rows <n>] [--force] [--yes]';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'Converted workbook' },
	...PUSH_OPTIONS,
	...SELECT_OPTIONS,
	...SAMPLE_OPTION
};

/** Push options shared by push and migrate. */
export function pushOptionsFrom(values) {
	try {
		parseOnly(values.only);
	} catch (err) {
		throw new UsageError(err.message);
	}
	const parent = values['parent-page'];
	if (parent !== undefined && parent !== '' && !/^[1-9]\d*$/.test(String(parent))) {
		throw new UsageError(`--parent-page must be a numeric Domo page id, got "${parent}"`);
	}
	return {
		dryRun: Boolean(values['dry-run']),
		parentPageId: parent,
		only: values.only,
		force: Boolean(values.force),
		selection: selectionFrom(values)
	};
}

/**
 * Build the confirm callback (or throw for non-interactive sessions without --yes).
 * @param {import('../main.js').CommandContext} ctx
 */
export function confirmerFor(ctx) {
	const { args, reporter, io } = ctx;
	if (args.values.yes || args.values['dry-run']) return null;
	if (!(io.stdin ?? process.stdin).isTTY) throw new UsageError('Refusing to push from a non-interactive session. Re-run with --yes (or --dry-run).');
	if (reporter.json) throw new UsageError('--json cannot show the change preview for confirmation. Re-run with --yes (or --dry-run).');
	return async (preview) => {
		reporter.note(formatPushSummary(preview, { verbose: reporter.verbose }));
		return askYesNo(io, `Apply these changes to ${preview.instance}?`);
	};
}

/** @param {import('../main.js').CommandContext} ctx */
export async function run(ctx) {
	const { config, args, reporter } = ctx;
	const pushOpts = pushOptionsFrom(args.values);
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	if (!pushOpts.dryRun) requireDomo(config);
	const confirm = confirmerFor(ctx);
	const emitter = createEmitter(reporter.sink, 'push');

	if (confirm) {
		const preview = await pushPlan({ config, slug, ...pushOpts, dryRun: true, emitter });
		if (!(await confirm(preview))) {
			reporter.print('Cancelled; nothing was changed.');
			return { slug, cancelled: true, preview };
		}
	}
	const summary = await pushPlan({ config, slug, ...pushOpts, emitter });
	reporter.print(formatPushSummary(summary, { verbose: reporter.verbose }));
	for (const issue of summary.issues.filter((i) => i.code === 'push.partial-data')) reporter.warn(issue.message);
	if (summary.app) reporter.print(`App: ${summary.app.url}`);
	reporter.print(formatTiming(summary.timing, { label: summary.dryRun ? 'Dry run took' : 'Push took' }));
	reporter.print(`Log: ${summary.dryRun ? ws.paths(slug).pushDryRun : ws.paths(slug).pushLog}`);
	return summary;
}
