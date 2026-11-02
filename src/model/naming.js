/**
 * Naming rules shared by extract (CSV headers) and convert (schemas, beast modes),
 * so a Tableau field always lands on the same Domo column name.
 */

/** '[Order Date]' -> 'Order Date'. Tableau escapes a literal ']' as ']]'. */
export function stripBrackets(id) {
	const text = String(id ?? '');
	if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).replace(/\]\]/g, ']');
	return text;
}

/**
 * Domo column name for a field display name. Backticks would break Beast Mode
 * column references, and leading/trailing whitespace is trimmed by Domo anyway.
 * @param {string} displayName
 */
export function domoColumnName(displayName) {
	const cleaned = String(displayName ?? '')
		.replace(/`/g, "'")
		.replace(/[\r\n\t]+/g, ' ')
		.trim();
	return cleaned || 'Column';
}

/**
 * Make names unique in order of appearance: 'Region', 'Region (2)', ...
 * @param {string[]} names
 * @returns {string[]}
 */
export function dedupeNames(names) {
	const seen = new Map();
	return names.map((name) => {
		const lower = name.toLowerCase();
		const count = seen.get(lower) || 0;
		seen.set(lower, count + 1);
		if (count === 0) return name;
		let candidate = `${name} (${count + 1})`;
		while (seen.has(candidate.toLowerCase())) candidate = `${candidate}'`;
		seen.set(candidate.toLowerCase(), 1);
		return candidate;
	});
}

/** Backtick-quoted Beast Mode column reference. */
export function bmColumn(name) {
	return `\`${domoColumnName(name)}\``;
}
