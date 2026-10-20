import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/globalSetup.ts',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:55432/receipts_test',
      REDIS_URL: 'redis://localhost:56379/1',
      LOG_LEVEL: 'warn',
      KAFKAJS_NO_PARTITIONER_WARNING: '1',
      // Fresh topic per run so old messages never leak into assertions.
      RECEIPT_TOPIC: `test.receipts.${Date.now()}`,
    },
  },
});
