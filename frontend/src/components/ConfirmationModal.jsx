import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle = {
  background: "var(--card-bg, #ffffff)",
  borderRadius: 10,
  padding: "1.5rem",
  maxWidth: 440,
  width: "90%",
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.18)",
};

export default function ConfirmationModal({
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmVariant = "danger",
  onConfirm,
  onCancel,
  loading = false,
  disabled = false,
  children,
}) {
  const { t } = useTranslation();
  const cancelRef = useRef(null);
  const modalRef = useRef(null);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape" && !loading) {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    cancelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, loading]);

  const resolvedConfirmLabel = confirmLabel || t("actions.delete") || "Confirm";
  const resolvedCancelLabel = cancelLabel || t("actions.cancel") || "Cancel";
  const btnClass = confirmVariant === "primary" ? "btn btn-primary" : "btn btn-danger";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby={description ? "confirm-modal-desc" : undefined}
      style={overlayStyle}
    >
      <div ref={modalRef} style={modalStyle}>
        {title && (
          <h2 id="confirm-modal-title" style={{ marginTop: 0, fontSize: "1.1rem" }}>
            {title}
          </h2>
        )}
        {description && (
          <p id="confirm-modal-desc" style={{ color: "var(--text)", lineHeight: 1.5, margin: "0.5rem 0 1rem" }}>
            {description}
          </p>
        )}
        {children}
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            justifyContent: "flex-end",
            marginTop: "1.5rem",
          }}
        >
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="btn btn-ghost"
          >
            {resolvedCancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || disabled}
            className={btnClass}
          >
            {loading ? "…" : resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
