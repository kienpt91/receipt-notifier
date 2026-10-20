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
 * Idempotent: a duplicate event hits the unique keys and inserts nothing. A "duplicate"
 * whose receipt differs from the one already queued is reported as a conflict instead of
 * being silently ignored.
 */
export async function recordPaymentAndEnqueueReceipt(
  client: pg.PoolClient,
  { provider, receipt, status, paidAt }: PaymentInput,
): Promise<'queued' | 'duplicate' | 'conflict'> {
  await client.query(
    `INSERT INTO payments (provider, provider_payment_id, customer_email, amount_minor, currency, status, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
    [provider, receipt.paymentReference, receipt.recipientEmail, receipt.amountMinor, receipt.currency, status, paidAt],
  );

  const message: ReceiptMessage = { v: 1, provider, ...receipt };
  const dedupeKey = `receipt:${provider}:${receipt.paymentReference}`;
  const outbox = await client.query(
    `INSERT INTO outbox (topic, message_key, dedupe_key, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [config.receiptTopic, `${provider}:${receipt.paymentReference}`, dedupeKey, message],
  );
  if (outbox.rowCount) return 'queued';

  const { rows } = await client.query<{ payload: ReceiptMessage }>('SELECT payload FROM outbox WHERE dedupe_key = $1', [dedupeKey]);
  const queued = rows[0]?.payload;
  const same =
    queued?.recipientEmail === receipt.recipientEmail &&
    queued.amountMinor === receipt.amountMinor &&
    queued.currency === receipt.currency;
  return same ? 'duplicate' : 'conflict';
}
