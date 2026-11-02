import { formatBytes, formatDuration } from '../util/timing.js';
import { renderFollowUpsMarkdown, renderSummaryMarkdown, summarizeWorkbook } from './migration-report.js';

const SEVERITY_ORDER = ['error', 'warning', 'info'];
const SEVERITY_TITLE = { error: 'Errors (did not convert)', warning: 'Warnings (converted approximately)', info: 'Info' };
const REPLACED = { header: 'app header', notebook: 'text card', stack: 'merged table' };

function cell(value) {
	if (value === undefined || value === null || value === '') return '';
	return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function code(value) {
	if (value === undefined || value === null || value === '') return '';
	const text = String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
	const longest = (text.match(/`+/g) ?? []).reduce((max, m) => Math.max(max, m.length), 0);
	const fence = '`'.repeat(longest + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

function table(headers, rows) {
	if (!rows.length) return '_None._\n';
	const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
	for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
	return `${lines.join('\n')}\n`;
}

function count(items, pred) {
	return (items ?? []).filter(pred).length;
}

function actionFor(push, kind, key) {
	return push?.actions?.filter((a) => a.kind === kind && a.key === key).at(-1);
}

function pushCell(action) {
	if (!action) return '';
	const id = action.id != null && action.status !== 'dry-run' ? ` (${action.id})` : '';
	const text = `${action.action}: ${action.status}${id}`;
	return cell(action.error ? `${text}: ${action.error}` : text);
}

/**
 * Markdown migration report.
 * @param {{
 *   ir?: import('../model/types.js').WorkbookIR,
 *   plan?: import('../model/types.js').DomoPlan,
 *   push?: import('./push.js').PushSummary,
 *   manifests?: import('../model/types.js').DataManifest[],
 *   runs?: Record<string, any>
 * }} input  `runs`: the latest log per stage (extract, convert, push, unpush; `latestRunLogs`) for the Timing section
 * @returns {string}
 */
export function renderReport({ ir, plan, push, manifests = [], runs = {} } = {}) {
	const out = [];
	const name = ir?.workbook?.name ?? plan?.source?.workbook ?? 'Workbook';
	const datasets = plan?.datasets ?? [];
	const beastModes = plan?.beastModes ?? [];
	const cards = plan?.cards ?? [];
	const pages = plan?.pages ?? [];
	const variables = plan?.variables ?? [];
	const dataflows = plan?.dataflows ?? [];
	const manifestById = new Map(manifests.map((m) => [m.datasourceId, m]));

	out.push(`# Migration report: ${name}`, '');
	const summary = summarizeWorkbook({ ir, plan, push, manifests, runs });
	out.push('## Summary', '', ...renderSummaryMarkdown(summary));
	out.push('## Manual follow-up', '', ...renderFollowUpsMarkdown(summary, { details: Infinity }));
	out.push('_The sections below list every object and issue in detail, with issue codes, for the migration lead._', '');
	const meta = [];
	if (ir?.workbook?.projectName) meta.push(`- Tableau project: ${ir.workbook.projectName}`);
	if (ir?.workbook?.luid) meta.push(`- Tableau workbook id: ${ir.workbook.luid}`);
	if (ir?.workbook?.webpageUrl) meta.push(`- Tableau URL: ${ir.workbook.webpageUrl}`);
	if (ir?.workbook?.tableauVersion) meta.push(`- Tableau version: ${ir.workbook.tableauVersion}`);
	if (plan?.generatedAt) meta.push(`- Plan generated: ${plan.generatedAt}`);
	if (push) meta.push(`- ${push.dryRun ? 'Dry run' : 'Push'} to ${push.instance}: ${push.finishedAt ?? push.startedAt}${push.ok ? '' : ' (with failures)'}`);
	const sel = plan?.selection;
	if (sel) {
		const picked = [...(sel.dashboards ?? []).map((d) => `dashboard "${d}"`), ...(sel.worksheets ?? []).map((w) => `worksheet "${w}"`), ...(sel.datasources ?? []).map((d) => `datasource "${d}"`)];
		meta.push(`- Subset: ${picked.join(', ')} (${sel.counts?.after?.cards ?? cards.length} of ${sel.counts?.before?.cards ?? '?'} cards; convert with --full for the whole workbook)`);
	}
	const sampled = manifests.filter((m) => m.sampled);
	if (sampled.length) meta.push(`- **Partial data**: only the first ${Math.max(...sampled.map((m) => m.sampled))} rows per table were extracted for ${sampled.length} datasource(s)`);
	if (meta.length) out.push(...meta, '');

	out.push('## Counts', '');
	const summaryRows = [
		['Tableau datasources', ir?.datasources?.length ?? ''],
		['Tableau worksheets', ir?.worksheets?.length ?? ''],
		['Tableau dashboards', ir?.dashboards?.length ?? ''],
		['Tableau parameters', ir?.parameters?.length ?? ''],
		['Domo datasets', datasets.length],
		['Domo dataflows', dataflows.length],
		[
			'Beast Modes',
			`${beastModes.length} (${count(beastModes, (b) => b.status === 'ok')} ok, ${count(beastModes, (b) => b.status === 'approximate')} approximate, ${count(beastModes, (b) => b.status === 'unsupported')} unsupported)`
		],
		['Variables', variables.length],
		[
			'Cards',
			`${cards.length} (${count(cards, (c) => c.status === 'ok')} ok, ${count(cards, (c) => c.status === 'approximate')} approximate, ${count(cards, (c) => c.status === 'unsupported' && !c.replacedBy)} unsupported${count(cards, (c) => c.replacedBy) ? `, ${count(cards, (c) => c.replacedBy)} replaced by another construct` : ''})`
		],
		[plan?.app ? 'App views' : 'Pages', pages.length]
	];
	if (push) {
		const c = push.counts ?? {};
		summaryRows.push([
			push.dryRun ? 'Dry run actions' : 'Push actions',
			`${c.create || 0} create, ${c.register ? `${c.register} register, ` : ''}${c.update || 0} update, ${c.unchanged || 0} unchanged, ${c.reuse || 0} reuse, ${c['status:failed'] || 0} failed, ${c['status:skipped'] || 0} skipped`
		]);
	}
	out.push(table(['Item', 'Count'], summaryRows.filter((r) => r[1] !== '').map(([k, v]) => [k, cell(v)])));

	out.push('## Datasets', '');
	out.push(
		table(
			push ? ['Dataset', 'Strategy', 'Rows', 'Cards use it', 'Source', 'Push'] : ['Dataset', 'Strategy', 'Rows', 'Cards use it', 'Source'],
			datasets.map((ds) => {
				const manifest = ds.datasourceId ? manifestById.get(ds.datasourceId) : undefined;
				const action = actionFor(push, 'dataset', ds.key);
				const rows = manifest?.tables?.length ? manifest.tables.reduce((n, t) => n + (t.rowCount || 0), 0) : '';
				const ca = ds.cloudAmplifier;
				const source =
					ds.strategy === 'existing'
						? `existing ${ds.existing?.datasetId ?? ''}`
						: ds.strategy === 'connector'
							? ds.connector?.providerKey
							: ca
								? `${ca.databaseName}.${ca.schemaName}.${ca.tableName} (integration ${ca.integrationId})`
								: ds.upload?.file ?? ds.dataflowOutput?.dataflowKey ?? '';
				const row = [cell(ds.name), cell(ds.strategy === 'upload' && !ds.upload?.file ? 'schema only (empty)' : `${ds.strategy}${manifest ? ` (${manifest.strategy})` : ''}`), cell(rows), ds.cardTarget ? 'yes' : '', cell(source)];
				if (push) row.push(pushCell(action));
				return row;
			})
		)
	);

	out.push('## Beast Modes', '');
	out.push(
		table(
			push ? ['Name', 'Status', 'Tableau formula', 'Domo expression', 'Features needed', 'Push'] : ['Name', 'Status', 'Tableau formula', 'Domo expression', 'Features needed'],
			beastModes.map((bm) => {
				const row = [cell(bm.name), cell(bm.status), code(bm.tableauFormula), code(bm.expression), cell((bm.features ?? []).join(', '))];
				if (push) row.push(pushCell(actionFor(push, 'beastmode', bm.key)));
				return row;
			})
		)
	);

	if (variables.length) {
		out.push('## Variables (Tableau parameters)', '');
		out.push(
			table(
				['Name', 'Type', 'Default', 'Domain'],
				variables.map((v) => [cell(v.name), cell(v.dataType), code(v.defaultExpression), cell(v.parameter?.domain)])
			)
		);
	}

	out.push('## Cards', '');
	out.push(
		table(
			push ? ['Card', 'Worksheet', 'Chart type', 'Status', 'Push'] : ['Card', 'Worksheet', 'Chart type', 'Status'],
			cards.map((card) => {
				const row = [cell(card.title), cell(card.worksheet || (card.stack ? card.stack.sheets.join(' + ') : { image: '(image)', notebook: '(text card)' }[card.kind] || '(filter card)')), code(card.chartType), cell(card.replacedBy ? `replaced (${REPLACED[card.replacedBy] ?? card.replacedBy})` : card.status)];
				if (push) row.push(pushCell(actionFor(push, 'card', card.key)));
				return row;
			})
		)
	);

	if (plan?.app) {
		const app = plan.app;
		const pushed = push?.app;
		const viewLinks = new Map((pushed?.views ?? []).map((v) => [v.key, v.url]));
		out.push('## App Studio app', '');
		out.push(pushed?.url ? `[${cell(app.title)}](${pushed.url}) (app ${pushed.id})` : `${cell(app.title)} (not pushed yet)`, '');
		out.push(`Theme ${cell(app.theme?.base ?? '')}, ${cell(app.navigation?.orientation ?? '')} navigation.`, '');
		out.push(
			table(
				push ? ['View', 'Dashboard', 'Nav order', 'Hidden', 'Cards', 'Link', 'Push'] : ['View', 'Dashboard', 'Nav order', 'Hidden', 'Cards'],
				pages.map((pg) => {
					const nCards = cards.filter((c) => (c.pageKeys ?? []).includes(pg.key)).length;
					const row = [cell(pg.title), cell(pg.dashboard || '(worksheets)'), cell(pg.navOrder ?? ''), pg.hidden ? 'yes' : '', cell(nCards)];
					if (push) row.push(viewLinks.get(pg.key) ? `[open](${viewLinks.get(pg.key)})` : '', pushCell(actionFor(push, 'page', pg.key)));
					return row;
				})
			)
		);
	} else {
		out.push('## Pages', '');
		const pageTitles = new Map(pages.map((pg) => [pg.key, pg.title]));
		out.push(
			table(
				push ? ['Page', 'Parent', 'Dashboard', 'Cards', 'Push'] : ['Page', 'Parent', 'Dashboard', 'Cards'],
				pages.map((pg) => {
					const nCards = cards.filter((c) => (c.pageKeys ?? []).includes(pg.key)).length;
					const row = [cell(pg.title), cell(pg.parentKey ? pageTitles.get(pg.parentKey) ?? pg.parentKey : ''), cell(pg.dashboard || ''), cell(nCards)];
					if (push) row.push(pushCell(actionFor(push, 'page', pg.key)));
					return row;
				})
			)
		);
	}

	const seenIssues = new Set();
	const issues = [
		...(ir?.issues ?? []).map((i) => ({ ...i, stage: 'extract' })),
		...manifests.flatMap((m) => (m.issues ?? []).map((i) => ({ ...i, stage: 'data' }))),
		...(plan?.issues ?? []).map((i) => ({ ...i, stage: 'convert' })),
		...(push?.issues ?? []).map((i) => ({ ...i, stage: 'push' }))
	].filter((i) => {
		const key = JSON.stringify([i.severity, i.code, i.message, i.object?.type, i.object?.name, i.object?.id]);
		if (seenIssues.has(key)) return false;
		seenIssues.add(key);
		return true;
	});
	const pushFailures = (push?.actions ?? []).filter((a) => a.status === 'failed' || a.status === 'skipped');

	out.push('## Issues', '');
	if (!issues.length && !pushFailures.length) out.push('_No issues._', '');
	for (const severity of SEVERITY_ORDER) {
		const group = issues.filter((i) => (i.severity ?? 'info') === severity);
		if (!group.length) continue;
		out.push(`### ${SEVERITY_TITLE[severity]} (${group.length})`, '');
		for (const issue of group) {
			const object = issue.object ? ` ${issue.object.type} "${issue.object.name}":` : '';
			out.push(`- **${cell(issue.code)}** (${issue.stage})${cell(object)} ${cell(issue.message)}`);
			if (issue.suggestion) out.push(`  - Suggestion: ${cell(issue.suggestion)}`);
		}
		out.push('');
	}
	if (pushFailures.length) {
		out.push(`### Push failures (${pushFailures.length})`, '');
		for (const a of pushFailures) out.push(`- ${a.kind} "${cell(a.name ?? a.key)}" ${a.status}: ${cell(a.error ?? '')}`);
		out.push('');
	}

	out.push(...timingSection(runs));
	return out.join('\n');
}

const TIMED_STAGES = ['extract', 'convert', 'push', 'unpush'];

/** Duration of each stage's latest run, then its slowest steps. */
function timingSection(runs) {
	const logs = TIMED_STAGES.map((stage) => [stage, runs?.[stage]]).filter(([, log]) => log?.timing);
	if (!logs.length) return [];
	const label = (stage, log) => (log.dryRun ? `${stage} (dry run)` : stage);
	const out = ['## Timing', ''];
	out.push(table(['Stage', 'Started', 'Duration', 'Result'], logs.map(([stage, log]) => [label(stage, log), cell(log.startedAt), formatDuration(log.timing.ms), log.ok === false ? 'failed' : 'ok'])));
	const total = logs.filter(([, log]) => !log.dryRun).reduce((sum, [, log]) => sum + log.timing.ms, 0);
	out.push(`Latest runs together: ${formatDuration(total)}.`, '');
	const steps = logs
		.flatMap(([stage, log]) => log.timing.steps.map((s) => ({ ...s, stage: label(stage, log) })))
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 10);
	if (steps.length) {
		out.push('Slowest steps:', '');
		out.push(table(['Stage', 'Step', 'Object', 'Duration', 'Rows', 'Bytes'], steps.map((s) => [s.stage, cell(s.step), cell(s.name ?? s.key ?? ''), formatDuration(s.ms), s.rows != null ? Number(s.rows).toLocaleString('en-US') : '', s.bytes != null ? formatBytes(s.bytes) : ''])));
	}
	return out;
}
