/**
 * Step durations for one pipeline run. Each finished step is kept in `steps` and emitted as a 'timing' event.
 *
 * @typedef {Object} TimingStep
 * @property {string} step       'datasets', 'datasets.upload', 'tableau.sign-in', ... (a dot nests it in its parent)
 * @property {string} startedAt
 * @property {number} ms
 * @property {boolean} [failed]
 *   Any other properties are step metadata: key, name, rows, bytes, waitMs, ...
 *
 * @typedef {Object} Timing
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {number} ms
 * @property {TimingStep[]} steps
 */

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {{ emitter?: import('./events.js').Emitter, now?: () => number }} [opts]
 */
export function createTimer({ emitter, now = Date.now } = {}) {
	const t0 = now();
	/** @type {TimingStep[]} */
	const steps = [];
	let phaseEnd = null;
	let finished = null;

	const record = (step, start, meta = {}) => {
		const entry = { step, startedAt: iso(start), ms: Math.max(0, now() - start), ...meta };
		steps.push(entry);
		emitter?.timing?.(describeStep(entry), entry);
		return entry;
	};

	/** Start a step; the returned function ends it (later calls do nothing) with extra metadata. */
	const start = (step, meta = {}) => {
		const begun = now();
		let done = null;
		return (more = {}) => (done ??= record(step, begun, { ...meta, ...more }));
	};

	return {
		steps,
		startedAt: iso(t0),
		start,
		/**
		 * Time `fn`. `meta` is an object, or a function of the result (then `base` is recorded even when `fn` throws).
		 * A throw is recorded as `failed` and rethrown.
		 * @template T
		 * @param {string} step
		 * @param {() => Promise<T>|T} fn
		 * @param {Record<string, any>|((result: T) => Record<string, any>)} [meta]
		 * @param {Record<string, any>} [base]
		 * @returns {Promise<T>}
		 */
		async time(step, fn, meta = {}, base = {}) {
			const end = start(step, typeof meta === 'function' ? base : { ...base, ...meta });
			let result;
			try {
				result = await fn();
			} catch (err) {
				end({ failed: true });
				throw err;
			}
			end(typeof meta === 'function' ? (meta(result) ?? {}) : {});
			return result;
		},
		/** End the current phase and, when `active`, start `step` as the next one. */
		phase(step, active = true) {
			phaseEnd?.();
			phaseEnd = active && step ? start(step) : null;
		},
		/** Close the open phase and emit the total. @returns {Timing} */
		finish(meta = {}) {
			if (finished) return finished;
			phaseEnd?.();
			phaseEnd = null;
			const ms = Math.max(0, now() - t0);
			finished = { startedAt: iso(t0), finishedAt: iso(t0 + ms), ms, steps };
			emitter?.timing?.(`total: ${formatDuration(ms)}`, { step: 'total', startedAt: iso(t0), ms, ...meta });
			return finished;
		}
	};
}

/** @typedef {ReturnType<typeof createTimer>} Timer */

/** @param {number} ms */
export function formatDuration(ms) {
	if (!Number.isFinite(ms)) return '?';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const s = Math.round(ms / 1000);
	const pad = (n) => String(n).padStart(2, '0');
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) return '?';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${bytes} B`;
}

/** One line for a step: `datasets.upload "Orders": 12.3 s (120,000 rows, 3.4 MB)`. @param {TimingStep} entry */
export function describeStep(entry) {
	const label = entry.name ?? entry.key;
	const extras = [];
	if (entry.rows != null) extras.push(`${Number(entry.rows).toLocaleString('en-US')} rows`);
	if (entry.bytes != null) extras.push(formatBytes(entry.bytes));
	if (entry.waitMs != null) extras.push(`${formatDuration(entry.waitMs)} waiting`);
	if (entry.failed) extras.push('failed');
	return `${entry.step}${label ? ` "${label}"` : ''}: ${formatDuration(entry.ms)}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

/** The `top` slowest steps, slowest first. @param {Timing|undefined} timing */
export function slowestSteps(timing, top = 5) {
	return [...(timing?.steps ?? [])].sort((a, b) => b.ms - a.ms).slice(0, top);
}

/**
 * Short human summary: the total, then the slowest steps.
 * @param {Timing|undefined} timing
 * @param {{ label?: string, top?: number }} [opts]
 * @returns {string[]}
 */
export function formatTimingSummary(timing, { label = 'Total', top = 5 } = {}) {
	if (!timing) return [];
	const slow = slowestSteps(timing, top);
	return [`${label}: ${formatDuration(timing.ms)}`, ...(slow.length ? ['Slowest steps:', ...slow.map((s) => `  ${describeStep(s)}`)] : [])];
}
