import { useState, useEffect } from "react";
import { getAuditLogs } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import {
  IconChevronLeft, IconChevronRight, IconAlertTriangle, IconCheck,
} from "../components/Icons";
import PageHero from "../components/PageHero";
import { useTranslation } from "react-i18next";
import styles from "../styles/audit-logs.module.css";

function formatTimestamp(isoString, t) {
  if (!isoString) return t("auditLogs.notAvailable");
  return new Date(isoString).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const ACTION_LABELS = {
  student_create:       "auditLogs.event.student_create",
  student_update:       "auditLogs.event.student_update",
  student_delete:       "auditLogs.event.student_delete",
  student_bulk_import:  "auditLogs.event.student_bulk_import",
  payment_manual_sync:  "auditLogs.event.payment_manual_sync",
  payment_finalize:     "auditLogs.event.payment_finalize",
  fee_create:           "auditLogs.event.fee_create",
  fee_update:           "auditLogs.event.fee_update",
  fee_delete:           "auditLogs.event.fee_delete",
  school_create:        "auditLogs.event.school_create",
  school_update:        "auditLogs.event.school_update",
  school_deactivate:    "auditLogs.event.school_deactivate",
};

function getActionLabel(action, t) {
  return ACTION_LABELS[action] ? t(ACTION_LABELS[action]) : action;
}

const ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }));

export default function AuditLogsContent() {
  const { t } = useTranslation();
  const [logs, setLogs]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [total, setTotal]             = useState(0);
  const [nextCursor, setNextCursor]   = useState(null);
  const [cursorStack, setCursorStack] = useState([]); // Stack of previous cursors for back button
  const [expandedId, setExpandedId]   = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

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

  const fetchLogs = (cursor = null) => {
    const isLoadMore = cursor !== null && cursor !== undefined;
    if (isLoadMore) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLogs([]);
      setCursorStack([]);
    }
    setError(null);
    const params = { limit: 50 };
    if (cursor) params.cursor = cursor;
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
        if (isLoadMore) {
          setLogs(prev => [...prev, ...data.data]);
          setCursorStack(prev => [...prev, cursor]);
        } else {
          setLogs(data.data);
          setTotal(data.total);
        }
        setNextCursor(data.nextCursor);
      })
      .catch((err) => {
        setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("auditLogs.failedToLoad"));
      })
      .finally(() => {
        if (isLoadMore) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      });
  };

  useEffect(() => { fetchLogs(1); }, [actionFilter, targetTypeFilter, resultFilter, actorIdFilter, searchFilter, startDate, endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="page-wrap-wide">
        <PageHero
          eyebrow={t("auditLogs.eyebrow")}
          title={t("auditLogs.title")}
          subtitle={t("auditLogs.subtitle")}
        />
        {!loading && total !== null && (
          <p style={{ textAlign: "center", fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "-1.25rem", marginBottom: "1.5rem" }}>
            {t("auditLogs.showingEntries", { shown: logs.length.toLocaleString(), total: total.toLocaleString() })}
          </p>
        )}

        <div className="card">
          {/* Filters */}
          <div className={styles.filters}>
            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterActionLabel")}</label>
              <select
                value={actionFilter}
                onChange={e => setActionFilter(e.target.value)}
                className={styles.filterInput}
              >
                <option value="">{t("auditLogs.allActions")}</option>
                {ACTION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{t(o.label)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterTargetTypeLabel")}</label>
              <select
                value={targetTypeFilter}
                onChange={e => setTargetTypeFilter(e.target.value)}
                className={styles.filterInput}
              >
                <option value="">{t("auditLogs.allTypes")}</option>
                {["student","payment","fee","school"].map(t => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterResultLabel")}</label>
              <select
                value={resultFilter}
                onChange={e => setResultFilter(e.target.value)}
                className={styles.filterInput}
                aria-label={t("auditLogs.filterByResult")}
              >
                <option value="">{t("auditLogs.allResults")}</option>
                <option value="success">{t("auditLogs.resultSuccess")}</option>
                <option value="failure">{t("auditLogs.resultFailure")}</option>
              </select>
            </div>

            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterActorIdLabel")}</label>
              <input
                type="text"
                value={actorIdInput}
                onChange={e => setActorIdInput(e.target.value)}
                placeholder={t("auditLogs.actorPlaceholder")}
                className={styles.filterInput}
              />
            </div>

            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterSearchLabel")}</label>
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder={t("auditLogs.searchPlaceholder")}
                className={styles.filterInput}
              />
            </div>

            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterFromLabel")}</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className={styles.filterInput}
              />
            </div>

            <div>
              <label className={styles.filterLabel}>{t("auditLogs.filterToLabel")}</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className={styles.filterInput}
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
                    <th>{t("auditLogs.colTimestamp")}</th><th>{t("auditLogs.colAction")}</th><th>{t("auditLogs.colPerformedBy")}</th>
                    <th>{t("auditLogs.colTarget")}</th><th>{t("auditLogs.colResult")}</th><th>{t("auditLogs.colDetails")}</th>
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
            <div className={styles.empty}>
              <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>{t("auditLogs.noLogsFound")}</p>
              <p style={{ fontSize: "0.8125rem" }}>{t("auditLogs.emptyFilters")}</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t("auditLogs.colTimestamp")}</th>
                    <th scope="col">{t("auditLogs.colAction")}</th>
                    <th scope="col">{t("auditLogs.colPerformedBy")}</th>
                    <th scope="col">{t("auditLogs.colTarget")}</th>
                    <th scope="col">{t("auditLogs.colResult")}</th>
                    <th scope="col">{t("auditLogs.colDetails")}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const isExpanded = expandedId === log._id;
                    return (
                      <tr key={log._id}>
                        <td style={{ whiteSpace: "nowrap", fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                          {formatTimestamp(log.createdAt, t)}
                        </td>
                        <td style={{ fontWeight: 500, fontSize: "0.875rem" }}>{getActionLabel(log.action, t)}</td>
                        <td style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>{log.performedBy}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.25rem" }}>
                            <span className={styles.targetBadge}>{log.targetType}</span>
                            <span className="font-mono" style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{log.targetId}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${log.result === "success" ? "badge-success" : "badge-danger"}`}>
                            {log.result === "success" ? <IconCheck size={10} /> : <IconAlertTriangle size={10} />}
                            {log.result === "success" ? t("auditLogs.resultSuccess") : t("auditLogs.resultFailure")}
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
                                className={styles.expandBtn}
                                onClick={() => setExpandedId(isExpanded ? null : log._id)}
                                aria-expanded={isExpanded}
                              >
                                {isExpanded ? t("actions.hide") : t("actions.view")}
                              </button>
                              {isExpanded && (
                                <pre className={styles.detailPre}>
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
          {!loading && nextCursor && (
            <div style={{ padding: "0.875rem 1.5rem", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
              {cursorStack.length > 0 && (
                <button
                  className="page-btn"
                  onClick={() => {
                    const prevStack = cursorStack.slice(0, -1);
                    const prevCursor = prevStack.length > 0 ? prevStack[prevStack.length - 1] : null;
                    setCursorStack(prevStack);
                    // Reset to first page with current filters
                    fetchLogs(null);
                  }}
                  aria-label={t("actions.previousPage")}
                  style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                  disabled={loadingMore}
                >
                  <IconChevronLeft size={15} /> {t("actions.back")}
                </button>
              )}
              <button
                className="page-btn"
                onClick={() => fetchLogs(nextCursor)}
                aria-label={t("actions.nextPage")}
                style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                disabled={loadingMore}
              >
                {loadingMore ? t("actions.loading") : t("actions.loadMore")} <IconChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
