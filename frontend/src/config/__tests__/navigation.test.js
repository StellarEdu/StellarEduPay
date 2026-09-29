/**
 * #1580 — navigation is defined once (config/navigation.js) and rendered by
 * both the Navbar and the AppLayout sidebar. Guard against the drift that
 * previously produced a duplicated /fees entry and React key warnings.
 */

import en from "../../i18n/locales/en";
import {
  NAV_ITEMS,
  PUBLIC_NAV_ITEMS,
  ADMIN_NAV_ITEMS,
  getNavItems,
} from "../navigation";
import { ADMIN_ROUTES } from "../routes";

function lookup(obj, dottedKey) {
  return dottedKey.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), obj);
}

describe("navigation config", () => {
  it("has unique hrefs (no duplicate items / React key collisions)", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gives every item an href, a translated label, an Icon and a valid audience", () => {
    for (const item of NAV_ITEMS) {
      expect(item.href).toMatch(/^\//);
      expect(typeof lookup(en, item.i18nKey)).toBe("string");
      expect(typeof item.Icon).toBe("function");
      expect(["public", "admin"]).toContain(item.audience);
    }
  });

  it("only lists admin items for routes that are guarded", () => {
    for (const { href } of ADMIN_NAV_ITEMS) {
      expect(ADMIN_ROUTES).toContain(href);
    }
  });

  it("never lists a guarded route as public", () => {
    for (const { href } of PUBLIC_NAV_ITEMS) {
      expect(ADMIN_ROUTES).not.toContain(href);
    }
  });

  it("shows only public items to visitors and everything to admins", () => {
    expect(getNavItems({ isAdmin: false })).toEqual(PUBLIC_NAV_ITEMS);
    expect(getNavItems({ isAdmin: true })).toEqual(NAV_ITEMS);
  });
});
