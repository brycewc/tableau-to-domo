import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findView, linkTargetOf, linkedViewNames, linkedWorkbooks, parseViewUrl, resolveWebUrl, siteFromConfig, siteOfWorkbook, tableauViewHref } from '../../src/convert/web-links.js';
import { planPages } from '../../src/convert/layout.js';
import { planCards } from '../../src/convert/cards.js';
import { linkField } from '../../src/pipeline/push.js';
import { linksLater } from '../../src/pipeline/batch.js';
import { makeBindings, p, sheet, workbook } from './cards.fixtures.test.js';

const HOST = 'prod-useast-b.online.tableau.com';
const ACTIVITY = `https://${HOST}/#/site/acme/views/SupportActivity/ActivityByTimeAge?:iid=1`;
const ACTIVITY_VIEW = `https://${HOST}/#/site/acme/views/SupportActivity/ActivityByTimeAge`;

test('parseViewUrl reads site, workbook and sheet from every Tableau view url form; anything else is no view', () => {
	assert.deepEqual(parseViewUrl(ACTIVITY), { host: HOST, site: 'acme', workbook: 'SupportActivity', sheet: 'ActivityByTimeAge' });
	assert.deepEqual(parseViewUrl(`https://${HOST}/t/acme/views/Chatbot/Chat?:embed=y&:showVizHome=no`), { host: HOST, site: 'acme', workbook: 'Chatbot', sheet: 'Chat' });
	assert.deepEqual(parseViewUrl('https://tableau.acme.com/views/Sales/Overview'), { host: 'tableau.acme.com', site: '', workbook: 'Sales', sheet: 'Overview' });
	assert.deepEqual(parseViewUrl('https://tableau.acme.com/#/views/Sales/Over%20view?:iid=3'), { host: 'tableau.acme.com', site: '', workbook: 'Sales', sheet: 'Over view' });
	for (const url of ['https://www.example.com/page', 'Image/logo.png', '', `https://${HOST}/#/site/acme/workbooks/1001`]) assert.equal(parseViewUrl(url), undefined);
	assert.deepEqual(siteOfWorkbook({ workbook: { webpageUrl: `https://${HOST}/#/site/acme/workbooks/1001` } }), { host: HOST, site: 'acme' });
	assert.deepEqual(siteFromConfig({ server: `https://${HOST}`, site: '' }), { host: HOST, site: '' });
});

const target = linkTargetOf({ slug: 'support-activity', contentUrl: 'SupportActivity', ir: { workbook: { name: 'Support Activity', luid: 'B1' }, dashboards: [{ name: 'Activity By Time / Age ' }] } });
const ownIr = (url) => ({
	...workbook({
		worksheets: [sheet({ name: 'Volume', cols: p('none', 'Category'), rows: p('sum', 'Sales', 'qk') })],
		dashboards: [
			{ name: 'Overview', size: { mode: 'fixed', width: 1400, height: 1000 }, zones: [{ id: '1', kind: 'worksheet', worksheet: 'Volume', rect: { x: 0, y: 0, w: 1, h: 1 }, floating: false }], floating: [] },
			{ name: 'Activity', size: { mode: 'fixed', width: 1400, height: 1000 }, zones: [{ id: '3', kind: 'web', url, rect: { x: 0.00571, y: 0.008, w: 0.98858, h: 0.984 }, floating: false }], floating: [] }
		]
	}),
	workbook: { name: 'Acme', contentUrl: 'Support_Summary', webpageUrl: `https://${HOST}/#/site/acme/workbooks/1` }
});

test('resolveWebUrl: a view of this workbook, of a workbook in the migration, of one outside it, or of another site', () => {
	assert.deepEqual(target.views, [{ name: 'Activity By Time / Age ', key: 'b1--activity-by-time-age', kind: 'dashboard' }]);
	assert.equal(findView(target.views, 'activitybytimeage').key, 'b1--activity-by-time-age');
	const ir = ownIr(ACTIVITY);
	assert.equal(resolveWebUrl(ACTIVITY, ir, { targets: [target] }).kind, 'move');
	assert.equal(resolveWebUrl(ACTIVITY, ir, {}).kind, 'outside');
	assert.deepEqual(resolveWebUrl(`https://${HOST}/#/site/acme/views/Support_Summary/Overview`, ir).target, { name: 'Overview', kind: 'dashboard' });
	assert.match(resolveWebUrl(`https://${HOST}/#/site/other/views/SupportActivity/X`, ir, { targets: [target] }).why, /another Tableau site/);
	assert.match(resolveWebUrl(`https://${HOST}/#/site/acme/views/SupportActivity/Nope`, ir, { targets: [target] }).why, /no dashboard or story named like "Nope"/);
	assert.deepEqual(linkedWorkbooks(ir), ['SupportActivity']);
});

function viewOf(url, links) {
	const ir = ownIr(url);
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options: { target: 'app' }, workbookKey: 'wb' });
	const result = planPages(ir, cards, bindings, { options: { target: 'app' }, workbookKey: 'wb', links });
	return { page: result.pages.find((pg) => pg.title === 'Activity'), issues: result.issues };
}

test('a web zone showing a view of a workbook in the migration is one big button that opens that view across apps', () => {
	const { page, issues } = viewOf(ACTIVITY, { targets: [target] });
	const [item] = page.layout.content;
	assert.deepEqual(item, {
		contentKey: item.contentKey,
		type: 'BUTTON',
		text: 'Open Activity By Time / Age',
		iconPosition: 'LEFT',
		interaction: { type: 'WEBLINK', config: { url: { $ref: 'page:b1--activity-by-time-age', field: 'webUrl' }, openInNewWindow: false, displayName: 'Open Activity By Time / Age' } }
	});
	const [box] = page.layout.standard.template;
	assert.deepEqual([box.x, box.y, box.width], [0, 0, 60]);
	assert.ok(box.height > 60, 'the button fills the zone');
	assert.deepEqual(page.webLinks, [{ contentKey: item.contentKey, url: ACTIVITY, workbook: 'SupportActivity', sheet: 'ActivityByTimeAge', status: 'move', tableauUrl: ACTIVITY_VIEW, title: 'Activity By Time / Age', target: 'page:b1--activity-by-time-age', slug: 'support-activity', name: 'Support Activity' }]);
	assert.ok(issues.some((i) => i.code === 'layout.web-view' && /also converts/.test(i.message)));
	assert.ok(!issues.some((i) => i.code === 'layout.url-action-dropped'), 'a link filled in at push is not an http link');
});

test('tableauViewHref is the https view address without the tab query; linkedViewNames prefers the names Tableau lists', () => {
	assert.equal(tableauViewHref(parseViewUrl(ACTIVITY)), ACTIVITY_VIEW);
	assert.equal(tableauViewHref(parseViewUrl(`http://${HOST}/t/acme/views/Chatbot/Chat?:embed=y`)), `https://${HOST}/#/site/acme/views/Chatbot/Chat`);
	assert.equal(tableauViewHref(parseViewUrl('https://tableau.acme.com/#/views/Sales/Over%20view?:iid=3')), 'https://tableau.acme.com/#/views/Sales/Over%20view');
	const view = parseViewUrl(ACTIVITY);
	assert.deepEqual(linkedViewNames({}, view), { name: 'Activity By Time Age', workbook: 'Support Activity' });
	const ir = { workbook: { linkedViews: [{ contentUrl: 'SupportActivity/sheets/ActivityByTimeAge', name: 'Activity By Time / Age ', workbook: 'Support Activity' }] } };
	assert.deepEqual(linkedViewNames(ir, view), { name: 'Activity By Time / Age', workbook: 'Support Activity' });
});

test('a web zone showing a view outside the migration is one big button that opens it on Tableau in a new tab', () => {
	const outside = viewOf(ACTIVITY, {});
	const [item] = outside.page.layout.content;
	const text = 'Open Activity By Time Age in Tableau (Support Activity)';
	assert.deepEqual(item, { contentKey: item.contentKey, type: 'BUTTON', text, iconPosition: 'LEFT', interaction: { type: 'WEBLINK', config: { url: ACTIVITY_VIEW, openInNewWindow: true, displayName: text } } });
	assert.ok(outside.page.layout.standard.template[0].height > 60, 'the button fills the zone');
	const issue = outside.issues.find((i) => i.code === 'layout.web-view-outside');
	assert.ok(issue.message.includes(ACTIVITY) && /became a button that opens it on Tableau/.test(issue.message));
	assert.match(issue.suggestion, /Migrate "Support Activity" into this workspace/);
	assert.deepEqual(outside.page.webLinks, [{ contentKey: item.contentKey, url: ACTIVITY, workbook: 'SupportActivity', sheet: 'ActivityByTimeAge', status: 'outside', tableauUrl: ACTIVITY_VIEW, title: 'Activity By Time Age', name: 'Support Activity' }]);
});

test('an outside button uses the Tableau names from the extract; http becomes https; another site still gets a Tableau button', () => {
	const ir = ownIr(`http://${HOST}/#/site/acme/views/SupportActivity/ActivityByTimeAge`);
	ir.workbook.linkedViews = [{ contentUrl: 'SupportActivity/sheets/ActivityByTimeAge', name: 'Activity By Time / Age ', workbook: 'Support Activity' }];
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options: { target: 'app' }, workbookKey: 'wb' });
	const result = planPages(ir, cards, bindings, { options: { target: 'app' }, workbookKey: 'wb', links: {} });
	const [item] = result.pages.find((pg) => pg.title === 'Activity').layout.content;
	assert.equal(item.text, 'Open Activity By Time / Age in Tableau (Support Activity)');
	assert.equal(item.interaction.config.url, ACTIVITY_VIEW);
	assert.match(result.issues.find((i) => i.code === 'layout.web-view-outside').message, /http address was changed to https/);
	const other = viewOf(`https://${HOST}/#/site/other/views/Sales/Overview?:iid=4`, {});
	assert.deepEqual(other.page.layout.content[0].interaction.config, { url: `https://${HOST}/#/site/other/views/Sales/Overview`, openInNewWindow: true, displayName: 'Open Overview in Tableau (Sales)' });
	assert.match(other.issues.find((i) => i.code === 'layout.web-view-unresolved').message, /another Tableau site.*button that opens it on Tableau/);
	const missing = viewOf(`https://${HOST}/#/site/acme/views/Support_Summary/Gone`, {});
	assert.equal(missing.page.layout.content[0].text, 'Open Gone in Tableau (Acme)');
});

test('a web zone showing any other web page is a button that opens it in a new tab; classic pages keep the issue', () => {
	const self = viewOf(`https://${HOST}/#/site/acme/views/Support_Summary/Overview`, {});
	assert.deepEqual(self.page.layout.content[0].interaction.config.url, { $ref: 'page:wb--overview', field: 'appUrl' });
	const web = viewOf('http://www.example.com/report?a=1', {});
	assert.deepEqual(web.page.layout.content[0], { contentKey: web.page.layout.content[0].contentKey, type: 'BUTTON', text: 'Open www.example.com', iconPosition: 'LEFT', interaction: { type: 'WEBLINK', config: { url: 'https://www.example.com/report?a=1', openInNewWindow: true, displayName: 'Open www.example.com' } } });
	assert.match(web.issues.find((i) => i.code === 'layout.web-page').message, /http address was changed to https/);
	const none = viewOf('mailto:help@example.com', {});
	assert.equal(none.page.layout.content.length, 0);
	assert.ok(none.issues.some((i) => i.code === 'layout.unsupported-zone'));
	const ir = ownIr(ACTIVITY);
	const bindings = makeBindings();
	const { cards } = planCards(ir, bindings, { options: {}, workbookKey: 'wb' });
	const classic = planPages(ir, cards, bindings, { options: {}, workbookKey: 'wb', links: {} });
	assert.ok(classic.issues.some((i) => i.code === 'layout.web-view-outside' && /classic pages have no buttons/.test(i.message)));
});

test('linkField webUrl is the https address of a view, page or card; linksLater finds links to batch workbooks migrated later', () => {
	assert.equal(linkField('page:v', { id: 7, extra: { appId: 3 } }, 'webUrl', 'acme.domo.com'), 'https://acme.domo.com/app-studio/3/pages/7');
	assert.equal(linkField('page:v', { id: 7 }, 'webUrl', 'acme.domo.com'), 'https://acme.domo.com/page/7');
	assert.equal(linkField('card:c', { id: 9 }, 'webUrl', 'acme.domo.com'), 'https://acme.domo.com/kpis/details/9');
	assert.equal(linkField('card:c', { id: 9 }, 'urn'), '9', 'a text card records no urn: its id is one');
	assert.equal(linkField('card:c', { id: 9, extra: { urn: '42' } }, 'urn'), '42');
	const plan = { pages: [{ webLinks: [{ status: 'outside', workbook: 'SupportActivity' }] }] };
	const list = [{ contentUrl: 'Acme' }, { contentUrl: 'SupportActivity' }];
	assert.equal(linksLater(plan, list, 0), true);
	assert.equal(linksLater(plan, [...list].reverse(), 1), false);
});
