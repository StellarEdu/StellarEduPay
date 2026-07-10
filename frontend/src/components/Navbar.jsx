import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import TestnetBanner from "./TestnetBanner";
import { useTheme } from "../pages/_app";
import { useAdminAuth } from "../hooks/useAdminAuth";

const PUBLIC_LINKS = [
  { href: "/pay-fees",  label: "Pay Fees" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/reports",   label: "Reports" },
];

const ADMIN_LINKS = [
  { href: "/fee-adjustments", label: "Fee Rules" },
  { href: "/audit-logs",      label: "Audit Logs" },
  { href: "/disputes",        label: "Disputes" },
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
  const { dark, toggle } = useTheme();
  const { isAdmin, logout } = useAdminAuth();
  const links = isAdmin ? [...PUBLIC_LINKS, ...ADMIN_LINKS] : PUBLIC_LINKS;

  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <>
      <style>{`
        .nav {
          background: #0e1424;
          background-image: radial-gradient(600px 120px at 18% 0%, rgba(16,185,129,0.20), transparent 70%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.07);
          position: sticky;
          top: 0;
          z-index: 200;
          backdrop-filter: saturate(140%);
        }
        .nav-inner {
          max-width: 1280px;
          margin: 0 auto;
          padding: 0 1.5rem;
          height: 60px;
          display: flex;
          align-items: center;
          gap: 1.5rem;
        }
        .nav-brand {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          text-decoration: none;
          flex-shrink: 0;
          margin-right: 0.5rem;
        }
        .nav-logo {
          width: 32px; height: 32px;
          background: linear-gradient(135deg, #34d399 0%, #059669 55%, #0d9488 100%);
          border-radius: 9px;
          display: flex; align-items: center; justify-content: center;
          font-weight: 900; font-size: 0.85rem; color: #fff;
          flex-shrink: 0;
          letter-spacing: -0.05em;
          box-shadow: 0 4px 14px -2px rgba(5,150,105,0.6);
        }
        .nav-name {
          color: #f1f5f9;
          font-weight: 700;
          font-size: 0.9375rem;
          letter-spacing: -0.02em;
          white-space: nowrap;
        }
        .nav-links {
          display: flex;
          align-items: center;
          gap: 0.125rem;
          flex: 1;
        }
        .nav-link {
          color: rgba(255, 255, 255, 0.5);
          text-decoration: none;
          font-size: 0.8375rem;
          font-weight: 500;
          padding: 0.375rem 0.7rem;
          border-radius: 6px;
          transition: color 0.12s, background 0.12s;
          white-space: nowrap;
        }
        .nav-link:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
        .nav-link.active { color: #fff; background: rgba(255, 255, 255, 0.1); font-weight: 600; }
        .nav-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
        .nav-theme-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px; height: 32px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s, color 0.12s;
        }
        .nav-theme-btn:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.2);
          color: #fff;
        }
        .nav-pill {
          display: inline-flex; align-items: center;
          background: transparent;
          border: 1.5px solid rgba(255, 255, 255, 0.14);
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.65);
          cursor: pointer;
          font: 500 0.8rem/1 inherit;
          padding: 0.375rem 0.875rem;
          transition: all 0.12s;
          text-decoration: none;
          white-space: nowrap;
        }
        .nav-pill:hover {
          border-color: rgba(255, 255, 255, 0.3);
          color: #fff;
          background: rgba(255, 255, 255, 0.06);
        }
        .nav-pill-accent {
          background: linear-gradient(135deg, #059669 0%, #0d9488 100%);
          border: none;
          color: #fff;
          font-weight: 700;
          box-shadow: 0 4px 14px -3px rgba(5,150,105,0.6);
        }
        .nav-pill-accent:hover {
          filter: brightness(1.08);
          color: #fff;
          background: linear-gradient(135deg, #059669 0%, #0d9488 100%);
        }
        .nav-hamburger {
          display: none;
          align-items: center;
          justify-content: center;
          width: 32px; height: 32px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 7px;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.7);
          font-size: 1.1rem;
          line-height: 1;
        }
        .nav-mobile {
          display: none;
          flex-direction: column;
          background: #0c1525;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          padding: 0.5rem 1rem 1rem;
          gap: 0.125rem;
        }
        .nav-mobile.open { display: flex; }
        .nav-mobile-divider {
          height: 1px;
          background: rgba(255,255,255,0.07);
          margin: 0.5rem 0;
        }
        @media (max-width: 720px) {
          .nav-links { display: none; }
          .nav-hamburger { display: flex; }
        }
      `}</style>

      <TestnetBanner />
      <nav className="nav" aria-label="Main navigation">
        <div className="nav-inner">
          <Link href="/" className="nav-brand">
            <div className="nav-logo">S</div>
            <span className="nav-name">StellarEduPay</span>
          </Link>

          <div className="nav-links">
            {links.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`nav-link${pathname === href ? " active" : ""}`}
                aria-current={pathname === href ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </div>

          <div className="nav-right">
            <button
              className="nav-theme-btn"
              onClick={toggle}
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </button>
            {isAdmin
              ? <button className="nav-pill" onClick={logout}>Sign out</button>
              : <Link href="/login" className="nav-pill nav-pill-accent">Admin Login</Link>
            }
            <button
              className="nav-hamburger"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-label={open ? "Close menu" : "Open menu"}
            >
              {open ? "✕" : "☰"}
            </button>
          </div>
        </div>
      </nav>

      <div className={`nav-mobile${open ? " open" : ""}`} aria-hidden={!open}>
        {links.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`nav-link${pathname === href ? " active" : ""}`}
            onClick={() => setOpen(false)}
          >
            {label}
          </Link>
        ))}
        <div className="nav-mobile-divider" />
        {isAdmin
          ? <button className="nav-pill" onClick={() => { logout(); setOpen(false); }} style={{ marginTop: "0.25rem", width: "fit-content" }}>Sign out</button>
          : <Link href="/login" className="nav-pill nav-pill-accent" style={{ marginTop: "0.25rem", width: "fit-content" }} onClick={() => setOpen(false)}>Admin Login</Link>
        }
      </div>
    </>
  );
}
