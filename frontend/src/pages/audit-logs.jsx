import { useState, useEffect } from "react";
import { getAuditLogs } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

function formatTimestamp(isoString) {
  if (!isoString) return "N/A";
  const date = new Date(isoString);
  return date.toLocaleString();
}

function getActionLabel(action) {
  const labels = {
    student_create: "Student Created",
    student_update: "Student Updated",
    student_delete: "Student Deleted",
    student_bulk_import: "Bulk Import",
    payment_manual_sync: "Manual Sync",
    payment_finalize: "Payment Finalized",
    fee_create: "Fee Created",
    fee_update: "Fee Updated",
    fee_delete: "Fee Deleted",
    school_create: "School Created",
    school_update: "School Updated",
    school_deactivate: "School Deactivated",
  };
  return labels[action] || action;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);

  // Filters
  const [actionFilter, setActionFilter] = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const fetchLogs = (p = page) => {
    setLoading(true);
    setError(null);

    const params = { page: p, limit: 50 };
    if (actionFilter) params.action = actionFilter;
    if (targetTypeFilter) params.targetType = targetTypeFilter;
    if (resultFilter) params.result = resultFilter;
    // Convert local date strings (YYYY-MM-DD) to ISO 8601 UTC so the backend
    // receives the correct boundary regardless of the user's timezone.
    // startDate → start of that local day (T00:00:00 local → UTC)
    // endDate   → end of that local day (T23:59:59.999 local → UTC)
    if (startDate) params.startDate = new Date(startDate).toISOString();
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
        setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to load audit logs. Please try again.");
        console.error(err);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs(1);
  }, [actionFilter, targetTypeFilter, resultFilter, startDate, endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Audit Logs</h1>

      {/* Filters */}
      <div style={filtersStyle}>
        <div style={filterGroupStyle}>
          <label style={labelStyle}>Action Type</label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Actions</option>
            <option value="student_create">Student Created</option>
            <option value="student_update">Student Updated</option>
            <option value="student_delete">Student Deleted</option>
            <option value="student_bulk_import">Bulk Import</option>
            <option value="payment_manual_sync">Manual Sync</option>
            <option value="payment_finalize">Payment Finalized</option>
            <option value="fee_create">Fee Created</option>
            <option value="fee_update">Fee Updated</option>
            <option value="fee_delete">Fee Deleted</option>
            <option value="school_create">School Created</option>
            <option value="school_update">School Updated</option>
            <option value="school_deactivate">School Deactivated</option>
          </select>
        </div>

        <div style={filterGroupStyle}>
          <label style={labelStyle}>Target Type</label>
          <select
            value={targetTypeFilter}
            onChange={(e) => setTargetTypeFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Types</option>
            <option value="student">Student</option>
            <option value="payment">Payment</option>
            <option value="fee">Fee</option>
            <option value="school">School</option>
          </select>
        </div>

        <div style={filterGroupStyle}>
          <label style={labelStyle}>Result</label>
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value)}
            style={selectStyle}
            aria-label="Filter by result"
          >
            <option value="">All Results</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </div>

        <div style={filterGroupStyle}>
          <label style={labelStyle}>Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={filterGroupStyle}>
          <label style={labelStyle}>End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <p style={{ color: "var(--muted)" }}>Loading audit logs...</p>
      ) : error ? (
        <p style={{ color: "var(--error-color)" }}>{error}</p>
      ) : logs.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No audit logs found</p>
      ) : (
        <>
          <div style={tableContainerStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Timestamp</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Performed By</th>
                  <th style={thStyle}>Target</th>
                  <th style={thStyle}>Result</th>
                  <th style={thStyle}>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log._id} style={trStyle}>
                    <td style={tdStyle}>{formatTimestamp(log.createdAt)}</td>
                    <td style={tdStyle}>{getActionLabel(log.action)}</td>
                    <td style={tdStyle}>{log.performedBy}</td>
                    <td style={tdStyle}>
                      <span style={targetBadgeStyle}>{log.targetType}</span>
                      {" "}
                      {log.targetId}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          ...resultBadgeStyle,
                          background: log.result === "success" ? "var(--success-bg)" : "var(--error-bg)",
                          color: log.result === "success" ? "var(--success-color)" : "var(--error-color)",
                        }}
                      >
                        {log.result}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {log.errorMessage ? (
                        <span style={{ color: "var(--error-color)", fontSize: "0.85rem" }}>
                          {log.errorMessage}
                        </span>
                      ) : (
                        <details style={{ fontSize: "0.85rem" }}>
                          <summary style={{ cursor: "pointer", color: "var(--accent)" }}>
                            View
                          </summary>
                          <pre style={preStyle}>
                            {JSON.stringify(log.details, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={paginationStyle} role="navigation" aria-label="Audit log pagination">
            <button
              onClick={() => fetchLogs(page - 1)}
              disabled={page === 1}
              aria-label="Previous page"
              style={{
                ...pageBtnStyle,
                opacity: page === 1 ? 0.5 : 1,
                cursor: page === 1 ? "not-allowed" : "pointer",
              }}
            >
              Previous
            </button>
            <span style={{ fontSize: "0.9rem", color: "var(--muted)" }} aria-live="polite">
              Page {page} of {pages} &mdash; {total.toLocaleString()} total entries
            </span>
            <button
              onClick={() => fetchLogs(page + 1)}
              disabled={page === pages}
              aria-label="Next page"
              style={{
                ...pageBtnStyle,
                opacity: page === pages ? 0.5 : 1,
                cursor: page === pages ? "not-allowed" : "pointer",
              }}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const containerStyle = {
  maxWidth: "1400px",
  margin: "0 auto",
  padding: "2rem",
};

const titleStyle = {
  fontSize: "2rem",
  fontWeight: 700,
  marginBottom: "1.5rem",
  color: "var(--text)",
};

const filtersStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: "1rem",
  marginBottom: "1.5rem",
  padding: "1.5rem",
  background: "var(--card-bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
};

const filterGroupStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const labelStyle = {
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const selectStyle = {
  padding: "0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9rem",
  background: "var(--bg)",
  color: "var(--text)",
};

const inputStyle = {
  padding: "0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9rem",
  background: "var(--bg)",
  color: "var(--text)",
};

const tableContainerStyle = {
  overflowX: "auto",
  background: "var(--card-bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "1rem",
};

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};

const thStyle = {
  textAlign: "left",
  padding: "0.75rem",
  borderBottom: "2px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 600,
  fontSize: "0.85rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle = {
  padding: "0.75rem",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
};

const trStyle = {
  transition: "background 0.2s",
};

const targetBadgeStyle = {
  display: "inline-block",
  padding: "0.2rem 0.5rem",
  background: "rgba(126,200,227,0.15)",
  color: "var(--accent)",
  borderRadius: 4,
  fontSize: "0.75rem",
  fontWeight: 600,
  textTransform: "uppercase",
};

const resultBadgeStyle = {
  display: "inline-block",
  padding: "0.2rem 0.6rem",
  borderRadius: 4,
  fontSize: "0.75rem",
  fontWeight: 600,
  textTransform: "capitalize",
};

const preStyle = {
  marginTop: "0.5rem",
  padding: "0.5rem",
  background: "var(--border)",
  borderRadius: 4,
  fontSize: "0.75rem",
  overflow: "auto",
  maxHeight: "200px",
};

const paginationStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: "1.5rem",
  padding: "1rem",
  background: "var(--card-bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
};

const pageBtnStyle = {
  padding: "0.6rem 1.2rem",
  fontSize: "0.9rem",
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  transition: "background 0.2s",
};
