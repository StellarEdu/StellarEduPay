import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import "../styles/globals.css";
import "../styles/redesign.css";
import Navbar from "../components/Navbar";
import AppLayout from "../components/AppLayout";
import ErrorBoundary from "../components/ErrorBoundary";
import { AdminAuthProvider } from "../hooks/AdminAuthContext";
import i18n, { SUPPORTED_LOCALES } from "../i18n";

export const ThemeContext = createContext({ dark: false, toggle: () => {} });
export const useTheme = () => useContext(ThemeContext);

const APP_LAYOUT_ROUTES = [
  "/dashboard",
  "/reports",
  "/fees",
  "/fee-adjustments",
  "/audit-logs",
  "/disputes",
];

export default function MyApp({ Component, pageProps }) {
  const { pathname } = useRouter();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "dark") {
      setDark(true);
    } else if (saved === "light") {
      setDark(false);
    } else {
      setDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const useAppLayout = APP_LAYOUT_ROUTES.includes(pathname);

  return (
    <AdminAuthProvider>
      <ThemeContext.Provider value={{ dark, toggle: () => setDark((d) => !d) }}>
        <Head>
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        </Head>
        <Navbar />
        <ErrorBoundary>
          {useAppLayout ? (
            <AppLayout>
              <Component {...pageProps} />
            </AppLayout>
          ) : (
            <Component {...pageProps} />
          )}
        </ErrorBoundary>
      </ThemeContext.Provider>
    </AdminAuthProvider>
  );
}

MyApp.getInitialProps = async ({ Component, ctx }) => {
  const pageProps = await (Component.getInitialProps
    ? Component.getInitialProps(ctx)
    : {});

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
