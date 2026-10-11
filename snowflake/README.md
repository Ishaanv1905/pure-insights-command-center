# Task 3: Snowflake cost allocation SQL suite

Attributes every billed Snowflake credit to a report (or to an explicit "unattributed" bucket) and calculates the unit cost per active user view, from simulated `ACCOUNT_USAGE` logs.

## Files

| Path                                     | What it is                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate_data.py`                       | Builds one simulated month (September 2026) of logs from the case-study CSV. Deterministic (fixed seed). Writes `data/*.csv`                                                                                                |
| `data/`                                  | The simulated logs: `query_history`, `query_attribution_history`, `warehouse_metering_history` (Snowflake look-alikes) and app-side tables `report_registry`, `report_usage_monthly`, `monitoring_reference`, `cost_config` |
| `sql/00_setup_and_load.sql`              | Database, schema, warehouse, stage, `COPY INTO` (Snowflake only)                                                                                                                                                            |
| `sql/01_ddl.sql`                         | Tables                                                                                                                                                                                                                      |
| `sql/10_data_quality_checks.sql`         | Finds problems in the logs before any cost is attributed: `DQ_FINDINGS`, `DQ_QUERY_STATUS`                                                                                                                                  |
| `sql/20_credit_attribution.sql`          | The attribution engine: `QUERY_COST`, `COST_OBJECT_CREDITS`, `REPORT_CREDIT_ATTRIBUTION`                                                                                                                                    |
| `sql/30_unit_cost_per_view.sql`          | Cost per active view per report, ranked and banded: `REPORT_UNIT_COST`                                                                                                                                                      |
| `sql/40_reconciliation.sql`              | Proves metered credits = attributed + unattributed, per warehouse: `RECONCILIATION`                                                                                                                                         |
| `sql/50_optimisation_insights.sql`       | Spend concentration, orphaned spend, waste candidates, daily trend, unattributed spend                                                                                                                                      |
| `sql/60_cross_check_with_monitoring.sql` | Compares the attribution with the credits in the monitoring CSV: `CROSS_CHECK`                                                                                                                                              |
| `verify/run_local.py`                    | Runs the same SQL files on DuckDB (no Snowflake account needed) and exports results                                                                                                                                         |
| `output/`                                | `attribution_results.json` plus CSVs of the main result tables                                                                                                                                                              |

## How queries are linked to reports

The portal sets a query tag on every query it runs: `QUERY_TAG = '{"app":"pure-insights","report_id":"RPT_203"}'`. The suite parses it with `TRY_PARSE_JSON`. Queries with no tag, a malformed tag, or a tag for a report that is not in the registry are not guessed: they go to explicit `UNTAGGED`, `MALFORMED_TAG` and `UNKNOWN_REPORT` buckets.

## Attribution method

- **Method A (fully loaded, reconciles to the bill).** Each warehouse-hour's metered compute credits (`WAREHOUSE_METERING_HISTORY`, negative rows excluded) are split across the queries that ran in that hour in proportion to their `execution_time`. Idle time inside the hour follows the work. Hours that were billed but ran no queries are shared per warehouse by each report's share of that warehouse's monthly execution time. Cloud services credits are added per query.
- **Method B (active only, cross-check).** Snowflake's `QUERY_ATTRIBUTION_HISTORY` credits per query, which exclude idle time. A minus B is the idle cost each report is responsible for.
- **Unit cost.** USD = credits x `COST_CONFIG.credit_price_usd` ($3.00, an assumption). Cost per view = USD / active views, using `NULLIF` so a report with no views gets NULL rather than a division by zero.

## Results on the simulated month

|                                                    |                                              |
| -------------------------------------------------- | -------------------------------------------- |
| Metered compute                                    | 65,730 credits                               |
| Attributed to reports                              | 63,142 credits                               |
| Unattributed (untagged, malformed, unknown report) | 2,588 credits                                |
| Reconciliation difference                          | 0                                            |
| Idle compute                                       | 10,054 credits (utilisation 84.7%)           |
| Total report cost (incl. cloud services)           | about $196,000                               |
| Top 10 reports' share of spend                     | 18%                                          |
| Orphaned reports (13) share of spend               | 11.7%                                        |
| Most expensive per view                            | RPT_271 ($229 per view, 9 views)             |
| Cross-check vs monitoring CSV                      | all 100 reports within 15% (median gap 0.5%) |

Data quality checks find exactly the anomalies injected into the logs: 30 duplicate query rows, 300 untagged queries, 25 malformed tags, 15 tags for an unknown report, 6 negative metering rows, 36 idle-only hours. Full numbers are in `output/attribution_results.json`.

## Run it

**Locally (verification, no Snowflake account):**

```bash
pip install duckdb
python snowflake/generate_data.py          # optional: data/ is already committed
python snowflake/verify/run_local.py       # runs every SQL file, writes output/
```

The runner applies three mechanical rewrites for syntax DuckDB lacks (`TRY_PARSE_JSON(x):key::STRING`, `TIMESTAMP_NTZ`, `NUMBER(p,s)`), and skips the statements marked `@snowflake-only` (database, warehouse, stage, `COPY INTO`). Everything else runs unchanged.

**In Snowflake (e.g. a free trial):**

1. Run the setup statements at the top of `sql/00_setup_and_load.sql`.
2. Upload the CSVs from SnowSQL: `PUT file://snowflake/data/*.csv @SIM_LOGS AUTO_COMPRESS = TRUE;`
3. Run `sql/01_ddl.sql`, then the `COPY INTO` statements in `00_setup_and_load.sql`.
4. Run `10` to `60` in order and query the views (`REPORT_UNIT_COST`, `RECONCILIATION`, `DQ_FINDINGS`, ...).

The SQL was verified on DuckDB only; the Snowflake-only setup statements were not executed.

## Assumptions and simplifications

- 1 credit = $3.00 (depends on edition and region).
- One simulated query represents 50 real ones, to keep the files small.
- Simulated queries never cross an hour boundary. With real data, split each query's execution time across the hours it spans before allocating.
- Per report, the reference values come from its most recent snapshot in the monitoring CSV with non-negative credits.
- Failed queries still use warehouse time, so they are charged to their report.
