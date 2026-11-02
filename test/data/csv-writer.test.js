import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { csvField, reformatCsv, inferCsvColumns, readCsvHeader } from '../../src/tableau/data/csv-writer.js';

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 't2d-csv-'));
}

test('csvField quotes only when needed', () => {
	assert.equal(csvField('plain'), 'plain');
	assert.equal(csvField('a,b'), '"a,b"');
	assert.equal(csvField('say "hi"'), '"say ""hi"""');
	assert.equal(csvField('line\nbreak'), '"line\nbreak"');
	assert.equal(csvField(null), '');
});

test('reformatCsv renames headers, normalizes values, keeps quoted newlines and quotes', async () => {
	const dir = tmp();
	const input = path.join(dir, 'in.csv');
	fs.writeFileSync(
		input,
		'﻿Region,Sales,Order Date,Flag,Note\r\n' +
			'East,"1,234.50",2024-01-02 00:00:00,t,"multi\r\nline"\r\n' +
			'West,12,2024-02-03,f,"has ""quotes"", and comma"\r\n' +
			'\r\n' +
			'North,,,,\r\n'
	);
	const output = path.join(dir, 'out.csv');
	const result = await reformatCsv({
		input,
		output,
		lenient: true,
		columns: [
			{ name: 'Region Name', type: 'STRING', sourceName: 'Region' },
			{ name: 'Sales', type: 'DOUBLE' },
			{ name: 'Order Date', type: 'DATE' },
			{ name: 'Flag', type: 'STRING', boolean: true },
			{ name: 'Note', type: 'STRING' },
			{ name: 'Missing', type: 'LONG' }
		]
	});
	assert.equal(result.rowCount, 3);
	assert.deepEqual(result.missing, ['Missing']);
	assert.equal(
		fs.readFileSync(output, 'utf8'),
		'Region Name,Sales,Order Date,Flag,Note,Missing\n' +
			'East,1234.50,2024-01-02,true,"multi\r\nline",\n' +
			'West,12,2024-02-03,false,"has ""quotes"", and comma",\n' +
			'North,,,,,\n'
	);
});

test('reformatCsv counts values that do not fit the type', async () => {
	const dir = tmp();
	const input = path.join(dir, 'in.csv');
	fs.writeFileSync(input, 'n\n1\nabc\n3\n');
	const output = path.join(dir, 'out.csv');
	const result = await reformatCsv({ input, output, columns: [{ name: 'N', type: 'LONG', sourceIndex: 0 }] });
	assert.deepEqual(result.invalid, { N: 1 });
	assert.equal(fs.readFileSync(output, 'utf8'), 'N\n1\n\n3\n');
});

test('inferCsvColumns scans every row', async () => {
	const dir = tmp();
	const input = path.join(dir, 'in.csv');
	fs.writeFileSync(input, 'a,b,c,d\n1,"1,000",1/2/2024,x\n2,2.5,1/3/2024,\n3,7,,y\n');
	const { header, types, rowCount } = await inferCsvColumns(input, { lenient: true });
	assert.deepEqual(header, ['a', 'b', 'c', 'd']);
	assert.deepEqual(types, ['LONG', 'DOUBLE', 'DATE', 'STRING']);
	assert.equal(rowCount, 3);
	assert.deepEqual(await readCsvHeader(input), ['a', 'b', 'c', 'd']);
});

test('reformatCsv keeps NULL rows of a one-column CSV', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-csv-'));
	const input = path.join(dir, 'in.csv');
	const output = path.join(dir, 'out.csv');
	fs.writeFileSync(input, 'Region\nEast\n\n\nWest\n');
	const { rowCount } = await reformatCsv({ input, output, columns: [{ name: 'Region', type: 'STRING' }] });
	assert.equal(rowCount, 4);
	fs.writeFileSync(input, 'a,b\n1,2\n\n3,4\n');
	const two = await reformatCsv({ input, output, columns: [{ name: 'a', type: 'LONG' }, { name: 'b', type: 'LONG' }] });
	assert.equal(two.rowCount, 2);
});
