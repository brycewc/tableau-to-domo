/**
 * Shared data contracts. Nothing here runs; it is the JSDoc type surface that
 * the extract, convert and push stages (and any future UI) agree on.
 *
 *   Tableau --extract--> WorkbookIR (+ data files) --convert--> DomoPlan --push--> Domo
 *
 * Each stage reads and writes JSON files in the workspace, so stages can run
 * separately, be inspected, hand-edited, or resumed.
 */

// 2: actions, stories, workbook style, dashboard containers and titles (the App Studio items). 3: worksheet colors.
// 4: quick filter titles, pane mark colors and label weight. 5: parameter control titles. 6: pane label alignment and
// color. 7: secondary quick table calcs. 8: column collations. 9: hidden members (filter kind='hide'). 10: underlined
// header labels (linkStyled). 11: image zone fit and package bytes (zone.image). 12: color maps up to 1000 members, the
// other panes' color pills (paneColors). 13: filter scope (filter-group, shared-view filters) and set filters that keep
// the set's members (bare, memberLevel). 14: datasource hierarchies (drill paths). 15: worksheet window filter cards
// (quickFilters). 16: table shading and row dividers (tableStyle). 17: fiscal year start month of datasources and date
// fields (fiscalYearStart). 18: worksheet window filter, parameter and legend cards (windowCards). Convert warns on an
// older ir.json.
export const IR_VERSION = 18;
export const PLAN_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Issues: anything a human should review, attached to IR or plan.    */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'info'|'warning'|'error'} IssueSeverity
 *
 * @typedef {Object} Issue
 * @property {IssueSeverity} severity  error = could not convert; warning = converted approximately
 * @property {string} code             Stable machine code, e.g. 'calc.lod-dimension', 'chart.dual-axis'
 * @property {string} message
 * @property {{ type: string, name: string, id?: string }} [object]  The Tableau object concerned
 * @property {string} [suggestion]
 */

/* ------------------------------------------------------------------ */
/* WorkbookIR: normalized Tableau workbook (stage 1 output, ir.json)   */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} WorkbookIR
 * @property {number} irVersion                 IR_VERSION
 * @property {WorkbookInfo} workbook
 * @property {DatasourceIR[]} datasources       Excludes the special 'Parameters' datasource
 * @property {ParameterIR[]} parameters
 * @property {WorksheetIR[]} worksheets
 * @property {DashboardIR[]} dashboards
 * @property {Issue[]} issues
 * @property {BlendRelationshipIR[]} [blendRelationships]  Custom blend links (datasource-relationships)
 * @property {FilterActionIR[]} [filterActions]  Filter actions (tsc:tsl-filter); `actions` has the full detail
 * @property {ActionIR[]} [actions]             Every workbook action, in <actions> order
 * @property {StoryIR[]} [stories]              Stories (storyboards); not in `dashboards`
 * @property {WorkbookStyleIR} [style]          Workbook formatting (Format > Workbook) and custom palettes
 *
 * @typedef {Object} FilterActionIR
 * @property {string} name
 * @property {string} sourceDashboard           Dashboard the action starts on ('' when it starts on a sheet)
 * @property {string} target                    Target sheet or dashboard name
 *
 * @typedef {Object} ActionIR
 * @property {string} id                        action@name, e.g. '[Action12]'
 * @property {string} name                      Caption
 * @property {'filter'|'highlight'|'url'|'navigate'|'parameter'|'set'|'other'} type
 * @property {string} [command]                 type=other: the Tableau command
 * @property {'select'|'hover'|'menu'} trigger  No <activation> type means menu
 * @property {Record<string,string>} [activation]  Activation attributes other than type and auto-clear
 * @property {ActionSourceIR} source
 * @property {ActionTargetIR} [target]          filter/highlight: target sheet or dashboard; navigate: the sheet to open
 * @property {boolean} [allFields]              filter/highlight: all fields (special-fields=all)
 * @property {{ source: string, target: string }[]} [fields]  filter on selected fields: source field -> target field ids
 * @property {string[]} [fieldCaptions]         highlight on selected fields: field captions
 * @property {'keep'|'show-all'|'exclude-all'} [clear]  filter/highlight: what clearing the selection does
 * @property {string} [menuCaption]             Link caption shown in the tooltip menu
 * @property {ActionUrlIR} [url]                type=url
 * @property {{ target: string, sourceField: string, sourcePill: string, aggregation?: string, clear?: { type: string, value?: any } }} [parameter]  type=parameter
 * @property {{ target: string, mode: 'assign'|'add'|'remove'|string, clear?: string }} [set]  type=set (target is the set field id)
 *
 * @typedef {Object} ActionSourceIR
 * @property {'sheet'|'datasource'|'all'|string} type
 * @property {string} [dashboard]
 * @property {string} [worksheet]               A single source sheet
 * @property {string[]} [excludeSheets]         Sheets of the source dashboard left out
 * @property {string[]} [worksheets]            Resolved source sheets (the named one, or the dashboard's sheets minus excluded)
 * @property {string} [datasource]              type=datasource
 *
 * @typedef {Object} ActionTargetIR
 * @property {string} name                      As written; 'None' and unknown names have no kind
 * @property {'dashboard'|'worksheet'|'story'} [kind]
 * @property {string[]} [excludeSheets]         Target dashboard sheets the action does not apply to
 * @property {string[]} [worksheets]            kind=dashboard: target sheets after exclusions
 *
 * @typedef {Object} ActionUrlIR
 * @property {string} template                  With field tokens, e.g. 'https://x/<[Id]>'
 * @property {string[]} tokens                  Token contents, e.g. '[Id]', '[Parameters].[P1]', 'ATTR([Calc])'
 * @property {string} scheme                    'https', 'mailto', ... ('' when the URL starts with a token)
 * @property {boolean} [encode]                 url-escape
 * @property {boolean} [multiSelect]            Allow multiple values, joined with `delimiter`
 * @property {string} [delimiter]
 * @property {string} [escape]
 * @property {boolean} [includeNull]
 * @property {string} [target]                  url-action-type, e.g. 'browser'
 *
 * @typedef {Object} StoryIR
 * @property {string} name
 * @property {{ width?: number, height?: number, mode: string }} size
 * @property {StoryPointIR[]} points
 * @property {string} [activePoint]             Point id shown when the story opens
 * @property {string} [navType]                 caption | number | dots | arrows
 * @property {boolean} [showArrows]
 * @property {{ text: string, runs?: TextRunIR[] }} [title]  Present when the story shows a title
 * @property {StyleRuleIR[]} [styleRules]
 * @property {number} [tabIndex]
 * @property {boolean} [hidden]
 *
 * @typedef {Object} StoryPointIR
 * @property {string} id
 * @property {string} caption
 * @property {string} sheet                     Captured sheet or dashboard name
 * @property {'dashboard'|'worksheet'} [sheetKind]
 * @property {{ name: string, filters?: FilterIR[], annotations?: number }[]} [captured]  Changes the point keeps per worksheet
 *
 * @typedef {Object} WorkbookStyleIR
 * @property {StyleRuleIR[]} rules
 * @property {{ fontFamily?: string, fontSize?: number, color?: string }} [defaults]  From the 'all' rule
 * @property {{ name: string, type: string, colors: string[] }[]} [palettes]  <preferences> color palettes
 * @property {TableStyleIR} [table]             Workbook-level shading (IR 16)
 *
 * @typedef {Object} TableStyleIR                Tableau Format Shading and Borders, raw values ('#00000000' is None)
 * @property {number} [rowBandSize]             table band-size (rows): 0 turns row banding off
 * @property {string} [rowBandColor]            pane, else header, band-color (rows)
 * @property {string} [background]              table, worksheet or pane background-color
 * @property {string} [totalBackground]         Grand totals fill (data-class total, rows scope else unscoped)
 * @property {string} [subtotalBackground]      Subtotals fill (data-class subtotal, rows scope else unscoped)
 * @property {string} [totalColor]              Grand totals text color (cell, pane or header rule, data-class total)
 * @property {string} [subtotalColor]           Totals text color (data-class subtotal); Tableau also draws grand totals with it
 * @property {string} [totalWeight]             Grand totals font weight (data-class total)
 * @property {string} [subtotalWeight]          Totals font weight (data-class subtotal), also used by grand totals
 * @property {boolean} [rowDividers]            table-div (rows) line-visibility / stroke-size: false when turned off
 * @property {string} [rowDividerColor]         table-div (rows) stroke-color
 *
 * @typedef {Object} StyleRuleIR
 * @property {string} element                   all | worksheet | dash-title | dash-text | table | parameter-ctrl | ...
 * @property {{ attr: string, value: string, id?: string, field?: string }[]} formats
 *
 * @typedef {Object} BoxStyleIR
 * @property {string} [background]
 * @property {{ style: string, width?: number, color?: string }} [border]  Absent when the border style is none
 * @property {number|{ top: number, right: number, bottom: number, left: number }} [margin]   Outer padding, px
 * @property {number|{ top: number, right: number, bottom: number, left: number }} [padding]  Inner padding, px
 *
 * @typedef {Object} FontIR
 * @property {string} [fontName]
 * @property {number} [fontSize]
 * @property {string} [color]
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {'left'|'center'|'right'|string} [align]
 * @property {string} [hyperlink]
 *
 * @typedef {FontIR & { text: string }} TextRunIR
 *
 * @typedef {Object} BlendRelationshipIR
 * @property {string} source                    Datasource id
 * @property {string} target
 * @property {{ source: string, target: string }[]} mappings  Field ids linked; empty = automatic (same field names)
 *
 * @typedef {Object} WorkbookInfo
 * @property {string} name
 * @property {string} [luid]                    Tableau REST id when extracted from a server
 * @property {string} [projectName]
 * @property {string} [contentUrl]
 * @property {string} [webpageUrl]
 * @property {{ name: string, contentUrl: string }[]} [views]  The sheets Tableau publishes as views (`<workbook>/sheets/<sheet>`)
 * @property {{ contentUrl: string, name: string, workbook: string }[]} [linkedViews]  Views of the other workbooks its web zones show
 * @property {string} [tableauVersion]          workbook@version / source-build
 * @property {string} sourceFile                Workspace-relative path of the .twb/.twbx
 */

/**
 * @typedef {Object} DatasourceIR
 * @property {string} id                        Internal name, e.g. 'federated.1df63xu0j2dvhd1e3sooz18pbrcc'
 * @property {string} caption                   Display name
 * @property {PublishedRef} [published]         Set when this is a reference to a published datasource (sqlproxy)
 * @property {ConnectionIR[]} connections
 * @property {ExtractInfo} [extract]
 * @property {TableIR[]} tables                 Physical/logical tables feeding this datasource
 * @property {RelationNode} [relationTree]      Physical layer: legacy joins/unions (single logical table)
 * @property {RelationshipIR[]} relationships   Logical layer (object-graph, 2020.2+)
 * @property {FieldIR[]} fields                 Every field incl. calcs, groups, bins, sets
 * @property {FilterIR[]} filters               Datasource-level filters
 * @property {ParameterIR[]} [parameters]       Only on a standalone .tds (buildDatasourceIR): the parameters its calculations use
 * @property {{ primary: string, secondaries: string[] }} [blend]  A blend datasource convert/blends.js built from these datasources
 * @property {{ name: string, fields: string[] }[]} [hierarchies]  Hierarchies (`<drill-paths>`): field ids, top level first
 * @property {number} [fiscalYearStart]         Month 1-12 the fiscal year starts in (`<date-options fiscal-year-start>`); 1 when unset
 *
 * @typedef {Object} PublishedRef
 * @property {string} [repositoryId]            repository-location@id (the datasource contentUrl)
 * @property {string} [path]
 * @property {string} [site]
 * @property {string} [luid]                    Resolved via REST during extract
 * @property {string} [name]
 *
 * @typedef {Object} ConnectionIR
 * @property {string} id                        named-connection@name (or 'default')
 * @property {string} class                     sqlserver | snowflake | postgres | hyper | excel-direct | textscan | sqlproxy | ...
 * @property {string} [server]
 * @property {string} [port]
 * @property {string} [dbname]
 * @property {string} [schema]
 * @property {string} [warehouse]
 * @property {string} [service]
 * @property {string} [authentication]
 * @property {string} [filename]                For file connections
 * @property {Record<string,string>} extra      Other non-sensitive attributes. Credentials are never kept.
 *
 * @typedef {Object} ExtractInfo
 * @property {boolean} enabled
 * @property {string[]} hyperFiles              Package-relative paths, e.g. 'Data/Extracts/x.hyper'
 *
 * @typedef {Object} TableIR
 * @property {string} id                        object-graph object id, or relation name when there is no object model
 * @property {string} name                      Display name (object caption / relation name)
 * @property {string} [relation]                Relation name when it differs from `name` (multi-table extracts name their tables after it)
 * @property {string} [connectionId]
 * @property {'table'|'custom-sql'|'file'|'extract'} kind
 * @property {string} [table]                   e.g. '[dbo].[Orders]'
 * @property {string} [sql]                     Custom SQL text (decoded)
 * @property {PhysicalColumnIR[]} columns
 *
 * @typedef {Object} PhysicalColumnIR
 * @property {string} remoteName                Column name in the source / extract
 * @property {string} localName                 Bracketed Tableau field id, e.g. '[Region]'
 * @property {string} [tableId]                 Owning TableIR id (metadata-record object-id or parent-name)
 * @property {TableauDataType} localType
 * @property {string} [remoteType]
 * @property {number} [ordinal]
 *
 * @typedef {Object} RelationNode
 * @property {'table'|'custom-sql'|'join'|'union'} type
 * @property {string} [tableId]                 For leaves
 * @property {'inner'|'left'|'right'|'full'} [join]
 * @property {JoinCondition[]} [on]
 * @property {RelationNode[]} [children]        join: [left, right]; union: members
 *
 * @typedef {Object} JoinCondition
 * @property {string} left                      '[Orders].[Region]'
 * @property {string} right
 * @property {string} [op]                      Default '='
 *
 * @typedef {Object} RelationshipIR
 * @property {string} fromTableId
 * @property {string} toTableId
 * @property {JoinCondition[]} on               Field ids as written in the relationship expression
 */

/**
 * @typedef {'string'|'integer'|'real'|'date'|'datetime'|'boolean'|'spatial'|'table'|'unknown'} TableauDataType
 *
 * @typedef {Object} FieldIR
 * @property {string} id                        Bracketed internal name, e.g. '[Region]', '[Calculation_123]'
 * @property {string} name                      Display name: alias > caption > id without brackets
 * @property {string} [caption]
 * @property {TableauDataType} datatype
 * @property {'dimension'|'measure'} role
 * @property {'nominal'|'ordinal'|'quantitative'} [type]
 * @property {'column'|'calculated'|'bin'|'group'|'set'|'count'|'measure-names'|'measure-values'} kind
 * @property {boolean} [hidden]
 * @property {string} [semanticRole]            e.g. '[State].[Name]', '[Geographical].[Latitude]'
 * @property {string} [defaultFormat]           Tableau number format (`default-format`, e.g. 'n#,##0;-#,##0')
 * @property {string} [defaultAggregation]      Sum | Count | Avg | ...
 * @property {string} [formula]                 kind=calculated: decoded Tableau formula
 * @property {string} [description]
 * @property {{ tableId?: string, remoteName: string }} [physical]  kind=column
 * @property {{ source: string, size: number|string, peg?: number }} [bin]          size may be a parameter id
 * @property {{ source: string, bins: { label: string, values: any[] }[], otherLabel?: string }} [group]
 * @property {{ source: string, members?: any[], ranges?: { from: any, to: any }[], exclude?: boolean, all?: boolean, condition?: string, top?: { count: number, direction: 'top'|'bottom', by: string }, unparsed?: string[] }} [set]  `all`: every member (Use all); `unparsed`: groupfilter functions not read (e.g. a union of other sets)
 * @property {Record<string,string>} [aliases]  Raw value -> display label
 * @property {string} [collation]               Text comparison of the source column (metadata-record `<collation name>`):
 *                                              'binary' is case-sensitive; an ICU name ('LEN_RUS_S2', 'LROOT', ...) ignores case
 * @property {number} [fiscalYearStart]         date/datetime: month 1-12 its fiscal year starts in (the column's own
 *                                              `fiscal-year-start`, else the datasource's). Tableau names a fiscal year by
 *                                              the year it ends: with 12, 2025-12-01 is in FY2026
 * @property {DatePart} [datePartOf]            t2d's own field holding a date part a filter control shows (withDatePartFilterFields)
 */

/**
 * @typedef {Object} ParameterIR
 * @property {string} id                        '[Parameters].[Parameter 1]'
 * @property {string} name                      Display caption
 * @property {TableauDataType} datatype
 * @property {'all'|'list'|'range'} domain
 * @property {any} value                        Current value, parsed (number / string / ISO date)
 * @property {{ value: any, alias?: string }[]} [members]
 * @property {{ min?: number|string, max?: number|string, step?: number|string }} [range]
 */

/**
 * A pill: one field instance placed on a shelf/encoding, with its derivation.
 *
 * @typedef {Object} PillIR
 * @property {string} id                        As written: '[federated.x].[sum:Sales:qk]'
 * @property {string} datasourceId
 * @property {string} fieldId                   '[Sales]', or ':Measure Names' / 'Multiple Values'
 * @property {string} derivation                None | Sum | Avg | Count | CountD | Min | Max | Median | Attribute | User | Year | Month-Trunc | ...
 * @property {string} prefix                    none | sum | avg | cnt | ctd | yr | tmn | ...
 * @property {'nk'|'ok'|'qk'|string} typeKey
 * @property {boolean} continuous               typeKey === 'qk'
 * @property {boolean} aggregated               derivation is an aggregation (incl. User for aggregate calcs)
 * @property {DatePart|null} datePart           Discrete date part (yr/qr/mn/wk/dy/wd/hr...) or null
 * @property {DatePart|null} dateTrunc          Continuous truncation (tyr/tqr/tmn/twk/tdy...) or null
 * @property {TableCalcIR} [tableCalc]
 *
 * @typedef {'year'|'quarter'|'month'|'week'|'day'|'weekday'|'hour'|'minute'|'second'|'mdy'} DatePart
 *
 * @typedef {Object} TableCalcIR
 * @property {string} type                      Tableau's XML vocabulary: PctTotal | CumTotal | Rank | Difference | PctDiff | PctValue | WindowTotal | Calculation | ...
 *                                              (a pill without a table-calc node has the prefix's type: Diff, MovingCalc)
 * @property {string} [orderingType]            Rows | Columns | Table | Field | ...
 * @property {string[]} [orderFields]           Compute-using field ids
 * @property {Record<string,string>} [attrs]
 * @property {Record<string, TableCalcIR>} [nested]  Compute-using of each referenced table calc, by field id
 * @property {TableCalcIR} [secondary]          A quick calc's secondary calculation, applied to the primary's result
 *
 * @typedef {Object} ShelfNode                  Parsed rows/cols expression
 * @property {'pill'|'nest'|'concat'|'cross'} op
 * @property {string} [pillId]
 * @property {ShelfNode[]} [children]
 */

/**
 * @typedef {Object} WorksheetIR
 * @property {string} name
 * @property {string} [title]                   Plain-text title
 * @property {TextRunIR[]} [titleRuns]          Formatted runs of the title, when any carries formatting (tokens such as
 *                                              <Sheet Name> unfilled)
 * @property {string[]} datasourceIds
 * @property {Record<string, PillIR>} pills     Every pill referenced anywhere in the sheet, by id
 * @property {ShelfNode|null} rows
 * @property {ShelfNode|null} cols
 * @property {string[]} rowPills                Flattened, in order
 * @property {string[]} colPills
 * @property {PaneIR[]} panes                   One per mark layer (dual axis => several)
 * @property {FilterIR[]} filters
 * @property {SortIR[]} sorts
 * @property {string[]} [hiddenHeaders]         Pills whose header is hidden (Hide Header: label style-rule display=false)
 * @property {string[]} [linkStyled]            Pills whose header labels are underlined (label style-rule text-decoration
 *                                              underline, totals excluded): the column an author styled as a link
 * @property {Record<string, string>} [numberFormats]  Pill id -> the worksheet's Tableau number format for it (cell, else
 *                                              label style-rule `text-format`), e.g. 'c"$"#,##0;("$"#,##0)'
 * @property {{ pillId: string, min?: number, max?: number }[]} [axes]  Axes with a fixed range (axis style-rule `space`
 *                                              encoding, range-type fixed, fixedmin or fixedmax); absent in IR extracted
 *                                              before it was read
 * @property {Record<string, string>} [filterTitles]  Filter field (pill id) -> the title its quick filters show
 *                                              (quick-filter style-rule `title`)
 * @property {{ pillId: string, mode?: string }[]} [quickFilters]  The filter cards the worksheet's own window shows
 * @property {{ kind: 'filter'|'paramctrl'|'legend', param: string, mode?: string, values?: string }[]} [windowCards]  Its window's filter, parameter and legend cards, in order
 *                                              (`<window class='worksheet'>` `<card type='filter'>`, IR 15), not its dashboards'
 * @property {{ rows?: boolean, cols?: boolean, subtotals?: string[], rowsOnTop?: boolean, colsOnLeft?: boolean }} [totals]  Grand totals
 *                                              (rows/cols@total), subtotaled pills, and Tableau's "totals to top" (rows@onTop)
 *                                              and "totals to left" (cols@onLeft)
 * @property {TableStyleIR} [tableStyle]        The sheet's shading and row dividers (IR 16)
 * @property {boolean} aggregated               view/aggregation@value (false = disaggregated)
 * @property {string[]} measureValues           Pill ids included in Measure Values, when used
 * @property {boolean} hidden                   Only shown inside dashboards
 * @property {{ include?: string[], exclude?: string[] }} [linkOverrides]  Blend links turned on or off by hand ('[ds].[field]')
 * @property {BlendIR} [blend]                  Set by convert/blends.js on a worksheet moved onto a blend datasource
 * @property {ColorEncodingIR & { pillId: string, source: 'worksheet'|'datasource' }} [color]  How the color pill is colored:
 *                                              the worksheet's own encoding, else its datasource's (Edit Colors on the field)
 * @property {string} [markColor]               Fixed mark color ('#rrggbb', Color > one color) of the first pane that sets one
 * @property {Object<string, ColorEncodingIR>} [paneColors]  Encodings of the other panes' color pills, by pill id (a dual
 *                                              axis line colored by Measure Names under bars colored by a dimension)
 *
 * @typedef {Object} ColorEncodingIR             A `<encoding attr='color'>` of a mark style rule
 * @property {'palette'|'interpolated'|'custom-interpolated'|string} type  palette: categorical; the others are gradients
 * @property {string} [palette]                 Palette name: a built-in (tableau10_10_0, blue_10_0, ...) or a custom one
 * @property {{ value: any, color: string }[]} [members]  Explicit member colors (`<map to><bucket>`), raw values ('%null%' as
 *                                              null; Measure Names members are pill ids), colors '#rrggbb', at most MAX_COLOR_MEMBERS
 * @property {number} [truncated]               Number of members before the cut
 * @property {boolean} [multi]                  Some maps color tuples (`<multibucket>`), which are left out
 * @property {string[]} [colors]                custom-interpolated: the gradient's colors
 *
 * @typedef {Object} BlendIR
 * @property {string} primary                   Original primary datasource id
 * @property {{ datasourceId: string, links: { primary: string, secondary: string, datePart?: string }[] }[]} secondaries
 *
 * @typedef {Object} PaneIR
 * @property {string} [id]
 * @property {MarkClass} markClass
 * @property {string} [xAxisPill]               Dual-axis panes name the measure they plot
 * @property {string} [yAxisPill]
 * @property {{ color?: string[], size?: string[], text?: string[], label?: string[], tooltip?: string[], detail?: string[], shape?: string[], wedgeSize?: string[], path?: string[], geometry?: string[] }} encodings  Pill ids
 * @property {boolean} [showLabels]
 * @property {boolean} [boldLabels]             Its mark labels are bold (datalabel style-rule font-weight)
 * @property {string} [markColor]               Its own mark color (mark style-rule mark-color), '#rrggbb'
 * @property {{ horizontal?: string, vertical?: string }} [labelAlign]  Label alignment (cell style-rule text-align / vertical-align: left|center|right|top|bottom|auto)
 * @property {{ mode: string, color?: string }} [labelColor]  Label color (datalabel style-rule color-mode auto|user|match, color when user)
 * @property {string} [label]                 <customized-label> text, field tokens kept as <[ds].[field]>
 * @property {string} [tooltip]                 <customized-tooltip> text, field tokens kept as <[ds].[field]>
 *
 * @typedef {'Automatic'|'Bar'|'Line'|'Area'|'Square'|'Circle'|'Shape'|'Text'|'Pie'|'GanttBar'|'Polygon'|'Map'|'Multipolygon'|'Density'|string} MarkClass
 *
 * @typedef {Object} FilterIR
 * @property {string} [pillId]
 * @property {string} datasourceId
 * @property {string} fieldId
 * @property {'categorical'|'quantitative'|'relative-date'|'top'|'condition'|'wildcard'|'range-date'} kind
 * @property {any[]} [include]                  Categorical include list (raw values)
 * @property {any[]} [exclude]
 * @property {boolean} [all]                    Filter present but nothing excluded
 * @property {number|string} [min]
 * @property {number|string} [max]
 * @property {'in-range'|'in-range-or-null'|'non-null'|'null'|'all'} [includedValues]
 * @property {{ periodType: string, first: number, last: number, anchor?: string, includeNull?: boolean }} [relative]
 * @property {{ count: number|string, direction: 'top'|'bottom', by: string, rankColumn?: string }} [top]   by = Tableau expression;
 *   rankColumn: the Magic ETL rank column convert adds (not stored in ir.json)
 * @property {string} [expression]              condition / wildcard expression
 * @property {{ pattern: string, mode: 'contains'|'starts-with'|'ends-with'|'exact' }} [wildcard]
 * @property {boolean} [context]
 * @property {boolean} [aggregated]             Filter on an aggregated pill (HAVING semantics)
 * @property {boolean} [shownOnDashboard]       A dashboard filter zone exposes it
 * @property {{ from: any, to: any }[]} [ranges]  Categorical member ranges (groupfilter function='range')
 * @property {boolean} [hidden]                 Hide (kind='hide'): removes the members' marks, not their rows
 * @property {string} [group]                   filter-group: one Tableau filter on its "Selected worksheets"
 * @property {string} [shared]                  Datasource id of a <shared-views> filter ("All using this data source")
 * @property {boolean} [bare]                   No groupfilter: on a set, it keeps the set's members
 * @property {string} [memberLevel]             Groupfilter level field id when not the filter's field (set source members)
 *
 * @typedef {Object} SortIR
 * @property {string} pillId
 * @property {'computed'|'natural'|'manual'|'alphabetic'} kind
 * @property {'ASC'|'DESC'} direction
 * @property {string} [using]                   Measure pill id for computed sorts
 * @property {any[]} [order]                    Manual order
 */

/**
 * @typedef {Object} DashboardIR
 * @property {string} name
 * @property {{ width?: number, height?: number, mode: 'fixed'|'automatic'|'range' }} size
 * @property {ZoneIR[]} zones                   Flattened leaves (containers dropped), document order
 * @property {ZoneIR[]} floating                Floating zones, kept separate
 * @property {number} [tabIndex]                Position among the workbook's tabs (<windows> order)
 * @property {boolean} [hidden]                 Hidden tab
 * @property {boolean} [sheetView]              A published worksheet on no dashboard, laid out as its own view (withSheetViews)
 * @property {ContainerIR[]} [containers]       Layout containers, document order; zones and containers name theirs in `parent`
 * @property {string[]} [roots]                 Ids of the root zones and containers
 * @property {{ text: string, runs?: TextRunIR[] }} [title]  Custom dashboard title (Format > Title), `<Sheet Name>` filled in
 * @property {StyleRuleIR[]} [styleRules]       Dashboard <style> (dash-title, dash-text, table, parameter-ctrl, ...)
 * @property {string} [background]              Dashboard shading (the 'table' rule's background-color)
 * @property {DeviceLayoutIR[]} [deviceLayouts]
 *
 * @typedef {Object} ContainerIR
 * @property {string} id
 * @property {'flow'|'basic'|'other'} layout     flow: horizontal/vertical container; basic: tiled area
 * @property {'horizontal'|'vertical'} [direction]
 * @property {boolean} [distributeEvenly]
 * @property {string} [name]                    friendly-name (Item hierarchy name)
 * @property {{ x: number, y: number, w: number, h: number }} rect
 * @property {boolean} floating
 * @property {string[]} children                Child zone and container ids, in order
 * @property {string} [parent]
 * @property {boolean} [hidden]                 Hidden on the dashboard (itself or a container above it)
 * @property {BoxStyleIR} [style]
 * @property {number} [fixedSize]               Fixed width or height in px along the parent's direction
 *
 * @typedef {Object} DeviceLayoutIR
 * @property {string} name                      Phone | Tablet | Desktop
 * @property {boolean} auto                     Generated by Tableau
 * @property {{ width?: number, height?: number, mode: string }} size  mode may be 'vscroll'
 * @property {string[]} [zoneIds]               Custom layouts: leaf zone ids in order
 *
 * @typedef {Object} ButtonIR
 * @property {'navigate'|'toggle'|'download'|'none'|'other'} action
 * @property {'text'|'image'|'default'} style   default: Tableau's built-in icon (no caption or image set)
 * @property {{ caption?: string, image?: string, tooltip?: string, font?: FontIR, style?: BoxStyleIR }[]} states
 *   navigate: one state; toggle: [shown, hidden]
 * @property {number} [activeState]
 * @property {{ windowId?: string, name?: string, kind?: 'dashboard'|'worksheet'|'story' }} [target]  navigate (no name: the window is gone)
 * @property {{ zoneIds: string[], shown?: boolean }} [toggle]  Zones or containers shown and hidden; shown = their state on open
 * @property {string} [exportFormat]            download: e.g. pdf, image, crosstab
 * @property {string} [command]                 download and other: the Tableau button action
 *
 * @typedef {Object} ZoneIR
 * @property {string} id
 * @property {'worksheet'|'text'|'title'|'filter'|'paramctrl'|'legend'|'image'|'web'|'blank'|'button'|'other'} kind
 * @property {string} [worksheet]               Worksheet name (kind=worksheet, or the sheet a filter/legend belongs to)
 * @property {string} [param]                   Filter pill id or parameter id
 * @property {string} [mode]                    Control mode: dropdown | checkdropdown | checklist | radiolist | slider | typein | ...
 * @property {string} [values]                  Filter domain: relevant (only relevant values) | database | context | all
 * @property {string} [text]                    Plain text for text/title zones
 * @property {string} [title]                   paramctrl: the custom title the control shows (default: the parameter caption)
 * @property {string} [url]                   web: the page address; image: the image path in the package
 * @property {'fit'|'center'|'none'} [fit]      image: Fit Image (is-scaled), Center Image (is-centered), or neither
 * @property {ZoneImageIR} [image]              image: the bytes extract copied out of the package
 * @property {{ x: number, y: number, w: number, h: number }} rect   Fractions 0..1 of the dashboard
 * @property {boolean} floating
 * @property {TextRunIR[]} [runs]               text/title: formatted runs, when any carries formatting
 * @property {ButtonIR} [button]                kind=button
 * @property {boolean} [showTitle]              false when the zone hides its title
 * @property {string} [altText]
 * @property {string} [parent]                  Container id
 * @property {boolean} [hidden]                 Hidden on the dashboard (itself or a container above it)
 * @property {BoxStyleIR} [style]               Zone background, border, margin and padding
 * @property {number} [fixedSize]
 *
 * @typedef {Object} ZoneImageIR
 * @property {string} file                      Path relative to the workbook directory (images/<name>)
 * @property {string} name                      File name in the package
 * @property {number} bytes
 * @property {string} md5                       Lowercase hex
 * @property {number} [width]                   Pixels (src/util/image.js imageInfo)
 * @property {number} [height]
 * @property {number} [tone]                    PNG: mean luminance of its pixels weighted by opacity, 0 black to 1 white
 */

/* ------------------------------------------------------------------ */
/* Data manifest: what extract wrote for each datasource (data/*.json) */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'existing'|'cloud-amplifier'|'federated'|'connector'|'hyper'|'published-extract'|'vds'|'view-csv'|'none'} DataStrategy
 *
 * @typedef {Object} DataManifest
 * @property {string} datasourceId
 * @property {DataStrategy} strategy
 * @property {DataTable[]} tables              One per extracted table (a single flattened extract has one)
 * @property {string} [existingDatasetId]      strategy=existing
 * @property {CloudAmplifierInfo} [cloudAmplifier]  strategy=cloud-amplifier (tables is empty: nothing is copied)
 * @property {{ accountId: number|string, providerKey: string, cacheTTL: number, connection: object, tables: { tableId: string, name: string, catalog?: string, schema?: string, table: string, verified?: boolean }[], views?: boolean }} [federated]
 *   strategy=federated: one federated DataSet per table (tables is empty: nothing is copied); `views` joins them in a DataSet View
 * @property {number} [sampled]              Only the first N rows per table were kept (extract --sample-rows)
 * @property {SharedDataInfo} [shared]        A published datasource extracted once per site; table files point into its directory
 * @property {Issue[]} issues
 *
 * @typedef {Object} SharedDataInfo
 * @property {string} luid                     Tableau published datasource luid
 * @property {string} name                     Published datasource name (the Domo dataset name)
 * @property {string} dir                      Workspace-relative directory holding the data (datasources/<luid>[/sample-N])
 * @property {boolean} reused                  This workbook reused data another extraction wrote
 * @property {string} extractedAt
 * @property {string} [extractedBy]            Workspace slug of the workbook whose extract run wrote the data
 * @property {string} [updatedAt]              Tableau updatedAt of the datasource when extracted (reuse is keyed on it)
 *
 * @typedef {Object} CloudAmplifierInfo
 * @property {{ id: string, name: string, engine: string, account?: string, accountMatch?: 'equal'|'differs'|'unknown' }[]} integrations
 *   `account` is the Snowflake account of the integration's service account
 * @property {string} matchedBy                'mapping' | 'host' | 'account' | 'browse' (comma list when connections differ)
 * @property {CloudAmplifierTable[]} tables    Warehouse tables to register, deduplicated
 * @property {CloudAmplifierRelation[]} relations  One per Tableau TableIR, in datasource order
 * @property {{ tables: TableIR[], relationTree?: RelationNode, relationships: RelationshipIR[] }} [source]
 *   Physical layer of a published datasource (read from its .tds), used instead of the sqlproxy copy
 *
 * @typedef {Object} CloudAmplifierTable
 * @property {string} integrationId
 * @property {string} integrationName
 * @property {string} engine
 * @property {string} dataProviderKey          Register payload key, e.g. 'snowflake', 'google-bigquery'
 * @property {string} databaseName             Canonical warehouse names (from browsing when verified)
 * @property {string} schemaName
 * @property {string} tableName
 * @property {{ name: string, type: DomoColumnType }[]} columns   Warehouse column names, as the registered dataset exposes them
 * @property {boolean} verified                The integration was browsed and lists the table
 * @property {string} [registeredDatasetId]    Already registered on the instance
 *
 * @typedef {Object} CloudAmplifierRelation
 * @property {string} tableId                  TableIR id
 * @property {string} name
 * @property {'table'|'custom-sql'} kind
 * @property {number} [table]                  kind=table: index into tables
 * @property {string} [sql]                    kind=custom-sql: the Tableau custom SQL
 * @property {{ start: number, end: number, table: number }[]} [refs]  kind=custom-sql: table references (character offsets in sql)
 * @property {{ name: string, type: DomoColumnType }[]} [columns]       kind=custom-sql: result columns from Tableau metadata
 *
 * @typedef {Object} DataTable
 * @property {string} name                     Table name (hyper table, or datasource caption)
 * @property {string} [tableId]                Matching TableIR id when known
 * @property {string} file                     CSV path relative to the workbook directory (header row = Domo column names)
 * @property {{ name: string, type: DomoColumnType, sourceName?: string }[]} columns
 * @property {number} rowCount
 * @property {boolean} flattened               true when the table already contains all joined/related columns
 */

/* ------------------------------------------------------------------ */
/* DomoPlan: everything push will create (stage 2 output, plan.json)   */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'STRING'|'LONG'|'DOUBLE'|'DECIMAL'|'DATE'|'DATETIME'} DomoColumnType
 *
 * @typedef {Object} DomoPlan
 * @property {number} planVersion               PLAN_VERSION
 * @property {{ workbook: string, luid?: string, irFile: string }} source
 * @property {string} generatedAt               ISO timestamp
 * @property {ConvertOptions} options
 * @property {DatasetPlan[]} datasets           In dependency order (inputs before views/dataflows)
 * @property {DataflowPlan[]} dataflows
 * @property {BeastModePlan[]} beastModes
 * @property {VariablePlan[]} variables
 * @property {CardPlan[]} cards
 * @property {PagePlan[]} pages               target 'app': the app's views (no root page)
 * @property {'app'|'pages'} [target]           Dashboard container; absent means 'pages' (plans made before App Studio support)
 * @property {AppPlan} [app]                    target 'app': the workbook's App Studio app
 * @property {Issue[]} issues
 * @property {PlanSelection} [selection]       Set when the plan was pruned to a subset (convert/select.js selectPlan)
 *
 * @typedef {Object} PlanSelection
 * @property {string[]} dashboards              Resolved dashboard names
 * @property {string[]} worksheets
 * @property {string[]} datasources
 * @property {boolean} [allBeastModes]
 * @property {string[]} containerPages          Pages kept only to hold cards or subpages (no layout or filters)
 * @property {{ before: Record<string, number>, after: Record<string, number> }} counts
 */

/**
 * @typedef {Object} DatasetPlan
 * @property {string} key                       Stable key, unique within the plan
 * @property {string} name
 * @property {string} [description]
 * @property {'upload'|'connector'|'existing'|'cloud-amplifier'|'federated'|'view'|'dataflow-output'} strategy
 * @property {{ name: string, type: DomoColumnType }[]} schema
 * @property {{ file: string, sampled?: number }} [upload]  strategy=upload: CSV relative to the workbook directory (`sampled` = only the first N rows were extracted); absent = schema-only (created with a header-only upload so the schema is indexed)
 * @property {ConnectorPlan} [connector]        strategy=connector
 * @property {{ datasetId: string }} [existing] strategy=existing
 * @property {{ integrationId: string, databaseName: string, schemaName: string, tableName: string, dataProviderKey: string, registeredDatasetId?: string }} [cloudAmplifier]
 *   strategy=cloud-amplifier: registered at push with POST /data/v1/byos/register/{integrationId}; columns keep the warehouse names
 * @property {Object} [view]                    strategy=view: fusion body (POST /query/v1/fusions), or a SQL view body with
 *                                              schema.viewTemplate (POST /query/v1/views), with $refs to input datasets
 * @property {{ accountId: number|string, providerKey: string, catalog?: string, schema?: string, table: string, cacheTTL: number }} [federated]
 *   strategy=federated: created at push with POST /federated/v1/config/accounts/{accountId}/datasources; columns keep the database names
 * @property {{ dataflowKey: string, outputName: string }} [dataflowOutput]  strategy=dataflow-output
 * @property {DatasetPlan['strategy']} [sourceStrategy]  strategy=dataflow-output over one dataset's rows (Magic ETL calcs, blends, Initial SQL) or a view over federated DataSets: that dataset's strategy
 * @property {string} [datasourceId]            Tableau datasource this dataset serves (cards target this)
 * @property {boolean} cardTarget               Cards and beast modes attach to this dataset
 * @property {Record<string,string>} fieldMap   Tableau field id -> Domo column name (for cardTarget datasets)
 * @property {{ luid: string, name: string }} [shared]  Serves a published datasource shared by every workbook on the site
 *                                              (key 'pds-<luid>[.<table>]', identical in every workbook's plan)
 * @property {string} [previousKey]             Workbook-scoped key the object had before it was shared; push moves its state entry
 *
 * @typedef {Object} ConnectorPlan
 * @property {string} providerKey               Domo provider key from GET /data/v1/providers, e.g. 'snowflakekeypairauthentication'
 * @property {{ class: string, server?: string, dbname?: string, warehouse?: string }} accountMatch  Looked up in mappings.accounts
 * @property {{ name: string, value: string, type?: string, category?: string }[]} configuration
 * @property {string} query
 * @property {'REPLACE'|'APPEND'} updateMethod
 * @property {number|string|null} [accountId]  Resolved from mappings.accounts at convert time (push re-resolves)
 * @property {string[]} [unverified]            Settings not confirmed on a Domo instance
 * @property {{ providerKey: string, connectorId: string, connectorVersion?: string }} [defaultTransport]  Built-in transport, used at push only when no stream of the provider exists on the instance
 *
 * @typedef {Object} DataflowPlan
 * @property {string} key
 * @property {string} name
 * @property {Object} definition                Magic ETL body (POST /dataprocessing/v1/dataflows) with $refs for input dataset ids
 * @property {string[]} outputDatasetKeys
 * @property {boolean} runAfterCreate
 * @property {{ luid: string, name: string }} [shared]
 * @property {string} [previousKey]
 *
 * @typedef {Object} BeastModePlan
 * @property {string} key
 * @property {string} datasetKey
 * @property {string} name
 * @property {string} legacyId                  'calculation_<uuidv5>' (deterministic, referenced by cards)
 * @property {string} expression                Domo Beast Mode SQL
 * @property {boolean} aggregated
 * @property {DomoColumnType} [dataType]
 * @property {string} tableauFieldId
 * @property {string} tableauFormula
 * @property {'ok'|'approximate'|'unsupported'} status   unsupported => not pushed
 * @property {string[]} features                e.g. ['fixed', 'window'] (needed feature switches)
 * @property {string} [sharedHash]              On a shared dataset: fingerprint of the definition, compared across workbooks
 * @property {boolean} [sharedRenamed]          On a shared dataset: renamed because another workbook defines the name differently
 * @property {string} [previousKey]
 *
 * @typedef {Object} VariablePlan
 * @property {string} key
 * @property {string} name
 * @property {string} legacyId
 * @property {DomoColumnType} dataType
 * @property {string} defaultExpression
 * @property {ParameterIR} parameter
 * @property {string} [previousKey]             Workbook-scoped key before it was rekeyed per instance (`param.<name>.<type>`); push moves its state entry
 *
 * @typedef {Object} CardPlan
 * @property {string} key
 * @property {string} title
 * @property {string} worksheet                 Source worksheet name ('' for generated filter cards)
 * @property {string} datasetKey
 * @property {string} chartType                 'notebook' for a text card
 * @property {Object} body                      AnalyzerCardUpdate for PUT /content/v3/cards/kpi, dataSourceId as $ref; for a text
 *                                              card `{ notebook: { title, paragraphs }, dataSourceId? }` (src/domo/notebooks.js)
 * @property {'notebook'|'image'} [kind]        notebook: a Text (notebook v4) card for a status sheet, pushed through
 *                                              /content/v1/cards/notebook; image: a document card showing a dashboard
 *                                              image zone, body `{ image: ZoneImageIR }` (src/domo/files.js)
 * @property {Object} [bigNumber]               Summary-number subscription applied with a follow-up update
 * @property {{ column: string, formulaId?: string, name: string, dataType: string, operand: string, values: string[], pillIds?: string[], fixed?: Object[] }[]} [quickFilterDefaults]
 *                                              Tableau selections of the card's quick filters and dashboard filters (`fixed`:
 *                                              the card filters a dashboard-only one gets back unless a view takes it)
 * @property {string} [tableauLink]             Text card: the Tableau view url its last paragraph links to (on unless `--no-tableau-links`)
 * @property {{ actionId: string, action: string, column: string, native?: boolean }[]} [urlColumns]  URL actions the table
 *                                              carries as a link in each row of `column` (no card click; convert/url-columns.js)
 * @property {DrillViewPlan[]} [drillPath]     Drill views below the card, in drill order (a Tableau hierarchy, or a chart's
 *                                              date pill, convert/drill.js); push creates them with parentUrn = the card
 * @property {string[]} pageKeys
 * @property {'ok'|'approximate'|'unsupported'} status   unsupported => not pushed
 * @property {'header'|'notebook'|'stack'} [replacedBy]  A label sheet placed as a header, a status sheet placed as a text
 *                                              card, or a section
 *                                              of a merged crosstab stack (`stackedInto`): push deletes the card an earlier push created
 * @property {string} [stackedInto]             replacedBy 'stack': key of the merged card
 * @property {{ sheets: string[], datasetKey: string }} [stack]  A merged crosstab stack (convert/stack.js): its sheets top to
 *                                              bottom and the union dataset it reads; `worksheet` is ''
 * @property {FiscalCalendarNeed} [fiscalCalendar]  The card's subscriptions have `fiscal: true` (a Tableau date part,
 *                                              truncation or relative date filter on a field whose fiscal year does not
 *                                              start in January), so Domo needs this fiscal calendar to match Tableau
 *
 * @typedef {Object} FiscalCalendarNeed
 * @property {number} startMonth                2-12
 * @property {true} labelByEndYear              Tableau names a fiscal year by the year it ends
 * @property {'instance'|{ integrationId: string }} source  'instance': the card's dataset is stored in Domo, so the
 *                                              company fiscal calendar applies; integrationId: it queries a Cloud
 *                                              Amplifier integration live, whose own registered calendar applies
 *
 * @typedef {Object} DrillViewPlan
 * @property {string} title
 * @property {string} chartType
 * @property {string} field                     Field id the view shows instead of the level above
 * @property {'quarter'|'month'|'day'} [grain]   Date drill: the date level of `field` the view shows
 * @property {string} hierarchy                 Hierarchy name ('' for a date drill)
 * @property {Object} body                      AnalyzerCardUpdate like CardPlan.body; filters and quick filters stay on the card,
 *                                              which Domo applies to its drill views
 * @property {FiscalCalendarNeed} [fiscalCalendar]  As CardPlan.fiscalCalendar, for the view's own subscription
 *
 * @typedef {Object} PagePlan
 * @property {string} key
 * @property {string} title
 * @property {string} [parentKey]
 * @property {string} [dashboard]               Source dashboard name ('' for the workbook root page)
 * @property {LayoutPlan} [layout]
 * @property {PageFilterPlan[]} [filters]       Page-level default filters: push writes them as the page's "Default" filter view,
 *                                              the page default for all users
 * @property {Object} [dateRange]               App view date control default (a Domo DateTimeRange from a relative date
 *                                              filter card), written into the same "Default" filter view
 * @property {string} [appKey]                 Set when the page is an App Studio view of plan.app
 * @property {number} [navOrder]                View position in the app navigation (1-based)
 * @property {boolean} [hidden]                 Tableau-hidden dashboard: the view is hidden in the navigation
 * @property {boolean} [linked]                 hidden and opened by a button or card action: the view stays visible and only
 *                                              its navigation item is hidden
 * @property {string} [story]                   Source story name (target 'app': one view per story, points as tabs)
 * @property {string} [navIcon]                 App Studio navigation icon, a NAV_ICONS name (src/domo/apps.js)
 * @property {{ url: string, workbook: string, sheet: string, status: 'self'|'move'|'outside'|'unresolved', tableauUrl: string, contentKey?: number, title?: string, target?: string, slug?: string, name?: string }[]} [webLinks]
 *                                              Web zones that show a Tableau view: `contentKey` of its button, `tableauUrl`
 *                                              (its link when not rebuilt, and until a `move` target is pushed), view and
 *                                              workbook names (`title`, `name`), a `move` target's ref and workspace slug
 *
 * @typedef {Object} PageFilterPlan              One filter of a page's Default filter view
 * @property {string} column                    Dataset column, or the beast mode name (as the filter bar saves it)
 * @property {string} dataType
 * @property {string} operand
 * @property {string[]} values
 * @property {'LEGACY'} filterType
 * @property {Object} dataSourceId              $ref of the dataset: the filter applies to the page's cards on that dataset
 * @property {string} [sourceCard]             Key of the page's filter card on the column (sourceCardURN, as the filter bar saves it)
 * @property {string[]} [affectedCards]         Keys of the cards a filter card scoped to the Tableau filter's sheets reaches
 *                                              (affectedCardUrns); absent when it reaches every card
 *
 * @typedef {Object} AppPlan
 * @property {string} key                       Workbook key (the root page key of target 'pages')
 * @property {string} title                     The only title namePrefix / pageTitle apply to
 * @property {string} [description]
 * @property {{ base: string, overrides?: AppThemeOverrides, palette?: { name: string, colors: string[] }, itemStyles?: ItemStylePlan[] }} theme
 *                                              Built-in theme cloned at push with the workbook's formatting, app chart palette
 *                                              and item styles; written on create, and on update only with --theme or --workbook-theme
 * @property {{ orientation: 'TOP'|'LEFT', showDomoNavigation: boolean, showNavigation: boolean, showTitle?: boolean }} navigation
 *                                              As the editor sets them: LEFT has no Domo navigation and no app title
 * @property {{ persistFiltersEnabled: boolean, persistVariablesEnabled: boolean, persistDateEnabled: boolean, persistInteractionsEnabled: boolean, persistedColumns: Object[] }} persistSettings
 * @property {string} [landingKey]              PagePlan key of the landing view
 *
 * @typedef {Object} AppThemeOverrides           Workbook formatting applied to the cloned theme (hex colors '#RRGGBB')
 * @property {'Sans'|'Serif'|'Slab'|'Condensed'|'Monospace'} [fontFamily]       Every theme font
 * @property {'Sans'|'Serif'|'Slab'|'Condensed'|'Monospace'} [titleFontFamily]  Header and card title fonts
 * @property {string} [fontColor]               Dark (or light) text color of the automatic font color
 * @property {string} [background]              App and page background
 * @property {{ background?: string, borderColor?: string, borderWidth?: number }} [card]  Chart and table card style
 * @property {string} [buttonBackground]        Default button style
 * @property {AppTableStyle} [table]            The mapped table style's rows, banding, header, totals and dividers
 * @property {{ background: string|null, borderWidth: number }} [control]  Filter card style: the most common filter zone
 *                                              background (null: the theme's), no border
 *
 * @typedef {Object} AppTableStyle               The workbook's most common crosstab look ('#RRGGBB')
 * @property {string} rowColor                  Rows and header background
 * @property {string|null} bandColor            Alternate row color (null: no banding)
 * @property {string} totalColor                Total row background
 * @property {string} subtotalColor             Subtotal row background
 * @property {string|null} totalTextColor       Total row text (null: automatic)
 * @property {string|null} subtotalTextColor    Subtotal row text (null: automatic)
 * @property {'ALL'|'BELOW_HEADER'|'HORIZONTAL'|'NONE'|'VERTICAL'} borderType
 * @property {string|null} borderColor
 *
 * @typedef {Object} ItemStylePlan               A dashboard zone style other than the theme's card style (null: the theme's)
 * @property {string} key                       's1', ...: the layout content's `itemStyle`
 * @property {'card'|'table'|'control'} kind    Copied from the theme's chart (ca#), table (t#) or control (ca#) style
 * @property {string|null} background
 * @property {string|null} borderColor
 * @property {number} borderWidth               0..4
 * @property {{ top: number, right: number, bottom: number, left: number }|null} padding
 * @property {number} items
 *
 * @typedef {Object} LayoutPlan
 * @property {Object[]} content                 Layout content items; CARD items carry cardId as $ref
 * @property {{ width: number, template: Object[] }} standard   width 60
 * @property {{ width: number, template: Object[] }} compact    width 12
 */

/**
 * How a Tableau field is addressed in Domo once datasets and beast modes are
 * planned. Produced by convert/beastmodes.js, consumed by cards/filters/layout.
 *
 * @typedef {Object} FieldBinding
 * @property {string} datasetKey
 * @property {'column'|'formula'|'unsupported'} kind
 * @property {string} name                      Display name
 * @property {string} [column]                  kind=column: Domo column name
 * @property {string} [alias]                   kind=column: card column label, for a calc that only renames the column
 * @property {string} [formulaId]               kind=formula: beast mode legacyId
 * @property {string} [formulaName]             kind=formula: beast mode name, when it differs from `name` (a clash)
 * @property {string} [expression]              kind=formula: Beast Mode SQL (for card-scoped reuse)
 * @property {string} [lodExpression]           kind=formula: bare LOD expression when the Beast Mode wraps it in a default SUM;
 *                                              cards whose pill aggregates differently (avg:, min:, ...) wrap this instead
 * @property {boolean} [setMembers]             kind=formula: a Tableau set, whose beast mode returns 'In' or 'Out'
 * @property {{ source: string, members: any[], exclude: boolean }} [set]  setMembers with saved members: its source field id
 * @property {boolean} aggregated               The formula already aggregates; do not wrap in another aggregation
 * @property {DomoColumnType} [dataType]
 * @property {TableauDataType} [tableauType]
 * @property {number} [fiscalYearStart]         Date field whose fiscal year starts in this month (2-12; absent for January)
 * @property {boolean} [caseSensitive]         Text Tableau compares case-sensitively (binary collation)
 * @property {string} [reason]                  kind=unsupported
 *
 * @typedef {Object} FieldBindings
 * @property {(datasourceId: string, fieldId: string) => FieldBinding|undefined} get
 * @property {(datasourceId: string) => string|undefined} datasetKeyFor   Card-target dataset for a datasource
 */

/**
 * @typedef {Object} ConvertOptions
 * @property {boolean} [useFixed=true]          Translate LODs with Domo FIXED (needs 'fixed-beast-mode')
 * @property {boolean} [useWindowFunctions=true]   Translate table calcs with OVER() window functions
 * @property {'inline'|'variables'} [parameters='variables']  Domo variables where they work (resolveParameterModes), else inlined constants
 * @property {'flatten'|'view'|'dataflow'} [joins='dataflow']  How multi-table datasources become one dataset
 * @property {boolean} [createFilterCards=true] Dashboard filter zones become filter cards
 * @property {boolean} [materialize=true]       Calcs Beast Mode cannot express (FIXED LODs used as dimensions, wrapped nested
 *                                              LODs, trig functions) become columns computed by a Magic ETL dataflow
 * @property {boolean} [warehouseDataflows=true] Dataflows over one Cloud Amplifier integration run on its warehouse (ADR)
 * @property {boolean} [combineDataflows=true]  All dataflows on one engine become one dataflow (combineDataflows)
 * @property {string} [namePrefix='']           Prefix for created Domo object names
 * @property {string} [pageTitle]               Root page or app title (default: namePrefix + workbook name)
 * @property {'app'|'pages'} [target='app']     App Studio app with one view per dashboard, or a root page with subpages
 * @property {string} [theme]                   target 'app': built-in theme name (default Clarion); given explicitly, push writes it on update too
 * @property {'TOP'|'LEFT'} [navOrientation]    target 'app': default TOP (a long one folds into the "More" menu); LEFT with --nav left
 * @property {boolean} [persistFilters=true]    target 'app': carry filters and variables across views
 * @property {boolean} [domoNav=true]           target 'app': show Domo's own navigation next to a TOP app navigation (--no-domo-nav
 *                                              turns it off; never with LEFT)
 * @property {boolean} [workbookTheme]         target 'app': false leaves the built-in theme as is; true (given explicitly)
 *                                              also writes the workbook theme to an existing app. Default: on, create only
 * @property {boolean} [tableauLinks=true]     A link to each dashboard's view on Tableau in the text card at the top of its
 *                                              page or view; a text card just for the link when it has none
 * @property {boolean} [allBeastModes]           Keep a Beast Mode for every translated calc, not only those migrated objects use
 * @property {boolean} [unpublished]             Also migrate dashboards and sheets that are not views on Tableau and no view opens
 */

/* ------------------------------------------------------------------ */
/* Push state and mappings                                            */
/* ------------------------------------------------------------------ */

/**
 * Per target instance, persisted at <workspace>/state/<instance>.json. Makes push
 * idempotent: an existing entry means update instead of create.
 *
 * @typedef {Object} PushState
 * @property {string} instance
 * @property {Record<string, StateEntry>} objects   Keyed 'kind:key', e.g. 'dataset:superstore'
 *
 * @typedef {Object} StateEntry
 * @property {string|number} id                 Domo id
 * @property {string} [hash]                    Fingerprint of what was last pushed
 * @property {string} updatedAt
 * @property {Record<string, any>} [extra]      e.g. { legacyId, layoutId, urn, workbooks: [slug] } (`workbooks` lists the workspace
 *                                              slugs whose push wrote the entry; unpush only deletes entries no other workbook shares).
 *                                              A connector dataset has `streamId`, and `streamPending: true` until its stream ran once
 *
 * User-maintained mappings, <workspace>/mappings.json. Read by extract, convert and push.
 *
 * @typedef {Object} Mappings
 * @property {Record<string,string>} datasets   Tableau datasource caption or luid -> existing Domo dataset id
 * @property {{ match: { class?: string, server?: string, dbname?: string }, accountId: number|string, providerKey?: string, connectorId?: string, connectorVersion?: string|number, templateStreamId?: number|string }[]} accounts  Extra keys are passed to createConnectorStream
 * @property {{ match: { class?: string, server?: string, dbname?: string }, integrationId: string|false|null, dataProviderKey?: string, databases?: Record<string, string> }[]} [cloudAmplifier]
 *   Pin a connection to a Cloud Amplifier integration (or disable it with integrationId false); overrides automatic matching
 * @property {{ match: { class?: string, server?: string, dbname?: string }, accountId: number|string|false, providerKey?: string, databases?: Record<string, string>, cacheTTL?: number }[]} [federated]
 *   Opt in to federated DataSets (queried live) for plain tables of a connection; cacheTTL in seconds (default 900)
 * @property {Record<string,string>} columns    Optional 'Datasource caption.Field name' -> Domo column override
 * @property {Record<string,Record<string,string>>} [customSql]  Datasource caption or luid -> Custom SQL table name -> query
 *   that replaces it for Cloud Amplifier, for a warehouse that shares the same data under other objects
 * @property {Record<string,'export'|'none'>} [unmapped]  Datasource caption or luid -> what to do when no mapping covers it:
 *   'export' a snapshot (hyper, published-extract, vds, view-csv) or 'none' (no data). Without it, extract asks.
 */

export {};
