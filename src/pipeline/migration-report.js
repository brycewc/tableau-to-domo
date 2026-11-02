import fs from 'node:fs';
import path from 'node:path';
import { instanceHost } from '../domo/client.js';
import { formatDuration } from '../util/timing.js';
import { untranslatedCalcs } from './calc-formulas.js';
import { describeIssue } from './issue-text.js';
import { latestRunLogs } from './runs.js';

/**
 * Stakeholder migration report: one summary per workbook (links, stage status, counts, data strategy, timing) and a
 * plain-language follow-up checklist, rendered as Markdown or self-contained HTML from the same model.
 *
 * @typedef {'must'|'check'|'info'} FollowUpLevel
 * @typedef {{ label: string, url?: string }} Link
 * @typedef {Object} FollowUp
 * @property {FollowUpLevel} level
 * @property {{ key: string, title: string, url?: string, order: number }} group  The whole workbook or one view
 * @property {string} text          What to do, in plain language
 * @property {Link[]} subjects      Cards, calculations or other objects concerned
 * @property {string[]} details     Original pipeline messages
 * @property {string[]} codes       Issue codes
 * @property {import('./calc-formulas.js').CalcFormula[]} [formulas]  Tableau formulas of calculations to rebuild
 *
 * @typedef {Object} DataSourceSummary
 * @property {string} name
 * @property {'existing'|'cloud-amplifier'|'federated'|'connector'|'snapshot'|'export'|'none'|'unused'} strategy
 * @property {string} label
 * @property {Link[]} datasets
 *
 * @typedef {Object} WorkbookSummary
 * @property {string} [slug]
 * @property {string} name
 * @property {string} [project]
 * @property {string} [tableauUrl]
 * @property {string} [host]
 * @property {Link} [app]
 * @property {string} status       Plain status, e.g. "Migrated"
 * @property {string} statusKey    migrated | failed | dry-run | converted | extracted | skipped | cancelled | not-started
 * @property {{ extract: string, convert: string, push: string }} stages  done | failed | not run | dry run
 * @property {string} [why]
 * @property {{ views: number, viewsPushed: number, cards: number, exact: number, approximate: number, unsupported: number, cardsPushed: number }} counts
 * @property {DataSourceSummary[]} data
 * @property {{ totalMs?: number, extract?: number, convert?: number, push?: number }} timing
 * @property {FollowUp[]} followUps  must and check items, must first
 * @property {number} notes           Informational items left out of the checklist
 * @property {string} [reportFile]  Absolute path of the workbook's own report.md
 */

const LEVEL_ORDER = { must: 0, check: 1, info: 2 };
const RANK = { 'report.failed': 0, 'report.push-failed': 0, 'report.dry-run': 0, 'report.not-pushed': 0 };
export const LEVEL_TITLE = { must: 'Must fix', check: 'Check', info: 'For information' };

const STRATEGY = {
	existing: ['existing', 'Existing Domo dataset'],
	'cloud-amplifier': ['cloud-amplifier', 'Cloud Amplifier (queries the warehouse live)'],
	federated: ['federated', 'Federated (queries the database live)'],
	connector: ['connector', 'Domo connector'],
	hyper: ['snapshot', 'One-time copy of the Tableau extract'],
	'published-extract': ['snapshot', 'One-time copy of the Tableau extract'],
	vds: ['snapshot', 'One-time copy from Tableau'],
	'view-csv': ['export', 'Export of Tableau views (aggregated, partial)'],
	none: ['none', 'No data']
};
export const STRATEGY_TITLE = {
	existing: 'Existing Domo dataset',
	'cloud-amplifier': 'Cloud Amplifier',
	federated: 'Federated',
	connector: 'Domo connector',
	snapshot: 'One-time copy',
	export: 'View export',
	none: 'No data',
	unused: 'Not used by any sheet'
};

const FEATURE_TEXT = {
	fixed: 'Ask Domo support to enable FIXED (LOD) Beast Mode functions on the instance',
	window: 'Ask Domo support to enable window functions in Beast Mode on the instance'
};

function lastAction(push, kind, key) {
	return push?.actions?.filter((a) => a.kind === kind && a.key === key).at(-1);
}

function sumRows(manifest) {
	return manifest?.tables?.reduce((n, t) => n + (t.rowCount || 0), 0);
}

function stageMs(log) {
	return log?.timing && !log.dryRun ? log.timing.ms : undefined;
}

/**
 * Pure: the summary of one workbook from its workspace files and, in a batch, its batch row.
 * @param {{
 *   slug?: string,
 *   ir?: import('../model/types.js').WorkbookIR | null,
 *   plan?: import('../model/types.js').DomoPlan | null,
 *   push?: import('./push.js').PushSummary | null,
 *   manifests?: import('../model/types.js').DataManifest[],
 *   runs?: Record<string, any>,
 *   batch?: import('./batch.js').BatchWorkbookResult
 * }} input
 * @returns {WorkbookSummary}
 */
export function summarizeWorkbook({ slug, ir, plan, push, manifests = [], runs = {}, batch } = {}) {
	const pushed = push && !push.dryRun ? push : undefined;
	const host = push?.instance ? instanceHost(push.instance) : undefined;
	const base = host ? `https://${host}` : undefined;
	const pages = [...(plan?.pages ?? [])].map((pg, i) => ({ pg, order: pg.navOrder ?? i })).sort((a, b) => a.order - b.order);
	const cards = plan?.cards ?? [];
	const domoCards = cards.filter((c) => !(c.status === 'unsupported' && c.replacedBy));
	const okId = (kind, key) => {
		const a = lastAction(pushed, kind, key);
		return a && a.status === 'ok' && a.id != null ? a.id : undefined;
	};
	const appViews = new Map((pushed?.app?.views ?? []).map((v) => [v.key, v.url]));
	const viewUrl = (pg) => appViews.get(pg.key) ?? (base && !plan?.app && okId('page', pg.key) != null ? `${base}/page/${okId('page', pg.key)}` : undefined);
	const cardUrl = (card) => (base && okId('card', card.key) != null ? `${base}/kpis/details/${okId('card', card.key)}` : undefined);

	const failedBatch = batch?.status === 'failed';
	const extractLog = runs.extract;
	const stages = {
		extract: ir ? 'done' : failedBatch || extractLog?.ok === false ? 'failed' : 'not run',
		convert: plan ? 'done' : ir && failedBatch ? 'failed' : 'not run',
		push: pushed ? (pushed.ok ? 'done' : 'failed') : push?.dryRun ? 'dry run' : plan && failedBatch ? 'failed' : 'not run'
	};
	const failedActions = (pushed?.actions ?? []).filter((a) => a.status === 'failed');
	let statusKey;
	if (batch?.status === 'skipped' || batch?.status === 'cancelled') statusKey = batch.status;
	else if (Object.values(stages).includes('failed') || batch?.relink?.ok === false) statusKey = 'failed';
	else if (stages.push === 'done') statusKey = 'migrated';
	else if (stages.push === 'dry run') statusKey = 'dry-run';
	else if (plan) statusKey = 'converted';
	else if (ir) statusKey = 'extracted';
	else statusKey = 'not-started';
	const status = {
		migrated: 'Migrated',
		failed: `Failed at ${stages.extract === 'failed' ? 'extract' : stages.convert === 'failed' ? 'convert' : 'push'}`,
		'dry-run': 'Dry run only (nothing written to Domo)',
		converted: 'Converted, not pushed',
		extracted: 'Extracted, not converted',
		skipped: 'Skipped',
		cancelled: 'Cancelled before push',
		'not-started': 'Not started'
	}[statusKey];
	const whyParts = [];
	if (batch?.error) whyParts.push(batch.error);
	if (!batch?.error && extractLog?.ok === false && extractLog.error) whyParts.push(String(extractLog.error));
	if (failedActions.length) whyParts.push(`${failedActions.length} object(s) did not reach Domo, first: ${failedActions[0].kind} "${failedActions[0].name ?? failedActions[0].key}": ${failedActions[0].error ?? 'failed'}`);
	if (batch?.relink?.ok === false) whyParts.push(`linking to later workbooks failed${batch.relink.error ? `: ${batch.relink.error}` : ''}`);

	const manifestById = new Map(manifests.map((m) => [m.datasourceId, m]));
	const datasetUrl = (ds) => {
		const id = okId('dataset', ds.key) ?? (ds.strategy === 'existing' ? ds.existing?.datasetId : undefined);
		return base && id ? `${base}/datasources/${id}/details/overview` : undefined;
	};
	const sourceIds = ir?.datasources?.length ? ir.datasources.map((d) => d.id) : [...new Set((plan?.datasets ?? []).map((d) => d.datasourceId).filter(Boolean))];
	const data = sourceIds.map((id) => {
		const irDs = ir?.datasources?.find((d) => d.id === id);
		const datasets = (plan?.datasets ?? []).filter((d) => d.datasourceId === id);
		const manifest = manifestById.get(id);
		const live = datasets.find((d) => ['existing', 'cloud-amplifier', 'federated', 'connector'].includes(d.strategy))?.strategy;
		let [strategy, label] = STRATEGY[manifest?.strategy ?? live ?? 'none'] ?? STRATEGY.none;
		const used = !ir || ir.worksheets?.some((w) => (w.datasourceIds ?? []).includes(id));
		if (!datasets.length && !manifest) [strategy, label] = used ? ['none', 'Not migrated'] : ['unused', 'Not migrated (no sheet uses it)'];
		else if (datasets.length && datasets.every((d) => d.strategy === 'upload' && !d.upload?.file)) [strategy, label] = ['none', 'No data (dataset created empty)'];
		if (manifest?.sampled) label += `, sample of ${manifest.sampled} rows per table`;
		const rows = sumRows(manifest);
		if (strategy === 'snapshot' && rows) label += `, ${rows.toLocaleString('en-US')} rows`;
		return { name: irDs?.caption ?? irDs?.name ?? manifest?.shared?.name ?? datasets[0]?.name ?? id, strategy, label, datasets: datasets.map((d) => ({ label: d.name, url: datasetUrl(d) })) };
	});

	const counts = {
		views: pages.length,
		viewsPushed: pages.filter(({ pg }) => viewUrl(pg)).length,
		cards: domoCards.length,
		exact: domoCards.filter((c) => c.status === 'ok').length,
		approximate: domoCards.filter((c) => c.status === 'approximate').length,
		unsupported: domoCards.filter((c) => c.status === 'unsupported').length,
		cardsPushed: domoCards.filter((c) => cardUrl(c)).length
	};

	const timing = { extract: stageMs(runs.extract), convert: stageMs(runs.convert), push: stageMs(runs.push ?? pushed) };
	const staged = [timing.extract, timing.convert, timing.push].filter((ms) => ms != null);
	timing.totalMs = batch?.durationMs ?? (staged.length ? staged.reduce((a, b) => a + b, 0) : undefined);

	const failure = statusKey === 'failed' && !failedActions.length ? whyParts.join('; ') || 'unknown error' : undefined;
	const { followUps, notes } = buildFollowUps({ ir, plan, push, manifests, data, pages, cards, viewUrl, cardUrl, failedActions, stages, failure });
	return {
		...(slug ? { slug } : {}),
		name: ir?.workbook?.name ?? plan?.source?.workbook ?? batch?.name ?? slug ?? 'Workbook',
		...((ir?.workbook?.projectName ?? batch?.project) ? { project: ir?.workbook?.projectName ?? batch?.project } : {}),
		...(ir?.workbook?.webpageUrl ? { tableauUrl: ir.workbook.webpageUrl } : {}),
		...(host ? { host } : {}),
		...(pushed?.app?.url ? { app: { label: pushed.app.title ?? plan?.app?.title ?? 'App', url: pushed.app.url } } : {}),
		status,
		statusKey,
		stages,
		...(whyParts.length ? { why: whyParts.join('; ') } : {}),
		counts,
		data,
		timing,
		followUps,
		notes
	};
}

function buildFollowUps({ ir, plan, push, manifests, data, pages, cards, viewUrl, cardUrl, failedActions, stages, failure }) {
	const workbookGroup = { key: 'workbook', title: 'Whole workbook', order: -1 };
	const viewGroups = new Map(pages.map(({ pg, order }) => [pg.key, { key: `view:${pg.key}`, title: pg.title, url: viewUrl(pg), order }]));
	const pagesByDashboard = new Map();
	for (const { pg } of pages) if (pg.dashboard) pagesByDashboard.set(pg.dashboard, [...(pagesByDashboard.get(pg.dashboard) ?? []), pg]);
	const cardsBySheet = new Map();
	for (const card of cards) {
		for (const sheet of card.worksheet ? [card.worksheet] : card.stack?.sheets ?? []) cardsBySheet.set(sheet, [...(cardsBySheet.get(sheet) ?? []), card]);
	}
	const cardPlaces = (card) => {
		const group = viewGroups.get((card.pageKeys ?? []).find((k) => viewGroups.has(k))) ?? workbookGroup;
		return { group, subject: { label: card.title || card.worksheet || 'card', url: cardUrl(card) } };
	};
	const locate = (object) => {
		const name = object?.name;
		if (!name) return [{ group: workbookGroup }];
		if (object.type === 'dashboard') {
			const pg = pagesByDashboard.get(name)?.[0];
			return pg ? [{ group: viewGroups.get(pg.key) }] : [{ group: workbookGroup, subject: { label: name } }];
		}
		if (object.type === 'worksheet' || object.type === 'card') {
			const found = cardsBySheet.get(name) ?? cards.filter((c) => c.title === name);
			return found.length ? found.map(cardPlaces) : [{ group: workbookGroup, subject: { label: name } }];
		}
		if (object.type === 'page') {
			const pg = pages.find(({ pg: p }) => p.title === name)?.pg;
			if (pg) return [{ group: viewGroups.get(pg.key) }];
		}
		return [{ group: workbookGroup, subject: { label: name } }];
	};

	const items = new Map();
	const add = ({ level, text, key, group, subject, detail, code, formulas = [] }) => {
		const id = `${level}|${group.key}|${key}`;
		const item = items.get(id) ?? { level, group, text, subjects: [], details: [], codes: [], rank: RANK[key] ?? (code ? 2 : 1) };
		items.set(id, item);
		if (subject && !item.subjects.some((s) => s.label === subject.label)) item.subjects.push(subject);
		if (detail && !item.details.includes(detail)) item.details.push(detail);
		if (code && !item.codes.includes(code)) item.codes.push(code);
		for (const f of formulas) {
			item.formulas ??= [];
			if (!item.formulas.some((x) => x.key === f.key)) item.formulas.push(f);
		}
	};
	const issues = [...(ir?.issues ?? []), ...manifests.flatMap((m) => m.issues ?? []), ...(plan?.issues ?? []), ...(push?.issues ?? [])];
	const calcs = untranslatedCalcs({ ir, plan, issues });
	const calcsOf = (object) => (object?.name ? calcs.filter((c) => c.name === object.name && (!object.id || object.id === c.fieldId)) : []);
	for (const issue of issues) {
		const { level, text, known } = describeIssue(issue);
		const message = String(issue.message ?? '').trim();
		const formulas = level === 'must' ? calcsOf(issue.object) : [];
		const detail = formulas.length ? undefined : known ? [message && !/[.!?)]$/.test(message) ? `${message}.` : message, issue.suggestion].filter(Boolean).join(' ') : issue.suggestion;
		for (const place of locate(issue.object)) add({ level, text, key: known ? issue.code : `${issue.code}|${issue.message}`, ...place, detail, code: issue.code, formulas });
	}

	const mustNames = new Set([...items.values()].filter((i) => i.level === 'must').flatMap((i) => i.subjects.map((s) => s.label)));
	const sameName = (c) => calcs.filter((x) => x.name === c.name).length > 1;
	for (const calc of calcs.filter((c) => !mustNames.has(c.name))) {
		const label = sameName(calc) && calc.datasource ? `${calc.name} (${calc.datasource})` : calc.name;
		add({ level: 'must', text: describeIssue({ code: 'calc.unsupported' }).text, key: 'calc.unsupported', group: workbookGroup, subject: { label }, code: 'calc.unsupported', formulas: [calc] });
	}
	for (const card of cards.filter((c) => c.status === 'unsupported' && !c.replacedBy && !mustNames.has(c.title))) {
		add({ level: 'must', text: 'Recreate these cards by hand; they did not convert', key: 'report.card-unsupported', ...cardPlaces(card) });
	}
	const wb = (level, key, text, extra = {}) => add({ level, key, text, group: workbookGroup, ...extra });
	if (failure) wb('must', 'report.failed', 'The migration did not finish; fix the cause and run `t2d migrate` again', { detail: failure });
	if (failedActions.length) {
		for (const a of failedActions) wb('must', 'report.push-failed', 'These objects did not reach Domo; fix the errors and run `t2d push` again (it resumes from the saved state)', { subject: { label: `${a.kind} "${a.name ?? a.key}"` }, detail: a.error });
	}
	if (stages.push === 'dry run') wb('must', 'report.dry-run', 'Only a dry run was done; run `t2d push` without --dry-run to create the app in Domo');
	else if (stages.push === 'not run' && plan) wb('must', 'report.not-pushed', 'Not pushed to Domo yet; run `t2d push`');
	const snapshot = data.filter((d) => d.strategy === 'snapshot' || d.strategy === 'export');
	if (snapshot.length) {
		for (const d of snapshot) wb('must', 'report.snapshot', 'The data is a one-time copy and will not refresh; replace it with a connector or Cloud Amplifier, or rerun the migration on a schedule', { subject: { label: d.name } });
	}
	const notPushed = (b) => !push || push.dryRun || lastAction(push, 'beastmode', b.key)?.status === 'failed';
	const features = new Set((plan?.beastModes ?? []).filter((b) => b.status !== 'unsupported' && notPushed(b)).flatMap((b) => b.features ?? []));
	for (const f of features) if (FEATURE_TEXT[f]) wb('check', `report.feature-${f}`, FEATURE_TEXT[f]);
	for (const d of data.filter((x) => x.strategy === 'connector')) wb('check', 'report.connector', 'Set a refresh schedule for the connector datasets in the Domo Data Center', { subject: { label: d.name } });
	for (const d of data.filter((x) => x.strategy === 'cloud-amplifier')) wb('check', 'report.cloud-amplifier', 'Cards query the warehouse live; check that the warehouse and its credentials suit the expected traffic', { subject: { label: d.name } });
	if (pages.length) {
		wb('check', 'report.share', 'Share the app with the right users and groups, and set PDP policies on the datasets if Tableau used row-level security or user filters');
		wb('check', 'report.compare', 'Compare each view side by side with Tableau: layout, chart types, colors, sorting and a few key totals');
	}

	const all = [...items.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.group.order - b.group.order || a.rank - b.rank || a.text.localeCompare(b.text));
	return { followUps: all.filter((i) => i.level !== 'info').map(({ rank: _rank, ...i }) => i), notes: all.filter((i) => i.level === 'info').length };
}

/**
 * @param {{ workbooks: WorkbookSummary[], scope?: string, generatedAt?: string }} input
 */
export function buildMigrationReport({ workbooks, scope = '', generatedAt = new Date().toISOString() }) {
	const by = (fn) => workbooks.reduce((n, w) => n + fn(w), 0);
	const statuses = {};
	for (const w of workbooks) statuses[w.statusKey] = (statuses[w.statusKey] || 0) + 1;
	const strategies = {};
	for (const d of workbooks.flatMap((w) => w.data)) strategies[d.strategy] = (strategies[d.strategy] || 0) + 1;
	return {
		generatedAt,
		scope,
		hosts: [...new Set(workbooks.map((w) => w.host).filter(Boolean))],
		workbooks,
		totals: {
			workbooks: workbooks.length,
			statuses,
			views: by((w) => w.counts.views),
			viewsPushed: by((w) => w.counts.viewsPushed),
			cards: by((w) => w.counts.cards),
			exact: by((w) => w.counts.exact),
			approximate: by((w) => w.counts.approximate),
			unsupported: by((w) => w.counts.unsupported),
			cardsPushed: by((w) => w.counts.cardsPushed),
			strategies,
			must: by((w) => w.followUps.filter((f) => f.level === 'must').length),
			check: by((w) => w.followUps.filter((f) => f.level === 'check').length),
			notes: by((w) => w.notes),
			ms: by((w) => w.timing.totalMs ?? 0)
		}
	};
}

/**
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} slug
 * @param {import('./batch.js').BatchWorkbookResult} [batch]
 */
export async function loadWorkbookSummary(ws, slug, batch) {
	const p = ws.paths(slug);
	const read = (file) => ws.readJson(file, null).catch(() => null);
	const push = (await read(p.pushLog)) ?? (await read(p.pushDryRun));
	const summary = summarizeWorkbook({
		slug,
		ir: await read(p.ir),
		plan: await read(p.plan),
		push,
		manifests: await ws.readManifests(slug).catch(() => []),
		runs: await latestRunLogs(ws, slug).catch(() => ({})),
		batch
	});
	return fs.existsSync(p.report) ? { ...summary, reportFile: p.report } : summary;
}

/**
 * Report over a batch summary, a list of workspace slugs or names, or every workbook in the workspace.
 * @param {import('./workspace.js').Workspace} ws
 * @param {{ batch?: import('./batch.js').BatchSummary, workbooks?: string[], all?: boolean, now?: () => Date }} opts
 */
export async function loadMigrationReport(ws, { batch, workbooks, all, now = () => new Date() } = {}) {
	const summaries = [];
	let scope;
	if (batch) {
		for (const row of batch.workbooks ?? []) {
			summaries.push(row.slug && fs.existsSync(ws.workbookDir(row.slug)) ? await loadWorkbookSummary(ws, row.slug, row) : summarizeWorkbook({ batch: row }));
		}
		const where = batch.scope?.all ? 'every workbook on the site' : batch.scope?.project ? `project "${batch.scope.project}"` : `${summaries.length} workbook(s)`;
		scope = `Batch run of ${where}, started ${batch.startedAt}${batch.scope?.dryRun ? ' (dry run)' : ''}`;
	} else {
		const slugs = all ? (await ws.listWorkbooks()).map((w) => w.slug) : [];
		for (const name of workbooks ?? []) slugs.push(await ws.resolveSlug(name));
		if (!slugs.length) throw new Error(all ? `No workbooks in ${ws.workbooksDir}` : 'No workbooks to report on');
		for (const slug of [...new Set(slugs)]) summaries.push(await loadWorkbookSummary(ws, slug));
		scope = all ? 'All workbooks in the workspace' : `${summaries.length} workbook(s)`;
	}
	return buildMigrationReport({ workbooks: summaries, scope, generatedAt: now().toISOString() });
}

/**
 * Default report file: workspace/migration-report.md, or migration-report-<timestamp>.md for batch-<timestamp>.json.
 * @param {import('./workspace.js').Workspace} ws
 * @param {string} [batchFile]
 */
export function migrationReportFile(ws, batchFile) {
	const stamp = batchFile ? path.basename(batchFile).match(/^batch-(.+)\.json$/)?.[1] : undefined;
	return path.join(ws.root, stamp ? `migration-report-${stamp}.md` : 'migration-report.md');
}

/**
 * Write the Markdown report and, with `html`, the HTML next to it (same name, .html).
 * @param {ReturnType<typeof buildMigrationReport>} report
 * @param {{ file: string, html?: boolean }} opts
 * @returns {Promise<{ markdown: string, html?: string }>}
 */
export async function writeMigrationReport(ws, report, { file, html = false }) {
	const markdown = `${file.replace(/\.(md|html?)$/i, '')}.md`;
	const baseDir = path.dirname(markdown);
	await ws.writeText(markdown, renderMigrationMarkdown(report, { baseDir }));
	if (!html) return { markdown };
	const htmlFile = path.join(baseDir, `${path.basename(markdown, '.md')}.html`);
	await ws.writeText(htmlFile, renderMigrationHtml(report, { baseDir }));
	return { markdown, html: htmlFile };
}

/* Markdown */

function md(value) {
	return String(value ?? '')
		.replace(/\r?\n/g, ' ')
		.replace(/([\\`*_[\]<>|])/g, '\\$1');
}

function mdLink(link) {
	return link.url ? `[${md(link.label)}](${link.url})` : md(link.label);
}

function mdTable(headers, rows) {
	if (!rows.length) return '_None._\n';
	return `${[`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')}\n`;
}

/** Plain text with `code` spans kept as code, for checklist text. */
function mdText(text) {
	return String(text)
		.split(/(`[^`]+`)/)
		.map((part, i) => (i % 2 ? part : md(part)))
		.join('');
}

// The fence must be longer than any backtick run in the text, or the text would close it.
function mdCodeBlock(text, indent) {
	const value = String(text ?? '').replace(/\r\n?/g, '\n');
	const fence = '`'.repeat(Math.max(3, ...(value.match(/`+/g) ?? []).map((run) => run.length + 1)));
	return [`${indent}${fence}`, ...value.split('\n').map((line) => (line ? `${indent}${line}` : '')), `${indent}${fence}`];
}

function calcTitle(f) {
	return `**${md(f.name)}**${f.datasource ? ` (datasource ${md(f.datasource)})` : ''}`;
}

function mdFormula(f, indent, listed) {
	const out = [`${indent}- ${calcTitle(f)}: ${md(f.reasons.join(' '))} Tableau formula:`,...mdCodeBlock(f.formula, `${indent}  `)];
	for (const ref of f.references) {
		if (listed.has(ref.key)) out.push(`${indent}  - Uses **${md(ref.name)}**, which did not convert either; its formula is listed in this item.`);
		else out.push(`${indent}  - Uses **${md(ref.name)}**, which did not convert either:`, ...mdCodeBlock(ref.formula, `${indent}    `));
	}
	return out;
}

function cardsText(c, unit = '') {
	if (!c.cards) return `0${unit}`;
	const parts = [c.exact && `${c.exact} exact`, c.approximate && `${c.approximate} approximate`, c.unsupported && `${c.unsupported} not converted`].filter(Boolean);
	return `${c.cards}${unit}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const STAGE_TEXT = { done: 'Yes', failed: 'Failed', 'not run': 'No', 'dry run': 'Dry run' };

function timingText(t) {
	if (t.totalMs == null) return '';
	const parts = [['extract', t.extract], ['convert', t.convert], ['push', t.push]].filter(([, ms]) => ms != null).map(([s, ms]) => `${s} ${formatDuration(ms)}`);
	return `${formatDuration(t.totalMs)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const DETAILS_SHOWN = 3;

function workbookReportLink(wb, baseDir) {
	if (!wb.reportFile) return { label: 'the workbook report' };
	const rel = baseDir ? path.relative(baseDir, wb.reportFile) : wb.reportFile;
	return { label: 'the workbook report', url: rel.split(path.sep).map(encodeURIComponent).join('/') };
}

/**
 * Checklist lines for one workbook: must-fix items first, each level grouped by the whole workbook and then each view.
 * @param {WorkbookSummary} wb
 */
export function renderFollowUpsMarkdown(wb, { details = DETAILS_SHOWN, baseDir } = {}) {
	if (!wb.followUps.length) return ['_Nothing to follow up._', ''];
	const out = [];
	for (const level of ['must', 'check']) {
		const items = wb.followUps.filter((f) => f.level === level);
		if (!items.length) continue;
		out.push(`**${LEVEL_TITLE[level]}** (${items.length})`, '');
		const groups = [...new Map(items.map((i) => [i.group.key, i.group])).values()];
		for (const group of groups) {
			out.push(`- ${group.key === 'workbook' ? group.title : `View ${mdLink({ label: group.title, url: group.url })}`}`);
			for (const item of items.filter((i) => i.group.key === group.key)) {
				const subjects = item.subjects.length ? `: ${item.subjects.map(mdLink).join(', ')}` : '';
				out.push(`  - [ ] ${mdText(item.text)}${subjects}`);
				for (const d of item.details.slice(0, details)) out.push(`    - ${md(d)}`);
				if (item.details.length > details) out.push(`    - and ${item.details.length - details} more`);
				const listed = new Set((item.formulas ?? []).map((f) => f.key));
				for (const f of item.formulas ?? []) out.push(...mdFormula(f, '    ', listed));
			}
		}
		out.push('');
	}
	if (wb.notes) out.push(`${wb.notes} informational note(s) need no action; they are listed in ${mdLink(workbookReportLink(wb, baseDir))}.`, '');
	return out;
}

/**
 * Summary bullets of one workbook, for the top of report.md.
 * @param {WorkbookSummary} wb
 */
export function renderSummaryMarkdown(wb) {
	const out = [];
	out.push(`- Tableau: ${wb.tableauUrl ? mdLink({ label: wb.name, url: wb.tableauUrl }) : md(wb.name)}${wb.project ? ` (project ${md(wb.project)})` : ''}`);
	out.push(`- Domo app: ${wb.app ? mdLink(wb.app) : 'not pushed yet'}`);
	out.push(`- Status: **${md(wb.status)}**. Extracted: ${STAGE_TEXT[wb.stages.extract]}, converted: ${STAGE_TEXT[wb.stages.convert]}, pushed: ${STAGE_TEXT[wb.stages.push]}.`);
	if (wb.why) out.push(`- Why: ${md(wb.why)}`);
	out.push(`- Converted: ${wb.counts.views} view(s) and ${cardsText(wb.counts, ' card(s)')}${wb.counts.cardsPushed ? `; ${wb.counts.cardsPushed} card(s) in Domo` : ''}`);
	if (wb.data.length) {
		out.push('- Data:');
		for (const d of wb.data) out.push(`  - ${md(d.name)}: ${md(d.label)}${d.datasets.length ? ` (${d.datasets.map(mdLink).join(', ')})` : ''}`);
	}
	const must = wb.followUps.filter((f) => f.level === 'must').length;
	out.push(`- Follow-up: ${must} must fix, ${wb.followUps.length - must} to check`);
	if (wb.timing.totalMs != null) out.push(`- Time: ${timingText(wb.timing)}`);
	return [...out, ''];
}

function overviewText(report) {
	const t = report.totals;
	const statuses = Object.entries(t.statuses).map(([k, v]) => `${v} ${k.replace('-', ' ')}`).join(', ');
	return `${t.workbooks} workbook(s): ${statuses || 'none'}. ${t.views} view(s) and ${t.cards} card(s) converted. ${t.must} item(s) must be fixed and ${t.check} should be checked.`;
}

/** @param {ReturnType<typeof buildMigrationReport>} report */
export function renderMigrationMarkdown(report, { baseDir } = {}) {
	const out = ['# Tableau to Domo migration report', ''];
	out.push(`Generated ${report.generatedAt}. ${md(report.scope)}.${report.hosts.length ? ` Domo: ${report.hosts.map((h) => `https://${h}`).join(', ')}.` : ''}`, '');
	out.push(`**${overviewText(report)}**`, '');

	out.push('## Workbooks', '');
	out.push(
		mdTable(
			['Workbook', 'Domo app', 'Status', 'Extracted', 'Converted', 'Pushed', 'Views', 'Cards', 'Must fix', 'Check', 'Time'],
			report.workbooks.map((w) => [
				w.tableauUrl ? mdLink({ label: w.name, url: w.tableauUrl }) : md(w.name),
				w.app ? mdLink({ label: 'Open app', url: w.app.url }) : '',
				`${md(w.status)}${w.why ? `: ${md(w.why)}` : ''}`,
				STAGE_TEXT[w.stages.extract],
				STAGE_TEXT[w.stages.convert],
				STAGE_TEXT[w.stages.push],
				String(w.counts.views),
				cardsText(w.counts),
				String(w.followUps.filter((f) => f.level === 'must').length),
				String(w.followUps.filter((f) => f.level === 'check').length),
				w.timing.totalMs != null ? formatDuration(w.timing.totalMs) : ''
			])
		)
	);

	out.push('## Data', '');
	out.push(
		mdTable(
			['Workbook', 'Tableau datasource', 'How the data reaches Domo', 'Domo datasets'],
			report.workbooks.flatMap((w) => w.data.map((d) => [md(w.name), md(d.name), md(d.label), d.datasets.map(mdLink).join(', ')]))
		)
	);

	out.push('## Manual follow-up', '');
	out.push('Workbooks with the most must-fix items come first. Within each workbook, fix the must-fix items before checking the rest.', '');
	for (const w of rankWorkbooks(report.workbooks)) {
		const links = [w.tableauUrl && mdLink({ label: 'Tableau', url: w.tableauUrl }), w.app && mdLink({ label: 'Domo app', url: w.app.url })].filter(Boolean);
		out.push(`### ${md(w.name)}${links.length ? ` (${links.join(', ')})` : ''}`, '');
		out.push(...renderFollowUpsMarkdown(w, { baseDir }));
	}

	out.push('## Totals', '');
	out.push(mdTable(['Item', 'Count'], totalsRows(report.totals)));
	return out.join('\n');
}

function rankWorkbooks(workbooks) {
	const must = (w) => w.followUps.filter((f) => f.level === 'must').length;
	return [...workbooks].sort((a, b) => must(b) - must(a) || a.name.localeCompare(b.name));
}

function totalsRows(t) {
	const rows = [['Workbooks', String(t.workbooks)]];
	for (const [k, v] of Object.entries(t.statuses)) rows.push([`Workbooks ${k.replace('-', ' ')}`, String(v)]);
	rows.push(['Views converted', String(t.views)], ['Views in Domo', String(t.viewsPushed)]);
	rows.push(['Cards converted', cardsText(t)], ['Cards in Domo', String(t.cardsPushed)]);
	for (const [k, v] of Object.entries(t.strategies)) rows.push([`Datasources: ${STRATEGY_TITLE[k] ?? k}`, String(v)]);
	rows.push(['Follow-up: must fix', String(t.must)], ['Follow-up: check', String(t.check)], ['Informational notes', String(t.notes)]);
	if (t.ms) rows.push(['Total time', formatDuration(t.ms)]);
	return rows;
}

/* HTML */

function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function a(link) {
	return link.url ? `<a href="${esc(link.url)}" target="_blank" rel="noopener">${esc(link.label)}</a>` : esc(link.label);
}

function htmlText(text) {
	return String(text)
		.split(/(`[^`]+`)/)
		.map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part)))
		.join('');
}

function htmlTable(headers, rows) {
	if (!rows.length) return '<p class="muted">None.</p>';
	return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const CSS = `
:root { --fg: #1f2933; --muted: #616e7c; --line: #d9dee3; --bg: #ffffff; --soft: #f5f7f9; --link: #1d5fbf; --must: #b42318; --must-bg: #fde8e7; --check: #8a5a00; --check-bg: #fff4d6; --ok: #1b7a43; --ok-bg: #e3f5ea; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
h3 { font-size: 16px; margin: 24px 0 8px; }
h4 { font-size: 13px; margin: 16px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
a { color: var(--link); }
.muted { color: var(--muted); }
.overview { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; font-weight: 600; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 600; white-space: nowrap; }
.badge { display: inline-block; padding: 0 8px; border-radius: 10px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.must { color: var(--must); background: var(--must-bg); }
.check { color: var(--check); background: var(--check-bg); }
.ok { color: var(--ok); background: var(--ok-bg); }
ul.items { list-style: none; padding-left: 0; margin: 4px 0 8px; }
ul.items li { padding: 4px 0 4px 28px; position: relative; }
ul.items li input { position: absolute; left: 4px; top: 7px; }
.group { font-weight: 600; margin-top: 8px; }
details { margin-top: 2px; color: var(--muted); }
details ul { margin: 4px 0; padding-left: 18px; }
code { background: var(--soft); padding: 0 4px; border-radius: 3px; }
.formula { margin: 8px 0; color: var(--fg); }
pre { background: var(--soft); border: 1px solid var(--line); border-radius: 4px; padding: 8px; margin: 4px 0; overflow-x: auto; white-space: pre; }
pre code { padding: 0; background: none; }
`;

function statusBadge(w) {
	const cls = w.statusKey === 'migrated' ? 'ok' : w.statusKey === 'failed' ? 'must' : 'check';
	return `<span class="badge ${cls}">${esc(w.status)}</span>`;
}

function htmlFormulas(formulas) {
	const listed = new Set(formulas.map((f) => f.key));
	const pre = (text) => `<pre><code>${esc(text)}</code></pre>`;
	return formulas
		.map((f) => {
			const refs = f.references.map((r) => {
				const uses = `Uses <strong>${esc(r.name)}</strong>, which did not convert either`;
				return listed.has(r.key) ? `<div>${uses}; its formula is listed in this item.</div>` : `<div>${uses}:</div>${pre(r.formula)}`;
			});
			return `<div class="formula"><div><strong>${esc(f.name)}</strong>${f.datasource ? ` (datasource ${esc(f.datasource)})` : ''}: ${esc(f.reasons.join(' '))} Tableau formula:</div>${pre(f.formula)}${refs.join('')}</div>`;
		})
		.join('');
}

function htmlFollowUps(w, baseDir) {
	if (!w.followUps.length) return '<p class="muted">Nothing to follow up.</p>';
	const out = [];
	for (const level of ['must', 'check']) {
		const items = w.followUps.filter((f) => f.level === level);
		if (!items.length) continue;
		out.push(`<h4><span class="badge ${level}">${LEVEL_TITLE[level]}</span> ${items.length}</h4>`);
		const groups = [...new Map(items.map((i) => [i.group.key, i.group])).values()];
		for (const group of groups) {
			out.push(`<div class="group">${group.key === 'workbook' ? esc(group.title) : `View ${a({ label: group.title, url: group.url })}`}</div><ul class="items">`);
			for (const item of items.filter((i) => i.group.key === group.key)) {
				const subjects = item.subjects.length ? `: ${item.subjects.map(a).join(', ')}` : '';
				const formulas = htmlFormulas(item.formulas ?? []);
				const more = item.details.length || item.codes.length || formulas ? `<details><summary>${formulas ? 'Details and Tableau formulas' : 'Details'}</summary><ul>${item.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>${formulas}${item.codes.length ? `<div>Codes: ${item.codes.map((c) => `<code>${esc(c)}</code>`).join(' ')}</div>` : ''}</details>` : '';
				out.push(`<li><input type="checkbox" aria-label="done"> ${htmlText(item.text)}${subjects}${more}</li>`);
			}
			out.push('</ul>');
		}
	}
	if (w.notes) out.push(`<p class="muted">${w.notes} informational note(s) need no action; they are listed in ${a(workbookReportLink(w, baseDir))}.</p>`);
	return out.join('\n');
}

/** Self-contained HTML (inline styles, no external assets). @param {ReturnType<typeof buildMigrationReport>} report */
export function renderMigrationHtml(report, { baseDir } = {}) {
	const body = [];
	body.push('<h1>Tableau to Domo migration report</h1>');
	body.push(`<p class="muted">Generated ${esc(report.generatedAt)}. ${esc(report.scope)}.${report.hosts.length ? ` Domo: ${report.hosts.map((h) => a({ label: `https://${h}`, url: `https://${h}` })).join(', ')}.` : ''}</p>`);
	body.push(`<p class="overview">${esc(overviewText(report))}</p>`);

	body.push('<h2>Workbooks</h2><div class="scroll">');
	body.push(
		htmlTable(
			['Workbook', 'Domo app', 'Status', 'Extracted', 'Converted', 'Pushed', 'Views', 'Cards', 'Must fix', 'Check', 'Time'],
			report.workbooks.map((w) => {
				const must = w.followUps.filter((f) => f.level === 'must').length;
				return [
					`${w.tableauUrl ? a({ label: w.name, url: w.tableauUrl }) : esc(w.name)}${w.project ? `<div class="muted">${esc(w.project)}</div>` : ''}`,
					w.app ? a({ label: 'Open app', url: w.app.url }) : '<span class="muted">none</span>',
					`${statusBadge(w)}${w.why ? `<div class="muted">${esc(w.why)}</div>` : ''}`,
					esc(STAGE_TEXT[w.stages.extract]),
					esc(STAGE_TEXT[w.stages.convert]),
					esc(STAGE_TEXT[w.stages.push]),
					String(w.counts.views),
					esc(cardsText(w.counts)),
					must ? `<span class="badge must">${must}</span>` : '0',
					String(w.followUps.length - must),
					w.timing.totalMs != null ? esc(formatDuration(w.timing.totalMs)) : ''
				];
			})
		)
	);
	body.push('</div><h2>Data</h2><div class="scroll">');
	body.push(
		htmlTable(
			['Workbook', 'Tableau datasource', 'How the data reaches Domo', 'Domo datasets'],
			report.workbooks.flatMap((w) => w.data.map((d) => [esc(w.name), esc(d.name), esc(d.label), d.datasets.map(a).join('<br>')]))
		)
	);
	body.push('</div><h2>Manual follow-up</h2>');
	body.push('<p class="muted">Workbooks with the most must-fix items come first. Within each workbook, fix the must-fix items before checking the rest. The checkboxes are not saved.</p>');
	for (const w of rankWorkbooks(report.workbooks)) {
		const links = [w.tableauUrl && a({ label: 'Tableau', url: w.tableauUrl }), w.app && a({ label: 'Domo app', url: w.app.url })].filter(Boolean);
		body.push(`<h3>${esc(w.name)}${links.length ? ` <span class="muted">(${links.join(', ')})</span>` : ''}</h3>`);
		body.push(htmlFollowUps(w, baseDir));
	}
	body.push('<h2>Totals</h2>');
	body.push(htmlTable(['Item', 'Count'], totalsRows(report.totals).map(([k, v]) => [esc(k), esc(v)])));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migration report</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body.join('\n')}
</main>
</body>
</html>
`;
}
