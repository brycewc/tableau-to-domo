import fs from 'node:fs';
import path from 'node:path';
import { createEmitter } from '../../util/events.js';
import { slugify, shortHash } from '../../util/ids.js';
import { stripBrackets, domoColumnName, dedupeNames } from '../../model/naming.js';
import { hyperToDomoType, isHyperBoolean } from '../../convert/schema.js';
import { checkHyper, exportHyper } from './hyper.js';
import { exportPublishedDatasource } from './vds.js';
import { exportViewCsv } from './view-csv.js';
import { reformatCsv } from './csv-writer.js';
import { matchCloudAmplifier, mappingSnippet, planTargets } from './cloud-amplifier.js';
import { planDatasourceInitialSql, initialSqlBlockedMessage } from '../../convert/initial-sql.js';
import { cacheTtlOf, federatedConnection, findFederatedMapping, planFederatedTargets } from './federated.js';
import { federatedProviders, findInTree } from '../../domo/federated.js';

export { checkHyper, exportHyper, detectPython, resolvePythonPath } from './hyper.js';
export { exportPublishedDatasource } from './vds.js';
export { exportViewCsv } from './view-csv.js';
export { matchCloudAmplifier, createBrowser, cloudAmplifierEngines, findCloudAmplifierMapping } from './cloud-amplifier.js';
export { parseSqlTableRefs } from './sql-refs.js';
export { findFederatedMapping, planFederatedTargets, federatedEntry } from './federated.js';

const STRATEGIES = ['auto', 'existing', 'cloud-amplifier', 'federated', 'connector', 'hyper', 'published-extract', 'vds', 'view-csv', 'none'];
const NON_CONNECTOR_CLASSES = new Set([
	'hyper',
	'dataengine',
	'sqlproxy',
	'excel',
	'excel-direct',
	'textscan',
	'textclean',
	'ogrdirect',
	'csv',
	'pdf',
	'json',
	'statfile',
	'spatial'
]);

/**
 * Stable folder name for a datasource's data files. The hash keeps two
 * datasources with the same caption apart.
 * @param {import('../../model/types.js').DatasourceIR} datasource
 */
export function datasourceSlug(datasource) {
	return `${slugify(datasource.caption || stripBrackets(datasource.id))}-${shortHash(datasource.id).slice(0, 6)}`;
}

/**
 * Mapped Domo dataset id for a datasource (by caption, published luid/name/contentUrl, or internal name).
 * @param {import('../../model/types.js').DatasourceIR} datasource
 * @param {Partial<import('../../model/types.js').Mappings>} [mappings]
 * @returns {string|undefined}
 */
export function findExistingDataset(datasource, mappings) {
	const datasets = mappings?.datasets || {};
	const keys = [
		datasource.caption,
		datasource.published?.luid,
		datasource.published?.name,
		datasource.published?.repositoryId,
		datasource.id
	].filter(Boolean);
	for (const key of keys) {
		if (datasets[key] !== undefined && datasets[key] !== null && datasets[key] !== '') return String(datasets[key]);
	}
	return undefined;
}

/**
 * The recorded `mappings.unmapped` choice for a datasource that no mapping covers: 'export' or 'none'.
 * @param {import('../../model/types.js').DatasourceIR} datasource
 * @param {Partial<import('../../model/types.js').Mappings>} [mappings]
 * @returns {'export'|'none'|undefined}
 */
export function findUnmappedDecision(datasource, mappings) {
	const unmapped = mappings?.unmapped ?? {};
	for (const key of [datasource.published?.luid, datasource.caption, datasource.published?.name, datasource.published?.repositoryId, datasource.id].filter(Boolean)) {
		const value = String(unmapped[key] ?? '').toLowerCase();
		if (value === 'export' || value === 'none') return value;
	}
	return undefined;
}

/** `mappings.customSql` is keyed like `datasets`, then by the Tableau name of the Custom SQL table. */
export function applyCustomSqlOverrides(source, datasource, mappings, issue) {
	const all = mappings?.customSql ?? {};
	const key = [datasource.published?.luid, datasource.caption, datasource.published?.name, datasource.published?.repositoryId, datasource.id].find((k) => k && all[k]);
	if (!key) return source;
	const overrides = all[key];
	let changed = false;
	const tables = (source.tables ?? []).map((t) => {
		const sql = t.kind === 'custom-sql' ? (overrides[t.name] ?? overrides[t.id]) : undefined;
		if (!sql) return t;
		changed = true;
		issue?.('info', 'data.custom-sql-override', `Custom SQL '${t.name || t.id}' replaced by mappings.json customSql: ${sql.replace(/\s+/g, ' ').trim()}`);
		return { ...t, sql };
	});
	return changed ? { ...source, tables } : source;
}

function sameValue(a, b) {
	return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * First live connection with a matching account mapping. Every key given in
 * `match` must equal the connection's value (case-insensitive).
 * @param {import('../../model/types.js').DatasourceIR} datasource
 * @param {Partial<import('../../model/types.js').Mappings>} [mappings]
 * @returns {{ connection: import('../../model/types.js').ConnectionIR, account: import('../../model/types.js').Mappings['accounts'][number] }|undefined}
 */
export function findConnectorMatch(datasource, mappings) {
	const accounts = mappings?.accounts || [];
	if (!accounts.length || datasource.published) return undefined;
	for (const connection of datasource.connections || []) {
		if (!connection?.class || NON_CONNECTOR_CLASSES.has(connection.class.toLowerCase())) continue;
		for (const account of accounts) {
			const entries = Object.entries(account?.match || {}).filter(([, v]) => v !== undefined && v !== '');
			if (!entries.length) continue;
			if (entries.every(([key, value]) => sameValue(connection[key], value))) return { connection, account };
		}
	}
	return undefined;
}

const hyperChecks = new Map();
function cachedCheckHyper(python) {
	if (!hyperChecks.has(python)) {
		const check = checkHyper(python).then((result) => {
			if (!result.ok) hyperChecks.delete(python);
			return result;
		});
		hyperChecks.set(python, check);
	}
	return hyperChecks.get(python);
}

function hasPackagedExtract(datasource, pkg) {
	return Boolean(pkg && datasource.extract?.enabled && datasource.extract.hyperFiles?.length);
}

/**
 * Extract the data behind one Tableau datasource and describe it.
 *
 * Writes `data/<datasourceSlug>/<table>.csv` (Domo column names as the header)
 * and `data/<datasourceSlug>.manifest.json` under `dir`. Strategy failures are
 * returned as issues with strategy 'none'; only programming errors throw.
 *
 * @param {Object} opts
 * @param {import('../client.js').TableauClient} [opts.client]
 * @param {import('../../model/types.js').WorkbookIR} [opts.ir]
 * @param {import('../../model/types.js').DatasourceIR} opts.datasource
 * @param {{ entries?: any[], extractEntry: (entry: any, destFile: string) => Promise<any> }} [opts.pkg]
 * @param {string} opts.dir                       Workbook directory; manifest file paths are relative to it
 * @param {import('../../model/types.js').DataStrategy|'auto'} [opts.strategy='auto']
 * @param {Partial<import('../../model/types.js').Mappings>} [opts.mappings]
 * @param {string} [opts.python='python3']
 * @param {import('../../util/events.js').Emitter} [opts.emitter]
 * @param {import('../../util/timing.js').Timer} [opts.timer]  Records download, Hyper export and CSV steps
 * @param {{ id: string, name: string }[]} [opts.views]   Workbook views; fetched with listWorkbookViews when omitted
 * @param {{ rowLimit?: number }} [opts.vds]
 * @param {{ getIntegrations?: () => Promise<import('../../domo/cloud-amplifier.js').Integration[]|null>, browser?: ReturnType<typeof import('./cloud-amplifier.js').createBrowser>|null }} [opts.cloudAmplifier]
 *   Read-only Domo lookups for the cloud-amplifier strategy; omit to match only through mappings.cloudAmplifier.
 * @param {string} [opts.slug]  Data folder and manifest name (default datasourceSlug(datasource))
 * @param {boolean} [opts.skipViewCsv]  auto never falls back to view-csv (data shared by several workbooks must not come from one workbook's views)
 * @param {import('../../model/types.js').DatasourceIR} [opts.published]  The published datasource's .tds, already read
 *   with readPublishedDatasource; cloud-amplifier and connector then skip their own download
 * @param {'export'|'ask'} [opts.unmapped='export']  'ask': under auto, a datasource that would become a snapshot and has no
 *   `mappings.unmapped` choice returns strategy 'pending' with a `decision`, and nothing is written. 'ask' also lets a mapped
 *   account replace a Tableau extract.
 * @param {boolean} [opts.planOnly]  Stop before any snapshot download: a decided snapshot returns strategy 'deferred'
 * @param {boolean} [opts.snapshotOnly]  Skip existing, cloud-amplifier and connector (a run that already tried them)
 * @param {import('../../model/types.js').Issue[]} [opts.priorIssues]  Issues of that earlier run, kept first
 * @returns {Promise<import('../../model/types.js').DataManifest>}
 */
export async function extractData(opts) {
	const { datasource, dir, strategy = 'auto', mappings = {}, python = 'python3' } = opts;
	if (!datasource) throw new Error('extractData needs a datasource');
	if (!dir) throw new Error('extractData needs dir');
	if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown data strategy "${strategy}" (expected ${STRATEGIES.join(', ')})`);
	const emitter = opts.emitter || createEmitter(undefined, 'extract');
	const slug = opts.slug || datasourceSlug(datasource);
	const object = { type: 'datasource', name: datasource.caption || datasource.id, id: datasource.id };
	const ctx = { ...opts, emitter, slug, object, mappings, python, issues: [...(opts.priorIssues ?? [])] };
	const issue = (severity, code, message, suggestion) =>
		ctx.issues.push({ severity, code, message, object, ...(suggestion ? { suggestion } : {}) });
	ctx.issue = issue;
	ctx.time = (step, fn, meta) => (opts.timer ? opts.timer.time(step, fn, meta, { name: object.name }) : fn());

	const manifest = await resolve(ctx, strategy);
	if (manifest.strategy === 'pending' || manifest.strategy === 'deferred') {
		manifest.issues = ctx.issues;
		return manifest;
	}
	if (strategy !== 'none') noteMixedSources(ctx, manifest);
	manifest.issues = [...ctx.issues, ...(manifest.issues || [])];
	const manifestFile = path.join(dir, 'data', `${slug}.manifest.json`);
	await fs.promises.mkdir(path.dirname(manifestFile), { recursive: true });
	await fs.promises.writeFile(manifestFile, `${JSON.stringify(manifest, null, '\t')}\n`);
	emitter.info(`Data for "${object.name}": ${manifest.strategy}`, {
		datasourceId: datasource.id,
		strategy: manifest.strategy,
		tables: manifest.tables.length,
		rows: manifest.tables.reduce((sum, t) => sum + t.rowCount, 0)
	});
	return manifest;
}

async function resolve(ctx, strategy) {
	const { datasource } = ctx;
	const base = { datasourceId: datasource.id, tables: [], issues: [] };

	if (strategy === 'none') {
		ctx.issue('warning', 'data.skipped', 'Data extraction was skipped (strategy none); no dataset data will be uploaded.');
		return { ...base, strategy: 'none' };
	}

	if (ctx.snapshotOnly && strategy === 'auto') {
		const gate = await snapshotGate(ctx);
		return gate ? { ...base, ...gate } : resolveSnapshot(ctx, strategy, base);
	}

	if (strategy === 'auto' || strategy === 'existing') {
		const existingDatasetId = findExistingDataset(datasource, ctx.mappings);
		if (existingDatasetId) {
			ctx.issue('info', 'data.existing', `Using existing Domo dataset ${existingDatasetId} from mappings.datasets.`);
			return { ...base, strategy: 'existing', existingDatasetId };
		}
		if (strategy === 'existing') {
			return none(ctx, 'data.existing-missing', 'No mappings.datasets entry matches this datasource caption or luid.', 'Add "<caption or luid>": "<Domo dataset id>" to mappings.json datasets.');
		}
	}

	if (strategy === 'auto' || strategy === 'cloud-amplifier') {
		const result = await tryCloudAmplifier(ctx, strategy === 'cloud-amplifier');
		if (result) return { ...base, ...result };
		if (strategy === 'cloud-amplifier') return none(ctx);
	}

	if (strategy === 'auto' || strategy === 'federated') {
		const result = await tryFederated(ctx, strategy === 'federated');
		if (result) return { ...base, ...result };
		if (strategy === 'federated') return none(ctx);
	}

	if (strategy === 'auto' || strategy === 'connector') {
		const result = await tryConnector(ctx, strategy === 'connector');
		if (result) return { ...base, ...result };
		if (strategy === 'connector') return none(ctx);
	}

	if (strategy === 'auto') {
		const gate = await snapshotGate(ctx);
		if (gate) return { ...base, ...gate };
	}
	return resolveSnapshot(ctx, strategy, base);
}

async function snapshotGate(ctx) {
	const base = { datasourceId: ctx.datasource.id, tables: [] };
	const recorded = findUnmappedDecision(ctx.datasource, ctx.mappings);
	if (recorded === 'none') {
		ctx.issue('info', 'data.unmapped-none', 'No data, as chosen in mappings.json unmapped; the DataSet keeps the Tableau field schema.');
		return { ...base, strategy: 'none' };
	}
	if (recorded !== 'export' && ctx.unmapped === 'ask') return { ...base, strategy: 'pending', decision: await pendingDecision(ctx) };
	if (ctx.planOnly) return { ...base, strategy: 'deferred' };
	return undefined;
}

function likelySnapshots(ctx, source) {
	const { datasource, pkg, client } = ctx;
	const out = [];
	if (hasPackagedExtract(datasource, pkg)) out.push('hyper');
	if (datasource.published?.luid && client) out.push(...(source?.extract?.enabled ? ['published-extract', 'vds'] : ['vds']));
	if (client && ctx.ir?.workbook?.luid && !ctx.skipViewCsv) out.push('view-csv');
	return out;
}

const DECISION_CONNECTION_KEYS = ['class', 'server', 'port', 'dbname', 'schema', 'warehouse', 'service', 'authentication'];

async function pendingDecision(ctx) {
	const { datasource } = ctx;
	let source = ctx.physicalSource ?? ctx.published ?? null;
	if (!source && datasource.published?.luid && ctx.client) source = await readPublishedTds(ctx).catch(() => null);
	source ??= datasource;
	const connections = (source.connections ?? [])
		.filter((c) => c?.class && !NON_CONNECTOR_CLASSES.has(c.class.toLowerCase()))
		.map((c) => Object.fromEntries(DECISION_CONNECTION_KEYS.filter((k) => c[k] !== undefined && c[k] !== '').map((k) => [k, c[k]])));
	const tables = (source.tables ?? []).map((t) => t.relation ?? t.table ?? t.name).filter(Boolean);
	return {
		datasource: { id: datasource.id, caption: datasource.caption, ...(datasource.published ? { published: { luid: datasource.published.luid, name: datasource.published.name } } : {}) },
		connections,
		...(tables.length ? { tables: [...new Set(tables)].slice(0, 20) } : {}),
		extract: Boolean(source.extract?.enabled || datasource.extract?.enabled),
		snapshot: likelySnapshots(ctx, source),
		...connectorBlock(ctx, source),
		...(await federatedBlock(ctx, source)),
		...(ctx.cloudAmplifierBlocked ? { cloudAmplifierBlocked: ctx.cloudAmplifierBlocked } : {}),
		...(ctx.caSuggestions?.length && !ctx.cloudAmplifierBlocked ? { cloudAmplifier: ctx.caSuggestions } : {})
	};
}

async function federatedBlock(ctx, source) {
	if (ctx.federatedBlocked) return { federatedBlocked: ctx.federatedBlocked };
	const connection = federatedConnection(source);
	if (connection && !federatedProviders(connection.class).length) return { federatedBlocked: { reason: `Domo has no federated provider for ${connection.class}` } };
	const multi = (source.tables ?? []).length > 1;
	const viewsEnabled = multi && ctx.federated?.viewsEnabled ? await ctx.federated.viewsEnabled().catch(() => null) : multi ? null : false;
	const planned = planFederatedTargets(source, { viewsEnabled, fields: ctx.datasource.fields });
	return planned.ineligible ? { federatedBlocked: { reason: planned.ineligible } } : {};
}

function connectorBlock(ctx, source) {
	if (ctx.connectorBlocked) return { connectorBlocked: ctx.connectorBlocked };
	const blocked = planDatasourceInitialSql(source).find((p) => p.plan.blocked);
	return blocked ? { connectorBlocked: { reason: initialSqlBlockedMessage(blocked.plan.blocked) } } : {};
}

async function resolveSnapshot(ctx, strategy, base) {
	if (strategy === 'auto' || strategy === 'hyper') {
		const result = await tryHyper(ctx, strategy === 'hyper');
		if (result) return { ...base, ...result };
		if (strategy === 'hyper') return none(ctx);
	}

	if (strategy === 'auto' || strategy === 'published-extract') {
		const result = await tryPublishedExtract(ctx, strategy === 'published-extract');
		if (result) return { ...base, ...result };
		if (strategy === 'published-extract') return none(ctx);
	}

	if (strategy === 'auto' || strategy === 'vds') {
		const result = await tryVds(ctx, strategy === 'vds');
		if (result) return { ...base, ...result };
		if (strategy === 'vds') return none(ctx);
	}

	const result = ctx.skipViewCsv && strategy === 'auto' ? undefined : await tryViewCsv(ctx, strategy === 'view-csv');
	if (result) return { ...base, ...result };
	if (strategy === 'view-csv') return none(ctx);
	return none(
		ctx,
		'data.none',
		`No data strategy worked for this datasource: no mapping, no matching connector account, no usable extract${ctx.client ? ', and neither the published datasource (download or VizQL Data Service) nor the views could be exported' : ', and no Tableau sign-in to export a published datasource or views'}.`,
		'Map it to an existing Domo dataset in mappings.json, add a connector account mapping, or download the workbook with its extract.'
	);
}

const SNAPSHOT_STRATEGIES = new Set(['hyper', 'published-extract', 'vds', 'view-csv', 'none']);

/** Explain why a datasource joining several kinds of source gets a snapshot, and what keeps it live. */
function noteMixedSources(ctx, manifest) {
	if (!SNAPSHOT_STRATEGIES.has(manifest.strategy)) return;
	const source = ctx.physicalSource ?? ctx.datasource;
	const conns = (source.connections ?? []).filter((c) => c?.class && !NON_CONNECTOR_CLASSES.has(c.class.toLowerCase()));
	const classes = [...new Set(conns.map((c) => c.class.toLowerCase()))];
	if (classes.length < 2) return;
	const tables = (c) => (source.tables ?? []).filter((t) => t.connectionId === c.id || (!t.connectionId && conns.length === 1)).map((t) => t.relation ?? t.name);
	const parts = conns.map((c) => `${c.class}${c.server ? ` ${c.server}` : ''}${c.dbname ? `/${c.dbname}` : ''} (${tables(c).join(', ') || 'no tables'})`);
	const result = manifest.strategy === 'none' ? 'no data could be extracted' : `the data is a ${manifest.strategy} snapshot, refreshed only by extracting and pushing again`;
	const salesforce = classes.includes('salesforce');
	const steps = [
		...(salesforce ? [`a Salesforce connector DataSet per Salesforce object (${conns.filter((c) => c.class.toLowerCase() === 'salesforce').flatMap(tables).join(', ') || 'see the report'}), with the fields the workbook uses`] : []),
		`the ${classes.filter((k) => k !== 'salesforce').join(', ')} tables as Cloud Amplifier DataSets or connector streams`,
		'a Magic ETL DataFlow that joins them the way Tableau does (plan.json dataflows shows the joins t2d planned over the snapshot)',
		`then map the DataFlow output in mappings.json datasets ("${ctx.datasource.published?.luid ?? ctx.datasource.caption}": "<DataSet id>") and run extract and push again`
	];
	ctx.issue(
		'warning',
		'data.mixed-sources',
		`This datasource combines ${classes.length} kinds of connection: ${parts.join('; ')}. Cloud Amplifier and connector streams each recreate one warehouse${salesforce ? ', and Salesforce is read by object, not SQL' : ''}, so ${result}.`,
		`To keep it live, set up in Domo by hand: ${steps.join('; ')}.`
	);
}

function none(ctx, code, message, suggestion) {
	if (code) ctx.issue('error', code, message, suggestion);
	return { datasourceId: ctx.datasource.id, strategy: 'none', tables: [], issues: [] };
}

function relativePath(dir, file) {
	return path.relative(dir, file).split(path.sep).join('/');
}

async function freshDataDir(ctx, keep = []) {
	const dataDir = path.join(ctx.dir, 'data', ctx.slug);
	if (!keep.length) {
		await fs.promises.rm(dataDir, { recursive: true, force: true });
	} else {
		const names = await fs.promises.readdir(dataDir).catch(() => []);
		for (const name of names.filter((n) => !keep.includes(n))) {
			await fs.promises.rm(path.join(dataDir, name), { recursive: true, force: true });
		}
	}
	await fs.promises.mkdir(dataDir, { recursive: true });
	return dataDir;
}

function uniqueFileNamer() {
	const used = new Set();
	return (name) => {
		const base = slugify(name);
		let candidate = base;
		for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
		used.add(candidate);
		return `${candidate}.csv`;
	};
}

function columnOverride(ctx, fieldName) {
	return ctx.mappings?.columns?.[`${ctx.datasource.caption}.${fieldName}`];
}

/* Cloud Amplifier */

function readPublishedTds(ctx) {
	ctx.publishedTds ??= (ctx.published ? Promise.resolve(structuredClone(ctx.published)) : downloadPublishedTds(ctx)).then(
		(published) => (ctx.physicalSource = published),
		(err) => {
			ctx.publishedTds = undefined;
			throw err;
		}
	);
	return ctx.publishedTds;
}

function downloadPublishedTds(ctx) {
	const { datasource } = ctx;
	const luid = datasource.published.luid;
	ctx.emitter.step(`Reading the connections of published datasource ${datasource.published?.name || datasource.caption || luid}`);
	return ctx.time('datasource.tds-download', () => readPublishedDatasource(ctx.client, luid, path.join(ctx.dir, 'data', '.ca-download')));
}

/**
 * Download a published datasource without its extract and parse its .tds (connections, tables, field definitions).
 * @param {import('../client.js').TableauClient} client
 * @param {string} luid
 * @param {string} tmpDir  Scratch directory, removed afterwards
 * @returns {Promise<import('../../model/types.js').DatasourceIR>}
 */
export async function readPublishedDatasource(client, luid, tmpDir) {
	let pkg;
	try {
		const { downloadDatasource } = await import('../content.js');
		const downloaded = await downloadDatasource(client, luid, path.join(tmpDir, slugify(luid)), { includeExtract: false });
		const [{ openPackage }, { buildDatasourceIR }] = await Promise.all([import('../package.js'), import('../twb/index.js')]);
		pkg = await openPackage(downloaded.file);
		return buildDatasourceIR(pkg.xml);
	} finally {
		if (pkg) await Promise.resolve(pkg.close?.()).catch(() => {});
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/* Federated */

const targetLabel = (t) => [t.catalog, t.schema, t.table].filter(Boolean).join('.');

async function tryFederated(ctx, explicit) {
	const { datasource, mappings } = ctx;
	const fail = (severity, code, message, suggestion) => {
		ctx.issue(explicit ? 'error' : severity, code, message, suggestion);
		return undefined;
	};
	const missing = () =>
		explicit ? fail('error', 'data.federated-missing', 'No mappings.json federated entry matches the connection of this datasource.', 'Add { "match": { "class", "server", "dbname" }, "accountId": <federated account id> } to federated (t2d list federated shows the accounts).') : undefined;
	if (!(mappings?.federated ?? []).length) return missing();
	let source = datasource;
	let published = null;
	if (datasource.published) {
		if (!datasource.published.luid || !ctx.client) {
			return explicit ? fail('error', 'data.federated-unavailable', "Reading a published datasource's connections needs a Tableau sign-in and a resolved luid.") : undefined;
		}
		try {
			published = await readPublishedTds(ctx);
			source = published;
		} catch (err) {
			return fail('warning', 'data.federated-tds', `Could not read the published datasource's connections for federated matching: ${err.message}`, 'The PAT user needs the Download Data Source capability.');
		}
	}
	const connection = federatedConnection(source);
	const mapping = connection ? findFederatedMapping(connection, mappings) : undefined;
	if (!mapping || mapping.accountId === false || mapping.accountId == null || mapping.accountId === '') return missing();
	const multi = (source.tables ?? []).length > 1;
	const viewsEnabled = multi && ctx.federated?.viewsEnabled ? await ctx.federated.viewsEnabled().catch(() => null) : multi ? null : false;
	const planned = planFederatedTargets(source, { mapping, viewsEnabled, fields: datasource.fields });
	if (planned.ineligible) {
		ctx.federatedBlocked = { reason: planned.ineligible };
		return fail('warning', 'data.federated-ineligible', `Federated account ${mapping.accountId} not used: ${planned.ineligible}.`, 'The next data strategy is used instead.');
	}
	const accountId = mapping.accountId;
	if (ctx.federated?.browse) {
		const tree = await ctx.federated.browse(accountId);
		if (tree.ok) {
			for (const target of planned.targets) {
				const found = findInTree(tree.value, target);
				if (!found) {
					ctx.federatedBlocked = { reason: `federated account ${accountId} does not list ${targetLabel(target)}` };
					return fail('warning', 'data.federated-missing-table', `Federated account ${accountId} does not list ${targetLabel(target)}, so it cannot read table '${target.name}'.`, 'Check the account in Domo, or the databases rename in the mappings.json federated entry.');
				}
				Object.assign(target, found, { verified: true });
			}
		} else {
			ctx.issue('warning', 'data.federated-unverified', `Could not browse federated account ${accountId} (${tree.reason}); the table names are not confirmed, so the DataSet create fails at push if they are wrong.`);
		}
	}
	if (published) usePublishedPhysicalLayer(ctx, published);
	const providerKey = mapping.providerKey ?? federatedProviders(connection.class)[0];
	const cacheTTL = cacheTtlOf(mapping);
	ctx.issue(
		'info',
		'data.federated',
		`Federated through account ${accountId} (${providerKey}): ${planned.targets.map(targetLabel).join(', ')}, cached ${cacheTTL} s. No data is copied; Domo queries the database live.${datasource.extract?.enabled || published?.extract?.enabled ? ' The Tableau extract is bypassed, so extract filters and aggregation do not apply.' : ''}`
	);
	return {
		strategy: 'federated',
		tables: [],
		federated: { accountId, providerKey, cacheTTL, connection: { class: connection.class, ...(connection.server ? { server: connection.server } : {}), ...(connection.dbname ? { dbname: connection.dbname } : {}) }, tables: planned.targets, ...(multi ? { views: true } : {}) }
	};
}

/* Connector */

async function tryConnector(ctx, explicit) {
	const { datasource, mappings } = ctx;
	const missing = () => {
		if (explicit) ctx.issue('error', 'data.connector-missing', 'No mappings.accounts entry matches a live connection of this datasource.', 'Add an accounts entry with match { class, server, dbname } and the Domo accountId.');
		return undefined;
	};
	const found = (connection, account, source) => {
		const initial = planDatasourceInitialSql(source);
		const blocked = initial.find((p) => p.plan.blocked);
		if (blocked) {
			ctx.connectorBlocked = { reason: initialSqlBlockedMessage(blocked.plan.blocked) };
			ctx.issue(explicit ? 'error' : 'warning', 'data.connector-initial-sql', `Not recreated as a Domo connector: ${ctx.connectorBlocked.reason}`, 'Export a snapshot instead (answer e at the data decision, or add "unmapped": { "<datasource>": "export" } to mappings.json).');
			return undefined;
		}
		const reads = initial.filter((p) => p.plan.tables.size);
		ctx.issue('info', 'data.connector', `Live ${connection.class} connection will be recreated as a Domo connector with account ${account.accountId}${reads.length ? `; its Initial SQL becomes ${reads.reduce((n, p) => n + p.plan.streams.length, 0)} connector stream(s) and Magic ETL` : ''}; no data was extracted.`);
		return { strategy: 'connector' };
	};
	if (!(mappings?.accounts ?? []).length) return missing();
	if (!datasource.published) {
		const match = explicit || ctx.unmapped === 'ask' || !datasource.extract?.enabled ? findConnectorMatch(datasource, mappings) : undefined;
		return match ? found(match.connection, match.account, datasource) : missing();
	}
	if (!datasource.published.luid || !ctx.client) {
		if (explicit) ctx.issue('error', 'data.connector-unavailable', 'Reading a published datasource\'s connections needs a Tableau sign-in and a resolved luid.');
		return undefined;
	}
	let published;
	try {
		published = await readPublishedTds(ctx);
	} catch (err) {
		ctx.issue(explicit ? 'error' : 'warning', 'data.connector-tds', `Could not read the published datasource's connections for connector matching: ${err.message}`, 'The PAT user needs the Download Data Source capability.');
		return undefined;
	}
	if (!explicit && ctx.unmapped !== 'ask' && published.extract?.enabled) return undefined;
	const match = findConnectorMatch({ ...published, published: undefined }, mappings);
	if (!match) return missing();
	const result = found(match.connection, match.account, published);
	if (result) usePublishedPhysicalLayer(ctx, published);
	return result;
}

/** Convert plans connector streams from the datasource's connections and tables, so take them from the published .tds. */
function usePublishedPhysicalLayer(ctx, published) {
	const { datasource } = ctx;
	datasource.connections = published.connections ?? [];
	datasource.tables = published.tables ?? [];
	datasource.relationships = published.relationships ?? [];
	if (published.relationTree) datasource.relationTree = published.relationTree;
	else delete datasource.relationTree;
	const extractedFieldIds = new Set(datasource.tables.flatMap((t) => (t.columns ?? []).map((c) => c.localName)));
	const { added, replaced } = mergePublishedFields(datasource, published, { extractedFieldIds });
	const merged = [...replaced, ...added];
	ctx.issue(
		'info',
		'data.published-connections',
		`Took the connections and ${datasource.tables.length} table(s) of published datasource ${datasource.published.name || datasource.published.luid}${merged.length ? ` and ${merged.length} field definition(s)` : ''}.${published.extract?.enabled ? ' The Tableau extract is bypassed, so extract filters and aggregation do not apply.' : ''}`
	);
}

function caLabel(table) {
	return `${table.databaseName}.${table.schemaName}.${table.tableName}`;
}

const ACCOUNT_WORD = { equal: 'matches', differs: 'differs', unknown: 'unknown' };
const ACCOUNT_LIST_LIMIT = 8;

/** " Snowflake accounts vs <server>: "A" account X matches; ..." for the integrations checked, or ''. */
function accountNote(accounts, server) {
	if (!accounts?.length) return '';
	const order = { equal: 0, differs: 1, unknown: 2 };
	const sorted = [...accounts].sort((a, b) => order[a.result] - order[b.result]);
	const parts = sorted.slice(0, ACCOUNT_LIST_LIMIT).map((a) => `"${a.name}" account ${a.account ?? '(not resolved)'} ${ACCOUNT_WORD[a.result]}`);
	const more = sorted.length > ACCOUNT_LIST_LIMIT ? `; and ${sorted.length - ACCOUNT_LIST_LIMIT} more` : '';
	return ` Snowflake accounts vs ${server}: ${parts.join('; ')}${more}.`;
}

function shareIssue(ctx, explicit, conn, where, result) {
	const lines = result.suggestions.map((s) => {
		const account = s.account?.account ? `account ${s.account.account} ${ACCOUNT_WORD[s.account.result]}` : 'account unknown';
		const renamed = s.databases ? `, under database ${Object.entries(s.databases).map(([from, to]) => `${to} (for ${from})`).join(', ')}` : '';
		return `"${s.integration.name}" (${s.integration.id}, ${account}) reads the same schema and tables${renamed}`;
	});
	const snippets = result.suggestions.map((s) => mappingSnippet(conn, s.integration.id, s.databases));
	ctx.issue(
		explicit ? 'error' : 'warning',
		'data.cloud-amplifier-share',
		`Cloud Amplifier not used for ${where}: no integration in the same Snowflake account can read it, but ${lines.join('; ')}, as through a secure share. It is not used automatically.${accountNote(result.accounts, conn.server)}`,
		`If it holds the same data, pin it in mappings.json: ${snippets.join(' or ')}`
	);
}

async function tryCloudAmplifier(ctx, explicit) {
	const { datasource, mappings } = ctx;
	const ca = ctx.cloudAmplifier ?? {};
	const hasMappings = (mappings?.cloudAmplifier ?? []).length > 0;
	const fail = (severity, code, message, suggestion) => {
		ctx.issue(explicit ? 'error' : severity, code, message, suggestion);
		return undefined;
	};
	if (!ca.getIntegrations && !hasMappings) {
		if (!explicit) return undefined;
		return fail('error', 'data.cloud-amplifier-unavailable', 'Cloud Amplifier matching needs Domo settings (DOMO_INSTANCE, DOMO_ACCESS_TOKEN) or a mappings.json cloudAmplifier entry.');
	}

	const precheck = datasource.published ? null : planTargets(datasource);
	if (precheck?.ineligible && !precheck.initialSql && !precheck.customSql && !explicit) return undefined;

	let integrations = null;
	if (ca.getIntegrations) {
		try {
			integrations = await ca.getIntegrations();
		} catch (err) {
			if (!hasMappings) return fail('warning', 'data.cloud-amplifier-lookup', `Could not list Domo Cloud Amplifier integrations: ${err.message}`);
		}
	}

	if (!hasMappings && !integrations?.length) {
		return explicit ? fail('error', 'data.cloud-amplifier-none', 'The Domo instance has no Cloud Amplifier integrations.') : undefined;
	}

	let source = datasource;
	let published = null;
	if (datasource.published) {
		if (!datasource.published.luid || !ctx.client) {
			if (!explicit) return undefined;
			return fail('error', 'data.cloud-amplifier-unavailable', 'Reading a published datasource\'s connections needs a Tableau sign-in and a resolved luid.');
		}
		try {
			published = await readPublishedTds(ctx);
			source = published;
		} catch (err) {
			return fail('warning', 'data.cloud-amplifier-tds', `Could not read the published datasource's connections for Cloud Amplifier matching: ${err.message}`, 'The PAT user needs the Download Data Source capability.');
		}
	}

	source = applyCustomSqlOverrides(source, datasource, mappings, ctx.issue);
	const result = await matchCloudAmplifier({ source, integrations, mappings, browser: ca.browser ?? null });
	const conn = result.connection;
	const suggest = (list) => {
		const match = conn ? JSON.parse(mappingSnippet(conn)).cloudAmplifier[0].match : undefined;
		ctx.caSuggestions = list.map(({ integration, reason, databases }) => ({
			integrationId: integration.id,
			name: integration.name,
			reason,
			...(match ? { match } : {}),
			...(databases && Object.keys(databases).length ? { databases } : {})
		}));
	};
	const where = conn ? `${conn.class} ${conn.server ?? ''}${conn.dbname ? `/${conn.dbname}` : ''}`.trim() : 'this datasource';
	const accounts = accountNote(result.accounts, conn?.server);
	if (result.status === 'ineligible') {
		ctx.cloudAmplifierBlocked = { reason: result.reason };
		if (explicit || result.initialSql || result.customSql) ctx.issue(explicit ? 'error' : 'info', 'data.cloud-amplifier-ineligible', `Cloud Amplifier not used: ${result.reason}.`);
		return undefined;
	}
	if (result.status === 'disabled') return explicit ? fail('error', 'data.cloud-amplifier-disabled', `Cloud Amplifier is ${result.reason}.`) : undefined;
	if (result.status === 'unavailable') {
		return explicit ? fail('error', 'data.cloud-amplifier-unavailable', `Cloud Amplifier matching for ${where} is unavailable: ${result.reason}.`) : undefined;
	}
	if (result.status === 'ambiguous') {
		suggest(result.candidates.map((integration) => ({ integration, reason: 'one of several integrations that read the tables' })));
		const list = result.candidates.map((i) => `${i.name} (${i.id})`).join(', ');
		return fail('warning', 'data.cloud-amplifier-ambiguous', `Several Cloud Amplifier integrations can read ${where}: ${list}. None was picked.${accounts}`, `Choose one in mappings.json: ${mappingSnippet(conn, result.candidates[0].id)}`);
	}
	if (result.status === 'unconfirmed') {
		suggest([{ integration: result.integration, reason: 'reads the tables, but its host or account could not be tied to the server' }]);
		return fail(
			'warning',
			'data.cloud-amplifier-unconfirmed',
			`Cloud Amplifier not used for ${where}: ${result.reason}. Another account with the same names would show different data.${accounts}`,
			`If it is the same warehouse, pin it in mappings.json: ${mappingSnippet(conn, result.integration.id)}`
		);
	}
	if (result.status === 'unknown') {
		return fail(
			'warning',
			'data.cloud-amplifier-unverified',
			`Could not check whether a Cloud Amplifier integration can read ${where} (the warehouse did not answer): ${result.reason}. Falling back to the next data strategy.${accounts}`,
			`Re-run extract later, or pin the integration in mappings.json: ${mappingSnippet(conn)}`
		);
	}
	if (result.status === 'none' && result.suggestions?.length) {
		suggest(result.suggestions.map((s) => ({ ...s, reason: `reads the same schema and tables${s.databases ? ' under a renamed database' : ''}, as through a secure share` })));
		shareIssue(ctx, explicit, conn, where, result);
		return undefined;
	}
	if (result.status !== 'match') {
		return fail('info', 'data.cloud-amplifier-none', `No Cloud Amplifier integration can read ${where}: ${result.reason}.${accounts}`, `If one should, pin it in mappings.json: ${mappingSnippet(conn ?? { class: '<class>' })}`);
	}

	const info = result.info;
	if (published) {
		info.source = {
			tables: published.tables ?? [],
			...(published.relationTree ? { relationTree: published.relationTree } : {}),
			relationships: published.relationships ?? []
		};
		const columnNames = new Set(info.tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())));
		const extractedFieldIds = new Set(
			(published.tables ?? []).flatMap((t) => (t.columns ?? []).filter((c) => columnNames.has(String(c.remoteName).toLowerCase())).map((c) => c.localName))
		);
		const { added, replaced } = mergePublishedFields(datasource, published, { extractedFieldIds });
		const merged = [...replaced, ...added];
		if (merged.length) {
			const calcs = merged.filter((f) => f.kind === 'calculated').length;
			ctx.issue(
				'info',
				'data.published-fields-merged',
				`Took ${merged.length} field definition(s) from the published datasource${calcs ? ` (${calcs} calculation(s), converted to Beast Modes)` : ''}: ${merged.slice(0, 15).map((f) => f.name).join(', ')}${merged.length > 15 ? ', ...' : ''}`
			);
		}
	}
	const names = info.integrations.map((i) => `"${i.name}" (${i.engine}, ${i.id}${i.accountMatch ? `, account ${i.account ?? '(not resolved)'} ${ACCOUNT_WORD[i.accountMatch]}` : ''})`).join(', ');
	ctx.issue(
		'info',
		'data.cloud-amplifier',
		`Registered through Cloud Amplifier integration ${names}, matched by ${info.matchedBy}: ${info.tables.map(caLabel).join(', ')}. No data is copied; Domo queries the warehouse.${datasource.extract?.enabled || published?.extract?.enabled ? ' The Tableau extract is bypassed, so extract filters and aggregation do not apply.' : ''}`
	);
	const unverified = info.tables.filter((t) => !t.verified);
	if (unverified.length) {
		ctx.issue('warning', 'data.cloud-amplifier-unverified-tables', `Table names and columns were not confirmed by browsing the integration: ${unverified.map(caLabel).join(', ')}. Registration fails at push if they are wrong.`);
	}
	return { strategy: 'cloud-amplifier', tables: [], cloudAmplifier: info };
}

/* Hyper */

function findPackageEntry(pkg, hyperPath) {
	const wanted = normalizeEntryPath(hyperPath);
	const entries = pkg.entries || [];
	const nameOf = (entry) => normalizeEntryPath(typeof entry === 'string' ? entry : entry?.fileName ?? entry?.name ?? entry?.path ?? '');
	let found = entries.find((entry) => nameOf(entry) === wanted);
	found ??= entries.find((entry) => nameOf(entry).toLowerCase() === wanted.toLowerCase());
	const base = path.posix.basename(wanted).toLowerCase();
	found ??= entries.find((entry) => path.posix.basename(nameOf(entry)).toLowerCase() === base);
	if (found !== undefined) return found;
	return entries.length ? undefined : hyperPath;
}

function normalizeEntryPath(value) {
	return String(value).replace(/\\/g, '/').replace(/^\.?\//, '');
}

async function tryHyper(ctx, explicit) {
	const { datasource, pkg, python } = ctx;
	const fail = (code, message, suggestion) => {
		if (explicit || code !== 'data.hyper-unavailable') ctx.issue(explicit ? 'error' : 'warning', code, message, suggestion);
		return undefined;
	};
	if (!hasPackagedExtract(datasource, pkg)) {
		return fail('data.hyper-unavailable', 'The datasource has no packaged .hyper extract (download the .twbx with includeExtract).');
	}
	const hyperFiles = datasource.extract.hyperFiles;
	if (hyperFiles.every((f) => /\.tde$/i.test(f))) {
		return fail(
			'data.legacy-tde',
			'The extract is a legacy .tde file, which the Hyper API cannot read.',
			'Open the workbook in Tableau 10.5 or later and upgrade the extract to .hyper.'
		);
	}
	const check = await cachedCheckHyper(python);
	if (!check.ok) {
		return fail('data.hyper-sidecar', `Packaged extract found but the Hyper sidecar is unavailable: ${check.error}`, 'pip install tableauhyperapi');
	}

	try {
		const tables = await exportPackagedHyper(ctx, pkg, hyperFiles, datasource);
		return { strategy: 'hyper', tables };
	} catch (err) {
		return fail('data.hyper-failed', `Hyper extract export failed: ${err.message}`);
	}
}

/**
 * Export the given package extracts with the sidecar and write mapped CSVs into the datasource data dir.
 * `mappingSource` supplies the tables and fields that map Hyper columns to Tableau fields.
 * @param {{ keep?: string[] }} [opts]  Files in the data dir that survive the refresh
 */
async function exportPackagedHyper(ctx, pkg, hyperFiles, mappingSource, { keep = [] } = {}) {
	const tmpDir = path.join(ctx.dir, 'data', '.tmp', ctx.slug);
	await fs.promises.rm(tmpDir, { recursive: true, force: true });
	await fs.promises.mkdir(tmpDir, { recursive: true });
	try {
		const exported = [];
		for (const [index, hyperPath] of hyperFiles.entries()) {
			if (/\.tde$/i.test(hyperPath)) {
				ctx.issue('warning', 'data.legacy-tde', `Skipped legacy .tde extract ${hyperPath}.`);
				continue;
			}
			const entry = findPackageEntry(pkg, hyperPath);
			if (entry === undefined) throw new Error(`Extract ${hyperPath} is not in the package`);
			const hyperFile = path.join(tmpDir, `${index}-${path.posix.basename(normalizeEntryPath(hyperPath))}`);
			ctx.emitter.step(`Extracting ${hyperPath}`);
			await ctx.time('datasource.unpack', () => pkg.extractEntry(entry, hyperFile), () => ({ bytes: fs.statSync(hyperFile).size }));
			ctx.emitter.step(`Exporting Hyper tables from ${path.basename(hyperFile)}`);
			const { tables } = await ctx.time('datasource.hyper-export', () => exportHyper({ python: ctx.python, hyperFile, outDir: path.join(tmpDir, `out-${index}`) }), (r) => ({ tables: r.tables.length }));
			exported.push(...tables);
		}
		if (!exported.length) throw new Error('The extract contains no tables');
		const dataDir = await freshDataDir(ctx, keep);
		return await ctx.time('datasource.csv', () => mapHyperTables(ctx, exported, dataDir, mappingSource), (tables) => ({ rows: tables.reduce((n, tbl) => n + (tbl.rowCount || 0), 0) }));
	} finally {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
		await fs.promises.rmdir(path.join(ctx.dir, 'data', '.tmp')).catch(() => {});
	}
}

/* Published datasource extract (.tdsx download) */

const PUBLISHED_SOURCE_FILE = 'source.tdsx';

/**
 * Merge the published datasource's field definitions into the workbook's sqlproxy copy. Fields the
 * workbook lacks are added; a workbook "column" that the .tds defines as a calculation (the sqlproxy
 * exposes published calcs as remote columns) and that the extract does not materialize is replaced by
 * the calculation, keeping its id so worksheet pills still resolve. Mutates `datasource`.
 * @param {import('../../model/types.js').DatasourceIR} datasource
 * @param {import('../../model/types.js').DatasourceIR} published
 * @param {{ extractedFieldIds?: Set<string> }} [opts]  Field ids that matched an extract column
 * @returns {{ added: import('../../model/types.js').FieldIR[], replaced: import('../../model/types.js').FieldIR[] }}
 */
export function mergePublishedFields(datasource, published, { extractedFieldIds = new Set() } = {}) {
	const fields = datasource.fields || [];
	const index = new Map(fields.map((f, i) => [f.id, i]));
	const added = [];
	const replaced = [];
	for (const field of published.fields || []) {
		if (!field.id || field.kind === 'measure-names' || field.kind === 'measure-values') continue;
		const at = index.get(field.id);
		if (at === undefined) {
			added.push(structuredClone(field));
			continue;
		}
		const current = fields[at];
		const derived = field.kind && field.kind !== 'column';
		if (derived && (!current.kind || current.kind === 'column') && !extractedFieldIds.has(field.id)) {
			const merged = { ...structuredClone(field), ...(current.aliases && !field.aliases ? { aliases: current.aliases } : {}) };
			delete merged.physical;
			fields[at] = merged;
			replaced.push(merged);
		}
	}
	datasource.fields = [...fields, ...added];
	return { added, replaced };
}

/**
 * Add the field definitions of a published datasource that the workbook copy lacks (calculations, groups, bins,
 * sets, columns), and fill aliases, unknown datatypes and empty formulas on the fields it has. Never turns a workbook column into
 * a calculation: the data strategy decides that (mergePublishedFields). Mutates `datasource`.
 * @param {import('../../model/types.js').DatasourceIR} datasource
 * @param {import('../../model/types.js').DatasourceIR} published
 * @returns {{ added: import('../../model/types.js').FieldIR[], filled: import('../../model/types.js').FieldIR[] }}
 */
export function mergePublishedDefinitions(datasource, published) {
	const byId = new Map((published.fields || []).map((f) => [f.id, f]));
	const filled = [];
	for (const field of datasource.fields || []) {
		const pub = byId.get(field.id);
		if (!pub) continue;
		let changed = false;
		if (!field.aliases && pub.aliases) {
			field.aliases = structuredClone(pub.aliases);
			changed = true;
		}
		if ((!field.datatype || field.datatype === 'unknown') && pub.datatype && pub.datatype !== 'unknown') {
			field.datatype = pub.datatype;
			changed = true;
		}
		if (field.kind === 'calculated' && !field.formula && pub.kind === 'calculated' && pub.formula) {
			field.formula = pub.formula;
			changed = true;
		}
		if (changed) filled.push(field);
	}
	const { added } = mergePublishedFields(datasource, published, { extractedFieldIds: new Set((datasource.fields || []).map((f) => f.id)) });
	if (!datasource.hierarchies?.length && published.hierarchies?.length) datasource.hierarchies = structuredClone(published.hierarchies);
	return { added, filled };
}

/**
 * Datasource used to map Hyper columns: the workbook's fields (ids the worksheets reference) plus the
 * published datasource's tables when the workbook copy has no metadata-records.
 */
function publishedMappingSource(datasource, published) {
	const hasColumns = (ds) => (ds.tables || []).some((t) => t.columns?.length);
	// The sqlproxy copy names columns by their published field names, while the extract keeps the warehouse
	// names (Salesforce "Id"), so the published table's columns come first.
	const publishedById = new Map((published.tables || []).map((t) => [t.id, t]));
	const tables = hasColumns(datasource)
		? datasource.tables.map((t) => {
				const pub = publishedById.get(t.id);
				if (!pub) return t;
				return { ...t, ...(pub.relation ? { relation: pub.relation } : {}), columns: [...(pub.columns || []), ...(t.columns || [])] };
			})
		: published.tables || [];
	const byId = new Map((datasource.fields || []).map((f) => [f.id, f]));
	for (const field of published.fields || []) if (!byId.has(field.id)) byId.set(field.id, field);
	return { ...datasource, tables, fields: [...byId.values()] };
}

function hyperEntries(pkg) {
	return (pkg.entries || [])
		.map((e) => (typeof e === 'string' ? e : e?.fileName ?? e?.name))
		.filter((name) => name && /\.(hyper|tde)$/i.test(name));
}

async function tryPublishedExtract(ctx, explicit) {
	const { datasource, client, python } = ctx;
	const luid = datasource.published?.luid;
	const fail = (code, message, suggestion) => {
		ctx.issue(explicit ? 'error' : 'warning', code, message, suggestion);
		return undefined;
	};
	if (!luid || !client) {
		if (!explicit) return undefined;
		return fail(
			'data.published-extract-unavailable',
			luid ? 'A Tableau client is needed to download the published datasource.' : 'The datasource is not a published datasource with a resolved luid.'
		);
	}
	const check = await cachedCheckHyper(python);
	if (!check.ok) {
		if (!explicit) return undefined;
		return fail('data.hyper-sidecar', `The Hyper sidecar is needed to read the published datasource extract: ${check.error}`, 'pip install tableauhyperapi');
	}

	const name = datasource.published?.name || datasource.caption || luid;
	const dataDir = path.join(ctx.dir, 'data', ctx.slug);
	const target = path.join(dataDir, PUBLISHED_SOURCE_FILE);
	let pkg;
	try {
		const { downloadDatasource } = await import('../content.js');
		ctx.emitter.step(`Downloading published datasource ${name} with its extract`);
		const downloaded = await ctx.time('datasource.download', () => downloadDatasource(client, luid, path.join(ctx.dir, 'data', '.download', ctx.slug), { includeExtract: true }), (r) => ({ bytes: fs.statSync(r.file).size }));
		await fs.promises.mkdir(dataDir, { recursive: true });
		await fs.promises.rename(downloaded.file, target);
		await fs.promises.rm(path.join(ctx.dir, 'data', '.download'), { recursive: true, force: true });

		const [{ openPackage }, { buildDatasourceIR }] = await Promise.all([import('../package.js'), import('../twb/index.js')]);
		pkg = await openPackage(target);
		const published = buildDatasourceIR(pkg.xml);
		ctx.physicalSource = published;
		const hyperFiles = published.extract?.enabled && published.extract.hyperFiles?.length ? published.extract.hyperFiles : hyperEntries(pkg);
		if (!hyperFiles.length) {
			const live = (published.connections || []).map((c) => c.class).filter((c) => c && !NON_CONNECTOR_CLASSES.has(c.toLowerCase()));
			return fail(
				'data.published-extract-live',
				`Published datasource ${name} is a live connection${live.length ? ` (${[...new Set(live)].join(', ')})` : ''} with no extract to read.`,
				'Use a connector account mapping, map it to an existing Domo dataset, or use the vds strategy.'
			);
		}
		if (hyperFiles.every((f) => /\.tde$/i.test(f))) {
			return fail('data.legacy-tde', `Published datasource ${name} has a legacy .tde extract, which the Hyper API cannot read.`, 'Upgrade the extract to .hyper in Tableau.');
		}

		const mappingSource = publishedMappingSource(datasource, published);
		const tables = await exportPackagedHyper(ctx, pkg, hyperFiles, mappingSource, { keep: [PUBLISHED_SOURCE_FILE] });
		const { added, replaced } = mergePublishedFields(datasource, published, { extractedFieldIds: ctx.extractedFieldIds });
		const merged = [...replaced, ...added];
		if (merged.length) {
			const calcs = merged.filter((f) => f.kind === 'calculated').length;
			ctx.issue(
				'info',
				'data.published-fields-merged',
				`Took ${merged.length} field definition(s) from the published datasource${calcs ? ` (${calcs} calculation(s), converted to Beast Modes)` : ''}: ${merged.slice(0, 15).map((f) => f.name).join(', ')}${merged.length > 15 ? ', ...' : ''}`
			);
		}
		ctx.issue('info', 'data.published-extract', `Data came from the extract of published datasource ${name} (${relativePath(ctx.dir, target)}).`);
		return { strategy: 'published-extract', tables };
	} catch (err) {
		return fail(
			'data.published-extract-failed',
			`Published datasource download or extract export failed: ${err.message}`,
			'The PAT user needs the Download Data Source capability on the published datasource.'
		);
	} finally {
		if (pkg) await Promise.resolve(pkg.close?.()).catch(() => {});
		await fs.promises.rm(path.join(ctx.dir, 'data', '.download'), { recursive: true, force: true }).catch(() => {});
	}
}

const OBJECT_ID_SUFFIX = /_[0-9A-F]{32}$/i;

/**
 * Match a Hyper table to a TableIR. Multi-table extracts name tables after the
 * object-graph object id ('Orders_ECFCA1FB690A41FE803BC071773BA862').
 */
export function matchHyperTable(datasource, hyperTable, hyperTableCount) {
	const tables = datasource.tables || [];
	const name = hyperTable.name;
	const lower = name.toLowerCase();
	const stem = name.replace(OBJECT_ID_SUFFIX, '');
	const finders = [
		(t) => t.id === name,
		(t) => t.name === name,
		(t) => t.id?.toLowerCase() === lower,
		(t) => t.name?.toLowerCase() === lower,
		(t) => t.relation === name,
		(t) => stripBrackets(t.table?.split('.').pop() ?? '') === name,
		(t) => stem !== name && (t.name === stem || t.id?.replace(OBJECT_ID_SUFFIX, '') === stem)
	];
	for (const finder of finders) {
		const matches = tables.filter(finder);
		if (matches.length === 1) return matches[0];
	}
	if (hyperTableCount === 1 && tables.length === 1) return tables[0];
	return undefined;
}

async function mapHyperTables(ctx, exported, dataDir, datasource = ctx.datasource) {
	const fileName = uniqueFileNamer();
	const columnFields = (datasource.fields || []).filter((f) => !f.kind || f.kind === 'column');
	const byLocal = new Map();
	for (const field of columnFields) {
		const key = stripBrackets(field.id).toLowerCase();
		if (!byLocal.has(key)) byLocal.set(key, field);
	}
	const fieldsById = new Map((datasource.fields || []).map((f) => [f.id, f]));
	const out = [];
	for (const hyperTable of exported) {
		const tableIR = matchHyperTable(datasource, hyperTable, exported.length);
		const singleExtract = exported.length === 1 && (hyperTable.name === 'Extract' || (datasource.tables || []).length <= 1);
		const flattened = exported.length === 1 && singleExtract;
		const physical = tableIR?.columns || [];
		const resolveField = (hyperName) => {
			const lower = hyperName.toLowerCase();
			const viaPhysical =
				physical.find((c) => stripBrackets(c.localName).toLowerCase() === lower) ||
				physical.find((c) => String(c.remoteName).toLowerCase() === lower);
			if (viaPhysical) {
				const field = fieldsById.get(viaPhysical.localName);
				if (field && (!field.kind || field.kind === 'column')) return field;
			}
			return byLocal.get(lower);
		};
		const sources = hyperTable.columns.map((column) => ({ column, field: resolveField(column.name) }));
		ctx.extractedFieldIds ??= new Set();
		for (const { field } of sources) if (field) ctx.extractedFieldIds.add(field.id);
		const names = dedupeNames(
			sources.map(({ column, field }) => domoColumnName(field ? columnOverride(ctx, field.name) ?? field.name : column.name))
		);
		const columns = sources.map(({ column }, i) => ({
			name: names[i],
			type: hyperToDomoType(column.type),
			sourceName: column.name,
			sourceIndex: i,
			boolean: isHyperBoolean(column.type)
		}));
		const unmatched = sources.filter((s) => !s.field).map((s) => s.column.name);
		if (unmatched.length && columnFields.length) {
			ctx.issue(
				'info',
				'data.hyper-unmatched-columns',
				`Hyper table ${hyperTable.schema}.${hyperTable.name} has columns with no matching Tableau field (kept as-is): ${unmatched.slice(0, 20).join(', ')}${unmatched.length > 20 ? ', ...' : ''}`
			);
		}
		const tableName = tableIR?.name || (flattened ? datasource.caption || hyperTable.name : hyperTable.name);
		const output = path.join(dataDir, fileName(tableName));
		ctx.emitter.step(`Writing ${relativePath(ctx.dir, output)}`);
		const { rowCount, invalid } = await reformatCsv({
			input: hyperTable.file,
			output,
			columns,
			emitter: ctx.emitter,
			label: tableName
		});
		reportInvalid(ctx, tableName, invalid);
		if (hyperTable.rowCount && hyperTable.rowCount !== rowCount) {
			ctx.issue('warning', 'data.row-count-mismatch', `Table ${tableName}: Hyper reported ${hyperTable.rowCount} rows but ${rowCount} were written.`);
		}
		out.push({
			name: tableName,
			...(tableIR ? { tableId: tableIR.id } : {}),
			file: relativePath(ctx.dir, output),
			columns: columns.map(({ name, type, sourceName }) => ({ name, type, sourceName })),
			rowCount,
			flattened
		});
	}
	return out;
}

function reportInvalid(ctx, tableName, invalid) {
	const entries = Object.entries(invalid || {});
	if (!entries.length) return;
	ctx.issue(
		'warning',
		'data.invalid-values',
		`Table ${tableName}: values that did not fit the column type were written as empty: ${entries.map(([c, n]) => `${c} (${n})`).join(', ')}`
	);
}

/* VizQL Data Service */

function fieldByCaption(datasource) {
	const map = new Map();
	for (const field of datasource.fields || []) {
		for (const key of [field.caption, field.name, stripBrackets(field.id)]) {
			if (key && !map.has(key)) map.set(key, field);
		}
	}
	return map;
}

async function tryVds(ctx, explicit) {
	const { datasource, client } = ctx;
	const luid = datasource.published?.luid;
	if (!luid || !client) {
		if (explicit) {
			ctx.issue('error', 'data.vds-unavailable', luid ? 'A Tableau client is needed to query the published datasource.' : 'The datasource is not a published datasource with a resolved luid.');
		}
		return undefined;
	}
	const fields = fieldByCaption(datasource);
	try {
		const dataDir = await freshDataDir(ctx);
		const tableName = datasource.published?.name || datasource.caption || luid;
		const output = path.join(dataDir, uniqueFileNamer()(tableName));
		ctx.emitter.step(`Querying published datasource ${tableName} through VizQL Data Service`);
		const result = await ctx.time('datasource.vds-export', () => exportPublishedDatasource(client, luid, output, {
			emitter: ctx.emitter,
			rowLimit: ctx.vds?.rowLimit,
			columnName: (meta) => {
				const field = fields.get(meta.fieldCaption) || fields.get(meta.fieldName);
				const name = field?.name || meta.fieldCaption || meta.fieldName;
				return columnOverride(ctx, name) ?? name;
			}
		}), (r) => ({ rows: r.rowCount }));
		if (result.truncated) {
			ctx.issue('warning', 'data.vds-truncated', `VizQL Data Service returned exactly the row limit (${result.rowCount}); data is probably truncated.`);
		}
		const skipped = result.skipped.filter((s) => !/CALCULATION/.test(s.reason));
		if (skipped.length) {
			ctx.issue('info', 'data.vds-skipped-fields', `Fields not exported: ${skipped.map((s) => `${s.caption} (${s.reason})`).join(', ')}`);
		}
		ctx.issue('info', 'data.vds', 'Row-level data was queried through VizQL Data Service; very large datasources may hit undocumented server limits.');
		return {
			strategy: 'vds',
			tables: [
				{
					name: tableName,
					...(datasource.tables?.length === 1 ? { tableId: datasource.tables[0].id } : {}),
					file: relativePath(ctx.dir, output),
					columns: result.columns,
					rowCount: result.rowCount,
					flattened: true
				}
			]
		};
	} catch (err) {
		ctx.issue(explicit ? 'error' : 'warning', 'data.vds-failed', `VizQL Data Service export failed: ${err.message}`, 'The PAT user needs the API Access capability on the datasource; Tableau Server needs 2025.1 or later.');
		return undefined;
	}
}

/* View CSV */

async function tryViewCsv(ctx, explicit) {
	const { datasource, client, ir } = ctx;
	const workbookLuid = ir?.workbook?.luid;
	if (!client || !workbookLuid) {
		if (explicit) ctx.issue('error', 'data.view-csv-unavailable', 'View CSV export needs a Tableau client and a workbook published on the server.');
		return undefined;
	}
	const worksheets = (ir.worksheets || []).filter((ws) => (ws.datasourceIds || []).includes(datasource.id));
	if (!worksheets.length) {
		if (explicit) ctx.issue('error', 'data.view-csv-unavailable', 'No worksheet uses this datasource.');
		return undefined;
	}
	let views = ctx.views;
	try {
		if (!views) {
			const { listWorkbookViews } = await import('../content.js');
			views = await listWorkbookViews(client, workbookLuid);
		}
	} catch (err) {
		ctx.issue(explicit ? 'error' : 'warning', 'data.view-csv-failed', `Could not list workbook views: ${err.message}`);
		return undefined;
	}
	const byName = new Map((views || []).map((v) => [v.name, v]));
	const targets = [];
	const missing = [];
	for (const ws of worksheets) {
		const view = byName.get(ws.name);
		if (view) targets.push({ ws, view });
		else missing.push(ws.name);
	}
	if (!targets.length) {
		ctx.issue(explicit ? 'error' : 'warning', 'data.view-csv-failed', `None of the worksheets using this datasource are published views (hidden sheets are not exposed): ${missing.join(', ')}`);
		return undefined;
	}
	const dataDir = await freshDataDir(ctx);
	const fileName = uniqueFileNamer();
	const tables = [];
	const failed = [];
	for (const { ws, view } of targets) {
		const output = path.join(dataDir, fileName(`view-${ws.name}`));
		try {
			ctx.emitter.step(`Downloading summary data for view ${ws.name}`);
			const result = await ctx.time('datasource.view-csv', () => exportViewCsv(client, view.id, output, { emitter: ctx.emitter }), (r) => ({ key: ws.name, rows: r.rowCount }));
			reportInvalid(ctx, ws.name, result.invalid);
			tables.push({
				name: ws.name,
				file: relativePath(ctx.dir, output),
				columns: result.columns,
				rowCount: result.rowCount,
				flattened: true
			});
		} catch (err) {
			failed.push(`${ws.name} (${err.message})`);
		}
	}
	if (failed.length) ctx.issue('warning', 'data.view-csv-failed', `Some views could not be exported: ${failed.join('; ')}`);
	if (missing.length) ctx.issue('info', 'data.view-csv-hidden', `Worksheets without a published view were skipped: ${missing.join(', ')}`);
	if (!tables.length) return undefined;
	ctx.issue(
		'warning',
		'data.view-csv-lossy',
		`Data came from ${tables.length} view summary CSV export(s): aggregated to each view's level of detail and display-formatted, so it is not row-level data.`,
		'Provide the packaged extract, a published datasource with API Access, or map this datasource to an existing Domo dataset.'
	);
	return { strategy: 'view-csv', tables };
}
