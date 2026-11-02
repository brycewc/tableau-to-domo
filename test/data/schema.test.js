import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	tableauToDomoType,
	hyperToDomoType,
	inferCsvType,
	formatDate,
	formatDateTime,
	formatBoolean,
	formatNumber,
	formatDomoValue
} from '../../src/convert/schema.js';

test('tableauToDomoType maps every Tableau datatype', () => {
	const cases = {
		string: 'STRING',
		integer: 'LONG',
		real: 'DOUBLE',
		date: 'DATE',
		datetime: 'DATETIME',
		boolean: 'STRING',
		spatial: 'STRING',
		unknown: 'STRING',
		INTEGER: 'LONG',
		REAL: 'DOUBLE',
		DATETIME: 'DATETIME',
		'': 'STRING',
		whatever: 'STRING'
	};
	for (const [input, expected] of Object.entries(cases)) assert.equal(tableauToDomoType(input), expected, input);
	assert.equal(tableauToDomoType(undefined), 'STRING');
});

test('hyperToDomoType maps SQL and TypeTag spellings', () => {
	const cases = {
		TEXT: 'STRING',
		'VARCHAR(255)': 'STRING',
		'CHAR(2)': 'STRING',
		SMALLINT: 'LONG',
		INTEGER: 'LONG',
		BIGINT: 'LONG',
		BIG_INT: 'LONG',
		SMALL_INT: 'LONG',
		INT: 'LONG',
		DOUBLE: 'DOUBLE',
		'DOUBLE PRECISION': 'DOUBLE',
		REAL: 'DOUBLE',
		FLOAT: 'DOUBLE',
		'NUMERIC(18,2)': 'DECIMAL',
		'NUMERIC(18,0)': 'LONG',
		'NUMERIC(10)': 'LONG',
		'NUMERIC(38,0)': 'DECIMAL',
		'NUMERIC(19, 0)': 'DECIMAL',
		NUMERIC: 'DECIMAL',
		DATE: 'DATE',
		TIMESTAMP: 'DATETIME',
		TIMESTAMP_TZ: 'DATETIME',
		'TIMESTAMP WITH TIME ZONE': 'DATETIME',
		BOOL: 'STRING',
		GEOGRAPHY: 'STRING',
		INTERVAL: 'STRING',
		TIME: 'STRING',
		BYTES: 'STRING',
		json: 'STRING'
	};
	for (const [input, expected] of Object.entries(cases)) assert.equal(hyperToDomoType(input), expected, input);
});

test('inferCsvType', () => {
	assert.equal(inferCsvType(['1', '2', '', '-30']), 'LONG');
	assert.equal(inferCsvType(['1', '2.5', '3e4']), 'DOUBLE');
	assert.equal(inferCsvType(['2024-01-02', '', '2024-12-31']), 'DATE');
	assert.equal(inferCsvType(['2024-01-02', '2024-01-02 10:11:12']), 'DATETIME');
	assert.equal(inferCsvType(['2024-01-02T10:11:12Z']), 'DATETIME');
	assert.equal(inferCsvType(['02134', '10001']), 'STRING', 'zip codes keep leading zeros');
	assert.equal(inferCsvType(['0', '0.5', '10']), 'DOUBLE');
	assert.equal(inferCsvType(['2024-02-30']), 'STRING', 'invalid date');
	assert.equal(inferCsvType(['true', 'false']), 'STRING');
	assert.equal(inferCsvType(['', ' ']), 'STRING');
	assert.equal(inferCsvType([]), 'STRING');
	assert.equal(inferCsvType(['99999999999999999999']), 'DOUBLE', 'overflows LONG');
	assert.equal(inferCsvType(['1,234', '5']), 'STRING', 'strict mode rejects separators');
	assert.equal(inferCsvType(['1,234', '5'], { lenient: true }), 'LONG');
	assert.equal(inferCsvType(['$1,234.50', '(12.00)', '7%'], { lenient: true }), 'DOUBLE');
	assert.equal(inferCsvType(['1/2/2024', '12/31/2023'], { lenient: true }), 'DATE');
	assert.equal(inferCsvType(['1/2/2024 3:04:05 PM'], { lenient: true }), 'DATETIME');
	assert.equal(inferCsvType(['1/2/2024']), 'STRING');
});

test('date and boolean formatting', () => {
	assert.equal(formatDate('2024-1-2'), '2024-01-02');
	assert.equal(formatDate('2024-01-02 10:00:00'), '2024-01-02');
	assert.equal(formatDate('3/4/2024', { lenient: true }), '2024-03-04');
	assert.equal(formatDate('nope'), null);
	assert.equal(formatDateTime('2024-01-02'), '2024-01-02 00:00:00');
	assert.equal(formatDateTime('2024-01-02T10:11:12.123456'), '2024-01-02 10:11:12');
	assert.equal(formatDateTime('2024-01-02 23:30:00-02'), '2024-01-03 01:30:00');
	assert.equal(formatDateTime('2024-01-02 10:00:00+05:30'), '2024-01-02 04:30:00');
	assert.equal(formatDateTime('1/2/2024 12:05 AM', { lenient: true }), '2024-01-02 00:05:00');
	assert.equal(formatDateTime('1/2/2024 1:05:09 PM', { lenient: true }), '2024-01-02 13:05:09');
	assert.equal(formatDateTime(new Date(Date.UTC(2020, 5, 7, 8, 9, 10))), '2020-06-07 08:09:10');
	assert.equal(formatBoolean('t'), 'true');
	assert.equal(formatBoolean('FALSE'), 'false');
	assert.equal(formatBoolean(true), 'true');
	assert.equal(formatBoolean('maybe'), null);
});

test('number formatting', () => {
	assert.equal(formatNumber('1,234,567', 'LONG', { lenient: true }), '1234567');
	assert.equal(formatNumber('(1,234.5)', 'DOUBLE', { lenient: true }), '-1234.5');
	assert.equal(formatNumber('-$12.50', 'DOUBLE', { lenient: true }), '-12.50');
	assert.equal(formatNumber('12.5%', 'DOUBLE', { lenient: true }), '0.125');
	assert.equal(formatNumber('42.000', 'LONG'), '42');
	assert.equal(formatNumber('42.5', 'LONG'), null);
	assert.equal(formatNumber('+.5', 'DOUBLE'), '0.5');
	assert.equal(formatNumber(3, 'LONG'), '3');
	assert.equal(formatNumber(NaN, 'DOUBLE'), null);
	assert.equal(formatNumber('NaN', 'DOUBLE'), null);
	assert.equal(formatNumber('007', 'LONG'), '7', 'typed numeric columns accept leading zeros');
});

test('formatDomoValue', () => {
	assert.equal(formatDomoValue(null, 'LONG'), '');
	assert.equal(formatDomoValue('  ', 'DATE'), '');
	assert.equal(formatDomoValue('x', 'LONG'), null);
	assert.equal(formatDomoValue('t', 'STRING', { boolean: true }), 'true');
	assert.equal(formatDomoValue('t', 'STRING'), 't');
	assert.equal(formatDomoValue(false, 'STRING'), 'false');
	assert.equal(formatDomoValue({ a: 1 }, 'STRING'), '{"a":1}');
});
