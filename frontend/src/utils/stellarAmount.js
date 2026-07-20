/**
 * Stellar amount utilities — client-side mirror of the backend's
 * `backend/src/utils/stellarAmount.js` (#1123).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND THE RULE THAT KEEPS IT HONEST
 * ─────────────────────────────────────────────────────────────────────────────
 * Stellar represents every amount as a signed 64-bit integer count of "stroops",
 * where 1 unit (XLM or USDC — both use 7 decimal places) = 10,000,000 stroops.
 * The backend converts to integer stroops (BigInt) for all monetary decisions so
 * a payment that exactly equals a fee is never judged short or over by an
 * IEEE-754 rounding artifact.
 *
 * Frontend forms used to validate amounts with their own looser rules — chiefly
 * `parseFloat(amount) > 0`. That accepted values the backend handles with
 * different precision semantics, so a user could type an amount the UI showed as
 * accepted, only to have it rejected or silently rounded once it reached backend
 * validation. `0.00000001` is the canonical example: parseFloat says it's a
 * positive number, but it is a *sub-stroop* amount that rounds to exactly zero
 * on the backend and is then rejected as non-positive.
 *
 * This module applies the same stroop-space rules on the client, so the two
 * layers agree on what a valid, correctly-rounded amount is.
 *
 * INVARIANT: this file's arithmetic must stay behaviourally identical to
 * `backend/src/utils/stellarAmount.js`. `tests/issue-1123-amount-precision-parity.test.js`
 * runs both implementations over a shared vector table plus a randomised sweep
 * and fails on any divergence. If you change one, change both.
 *
 * NOTE ON VALIDATION vs. CONVERSION: `toStroops` deliberately mirrors the
 * backend and rounds inputs with more than 7 decimal places (half-up). Forms
 * must not rely on that — they should call `validateStellarAmount`, which
 * *rejects* over-precise input outright rather than silently altering what the
 * user typed. Rounding is what the backend does with values that reach it;
 * refusing to send them is what the UI should do.
 */

export const DECIMALS = 7;
export const STROOPS_PER_UNIT = 10000000n; // 1e7

/**
 * Convert a decimal amount (string or JS number) to an exact integer number of
 * stroops as a BigInt. Fractional digits beyond 7 are rounded half-up, matching
 * Stellar's own precision rules and the backend implementation.
 *
 * @param {string|number|bigint} amount
 * @returns {bigint} stroops
 * @throws {TypeError} on null/empty/non-decimal input
 */
export function toStroops(amount) {
  if (typeof amount === "bigint") return amount;
  if (amount === null || amount === undefined || amount === "") {
    throw new TypeError(`Cannot convert ${amount} to stroops`);
  }

  // Use a fixed-point string so we never depend on float arithmetic. For a JS
  // number, toFixed gives a decimal string already rounded to 7 places.
  let str = typeof amount === "number" ? amount.toFixed(DECIMALS) : String(amount).trim();

  const negative = str.startsWith("-");
  if (negative) str = str.slice(1);

  if (!/^\d*(\.\d*)?$/.test(str) || str === "" || str === ".") {
    throw new TypeError(`Invalid amount for stroop conversion: ${amount}`);
  }

  const [intPart = "0", fracRaw = ""] = str.split(".");
  const frac = (fracRaw + "0".repeat(DECIMALS)).slice(0, DECIMALS);

  let stroops = BigInt(intPart || "0") * STROOPS_PER_UNIT + BigInt(frac || "0");

  // Round half-up if there are more than 7 fractional digits.
  if (fracRaw.length > DECIMALS && Number(fracRaw[DECIMALS]) >= 5) {
    stroops += 1n;
  }

  return negative ? -stroops : stroops;
}

/**
 * Convert integer stroops back to a 7-decimal-place decimal string.
 * @param {bigint|number|string} stroops
 * @returns {string}
 */
export function fromStroops(stroops) {
  const b = BigInt(stroops);
  const negative = b < 0n;
  const abs = negative ? -b : b;
  const intPart = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(DECIMALS, "0");
  return `${negative ? "-" : ""}${intPart}.${frac}`;
}

/**
 * Convert integer stroops to a JS number (7-decimal precision).
 * @param {bigint|number|string} stroops
 * @returns {number}
 */
export function stroopsToNumber(stroops) {
  return parseFloat(fromStroops(stroops));
}

/**
 * Compare two decimal amounts exactly in stroop space.
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareAmounts(a, b) {
  const sa = toStroops(a);
  const sb = toStroops(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** True iff the two amounts are exactly equal to the stroop. */
export function amountsEqual(a, b) {
  return compareAmounts(a, b) === 0;
}

/**
 * Normalize a raw amount to a JS number using exact stroop conversion.
 * Returns 0 for anything unparseable, mirroring the backend normalizer.
 * @param {string|number} rawAmount
 * @returns {number}
 */
export function normalizeToNumber(rawAmount) {
  if (rawAmount === null || rawAmount === undefined || rawAmount === "") return 0;
  try {
    return stroopsToNumber(toStroops(rawAmount));
  } catch (_) {
    return 0;
  }
}

/**
 * Count the fractional digits in a decimal input string, ignoring trailing
 * zeros (`1.50000000` is 1 significant decimal, not 8 — padding a value with
 * zeros doesn't make it over-precise).
 *
 * @param {string} str
 * @returns {number}
 */
function significantDecimals(str) {
  const dot = str.indexOf(".");
  if (dot === -1) return 0;
  return str.slice(dot + 1).replace(/0+$/, "").length;
}

/**
 * Validate a user-entered Stellar amount using the same precision rules the
 * backend applies, so the UI never accepts something the backend will reject or
 * silently round.
 *
 * Rejects, in order:
 *   - blank input
 *   - anything that isn't a plain decimal number (scientific notation such as
 *     `1e-8` included — `String()`/`parseFloat` accept it, the backend's stroop
 *     parser does not)
 *   - zero and negative amounts
 *   - more than 7 decimal places, which the backend would round rather than
 *     honour (`TOO_PRECISE`)
 *   - sub-stroop amounts that round to zero (`BELOW_MIN_STROOP`)
 *   - amounts outside the configured min/max, when supplied
 *
 * @param {string|number} input - Raw form value
 * @param {Object} [opts]
 * @param {string|number} [opts.min] - Inclusive minimum, compared in stroop space
 * @param {string|number} [opts.max] - Inclusive maximum, compared in stroop space
 * @returns {{valid: boolean, error?: string, code?: string, normalized?: string, stroops?: bigint}}
 *   On success, `normalized` is the canonical 7-decimal string safe to submit —
 *   equal in value to what the user typed, never rounded away from it.
 */
export function validateStellarAmount(input, opts = {}) {
  // A JS number has already lost any precision beyond a float, so mirror the
  // backend's contract for numbers exactly: fix to 7 dp. (Doing `String(n)`
  // instead would emit scientific notation for small values — String(1e-7) is
  // "1e-7" — and wrongly reject an amount that is precisely one stroop.)
  // String input is left verbatim so the TOO_PRECISE check below still sees
  // exactly what the user typed; form fields always hand us strings.
  const raw =
    typeof input === "number" && Number.isFinite(input)
      ? input.toFixed(DECIMALS)
      : String(input ?? "").trim();

  if (raw === "") {
    return { valid: false, error: "Amount is required", code: "REQUIRED" };
  }

  // The backend's stroop parser accepts only plain decimals. Reject anything
  // else here rather than letting the form submit a value that will throw or be
  // coerced server-side — notably scientific notation, which parseFloat happily
  // accepts and String() happily produces for very small numbers.
  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === "." || raw === "-" || raw === "-.") {
    return {
      valid: false,
      error: "Enter a plain decimal amount, e.g. 250.50",
      code: "INVALID_FORMAT",
    };
  }

  if (significantDecimals(raw) > DECIMALS) {
    return {
      valid: false,
      error: `Stellar supports at most ${DECIMALS} decimal places`,
      code: "TOO_PRECISE",
    };
  }

  let stroops;
  try {
    stroops = toStroops(raw);
  } catch (_) {
    return {
      valid: false,
      error: "Enter a plain decimal amount, e.g. 250.50",
      code: "INVALID_FORMAT",
    };
  }

  if (stroops <= 0n) {
    // Covers both an explicit 0/negative and a positive-looking sub-stroop
    // value that rounds to nothing — the exact case the old parseFloat check
    // let through to be rejected server-side.
    const wasPositive = !raw.startsWith("-") && /[1-9]/.test(raw);
    return wasPositive
      ? {
          valid: false,
          error: `Amount is smaller than the minimum of 0.${"0".repeat(DECIMALS - 1)}1`,
          code: "BELOW_MIN_STROOP",
        }
      : { valid: false, error: "Amount must be greater than zero", code: "INVALID_AMOUNT" };
  }

  if (opts.min !== undefined && opts.min !== null && compareAmounts(raw, opts.min) < 0) {
    return {
      valid: false,
      error: `Amount is below the minimum of ${opts.min}`,
      code: "AMOUNT_TOO_LOW",
    };
  }

  if (opts.max !== undefined && opts.max !== null && compareAmounts(raw, opts.max) > 0) {
    return {
      valid: false,
      error: `Amount exceeds the maximum of ${opts.max}`,
      code: "AMOUNT_TOO_HIGH",
    };
  }

  return { valid: true, normalized: fromStroops(stroops), stroops };
}
