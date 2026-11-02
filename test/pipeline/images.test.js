import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPackage } from '../../src/tableau/package.js';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';
import { backfillImages, describeImages, extractImages, needsImageBackfill } from '../../src/pipeline/images.js';
import { makeZip } from '../twb/helpers/zip.js';

const XML = `<?xml version='1.0'?><workbook><worksheets /><dashboards>
	<dashboard name='Home'><zones><zone h='100000' id='1' type-v2='layout-flow' param='vert' w='100000' x='0' y='0'>
		<zone h='10000' id='2' type-v2='bitmap' param='Image/banner.png' w='100000' x='0' y='0' />
		<zone h='10000' id='3' type-v2='bitmap' param='Image/logo.png' is-scaled='1' w='50000' x='0' y='10000' />
		<zone h='10000' id='4' type-v2='bitmap' param='Other/logo.png' w='50000' x='50000' y='10000' />
		<zone h='10000' id='5' type-v2='bitmap' param='C:/Data/missing.png' w='50000' x='0' y='20000' />
	</zone></zones></dashboard>
	<dashboard name='Detail'><zones><zone h='10000' id='9' type-v2='bitmap' param='Image/banner.png' w='100000' x='0' y='0' /></zones></dashboard>
</dashboards></workbook>`;

const banner = Buffer.from('banner bytes');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

async function withPackage(run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-images-'));
	const file = path.join(dir, 'source.twbx');
	fs.writeFileSync(file, makeZip([{ name: 'Book.twb', data: XML }, { name: 'Image/banner.png', data: banner }, { name: 'Image/logo.png', data: 'logo a' }, { name: 'Other/logo.png', data: 'logo b' }]));
	const pkg = await openPackage(file);
	try {
		await run(pkg, dir);
	} finally {
		pkg.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const zones = (ir) => ir.dashboards.flatMap((d) => d.zones.map((z) => [d.name, z]));

test('extractImages copies each package image once, md5 in the IR; a shared basename gets its md5 prefix; a missing one an issue', async () => {
	await withPackage(async (pkg, dir) => {
		const ir = buildWorkbookIR(pkg.xml);
		const issues = await extractImages(pkg, ir, dir);
		const images = Object.fromEntries(zones(ir).map(([d, z]) => [`${d}.${z.id}`, z.image]));
		assert.deepEqual(images['Home.2'], { file: 'images/banner.png', name: 'banner.png', bytes: banner.length, md5: md5(banner) });
		assert.deepEqual(images['Detail.9'], images['Home.2']);
		assert.equal(images['Home.3'].file, 'images/logo.png');
		assert.equal(images['Home.4'].file, `images/${md5('logo b').slice(0, 8)}-logo.png`);
		assert.equal(fs.readFileSync(path.join(dir, images['Home.4'].file), 'utf8'), 'logo b');
		assert.equal(images['Home.5'], undefined);
		assert.deepEqual(issues.map((i) => [i.code, i.object.name]), [['extract.image-missing', 'Home']]);
		assert.deepEqual(fs.readdirSync(path.join(dir, 'images')).sort(), ['banner.png', 'logo.png', `${md5('logo b').slice(0, 8)}-logo.png`].sort());
	});
});

test('backfillImages fills an older ir.json: the bytes, and the fit read from the package XML', async () => {
	await withPackage(async (pkg, dir) => {
		const ir = buildWorkbookIR(pkg.xml);
		ir.irVersion = 10;
		for (const [, z] of zones(ir)) delete z.fit;
		assert.equal(needsImageBackfill(ir), true);
		await backfillImages(pkg, ir, dir, (xml) => buildWorkbookIR(xml));
		const home = ir.dashboards[0].zones;
		assert.deepEqual(home.map((z) => [z.id, z.fit, Boolean(z.image)]), [['2', 'none', true], ['3', 'fit', true], ['4', 'none', true], ['5', 'none', false]]);
		assert.equal(needsImageBackfill({ ...ir, irVersion: 11 }), false);
	});
});

test('describeImages adds the pixel size of images extracted before it was recorded, reading each file once', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2d-images-'));
	try {
		fs.mkdirSync(path.join(dir, 'images'));
		fs.writeFileSync(path.join(dir, 'images', 'logo.gif'), Buffer.from('GIF89a\x40\x01\xc8\x00\x00\x00', 'latin1'));
		const image = () => ({ file: 'images/logo.gif', name: 'logo.gif', bytes: 12, md5: 'ab' });
		const ir = { dashboards: [{ name: 'Home', zones: [{ id: '1', kind: 'image', image: image() }, { id: '2', kind: 'image', image: { ...image(), file: 'images/gone.png' } }], floating: [{ id: '3', kind: 'image', image: image() }] }] };
		await describeImages(ir, dir);
		const [a, gone] = ir.dashboards[0].zones;
		assert.deepEqual([a.image.width, a.image.height, ir.dashboards[0].floating[0].image.width], [320, 200, 320]);
		assert.equal(gone.image.width, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
