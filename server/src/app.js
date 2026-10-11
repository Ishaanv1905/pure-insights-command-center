// Builds the Express application from an already-wired container.
// createApp does NOT open a port, so tests can drive it with supertest.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { authenticate, requireApiKey, requirePermission } from './middleware/auth.js';
import {
  apiNotFound,
  errorHandler,
  rejectRepeatedQueryParams,
  requestLogger,
  requireJsonForWrites,
} from './middleware/http.js';
import { authRoutes } from './routes/authRoutes.js';
import { ingestRoutes } from './routes/ingestRoutes.js';
import { reportRoutes } from './routes/reportRoutes.js';
import { alertRoutes } from './routes/alertRoutes.js';
import { insightRoutes } from './routes/insightRoutes.js';
import { userRoutes } from './routes/userRoutes.js';

export function createApp(container) {
  const { config, logger } = container;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Security headers. The default CSP's connect-src 'self' already allows the
  // page's WebSocket to its own origin, so no extra hosts are opened up.
  app.use(helmet());
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const guards = {
    authenticate: authenticate(container),
    requireApiKey: requireApiKey(container),
    requirePermission,
  };

  // ---- Public ----
  app.get('/api/health/live', (_req, res) => res.json({ status: 'ok' })); // liveness probe, no auth

  const api = express.Router();
  api.use(rejectRepeatedQueryParams);
  api.use(requireJsonForWrites);
  api.use('/auth', authRoutes(container, guards));
  api.use('/ingest', ingestRoutes(container, guards)); // API key, not a user session

  // ---- Everything below requires a logged-in user ----
  api.use(guards.authenticate);
  api.use('/reports', reportRoutes(container, guards));
  api.use('/alerts', alertRoutes(container, guards));
  api.use('/users', userRoutes(container, guards));
  api.use('/', insightRoutes(container, guards));
  api.use(apiNotFound);

  app.use('/api', api);

  // ---- Frontend (production build) ----
  // When client/dist exists, the same server serves the React app, so the whole
  // product runs on one port with no CORS configuration.
  const indexHtml = path.join(config.clientDistPath, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.clientDistPath));
    // Single-page app: unknown non-API paths return index.html and React Router takes over.
    app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => res.sendFile(indexHtml));
  }

  app.use(errorHandler(logger));
  return app;
}
