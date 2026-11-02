import { TableauGraphQLError } from './client.js';
import { stripBrackets } from '../model/naming.js';

const DS_FIELD_PLACEHOLDER = '__EMBEDDED__';

const FULL_QUERY = `query T2DWorkbook($luid: String!) {
	workbooks(filter: { luid: $luid }) {
		luid name projectName owner { username }
		sheets { luid id name path index
			containedInDashboards { luid name }
			worksheetFields { name formula dataType role }
			upstreamDatasources { name }
		}
		dashboards { luid id name path sheets { luid id name } }
		${DS_FIELD_PLACEHOLDER} { id name hasExtracts
			upstreamDatasources { luid name }
			fields { name fullyQualifiedName __typename isHidden
				... on CalculatedField { formula dataType role aggregation fields { name } }
				... on ColumnField { dataType role aggregation columns { name remoteType table { name } } }
			}
			upstreamTables { name fullName schema connectionType database { name connectionType } }
			upstreamDatabases { name connectionType }
		}
	}
}`;

// Used when the full query exceeds the node/time limit or a field is missing on an older schema.
const SLIM_QUERY = `query T2DWorkbookSlim($luid: String!) {
	workbooks(filter: { luid: $luid }) {
		luid name projectName
		${DS_FIELD_PLACEHOLDER} { id name
			upstreamDatasources { luid name }
			fields { name __typename ... on CalculatedField { formula } }
			upstreamTables { name fullName schema connectionType }
			upstreamDatabases { name connectionType }
		}
	}
}`;

const DS_FIELD_NAMES = ['embeddedDatasources', 'embeddedDataSources'];

/**
 * Lineage and formulas for one workbook from the Metadata API. The embedded
 * datasources are always returned under `embeddedDatasources`.
 * @param {import('./client.js').TableauClient} client
 * @param {string} workbookLuid
 * @returns {Promise<any|null>} Raw `workbooks[0]`, or null when the workbook is not indexed
 */
export async function fetchWorkbookMetadata(client, workbookLuid) {
	let lastError;
	for (const template of [FULL_QUERY, SLIM_QUERY]) {
		for (const dsField of DS_FIELD_NAMES) {
			try {
				const data = await client.graphql(template.replace(DS_FIELD_PLACEHOLDER, dsField), { luid: workbookLuid });
				const workbook = data?.workbooks?.[0];
				if (!workbook) return null;
				if (dsField !== 'embeddedDatasources') {
					workbook.embeddedDatasources = workbook[dsField];
					delete workbook[dsField];
				}
				return workbook;
			} catch (err) {
				if (!(err instanceof TableauGraphQLError)) throw err;
				lastError = err;
				if (rejectsField(err, dsField)) continue;
				break;
			}
		}
		if (!isRecoverable(lastError)) throw lastError;
	}
	throw lastError;
}

function errorText(err) {
	return (err.errors || []).map((e) => `${e?.extensions?.code || ''} ${e?.message || ''}`).join(' ');
}

function rejectsField(err, field) {
	return new RegExp(`\\b${field}\\b`).test(errorText(err)) && /undefined|unknown|cannot query|validation|not exist|FieldUndefined/i.test(errorText(err));
}

function isRecoverable(err) {
	return /NODE_LIMIT|TIME_LIMIT|undefined|unknown|cannot query|validation|FieldUndefined/i.test(errorText(err));
}

/**
 * Enrich the IR with Metadata API results: missing calculated-field formulas,
 * published-datasource luids, and info issues describing upstream tables.
 * Mutates and returns `ir`. Safe to call with null or partial metadata.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {any} metadata Result of fetchWorkbookMetadata
 */
export function applyMetadata(ir, metadata) {
	if (!ir || !metadata || typeof metadata !== 'object') return ir;
	if (!Array.isArray(ir.issues)) ir.issues = [];
	if (ir.workbook) {
		if (!ir.workbook.luid && metadata.luid) ir.workbook.luid = metadata.luid;
		if (!ir.workbook.projectName && metadata.projectName) ir.workbook.projectName = metadata.projectName;
	}

	const embedded = asArray(metadata.embeddedDatasources ?? metadata.embeddedDataSources).filter(Boolean);
	const upstreamByName = new Map();
	for (const mds of embedded) {
		for (const up of asArray(mds.upstreamDatasources)) {
			if (up?.name && up?.luid) upstreamByName.set(up.name, up.luid);
		}
	}

	const used = new Set();
	const irDatasources = asArray(ir.datasources);
	for (const ds of irDatasources) {
		const mds = matchDatasource(ds, embedded, used) ?? (irDatasources.length === 1 && embedded.length === 1 ? embedded[0] : undefined);
		if (mds) {
			used.add(mds);
			fillFormulas(ir, ds, mds);
			linkPublished(ds, mds, upstreamByName);
			addUpstreamIssue(ir, ds, mds);
		} else if (ds.published && !ds.published.luid) {
			const luid = upstreamByName.get(ds.published.name) ?? upstreamByName.get(ds.caption);
			if (luid) ds.published.luid = luid;
		}
	}
	return ir;
}

function matchDatasource(ds, embedded, used) {
	const free = embedded.filter((m) => !used.has(m));
	return (
		free.find((m) => m.name && m.name === ds.caption) ||
		free.find((m) => m.name && (m.name === ds.id || m.name === ds.published?.name)) ||
		free.find((m) => m.name && ds.caption && m.name.toLowerCase() === ds.caption.toLowerCase())
	);
}

function fillFormulas(ir, ds, mds) {
	const fields = asArray(ds.fields);
	const byKey = new Map();
	for (const f of fields) {
		for (const key of [f.name, f.caption, stripBrackets(f.id)]) {
			if (key && !byKey.has(key)) byKey.set(key, f);
		}
	}
	let filled = 0;
	for (const mf of asArray(mds.fields)) {
		if (!mf || mf.__typename !== 'CalculatedField' || typeof mf.formula !== 'string' || !mf.formula.trim()) continue;
		const field = byKey.get(mf.name) ?? byKey.get(stripBrackets(mf.name));
		if (!field || field.formula) continue;
		if (field.kind === 'calculated') {
			field.formula = mf.formula;
			filled++;
		} else if (field.kind === 'column' && !field.physical) {
			field.kind = 'calculated';
			field.formula = mf.formula;
			filled++;
		}
	}
	if (filled) {
		pushIssue(ir, {
			severity: 'info',
			code: 'metadata.formulas-filled',
			message: `Filled ${filled} calculated field formula(s) for "${ds.caption}" from the Tableau Metadata API`,
			object: { type: 'datasource', name: ds.caption, id: ds.id }
		});
	}
}

function linkPublished(ds, mds, upstreamByName) {
	const ups = asArray(mds.upstreamDatasources).filter((u) => u?.luid);
	const isProxy = asArray(ds.connections).some((c) => c?.class === 'sqlproxy');
	if (!ds.published && !(isProxy && ups.length)) return;
	if (!ds.published) ds.published = {};
	if (ds.published.luid) return;
	const wanted = [ds.published.name, ds.caption].filter(Boolean);
	const byName = ups.find((u) => wanted.includes(u.name));
	const chosen = byName || (ups.length === 1 ? ups[0] : undefined);
	const luid = chosen?.luid ?? wanted.map((n) => upstreamByName.get(n)).find(Boolean);
	if (luid) {
		ds.published.luid = luid;
		if (!ds.published.name && chosen?.name) ds.published.name = chosen.name;
	}
}

function addUpstreamIssue(ir, ds, mds) {
	const tables = asArray(mds.upstreamTables)
		.filter(Boolean)
		.map((t) => {
			const label = t.fullName || [t.schema, t.name].filter(Boolean).join('.') || t.name;
			const db = t.database?.name;
			return db && !String(label).includes(db) ? `${db}.${label}` : label;
		})
		.filter(Boolean);
	const databases = asArray(mds.upstreamDatabases)
		.filter((d) => d?.name)
		.map((d) => (d.connectionType ? `${d.name} (${d.connectionType})` : d.name));
	if (!tables.length && !databases.length) return;
	const parts = [];
	if (databases.length) parts.push(`databases: ${[...new Set(databases)].join(', ')}`);
	if (tables.length) parts.push(`tables: ${[...new Set(tables)].join(', ')}`);
	pushIssue(ir, {
		severity: 'info',
		code: 'metadata.upstream',
		message: `Datasource "${ds.caption}" reads from ${parts.join('; ')}`,
		object: { type: 'datasource', name: ds.caption, id: ds.id }
	});
}

function pushIssue(ir, issue) {
	const dup = ir.issues.some((i) => i.code === issue.code && i.object?.id === issue.object?.id && i.message === issue.message);
	if (!dup) ir.issues.push(issue);
}

function asArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}
