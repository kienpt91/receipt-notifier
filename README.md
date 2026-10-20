# receipt-notifier

Sends exactly one receipt email per successful payment. It is built to survive crashes,
duplicate webhooks and concurrent workers, using Node.js/TypeScript, Postgres, Kafka and
Redis. The design walkthrough is in [DESIGN.md](DESIGN.md).

## Run locally

Requires Node 22+ and Docker.

```bash
npm ci
docker compose up -d        # Postgres :55432, Redis :56379, Kafka :59092
npm run migrate
npm test                    # runs against the real services
```

Start every process, each in its own terminal; run as many workers as you like:

```bash
npm run api          # http://localhost:3100 (admin form at /)
npm run relay
npm run consumer
npm run worker
npm run reconciler
```

## Configuration

| Env | Default |
|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:55432/receipts` |
| `REDIS_URL` | `redis://localhost:56379` |
| `KAFKA_BROKERS` | `localhost:59092` |
| `WHOP_WEBHOOK_SECRET` | dev value. In production, use the `ws_…` secret from the Whop dashboard, verbatim |
| `ADMIN_TOKEN` | dev value |
| `LEASE_SECONDS` | `60` |

## CI/CD

GitHub Actions runs on every pull request: typecheck, then the full test suite against
Postgres, Redis and Kafka started with the same `docker-compose.yml`. Each push to `main`
also builds the image and publishes it to `ghcr.io/<owner>/receipt-notifier`.
