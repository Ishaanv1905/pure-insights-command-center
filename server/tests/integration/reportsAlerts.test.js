import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestContext, ingest, loginAs, makeReading } from '../helpers.js';

describe('alert lifecycle through the API (with a controllable clock)', () => {
  let ctx;
  let analyst;
  const events = [];
  const R = 'RPT_LIFE';
  const send = (overrides) => ingest(ctx.app, makeReading({ report_id: R, ...overrides }));
  const latencyAlerts = async () => (await analyst.get(`/api/alerts?report_id=${R}&rule=HIGH_LATENCY`)).body.items;

  before(async () => {
    ctx = await buildTestContext({ configOverrides: { alerts: { cooldownSec: 300 } } });
    ctx.container.events.subscribe((e) => events.push(e));
    analyst = await loginAs(ctx.app, 'analyst');
  });

  test('1. first slow reading opens an alert and publishes alert.created', async () => {
    await send({ avg_load_time_sec: 20 });
    const alerts = await latencyAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, 'OPEN');
    assert.equal(alerts[0].severity, 'warning');
    assert.ok(events.some((e) => e.type === 'alert.created' && e.data.report_id === R));
  });

  test('2. more slow readings do not create more alerts', async () => {
    ctx.clock.advanceSeconds(30);
    await send({ avg_load_time_sec: 22 });
    await send({ avg_load_time_sec: 25 });
    const alerts = await latencyAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].occurrences, 3);
  });

  test('3. a much worse reading escalates severity and publishes alert.updated', async () => {
    await send({ avg_load_time_sec: 50 });
    assert.equal((await latencyAlerts())[0].severity, 'critical');
    assert.ok(
      events.some((e) => e.type === 'alert.updated' && e.data.change === 'escalated' && e.data.severity === 'critical'),
    );
  });

  test('4. recovery resolves it', async () => {
    ctx.clock.advanceSeconds(30);
    await send({ avg_load_time_sec: 3 });
    const [alert] = await latencyAlerts();
    assert.equal(alert.status, 'RESOLVED');
    assert.ok(alert.resolved_at);
    assert.ok(events.some((e) => e.type === 'alert.resolved'));
  });

  test('5. breaking again inside the cooldown reopens the same alert (flapping)', async () => {
    ctx.clock.advanceSeconds(60);
    await send({ avg_load_time_sec: 18 });
    const alerts = await latencyAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, 'OPEN');
    assert.equal(alerts[0].reopen_count, 1);
    assert.ok(events.some((e) => e.type === 'alert.updated' && e.data.change === 'reopened'));
    // a reopen is NOT announced as a new incident
    assert.equal(events.filter((e) => e.type === 'alert.created' && e.data.rule === 'HIGH_LATENCY').length, 1);
  });

  test('6. breaking again after the cooldown is a new incident', async () => {
    await send({ avg_load_time_sec: 3 }); // resolve
    ctx.clock.advanceSeconds(301);
    await send({ avg_load_time_sec: 18 });
    const alerts = await latencyAlerts();
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].status, 'OPEN'); // newest first
  });

  test('alerts are stored before they are published (REST can always catch up)', async () => {
    const created = events.filter((e) => e.type === 'alert.created');
    for (const e of created) assert.ok(ctx.container.repos.alerts.findById(e.data.id));
  });

  test('alert filters validate their input', async () => {
    assert.equal((await analyst.get('/api/alerts?status=active')).status, 200);
    assert.equal((await analyst.get('/api/alerts?status=bogus')).status, 400);
    assert.equal((await analyst.get('/api/alerts?limit=500')).status, 400);
    assert.equal((await analyst.get('/api/alerts/abc')).status, 400);
    assert.equal((await analyst.get('/api/alerts/99999')).status, 404);
  });
});

describe('reports API', () => {
  let ctx;
  let admin;
  before(async () => {
    ctx = await buildTestContext();
    admin = await loginAs(ctx.app, 'admin');
    await ingest(ctx.app, makeReading({ report_id: 'RPT_A', owner_email: 'ORPHANED_REPORT', avg_load_time_sec: 30 }));
    await ingest(
      ctx.app,
      makeReading({ report_id: 'RPT_B', owner_email: 'b@company.com', last_refresh_status: 'FAILED' }),
    );
    await ingest(ctx.app, makeReading({ report_id: 'RPT_C', owner_email: 'nan' }));
  });

  test('orphaned endpoint lists reports with no owner', async () => {
    const res = await admin.get('/api/reports/orphaned');
    assert.deepEqual(
      res.body.items.map((r) => r.report_id),
      ['RPT_A', 'RPT_C'],
    );
    assert.equal(res.body.pagination.total, 2);
  });

  test('filtering by flag and status, and pagination metadata', async () => {
    const slow = await admin.get('/api/reports?flag=HIGH_LATENCY');
    assert.deepEqual(
      slow.body.items.map((r) => r.report_id),
      ['RPT_A'],
    );
    const failed = await admin.get('/api/reports?status=FAILED');
    assert.deepEqual(
      failed.body.items.map((r) => r.report_id),
      ['RPT_B'],
    );
    const paged = await admin.get('/api/reports?limit=2&offset=0');
    assert.equal(paged.body.items.length, 2);
    assert.equal(paged.body.pagination.has_more, true);
    assert.equal((await admin.get('/api/reports?flag=NOT_A_FLAG')).status, 400);
  });

  test('sort parameter cannot be used for SQL injection', async () => {
    const res = await admin.get('/api/reports?sort=report_id;DROP TABLE reports&order=desc');
    assert.equal(res.status, 200);
    assert.equal((await admin.get('/api/reports')).body.pagination.total, 3);
  });

  test('404 for an unknown report', async () => {
    assert.equal((await admin.get('/api/reports/NOPE')).status, 404);
  });

  test('admin assigns an owner: report leaves the orphaned list and stays assigned after new feed data', async () => {
    const res = await admin.patch('/api/reports/RPT_A/owner').send({ owner_email: 'New.Owner@Company.com' });
    assert.equal(res.status, 200);
    assert.equal(res.body.owner_email, 'new.owner@company.com');
    assert.equal(res.body.owner_source, 'assigned');
    assert.equal(res.body.is_orphaned, false);
    assert.equal(res.body.flags.includes('ORPHANED'), false); // flags agree with the assignment immediately
    assert.equal(
      (await admin.get('/api/reports?flag=ORPHANED')).body.items.some((r) => r.report_id === 'RPT_A'),
      false,
    );

    // the feed keeps saying "no owner"; the admin assignment wins
    await ingest(ctx.app, makeReading({ report_id: 'RPT_A', owner_email: 'nan' }));
    const after = (await admin.get('/api/reports/RPT_A')).body;
    assert.equal(after.is_orphaned, false);
    assert.equal(after.flags.includes('ORPHANED'), false);
    const ids = (await admin.get('/api/reports/orphaned')).body.items.map((r) => r.report_id);
    assert.deepEqual(ids, ['RPT_C']);
  });

  test('clearing the assignment makes the report orphaned again, flags included', async () => {
    await admin.patch('/api/reports/RPT_C/owner').send({ owner_email: 'temp@company.com' });
    const cleared = (await admin.patch('/api/reports/RPT_C/owner').send({ owner_email: null })).body;
    assert.equal(cleared.is_orphaned, true);
    assert.ok(cleared.flags.includes('ORPHANED'));
  });

  test('a repeated query parameter is a 400, not a crash', async () => {
    const res = await admin.get('/api/alerts?report_id=a&report_id=b');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  test('owner assignment validates the email', async () => {
    assert.equal((await admin.patch('/api/reports/RPT_C/owner').send({ owner_email: 'not-an-email' })).status, 400);
    assert.equal((await admin.patch('/api/reports/RPT_C/owner').send({})).status, 400);
  });

  test('health summary counts', async () => {
    const res = await admin.get('/api/health/summary');
    assert.equal(res.body.reports.total, 3);
    assert.equal(res.body.reports.failing_refresh, 1);
    assert.equal(res.body.thresholds.latency_threshold_sec, 15);
  });

  test('unknown API routes return a JSON 404', async () => {
    const res = await admin.get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
