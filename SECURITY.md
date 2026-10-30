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

Dependencies are pinned to exact versions, and only versions published at least 7 days
before the lockfile was last updated are used (cutoff for the current lockfile:
2026-10-23). Security fixes released inside the 7-day window are therefore not yet taken;
they are listed below until the cutoff moves.

Installs, tests, typechecks and builds are run in a throwaway container, and packages are
installed with `--ignore-scripts` (`npm ci --ignore-scripts` in CI and the Dockerfile), so
dependency install scripts never run. No dependency needs one: `esbuild` falls back to its
bundled platform binary package and `fsevents` is optional and macOS-only.

## Known open advisories

`npm audit` (full and `--omit=dev`) at the current lockfile reports **0 vulnerabilities**.
The previously listed advisories (`zod`, `fastify`, `fast-uri`, `ip-address`, the
`vitest`/`vite`/`postcss`/`source-map-js` chain) are fixed by the current versions (`zod` 4.6.7, `fastify` 5.12.7, `fast-uri`
3.1.9/4.2.3, `ip-address` 10.7.4, `vitest` 5.0.5, `vite` 8.3.5).
Anything published after the cutoff is not yet covered by this check.

One advisory is still open because its fix is inside the cooldown window: `@fastify/static`
is at 10.1.7; 10.1.8 (published 2026-10-27, after the cutoff) is reported to fix a
route-guard bypass via non-canonical paths, and `npm audit` does not list it yet.
Reachability: the static handler only serves `public/index.html` and `public/form.js`,
which are public by design, and no authorization guard is attached to static routes. The
authenticated route `/admin/receipts` is a regular Fastify route, not served by the static
plugin.

GitHub Actions are pinned to commit SHAs of releases published on or before the cutoff.
`docker-compose.yml` uses floating dev-only image tags (`postgres:16-alpine`,
`redis:7-alpine`, `apache/kafka:3.8.0`); the production `Dockerfile` base image is pinned
by digest (`node:22.22-alpine3.24`, pushed 2026-06-16).
