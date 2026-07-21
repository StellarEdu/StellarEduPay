import Head from 'next/head';
import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAdminAuth } from '../hooks/useAdminAuth';
import { getErrorMessage } from '../utils/errorMessages';

// Only honour same-origin, absolute internal paths as a post-login destination.
// Anything else (external URLs, protocol-relative "//evil.com", missing) falls
// back to the dashboard — prevents open-redirect via the returnTo query param.
function safeReturnTo(returnTo) {
  if (typeof returnTo !== 'string') return '/dashboard';
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return '/dashboard';
  return returnTo;
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAdminAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(getErrorMessage(data.code, data.error)); return; }
      login();
      router.push(safeReturnTo(router.query.returnTo));
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head><title>Admin Login — StellarEduPay</title></Head>
      <style>{`
        .login-page {
          min-height: calc(100vh - 60px);
          background:
            radial-gradient(700px 400px at 50% -10%, rgba(5,150,105,0.16), transparent 60%),
            radial-gradient(600px 350px at 100% 100%, rgba(6,182,212,0.12), transparent 55%),
            #f6f7fb;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem 1rem;
        }
        .login-card {
          width: 100%;
          max-width: 410px;
          background: #fff;
          border-radius: 20px;
          border: 1px solid #e7e9f3;
          box-shadow: 0 24px 60px -20px rgba(49,46,129,0.35), 0 8px 20px -12px rgba(16,24,64,0.1);
          padding: 2.75rem 2.25rem;
          text-align: center;
        }
        .login-icon {
          width: 56px; height: 56px;
          background: linear-gradient(135deg, #059669 0%, #0d9488 100%);
          border-radius: 16px;
          display: flex; align-items: center; justify-content: center;
          font-size: 1.4rem;
          margin: 0 auto 1.5rem;
          box-shadow: 0 12px 28px -8px rgba(5,150,105,0.6);
        }
        .login-card h1 {
          font-size: 1.5rem !important;
          font-weight: 800 !important;
          color: #0f172a !important;
          letter-spacing: -0.03em;
          margin-bottom: 0.375rem !important;
        }
        .login-sub {
          font-size: 0.875rem;
          color: #64748b;
          margin-bottom: 2rem;
        }
        .login-field { margin-bottom: 1rem; text-align: left; }
        form { text-align: left; }
        .login-label {
          display: block;
          font-size: 0.8rem;
          font-weight: 600;
          color: #374151;
          margin-bottom: 0.375rem;
          letter-spacing: 0.01em;
        }
        .login-input {
          width: 100%;
          padding: 0.65rem 0.875rem;
          border: 1.5px solid #e2e8f0;
          border-radius: 8px;
          font-size: 0.95rem;
          color: #0f172a;
          background: #f8fafc;
          transition: border-color 0.15s, box-shadow 0.15s;
          outline: none;
          font-family: inherit;
        }
        .login-input:focus {
          border-color: #059669;
          box-shadow: 0 0 0 4px rgba(5,150,105,0.18);
          background: #fff;
        }
        .login-error {
          display: flex; align-items: center; gap: 0.5rem;
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 8px;
          color: #dc2626;
          font-size: 0.85rem;
          padding: 0.65rem 0.875rem;
          margin-bottom: 1rem;
        }
        .login-btn {
          width: 100%;
          background: linear-gradient(135deg, #059669 0%, #0d9488 100%);
          color: #fff;
          border: none;
          border-radius: 10px;
          font: 700 0.95rem/1 inherit;
          padding: 0.85rem;
          cursor: pointer;
          transition: filter 0.15s, transform 0.1s, box-shadow 0.15s;
          margin-top: 0.5rem;
          letter-spacing: -0.01em;
          box-shadow: 0 10px 24px -8px rgba(5,150,105,0.6);
        }
        .login-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
        .login-btn:active:not(:disabled) { transform: scale(0.99); }
        .login-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .login-btn-inner { display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
        .login-spinner {
          width: 1em; height: 1em;
          border: 2px solid rgba(255,255,255,0.4);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .login-input:disabled { opacity: 0.6; cursor: not-allowed; }
        .login-footer {
          text-align: center;
          margin-top: 1.5rem;
          font-size: 0.78rem;
          color: #94a3b8;
        }
        /* dark mode */
        html.dark .login-page { background: #0f172a; }
        html.dark .login-card { background: #1e293b; box-shadow: 0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06); }
        html.dark .login-card h1 { color: #f1f5f9 !important; }
        html.dark .login-sub { color: #64748b; }
        html.dark .login-label { color: #94a3b8; }
        html.dark .login-page {
          background:
            radial-gradient(700px 400px at 50% -10%, rgba(5,150,105,0.2), transparent 60%),
            radial-gradient(600px 350px at 100% 100%, rgba(6,182,212,0.14), transparent 55%),
            #0a0e1f;
        }
        html.dark .login-input { background: #0a0e1f; border-color: #25304d; color: #f1f5f9; }
        html.dark .login-input:focus { border-color: #34d399; background: #0a0e1f; box-shadow: 0 0 0 4px rgba(52,211,153,0.22); }
      `}</style>

      <div className="login-page">
        <div className="login-card">
          <div className="login-icon">🔐</div>
          <h1>Admin Login</h1>
          <p className="login-sub">Sign in to manage students, fees, and payments.</p>

          <form onSubmit={handleSubmit}>
            <div className="login-field">
              <label className="login-label" htmlFor="username">Username</label>
              <input
                id="username"
                className="login-input"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoComplete="username"
                autoFocus
                placeholder="admin"
                disabled={loading}
              />
            </div>

            <div className="login-field">
              <label className="login-label" htmlFor="password">Password</label>
              <input
                id="password"
                className="login-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="login-error" role="alert">
                <span>⚠</span> {error}
              </div>
            )}

            <button className="login-btn" type="submit" disabled={loading} aria-busy={loading}>
              <span className="login-btn-inner">
                {loading && <span className="login-spinner" aria-hidden="true" />}
                {loading ? 'Signing in…' : 'Sign in →'}
              </span>
            </button>
          </form>

          <p className="login-footer">StellarEduPay · Admin Portal</p>
        </div>
      </div>
    </>
  );
}
