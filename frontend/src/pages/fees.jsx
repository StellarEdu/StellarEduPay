import { useState, useEffect } from "react";
import { getFeeStructures, deleteFeeStructure, getStudents } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

/** Modal that asks the user to confirm deletion of a fee structure. */
function DeleteConfirmModal({ feeStructure, studentCount, onConfirm, onCancel }) {
  // Trap focus inside the modal and close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-desc"
      style={overlayStyle}
    >
      <div style={modalStyle}>
        <h2 id="modal-title" style={{ marginTop: 0, fontSize: "1.1rem" }}>
          Delete fee structure?
        </h2>
        <p id="modal-desc" style={{ color: "var(--text)", lineHeight: 1.5 }}>
          You are about to delete the fee structure for{" "}
          <strong>{feeStructure.className}</strong>.
          {studentCount > 0 && (
            <>
              {" "}This affects{" "}
              <strong>{studentCount} student{studentCount !== 1 ? "s" : ""}</strong>.
            </>
          )}{" "}
          This cannot be undone.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.5rem" }}>
          <button onClick={onCancel} style={cancelBtnStyle} autoFocus>
            Cancel
          </button>
          <button onClick={onConfirm} style={deleteBtnStyle}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FeesPage() {
  const [fees, setFees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // { fee, studentCount }
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    setLoading(true);
    getFeeStructures()
      .then(({ data }) => setFees(data))
      .catch(() => setError("Could not load fee structures."))
      .finally(() => setLoading(false));
  }, []);

  async function handleDeleteClick(fee) {
    setDeleteError(null);
    // Fetch affected student count before showing the modal
    let studentCount = 0;
    try {
      const { data } = await getStudents(1, 1, { className: fee.className });
      studentCount = data.total || 0;
    } catch {
      // Non-fatal — show modal without count
    }
    setPendingDelete({ fee, studentCount });
  }

  async function handleConfirmDelete() {
    const { fee } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteFeeStructure(fee.className);
      setFees((prev) => prev.filter((f) => f.className !== fee.className));
    } catch (err) {
      setDeleteError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to delete fee structure.");
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Fee Structures</h1>

      {error && (
        <p role="alert" style={{ color: "var(--error-color)" }}>{error}</p>
      )}
      {deleteError && (
        <p role="alert" style={{ color: "var(--error-color)" }}>{deleteError}</p>
      )}

      {loading ? (
        <p aria-busy="true">Loading fee structures…</p>
      ) : fees.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No fee structures found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr>
              <th style={thStyle}>Class</th>
              <th style={thStyle}>Fee Amount</th>
              <th style={thStyle}>Academic Year</th>
              <th style={thStyle}>Description</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {fees.map((fee) => (
              <tr key={fee.className}>
                <td style={tdStyle}>{fee.className}</td>
                <td style={tdStyle}>{fee.feeAmount} XLM</td>
                <td style={tdStyle}>{fee.academicYear || "—"}</td>
                <td style={tdStyle}>{fee.description || "—"}</td>
                <td style={tdStyle}>
                  <button
                    onClick={() => handleDeleteClick(fee)}
                    aria-label={`Delete fee structure for ${fee.className}`}
                    style={deleteBtnStyle}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          feeStructure={pendingDelete.fee}
          studentCount={pendingDelete.studentCount}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "0.6rem 1rem",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted)",
  borderBottom: "2px solid var(--border)",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  borderBottom: "1px solid var(--border)",
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
  borderRadius: 10,
  padding: "1.5rem",
  maxWidth: 420,
  width: "90%",
  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
};

const cancelBtnStyle = {
  padding: "0.5rem 1.2rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: "0.9rem",
};

const deleteBtnStyle = {
  padding: "0.5rem 1.2rem",
  borderRadius: 6,
  border: "none",
  background: "#dc2626",
  color: "#fff",
  cursor: "pointer",
  fontSize: "0.9rem",
};
