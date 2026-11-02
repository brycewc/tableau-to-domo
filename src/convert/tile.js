/**
 * Tiling for App Studio and page layouts: the editor only edits a template whose
 * every cell belongs to exactly one item, with headers and sections as full-width rows, so layouts are built that way.
 *
 * Items are placed from their Tableau frames (grid units, unrounded) by guillotine cuts: rows where no item crosses, then
 * columns, recursively, the way Tableau containers nest. Rows keep their natural heights and close up; columns share the
 * row's width by their spans, so space an unconverted zone left goes to its neighbors.
 *
 * @typedef {{ x: number, y: number, w: number, h: number }} Frame
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 * @typedef {Object} TileItem
 * @property {Frame} frame
 * @property {number} height        Natural height in rows
 * @property {number} [minWidth]    Default MIN_TILE_WIDTH
 * @property {boolean} [barrier]    A full-width row of the top level (HEADER, TABS, packed controls)
 * @property {boolean} [fixed]      Never taller than its natural height while a sibling can grow
 * @property {number[]} [sortKey]   Order of barriers lifted out of one row (default frame y, x)
 */

export const MIN_TILE_WIDTH = 5;
export const MIN_NARROW_WIDTH = 2;
const EPS = 0.25;

const leaf = (item) => ({ item });

function extent(items, axis) {
	const start = (f) => (axis === 'y' ? f.y : f.x);
	const size = (f) => Math.max(0, axis === 'y' ? f.h : f.w);
	return items.map((it) => ({ it, a: start(it.frame), b: start(it.frame) + size(it.frame) }));
}

/** Groups of items separated by lines no item crosses, in order along the axis. */
function cuts(items, axis) {
	const spans = extent(items, axis).sort((p, q) => p.a - q.a || p.b - q.b);
	const groups = [];
	let end = -Infinity;
	for (const s of spans) {
		if (!groups.length || s.a >= end - EPS) {
			groups.push([s.it]);
			end = s.b;
		} else {
			groups.at(-1).push(s.it);
			end = Math.max(end, s.b);
		}
	}
	return groups;
}

const readingOrder = (a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x;

function build(items) {
	if (items.length === 1) return leaf(items[0]);
	const rows = cuts(items, 'y');
	if (rows.length > 1) return { dir: 'v', children: rows.map(build) };
	const cols = cuts(items, 'x');
	if (cols.length > 1) return { dir: 'h', children: cols.map(build) };
	return { dir: 'v', children: [...items].sort(readingOrder).map(leaf) };
}

function leaves(node) {
	return node.item ? [node.item] : node.children.flatMap(leaves);
}

function bounds(node) {
	const fs = leaves(node).map((i) => i.frame);
	const x = Math.min(...fs.map((f) => f.x));
	const y = Math.min(...fs.map((f) => f.y));
	return { x, y, x2: Math.max(...fs.map((f) => f.x + Math.max(0, f.w))), y2: Math.max(...fs.map((f) => f.y + Math.max(0, f.h))) };
}

/** The node without its barrier leaves (collected into `out`), or null when nothing else is left. */
function prune(node, out) {
	if (node.item) {
		if (!node.item.barrier) return node;
		out.push(node.item);
		return null;
	}
	const children = node.children.map((c) => prune(c, out)).filter(Boolean);
	if (!children.length) return null;
	if (children.length === 1) return children[0];
	return { dir: node.dir, children };
}

const sortKey = (item) => item.sortKey ?? [item.frame.y, item.frame.x];
function byKey(a, b) {
	const ka = sortKey(a);
	const kb = sortKey(b);
	for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) - (kb[i] ?? 0);
	return 0;
}

/** Top level as rows, with every barrier as a row of its own next to the row it came from. */
function liftBarriers(root) {
	const rows = root.dir === 'v' ? root.children : [root];
	const out = [];
	for (const row of rows) {
		if (row.item) {
			out.push(row);
			continue;
		}
		const lifted = [];
		const rest = prune(row, lifted);
		lifted.sort(byKey);
		if (!rest) {
			out.push(...lifted.map(leaf));
			continue;
		}
		const { y, y2 } = bounds(rest);
		const middle = (y + y2) / 2;
		const before = lifted.filter((i) => sortKey(i)[0] <= middle);
		const after = lifted.filter((i) => sortKey(i)[0] > middle);
		out.push(...before.map(leaf), ...(rest.dir === 'v' ? rest.children : [rest]), ...after.map(leaf));
	}
	return { dir: 'v', children: out };
}

const minWidthOf = (item) => item.minWidth ?? MIN_TILE_WIDTH;

function minWidth(node) {
	if (node.item) return minWidthOf(node.item);
	const widths = node.children.map(minWidth);
	return node.dir === 'h' ? widths.reduce((a, b) => a + b, 0) : Math.max(...widths);
}

/** Integer shares of `total` proportional to `weights` (largest remainder), each at least its `mins` entry when they fit. */
export function apportion(total, weights, mins = weights.map(() => 0)) {
	const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
	const ideal = weights.map((w) => (sum > 0 ? (Math.max(0, w) / sum) * total : total / weights.length));
	const out = ideal.map(Math.floor);
	let left = total - out.reduce((a, b) => a + b, 0);
	const order = ideal.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]] += 1;
	if (mins.reduce((a, b) => a + b, 0) > total) return out;
	for (let i = 0; i < out.length; i++) {
		while (out[i] < mins[i]) {
			let donor = -1;
			for (let j = 0; j < out.length; j++) if (out[j] > mins[j] && (donor < 0 || out[j] - mins[j] > out[donor] - mins[donor])) donor = j;
			if (donor < 0) break;
			out[donor] -= 1;
			out[i] += 1;
		}
	}
	return out;
}

function placeX(node, x, width, boxes) {
	if (node.item) {
		boxes.set(node.item, { x, y: 0, width, height: 0 });
		return;
	}
	if (node.dir === 'h' && minWidth(node) > width) node.dir = 'v';
	if (node.dir === 'v') {
		for (const c of node.children) placeX(c, x, width, boxes);
		return;
	}
	const spans = node.children.map(bounds);
	const edges = [spans[0].x, ...spans.slice(1).map((s, i) => (spans[i].x2 + s.x) / 2), spans.at(-1).x2];
	const widths = apportion(width, spans.map((_, i) => edges[i + 1] - edges[i]), node.children.map(minWidth));
	let at = x;
	node.children.forEach((c, i) => {
		placeX(c, at, widths[i], boxes);
		at += widths[i];
	});
}

function natural(node) {
	if (node.item) return Math.max(0, Math.round(node.item.height));
	const heights = node.children.map(natural);
	return node.dir === 'h' ? Math.max(0, ...heights) : heights.reduce((a, b) => a + b, 0);
}

const growable = (node) => (node.item ? !node.item.fixed : node.children.some(growable));

function placeY(node, y, height, boxes) {
	if (node.item) {
		Object.assign(boxes.get(node.item), { y, height });
		return;
	}
	if (node.dir === 'h') {
		for (const c of node.children) placeY(c, y, height, boxes);
		return;
	}
	const heights = node.children.map(natural);
	const extra = height - heights.reduce((a, b) => a + b, 0);
	if (extra > 0) {
		let weights = node.children.map((c, i) => (growable(c) ? Math.max(1, heights[i]) : 0));
		if (!weights.some(Boolean)) weights = heights.map((h) => Math.max(1, h));
		apportion(extra, weights).forEach((e, i) => {
			heights[i] += e;
		});
	}
	let at = y;
	node.children.forEach((c, i) => {
		placeY(c, at, heights[i], boxes);
		at += heights[i];
	});
}

/**
 * Tile items into a template `width` columns wide, from row 0 down, with no empty cell: every row band and every column
 * of a band is filled by its items, which grow into the space between them.
 * @template {TileItem} T
 * @param {T[]} items
 * @param {number} width
 * @param {{ barriers?: boolean }} [opts]  `barriers`: lift barrier items out to full-width top-level rows (the top level
 *   of a view; a section pane has none)
 * @returns {{ boxes: Map<T, Box>, height: number }}
 */
export function tile(items, width, { barriers = true } = {}) {
	const boxes = new Map();
	if (!items.length) return { boxes, height: 0 };
	let root = build(items);
	if (barriers) root = liftBarriers(root);
	placeX(root, 0, width, boxes);
	const height = natural(root);
	placeY(root, 0, height, boxes);
	return { boxes, height };
}

/**
 * Cells of a template not covered by exactly one item: `empty` holes and `overlapping` cells, counted per template level
 * (each TAB_CONTENT against its own height). PAGE_BREAK and zero-height items cover nothing.
 * @param {Object[]} template  Template items ({ x, y, width, height, type, children })
 * @param {number} width
 * @returns {{ empty: number, overlapping: number }}
 */
export function tilingGaps(template, width) {
	const out = { empty: 0, overlapping: 0 };
	const count = (items, height) => {
		const grid = Array.from({ length: height }, () => new Array(width).fill(0));
		for (const it of items) {
			for (let y = it.y; y < it.y + it.height && y < height; y++) for (let x = it.x; x < it.x + it.width && x < width; x++) grid[y][x] += 1;
			if (it.type === 'TABS') for (const c of it.children ?? []) if (c.type === 'TAB_CONTENT') count(c.children ?? [], c.height);
		}
		for (const row of grid) for (const v of row) if (v === 0) out.empty += 1;
		else if (v > 1) out.overlapping += 1;
	};
	count(template, Math.max(0, ...template.map((t) => t.y + t.height)));
	return out;
}

/**
 * Fill holes left in a template level, as the editor's own removal does: an item whose edge borders the whole hole grows
 * into it (left, right, then above, below); a hole nothing borders becomes a SPACER from `spacer(box)`. Mutates `items`.
 * @param {Object[]} items  One template level
 * @param {number} width
 * @param {number} height
 * @param {(box: Box) => Object} spacer  Template item for a SPACER
 */
export function fillHoles(items, width, height, spacer) {
	const covered = () => {
		const grid = Array.from({ length: height }, () => new Array(width).fill(false));
		for (const it of items) for (let y = it.y; y < it.y + it.height && y < height; y++) for (let x = it.x; x < it.x + it.width && x < width; x++) grid[y][x] = true;
		return grid;
	};
	for (let guard = 0; guard < width * height; guard++) {
		const grid = covered();
		let hole;
		for (let y = 0; y < height && !hole; y++) for (let x = 0; x < width && !hole; x++) if (!grid[y][x]) hole = { x, y };
		if (!hole) return items;
		let w = 0;
		while (hole.x + w < width && !grid[hole.y][hole.x + w]) w++;
		let h = 0;
		while (hole.y + h < height && grid[hole.y + h].slice(hole.x, hole.x + w).every((v) => !v)) h++;
		const box = { x: hole.x, y: hole.y, width: w, height: h };
		const flat = items.filter((it) => it.type !== 'PAGE_BREAK' && it.height > 0);
		const left = flat.find((it) => it.x + it.width === box.x && it.y === box.y && it.height === box.height);
		const right = flat.find((it) => it.x === box.x + box.width && it.y === box.y && it.height === box.height);
		const above = flat.find((it) => it.y + it.height === box.y && it.x === box.x && it.width === box.width);
		const below = flat.find((it) => it.y === box.y + box.height && it.x === box.x && it.width === box.width);
		if (left) left.width += box.width;
		else if (right) Object.assign(right, { x: box.x, width: right.width + box.width });
		else if (above) above.height += box.height;
		else if (below) Object.assign(below, { y: box.y, height: below.height + box.height });
		else items.push(spacer(box));
	}
	return items;
}

const templateOrder = (a, b) => a.y - b.y || a.x - b.x || a.height - b.height;

/**
 * A template in the editor's order: each level by y, x, height,
 * TABS children as [TAB_BAR, TAB_CONTENT...]. Mutates and returns the array.
 */
export function sortTemplate(items) {
	items.sort(templateOrder);
	for (const it of items) {
		if (it.type !== 'TABS' || !it.children) continue;
		const bar = it.children.filter((c) => c.type === 'TAB_BAR');
		const panes = it.children.filter((c) => c.type !== 'TAB_BAR');
		for (const p of panes) if (p.children) sortTemplate(p.children);
		it.children = [...bar, ...panes];
	}
	return items;
}
