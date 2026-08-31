/**
 * SseDegradedBanner
 *
 * Renders a visible status strip for three SSE health states:
 *
 *   degraded         — backend signalled Redis pub/sub is unavailable; some
 *                      live events may not be delivered (Issue #1054).
 *   reconnecting     — client lost the SSE connection and is retrying with
 *                      exponential back-off (Issue #1078).
 *   failed           — back-off retries exhausted; user should refresh to
 *                      restore live updates (Issue #1078).
 *
 * Issue #1404: When on the pay-fees page and the connection is degraded, a
 * 'Verify payment manually' link is displayed to guide parents to manual
 * verification. Countdown timer shows estimated reconnection time.
 *
 * Usage:
 *   import SseDegradedBanner from '../components/SseDegradedBanner';
 *   <SseDegradedBanner degraded={degraded} connectionStatus={connectionStatus} onManualVerify={handleClick} retryCountdown={seconds} />
 */
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

const STYLES = {
  base: {
    padding: '0.5rem 1.5rem',
    textAlign: 'center',
    fontWeight: 600,
    fontSize: '0.8rem',
    letterSpacing: '0.01em',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.55rem',
    borderBottom: '1px solid rgba(0,0,0,0.2)',
    zIndex: 1000,
    flexWrap: 'wrap',
  },
  degraded:     { background: '#7c2d12', color: '#fef2f2' },
  reconnecting: { background: '#78350f', color: '#fef3c7' },
  failed:       { background: '#1e1b4b', color: '#e0e7ff' },
};

function Dot({ color }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

export default function SseDegradedBanner({ degraded, connectionStatus, onManualVerify, retryCountdown }) {
  const { t } = useTranslation();
  const [countdown, setCountdown] = useState(retryCountdown);

  useEffect(() => {
    setCountdown(retryCountdown);
  }, [retryCountdown]);

  useEffect(() => {
    if (countdown === undefined || countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  if (connectionStatus === 'failed') {
    return (
      <div role="alert" aria-live="assertive" style={{ ...STYLES.base, ...STYLES.failed }}>
        <Dot color="#a5b4fc" />
        <span>{t("degradedBanner.failed")}</span>
        {onManualVerify && (
          <button
            type="button"
            onClick={onManualVerify}
            style={{
              background: 'rgba(255,255,255,0.2)',
              color: 'inherit',
              border: '1px solid rgba(255,255,255,0.3)',
              padding: '0.25rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.75rem',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {t("degradedBanner.verifyManually")}
          </button>
        )}
      </div>
    );
  }

  if (connectionStatus === 'reconnecting') {
    return (
      <div role="status" aria-live="polite" style={{ ...STYLES.base, ...STYLES.reconnecting }}>
        <Dot color="#fcd34d" />
        <span>
          {t("degradedBanner.reconnecting")}
          {countdown !== undefined && countdown > 0 && ` (${countdown}s)`}
        </span>
        {onManualVerify && (
          <button
            type="button"
            onClick={onManualVerify}
            style={{
              background: 'rgba(0,0,0,0.1)',
              color: 'inherit',
              border: '1px solid rgba(0,0,0,0.2)',
              padding: '0.25rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.75rem',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {t("degradedBanner.verifyManually")}
          </button>
        )}
      </div>
    );
  }

  if (!degraded) return null;

  return (
    <div role="alert" aria-live="polite" style={{ ...STYLES.base, ...STYLES.degraded }}>
      <Dot color="#fca5a5" />
      <span>{t("degradedBanner.degraded")}</span>
      {onManualVerify && (
        <button
          type="button"
          onClick={onManualVerify}
          style={{
            background: 'rgba(255,255,255,0.1)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.2)',
            padding: '0.25rem 0.75rem',
            borderRadius: '4px',
            fontSize: '0.75rem',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {t("degradedBanner.verifyManually")}
        </button>
      )}
    </div>
  );
}
