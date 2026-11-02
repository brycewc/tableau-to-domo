import path from 'node:path';
import { requireTableau } from '../config.js';
import { SelectionError, matchNames } from '../convert/select.js';
import { createEmitter, noopSink } from '../util/events.js';
import { convertStage } from './convert.js';
import { DataDecisionError, mergeDecisions, recordAnswers } from './decisions.js';
import { extractWorkbook } from './extract.js';
import { migrateWorkbook } from './migrate.js';
import { loadMigrationReport, migrationReportFile, writeMigrationReport } from './migration-report.js';
import { pushPlan } from './push.js';
import { openWorkspace } from './workspace.js';

/** Resolve every workbook's data strategies without downloading data, then ask the open decisions at once. */
async function askUpFront({ ws, list, preExtract, config, client, sharedCache, rest, sink, emitter, deps }) {
	emitter.step(`Checking the data of ${list.length} workbook(s) for decisions before downloading any data`);
	const found = [];
	for (const wb of list) {
		try {
			const result = await preExtract({
				config,
				workbook: wb.id,
				client,
				sharedCache,
				dataStrategy: 'auto',
				includeExtract: false,
				metadata: rest.metadata,
				publishedFields: rest.publishedFields,
				domoLookup: rest.domoLookup,
				selection: rest.selection,
				unmapped: rest.unmapped,
				decisionsOnly: true,
				emitter: createEmitter(sink, 'extract'),
				deps: deps.workbook?.extract
			});
			found.push(...(result.decisions ?? []));
		} catch (err) {
			if (err instanceof SelectionError || err?.name === 'SelectionError') continue;
			emitter.warn(`Could not check the data of "${wb.name}" up front: ${err?.message ?? err}`);
		}
	}
	const decisions = mergeDecisions(found);
	if (!decisions.length) return;
	const answers = (rest.unmapped ?? 'ask') === 'ask' && rest.decide ? await rest.decide(decisions) : null;
	const recorded = answers?.length ? await recordAnswers(ws.mappingsFile, decisions, answers) : [];
	for (const r of recorded) emitter.info(`Recorded in ${ws.relative(ws.mappingsFile)}: ${JSON.stringify(r.entry)}`);
	const unanswered = decisions.filter((d) => !recorded.some((r) => r.key === d.key));
	if (unanswered.length) throw new DataDecisionError(unanswered);
}

/**
 * @typedef {Object} BatchWorkbookResult
 * @property {string} name
 * @property {string} luid
 * @property {string} [project]
 * @property {string} [slug]
 * @property {'migrated'|'dry-run'|'converted'|'cancelled'|'skipped'|'failed'} status
 * @property {string} [error]
 * @property {{ datasets: number, dataflows: number, beastModes: number, cards: number, pages: number }} [plan]
 * @property {{ errors: number, warnings: number }} [issues]
 * @property {{ ok: boolean, counts: Record<string, number> }} [push]
 * @property {string[]} [sharedDatasets]  Keys of the shared published datasource datasets the plan uses
 * @property {{ ok: boolean, counts?: Record<string, number>, error?: string }} [relink]  The pass that converted it again and
 *   pushed its layouts once the workbooks its web zones show were migrated
 * @property {number} durationMs
 *
 * @typedef {Object} BatchSummary
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {{ project?: string, all: boolean, workbooks?: string[], dryRun: boolean, skipPush: boolean, selection?: Object }} scope
 * @property {boolean} ok                      No workbook failed
 * @property {Record<string, number>} counts  By status
 * @property {BatchWorkbookResult[]} workbooks
 * @property {Record<string, { name: string, workbooks: string[] }>} sharedDatasets  Shared dataset key -> workbooks using it
 * @property {string} file                    Workspace batch-<timestamp>.json
 * @property {string} report                  Workspace batch-<timestamp>.md
 * @property {{ markdown: string, html?: string }} [migrationReport]  Stakeholder report, migration-report-<timestamp>.{md,html}
 */

function stamp(date) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function countIssues(plan) {
	const issues = plan?.issues ?? [];
	return { errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length };
}

/**
 * True when a plan's web zones show views of batch workbooks migrated after it (index above `index` in `list`): its
 * buttons to them could not be planned or pushed yet.
 */
export function linksLater(plan, list, index) {
	const later = new Set(list.slice(index + 1).map((w) => String(w.contentUrl ?? '').toLowerCase()).filter(Boolean));
	return (plan?.pages ?? []).some((pg) => (pg.webLinks ?? []).some((l) => (l.status === 'outside' || l.status === 'move') && later.has(String(l.workbook).toLowerCase())));
}

function statusOf(result, { dryRun, skipPush }) {
	if (result.cancelled) return 'cancelled';
	if (skipPush || !result.push) return 'converted';
	if (dryRun) return 'dry-run';
	return result.push.ok ? 'migrated' : 'failed';
}

/**
 * Markdown summary of a batch run.
 * @param {BatchSummary} summary
 */
export function renderBatchReport(summary) {
	const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
	const scope = summary.scope.all ? 'all workbooks on the site' : summary.scope.project ? `project "${summary.scope.project}"` : `${summary.workbooks.length} workbook(s)`;
	const counts = Object.entries(summary.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
	const out = [
		`# Batch migration: ${scope}`,
		'',
		`Started ${summary.startedAt}, finished ${summary.finishedAt ?? '(running)'}. ${summary.scope.dryRun ? 'Dry run: nothing was written to Domo. ' : ''}Result: ${counts}.`,
		'',
		'| Workbook | Project | Status | Datasets | Beast modes | Cards | Pages | Errors | Warnings | Detail |',
		'|---|---|---|---|---|---|---|---|---|---|'
	];
	for (const w of summary.workbooks) {
		const pushCounts = w.push?.counts ?? {};
		const detail = w.error ?? (w.push ? `${pushCounts.create || 0} create, ${pushCounts.register || 0} register, ${pushCounts.update || 0} update, ${pushCounts['status:failed'] || 0} failed` : '');
		out.push(
			`| ${cell(w.name)}${w.slug ? ` (\`${w.slug}\`)` : ''} | ${cell(w.project)} | ${w.status} | ${w.plan?.datasets ?? ''} | ${w.plan?.beastModes ?? ''} | ${w.plan?.cards ?? ''} | ${w.plan?.pages ?? ''} | ${w.issues?.errors ?? ''} | ${w.issues?.warnings ?? ''} | ${cell(detail)} |`
		);
	}
	const shared = Object.entries(summary.sharedDatasets).filter(([, v]) => v.workbooks.length > 1);
	if (shared.length) {
		out.push('', '## Shared published datasources', '', 'Each becomes one Domo dataset used by every workbook listed.', '', '| Dataset | Key | Workbooks |', '|---|---|---|');
		for (const [key, v] of shared) out.push(`| ${cell(v.name)} | \`${key}\` | ${cell(v.workbooks.join(', '))} |`);
	}
	out.push('', `Per-workbook details are in workbooks/<slug>/report.md.${summary.migrationReport ? ` The stakeholder report with the follow-up checklist is ${path.basename(summary.migrationReport.markdown)}.` : ''}`, '');
	return out.join('\n');
}

/**
 * Migrate many workbooks: every workbook of a project, the whole site, or a list of names/luids. Each workbook
 * runs extract, convert and push (or a dry run) with the same options and selection; a failure is recorded and
 * the batch continues. One Tableau session and one shared-datasource cache serve the whole run, so a published
 * datasource used by several workbooks is extracted once and becomes one Domo dataset. A workbook whose web zones show views
 * of workbooks migrated after it is converted again at the end and its layouts pushed, so its buttons to those views land
 * once they exist. Writes workspace/batch-<timestamp>.json after every workbook and batch-<timestamp>.md at the end.
 *
 * @param {Omit<Parameters<typeof migrateWorkbook>[0], 'workbook'|'file'|'sink'> & {
 *   project?: string,
 *   all?: boolean,
 *   workbooks?: string[],
 *   sink?: import('../util/events.js').EventSink,
 *   now?: () => Date,
 *   deps?: { client?: any, content?: { listWorkbooks: Function }, migrateWorkbook?: typeof migrateWorkbook, workbook?: Parameters<typeof migrateWorkbook>[0]['deps'], convertStage?: typeof convertStage, pushPlan?: typeof pushPlan }
 * }} opts  `workbooks` limits the batch to these names or luids (case-insensitive, * globs) within the project or site.
 *   A selection whose names a workbook does not have skips that workbook.
 * @returns {Promise<BatchSummary>}
 */
export async function migrateBatch(opts) {
	const { config, project, all = false, workbooks: names, sink = noopSink, deps = {}, dryRun = false, skipPush = false, now = () => new Date(), ...rest } = opts;
	if (!project && !all && !names?.length) throw new Error('migrateBatch needs a project, all, or a list of workbooks');
	const ws = openWorkspace(config.workspace);
	const emitter = createEmitter(sink, 'batch');
	const started = now();
	const files = { json: ws.batchFile(stamp(started), 'json'), md: ws.batchFile(stamp(started), 'md') };

	let client = deps.client;
	let signedIn = false;
	if (!client) {
		requireTableau(config);
		const { TableauClient } = await import('../tableau/client.js');
		client = new TableauClient(config.tableau, { emitter: emitter.child('tableau') });
	}
	const content = deps.content ?? (await import('../tableau/content.js'));
	const migrate = deps.migrateWorkbook ?? migrateWorkbook;

	/** @type {BatchSummary} */
	const summary = {
		startedAt: started.toISOString(),
		scope: { ...(project ? { project } : {}), all: Boolean(all), ...(names?.length ? { workbooks: names } : {}), dryRun, skipPush, ...(rest.selection ? { selection: rest.selection } : {}) },
		ok: true,
		counts: {},
		workbooks: [],
		sharedDatasets: {},
		file: files.json,
		report: files.md
	};

	try {
		if (!deps.client) {
			emitter.step(`Signing in to Tableau ${config.tableau.server}`);
			await client.signIn();
			signedIn = true;
		}
		emitter.step(`Listing workbooks${project ? ` in project "${project}"` : ' on the site'}`);
		let list = await content.listWorkbooks(client, { project });
		if (names?.length) {
			const byLuid = new Set(names.map((n) => String(n).toLowerCase()));
			const wanted = new Set(matchNames(names.filter((n) => !list.some((w) => w.id.toLowerCase() === String(n).toLowerCase())), list.map((w) => w.name), 'workbook'));
			list = list.filter((w) => byLuid.has(w.id.toLowerCase()) || wanted.has(w.name));
		}
		list.sort((a, b) => String(a.project?.name ?? '').localeCompare(String(b.project?.name ?? '')) || a.name.localeCompare(b.name));
		if (!list.length) throw new Error(`No workbooks found${project ? ` in project "${project}"` : ''}`);
		emitter.info(`${list.length} workbook(s) to migrate${dryRun ? ' (dry run)' : skipPush ? ' (extract and convert only)' : ''}`);

		const sharedCache = new Map();
		const preExtract = deps.extractWorkbook ?? (deps.migrateWorkbook ? null : extractWorkbook);
		if (preExtract && (rest.dataStrategy ?? 'auto') === 'auto' && (rest.unmapped ?? 'ask') !== 'export' && !dryRun && rest.includeExtract !== false) {
			await askUpFront({ ws, list, preExtract, config, client, sharedCache, rest, sink, emitter, deps });
		}
		const relink = [];
		for (const [i, wb] of list.entries()) {
			const t0 = Date.now();
			const base = { name: wb.name, luid: wb.id, ...(wb.project?.name ? { project: wb.project.name } : {}) };
			emitter.step(`[${i + 1}/${list.length}] ${wb.project?.name ? `${wb.project.name} / ` : ''}${wb.name}`);
			/** @type {BatchWorkbookResult} */
			let row;
			try {
				const result = await migrate({ ...rest, config, workbook: wb.id, client, sharedCache, dryRun, skipPush, sink, deps: deps.workbook });
				row = {
					...base,
					slug: result.slug,
					status: statusOf(result, { dryRun, skipPush }),
					plan: {
						datasets: result.plan?.datasets?.length ?? 0,
						dataflows: result.plan?.dataflows?.length ?? 0,
						beastModes: result.plan?.beastModes?.length ?? 0,
						cards: result.plan?.cards?.length ?? 0,
						pages: result.plan?.pages?.length ?? 0
					},
					issues: countIssues(result.plan),
					...(result.push ? { push: { ok: result.push.ok, counts: result.push.counts } } : {}),
					sharedDatasets: (result.plan?.datasets ?? []).filter((d) => d.shared && d.cardTarget).map((d) => d.key),
					durationMs: Date.now() - t0,
					...(result.timing ? { stageMs: Object.fromEntries(result.timing.steps.map((s) => [s.step, s.ms])) } : {})
				};
				for (const d of (result.plan?.datasets ?? []).filter((x) => x.shared && x.cardTarget)) {
					const entry = (summary.sharedDatasets[d.key] ??= { name: d.name, workbooks: [] });
					if (!entry.workbooks.includes(result.slug)) entry.workbooks.push(result.slug);
				}
				if (!result.cancelled && linksLater(result.plan, list, i)) relink.push(row);
			} catch (err) {
				const skipped = err instanceof SelectionError || err?.name === 'SelectionError';
				row = { ...base, status: skipped ? 'skipped' : 'failed', error: err?.message ?? String(err), durationMs: Date.now() - t0 };
				if (skipped) emitter.info(`Skipped "${wb.name}": ${row.error}`);
				else emitter.warn(`"${wb.name}" failed: ${row.error}`);
			}
			if (row.status === 'failed') summary.ok = false;
			summary.counts[row.status] = (summary.counts[row.status] || 0) + 1;
			summary.workbooks.push(row);
			await ws.writeJson(files.json, summary);
		}
		const convert = deps.convertStage ?? convertStage;
		const push = deps.pushPlan ?? pushPlan;
		for (const row of relink) {
			emitter.step(`Linking "${row.name}" to the views of workbooks migrated after it`);
			try {
				await convert({ config, slug: row.slug, options: rest.options, selection: rest.selection, full: rest.full, emitter: createEmitter(sink, 'convert') });
				if (!dryRun && !skipPush) {
					const result = await push({ config, slug: row.slug, only: 'layouts', emitter: createEmitter(sink, 'push'), deps: deps.workbook?.push });
					row.relink = { ok: result.ok, counts: result.counts };
					if (!result.ok) summary.ok = false;
				} else row.relink = { ok: true, counts: {} };
			} catch (err) {
				row.relink = { ok: false, error: err?.message ?? String(err) };
				summary.ok = false;
				emitter.warn(`Linking "${row.name}" failed: ${row.relink.error}`);
			}
			await ws.writeJson(files.json, summary);
		}
	} finally {
		if (signedIn) await client.signOut().catch(() => {});
	}
	summary.finishedAt = now().toISOString();
	try {
		const report = await loadMigrationReport(ws, { batch: summary, now });
		summary.migrationReport = await writeMigrationReport(ws, report, { file: migrationReportFile(ws, files.json), html: true });
	} catch (err) {
		emitter.warn(`Could not write the migration report: ${err?.message ?? err}`);
	}
	await ws.writeJson(files.json, summary);
	await ws.writeText(files.md, renderBatchReport(summary));
	emitter.done(`Batch finished: ${Object.entries(summary.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`, { counts: summary.counts, file: ws.relative(files.json) });
	return summary;
}
