# tableau-to-domo (`t2d`)

Migrate Tableau workbooks to Domo: data, calculated fields, worksheets and dashboards.

`t2d` reads a workbook from Tableau Server or Tableau Cloud (with a personal access token) or
from a local `.twb`/`.twbx` file. It converts the workbook into a reviewable Domo plan and
then creates the matching Domo objects:

| Tableau | Domo |
|---|---|
| Datasource (extract, live connection, published datasource) | DataSet (Cloud Amplifier registration of the warehouse table, connector stream, uploaded CSV, or an existing DataSet you map) |
| Multi-table datasource (joins, relationships, unions) | Magic ETL DataFlow or DataSet View that produces one DataSet |
| Calculated field | Beast Mode on the DataSet (validated before it is saved) |
| Parameter | Domo Variable (inlined constant when it cannot be one) |
| Worksheet | Analyzer card (chart type inferred from marks and shelves) |
| Workbook | App Studio app (or, with `convert --target pages`, a root page) |
| Dashboard | App view, in workbook tab order (or a subpage), with a layout that mirrors the zone positions |
| Dashboard filter control | Filter card (dropdown, slicer, range selector, date selector) |
| Dashboard parameter control | Variable control on the view or page (dropdown, radio buttons, slider, text box, date picker) |
| Status sheet (a title such as "Owner : ... \| Data Refreshed : &lt;Data Update Time&gt;") | Text card at the top of the view, bold kept, with "Date last updated" smart text (and owner smart text when the DataSet owner has the Tableau owner's name); a title with only the update time is smart text in the main card's description |

It is headless first: a core library (`src/`) with a thin CLI on top. Every stage reads and
writes plain JSON files in a workspace directory, so you can inspect or hand-edit the IR and the
plan between stages, and a UI can drive the same functions and listen to the same progress events.

```
extract  ->  workbooks/<slug>/ir.json + data/*.csv      (Tableau REST, Metadata API, Hyper, VizQL)
convert  ->  workbooks/<slug>/plan.json + report.md     (pure, no network)
push     ->  Domo objects, state/<instance>.json        (idempotent and resumable)
```

## Install

Requires Node.js 20 or newer.

```sh
npm install
npm link            # optional: puts `t2d` on your PATH (otherwise use `node bin/t2d.js`)
```

Optional, to export packaged and published `.hyper` extracts (the most accurate data path):

```sh
python3 -m venv .venv
.venv/bin/pip install tableauhyperapi
```

When `T2D_PYTHON` is unset and `python3` lacks `tableauhyperapi`, `t2d` uses `.venv/bin/python` (or
`venv/bin/python`) from the current directory or the project directory. A relative `T2D_PYTHON`
such as `.venv/bin/python` is resolved against the current directory.

## Configure `.env`

Copy `.env.example` to `.env` and fill in the values. Use `.env.<name>` files with `--env <name>`
to keep several instances side by side (for example `.env.prod` and `t2d --env prod doctor`).

```sh
TABLEAU_SERVER=https://prod-useast-a.online.tableau.com
TABLEAU_SITE=mysite            # site contentUrl; leave blank for the Default site
TABLEAU_PAT_NAME=t2d
TABLEAU_PAT_SECRET=...
DOMO_INSTANCE=acme             # acme.domo.com
DOMO_ACCESS_TOKEN=...
# T2D_WORKSPACE=./t2d-work
# T2D_PYTHON=python3
```

**Tableau personal access token**

1. Sign in to Tableau Server or Tableau Cloud.
2. Open your account settings (your avatar, then **My Account Settings**).
3. Under **Personal Access Tokens**, enter a token name (for example `t2d`) and select **Create Token**.
4. Copy the secret right away: Tableau shows it only once. Put the name in `TABLEAU_PAT_NAME` and the
   secret in `TABLEAU_PAT_SECRET`.
5. The site is the part of the URL after `#/site/` (blank for the Default site on Tableau Server).

A PAT allows one session at a time, so do not run two `t2d` commands against the same token in parallel.
Admins can disable PATs on a site; if sign-in fails with a 401, check that PATs are allowed.

**Domo developer token**

1. In Domo, go to **Admin > Authentication > Access tokens** (needs the Admin role or the
   "Manage access tokens" grant).
2. Select **Generate access token**, choose a user who can create DataSets, Beast Modes, pages, App Studio
   apps (`content.dataapp.edit` and `content.page.edit`) and cards, and pick an expiration.
3. Put the token in `DOMO_ACCESS_TOKEN` and the subdomain in `DOMO_INSTANCE`.

Variables (Tableau parameters) also need the `CONTENT_VARIABLE_EDIT` grant; without it, convert with
`--parameters inline`.

## Quick start

```sh
t2d doctor                                     # check credentials, VizQL Data Service access, App Studio, Cloud Amplifier integrations and the Hyper sidecar; changes nothing
t2d list workbooks --project "Finance"
t2d migrate --workbook "Sales Overview" --dry-run
t2d push --workbook sales-overview             # asks for confirmation, then creates everything
t2d status --workbook sales-overview
t2d verify --workbook sales-overview           # compare the pushed cards with the Tableau view data; read only
```

Stage by stage:

```sh
t2d extract --workbook "Sales Overview" --project Finance
t2d convert --workbook sales-overview
t2d report  --workbook sales-overview --open   # review report.md before pushing
t2d push    --workbook sales-overview --dry-run
t2d push    --workbook sales-overview --yes
```

### App Studio app or classic pages (`--target`)

By default `convert` plans one App Studio app per workbook (`--target app`): each dashboard becomes a view, in
the workbook's tab order, and worksheets on no dashboard go on a last "Worksheets" view. Dashboards hidden in
Tableau are hidden in the app navigation. `--prefix` and `--page-title` set the app title only; views keep the
dashboard names. The app gets the built-in Clarion theme (`--theme <name>` for another built-in one), a top
navigation whatever the number of views (a long one folds into a "More" menu; `--nav left` for a left one), and carries
filters and variables across views (`--no-persist-filters` turns that off). Domo's own navigation shows next to a top
navigation, as the editor sets it; `--no-domo-nav` hides it. A left navigation has neither Domo's navigation nor the app
title, as in the editor. Each navigation item gets an icon picked from the view title;
an icon chosen later in the App Studio editor is kept on re-push. Click filters carry across views only when the workbook has a filter
action that targets another dashboard. The target is recorded in `plan.json`, so `push` never switches shape.

App views also get the App Studio items classic pages cannot hold:

- **Navigation buttons** become buttons that open the target view (or the target worksheet's card in a window).
  Image and icon buttons become text buttons. A hidden dashboard that a button or action opens keeps its view
  visible and only its navigation item is hidden. Download buttons have no equivalent. A button floating over a
  sheet sits over that sheet's card: it takes the card's width and top rows (App Studio items cannot overlap).
- **Web page zones that show a Tableau view** of another workbook in the same workspace become one big button that
  opens that workbook's app view (push fills in its address once that workbook is pushed; `t2d migrate` batches push
  such layouts again at the end; until then the button opens the view on Tableau). A view of a workbook outside the
  migration, or one t2d cannot place, becomes the same button to the view on Tableau (new tab), and any other web page
  a button that opens it, so no view is left empty.
- **Dashboard headers** are recreated as Tableau draws them (App Studio apps): the banner image or the title fill becomes
  the background of a section at the top, with the title as a text card keeping Tableau's alignment, bold, size and color,
  the logos and the owner and refresh text at their Tableau positions, and the Tableau link in that text. A
  centered or bold plain title is a text card too. A banner image or title text card already set by hand on the view is
  used instead of a new one. Other dashboard images (pictures, logos) packaged in the .twbx become image (document)
  cards: each is uploaded once as a Domo file and pushed again only when it changes, and unpush deletes it. On classic
  pages the banner is an image card above the title. An image that is not in the package is reported.
- **Show/hide buttons** become collapsible sections around the zones they toggle. Sections always start
  expanded: App Studio keeps a collapsed state per viewer only.
- **Stories** become one view with a tab per story point (the caption is the tab label); a point on a dashboard
  gets a button to that dashboard's view. Captured filters and annotations are reported.
- **Dashboard actions** become card click actions: Go to Sheet and filter actions into another dashboard open
  that view with the page filters, and a filter action also passes the clicked values ("Enable interaction filters",
  which filters the cards of the starting view too), filter actions on the same dashboard keep Domo's default
  cross-filtering or limit it to their target cards, URL actions open https links, and parameter actions set the
  Domo variable. A URL action with field values on a table becomes a link in each row: the column Tableau
  underlines, else the field the link passes or is computed from, else the first text column (a second action
  gets its own column, named after it). Elsewhere field values cannot be passed: a link with them in its query
  stops before the `?`, and one with them in its path is not migrated, as the rest opens another page. A card runs
  one click action, on click: menu and hover actions run on click, and highlight and set actions have no
  equivalent. `report.md` lists what each action became.
- **Theme**: the built-in theme is cloned with the workbook's dominant fonts (mapped onto App Studio's Sans,
  Serif, Slab, Condensed and Monospace), text color, dashboard background, card background and border, and button
  color. The workbook's main color palette becomes the app's chart palette (an App Studio app palette, deleted with
  the app), and worksheet zones whose background, border or padding differ from the rest get their own card style
  (App Studio keeps 8 card and 3 table styles, so a workbook can use only the ones the theme's mappings leave free,
  4 card and 2 table styles in Clarion; styles that differ only by border color share one when they run out). Filter
  cards keep the background their Tableau zone shows (its own or its container's). Cards, tables and sections are
  square and the views have no gap between items, as Tableau tiles a dashboard. `--no-workbook-theme` keeps the
  built-in theme unchanged.

Chart colors (both targets): Tableau's colors for members of a field on Color (Edit Colors), for Measure Names and
a single mark color become color rules on the card, up to 100 colors per card (a bar and line on one column get
the line's color on the column and the bars' on the category axis). Gradients (a measure on Color), null
members and colors on tables and maps are not set, and `report.md` says so.

`--target pages` keeps the classic shape: a root page per workbook with one subpage per dashboard, and
`push --parent-page <id>` to place the root page (apps have no parent page, so `--parent-page` is rejected for
an app plan).

Before writing anything, `push` checks the instance's `data-app` feature (App Studio) and stops with
`push.app-unavailable` when it is off: the app would be created, but nobody could open it. Convert again with
`--target pages` on such an instance. `t2d doctor` reports App Studio availability and the related flags. The
push result and `report.md` link to the app and to each view.

`push`, `migrate` and `unpush` always ask before writing to Domo. Pass `--yes` to skip the question.
In a non-interactive session (CI, pipes) they refuse to change Domo without `--yes`.

### Testing a small piece first

The whole workbook is the default. To try one dashboard with a little data, then clean up:

```sh
t2d show    --workbook sales-overview                          # dashboards, worksheets, datasources, plan keys
t2d extract --workbook "Sales Overview" --dashboards "Executive Overview" --sample-rows 1000
t2d convert --workbook sales-overview --dashboards "Executive Overview"
t2d push    --workbook sales-overview --dry-run
t2d push    --workbook sales-overview --yes
t2d unpush  --workbook sales-overview --dry-run                # then without --dry-run to delete it again
```

Selection flags are shared by `extract`, `convert`, `push`, `unpush` and `migrate`:

- `--dashboards`, `--worksheets`, `--datasources`: names (or datasource ids), case-insensitive, `*` globs,
  comma lists or repeated flags. An unknown name is a usage error that lists the valid names. They add up:
  each selected dashboard brings its page (with the pages above it), its layout cards and filter cards; each
  worksheet its card; each datasource its datasets. Everything those need comes along: the datasets the cards
  read and their inputs (dataflows, views, uploaded tables), the Beast Modes the cards use (and those they use;
  `--all-beast-modes` keeps all of them) and the variables. Pages kept only to hold a dashboard keep no layout,
  so a subset push never rewrites a page with fewer cards.
- `extract` only exports data for the datasources the selection uses (manifests of the others are kept), and
  `--sample-rows N` keeps the first N rows per table (`manifest.sampled`; the report and push warn that the data
  is partial; tables sampled separately may join to fewer rows).
- `convert` writes a pruned plan (`plan.selection` records it). Without selection flags it reuses the
  selection extract ran with; `--full` plans the whole workbook.
- `push` also takes `--only <kinds>` (`datasets`, `dataflows`, `variables`, `beastmodes`, `app`, `pages`,
  `cards`, `layouts`, `navigation`; app views are `pages`), `--keys <keys>` (plan keys or `kind:key`, globs; see `t2d show`),
  `--schema-only` (datasets get their schema and only a header row, which Domo needs to index the schema
  before cards can be built on it; connector streams are not run, so cards on a new connector DataSet are skipped
  until a later push without `--schema-only` runs the stream) and `--sample-rows N`
  (uploads only N rows; a later full push uploads everything). When `--only`/`--keys` leave out something a
  pushed object needs (a card's dataset, a subpage's parent, a view's app), push stops before writing anything unless that
  object is already in state.

### Many workbooks at once

```sh
t2d migrate --project "Finance" --dry-run                  # every workbook in the project
t2d migrate --all --no-push                                 # extract and convert the whole site
t2d migrate --all --workbooks "Sales*,Ops Review" --yes     # a few workbooks (names or luids, * globs)
```

A batch signs in to Tableau once and runs extract, convert and push for each workbook with the same flags
(selection flags apply to each workbook; a workbook without the selected dashboards is skipped). A failing
workbook is recorded and the batch goes on. The summary is written to `t2d-work/batch-<timestamp>.json` and
`.md` (status, plan counts, errors and warnings per workbook, and the shared datasources), and the stakeholder
[migration report](#migration-report) to `t2d-work/migration-report-<timestamp>.md` and `.html`.

Published datasources are site-scoped. A published datasource (with a resolved luid) is extracted once into
`t2d-work/datasources/<luid>/` and becomes one Domo DataSet (plan key `pds-<luid>`, named after the published
datasource) that every workbook's plan targets; push creates it once and the other workbooks reuse its state
entry. The data is reused while the datasource's Tableau `updatedAt`, the data strategy and `mappings.json`
are unchanged (`--refresh-data` extracts again). Column names come from the first workbook extracted. Beast
Modes on a shared DataSet are keyed by the DataSet and field id, not the workbook: workbooks defining the
same calculation share one Beast Mode, and a workbook defining a name differently gets its own Beast Mode
named `<name> (<workbook>)` with a `calc.shared-conflict` warning. The variants are tracked in
`t2d-work/datasources/<luid>/beastmodes.json`. Filter cards, cards and pages stay per workbook. When the
views are the only way to get the data (`view-csv`), the DataSet belongs to that workbook alone. Objects
pushed before their datasource became shared are adopted under the shared key on the next push.

### Commands

| Command | What it does |
|---|---|
| `doctor [--dataset <id>] [--datasource <luid>]` | Signs in to Tableau (REST version), checks VizQL Data Service access with `read-metadata` on one published datasource (the first on the site, or `--datasource`; no data is read), checks the Domo token (`whoAmI`), reports App Studio availability (`data-app`) and the `app-studio-*`, `rooster-cards` and related feature flags, counts the Cloud Amplifier integrations per engine and the Snowflake integrations whose account resolved, checks Python and `tableauhyperapi`. A `403800` means the API Access capability is missing, so the `vds` strategy will not work for that datasource (it is granted per datasource); this, App Studio, Cloud Amplifier and Hyper failures do not fail the command. With `--dataset` it probes whether FIXED and window functions validate on that DataSet. Read only. |
| `list <projects\|workbooks\|datasources\|views\|local\|providers\|accounts\|integrations\|federated>` | Lists Tableau content (`--project`, `--name`, `--workbook` for views), the workbooks already in the workspace, or (read-only, Domo) connector providers (`--name`), accounts (`--provider`, which also finds accounts not shared with you; with the host or Snowflake account and database of each, never a credential), Cloud Amplifier integrations (id, engine, name, Snowflake account, database, default schema, host; `--engine`, `--name`) and federated adapters with their accounts (`--provider`, `--name`; the host only) for `mappings.json`. |
| `extract (--workbook <name\|luid> \| --file <path>)` | Downloads the workbook, builds `ir.json`, exports data. `--data-strategy`, `--unmapped ask\|export\|fail` (what to do with a datasource no mapping covers; see Data strategies), `--no-extract-data`, `--no-metadata`, `--no-published-fields` (do not merge field definitions from published datasource .tds files), `--no-domo-lookup` (no read-only Domo calls for Cloud Amplifier, federated and connector account matching), `--refresh-data` (re-extract shared published datasources), `--dashboards`, `--worksheets`, `--datasources`, `--sample-rows`. |
| `show --workbook <slug>` | Lists dashboards (with their worksheets), worksheets, datasources (with their data strategy) and plan keys, to pick a subset. |
| `convert --workbook <slug\|name>` | Writes `plan.json` and `report.md`. `--no-fixed`, `--no-window-functions`, `--parameters variables\|inline` (default variables), `--joins dataflow\|view\|flatten`, `--no-filter-cards`, `--no-materialize`, `--target app\|pages` (default app), `--theme <name>`, `--nav top\|left`, `--no-persist-filters`, `--no-domo-nav`, `--workbook-theme` / `--no-workbook-theme`, `--no-tableau-links` (no link to each dashboard on Tableau in the text card at the top of its view; links are on by default), `--prefix`, `--page-title`, `--dashboards`, `--worksheets`, `--datasources`, `--all-beast-modes` (by default only calcs a migrated card, filter, view or dataflow uses get a Beast Mode; this plans one for every translated calc), `--full`. |
| `push --workbook <slug>` | Creates or updates Domo objects. `--dry-run`, `--parent-page <id>` (`--target pages` only), `--only <kinds>`, `--keys <keys>`, `--dashboards`, `--worksheets`, `--datasources`, `--schema-only`, `--sample-rows`, `--all-beast-modes`, `--force`, `--yes`. |
| `unpush --workbook <slug>` | Deletes what push created, from the push state only. Selection flags, `--only`, `--keys`, `--dry-run`, `--yes`. See below. |
| `migrate` | `extract`, `convert` and `push` in one go; accepts all their flags plus `--no-push`. `--project <name>` (without `--workbook`), `--all` and `--workbooks <names>` run a batch (see above). |
| `report --workbook <slug> [--html] [--open]` | Re-renders `report.md` from the IR, plan and last push log, with a Timing section from the latest extract, convert and push logs. `--html` also writes `report.html` (the stakeholder view of that one workbook). |
| `report (--batch <file\|latest> \| --workbooks <a,b> \| --all) [--html] [--out <file>] [--open]` | Writes the stakeholder migration report across several workbooks (see [Migration report](#migration-report)): a batch run's `batch-<timestamp>.json` (`latest` picks the newest), workspace slugs or names, or every workbook in the workspace. Markdown by default (`migration-report.md`, or `migration-report-<timestamp>.md` for a batch; `--out` sets the file); `--html` adds a self-contained `.html` next to it. Read only, no network. |
| `status --workbook <slug> [--runs]` | How many planned objects already exist in Domo, per kind. `--runs` lists past extract, convert, push and unpush runs instead, with start time, duration and result (from `logs/`). |
| `verify --workbook <slug>` | Compares each pushed card with the Tableau view data it came from (row counts, dimension members, measure totals). `--tolerance <pct>` (default 0.5), `--keys`. Read only. See below. |
| `mappings [--init]` | Shows the `mappings.json` path, its format and an example. |

Global flags: `--env <name>`, `--workspace <dir>`, `--json`, `--quiet`, `--verbose`, `--help`, `--version`.
Every command accepts `--json`: NDJSON events, and a last `result` line with the command's data (for `list`, the items).

Exit codes: `0` success, `1` failure (including a push with failed objects), `2` usage error, `3` data decisions
needed (extract or migrate stopped before downloading data; see Data strategies).

## Offline mode (`--file`)

```sh
t2d extract --file ./Sales.twbx
t2d convert --workbook sales
```

No Tableau credentials are needed when the data can be read from the package itself (a packaged
`.hyper` extract with the Python sidecar) or comes from `mappings.json`. Strategies that need the
server (`vds`, `view-csv`) sign in only when you ask for them, or under `auto` when Tableau
settings are present. A `.twb` without data still converts: map its datasources to existing Domo
DataSets, or use `--data-strategy none` to build everything on empty DataSets whose schema comes from
the Tableau fields (load the data later).

## The workspace

```
t2d-work/
  mappings.json                  # your mappings (created on first extract)
  migration-report[-<timestamp>].{md,html}  # stakeholder report across workbooks (batch runs, t2d report --batch|--all)
  state/<instance>.json          # Domo ids per plan object; this is what makes push idempotent
  workbooks/<slug>/
    source.twbx                  # the downloaded or copied workbook
    workbook.twb                 # the XML inside it
    metadata.json                # Tableau ids, project, Metadata API result
    ir.json                      # normalized workbook (datasources, fields, sheets, dashboards, issues)
    data/<datasource>/*.csv      # exported data, Domo column names in the header
    data/<datasource>.manifest.json
    plan.json                    # everything push will create; safe to edit
    report.md                    # summary, manual follow-up checklist, then detailed tables and issues
    report.html                  # with t2d report --workbook <slug> --html
    extract-log.json             # the last extract: per datasource strategy, rows and bytes, and step durations
    convert-log.json             # the last convert: plan counts and step durations
    push-log.json                # every push action with status and error, and step durations
    push-dry-run.json            # the last dry run
    unpush-log.json              # every unpush action (unpush-dry-run.json for dry runs)
    logs/<stage>-<timestamp>.json  # one log per extract, convert, push and unpush run (not dry runs), newest 50 per stage
```

### How long a migration takes

Extract, push and migrate end with a short timing summary: the total, then the slowest steps, with rows and
bytes for data steps:

```
Extract took: 14.8 s
Slowest steps:
  datasource "Orders (Snowflake)": 10.9 s (75,000 rows, 77 MB)
  datasource.download "Orders (Snowflake)": 6.1 s (20 MB)
  datasource.csv "Orders (Snowflake)": 2.0 s (75,000 rows)
  workbook.download: 890 ms (381 KB)
  datasource.definition "Orders (Snowflake)": 888 ms
```

Extract times the Tableau sign-in, the workbook download, the parse, and per datasource the published extract
download or packaged `.hyper` unpack, the Hyper export and the CSV writing. Push times the preflight, each stage
(datasets, dataflows, variables, beast modes, app and theme, views or pages, cards, layouts, filter views, navigation),
each data upload (rows, bytes), each dataflow or connector stream run (with the time spent waiting) and each image
upload. Every run keeps its own log in `workbooks/<slug>/logs/`; `t2d status --workbook <slug> --runs` lists them:

```
Started                   Stage    Duration  Result  Instance  Detail
------------------------  -------  --------  ------  --------  ------
2026-10-20T18:48:21.131Z  extract  14.8 s    ok
2026-10-20T18:48:44.091Z  convert  53 ms     ok
```

`report.md` gets a Timing section with the latest run of each stage and its slowest steps. `--verbose` prints every
step as it finishes; `--json` emits each as a `timing` event.

The slug is the workbook name in lowercase with dashes. A short id suffix is added only when two
different workbooks have the same name.

## `mappings.json`

```json
{
	"datasets": {
		"Sample - Superstore": "8c5f0e8b-1b7e-4c9f-9d6a-2f0b1d3e4a5c"
	},
	"accounts": [
		{
			"match": { "class": "snowflake", "server": "acme.snowflakecomputing.com" },
			"accountId": 123,
			"providerKey": "snowflakekeypairauthentication"
		}
	],
	"cloudAmplifier": [
		{
			"match": { "class": "snowflake", "server": "acme.snowflakecomputing.com", "dbname": "ANALYTICS" },
			"integrationId": "00000000-0000-4000-8000-000000000001"
		}
	],
	"federated": [
		{
			"match": { "class": "sqlserver", "server": "dw.corp.example.com", "dbname": "Salesforce" },
			"accountId": 15500,
			"providerKey": "sqlserver-federated",
			"databases": { "Salesforce": "Salesforce" },
			"cacheTTL": 900
		}
	],
	"columns": {
		"Sample - Superstore.Order Date": "order_date"
	},
	"unmapped": {
		"00000000-0000-4000-8000-000000000002": "export",
		"Old Survey Data": "none"
	}
}
```

- **datasets**: Tableau datasource caption (or published datasource luid) to an existing Domo DataSet id.
  The data is not copied; cards and Beast Modes are built on that DataSet. Field names must match
  the DataSet's columns (use `columns` to fix differences).
- **accounts**: a Tableau connection (`class`, `server`, `dbname`, ...) to a Domo connector account.
  When a live connection matches, `t2d` creates a connector stream with the datasource's query instead
  of uploading a snapshot. The most specific match wins. `t2d list accounts --provider <key>` prints
  the instance's accounts with a ready-to-paste entry, and `t2d list providers --name <text>` finds
  provider keys. `providerKey` picks another connector for the class (default per class: Snowflake
  `snowflakekeypairauthentication`, SQL Server `ms-sql-server`, PostgreSQL `postgresql`, MySQL `mysql`,
  Redshift `amazon-redshift`, BigQuery `google-bigquery-service`, Oracle `OracleDB`, Databricks
  `databricks-pat`; Salesforce is object based and must be set up by hand). At push, the connector
  transport and option defaults are copied from an existing stream of the same provider on the
  instance, then from built-in defaults read from the connector descriptors. Extra keys such as
  `connectorId`, `connectorVersion` or `templateStreamId` override that choice. `databases` renames
  databases for an account that sees the Tableau database under another name (the `databaseName` setting
  and three-part names in the query are rewritten, e.g. `"databases": { "ANALYTICS": "PROD_ANALYTICS" }`), and
  `configuration` sets stream options over the planned ones (`null` drops one), for example
  `"configuration": { "warehouseName": "REPORTING_WH" }` when the account cannot use the Tableau
  warehouse. A push after the planned or mapped configuration changed updates the existing stream and
  runs it again. Extract looks up the instance's accounts of the connection's provider (read-only, their
  host or Snowflake account, port and database; never a credential field) and proposes one whose host
  matches the Tableau server (a short name such as `dw` matches `dw.corp.example.com`) with no differing
  port or database, but an account is used only once it is in this file. Under the default `--unmapped ask`
  a matching entry also replaces a Tableau extract (it counts as a decision).
- **unmapped**: datasource caption (or published datasource luid) to `"export"` (export a snapshot, see
  below) or `"none"` (no data: an empty DataSet with the Tableau schema). Extract writes these, and the
  entries above, when you answer its questions.
- **cloudAmplifier**: pins a Tableau connection (`class`, `server`, `dbname`) to a Cloud Amplifier
  integration id (see `t2d list integrations`), overriding automatic matching. `"integrationId": false`
  turns Cloud Amplifier off for that connection. `dataProviderKey` overrides the register key (default per
  engine: Snowflake `snowflake`, BigQuery `google-bigquery`, Databricks `databricks`, PostgreSQL
  `postgresql`, Lakebase `lakebase`, MySQL `mysql`, Redshift `amazon-redshift`, Oracle `oracle`, Azure SQL
  `microsoft-azure-sql-database`, Athena `aws-athena-arn`; read from an already registered table of the
  integration when there is one). `databases` renames databases for that integration, for a database
  shared into the integration's account under another name, for example
  `"databases": { "ANALYTICS": "PROD_ANALYTICS" }`; custom SQL that names the old database is rewritten too.
- **federated**: opts a Tableau connection (`class`, `server`, `dbname`) in to Domo federated DataSets on a federated
  account (`t2d list federated`): each plain table becomes a DataSet that Domo queries live in the database, nothing
  is copied. `providerKey` defaults per class (SQL Server `sqlserver-federated`, Snowflake `snowflake-federated`,
  PostgreSQL `postgres-federated`, ...), `databases` renames databases the account sees under another name, and
  `cacheTTL` is the query cache in seconds (default 900, 5 s to 2 days). `"accountId": false` turns it off for that
  connection. Only used when it matches; see Federated below for what qualifies.
- **customSql**: datasource caption or luid, then a Custom SQL table's Tableau name, to a query that replaces it for
  Cloud Amplifier, for a warehouse that shares the same data under other objects. Keep Tableau's column names (alias
  them) so joins and calculations work unchanged, and keep the key unique when Tableau joins on it. The report lists
  each replacement.
- **columns**: `Datasource caption.Field name` to a Domo column name.

## Data strategies

`--data-strategy` controls how each datasource's rows get to Domo. `auto` (the default) tries, in order (zero
copy first, then the connector, then the snapshot exports):

| Strategy | When | Fidelity |
|---|---|---|
| `existing` | The datasource is in `mappings.datasets` | Full: uses your Domo DataSet as is |
| `cloud-amplifier` | A Domo Cloud Amplifier integration can read every table of the datasource | Full and live (zero copy): the warehouse tables are registered as Cloud Amplifier DataSets |
| `federated` | Opt-in: a live connection matches `mappings.federated` and every table is a plain table or view (no custom SQL, no Initial SQL) | Live (zero copy): one federated DataSet per table, queried in the database; Beast Modes run there too |
| `connector` | A live connection matches `mappings.accounts` (a published datasource's connections and tables are read from its `.tdsx`; under `auto` only a live one, `--data-strategy connector` also replaces a published extract) | Full and refreshable: a Domo connector runs the query; Initial SQL temp tables become extra streams and Magic ETL |
| `hyper` | The workbook packages an extract and the Python sidecar works | Full snapshot of the extract (every table, all rows) |
| `published-extract` | The datasource is published, its .tdsx can be downloaded, and the sidecar works | Full snapshot of the published extract; calculations defined only in the published datasource become Beast Modes |
| `vds` | The datasource is published on the server | Row-level snapshot through the VizQL Data Service |
| `view-csv` | Last resort | Lossy: the aggregated rows of a view, as shown |
| `none` | Explicit, `mappings.unmapped` says `none`, or every other strategy failed | No data: an empty DataSet with the Tableau field schema, so cards and pages are still created |

### Ask before exporting (`--unmapped`)

An export (`hyper`, `published-extract`, `vds`, `view-csv`) copies every row through Tableau and can take far
longer than the rest of the migration, so under `auto` t2d never assumes one. Extract first resolves every
datasource of the run (for a batch, of every workbook) without downloading data. A datasource that would end up
as an export and has no decision yet is asked about once, in one prompt per run, before any data is downloaded.
A decision is any `mappings.json` entry for the connection or datasource (`datasets`, `cloudAmplifier`,
`federated`, `accounts`, `unmapped`), an explicit `--data-strategy` other than `auto`, or an earlier extract of the workbook
that exported it.

```
1/1 "Support Summary - Cases" (published datasource 00000000-...; used by support-summary)
  Tableau connection: sqlserver dw / Support (no embedded password, authentication sspi)
  Export would use: published-extract, then vds
  Connector accounts (ms-sql-server): none on this server; 3 other(s): 1001 "Microsoft SQL Server Account" ...
  Federated accounts (sqlserver-federated): no federated account for this server
  Keeps the data out of Domo (zero copy):
    [c] Cloud Amplifier integration (the warehouse is queried live)
    [f] a Domo federated account (the database is queried live; plain tables only)
  Uses data already in Domo:
    [d] an existing Domo DataSet, used as is
  Copies the data into Domo:
    [a] a Domo connector account (a refreshable connector stream)
    [e] export a snapshot through Tableau (one-time copy, the slowest)
  Other:
    [n] no data (an empty DataSet with the Tableau field schema)
  Choice [c/f/d/a/e/n]:
```

A matching connector account, a Cloud Amplifier integration that reads the tables through a secure share (with
its `databases` rename), a single unconfirmed or ambiguous integration, or a federated account on the same host
that lists the database is pre-filled: Enter accepts it (in that order). `[f]` is saved as a `federated` entry. An
option that cannot serve the datasource is left out with the reason: `[f]` for custom SQL, Initial SQL, joins
without `federated-views` or calcs that need Magic ETL ("Federated: not possible, ..."), and `[a]` for Initial SQL
t2d cannot translate ("Connector stream: not possible. ..."), where Enter accepts `[e]` export. The
answer is written to `mappings.json`, so it is not asked again. Tableau never returns a connection's password
(the REST API gives the server, port, user name and whether a password is embedded), so t2d cannot create the Domo
account itself: the prompt shows those settings so you can create the account in Domo with them and give its id.

`--unmapped` (extract and migrate):

- `ask` (default): ask on a terminal. Without one, with `--json` or `--yes`, or through the library without a
  `decide` callback, extract stops before downloading data with exit code `3` (`extract.data-decision-needed`)
  and lists every open decision with ready-to-paste `mappings.json` entries; the JSON result line carries them in
  `decisions`, and each one is also a `decision` event.
- `export`: export undecided datasources as before (the fallback order in the table above).
- `fail`: never ask; stop as above even on a terminal.

A dry run (`migrate --dry-run`) and `--no-extract-data` never ask: an undecided datasource gets no data and a
`data.decision-pending` warning with the entries to add.

A datasource that combines several kinds of connection (for example Salesforce objects joined to
Snowflake tables) cannot be recreated live by one Cloud Amplifier integration or connector, so it needs a
snapshot (`published-extract`, `vds`, ...), which extract asks about first. The report's `data.mixed-sources` warning lists each
connection with its tables and the manual setup that keeps it live: a Salesforce connector DataSet per
object, the warehouse tables through Cloud Amplifier or a connector, a Magic ETL DataFlow joining them as
Tableau does (the snapshot plan shows the joins), and a `mappings.json` `datasets` entry for its output.

### Cloud Amplifier (zero copy)

When Domo settings are present, extract makes read-only Domo calls to find a Cloud Amplifier
integration that reaches the same warehouse (`--no-domo-lookup` turns this off). For each live
connection (a published datasource's connections are read from its `.tdsx`, without the extract):

1. a `mappings.json` `cloudAmplifier` entry wins;
2. otherwise the integration engine must fit the connection class (Snowflake, BigQuery, Databricks,
   Redshift, PostgreSQL, MySQL, Oracle, SQL Server / Azure SQL, Athena);
3. an integration that exposes its host must have the connection's server;
4. a Snowflake integration's account must be the connection's account (see below);
5. the integration is browsed: it must list the database, the schema and every table (quoted
   Tableau names must match exactly, including case).

Snowflake integrations do not expose a host, so extract reads the Snowflake account identifier of the
integration's service account (`serviceAccountId`): `GET /data/v1/accounts/{id}` gives its provider key
and `GET /data/v1/providers/{provider}/account/{id}` its `account` field (with `unmask=true` only when the
plain read has none). Only that field is kept; the rest of the response holds credentials and is never
logged or stored. The account is compared with the connection's server after normalizing both: the
`.snowflakecomputing.com` and `.privatelink` suffixes, case, underscores read as hyphens in the
`ORG-ACCOUNT` form, and a locator's `.aws` cloud suffix (`xy12345.us-east-1` and
`xy12345.us-east-1.aws` are the same account; a bare locator is in `us-west-2`):

- **matches**: the integration is trusted like a host match; the browse still has to pass;
- **differs**: the integration is not a candidate;
- **unknown**: a locator on one side and an `ORG-ACCOUNT` name on the other (the same account can have
  both, and names alone cannot tell), or the service account could not be read (403, 404, another
  provider). Matching works as without the check.

The report's Cloud Amplifier lines name each integration's account and whether it matches, differs or
is unknown; `t2d list integrations` shows the account per Snowflake integration and `t2d doctor` counts
how many resolved.

One candidate is used. When the connection names a server but the matching integration can be tied to
it by neither host nor account, a browse match alone is not trusted, because a dev and a prod account
often hold the same names: extract warns, falls back to the next strategy, and suggests the
`mappings.json` entry that pins the integration.

Data read through a Snowflake secure share lives in another account than the Tableau server, often
under a renamed database (`ANALYTICS` shared as `PROD_ANALYTICS`). When nothing matches, extract browses the
integrations of other accounts, and those whose database is not visible, for the connection's schema and
tables: under the same database name, or under a database whose name shares a word with the Tableau one
(at most 40 extra browse calls per connection). A hit is never used automatically; the report warns
(`data.cloud-amplifier-share`) and suggests a ready-to-paste `cloudAmplifier` entry with the `databases`
rename, and the export question pre-fills it (Enter records it). A word is 3 or more letters or digits and not
a generic one (`db`, `prod`, `dev`, `share`, `data`, ...), so `SALES_DB` matches `PROD_SALES` through `sales`. Several candidates pick none and the report lists them with a ready-to-paste
`mappings.json` entry. A warehouse incident or cold start while browsing is reported as "could not
verify", never as "no match", and extract falls back to the next strategy. Initial SQL cannot be
reproduced on Cloud Amplifier, so such connections fall back too (the connector can, see below). Custom SQL becomes an Advanced SQL DataSet View over the
registered tables when its FROM/JOIN tables can all be registered (the SQL keeps the warehouse dialect,
so check the view after push); multi-table datasources register every table and join them with the same
Magic ETL or View planning as uploads. Cloud Amplifier DataSet columns keep the warehouse column names
(Snowflake usually upper case), so Beast Modes and cards refer to those names. Push registers each table
(`POST /data/v1/byos/register/{integrationId}`), reuses a table that is already registered, and waits for
its schema; `--dry-run` shows these as `register` actions.

### Initial SQL on the connector

Tableau runs a connection's Initial SQL once per session before the datasource's query, typically to fill temp tables
(`SELECT ... INTO #t`, `CREATE TABLE #t` plus `INSERT ... SELECT`, `UPDATE #t ...`) that the custom SQL then reads. A
Domo connector stream runs one query, so with the connector strategy t2d splits it:

- every temp table built from one SELECT (joins, filters and groups inside that query) becomes its own connector stream
  running that SELECT; several `INSERT ... SELECT` into one temp table become one `UNION ALL` stream, and `INSERT ...
  VALUES` becomes a SELECT of the literal rows;
- a query that reads only database tables (including `SELECT * FROM #t`, which is the temp table's own stream) stays a
  stream;
- whatever combines them becomes a Magic ETL DataFlow whose output DataSet the cards use: Input tiles for the streams,
  then the joins, WHERE filters, GROUP BY and HAVING, simple expressions, UNION and set-based `UPDATE` or `DELETE` on a
  temp table translated to Magic ETL tiles. The database tables of such a query are pushed into one stream (with the
  filters that only read them), and only the temp table joins happen in Magic ETL.

Variables (`DECLARE`, `SET`, `SELECT @v = ... FROM`) are substituted, a variable set from a query as a subquery;
`DROP TABLE` of a temp table, `SET NOCOUNT ON`, `ALTER SESSION`, `USE` (database, schema or warehouse of the streams),
transactions and `IF 1=2` blocks are handled. Snowflake and PostgreSQL temp tables (`CREATE TEMP TABLE t AS SELECT`)
work the same way. Cursors, loops, `IF`/`ELSE`, dynamic SQL and stored procedures (`EXEC`), `UPDATE ... FROM`, joins that
are not equalities of columns, window functions or subqueries over a temp table, `SELECT *` over a temp table whose
columns are unknown, writes to database tables and Tableau parameters such as `[TableauServerUser]` cannot be
translated. Then extract does not use the connector: it warns `data.connector-initial-sql` with the statement number,
its text and the reason, and the data decision offers an export instead (Enter accepts it). Magic ETL compares text
case-sensitively, unlike SQL Server's default collation, so `LIKE` becomes `ILIKE` and the report warns about text
joins (`data.initial-sql-note`). The report's `data.initial-sql` line lists every statement and what became of it.

### Federated (zero copy, opt-in)

A Domo federated DataSet points at one table on a federated account and Domo queries the database live for every
card. It is used only when a `mappings.json` `federated` entry matches the
connection, after Cloud Amplifier and before the connector, and only when every table of the datasource is a plain
table or view (custom SQL that is exactly `SELECT * FROM x` counts as `x`). Not eligible, with the reason reported
(`data.federated-ineligible`): custom SQL, Initial SQL, several connections, a join of several tables unless the
instance has `federated-views` on (then the join is a DataSet View over the federated DataSets; a union or full join
is not possible), and calculations with LOD expressions or table calculations, because Magic ETL cannot read federated
DataSets. Extract checks the feature flag read-only and browses the account
(`GET /federated/v2/config/accounts/{id}/databases`) to confirm the database, schema and table.

At the data decision, extract lists the federated accounts of the connection's provider (search, then the allowlisted
`server-name` of each, never a credential) and pre-fills one on the same host whose browse lists the database.

Push creates each DataSet with `POST /federated/v1/config/accounts/{accountId}/datasources`, its columns read from the
account (`.../databases/columns`), named with the plan's dataset name and prefix and the mapping's `cacheTTL`. A pushed
DataSet is reused; the TTL is updated only when it changed (each update adds a schema version). `--dry-run` shows
them as `create` with `federated <provider>, account <id>, <table>, cache <n> s`. Unpush deletes them with
`DELETE /data/v3/datasources/{id}`; the account and the table stay. Beast Modes run on the database (Domo translates
them to its dialect), so check cards with window functions or FIXED LODs (`data.federated-beast-modes`).

Uploaded data (`hyper`, `published-extract`, `vds`, `view-csv`) is a one-time snapshot. Re-run `t2d extract` and
`t2d push` to refresh it, or switch to a connector.

## What converts

| Area | Converts fully | Converts approximately | Does not convert (flagged in the report) |
|---|---|---|---|
| Data | Extracts, published datasources, single-table live connections, custom SQL (connector) | Joins and relationships (Magic ETL or View), unions, data source filters | Data blending across datasources, cross-database joins on live connections, Tableau row-level security |
| Calculations | Aggregates, logic (IF, CASE, IIF, ZN, IFNULL), string, date (DATEADD, DATEDIFF, DATETRUNC, DATEPART), math, type conversion | FIXED, INCLUDE and EXCLUDE LODs (Domo FIXED), TOTAL and percent of total, groups, bins, sets, table calcs as window functions, including a quick calc's secondary calculation over a running sum such as a Pareto line (`--no-window-functions` turns them off), FIXED LODs used as dimensions or nested in expressions and trig functions (columns computed by a Magic ETL dataflow; `--no-materialize` turns it off) | INCLUDE/EXCLUDE LODs used as dimensions, a table calc over another table calc (Domo cannot run a window over a window, even split into two beast modes), RAWSQL, SCRIPT_*, spatial functions, USERNAME and ISMEMBEROF (use PDP), dynamic parameters |
| Parameters | Domo Variables with a variable control on the page per parameter control, starting at the Tableau value | Parameters that cannot be variables stay constants inlined into Beast Modes (see Parameters below); list aliases show as values | Parameter actions |
| Charts | Bar, stacked and side-by-side bar, line, area, text table, crosstab (pivot; a crosstab listing records with four or more row headers is a Mega Table, see below), pie and donut, KPI, scatter, bubble, heatmap, treemap, histogram, filled and point maps | Dual axis (line + bar), combined axis, Gantt, highlight tables, reference lines, sorting, number formats, custom tooltips (hover text), mark labels (with their alignment and color on bars), color legend position, small multiples (drawn as series, or one card per member), member and mark colors (card color rules) | Custom shapes, polygons, density marks, trend line models, forecasts, annotations, color gradients |
| Filters | Categorical include and exclude (Null kept or dropped as in Tableau), ranges, relative dates, top N (ranked in Magic ETL before the other filters when the sheet has other dimensions or filters), "Non-null values" and "Null values only" on row-level fields | Context filters (FIXED FILTER ALLOW), wildcard and condition filters; in apps, filter, Go to Sheet, URL and parameter actions as card click actions | Highlight actions, set actions (and every action on classic pages) |
| Dashboards | App views (or pages and subpages), tab order, hidden tabs, card positions and sizes, filter cards, text and title zones; in apps, navigation buttons | Floating layouts, containers, legends; in apps, show/hide buttons (sections start expanded), stories (one view, a tab per point), the workbook theme, chart palette and per-card zone styles | Images, web pages, extensions, device layouts, download buttons; buttons, sections and stories on classic pages |

Every object the converter could not map exactly is listed in `report.md` with a severity, a
stable code and a suggestion, plus a manual follow-up checklist.

## Migration report

A report to hand to business owners and the migration lead once a set of workbooks is migrated. `t2d migrate`
batch runs write it as `migration-report-<timestamp>.md` and `.html` next to `batch-<timestamp>.json`;
`t2d report --batch latest --html` (or `--workbooks a,b`, `--all`) writes it again from the workspace at any time.

- **Workbooks**: one row per workbook with its Tableau link, the Domo app link, the status of each stage
  (extracted, converted, pushed, and why a failed one failed), the views and cards converted (exact, approximate,
  not converted), the number of follow-up items and the time taken.
- **Data**: each Tableau datasource with how its data reaches Domo (existing dataset, Cloud Amplifier, federated,
  connector, one-time copy, view export, no data, or not used) and links to its Domo datasets.
- **Manual follow-up**: one checklist per workbook, workbooks with the most must-fix items first. Items are in
  plain language, grouped by the whole workbook and then by view, merged when the same thing applies to several
  cards (each card linked), and split into **Must fix** (wrong or missing until someone acts) and **Check**
  (converted approximately; compare with Tableau). Informational notes are only counted.
- **Totals**: workbooks by status, views and cards, datasources by strategy, follow-up items and total time.

The HTML has no external assets, so it can be emailed or attached as is. Each workbook's `report.md` starts the
same way (summary, then the checklist) and keeps the detailed tables, issue codes and timing below. The plain
text for each issue code is in `src/pipeline/issue-text.js`; a code without an entry shows its pipeline message.

## Push behaviour

Push order: DataSets (Cloud Amplifier registrations, uploads, connector streams, Views), DataFlows, Variables, Beast Modes, the app,
pages or views, cards, layouts, then the app navigation and settings.

- **App Studio apps**: the app is created with its title and description, then its theme and navigation settings
  are written by reading the app, merging and writing it back (the update replaces the whole object). The first
  view takes over the default view Domo creates with the app. Cards and variable controls go on views exactly as
  on pages. Last, push orders the navigation (t2d's views first in plan order, views added by users after them),
  sets titles, hides hidden dashboards, sets the landing view and writes the persist settings. The theme is
  written on create, and on later pushes only when `--theme` or `--workbook-theme` was given, so theme edits made
  in App Studio stay. A button or click action whose target view is not pushed (a `--dashboards` subset) is left
  out with `push.link-target-missing`.
  A renamed dashboard renames its view and its navigation entry; a dashboard left out of a `--dashboards` subset
  keeps its view. A view layout open in the App Studio editor holds a write lock that cannot be taken over: that
  layout fails with `push.layout-locked`, so push again after the editor closes. An app deleted in Domo is
  recreated with its views on the next push.

- **Idempotent**: every created object is recorded in `state/<instance>.json` right away. On the next
  run an existing entry means update (or `unchanged` when nothing changed), never a duplicate.
  Unchanged CSVs are not re-uploaded; use `--force` to re-send everything.
- **Resumable**: if a run stops halfway, run it again and it continues where it stopped.
- **Validated**: Beast Modes are validated on the DataSet in one batch before they are saved. An invalid
  Beast Mode is reported and skipped; cards that use it are pushed without that field and flagged.
- **Booleans**: Beast Mode has no boolean type or TRUE/FALSE literals, so boolean calculations return the text
  `'true'`/`'false'`, and conditions on them compare with `= 'true'`. A boolean column on a DataSet t2d did not
  upload also matches `t`, `1`, `yes` and `y` (or `1` for a numeric column). Inlined parameters are folded: a branch
  their current value can never take is dropped (`IF [Mode] = 'All' THEN ... END` keeps only the chosen branch).
- **Parameters**: each Tableau parameter becomes a Domo Variable, Beast Modes reference it as
  `DOMO_BEAST_MODE(<variable id>)`, and each parameter control on a dashboard becomes a variable control on the page
  (list: dropdown, or radio buttons for a single-value list; range with both bounds: slider; date: date picker;
  otherwise a text box), starting at the parameter's current value. Cards that use a variable get a card variable
  control, which Domo needs to redraw them when the value changes. One variable serves every workbook with a
  parameter of the same name and type (Domo variable names are unique on an instance), and each page keeps its own
  value; a name taken by a variable t2d did not create gets ` (Tableau)` appended, and a parameter named like a
  calculated field gets a variable named `<name> (Parameter)`. A `LOOKUP` offset that picks between whole numbers
  (`IF [Granularity] = 'Quarter' THEN -4 ELSE -1 END`) becomes a CASE over the shifted values, so its parameter stays a
  variable. A parameter stays a constant inlined into the Beast Modes (info `calc.parameter-constant`, and
  `layout.parameter-control` for its control) when no calculation uses it, or when a calculation using it converts
  worse with a variable than with the value inlined: a literal-only argument (a `DATETRUNC` date part, any other
  `LOOKUP` offset), or a branch only the current value removes (an LOD used as a dimension, a field that does not
  exist). Calculations computed in Magic ETL use the current value. `--parameters inline` inlines every parameter.
- **Quick filters**: a quick filter with more than 50 selected values (Domo's limit) starts unfiltered, and its
  selection is kept as a fixed card filter so the card shows the same data (warning `filter.slicer-limit`).
- **Member ranges**: a shift-selected run of text members keeps the values between its bounds ignoring case, as
  Tableau's collation does (Domo compares text case-sensitively, so a card formula compares the lower-cased text);
  a column whose Tableau collation is `binary` keeps a case-sensitive BETWEEN.
- **Hidden members** (Hide in Tableau): Hide removes marks, not rows. On a dimension only one pane of a dual axis
  uses (its Color, say), the hidden members are left out of that pane's measure only, so the other pane's totals keep
  them; elsewhere Hide is a card filter (warning `filter.hidden` when a table calculation still counts the hidden
  members in Tableau, or when the pane's measure is an aggregate calculation that cannot leave them out).
- **Small multiples Domo cannot draw**: a dimension on the value shelf that splits a dual axis (or several measures)
  into panes becomes one card per member, stacked in the dashboard zone with its height divided, titled
  "<title>: <member>" and colored with the member's Tableau color. Members come from the sheet's filter, else push
  reads them from the dataset under the card's filters; more than 6 members keep one card (warning). The member cards
  scale their value axes separately, where Tableau's panes share one.
- **Member order in tables**: pivot headers Tableau leaves unsorted or sorts by name are listed in Tableau's order, with
  numbers numeric and text natural ("2023 P7" before "2023 P10"); so are the text headers of a Mega Table and the
  columns and rows of a heatmap.
- **Crosstabs that list records**: a Tableau crosstab with four or more visible row headers (accounts, ids, orders,
  dates) becomes a Mega Table, not a pivot: a Domo pivot reads at most 10,000 rows and then shows partial data, where a
  Mega Table pages through all of them. The row headers are its first columns and outer column headers the next ones;
  the innermost column header is spread into one value column per member in Tableau's manual order, plus "Grand Total"
  when Tableau totals the columns. The grand total row and subtotals on the first row header carry over (a Mega Table
  subtotals its first column only). A header caption of only punctuation (Tableau authors use "." to hide a label) is a
  blank label in Domo tables and pivots.
- **Filter cards**: presentation mode is off (no card options menu) and table drill is off. A Tableau integer dimension
  (FY) shows without thousands separators ("2026", not "2,026") on filter cards and card columns, unless its Tableau
  number format has them. More than six filter cards and variable controls on a dashboard go into a collapsible
  "Filters" section that keeps Tableau's arrangement: filters stacked in one Tableau container stay a column, and the
  columns keep their relative Tableau widths (equal when nearly so) rather than being sized by their titles. A variable
  control is labeled with the title the Tableau control shows (its custom title, else the parameter's caption), even
  when the Domo variable name needed a suffix, and takes the background of its Tableau container like the filter cards
  next to it.
- **Drill paths**: a card drills down when its Tableau sheet has a hierarchy level where a click lands, or, on a chart
  without one, a date coarser than a day. Each deeper level is a drill view, the same card with that dimension
  swapped, titled `<card title>: <level>`; clicking a mark (or table cell) opens the next level filtered to it, in place
  on the view (a card whose click runs a Tableau filter action keeps that action and drills from its details,
  `card.drill-action`).
  - Charts (bar, line, area, combo, pie, treemap) drill from the axis, else the series; filled maps from the region,
    to the next Domo map (world, US state, US county) and to a table below the last one; tables and Mega Tables from
    a cell of the hierarchy column; pivots only from a column header, because a Domo pivot click never filters by
    its row (`card.drill-chart`). Other chart types do not drill.
  - Dates follow Tableau: Year > Quarter > Month > Day from where the date starts, by Domo date grain; week dates
    drill to Day; day and exact dates do not drill. A hierarchy on the card wins over its date.
  - When Tableau shows several levels expanded, the card keeps them and the drill continues below the deepest one.
    The drill views follow the card's filters (Domo applies them) but not its quick filters or Top N row limit. A level with no Domo column
    ends the path (`card.drill-unmapped`).
  - A re-push updates the drill views in place, or replaces them when the levels changed (no duplicates); unpush
    deletes them with their card. Hierarchies need an `ir.json` from IR version 14 or later (run extract again).
- **Table drill**: off on table cards (tables, pivots, Mega Tables), filter cards and every card with a drill path and
  its drill views; on for other charts. A card you own may later show it off because of your own Domo automation.
- **SQL layout**: Beast Modes, card formulas, Magic ETL expressions and SQL DataSet View queries are written formatted
  (2-space indent, one WHEN per line, long calls one argument per line), whatever the Tableau formula looked like. Only
  whitespace changes; SQL with comments is written as is.
- **Default filters**: card quick filters start empty. The Tableau selections become each view's (or page's) "Default"
  filter view, the page default for all users, so the view's filter cards list only the values left. The other sheets a
  Tableau dashboard filter applies to ("Selected worksheets" or "All using this data source") lose their fixed copy of
  it. When that filter leaves out some of the view's cards on its DataSet, the view's filter card on the column is
  scoped to the other cards (`layout.page-default-scope`); with no such filter card the selection stays on the cards'
  quick filters (`layout.page-default-partial`). A "Default" filter view someone else made is left alone unless it has
  the same filters (`push.filter-view-foreign`).
- **Links back to Tableau** (on by default; `--no-tableau-links` turns them off): the text card at the top of each dashboard view ends with an
  "Open in Tableau" link to that dashboard on Tableau (the workbook page when Tableau does not publish the dashboard as a view);
  a view with no text card gets one just for the link.
- **Failure isolation**: a failed DataSet skips its Beast Modes and cards; everything else continues.
- **Dry run**: `--dry-run` writes nothing, does not need a Domo token, and lists what would be created, updated or left
  unchanged. Its only network calls are the read-only fiscal calendar checks below, when a token is set.
- **Fiscal years**: a Tableau datasource or date field whose fiscal year starts in another month than January (Data
  Source > Date Properties > Fiscal year start; a field's own setting wins, its "0" means the datasource's) keeps that
  fiscal year in Domo. Tableau names a fiscal year by the year it ends: with a December start, December 2025 is FY2026.
  Cards whose year, quarter, month or week grain or relative date filter is on such a field are created with Domo's
  fiscal calendar on; date parts t2d computes itself (Beast Modes such as the fiscal quarter) are shifted to the fiscal
  year and need nothing. Push checks, read-only, that the calendar exists: for data stored in Domo, the company Fiscal
  Calendar setting; for data queried live through Cloud Amplifier, the integration's own calendar (wrench > Set up
  calendar). Each needs a month-boundary calendar starting in the Tableau start month with "Label fiscal year by end
  year" on. t2d never sets either up: a missing or different one is a must-fix item listing the affected cards, which
  push anyway and are right once the calendar is there. A Domo instance or integration holds one fiscal calendar, so
  cards needing another start than most (across the workspace's workbooks) are must-fix too. Needs an `ir.json` from IR
  version 17 or later (run extract again).
- **Selective**: `--only cards,layouts` pushes just those kinds and resolves the rest from state; see
  "Testing a small piece first" for dashboard, worksheet and key selections.

## Cleanup (`t2d unpush`)

`t2d unpush --workbook <slug>` deletes what push created, using `state/<instance>.json` as the only source of
truth: nothing absent from the state is ever deleted, and each entry is removed as soon as its object is gone
(a 404 counts as gone), so it is safe to run again after an interruption. Order: cards, the App Studio app (its
saved themes are cleared, then the app is deleted with its views, layouts and navigation), pages (subpages first;
layouts go with their pages), DataFlows, DataSets (views and DataFlow outputs before their inputs; connector
streams go with their DataSet), then Beast Modes and variables.

- `existing` DataSets (from `mappings.json`) and Cloud Amplifier tables that were already registered before
  t2d are never deleted; a Cloud Amplifier DataSet t2d registered is deleted, never the integration or the
  warehouse table.
- Beast Modes on a deleted DataSet go with it: Domo removes them asynchronously, so unpush waits for each to
  disappear (up to 3 minutes) and deletes any that remain without links. The others (for example on an
  `existing` DataSet) are removed with the bulk template delete.
- An object stays (reported as left in place) while a remaining object needs it: a card on the DataSet, a
  subpage under the page, a DataFlow reading the DataSet. Before deleting, the instance is checked for cards on
  the DataSet and subpages under the page that the state does not know about (deleting a DataSet deletes its
  cards, and deleting a page deletes its subpages), and those keep it too.
- Entries another workbook's push also wrote are kept for that workbook (a variable another workbook's pages use
  stays).
- Page and card variable controls go with their pages and cards. Variables are deleted one at a time, which is
  the only path where Domo also removes the variable's default control; the bulk delete leaves it behind, and a
  default control cannot be deleted through the API afterwards.
- App delete is permanent: App Studio has no trash. Unpush first reads the app and keeps it (warning
  `unpush.app-foreign-views`) when it holds views t2d did not create; t2d's own views are then deleted one by one.
  Cards are deleted before the app, because deleting an app or a view removes only the cards' placement.
- Selection flags, `--only` and `--keys` narrow what is deleted; pages kept only as parents of a selected
  dashboard stay. With a dashboard selection, the selected views are deleted and the app stays; the app's last
  visible view is never deleted (unpush the whole workbook instead). `--dry-run` makes no network calls.

## Checking the result (`t2d verify`)

`t2d verify --workbook <slug>` checks pushed cards against Tableau without changing either side. For each card
in the push state it downloads the summary data of the Tableau view (`GET /views/{id}/data`, with the filters as
saved in the view) and renders the Domo card (`PUT /content/v1/cards/kpi/{id}/render`, with the card's saved
filters; page filters are not applied). Columns are paired by label (exact first, then without aggregation
wording such as `Sum of` or `Avg.`), and the two sides are compared at the level of the dimensions both show:

- row count: distinct combinations of the shared dimensions;
- dimension members: values only one side shows (nulls, case, number and date formats are normalized);
- measure totals: sum over the rows, within `--tolerance` percent or the rounding of Tableau's displayed values.

Each card is reported `ok`, `differs` or `not comparable` (not pushed, a filter card, no published view, the
view data failed to download or shares no column with the card). A worksheet hidden behind a dashboard has no
view of its own: the dashboard's view data holds one of its sheets, and it is matched to the card whose
columns fit it. Columns only Tableau shows (tooltip and detail fields) are listed but do not count as a
difference. When the card's DataSet holds a sample (`--sample-rows`), totals cannot match: verify says so,
marks those cards `(sample)` and only checks that Domo shows no rows or members Tableau lacks. The command fails
(exit 1) when a card differs. The downloaded view data and `verify.json` are written to the workbook directory.

The Tableau user needs the Download Summary Data capability on the views.

## JSON mode (for UIs and scripts)

With `--json`, stdout carries one JSON object per line: progress events while the command runs
and a final result line.

```sh
t2d --json push --workbook sales --dry-run
```

```json
{"type":"step","stage":"push","message":"Datasets","time":"2026-10-13T17:00:00.000Z"}
{"type":"progress","stage":"push","message":"create dataset \"Orders\"","data":{"ref":"dataset:orders","action":"create","status":"dry-run"},"time":"..."}
{"type":"done","stage":"push","message":"Dry run finished: 8 create, 0 update, ...","data":{"counts":{}},"time":"..."}
{"type":"result","command":"push","ok":true,"result":{"slug":"sales","dryRun":true,"actions":[]}}
```

Event `type` is one of `step`, `progress`, `info`, `warn`, `error`, `done`, `timing`, `decision` (a datasource that
needs a data decision; `data` is the decision with its Tableau connection, candidates and `entries`). A `timing` event carries a
finished step in `data` (`{"step":"datasets.upload","startedAt":"...","ms":5120,"key":"orders","name":"Orders","rows":120000,"bytes":3561234}`);
the run's total comes last as `step: "total"`. Errors end with
`{"type":"result","ok":false,"exitCode":1,"error":{"name","message"}}`.

## Library usage

```js
import { loadConfig, migrateWorkbook, migrateBatch, extractWorkbook, convertStage, pushPlan, unpushPlan, createEmitter } from 'tableau-to-domo';

const config = loadConfig({ env: 'prod' });
const sink = (event) => console.log(`[${event.stage}] ${event.type}: ${event.message}`);

const { slug } = await extractWorkbook({ config, file: './Sales.twbx', emitter: createEmitter(sink, 'extract') });
const plan = await convertStage({ config, slug, options: { namePrefix: 'Migrated: ' }, emitter: createEmitter(sink, 'convert') });
const preview = await pushPlan({ config, slug, dryRun: true });
if (preview.ok) await pushPlan({ config, slug, emitter: createEmitter(sink, 'push') });

// a subset, then cleanup
const selection = { dashboards: ['Executive Overview'], sampleRows: 1000 };
await pushPlan({ config, slug, selection });
await unpushPlan({ config, slug, selection });

// or all at once, with a confirmation hook
await migrateWorkbook({ config, workbook: 'Sales Overview', sink, confirm: async (preview) => preview.counts.create < 100 });

// datasources no mapping covers: answer in code (written to mappings.json), or catch DataDecisionError
const decide = async (decisions) => decisions.map((d) => (d.suggested ? { key: d.key, choice: d.suggested.choice, id: d.suggested.id } : { key: d.key, choice: 'export' }));
await extractWorkbook({ config, workbook: 'Sales Overview', decide });
await extractWorkbook({ config, workbook: 'Sales Overview', unmapped: 'export' }); // old behavior

// a whole project (batch summary in summary.file / summary.report)
const summary = await migrateBatch({ config, project: 'Finance', dryRun: true, sink });
```

Core functions never print and never exit the process: they throw errors and report progress
through the emitter. Lower-level pieces are exported too (`TableauClient`, `openPackage`,
`buildWorkbookIR`, `convertWorkbook`, `selectPlan`, `normalizeSelection`, `describeWorkbook`, `createDomoClient`, and the `domo` namespace).

## Troubleshooting

- **`Missing Tableau settings` / `Missing Domo settings`**: check `.env`, or the `.env.<name>` file you passed with `--env`.
- **Tableau 401 on sign-in**: the PAT is wrong, expired, revoked, or already in use by another session. Create a new one.
- **Tableau Cloud redirects**: use the pod URL (for example `https://prod-useast-b.online.tableau.com`); `t2d` follows the pod redirect on sign-in.
- **`tableauhyperapi` not available**: install it in the Python that `T2D_PYTHON` points to, or use another `--data-strategy`.
- **Metadata API errors**: they are warnings. The workbook XML still has the formulas; the Metadata API only fills gaps for published datasources.
- **Beast Mode fails validation**: open `report.md`, fix the expression in `plan.json` (`beastModes[].expression`), and run `push` again.
- **FIXED or window functions rejected**: run `t2d doctor --dataset <id>` to see what the instance accepts; ask Domo support to enable the feature, or convert with `--no-fixed` / `--no-window-functions`.
- **A card shows no data right after push**: the DataSet may still be indexing; refresh in a minute.
- **`push.app-unavailable`**: App Studio (`data-app`) is off on the instance, or the token user lacks the app grants. Convert with `--target pages`.
- **`push.target-changed`**: the dashboards were pushed with the other `--target`. Unpush first, or convert with the target they were pushed with.
- **Start over on an instance**: delete objects in Domo, then remove `t2d-work/state/<instance>.json` (or the entries for those objects).
- **Verbose logs**: add `--verbose` for per-object progress, or `--json` to capture everything.
