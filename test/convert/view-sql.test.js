import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCollate } from '../../src/convert/view-sql.js';

test('rewriteCollate turns Snowflake COLLATE() into SQL the view parser accepts', () => {
	const sql = `SELECT collate("T"."PRODUCT_LINE", 'en-ci') AS "Product_Line", COLLATE("T"."X", 'en-cs') AS "X"
FROM \`t1\` "T"
WHERE collate("T"."TRANSACTIONTYPE",'en-ci') = 'Evergreen' AND COLLATE("T"."G", 'en-ci') IN ('A', 'b') AND 'Ab' <> COLLATE(T.C, 'en-ci-pi') AND "T"."N" = 'collate(x, ''en-ci'')'`;
	const { sql: out, rewrites } = rewriteCollate(sql);
	assert.equal(
		out,
		`SELECT "T"."PRODUCT_LINE" AS "Product_Line", "T"."X" AS "X"
FROM \`t1\` "T"
WHERE LOWER("T"."TRANSACTIONTYPE") = LOWER('Evergreen') AND LOWER("T"."G") IN (LOWER('A'), LOWER('b')) AND LOWER('Ab') <> LOWER(T.C) AND "T"."N" = 'collate(x, ''en-ci'')'`
	);
	assert.deepEqual(rewrites.map((r) => r.compared), [false, false, true, true, true]);
	assert.deepEqual(rewriteCollate('SELECT 1').rewrites, []);
});
