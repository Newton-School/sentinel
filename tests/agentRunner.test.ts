import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted spies referenced by the (hoisted) vi.mock factories.
const h = vi.hoisted(() => ({
  agentCtor: vi.fn(),
  runMock: vi.fn(),
  onMock: vi.fn(),
  setKeyMock: vi.fn(),
  setTracingMock: vi.fn(),
  recordLlmCall: vi.fn(),
  computeCostUsd: vi.fn(() => 0.05),
  buildMcpServers: vi.fn(),
}));

// The runner uses a Runner instance (so it can attach a token-budget hook via
// .on). The mock Runner records hook registrations and delegates run() to runMock.
vi.mock("@openai/agents", () => ({
  Agent: class {
    constructor(opts: unknown) {
      h.agentCtor(opts);
    }
  },
  Runner: class {
    on(event: string, listener: (...a: unknown[]) => void) {
      h.onMock(event, listener);
      return this;
    }
    run(...a: unknown[]) {
      return h.runMock(...a);
    }
  },
  setDefaultOpenAIKey: (...a: unknown[]) => h.setKeyMock(...a),
  setTracingDisabled: (...a: unknown[]) => h.setTracingMock(...a),
}));
vi.mock("../src/config.js", () => ({
  config: { OPENAI_REPLY_MODEL: "gpt-5.4-mini", AGENT_MAX_TURNS: 12 },
}));
vi.mock("../src/logging/logger.js", () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
vi.mock("../src/llm/openaiClient.js", () => ({ openaiApiKey: () => "sk-test" }));
vi.mock("../src/llm/traceStore.js", () => ({ recordLlmCall: (...a: unknown[]) => h.recordLlmCall(...a) }));
vi.mock("../src/llm/modelPricing.js", () => ({ computeCostUsd: (...a: unknown[]) => h.computeCostUsd(...a) }));
vi.mock("../src/agent/mcpServers.js", () => ({ buildMcpServers: (...a: unknown[]) => h.buildMcpServers(...a) }));

import { runAgentReply, initAgentHarness, __resetAgentRunnerForTests } from "../src/agent/runner.js";

interface FakeServer {
  name: string;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
const makeServer = (name: string): FakeServer => ({
  name,
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

const OK_RESULT = {
  finalOutput: "the answer",
  state: { usage: { requests: 3, inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
};

describe("runAgentReply", () => {
  beforeEach(() => {
    __resetAgentRunnerForTests();
    for (const k of Object.keys(h) as (keyof typeof h)[]) (h[k] as ReturnType<typeof vi.fn>).mockReset();
    h.computeCostUsd.mockReturnValue(0.05);
    h.runMock.mockResolvedValue(OK_RESULT);
    h.buildMcpServers.mockReturnValue([makeServer("memory")]);
  });

  it("builds an Agent with model+instructions+mcpServers and maps the result", async () => {
    const servers = [makeServer("metabase"), makeServer("memory")];
    h.buildMcpServers.mockReturnValue(servers);

    const res = await runAgentReply("SYS PROMPT", "hello", undefined, undefined, "system@1.0.0");

    expect(h.agentCtor).toHaveBeenCalledTimes(1);
    const agentOpts = h.agentCtor.mock.calls[0][0] as { instructions: string; model: string; mcpServers: FakeServer[] };
    expect(agentOpts.instructions).toBe("SYS PROMPT");
    expect(agentOpts.model).toBe("gpt-5.4-mini");
    expect(agentOpts.mcpServers.map((s) => s.name).sort()).toEqual(["memory", "metabase"]);

    expect(h.runMock).toHaveBeenCalledTimes(1);
    const [, input, runOpts] = h.runMock.mock.calls[0] as [unknown, string, { maxTurns: number }];
    expect(input).toBe("hello");
    expect(runOpts.maxTurns).toBe(12);

    expect(res.text).toBe("the answer");
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(40);
    expect(res.numTurns).toBe(3);
    expect(res.costUsd).toBe(0.05);
    expect(typeof res.durationMs).toBe("number");
  });

  it("prepends thread context in the same shape as the CLI runner", async () => {
    await runAgentReply("SYS", "latest msg", "<@U1>: earlier");
    const input = (h.runMock.mock.calls[0] as [unknown, string])[1];
    expect(input).toBe("<@U1>: earlier\n\nLatest message:\nlatest msg");
  });

  it("connects every MCP server before the run and closes them after", async () => {
    const servers = [makeServer("metabase"), makeServer("memory")];
    h.buildMcpServers.mockReturnValue(servers);
    await runAgentReply("SYS", "x");
    for (const s of servers) {
      expect(s.connect).toHaveBeenCalledTimes(1);
      expect(s.close).toHaveBeenCalledTimes(1);
    }
  });

  it("closes MCP servers and records an error span even when the run throws", async () => {
    const servers = [makeServer("memory")];
    h.buildMcpServers.mockReturnValue(servers);
    h.runMock.mockRejectedValue(new Error("boom"));
    await expect(runAgentReply("SYS", "x")).rejects.toThrow("boom");
    expect(servers[0].close).toHaveBeenCalledTimes(1);
    expect(h.recordLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", operation: "reply", status: "error" })
    );
  });

  it("records one openai 'reply' span with the usage mapping on success", async () => {
    await runAgentReply("SYS", "x", "ctx", undefined, "system@1.0.0");
    expect(h.recordLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        operation: "reply",
        model: "gpt-5.4-mini",
        inputTokens: 100,
        outputTokens: 40,
        numTurns: 3,
        status: "ok",
        promptVersion: "system@1.0.0",
      })
    );
  });

  it("threads the viewer scope + server allowlist into buildMcpServers", async () => {
    const viewer = { userId: "U1" } as never;
    await runAgentReply("SYS", "x", undefined, viewer, undefined, {
      mcpServers: new Set(["metabase"]),
    });
    expect(h.buildMcpServers).toHaveBeenCalledWith({ viewer, servers: new Set(["metabase"]) });
  });

  it("honors an explicit model override", async () => {
    await runAgentReply("SYS", "x", undefined, undefined, undefined, { model: "gpt-5.4" });
    expect((h.agentCtor.mock.calls[0][0] as { model: string }).model).toBe("gpt-5.4");
  });

  it("initializes the OpenAI key and disables tracing exactly once", async () => {
    await runAgentReply("SYS", "x");
    await runAgentReply("SYS", "y");
    expect(h.setKeyMock).toHaveBeenCalledWith("sk-test");
    expect(h.setTracingMock).toHaveBeenCalledWith(true);
    expect(h.setKeyMock).toHaveBeenCalledTimes(1);
  });

  it("does not arm a timeout when timeoutMs<=0 (analytics unlimited)", async () => {
    await runAgentReply("SYS", "x", undefined, undefined, undefined, { timeoutMs: 0 });
    const runOpts = h.runMock.mock.calls[0][2] as { signal?: AbortSignal };
    expect(runOpts.signal).toBeUndefined();
  });

  it("initAgentHarness eagerly sets the key + disables tracing and reports a key was found", () => {
    const found = initAgentHarness();
    expect(found).toBe(true);
    expect(h.setKeyMock).toHaveBeenCalledWith("sk-test");
    expect(h.setTracingMock).toHaveBeenCalledWith(true);
  });

  it("does not register a budget hook when no tokenBudget is set", async () => {
    await runAgentReply("SYS", "x");
    const registered = h.onMock.mock.calls.map((c) => c[0]);
    expect(registered).not.toContain("agent_tool_start");
  });

  it("aborts with a budget error when cumulative tokens exceed tokenBudget", async () => {
    const servers = [makeServer("memory")];
    h.buildMcpServers.mockReturnValue(servers);
    // run() hangs until aborted; reject when the signal fires (as a real run would).
    h.runMock.mockImplementation(
      (_a: unknown, _i: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
        })
    );

    const p = runAgentReply("SYS", "x", undefined, undefined, undefined, { tokenBudget: 500 });
    const assertion = expect(p).rejects.toThrow(/budget/i);

    // Let connect() resolve and the Runner hook register, then fire it over budget.
    await new Promise((r) => setTimeout(r, 0));
    const entry = h.onMock.mock.calls.find((c) => c[0] === "agent_tool_start");
    expect(entry).toBeDefined();
    const hook = entry![1] as (ctx: unknown) => void;
    hook({ usage: { totalTokens: 600, inputTokens: 500, outputTokens: 100 } });

    await assertion;
    expect(servers[0].close).toHaveBeenCalledTimes(1);
    expect(h.recordLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", status: "error", errorKind: "budget" })
    );
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("aborts with a 'timed out' error when the run exceeds the timeout", async () => {
      const servers = [makeServer("memory")];
      h.buildMcpServers.mockReturnValue(servers);
      h.runMock.mockImplementation(
        (_a: unknown, _i: unknown, opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
          })
      );

      const p = runAgentReply("SYS", "x", undefined, undefined, undefined, { timeoutMs: 1000 });
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(servers[0].close).toHaveBeenCalledTimes(1);
      expect(h.recordLlmCall).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai", status: "error", errorKind: "timeout" })
      );
    });
  });
});
