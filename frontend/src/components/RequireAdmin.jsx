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
 * Usage — wrap any admin page's exported component:
 *
 *   export default function MyAdminPage() { ... }
 *   // In _app.jsx or directly:
 *   <RequireAdmin><MyAdminPage /></RequireAdmin>
 *
 * Or as a HOC (used by AppLayout internally):
 *
 *   export default RequireAdmin(MyAdminPage);
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
