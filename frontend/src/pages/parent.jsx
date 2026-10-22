import Head from "next/head";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { createParentApi, loadParentToken, saveParentToken } from "../services/parentApi";
import { getErrorMessage } from "../utils/errorMessages";
import styles from "../styles/parent.module.css";

// #1637 — parent self-service portal. Reached through a per-family magic link
// (/parent?token=…) from reminder emails or sent by the school. The token is
// moved out of the address bar into sessionStorage on first load so it is not
// left in browser history, and is sent only in the X-Parent-Token header.

function formatAmount(amount, asset) {
  if (amount === null || amount === undefined) return "—";
  return `${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 7 })} ${asset || ""}`.trim();
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function PaymentHistory({ api, studentId, t, onDispute }) {
  const [state, setState] = useState({ loading: true, error: "", payments: [] });

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/parent/students/${encodeURIComponent(studentId)}/payments`, { params: { limit: 50 } })
      .then(({ data }) => !cancelled && setState({ loading: false, error: "", payments: data.payments || [] }))
      .catch((err) => {
        const body = err.response?.data || {};
        if (!cancelled) setState({ loading: false, error: getErrorMessage(body.code, body.error), payments: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [api, studentId]);

  async function downloadReceipt(txHash) {
    try {
      const { data } = await api.get(`/parent/receipts/${encodeURIComponent(txHash)}`, {
        params: { format: "pdf" },
        responseType: "blob",
      });
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt-${txHash}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setState((s) => ({ ...s, error: t("parent.receiptFailed", "Could not download the receipt. Please try again.") }));
    }
  }

  if (state.loading) return <p className={styles.muted}>{t("parent.loadingPayments", "Loading payments…")}</p>;
  if (state.error) return <p role="alert" className="error-message">{state.error}</p>;
  if (state.payments.length === 0) return <p className={styles.muted}>{t("parent.noPayments", "No payments yet.")}</p>;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t("parent.date", "Date")}</th>
            <th>{t("parent.amount", "Amount")}</th>
            <th>{t("parent.status", "Status")}</th>
            <th>{t("parent.transaction", "Transaction")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.payments.map((p) => (
            <tr key={p.txHash}>
              <td>{formatDate(p.confirmedAt || p.createdAt)}</td>
              <td>{formatAmount(p.amount, p.assetCode)}</td>
              <td>{p.status}</td>
              <td className={styles.hash} title={p.txHash}>{`${p.txHash.slice(0, 8)}…${p.txHash.slice(-6)}`}</td>
              <td className={styles.actions}>
                {p.receiptAvailable && (
                  <button type="button" className="btn btn-secondary" onClick={() => downloadReceipt(p.txHash)}>
                    {t("parent.receipt", "Receipt")}
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => onDispute(p)}>
                  {t("parent.dispute", "Report a problem")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DisputeForm({ api, payment, t, onClose }) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("idle"); // idle | working | done | error
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setStatus("working");
    setError("");
    try {
      await api.post("/parent/disputes", { txHash: payment.txHash, reason });
      setStatus("done");
    } catch (err) {
      const body = err.response?.data || {};
      setError(getErrorMessage(body.code, body.error));
      setStatus("error");
    }
  }

  return (
    <section className={`${styles.card} ${styles.dispute}`} aria-labelledby="dispute-title">
      <h2 id="dispute-title">{t("parent.disputeTitle", "Report a problem with a payment")}</h2>
      <p className={styles.muted}>
        {formatDate(payment.confirmedAt || payment.createdAt)} · {formatAmount(payment.amount, payment.assetCode)} ·{" "}
        <span className={styles.hash}>{payment.txHash}</span>
      </p>
      {status === "done" ? (
        <>
          <p>{t("parent.disputeDone", "Thank you — the school has been notified and will review this payment.")}</p>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("parent.close", "Close")}
          </button>
        </>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="dispute-reason">{t("parent.disputeReason", "What is wrong with this payment?")}</label>
          <textarea
            id="dispute-reason"
            value={reason}
            maxLength={1000}
            required
            onChange={(e) => setReason(e.target.value)}
          />
          {status === "error" && <p role="alert" className="error-message">{error}</p>}
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={status === "working" || !reason.trim()}>
              {status === "working" ? t("parent.sending", "Sending…") : t("parent.sendDispute", "Send to school")}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t("parent.cancel", "Cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function StudentCard({ api, student, t, onDispute, onPreferenceChange }) {
  const plan = student.paymentPlan;
  const [saving, setSaving] = useState(false);

  async function toggleReminders() {
    setSaving(true);
    try {
      const { data } = await api.put(`/parent/students/${encodeURIComponent(student.studentId)}/preferences`, {
        reminderOptOut: !student.preferences.reminderOptOut,
      });
      onPreferenceChange(student.studentId, data.preferences);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby={`student-${student.studentId}`}>
      <h2 id={`student-${student.studentId}`}>
        {student.name} <span className={styles.muted}>· {student.class} · ID {student.studentId}</span>
      </h2>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.muted}>{t("parent.totalFees", "Total fees")}</span>
          <strong>{formatAmount(student.feeAmount)}</strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.muted}>{t("parent.paid", "Paid")}</span>
          <strong>{formatAmount(student.totalPaid)}</strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.muted}>{t("parent.outstanding", "Outstanding")}</span>
          <strong>{student.feePaid ? t("parent.paidInFull", "Paid in full") : formatAmount(student.remainingBalance)}</strong>
        </div>
        {student.paymentDeadline && (
          <div className={styles.stat}>
            <span className={styles.muted}>{t("parent.deadline", "Due by")}</span>
            <strong>{formatDate(student.paymentDeadline)}</strong>
          </div>
        )}
      </div>

      {plan && (
        <>
          <h3>{t("parent.paymentPlan", "Payment plan")}</h3>
          <p>
            {t("parent.planProgress", "{{paid}} of {{count}} installments paid", {
              paid: plan.paidInstallments,
              count: plan.installmentCount,
            })}
            {plan.nextInstallment && (
              <>
                {" · "}
                {t("parent.nextInstallment", "Next: {{amount}} due {{date}}", {
                  amount: formatAmount(plan.nextInstallment.amount - (plan.nextInstallment.paidAmount || 0)),
                  date: formatDate(plan.nextInstallment.dueDate),
                })}
                {plan.nextInstallment.overdue && <strong> ({t("parent.overdue", "overdue")})</strong>}
              </>
            )}
          </p>
        </>
      )}

      <h3>{t("parent.history", "Payment history")}</h3>
      <PaymentHistory api={api} studentId={student.studentId} t={t} onDispute={onDispute} />

      <h3>{t("parent.notifications", "Notifications")}</h3>
      <label>
        <input
          type="checkbox"
          checked={!student.preferences.reminderOptOut}
          disabled={saving}
          onChange={toggleReminders}
        />{" "}
        {t("parent.reminderToggle", "Email me fee payment reminders for this student")}
      </label>
    </section>
  );
}

export default function ParentPortalPage() {
  const router = useRouter();
  const { t } = useTranslation();
  // null = not yet read from the link / session storage
  const [token, setToken] = useState(null);
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [disputePayment, setDisputePayment] = useState(null);

  // Move the token from the link into session storage and out of the URL.
  useEffect(() => {
    if (!router.isReady) return;
    const fromLink = typeof router.query.token === "string" ? router.query.token : "";
    if (fromLink) {
      saveParentToken(fromLink);
      setToken(fromLink);
      router.replace("/parent", undefined, { shallow: true });
    } else {
      setToken(loadParentToken());
    }
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const api = useMemo(() => (token ? createParentApi(token) : null), [token]);

  const load = useCallback(async () => {
    if (token === null) return;
    if (!token) {
      setState({ status: "missing", data: null, error: "" });
      return;
    }
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const { data } = await api.get("/parent/me");
      setState({ status: "ready", data, error: "" });
    } catch (err) {
      const body = err.response?.data || {};
      if (err.response?.status === 401) saveParentToken("");
      setState({ status: "error", data: null, error: body.error || getErrorMessage(body.code, body.error) });
    }
  }, [token, api]);

  useEffect(() => {
    load();
  }, [load]);

  function handlePreferenceChange(studentId, preferences) {
    setState((s) => ({
      ...s,
      data: {
        ...s.data,
        students: s.data.students.map((st) => (st.studentId === studentId ? { ...st, preferences } : st)),
      },
    }));
  }

  let content;
  if (state.status === "loading") {
    content = <p>{t("parent.loading", "Loading…")}</p>;
  } else if (state.status === "missing") {
    content = (
      <div className={styles.card}>
        <h1>{t("parent.title", "Parent portal")}</h1>
        <p>
          {t(
            "parent.missingToken",
            "Open the parent portal using the personal link from your school's email. If you don't have one, ask the school office to send you a link."
          )}
        </p>
      </div>
    );
  } else if (state.status === "error") {
    content = (
      <div className={styles.card}>
        <h1>{t("parent.title", "Parent portal")}</h1>
        <p role="alert" className="error-message">{state.error}</p>
        <p>{t("parent.askForLink", "Please ask the school office to send you a new link.")}</p>
      </div>
    );
  } else {
    const { school, students, expiresAt } = state.data;
    content = (
      <>
        <header className={styles.header}>
          {school?.logoUrl && <img src={school.logoUrl} alt="" />}
          <div>
            <h1>{school?.name || t("parent.title", "Parent portal")}</h1>
            <p className={styles.muted}>
              {t("parent.linkExpires", "This personal link is valid until {{date}}. Please do not share it.", {
                date: formatDate(expiresAt),
              })}
              {school?.supportContact && <> · {t("parent.support", "Questions?")} {school.supportContact}</>}
            </p>
          </div>
        </header>
        {disputePayment && (
          <DisputeForm api={api} payment={disputePayment} t={t} onClose={() => setDisputePayment(null)} />
        )}
        {students.map((student) => (
          <StudentCard
            key={student.studentId}
            api={api}
            student={student}
            t={t}
            onDispute={setDisputePayment}
            onPreferenceChange={handlePreferenceChange}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{t("parent.pageTitle", "Parent portal")} | {t("app.name")}</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className={styles.wrap}>
        <div className={styles.inner}>{content}</div>
      </div>
    </>
  );
}
