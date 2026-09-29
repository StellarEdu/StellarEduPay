/**
 * Route classification — the single place that decides which pages are
 * admin-only (#1579). _app.jsx wraps every route listed here in RequireAdmin,
 * so individual pages must NOT add their own guard.
 */

// Every authenticated admin page. Logged-out visitors are redirected to /login.
export const ADMIN_ROUTES = [
  "/dashboard",
  "/students",
  "/payments",
  "/reports",
  "/fees",
  "/fee-adjustments",
  "/analytics",
  "/refunds",
  "/reminders",
  "/webhooks",
  "/source-validation-rules",
  "/audit-logs",
  "/disputes",
  "/settings",
  "/security",
  "/mfa-setup",
];

// Admin routes that render full-page (no sidebar) — still guarded.
const NO_LAYOUT_ADMIN_ROUTES = ["/mfa-setup"];

// Admin routes rendered inside the AppLayout sidebar shell.
export const APP_LAYOUT_ROUTES = ADMIN_ROUTES.filter(
  (route) => !NO_LAYOUT_ADMIN_ROUTES.includes(route)
);

export const isAdminRoute = (pathname) => ADMIN_ROUTES.includes(pathname);
export const usesAppLayout = (pathname) => APP_LAYOUT_ROUTES.includes(pathname);
