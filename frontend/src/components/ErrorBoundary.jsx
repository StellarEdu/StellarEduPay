import { Component } from "react";
import Link from "next/link";
import { withTranslation } from "react-i18next";

class ErrorBoundary extends Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { t } = this.props;
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "2rem",
          textAlign: "center",
          fontFamily: "Inter, sans-serif",
          color: "var(--text, #0f172a)",
        }}>
          <div style={{ fontSize: "3rem" }}>⚠️</div>
          <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700 }}>{t("errorBoundary.title")}</h2>
          <p style={{ margin: 0, color: "var(--text-muted, #64748b)", maxWidth: "360px" }}>
            {t("errorBoundary.body")}
          </p>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "8px",
                border: "none",
                background: "var(--grad-brand, #059669)",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("errorBoundary.reload")}
            </button>
            <button
              onClick={() => {
                const onNavigated = () => {
                  this.setState({ hasError: false, error: null });
                };
                window.addEventListener("popstate", onNavigated, { once: true });
                window.history.back();
              }}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "8px",
                border: "1px solid var(--border, #e7e9f3)",
                background: "var(--card-bg, #fff)",
                color: "var(--text, #0f172a)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("errorBoundary.goBack")}
            </button>
            <Link
              href="/"
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "8px",
                border: "1px solid var(--border, #e7e9f3)",
                background: "var(--card-bg, #fff)",
                color: "var(--text, #0f172a)",
                fontWeight: 600,
                textDecoration: "none",
                lineHeight: "1.5",
              }}
            >
              {t("errorBoundary.goHome")}
            </Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default withTranslation()(ErrorBoundary);
