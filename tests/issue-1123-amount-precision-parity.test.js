'use strict';

/**
 * Issue #1123 — client/server amount-precision parity.
 *
 * The backend keeps a dedicated stellarAmount utility so monetary decisions
 * happen in exact integer stroop space (1 unit = 1e7 stroops) and never on JS
 * floats. Frontend forms used to validate amounts with their own looser rules —
 * chiefly `parseFloat(amount) > 0` — so a value the UI showed as accepted could
 * be rejected, silently rounded, or handled with different semantics once it
 * reached backend validation.
 *
 * These tests are the enforcement mechanism for the fix. They assert:
 *   1. PARITY — the frontend port and the backend original produce byte-identical
 *      results across a shared vector table and a randomised sweep. Drift in
 *      either file fails the build.
 *   2. THE ACCEPTANCE CRITERION — anything `validateStellarAmount` accepts is
 *      never subsequently rejected or altered by backend validation for
 *      precision reasons alone.
 *   3. REGRESSION — the specific inputs the old `parseFloat` check let through
 *      are now caught client-side.
 */

// Backend original (CommonJS) and frontend port (ESM, transpiled by babel-jest).
const backend = require('../backend/src/utils/stellarAmount');
const frontend = require('../frontend/src/utils/stellarAmount');

const { validateStellarAmount } = frontend;

// ── Shared vector table ──────────────────────────────────────────────────────
// Every value both implementations must agree on. Deliberately includes the
// nasty ones: exact stroop boundaries, half-up rounding ties, sub-stroop dust,
// long fractions, and floats with no exact binary representation.
const VECTORS = [
  '0',
  '0.0000001',            // exactly 1 stroop — the smallest representable amount
  '0.00000001',           // sub-stroop dust — rounds DOWN to 0
  '0.00000005',           // half-up tie at the stroop boundary — rounds UP to 1
  '0.00000004',           // just under the tie — rounds down
  '0.00000015',           // tie one stroop higher
  '0.1',
  '0.5',
  '1',
  '1.0000000',
  '1.5',
  '10.5',
  '99.9999999',
  '100.0000000',
  '100.00000004',         // over-precise, rounds down to 100.0000000
  '100.00000005',         // over-precise, rounds up by one stroop
  '250.5',
  '1000000',
  '0.1234567',
  '0.12345678',           // 8 dp
  '0.123456789012345',    // absurdly long fraction
  '-0.0000001',
  '-5',
  '-100.12345678',
  '922337203685.4775807', // max int64 stroops
  0,
  0.1,
  1.5,
  10.5,
  100,
  250.5,
  0.1 + 0.2,              // 0.30000000000000004 — the classic float artifact
  1e-7,
  3,
];

describe('#1123 — frontend/backend stellarAmount parity', () => {
  test.each(VECTORS.map(v => [String(v), v]))(
    'toStroops agrees on %s',
    (_label, value) => {
      let backendResult;
      let backendThrew = false;
      try {
        backendResult = backend.toStroops(value);
      } catch (_) {
        backendThrew = true;
      }

      let frontendResult;
      let frontendThrew = false;
      try {
        frontendResult = frontend.toStroops(value);
      } catch (_) {
        frontendThrew = true;
      }

      expect(frontendThrew).toBe(backendThrew);
      if (!backendThrew) expect(frontendResult).toBe(backendResult);
    },
  );

  test.each(VECTORS.map(v => [String(v), v]))(
    'normalizeToNumber agrees on %s',
    (_label, value) => {
      expect(frontend.normalizeToNumber(value)).toBe(backend.normalizeToNumber(value));
    },
  );

  test('fromStroops agrees across the stroop range', () => {
    const stroopValues = [0n, 1n, 5n, 9999999n, 10000000n, -1n, -10000000n, 9223372036854775807n];
    for (const s of stroopValues) {
      expect(frontend.fromStroops(s)).toBe(backend.fromStroops(s));
    }
  });

  test('compareAmounts agrees on every ordered pair in the vector table', () => {
    const comparable = VECTORS.filter(v => {
      try { backend.toStroops(v); return true; } catch (_) { return false; }
    });
    for (const a of comparable) {
      for (const b of comparable) {
        expect(frontend.compareAmounts(a, b)).toBe(backend.compareAmounts(a, b));
      }
    }
  });

  test('shared constants match', () => {
    expect(frontend.DECIMALS).toBe(backend.DECIMALS);
    expect(frontend.STROOPS_PER_UNIT).toBe(backend.STROOPS_PER_UNIT);
  });

  // Property sweep — a deterministic pseudo-random walk over amounts with 0–10
  // decimal places, which is where rounding divergence would actually hide.
  test('randomised sweep finds no divergence (5000 amounts)', () => {
    let seed = 1123;
    const rand = () => {
      // xorshift — deterministic so a failure is always reproducible.
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return Math.abs(seed) / 2147483648;
    };

    for (let i = 0; i < 5000; i++) {
      const intPart = Math.floor(rand() * 1000000);
      const decimals = Math.floor(rand() * 11); // 0–10 decimal places
      const fracPart = decimals
        ? String(Math.floor(rand() * 10 ** decimals)).padStart(decimals, '0')
        : '';
      const sign = rand() < 0.1 ? '-' : '';
      const amount = `${sign}${intPart}${fracPart ? `.${fracPart}` : ''}`;

      expect(frontend.toStroops(amount)).toBe(backend.toStroops(amount));
      expect(frontend.normalizeToNumber(amount)).toBe(backend.normalizeToNumber(amount));
    }
  });
});

describe('#1123 — validateStellarAmount rejects what the backend would alter', () => {
  test('accepts ordinary well-formed amounts', () => {
    for (const good of ['1', '0.0000001', '250.5', '100.0000000', '999999.9999999']) {
      expect(validateStellarAmount(good)).toMatchObject({ valid: true });
    }
  });

  test('rejects sub-stroop dust that parseFloat used to accept', () => {
    // parseFloat('0.00000001') > 0 is true, so the old check passed it through —
    // but it converts to 0 stroops and the backend then rejects it as non-positive.
    expect(parseFloat('0.00000001') > 0).toBe(true);
    expect(backend.normalizeToNumber('0.00000001')).toBe(0);

    const result = validateStellarAmount('0.00000001');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('TOO_PRECISE');
  });

  test('rejects scientific notation, which the backend stroop parser cannot read', () => {
    expect(parseFloat('1e-8') > 0).toBe(true);          // old check said fine
    expect(() => backend.toStroops('1e-8')).toThrow();  // backend cannot parse it

    expect(validateStellarAmount('1e-8')).toMatchObject({
      valid: false,
      code: 'INVALID_FORMAT',
    });
  });

  test('rejects more than 7 decimal places rather than silently rounding', () => {
    // The backend would round this up by a stroop. Silently changing what the
    // user typed is exactly the confusion this issue is about.
    expect(backend.normalizeToNumber('100.00000005')).toBe(100.0000001);

    expect(validateStellarAmount('100.00000005')).toMatchObject({
      valid: false,
      code: 'TOO_PRECISE',
    });
  });

  test('numeric input mirrors the backend rather than stringifying to exponent form', () => {
    // String(1e-7) is "1e-7", which would be rejected as INVALID_FORMAT — but
    // 1e-7 is precisely one stroop and the backend accepts it via toFixed(7).
    // Numbers must therefore take the same toFixed path the backend takes.
    expect(backend.toStroops(1e-7)).toBe(1n);
    expect(validateStellarAmount(1e-7)).toMatchObject({ valid: true, normalized: '0.0000001' });

    // The classic float artifact normalises rather than tripping TOO_PRECISE:
    // the excess digits are an artifact of the float, not user intent.
    expect(validateStellarAmount(0.1 + 0.2)).toMatchObject({ valid: true, normalized: '0.3000000' });

    // A numeric sub-stroop value still gets rejected — it rounds to nothing.
    expect(validateStellarAmount(1e-9).valid).toBe(false);
  });

  test('trailing zeros are not treated as excess precision', () => {
    // 1.50000000 is 8 written decimals but only 1 significant one — padding a
    // value with zeros must not make it invalid.
    expect(validateStellarAmount('1.50000000')).toMatchObject({ valid: true });
  });

  test('rejects zero, negatives and blanks', () => {
    expect(validateStellarAmount('0')).toMatchObject({ valid: false, code: 'INVALID_AMOUNT' });
    expect(validateStellarAmount('-5')).toMatchObject({ valid: false, code: 'INVALID_AMOUNT' });
    expect(validateStellarAmount('')).toMatchObject({ valid: false, code: 'REQUIRED' });
    expect(validateStellarAmount('abc')).toMatchObject({ valid: false, code: 'INVALID_FORMAT' });
  });

  test('honours min/max bounds in exact stroop space', () => {
    expect(validateStellarAmount('0.5', { min: 1 })).toMatchObject({ code: 'AMOUNT_TOO_LOW' });
    expect(validateStellarAmount('500', { max: 100 })).toMatchObject({ code: 'AMOUNT_TOO_HIGH' });
    // A value exactly on the boundary must pass — no epsilon may push it out.
    expect(validateStellarAmount('100', { min: 100, max: 100 })).toMatchObject({ valid: true });
    expect(validateStellarAmount('100.0000000', { min: '100' })).toMatchObject({ valid: true });
  });
});

describe('#1123 — acceptance criterion: accepted client-side ⇒ unaltered server-side', () => {
  const { validatePaymentAmount } = require('../backend/src/utils/paymentLimits');
  const { MIN_PAYMENT_AMOUNT, MAX_PAYMENT_AMOUNT } = require('../backend/src/config');

  /**
   * The headline guarantee: for any input the frontend accepts, the backend
   * must (a) not reject it for a precision reason, and (b) not change its
   * value. Both are checked in exact stroop space.
   */
  function assertRoundTripsUnaltered(input) {
    const clientResult = validateStellarAmount(input, {
      min: MIN_PAYMENT_AMOUNT,
      max: MAX_PAYMENT_AMOUNT,
    });
    if (!clientResult.valid) return; // rejected client-side — nothing submitted

    // (a) the backend's own limit validation agrees it is a valid amount
    const submitted = Number(clientResult.normalized);
    expect(validatePaymentAmount(submitted)).toMatchObject({ valid: true });

    // (b) the value survives the backend's stroop conversion completely intact
    expect(backend.toStroops(clientResult.normalized)).toBe(clientResult.stroops);
    expect(backend.normalizeToNumber(clientResult.normalized)).toBe(submitted);
    expect(backend.amountsEqual(clientResult.normalized, input)).toBe(true);
  }

  test.each(VECTORS.map(v => [String(v), v]))(
    'vector %s either fails client-side or round-trips unaltered',
    (_label, value) => assertRoundTripsUnaltered(value),
  );

  test('randomised sweep: no accepted amount is ever altered by the backend', () => {
    let seed = 424242;
    const rand = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return Math.abs(seed) / 2147483648;
    };

    for (let i = 0; i < 2000; i++) {
      const intPart = Math.floor(rand() * 10000);
      const decimals = Math.floor(rand() * 10);
      const fracPart = decimals
        ? String(Math.floor(rand() * 10 ** decimals)).padStart(decimals, '0')
        : '';
      assertRoundTripsUnaltered(`${intPart}${fracPart ? `.${fracPart}` : ''}`);
    }
  });
});
