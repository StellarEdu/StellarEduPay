import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
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
} from "./Icons";

const PUBLIC_NAV = [
  { href: "/dashboard",      i18nKey: "nav.dashboard",  Icon: IconDashboard },
  { href: "/pay-fees",       i18nKey: "nav.payFees",   Icon: IconCreditCard },
  { href: "/reports",        i18nKey: "nav.reports",   Icon: IconBarChart },
];

const ADMIN_NAV = [
  { href: "/fees",            i18nKey: "nav.fees",        Icon: IconDollarSign },
  { href: "/fee-adjustments", i18nKey: "nav.feeRules",   Icon: IconLayers },
  { href: "/fees",            i18nKey: "nav.fees",        Icon: IconCreditCard },
  { href: "/audit-logs",      i18nKey: "nav.auditLogs",  Icon: IconFileText },
  { href: "/disputes",        i18nKey: "nav.disputes",    Icon: IconMessageCircle },
];

function AppLayoutInner({ children }) {
  const { pathname } = useRouter();
  const { t } = useTranslation();
  const { isAdmin } = useAdminAuthContext();

  return (
    <div className="app-layout">
      <aside className="app-sidebar" aria-label={t("nav.sidebarAria")}>
        <div>
          <div className="app-sidebar-section">{t("nav.section")}</div>
          {PUBLIC_NAV.map(({ href, i18nKey, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`app-sidebar-link${pathname === href ? " active" : ""}`}
              aria-current={pathname === href ? "page" : undefined}
            >
              <span className="app-sidebar-icon">
                <Icon size={15} />
              </span>
              {t(i18nKey)}
            </Link>
          ))}

          {isAdmin && (
            <>
              <div className="app-sidebar-section">{t("nav.adminSection")}</div>
              {ADMIN_NAV.map(({ href, i18nKey, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={`app-sidebar-link${pathname === href ? " active" : ""}`}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  <span className="app-sidebar-icon">
                    <Icon size={15} />
                  </span>
                  {t(i18nKey)}
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
