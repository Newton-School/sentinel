import "dotenv/config";
import { z } from "zod";

export const envSchema = z
  .object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  BOT_USER_ID: z.string().min(1),

  // Agentic harness selector. 'cli' = the legacy Claude CLI subprocess;
  // 'openai' = the in-process OpenAI Agents SDK loop. Defaults to 'cli' so the
  // migration ships dark until explicitly flipped (see HARNESS in .env.example).
  HARNESS: z.enum(["cli", "openai"]).default("cli"),
  // Path to the Claude CLI (legacy 'cli' harness only).
  CLAUDE_BIN: z.string().default("claude"),
  // OpenAI key — powers the 'openai' harness reply loop AND fact extraction +
  // embeddings. OPENAI_API_KEY is preferred; MEMORY_EMBEDDING_API_KEY remains a
  // fallback so an embeddings-only config keeps working. (No ANTHROPIC_API_KEY.)
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Default model for the 'openai' harness reply loop (GPT-5-class). The SDK's
  // own default is gpt-5.4-mini; bump to a larger GPT-5-class tier here when you
  // want more headroom (add its official price to modelPricing.ts first).
  OPENAI_REPLY_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  // Agent-loop cost guards (openai harness): hard turn cap + optional cumulative
  // output-token budget that aborts the loop when exceeded.
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(12),
  AGENT_TOKEN_BUDGET: z.coerce.number().int().positive().optional(),

  // Analytics route (Project Atlas brain) — always on. An analytics-classified
  // message is answered by the Atlas brain over Metabase. ANALYTICS_MODEL pins a
  // (typically stronger) model for that route; ANALYTICS_CLAUDE_MODEL is the
  // deprecated alias kept one release for back-compat.
  ANALYTICS_MODEL: z.string().min(1).optional(),
  ANALYTICS_CLAUDE_MODEL: z.string().min(1).optional(),

  // Metabase (optional — bot starts without it)
  METABASE_URL: z.string().url().optional(),
  METABASE_USERNAME: z.string().min(1).optional(),
  METABASE_PASSWORD: z.string().min(1).optional(),
  // API-key auth (X-API-KEY) — alternative to username/password; required for
  // headless/EC2 against an SSO Metabase. When set, it takes precedence.
  METABASE_API_KEY: z.string().min(1).optional(),

  // GitHub (optional)
  GITHUB_TOKEN: z.string().min(1).optional(),

  // Notion (optional)
  NOTION_API_KEY: z.string().min(1).optional(),

  // Slack search (user token for search:read scope)
  SLACK_USER_TOKEN: z.string().startsWith("xoxp-").optional(),

  // Google Workspace (for Gmail, Calendar, Drive/Transcripts)
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),

  // OpenAI embeddings for hybrid retrieval (optional). Enabled at RUNTIME via
  // MEMORY_EMBEDDINGS=1 (kill-switch style); without a key the embedder is a
  // logged no-op and retrieval stays BM25-only — never a boot failure.
  MEMORY_EMBEDDING_API_KEY: z.string().min(1).optional(),
  MEMORY_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  HEALTH_CHECK_PORT: z.coerce.number().default(8930),

  SQLITE_DB_PATH: z.string().default("./sentinel.db"),

  // Entry gate: access is granted to members of this Slack user group (resolved
  // by handle) plus SENTINEL_OWNER_USER_ID. Requires the bot's `usergroups:read`
  // scope. ALLOWED_USER_IDS no longer gates entry (kept for the memory-founder
  // default below).
  SENTINEL_ACCESS_GROUP_HANDLE: z.string().min(1).default("sentinel-access-group"),
  // Owner — always allowed (so a group-resolution failure can't lock you out)
  // and rendered as the @mention in the denial reply to non-members.
  SENTINEL_OWNER_USER_ID: z.string().min(1).optional(),

  ALLOWED_USER_IDS: z
    .string()
    .transform((s) => s.split(",").map((id) => id.trim()).filter(Boolean))
    .refine(
      (arr) => arr.length > 0,
      "ALLOWED_USER_IDS must list at least one Slack user ID",
    ),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  })
  .refine(
    (env) => {
      const googleVars = [
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REFRESH_TOKEN,
      ];
      const count = googleVars.filter(Boolean).length;
      return count === 0 || count === 3;
    },
    {
      message:
        "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must all be set together or all be unset",
    },
  )
  .refine(
    // The OpenAI harness drives the reply loop through the OpenAI API, so it
    // needs a key. OPENAI_API_KEY is preferred; MEMORY_EMBEDDING_API_KEY is the
    // same-account fallback (mirrors openaiApiKey()). The 'cli' harness is exempt.
    (env) => env.HARNESS !== "openai" || Boolean(env.OPENAI_API_KEY || env.MEMORY_EMBEDDING_API_KEY),
    {
      message: "HARNESS=openai requires OPENAI_API_KEY (or MEMORY_EMBEDDING_API_KEY as a fallback)",
    },
  );

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
