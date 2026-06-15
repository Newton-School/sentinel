/* ============================================================================
   Sentinel — technical content model. Everything the UI renders lives here so
   the views stay declarative. Derived directly from the source tree.
   ========================================================================== */

export type Accent =
  | "slack" | "core" | "claude" | "mcp" | "brain" | "meet" | "data" | "ops" | "persona";

export const ACCENT_HEX: Record<Accent, string> = {
  slack: "#38bdf8", core: "#6e95ff", claude: "#e0795a", mcp: "#2dd4a7",
  brain: "#c084fc", meet: "#fb923c", data: "#60a5fa", ops: "#94a3b8", persona: "#f472b6",
};

/* ---------- Architecture graph ---------- */
export interface GroupBox { id: string; label: string; x: number; y: number; w: number; h: number; }
export interface GraphNode {
  id: string; accent: Accent; icon: string; title: string; sub: string;
  x: number; y: number; w: number; key: string;
}
export interface Wire { from: string; to: string; flow?: boolean; }

export const GROUPS: GroupBox[] = [
  { id: "g-slack", label: "Slack · Socket Mode", x: 2, y: 1, w: 30, h: 9 },
  { id: "g-core", label: "Sentinel process · dist/index.js", x: 2, y: 12, w: 62, h: 46 },
  { id: "g-mcp", label: "MCP servers · stdio subprocesses", x: 67, y: 12, w: 31, h: 62 },
  { id: "g-poll", label: "Background pollers", x: 2, y: 60, w: 40, h: 16 },
  { id: "g-meet", label: "Meet-bot pipeline · independent", x: 2, y: 78, w: 62, h: 20 },
];

export const NODES: GraphNode[] = [
  { id: "slack-in", accent: "slack", icon: "💬", title: "User event", sub: "@mention · DM · /sentinel", x: 4, y: 3.5, w: 26, key: "slack-in" },

  { id: "socket", accent: "core", icon: "🔌", title: "socketClient.ts", sub: "authorize · dedupe · normalize", x: 4, y: 15.5, w: 27, key: "socket" },
  { id: "handle", accent: "core", icon: "⚙️", title: "handleEvent()", sub: "semaphore · reactions · orchestrate", x: 4, y: 23.5, w: 27, key: "handle" },
  { id: "thread", accent: "core", icon: "🧵", title: "threadContext.ts", sub: "fetch prior replies", x: 4, y: 31.5, w: 27, key: "thread" },
  { id: "persona", accent: "persona", icon: "🧬", title: "persona store + tracker", sub: "get persona · traits", x: 4, y: 39.5, w: 27, key: "persona" },
  { id: "recall", accent: "brain", icon: "🧠", title: "memory recall", sub: "searchMemories / assembleRetrieval", x: 34, y: 31.5, w: 28, key: "recall" },
  { id: "sysprompt", accent: "core", icon: "📝", title: "buildSystemPrompt()", sub: "persona + traits + memories", x: 34, y: 39.5, w: 28, key: "sysprompt" },
  { id: "runner", accent: "claude", icon: "🚀", title: "runner.ts → spawn", sub: "claude --print --mcp-config", x: 4, y: 47.5, w: 27, key: "runner" },
  { id: "format", accent: "core", icon: "✨", title: "formatters.ts", sub: "markdown → Slack mrkdwn", x: 34, y: 47.5, w: 28, key: "format" },

  { id: "cli", accent: "claude", icon: "🤖", title: "Claude CLI subprocess", sub: "agentic tool loop · 120s", x: 34, y: 15.5, w: 28, key: "cli" },

  { id: "mcp-metabase", accent: "mcp", icon: "📊", title: "metabase", sub: "SQL · read-only AST", x: 69, y: 15, w: 27, key: "mcp-metabase" },
  { id: "mcp-github", accent: "mcp", icon: "🐙", title: "github (npx)", sub: "PRs · issues · repos", x: 69, y: 20.5, w: 27, key: "mcp-github" },
  { id: "mcp-notion", accent: "mcp", icon: "📔", title: "notion (npx)", sub: "docs · roadmaps", x: 69, y: 26, w: 27, key: "mcp-notion" },
  { id: "mcp-slack", accent: "mcp", icon: "🔍", title: "slack-search", sub: "search · history · thread", x: 69, y: 31.5, w: 27, key: "mcp-slack" },
  { id: "mcp-gmail", accent: "mcp", icon: "✉️", title: "gmail", sub: "search · thread · recent", x: 69, y: 37, w: 27, key: "mcp-gmail" },
  { id: "mcp-cal", accent: "mcp", icon: "📅", title: "google-calendar", sub: "events · search", x: 69, y: 42.5, w: 27, key: "mcp-cal" },
  { id: "mcp-tr", accent: "mcp", icon: "📄", title: "meeting-transcripts", sub: "Drive Docs", x: 69, y: 48, w: 27, key: "mcp-tr" },
  { id: "mcp-meet", accent: "mcp", icon: "🎥", title: "google-meet", sub: "Meet API v2 entries", x: 69, y: 53.5, w: 27, key: "mcp-meet" },
  { id: "mcp-mem", accent: "brain", icon: "🧠", title: "memory", sub: "memory_* · entity_* · digests", x: 69, y: 59, w: 27, key: "mcp-mem" },

  { id: "db", accent: "data", icon: "🗄️", title: "sentinel.db · SQLite/WAL", sub: "13 tables", x: 44, y: 64, w: 21, key: "db" },

  { id: "ingest", accent: "brain", icon: "⏱️", title: "ingestWatcher", sub: "5 min · meet/gmail/slack", x: 4, y: 63.5, w: 24, key: "ingest" },
  { id: "consol", accent: "brain", icon: "🧱", title: "consolidationWatcher", sub: "30 min · dossiers + embeddings", x: 4, y: 69.5, w: 24, key: "consol" },
  { id: "hook", accent: "brain", icon: "🪝", title: "conversationHook", sub: "fire-and-forget", x: 30, y: 63.5, w: 12, key: "hook" },

  { id: "watcher", accent: "meet", icon: "📡", title: "watcher.ts", sub: "poll calendar /60s", x: 4, y: 81, w: 18, key: "watcher" },
  { id: "joiner", accent: "meet", icon: "🎭", title: "joiner.ts · Playwright", sub: "detached Chrome · join", x: 24, y: 81, w: 20, key: "joiner" },
  { id: "gmeet", accent: "meet", icon: "🟢", title: "Google Meet web", sub: "server-side transcription", x: 46, y: 81, w: 16, key: "gmeet" },
  { id: "health", accent: "ops", icon: "❤️", title: "health server", sub: "/health /ready /metrics :8930", x: 4, y: 88.5, w: 18, key: "health" },
];

export const WIRES: Wire[] = [
  { from: "slack-in", to: "socket", flow: true }, { from: "socket", to: "handle", flow: true },
  { from: "handle", to: "thread", flow: true }, { from: "handle", to: "persona", flow: true },
  { from: "handle", to: "recall", flow: true }, { from: "recall", to: "sysprompt", flow: true },
  { from: "persona", to: "sysprompt", flow: true },
  { from: "handle", to: "runner", flow: true }, { from: "sysprompt", to: "runner", flow: true },
  { from: "runner", to: "cli", flow: true },
  { from: "cli", to: "mcp-metabase" }, { from: "cli", to: "mcp-github" }, { from: "cli", to: "mcp-notion" },
  { from: "cli", to: "mcp-slack" }, { from: "cli", to: "mcp-gmail" }, { from: "cli", to: "mcp-cal" },
  { from: "cli", to: "mcp-tr" }, { from: "cli", to: "mcp-meet" }, { from: "cli", to: "mcp-mem" },
  { from: "cli", to: "format", flow: true }, { from: "format", to: "slack-in", flow: true },
  { from: "recall", to: "db" }, { from: "persona", to: "db" }, { from: "mcp-mem", to: "db" },
  { from: "ingest", to: "db" }, { from: "consol", to: "db" }, { from: "hook", to: "db" },
  { from: "watcher", to: "joiner" }, { from: "joiner", to: "gmeet" },
  { from: "gmeet", to: "mcp-meet" }, { from: "gmeet", to: "mcp-tr" },
];

/* ---------- Node detail (drawer) ---------- */
export interface NodeDetail {
  kicker: string; title: string; files: string;
  body: { p?: string; h?: string; list?: string[]; code?: string; note?: string; noteKind?: "info" | "warn" | "ok" }[];
}

export const NODE_DETAIL: Record<string, NodeDetail> = {
  "slack-in": { kicker: "Entry point", title: "Slack inbound event", files: "src/slack/socketClient.ts", body: [
    { p: "Sentinel connects over <b>Socket Mode</b> (no public webhook). Three event types are routed:" },
    { list: ["<b>app_mention</b> — bot @mentioned in a channel", "<b>message</b> (DM only) — genuine user IMs, no subtypes", "<b>/sentinel</b> slash command — ACKs, posts a “Processing…” seed message"] },
    { h: "Security gate", p: "<code>isAllowed(userId)</code> checks <code>ALLOWED_USER_IDS</code> — the single check keeping non-founders out. Unlisted users are silently ignored." },
    { h: "Normalization", p: "Each event becomes a <code>SlackEventEnvelope</code> {type, userId, channelId, threadTs, text, messageTs}; the bot mention is stripped." },
  ]},
  socket: { kicker: "Transport", title: "socketClient.ts", files: "src/slack/socketClient.ts · dedupe.ts", body: [
    { p: "Builds the <code>@slack/bolt</code> App and registers handlers. Because Claude can take up to 120s, Slack re-delivers events — a per-app <b>TTL deduper</b> keyed <code>channelId:messageTs</code> suppresses repeats." },
    { h: "Functions", list: ["<code>isAllowed</code> — allow-list gate", "<code>stripBotMention</code>", "<code>isUserDmMessage</code> — DM subtype filter", "<code>normalizeMention / DmMessage / SlashCommand</code>"] },
  ]},
  handle: { kicker: "Orchestrator", title: "handleEvent()", files: "src/index.ts", body: [
    { p: "The heart of the Q&A path. Bounded by a <b>3-request in-flight semaphore</b> (a 4th gets an “I'm busy” reply)." },
    { h: "Reaction state machine", list: ["Adds <code>:eyes:</code> on start", "Swaps to <code>:white_check_mark:</code> on success", "Swaps to <code>:x:</code> + error message on failure"] },
    { h: "Per-request sequence", p: "thread context → user lookup → persona/traits → memory recall (with the asker's <b>viewer scope</b>) → system prompt → <code>runClaude</code> → post → swap reaction → <code>trackQuery</code> → fire-and-forget <code>extractFromConversation</code> → record metrics." },
  ]},
  thread: { kicker: "Context", title: "threadContext.ts", files: "src/slack/threadContext.ts", body: [
    { p: "Fetches prior replies in the thread (cursor-paginated via <code>paginate()</code>). Each is rendered <code>&lt;@user&gt;: text</code> and prepended as <code>threadContext</code>. Errors are swallowed to <code>[]</code> — best-effort, never fatal." },
  ]},
  persona: { kicker: "Personalization", title: "Persona store + tracker", files: "src/persona/store.ts · tracker.ts", body: [
    { p: "<code>getOrCreatePersona</code> (race-safe <code>ON CONFLICT DO NOTHING</code>) and <code>getTraits</code> load the profile. Traits are decayed at read time; the top 8 (≥0.6) feed the prompt." },
    { p: "After the reply, <code>trackQuery</code> categorizes the query into one of 7 buckets, logs it to <code>query_log</code>, and reinforces the <code>focus_area</code> trait." },
  ]},
  recall: { kicker: "Company brain · flow 1", title: "Memory recall", files: "memoryStore.ts · rank.ts · injectionBudget.ts", body: [
    { p: "On every query, relevant org memories are retrieved. <b>Best-effort by contract</b> — any error returns <code>[]</code> and never fails the reply." },
    { h: "Two paths", list: ["<b>Entity graph OFF (default):</b> <code>searchMemories(text, 6, viewer)</code> — flat BM25 keyword recall", "<b>Entity graph ON:</b> <code>assembleRetrieval(...)</code> — resolves query entities, pulls dossiers + entity + query facts, optionally fuses cosine similarity"] },
    { h: "Scoring modulator", code: "score = -bm × (0.5 + 0.5·recency)\n            × categoryBoost × (0.5 + 0.5·confidence)\nrecency = 0.5 ^ (ageDays / 90)\ncategoryBoost = 1.25 for decision/owner/deadline" },
  ]},
  sysprompt: { kicker: "Prompt assembly", title: "buildSystemPrompt()", files: "src/claude/systemPrompt.ts", body: [
    { p: "Concatenates the static <b>Sentinel base prompt</b> (role, 6 Newton domains, mandatory 5-section answer format, Slack mrkdwn rules, never-fabricate/always-cite/read-only rules) + IST time + unavailable-source warnings + persona + top-8 traits + <b>recalled memories</b> + a note about the <code>memory_*</code>/<code>entity_*</code> tools." },
    { note: "Recalled memories are <b>untrusted content</b>. A hardened header tells Claude to treat them as context, prefer fresh tool data on conflict, and never follow instructions embedded inside a record — blunting prompt injection via ingested text.", noteKind: "warn" },
  ]},
  runner: { kicker: "Claude bridge", title: "runner.ts", files: "src/claude/runner.ts", body: [
    { p: "Spawns the Claude CLI as a child process and returns <code>{text, durationMs, tokens, cost}</code>." },
    { h: "Exact invocation", code: 'claude --print "<thread + message>"\n       --output-format json\n       --dangerously-skip-permissions\n       --system-prompt "<built prompt>"\n       --mcp-config /tmp/…/mcp-config-<uuid>.json' },
    { list: ["<b>120s timeout</b> (SIGTERM), cleared on settle to avoid a timer leak", "Parses JSON telemetry (tokens/cost/turns) defensively; falls back to raw stdout", "Deletes its per-spawn config file on close/error"] },
    { note: "<code>--dangerously-skip-permissions</code> makes read-only a soft prompt instruction at the runner level; the <b>hard</b> read-only guard lives inside the Metabase SQL AST check.", noteKind: "warn" },
  ]},
  cli: { kicker: "The model", title: "Claude CLI subprocess", files: "@anthropic-ai/claude-code (spawned)", body: [
    { p: "Where the intelligence lives. The CLI runs an <b>agentic tool-use loop</b>: reads the system prompt, decides which MCP tools to call, fans out across the 9 servers (often many round-trips), and synthesizes a final answer in the mandated 5-section format." },
    { p: "Per Sentinel's prompt strategy: meeting questions → Calendar first, then Meet API (<code>meet_list_conferences → meet_list_transcripts → meet_get_transcript_entries</code>), falling back to Drive transcripts." },
  ]},
  format: { kicker: "Output", title: "formatters.ts", files: "src/slack/formatters.ts", body: [
    { p: "<code>markdownToSlackMrkdwn</code> defensively converts any standard Markdown that slips through: <code>**bold**</code>→<code>*bold*</code>, <code>[t](u)</code>→<code>&lt;u|t&gt;</code>, headers→bold lines — while <b>protecting code blocks</b>. Posted with <code>unfurl_links:false</code>." },
  ]},
  db: { kicker: "State", title: "sentinel.db", files: "src/state/db.ts", body: [
    { p: "A single <code>better-sqlite3</code> connection (WAL, foreign keys, <code>busy_timeout=5000</code>), opened lazily. 13 tables across personas, audit, the company brain (facts + entity graph), and meet-bot dedup. See the <b>Data Model</b> tab." },
  ]},
  ingest: { kicker: "Company brain · flow 3", title: "ingestWatcher", files: "src/memory/ingestWatcher.ts", body: [
    { p: "Ticks every <b>5 min</b> (and once at boot). Requires an extraction API key + ≥1 runnable source. Overlapping ticks are skipped." },
    { list: ["<code>runMeetIngest</code> — transcripts of attended meetings (≤3/tick, 15-min grace, chunked, +summary)", "<code>runGmailIngest</code> — internal-sender allowlist only (≤10 extractions/tick)", "<code>runSlackIngest</code> — opt-in, allowlisted channels only"] },
    { p: "Kill switches read every tick: <code>MEMORY_INGEST_MEET=0</code>, <code>MEMORY_INGEST_GMAIL=0</code>, <code>MEMORY_INGEST_SLACK=1</code>, <code>MEMORY_SLACK_CHANNELS</code>." },
  ]},
  consol: { kicker: "Company brain · flow 4", title: "consolidationWatcher", files: "consolidationWatcher.ts · consolidate.ts", body: [
    { p: "Ticks every <b>30 min</b>. Selects entities “due” for a dossier rebuild (never built & ≥3 facts; or ≥8 new facts; or &gt;14 days old with new facts), then <code>consolidateEntity()</code> synthesizes a ≤1200-char markdown dossier. Also runs <code>backfillEmbeddings()</code> when embeddings are on. Gated by <code>MEMORY_CONSOLIDATION</code>." },
  ]},
  hook: { kicker: "Company brain · flow 2", title: "conversationHook", files: "conversationHook.ts · extractor.ts", body: [
    { p: "Fire-and-forget after each reply — never awaited, never throws. Runs the <b>user turn only</b> (≥40 chars) through the extractor with defense-in-depth (Zod → evidence-quote check → secret filter). Conversation facts capped at 0.6 confidence." },
  ]},
  watcher: { kicker: "Meet bot", title: "watcher.ts", files: "src/meet-bot/watcher.ts", body: [
    { p: "Polls the primary calendar every <b>60s</b> for events in the next 5 min, filters eligible ones (starting ≤2 min out / in progress, valid Meet URL, not already joined), and spawns a detached joiner — capped at <code>MAX_CONCURRENT_JOINERS</code> (default 1). Dedup persisted in <code>joined_meetings</code> (4h TTL)." },
  ]},
  joiner: { kicker: "Meet bot", title: "joiner.ts", files: "src/meet-bot/joiner.ts", body: [
    { p: "A detached Playwright Chrome process using the persistent signed-in profile. Cleans profile locks → launches headless Chrome (<code>channel:\"chrome\"</code>, fake media, no-sandbox) → mutes mic/cam → clicks Join/Ask-to-join (15 retries) → starts transcription → stays until the meeting ends. Gets a scrubbed env (no secrets)." },
  ]},
  gmeet: { kicker: "Meet bot", title: "Google Meet (server-side transcript)", files: "—", body: [
    { p: "Once the bot enables transcription, Google generates the transcript <b>server-side</b> and saves it to the organizer's Drive. It later becomes queryable via the <b>google-meet</b> MCP server (API v2 structured entries) and the <b>meeting-transcripts</b> server (Drive Docs), and is ingested into the brain by <code>meetIngest</code>." },
  ]},
  health: { kicker: "Ops", title: "health server", files: "src/health/server.ts", body: [
    { p: "HTTP server on port 8930 exposing <code>/health</code> (liveness), <code>/ready</code> (readiness), <code>/metrics</code> (Prometheus). See the <b>Ops &amp; Config</b> tab." },
  ]},
};

/* ---------- Lifecycle ---------- */
export interface LifecycleStep { stage: string; head: string; file: string; body: string; }
export const LIFECYCLE: LifecycleStep[] = [
  { stage: "Ingress", head: "Event arrives & is authorized", file: "socketClient.ts", body: 'Slack delivers an <code>app_mention</code>, DM <code>message</code>, or <code>/sentinel</code> over Socket Mode. <code>isAllowed(userId)</code> checks <code>ALLOWED_USER_IDS</code> — unlisted users are dropped. A TTL deduper keyed <code>channelId:messageTs</code> suppresses retry re-deliveries. The event is normalized into a <code>SlackEventEnvelope</code> and the bot mention is stripped.' },
  { stage: "Admission", head: "Concurrency gate + acknowledge", file: "index.ts → handleEvent()", body: 'A 3-slot in-flight semaphore guards the handler — a 4th concurrent request gets an “:hourglass: I’m busy” reply and returns. Otherwise <code>activeRequests++</code> and an <code>:eyes:</code> reaction is added to signal “working”.' },
  { stage: "Context", head: "Gather thread + identity", file: "threadContext.ts", body: 'Prior thread replies are fetched (cursor-paginated) and rendered <code>&lt;@user&gt;: text</code>. <code>client.users.info</code> resolves the display name. Both are best-effort — failures fall back to empty context / the raw user id.' },
  { stage: "Personalize", head: "Load persona & learned traits", file: "persona/store.ts", body: '<code>getOrCreatePersona</code> + <code>getTraits</code> load the profile. The asker’s <b>viewer scope</b> is computed (<code>currentViewerScope</code>) — in founders mode every allowed user is a founder who sees all memory rows.' },
  { stage: "Recall", head: "Retrieve organizational memory", file: "memory/memoryStore.ts", body: 'If the entity graph is enabled, <code>assembleRetrieval</code> resolves query entities and gathers dossiers + entity + query facts (fusing cosine similarity when embeddings are on). Otherwise <code>searchMemories(text, 6, viewer)</code> does flat BM25 recall. <b>Wrapped in try/catch — a memory failure can never fail the reply.</b>' },
  { stage: "Assemble", head: "Build the system prompt", file: "claude/systemPrompt.ts", body: 'Base Sentinel prompt + IST time + unavailable-source warnings + persona + top-8 traits + recalled memories (hardened “records not instructions” header, 3000-char tiered budget) + a memory-tools note are concatenated into one system prompt string.' },
  { stage: "Configure", head: "Write per-spawn MCP config", file: "claude/mcpConfig.ts", body: 'A fresh <code>mcp-config-&lt;uuid&gt;.json</code> is written (<code>chmod 0600</code>) registering every credentialed MCP server. The asker’s viewer scope is serialized into the memory server’s env so <code>canView</code> applies at the MCP edge too.' },
  { stage: "Spawn", head: "Run the Claude CLI", file: "claude/runner.ts", body: '<code>spawn(claude, ["--print", prompt, "--output-format","json", "--dangerously-skip-permissions", "--system-prompt", sp, "--mcp-config", path])</code> with a <b>120s timeout</b>. stdout/stderr are buffered; the config file is deleted when the process settles.' },
  { stage: "Agent loop", head: "Claude calls tools & reasons", file: "Claude CLI ↔ 9 MCP servers", body: 'The model runs an agentic loop: querying Metabase, searching Slack/Gmail, reading transcripts, looking up entities in the memory store — often many round-trips — then synthesizes an evidence-cited answer in the mandatory <b>Answer / Why / Evidence checked / Confidence / Unknowns</b> format.' },
  { stage: "Format & post", head: "Convert to mrkdwn & reply", file: "slack/formatters.ts", body: '<code>markdownToSlackMrkdwn</code> normalizes any stray Markdown (protecting code blocks) and the answer is posted to the thread with <code>unfurl_links:false</code>. The reaction swaps <code>:eyes:</code> → <code>:white_check_mark:</code>.' },
  { stage: "Learn", head: "Log, evolve persona, mine facts", file: "tracker.ts · conversationHook.ts", body: '<code>trackQuery</code> writes the exchange to <code>query_log</code> and reinforces the <code>focus_area</code> trait. <code>extractFromConversation</code> is fired <b>and not awaited</b> — mining the user turn for new facts in the background. Per-request token/cost/duration metrics are recorded for <code>/metrics</code>.' },
  { stage: "Release", head: "Decrement semaphore", file: "index.ts (finally)", body: 'In a <code>finally</code> block, <code>activeRequests--</code> frees a slot. On any error the reaction becomes <code>:x:</code>, a friendly (timeout-aware) message is posted, and the failure is recorded as an error metric.' },
];

/* ---------- MCP servers ---------- */
export interface McpServer {
  id: string; icon: string; name: string; file: string; auth: string;
  tools: string[]; note: string; accent: Accent;
}
export const MCP: McpServer[] = [
  { id: "metabase", icon: "📊", accent: "mcp", name: "metabase", file: "src/mcp/metabase.ts", auth: "Session token OR X-API-KEY",
    tools: ["metabase_query(sql, db_id) — native SQL, read-only AST guarded", "metabase_get_question(id) — run a saved card", "metabase_list_dashboards()", "metabase_list_databases()"],
    note: "Read-only enforced by node-sql-parser AST + regex fallback. 401 → re-auth once (checks retry.ok)." },
  { id: "github", icon: "🐙", accent: "mcp", name: "github", file: "npx @modelcontextprotocol/server-github", auth: "Personal Access Token",
    tools: ["Official MCP server — PRs, issues, commits, repo & release data"],
    note: "Not a custom server; spawned via npx with GITHUB_PERSONAL_ACCESS_TOKEN." },
  { id: "notion", icon: "📔", accent: "mcp", name: "notion", file: "npx @notionhq/notion-mcp-server", auth: "Bearer (OPENAPI_MCP_HEADERS)",
    tools: ["Official Notion MCP — docs, project pages, roadmaps"],
    note: "npx package (NOT @modelcontextprotocol/server-notion). Notion-Version 2022-06-28." },
  { id: "slack-search", icon: "🔍", accent: "mcp", name: "slack-search", file: "src/mcp/slack.ts", auth: "xoxp user token",
    tools: ["slack_search_messages(query, count, sort)", "slack_read_channel_history(channel, limit, oldest?)", "slack_read_thread(channel, thread_ts, limit)"],
    note: "Text clamped to 500 chars; threads de-dup the parent across pages; bounded pagination." },
  { id: "gmail", icon: "✉️", accent: "mcp", name: "gmail", file: "src/mcp/gmail.ts", auth: "Google OAuth2 refresh token",
    tools: ["gmail_search(query, max)", "gmail_read_thread(thread_id)", "gmail_list_recent(days, label?, max)"],
    note: "Recursive MIME walk for first text/plain body; bodies clamped to 2000 chars." },
  { id: "google-calendar", icon: "📅", accent: "mcp", name: "google-calendar", file: "src/mcp/calendar.ts", auth: "Google OAuth2 refresh token",
    tools: ["calendar_list_events(start?, end?, max, cal) — defaults to Mon–Fri week", "calendar_get_event(id)", "calendar_search(query, days_back, days_forward)"],
    note: "Timezone-aware week math via Intl.DateTimeFormat (two-pass DST-correct, IST fallback)." },
  { id: "meeting-transcripts", icon: "📄", accent: "mcp", name: "meeting-transcripts", file: "src/mcp/transcripts.ts", auth: "Google OAuth2 (Drive v3 + Docs v1)",
    tools: ["transcript_search(query?, days_back, max)", "transcript_read(doc_id, max_length)", "transcript_list_recent(days, max)"],
    note: "Drive q-grammar escaped backslash-first. Returns nothing unless a Doc is shared with Sentinel." },
  { id: "google-meet", icon: "🎥", accent: "mcp", name: "google-meet", file: "src/mcp/meet.ts", auth: "Google OAuth2 (raw Meet REST v2)",
    tools: ["meet_list_conferences(page_size, filter?)", "meet_get_conference(id)", "meet_list_transcripts(conf_id)", "meet_get_transcript_entries(conf_id, tr_id, page_size)"],
    note: "In-process token cache (30s early-expiry); resolves speaker ids → names with a cache. Preferred over Drive transcripts." },
  { id: "memory", icon: "🧠", accent: "brain", name: "memory", file: "src/mcp/memory.ts", auth: "Own SQLite handle + viewer scope from env",
    tools: ["memory_search / store / forget / forget_source / supersede / recent", "entity_search / entity_get / entity_facts", "team_roster / org_lookup", "entity_digest / org_digest", "memory_forget_entity (right-to-be-forgotten)"],
    note: "Registered UNCONDITIONALLY. Never migrates (main process owns schema). Applies canView at the MCP edge." },
];

export interface SecHighlight { title: string; body: string; }
export const SEC_HIGHLIGHTS: SecHighlight[] = [
  { title: "SQL read-only enforcement (sqlReadOnly.ts)", body: "<code>metabase_query</code> is hard-gated read-only. An AST check via <code>node-sql-parser</code> accepts only node types <code>select / explain / show / desc</code>, blocks data-modifying CTEs (<code>WITH x AS (DELETE…)</code>), <code>SELECT … INTO</code>, and stacked statements (<code>SELECT 1; DROP…</code>). If the parser throws on a dialect quirk, it <b>falls back to a regex guard</b> (forbidden whole-word keywords) so it never regresses open." },
  { title: "Per-spawn secret hygiene (mcpConfig.ts + runner.ts)", body: "The config file holds every server's plaintext credentials, so each spawn writes a <b>UUID-named</b> file (no fixed path → no torn reads), <code>chmod 0600</code>, and <code>runner.ts</code> removes it on close/error. Shutdown sweeps strays. The detached Meet joiner gets a <b>scrubbed env</b> — no secrets, it authenticates via the Chrome profile." },
  { title: "Google data quirks handled", body: "Calendar “this week” is timezone-aware via <code>Intl.DateTimeFormat</code> (two-pass DST-correct, IST fallback). Meet speakers are resolved from opaque participant ids to human names with an in-process cache. Drive <code>q</code> values are escaped backslash-first to prevent query injection. Gmail bodies are extracted by recursively walking the MIME multipart tree for the first <code>text/plain</code> node." },
  { title: "Memory MCP server is read-mostly & never migrates", body: "<code>memory.js</code> opens its <b>own</b> SQLite handle (WAL, <code>busy_timeout=5000</code>) and <b>never runs migrations</b> — the main process owns the schema. It reads the per-request <b>viewer scope from env</b> (<code>viewerScopeFromEnv</code>) so the same <code>canView</code> ACL applies at the MCP edge. If the schema is absent, every tool returns a friendly “run the bot once” message." },
];

/* ---------- Company brain ---------- */
export interface BrainFlow { n: string; title: string; desc: string; }
export const BRAIN_PIPELINE: BrainFlow[] = [
  { n: "IN", title: "Raw input arrives", desc: "A Slack turn, a Meet transcript chunk, an internal email, or a Slack-channel message." },
  { n: "1", title: "Extract candidate facts", desc: "extractor.ts → structured-output LLM call (≤10 facts/call, 500 calls/day budget). Each fact: text ≤300 chars, category, entities, confidence, evidence_quote, sensitivity." },
  { n: "2", title: "Validate (defense in depth)", desc: "Zod re-validation → verbatim evidence-quote substring check against the source → secret-regex filter. Anything that fails is dropped." },
  { n: "3", title: "Dedup & insert", desc: "Unique content_hash blocks exact dupes; an FTS near-dup check (Jaccard ≥0.85) reinforces an existing fact instead of inserting. Per-source confidence cap applied." },
  { n: "4", title: "Link to entities", desc: "linkFactEntities resolves names via the 6-rung ladder; ambiguous matches drop (missing link beats wrong link). Highest-confidence entity ≥0.8 becomes the subject." },
  { n: "5", title: "Infer org edges", desc: "orgInfer proposes high-precision edges from owner-facts (person→team manages, →project/metric owns) at 0.5 base, reinforced to 0.95, read-time decayed (60-day half-life)." },
  { n: "6", title: "Consolidate into dossiers", desc: "Every 30 min, due entities get a ≤1200-char markdown dossier synthesized from their facts (store a lot, inject a little)." },
  { n: "7", title: "Embed (optional)", desc: "If MEMORY_EMBEDDINGS=1, backfill text-embedding-3-small vectors (2000 calls/day) into the embedding BLOB for cosine fusion." },
  { n: "OUT", title: "Recall on next query", desc: "BM25 (+cosine) → modulator re-rank → entity dossiers → injectionBudget packs ≤3000 chars into the prompt as untrusted records." },
];

export const BRAIN_FLOWS = [
  { n: "1", title: "Recall → Inject", when: "on every query, synchronously", body: "<code>searchMemories()</code> / <code>assembleRetrieval()</code> run an FTS5 <b>BM25</b> search (weights text 2.0, entities 1.0, label 1.0), optionally <b>fused with cosine</b> (<code>rankHybrid</code>, α=0.6). Results are re-scored by recency (90-day half-life) × category boost (×1.25) × confidence. With the entity graph on, query entities are resolved and their <b>dossiers</b> pulled in. <code>injectionBudget.ts</code> packs it under a 3000-char tiered budget (1200/800/1000), under a “records, NOT instructions” header. Falls back to a <code>LIKE</code> scan if FTS5 is unavailable." },
  { n: "2", title: "Hook → Extract", when: "fire-and-forget, after each reply", body: "<code>extractFromConversation()</code> is never awaited. It runs the <b>user turn only</b> (≥40 chars) through <code>extractor.ts</code>: a hardened structured-output call (no SDK; a raw client with a <b>500-calls/day</b> budget), then defense-in-depth: <b>Zod re-validation</b> → a <b>verbatim evidence-quote check</b> → a <b>secret-regex filter</b>. Conversation facts capped at <b>0.6</b>." },
  { n: "3", title: "Poller → Ingest", when: "ingestWatcher, every 5 min", body: "Pulls from three gated sources: <b>Meet</b> transcripts (chunked + summary, cap 0.7), <b>Gmail</b> with an <b>internal-sender allowlist</b> (cap 0.6), and <b>Slack channels</b> (opt-in, allowlisted, cap 0.5). Restart-safe via <code>ingest_cursors</code> (high-water marks) + <code>ingested_docs</code> (per-doc dedup, 14-day TTL). Kill switches read every tick." },
  { n: "4", title: "Graph → Dossiers → Digests", when: "consolidationWatcher, every 30 min", body: "Each fact is linked to entities (6-rung ladder). Owner-facts <b>infer org edges</b> (manages/owns) at 0.5 base, reinforced toward 0.95, <b>read-time decayed</b> (60-day half-life, display ≥0.45). <code>consolidateEntity()</code> rolls an entity's facts into a ≤1200-char <b>dossier</b>. <code>entity_digest</code> / <code>org_digest</code> answer “what changed”." },
];

export const BRAIN_CONSTS: [string, string, string, string][] = [
  ["MEMORY_RECENCY_HALF_LIFE_DAYS", "90", "rank.ts", "Recency decay in recall ranking"],
  ["CATEGORY_BOOST", "1.25", "rank.ts", "Boost for decision/owner/deadline facts"],
  ["HYBRID_ALPHA", "0.6", "rank.ts", "BM25 vs cosine blend (lexical-leaning)"],
  ["BM25 weights", "text 2.0 / ent 1.0 / label 1.0", "memorySql.ts", "FTS5 column weighting"],
  ["NEAR_DUP_JACCARD", "0.85", "memorySql.ts", "Near-dup → reinforce instead of insert"],
  ["MAX fact text", "300 chars", "memorySql.ts", "Hard cap on stored fact length"],
  ["Injection budget", "3000 (1200/800/1000)", "injectionBudget.ts", "Total / dossiers / entity / query chars"],
  ["MAX_EXTRACTION_CALLS_PER_DAY", "500", "anthropicClient.ts", "Extraction budget"],
  ["MAX_EMBEDDING_CALLS_PER_DAY", "2000", "embedder.ts", "Embedding-request budget"],
  ["FUZZY_THRESHOLD", "0.6", "entityResolve.ts", "Entity name soft-overlap minimum"],
  ["DEFAULT_RESOLVE_MIN", "0.8", "entityLink.ts", "Subject-attribution confidence floor"],
  ["EDGE growth / cap", "+15% / 0.95", "entitySql.ts", "Edge confidence reinforcement"],
  ["EDGE_HALF_LIFE / display", "60d / 0.45", "edgeDecay.ts", "Read-time edge decay & threshold"],
  ["INGEST_INTERVAL_MS", "5 min", "ingestWatcher.ts", "Ingest poll cadence"],
  ["CONSOLIDATION_INTERVAL_MS", "30 min", "consolidationWatcher.ts", "Dossier rebuild cadence"],
  ["Confidence caps", "meet .70 / email,conv .60 / slack .50", "ingest*.ts", "Per-source trust ceilings"],
  ["ingested_docs TTL", "14 days", "memorySql.ts", "Per-doc ingest dedup window"],
];

/* ---------- Gates ---------- */
export const GATES: [string, string, "on" | "off" | "founders"][] = [
  ["per-MCP credentials", "Each server registers only if its env creds are present; missing → source reported unavailable", "off"],
  ["MEMORY_ACL_MODE", "founders (default) — founders see all, others nothing. scoped = built but dormant", "founders"],
  ["MEMORY_ENTITY_GRAPH", "=1 to enable entity-aware recall, linking & org-edge inference. Default OFF (flat recall)", "off"],
  ["MEMORY_EMBEDDINGS", "=1 to enable cosine fusion + embedding backfill. Default OFF (BM25-only)", "off"],
  ["MEMORY_INGEST_MEET / GMAIL", "ON by default (need API key + Google creds). =0 to disable", "on"],
  ["MEMORY_INGEST_SLACK", "OFF by default; =1 + MEMORY_SLACK_CHANNELS allowlist to enable (untrusted source)", "off"],
  ["MEMORY_SENSITIVE_RECALL", "Default OFF — sensitive (HR/comp/legal) facts excluded from ambient recall", "off"],
  ["MEMORY_CONSOLIDATION", "ON by default; =0 to stop dossier synthesis", "on"],
];

/* ---------- Meet ---------- */
export const MEET_WATCH: BrainFlow[] = [
  { n: "1", title: "Poll every 60s", desc: "calendar.events.list(primary, now → now+5min, singleEvents, orderBy startTime)." },
  { n: "2", title: "Filter eligible", desc: "start ≤2 min away (or in progress), not ended, valid meet.google.com URL, not in joined_meetings (4h TTL)." },
  { n: "3", title: "Check capacity", desc: "canSpawnJoiner(active, MAX_CONCURRENT_JOINERS=1). At cap → defer to next poll." },
  { n: "4", title: "Spawn detached", desc: "buildJoinerArgs + scrubbed buildJoinerEnv; spawn detached, unref, log to data/meet-bot-logs/. markJoined." },
];
export const MEET_JOIN: BrainFlow[] = [
  { n: "1", title: "Clean & launch", desc: "Remove stale profile locks; launchPersistentContext(channel:chrome, headless, fake-media, no-sandbox)." },
  { n: "2", title: "Navigate & prep", desc: "Open Meet URL; wait for UI; mute mic + camera; set guest name 'Sentinel'." },
  { n: "3", title: "Join", desc: "Click 'Join now' / 'Ask to join' (≤15 retries, 2s apart); confirm via 'Leave call' button." },
  { n: "4", title: "Transcribe", desc: "Activities → Transcripts → 'Start transcription' (Google records server-side)." },
  { n: "5", title: "Stay until end", desc: "Poll every 15s for end conditions or max 2h; leave gracefully. (watcher hardcodes stay-until-end)" },
];
export const MEET_WHY: [string, string][] = [
  ["Detached subprocess", "Spawned with detached:true + unref() and logs to a per-spawn file. If Sentinel restarts mid-meeting, the bot keeps recording."],
  ["Concurrency cap = 1", "MAX_CONCURRENT_JOINERS defaults to 1 because all joins share one persistent Chrome profile — two at once would corrupt it. Deferred meetings retry next poll."],
  ["Persisted dedup", "joined_meetings table (4h TTL) means an in-progress meeting isn't re-joined after a restart. Profile locks are cleaned before each launch."],
  ["Stay-until-end hardcoded", "The watcher overrides the CLI's leave-after-join default with --stay-mode stay-until-end (a deliberate #17 revert) so the bot stays for in-call artifacts."],
  ["Scrubbed env", "buildJoinerEnv() forwards only an allowlist (PATH/HOME/TZ/DISPLAY/CHROME*/PLAYWRIGHT*) — zero secrets reach the child."],
  ["Fake media + no-sandbox", "Launched with --use-fake-ui-for-media-stream, --no-sandbox, mic/cam muted, name “Sentinel”. Runtime image is the Playwright base with Chrome."],
];

/* ---------- Persona ---------- */
export const CATEGORIES: [string, string][] = [
  ["placements", "placement · employer · offer · interview · salary · ctc"],
  ["admissions", "admission · funnel · counselor · lead · cohort · enrollment"],
  ["student_health", "escalation · dropout · sentiment · complaint · nps"],
  ["product_execution", "product · feature · sprint · PR · deploy · bug · launch"],
  ["finance", "revenue · arr · churn · billing · budget · expense"],
  ["nst_operations", "nst · campus · internship · academic · faculty · curriculum"],
  ["general", "fallback when no keywords match"],
];

/* ---------- Ops ---------- */
export const BOOT: BrainFlow[] = [
  { n: "1", title: "getDb()", desc: "Open SQLite, run idempotent migrations, prune query log + non-active memories (90d)." },
  { n: "2", title: "getMcpConfigPath()", desc: "Generate the initial MCP config (validates which sources are available)." },
  { n: "3", title: "startHealthServer()", desc: "Bind :8930 with /health, /ready, /metrics providers." },
  { n: "4", title: "startMeetWatcher()", desc: "Begin the 60s calendar poll → Playwright joiner pipeline." },
  { n: "5", title: "startIngestWatcher()", desc: "Begin the 5-min memory ingest poller (if a source + API key exist)." },
  { n: "6", title: "startConsolidationWatcher()", desc: "Begin the 30-min dossier + embedding poller." },
  { n: "7", title: "app.start()", desc: "Connect Slack Socket Mode; flip slackConnected=true → /ready turns green." },
];
export const SHUT: BrainFlow[] = [
  { n: "1", title: "Stop pollers", desc: "Halt watcher / ingest / consolidation loops (detached Meet joiners are left running)." },
  { n: "2", title: "Stop Slack app", desc: "Stop accepting new events." },
  { n: "3", title: "Drain in-flight", desc: "Poll activeRequests every 250ms up to a 25s cap (under K8s 30s grace), then continue." },
  { n: "4", title: "Close health + DB", desc: "Close the HTTP server, close SQLite, sweep stray MCP config files." },
  { n: "5", title: "exit(0)", desc: "Idempotent — repeat SIGINT/SIGTERM await the same in-flight shutdown." },
];
export const ENV: [string, boolean, string, string][] = [
  ["SLACK_BOT_TOKEN", true, "—", "Must start xoxb-"],
  ["SLACK_APP_TOKEN", true, "—", "Must start xapp- (Socket Mode)"],
  ["BOT_USER_ID", true, "—", "For mention stripping"],
  ["ALLOWED_USER_IDS", true, "—", "CSV allow-list; .refine ≥1 non-empty"],
  ["CLAUDE_BIN", false, "claude", "Path to the Claude CLI binary"],
  ["ANTHROPIC_API_KEY", false, "—", "Passed to CLI (extraction can also run on OpenAI)"],
  ["METABASE_URL + (API_KEY | USER+PASS)", false, "—", "Metabase server if set"],
  ["GITHUB_TOKEN", false, "—", "GitHub MCP if set"],
  ["NOTION_API_KEY", false, "—", "Notion MCP if set"],
  ["SLACK_USER_TOKEN", false, "—", "xoxp- → slack-search MCP"],
  ["GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN", false, "—", "All-or-nothing (.refine); Gmail/Cal/Meet/Transcripts"],
  ["MEMORY_EMBEDDING_API_KEY", false, "—", "Key for embeddings (OpenAI)"],
  ["MEMORY_EMBEDDING_MODEL", false, "text-embedding-3-small", "Embedding model id"],
  ["HEALTH_CHECK_PORT", false, "8930", "Health/metrics HTTP port"],
  ["SQLITE_DB_PATH", false, "./sentinel.db", "DB file (CWD-relative)"],
  ["LOG_LEVEL", false, "info", "fatal…trace (Pino)"],
  ["MAX_CONCURRENT_JOINERS", false, "1", "Meet joiner cap (shared Chrome profile)"],
];

/* ---------- Schema / ERD ---------- */
export interface ErdTable { name: string; note: string; rows: [string, string, string][]; }
export const SCHEMA: Record<string, ErdTable[]> = {
  persona: [
    { name: "personas", note: "1 / user", rows: [["user_id", "TEXT", "pk"], ["display_name", "TEXT", ""], ["role", "TEXT", ""], ["created_at", "TEXT", ""], ["updated_at", "TEXT", ""]] },
    { name: "persona_traits", note: "UQ(user,label,value)", rows: [["id", "INTEGER", "pk"], ["user_id", "TEXT", ""], ["label", "TEXT", ""], ["value", "TEXT", "uq"], ["confidence", "REAL", ""], ["evidence_count", "INT", ""], ["updated_at", "TEXT", ""]] },
    { name: "query_log", note: "audit · 90d", rows: [["id", "INTEGER", "pk"], ["user_id", "TEXT", ""], ["query_text", "TEXT", ""], ["category", "TEXT", ""], ["response_text", "TEXT", ""], ["response_duration_ms", "INT", ""], ["sources_used", "JSON", ""], ["created_at", "TEXT", ""]] },
  ],
  facts: [
    { name: "memories", note: "the fact store", rows: [["id", "INTEGER", "pk"], ["text", "TEXT ≤300", ""], ["category", "enum(7)", ""], ["source_type", "enum(4)", ""], ["source_ref / label", "TEXT", ""], ["evidence_quote", "TEXT", ""], ["confidence", "REAL", ""], ["visibility", "TEXT", ""], ["sensitivity", "enum", ""], ["subject_entity_id", "INT", "fk"], ["scope_team_id", "INT", ""], ["content_hash", "TEXT", "uq"], ["status", "enum", ""], ["superseded_by", "INT", "fk"], ["embedding", "BLOB", ""]] },
    { name: "memories_fts", note: "FTS5 · porter", rows: [["text", "", ""], ["entities", "", ""], ["source_label", "", ""], ["triggers ai/ad/au", "sync", ""]] },
    { name: "ingest_cursors", note: "high-water marks", rows: [["source", "TEXT", "pk"], ["cursor", "TEXT", ""], ["updated_at", "TEXT", ""]] },
    { name: "ingested_docs", note: "per-doc dedup 14d", rows: [["doc_id", "TEXT", "pk"], ["ingested_at", "INT", ""]] },
  ],
  graph: [
    { name: "entities", note: "people/teams/…", rows: [["id", "INTEGER", "pk"], ["type", "enum(8)", ""], ["canonical_name", "TEXT", ""], ["normalized_name", "TEXT", ""], ["aliases", "JSON", ""], ["slack_user_id", "TEXT", "uq"], ["email", "TEXT", "uq"], ["confidence", "REAL", ""], ["status", "enum", ""], ["merged_into", "INT", "fk"], ["embedding", "BLOB", ""]] },
    { name: "entity_edges", note: "UQ(src,dst,rel)", rows: [["id", "INTEGER", "pk"], ["src_id", "INT", "fk"], ["dst_id", "INT", "fk"], ["relation", "enum(8)", ""], ["confidence", "REAL", ""], ["evidence_count", "INT", ""], ["provenance", "JSON", ""], ["status", "enum", ""]] },
    { name: "memory_entities", note: "fact↔entity links", rows: [["memory_id", "INT", "pk"], ["entity_id", "INT", "pk"], ["role", "enum(4)", "pk"], ["confidence", "REAL", ""]] },
    { name: "entity_profiles", note: "dossiers ≤1200", rows: [["entity_id", "INT", "pk"], ["profile_md", "TEXT", ""], ["source_fact_ids", "JSON", ""], ["fact_count", "INT", ""], ["version", "INT", ""], ["model", "TEXT", ""], ["embedding", "BLOB", ""]] },
    { name: "entity_profile_cursors", note: "rebuild delta", rows: [["entity_id", "INT", "pk"], ["last_fact_count", "INT", ""]] },
    { name: "entity_exclusions", note: "right-to-be-forgotten", rows: [["entity_id", "INT", "pk"], ["reason", "TEXT", ""], ["created_by", "TEXT", ""]] },
  ],
  meet: [
    { name: "joined_meetings", note: "dedup · 4h TTL", rows: [["event_id", "TEXT", "pk"], ["joined_at", "INT (ms)", ""]] },
  ],
};

export const STATS: [string, string][] = [
  ["9", "MCP tool servers"],
  ["2", "independent pipelines"],
  ["13", "SQLite tables"],
  ["4", "memory data-flows"],
  ["3", "background pollers"],
  ["120s", "per-query CLI budget"],
];
