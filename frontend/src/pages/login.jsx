import Head from 'next/head';
import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAdminAuthContext } from '../hooks/AdminAuthContext';
import { getErrorMessage } from '../utils/errorMessages';
import api from '../services/api';
import { useTranslation } from 'react-i18next';
import styles from '../styles/login.module.css';

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
  const { login } = useAdminAuthContext();
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState(''); // username or email
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requiresMfa, setRequiresMfa] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Determine if identifier is email or username
      const isEmail = identifier.includes('@');
      const payload = isEmail
        ? { email: identifier, password, ...(mfaCode && { mfaCode }) }
        : { username: identifier, password, ...(mfaCode && { mfaCode }) };

      const res = await api.post('/auth/login', payload);
      
      // Check if MFA is required
      if (res.data?.requiresMfa) {
        setRequiresMfa(true);
        setLoading(false);
        return;
      }

      // Only call login() when authentication is complete
      if (res.status === 200 && !res.data?.requiresMfa) {
        login();
        if (res.data?.mfaSetupRequired) {
          router.push('/mfa-setup');
        } else {
          router.push(safeReturnTo(router.query.returnTo));
        }
      }
    } catch (err) {
      if (err.response) {
        const { code, error } = err.response.data || {};
        
        // Handle specific error codes
        if (code === 'ACCOUNT_LOCKED') {
          setError(t('auth.accountLocked') || 'Too many failed login attempts. Account temporarily locked.');
        } else if (code === 'INVALID_MFA_CODE') {
          setError(t('auth.invalidMfaCode') || 'Invalid MFA code. Please try again.');
        } else if (code === 'AUTH_MISCONFIGURED') {
          setError(t('auth.serverError') || 'Server configuration error. Please contact support.');
        } else {
          setError(getErrorMessage(code, error));
        }
      } else {
        setError(t('auth.networkError'));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head><title>{t("auth.title")} — {t("app.name")}</title></Head>

      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.icon}>🔐</div>
          <h1>{t("auth.title")}</h1>
          <p className={styles.sub}>{requiresMfa ? t("auth.mfaSubtitle") || "Enter your MFA code" : t("auth.subtitle")}</p>

          <form onSubmit={handleSubmit}>
            {!requiresMfa ? (
              <>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="identifier">{t("auth.emailOrUsername") || "Email or Username"}</label>
                  <input
                    id="identifier"
                    className={styles.input}
                    type="text"
                    value={identifier}
                    onChange={e => setIdentifier(e.target.value)}
                    required
                    autoComplete="username"
                    autoFocus
                    placeholder={t("auth.identifierPlaceholder") || "admin@school.com or admin"}
                    disabled={loading}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="password">{t("auth.password")}</label>
                  <input
                    id="password"
                    className={styles.input}
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder={t("auth.passwordPlaceholder")}
                    disabled={loading}
                  />
                </div>
              </>
            ) : (
              <>
                <div className={styles.mfaInfo}>
                  {t("auth.mfaRequired") || "Multi-factor authentication is enabled. Please enter your 6-digit code or backup code."}
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="mfaCode">{t("auth.mfaCode") || "MFA Code"}</label>
                  <input
                    id="mfaCode"
                    className={styles.input}
                    type="text"
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value)}
                    required
                    autoComplete="one-time-code"
                    autoFocus
                    placeholder={t("auth.mfaPlaceholder") || "000000"}
                    disabled={loading}
                    maxLength={12}
                  />
                </div>
              </>
            )}

            {error && (
              <div className={styles.error} role="alert">
                <span>⚠</span> {error}
              </div>
            )}

            <button className={styles.btn} type="submit" disabled={loading} aria-busy={loading}>
              <span className={styles.btnInner}>
                {loading && <span className={styles.spinner} aria-hidden="true" />}
                {loading ? t("auth.signingIn") : t("auth.signIn")}
              </span>
            </button>

            {requiresMfa && (
              <button
                type="button"
                className={styles.btn}
                style={{ marginTop: '0.5rem', background: '#6b7280' }}
                onClick={() => {
                  setRequiresMfa(false);
                  setMfaCode('');
                  setError('');
                }}
                disabled={loading}
              >
                {t("auth.back") || "Back"}
              </button>
            )}
          </form>

          <p className={styles.footer}>{t("auth.footer")}</p>
        </div>
      </div>
    </>
  );
}
