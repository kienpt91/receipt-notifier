# Security policy

## Status of this project

receipt-notifier is a **reference implementation**. Email delivery is **simulated**: the
worker uses `FakeEmailProvider`, which writes to a Redis list and sends nothing. It refuses
to start with `NODE_ENV=production` until a real `EmailProvider` is wired in. The
`docker-compose.yml` is for development and CI only.

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases.

## Reporting a vulnerability

Please report privately, not in a public issue:

- Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
  the repository, or
- email **kienphan.dev@gmail.com**.

Include affected version/commit, reproduction steps and impact. Expect an acknowledgement
within a few days.

## Dependency policy

Dependencies are pinned to exact versions, and only versions published at least 30 days
before the lockfile was last updated are used (cutoff for the current lockfile:
2026-09-30). Security fixes released after the cutoff are therefore not yet taken; they are
listed below until the cutoff moves.

## Known open advisories

`npm audit` at the current lockfile (fixes exist only in versions newer than the cutoff):

| Package | Installed | Advisory | Fixed in | Scope | Reachability here |
|---|---|---|---|---|---|
| `zod` (direct) | 4.6.5 | memory exhaustion validating oversized constrained collections (high) | 4.6.7 | runtime | Low. Receipt schemas only validate fixed-shape objects and bounded strings (email ≤254, reference ≤64, amount ≤18 digits); no user-controlled arrays/sets/records. |
| `fastify` (direct) | 5.12.5 | header validation bypass via case-sensitive `propertyNames` (low) | 5.12.7 | runtime | None known. No route defines a JSON-schema header validation. |
| `fast-uri` (via fastify/ajv) | 3.1.8, 4.2.1 | URI parsing/normalisation issues (moderate) | 3.1.9 / 4.2.3 | runtime | None known. Used by fastify's schema compiler on developer-supplied schemas, never on request data. |
| `ip-address` (via `@fastify/rate-limit`) | 10.7.2 | quadratic-time IPv6 zone parsing (moderate) | 10.7.4+ | runtime | Low. The client IP comes from the TCP socket (`trustProxy` is off), not from a user-supplied header. If you enable `trustProxy`, treat as exposed. |
| `vitest`, `@vitest/mocker`, `vite`, `source-map-js`, `postcss` chain | 5.0.2 / 8.3.1 / 1.2.1 | various (up to high) | 5.0.5 / 8.3.5 / 1.2.2 | **dev only** | None in production: not installed in the image (`npm ci --omit=dev`). Affects developers running the vite dev server or tests; vitest's code-injection issue needs an attacker-controlled mock registration. |

`@fastify/static` is at 10.1.5. A later release (10.1.8, published 2026-10-27, after the
cutoff) is reported to fix a route-guard bypass via non-canonical paths. It is not taken yet.
Reachability: the static handler only serves `public/index.html` and `public/form.js`,
which are public by design, and no authorization guard is attached to static routes. The
authenticated route `/admin/receipts` is a regular Fastify route, not served by the static
plugin.

GitHub Actions are pinned to commit SHAs of releases published on or before the cutoff.
`docker-compose.yml` uses floating dev-only image tags (`postgres:16-alpine`,
`redis:7-alpine`, `apache/kafka:3.8.0`); the production `Dockerfile` base image is pinned
by digest (`node:22.22-alpine3.24`, pushed 2026-06-16).
