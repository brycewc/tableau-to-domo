# SQL DataSet View rules for Snowflake-backed views

What Domo does to the `selectString` of an Advanced SQL DataSet View (`viewTemplate.version: advancedEditorSql`)
between `createSqlView`/`updateSqlView` and Snowflake, read from Domo's source. Each rule has an id that
[src/convert/view-sql.js](../src/convert/view-sql.js) cites in the JSDoc of the rewrite that answers it. Each rule t2d
handles has a test in [test/convert/view-sql.test.js](../test/convert/view-sql.test.js) whose name starts with its id;
`buildSqlView` runs them in order (test in `test/convert/cloud-amplifier.test.js`), and the U2 push retry is tested in
`test/pipeline/push-cloud-amplifier.test.js`.

Source paths are relative to `~/repositories/domo-development`, read on 2026-11-05 at dataShared `7348fd3`,
icebox `cd8312438`, ice `080324d4aa`. Abbreviations:

| Short | Path |
|---|---|
| `DFS` | `icebox/query-app/src/main/java/com/domo/icebox/query/modeler/service/DataFusionService.java` |
| `TCV` | `icebox/query-app/src/main/java/com/domo/icebox/query/modeler/service/TypeCollectingVisitor.java` |
| `JJT` | `dataShared/jsqlparser/src/main/jjtree/net/sf/jsqlparser/parser/JSqlParserCC.jjt` |
| `SSF` | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/supportedfunctions/SupportedSQLFunctions.java` |
| `SVSEV` | `dataShared/logic/src/main/java/com/domo/datashared/util/SchemaViewSelectExpressionValidator.java` |
| `SVP` | `dataShared/logic/src/main/java/com/domo/datashared/util/view/SchemaViewProcessor.java` |
| `ACRV` | `dataShared/logic/src/main/java/com/domo/datashared/util/sql/AllColumnsReplacementVisitor.java` |
| `CQV` | `dataShared/logic/src/main/java/com/domo/datashared/util/sql/ColumnQualifierVisitor.java` |
| `TTCV` | `dataShared/logic/src/main/java/com/domo/datashared/util/sql/visitor/chain/TypeTrackingChainVisitor.java` |
| `TU` | `dataShared/logic/src/main/java/com/domo/datashared/util/sql/TypeUtil.java` |
| `SFT` | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/deparser/domo/engine/snowflake/SnowflakeFunctionTranslator.java` |
| `SED` | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/deparser/domo/engine/snowflake/SnowflakeExpressionDeParser.java` |
| `S92E` | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/deparser/domo/Sql92ExpressionDeParser.java` |
| `S92S` | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/deparser/domo/Sql92StatementDeParser.java` |
| `SNR` | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/deparser/domo/sql/SqlNameResolver.java` |
| `SFE` | `ice/server/src/main/java/com/domo/ice/engine/impl/snowflake/SnowflakeEngine.java` |

## The path

1. `DFS:1026-1034` create/update: resolve the view template, then `validateView`.
2. `selectString` is parsed by Domo's JSqlParser fork with the default context
   (`dataShared/model/src/main/java/com/domo/datashared/schema/view/ViewTemplate.java:57-58`), then every table is
   renamed through `tableAliases` (`DFS:1130-1149`;
   `dataShared/logic/src/main/java/com/domo/datashared/util/view/ViewTemplateResolver.java:73-79, 233-238`).
3. `validateView` (`DFS:1271-1412`): expression validation (`DFS:1299-1307`, rules F1, A1-A5), then the select path
   (`DFS:1311-1338`): `SchemaViewProcessor` expands stars and qualifies columns (`SVP:325-341`, rules S1, S2, Q1-Q3),
   `TypeCollectingVisitor` types every output column (`DFS:1452-1477`, rules N1, N2, U1, U2, T1, T2).
4. At query and index time ice deparses the processed select for Snowflake (`SFE:563-571, 3336-3345`), translating
   every function (`SFT`, rules F3-F5) and quoting every identifier (rules D1, D2).

The UI preview path (`DFS:659-761`) adds three more checks only when `querySource` is `judoTable`
(`DFS:690-697`): no `SELECT *` (`DFS:792-794`), every non-column item aliased (`DFS:799-801`), unique names
(`DFS:818-821`). t2d's push does not go through it.

## Parse rules

| Id | Rule | Source | t2d |
|---|---|---|---|
| P1 | `COLLATE` is a keyword, accepted only as the postfix `<expr> COLLATE <identifier>`. Snowflake's `COLLATE(<expr>, '<spec>')` and a quoted spec do not parse. | `JJT:215, 3060-3062` | `rewriteCollate` |
| P2 | No `UNPIVOT` token; only `PIVOT` follows a FROM item. | `JJT:332, 1851` | `rewriteUnpivot` |
| P3 | A derived table's alias is optional in the grammar, but building the table reference with no name throws "table name can't be null". | `JJT:1850`; `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/schema/Table.java:443-444` | `aliasDerivedTables` |
| P4 | `::` casts, `QUALIFY`, `ILIKE`, `PIVOT`, `VALUES` lists, `EXTRACT(part FROM x)`, `TRY_CAST`, `INTERVAL n unit`, `IF`/`IIF` and analytic `name(...) OVER (...)` / `WITHIN GROUP (...)` all parse. | `JJT:3068-3082, 2100-2107, 2600, 1824, 3385-3401, 3420-3433, 3170-3184, 3556-3576, 3219-3272` | nothing needed |
| P5 | A function name is any identifier or one of a few keywords (`LEFT`, `RIGHT`, `REPLACE`, `IF`, ...), optionally qualified two levels. | `JJT:3595-3613, 1234-1244, 1158-1184` | none |
| R1 | Every table name must be a key of `tableAliases` (case-insensitive), a UUID, or `standardcalendar`; anything else, a CTE name included, throws `JsqlTableRenameException`. | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/visitor/mutable/TableRenameVisitor.java:17-57` | `inlineCtes`; `WITH RECURSIVE` is left as is |

## Function rules

| Id | Rule | Source | t2d |
|---|---|---|---|
| F1 | Every `Function` node must be named in `SupportedSQLFunctions`; any other name fails "Unsupported function referenced: X". Analytic expressions (`OVER`, `WITHIN GROUP`) are visited without a name check. | `SVSEV:249-261, 321-347`; list `SSF:88-259` | `SUPPORTED_FUNCTIONS`, `unsupportedFunctions` (warning `data.view-sql-unsupported-function`) |
| F2 | Snowflake functions outside F1 that have a supported equivalent with the same result. | F1 plus the `SFT` translation of the target | `rewriteFunctions` (table below) |
| F3 | `DATE_ADD(d, INTERVAL n unit)` (and `ADDDATE`) becomes `CAST(TIMESTAMPADD('unit', CAST(n AS INTEGER), CAST(d AS TIMESTAMP)) AS DATE)`; the cast is `TIMESTAMP` only for hour, minute or second, or a literal date with a time. | `SFT:72-93, 246-248, 1264-1300` | `rewriteDateAdd`; the info issue says a timestamp loses its time for day-or-longer parts |
| F4 | `DATEDIFF` is always translated as `DATEDIFF('DAY', arg1, arg0)`, so Snowflake's three-argument form would be mistranslated even though the count check allows three. | `SFT:336-338`; `SSF:124` | `rewriteDateDiff` (DAY, MONTH, QUARTER, YEAR; other parts warned) |
| F5 | A listed function called with a count outside its allowed set fails `InvalidParameterCountException` when translated. | `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/exception/Helpers.java:29-50`; `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/deparser/domo/FunctionTranslator.java:429-434` | `LPAD`/`RPAD` gain the pad, `TO_NUMBER(x, p, s)` and `LAST_DAY(x, month)` lose the extra arguments |

### Supported functions (F1)

`ABS ADDDATE ADDTIME ANY_VALUE APPROXIMATE_COUNT_DISTINCT APPROXIMATE_COUNT_DISTINCT_SYNOPSIS
APPROXIMATE_COUNT_DISTINCT_OF_SYNOPSIS APPROXIMATE_MEDIAN APPROXIMATE_PERCENTILE AVG CALENDAR CALENDAR_PERIOD
CALENDAR_PERIOD_ROLLING CALENDAR_PERIOD_TO_DATE CASE CAST CEILING COALESCE CONCAT CONVERT_TZ CORR COUNT CURDATE
CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURTIME DATE DATE_ADD DATE_FORMAT DATE_RANGE DATE_SUB DATE_TRUNC DATEDIFF DAY
DAYNAME DAYOFMONTH DAYOFWEEK DAYOFYEAR DIV DOMO_BEAST_MODE DYNACAST FIRST_VALUE FIXED FLOOR FROM_DAYS FROM_UNIXTIME
GRAIN_HOUR GRAIN_MINUTE GRAIN_SECOND HOUR IFNULL INITCAP INSERT INSTR LAG LAST_DAY LAST_VALUE LCASE LEAD LEFT LENGTH
LISTAGG LN LOG LOWER LPAD MAX MD5 MEDIAN MIN MINUTE MOD MONTH MONTHNAME NOW NTILE NULLIF NVL OCTET_LENGTH ONLY_AGG
PERCENTILE PERCENTILE25 PERCENTILE75 PERCENTILE99 PERCENTILE_CONT PERIOD_ADD PERIOD_DIFF POWER POW QUARTER RAND RANDOM
RANK DENSE_RANK REGEXP_REPLACE REPLACE RIGHT ROUND RPAD SAFE_DIVIDE SEC_TO_TIME SECOND SHA1 SHA224 SHA256 SHA384 SHA512
SQRT SPLIT_PART STDDEV STDDEV_POP STRPOS STR_CONTAINS STR_DIGITS STR_ENDS_WITH STR_REMOVE_DIGITS STR_STARTS_WITH
STR_TO_DATE SUBDATE SUBSTR SUBSTRING SUBSTRING_INDEX SUBTIME SUM SYSDATE TIME TIME_FORMAT TIME_TO_SEC TIMEDIFF TIMESTAMP
TO_CHAR TO_DATE TO_DAYS TO_NUMBER TRIM TRUNC TRY_CAST UNIX_TIMESTAMP UPPER VAR VAR_POP WEEK WEEKDAY WEEKOFYEAR
WIDTH_BUCKET YEAR YEARWEEK HLL_SKETCH_INIT HLL_SKETCH_MERGE HLL_SKETCH_MERGE_PARTIAL HLL_SKETCH_ESTIMATE` and the
internal `__DOMO_REQUIRED_FILTER` (`SSF:90-259`). `SSF:242-253` adds Databricks-only AI functions, `ARRAY` and
`NAMED_STRUCT`, which do not apply to Snowflake. Parameter counts are in the same lines (`oneParam`, `twoThreeParam`,
...). `CAST`, `TRY_CAST`, `EXTRACT`, `CASE` and `INTERVAL` are grammar constructs, not function calls.

Not in the list, among those Snowflake SQL uses often: `DATEADD`, `TIMEADD`, `TIMESTAMPADD`, `TIMESTAMPDIFF`,
`TO_VARCHAR`, `IFF`, `IF`, `DECODE`, `NVL2`, `ZEROIFNULL`, `NULLIFZERO`, `DIV0`, `GREATEST`, `LEAST`, `CONCAT_WS`,
`CONTAINS`, `STARTSWITH`, `ENDSWITH`, `LEN`, `CHAR_LENGTH`, `CEIL`, `LTRIM`, `RTRIM`, `CHARINDEX`, `POSITION`,
`SQUARE`, `SHA2`, `GETDATE`, `TO_TIMESTAMP*`, `TRY_TO_*`, `TO_DECIMAL`, `TO_NUMERIC`, `TO_DOUBLE`, `TO_BOOLEAN`,
`DATE_PART`, `ADD_MONTHS`, `COUNT_IF`, `REGEXP_SUBSTR`, `REGEXP_LIKE`, `REGEXP_COUNT`, `REGEXP_INSTR`,
`MONTHS_BETWEEN`, `DATE_FROM_PARTS`, `TIME_SLICE`, `EXP`, `SIGN`, `ARRAY_AGG`, `OBJECT_CONSTRUCT`, `PARSE_JSON`,
`FLATTEN`, `UUID_STRING`, `HASH`.

### F2 rewrites

| Snowflake | Written as | Why it is equivalent |
|---|---|---|
| `TO_VARCHAR(x[, fmt])` | `TO_CHAR(x[, fmt])` | Synonyms in Snowflake; `TO_CHAR` passes through (`SFT:1080-1082`), typed STRING (`TU:749`) |
| `IFF(c, a, b)` | `CASE WHEN (c) THEN a ELSE b END` | Same |
| `NVL2(a, b, c)` | `CASE WHEN a IS NOT NULL THEN b ELSE c END` | Same |
| `DECODE(x, s1, r1, ..., d)` | `CASE WHEN ... END` | A NULL search matches NULL, as DECODE does: `x IS NULL` for a NULL literal, a null-safe test for a non-literal |
| `ZEROIFNULL(x)`, `NULLIFZERO(x)` | `COALESCE(x, 0)`, `NULLIF(x, 0)` | Same |
| `DIV0(a, b)`, `DIV0NULL(a, b)` | `CASE WHEN b = 0 [OR b IS NULL] THEN 0 ELSE a / b END` | Same |
| `GREATEST`, `LEAST` (2 or 3 args) | nested `CASE` that is NULL when any argument is NULL | Same NULL rule as Snowflake; 4+ arguments are left for F1 |
| `CONCAT_WS(sep, a, b, ...)` | `CONCAT(a, sep, b, ...)` | Both are NULL when any argument is NULL |
| `CONTAINS`, `STARTSWITH`, `ENDSWITH` | `STR_CONTAINS`, `STR_STARTS_WITH`, `STR_ENDS_WITH` | Translated back to the Snowflake names (`SFT:915-927`) |
| `LEN`, `CHAR_LENGTH`, `CHARACTER_LENGTH` | `LENGTH` | Same |
| `CEIL(x)` | `CEILING(x)` | Translated back to `CEIL` (`SFT:160-162`) |
| `LTRIM(x[, 'chars'])`, `RTRIM` | `REGEXP_REPLACE(x, '^[chars]+', '')` | Default characters are a blank; characters special in a bracket class are left for F1 |
| `LPAD(x, n)`, `RPAD(x, n)` | `LPAD(x, n, ' ')` | F5: three parameters required |
| `CHARINDEX(sub, s)`, `POSITION(sub, s)`, `POSITION(sub IN s)` | `INSTR(s, sub)` | Translated to `POSITION(sub, s)` (`SFT:500-502`); a start position is dropped by that translation, so 3-argument calls are left for F1 |
| `SQUARE(x)` | `POWER(x, 2)` | Same |
| `SHA2(x[, 224/256/384/512])`, `SHA2_HEX` | `SHA256(x)` etc. | Translated back to `SHA2(x, n)` (`SFT:868-885`) |
| `GETDATE()`, `SYSTIMESTAMP()`, `LOCALTIMESTAMP()` | `CURRENT_TIMESTAMP` | Same |
| `TO_TIMESTAMP(x)`, `TO_TIMESTAMP_NTZ(x)` | `CAST(x AS TIMESTAMP)` | One argument only; a format argument is left for F1 |
| `TRY_TO_TIMESTAMP(x)`, `TRY_TO_DATE(x)`, `TRY_TO_DOUBLE(x)`, `TRY_TO_BOOLEAN(x)` | `TRY_CAST(x AS ...)` | Both take text only |
| `TO_DOUBLE(x)`, `TO_BOOLEAN(x)` | `CAST(x AS ...)` | Same |
| `TO_DECIMAL`/`TO_NUMERIC`/`TO_NUMBER(x, p[, s])`, `TRY_TO_NUMBER`/`TRY_TO_DECIMAL`/`TRY_TO_NUMERIC` | `[TRY_]CAST(x AS NUMBER[(p[, s])])` | Integer precision and scale only; a format string is left for F1 |
| `DATE_PART(part, x)` | `EXTRACT(PART FROM x)` | Snowflake synonyms; typed LONG, or DECIMAL for SECOND (`TTCV:674-683`) |
| `DATE_TRUNC(month, x)`, `TRUNC(x, month)` | `DATE_TRUNC('month', x)`, `TRUNC(x, 'month')` | Rule Q1: a bare part is read as a column |
| `LAST_DAY(x, month)` | `LAST_DAY(x)` | F5; other parts are left as is |
| `ADD_MONTHS(d, n)` | `DATE_ADD(d, INTERVAL n MONTH)` | Approximate (warning): no month-end preservation, and F3 returns a DATE |
| `COUNT_IF(c)` | `COUNT(CASE WHEN c THEN 1 END)` | Same, including 0 for no rows |

### Translations that change meaning (F3-F5 and similar)

From `SFT`, for functions that pass F1: `DATEDIFF` swaps to `DATEDIFF('DAY', b, a)` (`SFT:336-338`); `DATE_ADD`,
`ADDDATE`, `DATE_SUB`, `SUBDATE` cast to DATE unless the unit is below a day (`SFT:1264-1300`); `TO_NUMBER(x)`
becomes `CAST(TO_NUMBER(x) AS INTEGER)` (`SFT:1096-1098`); `INSTR` and `STRPOS` become `POSITION` with only two
arguments (`SFT:500-502, 907-912`); `IFNULL` becomes `COALESCE` (`SFT:490-492`); `DATE(x)` becomes `TO_DATE(x)`
(`SFT:241-243`); `TIMESTAMP(x)` becomes a cast (`SFT:1075-1077`); `LISTAGG`'s separator is normalized to a string
(`SFT:543-567`); a date-literal string argument of `DATE_TRUNC`, `TRUNC` and the date-part functions is wrapped in
`TO_DATE`/`TO_TIMESTAMP` (`SFT:657-672`). `LOG(base, x)`, `DAYOFWEEK`, `TO_CHAR`, `TO_DATE`, `TRIM`, `TRY_CAST`,
`REPLACE`, `SPLIT_PART`, `LEFT`, `RIGHT`, `LPAD`, `RPAD` pass through unchanged.

## Qualification and naming rules

| Id | Rule | Source | t2d |
|---|---|---|---|
| Q1 | Every unqualified column must belong to exactly one FROM item of its own SELECT, compared case-insensitively; otherwise "No FromItem (table) found to qualify column". A bare word inside a function call (`DATEADD(day, ...)`, `DATE_TRUNC(month, ...)`) is a column. | `CQV:236-253, 83` | date parts rewritten or quoted (`rewriteDateAdd`, `rewriteDateDiff`, `rewriteFunctions`) |
| Q2 | An unqualified column found in more than one FROM item fails "Ambiguous column". Every table is assumed to carry the built-in columns (`ROWID_DOMO_INTERNAL` and the like). Qualified columns skip both checks. | `CQV:255-264, 124-129, 283-295`; `dataShared/jsqlparser/src/main/java/com/domo/datashared/util/sql/BuiltInColumns.java:23-90` | none (Snowflake rejects the same ambiguity) |
| Q3 | A select-list alias may be referenced only in `GROUP BY`, `HAVING`, `ORDER BY` and `QUALIFY` of the same SELECT. Snowflake's lateral alias references (an alias used in `WHERE` or in a later select item) fail Q1. | `CQV:283-327` | not handled |
| N1 | The top-level output names must equal the view schema's column names exactly, case included ("column names do not match"). A plain column projects its name as written. | `DFS:1330-1334`; `TCV:94-101`; `dataShared/jsqlparser/src/main/java/net/sf/jsqlparser/util/JsqlUtil.java:706-715` | `projectionNames` names the schema columns |
| N2 | The output column count must equal the schema's. | `DFS:1327-1329` | schema built from the projection |

## Set operation and type rules

| Id | Rule | Source | t2d |
|---|---|---|---|
| U1 | Each branch of a UNION/INTERSECT/EXCEPT must project the first branch's names, compared case-insensitively after unquoting. | `TCV:81-86`; `DFS:1493-1499` | `aliasUnionBranches` (aligns case too, for S1) |
| U2 | Each branch must project the same Domo type in each position ("column types do not match. A(A):LONG does not match A(A):DECIMAL"). | `TCV:85`; `DFS:1501-1505` | `castUnionNulls`; push retries with `castUnionColumn` (`withUnionCasts` in `src/pipeline/push.js`) |
| T1 | A bare `NULL` types as NULL, which resolves to STRING; integer literals type LONG, decimal literals DOUBLE. | `TTCV:157-175, 277-299` | `castUnionNulls` |
| T2 | A cast's type is looked up by name in `InternalColumnType` (no arguments); an unknown name types as text. So `TIMESTAMP_NTZ`, `TIMESTAMP_LTZ`, `TIMESTAMP_TZ`, `TEXT`, `DOUBLE PRECISION`, `FLOAT4`, `BYTEINT`, `TIME`, `VARIANT` give a STRING column. | `TTCV:634-646`; `TU:92-140`; `JJT:4062-4104` | `rewriteCastTypes`; LTZ/TZ warned |
| T3 | Function result types come from `TU:502-968`: e.g. `DATEDIFF` LONG, `TO_NUMBER` DOUBLE, `DATE_ADD` the date argument's type, `STR_CONTAINS` BOOLEAN (a STRING column). | `TU:502-968` | none |

## Star rules

| Id | Rule | Source | t2d |
|---|---|---|---|
| S1 | Star expansion records the select items of every SELECT under a starred SELECT into one shared set, emptied only when a derived table closes. The branches of a UNION under `*` therefore share it, and a later branch's own starred derived table pops the earlier branches' names with its own. The set dedupes names case-sensitively. | `ACRV:88-95, 141-148, 162-197` | `expandStarsOverUnions` writes such stars out; `aliasUnionBranches` makes branch names identical |
| S2 | `SELECT *` over a derived table that projects an unaliased non-column expression fails "Unsupported SELECT * of sub-select with un-aliased non-column expression". | `ACRV:199-208` | not handled |

## Deparser rules (ice, Snowflake)

| Id | Rule | Source | t2d |
|---|---|---|---|
| D1 | Snowflake queries run with `table_based_column_resolution` and `quote_alias`, and the Snowflake deparser never changes case: every identifier and alias is double-quoted. A reference to a derived-table column is quoted exactly as written, so `s.name` is `s."name"` and misses a column aliased `Name`. | `SFE:3343-3344`; `SED:49-70`; `SNR:89-97`; `S92E:746-758`; `S92S:744-753` | `matchColumnCase`, `matchColumnCaseFully` |
| D2 | A reference to a dataset column resolves to its physical name, exact first, then case-insensitively (`SNR:105-131`). So an unaliased `a.id` inside a derived table projects `"ID"` while an outer `s.id` asks for `"id"`. | `SNR:101-136, 191-224` | `aliasDerivedColumns` aliases such items as written, then D1 aligns the outer references |

## Aggregation rules

Snowflake rejects the same SQL in each case, so t2d does not rewrite for them.

| Id | Rule | Source |
|---|---|---|
| A1 | With a top-level `GROUP BY`, every output column is grouped, aggregated, or a grouped expression. | `SVSEV:112-127, 133-143` |
| A2 | No aggregate or analytic function in `WHERE`. | `SVSEV:171-183` |
| A3 | No aggregate or analytic function in `GROUP BY`. | `SVSEV:185-194` |
| A4 | `HAVING`, and `ORDER BY` with a `GROUP BY`, reference only aggregates or grouped columns. | `SVSEV:234-247` |
| A5 | No aggregate inside another aggregate. | `SVSEV:330-333` |

## Observed, source not located

| Id | Rule | t2d |
|---|---|---|
| X1 | The view index job fails with "TableReference is null" on a UNION column that is a constant in every branch. The message does not appear in ice, icebox or dataShared; it is likely a Java null-pointer message from column lineage. | `anchorConstantUnionColumns` |

## Not handled

- Q3 lateral alias references: inlining needs every FROM item's columns, which t2d does not have for registered tables.
- S2 stars over unaliased expressions: the name Snowflake would give the expression is not knowable here.
- `DATEDIFF` in week, hour, minute or second parts (F4): no supported function counts those boundaries.
- `DATEADD` on a timestamp in a part of a day or longer keeps only the date (F3).
- Casts to `TIMESTAMP_LTZ`/`TIMESTAMP_TZ` (T2) type as STRING.
- Functions with no F2 entry, `TO_TIMESTAMP` and `TO_NUMBER` with a format, `GREATEST`/`LEAST` with four or more
  arguments, `CHARINDEX`/`POSITION` with a start position: warned by `unsupportedFunctions`.
- Semi-structured access (`col:path`, `FLATTEN`, `LATERAL`) and `WITH RECURSIVE`.
