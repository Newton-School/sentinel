import "dotenv/config";
import { z } from "zod";

export const envSchema = z
  .object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  BOT_USER_ID: z.string().min(1),

  CLAUDE_BIN: z.string().default("claude"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

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

  HEALTH_CHECK_PORT: z.coerce.number().default(8930),

  SQLITE_DB_PATH: z.string().default("./sentinel.db"),

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
