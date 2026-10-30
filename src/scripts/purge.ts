import type pg from 'pg';
import { createPool } from '../db.js';

export interface PurgeOptions {
  /** Delete webhook_events received more than this many days ago. */
  webhookEventDays: number;
  /** Delete dead_letters that were resolved more than this many days ago. */
  deadLetterDays: number;
}

export interface PurgeStatement {
  name: string;
  text: string;
  values: [number];
}

function days(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a whole number of days >= 1, got ${value}`);
  return value;
}

/** Pure SQL builder, so the retention rules can be tested without a database. */
export function buildPurgeStatements(opts: PurgeOptions): PurgeStatement[] {
  return [
    {
      name: 'webhook_events',
      text: "DELETE FROM webhook_events WHERE received_at < now() - make_interval(days => $1::int)",
      values: [days('WEBHOOK_EVENT_RETENTION_DAYS', opts.webhookEventDays)],
    },
    {
      name: 'dead_letters',
      // Only resolved ones: an unresolved dead letter is an open problem, not old data.
      text:
        'DELETE FROM dead_letters WHERE resolved_at IS NOT NULL AND resolved_at < now() - make_interval(days => $1::int)',
      values: [days('DEAD_LETTER_RETENTION_DAYS', opts.deadLetterDays)],
    },
  ];
}

export function purgeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PurgeOptions {
  return {
    webhookEventDays: Number(env.WEBHOOK_EVENT_RETENTION_DAYS ?? 30),
    deadLetterDays: Number(env.DEAD_LETTER_RETENTION_DAYS ?? 30),
  };
}

export async function purge(pool: pg.Pool, opts: PurgeOptions): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const { name, text, values } of buildPurgeStatements(opts)) {
    deleted[name] = (await pool.query(text, values)).rowCount ?? 0;
  }
  return deleted;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  try {
    console.log('purged', await purge(pool, purgeOptionsFromEnv()));
  } finally {
    await pool.end();
  }
}
