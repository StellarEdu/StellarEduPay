import { useCallback } from "react";
import { useAdminAuthContext } from "./AdminAuthContext";
import { can } from "../utils/permissions";

/**
 * usePermissions — #1581
 *
 * Returns a `can(permission)` checker bound to the current user's roles.
 */
export function usePermissions() {
  const { roles } = useAdminAuthContext();
  return useCallback((permission) => can(roles, permission), [roles]);
}
