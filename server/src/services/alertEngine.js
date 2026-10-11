// PURE FUNCTIONS: decide what should happen to alerts when a reading arrives.
//
// Why not "alert on every slow reading"? In the dataset about 1,490 of 2,000
// readings are over 15s. Alerting on each one would flood the screen and people
// would stop reading alerts (alert fatigue). Instead each (report, rule) pair is
// a small state machine:
//
//   healthy --breach--> new OPEN alert                    (broadcast "alert.created": a new incident)
//   OPEN/ACKNOWLEDGED --breach again--> same alert,
//                         occurrences + 1                 (silent; "alert.updated" only if severity escalates)
//   OPEN/ACKNOWLEDGED --healthy--> RESOLVED               (broadcast "alert.resolved")
//   RESOLVED --breach within the cooldown--> REOPEN       (broadcast "alert.updated", no new incident)
//
// The cooldown handles a flapping report (bad, good, bad, good...). Instead of a
// fresh alert every few seconds, the recently resolved alert is reopened. The
// alert list stays truthful (a broken report always has an active alert) while
// the number of "new incident" notifications stays low.
//
// The engine returns a list of ACTIONS. It never touches the database; the
// ingest service applies the actions inside a transaction.

export const RULES = Object.freeze({ HIGH_LATENCY: 'HIGH_LATENCY', REFRESH_FAILED: 'REFRESH_FAILED' });

const SEVERITY_RANK = { warning: 1, critical: 2 };
const maxSeverity = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/** Evaluate every rule against one reading. */
export function evaluateRules(reading, rules) {
  const latency = reading.avg_load_time_sec;
  const latencyBreached = latency > rules.latencyThresholdSec;

  // A rule can be breached (true), healthy (false) or UNDETERMINED (null).
  // UNKNOWN refresh status is undetermined: it is not evidence of a failure,
  // and it is not evidence of a recovery either, so it must not open OR resolve
  // a refresh alert.
  const status = reading.last_refresh_status;
  const refreshBreached = status === 'UNKNOWN' ? null : rules.failureStatuses.includes(status);

  return [
    {
      rule: RULES.HIGH_LATENCY,
      breached: latencyBreached,
      severity: latency > rules.latencyCriticalSec ? 'critical' : 'warning',
      observed_value: String(latency),
      threshold: `> ${rules.latencyThresholdSec}s`,
      message: `${reading.report_id} average load time ${latency}s exceeds the ${rules.latencyThresholdSec}s threshold`,
    },
    {
      rule: RULES.REFRESH_FAILED,
      breached: refreshBreached,
      severity: status === 'FAILED' ? 'critical' : 'warning',
      observed_value: status,
      threshold: `status in [${rules.failureStatuses.join(', ')}]`,
      message: `${reading.report_id} automated refresh ${status === 'TIMED_OUT' ? 'timed out' : 'failed'}`,
    },
  ];
}

/**
 * @param {object}   args
 * @param {object}   args.reading             normalized reading (from processReading)
 * @param {object}   args.latestByRule  { [rule]: most recent alert (any status) } for this report
 * @param {Date}     args.now
 * @param {object}   args.rules         config.alerts
 * @returns {Array<object>} actions: create | touch | reopen | resolve
 */
export function decideAlertActions({ reading, latestByRule, now, rules }) {
  const actions = [];

  for (const result of evaluateRules(reading, rules)) {
    if (result.breached === null) continue; // undetermined: leave this rule's alert exactly as it is
    const latest = latestByRule[result.rule];
    const active = latest && latest.status !== 'RESOLVED' ? latest : undefined;

    if (result.breached && active) {
      const severity = maxSeverity(active.severity, result.severity);
      actions.push({
        type: 'touch',
        alertId: active.id,
        rule: result.rule,
        severity,
        escalated: severity !== active.severity,
        observed_value: result.observed_value,
        message: result.message,
      });
    } else if (result.breached && !active) {
      const recentlyResolved =
        latest?.resolved_at && now.getTime() - Date.parse(latest.resolved_at) < rules.cooldownSec * 1000;
      if (recentlyResolved) {
        actions.push({
          type: 'reopen',
          alertId: latest.id,
          rule: result.rule,
          severity: result.severity,
          observed_value: result.observed_value,
          message: result.message,
        });
      } else {
        actions.push({
          type: 'create',
          rule: result.rule,
          severity: result.severity,
          observed_value: result.observed_value,
          threshold: result.threshold,
          message: result.message,
        });
      }
    } else if (!result.breached && active) {
      actions.push({ type: 'resolve', alertId: active.id, rule: result.rule });
    }
    // not breached and no active alert: nothing to do
  }

  return actions;
}
