import { describe, expect, it } from 'vitest';
import { formatMinor, majorToMinor } from '../src/shared/money.js';
import { ReceiptRequest } from '../src/shared/receiptSchema.js';

const valid = { recipientEmail: 'a@b.co', amountMinor: '1999', currency: 'USD', paymentReference: 'pay_123' };

describe('money', () => {
  it('converts major to minor without float math and rejects excess precision', () => {
    expect(majorToMinor(6.9, 'USD')).toBe(690n); // 6.9 * 100 = 690.0000000000001 in floats
    expect(majorToMinor('0.29', 'USD')).toBe(29n);
    expect(majorToMinor('1500', 'JPY')).toBe(1500n);
    expect(majorToMinor('1.234', 'KWD')).toBe(1234n);
    expect(() => majorToMinor('1.999', 'USD')).toThrow(/at most 2/);
    expect(() => majorToMinor('-5', 'USD')).toThrow();
    expect(() => majorToMinor(1e21, 'USD')).toThrow();
  });

  it('formats by currency exponent', () => {
    expect(formatMinor(690n, 'USD')).toBe('$6.90');
    expect(formatMinor(1500n, 'JPY')).toBe('¥1,500');
    expect(formatMinor(9007199254740993n, 'USD')).toBe('$90,071,992,547,409.93'); // > 2^53, exact
  });
});

describe('shared ReceiptRequest schema', () => {
  it.each([
    ['float amount', { amountMinor: '19.99' }],
    ['number amount', { amountMinor: 1999 }],
    ['zero', { amountMinor: '0' }],
    ['negative', { amountMinor: '-1' }],
    ['beyond BIGINT', { amountMinor: '1'.repeat(19) }],
    ['bad email', { recipientEmail: 'nope' }],
    ['unknown currency', { currency: 'XYZ' }],
    ['bad reference', { paymentReference: 'a b' }],
    ['extra field', { isAdmin: true }],
  ])('rejects %s', (_label, patch) => {
    expect(ReceiptRequest.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('normalises email', () => {
    expect(ReceiptRequest.parse({ ...valid, recipientEmail: ' A@B.CO ' }).recipientEmail).toBe('a@b.co');
  });
});
