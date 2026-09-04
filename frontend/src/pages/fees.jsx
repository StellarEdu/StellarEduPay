import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  getFeeStructures,
  createFeeStructure,
  deleteFeeStructure,
  getStudents,
  getSchool,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { DEFAULT_CLASS_OPTIONS, loadSchoolClassOptions } from "../utils/classOptions";
import { IconAlertTriangle, IconCheck, IconDollarSign } from "../components/Icons";
import PageHero from "../components/PageHero";

const EMPTY_FORM = {
  className: "",
  feeAmount: "",
  academicYear: new Date().getUTCFullYear().toString(),
  description: "",
};

// ── Delete-confirmation modal ─────────────────────────────────────────────────

function DeleteConfirmModal({ feeStructure, studentCount, onConfirm, onCancel }) {
  const { t } = useTranslation();
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
          {t("fees.deleteTitle")}
        </h2>
        <p id="del-modal-desc" style={{ color: "var(--text)", lineHeight: 1.5 }}>
          {t("fees.deleteIntro")}{" "}
          <strong>{feeStructure.className}</strong>.
          {studentCount > 0 && (
            <>
              {" "}{t("fees.deleteAffects")}{" "}
              <strong>
                {t("fees.studentCount", { count: studentCount })}
              </strong>
              .
            </>
          )}{" "}
          {t("fees.deleteCannotUndo")}
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
            {t("actions.cancel")}
          </button>
          <button onClick={onConfirm} className="btn btn-danger">
            {t("actions.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FeesPage() {
  const [fees, setFees]             = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
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
    loadSchoolClassOptions(getSchool, setClassOptions);
  }, []);

  // Auto-focus success message for screen readers
  useEffect(() => {
    if (createSuccess) {
      successRef.current?.focus();
      const t = setTimeout(() => setCreateSuccess(false), 4000);
      return () => clearTimeout(t);
    }
  }, [createSuccess]);

  function loadFees(page = 1) {
    setLoading(true);
    setError(null);
    getFeeStructures({ page, limit: pagination.limit })
      .then(({ data }) => {
        setFees(data.data || data);
        if (data.pagination) {
          setPagination(data.pagination);
        }
      })
      .catch(() => setError(t("fees.failedToLoad")))
      .finally(() => setLoading(false));
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
      setCreateError(t("fees.classRequired"));
      return;
    }
    if (!form.feeAmount || isNaN(feeAmount) || feeAmount <= 0) {
      setCreateError(t("fees.amountPositive"));
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
      await createFeeStructure(payload);
      setForm(EMPTY_FORM);
      setCreateSuccess(true);
      loadFees(1);
    } catch (err) {
      setCreateError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
          err.response?.data?.errors?.[0] ||
          t("fees.failedToCreate")
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
      loadFees(pagination.page);
    } catch (err) {
      setDeleteError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
          t("fees.failedToDelete")
      );
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHero
        eyebrow={t("fees.eyebrow")}
        title={t("fees.title")}
        subtitle={t("fees.subtitle")}
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
              {t("fees.createTitle")}
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
                <span>{t("fees.createSuccess")}</span>
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
              aria-label={t("fees.createFormAria")}
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
                  {t("fees.classLabel")} <span aria-hidden="true" style={{ color: "var(--danger)" }}>*</span>
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
                  <option value="">{t("fees.selectClass")}</option>
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
                  {t("fees.feeAmountLabel")}{" "}
                  <span aria-hidden="true" style={{ color: "var(--danger)" }}>*</span>
                </label>
                <input
                  id="fee-feeAmount"
                  name="feeAmount"
                  type="number"
                  min="0.0000001"
                  step="any"
                  placeholder={t("fees.feePlaceholder")}
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
                  {t("fees.academicYearLabel")}
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
                  {t("fees.descriptionLabel")}
                </label>
                <input
                  id="fee-description"
                  name="description"
                  type="text"
                  placeholder={t("fees.descriptionPlaceholder")}
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
                  {creating ? t("fees.creating") : t("fees.create")}
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
            <div className="card-title">{t("fees.existingTitle")}</div>
            {!loading && (
              <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                {t("fees.count", { count: pagination.total })}
              </span>
            )}
          </div>

          {loading ? (
            <div className="card-body">
              <p aria-busy="true" style={{ color: "var(--text-muted)" }}>
                {t("fees.loading")}
              </p>
            </div>
          ) : fees.length === 0 ? (
            <div className="card-body">
              <p style={{ color: "var(--text-muted)" }}>
                {t("fees.empty")}
              </p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                className="data-table"
                aria-label={t("fees.tableAria")}
              >
                <thead>
                  <tr>
                    <th scope="col">{t("fees.colClass")}</th>
                    <th scope="col">{t("fees.colFeeAmount")}</th>
                    <th scope="col">{t("fees.colAcademicYear")}</th>
                    <th scope="col">{t("fees.colDescription")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("fees.colActions")}</span>
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
                          aria-label={t("fees.deleteForClass", { className: fee.className })}
                        >
                          {t("actions.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination.totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "0.5rem", padding: "1rem", borderTop: "1px solid var(--border)" }}>
                <button
                  onClick={() => loadFees(pagination.page - 1)}
                  disabled={!pagination.hasPrev || loading}
                  className="btn btn-sm btn-ghost"
                  aria-label={t("actions.previousPage")}
                >
                  <IconChevronLeft size={16} />
                </button>
                <span style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  {t("pagination.page", { current: pagination.page, total: pagination.totalPages })}
                </span>
                <button
                  onClick={() => loadFees(pagination.page + 1)}
                  disabled={!pagination.hasNext || loading}
                  className="btn btn-sm btn-ghost"
                  aria-label={t("actions.nextPage")}
                >
                  <IconChevronRight size={16} />
                </button>
              </div>
            )}
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
