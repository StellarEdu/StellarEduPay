'use strict';

/**
 * Tests for issue #1805 — students are identified through free-text memos,
 * which parents mistype or omit and which some exchanges do not support.
 * The proposal attributes payments through Stellar muxed accounts (CAP-27 /
 * SEP-23): a 64-bit ID encoded in the M… destination address.
 *
 * Muxed attribution is not built yet, so the acceptance criteria below are
 * todos. Memo matching is the current, working path and must keep working as
 * the fallback.
 *
 * Acceptance criteria (from the issue):
 *  1. A payment to a student's M… address with no memo is credited to that
 *     student.                                                         → todo
 *  2. A transaction with muxed destinations for several students credits each
 *     student, per operation.                                           → todo
 *  3. Memo matching remains as a compatibility fallback.               → todo
 */

describe("issue #1805 — muxed-account attribution", () => {
  it.todo("derives a deterministic muxed ID from (schoolId, studentId)");
  it.todo("derives an M… address from the school's G… account");
  it.todo("payment instructions and SEP-7 QR codes prefer the M… destination");
  it.todo("credits a payment to an M… address with no memo");
  it.todo("reads op.to_muxed_id before falling back to the memo");
  it.todo("credits each student in a multi-student transaction by opIndex");
  it.todo("keeps memo matching as the fallback path");
});
