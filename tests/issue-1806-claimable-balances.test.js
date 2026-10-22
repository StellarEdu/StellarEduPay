'use strict';

/**
 * Tests for issue #1806 — payments that arrive as claimable balances are
 * invisible to crediting, which only considers `payment` operations.
 *
 * Claimable-balance discovery and claiming are not built yet, so the
 * acceptance criteria below are todos.
 *
 * Acceptance criteria (from the issue):
 *  1. Claimable balances for school wallets appear in the admin UI.     → todo
 *  2. A claimable balance is credited to the right student once claimed. → todo
 *  3. Balances nearing predicate expiry raise an alert.                  → todo
 */

describe("issue #1806 — claimable-balance crediting", () => {
  it.todo("polls GET /claimable_balances for each active school wallet");
  it.todo("handles create_claimable_balance operations in the school's transaction stream");
  it.todo("records claimable balances with asset, amount, sponsor, predicates and memo");
  it.todo("attributes a claimable balance through its creating transaction's memo");
  it.todo("does not credit a claimable balance until it is claimed");
  it.todo("submits claimClaimableBalance automatically when a school signer is held");
  it.todo("exposes a Claim action that returns an XDR for the school to sign");
  it.todo("alerts when a claimable balance predicate is close to expiring");
});
