import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const TONE_SAMPLES = 200000;

const luminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Pixel size of a PNG, JPEG or GIF and, for a PNG, its tone: the mean luminance (0 black .. 1 white) of its pixels
 * weighted by their opacity (undefined when it has no opaque pixels or cannot be decoded).
 * @param {Buffer} bytes
 * @param {{ tone?: boolean }} [opts]  `tone: false` reads only the size
 * @returns {{ width: number, height: number, tone?: number } | undefined}
 */
export function imageInfo(bytes, { tone = true } = {}) {
	if (!Buffer.isBuffer(bytes) || bytes.length < 10) return undefined;
	if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return pngInfo(bytes, tone);
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
	if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	return undefined;
}

function jpegSize(bytes) {
	let at = 2;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) return undefined;
		const marker = bytes[at + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		const length = bytes.readUInt16BE(at + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
		at += 2 + length;
	}
	return undefined;
}

function pngInfo(bytes, withTone) {
	let header;
	let palette;
	let alphas;
	const data = [];
	for (let at = 8; at + 8 <= bytes.length; ) {
		const length = bytes.readUInt32BE(at);
		const type = bytes.toString('latin1', at + 4, at + 8);
		const chunk = bytes.subarray(at + 8, at + 8 + length);
		if (type === 'IHDR') header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] };
		else if (type === 'PLTE') palette = chunk;
		else if (type === 'tRNS') alphas = chunk;
		else if (type === 'IDAT') data.push(chunk);
		else if (type === 'IEND') break;
		at += 12 + length;
	}
	if (!header) return undefined;
	const size = { width: header.width, height: header.height };
	if (!withTone) return size;
	try {
		const tone = pngTone(header, zlib.inflateSync(Buffer.concat(data)), palette, alphas);
		return tone === undefined ? size : { ...size, tone };
	} catch {
		return size;
	}
}

function pngTone({ width, height, depth, color, interlace }, raw, palette, alphas) {
	const channels = PNG_CHANNELS[color];
	if (!channels || interlace !== 0 || (color === 3 && !palette)) return undefined;
	const bitsPerPixel = channels * depth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const step = Math.max(1, Math.ceil(bitsPerPixel / 8));
	if (raw.length < height * (stride + 1)) return undefined;
	const sampleEvery = Math.max(1, Math.floor((width * height) / TONE_SAMPLES));
	const max = 2 ** depth - 1;
	const sample = (row, x, ch) => {
		if (depth === 8) return row[x * channels + ch];
		if (depth === 16) return row[(x * channels + ch) * 2];
		const bit = (x * channels + ch) * depth;
		return (row[bit >> 3] >> (8 - depth - (bit & 7))) & max;
	};
	const scale = depth === 16 ? 1 : 255 / max;
	let prev = Buffer.alloc(stride);
	let sum = 0;
	let weight = 0;
	let n = 0;
	for (let y = 0; y < height; y++) {
		const start = y * (stride + 1);
		const filter = raw[start];
		const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
		for (let i = 0; i < stride; i++) {
			const left = i >= step ? row[i - step] : 0;
			const up = prev[i];
			const corner = i >= step ? prev[i - step] : 0;
			if (filter === 1) row[i] = (row[i] + left) & 0xff;
			else if (filter === 2) row[i] = (row[i] + up) & 0xff;
			else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
			else if (filter === 4) {
				const p = left + up - corner;
				const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
				row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner)) & 0xff;
			}
		}
		for (let x = 0; x < width; x++, n++) {
			if (n % sampleEvery) continue;
			let r;
			let g;
			let b;
			let a = 255;
			if (color === 3) {
				const index = sample(row, x, 0);
				[r, g, b] = [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
				if (alphas && index < alphas.length) a = alphas[index];
			} else if (color === 0 || color === 4) {
				r = g = b = sample(row, x, 0) * scale;
				if (color === 4) a = sample(row, x, 1) * scale;
			} else {
				[r, g, b] = [sample(row, x, 0) * scale, sample(row, x, 1) * scale, sample(row, x, 2) * scale];
				if (color === 6) a = sample(row, x, 3) * scale;
			}
			sum += luminance(r, g, b) * a;
			weight += a;
		}
		prev = row;
	}
	return weight > 0 ? Math.round((sum / weight) * 1000) / 1000 : undefined;
}

/** Relative luminance (0..1, same scale as imageInfo's tone) of a #rrggbb color; undefined for anything else. */
export function colorTone(hex) {
	const m = /^#?([0-9a-f]{6})/i.exec(String(hex ?? ''));
	if (!m) return undefined;
	const v = parseInt(m[1], 16);
	return Math.round(luminance(v >> 16, (v >> 8) & 0xff, v & 0xff) * 1000) / 1000;
}
