import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbookIR } from '../../src/tableau/twb/index.js';

const EXTERNAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'external');
const DS = 'federated.w1';

function workbook({ view = '', panes = '', rows = '', cols = '', windows = '', dashboards = '', extra = '', table = '' }) {
	return `<?xml version='1.0' encoding='utf-8' ?>
<workbook version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>
	<datasources><datasource caption='W' inline='true' name='${DS}' version='18.1'><column datatype='real' name='[Sales]' role='measure' type='quantitative' /></datasource></datasources>
	${extra}
	<worksheets><worksheet name='S'><table><view>
		<datasources><datasource name='${DS}' /><datasource name='Parameters' /></datasources>
		<datasource-dependencies datasource='${DS}'>
			<column caption='Ad hoc' datatype='string' name='[Only In Sheet]' role='dimension' type='nominal' />
			<column-instance column='[Sales]' derivation='Sum' name='[sum:Sales:qk]' pivot='key' type='quantitative' />
			<column-instance column='[Region]' derivation='None' name='[none:Region:nk]' pivot='key' type='nominal' />
		</datasource-dependencies>
		${view}
	</view>${table}<panes>${panes}</panes><rows>${rows}</rows><cols>${cols}</cols></table></worksheet></worksheets>
	${dashboards}
	${windows}
</workbook>`;
}

test('Hide Header (label style-rule display=false) lists the pills whose header is hidden', () => {
	const ir = buildWorkbookIR(
		workbook({
			table: `<style><style-rule element='label'><format attr='display' field='[${DS}].[none:Region:nk]' value='false' /><format attr='display' field='[${DS}].[sum:Sales:qk]' value='true' /></style-rule><style-rule element='cell'><format attr='display' field='[${DS}].[none:Other:nk]' value='false' /></style-rule></style>`,
			rows: `([${DS}].[none:Region:nk] / [${DS}].[sum:Sales:qk])`
		})
	);
	assert.deepEqual(ir.worksheets[0].hiddenHeaders, [`[${DS}].[none:Region:nk]`]);
	assert.equal(buildWorkbookIR(workbook({ rows: `[${DS}].[none:Region:nk]` })).worksheets[0].hiddenHeaders, undefined);
});

test('an underlined header label is a link-styled pill; an underline on the totals or a cell is not', () => {
	const label = `<format attr='text-decoration' data-class='total' field='[${DS}].[sum:Sales:qk]' value='underline' /><format attr='text-decoration' field='[${DS}].[none:Region:nk]' value='underline' />`;
	const ir = buildWorkbookIR(
		workbook({
			table: `<style><style-rule element='label'>${label}</style-rule><style-rule element='cell'><format attr='text-decoration' field='[${DS}].[sum:Sales:qk]' value='underline' /></style-rule></style>`,
			rows: `([${DS}].[none:Region:nk] / [${DS}].[sum:Sales:qk])`
		})
	);
	assert.deepEqual(ir.worksheets[0].linkStyled, [`[${DS}].[none:Region:nk]`]);
	assert.equal(buildWorkbookIR(workbook({ rows: `[${DS}].[none:Region:nk]` })).worksheets[0].linkStyled, undefined);
});

test('a worksheet text-format on a pill is its number format, the cell rule before the label rule', () => {
	const ir = buildWorkbookIR(
		workbook({
			table: `<style><style-rule element='label'><format attr='text-format' field='[${DS}].[sum:Sales:qk]' value='n#,##0' /></style-rule><style-rule element='cell'><format attr='text-format' field='[${DS}].[sum:Sales:qk]' value='c&quot;$&quot;#,##0;(&quot;$&quot;#,##0)' /><format attr='text-format' field='[${DS}].[sum:Missing:qk]' value='p0%' /><format attr='text-format' value='n0' /></style-rule></style>`,
			rows: `[${DS}].[none:Region:nk]`,
			panes: `<pane><mark class='Automatic' /><encodings><text column='[${DS}].[sum:Sales:qk]' /></encodings></pane>`
		})
	);
	assert.deepEqual(ir.worksheets[0].numberFormats, { [`[${DS}].[sum:Sales:qk]`]: 'c"$"#,##0;("$"#,##0)' }, 'pills the sheet does not have and unscoped formats are left out');
	assert.equal(buildWorkbookIR(workbook({ rows: `[${DS}].[none:Region:nk]` })).worksheets[0].numberFormats, undefined);
});

test('an axis with a fixed range keeps its min and max; automatic and independent ranges are left out', () => {
	const fixed = `<encoding attr='space' class='0' field='[${DS}].[sum:Sales:qk]' field-type='quantitative' max='9775742.67' min='-8547459.62' range-type='fixed' scope='rows' type='space' />`;
	const auto = `<encoding attr='space' class='0' field='[${DS}].[sum:Profit:qk]' field-type='quantitative' range-type='independent' scope='rows' type='space' />`;
	const ir = buildWorkbookIR(workbook({ table: `<style><style-rule element='axis'>${fixed}${auto}</style-rule></style>`, rows: `[${DS}].[sum:Sales:qk]`, cols: `[${DS}].[none:Region:nk]` }));
	assert.deepEqual(ir.worksheets[0].axes, [{ pillId: `[${DS}].[sum:Sales:qk]`, min: -8547459.62, max: 9775742.67 }]);
	assert.equal(buildWorkbookIR(workbook({ rows: `[${DS}].[sum:Sales:qk]` })).worksheets[0].axes, undefined);
	const start = `<encoding attr='space' class='0' field='[${DS}].[sum:Sales:qk]' field-type='quantitative' max='50.0' min='0.0' range-type='fixedmin' scope='cols' type='space' />`;
	const end = `<encoding attr='space' class='0' field='[${DS}].[sum:Profit:qk]' field-type='quantitative' max='100.0' min='5.0' range-type='fixedmax' scope='cols' type='space' />`;
	const halves = buildWorkbookIR(workbook({ table: `<style><style-rule element='axis'>${start}${end}</style-rule></style>`, cols: `[${DS}].[sum:Sales:qk]`, rows: `[${DS}].[none:Region:nk]` }));
	assert.deepEqual(halves.worksheets[0].axes, [
		{ pillId: `[${DS}].[sum:Sales:qk]`, min: 0 },
		{ pillId: `[${DS}].[sum:Profit:qk]`, max: 100 }
	], 'Fixed start keeps only the min, Fixed end only the max');
});

test('axis titles keep a blank title and the axis class; hidden axes and hidden field labels list their shelves', () => {
	const axis = [
		`<format attr='title' class='0' field='[${DS}].[sum:Sales:qk]' scope='rows' value='Order Items' />`,
		`<format attr='title' class='1' field='[${DS}].[sum:Profit:qk]' scope='rows' value='' />`,
		`<format attr='title' class='0' field='[Multiple Values]' scope='cols' value='Amount' />`,
		`<format attr='display' class='0' field='[${DS}].[sum:Profit:qk]' scope='cols' value='false' />`,
		`<format attr='display' class='0' field='[${DS}].[sum:Sales:qk]' scope='rows' value='true' />`
	].join('');
	const style = `<style><style-rule element='axis'>${axis}</style-rule><style-rule element='worksheet'><format attr='display-field-labels' scope='cols' value='false' /><format attr='display-field-labels' scope='rows' value='true' /></style-rule></style>`;
	const ws = buildWorkbookIR(workbook({ table: style, rows: `[${DS}].[sum:Sales:qk]`, cols: `[${DS}].[none:Region:nk]` })).worksheets[0];
	assert.deepEqual(ws.axisTitles, [
		{ pillId: `[${DS}].[sum:Sales:qk]`, scope: 'rows', axis: 0, title: 'Order Items' },
		{ pillId: `[${DS}].[sum:Profit:qk]`, scope: 'rows', axis: 1, title: '' },
		{ pillId: '[Multiple Values]', scope: 'cols', axis: 0, title: 'Amount' }
	]);
	assert.deepEqual(ws.hiddenAxes, [{ pillId: `[${DS}].[sum:Profit:qk]`, scope: 'cols', axis: 0 }]);
	assert.deepEqual(ws.hiddenFieldLabels, ['cols']);
	const plain = buildWorkbookIR(workbook({ rows: `[${DS}].[sum:Sales:qk]` })).worksheets[0];
	assert.deepEqual([plain.axisTitles, plain.hiddenAxes, plain.hiddenFieldLabels, plain.tooltipMode], [undefined, undefined, undefined, undefined]);
});

test("tooltip-style tooltip-mode 'none' and 'sticky' are kept; other modes are not", () => {
	const mode = (value) => buildWorkbookIR(workbook({ table: `<tooltip-style tooltip-mode='${value}' />`, rows: `[${DS}].[sum:Sales:qk]` })).worksheets[0].tooltipMode;
	assert.equal(mode('none'), 'none');
	assert.equal(mode('sticky'), 'sticky');
	assert.equal(mode('responsive'), undefined);
});

test('grand totals (rows/cols total=true) and subtotaled pills are read from the table', () => {
	const xml = workbook({ rows: `[${DS}].[none:Region:nk]`, cols: `[${DS}].[none:Segment:nk]` })
		.replace('<rows>', "<rows total='true'>")
		.replace('</cols>', `</cols><subtotals><column>[${DS}].[none:Region:nk]</column></subtotals>`);
	assert.deepEqual(buildWorkbookIR(xml).worksheets[0].totals, { rows: true, subtotals: [`[${DS}].[none:Region:nk]`] });
	assert.equal(buildWorkbookIR(workbook({ rows: `[${DS}].[none:Region:nk]` })).worksheets[0].totals, undefined);
});

test('shelf-sort-v2, natural and alphabetic sorts; disaggregated views', () => {
	const ir = buildWorkbookIR(
		workbook({
			view: `<natural-sort column='[${DS}].[none:Region:nk]' direction='DESC' />
				<shelf-sorts><shelf-sort-v2 dimension-to-sort='[${DS}].[none:Category:nk]' direction='DESC' measure-to-sort-by='[${DS}].[sum:Sales:qk]' shelf='rows' /></shelf-sorts>
				<alphabetic-sort column='[${DS}].[none:Sub:nk]' direction='asc' />
				<aggregation value='false' />`,
			rows: `[${DS}].[none:Region:nk]`
		})
	);
	const ws = ir.worksheets[0];
	assert.deepEqual(ws.datasourceIds, [DS]);
	assert.equal(ws.aggregated, false);
	assert.deepEqual(ws.sorts.map((s) => [s.kind, s.direction, s.using]), [['natural', 'DESC', undefined], ['alphabetic', 'ASC', undefined], ['computed', 'DESC', `[${DS}].[sum:Sales:qk]`]]);
	assert.ok(ws.pills[`[${DS}].[none:Category:nk]`]);
	assert.ok(ir.datasources[0].fields.some((f) => f.id === '[Only In Sheet]'));
	assert.equal(ir.issues.length, 0);
});

test('every referenced pill is in pills, including pane axes and encodings', () => {
	const ir = buildWorkbookIR(
		workbook({
			panes: `<pane id='3' x-axis-name='[${DS}].[avg:Sales:qk]'><mark class='Square' /><encodings><shape column='[${DS}].[none:Shape:nk]' /><path column='[${DS}].[none:Seq:ok]' /><geometry column='[${DS}].[none:Geometry:nk]' /><unknown column='[${DS}].[x]' /></encodings></pane>`,
			cols: `([${DS}].[avg:Sales:qk] + [${DS}].[cnt:Sales:qk])`
		})
	);
	const ws = ir.worksheets[0];
	for (const id of [...ws.colPills, ws.panes[0].xAxisPill, ...Object.values(ws.panes[0].encodings).flat()]) assert.ok(ws.pills[id], id);
	assert.deepEqual(Object.keys(ws.panes[0].encodings), ['shape', 'path', 'geometry']);
	assert.equal(ws.pills[`[${DS}].[cnt:Sales:qk]`].derivation, 'Count');
});

test('a pane customized-label becomes PaneIR.label', () => {
	const ir = buildWorkbookIR(
		workbook({
			panes: `<pane><mark class='Automatic' /><customized-label><formatted-text><run bold='true'>Waterfall</run><run>Æ&#10;</run><run>Quarterly &lt;[${DS}].[sum:Sales:qk]&gt;</run></formatted-text></customized-label></pane><pane><mark class='Bar' /></pane>`
		})
	);
	const [first, second] = ir.worksheets[0].panes;
	assert.equal(first.label, `Waterfall\nQuarterly <[${DS}].[sum:Sales:qk]>`);
	assert.equal('label' in second, false);
});

test('a pane customized-tooltip becomes PaneIR.tooltip, tabs and field tokens kept', () => {
	const tooltip = `<customized-tooltip><formatted-text><run fontcolor='#787878'>Region:&#9;</run><run bold='true'><![CDATA[<[${DS}].[none:Region:nk]>]]></run><run>Æ&#10;</run><run><![CDATA[Sales : <[${DS}].[sum:Sales:qk]>]]></run></formatted-text></customized-tooltip>`;
	const ir = buildWorkbookIR(workbook({ panes: `<pane><mark class='Bar' />${tooltip}</pane><pane><mark class='Bar' /></pane>` }));
	const [first, second] = ir.worksheets[0].panes;
	assert.equal(first.tooltip, `Region:\t<[${DS}].[none:Region:nk]>\nSales : <[${DS}].[sum:Sales:qk]>`);
	assert.equal('tooltip' in second, false);
});

test('hidden sheets: missing window entry for a dashboard-only sheet', () => {
	const ir = buildWorkbookIR(
		workbook({
			dashboards: "<dashboards><dashboard name='D'><zones><zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'><zone h='100000' id='2' name='S' w='100000' x='0' y='0' /></zone></zones></dashboard></dashboards>",
			windows: "<windows><window class='dashboard' name='D' /></windows>"
		})
	);
	assert.equal(ir.worksheets[0].hidden, true);
	const visible = buildWorkbookIR(workbook({ windows: "<windows><window class='worksheet' name='S' /></windows>" }));
	assert.equal(visible.worksheets[0].hidden, false);
});

test('the filter cards of a worksheet window become WorksheetIR.quickFilters; parameter cards and dashboard windows do not', () => {
	const cards = `<cards><edge name='left'><strip size='160'><card type='filters' /></strip></edge><edge name='right'><strip size='200'>
		<card mode='checkdropdown' param='[${DS}].[none:Region:nk]' type='filter' /><card mode='compact' param='[Parameters].[Parameter 1]' type='parameter' />
	</strip></edge></cards>`;
	const ir = buildWorkbookIR(workbook({ windows: `<windows><window class='dashboard' name='D'><cards><edge name='right'><strip size='1'><card param='[${DS}].[sum:Sales:qk]' type='filter' /></strip></edge></cards></window><window class='worksheet' name='S'>${cards}</window></windows>` }));
	assert.deepEqual(ir.worksheets[0].quickFilters, [{ pillId: `[${DS}].[none:Region:nk]`, mode: 'checkdropdown' }]);
	const none = buildWorkbookIR(workbook({ windows: "<windows><window class='worksheet' name='S' /></windows>" }));
	assert.equal('quickFilters' in none.worksheets[0], false);
});

test('ad hoc selection filters are dropped with an issue; measure-values element is read', () => {
	const ir = buildWorkbookIR(
		workbook({
			view: `<filter class='categorical' column='[${DS}].[Exclusions (Region)]'><groupfilter function='except' /></filter>
				<measure-values><column>[${DS}].[sum:Sales:qk]</column></measure-values>`
		})
	);
	const ws = ir.worksheets[0];
	assert.equal(ws.filters.length, 0);
	assert.deepEqual(ws.measureValues, [`[${DS}].[sum:Sales:qk]`]);
	assert.equal(ir.issues[0].code, 'twb.adhoc-selection-filter');
});

test('stories are excluded from dashboards and flagged; workbook root required', () => {
	const ir = buildWorkbookIR(workbook({ dashboards: "<dashboards><dashboard name='Story 1' type='storyboard' /></dashboards>" }));
	assert.equal(ir.dashboards.length, 0);
	assert.equal(ir.issues[0].code, 'twb.story');
	assert.throws(() => buildWorkbookIR("<datasource name='x' />"), /Expected a Tableau workbook/);
});

test('every document-api fixture builds a serializable IR', () => {
	for (const file of fs.readdirSync(EXTERNAL).filter((f) => f.endsWith('.twb'))) {
		const ir = buildWorkbookIR(fs.readFileSync(path.join(EXTERNAL, file), 'utf8'), { sourceFile: file });
		assert.equal(JSON.stringify(JSON.parse(JSON.stringify(ir))), JSON.stringify(ir), file);
		for (const ws of ir.worksheets) for (const id of [...ws.rowPills, ...ws.colPills]) assert.ok(ws.pills[id], `${file} ${id}`);
	}
});

test('Measure Names member and bucket values are backslash-unescaped to match column instances', () => {
	const pct = `[${DS}].[usr:\\% Leads to DQ (copy)_25572:qk]`;
	const pipe = `[${DS}].[usr:\\# Pipeline:qk]`;
	const ir = buildWorkbookIR(
		workbook({
			view: `<filter class='categorical' column='[${DS}].[:Measure Names]'>
					<groupfilter function='union' user:op='manual'>
						<groupfilter function='member' level='[:Measure Names]' member='&quot;${pct}&quot;' />
						<groupfilter function='member' level='[:Measure Names]' member='&quot;${pipe}&quot;' />
					</groupfilter>
				</filter>
				<manual-sort column='[${DS}].[:Measure Names]' direction='ASC'><dictionary><bucket>&quot;${pipe}&quot;</bucket><bucket>&quot;${pct}&quot;</bucket></dictionary></manual-sort>`
		})
	);
	const ws = ir.worksheets[0];
	const unescapedPct = `[${DS}].[usr:% Leads to DQ (copy)_25572:qk]`;
	const unescapedPipe = `[${DS}].[usr:# Pipeline:qk]`;
	assert.deepEqual(ws.measureValues, [unescapedPct, unescapedPipe]);
	assert.ok(ws.pills[unescapedPct]);
	assert.deepEqual(ws.sorts.find((s) => s.kind === 'manual').order, [unescapedPipe, unescapedPct]);
});

test('a quick table calc keeps its secondary calculation', () => {
	const ci = `<column-instance column='[UNIQUEID]' derivation='CountD' name='[pcto:cum:ctd:UNIQUEID:qk]' pivot='key' type='quantitative'>
		<table-calc aggregation='Sum' ordering-type='Rows' type='CumTotal' />
		<table-calc ordering-type='Rows' type='PctTotal' />
	</column-instance>`;
	const xml = workbook({ cols: `[${DS}].[none:Region:nk]`, rows: `[${DS}].[pcto:cum:ctd:UNIQUEID:qk]` }).replace('</datasource-dependencies>', `${ci}</datasource-dependencies>`);
	const pill = buildWorkbookIR(xml).worksheets[0].pills[`[${DS}].[pcto:cum:ctd:UNIQUEID:qk]`];
	assert.deepEqual(pill.tableCalc, {
		type: 'CumTotal',
		orderingType: 'Rows',
		attrs: { prefix: 'pcto:cum', aggregation: 'Sum' },
		secondary: { type: 'PctTotal', orderingType: 'Rows' }
	});
});

test('a table calc pill keeps the compute-using of each nested calc it references', () => {
	const ci = `<column-instance column='[Calculation_2]' derivation='User' name='[usr:Calculation_2:qk]' pivot='key' type='quantitative'>
		<table-calc ordering-field='[${DS}].[none:Month:nk]' ordering-type='Field' />
		<table-calc field='[${DS}].[Calculation_1]' ordering-field='[${DS}].[none:Region:nk]' ordering-type='Field' />
	</column-instance>`;
	const xml = workbook({ rows: `[${DS}].[none:Region:nk]`, panes: `<pane><mark class='Text' /><encodings><text column='[${DS}].[usr:Calculation_2:qk]' /></encodings></pane>` }).replace('</datasource-dependencies>', `${ci}</datasource-dependencies>`);
	const pill = buildWorkbookIR(xml).worksheets[0].pills[`[${DS}].[usr:Calculation_2:qk]`];
	assert.deepEqual(pill.tableCalc, {
		type: 'Calculation',
		orderingType: 'Field',
		orderFields: [`[${DS}].[none:Month:nk]`],
		nested: { '[Calculation_1]': { type: 'Calculation', orderingType: 'Field', orderFields: [`[${DS}].[none:Region:nk]`] } }
	});
});

test('tableStyle reads row banding, totals and subtotals fill and row dividers, the rows scope over the unscoped value', () => {
	const ir = buildWorkbookIR(
		workbook({
			table: `<style><style-rule element='header'><format attr='width' field='[${DS}].[none:Region:nk]' value='90' /><format attr='background-color' data-class='total' value='#e6e6e6' /><format attr='background-color' data-class='total' scope='rows' value='#00000000' /><format attr='background-color' data-class='subtotal' scope='rows' value='#d4d4d4' /></style-rule><style-rule element='pane'><format attr='band-color' scope='rows' value='#eeeeee' /></style-rule><style-rule element='table'><format attr='band-size' scope='rows' value='0' /></style-rule><style-rule element='table-div'><format attr='line-visibility' scope='rows' value='off' /></style-rule></style>`,
			rows: `[${DS}].[none:Region:nk]`
		})
	);
	assert.deepEqual(ir.worksheets[0].tableStyle, { rowBandSize: 0, rowBandColor: '#eeeeee', totalBackground: '#00000000', subtotalBackground: '#d4d4d4', rowDividers: false });
	assert.equal(buildWorkbookIR(workbook({ rows: `[${DS}].[none:Region:nk]` })).worksheets[0].tableStyle, undefined);
});

test('tableStyle reads totals and subtotals text color and weight from cell and header rules', () => {
	const ir = buildWorkbookIR(
		workbook({
			table: `<style><style-rule element='cell'><format attr='color' data-class='subtotal' value='#ffffff' /></style-rule><style-rule element='header'><format attr='font-weight' data-class='subtotal' value='bold' /><format attr='background-color' data-class='total' value='#a6aeff' /></style-rule></style>`,
			rows: `[${DS}].[none:Region:nk]`
		})
	);
	assert.deepEqual(ir.worksheets[0].tableStyle, { totalBackground: '#a6aeff', subtotalColor: '#ffffff', subtotalWeight: 'bold' });
});
