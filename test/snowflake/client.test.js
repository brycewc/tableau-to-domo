import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createSnowflakeClient, jwtAccount, keyPairJwt, snowflakeHost } from '../../src/snowflake/client.js';

const decode = (part) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('key-pair JWT names the account, user and public key fingerprint and verifies with the public key', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
	const jwt = keyPairJwt({ account: 'gib51418.us-east-1', user: 't2d_svc', privateKeyPem: pem, now: 1_700_000_000_000 });
	const [h, p, s] = jwt.split('.');
	const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
	assert.deepEqual(decode(p), { iss: `GIB51418.T2D_SVC.SHA256:${fingerprint}`, sub: 'GIB51418.T2D_SVC', iat: 1_700_000_000, exp: 1_700_003_540 });
	assert.equal(decode(h).alg, 'RS256');
	assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
	assert.equal(jwtAccount('myorg-myacct'), 'MYORG-MYACCT');
	assert.equal(snowflakeHost('gib51418.us-east-1'), 'gib51418.us-east-1.snowflakecomputing.com');
});

test('execute sends one statement with a PAT and polls an async result', async () => {
	const calls = [];
	const replies = [{ code: '333334', statementStatusUrl: '/api/v2/statements/abc' }, { code: '333334' }, { code: '090001', data: [['ok']], resultSetMetaData: { rowType: [{ name: 'STATUS' }] } }];
	const fetchImpl = async (url, opts) => (calls.push({ url, ...opts }), replies.shift());
	const c = createSnowflakeClient({ account: 'gib51418.us-east-1', user: 'u', role: 'R', warehouse: 'WH', pat: 'secret' }, { fetchImpl });
	const out = await c.execute('CREATE OR REPLACE VIEW X AS SELECT 1', { timeoutSeconds: 30 });
	assert.deepEqual(out, { rows: [['ok']], columns: ['STATUS'] });
	assert.equal(calls[0].url, 'https://gib51418.us-east-1.snowflakecomputing.com/api/v2/statements');
	assert.deepEqual(calls[0].json, { statement: 'CREATE OR REPLACE VIEW X AS SELECT 1', timeout: 30, warehouse: 'WH', role: 'R' });
	assert.equal(calls[0].headers.Authorization, 'Bearer secret');
	assert.equal(calls[0].headers['X-Snowflake-Authorization-Token-Type'], 'PROGRAMMATIC_ACCESS_TOKEN');
	assert.equal(calls[0].idempotent, false);
	assert.equal(calls[1].url, 'https://gib51418.us-east-1.snowflakecomputing.com/api/v2/statements/abc');
});

test('a key path is read for the JWT and settings without credentials are refused', () => {
	assert.throws(() => createSnowflakeClient({ account: 'a', user: 'u' }), /SNOWFLAKE_PAT or SNOWFLAKE_PRIVATE_KEY_PATH/);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-sf-'));
	const file = path.join(dir, 'key.p8');
	fs.writeFileSync(file, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
	assert.doesNotThrow(() => createSnowflakeClient({ account: 'a', user: 'u', privateKeyPath: file }));
	fs.rmSync(dir, { recursive: true, force: true });
});
