import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import PageHero from "../components/PageHero";
import InlineAlert from "../components/admin/InlineAlert";
import {
  getSchoolById,
  updateSchoolById,
  getSchoolSettings,
  updateSchoolSettings,
  getPaymentLimits,
  getAcceptedAssets,
  listSchoolUsers,
  createSchoolUser,
  updateSchoolUser,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { useActiveSchoolId } from "../hooks/useActiveSchoolId";
import { usePermissions } from "../hooks/usePermissions";

const SCHOOL_ROLES = ["owner", "staff", "read_only"];
const HOUR_MS = 3600000;

function apiError(err, fallback) {
  const data = err?.response?.data;
  return getErrorMessage(data?.code, data?.error) || fallback;
}

// ── School profile ────────────────────────────────────────────────────────────

function SchoolProfileSection({ schoolId, canEdit }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(null);
  const [original, setOriginal] = useState(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    getSchoolById(schoolId)
      .then(({ data }) => {
        const school = data.school || data;
        const values = {
          name: school.name || "",
          adminEmail: school.adminEmail || "",
          address: school.address || "",
          localCurrency: school.localCurrency || "",
          stellarAddress: school.stellarAddress || "",
          suspiciousPaymentMultiplier: school.suspiciousPaymentMultiplier ?? "",
        };
        setForm(values);
        setOriginal(values);
      })
      .catch((err) => setError(apiError(err, t("settings.loadFailed"))));
  }, [schoolId, t]);

  if (!form) {
    return (
      <section className="card admin-section" aria-labelledby="school-profile-title">
        <div className="card-header"><h2 id="school-profile-title" className="card-title">{t("settings.profileTitle")}</h2></div>
        <div className="card-body">
          <InlineAlert>{error}</InlineAlert>
          {!error && <p className="text-muted">{t("actions.loading")}</p>}
        </div>
      </section>
    );
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const addressChanged = form.stellarAddress !== original.stellarAddress;

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updates = {};
      for (const key of Object.keys(form)) {
        if (form[key] !== original[key]) updates[key] = form[key];
      }
      if (updates.suspiciousPaymentMultiplier !== undefined && updates.suspiciousPaymentMultiplier !== "") {
        updates.suspiciousPaymentMultiplier = Number(updates.suspiciousPaymentMultiplier);
      }
      if (addressChanged) updates.confirmPassword = confirmPassword;
      await updateSchoolById(schoolId, updates);
      setOriginal(form);
      setConfirmPassword("");
      setNotice(t("settings.saved"));
    } catch (err) {
      setError(apiError(err, t("settings.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const field = (key, label, props = {}) => (
    <div className="form-group">
      <label className="form-label" htmlFor={`school-${key}`}>{label}</label>
      <input id={`school-${key}`} className="form-input" value={form[key]} onChange={set(key)} disabled={!canEdit} {...props} />
    </div>
  );

  return (
    <form className="card admin-section" onSubmit={handleSubmit} aria-labelledby="school-profile-title">
      <div className="card-header"><h2 id="school-profile-title" className="card-title">{t("settings.profileTitle")}</h2></div>
      <div className="card-body">
        <InlineAlert>{error}</InlineAlert>
        <InlineAlert tone="success">{notice}</InlineAlert>
        {!canEdit && <p className="text-muted">{t("settings.readOnlyNotice")}</p>}
        <div className="admin-grid-2">
          {field("name", t("settings.fieldName"), { required: true })}
          {field("adminEmail", t("settings.fieldAdminEmail"), { type: "email" })}
          {field("address", t("settings.fieldAddress"))}
          {field("localCurrency", t("settings.fieldCurrency"))}
          {field("suspiciousPaymentMultiplier", t("settings.fieldSuspiciousMultiplier"), { type: "number", min: "1", step: "any" })}
          {field("stellarAddress", t("settings.fieldStellarAddress"), { className: "form-input mono" })}
        </div>
        {canEdit && addressChanged && (
          <div className="form-group">
            <label className="form-label" htmlFor="school-confirm-password">{t("settings.confirmPassword")}</label>
            <input id="school-confirm-password" type="password" className="form-input" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            <p className="text-muted">{t("settings.stellarAddressWarning")}</p>
          </div>
        )}
        {canEdit && (
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t("actions.saving") : t("actions.save")}
          </button>
        )}
      </div>
    </form>
  );
}

// ── Runtime settings ──────────────────────────────────────────────────────────

function RuntimeSettingsSection({ schoolId, canEdit }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    getSchoolSettings(schoolId)
      .then(({ data }) => setSettings(data.settings || {}))
      .catch((err) => setError(apiError(err, t("settings.loadFailed"))));
  }, [schoolId, t]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await updateSchoolSettings(schoolId, {
        reminderEnabled: !!settings.reminderEnabled,
        reminderIntervalMs: Number(settings.reminderIntervalMs),
        maxSyncBatchSize: Number(settings.maxSyncBatchSize),
        maintenanceMode: !!settings.maintenanceMode,
      });
      setNotice(t("settings.saved"));
    } catch (err) {
      setError(apiError(err, t("settings.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card admin-section" onSubmit={handleSubmit} aria-labelledby="runtime-settings-title">
      <div className="card-header"><h2 id="runtime-settings-title" className="card-title">{t("settings.runtimeTitle")}</h2></div>
      <div className="card-body">
        <InlineAlert>{error}</InlineAlert>
        <InlineAlert tone="success">{notice}</InlineAlert>
        {!settings ? (
          !error && <p className="text-muted">{t("actions.loading")}</p>
        ) : (
          <>
            <div className="admin-grid-2">
              <label className="form-check" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={!!settings.reminderEnabled}
                  disabled={!canEdit}
                  onChange={(e) => setSettings((s) => ({ ...s, reminderEnabled: e.target.checked }))}
                />
                {t("settings.reminderEnabled")}
              </label>
              <label className="form-check" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={!!settings.maintenanceMode}
                  disabled={!canEdit}
                  onChange={(e) => setSettings((s) => ({ ...s, maintenanceMode: e.target.checked }))}
                />
                {t("settings.maintenanceMode")}
              </label>
              <div className="form-group">
                <label className="form-label" htmlFor="setting-reminder-interval">{t("settings.reminderIntervalHours")}</label>
                <input
                  id="setting-reminder-interval"
                  type="number"
                  min="1"
                  className="form-input"
                  disabled={!canEdit}
                  value={Math.round((settings.reminderIntervalMs || 0) / HOUR_MS)}
                  onChange={(e) => setSettings((s) => ({ ...s, reminderIntervalMs: Number(e.target.value) * HOUR_MS }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="setting-sync-batch">{t("settings.maxSyncBatchSize")}</label>
                <input
                  id="setting-sync-batch"
                  type="number"
                  min="1"
                  className="form-input"
                  disabled={!canEdit}
                  value={settings.maxSyncBatchSize ?? ""}
                  onChange={(e) => setSettings((s) => ({ ...s, maxSyncBatchSize: e.target.value }))}
                />
              </div>
            </div>
            {canEdit && (
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t("actions.saving") : t("actions.save")}
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}

// ── Payment limits & accepted assets (read-only) ─────────────────────────────

function PaymentRulesSection() {
  const { t } = useTranslation();
  const [limits, setLimits] = useState(null);
  const [assets, setAssets] = useState([]);

  useEffect(() => {
    getPaymentLimits().then(({ data }) => setLimits(data)).catch(() => setLimits(null));
    getAcceptedAssets().then(({ data }) => setAssets(data.assets || [])).catch(() => setAssets([]));
  }, []);

  return (
    <section className="card admin-section" aria-labelledby="payment-rules-title">
      <div className="card-header"><h2 id="payment-rules-title" className="card-title">{t("settings.paymentRulesTitle")}</h2></div>
      <div className="card-body">
        <p>
          {limits
            ? t("settings.limitsRange", { min: limits.min, max: limits.max })
            : t("settings.limitsUnavailable")}
        </p>
        <p className="text-muted">{t("settings.acceptedAssets")}: {assets.length ? assets.map((a) => a.displayName || a.code).join(", ") : "—"}</p>
      </div>
    </section>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

function RolePicker({ value, onChange, disabled, idPrefix }) {
  const { t } = useTranslation();
  const toggle = (role) =>
    onChange(value.includes(role) ? value.filter((r) => r !== role) : [...value, role]);
  return (
    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
      {SCHOOL_ROLES.map((role) => (
        <label key={role} htmlFor={`${idPrefix}-${role}`} style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
          <input id={`${idPrefix}-${role}`} type="checkbox" checked={value.includes(role)} disabled={disabled} onChange={() => toggle(role)} />
          {t(`settings.role_${role}`)}
        </label>
      ))}
    </div>
  );
}

function UsersSection({ schoolId, canManage }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoles, setInviteRoles] = useState(["staff"]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    listSchoolUsers(schoolId)
      .then(({ data }) => setUsers(data.users || []))
      .catch((err) => setError(apiError(err, t("settings.usersLoadFailed"))))
      .finally(() => setLoading(false));
  }, [schoolId, t]);

  useEffect(() => { load(); }, [load]);

  async function handleInvite(e) {
    e.preventDefault();
    if (!inviteEmail.trim() || inviteRoles.length === 0) {
      setError(t("settings.inviteInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createSchoolUser(schoolId, { email: inviteEmail.trim(), roles: inviteRoles });
      setNotice(t("settings.invited", { email: inviteEmail.trim() }));
      setInviteEmail("");
      setInviteRoles(["staff"]);
      load();
    } catch (err) {
      setError(apiError(err, t("settings.inviteFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(user, changes) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await updateSchoolUser(schoolId, user._id || user.id, changes);
      setNotice(t("settings.userUpdated", { email: user.email }));
      load();
    } catch (err) {
      setError(apiError(err, t("settings.userUpdateFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card admin-section" aria-labelledby="users-title">
      <div className="card-header"><h2 id="users-title" className="card-title">{t("settings.usersTitle")}</h2></div>
      <div className="card-body">
        <InlineAlert>{error}</InlineAlert>
        <InlineAlert tone="success">{notice}</InlineAlert>

        {canManage && (
          <form onSubmit={handleInvite} aria-label={t("settings.inviteTitle")} style={{ marginBottom: "1rem" }}>
            <div className="admin-grid-2">
              <div className="form-group">
                <label className="form-label" htmlFor="invite-email">{t("settings.inviteEmail")}</label>
                <input id="invite-email" type="email" className="form-input" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              </div>
              <div className="form-group">
                <span className="form-label">{t("settings.roles")}</span>
                <RolePicker value={inviteRoles} onChange={setInviteRoles} idPrefix="invite-role" />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t("settings.inviteBtn")}</button>
          </form>
        )}

        <div className="table-wrap" aria-busy={loading}>
          <table className="data-table" aria-label={t("settings.usersTitle")}>
            <thead>
              <tr>
                <th scope="col">{t("settings.colEmail")}</th>
                <th scope="col">{t("settings.roles")}</th>
                <th scope="col">{t("settings.colStatus")}</th>
                <th scope="col"><span className="sr-only">{t("adminCommon.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="4" className="text-muted">{t("actions.loading")}</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan="4" className="text-muted">{t("settings.usersEmpty")}</td></tr>
              ) : users.map((u) => {
                const id = u._id || u.id;
                return (
                  <tr key={id}>
                    <td>{u.email}</td>
                    <td>
                      <RolePicker
                        value={u.roles || []}
                        disabled={!canManage || busy}
                        idPrefix={`user-${id}-role`}
                        onChange={(roles) => roles.length && handleUpdate(u, { roles })}
                      />
                    </td>
                    <td>
                      <span className={`badge ${u.isActive === false ? "badge-neutral" : "badge-success"}`}>
                        {u.isActive === false ? t("settings.inactive") : t("settings.active")}
                      </span>
                    </td>
                    <td>
                      {canManage && (
                        <button
                          type="button"
                          className={`btn btn-sm ${u.isActive === false ? "btn-secondary" : "btn-danger"}`}
                          disabled={busy}
                          onClick={() => handleUpdate(u, { isActive: u.isActive === false })}
                        >
                          {u.isActive === false ? t("settings.activateBtn") : t("settings.deactivateBtn")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { t } = useTranslation();
  const can = usePermissions();
  const schoolId = useActiveSchoolId();

  return (
    <div className="page-wrap-wide">
      <PageHero title={t("settings.title")} subtitle={t("settings.subtitle")} />
      {!schoolId ? (
        <InlineAlert tone="warning">{t("settings.noSchool")}</InlineAlert>
      ) : (
        <>
          <SchoolProfileSection schoolId={schoolId} canEdit={can("settings.write")} />
          <RuntimeSettingsSection schoolId={schoolId} canEdit={can("settings.write")} />
          <PaymentRulesSection />
          {can("users.read") && <UsersSection schoolId={schoolId} canManage={can("users.manage")} />}
        </>
      )}
    </div>
  );
}
