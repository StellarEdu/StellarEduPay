import { useState } from "react";
import { getReport } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconCalendar, IconDownload, IconBarChart, IconAlertTriangle,
  IconCheck, IconTrendingUp,
} from "./Icons";
import PageHero, { StatCard } from "./PageHero";

export default function ReportDownload() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate]     = useState("");
  const [report, setReport]       = useState(null);
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);

  async function handleGenerate(e) {
    e.preventDefault();
    setError(""); setReport(null); setLoading(true);
    try {
      const params = {};
      if (startDate) params.startDate = startDate;
      if (endDate)   params.endDate   = endDate;
      const { data } = await getReport(params);
      setReport(data);
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

    try {
      const query = new URLSearchParams({ ...params, format: "csv" }).toString();
      const url = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/reports?${query}`;
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
            <IconCalendar size={16} /> Date Range
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
            <button type="submit" disabled={loading} className="btn btn-primary" style={{ alignSelf: "flex-end" }}>
              {loading ? "Generating…" : "Generate Report"}
            </button>
            {(startDate || endDate) && !loading && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ alignSelf: "flex-end" }}
                onClick={() => { setStartDate(""); setEndDate(""); setReport(null); }}
              >
                Clear
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
            <button
              onClick={handleCsv}
              className="btn btn-ghost btn-sm"
              style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}
            >
              <IconDownload size={14} /> Download CSV
            </button>
          </div>

          {/* Summary stats */}
          <div className="stat-grid" style={{ marginBottom: "1.5rem" }}>
            <StatCard label="Total Collected" value={report.summary.totalAmount} sub="XLM" Icon={IconTrendingUp} color="violet" />
            <StatCard label="Payments"        value={report.summary.paymentCount}                            Icon={IconBarChart}  color="cyan" />
            <StatCard label="Valid"           value={report.summary.validCount}                              Icon={IconCheck}     color="green" />
            <StatCard label="Overpaid"        value={report.summary.overpaidCount}                           Icon={IconAlertTriangle} color="amber" />
            <StatCard label="Underpaid"       value={report.summary.underpaidCount}                          Icon={IconAlertTriangle} color="rose" />
            <StatCard label="Paid Students"   value={report.summary.fullyPaidStudentCount}                   Icon={IconCheck}     color="indigo" />
          </div>

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
