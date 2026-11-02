import { createHash } from 'node:crypto';

// Fixed namespace so the same Tableau object always yields the same Domo legacyId/key.
const NAMESPACE = 'd3c1b7a4-5f2e-4c8a-9b6d-7a1e0f2c3b4d';

/**
 * RFC 4122 version 5 (SHA-1, name-based) UUID.
 * @param {string} name
 * @param {string} [namespace]
 */
export function uuidv5(name, namespace = NAMESPACE) {
	const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
	const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
	hash[6] = (hash[6] & 0x0f) | 0x50;
	hash[8] = (hash[8] & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Domo dataset beast mode legacyId. The server requires the `calculation_` prefix. */
export function beastModeLegacyId(...parts) {
	return `calculation_${uuidv5(parts.join('|'))}`;
}

/** Filesystem- and key-safe slug. */
export function slugify(value) {
	return (
		String(value)
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80) || 'untitled'
	);
}

/** Short stable hash, for content fingerprints in push state. */
export function shortHash(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
