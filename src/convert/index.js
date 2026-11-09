import { combineDataflows, moveDataflowsToWarehouse, useGraphEditor } from './combine-dataflows.js';
import { warehouseSafeSorts } from './warehouse-sorts.js';
import { IR_VERSION, PLAN_VERSION } from '../model/types.js';
import { slugify } from '../util/ids.js';
import { createEmitter, noopSink } from '../util/events.js';
import { manifestIndex, planDatasets } from './datasets.js';
import { applyMemberCase } from './member-case.js';
import { planBlends } from './blends.js';
import { materializeCalcs, isFederatedDataset } from './materialize.js';
import { periodTopFilters } from './period-top.js';
import { collectRefs } from '../util/refs.js';
import { planCards } from './cards.js';
import { applyDrillInteractions } from './drill.js';
import { dashboardFilterScopes } from './filters.js';
import { planCrosstabStacks } from './stack.js';
import { pageDefaultFilters, planPages, withoutHiddenZones } from './layout.js';
import { withSheetViews, withoutUnpublishedSheets } from './published.js';
import { withDatePartFilterFields } from './date-part-filters.js';
import { resolveParameterModes } from './variables.js';
import { formatPlanSql } from './sql-format.js';
import { hiddenScope } from './hidden-members.js';
import { expandKnownSplits } from './split.js';
import { usedBeastModes } from './select.js';
import { MAX_COLOR_MEMBERS } from '../tableau/twb/colors.js';
import { assignCalendarSources, planCalendarConflicts } from './fiscal.js';

/** @type {Required<Omit<import('../model/types.js').ConvertOptions, 'pageTitle'|'theme'|'navOrientation'|'workbookTheme'>>} */
export const DEFAULT_CONVERT_OPTIONS = Object.freeze({
	useFixed: true,
	useWindowFunctions: true,
	parameters: 'variables',
	joins: 'dataflow',
	createFilterCards: true,
	materialize: true,
	namePrefix: '',
	target: 'app',
	persistFilters: true,
	domoNav: true,
	tableauLinks: true,
	unpublished: false
});

/**
 * Fill ConvertOptions defaults; undefined values do not override defaults. The root page title defaults to the
 * workbook name with the name prefix.
 * @param {import('../model/types.js').ConvertOptions} [options]
 * @param {import('../model/types.js').WorkbookIR} [ir]
 */
export function resolveConvertOptions(options = {}, ir) {
	const given = Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== undefined));
	const resolved = { ...DEFAULT_CONVERT_OPTIONS, ...given };
	const name = ir?.workbook?.name;
	return { ...resolved, pageTitle: given.pageTitle ?? (name === undefined ? undefined : `${resolved.namePrefix ?? ''}${name}`) };
}

const TEXT_MATCHING = /\b(CONTAINS|STARTSWITH|ENDSWITH|FIND)\s*\(/i;
const hasTextMatching = (ir) => (ir.datasources ?? []).some((ds) => (ds.fields ?? []).some((f) => TEXT_MATCHING.test(f.formula ?? '')));

function hasTextRanges(ir) {
	return (ir.datasources ?? []).some((ds) => {
		const text = new Set((ds.fields ?? []).filter((f) => f.datatype === 'string').map((f) => f.id));
		const filters = [...(ds.filters ?? []), ...(ir.worksheets ?? []).flatMap((w) => (w.filters ?? []).filter((f) => f.datasourceId === ds.id))];
		return filters.some((f) => f.ranges?.length && text.has(f.fieldId)) || (ds.fields ?? []).some((f) => f.set?.ranges?.length && text.has(f.set.source));
	});
}

function windowCardIssues(ir, version) {
	if (version >= 15) return [];
	const zoned = new Set((ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])]).filter((z) => z.kind === 'filter' && z.worksheet).map((z) => z.worksheet));
	if (!(ir.worksheets ?? []).some((w) => zoned.has(w.name) || (w.filters ?? []).some((f) => f.shownOnDashboard))) return [];
	return [
		{
			severity: 'info',
			code: 'convert.ir-outdated',
			message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read the filter cards of each worksheet's own window, so every filter a dashboard shows for a sheet is a quick filter of its card`,
			object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
			suggestion: 'Run t2d extract again for this workbook, then convert.'
		}
	];
}

function tableStyleIssues(ir, version, asApp) {
	if (version >= 16 || !asApp || !(ir.worksheets ?? []).some((w) => w.totals) || (ir.worksheets ?? []).some((w) => w.tableStyle) || ir.style?.table) return [];
	return [
		{
			severity: 'info',
			code: 'convert.ir-outdated',
			message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read table shading (row banding, totals and subtotals fill, row dividers), so the app's tables, totals included, take Tableau's default look`,
			object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
			suggestion: 'Run t2d extract again for this workbook, then convert.'
		}
	];
}

function sideCardIssues(ir, version) {
	const views = ir.workbook?.views ?? [];
	const onDashboard = new Set((ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])].map((z) => z.worksheet)));
	if (version >= 18 || !(ir.worksheets ?? []).some((w) => !onDashboard.has(w.name) && views.some((v) => v.name === w.name))) return [];
	return [
		{
			severity: 'info',
			code: 'convert.ir-outdated',
			message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read the parameter controls and legends of each worksheet's own window, so a worksheet's own view shows only its filter cards`,
			object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
			suggestion: 'Run t2d extract again for this workbook, then convert.'
		}
	];
}

function fiscalStartIssues(ir, version) {
	if (version >= 17 || !(ir.datasources ?? []).some((ds) => (ds.fields ?? []).some((f) => f.datatype === 'date' || f.datatype === 'datetime'))) return [];
	return [
		{
			severity: 'info',
			code: 'convert.ir-outdated',
			message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read fiscal year starts, so every date part, truncation and relative date filter uses a calendar year starting in January`,
			object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
			suggestion: 'Run t2d extract again for this workbook, then convert.'
		}
	];
}

function unscopedFilterIssues(ir, version) {
	if (version >= 13) return [];
	const sheets = new Map((ir.worksheets ?? []).map((w) => [w.name, w]));
	const sets = new Set((ir.datasources ?? []).flatMap((ds) => (ds.fields ?? []).filter((f) => f.kind === 'set').map((f) => `${ds.id}\u0000${f.id}`)));
	const shared = (ir.issues ?? []).some((i) => i.code === 'twb.shared-filter');
	const peers = (ir.dashboards ?? []).some((d) => {
		const zones = [...(d.zones ?? []), ...(d.floating ?? [])];
		const placed = zones.filter((z) => z.kind === 'worksheet').map((z) => sheets.get(z.worksheet)).filter(Boolean);
		return zones.some((z) => z.kind === 'filter' && z.worksheet && z.param && placed.some((w) => w.name !== z.worksheet && (w.filters ?? []).some((f) => f.pillId === z.param)));
	});
	const setFilters = (ir.worksheets ?? []).some((w) => (w.filters ?? []).some((f) => f.kind === 'categorical' && (f.all || f.include) && sets.has(`${f.datasourceId}\u0000${f.fieldId}`)));
	if (!shared && !peers && !setFilters) return [];
	const lost = [shared || peers ? "which sheets a dashboard filter applies to, so a filter shown for several sheets keeps a fixed copy on all but one and its selection stays on the cards instead of the view's default" : '', setFilters ? 'set filters that keep the set\'s members, which are dropped' : ''].filter(Boolean);
	return [
		{
			severity: 'info',
			code: 'convert.ir-outdated',
			message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read ${lost.join(', or ')}`,
			object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
			suggestion: 'Run t2d extract again for this workbook, then convert.'
		}
	];
}

/**
 * An ir.json from before IR version 2 has no actions, stories, containers or styles, so an app built from it silently has
 * no buttons, sections, story view, click actions or workbook theme. One with any of those fields is from the newer parser.
 * One from before version 3 has no worksheet colors, one from before version 4 no quick filter titles or pane colors, and
 * one from before version 5 no parameter control titles, one from before version 6 no mark label alignment or color,
 * one from before version 7 no secondary quick table calcs, one from before version 8 no column collations, one from
 * before version 9 no Hide filters, one from before version 10 no underlined headers, one from before version 12 cut
 * color maps at 200 members, one from before version 13 has no filter scope or members-of-set filters, and one from
 * before version 15 no worksheet window filter cards, one from before version 16 no table shading, and one from before
 * version 17 no fiscal year starts.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @returns {import('../model/types.js').Issue[]}
 */
export function outdatedIrIssues(ir, target) {
	const version = ir.irVersion ?? 1;
	if (version >= IR_VERSION) return [];
	const asApp = target === 'app';
	if (version >= 2 || ir.actions || ir.stories || ir.style || (ir.dashboards ?? []).some((d) => d.containers)) {
		if (version >= 3 || (ir.worksheets ?? []).some((w) => w.color || w.markColor)) {
			if (version >= 4 || (ir.worksheets ?? []).some((w) => w.filterTitles || (w.panes ?? []).some((pane) => pane.markColor || pane.boldLabels))) {
				const controls = (ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])]).filter((z) => z.kind === 'paramctrl');
				if (version >= 5 || !controls.length || controls.some((z) => z.title)) {
					const panes = (ir.worksheets ?? []).flatMap((w) => w.panes ?? []);
					if (version >= 6 || !panes.some((pane) => pane.showLabels) || panes.some((pane) => pane.labelAlign || pane.labelColor)) {
						const twoCalcs = (ir.worksheets ?? []).some((w) => Object.values(w.pills ?? {}).some((p) => String(p.tableCalc?.attrs?.prefix ?? '').includes(':') && !p.tableCalc.secondary));
						if (version >= 7 || !twoCalcs) {
							const textMatch = hasTextMatching(ir);
							if (version >= 8 || !(hasTextRanges(ir) || textMatch) || (ir.datasources ?? []).some((ds) => (ds.fields ?? []).some((f) => f.collation))) {
								const paneOnly = version < 9 && (ir.worksheets ?? []).some((w) => (w.filters ?? []).some((f) => f.kind === 'categorical' && (f.exclude ?? f.include)?.length && hiddenScope(w, f).scope === 'panes'));
								if (!paneOnly) {
									const fieldLinks = (ir.actions ?? []).some((a) => a.type === 'url' && (a.url?.tokens ?? []).some((t) => !(ir.parameters ?? []).some((p) => p.id === t)));
									if (!fieldLinks || (ir.worksheets ?? []).some((w) => w.linkStyled)) {
										const cut = version < 12 && (ir.worksheets ?? []).some((w) => w.color?.truncated && w.color.truncated <= MAX_COLOR_MEMBERS);
										if (!cut) {
											const unscoped = unscopedFilterIssues(ir, version);
											if (unscoped.length) return unscoped;
											const windowCards = windowCardIssues(ir, version);
											if (windowCards.length) return windowCards;
											const tableStyle = tableStyleIssues(ir, version, asApp);
											if (tableStyle.length) return tableStyle;
											const fiscal = fiscalStartIssues(ir, version);
											return fiscal.length ? fiscal : sideCardIssues(ir, version);
										}
										return [
											{
												severity: 'info',
												code: 'convert.ir-outdated',
												message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which kept only the first 200 members of a color map, so members past them (often the latest periods) take the chart palette's colors`,
												object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
												suggestion: 'Run t2d extract again for this workbook, then convert.'
											}
										];
									}
									return [
										{
											severity: 'info',
											code: 'convert.ir-outdated',
											message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read underlined headers, so a URL action's link column on a table is the token's own column or the first text column, not the one Tableau styles as a link`,
											object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
											suggestion: 'Run t2d extract again for this workbook, then convert.'
										}
									];
								}
								return [
									{
										severity: 'info',
										code: 'convert.ir-outdated',
										message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read Hide filters, so members a sheet hides in some panes only are filtered out of every pane`,
										object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
										suggestion: 'Run t2d extract again for this workbook, then convert.'
									}
								];
							}
							return [
								{
									severity: 'info',
									code: 'convert.ir-outdated',
									message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read column collations, so ${hasTextRanges(ir) ? 'a range of text members compares ignoring case even where Tableau compares case-sensitively' : 'CONTAINS, STARTSWITH, ENDSWITH, FIND and text comparisons stay case-sensitive even where Tableau ignores case'}`,
									object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
									suggestion: 'Run t2d extract again for this workbook, then convert.'
								}
							];
						}
						return [
							{
								severity: 'info',
								code: 'convert.ir-outdated',
								message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read the secondary calculation of a quick table calc, so a pill such as % of Total Running Sum shows only its first calculation`,
								object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
								suggestion: 'Run t2d extract again for this workbook, then convert.'
							}
						];
					}
					return [
						{
							severity: 'info',
							code: 'convert.ir-outdated',
							message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read mark label alignment and color, so stacked bar labels keep Domo's position and color`,
							object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
							suggestion: 'Run t2d extract again for this workbook, then convert.'
						}
					];
				}
				return [
					{
						severity: 'info',
						code: 'convert.ir-outdated',
						message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read parameter control titles, so a control Tableau shows under a custom title is named after its parameter`,
						object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
						suggestion: 'Run t2d extract again for this workbook, then convert.'
					}
				];
			}
			return [
				{
					severity: 'info',
					code: 'convert.ir-outdated',
					message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read quick filter titles, the mark color of each pane or bold labels, so filter cards show field names and stack totals are not labeled as Tableau's`,
					object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
					suggestion: 'Run t2d extract again for this workbook, then convert.'
				}
			];
		}
		return [
			{
				severity: 'info',
				code: 'convert.ir-outdated',
				message: `ir.json was extracted by an older t2d (IR version ${version}, now ${IR_VERSION}), which did not read the worksheets' colors, so the cards get no Tableau member or mark colors`,
				object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
				suggestion: 'Run t2d extract again for this workbook, then convert.'
			}
		];
	}
	return [
		{
			severity: asApp ? 'warning' : 'info',
			code: 'convert.ir-outdated',
			message: `ir.json was extracted by an older t2d (IR version ${ir.irVersion ?? 1}, now ${IR_VERSION}), which did not read actions, stories, show/hide containers or workbook formatting${asApp ? ', so the app gets none of the buttons, sections, story view, card click actions or workbook theme they would become' : ''}`,
			object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' },
			suggestion: 'Run t2d extract again for this workbook, then convert.'
		}
	];
}

/** Navigation icon per title word, first rule wins. A keyword ending in * matches words that start with it. */
const NAV_ICON_RULES = [
	['summary-number', ['summary', 'overview', 'executive', 'exec', 'kpi*', 'scorecard*', 'snapshot', 'highlight*', 'glance', 'dashboard']],
	['home', ['home', 'landing', 'welcome']],
	['gear', ['setting*', 'config*', 'admin*', 'parameter*', 'setup']],
	['table', ['table*', 'detail*', 'list', 'listing*', 'raw', 'record*', 'drill*', 'lookup', 'export*', 'transaction*']],
	['money-universal', ['financ*', 'revenue*', 'sales', 'profit*', 'margin*', 'cost*', 'arr', 'mrr', 'budget*', 'money', 'pric*', 'billing*', 'invoic*', 'expense*', 'spend*', 'payment*', 'cash', 'booking*', 'receivable*', 'payable*', 'ar', 'ap', 'pnl', 'income', 'aging', 'ageing']],
	['exclamation-triangle', ['escalat*', 'risk*', 'alert*', 'incident*', 'issue*', 'exception*', 'backlog*', 'overdue', 'defect*', 'error*']],
	['forecast', ['forecast*', 'projection*', 'outlook', 'predict*']],
	['chart-line', ['trend*', 'time', 'timeline*', 'history', 'historical', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'annual', 'yoy', 'mom', 'qoq', 'growth']],
	['funnel', ['funnel*', 'pipeline*', 'conversion*', 'lead', 'leads', 'opportunit*']],
	['globe', ['global', 'world*', 'international', 'country', 'countries', 'geo', 'geograph*']],
	['map-marker', ['map', 'maps', 'region*', 'state', 'states', 'territor*', 'location*', 'city', 'cities', 'site', 'sites', 'store', 'stores', 'zip']],
	['people', ['people', 'customer*', 'employee*', 'staff*', 'team', 'teams', 'hr', 'headcount', 'users', 'engineer*', 'agent', 'agents', 'workforce', 'account', 'accounts', 'client*', 'member*']],
	['person', ['user', 'person', 'profile', 'rep', 'reps', 'owner*']],
	['chat-bubbles', ['chat*', 'bot', 'support', 'feedback', 'survey*', 'nps', 'csat', 'conversation*', 'comment*']],
	['checked-list', ['case', 'cases', 'ticket*', 'task*', 'status', 'tracker', 'tracking', 'checklist*', 'complian*', 'audit*']],
	['gauge', ['performance', 'metric*', 'utiliz*', 'utilis*', 'capacity', 'efficien*', 'sla', 'slas', 'productivity', 'speed']],
	['goals', ['goal*', 'target*', 'okr*', 'quota*', 'objective*']],
	['trophy', ['ranking*', 'leaderboard*', 'top', 'winner*']],
	['chart-pie', ['share', 'mix', 'breakdown*', 'composition', 'distribution', 'segment*', 'split']],
	['chart-bar-vertical', ['comparison*', 'compare', 'waterfall*', 'bridge', 'variance*', 'benchmark*', 'versus', 'vs']],
	['tag', ['product*', 'categor*', 'inventor*', 'sku', 'skus', 'catalog*', 'item', 'items']],
	['building', ['compan*', 'organi*', 'department*', 'office*', 'vendor*', 'supplier*']],
	['handshake', ['partner*', 'deal', 'deals', 'contract*', 'renewal*', 'churn*', 'retention']],
	['pulse', ['activit*', 'health', 'monitor*', 'operation*', 'ops', 'usage', 'engagement']],
	['lightbulb', ['insight*', 'analysis', 'analyses', 'explor*', 'idea*']],
	['calendar', ['calendar*', 'date', 'dates', 'schedul*', 'week', 'month', 'quarter', 'year', 'fy', 'ytd', 'qtd', 'mtd']]
];
const DEFAULT_VIEW_ICON = 'analytics';
const STORY_ICON = 'presentation';
const WORKSHEETS_ICON = 'list-bulleted';

/** Lowercase words of a title, camelCase and acronym runs split ("CasesPerEngineer" -> cases per engineer). */
function titleWords(title) {
	return String(title ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * App Studio navigation icon for a view: a story view gets the presentation icon, the Worksheets view a list, a
 * dashboard the icon of the first keyword rule its title matches, else a generic chart.
 * @param {{ title?: string, story?: string, dashboard?: string }} view
 */
export function navIconFor(view) {
	if (view.story) return STORY_ICON;
	if (view.dashboard === '') return WORKSHEETS_ICON;
	const words = titleWords(view.title);
	const hit = (keyword) => (keyword.endsWith('*') ? words.some((w) => w.startsWith(keyword.slice(0, -1))) : words.includes(keyword));
	return NAV_ICON_RULES.find(([, keywords]) => keywords.some(hit))?.[0] ?? DEFAULT_VIEW_ICON;
}

/** A navigation icon per app view. */
function finishApp(app, pages) {
	if (!app) return app;
	for (const page of pages) if (page.appKey === app.key) page.navIcon = navIconFor(page);
	return app;
}

/** Plan key prefix for a workbook: its Tableau luid, or its name. */
export function workbookKeyFor(ir) {
	return slugify(ir.workbook?.luid || ir.workbook?.name);
}

/**
 * Convert a workbook IR plus extracted data manifests into a DomoPlan. Pure: no I/O.
 *
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {{ manifests?: import('../model/types.js').DataManifest[]|Record<string, import('../model/types.js').DataManifest>, mappings?: import('../model/types.js').Mappings, options?: import('../model/types.js').ConvertOptions, emitter?: import('../util/events.js').Emitter, irFile?: string, now?: Date, shared?: import('./beastmodes.js').SharedBeastModeContext, links?: import('./web-links.js').LinkContext }} [opts]
 *   `shared` carries the beast mode variants other workbooks planned on shared (published datasource) datasets; `links`
 *   the Tableau site and the other workbooks of the migration whose views web zones can show.
 * @returns {import('../model/types.js').DomoPlan}
 */
export function convertWorkbook(ir, { manifests = [], mappings = {}, options = {}, emitter, irFile = 'ir.json', now, shared, links } = {}) {
	const log = emitter ?? createEmitter(noopSink, 'convert');
	const resolved = resolveConvertOptions(options, ir);
	const workbookKey = workbookKeyFor(ir);
	const outdated = outdatedIrIssues(ir, resolved.target);
	for (const i of outdated) log.warn(i.message, { code: i.code });

	log.step('Planning datasets', { workbookKey });
	const published = resolved.unpublished ? { ir, issues: [] } : withoutUnpublishedSheets(ir);
	const cased = applyMemberCase(withoutHiddenZones(withDatePartFilterFields(withSheetViews(published.ir))), manifestIndex(manifests));
	const datasetPlan = planDatasets(cased.ir, manifests, { mappings, options: resolved, workbookKey });
	const blends = planBlends(cased.ir, datasetPlan, { options: resolved, workbookKey });
	const planned = { ...datasetPlan, datasets: blends.datasets, dataflows: blends.dataflows };
	log.info(`${planned.datasets.length} dataset(s), ${planned.dataflows.length} dataflow(s)`);

	log.step('Translating calculations');
	const periods = resolved.materialize === false ? { ir: blends.ir, issues: [] } : periodTopFilters(blends.ir);
	const modes = resolveParameterModes(periods.ir, planned.datasets, { options: resolved, workbookKey, shared });
	const { ir: calcIr, calcs, ...data } = materializeCalcs(modes.ir, planned, { options: resolved, workbookKey, shared });
	calcs.variables = calcs.variables.filter((v) => !modes.inline.has(v.parameter?.id));
	data.issues.push(...periods.issues, ...federatedDataflowIssues(data));
	const materialized = data.issues.filter((i) => i.code === 'calc.materialized').length;
	log.info(`${calcs.beastModes.length} beast mode(s), ${calcs.variables.length} variable(s)${materialized ? `, ${materialized} calc(s) computed in Magic ETL` : ''}`);

	log.step('Planning cards');
	const scopes = dashboardFilterScopes(calcIr);
	const cards = planCards(calcIr, calcs.bindings, { options: resolved, workbookKey, scopes, variables: calcs.variables });
	const stacks = resolved.materialize === false ? undefined : planCrosstabStacks(calcIr, cards.cards, { datasets: data.datasets, dataflows: data.dataflows, beastModes: calcs.beastModes }, { workbookKey, options: resolved });
	if (stacks?.cards.length) {
		cards.cards.push(...stacks.cards);
		log.info(`${stacks.cards.length} stacked crosstab(s) merged into one table each`);
	}

	log.step('Planning pages');
	const pages = planPages(calcIr, cards.cards, calcs.bindings, { options: resolved, workbookKey, variables: calcs.variables, inlineParameters: modes.inline, links, stacks: stacks?.placements });
	calcs.beastModes.push(...(pages.beastModes ?? []));
	pages.issues.push(...pageDefaultFilters(pages.pages, [...cards.cards, ...(pages.cards ?? [])], { beastModes: calcs.beastModes, scopes }));
	pages.issues.push(...applyDrillInteractions(pages.pages ?? [], cards.cards, calcIr));

	// A status sheet gets no chart card, so the issues of the card it would have had do not apply.
	const replacedByDescription = new Set(cards.cards.filter((c) => c.replacedBy === 'notebook').map((c) => c.worksheet));
	// A primary calc copied into a blend datasource reports the same issue twice.
	const seen = new Set();
	// Target 'app' converts actions and stories itself and reports them in layout.* issues.
	const asApp = resolved.target === 'app';
	const actionIds = new Set(asApp ? (ir.actions ?? []).filter((a) => a.type !== 'other').map((a) => a.id) : []);
	const storyNames = new Set(asApp ? (ir.stories ?? []).map((s) => s.name) : []);
	const converted = (i) => (i.object?.type === 'action' && actionIds.has(i.object.id)) || (i.code === 'twb.story' && storyNames.has(i.object?.name));
	const issues = [
		...outdated,
		...published.issues,
		...(blends.ir.issues ?? []).filter((i) => !converted(i)),
		...cased.issues,
		...planned.issues,
		...blends.issues,
		...modes.issues,
		...data.issues,
		...calcs.issues,
		...(cards.issues ?? []).filter((i) => !(i.object?.type === 'worksheet' && replacedByDescription.has(i.object.name))),
		...(stacks?.issues ?? []),
		...(pages.issues ?? [])
	].filter((i) => {
		const key = JSON.stringify(i);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const errors = issues.filter((i) => i.severity === 'error').length;
	if (errors) log.warn(`${errors} conversion error(s); see the report`, { errors });
	const app = finishApp(pages.app, pages.pages ?? []);

	const plan = {
		planVersion: PLAN_VERSION,
		source: { workbook: ir.workbook?.name, ...(ir.workbook?.luid ? { luid: ir.workbook.luid } : {}), irFile },
		generatedAt: (now ?? new Date()).toISOString(),
		options: resolved,
		datasets: data.datasets,
		dataflows: data.dataflows,
		beastModes: calcs.beastModes,
		variables: calcs.variables,
		cards: [...(cards.cards ?? []), ...(pages.cards ?? [])],
		pages: pages.pages ?? [],
		target: resolved.target,
		...(app ? { app } : {}),
		issues
	};
	plan.issues.push(...expandKnownSplits(plan));
	assignCalendarSources(plan.cards, plan.datasets);
	plan.issues.push(...planCalendarConflicts(plan));
	if (!resolved.allBeastModes) {
		const dropped = dropUnusedBeastModes(plan);
		if (dropped) log.info(`${dropped} beast mode(s) left out: nothing migrated uses them`);
	}
	if (resolved.warehouseDataflows !== false) plan.issues.push(...moveDataflowsToWarehouse(plan));
	if (resolved.combineDataflows !== false) plan.issues.push(...combineDataflows(plan, { workbookKey }));
	useGraphEditor(plan);
	plan.issues.push(...warehouseSafeSorts(plan));
	formatPlanSql(plan);
	log.done('Conversion planned', { datasets: plan.datasets.length, cards: plan.cards.length, pages: plan.pages.length, issues: issues.length });
	return plan;
}

/** Push never creates an unsupported beast mode, and the report lists them to rebuild, so they stay. */
function dropUnusedBeastModes(plan) {
	const used = usedBeastModes(plan);
	const unused = plan.beastModes.filter((bm) => bm.status !== 'unsupported' && !used.has(bm.key));
	if (!unused.length) return 0;
	const drop = new Set(unused.map((bm) => bm.key));
	plan.beastModes = plan.beastModes.filter((bm) => !drop.has(bm.key));
	for (const bm of unused) {
		plan.issues.push({
			severity: 'info',
			code: 'calc.unused',
			message: `No migrated card, filter, view or other calculation uses '${bm.name}', so its Beast Mode is not created`,
			object: { type: 'field', name: bm.name, id: bm.tableauFieldId || bm.legacyId },
			suggestion: 'Convert with --all-beast-modes to create every translated calculation.'
		});
	}
	return unused.length;
}

/** Magic ETL cannot read a federated DataSet (DataFlowsUI dfExcludedDsTypes), so a DataFlow planned over one fails. */
function federatedDataflowIssues({ datasets, dataflows }) {
	const federated = new Map(datasets.filter(isFederatedDataset).map((d) => [`dataset:${d.key}`, d]));
	if (!federated.size) return [];
	return dataflows.flatMap((df) => {
		const read = [...collectRefs(df.definition)].filter((r) => federated.has(r)).map((r) => federated.get(r).name);
		if (!read.length) return [];
		return [{ severity: 'error', code: 'data.federated-etl', message: `DataFlow "${df.name}" reads the federated DataSet(s) ${read.map((n) => `"${n}"`).join(', ')}, and Magic ETL cannot read federated DataSets, so it fails at push.`, object: { type: 'dataflow', name: df.name, id: df.key }, suggestion: 'Use the connector or a snapshot for this datasource instead of federated.' }];
	});
}
