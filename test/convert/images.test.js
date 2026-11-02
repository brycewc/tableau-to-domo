import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageRoles, planPages, textZoneFill } from '../../src/convert/layout.js';
import { planCards } from '../../src/convert/cards.js';
import { p, sheet, workbook, makeBindings } from './cards.fixtures.test.js';

const zone = (id, kind, rect, extra = {}) => ({ id, kind, rect, floating: false, ...extra });
const image = (name) => ({ file: `images/${name}`, name, bytes: 3, md5: 'a1b2' });
const chart = sheet({ name: 'Chart', cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') });
const BANNER = { x: 0.005, y: 0.00889, w: 0.99, h: 0.07642 };

function run(dashboards, options = { target: 'app' }) {
	const ir = workbook({ worksheets: [chart], dashboards });
	ir.workbook = { ...ir.workbook, contentUrl: 'CustomerVoice', webpageUrl: 'https://prod-useast-b.online.tableau.com/#/site/acme/workbooks/1' };
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options });
	return planPages(ir, cards, bindings, { options, workbookKey: 'wb' });
}

/** [type, label, x, y, width, height] in reading order. */
function rows(layout, which = 'standard') {
	const content = new Map(layout.content.map((c) => [c.contentKey, c]));
	return layout[which].template
		.slice()
		.sort((a, b) => a.y - b.y || a.x - b.x)
		.map((t) => {
			const c = content.get(t.contentKey);
			return [t.type, c.text ?? c.cardId?.$ref.replace(/^card:(wb--[^.]+\.)?/, '') ?? '', t.x, t.y, t.width, t.height];
		});
}

const activityDetail = (extra = {}) => ({
	name: 'Activity Detail',
	size: { mode: 'fixed', width: 1600, height: 900 },
	zones: [zone('7', 'image', BANNER, { url: 'Image/banner.png', fit: 'none', image: image('banner.png'), ...extra }), zone('9', 'worksheet', { x: 0.005, y: 0.1, w: 0.99, h: 0.89 }, { worksheet: 'Chart' })],
	floating: [zone('8', 'text', { x: 0.334, y: 0.02125, w: 0.228, h: 0.0575 }, { floating: true, text: 'Activity Detail' })]
});

test('on a page (no sections) a header image is a 9-row image card at the top, the dashboard title right below it, then the Tableau link (the user\'s Activity Detail)', () => {
	const { pages: all, cards, issues } = run([activityDetail()], { target: 'pages', tableauLinks: true });
	const pages = all.filter((pg) => pg.dashboard);
	const [view] = pages;
	const card = cards.find((c) => c.kind === 'image');
	assert.deepEqual(card, { key: `${view.key}.image.7`, kind: 'image', title: 'banner.png', worksheet: '', datasetKey: '', chartType: 'document', body: { image: image('banner.png') }, pageKeys: [view.key], status: 'ok' });
	assert.deepEqual(rows(view.layout).slice(0, 4), [
		['CARD', 'image.7', 0, 0, 60, 9],
		['HEADER', 'Activity Detail', 0, 9, 60, 5],
		['CARD', 'tableau-link', 0, 14, 60, 6],
		['CARD', 'chart', 0, 20, 60, rows(view.layout)[3][5]]
	]);
	assert.deepEqual(rows(view.layout, 'compact').slice(0, 3), [
		['CARD', 'image.7', 0, 0, 12, 6],
		['HEADER', 'Activity Detail', 0, 6, 12, 2],
		['CARD', 'tableau-link', 0, 8, 12, 6]
	]);
	const item = view.layout.content.find((c) => c.cardId?.$ref === `card:${card.key}`);
	assert.deepEqual(
		[item.type, item.hideTitle, item.hideDescription, item.hideFooter, item.hideWrench, item.hideBorder, item.fitToFrame, item.hideMargins, item.editInAppViewer, item.acceptFilters, item.style],
		['CARD', true, true, true, true, false, true, false, true, true, undefined]
	);
	assert.ok(!issues.some((i) => i.code === 'layout.unsupported-zone'));
});

test('a fitted image keeps its aspect (no fitToFrame); a taller banner keeps its height; another tiled image keeps its zone', () => {
	const tall = { ...activityDetail({ fit: 'fit' }), name: 'Tall' };
	tall.zones[0] = { ...tall.zones[0], rect: { x: 0, y: 0, w: 1, h: 0.2 } };
	tall.zones[1] = { ...tall.zones[1], rect: { x: 0, y: 0.2, w: 1, h: 0.8 } };
	const side = {
		name: 'Side',
		size: { mode: 'fixed', width: 1200, height: 800 },
		zones: [zone('1', 'image', { x: 0, y: 0.3, w: 0.25, h: 0.2 }, { url: 'Image/p.png', fit: 'center', image: image('p.png') }), zone('2', 'worksheet', { x: 0.25, y: 0.3, w: 0.75, h: 0.7 }, { worksheet: 'Chart' })],
		floating: []
	};
	const { pages } = run([tall, side], { target: 'pages' });
	const [t, s] = pages.filter((pg) => pg.dashboard);
	const banner = rows(t.layout)[0];
	assert.deepEqual(banner.slice(0, 5), ['CARD', 'image.7', 0, 0, 60]);
	assert.ok(banner[5] > 9, `scaled height ${banner[5]}`);
	assert.equal(t.layout.content.find((c) => c.cardId?.$ref?.endsWith('image.7')).fitToFrame, false);
	const tile = rows(s.layout).find((r) => r[1] === 'image.1');
	assert.deepEqual(tile.slice(2, 3), [0]);
	assert.ok(tile[4] < 60 && tile[5] >= 6, `a zone-sized card: ${tile}`);
	assert.equal(s.layout.content.find((c) => c.cardId?.$ref?.endsWith('image.1')).fitToFrame, true);
});

test('a logo floating over a banner is left out; an image floating over nothing keeps its frame; an image with no bytes keeps the warning', () => {
	const dash = activityDetail();
	dash.floating.push(zone('14', 'image', { x: 0.014, y: 0.04, w: 0.095, h: 0.024 }, { floating: true, url: 'Image/logo.png', fit: 'fit', image: image('logo.png') }));
	dash.floating.push(zone('15', 'image', { x: 0.5, y: 0.95, w: 0.1, h: 0.04 }, { floating: true, url: 'Image/x.png', fit: 'fit', image: image('x.png') }));
	dash.zones[1].rect = { x: 0.005, y: 0.1, w: 0.99, h: 0.8 };
	dash.zones.push(zone('20', 'image', { x: 0, y: 0.9, w: 0.5, h: 0.1 }, { url: 'C:/missing.png', fit: 'none' }));
	assert.deepEqual([...imageRoles(dash)].map(([z, r]) => [z.id, r.role]), [['7', 'banner'], ['20', 'tile'], ['14', 'overlay'], ['15', 'frame']]);
	const { pages: all, cards, issues } = run([dash], { target: 'pages' });
	const pages = all.filter((pg) => pg.dashboard);
	assert.deepEqual(cards.filter((c) => c.kind === 'image').map((c) => c.title).sort(), ['banner.png', 'x.png']);
	assert.ok(rows(pages[0].layout).some((r) => r[1] === 'image.15'));
	assert.deepEqual(issues.filter((i) => i.code === 'layout.image-overlay').map((i) => [i.severity, i.message]), [['info', 'Image logo.png floats over other items in Tableau and is left out (App Studio items cannot overlap)']]);
	assert.ok(issues.some((i) => i.code === 'layout.unsupported-zone' && i.severity === 'warning' && /C:\/missing\.png/.test(i.message)));
});

test('a floating banner converts like a tiled one: the title under it goes below it', () => {
	const dash = activityDetail();
	const [banner] = dash.zones.splice(0, 1);
	dash.zones[0].rect = { x: 0, y: 0, w: 1, h: 1 };
	dash.floating.unshift({ ...banner, floating: true });
	const pages = run([dash], { target: 'pages' }).pages.filter((pg) => pg.dashboard);
	assert.deepEqual(rows(pages[0].layout).slice(0, 2).map((r) => r.slice(0, 2)), [['CARD', 'image.7'], ['HEADER', 'Activity Detail']]);
});

test('a logo floating over an unfilled dashboard title sits at its end of the title row, the title narrowed', () => {
	const dash = {
		name: 'Executive Summary',
		size: { mode: 'fixed', width: 1300, height: 1200 },
		zones: [zone('169', 'title', { x: 0.006, y: 0.0067, w: 0.988, h: 0.0675 }, { text: 'Executive Summary TS/CS' }), zone('2', 'worksheet', { x: 0, y: 0.08, w: 1, h: 0.92 }, { worksheet: 'Chart' })],
		floating: [zone('172', 'image', { x: 0.80769, y: 0.0075, w: 0.18, h: 0.0375 }, { floating: true, url: 'Image/Logo_Text_White.png', fit: 'fit', image: image('Logo_Text_White.png') })]
	};
	const { pages, cards, issues } = run([dash]);
	const [view] = pages;
	assert.deepEqual(issues.filter((i) => i.code === 'layout.image-on-fill'), [], 'a logo of unknown tone is placed');
	assert.deepEqual(rows(view.layout).slice(0, 3).map((r) => r.slice(0, 6)), [
		['HEADER', 'Executive Summary TS/CS', 0, 0, 49, 5],
		['CARD', 'image.172', 49, 0, 11, 5],
		['CARD', 'chart', 0, 5, 60, rows(view.layout)[2][5]]
	]);
	assert.deepEqual(rows(view.layout, 'compact').slice(0, 2), [
		['HEADER', 'Executive Summary TS/CS', 0, 0, 12, 2],
		['CARD', 'image.172', 0, 2, 12, 2]
	]);
	assert.equal(view.layout.content.find((c) => c.cardId?.$ref?.endsWith('image.172')).fitToFrame, false);
	assert.deepEqual(cards.filter((c) => c.kind === 'image').map((c) => c.pageKeys), [[view.key]]);
	const left = structuredClone(dash);
	left.floating[0].rect.x = 0.01;
	assert.deepEqual(rows(run([left]).pages[0].layout).slice(0, 2).map((r) => r.slice(0, 6)), [
		['CARD', 'image.172', 0, 0, 11, 5],
		['HEADER', 'Executive Summary TS/CS', 11, 0, 49, 5]
	]);
});

const executiveSummary = (titleStyle = { background: '#083494ed' }, extra = {}) => ({
	name: 'Executive Summary',
	size: { mode: 'fixed', width: 1300, height: 1200 },
	zones: [zone('169', 'title', { x: 0.006, y: 0.0067, w: 0.988, h: 0.0675 }, { text: 'Executive Summary TS/CS', style: titleStyle }), zone('2', 'worksheet', { x: 0, y: 0.08, w: 1, h: 0.92 }, { worksheet: 'Chart' })],
	floating: [zone('172', 'image', { x: 0.80769, y: 0.0075, w: 0.18, h: 0.0375 }, { floating: true, url: 'Image/Logo_Text_White.png', fit: 'fit', image: { ...image('Logo_Text_White.png'), tone: 1 } })],
	...extra
});
const tree = (items) => items.map((t) => [t.type, t.x, t.y, t.width, t.height, ...(t.children?.length ? [tree(t.children)] : [])]);

test('a filled title is a header section on its fill: the title a text card where the logo leaves room, the logo at its Tableau columns (Acme Executive Summary)', () => {
	const { pages, cards, issues } = run([executiveSummary()]);
	const { layout } = pages[0];
	const band = layout.content.find((c) => c.type === 'TABS');
	assert.deepEqual(band, { contentKey: band.contentKey, type: 'TABS', tabType: 'SECTION', itemId: band.itemId, collapsible: false, hideTitle: true, sectionFill: '#19429C' });
	assert.equal(layout.content.find((c) => c.type === 'TAB_CONTENT').text, 'Header');
	const top = (which) => tree(layout[which].template.filter((t) => t.contentKey === band.contentKey));
	assert.deepEqual(top('standard'), [['TABS', 0, 0, 60, 7, [['TAB_BAR', 0, 0, 60, 0], ['TAB_CONTENT', 0, 0, 60, 7, [['CARD', 0, 0, 48, 7], ['CARD', 48, 0, 12, 7]]]]]]);
	assert.deepEqual(top('compact'), [['TABS', 0, 0, 12, 12, [['TAB_BAR', 0, 0, 12, 0], ['TAB_CONTENT', 0, 0, 12, 12, [['CARD', 0, 0, 12, 6], ['CARD', 0, 6, 12, 6]]]]]]);
	assert.equal(layout.standard.template.find((t) => t.type === 'CARD' && t.y === 7)?.width, 60, 'the chart is right below the band');
	const title = cards.find((c) => c.key.endsWith('.header.169'));
	assert.deepEqual(title.body.notebook, { title: 'Executive Summary TS/CS', paragraphs: [[{ text: 'Executive Summary TS/CS', size: 'header' }]], align: 'left', valign: 'middle' });
	assert.equal(layout.content.find((c) => c.cardId?.$ref === `card:${title.key}`).editInAppViewer, false, 'viewers cannot edit the title in app view');
	assert.deepEqual(cards.filter((c) => c.kind === 'image').map((c) => c.title), ['Logo_Text_White.png']);
	assert.deepEqual(issues.filter((i) => i.code.startsWith('layout.image') || i.code === 'layout.header').map((i) => i.code), ['layout.header']);
	const dark = run([executiveSummary(undefined, { background: '#1a1a1a' })]).pages[0].layout;
	assert.equal(dark.content.find((c) => c.type === 'TABS')?.sectionFill, '#19429C', 'a fill other than the view background is kept on a dark view too');
});

const planning = () => ({
	name: 'Planning',
	size: { mode: 'fixed', width: 1550, height: 1000 },
	zones: [zone('7', 'image', BANNER, { url: 'Image/banner.png', fit: 'none', image: image('banner.png') }), zone('9', 'worksheet', { x: 0.005, y: 0.1, w: 0.99, h: 0.89 }, { worksheet: 'Chart' })],
	floating: [
		zone('8', 'image', { x: 0.01259, y: 0.031, w: 0.08741, h: 0.039 }, { floating: true, url: 'Image/logo.png', fit: 'fit', image: image('logo.png') }),
		zone('10', 'text', { x: 0.22903, y: 0.022, w: 0.47484, h: 0.051 }, { floating: true, text: 'Planning Dashboard', runs: [{ text: 'Planning Dashboard', fontName: 'Tableau Bold', fontSize: 20, color: '#000000', align: 'center' }] }),
		zone('11', 'text', { x: 0.772, y: 0.027, w: 0.218, h: 0.05 }, { floating: true, text: 'Owner: Ann', runs: [{ text: 'Owner: Ann', bold: true, fontSize: 9, align: 'right' }] })
	]
});

test('a banner image header is a section with the image as its background: logo, centered bold title and right text at their Tableau columns, the Tableau link joining the text (the user\'s Planning)', () => {
	const { pages, cards, issues } = run([planning()], { target: 'app', tableauLinks: true });
	const { layout, key } = pages[0];
	const band = layout.content.find((c) => c.type === 'TABS');
	assert.equal(band.sectionImage, `${key}.section-image.7`);
	assert.deepEqual(cards.find((c) => c.key === band.sectionImage), { key: band.sectionImage, kind: 'image', section: true, title: 'banner.png', worksheet: '', datasetKey: '', chartType: 'document', body: { image: image('banner.png') }, pageKeys: [key], status: 'ok' });
	assert.deepEqual(tree(layout.standard.template), [['TABS', 0, 0, 60, 7, [['TAB_BAR', 0, 0, 60, 0], ['TAB_CONTENT', 0, 0, 60, 7, [['CARD', 0, 0, 10, 7], ['CARD', 10, 0, 36, 7], ['CARD', 46, 0, 14, 7]]]]], ['CARD', 0, 7, 60, 58]]);
	assert.deepEqual(tree(layout.compact.template)[0], ['TABS', 0, 0, 12, 18, [['TAB_BAR', 0, 0, 12, 0], ['TAB_CONTENT', 0, 0, 12, 18, [['CARD', 0, 0, 12, 6], ['CARD', 0, 6, 12, 6], ['CARD', 0, 12, 12, 6]]]]]);
	const byKey = (suffix) => cards.find((c) => c.key === `${key}.${suffix}`);
	assert.deepEqual(byKey('header.10').body.notebook, { title: 'Planning Dashboard', paragraphs: [[{ text: 'Planning Dashboard', bold: true, color: '#000000', size: 'header' }]], align: 'center', valign: 'middle' });
	assert.deepEqual(byKey('header.11').body.notebook.paragraphs, [[{ text: 'Owner: Ann', bold: true }], [{ text: 'Open in Tableau', link: 'https://prod-useast-b.online.tableau.com/#/site/acme/views/CustomerVoice/Planning' }]]);
	assert.equal(byKey('header.11').body.notebook.align, 'right');
	assert.ok(!cards.some((c) => c.key.endsWith('.tableau-link')), 'no separate link card');
	const item = (suffix) => layout.content.find((c) => c.cardId?.$ref === `card:${key}.${suffix}`);
	assert.deepEqual([item('image.8').hideTitle, item('image.8').hideWrench, item('image.8').fitToFrame, item('header.10').hideTitle, item('header.10').hideWrench], [true, true, false, true, true]);
	assert.deepEqual(issues.filter((i) => /^layout\.(header|image)/.test(i.code)).map((i) => i.code), ['layout.header']);
});

test('a title-only banner header keeps the Tableau link card below it, and a centered title alone keeps its Tableau center (spacers)', () => {
	const dash = activityDetail();
	dash.floating[0].runs = [{ text: 'Activity Detail', bold: true, fontSize: 20, color: '#1b1b1b', align: 'center' }];
	const { pages } = run([dash], { target: 'app', tableauLinks: true });
	const { layout } = pages[0];
	assert.deepEqual(tree(layout.standard.template).slice(0, 2), [['TABS', 0, 0, 60, 7, [['TAB_BAR', 0, 0, 60, 0], ['TAB_CONTENT', 0, 0, 60, 7, [['CARD', 0, 0, 54, 7], ['SPACER', 54, 0, 6, 7]]]]], ['CARD', 0, 7, 60, 6]]);
	assert.equal(rows(layout)[1][1], 'tableau-link');
});

test('a plain title that is centered or bold is a full-width text card on an app view; a left one stays a header; pages keep headers', () => {
	const plain = (runs) => ({ name: 'Plain', size: { mode: 'fixed', width: 1200, height: 800 }, zones: [zone('1', 'title', { x: 0, y: 0, w: 1, h: 0.06 }, { text: 'Plain' }), zone('2', 'worksheet', { x: 0, y: 0.06, w: 1, h: 0.94 }, { worksheet: 'Chart' })], floating: [], title: { text: 'Plain', runs } });
	const centered = run([plain([{ text: 'Plain', align: 'center' }])]);
	assert.deepEqual(rows(centered.pages[0].layout)[0], ['CARD', 'header.1', 0, 0, 60, 7]);
	assert.deepEqual(centered.cards.find((c) => c.key.endsWith('header.1')).body.notebook, { title: 'Plain', paragraphs: [[{ text: 'Plain', size: 'header' }]], align: 'center', valign: 'middle' });
	assert.equal(rows(run([plain([{ text: 'Plain' }])]).pages[0].layout)[0][0], 'HEADER');
	assert.equal(rows(run([plain([{ text: 'Plain', align: 'center' }])], { target: 'pages' }).pages.find((pg) => pg.dashboard).layout)[0][0], 'HEADER');
});

test('a white logo is left out when its title has no fill it shows on, or on a page (no sections)', () => {
	const message = (dash, options) => run([dash], options).issues.filter((i) => i.code.startsWith('layout.image')).map((i) => [i.code, i.message]);
	const { pages, cards } = run([executiveSummary({ background: '#ffffff' })]);
	assert.deepEqual(rows(pages[0].layout).slice(0, 1).map((r) => r.slice(0, 6)), [['HEADER', 'Executive Summary TS/CS', 0, 0, 60, 5]]);
	assert.deepEqual(cards.filter((c) => c.kind === 'image'), []);
	assert.deepEqual(message(executiveSummary({ background: '#ffffff' })), [['layout.image-on-fill', "Image Logo_Text_White.png is left out: its colors match the view background and it does not show on the title's #FFFFFF fill either, so it would not show"]]);
	assert.deepEqual(message(executiveSummary({})), [['layout.image-on-fill', 'Image Logo_Text_White.png is left out: its colors match the view background and its title has no fill, so it would not show']]);
	assert.deepEqual(message(executiveSummary(), { target: 'pages' }), [['layout.image-on-fill', "Image Logo_Text_White.png is left out: its colors match the view background and the title's #19429C fill needs an app view (a filled section), so it would not show"]]);
	const dark = run([executiveSummary({}, { background: '#1a1a1a' })]).pages[0].layout;
	assert.deepEqual(rows(dark).slice(0, 2).map((r) => r.slice(0, 2)), [['HEADER', 'Executive Summary TS/CS'], ['CARD', 'image.172']], 'an unfilled title on a dark view keeps the logo beside it');
});

test('a title with no fill of its own takes the dash-title style rule\'s; two logos on one title band both keep their columns', () => {
	const ruled = executiveSummary({ margin: 4 }, { styleRules: [{ element: 'dash-title', formats: [{ attr: 'background-color', value: '#a6aeff' }] }] });
	ruled.floating.push(zone('173', 'image', { x: 0.01, y: 0.0075, w: 0.1, h: 0.0375 }, { floating: true, url: 'Image/Other.png', fit: 'fit', image: { ...image('Other.png'), tone: 1 } }));
	const { pages, cards, issues } = run([ruled]);
	assert.equal(pages[0].layout.content.find((c) => c.type === 'TABS')?.sectionFill, '#A6AEFF');
	assert.deepEqual(cards.filter((c) => c.kind === 'image').map((c) => c.title).sort(), ['Logo_Text_White.png', 'Other.png']);
	assert.deepEqual(issues.filter((i) => i.code === 'layout.image-overlay'), []);
	const ir = { style: { rules: [{ element: 'dash-title', formats: [{ attr: 'background-color', value: '#003794' }] }] } };
	assert.equal(textZoneFill({ kind: 'title', style: {} }, {}, ir), '#003794', 'the workbook rule when the dashboard has none');
	assert.equal(textZoneFill({ kind: 'text', style: {} }, {}, ir), undefined, 'a text zone reads dash-text rules');
	assert.equal(textZoneFill({ kind: 'title', style: { background: '#ffffff' } }, {}, ir), '#FFFFFF', 'its own fill first');
});
