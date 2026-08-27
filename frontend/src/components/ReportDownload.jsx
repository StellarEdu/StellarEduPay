import { useState, useEffect } from "react";
import { getReport, getReportCsvUrl } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconCalendar, IconDownload, IconBarChart, IconAlertTriangle,
  IconCheck, IconTrendingUp, IconClock, IconX,
} from "./Icons";
import PageHero, { StatCard } from "./PageHero";

export default function ReportDownload() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate]     = useState("");
  const [className, setClassName] = useState("");
  const [studentId, setStudentId] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [report, setReport]       = useState(null);
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [reportHistory, setReportHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    loadReportHistory();
  }, []);

  async function loadReportHistory() {
    try {
      const storedHistory = localStorage.getItem("reportHistory");
      if (storedHistory) {
        setReportHistory(JSON.parse(storedHistory));
      }
    } catch (err) {
      console.error("Failed to load report history:", err);
    }
  }

  function saveReportToHistory(reportData, params) {
    const newEntry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      params,
      summary: {
        totalAmount: reportData.summary.totalAmount,
        paymentCount: reportData.summary.paymentCount,
      },
    };
    const updated = [newEntry, ...reportHistory.slice(0, 9)];
    setReportHistory(updated);
    localStorage.setItem("reportHistory", JSON.stringify(updated));
  }

  async function handleGenerate(e) {
    e.preventDefault();
    setError(""); setReport(null); setLoading(true);
    try {
      const params = {};
      if (startDate) params.startDate = startDate;
      if (endDate)   params.endDate   = endDate;
      if (className) params.className = className;
      if (studentId) params.studentId = studentId;
      if (paymentStatus) params.paymentStatus = paymentStatus;
      const { data } = await getReport(params);
      setReport(data);
      saveReportToHistory(data, params);
    } catch (err) {
      setError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
        "Failed to generate report."
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCsv() {
    const params = {};
    if (startDate) params.startDate = startDate;
    if (endDate)   params.endDate   = endDate;
    if (className) params.className = className;
    if (studentId) params.studentId = studentId;
    if (paymentStatus) params.paymentStatus = paymentStatus;

    try {
      setCsvLoading(true);
      const url = getReportCsvUrl(params);
      const response = await fetch(url, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to download CSV");
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const filename =
        startDate && endDate
          ? `report-${startDate}_to_${endDate}.csv`
          : "report-all-time.csv";
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError("Failed to download CSV: " + (err.message || "Unknown error"));
    } finally {
      setCsvLoading(false);
    }
  }

  const TABLE_COLS = [
    { key: "date",               label: "Date" },
    { key: "totalAmount",        label: "Amount (XLM)" },
    { key: "paymentCount",       label: "Payments" },
    { key: "validCount",         label: "Valid",      color: "var(--success-text)" },
    { key: "overpaidCount",      label: "Overpaid",   color: "var(--warning-text)" },
    { key: "underpaidCount",     label: "Underpaid",  color: "var(--danger-text)" },
    { key: "uniqueStudentCount", label: "Students" },
  ];

  return (
    <div className="page-wrap">
      <PageHero
        eyebrow="Analytics"
        title="Payment Reports"
        subtitle="Generate an on-chain payment summary and daily breakdown for any date range."
      />

      {/* Filter form */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="card-header">
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <IconCalendar size={16} /> Filters & Options
          </div>
        </div>
        <div className="card-body">
          <form onSubmit={handleGenerate} style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Start Date</label>
              <input
                type="date"
                className="form-input"
                style={{ width: "auto" }}
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">End Date</label>
              <input
                type="date"
                className="form-input"
                style={{ width: "auto" }}
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Class (Optional)</label>
              <input
                type="text"
                className="form-input"
                style={{ width: "auto" }}
                placeholder="e.g. Class A"
                value={className}
                onChange={e => setClassName(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Student ID (Optional)</label>
              <input
                type="text"
                className="form-input"
                style={{ width: "auto" }}
                placeholder="e.g. STU-001"
                value={studentId}
                onChange={e => setStudentId(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Payment Status (Optional)</label>
              <select
                className="form-input"
                style={{ width: "auto" }}
                value={paymentStatus}
                onChange={e => setPaymentStatus(e.target.value)}
              >
                <option value="">All</option>
                <option value="valid">Valid</option>
                <option value="overpaid">Overpaid</option>
                <option value="underpaid">Underpaid</option>
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
              </select>
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary" style={{ alignSelf: "flex-end" }}>
              {loading ? "Generating…" : "Generate Report"}
            </button>
            {(startDate || endDate || className || studentId || paymentStatus) && !loading && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ alignSelf: "flex-end" }}
                onClick={() => { setStartDate(""); setEndDate(""); setClassName(""); setStudentId(""); setPaymentStatus(""); setReport(null); }}
              >
                Clear All
              </button>
            )}
          </form>
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: "1rem" }}>
          <IconAlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          {/* Period info */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}>
            <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
              Period: <strong>{report.period.startDate || "all time"}</strong>
              {" → "}
              <strong>{report.period.endDate || "all time"}</strong>
              &nbsp;·&nbsp;Generated {new Date(report.generatedAt).toLocaleString()}
            </p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <button
                onClick={handleCsv}
                disabled={csvLoading}
                className="btn btn-ghost btn-sm"
                style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}
              >
                {csvLoading ? (
                  <>
                    <div style={{
                      width: "14px",
                      height: "14px",
                      border: "2px solid var(--text-muted)",
                      borderTop: "2px solid var(--text-default)",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }} />
                    <span>Downloading…</span>
                  </>
                ) : (
                  <>
                    <IconDownload size={14} /> Download CSV
                  </>
                )}
              </button>
              {reportHistory.length > 0 && (
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="btn btn-ghost btn-sm"
                  style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}
                >
                  <IconClock size={14} /> History ({reportHistory.length})
                </button>
              )}
            </div>
          </div>

          {showHistory && reportHistory.length > 0 && (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <div className="card-header">
                <div className="card-title">Previously Generated Reports</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ fontSize: "0.875rem" }}>
                  <thead>
                    <tr>
                      <th>Generated</th>
                      <th>Total Amount</th>
                      <th>Payments</th>
                      <th>Filters</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportHistory.map(entry => (
                      <tr key={entry.id}>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td>{entry.summary.totalAmount} XLM</td>
                        <td>{entry.summary.paymentCount}</td>
                        <td style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {Object.keys(entry.params).length > 0
                            ? Object.entries(entry.params)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(", ")
                            : "None"}
                        </td>
                        <td>
                          <button
                            onClick={() => {
                              setStartDate(entry.params.startDate || "");
                              setEndDate(entry.params.endDate || "");
                              setClassName(entry.params.className || "");
                              setStudentId(entry.params.studentId || "");
                              setPaymentStatus(entry.params.paymentStatus || "");
                            }}
                            className="btn btn-ghost btn-sm"
                            style={{ padding: "0.25rem 0.5rem" }}
                          >
                            Rerun
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>

          {/* Summary stats */}
          <div className="stat-grid" style={{ marginBottom: "1.5rem" }}>
            <StatCard label="Total Collected" value={report.summary.totalAmount} sub="XLM" Icon={IconTrendingUp} color="violet" />
            <StatCard label="Total Payments"  value={report.summary.paymentCount}                            Icon={IconBarChart}  color="cyan" />
            <StatCard label="Valid"           value={report.summary.validCount}                              Icon={IconCheck}     color="green" />
            <StatCard label="Overpaid"        value={report.summary.overpaidCount}                           Icon={IconAlertTriangle} color="amber" />
            <StatCard label="Underpaid"       value={report.summary.underpaidCount}                          Icon={IconAlertTriangle} color="rose" />
            <StatCard label="Paid Students"   value={report.summary.fullyPaidStudentCount}                   Icon={IconCheck}     color="indigo" />
          </div>

          {/* By-class breakdown (if available) */}
          {report.byClass && report.byClass.length > 0 && (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <div className="card-header">
                <div className="card-title">By Class</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ fontSize: "0.875rem" }}>
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Total (XLM)</th>
                      <th>Payments</th>
                      <th>Valid</th>
                      <th>Overpaid</th>
                      <th>Underpaid</th>
                      <th>Students</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byClass.map(row => (
                      <tr key={row.className}>
                        <td style={{ fontWeight: 500 }}>{row.className}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{row.totalAmount}</td>
                        <td>{row.paymentCount}</td>
                        <td style={{ color: "var(--success-text)", fontWeight: 600 }}>{row.validCount}</td>
                        <td style={{ color: "var(--warning-text)", fontWeight: 600 }}>{row.overpaidCount}</td>
                        <td style={{ color: "var(--danger-text)", fontWeight: 600 }}>{row.underpaidCount}</td>
                        <td>{row.uniqueStudentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Daily breakdown table */}
          {report.byDate.length > 0 ? (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Daily Breakdown</div>
                <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                  {report.byDate.length} days
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      {TABLE_COLS.map(col => (
                        <th key={col.key} scope="col">{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.byDate.map(row => (
                      <tr key={row.date}>
                        <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>{row.date}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{row.totalAmount}</td>
                        <td>{row.paymentCount}</td>
                        <td style={{ color: "var(--success-text)", fontWeight: 600 }}>{row.validCount}</td>
                        <td style={{ color: "var(--warning-text)", fontWeight: 600 }}>{row.overpaidCount}</td>
                        <td style={{ color: "var(--danger-text)", fontWeight: 600 }}>{row.underpaidCount}</td>
                        <td>{row.uniqueStudentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "3rem", color: "var(--text-muted)" }}>
              <p style={{ fontWeight: 500 }}>No payments in this period</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
