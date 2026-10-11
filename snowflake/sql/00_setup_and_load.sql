-- =============================================================================
-- 00_setup_and_load.sql
-- Purpose : create the database objects and load the simulated logs (Snowflake only).
-- Run     : once, as a role that can create databases (e.g. SYSADMIN), before 01_ddl.sql
--           has created the tables and after the CSVs in snowflake/data/ are staged.
-- Note    : the real views live in SNOWFLAKE.ACCOUNT_USAGE. We cannot write into those,
--           so the simulated copies live in PURE_INSIGHTS.ACCOUNT_USAGE_SIM with the same
--           names and column meanings. Pointing the suite at production means replacing
--           the schema name; the queries do not change.
-- Local   : statements marked @snowflake-only are skipped by verify/run_local.py.
-- =============================================================================

-- @snowflake-only
CREATE DATABASE IF NOT EXISTS PURE_INSIGHTS;
-- @snowflake-only
CREATE SCHEMA IF NOT EXISTS PURE_INSIGHTS.ACCOUNT_USAGE_SIM;
-- @snowflake-only
CREATE WAREHOUSE IF NOT EXISTS COST_ANALYSIS_WH WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;
-- @snowflake-only
USE SCHEMA PURE_INSIGHTS.ACCOUNT_USAGE_SIM;
-- @snowflake-only
CREATE OR REPLACE FILE FORMAT CSV_WITH_HEADER TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"' EMPTY_FIELD_AS_NULL = TRUE NULL_IF = ('');
-- @snowflake-only
CREATE OR REPLACE STAGE SIM_LOGS FILE_FORMAT = CSV_WITH_HEADER;

-- From SnowSQL on your machine (run in the project folder), upload the files:
--   PUT file://snowflake/data/*.csv @SIM_LOGS AUTO_COMPRESS = TRUE;
-- Then run 01_ddl.sql, then the COPY commands below.

-- @snowflake-only
COPY INTO QUERY_HISTORY FROM @SIM_LOGS/query_history.csv.gz;
-- @snowflake-only
COPY INTO QUERY_ATTRIBUTION_HISTORY FROM @SIM_LOGS/query_attribution_history.csv.gz;
-- @snowflake-only
COPY INTO WAREHOUSE_METERING_HISTORY FROM @SIM_LOGS/warehouse_metering_history.csv.gz;
-- @snowflake-only
COPY INTO REPORT_REGISTRY FROM @SIM_LOGS/report_registry.csv.gz;
-- @snowflake-only
COPY INTO REPORT_USAGE_MONTHLY FROM @SIM_LOGS/report_usage_monthly.csv.gz;
-- @snowflake-only
COPY INTO MONITORING_REFERENCE FROM @SIM_LOGS/monitoring_reference.csv.gz;
-- @snowflake-only
COPY INTO COST_CONFIG FROM @SIM_LOGS/cost_config.csv.gz;
