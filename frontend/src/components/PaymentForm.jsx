import { useState, useRef, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { generateStellarPaymentUri } from "../utils/stellarUri";
import { getStudent, getPaymentInstructions, getStudentPayments, getStudentBalance } from "../services/api";
import DisputeForm from "./DisputeForm";
import { getErrorMessage } from "../utils/errorMessages";
import { IconCopy, IconCheck, IconAlertTriangle, IconSearch, IconDownload } from "./Icons";

const STATUS_BADGE = {
  valid:     { cls: "badge badge-success", label: "Valid" },
  overpaid:  { cls: "badge badge-warning", label: "Overpaid" },
  underpaid: { cls: "badge badge-danger",  label: "Underpaid" },
  unknown:   { cls: "badge badge-neutral", label: "Unknown" },
};

function CopyButton({ text, copyKey, copied, onCopy }) {
  const isCopied = copied === copyKey;
  return (
    <button
      onClick={() => onCopy(text, copyKey)}
      className="btn btn-sm btn-ghost"
      aria-label={isCopied ? "Copied" : "Copy to clipboard"}
      style={{ flexShrink: 0, gap: "0.3rem" }}
    >
      {isCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {isCopied ? "Copied!" : "Copy"}
    </button>
  );
}

function InfoRow({ label, children }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "0.625rem 0",
      borderBottom: "1px solid var(--border)",
      gap: "0.5rem",
      flexWrap: "wrap",
    }}>
      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <div style={{ fontWeight: 600, textAlign: "right" }}>{children}</div>
    </div>
  );
}

export default function PaymentForm() {
  const [studentId, setStudentId]             = useState("");
  const [student, setStudent]                 = useState(null);
  const [instructions, setInstructions]       = useState(null);
  const [payments, setPayments]               = useState(null);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [error, setError]                     = useState("");
  const [loading, setLoading]                 = useState(false);
  const [copied, setCopied]                   = useState(null);
  const [hasDeletedPayments, setHasDeletedPayments] = useState(false);
  const [disputingTx, setDisputingTx]         = useState(null);
  const [disputedTxs, setDisputedTxs]         = useState(new Set());
  const errorRef  = useRef(null);
  const debounceRef = useRef(null);
  const qrWrapperRef = useRef(null);

  function handleStudentIdChange(e) {
    const value = e.target.value;
    setStudentId(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const lookupStudent = useCallback(async (id) => {
    if (!id.trim()) return;
    setError("");
    setStudent(null);
    setInstructions(null);
    setPayments(null);
    setHasDeletedPayments(false);
    setLoading(true);
    setPaymentsLoading(true);
    try {
      const [stuRes, instrRes, payRes, balRes] = await Promise.all([
        getStudent(id),
        getPaymentInstructions(id),
        getStudentPayments(id),
        getStudentBalance(id).catch(() => null),
      ]);
      setStudent(stuRes.data);
      setInstructions(instrRes.data);
      setPayments(payRes.data?.payments ?? payRes.data ?? []);
      setHasDeletedPayments(balRes?.data?.hasDeletedPayments === true);
    } catch (err) {
      setError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
        "Student not found. Please check the ID and try again."
      );
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

  async function downloadQr(filename) {
    const svgEl = qrWrapperRef.current?.querySelector("svg");
    if (!svgEl) return;

    const svgData = new XMLSerializer().serializeToString(svgEl);
    const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const padding = 16;
      const canvas = document.createElement("canvas");
      canvas.width  = img.width  + padding * 2;
      canvas.height = img.height + padding * 2;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, padding, padding);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = url;
  }

  const isTestnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "testnet";

  return (
    <>
      

      <div className="card pf-wrap">
        <div className="card-header">
          <div className="card-title">Pay School Fees</div>
          {isTestnet && (
            <span className="badge badge-warning" style={{ fontSize: "0.68rem" }}>Testnet</span>
          )}
        </div>
        <div className="card-body">
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
            Enter your student ID to get payment instructions.
          </p>

          <form onSubmit={(e) => { e.preventDefault(); lookupStudent(studentId); }}>
            <label className="pf-section-label" htmlFor="sid">Student ID</label>
            <div className="pf-id-input-wrap">
              <span className="pf-search-icon"><IconSearch size={15} /></span>
              <input
                id="sid"
                type="text"
                placeholder="e.g. STU001"
                value={studentId}
                onChange={(e) => {
                  handleStudentIdChange(e);
                  const val = e.target.value;
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  debounceRef.current = setTimeout(() => lookupStudent(val), 420);
                }}
                required
                className="form-input"
              />
            </div>
            <button type="submit" disabled={loading} className="btn btn-dark" style={{ width: "100%" }}>
              {loading ? "Looking up…" : "Get Payment Instructions"}
            </button>
          </form>

          {error && (
            <div ref={errorRef} role="alert" tabIndex="-1" className="alert alert-danger" style={{ marginTop: "1rem" }}>
              <IconAlertTriangle size={15} />
              <span>{error}</span>
            </div>
          )}

          {student && instructions && (
            <div style={{ marginTop: "1.25rem" }}>
              {isTestnet && (
                <div className="alert alert-warning" style={{ marginBottom: "1rem", fontSize: "0.8125rem" }}>
                  <IconAlertTriangle size={14} />
                  Testnet mode — do not send real funds.
                </div>
              )}
              {hasDeletedPayments && (
                <div role="alert" className="alert alert-warning" style={{ marginBottom: "1rem", fontSize: "0.8125rem" }}>
                  <IconAlertTriangle size={14} />
                  This student has deleted payment records not included in the balance shown.
                </div>
              )}

              {/* Student info */}
              <InfoRow label="Student">{student.name}</InfoRow>
              <InfoRow label="Class">{student.class}</InfoRow>
              <InfoRow label="Fee">
                {instructions.feeAmount ?? student.feeAmount}
                <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>XLM</span>
              </InfoRow>
              <InfoRow label="Status">
                <span className={student.feePaid ? "badge badge-success" : "badge badge-danger"}>
                  {student.feePaid ? "Paid" : "Unpaid"}
                </span>
              </InfoRow>

              {/* Wallet address */}
              <div style={{ marginTop: "1.25rem", marginBottom: "0.875rem" }}>
                <span className="pf-section-label">Wallet Address</span>
                <div className="pf-code-row">
                  <span className="pf-code">{instructions.walletAddress}</span>
                  <CopyButton text={instructions.walletAddress} copyKey="wallet" copied={copied} onCopy={copy} />
                </div>
              </div>

              {/* Memo */}
              <div style={{ marginBottom: "1.25rem" }}>
                <span className="pf-section-label">Memo (required)</span>
                <div className="pf-code-row">
                  <span className="pf-code">{instructions.memo}</span>
                  <CopyButton text={instructions.memo} copyKey="memo" copied={copied} onCopy={copy} />
                </div>
              </div>

              {/* QR Code */}
              {instructions.walletAddress && instructions.memo && (() => {
                const nonNative = instructions.acceptedAssets?.find(
                  a => a.code !== "XLM" && a.type !== "native"
                );
                const paymentUri = generateStellarPaymentUri({
                  destination: instructions.walletAddress,
                  amount: instructions.feeAmount ?? student.feeAmount ?? 0,
                  memo: instructions.memo,
                  assetCode: nonNative?.code,
                  assetIssuer: nonNative?.issuer,
                });
                const downloadFilename = `stellar-payment-${instructions.memo}.png`;
                return (
                  <div style={{ textAlign: "center", marginTop: "1.25rem", padding: "1.25rem", background: "var(--bg-subtle, var(--bg))", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
                    <span className="pf-section-label" style={{ display: "block", marginBottom: "0.75rem" }}>
                      Scan with Stellar Wallet
                    </span>
                    <div
                      ref={qrWrapperRef}
                      style={{ display: "inline-flex", padding: "0.75rem", background: "#fff", borderRadius: "var(--radius-sm)" }}
                    >
                      <QRCodeSVG
                        value={paymentUri}
                        size={148}
                        role="img"
                        aria-label={`QR code for payment to ${instructions.walletAddress}`}
                      />
                    </div>
                    <p style={{ marginTop: "0.625rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      Compatible with Lobstr, Solar, XBULL and any SEP-0007 wallet.
                    </p>

                    {/* QR actions */}
                    <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "0.875rem", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => copy(paymentUri, "qr-uri")}
                        className="btn btn-sm btn-ghost"
                        aria-label={copied === "qr-uri" ? "Payment URI copied" : "Copy payment URI"}
                        style={{ gap: "0.35rem" }}
                      >
                        {copied === "qr-uri" ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        {copied === "qr-uri" ? "Copied!" : "Copy payment URI"}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadQr(downloadFilename)}
                        className="btn btn-sm btn-ghost"
                        aria-label="Download QR code as PNG"
                        style={{ gap: "0.35rem" }}
                      >
                        <IconDownload size={13} />
                        Download QR
                      </button>
                    </div>
                  </div>
                );
              })()}

              {instructions.acceptedAssets?.length > 0 && (
                <p style={{ marginTop: "0.875rem", fontSize: "0.775rem", color: "var(--text-muted)" }}>
                  Accepted assets: {instructions.acceptedAssets.map(a => a.displayName).join(", ")}
                </p>
              )}
            </div>
          )}

          {/* Payment History */}
          {(payments !== null || paymentsLoading) && (
            <div style={{ marginTop: "1.75rem" }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.875rem", paddingBottom: "0.625rem", borderBottom: "1px solid var(--border)" }}>
                Payment History
              </div>
              {paymentsLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="pf-payment-item">
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                      <div className="skeleton" style={{ height: 14, width: 80 }} />
                      <div className="skeleton" style={{ height: 20, width: 60, borderRadius: 20 }} />
                    </div>
                    <div className="skeleton" style={{ height: 10, width: "100%" }} />
                  </div>
                ))
              ) : payments.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>No payments recorded yet.</p>
              ) : payments.map((p, i) => {
                const st = p.feeValidationStatus || "unknown";
                const badge = STATUS_BADGE[st] || STATUS_BADGE.unknown;
                const canDispute = st === "valid" || st === "overpaid";
                const alreadyDisputed = disputedTxs.has(p.txHash);
                return (
                  <div key={p.txHash || i} className="pf-payment-item">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.4rem" }}>
                      <strong style={{ fontSize: "0.9rem" }}>
                        {p.amount}{" "}
                        <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>
                          {p.assetCode || "XLM"}
                        </span>
                      </strong>
                      <span className={badge.cls}>{badge.label}</span>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.25rem", wordBreak: "break-all" }}>
                      {p.txHash}
                    </div>
                    {p.confirmedAt && (
                      <div style={{ fontSize: "0.75rem", color: "var(--text-subtle)" }}>
                        {new Date(p.confirmedAt).toLocaleString()}
                      </div>
                    )}

                    {canDispute && (
                      <div style={{ marginTop: "0.625rem" }}>
                        {alreadyDisputed ? (
                          <span className="badge badge-warning">Dispute submitted</span>
                        ) : disputingTx === p.txHash ? (
                          <div style={{ marginTop: "0.5rem" }}>
                            <DisputeForm
                              txHash={p.txHash}
                              studentId={studentId}
                              onSuccess={() => {
                                setDisputedTxs(prev => new Set([...prev, p.txHash]));
                                setDisputingTx(null);
                              }}
                              onCancel={() => setDisputingTx(null)}
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => setDisputingTx(p.txHash)}
                            className="btn btn-sm btn-ghost"
                            style={{ marginTop: "0.25rem" }}
                          >
                            Raise Dispute
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
