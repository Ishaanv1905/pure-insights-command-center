// Central configuration.
// Every tunable value lives here and is read from environment variables once,
// at startup. The rest of the code receives a plain config object, which makes
// it easy to override values in tests without touching process.env.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(here, '..', '..');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Config error: ${name} must be a number, got "${raw}"`);
  }
  return value;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig(overrides = {}) {
  const env = overrides.env ?? str('NODE_ENV', 'development');
  const isProduction = env === 'production';

  // Alert rules (Task 2). Thresholds are config, not hardcoded logic.
  const alerts = {
    latencyThresholdSec: num('LATENCY_THRESHOLD_SEC', 15), // doc: load latency "exceeds 15 seconds"
    latencyCriticalSec: num('LATENCY_CRITICAL_SEC', 30), // above this a latency alert is critical
    cooldownSec: num('ALERT_COOLDOWN_SEC', 300), // no new alert for the same report + rule within this window
    failureStatuses: ['FAILED', 'TIMED_OUT'], // refresh statuses that count as "failed"
    ...(overrides.alerts ?? {}),
  };

  // Cost model assumptions (documented in docs/architecture-and-decisions.md, D9)
  const cost = {
    creditPriceUsd: num('CREDIT_PRICE_USD', 3.0),
    outlierMultiplier: num('COST_OUTLIER_MULTIPLIER', 3), // "expensive" = cost per view > N x median
    mismatchIqrK: num('COST_MISMATCH_IQR_K', 1.5), // Tukey fence width for cost vs usage mismatches
    ...(overrides.cost ?? {}),
  };

  const config = {
    env,
    isProduction,
    port: num('PORT', 3000),
    logLevel: str('LOG_LEVEL', 'info'),

    // Storage
    databasePath: str('DATABASE_PATH', path.join(SERVER_ROOT, 'data', 'pure-insights.db')),

    // Security
    jwtSecret: str('JWT_SECRET', isProduction ? undefined : 'dev-only-jwt-secret-change-me'),
    jwtExpiresIn: str('JWT_EXPIRES_IN', '8h'),
    ingestApiKey: str('INGEST_API_KEY', isProduction ? undefined : 'dev-ingest-key'),
    cookieName: 'pi_session',
    seedDemoUsers: str('SEED_DEMO_USERS', isProduction ? 'false' : 'true') === 'true',
    loginRateLimit: { windowMs: 15 * 60 * 1000, max: num('LOGIN_RATE_LIMIT', 20) },
    // Extra browser origins allowed to open the WebSocket (the server's own origin is always allowed).
    // Development default: the Vite dev server.
    allowedOrigins: str('ALLOWED_ORIGINS', isProduction ? '' : 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    // Static frontend build, served by Express when it exists
    clientDistPath: str('CLIENT_DIST_PATH', path.resolve(SERVER_ROOT, '..', 'client', 'dist')),

    ...overrides,
    alerts,
    cost,
  };

  if (!config.jwtSecret) throw new Error('Config error: JWT_SECRET is required in production');
  if (!config.ingestApiKey) throw new Error('Config error: INGEST_API_KEY is required in production');

  return Object.freeze(config);
}
