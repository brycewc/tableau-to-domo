import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { definitionParserStamp, extractWorkbook } from '../../src/pipeline/extract.js';
import { openWorkspace } from '../../src/pipeline/workspace.js';
import { mergePublishedDefinitions } from '../../src/tableau/data/index.js';
import { tempDir, testConfig } from './helpers.js';

const LUID = 'aaaaaaaa-2222-3333-4444-555555555555';

function workbookIR(name) {
	return {
		irVersion: 1,
		workbook: { name, sourceFile: '' },
		datasources: [
			{
				id: `sqlproxy.${name.toLowerCase()}`,
				caption: 'Adoption',
				published: { luid: LUID, name: 'Adoption' },
				connections: [{ id: 'default', class: 'sqlproxy', extra: {} }],
				tables: [],
				relationships: [],
				fields: [
					{ id: '[ACCOUNTID]', name: 'ACCOUNTID', datatype: 'string', role: 'dimension', kind: 'column' },
					{ id: '[Calculation_1]', name: 'AU lod', datatype: 'integer', role: 'measure', kind: 'calculated', formula: '{FIXED [ACCOUNTID] : MAX([AU_YEAR])}' }
				],
				filters: []
			}
		],
		parameters: [],
		worksheets: [{ name: 'Sheet 1', datasourceIds: [`sqlproxy.${name.toLowerCase()}`], pills: {}, rows: null, cols: null, rowPills: [], colPills: [], panes: [], filters: [], sorts: [], aggregated: true, measureValues: [], hidden: false }],
		dashboards: [],
		issues: []
	};
}

const PUBLISHED = {
	id: 'federated.x',
	caption: 'Adoption',
	connections: [{ id: 'snowflake.1', class: 'snowflake', extra: {} }],
	tables: [],
	relationships: [],
	fields: [
		{ id: '[ACCOUNTID]', name: 'ACCOUNTID', datatype: 'string', role: 'dimension', kind: 'column' },
		{ id: '[AU_YEAR]', name: 'AU_YEAR', datatype: 'integer', role: 'measure', kind: 'column', physical: { remoteName: 'AU_YEAR' } },
		{ id: '[Calculation_2]', name: 'Published only', datatype: 'real', role: 'measure', kind: 'calculated', formula: 'SUM([AU_YEAR])' }
	],
	filters: [],
	parameters: [{ id: '[Parameters].[Period]', name: 'Period', datatype: 'string', domain: 'all', value: 'FQ' }]
};

function stubs(log, { fail = false } = {}) {
	return {
		client: { TableauClient: class {} },
		content: {
			findWorkbook: async (_c, name) => ({ id: `wb-${name}`, name }),
			findDatasource: async (_c, { luid }) => ({ id: luid, updatedAt: '2026-10-01T00:00:00Z' }),
			downloadWorkbook: async (_c, _luid, dir) => {
				const file = path.join(dir, 'wb.twb');
				fs.writeFileSync(file, '<workbook/>');
				return { file };
			}
		},
		metadata: { fetchWorkbookMetadata: async () => null, applyMetadata: () => {} },
		package: { openPackage: async () => ({ kind: 'twb', xml: '<workbook/>', close: () => {} }) },
		twb: { buildWorkbookIR: (_xml, { info }) => workbookIR(info.name) },
		data: {
			datasourceSlug: (ds) => ds.caption.toLowerCase(),
			readPublishedDatasource: async (_c, luid) => {
				log.downloads.push(luid);
				if (fail) throw new Error('Tableau 403: Forbidden');
				return structuredClone(PUBLISHED);
			},
			mergePublishedDefinitions,
			extractData: async ({ datasource, published }) => {
				log.extracts.push(Boolean(published));
				return { datasourceId: datasource.id, strategy: 'none', tables: [], issues: [] };
			}
		}
	};
}

const client = { signIn: async () => {}, signOut: async () => {} };

test('published datasource field definitions are merged with strategy none, read once per luid across a batch', async () => {
	const root = tempDir();
	const config = testConfig(root, null);
	const log = { downloads: [], extracts: [] };
	const sharedCache = new Map();
	const a = await extractWorkbook({ config, workbook: 'Alpha', client, sharedCache, dataStrategy: 'none', includeExtract: false, deps: stubs(log) });
	const b = await extractWorkbook({ config, workbook: 'Beta', client, sharedCache, dataStrategy: 'none', includeExtract: false, deps: stubs(log) });
	assert.deepEqual(log.downloads, [LUID]);
	assert.deepEqual(log.extracts, [true], 'the shared extraction runs once and gets the definition');
	for (const { ir } of [a, b]) {
		const fields = ir.datasources[0].fields;
		assert.deepEqual(fields.map((f) => f.id), ['[ACCOUNTID]', '[Calculation_1]', '[AU_YEAR]', '[Calculation_2]']);
		assert.ok(ir.issues.some((i) => i.code === 'extract.published-fields' && /2 field definition\(s\).*1 calculation/.test(i.message)));
		assert.deepEqual(ir.parameters.map((prm) => prm.id), ['[Parameters].[Period]']);
		assert.ok(ir.issues.some((i) => i.code === 'extract.published-parameters'));
	}
	const saved = JSON.parse(fs.readFileSync(path.join(openWorkspace(root).sharedPaths(LUID).dir, 'definition.json'), 'utf8'));
	assert.equal(saved.updatedAt, '2026-10-01T00:00:00Z');
	assert.equal(saved.datasource.fields.length, 3);

	const again = { downloads: [], extracts: [] };
	const c = await extractWorkbook({ config, workbook: 'Gamma', client, dataStrategy: 'none', deps: stubs(again) });
	assert.equal(again.downloads.length, 0, 'unchanged on Tableau: reused from disk');
	assert.ok(c.ir.datasources[0].fields.some((f) => f.id === '[Calculation_2]'));
	await extractWorkbook({ config, workbook: 'Gamma', client, dataStrategy: 'none', refreshShared: true, deps: stubs(again) });
	assert.equal(again.downloads.length, 1, '--refresh-data reads the definition again');

	const file = path.join(openWorkspace(root).sharedPaths(LUID).dir, 'definition.json');
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).parser, definitionParserStamp());
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), parser: 'older' }));
	await extractWorkbook({ config, workbook: 'Gamma', client, dataStrategy: 'none', deps: stubs(again) });
	assert.equal(again.downloads.length, 2, 'a definition saved by another parser version is read again');
});

test('published field definitions are skipped with metadata or publishedFields off, and a failed download is a warning', async () => {
	for (const opts of [{ metadata: false }, { publishedFields: false }]) {
		const config = testConfig(tempDir(), null);
		const log = { downloads: [], extracts: [] };
		const { ir } = await extractWorkbook({ config, workbook: 'Alpha', client, dataStrategy: 'none', ...opts, deps: stubs(log) });
		assert.equal(log.downloads.length, 0);
		assert.deepEqual(log.extracts, [false]);
		assert.equal(ir.datasources[0].fields.length, 2);
	}

	const config = testConfig(tempDir(), null);
	const log = { downloads: [], extracts: [] };
	const sharedCache = new Map();
	const { ir } = await extractWorkbook({ config, workbook: 'Alpha', client, sharedCache, dataStrategy: 'none', deps: stubs(log, { fail: true }) });
	assert.equal(ir.datasources[0].fields.length, 2);
	const issue = ir.issues.find((i) => i.code === 'extract.published-fields-unavailable');
	assert.equal(issue.severity, 'warning');
	assert.match(issue.message, /403/);
	assert.equal(sharedCache.has(`definition:${LUID}`), false, 'a failure is not cached');
});
