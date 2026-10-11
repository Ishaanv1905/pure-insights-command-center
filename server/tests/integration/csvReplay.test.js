// Data validation test: replays the REAL case-study CSV through the ingest
// service and checks the system's numbers against independently known counts
// of the planted defects. If any cleaning rule changes behaviour, this fails.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../../feeder/csv.js';
import { rowToReading } from '../../../feeder/feeder.js';
import { buildTestContext } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.resolve(here, '..', '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv');

describe('full CSV replay (2,000 rows)', { skip: !fs.existsSync(CSV) && 'CSV not found' }, () => {
  let ctx;
  let quality;

  before(async () => {
    ctx = await buildTestContext({ seedUsers: false });
    const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
    for (const row of rows) {
      ctx.clock.advanceSeconds(1);
      ctx.container.services.ingest.ingestOne(rowToReading(row));
    }
    quality = ctx.container.services.insights.dataQuality();
  });

  const flagCount = (flag) => quality.flag_counts.find((f) => f.flag === flag)?.readings ?? 0;

  test('every row is accepted (dirty data is flagged, not rejected)', () => {
    assert.equal(quality.totals.total_readings, 2000);
    assert.equal(quality.rejected_payloads, 0);
  });

  test('100 distinct reports, 20 readings each', () => {
    assert.equal(quality.totals.distinct_reports, 100);
    const { items } = ctx.container.repos.reports.list({ limit: 200, offset: 0 });
    assert.ok(items.every((r) => r.reading_count === 20));
  });

  test('orphaned: 128 "nan" + 117 "ORPHANED_REPORT" = 245 readings', () => {
    assert.equal(flagCount('ORPHANED'), 245);
    const raw = Object.fromEntries(quality.orphaned_owner_raw_values.map((r) => [r.raw_value, r.readings]));
    assert.equal(raw.nan, 128);
    assert.equal(raw.ORPHANED_REPORT, 117);
  });

  test('24 negative-credit readings, minimum -13.6', () => {
    assert.equal(flagCount('NEGATIVE_CREDITS'), 24);
    assert.equal(quality.negative_credits.min_value, -13.6);
  });

  test('1,490 readings above 15s (7 at exactly 15.0s are not), max 55s', () => {
    assert.equal(flagCount('HIGH_LATENCY'), 1490);
    assert.equal(quality.latency.max_sec, 55);
  });

  test('refresh statuses: 382 FAILED + 182 TIMED_OUT failures, 100 UNKNOWN, 4 zero-view readings', () => {
    assert.equal(flagCount('REFRESH_FAILED'), 382 + 182);
    assert.equal(flagCount('REFRESH_UNKNOWN'), 100);
    assert.equal(flagCount('ZERO_VIEWS'), 4);
  });

  test('views and AWS cost are essentially uncorrelated (|r| < 0.1)', () => {
    assert.ok(Math.abs(quality.views_vs_aws_cost_correlation) < 0.1);
  });

  test('invariant: every currently broken report has exactly one active alert per broken rule', () => {
    const { items: reports } = ctx.container.repos.reports.list({ limit: 200, offset: 0 });
    const { items: active } = ctx.container.repos.alerts.list({ status: 'active', limit: 200, offset: 0 });
    const slow = reports
      .filter((r) => r.avg_load_time_sec > 15)
      .map((r) => r.report_id)
      .sort();
    // UNKNOWN neither opens nor resolves a refresh alert, so the refresh alert follows
    // the LAST KNOWN status of each report (ignoring trailing UNKNOWN readings).
    const lastKnownStatus = (reportId) =>
      ctx.container.repos.readings
        .listForReport(reportId, { limit: 50, offset: 0 })
        .items.find((x) => x.last_refresh_status !== 'UNKNOWN')?.last_refresh_status;
    const failing = reports
      .filter((r) => ['FAILED', 'TIMED_OUT'].includes(lastKnownStatus(r.report_id)))
      .map((r) => r.report_id)
      .sort();
    assert.deepEqual(
      active
        .filter((a) => a.rule === 'HIGH_LATENCY')
        .map((a) => a.report_id)
        .sort(),
      slow,
    );
    assert.deepEqual(
      active
        .filter((a) => a.rule === 'REFRESH_FAILED')
        .map((a) => a.report_id)
        .sort(),
      failing,
    );
  });

  test('alert fatigue is controlled: far fewer incidents than breaching readings', () => {
    const counts = ctx.container.repos.alerts.counts();
    assert.equal(counts.breaching_readings, 1490 + 564);
    assert.ok(counts.incidents_created < counts.breaching_readings / 4);
  });

  test('cost vs usage mismatches match an independent pandas calculation (defect d)', () => {
    const m = ctx.container.services.cost.getUsageMismatch();
    assert.equal(m.summary.readings_checked, 1976); // 2,000 minus 24 negative-credit readings
    assert.equal(m.summary.mismatched_readings, 148);
    assert.equal(m.summary.high_cost_low_usage, 106);
    assert.equal(m.summary.low_cost_high_usage, 38);
    assert.equal(m.summary.cost_with_no_usage, 4);
    assert.equal(m.summary.reports_affected, 76);
    assert.ok(Math.abs(m.correlation.views_vs_aws_cost) < 0.1);
    assert.ok(Math.abs(m.correlation.peak_users_vs_aws_cost) < 0.1);
  });

  test('cost view excludes the 24 negative-credit readings and never divides by zero', () => {
    const cost = ctx.container.services.cost.getCostReport();
    assert.equal(cost.summary.excluded_readings, 24);
    assert.equal(cost.items.length, 100);
    assert.ok(
      cost.items.every((i) => i.total_cost_per_view_usd === null || Number.isFinite(i.total_cost_per_view_usd)),
    );
  });
});
