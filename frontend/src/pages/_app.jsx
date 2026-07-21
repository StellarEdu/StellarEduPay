import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/router";
import "../styles/globals.css";
import "../styles/redesign.css";
import Navbar from "../components/Navbar";
import AppLayout from "../components/AppLayout";
import ErrorBoundary from "../components/ErrorBoundary";

export const ThemeContext = createContext({ dark: false, toggle: () => {} });
export const useTheme = () => useContext(ThemeContext);

const APP_LAYOUT_ROUTES = [
  "/dashboard",
  "/reports",
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
    <ThemeContext.Provider value={{ dark, toggle: () => setDark((d) => !d) }}>
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
  );
}
