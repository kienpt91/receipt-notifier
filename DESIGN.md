# Design: payment receipt emails

Goal: when a payment succeeds, the customer gets exactly one receipt email. That has to
hold through process crashes, duplicate events and several concurrent workers.

## Architecture

```
Whop ──webhook──▶ App API ──one DB tx──▶ payments + outbox ──relay──▶ Kafka
                    ▲                                                   │
Admin form ─────────┘ (manual payments)                                 ▼
                                               notification consumer ──▶ email_deliveries
                                                                            │ SKIP LOCKED + lease
                                                                            ▼
                                                                   delivery workers ──▶ email provider
                                                                                       (idempotency key)
reconciler (every 10 min): republishes lost messages, alerts on stuck/dead rows
```

| Process | Scales to | Owns |
|---|---|---|
| API (`src/api/server.ts`) | N | webhook verification, validation, the payment + outbox transaction |
| Relay (`src/relay/relay.ts`) | N | outbox → Kafka |
| Consumer (`src/notification/consumer.ts`) | ≤ partitions | Kafka → `email_deliveries` |
| Worker (`src/notification/worker.ts`) | N | `email_deliveries` → provider |
| Reconciler (`src/notification/reconciler.ts`) | 1+ | safety net and alerts |

## A row's lifecycle

1. **Whop sends `payment.succeeded`.** The API verifies the Standard Webhooks signature
   against the raw bytes and maps the payload through the shared schema. In **one
   transaction** it inserts:
   - `webhook_events` (PK = `webhook-id`, so a Whop retry is a no-op)
   - `payments` (unique `(provider, provider_payment_id)`)
   - `outbox` (unique `dedupe_key = receipt:whop:pay_…`)

   It returns 200 only after COMMIT. A crash before COMMIT leaves nothing behind, and
   Whop retries. A crash after COMMIT leaves the receipt durable.
2. **Relay** locks unpublished outbox rows (`FOR UPDATE SKIP LOCKED`), publishes them
   with `acks=all`, and sets `published_at` in the same transaction. If it crashes after
   publishing but before COMMIT, the row is published again. That is at-least-once, by
   design.
3. **Consumer** validates the message with the same schema and does
   `INSERT … ON CONFLICT (provider, payment_reference) DO NOTHING`. It commits the Kafka
   offset only after that, so redelivery is harmless and a crash loses nothing. A message
   that fails validation goes to `dead_letters` and raises an alert; it is never dropped.
4. **Worker** claims rows in one statement:
   `UPDATE … SET status='sending', locked_by, locked_until=now()+lease, claims+1
   WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. It sends the batch concurrently.
   Right before each provider call it re-checks the lease and counts the attempt
   (`attempts+1 WHERE locked_by = me AND enough lease left`). It sends with
   `idempotencyKey = receipt-<provider>-<ref>`, then marks the row `sent`
   `WHERE locked_by = me`.

   `claims` and `attempts` are separate on purpose. Crashes unrelated to a row only
   raise its `claims`, so they can't use up its send attempts. Only a row picked up
   more than 3× `max_attempts` times (it keeps killing its workers) is parked.

   | Outcome | Next state |
   |---|---|
   | Transient error | `pending` with exponential backoff |
   | Permanent error, out of attempts, or invalid stored data | `dead` + alert |
   | First attempt older than the provider's idempotency window | `dead` + alert (a human checks the provider) |
   | Worker dies | lease expires, any worker reclaims the row |

```
pending ─claim─▶ sending ─ok─▶ sent
   ▲               │ transient error (backoff)
   └───────────────┤
                   ├─ permanent / max attempts / invalid ─▶ dead (alert)
                   └─ worker died: lease expires ─▶ reclaimable
```

## Exactly once: what the database can and can't guarantee

**What the database guarantees.** Every hop up to the provider is at-least-once delivery
with an idempotent write keyed on the payment:
- the `webhook-id` primary key
- the unique outbox key
- the unique delivery key
- `SKIP LOCKED` claims, so two workers never hold the same row

**What it can't guarantee.** No database can make an external API call exactly-once. If
the provider accepts the email and the worker dies before `UPDATE … sent`, the lease
expires and the row is sent again. The fix lives on the provider side: the stable
idempotency key makes that second call a no-op. The test
`worker dies after the provider accepted…` shows exactly this case: **2 calls, 1 email**.

**The honest bound.** Providers only dedupe for a limited time (Resend and Postmark: about
24h, set by `PROVIDER_IDEMPOTENCY_HOURS`). So the guarantee is exactly-once *within that
window*. Normal lease and backoff fit well inside it. After a longer outage, a resend
could duplicate an email that already landed, and we can't tell whether it did. So once
the first attempt is older than the window, the worker stops resending and parks the row
as `dead` with an alert. Never sending twice wins over sending automatically; a human
checks the provider's log and, if the email never arrived, runs
`npm run requeue -- <provider> <payment_reference>`. That resets the counters and the
window, not just the status; otherwise the row would be parked again at once.

**Lease rules.**
- A send only starts if at least half the lease is left, and it times out at half the
  lease, so it always finishes before anyone else can claim the row.
- Every state change is conditional on `locked_by = me`, so a worker that lost its lease
  can't overwrite the new owner's state.

## Money

- Stored as `amount_minor BIGINT` plus `currency CHAR(3)`, with
  `CHECK (amount_minor > 0)`.
- Inside the system it is a `bigint`. On the wire (JSON, Kafka) it is a decimal-integer
  string such as `"1999"`, never a JS number, so values above 2^53 stay exact.
- Whop sends decimals (`total: 6.9`). That is converted once, at the edge, by string
  parsing (`6.9 * 100 = 690.0000000000001` in floats). Inputs with more decimals than
  the currency allows are rejected, not rounded.
- Exponents come from the currency: JPY 0, USD 2, KWD 3. Formatting happens only when the
  email is rendered.
- The delivery row snapshots the amount, so the receipt shows what was charged.

## Validation: one schema, four layers

`src/shared/receiptSchema.ts` (zod) is the only definition. Each layer imports it and
reacts differently:

| Layer | Uses it for | On failure |
|---|---|---|
| Admin form (`src/web/form.ts`) | instant feedback | field errors, no request |
| API | trust boundary | 400 with the **same** field-error shape the form renders |
| Consumer | message off Kafka (schema versioned with `v: 1`) | `dead_letters` + alert |
| Worker | stored row, right before sending | `dead` + alert, provider never called |
| Postgres | `CHECK` / `NOT NULL` | transaction fails |

The Whop payload has its own narrow parser (`src/api/whop.ts`), because it is a foreign
format. Its output is still pushed through `ReceiptRequest`.

## Redis

Redis is a fast path only. The API checks `whop:webhook:<id>` before touching the
database. It writes the key **after** the database commits, never before. A `SET NX`
done first would make a crashed attempt look processed, and Whop's retry would then be
skipped, losing the receipt.

If Redis is down or flushed, the database constraints still dedupe. Both cases are
covered by tests.

## SQL, not an ORM

The guarantees depend on exact statements:
- `FOR UPDATE SKIP LOCKED`
- `ON CONFLICT DO NOTHING`
- `UPDATE … WHERE locked_by = $me`
- explicit transaction boundaries

An ORM would hide those or need raw-query escape hatches anyway; Prisma has no
`SKIP LOCKED`. It's a handful of queries, so raw `pg` keeps them visible and reviewable.
The cost is no generated types for rows. The row interfaces are small and the schema is
re-validated at the boundaries.

## Known limits / next steps

- **Owned tables.** `payments` and `email_deliveries` share one database here. In
  production the notification service owns its own, and the reconciler asks it through an
  API instead of a join.
- **Real email provider.** `FakeEmailProvider` stands in for one (it only writes to a Redis
  list and refuses to start under `NODE_ENV=production`). A real adapter (e.g.
  Resend with an `Idempotency-Key` header) only needs to implement `EmailProvider` and map
  4xx responses to `PermanentEmailError`.
- **No webhook replay.** A payment event that cannot produce a receipt (e.g. no customer
  email) is ACKed, alerted on, and kept in `webhook_events` in redacted form (no email).
  There is no replay tool: once the cause is fixed, record the payment through the admin
  form, which uses the same enqueue path.
- **Which Whop amount to bill.** `total` excludes buyer fees, so confirm with product
  which amount the receipt should show.
- **Kafka client.** kafkajs is unmaintained. Swap it for `@confluentinc/kafka-javascript`
  before production.
