import type pg from 'pg';
import { createPool } from '../db.js';
import { shutdownSignal, sleep } from '../runtime.js';

/**
 * The "cronjob every 10 minutes" from the design. It is not part of the happy path; it
 * catches what slipped past it and raises alerts:
 *   - outbox rows published long ago with no delivery row (message lost, e.g. topic
 *     retention, or a consumer bug) -> unpublish so the relay sends them again
 *   - outbox rows never published (relay down)                   -> alert
 *   - deliveries that are dead                                   -> alert
 * Messages the consumer dead-lettered are left alone: republishing would loop forever.
 * Republishing is safe because every hop downstream is idempotent.
 */
export async function reconcileOnce(pool: pg.Pool, olderThan = '10 minutes') {
  const republished = await pool.query(
    `UPDATE outbox o SET published_at = NULL
     WHERE o.published_at < now() - $1::interval
       AND o.dedupe_key LIKE 'receipt:%'
       AND NOT EXISTS (
         SELECT 1 FROM email_deliveries d
         WHERE o.dedupe_key = 'receipt:' || d.provider || ':' || d.payment_reference)
       -- Rejected by the consumer: republishing can't help, it's already alerting.
       AND NOT EXISTS (SELECT 1 FROM dead_letters dl WHERE dl.message_key = o.message_key)
     RETURNING o.id`,
    [olderThan],
  );
  const unpublished = await pool.query(
    'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL AND created_at < now() - $1::interval',
    [olderThan],
  );
  const dead = await pool.query("SELECT count(*)::int AS n FROM email_deliveries WHERE status = 'dead'");

  const summary = {
    republished: republished.rowCount ?? 0,
    stuckUnpublished: unpublished.rows[0].n as number,
    dead: dead.rows[0].n as number,
  };
  if (summary.republished || summary.stuckUnpublished || summary.dead) {
    console.error('ALERT receipt reconciliation', summary);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const signal = shutdownSignal();
  const pool = createPool();
  const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? 10 * 60 * 1000);
  while (!signal.aborted) {
    console.log('reconcile', await reconcileOnce(pool).catch((err) => ({ error: String(err) })));
    await sleep(intervalMs, signal);
  }
  await pool.end();
}
