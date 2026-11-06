import { createEmitter, noopSink } from '../util/events.js';
import { createTimer } from '../util/timing.js';
import { convertStage } from './convert.js';
import { extractWorkbook } from './extract.js';
import { pushPlan } from './push.js';

function pushOnly(selection) {
	if (!selection) return selection;
	const rest = { ...selection };
	for (const k of ['dashboards', 'worksheets', 'datasources']) delete rest[k];
	return rest;
}

/**
 * Run extract, convert and push in sequence.
 *
 * When `confirm` is given and this is not a dry run, a dry-run push runs first and
 * `confirm(preview)` decides whether the real push happens.
 *
 * @param {{
 *   config: import('../config.js').T2DConfig,
 *   workbook?: string,
 *   file?: string,
 *   project?: string,
 *   dataStrategy?: string,
 *   includeExtract?: boolean,
 *   metadata?: boolean,
 *   publishedFields?: boolean,
 *   domoLookup?: boolean,
 *   client?: import('../tableau/client.js').TableauClient,
 *   sharedCache?: Map<string, any>,
 *   refreshShared?: boolean,
 *   unmapped?: 'ask'|'export'|'fail',
 *   decide?: (decisions: import('./decisions.js').DataDecision[]) => Promise<{ key: string, choice: string, id?: string|number }[]|null>,
 *   options?: import('../model/types.js').ConvertOptions,
 *   selection?: import('../convert/select.js').Selection,
 *   full?: boolean,
 *   dryRun?: boolean,
 *   parentPageId?: string|number,
 *   only?: string|string[],
 *   force?: boolean,
 *   skipPush?: boolean,
 *   confirm?: (preview: import('./push.js').PushSummary) => Promise<boolean>|boolean,
 *   sink?: import('../util/events.js').EventSink,
 *   deps?: { extract?: Record<string, any>, convertWorkbook?: Function, push?: Record<string, any> }
 * }} opts  `selection` applies to all three stages (extract only the data it needs, prune the plan, push the subset).
 *   `client` (a signed-in TableauClient) and `sharedCache` let a batch reuse one session and shared datasource data.
 * @returns {Promise<{ slug: string, plan: import('../model/types.js').DomoPlan, push: import('./push.js').PushSummary|null, preview?: import('./push.js').PushSummary, cancelled?: boolean, timing: MigrateTiming }>}
 * @typedef {import('../util/timing.js').Timing & { stages: { extract?: import('../util/timing.js').Timing, push?: import('../util/timing.js').Timing } }} MigrateTiming
 */
export async function migrateWorkbook(opts) {
	const { config, sink = noopSink, deps = {}, dryRun = false, confirm, skipPush = false } = opts;
	const timer = createTimer({ emitter: createEmitter(sink, 'migrate') });
	const timing = (push) => ({ ...timer.finish(), stages: { ...(extracted.timing ? { extract: extracted.timing } : {}), ...(push?.timing ? { push: push.timing } : {}) } });
	const extracted = await timer.time('extract', () => extractWorkbook({
		config,
		workbook: opts.workbook,
		file: opts.file,
		project: opts.project,
		dataStrategy: opts.dataStrategy,
		includeExtract: opts.includeExtract,
		metadata: opts.metadata,
		publishedFields: opts.publishedFields,
		domoLookup: opts.domoLookup,
		snowflakeViews: opts.snowflakeViews,
		selection: opts.selection,
		client: opts.client,
		sharedCache: opts.sharedCache,
		refreshShared: opts.refreshShared,
		unmapped: opts.unmapped,
		decide: opts.decide,
		dryRun,
		emitter: createEmitter(sink, 'extract'),
		deps: deps.extract
	}));
	const { slug } = extracted;
	const plan = await timer.time('convert', () => convertStage({
		config,
		slug,
		options: opts.options,
		selection: opts.selection,
		full: opts.full,
		emitter: createEmitter(sink, 'convert'),
		convertWorkbook: deps.convertWorkbook
	}));
	if (skipPush) return { slug, plan, push: null, timing: timing() };

	const pushOpts = {
		config,
		slug,
		parentPageId: opts.parentPageId,
		only: opts.only,
		force: opts.force,
		selection: opts.full ? pushOnly(opts.selection) : opts.selection,
		emitter: createEmitter(sink, 'push'),
		deps: deps.push
	};
	if (dryRun) {
		const push = await timer.time('push', () => pushPlan({ ...pushOpts, dryRun: true }));
		return { slug, plan, push, timing: timing(push) };
	}
	let preview;
	if (confirm) {
		preview = await timer.time('push-preview', () => pushPlan({ ...pushOpts, dryRun: true }));
		if (!(await timer.time('confirm', () => confirm(preview)))) return { slug, plan, push: null, preview, cancelled: true, timing: timing() };
	}
	const push = await timer.time('push', () => pushPlan({ ...pushOpts, dryRun: false }));
	return { slug, plan, push, ...(preview ? { preview } : {}), timing: timing(push) };
}
