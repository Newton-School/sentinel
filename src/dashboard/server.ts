/**
 * Sentinel dashboard HTTP API — a small, read-only JSON API over the dashboard
 * query layer, plus static serving of the built SPA (single origin → no CORS).
 *
 * Mirrors the bare `node:http` style of src/health/server.ts. It takes all its
 * dependencies via `deps` (a Queryable + optional static dir + logger) and does
 * NOT import config, so it stays pure and unit-testable; the entrypoint
 * (src/dashboard/index.ts) wires the real read-only pool and logger.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Queryable } from "../state/db.js";
import type { ViewerScope } from "../access/scope.js";
import { listConversations, getTrace, listNegativeFeedback, getSummary } from "./queries.js";
import {
  dashboardViewerScope,
  listEntities,
  getEntityDetail,
  getGraph,
  listMemories,
  listPersonas,
  getPersona,
} from "./brain.js";
import { getActivity } from "./activity.js";

export interface DashboardLogger {
  error: (...args: unknown[]) => void;
}

/** The bot's /ready shape (proxied for the health view); all fields optional. */
export interface BotReadiness {
  status?: string;
  slack?: string;
  database?: string;
  mcpServers?: string[];
  unavailableSources?: string[];
  uptime?: number;
}
export type ReadinessFetcher = () => Promise<BotReadiness | null>;

export interface DashboardDeps {
  db: Queryable;
  /** Absolute path to the built SPA (index.html + assets). Omit to serve API only. */
  staticDir?: string;
  log?: DashboardLogger;
  /** ACL viewer for company-brain routes; defaults to a no-access "unknown" role. */
  viewer?: ViewerScope;
  /** Whether brain memory routes may surface sensitivity='sensitive' rows. */
  showSensitive?: boolean;
  /** Fetches the bot's /ready for the health view; omit → bot status unknown. */
  fetchReadiness?: ReadinessFetcher;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(text);
}

const ConversationParams = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  userId: z.string().min(1).optional(),
  sentiment: z.enum(["positive", "negative"]).optional(),
});

const SummaryParams = z.object({
  since: z.string().datetime().optional(),
});

const FeedbackParams = z.object({
  // P0 surfaces the 👎 queue only; an explicit other value is rejected.
  sentiment: z.enum(["negative"]).default("negative"),
  limit: z.coerce.number().int().positive().optional(),
});

const EntityListParams = z.object({
  type: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const GraphParams = z.object({
  types: z.string().min(1).optional(), // comma-separated entity types
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  nodeLimit: z.coerce.number().int().positive().optional(),
});

const MemoryParams = z.object({
  category: z.string().min(1).optional(),
  sourceType: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  search: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const PersonaListParams = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

const ActivityParams = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

/** Parse search params against a Zod schema; null on failure (→ 400). */
function parse<T>(schema: z.ZodType<T>, params: URLSearchParams): T | null {
  const r = schema.safeParse(Object.fromEntries(params.entries()));
  return r.success ? r.data : null;
}

async function handleApi(
  deps: DashboardDeps,
  pathname: string,
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  if (pathname === "/api/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (pathname === "/api/summary") {
    const q = parse(SummaryParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    sendJson(res, 200, await getSummary(deps.db, { since: q.since }));
    return;
  }

  if (pathname === "/api/conversations") {
    const q = parse(ConversationParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    const items = await listConversations(deps.db, q);
    sendJson(res, 200, { items, limit: q.limit ?? null, offset: q.offset ?? 0 });
    return;
  }

  if (pathname === "/api/feedback") {
    const q = parse(FeedbackParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    const items = await listNegativeFeedback(deps.db, { limit: q.limit });
    sendJson(res, 200, { items });
    return;
  }

  const traceMatch = /^\/api\/traces\/([^/]+)$/.exec(pathname);
  if (traceMatch) {
    const traceId = decodeURIComponent(traceMatch[1]);
    const trace = await getTrace(deps.db, traceId);
    if (!trace) return sendJson(res, 404, { error: "trace not found" });
    sendJson(res, 200, trace);
    return;
  }

  // ── Company-brain routes (ACL-enforced via the viewer) ───────────────────
  const viewer = deps.viewer ?? dashboardViewerScope("unknown");
  const showSensitive = deps.showSensitive ?? false;

  if (pathname === "/api/entities") {
    const q = parse(EntityListParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    sendJson(res, 200, { items: await listEntities(deps.db, viewer, q) });
    return;
  }

  const entityMatch = /^\/api\/entities\/([^/]+)$/.exec(pathname);
  if (entityMatch) {
    const id = Number(decodeURIComponent(entityMatch[1]));
    if (!Number.isInteger(id)) return sendJson(res, 400, { error: "invalid entity id" });
    const detail = await getEntityDetail(deps.db, id, viewer);
    if (!detail) return sendJson(res, 404, { error: "entity not found" });
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === "/api/graph") {
    const q = parse(GraphParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    const types = q.types ? q.types.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    sendJson(res, 200, await getGraph(deps.db, viewer, { types, minConfidence: q.minConfidence, nodeLimit: q.nodeLimit }));
    return;
  }

  if (pathname === "/api/memories") {
    const q = parse(MemoryParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    const items = await listMemories(deps.db, viewer, { ...q, showSensitive });
    sendJson(res, 200, { items });
    return;
  }

  if (pathname === "/api/personas") {
    const q = parse(PersonaListParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    sendJson(res, 200, { items: await listPersonas(deps.db, q) });
    return;
  }

  const personaMatch = /^\/api\/personas\/([^/]+)$/.exec(pathname);
  if (personaMatch) {
    const userId = decodeURIComponent(personaMatch[1]);
    const persona = await getPersona(deps.db, userId);
    if (!persona) return sendJson(res, 404, { error: "persona not found" });
    sendJson(res, 200, persona);
    return;
  }

  // ── System health (SRE) ──────────────────────────────────────────────────
  if (pathname === "/api/activity") {
    const q = parse(ActivityParams, params);
    if (!q) return sendJson(res, 400, { error: "invalid query parameters" });
    sendJson(res, 200, await getActivity(deps.db, { limit: q.limit }));
    return;
  }

  if (pathname === "/api/system") {
    // Proxy the bot's /ready; never fail the dashboard if the bot is unreachable.
    let bot: BotReadiness | null = null;
    if (deps.fetchReadiness) {
      try {
        bot = await deps.fetchReadiness();
      } catch {
        bot = null;
      }
    }
    sendJson(res, 200, { bot });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function streamFile(file: string, res: http.ServerResponse): void {
  res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.writeHead(200);
  fs.createReadStream(file).pipe(res);
}

/**
 * Serve a built SPA: real files are served directly; an unknown path WITHOUT a
 * file extension falls back to index.html (client-side routing), while a
 * missing path WITH an extension (a real asset) 404s rather than returning HTML.
 * A resolved path escaping the static root is refused (defense in depth — HTTP
 * clients/servers normalize `..`, but the guard stays).
 */
function serveStatic(staticDir: string, pathname: string, res: http.ServerResponse): void {
  const root = path.resolve(staticDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "bad path" });
  }
  const candidate = path.resolve(root, "." + (decoded === "/" ? "/index.html" : decoded));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return streamFile(candidate, res);
  }
  if (path.extname(decoded) !== "") {
    return sendJson(res, 404, { error: "not found" });
  }
  const index = path.join(root, "index.html");
  if (fs.existsSync(index)) return streamFile(index, res);
  sendJson(res, 404, { error: "not found" });
}

export function createDashboardServer(deps: DashboardDeps): http.Server {
  const log = deps.log ?? { error: () => {} };
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method not allowed" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      handleApi(deps, pathname, url.searchParams, res).catch((err) => {
        log.error({ err, pathname }, "dashboard api error");
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }

    if (deps.staticDir) {
      serveStatic(deps.staticDir, pathname, res);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
}
