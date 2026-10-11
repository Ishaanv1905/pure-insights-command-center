// Ingestion pipeline: the journey of one reading.
//
//   1. Idempotency check  - a retried request with the same key is not stored twice
//   2. processReading     - validate (reject) / normalize / flag   [pure]
//   3. Transaction:
//        upsert report current state
//        insert reading into history
//        decideAlertActions                                        [pure]
//        apply alert actions (create / touch / reopen / resolve)
//   4. After COMMIT, publish events (so a browser never hears about data that
//      was rolled back).

import { processReading, withOwnershipFlag } from './readingValidator.js';
import { decideAlertActions } from './alertEngine.js';
import { validationFailed, badRequest } from '../lib/errors.js';
import { transaction } from '../db/database.js';

export const MAX_BATCH_SIZE = 1000;

export function createIngestService({ db, repos, events, config, clock, logger }) {
  const { reports, readings, alerts } = repos;

  // Everything inside runs atomically: either all writes happen or none do.
  const storeReading = transaction(db, (reading, idempotencyKey, now) => {
    const nowIso = now.toISOString();
    const existing = reports.findRawById(reading.report_id);

    // If an admin assigned an owner, the report is not orphaned even though the
    // feed still reports no owner. The READING keeps its ORPHANED flag (it is a fact
    // about the incoming data); the REPORT's current flags follow the effective owner.
    const reportFlags = withOwnershipFlag(
      reading.flags,
      Boolean(existing?.assigned_owner_email || reading.owner_email),
    );

    reports.upsertFromReading(reading, reportFlags);
    const readingId = readings.insert(reading, idempotencyKey);

    const actions = decideAlertActions({
      reading,
      latestByRule: alerts.latestByRule(reading.report_id),
      now,
      rules: config.alerts,
    });

    const pendingEvents = [];
    for (const action of actions) {
      switch (action.type) {
        case 'create': {
          const id = alerts.create(
            {
              report_id: reading.report_id,
              rule: action.rule,
              severity: action.severity,
              message: action.message,
              observed_value: action.observed_value,
              threshold: action.threshold,
              trigger_reading_id: readingId,
            },
            nowIso,
          );
          pendingEvents.push(['alert.created', id]);
          break;
        }
        case 'touch':
          alerts.touch(action.alertId, action, nowIso);
          if (action.escalated) pendingEvents.push(['alert.updated', action.alertId, 'escalated']);
          break;
        case 'resolve':
          alerts.resolve(action.alertId, nowIso);
          pendingEvents.push(['alert.resolved', action.alertId]);
          break;
        case 'reopen':
          alerts.reopen(action.alertId, action, nowIso);
          pendingEvents.push(['alert.updated', action.alertId, 'reopened']);
          break;
        default:
          throw new Error(`Unknown alert action ${action.type}`);
      }
    }

    return { readingId, actions, pendingEvents };
  });

  function ingestOne(body, idempotencyKey) {
    const now = clock();
    const receivedAt = now.toISOString();

    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128) {
        throw badRequest('Idempotency key must be a string of 1 to 128 characters');
      }
      const previous = readings.findByIdempotencyKey(idempotencyKey);
      if (previous) {
        return { duplicate: true, reading_id: previous.id, report_id: previous.report_id, flags: previous.flags };
      }
    }

    const result = processReading(body, config.alerts);
    if (!result.ok) {
      readings.recordRejected(receivedAt, result.errors, body);
      logger.warn('ingest.rejected', { errors: result.errors });
      throw validationFailed(result.errors);
    }

    const reading = { ...result.reading, received_at: receivedAt };
    const { readingId, actions, pendingEvents } = storeReading(reading, idempotencyKey ?? null, now);

    // Committed. Now tell the world.
    events.publish('reading.ingested', {
      reading_id: readingId,
      report_id: reading.report_id,
      received_at: receivedAt,
      flags: reading.flags,
    });
    for (const [type, alertId, change] of pendingEvents) {
      const alert = alerts.findById(alertId);
      events.publish(type, change ? { ...alert, change } : alert);
    }

    return {
      duplicate: false,
      reading_id: readingId,
      report_id: reading.report_id,
      received_at: receivedAt,
      flags: reading.flags,
      alert_actions: actions.map((a) => ({ type: a.type, rule: a.rule })),
    };
  }

  function ingestBatch(items) {
    if (!Array.isArray(items)) throw badRequest('Batch body must be a JSON array of readings');
    if (items.length === 0) throw badRequest('Batch must contain at least one reading');
    if (items.length > MAX_BATCH_SIZE) throw badRequest(`Batch may contain at most ${MAX_BATCH_SIZE} readings`);

    const results = items.map((item, index) => {
      try {
        const key = item && typeof item === 'object' ? item.idempotency_key : undefined;
        return { index, status: 'accepted', ...ingestOne(item, key) };
      } catch (err) {
        if (err.status === 400) return { index, status: 'rejected', errors: err.details ?? [err.message] };
        throw err;
      }
    });
    const accepted = results.filter((r) => r.status === 'accepted').length;
    return { accepted, rejected: results.length - accepted, results };
  }

  return { ingestOne, ingestBatch };
}
