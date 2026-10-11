// Row -> API object mappers. Keeps "how it is stored" (JSON text, 0/1 integers)
// separate from "how the API presents it" (arrays, booleans).

export function parseFlags(text) {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function toReportDto(row) {
  return {
    report_id: row.report_id,
    report_name: row.report_name,
    owner_email: row.effective_owner_email,
    owner_source: row.assigned_owner_email ? 'assigned' : row.owner_email ? 'feed' : null,
    is_orphaned: row.is_orphaned === 1,
    last_refresh_status: row.last_refresh_status,
    monthly_active_views: row.monthly_active_views,
    snowflake_credits_consumed: row.snowflake_credits_consumed,
    avg_load_time_sec: row.avg_load_time_sec,
    aws_hosting_cost_usd: row.aws_hosting_cost_usd,
    query_count_last_30d: row.query_count_last_30d,
    concurrent_user_peak: row.concurrent_user_peak,
    flags: parseFlags(row.flags),
    reading_count: row.reading_count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

export function toReadingDto(row) {
  return {
    id: row.id,
    report_id: row.report_id,
    received_at: row.received_at,
    owner_email_raw: row.owner_email_raw,
    owner_email: row.owner_email,
    last_refresh_status: row.last_refresh_status,
    monthly_active_views: row.monthly_active_views,
    snowflake_credits_consumed: row.snowflake_credits_consumed,
    avg_load_time_sec: row.avg_load_time_sec,
    aws_hosting_cost_usd: row.aws_hosting_cost_usd,
    query_count_last_30d: row.query_count_last_30d,
    concurrent_user_peak: row.concurrent_user_peak,
    flags: parseFlags(row.flags),
  };
}

export function toAlertDto(row) {
  return {
    id: row.id,
    report_id: row.report_id,
    report_name: row.report_name ?? undefined,
    rule: row.rule,
    severity: row.severity,
    status: row.status,
    message: row.message,
    observed_value: row.observed_value,
    threshold: row.threshold,
    occurrences: row.occurrences,
    reopen_count: row.reopen_count,
    trigger_reading_id: row.trigger_reading_id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    resolved_at: row.resolved_at,
  };
}
