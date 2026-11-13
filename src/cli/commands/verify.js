import { UsageError, requireWorkbookArg } from '../shared.js';
import { createEmitter } from '../../util/events.js';
import { verifyWorkbook } from '../../pipeline/verify.js';
import { openWorkspace } from '../../pipeline/workspace.js';
import { formatTable } from '../reporter.js';

export const name = 'verify';
export const summary = 'Compare pushed Domo cards with the Tableau view data they came from; read only';
export const usage = 't2d verify --workbook <slug> [--tolerance <pct>] [--keys <keys>]';
export const options = {
	workbook: { type: 'string', short: 'w', value: '<slug|name>', description: 'Pushed workbook' },
	tolerance: { type: 'string', value: '<pct>', description: 'Allowed difference of measure totals, in percent (default 0.5)' },
	keys: { type: 'string', value: '<keys>', description: 'Comma list of card plan keys; * globs' }
};

const STATUS_TEXT = { ok: 'ok', differs: 'differs', 'not-comparable': 'not comparable' };

function parseTolerance(value) {
	if (value === undefined) return 0.005;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) throw new UsageError(`--tolerance must be a non-negative percentage, got "${value}"`);
	return n / 100;
}

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 4 }));

/** One-line detail of a card check. */
export function cardDetail(card) {
	const parts = [];
	if (card.rows) parts.push(`rows ${card.rows.tableau} Tableau / ${card.rows.domo} Domo`);
	for (const c of card.columns ?? []) {
		if (c.role === 'measure') {
			const mark = c.compared === false ? '' : c.ok ? ' ok' : ' DIFFERS';
			parts.push(`${c.domo}: ${fmt(c.tableauTotal)} / ${fmt(c.domoTotal)}${mark}`);
		} else if (!c.ok || c.missingInDomo || c.extraInDomo) {
			const bits = [];
			if (c.missingInDomo) bits.push(`only Tableau: ${c.missingInDomo.join(', ')}`);
			if (c.extraInDomo) bits.push(`only Domo: ${c.extraInDomo.join(', ')}`);
			parts.push(`${c.domo} members ${c.tableauMembers}/${c.domoMembers}${bits.length ? ` (${bits.join('; ')})` : ''}`);
		}
	}
	return [...parts, ...(card.notes ?? [])].join('; ');
}

/** @param {import('../main.js').CommandContext} ctx */
export async function run({ config, args, reporter }) {
	const tolerance = parseTolerance(args.values.tolerance);
	const keys = args.values.keys
		? String(args.values.keys)
				.split(',')
				.map((k) => k.trim())
				.filter(Boolean)
		: undefined;
	const ws = openWorkspace(config.workspace);
	const slug = await ws.resolveSlug(requireWorkbookArg(args.values, args.positionals));
	const summary = await verifyWorkbook({ config, slug, tolerance, keys, emitter: createEmitter(reporter.sink, 'verify') });

	const rows = summary.cards.map((c) => [c.title, STATUS_TEXT[c.status] + (c.sampled && c.status !== 'not-comparable' ? ' (sample)' : ''), c.view ?? '', c.cardId ?? '', cardDetail(c)]);
	reporter.print(rows.length ? formatTable(['Card', 'Status', 'Tableau view', 'Card id', 'Detail'], rows) : 'No cards in the plan.');
	const n = summary.counts;
	reporter.print(`\n${slug} on ${summary.instance}: ${n.ok} ok, ${n.differs} differ, ${n['not-comparable']} not comparable (tolerance ${tolerance * 100}%)`);
	for (const c of summary.cards.filter((x) => x.drawLimited)) {
		const d = c.drawLimited;
		reporter.print(`Draw limit: "${c.title}" (${c.cardId}) is drawn from ${fmt(d.limit)} of ${fmt(d.rows)}${d.atLeast ? '+' : ''} rows, so it shows part of the data.`);
	}
	for (const s of summary.searchStubs ?? []) {
		reporter.print(`Search: app view "${s.title}" (${s.viewId}) has a title-less page entry; it shows as "${s.viewId}" in Apps & Dashboards and search.`);
	}
	if (summary.sampled) {
		reporter.print(`Sampled data (${summary.sampled} rows per table): cards were only checked for rows and members Tableau lacks, not for totals.`);
	}
	return summary;
}
