import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  getFeeAdjustmentRules,
  createFeeAdjustmentRule,
  updateFeeAdjustmentRule,
  deleteFeeAdjustmentRule,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { validateStellarAmount } from "../utils/stellarAmount";
import { IconAlertTriangle, IconCheck } from "../components/Icons";
import PageHero from "../components/PageHero";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";

const RULE_TYPES = [
  { value: "discount_percentage", labelKey: "feeAdjustments.ruleTypeDiscountPct" },
  { value: "discount_fixed",      labelKey: "feeAdjustments.ruleTypeDiscountFixed" },
  { value: "penalty_percentage",  labelKey: "feeAdjustments.ruleTypePenaltyPct" },
  { value: "penalty_fixed",       labelKey: "feeAdjustments.ruleTypePenaltyFixed" },
  { value: "waiver",              labelKey: "feeAdjustments.ruleTypeWaiver" },
];

const EMPTY_FORM = {
  name: "",
  type: "discount_percentage",
  value: "",
  priority: 10,
  description: "",
  isActive: true,
};

/**
 * Fixed-value rule types carry an XLM amount (as opposed to a percentage or a
 * valueless waiver), so they are the ones subject to Stellar stroop precision.
 */
function isFixedAmountType(type) {
  return type === "discount_fixed" || type === "penalty_fixed";
}

function RuleTypePill({ type }) {
  const { t } = useTranslation();
  const match = RULE_TYPES.find(r => r.value === type);
  const label = match?.labelKey ? t(match.labelKey) : type;
  const isDiscount = type.startsWith("discount") || type === "waiver";
  return (
    <span
      className={`badge ${isDiscount ? "badge-success" : "badge-danger"}`}
      style={{ fontSize: "0.7rem", textTransform: "none" }}
    >
      {label}
    </span>
  );
}

export default function FeeAdjustments() {
  const { t } = useTranslation();
  const { schoolId } = useAdminAuthContext();
  const [rules, setRules]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [editId, setEditId]         = useState(null);
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState(null);
  const [formSuccess, setFormSuccess] = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return; // Don't load until we have the authenticated school context
    setLoading(true);
    setError(null);
    getFeeAdjustmentRules(schoolId)
      .then(({ data }) => setRules(data))
      .catch(() => setError(t("feeAdjustments.failedToLoad")))
      .finally(() => setLoading(false));
  }, [schoolId, t]);

  useEffect(() => { load(); }, [load]);

  function startEdit(rule) {
    setEditId(rule._id);
    setForm({
      name: rule.name,
      type: rule.type,
      value: rule.value,
      priority: rule.priority ?? 10,
      description: rule.description || "",
      isActive: rule.isActive,
    });
    setFormError(null);
    setFormSuccess(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormSuccess(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(false);

    // Fixed-value rules are XLM amounts, so they must satisfy the same
    // stroop-precision rules the backend applies (#1123). Validating here means
    // an over-precise or sub-stroop value is caught with a clear message rather
    // than being silently rounded once it reaches the server. Percentage rules
    // are not amounts and keep their own 0–100 bound; waivers carry no value.
    const isFixedAmount = isFixedAmountType(form.type);
    let amountCheck = null;
    if (isFixedAmount) {
      amountCheck = validateStellarAmount(form.value);
      if (!amountCheck.valid) {
        setFormError(amountCheck.error);
        return;
      }
    } else if (form.type !== "waiver") {
      const pct = Number(form.value);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        setFormError(t("feeAdjustments.percentRange"));
        return;
      }
    }

    const payload = {
      ...form,
      // Round-trip fixed amounts through stroop space so the value we send is
      // exactly what the backend will store — never a float artifact.
      value: isFixedAmount ? Number(amountCheck.normalized) : Number(form.value),
      priority: Number(form.priority),
    };
    setSaving(true);
    try {
      if (editId) {
        await updateFeeAdjustmentRule(editId, payload, schoolId);
      } else {
        await createFeeAdjustmentRule(payload, schoolId);
      }
      setFormSuccess(true);
      setTimeout(() => setFormSuccess(false), 3000);
      cancelEdit();
      load();
    } catch (err) {
      setFormError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("feeAdjustments.saveFailed")
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(rule) {
    if (!confirm(t("feeAdjustments.deactivateConfirm", { name: rule.name }))) return;
    try {
      await deleteFeeAdjustmentRule(rule._id, schoolId);
      load();
    } catch {
      setError(t("feeAdjustments.failedToDeactivate"));
    }
  }

  return (
    <>
      <style>{`
        .fa-form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        .fa-form-grid .full { grid-column: 1 / -1; }
        @media (max-width: 560px) {
          .fa-form-grid { grid-template-columns: 1fr; }
          .fa-form-grid .full { grid-column: 1; }
        }
        .fa-priority-hint {
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-top: 0.2rem;
        }
        .fa-checkbox-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          cursor: pointer;
          padding: 0.2rem 0;
        }
        .fa-checkbox-row input[type=checkbox] {
          width: 16px;
          height: 16px;
          accent-color: var(--accent);
          cursor: pointer;
        }
        .fa-actions { display: flex; gap: 0.375rem; justify-content: flex-end; }
      `}</style>

      <div className="page-wrap">
        <PageHero
          eyebrow={t("feeAdjustments.eyebrow")}
          title={t("feeAdjustments.title")}
          subtitle={t("feeAdjustments.subtitle")}
        />

        {/* ── Form ─────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="card-header">
            <div className="card-title">{editId ? t("feeAdjustments.editTitle") : t("feeAdjustments.newTitle")}</div>
            {editId && (
              <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>{t("actions.cancel")}</button>
            )}
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
                <span>{t("feeAdjustments.saved")}</span>
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="fa-form-grid">
                <div className="form-group">
                  <label className="form-label">{t("feeAdjustments.nameLabel")}</label>
                  <input
                    required
                    className="form-input"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t("feeAdjustments.namePlaceholder")}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">{t("feeAdjustments.typeLabel")}</label>
                  <select
                    className="form-input form-select"
                    value={form.type}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                  >
                    {RULE_TYPES.map(rt => (
                      <option key={rt.value} value={rt.value}>{t(rt.labelKey)}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    {t("feeAdjustments.valueLabel")}{form.type === "waiver" ? t("feeAdjustments.valueNa") : " *"}
                  </label>
                  {/*
                    Fixed values are XLM amounts, so they step by one stroop —
                    the browser's own validation then matches the backend's
                    7-decimal precision instead of accepting anything (#1123).
                    Percentages keep a free step but gain a 0–100 bound.
                  */}
                  <input
                    required={form.type !== "waiver"}
                    disabled={form.type === "waiver"}
                    type="number"
                    min="0"
                    step={isFixedAmountType(form.type) ? "0.0000001" : "any"}
                    max={form.type.includes("percentage") ? "100" : undefined}
                    className="form-input"
                    value={form.value}
                    onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                    placeholder={form.type.includes("percentage") ? t("feeAdjustments.percentPlaceholder") : t("feeAdjustments.amountPlaceholder")}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">{t("feeAdjustments.priorityLabel")}</label>
                  <input
                    type="number"
                    min="0"
                    className="form-input"
                    value={form.priority}
                    onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                  />
                  <p className="fa-priority-hint">{t("feeAdjustments.priorityHint")}</p>
                </div>

                <div className="form-group full">
                  <label className="form-label">{t("feeAdjustments.descriptionLabel")}</label>
                  <input
                    className="form-input"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    placeholder={t("feeAdjustments.descriptionPlaceholder")}
                  />
                </div>

                {editId && (
                  <div className="form-group">
                    <label className="fa-checkbox-row">
                      <input
                        type="checkbox"
                        checked={form.isActive}
                        onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))}
                      />
                      {t("feeAdjustments.activeLabel")}
                    </label>
                  </div>
                )}
              </div>

              <div style={{ marginTop: "0.25rem", display: "flex", gap: "0.5rem" }}>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? t("feeAdjustments.saving") : editId ? t("feeAdjustments.update") : t("feeAdjustments.create")}
                </button>
                {editId && (
                  <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                    {t("actions.cancel")}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        {/* ── Rules Table ────────────────────────────── */}
        {error && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <div className="card-title">{t("feeAdjustments.rulesTitle")}</div>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
              {t("feeAdjustments.count", { count: rules.length })}
            </span>
          </div>

          {loading ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("feeAdjustments.colPriority")}</th><th>{t("feeAdjustments.colName")}</th><th>{t("feeAdjustments.colType")}</th><th>{t("feeAdjustments.colValue")}</th>
                    <th>{t("feeAdjustments.colStatus")}</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {[30,140,120,50,60,80].map((w, j) => (
                        <td key={j}><div className="skeleton" style={{ height: 12, width: w }} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : rules.length === 0 ? (
            <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
              <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>{t("feeAdjustments.emptyTitle")}</p>
              <p style={{ fontSize: "0.8125rem" }}>{t("feeAdjustments.emptyHint")}</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t("feeAdjustments.colPriority")}</th>
                    <th scope="col">{t("feeAdjustments.colName")}</th>
                    <th scope="col">{t("feeAdjustments.colType")}</th>
                    <th scope="col">{t("feeAdjustments.colValue")}</th>
                    <th scope="col">{t("feeAdjustments.colStatus")}</th>
                    <th scope="col" style={{ textAlign: "right" }}>{t("feeAdjustments.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(rule => (
                    <tr key={rule._id}>
                      <td style={{ fontVariantNumeric: "tabular-nums", width: 60 }}>
                        <span style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 28, height: 28,
                          borderRadius: "50%",
                          background: "var(--bg-subtle, var(--bg))",
                          border: "1px solid var(--border)",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          color: "var(--text-muted)",
                        }}>
                          {rule.priority ?? 10}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{rule.name}</div>
                        {rule.description && (
                          <div style={{ fontSize: "0.775rem", color: "var(--text-muted)", marginTop: "0.125rem" }}>
                            {rule.description}
                          </div>
                        )}
                      </td>
                      <td><RuleTypePill type={rule.type} /></td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        {rule.type === "waiver" ? "—" : rule.value}
                      </td>
                      <td>
                        <span className={`badge ${rule.isActive ? "badge-success" : "badge-neutral"}`}>
                          {rule.isActive ? t("feeAdjustments.active") : t("feeAdjustments.inactive")}
                        </span>
                      </td>
                      <td>
                        <div className="fa-actions">
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => startEdit(rule)}
                          >
                            {t("actions.edit")}
                          </button>
                          {rule.isActive && (
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => handleDeactivate(rule)}
                            >
                              {t("feeAdjustments.deactivate")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
