-- =============================================================================
-- 10_data_quality_checks.sql
-- Purpose : find the problems in the logs BEFORE attributing cost, and say how each is handled.
--           Every later step depends on these decisions, so they are made visible first.
-- Output  : DQ_FINDINGS (one row per check) and DQ_QUERY_STATUS (each distinct query and
--           whether it can be tied to a report).
-- =============================================================================

-- Each distinct query once, with its parsed tag and attribution status.
-- Duplicate query_id rows (an ETL retry loaded some twice) are collapsed here.
CREATE OR REPLACE VIEW DQ_QUERY_STATUS AS
WITH deduplicated AS (
    SELECT *
    FROM QUERY_HISTORY
    QUALIFY ROW_NUMBER() OVER (PARTITION BY query_id ORDER BY start_time) = 1
),
parsed AS (
    SELECT
        d.*,
        TRY_PARSE_JSON(d.query_tag):report_id::STRING AS tag_report_id
    FROM deduplicated d
)
SELECT
    p.query_id,
    p.warehouse_name,
    p.start_time,
    p.execution_status,
    p.execution_time,
    p.query_tag,
    p.tag_report_id,
    r.report_id,
    CASE
        WHEN p.query_tag IS NULL OR TRIM(p.query_tag) = '' THEN 'UNTAGGED'
        WHEN p.tag_report_id IS NULL                       THEN 'MALFORMED_TAG'
        WHEN r.report_id IS NULL                           THEN 'UNKNOWN_REPORT'
        ELSE 'ATTRIBUTED'
    END AS attribution_status
FROM parsed p
LEFT JOIN REPORT_REGISTRY r ON r.report_id = p.tag_report_id;

CREATE OR REPLACE VIEW DQ_FINDINGS AS
SELECT 'DUPLICATE_QUERY_ROWS' AS check_name, 'warning' AS severity,
       (SELECT COUNT(*) - COUNT(DISTINCT query_id) FROM QUERY_HISTORY) AS affected_rows,
       'Query rows loaded more than once. Collapsed to one row per query_id so their credits are not counted twice.' AS handling
UNION ALL
SELECT 'UNTAGGED_QUERIES', 'info',
       (SELECT COUNT(*) FROM DQ_QUERY_STATUS WHERE attribution_status = 'UNTAGGED'),
       'Ad hoc queries without a query tag. Their credits go to an explicit UNTAGGED bucket, not to any report.'
UNION ALL
SELECT 'MALFORMED_QUERY_TAGS', 'warning',
       (SELECT COUNT(*) FROM DQ_QUERY_STATUS WHERE attribution_status = 'MALFORMED_TAG'),
       'Tag is not valid JSON (truncated by the portal). Credits go to a MALFORMED_TAG bucket; the portal tagging code needs a fix.'
UNION ALL
SELECT 'UNKNOWN_REPORT_TAGS', 'warning',
       (SELECT COUNT(*) FROM DQ_QUERY_STATUS WHERE attribution_status = 'UNKNOWN_REPORT'),
       'Tag names a report that is not in the registry (deleted or renamed). Credits go to an UNKNOWN_REPORT bucket.'
UNION ALL
SELECT 'NEGATIVE_METERING_ROWS', 'critical',
       (SELECT COUNT(*) FROM WAREHOUSE_METERING_HISTORY WHERE credits_used_compute < 0),
       'Metering rows with negative credits (an adjustment or ingestion error). Excluded from all cost math and listed for review.'
UNION ALL
SELECT 'IDLE_ONLY_HOURS', 'info',
       (SELECT COUNT(*) FROM WAREHOUSE_METERING_HISTORY m
         WHERE m.credits_used_compute >= 0
           AND NOT EXISTS (SELECT 1 FROM DQ_QUERY_STATUS q
                            WHERE q.warehouse_name = m.warehouse_name
                              AND DATE_TRUNC('hour', q.start_time) = m.start_time)),
       'Billed hours with no queries at all (warehouse stayed up before auto-suspend). Shared out by each report''s share of that warehouse''s monthly execution time.'
UNION ALL
SELECT 'FAILED_QUERIES', 'info',
       (SELECT COUNT(*) FROM DQ_QUERY_STATUS WHERE execution_status = 'FAILED'),
       'Failed queries still use warehouse time, so they are charged to their report like any other query.'
UNION ALL
SELECT 'ORPHANED_REPORTS', 'warning',
       (SELECT COUNT(*) FROM REPORT_REGISTRY WHERE owner_email IS NULL),
       'Reports with no owner. Their spend is attributed normally and reported separately, because nobody is accountable for it.'
UNION ALL
SELECT 'REPORTS_WITH_ZERO_VIEWS', 'warning',
       (SELECT COUNT(*) FROM REPORT_USAGE_MONTHLY WHERE active_views = 0),
       'Reports nobody viewed this month. Cost per view is undefined (NULL, never a division by zero); their whole cost is waste.';
