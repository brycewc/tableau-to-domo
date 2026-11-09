import { sqlToMagic } from '../magic/index.js';
import { isRef } from '../util/refs.js';
import { slugify } from '../util/ids.js';

const Y_GAP = 240;

const engineOf = (df) => `${df.definition?.databaseType ?? 'MAGIC'}\u0000${df.definition?.computeCloud ?? ''}`;
const loadKey = (a) => (a.type === 'LoadFromVault' && isRef(a.dataSourceId) && a.dataSourceId.$ref.startsWith('dataset:') ? a.dataSourceId.$ref.slice(8) : null);
const ID_FIELDS = ['dependsOn', 'inputs', 'input', 'step1', 'step2'];
const relink = (a, to) => {
	const out = { ...a };
	for (const f of ID_FIELDS) if (a[f] !== undefined) out[f] = Array.isArray(a[f]) ? a[f].map(to) : to(a[f]);
	return out;
};
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A SQL tile reads its inputs by tile name, so renaming a tile rewrites the statements that name it.
const renameInSql = (actions, from, to) => {
	if (!from || !to || from === to) return actions;
	const word = new RegExp(`(?<![A-Za-z0-9_"])${escapeRe(from)}(?![A-Za-z0-9_"])`, 'g');
	const quoted = `"${from.replace(/"/g, '""')}"`;
	const rename = (st) => st.split(quoted).join(`"${to.replace(/"/g, '""')}"`).replace(word, to);
	return actions.map((a) => (a.type === 'SQL' && a.statements ? { ...a, statements: a.statements.map(rename) } : a));
};

// Adrenaline SQL, which runs formulas on the warehouse, has no CHAR type (live-checked); STRING is its text type.
const adrFormula = (text) => text.replace(/\bAS\s+CHAR\s*\)/gi, 'AS STRING)');
const adrExpressions = (value) => {
	if (Array.isArray(value)) return value.map(adrExpressions);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'expression' && typeof v === 'string' ? adrFormula(v) : adrExpressions(v)]));
};
const ADR_LOAD = { settings: { preferredDatabaseEntityType: 'TEMP_VIEW' }, sourceType: 'AUTO', filterPolicy: 'LEGACY' };

/**
 * Domo-engine dataflows whose inputs all live on one Cloud Amplifier integration, moved to run on that warehouse (ADR)
 * and publish there. A moved flow gets a new key, so push builds its outputs on the warehouse instead of reusing the
 * Domo-stored ones. Mutates `plan.dataflows` and the outputs' `dataflowOutput`.
 * @param {import('../model/types.js').DomoPlan} plan
 * @returns {import('../model/types.js').Issue[]}
 */
export function moveDataflowsToWarehouse(plan) {
	const datasetByKey = new Map((plan.datasets ?? []).map((d) => [d.key, d]));
	const producer = new Map();
	for (const df of plan.dataflows ?? []) for (const key of df.outputDatasetKeys ?? []) producer.set(key, df);
	const cloudOf = (key, seen = new Set()) => {
		const d = datasetByKey.get(key);
		if (!d) return null;
		if (d.strategy === 'cloud-amplifier') return d.cloudAmplifier?.integrationId ?? null;
		if (d.strategy === 'view') return d.view?.cloudId ?? null;
		const df = d.strategy === 'dataflow-output' && producer.get(key);
		if (!df || seen.has(df.key)) return null;
		seen.add(df.key);
		return flowCloud(df, seen);
	};
	const flowCloud = (df, seen = new Set()) => {
		if (df.definition?.databaseType === 'ADR') return df.definition.computeCloud ?? null;
		const loads = (df.definition?.actions ?? []).filter((a) => a.type === 'LoadFromVault');
		const keys = loads.map(loadKey);
		if (!keys.length || keys.some((k) => !k)) return null;
		const clouds = new Set(keys.map((k) => cloudOf(k, seen)));
		return clouds.size === 1 && !clouds.has(null) ? [...clouds][0] : null;
	};
	const moved = [];
	plan.dataflows = (plan.dataflows ?? []).map((df) => {
		if (df.definition?.databaseType === 'ADR') return df;
		const cloud = flowCloud(df);
		if (!cloud) return df;
		moved.push(df.name);
		const key = `${df.key}.warehouse`;
		for (const out of df.outputDatasetKeys ?? []) {
			const d = datasetByKey.get(out);
			if (d?.dataflowOutput) d.dataflowOutput = { ...d.dataflowOutput, dataflowKey: key };
		}
		const actions = df.definition.actions.map((a) => {
			if (a.type === 'LoadFromVault') return { ...a, ...ADR_LOAD };
			if (a.type === 'PublishToVault') return { ...a, dataSource: { ...a.dataSource, cloudId: cloud } };
			return adrExpressions(a);
		});
		const flow = { ...df, key, definition: { ...df.definition, databaseType: 'ADR', computeCloud: cloud, settings: { ...(df.definition.settings ?? {}), sqlDialect: 'ADRENALINE' }, actions } };
		delete flow.shared;
		delete flow.previousKey;
		return flow;
	});
	if (!moved.length) return [];
	return [{ severity: 'info', code: 'data.dataflows-warehouse', message: `Dataflow(s) ${moved.map((n) => `'${n}'`).join(', ')} run on the Cloud Amplifier warehouse their inputs come from, and publish their outputs there.`, object: { type: 'workbook', name: plan.source?.workbook || 'Workbook' } }];
}

/**
 * Every dataflow a workbook plans on one engine as one dataflow: a flow that reads another's output takes that
 * output's tile directly, and an intermediate output nothing else reads is no longer published. Pure on its inputs;
 * replaces `plan.dataflows` and `plan.datasets`.
 * @param {import('../model/types.js').DomoPlan} plan
 * @param {{ workbookKey: string }} opts
 * @returns {import('../model/types.js').Issue[]}
 */
export function combineDataflows(plan, { workbookKey }) {
	const issues = [];
	const groups = new Map();
	for (const df of [...(plan.dataflows ?? []), ...viewFlows(plan, issues)]) {
		if (!groups.has(engineOf(df))) groups.set(engineOf(df), []);
		groups.get(engineOf(df)).push(df);
	}
	const combined = [];
	for (const flows of groups.values()) {
		const merged = flows.length > 1 ? mergeGroup(flows, plan, workbookKey) : null;
		if (!merged) {
			for (const f of flows.filter((x) => x.view)) delete plan.datasets.find((d) => d.key === f.outputDatasetKeys[0])?.dataflowOutput;
			combined.push(...flows.filter((f) => !f.view));
			continue;
		}
		combined.push(merged.flow);
		const dropped = new Set(merged.dropped);
		plan.datasets = plan.datasets.filter((d) => !dropped.has(d.key));
		for (const d of plan.datasets) if (d.dataflowOutput && merged.outputs.has(d.key)) d.dataflowOutput = { ...d.dataflowOutput, dataflowKey: merged.flow.key };
		issues.push({
			severity: 'info',
			code: 'data.dataflows-combined',
			message: `${flows.map((f) => f.name).join(', ')} run as one Magic ETL dataflow, '${merged.flow.name}'${merged.dropped.length ? `; ${merged.dropped.length} intermediate output(s) are no longer published` : ''}.`,
			object: { type: 'workbook', name: plan.source?.workbook || 'Workbook' }
		});
	}
	plan.dataflows = combined;
	return issues;
}

/**
 * A SQL DataSet View that dataflows on its warehouse read, as the tiles of its Custom SQL: a dataflow on the warehouse
 * cannot load a view ("The supplied inputs are not on a dataflow device", live-checked). A view cards also read stays.
 */
function viewFlows(plan, issues) {
	const clouds = new Set((plan.dataflows ?? []).filter((df) => df.definition?.databaseType === 'ADR').map((df) => df.definition.computeCloud));
	const views = (plan.datasets ?? []).filter((d) => d.strategy === 'view' && d.warehouseSql && clouds.has(d.view?.cloudId));
	if (!views.length) return [];
	const outside = usedOutside(plan, new Set(views.map((v) => v.key)));
	const readers = new Map();
	for (const df of plan.dataflows ?? []) for (const a of df.definition?.actions ?? []) if (loadKey(a)) readers.set(loadKey(a), [...(readers.get(loadKey(a)) ?? []), df]);
	const datasetByKey = new Map(plan.datasets.map((d) => [d.key, d]));
	const flows = [];
	for (const v of views) {
		const read = readers.get(v.key) ?? [];
		if (!read.length || read.some((df) => df.definition.computeCloud !== v.view.cloudId)) continue;
		const keep = outside.has(v.key) || Boolean(v.cardTarget);
		const inputs = Object.fromEntries(Object.entries(v.warehouseSql.tables).map(([name, r]) => [name, { dataSourceId: r, name: datasetByKey.get(r.$ref.slice(8))?.name, columns: datasetByKey.get(r.$ref.slice(8))?.schema }]));
		const result = sqlToMagic('', { inputs, outputs: [{ name: v.name, sql: v.warehouseSql.sql }], compute: { type: 'adr', cloudId: v.view.cloudId }, mode: 'sql', name: v.name });
		if (result.blocked) {
			issues.push({ severity: 'info', code: 'data.view-not-folded', message: `SQL DataSet View '${v.name}' stays a view: its Custom SQL ${result.blocked.reason}.`, object: { type: 'dataset', name: v.name } });
			continue;
		}
		if (!keep) v.dataflowOutput = { dataflowKey: `view:${v.key}`, outputName: v.name };
		flows.push({ key: `view:${v.key}`, name: `view '${v.name}'`, view: true, keepView: keep, definition: result.definition, outputDatasetKeys: [v.key], runAfterCreate: true });
	}
	return flows;
}

function mergeGroup(flows, plan, workbookKey) {
	const outputOf = new Map();
	for (const df of flows) for (const key of df.outputDatasetKeys ?? []) outputOf.set(key, df);
	const datasetByKey = new Map((plan.datasets ?? []).map((d) => [d.key, d]));
	const readByOthers = usedOutside(plan, new Set(outputOf.keys()));

	const names = new Set();
	for (const df of flows) for (const a of df.definition.actions) if (a.type === 'PublishToVault') {
		if (names.has(a.name)) return null;
		names.add(a.name);
	}

	const ids = new Set();
	const tileNames = new Set();
	const actions = [];
	const publishedKey = new Map();
	const publishTile = new Map();
	let yOffset = 0;
	for (const df of flows) {
		const rename = new Map();
		let own = df.definition.actions;
		for (const a of own) {
			let id = a.id;
			for (let k = 2; ids.has(id); k++) id = `${a.id}-${k}`;
			ids.add(id);
			rename.set(a.id, id);
		}
		for (const a of [...own]) {
			if (a.type === 'PublishToVault' || !a.name) continue;
			let name = a.name;
			for (let k = 2; tileNames.has(name); k++) name = `${a.name}_${k}`;
			tileNames.add(name);
			if (name !== a.name) own = renameInSql(own, a.name, name).map((x) => (x.id === a.id ? { ...x, name } : x));
		}
		let bottom = 0;
		for (const a of own) {
			const moved = { ...relink(a, (d) => rename.get(d) ?? d), id: rename.get(a.id), ...(a.gui ? { gui: { ...a.gui, y: (a.gui.y ?? 0) + yOffset } } : {}) };
			bottom = Math.max(bottom, moved.gui?.y ?? 0);
			if (a.type === 'PublishToVault') {
				const key = datasetKeyOf(df, a, datasetByKey);
				publishedKey.set(moved.id, key);
				if (key) publishTile.set(key, moved.dependsOn?.[0]);
			}
			actions.push(moved);
		}
		yOffset = bottom + Y_GAP;
	}

	const replace = new Map();
	const intermediate = new Set();
	const firstLoad = new Map();
	const kept = [];
	// Domo rejects a dataflow that loads one dataset twice (DP-DFDI), and two plan keys can register one table.
	const sameData = (key) => {
		const ca = datasetByKey.get(key)?.cloudAmplifier;
		return ca ? `ca:${ca.integrationId}:${ca.databaseName}.${ca.schemaName}.${ca.tableName}`.toUpperCase() : key;
	};
	for (const action of actions) {
		const key = loadKey(action);
		if (key && publishTile.get(key)) {
			replace.set(action.id, publishTile.get(key));
			intermediate.add(key);
		} else if (key && firstLoad.has(sameData(key))) replace.set(action.id, firstLoad.get(sameData(key)));
		else {
			if (key) firstLoad.set(sameData(key), action.id);
			kept.push(action);
		}
	}
	const resolve = (id) => (replace.has(id) ? resolve(replace.get(id)) : id);
	const keptViews = new Set(flows.filter((f) => f.keepView).flatMap((f) => f.outputDatasetKeys));
	const dropped = [...intermediate].filter((key) => !keptViews.has(key) && !readByOthers.has(key) && !datasetByKey.get(key)?.cardTarget);
	const droppedSet = new Set(dropped);
	const unpublished = new Set([...dropped, ...keptViews]);
	let finalActions = kept.filter((a) => !unpublished.has(publishedKey.get(a.id))).map((a) => relink(a, resolve));
	const byId = new Map(actions.map((a) => [a.id, a]));
	for (const [from] of replace) finalActions = renameInSql(finalActions, byId.get(from).name, byId.get(resolve(from)).name);

	const outputs = new Set(flows.flatMap((f) => f.outputDatasetKeys ?? []).filter((k) => !unpublished.has(k)));
	const host = flows.filter((f) => !f.view).sort((a, b) => cardOutputs(b, datasetByKey, droppedSet) - cardOutputs(a, datasetByKey, droppedSet))[0];
	const workbook = plan.source?.workbook || workbookKey;
	const first = host.definition;
	const flow = {
		key: host.shared ? `${workbookKey}.${slugify(host.key)}` : host.key,
		name: `${workbook} (Tableau data prep)`,
		definition: {
			...first,
			name: `${workbook} (Tableau data prep)`,
			description: `Data preparation for the Tableau workbook '${workbook}': ${flows.map((f) => f.name).join(', ')}.`,
			actions: finalActions
		},
		outputDatasetKeys: [...outputs],
		runAfterCreate: flows.some((f) => f.runAfterCreate !== false)
	};
	return { flow, dropped, outputs };
}

function datasetKeyOf(df, publish, datasetByKey) {
	for (const key of df?.outputDatasetKeys ?? []) {
		const d = datasetByKey.get(key);
		if ((d?.dataflowOutput?.outputName ?? d?.name) === publish.name) return key;
	}
	return undefined;
}

function cardOutputs(df, datasetByKey, dropped) {
	return (df.outputDatasetKeys ?? []).filter((k) => !dropped.has(k) && datasetByKey.get(k)?.cardTarget).length;
}

/** Dataset keys the plan reads anywhere but in the dataflows and in the dataset's own entry. */
function usedOutside(plan, keys) {
	const used = new Set();
	const visit = (value, self) => {
		if (isRef(value)) {
			const key = value.$ref.startsWith('dataset:') ? value.$ref.slice(8) : null;
			if (key && keys.has(key) && key !== self) used.add(key);
		} else if (Array.isArray(value)) value.forEach((v) => visit(v, self));
		else if (value && typeof value === 'object') Object.values(value).forEach((v) => visit(v, self));
		else if (typeof value === 'string' && keys.has(value) && value !== self) used.add(value);
	};
	for (const [k, v] of Object.entries(plan)) {
		if (k === 'dataflows' || k === 'issues') continue;
		if (k === 'datasets') for (const d of v ?? []) visit({ ...d, key: undefined, dataflowOutput: undefined }, d.key);
		else visit(v);
	}
	return used;
}

/**
 * Warehouse dataflows in the Magic ETL graph editor's format. Without `useGraphUI` Domo runs an ADR flow in its legacy
 * mode, where a Snowflake-dialect SQL tile fails (it cannot find its inputs by tile name; live-checked).
 * @param {import('../model/types.js').DomoPlan} plan
 */
export function useGraphEditor(plan) {
	for (const df of plan.dataflows ?? []) {
		if (df.definition?.databaseType !== 'ADR') continue;
		const elements = df.definition.actions.map((a) => ({ id: a.id, type: 'Tile', x: a.gui?.x ?? 0, y: a.gui?.y ?? 0, color: null, colorSource: null }));
		df.definition.gui = { version: '1.0', useGraphUI: true, canvases: { default: { canvasSettings: { coarserGrid: true, hideCoarserGridPopUp: false }, disabledActions: [], elements } } };
	}
}
