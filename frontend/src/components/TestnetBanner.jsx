import { useTranslation } from "react-i18next";
import { useRuntimeConfig } from "../hooks/useRuntimeConfig";

/**
 * TestnetBanner — Issue #1583
 *
 * Reads the Stellar network from the runtime config (GET /api/public-config)
 * rather than from NEXT_PUBLIC_STELLAR_NETWORK which is baked into the bundle
 * at build time. This allows the same frontend image to work correctly for
 * both testnet and mainnet deployments.
 *
 * Also shows a warning banner when the build-time env var disagrees with the
 * runtime network reported by the backend — a misconfiguration that could
 * cause the frontend to render incorrect payment instructions.
 */
export default function TestnetBanner() {
  const { t } = useTranslation();
  const { stellarNetwork, loading, networkMismatch } = useRuntimeConfig();

  // Don't flash the banner while loading — avoids a layout shift on mainnet.
  if (loading) return null;

  // Mismatch warning: build-time env and runtime backend disagree. This is a
  // serious misconfiguration for a payments product — block payment instructions
  // with a prominent error instead of silently showing wrong network info.
  if (networkMismatch) {
    return (
      <div
        role="alert"
        style={{
          background: "#7f1d1d",
          color: "#fecaca",
          padding: "0.5rem 1.5rem",
          textAlign: "center",
          fontWeight: 700,
          fontSize: "0.8rem",
          letterSpacing: "0.02em",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.5rem",
          borderBottom: "2px solid #dc2626",
        }}
      >
        <span>⚠️</span>
        {t("components.networkMismatch") ||
          `Network mismatch: build-time env says "${process.env.NEXT_PUBLIC_STELLAR_NETWORK}" but backend reports "${stellarNetwork}". Payment instructions may be incorrect.`}
      </div>
    );
  }

  const isTestnet = stellarNetwork === "testnet";
  if (!isTestnet) return null;

  return (
    <div
      role="alert"
      style={{
        background: "#92400e",
        color: "#fef3c7",
        padding: "0.4rem 1.5rem",
        textAlign: "center",
        fontWeight: 600,
        fontSize: "0.78rem",
        letterSpacing: "0.02em",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        borderBottom: "1px solid rgba(0,0,0,0.15)",
      }}
    >
      <span style={{
        display: "inline-block",
        width: 7, height: 7,
        borderRadius: "50%",
        background: "#fbbf24",
        boxShadow: "0 0 0 3px rgba(251,191,36,0.3)",
        animation: "navBlink 2s ease-in-out infinite",
      }} />
      {t("components.testnetBanner")}
    </div>
  );
}
