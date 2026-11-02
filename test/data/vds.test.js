import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportPublishedDatasource } from '../../src/tableau/data/vds.js';
import { exportViewCsv } from '../../src/tableau/data/view-csv.js';
import { tempDir } from './helpers.js';

const METADATA = {
	data: [
		{ fieldName: 'Region', fieldCaption: 'Region', dataType: 'STRING', columnClass: 'COLUMN' },
		{ fieldName: 'Sales', fieldCaption: 'Sales', dataType: 'REAL', columnClass: 'COLUMN' },
		{ fieldName: 'Qty', fieldCaption: 'Quantity', dataType: 'INTEGER', columnClass: 'COLUMN' },
		{ fieldName: 'Order Date', fieldCaption: 'Order Date', dataType: 'DATE', columnClass: 'COLUMN' },
		{ fieldName: 'Returned', fieldCaption: 'Returned', dataType: 'BOOLEAN', columnClass: 'COLUMN' },
		{ fieldName: 'Calculation_1', fieldCaption: 'Profit Ratio', dataType: 'REAL', columnClass: 'CALCULATION' },
		{ fieldName: 'Geo', fieldCaption: 'Geometry', dataType: 'SPATIAL', columnClass: 'COLUMN' }
	]
};

function stubClient(rows) {
	const calls = [];
	return {
		calls,
		async vds(endpoint, body) {
			calls.push({ endpoint, body });
			if (endpoint === 'read-metadata') return METADATA;
			if (endpoint === 'query-datasource') return { data: rows };
			throw new Error(`unexpected ${endpoint}`);
		}
	};
}

test('exportPublishedDatasource queries COLUMN fields and writes Domo CSV', async () => {
	const dir = tempDir();
	const out = path.join(dir, 'ds.csv');
	const client = stubClient([
		{ Region: 'East', Sales: 10.5, Quantity: 3, 'Order Date': '2024-01-02', Returned: true },
		{ Region: 'West, "far"', Sales: null, Quantity: 4, 'Order Date': null, Returned: false }
	]);
	const result = await exportPublishedDatasource(client, 'luid-1', out, { columnName: (f) => (f.fieldCaption === 'Quantity' ? 'Qty Sold' : undefined) });
	const query = client.calls.find((c) => c.endpoint === 'query-datasource').body;
	assert.deepEqual(query.datasource, { datasourceLuid: 'luid-1' });
	assert.deepEqual(
		query.query.fields.map((f) => f.fieldCaption),
		['Region', 'Sales', 'Quantity', 'Order Date', 'Returned']
	);
	assert.deepEqual(query.options, { returnFormat: 'OBJECTS', disaggregate: true });
	assert.deepEqual(
		result.columns.map((c) => [c.name, c.type]),
		[
			['Region', 'STRING'],
			['Sales', 'DOUBLE'],
			['Qty Sold', 'LONG'],
			['Order Date', 'DATE'],
			['Returned', 'STRING']
		]
	);
	assert.equal(result.rowCount, 2);
	assert.deepEqual(
		result.skipped.map((s) => s.caption),
		['Profit Ratio', 'Geometry']
	);
	assert.equal(
		fs.readFileSync(out, 'utf8'),
		'Region,Sales,Qty Sold,Order Date,Returned\nEast,10.5,3,2024-01-02,true\n"West, ""far""",,4,,false\n'
	);
});

test('exportPublishedDatasource can request calculations and flags truncation', async () => {
	const dir = tempDir();
	const client = stubClient([{ Region: 'East', 'Profit Ratio': 0.2 }]);
	const result = await exportPublishedDatasource(client, 'l', path.join(dir, 'x.csv'), { fields: ['Region', 'Profit Ratio', 'Nope'], rowLimit: 1 });
	assert.deepEqual(result.columns.map((c) => c.name), ['Region', 'Profit Ratio']);
	assert.equal(result.truncated, true);
	assert.deepEqual(result.skipped, [{ caption: 'Nope', reason: 'not in datasource metadata' }]);
	assert.equal(client.calls[1].body.options.rowLimit, 1);
});

test('exportPublishedDatasource throws on a VDS error body', async () => {
	const client = { vds: async () => ({ error: { message: 'no API Access' } }) };
	await assert.rejects(exportPublishedDatasource(client, 'l', path.join(tempDir(), 'x.csv')), /no API Access/);
});

test('exportViewCsv downloads, infers types leniently and rewrites', async () => {
	const dir = tempDir();
	const out = path.join(dir, 'view.csv');
	const client = {
		async download(p, dest) {
			assert.equal(p, '/views/v%201/data');
			fs.writeFileSync(dest, 'Category,Month of Order Date,Sales,Region\nFurniture,1/1/2024,"$1,234.00",East\nTech,2/1/2024,"(5.50)",East\nTech,2/1/2024,"(5.50)",East\n');
			return { file: dest };
		}
	};
	const result = await exportViewCsv(client, 'v 1', out);
	assert.equal(result.lossy, true);
	assert.equal(result.rowCount, 3);
	assert.deepEqual(result.columns.map((c) => c.type), ['STRING', 'DATE', 'DOUBLE', 'STRING']);
	assert.equal(
		fs.readFileSync(out, 'utf8'),
		'Category,Month of Order Date,Sales,Region\nFurniture,2024-01-01,1234.00,East\nTech,2024-02-01,-5.50,East\nTech,2024-02-01,-5.50,East\n'
	);
	assert.equal(fs.existsSync(`${out}.raw`), false);
});
