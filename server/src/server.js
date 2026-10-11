// Entry point: load config, wire the container, start HTTP + WebSocket, shut down cleanly.

import http from 'node:http';
import { loadConfig } from './config/index.js';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { attachRealtimeHub, WS_PATH } from './ws/realtimeHub.js';
import { DEMO_USERS } from './services/authService.js';

const config = loadConfig();
const container = createContainer(config);
const { logger } = container;

if (config.seedDemoUsers) {
  const created = await container.services.auth.seedDemoUsers();
  if (created.length) {
    logger.info('seeded_demo_users', { users: DEMO_USERS.map((u) => `${u.email} / ${u.password} (${u.role})`) });
  }
}

const app = createApp(container);
const server = http.createServer(app);
const hub = attachRealtimeHub(server, container);
container.setRealtimeClientCounter(hub.clientCount);

server.listen(config.port, () => {
  logger.info('server_started', {
    url: `http://localhost:${config.port}`,
    websocket: `ws://localhost:${config.port}${WS_PATH}`,
    env: config.env,
    database: config.databasePath,
  });
});

// Graceful shutdown: stop accepting connections, close sockets, close the DB.
function shutdown(signal) {
  logger.info('shutting_down', { signal });
  hub.close();
  server.close(() => {
    container.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
