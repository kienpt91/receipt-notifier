export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/receipts',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:56379',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:59092').split(','),
  receiptTopic: process.env.RECEIPT_TOPIC ?? 'payments.receipt-requested',
  whopWebhookSecret: process.env.WHOP_WEBHOOK_SECRET ?? 'ws_local_dev_secret',
  adminToken: process.env.ADMIN_TOKEN ?? 'local-admin-token',
  port: Number(process.env.PORT ?? 3100),
  leaseSeconds: Number(process.env.LEASE_SECONDS ?? 60),
};
