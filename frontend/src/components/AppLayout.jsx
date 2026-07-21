import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useAdminAuth } from "../hooks/useAdminAuth";
import {
  IconDashboard,
  IconCreditCard,
  IconBarChart,
  IconLayers,
  IconFileText,
  IconMessageCircle,
} from "./Icons";

const PUBLIC_NAV = [
  { href: "/dashboard",      label: "Dashboard",  Icon: IconDashboard },
  { href: "/pay-fees",       label: "Pay Fees",   Icon: IconCreditCard },
  { href: "/reports",        label: "Reports",    Icon: IconBarChart },
];

const ADMIN_NAV = [
  { href: "/fee-adjustments", label: "Fee Rules",   Icon: IconLayers },
  { href: "/audit-logs",      label: "Audit Logs",  Icon: IconFileText },
  { href: "/disputes",        label: "Disputes",    Icon: IconMessageCircle },
];

export default function AppLayout({ children }) {
  const router = useRouter();
  const { pathname } = router;
  const { isAdmin, checked } = useAdminAuth();

  // Route guard: these routes require an admin session. If the auth check has
  // resolved and the user is not authenticated, send them to /login (preserving
  // where they were via returnTo). We do NOT render the protected page until
  // authenticated — otherwise it would mount and fire admin-only API calls
  // (e.g. the dashboard's /students) while logged out.
  useEffect(() => {
    if (checked && !isAdmin) {
      router.replace(`/login?returnTo=${encodeURIComponent(router.asPath)}`);
    }
  }, [checked, isAdmin, router]);

  if (!isAdmin) {
    return (
      <div className="app-layout">
        <main className="app-main" id="main-content">
          <div className="app-auth-gate" role="status" aria-live="polite">
            {checked ? "Redirecting to sign in…" : "Checking access…"}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <aside className="app-sidebar" aria-label="Sidebar navigation">
        <div>
          <div className="app-sidebar-section">Navigation</div>
          {PUBLIC_NAV.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`app-sidebar-link${pathname === href ? " active" : ""}`}
              aria-current={pathname === href ? "page" : undefined}
            >
              <span className="app-sidebar-icon">
                <Icon size={15} />
              </span>
              {label}
            </Link>
          ))}

          {isAdmin && (
            <>
              <div className="app-sidebar-section">Admin</div>
              {ADMIN_NAV.map(({ href, label, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={`app-sidebar-link${pathname === href ? " active" : ""}`}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  <span className="app-sidebar-icon">
                    <Icon size={15} />
                  </span>
                  {label}
                </Link>
              ))}
            </>
          )}
        </div>
      </aside>

      <main className="app-main" id="main-content">
        {children}
      </main>
    </div>
  );
}
