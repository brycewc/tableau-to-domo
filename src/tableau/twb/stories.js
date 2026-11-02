import { parseSize } from './dashboards.js';
import { parseFilter } from './filters.js';
import { parsePillId } from './shelf.js';
import { styleRules, textRuns } from './style.js';
import { formattedText } from './xml.js';

/**
 * @typedef {import('./xml.js').XmlNode} XmlNode
 * @typedef {import('../../model/types.js').StoryIR} StoryIR
 * @typedef {import('../../model/types.js').Issue} Issue
 */

function capturedWorksheet(ws, issues) {
	const name = ws.attr('name') || '';
	const resolvePill = (id) => parsePillId(id);
	const filters = ws.descendants('filter').flatMap((f) => parseFilter(f, { resolvePill, issues, scope: name }));
	const out = { name };
	if (filters.length) out.filters = filters;
	const annotations = ws.child('annotations')?.all('annotation').length ?? 0;
	if (annotations) out.annotations = annotations;
	return out;
}

/**
 * A story (<dashboard type='storyboard'>) and its points. Each point shows one sheet or dashboard;
 * `captured` lists what the point changed on its sheets (filters, annotations).
 * @param {XmlNode} node
 * @param {{ issues: Issue[] }} ctx
 * @returns {StoryIR}
 */
export function parseStory(node, { issues }) {
	const name = node.attr('name') || 'Story';
	const flipboard = node.descendants('flipboard')[0];
	const points = (flipboard?.descendants('story-point') ?? node.descendants('story-point')).map((p) => {
		const point = { id: String(p.attr('id') ?? ''), caption: p.attr('caption') ?? '', sheet: p.attr('captured-sheet') ?? '' };
		const captured = (p.child('capturedDeltas')?.all('worksheet') ?? []).map((ws) => capturedWorksheet(ws, issues)).filter((c) => c.filters || c.annotations);
		if (captured.length) point.captured = captured;
		return point;
	});
	/** @type {StoryIR} */
	const story = { name, size: parseSize(node.child('size')), points };
	const active = flipboard?.attr('active-id') ?? node.descendants('story-points')[0]?.attr('active-id');
	if (active !== undefined) story.activePoint = String(active);
	if (flipboard?.attr('nav-type')) story.navType = flipboard.attr('nav-type');
	if (flipboard?.attr('show-nav-arrows') === 'true') story.showArrows = true;
	const titleZone = node.descendants('zone').find((z) => (z.attr('type-v2') || z.attr('type')) === 'title');
	const titleNode = node.path('layout-options/title');
	const title = titleNode ? formattedText(titleNode, { 'Sheet Name': name }) : undefined;
	if (titleZone || title) story.title = { text: title ?? name };
	const runs = titleNode ? textRuns(titleNode) : undefined;
	if (story.title && runs) story.title.runs = runs;
	const rules = styleRules(node.child('style'));
	if (rules.length) story.styleRules = rules;
	return story;
}
