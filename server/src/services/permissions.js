// Role-Based Access Control, defined in ONE place.
//
// Routes ask for a PERMISSION ("alerts:acknowledge"), never for a role name.
// Changing what a role may do is then a one-line edit here, and routes do not
// need to know which roles exist.
//
// Roles:
//   viewer  - read-only operational view (health, reports, orphaned list, alerts)
//   analyst - viewer + acknowledge alerts, cost attribution, data quality, reading history
//   admin   - analyst + assign owners to orphaned reports, manage users

export const ROLES = ['viewer', 'analyst', 'admin'];

const ROLE_PERMISSIONS = {
  viewer: ['health:read', 'reports:read', 'alerts:read'],
  analyst: [
    'health:read',
    'reports:read',
    'readings:read',
    'alerts:read',
    'alerts:acknowledge',
    'cost:read',
    'data-quality:read',
  ],
  admin: [
    'health:read',
    'reports:read',
    'readings:read',
    'alerts:read',
    'alerts:acknowledge',
    'cost:read',
    'data-quality:read',
    'reports:assign-owner',
    'users:manage',
  ],
};

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role, permission) {
  return permissionsFor(role).includes(permission);
}
