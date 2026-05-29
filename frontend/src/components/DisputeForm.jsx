import { useState } from "react";
import { flagDispute } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

/**
 * DisputeForm — lets a parent raise a dispute for a confirmed payment.
 *
 * Props:
 *   txHash    {string}   — transaction hash of the payment being disputed
 *   studentId {string}   — student ID associated with the payment
 *   onSuccess {function} — called with the created dispute object on success
 *   onCancel  {function} — called when the user dismisses the form
 */
export default function DisputeForm({ txHash, studentId, onSuccess, onCancel }) {
  const [raisedBy, setRaisedBy] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [existingDisputeId, setExistingDisputeId] = useState(null);

  function validate() {
    const e = {};
    if (!raisedBy.trim()) e.raisedBy = "Your name is required.";
    else if (raisedBy.trim().length > 200) e.raisedBy = "Must be 200 characters or fewer.";
    if (!reason.trim()) e.reason = "Reason is required.";
    else if (reason.trim().length > 1000) e.reason = "Must be 1000 characters or fewer.";
    return e;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setServerError(null);
    setExistingDisputeId(null);

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      const res = await flagDispute({ txHash, studentId, raisedBy: raisedBy.trim(), reason: reason.trim() });
      onSuccess && onSuccess(res.data);
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 409 && data?.disputeId) {
        setExistingDisputeId(data.disputeId);
      } else {
        setServerError(getErrorMessage(data?.code, data?.error) || "Failed to submit dispute. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dispute-form-title"
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "1.5rem",
        maxWidth: 480,
      }}
    >
      <h3 id="dispute-form-title" style={{ marginBottom: "0.25rem", fontSize: "1rem" }}>
        Raise a Dispute
      </h3>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "1.25rem" }}>
        Transaction: <code style={{ fontFamily: "monospace" }}>{txHash?.slice(0, 16)}…</code>
      </p>

      {existingDisputeId && (
        <div role="alert" style={{ background: "#fef9c3", border: "1px solid #fde68a", borderRadius: 6, padding: "0.75rem", fontSize: "0.85rem", color: "#854d0e", marginBottom: "1rem" }}>
          A dispute is already open for this payment.{" "}
          <strong>Dispute ID:</strong> <code>{existingDisputeId}</code>
        </div>
      )}

      {serverError && (
        <div role="alert" style={{ background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "0.75rem", fontSize: "0.85rem", color: "#991b1b", marginBottom: "1rem" }}>
          {serverError}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="df-raisedBy" style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "0.3rem" }}>
            Your Name
          </label>
          <input
            id="df-raisedBy"
            type="text"
            value={raisedBy}
            onChange={(e) => setRaisedBy(e.target.value)}
            maxLength={200}
            aria-describedby={errors.raisedBy ? "df-raisedBy-err" : undefined}
            aria-invalid={!!errors.raisedBy}
            style={{ width: "100%", padding: "0.6rem 0.75rem", border: `1px solid ${errors.raisedBy ? "#f87171" : "var(--border)"}`, borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: "0.9rem", boxSizing: "border-box" }}
          />
          {errors.raisedBy && (
            <span id="df-raisedBy-err" role="alert" style={{ color: "#dc2626", fontSize: "0.78rem" }}>{errors.raisedBy}</span>
          )}
        </div>

        <div style={{ marginBottom: "1.25rem" }}>
          <label htmlFor="df-reason" style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "0.3rem" }}>
            Reason <span style={{ color: "var(--muted)", fontWeight: 400 }}>({reason.length}/1000)</span>
          </label>
          <textarea
            id="df-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            rows={4}
            aria-describedby={errors.reason ? "df-reason-err" : undefined}
            aria-invalid={!!errors.reason}
            style={{ width: "100%", padding: "0.6rem 0.75rem", border: `1px solid ${errors.reason ? "#f87171" : "var(--border)"}`, borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: "0.9rem", resize: "vertical", boxSizing: "border-box" }}
          />
          {errors.reason && (
            <span id="df-reason-err" role="alert" style={{ color: "#dc2626", fontSize: "0.78rem" }}>{errors.reason}</span>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ padding: "0.5rem 1rem", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: "0.875rem" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            style={{ padding: "0.5rem 1.25rem", border: "none", borderRadius: 6, background: "#1a1a2e", color: "#fff", cursor: submitting ? "not-allowed" : "pointer", fontSize: "0.875rem", opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? "Submitting…" : "Submit Dispute"}
          </button>
        </div>
      </form>
    </div>
  );
}
