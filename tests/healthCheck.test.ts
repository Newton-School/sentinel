import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

// Mock config
vi.mock("../src/config.js", () => ({
  config: {
    SQLITE_DB_PATH: ":memory:",
    LOG_LEVEL: "silent",
    HEALTH_CHECK_PORT: 8080,
  },
}));

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

import { createHealthServer, type HealthStatus } from "../src/health/server.js";

describe("health check server", () => {
  let server: http.Server;
  let port: number;
  let statusFn: () => HealthStatus;

  beforeEach(async () => {
    statusFn = () => ({
      status: "ok",
      uptime: 123,
      slack: "connected",
      database: "connected",
      mcpServers: ["slack-search", "gmail"],
      unavailableSources: ["Metabase", "GitHub"],
    });

    server = createHealthServer(statusFn);
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function fetch(path: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(data),
          });
        });
      }).on("error", reject);
    });
  }

  describe("/health", () => {
    it("returns 200 with status ok", async () => {
      const res = await fetch("/health");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).status).toBe("ok");
    });

    it("includes uptime", async () => {
      const res = await fetch("/health");
      expect((res.body as Record<string, unknown>).uptime).toBe(123);
    });

    it("includes slack connection status", async () => {
      const res = await fetch("/health");
      expect((res.body as Record<string, unknown>).slack).toBe("connected");
    });

    it("includes database status", async () => {
      const res = await fetch("/health");
      expect((res.body as Record<string, unknown>).database).toBe("connected");
    });

    it("includes MCP servers list", async () => {
      const res = await fetch("/health");
      expect((res.body as Record<string, unknown>).mcpServers).toEqual(["slack-search", "gmail"]);
    });

    it("includes unavailable sources", async () => {
      const res = await fetch("/health");
      expect((res.body as Record<string, unknown>).unavailableSources).toEqual(["Metabase", "GitHub"]);
    });

    it("returns 503 when status is degraded", async () => {
      statusFn = () => ({
        status: "degraded",
        uptime: 10,
        slack: "disconnected",
        database: "connected",
        mcpServers: [],
        unavailableSources: [],
      });
      // Need to recreate server with new status fn
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = createHealthServer(statusFn);
      await new Promise<void>((resolve) => server.listen(0, () => resolve()));
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;

      const res = await fetch("/health");
      expect(res.status).toBe(503);
      expect((res.body as Record<string, unknown>).status).toBe("degraded");
    });
  });

  describe("/ready", () => {
    it("returns 200 when ready", async () => {
      const res = await fetch("/ready");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).ready).toBe(true);
    });

    it("returns 503 when not ready", async () => {
      statusFn = () => ({
        status: "degraded",
        uptime: 0,
        slack: "disconnected",
        database: "error",
        mcpServers: [],
        unavailableSources: [],
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = createHealthServer(statusFn);
      await new Promise<void>((resolve) => server.listen(0, () => resolve()));
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;

      const res = await fetch("/ready");
      expect(res.status).toBe(503);
      expect((res.body as Record<string, unknown>).ready).toBe(false);
    });
  });

  describe("unknown paths", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await fetch("/unknown");
      expect(res.status).toBe(404);
    });
  });
});
