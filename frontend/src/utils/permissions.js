/**
 * Role-based UI permissions (#1581).
 *
 * Mirrors the backend's route guards (requireSchoolAuth / requireAdminAuth) so
 * screens can hide or disable actions the current user is not allowed to
 * perform instead of letting them fail with a 403. The backend remains the
 * source of truth — this only shapes the UI.
 *
 * Super-admins (roles: ['super_admin'] or the legacy role 'admin') pass every
 * check, matching the backend's break-glass bypass.
 */

export const ROLES = Object.freeze({
  SUPER_ADMIN: "super_admin",
  OWNER: "owner",
  STAFF: "staff",
  READ_ONLY: "read_only",
});

const { OWNER, STAFF, READ_ONLY } = ROLES;

// Permission → school roles allowed (super-admin is always allowed).
export const PERMISSIONS = Object.freeze({
  "students.read":      [OWNER, STAFF, READ_ONLY],
  "students.write":     [OWNER, STAFF],
  "payments.read":      [OWNER, STAFF, READ_ONLY],
  "payments.write":     [OWNER, STAFF],
  "refunds.write":      [OWNER],
  "reminders.manage":   [OWNER, STAFF],
  "users.read":         [OWNER, STAFF, READ_ONLY],
  "users.manage":       [OWNER],
  // Backed by requireAdminAuth → super-admin only.
  "paymentPlans.write": [],
  "settings.write":     [],
  "sessions.manage":    [],
});

export function isSuperAdmin(roles = []) {
  return roles.includes(ROLES.SUPER_ADMIN) || roles.includes("admin");
}

/**
 * @param {string[]} roles       - roles of the current user (from /auth/me)
 * @param {string}   permission  - a key of PERMISSIONS
 * @returns {boolean}
 */
export function can(roles, permission) {
  const list = Array.isArray(roles) ? roles : [];
  if (isSuperAdmin(list)) return true;
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.some((role) => list.includes(role));
}
