import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { commandHelp, COMMANDS, globalHelp, main, parseCommandArgs } from '../../src/cli/main.js';
import { createReporter, formatTable, useColor } from '../../src/cli/reporter.js';
import { convertOptionsFrom, extractOptionsFrom, UsageError } from '../../src/cli/shared.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { samplePlan, tempDir, testConfig } from '../pipeline/helpers.js';

const BIN = fileURLToPath(new URL('../../bin/t2d.js', import.meta.url));

function capture({ tty = false } = {}) {
	const out = [];
	const err = [];
	return {
		io: {
			stdout: { write: (s) => out.push(s), isTTY: false },
			stderr: { write: (s) => err.push(s), isTTY: false },
			stdin: { isTTY: tty },
			env: { NO_COLOR: '1' }
		},
		out: () => out.join(''),
		err: () => err.join('')
	};
}

let realFetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		throw new Error(`unexpected network call ${url}`);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

async function workspaceWithPlan() {
	const root = tempDir();
	const ws = openWorkspace(root);
	const p = ws.paths('sales');
	fs.mkdirSync(path.join(p.dir, 'data', 'orders'), { recursive: true });
	fs.writeFileSync(path.join(p.dir, 'data', 'orders', 'orders.csv'), 'Region,Sales\nEast,1\n');
	await ws.writeJson(p.plan, samplePlan());
	await ws.writeJson(p.metadata, { workbook: { name: 'Sales' } });
	return { root, ws, p };
}

test('global help lists every command and exits 0', async () => {
	const c = capture();
	assert.equal(await main(['--help'], c.io), 0);
	for (const cmd of COMMANDS) assert.ok(c.out().includes(cmd.name), cmd.name);
	assert.match(c.out(), /Exit codes: 0 ok, 1 failure, 2 usage error/);
	assert.ok(!/[\u2013\u2014]/.test(globalHelp()));
});

test('no command prints help to stderr with exit 2', async () => {
	const c = capture();
	assert.equal(await main([], c.io), 2);
	assert.match(c.err(), /Usage: t2d <command>/);
});

test('command help shows usage and options', async () => {
	const c = capture();
	assert.equal(await main(['push', '-h'], c.io), 0);
	assert.match(c.out(), /Usage: t2d push --workbook <slug>/);
	assert.match(c.out(), /--dry-run/);
	assert.match(c.out(), /--yes/);
	for (const cmd of COMMANDS) {
		assert.equal(typeof cmd.run, 'function');
		assert.ok(cmd.summary && cmd.usage && cmd.options, cmd.name);
		assert.ok(!/[\u2013\u2014]/.test(commandHelp(cmd)), cmd.name);
	}
});

test('--version prints the package version', async () => {
	const c = capture();
	assert.equal(await main(['--version'], c.io), 0);
	assert.match(c.out(), /^\d+\.\d+\.\d+\n$/);
});

test('usage errors exit 2', async () => {
	let c = capture();
	assert.equal(await main(['frobnicate'], c.io), 2);
	assert.match(c.err(), /Unknown command "frobnicate"/);
	c = capture();
	assert.equal(await main(['push', '--nope'], c.io), 2);
	assert.match(c.err(), /Unknown option '--nope'/);
	c = capture();
	assert.equal(await main(['extract'], { ...c.io, loadConfig: () => testConfig(tempDir()) }), 2);
	assert.match(c.err(), /--workbook <name\|luid> or --file/);
	c = capture();
	assert.equal(await main(['--json', 'list'], { ...c.io, loadConfig: () => testConfig(tempDir()) }), 2);
	const last = JSON.parse(c.out().trim().split('\n').at(-1));
	assert.equal(last.ok, false);
	assert.equal(last.exitCode, 2);
});

test('global options are accepted before and after the command', () => {
	const { values, positionals } = parseCommandArgs(['--workspace', '/w', 'views', '--json', '-w', 'Sales'], { workbook: { type: 'string', short: 'w' } });
	assert.equal(values.workspace, '/w');
	assert.equal(values.json, true);
	assert.equal(values.workbook, 'Sales');
	assert.deepEqual(positionals, ['views']);
	assert.throws(() => parseCommandArgs(['--bogus'], {}), UsageError);
});

test('convert and extract option mapping', () => {
	assert.deepEqual(convertOptionsFrom({ 'no-fixed': true, 'window-functions': true, parameters: 'variables', joins: 'view', 'no-filter-cards': true, prefix: 'TB ', 'page-title': 'X' }), {
		useFixed: false,
		useWindowFunctions: true,
		parameters: 'variables',
		joins: 'view',
		createFilterCards: false,
		namePrefix: 'TB ',
		pageTitle: 'X'
	});
	assert.throws(() => convertOptionsFrom({ joins: 'zip' }), UsageError);
	assert.throws(() => convertOptionsFrom({ 'use-fixed': true, 'no-fixed': true }), UsageError);
	assert.deepEqual(convertOptionsFrom({ 'no-window-functions': true, 'no-materialize': true }), { useWindowFunctions: false, materialize: false });
	assert.throws(() => convertOptionsFrom({ 'window-functions': true, 'no-window-functions': true }), UsageError);
	assert.deepEqual(convertOptionsFrom({ 'domo-nav': true }), { domoNav: true });
	assert.deepEqual(convertOptionsFrom({ 'no-domo-nav': true }), { domoNav: false });
	assert.deepEqual(convertOptionsFrom({ 'no-tableau-links': true }), { tableauLinks: false }, 'on unless --no-tableau-links');
	assert.throws(() => convertOptionsFrom({ 'domo-nav': true, 'no-domo-nav': true }), /cannot be combined/);
	assert.throws(() => convertOptionsFrom({ 'domo-nav': true, target: 'pages' }), /--domo-nav applies to --target app only/);
	assert.throws(() => convertOptionsFrom({ 'no-domo-nav': true, target: 'pages' }), /--no-domo-nav applies to --target app only/);
	assert.deepEqual(extractOptionsFrom({ file: 'a.twbx', 'no-extract-data': true }), {
		unmapped: 'ask',
		workbook: undefined,
		file: 'a.twbx',
		project: undefined,
		dataStrategy: 'auto',
		includeExtract: false,
		metadata: true,
		publishedFields: true,
		domoLookup: true,
		refreshShared: false
	});
	assert.equal(extractOptionsFrom({ file: 'a.twbx', 'no-published-fields': true }).publishedFields, false);
	assert.throws(() => extractOptionsFrom({ workbook: 'a', 'data-strategy': 'csv' }), UsageError);
	assert.equal(extractOptionsFrom({ workbook: 'a', unmapped: 'export' }).unmapped, 'export');
	assert.throws(() => extractOptionsFrom({ workbook: 'a', unmapped: 'maybe' }), /--unmapped must be one of ask, export, fail/);
});

test('push refuses a non-TTY session without --yes (exit 2)', async () => {
	const { root } = await workspaceWithPlan();
	const c = capture({ tty: false });
	assert.equal(await main(['push', '--workbook', 'sales'], { ...c.io, loadConfig: () => testConfig(root) }), 2);
	assert.match(c.err(), /non-interactive/);
});

test('push --json in a TTY needs --yes, and --parent-page must be numeric (exit 2)', async () => {
	const { root } = await workspaceWithPlan();
	const c = capture({ tty: true });
	assert.equal(await main(['--json', 'push', '--workbook', 'sales'], { ...c.io, loadConfig: () => testConfig(root) }), 2);
	const d = capture({ tty: true });
	assert.equal(await main(['push', '--workbook', 'sales', '--dry-run', '--parent-page', 'abc'], { ...d.io, loadConfig: () => testConfig(root) }), 2);
	assert.match(d.err(), /--parent-page must be a numeric/);
});

test('push --dry-run --json emits NDJSON events and a final result line', async () => {
	const { root, p } = await workspaceWithPlan();
	const c = capture();
	assert.equal(await main(['--json', 'push', '-w', 'Sales', '--dry-run'], { ...c.io, loadConfig: () => testConfig(root) }), 0);
	const lines = c.out().trim().split('\n').map((l) => JSON.parse(l));
	assert.ok(lines.length > 2);
	assert.ok(lines.slice(0, -1).every((l) => l.type && l.stage && typeof l.message === 'string'));
	const result = lines.at(-1);
	assert.equal(result.type, 'result');
	assert.equal(result.command, 'push');
	assert.equal(result.ok, true);
	assert.equal(result.result.dryRun, true);
	assert.equal(result.result.counts.create, 8);
	assert.equal(c.err(), '');
	assert.ok(fs.existsSync(p.pushDryRun));
});

test('push --dry-run text output is a table and nothing goes to the network', async () => {
	const { root } = await workspaceWithPlan();
	const c = capture();
	assert.equal(await main(['push', '--workbook', 'sales', '--dry-run'], { ...c.io, loadConfig: () => testConfig(root) }), 0);
	assert.match(c.out(), /Kind\s+Name\s+Action/);
	assert.match(c.out(), /Dry run against acme: 8 create/);
});

test('failures exit 1', async () => {
	const root = tempDir();
	const c = capture();
	assert.equal(await main(['convert', '--workbook', 'missing'], { ...c.io, loadConfig: () => testConfig(root) }), 1);
	assert.match(c.err(), /No extracted workbook "missing"/);
	const d = capture();
	assert.equal(await main(['push', '--workbook', 'sales', '--yes'], { ...d.io, loadConfig: () => ({ ...testConfig(root), domo: { instance: '', accessToken: '' } }) }), 1);
});

test('status, mappings and report commands work offline', async () => {
	const { root, ws } = await workspaceWithPlan();
	await ws.writeJson(ws.stateFile('acme'), { instance: 'acme', objects: { 'dataset:orders': { id: 'ds', updatedAt: 'x' } } });
	const config = testConfig(root);
	let c = capture();
	assert.equal(await main(['status', '-w', 'sales'], { ...c.io, loadConfig: () => config }), 0);
	assert.match(c.out(), /Instance acme/);
	assert.match(c.out(), /dataset\s+1\s+1\s+0/);
	c = capture();
	assert.equal(await main(['mappings', '--init'], { ...c.io, loadConfig: () => config }), 0);
	assert.ok(fs.existsSync(ws.mappingsFile));
	assert.match(c.out(), /accountId/);
	c = capture();
	assert.equal(await main(['report', '-w', 'sales'], { ...c.io, loadConfig: () => config }), 0);
	assert.match(c.out(), /# Migration report/);
	c = capture();
	assert.equal(await main(['--json', 'list', 'local'], { ...c.io, loadConfig: () => config }), 0);
	assert.equal(JSON.parse(c.out().trim().split('\n').at(-1)).result.items[0].slug, 'sales');
});

test('reporter text rendering, quiet and color rules', () => {
	const out = [];
	const err = [];
	const r = createReporter({ stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s), isTTY: true }, env: {} });
	r.sink({ type: 'step', stage: 'push', message: 'Datasets' });
	r.sink({ type: 'progress', stage: 'push', message: 'hidden unless verbose' });
	r.sink({ type: 'warn', stage: 'push', message: 'careful' });
	assert.equal(err.length, 2);
	assert.ok(err[1].includes('\x1b[33m'));
	const q = [];
	const quiet = createReporter({ quiet: true, stdout: { write: () => {} }, stderr: { write: (s) => q.push(s) }, env: {} });
	quiet.sink({ type: 'step', stage: 's', message: 'x' });
	quiet.sink({ type: 'error', stage: 's', message: 'bad' });
	assert.deepEqual(q, ['[s] error: bad\n']);
	assert.equal(useColor({ isTTY: true }, { NO_COLOR: '1' }), false);
	assert.equal(useColor({ isTTY: false }, {}), false);
	assert.equal(formatTable(['A', 'B'], [['x', 'yy']]), 'A  B\n-  --\nx  yy');
});

test('bin/t2d.js runs as an executable and sets the exit code', () => {
	const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
	assert.match(help, /Usage: t2d <command>/);
	const bad = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8' });
	assert.equal(bad.status, 2);
	assert.ok(fs.readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node'));
});

test('list providers and list accounts read Domo and print a mappings entry', async () => {
	const config = testConfig(tempDir());
	const seen = [];
	globalThis.fetch = async (url) => {
		const u = new URL(url);
		seen.push(`${u.pathname}`);
		const json =
			u.pathname === '/api/data/v1/providers'
				? [{ key: 'mysql', name: 'MySQL', defaultConnectorId: 'com.domo.connector.mysql' }, { key: 'snowflakekeypairauthentication', name: 'Snowflake Key Pair Authentication' }]
				: u.pathname === '/api/search/v1/query'
					? { totalResultCount: 1, searchObjects: [{ databaseId: '101', displayName: 'Acme Snowflake', valid: true }] }
					: u.pathname.startsWith('/api/data/v1/providers/')
						? { account: 'ACME-ANALYTICS', privateKey: 'SECRET-KEY', passPhrase: 'SECRET-PHRASE', username: 'SVC' }
						: [];
		return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
	};
	let c = capture();
	assert.equal(await main(['--json', 'list', 'providers', '--name', 'snow'], { ...c.io, loadConfig: () => config }), 0);
	assert.deepEqual(JSON.parse(c.out().trim().split('\n').at(-1)).result.items.map((p) => p.key), ['snowflakekeypairauthentication']);
	c = capture();
	assert.equal(await main(['list', 'accounts', '--provider', 'snowflakekeypairauthentication'], { ...c.io, loadConfig: () => config }), 0);
	assert.match(c.out(), /Acme Snowflake/);
	assert.match(c.out(), /"accountId": 101/);
	assert.match(c.out(), /"class": "snowflake"/);
	assert.match(c.out(), /Host\s+Database/);
	assert.match(c.out(), /ACME-ANALYTICS/);
	assert.doesNotMatch(c.out() + c.err(), /SECRET/);
	assert.deepEqual(seen, ['/api/data/v1/providers', '/api/search/v1/query', '/api/data/v1/providers/snowflakekeypairauthentication/account/101']);
});

test('migrate batch flags: --all with --workbook is a usage error; a batch without Tableau settings fails cleanly', async () => {
	const c = capture();
	const root = tempDir();
	assert.equal(await main(['migrate', '--all', '--workbook', 'x', '--dry-run'], { ...c.io, loadConfig: () => testConfig(root) }), 2);
	assert.match(c.err(), /cannot be combined with --workbook/);
	const d = capture();
	assert.equal(await main(['--json', 'migrate', '--project', 'Finance', '--dry-run'], { ...d.io, loadConfig: () => testConfig(root) }), 1);
	const last = JSON.parse(d.out().trim().split('\n').at(-1));
	assert.equal(last.ok, false);
	assert.equal(last.error.name, 'ConfigError');
});
