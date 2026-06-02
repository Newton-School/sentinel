# Meeting Transcript Experiment — Full Writeup

This document captures everything we tried to solve a single problem: **make Google Meet transcripts accessible to Sentinel**. It lists every approach attempted, what worked, what failed, why, and what the final working solution looks like.

---

## The problem

Google Meet transcripts are saved to the **meeting organizer's** Google Drive by default. Even when `sentinel@newtonschool.co` is invited to a meeting via the calendar, the transcript never ends up in Sentinel's Drive. Sentinel cannot read transcripts it's not explicitly granted access to.

This blocks the PRD v1 requirement that Sentinel answer leadership questions using meeting transcripts as evidence.

---

## Attempts tried (chronological)

### Attempt 1 — Drive-based transcript MCP server (initial)

**What we built:** `src/mcp/transcripts.ts` — searches the Sentinel account's Google Drive for transcript documents and reads them.

**What worked:** Drive search and document reading both functioned correctly.

**What failed:** Returned zero results in practice because transcripts save to the organizer's Drive, not Sentinel's. Only worked when someone manually shared a transcript Doc with `sentinel@newtonschool.co`.

**Status:** Shipped but not sufficient on its own.

---

### Attempt 2 — Domain-wide delegation

**Idea:** Create a service account in Google Cloud with domain-wide delegation. Let Sentinel impersonate any user in the Newton School org to read their Drive files.

**What failed:** Requires Google Workspace admin access to configure in `admin.google.com`. User did not have admin access.

**Status:** Abandoned.

---

### Attempt 3 — Shared Drive for transcripts

**Idea:** Create a shared Google Drive, add `sentinel@newtonschool.co` as a viewer, configure Google Meet to save all transcripts there.

**Status:** Mentioned but not attempted.

---

### Attempt 4 — Google Meet REST API v2

**What we built:** `src/mcp/meet.ts` — uses Meet API v2 endpoints (`conferenceRecords.list`, `transcripts.list`, `transcripts.entries.list`) to fetch transcripts natively from Google.

**Setup required:**
1. Enable the **Google Meet REST API** in Google Cloud Console
2. Add scope `https://www.googleapis.com/auth/meetings.space.readonly` to OAuth consent screen
3. Re-run `scripts/google-auth.js` to get a refresh token with the new scope
4. Update `GOOGLE_REFRESH_TOKEN` in `.env`

**Hiccup 1:** The user tried visiting the scope URL directly (`https://www.googleapis.com/auth/meetings.space.readonly`) in a browser and got a "legacy API" error page. The error was misleading — scope URLs are identifiers, not visitable pages.

**Hiccup 2:** When trying to add the scope via "Add or Remove Scopes" UI in OAuth consent screen, `meetings.space.readonly` wasn't listed in the filtered results even with Meet API enabled. Had to paste the full URL into the "Manually add scopes" box at the bottom of the panel.

**What failed on first call:** Meet API returned zero conference records for `sentinel@newtonschool.co`, even though we had a calendar event with a Meet link and Sentinel was invited.

**Root cause discovered:** Meet API v2 only returns conference records for meetings the authenticated account **actually joined as a live participant**. Being on the calendar invite is not enough. The account needs to be physically in the Meet call, rendered as a participant, for Google to create a conference record from its perspective.

**Status:** Technically correct integration, but unusable unless Sentinel actually joins calls.

---

### Attempt 5 — Admin policy to auto-share transcripts with participants

**Idea:** Ask Workspace admin to enable "Share transcripts with all meeting participants" under Meet settings. Google emails the transcript link to all invitees, so Sentinel's Gmail MCP can find it.

**Status:** Mentioned but not actually configured.

---

### Attempt 6 — Auto-join bot (main effort)

**Goal:** Have Sentinel automatically join every Meet call it's invited to, as a real authenticated participant. Once in the call, the Meet API from Attempt 4 would work.

#### Attempt 6a — Playwright with bundled Chromium

**What we built:** `src/meet-bot/joiner.ts` and `src/meet-bot/setup.ts` using Playwright's bundled Chromium.

**Flow:**
1. Run `npm run meet-bot:setup` — opens Chromium, user logs in manually once, profile saved to `./data/sentinel-chrome-profile`
2. Run `npm run meet-bot:join <meet-url>` — headless/headed Chromium uses the saved profile to auto-join

**Hiccup 1: Stale SingletonLock files**
- Playwright's first launch after setup failed with `Failed to create a ProcessSingleton for your profile directory`
- Cause: the setup Chromium didn't close cleanly, leaving `SingletonLock`, `SingletonCookie`, `SingletonSocket` files in the profile directory
- Fix: added automatic cleanup of lock files at the start of each `joiner.ts` run

**Hiccup 2: "Ask to join" button was disabled**
- Bot found the button but it was disabled; `locator.click` timed out after 30s
- Cause 1: No one else was in the meeting yet — Google disables the join button when no participants are present
- Cause 2: The bot wasn't signed in, so Meet showed the guest flow and required a name first
- Fix: 
  - Added guest-name input detection and fallback — fills the name "Sentinel" if present
  - Added explicit wait for `button.isEnabled` before clicking
  - Asked user to be in the call before testing

**Hiccup 3 (the big one): Bot joined as GUEST, not as authenticated account**
- When the bot finally joined, Meet's participant list showed "Sentinel" as a guest, not `sentinel@newtonschool.co`
- Cause: **Google detects Playwright's bundled Chromium as automation** (`--disable-blink-features=AutomationControlled` isn't enough). Even though we signed in manually during setup, Google invalidated the session when the automated browser tried to use it
- The profile still had cookies and was "logged in" to Chromium, but Google's server rejected the automated session
- This defeated the entire purpose — a guest "Sentinel" has no conference record in the Meet API

#### Attempt 6b — Playwright with real Google Chrome (`channel: 'chrome'`)

**Change:** Switched Playwright from bundled Chromium to the user's installed Google Chrome app via `channel: "chrome"`. Google is noticeably less aggressive with real Chrome binaries than Chromium.

**Hiccup 4: Chrome crashed**
- First launch with real Chrome crashed the browser (and any other Chrome tabs the user had open)
- Cause: profile conflicts / Chrome's safety checks
- Fix: killed all Chrome processes, cleaned locks, restarted

**Hiccup 5: Chrome database LOCK errors**
- Chrome launch hung for 60+ seconds, produced many `Failed to open database ... LOCK` errors
- Cause: The profile's LevelDB files (`LOCK` files nested inside `GCM Store/`, `Default/`, `Profile 1/` etc.) were held by zombie processes
- Fix:
  - Extended `cleanProfileLocks()` to walk the entire profile directory recursively, removing all `LOCK` and `Singleton*` files
  - Raised Chrome launch timeout to 60s

**Hiccup 6: Premature meeting end detection**
- Bot joined successfully but then immediately logged "Detected meeting end via: button:has-text('Return to home screen')" and exited
- Cause: The "Return to home screen" button appeared on the Meet lobby / pre-call page during the "Ask to join" wait, not just after the meeting ended
- Fix: rewrote `waitForMeetingEnd()` to require BOTH:
  - Leave Call button is NOT visible
  - An explicit end message ("You left", "meeting has ended") IS visible

**Result: SUCCESS.** Bot joined the Meet as authenticated `sentinel@newtonschool.co`. User confirmed via participant list.

---

### Attempt 7 — Meet MCP OAuth fix

**Symptom:** With the bot successfully joining meetings, the Meet API was expected to return conference records. But `meet_list_conferences` failed with `invalid_client`.

**Diagnosis:**
1. Wrote `scripts/test-oauth.js` to directly verify `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` against Google's token endpoint
2. Test script succeeded — all three credentials were valid, and the token had all 5 expected scopes including `meetings.space.readonly`
3. Conclusion: the credentials were fine; the issue was in how the `googleapis` library's `refreshAccessToken()` method was being called

**Fix:** Replaced the `googleapis.OAuth2.refreshAccessToken()` call with a direct fetch to `https://oauth2.googleapis.com/token` (matching the pattern that worked in the diagnostic script). Added access token caching to avoid refreshing on every API call.

**Result: SUCCESS.** Meet API returned the conference record. `meet_get_transcript_entries` returned all 4 transcript entries including the "yellow tennis ball" verification keyword.

---

## Final working architecture

```
┌─────────────────────────────────────────────────────────────┐
│ User creates Meet, invites sentinel@newtonschool.co          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ npm run meet-bot:join <url>                                  │
│                                                              │
│  1. Clean LOCK/Singleton files in profile dir                │
│  2. Launch real Chrome (not Chromium) with persistent        │
│     profile containing sentinel@ session cookies             │
│  3. Navigate to Meet URL                                     │
│  4. Turn off mic + camera                                    │
│  5. Fill guest name (fallback) and click "Join now" /        │
│     "Ask to join"                                            │
│  6. Verify join by checking Leave Call button visibility     │
│  7. Stay in call, polling Leave button every 15s             │
│  8. Exit when Leave button disappears AND end message shows  │
└────────────────────┬────────────────────────────────────────┘
                     │  (user enables transcription in the call)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Meeting ends → Google generates transcript (~5-10 min)       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Founder asks Sentinel in Slack: "What did we discuss?"      │
│                                                              │
│  Claude → meet_list_conferences → meet_list_transcripts →    │
│  meet_get_transcript_entries → returns structured data       │
│  (speaker ID, start/end timestamps, text per entry)          │
└─────────────────────────────────────────────────────────────┘
```

**End-to-end verified April 21, 2026:** Bot joined as authenticated Sentinel, user spoke the phrase "yellow tennis ball" into the meeting, Meet API returned the transcript containing that exact phrase.

> **Stay-mode note (current behavior):** the diagram above shows the original
> *stay-until-end* flow (steps 7–8: stay in the call, poll the Leave button, exit when the
> meeting ends). The joiner later gained a `--stay-mode` flag with three modes —
> `leave-after-join` (join → enable transcription → leave immediately; the memory-saving
> joiner-CLI default), `stay-until-end` (the legacy flow shown here), and `hybrid`. **In
> production the watcher hardcodes `--stay-mode stay-until-end`** (the PR #17 revert —
> intentional), so the live bot stays for the full call; `leave-after-join` is available
> only when invoking `npm run meet-bot:join` by hand. Because transcription is server-side,
> either mode yields the same transcript via the Meet API. See `src/meet-bot/modeDispatch.ts`
> and `src/meet-bot/watcher.ts`.

---

## Key learnings

1. **Meet API requires actual participation.** Being a calendar invitee is not enough. The account must be physically in the call for Google to create a conference record from its perspective.

2. **Playwright's bundled Chromium fails Google authentication.** Google detects it as automation and invalidates sessions even when cookies are valid. Real Chrome via `channel: "chrome"` works.

3. **Chrome profiles are fragile.** Each launch/crash leaves LOCK files in `Default/`, `Profile 1/`, `GCM Store/`, etc. Always clean these before launch.

4. **`googleapis.refreshAccessToken()` is unreliable.** Produces `invalid_client` errors even with valid credentials. Direct fetch against `oauth2.googleapis.com/token` is more stable.

5. **Meet lobby UI has misleading signals.** "Return to home screen" button appears during lobby wait, not just after meeting ends. Joining detection must be strict (require BOTH "Leave button gone" AND "end message visible").

6. **Google scope management is awkward.** Newer scopes like `meetings.space.readonly` don't auto-appear in the OAuth consent screen's scope picker — must paste the full URL into the "Manually add scopes" box.

7. **Test OAuth credentials in isolation first.** The 15-line `scripts/test-oauth.js` script immediately revealed whether the credentials themselves were the issue or the client library was the problem.

---

## What's still missing for production

> **Update:** item 1 below (the calendar watcher) has since been **built** —
> `src/meet-bot/watcher.ts` polls the calendar every **60s** (not 5 min) and spawns a
> detached joiner per eligible meeting. It is started automatically by `npm start`. The
> remaining items (2–6) are still open. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) and
> [`TODO.md`](../TODO.md).

1. **Calendar watcher.** ~~Currently the bot is invoked manually with a Meet URL.~~
   **DONE** — `src/meet-bot/watcher.ts` polls Google Calendar every 60s, filters eligible
   events (via `eventFilter.ts`/`meetUrl.ts`), and auto-launches a detached joiner. The
   manual `npm run meet-bot:join <url>` path still exists for one-off joins.

2. **K8s deployment.** Running real Chrome in a container requires additional setup:
   - Install Chrome in the Docker image (or use a Chrome base image)
   - Provide a virtual display (`Xvfb`) since the pod has no desktop
   - Mount persistent volume for the profile directory
   - Handle Chrome's memory usage (real Chrome uses significantly more RAM than Chromium)

3. **Session refresh automation.** The Chrome profile session expires periodically. Currently requires manual re-run of `npm run meet-bot:setup`. A detector + alert + maybe a slash command like `/sentinel:relogin` would help.

4. **Error recovery.** Bot should retry on transient failures (Chrome crashed, meeting hasn't started yet, "Ask to join" pending admission).

5. **Transcription must be enabled by the organizer.** The bot joining doesn't force transcription on. If no one enables transcript in the call, there's nothing for the Meet API to return. Consider either a) requiring organizers to enable it, or b) falling back to audio capture + Whisper STT if transcription isn't on.

6. **Meeting code → space ID mapping.** Meet API v2 doesn't expose the human-readable meeting code (`qak-quia-esd`) — it uses internal IDs (`spaces/W3r3LhsgcfUB`). This makes verifying "is this the right conference?" heuristic. We infer via recency.

---

## Files touched

| File | Purpose |
|---|---|
| `src/mcp/meet.ts` | Google Meet API v2 MCP server (4 tools) |
| `src/meet-bot/meetUrl.ts` | URL parsing utilities |
| `src/meet-bot/setup.ts` | One-time manual-login setup script |
| `src/meet-bot/joiner.ts` | Main **Playwright** (real Chrome via `channel: 'chrome'`) bot that joins calls |
| `scripts/google-auth.js` | OAuth flow to obtain refresh token with all scopes |
| `scripts/test-oauth.js` | Diagnostic script for verifying OAuth credentials |
| `src/claude/mcpConfig.ts` | Registers `google-meet` MCP server |
| `src/claude/systemPrompt.ts` | Instructs Claude to prefer Meet API over Drive transcripts |
| `tests/meetBot.test.ts` | URL parsing tests |

---

## Commits / PRs for this experiment

- [PR #11](https://github.com/Newton-School/sentinel/pull/11) — Initial Meet API MCP integration
- [PR #12](https://github.com/Newton-School/sentinel/pull/12) — Playwright Meet bot Phase 1 (standalone joiner)
- [PR #13](https://github.com/Newton-School/sentinel/pull/13) — Meet MCP OAuth fix + Meet bot polish
