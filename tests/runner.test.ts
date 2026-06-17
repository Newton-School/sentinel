import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock pino so importing the logger doesn't try to write structured logs.
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// Avoid importing the real config module, whose top-level loadConfig()
// calls process.exit(1) when required env vars are missing. runner.ts only
// reads CLAUDE_BIN and ANTHROPIC_API_KEY.
vi.mock("../src/config.js", () => ({
  config: {
    CLAUDE_BIN: "claude-test-bin",
    ANTHROPIC_API_KEY: "sk-test-key",
  },
}));

// Avoid touching the filesystem in mcpConfig.getMcpConfigPath(); return a
// deterministic path so we can assert it shows up in the spawn args.
// removeMcpConfig is stubbed too — runner.ts calls it in the close/error
// handlers to clean up that spawn's per-request config file.
const MCP_CONFIG_PATH = "/tmp/test-mcp-config.json";
const removeMcpConfigMock = vi.fn();
vi.mock("../src/claude/mcpConfig.js", () => ({
  getMcpConfigPath: vi.fn(() => MCP_CONFIG_PATH),
  removeMcpConfig: removeMcpConfigMock,
}));

// A controllable fake child process. It is an EventEmitter (so it can emit
// "close" / "exit" / "error") with stdout/stderr EventEmitters that can emit
// "data" with Buffers, plus a kill() spy.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
  killed = false;
}

// Mock node:child_process with a spawn spy we control per-test.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Intercept the LLM trace sink so the reply span is observable and never
// touches the DB.
const { recordLlmCallSpy } = vi.hoisted(() => ({ recordLlmCallSpy: vi.fn() }));
vi.mock("../src/llm/traceStore.js", () => ({ recordLlmCall: recordLlmCallSpy }));

// Helper: flush pending microtasks/promise callbacks so that .then/.catch
// handlers attached inside runClaude run before we assert.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runClaude", () => {
  let child: FakeChild;

  beforeEach(() => {
    vi.clearAllMocks();
    child = new FakeChild();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("argument construction", () => {
    it("spawns the configured claude binary with the expected flags", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("SYSTEM PROMPT", "hello world");

      // Resolve so the promise doesn't dangle.
      child.emit("close", 0);
      await promise;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args] = spawnMock.mock.calls[0];

      expect(bin).toBe("claude-test-bin");
      expect(args).toEqual([
        "--print",
        "hello world",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--system-prompt",
        "SYSTEM PROMPT",
        "--mcp-config",
        MCP_CONFIG_PATH,
      ]);
    });

    it("requests JSON output so usage/cost telemetry is captured", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--output-format");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("json");
    });

    it("passes the system prompt as the value after --system-prompt", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("my custom system prompt", "msg");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--system-prompt");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("my custom system prompt");
    });

    it("passes the mcp config path as the value after --mcp-config", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--mcp-config");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(MCP_CONFIG_PATH);
    });

    it("spawns the CLI inheriting the ambient environment (CLI uses its own login)", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("close", 0);
      await promise;

      const opts = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env).toBe(process.env);
    });
  });

  describe("thread-context prefixing", () => {
    it("does NOT prefix the prompt when no thread context is given", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "just the message");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      // value directly after --print is the prompt
      const idx = args.indexOf("--print");
      expect(args[idx + 1]).toBe("just the message");
    });

    it("prepends the thread context to the user message when provided", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "latest", "earlier thread history");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--print");
      expect(args[idx + 1]).toBe(
        "earlier thread history\n\nLatest message:\nlatest"
      );
    });
  });

  describe("success path — JSON telemetry parsing", () => {
    // The CLI is run with --output-format json, which prints a single JSON
    // object: the assistant text under `result` plus usage/cost telemetry.
    function jsonResult(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        type: "result",
        result: "Hello world",
        usage: { input_tokens: 123, output_tokens: 45 },
        total_cost_usd: 0.0123,
        num_turns: 3,
        duration_ms: 9999,
        ...overrides,
      });
    }

    it("parses the JSON result text into `text`", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(jsonResult()));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("Hello world");
    });

    it("populates token, cost, and turn fields from the JSON telemetry", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(jsonResult()));
      child.emit("close", 0);

      const result = await promise;
      expect(result.inputTokens).toBe(123);
      expect(result.outputTokens).toBe(45);
      expect(result.costUsd).toBe(0.0123);
      expect(result.numTurns).toBe(3);
    });

    it("durationMs stays wall-clock (not the CLI-reported duration_ms)", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(jsonResult({ duration_ms: 9999 })));
      child.emit("close", 0);

      const result = await promise;
      // Wall-clock measured by the runner, not the 9999 echoed by the CLI.
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).not.toBe(9999);
    });

    it("handles JSON chunked across multiple stdout 'data' events", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const full = jsonResult();
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(full.slice(0, 20)));
      child.stdout.emit("data", Buffer.from(full.slice(20)));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("Hello world");
      expect(result.inputTokens).toBe(123);
    });

    it("ignores stderr content on a successful (code 0) exit", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(jsonResult({ result: "the answer" })));
      child.stderr.emit("data", Buffer.from("some warning"));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("the answer");
    });
  });

  describe("defensive fallback — non-JSON / unexpected shape", () => {
    it("falls back to raw trimmed stdout as `text` when JSON parsing fails", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from("plain non-json text\n"));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("plain non-json text");
      // No telemetry could be parsed.
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.costUsd).toBeUndefined();
      expect(result.numTurns).toBeUndefined();
    });

    it("falls back to raw stdout when the JSON lacks the expected result field", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const raw = JSON.stringify({ something: "else", nope: true });
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(raw));
      child.emit("close", 0);

      const result = await promise;
      // Parsing succeeded but the result text was absent → raw stdout is used.
      expect(result.text).toBe(raw);
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
    });

    it("uses the parsed result text but omits token fields when usage is absent", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const raw = JSON.stringify({ result: "answer only" });
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(raw));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("answer only");
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.costUsd).toBeUndefined();
    });
  });

  describe("failure paths", () => {
    it("rejects when the process exits with a non-zero code, including stderr", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stderr.emit("data", Buffer.from("boom failure"));
      child.emit("close", 1);

      await expect(promise).rejects.toThrow(
        /Claude CLI exited with code 1: boom failure/
      );
    });

    it("rejects when spawn emits an error event", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      const spawnError = new Error("ENOENT: claude not found");
      child.emit("error", spawnError);

      await expect(promise).rejects.toThrow("ENOENT: claude not found");
    });
  });

  describe("per-spawn mcp-config cleanup", () => {
    it("removes this spawn's mcp-config file on a successful close", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      // Not removed before the CLI has finished reading it.
      expect(removeMcpConfigMock).not.toHaveBeenCalled();

      child.emit("close", 0);
      await promise;

      expect(removeMcpConfigMock).toHaveBeenCalledWith(MCP_CONFIG_PATH);
    });

    it("removes this spawn's mcp-config file on a non-zero close", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("close", 1);

      await expect(promise).rejects.toThrow();
      expect(removeMcpConfigMock).toHaveBeenCalledWith(MCP_CONFIG_PATH);
    });

    it("removes this spawn's mcp-config file when spawn errors", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("error", new Error("spawn failed"));

      await expect(promise).rejects.toThrow();
      expect(removeMcpConfigMock).toHaveBeenCalledWith(MCP_CONFIG_PATH);
    });
  });

  describe("timeout", () => {
    it("kills the child and rejects with a timeout error after ~120s", async () => {
      vi.useFakeTimers();
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      // Attach a rejection handler immediately so the rejection isn't
      // treated as unhandled when timers fire.
      const assertion = expect(promise).rejects.toThrow(/timed out after 180000ms/);

      // Advance past the 180s timeout.
      vi.advanceTimersByTime(180_000);
      await flush();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      await assertion;
    });

    it("clears the timeout timer on early close so kill is never fired on the exited process", async () => {
      // runner.ts clears the timeout timer in the close/error handlers, so once
      // the process exits normally the still-pending 180s timer must NOT fire
      // (firing it would kill an already-dead PID and keep a dangling timer
      // holding the event loop open).
      vi.useFakeTimers();
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from("done"));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("done");
      expect(child.kill).not.toHaveBeenCalled();

      // Advancing past the timeout must remain a no-op: the timer was cleared.
      vi.advanceTimersByTime(180_000);
      await flush();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("clears the timeout timer on a spawn error so the timer never fires afterward", async () => {
      vi.useFakeTimers();
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      const assertion = expect(promise).rejects.toThrow(/spawn boom/);
      child.emit("error", new Error("spawn boom"));
      await assertion;

      vi.advanceTimersByTime(180_000);
      await flush();
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  describe("LLM trace recording", () => {
    function jsonResult(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        type: "result",
        result: "Hello world",
        usage: { input_tokens: 123, output_tokens: 45 },
        total_cost_usd: 0.0123,
        num_turns: 3,
        ...overrides,
      });
    }

    it("records an anthropic 'reply' span with parsed telemetry on success", async () => {
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(jsonResult()));
      child.emit("close", 0);
      await promise;

      expect(recordLlmCallSpy).toHaveBeenCalledTimes(1);
      const arg = recordLlmCallSpy.mock.calls[0][0];
      expect(arg.provider).toBe("anthropic");
      expect(arg.operation).toBe("reply");
      expect(arg.inputTokens).toBe(123);
      expect(arg.outputTokens).toBe(45);
      expect(arg.costUsd).toBe(0.0123);
      expect(arg.numTurns).toBe(3);
      expect(arg.status).toBe("ok");
      expect(arg.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("captures the model id from the CLI JSON when present", async () => {
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(jsonResult({ model: "claude-opus-4-8" })));
      child.emit("close", 0);
      await promise;
      expect(recordLlmCallSpy.mock.calls[0][0].model).toBe("claude-opus-4-8");
    });

    it("falls back to model 'claude' when the JSON omits it", async () => {
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "answer only" })));
      child.emit("close", 0);
      await promise;
      expect(recordLlmCallSpy.mock.calls[0][0].model).toBe("claude");
    });

    it("records an error reply span on a non-zero exit", async () => {
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg");
      child.stderr.emit("data", Buffer.from("boom"));
      child.emit("close", 1);
      await expect(promise).rejects.toThrow();
      expect(recordLlmCallSpy).toHaveBeenCalledTimes(1);
      const arg = recordLlmCallSpy.mock.calls[0][0];
      expect(arg.provider).toBe("anthropic");
      expect(arg.operation).toBe("reply");
      expect(arg.status).toBe("error");
      expect(arg.model).toBe("claude");
    });

    it("records an error reply span when spawn errors", async () => {
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg");
      child.emit("error", new Error("ENOENT"));
      await expect(promise).rejects.toThrow();
      expect(recordLlmCallSpy.mock.calls[0][0].status).toBe("error");
    });

    it("stamps the promptVersion passed to runClaude onto the reply span", async () => {
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg", undefined, undefined, "system@1.0.0+89c11ce42da9");
      child.stdout.emit("data", Buffer.from(jsonResult()));
      child.emit("close", 0);
      await promise;
      expect(recordLlmCallSpy.mock.calls[0][0].promptVersion).toBe("system@1.0.0+89c11ce42da9");
    });

    it("a throwing recorder never rejects runClaude", async () => {
      recordLlmCallSpy.mockImplementationOnce(() => {
        throw new Error("sink boom");
      });
      const { runClaude } = await import("../src/claude/runner.js");
      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
      child.emit("close", 0);
      const result = await promise;
      expect(result.text).toBe("ok");
    });
  });
});
