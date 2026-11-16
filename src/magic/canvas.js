// Tiles are 64px squares on DataFlowsUI's 32px coarser grid; a step of four squares leaves two empty between tiles.
const GRID = 32;
const STEP = 4 * GRID;
const ORIGIN = 2 * GRID;

/**
 * Canvas positions for a Magic ETL dataflow's actions, laid out in rows. A tile continues the row of the tile it
 * extends (a join's left input, a union's first input), so a lookup or appended input feeds in from a row of its own
 * below. Each tile sits one step before the earliest tile that reads it, and an output ends its row.
 *
 * @param {object[]} actions
 * @returns {object[]} Copies of `actions` with `gui` set
 */
export function layoutTiles(actions) {
	const byId = new Map(actions.map((a) => [a.id, a]));
	const deps = (a) => (a.dependsOn ?? []).filter((id) => byId.has(id)).map((id) => byId.get(id));
	const readers = new Map(actions.map((a) => [a, []]));
	for (const a of actions) for (const d of deps(a)) readers.get(d).push(a);
	const extended = (a) => deps(a)[0];

	const col = new Map();
	const earliest = (a) => {
		if (!col.has(a)) col.set(a, Math.max(-1, ...deps(a).map(earliest)) + 1);
		return col.get(a);
	};
	actions.forEach(earliest);
	for (const a of [...actions].sort((x, y) => col.get(y) - col.get(x))) {
		if (readers.get(a).length) col.set(a, Math.min(...readers.get(a).map((r) => col.get(r))) - 1);
	}

	const isOutput = (a) => a.type === 'PublishToVault';
	const outputs = actions.filter(isOutput).sort((x, y) => col.get(y) - col.get(x));
	const next = new Map();
	for (const output of outputs) {
		for (let t = output; extended(t) && !next.has(extended(t)); t = extended(t)) next.set(extended(t), t);
	}
	for (const a of actions) {
		if (next.has(a)) continue;
		const own = readers.get(a).filter((r) => extended(r) === a);
		const pick = own.find((r) => !isOutput(r)) ?? own[0];
		if (pick) next.set(a, pick);
	}
	const chainOf = (a) => {
		let head = a;
		while (extended(head) && next.get(extended(head)) === head) head = extended(head);
		const chain = [head];
		while (next.has(chain.at(-1))) chain.push(next.get(chain.at(-1)));
		return chain;
	};

	const row = new Map();
	let rows = 0;
	const place = (a) => {
		if (row.has(a)) return;
		const chain = chainOf(a);
		const trunk = extended(chain[0]);
		if (trunk) place(trunk);
		if (row.has(a)) return;
		const r = rows++;
		for (const t of chain) row.set(t, r);
		for (const t of chain) for (const d of deps(t).slice(1)) place(d);
		for (const t of chain) for (const r of readers.get(t)) if (extended(r) === t) place(r);
	};
	actions.filter(isOutput).forEach(place);
	actions.forEach(place);

	return actions.map((a) => ({ ...a, gui: { x: ORIGIN + col.get(a) * STEP, y: ORIGIN + row.get(a) * STEP } }));
}

/** The graph editor's `gui` for laid-out actions. */
export function graphCanvas(actions) {
	const elements = actions.map((a) => ({ id: a.id, type: 'Tile', x: a.gui?.x ?? 0, y: a.gui?.y ?? 0, color: null, colorSource: null }));
	return { version: '1.0', useGraphUI: true, canvases: { default: { canvasSettings: { coarserGrid: true, hideCoarserGridPopUp: false }, disabledActions: [], elements } } };
}
