import type pg from 'pg';
import { config } from '../config.js';
import { createPool } from '../db.js';
import { createKafka, ensureTopic } from '../kafka.js';
import { shutdownSignal } from '../runtime.js';
import { ReceiptMessage } from '../shared/receiptSchema.js';

/**
 * Kafka -> email_deliveries. The consumer only makes the receipt durable on our side; it
 * never sends email itself, so a slow provider can't stall the partition.
 *
 * Kafka is at-least-once (redelivery after a crash or rebalance, relay republishes), so
 * the insert is idempotent on (provider, payment_reference). The offset is committed only
 * after this resolves, so a crash here means redelivery, never loss.
 */
export async function handleReceiptMessage(
  pool: pg.Pool,
  msg: { topic: string; key: string | null; value: string | null },
): Promise<'inserted' | 'duplicate' | 'dead-letter'> {
  let parsed;
  try {
    parsed = ReceiptMessage.safeParse(JSON.parse(msg.value ?? ''));
  } catch (err) {
    parsed = { success: false as const, error: err as Error };
  }
  if (!parsed.success) {
    await pool.query('INSERT INTO dead_letters (topic, message_key, value, error) VALUES ($1, $2, $3, $4)', [
      msg.topic,
      msg.key,
      msg.value,
      parsed.error.message,
    ]);
    console.error(`ALERT receipt message rejected key=${msg.key}`);
    return 'dead-letter';
  }

  const m = parsed.data;
  const res = await pool.query(
    `INSERT INTO email_deliveries (provider, payment_reference, recipient, amount_minor, currency)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, payment_reference) DO NOTHING`,
    [m.provider, m.paymentReference, m.recipientEmail, m.amountMinor, m.currency],
  );
  return res.rowCount ? 'inserted' : 'duplicate';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const signal = shutdownSignal();
  const pool = createPool();
  const kafka = createKafka('notification-consumer');
  await ensureTopic(kafka);
  const consumer = kafka.consumer({ groupId: 'notification-service' });
  await consumer.connect();
  await consumer.subscribe({ topic: config.receiptTopic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const result = await handleReceiptMessage(pool, {
        topic,
        key: message.key?.toString() ?? null,
        value: message.value?.toString() ?? null,
      });
      console.log(`${message.key} ${result}`);
    },
  });
  signal.addEventListener('abort', async () => {
    await consumer.disconnect();
    await pool.end();
  });
}
