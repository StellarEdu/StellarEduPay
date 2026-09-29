import { useAdminAuthContext } from "./AdminAuthContext";

/**
 * School in scope for admin screens (#1581): the user's own school from
 * /auth/me, or — for super-admins, who are not bound to one school — the
 * school chosen in the school switcher (localStorage `selectedSchoolId`).
 */
export function useActiveSchoolId() {
  const { schoolId } = useAdminAuthContext();
  if (schoolId) return schoolId;
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("selectedSchoolId");
  } catch {
    return null;
  }
}
