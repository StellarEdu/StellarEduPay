import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { verifyPayment } from "../services/api";
import { parseStellarError } from "../utils/stellarErrors";
import { getErrorMessage } from "../utils/errorMessages";
import { IconAlertTriangle, IconCheck, IconExternalLink, IconShield } from "./Icons";

const STATUS_BADGE = {
  valid:     { cls: "badge badge-success", key: "status.validation.valid" },
  overpaid:  { cls: "badge badge-warning", key: "status.validation.overpaid" },
  underpaid: { cls: "badge badge-danger",  key: "status.validation.underpaid" },
  unknown:   { cls: "badge badge-neutral", key: "status.validation.unknown" },
};

function InfoRow({ label, children, mono }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      padding: "0.625rem 0",
      borderBottom: "1px solid var(--border)",
      gap: "0.5rem",
    }}>
      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <span style={{
        fontWeight: 600,
        textAlign: "right",
        wordBreak: "break-all",
        fontFamily: mono ? "monospace" : "inherit",
        fontSize: mono ? "0.8rem" : "inherit",
      }}>
        {children}
      </span>
    </div>
  );
}

export default function VerifyPayment() {
  const { t } = useTranslation();
  const [txHash, setTxHash]               = useState("");
  const [result, setResult]               = useState(null);
  const [error, setError]                 = useState("");
  const [stellarStatusUrl, setStellarStatusUrl] = useState(null);
  const [loading, setLoading]             = useState(false);
  const errorRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(""); setResult(null); setStellarStatusUrl(null); setLoading(true);
    try {
      const res = await verifyPayment(txHash.trim());
      setResult(res.data);
    } catch (err) {
      const stellar = parseStellarError(err);
      if (stellar) {
        setError(stellar.message);
        setStellarStatusUrl(stellar.stellarStatusUrl);
      } else {
        setError(
          getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
          t("verifyPayment.verificationFailed")
        );
        setStellarStatusUrl(null);
      }
      errorRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  const st = result?.feeValidation?.status || "unknown";
  const badge = STATUS_BADGE[st] || STATUS_BADGE.unknown;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconShield size={15} /> {t("verifyPayment.title")}
        </div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
          {t("verifyPayment.intro")}
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="txin" className="form-label">{t("verifyPayment.txHashLabel")}</label>
            <input
              id="txin"
              type="text"
              placeholder={t("verifyPayment.txHashPlaceholder")}
              value={txHash}
              onChange={e => setTxHash(e.target.value)}
              required
              className="form-input"
              style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
            />
          </div>
          <button
            type="submit"
            disabled={loading || !txHash.trim()}
            className="btn btn-dark"
            style={{ width: "100%" }}
          >
            {loading ? t("verifyPayment.verifying") : t("verifyPayment.submit")}
          </button>
        </form>

        {error && (
          <div ref={errorRef} role="alert" tabIndex="-1" className="alert alert-danger" style={{ marginTop: "1rem" }}>
            <IconAlertTriangle size={15} />
            <div>
              <span>{error}</span>
              {stellarStatusUrl && (
                <a
                  href={stellarStatusUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "block", marginTop: "0.375rem", color: "inherit", fontWeight: 600, textDecoration: "underline" }}
                >
                  {t("verifyPayment.checkNetworkStatus")}
                </a>
              )}
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginTop: "1.25rem" }} role="status">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <IconCheck size={15} style={{ color: "var(--success-text)" }} />
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t("verifyPayment.transactionFound")}</span>
              </div>
              <span className={badge.cls}>{t(badge.key)}</span>
            </div>

            <InfoRow label={t("verifyPayment.amount")}>
              {result.amount}{" "}
              <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>
                {result.assetCode || "XLM"}
              </span>
            </InfoRow>
            <InfoRow label={t("verifyPayment.memoLabel")} mono>{result.memo}</InfoRow>
            <InfoRow label={t("verifyPayment.date")}>
              {result.date ? new Date(result.date).toLocaleString() : "—"}
            </InfoRow>
            {result.feeValidation?.message && (
              <InfoRow label={t("verifyPayment.note")}>
                <span style={{ color: st === "valid" ? "var(--success-text)" : "var(--warning-text)" }}>
                  {result.feeValidation.message}
                </span>
              </InfoRow>
            )}
            <div style={{ padding: "0.625rem 0" }}>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>{t("verifyPayment.txHash")}</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.78rem", wordBreak: "break-all", color: "var(--text)" }}>
                {result.hash}
              </div>
              {result.stellarExplorerUrl && (
                <a
                  href={result.stellarExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", marginTop: "0.5rem", color: "var(--accent)", fontSize: "0.8125rem", fontWeight: 600 }}
                >
                  {t("verifyPayment.viewExplorer")} <IconExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
