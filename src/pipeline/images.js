import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { imageInfo } from '../util/image.js';

export const IMAGES_DIR = 'images';

const imageZones = (ir) => (ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])].map((zone) => ({ dash: d, zone }))).filter(({ zone }) => zone.kind === 'image');

const safeName = (name) => String(name).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_') || 'image';

/**
 * Copy the bytes of every image zone out of the workbook package into `<dir>/images/` (each package entry once, a basename
 * two entries share suffixed with its md5) and set `zone.image`. A zone whose path is not in the package gets an
 * extract.image-missing issue. Mutates the IR; returns the issues.
 * @param {import('../tableau/package.js').TableauPackage} pkg
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {string} dir  The workbook directory
 * @returns {Promise<import('../model/types.js').Issue[]>}
 */
export async function extractImages(pkg, ir, dir) {
	const issues = [];
	const byEntry = new Map();
	const taken = new Map();
	for (const { dash, zone } of imageZones(ir)) {
		const entry = zone.url ? pkg.findEntry?.(zone.url) : undefined;
		if (!entry) {
			delete zone.image;
			issues.push({
				severity: 'info',
				code: 'extract.image-missing',
				message: `Image zone${zone.url ? ` (${zone.url})` : ''} has no image in the workbook package`,
				object: { type: 'dashboard', name: dash.name },
				suggestion: 'Add the image to the Domo view by hand, or package the workbook with its images (.twbx).'
			});
			continue;
		}
		if (!byEntry.has(entry)) {
			const name = path.posix.basename(entry.replace(/\\/g, '/'));
			const tmp = path.join(dir, IMAGES_DIR, `.${crypto.randomUUID()}`);
			const { bytes } = await pkg.extractEntry(entry, tmp);
			const content = await fsp.readFile(tmp);
			const md5 = crypto.createHash('md5').update(content).digest('hex');
			let file = safeName(name);
			const owner = taken.get(file.toLowerCase());
			if (owner && owner !== entry) file = `${md5.slice(0, 8)}-${file}`;
			taken.set(file.toLowerCase(), entry);
			await fsp.rename(tmp, path.join(dir, IMAGES_DIR, file));
			byEntry.set(entry, { file: `${IMAGES_DIR}/${file}`, name, bytes, md5, ...imageInfo(content) });
		}
		zone.image = { ...byEntry.get(entry) };
	}
	return issues;
}

/**
 * Add the pixel size and tone (util/image.js imageInfo) to image zones extracted before they were recorded, reading each
 * file once from the workbook directory. Mutates the IR.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {string} dir
 */
export async function describeImages(ir, dir) {
	const seen = new Map();
	for (const { zone } of imageZones(ir)) {
		if (!zone.image?.file || zone.image.width !== undefined) continue;
		if (!seen.has(zone.image.file)) seen.set(zone.image.file, imageInfo(await fsp.readFile(path.join(dir, zone.image.file)).catch(() => undefined)));
		Object.assign(zone.image, seen.get(zone.image.file));
	}
}

/** True when an ir.json predates image extraction (IR version 11) and has image zones. */
export function needsImageBackfill(ir) {
	return (ir.irVersion ?? 1) < 11 && imageZones(ir).length > 0;
}

/**
 * Fill an older ir.json's image zones from the stored package: the bytes (extractImages) and `fit`, read from a fresh
 * parse of the package XML (dashboard name and zone id match). Mutates the IR; returns the issues.
 * @param {import('../tableau/package.js').TableauPackage} pkg
 * @param {import('../model/types.js').WorkbookIR} ir
 * @param {string} dir
 * @param {(xml: string) => import('../model/types.js').WorkbookIR} parse
 */
export async function backfillImages(pkg, ir, dir, parse) {
	const fresh = new Map(imageZones(parse(pkg.xml)).map(({ dash, zone }) => [`${dash.name}\n${zone.id}`, zone]));
	for (const { dash, zone } of imageZones(ir)) {
		const match = fresh.get(`${dash.name}\n${zone.id}`);
		if (match?.fit && !zone.fit) zone.fit = match.fit;
	}
	return extractImages(pkg, ir, dir);
}
