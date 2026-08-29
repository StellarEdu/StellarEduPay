import { useState, useEffect } from "react";
import { getReport, getReportCsvUrl } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconCalendar, IconDownload, IconBarChart, IconAlertTriangle,
  IconCheck, IconTrendingUp, IconClock, IconX,
} from "./Icons";
import PageHero, { StatCard } from "./PageHero";
import { useTranslation } from "react-i18next";

export default function ReportDownload() {
  const { t } = useTranslation();
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
        t("reports.failedGenerate")
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
      if (!response.ok) throw new Error(t("reports.downloadError"));
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
      setError(t("reports.failedCsvPrefix") + (err.message || t("reports.failedCsvUnknown")));
    } finally {
      setCsvLoading(false);
    }
  }

  const TABLE_COLS = [
    { key: "date",               label: "reports.colDate" },
    { key: "totalAmount",        label: "reports.colAmountXlm" },
    { key: "paymentCount",       label: "reports.colPayments" },
    { key: "validCount",         label: "status.validation.valid", color: "var(--success-text)" },
    { key: "overpaidCount",      label: "status.validation.overpaid", color: "var(--warning-text)" },
    { key: "underpaidCount",     label: "status.validation.underpaid", color: "var(--danger-text)" },
    { key: "uniqueStudentCount", label: "reports.colStudents" },
  ];

  return (
    <div className="page-wrap">
      <PageHero
        eyebrow={t("reports.eyebrow")}
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
      />

      {/* Filter form */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="card-header">
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <IconCalendar size={16} /> {t("reports.filtersTitle")}
          </div>
        </div>
        <div className="card-body">
          <form onSubmit={handleGenerate} style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.startDate")}</label>
              <input
                type="date"
                className="form-input"
                style={{ width: "auto" }}
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.endDate")}</label>
              <input
                type="date"
                className="form-input"
                style={{ width: "auto" }}
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.classOptional")}</label>
              <input
                type="text"
                className="form-input"
                style={{ width: "auto" }}
                placeholder={t("reports.classPlaceholder")}
                value={className}
                onChange={e => setClassName(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.studentIdOptional")}</label>
              <input
                type="text"
                className="form-input"
                style={{ width: "auto" }}
                placeholder={t("reports.studentIdPlaceholder")}
                value={studentId}
                onChange={e => setStudentId(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.paymentStatusOptional")}</label>
              <select
                className="form-input"
                style={{ width: "auto" }}
                value={paymentStatus}
                onChange={e => setPaymentStatus(e.target.value)}
              >
                <option value="">{t("reports.all")}</option>
                <option value="valid">{t("status.validation.valid")}</option>
                <option value="overpaid">{t("status.validation.overpaid")}</option>
                <option value="underpaid">{t("status.validation.underpaid")}</option>
                <option value="confirmed">{t("status.payment.CONFIRMED")}</option>
                <option value="pending">{t("status.payment.PENDING")}</option>
              </select>
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary" style={{ alignSelf: "flex-end" }}>
              {loading ? t("reports.generating") : t("reports.generateReport")}
            </button>
            {(startDate || endDate || className || studentId || paymentStatus) && !loading && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ alignSelf: "flex-end" }}
                onClick={() => { setStartDate(""); setEndDate(""); setClassName(""); setStudentId(""); setPaymentStatus(""); setReport(null); }}
              >
                {t("reports.clearAll")}
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
              {t("reports.period")} <strong>{report.period.startDate || t("reports.allTime")}</strong>
              {" → "}
              <strong>{report.period.endDate || t("reports.allTime")}</strong>
              &nbsp;·&nbsp;{t("reports.generatedAt", { date: new Date(report.generatedAt).toLocaleString() })}
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
                    <span>{t("reports.downloading")}</span>
                  </>
                ) : (
                  <>
                    <IconDownload size={14} /> {t("reports.downloadCsv")}
                  </>
                )}
              </button>
              {reportHistory.length > 0 && (
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="btn btn-ghost btn-sm"
                  style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}
                >
                  <IconClock size={14} /> {t("reports.history", { count: reportHistory.length })}
                </button>
              )}
            </div>
          </div>

          {showHistory && reportHistory.length > 0 && (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <div className="card-header">
                <div className="card-title">{t("reports.historyTitle")}</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ fontSize: "0.875rem" }}>
                  <thead>
                    <tr>
                      <th>{t("reports.colGenerated")}</th>
                      <th>{t("reports.colTotal")}</th>
                      <th>{t("reports.colPayments")}</th>
                      <th>{t("reports.colFilters")}</th>
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
                            : t("reports.none")}
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
                            {t("reports.rerun")}
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
            <StatCard label={t("reports.statTotalCollected")} value={report.summary.totalAmount} sub="XLM" Icon={IconTrendingUp} color="violet" />
            <StatCard label={t("reports.statTotalPayments")}  value={report.summary.paymentCount}                            Icon={IconBarChart}  color="cyan" />
            <StatCard label={t("status.validation.valid")}           value={report.summary.validCount}                              Icon={IconCheck}     color="green" />
            <StatCard label={t("status.validation.overpaid")}        value={report.summary.overpaidCount}                           Icon={IconAlertTriangle} color="amber" />
            <StatCard label={t("status.validation.underpaid")}       value={report.summary.underpaidCount}                          Icon={IconAlertTriangle} color="rose" />
            <StatCard label={t("reports.statPaidStudents")}   value={report.summary.fullyPaidStudentCount}                   Icon={IconCheck}     color="indigo" />
          </div>

          {/* By-class breakdown (if available) */}
          {report.byClass && report.byClass.length > 0 && (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <div className="card-header">
                <div className="card-title">{t("reports.byClass")}</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ fontSize: "0.875rem" }}>
                  <thead>
                    <tr>
                      <th>{t("reports.colClass")}</th>
                      <th>{t("reports.colTotalXlm")}</th>
                      <th>{t("reports.colPayments")}</th>
                      <th>{t("status.validation.valid")}</th>
                      <th>{t("status.validation.overpaid")}</th>
                      <th>{t("status.validation.underpaid")}</th>
                      <th>{t("reports.colStudents")}</th>
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
                <div className="card-title">{t("reports.dailyBreakdown")}</div>
                <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                  {t("reports.days", { count: report.byDate.length })}
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      {TABLE_COLS.map(col => (
                        <th key={col.key} scope="col">{t(col.label)}</th>
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
              <p style={{ fontWeight: 500 }}>{t("reports.noPaymentsInPeriod")}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
