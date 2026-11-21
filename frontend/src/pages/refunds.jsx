import { useState, useEffect, useCallback } from "react";
import { getSchoolRefunds, approveRefund, rejectRefund, completeRefund } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { IconAlertTriangle, IconCheck, IconChevronLeft, IconChevronRight } from "../components/Icons";
import PageHero from "../components/PageHero";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/usePermissions";

const STATUS_META = {
  approval_pending: { cls: "badge-warning",  labelKey: "status.refund.approval_pending", color: "var(--warning)" },
  pending:          { cls: "badge-info",     labelKey: "status.refund.pending",          color: "var(--info)" },
  submitted:        { cls: "badge-primary",  labelKey: "status.refund.submitted",        color: "var(--primary)" },
  confirmed:        { cls: "badge-success",  labelKey: "status.refund.confirmed",        color: "var(--success)" },
  rejected:         { cls: "badge-danger",   labelKey: "status.refund.rejected",         color: "var(--danger)" },
  failed:           { cls: "badge-danger",   labelKey: "status.refund.failed",           color: "var(--danger)" },
};

function StatusBadge({ status }) {
  const { t } = useTranslation();
  const meta = STATUS_META[status] || { cls: "badge-neutral", label: status };
  return (
    <span className={`badge ${meta.cls}`} style={{ textTransform: "none" }}>
      {meta.labelKey ? t(meta.labelKey) : status}
    </span>
  );
}

function actorName(actor) {
  if (!actor) return "—";
  return typeof actor === "string" ? actor : actor.displayName || "—";
}

function formatAmount(amount) {
  return typeof amount === "number" ? `$${amount.toFixed(2)}` : amount;
}

const LABEL_STYLE = {
  display: "block",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: "0.375rem",
};

const TEXTAREA_STYLE = {
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
};

const INPUT_STYLE = { ...TEXTAREA_STYLE, minHeight: 0, padding: "0.5rem 0.75rem" };

function actionButtonStyle(background, submitting) {
  return {
    padding: "0.5rem 1rem",
    background,
    color: background === "var(--bg)" ? "var(--text)" : "white",
    border: background === "var(--bg)" ? "1px solid var(--border)" : "none",
    borderRadius: "var(--radius-sm)",
    cursor: submitting ? "not-allowed" : "pointer",
    opacity: submitting ? 0.6 : 1,
    fontSize: "0.8125rem",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  };
}

function FormError({ message }) {
  if (!message) return null;
  return (
    <div role="alert" style={{
      marginBottom: "0.75rem",
      padding: "0.5rem 0.75rem",
      background: "var(--danger-subtle)",
      color: "var(--danger)",
      borderRadius: "var(--radius-sm)",
      fontSize: "0.8125rem",
    }}>
      {message}
    </div>
  );
}

function InfoBox({ message }) {
  return (
    <div style={{
      padding: "0.75rem",
      background: "var(--bg-subtle)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      fontSize: "0.8125rem",
      color: "var(--text-muted)",
    }}>
      {message}
    </div>
  );
}

function ApprovalForm({ refund, user, onDone, onCancelled }) {
  const { t } = useTranslation();
  const can = usePermissions();
  const [mode, setMode] = useState("approve");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  // #1581 — only owners may approve or reject (mirrors requireSchoolAuth(['owner'])).
  // Two-person rule: the initiator can never approve or reject their own request.
  const hasRole = can("refunds.write");
  const isInitiator = actorName(refund.initiatedBy) === user?.email;
  const canAct = hasRole && !isInitiator && refund.status === "approval_pending";

  if (!canAct) {
    return (
      <InfoBox message={
        !hasRole
          ? t("refunds.notAuthorized")
          : isInitiator
          ? t("refunds.youInitiated")
          : t("refunds.cannotApproveStatus", { status: refund.status })
      } />
    );
  }

  async function runAction(request, fallbackMessage) {
    setError(null);
    setSubmitting(true);
    try {
      await request();
      onDone();
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || fallbackMessage);
    } finally {
      setSubmitting(false);
    }
  }

  function handleApprove(e) {
    e.preventDefault();
    runAction(() => approveRefund(refund._id, { note }), t("refunds.failedToApprove"));
  }

  function handleReject(e) {
    e.preventDefault();
    const reason = rejectReason.trim();
    if (!reason) {
      setError(t("refunds.rejectReasonRequired"));
      return;
    }
    runAction(() => rejectRefund(refund._id, { reason }), t("refunds.failedToReject"));
  }

  return (
    <div style={{
      padding: "0.75rem",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      background: "var(--bg-subtle)",
    }}>
      <div role="group" aria-label={t("refunds.decisionLabel")} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        {[
          { value: "approve", label: t("refunds.approveRefund") },
          { value: "reject", label: t("refunds.rejectRefund") },
        ].map(opt => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={mode === opt.value}
            onClick={() => { setMode(opt.value); setError(null); }}
            style={{
              padding: "0.375rem 0.75rem",
              border: `1.5px solid ${mode === opt.value ? "var(--accent)" : "var(--border)"}`,
              background: mode === opt.value ? "var(--accent-subtle)" : "var(--bg)",
              color: mode === opt.value ? "var(--accent)" : "var(--text)",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontSize: "0.8125rem",
              fontWeight: mode === opt.value ? 600 : 400,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <FormError message={error} />

      {mode === "approve" ? (
        <form onSubmit={handleApprove}>
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={LABEL_STYLE}>{t("refunds.approvalNoteLabel")}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t("refunds.reasonPlaceholder")}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={onCancelled} disabled={submitting} style={actionButtonStyle("var(--bg)", submitting)}>
              {t("actions.cancel")}
            </button>
            <button type="submit" disabled={submitting} style={actionButtonStyle("var(--success)", submitting)}>
              <IconCheck size={16} />
              {submitting ? t("refunds.approving") : t("refunds.approveRefund")}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleReject}>
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={LABEL_STYLE}>{t("refunds.rejectReasonLabel")}</label>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder={t("refunds.rejectReasonPlaceholder")}
              required
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={onCancelled} disabled={submitting} style={actionButtonStyle("var(--bg)", submitting)}>
              {t("actions.cancel")}
            </button>
            <button type="submit" disabled={submitting} style={actionButtonStyle("var(--danger)", submitting)}>
              {submitting ? t("refunds.rejecting") : t("refunds.rejectRefund")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CompleteRefundForm({ refund, onDone, onCancelled }) {
  const { t } = useTranslation();
  const can = usePermissions();
  const [refundTxHash, setRefundTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const hasRole = can("refunds.write");
  const canComplete = hasRole && refund.status === "pending";

  if (!canComplete) {
    return <InfoBox message={hasRole ? t("refunds.notCompletable") : t("refunds.notAuthorized")} />;
  }

  async function handleComplete(e) {
    e.preventDefault();
    const hash = refundTxHash.trim();
    // Stellar transaction hashes are 32 bytes, written as 64 hex characters.
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      setError(t("refunds.invalidRefundTxHash"));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await completeRefund(refund._id, { refundTxHash: hash });
      onDone();
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("refunds.failedToComplete"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleComplete} style={{
      padding: "0.75rem",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      background: "var(--bg-subtle)",
    }}>
      <div style={{ fontSize: "0.8125rem", marginBottom: "0.75rem" }}>
        {t("refunds.sendInstructions", { amount: formatAmount(refund.amount) })}
      </div>
      <div style={{ fontSize: "0.8125rem", marginBottom: "0.75rem", wordBreak: "break-all" }}>
        <span style={{ color: "var(--text-muted)" }}>{t("refunds.originalTransaction")}: </span>
        <code style={{ fontSize: "0.75rem" }}>{refund.originalTxHash}</code>
      </div>

      <FormError message={error} />

      <div style={{ marginBottom: "0.75rem" }}>
        <label style={LABEL_STYLE}>{t("refunds.refundTxHashLabel")}</label>
        <input
          value={refundTxHash}
          onChange={e => setRefundTxHash(e.target.value)}
          placeholder={t("refunds.refundTxHashPlaceholder")}
          required
          style={INPUT_STYLE}
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancelled} disabled={submitting} style={actionButtonStyle("var(--bg)", submitting)}>
          {t("actions.cancel")}
        </button>
        <button type="submit" disabled={submitting} style={actionButtonStyle("var(--info)", submitting)}>
          {submitting ? t("refunds.completing") : t("refunds.markCompleted")}
        </button>
      </div>
    </form>
  );
}

function RefundTimeline({ refund }) {
  const { t } = useTranslation();
  const events = [
    { id: "initiated", at: refund.createdAt, text: t("refunds.timelineInitiated", { name: actorName(refund.initiatedBy) }) },
    { id: "approved", at: refund.approvedAt, text: t("refunds.timelineApproved", { name: actorName(refund.approvedBy) }) },
    { id: "rejected", at: refund.rejectedAt, text: t("refunds.timelineRejected", { name: actorName(refund.rejectedBy), reason: refund.rejectionReason || "—" }) },
    { id: "confirmed", at: refund.confirmedAt, text: t("refunds.timelineConfirmed") },
    { id: "failed", at: refund.failedAt, text: t("refunds.timelineFailed", { reason: refund.failureReason || "—" }) },
  ].filter(event => event.at);

  return (
    <div style={{ marginTop: "1rem", fontSize: "0.8125rem" }}>
      <div style={LABEL_STYLE}>{t("refunds.timelineTitle")}</div>
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {events.map(event => (
          <li key={event.id} style={{ display: "flex", gap: "0.75rem", padding: "0.25rem 0", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {new Date(event.at).toLocaleString()}
            </span>
            <span>{event.text}</span>
          </li>
        ))}
      </ol>
      {refund.refundTxHash && (
        <div style={{ marginTop: "0.5rem", wordBreak: "break-all" }}>
          <span style={{ color: "var(--text-muted)" }}>{t("refunds.refundHash")}: </span>
          <code style={{ fontSize: "0.75rem" }}>{refund.refundTxHash}</code>
        </div>
      )}
    </div>
  );
}

function RefundCard({ refund, user, onChanged }) {
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
              {refund.status === "approval_pending" && t("refunds.initiatedBy", { name: actorName(refund.initiatedBy) })}
              {refund.status !== "approval_pending" && refund.approvedAt && t("refunds.approvedBy", { name: actorName(refund.approvedBy) })}
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
                {formatAmount(refund.amount)}
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
          aria-expanded={expanded}
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
        <>
          {refund.status === "approval_pending" && (
            <ApprovalForm
              refund={refund}
              user={user}
              onDone={onChanged}
              onCancelled={() => setExpanded(false)}
            />
          )}
          {refund.status === "pending" && (
            <CompleteRefundForm
              refund={refund}
              onDone={onChanged}
              onCancelled={() => setExpanded(false)}
            />
          )}
          <RefundTimeline refund={refund} />
        </>
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
    <>
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
          { value: "rejected", labelKey: "status.refund.rejected" },
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
                onChanged={handleApprovalSuccess}
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
    </>
  );
}

export default Refunds;
