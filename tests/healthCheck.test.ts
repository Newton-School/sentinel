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

  // Liveness uptime is sourced independently of the readiness status fn so the
  // DB SELECT 1 can never flap /health. Tests pass the readiness uptime here so
  // both endpoints report a consistent value.
  function listen(
    fn: () => HealthStatus,
    getUptime: () => number = () => fn().uptime,
    getMetricsText?: () => string
  ): Promise<void> {
    statusFn = fn;
    server = createHealthServer(statusFn, getUptime, getMetricsText);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  function close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  const healthyStatus = (): HealthStatus => ({
    status: "ok",
    uptime: 123,
    slack: "connected",
    database: "connected",
    mcpServers: ["slack-search", "gmail"],
    unavailableSources: ["Metabase", "GitHub"],
  });

  beforeEach(async () => {
    await listen(healthyStatus);
  });

  afterEach(async () => {
    await close();
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

  // Raw-text fetch for endpoints (like /metrics) that return non-JSON bodies.
  function fetchRaw(
    path: string
  ): Promise<{ status: number; contentType: string | undefined; text: string }> {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"],
            text: data,
          });
        });
      }).on("error", reject);
    });
  }

  // Reattach the server with a fresh status function for a single test.
  async function reattach(
    fn: () => HealthStatus,
    getUptime?: () => number,
    getMetricsText?: () => string
  ): Promise<void> {
    await close();
    await listen(fn, getUptime, getMetricsText);
  }

  describe("/health (liveness)", () => {
    it("returns 200 with status alive when fully healthy", async () => {
      const res = await fetch("/health");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).status).toBe("alive");
    });

    it("includes uptime", async () => {
      const res = await fetch("/health");
      expect((res.body as Record<string, unknown>).uptime).toBe(123);
    });

    it("returns 200 even when slack is disconnected (liveness must not flap)", async () => {
      await reattach(() => ({
        status: "degraded",
        uptime: 5,
        slack: "disconnected",
        database: "connected",
        mcpServers: [],
        unavailableSources: [],
      }));

      const res = await fetch("/health");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).status).toBe("alive");
    });

    it("returns 200 even when the database check fails (liveness must not flap)", async () => {
      await reattach(() => ({
        status: "degraded",
        uptime: 7,
        slack: "connected",
        database: "error",
        mcpServers: [],
        unavailableSources: [],
      }));

      const res = await fetch("/health");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).status).toBe("alive");
      expect((res.body as Record<string, unknown>).uptime).toBe(7);
    });

    it("returns 200 even when both slack and database are down", async () => {
      await reattach(() => ({
        status: "degraded",
        uptime: 9,
        slack: "disconnected",
        database: "error",
        mcpServers: [],
        unavailableSources: [],
      }));

      const res = await fetch("/health");
      expect(res.status).toBe(200);
    });

    it("does not invoke the readiness status function (decoupled from slack/db state)", async () => {
      // The liveness path must not depend on the (potentially expensive /
      // flaky) readiness check. uptime is sourced from a separate provider; if
      // getReadiness is never called, the DB SELECT 1 can never flap liveness.
      const spy = vi.fn(healthyStatus);
      // Explicit uptime provider so the default helper doesn't call the spy.
      await reattach(spy, () => 42);

      const res = await fetch("/health");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).uptime).toBe(42);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("/ready (readiness)", () => {
    it("returns 200 with status ok when slack and db are healthy", async () => {
      const res = await fetch("/ready");
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).status).toBe("ok");
    });

    it("includes the full readiness fields", async () => {
      const res = await fetch("/ready");
      const body = res.body as Record<string, unknown>;
      expect(body.uptime).toBe(123);
      expect(body.slack).toBe("connected");
      expect(body.database).toBe("connected");
      expect(body.mcpServers).toEqual(["slack-search", "gmail"]);
      expect(body.unavailableSources).toEqual(["Metabase", "GitHub"]);
    });

    it("returns 503 with status degraded when slack is disconnected", async () => {
      await reattach(() => ({
        status: "degraded",
        uptime: 10,
        slack: "disconnected",
        database: "connected",
        mcpServers: [],
        unavailableSources: [],
      }));

      const res = await fetch("/ready");
      expect(res.status).toBe(503);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe("degraded");
      expect(body.slack).toBe("disconnected");
      expect(body.database).toBe("connected");
    });

    it("returns 503 when the database check throws / errors", async () => {
      await reattach(() => ({
        status: "degraded",
        uptime: 0,
        slack: "connected",
        database: "error",
        mcpServers: [],
        unavailableSources: [],
      }));

      const res = await fetch("/ready");
      expect(res.status).toBe(503);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe("degraded");
      expect(body.database).toBe("error");
    });

    it("returns 503 when both slack and db are down", async () => {
      await reattach(() => ({
        status: "degraded",
        uptime: 0,
        slack: "disconnected",
        database: "error",
        mcpServers: [],
        unavailableSources: [],
      }));

      const res = await fetch("/ready");
      expect(res.status).toBe(503);
      expect((res.body as Record<string, unknown>).status).toBe("degraded");
    });
  });

  describe("/metrics (Prometheus)", () => {
    const PROM_TEXT =
      "# HELP sentinel_requests_total Total requests\n" +
      "# TYPE sentinel_requests_total counter\n" +
      "sentinel_requests_total 5\n";

    it("returns 200 with the Prometheus text from the provider", async () => {
      await reattach(healthyStatus, undefined, () => PROM_TEXT);

      const res = await fetchRaw("/metrics");
      expect(res.status).toBe(200);
      expect(res.text).toBe(PROM_TEXT);
    });

    it("serves the Prometheus text content type", async () => {
      await reattach(healthyStatus, undefined, () => PROM_TEXT);

      const res = await fetchRaw("/metrics");
      expect(res.contentType).toBe("text/plain; version=0.0.4");
    });

    it("does not consult the readiness status function for /metrics", async () => {
      const spy = vi.fn(healthyStatus);
      await reattach(spy, () => 1, () => PROM_TEXT);

      const res = await fetchRaw("/metrics");
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });

    it("returns 404 for /metrics when no metrics provider is configured", async () => {
      // beforeEach attaches the server without a metrics provider.
      const res = await fetch("/metrics");
      expect(res.status).toBe(404);
    });
  });

  describe("unknown paths", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await fetch("/unknown");
      expect(res.status).toBe(404);
    });
  });
});
