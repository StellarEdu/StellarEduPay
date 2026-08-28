import {
  PAYMENT_STATUS,
  PAYMENT_STATUS_LABELS,
  TERMINAL_STATUSES,
  getPaymentStatusLabel,
  isTerminalStatus,
} from "../../utils/paymentStatus";

describe("paymentStatus constants — issue #72", () => {
  it("mirrors the backend payment status contract", () => {
    expect(PAYMENT_STATUS).toEqual({
      PENDING: "PENDING",
      SUBMITTED: "SUBMITTED",
      SUCCESS: "SUCCESS",
      FAILED: "FAILED",
      DISPUTED: "DISPUTED",
      REFUNDED: "REFUNDED",
      INVALID: "INVALID",
    });
    expect(Object.isFrozen(PAYMENT_STATUS)).toBe(true);
  });

  it("maps every status constant to a human-readable label", () => {
    expect(PAYMENT_STATUS_LABELS[PAYMENT_STATUS.PENDING]).toBe("Pending");
    expect(PAYMENT_STATUS_LABELS[PAYMENT_STATUS.SUCCESS]).toBe("Success");
    expect(PAYMENT_STATUS_LABELS[PAYMENT_STATUS.INVALID]).toBe("Invalid");
    expect(Object.isFrozen(PAYMENT_STATUS_LABELS)).toBe(true);
    expect(Object.isFrozen(TERMINAL_STATUSES)).toBe(true);
  });

  it("classifies terminal statuses", () => {
    for (const s of ["SUCCESS", "FAILED", "REFUNDED", "INVALID"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    for (const s of ["PENDING", "SUBMITTED", "DISPUTED"]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe("paymentStatus labels — i18n (issue #1420)", () => {
  it("localizes known payment statuses through i18n", () => {
    expect(getPaymentStatusLabel("PENDING")).toBe("Pending");
    expect(getPaymentStatusLabel("SUCCESS")).toBe("Success");
    expect(getPaymentStatusLabel("DISPUTED")).toBe("Disputed");
  });

  it("falls back to the raw value for unknown statuses", () => {
    expect(getPaymentStatusLabel("WEIRD_STATE")).toBe("WEIRD_STATE");
  });

  it("falls back to Unknown when status is null or undefined", () => {
    expect(getPaymentStatusLabel(null)).toBe("Unknown");
    expect(getPaymentStatusLabel(undefined)).toBe("Unknown");
  });
});