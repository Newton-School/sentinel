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
};
