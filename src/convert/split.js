import { slugify } from '../util/ids.js';
import { rule } from './colors.js';
import { quoteString } from './calc/sql.js';

/**
 * Small multiples Domo cannot draw in one chart become one card per member (CardPlan.split). Members known at convert
 * are expanded into the plan; the rest are read from the Domo dataset at push. Pure.
 */

export const MAX_SPLIT_CARDS = 6;
// Phoenix drops a chart's axes, data labels and legend below a 105px plot, and a
// card's title and frame take about 66px more: 14 standard rows (12.65px) and 6 compact (31.5px), checked in the viewer.
export const MIN_SPLIT_HEIGHT = { standard: 14, compact: 6 };
// Stands for the member condition in CardPlan.split.measures formulas.
export const SPLIT_MEMBER = '__t2d_split_member__';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Members in Tableau's pane order: the pill's manual order, else ascending (descending when the pill sorts so). */
export function orderSplitMembers(members, split = {}) {
	const unique = [...new Set(members.filter((m) => m !== null && m !== undefined && m !== '').map(String))];
	if (split.order?.length) {
		const rank = new Map(split.order.map((m, i) => [String(m), i]));
		return unique.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || collator.compare(a, b));
	}
	unique.sort(collator.compare);
	return split.direction === 'DESC' ? unique.reverse() : unique;
}

function memberKeys(key, members) {
	const used = new Set();
	return members.map((m) => {
		const base = `${key}.${slugify(m)}`;
		let k = base;
		for (let n = 2; used.has(k); n++) k = `${base}-${n}`;
		used.add(k);
		return k;
	});
}

function withSuffix(items, suffix) {
	const last = items.at(-1);
	return last?.type === 'TEXT' ? [...items.slice(0, -1), { ...last, text: last.text + suffix }] : [...items, { type: 'TEXT', text: suffix }];
}

function memberCard(card, key, member) {
	const out = structuredClone(card);
	delete out.split;
	out.key = key;
	out.splitOf = { key: card.key, member };
	out.title = `${card.title}: ${member}`;
	const def = out.body.definition;
	def.title = out.title;
	def.dynamicTitle = { ...def.dynamicTitle, text: withSuffix(def.dynamicTitle?.text ?? [{ type: 'TEXT', text: card.title }], `: ${member}`) };
	const main = def.subscriptions.main;
	const renamed = card.split.measures ? memberMeasures(out, card.split, member) : new Map();
	if (!card.split.measures) main.filters = [...(main.filters ?? []), { ...card.split.filter, values: [member] }];
	const hex = card.split.colors?.[member];
	if (hex) {
		const rules = def.conditionalFormats?.card ?? [];
		for (const column of card.split.colorColumns ?? []) rules.push(rule(renamed.get(column) ?? column, [], hex, main.dataSourceId));
		def.conditionalFormats = { ...def.conditionalFormats, card: rules };
	}
	return out;
}

function memberLiteral(member, dataType) {
	return dataType === 'string' || !Number.isFinite(Number(member)) ? quoteString(member) : String(Number(member));
}

/** The member card's value columns become card formulas limited to the member's rows. Returns old column -> new id. */
function memberMeasures(card, split, member) {
	const def = card.body.definition;
	const formulas = def.formulas.card;
	const condition = `(${split.expression} = ${memberLiteral(member, split.filter?.dataType)})`;
	const renamed = new Map();
	for (const m of split.measures) {
		const formula = m.formula.split(SPLIT_MEMBER).join(condition);
		const own = formulas.find((f) => f.id === m.column);
		if (own) {
			own.formula = formula;
			continue;
		}
		let n = formulas.length + 1;
		while (formulas.some((f) => f.id === `calculation_card_${n}`)) n += 1;
		const id = `calculation_card_${n}`;
		let name = m.name;
		for (let k = 2; formulas.some((f) => f.name.toLowerCase() === name.toLowerCase()); k++) name = `${m.name} (${k})`;
		formulas.push({ id, name, formula, templateId: -1, status: 'VALID', dataType: 'numeric', isCalculation: true, aggregated: true, persistedOnDataSource: false });
		renamed.set(m.column, id);
	}
	const rename = (c) => {
		const id = renamed.get(c?.column);
		if (!id) return;
		c.column = id;
		c.formulaId = id;
		delete c.aggregation;
	};
	const main = def.subscriptions.main;
	for (const c of [...main.columns, ...(main.orderBy ?? []), ...(card.bigNumber?.columns ?? [])]) rename(c);
	for (const r of def.conditionalFormats?.card ?? []) if (renamed.has(r.condition?.column)) r.condition.column = renamed.get(r.condition.column);
	return renamed;
}

const isRefTo = (value, key) => value && typeof value === 'object' && value.$ref === `card:${key}`;

/**
 * One template item becomes `n` stacked items splitting its height (rounded up, at least `min`); items below move down by
 * the excess, and items beside it that end on its bottom grow by it, so the template stays tiled.
 */
function stackItems(template, contentKey, keys, min = 1) {
	const n = keys.length;
	const out = [];
	for (const item of template) {
		if (item.contentKey !== contentKey) continue;
		const height = Math.max(min, Math.ceil(item.height / n));
		const bottom = item.y + item.height;
		const extra = height * n - item.height;
		if (extra > 0) {
			for (const other of template) {
				if (other === item) continue;
				if (other.y >= bottom) other.y += extra;
				else if (other.y + other.height === bottom) other.height += extra;
			}
		}
		keys.forEach((k, i) => out.push({ ...item, contentKey: k, y: item.y + i * height, height }));
	}
	return template.filter((item) => item.contentKey !== contentKey).concat(out);
}

function splitLayout(layout, key, keys) {
	if (!layout?.content) return;
	const templates = Object.entries(layout).filter(([, v]) => Array.isArray(v?.template));
	let next = Math.max(0, ...layout.content.map((c) => Number(c.contentKey) || 0));
	for (const content of [...layout.content]) {
		if (!isRefTo(content.cardId, key)) continue;
		const contentKeys = keys.map((_, i) => (i === 0 ? content.contentKey : ++next));
		const copies = keys.map((k, i) => ({ ...structuredClone(content), contentKey: contentKeys[i], cardId: { ...content.cardId, $ref: `card:${k}` } }));
		layout.content.splice(layout.content.indexOf(content), 1, ...copies);
		for (const [name, t] of templates) t.template = stackItems(t.template, content.contentKey, contentKeys, MIN_SPLIT_HEIGHT[name]);
	}
	for (const content of layout.content) {
		const urns = content.interaction?.config?.selectedCardUrns;
		if (!Array.isArray(urns)) continue;
		content.interaction.config.selectedCardUrns = urns.flatMap((u) => (isRefTo(u, key) ? keys.map((k) => ({ ...u, $ref: `card:${k}` })) : [u]));
	}
}

/**
 * Replace a split card with one card per member in the plan's cards and page layouts.
 * @param {Object} plan  DomoPlan, changed in place
 * @param {string} key   card key
 * @param {Array<string|number>} found  members as the data holds them
 * @returns {{ expanded: boolean, reason?: string, keys?: string[] }}
 */
export function expandSplitCard(plan, key, found) {
	const index = (plan.cards ?? []).findIndex((c) => c.key === key);
	const card = plan.cards[index];
	if (!card?.split) return { expanded: false, reason: 'not a split card' };
	const members = orderSplitMembers(found, card.split);
	const max = card.split.max ?? MAX_SPLIT_CARDS;
	if (!members.length) return { expanded: false, reason: `no ${card.split.name} member has rows` };
	if (members.length > max) return { expanded: false, reason: `${card.split.name} has ${members.length} members, more than ${max} cards` };
	if (members.length === 1) {
		const one = memberCard(card, key, members[0]);
		one.title = card.title;
		delete one.splitOf;
		Object.assign(one.body.definition, { title: card.title, dynamicTitle: card.body.definition.dynamicTitle });
		plan.cards[index] = one;
		return { expanded: true, keys: [key] };
	}
	const keys = memberKeys(key, members);
	plan.cards.splice(index, 1, ...members.map((m, i) => memberCard(card, keys[i], m)));
	for (const page of plan.pages ?? []) splitLayout(page.layout, key, keys);
	return { expanded: true, keys };
}

/** Expand every split card whose members convert already knows (an include filter on the split field). */
export function expandKnownSplits(plan) {
	const issues = [];
	for (const card of [...(plan.cards ?? [])]) {
		if (!card.split?.members) continue;
		const result = expandSplitCard(plan, card.key, card.split.members);
		if (!result.expanded) {
			delete card.split;
			issues.push({ severity: 'warning', code: 'chart.small-multiples', message: `${card.title}: kept as one card (${result.reason}); its panes are drawn together`, object: { type: 'worksheet', name: card.worksheet } });
		}
	}
	return issues;
}
