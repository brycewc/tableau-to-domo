/**
 * Split a dataflow that is too big for ADR into a chain of dataflows. ADR rejects a run with more than 128 actions
 * ("ADR-DF-15406 Invalid request over max operations", live-checked: 128 actions run, 129 do not, LoadFromVault and
 * PublishToVault included; one SQL tile counts once however large its SELECT). Cuts fall between tiles in run order:
 * a tile a later stage reads is published as an intermediate dataset on the same compute cloud, and the later stage
 * reads it back with a LoadFromVault of the same id and name (SQL tiles name their inputs).
 *
 * @typedef {{ name: string, columns: import('./index.js').OutputColumn[]|null, intermediate: boolean, actionId: string }} StageOutput
 * @typedef {{ definition: object, outputs: StageOutput[] }} Stage
 */

export const ADR_MAX_ACTIONS = 128;
// Room under the limit for tiles a hook may add later (and for ADR counting something we have not seen).
export const DEFAULT_MAX_ACTIONS = 100;

/**
 * @param {object} definition  One dataflow definition (from buildDefinition)
 * @param {{ maxActions?: number, columnsOf?: (actionId: string) => import('./index.js').OutputColumn[]|null, finalColumns?: (name: string) => any }} [opts]
 * @returns {Stage[]}
 */
export function splitDefinition(definition, opts = {}) {
	const max = opts.maxActions ?? DEFAULT_MAX_ACTIONS;
	const actions = definition.actions;
	const byId = new Map(actions.map((a) => [a.id, a]));
	const publishes = actions.filter((a) => a.type === 'PublishToVault');
	const tiles = actions.filter((a) => a.type !== 'LoadFromVault' && a.type !== 'PublishToVault');
	const final = (a) => ({ name: a.name, columns: opts.finalColumns?.(a.name) ?? null, intermediate: false, actionId: a.id });
	if (actions.length <= max) return [{ definition, outputs: publishes.map(final) }];

	const position = new Map(tiles.map((t, k) => [t.id, k]));
	const readers = new Map(tiles.map((t) => [t.id, []]));
	for (const t of tiles) for (const d of t.dependsOn ?? []) if (readers.has(d)) readers.get(d).push(position.get(t.id));

	/** Actions a stage of tiles [s, e) needs, and the tiles it must publish for later stages. */
	const measure = (s, e) => {
		const inputs = new Set();
		for (let k = s; k < e; k++) for (const d of tiles[k].dependsOn ?? []) if (!position.has(d) || position.get(d) < s) inputs.add(d);
		const carried = [];
		for (let k = s; k < e; k++) if (readers.get(tiles[k].id).some((r) => r >= e)) carried.push(tiles[k].id);
		const finals = publishes.filter((p) => {
			const at = position.get(p.dependsOn[0]);
			return at === undefined ? s === 0 : at >= s && at < e;
		});
		return { inputs, carried, finals, size: inputs.size + (e - s) + carried.length + finals.length };
	};

	const cuts = [];
	let s = 0;
	// Aim for the fewest stages, evenly sized, then pick the cut near that size that publishes the fewest tiles.
	const planned = Math.ceil(actions.length / (max * 0.9));
	while (s < tiles.length) {
		let e = s + 1;
		if (measure(s, e).size > max) throw new Error(`One tile of ${definition.name} needs more than ${max} actions with its inputs and outputs`);
		while (e < tiles.length && measure(s, e + 1).size <= max) e++;
		if (e < tiles.length) {
			const left = Math.max(1, planned - cuts.length);
			const even = Math.min(e, s + Math.ceil((tiles.length - s) / left));
			const floor = Math.max(s + 1, even - Math.ceil((e - s) / 12));
			e = Math.max(floor, Math.min(e, even + Math.ceil((e - s) / 12)));
			let best = e;
			let bestCost = measure(s, e).carried.length;
			for (let c = e - 1; c >= floor; c--) {
				const cost = measure(s, c).carried.length;
				if (cost < bestCost) {
					best = c;
					bestCost = cost;
				}
			}
			e = best;
		}
		cuts.push([s, e]);
		s = e;
	}

	const base = definition.name;
	const intermediateName = (id, k) => `${base} step ${k + 1} - ${byId.get(id).name}`;
	const carriedName = new Map();
	return cuts.map(([a, b], k) => {
		const { inputs, carried, finals } = measure(a, b);
		const stageActions = [];
		for (const id of inputs) {
			const original = byId.get(id);
			if (original.type === 'LoadFromVault') stageActions.push(original);
			else stageActions.push(stageLoad(original, `stage:${carriedName.get(id)}`, definition));
		}
		stageActions.push(...tiles.slice(a, b));
		const outputs = [];
		for (const id of carried) {
			const name = intermediateName(id, k);
			carriedName.set(id, name);
			const from = byId.get(id);
			stageActions.push({ type: 'PublishToVault', id: `out-step-${id}`.slice(0, 120), name, dependsOn: [id], dataSource: { guid: '', name, description: '', type: 'DataFlow', ...(definition.computeCloud ? { cloudId: definition.computeCloud } : {}) }, versionChainType: 'REPLACE', gui: { x: from.gui.x + 220, y: from.gui.y } });
			outputs.push({ name, columns: opts.columnsOf?.(id) ?? null, intermediate: true, actionId: `out-step-${id}`.slice(0, 120) });
		}
		for (const p of finals) {
			stageActions.push(p);
			outputs.push(final(p));
		}
		return { definition: { ...definition, name: `${base} (step ${k + 1} of ${cuts.length})`, actions: stageActions }, outputs };
	});
}

function stageLoad(tile, dataSourceId, definition) {
	const adr = definition.databaseType === 'ADR';
	return {
		type: 'LoadFromVault',
		id: tile.id,
		name: tile.name,
		dataSourceId,
		executeFlowWhenUpdated: true,
		onlyLoadNewVersions: false,
		truncateTextColumns: false,
		truncateRows: false,
		...(adr ? { settings: { preferredDatabaseEntityType: 'TEMP_VIEW' }, sourceType: 'AUTO', filterPolicy: 'LEGACY' } : {}),
		gui: { ...tile.gui }
	};
}
