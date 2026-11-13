/**
 * Tableau number formats (`default-format` on a field, worksheet `text-format` on a pill) as Domo column formats
 * (`columns[].format` on a card subscription; Phoenix NumberFormatter.applyColumnFormat reads type, precision, commas,
 * currency, percentMultiplied and abbreviate).
 */

/** The column format the editor saves for a number without thousands separators. */
export const PLAIN_INTEGER_FORMAT = Object.freeze({ type: 'number', format: '#', commas: false, percentMultiplied: true, precision: 0, abbreviate: false });

/** Currency symbols of Tableau's "Currency (Standard)" formats (`C<LCID>`). */
const LCID_CURRENCY = { 1033: '$', 4105: '$', 3081: '$', 5129: '$', 2057: '£', 1031: '€', 1036: '€', 1040: '€', 1043: '€', 3082: '€', 1041: '¥', 16393: '₹' };

/** Tableau prefixes: number, currency, percent, scientific, custom. */
const TYPES = { n: 'number', c: 'currency', p: 'percent', e: 'scientific', '*': 'custom' };

function splitSections(text) {
	const out = [''];
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\\' && i + 1 < text.length) {
			out[out.length - 1] += ch + text[++i];
			continue;
		}
		if (ch === '"') quoted = !quoted;
		if (ch === ';' && !quoted) out.push('');
		else out[out.length - 1] += ch;
	}
	return out;
}

/** Quoted and escaped literals vs. pattern characters of one section. */
function tokens(section) {
	const out = [];
	for (let i = 0; i < section.length; i++) {
		const ch = section[i];
		if (ch === '"') {
			const end = section.indexOf('"', i + 1);
			out.push({ literal: section.slice(i + 1, end < 0 ? undefined : end) });
			i = end < 0 ? section.length : end;
		} else if (ch === '\\' && i + 1 < section.length) {
			const next = section[++i];
			// Tableau escapes pattern characters it means literally as pattern ("\#,\#\#0", "0.0\%").
			out.push(/[#0,.%]/.test(next) ? { pattern: next } : { literal: next });
		} else if (ch === '[') {
			const end = section.indexOf(']', i);
			i = end < 0 ? section.length : end;
		} else {
			out.push({ pattern: ch });
		}
	}
	return out;
}

function domoPattern(commas, precision) {
	return `${commas ? '###,###' : '#'}${precision ? `.${'0'.repeat(precision)}` : ''}`;
}

function build({ type, commas, precision, currency, percentMultiplied = true, abbreviate = false }) {
	const out = { type, format: domoPattern(commas, precision), commas, percentMultiplied, precision };
	if (currency) out.currency = currency;
	out.abbreviate = abbreviate;
	return out;
}

/**
 * The Domo column format for a Tableau number format, or undefined when it has none (dates, scientific, standard number,
 * text). Covers the currency symbol, decimals, thousands separators, percent (multiplied, or a literal "%" suffix) and
 * display units (scaling commas for K, M, B become Domo's automatic abbreviation, with at least 2 decimals). Other text
 * around the number is dropped.
 * @param {string|undefined} text  e.g. 'c"$"#,##0;("$"#,##0)', 'p0.0%', 'n#,##0,,.00M;-#,##0,,.00M', 'C1033%'
 * @returns {Object|undefined}
 */
export function domoNumberFormat(text) {
	const raw = String(text ?? '').trim();
	if (!raw) return undefined;
	const standard = /^C(\d+)\\?%?$/.exec(raw);
	if (standard) {
		const currency = LCID_CURRENCY[standard[1]];
		return build({ type: currency ? 'currency' : 'number', commas: true, precision: 2, currency });
	}
	const head = /^([ncpe*])(?:![A-Za-z_]+!)?/.exec(raw);
	const kind = head ? TYPES[head[1]] : 'custom';
	if (kind === 'scientific') return undefined;
	const parts = tokens(splitSections(raw.slice(head ? head[0].length : 0))[0]);
	const first = parts.findIndex((t) => t.pattern === '#' || t.pattern === '0');
	if (first < 0) return undefined;
	let body = '';
	let end = first;
	while (end < parts.length && parts[end].pattern && /[#0,.]/.test(parts[end].pattern)) body += parts[end++].pattern;
	const before = parts.slice(0, first);
	const after = parts.slice(end);
	const text2 = (list) => list.map((t) => t.literal ?? t.pattern).join('');
	const unitLetter = /^\s*([KMB])\s*$/i.exec(text2(after.filter((t) => t.literal !== undefined || /[A-Za-z]/.test(t.pattern))).replace(/%/g, ''));
	if (kind === 'custom' && after.concat(before).some((t) => t.pattern && /[A-Za-z]/.test(t.pattern)) && !unitLetter) return undefined;
	const [intPart, decPart = ''] = body.split('.');
	const scaled = /,+$/.test(intPart) || /,+$/.test(decPart);
	const commas = intPart.replace(/,+$/, '').includes(',');
	const places = Math.min(decPart.replace(/,+$/, '').length, 10);
	const precision = scaled ? Math.max(places, 2) : places;
	const percentPattern = parts.some((t) => t.pattern === '%');
	const percentLiteral = after.some((t) => t.literal?.trim().startsWith('%'));
	// Only scaling commas divide ("#,##0,,M" is millions); a bare unit letter is text.
	const abbreviate = scaled;
	if (kind === 'percent' || percentPattern) return build({ type: 'percent', commas, precision, abbreviate });
	if (percentLiteral) return build({ type: 'percent', commas, precision, percentMultiplied: false, abbreviate });
	const isSymbol = (s) => /^[^\p{L}\p{N}\s]{1,3}$|^[A-Z]{1,3}[^\p{L}\p{N}\s]?$/u.test(s) && (kind === 'currency' || /\p{Sc}/u.test(s));
	const prefix = text2(before).trim();
	const suffix = text2(after).trim();
	const symbol = isSymbol(prefix) ? prefix : kind === 'currency' && !unitLetter && isSymbol(suffix) ? suffix : undefined;
	if (kind === 'currency' || symbol) return build({ type: 'currency', commas, precision, currency: symbol, abbreviate });
	return build({ type: 'number', commas, precision, abbreviate });
}

/**
 * How a format with a Domo format writes negatives: 'parens' (`("$"#,##0)`, `"$"(#,##0)`), 'minus' (leading `-` or no
 * negative section), else undefined. Domo column formats have no negative option; chart properties carry it.
 */
export function negativeStyle(text) {
	if (!domoNumberFormat(text)) return undefined;
	const raw = String(text).trim();
	if (/^C\d+/.test(raw) || /\[[<>=]/.test(raw)) return undefined;
	const head = /^([ncpe*])(?:![A-Za-z_]+!)?/.exec(raw);
	const sections = splitSections(raw.slice(head ? head[0].length : 0));
	if (sections.length < 2) return 'minus';
	const parts = tokens(sections[1]);
	const first = parts.findIndex((t) => t.pattern === '#' || t.pattern === '0');
	if (first < 0) return undefined;
	const around = (list) => list.map((t) => t.literal ?? t.pattern).join('');
	const before = around(parts.slice(0, first));
	const after = around(parts.slice(first).filter((t) => !(t.pattern && /[#0,.]/.test(t.pattern))));
	if (before.includes('(') && after.includes(')')) return 'parens';
	return before.includes('-') ? 'minus' : undefined;
}

/**
 * True for a Tableau integer dimension (not a bin) whose default format has no thousands separator: Tableau draws such a
 * field as "2026" where Domo writes "2,026".
 * @param {{ datatype?: string, role?: string, kind?: string, bin?: Object, defaultFormat?: string }|undefined} field
 */
export function plainInteger(field) {
	if (!field || field.datatype !== 'integer' || field.role !== 'dimension' || field.kind === 'bin' || field.bin) return false;
	return !String(field.defaultFormat ?? '').includes(',');
}

/** The Domo format of a numeric field's own Tableau default format, if Domo can express it. */
export function fieldNumberFormat(field) {
	if (!field || !/^(integer|real)$/.test(String(field.datatype ?? '')) || field.kind === 'bin' || field.bin) return undefined;
	return domoNumberFormat(field.defaultFormat);
}

/**
 * The column format for a field shown as itself: the worksheet's format for its pill, else the field's default format,
 * else the plain integer format for an integer dimension without thousands separators.
 * @param {{ datatype?: string, role?: string, kind?: string, bin?: Object, defaultFormat?: string }|undefined} field
 * @param {string} [pillFormat]  the worksheet's text-format for the pill
 */
export function fieldColumnFormat(field, pillFormat) {
	const mapped = domoNumberFormat(pillFormat) ?? fieldNumberFormat(field);
	if (mapped) return mapped;
	return plainInteger(field) ? { ...PLAIN_INTEGER_FORMAT } : undefined;
}
