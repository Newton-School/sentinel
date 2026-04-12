import http from "node:http";
import { createLogger } from "../logging/logger.js";

const log = createLogger("health");

export interface HealthStatus {
  status: "ok" | "degraded";
  uptime: number;
  slack: "connected" | "disconnected";
  database: "connected" | "error";
  mcpServers: string[];
  unavailableSources: string[];
}

export function createHealthServer(
  getStatus: () => HealthStatus
): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/health") {
      const status = getStatus();
      const code = status.status === "ok" ? 200 : 503;
      res.writeHead(code);
      res.end(JSON.stringify(status));
      return;
    }

    if (req.url === "/ready") {
      const status = getStatus();
      const ready = status.slack === "connected" && status.database === "connected";
      const code = ready ? 200 : 503;
      res.writeHead(code);
      res.end(JSON.stringify({ ready }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  return server;
}

export function startHealthServer(
  port: number,
  getStatus: () => HealthStatus
): http.Server {
  const server = createHealthServer(getStatus);
  server.listen(port, () => {
    log.info({ port }, "Health check server listening");
  });
  return server;
}
