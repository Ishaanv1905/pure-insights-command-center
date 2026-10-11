// The colour key: the single source of truth for what colour means in this app.
//
// Colour carries meaning in exactly five status tones plus one interactive colour:
//   critical (red)       broken now, needs action
//   warning (amber)      degraded
//   healthy (green)      working or resolved
//   dq (violet)          something is wrong with the DATA, not the system
//   neutral (grey)       unknown or informational
//   accent (teal)        interactive only (links, primary buttons, selected tab, focus ring)
//
// Components never pick a colour themselves. They ask this module for a tone
// ("critical", "warning", ...) and render it with the matching CSS class
// (`tone-critical`, ...). The actual colour values live only in the CSS custom
// properties at the top of styles.css. Documented in docs/ui-colour-key.md.

/** The five status tones. `token` is the CSS custom property prefix in styles.css. */
export const TONES = {
  critical: { name: 'Red', title: 'Critical', meaning: 'Broken now and needs action.' },
  warning: {
    name: 'Amber',
    title: 'Warning',
    meaning: 'Degraded: working, but slower or less reliable than it should be.',
  },
  healthy: { name: 'Green', title: 'Healthy', meaning: 'Working, or a problem that has been resolved.' },
  dq: {
    name: 'Violet',
    title: 'Data quality',
    meaning: 'Something is wrong with the data itself, not with the system.',
  },
  neutral: { name: 'Grey', title: 'Neutral', meaning: 'Unknown, or information without a judgement.' },
};

/** CSS class for a tone. Every coloured element in the app goes through this. */
export const toneClass = (tone) => `tone-${tone ?? 'neutral'}`;

/** Load time thresholds in seconds (match the server's alert rules). */
export const LATENCY = { warningAboveSec: 15, criticalAboveSec: 30 };

export const SEVERITY = {
  critical: { tone: 'critical', label: 'Critical' },
  warning: { tone: 'warning', label: 'Warning' },
};

export const REFRESH_STATUS = {
  SUCCESS: { tone: 'healthy', label: 'Success' },
  FAILED: { tone: 'critical', label: 'Failed' },
  TIMED_OUT: { tone: 'warning', label: 'Timed out' },
  UNKNOWN: { tone: 'neutral', label: 'Unknown' },
};

/**
 * Alert lifecycle status. Drawn as OUTLINED badges so it never competes with the
 * filled severity badge next to it. `tone: null` means the ink outline.
 */
export const ALERT_STATUS = {
  OPEN: { tone: null, label: 'Open' },
  ACKNOWLEDGED: { tone: 'neutral', label: 'Acknowledged' },
  RESOLVED: { tone: 'healthy', label: 'Resolved' },
};

/** Data flags attached to readings and reports. */
export const FLAGS = {
  REFRESH_FAILED: { tone: 'critical', label: 'Refresh failed' },
  HIGH_LATENCY: { tone: 'warning', label: 'High latency' },
  REFRESH_UNKNOWN: { tone: 'neutral', label: 'Refresh unknown' },
  ORPHANED: { tone: 'dq', label: 'Orphaned' },
  NEGATIVE_CREDITS: { tone: 'dq', label: 'Negative credits' },
  NEGATIVE_METRIC: { tone: 'dq', label: 'Negative metric' },
  ZERO_VIEWS: { tone: 'dq', label: 'No views' },
};

/** Cost vs usage mismatch directions (all data-quality findings). */
export const MISMATCH = {
  high_cost_low_usage: { tone: 'dq', label: 'High cost, low usage' },
  low_cost_high_usage: { tone: 'dq', label: 'Low cost, high usage' },
  cost_with_no_usage: { tone: 'dq', label: 'Cost with no views' },
};

/** Tone for a load time in seconds: coloured only when it crosses a threshold. */
export function loadTone(sec) {
  if (sec === null || sec === undefined) return null;
  if (sec > LATENCY.criticalAboveSec) return 'critical';
  if (sec > LATENCY.warningAboveSec) return 'warning';
  return null;
}

/** Negative credits are impossible values, so they are a data-quality finding. */
export const creditsTone = (credits) => (credits < 0 ? 'dq' : null);

/**
 * Style for one flag. The server raises REFRESH_FAILED for both FAILED and
 * TIMED_OUT, and HIGH_LATENCY for anything over 15 s. When the reading is known,
 * the badge follows the same rules as the status badge and the load time next to
 * it, so a row never shows two different colours for one problem:
 *   REFRESH_FAILED + TIMED_OUT -> amber "Refresh timed out"
 *   HIGH_LATENCY + load > 30 s -> red "High latency"
 */
export function flagStyle(flag, context = {}) {
  const base = FLAGS[flag] ?? { tone: 'neutral', label: humanise(flag) };
  if (flag === 'REFRESH_FAILED' && context.status === 'TIMED_OUT') {
    return { tone: 'warning', label: 'Refresh timed out' };
  }
  if (flag === 'HIGH_LATENCY' && loadTone(context.loadSec) === 'critical') {
    return { ...base, tone: 'critical' };
  }
  return base;
}

/**
 * A report's worst current state, used by the report panel on the overview.
 * Orphaned is shown separately (a violet dot) because it is a data problem,
 * not a health state.
 */
export function reportState(report) {
  const status = report.last_refresh_status;
  const load = loadTone(report.avg_load_time_sec);
  if (status === 'FAILED' || load === 'critical') return 'critical';
  if (status === 'TIMED_OUT' || load === 'warning') return 'warning';
  if (status === 'UNKNOWN') return 'neutral';
  return 'healthy';
}

/** Legend for the report panel, in reading order. */
export const REPORT_STATES = [
  { tone: 'critical', label: 'Broken', hint: 'refresh failed or load over 30 s' },
  { tone: 'warning', label: 'Degraded', hint: 'refresh timed out or load 15 to 30 s' },
  { tone: 'neutral', label: 'Unknown', hint: 'refresh status not reported' },
  { tone: 'healthy', label: 'Healthy', hint: 'refreshed and fast' },
];

/** Live activity entries on the Alerts page. */
export function feedEventStyle(type, alert) {
  if (type === 'alert.created') {
    return { tone: SEVERITY[alert.severity]?.tone ?? 'warning', label: `New ${alert.severity ?? ''}`.trim() };
  }
  if (type === 'alert.resolved') return { tone: 'healthy', label: 'Resolved' };
  if (alert.change === 'acknowledged') return { tone: 'neutral', label: 'Acknowledged' };
  if (alert.change === 'escalated') return { tone: 'warning', label: 'Escalated' };
  if (alert.change === 'reopened') return { tone: 'warning', label: 'Reopened' };
  return { tone: 'neutral', label: 'Updated' };
}

/** Connection status of the live WebSocket (a status, so it uses status tones). */
export const CONNECTION = {
  connected: { tone: 'healthy', label: 'Live' },
  connecting: { tone: 'warning', label: 'Reconnecting' },
  disconnected: { tone: 'critical', label: 'Offline' },
};

/** Content of the "Colour key" dialog. Examples are rendered as real badges. */
export const KEY_ENTRIES = [
  {
    tone: 'critical',
    examples: ['Critical severity', 'Refresh failed', 'Load time over 30 s'],
  },
  {
    tone: 'warning',
    examples: ['Warning severity', 'Refresh timed out', 'High latency (15 to 30 s)'],
  },
  {
    tone: 'healthy',
    examples: ['Refresh succeeded', 'Resolved alert', 'Healthy reports'],
  },
  {
    tone: 'dq',
    examples: ['Orphaned', 'Negative credits', 'Negative metric', 'No views', 'Cost vs usage mismatch'],
  },
  {
    tone: 'neutral',
    examples: ['Refresh unknown', 'Acknowledged alert', 'Counts such as breaches'],
  },
];

function humanise(value) {
  const text = String(value ?? '')
    .replaceAll('_', ' ')
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
