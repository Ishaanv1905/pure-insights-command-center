-- =============================================================================
-- 01_ddl.sql
-- Purpose : tables for the simulated logs.
--   Snowflake ACCOUNT_USAGE look-alikes (same names and column meanings, fewer columns):
--     QUERY_HISTORY, QUERY_ATTRIBUTION_HISTORY, WAREHOUSE_METERING_HISTORY
--   App-side tables (NOT Snowflake views; owned by the portal team):
--     REPORT_REGISTRY       which reports exist, their owner and warehouse
--     REPORT_USAGE_MONTHLY  active views per report per month (from the portal's own logs)
--     MONITORING_REFERENCE  credits per report as reported in the monitoring CSV (for cross-checking)
--     COST_CONFIG           one row of pricing assumptions (portable; no session variables)
-- Link    : the portal sets QUERY_TAG = '{"app":"pure-insights","report_id":"RPT_203"}' on every
--           query it runs (ALTER SESSION SET QUERY_TAG = ...). That tag is how a query, and so
--           its credits, is tied to a report.
-- =============================================================================

CREATE OR REPLACE TABLE QUERY_HISTORY (
    query_id                    VARCHAR,
    query_text                  VARCHAR,
    query_tag                   VARCHAR,          -- JSON string set by the portal; NULL/'' for ad hoc queries
    user_name                   VARCHAR,
    role_name                   VARCHAR,
    warehouse_name              VARCHAR,
    warehouse_size              VARCHAR,
    execution_status            VARCHAR,          -- SUCCESS / FAILED (failed queries still consume credits)
    start_time                  TIMESTAMP_NTZ,
    end_time                    TIMESTAMP_NTZ,
    total_elapsed_time          NUMBER(38, 0),    -- ms, includes queueing and compilation
    execution_time              NUMBER(38, 0),    -- ms the warehouse spent executing: the allocation driver
    bytes_scanned               NUMBER(38, 0),
    credits_used_cloud_services NUMBER(38, 9)
);

CREATE OR REPLACE TABLE QUERY_ATTRIBUTION_HISTORY (
    query_id                    VARCHAR,
    warehouse_name              VARCHAR,
    start_time                  TIMESTAMP_NTZ,
    end_time                    TIMESTAMP_NTZ,
    credits_attributed_compute  NUMBER(38, 9)     -- Snowflake's per-query compute credits, EXCLUDING idle time
);

CREATE OR REPLACE TABLE WAREHOUSE_METERING_HISTORY (
    start_time                  TIMESTAMP_NTZ,    -- start of the hour
    end_time                    TIMESTAMP_NTZ,
    warehouse_name              VARCHAR,
    credits_used_compute        NUMBER(38, 9),    -- what the warehouse actually billed in that hour (incl. idle)
    credits_used_cloud_services NUMBER(38, 9),
    credits_used                NUMBER(38, 9)
);

CREATE OR REPLACE TABLE REPORT_REGISTRY (
    report_id                   VARCHAR,
    report_name                 VARCHAR,
    owner_email                 VARCHAR,          -- NULL = orphaned report
    warehouse_name              VARCHAR
);

CREATE OR REPLACE TABLE REPORT_USAGE_MONTHLY (
    report_id                   VARCHAR,
    month                       DATE,
    active_views                NUMBER(38, 0)
);

CREATE OR REPLACE TABLE MONITORING_REFERENCE (
    report_id                   VARCHAR,
    reference_credits           NUMBER(38, 9)
);

CREATE OR REPLACE TABLE COST_CONFIG (
    credit_price_usd            NUMBER(38, 4),    -- assumption: $3.00 per credit (edition and region dependent)
    period_start                DATE,
    period_end                  DATE
);
