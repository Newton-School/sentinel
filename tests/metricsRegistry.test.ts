import { describe, it, expect, beforeEach } from "vitest";

import {
  record,
  recordLlmMetric,
  recordFeedback,
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

  describe("recordLlmMetric + LLM series", () => {
    it("emits labeled call counters by provider/model/operation/status", () => {
      recordLlmMetric({ provider: "openai", model: "gpt-4o-mini", operation: "extract", status: "ok", inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 120 });
      recordLlmMetric({ provider: "openai", model: "gpt-4o-mini", operation: "extract", status: "error", latencyMs: 50 });
      recordLlmMetric({ provider: "openai", model: "gpt-5.4-mini", operation: "reply", status: "ok", inputTokens: 1000, outputTokens: 200, costUsd: 0.02, latencyMs: 3000 });

      const text = renderPrometheus();
      expect(text).toMatch(/# TYPE sentinel_llm_calls_total counter/);
      expect(text).toContain('sentinel_llm_calls_total{provider="openai",model="gpt-4o-mini",operation="extract",status="ok"} 1');
      expect(text).toContain('sentinel_llm_calls_total{provider="openai",model="gpt-4o-mini",operation="extract",status="error"} 1');
      expect(text).toContain('sentinel_llm_calls_total{provider="openai",model="gpt-5.4-mini",operation="reply",status="ok"} 1');
    });

    it("accumulates token + cost counters by provider/model/operation", () => {
      recordLlmMetric({ provider: "openai", model: "gpt-4o-mini", operation: "extract", status: "ok", inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 10 });
      recordLlmMetric({ provider: "openai", model: "gpt-4o-mini", operation: "extract", status: "ok", inputTokens: 200, outputTokens: 25, costUsd: 0.02, latencyMs: 10 });

      const text = renderPrometheus();
      expect(text).toContain('sentinel_llm_input_tokens_total{provider="openai",model="gpt-4o-mini",operation="extract"} 300');
      expect(text).toContain('sentinel_llm_output_tokens_total{provider="openai",model="gpt-4o-mini",operation="extract"} 75');
      // cost via snapshot to avoid float-formatting brittleness
      const s = snapshot();
      expect(s.llm.costUsd['openai|gpt-4o-mini|extract']).toBeCloseTo(0.03, 10);
    });

    it("emits a latency histogram with cumulative buckets, +Inf == count, and matching sum", () => {
      for (const ms of [30, 75, 300, 3000]) {
        recordLlmMetric({ provider: "openai", model: "m", operation: "embed", status: "ok", latencyMs: ms });
      }
      const text = renderPrometheus();
      const labels = 'provider="openai",model="m",operation="embed"';
      expect(text).toMatch(/# TYPE sentinel_llm_latency_ms histogram/);
      // 30→le50; 75→le100; 300→le500; 3000→le5000 (cumulative)
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="50"} 1`);
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="100"} 2`);
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="250"} 2`);
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="500"} 3`);
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="5000"} 4`);
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="+Inf"} 4`);
      expect(text).toContain(`sentinel_llm_latency_ms_count{${labels}} 4`);
      expect(text).toContain(`sentinel_llm_latency_ms_sum{${labels}} 3405`);
    });

    it("counts latencies above the largest finite bucket only in +Inf", () => {
      recordLlmMetric({ provider: "openai", model: "gpt-5.4-mini", operation: "reply", status: "ok", latencyMs: 200000 });
      const text = renderPrometheus();
      const labels = 'provider="openai",model="gpt-5.4-mini",operation="reply"';
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="120000"} 0`);
      expect(text).toContain(`sentinel_llm_latency_ms_bucket{${labels},le="+Inf"} 1`);
      expect(text).toContain(`sentinel_llm_latency_ms_count{${labels}} 1`);
    });

    it("leaves the legacy aggregate series untouched (backward-compat)", () => {
      record({ type: "mention", durationMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
      recordLlmMetric({ provider: "openai", model: "gpt-4o-mini", operation: "extract", status: "ok", inputTokens: 999, latencyMs: 10 });

      const text = renderPrometheus();
      // The old request-scoped series still reflect ONLY record(), not recordLlmMetric().
      expect(text).toMatch(/^sentinel_requests_total 1$/m);
      expect(text).toMatch(/^sentinel_input_tokens_total 10$/m);
    });

    it("reset() clears the LLM series", () => {
      recordLlmMetric({ provider: "openai", model: "m", operation: "embed", status: "ok", latencyMs: 10 });
      reset();
      const text = renderPrometheus();
      expect(text).not.toContain('operation="embed"');
      expect(snapshot().llm.calls).toEqual({});
    });
  });

  describe("recordFeedback + feedback series", () => {
    it("counts feedback by sentiment and renders a labeled series", () => {
      recordFeedback("positive");
      recordFeedback("positive");
      recordFeedback("negative");

      const s = snapshot();
      expect(s.feedback.positive).toBe(2);
      expect(s.feedback.negative).toBe(1);

      const text = renderPrometheus();
      expect(text).toMatch(/# TYPE sentinel_feedback_total counter/);
      expect(text).toContain('sentinel_feedback_total{sentiment="positive"} 2');
      expect(text).toContain('sentinel_feedback_total{sentiment="negative"} 1');
    });

    it("reset() clears feedback counters", () => {
      recordFeedback("negative");
      reset();
      expect(snapshot().feedback).toEqual({ positive: 0, negative: 0 });
    });
  });
});
