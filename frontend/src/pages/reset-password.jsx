import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { resetPassword, requestPasswordReset } from '../services/api';

function readTokenFromFragment() {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash || '';
  if (!hash) return '';
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  return params.get('token') || '';
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPasswordValue] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // The token is delivered in the URL fragment so it never reaches server
    // logs or Referer headers; read it client-side only.
    const fragmentToken = readTokenFromFragment();
    setToken(fragmentToken);
    setTokenLoaded(true);
    if (fragmentToken && typeof window !== 'undefined') {
      // Strip the token from the address bar / history once captured.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  async function handleRequestReset(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await requestPasswordReset({ email });
      setRequestSent(true);
    } catch (err) {
      setError('Failed to send reset link. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setError('');

    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await resetPassword({ token, password });
      setSuccess(true);
      setTimeout(() => router.push('/login'), 3000);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to reset password.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <>
        <Head><title>Password Reset</title></Head>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ color: '#059669', marginBottom: '1rem' }}>✓ Password Reset Successfully</h1>
            <p>Redirecting to login...</p>
          </div>
        </div>
      </>
    );
  }

  if (requestSent) {
    return (
      <>
        <Head><title>Check Your Email</title></Head>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: '#f6f7fb' }}>
          <div style={{ width: '100%', maxWidth: '410px', background: '#fff', borderRadius: '20px', padding: '2.75rem 2.25rem', boxShadow: '0 4px 24px rgba(0,0,0,0.1)', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '0.5rem' }}>Check Your Email</h1>
            <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '2rem' }}>
              If an account exists with that email, you will receive a password reset link shortly.
            </p>
            <button
              onClick={() => router.push('/login')}
              style={{ background: 'linear-gradient(135deg, #059669 0%, #0d9488 100%)', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.85rem 1.5rem', cursor: 'pointer', fontSize: '0.95rem', fontWeight: '700' }}
            >
              Back to Login
            </button>
          </div>
        </div>
      </>
    );
  }

  if (!tokenLoaded) {
    return (
      <>
        <Head><title>Reset Password</title></Head>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: '#f6f7fb' }}>
          <p style={{ color: '#64748b' }}>Loading...</p>
        </div>
      </>
    );
  }

  if (!token) {
    // Request reset flow
    return (
      <>
        <Head><title>Reset Password</title></Head>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: '#f6f7fb' }}>
          <div style={{ width: '100%', maxWidth: '410px', background: '#fff', borderRadius: '20px', padding: '2.75rem 2.25rem', boxShadow: '0 4px 24px rgba(0,0,0,0.1)' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '0.5rem' }}>Reset Password</h1>
            <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '2rem' }}>Enter your email to receive a password reset link.</p>

            <form onSubmit={handleRequestReset}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.375rem' }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  style={{ width: '100%', padding: '0.65rem 0.875rem', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '0.95rem' }}
                  placeholder="your.email@example.com"
                  disabled={loading}
                />
              </div>

              {error && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '0.85rem', padding: '0.65rem 0.875rem', marginBottom: '1rem' }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{ width: '100%', background: 'linear-gradient(135deg, #059669 0%, #0d9488 100%)', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.85rem', cursor: 'pointer', fontSize: '0.95rem', fontWeight: '700', marginBottom: '0.75rem' }}
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>

              <button
                type="button"
                onClick={() => router.push('/login')}
                style={{ width: '100%', background: '#6b7280', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.85rem', cursor: 'pointer', fontSize: '0.95rem', fontWeight: '700' }}
              >
                Back to Login
              </button>
            </form>
          </div>
        </div>
      </>
    );
  }

  // Reset password with token flow
  return (
    <>
      <Head><title>Reset Password</title></Head>
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: '#f6f7fb' }}>
        <div style={{ width: '100%', maxWidth: '410px', background: '#fff', borderRadius: '20px', padding: '2.75rem 2.25rem', boxShadow: '0 4px 24px rgba(0,0,0,0.1)' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '0.5rem' }}>Reset Your Password</h1>
          <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '2rem' }}>Enter your new password below.</p>

          <form onSubmit={handleResetPassword}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.375rem' }}>New Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPasswordValue(e.target.value)}
                required
                style={{ width: '100%', padding: '0.65rem 0.875rem', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '0.95rem' }}
                placeholder="Min. 12 characters"
                disabled={loading}
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.375rem' }}>Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                style={{ width: '100%', padding: '0.65rem 0.875rem', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '0.95rem' }}
                placeholder="Re-enter password"
                disabled={loading}
              />
            </div>

            {error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '0.85rem', padding: '0.65rem 0.875rem', marginBottom: '1rem' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{ width: '100%', background: 'linear-gradient(135deg, #059669 0%, #0d9488 100%)', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.85rem', cursor: 'pointer', fontSize: '0.95rem', fontWeight: '700' }}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
