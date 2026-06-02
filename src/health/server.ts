import http from "node:http";
import { createLogger } from "../logging/logger.js";

const log = createLogger("health");

/**
 * Readiness payload. Reported by `/ready` only. `/health` (liveness)
 * intentionally does NOT consume this — see `LivenessStatus`.
 */
export interface HealthStatus {
  status: "ok" | "degraded";
  uptime: number;
  slack: "connected" | "disconnected";
  database: "connected" | "error";
  mcpServers: string[];
  unavailableSources: string[];
}

/**
 * Liveness payload. `/health` returns this and is always 200 while the
 * process is up — it never factors in Slack connectivity or the DB check, so
 * a slow Socket Mode connect or a transient SQLite blip cannot flip it to 503
 * and trigger a K8s restart loop.
 */
export interface LivenessStatus {
  status: "alive";
  uptime: number;
}

export function createHealthServer(
  getReadiness: () => HealthStatus,
  getUptime: () => number = () => 0
): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    // Liveness: the process is up. Deliberately decoupled from Slack/DB state
    // so a slow connect or a transient DB blip never flaps the K8s probe.
    if (req.url === "/health") {
      const body: LivenessStatus = { status: "alive", uptime: getUptime() };
      res.writeHead(200);
      res.end(JSON.stringify(body));
      return;
    }

    // Readiness: 200 only when Slack is connected AND the DB SELECT 1 passes.
    // All degradation lives here.
    if (req.url === "/ready") {
      const status = getReadiness();
      const ready =
        status.slack === "connected" && status.database === "connected";
      res.writeHead(ready ? 200 : 503);
      res.end(JSON.stringify(status));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  return server;
}

export function startHealthServer(
  port: number,
  getReadiness: () => HealthStatus,
  getUptime?: () => number
): http.Server {
  const server = createHealthServer(getReadiness, getUptime);
  server.listen(port, () => {
    log.info({ port }, "Health check server listening");
  });
  return server;
}
