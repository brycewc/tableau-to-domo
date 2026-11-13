# Architecture

`tableau-to-domo` (`t2d`) migrates Tableau workbooks to Domo in three stages. Each
stage is a plain async function in `src/` that reads and writes JSON files in a
workspace directory. The CLI in `src/cli/` is a thin shell over those functions,
so a UI can call the same functions later and subscribe to the same progress events.

```
Tableau REST / Metadata API / VizQL Data Service / .twbx file
        │
        ▼  extract   src/pipeline/extract.js
  workspace/workbooks/<slug>/  source.twbx, workbook.twb, ir.json, metadata.json, images/* (dashboard images),
                               data/<dsSlug>/*.csv, data/<dsSlug>.manifest.json
  workspace/datasources/<luid>/  published datasources shared by several workbooks: manifest.json,
                                 data/datasource/*.csv, beastmodes.json (shared beast mode variants),
                                 definition.json (the published .tds definitions extract merges)
        │
        ▼  convert   src/pipeline/convert.js   (pure: no network)
  plan.json  +  report.md
        │
        ▼  push      src/pipeline/push.js
  Domo: DataSets → DataFlows/Views → Variables → Beast Modes → App → Views (or Pages) → Cards → Layouts → Navigation
  workspace/state/<instance>.json   (Domo ids per plan key, makes push idempotent)
```

Data contracts live in [src/model/types.js](../src/model/types.js) (`WorkbookIR`, `DataManifest`,
`DomoPlan`, `FieldBinding`, `PushState`, `Mappings`). Read it before changing any stage.

## Conventions

- Node 20+, ESM, JSDoc types, no build step. Tabs, single quotes, semicolons.
- Allowed runtime dependencies: `fast-xml-parser`, `yauzl`, `dotenv`, `csv-parse`, Node built-ins.
- Core code never prints and never calls `process.exit`. It throws, and it reports progress
  through an `Emitter` (`src/util/events.js`). Only `src/cli/` writes to stdout/stderr.
- All HTTP goes through `request()` in `src/util/http.js` (timeouts, retry on 429/5xx).
- Cross-object ids inside a plan are `{ $ref: 'kind:key' }` (`src/util/refs.js`), resolved at push time.
- Names: Tableau field display name → Domo column via `domoColumnName()` (`src/model/naming.js`).
  Dataset beast mode legacyIds are deterministic: `beastModeLegacyId(workbookKey, datasetKey, fieldId)`.

## Module contracts

Signatures below are the integration contract between modules. Options objects may
grow; positional parameters may not change without updating every caller.

### Config and utilities (done)

| Module | Exports |
|---|---|
| `src/config.js` | `loadConfig({ env, cwd, overrides }) → T2DConfig`, `requireTableau(cfg)`, `requireDomo(cfg)`, `ConfigError` |
| `src/util/http.js` | `request(url, opts)`, `poll(check, opts)`, `sleep(ms)`, `HttpError` |
| `src/util/events.js` | `createEmitter(sink, stage) → Emitter`, `noopSink`; a `decision` event carries a `DataDecision` (`src/pipeline/decisions.js`) so a UI can ask too |
| `src/pipeline/decisions.js` | `DECISION_CHOICES` (cloud-amplifier, dataset, account, export, none; zero copy first, `copies` tells whether data lands in Domo), `UNMAPPED_POLICIES`, `completeDecision`, `mergeDecisions`, `decisionEntry`, `recordAnswers(file, decisions, answers)`, `describeDecision`, `formatDecisions`, `DataDecisionError`. The CLI prompt is `src/cli/decide.js` (`deciderFor(ctx)`, `promptDecisions`); `main` exits 3 on `DataDecisionError` (JSON result carries `error.code` and `decisions`) |
| `src/util/timing.js` | `createTimer({ emitter, now }) → Timer` (`time(step, fn, meta)`, `start(step, meta) → end(meta)`, `phase(step, active)`, `finish(meta) → Timing`), `formatDuration`, `formatBytes`, `describeStep`, `slowestSteps`, `formatTimingSummary` |
| `src/util/ids.js` | `uuidv5(name)`, `beastModeLegacyId(...parts)`, `slugify(v)`, `shortHash(v)` |
| `src/util/refs.js` | `ref(kind, key, field?)`, `isRef(v)`, `resolveRefs(v, lookup)`, `collectRefs(v)` |
| `src/model/naming.js` | `stripBrackets(id)`, `domoColumnName(name)`, `dedupeNames(names)`, `bmColumn(name)` |

### Tableau access: `src/tableau/`

`client.js`
- `class TableauClient`
  - `constructor(tableauConfig, { emitter } = {})`
  - `async signIn()`: serverinfo version detection (unless `apiVersion` is pinned), PAT sign-in,
    manual 301 handling for Cloud pods. Stores `token`, `siteId`, `userId`, `apiVersion`.
    A PAT allows one session, so sign-in is serialized and never repeated concurrently.
  - `async signOut()`
  - `async get(path, query?)`: `path` relative to `/api/{ver}/sites/{siteId}` (e.g. `/workbooks`); JSON
  - `async paginate(path, { collection, item, query, pageSize })`: all pages, returns the item array
    (e.g. `collection: 'workbooks', item: 'workbook'`)
  - `async download(path, destFile, query?)`: streamed to disk, returns `{ file, filename, bytes }`.
    `destFile` may be a function `(filename, contentType) => path` to name the file from Content-Disposition.
  - `async graphql(query, variables)`: Metadata API; throws on `errors`
  - `async vds(endpoint, body)`: VizQL Data Service `POST /api/v1/vizql-data-service/{endpoint}`
  - Re-signs-in once on 401.
  - Other HTTP failures throw `TableauApiError` (a `HttpError` with `code`, `summary`, `detail`) whose message
    is `Tableau <code>: <summary>: <detail> (<capability hint>)`; `parseTableauError(body)` reads REST XML/JSON
    and VizQL Data Service error bodies.

`content.js`
- `listProjects(client)`, `listWorkbooks(client, { project, name, tag })`, `listDatasources(client, { project, name })`
- `findWorkbook(client, nameOrLuid, { project })`: throws if ambiguous
- `findDatasource(client, { luid, name, contentUrl, project })` → datasource or `null`; throws if ambiguous
- `listWorkbookViews(client, workbookLuid)`
- `downloadWorkbook(client, luid, destDir, { includeExtract = true })` → `{ file }`
- `downloadDatasource(client, luid, destDir, { includeExtract = true })` → `{ file }`

`metadata.js`
- `fetchWorkbookMetadata(client, workbookLuid)` → raw GraphQL `workbooks[0]` (always under `embeddedDatasources`), or `null` when the workbook is not in the catalog
- `applyMetadata(ir, metadata)` → mutates IR: fills missing formulas and published-datasource luids, adds issues

`package.js`
- `openPackage(filePath)` → `{ kind: 'twb'|'twbx'|'tds'|'tdsx', xml, xmlEntry, entries: string[], findEntry(ref), extractEntry(entry, destFile), close() }`
  (`findEntry` resolves an extract dbname as written in the XML to a package entry)
  Guards: XML ≤ 100 MB, compression ratio ≤ 200, reject `<!DOCTYPE`/`<!ENTITY`, ignore cache XML.

`twb/index.js`
- `buildWorkbookIR(xml, { sourceFile, info }) → WorkbookIR`
- `buildDatasourceIR(xml) → DatasourceIR` for a standalone `.tds`, with `parameters` (the parameters its calculations use)
- `WorkbookIR.blendRelationships`: Data > Edit Blend Relationships (`datasource-relationships`), `{ source, target, mappings:
  [{ source, target }] }` with field ids (empty mappings = automatic, by field name). `WorksheetIR.linkOverrides`
  `{ include?, exclude? }`: blend links turned on or off by hand (`join-lod-include-overrides` / `-exclude-overrides`,
  `[ds].[field]`). A published datasource's copy lists its parameters in `<datasource-dependencies datasource='Parameters'>`;
  they are added when the workbook does not list them. Metadata records with `class='measure'` are read like columns.
- Filters: `groupfilter function='range'` (a shift-selected run of members) becomes `FilterIR.ranges: [{ from, to }]`, in a
  union next to `include`, and in `except` as excluded ranges (with `exclude`, possibly empty); a set with ranges gets `set.ranges`.
  `except` is set difference, so an `except` child is complemented: `except(level-members, except(level-members, X))`
  (Tableau's exclude-mode double negation) is `include X`; a subtracted subtree that does not reduce to one categorical
  facet is `twb.unknown-groupfilter` instead of a silent "all".
  A Top N (`function='end'`) over a member list (the General tab's selection under `order`) ranks within that list,
  kept as `top.members`.
- `TableCalcIR.secondary` (IR 7): a quick calc's second field-less `<table-calc>` (Pareto `pcto:cum`: CumTotal then
  PctTotal). Types stay in XML spelling (`Difference`, `WindowTotal`, `PctValue`); convert maps them with `quickCalcType`.
  A v6 IR with a two-calc prefix and no `secondary` gets `convert.ir-outdated`.
- `FieldIR.collation` (IR 8): the metadata-record `<collation name>` (`binary`, `LEN_RUS_S2`, `LROOT`, ...), also on calcs
  that have a record (published datasources). A v7 IR with a text member range and no collation anywhere gets
  `convert.ir-outdated` (such ranges then compare ignoring case).
- `FilterIR.hidden` (IR 9): a worksheet `<filter kind='hide'>` (Hide in Tableau), which removes the members' marks but
  not their rows. A v8 IR with a member filter on a dimension only some panes encode gets `convert.ir-outdated`.
- `WorksheetIR.linkStyled` (IR 10): pills whose header label is underlined (label style-rule `text-decoration: underline`, not
  `data-class='total'`), the column an author styles as a link. A v9 IR with a field-token URL action and no `linkStyled`
  anywhere gets `convert.ir-outdated`.
- Image zones (IR 11) carry `fit` (`fit` for Fit Image `is-scaled`, `center` for `is-centered`, else `none`) and `image`
  `{ file, name, bytes, md5, width, height, tone }` (`src/util/image.js imageInfo`: pixel size of a PNG, JPEG or GIF; tone,
  PNG only, the opacity-weighted mean luminance, 0 black to 1 white; convert adds them to images extracted before): extract copies each package entry a zone's path resolves to (`pkg.findEntry`) once into
  `images/` (`src/pipeline/images.js`; a basename two entries share gets an md5 prefix); a path not in the package is the info
  `extract.image-missing`. For an older ir.json, convert reads the images (and `fit`, from a parse of the package XML) from the
  package extract stored (`metadata.sourceFile`, else `source.twbx`), in memory, so no Tableau extract is needed.
- Filter scope (IR 13): `FilterIR.group` is the `filter-group` attribute, the id every copy of one filter set to "Apply to
  Worksheets > Selected worksheets" carries (ids repeat across fields); `FilterIR.shared`
  is the datasource id on the copies of a `<shared-views>` filter ("All using this data source"), which carry no group.
  `shownOnDashboard` still marks only the zone's own sheet; convert resolves the scope per dashboard.
- Set filters that keep the set's members (IR 13): a bare `<filter class='categorical' column='[Set]' />` is `bare: true`, and a
  groupfilter whose level is another field than the filter's (`level-members` or members of the set's source, the "Show
  members in set" quick filter) sets `memberLevel` to that field id. In/Out mode (level on the set, `true`/`false`) has
  neither. A v12 IR with a dashboard filter zone whose field another sheet on the dashboard also filters, a shared-view
  filter, or a set filter selecting nothing or members gets `convert.ir-outdated`.
- Filter zones carry `values` (the quick filter domain: `relevant`, `database`, `context`, `all`).
- Worksheet filter cards (IR 15): `WorksheetIR.quickFilters` lists the `<card type='filter' param mode>` entries of the
  worksheet's own `<window class='worksheet'><cards>`, the quick filters Tableau shows on the sheet itself (parameter cards
  are not read here). Dashboard filter zones belong to the dashboard, not the sheet: a worksheet can show one filter card
  and a few parameter cards in its window while its dashboards show dozens of its filters.
- Fiscal year start (IR 17, `twb/datasources.js` `fiscalMonth`, `datasourceFiscalStart`): `DatasourceIR.fiscalYearStart` is the
  month (1-12) of `<overridable-settings><date-options fiscal-year-start='december'>` (2020+; older workbooks put
  `<date-options>` directly under the datasource), a month name, January (1, Tableau's default) when unset. Every date and
  datetime field gets `FieldIR.fiscalYearStart`: its column's own `fiscal-year-start` (a number, '12' seen on December
  datasources and on single fields of January ones) or the datasource's. A column's '0' is read as "inherit the datasource
  setting": it appears almost only on fields of December datasources, next to '12' on fields there
  that set December explicitly. Tableau names a fiscal year by the year it ends (with a December start, 2025-12-01 is FY2026
  Q1 and 2025-11-30 FY2025 Q4). Fiscal starts apply to date part and truncation pills and relative date filters only; DATEPART
  and DATETRUNC in a calc are calendar ones, which is why some workbooks write `DATEPART('quarter', DATEADD('month', 1, [d]))`
  by hand. A v16 IR with any date field gets the info `convert.ir-outdated` and converts as before (every year from January).
- Dashboards carry `tabIndex` (position in `<windows>`, the tab order) and `hidden` (a hidden tab); `WorkbookIR.filterActions`
  lists `tsc:tsl-filter` actions as `{ name, sourceDashboard, target }` (convert turns on interaction carry-over in an app when one
  targets another dashboard).
- IR 2 (`IR_VERSION` 2; every field optional, so an older `ir.json` still loads, and convert adds `convert.ir-outdated`, a
  warning for target app, when a version 1 IR has none of these fields; JSDoc in `types.js`): `WorkbookIR.actions` (`ActionIR`: type
  filter, highlight, url, navigate, parameter, set or other; trigger select, hover or menu; `source` with resolved `worksheets`;
  `target` with `kind` and target `worksheets`; field pairs, clear mode, url template and tokens, parameter and set details),
  `WorkbookIR.stories` (`StoryIR` with points and what each captured), `WorkbookIR.style` (workbook style rules, `defaults`
  from the `all` rule, custom palettes). `DashboardIR` gains `containers` (`ContainerIR` tree), `roots`, `title` (custom title,
  `<Sheet Name>` filled in), `styleRules`, `background` and `deviceLayouts`; `ZoneIR` gains kind `button` with `ButtonIR`
  (navigate with a resolved target, toggle with its zone ids and initial state, download), `runs`, `showTitle`, `altText`,
  `parent`, `hidden` and `style`. Exports `containerZones(dash, containerId)` (leaves under a container), `parseTslLink`, `urlTokens`.
- IR 3 (`IR_VERSION` 3; a version 2 IR with no worksheet colors gets the info `convert.ir-outdated`): `colors.js` reads the
  'mark' `<encoding attr='color'>` rules of datasource and worksheet styles (`ColorEncodingIR`: type, palette, member maps as raw
  values with '#rrggbb' colors, at most `MAX_COLOR_MEMBERS` 1000 (IR 12; 200 before, which cut a long period map so the latest
  periods lost their colors), `truncated`, `multi` for tuple maps, custom gradient colors).
  `WorksheetIR.color` is the encoding of the sheet's color pill (worksheet first, then its datasource's for the column instance or
  the column), with `pillId` and `source`; `WorksheetIR.markColor` the first pane's fixed `mark-color`; `WorksheetIR.paneColors`
  (IR 12) the encodings of the other panes' color pills, so a dual axis line colored by Measure Names under bars colored by a
  dimension gets its measure color as a rule on the line's column.
- IR 5: a `paramctrl` zone with `custom-title='true'` carries `ZoneIR.title`, the zone's formatted text (Tableau shows the
  parameter caption otherwise). A version 4 IR whose parameter controls have no title gets the info `convert.ir-outdated`.
- IR 6: `PaneIR.labelAlign` (`{ horizontal, vertical }` from the pane's 'cell' style rule `text-align` / `vertical-align`) and
  `PaneIR.labelColor` (`{ mode, color }` from the 'datalabel' rule `color-mode` and the user `color`); formats with a `field`
  or `scope` are left out. A version 5 IR with labeled panes and neither field gets the info `convert.ir-outdated`.
- Strips `_.fcp.<Feature>.<true|false>...` prefixes (keeps the `true` variant), decodes formulas,
  redacts credentials (never stores username/password/token-like attributes).
- `twb/shelf.js`: `parsePillId(id) → PillIR` and `parseShelf(text) → ShelfNode` are exported for convert.
  Measure Names member and bucket values are backslash-unescaped (`[usr:\% Share:qk]` names `[usr:% Share:qk]`)
  before they become pill ids.

`data/`
- `data/index.js`: `extractData({ client, ir, datasource, pkg, dir, strategy, mappings, python, cloudAmplifier, federated, slug, skipViewCsv, emitter }) → DataManifest`
  (`slug` names the data folder, default `datasourceSlug(datasource)`; `skipViewCsv` keeps auto from falling back to view-csv)
  - `strategy`: `'auto'|'existing'|'cloud-amplifier'|'federated'|'connector'|'hyper'|'published-extract'|'vds'|'view-csv'|'none'`
  - auto = existing mapping → cloud-amplifier (a Domo Cloud Amplifier integration can read every table) →
    federated (opt-in: a `mappings.federated` entry matches and every table is plain) →
    connector (live connection with a matching account mapping) → hyper
    (packaged extract and a working sidecar) → published-extract (published datasource with a resolved
    luid, a client and a working sidecar) → vds (published datasource) → view-csv (lossy fallback).
    The order is zero copy first (cloud-amplifier, federated), then the connector, then the snapshot strategies.
  - federated (`tryFederated`): `federated` is `{ viewsEnabled(), browse(accountId), forConnection(connection) }`
    (`federatedLookup` in `pipeline/extract.js`). The mapping is found by `findFederatedMapping` (most specific
    `match`, server as a host); `planFederatedTargets(source, { mapping, viewsEnabled, fields })` (`data/federated.js`)
    gives `{ connection, targets }` or `{ ineligible }`: one connector-class connection, a federated provider for the
    class, no Initial SQL, plain tables or `SELECT * FROM x` (catalog = database, schema default `dbo` for SQL Server,
    `databases` renames), several tables only with feature `federated-views` on and no union or full join, and no calc
    with an LOD or a table calculation (Magic ETL cannot read federated DataSets). The browse confirms each target with
    `findInTree` (names as the tree spells them, `verified`); a failed browse warns `data.federated-unverified`. Not
    eligible: warning `data.federated-ineligible`, `ctx.federatedBlocked`, and the next strategy. The manifest has
    `federated: { accountId, providerKey, cacheTTL, connection, tables, views? }` and no data files.
  - connector with Initial SQL (`tryConnector`): `planDatasourceInitialSql(source)` (`convert/initial-sql.js`) runs at
    extract so an untranslatable batch never becomes a connector: warning (error when explicit)
    `data.connector-initial-sql` with `initialSqlBlockedMessage` (statement number, text and reason),
    `ctx.connectorBlocked`, and the next strategy.
  - Snapshot gate (`snapshotGate`): under auto, before the first snapshot strategy, `findUnmappedDecision(ds, mappings)`
    reads `mappings.unmapped` (caption, luid, name or contentUrl → `'export'|'none'`). `'none'` returns no data
    (`data.unmapped-none`). Without a choice and with `unmapped: 'ask'` it returns `{ strategy: 'pending', decision }`
    and writes nothing; the decision holds the datasource, its non-file connections (no credentials), up to 20 tables,
    the likely snapshot strategies and `cloudAmplifier` suggestions (`ctx.caSuggestions`: share, unconfirmed or
    ambiguous integrations with `match` and `databases`), `connectorBlocked` (Initial SQL t2d cannot translate) and
    `federatedBlocked` (why federated cannot serve it). `planOnly` returns `{ strategy: 'deferred' }` for a decided
    snapshot; `snapshotOnly` (with `priorIssues`) skips existing, cloud-amplifier and connector on the rerun. With
    `unmapped: 'ask'` a mapped account replaces a Tableau extract under auto (a mapping is a decision); with the
    default `'export'` the connector is used under auto only for live connections, as before.
  - `readPublishedDatasource(client, luid, tmpDir)` downloads a published datasource's .tds without its extract;
    `mergePublishedDefinitions(ds, published)` adds the calculations, groups, bins, sets and columns the workbook copy lacks
    and fills missing aliases, `unknown` datatypes and empty formulas (it never turns a workbook column into a calculation).
    `extractData` accepts `published` so cloud-amplifier and connector reuse that download.
  - published-extract downloads `data/<datasourceSlug>/source.tdsx` with its extract, exports the .hyper and
    maps columns like the packaged path, using the .tds tables/metadata-records when the workbook's sqlproxy
    copy has none. Fields defined only in the published datasource (calculations included) are merged into
    the workbook `DatasourceIR.fields` (info issue `data.published-fields-merged`), so they become Beast Modes.
  - `dir` is the workbook directory. Writes `data/<datasourceSlug>/<table>.csv` with Domo column names
    as the header and `data/<datasourceSlug>.manifest.json`. Manifest file paths are relative to `dir`.
  - Strategy failures do not throw: they return strategy `'none'` with an error issue. Convert then plans a
    schema-only dataset (created empty) so cards and pages are still built.
  - cloud-amplifier: `cloudAmplifier` is `{ getIntegrations(), browser }` (see `cloudAmplifierLookup` in
    `pipeline/extract.js`); without it only `mappings.cloudAmplifier` entries match. A published datasource's
    connections and tables are read from its `.tdsx` downloaded with `includeExtract=false`; its fields are
    merged like published-extract and its physical layer is stored in `manifest.cloudAmplifier.source`.
    The manifest has no data files (`tables: []`); `manifest.cloudAmplifier` lists the tables to register and
    one relation per `TableIR` (a registered table, or custom SQL with table reference offsets).
- `data/cloud-amplifier.js`: `planTargets(source)`, `matchConnection(connection, targets, { integrations, mappings, browser })`,
  `matchCloudAmplifier({ source, integrations, mappings, browser }) → { status, info?, reason? }`, `createBrowser(c, api)`,
  `findCloudAmplifierMapping(connection, mappings)`, `cloudAmplifierEngines(class)`.
  Matching: mappings entry → engine fits the class → same host when the integration exposes one → same
  Snowflake account (`browser.account(integration)` → `getSnowflakeAccount`, cached per service account;
  `compareSnowflakeAccounts(account, server)` is equal / differs / unknown, and a locator against an org-account
  name is unknown) → browse (database, schema, table must all be listed). An equal account is trusted like a
  host match but the browse must pass (`matchedBy: 'account'`); a different account is never a candidate.
  Results carry `accounts: AccountCheck[]` for the report. Several candidates = ambiguous (none picked, warning
  with a mappings snippet); a browse-only match when the connection names a server the integration cannot be
  tied to = unconfirmed (not used, warning with a mappings snippet); when nothing matches, `suggestShares`
  browses other-account integrations and those missing the database for the same schema and tables, under the
  same database or one sharing a name token (`findRenamedDatabases`, 40 browse calls per connection), and
  returns `suggestions` (issue `data.cloud-amplifier-share` with a `cloudAmplifier` snippet and `databases`
  rename; never applied); transient warehouse errors (incident, cold start) =
  unknown, never "no match"; Initial SQL and unparseable custom SQL are ineligible. Unquoted SQL names fold to
  the engine's case; quoted names match exactly.
- `data/federated.js`: `findFederatedMapping`, `federatedConnection(source)`, `planFederatedTargets`, `cacheTtlOf(mapping)`
  (default 900, clamped 5 s to 2 days), `federatedEntry(connection, accountId, opts)` (the decision's ready-to-paste entry).
- `data/sql-refs.js`: `parseSqlTableRefs(sql) → { refs: [{ start, end, parts }], unsupported? }` (FROM/JOIN
  and comma joins; CTEs, derived tables and `EXTRACT(x FROM y)` skipped; table functions and stages unsupported)
- `data/hyper.js`: `checkHyper(python)` → `{ ok, version?, error? }`; `exportHyper({ python, hyperFile, outDir }) → { tables }`;
  `resolvePythonPath(python, cwd)` (a path with a separator is made absolute; the sidecar runs with cwd = tmpdir);
  `detectPython({ python, explicit, cwd })` falls back to `<cwd or project>/.venv/bin/python` when no
  interpreter was configured and the default lacks tableauhyperapi (`config.pythonExplicit` is false).
  - Sidecar: `python/hyper_export.py` (needs `pip install tableauhyperapi`).
- `data/vds.js`: `exportPublishedDatasource(client, datasourceLuid, outFile, { fields }) → { columns, rowCount }`
- `data/view-csv.js`: `exportViewCsv(client, viewLuid, outFile) → { columns, rowCount }`

### Conversion: `src/convert/` (pure, no I/O)

`calc/`: Tableau formula → Beast Mode SQL
- `parseFormula(text) → AST` (throws `CalcSyntaxError` with position)
- `analyzeFormula(ast) → { aggregated, lod: [...], tableCalcs: [...], refs: [...], userFunctions, unsupported }`
- `translateCalc(formula, ctx) → { expression, aggregated, dataType, status, features, issues, lodExpression? }`
  - A bare LOD used as a measure with no `ctx.outerAggregation` is wrapped in SUM; `lodExpression` is the
    unwrapped LOD so cards can apply the pill's own aggregation (`FieldBinding.lodExpression`).
  - Trailing commas in IN lists and argument lists are accepted (Tableau allows them) and dropped.
  - Beast Mode has no boolean literals or values (bare TRUE/FALSE are read as columns; a comparison as a CASE result
    or operand is a PARSING_ERROR). Boolean nodes are emitted as predicates (`TRUE` is `1 = 1`); in value position
    (the result, THEN/ELSE, IFNULL, comparisons of two booleans, aggregate and table-calc arguments, ISNULL and STR)
    they become `'true'`/`'false'` strings (MIN/MAX of that text orders like FALSE < TRUE, COUNTD counts the same
    members), and a boolean IF/CASE/IIF or MIN/MAX/ATTR is compared back with `= 'true'`. A boolean CASE operand
    becomes a searched CASE. NOT of a
    `<`/`>`/`<=`/`>=` comparison flips the operator (Beast Mode rejects `NOT (a > b)`), and the NULL keyword is
    emitted as `NULLIF(1, 1)` or dropped from ELSE (Beast Mode rejects NULL).
  - Constants fold: literals, inlined parameters and calcs that reduce to one, through comparisons, IN, NOT,
    AND/OR, IF/CASE/IIF, ISNULL, CONTAINS/STARTSWITH/ENDSWITH, LEN, UPPER/LOWER, string `+` and numeric `+ - *`
    (dead branches are never translated, so their issues are not reported). The SQL of a folded function or
    arithmetic node is kept as written; only conditions collapse. Not folded: other functions, `/`, dates, and
    text ordering (`<`, `>`). Text that differs only in case is left to Domo, which compares case-insensitively
    (issue `calc.case-sensitivity`), so inlined and `variables` parameters pick the same branch.
  - Beast Mode rejects many MySQL functions (ILLEGAL_FUNCTION), so they are rewritten: LOG to `LOG(10, x)`, EXP
    to `POWER(e, x)`, SIGN to a CASE, PI to a literal, DEGREES/RADIANS to arithmetic, DIV to `TRUNC(a / b)`,
    LTRIM/RTRIM and REGEXP_MATCH to REGEXP_REPLACE (`calc.regexp-match` when the pattern can match an empty
    string), FIND with a start to INSTR on a SUBSTRING, SPLIT and FINDNTH to SPLIT_PART (Snowflake rejects
    SUBSTRING_INDEX), SPACE to LPAD, MAKETIME to DATE_ADD. ASCII/CHAR fold for literals only; trig functions and REGEXP_EXTRACT are `calc.no-equivalent` (`catalog.js` NO_EQUIVALENT).
  - Calc references are always inlined. Variables (parameters in `variables` mode, the default) are referenced as
    `DOMO_BEAST_MODE(<legacyId>)` (`variableReference`); push swaps in the template id (`bindVariables`). Domo does not
    resolve a backticked variable or beast mode name (validation `ILLEGAL_REFERENCE`); `DOMO_BEAST_MODE(<template id>)`
    is the only reference it saves and runs.
  - Date SQL puts every computed INTERVAL value in parentheses (`INTERVAL (DAYOFYEAR(d) - 1) DAY`): validateFunctions
    accepts arithmetic after INTERVAL but the query fails (ib:4201). Beast Mode MAKEDATETIME is
    `TIMESTAMP(CONCAT(DATE(d), ' ', TIME(t)))` (two-argument TIMESTAMP validates, then fails at query time).
  - Parse time: icebox parses a Beast Mode with Domo's JSqlParser fork and answers PARSING_ERROR when that takes over
    `icebox.parseSeconds` (60 s, `JsqlParseTimeoutException`). Its syntactic lookaheads re-scan a comparison's left
    operand (IN, BETWEEN, IS NULL, LIKE, then the comparison), a parenthesized condition, a WHEN condition, and each
    function's arguments, so cost multiplies per nesting level. Beast Mode SQL therefore puts a CASE or a long
    (`HEAVY_OPERAND_CHARS`) operand on the right of a comparison (`0 <= <expr>`, `'true' = CASE ... END`), drops the
    parentheses of a referenced or parenthesized comparison, writes `IF x = c THEN NULL ELSE x END` and
    `IF x != c THEN x END` as `NULLIF(x, c)`, folds DATEADD by years, quarters or months of a year, quarter or month
    start into one DATE_ADD, and drops `DATE()` around a date-only value (a truncation, or a DATE_ADD of one by days or
    more). A card formula (date part, sort key, filter or split condition) reads a calc whose expression is
    `REFERENCED_EXPRESSION_CHARS` (8,192) or longer as `DOMO_BEAST_MODE(<legacyId>)` of its dataset Beast Mode instead of
    inlining it (`bindingExpression`), so that Beast Mode is kept and pushed, and push swaps in its template id
    (`withBeastModes`); a card formula on a Beast Mode that was not pushed is dropped with its uses. apiContent saves a
    new card's formulas through icebox with a 60 s read timeout, which an 81 KB inlined calc overran. SQL saved as a
    dataset Beast Mode (an aggregate filter's, a stacked crosstab's section rows) still inlines it.
  - Size guard: Domo rejects a formula over `MAX_EXPRESSION_BYTES` (4,194,304, and validateFunctions answers 400 for
    the whole batch), so a longer expression (UTF-8
    bytes) is `calc.expression-too-large` (unsupported, both dialects). A Beast Mode over `LARGE_EXPRESSION_BYTES`
    (64 KiB) is `calc.expression-large` (approximate). materialize.js keeps inlined calcs under it (below).
  - A boolean in value position repeats its predicate (`CASE WHEN p THEN 'true' WHEN NOT p THEN 'false' END`) unless
    the predicate knows when it is not null: `x IN (<non-null constants>)` is not null when `x` is, ISNULL never is,
    and AND/OR with a never-null side follow from the other side. Large sets stay one copy of their member list.
    A set inlined into a calc (`calcFormula`) is `NOT ISNULL(x) AND (x IN (...))`, so a null value is Out (In for an
    exclude set) as in Tableau, unless the null member is listed. Filter and set members Tableau matched ignoring case
    expand to every spelling the data holds (`DataManifest.memberCase` member to string or string[]).
  - Boolean columns: LONG/DOUBLE/DECIMAL compare with `= 1`; text compares with `LOWER(col) = 'true'` on upload
    datasets (t2d normalizes the values) and `LOWER(col) IN ('true', 't', '1', 'yes', 'y')` elsewhere
    (`rawBoolean` on the resolved column).
  - Table calcs (`tablecalc.js`, behind `useWindowFunctions`, on by default; `--no-window-functions`): `ctx.tableCalc = { partitionBy, orderBy, issues? }`
    gives the window; `tableCalcAddressing(worksheet, pillId, toItem, { calc?, toMeasure? })` derives it from the sheet
    layout and the compute-using setting (`calc`: the secondary's setting; `toMeasure`: aggregate SQL of a computed sort's
    measure, which orders the window ahead of the sorted dimension as a tiebreak, so the measure need not be on the card),
    and `quickTableCalcSql(calc, baseSql, addressing, secondaryAddressing?)` builds the SQL for quick table calcs
    on measure pills. Secondary calcs over a running sum: PctTotal is `(<running>) / NULLIF(SUM(base) OVER (<partition>), 0)`
    (Tableau divides by the TOTAL of the measure; for COUNTD and other non-additive bases the info notes the total is the sum
    of the marks), Difference (Relative, same addressing) is the base after the first mark; others need a window over a
    window and are not converted. cards.js names them as Tableau's caption (`% of Total Running Sum of Distinct count of X`)
    and adds the dimension ASC after the card's computed sort so ties order as in the window. A frame is only emitted with an ORDER BY (Domo rejects `OVER (ROWS ...)`). Without one,
    RUNNING_* and a sliding WINDOW_* frame are errors (`calc.table-calc-order`); FIRST()..LAST() drops the frame.
    A table calc inside another one is `calc.table-calc-nested` (Domo cannot nest windows, inline or through a
    saved beast mode reference) unless materialize computes the inner one (`ctx.tableCalcColumn(node)` then reads it
    as `MAX(<column>)`).
  - `ctx.resolveField(id) → { kind: 'column', column, datatype, domoType?, rawBoolean? } | { kind: 'calc', field } | { kind: 'parameter', parameter } | undefined`
  - `ctx.options`: `ConvertOptions`; `ctx.contextFilterColumns` for FIXED `FILTER ALLOW`
- `translateRowExpression(formula, ctx)`: row-level dialect for Magic ETL formula tiles
- `translateEtl(formulaOrAst, ctx, { aggregate })`: Magic ETL SQL for a formula tile or (`aggregate`) a Group By
  field expression (no FIXED clause, nested aggregates are errors, VAR/STDEV use the Magic SQL names). Trig
  functions (`catalog.js` ETL_ONLY_FUNCTIONS) are allowed here only. `ctx.lodColumn(node)` (both dialects) reads an
  LOD node that Magic ETL computes as a column. Functions whose Beast Mode SQL Magic ETL rejects get an ETL spelling
  (`ETL_FUNCTIONS` in emit.js): MAKEDATETIME is `ADDTIME(TIMESTAMP(DATE(d)), TIME(t))` (Magic TIMESTAMP takes one argument).

`schema.js`: `tableauToDomoType(datatype)`, `hyperToDomoType(type)`, `inferCsvType(values)`

`blends.js`: `planBlends(ir, { datasets, dataflows }, { options, workbookKey }) → { ir, datasets, dataflows, issues }` (data blends as joins)
- Runs after planDatasets. A worksheet with several `datasourceIds` blends its secondaries into the primary (the first id).
  Link candidates (`linkCandidates`): the custom relationship's field pairs (differently named fields), else dimensions with
  the same name. Active links (`activeLinks`): candidates whose primary field is a dimension on the shelves or marks (at that
  pill's date part), plus `linkOverrides.include`, minus `exclude`.
- A secondary used only through filters on candidate fields needs no join: the pills and filters move onto the linked
  primary field (`blend.filter-mapped`), and the worksheet stays on the primary. Dashboard filter zones on a related
  datasource map the same way. A filter on another secondary field that keeps every value and has no control is dropped.
- Otherwise the worksheet moves onto a blend datasource `blend.<hash>` (primary fields plus one column per secondary value
  the worksheets use) whose dataset `<wb>.blend-<primary>-<hash>` is the output of a Magic ETL dataflow: LoadFromVault of the
  primary's and each secondary's card-target dataset; per secondary a GroupBy on the link keys (ExpressionEvaluator
  `_t2d_link_N` helpers for date parts, calc links and type mismatches cast to text) with one aggregate per secondary value:
  measures with their pill aggregation, aggregated calcs as their formula, dimensions as ATTR
  (`CASE WHEN MIN(x) = MAX(x) THEN MIN(x) ELSE '*' END`; null instead of '*' for non-text); then MergeJoin LEFT OUTER onto
  the primary (CROSS with no active link, `blend.no-links`). Worksheets with the same primary, secondaries, links, mode and
  folded filters share one blend datasource and dataflow. Secondary measure pills become `max:` pills on the column.
- Mode `once` (an active link not in the view, `blend.link-not-in-view`): Tableau aggregates per link value and then again
  per mark, so a WindowAction ROW_NUMBER per link value and primary view dimension (the worksheet's marks, part of the
  shared-dataflow signature) keeps each per-link measure on one row (`CASE WHEN row = 1`) and the card re-aggregates it
  (SUM for sums and counts, AVG, MIN, MAX, MEDIAN; aggregated calcs read MAX). Verified live.
- LoadFromVault tiles (blend, `.etl` and join dataflows) set `executeFlowWhenUpdated` when the input is refreshed after
  push (connector or existing, `refreshesOnUpdate` in etl.js). A secondary value using TODAY()/NOW() is `blend.today`.
- Primary calcs that reference a secondary (`[ds].[Field]`) are copied into the blend datasource with each aggregation over
  one secondary's fields rewritten to read its per-link column (`rewriteSecondaryRefs`: `SUM([S].[x])` becomes `MAX([col])`, or
  the re-aggregation in mode `once`); on the primary those calcs are dropped unless a worksheet left there uses them
  (`blend.calc-moved`). Only the primary calcs the blend worksheets reach are copied.
- With secondary values in the view, a fixed filter on a secondary dimension (no quick filter control) restricts the rows
  each aggregate reads (`wrapAggregates`: `SUM(IF p THEN x END)`, `blend.secondary-filter-folded`); other secondary filters
  filter the card by the per-link value (`blend.secondary-filter`). Secondary datasource filters are not applied
  (`blend.secondary-datasource-filters`). A secondary value Magic ETL cannot aggregate (FIXED LOD, table calc) is
  `blend.field-skipped`; a link it cannot compute is dropped (`blend.link-unsupported`).
- Verified live: link in view, link not in view (once per link), a fixed secondary filter
  and a date-part link matched the Tableau blend values computed by hand, and the rewritten primary calc validated.

`datasets.js`: `planDatasets(ir, manifests, { mappings, options, workbookKey }) → { datasets, dataflows, issues }`
- One card-target dataset per Tableau datasource, plus per-table input datasets and a Magic ETL
  join dataflow (or a fusion view) when the data arrived as several tables.
- Cloud Amplifier manifests plan one `cloud-amplifier` dataset per registered table (columns are the warehouse
  names, so `fieldMap` maps Tableau field ids to them) and an Advanced SQL DataSet View (`buildSqlView`,
  `view.schema.viewTemplate.version: 'advancedEditorSql'`, `tableAliases` as $refs, `cloudId` = integration id)
  per custom SQL relation; several relations join like uploaded tables. The custom SQL goes through the rewrites in
  `src/convert/view-sql.js`, each answering a rule of Domo's view validator or Snowflake deparser listed in
  [VIEW-SQL-RULES.md](VIEW-SQL-RULES.md); a function with no supported equivalent is `data.view-sql-unsupported-function`.
- Federated manifests plan one `federated` dataset per table (`planFederatedInputs`; columns keep the database names)
  and, for several tables, always a fusion DataSet View (`sourceStrategy: 'federated'`); a join the view cannot express
  is `data.federated-join` (error, only the first table is used), never a Magic ETL DataFlow. Each adds the info issue
  `data.federated-beast-modes`. `materializeCalcs` skips datasources whose card target is federated (`isFederatedDataset`)
  and reports the calcs it would have moved to Magic ETL as `data.federated-etl`; convert also flags any DataFlow that
  reads a federated DataSet (`data.federated-etl`, error).
- Connector manifests whose connection runs Initial SQL plan streams and Magic ETL through `planInitialSqlInputs` (see
  `initial-sql.js` below).
- Fills `DatasetPlan.fieldMap` (Tableau field id → Domo column) for every non-calculated field.

`initial-sql.js`: Tableau Initial SQL (`one-time-sql`) on the connector strategy.
- `tokenize`, `splitStatements(sql)` (T-SQL needs no semicolons: a statement keyword at depth 0 starts a statement unless
  it continues one, e.g. SELECT after UNION or INSERT, SET in UPDATE; CASE ... END and parentheses never split; GO and `;`
  split), `parseInitialSql(sql) → { statements, items }` (kinds `define` (SELECT INTO, CREATE TEMP TABLE AS),
  `create`, `insert` (SELECT or VALUES), `update`, `delete`, `drop`, `truncate`, `variable`, `session`, `use`, `select`,
  `dead` (IF with a constant condition), `blocked` with a reason; an `IF OBJECT_ID(...)` guard before a temp DROP folds in).
- `planInitialSql({ sql, tables, dialect, engine }) → InitialSqlPlan` runs the statements in order with a temp table map
  (each row source keeps a snapshot of the temps it may read, so a later DROP or UPDATE does not change it) and
  substitutes variables (a variable set from a query becomes a scalar subquery). For each datasource table that reads a
  temp table: `SELECT * FROM #t` maps to the temp's own stream (`{ kind: 'stream' }`); anything else is a graph
  (`{ kind: 'etl', graph }`). `queryGraph` splits UNION branches; `blockGraph` keeps every database table, its joins and
  the WHERE conjuncts that read only them in one stream (helper columns `_t2d_<alias>_<col>` for join keys and
  translated expressions), loads each temp through a Select Columns tile with working names, joins in FROM order
  (INNER or LEFT on column equalities; an ON conjunct over the temp alone filters it first; a leading temp table attaches
  the database stream with its ON), then Filter (WHERE over temps), formulas, Group By (GROUP BY, HAVING through hidden
  aggregates), final names (Alter Columns) and Remove Duplicates (DISTINCT). UPDATE becomes a formula, a drop and a rename
  per statement; DELETE a Filter. `toFormula` translates T-SQL expressions (ISNULL, IIF, GETDATE, LEN, DATEADD,
  DATEDIFF(day), DATEPART, CAST/CONVERT without style, string `+` as CONCAT, LIKE as ILIKE for SQL Server); anything
  else throws, and `plan.blocked = { statement?, text, where, reason }`. Unused streams are dropped.
- `planDatasourceInitialSql(ds)` plans every connection with Initial SQL and its tables; `describeInitialSql(plan)`
  (one line per statement) and `initialSqlBlockedMessage(blocked)` feed the issues.
- `initial-sql-etl.js`: `buildInitialSqlDataflow({ name, outputName, description, graph, streamKeys })`: LoadFromVault
  per stream (once, `executeFlowWhenUpdated`), SelectValues, MergeJoin, Filter, ExpressionEvaluator, GroupBy, Metadata,
  Unique, UnionAll (by name), PublishToVault.
- datasets.js `planInitialSqlInputs`: a connector dataset per stream (`<ds>.sql-<stream>` unless it is a table's own
  dataset, `planConnector(..., { session })` for USE), a `dataflow-output` dataset (`sourceStrategy: 'connector'`) per ETL
  table from DataFlow `<dataset>.initial-sql`, pushed before the datasource's join DataFlow; issues `data.initial-sql`
  (streams, DataFlows, one line per statement), `data.initial-sql-note`, and on a block `data.initial-sql-untranslatable`
  with a schema-only DataSet.

`etl.js`: `buildJoinDataflow(...)`, `buildFusionView(...)`. A join key that applies `DATE()` (a relationship such as
`DATE([Created Date]) = [CALENDAR_DATE]`; `ColumnRef.transform`) is computed into a `_t2d_join_key_N` column by an
ExpressionEvaluator before the join and dropped before the output (a DataSet View cannot, so it falls back to the
dataflow); another function joins on the bare column with `data.join-key-expression`. `connectors.js`: `planConnector(datasource, connection, mappings, { table }) → { connector, issues }`
- Default provider per Tableau class (read from the instance's providers and connector descriptors): snowflake
  `snowflakekeypairauthentication`, sqlserver `ms-sql-server`, postgres `postgresql`, mysql `mysql`, redshift
  `amazon-redshift`, bigquery `google-bigquery-service`, oracle `OracleDB`, databricks `databricks-pat`;
  salesforce is object based (error `data.connector-manual`). `mappings.accounts[].providerKey` overrides.
  `connector.configuration` holds the full METADATA set for custom-query mode; `connector.defaultTransport`
  `{ providerKey, connectorId, connectorVersion }` is the built-in transport fallback.
- Plan keys are workbook-scoped because push state is shared by every workbook on an instance:
  datasets `<wb>.<ds>[.<table>]`, beast modes `<datasetKey>.<field>`, variables `param.<name>.<type>` (site-wide:
  `siteVariables`, `previousKey` is the old `<wb>.param.<name>`; names of one workbook with the same slug get a name hash
  in the key, a repeated name gets " (2)"; `<type>` is the parameter's own type even when the variable is STRING, below),
  cards `<wb>.<worksheet>`, pages `<wb>` and `<wb>--<dashboard>`, filter cards `filter-<datasetKey>-...`.
- Exception: a manifest with `shared` (a site-scoped published datasource) plans its datasets and dataflows under
  `sharedDatasetKey(luid)` = `pds-<luid>[.<table>]`, named after the published datasource, with
  `DatasetPlan.shared = { luid, name }` and `previousKey` (the workbook-scoped key, adopted by push). Filter cards
  on such a dataset are `filter-<wb>-<datasetKey>-...`.

`beastmodes.js`: `planBeastModes(ir, datasets, { options, workbookKey, shared, lodColumns }) → { beastModes, variables, bindings: FieldBindings, issues }`
- `lodColumns`: datasource id → `ctx.lodColumn` lookup of inline LODs materialized by `materialize.js`;
  `tableCalcColumns`: datasource id → `(fieldId, node)` lookup of inner table calcs it materialized (`ctx.tableCalcColumn`).
- A calc with table calcs gets `ctx.tableCalc` from the worksheet pills that show it (`tableCalcAddressing`, dimension
  pills through `filters.js` `pillWindowItem`); worksheets that address it differently get `calc.table-calc-addressing`.
- `calcFormula(field, { lookupField, findParameter })`, `fieldLookup(ds)`, `parameterLookup(parameters)` are shared with materialize.
- Table-calc addressing: compute-using fields written `[ds].[Customer]` match the `[ds].[none:Customer:nk]` pills; a calc
  shown only through another calc takes that pill's nested compute-using; a calc pill without a table-calc setting gets
  Tableau's default (Table across); parameter pills never enter PARTITION BY or ORDER BY. LOOKUP offsets and window
  bounds fold constant expressions and inlined parameters. A LOOKUP offset that is an IF, CASE or IIF (directly or through
  a calc) whose results are all integer constants, under conditions without row-level columns, becomes a CASE over the
  LAG/LEAD at each offset (no ELSE gives NULL, as a null Tableau offset is assumed to), so a parameter in the condition
  stays a variable. A table calc no worksheet uses is `calc.table-calc-unused`
  (info); its missing-order error becomes a warning and the Beast Mode is not created.
- A `calc.unknown-field` in a calc no worksheet, filter or dashboard zone reaches is a warning (the Beast Mode is not
  created): such calcs are usually copied from another datasource and broken in Tableau too.
- Only used calcs get a Beast Mode: once the plan is assembled, `convertWorkbook` drops every translated beast mode that
  `usedBeastModes(plan)` (select.js) does not reach, each with a `calc.unused` info issue. Reached means referenced by
  legacyId or backticked name from a card on its dataset (the whole card: body, summary number, drill path, quick filter
  defaults), a page or app, a dataflow, a dataset view or a variable, or from another kept beast mode of the same dataset.
  Unsupported beast modes stay (push never creates them; the report lists them to rebuild). The convert option
  `allBeastModes` (`--all-beast-modes` on convert and migrate, recorded in `plan.options`) keeps them all. On a shared
  dataset each workbook plans and registers (`beastmodes.json`) only the calcs it uses.
- `calc.count-joined` reads `DatasetPlan.sourceStrategy` for a dataflow output over one dataset's rows (Magic ETL calcs,
  blends), so a `.etl` over an uploaded single table does not warn.

`materialize.js`: `materializeCalcs(ir, { datasets, dataflows }, { options, workbookKey, shared }) → { ir, datasets, dataflows, calcs, issues }`
- Runs `planBeastModes`, then (unless `options.materialize === false`) moves calcs Beast Mode cannot express into
  Magic ETL and plans beast modes again, in rounds until nothing new is needed:
  - `calc.lod-dimension`: every LOD the calc reaches (through calc references, and the LODs inside those) becomes a
    column: GroupBy on the FIXED dimensions with the body as one aggregate expression, MergeJoin LEFT OUTER back on
    the dimensions (CROSS for no dimensions). Calculated dimensions become `_t2d_key_N` formula columns, dropped by a
    Metadata tile before the output. INCLUDE/EXCLUDE are not materialized (`calc.materialize-skipped`).
  - `calc.lod-nested-wrapped`: only the LODs inside the outer LOD become columns; the outer one stays a FIXED beast
    mode unless a later round finds it used as a dimension.
  - `calc.no-equivalent`: a row-level calc using a Magic-only function becomes an ExpressionEvaluator column.
  - `calc.table-calc-nested`: the inner table calc (one whose own value holds no table calc) becomes a column at the
    grain of the first worksheet showing the calc (the view dimensions `tableCalcAddressing` returns, date parts as
    `_t2d_key_N` formula columns): GroupBy on the grain with the inner value, a WindowAction (Rank & Window) with the
    addressing's partition and order (a rank orders by the value; an inner calc reached through a calc reference uses
    that calc's own nested compute-using, `tableCalc.nested[fieldId]`, when the pill has one), MergeJoin back to the
    rows. LODs inside the inner value are materialized first. Inner calcs at the
    same grain share one GroupBy (one value column per distinct inner value) and one MergeJoin, with one chained
    WindowAction per distinct partition and order (several additions each). A calc is one Beast Mode, so it reads the
    column of one grain; the calc and an inner calc reached through a calc reference share it when their partition and
    order match. Supported inner calcs:
    RUNNING_SUM/AVG/COUNT, RANK/RANK_DENSE/RANK_UNIQUE, INDEX, LOOKUP with a literal offset, and WINDOW_SUM/AVG/COUNT
    with a frame that does not end at LAST(); others are `calc.materialize-skipped`. Only when every view dimension,
    the partition and the order are known (no addressing warning); otherwise the error stays. `calc.table-calc-grain`
    names the grain, and again per worksheet that shows the calc with other dimensions or with its own filters.
  - Size: calc references are inlined, so a helper reused through several paths (a diamond) repeats in every beast
    mode above it. When a datasource has beast modes over `LARGE_EXPRESSION_BYTES`, `sharedRowCalcs` (`inline-size.js`)
    estimates the inlined size of every calc they reach (one translation per calc, references read as placeholder
    columns, so the expansion is never built) and picks row-level calcs bottom-up: used twice or more by the calcs
    above and at least `MIN_SHARED_CHARS` (1024), or alone over the large size. Only calcs whose whole closure is
    row-level (no aggregate, LOD, table calc, user function or TODAY()/NOW(); no parameter in `variables` mode) qualify; aggregate
    calcs stay beast modes and read the columns. Each becomes a `formula:` unit (a formula column, like
    `calc.no-equivalent`); units that read no column of the open formula tile share it. A unit Magic ETL rejects is
    skipped and the next round picks around it. Issue `calc.materialized-size` per datasource.
  - Every ExpressionEvaluator and GroupBy tile it writes has `settings: { zoneId: 'UTC' }`: Magic ETL formulas
    otherwise use the instance time zone (`domo.globalization.defaultTimeZone`), so `TIMESTAMP('1899-12-30')` +
    7 hours read 14:00 where the Beast Mode reads 07:00.
- A calc whose whole formula is materialized becomes a `kind: 'column'` field in the returned IR (and `fieldMap`);
  an LOD inside another formula is a `<calc> (LOD)` column read through `lodColumns`.
- Tiles go before the PublishToVault of the datasource's own join dataflow; any other card target (upload, Cloud
  Amplifier, existing, connector, view, or a shared published datasource dataset) gets a new dataflow
  `<key>.etl` (`<wb>.<ds>.etl` for shared ones, which stay shared) reading it, whose `dataflow-output` dataset becomes
  the card target. A blend datasource over a primary whose own dataflow computes a calc reads that column (`preset` in
  buildTiles) instead of computing it again. Issues: `calc.materialized` per column, `calc.materialized-dataflow`, `calc.materialized-parameter`
  (parameters frozen at their current value), `calc.materialized-today` (TODAY()/NOW() hold the last run), `calc.materialized-filters` (datasource/context filters are not applied
  before the Group By), `calc.materialized-null-keys` (null FIXED or inner table calc view dimensions do not join).
- On a shared dataset, legacyIds are `beastModeLegacyId('site', datasetKey, fieldId)` and each beast mode carries
  `sharedHash` (`beastModeDefinitionHash` of the translation). `shared = { workbook, registry }` lists the variants
  other workbooks planned (`registry[datasetKey]`): the same hash with the same field id or name reuses that
  variant's key, legacyId and name; a different definition of an unrenamed variant's name or field id gets
  `<name> (<workbook name>)`, a hash-suffixed key and legacyId, `sharedRenamed`, and a `calc.shared-conflict` warning.
- `updateSharedRegistry(variants, workbook, beastModes) → variants` (pure) rewrites one dataset's registry after a conversion.

`drill.js`: card drill paths from Tableau hierarchies (`DatasourceIR.hierarchies`, from `<drill-paths>`, IR version 14)
and from Tableau's implicit date drill. `planCards` calls `planDrillPath(ws, ir, card, { slots, family, bindings, planView })`
after each card.
- What drills, and from which dimension (`dimensionSlots`): bar, line, area, combo, pie and treemap charts from the axis
  (ITEM), else the series; filled maps from their region (ITEM); basic tables and Mega Tables from any column; pivots from
  a column header only. A Domo pivot click filters by the clicked cell's column header and never by its row (a row
  header click gives the filter "<column> in <column>"; VERIFIED LIVE with throwaway
  cards), so a hierarchy on a pivot's rows gets `card.drill-chart` (info). A basic table click filters by the clicked
  cell's own column, so a viewer drills by clicking a cell of the hierarchy column. Other chart families (scatter,
  heatmap, gantt, KPI, histogram) and split cards do not drill (`card.drill-chart`).
- Hierarchy: when Tableau shows several levels expanded, the card keeps them and the drill starts below the deepest one
  shown (`drillSource`); a deepest level a click cannot reach gets no drill (`card.drill-unmapped`, info).
- Date drill (`dateDrillSource`, charts only, when no hierarchy drills): an axis or series date pill coarser than Day
  drills Year > Quarter > Month > Day from where it starts; week pills drill to Day; day, exact date, weekday and finer
  pills get none. Truncations and a discrete Year drill by Domo date grain (calendar columns with `dateGrain`; on a
  calculated date, the card's date formulas); discrete Quarter or Month parts drill by the next part. `card.drill-date`.
- One `DrillViewPlan` per deeper level (`grain` set for a date level): the worksheet with the drill pill swapped
  (`swapPill`: filters keep the old pill, a manual sort or member colors of it are dropped), planned by `planCard`, so the
  chart is normally the card's own; a map level with no Domo map (City under County) becomes what planCard picks for it, a
  table. The view has no filters of its own: Domo applies the card's filters to its drill views (VERIFIED
  LIVE, a drill view without filters returns the card's totals), while a copy
  planned from the swapped sheet can differ (a quick filter of the card becomes a fixed filter) and empty the view. It
  keeps its card formulas and drops quick filters, the Top N row limit and the date range (Domo clears a drill view's
  date range on update). Push adds the card's saved card formulas to each drill view it writes (`withParentFormulas`): a
  click on a card formula (a date part) filters the view by the id Domo saved on the card, and the view needs that
  formula or it shows no rows. Title `<card title>: <level caption>` (date levels
  `<field> (Quarter)`).
- A level with no Domo column, or whose view does not convert, ends the path there (`card.drill-unmapped`, warning).
  A drill path gets `card.drill-path` (info).
- `applyDrillInteractions(pages, cards, ir)` (convert/index.js, after planPages): a layout CARD item of a card with a drill
  path and no interaction gets `{ type: 'DRILL', config: { openInNewWindow: false } }`, so the viewer drills in place (the
  default interaction cross-filters the other cards instead; VERIFIED LIVE). A card whose sheet is the source of a filter or
  highlight action on that dashboard, or whose item has another interaction, keeps it, and its drill path opens from the card
  details (`card.drill-action`, info).
- `allowTableDrill` is false on table-type charts (`isTableChart`: any chart type containing `table`), on filter cards
  (layout.js), and on every card with a drill path and its drill views; true elsewhere. A user's Domo automation may turn it
  off later on cards they own, so `false` on a pushed card is not a t2d bug.

`cards.js`: `planCards(ir, bindings, { options, workbookKey }) → { cards, issues }`
- A blended worksheet is on its blend datasource (blends.js); one blends.js could not convert uses its primary datasource
  (`worksheet.datasourceIds[0]`, ordered by shelf usage) and gets `card.blend`.
- Sheets with no fields (`fieldlessSheetIssue`): title-only (`card.title-only`, info), empty (`card.empty-sheet`, info),
  shape-only buttons and logos (`card.ui-sheet`) and parameter labels (`card.parameter-label`) get an unsupported
  placeholder card when they have a dataset; push skips it.
- Datasource-level filters are applied to every card on that datasource.
- A pill whose binding has `lodExpression` and an aggregation other than sum/user/none (avg, min, max,
  countd, ...) gets a card formula `<AGG>(<lodExpression>)` instead of the dataset Beast Mode.
- A column whose binding is a plain column (`kind: 'column'`, no calendar grain or card formula) gets
  `alias: <Tableau name>` when that name differs from the column: a renamed column, or a calc that only renames one
  (beastmodes.js binds a calc whose translation is a bare, unaggregated column reference to the column with
  `alias` and plans no beast mode; other calcs inline it, so nothing references the missing beast mode). The alias is
  only on the card column, never in groupBy, orderBy, filters or quick filters; the server derives
  `metadata.columnAliases` from it.
- `chart-types.js`: `inferChart(worksheet, ir, bindings) → { chartType, mappings, warnings }`
  - Bars, lines and areas: the dimension on the shelf opposite the measure is ITEM. A dimension on the measure's
    shelf (Tableau panes, small multiples) is the SERIES when it is also on Color, or when it is the only one and no
    other series exists; otherwise it is nested into the axis (`chart.small-multiples` either way). When that series
    dimension competes with several measures for the SERIES slot (a bar + line dual axis, or several measures), the
    card is split instead (`ChartInference.split`, `CardPlan.split`, `split.js`): one card per member, the same body
    with each value column an aggregated card formula that counts only the member's rows (`split.measures`, `SPLIT_MEMBER`
    standing for `(<dimension> = '<member>')`; `conditionAggregates` puts the condition inside every aggregate of a calc),
    so every member card keeps all the categories, as Tableau's panes share one axis (a member with no rows in a period keeps
    the empty slot); when a measure cannot take it (a window, a table calc, another Beast Mode inside) a member filter instead.
    Title `<title>: <member>` (the suffix a TEXT item after the title's smart text items), the member's Tableau color on the bars of the pane it colors, and the layout item stacked into
    N items with the height divided (rounded up, at least `MIN_SPLIT_HEIGHT` 14 standard / 6 compact rows: below a 105px plot
    Phoenix drops axes, labels and legend, checked in the viewer); later items move
    down by the excess and items beside that end on its bottom grow by it, so the template stays tiled.
    Members come from an include filter at convert, else at push from a render preview of the card's own body grouped
    by the dimension (`previewMembers`, so beast modes and every card filter apply); a member card's state entry
    records `extra.splitOf` so a layouts-only push stacks the same cards. More than `MAX_SPLIT_CARDS` (6) or no member
    keeps one card (`chart.small-multiples` / `push.card-split` warning); one member keeps the card and its title.
    Phoenix's trellis facets along the category axis only, so it cannot draw Tableau's stacked row panes; member cards
    scale their value axes separately (info). A color dimension takes the SERIES from a nested second category level
    whose headers are hidden or that keeps one member; that level stays in groupBy and the sorts (`sortOnly`). When two
    or more visible levels remain, a bar chart combines them into one ITEM (`combinedCategory`, `SlotMapping.derived`
    `{ type: 'concat', pillIds }`, `chart.combined-category`): Tableau stacks a color that is on no level within each cell of
    the level tuple, so that color is the SERIES and the chart a stacked bar; three or more levels without such a color keep the colored, else innermost, level as a multibar SERIES,
    and a pane series from the value shelf keeps the SERIES beside the combined levels. One-member levels sort only (with
    two visible levels left they nest as before, without the drop); a date level, or a filter or highlight action from
    the sheet on a level (the click could not pass the level's own value), keeps the nesting (`chart.combined-category`
    warning). The ITEM is a card formula
    `<A> + <B>` = `CONCAT(COALESCE(a, ''), ' ', COALESCE(b, ''))` (`COMBINED_SEPARATOR`, the user's own reference card;
    COALESCE of a number and '' renders on a preview); every level's pill resolves to it for sorts, the outermost sorted
    level's sort wins (`card.sort-order` for the others), and tooltips name the outer level `%_CATEGORY_NAME`. A part
    without a row-level expression is left off it (`chart.combined-category` warning). A quick table calc that addresses
    a level partitions by the level's own column, so the card also groups by the level columns (same grain). A 100% chart
    (`badge_*_100pct`) needs the percent of total to run along the series and not the category (`percentScope`, from
    `tableCalcAddressing`, any combined level counting as the category); along the category it is a stacked bar whose
    VALUE is the percent as a window formula. A bar stack of a plain measure is a 100% chart too when the sheet formats
    that measure as a percent and labels the marks with its percent of total along the series (`percentLabelStack`): the author reads
    the bars as shares. The VALUE is the plain measure, Domo computes the shares, and the labels are `%_PERCENT_OF_CATEGORY`.
  - A bar + line dual axis on one measure (a total on one mark, the split by a color dimension on the other) colored on
    one pane only (`singlePaneColorFamily`: the pane's `encodings.color` holds the series pill, the other axis pane has no
    color, the shared untagged pane none either) keeps the colored pane: a line colored, a `badge_two_trendline` by the
    color; a bar colored, the bar the `bar` family picks (stacked). Domo line+bar draws every series member but the last as
    bars, on a second axis, so the total is dropped (`chart.dual-axis` warning). Both panes colored stays `badge_line_bar`.
  - EXTRAINFO1..3 hold measures the card does not already show (compared by field, aggregation and table calc,
    `measureKey`; a 100% chart's VALUE is the measure without its percent). With a Tableau `<customized-tooltip>`
    (`PaneIR.tooltip`) only the measures it names count, because Phoenix shows an EXTRAINFO column only through a
    `%_TOOLTIPn` hover macro.
- `colors.js` `cardColorRules(ws, { family, slots, dataSourceId })` (both targets): Tableau colors as card color rules in
  `definition.conditionalFormats.card`, the Analyzer's shape `{ condition: { column, values, operand: 'IN', dataSourceId }, format:
  { color, textColor: null, textStyle: 'PLAIN', applyToRow: false } }` (Phoenix matches the raw series or category value; empty
  `values` colors the whole column). A dimension's member map: one rule per color, most members first, at most `MAX_COLOR_RULES`
  100 (`card.colors-limit`); null members (`card.colors-null`), tuple maps (`-tuples`) and a cut map (`-truncated`) are reported.
  Measure Names: one rule per measure column in card order (measures sharing a column get the first one's color,
  `card.colors-same-column`); a fixed mark color with no color pill: one per value column. No rules for gradients
  (`card.color-gradient`), table, crosstab, map, heat map and single-value families (`card.colors-chart` when a map exists), a color
  pill off the card (`card.colors-dropped`) or a date part (`card.colors-date`). Push drops a rule on a dropped beast mode
  (`stripFormulaRefs`). `workbookPalette(ir)` → `AppPlan.theme.palette` `{ name, colors }`: the most used palette of categorical
  color pills on dashboard sheets, from `<preferences>`, `TABLEAU_PALETTES` (Tableau 10 for the default) or the colors its member maps
  use (`layout.theme-palette`); `paletteJson(colors)`: the theme palette string (a 9-shade color range per color with the color
  at column 4, one rule cycling `[row, 4]` to 36 cells, `lineColors` and `latLongMapColors` alike, a 9-cell gradient per row; one
  shade per row made Phoenix fail every chart in the app, verified live).
- `chart-options.js`: chart property overrides, written only for chart types whose Phoenix option list
  has the property, since Domo drops the others.
  - `markTextOverrides`: `hover_text` from the custom tooltip with field tokens as macros (`slotMacro`: ITEM
    `%_CATEGORY_NAME`, SERIES `%_SERIES_NAME`, VALUE `%_VALUE`, a percent of total along the series
    `%_PERCENT_OF_CATEGORY`, over every mark `%_PERCENT_OF_TOTAL`, EXTRAINFOn `%_TOOLTIPn`; parameters show their current
    value, `<Sheet Name>` the sheet name). Tokens with no macro (dimensions off the card, viz in tooltip, `<Page Name>`)
    drop their line (`chart.mark-text`, info); a translation that keeps no value macro is not written. Without a
    custom tooltip but with EXTRAINFO columns: Phoenix's default hover for the chart type plus `<name>: %_TOOLTIPn`
    lines. `datalabel_text` when a pane shows mark labels (`mark-labels-show`): the customized label, else the Text and
    Label shelf fields, else the measure the pane plots (its dual-axis `yAxisPill`/`xAxisPill`, else the one measure on
    Rows and Columns, so a percent-of-total axis labels `%_PERCENT_OF_*`), else `%_VALUE`. A non-empty `datalabel_text`
    turns Phoenix's labels on.
  - Label position and color (bar types without a line, the Phoenix option lists): the pane's label alignment along the bar
    (`PaneIR.labelAlign`, vertical on a column chart, horizontal on a bar chart) center gives `datalabel_position` Center,
    the base end (bottom, left) Inside Bottom / Inside Left, the far end Inside Top / Inside Right on a stack only (on a lone
    bar it may be outside); Automatic on a stack with a SERIES is Center, as Tableau centers segment labels. An inside label
    with automatic color (`PaneIR.labelColor`) is `datalabel_fnt_clr` Complimentary (Tableau contrasts it with the mark); a
    user color near white, black or gray is White, Black or Gray; match and hues keep Default.
  - Value axis range (`axisRangeOverrides`): a Tableau axis fixed by hand (`WorksheetIR.axes`, the axis style-rule `space`
    encoding with `range-type` `fixed`, or `fixedmin` / `fixedmax` for Fixed start / end, one bound) on the plotted
    measure sets `value_scale_min` / `value_scale_max` (bars, lines and areas whose Phoenix option list has them; not 100%
    charts, combos or scatters), info `chart.axis-range`. Nothing else
    pins the range: the sign of the data is unknown at convert time.
    Number formats in `hover_format` are not mapped; the column format (below) applies to labels and hover values.
  - `legendPlacements(ir)` / `legendOverrides`: a color legend zone (no param, Measure Names, or a Color field) whose
    center is above or in the top quarter of its worksheet zone is `lrg_legend_position` and `details_legend_position`
    Top; in the bottom quarter or below, both Bottom; right of it (or in its right quarter), `details_legend_position`
    Right. Only on cards with a SERIES. The first dashboard that places one wins; others placing it differently get
    `chart.legend` (info). A sheet on a dashboard with no color legend for it gets both positions `Hide` (Phoenix draws a
    legend for two or more series by default); a legend zone Domo cannot place leaves the default, and a sheet on no
    dashboard keeps it.
  - Stack totals: a vertical or horizontal stacked bar whose one labeled pane has no color while a colored pane has labels off
    (Tableau's dual axis "stack total" trick) gets `datalabel_show_total: "true"` and no `datalabel_text`, with
    `datalabel_total_style: "Medium"` when the labels are bold (`PaneIR.boldLabels`).
  - Stack sort (`stackSortOverrides`): a stacked or 100% bar whose series has a computed sort by the plotted measure gets
    `category_sort_method` ("Sort Each Category", in the Phoenix option lists of `badge_{vert,horiz}_{stackedbar,100pct}`),
    which orders each bar's segments by value. Descending puts the largest at the base; Tableau stacks a vertical bar's first series on top and a horizontal bar's at the base, so an
    ascending Tableau sort is Descending on columns and Ascending on bars (`chart.stack-sort`, info: Tableau orders by the
    series total over the chart, Domo per bar). Such a card sorts only its category axis: a series total-order or
    natural-order key as well (`sortEntries` `stackSorted`) left the app view right but drew every bar as one column per
    series in Analyzer.
  - Percent labels: a `%_PERCENT_OF_*` data label takes `percent_decimal_places` (None, .0, ...) from the Tableau number format
    of the labeled pill (`p0%` is None). A column that holds the base of a table calc Domo draws itself (a 100% chart) or could
    not convert gets no number format (it is the count, not the percent).
  - Series names: a measure column on a sheet that uses Measure Names takes its Measure Names alias (`<aliases>` on the
    datasource's `[:Measure Names]`) as the column `alias`, the name Domo shows in legends and hover.
- `filters.js`: `toCardFilters(...)`, `toQuickFilterControls(...)`, `exceedsSlicerLimit(filter)` (more than 50
  selected values: the control starts unfiltered because card create rejects larger slicers, and cards.js keeps the
  selection as a fixed card filter; warning `filter.slicer-limit`)
  - A categorical quick filter in Tableau's wildcard (`pattern`) mode is a `match_values_text_input` slicer with `CONTAINS` and no
    value; with a selection, or in `typein` mode, it is a `multiple_select` list. Card create rejects a text input slicer without a
    match operator or with more than one value (a bare 400 "invalid slicers").
  - Aggregate filters (`isAggregateFilter`: a range on an aggregated pill, or any filter on an aggregated calc) run
    as HAVING on the card's grouping. Domo sends a filter to HAVING when it carries
    `aggregation` (the pill's SUM/AVG/COUNT/MIN/MAX/MEDIAN/STDDEV..., ATTR as MAX) or names an aggregated beast mode
    (dataset, or card for COUNTD, VAR and an LOD with another outer aggregation). Cards without a
    groupBy filter their single total row. Shown as a quick filter, an aggregate filter has no control and stays a
    fixed card filter. A Rank quick table calc kept to ranks 1..N becomes a Top N (a Bottom N for `rank-options`
    Ascending) unless its compute-using leaves a partition; other table-calc filters are `filter.table-calc` (Domo
    filters before window functions). A Top N next to a HAVING filter warns `filter.top-order` (Tableau ranks first).
  - Top N: the ranking expression maps to an orderBy entry (COUNTD and VAR become a card formula, which reuses the VALUE
    column's formula when it is the same; a text field is never ranked by SUM, `filter.top` skips it). When the sheet has
    another dimension or another active non-context filter (`top-rank.js` `topRankReason`, shown and action-target filters
    included), `materialize.js` adds a rank unit instead: a null-safe key `_t2d_key_N` (COALESCE with a sentinel, so Null is a
    member), a Filter tile with the datasource and context filters (a shown context filter warns `filter.top-context`), a Group
    By on the key with the ranking aggregate, a WindowAction RANK (ASC for a bottom N) and a LEFT OUTER join back. Sheets with
    the same spec share the column. The IR copy convert returns carries `filter.top.rankColumn`, and `topFilter` makes it a card
    filter `rank <= N` with no limit (`filter.top-rank`). Without one the limit path warns `filter.top-order`.
  - Top N sets (`set.top`, by a field or formula, count a constant or parameter) get the same rank unit
    (`setRankUnit`, column `<set> (top rank)`): Tableau computes a set after datasource and context filters and before
    the sheet's other filters, so the Filter tile holds the datasource filters and the context filters every sheet using
    the set shares (`calc.set-top-context` when they differ). A shown context filter with one selected member partitions
    the rank instead (Group By, Rank & Window partition and join keys), so choosing one value there ranks as in Tableau
    (`calc.set-top-partition`). The set Beast Mode is `CASE WHEN <rank> <= N THEN 'In' ELSE 'Out' END`, N a variable for a
    parameter count (`calc.set-top-rank`: ranked per dataflow run, ties at N are all In). A ranking that reads one
    list parameter gets one Rank & Window tile and column per member (`switchedRanks`), and the Beast Mode
    picks the rank with `CASE <variable> WHEN <member> THEN <rank column> ...`, so no `calc.materialized-parameter`. A Beast Mode cannot do it: a
    window over FIXED gives the order rank, but a card or page filter on any FIXED beast mode fails (Domo puts the FIXED
    into WHERE, "Query failed"), and a plain window rank is filterable but ranks card rows (verified live).
  - Null members (`nullMemberFilter`): an exclude list with Null on text (or Null alone) is `NOT_IN` with `''` added, which
    drops null rows (and empty text, info `filter.null`); an include list with Null, an exclude list without Null (Tableau
    keeps nulls, a card NOT_IN drops them) or an exclude with Null and members on a non-text field is a card formula
    `<field> (selected members)` built by `memberCondition`, filtered IN 'true'. Set In/Out and aggregated bindings keep
    the plain list.
  - An ATTR categorical filter on a field the card does not group by (`ctx.viewDimensions`) is an aggregated card
    formula `CASE WHEN MIN(x) = MAX(x) AND MIN(x) IN (...) ...` filtered IN 'true' (HAVING; `filter.attr`); shown as a quick
    filter it keeps its row-level control with a `filter.attr` warning. Verified live.
  - Filter shape (`filterRef`): a column filter is `{ column, filterType: 'COLUMN_ID' }`; a filter on a dataset or card beast
    mode is `{ column: <formula id> }` with no `filterType`, `formulaId` or `cardURN`, as the editor saves it;
    the server stores it as `LEGACY` and remaps a card formula id to the saved one.
    `FORMULA_ID` and `CARD_FORMULA_ID` filters render, but the quick filter values endpoint cannot resolve them, so every quick
    filter of the card fails with `INVALID_FILTER / INVALID_COLUMN` (verified live).
  - A filter on a set's In/Out pill (`FieldBinding.setMembers`) compares `'In'` / `'Out'`, the values the set beast mode
    returns, where Tableau stores `true` / `false`. A set over all members (`level-members`, "Use all") is `'In'`.
  - A set filter that keeps the set's members (`bare` or `memberLevel`, `keepsSetMembers`) is a filter on the set's source:
    `<source> IN <members>` (narrowed to the source members the sheet selects) when the set has saved include members
    (`FieldBinding.set`, from `beastmodes.js`), none of them Null, and the source has a column on the card's dataset.
    Otherwise the set beast mode `IN ('In')`, plus the selected source members on the source (never
    `<set beast mode> IN (<source members>)`, which returned no rows). Info `filter.set-members`; such a filter shown on a dashboard stays a fixed card filter, with no In/Out control.
  - "Non-null values" / "Null values only" range filters (`included-values='non-null'|'null'`): the server reads `''` as
    IS [NOT] NULL (verified on date, datetime, numeric and string columns), so non-null
    is `NOT_IN ['']`, null-only on a date `IN ['']`, and null-only on other types a card formula `CASE WHEN x IS NULL ...`
    filtered IN `'true'`. On an aggregated pill both are skipped with `filter.null` (a row filter would change the other
    measures), except non-null on COUNT / COUNTD, which keeps every mark.
  - Categorical `ranges: [{ from, to }]` (groupfilter `function='range'`, a shift-selected run of members): Tableau keeps
    the values between the bounds by comparison (not by its natural list order: "2024 P1" to "2024 P7" also keeps
    "2024 P10", in both products), with the column's collation (`FieldIR.collation`, the metadata-record `<collation
    name>`). An ICU collation (`LEN_RUS_S2`, `LROOT`, ...) ignores case and Domo compares text by code point, so a text
    range is a card formula `CASE WHEN LOWER(<field>) BETWEEN '<from>' AND '<to>' ... THEN 'true' ELSE 'false' END`
    (bounds lower-cased) filtered IN `'true'` (`'false'` when excluded, which keeps nulls as Tableau's exclude does).
    A number or date range, and text on a `binary` collation (case-sensitive in
    Tableau, `FieldBinding.caseSensitive`; a calc without a collation takes the one its datasource's text columns share),
    alone is BETWEEN / NOT_BETWEEN; with members or several ranges, a card formula predicate. Without card formulas a text
    range keeps the BETWEEN with warning `filter.member-range`. Residuals: ICU also orders `{|}~`, `_` and non-ASCII
    characters differently from code points, and LOWER fixes case only. Set ranges (`calcFormula`) follow the same rule.
  - Hide (`FilterIR.hidden`, `hidden-members.js` `hiddenScope`): on a dimension in every pane's level of detail (a shelf,
    or every pane's encodings) it is a row filter, with warning `filter.hidden` when a table calc runs along it (Tableau
    still counts hidden members there). On one only some panes encode, the member condition (`memberCondition`: an
    exclude keeps nulls) goes inside those panes' measures, `<AGG>(CASE WHEN <condition> THEN <field> END)`, and the
    other panes keep every row. A measure that cannot take it
    (an aggregate calc, a table calc, an LOD) keeps the row filter with warning `filter.hidden`.

`layout.js`: `planPages(ir, cards, bindings, { options, workbookKey, variables, inlineParameters }) → { pages, cards: extraFilterCards, issues, app? }` (sets `cards[].pageKeys`)
- `options.target` (`ConvertOptions.target`, default `'app'` in `resolveConvertOptions`; planPages itself treats anything else as
  `'pages'`). `'pages'`: a root page `<wb>` plus a subpage `<wb>--<dashboard>` per dashboard. `'app'`: no root page; an `AppPlan`
  (`app`, key `<wb>`, title from `pageTitle` / `namePrefix`, theme `{ base }` default Clarion, navigation TOP whatever the view
  count unless `navOrientation` (`--nav left`), `showDomoNavigation` true with TOP unless `domoNav` is false (`--no-domo-nav`) and
  `showTitle` true, as the editor sets them; LEFT has neither, persistSettings with filters and variables on unless `persistFilters` is false and interactions off (a filter
  action into another dashboard is a card DOMOLINK with `allowCardToCardInteractions`, the editor's "Enable interaction
  filters" on a KPI card, which passes the clicked values), `landingKey` the first visible view) and one view per dashboard in tab order
  (`PagePlan` with `appKey`, 1-based `navOrder`, `hidden`, `navIcon`; the bare dashboard name as title, capped at 254), plus a "Worksheets"
  view `<wb>--worksheets` for sheets on no dashboard. When every dashboard is hidden the landing view is shown (`layout.landing-hidden`).
  Page keys are the same in both targets, so push refuses a plan whose dashboards were pushed with the other target.
- App views: text items are cut at `APP_TEXT_LIMIT` (250, App Studio's cut) instead of `MAX_HEADER_TEXT` (254), and
  `applyAppLayoutRules(layout, dash)` drops a non-https WEBLINK interaction from its item (`layout.url-action-dropped`; any other
  scheme fails the whole layout PUT) and cuts HEADER, BUTTON and TAB_CONTENT text to 250. The `app-layout.js` items are added
  for target app only; target pages output is unchanged.
- `app-layout.js` (target app):
  - Links: `viewLink(pageKey, { persistFilters })` is the same-app DOMOLINK (`entityType 'page'`, `displayMode APP_NAVIGATION`) with
    `entityId` / `url` as `$ref page:<key>` fields `idString` and `appUrl`; `cardLink(cardKey)` opens a card (`PRESENTATION`,
    fields `idString` and `detailsUrl`); `linkTo(target, ctx)` picks one for a dashboard, story or worksheet target.
  - `navigationButton(zone, dash, ctx)`: a navigation button zone becomes a BUTTON (`buttonBox`: at least 3 high, 8 wide; compact 1
    high); image and icon buttons get the target name as text (`layout.button-image`); a gone or unconverted target is
    `layout.button-target-missing`, a download button `layout.button-download`. `sheetButton` does the same for a worksheet drawn as
    a button (`card.ui-sheet`) that starts a Go to Sheet action.
  - `toggleSections(dash)` and `groupSections(entries, sections, pageKey, nextKey)`: each show/hide button wraps the zones it toggles
    (a container's leaves via `containerZones`, or single zones) in a full-width collapsible `TABS tabType SECTION` (`itemId` uuidv5
    of page key and button zone id, title from the container name, else its first sheet or text, cut to 250) with its members
    tiled in the pane (`tilePane`) and a 5 / 2 high bar; the button itself is left out. A text card it toggles goes into the
    pane; a title it toggles stays outside as header rows (the editor allows no HEADER in a pane; `layout.section-text`). A section inside another merges into it (`layout.section-nested`).
    `sectionIssues`: `layout.section`, or `layout.section-expanded` when Tableau starts it hidden (no author-level collapsed state).
  - `buildAppLayout(entries)`: buildLayout plus groups `TABS > [TAB_BAR, TAB_CONTENT > children]` in both templates (TAB_BAR a
    template entry only, every pane under the bar, compact children stacked per pane), finished by `finishLayout`; plain layouts
    are buildLayout's.
  - `applyCardActions(dash, entries, ctx)`: worksheet card `interaction` from `ir.actions` (`actionSources`: named sheets, the
    source dashboard's sheets, every sheet of a datasource, or all). One click action per card, chosen by trigger (select, menu,
    hover) then kind (Go to Sheet, filter into another view, URL, parameter, same-view filter), a URL cut at a field token last; view
    links (buttons and actions alike) carry the page filters (`persistFilters` true); same-view filters keep Domo's default
    cross-filtering unless they leave cards out (`STANDARD` with `selectIndividualCards` and `selectedCardUrns` as `$ref card:<key>`
    field `urn`; `allowCardToCardInteractions` is true, or false with no urns, the editor's "selected cards" and "disable interaction
    filters" options).
    `urlInteraction` / `staticUrl`: https only, parameter tokens take the parameter value, a field token cuts the link there, http
    becomes https, a template starting with a host and no scheme gets `https://`, max 2000. A cut link on a menu or hover action, or
    one whose field token sits in the path (`pathToken`: the rest opens another page), is not migrated (`layout.action-url-dropped`),
    so the card keeps Domo's click filtering. A URL action a table carries as a link column (`CardPlan.urlColumns`) is no click on
    that card. `actionIssues(ir, log, cards)` reports each action once (`layout.action-trigger`, `-filter`, `-url`,
    `-url-dropped`, `-navigate`, `-parameter`, `-conflict`, `-unmapped`, `-unplaced`, `-highlight`, `-set`); convertWorkbook then
    drops the parser's `twb.*-action` and `twb.story` issues for target app.
  - `planStoryLayout(story, key, ctx)`: one view per story (`PagePlan.story`, key `<wb>--<story>`, in tab order with the dashboards):
    title HEADER, then a full-width `TABS tabType TAB` with a pane per point (label cut to 60, `layout.story-caption`; no header
    in a tab), the point's card, a button to a dashboard point's view (`layout.story-dashboard`), or a SPACER; repeated sheets,
    captured filters and annotations are reported (`layout.story-point`, `-filters`, `-annotations`).
  - `linkedPageKeys(layout)`: pages a layout links to. A hidden view any other layout links to gets `PagePlan.linked`
    (`layout.hidden-linked`).
  - `workbookTheme(ir, base)` → `AppPlan.theme.overrides` (`AppThemeOverrides`): text font (workbook default, else the dominant run
    font) and title font mapped by `themeFamily`, text color (workbook default, else a neutral color held by most text runs, runs in
    the default color counted), dominant opaque dashboard background (`opaqueHex`), card background
    and border when most worksheet zones share them, navigation button color; `layout.theme`.
    `ConvertOptions.workbookTheme` false (`--no-workbook-theme`) skips it, the palette, the table look and the item styles.
  - Table look: `workbookTableStyle(ir, cards)` → `AppThemeOverrides.table` (`AppTableStyle`), the most common
    `sheetTableStyle` among the worksheets of placed `badge_basic_table` / `badge_pivot_table` cards (`layout.table-style`).
    It reads `WorksheetIR.tableStyle` over `WorkbookStyleIR.table` (IR 16, `twb/style.js` `tableStyle`: table band-size and
    pane/header band-color in the rows scope, data-class total/subtotal background-color in the rows scope else unscoped,
    table-div rows line-visibility / stroke-size / stroke-color). Unset parts take Tableau's default crosstab as it renders
    (`TABLEAU_TABLE`, measured on a crosstab that sets none): white rows and header, every other row `#F5F5F5`, no
    totals fill (a `#00000000` None is the row color), `#CBCBCB` row dividers. Domo draws a divider under every row, Tableau
    only between outer row groups, so dividers are HORIZONTAL with two or more row dimensions and BELOW_HEADER with one; a
    sheet with row dividers off gets NONE. The theme has one mapped table style, so crosstabs whose look differs take the
    majority's (the message counts them); free `t#` slots exist but item styles key on zone style, not shading. An older
    ir.json warns `convert.ir-outdated` and gets the defaults.
  - Filter cards take the worksheet's quick filter title (`WorksheetIR.filterTitles`, `quick-filter` style-rule `title`),
    else the column name; the card key stays on the column. In apps, `controlItemStyle(zone, dash)`
    gives each filter card the background it shows in Tableau, its own or the nearest container's, and no border; the most common
    one becomes `AppThemeOverrides.control` (the theme's control style), the others item styles of kind `control`.
  - Item styles: `zoneItemStyle(zone, chartType)` puts a plan-only `itemStyle` (`kind` card or table, opaque background, border
    color and width 1..4, inner padding rounded to 4 px; null keeps the theme's) on each chart and table card content of a
    worksheet zone (not single values, selectors or controls); `planItemStyles(views, overrides.card)` merges near-identical
    ones (colors within 8 per channel, padding within 4 px), drops the one equal to the theme's card style, ranks them by item
    count into `AppPlan.theme.itemStyles` (`ItemStylePlan`, keys `s1`...) and rewrites each `itemStyle` to its key
    (`layout.item-styles`).
- A title-only worksheet zone becomes a page HEADER with its title (lines holding field values such as
  `<Data Update Time>` dropped); an empty worksheet zone is left out without `layout.missing-card`.
- Variable titles: a parameter token in a worksheet title whose parameter is a planned Domo variable (`planCards`
  `variables`; not `--parameters inline` and not an inlined constant) is a smart text item `{ type: 'VARIABLE_VALUE',
  variables: [{ $ref: 'variable:<key>' }], defaultText: <current display value> }` (`resolveTitle` `lines[].items`) between
  TEXT items that keep Tableau's spacing, as the viewer concatenates items as they are. The first line is
  `definition.dynamicTitle`, `definition.title` the plain text; later lines go to `dynamicDescription` (with the update time
  item when there is one). The viewer shows the variable's member value, which is the alias for an aliased list
  parameter (below); a parameter whose aliases cannot be labels (repeated) reports `card.title-variable` (info); other
  parameter tokens stay fixed text (`card.title-parameter`). Push resolves the ref to the
  variable id and gives the card a VARIABLE control for it, so the card re-renders on a variable change. Header and label
  sheets and tooltips stay static.
- Filter and dataset titles (`resolveTitle` `smartText`, card titles only): a dimension token (no aggregation, or ATTR)
  is `{ type: 'FILTER', columns, defaultText: 'All' }`, which shows the page or card filter values on that column
  (`columns` the dataset column, or a beast mode's legacy id and name, as the editor stores them; `card.title-filter`); `<Data Source Name>` is `{ type: 'DATA_SOURCE_NAME' }` (plain text: the datasource caption).
  Measure tokens have no smart text and are left out (`card.title-field`). A worksheet zone with `showTitle: false`
  gives its card item `hideTitle: true`.
- Date windows (`period-top.js`): a filter whose calculation only keeps recent periods becomes a native `relative-date`
  filter on the date and the calculation is not built (no rank unit, no beast mode). Two shapes:
  - Period Top N: a Top N (top, numeric count) on a calc joining a year and a quarter field (FY/Year, FQ/Quarter), or
    on a date column's pill (its truncation, a year part or the day), ranked by COUNTD, COUNT, MIN, MAX or ATTR of
    itself (`filter.period-top`). COUNTD ties every period and MIN/MAX order them by date; COUNT ranks by row count, which
    in Tableau only a hand-picked list of the latest periods on the filter's General tab (`top.members`) turns into a
    window, so without such a list it warns (a Magic ETL rank by row count keeps the busiest periods, not the latest).
    A list of consecutive periods sizes the window (the smaller of the count and the list) and warns that Tableau's list
    is fixed while Domo's window moves on with new data; a list with gaps warns that the window ignores it. A Top N with
    `top.members` that is no window becomes an include filter of the list, next to the Top N when the count is smaller
    than the list. A label gets a new `<label> Quarter Start` calc
    (`periodDate`, the first day of the quarter's first month), always computed in Magic ETL so a card date range can
    read it.
  - A boolean calc kept True (include `[true]` or exclude `[false]`, not shown on a dashboard) that is a DATEDIFF of a
    date column against TODAY()/NOW() or the latest date (`{MAX([d])}`, `{FIXED : MAX([d])}`, WINDOW_MAX, TOTAL),
    compared with a number (`AND` of two bounds), `[d] >= DATEADD(unit, -N, anchor)` (whole periods in Domo, a warning
    unless the unit is day), or a descending RANK of MIN/MAX/ATTR of the date compared with N, in the period of the
    date's one pill on the sheet (`filter.date-window`). A window without an upper bound on the periods back is left.
  Domo's relative dates count back from today: `ROLLING_PERIOD` count N offset 0 includes the current partial period,
  offset 1 ends at the previous one (verified with render previews). A window anchored on
  today keeps Tableau's meaning. A Top N on itself, a rank, or a window against the latest date is relative to the data,
  so it keeps the N periods before the current one (first -N, last -1), taking the data's latest period as the last
  complete one, and warns that offset 0 is the choice when the data has the current period. A materialized date formula is wrapped in `DATE()`: Magic ETL's STR_TO_DATE
  yields a timestamp, which Domo shifts into the instance time zone. Merged crosstab sections keep a date range they share.
- Fiscal years (`convert/fiscal.js`, `FieldBinding.fiscalYearStart` from `FieldIR.fiscalYearStart` when it is not January):
  - A card whose Domo calendar periods come from a fiscal field (a YEAR, QUARTER, MONTH or WEEK `dateGrain`, or a
    `dateRangeFilter` in those intervals, including the `filter.date-window` and `filter.period-top` windows) gets
    `fiscal: true` on every subscription (main, big_number, the drill views planned from it) and
    `CardPlan.fiscalCalendar` `{ startMonth, labelByEndYear: true, source }`. `source` is `'instance'` for a dataset stored in
    Domo (upload, connector, Magic ETL output, a DataSet View over those; federated and existing datasets count as stored)
    and `{ integrationId }` for a Cloud Amplifier dataset or a SQL view or fusion over them (`calendarSource`).
  - The flag is per card, so a card mixing fiscal and calendar (or two fiscal) date fields takes the most used fiscal
    start and warns `card.fiscal-mixed`.
  - Date parts and truncations Domo computes in card beast modes do not use the flag: `datePartFormula(part, expr,
    fiscalStart)` shifts the date by `13 - start` months, so year is `YEAR(DATE_ADD(d, INTERVAL 1 MONTH))` for December
    (named by the end year), quarter and the `YYYY-Qn` truncation likewise, the month part keeps calendar month names and
    sorts from the start month, and the week counts from the fiscal year start. A year filter keeps whole fiscal years
    (`fiscalYearRange`). Plain dates, day and month truncations, and warehouse fiscal columns (string and number
    columns) are unaffected; Tableau calcs (DATEPART, DATETRUNC) are calendar in both tools.
  - One fiscal calendar per instance and per integration: datasources of one workbook needing different non-January
    starts on one target give the minority's cards (every card on a tie) the must-fix `convert.fiscal-conflict`
    (`planCalendarConflicts`). January never needs a calendar and never conflicts.
- Update time: `<Data Update Time>` in a worksheet title is a "Date last updated" smart text item
  (`{ type: 'DATA_SOURCE_DATA_LAST_UPDATED', prefix, suffix? }`, `cards.js updateTimeToken`) in the card's
  `dynamicDescription` (`displayOnCardDetails: true`), after the title's other lines as TEXT. A status sheet
  (`statusSheetNames`: the token in its title, and every zone at most 80 px high or no data field) gets no chart card
  (`replacedBy`, so push deletes the one an earlier push made; `planStatusSheets`). Whether its title shows only the update
  time ("Last Updated: <Data Update Time>") or more (the owner), it is one text card (`CardPlan.kind: 'notebook'`, key `<status card key>.text`, on the status card's dataset;
  `notebook.js`) on every view that shows it: a full-width row as tall as its paragraphs wrapped at the view width
  (`notebookHeight`: theme notebook text 14px, 21px lines, 40px padding; one line 6 standard rows, two 7; compact at least 6)
  that leads the phone order like a header (`placed.banner`), with title, description, footer and wrench hidden (`notebookContent`). Its paragraphs keep the
  title's bold runs (`WorksheetIR.titleRuns`), `<Data Update Time>` is "Date last updated" smart text, the value of an
  `Owner ... : value` part an owner segment, other tokens are left out; smart text ids are uuidv5 of the card key. A card with
  smart text shows its description (`hideDescription: false`).
- Published views (`withoutUnpublishedSheets`, `src/convert/published.js`): with `WorkbookInfo.views` listed, a dashboard or
  story that is not a view and that no view opens (dashboard zones and buttons, story points, action targets, followed
  transitively) is dropped, and a worksheet neither published nor reachable is hidden, so it gets no card and no place on
  the "Worksheets" view (`convert.unpublished`, info). `convert --unpublished` keeps them.
- Tableau links (`ConvertOptions.tableauLinks`, on by default, `convert --no-tableau-links` turns it off): the text card at the top of each
  dashboard view gets a last paragraph "Open in Tableau" linking to the dashboard on Tableau (`tableauViewUrl`: the site route of
  `WorkbookInfo.webpageUrl`, then `views/<view content url>` from `WorkbookInfo.views`, which extract lists; a dashboard Tableau
  does not publish as a view links to the workbook page; without the list, the sheet name with spaces and punctuation dropped).
  A status text card shared by several views is copied for each further view (key `<card>.<page>`, its own link and smart text
  ids); a view with no text card gets one just for the link (key `<page>.tableau-link`, no dataset), a floating banner that
  `placeFloating` puts below the title. `CardPlan.tableauLink` records the url. The link segment (`{ text, link }`) is written
  as the editor's link plugin saves one (an `<a target="_blank">`, a Slate `a` inline with `configType: 'WEBLINK'`, a `link` tag).
- Web page zones that show a Tableau view (`web-links.js`: `/#/site/<site>/views/<workbook>/<sheet>`, `/t/<site>/views/...`,
  `/views/...`, any query; the site the workbook came from, else the configured one). A view of this workbook is a BUTTON to
  its view; a view of another workspace workbook (`convertStage` `linkContext` reads its plan.json, else predicts its keys from
  its ir.json) is one BUTTON the size of the zone with an https WEBLINK whose url is `{ $ref: 'page:<key>', field: 'webUrl' }`
  (push fills in `https://<instance>/app-studio/<app>/pages/<view>`; a DOMOLINK cannot target another app's view), recorded in
  `PagePlan.webLinks` (`layout.web-view`). Every other Tableau view keeps the zone-sized BUTTON, "Open <view> in Tableau
  (<workbook>)", an https WEBLINK in a new tab to `tableauViewHref` (`https://<host>/#/site/<site>/views/<wb>/<sheet>`, the
  `?:iid=N` tab query dropped, http made https), so a frame dashboard (one web zone over the canvas) is never empty: a
  workbook outside the migration (`layout.web-view-outside`, status stays `outside` so `linksLater` still relinks it), another
  site or an unknown sheet (`layout.web-view-unresolved`), a sheet of this workbook with no view or card. Names come from
  `WorkbookInfo.linkedViews` (extract lists the linked workbooks' views over REST, fail-soft), else from the url words.
  Every `webLinks` record has `tableauUrl`; push gives a `move` button whose target is not pushed yet that Tableau link
  instead of dropping it (`push.web-link-target-missing`), and the next layout push swaps in the app link. Any other http(s)
  web zone is a BUTTON "Open <host>" in a new tab (`layout.web-page`); classic pages keep the issue (no buttons). `t2d
  migrate` batches convert a workbook again and push its layouts after the batch when its web zones show workbooks migrated
  after it (`linksLater`).
- Bar, line and area axes: a category level whose headers Tableau hides takes no ITEM or SERIES slot (unless every level
  is hidden); it goes to `sortOnly` (grouped, sorted ascending), so the next visible level or the color dimension is the
  series (`chart.hidden-level`).
- An ITEM sorted by the VALUE column on a card that groups by more than the ITEM sorts by `MAX(<value> FIXED (BY <item>))`
  (`itemGrainSort`): a sort equal to the VALUE column turns second-level sorting off, so the rows would follow per-row values.
- Text functions (`CONTAINS`, `STARTSWITH`, `ENDSWITH`, `FIND`) and `=` / `!=` lower-case both sides when an operand is a field
  whose collation ignores case (`collationIgnoresCase`: ICU strength 1 or 2; resolved columns carry `ignoreCase`, kept through
  calc references and IF/CASE results), since Domo compares text case-sensitively.
- Table cards: a row or column dimension with a hidden header (`WorksheetIR.hiddenHeaders`, the label style-rule
  `display=false`) is not a column (a Domo table cannot hide one): it stays in groupBy and in the sorts where Tableau has
  it, sorting ascending when it has no sort (`ChartInference.sortOnly`, `card.hidden-header`). When nothing else splits the
  cells the hidden headers stay: a pivot axis whose headers are all hidden keeps them as ROW / COLUMN, and a flat table whose
  dimensions are all hidden (Measure Names rows over hidden FY / FP) gets them as
  leading columns sorted ascending (`ChartInference.keptHeaders`); info `card.hidden-header` "shown". Without them every
  FY / FQ is an unlabeled row, or a pivot cell holding several query rows ("****").
- URL link columns (`url-columns.js`, `addUrlColumns` in cards.js): on a `badge_basic_table`, each URL action that starts from
  the sheet (`urlActionSheets`, any dashboard) and whose field tokens are all in the view (rows, columns, any mark encoding, hidden
  headers included) becomes a link in each row (`CardPlan.urlColumns`, info `card.url-column`). The column (`pickLinkColumn`, a
  visible non-date dimension column): the underlined one (`linkStyled`), else the token field, else a field the token calc reads,
  else the first text column. When the template is `https://...<that column>...` with no other token or `url-escape`, the column
  gets App Studio's link format (`format.tableColumn` `displayType: 'link'`, prefix and suffix);
  otherwise a card formula replaces it in place (alias = its header, the column itself stays
  in groupBy): `CASE WHEN <token> IS NULL THEN <label> ELSE CONCAT('<a name="', <label without ">, '" href="<url>"
  target="_blank">', <label>, '</a>') END` (`hyperlinkFormula`, the shape of the instance's own Hyperlink Beast Modes; `name`
  makes the column sort by the label). Row-level and grouped when every token is a row-level dimension; `MAX` of every field when
  a token is `ATTR` or another aggregate. `url-escape` is a `REPLACE` chain (`%` first; Domo has no URL encode function),
  `include-null` uses `IFNULL(token, '')`, parameter tokens are their current value. The label is not HTML-escaped: Phoenix
  entity-encodes the cell before it parses the whitelisted `<a>`, so an entity would show literally. A clicked link wins over the
  card's interaction. An action whose column is taken by an
  earlier one, or with no text column, gets a column appended under its name (link text = its menu caption); its null cell is
  `NULLIF(1, 1)`, as Beast Mode rejects the `NULL` keyword. The same action defined on several dashboards (same name, caption
  and template) is one link, not a column per copy. Pivot tables are
  not linked yet (Phoenix converts links only in pivot headers; no render probe).
- Category axis order (`itemFirst`): a bar, line, area or combo card whose ITEM is not a date sorts by it first, with its own
  Tableau sort when it has one, else ascending: a text ITEM by an aggregated card formula `<field> (natural order)` that pads
  every digit run to 10 digits (`naturalOrderKey`, so "2023 P7" comes before "2023 P10", as Tableau draws it), a number by its
  value; a date ITEM is left to Domo, which orders dates. Top N rankings stay ahead of it, and
  the axis sort comes before every other sort. On a card with one SERIES, ITEM and VALUE and two or more sorts, Domo's
  second-level sorting (only the first two sorts count) gives a sort on the ITEM or SERIES column itself that slot wherever it is
  listed; of the other sorts the first fills the series slot if it is free and the next the category slot. So:
  - a series with no Tableau sort: a text series bound to a field gets its own natural-order key, listed first so it takes
    the series slot: `[series key, axis key]` (Tableau lists unsorted members in natural order; with the axis key alone Domo
    keeps the query's row order). Other series: `[axis key, SERIES column ascending]`;
  - an alphabetic series sort (on the series column): `[axis key, series column]`;
  - a manual series order (a rank formula): `[rank, axis key]`, so the rank fills the series slot and the axis key the
    category slot;
  - a computed series sort by the VALUE measure itself (`sortEntries`, `seriesByValue`): a sort equal to the VALUE column
    turns second-level sorting off and scrambles the axis by per-row values, so the series sorts by `<series> (total order)`,
    `SUM(<value>) OVER (PARTITION BY <series expression>)` (`totalOrderKey`, shared with `pivotOrder`; a beast-mode series such
    as one that reads a variable partitions by its formula): `[total key, axis key]`, also first on a date axis. Without window
    functions the series sorts by name (`[axis key, series column]`, info `card.sort`). Verified on render previews:
    quarters in order, series by total.
  Domo stacks the first series at the bottom where Tableau draws it on top, so on a vertical stack (`badge_vert_stackedbar`,
  `badge_vert_100pct`) the series sort of the first two cases is reversed and `legend_reverse_layout` set, but only when card color rules pin the series colors:
  Phoenix assigns palette colors by series order, so without rules the stack stays upside down (info `card.stack-order`). Axis first, the rank would take the category slot (both orders scrambled), and a sort on the
    series column instead orders the series alphabetically;
  - a series sort by another measure stays first (info `card.sort-order`).
  A combined category (see the bar axes) sorted by the VALUE column is `[VALUE, combined ascending]` (`combinedValueOrder`):
  a key that is no VALUE sort would take the series slot, so a category with several
  series members sits at its largest segment, not its stack total (info `card.sort-order`). Otherwise its natural-order key is
  `naturalOrderKey` of the whole CONCAT (`FY + FP (natural order)`: "2024 2" before "2024 10"), in the level sort's direction.
  The earlier single combined key (`<axis> (natural order, then <series>)`) relied on the series order being the order each
  series first appears in the rows; it listed the series in Tableau's order but stacked them upside down, and it is gone.
  Verified on throwaway copies: `[axis key, <series> ascending]` renders the periods in order and the series alphabetically,
  where Tableau draws its manual order.
- Heatmaps (`heatmapOrder`): Phoenix lists the columns and rows in the order they first appear in the query, so an unsorted
  text ITEM or SERIES gets its natural-order key (another unsorted header ascending), listed `[series, item]` for
  second-level sorting (verified on a render preview: `[item key]` alone orders the
  columns only, `[item key, series key]` scrambles both).
- Pivot tables (`pivotTotals`, `pivotOrder`, `pivotHeaderSorts`; the Phoenix option list of `badge_pivot_table`):
  - Totals: every switch is written (`total_row`, `total_col`, `subtotal_rows`, `subtotal_columns` `'true'`/`'false'`), because
    Phoenix shows all four unless told not to. `<rows total='true'>` is the grand total row (`total_row_label` "Grand Total"),
    `<cols total='true'>` the grand total column; Tableau's "totals to top" (`rows@onTop`, `WorksheetIR.totals.rowsOnTop`) and
    "to left" (`cols@onLeft`) are `total_row_position` / `subtotal_rows_position` and `total_col_position` /
    `subtotal_cols_position` 'Before'. Phoenix subtotals every header level of an axis, so a header Tableau does not subtotal
    gets the column format `tableColumn.hideSubtotal` (read per header); subtotal labels are "Total".
  - Row order: Phoenix lists each header's members in the order they first appear in the rows (per level,
    sorted only after a click), so the query is sorted level by level along the row shelf: a computed sort by the member's
    total within its parents (`<field> (total order)`, `SUM(<measure>) OVER (PARTITION BY <headers up to it>)`), a manual one by
    its rank, an alphabetic one by the column (a descending one after `<field> (nulls last)`, since Domo sorts nulls first there
    and Tableau lists Null last), an unsorted one ascending; each member key follows its sort so members stay together; then the
    column headers. Without window functions, or with a calendar header, the flat sort stays. The rows then come
    out as Tableau lists them. On a Mega Table (family `crosstab`, drawn in
    query order) a text header that is unsorted or sorted by name sorts by `naturalOrderKey(<field>, { perGroup: true })`.
  - Header member order: the query order is not enough, since a column header lists its members as they first appear over
    the rows (2024 P5, P8, P9, P6, P7). Every row or column header Tableau leaves unsorted or sorts
    by name (not a computed or manual sort, not a date) is named in the chart option `column_sort`
    (`[{"column":"Region","sort":"asc"},...]`, `desc` for a descending sort). Phoenix then orders its members with numbers numeric and text natural and
    case-insensitive, Tableau's order. `column` is the data label: a dataset column's own name (its alias does not match), a
    beast mode's or card formula's name (`FieldBinding.formulaName` when the beast mode name differs); verified on render
    previews. Residuals: Phoenix tries date parsing when the card has a date grain, and sorts `_`
    and punctuation by code point after upper-casing.
  - Limits Domo has and Tableau does not: a pivot reads at most 10,000 rows, and past
    it shows "This pivot table is only showing part of the data" with "###" for subtotals it cannot compute; headers are
    ordered by first appearance unless `column_sort` names them (no manual order), and the field labels always show.
    A grouping column that is not a row or column (a hidden header) gives two rows
    one cell, drawn "****" ("Multiple results encountered for same location").
- Stacked crosstabs (`stack.js` `planCrosstabStacks`, run after planCards): Tableau draws one table from pivots tiled in one
  column, the lower ones hiding the column headers they share with the top one. A Domo pivot puts VALUE columns in a
  header row under the column headers and each source row feeds a row of every section (Opening, its waterfall category,
  Ending), so the sections become one ROW over one VALUE on a union of the card dataset with one copy per section.
  - Detection (`findCrosstabStacks`, per dashboard): tiled worksheet zones whose cards are pivots, with the same x and width and
    each top on the previous bottom (0.5% of the dashboard), the same datasource, card dataset and column pills, one row
    header (not Measure Names), one VALUE with the same format, no totals, the same top filters and limit; every member after
    the head hides all its column headers and the head shows them; a constant row label (`"Opening"`) must not be a member
    another section lists (manual sort, include filter). The chain stops at the first zone that fails. Keyed by the ordered
    sheet names, so one stack on two dashboards is one card. A pivot with Measure Names rows stays its own card.
  - Data: dataset `<T>.stack-<head>` (strategy `dataflow-output`, T's schema plus `t2d_section` LONG, `cardTarget: false`). When T
    is a Magic ETL output of the plan, a second output of T's dataflow: per section an ExpressionEvaluator `t2d_section = i`
    on what T's PublishToVault reads, a UnionAll (INCLUDE_ALL, schema of section 1) and a PublishToVault; else a flow of its
    own loading T. Push creates and runs it as any dataflow output. Skipped with `--no-materialize`.
  - Beast modes every member body reads (columns, sorts, filters, controls, transitively) are cloned onto the union dataset
    with the same names (page filter cards match them by name), keys `<key>@<stack>` and legacyIds from the stack and the old id.
  - Card (`CardPlan.stack`, key `<workbook>.stack-<sheets>`): ROW card formula `CASE WHEN t2d_section = i THEN <row i> ... END`
    (alias `' '`), the head's COLUMN headers, VALUE `CASE WHEN MAX(t2d_section) = i THEN <measure i> ... END` with the shared
    format; bodies are inlined from the member cards. A member's quick filter selections (control values that are not view
    defaults) count as its filters, since the merged card has no controls. Filters every member has stay, as does a dashboard filter one member shows
    and the others hold as scoped fixed copies with the same selection (it keeps `scopedFilters`, so the view default can replace
    it); the others fold into one row-level beast
    mode `<title> (section rows)` (`CASE WHEN t2d_section = i THEN <conditions> ...`, filtered IN 'true'; NOT_IN `''` is IS NOT
    NULL as the server reads it), and a filter that is not row-level keeps the cards apart (`card.crosstab-stack` with the
    reason). Sort: `MIN(t2d_section)`, then each section's own leading sorts (its manual rank) as `CASE WHEN MIN(t2d_section) = i
    THEN ...`, the row label, the column headers; `column_sort` names only the column headers. Phoenix lists the rows in that
    query order (render previews: Opening, New, Expansion, Contraction, Ending). Totals off,
    controls dropped, quick filter defaults merged.
  - Members whose every dashboard zone is in a stack are `unsupported`, `replacedBy: 'stack'`, `stackedInto` the merged key; push
    retires a card an earlier push made ("the sheet is part of the merged table <title>"). A sheet also shown elsewhere keeps
    its card.
  - Layout (`planDashboard`, both targets): the head zone places the merged card at its x, y and width, as tall as its lines
    (`stackHeightPx`: column header levels, the value header and the row members, about 28px each, plus 48px), at least the
    pivot minimum and not capped by the zones it replaces (Domo's table lines are taller than Tableau's, so the zones clip it);
    its title is hidden when no member zone shows one. The other zones are left out (`layout.crosstab-stack`). App actions from or
    to a member sheet reach the merged card (its entry lists every member sheet), and `--worksheets` naming a member keeps it.
- Crosstabs that list records (`chart-types.js` `crosstabTable`, family `crosstab`; `CROSSTAB_ROW_HEADERS` = 4 visible row headers
  or more): a Mega Table (`badge_basic_table`, which pages through every row). Visible row headers are the first columns, outer column headers the next ones; the
  innermost column header is spread (`ChartInference.spread`, `cards.js` `spreadMembers`) into one value column per member of its
  manual sort, `<AGG>(CASE WHEN <header> = <member> THEN <measure> END)` named after the member, then the measure as "Grand Total"
  when Tableau totals the columns; without a member list, a second measure, or a measure that is not a plain aggregation of a
  row-level field, the header stays a column (`chart.crosstab-spread`). Rows keep `pivotOrder`'s level-by-level sort (a hidden header
  only splits rows, as in Tableau). `crosstabTotals`: `total_row` with "Grand Total" (`Before` for totals to top), `subtotal_rows`
  when Tableau subtotals the first visible row header (Domo groups the subtotal query by the first column only; other
  subtotaled levels are `chart.crosstab-subtotals`), `total_row_suppress_count` / `subtotal_suppress_count`, and number headers get
  `tableColumn.hideTotal` / `hideSubtotal` so FY is not summed (its "2026" comes from `PLAIN_INTEGER_FORMAT`, below). Unused
  card formulas (the spread header's rank) are dropped. Verified on a throwaway copy: every row paged, the values Tableau shows. The member
  columns copy the measure column's format.
- Number formats (`number-format.js`): `domoNumberFormat(tableauFormat)` maps a Tableau number format to a Domo column format
  (`{ type: 'number'|'currency'|'percent', format, commas, percentMultiplied, precision, currency?, abbreviate }`, the shape the
  editor saves and Phoenix reads). It reads the first section only (the `;` zero section and
  `[...]` conditions are dropped; the negative section becomes chart properties, below), the `n`/`c`/`p`/`*` prefix and `!locale!` tag, the currency symbol (quoted or `$`
  before the number; with `n`/`*` only a Unicode currency symbol), decimals, thousands separators, percent (`%`, or a literal `"%"`
  suffix as `percentMultiplied: false`) and scaling commas (`,K` thousands, `,,M` millions) as `abbreviate: true` (Domo picks
  K/M/B per value). `C<LCID>` (Currency, Standard) is 2 decimals with the locale's symbol. Dates, `e` scientific, `N`/`S` and
  other text formats give none. A card column takes, in order, the worksheet's `text-format` for its pill
  (`WorksheetIR.numberFormats`, cell rule before label rule), then the field's `default-format` (only when the column is the field
  itself: not a count or table calc of a measure, not a bin), then `PLAIN_INTEGER_FORMAT` for an integer dimension. On a 100%
  chart a percent `text-format` on the plain measure is the share's format, not the measure's: the VALUE column takes the
  field's `default-format`, and the share labels keep `percent_decimal_places`. Filter cards
  use the field's format. Columns with no Tableau format get no format. For example `c"$"#,##0;("$"#,##0)` on
  `SUM(Sales)` gives `{ type: 'currency', format: '###,###', commas: true, percentMultiplied: true, precision: 0,
  currency: '$', abbreviate: false }`.
  Negatives: the column format has no negative option, so `negativeStyle(tableauFormat)` reads the second section
  (`'parens'` for `("$"#,##0)` or `"$"(#,##0)`, `'minus'` for a leading `-` or no section; `C<LCID>` and `[...]` conditions
  give none) and `negativeNumberOverrides` (`chart-options.js`) turns it into chart properties when every formatted measure
  on the card is `'parens'` (mixed: info `chart.negative-numbers`, Domo's minus kept). Tables, Mega Tables and pivots get
  `parenthesize_negatives: 'true'`; other chart types get `'(100)'` (a value starting with "(") on the properties their
  Phoenix option list has: value axis `negative_numbers` (`_right` on multibar and
  two-trendline, `_line`/`_bar` on combos, `_x`/`_y` on scatter and bubble), data labels `negative_numbers_dl`, hover
  `negative_numbers_hvr`; pie, donut, maps and single value `negative_numbers`; multi value `single_negative_numbers` and
  `addl_text_negative_numbers`; treemap hover only; heatmap labels and hover. Gantt, lat/long map and histogram list none.
- Header labels: a table or pivot dimension whose Tableau caption is only punctuation (a "." header, an author's way to hide a
  label) gets the alias `' '`, a blank header; Domo has no option to hide one.
- Grid: `scaleRect` keeps the dashboard's proportions with rows `1 / ASPECT_RATIO` (1.67) of a column,
  on both targets. `minCardHeight(chartType)` / `minCompactHeight(type, chartType)` give each card a minimum
  (standard / phone rows: single value 10 / 4, multi value 12 / 5, tables 12 / 6, pivot tables 20 / 8 (several header
  rows), other charts 16 / 6, maps 20 / 8, small multiples 24 / 10, dropdown filters 10 / 4, checkbox and radio filters
  12 / 5, variable controls 10 / 4; a standard row is about 12.3px and a dropdown or variable control needs about
  105px, checked in the viewer), one `layout.min-height` info per dashboard.
- Tiling (`tile.js`): the editor only edits a template every cell
  of which one item covers, so `tileEntries` lays the view out from the items' unrounded Tableau frames by guillotine cuts (rows
  no item crosses, then columns, recursively): rows keep their natural (minimum) heights and close up, columns share the row's
  width by their spans (largest remainder, at least 5 columns, 2 for a BUTTON, a filter's title width), and the space of a
  zone that does not convert (image, web, legend, blank, unsupported card) goes to its neighbors. HEADER lines, sections and
  packed control rows are full-width rows of the top level, next to the row they sat in. A floating button over a card (one
  whose zone covers at least half of it, the largest share; `attachButtons`) takes that card's column width and its top
  BUTTON_HEIGHT rows (bottom ones when it sits in the card's lower half), the width split between several in x order; the card
  keeps the rest, at least its minimum height (`hostHeight`, `placeButtons`, also in section panes), and on a phone the button
  comes right before the card (after it at the bottom). Other floating items join the flow at their
  own height (`placeFloating`): over nothing that converts they keep their frame, else they get a row at the nearest row
  boundary, below a header or image card they overlap; items over one image card go below it in reading order, and the
  Tableau link card after the others (`trailing`) (`layout.floating`). `finishLayout` then fills any hole a neighbor can
  take, else with a SPACER, sorts each level by y, x, height (TAB_BAR first), sets `frameMargin` 4 and `framePadding` 8, and keeps
  content and templates in step (SPACER, TAB_BAR and PAGE_BREAK are template-only, as the editor saves them); push runs it again
  when it leaves out items it cannot resolve. `packControls` gives every packed control one width that divides the grid (10 for
  short titles) and ends a short last row with a SPACER instead of stretching the controls. CARD content items carry the
  editor's defaults (`cardContent`: `hideFooter`, `hideDescription` and `editInAppViewer` true). Text card items
  (`notebookContent`) set `editInAppViewer` false, so "Allow editing in app view mode" is off: App Studio lets viewers edit a
  text card's text in app view only when it is set; classic pages ignore it. Image items keep the
  default. This applies to both targets: classic pages use the same editor.
- Images (`imageRoles`, `imageCard`, `imageContent`): an image zone with package bytes is a document card (`CardPlan.kind:
  'image'`, key `<page>.image.<zone id>`, title the file name, `body.image`, one card and data file per view, as the user made
  them) with title, description, footer and wrench hidden and `fitToFrame` (cover) unless Tableau fits the image (contain).
  A full-width image near the top (w >= 0.8, y < 0.15, tiled or floating) is a banner: a full-width row of at least
  `BANNER_IMAGE_HEIGHT` (9) rows, 6 compact, leading the phone order, the dashboard title right below it.
  Another tiled image keeps its zone; a floating one over nothing its frame. Beneath counts Tableau's z-order
  (tiled zones and earlier floats; blank zones are nothing): a floating image over a title or text zone (a logo) shares the
  title's row at its Tableau side, at most 20 columns, the title HEADER narrowed and wrapped to the rest (one BLOCK entry,
  `titleRow`). When the title has a fill (its own, else the dashboard's then the workbook's `dash-title` / `dash-text`
  style rule, `textZoneFill`) that differs from the view background and the logo shows on it (`titleRowFill`), the row is a
  section instead (target app, `titleBand`, info `layout.title-band`): `tabType: 'SECTION'`, `hideTitle`, not collapsible, a
  0-row TAB_BAR so the pane is the TABS height (the editor sizes rows by the pane height and draws no bar), and
  `sectionFill`; push refills the theme's unmapped section style with that color and no border, density or
  margin (`applySectionFills`, also on an existing app's theme; Domo rebuilds both section
  styles of a theme saved with other than two, so a third is never added and a second fill keeps none) and points the TABS item at it (`style.sourceId`), so the header's
  automatic font color turns light on a dark fill (Domo reads the section's theme style, not an item override). A logo that shows on neither its title fill nor the view background (tone within 0.25) is left
  out with the info `layout.image-on-fill`; only one logo per title row is placed. One over other zones (a logo on a
  banner) is left out with the info `layout.image-overlay`. An image without bytes keeps the warning `layout.unsupported-zone`.
- Headers (target app, `src/convert/header.js`, `placeHeader`, info `layout.header`): the top band of a dashboard, a banner
  image with package bytes (w >= 0.8, y < 0.15), else the first title or text zone near the top (w >= 0.5, y < 0.15) whose
  fill (`textZoneFill`) differs from the view background, is one section (`headerBand`: `tabType: 'SECTION'`, `hideTitle`,
  not collapsible, a 0-row TAB_BAR) holding the zones whose center is on the band: title and text zones as text cards
  (`headerCard`, key `<page>.header.<zone>`, `header: true`; `headerParagraphs` keeps each run's bold, `#RRGGBB` color and
  size (`textSize`: 18 pt and up header 32 px, 14 title 24 px, 11 subtitle 18 px; Tableau's default title is 18 pt), line
  breaks and the first run's alignment; `valign: 'middle'`), logos as image cards, and status sheets as their text cards
  (target app: aligned and colored as the sheet title; a status line with the owner near the top stays a text card
  instead of description smart text; a view that the colors would not show on, white text on a white view, gets a copy
  without them, key `<card>.<page>.plain`). Each item is the band's full height at its Tableau columns (`bandColumns`),
  or shares its columns with items Tableau stacks there (a logo above the status line: the logo its share of the band,
  the text card its rows):
  fixed items at their zone columns, an overlap split at the later item's left edge; a title spanning the band takes its
  columns where nothing else is, centered around its Tableau center when the room there fits it; then the gaps close
  (centered text grows evenly, so a leftover edge gap next to it is a SPACER, `bandHoles`). The band is at least 5 rows,
  its scaled Tableau height, and each text card's rows (`textCardRows`: 24 px padding, 40/30/23/21 px lines, a row to
  spare); on a phone every item is 6 rows. The background is `sectionImage` (an image
  `CardPlan` with `section: true`, key `<page>.section-image.<zone>`, no card) or `sectionFill` (as the title band below).
  The Tableau link joins the band's non-title text card (Owner, Refresh Date, Open in Tableau in one right-aligned
  card); a band with only a title keeps the separate link card, below it (`titleRow`). A plain
  title zone near the top that is centered, right aligned or bold (`needsTextCard`) is a full-width text card instead of
  HEADER lines (`placeTitleCard`); a left, plain one stays HEADER lines. Target pages keep the earlier layout
  (banner image card, HEADER title, title row), so the pages plans did not change.
- Text cards (target app, `placeTextCard`, `textZoneCard`): a view has one title zone, none when its header band holds a
  title or text: among the title and text zones near the top (y < 0.15) off the band, a kind `title` zone, else the text
  with the largest run font size, then the widest, then the topmost and leftmost; a text zone counts only when its text
  fits 2 `h2` header lines (longer text is a glossary or definitions, not a title). Every other title or text zone is a
  text card at its own zone (key `<page>.text.<zone>`, `header: true` so push adopts a matching text card made in Domo,
  `valign: 'top'` as Tableau draws text), with `headerParagraphs`' bold, color, size, line breaks and alignment, and
  parameter tokens resolved to their values (`resolveTitle`; fields are left out, `layout.text-field`; Tableau splits a
  token over the runs `<`, `[ds].[field]` and `>`, which `headerParagraphs` joins first). It tiles beside its
  row neighbors, floating ones through `placeFloating`; its height is
  `textCardRows` at its width, and on a phone its own rows (`compactRows` on the square phone grid, at least 2). Text under
  10 pt shows at 14 px, the smallest text card size (the editor offers header, title, subtitle and text), with
  the info `layout.text-size`. On a re-push the `.header.` card of a top-band bold or centered zone that is not the title
  is retired as no longer in the plan and a `.text.` card made in its place, once; a text card made in Domo that
  was adopted under the old key is adopted again under the new one (`adoptTextCard` counts an adopted card whose key left
  the plan as not t2d's). The pages target is unchanged.
- Text: App Studio headers never wrap (CSS truncates, the editor resets each header to 5 rows), so a text zone becomes one HEADER
  per wrapped line at the full width, 5 rows each; app body text and long titles use the `h2` style (24px). Text is cut after
  `MAX_TEXT_LINES` (6) lines with a warning.
- Label sheets (`labelSheet`): a sheet with no shelves whose text and label pills are constant calculations or parameters
  becomes header lines from `PaneIR.label` (the pane's `<customized-label>`), else the sheet title when the zone shows it; its
  card is `unsupported`. Field and parameter values are dropped (`layout.label-sheet` info); with no text the zone is left out
  (`layout.label-sheet` warning).
- Filters: more than `FILTER_PANEL_THRESHOLD` (6) filter cards and variable controls go into one collapsible "Filters" section
  (target app; packed the same way without a section on pages), as a full-width block where the first filters were
  (`layout.filter-panel`). `packControls` keeps Tableau's arrangement: controls in one vertical container form a column,
  side-by-side columns a band, each column at its Tableau width scaled so the widest band fills the row (`spreadWidths`,
  largest remainder, equal when within 15%, at least 8 columns, 10 for a variable control); a band too narrow for its
  minimum widths wraps into even rows, and members line up by their place in the column (five containers of two filters
  become two rows of five 12-column filters). Titles do not size these. When that
  arrangement is taller than a reflow into 10-column slots in reading order, each at least as wide as its title (8 to 20
  columns), the reflow is used (a sidebar stack). The rest of a row is a SPACER. A column with fewer members than its band
  whose members are the only children of their Tableau container and cover it (95% of its height, `stackFill`) spreads them
  over the band in proportion to their Tableau heights instead of ending in a SPACER, each at least its control height.
  Fewer keep their place, at least as wide as
  their titles. A variable control shows the Tableau parameter's caption as its name, also when the variable took a suffix,
  and in an app takes its zone's background like a filter card (`controlItemStyle`). Control heights in an app
  (`controlHeight`, with the unpadded control style push sets): range and date selectors 8 standard rows everywhere; dropdown
  filter cards and variable controls 5 in a Filters section, whose density is 0, and one row more outside a section; checkbox
  and radio filter cards 12 and radio button variable controls 10 (they list their values). Classic pages, which get no control
  style, keep 10 (12 for lists). Every app view gets the view style `APP_VIEW_STYLE` (`LayoutPlan.style`:
  density 0, margins 0; push writes it with `sourceId` the app theme's first page style): with the theme's spacing (6) an
  8-row range selector draws no Minimum/Maximum labels. A section style of 0 spacing (TABS
  `style.density` and `margin`, which the server requires for both platforms) did not make them fit; the view style did.
  A Tableau range of dates (a quantitative date filter) is a range selector on the date column (MIN/MAX); a relative date filter
  is a date selector.
- Filter cards on aggregates (`aggregateFilterCard`, `aggregateFilterField` in `filters.js`): a filter zone on a measure
  or an aggregated calc is a range selector (MIN and MAX of the beast mode, no
  column aggregation) or a dropdown on an aggregated dataset beast mode: the calc's own, or a new plan beast mode
  `AGG(<expression>)` named like Tableau's pill (`SUM(Sales)`, key `<dataset>.filter-<field>-<agg>`). Verified live
  on scratch cards: Domo applies such a card's selection as a page filter with `aggregated: true`, which every card runs as
  HAVING at its own grain; a range selector on a column with `aggregation: 'SUM'` emits the filter without it (WHERE), and a
  card beast mode is refused ("Filtering ... is not supported. Consider sharing the Card Beast Mode to the DataSet"). The
  card groups by the zone's worksheet card and carries its filters, so its range is over that sheet's marks (without a
  grouping it is the grand total, MIN = MAX). Its CARD item is scoped (`STANDARD`, `selectedCardUrns`) to the data cards of
  the Tableau filter's sheets: unscoped, the HAVING filter emptied every other filter card. Table
  calculations, relative-date and categorical date aggregates keep the `layout.filter-aggregate` warning and no card.
- Zones Tableau never draws (`withoutHiddenZones`, run by convertWorkbook and planPages): a zone whose rect, or an ancestor
  container's, has no width or height is dropped from the IR dashboards with no issue.
- Filter card sorts (`filterCardFor`): a dropdown, checkbox or radio filter card sorts by its own column ascending;
  on text that is a card formula `<field> (natural order)`, the natural-order key of `MIN(<field>)`
  (`naturalOrderKey(expr, { perGroup: true })`, one pattern match per listed value), so "2023 P7" lists before "2023 P10".
  Range and date selectors need none. A dropdown for Tableau's "Multiple Values (dropdown)" (`checkdropdown`, or no mode) gets
  `allow_multi_select: 'true'`.
- Filter card display: every filter card has `allowTableDrill: false` and its CARD item `hideWrench: true` (App Studio's
  "Presentation mode" unchecked). A filter on a Tableau integer dimension with no thousands separator in its `default-format` (`FieldIR.defaultFormat`;
  `number-format.js` `plainInteger`, not bins) gets `PLAIN_INTEGER_FORMAT` (`{ type: 'number', format: '#', commas: false, percentMultiplied:
  true, precision: 0, abbreviate: false }`, the editor's format) on its column, so FY lists "2026" as in Tableau.
  Worksheet cards put the same format on such a dimension column (table, pivot or chart axis). A filter card made in the editor
  has no groupBy; t2d keeps `groupBy: [<column>]`, because without it the selector reads 500,000 raw rows (render `limited`)
  and one whose sort is aggregated, one row.
- Filter cards accept the page's filters: the Default filter view narrows their lists and ranges. `acceptFilters: false` for
  context and "All values in database" filters was reverted at the user's request; `ZoneIR.values` is still parsed.
- Page default filters (`pageDefaultFilters`, run by convertWorkbook after planPages): card quick filters start empty
  (`CardPlan.quickFilterDefaults` keeps the Tableau selections), because a default on a card's quick filter does not narrow
  the view's filter cards (a date range selector listed every date while only the selected range had rows). A selection that every card of the view on that dataset carries becomes a `PagePlan.filters` entry (`PageFilterPlan`:
  column, or the beast mode's name as the filter bar saves it; LEGACY; the dataset; `sourceCard` the view's filter card on that
  column), written by push as the view's "Default" filter view. A page filter reaches every card of the view on its dataset,
  and an App Studio view ignores a saved filter's `affectedCardUrns` (verified live: a card left out of them still got the
  filter), so a selection only some of those cards carry, or that differs between them, stays the default of their quick
  filters (`layout.page-default-partial`), as does one on a beast mode with no name (`layout.page-default` warning).
  The dedupe key of the view's filters includes the dataset, so each dataset of a view gets its own entry.
- Filter scope (IR 13; `dashboardFilterScopes(ir)` in `filters.js`, by dashboard): a filter zone's scope is its sheet plus the
  dashboard's sheets holding a copy of the filter, by `group` on the same field (or the same caption and derivation, for a
  related datasource whose pill id differs) or by the same `shared` view and pill id; zones on one field whose scopes share a
  sheet merge. `planCards` tracks each in-scope sheet's own fixed copy (`toCardFilters` `trackPillIds` / `origins`) as
  `CardPlan.scopedFilters` (with the selection as a quick filter default), and `quickFilterDefaults` carry the `pillIds` of their
  controls. `pageDefaultFilters` groups defaults by dataset, column and scope: it promotes one when every card of the scope on
  the dataset selects the same (a selection over 50 values or with Null has no default, so it stays fixed). When cards on the
  dataset are outside the scope, the default still goes to the view, at the user's request, and the view's filter card on the
  column is scoped as the user set it up by hand: its CARD item gets `interaction: { type: 'STANDARD', config: { openInNewWindow:
  false, allowCardToCardInteractions: true, selectIndividualCards: true, selectedCardUrns } }` with every card item of the view
  but the data cards outside the scope (other filter cards, text cards and itself included), and the `PageFilterPlan` gets
  `affectedCards`, the same keys (info `layout.page-default-scope`). With no filter card on the column, or one already scoped to
  other cards, the selection stays on the cards (`layout.page-default-partial` warning). A promoted filter's fixed copies are
  removed from a card once every view holding the card promoted it; `scopedFilters` is removed from the plan. A merged stack
  card is in a scope through its section sheets; a scoped copy on a dataset where no card shows the filter (the shown sheet
  went into a stack) gets the shown default and its own page filter. A stack default whose
  dataset has no filter card takes the view's filter card on the sheets' dataset as `sourceCard`, unless a page filter on that
  dataset already uses it. An IR before 13
  has no scopes, so convert keeps the behavior above.
- `toQuickFilterControls` folds a second shown filter on a control's column into it (a selection wins over All, two member
  lists intersect); one it cannot fold stays a fixed card filter.
- Which filters are card quick filters (`shownFilters` in `cards.js`): from IR 15, only the sheet's own filter cards
  (`WorksheetIR.quickFilters`, their `mode` sets the display type), capped at `MAX_SLICERS` (20, `filter.slicer-count` keeps the
  rest fixed); before 15, every filter a dashboard shows for the sheet, and convert adds
  `convert.ir-outdated`. A quick filter that a dashboard filter card controls (shown for the sheet, or in its scope) lifts its
  selection into `quickFilterDefaults` as before; one only the sheet shows keeps it on the control. A filter a dashboard shows
  but the sheet does not (`dashboardOnly`, info `filter.dashboard-only`) has no control and no fixed filter while a view takes
  its selection: its default carries `fixed`, the card filters `toCardFilters` built for it, and `pageDefaultFilters` puts
  them back on the card (`restoreDefault`) when a view keeps the selection on the cards or the card is on no view, so the
  fixed filter never sits under the view's filter card on the same column. Without a default (All, Null kept, member ranges)
  it is skipped like a quick filter, except aggregates and member ranges. A Top N filter is never skipped for a control.
- Compact (phone) template: every item full width in phone order (`compactOrder`), as the editor adds compact items.
- Phone (compact) order: a custom Tableau phone layout sets it, with zones it leaves out at the end (`layout.phone-layout`);
  otherwise title headers, then filters and controls (two per row, 4 rows high), then the rest in reading order.
- Parameter controls become VARIABLE layout items (dropdown, radio buttons, slider, text box or date picker, at least 10
  columns wide) starting at the Tableau value and named after the zone title, else the parameter caption; a second
  control for the same parameter on a page is dropped (info), so the first zone's title wins.
  `src/convert/variables.js`: `resolveParameterModes` (which parameters stay inline constants: unused, or a calc that
  converts worse as a variable), `parameterVariableNames` (a parameter named like a calc gets the variable name
  `<name> (Parameter)`, `(Parameter 2)` on a further clash, since `bindVariables` binds backticked names), `variableControl`, `siteVariables`, `bindVariables`,
  `parameterAliases`: a Domo control value has no label, so a
  list parameter whose aliases differ from its values (0 All, 1 Today, ...) is a STRING variable over the
  aliases, its default and page overrides the current value's alias, and each beast mode reads it as `(CASE <variable>
  WHEN '<alias>' THEN <value> ... END)` (`aliasedReference`), so the formulas keep Tableau's values. Repeated aliases keep
  the raw values (the old note);
  `src/domo/variables.js`: default controls, page controls, the duplicate-name check. Every control carries `format: { type:
  'default' }`, as the editor saves one: opening a variable without it in the Beast Mode editor threw "Cannot read properties of
  undefined (reading 'type')" and the modal would not open again until a reload.

`sql-format.js`: `formatSql(sql, { statement })`, `formatPlanSql(plan)` (run last by convertWorkbook). Beast Modes, card formulas,
Magic ETL tile expressions and SQL DataSet View queries are laid out in the style of the sql-formatter defaults Domo's Monaco SQL
editors use (the Beast Mode editor has no format action and saves whitespace as typed): 2-space indent, CASE with one WHEN / ELSE
per line and END under it, a parenthesized expression over 50 characters or holding a CASE one argument per line, AND / OR leading
the lines of a long condition, OVER / FIXED one clause per line; statements one clause per line. Unlike sql-formatter it keeps a
function call tight (`DATE_ADD(`) and `INTERVAL (x) DAY` spaced. Only whitespace between tokens changes (keywords and function
names upper-cased); the output is re-tokenized and compared with the input, and SQL with comments, dollar quotes, unbalanced
parentheses or CASE, or over 64 KiB is left as is. The plan holds the formatted text, so push hashes stay stable; the first push
after the change updates every beast mode and card whose SQL changed.

`index.js`: `convertWorkbook(ir, { manifests, mappings, options, emitter, shared }) → DomoPlan`
(planDatasets, planBlends, resolveParameterModes, materializeCalcs, planCards with the materialized IR, planCrosstabStacks, planPages, then
`formatPlanSql`). `resolveConvertOptions` defaults the
root page (or app) title to `namePrefix` + workbook name and `target` to `'app'`; the plan records it as `DomoPlan.target`
(a plan without one is pushed as pages) and the AppPlan as `DomoPlan.app`.

`select.js`: one selection model for extract, convert, push, unpush and the library:
`Selection = { dashboards?, worksheets?, datasources?, kinds?, keys?, sampleRows?, schemaOnly?, allBeastModes? }`.
- `normalizeSelection(sel)`, `hasObjectSelection(sel)`, `parseKinds(v)`, `keyMatcher(keys)`, `matchNames(patterns, names, what)`
  (case-insensitive, `*` globs, names with leading or trailing spaces also match trimmed, "A,B" split only when the whole
  string matches nothing; unknown names throw `SelectionError` listing the valid names), `selectIrDatasources(ir, sel) →
  { datasourceIds, ... }` (extract), `dashboardWorksheets(dashboard)`, `mentions(text, beastModeOrVariable, { columns })`
  (a backticked name that is a dataset column, `planColumns(plan)`, is not a mention, as in `bindVariables`),
  `closeBeastModes(beastModes, isUsed)` (the accepted beast modes plus those their expressions reference on the same
  dataset, transitively; shared by `selectPlan` and `usedBeastModes(plan)`, the convert pruning above).
- `selectPlan(plan, sel, { ir }) → DomoPlan` (pure): keeps `plan.app` while any of its views is kept; selected dashboard pages (a
  story view is selected by the story name, `selectIrDatasources` too) with their layout and filter cards,
  selected worksheet cards (and the merged crosstab card of a selected section sheet), unsupported cards of a selected dashboard's worksheets that no layout places (only so
  push can delete an earlier copy; they keep nothing else), the pages above them as containers (no layout or filters), the datasets the cards
  target and their inputs (dataflows with all outputs, views, upload inputs), the beast modes the kept cards
  reference (legacyId or backticked name) plus the ones those reference (all with `allBeastModes`; all for a
  selected datasource), and the variables used. Records `plan.selection` (resolved names, container pages, counts).
  `kinds`/`keys` never prune here: push and unpush apply them.

### Domo access: `src/domo/`

`client.js`: `createDomoClient({ instance, accessToken }, { emitter }) → { instance, baseUrl, request(method, path, opts), get, post, put, del }`
(`path` excludes `/api`; headers `X-DOMO-Developer-Token` and `Accept-Language: en-US`, overridable per call: the v4
layout endpoints answer 400 `range=-*` without Accept-Language.)

| Module | Exports |
|---|---|
| `datasets.js` | `createDataset(c, { name, description, schema }) → id`, `updateSchema(c, id, schema)`, `uploadCsv(c, id, file, { action, partRows, emitter }) → { rowCount }`, `getDataset(c, id)`, `waitForReadable(c, id, { columns })` (indexed schema plus a data version; push waits on it for Cloud Amplifier tables and new or changed SQL views before dataflows read them), `deleteDataset(c, id)` (stream included), `listDownstream(c, id) → { dataflows, datasets }` (lineage children) |
| `beastmodes.js` | `validateExpressions(c, datasetId, items) → Map<key,{ valid, message, dataType }>`, `createBeastMode(c, spec)`, `updateBeastMode(c, id, spec)`, `listDatasetBeastModes(c, datasetId)`, `deleteBeastModes(c, ids, { unlink })` (bulk; a linked template is refused, so `unlink` passes each template's links: the visible one is deactivated and other non-template links removed in the same request) |
| `cards.js` | `createCard(c, body, { pageId }) → { id, urn, response }`, `updateCard(c, id, body)`, `getCardDefinition(c, id)` (`dynamicText: true`, so `definition.title` is null and the title is in `dynamicTitle`), `toWriteShape(definition)` (a `title` also rewrites a TEXT-only `dynamicTitle`, which Domo prefers for KPI cards; one with a VARIABLE_VALUE item is sent as it is, without `title`), `cardTitle(definition)`, `deleteCard(c, id)`, `listDatasetCards(c, datasetId)` (drill views are not listed), `createDrillView(c, rootId, body)`, `updateDrillView(c, rootId, drillId, body)`, `listDrillViews(c, rootId) → [{ id, urn }]`, `listPageCards(c, pageId)` (pages and App Studio views), `mayHaveCreated(err)` (5xx, timeout or a connection lost after sending), `findCreatedCard(c, { pageId, titles, since, known })`: push recovers a card (or drill view) that a create answered with 5xx or a timeout but saved anyway (apiContent answers 500 when icebox times out saving the card's formulas), adopting the one new card of its title on its page that is not in state and updating it to the plan; several fail with their ids |
| `pages.js` | `createPage(c, { title, parentPageId }) → pageId`, `getPage(c, id)`, `ensureLayout(c, pageId) → layout`, `writeLayout(c, pageId, layout)` (lock, update, unlock, wait; works on app views, whose ids are page ids; a lock held by another user, `WL002`, throws `LayoutLockedError` with `code: 'push.layout-locked'`; a lock that lapsed before the PUT, 403 `WL003`, is taken again once), `deletePage(c, id)`, `getSubpageIds(c, id)`. Classic page calls fail on views ("Cannot delete Report or App page"), so push and unpush route on the state entry's `extra.container` |
| `dataflows.js` | `createDataflow(c, def) → dataflow`, `updateDataflow(c, id, def)`, `runDataflow(c, id) → execution`, `waitForExecution(c, id, execId)`, `deleteDataflow(c, id)` (outputs stay) |
| `views.js` | `createFusion(c, body) → { dataSourceId }`, `updateFusion(c, id, body)`, `createSqlView(c, body)` / `updateSqlView(c, id, body)` (`POST`/`PUT /query/v1/views`, unconfirmed on an instance) |
| `streams.js` | `createConnectorStream(c, spec) → { streamId, datasetId, transportSource }`, `updateConnectorStream(c, streamId, { configuration, accountId })`, `runStream(c, streamId)`, `findTemplateStream(c, providerKey)`, `templateConfiguration(stream)`. Transport order: `templateStreamId`; explicit `connectorId` + `connectorVersion` (mappings.accounts extras); a CONNECTOR stream of the same provider found with `POST /data/ui/v3/datasources/search` (`dataProviderType` term filter), whose METADATA options also seed configuration the plan does not set (per-dataset values, CONNECTOR_RESULT entries and account ids are never copied); `spec.defaultTransport`; the provider's `defaultConnectorId` with version '0'. A missing major version is read from `GET /data/v1/connectors/{id}` |
| `cloud-amplifier.js` | `listIntegrations(c) → Integration[]` (`{ id, engine, name, database?, defaultSchema?, host?, port?, writeable, initialized, serviceAccountId? }`), `getIntegration(c, id)`, `getSnowflakeAccount(c, serviceAccountId) → { account?, providerKey?, reason? }` (reads only `account`; failures keep the HTTP status, never the body; never throws), `resolveSnowflakeAccounts(c, integrations) → Map<id, WarehouseAccount>`, `parseSnowflakeAccount(value)`, `compareSnowflakeAccounts(a, b)`, `listDatabases/listSchemas/listObjects(c, id, ...)` (500-row pages), `getObjectColumns(c, id, db, schema, object)`, `registerTables(c, integrationId, tables) → [{ datasetId, status, alreadyRegistered, afterRetry? }]` (mutating; tables may carry `displayName`; results paired by table name; new and old response formats, ALREADY_REGISTERED reuses the id named in the message, cold starts retried 3x 30 s apart), `dataProviderKeyFor(integration)`, `isTransientByosError(err)`, `withTransientRetry(fn)` |
| `accounts.js` | `listProviders(c, { name }) → [{ key, name, defaultConnectorId? }]`, `listAccounts(c, { provider }) → [{ id, name, providerKey, valid? }]`, `searchAccounts(c, provider)` (`POST /search/v1/query`, entity `account`, `dataproviderkey_facet` term filter; also finds accounts not shared with the token user; falls back to `listAccounts`), `getAccountSettings(c, id, { providerKey }) → { id, name?, providerKey?, valid?, settings }` (never `unmask`), `safeAccountSettings(raw)` (allowlist `ACCOUNT_SETTING_FIELDS`: host, hostname, server, server-name, instance-name, port, database, databaseName, warehouse, account, role, username; masked values dropped; every other field may be a credential and is never kept), `normalizeHost`, `compareHosts(a, b) → 'exact'\|'short'\|false` (short name vs FQDN), `matchAccounts(connection, accounts, { family, compareSnowflake }) → { status: 'match'\|'candidates'\|'none', matches, others }` (host, `server-name` of a federated account, or Snowflake account; confident when port and database do not differ). All read-only |
| `federated.js` | `federatedProviders(class)` (Tableau class to `*-federated` keys), `listAdapters(c)`, `listDatabases(c, accountId)` (`GET /federated/v2/config/accounts/{id}/databases`, the whole tree; connects to the database), `getTableColumns(c, accountId, { catalog, schema, table })` (Domo types), `createFederatedDataset(c, accountId, spec) → id` (`POST /federated/v1/config/accounts/{id}/datasources`; mutating), `getFederatedDataset(c, id)`, `updateFederatedCacheTtl(c, id, ttl)` (each update adds a schema version), `deleteFederatedDataset(c, id)` (`DELETE /data/v3/datasources/{id}`), `findInTree(tree, target)`, `treeCatalogs(tree)` |
| `calendars.js` | Read-only: `getInstanceCalendarTable(c)` (customer state `domo.calendar.tablename`, '' = none), `queryStandardCalendar(c, dates) → Map<date, { Date, Year, Quarter, QuarterOfYear, YearStart }>`, `getIntegrationFiscalCalendar(c, id) → { name, calendar?: { database, schema, table } }` |
| `probe.js` | `probeCapabilities(c, { datasetId }) → { basic, fixed, window, windowValidated, ... }` (`window` from a read-only query, since validateFunctions accepts analytic functions queries reject), `whoAmI(c)`, `readFeatureFlags(c) → { customer, features: Map<name, enabled> }` (`GET /content/v3/customers/current/name`, then `/content/v3/customers/{name}/features`), `appStudioStatus(c) → { available, customer, flags }` (`available` = `data-app` on; `flags` maps `APP_STUDIO_FLAGS` to on, off or absent) |
| `apps.js` | App Studio (`/content/v1/dataapps`): `createApp(c, { title, description, navigation?, theme? }) → { app, id, defaultViewId }` (create honors the navigation settings and the theme, verified live), `getApp(c, id)` / `updateApp(c, id, body)` (`includeHiddenViews=true`; the PUT replaces the whole app, so `body` is a GET merged with `mergeAppSettings(current, { title, description, navigation }, theme?)`; `userAccess`, `navigations`, `views`, `persistSettings` are dropped), `hasAppSettings(app, settings, theme?)` (pure), `listThemes`, `findTheme(themes, name)`, `applyThemeOverrides(theme, overrides) → { theme, notes }` (pure: a copy named `<base> (Tableau)`, new colors appended as CUSTOM up to c99, existing THEME/CUSTOM colors reused, backgrounds and borders by color reference, the automatic font color's dark or light hex, font families; `table`: the mapped table style's `rowColor` and `headerBackgroundColor`, `alternatingRowColorEnabled` / `alternatingRowColor`, `totalRowBackgroundColor`, `subtotalRowBackgroundColor`, `tableBorderType` / `tableBorderWeight` 1 / `tableBorderColor`, and the header, total and subtotal font colors set to the automatic color so they read on the new fills; item table styles copy it), `applyItemStyles(theme, itemStyles, original) → { theme, ids, skipped, notes }` (pure: item styles in the card and table styles no mapping uses, copied from the mapped chart or table style; Domo keeps 8 card and 3 table styles, so none are added; a null background keeps the built-in's, padding adds to the base, 16 at most), `createAppPalette(c, appId, { name, json })`, `updateAppPalette`, `listAppPalettes(c, appId)`, `deleteAppPalette` (`/brandkit/v1/chartColorPalettes/APP`, body `appPaletteBody`), `clearStyleOverride`, `setSavedThemes`, `createView(c, appId, { title }) → { viewId, layoutId }`, `renameView` (raw `text/plain` body), `deleteView`, `setViewVisible`, `getNavigation` (`includeHidden=true`, sorted by navOrder), `reorderNavigation` (full list), `buildNavigation(nav, views)` (pure: t2d views in plan order in the slots t2d's views hold; views t2d did not create and fixed items keep their slots and are sent as read; navOrder from 1), `setLanding`, `putPersistSettings`, `deleteApp` (permanent), `searchApps(c, text)` (admin summary title search), `appViewIds(app)`, `visibleViewIds(app)`, `appUrl(instance, appId, viewId?)` |

### Pipeline: `src/pipeline/`

- `workspace.js`: `openWorkspace(root)` → path helpers per workbook slug, `sharedPaths(luid)` (`{ dir, manifest, beastModes }`),
  `batchFile(stamp, ext)`, `readJson`/`writeJson`, `loadMappings()`
- `runs.js`: run logs. `writeRunLog(ws, slug, stage, log, { keep = 50 })` writes `workbooks/<slug>/logs/<stage>-<YYYY-MM-DDTHH-MM-SSZ>.json`
  (`-1`, `-2` for runs in the same second; `runLogName`, `parseRunLogName`) and keeps the newest `keep` per stage;
  `listRuns(ws, slug, { stage })` (oldest first: stage, file, startedAt, finishedAt, ms, ok, instance, counts, error; `t2d status --runs`);
  `latestRunLogs(ws, slug)` (the current `<stage>-log.json`, else the newest history log; the report's Timing section).
  Extract, convert, push and unpush each time their steps with a `Timer` (`src/util/timing.js`): every finished step is a
  `timing` event (`data`: `{ step, startedAt, ms, ...meta }`, then `step: 'total'`; the CLI shows them with `--verbose`) and
  the run's log gets `timing: { startedAt, finishedAt, ms, steps }`. A dot nests a step in its parent (`datasets.upload`
  inside `datasets`), so steps overlap and do not sum to the total. Extract steps: `tableau.sign-in`, `tableau.find-workbook`,
  `workbook.download`, `workbook.parse`, `tableau.metadata`, `datasource.definition`, and per datasource `datasource` (strategy,
  tables, rows, CSV bytes) with `datasource.download`, `.tds-download`, `.unpack`, `.hyper-export`, `.csv`, `.vds-export`, `.view-csv`
  (`extractData({ timer })`). Push phases: `preflight`, `datasets` (`datasets.upload` with rows and bytes, `datasets.stream-run`
  with `waitMs`), `dataflows` (`dataflows.run` with `waitMs`), `variables`, `beastmodes`, `app` (with the theme), `views` or `pages`,
  `cards`, `layouts` (`images.upload`), `filter-views`, `navigation`, `retired-beastmodes`. Convert: `read`, `convert`, `select`, `write`.
  Unpush: `preflight`, `cards`, `apps-pages`, `dataflows`, `datasets`, `beastmodes-variables`. Dry runs are timed (in
  `push-dry-run.json`) but get no history log. Extract writes `extract-log.json` and convert `convert-log.json`; push and unpush add
  `timing` to their existing logs (and set `finishedAt` from it). A failed extract still writes its history log (`ok: false`, `error`).
- `state.js`: `loadState(ws, instance)`, `saveState(ws, state)`, `getEntry(state, ref)`, `setEntry(state, ref, entry)`
- `extract.js`: `extractWorkbook({ config, workbook | file, project, dataStrategy, includeExtract, metadata, domoLookup, selection, client, sharedCache, refreshShared, unmapped, decide, dryRun, decisionsOnly, emitter }) → { slug, ir, manifests, timing, decisions? }`.
  Data decisions (`unmapped`, default `'ask'`; `'export'` keeps the old fallback; `'fail'` never calls `decide`): under
  auto every datasource is first resolved with `planOnly` (no snapshot download). Pending decisions get the Tableau
  REST connection details (`listConnections`: server, port, user name, `embedPassword`; never a password) and connector
  account candidates (`connectorAccountLookup`, skipped when `connectorBlocked`) and federated account candidates
  (`federatedLookup.forConnection`: the provider's accounts by search, their allowlisted `server-name`, a host match
  confirmed by a database browse that lists the Tableau database; skipped when `federatedBlocked`), become `DataDecision`s (`decisions.js` `completeDecision`, merged per
  key: the published luid, else the caption), are emitted as `decision` events, and go to `decide(decisions)` at once.
  `recordAnswers` writes the answers into mappings.json (the file as written; an accounts or cloudAmplifier entry with
  the same `match` is replaced); unanswered ones throw `DataDecisionError` (`code: 'extract.data-decision-needed'`,
  `decisions`). `choicesFor(decision)` leaves out `account` when `connectorBlocked` and `federated` when
  `federatedBlocked`; the suggestion order is a single integration, export when the connector is blocked, a matching
  connector account, then a matching federated account. Answered and deferred datasources are then extracted (account →
  connector, federated account → federated, integration → cloud-amplifier, dataset → existing, export/none → the gate again with `snapshotOnly`). A datasource whose previous
  manifest was a snapshot counts as decided. `dryRun` or `includeExtract: false` never ask: pending datasources get a
  `none` manifest with warning `data.decision-pending` and the ready-to-paste entries. `decisionsOnly` returns after
  resolving (no IR, logs or stale-manifest cleanup) for `migrateBatch`, which calls it for every workbook
  (`includeExtract: false`), merges the decisions (a shared datasource is asked once), asks once, then migrates.
  A published datasource with a resolved luid (`isSharedDatasource(ds, strategy, pkg)`: strategy auto, existing,
  cloud-amplifier, published-extract, vds or none, and no extract packaged in the workbook) is extracted once per
  site into `datasources/<luid>/` (`datasources/<luid>/sample-N/` for samples) with `extractData({ slug: 'datasource',
  skipViewCsv: true })` and reused while its Tableau `updatedAt` (`findDatasource`), the strategy, the sample size
  and mappings.json are unchanged (`refreshShared` forces it; `sharedCache` shares results within a batch). The
  shared manifest records the published field definitions the extraction merged (`shared.fields`), replayed on
  every workbook's datasource (`applySharedFields`). The workbook manifest gets `shared` and table paths relative
  to the workbook directory. When nothing shared works under auto, the workbook's own views are tried (view-csv,
  not shared). `client` is a signed-in TableauClient to use and not sign out.
  A selection limits data extraction to the datasources it uses (other manifests are kept) and is stored in
  `metadata.json`; `selection.sampleRows` truncates every table CSV to N rows (`manifest.sampled`, issue `data.sampled`).
  With Domo settings and `domoLookup` (default true) it makes read-only Domo calls for Cloud Amplifier
  matching (`cloudAmplifierLookup`: the integration list once per run, cached browsing) and federated matching
  (`federatedLookup`: the `federated-views` flag once, cached account browses).
  For every published datasource with a luid, extract merges the published definitions (`mergePublishedDefinitions`)
  whatever the data strategy, including `none`, unless `publishedFields` (CLI `--no-published-fields`) or `metadata` is
  false. Each .tds is downloaded once per luid (`sharedCache` in a batch) and saved as
  `datasources/<luid>/definition.json`, reused while Tableau's `updatedAt` is unchanged (`refreshShared` downloads it
  again, as does a change to the workbook parser: the file stores `parser`, `definitionParserStamp()`). Published parameters the workbook lacks are added to `ir.parameters` (`extract.published-fields`,
  `extract.published-parameters`; `extract.published-fields-unavailable` when the download fails).
- `convert.js`: `convertStage({ config, slug, options, selection, full, emitter }) → DomoPlan` (writes plan.json, report.md;
  reads and rewrites `datasources/<luid>/beastmodes.json` for every shared datasource, from the unpruned plan);
  prunes with `selectPlan` (the selection given, else the one extract ran with, unless `full`)
- `push.js`: `pushPlan({ config, slug, dryRun, parentPageId, only, force, selection, emitter }) → PushSummary`.
  A dry run writes nothing to Domo, needs no Domo token, saves no state and writes `push-dry-run.json`; its only calls are
  the read-only fiscal calendar checks, when the plan needs a calendar and a token is set.
  `selection` prunes the plan (selectPlan); `selection.kinds` (or `only`) and `selection.keys` limit what is
  written, and `missingDependencies(plan, writes, exists)` makes push throw before any write when a written object
  needs one that is neither written nor in state (existing-strategy datasets are seeded from the plan; variables a beast
  mode or card reads through `DOMO_BEAST_MODE(<legacyId>)` count).
  `schemaOnly` (and a dataset with no data file) uploads a header-only CSV instead of rows, once per schema
  (`extra.dataHash = 'header:<schemaHash>'`, never over real rows), because Domo cannot build a card on a
  dataset that never had an upload ("could not load schema for datasource"). A connector stream is not run: its
  dataset keeps `extra.streamPending` until a push without `schemaOnly` runs it (a failed run stays pending and is
  retried), and cards on a dataset with a pending stream are skipped under `schemaOnly`.
  `sampleRows` uploads a temporary N-row copy (its data hash
  differs, so a later full push re-uploads). Every entry a push writes is stamped `extra.workbooks: [slug]`.
  `adoptPreviousKeys(plan, state)` first moves state entries recorded under a dataset, dataflow or beast mode's
  `previousKey` to its key (objects pushed before their published datasource was shared are updated, not duplicated).
- `unpush.js`: `unpushPlan({ config, slug, dryRun, selection, emitter }) → UnpushSummary`; `planGraph(plan)` (who
  depends on whom; views and `navigation:` depend on `app:`, and go with it; a layout's BUTTON and click action targets are links,
  not dependencies, so a linked view can be unpushed alone; a view left in place that still links to a deleted view gets
  `unpush.links-stale`, naming the layout to push again). Sections, tabs, buttons and click actions add no state keys: they
  live in the layouts, the workbook theme in the app (its saved themes are still cleared before the app delete), and no child
  views are created. Deletes only state entries in scope (plan objects, plus entries stamped with the slug when no
  object selection is given), removes each entry once deleted (404 = gone), writes `unpush-log.json`
  (`unpush-dry-run.json`). A card's drill views (`extra.drillViews`) go with it (Domo deletes them with the card; the card's
  action notes them), and their beast mode links no longer keep a beast mode. Order: cards, App Studio apps (with their views; see "App Studio target" below), pages
  (deepest first, layouts with them), dataflows, datasets (views and
  outputs first; beast modes on a deleted dataset go with it: Domo unlinks them asynchronously, so each is polled
  with `GET /query/v1/functions/template/{id}` until 404, `templateWait` default 5 s up to 3 min, and one still
  there with no remaining links is deleted), remaining beast modes (bulk delete) and variables (one at a time).
  Never deletes `existing` datasets, already-registered Cloud Amplifier tables, or entries another workbook shares.
  Skips an object while a remaining plan object depends on it, or when the instance has cards on the dataset /
  subpages under the page that this run did not delete, or when a page or view this run does not delete shows the card
  (`listCardPlacements`: `GET /content/v1/cards?urns={id}&parts=adminAllPages`, warning `unpush.card-foreign-placement`; real runs only).
- `show.js`: `describeWorkbook({ config, slug })` → dashboards (with worksheets), worksheets, datasources (with
  data strategy) and plan keys (`t2d show`)
- `report.js`: `renderReport({ ir, plan, push, manifests, runs }) → markdown`: the workbook summary and follow-up checklist
  from `migration-report.js` first, then the detailed Counts, Datasets, Beast Modes, Cards, app or pages and Issues
  (with codes) sections; `runs` (`latestRunLogs`) adds a Timing section (each stage's latest run, the 10 slowest steps)
- `migration-report.js`: the stakeholder report. `summarizeWorkbook({ slug, ir, plan, push, manifests, runs, batch }) →
  WorkbookSummary` (pure): Tableau and Domo links (app and view links from `push.app`, card links
  `https://<host>/kpis/details/<id>`, dataset links `https://<host>/datasources/<id>/details/overview`, ids from ok push
  actions), stage status (`done | failed | not run | dry run`; a batch row's `status` and `error` say which stage
  failed when files are missing), card counts by status, the data strategy per Tableau datasource (manifest strategy,
  else the plan's live dataset strategy, bucketed into existing, cloud-amplifier, federated, connector, snapshot,
  export, none, unused), timing (batch `durationMs`, else the latest stage logs) and `followUps`. Follow-ups come from
  every IR, manifest, plan and push issue through `describeIssue` (`issue-text.js`: `ISSUE_TEXT[code]` gives the plain
  text and an optional level; otherwise error = must, warning = check, info = info, which is only counted; an unknown
  code keeps its message), placed by the issue object (dashboard: its view; worksheet or card: each card's first view,
  the card as subject; anything else: the whole workbook) and merged per level, group and code, plus synthesized
  items (push failures, not pushed or dry run only, one-time data copies, unsupported Beast Modes and cards no issue
  covers, Beast Mode features, connector schedules, Cloud Amplifier traffic, sharing and PDP, side-by-side check).
  Must items about an unsupported Beast Mode carry `formulas` (`calc-formulas.js`: `untranslatedCalcs({ ir, plan,
  issues })` gives the name, Tableau datasource, the formula with field and parameter ids replaced by captions by
  `readableFormula` (unresolved references kept), the reasons from the issues on its field, and the untranslated
  calcs it references, transitively); calcs that share a name are labeled with their datasource. Markdown renders
  each formula as a fenced block indented under the item (fence longer than any backtick run in the formula), HTML
  as `<pre><code>` inside the item's `<details>`; report.md shows them too, through `renderFollowUpsMarkdown`.
  Sorted must before check, then whole workbook before views in nav order. `buildMigrationReport({ workbooks, scope })`
  adds totals; `loadMigrationReport(ws, { batch | workbooks | all })` reads the workspace (a batch row without a
  workbook directory becomes a failed summary); `renderMigrationMarkdown` and `renderMigrationHtml` (self-contained,
  inline CSS, no scripts) render the same model; `writeMigrationReport(ws, report, { file, html })`;
  `migrationReportFile(ws, batchFile)` names `migration-report[-<timestamp>].md`. `t2d report --batch | --workbooks | --all`.
- `migrate.js`: `migrateWorkbook(opts)` runs all three stages (`client`, `sharedCache`, `refreshShared` pass to extract) and returns `timing`
  (steps `extract`, `convert`, `push-preview`, `confirm`, `push`; `stages.extract` and `stages.push` hold their step timings; batch rows get `stageMs`)
- `batch.js`: `migrateBatch({ config, project | all | workbooks, ...migrateWorkbook options, sink, deps }) → BatchSummary`:
  one Tableau sign-in, `listWorkbooks(client, { project })` (filtered by `workbooks` names or luids, globs), then
  `migrateWorkbook` per workbook with a shared `sharedCache`; failures are recorded and the batch continues; a
  `SelectionError` marks the workbook `skipped`. Writes `batch-<timestamp>.json` after each workbook and
  `batch-<timestamp>.md` (`renderBatchReport`) and `migration-report-<timestamp>.{md,html}` (`summary.migrationReport`;
  a failure to write it only warns) at the end. `t2d migrate --project X | --all [--workbooks ...]`.
- `verify.js`: `verifyWorkbook({ config, slug, tolerance, keys, emitter }) → VerifySummary` (`{ ok, cards, counts, sampled? }`), read-only on both sides:
  Tableau view data (`views/{id}/data`, saved filters) against the pushed card render
  (`renderCard(domo, cardId)`, `renderData(render)`); `compareCardData({ tableau, domo, tolerance, sampled })` pairs
  columns by label, pivots Measure Names/Values, compares row counts, members and measure totals, and gives `ok`,
  `differs` or `not comparable` per card. Sampled datasets skip totals: `sampledRows(plan, datasetKey, manifests, state)` reads
  extract-time sampling (plan, manifests) and push-time `--sample-rows` (`extra.sampled` on the dataset's state entry), on the
  card's dataset or any dataset a dataflow or view builds it from. Writes `verify.json`. `t2d verify`.

`src/index.js` re-exports the public API above.

## Push order and idempotency

1. Datasets: create (or reuse the state entry, or the mapped existing id), set the schema,
   upload CSV parts (a header row only when there are no rows to send), commit with `index: true`, poll the index status. Cloud Amplifier datasets are
   registered instead (an already registered table reuses its dataset, recorded with
   `extra.alreadyRegistered` so cleanup leaves it alone), then the indexed schema is polled. Dry runs show
   them as `register` actions. Federated datasets are created with the account's columns
   (`getTableColumns`, `createFederatedDataset`, state `extra: { strategy: 'federated', accountId, table, cacheTTL }`);
   a recorded one is reused, and only a changed `cacheTTL` is written (`updateFederatedCacheTtl`); the same table on
   another account is a strategy change. Unpush deletes them like any dataset (`DELETE /data/v3/datasources/{id}`).
2. Dataflows and views: create or update, then run and wait. Output dataset ids come from the response.
3. Variables (Tableau parameters in `variables` mode), so beast modes that use them validate, with their default
   controls. A name taken on the instance gets " (Tableau)" (the page controls keep the caption); a second workbook reuses the variable without changing its
   default. Beast modes and card formulas reference them as `DOMO_BEAST_MODE(<id>)`; cards that use one get a card control.
   A variable found on the instance by legacyId (not in this workspace's state) is adopted (`extra.adopted`): unpush only
   forgets it, and also skips a variable another beast mode still uses. A state entry whose variable is gone (404) is
   recreated, so its beast modes and cards are rewritten with the new id; a card update Domo then refuses (500, a card
   formula still depending on the deleted template) has those card formulas set to `MIN(1)` and is retried once. (Another
   workspace's unpush can delete a shared variable, and every card using it then fails to render with "no function template
   found for key".)
4. Beast modes: `validateFunctions` in one call per dataset, then create or update by legacyId.
   Failed validation is recorded as an issue and that beast mode is skipped; cards that need it
   are pushed without that column and flagged. After the app, on a whole-plan push with beast modes and cards
   (`retired-beastmodes`), a `beastmode:` entry of this workbook no longer in the plan (unused now, a plain column, or a
   changed calc) is deleted with its links, unless a card t2d did not create uses it (`push.beastmode-foreign-use`); one
   another workbook also pushed (`extra.workbooks`) only drops this workbook from that list.
5. Pages (`plan.target` absent or `'pages'`): root page for the workbook (optionally under `--parent-page`), one subpage per dashboard.
   App (`plan.target === 'app'`, kind `app`): see below.
6. Cards (status `unsupported` is skipped, and a card an earlier push created is kept; one with `replacedBy: 'header'`
   (a label sheet placed as a header) that has a state entry is deleted and forgotten, action `delete`, because Domo
   appends a page card its layout leaves out and the layout write then never settles); it is kept instead, with `push.card-foreign-placement`, when a page or view t2d did not create shows it): one at a time per dataset (parallel creates on one dataset can deadlock), with retries on
   400/404/500 while the dataset finishes indexing. A split card (`CardPlan.split`) is first expanded into its member
   cards and their stacked layout items: `PUT /content/v3/cards/kpi/render/preview?parts=dynamic` with the card's body
   grouped by the split column returns the members (read shape: formulas as an array, and an unsaved card formula needs
   `isAggregatable: true` or a filter on it keeps no row). The summary number is applied by a follow-up update. On a view, `pageId` is the
   view id; a layout PUT adds a card to any other view it is placed on. Drill views (`CardPlan.drillPath`) are written after
   their card and recorded in its entry, `extra.drillViews: [{ id, field, hash }]` in drill order (`field` is `<field>:<grain>`
   for a date level); they are not separate push
   actions but notes on the card's action (dry runs say what would happen). A re-push reads the card's live drill path
   (`listDrillViews`), forgets views Domo no longer has, updates changed views in place when the levels are the same, and
   otherwise deletes t2d's views and creates the planned ones (no duplicates); views someone else added stay. A failure is
   `push.card-drill-path` and leaves the card itself pushed. A text card (`kind: 'notebook'`, `src/domo/notebooks.js`)
   is created empty with `POST /content/v1/cards/notebook` on its first view, then written with `POST .../notebook/{id}/update`
   (textHtml, Slate `markup`, `tagMarkup`, `dynamicTextItems` and one subscription per smart text item, which the update
   validates together; create takes no smart text). The owner segment is `DATA_SOURCE_OWNER` smart text when the dataset
   owner (`GET /data/v3/datasources/{id}` `owner.name`) has that name, else the Tableau name as text (`extra.ownerSmart`); with
   its dataset not pushed or without rows it shows its text only (`push.notebook-text-only`). Its dataset is a soft dependency.
   VERIFIED LIVE on a scratch page, dataset and card (all deleted, 404 after). Delete is the card `DELETE`, so unpush needs nothing
   new; verify reads it with `GET /content/v1/cards/notebook/{id}` (no data to compare).
   An image card (`kind: 'image'`, `src/domo/files.js`) uploads `images/<file>` as a data file (`POST /data/v1/data-files`,
   multipart `file`) and is a document card on its first view (`POST /content/v1/cards?pageId=`, the editor's document card
   body, `metadata.documentId` `<dataFileId>:undefined`); state `extra { kind: 'image', dataFileId, md5 }`. Again with the
   same md5 and the file still there (`GET .../data-files/{id}/details` has a `currentRevision`) it uploads nothing; changed
   bytes are a new revision (`PUT /data/v1/data-files/{id}`, the card shows the latest); a file deleted outside t2d is uploaded
   again and the card pointed at it (`PUT /content/v1/cards/{id}`). Deleting a document card leaves its data file, so unpush and
   a retired image card delete the file too (`DELETE /data/v1/data-files/{id}`, 400/404 tolerated). An app with image cards
   also gets the theme's document style square, unpadded and with no header margin (`applyControlSpacing({ images })`;
   marked `controlSpacing: '2+images'`). VERIFIED LIVE with `[t2d probe]` files and cards (deleted).
   A document card someone made on the view (in its layout, not in state) whose data file is an image with the same md5, or
   the same pixel size when re-encoded, is used instead (`reuse`, state `extra { kind: 'image',
   adopted: true }`): t2d deletes its own card and file, never changes or deletes the adopted card, and forgets it on unpush
   or retire; when it is gone t2d makes its own again. Cards t2d did not create that Domo appends below a written layout (the
   Appendix of cards on the view that the layout leaves out) are the warning `push.layout-appendix`.
   A header's section image (`kind: 'image'`, `section: true`) is uploaded as the view's layout background (`POST
   /content/v4/pages/{viewId}/layouts/background`, the raw bytes; Domo stores it as "Image background", shares it with
   the view, 10 MB at most), no card; state `{ id: <dataFileId>, extra: { kind: 'image', section: true, dataFileId, md5 } }`.
   Again with the same md5 and the file there it uploads nothing; changed bytes upload a new file and delete the old one.
   The layout step lists each file in the app theme's images (`applyThemeImages`: `{ id: 'iN', dataFileId }`, the next id
   after the highest, the app PUT carries the theme; Domo checks no image list) and writes the TABS item style
   `{ sourceId: null, textColor: null, background: { value: 'iN', type: 'IMAGE_REFERENCE' }, isDynamic: null, density:
   null, margin: null, titleFontColor: null, titleFontStyle: null }` (the layout keeps the whole style;
   theme section styles take only colors; the view draws it `cover`, no repeat). An image left out
   of the theme is the warning `push.section-image-skipped`. A `--workbook-theme` rewrite keeps the app theme's images. A
   background set in Domo on the view (a TABS item with an IMAGE_REFERENCE whose file has the same md5 or pixel size) is used
   instead (`reuse`, `adopted: true`, t2d's file deleted), never changed or deleted. A header text card made in Domo on the
   view (a Text card not in state with the same text, spacing and case ignored) is used the same way (`adoptTextCard`);
   logos use the image card adoption above. Notebook bodies write text size, color and alignment as the editor saves them
   (`notebookBody` `align`/`valign`: tag markup `textSize`, `textColor`, `horizontalAlignment` start/middle/end; Slate marks
   `header`/`h1`/`h2`, `color`; textHtml wrappers `text-align` and `centerAlignedContent`). Unpush and a retire delete
   t2d's section image file only.
   On a whole-plan push, a `card:` entry of this workbook whose key is no longer in the plan (for example a filter card
   that changed type) is deleted the same way, before the layouts (kept with `push.card-foreign-placement` when a page or
   view t2d did not create shows it).
7. Layouts: ensure a v4 layout exists, acquire the write lock, PUT the full layout, release the lock, then poll until the
   read-back content matches. A card on the page that the PUT leaves out (one t2d did not create) is moved by Domo into an
   appendix below a page break the PUT did not send; those items are ignored by the match and logged as a warning. A lock
   another user holds fails that layout with `push.layout-locked` (there is no takeover; the lock times out 60 s after the
   editor stops). The layout hash covers the planned layout, the name each variable control gets
   (`variableControlSpecs`, shared with `placeVariableControls`) and `LAYOUT_WRITER`, a version bumped whenever push
   changes what it writes to a page, so such a change rewrites pages already pushed.
7b. Page default filters (kind `layouts`, state key `filterview:<pageKey>`, `--keys filterview:<key>`): a page with
   `PagePlan.filters` gets one page-scoped named filter view "Default" (`DEFAULT_FILTER_VIEW`), made the page default for all
   users; on classic pages and App Studio views alike. Filters go out as the filter bar saves them (`dataSourceId` the dataset id,
   `sourceCardURN` the filter card's urn, `affectedCardUrns` the urns of `PageFilterPlan.affectedCards`, pushed ones only, else
   `[]`). A card ref with field `urn` resolves to the card's id when its state records no urn (text and image cards), so a
   scoped filter card's `selectedCardUrns` keep the view's header text card. t2d's own view (its state entry) is updated in place when the
   hash of name and filters changes (`removePersonalized=false`, so the pushing user's own filter state stays) and recreated when
   someone deleted it; a page whose plan has no filters any more has t2d's view deleted. A "Default" view t2d did not create is
   never changed: with the same filters (`sameFilters`: column, operand, data type and values in any order) it is taken over in
   state (`extra.adopted`, action `reuse`), otherwise push skips with the warning `push.filter-view-foreign` naming both filter
   lists. When another view t2d did not create is the page default, t2d's view is not promoted (`push.filter-view-default`).
   Unpush forgets the entry with its page or view (Domo removes the page's filter views with it).
8. Navigation (target `app`, kind `navigation`): see below.

### App Studio target

`PUSH_KINDS` (and `SELECT_KINDS`) are `datasets, dataflows, variables, beastmodes, app, pages, cards, layouts, navigation`.

- **Preflight**, before any write and only on a real push that writes app, pages, cards, layouts or navigation of an app plan:
  `appStudioStatus`. `data-app` off throws `PushError` `push.app-unavailable` (suggestion: convert with `--target pages`); there is
  no automatic fallback. `app-studio-persist` off is the warning `push.app-persist-off`; `app-studio-sections` off warns only when a
  layout has TABS. A flag lookup that fails is the warning `push.app-flags-unknown`. Fiscal calendars
  (`pipeline/fiscal-calendars.js`, `domo/calendars.js`; the check is read-only and also runs on a dry run when the Domo settings are there) are
  checked for the cards being written. Instance: `GET /content/v1/customer-states/domo.calendar.tablename` (empty value: no
  custom fiscal calendar) and `POST /query/v1/execute/StandardCalendar` for the start month's first day of last year (must
  be QuarterOfYear 1, its own YearStart, Year + 1), the first day of the second quarter (QuarterOfYear 2) and the day
  before (QuarterOfYear 4, Year).
  Integration: `GET /query/v1/byos/accounts/{id}` properties `fiscal_calendar_database|schema|name`. ice fails a fiscal
  query on a Cloud Amplifier device with no registered calendar (`ib:4201`, `CalendarQueryService.requireFallbackOrFailFast`),
  so on a real push that writes dataflows, `provisionFiscalCalendars` builds one for each integration that has none, is
  `writeable` and is not contested (`calendarConflicts` over this and the other workbooks' needs): it creates or updates the
  dataflow `magic/fiscal-calendar.js` `fiscalCalendarDataflow` (ADR on the integration, `useGraphUI`, one input-less
  Snowflake SQL tile over `GENERATOR` giving the 25 columns of ice `CalendarRegistrationService.REQUIRED_COLUMNS` with the
  values of icebox `MonthBoundaryCalendarGenerator`, 1990 through 2074), runs it, then `POST .../calendar/validate` and
  `POST .../calendar/register` (`calendarType: FISCAL`) with the output table `<database>.<defaultSchema>.<dataset id with
  underscores>`. State `fiscalcalendar:<integrationId>` (`id` = dataflow, `extra: { startMonth, datasetId, table }`, no
  workbook stamp, so unpush never removes it); a failure is `push.fiscal-calendar-failed` per card, success the info
  `push.fiscal-calendar-created`. The check then accepts a registered table matching that entry; any other registered
  table is `push.fiscal-calendar-unverified`, since t2d cannot read its rows. A missing or different calendar is
  the must-fix `push.fiscal-calendar-missing` / `push.fiscal-calendar-wrong` on each card, with the setup in the
  suggestion (company settings Fiscal Calendar, or the integration's wrench > Set up calendar: month-boundary, start
  month, "Label fiscal year by end year" on); a read that fails is `push.fiscal-calendar-unchecked`. The cards push with
  `fiscal: true` either way and are right once the calendar exists. The other workbooks' plan.json in the workspace are read
  for their needs: a start month fewer of their cards need on the same target is `push.fiscal-conflict`. Also before any write: `--parent-page` with an
  app plan throws `push.parent-page-app`, and a plan whose `page:` entries were pushed with the other target (entry
  `extra.container` absent vs `'app'`, a classic root `page:<wb>`, or for a pages plan an `app:<wb>` entry) throws `push.target-changed`.
- **App** (`app:<wb>`, `extra: { title, defaultViewId, settingsHash, themeHash, controlSpacing, itemStyleIds, paletteId, workbooks }`): no entry: `createApp`
  with the navigation settings and the theme (from `listThemes`, with `applyControlSpacing`), and record the default view;
  only when the response lacks those settings does `getApp`, `mergeAppSettings` and `updateApp` follow. Entry: `getApp` (404: the app was deleted outside t2d; its `page:`, `layout:` and `navigation:` entries are forgotten
  and it is recreated); `updateApp` with the merged body when `settingsHash` (title, description, navigation) changed. The theme is
  written on create, and on update only when `plan.options.theme` is set (`--theme`) or `plan.options.workbookTheme` is true
  (`--workbook-theme`) and `themeHash` changed, followed by `clearStyleOverride`. With `theme.overrides` the base is read with
  `listThemes` (Clarion too) and cloned with `applyThemeOverrides`. Every theme t2d writes gets `applyControlSpacing`:
  the card style `mappings.control` names gets zero padding, `elementSpacing { isCustom: true,
  header.bottomMargin: 0 }` and the workbook's filter background with no border (`overrides.control`); the chart, single value,
  control and table styles and the section style get borderRadius 0 (Tableau zones are square), every card, table and
  text card style with a drop shadow gets `dropShadow: 'NONE'`, `dropShadowColor: null` (Tableau zones have none; the
  built-in Clarion chart style is FLOATING; styles without a shadow are left as they are), and the page and section styles
  density.standard 0 (`CONTROL_SPACING` 2, 4 since the shadow); a control style another mapping shares is
  copied onto the last card style no mapping uses (a theme holds at most 8). An app whose entry lacks `controlSpacing` (pushed
  before it) gets it once on its current theme, without `clearStyleOverride`; later theme editor changes stay.
  A 403/404 on create adds the error issue `push.app-unavailable`. Then `applyItemStyles` refills the card and table styles no
  mapping uses with the plan's item styles (`extra.itemStyleIds` `{ s1: 'ca4' }`), copies of the chart, control or table style.
  With more card styles than free slots, those that differ only by border color share the most used one's
  (`push.item-styles-merged`); any left over keep the default (`push.item-styles-full`). And with
  `theme.palette` the app palette is created (`createAppPalette` needs the app id, so on create it follows `createApp` and the
  theme is written again) or updated in place (`extra.paletteId`; a 404 creates it), and the theme names it `chartColorPalette
  { id, type: 'APP' }`; a written theme with no plan palette deletes t2d's earlier one. A failing palette call warns
  `push.app-palette-failed` and the theme goes without; a theme read back without the palette warns `push.app-palette-dropped`.
  Layouts turn `itemStyle` into `style.sourceId` only for ids in `extra.itemStyleIds` that the app's theme has (else the
  default style, `push.item-styles-skipped`); the layout hash covers the resolved ids.
- **Links** (buttons and card click actions): `$ref` fields resolve through `linkField`: `idString`, a view's `appUrl`
  (`/app-studio/<appId>/pages/<viewId>`) and a card's `detailsUrl` (`/kpis/details/<cardId>`); `urn` is the card entry's. Layouts
  are written after every view exists. A BUTTON whose target is not in state is left out; a card whose click target is missing
  keeps the card without the action; both add `push.link-target-missing`. A same-view filter on selected cards drops only the
  urns of cards not pushed (`withPushedCardUrns`), and with none left disables click filtering, so it never widens to every card.
  Template children (sections, tabs) are filtered recursively when an item is left out. A view recreated in a subset push whose
  linking layouts this push does not write gets `push.links-stale` per linking view.
- **Views** (`page:<key>`, `extra: { appId, title, container: 'app', navOrder, hidden, layoutId? }`), in `navOrder`:
  an entry whose view is no longer in the app is recreated; an entry with another title is renamed (`renameView`). The first view
  without an entry takes over the app's default view (`renameView` on `defaultViewId`, unless another entry holds it or it left the
  app); the others are `createView`. No classic page call is ever sent to a view. When the app step is left out (`--only`, `--keys`)
  and the app 404s, every view fails with the error issue `push.app-missing` (push again with the app included to recreate it).
- **Navigation** (`navigation:<wb>`, `hash` of the ordered view ids, titles, icons, hidden flags, landing view and persist settings), after
  layouts: `getApp`, then t2d's views are every state entry of the app still in it (plan order and titles for the plan's views,
  the stored ones for views outside a subset; entries whose view left the app are left out with a note). The landing view is the
  plan's `landingKey`, else the first visible view, else (a subset of hidden views) the app's current landing view, which stays
  visible. `getNavigation`, `buildNavigation` (titles, `visible: false` for hidden ones), `reorderNavigation` (read and sent
  again once on a 400, when someone added a view in between), `setViewVisible(true)` for views to show, `setLanding` (Domo
  rejects a hidden landing view; a landing view someone picked among views t2d did not create is kept). Views t2d did not
  create are never renamed, moved, shown, hidden or laid out, and a theme change skips `clearStyleOverride` (it resets every
  view) while the app has one. Icons: `PagePlan.navIcon` (`navIconFor`: title keywords, `presentation` for stories,
  `list-bulleted` for Worksheets, else `analytics`) replaces an item's icon only when it shows Domo's default `pages` or the
  icon t2d last wrote (`extra.icons`), so an icon picked in the editor stays; the reorder call does not check icon names, so a
  name outside `NAV_ICONS` is skipped with a note. Then `setViewVisible(false)` for hidden views (never the landing view, nor a `linked` view, whose
  navigation item alone is hidden so buttons still open it), `putPersistSettings`. Visibility is compared with the app as read, not
  with state. The hash adds a `linked` marker only for linked hidden views, so earlier navigation entries stay unchanged.
- `summary.app` (not on dry runs) holds the app and per-view links (`appUrl`); the CLI prints the app link and `report.md` has an
  "App Studio app" section with a link per view.
- **Unpush**: cards first (an app or view delete removes only the cards' placement), then for `app:` entries: kept when a view
  entry of the app stays (shared, still needed or out of scope), else `getApp` and kept with the warning `unpush.app-foreign-views`
  when it has views no state entry records (its `extra.defaultViewId` counts as t2d's); otherwise `setSavedThemes([])` (the app delete leaves saved themes), `deleteApp`
  (permanent, no trash), and its `page:`, `layout:` and `navigation:` entries are removed "with its app". View entries of an app that
  stays (a dashboard subset, or an app kept for foreign views) are deleted one by one with `deleteView`, except the app's last
  visible view. In a subset unpush the `app:` and `navigation:` entries are never candidates. Both checks need a read, so a dry
  run notes that the app or view is kept when they fail.

Every created object is recorded in `state/<instance>.json` as soon as it exists, so an
interrupted push resumes where it stopped.

## Verified Domo endpoints

Endpoints t2d calls. Paths are relative to `https://<instance>.domo.com/api`.

| Purpose | Call |
|---|---|
| Create dataset | `POST /data/v2/datasources` `{ dataSourceName, dataSourceDescription, dataSourceType: 'API', dataProviderType: 'api', schema: { columns } }` → `dataSource.dataSourceId` |
| Change schema | `POST /data/v2/datasources/{id}/schemas` `{ columns }` |
| Upload | `POST /data/v3/datasources/{id}/uploads` `{ action: 'REPLACE', appendId: 'none' }` → `uploadId`; `PUT .../uploads/{uploadId}/parts/{n}` (text/csv); `PUT .../uploads/{uploadId}/commit` `{ action, index: true, appendId: 'none' }` → `indexing.requestKey`; poll `GET /data/v3/datasources/{id}/indexes/{requestKey}/statuses` |
| Validate beast modes | `POST /query/v1/functions/validateFunctions` `{ dataSourceId, functionTemplates: { "-1": { name, expression } } }` |
| Create beast mode | `POST /query/v1/functions/template` (no `strict`, no `owner`) `{ name, expression, global: false, variable: false, legacyId, links: [{ resource: { type: 'DATA_SOURCE', id }, visible: true, active: true }] }` |
| Create page | `POST /content/v1/pages` `{ title, parentPageId? }` → `pageId` |
| Create card | `PUT /content/v3/cards/kpi?pageId=` `{ dataProvider: { dataSourceId }, variables: true, columns: false, definition }`; `definition.formulas` is mandatory; the title is `definition.dynamicTitle.text[]` (TEXT and VARIABLE_VALUE items), `definition.title` only when no dynamic title is sent |
| Update card | `PUT /content/v3/cards/kpi/{id}` |
| Drill views | Create `PUT /content/v3/cards/kpi?parentUrn=<cardId>` (card body; appended under the path's last view; response `urn` `dr:<drillId>:<cardId>`); update `PUT /content/v3/cards/kpi/dr:<drillId>:<cardId>` (the plain id is a 400); list `GET /content/v1/cards?urns=<cardId>&parts=drillPathURNs`; delete `DELETE /content/v1/cards/<drillId>` (the rest link up); deleting the card deletes its drill views. VERIFIED LIVE (throwaway cards, deleted) |
| App Studio | `POST /content/v1/dataapps` `{ title, description, type: 'app' }`; `GET`/`PUT /content/v1/dataapps/{id}?includeHiddenViews=true`; `POST .../{id}/views` `{ type: 'dataappview', title }` → `{ view: { pageId }, layout: { layoutId } }`; `PUT .../views/{viewId}/name` (text/plain); `PUT`/`DELETE .../views/{viewId}/visible`; `GET .../navigation?includeHidden=true`, `PUT .../navigation/reorder`; `PUT .../landing/{viewId}`; `PUT .../persistSettings`; `GET /content/v1/dataapps/themes?dataAppId=`; `PUT .../{id}/themes`; `DELETE /content/v1/dataapps/{id}`; `POST /content/v1/dataapps/adminsummary`; `POST /brandkit/v1/chartColorPalettes/APP` `{ name, type: 'APP', entityType: 'DATA_APP', entityId, palette }`, `PUT`/`DELETE .../APP/{id}`, `GET .../APP/entityType/DATA_APP/id/{appId}` |
| Page filter view | `GET /content/v3/pages/{pageId}/analyzer/named` → `[{ analyzerId, name, scope, isDefault }]`; `GET /content/v3/pages/analyzer/{id}` (filters); `POST /content/v3/pages/{pageId}/analyzer` `{ name, type: 'NAMED', scope: 'PAGE', filters, segmentIds, dateTimeRange, functionOverrides }` → `{ analyzerId }`; `PUT /content/v3/pages/{pageId}/analyzer?removePersonalized=false` (same body with `analyzerId`); `PUT .../analyzer/{id}/global` (page default); `DELETE /content/v3/pages/analyzer/{id}` (verified on App Studio views) |
| Layout | `GET /content/v4/pages/{pageId}/layouts`; else `POST /content/v4/pages/layouts { pageUrn }`; `PUT .../layouts/{layoutId}/writelock`; `PUT /content/v4/pages/layouts/{layoutId}`; `DELETE .../writelock` |
| Magic ETL | `POST /dataprocessing/v1/dataflows` `{ name, databaseType: 'MAGIC', engineProperties: { 'kettle.mode': 'STRICT' }, gui: {}, actions }`; `POST .../{id}/executions` |
| Magic ETL tiles | `GroupBy { dependsOn, groups: [{ name }], fields: [{ name, expression }] }` (an expression field is Magic SQL), `ExpressionEvaluator { dependsOn, expressions: [{ fieldName, expression }] }`, `MergeJoin { step1, step2, joinType: 'LEFT OUTER'\|'CROSS', keys1, keys2, schemaModification2: [{ name, rename, remove }] }`, `WindowAction { dependsOn, groupRules: [{ column, caseSensitive }], orderRules: [{ column, caseSensitive, ascending }], additions: [{ name, operation }] }` (operation `{ type: 'FRAMED', operationType: 'SUM'\|'AVERAGE'\|'COUNT', column, preceding, following }` with `following` never null, `{ type: 'RANKING', operationType: 'RANK'\|'DENSE_RANK'\|'ROW_NUMBER' }`, `{ type: 'OFFSET', operationType: 'LAG'\|'LEAD', column, amount }`), `Metadata { fields: [{ name, remove: true }] }` (keeps every other column) |
| Fusion view | `POST /query/v1/fusions` |
| SQL DataSet View | `POST /query/v1/views` `{ dataSourceName, dataProviderType, cloudId, trigger, schema: { tables, viewTemplate: { version: 'advancedEditorSql', fromItemInfo, selectString }, tableAliases } }` |
| Connector account settings | `POST /search/v1/query` `{ query: '*', entityList: [['account']], filters: [{ field: 'dataproviderkey_facet', filterType: 'term', value: '<provider>' }] }` → `searchObjects[].databaseId`; `GET /data/v1/providers/{provider}/account/{id}` → for `ms-sql-server` `{ host, port, database, username, password, allowExternalUse }`, for `snowflakekeypairauthentication` `{ account, role, username, privateKey, allowExternalUse }` (only allowlisted fields are kept; verified live) |
| Tableau connections | `GET /sites/{site}/datasources/{luid}/connections` and `/workbooks/{luid}/connections` → `{ id, type, serverAddress, serverPort?, userName, embedPassword, authenticationType, queryTaggingEnabled, useOAuthManagedKeychain }`; the password is never returned (REST docs; verified live) |
| Cloud Amplifier service account | `GET /data/v1/accounts/{serviceAccountId}` → `dataProviderType` (`snowflake`, `snowflakekeypairauthentication`, ...); `GET /data/v1/providers/{provider}/account/{id}[?unmask=true]` → credential fields plus `account` (only `account` is read; the `snowflake` provider masks it, the `snowflakekeypairauthentication` field list returns it plain for the same account; verified live) |
| Cloud Amplifier integrations | `GET /query/v1/byos/accounts` (`serviceAccountId` names the connector account); browse `.../{id}/databases`, `.../databases/{db}/schemas`, `.../schemas/{schema}/objects` (`rows`, `page`; objects carry `datasource` when registered), `.../objects/{object}` (columns under `tables[].columns`) |
| Cleanup (unpush) | `DELETE /content/v1/cards/{id}`; `GET /content/v1/pages/{id}/subpages` → `number[]` then `DELETE /content/v1/pages/{id}` (deletes subpages too, not cards); `DELETE /dataprocessing/v1/dataflows/{id}` (outputs stay); `GET /content/v1/datasources/{id}/cards` → `[{ id, urn, title, ... }]` then `DELETE /data/v3/datasources/{id}` (stream too); `POST /query/v1/functions/bulk/template { delete: [ids] }` (the single `DELETE /query/v1/functions/template/{id}` refuses templates with active links). A deleted dataset's beast modes 404 on `GET /query/v1/functions/template/{id}` about a minute later (verified live) |
| Cloud Amplifier register | `POST /data/v1/byos/register/{integrationId}` `[{ databaseName, schemaName, tableName, dataProviderKey }]` → `{ summary, results: [{ datasource, status, error }] }` |
