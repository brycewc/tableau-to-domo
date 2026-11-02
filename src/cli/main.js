import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { DataDecisionError, formatDecisions } from '../pipeline/decisions.js';
import { createEmitter } from '../util/events.js';
import * as convert from './commands/convert.js';
import * as doctor from './commands/doctor.js';
import * as extract from './commands/extract.js';
import * as list from './commands/list.js';
import * as mappings from './commands/mappings.js';
import * as migrate from './commands/migrate.js';
import * as push from './commands/push.js';
import * as report from './commands/report.js';
import * as show from './commands/show.js';
import * as status from './commands/status.js';
import * as unpush from './commands/unpush.js';
import * as verify from './commands/verify.js';
import { createReporter } from './reporter.js';
import { GLOBAL_OPTIONS, UsageError } from './shared.js';

/**
 * @typedef {Object} CommandContext
 * @property {import('../config.js').T2DConfig} config
 * @property {{ values: Record<string, any>, positionals: string[] }} args
 * @property {import('../util/events.js').Emitter} emitter
 * @property {import('./reporter.js').Reporter} reporter
 * @property {{ stdin?: any, stdout?: any, stderr?: any, env?: Record<string, string|undefined>, cwd?: string }} io
 */

export const COMMANDS = [doctor, list, extract, show, convert, push, unpush, migrate, report, status, verify, mappings];
const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

export const EXIT = { ok: 0, failure: 1, usage: 2, decision: 3 };

export function version() {
	try {
		return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
	} catch {
		return '0.0.0';
	}
}

function parseConfigFor(options) {
	const out = {};
	for (const [key, spec] of Object.entries(options)) {
		out[key] = { type: spec.type };
		if (spec.short) out[key].short = spec.short;
		if (spec.multiple) out[key].multiple = true;
	}
	return out;
}

function formatOptions(options) {
	const rows = Object.entries(options).map(([key, spec]) => {
		const flag = `${spec.short ? `-${spec.short}, ` : '    '}--${key}${spec.value ? ` ${spec.value}` : ''}`;
		return [flag, spec.description ?? ''];
	});
	const width = Math.max(0, ...rows.map((r) => r[0].length));
	return rows.map(([flag, desc]) => `  ${flag.padEnd(width)}  ${desc}`).join('\n');
}

/** Top-level help text. */
export function globalHelp() {
	const width = Math.max(...COMMANDS.map((c) => c.name.length));
	return [
		`t2d ${version()}: migrate Tableau workbooks to Domo`,
		'',
		'Usage: t2d <command> [options]',
		'',
		'Commands:',
		...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
		'',
		'Global options:',
		formatOptions(GLOBAL_OPTIONS),
		'',
		'Run "t2d <command> --help" for command options.',
		'Exit codes: 0 ok, 1 failure, 2 usage error.'
	].join('\n');
}

/** Help text for one command. */
export function commandHelp(command) {
	return [`t2d ${command.name}: ${command.summary}`, '', `Usage: ${command.usage}`, '', 'Options:', formatOptions(command.options ?? {}), '', 'Global options:', formatOptions(GLOBAL_OPTIONS)].join(
		'\n'
	);
}

/** Index of the command word, skipping values of global string options. */
function findCommandIndex(argv) {
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === '--') return -1;
		if (!token.startsWith('-')) return i;
		const flag = token.replace(/^-+/, '');
		if (!flag.includes('=') && GLOBAL_OPTIONS[flag]?.type === 'string') i++;
	}
	return -1;
}

/**
 * Parse arguments for a command (globals included). Throws UsageError.
 * @param {string[]} argv  argv without the command word
 * @param {Record<string, any>} options
 */
export function parseCommandArgs(argv, options) {
	const merged = { ...GLOBAL_OPTIONS, ...options };
	try {
		const { values, positionals } = parseArgs({ args: argv, options: parseConfigFor(merged), allowPositionals: true, strict: true });
		return { values, positionals };
	} catch (err) {
		throw new UsageError(err.message.replace(/\. To specify a positional argument.*$/s, ''));
	}
}

/**
 * CLI entry point. Never exits the process; returns the exit code.
 * @param {string[]} argv
 * @param {{ stdin?: any, stdout?: any, stderr?: any, env?: Record<string, string|undefined>, cwd?: string }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
	const stdout = io.stdout ?? process.stdout;
	const stderr = io.stderr ?? process.stderr;
	const env = io.env ?? process.env;
	const write = (stream, text) => stream.write(`${text}\n`);

	const index = findCommandIndex(argv);
	const commandName = index >= 0 ? argv[index] : null;
	const rest = index >= 0 ? [...argv.slice(0, index), ...argv.slice(index + 1)] : argv;
	const command = commandName ? BY_NAME.get(commandName) : null;

	let args;
	try {
		if (commandName && !command) throw new UsageError(`Unknown command "${commandName}". Commands: ${COMMANDS.map((c) => c.name).join(', ')}`);
		args = parseCommandArgs(rest, command?.options ?? {});
	} catch (err) {
		const json = argv.includes('--json');
		if (json) write(stdout, JSON.stringify({ type: 'result', command: commandName, ok: false, exitCode: EXIT.usage, error: { name: 'UsageError', message: err.message } }));
		else write(stderr, `error: ${err.message}\n\n${command ? `Usage: ${command.usage}` : 'Run "t2d --help" for usage.'}`);
		return EXIT.usage;
	}

	if (args.values.version) {
		write(stdout, version());
		return EXIT.ok;
	}
	if (!command) {
		if (args.values.help) {
			write(stdout, globalHelp());
			return EXIT.ok;
		}
		write(stderr, globalHelp());
		return EXIT.usage;
	}
	if (args.values.help) {
		write(stdout, commandHelp(command));
		return EXIT.ok;
	}

	const reporter = createReporter({ json: args.values.json, quiet: args.values.quiet, verbose: args.values.verbose, stdout, stderr, env });
	try {
		const config = (io.loadConfig ?? loadConfig)({ env: args.values.env ?? null, cwd: io.cwd ?? process.cwd(), overrides: args.values.workspace ? { workspace: args.values.workspace } : {} });
		const ctx = { config, args, emitter: createEmitter(reporter.sink, command.name), reporter, io: { ...io, stdin: io.stdin ?? process.stdin, stdout, stderr, env } };
		const result = await command.run(ctx);
		const ok = result?.ok !== false;
		reporter.result(command.name, ok, result);
		return ok ? EXIT.ok : EXIT.failure;
	} catch (err) {
		if (err instanceof DataDecisionError) {
			if (reporter.json) {
				write(stdout, JSON.stringify({ type: 'result', command: command.name, ok: false, exitCode: EXIT.decision, error: { name: err.name, code: err.code, message: err.message }, decisions: err.decisions }));
			} else {
				write(stderr, formatDecisions(err.decisions));
				write(stderr, `\nerror: ${err.message}`);
			}
			return EXIT.decision;
		}
		const code = err instanceof UsageError || err?.name === 'SelectionError' ? EXIT.usage : EXIT.failure;
		reporter.error(command.name, err, code);
		if (code === EXIT.usage && !reporter.json) write(stderr, `\nUsage: ${command.usage}`);
		else if (err instanceof ConfigError && !reporter.json) write(stderr, 'Check your .env (see .env.example) or pass --env <name>.');
		return code;
	}
}
