import { parseExpr, parseQuery } from './parser.js';
import { TranslateError, sfIdent, toSnowflake } from './expr.js';
import { snowflakeQueryText } from './sql-tile.js';

/**
 * Magic ETL dataflow definition -> one Snowflake query per output, a CTE per tile. For checking a translation (round
 * trip) and for small graphs a SQL view can serve.
 *
 * @typedef {Object} MagicToSqlOptions
 * @property {Record<string, { table: string, columns?: { name: string }[] }>} [inputs]  dataSourceId -> warehouse table
 *   (and its columns, which lets Add Formula tiles that overwrite a column be written exactly)
 *
 * @typedef {Object} MagicToSqlResult
 * @property {string} [sql]                          The first output's query
 * @property {{ name: string, sql: string }[]} outputs
 * @property {{ action: string, reason: string }[]} unsupported
 */

const quoteCte = (id) => `"${String(id).replace(/"/g, '""')}"`;
const col = (name) => sfIdent(name);
const formulaSql = (text) => toSnowflake(parseExpr(text, { formula: true }));

const GROUP_FUNCTIONS = {
	SUM: 'SUM', AVERAGE: 'AVG', AVG: 'AVG', MIN: 'MIN', MAX: 'MAX', COUNT_ALL: 'COUNT', COUNT: 'COUNT', COUNT_DISTINCT: 'COUNT(DISTINCT', FIRST: 'ANY_VALUE', LAST: 'ANY_VALUE', CONCAT_COMMA: 'LISTAGG'
};
const FILTER_OPS = { EQ: '=', NE: '<>', LT: '<', GT: '>', LE: '<=', GE: '>=', LTE: '<=', GTE: '>=' };

/**
 * @param {{ actions: object[] }} definition
 * @param {MagicToSqlOptions} [opts]
 * @returns {MagicToSqlResult}
 */
export function magicToSql(definition, opts = {}) {
	const actions = definition.actions ?? [];
	const byId = new Map(actions.map((a) => [a.id, a]));
	const cols = new Map();
	const ctes = new Map();
	const unsupported = [];
	const order = [];
	const done = new Set();
	const visit = (id) => {
		if (done.has(id)) return;
		done.add(id);
		const a = byId.get(id);
		if (!a) throw new TranslateError(`depends on missing action ${id}`);
		for (const d of a.dependsOn ?? []) visit(d);
		order.push(a);
	};
	for (const a of actions) if (a.type === 'PublishToVault') visit(a.id);

	for (const a of order) {
		try {
			const out = tileSql(a, { cols, byId, opts });
			if (out) {
				ctes.set(a.id, out.sql);
				cols.set(a.id, out.columns ?? null);
			}
		} catch (err) {
			if (!(err instanceof TranslateError) && err.name !== 'ParseError') throw err;
			unsupported.push({ action: a.id, reason: err.message });
		}
	}
	const outputs = [];
	for (const a of order.filter((x) => x.type === 'PublishToVault')) {
		const from = a.dependsOn?.[0];
		const needed = [];
		const seen = new Set();
		const need = (id) => {
			if (seen.has(id)) return;
			seen.add(id);
			for (const d of byId.get(id)?.dependsOn ?? []) need(d);
			if (ctes.has(id)) needed.push(id);
		};
		need(from);
		if (unsupported.some((u) => seen.has(u.action))) continue;
		const sql = `WITH ${needed.map((id) => `${quoteCte(id)} AS (\n  ${ctes.get(id)}\n)`).join(',\n')}\nSELECT * FROM ${quoteCte(from)}`;
		outputs.push({ name: a.dataSource?.name ?? a.name, sql });
	}
	return { sql: outputs[0]?.sql, outputs, unsupported };
}

function tileSql(a, { cols, byId, opts }) {
	const input = a.dependsOn?.[0];
	const from = input ? quoteCte(input) : undefined;
	const inCols = input ? cols.get(input) : null;
	switch (a.type) {
		case 'LoadFromVault': {
			const known = opts.inputs?.[a.dataSourceId];
			const table = known?.table ?? quoteCte(a.dataSourceId ?? a.name);
			return { sql: `SELECT * FROM ${table}`, columns: known?.columns?.map((c) => c.name) ?? null };
		}
		case 'PublishToVault':
			return null;
		case 'ExpressionEvaluator': {
			let sql = `SELECT * FROM ${from}`;
			let current = inCols ? [...inCols] : null;
			for (const e of a.expressions ?? []) {
				const value = formulaSql(e.expression);
				const exists = current?.includes(e.fieldName);
				sql = exists ? `SELECT * REPLACE (${value} AS ${col(e.fieldName)}) FROM (${sql})` : `SELECT *, ${value} AS ${col(e.fieldName)} FROM (${sql})`;
				if (current && !exists) current.push(e.fieldName);
			}
			return { sql, columns: current };
		}
		case 'SelectValues': {
			const fields = a.fields ?? a.select ?? [];
			return { sql: `SELECT ${fields.map((f) => (f.rename && f.rename !== f.name ? `${col(f.name)} AS ${col(f.rename)}` : col(f.name))).join(', ')} FROM ${from}`, columns: fields.map((f) => f.rename || f.name) };
		}
		case 'Metadata': {
			const fields = a.fields ?? [];
			const removed = fields.filter((f) => f.remove).map((f) => f.name);
			const renamed = fields.filter((f) => !f.remove && f.rename && f.rename !== f.name);
			if (fields.some((f) => f.type)) throw new TranslateError('changes column types in an Alter Columns tile');
			let sql = `SELECT *${removed.length ? ` EXCLUDE (${removed.map(col).join(', ')})` : ''}${renamed.length ? ` RENAME (${renamed.map((f) => `${col(f.name)} AS ${col(f.rename)}`).join(', ')})` : ''} FROM ${from}`;
			const columns = inCols ? inCols.filter((c) => !removed.includes(c)).map((c) => renamed.find((f) => f.name === c)?.rename ?? c) : null;
			return { sql, columns };
		}
		case 'Filter':
			return { sql: `SELECT * FROM ${from} WHERE ${filterCondition(a.filterList ?? [])}`, columns: inCols };
		case 'MergeJoin': {
			const l = quoteCte(a.step1);
			const r = quoteCte(a.step2);
			const type = { INNER: 'INNER JOIN', 'LEFT OUTER': 'LEFT OUTER JOIN', 'RIGHT OUTER': 'RIGHT OUTER JOIN', 'FULL OUTER': 'FULL OUTER JOIN' }[a.joinType];
			if (!type) throw new TranslateError(`uses join type ${a.joinType}`);
			const side = (mods, alias) => {
				const removed = (mods ?? []).filter((m) => m.remove).map((m) => m.name);
				const renamed = (mods ?? []).filter((m) => !m.remove && m.rename && m.rename !== m.name);
				return `${alias}.*${removed.length ? ` EXCLUDE (${removed.map(col).join(', ')})` : ''}${renamed.length ? ` RENAME (${renamed.map((m) => `${col(m.name)} AS ${col(m.rename)}`).join(', ')})` : ''}`;
			};
			const on = (a.keys1 ?? []).map((k, n) => `l.${col(k)} = r.${col(a.keys2[n])}`).join(' AND ') || 'TRUE';
			const lc = cols.get(a.step1);
			const rc = cols.get(a.step2);
			const columns = lc && rc ? [...applyMods(lc, a.schemaModification1), ...applyMods(rc, a.schemaModification2)] : null;
			return { sql: `SELECT ${side(a.schemaModification1, 'l')}, ${side(a.schemaModification2, 'r')} FROM ${l} AS l ${type} ${r} AS r ON ${on}`, columns };
		}
		case 'GroupBy': {
			const groups = (a.groups ?? []).map((g) => g.name);
			const fields = (a.fields ?? []).map((f) => `${groupField(f)} AS ${col(f.name)}`);
			if (a.giveBackRow || a.allRows || a.addLineNumber) throw new TranslateError('uses Group By options that keep every row');
			return { sql: `SELECT ${[...groups.map(col), ...fields].join(', ')} FROM ${from}${groups.length ? ` GROUP BY ${groups.map(col).join(', ')}` : ''}`, columns: [...groups, ...(a.fields ?? []).map((f) => f.name)] };
		}
		case 'WindowAction': {
			const partition = (a.groupRules ?? []).map((g) => col(g.column));
			const order = (a.orderRules ?? []).map((o) => `${col(o.column)}${o.ascending === false ? ' DESC' : ''}`);
			const over = (op) => {
				const parts = [partition.length ? `PARTITION BY ${partition.join(', ')}` : '', order.length ? `ORDER BY ${order.join(', ')}` : ''];
				if (op?.type === 'FRAMED') parts.push(`ROWS BETWEEN ${op.preceding === null || op.preceding === undefined ? 'UNBOUNDED' : Number(op.preceding)} PRECEDING AND ${op.following ? `${Number(op.following)} FOLLOWING` : 'CURRENT ROW'}`);
				return `OVER (${parts.filter(Boolean).join(' ')})`;
			};
			const adds = (a.additions ?? []).map((x) => `${windowCall(x.operation)} ${over(x.operation)} AS ${col(x.name)}`);
			return { sql: `SELECT *, ${adds.join(', ')} FROM ${from}`, columns: inCols ? [...inCols, ...(a.additions ?? []).map((x) => x.name)] : null };
		}
		case 'Unique': {
			const fields = (a.fields ?? []).map((f) => f.name);
			if (!fields.length) return { sql: `SELECT DISTINCT * FROM ${from}`, columns: inCols };
			return { sql: `SELECT * FROM ${from} QUALIFY ROW_NUMBER() OVER (PARTITION BY ${fields.map(col).join(', ')} ORDER BY NULL) = 1`, columns: inCols };
		}
		case 'UnionAll': {
			const parts = (a.dependsOn ?? []).map((d) => `SELECT * FROM ${quoteCte(d)}`);
			const allCols = (a.dependsOn ?? []).map((d) => cols.get(d));
			const columns = allCols.every(Boolean) ? [...new Set(allCols.flat())] : null;
			return { sql: parts.join(a.unionType === 'INCLUDE_ALL' || !a.unionType ? ' UNION ALL BY NAME ' : ' UNION ALL '), columns };
		}
		case 'Limit':
			return { sql: `SELECT * FROM ${from} LIMIT ${Number(a.limit)}${a.offset ? ` OFFSET ${Number(a.offset)}` : ''}`, columns: inCols };
		case 'SQL': {
			const statements = a.statements ?? [];
			if (statements.length !== 1) throw new TranslateError('has a SQL tile with several statements');
			const names = new Map((a.inputs ?? a.dependsOn ?? []).map((id) => [String(byId.get(id)?.name ?? id).toUpperCase(), quoteCte(id)]));
			const query = parseQuery(statements[0]);
			const sql = snowflakeQueryText(query, {
				table: (parts) => names.get(parts.map((p) => p.name).join('.').toUpperCase()) ?? names.get(parts.at(-1).name.toUpperCase())
			});
			return { sql, columns: null };
		}
		default:
			throw new TranslateError(`is a ${a.type} tile, which t2d does not translate to SQL`);
	}
}

function applyMods(columns, mods) {
	const out = [];
	for (const c of columns) {
		const m = (mods ?? []).find((x) => x.name === c);
		if (m?.remove) continue;
		out.push(m?.rename || c);
	}
	return out;
}

function groupField(f) {
	if (f.expression) return formulaSql(f.expression);
	const fn = GROUP_FUNCTIONS[f.type];
	if (!fn) throw new TranslateError(`uses the Group By aggregate ${f.type}`);
	if (f.type === 'COUNT_DISTINCT') return `COUNT(DISTINCT ${col(f.source)})`;
	if (f.type === 'COUNT_ALL') return 'COUNT(*)';
	if (f.type === 'CONCAT_COMMA') return `LISTAGG(${col(f.source)}, ',')`;
	return `${fn}(${col(f.source)})`;
}

function windowCall(op) {
	const t = op?.operationType;
	if (['ROW_NUMBER', 'RANK', 'DENSE_RANK'].includes(t)) return `${t}()`;
	if (op?.type === 'FRAMED' && ['SUM', 'AVERAGE', 'COUNT'].includes(t)) return `${t === 'AVERAGE' ? 'AVG' : t}(${col(op.column)})`;
	if (t === 'LAG' || t === 'LEAD') {
		const def = op.defaultValue === null || op.defaultValue === undefined ? '' : `, ${typeof op.defaultValue === 'number' ? op.defaultValue : `'${String(op.defaultValue).replace(/'/g, "''")}'`}`;
		return `${t}(${col(op.column)}, ${Number(op.amount ?? 1)}${def})`;
	}
	throw new TranslateError(`uses the window operation ${t}`);
}

function filterCondition(list) {
	const one = (f) => {
		if (f.expression) return `(${formulaSql(f.expression)})`;
		if (!f.leftField || !f.operator) throw new TranslateError('has a Filter rule t2d cannot read');
		const left = col(f.leftField);
		if (f.operator === 'NN') return `${left} IS NOT NULL`;
		if (f.operator === 'NL') return `${left} IS NULL`;
		const right = f.rightField ? col(f.rightField) : f.rightExpr ? formulaSql(f.rightExpr) : f.rightValue?.type === 'STRING' ? `'${String(f.rightValue.value).replace(/'/g, "''")}'` : String(f.rightValue?.value);
		const op = FILTER_OPS[f.operator];
		if (!op) throw new TranslateError(`uses the Filter operator ${f.operator}`);
		return `${left} ${op} ${right}`;
	};
	const clause = (f) => [one(f), ...(f.andFilterList ?? []).map(one)].join(' AND ');
	return list.map((f) => `(${clause(f)})`).join(' OR ') || 'TRUE';
}
