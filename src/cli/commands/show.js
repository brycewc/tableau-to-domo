import { describeWorkbook } from '../../pipeline/show.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { formatTable } from '../reporter.js';
import { requireWorkbookArg } from '../shared.js';

export const name = 'show';
export const summary = 'List a workbook\'s dashboards, worksheets, datasources and plan keys, to pick a subset';
export const usage = 't2d show --workbook <slug>';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'Extracted workbook' }
};

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	const info = await describeWorkbook({ config, slug });
	reporter.print(reporter.bold(`${info.workbook?.name ?? slug} (${slug})`));
	reporter.print('');
	reporter.print(reporter.bold('Dashboards'));
	reporter.print(info.dashboards.length ? formatTable(['Dashboard', 'Worksheets'], info.dashboards.map((d) => [d.name, d.worksheets.join(', ')])) : '  (none)');
	reporter.print('');
	reporter.print(reporter.bold('Worksheets'));
	reporter.print(
		info.worksheets.length
			? formatTable(['Worksheet', 'Datasources', 'Dashboards', 'Chart', 'Card key'], info.worksheets.map((w) => [`${w.name}${w.hidden ? ' (hidden)' : ''}`, w.datasources.join(', '), w.dashboards.join(', '), w.chartType ?? '', w.cardKey ?? '']))
			: '  (none)'
	);
	reporter.print('');
	reporter.print(reporter.bold('Datasources'));
	reporter.print(
		info.datasources.length
			? formatTable(['Datasource', 'Data strategy', 'Tables', 'Rows', 'Dataset keys'], info.datasources.map((d) => [`${d.caption}${d.published ? ' (published)' : ''}`, d.strategy ?? 'not extracted', d.tables, `${d.rows}${d.sampled ? ` (sample of ${d.sampled})` : ''}`, d.datasetKeys.join(', ')]))
			: '  (none)'
	);
	if (info.plan) {
		reporter.print('');
		reporter.print(reporter.bold(`Plan keys${info.plan.selection ? ' (plan is a subset; convert with --full for all)' : ''}`));
		for (const [kind, keys] of Object.entries(info.plan.keys)) if (keys.length) reporter.print(`  ${kind}: ${keys.join(', ')}`);
	} else {
		reporter.print('');
		reporter.print(`No plan yet. Next: t2d convert --workbook ${slug}`);
	}
	return info;
}
