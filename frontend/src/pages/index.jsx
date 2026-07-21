import Head from "next/head";
import Link from "next/link";

const FEATURES = [
  {
    icon: "⚡",
    title: "3–5 Second Settlement",
    desc: "Stellar confirms transactions faster than a credit card swipe. Parents get instant proof of payment.",
  },
  {
    icon: "🔗",
    title: "On-Chain Immutability",
    desc: "Every payment is permanently recorded on a public blockchain. Receipts that can never be faked or lost.",
  },
  {
    icon: "🔄",
    title: "Zero Manual Reconciliation",
    desc: "Student IDs in the Stellar memo field automatically match every payment — no spreadsheets required.",
  },
  {
    icon: "💰",
    title: "$0.000001 Per Transaction",
    desc: "Forget 2.9% + 30¢. Stellar's fees are microscopic. Every dollar goes toward education.",
  },
  {
    icon: "🏫",
    title: "Multi-School Architecture",
    desc: "Fully isolated wallets, students, and records per institution. Scale from one school to a district.",
  },
  {
    icon: "📡",
    title: "Real-Time Notifications",
    desc: "Server-sent events push live payment confirmations to parents and admins the instant they land.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Parent opens the pay page",
    desc: "They see the school wallet address, their student's ID as a pre-filled memo, the exact amount owed, and accepted assets (XLM or USDC).",
  },
  {
    n: "2",
    title: "They send from any Stellar wallet",
    desc: "Lobstr, Solar, XBULL — any wallet works. The transaction hits the Stellar network and confirms in seconds.",
  },
  {
    n: "3",
    title: "StellarEduPay does the rest",
    desc: "The poller reads the blockchain, matches the memo to the student, validates the amount, marks the fee paid, and fires a webhook.",
  },
];

const STATS = [
  { v: "< 5s", l: "Settlement time" },
  { v: "$0.000001", l: "Per transaction" },
  { v: "100%", l: "On-chain verified" },
  { v: "0", l: "Manual steps" },
];

export default function Home() {
  return (
    <>
      <Head>
        <title>StellarEduPay — Blockchain School Fee Payments</title>
        <meta name="description" content="Instant, transparent, fraud-proof school fee payments on the Stellar blockchain. Auto-reconciliation via transaction memos." />
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
              Live on Stellar Testnet
            </div>

            <h1>
              School fees,<br />
              <em>settled in seconds.</em>
            </h1>

            <p className="lp-hero-sub">
              Blockchain-powered payments that eliminate manual reconciliation,
              prevent fraud, and give parents instant proof — for a fraction of a cent per transaction.
            </p>

            <div className="lp-hero-actions">
              <Link href="/pay-fees" className="btn-cta">
                Pay Fees Now
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </Link>
              <Link href="/dashboard" className="btn-ghost">
                View Dashboard
              </Link>
            </div>
          </div>

          <div className="lp-scroll-hint">
            <div className="lp-scroll-arrow">
              <div className="lp-scroll-ball" />
            </div>
            Scroll
          </div>
        </section>

        {/* ── STATS BAND ── */}
        <div className="lp-stats-band">
          <div className="lp-container">
            <div className="lp-stats-inner">
              {STATS.map(({ v, l }) => (
                <div key={l} className="lp-stat">
                  <span className="lp-stat-v">{v}</span>
                  <span className="lp-stat-l">{l}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── FEATURES ── */}
        <section className="lp-features">
          <div className="lp-container">
            <div className="lp-section-header">
              <span className="lp-eyebrow">Why StellarEduPay</span>
              <h2 className="lp-section-h2">Built for how schools<br />actually work.</h2>
              <p className="lp-section-p">No PDFs. No bank transfers. No chasing payments. Just transparent, instant, verifiable transactions on a public blockchain.</p>
            </div>
            <div className="lp-features-grid">
              {FEATURES.map(({ icon, title, desc }) => (
                <div key={title} className="lp-feat">
                  <span className="lp-feat-icon">{icon}</span>
                  <p className="lp-feat-title">{title}</p>
                  <p className="lp-feat-desc">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── TRUST STRIP ── */}
        <div className="lp-trust">
          <div className="lp-container">
            <span className="lp-trust-label">Built on proven technology</span>
            <div className="lp-trust-items">
              {[
                ["Stellar SDK v12", "⬡"],
                ["MongoDB Atlas-ready", "🍃"],
                ["BullMQ + Redis", "⚙"],
                ["JWT + TOTP MFA", "🔐"],
                ["Prometheus metrics", "📊"],
                ["OpenAPI documented", "📄"],
              ].map(([label, icon]) => (
                <div key={label} className="lp-trust-item">
                  <span>{icon}</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── HOW IT WORKS ── */}
        <section className="lp-how">
          <div className="lp-container">
            <div className="lp-section-header">
              <span className="lp-eyebrow">How It Works</span>
              <h2 className="lp-section-h2">Three steps.<br />One transaction.</h2>
              <p className="lp-section-p">Parents pay. Stellar confirms. StellarEduPay matches, validates, and records — automatically.</p>
            </div>
            <div className="lp-steps">
              {STEPS.map(({ n, title, desc }) => (
                <div key={n} className="lp-step">
                  <div className="lp-step-num">{n}</div>
                  <p className="lp-step-title">{title}</p>
                  <p className="lp-step-desc">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="lp-cta">
          <div className="lp-cta-inner">
            <h2>Ready to run on blockchain?</h2>
            <p>Everything is already live. Connect a school wallet, register students, and start accepting on-chain fee payments today.</p>
            <div className="lp-cta-btns">
              <Link href="/pay-fees" className="btn-cta">Start Paying Fees</Link>
              <Link href="/dashboard" className="btn-ghost">Admin Dashboard</Link>
            </div>
          </div>
        </section>

        {/* ── FOOTER ── */}
        <footer className="lp-footer">
          <div className="lp-footer-inner">
            <div className="lp-footer-brand">
              <div className="lp-footer-logo">S</div>
              <span className="lp-footer-name">StellarEduPay</span>
            </div>
            <span className="lp-footer-copy">© {new Date().getFullYear()} MIT License</span>
            <div className="lp-footer-links">
              <a href="https://stellar.org" target="_blank" rel="noopener noreferrer">Stellar</a>
              <a href="https://github.com/manuelusman73-png/StellarEduPay" target="_blank" rel="noopener noreferrer">GitHub</a>
              <Link href="/api/docs">API Docs</Link>
            </div>
          </div>
        </footer>

      </div>
    </>
  );
}
