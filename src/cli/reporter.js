const ANSI = {
	reset: '\x1b[0m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m'
};

/**
 * Decide whether to color output for a stream.
 * @param {{ isTTY?: boolean }} stream
 * @param {Record<string, string|undefined>} env
 */
export function useColor(stream, env = process.env) {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
	if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
	return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

function errorShape(err) {
	return { name: err?.name ?? 'Error', message: err?.message ?? String(err), ...(err?.status ? { status: err.status } : {}) };
}

/**
 * Render pipeline events as text (stderr) or NDJSON (stdout).
 *
 * @param {{
 *   json?: boolean, quiet?: boolean, verbose?: boolean,
 *   stdout?: { write(s: string): any, isTTY?: boolean },
 *   stderr?: { write(s: string): any, isTTY?: boolean },
 *   env?: Record<string, string|undefined>
 * }} [opts]
 */
export function createReporter({ json = false, quiet = false, verbose = false, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
	const color = !json && useColor(stderr, env);
	const paint = (code, text) => (color ? `${ANSI[code]}${text}${ANSI.reset}` : text);
	const outColor = !json && useColor(stdout, env);
	const writeLine = (stream, line) => stream.write(`${line}\n`);

	/** @type {import('../util/events.js').EventSink} */
	const sink = (event) => {
		if (json) {
			writeLine(stdout, JSON.stringify({ ...event, time: new Date().toISOString() }));
			return;
		}
		const { type, stage, message, data } = event;
		if (quiet && type !== 'warn' && type !== 'error' && type !== 'decision') return;
		if ((type === 'progress' || type === 'timing') && !verbose) return;
		const prefix = stage ? paint('dim', `[${stage}] `) : '';
		let line;
		if (type === 'step') line = `${prefix}${paint('cyan', '>')} ${message}`;
		else if (type === 'warn') line = `${prefix}${paint('yellow', `warning: ${message}`)}`;
		else if (type === 'error') line = `${prefix}${paint('red', `error: ${message}`)}`;
		else if (type === 'decision') line = `${prefix}${paint('yellow', `decision needed: ${message}`)}`;
		else if (type === 'done') line = `${prefix}${paint('green', message)}`;
		else if (type === 'progress' || type === 'timing') line = `${prefix}${paint('dim', `  ${message}`)}`;
		else line = `${prefix}${message}`;
		if (verbose && data && Object.keys(data).length) line += paint('dim', ` ${JSON.stringify(data)}`);
		writeLine(stderr, line);
	};

	return {
		json,
		quiet,
		verbose,
		color,
		sink,
		/** Human output for the command result (stdout; suppressed in JSON mode). */
		print(text = '') {
			if (!json) writeLine(stdout, text);
		},
		/** Notes for humans on stderr (suppressed in JSON and quiet modes). */
		note(text = '') {
			if (!json && !quiet) writeLine(stderr, text);
		},
		warn(text) {
			if (json) sink({ type: 'warn', stage: 'cli', message: text });
			else writeLine(stderr, paint('yellow', `warning: ${text}`));
		},
		bold: (text) => (outColor ? `${ANSI.bold}${text}${ANSI.reset}` : text),
		/** Final line in JSON mode. */
		result(command, ok, result) {
			if (json) writeLine(stdout, JSON.stringify({ type: 'result', command, ok, result: result ?? null }));
		},
		error(command, err, exitCode = 1) {
			if (json) {
				writeLine(stdout, JSON.stringify({ type: 'result', command, ok: false, exitCode, error: errorShape(err) }));
				return;
			}
			writeLine(stderr, paint('red', `error: ${err?.message ?? err}`));
			if (verbose && err?.stack) writeLine(stderr, paint('dim', err.stack));
		}
	};
}

/** @typedef {ReturnType<typeof createReporter>} Reporter */

/**
 * Render rows as an aligned plain-text table.
 * @param {string[]} headers
 * @param {any[][]} rows
 */
export function formatTable(headers, rows) {
	const text = rows.map((r) => r.map((v) => (v === undefined || v === null ? '' : String(v))));
	const widths = headers.map((h, i) => Math.max(h.length, ...text.map((r) => (r[i] ?? '').length)));
	const fmt = (r) => r.map((v, i) => (i === r.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
	return [fmt(headers), fmt(widths.map((w) => '-'.repeat(w))), ...text.map(fmt)].join('\n');
}
