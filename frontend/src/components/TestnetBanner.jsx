import { useTranslation } from "react-i18next";

export default function TestnetBanner() {
  const { t } = useTranslation();
  const isTestnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "testnet";
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
      <style>{`@keyframes navBlink { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}
