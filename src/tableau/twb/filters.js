import { parsePillId } from './shelf.js';
import { isDateLiteral, parseLiteral } from './xml.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').FilterIR} FilterIR
 * @typedef {import('../../model/types.js').PillIR} PillIR
 *
 * @typedef {Object} GroupfilterFacet
 * @property {'categorical'|'top'|'condition'|'wildcard'} kind
 * @property {any[]} [include]
 * @property {any[]} [exclude]
 * @property {{ from: any, to: any }[]} [ranges]  Shift-selected runs of members (function='range')
 * @property {boolean} [all]
 * @property {{ count: number|string, direction: 'top'|'bottom', by: string, members?: any[] }} [top]  members: the General tab's list it ranks within
 * @property {string} [expression]
 * @property {{ pattern: string, mode: 'contains'|'starts-with'|'ends-with'|'exact' }} [wildcard]
 * @property {string} [level]
 */

const WILDCARD_MODES = { contains: 'contains', startswith: 'starts-with', endswith: 'ends-with', exact: 'exact', exactmatch: 'exact', equals: 'exact', matches: 'exact' };

function memberValues(nodes) {
	const values = [];
	for (const n of nodes) {
		const fn = n.attr('function');
		if (fn === 'member') values.push(parseLiteral(n.attr('member')));
		else if (fn === 'union' || fn === 'intersection') values.push(...memberValues(n.all('groupfilter')));
	}
	return values;
}

function memberRanges(nodes) {
	const ranges = [];
	for (const n of nodes) {
		const fn = n.attr('function');
		if (fn === 'range') ranges.push({ from: parseLiteral(n.attr('from')), to: parseLiteral(n.attr('to')) });
		else if (fn === 'union' || fn === 'intersection') ranges.push(...memberRanges(n.all('groupfilter')));
	}
	return ranges;
}

/** Categorical facet of selected members and ranges; `include` is left out when only ranges are selected. */
function selection(values, ranges, key, level) {
	return { kind: 'categorical', ...(values.length || !ranges.length || key === 'exclude' ? { [key]: values } : {}), ...(ranges.length ? { ranges } : {}), level };
}

/** The members a subtracted subtree leaves out of the level, so `level-members \ except(level-members, X)` is X. */
function complement(facets, level, unknown) {
	const [f] = facets;
	if (facets.length !== 1 || f.kind !== 'categorical') {
		unknown.push('except of a nested filter');
		return { kind: 'categorical', all: true, level };
	}
	if (f.all) return { kind: 'categorical', include: [], level: f.level ?? level };
	if (f.exclude) return selection(f.exclude, f.ranges ?? [], 'include', f.level ?? level);
	return selection(f.include ?? [], f.ranges ?? [], 'exclude', f.level ?? level);
}

function firstLevel(gf) {
	if (gf.attr('level')) return gf.attr('level');
	for (const c of gf.descendants('groupfilter')) if (c.attr('level')) return c.attr('level');
	return undefined;
}

function wildcardFacet(gf) {
	const expression = gf.attr('expression') || '';
	const typeAttr = gf.attr('user:ui-pattern_type') || gf.attr('user:ui-pattern-type');
	let pattern = gf.attr('user:ui-pattern_text') ?? gf.attr('user:ui-pattern-text');
	if (!typeAttr && pattern === undefined) return null;
	if (pattern === undefined) {
		const m = /"((?:[^"]|"")*)"|'((?:[^']|'')*)'/.exec(expression);
		pattern = m ? (m[1] ?? m[2]).replace(/""/g, '"').replace(/''/g, "'") : '';
	}
	let mode = WILDCARD_MODES[String(typeAttr || '').toLowerCase().replace(/[^a-z]/g, '')];
	if (!mode) {
		if (/^\s*STARTSWITH\s*\(/i.test(expression)) mode = 'starts-with';
		else if (/^\s*ENDSWITH\s*\(/i.test(expression)) mode = 'ends-with';
		else if (/^\s*CONTAINS\s*\(/i.test(expression)) mode = 'contains';
		else mode = 'exact';
	}
	return { kind: 'wildcard', expression, wildcard: { pattern: String(pattern), mode }, level: firstLevel(gf) };
}

/**
 * Decode a <groupfilter> tree (filters and sets share this grammar) into facets.
 * @param {XmlNode} gf
 * @param {string[]} [unknown] Collects unrecognized function names
 * @returns {GroupfilterFacet[]}
 */
export function parseGroupfilter(gf, unknown = []) {
	const fn = gf.attr('function');
	const level = firstLevel(gf);
	const children = gf.all('groupfilter');
	switch (fn) {
		case 'member':
			return [{ kind: 'categorical', include: [parseLiteral(gf.attr('member'))], level }];
		case 'range':
			return [selection([], memberRanges([gf]), 'include', level)];
		case 'union': {
			const nonMembers = children.filter((c) => !['member', 'union', 'range'].includes(c.attr('function')));
			if (nonMembers.length && nonMembers.length === children.length) return children.flatMap((c) => parseGroupfilter(c, unknown));
			return [selection(memberValues(children), memberRanges(children), 'include', level)];
		}
		case 'except': {
			const [base, ...rest] = children;
			const baseFn = base?.attr('function');
			if (base && baseFn !== 'level-members' && rest.length === 0) {
				return parseGroupfilter(base, unknown).map((f) => ({ ...f, exclude: f.include ?? (f.ranges ? [] : undefined), include: undefined }));
			}
			const facets = [];
			if (base && baseFn && baseFn !== 'level-members') facets.push(...parseGroupfilter(base, unknown));
			const excluded = memberValues(rest);
			const ranges = memberRanges(rest);
			const kept = rest.filter((c) => c.attr('function') === 'except').map((c) => complement(parseGroupfilter(c, unknown), level, unknown));
			if (kept.length === 1 && !facets.length && kept[0].include && !ranges.length && !kept[0].ranges) {
				const drop = new Set(excluded.map((v) => JSON.stringify(v)));
				return [{ ...kept[0], include: kept[0].include.filter((v) => !drop.has(JSON.stringify(v))) }];
			}
			facets.push(...kept);
			if (excluded.length || ranges.length) facets.push(selection(excluded, ranges, 'exclude', level));
			else if (!facets.length) facets.push({ kind: 'categorical', all: true, level });
			return facets;
		}
		case 'level-members':
			return [{ kind: 'categorical', all: true, level }];
		case 'empty-level':
			return [{ kind: 'categorical', include: [], level }];
		case 'end': {
			const order = gf.descendants('groupfilter').find((c) => c.attr('function') === 'order');
			const rawCount = gf.attr('count');
			const count = rawCount !== undefined && /^-?\d+$/.test(rawCount.trim()) ? Number(rawCount) : rawCount ?? '';
			const direction = gf.attr('end') === 'bottom' ? 'bottom' : 'top';
			const top = { count, direction, by: order?.attr('expression') || '' };
			const domain = (order ?? gf).all('groupfilter').filter((c) => c.attr('function') !== 'order').flatMap((c) => parseGroupfilter(c, unknown));
			if (domain.length === 1 && domain[0].include && !domain[0].ranges) top.members = domain[0].include;
			return [{ kind: 'top', top, level }];
		}
		case 'order':
			return children.flatMap((c) => parseGroupfilter(c, unknown));
		case 'filter': {
			const wildcard = wildcardFacet(gf);
			const facets = [wildcard || { kind: 'condition', expression: gf.attr('expression') || '', level }];
			for (const c of children) {
				if (c.attr('function') !== 'level-members') facets.push(...parseGroupfilter(c, unknown));
			}
			return facets;
		}
		case 'intersection':
			return children.flatMap((c) => parseGroupfilter(c, unknown));
		default:
			unknown.push(fn || '(none)');
			return [];
	}
}

/**
 * @param {XmlNode} node <filter>
 * @param {{ resolvePill: (id: string) => PillIR, defaultDatasourceId?: string, issues?: import('../../model/types.js').Issue[], scope?: string }} ctx
 * @returns {FilterIR[]}
 */
export function parseFilter(node, ctx) {
	const column = node.attr('column');
	if (!column) return [];
	const pill = ctx.resolvePill(column);
	const base = {
		pillId: pill.id,
		datasourceId: pill.datasourceId || ctx.defaultDatasourceId || '',
		fieldId: pill.fieldId
	};
	if (node.attr('context') === 'true') base.context = true;
	if (pill.aggregated) base.aggregated = true;
	if (node.attr('kind') === 'hide') base.hidden = true;
	if (node.attr('filter-group')) base.group = node.attr('filter-group');

	const cls = node.attr('class');
	if (cls === 'quantitative') {
		const minRaw = node.childText('min');
		const maxRaw = node.childText('max');
		/** @type {FilterIR} */
		const f = { ...base, kind: isDateLiteral(minRaw) || isDateLiteral(maxRaw) ? 'range-date' : 'quantitative' };
		if (minRaw !== undefined && minRaw !== '') f.min = parseLiteral(minRaw);
		if (maxRaw !== undefined && maxRaw !== '') f.max = parseLiteral(maxRaw);
		f.includedValues = node.attr('included-values') || 'in-range';
		return [f];
	}
	if (cls === 'relative-date') {
		const relative = {
			periodType: node.attr('period-type-v2') || node.attr('period-type') || 'day',
			first: Number(node.attr('first-period') ?? 0),
			last: Number(node.attr('last-period') ?? 0)
		};
		const anchor = node.attr('anchor') ?? node.attr('anchor-date');
		if (anchor) relative.anchor = parseLiteral(anchor.startsWith('#') ? anchor : `#${anchor}#`);
		relative.includeNull = node.attr('include-null') === 'true';
		return [{ ...base, kind: 'relative-date', relative }];
	}

	const groupfilter = node.child('groupfilter');
	if (!groupfilter) return [{ ...base, kind: 'categorical', all: true, bare: true }];
	const unknown = [];
	const facets = parseGroupfilter(groupfilter, unknown);
	if (unknown.length && ctx.issues) {
		ctx.issues.push({
			severity: 'warning',
			code: 'twb.unknown-groupfilter',
			message: `Filter on ${pill.fieldId} uses unsupported groupfilter function(s): ${[...new Set(unknown)].join(', ')}`,
			object: { type: 'filter', name: pill.fieldId, id: ctx.scope }
		});
	}
	if (!facets.length) return [{ ...base, kind: 'categorical', all: true }];
	return facets.map((facet) => {
		/** @type {FilterIR} */
		const f = { ...base, kind: facet.kind };
		if (facet.include) f.include = facet.include;
		if (facet.exclude) f.exclude = facet.exclude;
		if (facet.ranges) f.ranges = facet.ranges;
		if (facet.all) f.all = true;
		if (facet.top) f.top = facet.top;
		if (facet.expression !== undefined) f.expression = facet.expression;
		if (facet.wildcard) f.wildcard = facet.wildcard;
		const level = facet.level ? parsePillId(facet.level).fieldId : undefined;
		if (level && level !== pill.fieldId) f.memberLevel = level;
		return f;
	});
}
