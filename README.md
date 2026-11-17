# Zentry

Error tracking that speaks the Sentry SDK protocol and runs on Cloudflare:
one Worker, D1, R2 and Queues. Errors and stack traces, grouped into issues,
in a Sentry-like UI. No tracing, performance, replays or alerting.

Apps keep the official `@sentry/*` or `sentry-sdk` packages and change only
the DSN.

The full design, including the schema and the reasoning, is in
[DESIGN.md](DESIGN.md). Start with §17 for how the code differs from it.

## Run it locally

```bash
pnpm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
pnpm migrate:local
```

```bash
pnpm build
```

```bash
pnpm dev
```

Open <http://localhost:8787>, create a project, and copy its DSN into an
app's `Sentry.init`. Events appear a few seconds later (the queue batches
for up to five seconds).

`pnpm dev:ui` serves the UI with hot reload on another port and proxies the
API to `pnpm dev`.

## Checks

```bash
pnpm check
```

That runs the formatter check, the linter, both type checks and the tests.
All four must pass; there are no warnings. The same command runs in CI and
the formatter and linter run on staged files before each commit.

| Command | What it does |
|---|---|
| `pnpm fmt` | Format everything with oxfmt |
| `pnpm lint` | oxlint with the vendored anti-slop rules and the folder import rules |
| `pnpm typecheck` | `tsc` for the Worker, the UI and the e2e tests |
| `pnpm test` | vitest, inside the Workers runtime with local D1, R2 and Queues |

## End-to-end tests

```bash
pnpm e2e
```

This builds the UI, starts Zentry on port 8798 with an empty local database,
serves a small fixture shop (`e2e/shop/`) on port 5199, and drives both with
Playwright in your installed Chrome. The shop uses the stock `@sentry/browser`
SDK, pointed at a DSN on localhost. Each test creates its own project, breaks
the shop in some way, and checks what arrives:

| File | What it covers |
|---|---|
| `e2e/capture.spec.ts` | Uncaught errors, unhandled rejections, handled errors with user, tags and breadcrumbs, messages, error causes, non-Error throws, scrubbing |
| `e2e/grouping.spec.ts` | Grouping by parameterized message, custom fingerprints, environments and releases, project isolation |
| `e2e/rejection.spec.ts` | Unknown, revoked and wrong-project keys; CORS |
| `e2e/lifecycle.spec.ts` | Reading an issue in the UI, resolve and regression, archive, bulk resolve, delete, search, project settings, theme, unread, real-time updates, row clicks and range selection |

Set `E2E_BROWSER_CHANNEL` to use a browser other than Chrome (for example
`msedge`). The consumer batches for up to five seconds, so most tests take
about that long; they run in parallel.

## Layout

| Folder | Job | May import |
|---|---|---|
| `src/shared/` | Types, ids, time, JSON parsing, the UI contract | nothing internal |
| `src/core/` | Envelope parsing, normalizing, scrubbing, grouping, batch planning. Pure. | `shared` |
| `src/db/` | Every SQL statement | `shared` |
| `src/blobs/` | Every R2 read and write | `shared` |
| `src/ingest/` | `POST /api/:project/envelope/` and `/store/` | `shared`, `core`, `db` |
| `src/consumer/` | Queue consumer | `shared`, `core`, `db`, `blobs` |
| `src/api/` | Read API under `/api/0/` | `shared`, `db`, `blobs` |
| `src/cron/` | Daily retention | `shared`, `db`, `blobs` |
| `src/worker.ts` | Wires bindings to the handlers | everything |
| `ui/` | React SPA | `src/shared/contract.ts`, types only |
| `e2e/` | Playwright tests and the fixture shop | `src/shared/contract.ts`, types only |

The linter enforces the last column. To change it, change the table in
DESIGN.md §16.3 and `oxlint.config.ts` together.

## Deploy

The steps, in order. `wrangler.jsonc` holds placeholders so that nothing about
your account is committed; your real values go in `wrangler.production.jsonc`,
which is git-ignored, and `pnpm deploy` and `pnpm migrate:remote` read that file.

1. Create the resources:

   ```bash
   pnpm wrangler d1 create zentry
   ```

   ```bash
   pnpm wrangler r2 bucket create zentry-blobs
   ```

   ```bash
   pnpm wrangler queues create zentry-events
   ```

   ```bash
   pnpm wrangler queues create zentry-events-dlq
   ```

2. Copy `wrangler.jsonc` to `wrangler.production.jsonc` and set, in the copy,
   the D1 `database_id`, both hostnames under `routes`, and `INGEST_HOST`.
3. In Cloudflare Zero Trust, add an Access application for the UI hostname
   only. Put its team domain and audience tag in `ACCESS_TEAM_DOMAIN` and
   `ACCESS_AUD` in the same copy. Leave the ingest hostname without Access.
4. On the R2 bucket, add two lifecycle rules: delete `events/` after 90 days
   and `spill/` after 7 days.
5. Apply the schema and deploy:

   ```bash
   pnpm migrate:remote
   ```

   ```bash
   pnpm deploy
   ```

`DEV_USER_EMAIL` is honoured only for requests to `localhost`. Leave it
empty in `wrangler.jsonc`.

## Licences

The lint rules in `tools/oxlint/anti-slop/` are vendored from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) under the MIT
licence; see the `LICENSE` file in that folder.
