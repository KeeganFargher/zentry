# Suspect commits: plan

Status: a plan; nothing is built yet. Written 2026-11-21 from Sentry's source (getsentry/sentry master and getsentry/sentry-cli, read the same day) and a map of what Zentry has today. A reviewer then checked both and the plan was revised.

The goal is to name the commit that most likely broke a new issue, the way Sentry's "Suspect Commit" card does. It shows on the issue page (web and mobile), in the alert push and in the alert email.

## 1. How Sentry does it

Sentry has two strategies (`SuspectCommitStrategy`, `src/sentry/models/groupowner.py`). Each project runs exactly one; it never falls back from one to the other (`tasks/post_process.py::process_commits`).

|           | Blame (`scm_based`)                                                                                              | Release (`release_based`, "legacy")                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Runs when | the org has a GitHub/GitLab integration **and** the project has a code mapping                                   | otherwise                                                                                                  |
| Needs     | a repo connection and code mappings                                                                              | releases with commits (`sentry-cli releases set-commits`)                                                  |
| Runs      | once, as its own retried task, when the issue is new                                                             | on every event, debounced for 7 days per issue                                                             |
| Picks     | the most recent commit that blame finds on any in-app frame line, within 60 days before the issue first appeared | the authors whose changed files best match the frame paths, across the issue's release and the 5 before it |

Zentry copies **blame only**. The release strategy needs releases, deploys, `set-commits` and per-commit file changes. Zentry has none of these, and it answers their API routes with a 501 (DESIGN.md §20). That is a bigger project than this one (§8).

Sentry never holds an alert back for suspect commits. `process_commit_context` is a separate task. An alert sent before the task finishes simply goes out without a suspect commit. Zentry does the same (§5).

### 1.1 The blame algorithm, as Zentry will copy it

Taken from `tasks/commit_context.py::process_commit_context` and `integrations/utils/commit_context.py::find_commit_context_for_event_all_frames`.

1. **Frames.**
   - Where they come from: the exception chain's stack traces, or else the event's top-level `stacktrace`, or else the crashed thread's (`find_stack_frames`).
   - Keep frames with `in_app`, innermost first, without duplicates.
   - If none are left, the outcome is `could_not_find_in_app_stacktrace_frame`. A frame with no `lineno` is not dropped here; like any frame that maps to nothing, it ends in `no_successful_code_mapping`.
2. **Map each frame to a repo path** with the project's code mappings (§1.2). If none map, the outcome is `no_successful_code_mapping`.
3. **Blame.**
   - One GitHub GraphQL query per installation covers every repository and mapped file. Each repository is aliased `repository{i}`, each ref `ref{j}: ref(qualifiedName: branch)`, and each file `blame{k}: blame(path)`.
   - For each frame, take the first range where `startingLine <= lineno <= endingLine` and both `oid` and `committedDate` are set.
   - A null repository, ref or blame alias means that file is skipped, not that the query failed. The same holds for a null author.
4. **Choose.**
   - `commit_date_max` is the issue's `first_seen`. Sentry uses the first release's date when that is earlier; Zentry has no release dates.
   - Of the blamed commits with `commit_date_max − 60 days < committedDate < commit_date_max`, pick the **most recent**. This is not necessarily the top frame's commit.
   - Outcomes: `found`, `commits_too_old`, `commits_too_recent`, `no_valid_commits` (some too old and some too recent, none in the window) and `no_commits_found`.
5. **Store** the commit and its author.

**Blame reads the branch head, not the release SHA.** Sentry does the same. The 60-day window and the `< first_seen` bound stop a fix pushed after the error from being blamed. Zentry copies the quirk.

### 1.2 Code mappings

A code mapping says: "a frame path starting with `stack_root` lives in repository R under `source_root`, on branch B" (Sentry's `RepositoryProjectPathConfig`). Zentry ports these functions line for line, with Sentry's unit test cases:

**Path conversion** (`convert_stacktrace_frame_path_to_source_path`, `_map_frame_path_to_source_path`):

- The candidates, in order, are the frame's `filename`, then its `abs_path`.
- A candidate must start with `stack_root`.
- The result is `path.replace(stack_root, source_root, 1)`, with `\` turned into `/`, leading `/` stripped, and the path normalised.
- Empty, absolute and `..` results are rejected, as is any result containing `\` or `"`.
- If `stack_root` is empty or ends in a slash, the result must stay under `source_root`.

**Mapping order** (`get_sorted_code_mapping_configs`): an insertion sort, ported as is.

- A mapping goes before the first existing mapping that is relative while it is absolute, or whose `stack_root` it extends.
- Otherwise a user-created mapping goes to the front, so unrelated roots end up newest first.
- The first mapping that yields a path wins.

Sentry counts a root as absolute only when it starts with `/`. A .NET root such as `C:\a\1\s\` is therefore "relative". The port keeps that, and the settings page says so.

**Branch.** The mapping's branch is required. There is no repository-level default and no `master` fallback.

Sentry can also derive mappings by matching frame paths against the repo tree (`auto_source_code_config`). That is a later phase (§8). In v1 the mappings are entered by hand.

**The real risk is the paths.** The user's errors come from .NET. Depending on how its PDBs are built, a frame path can be:

- a build-machine path, such as `/home/runner/work/app/app/src/Core/Foo.cs` or `C:\a\1\s\src\Core\Foo.cs`;
- a bare file name;
- nothing at all.

A bare file name cannot be mapped. Phase 0 (§7) checks real events before anything is built.

### 1.3 What Sentry shows

- **Issue page** (`static/app/components/events/suspectCommits.tsx`, `commitRow.tsx`): a "Suspect Commit" heading, then:
  - the first line of the commit message, linked to the pull request when there is one, otherwise to the commit;
  - the author's avatar and name ("You" for the viewer, "Unknown author" when there is none);
  - "committed `abc1234`", linked, and how long ago;
  - a hint when the author's email matches no member.
- **API:** `GET /api/0/projects/{org}/{project}/events/{event_id}/committers/`. It only reads what is stored and returns `{committers: [{author, commits: [{id, message, dateCreated, pullRequest, repository, suspectCommitType: "via SCM integration"}]}]}`, plus `group_owner_id`.
- **Alert email:** a "Suspect Commits" table with the author, the subject and the short sha.
- **Slack:** the suspect commit's author appears among the suggested assignees.

## 2. What Zentry has today

- **Releases** are only strings: `events.release` and `groups.first_release`.
  - There are no release, commit or repository tables.
  - The sentry-cli release routes return 501.
- **Frames** are kept whole in R2 (`StoredFrame`, `src/shared/contract.ts:20`): `filename`, `absPath`, `module`, `lineno` and `inApp`.
  - The alert path reads a cut-down `SummaryFrame` (`src/blobs/events.ts:13`) that drops `absPath`.
  - The suspect job reads the full stored event instead.
- **New issues:**
  - Every new group gets a `new_issue` row in `notify_outbox`, written in the same D1 batch that creates the group (`src/db/batch.ts:84`).
  - By then the event is in R2.
  - Outbox kinds are fixed by a CHECK constraint, so a new kind needs a migration.
- **The notify consumer** runs one batch at a time (`max_concurrency` 1), up to 25 outbox rows per drain (`DRAIN_LIMIT`, `src/notify/handler.ts:23`). Seconds of GitHub calls per new issue would hold up every alert, monitor and quota email behind them. This is why the work goes on its own queue (§5).
- **Deferral:** `SendDeferred` (`src/notify/providers.ts`) already lets a provider put a row aside and retry it later.
- **Outbound clients** follow the pattern of `src/push/expo.ts` and `src/ai/summaries.ts`:
  - each is its own domain that imports only `shared`;
  - zod at the edge;
  - a result union, not a throw;
  - wired into the domains that use it from `worker.ts`, through their deps.
- **Users** are identified by their Cloudflare Access email, unique and lower-cased. Owner and member are the only roles, and Access admits every member, so owner-only pages must check the role themselves.
- **DESIGN.md §2 lists integrations under "Never"** (line 71), and §18.3 says "no suspect commits". This plan reverses both, so those lines are rewritten, not worked around.

## 3. Connecting GitHub

Sentry uses a **GitHub App**: a JWT signed with the app's private key buys an installation token that lasts an hour. Self-hosted Sentry asks you to create your own app, and Zentry does the same.

**Creating the app** (by hand, once, on github.com):

- A **private** app, so only your account can install it.
- Permissions: **Contents: read** and **Metadata: read** for blame. **Pull requests: read** for PR links (§5).
- No webhook. Sentry's blame strategy doesn't use webhooks; it builds the commit row from the blame result. So Zentry adds no public endpoint.
- Setup URL: `{APP_URL}/settings/github`.

**Configuration:**

- `GITHUB_APP_ID` (var) and `GITHUB_APP_PRIVATE_KEY` (secret).
- The key must be PKCS#8. GitHub hands out PKCS#1, and WebCrypto imports only PKCS#8, so the README gives the one-off conversion: `openssl pkcs8 -topk8 -nocrypt -in app.pem`.
- Without these two, the GitHub settings page says the app is not configured and nothing runs. This is a feature switch, not a fallback.
- Only `src/github/` reads the key.

**Installing, safely.** GitHub's redirect to the Setup URL carries an `installation_id` that anyone could forge. Sentry checks ownership with an OAuth step; Zentry checks it more simply:

1. An owner presses "Connect GitHub". Zentry stores a random `state` against that user and sends them to `https://github.com/apps/{slug}/installations/new?state=…`.
2. GitHub sends them back to the Setup URL with `installation_id` and the same `state`. The page **POSTs** both back. Only owners may do this; the role is checked on the server.
3. The server checks the `state`. It then calls `GET /app/installations/{id}` with the app JWT, which proves that the installation belongs to this app. Since the app is private, that also proves it is your account's. Only then does it store the installation and list its repositories (`GET /installation/repositories`).

The model allows one installation per organisation.

**Tokens:**

- The JWT is RS256, signed with WebCrypto: `iat = now − 60 s` (GitHub's advice for clock drift; Sentry uses `now`), `exp = now + 10 min`, `iss = app id`.
- An installation token is minted when a job or request needs one and kept only in memory. Sentry stores it in the integration's metadata. Zentry does not, at the cost of one extra call per job. This keeps a live token out of D1 and avoids two Workers racing to refresh a shared one.

**Uninstalled app or deleted repository.** With no webhook, Zentry finds out on its next call:

- The token or blame call answers 401, 403 or 404.
- Sentry treats these as final, never as a reason to retry, and Zentry does the same: the outcome is `github_refused`, and it is logged.
- The settings page shows the last such refusal, so a broken connection is visible.

## 4. Storage (migration `0010_suspect_commits.sql`)

These are cut-down copies of Sentry's models.

| Table                   | Copies                                    | Columns                                                                                                                                                         |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_installations`  | `Integration` + `OrganizationIntegration` | organization_id (PK), installation_id, account_login, created_at                                                                                                |
| `github_install_states` | Sentry's pipeline signature               | state (PK), user_id, organization_id, expires_at                                                                                                                |
| `repositories`          | `Repository`                              | id, organization_id, name (`owner/repo`), external_id, created_at; unique (organization_id, external_id)                                                        |
| `code_mappings`         | `RepositoryProjectPathConfig`             | id, project_id, repository_id (cascade), stack_root, source_root, branch (not null), created_at                                                                 |
| `commits`               | `Commit` + `CommitAuthor`                 | id, repository_id (cascade), sha, message, author_name, author_email (nullable), committed_at, pr_number, pr_title (both nullable); unique (repository_id, sha) |
| `suspect_commits`       | `GroupOwner` with type `SUSPECT_COMMIT`   | group_id (PK, cascade), commit_id (nullable, cascade), outcome, created_at                                                                                      |

Plus a migration of the `notify_outbox` CHECK constraint to add the kind `suspect_commit`.

**Why these choices:**

- **One row per issue,** written once. Sentry's blame strategy also writes one commit per issue.
- **The outcome is stored, not only the commit.** An issue already tried is never asked again, and the issue page can say why nothing was found. Sentry records these as metrics.
- **Possible outcomes:**
  - `found`;
  - the §1.1 reasons;
  - `github_refused`;
  - `event_missing`, for an event that was sampled out, aged out or unreadable. This is Zentry's own, because Sentry always has the event.
- **Deleting** a repository removes its mappings and commits. With them go the suspect rows pointing at those commits, so the issue then shows nothing instead of a dangling row. Deleting a mapping leaves suspects already found.
- **Authors are matched to users when read, by email.** Sentry stores the `user_id` when it writes the row. Zentry's users table is small, and matching on read lets a user who signs in later pick up their old commits.

## 5. When it runs

This follows Sentry: a separate retried job, run once per new issue, that never sits in an alert's path.

1. **Enqueue.** The events consumer's commit writes a `suspect_commit` outbox row next to `new_issue`, in the same D1 batch. That way it cannot be lost between the commit and a queue send.
2. **Hand off.** When the notify consumer reaches that row, it sends `{group_id}` to a new queue, `zentry-suspects`, and is done. It makes no GitHub calls itself, so alerts are not slowed.
3. **The `zentry-suspects` consumer** (batch 5, concurrency 2, `max_retries` 5 with a DLQ; Sentry retries 5 times) runs `src/suspects/handler.ts`:
   1. If a `suspect_commits` row exists, stop, because a redelivery must not ask GitHub twice. Stop too if the org has no installation or the project has no mappings, writing no row.
   2. Read the issue's latest event from R2. The job runs seconds after the issue is created, so this is almost always the event that created it. A null event gives `event_missing`.
   3. Run §1.1.
      - The pure parts (frame selection, mapping, ordering, choice) live in `src/core/suspect-commits.ts`, with Sentry's test cases ported.
      - The GitHub calls live in `src/github/`, each with a 10-second `AbortSignal` timeout.
      - Before blaming, check `rateLimit.remaining`. Below 200, retry later (Sentry's `MINIMUM_REQUESTS`).
   4. **PR link.** Sentry finds the PR in a table its webhooks fill. Zentry has no webhooks, so it makes one call, `GET /repos/{r}/commits/{sha}/pulls`. It keeps the PR only when exactly one merged PR comes back, the same rule Sentry uses for PR comments.
   5. Store the commit and the outcome.
   - **GitHub errors:**
     - A timeout, a 5xx, a 429 or a GraphQL `RATE_LIMITED` throws, so the queue retries.
     - 401, 403 and 404 are final (§3).
     - A GraphQL reply with `errors` and no `data` throws.
     - After the last retry, the message goes to the DLQ. No row is written, and the failure is logged as `suspect commit failed`.

**How alerts pick it up.** Composing an alert reads `suspect_commits` and shows the commit if one is there. When the job hasn't finished, the alert simply has no suspect line. This is the Sentry behaviour. It is not a fallback, because nothing failed.

**The catch** is that a new issue's first push usually goes out within a second or two, before the job finishes, so the push would rarely carry the line. Open question 2 asks whether the push should wait.

**Regressions** don't run the job again. They reuse the row, as Sentry does.

**Domains.**

- New domains: `github` (imports `shared` only) and `suspects` (imports `shared`, `core`, `db`, `blobs`). Both are added to `DOMAINS` in `oxlint.config.ts` and to DESIGN.md §16.3.
- `api` reaches GitHub (installing, listing repositories) through a function wired into its deps from `worker.ts`, the way `notify` reaches Workers AI.

## 6. Where it shows

Every line below is a fact Zentry read from GitHub, never model text. This is the same rule `factsLine` follows.

- **Push** (summary and plain alike): a last line such as `Suspect: a1b2c3d Switch Makro client to HttpClientFactory · Keegan`.
  - The line is clipped on its own to 80 characters. The text above it gives way to keep the body within `MAX_BODY`, so the commit line is never cut mid-sha.
  - A collapsed notification still shows the summary; expanding it shows the commit.
- **Email:** a "Suspect commit" row in `factRows` (`src/core/email-alert.ts:84`) with the subject, the short sha linked to GitHub, and the author.
- **Web issue page:** a "Suspect commit" `side-block` in `detail-side` (`ui/src/pages/issue-detail.tsx:179`), laid out like Sentry's `commitRow`:
  - the message's first line, linked to the PR or the commit;
  - the author, or "You";
  - "committed `abc1234`" and how long ago;
  - "Not a member" when the email matches no user.
  - When the outcome is not `found`, owners see why in a small grey line, such as "No in-app frame matched a code mapping". Only owners can fix mappings, so members see nothing.
- **Mobile issue screen:** a card after `IssueActions` (`mobile/src/screens/issue/screen.tsx`). Tapping it opens the PR or the commit. This is a mobile change, so it ships as an OTA update once pushed to main.
- **API:** `GET /api/0/projects/{org}/{project}/events/{event_id}/committers/` with Sentry's shape (§1.3). It opens to device tokens with `app()` so the mobile app can call it.

## 7. Phases

0. **Spike, first result (2026-11-21).** A real Buck Cheap event (GeeWiz 403) has in-app frames with `function` and `package` (the assembly) only. `filename`, `absPath` and `lineno` are all null, so blame has nothing to work with. The cause is in `Buck Cheap/API/Dockerfile.multiarch`: `dotnet publish … -p:DebugSymbols=false -p:DebugType=None` followed by `find … -name '*.pdb' -delete`. Without a PDB, .NET cannot say which file or line a frame came from.
   - **The fix is in Buck Cheap, not Zentry:** publish with `-p:DebugType=embedded`, which puts the PDB inside each DLL, and drop the `find … -delete`. The Sentry SDK then sends paths such as `/repo/Retailers/ProductFetchers/Fetchers/GeeWiz/GeeWizProductFetcher.cs` with line numbers. One mapping then covers everything: stack root `/repo/`, source root `API/` (the Docker build context is the repo's `API/` folder), branch `main`.
   - **Side benefit:** line numbers and file names on every Buck Cheap stack trace in Zentry, whether or not this feature is built.
   - **Still to check after that deploy:** that a new event carries `absPath` and `lineno`.
   - **Another mismatch:** the event's assemblies are `Core` and `DataAccess`, while the repo's projects are now `Retailers`, `Modules` and the others. Production may be running older code than `main`. Blame reads `main`, so lines can drift until production catches up. This is Sentry's quirk too (§1.1).
   - The event's release is `1.0.0`, the assembly version. Blame doesn't need releases, but setting the SDK's `Release` to the git SHA would make releases useful later.

   **Original spike plan** (half a day; no code kept).
   - Look at what three real .NET events carry in `filename` and `absPath`. Production data has to come from you: export an event's JSON from the issue page.
   - Run one GraphQL blame query by hand.
   - **Stop and rethink if the frames hold bare file names.** Nothing could be mapped. The way out would be the SDK's source-path settings, or matching file names against the repo tree. The second is a bigger, fuzzier design.

1. **Connection and mappings:**
   - the `github/` domain: JWT, installation token, verified install flow, repository list;
   - the migration;
   - settings: the GitHub page, plus code mappings per project (repository, stack root, source root, branch);
   - Sentry's mapping tests, ported.
2. **Finding the commit:**
   - the outbox kind, the queue and `suspects/`;
   - `core/suspect-commits.ts`;
   - the issue-page block and the API;
   - integration tests with a fake GitHub, in the style of the push tests:
     - each outcome;
     - a redelivery makes no second call;
     - 429 and 5xx retry;
     - 404 is final;
     - GraphQL partial nulls.
3. **Push, email and mobile.**

## 8. Not in this plan

- **Derived code mappings** (Sentry's `auto_source_code_config`). Worth doing if hand-entered mappings prove fiddly.
- **The release strategy and `set-commits`.** These need releases as a real model.
- **Resolving issues from "Fixes API-48" in commit messages** (`utils/groupreference.py`). This needs push webhooks or releases.
- **The PR comment listing the issues a merged PR caused.** This needs **Pull requests: write** and a public webhook.
- **Giving the AI summary the commit message.** It would improve the summary, but it mixes model text with a Zentry fact, and the eval would need rerunning first.
- **GitLab and Bitbucket.**

## 9. Open questions

1. **GitHub App or a fine-grained token?**
   - A personal access token with Contents: read on chosen repos is simpler: one secret, no install flow, no JWT.
   - But it is tied to your account, lives until it expires, and is not what Sentry does.
   - Recommendation: **the GitHub App**, with the verified install in §3.
2. **Should a new issue's push wait for its suspect commit?** Sentry doesn't wait, so most first pushes would lack the line.
   - The choices:
     - **(a) Don't wait**, like Sentry.
     - **(b) Wait up to 30 seconds** while the job is pending, using `SendDeferred`, then send with whatever is stored. Email never waits.
   - Option (b) gives a push without the line after the deadline. That is close to the fallback the house rule forbids, so it is yours to decide.
   - Recommendation: **(b)**, because the push is where you wanted it.
3. **One real .NET event's JSON** for the Phase 0 spike.
