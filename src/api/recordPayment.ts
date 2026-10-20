import type pg from 'pg';
import { config } from '../config.js';
import type { ReceiptMessage, ReceiptRequest } from '../shared/receiptSchema.js';

export interface PaymentInput {
  provider: ReceiptMessage['provider'];
  receipt: ReceiptRequest; // already validated by the caller with the shared schema
  status: string;
  paidAt: Date | null;
}

/**
 * Must be called inside a transaction. The payment row and its outbox row commit
 * together or not at all: a crash right after COMMIT can't lose the email, and a crash
 * before COMMIT leaves nothing behind for the retry to trip over.
 *
 * Idempotent: a duplicate event hits the unique keys and inserts nothing.
 */
export async function recordPaymentAndEnqueueReceipt(
  client: pg.PoolClient,
  { provider, receipt, status, paidAt }: PaymentInput,
): Promise<'queued' | 'duplicate'> {
  await client.query(
    `INSERT INTO payments (provider, provider_payment_id, customer_email, amount_minor, currency, status, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
    [provider, receipt.paymentReference, receipt.recipientEmail, receipt.amountMinor, receipt.currency, status, paidAt],
  );

  const message: ReceiptMessage = { v: 1, provider, ...receipt };
  const outbox = await client.query(
    `INSERT INTO outbox (topic, message_key, dedupe_key, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [config.receiptTopic, `${provider}:${receipt.paymentReference}`, `receipt:${provider}:${receipt.paymentReference}`, message],
  );
  return outbox.rowCount ? 'queued' : 'duplicate';
}
