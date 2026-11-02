import path from 'node:path';

const FILES = '/data/v1/data-files';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp' };

export const fileMime = (name) => MIME[path.extname(String(name)).slice(1).toLowerCase()] ?? 'application/octet-stream';

function fileForm(bytes, name) {
	const form = new FormData();
	form.append('file', new Blob([bytes], { type: fileMime(name) }), name);
	return form;
}

/**
 * Upload a data file, as a document card shows it.
 * @param {import('./client.js').DomoClient} c
 * @param {Buffer} bytes
 * @param {string} name
 * @returns {Promise<{ id: number }>}
 */
export async function uploadDataFile(c, bytes, name) {
	const res = await c.request('POST', FILES, { body: fileForm(bytes, name), idempotent: false });
	if (res?.dataFileId == null) throw new Error(`uploadDataFile: response had no dataFileId: ${JSON.stringify(res).slice(0, 300)}`);
	return { id: res.dataFileId };
}

/**
 * Upload a view's background image as the App Studio editor does: the raw bytes, stored as "Image background" and
 * shared with the view (10 MB at most).
 * @returns {Promise<{ id: number }>}
 */
export async function uploadLayoutBackground(c, pageId, bytes, name) {
	const res = await c.request('POST', `/content/v4/pages/${encodeURIComponent(pageId)}/layouts/background`, { body: bytes, headers: { 'Content-Type': fileMime(name) }, idempotent: false });
	if (res?.dataFileId == null) throw new Error(`uploadLayoutBackground: response had no dataFileId: ${JSON.stringify(res).slice(0, 300)}`);
	return { id: res.dataFileId };
}

/** A new revision of a data file (docCardService uploadNewVersion); a document card shows the latest one. */
export async function uploadDataFileVersion(c, id, bytes, name) {
	return c.request('PUT', `${FILES}/${encodeURIComponent(id)}`, { body: fileForm(bytes, name), idempotent: false });
}

/** The file's details, or undefined when it is gone (a deleted file keeps details without a currentRevision, or 400s). */
export async function getDataFileDetails(c, id) {
	try {
		const details = await c.get(`${FILES}/${encodeURIComponent(id)}/details`);
		return details?.currentRevision ? details : undefined;
	} catch (err) {
		if (err?.status === 400 || err?.status === 404) return undefined;
		throw err;
	}
}

/** The bytes of a data file's current revision. */
export async function downloadDataFile(c, id) {
	return c.get(`${FILES}/${encodeURIComponent(id)}`, { responseType: 'buffer' });
}

/** Delete a data file; false when it was already gone. Deleting a document card leaves its file behind. */
export async function deleteDataFile(c, id) {
	try {
		await c.del(`${FILES}/${encodeURIComponent(id)}`);
		return true;
	} catch (err) {
		if (err?.status === 400 || err?.status === 404) return false;
		throw err;
	}
}
