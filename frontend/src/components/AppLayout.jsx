import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import RequireAdmin from "./RequireAdmin";
import {
  IconDashboard,
  IconCreditCard,
  IconBarChart,
  IconLayers,
  IconFileText,
  IconMessageCircle,
  IconDollarSign,
  IconShield,
} from "./Icons";

const PUBLIC_NAV = [
  { href: "/dashboard",      label: "Dashboard",  Icon: IconDashboard },
  { href: "/pay-fees",       label: "Pay Fees",   Icon: IconCreditCard },
  { href: "/reports",        label: "Reports",    Icon: IconBarChart },
];

const ADMIN_NAV = [
  { href: "/fees",                    label: "Fees",          Icon: IconDollarSign },
  { href: "/fee-adjustments",         label: "Fee Rules",     Icon: IconLayers },
  { href: "/source-validation-rules", label: "Source Rules",  Icon: IconShield },
  { href: "/fees",                    label: "Fees",          Icon: IconCreditCard },
  { href: "/audit-logs",              label: "Audit Logs",    Icon: IconFileText },
  { href: "/disputes",                label: "Disputes",      Icon: IconMessageCircle },
];

function AppLayoutInner({ children }) {
  const { pathname } = useRouter();
  const { isAdmin } = useAdminAuthContext();

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

/**
 * AppLayout
 *
 * Wraps every admin route with the sidebar layout AND the RequireAdmin guard.
 * The guard is applied first so no layout chrome or page content renders until
 * authentication is confirmed.
 */
export default function AppLayout({ children }) {
  return (
    <RequireAdmin>
      <AppLayoutInner>{children}</AppLayoutInner>
    </RequireAdmin>
  );
}
