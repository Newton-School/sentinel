/**
 * Dashboard-specific environment. Deliberately SEPARATE from the bot's
 * src/config.ts: that schema mandates Slack + OpenAI secrets the bot needs, but
 * the dashboard is the only Ingress-facing Sentinel surface and must hold the
 * absolute minimum — a SELECT-only DB URL and a few tunables — so a dashboard
 * compromise can't post to Slack or spend on the LLM API.
 */

import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DASHBOARD_PORT: z.coerce.number().default(8940),
  // Dedicated SELECT-only role in prod; falls back to DATABASE_URL in dev.
  DATABASE_URL_READONLY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Directory of the built SPA to serve; unset → API-only.
  DASHBOARD_STATIC_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type DashboardEnv = z.infer<typeof schema>;

/** Parse dashboard env from a process env object (defaults applied). */
export function loadDashboardEnv(env: NodeJS.ProcessEnv = process.env): DashboardEnv {
  return schema.parse(env);
}

export const dashboardEnv = loadDashboardEnv();
