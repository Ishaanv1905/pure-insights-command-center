// /api/auth - login, logout, current user.
// Routes are thin: read the request, call a service, send the response.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

export function authRoutes({ services, config }, { authenticate }) {
  const router = Router();

  // Slows down password guessing: N attempts per IP per window.
  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimit.windowMs,
    limit: config.loginRateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many login attempts, try again later' } },
  });

  const cookieOptions = {
    httpOnly: true, // not readable from JavaScript
    sameSite: 'strict', // not sent on cross-site requests (CSRF protection)
    secure: config.isProduction, // HTTPS only in production
    path: '/',
  };

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    const { token, user, expiresAt } = await services.auth.login(email, password);
    // The cookie lives exactly as long as the token inside it (JWT_EXPIRES_IN).
    res.cookie(config.cookieName, token, { ...cookieOptions, expires: expiresAt });
    res.json({ user });
  });

  // Revokes the session on the server (not just in this browser) and clears the cookie.
  router.post('/logout', (req, res) => {
    services.auth.logout(req.cookies?.[config.cookieName]);
    res.clearCookie(config.cookieName, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
