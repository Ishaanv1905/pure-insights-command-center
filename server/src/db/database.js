// Opens the SQLite database and applies the schema.
// Pass ':memory:' for a throwaway database (used by the tests).
//
// Uses Node's built-in SQLite driver (node:sqlite, Node 22.13+), so the project
// has NO native dependencies: `npm install` never needs a C++ compiler, on any OS.
// The API is synchronous, like better-sqlite3: for an embedded database a query
// takes microseconds, so there is nothing to gain from callbacks or promises.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL'); // readers do not block the writer
  db.exec('PRAGMA foreign_keys = ON'); // SQLite has foreign keys OFF by default
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

/**
 * Wraps `fn` so that everything it does runs in ONE transaction:
 * all writes are committed together, or none are (rollback on any error).
 * Returns a function with the same arguments as `fn`.
 */
export function transaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}
