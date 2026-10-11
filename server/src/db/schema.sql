-- Pure Insights Command Center - SQLite schema
-- Applied on every startup with CREATE ... IF NOT EXISTS, so it is safe to re-run.
--
-- Design: "current state" vs "history"
--   reports  = one row per report, holding its LATEST state (fast dashboard reads)
--   readings = every reading ever received, never modified (history / audit trail)
-- Timestamps are ISO-8601 UTC strings, which sort correctly as text.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('viewer', 'analyst', 'admin')),
  created_at    TEXT    NOT NULL
);

-- Sessions ended by logout before their JWT expired (rows are pruned once expired)
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  report_id                  TEXT    PRIMARY KEY,
  report_name                TEXT,
  owner_email                TEXT,             -- normalized owner from the latest reading (NULL = none)
  assigned_owner_email       TEXT,             -- set by an admin to fix an orphaned report; wins over the feed
  effective_owner_email      TEXT    GENERATED ALWAYS AS (COALESCE(assigned_owner_email, owner_email)) VIRTUAL,
  is_orphaned                INTEGER GENERATED ALWAYS AS (COALESCE(assigned_owner_email, owner_email) IS NULL) VIRTUAL,
  last_refresh_status        TEXT    NOT NULL,
  monthly_active_views       INTEGER NOT NULL,
  snowflake_credits_consumed REAL    NOT NULL,
  avg_load_time_sec          REAL    NOT NULL,
  aws_hosting_cost_usd       REAL    NOT NULL,
  query_count_last_30d       INTEGER NOT NULL,
  concurrent_user_peak       INTEGER NOT NULL,
  flags                      TEXT    NOT NULL DEFAULT '[]',  -- JSON array of data quality / health flags
  reading_count              INTEGER NOT NULL DEFAULT 0,
  first_seen_at              TEXT    NOT NULL,
  last_seen_at               TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id                  TEXT    NOT NULL REFERENCES reports (report_id),
  received_at                TEXT    NOT NULL,
  idempotency_key            TEXT    UNIQUE,   -- optional; lets a sender retry safely
  report_name                TEXT,
  owner_email_raw            TEXT,             -- exactly what was sent (e.g. "nan", "ORPHANED_REPORT")
  owner_email                TEXT,             -- normalized (NULL = no owner)
  last_refresh_status        TEXT    NOT NULL,
  monthly_active_views       INTEGER NOT NULL,
  snowflake_credits_consumed REAL    NOT NULL,  -- raw value, kept even when negative (flagged instead)
  avg_load_time_sec          REAL    NOT NULL,
  aws_hosting_cost_usd       REAL    NOT NULL,
  query_count_last_30d       INTEGER NOT NULL,
  concurrent_user_peak       INTEGER NOT NULL,
  flags                      TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_readings_report ON readings (report_id, id);

CREATE TABLE IF NOT EXISTS alerts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id          TEXT    NOT NULL REFERENCES reports (report_id),
  rule               TEXT    NOT NULL CHECK (rule IN ('HIGH_LATENCY', 'REFRESH_FAILED')),
  severity           TEXT    NOT NULL CHECK (severity IN ('warning', 'critical')),
  status             TEXT    NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  message            TEXT    NOT NULL,
  observed_value     TEXT,
  threshold          TEXT,
  occurrences        INTEGER NOT NULL DEFAULT 1,  -- how many breaching readings this alert has absorbed
  reopen_count       INTEGER NOT NULL DEFAULT 0,  -- times it re-broke within the cooldown after resolving (flapping)
  trigger_reading_id INTEGER REFERENCES readings (id),
  created_at         TEXT    NOT NULL,
  last_seen_at       TEXT    NOT NULL,
  acknowledged_at    TEXT,
  acknowledged_by    TEXT,
  resolved_at        TEXT
);
-- Invariant enforced by the database itself: at most ONE active alert per report + rule.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_one_active
  ON alerts (report_id, rule) WHERE status IN ('OPEN', 'ACKNOWLEDGED');
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_report_rule ON alerts (report_id, rule, id);

-- Requests refused at the door (malformed input). Kept so data quality issues stay visible.
CREATE TABLE IF NOT EXISTS rejected_payloads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  errors      TEXT NOT NULL,   -- JSON array of validation messages
  payload     TEXT             -- JSON, truncated to a safe size
);
