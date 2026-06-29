import { useState, useEffect, useCallback } from "react";
import { getDisputes, resolveDispute } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconAlertTriangle, IconExternalLink,
  IconChevronLeft, IconChevronRight, IconSearch,
} from "../components/Icons";
import PageHero from "../components/PageHero";

const STATUS_META = {
  open:         { cls: "badge-success", label: "Open" },
  under_review: { cls: "badge-warning", label: "Under Review" },
  resolved:     { cls: "badge-info",    label: "Resolved" },
  rejected:     { cls: "badge-danger",  label: "Rejected" },
};

const STELLAR_EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { cls: "badge-neutral", label: status };
  return (
    <span className={`badge ${meta.cls}`} style={{ textTransform: "none" }}>
      {meta.label}
    </span>
  );
}

function ResolveForm({ dispute, onResolved }) {
  const [note, setNote]         = useState("");
  const [status, setStatus]     = useState("resolved");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]       = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!note.trim()) { setError("Resolution note is required."); return; }
    setError(null);
    setSubmitting(true);
    try {
      const res = await resolveDispute(dispute._id, { resolutionNote: note.trim(), status });
      onResolved(res.data);
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to resolve dispute.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
          Set status
        </div>
        <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
          {[
            { value: "resolved",     label: "Resolved" },
            { value: "rejected",     label: "Rejected" },
            { value: "under_review", label: "Under Review" },
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
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Resolution Note *</label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="Explain the resolution…"
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
        {submitting ? "Saving…" : "Save Resolution"}
      </button>
    </form>
  );
}

function DisputeCard({ dispute, expanded, onToggle, onResolved }) {
  const canResolve = dispute.status === "open" || dispute.status === "under_review";

  return (
    <div className="card" style={{ marginBottom: "0.75rem" }}>
      <div className="card-body">
        {/* Top row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.625rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "0.9375rem" }}>{dispute.studentId}</span>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>by {dispute.raisedBy}</span>
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
                aria-label={`View transaction on Stellar Explorer`}
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
          {expanded ? "Collapse" : canResolve ? "View & Resolve" : "View Details"}
        </button>

        {/* Expanded section */}
        {expanded && (
          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
            {dispute.resolutionNote && (
              <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
                <strong>Resolution note:</strong>&nbsp;{dispute.resolutionNote}
              </div>
            )}
            {canResolve && <ResolveForm dispute={dispute} onResolved={onResolved} />}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DisputesPage() {
  const [disputes, setDisputes]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [page, setPage]               = useState(1);
  const [totalPages, setTotalPages]   = useState(1);
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
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to load disputes.");
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, studentFilter]);

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
          eyebrow="Support"
          title="Payment Disputes"
          subtitle="Review and resolve payment disputes raised by parents and guardians."
        />

        {/* Filter bar */}
        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <div className="card-body" style={{ padding: "1rem 1.25rem" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label htmlFor="dp-status" className="form-label">Status</label>
                <select
                  id="dp-status"
                  value={statusFilter}
                  onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
                  className="form-input form-select"
                  style={{ width: "auto" }}
                >
                  <option value="">All</option>
                  <option value="open">Open</option>
                  <option value="under_review">Under Review</option>
                  <option value="resolved">Resolved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div>
                <label htmlFor="dp-student" className="form-label">Student ID</label>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <input
                    id="dp-student"
                    type="text"
                    value={draftStudent}
                    onChange={e => setDraftStudent(e.target.value)}
                    placeholder="e.g. STU001"
                    className="form-input"
                    style={{ width: 160 }}
                  />
                  <button type="submit" className="btn btn-ghost" style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                    <IconSearch size={14} /> Search
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
                  Clear filters
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
            <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>No disputes found</p>
            <p style={{ fontSize: "0.8125rem" }}>
              {statusFilter || studentFilter ? "Try clearing your filters." : "No disputes have been raised yet."}
            </p>
          </div>
        ) : (
          <div>
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
                <span className="pagination-info">Page {page} of {totalPages}</span>
                <div className="pagination-controls">
                  <button
                    className="page-btn"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                  >
                    <IconChevronLeft size={15} /> Prev
                  </button>
                  <button
                    className="page-btn"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                  >
                    Next <IconChevronRight size={15} />
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
