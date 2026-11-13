import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter, parseGroupfilter } from '../../src/tableau/twb/filters.js';
import { parsePillId } from '../../src/tableau/twb/shelf.js';
import { parseXml } from '../../src/tableau/twb/xml.js';

const DS = '[federated.abc]';
const ctx = (issues = []) => ({ resolvePill: (id) => parsePillId(id), issues, scope: 'Sheet 1' });
const filter = (xml, c = ctx()) => parseFilter(parseXml(xml), c);

test('categorical include list (union of members)', () => {
	const [f] = filter(`<filter class='categorical' column='${DS}.[none:Region:nk]'>
		<groupfilter function='union' user:ui-enumeration='inclusive'>
			<groupfilter function='member' level='[none:Region:nk]' member='&quot;East&quot;' />
			<groupfilter function='member' level='[none:Region:nk]' member='%null%' />
		</groupfilter></filter>`);
	assert.equal(f.kind, 'categorical');
	assert.equal(f.datasourceId, 'federated.abc');
	assert.equal(f.fieldId, '[Region]');
	assert.deepEqual(f.include, ['East', null]);
});

test('single member, numbers and booleans', () => {
	const [f] = filter(`<filter class='categorical' column='${DS}.[yr:Order Date:ok]'><groupfilter function='member' level='[yr:Order Date:ok]' member='2016' /></filter>`);
	assert.deepEqual(f.include, [2016]);
	const [b] = filter(`<filter class='categorical' column='${DS}.[none:Calc_1:nk]'><groupfilter function='member' member='true' /></filter>`);
	assert.deepEqual(b.include, [true]);
});

test('exclusion via except over level-members', () => {
	const [f] = filter(`<filter class='categorical' column='${DS}.[none:Ship Mode:nk]'>
		<groupfilter function='except' user:ui-enumeration='exclusive'>
			<groupfilter function='level-members' level='[none:Ship Mode:nk]' />
			<groupfilter function='union'>
				<groupfilter function='member' level='[none:Ship Mode:nk]' member='&quot;Same Day&quot;' />
				<groupfilter function='member' level='[none:Ship Mode:nk]' member='&quot;First Class&quot;' />
			</groupfilter>
		</groupfilter></filter>`);
	assert.deepEqual(f.exclude, ['Same Day', 'First Class']);
	assert.equal(f.include, undefined);
});

test('a double except over level-members is the inner selection', () => {
	const lvl = "level='[none:FYQ:nk]'";
	const outer = (inner) => filter(`<filter class='categorical' column='${DS}.[none:FYQ:nk]'>
		<groupfilter function='except' user:ui-enumeration='exclusive'><groupfilter function='level-members' ${lvl} />
			<groupfilter function='except'><groupfilter function='level-members' ${lvl} />${inner}</groupfilter>
		</groupfilter></filter>`);
	const [two] = outer(`<groupfilter function='union'><groupfilter function='member' ${lvl} member='&quot;2024 Q3&quot;' /><groupfilter function='member' ${lvl} member='&quot;2024 Q4&quot;' /></groupfilter>`);
	assert.deepEqual([two.include, two.exclude, two.all], [['2024 Q3', '2024 Q4'], undefined, undefined]);
	const [one] = outer(`<groupfilter function='member' ${lvl} member='&quot;2024 Q3&quot;' />`);
	assert.deepEqual(one.include, ['2024 Q3']);
});

test('an except child that cannot be reduced warns instead of keeping every member', () => {
	const issues = [];
	filter(`<filter class='categorical' column='${DS}.[none:A:nk]'><groupfilter function='except'>
		<groupfilter function='level-members' level='[none:A:nk]' />
		<groupfilter function='except'>
			<groupfilter function='union'><groupfilter function='member' level='[none:A:nk]' member='&quot;a&quot;' /><groupfilter function='member' level='[none:A:nk]' member='&quot;b&quot;' /></groupfilter>
			<groupfilter function='member' level='[none:A:nk]' member='&quot;b&quot;' />
		</groupfilter>
	</groupfilter></filter>`, ctx(issues));
	assert.equal(issues[0]?.code, 'twb.unknown-groupfilter');
});

test('all values, empty level, and missing groupfilter', () => {
	assert.equal(filter(`<filter class='categorical' column='${DS}.[none:A:nk]'><groupfilter function='level-members' level='[none:A:nk]' user:ui-enumeration='all' /></filter>`)[0].all, true);
	assert.deepEqual(filter(`<filter class='categorical' column='${DS}.[none:A:nk]'><groupfilter function='empty-level' level='[none:A:nk]' /></filter>`)[0].include, []);
	assert.equal(filter(`<filter class='categorical' column='${DS}.[none:A:nk]' />`)[0].all, true);
});

test('quantitative ranges, date ranges, included values and aggregated pills', () => {
	const [q] = filter(`<filter class='quantitative' column='${DS}.[sum:Sales:qk]' included-values='in-range-or-null'><min>100</min><max>1000.5</max></filter>`);
	assert.equal(q.kind, 'quantitative');
	assert.equal(q.min, 100);
	assert.equal(q.max, 1000.5);
	assert.equal(q.includedValues, 'in-range-or-null');
	assert.equal(q.aggregated, true);
	const [d] = filter(`<filter class='quantitative' column='${DS}.[tmn:Order Date:qk]' included-values='in-range'><min>#2018-11-01 00:00:00#</min></filter>`);
	assert.equal(d.kind, 'range-date');
	assert.equal(d.min, '2018-11-01T00:00:00');
	assert.equal(d.max, undefined);
	const [all] = filter(`<filter class='quantitative' column='${DS}.[attr:P:qk]' included-values='all' />`);
	assert.equal(all.includedValues, 'all');
});

test('relative date', () => {
	const [f] = filter(`<filter class='relative-date' column='${DS}.[none:Order Date:qk]' first-period='-2' include-future='true' include-null='true' last-period='0' period-type='year' anchor='2024-06-30' />`);
	assert.equal(f.kind, 'relative-date');
	assert.deepEqual(f.relative, { periodType: 'year', first: -2, last: 0, anchor: '2024-06-30', includeNull: true });
});

test('top N with order expression, bottom N with a parameter count', () => {
	const [top] = filter(`<filter class='categorical' column='${DS}.[none:Customer:nk]'>
		<groupfilter count='10' end='top' function='end' units='records'>
			<groupfilter direction='DESC' expression='SUM([Sales])' function='order'>
				<groupfilter function='level-members' level='[none:Customer:nk]' />
			</groupfilter>
		</groupfilter></filter>`);
	assert.equal(top.kind, 'top');
	assert.deepEqual(top.top, { count: 10, direction: 'top', by: 'SUM([Sales])' });
	const [bottom] = filter(`<filter class='categorical' column='${DS}.[none:Customer:nk]'><groupfilter count='[Parameters].[Top N]' end='bottom' function='end' /></filter>`);
	assert.deepEqual(bottom.top, { count: '[Parameters].[Top N]', direction: 'bottom', by: '' });
});

test('a top N keeps the hand-picked member list it ranks within', () => {
	const [top] = filter(`<filter class='categorical' column='${DS}.[none:FY-FQ:nk]'>
		<groupfilter count='20' end='top' function='end' units='records'>
			<groupfilter direction='DESC' expression='COUNTD([FY-FQ])' function='order'>
				<groupfilter function='union' user:ui-enumeration='inclusive'>
					<groupfilter function='member' level='[none:FY-FQ:nk]' member='&quot;2022-1&quot;' />
					<groupfilter function='member' level='[none:FY-FQ:nk]' member='&quot;2022-2&quot;' />
				</groupfilter>
			</groupfilter>
		</groupfilter></filter>`);
	assert.equal(top.kind, 'top');
	assert.deepEqual(top.top, { count: 20, direction: 'top', by: 'COUNTD([FY-FQ])', members: ['2022-1', '2022-2'] });
});

test('condition and wildcard filters', () => {
	const [cond] = filter(`<filter class='categorical' column='${DS}.[none:Sub:nk]'><groupfilter expression='SUM([Sales]) &gt; 1000' function='filter'><groupfilter function='level-members' /></groupfilter></filter>`);
	assert.equal(cond.kind, 'condition');
	assert.equal(cond.expression, 'SUM([Sales]) > 1000');
	const [wild] = filter(`<filter class='categorical' column='${DS}.[none:Name:nk]'><groupfilter expression='STARTSWITH([Name], &quot;Ab&quot;)' function='filter' user:ui-pattern_type='startsWith' /></filter>`);
	assert.equal(wild.kind, 'wildcard');
	assert.deepEqual(wild.wildcard, { pattern: 'Ab', mode: 'starts-with' });
	const [explicit] = filter(`<filter class='categorical' column='${DS}.[none:Name:nk]'><groupfilter expression='x' function='filter' user:ui-pattern_type='contains' user:ui-pattern_text='son' /></filter>`);
	assert.deepEqual(explicit.wildcard, { pattern: 'son', mode: 'contains' });
});

test('context flag and intersection of facets', () => {
	const fs = filter(`<filter class='categorical' column='${DS}.[none:A:nk]' context='true'>
		<groupfilter function='intersection'>
			<groupfilter function='member' member='&quot;x&quot;' />
			<groupfilter expression='SUM([S]) &gt; 0' function='filter' />
		</groupfilter></filter>`);
	assert.equal(fs.length, 2);
	assert.ok(fs.every((f) => f.context === true));
	assert.deepEqual(fs.map((f) => f.kind), ['categorical', 'condition']);
});

test('unknown groupfilter functions raise an issue and fall back to all', () => {
	const issues = [];
	const [f] = filter(`<filter class='categorical' column='${DS}.[none:A:nk]'><groupfilter function='crossjoin' /></filter>`, ctx(issues));
	assert.equal(f.all, true);
	assert.equal(issues[0].code, 'twb.unknown-groupfilter');
});

test('parseGroupfilter exposes the level for set building', () => {
	const facets = parseGroupfilter(parseXml("<groupfilter function='member' level='[none:Segment:nk]' member='&quot;Corporate&quot;' />"));
	assert.equal(facets[0].level, '[none:Segment:nk]');
});

test('member ranges: a range alone, ranges with members in a union, and excluded ranges', () => {
	const [only] = filter(`<filter class='categorical' column='[ds].[none:Quantity:ok]'><groupfilter function='range' from='2' to='5' level='[none:Quantity:ok]' /></filter>`);
	assert.deepEqual([only.include, only.exclude, only.ranges], [undefined, undefined, [{ from: 2, to: 5 }]]);
	const [mixed] = filter(`<filter class='categorical' column='[ds].[none:Region:nk]'><groupfilter function='union'>
		<groupfilter function='member' level='[none:Region:nk]' member='&quot;West&quot;' />
		<groupfilter function='range' from='&quot;Central&quot;' to='&quot;East&quot;' level='[none:Region:nk]' />
	</groupfilter></filter>`);
	assert.deepEqual([mixed.include, mixed.ranges], [['West'], [{ from: 'Central', to: 'East' }]]);
	const [excluded] = filter(`<filter class='categorical' column='[ds].[none:Region:nk]'><groupfilter function='except'>
		<groupfilter function='level-members' level='[none:Region:nk]' />
		<groupfilter function='range' from='&quot;Central&quot;' to='&quot;East&quot;' level='[none:Region:nk]' />
	</groupfilter></filter>`);
	assert.deepEqual([excluded.include, excluded.exclude, excluded.ranges], [undefined, [], [{ from: 'Central', to: 'East' }]]);
});

test('a Hide filter (kind=hide) is marked hidden with the members it hides', () => {
	const [f] = filter(`<filter class='categorical' column='${DS}.[none:isL3:ok]' kind='hide'>
		<groupfilter function='except' user:ui-enumeration='exclusive'>
			<groupfilter function='level-members' level='[none:isL3:ok]' />
			<groupfilter function='member' level='[none:isL3:ok]' member='0' />
		</groupfilter></filter>`);
	assert.equal(f.hidden, true);
	assert.deepEqual(f.exclude, [0]);
	const [plain] = filter(`<filter class='categorical' column='${DS}.[none:Region:nk]'><groupfilter function='member' level='[none:Region:nk]' member='&quot;East&quot;' /></filter>`);
	assert.equal(plain.hidden, undefined);
});

test('filter-group is the Tableau filter a sheet shares with its "Selected worksheets"', () => {
	const [f] = filter(`<filter class='categorical' column='${DS}.[none:FY:nk]' filter-group='4'><groupfilter function='member' level='[none:FY:nk]' member='&quot;2026&quot;' /></filter>`);
	assert.equal(f.group, '4');
	const [plain] = filter(`<filter class='categorical' column='${DS}.[none:FY:nk]'><groupfilter function='member' level='[none:FY:nk]' member='&quot;2026&quot;' /></filter>`);
	assert.equal(plain.group, undefined);
});

test('set filters in members-of-set mode: bare, or a level on the set source; In/Out mode has neither', () => {
	const [bare] = filter(`<filter class='categorical' column='${DS}.[NewExand Set]' />`);
	assert.deepEqual([bare.all, bare.bare, bare.memberLevel], [true, true, undefined]);
	const [all] = filter(`<filter class='categorical' column='${DS}.[NewExand Set (copy)]'><groupfilter function='level-members' level='[Calculation_1968]' user:ui-enumeration='all' /></filter>`);
	assert.deepEqual([all.all, all.bare, all.memberLevel], [true, undefined, '[Calculation_1968]']);
	const [picked] = filter(`<filter class='categorical' column='${DS}.[Mix Set]'><groupfilter function='member' level='[none:Mix Category:nk]' member='&quot;New SaaS&quot;' /></filter>`);
	assert.deepEqual([picked.include, picked.memberLevel], [['New SaaS'], '[Mix Category]']);
	const [inOut] = filter(`<filter class='categorical' column='${DS}.[Mix Set]'><groupfilter function='member' level='[Mix Set]' member='true' /></filter>`);
	assert.deepEqual([inOut.include, inOut.memberLevel, inOut.bare], [[true], undefined, undefined]);
	const [dated] = filter(`<filter class='categorical' column='${DS}.[yr:Order Date:ok]'><groupfilter function='member' level='[yr:Order Date:ok]' member='2016' /></filter>`);
	assert.equal(dated.memberLevel, undefined, 'a derivation of the same field is no other level');
});

test("a relative date filter's period-type-v2 is its period", () => {
	const [f] = filter(`<filter class='relative-date' column='${DS}.[none:Order Date:qk]' first-period='-1' include-future='true' include-null='false' last-period='0' period-type-v2='quarter' />`);
	assert.equal(f.relative.periodType, 'quarter');
});
