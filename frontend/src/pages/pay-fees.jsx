import Head from "next/head";
import { useRef, useState, useEffect } from "react";
import PaymentForm from "../components/PaymentForm";
import VerifyPayment from "../components/VerifyPayment";
import { listSchools } from "../services/api";
import { useTranslation } from "react-i18next";

// Issue #1573 — The pay-fees page is public (anonymous parents).
// It must not call admin-only endpoints and must not attempt an authenticated
// SSE stream (issue #1574). Instead, parents select their school from the
// public school listing so the X-School-ID header is sent for the
// payment-instructions and verify endpoints.

export default function PayFees() {
  const { t } = useTranslation();
  const verifyPaymentRef = useRef(null);

  const [schools, setSchools] = useState([]);
  const [schoolsLoading, setSchoolsLoading] = useState(true);
  const [selectedSchoolId, setSelectedSchoolId] = useState("");

  const STEPS = [
    { n: "1", title: t("payFees.step1Title"), desc: t("payFees.step1Desc") },
    { n: "2", title: t("payFees.step2Title"), desc: t("payFees.step2Desc") },
    { n: "3", title: t("payFees.step3Title"), desc: t("payFees.step3Desc") },
  ];

  // Load the public school listing so the parent can identify their school.
  useEffect(() => {
    listSchools()
      .then((res) => {
        const list = Array.isArray(res.data)
          ? res.data
          : res.data?.schools ?? [];
        setSchools(list.filter((s) => s.isActive !== false));
      })
      .catch(() => {
        // Non-fatal — the parent can still type the school ID manually
        // via the X-School-Slug header path.
        setSchools([]);
      })
      .finally(() => setSchoolsLoading(false));
  }, []);

  // Persist the selected school so the axios interceptor in api.js picks it up
  // via localStorage.getItem('selectedSchoolId').  We write to selectedSchoolId
  // (not schoolId) so it does not collide with the admin's own school context.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedSchoolId) {
      localStorage.setItem("selectedSchoolId", selectedSchoolId);
    } else {
      localStorage.removeItem("selectedSchoolId");
    }
    // Clean up when the page unmounts so we do not leave a stale school context
    // for an admin who navigates to this page and back.
    return () => {
      localStorage.removeItem("selectedSchoolId");
    };
  }, [selectedSchoolId]);

  const handleManualVerify = () => {
    verifyPaymentRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <>
      <Head>
        <title>
          {t("nav.payFees")} | {t("app.name")}
        </title>
      </Head>
      {/* Issue #1574 — do NOT mount usePaymentEvents here; this page is
          anonymous and EventSource cannot send auth headers. The SSE stream
          is only meaningful for admins on the authenticated dashboard. */}

      <div className="payfees-page">
        {/* Page header */}
        <div className="payfees-header">
          <span className="payfees-badge">
            <span className="payfees-badge-dot" />
            {t("payFees.liveOnStellar")}
          </span>
          <h1>{t("payFees.heroTitle")}</h1>
          <p>{t("payFees.heroDesc")}</p>
        </div>

        {/* How it works — inline steps */}
        <div className="payfees-steps">
          {STEPS.map((step) => (
            <div key={step.n} className="payfees-step">
              <div className="payfees-step-num">{step.n}</div>
              <div className="payfees-step-text">
                <h3>{step.title}</h3>
                <p>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* School picker — required before looking up a student so the
            X-School-ID header is populated for all subsequent requests. */}
        {!schoolsLoading && schools.length > 0 && (
          <div className="card" style={{ marginBottom: "1.5rem" }}>
            <div className="card-body">
              <label
                htmlFor="school-select"
                className="form-label"
                style={{ fontWeight: 600 }}
              >
                {t("payFees.selectSchool", { defaultValue: "Select your school" })}
              </label>
              <select
                id="school-select"
                className="form-input"
                value={selectedSchoolId}
                onChange={(e) => setSelectedSchoolId(e.target.value)}
              >
                <option value="">
                  {t("payFees.schoolPlaceholder", {
                    defaultValue: "— choose a school —",
                  })}
                </option>
                {schools.map((s) => (
                  <option key={s.schoolId} value={s.schoolId}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Main content grid — only rendered once a school is selected so
            all child API calls have the correct X-School-ID context. */}
        {selectedSchoolId ? (
          <div className="payfees-grid">
            {/* Issue #1573 — publicMode=true makes PaymentForm use the
                public /students/public/:id endpoint instead of the
                admin-only /students/:id, and skips balance/history calls. */}
            <PaymentForm publicMode />
            <div ref={verifyPaymentRef}>
              <VerifyPayment />
            </div>
          </div>
        ) : (
          !schoolsLoading && (
            <p
              style={{
                textAlign: "center",
                color: "var(--text-muted)",
                padding: "2rem 0",
              }}
            >
              {t("payFees.pickSchoolPrompt", {
                defaultValue:
                  "Please select your school above to continue.",
              })}
            </p>
          )
        )}
      </div>
    </>
  );
}
