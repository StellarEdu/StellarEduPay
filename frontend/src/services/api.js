import axios from "axios";
import { createRefreshHandler } from "./authRefresh";
import { API_BASE_URL, apiUrl } from "../config/apiBase";

const TIMEOUT_MS = parseInt(process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS || "15000", 10);

// Issue #1583: Default to a relative base URL so the same frontend build works
// for any deployment. The Next.js /api/* proxy rewrite (next.config.js) forwards
// same-origin /api/* requests to the backend, keeping auth cookies first-party.
// An explicit NEXT_PUBLIC_API_URL can still be set for split-origin dev setups.
const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "/api",
  timeout: TIMEOUT_MS,
  withCredentials: true,
});

// Issue #1762: Generate a UUID for idempotency keys. crypto.randomUUID is
// available in all modern browsers and Node 19+, but fall back to a
// Math.random-based v4 UUID for older environments.
export function generateIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Attach the school context header to every request unless one is already set.
// For super-admins: use selectedSchoolId from localStorage (school switcher selection).
// For school users: use schoolId from their JWT token (stored after login).
api.interceptors.request.use((config) => {
  // Issue #1762: The backend's idempotency middleware rejects non-GET requests
  // that lack an Idempotency-Key header (400 MISSING_IDEMPOTENCY_KEY). Attach a
  // generated key to any mutating request that doesn't already carry one, so
  // callers never have to remember. Callers that need a deterministic key
  // (e.g. verifyPayment) set the header explicitly and it is preserved here.
  const method = (config.method || "get").toLowerCase();
  if (method !== "get" && method !== "head" && method !== "options") {
    const hasIdempotencyKey = Object.keys(config.headers || {}).some(
      (h) => h.toLowerCase() === "idempotency-key"
    );
    if (!hasIdempotencyKey) {
      config.headers = { ...config.headers, "Idempotency-Key": generateIdempotencyKey() };
    }
  }

  const hasSchoolHeader = Object.keys(config.headers || {}).some(
    (h) => h.toLowerCase() === "x-school-id" || h.toLowerCase() === "x-school-slug"
  );
  if (!hasSchoolHeader) {
    // Super-admins select a school via the switcher, stored as selectedSchoolId.
    // School users have their schoolId from the token, stored as schoolId.
    const selectedSchoolId = typeof window !== 'undefined' ? localStorage.getItem('selectedSchoolId') : null;
    const schoolId = typeof window !== 'undefined' ? localStorage.getItem('schoolId') : null;
    
    const contextSchoolId = selectedSchoolId || schoolId;
    if (contextSchoolId) {
      config.headers = { ...config.headers, "X-School-ID": contextSchoolId };
    }
  }
  return config;
});

// On a 401 we transparently refresh the access token (the HttpOnly cookies are
// rotated by the backend) and replay the request, instead of hard-redirecting
// and losing in-flight work. Only a failed refresh sends the user to /login,
// preserving where they were via a return-to URL.
function redirectToLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login") return; // already there — avoid a redirect loop

  // The refresh failed, so the session is over — clear the client-side auth
  // state (the HttpOnly access/refresh cookies are already invalid and can
  // only be cleared server-side, but this app data must not survive into the
  // next login as stale context; see useAdminAuth's logout()).
  try {
    localStorage.removeItem("schoolId");
    localStorage.removeItem("userId");
    // Super-admin school choice belongs to the previous session; don't carry it over.
    localStorage.removeItem("selectedSchoolId");
  } catch {
    // localStorage unavailable (private browsing, disabled storage) — the
    // hard redirect below still ends the session from the app's perspective.
  }

  const returnTo = encodeURIComponent(`${pathname}${search}`);
  window.location.href = `/login?returnTo=${returnTo}`;
}

const onResponseRejected = createRefreshHandler({
  refresh: () => api.post("/auth/refresh"),
  retry: (config) => api(config),
  redirectToLogin,
  isAuthUrl: (url) => url.includes("/auth/"),
});

api.interceptors.response.use((response) => response, onResponseRejected);

// Export the bare axios instance as the default so callers that need ad-hoc
// requests (e.g. login.jsx) can use api.post('/auth/login', data) without
// coupling to a specific named helper.
export default api;

export const getStudents = (page = 1, limit = 20, { search, status, className } = {}, { signal } = {}) =>
  api.get("/students", {
    params: {
      page,
      limit,
      ...(search    && { search }),
      ...(status    && status !== "all" && { status }),
      ...(className && { class: className }),
    },
    signal,
  });
export const getStudent = (studentId, { signal } = {}) => api.get(`/students/${studentId}`, { signal });
// Public endpoint: returns only masked student info (maskedName, class).
// Does NOT require admin authentication — safe to call from the pay-fees page.
export const getPublicStudent = (studentId, { signal } = {}) =>
  api.get(`/students/public/${studentId}`, { signal });
export const registerStudent = (data) => api.post("/students", data);
export const updateStudent = (studentId, data) => api.patch(`/students/${encodeURIComponent(studentId)}`, data);
export const getPaymentSummary = () => api.get("/payments/summary");
export const getPaymentInstructions = (studentId, { signal } = {}) => api.get(`/payments/instructions/${studentId}`, { signal });
export const getStudentPayments = (studentId, { signal } = {}) => api.get(`/payments/${studentId}`, { signal });
export const getStudentBalance  = (studentId, { signal } = {}) => api.get(`/payments/balance/${studentId}`, { signal });
// Issue #1762: /payments/verify is protected by the idempotency middleware.
// Use a deterministic key derived from the txHash so retrying the same
// verification replays the cached result instead of re-processing, while a
// different hash is treated as a new request.
export const verifyPayment = (txHash) =>
  api.post(
    "/payments/verify",
    { txHash },
    { headers: { "Idempotency-Key": `verify:${txHash}` } }
  );
// Issue #1762: /payments/intent also requires an Idempotency-Key. Callers
// should generate one per logical action (e.g. with generateIdempotencyKey())
// and keep it in form state so retries of the same intent replay. If omitted,
// the request interceptor attaches a generated key.
export const createPaymentIntent = (data, idempotencyKey) =>
  api.post(
    "/payments/intent",
    data,
    idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : undefined
  );
export const syncPayments = () => api.post("/payments/sync");
export const getSyncStatus = () => api.get("/payments/sync/status");
export const getFeeStructures = () => api.get("/fees");
export const createFeeStructure = (data) => api.post("/fees", data);
export const getFeeByClass = (className) => api.get(`/fees/${className}`);
export const deleteFeeStructure = (className) => api.delete(`/fees/${encodeURIComponent(className)}`);

// Reports
export const getReport = (params = {}) => api.get("/reports", { params });
// Issue #1577 — getReportCsvUrl now returns a relative URL so it goes through
// the Next.js /api/* rewrite proxy. This keeps SameSite=Strict auth cookies
// first-party in split-host deployments. Callers that need a direct link can
// still construct an absolute URL by prepending NEXT_PUBLIC_API_URL.
export const getReportCsvUrl = (params = {}) => {
  const query = new URLSearchParams({ ...params, format: "csv" }).toString();
  return `/api/reports?${query}`;
};

// Currency conversion
export const getConversionRates = () => api.get("/payments/rates");

// Disputes
export const flagDispute = (data) => api.post("/disputes", data);
export const getDisputes = (params = {}) => api.get("/disputes", { params });
export const getDisputeById = (id) => api.get(`/disputes/${id}`);
export const resolveDispute = (id, data) =>
  api.patch(`/disputes/${id}/resolve`, data);

// Refunds
export const initiateRefund = (txHash, data) => api.post(`/payments/${txHash}/refund`, data);
export const approveRefund = (refundId, data) => api.post(`/payments/refunds/${refundId}/approve`, data);
export const getPaymentRefunds = (txHash) => api.get(`/payments/${txHash}/refunds`);
export const getSchoolRefunds = (params = {}) => api.get("/payments/refunds/school/list", { params });

// Audit logs
// Issue #1575 — backend mounts audit routes at /api/audit; the frontend
// previously called /api/audit-logs which always returned 404.
export const getRecentAuditLogs = (limit = 10) =>
  api.get("/audit/recent", { params: { limit } });
export const getAuditLogs = (params = {}) =>
  api.get("/audit", { params });

// Fee adjustment rules
export const getFeeAdjustmentRules = (schoolId) =>
  api.get("/fee-adjustments", { headers: { "X-School-ID": schoolId } });
export const createFeeAdjustmentRule = (data, schoolId) =>
  api.post("/fee-adjustments", data, { headers: { "X-School-ID": schoolId } });
export const updateFeeAdjustmentRule = (id, data, schoolId) =>
  api.put(`/fee-adjustments/${id}`, data, { headers: { "X-School-ID": schoolId } });
export const deleteFeeAdjustmentRule = (id, schoolId) =>
  api.delete(`/fee-adjustments/${id}`, { headers: { "X-School-ID": schoolId } });

// School settings
export const getSchool = (slug) => api.get(`/schools/${slug}`);
export const updateSchool = (slug, data) => api.patch(`/schools/${slug}`, data);
export const listSchools = () => api.get('/schools');

// User management
export const createUser = (data) => api.post('/admin/users', data);
export const listUsers = (params = {}) => api.get('/admin/users', { params });
export const getUser = (userId) => api.get(`/admin/users/${userId}`);
export const updateUser = (userId, data) => api.patch(`/admin/users/${userId}`, data);
export const deleteUser = (userId) => api.delete(`/admin/users/${userId}`);

export const createSchoolUser = (schoolId, data) => api.post(`/schools/${schoolId}/users`, data);
export const listSchoolUsers = (schoolId) => api.get(`/schools/${schoolId}/users`);
export const updateSchoolUser = (schoolId, userId, data) => api.patch(`/schools/${schoolId}/users/${userId}`, data);

export const setPassword = (data) => api.post('/users/set-password', data);
export const requestPasswordReset = (data) => api.post('/users/request-password-reset', data);
export const resetPassword = (data) => api.post('/users/reset-password', data);

// Payment plans
export const createPaymentPlan = (studentId, data) =>
  api.post(`/payment-plans/${studentId}`, data);
export const getPaymentPlan = (studentId, { signal } = {}) =>
  api.get(`/payment-plans/${studentId}`, { signal });
export const updateInstallment = (studentId, installmentIndex, data) =>
  api.patch(`/payment-plans/${studentId}/installment/${installmentIndex}`, data);
export const cancelPaymentPlan = (studentId) =>
  api.delete(`/payment-plans/${studentId}`);

// ── SEP-24 Anchor payments (Issue #1571) ──────────────────────────────────────
export const listAnchors = () =>
  api.get('/anchor/anchors');

export const initiateAnchorDeposit = (data) =>
  api.post('/anchor/initiate', data);

export const getAnchorDepositStatus = (anchorTxId, sep24Url, anchorId) =>
  api.get(`/anchor/status/${encodeURIComponent(anchorTxId)}`, {
    params: { sep24Url, anchorId },
  });

// Restored from 0062de7 (#1789): the merge of #1668 dropped these helpers, which
// seven admin pages import by name. Without them each page throws on first use.
export const deleteStudent = (studentId, data = {}) =>
  api.delete(`/students/${encodeURIComponent(studentId)}`, { data });

export const restoreStudent = (studentId) =>
  api.post(`/students/${encodeURIComponent(studentId)}/restore`);

export const bulkImportStudents = (file) => {
  const form = new FormData();
  form.append("file", file);
  // No explicit Content-Type: the browser sets multipart/form-data with the
  // boundary the backend's streaming CSV parser needs.
  return api.post("/students/bulk", form);
};

export const exportStudents = (params = {}) =>
  api.get("/students/export", { params, responseType: "blob" });

export const getStudentFeeHistory = (studentId, params = {}) =>
  api.get(`/students/${encodeURIComponent(studentId)}/fee-history`, { params });

export const resetStudentPayment = (studentId, data = {}) =>
  api.post(`/students/${encodeURIComponent(studentId)}/reset-payment`, data);

export const reconcileStudent = (studentId) =>
  api.post(`/students/${encodeURIComponent(studentId)}/reconcile`);

export const getOverdueStudents = () => api.get("/students/overdue");

export const getPayments = (params = {}, { signal } = {}) => api.get("/payments", { params, signal });

export const getSuspiciousPayments = (params = {}) => api.get("/payments/suspicious", { params });

export const getPendingPayments = (params = {}) => api.get("/payments/pending", { params });

export const getStuckPayments = () => api.get("/payments/stuck");

export const getOverpayments = (params = {}) => api.get("/payments/overpayments", { params });

export const reviewSuspiciousPayment = (txHash, data) =>
  api.patch(`/payments/${encodeURIComponent(txHash)}/suspicion-review`, data);

export const updatePaymentStatus = (txHash, data) =>
  api.patch(`/payments/${encodeURIComponent(txHash)}/status`, data);

export const correctPlaceholderPayment = (txHash, data) =>
  api.patch(`/payments/${encodeURIComponent(txHash)}/correct-placeholder`, data);

export const getSchoolById = (schoolId) => api.get(`/schools/${encodeURIComponent(schoolId)}`);

export const updateSchoolById = (schoolId, data) => api.patch(`/schools/${encodeURIComponent(schoolId)}`, data);

export const getSchoolSettings = (schoolId) => api.get(`/schools/${encodeURIComponent(schoolId)}/settings`);

export const updateSchoolSettings = (schoolId, data) =>
  api.patch(`/schools/${encodeURIComponent(schoolId)}/settings`, data);

export const getPaymentLimits = () => api.get("/payments/limits");

export const getAcceptedAssets = () => api.get("/payments/accepted-assets");

export const listSessions = () => api.get("/auth/sessions");

export const revokeSession = (sessionId) => api.delete(`/auth/sessions/${encodeURIComponent(sessionId)}`);

export const previewReminders = () => api.get("/reminders/preview");

export const triggerReminders = () => api.post("/reminders/trigger");

export const setReminderOptOut = (studentId, optOut) =>
  api.post("/reminders/opt-out", { studentId, optOut });

// Admin MFA enrolment for the REQUIRE_MFA flow (backend: /auth/mfa/user/*).
export const setupUserMfa = () => api.post("/auth/mfa/user/setup");
export const verifyUserMfa = (data) => api.post("/auth/mfa/user/verify", data);

// Source validation rules (backend: /source-rules, owner-only writes).
export const getSourceValidationRules = (schoolId) =>
  api.get("/source-rules", { headers: { "X-School-ID": schoolId } });
export const createSourceValidationRule = (data, schoolId) =>
  api.post("/source-rules", data, { headers: { "X-School-ID": schoolId } });
export const deleteSourceValidationRule = (id, schoolId) =>
  api.delete(`/source-rules/${id}`, { headers: { "X-School-ID": schoolId } });

// Number of students a fee adjustment rule would affect (backend: /fee-adjustments/:id/affected-count).
export const getFeeAdjustmentAffectedCount = (id, schoolId) =>
  api.get(`/fee-adjustments/${id}/affected-count`, { headers: { "X-School-ID": schoolId } });
