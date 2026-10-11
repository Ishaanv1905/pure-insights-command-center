// SQL for the readings table (append-only history) and rejected payloads.

import { toReadingDto } from './mappers.js';

const MAX_STORED_PAYLOAD_CHARS = 4000;

export function createReadingRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO readings (
      report_id, received_at, idempotency_key, report_name, owner_email_raw, owner_email,
      last_refresh_status, monthly_active_views, snowflake_credits_consumed, avg_load_time_sec,
      aws_hosting_cost_usd, query_count_last_30d, concurrent_user_peak, flags
    ) VALUES (
      @report_id, @received_at, @idempotency_key, @report_name, @owner_email_raw, @owner_email,
      @last_refresh_status, @monthly_active_views, @snowflake_credits_consumed, @avg_load_time_sec,
      @aws_hosting_cost_usd, @query_count_last_30d, @concurrent_user_peak, @flags
    )
  `);
  const byKeyStmt = db.prepare('SELECT * FROM readings WHERE idempotency_key = ?');
  const insertRejectedStmt = db.prepare(
    'INSERT INTO rejected_payloads (received_at, errors, payload) VALUES (?, ?, ?)',
  );

  return {
    insert(reading, idempotencyKey) {
      const info = insertStmt.run({
        report_id: reading.report_id,
        received_at: reading.received_at,
        idempotency_key: idempotencyKey ?? null,
        report_name: reading.report_name ?? null,
        owner_email_raw: reading.owner_email_raw,
        owner_email: reading.owner_email,
        last_refresh_status: reading.last_refresh_status,
        monthly_active_views: reading.monthly_active_views,
        snowflake_credits_consumed: reading.snowflake_credits_consumed,
        avg_load_time_sec: reading.avg_load_time_sec,
        aws_hosting_cost_usd: reading.aws_hosting_cost_usd,
        query_count_last_30d: reading.query_count_last_30d,
        concurrent_user_peak: reading.concurrent_user_peak,
        flags: JSON.stringify(reading.flags),
      });
      return Number(info.lastInsertRowid);
    },

    findByIdempotencyKey(key) {
      const row = byKeyStmt.get(key);
      return row ? toReadingDto(row) : null;
    },

    listForReport(reportId, { limit, offset }) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM readings WHERE report_id = ?').get(reportId).n;
      const items = db
        .prepare('SELECT * FROM readings WHERE report_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(reportId, limit, offset)
        .map(toReadingDto);
      return { total, items };
    },

    recordRejected(receivedAt, errors, payload) {
      let text;
      try {
        text = JSON.stringify(payload);
      } catch {
        text = String(payload);
      }
      if (text && text.length > MAX_STORED_PAYLOAD_CHARS) text = text.slice(0, MAX_STORED_PAYLOAD_CHARS) + '...';
      insertRejectedStmt.run(receivedAt, JSON.stringify(errors), text ?? null);
    },

    listRejected(limit = 20) {
      return db
        .prepare('SELECT * FROM rejected_payloads ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map((r) => ({ id: r.id, received_at: r.received_at, errors: JSON.parse(r.errors), payload: r.payload }));
    },

    /** Counts used by the data quality page. */
    qualityStats() {
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS total_readings,
                  COUNT(DISTINCT report_id) AS distinct_reports,
                  MIN(received_at) AS first_received_at,
                  MAX(received_at) AS last_received_at
           FROM readings`,
        )
        .get();
      const flagCounts = db
        .prepare(
          `SELECT j.value AS flag, COUNT(*) AS readings, COUNT(DISTINCT r.report_id) AS reports
           FROM readings r, json_each(r.flags) j
           GROUP BY j.value ORDER BY readings DESC`,
        )
        .all();
      const ownerRaw = db
        .prepare(
          `SELECT COALESCE(owner_email_raw, '(missing)') AS raw_value, COUNT(*) AS readings
           FROM readings WHERE owner_email IS NULL GROUP BY 1 ORDER BY readings DESC`,
        )
        .all();
      const statusCounts = db
        .prepare('SELECT last_refresh_status AS status, COUNT(*) AS readings FROM readings GROUP BY 1 ORDER BY 1')
        .all();
      const rejected = db.prepare('SELECT COUNT(*) AS n FROM rejected_payloads').get().n;
      const negativeCredits = db
        .prepare(
          `SELECT MIN(snowflake_credits_consumed) AS min_value, COUNT(*) AS readings
           FROM readings WHERE snowflake_credits_consumed < 0`,
        )
        .get();
      const latency = db
        .prepare(
          `SELECT MIN(avg_load_time_sec) AS min_sec, MAX(avg_load_time_sec) AS max_sec,
                  ROUND(AVG(avg_load_time_sec), 2) AS avg_sec
           FROM readings`,
        )
        .get();
      // Pearson correlation between views and AWS cost, computed in SQL.
      // A value near 0 means hosting cost does not follow usage, which is the
      // "active users vs AWS cost discrepancy" the case study asks us to surface.
      const corr = db
        .prepare(
          `WITH s AS (
             SELECT COUNT(*) n,
                    SUM(monthly_active_views) sx, SUM(aws_hosting_cost_usd) sy,
                    SUM(monthly_active_views * monthly_active_views) sxx,
                    SUM(aws_hosting_cost_usd * aws_hosting_cost_usd) syy,
                    SUM(monthly_active_views * aws_hosting_cost_usd) sxy
             FROM readings)
           SELECT CASE WHEN n < 2 THEN NULL ELSE
             (n * sxy - sx * sy) / (sqrt(n * sxx - sx * sx) * sqrt(n * syy - sy * sy)) END AS r
           FROM s`,
        )
        .get();
      return {
        totals,
        flag_counts: flagCounts,
        orphaned_owner_raw_values: ownerRaw,
        refresh_status_counts: statusCounts,
        rejected_payloads: rejected,
        negative_credits: negativeCredits,
        latency,
        views_vs_aws_cost_correlation: corr?.r == null ? null : Number(corr.r.toFixed(4)),
      };
    },

    /** Usage and AWS cost of every reading valid for cost math (input to the cost vs usage check). */
    usageRows(excludeFlags) {
      const placeholders = excludeFlags.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT r.id, r.report_id, rep.report_name, r.received_at, r.monthly_active_views,
                  r.concurrent_user_peak, r.aws_hosting_cost_usd
           FROM readings r JOIN reports rep ON rep.report_id = r.report_id
           WHERE NOT EXISTS (SELECT 1 FROM json_each(r.flags) WHERE value IN (${placeholders}))
           ORDER BY r.id`,
        )
        .all(...excludeFlags);
    },

    /**
     * Per-report aggregates for the cost view, over readings that are valid for cost
     * math. Readings carrying any of `excludeFlags` (e.g. NEGATIVE_CREDITS) are left
     * out of the sums and counted separately so the exclusion stays visible.
     */
    costAggregates(excludeFlags) {
      const placeholders = excludeFlags.map(() => '?').join(', ');
      const isExcluded = (alias) => `EXISTS (SELECT 1 FROM json_each(${alias}.flags) WHERE value IN (${placeholders}))`;
      return db
        .prepare(
          `SELECT r.report_id,
                  rep.report_name,
                  rep.effective_owner_email AS owner_email,
                  COUNT(*) AS valid_readings,
                  SUM(r.snowflake_credits_consumed) AS total_credits,
                  SUM(r.aws_hosting_cost_usd)       AS total_aws_cost_usd,
                  SUM(r.monthly_active_views)       AS total_views,
                  AVG(r.snowflake_credits_consumed) AS avg_monthly_credits,
                  AVG(r.aws_hosting_cost_usd)       AS avg_monthly_aws_cost_usd,
                  AVG(r.monthly_active_views)       AS avg_monthly_views,
                  (SELECT COUNT(*) FROM readings x
                    WHERE x.report_id = r.report_id AND ${isExcluded('x')}) AS excluded_readings
           FROM readings r
           JOIN reports rep ON rep.report_id = r.report_id
           WHERE NOT ${isExcluded('r')}
           GROUP BY r.report_id`,
        )
        .all(...excludeFlags, ...excludeFlags);
    },
  };
}
