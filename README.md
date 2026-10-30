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
npm ci
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

## CI/CD

GitHub Actions runs on every pull request: typecheck, then the full test suite against
Postgres, Redis and Kafka started with the same `docker-compose.yml`. Each push to `main`
also builds the image and publishes it to `ghcr.io/<owner>/receipt-notifier`.
