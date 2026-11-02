/**
 * Progress reporting. Core functions never print; they call `emit(event)` so the
 * CLI can render text or NDJSON and a future UI can subscribe to the same stream.
 *
 * @typedef {'step'|'progress'|'info'|'warn'|'error'|'done'|'timing'|'decision'} EventType
 *
 * @typedef {Object} T2DEvent
 * @property {EventType} type
 * @property {string} stage     e.g. 'extract', 'convert', 'push'
 * @property {string} message
 * @property {Record<string, any>} [data]   timing: a TimingStep (`src/util/timing.js`), `step: 'total'` for the run;
 *   decision: a DataDecision (`src/pipeline/decisions.js`)
 *
 * @typedef {(event: T2DEvent) => void} EventSink
 */

/** @type {EventSink} */
export const noopSink = () => {};

/**
 * Bind a stage name so callers can write `log.info('...')`.
 * @param {EventSink} [sink]
 * @param {string} stage
 */
export function createEmitter(sink = noopSink, stage) {
	const emit = (type, message, data) => sink({ type, stage, message, ...(data ? { data } : {}) });
	return {
		sink,
		stage,
		step: (message, data) => emit('step', message, data),
		progress: (message, data) => emit('progress', message, data),
		info: (message, data) => emit('info', message, data),
		warn: (message, data) => emit('warn', message, data),
		error: (message, data) => emit('error', message, data),
		done: (message, data) => emit('done', message, data),
		timing: (message, data) => emit('timing', message, data),
		decision: (message, data) => emit('decision', message, data),
		child: (childStage) => createEmitter(sink, `${stage}:${childStage}`)
	};
}

/** @typedef {ReturnType<typeof createEmitter>} Emitter */
