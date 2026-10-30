import { defineConfig } from 'vitest/config';

// Tests that need no Postgres/Redis/Kafka: `npm run test:unit`.
export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'], env: { LOG_LEVEL: 'warn' } },
});
