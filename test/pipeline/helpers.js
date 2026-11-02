import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ref } from '../../src/util/refs.js';

export function tempDir(prefix = 't2d-test-') {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(workspace, domo = { instance: 'acme', accessToken: 'token' }) {
	return {
		env: null,
		tableau: { server: '', site: '', patName: '', patSecret: '' },
		domo,
		workspace,
		python: 'python3'
	};
}

/** A small plan: one uploaded dataset, two beast modes, root + dashboard page, two cards, one layout. */
export function samplePlan() {
	return {
		planVersion: 1,
		source: { workbook: 'Sales', irFile: 'workbooks/sales/ir.json' },
		generatedAt: '2026-01-01T00:00:00.000Z',
		options: {},
		datasets: [
			{
				key: 'orders',
				name: 'Orders',
				strategy: 'upload',
				schema: [
					{ name: 'Region', type: 'STRING' },
					{ name: 'Sales', type: 'DOUBLE' }
				],
				upload: { file: 'data/orders/orders.csv' },
				datasourceId: 'federated.1',
				cardTarget: true,
				fieldMap: { '[Region]': 'Region', '[Sales]': 'Sales' }
			}
		],
		dataflows: [],
		beastModes: [
			{
				key: 'orders:ratio',
				datasetKey: 'orders',
				name: 'Ratio',
				legacyId: 'calculation_ratio',
				expression: 'SUM(`Sales`) / COUNT(`Region`)',
				aggregated: true,
				tableauFieldId: '[Calculation_1]',
				tableauFormula: 'SUM([Sales]) / COUNT([Region])',
				status: 'ok',
				features: []
			},
			{
				key: 'orders:bad',
				datasetKey: 'orders',
				name: 'Bad',
				legacyId: 'calculation_bad',
				expression: 'SUM(`Nope`)',
				aggregated: true,
				tableauFieldId: '[Calculation_2]',
				tableauFormula: 'SUM([Nope])',
				status: 'approximate',
				features: ['fixed']
			}
		],
		variables: [],
		cards: [
			{
				key: 'sheet-1',
				title: 'Sales by Region',
				worksheet: 'Sheet 1',
				datasetKey: 'orders',
				chartType: 'badge_vert_bar',
				body: {
					dataProvider: { dataSourceId: ref('dataset', 'orders') },
					variables: true,
					definition: {
						title: 'Sales by Region',
						subscriptions: {
							main: {
								name: 'main',
								columns: [
									{ column: 'Region', mapping: 'ITEM' },
									{ column: 'Sales', mapping: 'VALUE', aggregation: 'SUM' }
								]
							}
						},
						formulas: { card: [], dsUpdated: [], dsDeleted: [] }
					}
				},
				bigNumber: { columns: [{ column: 'Sales', aggregation: 'SUM' }] },
				pageKeys: ['dash'],
				status: 'ok'
			},
			{
				key: 'sheet-2',
				title: 'Bad ratio',
				worksheet: 'Sheet 2',
				datasetKey: 'orders',
				chartType: 'badge_vert_bar',
				body: {
					dataProvider: { dataSourceId: ref('dataset', 'orders') },
					variables: true,
					definition: {
						title: 'Bad ratio',
						subscriptions: {
							main: {
								name: 'main',
								columns: [
									{ column: 'Region', mapping: 'ITEM' },
									{ formulaId: 'calculation_bad', mapping: 'VALUE' },
									{ formulaId: 'calculation_ratio', mapping: 'VALUE' }
								]
							}
						},
						formulas: { card: [], dsUpdated: [], dsDeleted: [] }
					}
				},
				pageKeys: ['dash'],
				status: 'approximate'
			}
		],
		pages: [
			{
				key: 'dash',
				title: 'Overview',
				parentKey: 'root',
				dashboard: 'Overview',
				layout: {
					content: [
						{ contentKey: 1, type: 'CARD', cardId: ref('card', 'sheet-1') },
						{ contentKey: 2, type: 'CARD', cardId: ref('card', 'sheet-2') }
					],
					standard: { width: 60, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 30, height: 20 }, { contentKey: 2, type: 'CARD', x: 30, y: 0, width: 30, height: 20 }] },
					compact: { width: 12, template: [{ contentKey: 1, type: 'CARD', x: 0, y: 0, width: 12, height: 12 }, { contentKey: 2, type: 'CARD', x: 0, y: 12, width: 12, height: 12 }] }
				}
			},
			{ key: 'root', title: 'Sales', dashboard: '' }
		],
		issues: []
	};
}

/** Stub domo modules that record calls in order. */
export function stubDomo({ invalid = ['orders:bad'] } = {}) {
	const calls = [];
	let n = 0;
	const rec = (name, args, result) => {
		calls.push({ name, args });
		return result;
	};
	const deps = {
		client: { instance: 'acme' },
		datasets: {
			createDataset: async (_c, spec) => rec('createDataset', spec, 'ds-orders'),
			updateSchema: async (_c, id, schema) => rec('updateSchema', { id, schema }),
			uploadCsv: async (_c, id, file) => rec('uploadCsv', { id, file }, { rowCount: 2 })
		},
		beastmodes: {
			validateExpressions: async (_c, datasetId, items) =>
				rec('validateExpressions', { datasetId, items }, new Map(items.map((i) => [i.key, { valid: !invalid.includes(i.key), message: invalid.includes(i.key) ? 'INVALID_COLUMN' : 'valid' }]))),
			createBeastMode: async (_c, spec) => rec('createBeastMode', spec, { id: 100 + ++n, legacyId: spec.legacyId }),
			updateBeastMode: async (_c, id, spec) => rec('updateBeastMode', { id, spec }),
			listDatasetBeastModes: async (_c, datasetId) => rec('listDatasetBeastModes', { datasetId }, [])
		},
		pages: {
			createPage: async (_c, spec) => rec('createPage', spec, 500 + ++n),
			updatePage: async (_c, id, spec) => rec('updatePage', { id, ...spec }),
			writeLayout: async (_c, pageId, layout) => rec('writeLayout', { pageId, layout }, { layoutId: 900 })
		},
		cards: {
			createCard: async (_c, body, opts) => {
				const id = 700 + ++n;
				return rec('createCard', { body, opts }, { id, urn: String(id) });
			},
			updateCard: async (_c, id, body) => rec('updateCard', { id, body }),
			applyBigNumber: async (_c, id, sub, opts) => rec('applyBigNumber', { id, sub, opts })
		},
		dataflows: {},
		views: {},
		streams: {}
	};
	return { deps, calls };
}
