// Helpers for parsing query-string parameters safely.

import { badRequest } from './errors.js';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

export function parsePagination(query) {
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('offset must be a non-negative integer');
  return { limit, offset };
}

export function parseBoolean(value, name) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`${name} must be "true" or "false"`);
}

export function parseId(value, name = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw badRequest(`${name} must be a positive integer`);
  return id;
}

/** Standard paginated response envelope. */
export function page({ total, items }, { limit, offset }) {
  return { items, pagination: { total, limit, offset, has_more: offset + items.length < total } };
}
