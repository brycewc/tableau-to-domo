import { isRef } from '../util/refs.js';

const TOTAL_ORDER = /^SUM\(([\s\S]*)\) OVER \(PARTITION BY ([\s\S]*)\)$/;
const AGGREGATES = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT']);
const SQL_LITERAL = /^'((?:[^']|'')*)'$/;
const MAX_BACKREFERENCE = 9;

/** Datasets whose queries run on a Cloud Amplifier warehouse rather than on Domo. */
export function warehouseDatasetKeys(plan) {
	const adrOutputs = new Set((plan.dataflows ?? []).filter((df) => df.definition?.databaseType === 'ADR').flatMap((df) => df.outputDatasetKeys ?? []));
	return new Set(
		(plan.datasets ?? [])
			.filter((d) => d.strategy === 'cloud-amplifier' || (d.strategy === 'view' && d.view?.cloudId) || adrOutputs.has(d.key))
			.map((d) => d.key)
	);
}

function quoteEnd(text, start) {
	const q = text[start];
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] !== q) continue;
		if (text[i + 1] === q) i++;
		else return i + 1;
	}
	return text.length;
}

function closingParen(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; ) {
		const ch = text[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			i = quoteEnd(text, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')' && --depth === 0) return i;
		i++;
	}
	return -1;
}

function topLevelParts(text) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '`' || ch === '"') quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts;
}

function* words(text) {
	for (let i = 0; i < text.length; ) {
		const ch = text[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			yield { quoted: ch, start: i, end: (i = quoteEnd(text, i)) };
			continue;
		}
		const word = /^[A-Za-z_]\w*/.exec(text.slice(i));
		if (word && !/\w/.test(text[i - 1] ?? '')) {
			yield { word: word[0].toUpperCase(), start: i, end: (i += word[0].length) };
			continue;
		}
		i++;
	}
}

const callOpen = (text, end) => {
	const gap = /^\s*/.exec(text.slice(end))[0].length;
	return text[end + gap] === '(' ? end + gap : -1;
};

// FIXED goes after each aggregate call: Domo takes FIXED only after a function call (dataShared BeastMode.g4
// `function_expression fixed_expression`). Undefined when the measure cannot be expressed that way.
export function fixedAt(measure, levels) {
	const text = String(measure ?? '');
	const by = ` FIXED (BY ${levels.join(', ')})`;
	let out = '';
	let at = 0;
	let calls = 0;
	let skipTo = 0;
	for (const w of words(text)) {
		if (w.start < skipTo) continue;
		if (w.quoted) {
			if (w.quoted !== "'") return undefined;
			continue;
		}
		if (w.word === 'OVER' || w.word === 'FIXED') return undefined;
		const open = AGGREGATES.has(w.word) ? callOpen(text, w.end) : -1;
		if (open < 0) continue;
		const close = closingParen(text, open);
		if (close < 0) return undefined;
		const inner = text.slice(open + 1, close);
		for (const x of words(inner)) if (x.word === 'OVER' || x.word === 'FIXED' || (AGGREGATES.has(x.word) && callOpen(inner, x.end) >= 0)) return undefined;
		out += `${text.slice(at, close + 1)}${by}`;
		at = skipTo = close + 1;
		calls++;
	}
	return calls ? out + text.slice(at) : undefined;
}

/**
 * A warehouse card cannot sort by a window function ("is not a valid order by expression", live-checked), and FIXED BY an
 * expression fails there too: a total-order key over plain columns becomes a FIXED total, any other is dropped.
 * @param {import('../model/types.js').DomoPlan} plan
 * @returns {import('../model/types.js').Issue[]}
 */
export function warehouseSafeSorts(plan) {
	const warehouse = warehouseDatasetKeys(plan);
	const issues = [];
	for (const card of plan.cards ?? []) {
		const formulas = card.body?.definition?.formulas?.card;
		if (!warehouse.has(cardDatasetKey(card)) || !formulas?.length) continue;
		const dropped = new Set();
		let fixed = 0;
		for (const f of formulas) {
			if (!/\(total order\)$/.test(f.name ?? '')) continue;
			const m = TOTAL_ORDER.exec(String(f.formula).trim());
			const parts = m ? topLevelParts(m[2]) : [];
			const total = m && parts.every((p) => /^`[^`]+`$/.test(p)) ? fixedAt(m[1], parts) : undefined;
			if (total) {
				f.formula = `MAX(${total})`;
				fixed++;
			} else dropped.add(f.id);
		}
		if (!fixed && !dropped.size) continue;
		if (dropped.size) {
			card.body.definition.formulas.card = formulas.filter((f) => !dropped.has(f.id));
			for (const sub of Object.values(card.body.definition.subscriptions ?? {})) {
				if (Array.isArray(sub.orderBy)) sub.orderBy = sub.orderBy.filter((o) => !dropped.has(o.formulaId) && !dropped.has(o.column));
			}
		}
		issues.push({
			severity: dropped.size ? 'warning' : 'info',
			code: 'card.warehouse-total-order',
			message: `${card.title}: the dataset is on the warehouse, where a card cannot sort by a window function, so ${[fixed ? `${fixed} total-order sort(s) use a FIXED total` : '', dropped.size ? `${dropped.size} total-order sort(s) that group by an expression or whose measure cannot take FIXED were left out; those headers list members in query order` : ''].filter(Boolean).join(', and ')}.`,
			object: { type: 'worksheet', name: card.worksheet ?? card.title }
		});
	}
	return issues;
}

function cardDatasetKey(card) {
	const ds = card.body?.dataProvider?.dataSourceId;
	return isRef(ds) && ds.$ref.startsWith('dataset:') ? ds.$ref.slice(8) : card.datasetKey;
}

// Domo-stored data reads `$n` in a REGEXP_REPLACE replacement; Snowflake gets the call unchanged and reads `\n`
// (SnowflakeFunctionTranslator.convertREGEXP_REPLACE), so `$0` becomes a group around the pattern.
export function warehouseBackreferences(plan) {
	const warehouse = warehouseDatasetKeys(plan);
	if (!warehouse.size) return;
	for (const bm of plan.beastModes ?? []) if (warehouse.has(bm.datasetKey) && typeof bm.expression === 'string') bm.expression = snowflakeBackreferences(bm.expression);
	for (const card of plan.cards ?? []) {
		if (!warehouse.has(cardDatasetKey(card))) continue;
		for (const f of card.body?.definition?.formulas?.card ?? []) if (typeof f.formula === 'string') f.formula = snowflakeBackreferences(f.formula);
	}
}

export function snowflakeBackreferences(sql) {
	const text = String(sql);
	let out = '';
	let at = 0;
	let skipTo = 0;
	for (const w of words(text)) {
		if (w.start < skipTo || w.word !== 'REGEXP_REPLACE') continue;
		const open = callOpen(text, w.end);
		const close = open < 0 ? -1 : closingParen(text, open);
		if (close < 0) continue;
		const inner = snowflakeBackreferences(text.slice(open + 1, close));
		const args = snowflakeReplaceArgs(topLevelParts(inner));
		out += `${text.slice(at, open + 1)}${args ? args.join(', ') : inner})`;
		at = skipTo = close + 1;
	}
	return out + text.slice(at);
}

function snowflakeReplaceArgs(args) {
	const pattern = SQL_LITERAL.exec(args[1] ?? '');
	const replacement = SQL_LITERAL.exec(args[2] ?? '');
	if (!pattern || !replacement || !/\$\d/.test(replacement[1])) return undefined;
	const whole = /\$0/.test(replacement[1]);
	const shift = whole ? 1 : 0;
	if ([...replacement[1].matchAll(/\$(\d)/g)].some((m) => Number(m[1]) + shift > MAX_BACKREFERENCE)) return undefined;
	const swapped = replacement[1].replace(/\$(\d)/g, (_, n) => `\\${Number(n) + shift}`);
	return [args[0], whole ? `'(${pattern[1]})'` : args[1], `'${swapped}'`, ...args.slice(3)];
}
