import { useState, useEffect, useCallback } from "react";
import {
  getFeeAdjustmentRules,
  createFeeAdjustmentRule,
  updateFeeAdjustmentRule,
  deleteFeeAdjustmentRule,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";

const SCHOOL_ID = process.env.NEXT_PUBLIC_SCHOOL_ID || "SCH001";

const RULE_TYPES = [
  { value: "discount_percentage", label: "Discount %" },
  { value: "discount_fixed",      label: "Discount (fixed)" },
  { value: "penalty_percentage",  label: "Penalty %" },
  { value: "penalty_fixed",       label: "Penalty (fixed)" },
  { value: "waiver",              label: "Full waiver" },
];

const EMPTY_FORM = { name: "", type: "discount_percentage", value: "", priority: 10, description: "", isActive: true };

export default function FeeAdjustments() {
  const [rules, setRules]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [form, setForm]         = useState(EMPTY_FORM);
  const [editId, setEditId]     = useState(null);
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState(null);

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
  }

  function cancelEdit() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    const payload = {
      ...form,
      value: Number(form.value),
      priority: Number(form.priority),
    };
    setSaving(true);
    try {
      if (editId) {
        await updateFeeAdjustmentRule(editId, payload, SCHOOL_ID);
      } else {
        await createFeeAdjustmentRule(payload, SCHOOL_ID);
      }
      cancelEdit();
      load();
    } catch (err) {
      setFormError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Save failed.");
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
        .fa-wrap { max-width: 860px; margin: 0 auto; padding: 2rem 1rem; }
        .fa-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; margin-bottom: 1.5rem; }
        .fa-form { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
        .fa-form label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: var(--muted); }
        .fa-form input, .fa-form select, .fa-form textarea {
          padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
          font-size: 0.9rem; background: var(--bg); color: var(--text);
        }
        .fa-form input:focus, .fa-form select:focus { border-color: var(--accent); outline: none; }
        .fa-form .full { grid-column: 1 / -1; }
        .fa-btn { padding: 0.5rem 1.25rem; border-radius: 6px; border: none; cursor: pointer; font-size: 0.875rem; font-weight: 600; }
        .fa-btn-primary { background: var(--accent); color: #fff; }
        .fa-btn-ghost  { background: transparent; border: 1px solid var(--border); color: var(--text); }
        .fa-btn-danger { background: transparent; border: 1px solid #fecaca; color: #991b1b; }
        .fa-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
        .fa-table th { text-align: left; padding: 0.5rem 0.75rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-bottom: 1px solid var(--border); }
        .fa-table td { padding: 0.75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
        .fa-table tbody tr:last-child td { border-bottom: none; }
        .badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 20px; font-size: 0.72rem; font-weight: 600; }
        .badge-active   { background: #dcfce7; color: #166534; }
        .badge-inactive { background: #f3f4f6; color: #6b7280; }
        .alert-err { background: #fee2e2; border: 1px solid #fecaca; border-radius: 8px; padding: 0.65rem 1rem; color: #991b1b; font-size: 0.875rem; margin-bottom: 1rem; }
        .hint { font-size: 0.78rem; color: var(--muted); margin-top: 0.25rem; }
      `}</style>

      <div className="fa-wrap">
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem" }}>Fee Adjustment Rules</h1>
        <p className="hint" style={{ marginBottom: "1.5rem" }}>
          Rules are applied in ascending priority order (lower number = applied first).
        </p>

        {/* Form */}
        <div className="fa-card">
          <h2 style={{ margin: "0 0 1rem", fontSize: "1rem" }}>
            {editId ? "Edit Rule" : "New Rule"}
          </h2>
          {formError && <div className="alert-err">{formError}</div>}
          <form onSubmit={handleSubmit}>
            <div className="fa-form">
              <label>
                Name *
                <input
                  required
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Early Bird Discount"
                />
              </label>

              <label>
                Type *
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                  {RULE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>

              <label>
                Value *
                <input
                  required
                  type="number"
                  min="0"
                  step="any"
                  value={form.value}
                  onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                  placeholder="e.g. 10"
                />
              </label>

              <label>
                Priority
                <input
                  type="number"
                  min="0"
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                />
                <span className="hint">Lower = applied first (default: 10)</span>
              </label>

              <label className="full">
                Description
                <input
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description"
                />
              </label>

              {editId && (
                <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))}
                  />
                  Active
                </label>
              )}
            </div>

            <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
              <button type="submit" className="fa-btn fa-btn-primary" disabled={saving}>
                {saving ? "Saving…" : editId ? "Update" : "Create"}
              </button>
              {editId && (
                <button type="button" className="fa-btn fa-btn-ghost" onClick={cancelEdit}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Rules table */}
        {error && <div className="alert-err">{error}</div>}
        <div className="fa-card" style={{ padding: 0, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--muted)" }}>Loading…</div>
          ) : rules.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--muted)" }}>No rules yet.</div>
          ) : (
            <table className="fa-table">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rules.map(rule => (
                  <tr key={rule._id}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{rule.priority ?? 10}</td>
                    <td style={{ fontWeight: 500 }}>{rule.name}</td>
                    <td style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                      {RULE_TYPES.find(t => t.value === rule.type)?.label ?? rule.type}
                    </td>
                    <td>{rule.type === "waiver" ? "—" : rule.value}</td>
                    <td>
                      <span className={`badge ${rule.isActive ? "badge-active" : "badge-inactive"}`}>
                        {rule.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                      <button className="fa-btn fa-btn-ghost" style={{ fontSize: "0.8rem", padding: "0.3rem 0.75rem" }} onClick={() => startEdit(rule)}>
                        Edit
                      </button>
                      {rule.isActive && (
                        <button className="fa-btn fa-btn-danger" style={{ fontSize: "0.8rem", padding: "0.3rem 0.75rem" }} onClick={() => handleDeactivate(rule)}>
                          Deactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
