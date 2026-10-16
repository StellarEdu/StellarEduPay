/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (key === "paymentForm.qrAria" && opts) {
        return `QR code to pay ${opts.amount} XLM to ${opts.address}, memo ${opts.memo}`;
      }
      if (key === "paymentForm.memoRequiredBadge") {
        return "Memo / reference — REQUIRED";
      }
      if (key === "paymentForm.memoExchangeWarning") {
        return "Always include this exact memo when sending from an exchange or wallet so your payment can be matched to the student.";
      }
      if (key === "paymentForm.copiedWalletAnnouncement") {
        return "Wallet address copied to clipboard";
      }
      if (key === "paymentForm.copiedMemoAnnouncement") {
        return "Memo copied to clipboard";
      }
      return key;
    },
  }),
}));

jest.mock("../../i18n", () => ({ t: (key) => key }));
jest.mock("../PaymentPlanForm", () => () => null);
jest.mock("../DisputeForm", () => () => null);
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value, "aria-label": ariaLabel, role }) => (
    <svg data-testid="qr-code-svg" data-value={value} role={role} aria-label={ariaLabel} />
  ),
}));

jest.mock("../../services/api", () => ({
  getStudent: jest.fn(),
  getPublicStudent: jest.fn(),
  getPaymentInstructions: jest.fn(),
  getStudentPayments: jest.fn(),
  getStudentBalance: jest.fn(),
  getPaymentRefunds: jest.fn(),
  verifyPayment: jest.fn(),
  updateStudent: jest.fn(),
}));

import PaymentForm, { groupMonospaceValue } from "../PaymentForm";
import VerifyPayment from "../VerifyPayment";
import StudentForm from "../StudentForm";

const api = require("../../services/api");

const TEST_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TEST_TX_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(navigator, {
    clipboard: {
      writeText: jest.fn(() => Promise.resolve()),
    },
  });
});

describe("Payment flow accessibility (#1832)", () => {
  it("groups Stellar addresses and hashes into 4-character visual chunks while keeping raw value intact", () => {
    const grouped = groupMonospaceValue(TEST_ADDRESS);
    expect(grouped).toBe(
      "GBBD 47IF 6LWK 7P7M DEVS CWR7 DPUW V3NY 3DTQ EVFL 4NAT 4AQH 3ZLL FLA5"
    );
    expect(grouped.replace(/\s+/g, "")).toBe(TEST_ADDRESS);
  });

  it("renders descriptive QR aria-label, memo REQUIRED indicator with exchange warning, and announces copy actions", async () => {
    api.getPublicStudent.mockResolvedValue({
      data: {
        studentId: "STU001",
        name: "Ada Lovelace",
        class: "Form 4",
        feeAmount: 150,
        feePaid: false,
      },
    });
    api.getPaymentInstructions.mockResolvedValue({
      data: {
        walletAddress: TEST_ADDRESS,
        memo: "STU001",
        feeAmount: 150,
        acceptedAssets: [{ code: "XLM", type: "native", displayName: "XLM" }],
      },
    });

    render(<PaymentForm initialStudentId="STU001" publicMode />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();

    // QR has role="img" and descriptive aria-label including amount, recipient, and memo
    const qrSvgs = screen.getAllByTestId("qr-code-svg");
    const paymentQr = qrSvgs.find((el) =>
      el.getAttribute("aria-label")?.includes("QR code to pay 150 XLM")
    );
    expect(paymentQr).toBeDefined();
    expect(paymentQr).toHaveAttribute("role", "img");
    expect(paymentQr).toHaveAttribute(
      "aria-label",
      `QR code to pay 150 XLM to ${TEST_ADDRESS}, memo STU001`
    );

    // Memo has explicit REQUIRED indicator and aria-describedby exchange warning
    expect(screen.getByText("Memo / reference — REQUIRED")).toBeInTheDocument();
    const warningEl = screen.getByText(/Always include this exact memo/i);
    expect(warningEl).toHaveAttribute("id", "pf-memo-warning");

    // Monospace address is grouped in 4-character chunks visually, but copy copies raw address
    expect(
      screen.getByText(groupMonospaceValue(TEST_ADDRESS))
    ).toHaveAttribute("data-raw", TEST_ADDRESS);

    const copyButtons = screen.getAllByRole("button", { name: "actions.copyToClipboard" });
    fireEvent.click(copyButtons[0]); // Copy wallet address

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TEST_ADDRESS);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Wallet address copied to clipboard"
    );

    fireEvent.click(copyButtons[1]); // Copy memo
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("STU001");
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Memo copied to clipboard"
    );
  });

  it("links lookup errors to the student ID input via aria-invalid and aria-describedby", async () => {
    api.getPublicStudent.mockRejectedValue({
      response: { data: { error: "Student not found" } },
    });
    api.getPaymentInstructions.mockRejectedValue(new Error("Not found"));

    render(<PaymentForm publicMode />);

    const input = screen.getByLabelText("paymentForm.studentIdLabel");
    fireEvent.change(input, { target: { value: "UNKNOWN99" } });
    fireEvent.submit(input.closest("form"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "sid-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "sid-error");
  });

  it("links validation and server errors to input in VerifyPayment and groups txHash in 4-char chunks", async () => {
    render(<VerifyPayment />);

    const input = screen.getByLabelText("verifyPayment.txHashLabel");
    fireEvent.change(input, { target: { value: "invalid-hash" } });
    fireEvent.submit(input.closest("form"));

    const errSpan = await screen.findByRole("alert");
    expect(errSpan).toHaveAttribute("id", "txin-err");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "txin-err");

    // Valid hash submission shows grouped hash in polite status region
    api.verifyPayment.mockResolvedValue({
      data: {
        amount: 150,
        assetCode: "XLM",
        memo: "STU001",
        hash: TEST_TX_HASH,
        feeValidation: { status: "valid", message: "Exact fee match" },
      },
    });

    fireEvent.change(input, { target: { value: TEST_TX_HASH } });
    fireEvent.submit(input.closest("form"));

    const statusBox = await screen.findByRole("status");
    expect(statusBox).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByText(groupMonospaceValue(TEST_TX_HASH))
    ).toHaveAttribute("data-raw", TEST_TX_HASH);
  });

  it("associates StudentForm field errors with inputs via aria-describedby and aria-invalid", async () => {
    render(
      <StudentForm
        student={{
          studentId: "STU001",
          name: "",
          class: "5A",
          parentEmail: "not-an-email",
          parentPhone: "",
        }}
        onClose={() => {}}
        onSave={() => {}}
      />
    );

    fireEvent.click(screen.getByText("studentForm.saveChanges"));

    const nameInput = screen.getByLabelText("studentForm.name");
    const emailInput = screen.getByLabelText("studentForm.parentEmail");

    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveAttribute("aria-describedby", "student-form-name-err");
    expect(emailInput).toHaveAttribute("aria-invalid", "true");
    expect(emailInput).toHaveAttribute("aria-describedby", "student-form-email-err");
  });
});
