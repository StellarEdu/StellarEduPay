import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import "../styles/globals.css";
import Navbar from "../components/Navbar";
import RouteShell from "../components/RouteShell";
import ErrorBoundary from "../components/ErrorBoundary";
import { AdminAuthProvider } from "../hooks/AdminAuthContext";
import i18n, { SUPPORTED_LOCALES } from "../i18n";
import { ADMIN_ROUTES } from "../config/navigation";

export const ThemeContext = createContext({ dark: false, toggle: () => {} });
export const useTheme = () => useContext(ThemeContext);

// Routes that use the sidebar AppLayout (authenticated admin pages).
// Derived from ADMIN_ROUTES — filter to those that actually use AppLayout.
const APP_LAYOUT_ROUTES = [
  "/dashboard",
  "/reports",
  "/fees",
  "/fee-adjustments",
  "/audit-logs",
  "/disputes",
  "/source-validation-rules",
];

/**
 * Read the current theme state from the <html> class list, which was already
 * set by the blocking script in _document.jsx before first paint.
 * Falls back to false (light) on SSR where document is unavailable.
 *
 * Issue #1586: initialising from the class avoids a second state flip on
 * hydration and therefore eliminates the light-theme flash for dark-mode users.
 */
function getInitialDark() {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export default function MyApp({ Component, pageProps }) {
  const { pathname } = useRouter();
  // Issue #1586: lazy initialiser reads from <html> class (set by _document.jsx
  // blocking script) so the component is correct on first render — no flash.
  const [dark, setDark] = useState(getInitialDark);

  // Issue #1586: sync <html> classes whenever dark changes, but do NOT write to
  // localStorage here — that is the explicit-toggle handler's responsibility.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);

  // Issue #1586: listen to OS colour-scheme changes when the user has not
  // explicitly chosen a theme ("no value" = follow system).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => {
      // Only follow the OS preference when there is no explicit user choice.
      if (localStorage.getItem("theme") === null) {
        setDark(e.matches);
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  /**
   * Toggle dark/light and persist an explicit preference.
   * This is the ONLY place we write to localStorage — so users who never
   * call toggle() continue to follow their OS setting automatically.
   */
  const toggle = () => {
    setDark((d) => {
      const next = !d;
      localStorage.setItem("theme", next ? "dark" : "light");
      return next;
    });
  };

  const useAppLayout = APP_LAYOUT_ROUTES.includes(pathname);

  return (
    <AdminAuthProvider>
      <ThemeContext.Provider value={{ dark, toggle }}>
        <Head>
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        </Head>
        <Navbar />
        <ErrorBoundary>
          {/* #1579 — admin guard + layout are applied centrally by route. */}
          <RouteShell pathname={pathname}>
            <Component {...pageProps} />
          </RouteShell>
        </ErrorBoundary>
      </ThemeContext.Provider>
    </AdminAuthProvider>
  );
}

MyApp.getInitialProps = async ({ Component, ctx }) => {
  const pageProps = await (Component.getInitialProps
    ? Component.getInitialProps(ctx)
    : {});

  // #1385 — robots.txt only asks crawlers not to fetch these URLs; a page
  // that's still linked from somewhere else can get indexed anyway without
  // an explicit noindex signal. ADMIN_ROUTES is the canonical set of
  // authenticated admin pages (dashboard, audit logs, fee adjustments,
  // disputes, etc.), so it doubles as the noindex route list.
  if (ctx.res && ADMIN_ROUTES.includes(ctx.pathname)) {
    ctx.res.setHeader("X-Robots-Tag", "noindex");
  }

  const acceptLang = ctx.req?.headers?.["accept-language"] || "";
  const primary = acceptLang
    .split(",")[0]
    .trim()
    .split(";")[0]
    .split("-")[0]
    .toLowerCase();
  if (primary && SUPPORTED_LOCALES.includes(primary)) {
    i18n.changeLanguage(primary);
  }

  return { pageProps };
};
