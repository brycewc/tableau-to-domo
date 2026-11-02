import { requireDomo, requireTableau } from '../../config.js';
import { createEmitter } from '../../util/events.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { formatTable } from '../reporter.js';
import { UsageError } from '../shared.js';

export const name = 'list';
export const summary = 'List Tableau projects, workbooks, datasources or views, local workbooks, or Domo connector providers, accounts, Cloud Amplifier integrations and federated accounts';
export const usage = 't2d list <projects|workbooks|datasources|views|local|providers|accounts|integrations|federated> [--project <name>] [--name <text>] [--workbook <name|luid>] [--provider <key>] [--engine <engine>]';
export const options = {
	project: { type: 'string', short: 'p', value: '<name>', description: 'Filter by project' },
	name: { type: 'string', value: '<text>', description: 'Filter by name' },
	workbook: { type: 'string', short: 'w', value: '<name|luid>', description: 'Workbook whose views to list (views)' },
	provider: { type: 'string', value: '<key>', description: 'Domo provider key whose accounts to list (accounts)' },
	engine: { type: 'string', value: '<engine>', description: 'Cloud Amplifier engine to list, e.g. SNOWFLAKE (integrations)' }
};

const WHAT = ['projects', 'workbooks', 'datasources', 'views', 'local', 'providers', 'accounts', 'integrations', 'federated'];

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const what = args.positionals[0];
	if (!what || !WHAT.includes(what)) throw new UsageError(`list needs one of: ${WHAT.join(', ')}`);
	const { project, name: nameFilter, workbook } = args.values;

	if (what === 'local') {
		const rows = await openWorkspace(config.workspace).listWorkbooks();
		reporter.print(rows.length ? formatTable(['Slug', 'Name', 'Source', 'IR', 'Plan', 'Pushed'], rows.map((r) => [r.slug, r.name, r.source ?? '', yn(r.hasIr), yn(r.hasPlan), yn(r.pushed)])) : 'No workbooks in the workspace yet.');
		return { items: rows };
	}

	if (['providers', 'accounts', 'integrations', 'federated'].includes(what)) return listDomo({ config, what, args, reporter });

	if (what === 'views' && !workbook) throw new UsageError('list views needs --workbook <name|luid>');
	requireTableau(config);
	const { TableauClient } = await import('../../tableau/client.js');
	const content = await import('../../tableau/content.js');
	const client = new TableauClient(config.tableau, { emitter: createEmitter(reporter.sink, 'tableau') });
	await client.signIn();
	try {
		let items;
		let rows;
		let headers;
		if (what === 'projects') {
			items = await content.listProjects(client);
			if (nameFilter) items = items.filter((x) => includes(x.name, nameFilter));
			headers = ['Name', 'Parent', 'Id'];
			rows = items.map((x) => [x.name, x.parentProjectId ?? '', x.id]);
		} else if (what === 'workbooks') {
			items = await content.listWorkbooks(client, { project, name: nameFilter });
			headers = ['Name', 'Project', 'Updated', 'Id'];
			rows = items.map((x) => [x.name, x.project?.name ?? '', x.updatedAt ?? '', x.id]);
		} else if (what === 'datasources') {
			items = await content.listDatasources(client, { project, name: nameFilter });
			headers = ['Name', 'Project', 'Type', 'Id'];
			rows = items.map((x) => [x.name, x.project?.name ?? '', x.type ?? '', x.id]);
		} else {
			const wb = await content.findWorkbook(client, workbook, { project });
			items = await content.listWorkbookViews(client, wb.id);
			if (nameFilter) items = items.filter((x) => includes(x.name, nameFilter));
			headers = ['Name', 'Content URL', 'Id'];
			rows = items.map((x) => [x.name, x.contentUrl ?? '', x.id]);
		}
		reporter.print(rows.length ? formatTable(headers, rows) : `No ${what} found.`);
		return { items };
	} finally {
		await client.signOut().catch(() => {});
	}
}

async function listDomo({ config, what, args, reporter }) {
	requireDomo(config);
	const { createDomoClient } = await import('../../domo/client.js');
	const { listProviders, listAccounts, searchAccounts, getAccountSettings } = await import('../../domo/accounts.js');
	const client = createDomoClient(config.domo, { emitter: createEmitter(reporter.sink, 'domo') });
	if (what === 'integrations') {
		const { listIntegrations, resolveSnowflakeAccounts } = await import('../../domo/cloud-amplifier.js');
		const engine = args.values.engine?.toUpperCase();
		const items = (await listIntegrations(client)).filter((i) => (!engine || i.engine === engine) && (!args.values.name || includes(i.name, args.values.name)));
		items.sort((a, b) => a.engine.localeCompare(b.engine) || a.name.localeCompare(b.name));
		const accounts = await resolveSnowflakeAccounts(client, items);
		for (const i of items) {
			const resolved = accounts.get(i.id);
			if (resolved?.account) i.account = resolved.account;
			else if (resolved) i.accountUnknown = resolved.reason;
		}
		reporter.print(
			items.length
				? formatTable(
						['Id', 'Engine', 'Name', 'Account', 'Database', 'Default schema', 'Host'],
						items.map((i) => [i.id, i.engine, i.name, i.account ?? (i.accountUnknown ? `unknown (${i.accountUnknown})` : ''), i.database ?? '', i.defaultSchema ?? '', i.host ?? ''])
					)
				: 'No Cloud Amplifier integrations found.'
		);
		if (items.length) {
			reporter.print('');
			reporter.print('To pin a Tableau connection to one, add to mappings.json: { "cloudAmplifier": [{ "match": { "class": "snowflake", "server": "<server>", "dbname": "<database>" }, "integrationId": "<id>" }] }');
		}
		return { items };
	}
	if (what === 'federated') return listFederated(client, args, reporter, { searchAccounts, getAccountSettings });
	if (what === 'providers') {
		const items = await listProviders(client, { name: args.values.name });
		reporter.print(items.length ? formatTable(['Key', 'Name', 'Default connector'], items.map((p) => [p.key, p.name, p.defaultConnectorId ?? ''])) : 'No providers found.');
		return { items };
	}
	const { provider, name: nameFilter } = args.values;
	let items = provider ? await searchAccounts(client, provider) : await listAccounts(client);
	if (nameFilter) items = items.filter((a) => includes(a.name, nameFilter));
	if (!items.length) {
		reporter.print(`No accounts found${provider ? ` for provider ${provider}` : ''}.`);
		return { items, mappings: [] };
	}
	const withSettings = items.filter((a) => a.providerKey && SETTINGS_PROVIDER.test(a.providerKey)).slice(0, SETTINGS_LIMIT);
	await Promise.all(
		withSettings.map(async (a) => {
			a.settings = await getAccountSettings(client, a.id, { providerKey: a.providerKey }).then((r) => r.settings, () => ({}));
		})
	);
	const host = (a) => a.settings?.host ?? a.settings?.hostname ?? a.settings?.server ?? a.settings?.account ?? '';
	const database = (a) => a.settings?.database ?? a.settings?.databaseName ?? '';
	reporter.print(formatTable(['Id', 'Name', 'Provider', 'Valid', 'Host', 'Database'], items.map((a) => [a.id, a.name, a.providerKey, a.valid === undefined ? '' : yn(a.valid), host(a), database(a)])));
	const { tableauClassForProvider } = await import('../../convert/connectors.js');
	const mappings = items.map((a) => accountMapping(a, tableauClassForProvider(a.providerKey)));
	reporter.print('');
	reporter.print('mappings.json accounts entries (set match to the Tableau connection, e.g. server and dbname):');
	reporter.print(JSON.stringify(mappings.length === 1 ? mappings[0] : mappings, null, '\t'));
	return { items, mappings };
}

/** Federated adapters, and the accounts of each provider (or of --provider) with their allowlisted host. */
async function listFederated(client, args, reporter, { searchAccounts, getAccountSettings }) {
	const { listAdapters } = await import('../../domo/federated.js');
	const adapters = await listAdapters(client);
	const providers = adapters.flatMap((a) => (a.providers ?? []).map((p) => ({ adapter: a.adapterType, key: p.providerType, name: p.providerName ?? '', cloud: Boolean(p.hasCloudAgent), onPremise: Boolean(p.hasOnPremiseAgent) })));
	reporter.print(providers.length ? formatTable(['Adapter', 'Provider', 'Name', 'Cloud agent', 'On-premise agent'], providers.map((p) => [p.adapter, p.key, p.name, yn(p.cloud), yn(p.onPremise)])) : 'No federated adapters found.');
	const keys = args.values.provider ? [args.values.provider] : [...new Set(providers.map((p) => p.key))];
	const accounts = [];
	for (const key of keys) {
		const list = (await searchAccounts(client, key)).filter((a) => !args.values.name || includes(a.name, args.values.name));
		for (const a of list.slice(0, SETTINGS_LIMIT)) {
			a.settings = await getAccountSettings(client, a.id, { providerKey: key }).then((r) => r.settings, () => ({}));
			accounts.push({ ...a, providerKey: key });
		}
	}
	reporter.print('');
	const host = (a) => a.settings?.['server-name'] ?? a.settings?.host ?? a.settings?.server ?? a.settings?.account ?? '';
	reporter.print(accounts.length ? formatTable(['Id', 'Name', 'Provider', 'Valid', 'Host'], accounts.map((a) => [a.id, a.name, a.providerKey, a.valid === undefined ? '' : yn(a.valid), host(a)])) : 'No federated accounts found.');
	if (accounts.length) {
		reporter.print('');
		reporter.print('To use one for plain tables, add to mappings.json: { "federated": [{ "match": { "class": "<class>", "server": "<server>", "dbname": "<database>" }, "accountId": <id>, "providerKey": "<provider>", "cacheTTL": 900 }] }');
	}
	return { items: accounts, adapters: providers };
}

/**
 * A ready-to-paste mappings.json accounts entry for a Domo account.
 * @param {{ id: number|string, providerKey: string }} account
 * @param {string} [tableauClass]
 */
export function accountMapping(account, tableauClass) {
	return {
		match: { class: tableauClass ?? '<tableau connection class>', server: '<server>' },
		accountId: account.id,
		providerKey: account.providerKey
	};
}

const SETTINGS_PROVIDER = /sql|snowflake|postgres|redshift|oracle|bigquery|databricks|teradata|maria/i;
const SETTINGS_LIMIT = 100;
const yn = (v) => (v ? 'yes' : '');
const includes = (value, text) => String(value ?? '').toLowerCase().includes(String(text).toLowerCase());
