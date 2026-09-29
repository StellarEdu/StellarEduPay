import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { useTranslation } from "react-i18next";

/**
 * RequireAdmin
 *
 * A centralized route-guard component that blocks all child rendering until
 * the authentication check resolves, then redirects unauthenticated or
 * under-privileged users to /login before any protected content is shown.
 *
 * Usage — applied centrally (#1579): _app.jsx renders every route listed in
 * ADMIN_ROUTES (src/config/routes.js) inside <RouteShell>, which wraps it in
 * <RequireAdmin>. To protect a new admin page, add its path to ADMIN_ROUTES;
 * do not wrap pages individually.
 *
 * Guarantees:
 *  - No protected JSX is rendered until `checked` is true AND `isAdmin` is true.
 *  - While the auth check is in flight, a neutral loading placeholder is shown.
 *  - On auth failure, the user is redirected to /login with a returnTo param
 *    before the protected content mounts.
 *
 * @param {{ children: React.ReactNode }} props
 */
export default function RequireAdmin({ children }) {
  const router = useRouter();
  const { isAdmin, checked } = useAdminAuthContext();
  const { t } = useTranslation();

  useEffect(() => {
    // Only act once the /auth/me round-trip has completed.
    if (checked && !isAdmin) {
      router.replace(
        `/login?returnTo=${encodeURIComponent(router.asPath)}`
      );
    }
  }, [checked, isAdmin, router]);

  // Block all child rendering until the auth state is resolved AND confirmed.
  // This prevents any flash of protected content and prevents admin-only API
  // calls from firing on behalf of unauthenticated users.
  if (!checked || !isAdmin) {
    return (
      <div
        className="app-auth-gate"
        role="status"
        aria-live="polite"
        data-testid="require-admin-gate"
      >
        {checked ? t("auth.redirecting") : t("auth.checking")}
      </div>
    );
  }

  return children;
}
