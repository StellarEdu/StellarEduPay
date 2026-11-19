import { getErrorMessage } from "../../utils/errorMessages";

// Issue #1830 — codes that exist only in the locale files (shared catalog) must
// resolve to their message instead of the raw server string.
describe("getErrorMessage — shared error catalog (issue #1830)", () => {
  it("resolves a catalog-only code through the locale file", () => {
    expect(getErrorMessage("ACCOUNT_LOCKED", "raw server text")).toBe(
      "Too many failed sign-in attempts. Your account is temporarily locked. Please try again later."
    );
  });

  it("still returns the raw fallback for a code the catalog does not know", () => {
    expect(getErrorMessage("NOT_IN_CATALOG_XYZ", "raw server text")).toBe(
      "raw server text"
    );
  });
});
