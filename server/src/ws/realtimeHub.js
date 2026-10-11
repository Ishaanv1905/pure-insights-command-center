// Real-time channel (Task 2): pushes events to every logged-in browser.
//
// Why WebSocket: the server must PUSH alerts the moment they happen; the browser
// should not have to keep asking (polling). REST = "I ask", WebSocket = "I am told".
//
// Security:
//   - The connection is authenticated DURING the HTTP upgrade handshake, using
//     the same session cookie as the REST API. Unauthenticated sockets are
//     refused before they are ever opened.
//   - Browser connections must come from an allowed Origin (blocks other
//     websites from opening a socket with the user's cookie).
//   - Sessions are re-checked on every heartbeat and immediately on logout or
//     role change, so a socket never outlives the session that opened it.
//   - Each event type requires a permission; a client only receives events its
//     role may see (same rule as the REST API).
//   - Malformed frames or oversized messages close that one socket; they can
//     never crash the server.
//
// Reliability:
//   - Heartbeat: the server pings every client; clients that stop answering
//     are terminated, so dead connections do not pile up.
//   - The client reconnects with backoff and re-fetches over REST, so alerts
//     raised while it was disconnected are not lost (alerts are always stored
//     BEFORE they are broadcast).
//
// Scaling limit: the client list lives in this process's memory. Several server
// instances would need a shared channel (e.g. Redis pub/sub) behind the event bus.

import { WebSocketServer } from 'ws';

export const WS_PATH = '/ws';
const HEARTBEAT_MS = 30_000;
const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024; // clients only ever send {"type":"ping"}

/** Close code sent when the session is no longer valid (client should go to login, not reconnect). */
export const CLOSE_SESSION_ENDED = 4001;

/** Which permission a client needs to receive each event type. Types not listed are never broadcast. */
export const EVENT_PERMISSIONS = {
  'reading.ingested': 'reports:read',
  'report.updated': 'reports:read',
  'alert.created': 'alerts:read',
  'alert.updated': 'alerts:read',
  'alert.resolved': 'alerts:read',
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function reject(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

/** Browsers always send Origin; it must be this server itself or an explicitly allowed origin. */
function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, scripts); the session cookie is still required
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachRealtimeHub(
  httpServer,
  { services, events, config, logger },
  { heartbeatMs = HEARTBEAT_MS } = {},
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });

  const send = (ws, message) => {
    if (ws.readyState === ws.OPEN) ws.send(message);
  };

  const endSession = (ws, reason) => {
    logger.info('ws.session_ended', { user: ws.user?.email, reason });
    ws.close(CLOSE_SESSION_ENDED, reason);
  };

  /** Re-validates a socket's session; updates its user (role may have changed) or closes it. */
  const recheck = (ws) => {
    const session = services.auth.verifySession(ws.token);
    if (!session) {
      endSession(ws, 'session expired or revoked');
      return false;
    }
    ws.user = session.user;
    return true;
  };

  httpServer.on('upgrade', (req, socket, head) => {
    // Any unexpected error while handling an upgrade must only affect this socket.
    try {
      const pathname = (req.url ?? '').split('?')[0];
      if (pathname !== WS_PATH) return reject(socket, 404, 'Not Found');
      if (!originAllowed(req, config.allowedOrigins)) return reject(socket, 403, 'Forbidden');

      const token = parseCookies(req.headers.cookie)[config.cookieName];
      const session = services.auth.verifySession(token);
      if (!session) return reject(socket, 401, 'Unauthorized');

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = session.user;
        ws.token = token;
        ws.jti = session.jti;
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      logger.warn('ws.upgrade_failed', { message: err.message });
      reject(socket, 400, 'Bad Request');
    }
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;

    // Protocol errors (bad opcode, oversized frame...) close this socket only.
    ws.on('error', (err) => {
      logger.warn('ws.client_error', { user: ws.user?.email, message: err.message });
      ws.terminate();
    });
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      // The protocol is server -> client. The only client message understood is a
      // JSON {"type":"ping"}, answered with {"type":"pong"} (handy for debugging).
      try {
        if (JSON.parse(raw.toString()).type === 'ping') {
          send(ws, JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
    ws.on('close', () => logger.info('ws.disconnected', { user: ws.user?.email, clients: wss.clients.size }));

    send(
      ws,
      JSON.stringify({
        type: 'hello',
        data: { user: { email: ws.user.email, role: ws.user.role }, server_time: new Date().toISOString() },
        at: new Date().toISOString(),
      }),
    );
    logger.info('ws.connected', { user: ws.user.email, clients: wss.clients.size });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      if (!recheck(ws)) continue;
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const unsubscribe = events.subscribe((event) => {
    // Internal session events: act on them immediately, never forward them.
    if (event.type === 'session.revoked') {
      for (const ws of wss.clients) if (ws.jti === event.data.jti) endSession(ws, 'logged out');
      return;
    }
    if (event.type === 'user.updated') {
      for (const ws of wss.clients) if (ws.user.id === event.data.id) recheck(ws);
      return;
    }

    const permission = EVENT_PERMISSIONS[event.type];
    if (!permission) return; // unknown types are never broadcast (fail closed)
    const message = JSON.stringify(event);
    for (const ws of wss.clients) {
      if (ws.user.permissions.includes(permission)) send(ws, message);
    }
  });

  return {
    clientCount: () => wss.clients.size,
    close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
