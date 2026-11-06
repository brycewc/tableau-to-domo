const SHEET_WIDTH = 0.82;
const FILTER_HEIGHT = 0.1;

/** Each published worksheet on no dashboard as a `sheetView` dashboard with its filter cards on the right; tabs in view-list order. */
export function withSheetViews(ir) {
	const views = ir?.workbook?.views;
	if (!Array.isArray(views) || !views.length) return ir;
	const position = new Map(views.map((v, i) => [v.name, i]));
	const onDashboard = new Set((ir.dashboards ?? []).flatMap((d) => [...(d.zones ?? []), ...(d.floating ?? [])].map((z) => z.worksheet).filter(Boolean)));
	const names = new Set([...(ir.dashboards ?? []), ...(ir.stories ?? [])].map((d) => d.name));
	const sheets = (ir.worksheets ?? []).filter((w) => !w.hidden && position.has(w.name) && !onDashboard.has(w.name) && !names.has(w.name));
	const order = (item) => ({ ...item, tabIndex: position.has(item.name) ? position.get(item.name) : views.length + (item.tabIndex ?? 0) });
	const sheetViews = sheets.map((ws) => {
		const side = ws.windowCards ?? (ws.quickFilters ?? []).map((f) => ({ kind: 'filter', param: f.pillId, ...(f.mode ? { mode: f.mode } : {}) }));
		const width = side.length ? SHEET_WIDTH : 1;
		const zones = [
			{ id: `${ws.name}#sheet`, kind: 'worksheet', worksheet: ws.name, rect: { x: 0, y: 0, w: width, h: 1 }, floating: false },
			...side.map((card, i) => ({
				id: `${ws.name}#${card.kind}${i}`,
				kind: card.kind,
				...(card.kind === 'paramctrl' ? {} : { worksheet: ws.name }),
				param: card.param,
				...(card.mode ? { mode: card.mode } : {}),
				...(card.values ? { values: card.values } : {}),
				rect: { x: SHEET_WIDTH, y: i * FILTER_HEIGHT, w: 1 - SHEET_WIDTH, h: FILTER_HEIGHT },
				floating: false
			}))
		];
		return { name: ws.name, size: { mode: 'automatic' }, zones, floating: [], sheetView: true, tabIndex: position.get(ws.name) };
	});
	if (!sheetViews.length && !(ir.dashboards ?? []).length && !(ir.stories ?? []).length) return ir;
	return { ...ir, dashboards: [...(ir.dashboards ?? []).map(order), ...sheetViews], ...(ir.stories ? { stories: ir.stories.map(order) } : {}) };
}

/**
 * The workbook as Tableau publishes it: dashboards and stories that are not views on the server (`ir.workbook.views`,
 * listed at extract) and that no published view opens through a button, action or story point are dropped, and their
 * worksheets that are not views either are hidden. Without a view list the workbook is unchanged. Pure.
 * @param {import('../model/types.js').WorkbookIR} ir
 * @returns {{ ir: import('../model/types.js').WorkbookIR, issues: import('../model/types.js').Issue[] }}
 */
export function withoutUnpublishedSheets(ir) {
	const views = ir?.workbook?.views;
	if (!Array.isArray(views) || !views.length) return { ir, issues: [] };
	const reachable = new Set(views.map((v) => v.name));
	const dashboards = new Map((ir.dashboards ?? []).map((d) => [d.name, d]));
	const stories = new Map((ir.stories ?? []).map((s) => [s.name, s]));
	const opens = (name) => {
		const out = [];
		const dash = dashboards.get(name);
		if (dash) {
			for (const z of [...(dash.zones ?? []), ...(dash.floating ?? [])]) {
				if (z.worksheet) out.push(z.worksheet);
				if (z.button?.target?.name) out.push(z.button.target.name);
			}
		}
		for (const p of stories.get(name)?.points ?? []) if (p.sheet) out.push(p.sheet);
		for (const a of ir.actions ?? []) {
			const from = a.source?.dashboard ? a.source.dashboard === name : (a.source?.worksheets ?? [a.source?.worksheet]).includes(name);
			if (from && a.target?.kind && a.target.name) out.push(a.target.name);
		}
		return out;
	};
	const queue = [...reachable];
	while (queue.length) {
		for (const next of opens(queue.pop())) {
			if (reachable.has(next)) continue;
			reachable.add(next);
			queue.push(next);
		}
	}
	const droppedDashboards = (ir.dashboards ?? []).filter((d) => !reachable.has(d.name)).map((d) => d.name);
	const droppedStories = (ir.stories ?? []).filter((s) => !reachable.has(s.name)).map((s) => s.name);
	const hiddenSheets = (ir.worksheets ?? []).filter((w) => !w.hidden && !reachable.has(w.name)).map((w) => w.name);
	if (!droppedDashboards.length && !droppedStories.length && !hiddenSheets.length) return { ir, issues: [] };
	const hide = new Set(hiddenSheets);
	const out = {
		...ir,
		dashboards: (ir.dashboards ?? []).filter((d) => reachable.has(d.name)),
		...(ir.stories ? { stories: ir.stories.filter((s) => reachable.has(s.name)) } : {}),
		worksheets: (ir.worksheets ?? []).map((w) => (hide.has(w.name) ? { ...w, hidden: true } : w))
	};
	const names = [...droppedDashboards.map((n) => `dashboard "${n}"`), ...droppedStories.map((n) => `story "${n}"`), ...hiddenSheets.map((n) => `worksheet "${n}"`)];
	const issue = {
		severity: 'info',
		code: 'convert.unpublished',
		message: `Not migrated because Tableau does not publish them as views and no published view opens them: ${names.join(', ')}`,
		object: { type: 'workbook', name: ir.workbook?.name || 'Workbook' }
	};
	return { ir: out, issues: [issue] };
}
