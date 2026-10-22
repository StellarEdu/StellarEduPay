'use strict';

const express = require("express");

/**
 * Regression tests for payment routes.
 *
 * Issue #1594: `GET /api/payments/verify/:receiptId` was shadowed by
 * `GET /api/payments/verify/:txHash` because Express matches the first
 * declared route with the same method + path pattern. The txHash route's
 * `validateTxHashParam` middleware rejects non-64-char-hex values with 400,
 * so receipt verification was unreachable dead code.
 *
 * These tests assert that no two declared routes share the same method +
 * path pattern (which would shadow one another) and that the receipt
 * verification route is reachable on its own distinct path.
 *
 * Issue #1723: an editing tool truncated the tail of paymentRoutes.js,
 * dropping lock/unlock, admin status patches, refunds, reconciliation and
 * `module.exports`. These tests assert every expected method + path pair is
 * registered so a regression fails loudly.
 */

/**
 * Normalize an Express path into a comparable pattern so that
 * `/verify/:txHash` and `/verify/:receiptId` are treated as identical.
 */
function normalizePath(path) {
  return path
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .replace(/:[^/]+/g, ":");
}

/**
 * Collect every route registered on an Express router (or app), including
 * routes mounted on nested routers, as `METHOD path` keys.
 */
function collectRoutes(router, prefix = "") {
  const routes = [];
  const stack = router && router.stack ? router.stack : [];

  for (const layer of stack) {
    if (layer.route) {
      const routePath = prefix + layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) {
          routes.push({ method: method.toUpperCase(), path: routePath });
        }
      }
    } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
      // Nested router mounted via router.use(...). Recover the mount path
      // from the layer's regexp when possible; otherwise fall back to prefix.
      let mountPath = prefix;
      if (layer.regexp && layer.regexp.source) {
        const match = layer.regexp.source
          .replace("^\\/", "")
          .replace("\\/?(?=\\/|$)", "")
          .replace("\\/?(?=\\/|$)", "")
          .replace(/\\(\/|\?|\^|\$|\.|\+|\*|\(|\)|\[|\]|\{|\}|\|)/g, "$1")
          .replace(/\?$/, "");
        if (match && match !== "(?=\/|$)") {
          mountPath = prefix + "/" + match;
        }
      }
      routes.push(...collectRoutes(layer.handle, mountPath));
    }
  }

  return routes;
}

function findShadowedRoutes(routes) {
  const seen = new Map();
  const shadowed = [];

  for (const route of routes) {
    const key = `${route.method} ${normalizePath(route.path)}`;
    if (seen.has(key)) {
      shadowed.push({ key, first: seen.get(key), second: route });
    } else {
      seen.set(key, route);
    }
  }

  return shadowed;
}

/**
 * Returns true if `routes` contains a route matching the given method and
 * normalised path pattern.  `:param` segments in `expectedPath` are
 * normalised to `:` before comparison so the caller does not have to know
 * the exact param name used in the router.
 */
function hasRoute(routes, method, expectedPath) {
  const normExpected = normalizePath(expectedPath);
  return routes.some(
    (r) =>
      r.method === method.toUpperCase() &&
      normalizePath(r.path) === normExpected,
  );
}

describe("payment routes (#1594)", () => {
  let paymentRoutes;

  beforeAll(() => {
    // Require lazily so the test can be skipped cleanly if the module
    // cannot be loaded in isolation.
    paymentRoutes = require("../paymentRoutes");
  });

  it("declares no two routes with the same method + path pattern", () => {
    const routes = collectRoutes(paymentRoutes);
    const shadowed = findShadowedRoutes(routes);

    expect(shadowed).toEqual([]);
  });

  it("exposes receipt verification on a distinct, reachable path", () => {
    const routes = collectRoutes(paymentRoutes);
    const receiptVerify = routes.filter(
      (r) => r.method === "GET" && /receipt/i.test(r.path) && /verify/i.test(r.path)
    );

    expect(receiptVerify.length).toBeGreaterThan(0);

    // The receipt verification path must not collide with the txHash
    // verification path pattern.
    const txHashVerify = routes.find(
      (r) => r.method === "GET" && /verify/i.test(r.path) && /txhash/i.test(r.path)
    );

    if (txHashVerify) {
      const txHashKey = normalizePath(txHashVerify.path);
      for (const route of receiptVerify) {
        expect(normalizePath(route.path)).not.toBe(txHashKey);
      }
    }
  });

  it("does not register GET /verify/:receiptId (the shadowed path)", () => {
    const routes = collectRoutes(paymentRoutes);
    const shadowedReceipt = routes.find(
      (r) =>
        r.method === "GET" &&
        normalizePath(r.path) === normalizePath("/verify/:receiptId")
    );

    expect(shadowedReceipt).toBeUndefined();
  });
});

/**
 * Issue #1723 — router.stack coverage.
 *
 * Every route that existed before commit ab0e00a truncated the file must be
 * present. If any of these assertions fails it means the route was removed or
 * the file was truncated again.
 */
describe("payment routes (#1723) — all required routes are registered", () => {
  let routes;

  beforeAll(() => {
    const paymentRoutes = require("../paymentRoutes");
    routes = collectRoutes(paymentRoutes);
  });

  it("exports the router so app.js can mount it", () => {
    const paymentRoutes = require("../paymentRoutes");
    expect(paymentRoutes).toBeDefined();
    expect(typeof paymentRoutes).toBe("function");
    expect(Array.isArray(paymentRoutes.stack)).toBe(true);
  });

  // ── Core payment endpoints ──────────────────────────────────────────────
  it("registers GET /verify/:txHash", () => {
    expect(hasRoute(routes, "GET", "/verify/:txHash")).toBe(true);
  });

  it("registers GET /receipts/:receiptId/verify", () => {
    expect(hasRoute(routes, "GET", "/receipts/:receiptId/verify")).toBe(true);
  });

  it("registers POST /intent", () => {
    expect(hasRoute(routes, "POST", "/intent")).toBe(true);
  });

  it("registers POST /submit", () => {
    expect(hasRoute(routes, "POST", "/submit")).toBe(true);
  });

  it("registers POST /verify", () => {
    expect(hasRoute(routes, "POST", "/verify")).toBe(true);
  });

  it("registers POST /sync", () => {
    expect(hasRoute(routes, "POST", "/sync")).toBe(true);
  });

  it("registers POST /finalize", () => {
    expect(hasRoute(routes, "POST", "/finalize")).toBe(true);
  });

  // ── Query / read endpoints ──────────────────────────────────────────────
  it("registers GET /", () => {
    expect(hasRoute(routes, "GET", "/")).toBe(true);
  });

  it("registers GET /summary", () => {
    expect(hasRoute(routes, "GET", "/summary")).toBe(true);
  });

  it("registers GET /accepted-assets", () => {
    expect(hasRoute(routes, "GET", "/accepted-assets")).toBe(true);
  });

  it("registers GET /limits", () => {
    expect(hasRoute(routes, "GET", "/limits")).toBe(true);
  });

  it("registers GET /sync/status", () => {
    expect(hasRoute(routes, "GET", "/sync/status")).toBe(true);
  });

  it("registers GET /events", () => {
    expect(hasRoute(routes, "GET", "/events")).toBe(true);
  });

  it("registers GET /overpayments", () => {
    expect(hasRoute(routes, "GET", "/overpayments")).toBe(true);
  });

  it("registers GET /suspicious", () => {
    expect(hasRoute(routes, "GET", "/suspicious")).toBe(true);
  });

  it("registers GET /pending", () => {
    expect(hasRoute(routes, "GET", "/pending")).toBe(true);
  });

  it("registers GET /stuck", () => {
    expect(hasRoute(routes, "GET", "/stuck")).toBe(true);
  });

  it("registers GET /retry-queue", () => {
    expect(hasRoute(routes, "GET", "/retry-queue")).toBe(true);
  });

  it("registers GET /rates", () => {
    expect(hasRoute(routes, "GET", "/rates")).toBe(true);
  });

  it("registers GET /dlq", () => {
    expect(hasRoute(routes, "GET", "/dlq")).toBe(true);
  });

  it("registers POST /dlq/:id/retry", () => {
    expect(hasRoute(routes, "POST", "/dlq/:id/retry")).toBe(true);
  });

  it("registers GET /balance/:studentId", () => {
    expect(hasRoute(routes, "GET", "/balance/:studentId")).toBe(true);
  });

  it("registers GET /instructions/:studentId", () => {
    expect(hasRoute(routes, "GET", "/instructions/:studentId")).toBe(true);
  });

  it("registers GET /receipt/:txHash", () => {
    expect(hasRoute(routes, "GET", "/receipt/:txHash")).toBe(true);
  });

  it("registers GET /queue/:txHash", () => {
    expect(hasRoute(routes, "GET", "/queue/:txHash")).toBe(true);
  });

  it("registers GET /:studentId", () => {
    expect(hasRoute(routes, "GET", "/:studentId")).toBe(true);
  });

  // ── Lock / unlock (lost in truncation) ─────────────────────────────────
  it("registers POST /:paymentId/lock", () => {
    expect(hasRoute(routes, "POST", "/:paymentId/lock")).toBe(true);
  });

  it("registers POST /:paymentId/unlock", () => {
    expect(hasRoute(routes, "POST", "/:paymentId/unlock")).toBe(true);
  });

  // ── Status patches (lost in truncation) ────────────────────────────────
  it("registers PATCH /bulk/status", () => {
    expect(hasRoute(routes, "PATCH", "/bulk/status")).toBe(true);
  });

  it("registers PATCH /:txHash/status", () => {
    expect(hasRoute(routes, "PATCH", "/:txHash/status")).toBe(true);
  });

  it("registers PATCH /:txHash/suspicion-review", () => {
    expect(hasRoute(routes, "PATCH", "/:txHash/suspicion-review")).toBe(true);
  });

  it("registers PATCH /:txHash/correct-placeholder", () => {
    expect(hasRoute(routes, "PATCH", "/:txHash/correct-placeholder")).toBe(true);
  });

  // ── Reconciliation (lost in truncation) ────────────────────────────────
  it("registers GET /reconciliation/reports", () => {
    expect(hasRoute(routes, "GET", "/reconciliation/reports")).toBe(true);
  });

  it("registers POST /reconciliation/report", () => {
    expect(hasRoute(routes, "POST", "/reconciliation/report")).toBe(true);
  });

  // ── Refunds (lost in truncation) ───────────────────────────────────────
  it("registers GET /refunds/school/list", () => {
    expect(hasRoute(routes, "GET", "/refunds/school/list")).toBe(true);
  });

  it("registers POST /refunds/:refundId/approve", () => {
    expect(hasRoute(routes, "POST", "/refunds/:refundId/approve")).toBe(true);
  });

  it("registers POST /refunds/:refundId/reject", () => {
    expect(hasRoute(routes, "POST", "/refunds/:refundId/reject")).toBe(true);
  });

  it("registers POST /refunds/:refundId/complete", () => {
    expect(hasRoute(routes, "POST", "/refunds/:refundId/complete")).toBe(true);
  });

  it("registers POST /:txHash/refund", () => {
    expect(hasRoute(routes, "POST", "/:txHash/refund")).toBe(true);
  });

  it("registers GET /:txHash/refunds", () => {
    expect(hasRoute(routes, "GET", "/:txHash/refunds")).toBe(true);
  });

  // ── Ordering invariants ─────────────────────────────────────────────────
  // /refunds/school/list must appear before any /:txHash/* route so Express
  // does not swallow the literal "refunds" path segment as a txHash value.
  it("registers /refunds/school/list before /:txHash/* routes", () => {
    const stack = collectRoutes(require("../paymentRoutes"));
    const schoolListIdx = stack.findIndex(
      (r) =>
        r.method === "GET" &&
        normalizePath(r.path) === normalizePath("/refunds/school/list"),
    );
    // Find the first parameterised /:txHash/... route (normalized to /:/...)
    const firstTxHashRouteIdx = stack.findIndex(
      (r) => normalizePath(r.path).startsWith("/:"),
    );
    expect(schoolListIdx).toBeGreaterThan(-1);
    expect(firstTxHashRouteIdx).toBeGreaterThan(-1);
    expect(schoolListIdx).toBeLessThan(firstTxHashRouteIdx);
  });

  it("registers /reconciliation/* before /:txHash/* routes", () => {
    const stack = collectRoutes(require("../paymentRoutes"));
    const reconciliationIdx = stack.findIndex(
      (r) => r.path.startsWith("/reconciliation"),
    );
    const firstTxHashRouteIdx = stack.findIndex(
      (r) => normalizePath(r.path).startsWith("/:"),
    );
    expect(reconciliationIdx).toBeGreaterThan(-1);
    expect(firstTxHashRouteIdx).toBeGreaterThan(-1);
    expect(reconciliationIdx).toBeLessThan(firstTxHashRouteIdx);
  });

  it("registers every expected method + path pair", () => {
    const registered = new Set(
      routes.map((r) => `${r.method} ${normalizePath(r.path)}`)
    );

    const expected = [
      // lock / unlock
      "POST /:paymentId/lock",
      "POST /:paymentId/unlock",
      // admin status patches
      "PATCH /bulk/status",
      "PATCH /:txHash/status",
      "PATCH /:txHash/suspicion-review",
      "PATCH /:txHash/correct-placeholder",
      // refunds
      "POST /:txHash/refund",
      "POST /refunds/:refundId/approve",
      "GET /:txHash/refunds",
      "GET /refunds/school/list",
      // receipt verification
      "GET /verify/:receiptId",
      // reconciliation
      "GET /reconciliation/reports",
      "POST /reconciliation/report",
    ];

    const missing = expected.filter(
      (key) => !registered.has(normalizePath(key).replace(/^([A-Z]+) /, "$1 "))
    );

    expect(missing).toEqual([]);
  });
});
