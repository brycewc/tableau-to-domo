import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TableauClient } from '../../src/tableau/client.js';
import { fetchWorkbookMetadata, applyMetadata } from '../../src/tableau/metadata.js';
import { installFetch, jsonResponse, signinBody, baseConfig } from './mock-fetch.js';

let mock;
afterEach(() => mock?.restore());

const newClient = () => new TableauClient({ ...baseConfig, apiVersion: '3.24' });

test('fetchWorkbookMetadata falls back to embeddedDataSources when the schema rejects the field', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /graphql$/, (call) => {
			const { query, variables } = JSON.parse(call.body);
			assert.equal(variables.luid, 'w1');
			if (query.includes('embeddedDatasources')) {
				return jsonResponse({ errors: [{ message: "Validation error of type FieldUndefined: Field 'embeddedDatasources' in type 'Workbook' is undefined" }] });
			}
			return { data: { workbooks: [{ luid: 'w1', embeddedDataSources: [{ name: 'Orders' }] }] } };
		}]
	]);
	const wb = await fetchWorkbookMetadata(newClient(), 'w1');
	assert.deepEqual(wb.embeddedDatasources, [{ name: 'Orders' }]);
	assert.equal(wb.embeddedDataSources, undefined);
});

test('fetchWorkbookMetadata retries with the slim query on NODE_LIMIT_EXCEEDED', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /graphql$/, (call) => {
			const { query } = JSON.parse(call.body);
			if (query.includes('T2DWorkbookSlim')) return { data: { workbooks: [{ luid: 'w1', embeddedDatasources: [] }] } };
			return jsonResponse({ data: { workbooks: [] }, errors: [{ message: 'partial', extensions: { code: 'NODE_LIMIT_EXCEEDED' } }] });
		}]
	]);
	const wb = await fetchWorkbookMetadata(newClient(), 'w1');
	assert.equal(wb.luid, 'w1');
});

test('fetchWorkbookMetadata returns null when the workbook is not in the catalog and throws on other errors', async () => {
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /graphql$/, () => ({ data: { workbooks: [] } })]
	]);
	assert.equal(await fetchWorkbookMetadata(newClient(), 'w1'), null);
	mock.restore();
	mock = installFetch([
		['POST', /signin$/, () => signinBody()],
		['POST', /graphql$/, () => jsonResponse({ errors: [{ message: 'Permission denied', extensions: { code: 'PERMISSION_DENIED' } }] })]
	]);
	await assert.rejects(fetchWorkbookMetadata(newClient(), 'w1'), /Permission denied/);
});

function sampleIr() {
	return {
		irVersion: 1,
		workbook: { name: 'Sales', sourceFile: 'x.twbx' },
		datasources: [
			{
				id: 'federated.abc',
				caption: 'Orders',
				connections: [{ id: 'c', class: 'snowflake', extra: {} }],
				tables: [], relationships: [], filters: [],
				fields: [
					{ id: '[Calculation_1]', name: 'Profit Ratio', datatype: 'real', role: 'measure', kind: 'calculated' },
					{ id: '[Calculation_2]', name: 'Has Formula', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'KEEP' },
					{ id: '[Region]', name: 'Region', datatype: 'string', role: 'dimension', kind: 'column', physical: { remoteName: 'REGION' } }
				]
			},
			{
				id: 'sqlproxy.xyz',
				caption: 'Superstore (published)',
				published: { repositoryId: 'superstore', name: 'Superstore' },
				connections: [{ id: 'default', class: 'sqlproxy', extra: {} }],
				tables: [], relationships: [], filters: [], fields: []
			}
		],
		parameters: [], worksheets: [], dashboards: [], issues: []
	};
}

const sampleMetadata = {
	luid: 'w1',
	projectName: 'Finance',
	embeddedDatasources: [
		{
			name: 'Orders',
			upstreamDatasources: [],
			fields: [
				{ name: 'Profit Ratio', __typename: 'CalculatedField', formula: 'SUM([Profit])/SUM([Sales])' },
				{ name: 'Has Formula', __typename: 'CalculatedField', formula: 'OTHER' },
				{ name: 'Region', __typename: 'ColumnField' }
			],
			upstreamTables: [{ name: 'ORDERS', schema: 'PUBLIC', fullName: '[PUBLIC].[ORDERS]', connectionType: 'snowflake', database: { name: 'SALES_DB' } }],
			upstreamDatabases: [{ name: 'SALES_DB', connectionType: 'snowflake' }]
		},
		{
			name: 'Superstore (published)',
			upstreamDatasources: [{ luid: 'ds-luid-1', name: 'Superstore' }],
			fields: []
		}
	]
};

test('applyMetadata fills formulas, published luids and upstream issues', () => {
	const ir = applyMetadata(sampleIr(), sampleMetadata);
	const [orders, published] = ir.datasources;
	assert.equal(orders.fields[0].formula, 'SUM([Profit])/SUM([Sales])');
	assert.equal(orders.fields[1].formula, 'KEEP');
	assert.equal(orders.fields[2].formula, undefined);
	assert.equal(published.published.luid, 'ds-luid-1');
	assert.equal(ir.workbook.luid, 'w1');
	assert.equal(ir.workbook.projectName, 'Finance');
	const upstream = ir.issues.find((i) => i.code === 'metadata.upstream');
	assert.equal(upstream.severity, 'info');
	assert.match(upstream.message, /SALES_DB \(snowflake\)/);
	assert.match(upstream.message, /SALES_DB\.\[PUBLIC\]\.\[ORDERS\]/);
	const count = ir.issues.length;
	applyMetadata(ir, sampleMetadata);
	assert.equal(ir.issues.length, count);
});

test('applyMetadata tolerates missing or malformed metadata', () => {
	const ir = sampleIr();
	assert.equal(applyMetadata(ir, null), ir);
	applyMetadata(ir, { embeddedDatasources: [null, { fields: null }] });
	applyMetadata(ir, { embeddedDataSources: { name: 'Orders', fields: { name: 'Profit Ratio', __typename: 'CalculatedField', formula: 'X' } } });
	assert.equal(ir.datasources[0].fields[0].formula, 'X');
});
