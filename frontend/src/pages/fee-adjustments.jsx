import { useState, useEffect, useCallback } from "react";
import {
  getFeeAdjustmentRules,
  createFeeAdjustmentRule,
  updateFeeAdjustmentRule,
  deleteFeeAdjustmentRule,
  getFeeAdjustmentAffectedCount,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { validateStellarAmount } from "../utils/stellarAmount";
import { IconAlertTriangle, IconCheck } from "../components/Icons";
import PageHero from "../components/PageHero";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";

const RULE_TYPES = [
  { value: "discount_percentage", label: "Discount %" },
  { value: "discount_fixed",      label: "Discount (fixed XLM)" },
  { value: "penalty_percentage",  label: "Penalty %" },
  { value: "penalty_fixed",       label: "Penalty (fixed XLM)" },
  { value: "waiver",              label: "Full waiver" },
];

const CONFLICT_POLICIES = [
  { value: "stack",             label: "Stack (apply all matching rules)" },
  { value: "first_only",        label: "First only (highest priority wins)" },
  { value: "best_for_student",  label: "Best for student (largest discount wins)" },
];

const EMPTY_FORM = {
  name: "",
  type: "discount_percentage",
  value: "",
  priority: 10,
  conflictResolutionPolicy: "stack",
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

function ConflictPolicyPill({ policy }) {
  const p = CONFLICT_POLICIES.find(c => c.value === (policy || "stack"));
  return (
    <span
      className="badge badge-neutral"
      style={{ fontSize: "0.7rem", textTransform: "none" }}
      title="Only takes effect when this is the highest-priority rule matching a given student alongside other matching rules"
    >
      {p ? p.label.split(" (")[0] : (policy || "stack")}
    </span>
  );
}

export default function FeeAdjustments() {
  const { schoolId } = useAdminAuthContext();
  const [rules, setRules]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [editId, setEditId]         = useState(null);
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState(null);
  const [formSuccess, setFormSuccess] = useState(false);
  const [deleteTarget, setDeleteTarget]     = useState(null); // rule pending confirmation
  const [affectedCount, setAffectedCount]   = useState(null);
  const [deleteReason, setDeleteReason]     = useState("");
  const [deleteError, setDeleteError]       = useState(null);
  const [deleting, setDeleting]             = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return; // Don't load until we have the authenticated school context
    setLoading(true);
    setError(null);
    getFeeAdjustmentRules(schoolId)
      .then(({ data }) => setRules(data))
      .catch(() => setError("Could not load rules."))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  function startEdit(rule) {
    setEditId(rule._id);
    setForm({
      name: rule.name,
      type: rule.type,
      value: rule.value,
      priority: rule.priority ?? 10,
      conflictResolutionPolicy: rule.conflictResolutionPolicy || "stack",
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
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Save failed."
      );
    } finally {
      setSaving(false);
    }
  }

  function handleDeactivate(rule) {
    setDeleteTarget(rule);
    setDeleteReason("");
    setDeleteError(null);
    setAffectedCount(null);
    getFeeAdjustmentAffectedCount(rule._id, schoolId)
      .then(({ data }) => setAffectedCount(data.affectedCount))
      .catch(() => setAffectedCount(null));
  }

  function cancelDeactivate() {
    setDeleteTarget(null);
    setDeleteReason("");
    setDeleteError(null);
    setAffectedCount(null);
  }

  async function confirmDeactivate() {
    if (!deleteReason.trim()) {
      setDeleteError("A reason is required to deactivate this rule.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteFeeAdjustmentRule(deleteTarget._id, schoolId, deleteReason.trim());
      cancelDeactivate();
      load();
    } catch (err) {
      setDeleteError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Could not deactivate rule."
      );
    } finally {
      setDeleting(false);
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

                <div className="form-group">
                  <label className="form-label">When rules overlap</label>
                  <select
                    className="form-input form-select"
                    value={form.conflictResolutionPolicy}
                    onChange={e => setForm(f => ({ ...f, conflictResolutionPolicy: e.target.value }))}
                  >
                    {CONFLICT_POLICIES.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                  <p className="fa-priority-hint">
                    Only matters if this ends up the highest-priority rule matching a
                    student alongside others — see "How overlapping rules resolve" below.
                  </p>
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

        {/* ── How overlapping rules resolve ───────────── */}
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="card-header">
            <div className="card-title">How overlapping rules resolve</div>
          </div>
          <div className="card-body" style={{ fontSize: "0.85rem", lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              When more than one active rule matches the same student, they run in{" "}
              <strong>ascending priority order — lowest number first</strong> (ties broken
              alphabetically by name). Each rule adjusts the fee <em>left by the rule before
              it</em>, not the original fee — so for percentage rules, priority order changes
              the final amount.
            </p>
            <p>
              What happens to the rest of the matches is set by the{" "}
              <strong>"When rules overlap"</strong> field on whichever matching rule has the
              lowest priority number:
            </p>
            <ul style={{ margin: "0.25rem 0 0.75rem", paddingLeft: "1.25rem" }}>
              <li><strong>Stack</strong> — every matching rule applies, in priority order.</li>
              <li><strong>First only</strong> — only that top rule applies; other matches are ignored.</li>
              <li><strong>Best for student</strong> — among matching <em>discounts</em>, only the one
                that saves the most applies; matching <em>penalties</em> always stack regardless.</li>
            </ul>
            <p style={{
              margin: 0, padding: "0.6rem 0.75rem", borderRadius: 6,
              background: "var(--bg-subtle, var(--bg))", border: "1px solid var(--border)",
            }}>
              <strong>Example:</strong> a ₦10,000 fee with a 15% scholarship (priority 5) and a
              flat ₦800 late surcharge (priority 20), policy "Stack": the scholarship runs
              first (10,000 → 8,500), then the surcharge adds on top of that (8,500 → final{" "}
              <strong>₦9,300</strong>). Swap the two priorities instead and the surcharge would
              apply to the full 10,000 first (→ 10,800), then the 15% would come off that
              larger number (→ final <strong>₦9,180</strong>) — a different final fee from the
              exact same two rules and values, purely from priority order.
            </p>
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
                    <th>When overlapping</th><th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {[30,140,120,50,90,60,80].map((w, j) => (
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
                    <th scope="col">When overlapping</th>
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
                      <td><ConflictPolicyPill policy={rule.conflictResolutionPolicy} /></td>
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

        {deleteTarget && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="fa-delete-title"
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
            }}
          >
            <div className="card" style={{ maxWidth: 440, width: "90%" }}>
              <div className="card-header">
                <div className="card-title" id="fa-delete-title">Deactivate rule?</div>
              </div>
              <div className="card-body">
                <p style={{ marginBottom: "0.75rem" }}>
                  This will deactivate <strong>&quot;{deleteTarget.name}&quot;</strong>. It will
                  no longer be applied to future payment verifications.
                </p>
                <p style={{ marginBottom: "1rem", fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  {affectedCount === null
                    ? "Checking how many students this rule currently applies to…"
                    : `This rule currently applies to ${affectedCount} student${affectedCount !== 1 ? "s" : ""}.`}
                </p>

                {deleteError && (
                  <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
                    <IconAlertTriangle size={15} />
                    <span>{deleteError}</span>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label" htmlFor="fa-delete-reason">Reason *</label>
                  <input
                    id="fa-delete-reason"
                    className="form-input"
                    value={deleteReason}
                    onChange={e => setDeleteReason(e.target.value)}
                    placeholder="Why is this rule being deactivated?"
                    autoFocus
                  />
                </div>

                <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                  <button className="btn btn-ghost" onClick={cancelDeactivate} disabled={deleting}>
                    Cancel
                  </button>
                  <button className="btn btn-danger" onClick={confirmDeactivate} disabled={deleting}>
                    {deleting ? "Deactivating…" : "Deactivate Rule"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
