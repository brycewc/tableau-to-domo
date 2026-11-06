import fs from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { poll, request } from '../util/http.js';

/**
 * Snowflake SQL API (POST /api/v2/statements) client, authenticated with a programmatic access token or a key-pair
 * JWT. One statement per call.
 *
 * @typedef {{ account: string, user: string, role?: string, warehouse?: string, pat?: string, privateKeyPath?: string, privateKeyPassphrase?: string }} SnowflakeSettings
 * @typedef {{ execute: (sql: string, opts?: { database?: string, schema?: string, timeoutSeconds?: number }) => Promise<{ rows: any[][], columns: string[] }>, account: string }} SnowflakeClient
 */

const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The account part of a JWT issuer: the locator or org-account name before any region suffix, upper case. */
export function jwtAccount(account) {
	return String(account).replace(/\.snowflakecomputing\.com$/i, '').split('.')[0].toUpperCase();
}

/** Key-pair JWT for the SQL API: iss is ACCOUNT.USER.SHA256:<public key fingerprint>. */
export function keyPairJwt({ account, user, privateKeyPem, passphrase, now = Date.now() }) {
	const key = createPrivateKey({ key: privateKeyPem, format: 'pem', ...(passphrase ? { passphrase } : {}) });
	const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
	const fingerprint = createHash('sha256').update(der).digest('base64');
	const qualified = `${jwtAccount(account)}.${String(user).toUpperCase()}`;
	const iat = Math.floor(now / 1000);
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(JSON.stringify({ iss: `${qualified}.SHA256:${fingerprint}`, sub: qualified, iat, exp: iat + 3540 }));
	const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key));
	return `${header}.${payload}.${signature}`;
}

export function snowflakeHost(account) {
	const a = String(account).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	return /\.snowflakecomputing\.com$/i.test(a) ? a : `${a}.snowflakecomputing.com`;
}

/**
 * @param {SnowflakeSettings} settings
 * @param {{ fetchImpl?: typeof request, now?: () => number }} [deps]
 * @returns {SnowflakeClient}
 */
export function createSnowflakeClient(settings, { fetchImpl = request, now = Date.now } = {}) {
	const { account, user, role, warehouse, pat, privateKeyPath, privateKeyPassphrase } = settings;
	if (!account || !user) throw new Error('Snowflake settings need SNOWFLAKE_ACCOUNT and SNOWFLAKE_USER');
	if (!pat && !privateKeyPath) throw new Error('Snowflake settings need SNOWFLAKE_PAT or SNOWFLAKE_PRIVATE_KEY_PATH');
	const url = `https://${snowflakeHost(account)}/api/v2/statements`;
	let jwt;
	const authHeaders = () => {
		if (pat) return { Authorization: `Bearer ${pat}`, 'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN' };
		if (!jwt || jwt.expires < now() + 60000) {
			const token = keyPairJwt({ account, user, privateKeyPem: fs.readFileSync(privateKeyPath, 'utf8'), passphrase: privateKeyPassphrase, now: now() });
			jwt = { token, expires: now() + 3540 * 1000 };
		}
		return { Authorization: `Bearer ${jwt.token}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' };
	};
	const call = (method, target, json) =>
		fetchImpl(target, { method, json, headers: { ...authHeaders(), Accept: 'application/json', 'User-Agent': 't2d' }, idempotent: method === 'GET', timeoutMs: 300000 });

	return {
		account,
		async execute(sql, { database, schema, timeoutSeconds = 600 } = {}) {
			let res = await call('POST', url, { statement: sql, timeout: timeoutSeconds, ...(warehouse ? { warehouse } : {}), ...(role ? { role } : {}), ...(database ? { database } : {}), ...(schema ? { schema } : {}) });
			if (res?.statementStatusUrl && !res.data && res.code === '333334') {
				const status = `https://${snowflakeHost(account)}${res.statementStatusUrl}`;
				res = await poll(
					async () => {
						const r = await call('GET', status);
						return r?.code === '333334' ? undefined : r;
					},
					{ intervalMs: 2000, timeoutMs: timeoutSeconds * 1000, label: 'Snowflake statement' }
				);
			}
			return { rows: res?.data ?? [], columns: (res?.resultSetMetaData?.rowType ?? []).map((c) => c.name) };
		}
	};
}
