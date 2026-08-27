import { useRouter } from "next/router";
import Head from "next/head";
import PaymentForm from "../../components/PaymentForm";
import VerifyPayment from "../../components/VerifyPayment";
import SseDegradedBanner from "../../components/SseDegradedBanner";
import { usePaymentEvents } from "../../hooks/usePaymentEvents";

// #1344 — shareable, bookmarkable payment status URL. Pre-fills the student
// lookup from the route param instead of requiring manual re-entry.
export default function PayFeesForStudent() {
  const router = useRouter();
  const { studentId } = router.query;
  const { degraded, connectionStatus } = usePaymentEvents();

  return (
    <>
      <Head><title>Pay Fees | StellarEduPay</title></Head>
      <SseDegradedBanner degraded={degraded} connectionStatus={connectionStatus} />

      <div className="payfees-page">
        <div className="payfees-header">
          <span className="payfees-badge">
            <span className="payfees-badge-dot" />
            Live on Stellar
          </span>
          <h1>Pay School Fees</h1>
          <p>Payment instructions and history for this student. Payments confirm in 3–5 seconds.</p>
        </div>

        <div className="payfees-grid">
          {typeof studentId === "string" && <PaymentForm initialStudentId={studentId} />}
          <VerifyPayment />
        </div>
      </div>
    </>
  );
}
