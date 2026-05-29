import { useState, useRef, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { generateStellarPaymentUri } from "../utils/stellarUri";
import { getStudent, getPaymentInstructions, getStudentPayments } from "../services/api";
import DisputeForm from "./DisputeForm";
import { getErrorMessage } from "../utils/errorMessages";

const STATUS_STYLE = {
  valid:     { color: "#166534", bg: "#dcfce7" },
  overpaid:  { color: "#854d0e", bg: "#fef9c3" },
  underpaid: { color: "#991b1b", bg: "#fee2e2" },
  unknown:   { color: "#475569", bg: "#f1f5f9" },
};

export default function PaymentForm() {
  const [studentId, setStudentId]     = useState("");
  const [student, setStudent]         = useState(null);
  const [instructions, setInstructions] = useState(null);
  const [payments, setPayments]       = useState(null);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [error, setError]             = useState("");
  const [loading, setLoading]         = useState(false);
  const [copied, setCopied]           = useState(null);
  const [disputingTx, setDisputingTx] = useState(null); // txHash currently being disputed
  const [disputedTxs, setDisputedTxs] = useState(new Set()); // txHashes with open disputes
  const errorRef = useRef(null);
  const debounceRef = useRef(null);

  function handleStudentIdChange(e) {
    const value = e.target.value;
    setStudentId(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const lookupStudent = useCallback(async (id) => {
    if (!id.trim()) return;
    setError(""); setStudent(null); setInstructions(null); setPayments(null);
    setLoading(true);
    setPaymentsLoading(true);
    try {
      const [stuRes, instrRes, payRes] = await Promise.all([
        getStudent(id),
        getPaymentInstructions(id),
        getStudentPayments(id),
      ]);
      setStudent(stuRes.data);
      setInstructions(instrRes.data);
      setPayments(payRes.data?.payments ?? payRes.data ?? []);
    } catch (err) {
      setError(getErrorMessage(err.response?.data?.code, err.response?.data?.error) || "Student not found. Please check the ID and try again.");
      errorRef.current?.focus();
    } finally {
      setLoading(false);
      setPaymentsLoading(false);
    }
  }, []);

  async function copy(text, key) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  const isTestnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "testnet";

  return (
    <>
      <style>{`
        .pf-wrap { padding: 2rem 0; }
        .pf-card { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.75rem; margin-top: 1.5rem; }
        .pf-label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.4rem; display: block; }
        .pf-field { display: flex; gap: 0.5rem; align-items: center; }
        .pf-code { flex: 1; background: var(--border); border-radius: 6px; padding: 0.6rem 0.75rem; font-family: monospace; font-size: 0.85rem; word-break: break-all; color: var(--text); }
        .pf-copy { padding: 0.5rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; font-size: 0.8rem; white-space: nowrap; transition: background 0.15s; }
        .pf-copy:hover { background: var(--border); }
        .pf-input { width: 100%; padding: 0.65rem 0.85rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.95rem; background: var(--bg); color: var(--text); outline: none; margin-bottom: 0.75rem; }
        .pf-input:focus { border-color: var(--accent); }
        .pf-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
        .pf-row:last-child { border-bottom: none; }
        .pf-row-label { color: var(--muted); }
        .pf-hist-item { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; font-size: 0.875rem; }
        .pf-skeleton { height: 1rem; background: var(--border); border-radius: 4px; animation: pf-pulse 1.5s infinite; }
        @keyframes pf-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      <div className="pf-wrap">
        <h2 style={{ marginBottom: "0.25rem" }}>Pay School Fees</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
          Enter your student ID to get payment instructions.
        </p>

        <form onSubmit={(e) => { e.preventDefault(); lookupStudent(studentId); }}>
          <label htmlFor="sid" className="pf-label">Student ID</label>
          <input
            id="sid" type="text" placeholder="e.g. STU001"
            value={studentId}
            onChange={(e) => {
              handleStudentIdChange(e);
              const val = e.target.value;
              debounceRef.current = setTimeout(() => lookupStudent(val), 400);
            }}
            required className="pf-input"
          />
          <button type="submit" disabled={loading} className="btn-primary" style={{ width: "100%" }}>
            {loading ? "Loading…" : "Get Payment Instructions"}
          </button>
        </form>

        {error && (
          <div ref={errorRef} role="alert" tabIndex="-1"
            style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: "0.875rem" }}>
            {error}
          </div>
        )}

        {student && instructions && (
          <div className="pf-card">
            {isTestnet && (
              <div style={{ background: "#fef9c3", border: "1px solid #fde68a", borderRadius: 6, padding: "0.6rem 0.9rem", fontSize: "0.8rem", color: "#854d0e", marginBottom: "1.25rem" }}>
                ⚠️ Testnet mode — do not send real funds.
              </div>
            )}

            <div className="pf-row"><span className="pf-row-label">Student</span><strong>{student.name}</strong></div>
            <div className="pf-row"><span className="pf-row-label">Class</span><span>{student.class}</span></div>
            <div className="pf-row"><span className="pf-row-label">Fee</span><strong>{instructions.feeAmount ?? student.feeAmount} XLM</strong></div>
            <div className="pf-row" style={{ marginBottom: "1.25rem" }}>
              <span className="pf-row-label">Status</span>
              <span style={{ fontWeight: 600, color: student.feePaid ? "#166534" : "#991b1b" }}>
                {student.feePaid ? "Paid" : "Unpaid"}
              </span>
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <span className="pf-label">Wallet Address</span>
              <div className="pf-field">
                <span className="pf-code">{instructions.walletAddress}</span>
                <button className="pf-copy" onClick={() => copy(instructions.walletAddress, "wallet")}>
                  {copied === "wallet" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            <div>
              <span className="pf-label">Memo (required)</span>
              <div className="pf-field">
                <span className="pf-code">{instructions.memo}</span>
                <button className="pf-copy" onClick={() => copy(instructions.memo, "memo")}>
                  {copied === "memo" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            {/* QR code for mobile wallet scanning (SEP-0007 URI) */}
            {instructions.walletAddress && instructions.memo && (() => {
              // Pick the first non-XLM asset from acceptedAssets so the QR URI
              // includes asset_code and asset_issuer for USDC payments.
              // If only XLM is accepted, assetCode stays undefined (defaults to XLM).
              const nonNative = instructions.acceptedAssets?.find(
                a => a.code !== 'XLM' && a.type !== 'native'
              );
              return (
                <div style={{ marginTop: "1.25rem", textAlign: "center" }}>
                  <span className="pf-label" style={{ display: "block", marginBottom: "0.6rem" }}>Scan with Stellar Wallet</span>
                  <QRCodeSVG
                    value={generateStellarPaymentUri({
                      destination: instructions.walletAddress,
                      amount: instructions.feeAmount ?? student.feeAmount ?? 0,
                      memo: instructions.memo,
                      assetCode: nonNative?.code,
                      assetIssuer: nonNative?.issuer,
                    })}
                    size={160}
                    role="img"
                    aria-label={`QR code for Stellar payment address: ${instructions.walletAddress}`}
                  />
                  <p style={{ marginTop: "0.75rem", fontSize: "0.8rem", color: "var(--muted)" }}>
                    If you cannot scan the QR code, use the address and memo below:
                  </p>
                  <div style={{ textAlign: "left", marginTop: "0.5rem" }}>
                    <div style={{ marginBottom: "0.4rem" }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Address</span>
                      <p style={{ fontFamily: "monospace", fontSize: "0.82rem", wordBreak: "break-all", userSelect: "text", margin: "0.2rem 0 0" }}>
                        {instructions.walletAddress}
                      </p>
                    </div>
                    <div>
                      <span style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Memo</span>
                      <p style={{ fontFamily: "monospace", fontSize: "0.82rem", userSelect: "text", margin: "0.2rem 0 0" }}>
                        {instructions.memo}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {instructions.acceptedAssets?.length > 0 && (
              <p style={{ marginTop: "1rem", fontSize: "0.8rem", color: "var(--muted)" }}>
                Accepted: {instructions.acceptedAssets.map(a => a.displayName).join(", ")}
              </p>
            )}
          </div>
        )}

        {(payments !== null || paymentsLoading) && (
          <div style={{ marginTop: "2rem" }} aria-busy={paymentsLoading}>
            <h3 style={{ marginBottom: "1rem", fontSize: "1rem" }}>Payment History</h3>
            {paymentsLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="pf-hist-item">
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.6rem" }}>
                    <div className="pf-skeleton" style={{ width: "80px" }} />
                    <div className="pf-skeleton" style={{ width: "55px" }} />
                  </div>
                  <div className="pf-skeleton" style={{ width: "100%" }} />
                </div>
              ))
            ) : payments.length === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>No payments recorded yet.</p>
            ) : payments.map((p, i) => {
              const st = p.feeValidationStatus || "unknown";
              const badge = STATUS_STYLE[st] || STATUS_STYLE.unknown;
              const canDispute = st === "valid" || st === "overpaid";
              const alreadyDisputed = disputedTxs.has(p.txHash);
              return (
                <div key={p.txHash || i} className="pf-hist-item">
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                    <strong>{p.amount} {p.assetCode || "XLM"}</strong>
                    <span style={{ ...badge, padding: "0.15rem 0.6rem", borderRadius: 20, fontSize: "0.75rem", fontWeight: 600 }}>{st}</span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: "0.8rem", fontFamily: "monospace" }}>{p.txHash}</div>
                  {p.confirmedAt && <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: "0.25rem" }}>{new Date(p.confirmedAt).toLocaleString()}</div>}

                  {canDispute && (
                    alreadyDisputed ? (
                      <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#854d0e", background: "#fef9c3", padding: "0.25rem 0.6rem", borderRadius: 4, display: "inline-block" }}>
                        Dispute submitted
                      </div>
                    ) : (
                      disputingTx === p.txHash ? (
                        <div style={{ marginTop: "0.75rem" }}>
                          <DisputeForm
                            txHash={p.txHash}
                            studentId={studentId}
                            onSuccess={(dispute) => {
                              setDisputedTxs((prev) => new Set([...prev, p.txHash]));
                              setDisputingTx(null);
                            }}
                            onCancel={() => setDisputingTx(null)}
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => setDisputingTx(p.txHash)}
                          style={{ marginTop: "0.5rem", padding: "0.25rem 0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: "0.75rem" }}
                        >
                          Raise Dispute
                        </button>
                      )
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
