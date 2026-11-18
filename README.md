# Zentry

Error tracking that speaks the Sentry SDK protocol and runs on Cloudflare:
one Worker, D1, R2 and Queues. Errors and stack traces, grouped into issues,
in a Sentry-like UI, with email and push notifications and an Android app
([mobile/](mobile/README.md)). No tracing, performance or replays.

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
| `src/cron/` | Daily retention, spike thresholds, weekly reports | `shared`, `core`, `db`, `blobs` |
| `src/push/` | Every request to Expo's push service | `shared` |
| `src/notify/` | Notifications: queue consumer, mailer, pushes, unsubscribe page | `shared`, `core`, `db` |
| `src/worker.ts` | Wires bindings to the handlers | everything |
| `ui/` | React SPA | `src/shared/contract.ts`, types only |
| `e2e/` | Playwright tests and the fixture shop | `src/shared/contract.ts`, types only |
| `mobile/` | The Expo Android app ([mobile/README.md](mobile/README.md)) | `src/shared/contract.ts`, types only |

The linter enforces the last column. To change it, change the table in
DESIGN.md §16.3 and `oxlint.config.ts` together.

## Monitors

Under **Projects → Monitors**, choose a project and create a Metric, Cron, or
Uptime monitor. Owners can edit settings, pause execution and archive monitors.
A confirmed failure opens an issue. Select the notification option to route
failures through the project's existing notification preferences. A recovery
resolves the issue and can notify its workflow subscribers. Use **Preview**
to inspect a draft without changing the monitor's health.

- **Metric** counts processed error and fatal events in receive-time windows.
  Configure an environment, a breach threshold and an optional recovery
  threshold. Rollups start when the project creates its first metric monitor.
  Evaluations wait two minutes for ingestion. Heavy queue lag can delay coverage.
- **Cron** accepts Sentry SDK terminal check-ins and start/finish pairs. Create
  the monitor before sending a check-in and match its configured slug and
  environment. A valid first check-in arms missing-run detection. Crontab
  schedules use the configured IANA timezone. Intervals use elapsed time.
- **Uptime** sends GET or HEAD to operator-approved HTTPS origins from a
  separate Worker. Checks use a timeout, no redirects and HTTP 2xx for success.
  Failure and recovery streaks count scheduled observations.

Monitor history retains up to 14 days, with the latest 50 observations on the
detail page. The initial implementation uses Zentry's existing issue alert
configuration. Listed rollout milestones and follow-on monitor capabilities
are in the [monitoring plan](docs/sentry-monitoring-workers-plan.md).

### Deploy monitoring on Workers

1. Create the `zentry-uptime` and `zentry-uptime-dlq` Queues.
2. Prepare a private deployment configuration from `wrangler.probe.jsonc`.
   Set `UPTIME_ORIGINS` to a comma-separated list of exact HTTPS origins you
   operate and permit for probing. Keep `FIXTURE_ORIGIN` empty. Deploy this
   Worker first with `pnpm wrangler deploy -c <probe-config>`.
3. Update the main production config with the binding, queues, limiters,
   minute trigger and the same approved origins from `wrangler.jsonc`.
   Then follow the main migration and deployment steps below.

`pnpm dev` starts both Workers locally. Playwright starts an isolated
database, the application and probe Workers, and a local HTTP fixture server.
Run the monitor tests with `pnpm e2e monitors.spec.ts`.

## Deploy

The steps, in order. `wrangler.jsonc` holds placeholders so that nothing about
your account is committed; your real values go in `wrangler.production.jsonc`,
which is git-ignored, and `pnpm run deploy` and `pnpm migrate:remote` read that file.

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

   ```bash
   pnpm wrangler queues create zentry-notify
   ```

   ```bash
   pnpm wrangler queues create zentry-notify-dlq
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
   pnpm run deploy
   ```

   Use `pnpm run deploy`: plain `pnpm deploy` is a built-in pnpm command and fails.

6. Sign in, open Projects > Spend limits and set the monthly cap (see below),
   then add the account guards the Worker cannot set for itself, under
   "Spend protection".

`DEV_USER_EMAIL` is honoured only for requests to `localhost`. Leave it
empty in `wrangler.jsonc`.

## Email

Zentry emails issue alerts, workflow changes, quota and spike-protection
warnings and a weekly report, through Cloudflare Email Service (Workers Paid;
3,000 emails a month included). DESIGN.md §18 has the details. To turn it on:

1. In the dashboard, open Compute > Email Service > Email Sending and onboard
   the domain you will send from.
2. In `wrangler.production.jsonc`, set `EMAIL_FROM` (for example
   `Zentry <alerts@zentry.example.com>`) and `APP_URL` (the UI's origin).
3. Set the key that signs unsubscribe links:

   ```bash
   pnpm wrangler secret put EMAIL_SIGNING_KEY -c wrangler.production.jsonc
   ```

4. Deploy. Each user chooses what they get under Projects > Notifications.

Until `EMAIL_FROM` is set, nothing is sent. Locally, add `EMAIL_SIGNING_KEY`
and, to see emails, `EMAIL_FROM` to `.dev.vars`: `wrangler dev` simulates the
binding and writes each email to `.wrangler/tmp/email/`.

## Spend protection

A DSN is public, so anyone holding one can send events. These limits keep a
crash loop or an abuser from running up the bill. DESIGN.md §6 has the detail.

In the Worker, from broadest to narrowest:

| Limit | Default | Where it is set | 429 reason |
|---|---|---|---|
| Events per UTC month, all of an organization's projects | 1,000,000 | Spend limits page (owners) | `org_quota` |
| Spike protection, per project, recomputed hourly | on | project settings | `spike_protection` |
| Events per hour, per project | 10,000 | project settings | `project_quota` |
| Burst, per DSN key and Cloudflare location | 600 a minute | `ratelimits` in `wrangler.jsonc` | `key_quota` |
| Full events stored per issue per hour | 100 | `MAX_STORED_PER_GROUP_HOUR` | (counted, not stored) |

Every 429 carries `Retry-After` and `X-Sentry-Rate-Limits`, so the SDKs stop
sending until it passes. The monthly cap is the ceiling on the bill: at the
default, a whole month costs about $6 (DESIGN.md §12). When it is reached,
nothing is accepted until the next month starts; an owner can raise the cap
on the Spend limits page to resume sooner (it takes effect within a minute).

A new project is spike-protected from its first event: it starts at the
floor, derived from the monthly cap (4,167 events an hour for one project at
the default), and the hourly job adjusts it from there.

What the Worker cannot do is refuse a request without being invoked, and
every invocation is billed, refused or not. Set these on the account:

1. **Workers spending limit**, on the dashboard's Spend Management page
   ([docs](https://developers.cloudflare.com/workers/platform/spend-management/)). It blocks every Worker on the account once request and CPU
   charges pass the amount you set. It does not cover D1, R2 or Queues, which
   the limits above bound.
2. **Email alert** at a lower amount on the same page, so you hear about it
   before the limit stops ingest.
3. **A WAF rate limiting rule** on the ingest hostname
   ([docs](https://developers.cloudflare.com/waf/rate-limiting-rules/)), for example 100 requests per 10 seconds per IP, action
   Block. Requests it blocks never reach the Worker, so they are not billed as
   Worker requests. The Free plan allows one such rule. Set the rate above
   your busiest server's normal traffic: a fleet behind one NAT address shares
   one IP.

Workers Logs are sampled at 10% (`head_sampling_rate` in `wrangler.jsonc`),
because every logged invocation past 20 million a month is billed too. Raise
it while debugging.

## Mobile app

An Android app in `mobile/` shows issues and events, triages them, and gets
push notifications. Sign a phone in from Settings, Mobile app, with a QR code;
the app then calls the ingest host with its own device token, since Access
guards the UI host. Building it and setting up push are in
[mobile/README.md](mobile/README.md); the design is DESIGN.md §19.

For production, set `MOBILE_API_URL` in `wrangler.production.jsonc` to
`https://<your ingest host>`, and apply the migrations (`pnpm migrate:remote`).

## Licences

The lint rules in `tools/oxlint/anti-slop/` are vendored from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) under the MIT
licence; see the `LICENSE` file in that folder.
