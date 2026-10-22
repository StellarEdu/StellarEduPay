import axios from "axios";
import { API_BASE_URL } from "../config/apiBase";

// #1637 — API client for the parent portal. Deliberately separate from
// services/api.js: parents have no staff session, so this client sends no
// cookies or X-School-ID header and must never trigger the staff
// refresh-then-redirect-to-/login flow on a 401.
const TOKEN_KEY = "parentPortalToken";

export function loadParentToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveParentToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — the token then only lives for this page view
  }
}

export function createParentApi(token) {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: 15000,
    withCredentials: false,
    headers: { "X-Parent-Token": token },
  });
}
