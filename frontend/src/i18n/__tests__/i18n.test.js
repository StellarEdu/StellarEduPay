import i18n, { SUPPORTED_LOCALES, LOCALE_NAMES } from "../index";
import en from "../locales/en";
import fr from "../locales/fr";
import es from "../locales/es";
import pt from "../locales/pt";
import tpi from "../locales/tpi";
import ha from "../locales/ha";

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

describe("i18n setup", () => {
  it("exposes the six canonical locales", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "fr", "es", "pt", "tpi", "ha"]);
  });

  it("maps every supported locale to a display name", () => {
    expect(LOCALE_NAMES).toMatchObject({
      en: "English",
      fr: "Français",
      ha: "Hausa",
    });
  });

  it("resolves to English by default", () => {
    expect(i18n.resolvedLanguage).toBe("en");
  });

  it("resolves known keys for every supported locale", () => {
    for (const lng of SUPPORTED_LOCALES) {
      expect(i18n.t("nav.payFees", { lng })).not.toBeUndefined();
      expect(i18n.t("nav.payFees", { lng })).not.toBe("nav.payFees");
    }
  });

  it("falls back to English when a key is missing in a locale", () => {
    // "webhooks" is intentionally translated only in en/fr; es/pt/tpi/ha fall back.
    expect(i18n.t("webhooks.title", { lng: "en" })).toBe("Webhook Endpoints");
    expect(i18n.t("webhooks.title", { lng: "fr" })).toBe("Points de terminaison Webhook");
    expect(i18n.t("webhooks.title", { lng: "es" })).toBe("Webhook Endpoints");
  });

  it("returns the key for a completely unknown key", () => {
    expect(i18n.t("does.not.exist")).toBe("does.not.exist");
  });

  it("supports interpolation", () => {
    expect(i18n.t("time.minutesAgo", { mins: 5 })).toBe("5m ago");
    expect(i18n.t("time.hoursAgo", { hrs: 2 })).toBe("2h ago");
  });
});

describe("locale key parity", () => {
  const enFlat = flatten(en);
  const enKeys = Object.keys(enFlat).sort();

  it("is a large, fully-translated English resource", () => {
    expect(enKeys.length).toBeGreaterThan(600);
  });

  it("fr mirrors en key-for-key (exact parity)", () => {
    const frKeys = Object.keys(flatten(fr)).sort();
    expect(frKeys).toEqual(enKeys);
  });

  it("es/pt/tpi/ha are strict subsets of en with no foreign keys", () => {
    for (const loc of [es, pt, tpi, ha]) {
      const flat = flatten(loc);
      expect(Object.keys(flat).length).toBeLessThan(enKeys.length);
      for (const k of Object.keys(flat)) expect(enKeys).toContain(k);
    }
  });
});

describe("fully-translated locales actually translate (no copy-paste traps)", () => {
  const frFlat = flatten(fr);
  const enFlat = flatten(en);
  // Representative keys added across the conversion batches. For every one,
  // fr must render real French, not a copy of the English string.
  const samples = [
    "actions.back",
    "disputes.title",
    "auditLogs.title",
    "refunds.title",
    "webhooks.title",
    "webhooks.newEndpointBtn",
    "feeAdjustments.title",
    "disputeForm.title",
    "status.refund.approval_pending",
    "status.dispute.under_review",
  ];

  it.each(samples)("fr translates %s distinctly", (k) => {
    const enVal = enFlat[k];
    const frVal = frFlat[k];
    expect(frVal).toBeTruthy();
    expect(frVal).not.toBe(enVal);
  });
});

describe("pluralization for admin features", () => {
  it("pluralizes dispute totals", () => {
    expect(i18n.t("disputes.total", { count: 1 })).toBe("1 dispute total");
    expect(i18n.t("disputes.total", { count: 5 })).toBe("5 disputes total");
  });

  it("pluralizes the refunds pending banner", () => {
    expect(i18n.t("refunds.awaitingApproval", { count: 1 })).toBe("1 refund awaiting approval");
    expect(i18n.t("refunds.awaitingApproval", { count: 3 })).toBe("3 refunds awaiting approval");
  });

  it("uses the base key when a section has no plural forms", () => {
    expect(i18n.t("webhooks.eventsCount", { count: 2 })).toBe("2 events");
  });
});

describe("dynamic labelKey paths used by admin pages", () => {
  // Audit-logs/disputes/refunds/webhooks store a key path in the option/status
  // metadata and call t(labelKey) at render time. Those paths must resolve in
  // en and fr rather than leaking the key itself.
  const paths = [
    "webhooks.event.payment.confirmed",
    "webhooks.event.dispute.created",
    "status.dispute.open",
    "status.dispute.rejected",
    "status.refund.approval_pending",
    "status.webhook.active",
    "status.webhook.inactive",
    "status.result.success",
    "status.result.failure",
  ];

  it.each(paths)("resolves dynamic path %s in en and fr", (k) => {
    expect(i18n.t(k, { lng: "en" })).not.toBe(k);
    expect(i18n.t(k, { lng: "fr" })).not.toBe(k);
  });
});

describe("browser-only <html lang> sync (issue #1420)", () => {
  // i18n/index.js registers a languageChanged handler that keeps
  // document.documentElement.lang in step with the active locale. That block
  // is guarded by `typeof window !== "undefined"`, which never runs under
  // jest's node environment — so stub a minimal DOM and re-import the module
  // in isolation to exercise the real handler.
  const sanitizeGlobals = () => {
    delete global.window;
    delete global.document;
  };

  const fakeWindow = () => ({
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });

  afterEach(sanitizeGlobals);

  it("syncs document.documentElement.lang when the language changes", async () => {
    global.window = fakeWindow();
    global.document = {
      documentElement: { lang: "en" },
      querySelector: () => ({ getAttribute: () => "en" }),
      cookie: "",
    };

    let isolated;
    jest.isolateModules(() => {
      isolated = require("../index").default;
    });

    await isolated.changeLanguage("fr");
    expect(global.document.documentElement.lang).toBe("fr");
  });

  it("no-ops when documentElement is missing", async () => {
    global.window = fakeWindow();
    global.document = {
      documentElement: undefined,
      querySelector: () => null,
      cookie: "",
    };

    let isolated;
    jest.isolateModules(() => {
      isolated = require("../index").default;
    });

    await isolated.changeLanguage("es");
    expect(global.document.documentElement).toBeUndefined();
  });
});