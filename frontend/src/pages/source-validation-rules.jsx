import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  getSourceValidationRules,
  createSourceValidationRule,
  deleteSourceValidationRule,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { IconAlertTriangle, IconCheck } from "../components/Icons";
import PageHero from "../components/PageHero";
import ConfirmationModal from "../components/ConfirmationModal";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";

const EMPTY_FORM = { publicKey: "", label: "" };

// Ed25519 Stellar public keys are 56-char base32 strings starting with "G".
// This mirrors the backend's StrKey.isValidEd25519PublicKey check closely
// enough to give instant feedback; the backend remains the source of truth.
function isLikelyStellarPublicKey(key) {
  return /^G[A-Z2-7]{55}$/.test(key);
}

function truncateKey(key) {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-6)}` : key;
}

export default function SourceValidationRules() {
  const { schoolId } = useAdminAuthContext();
  const { t } = useTranslation();
  const [rules, setRules]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [formError, setFormError]     = useState(null);
  const [formSuccess, setFormSuccess] = useState(false);
  const [pendingDeleteRule, setPendingDeleteRule] = useState(null);
  const [deletingRule, setDeletingRule] = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError(null);
    getSourceValidationRules(schoolId)
      .then(({ data }) => setRules(data))
      .catch(() => setError(t("sourceRules.loadFailed")))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(false);

    const publicKey = form.publicKey.trim();
    if (!isLikelyStellarPublicKey(publicKey)) {
      setFormError(t("sourceRules.invalidKey"));
      return;
    }

    setSaving(true);
    try {
      await createSourceValidationRule(
        {
          name: form.label.trim() || publicKey,
          type: "whitelist",
          value: publicKey,
          description: form.label.trim() || null,
          isActive: true,
        },
        schoolId
      );
      setFormSuccess(true);
      setTimeout(() => setFormSuccess(false), 3000);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setFormError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("sourceRules.saveFailed")
      );
    } finally {
      setSaving(false);
    }
  }

  function handleDelete(rule) {
    setPendingDeleteRule(rule);
  }

  async function confirmDeleteRule() {
    if (!pendingDeleteRule) return;
    setDeletingRule(true);
    try {
      await deleteSourceValidationRule(pendingDeleteRule._id, schoolId);
      setPendingDeleteRule(null);
      load();
    } catch {
      setError(t("sourceRules.removeFailed"));
    } finally {
      setDeletingRule(false);
    }
  }

  return (
    <div className="page-wrap">
      <PageHero
        eyebrow={t("sourceRules.eyebrow")}
        title={t("sourceRules.title")}
        subtitle={t("sourceRules.subtitle")}
      />

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="card-header">
          <div className="card-title">{t("sourceRules.addTitle")}</div>
        </div>
        <div className="card-body">
          {formError && (
            <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
              <IconAlertTriangle size={15} />
              <span>{formError}</span>
            </div>
          )}
          {formSuccess && (
            <div role="status" className="alert alert-success" style={{ marginBottom: "1rem" }}>
              <IconCheck size={15} />
              <span>{t("sourceRules.savedSuccess")}</span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">{t("sourceRules.publicKeyLabel")}</label>
              <input
                required
                className="form-input"
                value={form.publicKey}
                onChange={e => setForm(f => ({ ...f, publicKey: e.target.value }))}
                placeholder={t("sourceRules.publicKeyPlaceholder")}
                style={{ fontFamily: "monospace" }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t("sourceRules.labelLabel")}</label>
              <input
                className="form-input"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder={t("sourceRules.labelPlaceholder")}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t("sourceRules.saving") : t("sourceRules.addRule")}
            </button>
          </form>
        </div>
      </div>

      {error && (
        <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
          <IconAlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div className="card-title">{t("sourceRules.rulesTitle")}</div>
          <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
            {t("sourceRules.ruleCount", { count: rules.length })}
          </span>
        </div>

        {loading ? (
          <div style={{ padding: "1.5rem" }}>{t("sourceRules.loading")}</div>
        ) : rules.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>{t("sourceRules.noRules")}</p>
            <p style={{ fontSize: "0.8125rem" }}>{t("sourceRules.noRulesHint")}</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("sourceRules.colLabel")}</th>
                  <th scope="col">{t("sourceRules.colPublicKey")}</th>
                  <th scope="col">{t("sourceRules.colStatus")}</th>
                  <th scope="col">{t("sourceRules.colLastMatched")}</th>
                  <th scope="col" style={{ textAlign: "right" }}>{t("sourceRules.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map(rule => (
                  <tr key={rule._id}>
                    <td>{rule.name}</td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.8125rem" }}>
                      {truncateKey(rule.value || "")}
                    </td>
                    <td>
                      <span className={`badge ${rule.isActive ? "badge-success" : "badge-neutral"}`}>
                        {rule.isActive ? t("sourceRules.active") : t("sourceRules.inactive")}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                      {rule.lastMatchedAt
                        ? new Date(rule.lastMatchedAt).toLocaleDateString(undefined, { dateStyle: "medium" })
                        : t("sourceRules.never")}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(rule)}>
                        {t("sourceRules.remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pendingDeleteRule && (
        <ConfirmationModal
          title={t("sourceRules.removeTitle")}
          description={t("sourceRules.removeDescription", { name: pendingDeleteRule.name })}
          confirmLabel={deletingRule ? t("sourceRules.removing") : t("sourceRules.remove")}
          cancelLabel={t("actions.cancel")}
          confirmVariant="danger"
          onConfirm={confirmDeleteRule}
          onCancel={() => setPendingDeleteRule(null)}
          loading={deletingRule}
        />
      )}
    </div>
  );
}
