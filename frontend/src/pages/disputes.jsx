import { useState, useEffect, useCallback } from "react";
import { getDisputes, resolveDispute } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconAlertTriangle, IconExternalLink,
  IconChevronLeft, IconChevronRight, IconSearch,
} from "../components/Icons";
import PageHero from "../components/PageHero";
import RequireAdmin from "../components/RequireAdmin";
import { useTranslation } from "react-i18next";

const STATUS_META = {
  open:         { cls: "badge-success", labelKey: "status.dispute.open" },
  under_review: { cls: "badge-warning", labelKey: "status.dispute.under_review" },
  resolved:     { cls: "badge-info",    labelKey: "status.dispute.resolved" },
  rejected:     { cls: "badge-danger",  labelKey: "status.dispute.rejected" },
};

const STELLAR_EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";

function StatusBadge({ status }) {
  const { t } = useTranslation();
  const meta = STATUS_META[status] || { cls: "badge-neutral", labelKey: null };
  return (
    <span className={`badge ${meta.cls}`} style={{ textTransform: "none" }}>
      {meta.labelKey ? t(meta.labelKey) : status}
    </span>
  );
}

function ResolveForm({ dispute, onResolved }) {
  const { t } = useTranslation();
  const [note, setNote]         = useState("");
  const [status, setStatus]     = useState("resolved");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]       = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!note.trim()) { setError(t("disputes.resolutionNoteRequired")); return; }
    setError(null);
    setSubmitting(true);
    try {
      const res = await resolveDispute(dispute._id, { resolutionNote: note.trim(), status });
      onResolved(res.data);
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("disputes.failedToResolve"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
          {t("disputes.setStatus")}
        </div>
        <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
          {[
            { value: "resolved",     labelKey: "status.dispute.resolved" },
            { value: "rejected",     labelKey: "status.dispute.rejected" },
            { value: "under_review", labelKey: "status.dispute.under_review" },
          ].map(opt => (
            <label
              key={opt.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.375rem",
                fontSize: "0.8125rem",
                cursor: "pointer",
                padding: "0.3rem 0.75rem",
                border: `1.5px solid ${status === opt.value ? "var(--accent)" : "var(--border)"}`,
                borderRadius: "var(--radius-sm)",
                background: status === opt.value ? "var(--accent-subtle)" : "transparent",
                color: status === opt.value ? "var(--accent)" : "var(--text)",
                fontWeight: status === opt.value ? 600 : 400,
                transition: "all 0.12s",
              }}
            >
              <input
                type="radio"
                name={`status-${dispute._id}`}
                value={opt.value}
                checked={status === opt.value}
                onChange={() => setStatus(opt.value)}
                style={{ display: "none" }}
              />
              {t(opt.labelKey)}
            </label>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">{t("disputes.resolutionNoteLabel")}</label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={t("disputes.resolutionNotePlaceholder")}
          className="form-input form-textarea"
          style={{ resize: "vertical" }}
        />
      </div>

      {error && (
        <p role="alert" style={{ color: "var(--danger-text)", fontSize: "0.8125rem", marginBottom: "0.5rem" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="btn btn-primary"
      >
        {submitting ? t("disputes.saving") : t("disputes.saveResolution")}
      </button>
    </form>
  );
}

function DisputeCard({ dispute, expanded, onToggle, onResolved }) {
  const { t } = useTranslation();
  const canResolve = dispute.status === "open" || dispute.status === "under_review";

  return (
    <div className="card" style={{ marginBottom: "0.75rem" }}>
      <div className="card-body">
        {/* Top row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.625rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "0.9375rem" }}>{dispute.studentId}</span>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{t("disputes.byLabel", { name: dispute.raisedBy })}</span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-subtle)" }}>
                {new Date(dispute.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </span>
            </div>
            <div style={{ marginTop: "0.375rem", display: "flex", alignItems: "center", gap: "0.375rem" }}>
              <a
                href={`${STELLAR_EXPLORER_BASE}${dispute.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", fontSize: "0.775rem", fontFamily: "monospace", display: "flex", alignItems: "center", gap: "0.25rem" }}
                aria-label={t("disputes.viewTransaction")}
              >
                {dispute.txHash?.slice(0, 18)}…
                <IconExternalLink size={11} />
              </a>
            </div>
          </div>
          <StatusBadge status={dispute.status} />
        </div>

        {/* Reason preview */}
        <p style={{ fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.6, marginBottom: "0.75rem" }}>
          {!expanded && dispute.reason?.length > 140
            ? dispute.reason.slice(0, 140) + "…"
            : dispute.reason}
        </p>

        <button
          onClick={onToggle}
          aria-expanded={expanded}
          className="btn btn-sm btn-ghost"
        >
          {expanded ? t("actions.collapse") : canResolve ? t("actions.viewAndResolve") : t("actions.viewDetails")}
        </button>

        {/* Expanded section */}
        {expanded && (
          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
            {dispute.resolutionNote && (
              <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
                <strong>{t("disputes.resolutionNotePrefix")}</strong>&nbsp;{dispute.resolutionNote}
              </div>
            )}
            {canResolve && <ResolveForm dispute={dispute} onResolved={onResolved} />}
          </div>
        )}
      </div>
    </div>
  );
}

function DisputesContent() {
  const { t } = useTranslation();
  const [disputes, setDisputes]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [page, setPage]               = useState(1);
  const [totalPages, setTotalPages]   = useState(1);
  const [totalCount, setTotalCount]   = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [studentFilter, setStudentFilter] = useState("");
  const [draftStudent, setDraftStudent]   = useState("");
  const [expanded, setExpanded]       = useState(null);

  // Auth is cookie-based; the axios interceptor in api.js handles 401 → /login redirect.

  const fetchDisputes = useCallback(async (p = page) => {
    setLoading(true);
    setError(null);
    try {
      const params = { page: p, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      if (studentFilter.trim()) params.studentId = studentFilter.trim();
      const res = await getDisputes(params);
      setDisputes(res.data.disputes || []);
      setTotalPages(res.data.pagination?.totalPages || 1);
      setTotalCount(res.data.pagination?.total || 0);
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("disputes.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, studentFilter, t]);

  useEffect(() => { fetchDisputes(page); }, [page, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleResolved(updated) {
    setDisputes(prev => prev.map(d => d._id === updated._id ? updated : d));
    setExpanded(null);
  }

  function handleSearch(e) {
    e.preventDefault();
    setStudentFilter(draftStudent);
    setPage(1);
  }

  return (
    <>
      <div className="page-wrap">
        <PageHero
          eyebrow={t("disputes.eyebrow")}
          title={t("disputes.title")}
          subtitle={t("disputes.subtitle")}
        />

        {/* Filter bar */}
        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <div className="card-body" style={{ padding: "1rem 1.25rem" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label htmlFor="dp-status" className="form-label">{t("disputes.status")}</label>
                <select
                  id="dp-status"
                  value={statusFilter}
                  onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
                  className="form-input form-select"
                  style={{ width: "auto" }}
                >
                  <option value="">{t("disputes.all")}</option>
                  <option value="open">{t("status.dispute.open")}</option>
                  <option value="under_review">{t("status.dispute.under_review")}</option>
                  <option value="resolved">{t("status.dispute.resolved")}</option>
                  <option value="rejected">{t("status.dispute.rejected")}</option>
                </select>
              </div>
              <div>
                <label htmlFor="dp-student" className="form-label">{t("disputes.studentId")}</label>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <input
                    id="dp-student"
                    type="text"
                    value={draftStudent}
                    onChange={e => setDraftStudent(e.target.value)}
                    placeholder={t("disputes.studentIdPlaceholder")}
                    className="form-input"
                    style={{ width: 160 }}
                  />
                  <button type="submit" className="btn btn-ghost" style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                    <IconSearch size={14} /> {t("disputes.search")}
                  </button>
                </div>
              </div>
              {(statusFilter || studentFilter) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setStatusFilter(""); setStudentFilter(""); setDraftStudent(""); setPage(1); }}
                  style={{ alignSelf: "flex-end" }}
                >
                  {t("disputes.clearFilters")}
                </button>
              )}
            </form>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
            <IconAlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card">
                <div className="card-body">
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <div className="skeleton" style={{ height: 16, width: 80 }} />
                      <div className="skeleton" style={{ height: 12, width: 60 }} />
                    </div>
                    <div className="skeleton" style={{ height: 20, width: 70, borderRadius: 20 }} />
                  </div>
                  <div className="skeleton" style={{ height: 12, width: "100%", marginBottom: "0.5rem" }} />
                  <div className="skeleton" style={{ height: 12, width: "70%" }} />
                </div>
              </div>
            ))}
          </div>
        ) : disputes.length === 0 ? (
          <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)" }}>
            <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>{t("disputes.empty")}</p>
            <p style={{ fontSize: "0.8125rem" }}>
              {statusFilter || studentFilter ? t("disputes.emptyFilters") : t("disputes.emptyNone")}
            </p>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
              {t("disputes.total", { count: totalCount })}
            </div>

            {disputes.map(d => (
              <DisputeCard
                key={d._id}
                dispute={d}
                expanded={expanded === d._id}
                onToggle={() => setExpanded(expanded === d._id ? null : d._id)}
                onResolved={handleResolved}
              />
            ))}

            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "1rem" }}>
                <span className="pagination-info">{t("disputes.pageOf", { page, total: totalPages })}</span>
                <div className="pagination-controls">
                  <button
                    className="page-btn"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                  >
                    <IconChevronLeft size={15} /> {t("actions.prev")}
                  </button>
                  <button
                    className="page-btn"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                  >
                    {t("actions.next")} <IconChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default function DisputesPage() {
  return (
    <RequireAdmin>
      <DisputesContent />
    </RequireAdmin>
  );
}
