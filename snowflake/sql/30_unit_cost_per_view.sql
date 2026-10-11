-- =============================================================================
-- 30_unit_cost_per_view.sql
-- Purpose : the brief's question: what does each report cost per active user view?
-- Method  : USD = total credits x COST_CONFIG.credit_price_usd.
--           cost per view = USD / active views, with NULLIF so a report with 0 views gets
--           NULL (undefined) rather than a division-by-zero error or a misleading 0.
--           Ranked most expensive per view first; banded into quartiles among reports
--           that have views; zero-view reports get their own band.
-- Output  : REPORT_UNIT_COST
-- =============================================================================

CREATE OR REPLACE VIEW REPORT_UNIT_COST AS
WITH priced AS (
    SELECT a.*,
           u.active_views,
           ROUND(a.total_credits * c.credit_price_usd, 2)                              AS cost_usd,
           a.total_credits * c.credit_price_usd / NULLIF(u.active_views, 0)            AS cost_per_view_raw
    FROM REPORT_CREDIT_ATTRIBUTION a
    CROSS JOIN COST_CONFIG c
    LEFT JOIN REPORT_USAGE_MONTHLY u
           ON u.report_id = a.report_id AND u.month = c.period_start
),
ranked AS (
    SELECT p.*,
           ROUND(p.cost_per_view_raw, 4)                                               AS cost_per_view_usd,
           ROUND(p.cost_per_view_raw * 1000, 2)                                        AS cost_per_1k_views_usd,
           CASE WHEN p.cost_per_view_raw IS NOT NULL
                THEN NTILE(4) OVER (PARTITION BY (p.cost_per_view_raw IS NOT NULL)
                                    ORDER BY p.cost_per_view_raw DESC) END             AS quartile,
           DENSE_RANK() OVER (ORDER BY p.cost_per_view_raw DESC NULLS FIRST)           AS cost_per_view_rank,
           p.cost_usd / NULLIF(SUM(p.cost_usd) OVER (), 0)                             AS share_of_report_spend
    FROM priced p
)
SELECT report_id, report_name, owner_email, warehouse_name, queries, execution_hours,
       active_compute_credits, idle_credits_allocated, compute_credits_total,
       cloud_services_credits, total_credits, active_views, cost_usd,
       cost_per_view_usd, cost_per_1k_views_usd, cost_per_view_rank,
       CASE WHEN active_views = 0 OR active_views IS NULL THEN 'No views (all cost is waste)'
            WHEN quartile = 1 THEN 'Most expensive 25%'
            WHEN quartile = 2 THEN 'Above median'
            WHEN quartile = 3 THEN 'Below median'
            ELSE 'Cheapest 25%' END                                                   AS cost_band,
       ROUND(share_of_report_spend, 6)                                                 AS share_of_report_spend
FROM ranked;
