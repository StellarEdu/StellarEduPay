'use strict';

const Payment = require('../backend/src/models/paymentModel');
const Student = require('../backend/src/models/studentModel');
const { toStroops, sumStroops } = require('../backend/src/utils/stellarAmount');

describe('Runtime *Stroops money field synchronization (#1819)', () => {
  test('Payment model populates amountStroops, feeAmountStroops, excessAmountStroops, appliedCreditStroops, and fiatAmountStroops on validate', async () => {
    const payment = new Payment({
      schoolId: 'SCH001',
      studentId: 'STU001',
      txHash: 'a'.repeat(64),
      opIndex: 0,
      amount: 125.5,
      feeAmount: 100,
      excessAmount: 25.5,
      underpaidReconciliation: {
        status: 'partial_credited',
        appliedCredit: 12.3456789,
      },
      fiatSnapshot: {
        fiatAmount: 15.75,
        fiatCurrency: 'USD',
        fiatRate: 0.125498,
      },
    });

    await payment.validate();

    expect(payment.amountStroops).toBe(toStroops(125.5).toString());
    expect(payment.amountStroops).toBe('1255000000');
    expect(payment.feeAmountStroops).toBe(toStroops(100).toString());
    expect(payment.feeAmountStroops).toBe('1000000000');
    expect(payment.excessAmountStroops).toBe(toStroops(25.5).toString());
    expect(payment.excessAmountStroops).toBe('255000000');
    expect(payment.underpaidReconciliation.appliedCreditStroops).toBe(
      toStroops(12.3456789).toString()
    );
    expect(payment.fiatSnapshot.fiatAmountStroops).toBe(
      toStroops(15.75).toString()
    );
  });

  test('Payment model leaves feeAmountStroops null when feeAmount is null and defaults excessAmountStroops to "0"', async () => {
    const payment = new Payment({
      schoolId: 'SCH001',
      studentId: 'STU001',
      txHash: 'b'.repeat(64),
      amount: 0.0000001,
    });

    await payment.validate();

    expect(payment.amountStroops).toBe('1');
    expect(payment.feeAmountStroops).toBeNull();
    expect(payment.excessAmountStroops).toBe('0');
  });

  test('Payment model updates *Stroops fields when amounts change and re-validates', async () => {
    const payment = new Payment({
      schoolId: 'SCH001',
      studentId: 'STU001',
      txHash: 'c'.repeat(64),
      amount: 50,
      feeAmount: 50,
      excessAmount: 0,
    });

    await payment.validate();
    expect(payment.amountStroops).toBe('500000000');

    payment.amount = 75.25;
    payment.excessAmount = 25.25;
    await payment.validate();

    expect(payment.amountStroops).toBe('752500000');
    expect(payment.excessAmountStroops).toBe('252500000');
  });

  test('Student model populates feeAmountStroops, totalPaidStroops, remainingBalanceStroops, creditBalanceStroops and nested fee stroops on validate', async () => {
    const student = new Student({
      schoolId: 'SCH001',
      studentId: 'STU001',
      name: 'Grace Hopper',
      class: 'Form 5',
      feeAmount: 300,
      totalPaid: 120.5,
      remainingBalance: 179.5,
      creditAdjustments: 10.25,
      fees: [
        {
          category: 'Tuition',
          amount: 200,
          totalPaid: 100,
          remainingBalance: 100,
        },
        {
          category: 'Lab',
          amount: 100,
          totalPaid: 20.5,
          remainingBalance: 79.5,
        },
      ],
    });

    await student.validate();

    expect(student.feeAmountStroops).toBe('3000000000');
    expect(student.totalPaidStroops).toBe('1205000000');
    expect(student.remainingBalanceStroops).toBe('1795000000');
    expect(student.creditBalanceStroops).toBe('102500000');
    expect(student.fees[0].amountStroops).toBe('2000000000');
    expect(student.fees[0].totalPaidStroops).toBe('1000000000');
    expect(student.fees[0].remainingBalanceStroops).toBe('1000000000');
    expect(student.fees[1].amountStroops).toBe('1000000000');
    expect(student.fees[1].totalPaidStroops).toBe('205000000');
    expect(student.fees[1].remainingBalanceStroops).toBe('795000000');
  });

  test('sumStroops aggregates persisted *Stroops strings without float drift', async () => {
    const amounts = [0.1, 0.2, 0.3, 19.9999999, 80.0000001];
    const payments = [];

    for (let i = 0; i < amounts.length; i++) {
      const p = new Payment({
        schoolId: 'SCH001',
        studentId: `STU00${i}`,
        txHash: String(i).padStart(64, '0'),
        amount: amounts[i],
      });
      await p.validate();
      payments.push(p);
    }

    const totalStroops = sumStroops(payments.map((p) => p.amountStroops));
    // 0.1 + 0.2 + 0.3 + 19.9999999 + 80.0000001 = 100.6 XLM = 1,006,000,000 stroops
    expect(totalStroops).toBe(1006000000n);
  });
});
