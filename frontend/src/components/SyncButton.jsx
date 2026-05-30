/**
 * SyncButton — triggers POST /api/payments/sync with a confirmation modal.
 *
 * Props:
 *   onSyncComplete  — called with the response data after a successful sync
 *   lastSyncTime    — ISO string or Date of the last sync (optional)
 */
import { useState } from "react";
import { syncPayments } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

export default function SyncButton({ onSyncComplete, lastSyncTime }) {
  const [showModal, setShowModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);

  async function handleConfirm() {
    setSyncing(true);
    setError(null);
    try {
      const { data } = await syncPayments();
      setShowModal(false);
      onSyncComplete?.(data);
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Sync failed. Please try again.");
    } finally {
      setSyncing(false);
    }
  }

  const formattedLastSync = lastSyncTime ? new Date(lastSyncTime).toLocaleString() : "Never";

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        disabled={syncing}
        style={btnStyle}
        aria-label="Sync payments from blockchain"
      >
        {syncing ? "Syncing…" : "Sync Payments"}
      </button>

      {showModal && (
        <div
          style={overlayStyle}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sync-modal-title"
        >
          <div style={modalStyle}>
            <h3 id="sync-modal-title" style={{ margin: "0 0 0.5rem" }}>
              Confirm Sync
            </h3>
            <p style={{ margin: "0 0 0.25rem", fontSize: "0.9rem", color: "var(--text)" }}>
              This will fetch the latest transactions from the Stellar network and update payment
              records.
            </p>
            <p style={{ margin: "0 0 1rem", fontSize: "0.85rem", color: "var(--muted)" }}>
              Last sync: <strong>{formattedLastSync}</strong>
            </p>

            {error && (
              <p
                style={{ color: "#c62828", fontSize: "0.85rem", margin: "0 0 0.75rem" }}
                role="alert"
              >
                {error}
              </p>
            )}

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setShowModal(false);
                  setError(null);
                }}
                disabled={syncing}
                style={cancelBtnStyle}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={syncing}
                style={confirmBtnStyle}
                aria-label="Confirm sync"
              >
                {syncing ? "Syncing…" : "Confirm Sync"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const btnStyle = {
  padding: "0.5rem 1.25rem",
  fontSize: "0.95rem",
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle = {
  background: "var(--card-bg)",
  borderRadius: 8,
  padding: "1.5rem",
  width: "100%",
  maxWidth: 420,
  boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
  fontFamily: "sans-serif",
};

const cancelBtnStyle = {
  padding: "0.45rem 1rem",
  fontSize: "0.9rem",
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  color: "var(--text)",
};

const confirmBtnStyle = {
  padding: "0.45rem 1rem",
  fontSize: "0.9rem",
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
