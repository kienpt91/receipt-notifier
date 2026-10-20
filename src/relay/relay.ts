import type { Producer } from 'kafkajs';
import type pg from 'pg';
import { createPool, withTransaction } from '../db.js';
import { createKafka, ensureTopic } from '../kafka.js';
import { shutdownSignal, sleep } from '../runtime.js';

/**
 * Publishes unpublished outbox rows to Kafka. Any number of relays can run:
 * FOR UPDATE SKIP LOCKED hands each row to exactly one of them.
 *
 * The row lock is held while sending. If the relay crashes after Kafka acks but before
 * COMMIT, the transaction rolls back and the row is published again. That is a deliberate
 * at-least-once: the consumer dedupes on (provider, payment_reference).
 */
export async function relayBatch(pool: pg.Pool, producer: Producer, limit = 100): Promise<number> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<{ id: string; topic: string; message_key: string; payload: unknown }>(
      `SELECT id, topic, message_key, payload FROM outbox
       WHERE published_at IS NULL
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const byTopic = new Map<string, { key: string; value: string }[]>();
    for (const r of rows) {
      const list = byTopic.get(r.topic) ?? [];
      list.push({ key: r.message_key, value: JSON.stringify(r.payload) });
      byTopic.set(r.topic, list);
    }
    await producer.sendBatch({
      acks: -1, // all in-sync replicas
      topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
    });

    await c.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
    return rows.length;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const signal = shutdownSignal();
  const pool = createPool();
  const kafka = createKafka('outbox-relay');
  await ensureTopic(kafka);
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  console.log('relay started');
  while (!signal.aborted) {
    try {
      const n = await relayBatch(pool, producer);
      if (n) console.log(`published ${n}`);
      else await sleep(500, signal);
    } catch (err) {
      console.error('relay batch failed; rows stay unpublished and will be retried', err);
      await sleep(2000, signal);
    }
  }
  await producer.disconnect();
  await pool.end();
}
