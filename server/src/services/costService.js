// In-app cost attribution from the monitoring feed (Task 1 dashboard view).
// Task 3 (the Snowflake ACCOUNT_USAGE SQL suite) is a separate deliverable;
// this view answers the same business question from the data the app already has.
//
// Method (all assumptions are returned with the result, so the UI can show them):
//   - Each reading carries MONTHLY figures. A report's cost metrics are computed
//     over all of its readings that are valid for cost math.
//   - Readings flagged NEGATIVE_CREDITS / NEGATIVE_METRIC are excluded and counted.
//   - Per-view ratios use "ratio of sums" (total cost / total views), not the
//     average of per-reading ratios, so a reading with 0 views cannot cause a
//     division by zero or blow up the average.
//   - Dollar cost of credits = credits x CREDIT_PRICE_USD (configurable assumption).
//   - A report is a cost outlier when its cost per view is more than
//     COST_OUTLIER_MULTIPLIER x the median cost per view across reports.

import { COST_EXCLUDING_FLAGS } from './readingValidator.js';
import { findUsageMismatches } from './usageMismatch.js';

const round = (value, digits = 4) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

export function median(values) {
  const sorted = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** PURE: turn per-report aggregates into the cost report. */
export function buildCostReport(aggregates, { creditPriceUsd, outlierMultiplier }) {
  const items = aggregates.map((a) => {
    const creditCostTotal = a.total_credits * creditPriceUsd;
    const totalCost = creditCostTotal + a.total_aws_cost_usd;
    const hasViews = a.total_views > 0;
    return {
      report_id: a.report_id,
      report_name: a.report_name,
      owner_email: a.owner_email,
      valid_readings: a.valid_readings,
      excluded_readings: a.excluded_readings,
      avg_monthly_credits: round(a.avg_monthly_credits, 2),
      avg_monthly_views: round(a.avg_monthly_views, 1),
      avg_monthly_credit_cost_usd: round(a.avg_monthly_credits * creditPriceUsd, 2),
      avg_monthly_aws_cost_usd: round(a.avg_monthly_aws_cost_usd, 2),
      avg_monthly_total_cost_usd: round(a.avg_monthly_credits * creditPriceUsd + a.avg_monthly_aws_cost_usd, 2),
      credits_per_view: hasViews ? round(a.total_credits / a.total_views) : null,
      aws_cost_per_view_usd: hasViews ? round(a.total_aws_cost_usd / a.total_views) : null,
      total_cost_per_view_usd: hasViews ? round(totalCost / a.total_views) : null,
    };
  });

  const medianCostPerView = median(items.map((i) => i.total_cost_per_view_usd));
  for (const item of items) {
    item.is_cost_outlier =
      medianCostPerView !== null &&
      item.total_cost_per_view_usd !== null &&
      item.total_cost_per_view_usd > outlierMultiplier * medianCostPerView;
  }
  items.sort((a, b) => (b.total_cost_per_view_usd ?? Infinity) - (a.total_cost_per_view_usd ?? Infinity));

  const sum = (key) => items.reduce((acc, i) => acc + (i[key] ?? 0), 0);
  return {
    assumptions: {
      credit_price_usd: creditPriceUsd,
      outlier_rule: `total cost per view > ${outlierMultiplier} x median`,
      excluded_flags: COST_EXCLUDING_FLAGS,
      period: 'average month across all valid readings of each report',
    },
    summary: {
      reports: items.length,
      avg_monthly_total_cost_usd: round(sum('avg_monthly_total_cost_usd'), 2),
      avg_monthly_credit_cost_usd: round(sum('avg_monthly_credit_cost_usd'), 2),
      avg_monthly_aws_cost_usd: round(sum('avg_monthly_aws_cost_usd'), 2),
      median_total_cost_per_view_usd: round(medianCostPerView),
      cost_outliers: items.filter((i) => i.is_cost_outlier).length,
      excluded_readings: items.reduce((acc, i) => acc + i.excluded_readings, 0),
    },
    items,
  };
}

export function createCostService({ repos, config }) {
  return {
    getCostReport() {
      return buildCostReport(repos.readings.costAggregates(COST_EXCLUDING_FLAGS), config.cost);
    },
    /** Defect (d): readings and reports whose AWS cost is out of line with their usage. */
    getUsageMismatch() {
      return findUsageMismatches(repos.readings.usageRows(COST_EXCLUDING_FLAGS), { iqrK: config.cost.mismatchIqrK });
    },
  };
}
