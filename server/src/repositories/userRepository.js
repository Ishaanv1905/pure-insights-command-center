// SQL for users. password_hash never leaves this layer except to the auth service.

const PUBLIC_COLUMNS = 'id, email, role, created_at';

export function createUserRepository(db) {
  return {
    findByEmailWithHash(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null;
    },
    findById(id) {
      return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id) ?? null;
    },
    list() {
      return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY id`).all();
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },
    create({ email, passwordHash, role }, now) {
      const info = db
        .prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
        .run(email, passwordHash, role, now);
      return this.findById(Number(info.lastInsertRowid));
    },
    updateRole(id, role) {
      return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id).changes;
    },
    revokeToken(jti, expiresAt, now) {
      db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(now); // keep the table small
      db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(jti, expiresAt);
    },
    isTokenRevoked(jti) {
      return Boolean(db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(jti));
    },
  };
}
