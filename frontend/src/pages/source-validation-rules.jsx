import { useState, useEffect, useCallback } from "react";
import {
  getSourceValidationRules,
  createSourceValidationRule,
  deleteSourceValidationRule,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { IconAlertTriangle, IconCheck } from "../components/Icons";
import PageHero from "../components/PageHero";
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
  const [rules, setRules]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [formError, setFormError]     = useState(null);
  const [formSuccess, setFormSuccess] = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError(null);
    getSourceValidationRules(schoolId)
      .then(({ data }) => setRules(data))
      .catch(() => setError("Could not load source validation rules."))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(false);

    const publicKey = form.publicKey.trim();
    if (!isLikelyStellarPublicKey(publicKey)) {
      setFormError("Enter a valid Stellar public key (56 characters, starting with \"G\").");
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
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Save failed."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(rule) {
    if (!confirm(`Remove trusted sender "${rule.name}"?`)) return;
    try {
      await deleteSourceValidationRule(rule._id, schoolId);
      load();
    } catch {
      setError("Could not remove rule.");
    }
  }

  return (
    <div className="page-wrap">
      <PageHero
        eyebrow="Security"
        title="Source Validation Rules"
        subtitle="Allowlist trusted parent/sender Stellar addresses. Payments from unmatched senders are still accepted, but only allowlisted addresses match a rule here."
      />

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="card-header">
          <div className="card-title">Add Trusted Sender</div>
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
            <div className="form-group">
              <label className="form-label">Stellar Public Key *</label>
              <input
                required
                className="form-input"
                value={form.publicKey}
                onChange={e => setForm(f => ({ ...f, publicKey: e.target.value }))}
                placeholder="G..."
                style={{ fontFamily: "monospace" }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Label (optional)</label>
              <input
                className="form-input"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Jane Doe (parent)"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Add Rule"}
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
          <div className="card-title">Rules</div>
          <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
            {rules.length} rule{rules.length !== 1 ? "s" : ""}
          </span>
        </div>

        {loading ? (
          <div style={{ padding: "1.5rem" }}>Loading…</div>
        ) : rules.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            <p style={{ fontWeight: 500, marginBottom: "0.25rem" }}>No rules yet</p>
            <p style={{ fontSize: "0.8125rem" }}>Add a trusted sender above to get started.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Public Key</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last Matched</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
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
                        {rule.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                      {rule.lastMatchedAt
                        ? new Date(rule.lastMatchedAt).toLocaleDateString(undefined, { dateStyle: "medium" })
                        : "Never"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(rule)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
