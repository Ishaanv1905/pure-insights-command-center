import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { processReading, normalizeOwner } from '../../src/services/readingValidator.js';
import { makeReading } from '../helpers.js';

const rules = { latencyThresholdSec: 15, failureStatuses: ['FAILED', 'TIMED_OUT'] };
const flagsOf = (overrides) => processReading(makeReading(overrides), rules).reading.flags;

describe('processReading: rejects malformed input', () => {
  const rejects = [
    ['null body', null],
    ['array body', [makeReading()]],
    ['missing report_id', makeReading({ report_id: undefined })],
    ['blank report_id', makeReading({ report_id: '   ' })],
    ['numeric report_id', makeReading({ report_id: 203 })],
    ['unknown status', makeReading({ last_refresh_status: 'BROKEN' })],
    ['missing status', makeReading({ last_refresh_status: undefined })],
    ['number sent as string', makeReading({ avg_load_time_sec: '17.8' })],
    ['NaN is not a number', makeReading({ snowflake_credits_consumed: NaN })],
    ['missing numeric field', makeReading({ aws_hosting_cost_usd: undefined })],
    ['fractional integer field', makeReading({ monthly_active_views: 10.5 })],
    ['owner of wrong type', makeReading({ owner_email: 42 })],
  ];
  for (const [name, body] of rejects) {
    test(name, () => {
      const result = processReading(body, rules);
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    });
  }

  test('reports every problem at once, not just the first', () => {
    const result = processReading({ report_id: '', last_refresh_status: 'X' }, rules);
    assert.ok(result.errors.length >= 8);
  });
});

describe('processReading: flags unusual but valid data', () => {
  test('clean reading has no flags', () => assert.deepEqual(flagsOf({}), []));
  test('exactly 15s is NOT high latency ("exceeds" means strictly greater)', () =>
    assert.deepEqual(flagsOf({ avg_load_time_sec: 15 }), []));
  test('15.1s is high latency', () => assert.deepEqual(flagsOf({ avg_load_time_sec: 15.1 }), ['HIGH_LATENCY']));
  test('FAILED and TIMED_OUT are refresh failures', () => {
    assert.deepEqual(flagsOf({ last_refresh_status: 'FAILED' }), ['REFRESH_FAILED']);
    assert.deepEqual(flagsOf({ last_refresh_status: 'TIMED_OUT' }), ['REFRESH_FAILED']);
  });
  test('UNKNOWN is a warning, not a failure', () =>
    assert.deepEqual(flagsOf({ last_refresh_status: 'UNKNOWN' }), ['REFRESH_UNKNOWN']));
  test('negative credits are flagged, not rejected', () =>
    assert.deepEqual(flagsOf({ snowflake_credits_consumed: -13.6 }), ['NEGATIVE_CREDITS']));
  test('other negative metrics are flagged', () =>
    assert.deepEqual(flagsOf({ aws_hosting_cost_usd: -1 }), ['NEGATIVE_METRIC']));
  test('zero views are flagged', () => assert.deepEqual(flagsOf({ monthly_active_views: 0 }), ['ZERO_VIEWS']));
  test('several flags can apply to one reading', () => {
    const flags = flagsOf({ owner_email: 'nan', avg_load_time_sec: 44, last_refresh_status: 'FAILED' });
    assert.deepEqual(flags.sort(), ['HIGH_LATENCY', 'ORPHANED', 'REFRESH_FAILED']);
  });
});

describe('processReading: normalization keeps the raw value', () => {
  test('status is trimmed and upper-cased', () => {
    const r = processReading(makeReading({ last_refresh_status: ' success ' }), rules);
    assert.equal(r.reading.last_refresh_status, 'SUCCESS');
  });
  test('orphan sentinel is normalized to null but the raw text is preserved', () => {
    const r = processReading(makeReading({ owner_email: 'ORPHANED_REPORT' }), rules);
    assert.equal(r.reading.owner_email, null);
    assert.equal(r.reading.owner_email_raw, 'ORPHANED_REPORT');
  });
  test('unknown extra fields are dropped', () => {
    const r = processReading(makeReading({ injected: 'x' }), rules);
    assert.equal('injected' in r.reading, false);
  });
});

describe('normalizeOwner', () => {
  for (const value of [undefined, null, '', '  ', 'nan', 'NaN', 'ORPHANED_REPORT', 'null', 'None']) {
    test(`${JSON.stringify(value)} means no owner`, () => assert.equal(normalizeOwner(value), null));
  }
  test('a real email is kept (trimmed)', () =>
    assert.equal(normalizeOwner(' user_7@company.com '), 'user_7@company.com'));
});
