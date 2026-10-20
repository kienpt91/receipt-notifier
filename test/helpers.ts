import { Redis } from 'ioredis';
import { Webhook } from 'standardwebhooks';
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';

export const pool = createPool();
export const redis = new Redis(config.redisUrl);

export async function resetState() {
  await pool.query('TRUNCATE payments, webhook_events, outbox, email_deliveries, dead_letters RESTART IDENTITY');
  await redis.flushdb();
}

export const WHOP_SECRET = 'ws_test_secret_123';

/** Signs like Whop does: HMAC over the literal secret bytes (see @whop/sdk verifyWebhook). */
export function signWhop(body: string, webhookId: string, secret = WHOP_SECRET) {
  const wh = new Webhook(Buffer.from(secret, 'utf8').toString('base64'));
  const timestamp = new Date();
  return {
    'content-type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': wh.sign(webhookId, timestamp, body),
  };
}

export function whopPaymentSucceeded(overrides: { paymentId?: string; total?: number | null; currency?: string; email?: string | null } = {}) {
  return JSON.stringify({
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'payment.succeeded',
    api_version: 'v1',
    timestamp: new Date().toISOString(),
    account_id: 'biz_test',
    data: {
      id: overrides.paymentId ?? 'pay_abc123',
      total: overrides.total === undefined ? 6.9 : overrides.total,
      currency: overrides.currency ?? 'usd',
      status: 'paid',
      paid_at: new Date().toISOString(),
      user: { id: 'user_1', email: overrides.email === undefined ? 'Buyer@Example.com' : overrides.email },
    },
  });
}

export async function insertDelivery(ref: string, overrides: { recipient?: string; amountMinor?: string } = {}) {
  await pool.query(
    `INSERT INTO email_deliveries (provider, payment_reference, recipient, amount_minor, currency)
     VALUES ('whop', $1, $2, $3, 'USD')`,
    [ref, overrides.recipient ?? 'buyer@example.com', overrides.amountMinor ?? '1999'],
  );
}

export async function fakeMail(key: string) {
  return {
    calls: Number(await redis.get(`fakemail:calls:${key}`)),
    delivered: (await redis.lrange('fakemail:inbox', 0, -1)).filter((m) => JSON.parse(m).idempotencyKey === key).length,
  };
}
