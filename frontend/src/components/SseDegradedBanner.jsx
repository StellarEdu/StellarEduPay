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
 * Usage:
 *   import SseDegradedBanner from '../components/SseDegradedBanner';
 *   <SseDegradedBanner degraded={degraded} connectionStatus={connectionStatus} />
 */
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

export default function SseDegradedBanner({ degraded, connectionStatus }) {
  const { t } = useTranslation();

  if (connectionStatus === 'failed') {
    return (
      <div role="alert" aria-live="assertive" style={{ ...STYLES.base, ...STYLES.failed }}>
        <Dot color="#a5b4fc" />
        {t("degradedBanner.failed")}
      </div>
    );
  }

  if (connectionStatus === 'reconnecting') {
    return (
      <div role="status" aria-live="polite" style={{ ...STYLES.base, ...STYLES.reconnecting }}>
        <Dot color="#fcd34d" />
        {t("degradedBanner.reconnecting")}
      </div>
    );
  }

  if (!degraded) return null;

  return (
    <div role="alert" aria-live="polite" style={{ ...STYLES.base, ...STYLES.degraded }}>
      <Dot color="#fca5a5" />
      {t("degradedBanner.degraded")}
    </div>
  );
}
