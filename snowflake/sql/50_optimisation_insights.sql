-- =============================================================================
-- 50_optimisation_insights.sql
-- Purpose : turn the attribution into decisions.
-- Output  :
--   SPEND_CONCENTRATION   how much of the spend the top 10 reports account for
--   ORPHANED_SPEND        spend on reports that have no owner
--   WASTE_CANDIDATES      expensive per view AND little used: first candidates to retire or cache
--   DAILY_COST_TREND      credits per day with day-over-day change and a 7-day moving average
--   UNATTRIBUTED_SPEND    credits that could not be tied to a report, by reason
-- =============================================================================

CREATE OR REPLACE VIEW SPEND_CONCENTRATION AS
WITH ranked AS (
    SELECT report_id, cost_usd,
           ROW_NUMBER() OVER (ORDER BY cost_usd DESC) AS spend_rank,
           SUM(cost_usd) OVER ()                       AS total_report_spend
    FROM REPORT_UNIT_COST
)
SELECT COUNT(*)                                                                    AS reports,
       ROUND(SUM(CASE WHEN spend_rank <= 10 THEN cost_usd ELSE 0 END), 2)          AS top10_spend_usd,
       ROUND(MAX(total_report_spend), 2)                                           AS total_report_spend_usd,
       ROUND(100 * SUM(CASE WHEN spend_rank <= 10 THEN cost_usd ELSE 0 END)
                 / NULLIF(MAX(total_report_spend), 0), 2)                          AS top10_share_pct
FROM ranked;

CREATE OR REPLACE VIEW ORPHANED_SPEND AS
SELECT COUNT(*)                                                   AS orphaned_reports,
       ROUND(SUM(cost_usd), 2)                                    AS orphaned_spend_usd,
       ROUND(100 * SUM(cost_usd) / NULLIF((SELECT SUM(cost_usd) FROM REPORT_UNIT_COST), 0), 2) AS share_of_report_spend_pct
FROM REPORT_UNIT_COST
WHERE owner_email IS NULL;

CREATE OR REPLACE VIEW WASTE_CANDIDATES AS
WITH scored AS (
    SELECT report_id, report_name, owner_email, cost_usd, active_views, cost_per_view_usd,
           PERCENT_RANK() OVER (ORDER BY active_views)        AS usage_percentile,
           PERCENT_RANK() OVER (ORDER BY cost_usd)            AS spend_percentile
    FROM REPORT_UNIT_COST
)
SELECT report_id, report_name, owner_email, cost_usd, active_views, cost_per_view_usd,
       ROUND(usage_percentile, 3) AS usage_percentile,
       ROUND(spend_percentile, 3) AS spend_percentile,
       CASE WHEN active_views = 0 THEN 'No views: retire or pause refreshes'
            ELSE 'High spend, low usage: cache, reduce refresh frequency, or retire' END AS suggestion
FROM scored
WHERE active_views = 0
   OR (usage_percentile <= 0.25 AND spend_percentile >= 0.50);

CREATE OR REPLACE VIEW DAILY_COST_TREND AS
WITH by_day AS (
    SELECT CAST(usage_hour AS DATE) AS usage_day, SUM(metered_compute_credits) AS credits
    FROM METERING_CLEAN
    GROUP BY CAST(usage_hour AS DATE)
)
SELECT usage_day,
       ROUND(credits, 4)                                                                  AS credits,
       ROUND(credits - LAG(credits) OVER (ORDER BY usage_day), 4)                         AS change_vs_previous_day,
       ROUND(AVG(credits) OVER (ORDER BY usage_day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 4) AS moving_avg_7d
FROM by_day;

CREATE OR REPLACE VIEW UNATTRIBUTED_SPEND AS
SELECT cost_object                                AS reason,
       SUM(queries)                               AS queries,
       ROUND(SUM(compute_credits_total), 6)       AS compute_credits,
       ROUND(SUM(compute_credits_total) * MAX(c.credit_price_usd), 2) AS cost_usd
FROM COST_OBJECT_CREDITS
CROSS JOIN COST_CONFIG c
WHERE report_id IS NULL
GROUP BY cost_object;
