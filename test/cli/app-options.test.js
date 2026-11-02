import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError, convertOptionsFrom } from '../../src/cli/shared.js';
import { main } from '../../src/cli/main.js';
import { tempDir, testConfig } from '../pipeline/helpers.js';

test('--target, --theme, --nav and --no-persist-filters parse into convert options', () => {
	assert.deepEqual(convertOptionsFrom({}), {});
	assert.deepEqual(convertOptionsFrom({ target: 'pages' }), { target: 'pages' });
	assert.deepEqual(convertOptionsFrom({ target: 'app', theme: 'midnight', nav: 'left', 'no-persist-filters': true }), { target: 'app', theme: 'Midnight', navOrientation: 'LEFT', persistFilters: false });
	assert.throws(() => convertOptionsFrom({ target: 'dashboard' }), UsageError);
	assert.throws(() => convertOptionsFrom({ theme: 'Neon' }), /built-in App Studio theme/);
	assert.throws(() => convertOptionsFrom({ nav: 'bottom' }), /--nav must be top or left/);
	assert.throws(() => convertOptionsFrom({ target: 'pages', theme: 'Midnight' }), /--theme applies to --target app only/);
});

test('--workbook-theme and --no-workbook-theme set workbookTheme; together, or with --target pages, they are refused', () => {
	assert.deepEqual(convertOptionsFrom({ 'workbook-theme': true }), { workbookTheme: true });
	assert.deepEqual(convertOptionsFrom({ 'no-workbook-theme': true }), { workbookTheme: false });
	assert.throws(() => convertOptionsFrom({ 'workbook-theme': true, 'no-workbook-theme': true }), /cannot be combined/);
	assert.throws(() => convertOptionsFrom({ target: 'pages', 'no-workbook-theme': true }), /--no-workbook-theme applies to --target app only/);
});

test('migrate rejects --parent-page unless --target pages', async () => {
	const out = [];
	const io = { stdout: { write: () => {}, isTTY: false }, stderr: { write: (s) => out.push(s), isTTY: false }, stdin: { isTTY: false }, env: { NO_COLOR: '1' } };
	const code = await main(['migrate', '--file', 'x.twbx', '--parent-page', '12', '--dry-run'], { ...io, loadConfig: () => testConfig(tempDir()) });
	assert.equal(code, 2);
	assert.match(out.join(''), /--parent-page needs --target pages/);
});
