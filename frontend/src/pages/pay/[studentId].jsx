import { useRouter } from "next/router";
import Head from "next/head";
import PaymentForm from "../../components/PaymentForm";
import VerifyPayment from "../../components/VerifyPayment";
import SseDegradedBanner from "../../components/SseDegradedBanner";
import { usePublicHealthPolling } from "../../hooks/usePublicHealthPolling";
import { apiUrl } from "../../config/apiBase";
import { useTranslation } from "react-i18next";

// #1344 — shareable, bookmarkable payment status URL. Pre-fills the student
// lookup from the route param instead of requiring manual re-entry.
export default function PayFeesForStudent() {
  const router = useRouter();
  const { t } = useTranslation();
  const { studentId } = router.query;
  // Issue #1831 — public parents poll a small endpoint with back-off instead of
  // holding an SSE connection open on a flaky mobile network.
  const { degraded, connectionStatus } = usePublicHealthPolling({ url: apiUrl("/public-config") });

  return (
    <>
      <Head><title>{t("nav.payFees")} | {t("app.name")}</title></Head>
      <SseDegradedBanner degraded={degraded} connectionStatus={connectionStatus} />

      <div className="payfees-page">
        <div className="payfees-header">
          <span className="payfees-badge">
            <span className="payfees-badge-dot" />
            {t("payFees.liveOnStellar")}
          </span>
          <h1>{t("payFees.heroTitle")}</h1>
          <p>{t("payFees.studentHeroDesc")}</p>
        </div>

        <div className="payfees-grid">
          {typeof studentId === "string" && <PaymentForm initialStudentId={studentId} />}
          <VerifyPayment />
        </div>
      </div>
    </>
  );
}
