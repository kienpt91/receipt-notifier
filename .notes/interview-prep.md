# Interview prep (local only, gitignored)

## How the design mapped from my diagram
| My diagram | What it became | Why it changed |
|---|---|---|
| App worker writes DB **and** publishes to Kafka | Outbox row in the same tx, relay publishes it | Dual write: a crash between the two loses or fakes a receipt |
| Redis single-thread lock to prevent duplicates | Redis = fast-path check, written **after** COMMIT; DB unique keys = the guarantee | A Redis lock has a TTL and can vanish on failover. SET-NX-first loses events after a crash |
| Notification worker with a `sent_at` field | `email_deliveries` with SKIP LOCKED claim + lease + `locked_by` guard + provider idempotency key | Check-then-set on `sent_at` races; setting it before the send loses mail, setting it after sends twice on a crash |
| Cronjob every 10 min | Reconciler: republish outbox rows that never produced a delivery, alert on stuck/dead rows | Needs a precise job and must be idempotent itself |
| Monitoring compares payment vs transaction | Same idea: dead rows, dead_letters and stuck outbox rows raise alerts | |
| FE prevents duplicate clicks | Kept, but only as UX; the server dedupes by reference | |

## Exactly-once in one sentence
At-least-once at every hop plus an idempotent write keyed on the payment at every hop. The one hop the DB can't cover (the external send) is covered by the provider idempotency key. Proof: test "worker dies after the provider accepted…" → 2 calls, 1 email.

## Where AI helped / what I checked / where I trust it less
- **Helped:** scaffolding, SQL and test boilerplate, docker-compose for KRaft Kafka, a first pass of DESIGN.md.
- **Checked by hand:**
  - **Whop webhook secret encoding.** The docs were contradictory: one guide says `btoa(secret)`, another says "pass verbatim". I read the `@whop/sdk` source (`helpers/verifyWebhook.mjs`). The SDK base64-encodes internally because Whop HMACs the literal secret bytes, so: use the SDK, pass the secret verbatim.
  - **Whop amounts are decimals (`6.9`), not cents.** The naive `* 100` gives 690.0000000000001. Converted by string parsing instead, with a test.
  - **Redis dedupe ordering.** A typical suggestion is "SET NX first", which loses an event if the process crashes before COMMIT.
  - **Claims of "exactly once".** AI tends to say SKIP LOCKED gives exactly-once delivery. It gives exactly-once *claiming*; delivery needs the idempotency key.
  - **`pg` returns BIGINT as a string.** Kept it a string on purpose, never `Number()`.
- **Trust it less:** concurrency semantics, failure windows, anything about a specific vendor's API (verify against docs or source), and tests that just encode what the code already does.

## Open questions to raise
- Which Whop amount the receipt shows: `total` excludes buyer fees.
- Whop `user.email` needs the `member:email:read` scope; without it the event is ACKed, stored, and an alert fires.
- In production the notification service owns its own DB, and the reconciler goes through an API instead of a join.
