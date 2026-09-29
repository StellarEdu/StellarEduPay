import { Html, Head, Main, NextScript } from "next/document";

/**
 * Custom Next.js Document — Issue #1586.
 *
 * Injects a tiny blocking <script> that runs synchronously before the first
 * paint to apply the correct dark/light class to <html>. This eliminates the
 * Flash Of Unstyled Content (FOUC) dark-mode users would otherwise see while
 * React hydrates and the client-side useEffect fires.
 *
 * Logic mirrors what _app.jsx does at runtime:
 *   1. If the user has explicitly chosen a theme (localStorage "theme" = "dark"
 *      | "light"), honour it.
 *   2. Otherwise follow the OS / system preference via matchMedia.
 *
 * The script is intentionally kept tiny and is inlined (no external request).
 * It must not use ES2015+ syntax that older browsers cannot parse before the
 * polyfill loads — plain var + function is safest here.
 */

const themeScript = `
(function () {
  try {
    var saved = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = saved === 'dark' || (saved === null && prefersDark);
    document.documentElement.classList.add(isDark ? 'dark' : 'light');
    document.documentElement.classList.remove(isDark ? 'light' : 'dark');
  } catch (e) {
    // localStorage may be blocked in some privacy modes; default to light.
    document.documentElement.classList.add('light');
  }
})();
`.trim();

export default function Document() {
  return (
    <Html>
      <Head>
        {/* Blocking theme initialisation — must be the very first script */}
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
