import fs from 'node:fs';

const CLARION = JSON.parse(fs.readFileSync(new URL('../fixtures/clarion-theme.json', import.meta.url), 'utf8'));

/**
 * In-memory stand-in for the Domo endpoints push uses. Installs itself as
 * globalThis.fetch, records every call, and answers with plausible ids.
 */
export function installDomoServer({ host = 'acme.domo.com', federatedAccounts = {} } = {}) {
	const calls = [];
	const original = globalThis.fetch;
	let next = 1000;
	const id = () => next++;
	const datasets = new Map();
	const templates = new Map();
	const dataflows = new Map();
	const cards = new Map();
	const drillPaths = new Map();
	const dataFiles = new Map();
	const layoutsByPage = new Map();
	const layouts = new Map();
	const controls = new Map();
	const apps = new Map();
	const navigation = new Map();
	const filterViews = new Map();
	const pageDefaults = new Map();
	const newView = (app, title) => {
		const viewId = id();
		const layoutId = id();
		layouts.set(layoutId, { layoutId, pageUrn: String(viewId), content: [], standard: { template: [] }, compact: { template: [] } });
		layoutsByPage.set(String(viewId), layoutId);
		app.views.push({ viewId, title, visible: true, children: [] });
		const nav = navigation.get(app.dataAppId);
		nav.splice(nav.length - 1, 0, { entity: 'VIEW', entityId: String(viewId), title, visible: true });
		nav.forEach((n, i) => (n.navOrder = i + 1));
		return { view: { pageId: viewId, type: 'dataappview', title }, layout: layouts.get(layoutId) };
	};
	const app = (m) => apps.get(Number(m[1])) ?? { status: 404 };

	const federated = new Map();
	const fed = federatedAccounts;
	const routes = [
		['GET', /^\/federated\/v1\/config\/adapters$/, () => [{ adapterType: 'sql-server', providers: [{ providerType: 'sqlserver-federated', providerName: 'Username/Password', hasCloudAgent: true, hasOnPremiseAgent: false }] }]],
		['POST', /^\/search\/v1\/query$/, (b) => {
			const provider = b?.filters?.[0]?.value;
			const hits = Object.entries(fed).filter(([, a]) => a.provider === provider).map(([accountId, a]) => ({ databaseId: accountId, displayName: a.name, valid: true }));
			return { totalResultCount: hits.length, searchObjects: hits };
		}],
		['GET', /^\/data\/v1\/providers\/([^/]+)\/account\/(\d+)$/, (b, m) => (fed[m[2]]?.provider === m[1] ? { ...fed[m[2]].settings } : { status: 404 })],
		['GET', /^\/federated\/v2\/config\/accounts\/(\d+)\/databases$/, (b, m) => fed[m[1]]?.tree ?? { status: 404 }],
		['GET', /^\/federated\/v1\/config\/accounts\/(\d+)\/databases\/columns$/, (b, m, call) => ({ columns: fed[m[1]]?.columns?.[call.query.table] ?? [] })],
		['POST', /^\/federated\/v1\/config\/accounts\/(\d+)\/datasources$/, (b, m) => {
			const dataSourceId = `fed-${id()}`;
			federated.set(dataSourceId, { accountId: Number(m[1]), ...b });
			return { dataSourceId };
		}],
		['POST', /^\/federated\/v1\/config\/datasources\/([^/]+)$/, (b, m) => (federated.has(m[1]) ? Object.assign(federated.get(m[1]), b) : { status: 404 })],
		['GET', /^\/content\/v1\/datasources\/([^/]+)\/cards$/, () => []],
		['GET', /^\/data\/v1\/lineage\/DATA_SOURCE\/([^/]+)$/, () => ({})],
		['DELETE', /^\/data\/v3\/datasources\/([^/]+)$/, (b, m) => (federated.delete(m[1]) || datasets.delete(m[1]) ? {} : { status: 404 })],
		['GET', /^\/content\/v3\/customers\/current\/name$/, () => 'acme'],
		['GET', /^\/content\/v3\/customers\/acme\/features$/, () => [{ name: 'data-app', enabled: true }, { name: 'app-studio-persist', enabled: true }]],
		['POST', /^\/content\/v1\/dataapps$/, (b) => {
			const created = { navOrientation: 'TOP', showDomoNavigation: true, showNavigation: true, theme: { name: 'Clarion' }, ...b, dataAppId: id(), owners: [{ id: 1, type: 'USER' }], views: [] };
			apps.set(created.dataAppId, created);
			navigation.set(created.dataAppId, [{ entity: 'HOME', entityId: 'home', title: 'Home' }, { entity: 'MORE', entityId: 'more', title: 'More' }]);
			created.landingViewId = newView(created, 'App Page 1').view.pageId;
			return created;
		}],
		['GET', /^\/content\/v1\/dataapps\/themes$/, () => ({ default: [structuredClone(CLARION)], saved: null })],
		['GET', /^\/content\/v1\/dataapps\/(\d+)$/, (b, m) => app(m)],
		['PUT', /^\/content\/v1\/dataapps\/(\d+)$/, (b, m) => {
			const updated = { ...b, views: app(m).views };
			apps.set(Number(m[1]), updated);
			return updated;
		}],
		['POST', /^\/content\/v1\/dataapps\/(\d+)\/views$/, (b, m) => newView(app(m), b.title)],
		['PUT', /^\/content\/v1\/dataapps\/(\d+)\/views\/(\d+)\/name$/, (b, m) => {
			app(m).views.find((v) => String(v.viewId) === m[2]).title = b;
			return '';
		}],
		['DELETE', /^\/content\/v1\/dataapps\/(\d+)\/views\/(\d+)\/visible$/, (b, m) => {
			app(m).views.find((v) => String(v.viewId) === m[2]).visible = false;
			return '';
		}],
		['GET', /^\/content\/v1\/dataapps\/(\d+)\/navigation$/, (b, m) => navigation.get(Number(m[1]))],
		['PUT', /^\/content\/v1\/dataapps\/(\d+)\/navigation\/reorder$/, (b, m) => {
			navigation.set(Number(m[1]), b);
			return b;
		}],
		['PUT', /^\/content\/v1\/dataapps\/(\d+)\/landing\/(\d+)$/, (b, m) => {
			app(m).landingViewId = Number(m[2]);
			return '';
		}],
		['PUT', /^\/content\/v1\/dataapps\/(\d+)\/persistSettings$/, (b, m) => {
			app(m).persistSettings = b;
			return '';
		}],
		['POST', /^\/data\/v2\/datasources$/, (b) => {
			const dsId = `ds-${id()}`;
			datasets.set(dsId, { name: b.dataSourceName, schema: b.schema });
			return { dataSource: { dataSourceId: dsId } };
		}],
		['POST', /^\/data\/v2\/datasources\/([^/]+)\/schemas$/, () => ({})],
		['POST', /^\/data\/v3\/datasources\/([^/]+)\/uploads$/, () => ({ uploadId: id() })],
		['PUT', /^\/data\/v3\/datasources\/([^/]+)\/uploads\/(\d+)\/parts\/(\d+)$/, () => ({})],
		['PUT', /^\/data\/v3\/datasources\/([^/]+)\/uploads\/(\d+)\/commit$/, () => ({ indexing: { requestKey: `rk-${id()}` } })],
		['GET', /^\/data\/v3\/datasources\/([^/]+)\/indexes\/([^/]+)\/statuses$/, () => ({ progress: { status: 'SUCCESS' }, detail: { rowCount: 2 } })],
		['POST', /^\/dataprocessing\/v1\/dataflows$/, (b) => {
			const dfId = id();
			const actions = (b.actions ?? []).map((a) =>
				a.type === 'PublishToVault' && !a.dataSource?.guid ? { ...a, dataSource: { ...a.dataSource, guid: `ds-out-${id()}` } } : a
			);
			const flow = { ...b, id: dfId, actions };
			dataflows.set(String(dfId), flow);
			return flow;
		}],
		['GET', /^\/dataprocessing\/v1\/dataflows\/(\d+)$/, (b, m) => dataflows.get(m[1])],
		['PUT', /^\/dataprocessing\/v1\/dataflows\/(\d+)$/, (b, m) => {
			dataflows.set(m[1], b);
			return b;
		}],
		['POST', /^\/dataprocessing\/v1\/dataflows\/(\d+)\/executions$/, () => ({ id: id(), state: 'CREATED' })],
		['GET', /^\/dataprocessing\/v1\/dataflows\/(\d+)\/executions\/(\d+)$/, (b, m) => ({ id: Number(m[2]), state: 'SUCCESS' })],
		['POST', /^\/query\/v1\/functions\/validateFunctions$/, (b) => ({
			results: Object.fromEntries(Object.keys(b.functionTemplates).map((k) => [k, { status: 'VALID', dataType: 'DOUBLE', containsAggregation: false }]))
		})],
		['POST', /^\/query\/v1\/functions\/list$/, (b) => {
			const dsId = b.resources?.[0]?.id;
			const linked = [...templates.values()].filter((t) => t.links?.some((l) => l.resource?.id === dsId));
			return {
				objectMap: Object.fromEntries(linked.map((t) => [t.id, t])),
				resourceMapping: { [`DATA_SOURCE:${dsId}`]: linked.map((t) => t.id) }
			};
		}],
		['POST', /^\/query\/v1\/functions\/search$/, () => ({ results: [] })],
		['POST', /^\/query\/v1\/functions\/template$/, (b) => {
			const t = { ...b, id: id() };
			templates.set(t.id, t);
			return t;
		}],
		['PUT', /^\/query\/v1\/functions\/template\/(\d+)$/, (b, m) => {
			const t = { ...templates.get(Number(m[1])), ...b };
			templates.set(Number(m[1]), t);
			return t;
		}],
		['POST', /^\/content\/v1\/pages$/, () => ({ pageId: id() })],
		['POST', /^\/data\/v1\/data-files$/, () => {
			const dataFileId = id();
			dataFiles.set(dataFileId, { revisions: 1 });
			return { dataFileId };
		}],
		['PUT', /^\/data\/v1\/data-files\/(\d+)$/, (b, m) => {
			dataFiles.get(Number(m[1])).revisions += 1;
			return { revisionId: id() };
		}],
		['GET', /^\/data\/v1\/data-files\/(\d+)\/details$/, (b, m) => (dataFiles.has(Number(m[1])) ? { id: Number(m[1]), currentRevision: { id: dataFiles.get(Number(m[1])).revisions } } : { status: 404 })],
		['DELETE', /^\/data\/v1\/data-files\/(\d+)$/, (b, m) => (dataFiles.delete(Number(m[1])) ? {} : { status: 404 })],
		['POST', /^\/content\/v4\/pages\/(\d+)\/layouts\/background$/, () => {
			const dataFileId = id();
			dataFiles.set(dataFileId, { revisions: 1 });
			return { dataFileId };
		}],
		['POST', /^\/content\/v1\/cards\/notebook$/, (b) => {
			const cardId = id();
			cards.set(cardId, { ...b, type: 'Text' });
			return { id: cardId };
		}],
		['POST', /^\/content\/v1\/cards\/notebook\/(\d+)\/update$/, (b, m) => {
			cards.set(Number(m[1]), { ...cards.get(Number(m[1])), ...b });
			return { id: Number(m[1]) };
		}],
		['POST', /^\/content\/v1\/cards$/, (b) => {
			const cardId = id();
			cards.set(cardId, b);
			return { id: cardId, urn: String(cardId) };
		}],
		['PUT', /^\/content\/v1\/cards\/(\d+)$/, (b, m) => {
			cards.set(Number(m[1]), b);
			return { id: Number(m[1]) };
		}],
		['PUT', /^\/content\/v3\/cards\/kpi\/definition$/, (b) => {
			const card = cards.get(Number(b.urn));
			return { definition: card?.definition ?? {} };
		}],
		['PUT', /^\/content\/v3\/cards\/kpi$/, (b, m, call) => {
			const cardId = id();
			cards.set(cardId, b);
			const root = call.query.parentUrn;
			if (!root) return { id: cardId, urn: String(cardId) };
			drillPaths.set(root, [...(drillPaths.get(root) ?? []), cardId]);
			return { id: cardId, urn: `dr:${cardId}:${root}` };
		}],
		['PUT', /^\/content\/v3\/cards\/kpi\/dr:(\d+):(\d+)$/, (b, m) => {
			cards.set(Number(m[1]), b);
			return { id: Number(m[1]) };
		}],
		['GET', /^\/content\/v1\/cards$/, (b, m, call) =>
			String(call.query.urns ?? '').split(',').filter((u) => cards.has(Number(u))).map((u) => ({ id: Number(u), drillPathURNs: (drillPaths.get(u) ?? []).map((d) => `dr:${d}:${u}`) }))],
		['PUT', /^\/content\/v3\/cards\/kpi\/(\d+)$/, (b, m) => {
			cards.set(Number(m[1]), b);
			return { id: Number(m[1]) };
		}],
		['GET', /^\/content\/v4\/pages\/(\d+)\/layouts$/, (b, m) => {
			const layoutId = layoutsByPage.get(m[1]);
			return layoutId ? layouts.get(layoutId) : { status: 404 };
		}],
		['POST', /^\/content\/v4\/pages\/layouts$/, (b) => {
			const layoutId = id();
			const layout = { layoutId, pageUrn: b.pageUrn, content: [], standard: { template: [] }, compact: { template: [] } };
			layouts.set(layoutId, layout);
			layoutsByPage.set(String(b.pageUrn), layoutId);
			return layout;
		}],
		['PUT', /^\/content\/v4\/pages\/layouts\/(\d+)\/writelock$/, () => ({})],
		['DELETE', /^\/content\/v4\/pages\/layouts\/(\d+)\/writelock$/, () => ({})],
		['PUT', /^\/content\/v4\/pages\/layouts\/(\d+)$/, (b, m) => {
			layouts.set(Number(m[1]), b);
			return b;
		}],
		['GET', /^\/content\/v4\/pages\/layouts\/(\d+)$/, (b, m) => layouts.get(Number(m[1]))],
		['GET', /^\/content\/v1\/variable\/controls$/, (b, m, call) => {
			const fns = String(call.query.functionTemplateIds ?? '').split(',');
			return [...controls.values()].filter((x) => !x.entityType && fns.includes(String(x.function.id)));
		}],
		['PUT', /^\/content\/v1\/variable\/controls$/, (b) =>
			b.map((x) => {
				const saved = { ...x, id: x.id ?? id() };
				controls.set(saved.id, saved);
				return saved;
			})],
		['PUT', /^\/content\/v1\/variable\/controls\/PAGE\/(\d+)$/, (b, m) => {
			const saved = { ...b, id: b.id ?? id(), entityType: 'PAGE', entityId: m[1] };
			controls.set(saved.id, saved);
			return saved;
		}],
		['GET', /^\/content\/v1\/pages\/(\d+)\/variable\/controls\/list$/, (b, m) => [...controls.values()].filter((x) => x.entityId === m[1])],
		['GET', /^\/content\/v3\/pages\/(\d+)\/analyzer\/named$/, (b, m) =>
			[...filterViews.values()].filter((v) => v.pageUrn === m[1]).map(({ analyzerId, name, scope, pageUrn }) => ({ analyzerId, name, type: 'NAMED', scope, isDefault: pageDefaults.get(pageUrn) === analyzerId }))],
		['GET', /^\/content\/v3\/pages\/analyzer\/(\d+)$/, (b, m) => filterViews.get(Number(m[1])) ?? { status: 404 }],
		['POST', /^\/content\/v3\/pages\/(\d+)\/analyzer$/, (b, m) => {
			const view = { ...b, analyzerId: id(), pageUrn: m[1] };
			filterViews.set(view.analyzerId, view);
			return view;
		}],
		['PUT', /^\/content\/v3\/pages\/(\d+)\/analyzer$/, (b, m) => {
			filterViews.set(b.analyzerId, { ...b, pageUrn: m[1] });
			return b;
		}],
		['PUT', /^\/content\/v3\/pages\/(\d+)\/analyzer\/(\d+)\/global$/, (b, m) => {
			pageDefaults.set(m[1], Number(m[2]));
			return {};
		}],
		['DELETE', /^\/content\/v3\/pages\/analyzer\/(\d+)$/, (b, m) => {
			filterViews.delete(Number(m[1]));
			return {};
		}]
	];

	globalThis.fetch = async (url, init = {}) => {
		const method = init.method || 'GET';
		const u = new URL(url);
		const path = u.pathname.replace(/^\/api/, '');
		let body;
		if (typeof init.body === 'string') {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		const call = { method, host: u.host, path, query: Object.fromEntries(u.searchParams), body };
		calls.push(call);
		if (u.host !== host) throw new Error(`Unexpected host ${u.host} (${method} ${url})`);
		for (const [m, pattern, handler] of routes) {
			if (m !== method) continue;
			const match = path.match(pattern);
			if (!match) continue;
			const out = handler(body, match, call);
			if (out?.status === 404) return new Response('not found', { status: 404 });
			return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(`no route for ${method} ${path}`, { status: 501 });
	};

	return {
		calls,
		datasets,
		federated,
		templates,
		cards,
		dataFiles,
		layouts,
		controls,
		apps,
		navigation,
		filterViews,
		pageDefaults,
		reset() {
			calls.length = 0;
		},
		restore() {
			globalThis.fetch = original;
		}
	};
}
