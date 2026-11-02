/**
 * Type mapping between Tableau, Hyper and Domo, plus the value normalization
 * used when writing CSV for Domo uploads. Pure functions, no I/O.
 */

const TABLEAU_TYPES = {
	string: 'STRING',
	integer: 'LONG',
	real: 'DOUBLE',
	date: 'DATE',
	datetime: 'DATETIME',
	boolean: 'STRING',
	spatial: 'STRING',
	table: 'STRING',
	unknown: 'STRING'
};

/**
 * Tableau field datatype (TWB `datatype` or VDS `dataType`) to Domo column type.
 * @param {string} datatype
 * @returns {import('../model/types.js').DomoColumnType}
 */
export function tableauToDomoType(datatype) {
	const key = String(datatype ?? '')
		.trim()
		.toLowerCase();
	if (key === 'int' || key === 'long') return 'LONG';
	if (key === 'double' || key === 'float' || key === 'number') return 'DOUBLE';
	return TABLEAU_TYPES[key] || 'STRING';
}

const MAX_LONG_DIGITS = 18;

/**
 * Hyper SQL type name to Domo column type. Accepts the SQL spelling ('BIGINT',
 * 'NUMERIC(18,2)', 'TIMESTAMP WITH TIME ZONE', 'DOUBLE PRECISION') and the
 * tableauhyperapi TypeTag spelling ('BIG_INT', 'TIMESTAMP_TZ').
 * @param {string} hyperTypeName
 * @returns {import('../model/types.js').DomoColumnType}
 */
export function hyperToDomoType(hyperTypeName) {
	const text = String(hyperTypeName ?? '')
		.trim()
		.toUpperCase();
	const numeric = /^(?:NUMERIC|DECIMAL)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?/.exec(text);
	if (numeric) {
		const precision = numeric[1] === undefined ? undefined : Number(numeric[1]);
		const scale = numeric[2] === undefined ? 0 : Number(numeric[2]);
		if (precision !== undefined && scale === 0 && precision <= MAX_LONG_DIGITS) return 'LONG';
		return 'DECIMAL';
	}
	const base = text
		.replace(/\(.*\)/, '')
		.replace(/[\s_]+/g, ' ')
		.trim();
	switch (base) {
		case 'SMALLINT':
		case 'SMALL INT':
		case 'INT2':
		case 'INTEGER':
		case 'INT':
		case 'INT4':
		case 'BIGINT':
		case 'BIG INT':
		case 'INT8':
		case 'OID':
			return 'LONG';
		case 'DOUBLE':
		case 'DOUBLE PRECISION':
		case 'REAL':
		case 'FLOAT':
		case 'FLOAT4':
		case 'FLOAT8':
			return 'DOUBLE';
		case 'DATE':
			return 'DATE';
		case 'TIMESTAMP':
		case 'TIMESTAMP TZ':
		case 'TIMESTAMPTZ':
		case 'TIMESTAMP WITH TIME ZONE':
		case 'TIMESTAMP WITHOUT TIME ZONE':
			return 'DATETIME';
		default:
			return 'STRING';
	}
}

/** True for Hyper boolean columns, whose CSV values need normalizing to 'true'/'false'. */
export function isHyperBoolean(hyperTypeName) {
	return /^(BOOL|BOOLEAN)$/i.test(String(hyperTypeName ?? '').trim());
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const ISO_DATETIME =
	/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const US_DATETIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*([AP]M)?$/i;
const PLAIN_INTEGER = /^[+-]?\d+$/;
const PLAIN_DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;
const CURRENCY = /^[$€£¥]|^(?:USD|EUR|GBP)\s?/i;

/**
 * @typedef {Object} NormalizeOptions
 * @property {boolean} [lenient=false]  Accept display formatting from Tableau view CSV:
 *   thousands separators, currency symbols, percents, accounting negatives, US m/d/yyyy dates.
 * @property {boolean} [boolean=false]  The source column is boolean; map t/f, 1/0, yes/no to 'true'/'false'.
 */

function pad(value, width = 2) {
	return String(value).padStart(width, '0');
}

function validDate(y, m, d) {
	if (m < 1 || m > 12 || d < 1) return false;
	const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return d <= days;
}

function validTime(h, mi, s) {
	return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 60;
}

/**
 * Parse a date or datetime string into parts, or null.
 * @returns {{ y: number, m: number, d: number, h: number, mi: number, s: number, hasTime: boolean }|null}
 */
function parseDateParts(text, lenient) {
	let match = ISO_DATE.exec(text);
	if (match) {
		const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
		return validDate(y, m, d) ? { y, m, d, h: 0, mi: 0, s: 0, hasTime: false } : null;
	}
	match = ISO_DATETIME.exec(text);
	if (match) {
		const [y, m, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(match[i]));
		const s = Number(match[6] || 0);
		if (!validDate(y, m, d) || !validTime(h, mi, s)) return null;
		const parts = { y, m, d, h, mi, s: Math.min(s, 59), hasTime: true };
		return match[8] ? toUtc(parts, match[8]) : parts;
	}
	if (!lenient) return null;
	match = US_DATE.exec(text);
	if (match) {
		const [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
		return validDate(y, m, d) ? { y, m, d, h: 0, mi: 0, s: 0, hasTime: false } : null;
	}
	match = US_DATETIME.exec(text);
	if (match) {
		const [m, d, y, rawH, mi] = [1, 2, 3, 4, 5].map((i) => Number(match[i]));
		const s = Number(match[6] || 0);
		const meridiem = match[8]?.toUpperCase();
		if (meridiem && (rawH < 1 || rawH > 12)) return null;
		let h = rawH;
		if (meridiem === 'PM' && h < 12) h += 12;
		if (meridiem === 'AM' && h === 12) h = 0;
		if (!validDate(y, m, d) || !validTime(h, mi, s)) return null;
		return { y, m, d, h, mi, s: Math.min(s, 59), hasTime: true };
	}
	return null;
}

function toUtc(parts, zone) {
	if (/^z$/i.test(zone)) return parts;
	const sign = zone.startsWith('-') ? -1 : 1;
	const digits = zone.slice(1).replace(':', '');
	const offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
	const ms = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi, parts.s) - offsetMinutes * 60000;
	const date = new Date(ms);
	return {
		y: date.getUTCFullYear(),
		m: date.getUTCMonth() + 1,
		d: date.getUTCDate(),
		h: date.getUTCHours(),
		mi: date.getUTCMinutes(),
		s: date.getUTCSeconds(),
		hasTime: true
	};
}

/**
 * Strip display formatting from a number. Returns the plain numeric text, or
 * null when the value is not a number.
 * @returns {{ text: string, integer: boolean }|null}
 */
function parseNumber(raw, lenient) {
	let text = raw;
	if (PLAIN_INTEGER.test(text)) return leadingZero(text) ? null : { text: canonicalInteger(text), integer: true };
	if (PLAIN_DECIMAL.test(text)) return leadingZero(text) ? null : { text: canonicalDecimal(text), integer: false };
	if (!lenient) return null;

	let negative = false;
	if (/^\(.*\)$/.test(text)) {
		negative = true;
		text = text.slice(1, -1).trim();
	}
	if (text.startsWith('-')) {
		negative = !negative;
		text = text.slice(1).trim();
	} else if (text.startsWith('+')) {
		text = text.slice(1).trim();
	}
	text = text.replace(CURRENCY, '').trim();
	if (text.startsWith('-') && !negative) {
		negative = true;
		text = text.slice(1).trim();
	}
	let percent = false;
	if (text.endsWith('%')) {
		percent = true;
		text = text.slice(0, -1).trim();
	}
	if (GROUPED_NUMBER.test(text)) text = text.replace(/,/g, '');
	if (!PLAIN_DECIMAL.test(text) || /^[+-]/.test(text) || leadingZero(text)) return null;
	if (percent) {
		const value = Number(text) / 100;
		if (!Number.isFinite(value)) return null;
		return { text: String(negative ? -value : value), integer: false };
	}
	const signed = negative ? `-${text}` : text;
	return PLAIN_INTEGER.test(signed)
		? { text: canonicalInteger(signed), integer: true }
		: { text: canonicalDecimal(signed), integer: false };
}

/** '0123' and '-007' are identifiers (zip codes, account numbers), not numbers. */
function leadingZero(text) {
	return /^[+-]?0\d/.test(text);
}

function canonicalInteger(text) {
	return text.startsWith('+') ? text.slice(1) : text;
}

function canonicalDecimal(text) {
	let out = text.startsWith('+') ? text.slice(1) : text;
	if (out.startsWith('.')) out = `0${out}`;
	else if (out.startsWith('-.')) out = `-0${out.slice(1)}`;
	if (/^-?\d+\.$/.test(out)) out = out.slice(0, -1);
	return out;
}

function fitsLong(text) {
	const digits = text.replace(/^-/, '');
	if (digits.length < 19) return true;
	if (digits.length > 19) return false;
	const value = BigInt(text);
	return value <= 9223372036854775807n && value >= -9223372036854775808n;
}

/**
 * Incremental type inference, for streaming a whole column instead of a sample.
 * @param {NormalizeOptions} [options]
 */
export function createTypeInferrer({ lenient = false } = {}) {
	let seen = 0;
	let long = true;
	let double = true;
	let date = true;
	let datetime = true;
	return {
		/** @param {any} value */
		add(value) {
			if (value === null || value === undefined) return;
			const text = String(value).trim();
			if (!text) return;
			seen++;
			if (long || double) {
				const number = parseNumber(text, lenient);
				if (!number) long = double = false;
				else if (!number.integer || !fitsLong(number.text)) long = false;
			}
			if (date || datetime) {
				const parts = parseDateParts(text, lenient);
				if (!parts) date = datetime = false;
				else if (parts.hasTime) date = false;
			}
		},
		/** @returns {import('../model/types.js').DomoColumnType} */
		result() {
			if (!seen) return 'STRING';
			if (long) return 'LONG';
			if (double) return 'DOUBLE';
			if (date) return 'DATE';
			if (datetime) return 'DATETIME';
			return 'STRING';
		}
	};
}

/**
 * Infer a Domo column type from CSV values. Empty values are ignored; numbers
 * with leading zeros stay STRING; a mix of dates and datetimes is DATETIME.
 * @param {any[]} sampleValues
 * @param {NormalizeOptions} [options]
 * @returns {import('../model/types.js').DomoColumnType}
 */
export function inferCsvType(sampleValues, options = {}) {
	const inferrer = createTypeInferrer(options);
	for (const value of sampleValues ?? []) inferrer.add(value);
	return inferrer.result();
}

/**
 * @param {any} value  Date, ISO string, or (lenient) m/d/yyyy
 * @param {NormalizeOptions} [options]
 * @returns {string|null} 'YYYY-MM-DD', or null when unparseable
 */
export function formatDate(value, { lenient = false } = {}) {
	const parts = dateParts(value, lenient);
	return parts ? `${pad(parts.y, 4)}-${pad(parts.m)}-${pad(parts.d)}` : null;
}

/**
 * Offsets are converted to UTC and fractional seconds are dropped.
 * @param {any} value
 * @param {NormalizeOptions} [options]
 * @returns {string|null} 'YYYY-MM-DD HH:MM:SS', or null when unparseable
 */
export function formatDateTime(value, { lenient = false } = {}) {
	const parts = dateParts(value, lenient);
	if (!parts) return null;
	return `${pad(parts.y, 4)}-${pad(parts.m)}-${pad(parts.d)} ${pad(parts.h)}:${pad(parts.mi)}:${pad(parts.s)}`;
}

function dateParts(value, lenient) {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		return {
			y: value.getUTCFullYear(),
			m: value.getUTCMonth() + 1,
			d: value.getUTCDate(),
			h: value.getUTCHours(),
			mi: value.getUTCMinutes(),
			s: value.getUTCSeconds(),
			hasTime: true
		};
	}
	return parseDateParts(String(value).trim(), lenient);
}

export const TRUE_VALUES = new Set(['true', 't', '1', 'yes', 'y']);
const FALSE_VALUES = new Set(['false', 'f', '0', 'no', 'n']);

/**
 * @param {any} value
 * @returns {string|null} 'true' | 'false', or null when not boolean-like
 */
export function formatBoolean(value) {
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	const text = String(value).trim().toLowerCase();
	if (TRUE_VALUES.has(text)) return 'true';
	if (FALSE_VALUES.has(text)) return 'false';
	return null;
}

/**
 * @param {any} value
 * @param {'LONG'|'DOUBLE'|'DECIMAL'} type
 * @param {NormalizeOptions} [options]
 * @returns {string|null} Plain numeric text, or null when not a number of that type
 */
export function formatNumber(value, type, { lenient = false } = {}) {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return null;
		if (type === 'LONG' && !Number.isInteger(value)) return null;
		return String(value);
	}
	if (typeof value === 'bigint') return String(value);
	const text = String(value).trim();
	const number = parseNumber(text, lenient) || parseNumber(text.replace(/^0+(?=\d)/, ''), lenient);
	if (!number) return null;
	if (type !== 'LONG') return number.text;
	if (number.integer) return fitsLong(number.text) ? number.text : null;
	const whole = /^(-?\d+)\.0*$/.exec(number.text);
	return whole && fitsLong(whole[1]) ? whole[1] : null;
}

/**
 * Normalize one value for a Domo CSV upload. Empty and null values become ''.
 * Returns null when the value cannot be represented in the column type, so the
 * caller can count it and write an empty cell.
 * @param {any} value
 * @param {import('../model/types.js').DomoColumnType} type
 * @param {NormalizeOptions} [options]
 * @returns {string|null}
 */
export function formatDomoValue(value, type, options = {}) {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string' && !value.trim()) return '';
	switch (type) {
		case 'LONG':
		case 'DOUBLE':
		case 'DECIMAL':
			if (typeof value === 'boolean') return value ? '1' : '0';
			return formatNumber(value, type, options);
		case 'DATE':
			return formatDate(value, options);
		case 'DATETIME':
			return formatDateTime(value, options);
		default: {
			if (options.boolean || typeof value === 'boolean') return formatBoolean(value) ?? String(value);
			if (typeof value === 'object') return JSON.stringify(value);
			return String(value);
		}
	}
}
