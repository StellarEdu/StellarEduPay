import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { QRCodeSVG } from "qrcode.react";
import { setupUserMfa, verifyUserMfa } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import PageHero from "../components/PageHero";
import RequireAdmin from "../components/RequireAdmin";

// #1356 — Shown when REQUIRE_MFA=true and the logged-in admin has not yet
// enrolled in MFA. The backend restricts the session to this flow's two
// endpoints until POST /auth/mfa/user/verify succeeds.
function MfaSetupContent() {
  const router = useRouter();
  const [secret, setSecret]     = useState(null);
  const [qrCode, setQrCode]     = useState(null);
  const [code, setCode]         = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setupUserMfa()
      .then(res => {
        setSecret(res.data.secret);
        setQrCode(res.data.qrCode);
      })
      .catch(err => {
        setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to start MFA setup.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await verifyUserMfa({ secret, code: code.trim() });
      router.push("/dashboard");
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Failed to verify MFA code.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-wrap" style={{ maxWidth: 480 }}>
      <PageHero
        eyebrow="Security"
        title="Set up multi-factor authentication"
        subtitle="Your school requires MFA before you can access the dashboard."
      />

      {error && (
        <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : qrCode ? (
        <div className="card">
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <p style={{ fontSize: "0.875rem" }}>
              Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password, …), then enter the 6-digit code it generates.
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <QRCodeSVG value={qrCode} size={180} />
            </div>
            {secret && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "center", fontFamily: "monospace" }}>
                Can&apos;t scan? Enter manually: {secret}
              </p>
            )}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="mfa-code">6-digit code</label>
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  maxLength={6}
                  className="form-input"
                  placeholder="123456"
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={submitting || code.trim().length !== 6}>
                {submitting ? "Verifying…" : "Enable MFA"}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function MfaSetupPage() {
  return (
    <RequireAdmin>
      <MfaSetupContent />
    </RequireAdmin>
  );
}
