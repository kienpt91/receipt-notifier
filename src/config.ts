const isProduction = process.env.NODE_ENV === 'production';

/** Dev defaults are public (they're in this repo), so production must set the real value. */
function secret(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) throw new Error(`${name} must be set in production`);
  return devDefault;
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
    return secret('ADMIN_TOKEN', 'local-admin-token');
  },
  port: Number(process.env.PORT ?? 3100),
  leaseSeconds: Number(process.env.LEASE_SECONDS ?? 60),
};
