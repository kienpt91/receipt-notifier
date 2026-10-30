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
    // Validated here: an invalid date would otherwise fail in Postgres and 500 on every retry.
    paid_at: z.string().datetime({ offset: true }).nullable(),
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

/**
 * What we keep in webhook_events: enough to correlate a webhook with a payment and to see
 * why it was rejected (amount, currency, status, dates), without the customer's email or
 * any other personal data in Whop's payload. Anything not listed here is dropped.
 */
export function redactWhopEvent(event: unknown): Record<string, unknown> {
  const pick = (o: unknown, keys: string[]) => {
    const src = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
    return Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));
  };
  const e = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
  const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
  return {
    ...pick(e, ['id', 'type', 'api_version', 'timestamp', 'account_id']),
    data: {
      ...pick(data, ['id', 'total', 'currency', 'status', 'paid_at']),
      ...(data.user && typeof data.user === 'object' ? { user: pick(data.user, ['id']) } : {}),
    },
  };
}
