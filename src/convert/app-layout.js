import { ref, collectRefs } from '../util/refs.js';
import { uuidv5 } from '../util/ids.js';
import { containerZones } from '../tableau/twb/dashboards.js';
import { APP_TEXT_LIMIT, COMPACT_WIDTH, HEADER_HEIGHT, MIN_CARD_HEIGHT, STANDARD_WIDTH, buildLayout, cardContent, compactHeight, dashboardPixels, detachButton, finishLayout, frameBounds, hasSmartDescription, scaleRect, stackCompact, tileWithButtons } from './layout.js';
import { MIN_NARROW_WIDTH, MIN_TILE_WIDTH, tile } from './tile.js';
import { withScheme } from './url-columns.js';
import { linkedViewNames, tableauViewHref } from './web-links.js';

/**
 * App Studio items for target 'app': BUTTON items, collapsible SECTIONs, TABS for
 * stories, card click actions and the workbook theme. Classic pages reject all of them, so nothing here runs for 'pages'.
 *
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').DashboardIR} DashboardIR
 * @typedef {import('../model/types.js').ZoneIR} ZoneIR
 * @typedef {import('../model/types.js').ActionIR} ActionIR
 * @typedef {import('../model/types.js').StoryIR} StoryIR
 * @typedef {import('../model/types.js').CardPlan} CardPlan
 * @typedef {import('../model/types.js').LayoutPlan} LayoutPlan
 * @typedef {import('../model/types.js').Issue} Issue
 * @typedef {import('./layout.js').Box} Box
 *
 * @typedef {Object} AppContext
 * @property {Map<string, string>} dashboardKeys   Dashboard name -> view key
 * @property {Map<string, string>} storyKeys       Story name -> view key
 * @property {Map<string, CardPlan>} cardsBySheet
 * @property {import('../model/types.js').VariablePlan[]} variables  Parameters that are Domo variables
 * @property {WorkbookIR} ir
 * @property {ActionLog} actions
 *
 * @typedef {Map<string, { action: ActionIR, views: Set<string>, notes: Set<string>, lost: Map<string, string> }>} ActionLog
 *   Per action id: views it runs on, approximations, and cards where another action took the click (card -> kept action)
 */

export const SECTION_BAR_HEIGHT = 5;
export const COMPACT_SECTION_BAR_HEIGHT = 2;
export const BUTTON_HEIGHT = 3;
export const MIN_BUTTON_WIDTH = 8;
export const MAX_URL = 2000;
export const MAX_LINK_NAME = 100;
export const STORY_TAB_LABEL = 60;
export const FILTER_SECTION_TITLE = 'Filters';
const TRIGGER_RANK = { select: 0, menu: 1, hover: 2 };
const KIND_RANK = { navigate: 0, 'filter-link': 1, url: 2, parameter: 3, filter: 4, 'url-partial': 5 };
// A link cut at a field token opens the same page for every mark, so any other action wins the click over it.
const clickOrder = (a, b) => (a.kind === 'url-partial') - (b.kind === 'url-partial') || a.rank - b.rank || KIND_RANK[a.kind] - KIND_RANK[b.kind];
export const THEME_FAMILIES = ['Sans', 'Serif', 'Slab', 'Condensed', 'Monospace'];

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text);

function issue(object, severity, code, message, suggestion) {
	const out = { severity, code, message, object };
	if (suggestion) out.suggestion = suggestion;
	return out;
}
const dashObject = (dash) => ({ type: 'dashboard', name: dash.name });

/** DOMOLINK to another view of the same app; `url` must be exactly /app-studio/<app>/pages/<view>.
 * `interactionFilters`: "Enable interaction filters", KPI cards only: the clicked values filter. */
export function viewLink(pageKey, { interactionFilters = false } = {}) {
	return {
		type: 'DOMOLINK',
		config: {
			entityType: 'page',
			entityId: ref('page', pageKey, 'idString'),
			url: ref('page', pageKey, 'appUrl'),
			displayMode: 'APP_NAVIGATION',
			openInNewWindow: false,
			persistFilters: true,
			allowCardToCardInteractions: interactionFilters,
			selectedCardUrns: [],
			selectIndividualCards: false,
			mobileOpenScanner: false,
			columns: [],
			displayName: ''
		}
	};
}

/** DOMOLINK that opens a card in a modal (a Tableau target worksheet, which has no view of its own). */
export function cardLink(cardKey) {
	return {
		type: 'DOMOLINK',
		config: {
			entityType: 'card',
			entityId: ref('card', cardKey, 'idString'),
			url: ref('card', cardKey, 'detailsUrl'),
			displayMode: 'PRESENTATION',
			openInNewWindow: false,
			persistFilters: true,
			allowCardToCardInteractions: false,
			selectedCardUrns: [],
			mobileOpenScanner: false,
			columns: [],
			displayName: ''
		}
	};
}

/**
 * The link a navigation button or Go to Sheet action opens: a dashboard or story view, or the card of a worksheet.
 * @param {{ name?: string, kind?: string }|undefined} target
 * @param {AppContext} ctx
 */
export function linkTo(target, ctx, linkOptions) {
	if (!target?.name) return undefined;
	if (target.kind === 'dashboard' && ctx.dashboardKeys.has(target.name)) return viewLink(ctx.dashboardKeys.get(target.name), linkOptions);
	if (target.kind === 'story' && ctx.storyKeys.has(target.name)) return viewLink(ctx.storyKeys.get(target.name), linkOptions);
	const card = target.kind === 'worksheet' ? ctx.cardsBySheet.get(target.name) : undefined;
	if (card && card.status !== 'unsupported') return cardLink(card.key);
	return undefined;
}

/**
 * BUTTON content item for a Tableau navigation button zone. Image and icon buttons become text buttons (App Studio
 * buttons have no image); download buttons have no equivalent.
 * @param {ZoneIR} zone
 * @param {AppContext} ctx
 * @returns {{ item?: (contentKey: number) => Object, issues: Issue[] }}
 */
export function navigationButton(zone, dash, ctx) {
	const button = zone.button;
	const object = dashObject(dash);
	if (button?.action === 'download') {
		return { issues: [issue(object, 'warning', 'layout.button-download', `Download button${button.exportFormat ? ` (${button.exportFormat})` : ''} has no App Studio equivalent; left out`, 'Viewers can export a view to PDF from the app navigation.')] };
	}
	if (button?.action !== 'navigate') {
		return { issues: button?.action === 'toggle' ? [] : [issue(object, 'info', 'layout.button-unsupported', `Button zone ${zone.id} has no action t2d can convert; left out`)] };
	}
	const name = button.target?.name;
	const interaction = linkTo(button.target, ctx);
	if (!interaction) {
		const why = name ? `"${name}", which has no view or card in the app` : 'a sheet that no longer exists in the workbook';
		return { issues: [issue(object, 'warning', 'layout.button-target-missing', `Navigation button ${button.states?.[0]?.caption ? `"${button.states[0].caption}" ` : ''}points to ${why}; left out`)] };
	}
	const caption = String(button.states?.[0]?.caption ?? '').replace(/\s+/g, ' ').trim();
	const text = cut(caption || name, APP_TEXT_LIMIT);
	const issues = [];
	if (!caption) issues.push(issue(object, 'info', 'layout.button-image', `${button.style === 'image' ? 'Image' : 'Icon'} button to "${name}" became a text button labeled "${text}" (App Studio buttons have no image)`));
	return { item: (contentKey) => ({ contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction }), issues };
}

export function tableauViewLink(name, workbook, url) {
	const words = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
	const text = cut(`Open ${words(name)} in Tableau${words(workbook) ? ` (${words(workbook)})` : ''}`, APP_TEXT_LIMIT);
	return { text, interaction: { type: 'WEBLINK', config: { url, openInNewWindow: true, displayName: cut(text, MAX_LINK_NAME) } } };
}

/**
 * BUTTON for a web zone that shows a Tableau view (web-links.js resolveWebUrl): to the view in this app, to the view of
 * another workbook of the migration as an https WEBLINK whose address push fills in (a DOMOLINK cannot target a view of
 * another app), or else to the view on Tableau, so the view is never empty.
 * @param {ReturnType<typeof import('./web-links.js').resolveWebUrl>} link
 * @param {ZoneIR} zone
 * @param {AppContext} [ctx]  Undefined for classic pages, which hold no buttons
 * @param {WorkbookIR} [ir]
 * @returns {{ item?: (contentKey: number) => Object, issues: Issue[], link?: Object }}  `link`: recorded on the page (PagePlan.webLinks)
 */
export function webViewButton(link, zone, dash, ctx, ir) {
	const object = dashObject(dash);
	const url = cut(String(zone.url ?? ''), 200);
	const { view } = link;
	const tableauUrl = tableauViewHref(view);
	const record = { url: zone.url, workbook: view.workbook, sheet: view.sheet, status: link.kind, tableauUrl };
	const code = link.kind === 'self' ? 'layout.web-view' : `layout.web-view-${link.kind}`;
	const toTableau = (names, why, suggestion) => {
		const shown = `the view "${names.name}" of the Tableau workbook "${names.workbook}" (${url})`;
		if (!ctx) return { issues: [issue(object, 'warning', code, `Web page zone shows ${shown}, ${why}; left out: classic pages have no buttons`, suggestion)], link: record };
		const { text, interaction } = tableauViewLink(names.name, names.workbook, tableauUrl);
		const https = /^\s*http:/i.test(String(zone.url)) ? ' (its http address was changed to https: App Studio links must be https)' : '';
		return {
			item: (contentKey) => ({ contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction }),
			issues: [issue(object, 'warning', code, `Web page zone shows ${shown}, ${why}; it became a button that opens it on Tableau${https}`, suggestion)],
			link: { ...record, title: names.name, name: names.workbook }
		};
	};
	if (link.kind === 'unresolved') {
		const names = linkedViewNames(undefined, view);
		if (ir?.workbook?.name && String(ir.workbook.contentUrl ?? '').toLowerCase() === view.workbook.toLowerCase()) names.workbook = ir.workbook.name;
		return toTableau(names, `which is not converted: ${link.why}`);
	}
	if (link.kind === 'outside') {
		const names = linkedViewNames(ir, view);
		return toTableau(names, 'which is not part of this migration', `Migrate "${names.workbook}" into this workspace too, then convert and push this workbook again: the button then opens its view in that workbook's app.`);
	}
	const name = String(link.target.name).replace(/\s+/g, ' ').trim();
	if (!ctx) return { issues: [issue(object, 'warning', 'layout.web-view', `Web page zone shows the Tableau view "${name}" (${url}); left out: classic pages have no buttons`, 'Convert with --target app to get a button that opens it.')], link: record };
	if (link.kind === 'self') {
		const interaction = linkTo(link.target, ctx);
		if (!interaction) return toTableau({ name, workbook: ir?.workbook?.name ?? view.workbook }, 'a sheet of this workbook that has no view or card in the app');
		const text = cut(`Open ${name}`, APP_TEXT_LIMIT);
		return { item: (contentKey) => ({ contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction }), issues: [issue(object, 'info', 'layout.web-view', `Web page zone shows "${name}" of this workbook; it became a button that opens it`)], link: record };
	}
	const workbook = link.workbook;
	const text = cut(`Open ${name}${workbook.title ? ` (${workbook.title})` : ''}`, APP_TEXT_LIMIT);
	const kind = link.target.kind === 'worksheet' ? 'card' : 'page';
	const interaction = { type: 'WEBLINK', config: { url: ref(kind, link.target.key, 'webUrl'), openInNewWindow: false, displayName: cut(text, MAX_LINK_NAME) } };
	const opens = kind === 'card' ? 'its card' : workbook.target === 'app' ? 'its view in that workbook\'s app' : 'its page';
	return {
		item: (contentKey) => ({ contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction }),
		issues: [issue(object, 'info', 'layout.web-view', `Web page zone shows "${name}" of the workbook "${workbook.name}", which this migration also converts; it became a button that opens ${opens} (push fills in its address once "${workbook.name}" is pushed; until then it opens the view on Tableau)`)],
		link: { ...record, title: name, target: `${kind}:${link.target.key}`, slug: workbook.slug, name: workbook.name }
	};
}

/**
 * BUTTON for a web zone that shows a page other than a Tableau view: App Studio has no web page item, so a button opens it
 * in a new tab. Undefined for a url that is not http(s).
 */
export function webPageButton(zone, dash) {
	let parsed;
	try {
		parsed = new URL(String(zone.url ?? '').trim());
	} catch {
		return undefined;
	}
	if (!/^https?:$/.test(parsed.protocol) || !parsed.host) return undefined;
	const https = parsed.protocol === 'http:';
	if (https) parsed.protocol = 'https:';
	const url = parsed.href;
	if (url.length > MAX_URL) return undefined;
	const text = cut(`Open ${parsed.host}`, APP_TEXT_LIMIT);
	const interaction = { type: 'WEBLINK', config: { url, openInNewWindow: true, displayName: cut(text, MAX_LINK_NAME) } };
	return {
		item: (contentKey) => ({ contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction }),
		issues: [issue(dashObject(dash), 'warning', 'layout.web-page', `Web page zone shows ${cut(url, 200)}, which App Studio cannot embed; it became a button that opens it in a new tab${https ? ' (its http address was changed to https: App Studio links must be https)' : ''}`)]
	};
}

/** Box for a BUTTON: its zone, at least BUTTON_HEIGHT high and MIN_BUTTON_WIDTH wide. */
export function buttonBox(zone, px) {
	const box = scaleRect(zone.rect, px, { minHeight: BUTTON_HEIGHT });
	box.width = Math.min(STANDARD_WIDTH, Math.max(box.width, MIN_BUTTON_WIDTH));
	box.x = Math.min(box.x, STANDARD_WIDTH - box.width);
	return box;
}

/**
 * Collapsible sections for a dashboard's show/hide buttons: each wraps the zones its button toggles (a container's
 * leaves, or single zones). A section inside another one is merged into the outer one.
 * @param {DashboardIR} dash
 * @returns {{ sections: { id: string, button: ZoneIR, title: string, shown: boolean, members: Set<string> }[], issues: Issue[] }}
 */
export function toggleSections(dash) {
	const containers = new Map((dash.containers ?? []).map((c) => [c.id, c]));
	const leaves = new Map([...(dash.zones ?? []), ...(dash.floating ?? [])].map((z) => [z.id, z]));
	const issues = [];
	const found = [];
	for (const zone of leaves.values()) {
		if (zone.button?.action !== 'toggle') continue;
		const ids = (zone.button.toggle?.zoneIds ?? []).filter((id) => containers.has(id) || leaves.has(id));
		const members = new Set(ids.flatMap((id) => (containers.has(id) ? containerZones(dash, id).map((z) => z.id) : [id])));
		members.delete(zone.id);
		if (!members.size) {
			issues.push(issue(dashObject(dash), 'warning', 'layout.section-target-missing', `Show/hide button ${zone.id} toggles nothing that exists on the dashboard; left out`));
			continue;
		}
		const named = ids.map((id) => containers.get(id)?.name).find(Boolean);
		const first = [...members].map((id) => leaves.get(id)).find((z) => z?.kind === 'worksheet' || (z?.text && z.kind === 'text'));
		const title = String(named || first?.worksheet || String(first?.text ?? '').split('\n')[0]).replace(/\s+/g, ' ').trim() || 'Details';
		found.push({ id: zone.id, button: zone, title: cut(title, APP_TEXT_LIMIT), shown: zone.button.toggle?.shown !== false, members });
	}
	found.sort((a, b) => b.members.size - a.members.size);
	const claimed = new Map();
	const sections = [];
	for (const s of found) {
		const outer = [...s.members].map((id) => claimed.get(id)).find(Boolean);
		const own = new Set([...s.members].filter((id) => !claimed.has(id)));
		if (outer) {
			issues.push(issue(dashObject(dash), 'warning', 'layout.section-nested', `Show/hide section "${s.title}" is inside section "${outer.title}"; App Studio sections do not nest, so ${own.size ? 'only its other items form a section' : 'it is merged into the outer one'}`));
		}
		if (!own.size) continue;
		const section = { ...s, members: own };
		for (const id of own) claimed.set(id, section);
		sections.push(section);
	}
	return { sections, issues };
}

/**
 * Tile items inside a section or tab pane (no barriers: the editor drops no HEADER, TABS or section into a pane). Sets
 * the item boxes, relative to the pane, and returns the pane height.
 * @param {Object[]} children  Entries with `placed.frame` and a natural `placed.box.height`
 */
export function tilePane(children) {
	const toItem = (c) => ({ entry: c, frame: c.placed.frame ?? { x: c.placed.box.x, y: c.placed.box.y, w: c.placed.box.width, h: c.placed.box.height }, minWidth: c.placed.minWidth ?? (c.placed.type === 'BUTTON' ? MIN_NARROW_WIDTH : MIN_TILE_WIDTH) });
	return tileWithButtons(children, toItem, (items) => tile(items, STANDARD_WIDTH, { barriers: false })).height;
}

/**
 * Wrap section members into full-width TABS groups (bar on top, members tiled in the pane). Headers and banner rows stay
 * out of sections (the editor allows no header in a pane); text cards go in. Returns the top-level entries with each group placed where its members were, and
 * the sections that got members.
 * @param {Object[]} entries  planDashboard entries ({ content, placed, floating, zoneId })
 * @param {ReturnType<typeof toggleSections>['sections']} sections
 * @param {string} pageKey
 * @param {() => number} nextKey
 */
export function groupSections(entries, sections, pageKey, nextKey) {
	const sectionOf = new Map();
	for (const s of sections) for (const id of s.members) sectionOf.set(id, s);
	const members = new Map();
	const withText = new Set();
	for (const e of entries) {
		const s = e.zoneId !== undefined ? sectionOf.get(e.zoneId) : undefined;
		if (!s) continue;
		if (e.placed.type === 'HEADER' || e.placed.banner) {
			withText.add(s);
			continue;
		}
		if (!members.has(s)) members.set(s, []);
		members.get(s).push(e);
	}
	const sectionOfEntry = new Map([...members].flatMap(([s, list]) => list.map((e) => [e, s])));
	for (const e of entries) if (e.host && sectionOfEntry.get(e) !== sectionOfEntry.get(e.host)) detachButton(e);
	const groups = new Map();
	for (const [s, list] of members) {
		const frame = frameBounds(list.map((e) => e.placed.frame));
		const height = tilePane(list);
		const tabsKey = nextKey();
		const barKey = nextKey();
		const paneKey = nextKey();
		groups.set(list[0], {
			group: {
				tabs: { contentKey: tabsKey, type: 'TABS', tabType: 'SECTION', itemId: uuidv5(`section|${pageKey}|${s.id}`), collapsible: true, hideTitle: false },
				barKey,
				panes: [{ content: { contentKey: paneKey, type: 'TAB_CONTENT', text: s.title }, children: list, height }]
			},
			placed: { contentKey: tabsKey, type: 'TABS', box: { x: 0, y: 0, width: STANDARD_WIDTH, height: height + SECTION_BAR_HEIGHT }, frame, order: list[0].placed.order },
			floating: list[0].floating
		});
	}
	const grouped = new Set([...members.values()].flat());
	return { entries: entries.flatMap((e) => (groups.has(e) ? [groups.get(e)] : grouped.has(e) ? [] : [e])), formed: new Set(members.keys()), withText };
}

/**
 * A collapsible "Filters" section holding packed controls (boxes already relative to the pane), at `box`.
 * @returns {Object} A group entry like groupSections'
 */
export function filterSection(controls, pageKey, nextKey, box, order, floating) {
	const tabsKey = nextKey();
	const barKey = nextKey();
	const paneKey = nextKey();
	return {
		group: {
			tabs: { contentKey: tabsKey, type: 'TABS', tabType: 'SECTION', itemId: uuidv5(`filters|${pageKey}`), collapsible: true, hideTitle: false },
			barKey,
			panes: [{ content: { contentKey: paneKey, type: 'TAB_CONTENT', text: FILTER_SECTION_TITLE }, children: controls, height: box.height - SECTION_BAR_HEIGHT }]
		},
		placed: { contentKey: tabsKey, type: 'TABS', box, order, control: 'panel' },
		floating
	};
}

/**
 * A title row on its Tableau fill: a section without a bar (`hideTitle`, 0 rows, so the pane fills it unstretched) holding
 * the title lines and the logo (boxes relative to the pane). Push points it at a theme section style of `fill`.
 */
export function titleBand(lines, logo, fill, pageKey, nextKey) {
	const tabsKey = nextKey();
	const barKey = nextKey();
	const paneKey = nextKey();
	const children = [...lines, logo];
	const height = Math.max(...children.map((c) => c.placed.box.y + c.placed.box.height));
	const text = cut(lines.map((l) => l.content.text).join(' '), APP_TEXT_LIMIT);
	return {
		group: {
			tabs: { contentKey: tabsKey, type: 'TABS', tabType: 'SECTION', itemId: uuidv5(`title-band|${pageKey}|${logo.zoneId}`), collapsible: false, hideTitle: true, sectionFill: fill },
			barKey,
			bar: 0,
			panes: [{ content: { contentKey: paneKey, type: 'TAB_CONTENT', text }, children, height }]
		},
		placed: { contentKey: tabsKey, type: 'TABS' }
	};
}

/**
 * A dashboard header (header.js): a section without a bar, as titleBand, holding the band's items (boxes relative to the
 * pane, `height` rows). Push points it at a theme section style of `fill`, or gives it `image` (an image card key) as its
 * background.
 */
export function headerBand(children, { fill, image }, height, pageKey, bandId, nextKey) {
	const tabsKey = nextKey();
	const barKey = nextKey();
	const paneKey = nextKey();
	return {
		group: {
			tabs: { contentKey: tabsKey, type: 'TABS', tabType: 'SECTION', itemId: uuidv5(`header|${pageKey}|${bandId}`), collapsible: false, hideTitle: true, ...(fill ? { sectionFill: fill } : {}), ...(image ? { sectionImage: image } : {}) },
			barKey,
			bar: 0,
			panes: [{ content: { contentKey: paneKey, type: 'TAB_CONTENT', text: 'Header' }, children, height }]
		},
		placed: { contentKey: tabsKey, type: 'TABS' }
	};
}

/**
 * One issue per show/hide button: the section it became (sections always start expanded), or why it has none; and one
 * for header text it toggles, which stays outside the section.
 * @param {Set<Object>} [withText]  Sections whose members included text
 */
export function sectionIssues(dash, sections, formed, withText = new Set()) {
	const object = dashObject(dash);
	return sections.flatMap((s) => {
		const name = s.button.button?.states?.[0]?.caption ? `"${s.button.button.states[0].caption}"` : s.button.id;
		const text = withText.has(s) ? [issue(object, 'info', 'layout.section-text', `Title text that show/hide button ${name} toggles stays a header above ${formed.has(s) ? 'its section' : 'the view items'}: App Studio sections hold no headers`)] : [];
		if (!formed.has(s)) return text.length ? text : [issue(object, 'info', 'layout.section-empty', `Show/hide button ${name} toggles nothing that converts to an app item; left out`)];
		return [...text, sectionIssue(object, s, name)];
	});
}

function sectionIssue(object, s, name) {
	if (!s.shown) {
		return issue(object, 'warning', 'layout.section-expanded', `Show/hide button ${name} became the collapsible section "${s.title}", which starts expanded: Tableau starts it hidden, and App Studio keeps a collapsed state per user only`, 'Collapse the section once in Domo; each viewer\'s choice is remembered for that viewer.');
	}
	return issue(object, 'info', 'layout.section', `Show/hide button ${name} became the collapsible section "${s.title}" (the button itself is left out)`);
}

function templateItem(contentKey, type, box, children) {
	const out = { contentKey, x: box.x, y: box.y, width: box.width, height: box.height, type, virtual: false, virtualAppendix: false };
	if (children) out.children = children;
	return out;
}

const placedOf = (e) => e.placed;

const compactBar = (e) => (e.group.bar === 0 ? 0 : COMPACT_SECTION_BAR_HEIGHT);

/** Panes of a group stacked for the compact template, with the group's height. */
function compactPanes(e) {
	const panes = e.group.panes.map((pane) => {
		const { boxes, height } = stackCompact(pane.children, placedOf, (c) => compactHeight(c.placed));
		return { pane, children: boxes.map(([c, box]) => templateItem(c.placed.contentKey, c.placed.type, box, [])), height };
	});
	const paneHeight = Math.max(0, ...panes.map((p) => p.height));
	return { panes, paneHeight, height: compactBar(e) + paneHeight };
}

/** Compact template entries in phone order (layout.js compactOrder), groups with their children stacked inside each pane. */
function compactItems(entries) {
	const stacked = new Map(entries.filter((e) => e.group).map((e) => [e, compactPanes(e)]));
	const { boxes } = stackCompact(entries, placedOf, (e) => (e.group ? stacked.get(e).height : compactHeight(e.placed)));
	return boxes.map(([e, box]) => {
		if (!e.group) return templateItem(e.placed.contentKey, e.placed.type, box);
		const { panes, paneHeight } = stacked.get(e);
		return templateItem(e.placed.contentKey, 'TABS', box, [
			templateItem(e.group.barKey, 'TAB_BAR', { x: 0, y: 0, width: COMPACT_WIDTH, height: compactBar(e) }, []),
			...panes.map((p) => templateItem(p.pane.content.contentKey, 'TAB_CONTENT', { x: 0, y: compactBar(e), width: COMPACT_WIDTH, height: paneHeight }, p.children))
		]);
	});
}

/**
 * LayoutPlan for an app view. Entries are buildLayout's, plus groups `{ group: { tabs, barKey, panes: [{ content,
 * children, height }] }, placed }` that become TABS > [TAB_BAR, TAB_CONTENT > children] (children relative to the pane;
 * every pane sits under the bar). TAB_BAR is a template entry only. Layouts without groups or buttons are buildLayout's.
 * @returns {LayoutPlan}
 */
export function buildAppLayout(entries) {
	if (!entries.some((e) => e.group || e.placed.type === 'BUTTON')) return buildLayout(entries);
	const content = entries.flatMap((e) => (e.group ? [e.group.tabs, ...e.group.panes.flatMap((p) => [p.content, ...p.children.map((c) => c.content)])] : [e.content]));
	const standard = entries.map((e) => {
		if (!e.group) return templateItem(e.placed.contentKey, e.placed.type, e.placed.box);
		const { box } = e.placed;
		const bar = e.group.bar ?? SECTION_BAR_HEIGHT;
		const paneHeight = box.height - bar;
		return templateItem(e.placed.contentKey, 'TABS', box, [
			templateItem(e.group.barKey, 'TAB_BAR', { x: 0, y: 0, width: box.width, height: bar }, []),
			...e.group.panes.map((p) =>
				templateItem(p.content.contentKey, 'TAB_CONTENT', { x: 0, y: bar, width: box.width, height: paneHeight }, p.children.map((c) => templateItem(c.placed.contentKey, c.placed.type, c.placed.box, [])))
			)
		]);
	});
	return finishLayout(content, standard, compactItems(entries));
}

/* Card click actions */

/** Worksheet names on the dashboard an action fires from. */
export function actionSources(action, dash, ir, sheetsOnDash) {
	const src = action.source ?? {};
	if (src.dashboard && src.dashboard !== dash.name) return [];
	let names;
	if (src.type === 'datasource') {
		names = (ir.worksheets ?? []).filter((w) => (w.datasourceIds ?? []).includes(src.datasource)).map((w) => w.name);
	} else if (src.type === 'all') {
		names = [...sheetsOnDash];
	} else {
		names = src.worksheets ?? (src.worksheet ? [src.worksheet] : []);
	}
	const exclude = new Set(src.excludeSheets ?? []);
	return names.filter((n) => sheetsOnDash.has(n) && !exclude.has(n));
}

/**
 * Parameter tokens filled with the parameter's current value; other field tokens cut the url there. A template that starts
 * with a host and no scheme gets `https://` (`schemeAdded`; Tableau opens it as http).
 */
export function staticUrl(action, ir) {
	const { template, schemeAdded } = withScheme(action.url?.template);
	const params = new Map((ir?.parameters ?? []).map((pm) => [pm.id, pm]));
	let fieldToken = false;
	let out = '';
	for (const part of template.split(/(<[^<>]+>)/)) {
		const token = /^<([^<>]+)>$/.exec(part)?.[1];
		if (token === undefined) {
			out += part;
			continue;
		}
		const value = params.get(token)?.value;
		if (value === undefined || value === null || typeof value === 'object') {
			fieldToken = true;
			break;
		}
		out += String(value);
	}
	const pathToken = fieldToken && !out.includes('?');
	if (fieldToken && !pathToken) out = out.split('?')[0];
	else if (fieldToken) {
		const host = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(out)?.[0] ?? '';
		if (out.length > host.length) out = out.slice(0, out.lastIndexOf('/') + 1);
	}
	return { url: out, fieldToken, ...(pathToken ? { pathToken } : {}), ...(schemeAdded ? { schemeAdded } : {}) };
}

/**
 * WEBLINK for a URL action: https only (anything else fails the whole layout PUT), field tokens dropped because
 * App Studio stores them as literal text.
 * @returns {{ interaction?: Object, note?: string, dropped?: string, fieldToken?: boolean, pathToken?: boolean }}
 */
export function urlInteraction(action, ir) {
	const { url: built, fieldToken, pathToken, schemeAdded } = staticUrl(action, ir);
	let url = built;
	const notes = [];
	if (fieldToken) notes.push(`field values in the link are not passed (App Studio keeps no tokens), so it opens ${url || 'nothing'}`);
	if (schemeAdded) notes.push('the link has no scheme, so https:// was added (Tableau opens it as http)');
	if (/^http:\/\//i.test(url)) {
		url = `https://${url.slice(7)}`;
		notes.push('http was changed to https (App Studio accepts only https links)');
	}
	if (!/^https:\/\/[^/?#\s<>]+/i.test(url)) {
		const scheme = action.url?.scheme || (schemeAdded ? 'https' : '');
		return { dropped: !scheme ? 'the link starts with a field value' : scheme !== 'https' && scheme !== 'http' ? `${scheme}: links are not allowed (https only)` : 'nothing static is left once the field values are removed', fieldToken };
	}
	if (url.length > MAX_URL) return { dropped: `the link is longer than ${MAX_URL} characters`, fieldToken };
	const displayName = cut(String(action.menuCaption || action.name || '').replace(/<[^<>]+>/g, '').replace(/\s+/g, ' ').replace(/[\s:|-]+$/, '').trim(), MAX_LINK_NAME);
	return { interaction: { type: 'WEBLINK', config: { url, openInNewWindow: true, displayName } }, note: notes.join('; ') || undefined, fieldToken, ...(pathToken ? { pathToken } : {}) };
}

function logAction(ctx, action) {
	if (!ctx.actions.has(action.id)) ctx.actions.set(action.id, { action, views: new Set(), notes: new Set(), lost: new Map() });
	return ctx.actions.get(action.id);
}

/**
 * One click candidate per action and source card: `filter` (same view, `targets` = sheets it filters), or an
 * interaction (`navigate`, `filter-link`, `url`, `parameter`). Undefined when the action has no click mapping.
 */
function candidate(action, dash, sheet, sheetsOnDash, ctx) {
	const log = logAction(ctx, action);
	const base = { action, rank: TRIGGER_RANK[action.trigger] ?? 1 };
	if (action.type === 'filter') {
		const target = action.target ?? {};
		const sameView = target.kind === 'dashboard' ? target.name === dash.name : target.kind === 'worksheet' && sheetsOnDash.has(target.name);
		const filterNotes = () => {
			if (!action.allFields && (action.fields?.length || action.fieldCaptions?.length)) log.notes.add('Domo filters on every clicked column, not only the action\'s fields');
			if (action.clear === 'exclude-all') log.notes.add('clearing the selection shows all values (Tableau excludes all)');
			if (action.clear === 'keep') log.notes.add('clearing the selection shows all values (Tableau keeps the filter)');
		};
		if (sameView) {
			const targets = (target.kind === 'dashboard' ? target.worksheets ?? [...sheetsOnDash] : [target.name]).filter((s) => s !== sheet && sheetsOnDash.has(s));
			filterNotes();
			log.mapped = true;
			return { ...base, kind: 'filter', targets };
		}
		const card = ctx.cardsBySheet.get(sheet);
		const kpi = Boolean(card) && card.kind !== 'notebook' && card.chartType !== 'notebook';
		const interaction = target.kind === 'dashboard' ? linkTo(target, ctx, { interactionFilters: kpi }) : undefined;
		if (!interaction) {
			log.notes.add(target.name && target.name !== 'None' ? `its target "${target.name}" is not a view of the app${target.kind === 'worksheet' ? ' (a worksheet not on this dashboard)' : ''}` : 'it has no target');
			return undefined;
		}
		log.mapped = true;
		if (kpi) {
			filterNotes();
			log.notes.add('the clicked values also filter the cards of the view it starts on (Tableau filters only the target)');
		} else log.linkWithoutValues = true;
		return { ...base, kind: 'filter-link', interaction };
	}
	if (action.type === 'navigate') {
		if (action.target?.name === dash.name) {
			log.notes.add('it opens the dashboard it starts on');
			return undefined;
		}
		const interaction = linkTo(action.target, ctx);
		if (!interaction) {
			log.notes.add(action.target?.name && action.target.name !== 'None' ? `its target "${action.target.name}" has no view or card in the app` : 'it has no target sheet');
			return undefined;
		}
		log.mapped = true;
		if (action.target.kind === 'worksheet') log.notes.add(`the worksheet "${action.target.name}" opens as a card in a window`);
		return { ...base, kind: 'navigate', interaction };
	}
	if (action.type === 'url') {
		const column = ctx.cardsBySheet.get(sheet)?.urlColumns?.find((u) => u.actionId === action.id);
		if (column) {
			(log.columns ??= new Map()).set(sheet, column.column);
			return undefined;
		}
		const { interaction, note, dropped, fieldToken, pathToken } = urlInteraction(action, ctx.ir);
		if (dropped) {
			log.dropped = dropped;
			return undefined;
		}
		if (fieldToken && action.trigger !== 'select') {
			log.dropped = `its link needs the clicked mark's field values, which App Studio cannot pass, and a static link on a ${action.trigger === 'hover' ? 'hover' : 'tooltip menu'} action would replace the card's click filtering`;
			return undefined;
		}
		if (pathToken) {
			log.dropped = `its link puts the clicked mark's field values in the page path, which App Studio cannot pass, and ${interaction.config.url} opens another page`;
			return undefined;
		}
		log.mapped = true;
		if (note) log.notes.add(note);
		return { ...base, kind: fieldToken ? 'url-partial' : 'url', interaction };
	}
	if (action.type === 'parameter') {
		const variable = ctx.variables.find((v) => v.parameter?.id === action.parameter?.target);
		if (!variable) {
			log.notes.add(`its parameter ${action.parameter?.target ?? ''} is not a Domo variable (inlined as a constant)`);
			return undefined;
		}
		log.mapped = true;
		log.notes.add(`a click sets variable "${variable.name}" from the clicked mark; Domo picks the column (Tableau uses ${action.parameter.sourceField || 'its source field'})${action.parameter.clear ? ', and clearing the selection does not reset it' : ''}`);
		return { ...base, kind: 'parameter', interaction: { type: 'VARIABLE', config: { variableId: ref('variable', variable.key) } } };
	}
	log.notes.add('it has no click mapping');
	return undefined;
}

/**
 * BUTTON for a worksheet drawn as a button (a single shape, no fields) that starts a Go to Sheet action on this
 * dashboard: the first such action with a target in the app.
 * @param {ZoneIR} zone
 * @param {AppContext} ctx
 */
export function sheetButton(zone, dash, ctx) {
	const sheets = new Set([zone.worksheet]);
	for (const action of ctx.ir.actions ?? []) {
		if (action.type !== 'navigate' || action.trigger === 'hover' || !actionSources(action, dash, ctx.ir, sheets).length) continue;
		const interaction = linkTo(action.target, ctx);
		if (!interaction) continue;
		const log = logAction(ctx, action);
		log.views.add(dash.name);
		log.mapped = true;
		log.notes.add(`the worksheet button "${zone.worksheet}" became an App Studio button`);
		const text = cut(String(action.name || action.target.name).trim(), APP_TEXT_LIMIT);
		return (contentKey) => ({ contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction });
	}
	return undefined;
}

/**
 * Set `interaction` on the dashboard's worksheet cards from the workbook actions. A card holds one click action: select
 * before menu before hover, then Go to Sheet, filter to another view, URL, parameter, same-view filter; a URL cut at a field
 * token comes after all of them. Same-view filters
 * keep Domo's default (every card on the view) unless the actions restrict targets (STANDARD with selected cards).
 * @param {{ content: Object, sheet?: string }[]} cardEntries  Worksheet card entries of the view
 * @param {AppContext} ctx
 */
export function applyCardActions(dash, cardEntries, ctx) {
	const sheetsOf = (e) => e.sheets ?? (e.sheet ? [e.sheet] : []);
	const bySheet = new Map(cardEntries.flatMap((e) => sheetsOf(e).map((s) => [s, e])));
	const sheetsOnDash = new Set(bySheet.keys());
	if (!sheetsOnDash.size) return;
	const candidates = new Map();
	for (const action of ctx.ir.actions ?? []) {
		for (const sheet of actionSources(action, dash, ctx.ir, sheetsOnDash)) {
			const log = logAction(ctx, action);
			log.views.add(dash.name);
			const c = candidate(action, dash, sheet, sheetsOnDash, ctx);
			if (!c) continue;
			const entry = bySheet.get(sheet);
			if (!candidates.has(entry)) candidates.set(entry, { sheet, list: [] });
			candidates.get(entry).list.push(c);
		}
	}
	for (const [entry, { sheet, list }] of candidates) {
		const filters = list.filter((c) => c.kind === 'filter');
		const merged = list.filter((c) => c.kind !== 'filter');
		if (filters.length) merged.push({ kind: 'filter', rank: Math.min(...filters.map((c) => c.rank)), action: filters[0].action, actions: filters.map((c) => c.action), targets: new Set(filters.flatMap((c) => c.targets)) });
		merged.sort(clickOrder);
		const [kept, ...rest] = merged;
		if (kept.kind === 'filter') {
			const others = [...new Set(cardEntries.filter((e) => e !== entry && sheetsOf(e).length))];
			const targeted = (e) => sheetsOf(e).some((s) => kept.targets.has(s));
			const restricted = others.some((e) => !targeted(e));
			if (restricted) {
				const urns = others.filter(targeted).map((e) => ref('card', cardKeyOf(e), 'urn'));
				entry.content.interaction = { type: 'STANDARD', config: { allowCardToCardInteractions: urns.length > 0, openInNewWindow: false, selectIndividualCards: true, selectedCardUrns: urns } };
			}
		} else {
			entry.content.interaction = kept.interaction;
		}
		for (const other of rest) for (const a of other.actions ?? [other.action]) logAction(ctx, a).lost.set(sheet, kept.action.name);
	}
}

const cardKeyOf = (entry) => String(entry.content.cardId?.$ref ?? '').replace(/^card:/, '');

/**
 * Issues for every workbook action, once each: what it became in the app and how that differs from Tableau.
 * @param {WorkbookIR} ir
 * @param {ActionLog} log
 * @param {CardPlan[]} [cards]  A URL action a table carries as a link column (card.urlColumns) is reported by that card
 * @returns {Issue[]}
 */
export function actionIssues(ir, log, cards = []) {
	const issues = [];
	const linkColumns = new Set(cards.flatMap((c) => (c.urlColumns ?? []).map((u) => u.actionId)));
	for (const action of ir.actions ?? []) {
		if (action.type === 'other') continue;
		const object = { type: 'action', name: action.name, id: action.id };
		const entry = log.get(action.id);
		const label = `${{ filter: 'Filter', highlight: 'Highlight', url: 'URL', navigate: 'Go to sheet', parameter: 'Change parameter', set: 'Change set' }[action.type]} action "${action.name}"`;
		if (linkColumns.has(action.id) && !entry?.mapped) {
			if (entry?.dropped) issues.push(issue(object, 'warning', 'layout.action-url-dropped', `${label} is a link column on its tables, but on its other cards it was not migrated: ${entry.dropped}`, 'Add a link in the App Studio editor if the target supports https.'));
			continue;
		}
		if (action.type === 'highlight') {
			issues.push(issue(object, 'warning', 'layout.action-highlight', `${label} has no App Studio equivalent (cards cannot highlight marks of other cards); not migrated`));
			continue;
		}
		if (action.type === 'set') {
			issues.push(issue(object, 'warning', 'layout.action-set', `${label} has no App Studio equivalent (no click action changes a set); not migrated`));
			continue;
		}
		if (!entry?.views.size) {
			issues.push(issue(object, 'info', 'layout.action-unplaced', `${label} starts on no worksheet of a dashboard view (card click actions are set on dashboard views only), so it is not migrated`));
			continue;
		}
		const where = [...entry.views].slice(0, 3).map((v) => `"${v}"`).join(', ');
		if (entry.dropped && !entry.mapped) {
			issues.push(issue(object, 'warning', 'layout.action-url-dropped', `${label} was not migrated: ${entry.dropped}`, 'Add a link in the App Studio editor if the target supports https.'));
			continue;
		}
		if (!entry.mapped) {
			issues.push(issue(object, 'warning', 'layout.action-unmapped', `${label} was not migrated: ${[...entry.notes].join('; ')}`));
			continue;
		}
		if (action.trigger !== 'select') {
			issues.push(issue(object, 'info', 'layout.action-trigger', `${label} runs on ${action.trigger === 'menu' ? 'a tooltip menu link' : 'hover'} in Tableau; App Studio card actions run on click (views ${where})`));
		}
		if (entry.linkWithoutValues) {
			issues.push(
				issue(
					object,
					'warning',
					'layout.action-filter-values',
					`${label} opens its target view with the page filters, but not the clicked values (views ${where}): App Studio passes clicked values to another view only from Domo-built rooster cards`,
					'Filter the target view with its filter cards after the click, or keep the target on the same view.'
				)
			);
		}
		if (entry.notes.size) {
			const code = action.type === 'url' ? 'layout.action-url' : action.type === 'parameter' ? 'layout.action-parameter' : action.type === 'navigate' ? 'layout.action-navigate' : 'layout.action-filter';
			issues.push(issue(object, action.type === 'url' && [...entry.notes].some((n) => n.startsWith('field values')) ? 'warning' : 'info', code, `${label} converted approximately: ${[...entry.notes].join('; ')}`));
		}
		if (entry.lost.size) {
			const cards = [...entry.lost].slice(0, 3).map(([sheet, kept]) => `"${sheet}" runs "${kept}"`).join(', ');
			issues.push(issue(object, 'warning', 'layout.action-conflict', `${label} is not applied on ${entry.lost.size} card(s), because a Domo card runs one click action: ${cards}`));
		}
	}
	return issues;
}

/* Stories */

/**
 * One view per story: an optional title HEADER and a full-width TABS item with one tab per story point (captions as tab
 * labels; the editor allows no HEADER inside a tab). A point on a worksheet shows its card; a point on a dashboard gets a
 * button to that dashboard's view; a tab with neither holds a SPACER. Mutates `card.pageKeys`.
 * @param {StoryIR} story
 * @param {string} key
 * @param {AppContext} ctx
 * @returns {{ layout: LayoutPlan, issues: Issue[] }}
 */
export function planStoryLayout(story, key, ctx) {
	const object = { type: 'story', name: story.name };
	const issues = [];
	const px = dashboardPixels(story);
	const paneHeight = scaleRect({ x: 0, y: 0, w: 1, h: 1 }, px).height;
	let contentKey = 0;
	let order = 0;
	const next = () => ++contentKey;
	const entries = [];
	const leaf = (content, type, box) => ({ content, placed: { contentKey: content.contentKey, type, box, order: order++ } });
	let top = 0;
	const title = String(story.title?.text ?? '').trim();
	if (title) {
		entries.push(leaf({ contentKey: next(), type: 'HEADER', text: cut(title, APP_TEXT_LIMIT) }, 'HEADER', { x: 0, y: 0, width: STANDARD_WIDTH, height: HEADER_HEIGHT }));
		top = HEADER_HEIGHT;
	}
	const placed = new Set();
	const tabsKey = next();
	const barKey = next();
	const panes = story.points.map((point, i) => {
		const caption = String(point.caption ?? '').replace(/\s+/g, ' ').trim() || `Point ${i + 1}`;
		const label = cut(caption, STORY_TAB_LABEL);
		const pane = { content: { contentKey: next(), type: 'TAB_CONTENT', text: label }, children: [] };
		let y = 0;
		const child = (content, type, height) => {
			pane.children.push(leaf(content, type, { x: 0, y, width: STANDARD_WIDTH, height }));
			y += height;
		};
		if (label !== caption) issues.push(issue(object, 'info', 'layout.story-caption', `Story point caption "${caption}" is cut to ${STORY_TAB_LABEL} characters in its tab label (a tab holds no header)`));
		const card = point.sheetKind === 'worksheet' ? ctx.cardsBySheet.get(point.sheet) : undefined;
		if (card && card.status !== 'unsupported' && !placed.has(card.key)) {
			placed.add(card.key);
			child(cardContent(next(), card.key, { showDescription: hasSmartDescription(card) }), 'CARD', paneHeight);
			if (!card.pageKeys.includes(key)) card.pageKeys.push(key);
		} else if (point.sheetKind === 'dashboard' && ctx.dashboardKeys.has(point.sheet)) {
			child({ contentKey: next(), type: 'BUTTON', text: cut(`Open ${point.sheet}`, APP_TEXT_LIMIT), iconPosition: 'LEFT', interaction: viewLink(ctx.dashboardKeys.get(point.sheet)) }, 'BUTTON', BUTTON_HEIGHT);
			issues.push(issue(object, 'info', 'layout.story-dashboard', `Story point "${label}" shows the dashboard "${point.sheet}"; its tab has a button that opens that dashboard's view`));
		} else {
			const why = card && placed.has(card.key) ? `repeats the worksheet "${point.sheet}" of an earlier point (a view holds a card once)` : `shows "${point.sheet}", which has no card in the app`;
			child({ contentKey: next(), type: 'SPACER' }, 'SPACER', HEADER_HEIGHT);
			issues.push(issue(object, 'warning', 'layout.story-point', `Story point "${label}" ${why}; its tab shows only the caption as its label`));
		}
		for (const captured of point.captured ?? []) {
			if (captured.filters?.length) issues.push(issue(object, 'warning', 'layout.story-filters', `Story point "${label}" keeps ${captured.filters.length} filter change(s) on "${captured.name}"; the tab shows the card with its own filters`, 'Save the filters as a Domo filter view if they matter.'));
			if (captured.annotations) issues.push(issue(object, 'info', 'layout.story-annotations', `Story point "${label}" has ${captured.annotations} annotation(s) on "${captured.name}"; Domo cards have no annotations`));
		}
		pane.height = y;
		return pane;
	});
	const height = Math.max(MIN_CARD_HEIGHT, ...panes.map((p) => p.height));
	for (const pane of panes) {
		pane.children.at(-1).placed.box.height += height - pane.height;
		pane.height = height;
	}
	const group = { group: { tabs: { contentKey: tabsKey, type: 'TABS', tabType: 'TAB', collapsible: false, hideTitle: false }, barKey, panes }, placed: { contentKey: tabsKey, type: 'TABS', box: { x: 0, y: top, width: STANDARD_WIDTH, height: height + SECTION_BAR_HEIGHT }, order: order++ } };
	entries.push(group);
	return { layout: buildAppLayout(entries), issues };
}

/** Page keys a layout links to (buttons and card actions). */
export function linkedPageKeys(layout) {
	const out = new Set();
	for (const item of layout?.content ?? []) for (const r of collectRefs(item.interaction)) if (r.startsWith('page:')) out.add(r.slice('page:'.length));
	return out;
}

/* Theme */

/** Tableau font name -> App Studio theme font family. */
export function themeFamily(name) {
	const n = String(name ?? '').toLowerCase();
	if (/mono|courier|consol|menlo|lucida console/.test(n)) return 'Monospace';
	if (/condensed|narrow|compressed|oswald|bebas/.test(n)) return 'Condensed';
	if (/slab|rockwell|roboto slab|museo slab|clarendon|arvo/.test(n)) return 'Slab';
	if (/sans/.test(n)) return 'Sans';
	if (/serif|georgia|times|garamond|cambria|palatino|book antiqua|baskerville|didot|bodoni|merriweather/.test(n)) return 'Serif';
	return 'Sans';
}

const fontName = (value) => String(value ?? '').split(',')[0].replace(/["']/g, '').trim();

/** '#rgb', '#rrggbb' or '#rrggbbaa' as uppercase '#RRGGBB' (alpha blended over white), or undefined when transparent. */
export function opaqueHex(value) {
	let hex = String(value ?? '').trim().replace(/^#/, '');
	if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((ch) => ch + ch).join('');
	if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return undefined;
	const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
	if (alpha === 0) return undefined;
	const rgb = [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * alpha + 255 * (1 - alpha)));
	return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function tally() {
	const counts = new Map();
	return {
		add(value, n = 1) {
			if (value !== undefined && value !== '') counts.set(value, (counts.get(value) ?? 0) + n);
		},
		top() {
			return [...counts].sort((a, b) => b[1] - a[1])[0];
		},
		total() {
			return [...counts.values()].reduce((a, b) => a + b, 0);
		}
	};
}

const DEFAULT_TEXT_COLOR = 'default';
// A saturated text color is an accent (a red note), not the color of the app's card titles and tables.
const MAX_NEUTRAL_SPREAD = 48;
const isNeutral = (hex) => {
	const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	return Math.max(...rgb) - Math.min(...rgb) <= MAX_NEUTRAL_SPREAD;
};

/**
 * Theme overrides from the workbook's dominant formatting: text and title font families (mapped onto App Studio's five),
 * text color (the workbook default, else a neutral color most text runs share), dashboard background, worksheet card background and border (when most worksheet zones share them), and
 * navigation button color. Undefined when the workbook sets none of these.
 * @param {WorkbookIR} ir
 * @returns {{ overrides?: import('../model/types.js').AppThemeOverrides, issues: Issue[] }}
 */
export function workbookTheme(ir, base) {
	const fonts = tally();
	const titleFonts = tally();
	const colors = tally();
	const backgrounds = tally();
	const cardBackgrounds = tally();
	const borders = tally();
	const buttons = tally();
	let sheetZones = 0;
	const defaults = ir.style?.defaults ?? {};
	for (const rule of ir.style?.rules ?? []) {
		for (const f of rule.formats) if (!f.id && !f.field && f.attr === 'font-family' && /title/.test(rule.element)) titleFonts.add(fontName(f.value), 5);
	}
	for (const dash of ir.dashboards ?? []) {
		backgrounds.add(dash.background ? opaqueHex(dash.background) : undefined);
		for (const rule of dash.styleRules ?? []) {
			for (const f of rule.formats) if (!f.id && !f.field && f.attr === 'font-family') (rule.element === 'dash-title' ? titleFonts : fonts).add(fontName(f.value), 5);
		}
		for (const run of dash.title?.runs ?? []) titleFonts.add(fontName(run.fontName));
		for (const zone of [...(dash.zones ?? []), ...(dash.floating ?? [])]) {
			for (const run of zone.runs ?? []) {
				(zone.kind === 'title' ? titleFonts : fonts).add(fontName(run.fontName));
				if (zone.kind === 'text' && String(run.text ?? '').trim()) colors.add(opaqueHex(run.color) ?? DEFAULT_TEXT_COLOR);
			}
			if (zone.kind === 'text' && !zone.runs?.length && String(zone.text ?? '').trim()) colors.add(DEFAULT_TEXT_COLOR);
			if (zone.kind === 'worksheet') {
				sheetZones += 1;
				cardBackgrounds.add(opaqueHex(zone.style?.background));
				const b = zone.style?.border;
				if (b && b.style !== 'none' && opaqueHex(b.color)) borders.add(`${opaqueHex(b.color)}|${Math.min(4, Math.max(1, Math.round(b.width ?? 1)))}`);
			}
			if (zone.button?.action === 'navigate') buttons.add(opaqueHex(zone.button.states?.[0]?.style?.background));
		}
	}
	const overrides = {};
	const mapped = [];
	const font = defaults.fontFamily ? fontName(defaults.fontFamily) : fonts.top()?.[0];
	if (font) {
		overrides.fontFamily = themeFamily(font);
		mapped.push(`text font ${font} as ${overrides.fontFamily}`);
	}
	const title = titleFonts.top()?.[0];
	if (title && themeFamily(title) !== overrides.fontFamily) {
		overrides.titleFontFamily = themeFamily(title);
		mapped.push(`title font ${title} as ${overrides.titleFontFamily}`);
	}
	const [topColor, topRuns] = colors.top() ?? [];
	const mostText = topColor && topColor !== DEFAULT_TEXT_COLOR && topRuns * 2 > colors.total() && isNeutral(topColor) ? topColor : undefined;
	const color = opaqueHex(defaults.color) ?? mostText;
	if (color) {
		overrides.fontColor = color;
		mapped.push(`text color ${color}`);
	}
	const background = backgrounds.top()?.[0];
	if (background) {
		overrides.background = background;
		mapped.push(`background ${background}`);
	}
	const majority = (t) => {
		const top = t.top();
		return top && top[1] * 2 >= sheetZones ? top[0] : undefined;
	};
	const cardBackground = majority(cardBackgrounds);
	const border = majority(borders);
	if (cardBackground || border) {
		overrides.card = {};
		if (cardBackground) overrides.card.background = cardBackground;
		if (border) [overrides.card.borderColor, overrides.card.borderWidth] = [border.split('|')[0], Number(border.split('|')[1])];
		mapped.push(`card ${[cardBackground && `background ${cardBackground}`, border && `border ${border.replace('|', ' ')}px`].filter(Boolean).join(', ')}`);
	}
	const button = buttons.top()?.[0];
	if (button) {
		overrides.buttonBackground = button;
		mapped.push(`button color ${button}`);
	}
	const issues = [];
	const object = { type: 'workbook', name: ir.workbook?.name || 'Workbook' };
	if (mapped.length) {
		issues.push(issue(object, 'info', 'layout.theme', `The app theme is ${base} with the workbook's dominant formatting: ${mapped.join('; ')}. Fonts, sizes and margins of single items are not kept`));
	}
	return { overrides: mapped.length ? overrides : undefined, issues };
}

// Tableau's default crosstab as rendered (a sheet that sets no banding or dividers): white panes, every other
// row #F5F5F5, no totals fill, #CBCBCB row dividers between the outer row groups.
export const TABLEAU_TABLE = { background: '#FFFFFF', band: '#F5F5F5', divider: '#CBCBCB' };

/** A crosstab's App Studio table look from its own shading, else the workbook's, else Tableau's default. Pure. */
export function sheetTableStyle(ws, workbook = {}) {
	const s = { ...workbook, ...(ws?.tableStyle ?? {}) };
	const rowColor = opaqueHex(s.background) ?? TABLEAU_TABLE.background;
	const banded = s.rowBandSize !== 0 && (s.rowBandColor === undefined || opaqueHex(s.rowBandColor));
	const dimensions = (ws?.rowPills ?? []).filter((id) => !ws.pills?.[id]?.continuous).length;
	return {
		rowColor,
		bandColor: banded ? (opaqueHex(s.rowBandColor) ?? TABLEAU_TABLE.band) : null,
		totalColor: opaqueHex(s.totalBackground) ?? rowColor,
		subtotalColor: opaqueHex(s.subtotalBackground) ?? rowColor,
		borderType: s.rowDividers === false ? 'NONE' : dimensions > 1 ? 'HORIZONTAL' : 'BELOW_HEADER',
		borderColor: s.rowDividers === false ? null : (opaqueHex(s.rowDividerColor) ?? TABLEAU_TABLE.divider)
	};
}

/** The most common look of the placed table cards' worksheets, for the theme's mapped table style. */
export function workbookTableStyle(ir, cards) {
	const byName = new Map((ir.worksheets ?? []).map((w) => [w.name, w]));
	const sheets = new Set((cards ?? []).filter((c) => TABLE_STYLE_CHARTS.has(c.chartType) && c.pageKeys?.length && byName.has(c.worksheet)).map((c) => c.worksheet));
	const looks = tally();
	for (const name of sheets) looks.add(JSON.stringify(sheetTableStyle(byName.get(name), ir.style?.table)));
	const [top, count] = looks.top() ?? [];
	if (!top) return { issues: [] };
	const table = JSON.parse(top);
	const object = { type: 'workbook', name: ir.workbook?.name || 'Workbook' };
	const label = `rows ${table.rowColor}, ${table.bandColor ? `banding ${table.bandColor}` : 'no banding'}, totals ${table.totalColor}, subtotals ${table.subtotalColor}, ${table.borderType === 'NONE' ? 'no row dividers' : `${table.borderType === 'HORIZONTAL' ? 'row dividers' : 'a line under the header'} ${table.borderColor}`}`;
	const others = looks.total() - count;
	return { table, issues: [issue(object, 'info', 'layout.table-style', `Tables take the look of ${count} of the workbook's ${looks.total()} crosstab(s): ${label}${others ? `; ${others} with other shading take it too (the theme has one table style)` : ''}`)] };
}

const MAX_BORDER = 4;
const MAX_PADDING = 16;
const PADDING_STEP = 4;
const NEAR_COLOR = 8;
const TABLE_STYLE_CHARTS = new Set(['badge_basic_table', 'badge_pivot_table']);
const SINGLE_VALUE_STYLE_CHARTS = /singlevalue|multi_value|gauge|progress|textbox|selector/;

const roundPadding = (v) => Math.min(MAX_PADDING, Math.max(0, Math.round((Number(v) || 0) / PADDING_STEP) * PADDING_STEP));

/** A worksheet zone's card style (null fields keep the theme's), or undefined for a card item styles skip. Pure. */
export function zoneItemStyle(zone, chartType) {
	if (!chartType || SINGLE_VALUE_STYLE_CHARTS.test(chartType)) return undefined;
	const s = zone.style ?? {};
	const border = s.border && opaqueHex(s.border.color) ? { color: opaqueHex(s.border.color), width: Math.min(MAX_BORDER, Math.max(1, Math.round(s.border.width ?? 1))) } : null;
	const sides = typeof s.padding === 'object' && s.padding ? s.padding : { top: s.padding, right: s.padding, bottom: s.padding, left: s.padding };
	const rounded = Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k) => [k, roundPadding(sides[k])]));
	const padding = Object.values(rounded).some(Boolean) ? rounded : null;
	return { kind: TABLE_STYLE_CHARTS.has(chartType) ? 'table' : 'card', background: (s.background && opaqueHex(s.background)) || null, borderColor: border?.color ?? null, borderWidth: border?.width ?? 0, padding };
}

/** A filter zone's card style: the background it shows, its own or the nearest container's; Tableau filters have no border. */
export function controlItemStyle(zone, dash) {
	const containers = new Map((dash?.containers ?? []).map((c) => [c.id, c]));
	let background = opaqueHex(zone.style?.background);
	for (let at = containers.get(zone.parent); !background && at; at = containers.get(at.parent)) background = opaqueHex(at.style?.background);
	return { kind: 'control', background: background || null, borderColor: null, borderWidth: 0, padding: null };
}

const nearColor = (a, b) => a === b || (Boolean(a) && Boolean(b) && [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= NEAR_COLOR));
const SIDES = ['top', 'right', 'bottom', 'left'];
const nearPadding = (a, b) => SIDES.every((k) => Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)) <= PADDING_STEP);
const sameStyle = (a, b) => a.kind === b.kind && a.borderWidth === b.borderWidth && nearPadding(a.padding, b.padding) && nearColor(a.background, b.background) && nearColor(a.borderColor, b.borderColor);

/**
 * The views' card zone styles (content `itemStyle`) merged when near-identical, ranked by item count, without the theme's
 * own card style; the most common filter style becomes the theme's control style (`control`). Each content's `itemStyle`
 * becomes its style key or is removed. Mutates the layouts.
 * @param {{ layout?: LayoutPlan }[]} views
 * @param {{ background?: string, borderColor?: string, borderWidth?: number }} [card]  The theme's card overrides
 * @returns {{ styles: import('../model/types.js').ItemStylePlan[], control?: { background: string|null, borderWidth: number } }}
 */
export function planItemStyles(views, card) {
	const items = views.flatMap((v) => (v.layout?.content ?? []).filter((c) => c.itemStyle));
	const groups = [];
	const raw = new Map();
	for (const item of items) {
		const k = JSON.stringify(item.itemStyle);
		raw.set(k, [...(raw.get(k) ?? []), item]);
	}
	for (const [k, list] of [...raw].sort((a, b) => b[1].length - a[1].length)) {
		const style = JSON.parse(k);
		const group = groups.find((g) => sameStyle(g.style, style));
		if (group) group.items.push(...list);
		else groups.push({ style, items: [...list] });
	}
	groups.sort((a, b) => b.items.length - a.items.length);
	const control = groups.find((g) => g.style.kind === 'control')?.style;
	const base = { background: card?.background ?? null, borderColor: card?.borderColor ?? null, borderWidth: card?.borderColor ? Math.min(MAX_BORDER, Math.max(1, Math.round(card.borderWidth ?? 1))) : 0, padding: null };
	const styles = [];
	for (const g of groups) {
		if (sameStyle(g.style, g.style.kind === 'control' ? control : { ...base, kind: g.style.kind })) {
			for (const item of g.items) delete item.itemStyle;
			continue;
		}
		const key = `s${styles.length + 1}`;
		styles.push({ key, ...g.style, items: g.items.length });
		for (const item of g.items) item.itemStyle = key;
	}
	return { styles, ...(control ? { control: { background: control.background, borderWidth: 0 } } : {}) };
}
