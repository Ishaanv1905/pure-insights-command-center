// Composition root: builds every dependency ONCE and wires them together.
//
// This is "dependency injection" without a framework: each module receives what
// it needs as arguments instead of importing globals. Tests call this with an
// in-memory database and a fake clock; production calls it with real ones.

import { openDatabase } from './db/database.js';
import { createLogger } from './lib/logger.js';
import { createEventBus } from './lib/eventBus.js';
import { createReportRepository } from './repositories/reportRepository.js';
import { createReadingRepository } from './repositories/readingRepository.js';
import { createAlertRepository } from './repositories/alertRepository.js';
import { createUserRepository } from './repositories/userRepository.js';
import { createIngestService } from './services/ingestService.js';
import { createAuthService } from './services/authService.js';
import { createReportService } from './services/reportService.js';
import { createAlertService } from './services/alertService.js';
import { createCostService } from './services/costService.js';
import { createInsightService } from './services/insightService.js';

export function createContainer(config, { db, clock, logger } = {}) {
  const database = db ?? openDatabase(config.databasePath);
  const log = logger ?? createLogger(config.logLevel);
  const now = clock ?? (() => new Date());
  const events = createEventBus();

  const repos = {
    reports: createReportRepository(database),
    readings: createReadingRepository(database),
    alerts: createAlertRepository(database),
    users: createUserRepository(database),
  };

  // The WebSocket hub registers itself later (it needs the HTTP server); until
  // then the health endpoint reports 0 connected clients.
  let realtimeClientCounter = () => 0;

  const deps = { db: database, repos, events, config, clock: now, logger: log };
  const services = {
    ingest: createIngestService(deps),
    auth: createAuthService(deps),
    reports: createReportService(deps),
    alerts: createAlertService(deps),
    cost: createCostService(deps),
    insights: createInsightService({ ...deps, getRealtimeClients: () => realtimeClientCounter() }),
  };

  return {
    config,
    db: database,
    logger: log,
    events,
    repos,
    services,
    setRealtimeClientCounter(fn) {
      realtimeClientCounter = fn;
    },
    close() {
      database.close();
    },
  };
}
