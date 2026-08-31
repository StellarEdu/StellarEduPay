import { useState, useRef, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { generateStellarPaymentUri, availableMemoTypes } from "../utils/stellarUri";
import { encodeMemo } from "../utils/stellarMemo";
import { getStudent, getPaymentInstructions, getStudentPayments, getStudentBalance, getPaymentRefunds } from "../services/api";
import DisputeForm from "./DisputeForm";
import { getErrorMessage } from "../utils/errorMessages";
import { IconCopy, IconCheck, IconAlertTriangle, IconSearch, IconDownload } from "./Icons";

const STATUS_BADGE = {
  valid:     { cls: "badge badge-success", key: "status.validation.valid" },
  overpaid:  { cls: "badge badge-warning", key: "status.validation.overpaid" },
  underpaid: { cls: "badge badge-danger",  key: "status.validation.underpaid" },
  unknown:   { cls: "badge badge-neutral", key: "status.validation.unknown" },
};

function CopyButton({ text, copyKey, copied, onCopy }) {
  const { t } = useTranslation();
  const isCopied = copied === copyKey;
  return (
    <button
      onClick={() => onCopy(text, copyKey)}
      className="btn btn-sm btn-ghost"
      aria-label={isCopied ? t("actions.copied") : t("actions.copyToClipboard")}
      style={{ flexShrink: 0, gap: "0.3rem" }}
    >
      {isCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {isCopied ? t("actions.copied") : t("actions.copy")}
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
      <div style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-word", overflowWrap: "anywhere" }}>{children}</div>
    </div>
  );
}

export default function PaymentForm({ initialStudentId = "" }) {
  const [studentId, setStudentId]             = useState(initialStudentId);
  const [shareCopied, setShareCopied]         = useState(false);
  const [student, setStudent]                 = useState(null);
  const [instructions, setInstructions]       = useState(null);
  const [payments, setPayments]               = useState(null);
  const [paymentPlan, setPaymentPlan]         = useState(null);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [error, setError]                     = useState("");
  const [loading, setLoading]                 = useState(false);
  const [copied, setCopied]                   = useState(null);
  const [hasDeletedPayments, setHasDeletedPayments] = useState(false);
  const [balanceError, setBalanceError]         = useState(false);
  const [disputingTx, setDisputingTx]           = useState(null);
  const [disputedTxs, setDisputedTxs]         = useState(new Set());
  const [refunds, setRefunds]                 = useState({}); // txHash -> refund
  // #1118 — wallets that cannot send free-text memos can switch the QR code to
  // MEMO_ID or MEMO_HASH; all three decode back to the same payment reference.
  const [memoType, setMemoType]               = useState("MEMO_TEXT");
  const errorRef    = useRef(null);
  const debounceRef = useRef(null);
  const qrWrapperRef = useRef(null);
  // Holds the AbortController for the in-flight lookup so a superseded request
  // can be cancelled before the next one starts (race-condition fix).
  const lookupAbortRef = useRef(null);

  function handleStudentIdChange(e) {
    const value = e.target.value;
    setStudentId(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Cancel any in-flight lookup when the component unmounts.
      lookupAbortRef.current?.abort();
    };
  }, []);

  const lookupStudent = useCallback(async (id) => {
    if (!id.trim()) return;

    // Cancel the previous in-flight request (if any) before starting a new one.
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    setError("");
    setStudent(null);
    setInstructions(null);
    setPayments(null);
    setPaymentPlan(null);
    setHasDeletedPayments(false);
    setBalanceError(false);
    setLoading(true);
    setPaymentsLoading(true);
    try {
      const signal = controller.signal;
      const [stuRes, instrRes, payRes, balRes, planRes] = await Promise.allSettled([
        getStudent(id, { signal }),
        getPaymentInstructions(id, { signal }),
        getStudentPayments(id, { signal }),
        getStudentBalance(id, { signal }).catch((err) => {
          // Propagate abort so the outer catch can detect it; surface other errors.
          if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") throw err;
          setBalanceError(true);
          return null;
        }),
        getPaymentPlan(id, { signal }).catch(() => null),
      ]);
      setStudent(stuRes.data);
      setInstructions(instrRes.data);
      const paymentsList = payRes.data?.payments ?? payRes.data ?? [];
      setPayments(paymentsList);
      setHasDeletedPayments(balRes?.data?.hasDeletedPayments === true);
      // Fetch refunds for each payment
      const newRefunds = {};
      for (const p of paymentsList) {
        if (p.txHash) {
          try {
            const refundsRes = await getPaymentRefunds(p.txHash);
            const refundList = Array.isArray(refundsRes.data) ? refundsRes.data : refundsRes.data?.refunds || [];
            if (refundList.length > 0) {
              newRefunds[p.txHash] = refundList[0]; // Get the most recent refund
            }
          } catch (e) {
            // Silently skip if refund fetch fails for this payment
          }
        }
      }
      if (Object.keys(newRefunds).length > 0) {
        setRefunds(newRefunds);
      }
    } catch (err) {
      // Axios names aborted requests "CanceledError" (axios ≥ 1.x) with code
      // "ERR_CANCELED".  Silently ignore them — a newer request is already
      // in flight and will update the UI when it resolves.
      if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") return;
      setError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
        t("paymentForm.studentNotFound")
      );
      errorRef.current?.focus();
    } finally {
      // Only clear loading state when *this* controller is still the current
      // one (i.e. it hasn't been superseded by a newer lookup).
      if (lookupAbortRef.current === controller) {
        setLoading(false);
        setPaymentsLoading(false);
      }
    }
  }, [t]);

  // #1344 — a bookmarked/shared /pay/:studentId URL pre-fills the lookup so a
  // parent doesn't have to retype the student ID on every visit.
  useEffect(() => {
    if (initialStudentId?.trim()) lookupStudent(initialStudentId);
  }, [initialStudentId, lookupStudent]);

  function sharePaymentUrl(id) {
    return `${window.location.origin}/pay/${encodeURIComponent(id)}`;
  }

  async function copyShareLink() {
    if (!student?.studentId) return;
    await navigator.clipboard.writeText(sharePaymentUrl(student.studentId)).catch(() => {});
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }

  const retryBalance = useCallback(async () => {
    if (!studentId.trim()) return;
    setBalanceError(false);
    try {
      const balRes = await getStudentBalance(studentId);
      setHasDeletedPayments(balRes?.data?.hasDeletedPayments === true);
    } catch {
      setBalanceError(true);
    }
  }, [studentId]);

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
  const { t } = useTranslation();

  return (
    <>
      

      <div className="card pf-wrap">
        <div className="card-header">
          <div className="card-title">{t("paymentForm.title")}</div>
          {isTestnet && (
            <span className="badge badge-warning" style={{ fontSize: "0.68rem" }}>{t("paymentForm.testnetBadge")}</span>
          )}
        </div>
        <div className="card-body">
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
            {t("paymentForm.intro")}
          </p>

          <form onSubmit={(e) => {
            e.preventDefault();
            // #1215 — cancel any pending debounce timer so that submitting the
            // form immediately after typing doesn't fire a duplicate lookup.
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            lookupStudent(studentId);
          }}>
            <label className="pf-section-label" htmlFor="sid">{t("paymentForm.studentIdLabel")}</label>
            <div className="pf-id-input-wrap">
              <span className="pf-search-icon"><IconSearch size={15} /></span>
              <input
                id="sid"
                type="text"
                placeholder={t("paymentForm.studentIdPlaceholder")}
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
              {loading ? t("paymentForm.lookingUp") : t("paymentForm.submit")}
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
                  {t("paymentForm.testnetMode")}
                </div>
              )}
              {hasDeletedPayments && (
                <div role="alert" className="alert alert-warning" style={{ marginBottom: "1rem", fontSize: "0.8125rem" }}>
                  <IconAlertTriangle size={14} />
                  {t("paymentForm.deletedPaymentRecords")}
                </div>
              )}
              {balanceError && (
                <div role="alert" className="alert alert-warning" style={{ marginBottom: "1rem", fontSize: "0.8125rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <IconAlertTriangle size={14} />
                    {t("paymentForm.balanceLoadError")}
                  </span>
                  <button
                    type="button"
                    onClick={retryBalance}
                    className="btn btn-sm btn-ghost"
                    style={{ flexShrink: 0 }}
                  >
                    {t("paymentForm.retry")}
                  </button>
                </div>
              )}

              {/* Student info */}
              <InfoRow label={t("paymentForm.student")}>{student.name}</InfoRow>
              <InfoRow label={t("paymentForm.class")}>{student.class}</InfoRow>
              <InfoRow label={t("paymentForm.fee")}>
                {instructions.feeAmount ?? student.feeAmount}
                <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>XLM</span>
              </InfoRow>
              <InfoRow label={t("actions.status")}>
                <span className={student.feePaid ? "badge badge-success" : "badge badge-danger"}>
                  {student.feePaid ? t("paymentForm.paid") : t("paymentForm.unpaid")}
                </span>
              </InfoRow>
              {instructions.minAmount !== undefined && instructions.maxAmount !== undefined && (
                <InfoRow label={t("paymentForm.paymentLimits")}>
                  {instructions.minAmount}
                  <span style={{ marginLeft: "0.25rem", marginRight: "0.5rem", fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>XLM</span>
                  —
                  {instructions.maxAmount}
                  <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>XLM</span>
                </InfoRow>
              )}

              {/* #1344 — bookmarkable/shareable payment link for this student */}
              <div style={{ marginTop: "0.875rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <button type="button" onClick={copyShareLink} className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start", gap: "0.3rem" }}>
                  {shareCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  {shareCopied ? t("paymentForm.linkCopied") : t("paymentForm.shareLink")}
                </button>
                <div className="pf-code-row">
                  <span className="pf-code">{sharePaymentUrl(student.studentId)}</span>
                </div>
                <div style={{ background: "#fff", padding: "0.5rem", borderRadius: "8px", alignSelf: "flex-start" }}>
                  <QRCodeSVG value={sharePaymentUrl(student.studentId)} size={96} />
                </div>
              </div>

              {/* Wallet address */}
              <div style={{ marginTop: "1.25rem", marginBottom: "0.875rem" }}>
                <span className="pf-section-label">{t("paymentForm.walletAddress")}</span>
                <div className="pf-code-row">
                  <span className="pf-code">{instructions.walletAddress}</span>
                  <CopyButton text={instructions.walletAddress} copyKey="wallet" copied={copied} onCopy={copy} />
                </div>
              </div>

              {/* Memo */}
              <div style={{ marginBottom: "1.25rem" }}>
                <span className="pf-section-label">{t("paymentForm.memoRequired")}</span>
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
                const memoTypes = availableMemoTypes(instructions.memo);
                // Guard against a stale selection if the memo changes to one
                // that has no numeric equivalent.
                const activeMemoType = memoTypes.includes(memoType) ? memoType : "MEMO_TEXT";
                const paymentUri = generateStellarPaymentUri({
                  destination: instructions.walletAddress,
                  amount: instructions.feeAmount ?? student.feeAmount ?? 0,
                  memo: instructions.memo,
                  memoType: activeMemoType,
                  assetCode: nonNative?.code,
                  assetIssuer: nonNative?.issuer,
                });
                const encodedMemo = encodeMemo(instructions.memo, activeMemoType);
                const downloadFilename = `stellar-payment-${instructions.memo}.png`;
                return (
                  <div style={{ textAlign: "center", marginTop: "1.25rem", padding: "1.25rem", background: "var(--bg-subtle, var(--bg))", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
                    <span className="pf-section-label" style={{ display: "block", marginBottom: "0.75rem" }}>
                      {t("paymentForm.scanWithWallet")}
                    </span>
                    <div
                      ref={qrWrapperRef}
                      style={{ display: "inline-flex", padding: "0.75rem", background: "#fff", borderRadius: "var(--radius-sm)", maxWidth: "100%" }}
                    >
                      {/* #1384 — 200px is the WCAG-friendly minimum for a
                          scannable QR on a mobile screen; fits comfortably
                          within a 360px viewport alongside the card padding. */}
                      <QRCodeSVG
                        value={paymentUri}
                        size={200}
                        role="img"
                        aria-label={t("paymentForm.qrAria", { address: instructions.walletAddress })}
                      />
                    </div>
                    <p style={{ marginTop: "0.625rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      {t("paymentForm.walletCompatibility")}
                    </p>

                    {/* Memo type — for wallets that require a numeric or hash memo (#1118) */}
                    {memoTypes.length > 1 && (
                      <div style={{ marginTop: "0.875rem" }}>
                        <label
                          htmlFor="memo-type-select"
                          className="pf-section-label"
                          style={{ display: "block", marginBottom: "0.375rem" }}
                        >
                          {t("paymentForm.memoType")}
                        </label>
                        <select
                          id="memo-type-select"
                          value={activeMemoType}
                          onChange={(e) => setMemoType(e.target.value)}
                          className="input input-sm"
                          style={{ maxWidth: "16rem", margin: "0 auto" }}
                        >
                          <option value="MEMO_TEXT">{t("paymentForm.memoTypeText")}</option>
                          <option value="MEMO_ID">{t("paymentForm.memoTypeId")}</option>
                          <option value="MEMO_HASH">{t("paymentForm.memoTypeHash")}</option>
                        </select>
                        {activeMemoType !== "MEMO_TEXT" && (
                          <div style={{ marginTop: "0.625rem" }}>
                            <span className="pf-section-label" style={{ display: "block", marginBottom: "0.375rem" }}>
                              {t("paymentForm.memoValueForType")}
                            </span>
                            <div className="pf-code-row" style={{ justifyContent: "center" }}>
                              <span className="pf-code" style={{ wordBreak: "break-all" }}>{encodedMemo}</span>
                              <CopyButton text={encodedMemo} copyKey="encoded-memo" copied={copied} onCopy={copy} />
                            </div>
                          </div>
                        )}
                        <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {t("paymentForm.memoCaution")}
                        </p>
                      </div>
                    )}

                    {/* QR actions */}
                    <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "0.875rem", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => copy(paymentUri, "qr-uri")}
                        className="btn btn-sm btn-ghost"
                        aria-label={copied === "qr-uri" ? t("paymentForm.uriCopied") : t("paymentForm.copyUri")}
                        style={{ gap: "0.35rem" }}
                      >
                        {copied === "qr-uri" ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        {copied === "qr-uri" ? t("actions.copied") : t("paymentForm.copyUri")}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadQr(downloadFilename)}
                        className="btn btn-sm btn-ghost"
                        aria-label={t("paymentForm.downloadQrAria")}
                        style={{ gap: "0.35rem" }}
                      >
                        <IconDownload size={13} />
                        {t("paymentForm.downloadQr")}
                      </button>
                    </div>
                  </div>
                );
              })()}

              {instructions.acceptedAssets?.length > 0 && (
                <p style={{ marginTop: "0.875rem", fontSize: "0.775rem", color: "var(--text-muted)" }}>
                  {t("paymentForm.acceptedAssets")} {instructions.acceptedAssets.map(a => a.displayName).join(", ")}
                </p>
              )}
            </div>
          )}

          {/* Payment History */}
          {(payments !== null || paymentsLoading) && (
            <div style={{ marginTop: "1.75rem" }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.875rem", paddingBottom: "0.625rem", borderBottom: "1px solid var(--border)" }}>
                {t("paymentForm.paymentHistory")}
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
                <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>{t("paymentForm.noPayments")}</p>
              ) : payments.map((p, i) => {
                const st = p.feeValidationStatus || "unknown";
                const badge = STATUS_BADGE[st] || STATUS_BADGE.unknown;
                const canDispute = st === "valid" || st === "overpaid";
                const alreadyDisputed = disputedTxs.has(p.txHash);
                const refund = refunds[p.txHash];
                const refundStatusStyles = {
                  approval_pending: { cls: "badge badge-warning" },
                  pending: { cls: "badge badge-info" },
                  submitted: { cls: "badge badge-primary" },
                  confirmed: { cls: "badge badge-success" },
                  failed: { cls: "badge badge-danger" },
                };
                return (
                  <div key={p.txHash || i} className="pf-payment-item">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.4rem", flexWrap: "wrap", gap: "0.5rem" }}>
                      <strong style={{ fontSize: "0.9rem" }}>
                        {p.amount}{" "}
                        <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>
                          {p.assetCode || "XLM"}
                        </span>
                      </strong>
                      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                          <span className={badge.cls}>{t(badge.key)}</span>
                          {refund && (
                            <span className={refundStatusStyles[refund.status]?.cls || "badge badge-neutral"}>
                              {refundStatusStyles[refund.status]
                                ? `${t("status.refund.prefix")} ${t(`status.refund.${refund.status}`)}`
                                : `${t("status.refund.prefix")} ${refund.status}`}
                            </span>
                          )}
                        </div>
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
                          <span className="badge badge-warning">{t("paymentForm.disputeSubmitted")}</span>
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
                            {t("paymentForm.raiseDispute")}
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
