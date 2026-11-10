import { calendarConflicts, calendarNeeds, fiscalStartName, targetLabel } from '../convert/fiscal.js';
import { getInstanceCalendarTable, getIntegrationFiscalCalendar, queryStandardCalendar, registerIntegrationFiscalCalendar, updateIntegrationFiscalCalendar, validateIntegrationFiscalCalendar } from '../domo/calendars.js';
import { getDatasetTable, isWarehouseTableName, renameDatasetTable } from '../domo/cloud-amplifier.js';
import { fiscalCalendarDataflow } from '../magic/fiscal-calendar.js';
import { getEntry, setEntry } from './state.js';

/** @typedef {import('../model/types.js').Issue} Issue */

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d = 1) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** Dates whose StandardCalendar rows show whether a fiscal year starts on the 1st of `startMonth`, named by its end year. */
export function probeDates(startMonth, year) {
	return { start: `${year}-${pad(startMonth)}-01`, secondQuarter: iso(year, startMonth + 3), dayBefore: iso(year, startMonth, 0) };
}

/** @returns {{ ok: boolean, seen: string }} */
export function matchesInstanceCalendar(rows, startMonth, year) {
	const dates = probeDates(startMonth, year);
	const start = rows.get(dates.start);
	const q2 = rows.get(dates.secondQuarter);
	const before = rows.get(dates.dayBefore);
	const seen = start ? `${dates.start} is in year ${start.Year}, quarter ${start.QuarterOfYear}, of a year starting ${start.YearStart}` : `${dates.start} is not in the calendar`;
	const ok = Boolean(start && q2 && before && start.QuarterOfYear === 1 && start.YearStart === dates.start && start.Year === year + 1 && q2.QuarterOfYear === 2 && before.QuarterOfYear === 4 && before.Year === year);
	return { ok, seen };
}

const setupText = (need) => `a month-boundary fiscal calendar whose year starts in ${fiscalStartName(need.startMonth)}, labelled by the year it ends (${fiscalStartName(need.startMonth)} 2025 starts FY2026)`;

function suggestionFor(need) {
	const after = 'The cards are pushed with the fiscal calendar on and show the right periods once it exists.';
	if (need.target === 'instance') return `In Domo company settings, set the Fiscal Calendar to ${setupText(need)}. ${after}`;
	return `In Data Center, open the Cloud Amplifier integration, click the wrench > Set up calendar, and register ${setupText(need)}, with "Label fiscal year by end year" on. ${after} On a writeable integration, push builds and registers it.`;
}

const cardIssues = (need, severity, code, message, suggestion) =>
	need.cards.map((card) => ({ severity, code, message, object: { type: 'card', name: card.title, id: card.key }, ...(suggestion ? { suggestion } : {}) }));

const sameTable = (a, b) => Boolean(a && b) && ['database', 'schema', 'table'].every((k) => String(a[k]).toUpperCase() === String(b[k]).toUpperCase());

export const calendarRef = (integrationId) => `fiscalcalendar:${integrationId}`;

/** For a writeable integration without a fiscal calendar. The state entry has no workbook stamp, so unpush keeps it.
 * @param {{ state: import('../model/types.js').PushState, dataflows: typeof import('../domo/dataflows.js'), others?: { slug: string, needs: any[] }[], emitter?: any }} opts */
export async function provisionFiscalCalendars(c, needs, { state, dataflows, others = [], emitter, sources = {} }) {
	const issues = [];
	const contested = new Set(calendarConflicts([...needs, ...others.flatMap((o) => o.needs)]).map((x) => x.need.target));
	for (const need of needs.filter((n) => n.target !== 'instance' && !contested.has(n.target))) {
		const id = need.source.integrationId;
		const ref = calendarRef(id);
		try {
			const { name, calendar, writeback } = await getIntegrationFiscalCalendar(c, id);
			const source = sources[id];
			const entry = getEntry(state, ref);
			const own = Boolean(calendar && entry?.extra?.table && sameTable(entry.extra.table, calendar));
			if (source && source.startMonth !== need.startMonth) throw new Error(`mappings.json fiscalCalendars maps ${source.table}, whose year starts in ${fiscalStartName(source.startMonth)}, but these cards need ${fiscalStartName(need.startMonth)}`);
			if (!writeback || (calendar && !(own && source && entry.extra.source !== source.table))) {
				if (own && entry.extra.datasetId) {
					const table = await nameCalendarTable(c, id, entry.extra.datasetId, entry.extra.startMonth ?? need.startMonth);
					if (!sameTable(table, calendar)) {
						await updateIntegrationFiscalCalendar(c, id, table);
						setEntry(state, ref, { extra: { table } });
						issues.push({ severity: 'info', code: 'push.fiscal-calendar-renamed', message: `Renamed the fiscal calendar table of Cloud Amplifier integration "${name}" (${id}) to ${table.database}.${table.schema}.${table.table}`, object: { type: 'dataflow', name: 'fiscal calendar', id: String(entry.id) } });
					}
				}
				continue;
			}
			emitter?.progress(`Building the ${fiscalStartName(need.startMonth)} fiscal calendar for Cloud Amplifier integration "${name}"${source ? ` from ${source.table}` : ''}`, { ref });
			const def = fiscalCalendarDataflow({ integrationId: id, integrationName: name, startMonth: need.startMonth, source, ...(entry?.id == null ? { table: { ...writeback, table: calendarTableName(need.startMonth) } } : {}) });
			let dataflowId = entry?.id;
			if (dataflowId == null) {
				dataflowId = (await dataflows.createDataflow(c, def))?.id;
				if (dataflowId == null) throw new Error('createDataflow returned no id');
				setEntry(state, ref, { id: dataflowId, extra: { startMonth: need.startMonth } });
			} else {
				await dataflows.updateDataflow(c, dataflowId, def);
				setEntry(state, ref, { extra: { startMonth: need.startMonth } });
			}
			const started = await dataflows.runDataflow(c, dataflowId);
			await dataflows.waitForExecution(c, dataflowId, started?.id);
			const datasetId = dataflows.outputDatasetIds(await dataflows.getDataflow(c, dataflowId))[0];
			if (!datasetId) throw new Error(`dataflow ${dataflowId} has no output dataset`);
			const table = await nameCalendarTable(c, id, datasetId, need.startMonth);
			const valid = await validateIntegrationFiscalCalendar(c, id, table);
			if (!valid.success) throw new Error(`the table ${table.database}.${table.schema}.${table.table} it wrote is not a valid calendar: ${valid.message}`);
			if (calendar) await updateIntegrationFiscalCalendar(c, id, table);
			else await registerIntegrationFiscalCalendar(c, id, table);
			setEntry(state, ref, { extra: { startMonth: need.startMonth, datasetId, table, ...(source ? { source: source.table } : {}) } });
			issues.push({
				severity: 'info',
				code: 'push.fiscal-calendar-created',
				message: `Registered ${setupText(need)} on Cloud Amplifier integration "${name}" (${id}): ${table.database}.${table.schema}.${table.table}, written by dataflow ${dataflowId}${source ? ` from ${source.table}` : ''}`,
				object: { type: 'dataflow', name: def.name, id: String(dataflowId) }
			});
		} catch (err) {
			issues.push(...cardIssues(need, 'warning', 'push.fiscal-calendar-failed', `Could not build ${setupText(need)} on Cloud Amplifier integration ${id}: ${err.message}`, suggestionFor(need)));
		}
	}
	return issues;
}

// Not T2D_...: ice reads a calendar name starting with T as a schema-id table and never resolves it (DatasourceExtractor.getDatasourceMap).
const calendarTableName = (startMonth) => `FISCAL_CALENDAR_${fiscalStartName(startMonth).toUpperCase()}_START`;

async function nameCalendarTable(c, integrationId, datasetId, startMonth) {
	const wanted = calendarTableName(startMonth);
	let current = await getDatasetTable(c, integrationId, datasetId);
	if (!isWarehouseTableName(current?.tableName, wanted)) current = { ...current, ...(await renameDatasetTable(c, integrationId, datasetId, { database: current.database, schemaName: current.schemaName, tableName: wanted })) };
	return { database: current.database, schema: current.schemaName, table: current.tableName };
}

/** Reads only. A calendar t2d registered (`state`) is known to match. @returns {Promise<Issue[]>} */
export async function checkFiscalCalendars(c, needs, { instance = 'the instance', now = new Date(), state } = {}) {
	if (!needs.length) return [];
	if (!c) {
		return needs.flatMap((need) => cardIssues(need, 'warning', 'push.fiscal-calendar-unchecked', `These cards need ${setupText(need)} on ${targetLabel(need.target)}, which was not checked: no Domo credentials`, suggestionFor(need)));
	}
	const year = now.getUTCFullYear() - 1;
	const issues = [];
	const instanceNeeds = needs.filter((n) => n.target === 'instance');
	if (instanceNeeds.length) {
		try {
			const table = await getInstanceCalendarTable(c);
			const rows = await queryStandardCalendar(c, instanceNeeds.flatMap((n) => Object.values(probeDates(n.startMonth, year))));
			for (const need of instanceNeeds) {
				const { ok, seen } = matchesInstanceCalendar(rows, need.startMonth, year);
				if (ok) continue;
				const has = table ? `its company fiscal calendar (${table}) does not match: ${seen}` : `it has no custom fiscal calendar (${seen})`;
				issues.push(...cardIssues(need, 'warning', table ? 'push.fiscal-calendar-wrong' : 'push.fiscal-calendar-missing', `These cards need ${setupText(need)} on ${instance}, but ${has}`, suggestionFor(need)));
			}
		} catch (err) {
			for (const need of instanceNeeds) issues.push(...cardIssues(need, 'warning', 'push.fiscal-calendar-unchecked', `These cards need ${setupText(need)} on ${instance}, which could not be checked: ${err.message}`, suggestionFor(need)));
		}
	}
	for (const need of needs.filter((n) => n.target !== 'instance')) {
		const id = need.source.integrationId;
		try {
			const { name, calendar } = await getIntegrationFiscalCalendar(c, id);
			const label = `Cloud Amplifier integration "${name}" (${id})`;
			if (!calendar) {
				issues.push(...cardIssues(need, 'warning', 'push.fiscal-calendar-missing', `These cards query ${label} live and need ${setupText(need)}, but the integration has no fiscal calendar registered, so Domo refuses to render them`, suggestionFor(need)));
				continue;
			}
			const own = state && getEntry(state, calendarRef(id))?.extra;
			if (own?.startMonth === need.startMonth && sameTable(own.table, calendar)) continue;
			const table = [calendar.database, calendar.schema, calendar.table].filter(Boolean).join('.');
			issues.push(...cardIssues(need, 'warning', 'push.fiscal-calendar-unverified', `These cards query ${label} live and need ${setupText(need)}; the integration has the fiscal calendar ${table} registered, whose rows t2d cannot read, so its start month is not verified`, `Check that ${table} starts its fiscal year in ${fiscalStartName(need.startMonth)} and names it by the year it ends.`));
		} catch (err) {
			issues.push(...cardIssues(need, 'warning', 'push.fiscal-calendar-unchecked', `These cards need ${setupText(need)} on Cloud Amplifier integration ${id}, which could not be checked: ${err.message}`, suggestionFor(need)));
		}
	}
	return issues;
}

/** A conflict inside this workbook alone is reported by convert (convert.fiscal-conflict). */
export function workspaceCalendarConflicts(own, others) {
	const all = [...own.map((n) => ({ ...n, workbook: '' })), ...others.flatMap((o) => o.needs.map((n) => ({ ...n, workbook: o.slug })))];
	return calendarConflicts(all).flatMap(({ need, competing }) => {
		const rivals = competing.filter((c) => c.workbook);
		if (need.workbook || !rivals.length) return [];
		const wanted = [...new Set(rivals.map((c) => `${fiscalStartName(c.startMonth)} (${[...new Set(rivals.filter((r) => r.startMonth === c.startMonth).map((r) => r.workbook))].join(', ')})`))];
		return cardIssues(
			need,
			'warning',
			'push.fiscal-conflict',
			`These cards need a fiscal year starting in ${fiscalStartName(need.startMonth)} on ${targetLabel(need.target)}, which holds one fiscal calendar, and more cards of other workbooks need ${wanted.join(' or ')}`,
			'Keep the fiscal calendar most cards need; rebuild the dates of these cards with fiscal beast modes, or move their data to another Cloud Amplifier integration.'
		);
	});
}

export async function otherWorkbookNeeds(ws, slug) {
	const out = [];
	for (const wb of await ws.listWorkbooks()) {
		if (wb.slug === slug || !wb.hasPlan) continue;
		const plan = await ws.readJson(ws.paths(wb.slug).plan, null).catch(() => null);
		const needs = calendarNeeds(plan);
		if (needs.length) out.push({ slug: wb.slug, needs });
	}
	return out;
}

export { calendarNeeds };
