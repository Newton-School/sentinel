import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

import { validateDashboard, extractMetricNames } from "../scripts/provision-grafana.js";

const DASHBOARD = JSON.parse(readFileSync("grafana/sentinel-llmops-dashboard.json", "utf8"));
const ALERTS = readFileSync("grafana/alerts/llmops-alerts.yaml", "utf8");

/**
 * The set of base metric names the code actually emits — computed by rendering
 * a populated registry + eval gauges, so a dashboard/alert that references a
 * metric the code never produces fails CI.
 */
async function emittedMetricNames(): Promise<Set<string>> {
  vi.resetModules();
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
  vi.doMock("../src/config.js", () => ({ config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" } }));
  const db = await import("../src/state/db.js");
  const registry = await import("../src/metrics/registry.js");
  const store = await import("../evals/store.js");
  const gauges = await import("../src/metrics/evalGauges.js");

  db.getDb();
  registry.reset();
  registry.record({ type: "mention", durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
  registry.recordLlmMetric({ provider: "openai", model: "gpt-4o-mini", operation: "extract", status: "ok", inputTokens: 1, outputTokens: 1, costUsd: 0.01, latencyMs: 10 });
  registry.recordFeedback("positive");
  store.recordEvalRun({ runId: "r", suite: "extraction", nCases: 1, nPass: 1, meanScore: 1, ranAt: "2026-06-28T00:00:00.000Z" });

  const text = registry.renderPrometheus() + gauges.renderEvalGauges();
  const names = new Set<string>();
  for (const m of text.match(/sentinel_[a-z0-9_]+/g) ?? []) {
    names.add(m.replace(/_(bucket|sum|count)$/, ""));
  }
  db.closeDb();
  return names;
}

describe("grafana dashboard", () => {
  beforeEach(() => vi.resetModules());

  it("is structurally valid", () => {
    expect(validateDashboard(DASHBOARD)).toEqual([]);
  });

  it("has the expected LLMOps panels", () => {
    const titles = (DASHBOARD.panels as Array<{ title: string }>).map((p) => p.title).join(" | ");
    expect(titles).toMatch(/cost/i);
    expect(titles).toMatch(/token/i);
    expect(titles).toMatch(/latency/i);
    expect(titles).toMatch(/error/i);
    expect(titles).toMatch(/feedback/i);
    expect(titles).toMatch(/eval/i);
  });

  it("only references metrics the code actually emits", async () => {
    const emitted = await emittedMetricNames();
    const referenced = extractMetricNames(DASHBOARD);
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((m) => !emitted.has(m));
    expect(missing, `dashboard references metrics not emitted by the code: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("grafana alert rules", () => {
  it("defines the expected alerts", () => {
    for (const name of [
      "SentinelLLMErrorRateHigh",
      "SentinelLLMLatencyP95High",
      "SentinelLLMCostSpike",
      "SentinelNegativeFeedbackSpike",
      "SentinelEvalRegression",
    ]) {
      expect(ALERTS).toContain(name);
    }
  });

  it("only references metrics the code actually emits", async () => {
    const emitted = await emittedMetricNames();
    const referenced = new Set<string>();
    for (const m of ALERTS.match(/sentinel_[a-z0-9_]+/g) ?? []) {
      referenced.add(m.replace(/_(bucket|sum|count)$/, ""));
    }
    const missing = [...referenced].filter((m) => !emitted.has(m));
    expect(missing, `alerts reference metrics not emitted by the code: ${missing.join(", ")}`).toEqual([]);
  });
});
