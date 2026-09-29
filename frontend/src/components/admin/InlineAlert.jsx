/**
 * InlineAlert — small status banner for admin screens (#1581).
 * `tone` maps onto the existing .alert-* classes in globals.css.
 */
export default function InlineAlert({ tone = "danger", children, onDismiss, dismissLabel }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss} aria-label={dismissLabel}>
          ×
        </button>
      )}
    </div>
  );
}
