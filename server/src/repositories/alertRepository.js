// SQL for alerts.

import { toAlertDto } from './mappers.js';

const SELECT_WITH_NAME = `
  SELECT a.*, r.report_name
  FROM alerts a LEFT JOIN reports r ON r.report_id = a.report_id`;

export function createAlertRepository(db) {
  // Most recent alert per rule for one report (any status).
  const latestPerRuleStmt = db.prepare(
    `SELECT a.* FROM alerts a
     WHERE a.report_id = ?
       AND a.id = (SELECT MAX(b.id) FROM alerts b WHERE b.report_id = a.report_id AND b.rule = a.rule)`,
  );
  const insertStmt = db.prepare(`
    INSERT INTO alerts (report_id, rule, severity, status, message, observed_value, threshold,
                        occurrences, trigger_reading_id, created_at, last_seen_at)
    VALUES (@report_id, @rule, @severity, 'OPEN', @message, @observed_value, @threshold,
            1, @trigger_reading_id, @now, @now)
  `);
  const touchStmt = db.prepare(`
    UPDATE alerts SET occurrences = occurrences + 1, last_seen_at = @now,
                      severity = @severity, observed_value = @observed_value, message = @message
    WHERE id = @id
  `);
  const resolveStmt = db.prepare(
    `UPDATE alerts SET status = 'RESOLVED', resolved_at = ? WHERE id = ? AND status != 'RESOLVED'`,
  );
  const ackStmt = db.prepare(
    `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ?
     WHERE id = ? AND status = 'OPEN'`,
  );
  const byIdStmt = db.prepare(`${SELECT_WITH_NAME} WHERE a.id = ?`);
  const reopenStmt = db.prepare(`
    UPDATE alerts SET status = 'OPEN', resolved_at = NULL, acknowledged_at = NULL, acknowledged_by = NULL,
                      reopen_count = reopen_count + 1, occurrences = occurrences + 1, last_seen_at = @now,
                      severity = @severity, observed_value = @observed_value, message = @message
    WHERE id = @id AND status = 'RESOLVED'
  `);

  return {
    /** Most recent alert per rule for one report, keyed by rule. Feeds the alert engine. */
    latestByRule(reportId) {
      const map = {};
      for (const row of latestPerRuleStmt.all(reportId)) map[row.rule] = toAlertDto(row);
      return map;
    },

    create(alert, now) {
      const info = insertStmt.run({ ...alert, now });
      return Number(info.lastInsertRowid);
    },

    touch(id, { severity, observed_value, message }, now) {
      touchStmt.run({ id, severity, observed_value, message, now });
    },

    resolve(id, now) {
      return resolveStmt.run(now, id).changes;
    },

    acknowledge(id, userEmail, now) {
      return ackStmt.run(now, userEmail, id).changes;
    },

    reopen(id, { severity, observed_value, message }, now) {
      return reopenStmt.run({ id, severity, observed_value, message, now }).changes;
    },

    findById(id) {
      const row = byIdStmt.get(id);
      return row ? toAlertDto(row) : null;
    },

    list({ status, severity, rule, reportId, limit, offset }) {
      const where = [];
      const params = {};
      if (status === 'active') {
        where.push(`a.status IN ('OPEN', 'ACKNOWLEDGED')`);
      } else if (status) {
        where.push('a.status = @status');
        params.status = status;
      }
      if (severity) {
        where.push('a.severity = @severity');
        params.severity = severity;
      }
      if (rule) {
        where.push('a.rule = @rule');
        params.rule = rule;
      }
      if (reportId) {
        where.push('a.report_id = @reportId');
        params.reportId = reportId;
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM alerts a ${whereSql}`).get(params).n;
      const items = db
        .prepare(`${SELECT_WITH_NAME} ${whereSql} ORDER BY a.id DESC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit, offset })
        .map(toAlertDto);
      return { total, items };
    },

    counts() {
      const active = db
        .prepare(
          `SELECT severity, COUNT(*) AS n FROM alerts
           WHERE status IN ('OPEN', 'ACKNOWLEDGED') GROUP BY severity`,
        )
        .all();
      const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM alerts GROUP BY status').all();
      const totals = db
        .prepare(
          'SELECT COUNT(*) AS incidents, COALESCE(SUM(reopen_count), 0) AS reopens, COALESCE(SUM(occurrences), 0) AS breaches FROM alerts',
        )
        .get();
      const toMap = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));
      return {
        active_by_severity: { warning: 0, critical: 0, ...toMap(active, 'severity') },
        by_status: { OPEN: 0, ACKNOWLEDGED: 0, RESOLVED: 0, ...toMap(byStatus, 'status') },
        incidents_created: totals.incidents, // distinct alerts (notifications users actually saw as new)
        reopened_by_cooldown: totals.reopens, // flaps absorbed instead of becoming new alerts
        breaching_readings: totals.breaches, // what "alert on every bad reading" would have produced
      };
    },
  };
}
