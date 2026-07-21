// Centered, gradient page header used across app pages.
export default function PageHero({ eyebrow, title, subtitle, children }) {
  return (
    <div className="page-hero animate-fade-up">
      {eyebrow && (
        <span className="page-hero-eyebrow">
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "currentColor", display: "inline-block",
          }} />
          {eyebrow}
        </span>
      )}
      <h1 className="page-hero-title gradient-text">{title}</h1>
      {subtitle && <p className="page-hero-sub">{subtitle}</p>}
      {children && <div className="page-hero-actions">{children}</div>}
    </div>
  );
}

// Gradient palettes for colourful stat cards
export const STAT_GRADIENTS = {
  indigo: { grad: "linear-gradient(135deg, #059669, #0d9488)", shadow: "rgba(5,150,105,0.5)", text: "#059669" },
  cyan:   { grad: "linear-gradient(135deg, #22d3ee, #3b82f6)", shadow: "rgba(34,211,238,0.5)", text: "#0891b2" },
  green:  { grad: "linear-gradient(135deg, #34d399, #10b981)", shadow: "rgba(16,185,129,0.5)", text: "#059669" },
  amber:  { grad: "linear-gradient(135deg, #fbbf24, #f59e0b)", shadow: "rgba(245,158,11,0.5)", text: "#d97706" },
  rose:   { grad: "linear-gradient(135deg, #fb7185, #f43f5e)", shadow: "rgba(244,63,94,0.5)",  text: "#e11d48" },
  violet: { grad: "linear-gradient(135deg, #a78bfa, #8b5cf6)", shadow: "rgba(139,92,246,0.5)", text: "#7c3aed" },
};

export function StatCard({ label, value, sub, Icon, color = "indigo" }) {
  const g = STAT_GRADIENTS[color] || STAT_GRADIENTS.indigo;
  return (
    <div className="stat-card" style={{ "--stat-accent": g.text }}>
      <div
        className="stat-card-icon-wrap"
        style={{ background: g.grad, "--stat-shadow": g.shadow }}
      >
        {Icon && <Icon size={19} />}
      </div>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}
