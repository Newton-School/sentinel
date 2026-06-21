/**
 * Background ingestion of recent INTERNAL email into organizational memory.
 *
 * One `runGmailIngest` call is one tick: list messages newer than the
 * persisted cursor (an internalDate epoch-ms string), fetch them in full,
 * filter hard, and run the survivors through the hardened extractor.
 *
 * SENDER ALLOWLIST (security-critical): a message is extracted ONLY when its
 * From address's domain is in `internalDomains`. External senders are marked
 * ingested without ever reaching the extractor — an outside party must never
 * be able to inject "facts" into memory by emailing the Sentinel account.
 * Bulk mail (List-Unsubscribe / no-reply-ish senders), self-sent mail, and
 * near-empty bodies are likewise skipped-and-marked.
 *
 * Restart safety mirrors meetIngest: a Postgres cursor (`ingest_cursors.gmail`)
 * plus per-document dedup (`ingested_docs`, `gmail:<messageId>`). Messages
 * are processed oldest-first so the cursor only ever advances over fully
 * processed mail; extraction-cap deferrals stay unmarked AND ahead of the
 * cursor, so the next tick re-lists them.
 */

import { getPool } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import { extractFacts } from "./extractor.js";
import { insertFact } from "./memoryStore.js";
import {
  getCursor,
  setCursor,
  markIngested,
  isIngested,
} from "./memorySql.js";
import { extractPlainTextBody, type GmailPart } from "../mcp/gmailBody.js";
import { getHeader, type GmailHeader } from "../mcp/gmailList.js";

const log = createLogger("gmail-ingest");

const CURSOR_SOURCE = "gmail";
/** First-run lookback window when no cursor exists yet. */
const INIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Max message ids pulled from messages.list per tick. */
const LIST_MAX_RESULTS = 25;
/** Max LLM extractions per tick (cost guard; the rest defer to later ticks). */
const MAX_EXTRACTIONS_PER_TICK = 10;
/** Bodies shorter than this (post quote-stripping) carry nothing durable. */
const MIN_BODY_CHARS = 200;
/** Email facts cap at this confidence prior (unverified, single-author). */
const EMAIL_CONFIDENCE_CAP = 0.6;
/** The always-allowlisted company domain. */
const DEFAULT_INTERNAL_DOMAIN = "newtonschool.co";

/** Automated/bulk senders that never carry durable human-asserted facts. */
const NO_REPLY_REGEX =
  /no-?reply|notifications?@|mailer-daemon|calendar-notification/i;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Extracts the lowercased address from a From header ("Name <a@b>" or bare). */
export function parseFromEmail(from: string): string {
  const angled = from.match(/<([^<>]+)>/);
  return (angled ? angled[1] : from).trim().toLowerCase();
}

/**
 * The internal-domain allowlist: always `newtonschool.co`, extended via the
 * MEMORY_GMAIL_DOMAINS env var (comma-separated, case-insensitive).
 */
export function resolveInternalDomains(
  env: Record<string, string | undefined> = process.env
): string[] {
  const domains = [DEFAULT_INTERNAL_DOMAIN];
  for (const raw of (env.MEMORY_GMAIL_DOMAINS ?? "").split(",")) {
    const domain = raw.trim().toLowerCase();
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

export interface ShouldIngestEmailInput {
  from: string;
  listUnsubscribe: string;
  bodyLength: number;
  selfEmail?: string;
  internalDomains: string[];
}

export interface IngestDecision {
  ingest: boolean;
  reason?: string;
}

/**
 * Pure ingest gate for one email. The sender allowlist is checked FIRST: an
 * external sender is rejected before any other consideration.
 */
export function shouldIngestEmail(
  input: ShouldIngestEmailInput
): IngestDecision {
  const address = parseFromEmail(input.from);
  const domain = address.split("@")[1] ?? "";
  if (!input.internalDomains.includes(domain)) {
    return { ingest: false, reason: "external-sender" };
  }
  if (input.listUnsubscribe.trim() !== "") {
    return { ingest: false, reason: "list-unsubscribe" };
  }
  if (NO_REPLY_REGEX.test(input.from)) {
    return { ingest: false, reason: "no-reply-sender" };
  }
  if (input.selfEmail && address === input.selfEmail.toLowerCase()) {
    return { ingest: false, reason: "self-sent" };
  }
  if (input.bodyLength < MIN_BODY_CHARS) {
    return { ingest: false, reason: "short-body" };
  }
  return { ingest: true };
}

/**
 * Strips quoted-reply content: everything from the first `On ... wrote:`
 * attribution line onward, plus any remaining `>`-quoted lines.
 */
export function stripQuotedReply(body: string): string {
  const attribution = body.match(/^On .{5,80} wrote:\s*$/m);
  const head =
    attribution && attribution.index !== undefined
      ? body.slice(0, attribution.index)
      : body;
  return head
    .split("\n")
    .filter((line) => !line.startsWith(">"))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Gmail client surface (structural subset of googleapis' gmail_v1.Gmail)
// ---------------------------------------------------------------------------

interface GmailFullMessage {
  id?: string | null;
  internalDate?: string | null;
  payload?: (GmailPart & { headers?: GmailHeader[] | null }) | null;
}

export interface GmailIngestClient {
  users: {
    getProfile(params: {
      userId: string;
    }): Promise<{ data: { emailAddress?: string | null } }>;
    messages: {
      list(params: {
        userId: string;
        q: string;
        maxResults: number;
      }): Promise<{
        data: { messages?: Array<{ id?: string | null }> | null };
      }>;
      get(params: {
        userId: string;
        id: string;
        format: "full";
      }): Promise<{ data: GmailFullMessage }>;
    };
  };
}

export interface GmailIngestDeps {
  gmail: GmailIngestClient;
  apiKey: string;
  internalDomains: string[];
  /** The Sentinel account's own address; fetched via getProfile when absent. */
  selfEmail?: string;
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Injectable fetch threaded into the extractor LLM calls. */
  fetchImpl?: typeof fetch;
}

// The bot's own address never changes during a process lifetime — fetch once.
let cachedSelfEmail: string | undefined;

async function resolveSelfEmail(
  deps: GmailIngestDeps
): Promise<string | undefined> {
  if (deps.selfEmail) return deps.selfEmail;
  if (cachedSelfEmail) return cachedSelfEmail;
  try {
    const profile = await deps.gmail.users.getProfile({ userId: "me" });
    cachedSelfEmail = profile.data.emailAddress ?? undefined;
  } catch (err) {
    log.warn({ err }, "users.getProfile failed — self-sent mail not skippable");
  }
  return cachedSelfEmail;
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

export async function runGmailIngest(deps: GmailIngestDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const pool = getPool();

  const rawCursor = await getCursor(pool, CURSOR_SOURCE);
  let cursorMs = rawCursor ? Number(rawCursor) : NaN;
  if (!Number.isFinite(cursorMs)) {
    cursorMs = nowMs - INIT_LOOKBACK_MS;
    await setCursor(pool, CURSOR_SOURCE, String(cursorMs), now);
  }

  const query =
    `after:${Math.floor(cursorMs / 1000)} ` +
    `-category:promotions -category:social -category:updates`;
  const listRes = await deps.gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: LIST_MAX_RESULTS,
  });

  const candidateIds = (listRes.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => !!id);
  const ingestedFlags = await Promise.all(
    candidateIds.map((id) => isIngested(pool, `gmail:${id}`))
  );
  const ids = candidateIds.filter((_id, i) => !ingestedFlags[i]);
  if (ids.length === 0) return;

  const selfEmail = await resolveSelfEmail(deps);

  // Fetch full messages up front so we can process oldest-first: the cursor
  // is "max internalDate fully processed", which is only safe when nothing
  // older than it can still be pending. On any fetch failure abort the whole
  // run (nothing marked yet; per-doc dedup makes the retry cheap).
  const messages: GmailFullMessage[] = [];
  for (const id of ids) {
    try {
      const res = await deps.gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      messages.push(res.data);
    } catch (err) {
      log.error(
        { err, messageId: id },
        "messages.get failed — aborting Gmail tick (will retry)"
      );
      return;
    }
  }
  messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));

  let extractions = 0;
  let maxProcessedMs = cursorMs;

  for (const [index, message] of messages.entries()) {
    const id = message.id;
    if (!id) continue;
    const internalDateMs = Number(message.internalDate);
    const headers = message.payload?.headers ?? [];
    const from = getHeader(headers, "From");
    const subject = getHeader(headers, "Subject") || "(no subject)";
    const dateHeader = getHeader(headers, "Date");
    const listUnsubscribe = getHeader(headers, "List-Unsubscribe");

    const body = stripQuotedReply(extractPlainTextBody(message.payload));

    const decision = shouldIngestEmail({
      from,
      listUnsubscribe,
      bodyLength: body.length,
      selfEmail,
      internalDomains: deps.internalDomains,
    });

    if (!decision.ingest) {
      // Fully examined: mark so it is never re-fetched, and let the cursor
      // advance over it.
      log.debug({ messageId: id, reason: decision.reason }, "Email skipped");
      await markIngested(pool, `gmail:${id}`, nowMs);
      if (Number.isFinite(internalDateMs)) {
        maxProcessedMs = Math.max(maxProcessedMs, internalDateMs);
      }
      continue;
    }

    if (extractions >= MAX_EXTRACTIONS_PER_TICK) {
      // Deferred messages stay UNMARKED and ahead of the cursor (oldest-first
      // ordering), so the next tick re-lists them. Never a silent cap.
      log.info(
        {
          cap: MAX_EXTRACTIONS_PER_TICK,
          deferred: messages.length - index,
        },
        "Extraction cap reached — deferring remaining emails to a later tick"
      );
      break;
    }

    const headerDateMs = Date.parse(dateHeader);
    const assertedAt = Number.isFinite(headerDateMs)
      ? new Date(headerDateMs).toISOString()
      : Number.isFinite(internalDateMs)
        ? new Date(internalDateMs).toISOString()
        : undefined;

    const sourceLabel = `Email: ${subject} (${from}, ${dateHeader})`;
    const facts = await extractFacts({
      sourceType: "email",
      sourceLabel,
      content: body,
      apiKey: deps.apiKey,
      fetchImpl: deps.fetchImpl,
    });
    extractions++;

    for (const fact of facts) {
      await insertFact({
        text: fact.text,
        category: fact.category,
        entities: fact.entities,
        sourceType: "email",
        sourceRef: `gmail:${id}`,
        sourceLabel,
        assertedAt,
        evidenceQuote: fact.evidence_quote,
        confidence: Math.min(fact.confidence, EMAIL_CONFIDENCE_CAP),
        sensitivity: fact.sensitivity,
        now,
      });
    }
    if (facts.length > 0) {
      log.info({ messageId: id, count: facts.length }, "Stored email facts");
    }

    await markIngested(pool, `gmail:${id}`, nowMs);
    if (Number.isFinite(internalDateMs)) {
      maxProcessedMs = Math.max(maxProcessedMs, internalDateMs);
    }
  }

  if (maxProcessedMs > cursorMs) {
    await setCursor(pool, CURSOR_SOURCE, String(maxProcessedMs), now);
  }
}
