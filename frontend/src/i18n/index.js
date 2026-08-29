/**
 * Internationalization setup — Issue #1420.
 *
 * Instantiates the i18next instance used across the frontend and exposes the
 * list of supported locales plus their display names.
 *
 * Resources are bundled as plain JS modules (not .json) so that the same
 * instance works unchanged under jest/babel-jest, which wraps .json imports
 * in an interop default. The default namespace is "common".
 *
 * Detection order: localStorage ("locale") -> navigator -> <html lang>.
 * `load: "languageOnly"` maps navigator codes like "fr-FR" to "fr".
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en";
import fr from "./locales/fr";
import es from "./locales/es";
import pt from "./locales/pt";
import tpi from "./locales/tpi";
import ha from "./locales/ha";

/**
 * Canonical supported locales — mirrored from backend/src/services/i18n.js.
 */
export const SUPPORTED_LOCALES = ["en", "fr", "es", "pt", "tpi", "ha"];

/**
 * Display names for the language switcher (native form).
 */
export const LOCALE_NAMES = {
  en: "English",
  fr: "Français",
  es: "Español",
  pt: "Português",
  tpi: "Tok Pisin",
  ha: "Hausa",
};

const resources = {
  en: { common: en },
  fr: { common: fr },
  es: { common: es },
  pt: { common: pt },
  tpi: { common: tpi },
  ha: { common: ha },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LOCALES,
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    ns: ["common"],
    defaultNS: "common",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "locale",
      caches: ["localStorage"],
    },
    react: {
      useSuspense: false,
    },
  });

if (typeof window !== "undefined") {
  i18n.on("languageChanged", (lng) => {
    if (!document.documentElement) return;
    document.documentElement.lang = lng;
  });
}

export default i18n;