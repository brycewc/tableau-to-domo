import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedParameterIds } from '../../src/pipeline/extract.js';

test("a published datasource's parameter whose id the workbook uses for another is read under the workbook's id", () => {
	const ir = {
		parameters: [
			{ id: '[Parameters].[Parameter 2]', name: 'ACV/TCV', datatype: 'string' },
			{ id: '[Parameters].[Parameter 2 2]', name: 'Metric', datatype: 'string' },
			{ id: '[Parameters].[Parameter 3]', name: 'Day 1', datatype: 'real' },
			{ id: '[Parameters].[Parameter 5]', name: 'Include Today?', datatype: 'boolean' }
		]
	};
	const definition = {
		parameters: [
			{ id: '[Parameters].[Parameter 2]', name: 'Metric', datatype: 'string' },
			{ id: '[Parameters].[Parameter 3]', name: 'Top N Deals', datatype: 'integer', value: 10 },
			{ id: '[Parameters].[Parameter 5]', name: 'Include Today?', datatype: 'boolean' }
		],
		fields: [{ id: '[Amount]', formula: "if [Parameters].[Parameter 2] = 'Bookings' then [A] end + [Parameters].[Parameter 3]" }]
	};
	const ds = { fields: [{ id: '[Amount]', formula: definition.fields[0].formula }, { id: '[Mine]', formula: '[Parameters].[Parameter 2]' }] };
	const pairs = publishedParameterIds(ir, definition, ds);
	assert.deepEqual(pairs, [['[Parameters].[Parameter 2]', '[Parameters].[Parameter 2 2]'], ['[Parameters].[Parameter 3]', '[Parameters].[Parameter 3 1]']]);
	assert.equal(ds.fields[0].formula, "if [Parameters].[Parameter 2 2] = 'Bookings' then [A] end + [Parameters].[Parameter 3 1]");
	assert.equal(ds.fields[1].formula, '[Parameters].[Parameter 2]', "the workbook's own calc keeps the workbook's parameter");
	assert.deepEqual(ir.parameters.at(-1), { id: '[Parameters].[Parameter 3 1]', name: 'Top N Deals', datatype: 'integer', value: 10 });
	assert.equal(definition.fields[0].formula.includes('[Parameter 2 2]'), false, 'the cached definition is not changed');
});
