import path from 'node:path';
import { readCsv } from './csv-writer.js';
import { findInputColumn, physicalOf } from '../../convert/datasets.js';
import { filterMembers } from '../../convert/member-case.js';

/**
 * Scan a manifest's CSV files for filter members the data holds only in another case.
 * @param {import('../../model/types.js').WorkbookIR} ir
 * @param {import('../../model/types.js').DatasourceIR} ds
 * @param {import('../../model/types.js').DataManifest} manifest
 * @param {string} dir  directory the manifest's table files are relative to
 * @returns {Promise<Record<string, Record<string, string|string[]>>>} field id -> { member: the data value, or every spelling when there are several }
 */
export async function scanMemberCase(ir, ds, manifest, dir) {
	const wanted = filterMembers(ir, ds);
	const out = {};
	if (!wanted.size) return out;
	for (const table of manifest.tables ?? []) {
		if (!table.file) continue;
		const targets = [];
		for (const [fieldId, members] of wanted) {
			const field = ds.fields.find((f) => f.id === fieldId);
			const phys = physicalOf(ds, field);
			if (phys.tableId && table.tableId && phys.tableId !== table.tableId && manifest.tables.length > 1) continue;
			const column = findInputColumn(table.columns ?? [], { remoteName: phys.remoteName, localName: field.id, fieldName: field.name });
			if (!column) continue;
			const lower = new Map();
			for (const m of members) lower.set(m.toLowerCase(), [...(lower.get(m.toLowerCase()) ?? []), m]);
			targets.push({ fieldId, name: column.name, lower, spellings: new Map() });
		}
		if (!targets.length) continue;
		let indexes;
		for await (const record of readCsv(path.resolve(dir, table.file))) {
			if (!indexes) {
				indexes = targets.map((t) => record.indexOf(t.name));
				continue;
			}
			for (let i = 0; i < targets.length; i++) {
				const value = record[indexes[i]];
				if (!value) continue;
				const t = targets[i];
				const key = value.toLowerCase();
				if (!t.lower.has(key)) continue;
				if (!t.spellings.has(key)) t.spellings.set(key, new Set());
				t.spellings.get(key).add(value);
			}
		}
		for (const t of targets) {
			for (const [key, found] of t.spellings) {
				const listed = t.lower.get(key);
				if ([...found].every((v) => listed.includes(v))) continue;
				const values = [...found].sort();
				for (const member of listed) (out[t.fieldId] ??= {})[member] = values.length === 1 ? values[0] : values;
			}
		}
	}
	return out;
}
