import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildMigrationReport, loadMigrationReport, loadWorkbookSummary, migrationReportFile, renderMigrationHtml, writeMigrationReport } from '../../pipeline/migration-report.js';
import { renderReport } from '../../pipeline/report.js';
import { latestRunLogs } from '../../pipeline/runs.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { UsageError, requireWorkbookArg } from '../shared.js';

export const name = 'report';
export const summary = 'Re-render report.md, or write a migration report across several workbooks';
export const usage = 't2d report (--workbook <slug> | --workbooks <a,b> | --all | --batch <file|latest>) [--html] [--out <file>] [--open]';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'One workbook: re-render its report.md' },
	workbooks: { type: 'string', multiple: true, value: '<names>', description: 'Migration report over these workspace workbooks (slugs or names; comma list or repeat)' },
	all: { type: 'boolean', description: 'Migration report over every workbook in the workspace' },
	batch: { type: 'string', value: '<file|latest>', description: 'Migration report over a batch run (its batch-<timestamp>.json, or latest)' },
	html: { type: 'boolean', description: 'Also write a self-contained HTML file next to the Markdown' },
	out: { type: 'string', value: '<file>', description: 'Migration report file (default workspace/migration-report.md, or migration-report-<timestamp>.md for a batch)' },
	open: { type: 'boolean', description: 'Open the report (the HTML with --html) with the system viewer instead of printing it' }
};

function openFile(file) {
	const [cmd, args] =
		process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
	const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
	child.on('error', () => {});
	child.unref();
}

function latestBatch(ws) {
	const files = fs.existsSync(ws.root) ? fs.readdirSync(ws.root).filter((f) => /^batch-.+\.json$/.test(f)).sort() : [];
	if (!files.length) throw new Error(`No batch-<timestamp>.json in ${ws.root}: run t2d migrate --project, --all or --workbooks first`);
	return path.join(ws.root, files.at(-1));
}

/** @param {import('../main.js').CommandContext} ctx */
export async function run(ctx) {
	const v = ctx.args.values;
	const many = Boolean(v.all) || Boolean(v.workbooks?.length) || Boolean(v.batch);
	if (many && v.workbook) throw new UsageError('--workbook cannot be combined with --workbooks, --all or --batch');
	return many ? runMany(ctx) : runOne(ctx);
}

async function runOne({ config, args, reporter }) {
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	const p = ws.paths(slug);
	const ir = await ws.readJson(p.ir, null);
	const plan = await ws.readJson(p.plan, null);
	if (!ir && !plan) throw new Error(`Nothing to report for "${slug}": run extract and convert first`);
	const push = (await ws.readJson(p.pushLog, null)) ?? (await ws.readJson(p.pushDryRun, null)) ?? undefined;
	const manifests = await ws.readManifests(slug);
	const runs = await latestRunLogs(ws, slug);
	const markdown = renderReport({ ir, plan, push, manifests, runs: { ...runs, ...(push ? { push } : {}) } });
	await ws.writeText(p.report, markdown);
	let html;
	if (args.values.html) {
		html = path.join(p.dir, 'report.html');
		await ws.writeText(html, renderMigrationHtml(buildMigrationReport({ workbooks: [await loadWorkbookSummary(ws, slug)], scope: '1 workbook' }), { baseDir: p.dir }));
	}
	const shown = html ?? p.report;
	if (args.values.open && fs.existsSync(shown)) {
		openFile(shown);
		reporter.print(`Opened ${shown}`);
	} else {
		reporter.print(markdown);
		if (html) reporter.print(`HTML: ${html}`);
	}
	return { slug, report: p.report, ...(html ? { html } : {}) };
}

async function runMany({ config, args, reporter }) {
	const v = args.values;
	const ws = openWorkspace(config.workspace);
	let batch;
	let batchFile;
	if (v.batch) {
		batchFile = v.batch === 'latest' ? latestBatch(ws) : path.resolve(v.batch);
		batch = await ws.readJson(batchFile);
		if (!Array.isArray(batch?.workbooks)) throw new Error(`${batchFile} is not a batch summary`);
	}
	const workbooks = (v.workbooks ?? []).flatMap((w) => String(w).split(',')).map((w) => w.trim()).filter(Boolean);
	const report = await loadMigrationReport(ws, { batch, workbooks: batch ? undefined : workbooks, all: !batch && Boolean(v.all) });
	const file = v.out ? path.resolve(v.out) : migrationReportFile(ws, batchFile);
	const written = await writeMigrationReport(ws, report, { file, html: Boolean(v.html) });
	const t = report.totals;
	reporter.print(`${t.workbooks} workbook(s), ${t.views} view(s), ${t.cards} card(s); follow-up: ${t.must} must fix, ${t.check} to check`);
	reporter.print(`Report: ${written.markdown}`);
	if (written.html) reporter.print(`HTML: ${written.html}`);
	if (v.open) openFile(written.html ?? written.markdown);
	return { ...written, totals: t };
}
