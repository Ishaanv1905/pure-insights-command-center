import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostReport, median } from '../../src/services/costService.js';
import { can, permissionsFor } from '../../src/services/permissions.js';

const agg = (id, credits, aws, views, extra = {}) => ({
  report_id: id,
  report_name: id,
  owner_email: null,
  valid_readings: 2,
  excluded_readings: 0,
  total_credits: credits,
  total_aws_cost_usd: aws,
  total_views: views,
  avg_monthly_credits: credits / 2,
  avg_monthly_aws_cost_usd: aws / 2,
  avg_monthly_views: views / 2,
  ...extra,
});

describe('buildCostReport (hand-checkable numbers)', () => {
  const settings = { creditPriceUsd: 2, outlierMultiplier: 3 };

  test('cost per view = (credits x price + aws) / views', () => {
    const { items } = buildCostReport([agg('A', 10, 30, 50)], settings);
    // (10 x 2 + 30) / 50 = 1.0 ; credits per view = 10 / 50 = 0.2
    assert.equal(items[0].total_cost_per_view_usd, 1);
    assert.equal(items[0].credits_per_view, 0.2);
    assert.equal(items[0].avg_monthly_total_cost_usd, 25); // (5 x 2) + 15
  });

  test('zero views gives null ratios instead of Infinity or a crash', () => {
    const { items } = buildCostReport([agg('Z', 10, 30, 0)], settings);
    assert.equal(items[0].total_cost_per_view_usd, null);
    assert.equal(items[0].credits_per_view, null);
  });

  test('outlier = cost per view above 3 x median', () => {
    // cost/view: A=1, B=1, C=1, D=10 -> median 1, D is the outlier
    const report = buildCostReport(
      [agg('A', 10, 30, 50), agg('B', 10, 30, 50), agg('C', 10, 30, 50), agg('D', 100, 300, 50)],
      settings,
    );
    assert.deepEqual(
      report.items.filter((i) => i.is_cost_outlier).map((i) => i.report_id),
      ['D'],
    );
    assert.equal(report.items[0].report_id, 'D'); // sorted most expensive first
    assert.equal(report.summary.cost_outliers, 1);
  });

  test('median handles even and odd counts and ignores nulls', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([null, 5]), 5);
    assert.equal(median([]), null);
  });
});

describe('permissions', () => {
  test('viewer is read-only', () => {
    assert.ok(can('viewer', 'reports:read'));
    assert.ok(!can('viewer', 'alerts:acknowledge'));
    assert.ok(!can('viewer', 'cost:read'));
  });
  test('analyst can acknowledge and see cost, but not manage users', () => {
    assert.ok(can('analyst', 'alerts:acknowledge'));
    assert.ok(can('analyst', 'cost:read'));
    assert.ok(!can('analyst', 'users:manage'));
  });
  test('each role includes everything the role below it has', () => {
    for (const p of permissionsFor('viewer')) assert.ok(can('analyst', p));
    for (const p of permissionsFor('analyst')) assert.ok(can('admin', p));
  });
  test('unknown roles have no permissions', () => assert.deepEqual(permissionsFor('hacker'), []));
});
