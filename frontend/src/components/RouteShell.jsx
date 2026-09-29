import RequireAdmin from "./RequireAdmin";
import AppLayout from "./AppLayout";
import { isAdminRoute, usesAppLayout } from "../config/routes";

/**
 * RouteShell — #1579
 *
 * Applies the admin guard and the sidebar layout centrally, based solely on
 * the route (see config/routes.js). Every admin route is wrapped in
 * RequireAdmin *outside* the layout, so neither the admin chrome nor the page
 * (and therefore none of its API calls) mounts until the session is confirmed.
 */
export default function RouteShell({ pathname, children }) {
  if (!isAdminRoute(pathname)) return children;

  return (
    <RequireAdmin>
      {usesAppLayout(pathname) ? <AppLayout>{children}</AppLayout> : children}
    </RequireAdmin>
  );
}
