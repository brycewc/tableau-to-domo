import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../util/http.js';

const LUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} value */
export function isLuid(value) {
	return typeof value === 'string' && LUID_RE.test(value.trim());
}

/**
 * Split equality clauses into a REST `filter` string and client-side predicates.
 * Tableau's filter syntax has no escaping, so values containing `,` or `:` are
 * matched client-side instead.
 * @param {Record<string, string|undefined>} clauses REST field name -> value
 * @returns {{ filter: string|undefined, clientSide: Record<string,string> }}
 */
export function buildFilter(clauses) {
	const parts = [];
	const clientSide = {};
	for (const [field, value] of Object.entries(clauses)) {
		if (value === undefined || value === null || value === '') continue;
		const text = String(value);
		if (/[,:]/.test(text) || text !== text.trim()) clientSide[field] = text;
		else parts.push(`${field}:eq:${text}`);
	}
	return { filter: parts.length ? parts.join(',') : undefined, clientSide };
}

const CLIENT_ACCESSORS = {
	name: (o) => o.name,
	projectName: (o) => o.project?.name,
	contentUrl: (o) => o.contentUrl,
	tags: (o) => asArray(o.tags?.tag).map((t) => t.label),
	parentProjectId: (o) => o.parentProjectId
};

function matchesClientSide(obj, clientSide) {
	return Object.entries(clientSide).every(([field, value]) => {
		const actual = (CLIENT_ACCESSORS[field] || ((o) => o[field]))(obj);
		return Array.isArray(actual) ? actual.includes(value) : actual === value;
	});
}

async function filteredList(client, relPath, collection, item, clauses) {
	const { filter, clientSide } = buildFilter(clauses);
	let items;
	try {
		items = await client.paginate(relPath, { collection, item, query: filter ? { filter } : {} });
	} catch (err) {
		if (!(filter && err instanceof HttpError && err.status === 400)) throw err;
		// Some fields are not filterable on older servers; fall back to filtering locally.
		items = await client.paginate(relPath, { collection, item });
		return items.filter((o) => matchesClientSide(o, { ...clientSide, ...nonEmpty(clauses) }));
	}
	return items.filter((o) => matchesClientSide(o, clientSide));
}

function nonEmpty(obj) {
	return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** Split a `project` option into a name filter or a project luid. */
function projectClauses(project) {
	if (!project) return { name: undefined, id: undefined };
	return isLuid(project) ? { name: undefined, id: project.trim() } : { name: project, id: undefined };
}

function byProjectId(items, projectId) {
	return projectId ? items.filter((o) => o.project?.id === projectId) : items;
}

/**
 * All projects on the site.
 * @param {import('./client.js').TableauClient} client
 */
export async function listProjects(client) {
	return client.paginate('/projects', { collection: 'projects', item: 'project' });
}

/**
 * Workbooks on the site, optionally filtered.
 * @param {import('./client.js').TableauClient} client
 * @param {{ project?: string, name?: string, tag?: string, contentUrl?: string }} [opts] project is a name or luid
 */
export async function listWorkbooks(client, { project, name, tag, contentUrl } = {}) {
	const p = projectClauses(project);
	const items = await filteredList(client, '/workbooks', 'workbooks', 'workbook', {
		name,
		projectName: p.name,
		tags: tag,
		contentUrl
	});
	return byProjectId(items, p.id);
}

/**
 * Published datasources on the site, optionally filtered.
 * @param {import('./client.js').TableauClient} client
 * @param {{ project?: string, name?: string, contentUrl?: string }} [opts] project is a name or luid
 */
export async function listDatasources(client, { project, name, contentUrl } = {}) {
	const p = projectClauses(project);
	const items = await filteredList(client, '/datasources', 'datasources', 'datasource', {
		name,
		projectName: p.name,
		contentUrl
	});
	return byProjectId(items, p.id);
}

function describeCandidates(items) {
	return items.map((o) => `"${o.name}" in project "${o.project?.name ?? '?'}" (${o.id})`).join('; ');
}

/**
 * Resolve one workbook by luid, name, or contentUrl. Throws when not found or ambiguous.
 * @param {import('./client.js').TableauClient} client
 * @param {string} nameOrLuid
 * @param {{ project?: string }} [opts]
 */
export async function findWorkbook(client, nameOrLuid, { project } = {}) {
	if (!nameOrLuid) throw new Error('findWorkbook: a workbook name or luid is required');
	if (isLuid(nameOrLuid)) {
		try {
			const json = await client.get(`/workbooks/${nameOrLuid.trim()}`);
			if (json?.workbook) return json.workbook;
		} catch (err) {
			if (!(err instanceof HttpError && (err.status === 404 || err.status === 400))) throw err;
		}
	}
	let matches = await listWorkbooks(client, { project, name: nameOrLuid });
	if (!matches.length) matches = await listWorkbooks(client, { project, contentUrl: nameOrLuid });
	if (!matches.length) {
		const where = project ? ` in project "${project}"` : '';
		throw new Error(`Tableau workbook "${nameOrLuid}" not found${where}. Names are case-sensitive; a luid or contentUrl also works.`);
	}
	if (matches.length > 1) {
		throw new Error(`Tableau workbook name "${nameOrLuid}" is ambiguous: ${describeCandidates(matches)}. Pass --project or the workbook luid.`);
	}
	return matches[0];
}

/**
 * Resolve one published datasource. Returns null when nothing matches; throws when ambiguous.
 * @param {import('./client.js').TableauClient} client
 * @param {{ luid?: string, name?: string, contentUrl?: string, project?: string }} criteria
 */
export async function findDatasource(client, { luid, name, contentUrl, project } = {}) {
	if (luid) {
		try {
			const json = await client.get(`/datasources/${luid}`);
			if (json?.datasource) return json.datasource;
		} catch (err) {
			if (!(err instanceof HttpError && (err.status === 404 || err.status === 400))) throw err;
		}
		if (!name && !contentUrl) return null;
	}
	let matches = [];
	if (contentUrl) matches = await listDatasources(client, { project, contentUrl });
	if (!matches.length && name) matches = await listDatasources(client, { project, name });
	if (matches.length > 1 && contentUrl) {
		const narrowed = matches.filter((d) => d.contentUrl === contentUrl);
		if (narrowed.length) matches = narrowed;
	}
	if (!matches.length) return null;
	if (matches.length > 1) {
		throw new Error(`Tableau datasource "${name || contentUrl}" is ambiguous: ${describeCandidates(matches)}. Pass the project or luid.`);
	}
	return matches[0];
}

/**
 * Views (worksheets and dashboards) published from a workbook.
 * @param {import('./client.js').TableauClient} client
 * @param {string} workbookLuid
 */
export async function listWorkbookViews(client, workbookLuid) {
	const json = await client.get(`/workbooks/${workbookLuid}/views`);
	return asArray(json?.views?.view);
}

/**
 * Server, port and user name of a workbook's or published datasource's connections. Tableau never returns the
 * password, only whether one is embedded.
 * @param {import('./client.js').TableauClient} client
 * @param {{ workbook?: string, datasource?: string }} owner  luid
 * @returns {Promise<{ type?: string, serverAddress?: string, serverPort?: string, userName?: string, embedPassword?: boolean, datasourceName?: string }[]>}
 */
export async function listConnections(client, { workbook, datasource }) {
	const json = await client.get(workbook ? `/workbooks/${workbook}/connections` : `/datasources/${datasource}/connections`);
	return asArray(json?.connections?.connection).map((c) => ({
		...(c.type ? { type: c.type } : {}),
		...(c.serverAddress ? { serverAddress: c.serverAddress } : {}),
		...(c.serverPort ? { serverPort: String(c.serverPort) } : {}),
		...(c.userName ? { userName: c.userName } : {}),
		...(c.embedPassword !== undefined ? { embedPassword: c.embedPassword === true || c.embedPassword === 'true' } : {}),
		...(c.datasource?.name ? { datasourceName: c.datasource.name } : {})
	}));
}

/**
 * Download a workbook (.twbx or .twb) into destDir.
 * @param {import('./client.js').TableauClient} client
 * @param {string} luid
 * @param {string} destDir
 * @param {{ includeExtract?: boolean }} [opts]
 * @returns {Promise<{ file: string, filename: string|null, bytes: number }>}
 */
export async function downloadWorkbook(client, luid, destDir, { includeExtract = true } = {}) {
	return downloadContent(client, `/workbooks/${luid}/content`, destDir, luid, ['twb', 'twbx'], includeExtract);
}

/**
 * Download a published datasource (.tdsx or .tds) into destDir.
 * @param {import('./client.js').TableauClient} client
 * @param {string} luid
 * @param {string} destDir
 * @param {{ includeExtract?: boolean }} [opts]
 * @returns {Promise<{ file: string, filename: string|null, bytes: number }>}
 */
export async function downloadDatasource(client, luid, destDir, { includeExtract = true } = {}) {
	return downloadContent(client, `/datasources/${luid}/content`, destDir, luid, ['tds', 'tdsx'], includeExtract);
}

async function downloadContent(client, relPath, destDir, luid, [xmlExt, zipExt], includeExtract) {
	await fs.promises.mkdir(destDir, { recursive: true });
	const pick = (filename, contentType) => {
		const fallbackExt = /xml/i.test(contentType || '') ? xmlExt : zipExt;
		return path.join(destDir, safeFileName(filename, `${luid}.${fallbackExt}`, [xmlExt, zipExt], fallbackExt));
	};
	return client.download(relPath, pick, { includeExtract: includeExtract ? 'true' : 'false' });
}

/**
 * Sanitize a server-provided filename to a basename with an expected extension.
 * @param {string|null} filename
 * @param {string} fallback
 * @param {string[]} allowedExts
 * @param {string} defaultExt
 */
export function safeFileName(filename, fallback, allowedExts, defaultExt) {
	if (!filename) return fallback;
	const printable = [...String(filename)].map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch)).join('');
	let base = path.basename(printable.replace(/\\/g, '/'))
		.replace(/[<>:"/\\|?*]/g, '_')
		.replace(/^\.+/, '')
		.trim();
	if (!base) return fallback;
	const ext = path.extname(base).slice(1).toLowerCase();
	if (!allowedExts.includes(ext)) base = `${base}.${defaultExt}`;
	return base.length > 200 ? base.slice(base.length - 200) : base;
}

function asArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}
