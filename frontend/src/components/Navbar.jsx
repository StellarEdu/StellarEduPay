import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import TestnetBanner from "./TestnetBanner";
import { useTheme } from "../pages/_app";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { SUPPORTED_LOCALES, LOCALE_NAMES } from "../i18n";
import styles from "../styles/Navbar.module.css";

const PUBLIC_LINKS = [
  { href: "/pay-fees",  i18nKey: "nav.payFees" },
  { href: "/dashboard", i18nKey: "nav.dashboard" },
  { href: "/reports",   i18nKey: "nav.reports" },
];

const ADMIN_LINKS = [
  { href: "/fee-adjustments", i18nKey: "nav.feeRules" },
  { href: "/audit-logs",      i18nKey: "nav.auditLogs" },
  { href: "/disputes",        i18nKey: "nav.disputes" },
  { href: "/webhooks",        i18nKey: "nav.webhooks" },
];

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
);

export default function Navbar() {
  const { pathname } = useRouter();
  const [open, setOpen] = useState(false);
  const { t, i18n } = useTranslation();
  const { dark, toggle } = useTheme();
  const { isAdmin, logout } = useAdminAuthContext();
  // #1580 — same navigation source as the AppLayout sidebar.
  const links = getNavItems({ isAdmin });
  // On sidebar routes the desktop sidebar already shows these links, so the top
  // bar only shows them where the sidebar is hidden (narrow screens).
  const hasSidebar = usesAppLayout(pathname);

  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <>

      <TestnetBanner />
      <nav className={styles.nav} aria-label={t("nav.mainNavAria")}>
        <div className={styles.inner}>
          <Link href="/" className={styles.brand}>
            <div className={styles.logo}>S</div>
            <span className={styles.name}>StellarEduPay</span>
          </Link>

          <div className={styles.links}>
            {links.map(({ href, i18nKey }) => (
              <Link
                key={href}
                href={href}
                className={`${styles.link}${pathname === href ? " " + styles.linkActive : ""}`}
                aria-current={pathname === href ? "page" : undefined}
              >
                {t(i18nKey)}
              </Link>
            ))}
          </div>

          <div className={styles.right}>
            <select
              className={styles.lang}
              value={i18n.resolvedLanguage || "en"}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              aria-label={t("nav.language")}
            >
              {SUPPORTED_LOCALES.map((lng) => (
                <option key={lng} value={lng}>{LOCALE_NAMES[lng]}</option>
              ))}
            </select>
            <button
              className={styles.themeBtn}
              onClick={toggle}
              aria-label={dark ? t("nav.switchToLight") : t("nav.switchToDark")}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </button>
            {isAdmin
              ? <button className={styles.pill} onClick={logout}>{t("actions.signOut")}</button>
              : <Link href="/login" className={`${styles.pill} ${styles.pillAccent}`}>{t("nav.adminLogin")}</Link>
            }
            <button
              className={styles.hamburger}
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-label={open ? t("nav.closeMenu") : t("nav.openMenu")}
            >
              {open ? "✕" : "☰"}
            </button>
          </div>
        </div>
      </nav>

      <div className={`${styles.mobile}${open ? " " + styles.mobileOpen : ""}`} aria-hidden={!open}>
        {links.map(({ href, i18nKey }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.link}${pathname === href ? " " + styles.linkActive : ""}`}
            onClick={() => setOpen(false)}
          >
            {t(i18nKey)}
          </Link>
        ))}
        <div className={styles.mobileDivider} />
        {isAdmin
          ? <button className={styles.pill} onClick={() => { logout(); setOpen(false); }} style={{ marginTop: "0.25rem", width: "fit-content" }}>{t("actions.signOut")}</button>
          : <Link href="/login" className={`${styles.pill} ${styles.pillAccent}`} style={{ marginTop: "0.25rem", width: "fit-content" }} onClick={() => setOpen(false)}>{t("nav.adminLogin")}</Link>
        }
      </div>
    </>
  );
}
