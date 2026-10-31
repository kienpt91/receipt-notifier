# receipt-notifier

Sends exactly one receipt email per successful payment. It is built to survive crashes,
duplicate webhooks and concurrent workers, using Node.js/TypeScript, Postgres, Kafka and
Redis. The design walkthrough is in [DESIGN.md](DESIGN.md).

> **Email delivery is simulated.** The worker uses `FakeEmailProvider`, which only records
> the "sent" message in a Redis list (`fakemail:inbox`); no real email leaves this system.
> This is a reference implementation until a real `EmailProvider` (Resend, Postmark, ...) is
> wired into `src/notification/worker.ts`. To stop it being deployed by mistake,
> `FakeEmailProvider` refuses to start when `NODE_ENV=production`.

## Run locally

Requires Node 22+ and Docker.

```bash
npm ci --ignore-scripts
docker compose up -d        # dev/test only: Postgres :55432, Redis :56379, Kafka :59092 (127.0.0.1)
npm run migrate
npm test                    # runs against the real services
```

Start every process, each in its own terminal; run as many workers as you like. Outside
tests the processes need `NODE_ENV=development` (see [Configuration](#configuration)):

```bash
export NODE_ENV=development
npm run api          # http://127.0.0.1:3100 (admin form at /)
npm run relay
npm run consumer
npm run worker
npm run reconciler
```

A receipt parked as `dead` (alerted) is requeued, once someone has checked the provider,
with `npm run requeue -- <provider> <payment_reference>`.

`docker-compose.yml` is for local development and CI only (throwaway credentials, no auth,
ports bound to loopback). Production needs its own managed Postgres, Redis and Kafka with
real credentials, passed in through `DATABASE_URL`, `REDIS_URL` and `KAFKA_BROKERS`.

## Admin endpoint

`POST /admin/receipts` needs `Authorization: Bearer <ADMIN_TOKEN>`. It is rate limited per
client IP (30 requests/minute, in memory per API instance), failed attempts are logged
(client IP and URL, never the token), and every response carries CSP, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Put the API behind TLS;
the token travels in a header. Unexpected errors return a generic `500` body, details go to
the server log only.

## Data retention

`webhook_events` keeps a *redacted* copy of each Whop webhook (ids, amount, currency,
status, dates; no customer email or other personal data). `payments` and `email_deliveries`
still hold the customer's email, as the receipt needs it. `dead_letters.value` holds the raw
Kafka message, which includes the email.

Run `npm run purge` periodically (cron, scheduled job) to delete:

- `webhook_events` older than `WEBHOOK_EVENT_RETENTION_DAYS` (default `30`)
- `dead_letters` that were marked resolved more than `DEAD_LETTER_RETENTION_DAYS` ago
  (default `30`). Mark one resolved with
  `UPDATE dead_letters SET resolved_at = now() WHERE id = <id>`. Unresolved ones are never purged.

## Configuration

| Env | Default |
|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:55432/receipts` |
| `REDIS_URL` | `redis://localhost:56379` |
| `KAFKA_BROKERS` | `localhost:59092` |
| `NODE_ENV` | unset. Dev defaults for the two secrets below apply **only** when this is `development` or `test`; any other value (or unset) requires real secrets and the API refuses to start without them |
| `WHOP_WEBHOOK_SECRET` | required unless `NODE_ENV` is `development`/`test`. Use the `ws_…` secret from the Whop dashboard, verbatim |
| `ADMIN_TOKEN` | required unless `NODE_ENV` is `development`/`test`; at least 24 characters (e.g. `openssl rand -hex 32`) |
| `HOST` | `127.0.0.1` (loopback only). Set `0.0.0.0` to expose the API, e.g. in a container (the Docker image does this) |
| `PORT` | `3100` |
| `LEASE_SECONDS` | `60` |
| `WEBHOOK_EVENT_RETENTION_DAYS` | `30` (used by `npm run purge`) |
| `DEAD_LETTER_RETENTION_DAYS` | `30` (used by `npm run purge`) |

## CI/CD

GitHub Actions runs on every pull request: typecheck, then the full test suite against
Postgres, Redis and Kafka started with the same `docker-compose.yml`. Each push to `main`
also builds the image and publishes it to `ghcr.io/<owner>/receipt-notifier`.

## Secrets and hooks

- Never commit `.env` files or credentials. Copy `.env.example` to `.env` for local settings; `.env` is gitignored.
- Install [lefthook](https://github.com/evilmartians/lefthook) and run `lefthook install` once per clone. This enables two hooks from `lefthook.yml`:
  - `pre-commit` runs `sh scripts/secret-scan.sh --staged` and blocks a commit that stages a secret.
  - `pre-push` runs `sh scripts/secret-scan.sh --tree` and blocks a push if the working tree contains one.
- The scanner (`scripts/secret-scan.sh`) has no dependencies. It flags secret-shaped values and forbidden file names, and prints the file, line and rule but never the value. CI also scans the tree and the full history.
- A reviewed false positive can be listed in `.secret-scan-allow`, one line per file and rule: `<path> <rule>  # reason`. A single line can be allowed with the inline marker `secret-scan: allow`. Keep entries specific and never allow a real credential.
- If a secret is ever committed, rotate it first (assume it is compromised), then remove it from history.

