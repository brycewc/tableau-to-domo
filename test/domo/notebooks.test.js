import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, jsonBody, testClient } from './helpers.js';
import { createNotebook, getNotebook, notebookBody, sameOwner, updateNotebook } from '../../src/domo/notebooks.js';

let mock;
afterEach(() => mock?.restore());

const OWNER = '00000000-0000-4000-8000-000000000001';
const UPDATED = '00000000-0000-4000-8000-000000000002';
const DATASET = '00000000-0000-4000-8000-000000000003';
const paragraphs = [[{ text: 'Owner Name', bold: true }, { text: ' : ' }, { owner: 'Alexis Montgomery', id: OWNER }, { text: ' | ' }, { text: 'Data Refreshed', bold: true }, { text: ' : ' }, { smart: 'DATA_SOURCE_DATA_LAST_UPDATED', id: UPDATED }]];

test('notebookBody writes the fields the editor saves: html, Slate markup, tag markup, smart text items and subscriptions', () => {
	const body = notebookBody(paragraphs, { dataSourceId: DATASET });
	assert.equal(body.textHtml, `<div style="white-space:pre-wrap"><div><span style="font-weight:600">Owner Name</span> : Alexis Montgomery | <span style="font-weight:600">Data Refreshed</span> : <dynamic-text data-id="${UPDATED}"></dynamic-text></div></div>`);
	assert.deepEqual(JSON.parse(body.tagMarkup), {
		text: 'Owner Name : Alexis Montgomery | Data Refreshed : ',
		tags: [
			{ type: 'textStyle', value: 'bold', start: 0, length: 10 },
			{ type: 'textStyle', value: 'bold', start: 33, length: 14 }
		]
	});
	const block = JSON.parse(body.markup).document.nodes[0];
	assert.deepEqual(block.nodes.map((n) => n.object), ['text', 'inline', 'text'], 'Slate keeps a text node on both sides of an inline');
	assert.deepEqual(block.nodes[0].leaves[0], { object: 'leaf', text: 'Owner Name', marks: [{ object: 'mark', type: 'strong', data: {} }] });
	assert.deepEqual(block.nodes[1], { object: 'inline', type: 'DynamicText', data: { id: UPDATED, MarkVoidMarks: [] }, nodes: [{ object: 'text', leaves: [{ object: 'leaf', text: '', marks: [] }] }] });
	assert.deepEqual(body.dynamicTextItems, { [UPDATED]: { dataSourceId: DATASET, type: 'DATA_SOURCE_DATA_LAST_UPDATED' } });
	assert.deepEqual(body.subscriptions, [{ name: UPDATED, dataSourceId: DATASET, columns: [], filters: [], orderBy: [], groupBy: [], fiscal: false, projection: false, distinct: false, limit: 1, offset: 0 }]);
});

test('notebookBody: the owner is owner smart text only when asked, and without a dataset only text remains', () => {
	const smart = notebookBody(paragraphs, { dataSourceId: DATASET, ownerSmart: true });
	assert.deepEqual(Object.values(smart.dynamicTextItems).map((i) => i.type).sort(), ['DATA_SOURCE_DATA_LAST_UPDATED', 'DATA_SOURCE_OWNER']);
	assert.equal(smart.subscriptions.length, 2, 'the server requires a subscription for every smart text item');
	assert.ok(smart.textHtml.includes(`: <dynamic-text data-id="${OWNER}"></dynamic-text> |`));
	assert.equal(JSON.parse(smart.tagMarkup).text, 'Owner Name :  | Data Refreshed : ');
	const text = notebookBody([...paragraphs, [{ text: 'Second line' }]], { ownerSmart: true });
	assert.deepEqual([text.dynamicTextItems, text.subscriptions], [{}, []]);
	assert.ok(text.textHtml.includes('Alexis Montgomery'));
	assert.ok(text.textHtml.endsWith('<div>Second line</div></div>'));
	assert.equal(JSON.parse(text.tagMarkup).text, 'Owner Name : Alexis Montgomery | Data Refreshed : \nSecond line');
	assert.equal(notebookBody([[{ text: 'a < b & "c"' }]]).textHtml, '<div style="white-space:pre-wrap"><div>a &lt; b &amp; &quot;c&quot;</div></div>');
});

test('sameOwner ignores case and spacing', () => {
	assert.equal(sameOwner(' Alexis  Montgomery', 'alexis montgomery'), true);
	assert.equal(sameOwner('Alexis Montgomery', 'Sam Lee'), false);
	assert.equal(sameOwner('', ''), false);
});

test('createNotebook posts an empty v4 Text card on the page; updateNotebook posts the content; getNotebook reads it', async () => {
	const { client } = testClient();
	mock = mockFetch([
		{ method: 'POST', path: '/content/v1/cards/notebook', json: { id: 9001, title: 'Data Updated Sheet', version: 'v4' } },
		{ method: 'POST', path: '/content/v1/cards/notebook/9001/update', text: '' },
		{ method: 'GET', path: '/content/v1/cards/notebook/9001', json: { id: 9001 } }
	]);
	assert.equal((await createNotebook(client, { title: 'Data Updated Sheet', pageId: '5001' })).id, 9001);
	assert.deepEqual(jsonBody(mock.calls[0]), { text: '', title: 'Data Updated Sheet', encoding: 'html', dataFileIds: [], markup: '', version: 'v4', tagMarkup: '{"text":"","tags":[]}', pageId: 5001 });
	const body = notebookBody(paragraphs, { dataSourceId: DATASET });
	await updateNotebook(client, 9001, { title: 'Data Updated Sheet', ...body });
	assert.deepEqual(jsonBody(mock.calls[1]), { id: 9001, title: 'Data Updated Sheet', ...body });
	assert.equal((await getNotebook(client, 9001)).id, 9001);
	await assert.rejects(createNotebook(client, { title: '' }), /title is required/);
});

test('notebookBody writes a link segment as the editor saves one: an anchor, a Slate link inline and a link tag', () => {
	const body = notebookBody([[{ text: 'Owner: Ann' }], [{ text: 'Open in Tableau', link: 'https://t.example.com/#/views/W/S' }]]);
	assert.match(body.textHtml, /<div><a href="https:\/\/t\.example\.com\/#\/views\/W\/S" target="_blank" rel="noopener noreferrer nofollow">Open in Tableau<\/a><\/div>/);
	const inline = JSON.parse(body.markup).document.nodes[1].nodes.find((n) => n.object === 'inline');
	assert.deepEqual([inline.type, inline.data], ['a', { configType: 'WEBLINK', url: 'https://t.example.com/#/views/W/S', openInNewWindow: true, displayName: 'Open in Tableau' }]);
	assert.deepEqual(JSON.parse(body.tagMarkup), { text: 'Owner: Ann\nOpen in Tableau', tags: [{ type: 'link', value: 'https://t.example.com/#/views/W/S', newWindow: true, start: 11, length: 15, contentLength: 15 }] });
});

test('notebookBody writes text size, bold, color and alignment as the editor saves them (the user\'s Planning title card)', () => {
	const body = notebookBody([[{ text: 'Planning Dashboard', bold: true, size: 'header' }]], { align: 'center', valign: 'middle' });
	assert.deepEqual(JSON.parse(body.tagMarkup), {
		text: 'Planning Dashboard',
		tags: [
			{ type: 'textSize', value: 'header', start: 0, length: 18 },
			{ type: 'textStyle', value: 'bold', start: 0, length: 18 }
		],
		verticalAlignment: 'middle',
		horizontalAlignment: 'middle'
	});
	assert.equal(
		body.textHtml,
		'<div style="height:100%;width:100%;text-align:center"><div class="centerAlignedContent"><div style="white-space:pre-wrap"><div><span style="margin:inherit;font-weight:600;line-height:inherit;color:inherit;display:inline;font-size:32px"><h1 style="margin:inherit;font-weight:inherit;line-height:inherit;color:inherit;display:inline;font-size:32px">Planning Dashboard</h1></span></div></div></div></div>'
	);
	const markup = JSON.parse(body.markup);
	assert.deepEqual(markup.document.data, { vertAlignment: 'center', horizontalAlignment: 'center' });
	assert.deepEqual(markup.document.nodes[0].nodes[0].leaves[0].marks.map((m) => m.type), ['header', 'strong']);
	const colored = notebookBody([[{ text: 'Case Metrics', color: '#FFFFFF', size: 'title' }, { text: ' note', color: '#FFFFFF' }]], { align: 'right' });
	assert.equal(colored.textHtml, '<div style="height:100%;width:100%;text-align:right"><div style="white-space:pre-wrap"><div><span style="margin:inherit;font-weight:inherit;line-height:inherit;color:#FFFFFF;display:inline;font-size:24px"><h1 style="margin:inherit;font-weight:inherit;line-height:inherit;color:inherit;display:inline;font-size:24px">Case Metrics</h1></span><span style="color:#FFFFFF"> note</span></div></div></div>');
	assert.deepEqual(JSON.parse(colored.tagMarkup).tags.map((t) => [t.type, t.value]), [['textSize', 'title'], ['textColor', '#FFFFFF'], ['textColor', '#FFFFFF']]);
	assert.equal(JSON.parse(colored.tagMarkup).horizontalAlignment, 'end');
	assert.deepEqual(JSON.parse(colored.markup).document.nodes[0].nodes[0].leaves[0].marks, [{ object: 'mark', type: 'h1', data: {} }, { object: 'mark', type: 'color', data: { color: '#FFFFFF' } }]);
	assert.deepEqual(JSON.parse(notebookBody([[{ text: 'a' }]], { align: 'left' }).markup).document.data, {}, 'left is the default and is not written');
});
