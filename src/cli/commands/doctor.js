import fs from 'node:fs';
import { requireDomo, requireTableau } from '../../config.js';
import { createEmitter } from '../../util/events.js';
import { formatTable } from '../reporter.js';

export const name = 'doctor';
export const summary = 'Check Tableau and Domo credentials, VizQL Data Service access, App Studio availability, Cloud Amplifier integrations and the Hyper sidecar; never changes anything';
export const usage = 't2d doctor [--dataset <domo dataset id>] [--datasource <tableau datasource luid>]';
export const options = {
	dataset: { type: 'string', value: '<id>', description: 'Probe Beast Mode capabilities (FIXED, window, nested) on this dataset' },
	datasource: { type: 'string', value: '<luid>', description: 'Check VizQL Data Service access on this published datasource (default: the first one on the site)' }
};

const NON_FATAL = new Set(['hyper', 'cloud amplifier', 'vizql data service', 'app studio']);

/**
 * Read the metadata (never the data) of one published datasource through VizQL Data Service.
 * @param {import('../../tableau/client.js').TableauClient} client
 * @param {{ datasource?: string }} [opts]
 */
export async function checkVdsAccess(client, { datasource } = {}) {
	let target;
	if (datasource) {
		const json = await client.get(`/datasources/${encodeURIComponent(datasource)}`).catch(() => null);
		target = { id: datasource, name: json?.datasource?.name ?? datasource };
	} else {
		const json = await client.get('/datasources', { pageSize: 1, pageNumber: 1 });
		const first = [].concat(json?.datasources?.datasource ?? [])[0];
		if (!first) return { skipped: 'no published datasources on the site' };
		target = { id: first.id, name: first.name ?? first.id };
	}
	const { readDatasourceMetadata } = await import('../../tableau/data/vds.js');
	try {
		const fields = await readDatasourceMetadata(client, target.id);
		return `read-metadata ok on "${target.name}" (${fields.length} field(s)); the vds data strategy can be used where API Access is granted (it is set per datasource)`;
	} catch (err) {
		if (String(err?.code) === '403800' || /403800/.test(err?.message ?? '')) {
			throw new Error(`403800 on "${target.name}": the API Access capability is missing${datasource ? ' or the datasource does not exist' : ''}, so the vds data strategy will not work for it (published-extract and view-csv still can)`, { cause: err });
		}
		throw err;
	}
}

async function check(name, fn) {
	try {
		const detail = await fn();
		if (detail && typeof detail === 'object' && 'skipped' in detail) return { name, status: 'skipped', detail: detail.skipped };
		return { name, status: 'ok', detail: detail ?? '' };
	} catch (err) {
		return { name, status: 'failed', detail: err?.message ?? String(err) };
	}
}

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const emitter = createEmitter(reporter.sink, 'doctor');
	const checks = [];

	checks.push(
		await check('workspace', async () => `${config.workspace}${fs.existsSync(config.workspace) ? '' : ' (will be created)'}`)
	);

	let tableauClient = null;
	try {
		checks.push(
			await check('tableau', async () => {
				try {
					requireTableau(config);
				} catch (err) {
					return { skipped: err.message };
				}
				const { TableauClient } = await import('../../tableau/client.js');
				const client = new TableauClient(config.tableau, { emitter: emitter.child('tableau') });
				await client.signIn();
				tableauClient = client;
				const version = client.serverInfo?.productVersion ?? client.productVersion ?? client.serverVersion;
				const v = typeof version === 'object' && version ? version.value ?? version.build : version;
				return `${config.tableau.server} site "${config.tableau.site || 'Default'}", REST ${client.apiVersion}${v ? `, server ${v}` : ''}`;
			})
		);
		checks.push(
			await check('vizql data service', async () => {
				if (!tableauClient) return { skipped: 'Tableau is not configured or not reachable' };
				return checkVdsAccess(tableauClient, { datasource: args.values.datasource });
			})
		);
	} finally {
		if (tableauClient) await tableauClient.signOut().catch(() => {});
	}

	let domoClient = null;
	checks.push(
		await check('domo', async () => {
			try {
				requireDomo(config);
			} catch (err) {
				return { skipped: err.message };
			}
			const { createDomoClient } = await import('../../domo/client.js');
			const { whoAmI } = await import('../../domo/probe.js');
			domoClient = createDomoClient({ instance: config.domo.instance, accessToken: config.domo.accessToken }, { emitter: emitter.child('domo') });
			const me = await whoAmI(domoClient);
			const who = me?.displayName ?? me?.name ?? me?.emailAddress ?? me?.id ?? 'token ok';
			return `${config.domo.instance}.domo.com as ${who}`;
		})
	);

	checks.push(
		await check('app studio', async () => {
			if (!domoClient) return { skipped: 'Domo is not configured or not reachable' };
			const { appStudioStatus } = await import('../../domo/probe.js');
			const status = await appStudioStatus(domoClient);
			const flags = Object.entries(status.flags)
				.filter(([name]) => name !== 'data-app')
				.map(([name, value]) => `${name} ${value}`)
				.join(', ');
			if (!status.available) throw new Error(`data-app is ${status.flags['data-app']}: push of an App Studio plan fails; convert with --target pages (${flags})`);
			return `data-app on (convert --target app works); ${flags}`;
		})
	);

	let integrations = [];
	checks.push(
		await check('cloud amplifier', async () => {
			if (!domoClient) return { skipped: 'Domo is not configured or not reachable' };
			const { listIntegrations, resolveSnowflakeAccounts } = await import('../../domo/cloud-amplifier.js');
			integrations = await listIntegrations(domoClient);
			if (!integrations.length) return 'no integrations (the cloud-amplifier data strategy will not apply)';
			const byEngine = {};
			for (const i of integrations) byEngine[i.engine] = (byEngine[i.engine] || 0) + 1;
			const accounts = [...(await resolveSnowflakeAccounts(domoClient, integrations)).values()];
			const resolved = accounts.length ? `; Snowflake account resolved for ${accounts.filter((a) => a.account).length} of ${accounts.length}` : '';
			return `${integrations.length} integration(s): ${Object.entries(byEngine)
				.sort()
				.map(([e, n]) => `${e} ${n}`)
				.join(', ')}${resolved} (t2d list integrations)`;
		})
	);

	checks.push(
		await check('hyper', async () => {
			const { detectPython } = await import('../../tableau/data/hyper.js');
			const result = await detectPython({ python: config.python, explicit: config.pythonExplicit });
			if (!result?.ok) throw new Error(`${result.python}: ${result?.error ?? 'tableauhyperapi not available'} (needed only for the hyper and published-extract data strategies)`);
			return `${result.python}${result.detected ? ' (auto-detected)' : ''}, tableauhyperapi ${result.version ?? ''}`.trim();
		})
	);

	if (args.values.dataset) {
		checks.push(
			await check('capabilities', async () => {
				if (!domoClient) throw new Error('Domo is not configured or not reachable');
				const { probeCapabilities } = await import('../../domo/probe.js');
				const caps = await probeCapabilities(domoClient, { datasetId: args.values.dataset });
				return Object.entries(caps ?? {})
					.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
					.join(', ');
			})
		);
	}

	reporter.print(formatTable(['Check', 'Status', 'Detail'], checks.map((c) => [c.name, c.status, c.detail])));
	const failedChecks = checks.filter((c) => c.status === 'failed' && !NON_FATAL.has(c.name));
	const ok = failedChecks.length === 0;
	if (!ok) reporter.print(`\n${failedChecks.length} check(s) failed.`);
	return { ok, checks, integrations };
}
