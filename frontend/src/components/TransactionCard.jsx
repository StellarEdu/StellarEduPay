import { useState } from "react";
import { flagDispute } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

const EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_EXPLORER_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/");

function truncateHash(hash) {
  return hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "—";
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

const disputeColors = {
  open: "#e65100",
  under_review: "#1565c0",
  resolved: "#2e7d32",
  rejected: "#757575",
};

/**
 * TransactionCard — displays a single payment record.
 *
 * Accepts either flat props (txHash, amount, memo, confirmedAt) or a
 * `payment` object prop for backwards-compatibility with PaymentForm.
 */
export default function TransactionCard({
  payment,
  txHash,
  amount,
  memo,
  confirmedAt,
  schoolId,
  schoolSlug,
}) {
  // Support both calling conventions
  const tx = payment?.txHash ?? txHash ?? "";
  const amt = payment?.amount ?? amount ?? null;
  const ref = payment?.memo ?? memo ?? null;
  const date = payment?.confirmedAt ?? confirmedAt ?? null;
  const assetCode = payment?.assetCode ?? "XLM";
  const explorerUrl = payment?.explorerUrl ?? (tx ? `${EXPLORER_BASE}${tx}` : null);
  const studentId = payment?.studentId ?? ref;
  const localCurrency = payment?.localCurrency ?? null;
  const initDispute = payment?.dispute ?? null;

  const [disputeState, setDisputeState] = useState(initDispute);
  const [showForm, setShowForm] = useState(false);
  const [raisedBy, setRaisedBy] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const hasLocal = localCurrency?.available && localCurrency?.amount != null;

  async function handleFlagDispute(e) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const { data } = await flagDispute({ txHash: tx, studentId, raisedBy, reason });
      setDisputeState(data);
      setShowForm(false);
      setRaisedBy("");
      setReason("");
    } catch (err) {
      setFormError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to submit dispute.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        border: disputeState ? "1px solid #e65100" : "1px solid #ddd",
        borderRadius: 8,
        padding: "0.75rem 1rem",
        marginBottom: "0.5rem",
        fontFamily: "sans-serif",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        background: "#fff",
      }}
    >
      {/* Amount */}
      <p style={{ margin: 0, fontWeight: 600 }}>
        {amt != null
          ? `${parseFloat(amt).toLocaleString(undefined, { maximumFractionDigits: 7 })} ${assetCode}`
          : "—"}
        {hasLocal && (
          <span
            style={{ marginLeft: "0.5rem", color: "#2e7d32", fontWeight: 400, fontSize: "0.88rem" }}
          >
            ≈ {localCurrency.amount.toFixed(2)} {localCurrency.currency}
          </span>
        )}
        {!hasLocal && localCurrency && (
          <span style={{ marginLeft: "0.5rem", color: "#bbb", fontSize: "0.8rem" }}>
            (rate unavailable)
          </span>
        )}
      </p>

      {/* Student ID / Memo */}
      <p style={{ margin: "0.3rem 0 0", fontSize: "0.85rem", color: "#555" }}>
        <span style={{ color: "#888" }}>Student ID: </span>
        <strong>{ref ?? "—"}</strong>
      </p>

      {/* Tx Hash */}
      <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: "#555" }}>
        <span style={{ color: "#888" }}>Tx: </span>
        {tx ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={tx}
            style={{ color: "#1565c0", fontFamily: "monospace" }}
            aria-label={`View transaction ${tx} on Stellar Explorer`}
          >
            {truncateHash(tx)}
          </a>
        ) : (
          "—"
        )}
      </p>

      {/* Date */}
      <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: "#888" }}>{formatDate(date)}</p>

      {/* Dispute section */}
      {disputeState ? (
        <p
          style={{
            margin: "0.5rem 0 0",
            fontSize: "0.8rem",
            color: disputeColors[disputeState.status] || "#555",
          }}
          aria-label={`Dispute status: ${disputeState.status}`}
        >
          ⚑ Dispute {disputeState.status.replace("_", " ")}
          {disputeState.resolutionNote && ` — ${disputeState.resolutionNote}`}
        </p>
      ) : (
        <div style={{ marginTop: "0.5rem" }}>
          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              style={{
                fontSize: "0.78rem",
                color: "#e65100",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
              }}
              aria-label="Flag this payment as disputed"
            >
              Flag as disputed
            </button>
          ) : (
            <form onSubmit={handleFlagDispute} style={{ marginTop: "0.25rem" }}>
              <input
                type="text"
                placeholder="Your name"
                value={raisedBy}
                onChange={(e) => setRaisedBy(e.target.value)}
                required
                style={{
                  display: "block",
                  width: "100%",
                  marginBottom: "0.25rem",
                  fontSize: "0.8rem",
                  padding: "0.2rem 0.4rem",
                  boxSizing: "border-box",
                }}
                aria-label="Your name"
              />
              <textarea
                placeholder="Describe the issue"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                rows={2}
                style={{
                  display: "block",
                  width: "100%",
                  marginBottom: "0.25rem",
                  fontSize: "0.8rem",
                  padding: "0.2rem 0.4rem",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
                aria-label="Dispute reason"
              />
              {formError && (
                <p
                  style={{ color: "#c62828", fontSize: "0.78rem", margin: "0 0 0.25rem" }}
                  role="alert"
                >
                  {formError}
                </p>
              )}
              <button
                type="submit"
                disabled={submitting}
                style={{ fontSize: "0.78rem", marginRight: "0.5rem", cursor: "pointer" }}
              >
                {submitting ? "Submitting…" : "Submit dispute"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setFormError(null);
                }}
                style={{
                  fontSize: "0.78rem",
                  cursor: "pointer",
                  background: "none",
                  border: "none",
                  textDecoration: "underline",
                }}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
