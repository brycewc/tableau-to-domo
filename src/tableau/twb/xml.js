import { XMLParser, XMLValidator } from 'fast-xml-parser';

const FCP_PREFIX = /^_\.fcp\.(.+?)\.(true|false)\.\.\.(.+)$/;
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const FORBIDDEN_DECL = /<!DOCTYPE|<!ENTITY/i;
const GUARD_WINDOW = 8192;

/** Element of a parsed, prefix-normalized Tableau XML document. */
export class XmlNode {
	/**
	 * @param {string} name
	 * @param {Record<string,string>} attrs
	 */
	constructor(name, attrs = {}) {
		this.name = name;
		this.attrs = attrs;
		/** @type {XmlNode[]} */
		this.children = [];
		this.text = '';
	}

	/** @param {string} name @returns {string|undefined} */
	attr(name) {
		return this.attrs[name];
	}

	/** First direct child element with this name. */
	child(name) {
		return this.children.find((c) => c.name === name);
	}

	/** All direct child elements with this name (all children when omitted). */
	all(name) {
		return name ? this.children.filter((c) => c.name === name) : this.children.slice();
	}

	/** First element at a slash-separated child path, e.g. 'table/view'. */
	path(p) {
		let node = this;
		for (const part of p.split('/')) {
			node = node?.child(part);
			if (!node) return undefined;
		}
		return node;
	}

	/** Every element matching a slash-separated child path. */
	pathAll(p) {
		let nodes = [this];
		for (const part of p.split('/')) nodes = nodes.flatMap((n) => n.all(part));
		return nodes;
	}

	/** Descendant elements with this name, in document order. */
	descendants(name) {
		const out = [];
		const walk = (node) => {
			for (const c of node.children) {
				if (!name || c.name === name) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	/** Text of this element and all descendants. */
	textContent() {
		return this.text + this.children.map((c) => c.textContent()).join('');
	}

	/** Trimmed direct text of a child element, or undefined. */
	childText(name) {
		const c = this.child(name);
		return c ? c.textContent().trim() : undefined;
	}
}

/** Decode the five XML entities and numeric character references in one pass. */
export function decodeEntities(value) {
	if (typeof value !== 'string' || !value.includes('&')) return value;
	return value.replace(ENTITY, (match, dec, hex, named) => {
		if (named) return NAMED[named];
		const code = dec ? Number(dec) : parseInt(hex, 16);
		if (!Number.isFinite(code) || code > 0x10ffff) return match;
		try {
			return String.fromCodePoint(code);
		} catch {
			return match;
		}
	});
}

/**
 * Throws when the document declares a DOCTYPE or ENTITY (XXE / billion-laughs vectors).
 * @param {string} xml
 */
export function assertNoDoctype(xml) {
	const rootStart = findRootStart(xml);
	const head = xml.slice(0, Math.max(GUARD_WINDOW, rootStart < 0 ? 0 : rootStart));
	if (FORBIDDEN_DECL.test(head)) throw new Error('Refusing XML with a DOCTYPE or ENTITY declaration');
}

function findRootStart(xml) {
	let i = 0;
	while (i < xml.length) {
		const lt = xml.indexOf('<', i);
		if (lt < 0) return -1;
		const next = xml[lt + 1];
		let end;
		if (next === '?') end = xml.indexOf('?>', lt) + 2;
		else if (xml.startsWith('<!--', lt)) end = xml.indexOf('-->', lt) + 3;
		else if (next === '!') end = xml.indexOf('>', lt) + 1;
		else return lt;
		if (end <= lt) return -1;
		i = end;
	}
	return -1;
}

/**
 * Name of the root element without parsing the whole document.
 * @param {string} xml
 * @returns {string|undefined}
 */
export function sniffRootName(xml) {
	const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
	const start = findRootStart(text);
	if (start < 0) return undefined;
	const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(start, start + 512));
	return m ? normalizeName(m[1]) : undefined;
}

/**
 * Resolve a `_.fcp.<Feature>.<true|false>...<name>` name. Returns null for the
 * `.false...` variant (it describes the pre-feature fallback and must be dropped).
 * @param {string} name
 * @returns {string|null}
 */
export function normalizeName(name) {
	let current = name;
	for (let m = FCP_PREFIX.exec(current); m; m = FCP_PREFIX.exec(current)) {
		if (m[2] === 'false') return null;
		current = m[3];
	}
	return current;
}

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	preserveOrder: true,
	processEntities: false,
	htmlEntities: false,
	parseAttributeValue: false,
	parseTagValue: false,
	trimValues: false,
	cdataPropName: '#cdata',
	ignoreDeclaration: true,
	ignorePiTags: true,
	allowBooleanAttributes: true
});

function convert(item) {
	const tag = Object.keys(item).find((k) => k !== ':@');
	const name = normalizeName(tag);
	if (name === null) return null;
	const attrs = {};
	const rawAttrs = item[':@'] || {};
	const promoted = [];
	for (const [key, value] of Object.entries(rawAttrs)) {
		const real = normalizeName(key);
		if (real === null) continue;
		if (real !== key) promoted.push([real, value]);
		else attrs[real] = decodeEntities(String(value));
	}
	for (const [real, value] of promoted) attrs[real] = decodeEntities(String(value));
	const node = new XmlNode(name, attrs);
	const textParts = [];
	for (const childItem of item[tag] || []) {
		if ('#text' in childItem) textParts.push(decodeEntities(String(childItem['#text'])));
		else if ('#cdata' in childItem) textParts.push(childItem['#cdata'].map((c) => String(c['#text'] ?? '')).join(''));
		else {
			const child = convert(childItem);
			if (child) node.children.push(child);
		}
	}
	const text = textParts.join('');
	node.text = node.children.length && !text.trim() ? '' : text;
	return node;
}

/**
 * Parse Tableau XML into an XmlNode tree with feature-flag prefixes resolved,
 * entities decoded once, comments dropped, and DOCTYPE rejected.
 * @param {string} xml
 * @returns {XmlNode} The root element
 */
export function parseXml(xml) {
	if (typeof xml !== 'string') throw new TypeError('parseXml expects a string');
	const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
	assertNoDoctype(text);
	// fast-xml-parser silently repairs mismatched or truncated tags, so a corrupt file must be caught here.
	const valid = XMLValidator.validate(text, { allowBooleanAttributes: true });
	if (valid !== true) throw new Error(`Invalid Tableau XML: ${valid.err.msg} (line ${valid.err.line}, col ${valid.err.col})`);
	let parsed;
	try {
		parsed = parser.parse(text);
	} catch (err) {
		throw new Error(`Invalid Tableau XML: ${err.message}`, { cause: err });
	}
	for (const item of parsed) {
		const tag = Object.keys(item).find((k) => k !== ':@');
		if (!tag || tag.startsWith('#') || tag.startsWith('?')) continue;
		const node = convert(item);
		if (node) return node;
	}
	throw new Error('Invalid Tableau XML: no root element');
}

const SAFE_INTEGER = /^-?\d{1,15}$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * '2019-01-01' stays; '2019-01-01 10:00:00' becomes '2019-01-01T10:00:00'.
 * @param {string} text Inside of a #...# literal
 */
export function parseDateLiteral(text) {
	const s = String(text).trim();
	const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/.exec(s);
	if (!m) return s;
	if (!m[2]) return m[1];
	const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
	return `${m[1]}T${time.padStart(8, '0')}`;
}

/**
 * Parse a Tableau literal as written in member/value attributes:
 * "quoted" strings, #date# literals, %null%, numbers, booleans.
 * Quoted strings undo Tableau's backslash escaping of %, # and \ ("Contraction >= 80\%").
 * @param {string|undefined} raw
 * @returns {any}
 */
export function parseLiteral(raw) {
	if (raw === undefined || raw === null) return undefined;
	const s = String(raw).trim();
	if (s === '%null%' || s === '\\%null\\%') return null;
	if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') return s.slice(1, -1).replace(/\\(.)|""/g, (_, c) => c ?? '"');
	if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1).replace(/''/g, "'");
	if (s.length >= 2 && s[0] === '#' && s.at(-1) === '#') return parseDateLiteral(s.slice(1, -1));
	if (/^-?\d+$/.test(s)) return SAFE_INTEGER.test(s) ? Number(s) : s;
	if (NUMBER.test(s)) return Number(s);
	if (/^true$/i.test(s)) return true;
	if (/^false$/i.test(s)) return false;
	return s;
}

/** True when a literal is a #date# literal. */
export function isDateLiteral(raw) {
	const s = String(raw ?? '').trim();
	return s.length >= 2 && s[0] === '#' && s.at(-1) === '#';
}

/**
 * Plain text of a <formatted-text> block (or any element containing runs).
 * Tableau ends paragraphs with a run of 'Æ' followed by a newline.
 * @param {XmlNode|undefined} node
 * @param {Record<string,string>} [placeholders] e.g. { 'Sheet Name': 'Sales' }
 */
export function formattedText(node, placeholders = {}) {
	if (!node) return undefined;
	const container = node.name === 'formatted-text' ? node : node.descendants('formatted-text')[0];
	if (!container) return undefined;
	const runs = container.descendants('run');
	let text = runs.length ? runs.map((r) => r.textContent()).join('') : container.textContent();
	text = text.replace(/Æ(?=\r?\n)/g, '').replace(/Æ/g, '').replace(/\r\n/g, '\n');
	for (const [key, value] of Object.entries(placeholders)) text = text.split(`<${key}>`).join(value);
	text = text.trim();
	return text || undefined;
}

/** Normalize line endings of a decoded formula. */
export function normalizeFormula(formula) {
	return typeof formula === 'string' ? formula.replace(/\r\n?/g, '\n') : formula;
}
