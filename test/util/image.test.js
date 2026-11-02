import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { colorTone, imageInfo } from '../../src/util/image.js';

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'latin1');
	data.copy(out, 8);
	return out;
}

/** A PNG from unfiltered rows of raw bytes. */
function png({ width, height, depth = 8, color, rows, palette, alphas }) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = depth;
	header[9] = color;
	const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
		...(alphas ? [chunk('tRNS', Buffer.from(alphas))] : []),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

test('a white logo on a transparent background has tone 1; transparent pixels do not count', () => {
	const rows = [
		[255, 255, 255, 255, 0, 0, 0, 0],
		[0, 0, 0, 0, 255, 255, 255, 255]
	];
	assert.deepEqual(imageInfo(png({ width: 2, height: 2, color: 6, rows })), { width: 2, height: 2, tone: 1 });
});

test('RGB, gray and palette PNGs (with a 2-bit palette and tRNS) give their mean luminance', () => {
	assert.deepEqual(imageInfo(png({ width: 2, height: 1, color: 2, rows: [[0, 0, 0, 255, 255, 255]] })), { width: 2, height: 1, tone: 0.5 });
	assert.equal(imageInfo(png({ width: 1, height: 1, color: 0, rows: [[51]] })).tone, 0.2);
	// Two pixels of a 2-bit palette: index 0 black (transparent), index 1 white.
	const paletted = png({ width: 2, height: 1, depth: 2, color: 3, rows: [[0b00010000]], palette: [0, 0, 0, 255, 255, 255], alphas: [0, 255] });
	assert.equal(imageInfo(paletted).tone, 1);
});

test('filtered PNG rows are reconstructed before measuring', () => {
	const header = png({ width: 2, height: 2, color: 0, rows: [[0, 0], [0, 0]] });
	// Sub (1) on row 1 gives [10, 20]; Up (2) on row 2 adds the row above: [15, 25].
	const raw = Buffer.from([1, 10, 10, 2, 5, 5]);
	const idat = chunk('IDAT', zlib.deflateSync(raw));
	const at = header.indexOf('IDAT', 0, 'latin1') - 4;
	const length = header.readUInt32BE(at);
	const rebuilt = Buffer.concat([header.subarray(0, at), idat, header.subarray(at + 12 + length)]);
	assert.equal(imageInfo(rebuilt).tone, Math.round(((10 + 20 + 15 + 25) / 4 / 255) * 1000) / 1000);
});

test('JPEG and GIF give their size only; other bytes give nothing', () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
	assert.deepEqual(imageInfo(jpeg), { width: 800, height: 600 });
	const gif = Buffer.from('GIF89a\x40\x01\xc8\x00\x00\x00', 'latin1');
	assert.deepEqual(imageInfo(gif), { width: 320, height: 200 });
	assert.equal(imageInfo(Buffer.from('not an image')), undefined);
	assert.equal(imageInfo(undefined), undefined);
	assert.deepEqual(imageInfo(png({ width: 3, height: 1, color: 2, rows: [[0, 0, 0]] }), { tone: false }), { width: 3, height: 1 });
});

test('colorTone matches the image tone scale', () => {
	assert.equal(colorTone('#FFFFFF'), 1);
	assert.equal(colorTone('#000000'), 0);
	assert.equal(colorTone('#083494'), 0.194);
	assert.equal(colorTone('none'), undefined);
});
