import type { Redis } from 'ioredis';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface SendOptions {
  /** Stable per receipt. Real providers (Resend, Postmark...) dedupe retries on it. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface EmailProvider {
  send(message: EmailMessage, options: SendOptions): Promise<{ messageId: string }>;
}

/** The provider rejected the message for good (bad address, suppressed...). Don't retry. */
export class PermanentEmailError extends Error {}

/**
 * Stand-in for a real provider with an idempotency key. Its state lives in Redis, not in
 * our DB, so it behaves like an external system shared by all worker processes:
 *   fakemail:calls:<key>  how many times we called it (can be > 1 after a crash)
 *   fakemail:sent:<key>   set once; a duplicate call is acknowledged but not re-delivered
 *   fakemail:inbox        what customers actually received
 */
export class FakeEmailProvider implements EmailProvider {
  /** Test hook: make the next N calls fail. */
  failNext = 0;
  failPermanently = false;

  constructor(private redis: Redis) {}

  async send(message: EmailMessage, { idempotencyKey }: SendOptions) {
    await this.redis.incr(`fakemail:calls:${idempotencyKey}`);
    if (this.failPermanently) throw new PermanentEmailError('recipient rejected');
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('provider 503');
    }
    const messageId = `fake_${idempotencyKey}`;
    const firstTime = await this.redis.set(`fakemail:sent:${idempotencyKey}`, messageId, 'NX');
    if (firstTime) await this.redis.rpush('fakemail:inbox', JSON.stringify({ idempotencyKey, ...message }));
    return { messageId };
  }
}
