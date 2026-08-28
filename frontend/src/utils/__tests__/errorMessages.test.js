import ERROR_MESSAGES, { getErrorMessage, tr } from "../../utils/errorMessages";
import { parseStellarError } from "../../utils/stellarErrors";

describe("errorMessages — issue #612", () => {
  it("maps DUPLICATE_STUDENT to human-readable message", () => {
    expect(getErrorMessage("DUPLICATE_STUDENT")).toBe(
      "A student with this ID already exists."
    );
  });

  it("maps SYNC_IN_PROGRESS to human-readable message", () => {
    expect(getErrorMessage("SYNC_IN_PROGRESS")).toBe(
      "A sync is already in progress. Please wait and try again."
    );
  });

  it("returns fallback raw message when code has no mapping", () => {
    expect(getErrorMessage("UNKNOWN_CODE", "Something went wrong")).toBe(
      "Something went wrong"
    );
  });

  it("returns generic message when code and fallback are both absent", () => {
    expect(getErrorMessage(undefined, undefined)).toBe(
      "An unexpected error occurred. Please try again."
    );
  });

  it("returns generic message when code is unknown and fallback is empty", () => {
    expect(getErrorMessage("UNKNOWN_CODE", "")).toBe(
      "An unexpected error occurred. Please try again."
    );
  });

  it("maps STUDENT_ID_GENERATION_FAILED", () => {
    expect(getErrorMessage("STUDENT_ID_GENERATION_FAILED")).toBe(
      "Could not generate a student ID. Please try again."
    );
  });

  it("maps RATE_LIMIT_EXCEEDED", () => {
    expect(getErrorMessage("RATE_LIMIT_EXCEEDED")).toBe(
      "Too many requests. Please slow down and try again."
    );
  });

  it("maps INVALID_CREDENTIALS", () => {
    expect(getErrorMessage("INVALID_CREDENTIALS")).toBe(
      "Incorrect email or password."
    );
  });

  it("maps DISPUTE_ALREADY_EXISTS", () => {
    expect(getErrorMessage("DISPUTE_ALREADY_EXISTS")).toBe(
      "A dispute for this transaction already exists."
    );
  });

  it("exports a non-empty ERROR_MESSAGES object", () => {
    expect(typeof ERROR_MESSAGES).toBe("object");
    expect(Object.keys(ERROR_MESSAGES).length).toBeGreaterThan(0);
  });

  it("tr() falls back to the English fallback when the i18n key is missing", () => {
    // Translation infra (issue #1420): when a key is absent from all locales,
    // i18next returns the key itself; tr() must return the English fallback.
    expect(tr("errors.NOT_A_REAL_CODE", "Custom fallback message")).toBe(
      "Custom fallback message"
    );
  });
});

// #1216 — Stellar-specific codes must resolve through the single source of
// truth in errorMessages.js so every form shows identical text for the same
// backend error.
describe("errorMessages — #1216 Stellar / Horizon codes", () => {
  it("maps STELLAR_NETWORK_ERROR", () => {
    expect(getErrorMessage("STELLAR_NETWORK_ERROR")).toBe(
      "The Stellar network is currently unavailable. Please try again later."
    );
  });

  it("maps HORIZON_UNREACHABLE", () => {
    expect(getErrorMessage("HORIZON_UNREACHABLE")).toBe(
      "The Stellar network is temporarily unavailable. Please check the network status and try again later."
    );
  });

  it("maps HORIZON_UNAVAILABLE to the same text as HORIZON_UNREACHABLE", () => {
    // Both codes represent the same failure from the user's perspective.
    expect(getErrorMessage("HORIZON_UNAVAILABLE")).toBe(
      getErrorMessage("HORIZON_UNREACHABLE")
    );
  });

  it("maps tx_insufficient_fee (Stellar SDK result code)", () => {
    const msg = getErrorMessage("tx_insufficient_fee");
    expect(msg).toContain("congested");
    expect(msg).toContain("fee");
  });

  it("maps op_underfunded (Stellar SDK result code)", () => {
    const msg = getErrorMessage("op_underfunded");
    expect(msg).toContain("XLM");
    expect(msg).toContain("balance");
  });

  // Verify parseStellarError delegates to errorMessages.js and the returned
  // messages are identical to a direct getErrorMessage() call — this is the
  // contract that closes the divergence reported in #1216.
  describe("parseStellarError delegates to errorMessages.js", () => {
    function makeAxiosErr(code, error) {
      return { response: { data: { code, error } } };
    }

    it("STELLAR_NETWORK_ERROR: parseStellarError message === getErrorMessage(code)", () => {
      const result = parseStellarError(makeAxiosErr("STELLAR_NETWORK_ERROR", ""));
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("STELLAR_NETWORK_ERROR"));
    });

    it("HORIZON_UNREACHABLE: parseStellarError message === getErrorMessage(code)", () => {
      const result = parseStellarError(makeAxiosErr("HORIZON_UNREACHABLE", ""));
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("HORIZON_UNREACHABLE"));
    });

    it("HORIZON_UNAVAILABLE: parseStellarError message === getErrorMessage(code)", () => {
      const result = parseStellarError(makeAxiosErr("HORIZON_UNAVAILABLE", ""));
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("HORIZON_UNAVAILABLE"));
    });

    it("tx_insufficient_fee: parseStellarError message === getErrorMessage(code)", () => {
      const result = parseStellarError(makeAxiosErr("tx_insufficient_fee", ""));
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("tx_insufficient_fee"));
    });

    it("op_underfunded: parseStellarError message === getErrorMessage(code)", () => {
      const result = parseStellarError(makeAxiosErr("op_underfunded", ""));
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("op_underfunded"));
    });

    it("returns null for a non-Stellar error code", () => {
      const result = parseStellarError(makeAxiosErr("VALIDATION_ERROR", "bad input"));
      expect(result).toBeNull();
    });

    it("surfaces stellarStatusUrl for STELLAR_NETWORK_ERROR", () => {
      const result = parseStellarError(makeAxiosErr("STELLAR_NETWORK_ERROR", ""));
      expect(result.stellarStatusUrl).toBe("https://status.stellar.org");
    });

    it("does not surface stellarStatusUrl for op_underfunded", () => {
      const result = parseStellarError(makeAxiosErr("op_underfunded", ""));
      expect(result.stellarStatusUrl).toBeNull();
    });

    it("keyword fallback: 'horizon' in message resolves to HORIZON_UNREACHABLE text", () => {
      const err = { response: { data: { code: "", error: "horizon is down" } } };
      const result = parseStellarError(err);
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("HORIZON_UNREACHABLE"));
    });

    it("keyword fallback: 'tx_insufficient_fee' in message resolves correctly", () => {
      const err = { response: { data: { code: "", error: "tx_insufficient_fee encountered" } } };
      const result = parseStellarError(err);
      expect(result).not.toBeNull();
      expect(result.message).toBe(getErrorMessage("tx_insufficient_fee"));
    });
  });
});
