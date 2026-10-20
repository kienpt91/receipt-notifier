import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Consumer, Producer } from 'kafkajs';
import { buildServer } from '../src/api/server.js';
import { config } from '../src/config.js';
import { FakeEmailProvider } from '../src/email/provider.js';
import { createKafka, ensureTopic } from '../src/kafka.js';
import { handleReceiptMessage } from '../src/notification/consumer.js';
import { reconcileOnce } from '../src/notification/reconciler.js';
import { DeliveryWorker } from '../src/notification/worker.js';
import { relayBatch } from '../src/relay/relay.js';
import { WHOP_SECRET, fakeMail, pool, redis, resetState, signWhop, whopPaymentSucceeded } from './helpers.js';

const kafka = createKafka('pipeline-test');
let producer: Producer;
let consumer: Consumer;
const results: string[] = [];
const app = buildServer({ pool, redis, whopSecret: WHOP_SECRET });

async function until(cond: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}
const deliveries = async () => (await pool.query('SELECT count(*)::int AS n FROM email_deliveries')).rows[0].n as number;

beforeAll(async () => {
  await ensureTopic(kafka);
  producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  consumer = kafka.consumer({ groupId: `test-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: config.receiptTopic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      results.push(await handleReceiptMessage(pool, { topic, key: message.key?.toString() ?? null, value: message.value?.toString() ?? null }));
    },
  });
});
afterAll(async () => {
  await consumer.disconnect();
  await producer.disconnect();
  await app.close();
});
beforeEach(resetState);

describe('webhook -> outbox -> Kafka -> email_deliveries -> email', () => {
  it('delivers exactly one email even when the relay publishes the same row twice', async () => {
    const body = whopPaymentSucceeded({ paymentId: 'pay_e2e', total: 49 });
    await app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_e2e'), payload: body });

    expect(await relayBatch(pool, producer)).toBe(1);
    await pool.query('UPDATE outbox SET published_at = NULL'); // as if the relay crashed before COMMIT
    expect(await relayBatch(pool, producer)).toBe(1);

    await until(async () => results.length >= 2);
    expect(results.slice(-2).sort()).toEqual(['duplicate', 'inserted']);

    const worker = new DeliveryWorker(pool, new FakeEmailProvider(redis));
    while (await worker.runOnce());
    expect(await fakeMail('receipt-whop-pay_e2e')).toEqual({ calls: 1, delivered: 1 });
    const inbox = JSON.parse((await redis.lrange('fakemail:inbox', 0, -1))[0]!);
    expect(inbox.subject).toBe('Your receipt: $49.00');
  });

  it('dead-letters a message that fails the shared schema instead of dropping it', async () => {
    const r = await handleReceiptMessage(pool, {
      topic: config.receiptTopic,
      key: 'k',
      value: JSON.stringify({ v: 1, provider: 'whop', recipientEmail: 'a@b.co', amountMinor: 19.99, currency: 'USD', paymentReference: 'p1' }),
    });
    expect(r).toBe('dead-letter');
    expect((await pool.query('SELECT count(*)::int AS n FROM dead_letters')).rows[0].n).toBe(1);
    expect(await deliveries()).toBe(0);
  });

  it('reconciler republishes a receipt whose message never produced a delivery', async () => {
    const body = whopPaymentSucceeded({ paymentId: 'pay_lost' });
    await app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_lost'), payload: body });
    // Simulate a message that was published but lost downstream.
    await pool.query("UPDATE outbox SET published_at = now() - interval '1 hour'");

    expect(await reconcileOnce(pool, '10 minutes')).toMatchObject({ republished: 1 });
    expect(await relayBatch(pool, producer)).toBe(1);
    await until(async () => (await deliveries()) === 1);
  });

  it('reconciler does not republish a message the consumer dead-lettered', async () => {
    const body = whopPaymentSucceeded({ paymentId: 'pay_poison' });
    await app.inject({ method: 'POST', url: '/webhooks/whop', headers: signWhop(body, 'msg_poison'), payload: body });
    await pool.query("UPDATE outbox SET published_at = now() - interval '1 hour'");
    await pool.query("INSERT INTO dead_letters (topic, message_key, value, error) VALUES ('t', 'whop:pay_poison', '{}', 'bad')");

    expect(await reconcileOnce(pool, '10 minutes')).toMatchObject({ republished: 0 });
  });
});
