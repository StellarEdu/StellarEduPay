import { useState } from "react";
import { getReport } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

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
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to generate report.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCsv() {
    const params = {};
    if (startDate) params.startDate = startDate;
    if (endDate)   params.endDate   = endDate;
    
    try {
      const token = localStorage.getItem('token');
      const query = new URLSearchParams({ ...params, format: 'csv' }).toString();
      const url = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/reports?${query}`;
      
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      
      if (!response.ok) {
        throw new Error('Failed to download CSV');
      }
      
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const filename = startDate && endDate
        ? `report-${startDate}_to_${endDate}.csv`
        : 'report-all-time.csv';
      
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError('Failed to download CSV: ' + (err.message || 'Unknown error'));
    }
  }

  const COLS = ["Date", "Amount", "Payments", "Valid", "Overpaid", "Underpaid", "Students"];

  return (
    <>
      <style>{`
        .rpt-wrap { max-width: 800px; margin: 2.5rem auto; padding: 0 1rem; }
        .rpt-input { padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; background: var(--bg); color: var(--text); outline: none; }
        .rpt-input:focus { border-color: var(--accent); }
        .rpt-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
        .rpt-stat { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
        .rpt-stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.35rem; }
        .rpt-stat-value { font-size: 1.4rem; font-weight: 700; }
        .rpt-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
        .rpt-table th { text-align: left; padding: 0.6rem 0.75rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-bottom: 1px solid var(--border); }
        .rpt-table td { padding: 0.75rem; border-bottom: 1px solid var(--border); }
        .rpt-table tbody tr:last-child td { border-bottom: none; }
        .rpt-table tbody tr:hover { background: rgba(126,200,227,0.05); }
        .rpt-table-wrap { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      `}</style>

      <div className="rpt-wrap">
        <h2 style={{ marginBottom: "0.25rem" }}>Reports</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem", marginBottom: "1.75rem" }}>
          Generate a payment summary for any date range.
        </p>

        <form onSubmit={handleGenerate} style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "0.35rem" }}>Start Date</label>
            <input type="date" className="rpt-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "0.35rem" }}>End Date</label>
            <input type="date" className="rpt-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? "Generating…" : "Generate"}
          </button>
        </form>

        {error && (
          <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: "0.875rem" }}>
            {error}
          </div>
        )}

        {report && (
          <>
            {/* Summary stats */}
            <div className="rpt-stat-grid">
              {[
                { label: "Total Collected", value: `${report.summary.totalAmount} XLM` },
                { label: "Payments",        value: report.summary.paymentCount },
                { label: "Valid",           value: report.summary.validCount,     color: "#166534" },
                { label: "Overpaid",        value: report.summary.overpaidCount,  color: "#854d0e" },
                { label: "Underpaid",       value: report.summary.underpaidCount, color: "#991b1b" },
                { label: "Paid Students",   value: report.summary.fullyPaidStudentCount },
              ].map(({ label, value, color }) => (
                <div key={label} className="rpt-stat">
                  <div className="rpt-stat-label">{label}</div>
                  <div className="rpt-stat-value" style={color ? { color } : {}}>{value}</div>
                </div>
              ))}
            </div>

            <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "1rem" }}>
              Period: {report.period.startDate || "all time"} → {report.period.endDate || "all time"} &nbsp;·&nbsp;
              Generated {new Date(report.generatedAt).toLocaleString()}
            </p>

            {/* Daily table */}
            {report.byDate.length > 0 ? (
              <div className="rpt-table-wrap">
                <table className="rpt-table">
                  <thead>
                    <tr>{COLS.map(h => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {report.byDate.map(row => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{row.totalAmount}</td>
                        <td>{row.paymentCount}</td>
                        <td style={{ color: "#166534" }}>{row.validCount}</td>
                        <td style={{ color: "#854d0e" }}>{row.overpaidCount}</td>
                        <td style={{ color: "#991b1b" }}>{row.underpaidCount}</td>
                        <td>{row.uniqueStudentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--muted)" }}>No payments found for this period.</p>
            )}

            <button onClick={handleCsv} className="btn-primary" style={{ marginTop: "1.25rem" }}>
              Download CSV
            </button>
          </>
        )}
      </div>
    </>
  );
}
