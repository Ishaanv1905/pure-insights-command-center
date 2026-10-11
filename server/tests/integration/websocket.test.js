// Real HTTP server on a random port + a real WebSocket client.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { attachRealtimeHub } from '../../src/ws/realtimeHub.js';
import { buildTestContext, ingest, makeReading } from '../helpers.js';

function nextMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

function rawRequest(host, text) {
  const [hostname, port] = host.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname, () => socket.write(text));
    let data = '';
    socket.on('data', (d) => (data += d));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
}

describe('WebSocket real-time alerts', () => {
  let ctx;
  let server;
  let hub;
  let base;
  let cookie;

  before(async () => {
    ctx = await buildTestContext();
    server = http.createServer(ctx.app);
    hub = attachRealtimeHub(server, ctx.container, { heartbeatMs: 60_000 });
    ctx.container.setRealtimeClientCounter(hub.clientCount);
    await new Promise((resolve) => server.listen(0, resolve));
    base = `127.0.0.1:${server.address().port}`;
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'viewer@pureinsights.local', password: 'Viewer#2026' });
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });

  after(() => {
    hub.close();
    server.close();
  });

  test('connection without a session is refused during the handshake', async () => {
    const ws = new WebSocket(`ws://${base}/ws`);
    const err = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
    assert.equal(err, 401);
  });

  test('unknown path is refused', async () => {
    const ws = new WebSocket(`ws://${base}/not-ws`, { headers: { cookie } });
    const status = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
    assert.equal(status, 404);
  });

  test('authenticated client gets hello, then alert.created when a slow reading is ingested', async () => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    const hello = await nextMessage(ws, (m) => m.type === 'hello');
    assert.equal(hello.data.user.role, 'viewer');

    const waitForAlert = nextMessage(ws, (m) => m.type === 'alert.created');
    await ingest(ctx.app, makeReading({ report_id: 'RPT_WS', avg_load_time_sec: 42 }));
    const alert = await waitForAlert;
    assert.equal(alert.data.report_id, 'RPT_WS');
    assert.equal(alert.data.rule, 'HIGH_LATENCY');
    assert.equal(alert.data.severity, 'critical');

    const waitForResolve = nextMessage(ws, (m) => m.type === 'alert.resolved');
    await ingest(ctx.app, makeReading({ report_id: 'RPT_WS', avg_load_time_sec: 2 }));
    assert.equal((await waitForResolve).data.status, 'RESOLVED');

    // the health endpoint reports connected clients
    const health = await request(ctx.app).get('/api/health/summary').set('Cookie', cookie);
    assert.equal(health.body.realtime.connected_clients, 1);
    ws.close();
  });

  test('every connected client receives the broadcast', async () => {
    const a = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    const b = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    await Promise.all([nextMessage(a, (m) => m.type === 'hello'), nextMessage(b, (m) => m.type === 'hello')]);
    const both = Promise.all([
      nextMessage(a, (m) => m.type === 'alert.created'),
      nextMessage(b, (m) => m.type === 'alert.created'),
    ]);
    await ingest(ctx.app, makeReading({ report_id: 'RPT_WS2', last_refresh_status: 'FAILED' }));
    const [ma, mb] = await both;
    assert.equal(ma.data.id, mb.data.id);
    a.close();
    b.close();
  });

  test('origin from another website is refused (403)', async () => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie, origin: 'https://evil.example' } });
    const status = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
    assert.equal(status, 403);
  });

  test('a malformed upgrade request cannot crash the server', async () => {
    const reply = await rawRequest(
      base,
      'GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    assert.match(reply, /^HTTP\/1\.1 (400|404)/);
    assert.equal((await request(ctx.app).get('/api/health/live')).status, 200);
    assert.equal(server.listening, true);
  });

  test('an invalid WebSocket frame closes only that socket, the server keeps running', async () => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    await nextMessage(ws, (m) => m.type === 'hello');
    const closed = new Promise((resolve) => ws.on('close', resolve));
    ws.on('error', () => {});
    ws._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0])); // reserved opcode 0x3, masked, empty
    await closed;
    const other = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    assert.equal((await nextMessage(other, (m) => m.type === 'hello')).type, 'hello');
    other.close();
  });

  test('logging out closes the sockets of that session and the old cookie stops working', async () => {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'analyst@pureinsights.local', password: 'Analyst#2026' });
    const sessionCookie = login.headers['set-cookie'][0].split(';')[0];
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie: sessionCookie } });
    await nextMessage(ws, (m) => m.type === 'hello');
    const closeCode = new Promise((resolve) => ws.on('close', (code) => resolve(code)));

    await request(ctx.app).post('/api/auth/logout').set('Cookie', sessionCookie).send({});
    assert.equal(await closeCode, 4001);
    // a copy of the cookie is useless now, for REST and for WebSocket
    assert.equal((await request(ctx.app).get('/api/auth/me').set('Cookie', sessionCookie)).status, 401);
    const again = new WebSocket(`ws://${base}/ws`, { headers: { cookie: sessionCookie } });
    const status = await new Promise((resolve) =>
      again.on('unexpected-response', (_req, res) => resolve(res.statusCode)),
    );
    assert.equal(status, 401);
  });

  test('internal events are never forwarded to browsers', async () => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    await nextMessage(ws, (m) => m.type === 'hello');
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString()).type));
    ctx.container.events.publish('internal.secret', { password: 'x' });
    ctx.container.events.publish('alert.created', { id: 1, report_id: 'X' });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, ['alert.created']);
    ws.close();
  });

  test('client ping gets a pong', async () => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    await nextMessage(ws, (m) => m.type === 'hello');
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await nextMessage(ws, (m) => m.type === 'pong')).type, 'pong');
    ws.close();
  });
});
