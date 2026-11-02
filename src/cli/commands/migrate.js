import { requireDomo } from '../../config.js';
import { migrateBatch } from '../../pipeline/batch.js';
import { migrateWorkbook } from '../../pipeline/migrate.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { formatTable } from '../reporter.js';
import { CONVERT_OPTIONS, EXTRACT_OPTIONS, PUSH_OPTIONS, SAMPLE_OPTION, SELECT_OPTIONS, UsageError, convertOptionsFrom, extractOptionsFrom, formatPushSummary, formatTiming } from '../shared.js';
import { deciderFor } from '../decide.js';
import { confirmerFor, pushOptionsFrom } from './push.js';

export const name = 'migrate';
export const summary = 'Extract, convert and push in one go (one workbook, a project, or the whole site)';
export const usage = 't2d migrate (--workbook <name|luid> | --file <path> | --project <name> | --all [--workbooks <names>]) [extract, convert and push options]';
export const options = {
	...EXTRACT_OPTIONS,
	project: { ...EXTRACT_OPTIONS.project, description: 'Project: disambiguates --workbook, or on its own migrates every workbook in it (batch)' },
	all: { type: 'boolean', description: 'Migrate every workbook on the site (batch; see also --project)' },
	workbooks: { type: 'string', multiple: true, value: '<names>', description: 'Batch: only these workbook names or luids (comma list or repeat; * globs)' },
	...CONVERT_OPTIONS,
	...PUSH_OPTIONS,
	...SELECT_OPTIONS,
	...SAMPLE_OPTION,
	'no-push': { type: 'boolean', description: 'Stop after convert' }
};

/** @param {import('../main.js').CommandContext} ctx */
export async function run(ctx) {
	const { args } = ctx;
	const v = args.values;
	const batch = Boolean(v.all) || Boolean(v.workbooks?.length) || (Boolean(v.project) && !v.workbook && !v.file);
	if (batch && (v.workbook || v.file)) throw new UsageError('--all, --workbooks and a project batch cannot be combined with --workbook or --file');
	return batch ? runBatch(ctx) : runOne(ctx);
}

function prepare(ctx, values) {
	const convertOptions = convertOptionsFrom(values);
	const pushOpts = pushOptionsFrom(values);
	if (pushOpts.parentPageId !== undefined && pushOpts.parentPageId !== '' && convertOptions.target !== 'pages') {
		throw new UsageError('--parent-page needs --target pages: App Studio apps have no parent page');
	}
	const skipPush = Boolean(values['no-push']);
	let confirm = null;
	if (!skipPush) {
		if (!pushOpts.dryRun) requireDomo(ctx.config);
		confirm = confirmerFor(ctx);
	}
	return { convertOptions, pushOpts, skipPush, confirm, decide: deciderFor(ctx) };
}

async function runOne(ctx) {
	const { config, args, reporter } = ctx;
	const extractOpts = extractOptionsFrom(args.values);
	const { convertOptions, pushOpts, skipPush, confirm, decide } = prepare(ctx, args.values);
	const result = await migrateWorkbook({
		config,
		...extractOpts,
		decide,
		options: convertOptions,
		...pushOpts,
		skipPush,
		confirm: confirm ?? undefined,
		sink: reporter.sink
	});
	const ws = openWorkspace(config.workspace);
	const p = ws.paths(result.slug);
	if (result.cancelled) reporter.print('Cancelled before push; extract and convert results are in the workspace.');
	if (result.push) reporter.print(formatPushSummary(result.push, { verbose: reporter.verbose }));
	if (result.push?.app) reporter.print(`App: ${result.push.app.url}`);
	reporter.print(formatTiming(result.timing, { label: 'Migration took' }));
	reporter.print(`Report: ${p.report}`);
	return {
		slug: result.slug,
		plan: p.plan,
		report: p.report,
		cancelled: Boolean(result.cancelled),
		push: result.push ?? null,
		timing: result.timing ?? null,
		ok: result.push ? result.push.ok : true
	};
}

async function runBatch(ctx) {
	const { config, args, reporter } = ctx;
	const { project, all } = args.values;
	const extractOpts = extractOptionsFrom({ ...args.values, workbook: '*' });
	delete extractOpts.workbook;
	delete extractOpts.project;
	const { convertOptions, pushOpts, skipPush, confirm, decide } = prepare(ctx, args.values);
	const summary = await migrateBatch({
		config,
		decide,
		project,
		all: Boolean(all),
		workbooks: args.values.workbooks,
		...extractOpts,
		options: convertOptions,
		...pushOpts,
		skipPush,
		confirm: confirm ?? undefined,
		sink: reporter.sink
	});
	const rows = summary.workbooks.map((w) => [w.name, w.project ?? '', w.status, w.plan?.datasets ?? '', w.plan?.cards ?? '', w.issues?.errors ?? '', w.error ?? '']);
	reporter.print(formatTable(['Workbook', 'Project', 'Status', 'Datasets', 'Cards', 'Errors', 'Detail'], rows));
	const shared = Object.entries(summary.sharedDatasets).filter(([, s]) => s.workbooks.length > 1);
	if (shared.length) reporter.print(`\n${shared.length} shared published datasource dataset(s): ${shared.map(([, s]) => `${s.name} (${s.workbooks.length} workbooks)`).join(', ')}`);
	reporter.print(`\nBatch summary: ${summary.report}`);
	if (summary.migrationReport) reporter.print(`Migration report: ${summary.migrationReport.markdown}${summary.migrationReport.html ? ` (HTML: ${summary.migrationReport.html})` : ''}`);
	return summary;
}
