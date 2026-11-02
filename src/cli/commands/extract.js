import { createEmitter } from '../../util/events.js';
import { extractWorkbook } from '../../pipeline/extract.js';
import { deciderFor } from '../decide.js';
import { EXTRACT_OPTIONS, SAMPLE_OPTION, SELECT_OPTIONS, extractOptionsFrom, formatTiming, selectionFrom } from '../shared.js';

export const name = 'extract';
export const summary = 'Download a workbook (or read a local file) and build ir.json plus data files';
export const usage = 't2d extract (--workbook <name|luid> | --file <path>) [--project <name>] [--data-strategy <s>] [--unmapped ask|export|fail] [--no-extract-data] [--no-metadata] [--no-domo-lookup] [--refresh-data] [--dashboards <names>] [--worksheets <names>] [--datasources <names>] [--sample-rows <n>]';
export const options = { ...EXTRACT_OPTIONS, ...SELECT_OPTIONS, ...SAMPLE_OPTION };

/** @param {import('../main.js').CommandContext} ctx */
export async function run(ctx) {
	const { config, args, reporter } = ctx;
	const opts = extractOptionsFrom(args.values);
	const selection = selectionFrom(args.values);
	const { slug, ir, manifests, timing } = await extractWorkbook({ config, ...opts, selection, decide: deciderFor(ctx), emitter: createEmitter(reporter.sink, 'extract') });
	reporter.print(`Extracted "${ir.workbook?.name}" as ${slug}`);
	reporter.print(`  ${ir.datasources.length} datasource(s), ${ir.worksheets.length} worksheet(s), ${ir.dashboards.length} dashboard(s), ${ir.issues.length} issue(s)`);
	for (const m of manifests) {
		const rows = (m.tables ?? []).reduce((n, t) => n + (t.rowCount || 0), 0);
		if (m.strategy === 'cloud-amplifier') {
			const ca = m.cloudAmplifier ?? {};
			reporter.print(`  data ${m.datasourceId}: cloud-amplifier via ${(ca.integrations ?? []).map((i) => i.name).join(', ')}, ${ca.tables?.length ?? 0} table(s) to register, no data copied`);
		} else reporter.print(`  data ${m.datasourceId}: ${m.strategy}, ${m.tables?.length ?? 0} table(s), ${rows} row(s)${m.sampled ? ` (sample: first ${m.sampled} rows per table)` : ''}`);
		if (m.shared) reporter.print(`    shared published datasource "${m.shared.name}" (${m.shared.reused ? 'reused' : 'extracted'} in ${m.shared.dir})`);
	}
	reporter.print(formatTiming(timing, { label: 'Extract took' }));
	reporter.print(`Next: t2d convert --workbook ${slug}`);
	return {
		slug,
		timing,
		workbook: ir.workbook,
		counts: { datasources: ir.datasources.length, worksheets: ir.worksheets.length, dashboards: ir.dashboards.length, issues: ir.issues.length },
		data: manifests.map((m) => ({
			datasourceId: m.datasourceId,
			strategy: m.strategy,
			tables: m.tables?.length ?? 0,
			...(m.sampled ? { sampled: m.sampled } : {}),
			...(m.shared ? { shared: { luid: m.shared.luid, name: m.shared.name, dir: m.shared.dir, reused: m.shared.reused } } : {})
		}))
	};
}
