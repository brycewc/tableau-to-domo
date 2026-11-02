import fs from 'node:fs';
import { openWorkspace } from '../../pipeline/workspace.js';

export const name = 'mappings';
export const summary = 'Show where mappings.json lives and an example of its format';
export const usage = 't2d mappings [--init]';
export const options = {
	init: { type: 'boolean', description: 'Create an empty mappings.json if it does not exist' }
};

export const MAPPINGS_EXAMPLE = {
	datasets: {
		'Sample - Superstore': '00000000-0000-0000-0000-000000000000'
	},
	accounts: [
		{
			match: { class: 'snowflake', server: 'acme.snowflakecomputing.com' },
			accountId: 123,
			providerKey: 'snowflakekeypairauthentication'
		}
	],
	cloudAmplifier: [
		{
			match: { class: 'snowflake', server: 'acme.snowflakecomputing.com', dbname: 'ANALYTICS' },
			integrationId: '00000000-0000-0000-0000-000000000000'
		}
	],
	columns: {
		'Sample - Superstore.Order Date': 'order_date'
	}
};

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const ws = openWorkspace(config.workspace);
	let created = false;
	if (args.values.init) created = await ws.ensureMappings();
	const exists = fs.existsSync(ws.mappingsFile);
	const current = exists ? await ws.loadMappings() : null;
	reporter.print(`${ws.mappingsFile}${exists ? (created ? ' (created)' : '') : ' (does not exist yet; run with --init or extract a workbook)'}`);
	reporter.print('');
	reporter.print('datasets: Tableau datasource caption or luid -> existing Domo dataset id (strategy "existing")');
	reporter.print('accounts: connection match (class, server, dbname) -> Domo connector account id (strategy "connector")');
	reporter.print('cloudAmplifier: connection match (class, server, dbname) -> Cloud Amplifier integration id (strategy "cloud-amplifier"); integrationId false disables it, databases renames { tableau: warehouse }');
	reporter.print('columns:  "Datasource caption.Field name" -> Domo column name override');
	reporter.print('');
	reporter.print('Example:');
	reporter.print(JSON.stringify(MAPPINGS_EXAMPLE, null, '\t'));
	if (current) {
		reporter.print('');
		reporter.print(`Current: ${Object.keys(current.datasets).length} dataset(s), ${current.accounts.length} account(s), ${current.cloudAmplifier.length} Cloud Amplifier mapping(s), ${Object.keys(current.columns).length} column override(s)`);
	}
	return { file: ws.mappingsFile, exists, created, mappings: current, example: MAPPINGS_EXAMPLE };
}
