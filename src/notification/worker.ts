import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { config } from '../config.js';
import { createPool } from '../db.js';
import { FakeEmailProvider, PermanentEmailError, type EmailProvider } from '../email/provider.js';
import { shutdownSignal, sleep } from '../runtime.js';
import { formatMinor } from '../shared/money.js';
import { ReceiptRequest } from '../shared/receiptSchema.js';

interface DeliveryRow {
  id: string;
  provider: string;
  payment_reference: string;
  recipient: string;
  amount_minor: string; // BIGINT arrives as a string
  currency: string;
  claims: number;
  attempts: number;
  max_attempts: number;
}

export interface WorkerOptions {
  workerId?: string;
  leaseSeconds?: number;
  batchSize?: number;
  baseBackoffMs?: number;
  providerIdempotencyHours?: number;
}

/**
 * Sends receipts from email_deliveries. Run as many as you like.
 *
 * pending --claim--> sending --send ok--> sent
 *                       |--transient--> pending (next_attempt_at = backoff)
 *                       |--permanent / out of attempts / invalid--> dead (+ alert)
 *                       '--worker dies--> lease expires --> reclaimed by any worker
 *
 * `claims` counts pickups (crash recovery included), `attempts` counts real sends, so
 * crashes unrelated to this row can't use up its attempts before it is ever sent.
 */
export class DeliveryWorker {
  readonly workerId: string;
  private leaseSeconds: number;
  private batchSize: number;
  private baseBackoffMs: number;
  private providerIdempotencyHours: number;

  constructor(private pool: pg.Pool, private provider: EmailProvider, opts: WorkerOptions = {}) {
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseSeconds = opts.leaseSeconds ?? config.leaseSeconds;
    this.batchSize = opts.batchSize ?? 10;
    this.baseBackoffMs = opts.baseBackoffMs ?? 30_000;
    this.providerIdempotencyHours = opts.providerIdempotencyHours ?? config.providerIdempotencyHours;
  }

  /**
   * One atomic statement: SKIP LOCKED means two workers never pick the same row, and the
   * status flip to 'sending' + lease happens in the same statement as the pick.
   * Expired leases (a worker died mid-send) are claimable again: never zero sends.
   */
  async claim(): Promise<DeliveryRow[]> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `UPDATE email_deliveries
       SET status = 'sending', locked_by = $1,
           locked_until = now() + make_interval(secs => $2), claims = claims + 1
       WHERE id IN (
         SELECT id FROM email_deliveries
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'sending' AND locked_until < now())
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3)
       RETURNING id, provider, payment_reference, recipient, amount_minor, currency, claims, attempts, max_attempts`,
      [this.workerId, this.leaseSeconds, this.batchSize],
    );
    return rows;
  }

  async runOnce(): Promise<number> {
    const rows = await this.claim();
    // Concurrently: every row's lease started at claim time, so sending them one after
    // another would let the later rows' leases expire before they are even attempted.
    const results = await Promise.allSettled(rows.map((row) => this.process(row)));
    for (const r of results) {
      if (r.status === 'rejected') console.error('delivery update failed; row is reclaimed after its lease', r.reason);
    }
    return rows.length;
  }

  /**
   * Starts a real send attempt. Re-checks the lease right before the provider call, with
   * enough time left for the whole send, and counts the attempt. Returns null when the
   * lease is gone: another worker owns the row now.
   */
  async beginAttempt(row: DeliveryRow): Promise<{ attempts: number; outsideWindow: boolean } | null> {
    const { rows } = await this.pool.query<{ attempts: number; outside_window: boolean }>(
      `UPDATE email_deliveries
       SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, now())
       WHERE id = $1 AND locked_by = $2 AND status = 'sending'
         AND locked_until > now() + make_interval(secs => $3)
       RETURNING attempts, first_attempt_at < now() - make_interval(hours => $4) AS outside_window`,
      [row.id, this.workerId, this.leaseSeconds / 2, this.providerIdempotencyHours],
    );
    return rows[0] ? { attempts: rows[0].attempts, outsideWindow: rows[0].outside_window } : null;
  }

  /** Exposed so tests can simulate a crash between send and mark-sent. */
  async sendOnly(row: DeliveryRow) {
    const receipt = ReceiptRequest.parse({
      recipientEmail: row.recipient,
      amountMinor: row.amount_minor,
      currency: row.currency,
      paymentReference: row.payment_reference,
    });
    const amount = formatMinor(BigInt(receipt.amountMinor), receipt.currency);
    return this.provider.send(
      {
        to: receipt.recipientEmail,
        subject: `Your receipt: ${amount}`,
        text: `Thanks for your payment of ${amount}.\nReference: ${receipt.paymentReference}`,
      },
      {
        // Stable across retries and across workers: the provider-side half of exactly-once.
        idempotencyKey: `receipt-${row.provider}-${row.payment_reference}`,
        // Never let a send outlive the lease, or another worker may already own the row.
        signal: AbortSignal.timeout((this.leaseSeconds * 1000) / 2),
      },
    );
  }

  private async process(row: DeliveryRow) {
    // Only a row that keeps killing its workers gets here; ordinary crashes don't.
    if (row.claims > row.max_attempts * 3) return this.markDead(row, `picked up ${row.claims} times without finishing`);
    if (!ReceiptRequest.safeParse(this.asRequest(row)).success) {
      return this.markDead(row, 'stored receipt failed validation');
    }
    const attempt = await this.beginAttempt(row);
    if (!attempt) return; // lease lost before sending; the new owner takes it from here
    // Past the provider's dedupe window a resend could reach the customer twice, and we
    // can't tell whether an earlier attempt landed. A human checks the provider instead.
    if (attempt.outsideWindow) {
      return this.markDead(row, 'earlier attempt is outside the provider idempotency window; check the provider before resending');
    }
    const { attempts } = attempt;
    try {
      const { messageId } = await this.sendOnly(row);
      const res = await this.pool.query(
        `UPDATE email_deliveries
         SET status = 'sent', sent_at = now(), provider_message_id = $3,
             locked_by = NULL, locked_until = NULL, last_error = NULL
         WHERE id = $1 AND locked_by = $2 AND status = 'sending'`,
        [row.id, this.workerId, messageId],
      );
      if (!res.rowCount) console.warn(`lease lost on delivery ${row.id}; owner's retry is deduped by the provider`);
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof PermanentEmailError || attempts >= row.max_attempts) return this.markDead(row, message);
      const delayMs = Math.min(this.baseBackoffMs * 2 ** (attempts - 1), 3_600_000) * (0.8 + Math.random() * 0.4);
      await this.pool.query(
        `UPDATE email_deliveries
         SET status = 'pending', locked_by = NULL, locked_until = NULL, last_error = $3,
             next_attempt_at = now() + make_interval(secs => $4)
         WHERE id = $1 AND locked_by = $2 AND status = 'sending'`,
        [row.id, this.workerId, message, delayMs / 1000],
      );
    }
  }

  private asRequest(row: DeliveryRow) {
    return {
      recipientEmail: row.recipient,
      amountMinor: row.amount_minor,
      currency: row.currency,
      paymentReference: row.payment_reference,
    };
  }

  private async markDead(row: DeliveryRow, reason: string) {
    await this.pool.query(
      `UPDATE email_deliveries SET status = 'dead', locked_by = NULL, locked_until = NULL, last_error = $3
       WHERE id = $1 AND locked_by = $2`,
      [row.id, this.workerId, reason],
    );
    console.error(`ALERT receipt ${row.provider}:${row.payment_reference} is dead: ${reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const signal = shutdownSignal();
  const pool = createPool();
  const redis = new Redis(config.redisUrl);
  const worker = new DeliveryWorker(pool, new FakeEmailProvider(redis));
  console.log(`worker ${worker.workerId} started`);
  while (!signal.aborted) {
    try {
      if (!(await worker.runOnce())) await sleep(500, signal);
    } catch (err) {
      console.error('worker batch failed; claimed rows will be reclaimed after their lease', err);
      await sleep(2000, signal);
    }
  }
  await pool.end();
  redis.disconnect();
}
