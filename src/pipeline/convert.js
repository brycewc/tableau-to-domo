import fs from 'node:fs';
import { createEmitter } from '../util/events.js';
import { createTimer } from '../util/timing.js';
import { hasObjectSelection, normalizeSelection, selectPlan } from '../convert/select.js';
import { updateSharedRegistry } from '../convert/beastmodes.js';
import { linkTargetOf, linkedWorkbooks, siteFromConfig } from '../convert/web-links.js';
import { renderReport } from './report.js';
import { latestRunLogs, writeRunLog } from './runs.js';
import { openWorkspace } from './workspace.js';
import { backfillImages, describeImages, needsImageBackfill } from './images.js';

/**
 * Stage 2: IR + manifests + mappings -> plan.json and report.md. No network.
 *
 * @param {{
 *   config: import('../config.js').T2DConfig,
 *   slug: string,
 *   options?: import('../model/types.js').ConvertOptions,
 *   selection?: import('../convert/select.js').Selection,
 *   full?: boolean,
 *   emitter?: import('../util/events.js').Emitter,
 *   convertWorkbook?: Function
 * }} opts  `selection` writes a plan pruned to the selected dashboards, worksheets and datasources (`plan.selection`).
 *   Without one, the selection extract ran with is reused unless `full`. `convertWorkbook` overrides the converter (tests).
 * @returns {Promise<import('../model/types.js').DomoPlan>}
 */
export async function convertStage({ config, slug, options = {}, selection, full = false, emitter = createEmitter(undefined, 'convert'), convertWorkbook }) {
	const timer = createTimer({ emitter });
	const ws = openWorkspace(config.workspace);
	const p = ws.paths(slug);
	if (!fs.existsSync(p.ir)) throw new Error(`No ir.json for "${slug}" at ${p.ir}. Run extract first.`);
	timer.phase('read');
	const ir = await ws.readJson(p.ir);
	if (needsImageBackfill(ir)) await backfillFromPackage(ws, p, ir, emitter);
	await describeImages(ir, p.dir);
	const manifests = await ws.readManifests(slug);
	const mappings = await ws.loadMappings();

	const convert = convertWorkbook ?? (await import('../convert/index.js')).convertWorkbook;
	emitter.step(`Converting "${ir.workbook?.name ?? slug}"`);
	timer.phase('convert');
	const sharedLuids = [...new Set(manifests.map((m) => m.shared?.luid).filter(Boolean))];
	const registries = new Map();
	for (const luid of sharedLuids) registries.set(luid, await ws.readJson(ws.sharedPaths(luid).beastModes, null).catch(() => null));
	const registry = Object.assign({}, ...[...registries.values()].map((r) => r?.datasets ?? {}));
	const links = await linkContext(ws, slug, ir, config);
	let plan = await convert(ir, { manifests, mappings, options, emitter, irFile: ws.relative(p.ir), shared: { workbook: slug, registry }, links });
	await saveSharedRegistries(ws, slug, plan, registries);

	timer.phase('select');
	let sel = normalizeSelection(selection);
	if (!full && !hasObjectSelection(sel)) {
		const extracted = (await ws.readJson(p.metadata, null).catch(() => null))?.selection;
		if (hasObjectSelection(extracted)) {
			sel = { ...normalizeSelection(extracted), ...sel };
			emitter.info('Using the selection extract ran with (pass --full for the whole workbook)', { selection: extracted });
		}
	}
	if (!full && hasObjectSelection(sel)) {
		plan = selectPlan(plan, sel, { ir });
		const s = plan.selection;
		emitter.info(`Selected ${[...s.dashboards.map((d) => `dashboard "${d}"`), ...s.worksheets.map((w) => `worksheet "${w}"`), ...s.datasources.map((d) => `datasource "${d}"`)].join(', ')}`, { counts: s.counts });
	}

	timer.phase('write');
	await ws.writeJson(p.plan, plan);
	const timing = timer.finish({ slug });
	const log = {
		slug,
		workbook: ir.workbook?.name ?? slug,
		ok: true,
		startedAt: timing.startedAt,
		finishedAt: timing.finishedAt,
		counts: { datasets: plan.datasets?.length ?? 0, beastModes: plan.beastModes?.length ?? 0, cards: plan.cards?.length ?? 0, pages: plan.pages?.length ?? 0, issues: plan.issues?.length ?? 0 },
		timing
	};
	await ws.writeJson(p.convertLog, log);
	await writeRunLog(ws, slug, 'convert', log);
	const { extract } = await latestRunLogs(ws, slug);
	await ws.writeText(p.report, renderReport({ ir, plan, manifests, runs: { extract, convert: log } }));
	emitter.done(`Wrote ${ws.relative(p.plan)} and ${ws.relative(p.report)}`, {
		slug,
		datasets: plan.datasets?.length ?? 0,
		beastModes: plan.beastModes?.length ?? 0,
		cards: plan.cards?.length ?? 0,
		pages: plan.pages?.length ?? 0,
		issues: plan.issues?.length ?? 0
	});
	return plan;
}

/**
 * Image bytes for an ir.json from before image extraction, read from the package extract stored (metadata sourceFile,
 * else source.twbx in the workbook directory), so the images convert without extracting from Tableau again. Mutates the IR.
 */
async function backfillFromPackage(ws, p, ir, emitter) {
	const sourceFile = (await ws.readJson(p.metadata, null).catch(() => null))?.sourceFile;
	const file = [sourceFile && ws.resolve(sourceFile), p.source('twbx')].find((f) => f && fs.existsSync(f));
	if (!file) return;
	const { openPackage } = await import('../tableau/package.js');
	const { buildWorkbookIR } = await import('../tableau/twb/index.js');
	let pkg;
	try {
		pkg = await openPackage(file);
		const issues = await backfillImages(pkg, ir, p.dir, (xml) => buildWorkbookIR(xml));
		ir.issues = [...(ir.issues ?? []), ...issues];
		emitter.info(`Read the dashboard images from ${ws.relative(file)} (ir.json predates image extraction)`);
	} catch (err) {
		emitter.warn(`Could not read the dashboard images from ${ws.relative(file)}: ${err.message}`);
	} finally {
		await Promise.resolve(pkg?.close?.()).catch(() => {});
	}
}

/**
 * The Tableau site and the other workspace workbooks that this workbook's web zones show views of: the workbooks of the
 * migration, read from their plan.json, else their ir.json. Undefined when no web zone shows another workbook's view.
 * @returns {Promise<import('../convert/web-links.js').LinkContext|undefined>}
 */
export async function linkContext(ws, slug, ir, config) {
	const wanted = new Set(linkedWorkbooks(ir).map((w) => w.toLowerCase()));
	const site = siteFromConfig(config?.tableau);
	if (!wanted.size) return site ? { site } : undefined;
	const targets = [];
	for (const w of await ws.listWorkbooks()) {
		if (w.slug === slug || !w.contentUrl || !wanted.has(w.contentUrl.toLowerCase())) continue;
		const wp = ws.paths(w.slug);
		const plan = await ws.readJson(wp.plan, null).catch(() => null);
		const other = plan ? undefined : await ws.readJson(wp.ir, null).catch(() => null);
		if (plan || other) targets.push(linkTargetOf({ slug: w.slug, contentUrl: w.contentUrl, plan, ir: other }));
	}
	return { ...(site ? { site } : {}), targets };
}

async function saveSharedRegistries(ws, slug, plan, registries) {
	for (const [luid, previous] of registries) {
		const datasets = { ...(previous?.datasets ?? {}) };
		for (const ds of (plan.datasets ?? []).filter((d) => d.shared?.luid === luid && d.cardTarget)) {
			datasets[ds.key] = updateSharedRegistry(datasets[ds.key], slug, (plan.beastModes ?? []).filter((bm) => bm.datasetKey === ds.key));
		}
		await ws.writeJson(ws.sharedPaths(luid).beastModes, { luid, updatedAt: new Date().toISOString(), datasets });
	}
}
