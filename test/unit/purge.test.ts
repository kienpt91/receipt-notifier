import { describe, expect, it } from 'vitest';
import { buildPurgeStatements, purgeOptionsFromEnv } from '../../src/scripts/purge.js';

describe('purge', () => {
  it('builds age-bounded deletes for webhook_events and resolved dead letters only', () => {
    const [webhooks, deadLetters] = buildPurgeStatements({ webhookEventDays: 14, deadLetterDays: 90 });
    expect(webhooks).toMatchObject({ name: 'webhook_events', values: [14] });
    expect(webhooks!.text).toMatch(/^DELETE FROM webhook_events WHERE received_at < now\(\) - make_interval/);
    expect(deadLetters).toMatchObject({ name: 'dead_letters', values: [90] });
    expect(deadLetters!.text).toContain('resolved_at IS NOT NULL');
    expect(deadLetters!.text).toContain('resolved_at < now()');
  });

  it('never touches payments, outbox or email_deliveries', () => {
    const sql = buildPurgeStatements({ webhookEventDays: 1, deadLetterDays: 1 }).map((s) => s.text).join(' ');
    expect(sql).not.toMatch(/payments|outbox|email_deliveries/);
  });

  it.each([0, -1, 1.5, NaN])('rejects an invalid age of %s days', (n) => {
    expect(() => buildPurgeStatements({ webhookEventDays: n, deadLetterDays: 30 })).toThrow(/days/);
    expect(() => buildPurgeStatements({ webhookEventDays: 30, deadLetterDays: n })).toThrow(/days/);
  });

  it('reads retention from env with 30-day defaults', () => {
    expect(purgeOptionsFromEnv({})).toEqual({ webhookEventDays: 30, deadLetterDays: 30 });
    expect(purgeOptionsFromEnv({ WEBHOOK_EVENT_RETENTION_DAYS: '7', DEAD_LETTER_RETENTION_DAYS: '60' })).toEqual({
      webhookEventDays: 7,
      deadLetterDays: 60,
    });
  });
});
