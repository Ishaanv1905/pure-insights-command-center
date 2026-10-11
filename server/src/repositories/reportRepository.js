// Repository = the ONLY place that knows SQL for the reports table.
// It speaks in plain JS objects; services never see SQL, and this file never
// contains business rules.

import { toReportDto } from './mappers.js';

const SORTABLE = new Set([
  'report_id',
  'report_name',
  'avg_load_time_sec',
  'monthly_active_views',
  'snowflake_credits_consumed',
  'aws_hosting_cost_usd',
  'last_seen_at',
]);

export function createReportRepository(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO reports (
      report_id, report_name, owner_email, last_refresh_status, monthly_active_views,
      snowflake_credits_consumed, avg_load_time_sec, aws_hosting_cost_usd,
      query_count_last_30d, concurrent_user_peak, flags, reading_count, first_seen_at, last_seen_at
    ) VALUES (
      @report_id, @report_name, @owner_email, @last_refresh_status, @monthly_active_views,
      @snowflake_credits_consumed, @avg_load_time_sec, @aws_hosting_cost_usd,
      @query_count_last_30d, @concurrent_user_peak, @flags, 1, @received_at, @received_at
    )
    ON CONFLICT (report_id) DO UPDATE SET
      report_name                = COALESCE(excluded.report_name, reports.report_name),
      owner_email                = excluded.owner_email,
      last_refresh_status        = excluded.last_refresh_status,
      monthly_active_views       = excluded.monthly_active_views,
      snowflake_credits_consumed = excluded.snowflake_credits_consumed,
      avg_load_time_sec          = excluded.avg_load_time_sec,
      aws_hosting_cost_usd       = excluded.aws_hosting_cost_usd,
      query_count_last_30d       = excluded.query_count_last_30d,
      concurrent_user_peak       = excluded.concurrent_user_peak,
      flags                      = excluded.flags,
      reading_count              = reports.reading_count + 1,
      last_seen_at               = excluded.last_seen_at
  `);

  const getStmt = db.prepare('SELECT * FROM reports WHERE report_id = ?');
  const assignOwnerStmt = db.prepare('UPDATE reports SET assigned_owner_email = ? WHERE report_id = ?');

  return {
    /** Insert a new report or overwrite its current state with the latest reading. */
    upsertFromReading(reading, reportFlags) {
      upsertStmt.run({
        report_id: reading.report_id,
        report_name: reading.report_name ?? null,
        owner_email: reading.owner_email,
        last_refresh_status: reading.last_refresh_status,
        monthly_active_views: reading.monthly_active_views,
        snowflake_credits_consumed: reading.snowflake_credits_consumed,
        avg_load_time_sec: reading.avg_load_time_sec,
        aws_hosting_cost_usd: reading.aws_hosting_cost_usd,
        query_count_last_30d: reading.query_count_last_30d,
        concurrent_user_peak: reading.concurrent_user_peak,
        flags: JSON.stringify(reportFlags),
        received_at: reading.received_at,
      });
    },

    findById(reportId) {
      const row = getStmt.get(reportId);
      return row ? toReportDto(row) : null;
    },

    /** Raw row, used internally by services that need assigned_owner_email etc. */
    findRawById(reportId) {
      return getStmt.get(reportId) ?? null;
    },

    assignOwner(reportId, email) {
      return assignOwnerStmt.run(email, reportId).changes;
    },

    setFlags(reportId, flags) {
      db.prepare('UPDATE reports SET flags = ? WHERE report_id = ?').run(JSON.stringify(flags), reportId);
    },

    /**
     * Filtered, sorted, paginated list.
     * Filters are combined with AND. Every value is bound as a parameter (never
     * concatenated into SQL), and the sort column comes from an allow-list,
     * which is what protects this query from SQL injection.
     */
    list({ search, status, flag, orphaned, sort = 'report_id', order = 'asc', limit, offset }) {
      const where = [];
      const params = {};
      if (search) {
        where.push('(report_id LIKE @search OR report_name LIKE @search OR effective_owner_email LIKE @search)');
        params.search = `%${search}%`;
      }
      if (status) {
        where.push('last_refresh_status = @status');
        params.status = status;
      }
      if (flag) {
        where.push('EXISTS (SELECT 1 FROM json_each(reports.flags) WHERE value = @flag)');
        params.flag = flag;
      }
      if (orphaned !== undefined) {
        where.push('is_orphaned = @orphaned');
        params.orphaned = orphaned ? 1 : 0;
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sortCol = SORTABLE.has(sort) ? sort : 'report_id';
      const dir = order === 'desc' ? 'DESC' : 'ASC';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM reports ${whereSql}`).get(params).n;
      const rows = db
        .prepare(
          `SELECT * FROM reports ${whereSql}
           ORDER BY ${sortCol} ${dir}, report_id ASC
           LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit, offset });
      return { total, items: rows.map(toReportDto) };
    },

    /** Aggregates for the health overview. */
    summary(latencyThresholdSec, failureStatuses) {
      const placeholders = failureStatuses.map(() => '?').join(', ');
      const row = db
        .prepare(
          `SELECT
             COUNT(*)                                                  AS total_reports,
             SUM(is_orphaned)                                          AS orphaned_reports,
             SUM(avg_load_time_sec > ?)                                AS slow_reports,
             SUM(last_refresh_status IN (${placeholders}))             AS failing_reports,
             SUM(last_refresh_status = 'UNKNOWN')                      AS unknown_status_reports,
             SUM(avg_load_time_sec <= ? AND last_refresh_status = 'SUCCESS') AS healthy_reports,
             ROUND(AVG(avg_load_time_sec), 2)                          AS avg_load_time_sec,
             MAX(avg_load_time_sec)                                    AS max_load_time_sec,
             MAX(last_seen_at)                                         AS last_reading_at
           FROM reports`,
        )
        .get(latencyThresholdSec, ...failureStatuses, latencyThresholdSec);
      const byStatus = db
        .prepare('SELECT last_refresh_status AS status, COUNT(*) AS count FROM reports GROUP BY 1 ORDER BY 1')
        .all();
      return { ...row, by_refresh_status: byStatus };
    },
  };
}
