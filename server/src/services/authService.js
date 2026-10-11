// Authentication: password check, token issue/verify, user management.
//
// Passwords: bcrypt hashes (slow on purpose, salted), never plain text.
// Sessions:  a signed JWT stored in an httpOnly cookie (JavaScript in the page
//            cannot read it, which limits the damage of an XSS bug).
// On every request the user is re-loaded from the database, so a role change
// or a deleted user takes effect immediately instead of when the token expires.
// Logout revokes the token's id (jti) on the server, so a copied cookie stops
// working too, and any WebSocket opened with it is closed.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ROLES, permissionsFor } from './permissions.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';

const BCRYPT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Compared against when the email does not exist, so a wrong email and a wrong
// password take the same time (prevents discovering valid emails by timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', BCRYPT_ROUNDS);

export const DEMO_USERS = [
  { email: 'admin@pureinsights.local', password: 'Admin#2026', role: 'admin' },
  { email: 'analyst@pureinsights.local', password: 'Analyst#2026', role: 'analyst' },
  { email: 'viewer@pureinsights.local', password: 'Viewer#2026', role: 'viewer' },
];

export function createAuthService({ repos, config, clock, events }) {
  const { users } = repos;

  const toPublicUser = (user) => ({
    id: user.id,
    email: user.email,
    role: user.role,
    permissions: permissionsFor(user.role),
  });

  async function login(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      throw badRequest('email and password are required');
    }
    const user = users.findByEmailWithHash(email.trim());
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid email or password');

    const token = jwt.sign({ sub: String(user.id), role: user.role }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
      jwtid: crypto.randomUUID(), // unique id per session, so this one token can be revoked
    });
    const { exp } = jwt.decode(token);
    return { token, user: toPublicUser(user), expiresAt: new Date(exp * 1000) };
  }

  /**
   * Full session check: signature, expiry, not revoked, user still exists.
   * Returns { user, jti, expiresAt } or null. Never throws.
   */
  function verifySession(token) {
    if (!token) return null;
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      if (payload.jti && users.isTokenRevoked(payload.jti)) return null;
      const user = users.findById(Number(payload.sub));
      if (!user) return null;
      return { user: toPublicUser(user), jti: payload.jti, expiresAt: new Date(payload.exp * 1000) };
    } catch {
      return null; // expired, tampered or malformed
    }
  }

  /** Returns the public user for a valid session, or null. */
  function verifyToken(token) {
    return verifySession(token)?.user ?? null;
  }

  /** Ends a session server-side. Safe to call with an invalid or missing token. */
  function logout(token) {
    const session = verifySession(token);
    if (!session?.jti) return;
    users.revokeToken(session.jti, session.expiresAt.toISOString(), clock().toISOString());
    events?.publish('session.revoked', { jti: session.jti });
  }

  function validateNewUser({ email, password, role }) {
    const errors = [];
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) errors.push('email must be a valid email address');
    if (typeof password !== 'string' || password.length < 8) errors.push('password must be at least 8 characters');
    if (!ROLES.includes(role)) errors.push(`role must be one of ${ROLES.join(', ')}`);
    if (errors.length) throw badRequest('Invalid user', errors);
  }

  async function createUser(input) {
    validateNewUser(input ?? {});
    const email = input.email.trim().toLowerCase();
    if (users.findByEmailWithHash(email)) throw conflict('A user with this email already exists');
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    return toPublicUser(users.create({ email, passwordHash, role: input.role }, clock().toISOString()));
  }

  function changeRole(userId, role, actingUserId) {
    if (!ROLES.includes(role)) throw badRequest(`role must be one of ${ROLES.join(', ')}`);
    if (userId === actingUserId) throw badRequest('You cannot change your own role');
    if (!users.updateRole(userId, role)) throw notFound('User not found');
    events?.publish('user.updated', { id: userId }); // open WebSockets pick up the new role at once
    return toPublicUser(users.findById(userId));
  }

  function listUsers() {
    return users.list().map((u) => ({ ...toPublicUser(u), created_at: u.created_at }));
  }

  /** Creates the demo accounts when the users table is empty (development only). */
  async function seedDemoUsers() {
    if (users.count() > 0) return [];
    const created = [];
    for (const u of DEMO_USERS) created.push(await createUser(u));
    return created;
  }

  return { login, logout, verifySession, verifyToken, createUser, changeRole, listUsers, seedDemoUsers };
}
