import { useState, useEffect } from "react";
import { createPaymentPlan, getPaymentPlan, cancelPaymentPlan } from "../services/api";
import { IconAlertTriangle, IconCheck, IconX } from "./Icons";

export default function PaymentPlanForm({ student, onClose, onSave }) {
  const [mode, setMode] = useState("view"); // "view", "create", or "cancel"
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Create form state
  const [totalAmount, setTotalAmount] = useState("");
  const [installmentCount, setInstallmentCount] = useState("3");
  const [installments, setInstallments] = useState([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadPaymentPlan();
  }, [student?.studentId]);

  async function loadPaymentPlan() {
    setLoading(true);
    setError("");
    try {
      const { data } = await getPaymentPlan(student.studentId);
      setPlan(data);
      setMode("view");
    } catch (err) {
      if (err.response?.status === 404) {
        setPlan(null);
        setMode("create");
      } else {
        setError("Failed to load payment plan");
      }
    } finally {
      setLoading(false);
    }
  }

  function generateInstallments(amount, count) {
    const numCount = Math.max(1, Math.min(12, parseInt(count, 10) || 1));
    const perInstallment = amount / numCount;
    const today = new Date();
    const newInstallments = [];

    for (let i = 0; i < numCount; i++) {
      const dueDate = new Date(today);
      dueDate.setMonth(dueDate.getMonth() + (i + 1));
      newInstallments.push({
        amount: i === numCount - 1 ? amount - (perInstallment * i) : perInstallment,
        dueDate: dueDate.toISOString().split("T")[0],
      });
    }
    setInstallments(newInstallments);
  }

  function handleAmountChange(e) {
    const amt = parseFloat(e.target.value) || 0;
    setTotalAmount(amt);
    if (amt > 0 && installmentCount) {
      generateInstallments(amt, installmentCount);
    }
  }

  function handleInstallmentCountChange(e) {
    const count = e.target.value;
    setInstallmentCount(count);
    if (totalAmount && count) {
      generateInstallments(totalAmount, count);
    }
  }

  function handleInstallmentAmountChange(index, value) {
    const newInstallments = [...installments];
    newInstallments[index].amount = parseFloat(value) || 0;
    setInstallments(newInstallments);
  }

  function handleInstallmentDateChange(index, value) {
    const newInstallments = [...installments];
    newInstallments[index].dueDate = value;
    setInstallments(newInstallments);
  }

  async function handleCreatePlan(e) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!totalAmount || totalAmount <= 0) {
      setError("Total amount must be greater than 0");
      return;
    }

    if (installments.length === 0) {
      setError("At least one installment is required");
      return;
    }

    const validInstallments = installments.every(inst => inst.amount > 0 && inst.dueDate);
    if (!validInstallments) {
      setError("All installments must have an amount and due date");
      return;
    }

    setCreating(true);
    try {
      await createPaymentPlan(student.studentId, {
        totalAmount,
        installments: installments.map(inst => ({
          amount: inst.amount,
          dueDate: new Date(inst.dueDate).toISOString(),
        })),
      });
      setSuccess("Payment plan created successfully!");
      setTimeout(() => {
        loadPaymentPlan();
        if (onSave) onSave();
      }, 1000);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to create payment plan");
    } finally {
      setCreating(false);
    }
  }

  async function handleCancelPlan() {
    if (!window.confirm("Are you sure you want to cancel this payment plan?")) {
      return;
    }

    setError("");
    setSuccess("");
    setCreating(true);

    try {
      await cancelPaymentPlan(student.studentId);
      setSuccess("Payment plan cancelled successfully!");
      setTimeout(() => {
        loadPaymentPlan();
        if (onSave) onSave();
      }, 1000);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to cancel payment plan");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return <div style={{ padding: "1rem", textAlign: "center" }}>Loading payment plan...</div>;
  }

  return (
    <div style={{ marginTop: "2rem", paddingTop: "2rem", borderTop: "1px solid var(--border)" }}>
      <h3 style={{ marginTop: 0, marginBottom: "1rem" }}>Payment Plan</h3>

      {error && (
        <div
          role="alert"
          style={{
            background: "var(--danger-bg, #fee2e2)",
            border: "1px solid var(--danger-border, #fecaca)",
            borderRadius: "6px",
            padding: "0.75rem 1rem",
            color: "var(--danger-text, #991b1b)",
            marginBottom: "1rem",
            fontSize: "0.875rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <IconAlertTriangle size={16} />
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          style={{
            background: "var(--success-bg, #dcfce7)",
            border: "1px solid var(--success-border, #bbf7d0)",
            borderRadius: "6px",
            padding: "0.75rem 1rem",
            color: "var(--success-text, #166534)",
            marginBottom: "1rem",
            fontSize: "0.875rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <IconCheck size={16} />
          {success}
        </div>
      )}

      {mode === "view" && plan && (
        <div>
          <div style={{ marginBottom: "1.5rem", padding: "1rem", background: "var(--muted)", borderRadius: "6px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600 }}>
                  Total Amount
                </div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: "0.25rem" }}>
                  {plan.totalAmount.toFixed(2)} XLM
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600 }}>
                  Status
                </div>
                <div style={{
                  fontSize: "1.25rem",
                  fontWeight: 700,
                  marginTop: "0.25rem",
                  color: plan.status === "active" ? "var(--success)" : "var(--danger)",
                  textTransform: "capitalize",
                }}>
                  {plan.status}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600 }}>
                  Paid / Total
                </div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: "0.25rem" }}>
                  {plan.totalPaid?.toFixed(2) || 0} / {plan.totalAmount?.toFixed(2) || 0} XLM
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600 }}>
                  Remaining
                </div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: "0.25rem", color: "var(--warning)" }}>
                  {plan.remainingBalance?.toFixed(2) || 0} XLM
                </div>
              </div>
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.75rem" }}>Installments</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {plan.installments?.map((inst, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "30px 1fr 1fr 1fr",
                      gap: "0.75rem",
                      alignItems: "center",
                      padding: "0.75rem",
                      background: "var(--bg)",
                      borderRadius: "4px",
                      fontSize: "0.875rem",
                    }}
                  >
                    <div style={{ fontWeight: 600, color: "var(--text-muted)" }}>#{i + 1}</div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Amount</div>
                      <div style={{ fontWeight: 600 }}>{inst.amount?.toFixed(2) || 0} XLM</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Due Date</div>
                      <div style={{ fontWeight: 600 }}>
                        {inst.dueDate ? new Date(inst.dueDate).toLocaleDateString() : "—"}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Status</div>
                      <div style={{
                        fontWeight: 600,
                        color: inst.paid ? "var(--success)" : "var(--warning)",
                      }}>
                        {inst.paid ? "Paid" : "Pending"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {plan.status === "active" && (
            <button
              onClick={() => setMode("cancel")}
              disabled={creating}
              className="btn btn-sm btn-danger"
              style={{ width: "100%" }}
            >
              Cancel Plan
            </button>
          )}
        </div>
      )}

      {mode === "create" && !plan && (
        <form onSubmit={handleCreatePlan}>
          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
            }}>
              Total Amount (XLM) <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.0000001"
              value={totalAmount}
              onChange={handleAmountChange}
              placeholder="e.g., 500"
              required
              disabled={creating}
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                boxSizing: "border-box",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "inherit",
              }}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
            }}>
              Number of Installments <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <input
              type="number"
              min="1"
              max="12"
              value={installmentCount}
              onChange={handleInstallmentCountChange}
              placeholder="e.g., 3"
              required
              disabled={creating}
              style={{
                width: "100%",
                padding: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                boxSizing: "border-box",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "inherit",
              }}
            />
          </div>

          {installments.length > 0 && (
            <div style={{ marginBottom: "1.25rem" }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.75rem" }}>
                Installment Amounts & Due Dates
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {installments.map((inst, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "0.75rem",
                      padding: "0.75rem",
                      background: "var(--muted)",
                      borderRadius: "6px",
                    }}
                  >
                    <div>
                      <label style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "block" }}>
                        Amount #{i + 1}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.0000001"
                        value={inst.amount}
                        onChange={(e) => handleInstallmentAmountChange(i, e.target.value)}
                        required
                        disabled={creating}
                        style={{
                          width: "100%",
                          padding: "0.5rem",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                          boxSizing: "border-box",
                          marginTop: "0.25rem",
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontFamily: "inherit",
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "block" }}>
                        Due Date #{i + 1}
                      </label>
                      <input
                        type="date"
                        value={inst.dueDate}
                        onChange={(e) => handleInstallmentDateChange(i, e.target.value)}
                        required
                        disabled={creating}
                        style={{
                          width: "100%",
                          padding: "0.5rem",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                          boxSizing: "border-box",
                          marginTop: "0.25rem",
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontFamily: "inherit",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={creating}
            className="btn btn-primary"
            style={{ width: "100%", marginBottom: "0.5rem" }}
          >
            {creating ? "Creating..." : "Create Payment Plan"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="btn btn-ghost"
            style={{ width: "100%" }}
          >
            Cancel
          </button>
        </form>
      )}

      {mode === "cancel" && plan && (
        <div>
          <p style={{ marginBottom: "1rem", color: "var(--text-muted)" }}>
            Are you sure you want to cancel this payment plan? This action cannot be undone.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <button
              onClick={() => setMode("view")}
              disabled={creating}
              className="btn btn-ghost"
            >
              Back
            </button>
            <button
              onClick={handleCancelPlan}
              disabled={creating}
              className="btn btn-danger"
              aria-busy={creating}
            >
              {creating ? "Cancelling..." : "Confirm Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
