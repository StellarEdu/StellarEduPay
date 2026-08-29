import { useState, useEffect, useRef } from "react";
import {
  getFeeStructures,
  createFeeStructure,
  deleteFeeStructure,
  getStudents,
  getSchool,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { IconAlertTriangle, IconCheck, IconDollarSign } from "../components/Icons";
import PageHero from "../components/PageHero";

// ── Default class options (used as fallback if school config not available) ──
const DEFAULT_CLASS_OPTIONS = ["JSS1", "JSS2", "JSS3", "SS1", "SS2", "SS3"];

const EMPTY_FORM = {
  className: "",
  feeAmount: "",
  academicYear: new Date().getUTCFullYear().toString(),
  description: "",
};

// ── Delete-confirmation modal ─────────────────────────────────────────────────

function DeleteConfirmModal({ feeStructure, studentCount, onConfirm, onCancel }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    cancelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="del-modal-title"
      aria-describedby="del-modal-desc"
      style={overlayStyle}
    >
      <div style={modalStyle}>
        <h2 id="del-modal-title" style={{ marginTop: 0, fontSize: "1.1rem" }}>
          Delete fee structure?
        </h2>
        <p id="del-modal-desc" style={{ color: "var(--text)", lineHeight: 1.5 }}>
          You are about to delete the fee structure for{" "}
          <strong>{feeStructure.className}</strong>.
          {studentCount > 0 && (
            <>
              {" "}This affects{" "}
              <strong>
                {studentCount} student{studentCount !== 1 ? "s" : ""}
              </strong>
              .
            </>
          )}{" "}
          This cannot be undone.
        </p>
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            justifyContent: "flex-end",
            marginTop: "1.5rem",
          }}
        >
          <button ref={cancelRef} onClick={onCancel} className="btn btn-ghost">
            Cancel
          </button>
          <button onClick={onConfirm} className="btn btn-danger">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FeesPage() {
  const [fees, setFees]             = useState([]);
  const [classOptions, setClassOptions] = useState(DEFAULT_CLASS_OPTIONS);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);

  // Create-form state
  const [form, setForm]             = useState(EMPTY_FORM);
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState(null);
  const [createSuccess, setCreateSuccess] = useState(false);

  // Delete state
  const [pendingDelete, setPendingDelete] = useState(null); // { fee, studentCount }
  const [deleteError, setDeleteError]     = useState(null);

  const successRef = useRef(null);

  useEffect(() => {
    loadFees();
    loadSchoolClassOptions();
  }, []);

  // Auto-focus success message for screen readers
  useEffect(() => {
    if (createSuccess) {
      successRef.current?.focus();
      const t = setTimeout(() => setCreateSuccess(false), 4000);
      return () => clearTimeout(t);
    }
  }, [createSuccess]);

  function loadFees() {
    setLoading(true);
    setError(null);
    getFeeStructures()
      .then(({ data }) => setFees(data))
      .catch(() => setError("Could not load fee structures."))
      .finally(() => setLoading(false));
  }

  function loadSchoolClassOptions() {
    // Get school slug from user's school ID stored in localStorage
    const schoolId = typeof window !== 'undefined' ? localStorage.getItem('schoolId') : null;
    if (!schoolId) return;

    // Use school ID as slug (or fetch from session if available)
    // The API will use X-School-ID header from interceptor, so we pass a placeholder
    getSchool(schoolId)
      .then(({ data }) => {
        if (data.classOptions && Array.isArray(data.classOptions) && data.classOptions.length > 0) {
          setClassOptions(data.classOptions);
        }
      })
      .catch(() => {
        // On error, silently fall back to defaults
      });
  }

  // ── Create form handlers ──────────────────────────────────────────────────

  function handleFormChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    setCreateError(null);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setCreateError(null);
    setCreateSuccess(false);

    const feeAmount = parseFloat(form.feeAmount);
    if (!form.className) {
      setCreateError("Class is required.");
      return;
    }
    if (!form.feeAmount || isNaN(feeAmount) || feeAmount <= 0) {
      setCreateError("Fee amount must be a positive number.");
      return;
    }

    setCreating(true);
    try {
      const payload = {
        className: form.className,
        feeAmount,
        ...(form.academicYear && { academicYear: form.academicYear }),
        ...(form.description.trim() && { description: form.description.trim() }),
      };
      const { data } = await createFeeStructure(payload);
      setFees((prev) => [...prev, data]);
      setForm(EMPTY_FORM);
      setCreateSuccess(true);
    } catch (err) {
      setCreateError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
          err.response?.data?.errors?.[0] ||
          "Failed to create fee structure."
      );
    } finally {
      setCreating(false);
    }
  }

  // ── Delete handlers ───────────────────────────────────────────────────────

  async function handleDeleteClick(fee) {
    setDeleteError(null);
    let studentCount = 0;
    try {
      const { data } = await getStudents(1, 1, { className: fee.className });
      studentCount = data.total || 0;
    } catch {
      // non-fatal — proceed without count
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
      setDeleteError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
          "Failed to delete fee structure."
      );
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHero
        eyebrow="Admin"
        title="Fee Structures"
        subtitle="Define per-class fee amounts that students are required to pay."
      />

      <div className="page-wrap">

        {/* ── Create form ──────────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="card-header">
            <div
              className="card-title"
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <IconDollarSign size={16} />
              Create Fee Structure
            </div>
          </div>
          <div className="card-body">
            {createSuccess && (
              <div
                ref={successRef}
                tabIndex="-1"
                role="status"
                aria-live="polite"
                className="alert alert-success"
                style={{ marginBottom: "1rem" }}
              >
                <IconCheck size={15} />
                <span>Fee structure created successfully.</span>
              </div>
            )}
            {createError && (
              <div
                role="alert"
                className="alert alert-danger"
                style={{ marginBottom: "1rem" }}
              >
                <IconAlertTriangle size={15} />
                <span>{createError}</span>
              </div>
            )}

            <form
              onSubmit={handleCreate}
              aria-label="Create fee structure"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "1rem",
                alignItems: "end",
              }}
            >
              {/* Class */}
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" htmlFor="fee-className">
                  Class <span aria-hidden="true" style={{ color: "var(--danger)" }}>*</span>
                </label>
                <select
                  id="fee-className"
                  name="className"
                  value={form.className}
                  onChange={handleFormChange}
                  required
                  disabled={creating}
                  className="form-input"
                  aria-required="true"
                >
                  <option value="">Select class…</option>
                  {classOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {/* Fee Amount */}
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" htmlFor="fee-feeAmount">
                  Fee Amount (XLM){" "}
                  <span aria-hidden="true" style={{ color: "var(--danger)" }}>*</span>
                </label>
                <input
                  id="fee-feeAmount"
                  name="feeAmount"
                  type="number"
                  min="0.0000001"
                  step="any"
                  placeholder="e.g. 250"
                  value={form.feeAmount}
                  onChange={handleFormChange}
                  required
                  disabled={creating}
                  className="form-input"
                  aria-required="true"
                />
              </div>

              {/* Academic Year */}
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" htmlFor="fee-academicYear">
                  Academic Year
                </label>
                <input
                  id="fee-academicYear"
                  name="academicYear"
                  type="text"
                  placeholder={new Date().getUTCFullYear().toString()}
                  value={form.academicYear}
                  onChange={handleFormChange}
                  disabled={creating}
                  className="form-input"
                />
              </div>

              {/* Description */}
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" htmlFor="fee-description">
                  Description
                </label>
                <input
                  id="fee-description"
                  name="description"
                  type="text"
                  placeholder="Optional note"
                  value={form.description}
                  onChange={handleFormChange}
                  disabled={creating}
                  className="form-input"
                />
              </div>

              {/* Submit */}
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                  aria-busy={creating}
                >
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* ── Alerts ───────────────────────────────────────────────────────── */}
        {error && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}
        {deleteError && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
            <IconAlertTriangle size={15} />
            <span>{deleteError}</span>
          </div>
        )}

        {/* ── Fee table ────────────────────────────────────────────────────── */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Existing Fee Structures</div>
            {!loading && (
              <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                {fees.length} {fees.length === 1 ? "structure" : "structures"}
              </span>
            )}
          </div>

          {loading ? (
            <div className="card-body">
              <p aria-busy="true" style={{ color: "var(--text-muted)" }}>
                Loading fee structures…
              </p>
            </div>
          ) : fees.length === 0 ? (
            <div className="card-body">
              <p style={{ color: "var(--text-muted)" }}>
                No fee structures found. Use the form above to create one.
              </p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                className="data-table"
                aria-label="Fee structures"
              >
                <thead>
                  <tr>
                    <th scope="col">Class</th>
                    <th scope="col">Fee Amount</th>
                    <th scope="col">Academic Year</th>
                    <th scope="col">Description</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fees.map((fee) => (
                    <tr key={fee.className}>
                      <td className="col-mono">{fee.className}</td>
                      <td>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>
                          {fee.feeAmount}
                        </span>
                        <span
                          style={{
                            marginLeft: "0.3rem",
                            fontSize: "0.72rem",
                            color: "var(--text-muted)",
                            fontWeight: 600,
                          }}
                        >
                          XLM
                        </span>
                      </td>
                      <td>{fee.academicYear || "—"}</td>
                      <td style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
                        {fee.description || "—"}
                      </td>
                      <td>
                        <button
                          onClick={() => handleDeleteClick(fee)}
                          className="btn btn-sm btn-ghost"
                          style={{ color: "var(--danger, #dc2626)" }}
                          aria-label={`Delete fee structure for ${fee.className}`}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Delete modal ─────────────────────────────────────────────────── */}
      {pendingDelete && (
        <DeleteConfirmModal
          feeStructure={pendingDelete.fee}
          studentCount={pendingDelete.studentCount}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

// ── Overlay styles (kept local — not in global CSS) ───────────────────────────

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
