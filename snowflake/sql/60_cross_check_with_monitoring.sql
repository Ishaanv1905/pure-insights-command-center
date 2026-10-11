-- =============================================================================
-- 60_cross_check_with_monitoring.sql
-- Purpose : independent check. The monitoring feed (the dashboard's CSV) reports a
--           credits number per report. Attribution from the logs should land close to it.
--           Large gaps point at tagging problems, wrong warehouse mapping, or a bad feed.
-- Method  : compare fully loaded compute credits (method A) with MONITORING_REFERENCE.
--           Tolerance 15%: idle time is shared differently by the two sources.
-- Output  : CROSS_CHECK
-- =============================================================================

CREATE OR REPLACE VIEW CROSS_CHECK AS
SELECT a.report_id,
       ROUND(a.compute_credits_total, 4)                                                   AS attributed_compute_credits,
       ROUND(m.reference_credits, 4)                                                       AS monitoring_credits,
       ROUND(100 * (a.compute_credits_total - m.reference_credits) / NULLIF(m.reference_credits, 0), 2) AS diff_pct,
       CASE WHEN m.reference_credits IS NULL THEN 'NO_REFERENCE'
            WHEN ABS(a.compute_credits_total - m.reference_credits) <= 0.15 * m.reference_credits THEN 'WITHIN_TOLERANCE'
            ELSE 'INVESTIGATE' END                                                         AS result
FROM REPORT_CREDIT_ATTRIBUTION a
LEFT JOIN MONITORING_REFERENCE m ON m.report_id = a.report_id;
