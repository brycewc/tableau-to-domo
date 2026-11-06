import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requireDomo, requireTableau } from '../config.js';
import { createEmitter } from '../util/events.js';
import { createTimer } from '../util/timing.js';
import { shortHash, slugify } from '../util/ids.js';
import { openWorkspace } from './workspace.js';
import { writeRunLog } from './runs.js';
import { extractImages } from './images.js';
import { usedDatasources } from '../convert/datasets.js';
import { linkedWorkbooks } from '../convert/web-links.js';
import { hasObjectSelection, normalizeSelection, selectIrDatasources } from '../convert/select.js';
import { copyCsvHead } from '../tableau/data/csv-writer.js';
import { scanMemberCase } from '../tableau/data/member-case.js';
import { connectorFamily, connectorSpec } from '../convert/connectors.js';
import { DataDecisionError, SNAPSHOT_STRATEGIES, UNMAPPED_POLICIES, choiceSpec, completeDecision, decisionKey, mergeDecisions, recordAnswers } from './decisions.js';

function fileSize(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return undefined;
	}
}

/** Strategy, tables, rows and CSV bytes of a datasource's extracted data. */
function dataStats(manifest, dir) {
	const tables = manifest?.tables ?? [];
	const bytes = tables.reduce((sum, tbl) => sum + (tbl.file ? (fileSize(path.resolve(dir, tbl.file)) ?? 0) : 0), 0);
	return { strategy: manifest?.strategy ?? 'none', tables: tables.length, rows: tables.reduce((sum, tbl) => sum + (tbl.rowCount || 0), 0), bytes };
}

const API_STRATEGIES = new Set(['published-extract', 'vds', 'view-csv']);
const HYPER_STRATEGIES = new Set(['auto', 'hyper', 'published-extract']);
const STRATEGIES = new Set(['auto', 'existing', 'cloud-amplifier', 'federated', 'connector', 'hyper', 'published-extract', 'vds', 'view-csv', 'none']);

async function loadTableauDeps(overrides = {}) {
	const need = (key, loader) => overrides[key] ?? loader();
	const [client, content, metadata, pkg, twb, data] = await Promise.all([
		need('client', () => import('../tableau/client.js')),
		need('content', () => import('../tableau/content.js')),
		need('metadata', () => import('../tableau/metadata.js')),
		need('package', () => import('../tableau/package.js')),
		need('twb', () => import('../tableau/twb/index.js')),
		need('data', () => import('../tableau/data/index.js'))
	]);
	return { TableauClient: client.TableauClient, ...content, ...metadata, ...pkg, ...twb, ...data };
}

/** True when every Tableau setting needed for sign-in is present. */
export function tableauConfigured(config) {
	try {
		requireTableau(config);
		return true;
	} catch {
		return false;
	}
}

/** Names of the views of other workbooks the web zones show (WorkbookInfo.linkedViews), for their buttons; fail-soft. */
async function linkedViewsOf(t, client, ir, emitter) {
	const out = [];
	if (!t.listWorkbooks || !t.listWorkbookViews) return out;
	for (const contentUrl of linkedWorkbooks(ir)) {
		try {
			const wb = (await t.listWorkbooks(client, { contentUrl })).find((w) => String(w.contentUrl ?? '').toLowerCase() === contentUrl.toLowerCase());
			if (!wb) continue;
			for (const view of await t.listWorkbookViews(client, wb.id)) out.push({ contentUrl: view.contentUrl, name: view.name, workbook: wb.name });
		} catch (err) {
			emitter.warn(`Could not look up the views of workbook "${contentUrl}" on Tableau, its web zone buttons use url names: ${err.message}`);
		}
	}
	return out;
}

/**
 * Pick a workspace slug: slugify(name), with a short suffix only when another
 * workbook with a different identity already owns that slug.
 */
async function chooseSlug(ws, name, identity) {
	const base = slugify(name);
	const meta = await ws.readJson(ws.paths(base).metadata, null).catch(() => null);
	if (!meta || !fs.existsSync(ws.workbookDir(base))) return base;
	const existing = meta.identity ?? meta.workbook?.luid;
	if (!existing || !identity || existing === identity) return base;
	return `${base}-${String(identity).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

function fallbackDatasourceSlug(ds) {
	return `${slugify(ds.caption || ds.id)}-${shortHash(ds.id).slice(0, 6)}`;
}

/** True when Domo settings are present, so extract may make read-only Domo lookups. */
export function domoConfigured(config) {
	try {
		requireDomo(config);
		return true;
	} catch {
		return false;
	}
}

/**
 * Lazy, cached read-only Domo lookups for the cloud-amplifier data strategy. The integration list is
 * fetched on first use; `browser` exists once `getIntegrations()` has resolved.
 * @param {{ config: import('../config.js').T2DConfig, emitter: import('../util/events.js').Emitter, domo?: { client?: any, api?: any, getDataset?: Function } }} opts
 */
async function snowflakeViewsHandler({ config, ws, emitter, deps }) {
	const sf = config.snowflake ?? {};
	const [database, schema] = String(sf.viewSchema ?? '').split('.');
	if (!database || !schema) throw new Error('--snowflake-views needs SNOWFLAKE_VIEW_SCHEMA as DATABASE.SCHEMA');
	const { createSnowflakeViews } = await import('./snowflake-views.js');
	let client = deps?.snowflake ?? null;
	if (!client && sf.account && sf.user && (sf.pat || sf.privateKeyPath)) {
		const { createSnowflakeClient } = await import('../snowflake/client.js');
		client = createSnowflakeClient(sf);
	}
	if (!client) emitter.warn('Snowflake settings are incomplete (SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and SNOWFLAKE_PAT or SNOWFLAKE_PRIVATE_KEY_PATH); view DDL is written for review instead');
	return createSnowflakeViews({ client, target: { database, schema }, dir: path.join(ws.root, 'snowflake'), emitter });
}

export function cloudAmplifierLookup({ config, emitter, domo = {} }) {
	let integrations;
	let browser = null;
	return {
		getIntegrations() {
			integrations ??= (async () => {
				const [api, { createBrowser }, datasets] = await Promise.all([
					domo.api ?? import('../domo/cloud-amplifier.js'),
					import('../tableau/data/cloud-amplifier.js'),
					domo.getDataset ? { getDataset: domo.getDataset } : import('../domo/datasets.js')
				]);
				let client = domo.client;
				if (!client) {
					const { createDomoClient } = await import('../domo/client.js');
					client = createDomoClient(requireDomo(config), { emitter: emitter.child('domo'), timeoutMs: 60000 });
				}
				emitter.step('Listing Domo Cloud Amplifier integrations (read-only)');
				const list = await api.listIntegrations(client);
				browser = createBrowser(client, api, { getDataset: datasets.getDataset, retry: domo.retry });
				emitter.info(`Found ${list.length} Cloud Amplifier integration(s) on ${config.domo.instance}`);
				return list;
			})();
			return integrations;
		},
		get browser() {
			return browser;
		}
	};
}

const BROWSE_CANDIDATES = 5;
const statusOf = (err) => (typeof err?.status === 'number' ? `HTTP ${err.status}` : 'request failed');

/**
 * Lazy, cached read-only lookups for the federated data strategy: the federated-views flag, database browses and
 * the federated accounts that may reach a connection (allowlisted settings only, never a credential).
 * @param {{ config: import('../config.js').T2DConfig, emitter: import('../util/events.js').Emitter, domo?: { client?: any, federated?: any, accounts?: any, probe?: any } }} opts
 */
export function federatedLookup({ config, emitter, domo = {} }) {
	let deps;
	let views;
	const browsed = new Map();
	const byProvider = new Map();
	const load = () =>
		(deps ??= (async () => {
			const [api, accounts, probe] = await Promise.all([domo.federated ?? import('../domo/federated.js'), domo.accounts ?? import('../domo/accounts.js'), domo.probe ?? import('../domo/probe.js')]);
			let client = domo.client;
			if (!client) {
				const { createDomoClient } = await import('../domo/client.js');
				client = createDomoClient(requireDomo(config), { emitter: emitter.child('domo'), timeoutMs: 60000 });
			}
			return { api, accounts, probe, client };
		})());
	const browse = (accountId) => {
		const key = String(accountId);
		if (!browsed.has(key)) {
			browsed.set(
				key,
				load()
					.then(({ api, client }) => api.listDatabases(client, accountId))
					.then(
						(value) => ({ ok: true, value }),
						(err) => ({ ok: false, reason: statusOf(err) })
					)
			);
		}
		return browsed.get(key);
	};
	const accountsOf = (provider) => {
		if (!byProvider.has(provider)) {
			const pending = (async () => {
				const { accounts, client } = await load();
				emitter.step(`Listing Domo ${provider} accounts (read-only)`);
				const list = (await accounts.searchAccounts(client, provider)).slice(0, ACCOUNTS_PER_PROVIDER);
				const out = [];
				for (const account of list) {
					const settings = await accounts.getAccountSettings(client, account.id, { providerKey: provider }).then((r) => r.settings).catch(() => ({}));
					out.push({ ...account, providerKey: provider, settings });
				}
				return out;
			})();
			byProvider.set(provider, pending);
			pending.catch(() => byProvider.delete(provider));
		}
		return byProvider.get(provider);
	};
	return {
		viewsEnabled() {
			views ??= load()
				.then(async ({ probe, client }) => {
					const { features } = await probe.readFeatureFlags(client);
					return features.get('federated-views') === true;
				})
				.catch(() => null);
			return views;
		},
		browse,
		/** @param {import('../model/types.js').ConnectionIR} connection */
		async forConnection(connection) {
			const { federatedProviders, treeCatalogs } = await import('../domo/federated.js');
			const providers = federatedProviders(connection?.class);
			if (!providers.length) return { providers, status: 'unavailable', matches: [], others: [], reason: `Domo has no federated provider for ${connection?.class ?? 'this connection'}` };
			try {
				const { accounts } = await load();
				const all = (await Promise.all(providers.map(accountsOf))).flat();
				const result = accounts.matchAccounts(connection, all, { family: connectorFamily(connection.class) });
				const wanted = String(connection.dbname ?? '').toLowerCase();
				const check = async (candidate, hostKnown) => {
					const tree = await browse(candidate.id);
					if (!tree.ok) {
						candidate.notes.push(`could not browse its databases (${tree.reason})`);
						candidate.confident = false;
						return false;
					}
					const listed = !wanted || treeCatalogs(tree.value).some((c) => String(c).toLowerCase() === wanted);
					candidate.notes.push(wanted ? `database ${connection.dbname} ${listed ? 'listed' : 'not listed'}${hostKnown ? '' : '; host not readable'}` : 'no database to check');
					if (!listed || !hostKnown) candidate.confident = false;
					return listed;
				};
				for (const m of result.matches.slice(0, BROWSE_CANDIDATES)) await check(m, true);
				if (!result.matches.length && wanted) {
					for (const other of result.others.slice(0, BROWSE_CANDIDATES)) {
						if (other.host) continue;
						if (await check(other, false)) result.matches.push(other);
					}
					result.others = result.others.filter((o) => !result.matches.includes(o));
				}
				const confident = result.matches.filter((m) => m.confident);
				return { providers, ...result, status: confident.length === 1 ? 'match' : result.matches.length ? 'candidates' : 'none' };
			} catch (err) {
				return { providers, status: 'unavailable', matches: [], others: [], reason: `the federated account list could not be read (${statusOf(err)})` };
			}
		}
	};
}

const SNOWFLAKE_ACCOUNT_PROVIDERS = ['snowflakekeypairauthentication', 'snowflake', 'snowflake-oauth'];
const ACCOUNTS_PER_PROVIDER = 50;

/**
 * Lazy, cached read-only lookup of the instance's connector accounts that may reach a Tableau connection.
 * Only allowlisted account settings are read (safeAccountSettings); failures keep the HTTP status only.
 * @param {{ config: import('../config.js').T2DConfig, emitter: import('../util/events.js').Emitter, domo?: { client?: any, accounts?: any, retry?: any } }} opts
 */
export function connectorAccountLookup({ config, emitter, domo = {} }) {
	const byProvider = new Map();
	let deps;
	const load = () =>
		(deps ??= (async () => {
			const [accounts, ca] = await Promise.all([domo.accounts ?? import('../domo/accounts.js'), import('../domo/cloud-amplifier.js')]);
			let client = domo.client;
			if (!client) {
				const { createDomoClient } = await import('../domo/client.js');
				client = createDomoClient(requireDomo(config), { emitter: emitter.child('domo'), timeoutMs: 60000 });
			}
			return { accounts, client, compareSnowflake: ca.compareSnowflakeAccounts };
		})());
	const accountsOf = (provider) => {
		if (!byProvider.has(provider)) {
			const pending = (async () => {
				const { accounts, client } = await load();
				emitter.step(`Listing Domo ${provider} connector accounts (read-only)`);
				const list = (await accounts.searchAccounts(client, provider)).slice(0, ACCOUNTS_PER_PROVIDER);
				const out = [];
				let next = 0;
				const worker = async () => {
					while (next < list.length) {
						const account = list[next++];
						const settings = await accounts
							.getAccountSettings(client, account.id, { providerKey: provider })
							.then((r) => r.settings)
							.catch(() => ({}));
						out.push({ ...account, providerKey: provider, settings });
					}
				};
				await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
				return out.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
			})();
			byProvider.set(provider, pending);
			pending.catch(() => byProvider.delete(provider));
		}
		return byProvider.get(provider);
	};
	return {
		/** @param {import('../model/types.js').ConnectionIR} connection */
		async forConnection(connection) {
			const family = connectorFamily(connection?.class);
			const spec = family ? connectorSpec(family) : undefined;
			if (!spec || spec.manual) return { providers: [], status: 'unavailable', matches: [], others: [], reason: `t2d has no SQL connector for ${connection?.class ?? 'this connection'}` };
			const providers = family === 'snowflake' ? SNOWFLAKE_ACCOUNT_PROVIDERS : [spec.providerKey];
			try {
				const { accounts, compareSnowflake } = await load();
				const all = (await Promise.all(providers.map(accountsOf))).flat();
				return { providers, ...accounts.matchAccounts(connection, all, { family, compareSnowflake }) };
			} catch (err) {
				return { providers, status: 'unavailable', matches: [], others: [], reason: `the account list could not be read (${typeof err?.status === 'number' ? `HTTP ${err.status}` : 'request failed'})` };
			}
		}
	};
}

/** Add the user name, port and embedded-password flag Tableau's REST API reports for each connection; fail-soft. */
async function addTableauConnectionDetails(t, client, ir, decision) {
	if (!client || !t.listConnections) return;
	const { compareHosts } = await import('../domo/accounts.js');
	const luid = decision.datasource.published?.luid;
	let rows;
	try {
		rows = luid ? await t.listConnections(client, { datasource: luid }) : ir.workbook?.luid ? await t.listConnections(client, { workbook: ir.workbook.luid }) : [];
	} catch {
		return;
	}
	if (!luid) rows = rows.filter((r) => !r.datasourceName || r.datasourceName === decision.datasource.caption);
	for (const conn of decision.connections) {
		const row = rows.find((r) => r.serverAddress && compareHosts(r.serverAddress, conn.server)) ?? (rows.length === 1 && decision.connections.length === 1 ? rows[0] : undefined);
		if (!row) continue;
		if (row.userName) conn.username = row.userName;
		if (row.serverPort && !conn.port) conn.port = row.serverPort;
		if (row.embedPassword !== undefined) conn.embedPassword = row.embedPassword;
	}
}

/** Record the filter members the data holds only in another case (DataManifest.memberCase); convert rewrites them. */
async function recordMemberCase({ ws, p, ir, ds, dsSlug, manifest, emitter }) {
	delete manifest.memberCase;
	if (!manifest.tables?.some((t) => t.file)) return;
	const memberCase = await scanMemberCase(ir, ds, manifest, p.dir).catch((err) => {
		emitter.warn(`Could not compare filter members with the data of "${ds.caption}": ${err.message}`);
		return {};
	});
	if (!Object.keys(memberCase).length) return;
	manifest.memberCase = memberCase;
	await ws.writeJson(p.manifest(dsSlug), manifest);
}

async function sampleManifest(manifest, { dir, rows, caption, emitter }) {
	let truncated = 0;
	for (const table of manifest.tables) {
		if (!table.file || !(table.rowCount > rows)) continue;
		const file = path.resolve(dir, table.file);
		const result = await copyCsvHead({ input: file, output: file, rows });
		table.rowCount = result.rowCount;
		if (result.truncated) truncated++;
	}
	if (!truncated) return;
	manifest.sampled = rows;
	const joined = manifest.tables.length > 1 ? ' Tables were sampled separately, so joins over them may match fewer rows.' : '';
	manifest.issues = [
		...(manifest.issues ?? []),
		{
			severity: 'warning',
			code: 'data.sampled',
			message: `Only the first ${rows} rows per table were kept for "${caption}"; data in Domo will be partial.${joined}`,
			object: { type: 'datasource', name: caption, id: manifest.datasourceId },
			suggestion: 'Extract again without --sample-rows for the full data.'
		}
	];
	emitter.warn(`Kept the first ${rows} rows per table of "${caption}" (sample)`);
}

const SHAREABLE_STRATEGIES = new Set(['auto', 'existing', 'cloud-amplifier', 'federated', 'connector', 'published-extract', 'vds', 'none']);
const SHARED_SLUG = 'datasource';

/**
 * True when a datasource's data is extracted once per site under workspace/datasources/<luid>/ and shared by
 * every workbook that uses it: a published datasource with a resolved luid and no extract packaged in the workbook.
 * @param {import('../model/types.js').DatasourceIR} ds
 * @param {string} strategy
 * @param {any} [pkg]
 */
export function isSharedDatasource(ds, strategy, pkg) {
	if (!ds?.published?.luid || !SHAREABLE_STRATEGIES.has(strategy)) return false;
	return !(pkg && ds.extract?.enabled && ds.extract.hyperFiles?.length);
}

function sharedMappingsHash(mappings) {
	return shortHash({ datasets: mappings.datasets ?? {}, cloudAmplifier: mappings.cloudAmplifier ?? [], federated: mappings.federated ?? [], accounts: mappings.accounts ?? [], columns: mappings.columns ?? {} });
}

function changedFields(before, after) {
	const prev = new Map((before ?? []).map((f) => [f.id, JSON.stringify(f)]));
	return (after ?? []).filter((f) => prev.get(f.id) !== JSON.stringify(f));
}

/** Apply fields recorded by a shared extraction (published definitions) to a workbook's copy of the datasource. */
export function applySharedFields(ds, fields) {
	const list = ds.fields ?? [];
	const index = new Map(list.map((f, i) => [f.id, i]));
	for (const field of fields ?? []) {
		const at = index.get(field.id);
		if (at === undefined) {
			index.set(field.id, list.length);
			list.push(structuredClone(field));
		} else if ((!list[at].kind || list[at].kind === 'column') && field.kind && field.kind !== 'column') {
			list[at] = { ...structuredClone(field), ...(list[at].aliases && !field.aliases ? { aliases: list[at].aliases } : {}) };
		}
	}
	ds.fields = list;
}

const PHYSICAL_KEYS = ['connections', 'tables', 'relationships', 'relationTree'];

/** Connections and tables an extraction took from the published datasource (connector strategy), to replay on every workbook. */
function physicalLayerChange(before, after) {
	if (PHYSICAL_KEYS.every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]))) return {};
	return { physical: Object.fromEntries(PHYSICAL_KEYS.filter((k) => after[k] !== undefined).map((k) => [k, after[k]])) };
}

function sharedFilesExist(manifest, dir) {
	return (manifest.tables ?? []).every((t) => !t.file || fs.existsSync(path.resolve(dir, t.file)));
}

/**
 * Extract (or reuse) the data of a published datasource at site scope, then return the workbook's manifest,
 * whose table files point into the shared directory.
 */
async function extractSharedDatasource({ ws, t, slug, p, ds, dsSlug, client, ir, strategy, mappings, python, cloudAmplifier, federated, published, sel, refresh, sharedCache, timer, emitter, gate = {} }) {
	const luid = ds.published.luid;
	const name = ds.published.name || ds.caption;
	const sp = ws.sharedPaths(luid);
	const variantDir = sel.sampleRows ? path.join(sp.dir, `sample-${sel.sampleRows}`) : sp.dir;
	const manifestFile = path.join(variantDir, 'manifest.json');
	let remote = null;
	if (client && t.findDatasource) remote = await t.findDatasource(client, { luid }).catch(() => null);
	const reuseKey = shortHash({ strategy, sampleRows: sel.sampleRows ?? null, updatedAt: remote?.updatedAt ?? null, mappings: sharedMappingsHash(mappings), domo: Boolean(cloudAmplifier), ...(cloudAmplifier?.snowflakeViews ? { snowflakeViews: true } : {}) });
	const cacheKey = `${luid}:${sel.sampleRows ?? ''}`;

	let shared = sharedCache?.get(cacheKey)?.reuseKey === reuseKey ? sharedCache.get(cacheKey).manifest : null;
	let reused = Boolean(shared);
	if (!shared && !refresh && remote?.updatedAt) {
		const onDisk = await ws.readJson(manifestFile, null).catch(() => null);
		if (onDisk?.shared?.reuseKey === reuseKey && sharedFilesExist(onDisk, variantDir)) {
			shared = onDisk;
			reused = true;
		}
	}
	if (reused) {
		emitter.info(`Reusing the shared data of published datasource "${name}" (${shared.strategy}, extracted ${shared.shared?.extractedAt ?? 'earlier'} for ${shared.shared?.extractedBy ?? 'another workbook'})`);
	} else {
		const canonical = structuredClone(ds);
		emitter.step(`${gate.planOnly ? 'Resolving' : 'Extracting'} shared data for published datasource "${name}" (${gate.snapshotOnly ? 'export' : strategy})`);
		let manifest;
		try {
			manifest = await t.extractData({ client, ir, datasource: canonical, pkg: null, dir: variantDir, slug: SHARED_SLUG, strategy, mappings, python, cloudAmplifier, federated, published, skipViewCsv: true, timer, emitter: emitter.child(dsSlug), ...gate });
		} catch (err) {
			emitter.warn(`Data extraction failed for "${ds.caption}": ${err.message}`);
			manifest = { datasourceId: ds.id, strategy: 'none', tables: [], issues: [extractFailedIssue(ds, err)] };
		}
		if (manifest.strategy === 'pending' || manifest.strategy === 'deferred') return { ...manifest, datasourceId: ds.id };
		if (sel.sampleRows && manifest.tables?.length) await sampleManifest(manifest, { dir: variantDir, rows: sel.sampleRows, caption: ds.caption, emitter });
		shared = {
			...manifest,
			shared: { luid, name, reuseKey, ...(remote?.updatedAt ? { updatedAt: remote.updatedAt } : {}), extractedAt: new Date().toISOString(), extractedBy: slug, fields: changedFields(ds.fields, canonical.fields), ...physicalLayerChange(ds, canonical) }
		};
		await ws.writeJson(manifestFile, shared);
	}
	sharedCache?.set(cacheKey, { reuseKey, manifest: shared });
	applySharedFields(ds, shared.shared?.fields);
	if (shared.shared?.physical) Object.assign(ds, structuredClone(shared.shared.physical));

	const object = { type: 'datasource', name: ds.caption, id: ds.id };
	const info = { ...shared.shared };
	delete info.fields;
	delete info.physical;
	delete info.reuseKey;
	const manifest = {
		...shared,
		datasourceId: ds.id,
		tables: (shared.tables ?? []).map((tbl) => (tbl.file ? { ...tbl, file: path.relative(p.dir, path.resolve(variantDir, tbl.file)).split(path.sep).join('/') } : tbl)),
		issues: (shared.issues ?? []).map((i) => (i.object?.type === 'datasource' ? { ...i, object } : i)),
		shared: { ...info, dir: ws.relative(variantDir), reused }
	};
	if (reused) {
		manifest.issues = [...manifest.issues, { severity: 'info', code: 'data.shared-reused', message: `Published datasource "${name}" is shared: its data was extracted once (for ${info.extractedBy ?? 'another workbook'}) and becomes one Domo dataset for every workbook that uses it.`, object }];
	}
	if (manifest.strategy === 'none' && strategy === 'auto' && client && ir.workbook?.luid && !(manifest.issues ?? []).some((i) => i.code === 'data.unmapped-none')) {
		const viaViews = await t.extractData({ client, ir, datasource: ds, pkg: null, dir: p.dir, slug: dsSlug, strategy: 'view-csv', mappings, python, timer, emitter: emitter.child(dsSlug) }).catch(() => null);
		if (viaViews?.strategy === 'view-csv') {
			viaViews.issues = [
				...(viaViews.issues ?? []),
				{ severity: 'warning', code: 'data.shared-view-csv', message: `No shared data could be extracted for published datasource "${name}"; this workbook's views were exported instead, so its Domo dataset belongs to this workbook only.`, object }
			];
			await ws.writeJson(p.manifest(dsSlug), viaViews);
			return viaViews;
		}
	}
	await ws.writeJson(p.manifest(dsSlug), manifest);
	return manifest;
}

const DEFINITION_FILE = 'definition.json';

let parserStamp;
/** Hash of the workbook parser sources, so a saved definition is read again after the parser changes. */
export function definitionParserStamp() {
	if (parserStamp === undefined) {
		const dir = new URL('../tableau/twb/', import.meta.url);
		const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
		parserStamp = shortHash(files.map((f) => [f, fs.readFileSync(new URL(f, dir), 'utf8')]));
	}
	return parserStamp;
}

/**
 * A published datasource's .tds (downloaded without its extract) as a DatasourceIR, read once per luid: shared through
 * `sharedCache` in a batch and kept in workspace/datasources/<luid>/definition.json while its Tableau updatedAt is unchanged.
 */
function publishedDefinition({ ws, t, client, luid, sharedCache, refresh }) {
	const key = `definition:${luid}`;
	const cached = sharedCache?.get(key);
	if (cached) return cached;
	const pending = (async () => {
		const dir = ws.sharedPaths(luid).dir;
		const file = path.join(dir, DEFINITION_FILE);
		const remote = t.findDatasource ? await t.findDatasource(client, { luid }).catch(() => null) : null;
		if (!refresh && remote?.updatedAt) {
			const onDisk = await ws.readJson(file, null).catch(() => null);
			if (onDisk?.updatedAt === remote.updatedAt && onDisk.parser === definitionParserStamp() && onDisk.datasource) return { datasource: onDisk.datasource, reused: true };
		}
		const datasource = await t.readPublishedDatasource(client, luid, path.join(dir, '.download'));
		await ws.writeJson(file, { luid, ...(remote?.updatedAt ? { updatedAt: remote.updatedAt } : {}), parser: definitionParserStamp(), readAt: new Date().toISOString(), datasource });
		return { datasource, reused: false };
	})();
	if (sharedCache) {
		sharedCache.set(key, pending);
		pending.catch(() => sharedCache.delete(key));
	}
	return pending;
}

/** Merge a published datasource's field definitions into the workbook copy; returns the definition, or undefined when it cannot be read. */
async function mergePublishedDefinition({ ws, t, client, ir, ds, sharedCache, refresh, emitter }) {
	const name = ds.published.name || ds.caption;
	const object = { type: 'datasource', name: ds.caption, id: ds.id };
	let definition;
	try {
		emitter.step(`Reading the field definitions of published datasource "${name}"`);
		const { datasource, reused } = await publishedDefinition({ ws, t, client, luid: ds.published.luid, sharedCache, refresh });
		if (reused) emitter.info(`Reusing the field definitions of published datasource "${name}" read earlier`);
		definition = datasource;
	} catch (err) {
		emitter.warn(`Could not read the field definitions of published datasource "${name}": ${err.message}`);
		ir.issues.push({
			severity: 'warning',
			code: 'extract.published-fields-unavailable',
			message: `The .tds of published datasource "${name}" could not be downloaded, so calculations, groups and sets defined only there are missing: ${err.message}`,
			object,
			suggestion: 'The PAT user needs the Download Data Source capability on the published datasource.'
		});
		return undefined;
	}
	const { added, filled } = t.mergePublishedDefinitions(ds, definition);
	const known = new Set((ir.parameters ??= []).map((prm) => prm.id));
	const parameters = (definition.parameters ?? []).filter((prm) => !known.has(prm.id));
	if (parameters.length) {
		ir.parameters.push(...structuredClone(parameters));
		ir.issues.push({
			severity: 'info',
			code: 'extract.published-parameters',
			message: `Took ${parameters.length} parameter(s) from published datasource "${name}" that the workbook does not list: ${parameters.map((prm) => prm.name).join(', ')}.`,
			object
		});
	}
	if (added.length || filled.length) {
		const calcs = added.filter((f) => f.kind === 'calculated').length;
		const names = added.slice(0, 15).map((f) => f.name).join(', ');
		ir.issues.push({
			severity: 'info',
			code: 'extract.published-fields',
			message: `Took ${added.length} field definition(s) that the workbook copy of published datasource "${name}" lacks${calcs ? ` (${calcs} calculation(s))` : ''}${names ? `: ${names}${added.length > 15 ? ', ...' : ''}` : ''}${filled.length ? `; filled aliases, types or formulas of ${filled.length} field(s)` : ''}.`,
			object
		});
	}
	return definition;
}

function extractFailedIssue(ds, err) {
	return {
		severity: 'error',
		code: 'data.extract-failed',
		message: `Data extraction failed: ${err.message}`,
		object: { type: 'datasource', name: ds.caption, id: ds.id },
		suggestion: 'Map an existing Domo dataset in mappings.json, or retry with another --data-strategy.'
	};
}

function pendingIssue(ds, decision, dryRun) {
	return {
		severity: 'warning',
		code: 'data.decision-pending',
		message: `No data for "${ds.caption}": no mapping covers it, and ${dryRun ? 'a dry run' : 'extract without its data (--no-extract-data)'} does not ask whether to export it.`,
		object: { type: 'datasource', name: ds.caption, id: ds.id },
		suggestion: `Add one of these to mappings.json: ${Object.values(decision?.entries ?? {}).map((e) => JSON.stringify(e)).join(' or ')}`
	};
}

function needsApi(strategy, datasources) {
	if (API_STRATEGIES.has(strategy)) return true;
	if (strategy !== 'auto') return false;
	return datasources.some((ds) => ds.published || !(ds.extract?.enabled && ds.extract?.hyperFiles?.length));
}

/**
 * Stage 1: get a workbook into the workspace and build its IR and data files.
 *
 * @param {{
 *   config: import('../config.js').T2DConfig,
 *   workbook?: string,
 *   file?: string,
 *   project?: string,
 *   dataStrategy?: 'auto'|'existing'|'connector'|'hyper'|'published-extract'|'vds'|'view-csv'|'none',
 *   includeExtract?: boolean,
 *   metadata?: boolean,
 *   publishedFields?: boolean,
 *   domoLookup?: boolean,
 *   selection?: import('../convert/select.js').Selection,
 *   client?: import('../tableau/client.js').TableauClient,
 *   sharedCache?: Map<string, any>,
 *   refreshShared?: boolean,
 *   emitter?: import('../util/events.js').Emitter,
 *   deps?: Record<string, any>
 * }} opts  `domoLookup` (default true) allows read-only Domo calls to match Cloud Amplifier integrations when
 *   Domo settings are present. `selection` limits data extraction to the datasources its dashboards, worksheets
 *   and datasources use (manifests of other datasources are kept), and `selection.sampleRows` keeps only the
 *   first N rows per table (`manifest.sampled`). A published datasource with a resolved luid is extracted once per
 *   site under workspace/datasources/<luid>/ (`manifest.shared`) and reused while its Tableau updatedAt, the strategy and
 *   the mappings are unchanged (`refreshShared` forces a new extraction; `sharedCache` shares results across a batch run).
 *   The field definitions of each published datasource (calculations, groups, bins, sets, aliases) are merged from
 *   its .tds downloaded without the extract, whatever the data strategy, unless `metadata` or `publishedFields` is false.
 *   `client` is a signed-in TableauClient to use (not signed out here). `deps` overrides the tableau modules, and
 *   `deps.domo` the Domo lookups (tests).
 *
 *   Under the auto strategy, a datasource that no mapping covers and that would become a snapshot export needs a
 *   decision first (`unmapped`, default 'ask'). Every datasource is resolved before any data is downloaded; the open
 *   decisions go to `decide(decisions)` at once, whose answers are recorded in mappings.json. Without `decide`, with
 *   `unmapped: 'fail'`, or for answers left out, it throws DataDecisionError. `unmapped: 'export'` exports as before.
 *   A datasource exported by an earlier extract of this workbook is not asked about. `dryRun`, and `includeExtract`
 *   false, never ask: undecided datasources get no data and a `data.decision-pending` warning. `decisionsOnly`
 *   returns `{ slug, decisions }` after resolving, writing no IR, logs or snapshot data (a batch asks once up front).
 * @returns {Promise<{ slug: string, ir: import('../model/types.js').WorkbookIR, manifests: import('../model/types.js').DataManifest[], decisions?: import('./decisions.js').DataDecision[] }>}
 */
export async function extractWorkbook({
	config,
	workbook,
	file,
	project,
	dataStrategy = 'auto',
	includeExtract = true,
	metadata = true,
	publishedFields = true,
	domoLookup = true,
	snowflakeViews = false,
	selection,
	client: givenClient,
	sharedCache,
	refreshShared = false,
	unmapped = 'ask',
	decide,
	dryRun = false,
	decisionsOnly = false,
	emitter = createEmitter(undefined, 'extract'),
	deps
}) {
	const sel = normalizeSelection(selection);
	if (!workbook && !file) throw new Error('extractWorkbook needs a workbook (name or luid) or a file');
	if (workbook && file) throw new Error('Pass either a workbook or a file, not both');
	if (!STRATEGIES.has(dataStrategy)) throw new Error(`Unknown data strategy "${dataStrategy}" (use ${[...STRATEGIES].join(', ')})`);
	if (!UNMAPPED_POLICIES.includes(unmapped)) throw new Error(`Unknown unmapped policy "${unmapped}" (use ${UNMAPPED_POLICIES.join(', ')})`);

	const timer = createTimer({ emitter });
	const t = await loadTableauDeps(deps);
	const ws = openWorkspace(config.workspace);
	if (await ws.ensureMappings()) emitter.info(`Created ${ws.mappingsFile} (edit it to map existing datasets and connector accounts)`);
	let mappings = await ws.loadMappings();
	const asking = dataStrategy === 'auto' && unmapped !== 'export';
	const holdData = dryRun || !includeExtract;

	let client = givenClient ?? null;
	let signedIn = false;
	const signIn = async () => {
		if (signedIn || givenClient) return client;
		requireTableau(config);
		client = client || new t.TableauClient(config.tableau, { emitter: emitter.child('tableau') });
		emitter.step(`Signing in to Tableau ${config.tableau.server}`);
		await timer.time('tableau.sign-in', () => client.signIn());
		signedIn = true;
		return client;
	};

	let pkg = null;
	let runSlug = null;
	let runInfo = null;
	try {
		let info;
		let slug;
		let sourcePath;
		let identity;
		if (file) {
			const abs = path.resolve(file);
			if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
			const ext = path.extname(abs).slice(1).toLowerCase();
			if (!['twb', 'twbx'].includes(ext)) throw new Error(`Expected a .twb or .twbx file, got ${abs}`);
			const name = path.basename(abs, path.extname(abs));
			identity = `file:${shortHash(abs)}`;
			slug = await chooseSlug(ws, name, identity);
			runSlug = slug;
			runInfo = { name };
			const p = ws.paths(slug);
			await fsp.mkdir(p.dir, { recursive: true });
			sourcePath = p.source(ext);
			if (path.resolve(sourcePath) !== abs) await fsp.copyFile(abs, sourcePath);
			info = { name };
			emitter.step(`Copied ${abs} into the workspace as ${slug}`);
		} else {
			await signIn();
			emitter.step(`Finding workbook "${workbook}"`);
			const wb = await timer.time('tableau.find-workbook', () => t.findWorkbook(client, workbook, { project }));
			identity = wb.id;
			slug = await chooseSlug(ws, wb.name, identity);
			runSlug = slug;
			runInfo = { name: wb.name, luid: wb.id };
			const p = ws.paths(slug);
			await fsp.mkdir(p.dir, { recursive: true });
			emitter.step(`Downloading "${wb.name}"${includeExtract ? '' : ' (without extract)'}`);
			const downloaded = await timer.time('workbook.download', () => t.downloadWorkbook(client, wb.id, p.dir, { includeExtract }), (r) => ({ bytes: fileSize(r.file) }));
			const ext = path.extname(downloaded.file).slice(1).toLowerCase() || 'twbx';
			sourcePath = p.source(ext);
			if (path.resolve(downloaded.file) !== path.resolve(sourcePath)) await fsp.rename(downloaded.file, sourcePath);
			info = {
				name: wb.name,
				luid: wb.id,
				projectName: wb.project?.name,
				contentUrl: wb.contentUrl,
				webpageUrl: wb.webpageUrl
			};
			try {
				info.views = (await t.listWorkbookViews(client, wb.id)).map((v) => ({ name: v.name, contentUrl: v.contentUrl }));
			} catch (err) {
				emitter.warn(`Could not list the workbook's views on Tableau, continuing without them: ${err.message}`);
			}
		}

		const p = ws.paths(slug);
		emitter.step('Reading the workbook package');
		const endParse = timer.start('workbook.parse', { bytes: fileSize(sourcePath) });
		pkg = await t.openPackage(sourcePath);
		await ws.writeText(p.twb, pkg.xml);

		emitter.step('Building the workbook IR');
		const ir = t.buildWorkbookIR(pkg.xml, { sourceFile: ws.relative(sourcePath), info });
		ir.issues.push(...(await extractImages(pkg, ir, p.dir)));
		endParse({ worksheets: ir.worksheets.length, dashboards: ir.dashboards.length, datasources: ir.datasources.length });
		if (client) {
			const linkedViews = await linkedViewsOf(t, client, ir, emitter);
			if (linkedViews.length) ir.workbook.linkedViews = linkedViews;
		}

		let rawMetadata = null;
		if (metadata && info.luid && client) {
			try {
				emitter.step('Fetching Metadata API lineage');
				rawMetadata = await timer.time('tableau.metadata', () => t.fetchWorkbookMetadata(client, info.luid));
				if (rawMetadata) t.applyMetadata(ir, rawMetadata);
			} catch (err) {
				emitter.warn(`Metadata API lookup failed, continuing without it: ${err.message}`);
				ir.issues.push({
					severity: 'info',
					code: 'extract.metadata-unavailable',
					message: `Metadata API lookup failed: ${err.message}`,
					suggestion: 'Enable the Tableau Metadata API (Catalog) or ignore; formulas come from the workbook XML.'
				});
			}
		}

		const allUsed = usedDatasources(ir);
		const unused = ir.datasources.filter((ds) => !allUsed.includes(ds));
		for (const ds of unused) emitter.info(`Skipping data for "${ds.caption}" (not used by any worksheet)`);
		let used = allUsed;
		let resolvedSelection;
		if (hasObjectSelection(sel)) {
			resolvedSelection = selectIrDatasources(ir, sel);
			used = ir.datasources.filter((ds) => resolvedSelection.datasourceIds.has(ds.id));
			for (const ds of allUsed.filter((d) => !used.includes(d))) emitter.info(`Skipping data for "${ds.caption}" (not in the selection)`);
		}

		const readDefinitions = metadata && publishedFields && Boolean(t.readPublishedDatasource);
		if (!client && dataStrategy !== 'none' && needsApi(dataStrategy, used)) {
			if (API_STRATEGIES.has(dataStrategy) || tableauConfigured(config)) await signIn();
		}
		if (!client && readDefinitions && used.some((d) => d.published) && tableauConfigured(config)) await signIn();

		if (client) {
			for (const ds of used.filter((d) => d.published && !d.published.luid)) {
				try {
					const found = await t.findDatasource(client, {
						contentUrl: ds.published.repositoryId,
						name: ds.published.name || ds.caption
					});
					if (found?.id) ds.published.luid = found.id;
				} catch (err) {
					emitter.warn(`Could not resolve published datasource "${ds.caption}": ${err.message}`);
				}
			}
		}

		const definitions = new Map();
		if (client && readDefinitions) {
			for (const ds of used.filter((d) => d.published?.luid)) {
				const definition = await timer.time('datasource.definition', () => mergePublishedDefinition({ ws, t, client, ir, ds, sharedCache, refresh: refreshShared, emitter }), { name: ds.caption });
				if (definition) definitions.set(ds.id, definition);
			}
		}

		let python = config.python;
		if (used.length && HYPER_STRATEGIES.has(dataStrategy) && !config.pythonExplicit && t.detectPython) {
			const found = await t.detectPython({ python: config.python });
			if (found.detected) emitter.info(`Using ${found.python} for the Hyper sidecar (set T2D_PYTHON to choose another)`);
			python = found.python;
		}

		const cloudAmplifier =
			domoLookup && ['auto', 'cloud-amplifier'].includes(dataStrategy) && (deps?.domo || domoConfigured(config))
				? cloudAmplifierLookup({ config, emitter, domo: deps?.domo })
				: undefined;
		if (cloudAmplifier && snowflakeViews) cloudAmplifier.snowflakeViews = await snowflakeViewsHandler({ config, ws, emitter, deps });

		const federated =
			domoLookup && ['auto', 'federated'].includes(dataStrategy) && (deps?.domo || domoConfigured(config)) ? federatedLookup({ config, emitter, domo: deps?.domo }) : undefined;

		const slugOf = (ds) => (t.datasourceSlug ? t.datasourceSlug(ds) : fallbackDatasourceSlug(ds));
		const manifests = [];
		const exportedBefore = new Set();
		const stale = await fsp.readdir(p.dataDir).catch(() => []);
		const knownIds = new Set(ir.datasources.map((ds) => ds.id));
		for (const name of stale.filter((n) => n.endsWith('.manifest.json'))) {
			const file = path.join(p.dataDir, name);
			const old = await ws.readJson(file, null).catch(() => null);
			if (old && SNAPSHOT_STRATEGIES.has(old.strategy)) exportedBefore.add(old.datasourceId);
			if (decisionsOnly) continue;
			if (resolvedSelection && old && knownIds.has(old.datasourceId) && !used.some((ds) => ds.id === old.datasourceId)) continue;
			await fsp.rm(file, { force: true });
		}

		const extractOne = async (ds, dsSlug, { strategy = dataStrategy, ...gate }) => {
			if (isSharedDatasource(ds, strategy, pkg)) {
				return extractSharedDatasource({ ws, t, slug, p, ds, dsSlug, client, ir, strategy, mappings, python, cloudAmplifier, federated, published: definitions.get(ds.id), sel, refresh: refreshShared, sharedCache, timer, emitter, gate });
			}
			let manifest;
			try {
				manifest = await t.extractData({
					client,
					ir,
					datasource: ds,
					pkg,
					dir: p.dir,
					strategy,
					mappings,
					python,
					cloudAmplifier,
					federated,
					published: definitions.get(ds.id),
					timer,
					emitter: emitter.child(dsSlug),
					...gate
				});
			} catch (err) {
				emitter.warn(`Data extraction failed for "${ds.caption}": ${err.message}`);
				manifest = { datasourceId: ds.id, strategy: 'none', tables: [], issues: [extractFailedIssue(ds, err)] };
				await ws.writeJson(p.manifest(dsSlug), manifest);
			}
			if (manifest.strategy !== 'pending' && manifest.strategy !== 'deferred' && sel.sampleRows && manifest.tables?.length) {
				await sampleManifest(manifest, { dir: p.dir, rows: sel.sampleRows, caption: ds.caption, emitter });
				await ws.writeJson(p.manifest(dsSlug), manifest);
			}
			return manifest;
		};

		const states = [];
		for (const ds of used) {
			const dsSlug = slugOf(ds);
			emitter.step(`${asking ? 'Resolving' : 'Extracting'} data for "${ds.caption}" (${dataStrategy})`);
			const endData = timer.start('datasource', { name: ds.caption });
			const gate = asking ? { unmapped: exportedBefore.has(ds.id) ? 'export' : 'ask', planOnly: true } : {};
			states.push({ ds, dsSlug, endData, manifest: await extractOne(ds, dsSlug, gate) });
		}

		const open = states.filter((s) => s.manifest.strategy === 'pending');
		let decisions = [];
		let recorded = [];
		if (open.length) {
			const accounts = domoLookup && (deps?.domo || domoConfigured(config)) ? connectorAccountLookup({ config, emitter, domo: deps?.domo }) : null;
			const raw = [];
			for (const s of open) {
				const decision = structuredClone(s.manifest.decision);
				await addTableauConnectionDetails(t, client, ir, decision);
				const connection = decision.connections.find((c) => connectorFamily(c.class)) ?? decision.connections[0];
				if (accounts && connection && !decision.connectorBlocked) decision.accounts = await accounts.forConnection(connection);
				if (federated && connection && !decision.federatedBlocked) decision.federated = await federated.forConnection(connection);
				raw.push(completeDecision(decision, { key: decisionKey(s.ds), workbook: slug }));
			}
			decisions = mergeDecisions(raw);
			for (const d of decisions) emitter.decision?.(`"${d.datasource.caption}" needs a data decision: no mapping covers it, and an export would copy every row through Tableau`, d);
			if (decisionsOnly) return { slug, ir, manifests: [], decisions };
			if (!holdData) {
				const answers = unmapped === 'ask' && decide ? await timer.time('data.decisions', () => decide(decisions), { count: decisions.length }) : null;
				recorded = answers?.length ? await recordAnswers(ws.mappingsFile, decisions, answers) : [];
				for (const r of recorded) emitter.info(`Recorded in ${ws.relative(ws.mappingsFile)}: ${JSON.stringify(r.entry)}`);
				const unanswered = decisions.filter((d) => !recorded.some((r) => r.key === d.key));
				if (unanswered.length) throw new DataDecisionError(unanswered);
				mappings = await ws.loadMappings();
			}
		}
		if (decisionsOnly) return { slug, ir, manifests: [], decisions };

		for (const s of states) {
			const { ds, dsSlug } = s;
			let manifest = s.manifest;
			const prior = { unmapped: 'export', snapshotOnly: true, priorIssues: manifest.issues ?? [] };
			if (manifest.strategy === 'deferred') {
				emitter.step(`Extracting data for "${ds.caption}" (export)`);
				manifest = await extractOne(ds, dsSlug, prior);
			} else if (manifest.strategy === 'pending' && holdData) {
				const decision = decisions.find((d) => d.key === decisionKey(ds));
				manifest = { datasourceId: ds.id, strategy: 'none', tables: [], issues: [...(manifest.issues ?? []), pendingIssue(ds, decision, dryRun)] };
				await ws.writeJson(p.manifest(dsSlug), manifest);
			} else if (manifest.strategy === 'pending') {
				const spec = choiceSpec(recorded.find((r) => r.key === decisionKey(ds)).choice);
				const viaGate = spec.choice === 'export' || spec.choice === 'none';
				emitter.step(`Extracting data for "${ds.caption}" (${spec.choice === 'export' ? 'export' : spec.strategy})`);
				manifest = await extractOne(ds, dsSlug, viaGate ? prior : { strategy: spec.strategy, unmapped: 'export' });
			}
			await recordMemberCase({ ws, p, ir, ds, dsSlug, manifest, emitter });
			s.endData(dataStats(manifest, p.dir));
			manifests.push(manifest);
		}

		await ws.writeJson(p.ir, ir);
		await ws.writeJson(p.metadata, {
			workbook: info,
			identity,
			source: file ? 'file' : 'server',
			sourceFile: ws.relative(sourcePath),
			extractedAt: new Date().toISOString(),
			dataStrategy,
			domoLookup: Boolean(cloudAmplifier),
			includeExtract,
			...(resolvedSelection || sel.sampleRows
				? {
						selection: {
							...(resolvedSelection ? { dashboards: resolvedSelection.dashboards, worksheets: resolvedSelection.worksheets, datasources: resolvedSelection.datasources } : {}),
							...(sel.sampleRows ? { sampleRows: sel.sampleRows } : {})
						}
					}
				: {}),
			datasources: used.map((ds) => ({ id: ds.id, caption: ds.caption, slug: slugOf(ds) })),
			...(rawMetadata ? { metadataApi: rawMetadata } : {})
		});
		const timing = timer.finish({ slug });
		const log = {
			slug,
			workbook: info.name,
			...(info.luid ? { luid: info.luid } : {}),
			source: file ? 'file' : 'server',
			dataStrategy,
			ok: true,
			startedAt: timing.startedAt,
			finishedAt: timing.finishedAt,
			datasources: used.map((ds, i) => ({ id: ds.id, name: ds.caption, ...dataStats(manifests[i], p.dir), ...(manifests[i]?.shared ? { shared: true, reused: Boolean(manifests[i].shared.reused) } : {}) })),
			timing
		};
		await ws.writeJson(p.extractLog, log);
		await writeRunLog(ws, slug, 'extract', log);
		emitter.done(`Extracted "${info.name}" to ${ws.relative(p.dir)}`, {
			slug,
			datasources: used.length,
			worksheets: ir.worksheets.length,
			dashboards: ir.dashboards.length,
			ms: timing.ms
		});
		return { slug, ir, manifests, timing };
	} catch (err) {
		if (runSlug) {
			const timing = timer.finish({ slug: runSlug, failed: true });
			const log = { slug: runSlug, workbook: runInfo?.name, ...(runInfo?.luid ? { luid: runInfo.luid } : {}), source: file ? 'file' : 'server', dataStrategy, ok: false, error: err.message, startedAt: timing.startedAt, finishedAt: timing.finishedAt, timing };
			await writeRunLog(ws, runSlug, 'extract', log).catch(() => {});
		}
		throw err;
	} finally {
		if (pkg) await Promise.resolve(pkg.close?.()).catch(() => {});
		if (signedIn) await client.signOut().catch(() => {});
	}
}
