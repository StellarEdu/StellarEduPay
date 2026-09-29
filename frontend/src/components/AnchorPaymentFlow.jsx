/**
 * AnchorPaymentFlow — SEP-24 "Pay with bank / mobile money" flow (Issue #1571)
 *
 * Renders a list of configured anchors for the school, lets the parent pick
 * one, opens the anchor's interactive deposit UI in a popup window, then polls
 * the backend for deposit status until it completes or errors.
 *
 * Props:
 *   studentId  {string}  — student to pay for
 *   onComplete {function} — called with { anchorTxId, stellarTxHash } on success
 *   onCancel   {function} — called if the parent dismisses the flow
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { listAnchors, initiateAnchorDeposit, getAnchorDepositStatus } from "../services/api";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 360; // 30 min

const STATUS_MESSAGES = {
  pending_user_transfer: "Waiting for your bank transfer or mobile money payment…",
  pending_anchor:        "Anchor is processing your deposit…",
  pending_stellar:       "Submitting to the Stellar network…",
  pending_external:      "Awaiting external confirmation…",
  completed:             "Payment received!",
  error:                 "The deposit could not be completed. Please try again.",
  refunded:              "Your deposit was refunded by the anchor.",
  expired:               "The deposit session expired. Please start over.",
};

export default function AnchorPaymentFlow({ studentId, onComplete, onCancel }) {
  const [anchors, setAnchors]         = useState([]);
  const [loadingAnchors, setLoading]  = useState(true);
  const [anchorsError, setAnchorsErr] = useState(null);

  const [selectedAnchor, setSelected] = useState(null);
  const [initiating, setInitiating]   = useState(false);
  const [initError, setInitError]     = useState(null);

  // Polling state
  const [anchorTxId, setAnchorTxId]   = useState(null);
  const [sep24Url, setSep24Url]        = useState(null);
  const [depositStatus, setDepStatus] = useState(null);
  const [polling, setPolling]          = useState(false);
  const [pollError, setPollError]      = useState(null);

  const popupRef      = useRef(null);
  const pollTimerRef  = useRef(null);
  const pollAttempts  = useRef(0);

  // ── Load available anchors on mount ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAnchors()
      .then(r => { if (!cancelled) setAnchors(r.data.data || []); })
      .catch(e => { if (!cancelled) setAnchorsErr(e.message || "Failed to load payment options"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  // ── Poll deposit status ─────────────────────────────────────────────────────
  const pollStatus = useCallback(async () => {
    if (!anchorTxId || !sep24Url || !selectedAnchor) return;

    pollAttempts.current++;
    if (pollAttempts.current > MAX_POLL_ATTEMPTS) {
      setPollError("Timed out waiting for deposit confirmation. Please check back later.");
      setPolling(false);
      return;
    }

    try {
      const r = await getAnchorDepositStatus(anchorTxId, sep24Url, selectedAnchor.id);
      const { status, stellarTxHash } = r.data;
      setDepStatus(status);

      if (status === "completed") {
        setPolling(false);
        onComplete?.({ anchorTxId, stellarTxHash });
        return;
      }
      if (status === "error" || status === "refunded" || status === "expired") {
        setPolling(false);
        setPollError(STATUS_MESSAGES[status] || `Deposit ended with status: ${status}`);
        return;
      }
    } catch (err) {
      // Non-fatal — keep polling
      console.warn("[AnchorPaymentFlow] Poll error:", err.message);
    }

    pollTimerRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
  }, [anchorTxId, sep24Url, selectedAnchor, onComplete]);

  useEffect(() => {
    if (polling && anchorTxId) {
      pollAttempts.current = 0;
      pollTimerRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
    }
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, [polling, anchorTxId, pollStatus]);

  // ── Initiate deposit ────────────────────────────────────────────────────────
  async function handleInitiate() {
    if (!selectedAnchor || !studentId) return;
    setInitiating(true);
    setInitError(null);

    try {
      const r = await initiateAnchorDeposit({
        studentId,
        anchorId: selectedAnchor.id,
      });
      const { interactiveUrl, anchorTxId: txId, sep24Url: s24 } = r.data;

      setAnchorTxId(txId);
      setSep24Url(s24);

      // Open the anchor's hosted UI in a popup.
      popupRef.current = window.open(
        interactiveUrl,
        "anchorDeposit",
        "width=480,height=700,resizable=yes,scrollbars=yes"
      );

      setPolling(true);
    } catch (err) {
      setInitError(
        err.response?.data?.error || err.message || "Failed to start deposit"
      );
    } finally {
      setInitiating(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loadingAnchors) {
    return <div className="anchor-flow-loading">Loading payment options…</div>;
  }

  if (anchorsError) {
    return (
      <div className="anchor-flow-error">
        <p>⚠️ {anchorsError}</p>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Back</button>
      </div>
    );
  }

  if (anchors.length === 0) {
    return (
      <div className="anchor-flow-empty">
        <p>No bank / mobile money payment options are configured for this school.</p>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Back</button>
      </div>
    );
  }

  // Polling / completion view
  if (anchorTxId) {
    const statusMsg = depositStatus
      ? (STATUS_MESSAGES[depositStatus] || `Status: ${depositStatus}`)
      : "Opening payment portal…";

    return (
      <div className="anchor-flow-polling">
        <h3 style={{ marginBottom: "0.75rem" }}>Bank / Mobile Money Deposit</h3>

        {pollError ? (
          <div className="alert alert-error" style={{ marginBottom: "1rem" }}>
            {pollError}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
            {depositStatus !== "completed" && (
              <span
                className="spinner"
                style={{
                  display: "inline-block",
                  width: 16,
                  height: 16,
                  border: "2px solid var(--primary, #1a56db)",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
            )}
            <span>{statusMsg}</span>
          </div>
        )}

        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
          Complete the deposit in the popup window. If it closed, you can{" "}
          <button
            className="btn btn-xs btn-ghost"
            onClick={() => {
              if (popupRef.current && !popupRef.current.closed) {
                popupRef.current.focus();
              }
            }}
          >
            reopen it
          </button>
          .
        </p>

        <button
          className="btn btn-sm btn-ghost"
          style={{ marginTop: "1rem" }}
          onClick={() => {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            setPolling(false);
            setAnchorTxId(null);
            onCancel?.();
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // Anchor selection view
  return (
    <div className="anchor-flow">
      <h3 style={{ marginBottom: "0.75rem" }}>Pay with Bank / Mobile Money</h3>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
        No Stellar wallet required. Choose your local payment option:
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        {anchors.map(anchor => (
          <label
            key={anchor.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.75rem 1rem",
              border: `2px solid ${selectedAnchor?.id === anchor.id ? "var(--primary, #1a56db)" : "var(--border, #e5e7eb)"}`,
              borderRadius: "0.5rem",
              cursor: "pointer",
              background: selectedAnchor?.id === anchor.id ? "var(--primary-light, #eff6ff)" : "transparent",
            }}
          >
            <input
              type="radio"
              name="anchor"
              value={anchor.id}
              checked={selectedAnchor?.id === anchor.id}
              onChange={() => setSelected(anchor)}
              style={{ accentColor: "var(--primary, #1a56db)" }}
            />
            {anchor.logoUrl && (
              <img
                src={anchor.logoUrl}
                alt={anchor.label}
                style={{ height: 28, objectFit: "contain" }}
              />
            )}
            <div>
              <div style={{ fontWeight: 600 }}>{anchor.label}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {anchor.assetCode} · {anchor.homeDomain}
              </div>
            </div>
          </label>
        ))}
      </div>

      {initError && (
        <div className="alert alert-error" style={{ marginBottom: "0.75rem" }}>
          {initError}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={!selectedAnchor || initiating}
          onClick={handleInitiate}
        >
          {initiating ? "Starting…" : "Continue to Bank / Mobile Money"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Back
        </button>
      </div>
    </div>
  );
}
