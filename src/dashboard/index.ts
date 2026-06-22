/**
 * Dashboard service entrypoint. Opens the read-only pool, starts the HTTP API
 * (serving the built SPA when DASHBOARD_STATIC_DIR is set), and shuts down
 * cleanly. A separate process from the bot — no Slack socket, no Playwright, no
 * migrations, and (by design) none of the bot's secrets.
 */

import pino from "pino";
import { dashboardEnv } from "./env.js";
import { getReadOnlyPool, closeReadOnlyPool } from "./pool.js";
import { createDashboardServer } from "./server.js";
import { dashboardViewerScope } from "./brain.js";

const log = pino({ name: "dashboard", level: dashboardEnv.LOG_LEVEL });

const db = getReadOnlyPool();
const server = createDashboardServer({
  db,
  staticDir: dashboardEnv.DASHBOARD_STATIC_DIR,
  log,
  viewer: dashboardViewerScope(dashboardEnv.DASHBOARD_VIEWER_ROLE),
  showSensitive: dashboardEnv.DASHBOARD_SHOW_SENSITIVE,
});

server.listen(dashboardEnv.DASHBOARD_PORT, () => {
  log.info(
    { port: dashboardEnv.DASHBOARD_PORT, staticDir: dashboardEnv.DASHBOARD_STATIC_DIR ?? null },
    "Dashboard server listening"
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "Dashboard shutting down");
  server.close();
  await closeReadOnlyPool().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
