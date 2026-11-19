import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { getPayLinkInstructions } from "../../../services/api";

// #1937 — a parent opens a signed link from a reminder email and pays without
// typing a student ID. The token in the URL is the only credential.
const ERROR_MESSAGES = {
  PAY_LINK_EXPIRED: "This payment link has expired. Ask the school for a new one.",
  PAY_LINK_REVOKED: "This payment link has been replaced or revoked. Ask the school for a new one.",
  PAY_LINK_INVALID: "This payment link is not valid. Check that you copied the whole link.",
  PAY_LINK_NOT_CONFIGURED: "Payment links are unavailable right now. Please try again later.",
};
const FALLBACK_ERROR = "We could not load this payment link. Please try again later.";

function formatAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

export default function PayWithLink() {
  const router = useRouter();
  const { token } = router.query;
  const [state, setState] = useState({ status: "loading", data: null, error: null });

  useEffect(() => {
    if (typeof token !== "string") return undefined;
    const controller = new AbortController();
    setState({ status: "loading", data: null, error: null });
    getPayLinkInstructions(token, { signal: controller.signal })
      .then((res) => setState({ status: "ready", data: res.data, error: null }))
      .catch((err) => {
        if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") return;
        const code = err?.response?.data?.code;
        setState({ status: "error", data: null, error: ERROR_MESSAGES[code] || FALLBACK_ERROR });
      });
    return () => controller.abort();
  }, [token]);

  return (
    <>
      <Head><title>Pay school fees</title></Head>
      <main className="payfees-page" style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
        <h1>Pay school fees</h1>

        {state.status === "loading" && <p role="status">Loading payment details…</p>}

        {state.status === "error" && (
          <p role="alert">{state.error}</p>
        )}

        {state.status === "ready" && state.data && (
          <>
            <p>
              <strong>{state.data.schoolName}</strong>
              {state.data.class ? ` · Class ${state.data.class}` : ""}
            </p>
            <p>Student: {state.data.maskedName}</p>

            <section aria-labelledby="pay-details">
              <h2 id="pay-details">How to pay</h2>
              <p>Send payment to the school wallet below and include the memo exactly as shown. The memo is what lets the school match your payment.</p>
              <dl>
                <dt>Wallet address</dt>
                <dd style={{ wordBreak: "break-all" }}><code>{state.data.walletAddress}</code></dd>
                <dt>Memo ({state.data.memoType})</dt>
                <dd><code>{state.data.memo}</code></dd>
                <dt>Fee</dt>
                <dd>{formatAmount(state.data.feeAmount)}</dd>
              </dl>
            </section>

            {Array.isArray(state.data.fees) && state.data.fees.length > 0 && (
              <section aria-labelledby="fee-breakdown">
                <h2 id="fee-breakdown">Fees</h2>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Category</th>
                        <th scope="col">Amount</th>
                        <th scope="col">Paid</th>
                        <th scope="col">Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.fees.map((f) => (
                        <tr key={f.category}>
                          <td>{f.category}</td>
                          <td>{formatAmount(f.amount)}</td>
                          <td>{formatAmount(f.totalPaid)}</td>
                          <td>{formatAmount(f.remainingBalance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
