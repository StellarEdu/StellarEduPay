import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import PageHero from "../components/PageHero";
import ConfirmationModal from "../components/ConfirmationModal";
import InlineAlert from "../components/admin/InlineAlert";
import { IconRefreshCw } from "../components/Icons";
import { listSessions, revokeSession } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { usePermissions } from "../hooks/usePermissions";

function apiError(err, fallback) {
  const data = err?.response?.data;
  return getErrorMessage(data?.code, data?.error) || fallback;
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

/**
 * Security — #1581
 *
 * Active sessions with revocation, and the entry point to MFA enrolment
 * (/mfa-setup). Session management is backed by requireAdminAuth, so it is
 * shown to super-admins only.
 */
export default function SecurityPage() {
  const { t } = useTranslation();
  const can = usePermissions();
  const canManageSessions = can("sessions.manage");

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listSessions()
      .then(({ data }) => setSessions(data.sessions || []))
      .catch((err) => setError(apiError(err, t("security.loadFailed"))))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (canManageSessions) load();
    else setLoading(false);
  }, [canManageSessions, load]);

  async function handleRevoke() {
    if (!pendingRevoke) return;
    setRevoking(true);
    try {
      await revokeSession(pendingRevoke.sessionId);
      setNotice(t("security.revoked"));
      setPendingRevoke(null);
      load();
    } catch (err) {
      setError(apiError(err, t("security.revokeFailed")));
      setPendingRevoke(null);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="page-wrap-wide">
      <PageHero title={t("security.title")} subtitle={t("security.subtitle")} />

      <section className="card admin-section" aria-labelledby="mfa-title">
        <div className="card-header"><h2 id="mfa-title" className="card-title">{t("security.mfaTitle")}</h2></div>
        <div className="card-body">
          <p className="text-muted">{t("security.mfaDesc")}</p>
          <Link href="/mfa-setup" className="btn btn-primary">{t("security.mfaBtn")}</Link>
        </div>
      </section>

      <section className="card admin-section" aria-labelledby="sessions-title">
        <div className="card-header">
          <h2 id="sessions-title" className="card-title">{t("security.sessionsTitle")}</h2>
          {canManageSessions && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={load} aria-label={t("adminCommon.refresh")}>
              <IconRefreshCw size={14} />
            </button>
          )}
        </div>
        <div className="card-body">
          <InlineAlert>{error}</InlineAlert>
          <InlineAlert tone="success" onDismiss={() => setNotice(null)} dismissLabel={t("actions.hide")}>{notice}</InlineAlert>
          {!canManageSessions ? (
            <p className="text-muted">{t("security.sessionsSuperAdminOnly")}</p>
          ) : (
            <div className="table-wrap" aria-busy={loading}>
              <table className="data-table" aria-label={t("security.sessionsTitle")}>
                <thead>
                  <tr>
                    <th scope="col">{t("security.colDevice")}</th>
                    <th scope="col">{t("security.colIp")}</th>
                    <th scope="col">{t("security.colCreated")}</th>
                    <th scope="col">{t("security.colLastUsed")}</th>
                    <th scope="col"><span className="sr-only">{t("adminCommon.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan="5" className="text-muted">{t("actions.loading")}</td></tr>
                  ) : sessions.length === 0 ? (
                    <tr><td colSpan="5" className="text-muted">{t("security.sessionsEmpty")}</td></tr>
                  ) : sessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td className="truncate" title={s.deviceInfo?.userAgent || ""}>{s.deviceInfo?.userAgent || t("security.unknownDevice")}</td>
                      <td className="mono">{s.deviceInfo?.ip || "—"}</td>
                      <td>{formatDate(s.createdAt)}</td>
                      <td>{formatDate(s.lastUsed)}</td>
                      <td>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => setPendingRevoke(s)}>
                          {t("security.revokeBtn")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {pendingRevoke && (
        <ConfirmationModal
          title={t("security.revokeConfirmTitle")}
          description={t("security.revokeConfirmDesc")}
          confirmLabel={t("security.revokeBtn")}
          loading={revoking}
          onConfirm={handleRevoke}
          onCancel={() => setPendingRevoke(null)}
        />
      )}
    </div>
  );
}
