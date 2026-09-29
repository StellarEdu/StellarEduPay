import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import PageHero from "../components/PageHero";
import ConfirmationModal from "../components/ConfirmationModal";
import InlineAlert from "../components/admin/InlineAlert";
import { IconRefreshCw, IconBell } from "../components/Icons";
import { previewReminders, triggerReminders, setReminderOptOut } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { usePermissions } from "../hooks/usePermissions";

function apiError(err, fallback) {
  const data = err?.response?.data;
  return getErrorMessage(data?.code, data?.error) || fallback;
}

/**
 * Reminders — #1581
 *
 * Preview which students are due a fee reminder, send the run on demand and
 * opt individual students out. Backed by /api/reminders (owner/staff).
 */
export default function RemindersPage() {
  const { t } = useTranslation();
  const can = usePermissions();
  const canManage = can("reminders.manage");

  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [busyStudent, setBusyStudent] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    previewReminders()
      .then(({ data }) => setPreview(data))
      .catch((err) => setError(apiError(err, t("reminders.loadFailed"))))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (canManage) load();
    else setLoading(false);
  }, [canManage, load]);

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      const { data } = await triggerReminders();
      const s = data.summary || {};
      setNotice(t("reminders.sent", { sent: s.sent ?? 0, failed: s.failed ?? 0, skipped: s.skipped ?? 0 }));
      load();
    } catch (err) {
      setError(apiError(err, t("reminders.sendFailed")));
    } finally {
      setSending(false);
      setConfirmSend(false);
    }
  }

  async function handleOptOut(student) {
    setBusyStudent(student.studentId);
    setError(null);
    try {
      await setReminderOptOut(student.studentId, true);
      setNotice(t("reminders.optedOut", { name: student.name }));
      load();
    } catch (err) {
      setError(apiError(err, t("reminders.optOutFailed")));
    } finally {
      setBusyStudent(null);
    }
  }

  if (!canManage) {
    return (
      <div className="page-wrap-wide">
        <PageHero title={t("reminders.title")} subtitle={t("reminders.subtitle")} />
        <InlineAlert tone="warning">{t("adminCommon.noPermission")}</InlineAlert>
      </div>
    );
  }

  const students = preview?.students || [];

  return (
    <div className="page-wrap-wide">
      <PageHero title={t("reminders.title")} subtitle={t("reminders.subtitle")}>
        <button type="button" className="btn btn-primary" disabled={sending || students.length === 0} onClick={() => setConfirmSend(true)}>
          <IconBell size={14} /> {t("reminders.sendBtn")}
        </button>
      </PageHero>

      <InlineAlert>{error}</InlineAlert>
      <InlineAlert tone="success" onDismiss={() => setNotice(null)} dismissLabel={t("actions.hide")}>{notice}</InlineAlert>

      <section className="card admin-section" aria-labelledby="reminders-preview-title">
        <div className="card-header">
          <h2 id="reminders-preview-title" className="card-title">{t("reminders.previewTitle")}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load} aria-label={t("adminCommon.refresh")}>
            <IconRefreshCw size={14} />
          </button>
        </div>
        <div className="card-body">
          {preview && (
            <p className="text-muted" data-testid="reminders-policy">
              {t("reminders.policy", { count: preview.count, cooldown: preview.cooldownHours, max: preview.maxReminders })}
            </p>
          )}
          <div className="table-wrap" aria-busy={loading}>
            <table className="data-table" aria-label={t("reminders.previewTitle")}>
              <thead>
                <tr>
                  <th scope="col">{t("reminders.colStudent")}</th>
                  <th scope="col">{t("reminders.colClass")}</th>
                  <th scope="col">{t("reminders.colBalance")}</th>
                  <th scope="col">{t("reminders.colLastSent")}</th>
                  <th scope="col">{t("reminders.colCount")}</th>
                  <th scope="col"><span className="sr-only">{t("adminCommon.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan="6" className="text-muted">{t("actions.loading")}</td></tr>
                ) : students.length === 0 ? (
                  <tr><td colSpan="6" className="text-muted">{t("reminders.empty")}</td></tr>
                ) : students.map((s) => (
                  <tr key={s.studentId}>
                    <td>{s.name} <span className="mono text-muted">({s.studentId})</span></td>
                    <td>{s.class}</td>
                    <td>{s.remainingBalance ?? s.feeAmount}</td>
                    <td>{s.lastReminderSentAt ? new Date(s.lastReminderSentAt).toLocaleString() : t("time.never")}</td>
                    <td>{s.reminderCount || 0}</td>
                    <td>
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busyStudent === s.studentId} onClick={() => handleOptOut(s)}>
                        {t("reminders.optOutBtn")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {confirmSend && (
        <ConfirmationModal
          title={t("reminders.confirmTitle")}
          description={t("reminders.confirmDesc", { count: students.length })}
          confirmLabel={t("reminders.sendBtn")}
          confirmVariant="primary"
          loading={sending}
          onConfirm={handleSend}
          onCancel={() => setConfirmSend(false)}
        />
      )}
    </div>
  );
}
