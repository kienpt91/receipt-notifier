import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordPaymentAndEnqueueReceipt } from '../src/api/recordPayment.js';
import { buildServer } from '../src/api/server.js';
import { withTransaction } from '../src/db.js';
import { WHOP_SECRET, pool, redis, resetState, signWhop, whopPaymentSucceeded } from './helpers.js';

const app = buildServer({ pool, redis, whopSecret: WHOP_SECRET, adminToken: 'tok' });
const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

beforeEach(resetState);
afterAll(() => app.close());

describe('POST /webhooks/whop', () => {
  it('records the payment and queues one receipt atomically', async () => {
    const body = whopPaymentSucceeded({ total: 6.9 });
    const res = await app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_1'), payload: body });

    expect(res.json()).toEqual({ status: 'queued' });
    const { rows } = await pool.query('SELECT amount_minor, currency, customer_email FROM payments');
    expect(rows).toEqual([{ amount_minor: '690', currency: 'USD', customer_email: 'buyer@example.com' }]);
    expect(await count('outbox')).toBe(1);
  });

  it('dedupes Whop retries (same webhook-id) and a re-sent event (new id, same payment)', async () => {
    const body = whopPaymentSucceeded();
    const send = (id: string, b = body) => app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(b, id), payload: b });

    await send('msg_1');
    expect((await send('msg_1')).json()).toEqual({ status: 'duplicate' }); // Redis fast path
    await redis.flushdb(); // Redis lost its memory: the DB must still catch it
    expect((await send('msg_1')).json()).toEqual({ status: 'duplicate' });
    expect((await send('msg_2', whopPaymentSucceeded())).json()).toEqual({ status: 'duplicate' });

    expect(await count('payments')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });

  it('keeps working when Redis is down', async () => {
    const deadRedis = new Redis('redis://localhost:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, lazyConnect: true });
    const app2 = buildServer({ pool, redis: deadRedis, whopSecret: WHOP_SECRET });
    const body = whopPaymentSucceeded();
    const res = await app2.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_9'), payload: body });
    expect(res.json()).toEqual({ status: 'queued' });
    await app2.close();
    deadRedis.disconnect();
  });

  it('rejects a bad signature and a tampered body', async () => {
    const body = whopPaymentSucceeded();
    const forged = await app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_1', 'ws_wrong'), payload: body });
    expect(forged.statusCode).toBe(401);
    const tampered = await app.inject({
      method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_1'), payload: body.replace('6.9', '0.01'),
    });
    expect(tampered.statusCode).toBe(401);
    expect(await count('payments')).toBe(0);
  });

  it('ACKs but does not queue a payment that cannot produce a valid receipt', async () => {
    const body = whopPaymentSucceeded({ email: null });
    const res = await app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_1'), payload: body });
    expect(res.json()).toEqual({ status: 'rejected' });
    expect(await count('webhook_events')).toBe(1); // kept for replay after the fix
    expect(await count('outbox')).toBe(0);
  });
});

describe('enqueue is atomic', () => {
  it('a crash after COMMIT keeps the receipt; a crash before COMMIT leaves nothing', async () => {
    const receipt = { recipientEmail: 'a@b.co', amountMinor: '500', currency: 'USD' as const, paymentReference: 'pay_crash' };

    await expect(
      withTransaction(pool, async (c) => {
        await recordPaymentAndEnqueueReceipt(c, { provider: 'whop', receipt, status: 'paid', paidAt: null });
        throw new Error('process died before COMMIT');
      }),
    ).rejects.toThrow();
    expect(await count('payments')).toBe(0);
    expect(await count('outbox')).toBe(0);

    await withTransaction(pool, (c) => recordPaymentAndEnqueueReceipt(c, { provider: 'whop', receipt, status: 'paid', paidAt: null }));
    // "Process exits" here: nothing else needs to run for the receipt to be durable.
    expect(await count('outbox')).toBe(1);
  });
});

describe('POST /admin/receipts', () => {
  const post = (payload: unknown, token = 'tok') =>
    app.inject({ method: 'POST', url: '/admin/receipts', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

  it('returns the shared schema field errors', async () => {
    const res = await post({ recipientEmail: 'x', amountMinor: '12.5', currency: 'USD', paymentReference: 'r1' });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().errors).sort()).toEqual(['amountMinor', 'paymentReference', 'recipientEmail']);
  });

  it('queues once, then reports duplicate', async () => {
    const body = { recipientEmail: 'a@b.co', amountMinor: '1250', currency: 'EUR', paymentReference: 'bank-0042' };
    expect((await post(body)).statusCode).toBe(202);
    expect((await post(body)).json()).toEqual({ status: 'duplicate' });
    expect((await post(body, 'wrong')).statusCode).toBe(401);
  });

  it('rejects a reused reference with a different amount instead of silently keeping the old one', async () => {
    const body = { recipientEmail: 'a@b.co', amountMinor: '1250', currency: 'EUR', paymentReference: 'bank-0043' };
    await post(body);
    const res = await post({ ...body, amountMinor: '9999' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors.paymentReference).toBeDefined();
  });
});
