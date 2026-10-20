import { beforeEach, describe, expect, it } from 'vitest';
import { FakeEmailProvider } from '../src/email/provider.js';
import { DeliveryWorker } from '../src/notification/worker.js';
import { fakeMail, insertDelivery, pool, redis, resetState } from './helpers.js';

const statusOf = async (ref: string) =>
  (await pool.query('SELECT status, attempts, last_error FROM email_deliveries WHERE payment_reference = $1', [ref])).rows[0];

beforeEach(resetState);

describe('DeliveryWorker', () => {
  it('4 concurrent workers send each of 60 receipts exactly once', async () => {
    const refs = Array.from({ length: 60 }, (_, i) => `pay_${i}`);
    for (const ref of refs) await insertDelivery(ref);

    const workers = Array.from({ length: 4 }, (_, i) => new DeliveryWorker(pool, new FakeEmailProvider(redis), { workerId: `w${i}`, batchSize: 3 }));
    const drain = async (w: DeliveryWorker) => { while (await w.runOnce()); };
    await Promise.all(workers.map(drain));

    for (const ref of refs) expect(await fakeMail(`receipt-whop-${ref}`)).toEqual({ calls: 1, delivered: 1 });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM email_deliveries WHERE status = 'sent'");
    expect(rows[0].n).toBe(60);
  });

  it('worker dies after the provider accepted but before marking sent: reclaimed, provider dedupes', async () => {
    await insertDelivery('pay_crash');
    const provider = new FakeEmailProvider(redis);
    const a = new DeliveryWorker(pool, provider, { workerId: 'a', leaseSeconds: 1 });
    const [row] = await a.claim();
    await a.sendOnly(row!); // ...and the process is killed here

    const b = new DeliveryWorker(pool, provider, { workerId: 'b' });
    expect(await b.runOnce()).toBe(0); // lease still held: nobody else may touch it
    await new Promise((r) => setTimeout(r, 1100));
    expect(await b.runOnce()).toBe(1);

    expect(await statusOf('pay_crash')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await fakeMail('receipt-whop-pay_crash')).toEqual({ calls: 2, delivered: 1 });
  });

  it('a stale worker cannot overwrite the row after its lease was taken over', async () => {
    await insertDelivery('pay_stale');
    const provider = new FakeEmailProvider(redis);
    const a = new DeliveryWorker(pool, provider, { workerId: 'a', leaseSeconds: 1 });
    const [row] = await a.claim();
    await new Promise((r) => setTimeout(r, 1100));
    await new DeliveryWorker(pool, provider, { workerId: 'b' }).runOnce();

    provider.failNext = 1; // a's late send fails and it tries to reschedule
    await (a as any).process(row);
    expect(await statusOf('pay_stale')).toMatchObject({ status: 'sent' });
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    await insertDelivery('pay_retry');
    const provider = new FakeEmailProvider(redis);
    provider.failNext = 2;
    const w = new DeliveryWorker(pool, provider, { baseBackoffMs: 0 });
    while (await w.runOnce());
    expect(await statusOf('pay_retry')).toMatchObject({ status: 'sent', attempts: 3 });
    expect(await fakeMail('receipt-whop-pay_retry')).toEqual({ calls: 3, delivered: 1 });
  });

  it('goes dead (not dropped) after max attempts or a permanent error', async () => {
    await insertDelivery('pay_flaky');
    const provider = new FakeEmailProvider(redis);
    provider.failNext = 100;
    const w = new DeliveryWorker(pool, provider, { baseBackoffMs: 0 });
    while (await w.runOnce());
    expect(await statusOf('pay_flaky')).toMatchObject({ status: 'dead', attempts: 8 });

    await insertDelivery('pay_bounce');
    provider.failNext = 0;
    provider.failPermanently = true;
    await w.runOnce();
    expect(await statusOf('pay_bounce')).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('re-validates the stored row and never sends an invalid one', async () => {
    await insertDelivery('pay_bad', { recipient: 'not-an-email' }); // got past every layer except this one
    await new DeliveryWorker(pool, new FakeEmailProvider(redis)).runOnce();
    expect(await statusOf('pay_bad')).toMatchObject({ status: 'dead', last_error: 'stored receipt failed validation' });
    expect(await fakeMail('receipt-whop-pay_bad')).toEqual({ calls: 0, delivered: 0 });
  });
});
