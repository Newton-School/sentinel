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
  // The bot's /ready URL, proxied by the health view (e.g. http://sentinel:8930/ready).
  // Unset → the health view shows bot status as unknown.
  BOT_READY_URL: z.string().url().optional(),
  // Slack workspace subdomain (e.g. "newtonschool" for newtonschool.slack.com).
  // When set, reply rows include a Slack permalink ("Open in Slack").
  DASHBOARD_SLACK_WORKSPACE: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // ACL role the dashboard views as. In the active 'founders' ACL mode this is
  // the whole gate (founder → sees the company brain; anything else → nothing),
  // so match the Ingress auth group to this role. Default 'founder'.
  DASHBOARD_VIEWER_ROLE: z.enum(["founder", "leadership", "manager", "member", "unknown"]).default("founder"),
  // Whether the memory browser may surface sensitivity='sensitive' facts.
  // (z.coerce.boolean treats any non-empty string as true, so parse explicitly.)
  DASHBOARD_SHOW_SENSITIVE: z
    .string()
    .default("0")
    .transform((s) => s === "1" || s.toLowerCase() === "true"),
});

export type DashboardEnv = z.infer<typeof schema>;

/** Parse dashboard env from a process env object (defaults applied). */
export function loadDashboardEnv(env: NodeJS.ProcessEnv = process.env): DashboardEnv {
  return schema.parse(env);
}

export const dashboardEnv = loadDashboardEnv();
