'use strict';

/**
 * Tests for issue #1804 — fees are bare XLM numbers that swing with the market.
 * Schools need to price fees in fiat or USDC, and lock an XLM quote at payment
 * time.
 *
 * Current behaviour is that FeeStructure.feeAmount has no currency attached,
 * so the amount is treated as XLM. The feature is not built yet, so the
 * acceptance criteria below are todos.
 *
 * Acceptance criteria (from the issue):
 *  1. A school can set "Tuition: 50,000 NGN" (feeCurrency on FeeStructure). → todo
 *  2. POST /api/payments/intent returns a locked quote per accepted asset
 *     with quoteExpiresAt.                                               → todo
 *  3. A payment inside the quote window marks the fee paid even if the
 *     market moved.                                                     → todo
 *  4. Payments within ±X% of the quote are accepted as valid (configurable). → todo
 *  5. Reports are in the fee currency, with XLM/USDC breakdowns.        → todo
 */

describe("issue #1804 — fiat/USDC-denominated fees", () => {
  it.todo("FeeStructure accepts feeCurrency 'XLM' | 'USDC' | ISO-4217 fiat");
  it.todo("existing FeeStructure documents migrate to feeCurrency 'XLM'");
  it.todo("POST /api/payments/intent returns a quote with quoteExpiresAt per accepted asset");
  it.todo("a payment inside the quote window is credited at the quoted rate");
  it.todo("a payment after quote expiry is credited at the receipt-time rate");
  it.todo("creditedFiatAmount is stored and used for balances on fiat-denominated fees");
  it.todo("a payment within the configured tolerance of the quote is valid");
  it.todo("receipts include the locked rate");
  it.todo("reports are denominated in the fee currency with XLM/USDC breakdowns");
});
