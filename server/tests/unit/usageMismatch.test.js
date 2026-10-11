import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findUsageMismatches, quantile, pearson } from '../../src/services/usageMismatch.js';

// Ten "normal" readings that all cost $1 per view and $10 per peak user,
// plus three planted problems.
const normal = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  report_id: `N${i}`,
  received_at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z`,
  monthly_active_views: 100 + i * 10,
  concurrent_user_peak: 10 + i,
  aws_hosting_cost_usd: 100 + i * 10, // $1 per view
}));
const planted = [
  {
    id: 101,
    report_id: 'PRICEY',
    received_at: '2026-10-01T01:00:00Z',
    monthly_active_views: 2,
    concurrent_user_peak: 1,
    aws_hosting_cost_usd: 360,
  },
  {
    id: 102,
    report_id: 'BARGAIN',
    received_at: '2026-10-01T01:00:01Z',
    monthly_active_views: 1500,
    concurrent_user_peak: 150,
    aws_hosting_cost_usd: 15,
  },
  {
    id: 103,
    report_id: 'GHOST',
    received_at: '2026-10-01T01:00:02Z',
    monthly_active_views: 0,
    concurrent_user_peak: 5,
    aws_hosting_cost_usd: 50,
  },
];

describe('findUsageMismatches', () => {
  const result = findUsageMismatches([...normal, ...planted], { iqrK: 1.5 });
  const byReport = Object.fromEntries(result.readings.map((r) => [r.report_id, r]));

  test('finds exactly the three planted readings and none of the normal ones', () => {
    assert.deepEqual(Object.keys(byReport).sort(), ['BARGAIN', 'GHOST', 'PRICEY']);
  });

  test('labels the direction of each discrepancy', () => {
    assert.equal(byReport.PRICEY.direction, 'high_cost_low_usage'); // $180 per view
    assert.equal(byReport.BARGAIN.direction, 'low_cost_high_usage'); // $0.01 per view
    assert.equal(byReport.GHOST.direction, 'cost_with_no_usage'); // $50 with 0 views
  });

  test('reports the ratios in dollars', () => {
    assert.equal(byReport.PRICEY.aws_cost_per_view_usd, 180);
    assert.equal(byReport.GHOST.aws_cost_per_view_usd, null); // never divides by zero
  });

  test('most extreme first, with a per-report roll-up', () => {
    assert.equal(result.readings[0].report_id, 'GHOST');
    assert.equal(result.summary.mismatched_readings, 3);
    assert.equal(result.summary.reports_affected, 3);
  });

  test('nothing is flagged when cost follows usage exactly', () => {
    assert.equal(findUsageMismatches(normal).summary.mismatched_readings, 0);
  });
});

describe('statistics helpers', () => {
  test('quantile interpolates like numpy', () => {
    assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  });
  test('pearson: perfect, inverse, undefined', () => {
    assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(pearson([1, 2, 3], [3, 2, 1]), -1);
    assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  });
});
