import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { icuToMysqlFormat, parseDateLiteral } from '../../src/convert/calc/index.js';

describe('date helpers', () => {
	const formats = [
		['yyyy-MM-dd', '%Y-%m-%d', false],
		['MM/dd/yy', '%m/%d/%y', false],
		['M/d/yyyy h:mm a', '%c/%e/%Y %l:%i %p', true],
		['EEEE, MMMM d', '%W, %M %e', false],
		['EEE dd-MMM-yyyy HH:mm:ss.SSS', '%a %d-%b-%Y %H:%i:%s.%f', true],
		["yyyy'T'HH", '%YT%H', true],
		['yyyy 100%', '%Y 100%%', false],
		['D/yyyy', '%j/%Y', false]
	];
	for (const [icu, mysql, hasTime] of formats) {
		test(`ICU ${icu}`, () => {
			const r = icuToMysqlFormat(icu);
			assert.equal(r.format, mysql);
			assert.equal(r.hasTime, hasTime);
			assert.deepEqual(r.unsupported, []);
		});
	}

	test('unsupported ICU tokens are reported', () => {
		assert.deepEqual(icuToMysqlFormat('yyyy QQ zzz').unsupported, ['QQ', 'zzz']);
	});

	test('date literal edge cases', () => {
		assert.equal(parseDateLiteral('2024-13-01'), null);
		assert.equal(parseDateLiteral('2024-01-01 25:00'), null);
		assert.deepEqual(parseDateLiteral('12/31/99'), { type: 'date', value: '1999-12-31' });
		assert.deepEqual(parseDateLiteral('2024-01-01 12:00 AM'), { type: 'datetime', value: '2024-01-01 00:00:00' });
		assert.deepEqual(parseDateLiteral('Jan. 2, 2024'), { type: 'date', value: '2024-01-02' });
	});
});
