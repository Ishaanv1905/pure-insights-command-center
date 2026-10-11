-- =============================================================================
-- 40_reconciliation.sql
-- Purpose : prove nothing was lost or double counted.
--           For every warehouse: metered compute (valid rows) must equal
--           credits attributed to reports + credits in the unattributed buckets.
--           Also shows how much was active work vs idle (method A vs method B).
-- Output  : RECONCILIATION (per warehouse plus a TOTAL row). difference should be ~0.
-- =============================================================================

CREATE OR REPLACE VIEW RECONCILIATION AS
WITH metered AS (
    SELECT warehouse_name, SUM(metered_compute_credits) AS metered_compute
    FROM METERING_CLEAN GROUP BY warehouse_name
),
excluded AS (
    SELECT warehouse_name, COUNT(*) AS negative_rows, SUM(credits_used_compute) AS negative_credits
    FROM WAREHOUSE_METERING_HISTORY WHERE credits_used_compute < 0 GROUP BY warehouse_name
),
attributed AS (
    SELECT warehouse_name,
           SUM(CASE WHEN report_id IS NOT NULL THEN compute_credits_total ELSE 0 END) AS to_reports,
           SUM(CASE WHEN report_id IS NULL     THEN compute_credits_total ELSE 0 END) AS unattributed,
           SUM(active_compute_credits)                                                AS active_compute
    FROM COST_OBJECT_CREDITS GROUP BY warehouse_name
),
per_warehouse AS (
    SELECT m.warehouse_name,
           m.metered_compute,
           COALESCE(a.to_reports, 0)                              AS attributed_to_reports,
           COALESCE(a.unattributed, 0)                            AS unattributed,
           COALESCE(a.active_compute, 0)                          AS active_compute,
           m.metered_compute - COALESCE(a.active_compute, 0)      AS idle_compute,
           COALESCE(e.negative_rows, 0)                           AS negative_rows_excluded,
           COALESCE(e.negative_credits, 0)                        AS negative_credits_excluded
    FROM metered m
    LEFT JOIN attributed a ON a.warehouse_name = m.warehouse_name
    LEFT JOIN excluded e   ON e.warehouse_name = m.warehouse_name
)
SELECT warehouse_name,
       ROUND(metered_compute, 6)                                                   AS metered_compute,
       ROUND(attributed_to_reports, 6)                                             AS attributed_to_reports,
       ROUND(unattributed, 6)                                                      AS unattributed,
       ROUND(active_compute, 6)                                                    AS active_compute,
       ROUND(idle_compute, 6)                                                      AS idle_compute,
       ROUND(100 * active_compute / NULLIF(metered_compute, 0), 2)                 AS utilisation_pct,
       negative_rows_excluded,
       ROUND(negative_credits_excluded, 6)                                         AS negative_credits_excluded,
       ROUND(metered_compute - attributed_to_reports - unattributed, 9)            AS difference
FROM per_warehouse
UNION ALL
SELECT 'TOTAL',
       ROUND(SUM(metered_compute), 6), ROUND(SUM(attributed_to_reports), 6), ROUND(SUM(unattributed), 6),
       ROUND(SUM(active_compute), 6), ROUND(SUM(idle_compute), 6),
       ROUND(100 * SUM(active_compute) / NULLIF(SUM(metered_compute), 0), 2),
       SUM(negative_rows_excluded), ROUND(SUM(negative_credits_excluded), 6),
       ROUND(SUM(metered_compute) - SUM(attributed_to_reports) - SUM(unattributed), 9)
FROM per_warehouse;
