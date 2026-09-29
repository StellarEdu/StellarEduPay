const express = require("express");

/**
 * Regression test for issue #1594:
 * `GET /api/payments/verify/:receiptId` was shadowed by
 * `GET /api/payments/verify/:txHash` because Express matches the first
 * declared route with the same method + path pattern. The txHash route's
 * `validateTxHashParam` middleware rejects non-64-char-hex values with 400,
 * so receipt verification was unreachable dead code.
 *
 * These tests assert that no two declared routes share the same method +
 * path pattern (which would shadow one another) and that the receipt
 * verification route is reachable on its own distinct path.
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
