import { Component } from "react";

export default class ErrorBoundary extends Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
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
          <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700 }}>Something went wrong</h2>
          <p style={{ margin: 0, color: "var(--text-muted, #64748b)", maxWidth: "360px" }}>
            An unexpected error occurred. You can try reloading the page or go back to safety.
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
              Reload page
            </button>
            <button
              onClick={() => { window.history.back(); this.setState({ hasError: false, error: null }); }}
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
              Go back
            </button>
            <a
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
              Go home
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
