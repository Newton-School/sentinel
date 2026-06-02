# Sentinel — Engineering Backlog

> Generated 2026-06-02 from a full codebase audit (10-subsystem parallel map +
> adversarial verification). Each P0 below was re-verified by hand against the
> source. See `ARCHITECTURE.md` for the current-state map.
>
> Status snapshot at audit time: build clean (`tsc --noEmit`), 150/150 tests
> green, 1 open PR (#18 memory monitor), local `main` 1 behind `origin/main`,
> 10 local feature branches fully merged and safe to delete.

Priority key: **P0** correctness/security/deploy-blocker · **P1** important gap ·
**P2** quality/tech-debt · **P3** nice-to-have. Effort: S/M/L.

---

## P0 — correctness, security, deploy blockers (verified by hand)

- [x] **(bug, S) Fix persona snake_case→camelCase mismatch breaking all personalization.** ✅ PR #20
  `src/persona/store.ts:14-18` and `:35-42` do `SELECT *` (columns `display_name`,
  `evidence_count`) and cast straight to the camelCase `PersonaProfile`/`PersonaTrait`
  types. For any *returning* user, `persona.displayName` and `trait.evidenceCount` are
  `undefined`, so `src/claude/systemPrompt.ts:137,149` emit *"speaking with **undefined**"*
  and *"based on undefined queries"*. The new-persona path (`store.ts:26-32`) builds a
  correct object, so it only breaks on the *second* message — invisible to a smoke test.
  Add a snake↔camel mapping layer in `store.ts`. `confidence`/`id`/`role` (single-word
  columns) are unaffected.

- [x] **(security, M) Add read-only enforcement / SQL allowlist to `metabase_query`.** ✅ PR #21
  `src/mcp/metabase.ts:82-125` forwards arbitrary native SQL to `/api/dataset` with no
  guard. Combined with `--dangerously-skip-permissions` (`src/claude/runner.ts:28`),
  read-only is *only* a soft system-prompt instruction — a prompt-injected/hallucinated
  `UPDATE`/`DROP` would execute if the warehouse account has write grants. Enforce
  read-only (statement parse/allowlist, or a read-only DB role).

- [x] **(security, M) Restrict + clean up the secret-bearing `mcp-config.json`.** ✅ PR #22
  `src/claude/mcpConfig.ts:141` writes all credentials (Metabase pw, GitHub/Notion/Slack
  tokens, Google client secret + refresh token) in plaintext to
  `/tmp/sentinel-mcp/mcp-config.json` with default world-readable perms, no `chmod 0600`,
  no cleanup, regenerated on every request. Write `mode: 0o600` and remove on shutdown;
  consider a per-spawn unique path (see torn-read item below).

- [x] **(security, S) Stop the detached Meet joiner from inheriting the full parent env.** ✅ PR #23
  `src/meet-bot/watcher.ts:153` passes `env: { ...process.env }` to the `unref()`'d joiner
  subprocess, leaking Slack/Google/Anthropic secrets into a Chromium-driving process that
  only needs the Meet URL + Google creds. Pass an explicit minimal env. (New
  `src/meet-bot/joinerEnv.ts` `buildJoinerEnv()` — non-secret allowlist; joiner auths via
  the persistent Chrome profile, not env.)

- [x] **(bug, S) Guard the Metabase 401 re-auth path.** ✅ PR #24
  `src/mcp/metabase.ts:53-66` does `return retry.json()` without checking `retry.ok`; a
  still-failing re-auth returns the error body as data, then crashes downstream on
  `result.data.cols`. Check `retry.ok` and surface auth failure as an error. (Auth/fetch
  extracted to new side-effect-free `src/mcp/metabaseClient.ts` `createMetabaseClient()` for
  testability; retry now throws on `!retry.ok`.)

- [x] **(infra, M) Install Chrome + Playwright deps in the Dockerfile.** ✅ PR #25
  `joiner.ts:105-107` uses `chromium.launchPersistentContext(..., { channel: "chrome" })`
  (real Chrome binary required), but the `node:20-alpine` `Dockerfile` installs only
  claude-code + curl. `index.ts` starts the Meet watcher on boot, so the deployed
  container can't run its largest feature. Add Chrome/Chromium (+ `npx playwright install`)
  and a display if needed, or split the Meet bot into its own image. (Runtime stage now
  `mcr.microsoft.com/playwright:v1.59.1-jammy` + `npx playwright install --with-deps chrome`;
  image not yet built/verified locally — Docker daemon was down — and still runs as root,
  see the separate non-root P2 item.)

- [x] **(infra, M) Create the missing `k8s/` manifests referenced by CI.** ✅ PR #27
  `buildspec.yml:41` packages `k8s/**/*` as a deploy artifact, but no `k8s/` directory
  exists — the artifact is empty and any K8s apply has nothing to deploy. Add the
  Deployment/Service/etc. manifests (deploy target is K8s + ECR per project notes).
  (Added `k8s/{deployment,service,pvc,configmap,secret.example}.yaml` + README: 1 replica,
  Recreate strategy, RWO PVC at `/app/data`, `/health`+`/ready` probes, placeholder secret;
  `image: PLACEHOLDER_IMAGE_URI` substituted at deploy from `imageDetail.json`. The actual
  deploy job that runs the substitution lives outside this repo.)

## P1 — important gaps

- [x] **(bug, S) Warn/fail at startup when `ALLOWED_USER_IDS` is empty.** ✅ PR #26
  `src/config.ts:35-37` transforms an empty/whitespace value to `[]` with no `.nonempty()`
  check; `isAllowed()` (`socketClient.ts:108-109`) then returns false for *everyone* with
  no warning — silently bricks the bot. (Added a `.refine(arr.length > 0)` so an empty
  allowlist now fails validation at startup. `envSchema` is now exported + tested directly.)

- [x] **(bug, S) Add all-or-none cross-field validation for Google OAuth creds.** ✅ PR #26
  `src/config.ts` treats `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` as independently optional;
  a partial set passes validation and only fails at runtime. Add a Zod `.refine`. (Object-level
  `.refine`: the three Google vars must be all-set or all-unset.)

- [x] **(bug, M) Graceful shutdown for the Slack app + Meet watcher on SIGINT/SIGTERM.** ✅ PR #28
  `src/index.ts` shutdown only calls `closeDb()`; in-flight requests aren't drained, the
  Slack app isn't stopped, and the watcher/detached joiners aren't stopped — abrupt kill
  under K8s. (New side-effect-free `src/shutdown.ts` `createGracefulShutdown()`: stop watcher
  loop → stop Slack app → drain in-flight (≤25s) → close health server → closeDb → exit;
  `startMeetWatcher()` now returns a `stop()`. Detached joiners intentionally left running.)

- [x] **(bug, S) Make `getOrCreatePersona`/`upsertTrait` race-safe.** ✅ PR #30
  `src/persona/store.ts` uses check-then-insert with no `ON CONFLICT`; concurrent first-time
  inserts (or a duplicate trait under `UNIQUE(user_id,label,value)`) throw on the constraint.
  Use `INSERT … ON CONFLICT DO UPDATE`. (persona: `ON CONFLICT(user_id) DO NOTHING` + read-back
  through the mapping layer; trait: single `ON CONFLICT DO UPDATE` preserving the confidence math.)

- [x] **(bug, M) Fix Gmail body extraction for nested multipart parts.** ✅ PR #29
  `src/mcp/gmail.ts` only inspects top-level `parts`; `text/plain` nested inside
  `multipart/alternative`/`mixed` is missed, so many threads return an empty body. Recurse.
  (New `src/mcp/gmailBody.ts` `extractPlainTextBody()` — depth-first recursion + base64url
  decode; HTML-only messages still return empty, no html fallback yet.)

- [x] **(bug, M) Resolve Meet transcript speaker resource names to human names.** ✅ PR #31
  `src/mcp/meet.ts` `meet_get_transcript_entries` returns raw
  `conferenceRecords/x/participants/y` as the speaker. Resolve via the participants
  endpoint (with a cache). (New pure `src/mcp/participantName.ts` + `resolveParticipantName`
  with an in-process cache; raw id retained as `participant`/`speakerId`.)

- [ ] **(docs, M) Reconcile README/PLAN/CLAUDE.md data-sources + directory tree with reality.**
  They describe only Metabase+GitHub+Notion and list non-existent `src/mcp/github.ts` /
  `notion.ts`; actual `src/mcp/` is metabase/slack/gmail/calendar/meet/transcripts (GitHub
  & Notion are npx packages; Notion is `@notionhq/notion-mcp-server`, not
  `@modelcontextprotocol/server-notion`). (`ARCHITECTURE.md` already documents the truth.)

- [ ] **(docs, M) Document the Meet bot, calendar watcher, health server, and audit log.**
  The largest feature (`src/meet-bot/`) and `meet-bot:setup`/`join` scripts are undocumented
  in README/PLAN/CLAUDE.md; `PLAN.md` still lists the health check as "deferred to v2" though
  `src/health/server.ts` ships `/health` + `/ready`. The `query_log` audit columns are also
  undocumented.

- [ ] **(docs, S) Reconcile `.env.example` Google OAuth scope list with `scripts/google-auth.js`.**
  `.env.example` lists only gmail/calendar/drive readonly; `google-auth.js` requests
  `documents.readonly` + `meetings.space.readonly` too (the latter required by `meet.ts`).
  A token minted from the stale list lacks the Meet scope.

- [ ] **(docs, S) Resolve PRD's Jira-as-v1 claim and "no scheduled jobs" framing.**
  `SENTINEL_PRD_V1.md` lists Jira as a confirmed v1 source (no connector exists in `src/`)
  and frames Sentinel as having no proactive jobs, yet `watcher.ts` now polls calendar every
  60s and auto-launches the bot. Mark Jira not-in-v1 (or build it) and update the framing.

- [x] **(test, M) Test the *real* config loader instead of a re-declared copy.** ✅ PR #32
  `tests/config.test.ts:4-32` replicates the Zod schema (to dodge `config.ts`'s import-time
  `process.exit`) and has already drifted — it omits `HEALTH_CHECK_PORT` (`config.ts:31`).
  Refactor `loadConfig()` so the schema is importable without side effects, then test the
  real module incl. the exit path. (Exported `loadConfig`; `config.test.ts` rewritten to import
  the real module + test the exit path via mocked `process.exit`; re-declared copy removed.)

- [x] **(test, M) Add unit tests for the Claude subprocess runner (`runner.ts`).** ✅ PR #33
  Arg construction, thread-context prefixing, 120s timeout, success path, and
  non-zero-exit/spawn-error rejection are untested. Mock `child_process.spawn`. (Done — and the
  tests surfaced a real bug: the timeout timer was never `clearTimeout`'d on close/error,
  firing `kill` on the exited process; fixed in the same PR.)

- [x] **(test, M) Add unit tests for `socketClient.ts` + `threadContext.ts`.** ✅ PR #34
  Event routing (`app_mention`/DM/slash), the `isAllowed` authorization gate, mention
  stripping, DM subtype filtering, slash ACK/post, and the 50-reply truncation are untested
  — and authorization is security-relevant. (Extracted pure helpers + handler-level tests via a
  faked Bolt App. Note: the 50-cap is request-side only — see the pagination P2 item.)

- [x] **(test, S) Add persona-store CRUD + confidence-math tests (`store.ts`).** ✅ PR #30
  Currently only mocked (`auditLog.test.ts`). A real test against an in-memory DB would have
  caught the camelCase bug. Cover the 0.15→0.95 growth, the 0.5 seed, `evidence_count`
  increment, and the row round-trip. (Covered by `tests/personaStoreRace.test.ts`: idempotent
  create + null-role/equal-timestamps + no-overwrite round-trip, seed 0.5/1, 0.575→0.63875
  growth, 0.95 ceiling, lost-race duplicate inserts.)

- [x] **(test, L) Add handler-level tests for the six custom MCP servers.** ✅ PR #36
  `metabase/slack/gmail/calendar/meet/transcripts` (~1240 LOC) have zero direct tests; only
  `mcpConfig` registration is covered. Mock `fetch`/`googleapis`. (Strict-TDD mandate.)
  (Extracted a pure `*Shape`/`*Lib` helper per server — `metabaseShape`, `slackShape`, `gmailList`,
  `calendarWeek`, `meetShape`, `transcriptsQuery` — and tested them; +77 tests. Server `main()`/
  startup deliberately untouched. Characterized the calendar local-time week bug — see below.)

- [x] **(test, M) Test the Meet watcher poll loop + joiner arg/env construction.** ✅ PR #35
  `watcher.ts` (polling, OAuth setup, event mapping, 4h TTL purge, spawn args/env) and
  `joiner.ts` (`parseArgs`, lock cleanup, join/transcribe/leave) are untested despite active
  churn (PRs #14-17). (Extracted `buildJoinerArgs`/`mapCalendarEvents`/`runOnce`/`purgeOldJoinedIds`
  + guarded joiner's top-level run behind `isMainModule()`; +26 tests covering the poll loop,
  dedup, TTL purge, arg construction, and `parseArgs` exit path.)

## P2 — quality / tech-debt

- [x] **(bug, S) Use the calendar's timezone (not local server time) for "this week" math.** ✅ PR #37
  `src/mcp/calendar.ts:49-61` computes the week window with `(getDay()+6)%7` against local
  time while emitting UTC ISO — off by up to a day on a non-UTC host. (`calendarWeek.weekWindow`
  is now tz-aware via `Intl` (two-pass DST-correct); `calendar.ts` fetches the primary calendar's
  `timeZone` — fallback `Asia/Kolkata`. Tested with IST + a DST zone.)

- [x] **(bug, M) Persist Meet-watcher join dedup so meetings aren't re-joined after restart.** ✅ PR #39
  `watcher.ts:23` `joinedAt` is an in-memory `Map` (4h TTL); a restart re-joins in-progress
  meetings, spawning a second Chromium. Persist joined event IDs (SQLite). (New `joined_meetings`
  table + race-safe `joinStore` (`markJoined`/`getJoinedIds`/`purgeJoined`); watcher uses it,
  same 4h TTL.)

- [ ] **(docs, S) Reconcile the stay-mode contradiction.**
  `modeDispatch.ts:7,29` + `joiner.ts` default to `leave-after-join` ("~60x memory"), but
  `watcher.ts:124` hardcodes `--stay-mode stay-until-end` (PR #17 revert) — production is the
  opposite of the documented default. `docs/MEET_TRANSCRIPT_EXPERIMENT.md` also still says
  Puppeteer/stay-until-end and lists the now-built calendar watcher as "missing".

- [x] **(infra, M) Build `dist` in CI and isolate test runtime state.** ✅ PR #52
  `buildspec.yml` runs `tsc --noEmit` + `npm test` but no emit build before tests; recent
  mcp-config test pollution (commit 460bb4f) shows tests touch real runtime state. Build
  dist and harden test isolation. (CI now `npm run build` (emit) before tests; new
  `vitest.config.ts`+`tests/setup.ts` redirect `SENTINEL_MCP_TMPDIR` to a throwaway dir.
  `SQLITE_DB_PATH` left to tests — they already mock config to `:memory:`.)

- [x] **(infra, S) Separate liveness vs readiness so `/health` doesn't flap to 503.** ✅ PR #38
  `slackConnected` flips true only after `app.start()` returns while the health server starts
  earlier; with `HEALTHCHECK --start-period=10s` a slow Socket Mode connect (or a transient
  SQLite blip) can trigger a restart loop. Keep degradation in `/ready` only. (`/health` is now
  pure liveness — always 200 `{status:"alive",uptime}`; all slack/db degradation moved to `/ready`.)

- [x] **(security, S) Escape Drive `q` query strings per the Drive q-grammar.** ✅ PR #40
  `src/mcp/transcripts.ts:50,52,142` interpolate with only a naive single-quote escape —
  low-grade query injection / malformed-query risk. (Added `escapeDriveQueryValue` — escapes
  backslash then quote — applied to the user `query` in `transcriptsQuery.buildSearchQuery`.)

- [x] **(security, M) Replace the regex `metabase_query` guard with a parser/AST-based check.** ✅ PR #43
  The PR #21 guard (`src/mcp/sqlReadOnly.ts`) matches keywords with regex and doesn't tokenize
  out string literals or handle a parenthesized leading `SELECT`, so it *fail-safe* false-rejects
  valid reads like `… WHERE action = 'delete'` or `(SELECT …) UNION (SELECT …)`. Use a real SQL
  parser (or a read-only DB role / Metabase permissions) so legitimate analytics queries aren't blocked.
  (Added `node-sql-parser`; AST check allows string-literal/parenthesized/UNION reads, falls back to
  the regex verdict on parse failure so it never regresses on exotic warehouse SQL.)

- [x] **(security, S) Run the deployed container as a non-root user.** ✅ PR #41
  The Dockerfile's runtime stage has no `USER` directive. Add a non-root user + adjust
  `/app/data` ownership. (Added `chown -R pwuser /app` + `USER pwuser` after the root-only
  install steps. NOTE: image not built locally — Docker daemon down — and pwuser's access to the
  apt-installed Chrome was reasoned, not empirically verified. Verify with a real `docker build`+`run`.)

- [x] **(security, S) Stop embedding raw upstream response bodies in thrown MCP errors.** ✅ PR #42
  `metabase.ts:31,69`, `slack.ts:28`, `meet.ts:41,61` put `await res.text()` into error
  messages, leaking data/identifiers into logs and the Slack-facing tool output. Redact.
  (New `redactedHttpError(prefix, res)` → status+statusText only; applied at 6 sites across
  `metabaseClient.ts`/`slack.ts`/`meet.ts`. Slack's app-level `data.error` code kept.)

- [x] **(tech-debt, M) Give each Claude spawn a unique `mcp-config.json` path.** ✅ PR #46
  After cache removal (460bb4f) the same path is rewritten per request; with
  `MAX_CONCURRENT=3` a write racing the CLI read can yield a torn JSON. Use a per-request id.
  (UUID-named config per `getMcpConfigPath()` call, 0600; `runner` removes its file after the
  spawn settles; shutdown sweeps all `mcp-config*.json`.)

- [x] **(tech-debt, M) De-duplicate Slack event retries by `messageTs`.** ✅ PR #45
  Slack re-delivers on timeout; a slow handler (Claude up to 120s) can be invoked multiple
  times for one message → duplicate runs/replies. Track processed `messageTs`. (Per-app TTL
  deduper keyed `channel:messageTs` in `socketClient`. In-process only — fine for the single-replica
  deployment; slash isn't events-retried so its dedup is best-effort.)

- [x] **(tech-debt, M) Cap concurrency + add orphan recovery for detached joiners.** ✅ PR #47
  `spawnJoiner` has no backpressure (overlapping meetings each spawn a heavy Chromium),
  detached `unref()` joiners have no kill path, and `cleanProfileLocks` deleting
  `LOCK`/`Singleton*` under a shared profile means concurrent joiners corrupt each other.
  (In-process cap `MAX_CONCURRENT_JOINERS` default 1; deferred meetings retried next poll.
  RESIDUAL: the counter resets on restart, so a pre-restart detached joiner isn't counted —
  fully closing the cross-restart window needs cross-process PID tracking. Follow-up if needed.)

- [x] **(tech-debt, M) Add pagination/cursor handling across MCP read tools.** ✅ PR #49
  `meet.ts`/`transcripts.ts` ignore `nextPageToken`; Slack/Gmail are cap-only;
  `threadContext.ts:16` truncates >50 replies and never follows the cursor. Long
  meetings/threads are silently truncated. (Generic bounded `paginate()` helper — maxItems +
  maxPages=20, reports `truncated` — applied to 10 read tools + threadContext; truncation logged;
  output shapes unchanged. `slack_search` left cap-only (page-number API returns `total`).)

- [x] **(tech-debt, M) Add request timeouts + 429/5xx retry-backoff to MCP upstream calls.** ✅ PR #50
  No `fetch`/googleapis timeouts (a hung upstream blocks a tool indefinitely) and no retry on
  any of the servers; Gmail's N+1 `messages.get` will hit rate limits noisily. (New `fetchWithRetry`
  — 15s AbortController timeout + exp backoff on 429/5xx/network, honors `Retry-After` — in
  slack/meet; per-call timeouts on the googleapis servers; Metabase timeout-only by design.)

## P3 — nice-to-have

- [x] **(feature, M) Cap/curate persona traits in the prompt + add trait decay.** ✅ PR #48
  `systemPrompt.ts:144-155` includes all traits with confidence ≥0.6 uncapped, and
  `store.ts` confidence only grows (no decay/forget) — the prompt grows unbounded and stale
  interests never down-weight. (Read-time exponential decay, 30-day half-life, no row mutation;
  `buildSystemPrompt` caps to the top 8 by decayed confidence. Reinforcement refreshes `updated_at`.)

- [ ] **(feature, M) Add a `/metrics` endpoint + per-request token/cost/tool-use accounting.**
  `runner.ts` uses `--output-format text` and discards CLI telemetry; `ClaudeResponse` is
  only `{ text, durationMs }`. Capture structured output and expose ops metrics. (A
  standalone memory monitor is in flight — PR #18.)

- [x] **(tech-debt, S) Replace module-level non-null env assertions in MCP servers with startup validation.** ✅ PR #51
  `METABASE_URL!`, `SLACK_USER_TOKEN!`, `GOOGLE_CLIENT_ID!` etc. yield `undefined` at runtime
  (e.g. `fetch('undefined/api/session')`) when a server is run directly. Validate + exit with
  a clear message. (New `findMissingEnv`/`assertEnv`; each of the 6 servers validates its required
  env at startup and exits naming the missing vars.)

- [x] **(tech-debt, S) Add `query_log` retention/pruning + a `user_id` index.** ✅ PR #44
  `query_log` growth is unbounded with no index; `sources_used` is written (`tracker.ts:103`)
  but never read back. Add retention + indexes, and either consume or drop `sources_used`.
  (`idx_query_log_user_id` + `idx_query_log_created_at`; `pruneQueryLog(90d)` run once on DB init.
  `sources_used` left as-is — out of scope.)

---

## Repo hygiene (not code — do when convenient)

- [ ] Pull `origin/main` into local `main` (1 commit behind).
- [ ] Delete the 10 fully-merged local branches: `docs/tdd-workflow`,
  `feat/{codebuild-ci,optional-api-key,optional-data-sources,prd-v1-implementation,production-readiness,sentinel-poc}`,
  `fix/{italic-conversion-removal,meeting-transcript-routing,slack-mrkdwn-formatting}`.
- [ ] Decide on open PR #18 (memory monitor) — mergeable, +372/-1, open since 2026-04-21.
