import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMemberCase, filterMembers } from '../../src/convert/member-case.js';
import { scanMemberCase } from '../../src/tableau/data/member-case.js';

const DS = 'federated.x';
const ds = {
	id: DS,
	caption: 'Summary',
	tables: [{ id: 'T', name: 'Summary', kind: 'table', columns: [{ localName: '[ARR_Category]', remoteName: 'ARR_Category' }] }],
	fields: [
		{ id: '[ARR_Category]', name: 'ARR_Category', datatype: 'string', role: 'dimension', kind: 'column' },
		{ id: '[ARR]', name: 'ARR', datatype: 'real', role: 'measure', kind: 'column' },
		{ id: '[Cats]', name: 'Cats', datatype: 'string', role: 'dimension', kind: 'set', set: { source: '[ARR_Category]', members: ['ENDOFPERIOD'] } }
	],
	filters: []
};
const ir = {
	datasources: [ds],
	worksheets: [
		{ name: 'S', filters: [{ datasourceId: DS, fieldId: '[ARR_Category]', kind: 'categorical', include: ['ENDOFPERIOD', 'EOP TRIAL', 'Exact'] }, { datasourceId: DS, fieldId: '[ARR]', kind: 'quantitative', min: 1 }] }
	]
};

test('filterMembers collects text members of categorical filters and sets on column fields', () => {
	assert.deepEqual([...filterMembers(ir, ds)].map(([k, v]) => [k, [...v]]), [['[ARR_Category]', ['ENDOFPERIOD', 'EOP TRIAL', 'Exact']]]);
});

test('scanMemberCase maps members the data holds only in another case', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-case-'));
	fs.writeFileSync(path.join(dir, 's.csv'), 'ARR_Category,ARR\nEndOfPeriod,1\nExact,2\nexact,3\neop trial,4\n');
	const manifest = { datasourceId: DS, tables: [{ name: 'Summary', tableId: 'T', file: 's.csv', columns: [{ name: 'ARR_Category', type: 'STRING', sourceName: 'ARR_Category' }] }] };
	// An exact match still lists the other spellings: Tableau's case-insensitive filter keeps both.
	assert.deepEqual(await scanMemberCase(ir, ds, manifest, dir), { '[ARR_Category]': { ENDOFPERIOD: 'EndOfPeriod', 'EOP TRIAL': 'eop trial', Exact: ['Exact', 'exact'] } });
	fs.writeFileSync(path.join(dir, 's.csv'), 'ARR_Category,ARR\nEndofperiod,1\nEndOfPeriod,2\nExact,3\n');
	assert.deepEqual(await scanMemberCase(ir, ds, manifest, dir), { '[ARR_Category]': { ENDOFPERIOD: ['EndOfPeriod', 'Endofperiod'] } });
	fs.rmSync(dir, { recursive: true, force: true });
});

test('applyMemberCase rewrites filter and set members and notes each once', () => {
	const manifests = new Map([[DS, { memberCase: { '[ARR_Category]': { ENDOFPERIOD: 'EndOfPeriod' } } }]]);
	const { ir: out, issues } = applyMemberCase(ir, manifests);
	assert.deepEqual(out.worksheets[0].filters[0].include, ['EndOfPeriod', 'EOP TRIAL', 'Exact']);
	assert.deepEqual(out.datasources[0].fields[2].set.members, ['EndOfPeriod']);
	assert.deepEqual(issues.map((i) => i.code), ['filter.member-case']);
	assert.deepEqual(ir.worksheets[0].filters[0].include, ['ENDOFPERIOD', 'EOP TRIAL', 'Exact']);
	assert.equal(applyMemberCase(ir, new Map()).ir, ir);
});

test('applyMemberCase expands a member to every spelling, for include and exclude lists', () => {
	const model = { datasources: [ds], worksheets: [{ name: 'S', filters: [{ datasourceId: DS, fieldId: '[ARR_Category]', kind: 'categorical', exclude: ['Exact', 'exact'] }] }] };
	const manifests = new Map([[DS, { memberCase: { '[ARR_Category]': { Exact: ['EXACT', 'Exact', 'exact'], exact: ['EXACT', 'Exact', 'exact'] } } }]]);
	assert.deepEqual(applyMemberCase(model, manifests).ir.worksheets[0].filters[0].exclude, ['EXACT', 'Exact', 'exact']);
});
