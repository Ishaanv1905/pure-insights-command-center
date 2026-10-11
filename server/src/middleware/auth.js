// Authentication and authorization middleware.
//
//   authenticate         - reads the session cookie, attaches req.user (or 401)
//   requirePermission(p) - 403 unless req.user's role grants permission p
//   requireApiKey        - machine-to-machine auth for the ingest endpoint
//
// Hiding a button in React is only cosmetic: anyone can call the API directly.
// These checks on the server are the real access control.

import crypto from 'node:crypto';
import { forbidden, unauthorized } from '../lib/errors.js';

export function authenticate({ services, config }) {
  return (req, _res, next) => {
    const user = services.auth.verifyToken(req.cookies?.[config.cookieName]);
    if (!user) return next(unauthorized());
    req.user = user;
    next();
  };
}

export function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.permissions.includes(permission)) {
      return next(forbidden(`Your role (${req.user.role}) does not have the "${permission}" permission`));
    }
    next();
  };
}

/** Constant-time comparison, so the key cannot be guessed byte by byte from response timing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function requireApiKey({ config }) {
  return (req, _res, next) => {
    const key = req.get('x-api-key');
    if (!key || !safeEqual(key, config.ingestApiKey)) return next(unauthorized('Invalid or missing API key'));
    next();
  };
}
