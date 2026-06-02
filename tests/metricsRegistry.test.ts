import { describe, it, expect, beforeEach } from "vitest";

import {
  record,
  snapshot,
  renderPrometheus,
  reset,
} from "../src/metrics/registry.js";

describe("metrics registry", () => {
  beforeEach(() => {
    reset();
  });

  describe("record + snapshot", () => {
    it("starts empty", () => {
      const s = snapshot();
      expect(s.totalRequests).toBe(0);
      expect(s.totalErrors).toBe(0);
      expect(s.totalDurationMs).toBe(0);
      expect(s.totalInputTokens).toBe(0);
      expect(s.totalOutputTokens).toBe(0);
      expect(s.totalCostUsd).toBe(0);
      expect(s.byType).toEqual({});
    });

    it("accumulates counts and summed metrics across records", () => {
      record({
        type: "mention",
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      });
      record({
        type: "dm",
        durationMs: 200,
        inputTokens: 20,
        outputTokens: 15,
        costUsd: 0.02,
      });

      const s = snapshot();
      expect(s.totalRequests).toBe(2);
      expect(s.totalErrors).toBe(0);
      expect(s.totalDurationMs).toBe(300);
      expect(s.totalInputTokens).toBe(30);
      expect(s.totalOutputTokens).toBe(20);
      expect(s.totalCostUsd).toBeCloseTo(0.03, 10);
    });

    it("counts requests by envelope type", () => {
      record({ type: "mention", durationMs: 1 });
      record({ type: "mention", durationMs: 1 });
      record({ type: "dm", durationMs: 1 });
      record({ type: "slash_command", durationMs: 1 });

      const s = snapshot();
      expect(s.byType.mention).toBe(2);
      expect(s.byType.dm).toBe(1);
      expect(s.byType.slash_command).toBe(1);
    });

    it("increments the error counter when isError is true (and still counts the request)", () => {
      record({ type: "mention", durationMs: 50, isError: true });
      record({ type: "mention", durationMs: 60 });

      const s = snapshot();
      expect(s.totalRequests).toBe(2);
      expect(s.totalErrors).toBe(1);
      expect(s.totalDurationMs).toBe(110);
    });

    it("treats token/cost fields as optional (defaults to 0 contribution)", () => {
      record({ type: "dm", durationMs: 5 });

      const s = snapshot();
      expect(s.totalRequests).toBe(1);
      expect(s.totalInputTokens).toBe(0);
      expect(s.totalOutputTokens).toBe(0);
      expect(s.totalCostUsd).toBe(0);
    });
  });

  describe("renderPrometheus", () => {
    it("emits valid Prometheus metric lines for the aggregate counters", () => {
      record({
        type: "mention",
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      });
      record({ type: "dm", durationMs: 50, isError: true });

      const text = renderPrometheus();

      // HELP/TYPE metadata lines present for the core metrics.
      expect(text).toMatch(/# HELP sentinel_requests_total/);
      expect(text).toMatch(/# TYPE sentinel_requests_total counter/);
      expect(text).toMatch(/# TYPE sentinel_errors_total counter/);

      // Aggregate sample lines with the accumulated values.
      expect(text).toMatch(/^sentinel_requests_total 2$/m);
      expect(text).toMatch(/^sentinel_errors_total 1$/m);
      expect(text).toMatch(/^sentinel_request_duration_ms_sum 150$/m);
      expect(text).toMatch(/^sentinel_input_tokens_total 10$/m);
      expect(text).toMatch(/^sentinel_output_tokens_total 5$/m);
      expect(text).toMatch(/^sentinel_cost_usd_total 0\.01$/m);

      // Per-type labelled counter.
      expect(text).toMatch(/^sentinel_requests_total\{type="mention"\} 1$/m);
      expect(text).toMatch(/^sentinel_requests_total\{type="dm"\} 1$/m);

      // Every non-comment line follows `name value` shape.
      const sampleLines = text
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.startsWith("#"));
      expect(sampleLines.length).toBeGreaterThan(0);
      for (const line of sampleLines) {
        expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?$/);
      }
    });

    it("renders zeroed totals on a fresh registry", () => {
      const text = renderPrometheus();
      expect(text).toMatch(/^sentinel_requests_total 0$/m);
      expect(text).toMatch(/^sentinel_errors_total 0$/m);
    });
  });

  describe("reset", () => {
    it("clears all accumulated state", () => {
      record({
        type: "mention",
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.5,
        isError: true,
      });

      reset();

      const s = snapshot();
      expect(s.totalRequests).toBe(0);
      expect(s.totalErrors).toBe(0);
      expect(s.totalDurationMs).toBe(0);
      expect(s.totalInputTokens).toBe(0);
      expect(s.totalOutputTokens).toBe(0);
      expect(s.totalCostUsd).toBe(0);
      expect(s.byType).toEqual({});
    });
  });
});
