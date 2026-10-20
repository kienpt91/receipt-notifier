import type pg from 'pg';
import { createPool } from '../db.js';

/**
 * Operator action for a 'dead' receipt, after a human has checked the provider's log and
 * confirmed the email never arrived. Resets the counters and the idempotency window as
 * well as the status; flipping only the status would get the row parked again at once.
 */
export async function requeueDelivery(pool: pg.Pool, provider: string, paymentReference: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE email_deliveries
     SET status = 'pending', next_attempt_at = now(), claims = 0, attempts = 0,
         first_attempt_at = NULL, locked_by = NULL, locked_until = NULL,
         last_error = 'requeued by operator: ' || coalesce(last_error, '')
     WHERE provider = $1 AND payment_reference = $2 AND status = 'dead'`,
    [provider, paymentReference],
  );
  return res.rowCount === 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [provider, ref] = process.argv.slice(2);
  if (!provider || !ref) {
    console.error('usage: npm run requeue -- <provider> <payment_reference>');
    process.exit(2);
  }
  const pool = createPool();
  const ok = await requeueDelivery(pool, provider, ref);
  console.log(ok ? `requeued ${provider}:${ref}` : `no dead delivery ${provider}:${ref}`);
  await pool.end();
  process.exit(ok ? 0 : 1);
}
