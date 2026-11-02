import fs from 'node:fs';
import * as realApps from '../../src/domo/apps.js';
import { buildAppLayout, cardLink, viewLink } from '../../src/convert/app-layout.js';
import { ref } from '../../src/util/refs.js';
import { samplePlan, stubDomo } from './helpers.js';

/** samplePlan as target 'app': one app, views Overview (landing) and Details (hidden), cards on Overview. */
export function appPlan() {
	const plan = samplePlan();
	const overview = plan.pages.find((p) => p.key === 'dash');
	delete overview.parentKey;
	Object.assign(overview, { appKey: 'root', navOrder: 1 });
	const details = {
		key: 'details',
		title: 'Details',
		appKey: 'root',
		navOrder: 2,
		hidden: true,
		dashboard: 'Details',
		layout: {
			content: [{ contentKey: 1, type: 'CARD', cardId: ref('card', 'sheet-1') }],
			standard: { width: 60, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 60, height: 20 }] },
			compact: { width: 12, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 12 }] }
		}
	};
	plan.cards[0].pageKeys = ['dash', 'details'];
	plan.pages = [overview, details];
	plan.target = 'app';
	plan.app = {
		key: 'root',
		title: 'Sales',
		description: 'Migrated from the Tableau workbook "Sales"',
		theme: { base: 'Clarion' },
		navigation: { orientation: 'TOP', showDomoNavigation: false, showNavigation: true },
		persistSettings: { persistFiltersEnabled: true, persistVariablesEnabled: true, persistDateEnabled: false, persistInteractionsEnabled: false, persistedColumns: [] },
		landingKey: 'dash'
	};
	return plan;
}

/**
 * appPlan with linking items: on Overview a button and a card that open Details, a card filtering only the other
 * card, and a section; Details hidden but linked, with a card that opens the other card; workbook theme overrides.
 */
export function appItemsPlan() {
	const plan = appPlan();
	const card = (contentKey, key, interaction) => ({ content: { contentKey, type: 'CARD', cardId: ref('card', key), ...(interaction ? { interaction } : {}) }, placed: { contentKey, type: 'CARD', box: { x: (contentKey - 1) * 20, y: 0, width: 20, height: 20 }, order: contentKey } });
	const header = { content: { contentKey: 4, type: 'HEADER', text: 'Notes' }, placed: { contentKey: 4, type: 'HEADER', box: { x: 0, y: 0, width: 60, height: 5 }, order: 4 } };
	const section = {
		group: { tabs: { contentKey: 5, type: 'TABS', tabType: 'SECTION', itemId: '8c4b1f2e-5d6a-4b7c-9e8f-0a1b2c3d4e5f', collapsible: true, hideTitle: false }, barKey: 6, panes: [{ content: { contentKey: 7, type: 'TAB_CONTENT', text: 'Notes' }, children: [header], height: 5 }] },
		placed: { contentKey: 5, type: 'TABS', box: { x: 0, y: 20, width: 60, height: 10 }, order: 5 }
	};
	const button = { content: { contentKey: 3, type: 'BUTTON', text: 'Open details', iconPosition: 'LEFT', interaction: viewLink('details') }, placed: { contentKey: 3, type: 'BUTTON', box: { x: 40, y: 0, width: 20, height: 3 }, order: 3 } };
	const standard = { type: 'STANDARD', config: { allowCardToCardInteractions: true, openInNewWindow: false, selectIndividualCards: true, selectedCardUrns: [ref('card', 'sheet-2', 'urn')] } };
	plan.pages[0].layout = buildAppLayout([card(1, 'sheet-1', standard), card(2, 'sheet-2', viewLink('details')), button, section]);
	plan.pages[1].linked = true;
	plan.pages[1].layout = buildAppLayout([card(1, 'sheet-1', cardLink('sheet-2'))]);
	plan.app.theme = { base: 'Clarion', overrides: { fontFamily: 'Serif', background: '#FFF5E6' } };
	return plan;
}

const CLARION = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));

const NAV_FIXED = ['HOME', 'AI_ASSISTANT', 'CONTROLS', 'DISTRIBUTE', 'MORE'];

/**
 * stubDomo plus an in-memory App Studio: `apps` and `probe` deps that record calls in the same list.
 * `flags` are the customer features; `lockedLayouts` are view ids whose layout write fails with a lock conflict.
 */
export function stubAppDomo({ flags = { 'data-app': 'on', 'app-studio-persist': 'on' }, lockedLayouts = [], foreignViews = [] } = {}) {
	const stub = stubDomo({ invalid: [] });
	const { calls } = stub;
	let next = 600;
	const server = { apps: new Map(), nav: new Map(), persist: new Map(), savedThemes: new Map(), palettes: new Map() };
	const rec = (name, args, result) => {
		calls.push({ name, args });
		return result;
	};
	const notFound = (what) => Object.assign(new Error(`HTTP 404: ${what} not found`), { status: 404 });
	const badRequest = (message) => Object.assign(new Error(`HTTP 400: ${message}`), { status: 400 });
	const appOf = (id) => {
		const app = server.apps.get(String(id));
		if (!app) throw notFound(`app ${id}`);
		return app;
	};
	const navItem = (entity, entityId, title, visible = true) => ({ entity, entityId: String(entityId), title, visible, icon: { value: 'pages', size: 'DEFAULT' }, iconPosition: 'LEFT' });
	const addView = (app, viewId, title) => {
		app.views.push({ viewId, title, visible: true, children: [] });
		const nav = server.nav.get(String(app.dataAppId));
		const at = nav.findIndex((n) => n.entity === 'AI_ASSISTANT');
		nav.splice(at, 0, navItem('VIEW', viewId, title));
		nav.forEach((n, i) => (n.navOrder = i + 1));
	};
	const apps = {
		...realApps,
		createApp: async (_c, spec) => {
			const id = ++next;
			const viewId = ++next;
			const nav = spec.navigation ?? { orientation: 'TOP', showDomoNavigation: false, showNavigation: true };
			const app = {
				dataAppId: id, title: spec.title, description: spec.description, landingViewId: viewId, owners: [{ id: 1, type: 'USER' }],
				navOrientation: nav.orientation, showDomoNavigation: nav.orientation === 'LEFT' ? false : nav.showDomoNavigation !== false, showNavigation: nav.showNavigation, showTitle: nav.showTitle ?? nav.orientation !== 'LEFT',
				theme: spec.theme ?? { name: 'Clarion' }, views: [], type: 'app'
			};
			if (app.theme.sections && app.theme.sections.length !== 2) app.theme = { ...app.theme, sections: structuredClone(CLARION.sections) };
			server.apps.set(String(id), app);
			server.nav.set(String(id), [navItem('HOME', 'home', 'Home'), ...NAV_FIXED.slice(1).map((e) => navItem(e, e.toLowerCase(), e))]);
			addView(app, viewId, 'App Page 1');
			for (const title of foreignViews) addView(app, ++next, title);
			return rec('createApp', spec, { app: structuredClone(app), id, defaultViewId: viewId });
		},
		getApp: async (_c, id) => rec('getApp', { id }, structuredClone(appOf(id))),
		updateApp: async (_c, id, body) => {
			appOf(id);
			const stored = { ...body, views: appOf(id).views };
			if (stored.theme?.sections && stored.theme.sections.length !== 2) stored.theme = { ...stored.theme, sections: structuredClone(CLARION.sections) };
			server.apps.set(String(id), stored);
			return rec('updateApp', { id, body }, structuredClone(stored));
		},
		listThemes: async (_c, appId) => rec('listThemes', { appId }, { default: [structuredClone(CLARION), ...['Midnight', 'Obsidian'].map((name) => ({ name, cards: [] }))], saved: null }),
		clearStyleOverride: async (_c, appId) => rec('clearStyleOverride', { appId }, ''),
		createAppPalette: async (_c, appId, palette) => {
			const id = ++next;
			server.palettes.set(String(id), { appId, ...palette });
			return rec('createAppPalette', { appId, palette }, { id, type: 'APP' });
		},
		updateAppPalette: async (_c, paletteId, appId, palette) => {
			if (!server.palettes.has(String(paletteId))) throw notFound(`palette ${paletteId}`);
			server.palettes.set(String(paletteId), { appId, ...palette });
			return rec('updateAppPalette', { paletteId, appId, palette }, { id: paletteId });
		},
		deleteAppPalette: async (_c, paletteId) => {
			if (!server.palettes.delete(String(paletteId))) throw notFound(`palette ${paletteId}`);
			return rec('deleteAppPalette', { paletteId }, '');
		},
		setSavedThemes: async (_c, appId, themes) => {
			appOf(appId);
			server.savedThemes.set(String(appId), themes);
			return rec('setSavedThemes', { appId, themes }, '');
		},
		createView: async (_c, appId, { title }) => {
			const viewId = ++next;
			addView(appOf(appId), viewId, title);
			return rec('createView', { appId, title }, { viewId, layoutId: viewId + 5000 });
		},
		renameView: async (_c, appId, viewId, title) => {
			const view = appOf(appId).views.find((v) => String(v.viewId) === String(viewId));
			if (!view) throw notFound(`view ${viewId}`);
			view.title = title;
			return rec('renameView', { appId, viewId, title }, '');
		},
		deleteView: async (_c, appId, viewId) => {
			const app = appOf(appId);
			app.views = app.views.filter((v) => String(v.viewId) !== String(viewId));
			if (String(app.landingViewId) === String(viewId)) app.landingViewId = app.views.find((v) => v.visible !== false)?.viewId ?? 0;
			server.nav.set(String(appId), server.nav.get(String(appId)).filter((n) => !(n.entity === 'VIEW' && n.entityId === String(viewId))));
			return rec('deleteView', { appId, viewId }, []);
		},
		setViewVisible: async (_c, appId, viewId, visible) => {
			const app = appOf(appId);
			const view = app.views.find((v) => String(v.viewId) === String(viewId));
			if (!visible && String(app.landingViewId) === String(viewId)) throw badRequest('Landing view id cannot be set hidden');
			view.visible = visible;
			return rec('setViewVisible', { appId, viewId, visible }, '');
		},
		getNavigation: async (_c, appId) => rec('getNavigation', { appId }, structuredClone(server.nav.get(String(appOf(appId).dataAppId)))),
		reorderNavigation: async (_c, appId, items) => {
			const views = new Set(appOf(appId).views.map((v) => String(v.viewId)));
			const listed = items.filter((n) => n.entity === 'VIEW').map((n) => n.entityId);
			if (listed.length !== views.size || !listed.every((id) => views.has(id))) throw Object.assign(new Error('HTTP 400: every view must be listed'), { status: 400 });
			server.nav.set(String(appId), structuredClone(items));
			return rec('reorderNavigation', { appId, items }, items);
		},
		setLanding: async (_c, appId, viewId) => {
			const view = appOf(appId).views.find((v) => String(v.viewId) === String(viewId));
			if (!view) throw notFound(`view ${viewId}`);
			if (view.visible === false) throw badRequest('Only visible view can set as landing view');
			appOf(appId).landingViewId = viewId;
			return rec('setLanding', { appId, viewId }, '');
		},
		putPersistSettings: async (_c, appId, settings) => {
			server.persist.set(String(appId), settings);
			return rec('putPersistSettings', { appId, settings }, '');
		},
		deleteApp: async (_c, id) => {
			appOf(id);
			server.apps.delete(String(id));
			return rec('deleteApp', { id }, '');
		}
	};
	const probe = {
		appStudioStatus: async () => rec('appStudioStatus', {}, { available: flags['data-app'] === 'on', customer: 'acme', flags })
	};
	const writeLayout = stub.deps.pages.writeLayout;
	stub.deps.pages.writeLayout = async (c, pageId, layout) => {
		if (lockedLayouts.map(String).includes(String(pageId))) {
			calls.push({ name: 'writeLayout', args: { pageId, layout, locked: true } });
			const { LayoutLockedError } = await import('../../src/domo/pages.js');
			throw new LayoutLockedError(pageId + 5000, new Error('HTTP 403: WL002: Cannot overwrite another user\'s existing write lock'));
		}
		return writeLayout(c, pageId, layout);
	};
	stub.deps.variables = { upsertPageControl: async (_c, pageId, fn, control) => rec('upsertPageControl', { pageId, fn, control }, { id: 4000 + pageId }) };
	stub.deps.apps = apps;
	stub.deps.probe = probe;
	return { ...stub, server };
}
