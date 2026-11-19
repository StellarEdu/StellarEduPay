/**
 * @jest-environment jsdom
 */

/**
 * #1937 — /pay/link/[token]: a parent opens a signed link and sees the school
 * wallet and memo, or a clear message when the link is expired or revoked.
 */

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PayWithLink from "../../pages/pay/link/[token]";
import { getPayLinkInstructions } from "../../services/api";

global.IS_REACT_ACT_ENVIRONMENT = true;

let mockQuery = { token: "tok-123" };
jest.mock("next/router", () => ({
  useRouter: () => ({ query: mockQuery }),
}));
jest.mock("next/head", () => ({ children }) => <>{children}</>);
jest.mock("../../services/api", () => ({
  getPayLinkInstructions: jest.fn(),
}));

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PayWithLink />);
  });
  // Let pending promise callbacks run and flush the resulting state update.
  await act(async () => {
    await Promise.resolve();
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("PayWithLink (#1937)", () => {
  beforeEach(() => {
    mockQuery = { token: "tok-123" };
    getPayLinkInstructions.mockReset();
    document.body.innerHTML = "";
  });

  test("shows wallet, memo and fee for a valid link", async () => {
    getPayLinkInstructions.mockResolvedValue({
      data: {
        schoolName: "Riverside Academy",
        walletAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        memo: "STU-0001",
        memoType: "text",
        maskedName: "J*** S.",
        class: "JSS1",
        feeAmount: 100,
        fees: [{ category: "tuition", amount: 100, totalPaid: 40, remainingBalance: "60.0000000" }],
      },
    });

    const { container, unmount } = await renderPage();

    expect(container.textContent).toContain("Riverside Academy");
    expect(container.textContent).toContain("STU-0001");
    expect(container.textContent).toContain("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(container.textContent).toContain("tuition");
    expect(getPayLinkInstructions).toHaveBeenCalledWith("tok-123", expect.any(Object));
    await unmount();
  });

  test.each([
    ["PAY_LINK_EXPIRED", /expired/i],
    ["PAY_LINK_REVOKED", /replaced or revoked/i],
    ["PAY_LINK_INVALID", /not valid/i],
  ])("maps %s to a specific message", async (code, pattern) => {
    getPayLinkInstructions.mockRejectedValue({ response: { status: 401, data: { code } } });

    const { container, unmount } = await renderPage();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toMatch(pattern);
    await unmount();
  });

  test("falls back to a generic message for unknown failures", async () => {
    getPayLinkInstructions.mockRejectedValue(new Error("network down"));

    const { container, unmount } = await renderPage();

    expect(container.querySelector('[role="alert"]').textContent).toMatch(/could not load/i);
    await unmount();
  });

  test("does not call the API until the token route param is available", async () => {
    mockQuery = {};
    const { unmount } = await renderPage();
    expect(getPayLinkInstructions).not.toHaveBeenCalled();
    await unmount();
  });
});
