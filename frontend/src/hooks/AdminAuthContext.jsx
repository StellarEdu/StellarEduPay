/**
 * AdminAuthContext — #1217
 *
 * Provides a single shared instance of useAdminAuth so every component on a
 * given page reads from the same in-memory state and the browser fires exactly
 * one /auth/me request per page load, regardless of how many components call
 * useAdminAuthContext().
 *
 * Usage
 * -----
 * 1. Mount <AdminAuthProvider> once near the root (in _app.jsx).
 * 2. Replace every `useAdminAuth()` call-site with `useAdminAuthContext()`.
 *    The returned shape is identical to useAdminAuth(), so it's a drop-in swap.
 *
 * login.jsx is the only page that needs the `login` callback — it still
 * receives it through context just like all other fields.
 *
 * Implementation note: React.createElement is used instead of JSX so this
 * file parses correctly under the project's existing Babel config
 * (@babel/preset-env only, no @babel/preset-react).
 */

import React, { createContext, useContext } from "react";
import { useAdminAuth } from "./useAdminAuth";

// The context holds the full return value of useAdminAuth().
// Initialised to null so we can detect if a consumer is used outside the provider.
const AdminAuthContext = createContext(null);

/**
 * Mount this once at the top of the component tree (e.g. in _app.jsx).
 * It instantiates useAdminAuth exactly once and publishes the result to all
 * descendants via context.
 */
export function AdminAuthProvider({ children }) {
  const auth = useAdminAuth();
  return React.createElement(
    AdminAuthContext.Provider,
    { value: auth },
    children
  );
}

/**
 * Drop-in replacement for the standalone `useAdminAuth()` call.
 * Returns the same shape: { isAdmin, checked, login, logout, schoolId, userId,
 * roles, authMeError, retryAuth }.
 *
 * Throws a clear error when used outside <AdminAuthProvider> so misconfiguration
 * surfaces immediately in development rather than silently producing bad state.
 */
export function useAdminAuthContext() {
  const ctx = useContext(AdminAuthContext);
  if (ctx === null) {
    throw new Error(
      "useAdminAuthContext must be used inside <AdminAuthProvider>. " +
      "Make sure AdminAuthProvider is mounted in _app.jsx."
    );
  }
  return ctx;
}
