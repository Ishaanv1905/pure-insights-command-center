// Aggregated views: the health overview and the data quality report.

import { FLAGS, COST_EXCLUDING_FLAGS } from './readingValidator.js';
import { findUsageMismatches } from './usageMismatch.js';

// What each flag means and how the system handles it. Served to the UI so the
// data quality page explains itself, and kept next to the code that defines it.
export const FLAG_HANDLING = {
  [FLAGS.ORPHANED]:
    'Owner missing, "nan" or "ORPHANED_REPORT". Kept and listed on the Orphaned page; admins can assign an owner.',
  [FLAGS.NEGATIVE_CREDITS]:
    'Snowflake credits below zero are impossible. Reading kept for audit, excluded from all cost math.',
  [FLAGS.NEGATIVE_METRIC]: 'Another numeric field below zero. Kept for audit, excluded from cost math.',
  [FLAGS.HIGH_LATENCY]: 'Average load time above the threshold. Drives the HIGH_LATENCY alert rule.',
  [FLAGS.REFRESH_FAILED]: 'Refresh FAILED or TIMED_OUT. Drives the REFRESH_FAILED alert rule.',
  [FLAGS.REFRESH_UNKNOWN]: 'Refresh status not reported. Shown as a warning, does not raise an alert.',
  [FLAGS.ZERO_VIEWS]:
    'No active views: cost per view is undefined for this reading (ratio-of-sums avoids division by zero).',
};

export function createInsightService({ repos, config, getRealtimeClients }) {
  const { reports, readings, alerts } = repos;

  return {
    healthSummary() {
      const { latencyThresholdSec, latencyCriticalSec, failureStatuses, cooldownSec } = config.alerts;
      const reportStats = reports.summary(latencyThresholdSec, failureStatuses);
      const ingest = readings.qualityStats();
      return {
        reports: {
          total: reportStats.total_reports ?? 0,
          healthy: reportStats.healthy_reports ?? 0,
          slow: reportStats.slow_reports ?? 0,
          failing_refresh: reportStats.failing_reports ?? 0,
          unknown_refresh: reportStats.unknown_status_reports ?? 0,
          orphaned: reportStats.orphaned_reports ?? 0,
          avg_load_time_sec: reportStats.avg_load_time_sec,
          max_load_time_sec: reportStats.max_load_time_sec,
          by_refresh_status: reportStats.by_refresh_status,
        },
        alerts: alerts.counts(),
        ingestion: {
          total_readings: ingest.totals.total_readings,
          rejected_payloads: ingest.rejected_payloads,
          last_reading_at: reportStats.last_reading_at,
        },
        realtime: { connected_clients: getRealtimeClients() },
        thresholds: {
          latency_threshold_sec: latencyThresholdSec,
          latency_critical_sec: latencyCriticalSec,
          failure_statuses: failureStatuses,
          alert_cooldown_sec: cooldownSec,
        },
      };
    },

    dataQuality() {
      const stats = readings.qualityStats();
      const mismatch = findUsageMismatches(readings.usageRows(COST_EXCLUDING_FLAGS), {
        iqrK: config.cost.mismatchIqrK,
      });
      return {
        ...stats,
        cost_usage_mismatch: {
          ...mismatch.summary,
          correlation: mismatch.correlation,
          fences_usd: mismatch.fences_usd,
        },
        flag_handling: FLAG_HANDLING,
        recent_rejections: readings.listRejected(20),
      };
    },
  };
}
