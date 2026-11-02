import { stripBrackets } from '../../model/naming.js';
import { fieldFromColumn, fieldFromGroup, fieldFromRecord, normalizeDatatype } from './fields.js';
import { parseFilter } from './filters.js';
import { parsePillId, splitBracketParts } from './shelf.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').DatasourceIR} DatasourceIR
 * @typedef {import('../../model/types.js').ConnectionIR} ConnectionIR
 * @typedef {import('../../model/types.js').TableIR} TableIR
 * @typedef {import('../../model/types.js').RelationNode} RelationNode
 * @typedef {import('../../model/types.js').JoinCondition} JoinCondition
 * @typedef {import('../../model/types.js').Issue} Issue
 * @typedef {import('./fields.js').MetadataRecord} MetadataRecord
 */

/** Attribute names that may hold credentials (from jawharjoe/tableau-to-power-bi-manual-migration). */
export const SENSITIVE_NAME = /(?:pass(?:word|wd)?|secret|token|private.?key|access.?key|credential|oauth|username|user)/i;
const SENSITIVE_VALUE = /(?:\bpwd|\bpassword|\bsecret|\btoken|api[_-]?key|\bauth[_-]?key)\s*[=:]/i;

const CORE_ATTRS = ['class', 'server', 'port', 'dbname', 'schema', 'warehouse', 'service', 'authentication', 'filename'];
const FILE_CLASSES = new Set(['excel-direct', 'excel', 'textscan', 'csv', 'ogrdirect', 'pdf', 'json', 'jsonfile', 'statfile', 'spss', 'sas', 'r', 'access', 'msaccess']);
const EXTRACT_CLASSES = new Set(['hyper', 'dataengine']);
const LEAF_TYPES = new Set(['table', 'text', 'stored-proc']);
const JOIN_TYPES = new Set(['inner', 'left', 'right', 'full']);
const COMPARISON = new Set(['=', '==', '<>', '!=', '<', '>', '<=', '>=']);
const INFIX = new Set([...COMPARISON, '+', '-', '*', '/', '%', 'AND', 'OR', '&&', '||']);
// A sqlproxy connection lists the published datasource's measure-role fields as class='measure' records.
const RECORD_CLASSES = new Set(['column', 'measure']);

/**
 * Connection attributes with credentials removed.
 * @param {XmlNode} node <connection>
 * @param {string} id
 * @returns {ConnectionIR}
 */
export function parseConnection(node, id) {
	/** @type {ConnectionIR} */
	const conn = { id, class: node.attr('class') || 'unknown', extra: {} };
	for (const [key, value] of Object.entries(node.attrs)) {
		if (SENSITIVE_NAME.test(key) || SENSITIVE_VALUE.test(value)) continue;
		if (CORE_ATTRS.includes(key)) {
			if (key !== 'class' && value !== '') conn[key] = value;
		} else if (value !== '') {
			conn.extra[key] = value;
		}
	}
	return conn;
}

/** Tableau escapes literal '<' and '>' in custom SQL by doubling them; '<[Parameters].[X]>' is a parameter. */
export function decodeCustomSql(text) {
	return String(text ?? '')
		.replace(/\r\n?/g, '\n')
		.replace(/<</g, '<')
		.replace(/>>/g, '>')
		.trim();
}

function expressionText(expr) {
	if (!expr) return '';
	const op = expr.attr('op') ?? '';
	const children = expr.all('expression');
	if (!children.length) return op;
	const parts = children.map(expressionText);
	if (INFIX.has(op.toUpperCase()) && parts.length > 1) return `(${parts.join(` ${op} `)})`;
	return `${op}(${parts.join(', ')})`;
}

/**
 * Join / relationship conditions from an <expression> tree.
 * @param {XmlNode|undefined} expr
 * @returns {JoinCondition[]}
 */
export function parseConditions(expr) {
	if (!expr) return [];
	const op = expr.attr('op') ?? '';
	const children = expr.all('expression');
	if ((op.toUpperCase() === 'AND' || op === '&&') && children.length) return children.flatMap(parseConditions);
	if (COMPARISON.has(op) && children.length === 2) {
		const cond = { left: expressionText(children[0]), right: expressionText(children[1]) };
		if (op !== '=' && op !== '==') cond.op = op;
		return [cond];
	}
	return [];
}

function isLeaf(rel) {
	const type = rel.attr('type');
	return LEAF_TYPES.has(type) || (!type && !rel.child('relation'));
}

function collectLeaves(rel, out = []) {
	if (isLeaf(rel)) out.push(rel);
	else for (const child of rel.all('relation')) collectLeaves(child, out);
	return out;
}

function textOf(rec, name) {
	return rec.childText(name);
}

/**
 * @param {XmlNode|undefined} conn
 * @returns {Array<MetadataRecord & { objectId?: string, parentName?: string }>}
 */
function readRecords(conn) {
	const out = [];
	const seen = new Set();
	for (const rec of conn?.child('metadata-records')?.all('metadata-record') || []) {
		if (rec.attr('class') && !RECORD_CLASSES.has(rec.attr('class'))) continue;
		const localName = textOf(rec, 'local-name');
		if (!localName || seen.has(localName)) continue;
		seen.add(localName);
		const ordinal = textOf(rec, 'ordinal');
		out.push({
			remoteName: textOf(rec, 'remote-name') ?? stripBrackets(localName),
			localName,
			localType: normalizeDatatype(textOf(rec, 'local-type')),
			remoteType: textOf(rec, 'remote-type'),
			ordinal: ordinal !== undefined && ordinal !== '' ? Number(ordinal) : undefined,
			aggregation: textOf(rec, 'aggregation'),
			collation: rec.child('collation')?.attr('name') || undefined,
			objectId: textOf(rec, 'object-id'),
			parentName: textOf(rec, 'parent-name')
		});
	}
	return out;
}

/**
 * Parse a <datasource> element (workbook-embedded or a .tds root).
 * @param {XmlNode} node
 * @param {{ issues?: Issue[] }} [ctx]
 * @returns {{ datasource: DatasourceIR, instances: Map<string,string> }}
 */
export function parseDatasourceNode(node, ctx = {}) {
	const issues = ctx.issues || [];
	const id = node.attr('name') || node.attr('caption') || 'datasource';
	const caption = node.attr('caption') || node.attr('formatted-name') || id;
	const object = { type: 'datasource', name: caption, id };

	const main = node.child('connection');
	/** @type {ConnectionIR[]} */
	const connections = [];
	if (main) {
		if (main.attr('class') === 'federated') {
			for (const nc of main.child('named-connections')?.all('named-connection') || []) {
				const inner = nc.child('connection');
				if (!inner) continue;
				const conn = parseConnection(inner, nc.attr('name') || `connection${connections.length + 1}`);
				if (nc.attr('caption')) conn.extra.caption = nc.attr('caption');
				connections.push(conn);
			}
		} else {
			connections.push(parseConnection(main, 'default'));
		}
	}
	const defaultConnectionId = connections.length === 1 ? connections[0].id : undefined;

	/** @type {TableIR[]} */
	const tables = [];
	const usedIds = new Set();
	const uniqueId = (base) => {
		let candidate = base || `table${tables.length + 1}`;
		for (let n = 2; usedIds.has(candidate); n++) candidate = `${base} (${n})`;
		usedIds.add(candidate);
		return candidate;
	};
	const makeTable = (rel, tableId, name) => {
		const connectionId = rel?.attr('connection') || defaultConnectionId || (main && main.attr('class') !== 'federated' ? 'default' : undefined);
		const conn = connections.find((c) => c.id === connectionId);
		const type = rel?.attr('type');
		let kind = 'table';
		if (type === 'text') kind = 'custom-sql';
		else if (conn && FILE_CLASSES.has(conn.class)) kind = 'file';
		else if (conn && EXTRACT_CLASSES.has(conn.class)) kind = 'extract';
		/** @type {TableIR} */
		const table = { id: tableId, name: name || tableId, kind: /** @type {TableIR['kind']} */ (kind), columns: [] };
		if (connectionId) table.connectionId = connectionId;
		if (rel?.attr('name') && rel.attr('name') !== table.name) table.relation = rel.attr('name');
		if (rel?.attr('table')) table.table = rel.attr('table');
		if (type === 'text') {
			table.sql = decodeCustomSql(rel.text);
			if (/<\[Parameters\]\./.test(table.sql)) {
				issues.push({
					severity: 'warning',
					code: 'twb.custom-sql-parameter',
					message: `Custom SQL "${table.name}" in "${caption}" references Tableau parameters; the current value must be substituted`,
					object
				});
			}
		}
		const fallback = rel?.child('columns')?.all('column') || [];
		table._fallbackColumns = fallback.map((c) => ({
			remoteName: c.attr('name'),
			localName: `[${c.attr('name')}]`,
			tableId,
			localType: normalizeDatatype(c.attr('datatype')),
			...(c.attr('ordinal') !== undefined ? { ordinal: Number(c.attr('ordinal')) } : {})
		}));
		usedIds.add(tableId);
		tables.push(table);
		return table;
	};

	const leafIds = new Map();
	const toRelationNode = (rel) => {
		const type = rel.attr('type');
		if (isLeaf(rel)) return { type: type === 'text' ? 'custom-sql' : 'table', tableId: leafIds.get(rel) };
		const children = rel.all('relation').map(toRelationNode);
		if (type === 'join') {
			const join = String(rel.attr('join') || 'inner').toLowerCase();
			return {
				type: 'join',
				join: JOIN_TYPES.has(join) ? join : 'inner',
				on: parseConditions(rel.child('clause')?.child('expression')),
				children
			};
		}
		if (children.length === 1) return children[0];
		return { type: 'union', children };
	};
	const addTree = (rel) => {
		const leaves = collectLeaves(rel);
		for (const leaf of leaves) {
			const tableId = uniqueId(leaf.attr('name'));
			leafIds.set(leaf, tableId);
			makeTable(leaf, tableId, leaf.attr('name'));
		}
		return { tree: toRelationNode(rel), first: leafIds.get(leaves[0]) };
	};

	/** @type {RelationNode|undefined} */
	let relationTree;
	const relationships = [];
	const graph = node.child('object-graph');
	const objects = graph?.child('objects')?.all('object') || [];
	if (objects.length) {
		const alias = new Map();
		for (const obj of objects) {
			const objId = obj.attr('id') || obj.attr('caption');
			const props = obj.all('properties');
			const rel = (props.find((p) => (p.attr('context') ?? '') === '') || props[0])?.child('relation');
			const objCaption = obj.attr('caption') || rel?.attr('name') || objId;
			if (!rel || isLeaf(rel)) {
				alias.set(objId, makeTable(rel, uniqueId(objId), objCaption).id);
			} else {
				const { tree, first } = addTree(rel);
				alias.set(objId, first);
				if (!relationTree) relationTree = tree;
				issues.push({
					severity: relationTree === tree ? 'info' : 'warning',
					code: 'twb.object-join',
					message: `Logical table "${objCaption}" in "${caption}" is built from a physical join/union`,
					object
				});
			}
		}
		for (const rel of graph.child('relationships')?.all('relationship') || []) {
			const from = rel.child('first-end-point')?.attr('object-id');
			const to = rel.child('second-end-point')?.attr('object-id');
			if (!from || !to) continue;
			relationships.push({
				fromTableId: alias.get(from) || from,
				toTableId: alias.get(to) || to,
				on: parseConditions(rel.child('expression'))
			});
		}
	} else {
		const rel = main?.child('relation');
		if (rel) {
			if (isLeaf(rel)) makeTable(rel, uniqueId(rel.attr('name')), rel.attr('name'));
			else if (rel.attr('type') === 'collection') {
				for (const child of rel.all('relation')) {
					if (isLeaf(child)) makeTable(child, uniqueId(child.attr('name')), child.attr('name'));
					else relationTree ||= addTree(child).tree;
				}
			} else relationTree = addTree(rel).tree;
		}
	}

	const extractNode = node.child('extract');
	let records = readRecords(main);
	if (!records.length && extractNode) records = readRecords(extractNode.child('connection'));
	const tableIds = new Set(tables.map((t) => t.id));
	const resolveTableId = (objectId, parentName) => {
		const o = objectId ? stripBrackets(objectId) : undefined;
		const p = parentName ? stripBrackets(parentName) : undefined;
		if (o && tableIds.has(o)) return o;
		if (p && tableIds.has(p)) return p;
		const byName = p && tables.find((t) => t.name === p);
		if (byName) return byName.id;
		if (tables.length === 1) return tables[0].id;
		return o || p;
	};
	/** @type {MetadataRecord[]} */
	const physical = records.map(({ objectId, parentName, ...rec }) => {
		const tableId = resolveTableId(objectId, parentName);
		return { ...rec, ...(tableId ? { tableId } : {}) };
	});
	for (const table of tables) {
		const own = physical.filter((r) => r.tableId === table.id);
		table.columns = (own.length ? own : table._fallbackColumns).map((r) => {
			const col = { remoteName: r.remoteName, localName: r.localName, tableId: table.id, localType: r.localType };
			if (r.remoteType !== undefined) col.remoteType = r.remoteType;
			if (r.ordinal !== undefined && !Number.isNaN(r.ordinal)) col.ordinal = r.ordinal;
			return col;
		});
		delete table._fallbackColumns;
	}

	const extract = parseExtract(extractNode, connections);

	let published;
	const repo = node.child('repository-location');
	const proxy = connections.find((c) => c.class === 'sqlproxy');
	if (repo || proxy) {
		published = {};
		if (repo?.attr('id')) published.repositoryId = repo.attr('id');
		else if (proxy?.dbname) published.repositoryId = proxy.dbname;
		if (repo?.attr('path')) published.path = repo.attr('path');
		if (repo?.attr('site')) published.site = repo.attr('site');
		published.name = proxy?.extra['server-ds-friendly-name'] || caption;
		issues.push({
			severity: 'info',
			code: 'twb.published-datasource',
			message: `"${caption}" is a published Tableau datasource (${published.repositoryId || 'unknown id'})`,
			object
		});
	}

	const colsMap = new Map();
	for (const map of main?.child('cols')?.all('map') || []) {
		const parts = splitBracketParts(map.attr('value'));
		if (!map.attr('key') || !parts) continue;
		const remoteName = stripBrackets(`[${parts.at(-1)}]`);
		const tableId = parts.length > 1 ? resolveTableId(undefined, `[${parts[0]}]`) : undefined;
		colsMap.set(map.attr('key'), { ...(tableId ? { tableId } : {}), remoteName });
	}

	const instances = new Map();
	for (const ci of node.all('column-instance')) if (ci.attr('name') && ci.attr('column')) instances.set(ci.attr('name'), ci.attr('column'));

	const fields = new Map();
	for (const rec of [...physical].sort((a, b) => (a.ordinal ?? 1e9) - (b.ordinal ?? 1e9))) {
		if (!fields.has(rec.localName)) fields.set(rec.localName, fieldFromRecord(rec));
	}
	const fiscalYearStart = datasourceFiscalStart(node);
	const fieldFiscalStarts = new Map();
	for (const col of node.all('column')) {
		const colId = col.attr('name');
		if (!colId) continue;
		const own = fiscalMonth(col.attr('fiscal-year-start'));
		if (own) fieldFiscalStarts.set(colId, own);
		const field = fieldFromColumn(col, fields.get(colId), { colsMap });
		if (field) fields.set(colId, field);
		else fields.delete(colId);
	}
	for (const field of fields.values()) {
		if (field.datatype === 'date' || field.datatype === 'datetime') field.fiscalYearStart = fieldFiscalStarts.get(field.id) ?? fiscalYearStart;
	}
	const unknown = [];
	for (const group of node.all('group')) {
		const field = fieldFromGroup(group, instances, unknown);
		if (field) fields.set(field.id, field);
	}
	if (unknown.length) {
		issues.push({ severity: 'warning', code: 'twb.unknown-groupfilter', message: `Sets in "${caption}" use unsupported groupfilter function(s): ${[...new Set(unknown)].join(', ')}`, object });
	}

	const resolvePill = (column) => {
		const parts = splitBracketParts(column);
		if (parts && parts.length > 1 && parts[0] === id) return parsePillId(column, instanceAttrs(node, `[${parts.slice(1).join('].[')}]`));
		if (parts && parts.length > 1 && parts[0] !== '__tableau_internal_object_id__') return parsePillId(column);
		return parsePillId(`[${id}].${column}`, instanceAttrs(node, column));
	};
	const filters = node.all('filter').flatMap((f) => parseFilter(f, { resolvePill, defaultDatasourceId: id, issues, scope: caption }));

	/** @type {DatasourceIR} */
	const datasource = { id, caption, connections, tables, relationships, fields: [...fields.values()], filters, fiscalYearStart };
	if (published) datasource.published = published;
	if (extract) datasource.extract = extract;
	if (relationTree) datasource.relationTree = relationTree;
	const hierarchies = parseHierarchies(node);
	if (hierarchies.length) datasource.hierarchies = hierarchies;
	return { datasource, instances };
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** A month name (`<date-options>`) or number (a column's own setting); a column's '0' inherits, so it reads as unset. */
export function fiscalMonth(raw) {
	const text = String(raw ?? '').trim().toLowerCase();
	const named = MONTH_NAMES.indexOf(text);
	if (named >= 0) return named + 1;
	const n = /^\d+$/.test(text) ? Number(text) : NaN;
	return n >= 1 && n <= 12 ? n : undefined;
}

export function datasourceFiscalStart(node) {
	return fiscalMonth(node.path('overridable-settings/date-options')?.attr('fiscal-year-start')) ?? fiscalMonth(node.child('date-options')?.attr('fiscal-year-start')) ?? 1;
}

/** Hierarchies (`<drill-paths>`), top level first; a path with fewer than two fields cannot drill. */
export function parseHierarchies(node) {
	return (node.child('drill-paths')?.all('drill-path') ?? [])
		.map((path) => ({ name: path.attr('name') ?? '', fields: path.all('field').map((f) => f.textContent().trim()).filter(Boolean) }))
		.filter((h) => h.fields.length > 1);
}

function instanceAttrs(node, name) {
	const ci = node.all('column-instance').find((c) => c.attr('name') === name);
	return ci ? { column: ci.attr('column'), derivation: ci.attr('derivation'), type: ci.attr('type') } : {};
}

function normalizePackagePath(p) {
	return String(p).replace(/\\/g, '/');
}

function parseExtract(extractNode, connections) {
	const hyperFiles = [];
	let enabled = false;
	if (extractNode) {
		enabled = extractNode.attr('enabled') !== 'false';
		const conn = extractNode.child('connection');
		if (conn?.attr('dbname')) hyperFiles.push(normalizePackagePath(conn.attr('dbname')));
	}
	for (const c of connections) {
		if (EXTRACT_CLASSES.has(c.class) && c.dbname) {
			hyperFiles.push(normalizePackagePath(c.dbname));
			enabled = true;
		}
	}
	if (!extractNode && !hyperFiles.length) return undefined;
	return { enabled, hyperFiles: [...new Set(hyperFiles)] };
}

/**
 * Parse a <datasource> element into a DatasourceIR.
 * @param {XmlNode} node
 * @param {{ issues?: Issue[] }} [ctx]
 * @returns {DatasourceIR}
 */
export function parseDatasource(node, ctx = {}) {
	return parseDatasourceNode(node, ctx).datasource;
}
