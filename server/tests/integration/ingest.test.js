import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { API_KEY, buildTestContext, ingest, loginAs, makeReading } from '../helpers.js';

describe('POST /api/ingest', () => {
  let ctx;
  before(async () => {
    ctx = await buildTestContext();
  });

  test('401 without an API key', async () => {
    const res = await request(ctx.app).post('/api/ingest').send(makeReading());
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  test('401 with a wrong API key', async () => {
    const res = await request(ctx.app).post('/api/ingest').set('x-api-key', 'nope').send(makeReading());
    assert.equal(res.status, 401);
  });

  test('a user session cookie is NOT accepted instead of the API key', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const res = await admin.post('/api/ingest').send(makeReading());
    assert.equal(res.status, 401);
  });

  test('201 stores a valid reading and returns its flags', async () => {
    const res = await ingest(
      ctx.app,
      makeReading({
        report_id: 'RPT_203',
        owner_email: 'nan',
        avg_load_time_sec: 17.8,
        last_refresh_status: 'TIMED_OUT',
      }),
    );
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.flags.sort(), ['HIGH_LATENCY', 'ORPHANED', 'REFRESH_FAILED']);
    assert.ok(res.body.reading_id > 0);
    assert.ok(res.body.received_at); // server-stamped: the CSV has no timestamp
  });

  test('400 with every validation error listed, and the payload is kept as a rejection', async () => {
    const res = await ingest(ctx.app, { report_id: '', avg_load_time_sec: 'slow' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(res.body.error.details.length > 3);
    const rejected = ctx.container.repos.readings.listRejected();
    assert.ok(rejected.some((r) => r.payload.includes('"slow"')));
  });

  test('400 for malformed JSON', async () => {
    const res = await request(ctx.app)
      .post('/api/ingest')
      .set('x-api-key', API_KEY)
      .set('content-type', 'application/json')
      .send('{"report_id": ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });

  test('415 when the body is not JSON', async () => {
    const res = await request(ctx.app)
      .post('/api/ingest')
      .set('x-api-key', API_KEY)
      .set('content-type', 'text/plain')
      .send('hello');
    assert.equal(res.status, 415);
  });

  test('idempotency key: a retry returns 200 and stores nothing new', async () => {
    const body = makeReading({ report_id: 'RPT_IDEM' });
    const first = await ingest(ctx.app, body, { 'idempotency-key': 'retry-1' });
    const second = await ingest(ctx.app, body, { 'idempotency-key': 'retry-1' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.reading_id, first.body.reading_id);
    assert.equal(ctx.container.repos.reports.findById('RPT_IDEM').reading_count, 1);
  });

  test('raw values are preserved in history while the report holds the latest state', async () => {
    await ingest(ctx.app, makeReading({ report_id: 'RPT_HIST', snowflake_credits_consumed: -5 }));
    await ingest(ctx.app, makeReading({ report_id: 'RPT_HIST', snowflake_credits_consumed: 42 }));
    const report = ctx.container.repos.reports.findById('RPT_HIST');
    assert.equal(report.reading_count, 2);
    assert.equal(report.snowflake_credits_consumed, 42);
    const history = ctx.container.repos.readings.listForReport('RPT_HIST', { limit: 10, offset: 0 });
    assert.deepEqual(
      history.items.map((r) => r.snowflake_credits_consumed),
      [42, -5],
    ); // newest first, raw kept
  });
});

describe('POST /api/ingest/batch', () => {
  let ctx;
  before(async () => {
    ctx = await buildTestContext();
  });

  test('accepts good items and rejects bad ones independently', async () => {
    const res = await request(ctx.app)
      .post('/api/ingest/batch')
      .set('x-api-key', API_KEY)
      .send([makeReading({ report_id: 'B1' }), { report_id: 'B2' }, makeReading({ report_id: 'B3' })]);
    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, 2);
    assert.equal(res.body.rejected, 1);
    assert.equal(res.body.results[1].status, 'rejected');
  });

  test('400 when the body is not an array or is empty', async () => {
    const notArray = await request(ctx.app).post('/api/ingest/batch').set('x-api-key', API_KEY).send(makeReading());
    const empty = await request(ctx.app).post('/api/ingest/batch').set('x-api-key', API_KEY).send([]);
    assert.equal(notArray.status, 400);
    assert.equal(empty.status, 400);
  });
});
