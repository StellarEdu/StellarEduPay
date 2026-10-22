import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { setPassword } from '../services/api';

function readTokenFromHash(hash) {
  if (!hash) return '';
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  return params.get('token') || '';
}

export default function SetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [password, setPasswordValue] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fromHash = readTokenFromHash(window.location.hash);
    if (fromHash) {
      setToken(fromHash);
      // Strip the token from the address bar so it is not kept in history.
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [router.asPath]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('This link is missing or has an invalid token. Please request a new invitation.');
      return;
    }

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
      await setPassword({ token, password });
      setToken('');
      setSuccess(true);
      setTimeout(() => router.push('/login'), 3000);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to set password.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <>
        <Head><title>Password Set</title></Head>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ color: '#059669', marginBottom: '1rem' }}>✓ Password Set Successfully</h1>
            <p>Redirecting to login...</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Head><title>Set Password</title></Head>
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: '#f6f7fb' }}>
        <div style={{ width: '100%', maxWidth: '410px', background: '#fff', borderRadius: '20px', padding: '2.75rem 2.25rem', boxShadow: '0 4px 24px rgba(0,0,0,0.1)' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '0.5rem' }}>Set Your Password</h1>
          <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '2rem' }}>Choose a secure password for your account.</p>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.375rem' }}>Password</label>
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
              {loading ? 'Setting Password...' : 'Set Password'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
