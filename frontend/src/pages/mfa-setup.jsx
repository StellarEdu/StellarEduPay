import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { QRCodeSVG } from "qrcode.react";
import { setupUserMfa, verifyUserMfa } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import PageHero from "../components/PageHero";
import RequireAdmin from "../components/RequireAdmin";
import { useTranslation } from "react-i18next";

// #1356 — Shown when REQUIRE_MFA=true and the logged-in admin has not yet
// enrolled in MFA. The backend restricts the session to this flow's two
// endpoints until POST /auth/mfa/user/verify succeeds.
function MfaSetupContent() {
  const router = useRouter();
  const { t } = useTranslation();
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
        setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("mfa.failedToStart"));
      })
      .finally(() => setLoading(false));
  }, [t]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await verifyUserMfa({ secret, code: code.trim() });
      router.push("/dashboard");
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || t("mfa.failedToVerify"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-wrap" style={{ maxWidth: 480 }}>
      <PageHero
        eyebrow={t("mfa.eyebrow")}
        title={t("mfa.title")}
        subtitle={t("mfa.subtitle")}
      />

      {error && (
        <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {loading ? (
        <p>{t("mfa.loading")}</p>
      ) : qrCode ? (
        <div className="card">
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <p style={{ fontSize: "0.875rem" }}>
              {t("mfa.scanInstructions")}
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <QRCodeSVG value={qrCode} size={180} />
            </div>
            {secret && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "center", fontFamily: "monospace" }}>
                {t("mfa.cantScan", { secret })}
              </p>
            )}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="mfa-code">{t("mfa.codeLabel")}</label>
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  maxLength={6}
                  className="form-input"
                  placeholder={t("mfa.codePlaceholder")}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={submitting || code.trim().length !== 6}>
                {submitting ? t("mfa.verifying") : t("mfa.enableMfa")}
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
