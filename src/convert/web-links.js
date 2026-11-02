import { slugify } from '../util/ids.js';

/**
 * Web zones that show another Tableau view of the same site. A view of a workbook that is part of the migration becomes a
 * button to that workbook's app view; the plan cannot rebuild a view of another workbook.
 *
 * @typedef {{ host: string, site: string }} TableauSite  `site` is the site contentUrl, '' for the Default site
 * @typedef {{ name: string, key: string, kind: 'dashboard'|'story'|'worksheet' }} LinkView  `key`: the view's page key, or a worksheet's card key
 * @typedef {Object} LinkTarget  A workbook of the migration (another workspace workbook) a web zone can link to
 * @property {string} slug
 * @property {string} name          Workbook name
 * @property {string} contentUrl    Workbook contentUrl, as in a view url
 * @property {'app'|'pages'} target
 * @property {string} [title]       App or root page title
 * @property {boolean} [planned]    Keys come from its plan.json (else they are predicted from its ir.json)
 * @property {LinkView[]} views
 * @typedef {{ site?: TableauSite, targets?: LinkTarget[] }} LinkContext  `site`: the configured site, for a workbook whose
 *   IR has no webpage url (the site it was downloaded from wins: a Tableau Cloud config may leave the site empty)
 */

/**
 * Parts of a Tableau view url: `/#/site/<site>/views/<workbook>/<sheet>`, `/t/<site>/views/...`, and on the Default site
 * `/#/views/...` and `/views/...`; any query string. Undefined for any other url.
 * @param {string} url
 * @returns {(TableauSite & { workbook: string, sheet: string })|undefined}
 */
export function parseViewUrl(url) {
	let parsed;
	try {
		parsed = new URL(String(url ?? '').trim());
	} catch {
		return undefined;
	}
	if (!/^https?:$/.test(parsed.protocol)) return undefined;
	const route = `${parsed.pathname}${parsed.hash.replace(/^#/, '')}`.replace(/\/{2,}/g, '/');
	const m = /(?:^|\/)(?:(?:site|t)\/([^/?#]+)\/)?views\/([^/?#]+)\/([^/?#]+)/.exec(route);
	if (!m) return undefined;
	const dec = (s) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};
	return { host: parsed.host.toLowerCase(), site: dec(m[1] ?? ''), workbook: dec(m[2]), sheet: dec(m[3]) };
}

// The query is dropped: `?:iid=N` only numbers the browser tab.
export function tableauViewHref(view) {
	const enc = encodeURIComponent;
	return `https://${view.host}/#/${view.site ? `site/${enc(view.site)}/` : ''}views/${enc(view.workbook)}/${enc(view.sheet)}`;
}

const urlWords = (name) => String(name ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');

/** Tableau's names from the extract (WorkbookInfo.linkedViews), else words from the url. */
export function linkedViewNames(ir, view) {
	const wanted = `${view.workbook}/sheets/${view.sheet}`.toLowerCase();
	const found = (ir?.workbook?.linkedViews ?? []).find((v) => String(v.contentUrl ?? '').toLowerCase() === wanted);
	return { name: found?.name?.trim() || urlWords(view.sheet), workbook: found?.workbook?.trim() || urlWords(view.workbook) };
}

/** The Tableau site of a server url and site contentUrl (the t2d config). */
export function siteFromConfig(tableau) {
	if (!tableau?.server) return undefined;
	try {
		return { host: new URL(tableau.server).host.toLowerCase(), site: tableau.site ?? '' };
	} catch {
		return undefined;
	}
}

/** The site a workbook was extracted from, from its webpage url (`.../#/site/<site>/workbooks/<id>`). */
export function siteOfWorkbook(ir) {
	const page = ir?.workbook?.webpageUrl;
	if (!page) return undefined;
	try {
		const parsed = new URL(page);
		const route = `${parsed.pathname}${parsed.hash.replace(/^#/, '')}`;
		return { host: parsed.host.toLowerCase(), site: /(?:site|t)\/([^/?#]+)/.exec(route)?.[1] ?? '' };
	} catch {
		return undefined;
	}
}

/** A sheet name as it appears in its view url: Tableau drops spaces and punctuation; compared case-insensitively. */
const urlName = (name) => String(name ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/** The view of a workbook a url names, by sheet url name. */
export function findView(views, sheet) {
	const wanted = urlName(sheet);
	return wanted ? views.find((v) => urlName(v.name) === wanted) : undefined;
}

/**
 * Link targets of a workbook from its plan, or, before it is converted, its IR (keys as convert gives them).
 * @param {{ slug: string, contentUrl: string, ir?: Object, plan?: Object }} source
 * @param {string} [workbookKey]  The workbook's plan key (convert/index.js workbookKeyFor), for an IR
 * @returns {LinkTarget}
 */
export function linkTargetOf({ slug, contentUrl, ir, plan }, workbookKey) {
	const name = ir?.workbook?.name ?? plan?.source?.workbook ?? slug;
	if (plan) {
		const views = [
			...(plan.pages ?? []).filter((pg) => pg.dashboard || pg.story).map((pg) => ({ name: pg.story || pg.dashboard, key: pg.key, kind: pg.story ? 'story' : 'dashboard' })),
			...(plan.cards ?? []).filter((c) => c.worksheet && c.status !== 'unsupported' && c.kind !== 'notebook').map((c) => ({ name: c.worksheet, key: c.key, kind: 'worksheet' }))
		];
		const title = plan.app?.title ?? (plan.pages ?? []).find((pg) => !pg.parentKey && !pg.dashboard)?.title;
		return { slug, name, contentUrl, target: plan.target === 'pages' ? 'pages' : 'app', ...(title ? { title } : {}), planned: true, views };
	}
	const root = workbookKey ?? slugify(ir?.workbook?.luid || name);
	const views = [...(ir?.dashboards ?? []).map((d) => ({ name: d.name, key: `${root}--${slugify(d.name)}`, kind: 'dashboard' })), ...(ir?.stories ?? []).map((s) => ({ name: s.name, key: `${root}--${slugify(s.name)}`, kind: 'story' }))];
	return { slug, name, contentUrl, target: 'app', views };
}

const sameSite = (a, b) => Boolean(a && b) && a.host === b.host && a.site.toLowerCase() === b.site.toLowerCase();

/**
 * What a web zone's url shows: a view of this workbook (`self`), of a workbook in the migration (`move`), of another
 * workbook on the site (`outside`), a Tableau view t2d cannot place (`unresolved`, with why), or no Tableau view (undefined).
 * @param {string} url
 * @param {Object} ir  This workbook's IR
 * @param {LinkContext} [links]
 */
export function resolveWebUrl(url, ir, links = {}) {
	const view = parseViewUrl(url);
	if (!view) return undefined;
	const site = siteOfWorkbook(ir) ?? links.site;
	if (!sameSite(view, site)) return { kind: 'unresolved', view, why: site ? `it is on another Tableau site (${view.host}${view.site ? `, site ${view.site}` : ''})` : 'the Tableau site of this workbook is unknown' };
	const own = String(ir?.workbook?.contentUrl ?? '').toLowerCase();
	if (own && view.workbook.toLowerCase() === own) {
		const sheets = [...(ir.dashboards ?? []).map((d) => ({ name: d.name, kind: 'dashboard' })), ...(ir.stories ?? []).map((s) => ({ name: s.name, kind: 'story' })), ...(ir.worksheets ?? []).map((w) => ({ name: w.name, kind: 'worksheet' }))];
		const found = findView(sheets, view.sheet);
		return found ? { kind: 'self', view, target: found } : { kind: 'unresolved', view, why: `this workbook has no sheet named like "${view.sheet}"` };
	}
	const target = (links.targets ?? []).find((t) => String(t.contentUrl ?? '').toLowerCase() === view.workbook.toLowerCase());
	if (!target) return { kind: 'outside', view };
	const found = findView(target.views, view.sheet);
	return found ? { kind: 'move', view, workbook: target, target: found } : { kind: 'unresolved', view, why: `workbook "${target.name}" has no ${target.planned ? 'view or card' : 'dashboard or story'} named like "${view.sheet}"` };
}

/** Workbook contentUrls the web zones of an IR show views of, other than its own. */
export function linkedWorkbooks(ir) {
	const own = String(ir?.workbook?.contentUrl ?? '').toLowerCase();
	const out = new Set();
	for (const dash of ir?.dashboards ?? []) {
		for (const zone of [...(dash.zones ?? []), ...(dash.floating ?? [])]) {
			const view = zone.kind === 'web' ? parseViewUrl(zone.url) : undefined;
			if (view && view.workbook.toLowerCase() !== own) out.add(view.workbook);
		}
	}
	return [...out];
}
