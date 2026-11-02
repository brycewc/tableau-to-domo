import { stripBrackets } from '../model/naming.js';

/**
 * Tableau connection class -> Domo connector stream.
 *
 * Provider keys come from `GET /data/v1/providers`; connector ids, major versions and the configuration
 * names below were read from the instance's connector descriptors (`GET /data/v1/connectors/{id}`, `view`
 * fields) and from streams created in the Domo UI (`GET /data/v1/streams/{id}?fields=all`). At push time a
 * stream of the same provider on the target instance, when one exists, supplies the transport and any
 * configuration defaults not set here.
 *
 * @typedef {'ansi'|'tsql'|'mysql'|'bigquery'} Dialect
 *
 * @typedef {Object} ConnectorSpec
 * @property {string} providerKey
 * @property {boolean} verified          configuration names confirmed against a connector descriptor or stream
 * @property {Dialect} dialect
 * @property {string} label
 * @property {string} [connectorId]      transport.description
 * @property {string} [connectorVersion] transport.version (latest major seen; push prefers the live descriptor)
 * @property {string} [manual]           Set when the connector is object based and the stream must be configured by hand
 * @property {(conn: import('../model/types.js').ConnectionIR, query: string) => Record<string, string|undefined>} config
 */

const COMMON = { 'updatemode.mode': 'Replace', 'retry.retryNumber': '0' };

/** @type {Record<string, ConnectorSpec>} */
const CONNECTORS = {
	snowflake: {
		providerKey: 'snowflakekeypairauthentication',
		connectorId: 'com.domo.connector.snowflakekeypairauthentication',
		connectorVersion: '0',
		verified: true,
		dialect: 'ansi',
		label: 'Snowflake',
		config: (c, query) => ({
			query,
			warehouseName: c.warehouse,
			databaseName: c.dbname,
			schemaName: c.schema,
			queryTag: '',
			fetchSize: '1000',
			convertColumnsToString: '',
			convertTimeZone: 'UTC',
			schemaModificationProtection: 'ignore',
			schemaAdditionProtection: 'ignore',
			schemaDeleteProtection: 'ignore',
			...COMMON,
			cloud: 'domo',
			_description_: ''
		})
	},
	sqlserver: {
		providerKey: 'ms-sql-server',
		connectorId: 'com.domo.connector.mssql',
		connectorVersion: '3',
		verified: true,
		dialect: 'tsql',
		label: 'Microsoft SQL Server',
		config: (c, query) => ({ query, ...COMMON })
	},
	azure_sql_db: {
		providerKey: 'ms-sql-server',
		connectorId: 'com.domo.connector.mssql',
		connectorVersion: '3',
		verified: true,
		dialect: 'tsql',
		label: 'Azure SQL Database (SQL Server connector)',
		config: (c, query) => ({ query, ...COMMON })
	},
	postgres: {
		providerKey: 'postgresql',
		connectorId: 'com.domo.connector.postgresql',
		verified: false,
		dialect: 'ansi',
		label: 'PostgreSQL',
		config: (c, query) => ({ query, ...COMMON })
	},
	mysql: {
		providerKey: 'mysql',
		connectorId: 'com.domo.connector.mysql',
		connectorVersion: '6',
		verified: true,
		dialect: 'mysql',
		label: 'MySQL',
		config: (c, query) => ({
			queryType: 'customQuery',
			query,
			addQueryParameter: 'false',
			queryParameter: '',
			tinyIsBit: 'yes',
			castBooleanTo: 'string',
			useCompression: 'false',
			...COMMON,
			cloud: 'domo',
			_description_: ''
		})
	},
	redshift: {
		providerKey: 'amazon-redshift',
		connectorId: 'com.domo.connector.redshift.l1',
		connectorVersion: '1',
		verified: true,
		dialect: 'ansi',
		label: 'Amazon Redshift',
		config: (c, query) => ({ query, includeSchemaName: 'false', booleanFormat: 'true/false', ...COMMON })
	},
	bigquery: {
		providerKey: 'google-bigquery-service',
		connectorId: 'com.domo.connector.googlebigqueryservice',
		connectorVersion: '0',
		verified: true,
		dialect: 'bigquery',
		label: 'Google BigQuery',
		config: (c, query) => ({
			report: 'run_query',
			queryType: 'standard',
			query,
			queryParameter: '',
			allowLargeResults: 'false',
			location: '',
			maxResults: '10000',
			use_bigquery_schema: 'false',
			...COMMON,
			cloud: 'domo',
			_description_: ''
		})
	},
	oracle: {
		providerKey: 'OracleDB',
		connectorId: 'com.domo.connector.oracledb',
		connectorVersion: '0',
		verified: true,
		dialect: 'ansi',
		label: 'Oracle Database',
		config: (c, query) => ({ QueryType: 'query', query, ...COMMON })
	},
	databricks: {
		providerKey: 'databricks-pat',
		verified: false,
		dialect: 'mysql',
		label: 'Databricks',
		config: (c, query) => ({ queryType: 'customQuery', query, ...COMMON })
	},
	salesforce: {
		providerKey: 'salesforce',
		connectorId: 'com.domo.connector.salesforce',
		verified: false,
		dialect: 'ansi',
		label: 'Salesforce',
		manual: 'The Salesforce connector reads objects and reports, not SQL, so Tableau Salesforce tables cannot be mapped to a stream automatically.',
		config: () => ({})
	},
	teradata: {
		providerKey: 'teradata-tile',
		verified: false,
		dialect: 'ansi',
		label: 'Teradata',
		config: (c, query) => ({ query, ...COMMON })
	}
};

/** Static connector defaults for a family. */
export function connectorSpec(family) {
	return CONNECTORS[family];
}

/**
 * Tableau connection class whose default Domo provider is `providerKey`, for mappings.json snippets.
 * @param {string} providerKey
 * @returns {string|undefined}
 */
export function tableauClassForProvider(providerKey) {
	const key = String(providerKey ?? '').toLowerCase();
	return Object.entries(CONNECTORS).find(([, spec]) => spec.providerKey.toLowerCase() === key)?.[0];
}

const CLASS_ALIASES = {
	'snowflake': 'snowflake',
	'sqlserver': 'sqlserver',
	'azure_sql_db': 'azure_sql_db',
	'azure-sql-db': 'azure_sql_db',
	'azuresqldb': 'azure_sql_db',
	'postgres': 'postgres',
	'postgresql': 'postgres',
	'mysql': 'mysql',
	'mariadb': 'mysql',
	'memsql': 'mysql',
	'redshift': 'redshift',
	'bigquery': 'bigquery',
	'google-bigquery': 'bigquery',
	'bigquery-jdbc': 'bigquery',
	'oracle': 'oracle',
	'databricks': 'databricks',
	'spark': 'databricks',
	'teradata': 'teradata',
	'salesforce': 'salesforce'
};

/**
 * Normalized connector family for a Tableau connection class, or undefined when
 * there is no Domo connector equivalent.
 * @param {string} connectionClass
 */
export function connectorFamily(connectionClass) {
	return CLASS_ALIASES[String(connectionClass ?? '').toLowerCase()];
}

/** @param {string} connectionClass */
export function isConnectorClass(connectionClass) {
	return Boolean(connectorFamily(connectionClass));
}

function normalize(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

/**
 * Most specific `mappings.accounts` entry whose every `match` key equals the
 * connection's value (case-insensitive). Class compares by connector family.
 * @param {import('../model/types.js').ConnectionIR} connection
 * @param {import('../model/types.js').Mappings} [mappings]
 */
export function findAccount(connection, mappings) {
	let best = null;
	let bestScore = -1;
	for (const account of mappings?.accounts ?? []) {
		const match = account?.match ?? {};
		let ok = true;
		let score = 0;
		for (const [key, wanted] of Object.entries(match)) {
			if (wanted === undefined || wanted === null || wanted === '') continue;
			const actual = connection?.[key] ?? connection?.extra?.[key];
			const equal =
				key === 'class'
					? (connectorFamily(wanted) ?? normalize(wanted)) === (connectorFamily(actual) ?? normalize(actual))
					: normalize(wanted) === normalize(actual);
			if (!equal) {
				ok = false;
				break;
			}
			score++;
		}
		if (ok && score > bestScore) {
			best = account;
			bestScore = score;
		}
	}
	return best;
}

/** Bracketed Tableau relation '[dbo].[Orders]' -> ['dbo', 'Orders']. */
export function relationParts(table) {
	const text = String(table ?? '').trim();
	if (!text) return [];
	const parts = [];
	const re = /\[((?:[^\]]|\]\])*)\]/g;
	let match;
	while ((match = re.exec(text))) parts.push(match[1].replace(/\]\]/g, ']'));
	if (parts.length) return parts;
	return text.split('.').map((p) => stripBrackets(p.trim()));
}

/**
 * @param {string} name
 * @param {Dialect} dialect
 */
export function quoteIdentifier(name, dialect) {
	switch (dialect) {
		case 'tsql':
			return `[${name.replace(/\]/g, ']]')}]`;
		case 'mysql':
		case 'bigquery':
			return `\`${name.replace(/`/g, '``')}\``;
		default:
			return `"${name.replace(/"/g, '""')}"`;
	}
}

/**
 * Connector query for one Tableau table: custom SQL verbatim, otherwise SELECT *.
 * @param {import('../model/types.js').TableIR} table
 * @param {Dialect} dialect
 * @param {import('../model/types.js').ConnectionIR} [connection]
 */
export function buildQuery(table, dialect, connection) {
	if (table.kind === 'custom-sql' && table.sql) return table.sql.trim();
	let parts = relationParts(table.table || table.name);
	if (parts.length === 1 && connection?.schema) parts = [connection.schema, ...parts];
	return `SELECT * FROM ${parts.map((p) => quoteIdentifier(p, dialect)).join('.')}`;
}

/**
 * Plan a Domo connector stream that re-creates one Tableau table from its live source.
 *
 * @param {import('../model/types.js').DatasourceIR} datasource
 * @param {import('../model/types.js').ConnectionIR} connection
 * @param {import('../model/types.js').Mappings} [mappings]
 * @param {{ table?: import('../model/types.js').TableIR, session?: { dbname?: string, schema?: string, warehouse?: string } }} [opts]
 *   `table`: the table to query (default: the datasource's first table); `session`: database, schema and warehouse an
 *   Initial SQL USE statement switched to, for the stream settings only
 * @returns {{ connector: (import('../model/types.js').ConnectorPlan & { accountId: string|number|null, unverified: string[] })|null, issues: import('../model/types.js').Issue[] }}
 */
export function planConnector(datasource, connection, mappings, { table, session } = {}) {
	const issues = [];
	const object = { type: 'datasource', name: datasource.caption || datasource.id, id: datasource.id };
	const family = connectorFamily(connection?.class);
	if (!family) {
		issues.push({
			severity: 'error',
			code: 'data.connector-unsupported',
			message: `No Domo connector mapping for Tableau connection class '${connection?.class ?? 'unknown'}'.`,
			object,
			suggestion: 'Use the hyper, published-extract, vds or view-csv data strategy, or map the datasource to an existing Domo dataset.'
		});
		return { connector: null, issues };
	}
	const spec = CONNECTORS[family];
	const accountMatch = {
		class: connection.class,
		...(connection.server ? { server: connection.server } : {}),
		...(connection.dbname ? { dbname: connection.dbname } : {}),
		...(connection.warehouse ? { warehouse: connection.warehouse } : {})
	};
	if (spec.manual) {
		issues.push({
			severity: 'error',
			code: 'data.connector-manual',
			message: `${spec.manual}`,
			object,
			suggestion: `Create the ${spec.label} dataset in Domo, then map it in mappings.json datasets ("${datasource.caption || datasource.id}": "<Domo dataset id>").`
		});
		return { connector: null, issues };
	}
	const source = table ?? datasource.tables?.[0];
	const account = findAccount(connection, mappings);
	const providerKey = account?.providerKey || spec.providerKey;
	const sameProvider = providerKey === spec.providerKey;
	const unverified = [];
	if (!sameProvider) unverified.push(`configuration for provider '${providerKey}' (defaults are for '${spec.providerKey}'; a stream of that provider on the instance supplies the rest at push)`);
	else if (!spec.verified) unverified.push(`configuration names for '${providerKey}'`);
	if (!spec.connectorId && sameProvider) unverified.push('connector id (taken from a stream of this provider on the instance at push)');

	const query = source ? buildQuery(source, spec.dialect, connection) : '';
	const configuration = [];
	for (const [name, value] of Object.entries(spec.config(session ? { ...connection, ...session } : connection, query))) {
		if (value === undefined || value === null) continue;
		configuration.push({ name, value: String(value), type: 'string', category: 'METADATA' });
	}

	if (!account) {
		issues.push({
			severity: 'error',
			code: 'data.no-account',
			message: `No Domo account mapped for ${spec.label} connection ${connection.server || ''}${connection.dbname ? `/${connection.dbname}` : ''}.`,
			object,
			suggestion: `Find the account with \`t2d list accounts --provider ${providerKey}\`, then add to mappings.json accounts: { "match": ${JSON.stringify(accountMatch)}, "accountId": <Domo account id> }.`
		});
	}
	if (unverified.length) {
		issues.push({
			severity: 'info',
			code: 'data.connector-unverified',
			message: `${spec.label} connector stream settings not confirmed on a Domo instance: ${unverified.join(', ')}.`,
			object,
			suggestion: 'Compare with GET /data/v1/streams/{id}?fields=all of a stream created in the Domo UI for this connector, or set templateStreamId on the mappings.json account.'
		});
	}

	return {
		connector: {
			providerKey,
			accountMatch,
			accountId: account?.accountId ?? null,
			configuration,
			query,
			updateMethod: 'REPLACE',
			...(sameProvider && spec.connectorId
				? { defaultTransport: { providerKey: spec.providerKey, connectorId: spec.connectorId, ...(spec.connectorVersion ? { connectorVersion: spec.connectorVersion } : {}) } }
				: {}),
			unverified
		},
		issues
	};
}
