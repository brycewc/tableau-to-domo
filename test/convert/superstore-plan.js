import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWorkbook } from '../../src/pipeline/extract.js';
import { convertStage } from '../../src/pipeline/convert.js';
import { createEmitter, noopSink } from '../../src/util/events.js';
import { fakeHyperPython } from '../data/helpers.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/superstore.twbx', import.meta.url));
const ORDERS_HEADER = 'Row ID,Order ID,Order Date,Ship Date,Ship Mode,Customer ID,Customer Name,Segment,Country/Region,City,State/Province,Postal Code,Region,Product ID,Category,Sub-Category,Product Name,Sales,Quantity,Discount,Profit';
const ORDERS = `${ORDERS_HEADER}
1,CA-1,2024-01-03,2024-01-05,Second Class,C1,Ann,Consumer,United States,Austin,Texas,07001,Central,P1,Furniture,Chairs,Chair,261.96,2,0,41.91
2,CA-2,2024-02-03,2024-02-06,Same Day,C2,Bob,Corporate,United States,Boston,Massachusetts,02101,East,P2,Technology,Phones,"Phone, X",731.94,3,0.2,-12.5
3,CA-3,2024-03-03,2024-03-06,Same Day,C3,Cy,Corporate,United States,Denver,Colorado,80201,West,P3,Technology,Phones,"Line
break",10,1,0,1
`;

const col = (name, type = 'TEXT') => ({ name, type, nullable: true });

/**
 * Extract the superstore fixture (fake Hyper sidecar) into a temp workspace.
 * @param {{ selection?: Object, extract?: boolean }} [opts]
 */
export async function superstoreWorkspace({ selection } = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-select-'));
	const python = fakeHyperPython(tmp, [
		{ schema: 'Extract', name: 'Orders_ECFCA1FB690A41FE803BC071773BA862', csv: ORDERS, rowCount: 3, columns: ORDERS_HEADER.split(',').map((n) => col(n)) },
		{ schema: 'Extract', name: 'People_D73023733B004CC1B3CB1ACF62F4A965', csv: 'Regional Manager,Region\nChris,Central\nDana,East\n', rowCount: 2, columns: [col('Regional Manager'), col('Region')] },
		{ schema: 'Extract', name: 'Returns_2AA0FADE3C8A4E1A9A4B4F8E1B2C3D4E', csv: 'Returned,Order ID\nYes,CA-2\n', rowCount: 1, columns: [col('Returned'), col('Order ID')] }
	]);
	const config = { env: null, tableau: { server: '', site: '', patName: '', patSecret: '' }, domo: { instance: 'acme', accessToken: 'tok' }, workspace: path.join(tmp, 'ws'), python };
	const emitter = createEmitter(noopSink, 'test');
	const result = await extractWorkbook({ config, file: FIXTURE, dataStrategy: 'auto', unmapped: 'export', domoLookup: false, selection, emitter });
	return { tmp, config, slug: result.slug, ir: result.ir, manifests: result.manifests, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

let cached;
/** Full superstore plan and IR (built once per test file). */
export async function superstorePlan() {
	if (!cached) {
		const w = await superstoreWorkspace();
		const plan = await convertStage({ config: w.config, slug: w.slug, options: { target: 'pages', allBeastModes: true }, emitter: createEmitter(noopSink, 'test') });
		cached = { ...w, plan };
	}
	return cached;
}
