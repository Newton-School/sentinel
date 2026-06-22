/**
 * Dashboard service entrypoint. Opens the read-only pool, starts the HTTP API
 * (serving the built SPA when DASHBOARD_STATIC_DIR is set), and shuts down
 * cleanly. This is a separate process from the bot — no Slack socket, no
 * Playwright, no migrations.
 */

import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { getReadOnlyPool, closeReadOnlyPool } from "./pool.js";
import { createDashboardServer } from "./server.js";

const log = createLogger("dashboard");

// Built SPA directory, injected by the container image (wired in with the SPA).
// Unset → API-only (e.g. when running the API alone in dev).
const staticDir = process.env.DASHBOARD_STATIC_DIR;

const db = getReadOnlyPool();
const server = createDashboardServer({ db, staticDir, log });

server.listen(config.DASHBOARD_PORT, () => {
  log.info({ port: config.DASHBOARD_PORT, staticDir: staticDir ?? null }, "Dashboard server listening");
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
