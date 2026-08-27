import { useState, useEffect } from "react";
import { getAuditLogs } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconChevronLeft, IconChevronRight, IconAlertTriangle, IconCheck,
} from "../components/Icons";
import PageHero from "../components/PageHero";
import RequireAdmin from "../components/RequireAdmin";

function formatTimestamp(isoString) {
  if (!isoString) return "N/A";
  return new Date(isoString).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const ACTION_LABELS = {
  student_create:       "Student Created",
  student_update:       "Student Updated",
  student_delete:       "Student Deleted",
  student_bulk_import:  "Bulk Import",
  payment_manual_sync:  "Manual Sync",
  payment_finalize:     "Payment Finalized",
  fee_create:           "Fee Created",
  fee_update:           "Fee Updated",
  fee_delete:           "Fee Deleted",
  school_create:        "School Created",
  school_update:        "School Updated",
  school_deactivate:    "School Deactivated",
};

function getActionLabel(action) {
  return ACTION_LABELS[action] || action;
}

const ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }));

function AuditLogsContent() {
  const [logs, setLogs]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [page, setPage]               = useState(1);
  const [total, setTotal]             = useState(0);
  const [pages, setPages]             = useState(1);
  const [expandedId, setExpandedId]   = useState(null);

  const [actionFilter, setActionFilter]         = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [resultFilter, setResultFilter]         = useState("");
  const [startDate, setStartDate]               = useState("");
  const [endDate, setEndDate]                   = useState("");
  const [actorIdInput, setActorIdInput]         = useState("");
  const [actorIdFilter, setActorIdFilter]       = useState("");
  const [searchInput, setSearchInput]           = useState("");
  const [searchFilter, setSearchFilter]         = useState("");

  // Debounce the free-text inputs so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setActorIdFilter(actorIdInput.trim()), 350);
    return () => clearTimeout(t);
  }, [actorIdInput]);
  useEffect(() => {
    const t = setTimeout(() => setSearchFilter(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchLogs = (p = page) => {
    setLoading(true);
    setError(null);
    const params = { page: p, limit: 50 };
    if (actionFilter)     params.action     = actionFilter;
    if (targetTypeFilter) params.targetType = targetTypeFilter;
    if (resultFilter)     params.result     = resultFilter;
    if (actorIdFilter)    params.performedBy = actorIdFilter;
    if (searchFilter)     params.search     = searchFilter;
    if (startDate)        params.startDate  = new Date(startDate).toISOString();
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      params.endDate = end.toISOString();
    }
    getAuditLogs(params)
      .then(({ data }) => {
        setLogs(data.logs);
        setTotal(data.total);
        setPages(data.pages);
        setPage(data.page);
      })
      .catch((err) => {
        setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to load audit logs.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchLogs(1); }, [actionFilter, targetTypeFilter, resultFilter, actorIdFilter, searchFilter, startDate, endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <style>{`
        .al-filters {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 0.75rem;
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid var(--border);
          background: var(--bg-subtle, var(--bg));
        }
        .al-filter-label {
          display: block;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          margin-bottom: 0.3rem;
        }
        .al-filter-input {
          width: 100%;
          padding: 0.425rem 0.65rem;
          border: 1.5px solid var(--border);
          border-radius: var(--radius-sm);
          font-size: 0.825rem;
          font-family: inherit;
          color: var(--text);
          background: var(--card-bg);
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .al-filter-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-subtle);
        }
        .al-empty {
          padding: 3.5rem;
          text-align: center;
          color: var(--text-muted);
        }
        .al-detail-pre {
          margin-top: 0.75rem;
          padding: 0.625rem 0.75rem;
          background: var(--bg-subtle, var(--bg));
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          font-size: 0.72rem;
          font-family: monospace;
          overflow: auto;
          max-height: 220px;
          white-space: pre-wrap;
          word-break: break-all;
          color: var(--text);
        }
        .al-target-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.15rem 0.5rem;
          border-radius: 4px;
          background: var(--accent-subtle);
          color: var(--accent);
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-right: 0.375rem;
          flex-shrink: 0;
        }
        .al-expand-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.2rem 0.55rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: transparent;
          color: var(--text-muted);
          font-size: 0.72rem;
          font-family: inherit;
          cursor: pointer;
          transition: background 0.12s;
        }
        .al-expand-btn:hover { background: var(--bg-subtle, var(--bg)); }
        .al-result-badge-success { background: var(--success-bg); color: var(--success-text); }
        .al-result-badge-failure { background: var(--danger-bg);  color: var(--danger-text);  }
      `}</style>

      <div className="page-wrap-wide">
        <PageHero
          eyebrow="Compliance"
          title="Audit Logs"
          subtitle="A complete, immutable trail of every administrative action across the platform."
        />
        {!loading && (
          <p style={{ textAlign: "center", fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "-1.25rem", marginBottom: "1.5rem" }}>
            {total.toLocaleString()} total entries
          </p>
        )}

        <div className="card">
          {/* Filters */}
          <div className="al-filters">
            <div>
              <label className="al-filter-label">Action</label>
              <select
                value={actionFilter}
                onChange={e => setActionFilter(e.target.value)}
                className="al-filter-input"
              >
                <option value="">All Actions</option>
                {ACTION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="al-filter-label">Target Type</label>
              <select
                value={targetTypeFilter}
                onChange={e => setTargetTypeFilter(e.target.value)}
                className="al-filter-input"
              >
                <option value="">All Types</option>
                {["student","payment","fee","school"].map(t => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="al-filter-label">Result</label>
              <select
                value={resultFilter}
                onChange={e => setResultFilter(e.target.value)}
                className="al-filter-input"
                aria-label="Filter by result"
              >
                <option value="">All Results</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </select>
            </div>

            <div>
              <label className="al-filter-label">Actor ID</label>
              <input
                type="text"
                value={actorIdInput}
                onChange={e => setActorIdInput(e.target.value)}
                placeholder="Performed by..."
                className="al-filter-input"
              />
            </div>

            <div>
              <label className="al-filter-label">Search</label>
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Search details..."
                className="al-filter-input"
              />
            </div>

            <div>
              <label className="al-filter-label">From</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="al-filter-input"
              />
            </div>

            <div>
              <label className="al-filter-label">To</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="al-filter-input"
              />
            </div>
          </div>

          {/* Alerts */}
          {error && (
            <div className="card-body">
              <div role="alert" className="alert alert-danger">
                <IconAlertTriangle size={16} />
                <span>{error}</span>
              </div>
            </div>
          )}

          {/* Table */}
          {loading ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Timestamp</th><th>Action</th><th>Performed By</th>
                    <th>Target</th><th>Result</th><th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      {[100,140,80,120,60,40].map((w, j) => (
                        <td key={j}><div className="skeleton" style={{ height: 12, width: w }} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : logs.length === 0 ? (
            <div className="al-empty">
              <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>No audit logs found</p>
              <p style={{ fontSize: "0.8125rem" }}>Try adjusting your filters.</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Action</th>
                    <th scope="col">Performed By</th>
                    <th scope="col">Target</th>
                    <th scope="col">Result</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const isExpanded = expandedId === log._id;
                    return (
                      <tr key={log._id}>
                        <td style={{ whiteSpace: "nowrap", fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                          {formatTimestamp(log.createdAt)}
                        </td>
                        <td style={{ fontWeight: 500, fontSize: "0.875rem" }}>{getActionLabel(log.action)}</td>
                        <td style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>{log.performedBy}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.25rem" }}>
                            <span className="al-target-badge">{log.targetType}</span>
                            <span className="font-mono" style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{log.targetId}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${log.result === "success" ? "badge-success" : "badge-danger"}`}>
                            {log.result === "success" ? <IconCheck size={10} /> : <IconAlertTriangle size={10} />}
                            {log.result}
                          </span>
                        </td>
                        <td>
                          {log.errorMessage ? (
                            <span style={{ color: "var(--danger-text)", fontSize: "0.8125rem" }}>
                              {log.errorMessage}
                            </span>
                          ) : (
                            <div>
                              <button
                                className="al-expand-btn"
                                onClick={() => setExpandedId(isExpanded ? null : log._id)}
                                aria-expanded={isExpanded}
                              >
                                {isExpanded ? "Hide" : "View"}
                              </button>
                              {isExpanded && (
                                <pre className="al-detail-pre">
                                  {JSON.stringify(log.details, null, 2)}
                                </pre>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {!loading && pages > 1 && (
            <div style={{ padding: "0.875rem 1.5rem", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="pagination-info" aria-live="polite">
                Page {page} of {pages} — {total.toLocaleString()} entries
              </span>
              <nav className="pagination-controls" aria-label="Audit log pagination">
                <button
                  className="page-btn"
                  onClick={() => fetchLogs(page - 1)}
                  disabled={page === 1}
                  aria-label="Previous page"
                  style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                >
                  <IconChevronLeft size={15} /> Prev
                </button>
                <button
                  className="page-btn"
                  onClick={() => fetchLogs(page + 1)}
                  disabled={page === pages}
                  aria-label="Next page"
                  style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                >
                  Next <IconChevronRight size={15} />
                </button>
              </nav>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
