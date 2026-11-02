const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n, width = 2) => String(n).padStart(width, '0');

function monthIndex(name) {
	const idx = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
	return idx < 0 ? null : idx + 1;
}

function build(y, m, d, time) {
	let year = Number(y);
	if (String(y).length <= 2) year += year < 50 ? 2000 : 1900;
	const month = Number(m);
	const day = Number(d);
	if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
	const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
	if (!time) return { type: 'date', value: date };
	let hour = Number(time.h);
	if (time.ampm) {
		const pm = time.ampm.toUpperCase() === 'PM';
		if (hour === 12) hour = pm ? 12 : 0;
		else if (pm) hour += 12;
	}
	if (hour > 23 || Number(time.mi) > 59 || Number(time.s || 0) > 59) return null;
	return { type: 'datetime', value: `${date} ${pad(hour)}:${pad(time.mi)}:${pad(time.s || 0)}` };
}

const TIME = String.raw`(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(AM|PM)?)?`;
const ISO = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${TIME}$`, 'i');
const SLASH = new RegExp(String.raw`^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})${TIME}$`, 'i');
const NAMED_MDY = new RegExp(String.raw`^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})${TIME}$`, 'i');
const NAMED_DMY = new RegExp(String.raw`^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})${TIME}$`, 'i');

const timeOf = (m, from) => (m[from] === undefined ? null : { h: m[from], mi: m[from + 1], s: m[from + 2], ampm: m[from + 3] });

/**
 * Parse the inside of a Tableau `#...#` literal.
 * Tableau reads numeric dates in the workbook locale; m/d/y (en-US) is assumed.
 * @param {string} raw
 * @returns {{ type: 'date'|'datetime', value: string } | null}
 */
export function parseDateLiteral(raw) {
	const text = String(raw).trim();
	let m = ISO.exec(text);
	if (m) return build(m[1], m[2], m[3], timeOf(m, 4));
	m = SLASH.exec(text);
	if (m) return build(m[3], m[1], m[2], timeOf(m, 4));
	m = NAMED_MDY.exec(text);
	if (m && monthIndex(m[1])) return build(m[3], monthIndex(m[1]), m[2], timeOf(m, 4));
	m = NAMED_DMY.exec(text);
	if (m && monthIndex(m[2])) return build(m[3], monthIndex(m[2]), m[1], timeOf(m, 4));
	return null;
}

const ICU_TO_MYSQL = {
	y: '%Y',
	yy: '%y',
	yyy: '%Y',
	yyyy: '%Y',
	Y: '%Y',
	YY: '%y',
	YYYY: '%Y',
	M: '%c',
	MM: '%m',
	MMM: '%b',
	MMMM: '%M',
	L: '%c',
	LL: '%m',
	LLL: '%b',
	LLLL: '%M',
	d: '%e',
	dd: '%d',
	D: '%j',
	DD: '%j',
	DDD: '%j',
	E: '%a',
	EE: '%a',
	EEE: '%a',
	EEEE: '%W',
	H: '%k',
	HH: '%H',
	h: '%l',
	hh: '%h',
	m: '%i',
	mm: '%i',
	s: '%s',
	ss: '%s',
	a: '%p',
	aa: '%p'
};
const TIME_LETTERS = new Set(['H', 'h', 'm', 's', 'S', 'a', 'k', 'K']);

/**
 * Convert an ICU date pattern (Tableau DATEPARSE) to a MySQL STR_TO_DATE format.
 * @param {string} pattern
 * @returns {{ format: string, unsupported: string[], hasTime: boolean }}
 */
export function icuToMysqlFormat(pattern) {
	let out = '';
	const unsupported = [];
	let hasTime = false;
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "'") {
			if (pattern[i + 1] === "'") {
				out += "'";
				i += 2;
				continue;
			}
			const close = pattern.indexOf("'", i + 1);
			const literal = close < 0 ? pattern.slice(i + 1) : pattern.slice(i + 1, close);
			out += literal.replace(/%/g, '%%');
			i = close < 0 ? pattern.length : close + 1;
			continue;
		}
		if (/[A-Za-z]/.test(ch)) {
			let j = i;
			while (pattern[j] === ch) j++;
			const run = pattern.slice(i, j);
			if (TIME_LETTERS.has(ch)) hasTime = true;
			if (ch === 'S') out += '%f';
			else if (ICU_TO_MYSQL[run]) out += ICU_TO_MYSQL[run];
			else if (ch === 'E') out += '%W';
			else unsupported.push(run);
			i = j;
			continue;
		}
		out += ch === '%' ? '%%' : ch;
		i++;
	}
	return { format: out, unsupported, hasTime };
}
