import ERROR_MESSAGES, { getErrorMessage } from "../../utils/errorMessages";

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
});
