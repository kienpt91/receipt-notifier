import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { config } from '../config.js';
import { createPool, withTransaction } from '../db.js';
import { ReceiptRequest, fieldErrors } from '../shared/receiptSchema.js';
import { recordPaymentAndEnqueueReceipt } from './recordPayment.js';
import { redactWhopEvent, toReceipt, verifyWhopWebhook } from './whop.js';

// Whop retries for ~3 days with the same webhook-id; remember ids for that long.
const SEEN_TTL_SECONDS = 3 * 24 * 60 * 60;

export interface AdminRateLimit {
  max: number;
  timeWindow: string | number;
}

// Per client IP, in memory (per API instance). Enough to make guessing ADMIN_TOKEN impractical.
const DEFAULT_ADMIN_RATE_LIMIT: AdminRateLimit = { max: 30, timeWindow: '1 minute' };

export function buildServer(deps: {
  pool: pg.Pool;
  redis: Redis;
  whopSecret?: string;
  adminToken?: string;
  adminRateLimit?: AdminRateLimit;
  /** Override for tests (e.g. to capture log lines). */
  logger?: FastifyServerOptions['logger'];
}) {
  const { pool, redis } = deps;
  const whopSecret = deps.whopSecret ?? config.whopWebhookSecret;
  const adminToken = deps.adminToken ?? config.adminToken;
  const app = Fastify({ logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? 'info' } });

  // Never leak internals (SQL errors, stack traces, paths) to clients: log the detail here,
  // answer with a generic body. 4xx (bad JSON, body too large, rate limited) keep their status.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal server error' });
    }
    return reply.code(status).send({ error: err.message });
  });

  // Security headers on every response, including the static form and /admin/*.
  app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // public/index.html has an inline <style>
        connectSrc: ["'self'"],
        imgSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // Keep JSON bodies as raw strings: the webhook signature covers the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.register(fastifyStatic, { root: fileURLToPath(new URL('../../public/', import.meta.url)) });

  app.post('/webhooks/whop', async (req, reply) => {
    const headers = req.headers as Record<string, string>;
    let event;
    try {
      event = verifyWhopWebhook(String(req.body ?? ''), headers, whopSecret);
    } catch {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const deliveryId = headers['webhook-id'] ?? event.id;
    const seenKey = `whop:webhook:${deliveryId}`;

    // Fast path only. Redis being down must not block payments, and a Redis hit is
    // only trusted because the key is written AFTER the DB commit below.
    const seen = await redis.exists(seenKey).catch(() => 0);
    if (seen) return reply.code(200).send({ status: 'duplicate' });

    if (event.type !== 'payment.succeeded') return reply.code(200).send({ status: 'ignored' });

    const mapped = toReceipt(event.raw);
    const result = await withTransaction(pool, async (c) => {
      const inserted = await c.query(
        `INSERT INTO webhook_events (provider, event_id, event_type, payload)
         VALUES ('whop', $1, $2, $3) ON CONFLICT DO NOTHING`,
        [deliveryId, event.type, redactWhopEvent(event.raw)],
      );
      if (!inserted.rowCount) return 'duplicate' as const;
      if (!mapped.ok) return 'rejected' as const;
      return recordPaymentAndEnqueueReceipt(c, {
        provider: 'whop',
        receipt: mapped.receipt,
        status: mapped.status,
        paidAt: mapped.paidAt,
      });
    });

    if (result === 'rejected' && !mapped.ok) {
      // A permanent data problem. Retrying the webhook won't fix it, so ACK it, but page a
      // human; a redacted copy (no customer email) is kept in webhook_events for diagnosis.
      req.log.error({ alert: true, deliveryId, reason: mapped.reason }, 'ALERT whop payment cannot produce a receipt');
    }
    if (result === 'conflict') {
      req.log.error({ alert: true, deliveryId }, 'ALERT whop payment re-sent with a different receipt; first one kept');
    }
    await redis.set(seenKey, '1', 'EX', SEEN_TTL_SECONDS).catch(() => {});
    return reply.code(200).send({ status: result });
  });

  // Admin "manual payment" form (e.g. bank transfer). Same schema, same enqueue path.
  // Rate limit is scoped to this plugin, so it only covers /admin/*.
  app.register(async (admin) => {
    await admin.register(fastifyRateLimit, { global: true, ...(deps.adminRateLimit ?? DEFAULT_ADMIN_RATE_LIMIT) });
    admin.post('/admin/receipts', async (req, reply) => {
      if (!isAdmin(req.headers.authorization, adminToken)) {
        // Log who and where, never the presented token.
        req.log.warn({ ip: req.ip, url: req.url }, 'admin auth failed');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      let body: unknown;
      try {
        body = JSON.parse(String(req.body ?? ''));
      } catch {
        return reply.code(400).send({ errors: { _form: ['Body must be JSON'] } });
      }
      const parsed = ReceiptRequest.safeParse(body);
      if (!parsed.success) return reply.code(400).send({ errors: fieldErrors(parsed.error) });

      const status = await withTransaction(pool, (c) =>
        recordPaymentAndEnqueueReceipt(c, { provider: 'manual', receipt: parsed.data, status: 'paid', paidAt: new Date() }),
      );
      if (status === 'conflict') {
        return reply.code(409).send({ errors: { paymentReference: ['This reference was already used for a different receipt'] } });
      }
      return reply.code(status === 'queued' ? 202 : 200).send({ status });
    });
  });

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

function isAdmin(header: string | undefined, token: string) {
  const given = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Fail fast when Redis is down instead of queueing commands: it's only a fast path.
  const redis = new Redis(config.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const app = buildServer({ pool: createPool(), redis });
  await app.listen({ port: config.port, host: config.host });
}
