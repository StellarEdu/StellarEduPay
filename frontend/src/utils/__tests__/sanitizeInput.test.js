import { stripHtml } from "../sanitizeInput";

describe("stripHtml — issue #1391", () => {
  it("removes a script tag", () => {
    expect(stripHtml('<script>alert("xss")</script>')).toBe('alert("xss")');
  });

  it("removes an img tag with an onerror handler", () => {
    expect(stripHtml('<img src=x onerror=alert(1)>')).toBe('');
  });

  it("leaves plain text untouched", () => {
    expect(stripHtml("Alice Johnson")).toBe("Alice Johnson");
  });

  it("leaves ampersands and other non-tag characters untouched", () => {
    expect(stripHtml("Smith & Sons")).toBe("Smith & Sons");
  });

  it("strips multiple tags in one string", () => {
    expect(stripHtml("<b>Bold</b> and <i>italic</i>")).toBe("Bold and italic");
  });

  it("returns non-string values unchanged", () => {
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml(undefined)).toBeUndefined();
    expect(stripHtml(42)).toBe(42);
  });
});
