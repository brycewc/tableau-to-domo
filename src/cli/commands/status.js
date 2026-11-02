import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listRuns } from '../../pipeline/runs.js';
import { loadState } from '../../pipeline/state.js';
import { formatDuration } from '../../util/timing.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { formatTable } from '../reporter.js';
import { requireWorkbookArg } from '../shared.js';

export const name = 'status';
export const summary = 'Show which planned objects already exist in Domo (from push state)';
export const usage = 't2d status --workbook <slug> [--runs]';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'Workbook' },
	runs: { type: 'boolean', description: 'List past extract, convert, push and unpush runs with their durations' }
};

/** Planned object refs by kind. */
function plannedRefs(plan) {
	const groups = {
		dataset: (plan.datasets ?? []).map((x) => x.key),
		dataflow: (plan.dataflows ?? []).map((x) => x.key),
		variable: (plan.variables ?? []).map((x) => x.key),
		beastmode: (plan.beastModes ?? []).filter((x) => x.status !== 'unsupported').map((x) => x.key),
		app: plan.app ? [plan.app.key] : [],
		page: (plan.pages ?? []).map((x) => x.key),
		card: (plan.cards ?? []).map((x) => x.key),
		layout: (plan.pages ?? []).filter((x) => x.layout).map((x) => x.key),
		navigation: plan.app ? [plan.app.key] : []
	};
	return groups;
}

async function instancesWithState(ws) {
	try {
		return (await fsp.readdir(ws.stateDir)).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));
	} catch {
		return [];
	}
}

async function printRuns(ws, slug, reporter) {
	const runs = await listRuns(ws, slug);
	if (!runs.length) reporter.print(`No run logs for ${slug} yet (they are written to ${ws.relative(ws.paths(slug).logsDir)}/ from now on).`);
	else {
		const detail = (r) => r.error ?? (r.counts && r.stage === 'push' ? `${r.counts.create || 0} create, ${r.counts.update || 0} update, ${r.counts['status:failed'] || 0} failed` : '');
		reporter.print(formatTable(['Started', 'Stage', 'Duration', 'Result', 'Instance', 'Detail'], runs.map((r) => [r.startedAt, r.stage, r.ms != null ? formatDuration(r.ms) : '', r.ok ? 'ok' : 'failed', r.instance ?? '', detail(r)])));
	}
	return { slug, runs };
}

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	const p = ws.paths(slug);
	if (args.values.runs) return printRuns(ws, slug, reporter);
	const plan = await ws.readJson(p.plan, null);
	const stages = {
		extracted: fs.existsSync(p.ir),
		converted: Boolean(plan),
		pushed: fs.existsSync(p.pushLog)
	};
	const instances = config.domo.instance ? [config.domo.instance] : await instancesWithState(ws);
	const lastPush = await ws.readJson(p.pushLog, null);
	const perInstance = [];
	for (const instance of instances) {
		const state = await loadState(ws, instance);
		const kinds = plan ? plannedRefs(plan) : {};
		const rows = Object.entries(kinds)
			.filter(([, keys]) => keys.length)
			.map(([kind, keys]) => {
				const pushed = keys.filter((k) => state.objects[`${kind}:${k}`]).length;
				return { kind, planned: keys.length, pushed, missing: keys.length - pushed };
			});
		perInstance.push({ instance, rows });
	}

	reporter.print(`${slug}: extracted ${stages.extracted ? 'yes' : 'no'}, converted ${stages.converted ? 'yes' : 'no'}, pushed ${stages.pushed ? 'yes' : 'no'}`);
	if (lastPush) {
		const c = lastPush.counts ?? {};
		reporter.print(`Last push to ${lastPush.instance} at ${lastPush.finishedAt ?? lastPush.startedAt}: ${lastPush.ok ? 'ok' : 'with failures'} (${c['status:failed'] || 0} failed, ${c['status:skipped'] || 0} skipped)${lastPush.timing ? `, took ${formatDuration(lastPush.timing.ms)}` : ''}`);
	}
	for (const { instance, rows } of perInstance) {
		reporter.print('');
		reporter.print(`Instance ${instance}:`);
		reporter.print(rows.length ? formatTable(['Kind', 'Planned', 'In Domo', 'Missing'], rows.map((r) => [r.kind, r.planned, r.pushed, r.missing])) : '  (no plan or nothing planned)');
	}
	if (!perInstance.length) reporter.print('No push state yet.');
	return { slug, stages, instances: perInstance, lastPush: lastPush ? { instance: lastPush.instance, ok: lastPush.ok, counts: lastPush.counts, finishedAt: lastPush.finishedAt } : null };
}
