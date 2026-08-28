import { useState, useEffect, useCallback } from "react";
import { getSchoolRefunds, approveRefund } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { IconAlertTriangle, IconCheck, IconChevronLeft, IconChevronRight } from "../components/Icons";
import PageHero from "../components/PageHero";
import RequireAdmin from "../components/RequireAdmin";
import { useTranslation } from "react-i18next";

const STATUS_META = {
  approval_pending: { cls: "badge-warning",  labelKey: "status.refund.approval_pending", color: "var(--warning)" },
  pending:          { cls: "badge-info",     labelKey: "status.refund.pending",          color: "var(--info)" },
  submitted:        { cls: "badge-primary",  labelKey: "status.refund.submitted",        color: "var(--primary)" },
  confirmed:        { cls: "badge-success",  labelKey: "status.refund.confirmed",        color: "var(--success)" },
  failed:           { cls: "badge-danger",   labelKey: "status.refund.failed",           color: "var(--danger)" },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { cls: "badge-neutral", label: status };
  return (
    <span className={`badge ${meta.cls}`} style={{ textTransform: "none" }}>
      {meta.labelKey ? t(meta.labelKey) : status}
    </span>
  );
}

function ApproveRefundForm({ refund, user, onApproved, onCancelled }) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState("");

  const canApprove = refund.initiatedBy !== user?.email && refund.status === "approval_pending";

  async function handleApprove(e) {
    e.preventDefault();
    if (!canApprove) return;

    setError(null);
    setSubmitting(true);
    try {
      await approveRefund(refund._id, { note });
      onApproved();
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("refunds.failedToApprove"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!canApprove) {
    return (
      <div style={{
        padding: "0.75rem",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        fontSize: "0.8125rem",
        color: "var(--text-muted)",
      }}>
        {refund.initiatedBy === user?.email
          ? t("refunds.youInitiated")
          : refund.status !== "approval_pending"
          ? t("refunds.cannotApproveStatus", { status: refund.status })
          : t("refunds.notAuthorized")}
      </div>
    );
  }

  return (
    <form onSubmit={handleApprove} style={{
      padding: "0.75rem",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      background: "var(--bg-subtle)",
    }}>
      {error && (
        <div style={{
          marginBottom: "0.75rem",
          padding: "0.5rem 0.75rem",
          background: "var(--danger-subtle)",
          color: "var(--danger)",
          borderRadius: "var(--radius-sm)",
          fontSize: "0.8125rem",
        }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: "0.75rem" }}>
        <label style={{
          display: "block",
          fontSize: "0.75rem",
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: "0.375rem",
        }}>
          {t("refunds.approvalNoteLabel")}
        </label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={t("refunds.reasonPlaceholder")}
          style={{
            width: "100%",
            padding: "0.5rem 0.75rem",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "monospace",
            fontSize: "0.8125rem",
            minHeight: "60px",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCancelled}
          disabled={submitting}
          style={{
            padding: "0.5rem 1rem",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            borderRadius: "var(--radius-sm)",
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: submitting ? 0.6 : 1,
            fontSize: "0.8125rem",
            fontWeight: 500,
          }}
        >
          {t("actions.cancel")}
        </button>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "0.5rem 1rem",
            background: "var(--success)",
            color: "white",
            border: "none",
            borderRadius: "var(--radius-sm)",
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: submitting ? 0.6 : 1,
            fontSize: "0.8125rem",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "0.375rem",
          }}
        >
          <IconCheck size={16} />
          {submitting ? t("refunds.approving") : t("refunds.approveRefund")}
        </button>
      </div>
    </form>
  );
}

function RefundCard({ refund, user, onApproved }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      padding: "1rem",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      background: "var(--bg-card)",
      marginBottom: "0.75rem",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "1rem",
        marginBottom: expanded ? "1rem" : 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <StatusBadge status={refund.status} />
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
              {refund.status === "approval_pending" && t("refunds.initiatedBy", { name: refund.initiatedBy })}
              {refund.status !== "approval_pending" && refund.approvedAt && t("refunds.approvedBy", { name: refund.approvedBy })}
            </span>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1rem",
            fontSize: "0.8125rem",
          }}>
            <div>
              <div style={{ color: "var(--text-muted)", marginBottom: "0.25rem" }}>{t("refunds.studentId")}</div>
              <div style={{ fontWeight: 600, fontFamily: "monospace", fontSize: "0.75rem" }}>
                {refund.studentId}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", marginBottom: "0.25rem" }}>{t("refunds.amount")}</div>
              <div style={{ fontWeight: 600 }}>
                {typeof refund.amount === "number" ? `$${refund.amount.toFixed(2)}` : refund.amount}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", marginBottom: "0.25rem" }}>{t("refunds.reason")}</div>
              <div style={{ fontSize: "0.75rem", fontStyle: "italic" }}>
                {refund.reason || "—"}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", marginBottom: "0.25rem" }}>{t("refunds.transaction")}</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.75rem", wordBreak: "break-all" }}>
                {refund.originalTxHash?.slice(0, 16)}...
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            padding: "0.25rem",
            display: "flex",
            alignItems: "center",
          }}
        >
          {expanded ? "−" : "+"}
        </button>
      </div>

      {expanded && (
        <ApproveRefundForm
          refund={refund}
          user={user}
          onApproved={onApproved}
          onCancelled={() => setExpanded(false)}
        />
      )}
    </div>
  );
}

function Refunds() {
  const { t } = useTranslation();
  const [refunds, setRefunds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState("approval_pending");
  const [user, setUser] = useState(null);

  const PAGE_SIZE = 10;

  useEffect(() => {
    const userData = typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('user') || '{}') : {};
    setUser(userData);
  }, []);

  const fetchRefunds = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = {
      page,
      limit: PAGE_SIZE,
      ...(statusFilter && statusFilter !== "all" && { status: statusFilter }),
    };
    getSchoolRefunds(params)
      .then(({ data }) => {
        setRefunds(Array.isArray(data.refunds) ? data.refunds : []);
        setPages(data.pages || 1);
        setTotal(data.total || 0);
      })
      .catch(() => setError(t("refunds.failedToLoad")))
      .finally(() => setLoading(false));
  }, [page, statusFilter, t]);

  useEffect(() => {
    fetchRefunds();
  }, [fetchRefunds]);

  const handleApprovalSuccess = () => {
    fetchRefunds();
  };

  const pendingCount = refunds.filter(r => r.status === "approval_pending").length;

  return (
    <RequireAdmin>
      <PageHero
        title={t("refunds.title")}
        subtitle={t("refunds.subtitle")}
      />

      {pendingCount > 0 && (
        <div style={{
          marginBottom: "2rem",
          padding: "1rem",
          background: "var(--warning-subtle)",
          border: `2px solid var(--warning)`,
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          display: "flex",
          gap: "0.75rem",
          alignItems: "flex-start",
        }}>
          <IconAlertTriangle size={20} style={{ marginTop: "0.125rem", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
              {t("refunds.awaitingApproval", { count: pendingCount })}
            </div>
            <div style={{ fontSize: "0.8125rem", opacity: 0.9 }}>
              {t("refunds.twoOperator")}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: "1.5rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        {[
          { value: "approval_pending", labelKey: "status.refund.approval_pending" },
          { value: "pending", labelKey: "status.refund.pending" },
          { value: "confirmed", labelKey: "status.refund.confirmed" },
          { value: "failed", labelKey: "status.refund.failed" },
          { value: "all", labelKey: "refunds.filterAll" },
        ].map(opt => (
          <button
            key={opt.value}
            onClick={() => {
              setStatusFilter(opt.value);
              setPage(1);
            }}
            style={{
              padding: "0.5rem 1rem",
              border: `1.5px solid ${statusFilter === opt.value ? "var(--accent)" : "var(--border)"}`,
              background: statusFilter === opt.value ? "var(--accent-subtle)" : "var(--bg)",
              color: statusFilter === opt.value ? "var(--accent)" : "var(--text)",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontWeight: statusFilter === opt.value ? 600 : 400,
              fontSize: "0.8125rem",
              transition: "all 0.12s",
            }}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          padding: "1rem",
          background: "var(--danger-subtle)",
          color: "var(--danger)",
          borderRadius: "var(--radius-sm)",
          marginBottom: "1.5rem",
        }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
          {t("actions.loading")}
        </div>
      )}

      {!loading && refunds.length === 0 && (
        <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
          {t("refunds.emptyStatus")}
        </div>
      )}

      {!loading && refunds.length > 0 && (
        <>
          <div style={{ marginBottom: "1.5rem" }}>
            {refunds.map(refund => (
              <RefundCard
                key={refund._id}
                refund={refund}
                user={user}
                onApproved={handleApprovalSuccess}
              />
            ))}
          </div>

          {pages > 1 && (
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "1.5rem",
              paddingTop: "1rem",
              borderTop: "1px solid var(--border)",
            }}>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                {t("refunds.showingRange", { start: (page - 1) * PAGE_SIZE + 1, end: Math.min(page * PAGE_SIZE, total), total })}
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  style={{
                    padding: "0.5rem 0.75rem",
                    border: "1px solid var(--border)",
                    background: page === 1 ? "var(--bg-subtle)" : "var(--bg)",
                    borderRadius: "var(--radius-sm)",
                    cursor: page === 1 ? "not-allowed" : "pointer",
                    opacity: page === 1 ? 0.5 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.375rem",
                  }}
                >
                  <IconChevronLeft size={16} />
                </button>
                <span style={{ fontSize: "0.8125rem", padding: "0.5rem 0.75rem" }}>
                  {t("refunds.pageOf", { page, total: pages })}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pages, p + 1))}
                  disabled={page === pages}
                  style={{
                    padding: "0.5rem 0.75rem",
                    border: "1px solid var(--border)",
                    background: page === pages ? "var(--bg-subtle)" : "var(--bg)",
                    borderRadius: "var(--radius-sm)",
                    cursor: page === pages ? "not-allowed" : "pointer",
                    opacity: page === pages ? 0.5 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.375rem",
                  }}
                >
                  <IconChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </RequireAdmin>
  );
}

export default Refunds;
