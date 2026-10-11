import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildTestContext, ingest, loginAs, makeReading } from '../helpers.js';

describe('authentication', () => {
  let ctx;
  before(async () => {
    ctx = await buildTestContext();
  });

  test('login sets an httpOnly, SameSite=Strict session cookie and never returns the hash', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'analyst@pureinsights.local', password: 'Analyst#2026' });
    assert.equal(res.status, 200);
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /pi_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    // cookie lifetime matches the token lifetime (8h by default)
    const expires = Date.parse(/Expires=([^;]+)/.exec(cookie)[1]);
    assert.ok(Math.abs(expires - Date.now() - 8 * 3600 * 1000) < 60_000);
    assert.equal(res.body.user.role, 'analyst');
    assert.equal(JSON.stringify(res.body).includes('password'), false);
  });

  test('wrong password and unknown email give the same 401', async () => {
    const wrongPw = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'admin@pureinsights.local', password: 'nope' });
    const noUser = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'ghost@pureinsights.local', password: 'nope' });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.body.error.message, noUser.body.error.message);
  });

  test('protected endpoints require a session', async () => {
    for (const path of ['/api/reports', '/api/alerts', '/api/health/summary', '/api/auth/me']) {
      const res = await request(ctx.app).get(path);
      assert.equal(res.status, 401, path);
    }
  });

  test('a tampered or foreign-signed token is rejected', async () => {
    const forged = jwt.sign({ sub: '1', role: 'admin' }, 'not-the-real-secret');
    const res = await request(ctx.app).get('/api/auth/me').set('Cookie', `pi_session=${forged}`);
    assert.equal(res.status, 401);
  });

  test('/me returns the user and their permissions; logout clears the cookie', async () => {
    const agent = await loginAs(ctx.app, 'viewer');
    const me = await agent.get('/api/auth/me');
    assert.equal(me.body.user.role, 'viewer');
    assert.ok(me.body.user.permissions.includes('reports:read'));
    const out = await agent.post('/api/auth/logout').send({});
    assert.equal(out.status, 204);
    assert.equal((await agent.get('/api/auth/me')).status, 401);
  });

  test('role changes take effect immediately, without logging in again', async () => {
    const created = await ctx.container.services.auth.createUser({
      email: 'temp@x.io',
      password: 'Temp#12345',
      role: 'viewer',
    });
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ email: 'temp@x.io', password: 'Temp#12345' });
    assert.equal((await agent.get('/api/cost')).status, 403);
    ctx.container.repos.users.updateRole(created.id, 'analyst');
    assert.equal((await agent.get('/api/cost')).status, 200);
  });
});

describe('role-based access control', () => {
  let ctx;
  let alertId;
  before(async () => {
    ctx = await buildTestContext();
    const res = await ingest(ctx.app, makeReading({ report_id: 'RPT_RBAC', avg_load_time_sec: 40 }));
    assert.equal(res.status, 201);
    alertId = ctx.container.repos.alerts.list({ limit: 1, offset: 0 }).items[0].id;
  });

  // [method, path, body, { viewer, analyst, admin } expected status]
  const matrix = [
    ['get', '/api/reports', null, { viewer: 200, analyst: 200, admin: 200 }],
    ['get', '/api/reports/orphaned', null, { viewer: 200, analyst: 200, admin: 200 }],
    ['get', '/api/health/summary', null, { viewer: 200, analyst: 200, admin: 200 }],
    ['get', '/api/alerts', null, { viewer: 200, analyst: 200, admin: 200 }],
    ['get', '/api/reports/RPT_RBAC/readings', null, { viewer: 403, analyst: 200, admin: 200 }],
    ['get', '/api/cost', null, { viewer: 403, analyst: 200, admin: 200 }],
    ['get', '/api/data-quality', null, { viewer: 403, analyst: 200, admin: 200 }],
    ['get', '/api/users', null, { viewer: 403, analyst: 403, admin: 200 }],
    [
      'patch',
      '/api/reports/RPT_RBAC/owner',
      { owner_email: 'x@company.com' },
      { viewer: 403, analyst: 403, admin: 200 },
    ],
  ];

  for (const [method, path, body, expected] of matrix) {
    for (const role of ['viewer', 'analyst', 'admin']) {
      test(`${role} ${method.toUpperCase()} ${path} -> ${expected[role]}`, async () => {
        const agent = await loginAs(ctx.app, role);
        const req = agent[method](path);
        const res = body ? await req.send(body) : await req;
        assert.equal(res.status, expected[role]);
      });
    }
  }

  test('viewer cannot acknowledge an alert, analyst can', async () => {
    const viewer = await loginAs(ctx.app, 'viewer');
    assert.equal((await viewer.post(`/api/alerts/${alertId}/acknowledge`).send({})).status, 403);
    const analyst = await loginAs(ctx.app, 'analyst');
    const res = await analyst.post(`/api/alerts/${alertId}/acknowledge`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ACKNOWLEDGED');
    assert.equal(res.body.acknowledged_by, 'analyst@pureinsights.local');
    // acknowledging twice is a conflict, not a silent success
    assert.equal((await analyst.post(`/api/alerts/${alertId}/acknowledge`).send({})).status, 409);
  });

  test('admin can create users; duplicates and weak passwords are refused', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const ok = await admin
      .post('/api/users')
      .send({ email: 'new@company.com', password: 'Str0ng#pass', role: 'analyst' });
    assert.equal(ok.status, 201);
    assert.equal(
      (await admin.post('/api/users').send({ email: 'new@company.com', password: 'Str0ng#pass', role: 'analyst' }))
        .status,
      409,
    );
    const weak = await admin.post('/api/users').send({ email: 'weak@company.com', password: '123', role: 'superuser' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.details.length, 2);
  });

  test('admin cannot change their own role (avoids locking everyone out)', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const me = (await admin.get('/api/auth/me')).body.user;
    assert.equal((await admin.patch(`/api/users/${me.id}`).send({ role: 'viewer' })).status, 400);
  });
});
