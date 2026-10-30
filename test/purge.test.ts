import { beforeEach, describe, expect, it } from 'vitest';
import { purge } from '../src/scripts/purge.js';
import { pool, resetState } from './helpers.js';

beforeEach(resetState);

describe('purge', () => {
  it('deletes old webhook events and old resolved dead letters only', async () => {
    await pool.query(
      `INSERT INTO webhook_events (provider, event_id, event_type, payload, received_at) VALUES
       ('whop', 'old', 't', '{}', now() - interval '40 days'),
       ('whop', 'new', 't', '{}', now() - interval '1 day')`,
    );
    await pool.query(
      `INSERT INTO dead_letters (topic, value, error, resolved_at) VALUES
       ('t', 'a', 'e', now() - interval '40 days'),
       ('t', 'b', 'e', now() - interval '1 day'),
       ('t', 'c', 'e', NULL)`,
    );
    expect(await purge(pool, { webhookEventDays: 30, deadLetterDays: 30 })).toEqual({ webhook_events: 1, dead_letters: 1 });
    expect((await pool.query('SELECT event_id FROM webhook_events')).rows).toEqual([{ event_id: 'new' }]);
    expect((await pool.query('SELECT value FROM dead_letters ORDER BY id')).rows).toEqual([{ value: 'b' }, { value: 'c' }]);
  });
});
