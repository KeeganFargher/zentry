# Zentry: "Sentry Lite" on Cloudflare — design (rev 2)

Goal: errors and stack traces, grouped into issues, browsable in a Sentry-like
UI. No tracing, performance, profiling, replays, sessions, metrics or alerting.

**The one hard requirement is SDK compatibility.** Apps keep the official
`@sentry/*` / `sentry-sdk` packages and only change the DSN:

```
https://<public_key>@ingest.zentry.example.com/<project_id>
```

Cloudflare limits and prices quoted here were read from the Cloudflare docs on
2026-11-17. Sentry behaviour was read from `getsentry/sentry` and
`getsentry/relay` at HEAD on the same day.

**Status:** v1 is implemented in this repository and covered by tests. Where
the code differs from the text below, §17 lists the difference and the code
is right.

---

## 0. What rev 2 fixes

A review of rev 1 found these problems. Each is fixed in the section named.

| # | Problem in rev 1 | Fix |
|---|---|---|
| 1 | The consumer inserted the `events` row for dedupe *before* grouping. A failure after that insert made the retry look like a duplicate, so the event was lost and never counted. | Read first, then write everything in one transaction (§7). |
| 2 | The "recommended" single-statement group upsert never allocated `short_id`, and the alternative was not race-safe. | Short id allocated inside the transaction; unique constraints turn a race into rollback and retry (§7.4). |
| 3 | No rate limiting. A DSN is public, so a crash loop or an abuser could run up the bill. | Three layers: burst limit, hourly project quota, per-issue flood sampling (§6). |
| 4 | No data scrubbing. Relay strips passwords, tokens and card numbers by default; rev 1 silently dropped that. | Default scrubber in normalization (§7.2). |
| 5 | Two R2 writes per event (raw, then processed). | Event travels inside the queue message; one R2 write (§5.6). |
| 6 | Access was to protect "everything except the ingest paths" on one hostname. That is fragile, and `workers.dev` would bypass it. | Two hostnames, `workers_dev: false`, and the Worker verifies the Access JWT itself (§10). |
| 7 | The issue list offered an environment filter the schema could not answer. | `group_tag_values` carries `project_id` and an index for tag filters (§8). |
| 8 | One D1 statement per tag per event would hit the bound-parameter limit and write far more rows than needed. | Per-batch coalescing and `json_each` bulk statements (§7.5). |
| 9 | Browser JavaScript grouping would create a new issue on every deploy, because minified names and hashed filenames change. | Browser frames without source maps do not contribute to the hash (§7.3). |
| 10 | No cost numbers and no stated scale ceiling. | §12. |
| 11 | Tag tables could grow without bound on high-cardinality tags. | Caps and pruning (§7.2, §9). |
| 12 | Message events ignored the unformatted log template. | `logentry.message` preferred over `formatted` (§7.3). |

---

## 1. What real Sentry does

| Stage | Real Sentry | Source |
|---|---|---|
| Ingest | Relay (Rust) accepts `POST /api/{project_id}/envelope/` and legacy `/store/`, authenticates the DSN key, rate-limits, normalizes, scrubs, writes to Kafka | `relay-server/src/endpoints/mod.rs`, `envelope/mod.rs` |
| Save | `EventManager.save_error_events()`: release, user, tags, `assign_event_to_group`, environments, counters, nodestore, eventstream to Snuba | `event_manager.py:534` |
| Grouping | Build a tree of components (exception → stacktrace → frames), mark which contribute, md5 the contributing values | `grouping/strategies/newstyle.py`, `grouping/utils.py:20` |
| Group upsert | Look up `GroupHash(project, hash)`. Found: update aggregate and check for regression. Not found: create `Group` with the next `short_id` | `event_manager.py:1380`, `:1971`, `:1786` |
| Read side | Django API, React UI, search through Snuba | `static/app` |

Dropped: Kafka, Snuba/ClickHouse, Symbolicator, Redis, Postgres, Celery, Seer,
secondary grouping configs, stack-trace enhancer rules, dynamic sampling, and
every non-error pipeline.

---

## 2. Scope

**In v1:** error and message events; envelope and store endpoints; grouping;
issue status (unresolved, resolved, ignored, regressed); counts, first/last
seen, hourly stats, tags; projects and DSN keys; organizations (present in the
data model and API, hidden in the UI); rate limits; scrubbing; retention; UI.

**Later (§13):** JavaScript source maps, attachments, issue merge, inbound
filters. Email notifications were added after v1 (§18).

**Never:** transactions, spans, profiles, replays, sessions, cron monitors,
logs, metrics, native symbolication, teams, SSO, integrations.

---

## 3. Architecture

```
                 ingest.zentry.example.com            zentry.example.com
                 (public, no Access)                  (behind Cloudflare Access)
 SDKs ──HTTPS──▶ ┌──────────────────────────── one Worker ───────────────────────────┐ ◀── browser
                 │ fetch: ingest routes        │ fetch: /api/0/* JSON API + SPA assets│
                 │   auth, limits, parse       │   verifies Access JWT                │
                 │   └─ send ─▶ Queue          │   reads D1, reads R2                 │
                 │ queue: consumer (concurrency 1)                                    │
                 │   normalize → scrub → hash → R2 put → one D1 transaction           │
                 │ scheduled: retention, tag pruning; hourly spike thresholds         │
                 └────────────────────────────────────────────────────────────────────┘
                     │              │                   │                │
                  Queue          Queue (DLQ)           D1               R2
              zentry-events   zentry-events-dlq      zentry        zentry-blobs
```

| Concern | Product | Why |
|---|---|---|
| Ingest, API, consumer, cron | One Worker, four handlers | One deploy, shared code. Split later only if needed. |
| Buffer between ingest and processing | Queues | Retries and a DLQ, and batching, which is what makes D1 writes cheap (§7.5). |
| Full event JSON | R2 | Events are 2–100 KB each; D1 is capped at 10 GB per database. |
| Issues, event index, tags, stats | D1 | Relational queries for the issue list. |
| Burst limiting | Rate Limiting binding | In-Worker, no extra round trip. |
| Login | Cloudflare Access | No auth code to write. |

Not used: KV (project keys are cached in the isolate instead, §5.3), Durable
Objects (the single-consumer rule in §7 gives the same ordering guarantee
without them), Analytics Engine.

### Repository layout

```
zentry/
├─ wrangler.jsonc
├─ oxlint.config.ts  .oxfmtrc.json  tsconfig.json  lefthook.yml      # §16
├─ migrations/0001_init.sql … 0005_notifications.sql      # §8, §6, §18
├─ src/
│  ├─ worker.ts      # composition root: exports { fetch, queue, scheduled }
│  ├─ shared/        # no internal imports
│  │    types  ids  time  json  schema  contract  plan  log  notify
│  ├─ core/          # pure functions: no bindings, no I/O, no clock
│  │    wire  envelope  normalize  fields  context  exceptions  frames  inapp
│  │    logentry  useragent  trim  scrub  secrets  derive  tags  grouping
│  │    fingerprint  parameterize  md5  buckets  plan  spike
│  │    notify-settings  digest  unsubscribe  email-layout  email-messages
│  │    email-alert
│  ├─ db/            # the only place SQL lives
│  │    keys  batch  projects  issues  events  tenancy  organizations
│  │    usage  spike  retention  notify  notify-settings  mail  reports
│  ├─ blobs/         events  spill            # the only place R2 keys are built
│  ├─ ingest/        auth  body  handler  http  limits
│  ├─ consumer/      handler
│  ├─ api/           access  context  router  http  series  issues  events
│  │                 projects  organization  notifications
│  ├─ cron/          retention  spike  notify
│  └─ notify/        deps  handler  alerts  jobs  recipients  mailer  unsubscribe
├─ ui/               # Vite + React SPA, built to ui/dist
├─ tools/oxlint/     anti-slop/ (vendored)  zentry/ (our own rules), §16
├─ test/             core/ (pure)  integration/ (Workers runtime)  fixtures/envelopes/*.bin
└─ e2e/              Playwright: the stock browser SDK against a local Zentry
```

The allowed imports between these folders are fixed and lint-enforced; see §16.3.

### wrangler.jsonc

```jsonc
{
  "name": "zentry",
  "main": "src/worker.ts",
  "compatibility_date": "2026-11-01",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "ingest.zentry.example.com", "custom_domain": true },
    { "pattern": "zentry.example.com", "custom_domain": true }
  ],
  "assets": {
    "directory": "./ui/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "zentry", "database_id": "<id>", "migrations_dir": "migrations" }
  ],
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "zentry-blobs" }],
  "queues": {
    "producers": [{ "binding": "EVENTS_Q", "queue": "zentry-events" }],
    "consumers": [{
      "queue": "zentry-events",
      "max_batch_size": 100,
      "max_batch_timeout": 5,
      "max_concurrency": 1,
      "max_retries": 5,
      "dead_letter_queue": "zentry-events-dlq"
    }]
  },
  "ratelimits": [
    { "name": "INGEST_RL", "namespace_id": "1001", "simple": { "limit": 600, "period": 60 } }
  ],
  "triggers": { "crons": ["17 3 * * *", "3 * * * *"] },
  "observability": { "enabled": true, "head_sampling_rate": 0.1 },
  "vars": {
    "INGEST_HOST": "ingest.zentry.example.com",
    "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
    "ACCESS_AUD": "<application audience tag>",
    "RETENTION_DAYS": "90",
    "MAX_STORED_PER_GROUP_HOUR": "100"
  }
}
```

---

## 4. Conventions

- **Time:** integer milliseconds since the Unix epoch, UTC, everywhere.
- **event_id:** 32 lowercase hex characters. Dashes are stripped and case is
  lowered on ingest. If the SDK sent none, the ingest Worker generates one.
- **Project id:** integer, as it appears in the DSN path.
- **Public key:** 32 lowercase hex characters, generated with
  `crypto.getRandomValues`.
- **Issue short id:** `{PROJECT_SLUG_UPPER}-{short_id}`, for example `API-42`.
- **Hash:** md5 hex. Workers' `crypto.subtle.digest("MD5", …)` supports it.

---

## 5. Ingest

### 5.1 Routes (only on `INGEST_HOST`)

| Method | Path | Body |
|---|---|---|
| POST | `/api/:project_id/envelope/` | Envelope |
| POST | `/api/:project_id/store/` | One event as JSON |
| OPTIONS | both | CORS preflight |
| any | anything else | 404 |

A trailing slash is optional. Requests for `/api/0/*` on the ingest host get
404, so the read API is never reachable without Access.

### 5.2 CORS

Every response, including errors, carries:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: content-type, content-encoding, x-sentry-auth, sentry-trace, baggage, authentication
Access-Control-Expose-Headers: x-sentry-rate-limits, retry-after
Access-Control-Max-Age: 86400
```

Browser SDKs normally post `text/plain` with `?sentry_key=` so that no
preflight is needed, but the preflight must still work.

### 5.3 Authentication

The public key is taken from the first of these that is present:

1. `X-Sentry-Auth: Sentry sentry_key=<key>, sentry_version=7, sentry_client=…`
2. Query string `?sentry_key=<key>`
3. Envelope header `dsn` (the user part of the URL)

Lookup:

```sql
SELECT k.id AS key_id, k.project_id, p.organization_id,
       p.rate_limited_until, p.rate_limit_reason, o.max_events_per_month
FROM project_keys k
JOIN projects p ON p.id = k.project_id
JOIN organizations o ON o.id = p.organization_id
WHERE k.public_key = ?1 AND k.status = 'active';
```

The result is cached in a module-level `Map` for 60 seconds, including
negative results. A revoked key therefore keeps working for at most 60 seconds
per isolate, and a project's rate-limit flag takes the same time to be seen.

- Key missing or unknown: `401 {"detail":"invalid sentry key"}`.
- Key's project differs from `:project_id`: `401`.

### 5.4 Body handling

- `Content-Encoding`: `gzip` and `deflate` are decoded with
  `DecompressionStream`. Anything else, including `br`, is `415` (the Workers
  runtime has no Brotli decompression stream).
- Size caps, counted on the decompressed bytes while streaming so a
  compressed bomb is cut off. Over a cap is `413`. `/store/` bodies and the
  `event` item of an envelope are capped at 1,000,000 bytes (Relay's
  `max_event_size`). A whole envelope is capped at 10,000,000 bytes, so an
  event sent with a screenshot or other attachment is not refused for the
  attachment's size. Attachments themselves are dropped.

### 5.5 Envelope parsing

```
{"event_id":"…","dsn":"…","sent_at":"…"}\n          envelope header
{"type":"event","length":41}\n                      item header
<41 bytes>\n                                         payload
{"type":"attachment","length":7,"filename":"x"}\n
<7 bytes>\n
```

Rules, taken from `relay-server/src/envelope/mod.rs`:

- Work on bytes (`Uint8Array`). `length` is a byte count.
- `length` is optional. When absent, the payload ends at the next `\n` or at
  end of input.
- The final newline is optional. An empty line at the end is not an item.
- A header that is not valid JSON makes the whole request `400`.

Item handling:

| Item `type` | Action |
|---|---|
| `event` | Keep. At most one per envelope. |
| `attachment`, `user_report`, `feedback` | Drop in v1. |
| `transaction`, `span`, `session`, `sessions`, `client_report`, `profile`, `profile_chunk`, `replay_event`, `replay_recording`, `replay_video`, `check_in`, `statsd`, `metric_buckets`, `log`, `otel_log`, unknown | Drop. |

An event item whose JSON has `"type":"transaction"` is also dropped. An
envelope with nothing kept returns `200 {}`. A 4xx here would make some SDKs
log or retry.

For `/store/`, the body is the event JSON.

The ingest Worker parses the event JSON once, to confirm it is an object and
to read or assign `event_id`. All other processing happens in the consumer.

### 5.6 Hand-off to the queue

```ts
type QueueMessage = {
  v: 1;
  project_id: number;
  key_id: number;
  event_id: string;
  received_at: number;        // ms
  client_ip: string | null;   // CF-Connecting-IP
  user_agent: string | null;
  sent_at: string | null;     // envelope header, for clock-drift correction
  payload: string | null;     // event JSON, when it is at most 100,000 bytes
  spill_key: string | null;   // R2 key, when it is larger; exactly one is set
};
```

Queues caps a message at 128 KB. Events up to 100,000 bytes go inline, which
covers nearly all of them. Larger events are written to
`spill/{project_id}/{event_id}.json` in R2 and the message carries the key.

The Worker awaits `EVENTS_Q.send()` before responding. If the send throws
(the queue allows 5,000 messages per second), the response is `503` with
`Retry-After: 30`, and the SDK retries. The same holds for anything else that
throws while accepting a request, which can only be storage failing: the R2
spill write, or the D1 reads behind the key and usage caches. The error is
logged, and the 503 carries the CORS headers, which a bare runtime error page
would not.

### 5.7 Responses

| Case | Status | Body and headers |
|---|---|---|
| Accepted | 200 | `{"id":"<event_id>"}` |
| Nothing kept | 200 | `{}` |
| Bad key | 401 | `{"detail":"…"}` |
| Malformed | 400 | `{"detail":"…"}` |
| Too large | 413 | `{"detail":"…"}` |
| Rate limited | 429 | `Retry-After: <s>`, `X-Sentry-Rate-Limits: <s>::<scope>:<reason>` (§6) |
| Storage unavailable (queue, R2 spill, D1) | 503 | `Retry-After: 30` |

SDKs read `X-Sentry-Rate-Limits` and stop sending for that many seconds, which
is what makes rate limiting cheap.

---

## 6. Rate limiting, spike protection and flood control

A DSN is public, so a crash loop or an abuser can send any volume. Each layer
below bounds a different cost; together they put a ceiling on the bill. They
follow Sentry's quota model (`src/sentry/quotas/base.py`: quotas scoped to the
organization, project or key, each with a reason code) and its spike
protection (described in `docs/pricing/quotas/spike-protection.mdx` of
`getsentry/sentry-docs`; the algorithm itself is in the closed `getsentry`).

| # | Layer | Scope | Reason code | Set by | Bounds |
|---|---|---|---|---|---|
| 1 | Monthly cap | organization | `org_quota` | organization settings page | everything downstream, for the month |
| 2 | Spike protection | project | `spike_protection` | hourly cron | one project's sudden surge |
| 3 | Hourly quota | project | `project_quota` | project settings | one project's sustained volume |
| 4 | Burst limit | key, per location | `key_quota` | Rate Limiting binding | a runaway loop, within the minute |
| 5 | Flood sampling | issue | (stored, not refused) | `MAX_STORED_PER_GROUP_HOUR` | R2 writes and event rows |

Every refusal is a `429` with `Retry-After` and
`X-Sentry-Rate-Limits: <seconds>::<scope>:<reason>`, Relay's format
(`relay-server/src/utils/rate_limits.rs`). The categories field is empty,
which means all categories, so the SDK also pauses sessions and transactions;
Zentry drops those, but each still costs a Worker request. Layers 1 to 3 apply
to every envelope; layer 4 only to envelopes that carry an event.

1. **Monthly cap.** `organizations.max_events_per_month` (default 1,000,000,
   always set, CHECK > 0), changed by owners on the organization's
   "Spend limits" page (`GET, PUT /api/0/organizations/{org}/limits/`). The
   consumer adds each batch's new events to `usage_months` (one row per
   organization per UTC month) in the same transaction as the rest. Ingest
   reads the cap with the DSN key and the count through a per-isolate cache,
   both refreshed every minute, and refuses the organization's events once the
   count reaches the cap, until the month ends. Overshoot is what arrives
   within a minute plus queue delay, which layer 4 bounds. Owners only, as in
   Sentry, where quotas belong to the owner and billing roles: raising the
   cap is a decision about the bill.
2. **Spike protection.** On by default per project, off for projects that are
   bursty by design. A cron at minute 3 of every hour sets
   `projects.spike_limit_per_hour` for each protected project
   (`core/spike.ts`):
   - floor = max(500, ⌈3 × monthly cap / (720 × min(projects, 5))⌉), counting
     the organization's projects,
     Sentry's floor: the hourly rate that would use three months of quota in
     one; 500 is a tenth of Sentry's smallest error plan;
   - projection = the higher of the mean of the last 168 complete hours and
     the mean of the same hour of day over those 7 days (a stand-in for
     Sentry's seasonality weighting);
   - multiplier = 5 × the coefficient of variation of those hours, bounded to
     3..6 (Sentry: "5 times the standard deviation", bounded to 3..6);
   - threshold = max(floor, ⌈projection × multiplier⌉).

   The consumer treats the threshold like an hourly quota. Only accepted
   events count toward the history, since refused ones never reach the
   consumer; Sentry gives dropped events a decaying weight instead, so here a
   long spike raises the threshold more slowly.

   Every project has a threshold from the moment it exists: creating a project
   sets it to the floor, which is what the cron computes for a project with no
   history. A new project's first surge is therefore caught at once, and its
   normal traffic is not mistaken for one, since the floor is set from the
   monthly cap rather than from history (4,167 an hour for one project at the
   default cap). The migration gives existing projects an upper bound of what
   the cron can compute (the floor or 6 × their busiest hour of the last week),
   so the first deploy refuses nothing new; the first hourly run tightens it.
   A change to the monthly cap or the number of projects moves floors at the
   next hourly run.
3. **Hourly project quota.** The consumer keeps `project_stats.received` per
   hour. When a project passes `projects.max_events_per_hour` (default 10,000;
   NULL means unlimited) or its spike threshold, the consumer sets
   `rate_limited_until` to the start of the next hour and `rate_limit_reason`
   to the lower of the two limits passed. A CHECK keeps the two columns set
   and cleared together. Ingest sees the flag through its 60-second key cache.
   Changing the quota or the spike setting lifts the current limit.
4. **Burst limit, in the ingest Worker.** `INGEST_RL.limit({ key: publicKey })`
   at 600 per 60 seconds. This counter is per Cloudflare location and
   approximate, so it is a guard against a runaway loop and not an exact
   quota. Over the limit: `429`, `Retry-After: 60`.
5. **Per-issue flood sampling, in the consumer.** Each issue stores at most
   `MAX_STORED_PER_GROUP_HOUR` (100) full events per hour. Events beyond that
   still add to `times_seen`, hourly stats and tag counts, but get no `events`
   row and no R2 object. One issue firing a million times costs 100 stored
   events an hour instead of a million.

**What the Worker cannot bound.** Every request that reaches the Worker is
billed, including the ones it refuses, and so is each logged invocation past
20 million a month. Three account settings cover that, listed in `README.md`
under "Spend protection": the Workers spending limit (requests and CPU; not
D1, R2 or Queues), an email alert below it, and a WAF rate limiting rule on
the ingest hostname, whose blocked requests never invoke the Worker. Workers
Logs are sampled at 10% (`head_sampling_rate`) for the same reason.

Refused events are not counted anywhere: counting them would cost a D1 write
per refusal, which is the cost being avoided.

---

## 7. Consumer

### 7.1 Correctness model

- **One consumer at a time** (`max_concurrency: 1`). Batches are processed in
  sequence, so the reads in step B are still true when step D writes.
  Throughput at 100 events per batch and under a second per batch is well
  above the scale in §12.
- **One transaction per batch.** `DB.batch([...])` runs as a single SQLite
  transaction. Either every write for the batch lands or none does.
- **Constraints as the backstop.** If two writers ever did race, a unique
  constraint fails, the transaction rolls back, and the batch is retried. The
  retry's read step then sees the other writer's rows.
- **R2 before D1.** The event object is written first. A failure after that
  leaves an orphan object that the retry overwrites or the lifecycle rule
  deletes. The reverse order could leave an `events` row with no object.
- **Ack only after commit.**

Known inexactness: flood-sampled events have no `events` row, so a redelivered
or re-sent sampled event is counted twice. That is accepted.

### 7.2 Step A: normalize and scrub (CPU only, per message)

Load the payload (inline or from `spill_key`) and parse it with the
`WireEvent` schema (`core/wire.ts`). That one parse is where every field's
wire shape is checked: a field of the wrong type is dropped and the rest of
the event kept, as Relay does, and only a payload that is not a JSON object is
refused. Normalization then works on the typed result and applies:

| Field | Rule |
|---|---|
| `event_id` | From the message. |
| `timestamp` | ISO 8601 or epoch seconds (float). If `sent_at` is present, shift by `received_at − sent_at` when that drift exceeds 5 minutes. Then clamp: more than 1 minute in the future or more than 30 days old becomes `received_at`. |
| `level` | One of `fatal`, `error`, `warning`, `info`, `debug`. Aliases: `critical` is `fatal`, `warn` is `warning`, `log` is `info`. Python logging numbers map by band (50, 40, 30, 20, below). Default `error`. |
| `platform` | Default `other`. |
| `exception` | Accept `{values:[…]}` and the legacy bare array. Keep at most 20 exceptions. |
| `stacktrace.frames` | Keep at most 250 frames: the first 125 and the last 125. Source context keeps the 10 `pre_context` lines nearest the error (the last ones) and the 10 `post_context` lines nearest it (the first ones). |
| `threads`, top-level `stacktrace` | Used only when no exception has frames. The stack of the crashed thread (else the current one, else the first with frames) goes on the last exception, or on a bare exception with no type or value when the event has none. |
| `frame.in_app` | One override first: when the stack trace names the `package` (assembly or binary) of its frames and a frame has none, that frame is runtime-generated code (a reflection stub, a dynamic method) and is not in-app, whatever the SDK said. The .NET SDK marks such frames in-app because their module is `"(unknown)"`, and they appear only once the runtime warms up, so counting them split one crash into two issues. Then: if the SDK set it, keep it. Otherwise `false` for platform and framework code (`core/inapp.ts`): library paths (`node_modules/`, `site-packages/`, `/usr/lib/`, `/System/Library/`, …), module prefixes (`java.`, `android.`, `org.springframework.`, `System.`, `Microsoft.`, …) and Go runtime functions; `true` otherwise. |
| `frame.vars` | Depth 3, 50 keys, strings cut at 512 characters. |
| `breadcrumbs` | Accept `{values:[…]}` and a bare array. Keep the last 100. |
| `logentry` / `message` | Normalize to `logentry: {message, formatted, params}`. With `params` and no `formatted`, fill `%s`, `%d`, `%(name)s`, `{}`, `{0}` and `{name}` placeholders; the title uses the filled text and grouping uses the template. |
| `user.ip_address` | `{{auto}}`, or absent on platform `javascript`, becomes `client_ip`, unless the SDK set `sdk.settings.infer_ip` to `never`, in which case no address is stored. An address the SDK sent is kept. |
| `request.headers` | Normalize to a list of pairs. Add `User-Agent` from the message if absent. |
| `contexts.browser`, `contexts.os` | If absent and a User-Agent exists, fill name and version from a small UA parser. |
| `tags` | Accept an object or a list of pairs. Keys cut at 32 characters, values at 200. |
| `extra`, `contexts` | Depth 5, strings cut at 8,192 characters. |
| Any string | Cut at 8,192 characters, except `context_line` and source context at 512. |

**Derived fields:**

- `title`: for an exception event, `"{type}: {value}"` of the last exception
  in the list, cut at 200 characters. For a message event, the first line of
  `logentry.formatted`. Otherwise `<unlabeled event>`. The title is for
  display only: a line that is mostly unprintable (control characters, lone
  surrogates, U+FFFD) becomes `<binary data>`, as when an app reads gzip
  bytes as a string, and otherwise each run of unprintable characters becomes
  one U+FFFD. The stored event and grouping keep the value as sent.
- `culprit`: `"{module or filename} in {function}"` of the last in-app frame,
  falling back to the last frame. A frame with a function but no module or
  filename gives the function alone (the .NET SDK clears `module`, and a
  build without symbols has no files). Without a frame, `transaction`, then
  empty.
- `metadata`: `{type, value, filename, function}` from the same exception and
  frame. Stored on the group so the list can render type and value separately.
- `user_label`: first present of `user.email`, `user.username`, `user.id`,
  `user.ip_address`.

**Indexed tags.** Built from, in order: `level`, `environment` (default
`production`), `release`, `server_name`, `transaction`, `browser`
(`"{name} {major}"`), `browser.name`, `os`, `os.name`, `runtime`, `device`,
`url` (from `request.url`, without query string), `user` (`"id:…"`,
`"email:…"`, `"username:…"` or `"ip:…"`), `handled` and `mechanism` from the last exception,
then the event's own `tags`. At most 50 tags per event are indexed.

**Scrubbing.** Applied to `request` (URL, data, cookies, headers, query string),
`extra`, `contexts`, `user`, `frame.vars`, `breadcrumbs[].data`, and `tags`,
and by shape only to the message (template and formatted text), exception
values and breadcrumb messages:

- Any value under a key matching, case-insensitively,
  `password|passwd|secret|api[_-]?key|access[_-]?key|auth|credentials|mysql_pwd|private[_-]?key|token|session|cookie|csrf|bearer`
  becomes `"[Filtered]"`. `request.cookies` is replaced whole.
- Inside any string, by shape (`core/secrets.ts`): card numbers (13–19
  digits, Luhn-checked), IBANs (mod-97), PEM private keys, the user and
  password in a URL (`scheme://[Filtered]:[Filtered]@host`), and bearer tokens
  become `"[Filtered]"`.

This is a reduced form of Relay's default rules, applied before anything is
stored.

A message that fails to parse or normalize is acked and logged with its
project and event id. Retrying would not help.

### 7.3 Grouping

Output: one md5 hex hash per event, plus the config id `lite:2026-11-18`,
which is stored with the hash so a later algorithm change can be handled
deliberately.

1. **Client fingerprint.** If `event.fingerprint` is a non-empty array and is
   not exactly `["{{ default }}"]`, the hash is md5 of its entries, with any
   `{{ default }}` entry replaced by the hash from the steps below.
2. **Exceptions.** For each exception in `exception.values`, in order, collect:
   - `type`, unless `mechanism.synthetic` is true.
   - The stack trace's contributing frames (rules below).
   - `value`, parameterized, **only if** that exception has no contributing
     frames.

   The hash is md5 of everything collected. If nothing was collected, go to
   step 3.

   **Exception groups** (`AggregateException`, `AggregateError`, Python
   `ExceptionGroup`, or `mechanism.is_exception_group`): the wrappers hash
   first, then each distinct child once in a fixed order, so the number and
   order of failed children do not split the issue.
3. **Message.** `logentry.message` (the unformatted template) if present,
   otherwise `logentry.formatted`, parameterized.
4. **Fallback.** md5 of the empty string. All such events share one issue.

**Frame rules** (`newstyle.py:304`, `:482`):

- Use only in-app frames. If no frame is in-app, use all frames.
- A frame that repeats the previous frame (same module, filename, function,
  line) is skipped.
- Per frame, collect `module` if present, otherwise the lower-cased basename
  of `filename`; then `function`; then the trimmed `context_line` when the
  platform is `javascript`, `node`, `python`, `php` or `ruby` and the line is
  at most 120 characters.
- `filename` does not contribute when `abs_path` is an `http(s)` URL, or the
  name is `<anonymous>` or `[native code]`.
- `function` does not contribute when it is empty, `?`, `<anonymous>`,
  `<anonymous function>`, `Anonymous function`, or ends in `/<`. For
  JavaScript, `Object.foo` is reduced to `foo`. Ruby `block …` becomes
  `block`. Java functions starting `lambda$` do not contribute.
- Class and function names have generated suffixes removed first: CGLIB and
  Spring proxies (`$$EnhancerBySpringCGLIB$$ab12`), Hibernate proxies,
  `$$Lambda…` and `$ProxyN`.
- A JavaScript frame whose function is `eval`, or whose `abs_path` is
  `[native code]`, `native code`, `eval code` or `<anonymous>`, is skipped.

**Browser rule (differs from Sentry).** A frame on platform `javascript`
whose `abs_path` is an `http(s)` URL and which carries no source-map data does
not contribute at all. Sentry can use such frames because it applies source
maps first. Without them, minified names and hashed bundle filenames change on
every deploy and would open a new issue each time. The effect is that browser
errors group by exception type and parameterized message until source maps
exist (§13), which is coarser but stable.

**Parameterization** (reduced from `grouping/parameterization.py`). Applied in
this order, each match replaced by its placeholder:

| Placeholder | Matches |
|---|---|
| `<email>` | email addresses |
| `<url>` | `http(s)://…` up to whitespace or quote |
| `<uuid>` | 8-4-4-4-12 hex |
| `<sha1>`, `<md5>` | 40 or 32 hex characters as a word |
| `<date>` | ISO 8601 dates and datetimes |
| `<time>` | `14:05`, `14:05:09.5`, `2:30 PM` |
| `<host>` | lower-case host names ending in `com`, `net`, `org`, `dev`, `app`, `local`, `internal`, `lan`, `svc`, or (with two dots) a country or other short suffix such as `io`, `co.za` |
| `<ip>` | IPv4, IPv6 |
| `<duration>` | `123ms`, `1.5s` |
| `<hex>` | `0x…`, or 8 or more hex characters containing a digit, also after `_` or `-` (`req_8f3a9c01`) |
| `<float>`, `<int>` | numbers as whole words, and digits after `_` (`job_123`) |
| `<quoted>` | not applied; quoted strings are kept |

The result is trimmed to its first line.

### 7.4 Steps B to E: read, plan, store, commit

**B. Read** (one `DB.batch` of SELECTs; each takes one JSON array parameter):

```sql
-- B1: which of these events already exist?
SELECT e.project_id, e.event_id
FROM json_each(?1) j
JOIN events e ON e.project_id = j.value->>'p' AND e.event_id = j.value->>'e';

-- B2: which hashes already map to an issue, and what state is it in?
SELECT gh.project_id, gh.hash, g.id AS group_id, g.status, g.resolved_at
FROM json_each(?1) j
JOIN grouphashes gh ON gh.project_id = j.value->>'p' AND gh.hash = j.value->>'h'
JOIN groups g ON g.id = gh.group_id;

-- B3: how many events has each of those issues stored this hour?
SELECT s.group_id, s.stored
FROM json_each(?1) j
JOIN group_stats s ON s.group_id = j.value->>'g' AND s.bucket = j.value->>'b';

-- B4: project quota state
SELECT p.id, p.max_events_per_hour, COALESCE(ps.received, 0) AS received
FROM json_each(?1) j
JOIN projects p ON p.id = j.value
LEFT JOIN project_stats ps ON ps.project_id = p.id AND ps.bucket = ?2;
```

B3 runs after B2, since it needs group ids.

**C. Plan** (in memory):

1. Drop events found in B1, and later duplicates of an `event_id` within the
   batch.
2. Bucket the rest by `(project_id, hash)`. Buckets whose hashes B2 mapped to
   the same `group_id` are merged, so each issue is updated once.
3. Buckets with no row in B2 are **new issues**.
4. For each bucket, in timestamp order, mark events as *stored* until the
   issue's hourly allowance (B3 plus this batch) is used up; mark the rest
   *sampled*.
5. Per bucket compute: `n`, `first_ts`, `last_ts`, `last_received`, and the
   title, culprit, level, metadata and event id of the newest event.
6. Sum stats per `(bucket hour)` and tag counts per `(key, value)`.
7. Projects whose `received` now exceeds their quota get a
   `rate_limited_until`.

**D. Store blobs.** For each *stored* event, gzip the normalized JSON and put
it at `events/{project_id}/{event_id}.json.gz`. Puts run 10 at a time.

**E. Commit** (one `DB.batch`, in this order):

```sql
-- E1, once per new issue. Three statements each.
INSERT INTO groups
  (project_id, short_id, primary_hash, title, culprit, level, platform, metadata,
   status, substatus, times_seen, first_seen, last_seen, last_event_id, first_release, created_at)
SELECT ?1, p.next_short_id + 1, ?2, ?3, ?4, ?5, ?6, ?7,
       'unresolved', NULL, 0, ?8, ?8, ?9, ?10, ?11
FROM projects p WHERE p.id = ?1;

UPDATE projects
SET next_short_id = next_short_id + 1,
    first_event_at = COALESCE(first_event_at, ?2)
WHERE id = ?1;

INSERT INTO grouphashes (project_id, hash, group_id, grouping_config, created_at)
SELECT ?1, ?2, g.id, ?3, ?4 FROM groups g WHERE g.project_id = ?1 AND g.primary_hash = ?2;

-- E2: activity rows for issues about to regress. Must run before E3.
INSERT INTO activity (group_id, project_id, type, user_id, data, created_at)
SELECT g.id, g.project_id, 'regressed', NULL, json_object('event_id', j.value->>'eid'), ?2
FROM json_each(?1) j
JOIN grouphashes gh ON gh.project_id = j.value->>'p' AND gh.hash = j.value->>'h'
JOIN groups g ON g.id = gh.group_id
WHERE g.status = 'resolved' AND j.value->>'last_received' > COALESCE(g.resolved_at, 0);

-- E3: issue aggregates, all issues in one statement.
UPDATE groups SET
  times_seen    = times_seen + j.n,
  first_seen    = min(first_seen, j.first_ts),
  last_seen     = max(last_seen, j.last_ts),
  last_event_id = CASE WHEN j.last_ts >= last_seen AND j.eid IS NOT NULL THEN j.eid ELSE last_event_id END,
  title         = CASE WHEN j.last_ts >= last_seen AND j.title NOT LIKE '<%' THEN j.title ELSE title END,
  culprit       = CASE WHEN j.last_ts >= last_seen THEN j.culprit ELSE culprit END,
  level         = CASE WHEN j.last_ts >= last_seen THEN j.level ELSE level END,
  metadata      = CASE WHEN j.last_ts >= last_seen THEN j.metadata ELSE metadata END,
  substatus     = CASE WHEN status = 'resolved' AND j.last_received > COALESCE(resolved_at, 0)
                       THEN 'regressed' ELSE substatus END,
  status        = CASE WHEN status = 'resolved' AND j.last_received > COALESCE(resolved_at, 0)
                       THEN 'unresolved' ELSE status END
FROM (
  SELECT gh.group_id AS gid,
         value->>'n' AS n, value->>'first_ts' AS first_ts, value->>'last_ts' AS last_ts,
         value->>'last_received' AS last_received, value->>'eid' AS eid,
         value->>'title' AS title, value->>'culprit' AS culprit,
         value->>'level' AS level, value->>'metadata' AS metadata
  FROM json_each(?1)
  JOIN grouphashes gh ON gh.project_id = value->>'p' AND gh.hash = value->>'h'
) AS j
WHERE groups.id = j.gid;

-- E4: event index rows (stored events only).
INSERT INTO events
  (project_id, event_id, group_id, ts, received_at, level, platform,
   release, environment, user_label, title, size_bytes)
SELECT value->>'p', value->>'e', gh.group_id, value->>'ts', value->>'rx', value->>'level',
       value->>'platform', value->>'release', value->>'env', value->>'user', value->>'title', value->>'size'
FROM json_each(?1)
JOIN grouphashes gh ON gh.project_id = value->>'p' AND gh.hash = value->>'h';

-- E5: hourly issue stats.
INSERT INTO group_stats (group_id, bucket, project_id, count, stored)
SELECT gh.group_id, value->>'b', value->>'p', value->>'n', value->>'stored'
FROM json_each(?1)
JOIN grouphashes gh ON gh.project_id = value->>'p' AND gh.hash = value->>'h'
WHERE true
ON CONFLICT(group_id, bucket) DO UPDATE SET
  count = count + excluded.count, stored = stored + excluded.stored;

-- E6: tag counts.
INSERT INTO group_tag_values (group_id, key, value, project_id, times_seen, first_seen, last_seen)
SELECT gh.group_id, j.value->>'k', j.value->>'v', j.value->>'p', j.value->>'n', j.value->>'ts', j.value->>'ts'
FROM json_each(?1) j
JOIN grouphashes gh ON gh.project_id = j.value->>'p' AND gh.hash = j.value->>'h'
WHERE true
ON CONFLICT(group_id, key, value) DO UPDATE SET
  times_seen = times_seen + excluded.times_seen,
  last_seen  = max(last_seen, excluded.last_seen);

-- E7: hourly project stats.
INSERT INTO project_stats (project_id, bucket, received, stored)
SELECT value->>'p', value->>'b', value->>'n', value->>'stored' FROM json_each(?1)
WHERE true
ON CONFLICT(project_id, bucket) DO UPDATE SET
  received = received + excluded.received, stored = stored + excluded.stored;

-- E8, once per project that passed its quota.
UPDATE projects SET rate_limited_until = ?2 WHERE id = ?1;
```

Notes on the SQL:

- `WHERE true` before `ON CONFLICT` is required by SQLite when the insert
  source is a `SELECT`.
- In an `UPDATE`, every right-hand side sees the row's values from before the
  update, which E3 relies on.
- A group is created with `times_seen = 0` and E3 adds the count, so new and
  existing issues share one path.
- E4 is a plain `INSERT`. A duplicate key aborts the transaction, which is the
  backstop described in §7.1.
- Issues with `status = 'ignored'` keep that status and still count.

**After commit:** ack every message, then delete any `spill/` objects used.
The delete comes after the ack so that its failure cannot send committed
events back to the queue (sampled events would be counted twice). A failed
delete throws and is logged; the 7-day lifecycle rule on `spill/` removes
what it left.

### 7.5 Limits this design stays inside

| Limit (Cloudflare docs) | Value | How the design relates |
|---|---|---|
| D1 bound parameters per query | 100 | Bulk statements take one JSON parameter. |
| D1 string or row size | 2 MB | A batch's JSON parameter is tens of KB. |
| D1 SQL statement length | 100 KB | Statements are static. |
| D1 queries per invocation | 1,000; a `batch()` counts as one | Three batches per queue batch. |
| D1 database size | 10 GB | See §12. |
| Queue message size | 128 KB | Inline payload capped at 100,000 bytes. |
| Queue consumer batch | 100 messages | `max_batch_size: 100`. |
| Queue consumer duration | 15 min wall, 30 s CPU by default | A batch takes about a second. |
| Queue retention | up to 14 days | Set to 4 days. |

### 7.6 Failure handling

| Failure | Result |
|---|---|
| Event cannot be parsed | Ack and log. |
| R2 put fails | Throw. The whole batch is retried. |
| D1 batch fails | Throw. The whole batch is retried. |
| Same batch fails twice | On the third attempt (`msg.attempts >= 3`), process messages one at a time so a single bad message is isolated. |
| Spill delete fails after the ack | Throw and log. The messages stay acked; R2's lifecycle rule removes the objects. |
| Spilled payload is gone | Ack and log; nothing can be stored. |
| Message still fails after `max_retries` (5) retries | Goes to `zentry-events-dlq`. Nothing consumes it automatically; a script can replay it. |

---

## 8. D1 schema

`migrations/0001_init.sql`. D1 enforces foreign keys. Tables with a composite
primary key are `WITHOUT ROWID`, so the key is the table and no second index
is written.

```sql
-- ── Tenancy ────────────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id          INTEGER PRIMARY KEY,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE users (                       -- created on first request from the Access JWT
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,   -- lower-cased
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE organization_members (
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
) WITHOUT ROWID;
CREATE INDEX organization_members_user ON organization_members(user_id);

CREATE TABLE projects (
  id                   INTEGER PRIMARY KEY,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id),
  slug                 TEXT    NOT NULL,           -- 'api', 'web'; upper-cased for short ids
  name                 TEXT    NOT NULL,
  platform             TEXT,
  next_short_id        INTEGER NOT NULL DEFAULT 0,
  max_events_per_hour  INTEGER DEFAULT 10000,      -- NULL = unlimited
  rate_limited_until   INTEGER,                    -- ms; ingest returns 429 until then
  first_event_at       INTEGER,
  created_at           INTEGER NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE TABLE project_keys (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_key  TEXT    NOT NULL UNIQUE,             -- 32 hex
  label       TEXT    NOT NULL DEFAULT 'Default',
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX project_keys_project ON project_keys(project_id);

-- ── Issues ─────────────────────────────────────────────────────────────────
CREATE TABLE groups (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_id       INTEGER NOT NULL,
  primary_hash   TEXT    NOT NULL,                 -- the hash that created the issue
  title          TEXT    NOT NULL,
  culprit        TEXT    NOT NULL DEFAULT '',
  level          TEXT    NOT NULL DEFAULT 'error',
  platform       TEXT,
  metadata       TEXT    NOT NULL DEFAULT '{}',    -- JSON {type,value,filename,function}
  status         TEXT    NOT NULL DEFAULT 'unresolved'
                 CHECK (status IN ('unresolved','resolved','ignored')),
  substatus      TEXT    CHECK (substatus IN ('regressed')),
  times_seen     INTEGER NOT NULL DEFAULT 0,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  resolved_at    INTEGER,
  resolved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_event_id  TEXT,
  first_release  TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (project_id, primary_hash),
  UNIQUE (project_id, short_id)
);
-- Issue list, default sort.
CREATE INDEX groups_by_last_seen  ON groups(project_id, status, last_seen DESC, id DESC);
-- Issue list sorted by age. first_seen almost never changes, so this is cheap to maintain.
CREATE INDEX groups_by_first_seen ON groups(project_id, status, first_seen DESC, id DESC);
-- No index on times_seen: it changes on every event. That sort reads the
-- project's rows for one status and sorts them.

CREATE TABLE grouphashes (                 -- many hashes can point at one issue (merge)
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hash             TEXT    NOT NULL,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  grouping_config  TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, hash)
) WITHOUT ROWID;
CREATE INDEX grouphashes_group ON grouphashes(group_id);

CREATE TABLE activity (                    -- resolved / unresolved / ignored / regressed / merged
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- NULL = system
  data        TEXT    NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX activity_by_group ON activity(group_id, created_at DESC);

-- ── Events (index only; the full JSON is in R2) ────────────────────────────
CREATE TABLE events (
  project_id   INTEGER NOT NULL,
  event_id     TEXT    NOT NULL,
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,           -- event time
  received_at  INTEGER NOT NULL,
  level        TEXT,
  platform     TEXT,
  release      TEXT,
  environment  TEXT,
  user_label   TEXT,
  title        TEXT,
  size_bytes   INTEGER,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
-- Latest / oldest / previous / next within an issue, and the issue's event list.
CREATE INDEX events_by_group    ON events(group_id, ts DESC, event_id);
-- Retention deletes oldest first.
CREATE INDEX events_by_received ON events(received_at);

-- ── Aggregates ─────────────────────────────────────────────────────────────
CREATE TABLE group_stats (                 -- hourly; drives sparklines and flood sampling
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  bucket      INTEGER NOT NULL,            -- ms at the start of the hour
  project_id  INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,  -- all events
  stored      INTEGER NOT NULL DEFAULT 0,  -- events kept in full
  PRIMARY KEY (group_id, bucket)
) WITHOUT ROWID;

CREATE TABLE project_stats (               -- hourly; drives the quota and the project chart
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket      INTEGER NOT NULL,
  received    INTEGER NOT NULL DEFAULT 0,
  stored      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, bucket)
) WITHOUT ROWID;

CREATE TABLE group_tag_values (
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  project_id  INTEGER NOT NULL,
  times_seen  INTEGER NOT NULL DEFAULT 0,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (group_id, key, value)
) WITHOUT ROWID;
-- "Issues where environment = production" and other tag filters.
-- Its columns never change after insert, so counter updates do not rewrite it.
CREATE INDEX group_tag_values_filter ON group_tag_values(project_id, key, value, group_id);

-- ── Seed ───────────────────────────────────────────────────────────────────
INSERT INTO organizations (id, slug, name, created_at)
VALUES (1, 'default', 'Default', unixepoch() * 1000);
```

### Which query uses which index

| Query | Index |
|---|---|
| Ingest key lookup | `project_keys.public_key` (unique) |
| Hash → issue | `grouphashes` primary key |
| Issue list by last seen | `groups_by_last_seen` |
| Issue list by first seen | `groups_by_first_seen` |
| Issue by short id (`API-42`) | `groups (project_id, short_id)` (unique) |
| Issue list filtered by a tag | `projects` by org, `group_tag_values_filter`, then `groups` by id; the matches are sorted in memory |
| Events of an issue; latest, oldest, next, previous | `events_by_group` |
| Event by id | `events` primary key |
| Dedupe | `events` primary key |
| Tag sidebar | `group_tag_values` primary key |
| Sparkline | `group_stats` primary key |
| Activity feed | `activity_by_group` |
| Retention | `events_by_received` |

### R2 layout (bucket `zentry-blobs`)

| Prefix | Content | Lifecycle rule |
|---|---|---|
| `events/{project_id}/{event_id}.json.gz` | Normalized, scrubbed event | Delete after `RETENTION_DAYS` |
| `spill/{project_id}/{event_id}.json` | Raw oversize payload awaiting the consumer | Delete after 7 days |

---

## 9. Retention (cron, 03:17 UTC daily)

Each step loops in chunks of 5,000 rows until it has nothing left. All steps
share one 20-second budget, in the order below; a step the budget does not
reach waits for the next run.

1. `DELETE FROM events WHERE (project_id, event_id) IN (SELECT project_id, event_id FROM events WHERE received_at < ?cutoff ORDER BY received_at LIMIT 5000)`
2. Issues are not deleted, as in Sentry: only their events expire. An issue
   with no events left stays in the list and opens without an event; if it
   recurs, it is a regression, not a new issue.
3. `DELETE FROM group_stats WHERE (group_id, bucket) IN (SELECT group_id, bucket FROM group_stats WHERE bucket < ?now − 30 days LIMIT 5000)`,
   and the same for `project_stats` at 90 days. Both tables are keyed by
   owner first, so each chunk scans the table. An index on `bucket` would
   avoid the scan but add a write to every event, for a once-a-day job.
4. Tag pruning: for any `(group_id, key)` with more than 200 values, delete
   all but the 200 with the highest `times_seen`. This bounds `user`, `url`
   and similar tags. Counts for such tags are therefore approximate.
5. `UPDATE projects SET rate_limited_until = NULL, rate_limit_reason = NULL WHERE rate_limited_until < ?now`.

R2 objects are removed by the lifecycle rules, not by the cron. Deleting an
issue by hand from the UI also deletes its R2 objects, 1,000 keys per call.

---

## 10. Read API and authentication

### Authentication

- `zentry.example.com` is one Cloudflare Access application covering the
  whole hostname. `ingest.zentry.example.com` has no Access application.
- `workers_dev` and preview URLs are off, so there is no unprotected route.
- The Worker verifies the `Cf-Access-Jwt-Assertion` header on every `/api/0/*`
  request: signature against
  `https://{ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (keys cached for an
  hour), `aud` equal to `ACCESS_AUD`, and `exp`. Failure is `401`.
- The JWT's `email` is upserted into `users` and, on first sight, added to
  organization 1 as `member` (the first user ever becomes `owner`).
- Every query is scoped: the org slug in the path is resolved to an id, the
  caller must be a member, and any project or issue id is checked to belong
  to that org.

### Endpoints

Paths follow Sentry's public API so that the org is in every URL from the
start. Response shapes are our own, using Sentry's field names where that
costs nothing. This is not a compatibility promise.

| Method and path | Purpose |
|---|---|
| `GET /api/0/me/` | Current user and their organizations |
| `GET /api/0/organizations/{org}/projects/` | Projects with 24-hour counts |
| `POST /api/0/organizations/{org}/projects/` | Create a project and its first key |
| `GET, PUT, DELETE /api/0/projects/{org}/{project}/` | Read, rename, set quota, delete |
| `GET, POST /api/0/projects/{org}/{project}/keys/` | List keys with DSNs; create |
| `PUT /api/0/projects/{org}/{project}/keys/{key_id}/` | Revoke or relabel |
| `GET /api/0/organizations/{org}/issues/` | Issue list |
| `PUT /api/0/organizations/{org}/issues/?id=…&id=…` | Bulk status change |
| `GET, PUT, DELETE /api/0/organizations/{org}/issues/{id}/` | One issue; status change; delete |
| `GET /api/0/organizations/{org}/issues/{id}/events/` | The issue's events, newest first |
| `GET /api/0/organizations/{org}/issues/{id}/events/{latest\|oldest\|event_id}/` | `{event, previousEventId, nextEventId}`: the full event JSON from R2 and its neighbours |
| `GET /api/0/organizations/{org}/issues/{id}/tags/` | Top 10 values per key with counts |
| `GET /api/0/organizations/{org}/issues/{id}/stats/?period=24h\|14d\|30d` | Time series |
| `GET /api/0/organizations/{org}/issues/{id}/activity/` | Activity feed |
| `GET /api/0/organizations/{org}/shortids/{short_id}/` | Resolve `API-42` to an issue |
| `GET, PUT /api/0/organizations/{org}/limits/` | Read the monthly event cap (§6); `PUT` is owner-only and returns 403 otherwise |

**Issue list parameters:** `project` (id), `status` (default
`unresolved`; `all` drops the filter), `level`, `tag` (`key:value`), `query` (substring of
title or culprit, matched with `LIKE`), `sort` (`date`, `new`, `freq`),
`limit` (default 25, max 100), `cursor`.

**Pagination:** keyset. The cursor is the base64 of the last row's sort value
and id, and the next page is `WHERE (last_seen, id) < (?, ?)`. The list
response includes each issue's 24-hour series, fetched with one
`group_stats` query for the page's ids.

**Status changes:** `resolved` sets `resolved_at` and `resolved_by` and clears
`substatus`. `unresolved` and `ignored` clear `resolved_at` and `resolved_by`
and keep `substatus`, so an ignored regression is still marked regressed.
Each writes an `activity` row.

---

## 11. UI

A React SPA built with Vite, served from Workers static assets. The org slug
is in the URL but the UI shows no org switcher while there is one org.

| Route | View | API |
|---|---|---|
| `/` | Redirect to the issue list | `me` |
| `/{org}/issues/` | Issue list | `issues`, `projects` |
| `/{org}/issues/{id}/` | Issue detail, latest event | `issues/{id}`, `events/latest`, `tags`, `stats` |
| `/{org}/issues/{id}/events/{event_id}/` | Issue detail, chosen event | same |
| `/{org}/issues/{id}/events/` | Table of the issue's events | `events` |
| `/{org}/projects/` | Project cards with 24-hour charts | `projects` |
| `/{org}/settings/projects/{project}/` | Name, quota, DSN keys, SDK snippet | `projects`, `keys` |
| `/{org}/settings/` | Organization settings: the monthly event cap | `limits` |

**Layout.** After Sentry's current UI, in light and dark themes. The theme
follows the system setting until the toggle at the foot of the icon rail is
used; that choice is kept in `localStorage`. The shell is an icon rail (Issues,
Projects), a second column of links for the section (Feed, Errors, Warnings,
Resolved, Archived, All issues, then one link per project), and the page.
"Archived" is the UI's word for the `ignored` status.

**Issue list ("Feed").** A joined row of project, level and status selects;
a search box that shows the status and tag filters as removable tokens; a
sort menu. Each row: exception type (bold with a dot while unread) with a `Regressed`,
`Resolved` or `Archived` badge; the value beside a
level colour bar; platform, short id and culprit; then Last Seen, Age, a
24-hour trend with its peak, and the event count. The header checkbox selects
all, and the header turns into bulk Resolve / Archive / Unresolve.

**Issue detail.**
- Header: breadcrumb with short id, type, value with level bar, a status line
  (New, Ongoing, Regressed, Resolved, Archived), total events, then Resolve /
  Archive / Unresolve / Delete.
- Graph band: 30-day event chart with event and stored counts; beside it the
  leading value of the top tags as percentage bars, expandable to every tag.
  Clicking a value filters the issue list.
- Event tab: Older / Newer / First / Latest / View More Events; event id,
  age, link to raw JSON, jump links; a line with user, browser or runtime,
  release and environment.
- Foldable sections: Highlights, Message, Stack Trace, Breadcrumbs (newest
  first), Tags, Contexts (user, request, each SDK context, SDK), Additional
  Data.
- Stack trace: each exception in the chain with type, value, mechanism and
  handled. Frames newest first; library frames collapse into "Show N more
  frames". A frame expands to source context and local variables.
- Right column: last seen, first seen with release, activity timeline.

**Flood-sampled issues** show "N of M events stored" so the gap between the
count and the event list is explained.

### Using Sentry's frontend

Not used whole. `static/app` is about 8,800 TypeScript files, calls about 470
distinct organization API paths, and boots from data Django injects into the
page. Individual components import Sentry's private design system
(`@sentry/scraps/*`, `@sentry/icons/*`) and API hooks, so none is drop-in.

The UI is our own and copies the layout. Three pieces are worth porting from
Sentry's code, with their design-system imports replaced: the frame and
source-context renderer, the exception chain, and the breadcrumb list. Sentry
is licensed FSL-1.1-Apache-2.0, which allows internal use; the licence notice
stays with any copied file.

---

## 12. Cost and scale

Unit prices on Workers Paid ($5 per month): requests 10M included then $0.30
per million; Queues 1M operations included then $0.40 per million, three
operations per message up to 64 KB; R2 10 GB, 1M writes and 10M reads free,
then $0.015 per GB-month, $4.50 per million writes; D1 50M rows written, 25B
rows read and 5 GB included, then $1.00 per million rows written and $0.75
per GB-month.

Assumptions: 5 KB per stored event after gzip, about 18 D1 rows written per
stored event before batching savings (3 for the event row and its two
indexes, about 10 for tags, the rest for the issue and stats), 90-day
retention, about 400 bytes of D1 per event including indexes. These are
estimates, not measurements.

| Events per month | Queue | R2 | D1 | Approx. total |
|---|---|---|---|---|
| 100,000 | included | included | included | $5 |
| 1,000,000 | $0.80 | about $0.10 | included | $6 |
| 10,000,000, all stored | $11.60 | about $43 | about $130, and over the 10 GB cap | not viable as is |

**Ceiling.** With every event stored, D1 holds about 0.4 GB per million
events, so a 90-day window fits roughly 25 million events, or about 8 million
a month, before the 10 GB cap. D1 write cost becomes the larger concern
first, at around 3 million events a month. Flood sampling (§6) is what keeps
real workloads under both, since most volume comes from a few issues. Past
that, the options are a shorter retention, fewer indexed tags, or one D1
database per organization.

---

## 13. Later phases

**JavaScript source maps.** Needed for readable browser traces and for
frame-based browser grouping. Sketch: a table
`sourcemaps (project_id, debug_id, r2_key, created_at)` keyed by the debug id
that Sentry's bundler plugins inject; the consumer resolves frames with a
source-map library before grouping and marks them as resolved. Two open
points: `sentry-cli`'s upload uses a chunked-assemble API that is sizeable to
reimplement, so a small upload script of our own may be the practical route;
and events that arrive before their maps are uploaded will group under the
browser rule, so they land in a different issue from later ones.

**Attachments.** Keep `attachment` items in R2 under
`attachments/{project_id}/{event_id}/{name}` with a size cap.

**Merge.** Repoint the absorbed issue's `grouphashes` rows, add its counters,
move its events, delete it. The schema already supports this.

**Notifications.** Email is built (§18). Slack, webhooks and reply-by-email
are later: the settings table already has a `provider` column.

**Inbound filters.** Per-project switches to drop browser-extension errors,
localhost events and known crawlers at ingest.

---

## 14. Build order and tests

0. **Tooling first.** Formatter, linter with anti-slop and boundary rules,
   strict `tsconfig`, pre-commit hook and CI (§16), on an empty skeleton of
   the folders in §3. Every later step lands under the rules.
1. **Schema, project and key seeding, ingest.** Tests: envelope parser against
   captured envelopes from `@sentry/node`, `@sentry/browser` and `sentry-sdk`
   (with and without `length`, gzip, trailing newline, mixed item types); the
   three auth paths; size cap; CORS.
2. **Consumer.** Tests, using Miniflare's D1 and Queues: grouping fixtures
   (same error twice gives one hash; different line gives the same hash;
   different function gives a different one; parameterized messages collapse);
   scrubbing; 100 copies of one event give one issue with `times_seen = 100`;
   the same batch delivered twice changes nothing; two new errors in one batch
   get short ids 1 and 2; a resolved issue regresses; an ignored one does not;
   flood sampling stores 100 and counts the rest; a failing D1 batch leaves no
   partial writes.
3. **Read API with Access verification.** Tests: scoping (an issue id from
   another org is 404), pagination, tag filter.
4. **UI:** issue list, issue detail, settings.
5. **Rate limits, retention cron, DLQ replay script.**
6. Phase 2 items from §13.

Rough size: ingest 400 lines, consumer 900, API 500, UI 2,000–2,500.

---

## 15. Open decisions

- **Hostnames.** Two subdomains are assumed. The domain itself is not chosen.
- **Retention.** 90 days is assumed.
- **Default quota.** 10,000 events per project per hour is a guess.
- **Stored events per issue per hour.** 100 is a guess.
- **Alternatives.** GlitchTip and Bugsink are existing Sentry-SDK-compatible
  backends that run on one small server. This design is for serverless
  hosting on Cloudflare specifically.

---

## 16. Code standards and enforcement

Everything here fails CI. There are no warnings: a rule is either an error or
off. Versions and rule names were checked against the oxc docs and the
`dmmulroy/anti-slop` repository on 2026-11-17; the configs themselves have not
been run.

### 16.1 Tools

| Job | Tool | Notes |
|---|---|---|
| Format | **oxfmt** (`oxfmt`, config `.oxfmtrc.json`) | `oxfmt --check` in CI. |
| Lint | **oxlint** (`oxlint.config.ts`) | Native plugins plus type-aware rules. |
| Slop rules | **anti-slop**, vendored at `tools/oxlint/anti-slop/` | MIT. Meant to be copied in, not installed. Runs as an oxlint JS plugin. |
| Edge rules | **zentry**, our own, at `tools/oxlint/zentry/` | `no-json-parse`, `no-nullable-parameters`, `zod-only-at-boundaries` (§16.6). Linted like the rest of the code. |
| Boundaries | oxlint `no-restricted-imports` per folder, plus `import/no-cycle` | Native rules, no extra tool. |
| Types | `tsc --noEmit` with the strict flags in §16.5 | |
| Hooks | lefthook | Format and lint staged files before commit. |

Two cautions:

- oxlint's JS plugin support, which anti-slop depends on, is marked alpha and
  is outside semver. `oxlint` and `@oxlint/plugins` are therefore pinned to
  the same exact version (anti-slop currently pins 1.78.0) and upgraded
  together.
- anti-slop's rules work on syntax and same-file scope, not the type checker.
  They do not follow imported types.

### 16.2 Formatting (`.oxfmtrc.json`)

```jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "sortImports": true,
  "sortPackageJson": true,
  "ignorePatterns": [
    "ui/dist/**",
    "tools/oxlint/anti-slop/**",
    "test/fixtures/**",
    ".wrangler/**",
    "worker-configuration.d.ts",
    "pnpm-lock.yaml",
    "README.md",
    "DESIGN.md"
  ]
}
```

`README.md` and `DESIGN.md` are not formatted: oxfmt pads every Markdown
table to its widest cell, which makes the wide tables here unreadable as text
and turns each edit to a row into a diff of the whole table. Formatting is
never discussed in review: if `oxfmt --check` passes, it is right.

### 16.3 Domain boundaries

Each folder under `src/` is a domain with one job. Imports between them are
fixed:

| Folder | Job | May import |
|---|---|---|
| `shared/` | Types, ids, time, JSON boundary helpers, API contract types | nothing internal |
| `core/` | Envelope parsing, normalization, scrubbing, grouping, batch planning | `shared` |
| `db/` | Every SQL statement, behind typed functions | `shared` |
| `blobs/` | Every R2 read and write, and all key construction | `shared` |
| `ingest/` | HTTP ingest | `shared`, `core`, `db` |
| `consumer/` | Queue handler | `shared`, `core`, `db`, `blobs` |
| `api/` | Read API | `shared`, `core`, `db`, `blobs` |
| `cron/` | Retention, spike thresholds, weekly reports | `shared`, `core`, `db`, `blobs` |
| `notify/` | Notify queue consumer, mailer, unsubscribe page | `shared`, `core`, `db` |
| `worker.ts` | Wires handlers to bindings | everything |
| `ui/` | SPA | `src/shared/contract.ts` only, as type imports |

Rules that follow from the table:

- **`core/` is pure.** It takes values and returns values. It may not import
  `db`, `blobs`, `cloudflare:workers`, or read the clock; the current time is
  passed in. This is what makes grouping and planning unit-testable without
  Miniflare.
- **`ingest`, `consumer`, `api`, `cron` and `notify` never import each other.** Anything
  two of them need moves to `shared`, `core`, `db` or `blobs`.
- **SQL appears only in `db/`**, and R2 key strings only in `blobs/`. Handlers
  receive typed functions, not `D1Database`. The schema in §8 then has one
  owner in code.
- **No import cycles**, anywhere.

How it is enforced:

- Cross-folder imports must use the `@/` alias (`@/core/grouping`).
  Parent-relative imports (`../`) are banned, so every cross-domain import is
  a plain string the linter can match.
- Each folder has an `overrides` block listing the aliases it may not import.
- `import/no-cycle` is on globally.

The "SQL only in `db/`" rule is partly structural rather than linted: oxlint
has no `no-restricted-syntax`, so nothing stops a handler calling
`.prepare()` if it is handed a raw `D1Database`. The guard is that
`worker.ts` passes the binding only to `db/` constructors.

### 16.4 Lint config (`oxlint.config.ts`)

```ts
import { defineConfig } from "oxlint";

// Domain boundaries. See DESIGN.md §16.3 before changing any of this.
const DOMAINS = ["shared", "core", "db", "blobs", "ingest", "consumer", "api", "cron"];

type Pattern = { group: string[]; message: string };

const forbid = (...domains: string[]): ["error", { patterns: Pattern[] }] => [
  "error",
  {
    patterns: [
      { group: ["../*", "../**/*"], message: "Use the @/ alias for imports outside this folder." },
      ...domains.map((domain) => ({
        group: [`@/${domain}`, `@/${domain}/**`],
        message: `This folder may not import from ${domain}/. See DESIGN.md §16.3.`,
      })),
    ],
  },
];

const except = (...allowed: string[]): ["error", { patterns: Pattern[] }] =>
  forbid(...DOMAINS.filter((domain) => !allowed.includes(domain)));

export default defineConfig({
  plugins: ["typescript", "import", "unicorn", "oxc", "promise", "vitest", "react"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "zentry", specifier: "./tools/oxlint/zentry/index.ts" },
  ],
  options: { typeAware: true },
  categories: { correctness: "error", suspicious: "error", perf: "error" },
  ignorePatterns: [
    "ui/dist/**",
    "tools/oxlint/anti-slop/**",
    ".wrangler/**",
    ".claude/**",
    "worker-configuration.d.ts",
  ],
  rules: {
    // ── Boundaries ──────────────────────────────────────────────
    "import/no-cycle": "error",
    "import/no-default-export": "error",
    "no-restricted-imports": forbid(),

    // ── Types ───────────────────────────────────────────────────
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/explicit-module-boundary-types": "error",

    // ── Size and shape ──────────────────────────────────────────
    "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
    "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
    "max-depth": ["error", 3],
    "max-params": ["error", 3],
    complexity: ["error", 10],

    // ── Hygiene ─────────────────────────────────────────────────
    eqeqeq: "error",
    "no-console": "error",
    "no-param-reassign": "error",
    "oxc/no-accumulating-spread": "error",
    // Sequential awaits are deliberate here: bounded R2 concurrency, chunked
    // deletes, and time-boxed retention loops.
    "no-await-in-loop": "off",
    // The UI uses the automatic JSX runtime, which needs no React import.
    "react/react-in-jsx-scope": "off",

    // ── anti-slop: every generic rule ───────────────────────────
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // ── zentry: validate once at the edge (DESIGN.md §16.6) ────
    "zentry/no-json-parse": "error",
    "zentry/no-nullable-parameters": "error",
    "zentry/zod-only-at-boundaries": "error",
  },
  overrides: [
    { files: ["src/shared/**"], rules: { "no-restricted-imports": except() } },
    { files: ["src/core/**"], rules: { "no-restricted-imports": except("shared") } },
    { files: ["src/db/**"], rules: { "no-restricted-imports": except("shared") } },
    { files: ["src/blobs/**"], rules: { "no-restricted-imports": except("shared") } },
    {
      files: ["src/ingest/**"],
      rules: { "no-restricted-imports": except("shared", "core", "db") },
    },
    {
      files: ["src/consumer/**"],
      rules: { "no-restricted-imports": except("shared", "core", "db", "blobs") },
    },
    // api takes core for the spike floor a new project starts with (DESIGN.md §6).
    {
      files: ["src/api/**"],
      rules: { "no-restricted-imports": except("shared", "core", "db", "blobs") },
    },
    // cron takes core for the spike-protection arithmetic, which is pure (DESIGN.md §6).
    {
      files: ["src/cron/**"],
      rules: { "no-restricted-imports": except("shared", "core", "db", "blobs") },
    },
    { files: ["ui/**"], rules: { "no-restricted-imports": except() } },

    // Named exemptions. Each is one file or one folder, with the reason.
    {
      // `jsonKind` tells the members of the Json union apart for trim and scrub, and
      // `jsonText` hands a parsed value to a schema; both need what these rules forbid.
      files: ["src/shared/json.ts"],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
    {
      // `jsonText` is the one place JSON text is parsed, straight into a schema.
      files: ["src/shared/json.ts"],
      rules: { "zentry/no-json-parse": "off" },
    },
    {
      // Where outside data enters, and so where its schemas live: the event and
      // envelope from SDKs, the queue payload, API requests, the Access JWT, and
      // JSON columns read back from D1. A new entry point is added here, by name.
      files: [
        "src/shared/json.ts",
        "src/shared/schema.ts",
        "src/core/wire.ts",
        "src/core/envelope.ts",
        "src/ingest/handler.ts",
        "src/consumer/handler.ts",
        "src/api/**",
        "src/db/**",
      ],
      rules: { "zentry/zod-only-at-boundaries": "off" },
    },
    {
      // The UI's JSON viewer has to tell strings, numbers, lists and objects apart.
      files: ["ui/src/lib/json.ts"],
      rules: { "anti-slop/no-runtime-typeof": "off" },
    },
    {
      // The UI's API client and the e2e helpers assert that responses match the shared contract.
      files: ["ui/src/lib/api.ts", "e2e/support.ts"],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
    {
      // The logger is the one module allowed to write to the console.
      files: ["src/shared/log.ts"],
      rules: { "no-console": "off" },
    },
    {
      // SQL is long; statements are kept whole rather than split to fit a line count.
      files: ["src/db/**"],
      rules: { "max-lines-per-function": "off" },
    },
    {
      // Workers, Vite, Vitest, Playwright and oxlint require a default export in these files.
      files: [
        "src/worker.ts",
        "ui/vite.config.ts",
        "vitest.config.ts",
        "oxlint.config.ts",
        "e2e/playwright.config.ts",
        "tools/oxlint/zentry/index.ts",
      ],
      rules: { "import/no-default-export": "off" },
    },
    {
      // Test suites are long by nature, and small helpers read best next to their test.
      files: ["test/**", "e2e/**"],
      rules: {
        "max-lines-per-function": "off",
        "max-lines": "off",
        "unicorn/consistent-function-scoping": "off",
      },
    },
  ],
});
```

This is the file as it stands; change both together. The `ui/**` override blocks every
`@/` domain; the one allowed import, `src/shared/contract.ts`, is reached
through a separate `@contract` alias.

### 16.5 TypeScript (`tsconfig.json`, compiler options)

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noPropertyAccessFromIndexSignature": true,
  "noImplicitOverride": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "paths": { "@/*": ["./src/*"], "@contract": ["./src/shared/contract.ts"] }
}
```

### 16.6 What the anti-slop rules mean for this codebase

Three of them shape the design rather than just the style:

- **`no-runtime-typeof`, `no-unknown-parameters`, `no-unknown-returns`.** The
  ingest and consumer handle arbitrary JSON from SDKs. Under these rules that
  JSON is validated exactly once, where it enters, by a zod schema: the event
  by `WireEvent` (`core/wire.ts`), envelope headers in `core/envelope.ts`,
  API bodies and query strings at the top of each handler, the Access JWT in
  `api/access.ts`, and JSON columns read from D1 inside `db/`. Everything past
  a schema works on its typed output and never re-checks a type. The one
  `typeof` left is `jsonKind` in `src/shared/json.ts`, which tells the members
  of the `Json` union apart for the code that trims and scrubs free-form data.
- **Zentry's own rules (`tools/oxlint/zentry/`) hold that line.**
  `no-nullable-parameters` rejects any parameter typed `T | null`, `T |
  undefined` or `x?: T`: absence is checked once, where the value is
  produced, and helpers take present values. Inline callbacks (typed by the
  API they are passed to) and React hooks (which cannot be skipped while
  their input loads) are exempt. `no-json-parse` sends all JSON text through
  `jsonText(schema)`. `zod-only-at-boundaries` allows schemas only in the
  files listed in `oxlint.config.ts` as entry points, so nothing past them
  re-validates.
- **`no-module-mocking`.** Tests may not mock modules. This fits the test plan
  in §14: `core/` is pure and needs no mocks, and everything else runs against
  Miniflare's real D1, R2 and Queues.
- **`require-safety-comment-for-type-assertion`.** Any `as` needs a
  `// SAFETY:` comment giving the reason it holds. With the two points above,
  assertions should be rare outside `shared/json.ts` and `db/`.

`no-array-filter-map` asks for iterator helpers (`.values().filter().map().toArray()`),
which the Workers runtime supports.

### 16.7 Scripts, hook and CI

```jsonc
// package.json (excerpt)
"scripts": {
  "build": "vite build ui",
  "check": "pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test",
  "fmt": "oxfmt",
  "fmt:check": "oxfmt --check",
  "lint": "oxlint --deny-warnings",
  "lint:fix": "oxlint --fix",
  "typecheck": "tsc --noEmit && tsc --noEmit -p ui && tsc --noEmit -p e2e",
  "test": "vitest run",
  "e2e": "pnpm build && playwright test -c e2e"
}
```

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    fmt:  { glob: "*.{ts,tsx,json,jsonc,css}", run: "pnpm oxfmt {staged_files}", stage_fixed: true }
    lint: { glob: "*.{ts,tsx}", run: "pnpm oxlint --deny-warnings {staged_files}" }
```

CI runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm check` and
`pnpm e2e` on every pull request and every push to `main`. It does not deploy.
Deploys are run by hand with `pnpm run deploy`, which reads the git-ignored
`wrangler.production.jsonc` holding the account's real IDs and hostnames
(README "Deploy"); CI has neither. Deploying from CI can come once the
hostnames in §15 are settled and the config can live in CI secrets.

### 16.8 Policy

- A lint rule is switched off only in `oxlint.config.ts`, in an `overrides`
  entry that names the file and gives the reason. Inline disable comments are
  not used.
- A new cross-domain dependency means changing the table in §16.3 first.
- The vendored anti-slop rules are ours to edit. A rule that proves wrong for
  this codebase is changed or removed there, with a note in the commit, rather
  than worked around.

---

## 17. Implementation notes

What changed when the design met running code. The code is the reference.

**Fixed while building**

- **E3 did not run as written.** In `UPDATE … FROM`, unqualified column names
  such as `title` are ambiguous between `groups` and the joined rows. Every
  right-hand reference is now `groups.<column>`. See `src/db/batch.ts`.
- **Brotli request bodies are refused** (§5.4).
- **`wrangler dev` presents requests as the first route's hostname**, which
  made the Worker treat local requests as ingest-only. `wrangler.jsonc` sets
  `dev.host` to `localhost:8787`.

**Fixed after an independent audit against this document**

- **Request bodies sent as text are scrubbed by key** when they hold JSON or
  form fields (§7.2). Before, only the card-number rule applied to them.
- **The inline queue payload is measured as it is serialized** (a JSON
  string, with quotes escaped), so a quote-heavy event under 100 KB spills to
  R2 instead of exceeding the 128 KB message limit (§5.6).
- **The burst limiter counts only envelopes that carry an event** (§6.1).
  Transactions, sessions and other dropped items no longer make the SDK back
  off from sending errors.
- **`run_worker_first` is `true`**, so the ingest hostname really does refuse
  the UI (§5.1). With a path list, static assets were served before the
  Worker's hostname check ran.
- **Access signing keys**: a failed fetch of the certs keeps the keys already
  held, and an unknown key id triggers a refetch, at most once a minute (§10).
- **A project deleted while its events are in flight** no longer fails the
  batch: E7 skips projects that no longer exist (§7.4).
- **Membership of organization 1 is granted only when the user row is
  created**, not on every session (§10).
- **Changing a project's quota clears its current rate limit** (§6).
- **An event that throws during normalization is logged and dropped**, like
  one that is not JSON (§7.6).
- **Event by id uses the `events` primary key** (project, event id), as the
  index table in §8 says.

**Added after the first deploy**

- **Unread issues, per user** (migration `0002_group_seen.sql`). Modelled on
  Sentry's `GroupSeen`: one row per (user, issue) with `last_seen`. An issue
  is unread for a user until they open it, and again after it regresses:
  `hasSeen` is true when the row's `last_seen` is later than the issue's
  latest `regressed` activity, or its `first_seen` if it never regressed.
  `PUT /organizations/{org}/issues/{id}/` accepts `{"hasSeen": true}`; the UI
  sends it when an issue page loads. In the issue list an unread issue has a
  dot and a bold title; a seen one has neither. This replaces the `New` badge.
- **`logger`** is kept on the event, indexed as a tag, and stored in the
  issue's metadata. The issue row shows it after the culprit, which is where
  .NET and Java events show their class or namespace.
- **Grouping closer to Sentry** (config id `lite:2026-11-18`; existing issues
  may split once when their next event arrives, because their hashes change):
  exception groups hash by their distinct children; messages parameterize
  clock times, host names, `job_123` and `req_8f3a9c01`; proxy class names are
  normalized; the default in-app rule also knows JVM, Android, .NET, Apple, Go,
  Dart and Rust platform code (`core/inapp.ts`, a small subset of Sentry's
  roughly 550 rules). Not done: Sentry's second, system-frames hash.
- **Fixes from the Sentry comparison (backend)**: stacks in `threads` or a
  top-level `stacktrace` are kept (§7.2); an event sent with attachments is no
  longer refused for their size, only for an event over 1 MB (§5.4);
  hyphenated key names and secrets inside text are scrubbed; no IP is stored
  when the SDK says `infer_ip: never`; `{{default}}` without spaces and
  variables such as `{{ transaction }}` and `{{ tags.key }}` work in custom
  fingerprints; issues are kept when their events expire (§9); `log`,
  `critical` and numeric levels map to Sentry's; message templates are filled
  from `params`; `post_context` keeps its first lines.
- **Issue list trend and layout**: the trend column has Sentry's 24h / 30d
  switch (`groupStatsPeriod` on the list API, remembered per browser), a
  baseline under light bars, and a gray status label. The Issue column takes
  about two fifths of the table rather than all the leftover width. On phones
  the icon rail becomes a top bar, the filters wrap, and rows keep Last Seen.
- **Old issues and the strict metadata parse**: migration
  `0004_metadata_logger.sql` writes `logger: null` into issues created before
  `logger` was part of the metadata. Without it, the parse added in
  `db/issues.ts` rejected those rows and the whole issue list failed.
- **Closer to Sentry's UI, in the browser only** (no API or schema change):
  - Issue list: the whole row opens the issue; shift-click selects a range,
    cmd/ctrl-click toggles a row; the header checkbox is tri-state and the
    header sticks under the top bar. Status (New, Ongoing, Regressed,
    Resolved, Archived) sits under the trend. Times tick every minute and show
    local and UTC on hover; counts show the exact number on hover. Columns
    drop out as the table narrows (container queries). Bulk changes over a
    whole page are confirmed, and every status change shows a toast with Undo.
    Three empty states (no projects, waiting for the first event, nothing
    matches), skeleton rows while loading, Retry on errors. The sort is
    remembered per browser.
  - **Real-time updates**: a play/pause button in the top bar. While on, the
    first page reloads every 5 seconds when the tab is visible. Off by
    default; the choice is kept in `localStorage` (Sentry uses a cookie).
  - Issue page: a banner with Unresolve or Unarchive replaces the actions on a
    closed issue; Delete moved into a "…" menu with a confirmation dialog.
    The event bar sticks, has First / Latest, Previous / Next, copy event ID
    and Copy as Markdown. The graph marks the bucket of the event shown. Tag
    previews follow the platform's tag order and use segmented bars with
    "<1%" and ">99%"; "View all tags" shows cards with a filter. Sections fold
    and remember it per browser; "Jump to" lists only the sections present.
    New sections: HTTP Request (with a curl view), SDK and Event Grouping
    Information (both folded). The stack trace has Most Relevant / Full,
    Newest / Oldest, a raw platform-style view and copy; library runs fold
    behind the frame nearest the crash; repeated frames are counted; source
    lines are coloured. Breadcrumbs are a timeline with type icons, the event
    itself on top, the newest six shown, a filter and absolute or relative
    times. Tags are a tree of dotted keys with All / Custom / Application /
    Client tabs and a menu per value; the derived tags the Worker indexes are
    shown too (a copy of `src/core/tags.ts` in the UI). Context cards follow
    Sentry's order and titles, hide `type`, sort their rows and format bytes,
    battery level, yes/no flags and start times. Relative times on this page
    read "5 minutes ago".

**Known differences from the text above, left as they are**

- A non-POST request to an ingest route gets 405, not 404.
- `request.cookies` and `logentry.params` are dropped rather than kept.
- `User-Agent` is added to the request headers only for browser events.
- The card rule needs a known issuer prefix and a Luhn pass, and replaces
  only the number, not the whole value.
- The issue list is index-ordered only with one project and one status; the
  all-projects feed and tag-filtered lists sort their matches. This is fine
  at the sizes in §12 and is the first thing to revisit beyond them.
- Issue ids can be reused after an issue is deleted (SQLite rowids).
- Query strings inside breadcrumb `data.url` get the shape rules (cards,
  IBANs, keys, URL credentials, bearer tokens) but not the key rule, so
  `?token=abc` there is kept.
- The issue list has no environment picker; filter by clicking a tag value.

**Spend limits (migration `0003_spend_limits.sql`)**

- The monthly cap, spike protection and reason codes in §6 were added after a
  review against Sentry's quota code. The migration clears any rate limit set
  before it, since those carry no reason; the next batch over quota sets them
  again.
- `cron/` imports `core/` (§16.3) for the spike arithmetic, and `api/`
  imports `core/` for the floor a new project starts with.
- The monthly cap is a column on `organizations`, not a variable, so owners
  can change it in the UI without a deploy.

**Decisions the design left open**

- **Stored event format.** R2 holds our own typed `StoredEvent`
  (`src/shared/contract.ts`), not the SDK's raw JSON. The UI and the Worker
  compile against the same type.
- **Hourly buckets use the receive time**, not the event's own timestamp, for
  `group_stats`, `project_stats` and flood sampling.
- **Ingest routes answer on any hostname; the read API and the UI are refused
  on `INGEST_HOST`.** This keeps local development on one port.
- **Local sign-in.** On `localhost` only, `DEV_USER_EMAIL` (from `.dev.vars`)
  stands in for the Access JWT.
- **B1, B2 and B4 run as three parallel queries** rather than one `batch()`,
  so each result keeps its row type.
- **MD5 is implemented in `src/core/md5.ts`** so that `core/` stays
  synchronous and free of runtime APIs.
- **The issue list takes one `project` and one `tag` filter**, not repeated
  parameters.
- **The API returns the stored event as text spliced into the response**, so
  the Worker never parses it.
- **The parameterizer uses `<hash>`** for both SHA-1 and MD5, because a
  placeholder containing a digit would be re-matched by the `<int>` rule.

**Tooling as built (§16)**

- `oxlint` and `@oxlint/plugins` are pinned to 1.93.0; `oxfmt` 0.78.0.
  `sortImports: true` and `--deny-warnings` both work as written.
- Tests run in the Workers runtime through `@cloudflare/vitest-plugin`
  (the renamed `vitest-pool-workers`), on vitest 4.
- The UI imports its own files through a `~/` alias, since `../` is banned.
- End-to-end tests live in `e2e/` and run with Playwright (`pnpm e2e`): a
  fixture shop page using the stock `@sentry/browser` SDK reports to a local
  Zentry started on a clean database. They are not part of `pnpm check`, but
  CI runs them after it (§16.7).

**Not done yet**

- Captured-envelope fixtures from the browser and Python SDKs (§14 step 1).
  `@sentry/node` 11 was checked by hand against a local server.
- DLQ replay script (§14 step 5).
- Everything in §13.
- Nothing has been deployed, and CI does not deploy (§16.7). The R2
  lifecycle rules, the Access application and the queue retention setting
  are manual steps listed in `README.md`.

---

## 18. Email notifications

Modelled on Sentry's notifications; the research behind this section is the
"How Sentry notifications and emails work" doc. Email goes through Cloudflare
Email Service's `send_email` binding (public beta, Workers Paid, 3,000 a month
included, then $0.35 per 1,000).

### 18.1 Pipeline

1. **Outbox.** Anything that may need an email writes a `notify_outbox` row
   in the same transaction as the change itself, so no notification is lost
   between a commit and an enqueue:
   - the consumer's commit (§7.4): `new_issue` with each new group,
     `regression` with E2, `spike` before E8 when spike protection starts
     refusing a project, `quota` before E9 when the month's count crosses 80%
     or 100% of the cap;
   - `IssueStore.setStatus`: `status`, with the acting user;
   - the Saturday 12:00 UTC cron: `weekly_report`, one per organization.
2. **Wake-up.** After such a write the writer sends `{kind: "drain"}` to the
   `zentry-notify` queue. A failed send is only logged: the hourly cron
   sweeps a non-empty outbox and wakes the consumer itself.
3. **Drain.** The notify consumer (`max_concurrency: 1`) reads up to 25
   rows in id order, handles each, and deletes it. A row that throws keeps
   its place with `attempts + 1` and the message is retried after 60 s; after
   five attempts the row is dropped and logged, so it cannot block the rest.
   When Cloudflare asks to wait (rate or daily limit, an outage), the drain
   stops at once and counts no attempt, so a busy hour cannot drop alerts.
   `notify_outbox.id` is AUTOINCREMENT because it is part of each email's
   idempotency key and a reused rowid would make a new email look sent.
4. **Send.** One `send()` per recipient. `email_sends` is claimed first with
   a key unique to the email and recipient; a redelivery finds it sent and
   skips it.

With `EMAIL_FROM` empty the outbox is still drained, and nothing is sent.

### 18.2 Settings

| Type | Values | Default | Scopes |
|---|---|---|---|
| `alerts` | always, never | always | user, organization, project |
| `workflow` | always, subscribe_only, never | subscribe_only | user, organization, project |
| `spikeProtection` | always, never | always | user, organization, project |
| `quota` | always, never | always | user, organization |
| `reports` | always, never | always | user, organization |

The most specific row wins: project, then organization, then user, then the
default (`core/notify-settings.ts`). Sentry also has a team scope; Zentry has
no teams. The UI edits organization and project rows; unsubscribe links write
project or organization rows, so the UI always shows what a link did.

`issue_subscriptions` records who follows an issue. Changing an issue's
status follows it (`INSERT OR IGNORE`, so an explicit unfollow survives); the
Follow button and the workflow unsubscribe link set it explicitly.
`subscribe_only` sends only for followed issues; an unfollow beats `always`.

### 18.3 Recipients

Every organization member is a candidate (no teams, no ownership rules, no
suspect commits), filtered by their setting for the type where the email comes
from. Workflow emails never go to the user who made the change. The `quota`
emails go to every member, not only owners, until Zentry has billing roles.

### 18.4 Alerts and digests

- An issue alerts on creation and on regression, at most once per 30 minutes
  per reason (`notify_state`), and only while it is unresolved.
- Per project, the first alert goes out at once and opens a window in
  `digest_windows`, due 5 minutes later. Alerts inside the window wait in
  `digest_pending`; each pushes the due time to 30 s after itself, never past
  30 minutes after the window opened (`core/digest.ts`, Sentry's
  `minimum_delay`, `increment_delay` and `maximum_delay`).
- A `{kind: "digest"}` message, delayed with `delaySeconds`, flushes the
  window: early, it re-delays itself; due with nothing held, it closes the
  window; with one issue it sends a normal alert; with more, one digest email
  listing up to 10. A send opens the next window.
- An alert arriving at a window already past due re-requests the flush, in
  case its message went to the dead letter queue; the hourly sweep does the
  same for any window more than 10 minutes past due.
- After the first alert's send, the alert is recorded before the window is
  opened, so a retry stops at the interval check instead of holding an issue
  already emailed.

### 18.5 Emails

`core/email-layout.ts` renders one list of blocks twice, so every email has an
HTML part and a matching plain-text part. Subjects follow Sentry's:
`API-12 - <title>` for anything about an issue, with no prefix, as Sentry now
sends them. Times are UTC, since users have no timezone yet.

The issue alert (`core/email-alert.ts`) is laid out like Sentry's: the issue
card (innermost exception type, its value, event time and id), project,
environment, level and release, then the latest event's exception with
in-app frames, user (id, email, username, IP), message and tags. The notify
consumer reads that event back from R2 through `latestEvent`, wired in
`worker.ts`, so `notify/` still imports no `blobs/`; `blobs/events.ts` parses
it leniently with its own schema. When the event is missing (not stored
under the per-issue cap, aged out, or R2 failing), the alert goes out with
the issue's fields alone. Values are clipped (2,000 characters, 12 frames,
40 tags), because an exception value can be a whole HTML error page.

Headers: `Auto-Submitted: auto-generated`, `X-Zentry-Kind`, and on every
email `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
(RFC 8058), which Sentry omits. Cloudflare picks the Message-ID, so
`email_threads` keeps the id `send()` returned for the first email per
address and issue, and later ones set `In-Reply-To` and `References` to it.

Errors: rate, daily-limit, internal, not-ready and delivery failures throw, so
the row is retried. `E_RECIPIENT_SUPPRESSED` (Cloudflare's own bounce and
complaint list) adds the address to `email_suppressions` for 7 days. Anything
else is recorded as failed in `email_sends` and logged.

### 18.6 Unsubscribe

The link is `https://INGEST_HOST/notifications/unsubscribe?t=<token>`, on the
ingest host because Access guards the UI host and mail providers POST without
signing in. The token is `user.type.scope.id.<HMAC-SHA256>` with
`EMAIL_SIGNING_KEY`; it does not expire, since all it can do is turn an email
off. GET shows a confirmation page (link scanners fetch every URL); POST,
from that page or from the mail provider, applies it.

### 18.7 Weekly report

Saturdays at 12:00 UTC, covering the seven UTC days before. Per organization:
received events and new issues per project, issues regressed and resolved,
and the five issues with the most events. An organization with no events and
no new issues gets no email.

### 18.8 Not done

- Delivery events. Bounces and complaints are learnt only when `send()`
  refuses a suppressed address; Email Sending's event subscription queue is
  not consumed.
- Reply-by-email (an `email()` handler) and `mailto:` unsubscribe.
- Timezones, deploy emails (Zentry has no deploys), nudges and account
  emails.
