-- =============================================================================
-- 20_credit_attribution.sql
-- Purpose : attribute every billed warehouse credit to a report (or an explicit bucket).
-- Method A (fully loaded, reconciles to the bill):
--   1. Metered compute credits per warehouse-hour come from WAREHOUSE_METERING_HISTORY
--      (negative rows excluded, see 10_data_quality_checks.sql).
--   2. Within each warehouse-hour, credits are split across the queries that ran in it in
--      proportion to their execution_time. This shares the hour's idle time too, in the
--      same proportion as the work.
--   3. Hours with credits but no queries ("idle-only" hours) are shared out per warehouse
--      by each cost object's share of that warehouse's monthly execution time.
--   4. Cloud services credits are taken per query from QUERY_HISTORY.
-- Method B (active only, cross-check): Snowflake's QUERY_ATTRIBUTION_HISTORY credits,
--   which exclude idle time. A - B = the idle cost each report is responsible for.
-- Simplification: the generated queries never cross an hour boundary. With real data,
--   split a query's execution_time across the hours it spans before step 2.
-- Output  : QUERY_COST (per query), COST_OBJECT_CREDITS (per report or bucket),
--           REPORT_CREDIT_ATTRIBUTION (per report, every registered report).
-- =============================================================================

CREATE OR REPLACE VIEW METERING_CLEAN AS
SELECT warehouse_name,
       start_time AS usage_hour,
       SUM(credits_used_compute) AS metered_compute_credits
FROM WAREHOUSE_METERING_HISTORY
WHERE credits_used_compute >= 0
GROUP BY warehouse_name, start_time;

-- Step 2: each query's share of its warehouse-hour.
CREATE OR REPLACE TABLE QUERY_COST AS
WITH q AS (
    SELECT query_id, report_id, attribution_status, warehouse_name, execution_status,
           execution_time,
           DATE_TRUNC('hour', start_time) AS usage_hour
    FROM DQ_QUERY_STATUS
),
shared AS (
    SELECT q.*,
           q.execution_time
             / NULLIF(SUM(q.execution_time) OVER (PARTITION BY q.warehouse_name, q.usage_hour), 0) AS hour_share
    FROM q
)
SELECT s.query_id,
       s.report_id,
       COALESCE(s.report_id, s.attribution_status) AS cost_object,     -- RPT_xxx, UNTAGGED, MALFORMED_TAG, UNKNOWN_REPORT
       s.attribution_status,
       s.warehouse_name,
       s.usage_hour,
       s.execution_status,
       s.execution_time,
       s.hour_share,
       COALESCE(m.metered_compute_credits, 0) * s.hour_share AS compute_credits_in_hour,
       COALESCE(a.credits_attributed_compute, 0)               AS active_compute_credits,   -- method B
       COALESCE(h.credits_used_cloud_services, 0)              AS cloud_services_credits
FROM shared s
LEFT JOIN METERING_CLEAN m
       ON m.warehouse_name = s.warehouse_name AND m.usage_hour = s.usage_hour
LEFT JOIN QUERY_ATTRIBUTION_HISTORY a
       ON a.query_id = s.query_id
LEFT JOIN (SELECT query_id, MAX(credits_used_cloud_services) AS credits_used_cloud_services
           FROM QUERY_HISTORY GROUP BY query_id) h
       ON h.query_id = s.query_id;

-- Step 3: billed hours with no queries.
CREATE OR REPLACE VIEW IDLE_ONLY_HOURS AS
SELECT m.warehouse_name, m.usage_hour, m.metered_compute_credits
FROM METERING_CLEAN m
WHERE NOT EXISTS (SELECT 1 FROM QUERY_COST q
                  WHERE q.warehouse_name = m.warehouse_name AND q.usage_hour = m.usage_hour);

CREATE OR REPLACE TABLE COST_OBJECT_CREDITS AS
WITH per_object AS (
    SELECT warehouse_name,
           cost_object,
           MAX(report_id)                       AS report_id,
           COUNT(*)                             AS queries,
           SUM(execution_time) / 3600000.0      AS execution_hours,
           SUM(compute_credits_in_hour)         AS compute_credits_in_hours,
           SUM(active_compute_credits)          AS active_compute_credits,
           SUM(cloud_services_credits)          AS cloud_services_credits
    FROM QUERY_COST
    GROUP BY warehouse_name, cost_object
),
with_share AS (
    SELECT p.*,
           p.execution_hours / NULLIF(SUM(p.execution_hours) OVER (PARTITION BY p.warehouse_name), 0) AS warehouse_exec_share
    FROM per_object p
),
idle_only AS (
    SELECT warehouse_name, SUM(metered_compute_credits) AS idle_only_credits
    FROM IDLE_ONLY_HOURS
    GROUP BY warehouse_name
)
SELECT s.warehouse_name,
       s.cost_object,
       s.report_id,
       s.queries,
       s.execution_hours,
       s.active_compute_credits,                                                     -- method B
       s.compute_credits_in_hours + s.warehouse_exec_share * COALESCE(i.idle_only_credits, 0)
                                                    AS compute_credits_total,       -- method A
       s.cloud_services_credits
FROM with_share s
LEFT JOIN idle_only i ON i.warehouse_name = s.warehouse_name;

-- Per report: every registered report appears, even one with no queries this month.
CREATE OR REPLACE TABLE REPORT_CREDIT_ATTRIBUTION AS
WITH per_report AS (
    SELECT report_id,
           MAX(warehouse_name)          AS warehouse_name,
           SUM(queries)                 AS queries,
           SUM(execution_hours)         AS execution_hours,
           SUM(active_compute_credits)  AS active_compute_credits,
           SUM(compute_credits_total)   AS compute_credits_total,
           SUM(cloud_services_credits)  AS cloud_services_credits
    FROM COST_OBJECT_CREDITS
    WHERE report_id IS NOT NULL
    GROUP BY report_id
)
SELECT r.report_id,
       r.report_name,
       r.owner_email,
       COALESCE(p.warehouse_name, r.warehouse_name)                         AS warehouse_name,
       COALESCE(p.queries, 0)                                               AS queries,
       ROUND(COALESCE(p.execution_hours, 0), 4)                             AS execution_hours,
       ROUND(COALESCE(p.active_compute_credits, 0), 6)                      AS active_compute_credits,
       ROUND(COALESCE(p.compute_credits_total, 0)
             - COALESCE(p.active_compute_credits, 0), 6)                    AS idle_credits_allocated,
       ROUND(COALESCE(p.compute_credits_total, 0), 6)                       AS compute_credits_total,
       ROUND(COALESCE(p.cloud_services_credits, 0), 6)                      AS cloud_services_credits,
       ROUND(COALESCE(p.compute_credits_total, 0)
             + COALESCE(p.cloud_services_credits, 0), 6)                    AS total_credits
FROM REPORT_REGISTRY r
LEFT JOIN per_report p ON p.report_id = r.report_id;
