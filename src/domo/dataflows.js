import { poll } from '../util/http.js';

const DATAFLOWS = '/dataprocessing/v1/dataflows';

export const SUCCESS_STATES = new Set(['SUCCESS']);
export const FAIL_STATES = new Set(['FAILED_DATA_FLOW', 'FAILED_UNKNOWN', 'FAILED_INDEXING', 'REJECTED', 'KILLED']);
export const INPUT_TRIGGER_TITLE = 'Input DataSets updated';

export function inputTriggerSettings(actions) {
	const ids = [...new Set((actions ?? []).filter((a) => a.type === 'LoadFromVault' && a.dataSourceId).map((a) => String(a.dataSourceId)))];
	if (!ids.length) return undefined;
	return {
		triggers: [{ title: INPUT_TRIGGER_TITLE, triggerEvents: ids.map((datasetId) => ({ type: 'DATASET_UPDATED', datasetId, triggerOnDataChanged: true })), triggerConditions: [] }],
		zoneId: 'UTC',
		locale: 'en_US'
	};
}

function userTriggers(settings) {
	const triggers = settings?.triggers ?? [];
	return triggers.length > 0 && triggers.some((t) => t.title !== INPUT_TRIGGER_TITLE);
}

/**
 * Create a Magic ETL dataflow. Output datasets for PublishToVault actions with an
 * empty `dataSource.guid` are created by the server.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {Object} def
 * @returns {Promise<Object>} dataflow incl. id
 */
export async function createDataflow(c, def) {
	return c.post(DATAFLOWS, {
		databaseType: 'MAGIC',
		engineProperties: { 'kettle.mode': 'STRICT' },
		gui: {},
		...def
	});
}

/**
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function getDataflow(c, id) {
	return c.get(`${DATAFLOWS}/${encodeURIComponent(id)}`);
}

/**
 * Replace a dataflow definition (the endpoint wants the full object).
 * With `merge` (default) the current dataflow is read first, `def` is laid over it,
 * and PublishToVault actions without a guid reuse the existing output dataset
 * (matched by action id, then output name) so a re-push does not create new outputs. Triggers someone
 * added in Domo are kept.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @param {Object} def
 * @param {{ merge?: boolean }} [opts]
 */
export async function updateDataflow(c, id, def, { merge = true } = {}) {
	let body = def;
	if (merge) {
		const current = await getDataflow(c, id);
		// A run rejected after an update leaves the flow paused, and a paused flow answers a new run with a bare 400.
		body = { ...current, paused: false, pausedReason: null, ...def, id: current?.id ?? id };
		if (userTriggers(current?.triggerSettings)) body.triggerSettings = current.triggerSettings;
		if (Array.isArray(def.actions)) body.actions = carryOutputGuids(def.actions, current?.actions || []);
	}
	return c.put(`${DATAFLOWS}/${encodeURIComponent(id)}`, body);
}

function carryOutputGuids(actions, previous) {
	const publishes = previous.filter((a) => a.type === 'PublishToVault' && a.dataSource?.guid);
	return actions.map((action) => {
		if (action.type !== 'PublishToVault' || action.dataSource?.guid) return action;
		const match =
			publishes.find((p) => p.id === action.id) ||
			publishes.find((p) => p.dataSource?.name && p.dataSource.name === action.dataSource?.name);
		return { ...action, dataSource: { ...action.dataSource, guid: match?.dataSource.guid ?? null } };
	});
}

/**
 * Start a run.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @returns {Promise<Object>} execution incl. id
 */
export async function runDataflow(c, id) {
	return c.post(`${DATAFLOWS}/${encodeURIComponent(id)}/executions`);
}

/**
 * Poll an execution until it is terminal. Resolves on SUCCESS, throws on a failed state.
 *
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 * @param {number|string} execId
 * @param {{ intervalMs?: number, timeoutMs?: number, emitter?: import('../util/events.js').Emitter }} [opts]
 */
export async function waitForExecution(c, id, execId, { intervalMs = 5000, timeoutMs = 60 * 60 * 1000, emitter = c.emitter } = {}) {
	let lastState;
	return poll(
		async () => {
			const exec = await c.get(`${DATAFLOWS}/${encodeURIComponent(id)}/executions/${encodeURIComponent(execId)}`);
			const state = String(exec?.state ?? 'UNKNOWN');
			if (SUCCESS_STATES.has(state)) return exec;
			if (FAIL_STATES.has(state) || state === 'SKIPPED') {
				const detail = exec?.failureReason || exec?.errorMessage || exec?.message || executionErrors(exec?.errors);
				const err = new Error(`Dataflow ${id} execution ${execId} ended in ${state}${detail ? `: ${detail}` : ''}`);
				err.execution = exec;
				throw err;
			}
			if (state !== lastState) emitter?.progress(`Dataflow ${id}: ${state}`, { dataflowId: id, executionId: execId, state });
			lastState = state;
			return undefined;
		},
		{ intervalMs, timeoutMs, label: `dataflow ${id} execution ${execId}` }
	);
}

/** "DP-0030 group-accountau-lod: Division by zero" for each entry of an execution's errors[]. */
export function executionErrors(errors) {
	if (!Array.isArray(errors) || !errors.length) return '';
	return errors
		.map((e) => {
			if (e === null || typeof e !== 'object') return String(e);
			const text = e.localizedMessage ?? e.message ?? JSON.stringify(e);
			const where = [e.code, e.actionId].filter(Boolean).join(' ');
			return where ? `${where}: ${text}` : String(text);
		})
		.join('; ');
}

/**
 * Output datasets of a dataflow, from `outputs[]` and PublishToVault actions.
 * @param {Object} dataflow
 * @returns {{ id: string, name?: string, actionId?: string }[]}
 */
export function outputDatasets(dataflow) {
	const seen = new Map();
	for (const output of dataflow?.outputs || []) {
		if (output?.dataSourceId) seen.set(output.dataSourceId, { id: output.dataSourceId, name: output.dataSourceName });
	}
	for (const action of dataflow?.actions || []) {
		if (action?.type !== 'PublishToVault' || !action.dataSource?.guid) continue;
		const prev = seen.get(action.dataSource.guid) || {};
		seen.set(action.dataSource.guid, { id: action.dataSource.guid, name: prev.name ?? action.dataSource.name, actionId: action.id });
	}
	return [...seen.values()];
}

/**
 * @param {Object} dataflow
 * @returns {string[]}
 */
export function outputDatasetIds(dataflow) {
	return outputDatasets(dataflow).map((o) => o.id);
}

/**
 * Delete a dataflow. Its output datasets stay. Mutating.
 * @param {import('./client.js').DomoClient} c
 * @param {number|string} id
 */
export async function deleteDataflow(c, id) {
	return c.del(`${DATAFLOWS}/${encodeURIComponent(id)}`);
}
