// PURE FUNCTION: validate, normalize and flag one incoming reading.
// No database, no HTTP, no clock - just input -> output. That is what makes it
// trivial to unit test with hand-written rows.
//
// The key idea is the split between REJECT and FLAG:
//   REJECT = the request is structurally unusable (missing id, wrong type, unknown status).
//            The caller answers 400 and nothing is stored as a reading.
//   FLAG   = the request is well-formed but the data is unusual or implausible
//            (no owner, negative credits, slow, failed refresh). It is stored,
//            labelled, and handled downstream (alerts, cost exclusion, UI badges).

export const REFRESH_STATUSES = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];

// Integer counters vs decimal measurements
export const INTEGER_FIELDS = ['monthly_active_views', 'query_count_last_30d', 'concurrent_user_peak'];
export const DECIMAL_FIELDS = ['snowflake_credits_consumed', 'avg_load_time_sec', 'aws_hosting_cost_usd'];
export const NUMERIC_FIELDS = [...INTEGER_FIELDS, ...DECIMAL_FIELDS];

// Owner values that mean "nobody owns this report". The CSV uses the literal
// text "nan" (an export artefact of a missing value) and the sentinel "ORPHANED_REPORT".
const ORPHAN_SENTINELS = new Set(['', 'nan', 'null', 'none', 'orphaned_report']);

export const FLAGS = Object.freeze({
  ORPHANED: 'ORPHANED', // no usable owner email
  NEGATIVE_CREDITS: 'NEGATIVE_CREDITS', // Snowflake credits < 0: impossible, excluded from cost math
  NEGATIVE_METRIC: 'NEGATIVE_METRIC', // any other numeric field < 0
  HIGH_LATENCY: 'HIGH_LATENCY', // avg_load_time_sec > threshold (strictly greater)
  REFRESH_FAILED: 'REFRESH_FAILED', // last refresh FAILED or TIMED_OUT
  REFRESH_UNKNOWN: 'REFRESH_UNKNOWN', // refresh state not reported
  ZERO_VIEWS: 'ZERO_VIEWS', // no views: cost per view is undefined for this reading
});

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

export function normalizeOwner(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (ORPHAN_SENTINELS.has(text.toLowerCase())) return null;
  return text;
}

/**
 * @param {unknown} input  parsed JSON body
 * @param {{ latencyThresholdSec: number, failureStatuses: string[] }} rules
 * @returns {{ ok: false, errors: string[] } | { ok: true, reading: object }}
 */
export function processReading(input, rules) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const errors = [];

  // report_id: required identity
  const reportId = typeof input.report_id === 'string' ? input.report_id.trim() : '';
  if (!reportId) errors.push('report_id is required and must be a non-empty string');
  else if (reportId.length > MAX_ID_LENGTH) errors.push(`report_id must be at most ${MAX_ID_LENGTH} characters`);

  // report_name: optional
  let reportName = null;
  if (input.report_name !== undefined && input.report_name !== null) {
    if (typeof input.report_name !== 'string') errors.push('report_name must be a string');
    else if (input.report_name.length > MAX_NAME_LENGTH) errors.push('report_name is too long');
    else reportName = input.report_name.trim() || null;
  }

  // owner_email: optional; a missing owner is valid data (an orphaned report)
  if (input.owner_email !== undefined && input.owner_email !== null) {
    if (typeof input.owner_email !== 'string') errors.push('owner_email must be a string or null');
    else if (input.owner_email.length > MAX_EMAIL_LENGTH) errors.push('owner_email is too long');
  }

  // last_refresh_status: required enum (trimmed and upper-cased first, to tolerate harmless formatting noise)
  const status = typeof input.last_refresh_status === 'string' ? input.last_refresh_status.trim().toUpperCase() : '';
  if (!REFRESH_STATUSES.includes(status)) {
    errors.push(`last_refresh_status must be one of ${REFRESH_STATUSES.join(', ')}`);
  }

  // numeric fields: required, real JSON numbers (strings like "17.8" are rejected, NaN/Infinity too)
  for (const field of NUMERIC_FIELDS) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${field} is required and must be a finite number`);
    } else if (INTEGER_FIELDS.includes(field) && !Number.isInteger(value)) {
      errors.push(`${field} must be an integer`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- Normalize ----
  const ownerRaw = typeof input.owner_email === 'string' ? input.owner_email : null;
  const owner = normalizeOwner(ownerRaw);

  const reading = {
    report_id: reportId,
    report_name: reportName,
    owner_email_raw: ownerRaw,
    owner_email: owner,
    last_refresh_status: status,
  };
  for (const field of NUMERIC_FIELDS) reading[field] = input[field];

  // ---- Flag ----
  const flags = [];
  if (owner === null) flags.push(FLAGS.ORPHANED);
  if (reading.snowflake_credits_consumed < 0) flags.push(FLAGS.NEGATIVE_CREDITS);
  if (NUMERIC_FIELDS.some((f) => f !== 'snowflake_credits_consumed' && reading[f] < 0)) {
    flags.push(FLAGS.NEGATIVE_METRIC);
  }
  if (reading.avg_load_time_sec > rules.latencyThresholdSec) flags.push(FLAGS.HIGH_LATENCY);
  if (rules.failureStatuses.includes(status)) flags.push(FLAGS.REFRESH_FAILED);
  if (status === 'UNKNOWN') flags.push(FLAGS.REFRESH_UNKNOWN);
  if (reading.monthly_active_views === 0) flags.push(FLAGS.ZERO_VIEWS);

  reading.flags = flags;
  return { ok: true, reading };
}

/**
 * A REPORT's flags = its latest reading's flags, except ORPHANED depends on the
 * report's effective owner (an admin assignment counts as an owner even when the
 * feed sends none). Used by both ingestion and owner assignment, so they agree.
 */
export function withOwnershipFlag(flags, hasOwner) {
  const rest = flags.filter((f) => f !== FLAGS.ORPHANED);
  return hasOwner ? rest : [FLAGS.ORPHANED, ...rest];
}

/** Flags that make a reading unusable for cost calculations. */
export const COST_EXCLUDING_FLAGS = [FLAGS.NEGATIVE_CREDITS, FLAGS.NEGATIVE_METRIC];
