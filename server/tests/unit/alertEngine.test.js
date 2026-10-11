import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAlertActions, evaluateRules } from '../../src/services/alertEngine.js';
import { makeReading } from '../helpers.js';

const rules = {
  latencyThresholdSec: 15,
  latencyCriticalSec: 30,
  cooldownSec: 300,
  failureStatuses: ['FAILED', 'TIMED_OUT'],
};
const now = new Date('2026-10-01T10:00:00Z');
const secondsAgo = (s) => new Date(now.getTime() - s * 1000).toISOString();

const decide = (readingOverrides, latestByRule = {}) =>
  decideAlertActions({ reading: makeReading(readingOverrides), latestByRule, now, rules });

const openLatency = { id: 7, rule: 'HIGH_LATENCY', status: 'OPEN', severity: 'warning', resolved_at: null };

describe('evaluateRules', () => {
  test('severity: latency above the critical threshold is critical', () => {
    const [latency] = evaluateRules(makeReading({ avg_load_time_sec: 31 }), rules);
    assert.equal(latency.breached, true);
    assert.equal(latency.severity, 'critical');
  });
  test('severity: FAILED is critical, TIMED_OUT is a warning', () => {
    assert.equal(evaluateRules(makeReading({ last_refresh_status: 'FAILED' }), rules)[1].severity, 'critical');
    assert.equal(evaluateRules(makeReading({ last_refresh_status: 'TIMED_OUT' }), rules)[1].severity, 'warning');
  });
});

describe('decideAlertActions: state machine', () => {
  test('healthy reading with no history does nothing', () => assert.deepEqual(decide({}), []));

  test('first breach creates an alert', () => {
    const actions = decide({ avg_load_time_sec: 20 });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'create');
    assert.equal(actions[0].rule, 'HIGH_LATENCY');
  });

  test('two rules breached at once create two alerts', () => {
    const types = decide({ avg_load_time_sec: 20, last_refresh_status: 'FAILED' }).map((a) => `${a.type}:${a.rule}`);
    assert.deepEqual(types, ['create:HIGH_LATENCY', 'create:REFRESH_FAILED']);
  });

  test('breach while an alert is already active only touches it (no alert storm)', () => {
    const [action] = decide({ avg_load_time_sec: 20 }, { HIGH_LATENCY: openLatency });
    assert.equal(action.type, 'touch');
    assert.equal(action.alertId, 7);
    assert.equal(action.escalated, false);
  });

  test('an acknowledged alert also absorbs repeat breaches', () => {
    const [action] = decide({ avg_load_time_sec: 20 }, { HIGH_LATENCY: { ...openLatency, status: 'ACKNOWLEDGED' } });
    assert.equal(action.type, 'touch');
  });

  test('a worse reading escalates severity but never downgrades it', () => {
    const [up] = decide({ avg_load_time_sec: 45 }, { HIGH_LATENCY: openLatency });
    assert.equal(up.severity, 'critical');
    assert.equal(up.escalated, true);
    const [stay] = decide({ avg_load_time_sec: 16 }, { HIGH_LATENCY: { ...openLatency, severity: 'critical' } });
    assert.equal(stay.severity, 'critical');
    assert.equal(stay.escalated, false);
  });

  test('recovery resolves the active alert', () => {
    assert.deepEqual(decide({ avg_load_time_sec: 5 }, { HIGH_LATENCY: openLatency }), [
      { type: 'resolve', alertId: 7, rule: 'HIGH_LATENCY' },
    ]);
  });

  test('re-breach within the cooldown reopens the resolved alert instead of creating a new one', () => {
    const resolved = { ...openLatency, status: 'RESOLVED', resolved_at: secondsAgo(60) };
    const [action] = decide({ avg_load_time_sec: 20 }, { HIGH_LATENCY: resolved });
    assert.equal(action.type, 'reopen');
    assert.equal(action.alertId, 7);
  });

  test('re-breach after the cooldown creates a new alert', () => {
    const resolved = { ...openLatency, status: 'RESOLVED', resolved_at: secondsAgo(301) };
    assert.equal(decide({ avg_load_time_sec: 20 }, { HIGH_LATENCY: resolved })[0].type, 'create');
  });

  test('UNKNOWN refresh status does not resolve an open refresh alert', () => {
    const openRefresh = { id: 9, rule: 'REFRESH_FAILED', status: 'OPEN', severity: 'critical', resolved_at: null };
    assert.deepEqual(decide({ last_refresh_status: 'UNKNOWN' }, { REFRESH_FAILED: openRefresh }), []);
  });

  test('UNKNOWN refresh status does not open a refresh alert either', () => {
    assert.deepEqual(decide({ last_refresh_status: 'UNKNOWN' }), []);
  });

  test('rules are independent: one rule recovering does not touch the other', () => {
    const actions = decide({ avg_load_time_sec: 5, last_refresh_status: 'FAILED' }, { HIGH_LATENCY: openLatency }).map(
      (a) => `${a.type}:${a.rule}`,
    );
    assert.deepEqual(actions, ['resolve:HIGH_LATENCY', 'create:REFRESH_FAILED']);
  });
});
