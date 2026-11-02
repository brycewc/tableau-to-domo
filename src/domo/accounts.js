/**
 * Connector providers on the instance (`GET /data/v1/providers`), optionally filtered by a
 * case-insensitive substring of the key or name.
 * @param {import('./client.js').DomoClient} c
 * @param {{ name?: string }} [opts]
 * @returns {Promise<{ key: string, name: string, defaultConnectorId?: string }[]>}
 */
export async function listProviders(c, { name } = {}) {
	const providers = await c.get('/data/v1/providers');
	const wanted = String(name ?? '').toLowerCase();
	return (Array.isArray(providers) ? providers : [])
		.filter((p) => p?.key && (!wanted || p.key.toLowerCase().includes(wanted) || String(p.name ?? '').toLowerCase().includes(wanted)))
		.map((p) => ({ key: p.key, name: p.name ?? p.key, ...(p.defaultConnectorId ? { defaultConnectorId: p.defaultConnectorId } : {}) }));
}

// Every field not listed may hold a credential.
export const ACCOUNT_SETTING_FIELDS = ['host', 'hostname', 'server', 'server-name', 'instance-name', 'port', 'database', 'databaseName', 'warehouse', 'account', 'role', 'username'];
const CREDENTIAL_NAME = /pass|secret|token|private|key|credential|pwd/i;

/** @param {any} raw  GET /data/v1/providers/{provider}/account/{id}; masked values are dropped */
export function safeAccountSettings(raw) {
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const field of ACCOUNT_SETTING_FIELDS) {
		if (CREDENTIAL_NAME.test(field)) continue;
		const value = raw[field];
		if ((typeof value !== 'string' && typeof value !== 'number') || /^\*+$/.test(String(value).trim()) || !String(value).trim()) continue;
		out[field] = String(value).trim();
	}
	return out;
}

/**
 * Provider and allowlisted settings of one account, read without `unmask`.
 * @returns {Promise<{ id: number|string, name?: string, providerKey?: string, valid?: boolean, settings: Record<string, string> }>}
 */
export async function getAccountSettings(c, id, { providerKey } = {}) {
	let meta = null;
	if (!providerKey) {
		meta = await c.get(`/data/v1/accounts/${encodeURIComponent(id)}`);
		providerKey = typeof meta?.dataProviderType === 'string' ? meta.dataProviderType : undefined;
	}
	const settings = providerKey ? safeAccountSettings(await c.get(`/data/v1/providers/${encodeURIComponent(providerKey)}/account/${encodeURIComponent(id)}`)) : {};
	return {
		id: meta?.id ?? id,
		...(meta?.displayName || meta?.name ? { name: meta.displayName ?? meta.name } : {}),
		...(providerKey ? { providerKey } : {}),
		...(meta?.valid !== undefined ? { valid: Boolean(meta.valid) } : {}),
		settings
	};
}

/** Every account of a provider; search also finds accounts not shared with the token user. */
export async function searchAccounts(c, provider) {
	try {
		const out = [];
		for (let offset = 0; offset < 1000; offset += 100) {
			const page = await c.post('/search/v1/query', {
				query: '*',
				count: 100,
				offset,
				entityList: [['account']],
				filters: [{ field: 'dataproviderkey_facet', filterType: 'term', value: provider }]
			});
			const hits = Array.isArray(page?.searchObjects) ? page.searchObjects : [];
			for (const h of hits) {
				out.push({ id: /^\d+$/.test(String(h.databaseId)) ? Number(h.databaseId) : h.databaseId, name: h.displayName ?? h.name ?? '', providerKey: provider, ...(h.valid !== undefined ? { valid: Boolean(h.valid) } : {}) });
			}
			if (hits.length < 100 || out.length >= (page?.totalResultCount ?? 0)) break;
		}
		if (out.length) return out;
	} catch {
		// Search may be unavailable to the token; the plain list still shows the accounts shared with it.
	}
	return listAccounts(c, { provider });
}

const DEFAULT_PORTS = { sqlserver: '1433', azure_sql_db: '1433', postgres: '5432', mysql: '3306', redshift: '5439', oracle: '1521' };

/** Host without protocol, port, SQL Server instance or trailing dot, lower case. */
export function normalizeHost(value) {
	let host = String(value ?? '').trim().toLowerCase();
	host = host.replace(/^(?:tcp|np|lpc|https?|jdbc:[a-z]+):(?:\/\/)?/, '').replace(/\/.*$/, '');
	host = host.replace(/\\.*$/, '').replace(/,\s*\d+$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
	return host;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** @returns {'exact'|'short'|false}  'short' when one side is a short name (`dw`) and the other an FQDN starting with it */
export function compareHosts(a, b) {
	const x = normalizeHost(a);
	const y = normalizeHost(b);
	if (!x || !y) return false;
	if (x === y) return 'exact';
	if (IPV4.test(x) || IPV4.test(y)) return false;
	const [short, long] = x.includes('.') ? [y, x] : [x, y];
	if (short.includes('.') || !long.includes('.')) return false;
	return long.split('.')[0] === short ? 'short' : false;
}

/**
 * Accounts on the connection's host (or Snowflake account); a confident one has no differing port or database.
 * @returns {{ status: 'match'|'candidates'|'none', matches: object[], others: object[] }}
 */
export function matchAccounts(connection, accounts, { family, compareSnowflake } = {}) {
	const matches = [];
	const others = [];
	const wantDb = String(connection?.dbname ?? '').trim().toLowerCase();
	const defaultPort = DEFAULT_PORTS[family];
	const wantPort = String(connection?.port ?? defaultPort ?? '');
	for (const account of accounts) {
		const s = account.settings ?? {};
		const host = s.host ?? s.hostname ?? s.server ?? s['server-name'];
		const database = s.database ?? s.databaseName;
		const candidate = {
			id: account.id,
			...(account.name ? { name: account.name } : {}),
			...(account.providerKey ? { providerKey: account.providerKey } : {}),
			...(host ? { host } : {}),
			...(s.port ? { port: s.port } : {}),
			...(database ? { database } : {}),
			...(s.account ? { account: s.account } : {}),
			...(s.warehouse ? { warehouse: s.warehouse } : {}),
			...(s.username ? { username: s.username } : {}),
			confident: false,
			notes: []
		};
		let hostMatch = host ? compareHosts(host, connection?.server) : false;
		if (!hostMatch && s.account && compareSnowflake) hostMatch = compareSnowflake(s.account, connection?.server) === 'equal' ? 'account' : false;
		if (!hostMatch) {
			others.push(candidate);
			continue;
		}
		candidate.hostMatch = hostMatch;
		if (hostMatch === 'short') candidate.notes.push(`host ${host} vs ${connection.server}: short name`);
		const port = s.port ? String(s.port) : defaultPort;
		const portDiffers = Boolean(wantPort && port && wantPort !== port);
		if (portDiffers) candidate.notes.push(`port ${port} differs from ${wantPort}`);
		const dbDiffers = Boolean(wantDb && database && database.toLowerCase() !== wantDb);
		if (dbDiffers) candidate.notes.push(`database ${database} differs from ${connection.dbname}`);
		candidate.confident = !portDiffers && !dbDiffers;
		matches.push(candidate);
	}
	matches.sort((a, b) => Number(b.confident) - Number(a.confident));
	const confident = matches.filter((m) => m.confident);
	return { status: confident.length === 1 ? 'match' : matches.length ? 'candidates' : 'none', matches, others };
}

/**
 * Connector accounts the token user can see. Credentials and configurations are never returned.
 * @param {import('./client.js').DomoClient} c
 * @param {{ provider?: string }} [opts]  Provider key (`GET /data/v1/accounts/provider/{key}`)
 * @returns {Promise<{ id: number, name: string, providerKey: string, valid?: boolean }[]>}
 */
export async function listAccounts(c, { provider } = {}) {
	const path = provider ? `/data/v1/accounts/provider/${encodeURIComponent(provider)}` : '/data/v1/accounts';
	const accounts = await c.get(path);
	return (Array.isArray(accounts) ? accounts : []).map((a) => ({
		id: a.id ?? a.accountId,
		name: a.displayName ?? a.name ?? '',
		providerKey: a.dataProviderType ?? provider ?? '',
		...(a.valid !== undefined ? { valid: Boolean(a.valid) } : {})
	}));
}
