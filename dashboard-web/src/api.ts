// Typed client for the read-only dashboard API. Shapes mirror src/dashboard/queries.ts.

export type Sentiment = "positive" | "negative";

export interface Summary {
  since: string | null;
  totalQueries: number;
  distinctUsers: number;
  positiveCount: number;
  negativeCount: number;
  positiveRatio: number | null;
  costUsd: number;
}

export interface Conversation {
  traceId: string | null;
  channelId: string;
  replyTs: string;
  userId: string | null;
  displayName: string | null;
  question: string | null;
  answer: string | null;
  sentiment: Sentiment | null;
  createdAt: string;
}

export interface TraceCall {
  callId: string;
  operation: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  status: string;
  errorKind: string | null;
  numTurns: number | null;
  promptVersion: string | null;
  createdAt: string;
}

export interface TraceFeedback {
  sentiment: Sentiment;
  reaction: string;
  score: number;
  reactorUserId: string;
  createdAt: string;
}

export interface TraceTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number | null;
  promptVersion: string | null;
  latencyMs: number;
  callCount: number;
}

export interface TraceDetail {
  traceId: string;
  reply: {
    channelId: string;
    replyTs: string;
    userId: string | null;
    question: string | null;
    answer: string | null;
    createdAt: string;
  } | null;
  calls: TraceCall[];
  feedback: TraceFeedback[];
  totals: TraceTotals;
}

export interface NegativeFeedback {
  feedbackId: number;
  traceId: string | null;
  channelId: string;
  replyTs: string;
  reactorUserId: string;
  question: string | null;
  answer: string | null;
  model: string | null;
  promptVersion: string | null;
  costUsd: number | null;
  createdAt: string;
}

// ── Company brain ──────────────────────────────────────────────────────────

export interface EntitySummary {
  id: number;
  type: string;
  canonicalName: string;
  aliases: string[];
  status: string;
  visibility: string;
  factCount: number;
  slackUserId: string | null;
  email: string | null;
  updatedAt: string;
}

export interface GraphNode { id: number; type: string; name: string; factCount: number; }
export interface GraphEdge { src: number; dst: number; relation: string; confidence: number; }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; capped: boolean; }

export interface Relationship {
  relation: string;
  direction: "out" | "in";
  otherId: number;
  otherName: string;
  otherType: string;
  confidence: number;
}

export interface MemorySummary {
  id: number;
  text: string;
  category: string;
  entities: string[];
  sourceType: string;
  sourceLabel: string | null;
  speaker: string | null;
  assertedAt: string | null;
  evidenceQuote: string | null;
  confidence: number;
  verified: boolean;
  visibility: string;
  sensitivity: string;
  createdAt: string;
}

export interface EntityDetail {
  entity: EntitySummary;
  profileMd: string | null;
  builtAt: string | null;
  relationships: Relationship[];
  backingFacts: MemorySummary[];
}

export interface PersonaSummary { userId: string; displayName: string; role: string | null; updatedAt: string; }
export interface PersonaTrait { label: string; value: string; confidence: number; evidenceCount: number; updatedAt: string; }
export interface PersonaDetail extends PersonaSummary { traits: PersonaTrait[]; }

// ── System health ────────────────────────────────────────────────────────────

export interface IngestCursor { source: string; cursor: string; updatedAt: string; }
export interface JoinedMeeting { eventId: string; joinedAt: number; }
export interface FailedCall {
  callId: string; traceId: string; operation: string; errorKind: string | null;
  model: string; latencyMs: number | null; userId: string | null; question: string | null; createdAt: string;
}
export interface Activity { cursors: IngestCursor[]; meetings: JoinedMeeting[]; failedCalls: FailedCall[]; }
export interface BotReadiness {
  status?: string; slack?: string; database?: string;
  mcpServers?: string[]; unavailableSources?: string[]; uptime?: number;
}
export interface SystemStatus { bot: BotReadiness | null; }

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  summary: (since?: string) => get<Summary>(`/api/summary${qs({ since })}`),
  conversations: (p: { userId?: string; sentiment?: Sentiment; limit?: number } = {}) =>
    get<{ items: Conversation[] }>(`/api/conversations${qs(p)}`),
  trace: (id: string) => get<TraceDetail>(`/api/traces/${encodeURIComponent(id)}`),
  negativeFeedback: (limit?: number) =>
    get<{ items: NegativeFeedback[] }>(`/api/feedback${qs({ sentiment: "negative", limit })}`),
  entities: (p: { type?: string; search?: string; limit?: number } = {}) =>
    get<{ items: EntitySummary[] }>(`/api/entities${qs(p)}`),
  entity: (id: number) => get<EntityDetail>(`/api/entities/${id}`),
  graph: (p: { types?: string; nodeLimit?: number } = {}) => get<Graph>(`/api/graph${qs(p)}`),
  memories: (p: { category?: string; sourceType?: string; search?: string; since?: string; limit?: number } = {}) =>
    get<{ items: MemorySummary[] }>(`/api/memories${qs(p)}`),
  personas: (limit?: number) => get<{ items: PersonaSummary[] }>(`/api/personas${qs({ limit })}`),
  persona: (userId: string) => get<PersonaDetail>(`/api/personas/${encodeURIComponent(userId)}`),
  activity: (limit?: number) => get<Activity>(`/api/activity${qs({ limit })}`),
  system: () => get<SystemStatus>(`/api/system`),
};

