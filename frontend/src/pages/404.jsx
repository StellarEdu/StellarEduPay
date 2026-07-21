import Link from "next/link";

export default function Custom404() {
  return (
    <>
      <style>{`
        .not-found-wrap {
          min-height: calc(100vh - 60px);
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg);
          padding: 2rem;
        }
        .not-found-card {
          text-align: center;
          max-width: 480px;
          width: 100%;
        }
        .not-found-code {
          font-size: clamp(5rem, 20vw, 8rem);
          font-weight: 900;
          letter-spacing: -0.06em;
          line-height: 1;
          background: linear-gradient(135deg, #34d399 0%, #059669 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-bottom: 1rem;
        }
        .not-found-title {
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--text);
          margin-bottom: 0.625rem;
          letter-spacing: -0.02em;
        }
        .not-found-desc {
          font-size: 0.9375rem;
          color: var(--text-muted);
          line-height: 1.65;
          margin-bottom: 2rem;
          max-width: 380px;
          margin-left: auto;
          margin-right: auto;
        }
        .not-found-actions {
          display: flex;
          gap: 0.75rem;
          justify-content: center;
          flex-wrap: wrap;
          margin-bottom: 2rem;
        }
        .not-found-links {
          padding-top: 1.75rem;
          border-top: 1px solid var(--border);
          display: flex;
          gap: 1.25rem;
          justify-content: center;
          flex-wrap: wrap;
        }
        .not-found-link {
          color: var(--text-muted);
          font-size: 0.875rem;
          transition: color 0.15s;
        }
        .not-found-link:hover { color: var(--accent); }
      `}</style>

      <div className="not-found-wrap">
        <div className="not-found-card">
          <div className="not-found-code" aria-label="404">404</div>
          <h1 className="not-found-title">Page Not Found</h1>
          <p className="not-found-desc">
            The page you&apos;re looking for doesn&apos;t exist. It may have been moved or the URL is incorrect.
          </p>

          <div className="not-found-actions">
            <Link href="/" className="btn btn-primary">
              ← Back to Home
            </Link>
            <Link href="/pay-fees" className="btn btn-ghost">
              Pay Fees
            </Link>
          </div>

          <div className="not-found-links">
            <Link href="/dashboard" className="not-found-link">Dashboard</Link>
            <Link href="/reports" className="not-found-link">Reports</Link>
            <Link href="/login" className="not-found-link">Admin Login</Link>
          </div>
        </div>
      </div>
    </>
  );
}
