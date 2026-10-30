/** Public dev defaults (they're in this repo) are only allowed in these two environments. */
const allowDevDefaults = () => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

export const MIN_ADMIN_TOKEN_LENGTH = 24;

/**
 * Secrets have no default unless NODE_ENV is explicitly 'development' or 'test'.
 * An unset or unknown NODE_ENV is treated like production: fail fast.
 */
export function secret(name: string, devDefault: string, minLength = 1): string {
  const value = process.env[name];
  if (!value) {
    if (allowDevDefaults()) return devDefault;
    throw new Error(`${name} must be set (dev defaults only apply when NODE_ENV is 'development' or 'test')`);
  }
  if (!allowDevDefaults() && value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters outside development/test`);
  }
  return value;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/receipts',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:56379',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:59092').split(','),
  receiptTopic: process.env.RECEIPT_TOPIC ?? 'payments.receipt-requested',
  // Getters: only the API needs these, so other roles don't fail on a missing secret.
  get whopWebhookSecret() {
    return secret('WHOP_WEBHOOK_SECRET', 'ws_local_dev_secret');
  },
  get adminToken() {
    return secret('ADMIN_TOKEN', 'local-admin-token', MIN_ADMIN_TOKEN_LENGTH);
  },
  // Loopback by default; set HOST=0.0.0.0 (e.g. in a container) to expose the API.
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3100),
  leaseSeconds: Number(process.env.LEASE_SECONDS ?? 60),
  // How long the email provider dedupes on an idempotency key (Resend/Postmark: ~24h).
  providerIdempotencyHours: Number(process.env.PROVIDER_IDEMPOTENCY_HOURS ?? 24),
};
