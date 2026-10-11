// Shared test setup: an isolated app with an in-memory database, a controllable
// clock and silent logs. Every test file gets a fresh world, so tests never
// depend on each other or on a database file left on disk.

import request from 'supertest';
import { loadConfig } from '../src/config/index.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/database.js';
import { createLogger } from '../src/lib/logger.js';
import { DEMO_USERS } from '../src/services/authService.js';

export const API_KEY = 'test-ingest-key';

/** A clock the test can move forward, so cooldowns can be tested without waiting. */
export function createFakeClock(start = '2026-10-01T09:00:00.000Z') {
  let current = new Date(start).getTime();
  const clock = () => new Date(current);
  clock.advanceSeconds = (s) => {
    current += s * 1000;
  };
  return clock;
}

export async function buildTestContext({ configOverrides = {}, seedUsers = true } = {}) {
  const config = loadConfig({
    env: 'test',
    jwtSecret: 'test-secret',
    ingestApiKey: API_KEY,
    databasePath: ':memory:',
    clientDistPath: '/nonexistent',
    loginRateLimit: { windowMs: 60_000, max: 1000 },
    ...configOverrides,
  });
  const clock = createFakeClock();
  const container = createContainer(config, {
    db: openDatabase(':memory:'),
    clock,
    logger: createLogger('silent'),
  });
  if (seedUsers) await container.services.auth.seedDemoUsers();
  const app = createApp(container);
  return { config, clock, container, app };
}

/** Logs in as one of the demo roles and returns a supertest agent that keeps the cookie. */
export async function loginAs(app, role) {
  const user = DEMO_USERS.find((u) => u.role === role);
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login as ${role} failed: ${res.status}`);
  return agent;
}

export function makeReading(overrides = {}) {
  return {
    report_id: 'RPT_TEST',
    report_name: 'Test Report',
    owner_email: 'owner@company.com',
    last_refresh_status: 'SUCCESS',
    monthly_active_views: 100,
    snowflake_credits_consumed: 10,
    avg_load_time_sec: 5,
    aws_hosting_cost_usd: 20,
    query_count_last_30d: 300,
    concurrent_user_peak: 4,
    ...overrides,
  };
}

export function ingest(app, body, headers = {}) {
  return request(app).post('/api/ingest').set('x-api-key', API_KEY).set(headers).send(body);
}
