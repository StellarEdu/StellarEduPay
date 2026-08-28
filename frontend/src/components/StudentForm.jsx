import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { updateStudent } from "../services/api";
import PaymentPlanForm from "./PaymentPlanForm";

export default function StudentForm({ student, onClose, onSave }) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    name: "",
    class: "",
    parentEmail: "",
    parentPhone: "",
    reminderOptOut: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (student) {
      setFormData({
        name: student.name || "",
        class: student.class || "",
        parentEmail: student.parentEmail || "",
        parentPhone: student.parentPhone || "",
        reminderOptOut: student.reminderOptOut || false,
      });
    }
  }, [student]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);

    try {
      await updateStudent(student.studentId, formData);
      setSuccess(t("studentForm.updateSuccess"));
      setTimeout(() => {
        if (onSave) onSave();
        if (onClose) onClose();
      }, 1000);
    } catch (err) {
      setError(err.response?.data?.error || t("studentForm.updateFailed"));
    } finally {
      setLoading(false);
    }
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  if (!student) return null;

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }}>
      <div style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        padding: "2rem",
        maxWidth: "500px",
        width: "90%",
        maxHeight: "90vh",
        overflowY: "auto",
      }}>
        <h2 style={{ marginTop: 0, marginBottom: "1.5rem" }}>{t("studentForm.editTitle")}</h2>

        {error && (
          <div style={{
            background: "#fee2e2",
            border: "1px solid #fecaca",
            borderRadius: "6px",
            padding: "0.75rem 1rem",
            color: "#991b1b",
            marginBottom: "1rem",
            fontSize: "0.875rem",
          }}>
            {error}
          </div>
        )}

        {success && (
          <div style={{
            background: "#dcfce7",
            border: "1px solid #bbf7d0",
            borderRadius: "6px",
            padding: "0.75rem 1rem",
            color: "#166534",
            marginBottom: "1rem",
            fontSize: "0.875rem",
          }}>
            ✓ {success}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "var(--text)",
            }}>
              {t("studentForm.studentId")}
            </label>
            <input
              type="text"
              value={student.studentId}
              disabled
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: "var(--muted)",
                color: "var(--text)",
                opacity: 0.6,
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "var(--text)",
            }}>
              {t("studentForm.name")}
            </label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "var(--text)",
            }}>
               {t("studentForm.className")}
            </label>
            <input
              type="text"
              name="class"
              value={formData.class}
              onChange={handleChange}
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "var(--text)",
            }}>
              {t("studentForm.parentEmail")}
            </label>
            <input
              type="email"
              name="parentEmail"
              value={formData.parentEmail}
              onChange={handleChange}
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "var(--text)",
            }}>
              {t("studentForm.parentPhone")}
            </label>
            <input
              type="tel"
              name="parentPhone"
              value={formData.parentPhone}
              onChange={handleChange}
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{
            marginBottom: "1.5rem",
            padding: "1rem",
            background: "rgba(126,200,227,0.05)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
          }}>
            <label style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              cursor: "pointer",
              fontSize: "0.9rem",
              margin: 0,
            }}>
              <input
                type="checkbox"
                name="reminderOptOut"
                checked={formData.reminderOptOut}
                onChange={handleChange}
                style={{
                  width: "18px",
                  height: "18px",
                  cursor: "pointer",
                }}
              />
              <span>
                <strong>{t("studentForm.receiveReminders")}</strong>
                <div style={{
                  fontSize: "0.8rem",
                  color: "var(--muted)",
                  marginTop: "0.25rem",
                }}>
                  {formData.reminderOptOut
                    ? t("studentForm.remindersDisabled")
                    : t("studentForm.remindersEnabled")}
                </div>
              </span>
            </label>
          </div>

          <PaymentPlanForm
            student={student}
            onClose={onClose}
            onSave={onSave}
          />

          <div style={{
            display: "flex",
            gap: "0.75rem",
            justifyContent: "flex-end",
            marginTop: "1.5rem",
          }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              style={{
                padding: "0.75rem 1.5rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: "0.9rem",
              }}
            >
              {t("actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: "0.75rem 1.5rem",
                border: "none",
                borderRadius: "6px",
                background: "var(--accent)",
                color: "white",
                cursor: loading ? "default" : "pointer",
                fontSize: "0.9rem",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? t("actions.savingEllipsis") : t("studentForm.saveChanges")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
