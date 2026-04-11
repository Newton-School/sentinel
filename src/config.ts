import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  BOT_USER_ID: z.string().min(1),

  CLAUDE_BIN: z.string().default("claude"),
  ANTHROPIC_API_KEY: z.string().min(1),

  // Metabase (optional — bot starts without it)
  METABASE_URL: z.string().url().optional(),
  METABASE_USERNAME: z.string().min(1).optional(),
  METABASE_PASSWORD: z.string().min(1).optional(),

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

  SQLITE_DB_PATH: z.string().default("./sentinel.db"),

  ALLOWED_USER_IDS: z
    .string()
    .transform((s) => s.split(",").map((id) => id.trim()).filter(Boolean)),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
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
