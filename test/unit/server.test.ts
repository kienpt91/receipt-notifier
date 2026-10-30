import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { redactWhopEvent } from '../../src/api/whop.js';

// No services: the pool/redis stubs are only touched by the routes that reach Postgres.
const TOKEN = 'test-admin-token-0123456789';
const failingPool = {
  connect: async () => {
    throw new Error('connection to postgres://user:hunter2@db.internal:5432 refused');
  },
} as unknown as pg.Pool;
const redis = { exists: async () => 0, set: async () => 'OK' } as unknown as Redis;

const apps: ReturnType<typeof buildServer>[] = [];
const make = (opts: Partial<Parameters<typeof buildServer>[0]> = {}) => {
  const app = buildServer({ pool: failingPool, redis, whopSecret: 'ws_x', adminToken: TOKEN, logger: false, ...opts });
  apps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const adminPost = (app: ReturnType<typeof buildServer>, token: string, payload: unknown = {}) =>
  app.inject({
    method: 'POST',
    url: '/admin/receipts',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

describe('security headers', () => {
  it.each(['/', '/healthz'])('are set on %s', async (url) => {
    const res = await make().inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('are set on /admin/* responses, including 401s', async () => {
    const res = await adminPost(make(), 'wrong');
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

describe('/admin rate limit', () => {
  it('answers 429 after max requests, even for wrong tokens', async () => {
    const app = make({ adminRateLimit: { max: 3, timeWindow: '1 minute' } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await adminPost(app, `guess-${i}`)).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('does not limit the webhook or health routes', async () => {
    const app = make({ adminRateLimit: { max: 1, timeWindow: '1 minute' } });
    for (let i = 0; i < 4; i++) expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('failed admin auth logging', () => {
  it('logs the attempt without the presented token', async () => {
    const lines: string[] = [];
    const app = make({ logger: { level: 'warn', stream: { write: (m: string) => void lines.push(m) } } });
    const guess = 'super-secret-guess-value';
    const res = await adminPost(app, guess);
    expect(res.statusCode).toBe(401);
    const log = lines.join('');
    expect(log).toContain('admin auth failed');
    expect(log).not.toContain(guess);
  });
});

describe('error handler', () => {
  it('returns a generic 500 and no internal detail', async () => {
    const res = await adminPost(make(), TOKEN, {
      recipientEmail: 'a@b.co', amountMinor: '100', currency: 'USD', paymentReference: 'ref-001',
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal server error' });
    expect(res.body).not.toMatch(/hunter2|postgres|db\.internal/);
  });
});

describe('redactWhopEvent', () => {
  it('drops the customer email and unlisted fields, keeps the diagnostic ones', () => {
    const out = redactWhopEvent({
      id: 'msg_1', type: 'payment.succeeded', api_version: 'v1', timestamp: 't', account_id: 'biz_1',
      data: {
        id: 'pay_1', total: 6.9, currency: 'usd', status: 'paid', paid_at: null,
        user: { id: 'user_1', email: 'buyer@example.com', name: 'Jane Doe' },
        billing_address: { line1: '1 Main St' },
      },
    });
    expect(out).toEqual({
      id: 'msg_1', type: 'payment.succeeded', api_version: 'v1', timestamp: 't', account_id: 'biz_1',
      data: { id: 'pay_1', total: 6.9, currency: 'usd', status: 'paid', paid_at: null, user: { id: 'user_1' } },
    });
    expect(JSON.stringify(out)).not.toMatch(/buyer@|Jane|Main St/);
  });

  it('tolerates junk input', () => {
    expect(redactWhopEvent(null)).toEqual({ data: {} });
    expect(redactWhopEvent('x')).toEqual({ data: {} });
  });
});
