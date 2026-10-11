// Cross-cutting HTTP middleware: request logging, JSON-only writes, 404s and errors.

import { AppError } from '../lib/errors.js';

export function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info('http', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Number(ms.toFixed(1)),
      });
    });
    next();
  };
}

/**
 * Every state-changing API call must send Content-Type: application/json.
 * Defence in depth against CSRF: an HTML form on another site cannot send JSON
 * without a CORS preflight, which this server never approves. (The session
 * cookie is also SameSite=Strict.)
 */
export function requireJsonForWrites(req, res, next) {
  const writes = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (writes.includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' },
    });
  }
  next();
}

/**
 * Every query parameter must be a single string. "?status=a&status=b" would
 * otherwise arrive as an array and reach code that expects a string.
 */
export function rejectRepeatedQueryParams(req, res, next) {
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== 'string') {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: `Query parameter "${key}" must be given once, as plain text` },
      });
    }
  }
  next();
}

export function apiNotFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

export function errorHandler(logger) {
  // Express recognizes an error handler by its 4 parameters, so _next must stay.
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.details !== undefined) body.error.details = err.details;
      return res.status(err.status).json(body);
    }
    // Malformed JSON body (thrown by express.json)
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    }
    // Anything else is a bug: log the details, but never leak a stack trace to the client.
    logger.error('unhandled_error', { path: req.originalUrl, message: err.message, stack: err.stack });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  };
}
