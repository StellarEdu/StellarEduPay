import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { PUBLIC_NAV_ITEMS, ADMIN_NAV_ITEMS } from "../config/navigation";

function SidebarLink({ href, i18nKey, Icon, active }) {
  const { t } = useTranslation();
  return (
    <Link
      href={href}
      className={`app-sidebar-link${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span className="app-sidebar-icon">
        <Icon size={15} />
      </span>
      {t(i18nKey)}
    </Link>
  );
}

function AppLayoutInner({ children }) {
  const { pathname } = useRouter();
  const { t } = useTranslation();
  const { isAdmin } = useAdminAuthContext();

  // #1580 — rendered from the shared navigation config (config/navigation.js),
  // the same source the top Navbar uses.
  return (
    <div className="app-layout">
      <aside className="app-sidebar" aria-label={t("nav.sidebarAria")}>
        <div>
          <div className="app-sidebar-section">{t("nav.section")}</div>
          {PUBLIC_NAV_ITEMS.map((item) => (
            <SidebarLink key={item.href} {...item} active={pathname === item.href} />
          ))}

          {isAdmin && (
            <>
              <div className="app-sidebar-section">{t("nav.adminSection")}</div>
              {ADMIN_NAV_ITEMS.map((item) => (
                <SidebarLink key={item.href} {...item} active={pathname === item.href} />
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
 * The sidebar layout for admin routes. The RequireAdmin guard is applied
 * outside this component by RouteShell (#1579), so no layout chrome renders
 * until authentication is confirmed.
 */
export default function AppLayout({ children }) {
  return <AppLayoutInner>{children}</AppLayoutInner>;
}
