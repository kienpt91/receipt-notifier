import { unwrapWebhook } from '@whop/sdk/helpers';
import { z } from 'zod';
import { isCurrency, majorToMinor } from '../shared/money.js';
import { ReceiptRequest } from '../shared/receiptSchema.js';

// Only the fields we use. Whop's payment object sends amounts as decimals (`total: 6.9`)
// and currency lowercase (`usd`); both are normalised here, at the edge.
const WhopPaymentSucceeded = z.object({
  id: z.string(),
  type: z.literal('payment.succeeded'),
  data: z.object({
    id: z.string(),
    total: z.number().nullable(),
    currency: z.string(),
    status: z.string().nullable(),
    paid_at: z.string().nullable(),
    user: z.object({ email: z.string().nullable() }).passthrough().nullable(),
  }).passthrough(),
}).passthrough();

export type WhopEvent = { id: string; type: string; raw: unknown };

/** Throws WebhookVerificationError on a bad or stale signature. */
export function verifyWhopWebhook(rawBody: string, headers: Record<string, string>, secret: string): WhopEvent {
  const event = unwrapWebhook(rawBody, { headers, key: secret }) as { id: string; type: string };
  return { id: event.id, type: event.type, raw: event };
}

export type WhopReceipt =
  | { ok: true; receipt: ReceiptRequest; status: string; paidAt: Date | null }
  | { ok: false; reason: string };

/** Maps a verified Whop event to our shared ReceiptRequest, or explains why it can't. */
export function toReceipt(event: unknown): WhopReceipt {
  const parsed = WhopPaymentSucceeded.safeParse(event);
  if (!parsed.success) return { ok: false, reason: `unexpected payload: ${parsed.error.message}` };
  const { data } = parsed.data;

  const currency = data.currency.toUpperCase();
  if (!isCurrency(currency)) return { ok: false, reason: `unsupported currency ${data.currency}` };
  if (data.total === null) return { ok: false, reason: 'payment has no total' };
  if (!data.user?.email) return { ok: false, reason: 'payment has no customer email (member:email:read scope?)' };

  let amountMinor: string;
  try {
    amountMinor = majorToMinor(data.total, currency).toString();
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const receipt = ReceiptRequest.safeParse({
    recipientEmail: data.user.email,
    amountMinor,
    currency,
    paymentReference: data.id,
  });
  if (!receipt.success) return { ok: false, reason: receipt.error.message };

  return {
    ok: true,
    receipt: receipt.data,
    status: data.status ?? 'paid',
    paidAt: data.paid_at ? new Date(data.paid_at) : null,
  };
}
