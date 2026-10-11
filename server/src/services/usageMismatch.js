// Defect (d): "discrepancies between active user counts and AWS hosting compute costs".
//
// Hosting cost should roughly follow usage. On this data it does not (correlation
// is about 0), so the useful output is WHICH readings and reports are out of line.
//
// Method (PURE function, so it is unit-tested with hand-made numbers):
//   1. For every reading valid for cost math, compute two ratios:
//        AWS cost per monthly active view   and   AWS cost per peak concurrent user
//      (the brief says "active user counts"; the data has both measures, so both are used).
//   2. Take the log of each ratio. Cost ratios are skewed (a few huge values), and
//      on the log scale "10x too expensive" and "10x too cheap" are equally far apart.
//   3. Tukey fences: Q1 - k*IQR and Q3 + k*IQR (k = 1.5, the standard box-plot rule).
//      Quartiles are robust: the outliers themselves cannot drag the fences.
//   4. A reading is a mismatch if either ratio is outside its fences:
//        high_cost_low_usage  - paying far more than usual for the usage it serves
//        low_cost_high_usage  - serving far more usage than its cost suggests
//      plus cost_with_no_usage - AWS cost while nobody viewed the report.
// The fences are learned from the data, so no dollar threshold is hard-coded.

const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** Linear-interpolation quantile of a SORTED array (same as numpy's default). */
export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/** Tukey fences for log(ratio); returned in dollars for readability. */
function fencesFor(logValues, k) {
  const sorted = [...logValues].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  if (q1 === null) return null;
  const iqr = q3 - q1;
  return { lowLog: q1 - k * iqr, highLog: q3 + k * iqr, medianLog: quantile(sorted, 0.5) };
}

const METRICS = [
  { key: 'per_view', usage: 'monthly_active_views', label: 'AWS cost per active view' },
  { key: 'per_peak_user', usage: 'concurrent_user_peak', label: 'AWS cost per peak concurrent user' },
];

/**
 * @param {Array<{id, report_id, report_name?, received_at, monthly_active_views,
 *                concurrent_user_peak, aws_hosting_cost_usd}>} readings  valid-for-cost readings
 * @param {{ iqrK: number }} options
 */
export function findUsageMismatches(readings, { iqrK = 1.5 } = {}) {
  const fences = {};
  for (const m of METRICS) {
    const logs = readings
      .filter((r) => r[m.usage] > 0 && r.aws_hosting_cost_usd > 0)
      .map((r) => Math.log(r.aws_hosting_cost_usd / r[m.usage]));
    fences[m.key] = fencesFor(logs, iqrK);
  }

  const mismatches = [];
  for (const r of readings) {
    const reasons = [];
    if (r.monthly_active_views === 0 && r.aws_hosting_cost_usd > 0) {
      reasons.push({ metric: 'per_view', direction: 'cost_with_no_usage', ratio: null, times_beyond_fence: null });
    }
    for (const m of METRICS) {
      const f = fences[m.key];
      if (!f || !(r[m.usage] > 0) || !(r.aws_hosting_cost_usd > 0)) continue;
      const logRatio = Math.log(r.aws_hosting_cost_usd / r[m.usage]);
      // How far outside the fence, as a multiple: 2 means "twice as extreme as the fence allows".
      if (logRatio > f.highLog) {
        reasons.push({
          metric: m.key,
          direction: 'high_cost_low_usage',
          ratio: round(Math.exp(logRatio)),
          times_beyond_fence: round(Math.exp(logRatio - f.highLog), 2),
        });
      } else if (logRatio < f.lowLog) {
        reasons.push({
          metric: m.key,
          direction: 'low_cost_high_usage',
          ratio: round(Math.exp(logRatio)),
          times_beyond_fence: round(Math.exp(f.lowLog - logRatio), 2),
        });
      }
    }
    if (reasons.length) {
      const direction = reasons.some((x) => x.direction === 'cost_with_no_usage')
        ? 'cost_with_no_usage'
        : reasons.some((x) => x.direction === 'high_cost_low_usage')
          ? 'high_cost_low_usage'
          : 'low_cost_high_usage';
      mismatches.push({
        reading_id: r.id,
        report_id: r.report_id,
        report_name: r.report_name ?? null,
        received_at: r.received_at,
        monthly_active_views: r.monthly_active_views,
        concurrent_user_peak: r.concurrent_user_peak,
        aws_hosting_cost_usd: r.aws_hosting_cost_usd,
        aws_cost_per_view_usd:
          r.monthly_active_views > 0 ? round(r.aws_hosting_cost_usd / r.monthly_active_views) : null,
        aws_cost_per_peak_user_usd:
          r.concurrent_user_peak > 0 ? round(r.aws_hosting_cost_usd / r.concurrent_user_peak) : null,
        direction,
        reasons,
        times_beyond_fence: Math.max(...reasons.map((x) => x.times_beyond_fence ?? Infinity)), // cost with no usage ranks first
      });
    }
  }
  // Most extreme first: cost-with-no-usage, then furthest outside the fences.
  mismatches.sort((a, b) => b.times_beyond_fence - a.times_beyond_fence || a.reading_id - b.reading_id);
  for (const m of mismatches) if (!Number.isFinite(m.times_beyond_fence)) m.times_beyond_fence = null;

  // Per-report roll-up
  const byReport = new Map();
  for (const m of mismatches) {
    const entry = byReport.get(m.report_id) ?? {
      report_id: m.report_id,
      report_name: m.report_name,
      mismatched_readings: 0,
      high_cost_low_usage: 0,
      low_cost_high_usage: 0,
      cost_with_no_usage: 0,
      last_mismatch_at: null,
    };
    entry.mismatched_readings += 1;
    entry[m.direction] += 1;
    if (!entry.last_mismatch_at || m.received_at > entry.last_mismatch_at) entry.last_mismatch_at = m.received_at;
    byReport.set(m.report_id, entry);
  }
  const reports = [...byReport.values()].sort(
    (a, b) =>
      b.high_cost_low_usage + b.cost_with_no_usage - (a.high_cost_low_usage + a.cost_with_no_usage) ||
      b.mismatched_readings - a.mismatched_readings,
  );

  const withUsage = (key) => readings.filter((r) => r[key] !== undefined);
  const count = (dir) => mismatches.filter((m) => m.direction === dir).length;
  const fenceUsd = (f) =>
    f && { low: round(Math.exp(f.lowLog)), median: round(Math.exp(f.medianLog)), high: round(Math.exp(f.highLog)) };

  return {
    method: {
      rule: `Tukey fences on log(cost / usage), k = ${iqrK}, learned from all readings valid for cost math`,
      metrics: METRICS.map((m) => m.label),
    },
    fences_usd: { per_view: fenceUsd(fences.per_view), per_peak_user: fenceUsd(fences.per_peak_user) },
    correlation: {
      views_vs_aws_cost: round(
        pearson(
          withUsage('monthly_active_views').map((r) => r.monthly_active_views),
          readings.map((r) => r.aws_hosting_cost_usd),
        ),
      ),
      peak_users_vs_aws_cost: round(
        pearson(
          withUsage('concurrent_user_peak').map((r) => r.concurrent_user_peak),
          readings.map((r) => r.aws_hosting_cost_usd),
        ),
      ),
    },
    summary: {
      readings_checked: readings.length,
      mismatched_readings: mismatches.length,
      high_cost_low_usage: count('high_cost_low_usage'),
      low_cost_high_usage: count('low_cost_high_usage'),
      cost_with_no_usage: count('cost_with_no_usage'),
      reports_affected: reports.length,
    },
    reports,
    readings: mismatches,
  };
}
