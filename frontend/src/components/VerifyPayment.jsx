import { useState, useRef } from "react";
import { verifyPayment } from "../services/api";
import { parseStellarError } from "../utils/stellarErrors";
import { getErrorMessage } from "../utils/errorMessages";

const STATUS_STYLE = {
  valid:     { color: "#166534", bg: "#dcfce7" },
  overpaid:  { color: "#854d0e", bg: "#fef9c3" },
  underpaid: { color: "#991b1b", bg: "#fee2e2" },
  unknown:   { color: "#475569", bg: "#f1f5f9" },
};

export default function VerifyPayment() {
  const [txHash, setTxHash] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError]   = useState("");
  const [stellarStatusUrl, setStellarStatusUrl] = useState(null);
  const [loading, setLoading] = useState(false);
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
        setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Verification failed. Check the transaction hash and try again.");
        setStellarStatusUrl(null);
      }
      errorRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  const st = result?.feeValidation?.status || "unknown";
  const badge = STATUS_STYLE[st] || STATUS_STYLE.unknown;

  return (
    <>
      <style>{`
        .vp-wrap { padding: 2rem 0; }
        .vp-input { width: 100%; padding: 0.65rem 0.85rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; font-family: monospace; background: var(--bg); color: var(--text); outline: none; margin-bottom: 0.75rem; }
        .vp-input:focus { border-color: var(--accent); }
        .vp-card { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-top: 1.5rem; }
        .vp-row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.55rem 0; border-bottom: 1px solid var(--border); font-size: 0.875rem; }
        .vp-row:last-child { border-bottom: none; }
        .vp-row-label { color: var(--muted); flex-shrink: 0; }
        .vp-row-val { text-align: right; word-break: break-all; font-family: monospace; }
      `}</style>

      <div className="vp-wrap">
        <h2 style={{ marginBottom: "0.25rem" }}>Verify Payment</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
          Confirm a payment was recorded by entering its transaction hash.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="txin" style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "0.4rem" }}>
            Transaction Hash
          </label>
          <input id="txin" type="text" placeholder="e.g. 3389e9f0f1a65f19…"
            value={txHash} onChange={e => setTxHash(e.target.value)}
            required className="vp-input"
          />
          <button type="submit" disabled={loading || !txHash.trim()} className="btn-primary" style={{ width: "100%" }}>
            {loading ? "Verifying…" : "Verify Transaction"}
          </button>
        </form>

        {error && (
          <div ref={errorRef} role="alert" tabIndex="-1"
            style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: "0.875rem" }}>
            {error}
            {stellarStatusUrl && (
              <a href={stellarStatusUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "block", marginTop: "0.5rem", color: "#991b1b", fontWeight: 600, textDecoration: "underline" }}>
                Check Stellar Network Status ↗
              </a>
            )}
          </div>
        )}

        {result && (
          <div className="vp-card" role="status">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>Transaction Found</span>
              <span style={{ background: badge.bg, color: badge.color, padding: "0.2rem 0.7rem", borderRadius: 20, fontSize: "0.75rem", fontWeight: 600 }}>
                {st}
              </span>
            </div>

            <div className="vp-row"><span className="vp-row-label">Amount</span><span className="vp-row-val">{result.amount} {result.assetCode || "XLM"}</span></div>
            <div className="vp-row"><span className="vp-row-label">Memo (Student ID)</span><span className="vp-row-val">{result.memo}</span></div>
            <div className="vp-row"><span className="vp-row-label">Date</span><span className="vp-row-val" style={{ fontFamily: "inherit" }}>{result.date ? new Date(result.date).toLocaleString() : "—"}</span></div>
            {result.feeValidation?.message && (
              <div className="vp-row"><span className="vp-row-label">Note</span><span className="vp-row-val" style={{ fontFamily: "inherit", color: badge.color }}>{result.feeValidation.message}</span></div>
            )}
            <div className="vp-row">
              <span className="vp-row-label">Tx Hash</span>
              <span className="vp-row-val" style={{ fontSize: "0.78rem" }}>
                {result.hash}
                {result.stellarExplorerUrl && (
                  <a href={result.stellarExplorerUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", color: "var(--accent)", fontFamily: "inherit", marginTop: "0.25rem" }}>
                    View on Explorer ↗
                  </a>
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
