import { isRef } from '../util/refs.js';

const TOTAL_ORDER = /^SUM\(([\s\S]*)\) OVER \(PARTITION BY ([\s\S]*)\)$/;

/** Datasets whose queries run on a Cloud Amplifier warehouse rather than on Domo. */
export function warehouseDatasetKeys(plan) {
	const adrOutputs = new Set((plan.dataflows ?? []).filter((df) => df.definition?.databaseType === 'ADR').flatMap((df) => df.outputDatasetKeys ?? []));
	return new Set(
		(plan.datasets ?? [])
			.filter((d) => d.strategy === 'cloud-amplifier' || (d.strategy === 'view' && d.view?.cloudId) || adrOutputs.has(d.key))
			.map((d) => d.key)
	);
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
		const ds = card.body?.dataProvider?.dataSourceId;
		const key = isRef(ds) && ds.$ref.startsWith('dataset:') ? ds.$ref.slice(8) : card.datasetKey;
		const formulas = card.body?.definition?.formulas?.card;
		if (!warehouse.has(key) || !formulas?.length) continue;
		const dropped = new Set();
		let fixed = 0;
		for (const f of formulas) {
			if (!/\(total order\)$/.test(f.name ?? '')) continue;
			const m = TOTAL_ORDER.exec(String(f.formula).trim());
			const parts = m ? topLevelParts(m[2]) : [];
			if (m && parts.every((p) => /^`[^`]+`$/.test(p))) {
				f.formula = `MAX(${m[1]} FIXED (BY ${parts.join(', ')}))`;
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
			message: `${card.title}: the dataset is on the warehouse, where a card cannot sort by a window function, so ${[fixed ? `${fixed} total-order sort(s) use a FIXED total` : '', dropped.size ? `${dropped.size} total-order sort(s) that group by an expression were left out; those headers list members in query order` : ''].filter(Boolean).join(', and ')}.`,
			object: { type: 'worksheet', name: card.worksheet ?? card.title }
		});
	}
	return issues;
}
