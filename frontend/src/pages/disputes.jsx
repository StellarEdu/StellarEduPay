import { useState, useEffect, useCallback } from "react";
import { getDisputes, resolveDispute } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

const STATUS_COLORS = {
  open:         { color: "#166534", bg: "#dcfce7" },
  under_review: { color: "#854d0e", bg: "#fef9c3" },
  resolved:     { color: "#1e40af", bg: "#dbeafe" },
  rejected:     { color: "#991b1b", bg: "#fee2e2" },
};

const STELLAR_EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";

function StatusBadge({ status }) {
  const style = STATUS_COLORS[status] || { color: "#475569", bg: "#f1f5f9" };
  return (
    <span style={{ ...style, padding: "0.15rem 0.6rem", borderRadius: 20, fontSize: "0.75rem", fontWeight: 600, whiteSpace: "nowrap" }}>
      {status.replace("_", " ")}
    </span>
  );
}

function ResolveForm({ dispute, onResolved }) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("resolved");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

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
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        {["resolved", "rejected", "under_review"].map((s) => (
          <label key={s} style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem", cursor: "pointer" }}>
            <input type="radio" name="status" value={s} checked={status === s} onChange={() => setStatus(s)} />
            {s.replace("_", " ")}
          </label>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder="Resolution note…"
        style={{ width: "100%", padding: "0.5rem 0.75rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: "0.875rem", resize: "vertical", boxSizing: "border-box" }}
      />
      {error && <p role="alert" style={{ color: "#dc2626", fontSize: "0.8rem", margin: "0.25rem 0" }}>{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        style={{ marginTop: "0.5rem", padding: "0.4rem 1rem", border: "none", borderRadius: 6, background: "#1a1a2e", color: "#fff", cursor: submitting ? "not-allowed" : "pointer", fontSize: "0.85rem", opacity: submitting ? 0.7 : 1 }}
      >
        {submitting ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export default function DisputesPage() {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [studentFilter, setStudentFilter] = useState("");
  const [expanded, setExpanded] = useState(null);

  // Guard: redirect unauthenticated users (no JWT in localStorage)
  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("token")) {
      window.location.href = "/";
    }
  }, []);

  const fetchDisputes = useCallback(
    async (p = page) => {
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
    },
    [page, statusFilter, studentFilter]
  );

  useEffect(() => { fetchDisputes(page); }, [page, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleResolved(updated) {
    setDisputes((prev) => prev.map((d) => (d._id === updated._id ? updated : d)));
    setExpanded(null);
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    fetchDisputes(1);
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>Disputes</h1>
      <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Review and resolve payment disputes raised by parents.
      </p>

      {/* Filter bar */}
      <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.5rem", alignItems: "flex-end" }}>
        <div>
          <label htmlFor="dp-status" style={{ display: "block", fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Status</label>
          <select
            id="dp-status"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            style={{ padding: "0.45rem 0.75rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: "0.875rem" }}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="under_review">Under Review</option>
            <option value="resolved">Resolved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <div>
          <label htmlFor="dp-student" style={{ display: "block", fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Student ID</label>
          <input
            id="dp-student"
            type="text"
            value={studentFilter}
            onChange={(e) => setStudentFilter(e.target.value)}
            placeholder="e.g. STU001"
            style={{ padding: "0.45rem 0.75rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: "0.875rem" }}
          />
        </div>
        <button type="submit" style={{ padding: "0.45rem 1rem", border: "none", borderRadius: 6, background: "#1a1a2e", color: "#fff", cursor: "pointer", fontSize: "0.875rem" }}>
          Search
        </button>
      </form>

      {error && (
        <div role="alert" style={{ background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "0.75rem", color: "#991b1b", fontSize: "0.875rem", marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      ) : disputes.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No disputes found.</p>
      ) : (
        <div>
          {disputes.map((d) => (
            <div
              key={d._id}
              style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "1rem", marginBottom: "0.75rem", background: "var(--bg)" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{d.studentId}</span>
                  <span style={{ color: "var(--muted)", fontSize: "0.8rem", marginLeft: "0.75rem" }}>
                    by {d.raisedBy}
                  </span>
                </div>
                <StatusBadge status={d.status} />
              </div>

              <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--muted)", fontFamily: "monospace" }}>
                <a
                  href={`${STELLAR_EXPLORER_BASE}${d.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent, #3b82f6)" }}
                  aria-label={`View transaction ${d.txHash} on Stellar Explorer`}
                >
                  {d.txHash?.slice(0, 20)}…
                </a>
              </div>

              <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "var(--text)" }}>
                {d.reason?.length > 120 ? d.reason.slice(0, 120) + "…" : d.reason}
              </p>

              <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "var(--muted)" }}>
                {new Date(d.createdAt).toLocaleString()}
              </div>

              {/* Expand / collapse detail + resolve form */}
              <button
                onClick={() => setExpanded(expanded === d._id ? null : d._id)}
                aria-expanded={expanded === d._id}
                style={{ marginTop: "0.75rem", padding: "0.3rem 0.75rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: "0.8rem" }}
              >
                {expanded === d._id ? "Hide details" : "View details"}
              </button>

              {expanded === d._id && (
                <div style={{ marginTop: "1rem" }}>
                  <p style={{ fontSize: "0.875rem" }}><strong>Full reason:</strong> {d.reason}</p>
                  {d.resolutionNote && (
                    <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}><strong>Resolution note:</strong> {d.resolutionNote}</p>
                  )}
                  {(d.status === "open" || d.status === "under_review") && (
                    <ResolveForm dispute={d} onResolved={handleResolved} />
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "1.5rem" }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{ padding: "0.4rem 0.9rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: page === 1 ? "not-allowed" : "pointer", opacity: page === 1 ? 0.5 : 1 }}
              >
                ← Prev
              </button>
              <span style={{ padding: "0.4rem 0.75rem", fontSize: "0.875rem", color: "var(--muted)" }}>
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                style={{ padding: "0.4rem 0.9rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: page === totalPages ? "not-allowed" : "pointer", opacity: page === totalPages ? 0.5 : 1 }}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
