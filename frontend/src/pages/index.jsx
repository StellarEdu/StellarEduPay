import Head from "next/head";
import Link from "next/link";
import { useTranslation } from "react-i18next";

const FEATURES = [
  {
    icon: "⚡",
    title: "landing.featSettlementTitle",
    desc: "landing.featSettlementDesc",
  },
  {
    icon: "🔗",
    title: "landing.featImmutabilityTitle",
    desc: "landing.featImmutabilityDesc",
  },
  {
    icon: "🔄",
    title: "landing.featReconciliationTitle",
    desc: "landing.featReconciliationDesc",
  },
  {
    icon: "💰",
    title: "landing.featCostTitle",
    desc: "landing.featCostDesc",
  },
  {
    icon: "🏫",
    title: "landing.featMultiSchoolTitle",
    desc: "landing.featMultiSchoolDesc",
  },
  {
    icon: "📡",
    title: "landing.featRealtimeTitle",
    desc: "landing.featRealtimeDesc",
  },
];

const STEPS = [
  {
    n: "1",
    title: "landing.howStep1Title",
    desc: "landing.howStep1Desc",
  },
  {
    n: "2",
    title: "landing.howStep2Title",
    desc: "landing.howStep2Desc",
  },
  {
    n: "3",
    title: "landing.howStep3Title",
    desc: "landing.howStep3Desc",
  },
];

const STATS = [
  { v: "< 5s", l: "landing.statSettlement" },
  { v: "$0.000001", l: "landing.statPerTx" },
  { v: "100%", l: "landing.statOnChain" },
  { v: "0", l: "landing.statManualSteps" },
];

export default function Home() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("landing.headTitle")}</title>
        <meta name="description" content={t("landing.headDesc")} />
      </Head>

      

      <div className="lp">

        {/* ── HERO ── */}
        <section className="lp-hero">
          <div className="lp-hero-bg">
            <div className="lp-blob lp-blob-1" />
            <div className="lp-blob lp-blob-2" />
            <div className="lp-blob lp-blob-3" />
          </div>
          <div className="lp-hero-grid" />

          <div className="lp-hero-content">
            <div className="lp-badge">
              <span className="lp-badge-dot" />
              {t("landing.badge")}
            </div>

            <h1>
              {t("landing.heroLine1")}<br />
              <em>{t("landing.heroLine2")}</em>
            </h1>

            <p className="lp-hero-sub">
              {t("landing.heroSub")}
            </p>

            <div className="lp-hero-actions">
              <Link href="/pay-fees" className="btn-cta">
                {t("landing.ctaPayNow")}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </Link>
              <Link href="/dashboard" className="btn-ghost">
                {t("landing.ctaDashboard")}
              </Link>
            </div>
          </div>

          <div className="lp-scroll-hint">
            <div className="lp-scroll-arrow">
              <div className="lp-scroll-ball" />
            </div>
            {t("landing.scroll")}
          </div>
        </section>

        {/* ── STATS BAND ── */}
        <div className="lp-stats-band">
          <div className="lp-container">
            <div className="lp-stats-inner">
              {STATS.map(({ v, l }) => (
                <div key={l} className="lp-stat">
                  <span className="lp-stat-v">{v}</span>
                  <span className="lp-stat-l">{t(l)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── FEATURES ── */}
        <section className="lp-features">
          <div className="lp-container">
            <div className="lp-section-header">
              <span className="lp-eyebrow">{t("landing.featuresEyebrow")}</span>
              <h2 className="lp-section-h2">{t("landing.featuresH2a")}<br />{t("landing.featuresH2b")}</h2>
              <p className="lp-section-p">{t("landing.featuresP")}</p>
            </div>
            <div className="lp-features-grid">
              {FEATURES.map(({ icon, title, desc }) => (
                <div key={title} className="lp-feat">
                  <span className="lp-feat-icon">{icon}</span>
                  <p className="lp-feat-title">{t(title)}</p>
                  <p className="lp-feat-desc">{t(desc)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── TRUST STRIP ── */}
        <div className="lp-trust">
          <div className="lp-container">
            <span className="lp-trust-label">{t("landing.trustLabel")}</span>
            <div className="lp-trust-items">
              {[
                ["landing.trustSdk", "⬡"],
                ["landing.trustMongo", "🍃"],
                ["landing.trustRedis", "⚙"],
                ["landing.trustJwt", "🔐"],
                ["landing.trustPrometheus", "📊"],
                ["landing.trustOpenApi", "📄"],
              ].map(([label, icon]) => (
                <div key={label} className="lp-trust-item">
                  <span>{icon}</span>
                  <span>{t(label)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── HOW IT WORKS ── */}
        <section className="lp-how">
          <div className="lp-container">
            <div className="lp-section-header">
              <span className="lp-eyebrow">{t("landing.howItWorksTitle")}</span>
              <h2 className="lp-section-h2">{t("landing.howH2a")}<br />{t("landing.howH2b")}</h2>
              <p className="lp-section-p">{t("landing.howP")}</p>
            </div>
            <div className="lp-steps">
              {STEPS.map(({ n, title, desc }) => (
                <div key={n} className="lp-step">
                  <div className="lp-step-num">{n}</div>
                  <p className="lp-step-title">{t(title)}</p>
                  <p className="lp-step-desc">{t(desc)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="lp-cta">
          <div className="lp-cta-inner">
            <h2>{t("landing.ctaH2")}</h2>
            <p>{t("landing.ctaP")}</p>
            <div className="lp-cta-btns">
              <Link href="/pay-fees" className="btn-cta">{t("landing.ctaStart")}</Link>
              <Link href="/dashboard" className="btn-ghost">{t("landing.ctaAdminDashboard")}</Link>
            </div>
          </div>
        </section>

        {/* ── FOOTER ── */}
        <footer className="lp-footer">
          <div className="lp-footer-inner">
            <div className="lp-footer-brand">
              <div className="lp-footer-logo">S</div>
              <span className="lp-footer-name">{t("app.name")}</span>
            </div>
            <span className="lp-footer-copy">{t("landing.footerCopy", { year: new Date().getFullYear() })}</span>
            <div className="lp-footer-links">
              <a href="https://stellar.org" target="_blank" rel="noopener noreferrer">{t("landing.footerStellar")}</a>
              <a href="https://github.com/manuelusman73-png/StellarEduPay" target="_blank" rel="noopener noreferrer">{t("landing.footerGithub")}</a>
              <Link href="/api/docs">{t("landing.footerApiDocs")}</Link>
            </div>
          </div>
        </footer>

      </div>
    </>
  );
}
