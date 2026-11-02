import { collectRefs } from '../util/refs.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const fiscalStartName = (month) => MONTH_NAMES[month - 1] ?? String(month);

/**
 * @typedef {import('../model/types.js').FiscalCalendarNeed} FiscalCalendarNeed
 *
 * @typedef {Object} CalendarTarget
 * @property {string} target                    'instance' or 'integration:<id>'
 * @property {number} startMonth
 * @property {FiscalCalendarNeed['source']} source
 * @property {{ key: string, title: string }[]} cards
 */

/** A dataset Cloud Amplifier queries live (a registered table, or a view over them) uses its integration's calendar. */
export function calendarSource(datasetKey, datasets) {
	const byKey = new Map(datasets.map((d) => [d.key, d]));
	const integrationOf = (key, seen = new Set()) => {
		const ds = byKey.get(key);
		if (!ds || seen.has(key)) return undefined;
		seen.add(key);
		if (ds.strategy === 'cloud-amplifier') return ds.cloudAmplifier?.integrationId;
		if (ds.strategy !== 'view') return undefined;
		if (ds.view?.cloudId) return ds.view.cloudId;
		const inputs = [...collectRefs(ds.view)].filter((r) => r.startsWith('dataset:')).map((r) => integrationOf(r.slice(8), seen));
		return inputs.length && inputs.every((id) => id && id === inputs[0]) ? inputs[0] : undefined;
	};
	const integrationId = integrationOf(datasetKey);
	return integrationId ? { integrationId: String(integrationId) } : 'instance';
}

export function assignCalendarSources(cards, datasets) {
	for (const card of cards) {
		const views = (card.drillPath ?? []).filter((v) => v.fiscalCalendar);
		if (!card.fiscalCalendar && !views.length) continue;
		const source = calendarSource(card.datasetKey, datasets);
		if (card.fiscalCalendar) card.fiscalCalendar.source = source;
		for (const view of views) view.fiscalCalendar.source = source;
	}
}

export const targetOf = (source) => (source === 'instance' ? 'instance' : `integration:${source?.integrationId}`);

export const targetLabel = (target) => (target === 'instance' ? 'the Domo instance' : `Cloud Amplifier integration ${target.slice('integration:'.length)}`);

/** @returns {CalendarTarget[]} */
export function calendarNeeds(plan, include = () => true) {
	const needs = new Map();
	for (const card of plan?.cards ?? []) {
		if (card.status === 'unsupported' || card.replacedBy || !include(card)) continue;
		const calendars = [card.fiscalCalendar, ...(card.drillPath ?? []).map((v) => v.fiscalCalendar)].filter((c) => c?.source);
		for (const cal of calendars) {
			const target = targetOf(cal.source);
			const id = `${target}\u0000${cal.startMonth}`;
			const need = needs.get(id) ?? { target, startMonth: cal.startMonth, source: cal.source, cards: [] };
			needs.set(id, need);
			if (!need.cards.some((c) => c.key === card.key)) need.cards.push({ key: card.key, title: card.title });
		}
	}
	return [...needs.values()];
}

/** An instance or integration holds one fiscal calendar: the start most cards need wins, and on a tie none does. */
export function calendarConflicts(needs) {
	const byTarget = new Map();
	for (const n of needs) byTarget.set(n.target, [...(byTarget.get(n.target) ?? []), n]);
	const out = [];
	for (const group of byTarget.values()) {
		const counts = new Map();
		for (const n of group) counts.set(n.startMonth, (counts.get(n.startMonth) ?? 0) + n.cards.length);
		if (counts.size < 2) continue;
		const top = Math.max(...counts.values());
		const winners = [...counts].filter(([, c]) => c === top).map(([m]) => m);
		for (const n of group) {
			if (winners.length === 1 && winners[0] === n.startMonth) continue;
			out.push({ need: n, competing: group.filter((o) => o.startMonth !== n.startMonth) });
		}
	}
	return out;
}

export function planCalendarConflicts(plan) {
	return calendarConflicts(calendarNeeds(plan)).flatMap(({ need, competing }) =>
		need.cards.map((card) => ({
			severity: 'warning',
			code: 'convert.fiscal-conflict',
			message: `This card needs a fiscal year starting in ${fiscalStartName(need.startMonth)} on ${targetLabel(need.target)}, but other cards of this workbook need ${[...new Set(competing.map((c) => fiscalStartName(c.startMonth)))].join(' or ')}, and it holds one fiscal calendar`,
			object: { type: 'card', name: card.title, id: card.key },
			suggestion: 'Keep the fiscal calendar most cards need; rebuild the dates of these cards with fiscal beast modes, or move their data to another Cloud Amplifier integration.'
		}))
	);
}
