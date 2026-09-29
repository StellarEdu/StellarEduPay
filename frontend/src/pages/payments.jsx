import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import PageHero from "../components/PageHero";
import SyncButton from "../components/SyncButton";
import Pager from "../components/admin/Pager";
import InlineAlert from "../components/admin/InlineAlert";
import { IconRefreshCw, IconExternalLink } from "../components/Icons";
import {
  getPayments,
  getSuspiciousPayments,
  getPendingPayments,
  getStuckPayments,
  getOverpayments,
  getSyncStatus,
  reviewSuspiciousPayment,
  updatePaymentStatus,
  initiateRefund,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { usePermissions } from "../hooks/usePermissions";

const PAGE_SIZE = 25;

// Statuses an operator may set manually (the backend rejects PENDING).
export const OVERRIDE_STATUSES = ["SUBMITTED", "SUCCESS", "FAILED", "DISPUTED", "REFUNDED", "INVALID"];

const STATUS_BADGE = {
  SUCCESS: "badge-success",
  PENDING: "badge-warning",
  SUBMITTED: "badge-info",
  FAILED: "badge-danger",
  INVALID: "badge-danger",
  DISPUTED: "badge-warning",
  REFUNDED: "badge-neutral",
};

// Each tab knows how to fetch its list and where the rows live in the response.
const TABS = {
  all: {
    fetch: (page, filters) => getPayments({ page, limit: PAGE_SIZE, ...filters }),
    rows: (d) => d.payments || [],
    pages: (d) => d.pagination?.totalPages || 1,
    total: (d) => d.pagination?.total || 0,
  },
  suspicious: {
    fetch: (page) => getSuspiciousPayments({ page, limit: PAGE_SIZE }),
    rows: (d) => d.suspicious || [],
    pages: (d) => d.pagination?.totalPages || 1,
    total: (d) => d.pagination?.total || 0,
  },
  pending: {
    fetch: (page) => getPendingPayments({ page, limit: PAGE_SIZE }),
    rows: (d) => d.pending || [],
    pages: (d) => d.pagination?.totalPages || 1,
    total: (d) => d.pagination?.total || 0,
  },
  stuck: {
    fetch: () => getStuckPayments(),
    rows: (d) => d.payments || [],
    pages: () => 1,
    total: (d) => d.count || 0,
  },
  overpayments: {
    fetch: (page) => getOverpayments({ page, limit: PAGE_SIZE }),
    rows: (d) => d.overpayments || [],
    pages: (d) => d.pagination?.totalPages || 1,
    total: (d) => d.pagination?.total || 0,
  },
};

function apiError(err, fallback) {
  const data = err?.response?.data;
  return getErrorMessage(data?.code, data?.error) || fallback;
}

const txOf = (p) => p.txHash || p.transactionHash || "";
const shortHash = (h) => (h && h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h || "—");

// ── Row action forms ──────────────────────────────────────────────────────────

function SuspicionReviewForm({ payment, onDone }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(action) {
    setBusy(true);
    setError(null);
    try {
      await reviewSuspiciousPayment(txOf(payment), { action, note: note.trim() || undefined });
      onDone(action === "clear" ? t("payments.reviewCleared") : t("payments.reviewFraud"));
    } catch (err) {
      setError(apiError(err, t("payments.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="suspicion-review-form">
      <p className="text-muted">{t("payments.suspicionReason")}: {payment.suspicionReason || "—"}</p>
      <InlineAlert>{error}</InlineAlert>
      <div className="form-group">
        <label className="form-label" htmlFor={`review-note-${txOf(payment)}`}>{t("payments.reviewNote")}</label>
        <textarea id={`review-note-${txOf(payment)}`} className="form-textarea" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="admin-row-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => submit("clear")}>
          {t("payments.clearBtn")}
        </button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => submit("confirm_fraud")}>
          {t("payments.confirmFraudBtn")}
        </button>
      </div>
    </div>
  );
}

function StatusOverrideForm({ payment, onDone }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(
    OVERRIDE_STATUSES.find((s) => s !== payment.status) || OVERRIDE_STATUSES[0]
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!reason.trim()) {
      setError(t("payments.reasonRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updatePaymentStatus(txOf(payment), { status, reason: reason.trim() });
      onDone(t("payments.statusUpdated", { status }));
    } catch (err) {
      setError(apiError(err, t("payments.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} data-testid="status-override-form">
      <InlineAlert>{error}</InlineAlert>
      <div className="admin-grid-2">
        <div className="form-group">
          <label className="form-label" htmlFor={`override-status-${txOf(payment)}`}>{t("payments.newStatus")}</label>
          <select id={`override-status-${txOf(payment)}`} className="form-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            {OVERRIDE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`override-reason-${txOf(payment)}`}>{t("payments.reason")}</label>
          <input id={`override-reason-${txOf(payment)}`} className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>{t("payments.applyStatusBtn")}</button>
    </form>
  );
}

function RefundForm({ payment, onDone }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!reason.trim()) {
      setError(t("payments.reasonRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await initiateRefund(txOf(payment), { reason: reason.trim() });
      onDone(t("payments.refundInitiated"));
    } catch (err) {
      setError(apiError(err, t("payments.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} data-testid="refund-form">
      <InlineAlert>{error}</InlineAlert>
      <div className="form-group">
        <label className="form-label" htmlFor={`refund-reason-${txOf(payment)}`}>{t("payments.refundReason")}</label>
        <input id={`refund-reason-${txOf(payment)}`} className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <p className="text-muted">{t("payments.refundHelp")}</p>
      <button type="submit" className="btn btn-sm btn-danger" disabled={busy}>{t("payments.refundBtn")}</button>
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { t } = useTranslation();
  const can = usePermissions();
  const canWrite = can("payments.write");
  const canRefund = can("refunds.write");

  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filters, setFilters] = useState({ status: "", studentId: "", startDate: "", endDate: "" });
  const [openAction, setOpenAction] = useState(null); // { tx, kind }
  const [syncStatus, setSyncStatus] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    getSyncStatus()
      .then(({ data }) => setSyncStatus(data))
      .catch(() => setSyncStatus(null));
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    const cfg = TABS[tab];
    const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    setLoading(true);
    setError(null);
    cfg.fetch(page, activeFilters)
      .then(({ data }) => {
        if (cancelled) return;
        setRows(cfg.rows(data));
        setPages(cfg.pages(data));
        setTotal(cfg.total(data));
      })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
        setError(apiError(err, t("payments.loadFailed")));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, page, filters, reloadKey, t]);

  function selectTab(next) {
    setTab(next);
    setPage(1);
    setOpenAction(null);
  }

  function handleDone(message) {
    setOpenAction(null);
    setNotice(message);
    reload();
  }

  const setFilter = (key) => (e) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setPage(1);
  };

  const toggleAction = (tx, kind) =>
    setOpenAction(openAction?.tx === tx && openAction?.kind === kind ? null : { tx, kind });

  return (
    <div className="page-wrap-wide">
      <PageHero title={t("payments.title")} subtitle={t("payments.subtitle")}>
        {canWrite && <SyncButton onSyncComplete={reload} />}
      </PageHero>

      {syncStatus && (
        <p className="text-muted" data-testid="sync-status">
          {syncStatus.lastSyncAt
            ? t("payments.lastSync", { when: new Date(syncStatus.lastSyncAt).toLocaleString() })
            : t("payments.neverSynced")}
        </p>
      )}

      <InlineAlert tone="success" onDismiss={() => setNotice(null)} dismissLabel={t("actions.hide")}>{notice}</InlineAlert>

      <div className="admin-tabs" role="tablist" aria-label={t("payments.tabsAria")}>
        {Object.keys(TABS).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={tab === key}
            onClick={() => selectTab(key)}
          >
            {t(`payments.tab_${key}`)}
          </button>
        ))}
      </div>

      <div className="card admin-section">
        {tab === "all" && (
          <div className="admin-toolbar" role="search" aria-label={t("payments.filtersAria")}>
            <div className="form-group">
              <label className="form-label" htmlFor="payments-student">{t("payments.colStudent")}</label>
              <input id="payments-student" className="form-input" value={filters.studentId} onChange={setFilter("studentId")} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="payments-status">{t("payments.colStatus")}</label>
              <select id="payments-status" className="form-select" value={filters.status} onChange={setFilter("status")}>
                <option value="">{t("payments.statusAny")}</option>
                {["PENDING", ...OVERRIDE_STATUSES].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="payments-from">{t("payments.from")}</label>
              <input id="payments-from" type="date" className="form-input" value={filters.startDate} onChange={setFilter("startDate")} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="payments-to">{t("payments.to")}</label>
              <input id="payments-to" type="date" className="form-input" value={filters.endDate} onChange={setFilter("endDate")} />
            </div>
            <button type="button" className="btn btn-ghost" onClick={reload} aria-label={t("adminCommon.refresh")}>
              <IconRefreshCw size={14} />
            </button>
          </div>
        )}

        <InlineAlert>{error}</InlineAlert>

        <div className="table-wrap" aria-busy={loading}>
          <table className="data-table" aria-label={t(`payments.tab_${tab}`)}>
            <thead>
              <tr>
                <th scope="col">{t("payments.colTx")}</th>
                <th scope="col">{t("payments.colStudent")}</th>
                <th scope="col">{t("payments.colAmount")}</th>
                <th scope="col">{t("payments.colStatus")}</th>
                <th scope="col">{t("payments.colDate")}</th>
                <th scope="col"><span className="sr-only">{t("adminCommon.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="6" className="text-muted">{t("actions.loading")}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan="6"><div className="empty-state"><div className="empty-state-title">{t("payments.empty")}</div></div></td></tr>
              ) : rows.flatMap((p) => {
                const tx = txOf(p);
                const explorer = p.stellarExplorerUrl || p.explorerUrl;
                const out = [
                  <tr key={tx}>
                    <td className="mono" title={tx}>
                      {shortHash(tx)}
                      {explorer && (
                        <a href={explorer} target="_blank" rel="noopener noreferrer" aria-label={t("payments.viewOnExplorer")} style={{ marginLeft: 4 }}>
                          <IconExternalLink size={12} />
                        </a>
                      )}
                    </td>
                    <td className="mono">{p.studentId || "—"}</td>
                    <td>
                      {p.amount} {p.assetCode || ""}
                      {tab === "overpayments" && p.excessAmount ? ` (+${p.excessAmount})` : ""}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[p.status] || "badge-neutral"}`}>{p.status}</span>
                      {p.isSuspicious && <span className="badge badge-danger" style={{ marginLeft: 4 }}>{t("payments.suspiciousBadge")}</span>}
                    </td>
                    <td>{p.confirmedAt || p.submittedAt || p.createdAt ? new Date(p.confirmedAt || p.submittedAt || p.createdAt).toLocaleString() : "—"}</td>
                    <td>
                      <div className="admin-row-actions">
                        {canWrite && tab === "suspicious" && (
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => toggleAction(tx, "review")}>
                            {t("payments.reviewBtn")}
                          </button>
                        )}
                        {canWrite && tab !== "suspicious" && (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => toggleAction(tx, "status")}>
                            {t("payments.overrideBtn")}
                          </button>
                        )}
                        {canRefund && p.status === "SUCCESS" && (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => toggleAction(tx, "refund")}>
                            {t("payments.refundBtn")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>,
                ];
                if (openAction?.tx === tx) {
                  const Form = { review: SuspicionReviewForm, status: StatusOverrideForm, refund: RefundForm }[openAction.kind];
                  out.push(
                    <tr key={`${tx}-action`}>
                      <td colSpan="6" style={{ padding: 0 }}>
                        <div className="admin-detail"><Form payment={p} onDone={handleDone} /></div>
                      </td>
                    </tr>
                  );
                }
                return out;
              })}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} total={total} loading={loading} onChange={setPage} />
      </div>
    </div>
  );
}
