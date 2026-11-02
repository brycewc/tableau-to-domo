import { dashboardWorksheets } from '../convert/select.js';
import { openWorkspace } from './workspace.js';

/**
 * What a workbook contains, so a subset can be picked for extract, convert, push and unpush:
 * dashboards with their worksheets, worksheets, datasources with their data strategy, and plan keys.
 *
 * @param {{ config: import('../config.js').T2DConfig, slug: string }} opts
 * @returns {Promise<{
 *   slug: string,
 *   workbook: import('../model/types.js').WorkbookInfo|null,
 *   dashboards: { name: string, worksheets: string[], pageKey?: string }[],
 *   worksheets: { name: string, hidden: boolean, datasources: string[], dashboards: string[], cardKey?: string, chartType?: string, status?: string }[],
 *   datasources: { id: string, caption: string, published: boolean, strategy: string|null, tables: number, rows: number, sampled?: number, datasetKeys: string[] }[],
 *   plan: { selection: Object|null, keys: Record<string, string[]> }|null
 * }>}
 */
export async function describeWorkbook({ config, slug }) {
	const ws = openWorkspace(config.workspace);
	const p = ws.paths(slug);
	const ir = await ws.readJson(p.ir, null);
	if (!ir) throw new Error(`No ir.json for "${slug}" at ${p.ir}. Run extract first.`);
	const plan = await ws.readJson(p.plan, null);
	const manifests = await ws.readManifests(slug);
	const manifestById = new Map(manifests.map((m) => [m.datasourceId, m]));
	const captionOf = new Map((ir.datasources ?? []).map((ds) => [ds.id, ds.caption || ds.id]));

	const dashboards = (ir.dashboards ?? []).map((d) => {
		const page = plan?.pages?.find((pg) => pg.dashboard === d.name);
		return { name: d.name, worksheets: dashboardWorksheets(d), ...(page ? { pageKey: page.key } : {}) };
	});
	const worksheets = (ir.worksheets ?? []).map((w) => {
		const card = plan?.cards?.find((c) => c.worksheet === w.name);
		return {
			name: w.name,
			hidden: Boolean(w.hidden),
			datasources: (w.datasourceIds ?? []).map((id) => captionOf.get(id) ?? id),
			dashboards: dashboards.filter((d) => d.worksheets.includes(w.name)).map((d) => d.name),
			...(card ? { cardKey: card.key, chartType: card.chartType, status: card.status } : {})
		};
	});
	const usedIds = new Set((ir.worksheets ?? []).flatMap((w) => w.datasourceIds ?? []));
	const datasources = (ir.datasources ?? [])
		.filter((ds) => usedIds.has(ds.id) || manifestById.has(ds.id))
		.map((ds) => {
			const m = manifestById.get(ds.id);
			return {
				id: ds.id,
				caption: ds.caption || ds.id,
				published: Boolean(ds.published),
				strategy: m?.strategy ?? null,
				tables: m?.strategy === 'cloud-amplifier' ? (m.cloudAmplifier?.tables?.length ?? 0) : (m?.tables?.length ?? 0),
				rows: (m?.tables ?? []).reduce((n, t) => n + (t.rowCount || 0), 0),
				...(m?.sampled ? { sampled: m.sampled } : {}),
				datasetKeys: (plan?.datasets ?? []).filter((x) => x.datasourceId === ds.id).map((x) => x.key)
			};
		});
	const planInfo = plan
		? {
				selection: plan.selection ?? null,
				keys: {
					datasets: (plan.datasets ?? []).map((x) => x.key),
					dataflows: (plan.dataflows ?? []).map((x) => x.key),
					variables: (plan.variables ?? []).map((x) => x.key),
					beastmodes: (plan.beastModes ?? []).map((x) => x.key),
					...(plan.app ? { app: [plan.app.key], navigation: [plan.app.key] } : {}),
					pages: (plan.pages ?? []).map((x) => x.key),
					cards: (plan.cards ?? []).map((x) => x.key),
					layouts: (plan.pages ?? []).filter((x) => x.layout).map((x) => x.key)
				}
			}
		: null;
	return { slug, workbook: ir.workbook ?? null, dashboards, worksheets, datasources, plan: planInfo };
}
