import { connectorFamily, connectorSpec } from '../convert/connectors.js';
import { readJson, writeJson } from './workspace.js';
import { federatedEntry } from '../tableau/data/federated.js';

export const SNAPSHOT_STRATEGIES = new Set(['hyper', 'published-extract', 'vds', 'view-csv']);

/** What extract does with a datasource that would become a snapshot and has no decision in mappings.json. */
export const UNMAPPED_POLICIES = ['ask', 'export', 'fail'];

/**
 * The answers to a data decision, zero-copy first. `copies` says whether the data lands in Domo.
 * @type {{ choice: DecisionChoice, letter: string, copies: boolean|null, label: string, idLabel?: string, strategy: string }[]}
 * @typedef {'cloud-amplifier'|'federated'|'dataset'|'account'|'export'|'none'} DecisionChoice
 */
export const DECISION_CHOICES = [
	{ choice: 'cloud-amplifier', letter: 'c', copies: false, label: 'Cloud Amplifier integration (the warehouse is queried live)', idLabel: 'Cloud Amplifier integration id', strategy: 'cloud-amplifier' },
	{ choice: 'federated', letter: 'f', copies: false, label: 'a Domo federated account (the database is queried live; plain tables only)', idLabel: 'Domo federated account id', strategy: 'federated' },
	{ choice: 'dataset', letter: 'd', copies: null, label: 'an existing Domo DataSet, used as is', idLabel: 'Domo DataSet id', strategy: 'existing' },
	{ choice: 'account', letter: 'a', copies: true, label: 'a Domo connector account (a refreshable connector stream)', idLabel: 'Domo connector account id', strategy: 'connector' },
	{ choice: 'export', letter: 'e', copies: true, label: 'export a snapshot through Tableau (one-time copy, the slowest)', strategy: 'auto' },
	{ choice: 'none', letter: 'n', copies: null, label: 'no data (an empty DataSet with the Tableau field schema)', strategy: 'none' }
];

export const choiceSpec = (choice) => DECISION_CHOICES.find((c) => c.choice === choice);

export class DataDecisionError extends Error {
	/** @param {DataDecision[]} decisions */
	constructor(decisions) {
		super(`${decisions.length} datasource(s) need a data decision before extract downloads any data: ${decisions.map((d) => `"${d.datasource.caption}"`).join(', ')}. Add the mappings.json entries listed, or re-run with --unmapped export.`);
		this.name = 'DataDecisionError';
		this.code = 'extract.data-decision-needed';
		this.decisions = decisions;
	}
}

/**
 * @typedef {Object} DataDecision
 * @property {string} key  mappings.json key: the published datasource luid, else the caption
 * @property {{ id: string, caption: string, published?: { luid?: string, name?: string } }} datasource
 * @property {string[]} workbooks
 * @property {Record<string, string|boolean>[]} connections  Tableau connection settings (no password: Tableau never returns it)
 * @property {string[]} snapshot  Likely export strategies, in fallback order
 * @property {{ integrationId: string, name: string, reason: string, match?: object, databases?: Record<string, string> }[]} [cloudAmplifier]
 * @property {{ providers: string[], status: 'match'|'candidates'|'none'|'unavailable', matches: object[], others: object[], reason?: string }} [accounts]
 * @property {{ reason: string }} [connectorBlocked]  Why a connector stream cannot reproduce the datasource (Initial SQL)
 * @property {{ providers: string[], status: 'match'|'candidates'|'none'|'unavailable', matches: object[], others: object[], reason?: string }} [federated]
 * @property {{ reason: string }} [federatedBlocked]  Why federated DataSets cannot serve the datasource
 * @property {{ reason: string }} [cloudAmplifierBlocked]  Why a Cloud Amplifier DataSet cannot serve the datasource
 * @property {{ choice: DecisionChoice, id?: string|number }} [suggested]
 * @property {Record<DecisionChoice, object>} entries  Ready-to-paste mappings.json fragments
 */

/** @param {import('../model/types.js').DatasourceIR|DataDecision['datasource']} ds */
export function decisionKey(ds) {
	return ds.published?.luid || ds.caption || ds.id;
}

function primaryConnection(decision) {
	return decision.connections.find((c) => connectorFamily(c.class)) ?? decision.connections[0];
}

function matchOf(connection) {
	if (!connection) return { class: '<class>', server: '<server>' };
	return Object.fromEntries(['class', 'server', 'dbname'].filter((k) => connection[k]).map((k) => [k, connection[k]]));
}

function accountEntry(decision, accountId, providerKey) {
	const connection = primaryConnection(decision);
	const family = connectorFamily(connection?.class);
	const defaultProvider = family ? connectorSpec(family)?.providerKey : undefined;
	return { match: matchOf(connection), accountId, ...(providerKey && providerKey !== defaultProvider ? { providerKey } : {}) };
}

function cloudAmplifierEntry(decision, integrationId) {
	const suggestion = decision.cloudAmplifier?.find((s) => s.integrationId === integrationId);
	return { match: suggestion?.match ?? matchOf(primaryConnection(decision)), integrationId, ...(suggestion?.databases ? { databases: suggestion.databases } : {}) };
}

/**
 * mappings.json fragment for one answer.
 * @param {DataDecision} decision
 * @param {DecisionChoice} choice
 * @param {string|number} [id]
 */
export function decisionEntry(decision, choice, id) {
	if (choice === 'cloud-amplifier') return { cloudAmplifier: [cloudAmplifierEntry(decision, id ?? '<integration id>')] };
	if (choice === 'dataset') return { datasets: { [decision.key]: id ?? '<DataSet id>' } };
	if (choice === 'federated') {
		const candidate = [...(decision.federated?.matches ?? []), ...(decision.federated?.others ?? [])].find((a) => String(a.id) === String(id));
		return { federated: [federatedEntry(primaryConnection(decision), id ?? '<federated account id>', { providerKey: candidate?.providerKey ?? decision.federated?.providers?.[0] })] };
	}
	if (choice === 'account') {
		const candidate = [...(decision.accounts?.matches ?? []), ...(decision.accounts?.others ?? [])].find((a) => String(a.id) === String(id));
		return { accounts: [accountEntry(decision, id ?? '<account id>', candidate?.providerKey ?? decision.accounts?.providers?.[0])] };
	}
	return { unmapped: { [decision.key]: choice } };
}

/**
 * Add the key, workbooks, suggestion and ready-to-paste entries to a raw decision from extractData.
 * @returns {DataDecision}
 */
export function completeDecision(raw, { key, workbook }) {
	const decision = { key, ...raw, workbooks: [...new Set([...(raw.workbooks ?? []), ...(workbook ? [workbook] : [])])] };
	const ca = decision.cloudAmplifier ?? [];
	if (ca.length === 1) decision.suggested = { choice: 'cloud-amplifier', id: ca[0].integrationId };
	else if (decision.connectorBlocked) decision.suggested = { choice: 'export' };
	else if (decision.accounts?.status === 'match') decision.suggested = { choice: 'account', id: decision.accounts.matches[0].id };
	else if (decision.federated?.status === 'match' && !decision.federatedBlocked) decision.suggested = { choice: 'federated', id: decision.federated.matches[0].id };
	else delete decision.suggested;
	decision.entries = Object.fromEntries(
		DECISION_CHOICES.map(({ choice }) => [choice, decisionEntry(decision, choice, decision.suggested?.choice === choice ? decision.suggested.id : choice === 'cloud-amplifier' ? ca[0]?.integrationId : undefined)])
	);
	return decision;
}

/** The answers that fit a decision: no connector account or federated account when it cannot serve the datasource. */
export function choicesFor(decision) {
	return DECISION_CHOICES.filter(
		(c) =>
			!(c.choice === 'account' && decision.connectorBlocked) &&
			!(c.choice === 'federated' && decision.federatedBlocked) &&
			!(c.choice === 'cloud-amplifier' && decision.cloudAmplifierBlocked)
	);
}

/** One decision per key; a shared datasource lists every workbook that uses it. */
export function mergeDecisions(decisions) {
	const byKey = new Map();
	for (const d of decisions) {
		const prev = byKey.get(d.key);
		if (prev) prev.workbooks = [...new Set([...prev.workbooks, ...d.workbooks])];
		else byKey.set(d.key, { ...d, workbooks: [...d.workbooks] });
	}
	return [...byKey.values()];
}

/**
 * Write the answers into mappings.json (the file as written, other keys untouched) and return what was recorded.
 * @param {string} file  mappings.json
 * @param {DataDecision[]} decisions
 * @param {{ key: string, choice: DecisionChoice, id?: string|number }[]} answers
 */
export async function recordAnswers(file, decisions, answers) {
	const raw = await readJson(file, {});
	const recorded = [];
	for (const answer of answers) {
		const decision = decisions.find((d) => d.key === answer.key);
		const spec = choiceSpec(answer.choice);
		if (!decision || !spec) continue;
		if (spec.idLabel && (answer.id === undefined || answer.id === null || String(answer.id).trim() === '')) continue;
		const id = (answer.choice === 'account' || answer.choice === 'federated') && /^\d+$/.test(String(answer.id)) ? Number(answer.id) : answer.id;
		const entry = decisionEntry(decision, answer.choice, id);
		for (const [section, value] of Object.entries(entry)) {
			if (Array.isArray(value)) {
				const list = Array.isArray(raw[section]) ? raw[section] : [];
				const same = (e) => JSON.stringify(e.match) === JSON.stringify(value[0].match);
				raw[section] = [...list.filter((e) => !same(e)), ...value];
			} else {
				raw[section] = { ...(raw[section] && typeof raw[section] === 'object' ? raw[section] : {}), ...value };
			}
		}
		recorded.push({ key: decision.key, choice: answer.choice, ...(id !== undefined ? { id } : {}), entry });
	}
	if (recorded.length) await writeJson(file, raw);
	return recorded;
}

function connectionLine(c) {
	const where = [c.server, c.dbname].filter(Boolean).join(' / ');
	const extra = [c.port ? `port ${c.port}` : '', c.warehouse ? `warehouse ${c.warehouse}` : '', c.schema ? `schema ${c.schema}` : '', c.username ? `user ${c.username}` : '', c.authentication ? `authentication ${c.authentication}` : ''].filter(Boolean);
	const password = c.embedPassword === true ? 'password embedded in Tableau, not readable' : c.embedPassword === false ? 'no embedded password' : '';
	return `${c.class}${where ? ` ${where}` : ''}${extra.length || password ? ` (${[...extra, password].filter(Boolean).join(', ')})` : ''}`;
}

function accountLabel(a) {
	const where = a.host ?? a.account;
	return `${a.id} "${a.name ?? ''}"${where ? ` ${where}${a.database ? `/${a.database}` : ''}` : ''}${a.notes?.length ? ` [${a.notes.join('; ')}]` : ''}`;
}

const OTHERS_LIMIT = 5;

/**
 * Human lines describing one decision: the Tableau connection, the likely export, the candidates found.
 * @param {DataDecision} d
 */
export function describeDecision(d) {
	const lines = [];
	const kind = d.datasource.published ? `published datasource${d.datasource.published.luid ? ` ${d.datasource.published.luid}` : ''}` : 'embedded datasource';
	lines.push(`"${d.datasource.caption}" (${kind}; used by ${d.workbooks.join(', ') || 'this workbook'})`);
	for (const c of d.connections) lines.push(`  Tableau connection: ${connectionLine(c)}`);
	if (!d.connections.length) lines.push('  Tableau connection: none Domo can reach (files or an extract only)');
	lines.push(`  Export would use: ${d.snapshot.length ? d.snapshot.join(', then ') : 'nothing available (no packaged extract or Tableau sign-in)'}`);
	for (const s of d.cloudAmplifier ?? []) {
		lines.push(`  Cloud Amplifier: "${s.name}" (${s.integrationId}) ${s.reason}${s.databases ? `, databases ${Object.entries(s.databases).map(([a, b]) => `${a} as ${b}`).join(', ')}` : ''}`);
	}
	const acc = d.accounts;
	if (acc) {
		const providers = acc.providers.join(', ');
		if (acc.status === 'unavailable') lines.push(`  Connector accounts (${providers}): not checked, ${acc.reason}`);
		else if (acc.status === 'none') lines.push(`  Connector accounts (${providers}): none on this server${acc.others.length ? `; ${acc.others.length} other(s): ${acc.others.slice(0, OTHERS_LIMIT).map(accountLabel).join(', ')}${acc.others.length > OTHERS_LIMIT ? ', ...' : ''}` : ''}`);
		else lines.push(`  Connector accounts (${providers}): ${acc.status === 'match' ? 'match' : 'possible matches'} ${acc.matches.map(accountLabel).join(', ')}`);
	}
	const fed = d.federated;
	if (d.cloudAmplifierBlocked) lines.push(`  Cloud Amplifier: not possible, ${d.cloudAmplifierBlocked.reason}`);
	if (d.federatedBlocked) lines.push(`  Federated: not possible, ${d.federatedBlocked.reason}`);
	else if (fed) {
		const providers = fed.providers.join(', ');
		if (fed.status === 'unavailable') lines.push(`  Federated accounts (${providers || 'none'}): not checked, ${fed.reason}`);
		else if (fed.status === 'none') lines.push(`  Federated accounts (${providers}): no federated account for this server${fed.others.length ? `; ${fed.others.length} other(s): ${fed.others.slice(0, OTHERS_LIMIT).map(accountLabel).join(', ')}${fed.others.length > OTHERS_LIMIT ? ', ...' : ''}` : ''}`);
		else lines.push(`  Federated accounts (${providers}): ${fed.status === 'match' ? 'match' : 'possible matches'} ${fed.matches.map(accountLabel).join(', ')}`);
	}
	if (d.connectorBlocked) lines.push(`  Connector stream: not possible. ${d.connectorBlocked.reason}`);
	if (d.suggested) lines.push(`  Suggested: ${d.suggested.id !== undefined ? `${choiceSpec(d.suggested.choice).idLabel} ${d.suggested.id}` : choiceSpec(d.suggested.choice).label}`);
	return lines;
}

/**
 * Text for a run that stopped: every decision with ready-to-paste mappings.json entries.
 * @param {DataDecision[]} decisions
 */
export function formatDecisions(decisions) {
	const out = [
		`${decisions.length} datasource(s) need a data decision before extract downloads any data. An export copies every row through Tableau and can take a long time, so t2d does not assume one.`,
		''
	];
	for (const d of decisions) {
		out.push(...describeDecision(d));
		out.push('  Add one of these to mappings.json:');
		for (const spec of choicesFor(d)) {
			const tag = spec.copies === false ? 'keeps data out of Domo' : spec.copies ? 'copies data into Domo' : spec.choice === 'dataset' ? 'data already in Domo' : 'no data';
			out.push(`    ${spec.label}, ${tag}: ${JSON.stringify(d.entries[spec.choice])}`);
		}
		out.push('');
	}
	out.push('Or re-run with --unmapped export to export every undecided datasource as before.');
	return out.join('\n');
}
