/** Page ids whose `page` search entry has no title (App Studio views should have no `page` entry at all). */
export async function findPageStubs(c, pageIds) {
	const out = [];
	for (const id of new Set(pageIds.map(String))) {
		const res = await c.post('/search/v1/query', { query: '*', entities: ['page'], count: 5, filters: [{ field: 'database_id', value: id, filterType: 'term' }] });
		const entry = (res?.searchObjects ?? []).find((o) => o?.entityType === 'page' && String(o.databaseId) === id);
		if (entry && !entry.title) out.push({ id, entry });
	}
	return out;
}
