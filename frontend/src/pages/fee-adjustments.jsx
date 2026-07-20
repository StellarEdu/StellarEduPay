import { useState, useEffect, useCallback } from "react";
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

const SCHOOL_ID = process.env.NEXT_PUBLIC_SCHOOL_ID || "SCH001";

const RULE_TYPES = [
  { value: "discount_percentage", label: "Discount %" },
  { value: "discount_fixed",      label: "Discount (fixed XLM)" },
  { value: "penalty_percentage",  label: "Penalty %" },
  { value: "penalty_fixed",       label: "Penalty (fixed XLM)" },
  { value: "waiver",              label: "Full waiver" },
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
  const t = RULE_TYPES.find(r => r.value === type);
  const label = t?.label ?? type;
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
  const [rules, setRules]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [editId, setEditId]         = useState(null);
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState(null);
  const [formSuccess, setFormSuccess] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getFeeAdjustmentRules(SCHOOL_ID)
      .then(({ data }) => setRules(data))
      .catch(() => setError("Could not load rules."))
      .finally(() => setLoading(false));
  }, []);

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
        setFormError("Percentage must be greater than 0 and at most 100");
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
        await updateFeeAdjustmentRule(editId, payload, SCHOOL_ID);
      } else {
        await createFeeAdjustmentRule(payload, SCHOOL_ID);
      }
      setFormSuccess(true);
      setTimeout(() => setFormSuccess(false), 3000);
      cancelEdit();
      load();
    } catch (err) {
      setFormError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Save failed."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(rule) {
    if (!confirm(`Deactivate "${rule.name}"?`)) return;
    try {
      await deleteFeeAdjustmentRule(rule._id, SCHOOL_ID);
      load();
    } catch {
      setError("Could not deactivate rule.");
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
          eyebrow="Configuration"
          title="Fee Adjustment Rules"
          subtitle="Discounts, penalties and waivers — applied in ascending priority order (lower number first)."
        />

        {/* ── Form ─────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="card-header">
            <div className="card-title">{editId ? "Edit Rule" : "New Rule"}</div>
            {editId && (
              <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>Cancel</button>
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
                <span>Rule saved successfully.</span>
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="fa-form-grid">
                <div className="form-group">
                  <label className="form-label">Name *</label>
                  <input
                    required
                    className="form-input"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Early Bird Discount"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Type *</label>
                  <select
                    className="form-input form-select"
                    value={form.type}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                  >
                    {RULE_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Value{form.type === "waiver" ? " (N/A)" : " *"}
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
                    placeholder={form.type.includes("percentage") ? "e.g. 10" : "e.g. 50"}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Priority</label>
                  <input
                    type="number"
                    min="0"
                    className="form-input"
                    value={form.priority}
                    onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                  />
                  <p className="fa-priority-hint">Lower number = applied first (default: 10)</p>
                </div>

                <div className="form-group full">
                  <label className="form-label">Description</label>
                  <input
                    className="form-input"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="Optional — visible to admins only"
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
                      Rule is active
                    </label>
                  </div>
                )}
              </div>

              <div style={{ marginTop: "0.25rem", display: "flex", gap: "0.5rem" }}>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "Saving…" : editId ? "Update Rule" : "Create Rule"}
                </button>
                {editId && (
                  <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                    Cancel
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
            <div className="card-title">Rules</div>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
              {rules.length} rule{rules.length !== 1 ? "s" : ""}
            </span>
          </div>

          {loading ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Priority</th><th>Name</th><th>Type</th><th>Value</th>
                    <th>Status</th><th></th>
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
              <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>No rules yet</p>
              <p style={{ fontSize: "0.8125rem" }}>Create a rule above to get started.</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Priority</th>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Value</th>
                    <th scope="col">Status</th>
                    <th scope="col" style={{ textAlign: "right" }}>Actions</th>
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
                          {rule.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <div className="fa-actions">
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => startEdit(rule)}
                          >
                            Edit
                          </button>
                          {rule.isActive && (
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => handleDeactivate(rule)}
                            >
                              Deactivate
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
