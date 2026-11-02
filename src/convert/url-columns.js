import { quoteString } from './calc/sql.js';

/**
 * Tableau URL actions on a table become a link in each row: a card Beast Mode that renders an HTML `<a>` (Phoenix keeps
 * `href` (http, https, mailto, tel) and `target` in table cells, SimpleWhiteListHtml), or App Studio's native link column
 * format when the cell value is the only token.
 * @typedef {import('../model/types.js').ActionIR} ActionIR
 * @typedef {import('../model/types.js').WorkbookIR} WorkbookIR
 * @typedef {import('../model/types.js').WorksheetIR} WorksheetIR
 */

const URL_ESCAPES = [
	['%', '%25'],
	[' ', '%20'],
	['"', '%22'],
	['#', '%23'],
	['&', '%26'],
	['+', '%2B'],
	[',', '%2C'],
	['/', '%2F'],
	[':', '%3A'],
	[';', '%3B'],
	['=', '%3D'],
	['?', '%3F'],
	['@', '%40']
];
const TOKEN_AGGREGATIONS = { ATTR: 'MAX', MAX: 'MAX', MIN: 'MIN', SUM: 'SUM', AVG: 'AVG', COUNT: 'COUNT' };
const FIELD_TOKEN = /^(?:\[([^\]]+)\]\.)?(\[[^\]]+\])$/;

/** A template that starts with a host and no scheme opens as a web address in Tableau; App Studio needs the scheme. */
export function withScheme(template) {
	const text = String(template ?? '').trim();
	const schemeAdded = !/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(?=[/?#<]|$)/i.test(text);
	return { template: schemeAdded ? `https://${text}` : text, schemeAdded };
}

/** Worksheets a URL action starts from, on any dashboard (a datasource-scoped action starts from every sheet of it). */
export function urlActionSheets(action, ir) {
	const src = action.source ?? {};
	const worksheets = ir.worksheets ?? [];
	let names;
	if (src.type === 'datasource') names = worksheets.filter((w) => (w.datasourceIds ?? []).includes(src.datasource)).map((w) => w.name);
	else if (src.type === 'all') names = worksheets.map((w) => w.name);
	else names = src.worksheets ?? (src.worksheet ? [src.worksheet] : []);
	const exclude = new Set(src.excludeSheets ?? []);
	return names.filter((n) => !exclude.has(n));
}

/**
 * A URL token: a parameter, or a field (`[f]`, `[ds].[f]`) with the aggregation Tableau wrote around it (`ATTR([f])`).
 * @returns {{ parameter: Object } | { datasourceId?: string, fieldId: string, aggregation?: string } | undefined}
 */
export function parseUrlToken(token, ir) {
	const parameter = (ir.parameters ?? []).find((p) => p.id === token);
	if (parameter || token.startsWith('[Parameters].')) return parameter ? { parameter } : undefined;
	const call = /^([A-Za-z]+)\((.+)\)$/.exec(token.trim());
	const aggregation = call ? TOKEN_AGGREGATIONS[call[1].toUpperCase()] : undefined;
	if (call && !aggregation) return undefined;
	const m = FIELD_TOKEN.exec((call ? call[2] : token).trim());
	if (!m) return undefined;
	return { ...(m[1] ? { datasourceId: m[1] } : {}), fieldId: m[2], ...(aggregation ? { aggregation } : {}) };
}

/** Static text and tokens of a URL template, in order. */
export function templateParts(template) {
	return String(template ?? '')
		.split(/(<[^<>]+>)/)
		.filter(Boolean)
		.map((part) => {
			const token = /^<([^<>]+)>$/.exec(part)?.[1];
			return token === undefined ? { text: part } : { token };
		});
}

/**
 * The column the link goes on, first match: a header styled as a link (underlined), the token field itself, a field the
 * token's calculation reads, the first text column.
 * @param {{ pillId: string, fieldId: string, text: boolean }[]} candidates  Visible table dimensions, in column order
 * @param {{ linkStyled?: string[], tokenFields: Set<string>, derivedFields: Set<string> }} hints
 */
export function pickLinkColumn(candidates, { linkStyled = [], tokenFields, derivedFields }) {
	const styled = new Set(linkStyled);
	const rules = [
		['underline', (c) => styled.has(c.pillId)],
		['token', (c) => tokenFields.has(c.fieldId)],
		['derived', (c) => derivedFields.has(c.fieldId)],
		['first', (c) => c.text]
	];
	for (const [reason, match] of rules) {
		const candidate = candidates.find(match);
		if (candidate) return { candidate, reason };
	}
	return undefined;
}

/**
 * App Studio's link column format (prefix + cell value + suffix, https only, Phoenix TCell.processLinkImageColFormats)
 * when the template is `https://...<display field>...` with no other token and no url encoding.
 * @param {({ text: string } | { token: string, field?: { fieldId: string, aggregation?: string } })[]} parts
 */
export function nativeLinkFormat(parts, displayFieldId, { encode } = {}) {
	const tokens = parts.filter((p) => 'token' in p);
	if (encode || tokens.length !== 1 || tokens[0].field?.fieldId !== displayFieldId || tokens[0].field.aggregation) return undefined;
	const at = parts.indexOf(tokens[0]);
	const prefix = parts.slice(0, at).map((p) => p.text).join('');
	const suffix = parts.slice(at + 1).map((p) => p.text).join('');
	if (!/^https:\/\/[^/?#\s<>]+/i.test(prefix) || /[<>"\s]/.test(prefix + suffix)) return undefined;
	return { displayType: 'link', displayPrefix: prefix, displaySuffix: suffix, displayLabel: '' };
}

function urlEncoded(sql) {
	return URL_ESCAPES.reduce((expr, [from, to]) => `REPLACE(${expr}, ${quoteString(from)}, ${quoteString(to)})`, sql);
}

/**
 * Beast Mode for a link cell, in the shape of the instance's own Hyperlink Beast Modes: the label as `name` (so the column
 * sorts by it) and as the link text, the href built from the template, a new tab. A null token shows the plain label, as
 * Tableau runs no action without a value (unless the action includes nulls). The label is not HTML-escaped: Phoenix
 * entity-encodes the cell before it parses the whitelisted tags, so an entity would show literally.
 * @param {{ label: string, parts: ({ text: string } | { sql: string, value?: string })[], encode?: boolean, includeNull?: boolean, whenNull?: string }} spec
 *   `sql` is a field expression, `value` a constant (a parameter's current value)
 */
export function hyperlinkFormula({ label, parts, encode = false, includeNull = false, whenNull = label }) {
	const href = [];
	const nullable = [];
	for (const part of parts) {
		if ('text' in part) href.push({ text: part.text.replace(/"/g, '%22') });
		else if (part.value !== undefined) href.push({ text: (encode ? encodeURIComponent(part.value) : part.value).replace(/"/g, '%22') });
		else {
			const sql = includeNull ? `IFNULL(${part.sql}, '')` : part.sql;
			if (!includeNull) nullable.push(part.sql);
			href.push({ sql: encode ? urlEncoded(sql) : `REPLACE(${sql}, '"', '%22')` });
		}
	}
	const pieces = [{ text: '<a name="' }, { sql: `REPLACE(${label}, '"', '')` }, { text: '" href="' }, ...href, { text: '" target="_blank">' }, { sql: label }, { text: '</a>' }];
	const args = [];
	for (const piece of pieces) {
		if ('text' in piece && args.length && typeof args.at(-1) === 'object') args.at(-1).text += piece.text;
		else args.push('text' in piece ? { text: piece.text } : piece.sql);
	}
	const concat = `CONCAT(${args.map((a) => (typeof a === 'object' ? quoteString(a.text) : a)).join(', ')})`;
	if (!nullable.length) return concat;
	return `CASE WHEN ${nullable.map((t) => `${t} IS NULL`).join(' OR ')} THEN ${whenNull} ELSE ${concat} END`;
}
