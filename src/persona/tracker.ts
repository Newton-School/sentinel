import { getDb } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import { upsertTrait } from "./store.js";
import type { QueryCategory } from "./types.js";

const log = createLogger("persona-tracker");

const CATEGORY_KEYWORDS: Record<QueryCategory, string[]> = {
  placements: [
    "placement", "placements", "employer", "candidate", "rejection",
    "offer", "hiring partner", "placed", "unplaced", "job ready",
    "interview", "shortlist", "selection", "recruiter", "company tie-up",
    "package", "ctc", "salary",
  ],
  admissions: [
    "admission", "admissions", "funnel", "conversion", "counselor",
    "enrollment", "lead", "cohort", "campus", "application",
    "lead-to-enrollment", "registration", "intake", "batch",
    "counsellor", "inquiry", "enquiry",
  ],
  student_health: [
    "student health", "support escalation", "dropout", "sentiment",
    "student issue", "complaint", "student experience", "attendance",
    "grievance", "student risk", "mental health", "feedback",
    "satisfaction", "nps", "student support",
  ],
  product_execution: [
    "product", "roadmap", "feature", "sprint", "velocity",
    "pr", "pull request", "merge", "deploy", "deployment", "build",
    "ci", "cd", "pipeline", "bug", "issue", "commit", "branch",
    "release", "code", "repo", "github", "test", "coverage",
    "incident", "outage", "downtime", "jira", "blocker", "launch",
    "engineering", "ux", "ui", "design",
  ],
  finance: [
    "revenue", "finance", "sales", "arr", "mrr", "pricing", "billing",
    "subscription", "churn", "ltv", "cac", "money", "income",
    "profit", "margin", "cost", "spend", "budget", "collection",
    "expense", "cash flow", "burn rate", "runway",
  ],
  nst_operations: [
    "nst", "campus operations", "internship", "academic", "schedule",
    "cohort health", "operational", "campus", "hostel", "infrastructure",
    "faculty", "curriculum", "semester", "exam", "assessment",
  ],
  general: [],
};

export function categorizeQuery(text: string): QueryCategory {
  const lower = text.toLowerCase();
  const scores: Record<QueryCategory, number> = {
    placements: 0,
    admissions: 0,
    student_health: 0,
    product_execution: 0,
    finance: 0,
    nst_operations: 0,
    general: 0,
  };

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === "general") continue;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        scores[category as QueryCategory]++;
      }
    }
  }

  const best = Object.entries(scores).reduce((a, b) =>
    a[1] >= b[1] ? a : b
  );

  return best[1] > 0 ? (best[0] as QueryCategory) : "general";
}

export interface TrackQueryOptions {
  userId: string;
  channelId: string;
  threadTs: string;
  queryText: string;
  responseText?: string;
  responseDurationMs?: number;
  sourcesUsed?: string[];
}

export function trackQuery(opts: TrackQueryOptions): void {
  const db = getDb();
  const category = categorizeQuery(opts.queryText);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO query_log (user_id, channel_id, thread_ts, query_text, category, response_text, response_duration_ms, sources_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.userId,
    opts.channelId,
    opts.threadTs,
    opts.queryText,
    category,
    opts.responseText ?? null,
    opts.responseDurationMs ?? null,
    opts.sourcesUsed ? JSON.stringify(opts.sourcesUsed) : null,
    now
  );

  if (category !== "general") {
    upsertTrait(opts.userId, "focus_area", category);
    log.info({ userId: opts.userId, category }, "Tracked query and updated persona trait");
  } else {
    log.debug({ userId: opts.userId }, "Tracked general query (no trait update)");
  }
}
